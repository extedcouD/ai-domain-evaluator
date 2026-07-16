/**
 * A run: something the engine is doing, that you can watch, await, and cancel.
 *
 * Engine operations are written as async generators that `yield` EventBody and `return` a value.
 * `toRun()` wraps one into the handle below — stamping run ids, sequence numbers and clocks, so no
 * engine author ever does bookkeeping — and hands the front-end two independent views of the same
 * work: a stream of events to render, and a promise to await.
 */
import { serializeError } from "./serialize";
import type { EventBody, HarnessEvent, RunKind } from "./events";
import type { TokenUsage } from "./types";

export interface Run<T> {
  readonly id: string;
  /**
   * Every event, in order.
   *
   * Iterating is OPTIONAL. Not iterating does not stall the run — see the queue below.
   * Breaking out of a `for await` over this does NOT cancel the run; only `cancel()` cancels.
   * Detaching a viewer and killing the work are different things, and conflating them means closing
   * a debug pane kills someone's agent.
   */
  readonly events: AsyncIterable<HarnessEvent>;
  readonly result: Promise<T>;
  cancel(reason?: string): void;
}

/**
 * How many events we will hold for a consumer that has stopped reading.
 *
 * At ~100 tok/s this is ten seconds of slack, and no React consumer falls ten seconds behind. It is
 * a safety valve, not a design parameter.
 */
const QUEUE_CAP = 1024;

/**
 * A queue that NEVER blocks the producer.
 *
 * This is the single most important property in this file, and the obvious implementation gets it
 * backwards. If the engine blocked until someone pulled an event, then `await coverage(...).result`
 * — with no one iterating `.events` — would DEADLOCK on the very first emit. That is the CLI's
 * entire usage pattern, and an MCP server's, and a test's.
 *
 * So the producer always wins. When the buffer is full we drop the OLDEST event and count it, then
 * tell the consumer we did. An instrument that can silently lose readings is not an instrument.
 */
class EventQueue {
  private readonly buffer: HarnessEvent[] = [];
  private waiter: ((r: IteratorResult<HarnessEvent>) => void) | null = null;
  private closed = false;
  private dropped = 0;

  push(event: HarnessEvent): void {
    if (this.closed) return;

    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter({ value: event, done: false });
      return;
    }

    if (this.buffer.length >= QUEUE_CAP) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(event);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  /** Reports a drop before the next real event, so the loss shows up in the stream that lost it. */
  private takeDropReport(runId: string, seq: number): HarnessEvent | null {
    if (this.dropped === 0) return null;
    const count = this.dropped;
    this.dropped = 0;
    return { runId, seq, at: Date.now(), type: "run.dropped", count };
  }

  async next(runId: string, seq: number): Promise<IteratorResult<HarnessEvent>> {
    const drop = this.takeDropReport(runId, seq);
    if (drop !== null) return { value: drop, done: false };

    const buffered = this.buffer.shift();
    if (buffered !== undefined) return { value: buffered, done: false };

    if (this.closed) return { value: undefined, done: true };

    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

let runCounter = 0;

/**
 * Turn an engine generator into a `Run`.
 *
 * The ONLY place that knows about run ids, sequence numbers, clocks, the AbortController, the queue,
 * or usage aggregation. Engine functions yield semantics; this adds the bookkeeping.
 */
export function toRun<T>(
  kind: RunKind,
  label: string,
  make: (signal: AbortSignal) => AsyncGenerator<EventBody, T>,
): Run<T> {
  runCounter += 1;
  const id = `run_${String(runCounter)}`;

  const queue = new EventQueue();
  const controller = new AbortController();
  const startedAt = Date.now();

  let seq = 0;
  let cancelReason: string | null = null;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const emit = (body: EventBody): void => {
    queue.push({ runId: id, seq: seq++, at: Date.now(), ...body });
  };

  const pump = async (): Promise<T> => {
    emit({ type: "run.started", kind, label });

    try {
      const gen = make(controller.signal);

      let step = await gen.next();
      while (!step.done) {
        const body = step.value;

        // Usage is aggregated here rather than by each op, so "what did this run cost" is answerable
        // without a front-end having to sum anything.
        if (body.type === "llm.response") {
          usage.promptTokens += body.usage.promptTokens;
          usage.completionTokens += body.usage.completionTokens;
          usage.totalTokens += body.usage.totalTokens;
        }

        emit(body);
        step = await gen.next();
      }

      emit({ type: "run.finished", ms: Date.now() - startedAt, usage });
      return step.value;
    } catch (error) {
      // A cancellation is not a failure. It is the one thing the user meant to do.
      if (controller.signal.aborted) {
        emit({ type: "run.cancelled", reason: cancelReason ?? "cancelled" });
      } else {
        emit({ type: "run.failed", error: serializeError(error) });
      }
      throw error;
    } finally {
      queue.close();
    }
  };

  const result = pump();

  /**
   * A front-end that renders `run.failed` beautifully and never touches `result` would still take an
   * unhandled rejection and kill the process. This handler exists only to stop that. `.catch()`
   * returns a NEW promise and does not consume the original, so a caller who DOES `await run.result`
   * still gets the throw.
   */
  void result.catch(() => undefined);

  let consumed = false;
  const events: AsyncIterable<HarnessEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
      // Two consumers of a single-consumer queue would each silently get a random half of the events
      // — deterministically wrong, and undetectable. Loud beats subtly wrong.
      if (consumed) {
        throw new Error("Run.events already has a consumer. Events are a single-consumer stream.");
      }
      consumed = true;

      return {
        next: () => queue.next(id, seq),
        // Deliberately NO return()/throw() that aborts the controller: detaching a viewer must not
        // kill the work. See the note on `Run.events`.
      };
    },
  };

  return {
    id,
    events,
    result,
    cancel(reason = "cancelled") {
      cancelReason = reason;
      controller.abort();
    },
  };
}
