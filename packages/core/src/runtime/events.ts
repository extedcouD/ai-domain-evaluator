/**
 * The engine <-> front-end contract.
 *
 * The engine does not print, and it does not hand a front-end an object with methods on it. It emits
 * a stream of these. That is the whole boundary — a TUI, the CLI, an MCP server and a log file are
 * all just different things to do with the same events.
 *
 * EVERY event here is JSON-serializable: no Error, no Date, no Map, no class instance, no function.
 * Holding that line is what keeps moving a consumer OUT of process an afternoon's work —
 * `JSON.stringify(event) + "\n"` on one side, `JSON.parse` on the other, and nothing else.
 * `JSON.stringify` will not warn you when you break this. See serialize.ts.
 */
import type { SerializedError } from "./serialize";
import type { FinishReason, TokenUsage } from "./types";

/** Stamped by `toRun()`. No engine function ever writes these — they are pure bookkeeping. */
interface EventEnvelope {
  runId: string;
  /** Monotonic from 0, within a run. Lets a consumer notice it missed a frame. */
  seq: number;
  /** Epoch ms as a NUMBER. `JSON.parse(JSON.stringify(new Date()))` gives you back a string. */
  at: number;
}

/** What kind of work a run is. `probe` covers coverage/validate/health; `chat` is a conversation. */
export type RunKind = "chat" | "probe";

/**
 * What an engine function actually yields. The envelope is added for it.
 *
 * If you are adding an event: it must survive `JSON.stringify`. There is a test that checks.
 */
export type EventBody =
  // ---- lifecycle. Synthesized by toRun(); engine functions never yield these. ------------------
  | { type: "run.started"; kind: RunKind; label: string }
  | { type: "run.finished"; ms: number; usage: TokenUsage }
  | { type: "run.failed"; error: SerializedError }
  | { type: "run.cancelled"; reason: string }
  /** The instrument reporting its own blind spot: the consumer fell behind and we dropped frames. */
  | { type: "run.dropped"; count: number }

  // ---- the model call --------------------------------------------------------------------------
  /**
   * `messages` is deliberately NOT carried here. A conversation is O(n) messages over O(n) turns, so
   * putting the whole array on every request event makes the event log O(n^2) in the size of the
   * chat. The front-end already has the messages — it sent them.
   */
  | { type: "llm.request"; callId: string; model: string; messageCount: number; streamed: boolean }
  /** A token of the answer. */
  | { type: "llm.delta"; callId: string; text: string }
  /**
   * A token of the model's scratchpad — NOT of the answer.
   *
   * Separate from `llm.delta` because they are different things and merging them corrupts the answer.
   * A hybrid-reasoning model can spend its entire budget here and never emit a single `llm.delta`,
   * which is a real and completely silent failure if you aren't watching for it.
   */
  | { type: "llm.reasoning"; callId: string; text: string }
  | {
      type: "llm.response";
      callId: string;
      /** Normalized reason (see `FinishReason`), not a raw provider string. */
      finishReason: FinishReason | null;
      usage: TokenUsage;
      latencyMs: number;
      firstTokenMs: number | null;
      model: string;
    }

  // ---- the instruments -------------------------------------------------------------------------
  /**
   * The model thought until it ran out of room and never answered.
   *
   * `finishReason: "length"`, empty text, non-empty reasoning. Without this event the front-end sees
   * a successful, empty response and has no way to explain it — which is exactly how it looked before
   * anyone went looking.
   */
  | { type: "budget.exhausted"; callId: string; reasoningChars: number; maxTokens: number }

  /** The engine cannot print. When it has something to say anyway, it says it here. */
  | { type: "notice"; level: "info" | "warn"; message: string };

export type HarnessEvent = EventEnvelope & EventBody;
