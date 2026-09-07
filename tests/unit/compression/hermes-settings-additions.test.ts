import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Hermes Agent context-optimization task — settings-layer regression guard for the two
// new operator-facing knobs this task adds:
//   1. memorySettings.sessionScopeEnabled (session-scoped memory retrieval opt-in)
//   2. compression proactiveConfig.thresholdRatio (now reachable via a settings route,
//      previously DB-only with no way to tune it without a raw SQLite write)
// Isolated on-disk SQLite DB — must run alone.

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omniroute-hermes-settings-"));
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

const {
  normalizeMemorySettings,
  toMemorySettingsUpdates,
  DEFAULT_MEMORY_SETTINGS,
} = await import("../../../src/lib/memory/settings.ts");
const { MemorySettingsExtendedSchema } = await import("../../../src/shared/schemas/memory.ts");
const { proactiveCompressionConfigSchema } = await import(
  "../../../src/shared/validation/compressionConfigSchemas.ts"
);
const { getProactiveCompressionRatio, setProactiveCompressionRatio } = await import(
  "../../../src/lib/db/compression.ts"
);
const { resetDbInstance, getDbInstance } = await import("../../../src/lib/db/core.ts");

describe("memorySettings.sessionScopeEnabled", () => {
  it("defaults to false (backward compatible)", () => {
    assert.equal(DEFAULT_MEMORY_SETTINGS.sessionScopeEnabled, false);
  });

  it("normalizeMemorySettings reads the raw DB key", () => {
    const settings = normalizeMemorySettings({ memorySessionScopeEnabled: true });
    assert.equal(settings.sessionScopeEnabled, true);
  });

  it("normalizeMemorySettings ignores non-boolean junk and falls back to the default", () => {
    const settings = normalizeMemorySettings({ memorySessionScopeEnabled: "yes" });
    assert.equal(settings.sessionScopeEnabled, false);
  });

  it("toMemorySettingsUpdates round-trips the field", () => {
    const updates = toMemorySettingsUpdates({ sessionScopeEnabled: true });
    assert.equal(updates.memorySessionScopeEnabled, true);
    const restored = normalizeMemorySettings(updates);
    assert.equal(restored.sessionScopeEnabled, true);
  });

  it("MemorySettingsExtendedSchema (PUT /api/settings/memory body) accepts the field", () => {
    const parsed = MemorySettingsExtendedSchema.parse({ sessionScopeEnabled: true });
    assert.equal(parsed.sessionScopeEnabled, true);
  });

  it("MemorySettingsExtendedSchema is still .strict() — unknown fields are rejected", () => {
    assert.throws(() => MemorySettingsExtendedSchema.parse({ notARealField: true }));
  });
});

describe("compression proactiveConfig.thresholdRatio", () => {
  it("proactiveCompressionConfigSchema rejects out-of-range values", () => {
    assert.throws(() => proactiveCompressionConfigSchema.parse({ thresholdRatio: 0.05 }));
    assert.throws(() => proactiveCompressionConfigSchema.parse({ thresholdRatio: 1 }));
    assert.doesNotThrow(() => proactiveCompressionConfigSchema.parse({ thresholdRatio: 0.85 }));
  });

  it("getProactiveCompressionRatio defaults to 0.7 with no stored row", () => {
    resetDbInstance();
    getDbInstance();
    assert.equal(getProactiveCompressionRatio(), 0.7);
  });

  it("setProactiveCompressionRatio persists and getProactiveCompressionRatio reads it back", async () => {
    resetDbInstance();
    getDbInstance();
    await setProactiveCompressionRatio(0.85);
    assert.equal(getProactiveCompressionRatio(), 0.85);
  });

  it("setProactiveCompressionRatio clamps out-of-range input instead of storing it verbatim", async () => {
    resetDbInstance();
    getDbInstance();
    await setProactiveCompressionRatio(5); // way above PROACTIVE_COMPRESSION_RATIO_MAX (0.99)
    assert.equal(getProactiveCompressionRatio(), 0.99);
  });
});
