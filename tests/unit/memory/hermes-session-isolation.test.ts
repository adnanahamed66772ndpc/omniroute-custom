import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Hermes Agent context-optimization task — session/project isolation regression guard.
//
// Real-world threat model: one Hermes Agent API key is reused across multiple, unrelated
// projects/conversations (Project A, Project B, ...). Two prior investigations of this
// repository established that message-body construction (chatCore.ts), the conversation
// tracker, the semantic cache, and compression telemetry are all already isolated per
// request/apiKey and never leak content across sessions — EXCEPT memory retrieval, which
// was hardcoded to `scope: "apiKey"` (src/lib/memory/settings.ts::toMemoryRetrievalConfig),
// pooling every session's saved memories under one API key even though the DB schema and
// query layer (src/lib/memory/retrieval.ts) already supported `scope: "session"` filtering.
//
// This suite pins the fix: retrieval now scopes to `x-omniroute-session-id` (forwarded as
// `sessionId`) when an operator opts in via `memorySettings.sessionScopeEnabled`, and falls
// back to the original apiKey-pooled behavior otherwise (backward compatible by default).
//
// Isolated on-disk SQLite DB — DATA_DIR is frozen at first import, so this file MUST run
// alone (mirrors tests/unit/memory/typed-decay.test.ts).

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omniroute-hermes-session-isolation-"));
  process.env.DATA_DIR = dataDir;
});

after(() => {
  try {
    resetDbInstance();
  } catch {
    /* ignore */
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const { MemoryType } = await import("../../../src/lib/memory/types.ts");
const { createMemory } = await import("../../../src/lib/memory/store.ts");
const { retrieveMemories } = await import("../../../src/lib/memory/retrieval.ts");
const { toMemoryRetrievalConfig, DEFAULT_MEMORY_SETTINGS } = await import(
  "../../../src/lib/memory/settings.ts"
);
const { resetDbInstance, getDbInstance } = await import("../../../src/lib/db/core.ts");

const SHARED_API_KEY = "hermes-shared-api-key";
const PROJECT_A_SECRET_CONTEXT_MARKER = "PROJECT_A_SECRET_CONTEXT_MARKER";
const PROJECT_B_CONTEXT = "PROJECT_B_CONTEXT";

async function seedTwoProjects() {
  await createMemory({
    apiKeyId: SHARED_API_KEY,
    sessionId: "session-project-a",
    type: MemoryType.FACTUAL,
    key: "project-a-fact",
    content: `Architecture decision: ${PROJECT_A_SECRET_CONTEXT_MARKER} — auth module uses JWT refresh rotation`,
    metadata: {},
    expiresAt: null,
  });
  await createMemory({
    apiKeyId: SHARED_API_KEY,
    sessionId: "session-project-b",
    type: MemoryType.FACTUAL,
    key: "project-b-fact",
    content: `Architecture decision: ${PROJECT_B_CONTEXT} — payments module uses Stripe webhooks`,
    metadata: {},
    expiresAt: null,
  });
}

describe("toMemoryRetrievalConfig — scope decision (pure function)", () => {
  it("defaults to apiKey-pooled scope when sessionScopeEnabled is off (backward compatible)", () => {
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
    const config = toMemoryRetrievalConfig(settings, { sessionId: "session-project-b" });
    assert.equal(config.scope, "apiKey");
    assert.equal(config.sessionId, undefined);
  });

  it("stays apiKey-pooled when opted in but no client session id is present", () => {
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };
    const config = toMemoryRetrievalConfig(settings, {});
    assert.equal(
      config.scope,
      "apiKey",
      "must gracefully degrade instead of scoping to an id that was never provided"
    );
  });

  it("scopes to the session only when opted in AND a session id is provided", () => {
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };
    const config = toMemoryRetrievalConfig(settings, { sessionId: "session-project-b" });
    assert.equal(config.scope, "session");
    assert.equal(config.sessionId, "session-project-b");
  });

  it("ignores a blank/whitespace-only session id", () => {
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };
    const config = toMemoryRetrievalConfig(settings, { sessionId: "   " });
    assert.equal(config.scope, "apiKey");
  });
});

describe("Session isolation — Hermes multi-project single-API-key retrieval (DB)", () => {
  beforeEach(() => {
    resetDbInstance();
    getDbInstance().prepare("DELETE FROM memories").run();
  });

  // Test B (task spec): new Hermes session must never see a previous, unrelated session's
  // content — even sharing the exact same API key.
  it("Test B — a fresh session's retrieval contains NO other session's secret marker", async () => {
    await seedTwoProjects();

    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };
    const config = toMemoryRetrievalConfig(settings, { sessionId: "session-project-b" });
    const results = await retrieveMemories(SHARED_API_KEY, config);

    const joined = results.map((m) => m.content).join("\n");
    assert.ok(
      !joined.includes(PROJECT_A_SECRET_CONTEXT_MARKER),
      "Project B's outbound retrieval must not contain Project A's marker"
    );
    assert.ok(
      joined.includes(PROJECT_B_CONTEXT),
      "Project B's own memory must still be retrievable"
    );
  });

  // Test C (task spec): two logical conversations sharing the same API key/provider/model
  // must not cross-contaminate, including when queried in an interleaved order (simulating
  // concurrent sessions — each retrieval is a stateless, independently-scoped query).
  it("Test C — concurrent/interleaved session retrieval never cross-contaminates", async () => {
    await seedTwoProjects();
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };

    const [forA, forB, forAAgain] = await Promise.all([
      retrieveMemories(
        SHARED_API_KEY,
        toMemoryRetrievalConfig(settings, { sessionId: "session-project-a" })
      ),
      retrieveMemories(
        SHARED_API_KEY,
        toMemoryRetrievalConfig(settings, { sessionId: "session-project-b" })
      ),
      retrieveMemories(
        SHARED_API_KEY,
        toMemoryRetrievalConfig(settings, { sessionId: "session-project-a" })
      ),
    ]);

    for (const result of [forA, forAAgain]) {
      const joined = result.map((m) => m.content).join("\n");
      assert.ok(joined.includes(PROJECT_A_SECRET_CONTEXT_MARKER));
      assert.ok(!joined.includes(PROJECT_B_CONTEXT));
    }
    const bJoined = forB.map((m) => m.content).join("\n");
    assert.ok(bJoined.includes(PROJECT_B_CONTEXT));
    assert.ok(!bJoined.includes(PROJECT_A_SECRET_CONTEXT_MARKER));
  });

  // Test D (task spec): separate codebases (Project Alpha / Project Beta) with independent
  // histories — summaries/context must never cross.
  it("Test D — independent project histories never share retrieved context", async () => {
    await createMemory({
      apiKeyId: SHARED_API_KEY,
      sessionId: "project-alpha",
      type: MemoryType.PROCEDURAL,
      key: "alpha-decision",
      content: "Project Alpha: migrated the billing service to the new queue-based worker",
      metadata: {},
      expiresAt: null,
    });
    await createMemory({
      apiKeyId: SHARED_API_KEY,
      sessionId: "project-beta",
      type: MemoryType.PROCEDURAL,
      key: "beta-decision",
      content: "Project Beta: rewrote the onboarding flow to skip email verification in dev",
      metadata: {},
      expiresAt: null,
    });

    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };
    const alphaResults = await retrieveMemories(
      SHARED_API_KEY,
      toMemoryRetrievalConfig(settings, { sessionId: "project-alpha" })
    );
    const betaResults = await retrieveMemories(
      SHARED_API_KEY,
      toMemoryRetrievalConfig(settings, { sessionId: "project-beta" })
    );

    assert.ok(alphaResults.every((m) => !m.content.includes("Project Beta")));
    assert.ok(betaResults.every((m) => !m.content.includes("Project Alpha")));
  });

  // Explicit backward-compatibility guard: the new opt-in must not change behavior for any
  // operator who has not turned it on. Without sessionScopeEnabled, retrieval stays pooled
  // across sessions under one API key — the documented, pre-existing behavior
  // (docs/frameworks/MEMORY.md).
  it("Test I-equivalent — sessionScopeEnabled off (default) preserves pooled apiKey retrieval", async () => {
    await seedTwoProjects();
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true }; // sessionScopeEnabled left at default (false)
    const results = await retrieveMemories(
      SHARED_API_KEY,
      toMemoryRetrievalConfig(settings, { sessionId: "session-project-b" })
    );
    const joined = results.map((m) => m.content).join("\n");
    assert.ok(
      joined.includes(PROJECT_A_SECRET_CONTEXT_MARKER) && joined.includes(PROJECT_B_CONTEXT),
      "default (opt-out) behavior must remain unchanged: both sessions pooled under one key"
    );
  });

  it("a different API key never sees another key's memories regardless of session scoping", async () => {
    await seedTwoProjects();
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, sessionScopeEnabled: true };
    const results = await retrieveMemories(
      "a-completely-different-api-key",
      toMemoryRetrievalConfig(settings, { sessionId: "session-project-a" })
    );
    assert.equal(results.length, 0);
  });
});
