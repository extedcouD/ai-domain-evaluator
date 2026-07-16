/**
 * The OpenAI-compatible transport adapter.
 *
 * This is one implementation of the `Llm` seam, and the ONLY package permitted to import the OpenAI
 * SDK (a rule the ESLint config enforces at the package boundary). It is PURE: it reads no
 * environment, holds no global state, and has no import-time side effects. You get a client by calling
 * `createOpenAiLlm(cfg)`.
 *
 * No model, vendor, or runtime is named beyond "OpenAI-compatible". The backend is whatever
 * `cfg.baseUrl` points at: vLLM, LM Studio, Ollama, llama.cpp, a hosted API.
 */
import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import {
  isPlainObject,
  LlmAbortedError,
  LlmError,
  LlmModelNotFoundError,
  LlmUnreachableError,
  sanitizeSchema,
  type ChatMessage,
  type CompleteOptions,
  type CompletionResult,
  type FinishReason,
  type HealthResult,
  type Llm,
  type LlmChunk,
  type LlmConfig,
  type SchemaProbeResult,
  type TokenLogprob,
  type TokenUsage,
  type ToolCall,
  type ToolSpec,
} from "@evaluator/core";

/**
 * How this adapter attaches a JSON Schema to a request.
 *
 * - `json_schema`         OpenAI's `response_format`. What OpenAI, LM Studio, Ollama and llama.cpp
 *                         all read. Portable — prefer it.
 * - `structured_outputs`  vLLM's native field. Not portable, but the door to non-JSON constraints.
 *
 * This is provider-specific, which is why it lives here and not in the shared `LlmConfig`: LM Studio
 * enforces schemas under `json_schema` and ignores them entirely under `structured_outputs`. Same
 * server, same model, opposite answer.
 */
export type SchemaMode = "json_schema" | "structured_outputs";

/** The seam config plus the one OpenAI-specific knob. `schemaMode` defaults to the portable path. */
export type OpenAiConfig = LlmConfig & { schemaMode?: SchemaMode };

/**
 * Request fields the OpenAI SDK doesn't type (vLLM's `structured_outputs`, Ollama's
 * `reasoning_effort`). The SDK does not strip unknown body keys, so widening the param type is all
 * that's needed. Assigning to a *variable* rather than an inline literal sidesteps excess-property
 * checking — which is why there is no cast and no @ts-expect-error in this file.
 *
 * Do NOT inject these through the second `RequestOptions` argument: the SDK does `{ body, ...options }`,
 * so an `options.body` there *replaces* the entire request body.
 */
type Extras = {
  structured_outputs?: { json: Record<string, unknown> };
  reasoning_effort?: string;
};
type ChatParams = ChatCompletionCreateParamsNonStreaming & Extras;
type ChatStreamParams = ChatCompletionCreateParamsStreaming & Extras;

/**
 * The reverse of `Extras`: fields servers SEND that the SDK doesn't type.
 *
 * A hybrid-reasoning model streams its scratchpad in `reasoning_content` (LM Studio, vLLM, DeepSeek)
 * or `thinking` (Ollama), a sibling of `content`. Drop it and a short `maxTokens` yields 200 OK, a
 * full and correct usage bill, and an empty string for an answer — because the model spent its whole
 * budget reasoning and never reached the reply.
 */
type ReasoningDelta = { reasoning_content?: string | null; thinking?: string | null };

function readReasoning(from: unknown): string {
  const r = from as ReasoningDelta | undefined;
  return r?.reasoning_content ?? r?.thinking ?? "";
}

/** Map OpenAI's finish_reason vocabulary onto the neutral enum. `other` keeps a new value honest. */
function toFinishReason(raw: string | null | undefined): FinishReason | null {
  switch (raw) {
    case null:
    case undefined:
      return null;
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------------------------
// Our vocabulary -> the wire
// ---------------------------------------------------------------------------------------------

/**
 * The one place a `ChatMessage` becomes an SDK message.
 *
 * Exhaustive by `switch` on the discriminant, so adding a role to the union fails to compile here
 * rather than silently sending a message the server rejects.
 */
function toWireMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((t) => ({
                  id: t.id,
                  type: "function" as const,
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        };
    }
  });
}

/** Tool arguments get the same sanitizing as a response schema — they reach the same grammar backend. */
function toWireTools(tools: ToolSpec[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) },
  }));
}

/**
 * The single place a request body is built.
 *
 * Both `complete()` and `stream()` call it, so the schema sanitizing and the `reasoning_effort` rule
 * cannot drift apart — which they would, because the very reason those are two separate wire calls is
 * the reason someone will one day "fix" one of them and not the other.
 */
function buildBody(cfg: OpenAiConfig, opts: CompleteOptions): ChatParams {
  const body: ChatParams = {
    model: cfg.model,
    messages: toWireMessages(opts.messages),
    temperature: opts.temperature ?? cfg.temperature,
    top_p: opts.topP ?? cfg.topP,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    n: opts.n ?? 1,
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toWireTools(opts.tools);
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  }

  if (opts.seed !== undefined) body.seed = opts.seed;
  if (opts.logprobs === true) body.logprobs = true;

  if (opts.schema) {
    const schema = sanitizeSchema(opts.schema);
    const name = opts.schemaName ?? "response";

    if ((cfg.schemaMode ?? "json_schema") === "json_schema") {
      // The portable path: identical bytes to what api.openai.com expects, and what LM Studio,
      // Ollama and llama.cpp all read. Some servers ignore `name`/`strict` and read only `schema` —
      // so client-side validation, not `strict`, is what actually protects you.
      body.response_format = { type: "json_schema", json_schema: { name, schema, strict: true } };
    } else {
      body.structured_outputs = { json: schema };
    }

    // A grammar constrains the WHOLE output, so reasoning tokens would be illegal under it. On a
    // hybrid-reasoning model, thinking + a schema is either a hard error or a silently unenforced
    // schema. Constrained decoding and thinking are mutually exclusive today; this picks constrained
    // decoding. Servers that don't know the field ignore it.
    body.reasoning_effort = "none";
  }

  return body;
}

// ---------------------------------------------------------------------------------------------
// The wire -> our vocabulary
// ---------------------------------------------------------------------------------------------

/** The SDK's `usage` is optional. Absent usage means zero, not a crash. */
function toTokenUsage(usage: OpenAI.Completions.CompletionUsage | undefined | null): TokenUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

function toLogprobs(choice: { logprobs?: { content?: unknown } | null } | undefined): TokenLogprob[] | null {
  const content = choice?.logprobs?.content;
  if (!Array.isArray(content)) return null;

  return content.map((entry: unknown) => {
    const e = entry as { token?: unknown; logprob?: unknown };
    return {
      token: typeof e.token === "string" ? e.token : "",
      logprob: typeof e.logprob === "number" ? e.logprob : 0,
    };
  });
}

/**
 * Reassemble streamed tool-call fragments.
 *
 * The wire sends a tool call as a sequence of deltas keyed by `index`, and it splits the `arguments`
 * JSON string ANYWHERE — mid-key, mid-value, mid-escape. Concatenating by index is the only correct
 * way to put it back together, and it is exactly the kind of wire detail that must not escape this
 * file: a caller who tried to `JSON.parse` a fragment would be parsing `{"loc` and wondering why.
 */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(index: number, id: string | null, name: string | null, argumentsDelta: string): void {
    const existing = this.byIndex.get(index) ?? { id: "", name: "", args: "" };

    this.byIndex.set(index, {
      // `id` and `name` arrive once, on the first fragment, and are absent from every one after it.
      id: id ?? existing.id,
      name: name ?? existing.name,
      args: existing.args + argumentsDelta,
    });
  }

  toToolCalls(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }));
  }
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

/**
 * Build a client against one OpenAI-compatible endpoint.
 *
 * Everything is injected. Nothing is read from the environment. Call this once and pass the result
 * around, or call it many times to talk to several backends at once.
 */
export function createOpenAiLlm(cfg: OpenAiConfig): Llm {
  const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });

  /**
   * One non-streaming request.
   *
   * This is NOT sugar over `stream()`, and resisting that refactor is load-bearing: streamed usage
   * requires `stream_options: { include_usage: true }` which many servers don't implement (they stream
   * fine and report nothing); `n > 1` interleaves and some servers reject `n` with `stream: true`; and
   * `stream: true` + `response_format` is a 400 on some servers.
   */
  async function complete(opts: CompleteOptions, signal?: AbortSignal): Promise<CompletionResult> {
    const body = buildBody(cfg, opts);

    const startedAt = performance.now();
    let response;
    try {
      response = await client.chat.completions.create(body, signal ? { signal } : {});
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    const choices = response.choices.map((c) => c.message.content ?? "");
    const first = response.choices[0];

    const toolCalls: ToolCall[] = (first?.message.tool_calls ?? []).flatMap((t) =>
      // The SDK union also covers custom (non-function) tools, which we never emit and can't act on.
      t.type === "function" ? [{ id: t.id, name: t.function.name, arguments: t.function.arguments }] : [],
    );

    const reasoning = readReasoning(first?.message);

    return {
      text: choices[0] ?? "",
      choices,
      reasoningText: reasoning.length > 0 ? reasoning : null,
      toolCalls,
      usage: toTokenUsage(response.usage),
      latencyMs,
      // Not streamed, so there was no "first token". Reporting 0 would be a measurement we never made.
      firstTokenMs: null,
      model: response.model,
      finishReason: toFinishReason(first?.finish_reason),
      logprobs: toLogprobs(first),
    };
  }

  /** One streaming request. Yields text as it arrives, then exactly one `done` carrying the result. */
  async function* stream(opts: CompleteOptions, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
    const body: ChatStreamParams = {
      ...buildBody(cfg, opts),
      stream: true,
      stream_options: { include_usage: true },
    };

    const startedAt = performance.now();
    let firstTokenMs: number | null = null;

    let sdkStream;
    try {
      sdkStream = await client.chat.completions.create(body, signal ? { signal } : {});
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }

    const texts: string[] = [];
    const tools = new ToolCallAccumulator();
    let reasoning = "";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let model = cfg.model;
    let finishReason: string | null = null;

    try {
      for await (const chunk of sdkStream) {
        // The final usage frame arrives with an EMPTY choices array. Reaching for choices[0] without
        // checking is the classic way to drop the token counts you specifically asked for.
        if (chunk.usage) usage = toTokenUsage(chunk.usage);
        if (chunk.model) model = chunk.model;

        for (const choice of chunk.choices) {
          const index = choice.index;
          const text = choice.delta.content;

          // Scratchpad tokens arrive FIRST and, on a short budget, may be the only tokens there are.
          // They count for TTFT — they are genuinely the first token — but they are not the answer.
          const think = readReasoning(choice.delta);
          if (think.length > 0 && index === 0) {
            firstTokenMs ??= Math.round(performance.now() - startedAt);
            reasoning += think;
            yield { kind: "reasoning", text: think };
          }

          if (typeof text === "string" && text.length > 0) {
            firstTokenMs ??= Math.round(performance.now() - startedAt);
            texts[index] = (texts[index] ?? "") + text;
            // Only choice 0 is streamed to the caller. With n > 1 the rest still accumulate for the
            // final result, but interleaving several choices into one text stream would be nonsense.
            if (index === 0) yield { kind: "text", text };
          }

          for (const t of choice.delta.tool_calls ?? []) {
            const name = t.function?.name ?? null;
            const argumentsDelta = t.function?.arguments ?? "";

            firstTokenMs ??= Math.round(performance.now() - startedAt);
            tools.add(t.index, t.id ?? null, name, argumentsDelta);
            yield { kind: "tool_call_delta", index: t.index, id: t.id ?? null, name, argumentsDelta };
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }

    /**
     * A cancelled stream must NOT look like a finished one.
     *
     * Without this check there is a real, silent bug. The SDK SWALLOWS the abort: when the underlying
     * fetch is aborted mid-stream it catches the `AbortError` and lets the iterator terminate CLEANLY
     * rather than throwing. So the `for await` above simply ends, execution falls through here, and we
     * would emit a perfectly ordinary `done` — partial text, a null finish_reason, zero usage — that a
     * consumer cannot distinguish from the model deciding to stop early. So we ask the signal directly.
     */
    if (signal?.aborted === true) {
      throw new LlmAbortedError("The request was cancelled.");
    }

    // `texts` is index-addressed and may be sparse if a server skips a choice entirely.
    const choices = Array.from(texts, (t: string | undefined) => t ?? "");

    yield {
      kind: "done",
      result: {
        text: choices[0] ?? "",
        choices,
        reasoningText: reasoning.length > 0 ? reasoning : null,
        toolCalls: tools.toToolCalls(),
        usage,
        latencyMs: Math.round(performance.now() - startedAt),
        firstTokenMs,
        model,
        finishReason: toFinishReason(finishReason),
        // No backend streams logprobs usefully today. Ask for them with complete().
        logprobs: null,
      },
    };
  }

  async function health(): Promise<HealthResult> {
    let models: string[];
    try {
      const page = await client.models.list();
      models = page.data.map((m) => m.id);
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }

    return {
      baseUrl: cfg.baseUrl,
      models,
      servingConfiguredModel: models.includes(cfg.model),
    };
  }

  /**
   * Ask the backend to prove it actually enforces schemas.
   *
   * This is not paranoia. EVERY backend in this space returns HTTP 200 with ordinary prose when it
   * doesn't honor `response_format` — none of them error. So we ask for a field the model would never
   * volunteer, against a prompt that invites prose. If the grammar is live, the only legal output is
   * the canary. If we get an essay about Canada, the schema was dropped on the floor.
   */
  async function probeSchemaEnforcement(): Promise<SchemaProbeResult> {
    const result = await complete({
      messages: [{ role: "user", content: "Tell me about Canada." }],
      schema: {
        type: "object",
        properties: { zzz_canary: { type: "integer" } },
        required: ["zzz_canary"],
        additionalProperties: false,
      },
      schemaName: "canary",
      maxTokens: 64,
    });

    try {
      const parsed: unknown = JSON.parse(result.text);
      if (isPlainObject(parsed) && typeof parsed["zzz_canary"] === "number") {
        return { enforced: true, raw: result.text, detail: "Grammar is live; output matched the canary schema." };
      }
      return {
        enforced: false,
        raw: result.text,
        detail: "Server returned JSON, but not the requested shape. The schema is not being enforced.",
      };
    } catch {
      return {
        enforced: false,
        raw: result.text,
        detail:
          "Server returned free text instead of the canary schema. `response_format` was accepted and SILENTLY IGNORED.",
      };
    }
  }

  return { complete, stream, health, probeSchemaEnforcement };
}

// ---------------------------------------------------------------------------------------------
// Errors you can act on
// ---------------------------------------------------------------------------------------------

/**
 * Turn SDK exceptions into something that tells you what to do next. A stack trace through
 * node:internal/deps/undici is not a useful thing to hand someone whose server isn't running.
 */
async function toActionableError(error: unknown, cfg: OpenAiConfig, client: OpenAI): Promise<Error> {
  // MUST come first. An aborted fetch and a dead server look nearly identical from the SDK's side,
  // and telling someone their server is down because they pressed ctrl-C is a maddening bug. This is
  // the only error the harness treats as "they meant to do that".
  if (error instanceof APIUserAbortError) {
    return new LlmAbortedError("The request was cancelled.");
  }

  if (error instanceof APIConnectionError) {
    return new LlmUnreachableError(
      [
        `Cannot reach an OpenAI-compatible server at ${cfg.baseUrl}`,
        ``,
        `  • Is the server running?`,
        `  • Is LLM_BASE_URL right?   (currently ${cfg.baseUrl})`,
        `  • Check it by hand:        curl ${cfg.baseUrl}/models`,
      ].join("\n"),
    );
  }

  if (error instanceof APIError && error.status === 404) {
    // The server answered, so it's up — it just doesn't have this model. Say what it *does* have.
    const served = await listModelsQuietly(client);
    const known = served.length > 0 ? served.map((m) => `      - ${m}`).join("\n") : `      (none reported)`;

    return new LlmModelNotFoundError(
      [
        `The server at ${cfg.baseUrl} is up, but is not serving "${cfg.model}".`,
        ``,
        `  It is serving:`,
        known,
        ``,
        `  Set LLM_MODEL in .env to one of the above.`,
      ].join("\n"),
    );
  }

  if (error instanceof APIError) {
    return new LlmError(`LLM request failed (HTTP ${String(error.status)}): ${error.message}`);
  }

  return error instanceof Error ? error : new LlmError(String(error));
}

/** Best-effort: we're already in an error path, so a second failure must not mask the first. */
async function listModelsQuietly(client: OpenAI): Promise<string[]> {
  try {
    const page = await client.models.list();
    return page.data.map((m) => m.id);
  } catch {
    return [];
  }
}
