import { describe, expect, it } from "vitest";

import {
  CapabilityUnavailableError,
  LlmUnreachableError,
  SchemaRepairExhaustedError,
  serializeError,
  type Json,
  type SerializedError,
} from "@evaluator/core";

describe("serializeError", () => {
  it("keeps the class name, which is the only thing that survives a process boundary", () => {
    // `class ConfigError extends HarnessError {}` gives you `.name === "Error"` unless someone sets
    // it. Nobody notices until the far side of a pipe reports every failure as "Error".
    expect(serializeError(new LlmUnreachableError("down")).name).toBe("LlmUnreachableError");
    expect(serializeError(new CapabilityUnavailableError("nope")).name).toBe("CapabilityUnavailableError");
  });

  it("marks the HarnessError hierarchy expected, and omits the stack", () => {
    const wire = serializeError(new LlmUnreachableError("Cannot reach a server at http://localhost:1234/v1"));

    expect(wire.expected).toBe(true);
    // A stack trace for "your server isn't running" is noise, and it is noise the CLI would print.
    expect(wire).not.toHaveProperty("stack");
    expect(wire.message).toContain("localhost:1234");
  });

  it("marks anything else unexpected, and KEEPS the stack", () => {
    const wire = serializeError(new TypeError("x is not a function"));

    expect(wire.expected).toBe(false);
    expect(wire.name).toBe("TypeError");
    expect(wire.stack).toContain("TypeError");
  });

  it('survives a non-Error throw, because `throw "boom"` is legal and somebody\'s dep does it', () => {
    expect(serializeError("boom")).toEqual({ name: "UnknownError", message: "boom", expected: false });
    expect(serializeError(undefined).message).toBe("undefined");
  });

  it("carries the structured payload of errors that have one", () => {
    // The whole point of this error: by the time it throws you have spent three round trips learning
    // something. All three raws have to come with it or the failure is undiagnosable.
    const raws = ["not json at all", '{"a": 1}', "```json\n{}\n```"];
    const wire = serializeError(new SchemaRepairExhaustedError("gave up after 3", raws));

    expect(wire.data).toEqual({ attempts: raws });
  });

  /**
   * The load-bearing test. If a `SerializedError` cannot round-trip, neither can any event that
   * carries one, and "a consumer could be a separate process" quietly stops being true.
   */
  it("round-trips through JSON unchanged", () => {
    const cases: SerializedError[] = [
      serializeError(new LlmUnreachableError("down")),
      serializeError(new TypeError("boom")),
      serializeError(new SchemaRepairExhaustedError("gave up", ["a", "b"])),
      serializeError(42),
    ];

    for (const wire of cases) {
      expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    }
  });
});

describe("Json<T>", () => {
  it("accepts a plain data shape", () => {
    const ok: Json<{ a: string; b: number[]; c: { d: boolean | null } }> = {
      a: "x",
      b: [1],
      c: { d: null },
    };
    expect(ok.c.d).toBeNull();
  });

  /**
   * These are compile-time assertions; there is nothing to run. They exist so that the guard is
   * itself guarded — a `Json<T>` that silently accepted a Date would be exactly the class of
   * green-but-useless check this codebase keeps finding in other people's software.
   */
  it("refuses the types that JSON.stringify silently destroys", () => {
    // @ts-expect-error a Date is not JSON — it becomes a string, and the type must say so
    const date: Json<{ at: Date }> = { at: new Date() };

    // @ts-expect-error a function vanishes entirely
    const fn: Json<{ run: () => void }> = { run: () => {} };

    // @ts-expect-error a Set becomes {}
    const set: Json<{ seen: Set<string> }> = { seen: new Set(["a"]) };

    // The assertion is that the three directives above FIRED. If `Json<T>` ever went soft and started
    // accepting a Date, tsc would report the @ts-expect-error as unused and `pnpm typecheck` would
    // fail — which is the only place this test has teeth, since vitest does not typecheck.
    expect([date, fn, set]).toHaveLength(3);
  });
});
