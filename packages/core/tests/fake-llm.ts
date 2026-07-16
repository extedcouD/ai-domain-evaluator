/**
 * A fake `Llm` for testing core logic that talks to the seam WITHOUT a real backend.
 *
 * Core must be testable with no provider package and no HTTP server — that is the point of the seam.
 * The wire-level liars (a node:http server that accepts a schema and ignores it) live in the provider
 * test suites, where there is a real socket to lie over. Here we only need an `Llm` that reports
 * whether it enforces schemas and returns a canned reply, which is enough to prove the judge's guard
 * degrades to a heuristic and says so.
 */
import type { CompleteOptions, CompletionResult, HealthResult, Llm, LlmChunk, SchemaProbeResult } from "@evaluator/core";

export interface FakeLlmSpec {
  /** What `probeSchemaEnforcement()` reports, and thus whether the judge trusts its own verdicts. */
  enforced: boolean;
  /** What `complete()` returns as text. Defaults to prose that satisfies no verdict schema. */
  reply?: (opts: CompleteOptions) => string;
}

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export function fakeLlm(spec: FakeLlmSpec): Llm {
  const reply = spec.reply ?? (() => "Canada is a country in North America. It is quite large.");

  const complete = (opts: CompleteOptions): Promise<CompletionResult> => {
    const text = reply(opts);
    return Promise.resolve({
      text,
      choices: [text],
      reasoningText: null,
      toolCalls: [],
      usage: ZERO_USAGE,
      latencyMs: 0,
      firstTokenMs: null,
      model: "fake",
      finishReason: "stop",
      logprobs: null,
    });
  };

  return {
    complete,
    async *stream(opts: CompleteOptions): AsyncGenerator<LlmChunk> {
      const result = await complete(opts);
      yield { kind: "text", text: result.text };
      yield { kind: "done", result };
    },
    health: (): Promise<HealthResult> =>
      Promise.resolve({ baseUrl: "fake://", models: ["fake"], servingConfiguredModel: true }),
    probeSchemaEnforcement: (): Promise<SchemaProbeResult> =>
      Promise.resolve({
        enforced: spec.enforced,
        raw: spec.enforced ? '{"zzz_canary":1}' : "Canada is a country…",
        detail: spec.enforced ? "grammar live" : "schema ignored",
      }),
  };
}
