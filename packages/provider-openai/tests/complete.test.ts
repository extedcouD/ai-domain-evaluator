import { afterAll, describe, expect, it } from "vitest";

import { LlmUnreachableError } from "@evaluator/core";
import { createOpenAiLlm } from "../src/index";
import { fakeBackend, type FakeBackend } from "./fake-backend";

const open: FakeBackend[] = [];
afterAll(() => open.forEach((b) => b.close()));

async function backend(spec: Parameters<typeof fakeBackend>[0] = {}): Promise<FakeBackend> {
  const b = await fakeBackend(spec);
  open.push(b);
  return b;
}

describe("complete()", () => {
  it("returns real usage on a non-streaming call — NOT zero", async () => {
    const fake = await backend();
    const r = await createOpenAiLlm(fake.config()).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r.usage.totalTokens).toBe(11);
    expect(r.firstTokenMs).toBeNull(); // nothing streamed → no "first token"
    expect(r.finishReason).toBe("stop");
  });

  it("ignores n silently on backends that don't honor it (choices length 1, not n)", async () => {
    const fake = await backend({ n: "ignores" });
    const r = await createOpenAiLlm(fake.config()).complete({ messages: [{ role: "user", content: "hi" }], n: 3 });
    expect(r.choices).toHaveLength(1);
  });

  it("surfaces the scratchpad separately even on a non-streaming call", async () => {
    const fake = await backend({ reasoning: "then-answers" });
    const r = await createOpenAiLlm(fake.config()).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r.reasoningText).toBeTruthy();
    expect(r.text).not.toContain("Let me think");
  });

  it("maps a tool_calls finish reason onto the neutral enum and reassembles the call", async () => {
    const fake = await backend();
    const r = await createOpenAiLlm(fake.config()).complete({
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ name: "get_weather", description: "x", parameters: { type: "object" } }],
    });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls[0]?.name).toBe("zzz_canary_tool");
  });
});

describe("probeSchemaEnforcement()", () => {
  it("PASSES a backend that enforces the schema", async () => {
    const fake = await backend({ schema: "honors" });
    const probe = await createOpenAiLlm(fake.config()).probeSchemaEnforcement();
    expect(probe.enforced).toBe(true);
  });

  it("CATCHES a backend that accepts response_format and silently ignores it", async () => {
    // The whole reason this project exists: 200 OK, a full usage object, and prose. No error anywhere.
    const fake = await backend({ schema: "ignores" });
    const probe = await createOpenAiLlm(fake.config()).probeSchemaEnforcement();
    expect(probe.enforced).toBe(false);
    expect(probe.detail).toMatch(/SILENTLY IGNORED/);
  });
});

describe("health() and actionable errors", () => {
  it("lists served models and confirms the configured one is present", async () => {
    const fake = await backend();
    const h = await createOpenAiLlm(fake.config()).health();
    expect(h.models).toContain("fake-model");
    expect(h.servingConfiguredModel).toBe(true);
  });

  it("turns a dead endpoint into an actionable LlmUnreachableError, not an undici stack", async () => {
    const llm = createOpenAiLlm({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "x",
      model: "m",
      temperature: 0,
      topP: 1,
      maxTokens: 16,
    });
    await expect(llm.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(
      LlmUnreachableError,
    );
  });
});
