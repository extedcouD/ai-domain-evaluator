import { afterAll, describe, expect, it } from "vitest";

import { LlmAbortedError, type CompletionResult, type LlmChunk } from "@evaluator/core";
import { createOpenAiLlm } from "../src/index";
import { fakeBackend, type FakeBackend } from "./fake-backend";

const open: FakeBackend[] = [];
afterAll(() => open.forEach((b) => b.close()));

async function backend(spec: Parameters<typeof fakeBackend>[0] = {}): Promise<FakeBackend> {
  const b = await fakeBackend(spec);
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
  it("streams the answer and the scratchpad on SEPARATE channels", async () => {
    const fake = await backend({ reasoning: "then-answers" });
    const chunks = await collect(createOpenAiLlm(fake.config()).stream({ messages: [{ role: "user", content: "hi" }] }));

    const reasoning = chunks.filter((c) => c.kind === "reasoning");
    expect(reasoning.length).toBeGreaterThan(1);
    // Merging them would corrupt the answer with the model's mumbling.
    expect(joinText(chunks)).toContain("Canada");
    expect(joinText(chunks)).not.toContain("Let me think");
  });

  it("reports ZERO usage when the server streams but never implements stream_options", async () => {
    // This is the heart of "complete() is not sugar over stream()": a naive wrapper would report zero
    // tokens forever on exactly the local backends this harness cares about.
    const fake = await backend({ stream: "no-usage" });
    const result = doneResult(
      await collect(createOpenAiLlm(fake.config()).stream({ messages: [{ role: "user", content: "hi" }] })),
    );
    expect(result.usage.totalTokens).toBe(0);
  });

  it("says the answer is empty because the model thought until it ran out of room", async () => {
    const fake = await backend({ reasoning: "all-budget" });
    const result = doneResult(
      await collect(
        createOpenAiLlm(fake.config()).stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 64 }),
      ),
    );
    expect(result.text).toBe("");
    expect(result.reasoningText).toBeTruthy();
    // The neutral mapping — the budget brake must not string-match a raw provider value.
    expect(result.finishReason).toBe("length");
  });

  it("reassembles a tool call whose arguments were split mid-string across frames", async () => {
    const fake = await backend();
    const result = doneResult(
      await collect(
        createOpenAiLlm(fake.config()).stream({
          messages: [{ role: "user", content: "weather?" }],
          tools: [{ name: "get_weather", description: "x", parameters: { type: "object" } }],
        }),
      ),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.arguments).toBe('{"location":"Paris"}');
  });

  it("throws LlmAbortedError when cancelled mid-stream — the SDK swallows the abort, so we ask the signal", async () => {
    const fake = await backend({ stream: "hangs" });
    const controller = new AbortController();
    const iterator = createOpenAiLlm(fake.config())
      .stream({ messages: [{ role: "user", content: "hi" }] }, controller.signal)
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.kind).toBe("text"); // the one frame the hanging server sent

    controller.abort();
    // Without the explicit signal check, this would resolve to a clean `done` — a cancelled run
    // masquerading as a finished one.
    await expect(iterator.next()).rejects.toBeInstanceOf(LlmAbortedError);
  });
});
