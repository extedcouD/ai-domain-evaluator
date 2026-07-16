import { afterAll, describe, expect, it } from "vitest";

import { LlmAbortedError, type CompletionResult, type LlmChunk } from "@evaluator/core";
import { createAnthropicLlm } from "../src/index";
import { fakeAnthropic, type FakeAnthropic } from "./fake-anthropic";

const open: FakeAnthropic[] = [];
afterAll(() => open.forEach((b) => b.close()));

async function backend(spec: Parameters<typeof fakeAnthropic>[0] = {}): Promise<FakeAnthropic> {
  const b = await fakeAnthropic(spec);
  open.push(b);
  return b;
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function doneResult(chunks: LlmChunk[]): CompletionResult {
  const d = chunks.find((c) => c.kind === "done");
  if (d?.kind !== "done") throw new Error("stream ended without a done chunk");
  return d.result;
}

function joinText(chunks: LlmChunk[]): string {
  return chunks.map((c) => (c.kind === "text" ? c.text : "")).join("");
}

describe("stream()", () => {
  it("streams the answer and the thinking on SEPARATE channels", async () => {
    const fake = await backend({ reasoning: "then-answers" });
    const chunks = await collect(createAnthropicLlm(fake.config()).stream({ messages: [{ role: "user", content: "hi" }] }));

    expect(chunks.filter((c) => c.kind === "reasoning").length).toBeGreaterThan(1);
    expect(joinText(chunks)).toContain("Canada");
    expect(joinText(chunks)).not.toContain("Let me think");
  });

  it("says the answer is empty because the model thought until it ran out of room", async () => {
    const fake = await backend({ reasoning: "all-budget" });
    const result = doneResult(
      await collect(createAnthropicLlm(fake.config()).stream({ messages: [{ role: "user", content: "hi" }] })),
    );
    expect(result.text).toBe("");
    expect(result.reasoningText).toBeTruthy();
    expect(result.finishReason).toBe("length");
  });

  it("reassembles a tool call whose arguments were split mid-string across frames", async () => {
    const fake = await backend();
    const result = doneResult(
      await collect(
        createAnthropicLlm(fake.config()).stream({
          messages: [{ role: "user", content: "weather?" }],
          tools: [{ name: "get_weather", description: "x", parameters: { type: "object" } }],
        }),
      ),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.arguments).toBe('{"location":"Paris"}');
  });

  it("throws LlmAbortedError when cancelled mid-stream — the SDK swallows the abort", async () => {
    const fake = await backend({ stream: "hangs" });
    const controller = new AbortController();
    const iterator = createAnthropicLlm(fake.config())
      .stream({ messages: [{ role: "user", content: "hi" }] }, controller.signal)
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.kind).toBe("text");

    controller.abort();
    await expect(iterator.next()).rejects.toBeInstanceOf(LlmAbortedError);
  });
});
