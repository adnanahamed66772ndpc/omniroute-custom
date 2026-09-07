import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyStackedCompressionAsync } from "../../../open-sse/services/compression/index.ts";
import { openaiToOpenAIResponsesRequest } from "../../../open-sse/translator/request/openai-responses/toResponses.ts";
import { openaiToAntigravityRequest } from "../../../open-sse/translator/request/openai-to-gemini.ts";
import type { CompressionPipelineStep } from "../../../open-sse/services/compression/types.ts";

// Hermes Agent context-optimization task — Test F (Codex/openai-responses) and Test G
// (Antigravity/openai) from the task's benchmark plan: proves the recommended
// [rtk, aggressive, caveman] compression profile does not corrupt request translation for
// either of the two real providers observed in the captured Hermes traffic. Compression
// runs pre-translation (chatCore.ts), so both providers receive an already-compacted
// `messages[]` body; this suite feeds that compacted body through the REAL translators
// (no mocks) and asserts the output stays structurally valid.

const HERMES_PIPELINE: CompressionPipelineStep[] = [
  { engine: "rtk", intensity: "standard" },
  { engine: "aggressive" },
  { engine: "caveman", intensity: "full" },
] as unknown as CompressionPipelineStep[];

function bigBuildLog(lines: number): string {
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) rows.push(`[build] step ${i} ok (${i}ms)`);
  return rows.join("\n");
}

function buildCompressibleHermesBody(turns: number) {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "You are Hermes Agent, an autonomous coding assistant." },
  ];
  for (let i = 0; i < turns; i++) {
    const toolCallId = `call_${i}`;
    messages.push(
      { role: "user", content: `Turn ${i}: keep debugging the payment webhook handler.` },
      {
        role: "assistant",
        content: `Turn ${i} reasoning: re-checking the webhook signature verification step in detail before proposing a fix.`,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: "run_terminal_command", arguments: JSON.stringify({ cmd: "npm test" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: toolCallId, content: bigBuildLog(30) }
    );
  }
  messages.push({ role: "user", content: "Summarize what's broken in the webhook handler." });
  return { model: "gpt-5.6-sol", messages, tools: [{ type: "function", function: { name: "run_terminal_command", parameters: { type: "object", properties: {} } } }] };
}

describe("Test F — Codex (openai -> openai-responses) after compression", () => {
  it("a compressed Hermes body translates to a structurally valid Responses request", async () => {
    const body = buildCompressibleHermesBody(15);
    const compressed = await applyStackedCompressionAsync(body, HERMES_PIPELINE, {
      sourceFormat: "openai",
      targetFormat: "openai-responses",
    });
    assert.ok(compressed.compressed, "a 15-turn session should trigger compression");

    const translated = openaiToOpenAIResponsesRequest(
      compressed.body.model,
      compressed.body,
      true,
      {}
    ) as { input: Array<Record<string, unknown>>; model: unknown };

    assert.ok(Array.isArray(translated.input) && translated.input.length > 0);
    assert.equal(translated.model, "gpt-5.6-sol");

    // Every function_call_output must reference a call_id that exists among the
    // translated function_call items (no orphaned tool results post-compression).
    const callIds = new Set(
      translated.input
        .filter((item) => item.type === "function_call")
        .map((item) => item.call_id)
    );
    for (const item of translated.input) {
      if (item.type === "function_call_output") {
        assert.ok(
          callIds.has(item.call_id),
          `orphaned function_call_output after compression+translation: ${item.call_id}`
        );
      }
    }
  });
});

describe("Test G — Antigravity (openai -> antigravity/Gemini) after compression", () => {
  it("a compressed Hermes body translates to a structurally valid Antigravity/Gemini request", async () => {
    const body = buildCompressibleHermesBody(15);
    const compressed = await applyStackedCompressionAsync(body, HERMES_PIPELINE, {
      sourceFormat: "openai",
      targetFormat: "antigravity",
    });
    assert.ok(compressed.compressed, "a 15-turn session should trigger compression");

    const envelope = openaiToAntigravityRequest(
      "gemini-3.1-pro-low",
      compressed.body,
      true,
      null
    ) as { request: { contents: Array<Record<string, unknown>>; systemInstruction?: unknown } };
    const translated = envelope.request;

    assert.ok(Array.isArray(translated.contents) && translated.contents.length > 0);
    assert.ok(translated.systemInstruction, "system instruction must survive translation");

    // Every Gemini content entry must have a valid role and non-empty parts array —
    // a corrupted compression pass could leave an empty/malformed turn behind.
    for (const entry of translated.contents) {
      assert.ok(["user", "model"].includes(entry.role as string));
      assert.ok(Array.isArray(entry.parts) && (entry.parts as unknown[]).length > 0);
    }
  });
});
