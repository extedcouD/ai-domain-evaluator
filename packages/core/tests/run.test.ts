import { describe, expect, it } from "vitest";

import { toRun, type EventBody, type HarnessEvent } from "@evaluator/core";

async function collect(run: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of run.events) out.push(e);
  return out;
}

describe("toRun", () => {
  /**
   * THE most important test in this file.
   *
   * The obvious event-queue design blocks the producer until a consumer pulls. It deadlocks here:
   * `await run.result` with nobody iterating `.events` would hang forever on the first emit — and
   * that is the CLI's entire usage pattern, and an MCP server's, and most tests'.
   */
  it("completes when NOBODY is listening to events", async () => {
    const run = toRun("probe", "silent", async function* () {
      for (let i = 0; i < 10_000; i++) yield { type: "notice", level: "info", message: `n${String(i)}` };
      return "done";
    });

    // No `for await` anywhere. If the queue applies backpressure, this never resolves.
    await expect(run.result).resolves.toBe("done");
  });

  it("reports the frames it dropped, rather than pretending it saw everything", async () => {
    const run = toRun("probe", "flood", async function* () {
      for (let i = 0; i < 5000; i++) yield { type: "notice", level: "info", message: `n${String(i)}` };
      return "done";
    });

    await run.result; // let the producer race ahead of the (absent) consumer
    const events = await collect(run);

    // An instrument that can silently lose readings is not an instrument.
    const dropped = events.filter((e) => e.type === "run.dropped");
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]?.type === "run.dropped" && dropped[0].count).toBeGreaterThan(0);
  });

  it("surfaces a failure on BOTH channels, and does not crash the process on either alone", async () => {
    const run = toRun("probe", "boom", async function* () {
      yield { type: "notice", level: "info", message: "about to fail" };
      throw new TypeError("boom");
    });

    // A front-end that renders run.failed and never touches `result` must not take an unhandled
    // rejection. If the internal .catch() were missing, this test would kill the whole vitest worker.
    const events = await collect(run);
    const failed = events.find((e) => e.type === "run.failed");

    expect(failed?.type === "run.failed" && failed.error.name).toBe("TypeError");
    expect(failed?.type === "run.failed" && failed.error.expected).toBe(false);

    // ...and a caller who DOES await it still gets the throw.
    await expect(run.result).rejects.toThrow("boom");
  });

  it("distinguishes a cancellation from a failure", async () => {
    const run = toRun("probe", "slow", async function* (signal) {
      yield { type: "notice", level: "info", message: "working" };
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) throw new Error("aborted");
      return "finished";
    });

    run.cancel("user pressed ctrl-c");

    const events = await collect(run);
    await expect(run.result).rejects.toThrow();

    // Cancelled, NOT failed. The user meant to do that.
    expect(events.some((e) => e.type === "run.cancelled")).toBe(true);
    expect(events.some((e) => e.type === "run.failed")).toBe(false);
    const cancelled = events.find((e) => e.type === "run.cancelled");
    expect(cancelled?.type === "run.cancelled" && cancelled.reason).toBe("user pressed ctrl-c");
  });

  it("refuses a second consumer instead of silently splitting the stream between them", async () => {
    const run = toRun("probe", "x", async function* () {
      yield { type: "notice", level: "info", message: "hi" };
      return 1;
    });

    void run.events[Symbol.asyncIterator]();
    // Two consumers of a single-consumer queue each get a random half — deterministically wrong and
    // undetectable. Loud beats subtly wrong.
    expect(() => run.events[Symbol.asyncIterator]()).toThrow(/single-consumer/);
    await run.result;
  });

  it("stamps a monotonic seq, so a consumer can tell it missed something", async () => {
    const run = toRun("probe", "x", async function* () {
      yield { type: "notice", level: "info", message: "a" };
      yield { type: "notice", level: "info", message: "b" };
      return 1;
    });

    const events = await collect(run);
    expect(events.map((e) => e.seq)).toEqual([...events.keys()]);
    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.finished");
  });

  it("aggregates usage from llm.response onto run.finished, so cost needs no arithmetic", async () => {
    const run = toRun("probe", "usage", async function* () {
      yield {
        type: "llm.response",
        callId: "c1",
        finishReason: "stop",
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        latencyMs: 1,
        firstTokenMs: null,
        model: "m",
      };
      yield {
        type: "llm.response",
        callId: "c2",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        latencyMs: 1,
        firstTokenMs: null,
        model: "m",
      };
      return 1;
    });

    const events = await collect(run);
    const finished = events.find((e) => e.type === "run.finished");
    expect(finished?.type === "run.finished" && finished.usage.totalTokens).toBe(10);
  });
});

/**
 * THE definition of "decoupled" in this codebase.
 *
 * Pass this, and moving a consumer into its own process is `JSON.stringify(e) + "\n"` on one side and
 * `JSON.parse` on the other. `JSON.stringify(new Error("x"))` is `"{}"`; it will not tell you that it
 * just deleted the reason your run failed.
 */
describe("every event survives a JSON round trip", () => {
  it("holds for a failed run, where the Error is the thing most likely to be silently eaten", async () => {
    const run = toRun("probe", "boom", async function* () {
      yield { type: "notice", level: "info", message: "x" };
      throw new TypeError("boom");
    });
    const events = await collect(run);
    await expect(run.result).rejects.toThrow();

    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
    // Specifically: the message survived. `JSON.stringify(new Error("boom"))` would have been "{}".
    const failed = events.find((e) => e.type === "run.failed");
    expect(JSON.parse(JSON.stringify(failed))).toMatchObject({ error: { message: "boom" } });
  });

  it("covers every EventBody variant, so a new event cannot skip this check unnoticed", () => {
    // If you add a variant to EventBody, add it here — or `samples` stops being exhaustive and this
    // stops proving what it claims.
    const samples: EventBody[] = [
      { type: "run.started", kind: "probe", label: "x" },
      { type: "run.finished", ms: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      { type: "run.failed", error: { name: "E", message: "m", expected: true } },
      { type: "run.cancelled", reason: "r" },
      { type: "run.dropped", count: 3 },
      { type: "llm.request", callId: "c", model: "m", messageCount: 1, streamed: true },
      { type: "llm.delta", callId: "c", text: "t" },
      { type: "llm.reasoning", callId: "c", text: "t" },
      {
        type: "llm.response",
        callId: "c",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
        firstTokenMs: 1,
        model: "m",
      },
      { type: "budget.exhausted", callId: "c", reasoningChars: 10, maxTokens: 64 },
      { type: "notice", level: "warn", message: "m" },
    ];

    for (const body of samples) {
      const event: HarnessEvent = { runId: "r", seq: 0, at: 1, ...body };
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });
});
