/**
 * The rule that makes the engine/front-end boundary real: everything that crosses it is DATA.
 *
 * A front-end imports the core in-process today. It could just as well spawn it and read JSON lines
 * off a pipe, and the only reason that stays a ~30-line adapter instead of a rewrite is that nothing
 * on the wire is a class instance, a Date, a Map, or a function.
 *
 * `JSON.stringify` will not help you hold that line. It does not throw on any of those — it quietly
 * drops them and hands you a plausible-looking object:
 *
 *     JSON.stringify(new Error("the server is down"))   ===  "{}"
 *     JSON.stringify({ at: new Date() })                ===  '{"at":"2026-07-14T..."}'   // now a string
 *     JSON.stringify({ seen: new Set([1, 2]) })         ===  '{"seen":{}}'
 *
 * The first one is the dangerous one. The reason your run failed becomes an empty object, and
 * nothing anywhere reports a problem. So `Json<T>` below refuses to compile such a type, and the
 * event suite round-trips every variant through `JSON.parse(JSON.stringify(x))` and demands it come
 * back equal. That test is the actual definition of "decoupled" in this codebase.
 */
import { HarnessError } from "./errors";

/**
 * A type that is exactly what survives a JSON round trip.
 *
 * `Json<MyEvent>` fails to compile if the event carries a Date, an Error, a Map, a Set, or a
 * function. Applied to `HarnessEvent`, it turns "please remember to keep events serializable" from a
 * comment nobody reads into a compile error nobody can ignore.
 *
 * `unknown` and `any` are deliberately rejected too: they are the hole through which a Date walks in.
 */
export type Json<T> = T extends string | number | boolean | null
  ? T
  : T extends readonly (infer U)[]
    ? readonly Json<U>[]
    : T extends (...args: never[]) => unknown
      ? never
      : T extends object
        ? { [K in keyof T]: Json<T[K]> }
        : never;

/**
 * An error, flattened into something that can be printed, piped, or posted.
 *
 * On the far side of a stdio boundary you cannot reconstruct a class, so we don't pretend to. You
 * get the name as a string and the one bit that actually drives behavior.
 */
export interface SerializedError {
  /** The class name: "LlmUnreachableError", "SchemaRepairExhaustedError", … */
  name: string;
  /** The multi-line, actionable text. The thing a human should read. */
  message: string;
  /**
   * True for the `HarnessError` hierarchy: a state we anticipated and can explain.
   *
   * This is the same distinction the CLI already makes, and it is the entire reason that hierarchy
   * exists — a server that isn't running and a missing env var are ordinary states that deserve a
   * sentence you can act on. Everything else is a real bug and keeps its stack.
   */
  expected: boolean;
  /** Only when `expected` is false. A stack trace for "the server isn't running" is noise. */
  stack?: string;
  /** Structured payload from errors that carry one — e.g. every raw attempt of a failed repair. */
  data?: Record<string, unknown>;
}

/** Anything at all — including the non-Errors that `throw` permits — becomes reportable data. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof HarnessError) {
    const out: SerializedError = { name: error.name, message: error.message, expected: true };
    const data = extraData(error);
    if (data !== undefined) out.data = data;
    return out;
  }

  if (error instanceof Error) {
    const out: SerializedError = { name: error.name, message: error.message, expected: false };
    // `exactOptionalPropertyTypes` means assigning `undefined` is not the same as omitting the key,
    // and the round-trip test can tell the difference: JSON.stringify drops undefined values, so
    // `{stack: undefined}` comes back as `{}` and fails the deep-equal.
    if (error.stack !== undefined) out.stack = error.stack;
    return out;
  }

  // `throw "boom"` is legal JavaScript and someone's dependency does it.
  return { name: "UnknownError", message: String(error), expected: false };
}

/**
 * Pull the structured payload off the errors that carry one.
 *
 * Deliberately a lookup here rather than a `toJSON()` on each class: `errors.ts` imports nothing and
 * must stay that way, and a `toJSON()` there would be the first crack in that.
 */
function extraData(error: HarnessError): Record<string, unknown> | undefined {
  if ("attempts" in error && Array.isArray(error.attempts)) {
    return { attempts: error.attempts as readonly string[] };
  }
  return undefined;
}
