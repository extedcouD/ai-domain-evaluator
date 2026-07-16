/**
 * Turning one `HarnessEvent` into a human-readable line.
 *
 * Pure — no I/O, no clock of its own (it reads `event.at`, the epoch-ms the engine already stamped).
 * The structured record is the event itself; this is only the pretty face on top of it, so a person
 * watching a run sees words instead of JSON. Colour is applied with raw ANSI (zero-dependency) and
 * only when the destination is a TTY.
 */
import type { HarnessEvent } from "@evaluator/core";

export type Level = "debug" | "info" | "warn" | "error";

export function levelOf(event: HarnessEvent): Level {
  switch (event.type) {
    case "notice":
      return event.level === "warn" ? "warn" : "info";
    case "run.failed":
      return "error";
    case "run.cancelled":
    case "run.dropped":
    case "budget.exhausted":
      return "warn";
    case "llm.request":
    case "llm.response":
    case "llm.delta":
    case "llm.reasoning":
      return "debug";
    default:
      return "info"; // run.started, run.finished
  }
}

function messageOf(event: HarnessEvent): string {
  // Captured as a plain string up front: events cross a process boundary as JSON, so a newer producer
  // could send a type this switch doesn't know — the default returns it rather than throwing.
  const type: string = event.type;
  switch (event.type) {
    case "run.started":
      return `▶ ${event.kind} · ${event.label}`;
    case "run.finished":
      return `■ finished in ${String(event.ms)}ms · ${String(event.usage.totalTokens)} tok`;
    case "run.failed":
      return `✖ ${event.error.name}: ${event.error.message}`;
    case "run.cancelled":
      return `▲ cancelled: ${event.reason}`;
    case "run.dropped":
      return `dropped ${String(event.count)} events (consumer fell behind)`;
    case "llm.request":
      return `→ ${event.model || "model"} · ${String(event.messageCount)} msgs`;
    case "llm.response":
      return `← ${String(event.usage.totalTokens)} tok · ${String(event.latencyMs)}ms`;
    case "llm.delta":
    case "llm.reasoning":
      return event.text;
    case "budget.exhausted":
      return `budget exhausted: ${String(event.reasoningChars)} reasoning chars, max_tokens=${String(event.maxTokens)}`;
    case "notice":
      return event.message;
    default:
      return type;
  }
}

const COLOR: Record<Level, string> = { debug: "2", info: "36", warn: "33", error: "31" };

const paint = (code: string, s: string, on: boolean): string => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

/** A single log line: `HH:MM:SS  level  run_id  message`. */
export function formatLine(event: HarnessEvent, color: boolean): string {
  const level = levelOf(event);
  const ts = paint("2", clock(event.at), color);
  const lvl = paint(COLOR[level], level.padEnd(5), color);
  const run = paint("2", event.runId, color);
  return `${ts} ${lvl} ${run}  ${messageOf(event)}`;
}

function clock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
