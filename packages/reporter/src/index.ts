/**
 * Structured logging for the harness — as a SINK over the engine's event stream, never a logger
 * inside the engine.
 *
 * This is the whole point of the engine emitting JSON-serializable events: the event IS the
 * structured log record. So "add logging" is not "thread a logger through the call stack" — it is
 * "attach a consumer to `Run.events`". The engine stays pure (it prints nothing, holds no logger),
 * and this zero-dependency package turns the same events a TUI renders into newline-delimited JSON on
 * disk and, optionally, human lines on a terminal.
 *
 * One caveat drives the API: `Run.events` is SINGLE-consumer (see run.ts). So `logRun` is THE
 * consumer of a run's events — if a front-end also wants to render, it passes `onEvent` rather than
 * iterating the stream a second time (which would throw). The run's return value is unaffected:
 * await `run.result` alongside, as always.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { HarnessEvent, Run } from "@evaluator/core";

import { formatLine } from "./format";

export interface SinkOptions {
  /** Newline-delimited JSON destination. Parent dirs are created; the file is appended to. */
  file?: string;
  /** Render a human line per event. Ignored when `onEvent` is given (that becomes the renderer). */
  pretty?: boolean;
  /** Where pretty lines go. Default `process.stdout`. */
  stream?: NodeJS.WritableStream;
  /** A front-end's own per-event renderer. Runs in addition to file logging; suppresses `pretty`. */
  onEvent?: (event: HarnessEvent) => void;
  /** Include per-token `llm.delta` / `llm.reasoning` events. Off by default — they are stream spam. */
  includeTokens?: boolean;
}

/**
 * Drain a run's events into structured logs. Resolves when the stream ends (the run finished, failed,
 * or was cancelled — all of which arrive AS events). It never throws on a failed run: the failure is
 * an event too. Await `run.result` separately for the value or the thrown error.
 */
export async function logRun(run: Run<unknown>, opts: SinkOptions = {}): Promise<void> {
  const toFile = opts.file ? fileWriter(opts.file) : null;
  const render = opts.onEvent ?? (opts.pretty ? consoleWriter(opts.stream ?? process.stdout) : null);

  for await (const event of run.events) {
    if (!opts.includeTokens && (event.type === "llm.delta" || event.type === "llm.reasoning")) continue;
    toFile?.(event);
    render?.(event);
  }
}

function fileWriter(file: string): (event: HarnessEvent) => void {
  mkdirSync(dirname(file), { recursive: true });
  // Append one JSON object per line. The event is already `Json<T>`-clean, so `JSON.stringify` is
  // lossless here — the same guarantee that lets it cross a process boundary.
  return (event) => appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function consoleWriter(stream: NodeJS.WritableStream): (event: HarnessEvent) => void {
  const color = (stream as NodeJS.WriteStream).isTTY === true;
  return (event) => stream.write(`${formatLine(event, color)}\n`);
}

export { formatLine, levelOf, type Level } from "./format";
