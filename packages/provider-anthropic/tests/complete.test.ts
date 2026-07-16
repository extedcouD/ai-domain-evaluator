import { afterAll, describe, expect, it } from "vitest";

import { LlmUnreachableError } from "@evaluator/core";
import { createAnthropicLlm } from "../src/index";
import { fakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

const open: FakeAnthropic[] = [];
afterAll(() => open.forEach((b) => b.close()));

async function backend(spec: Parameters<typeof fakeAnthropic>[0] = {}): Promise<FakeAnthropic> {
  const b = await fakeAnthropic(spec);
  open.push(b);
  return b;
}

const CANARY = {
  type: "object",
  properties: { zzz_canary: { type: "integer" } },
  required: ["zzz_canary"],
  additionalProperties: false,
};

describe("complete()", () => {
  it("returns Anthropic usage on a non-streaming call", async () => {
    const fake = await backend();
    const r = await createAnthropicLlm(fake.config()).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
    expect(r.firstTokenMs).toBeNull();
    expect(r.finishReason).toBe("stop");
  });

  it("turns a schema request into a forced tool call and serializes its input back to text", async () => {
    // A downstream JSON.parse(result.text) must behave exactly as it does for the OpenAI adapter.
    const fake = await backend({ schema: "honors" });
    const r = await createAnthropicLlm(fake.config()).complete({
      messages: [{ role: "user", content: "give me the canary" }],
      schema: CANARY,
      schemaName: "canary",
    });
    expect(JSON.parse(r.text)).toEqual({ zzz_canary: 7 });
    expect(r.finishReason).toBe("tool_calls");
  });

  it("surfaces the scratchpad separately even on a non-streaming call", async () => {
    const fake = await backend({ reasoning: "then-answers" });
    const r = await createAnthropicLlm(fake.config()).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r.reasoningText).toBeTruthy();
    expect(r.text).toContain("Canada");
    expect(r.text).not.toContain("Let me think");
  });

  it("maps max_tokens onto the neutral length reason when the model thinks itself out of room", async () => {
    const fake = await backend({ reasoning: "all-budget" });
    const r = await createAnthropicLlm(fake.config()).complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
    });
    expect(r.text).toBe("");
    expect(r.reasoningText).toBeTruthy();
    expect(r.finishReason).toBe("length"); // NOT the raw "max_tokens"
  });
});

describe("probeSchemaEnforcement()", () => {
  it("PASSES when the forced tool returns the canary structure", async () => {
    const fake = await backend({ schema: "honors" });
    const probe = await createAnthropicLlm(fake.config()).probeSchemaEnforcement();
    expect(probe.enforced).toBe(true);
  });

  it("CATCHES a backend that was told to force a tool and answered in prose anyway", async () => {
    const fake = await backend({ schema: "ignores" });
    const probe = await createAnthropicLlm(fake.config()).probeSchemaEnforcement();
    expect(probe.enforced).toBe(false);
    expect(probe.detail).toMatch(/not enforced|prose/i);
  });
});

describe("health() and actionable errors", () => {
  it("lists served models and confirms the configured one is present", async () => {
    const fake = await backend();
    const h = await createAnthropicLlm(fake.config()).health();
    expect(h.models).toContain("fake-claude");
    expect(h.servingConfiguredModel).toBe(true);
  });

  it("turns a dead endpoint into an actionable LlmUnreachableError", async () => {
    const llm = createAnthropicLlm({
      baseUrl: "http://127.0.0.1:1",
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
