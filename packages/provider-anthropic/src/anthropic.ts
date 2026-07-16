/**
 * The Anthropic Messages API transport adapter.
 *
 * One implementation of the `Llm` seam, and the ONLY package permitted to import the Anthropic SDK
 * (a rule the ESLint config enforces at the package boundary). Pure: reads no environment, holds no
 * global state, no import-time side effects. You get a client by calling `createAnthropicLlm(cfg)`.
 *
 * The interesting differences from an OpenAI-compatible backend, and how each is handled:
 *   - System prompts are a top-level `system` string, NOT a message in the array → we hoist them.
 *   - There is no `response_format`. Structured output is enforced by a FORCED single-tool call
 *     (`tool_choice: { type: "tool", name }`); the model's `tool_use.input` is the object, which we
 *     serialize back to `text` so a downstream `JSON.parse(result.text)` behaves exactly as it does
 *     for the OpenAI adapter. `probeSchemaEnforcement` runs the same canary through that path.
 *   - Reasoning arrives as `thinking` content blocks → mapped to the `reasoning` channel.
 *   - Streaming is a different SSE event model (message_start / content_block_* / message_delta) and
 *     tool args arrive as `input_json_delta` fragments → reassembled the same way.
 *   - `stop_reason: "max_tokens"` is normalized to the neutral `FinishReason "length"`, so the budget
 *     brake keeps working without string-matching a provider value.
 */
import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";

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
  type JsonSchema,
  type Llm,
  type LlmChunk,
  type LlmConfig,
  type SchemaProbeResult,
  type TokenUsage,
  type ToolCall,
} from "@evaluator/core";

/** The Anthropic adapter needs nothing beyond the shared seam config. */
export type AnthropicConfig = LlmConfig;

/** The synthetic tool name used when a caller asks for structured output. */
const STRUCTURED_TOOL_FALLBACK = "respond";

/** Map Anthropic's stop_reason vocabulary onto the neutral enum. `other` keeps a new value honest. */
function toFinishReason(raw: Anthropic.StopReason | null | undefined): FinishReason | null {
  switch (raw) {
    case null:
    case undefined:
      return null;
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}

function toTokenUsage(input: number, output: number): TokenUsage {
  return { promptTokens: input, completionTokens: output, totalTokens: input + output };
}

// ---------------------------------------------------------------------------------------------
// Our vocabulary -> the wire
// ---------------------------------------------------------------------------------------------

/** Parse tool-call argument text into the object Anthropic wants; broken JSON becomes an empty object. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Split our flat message list into Anthropic's `system` string + `messages` array.
 *
 * System messages are hoisted and joined. A `tool` message becomes a `user` turn carrying a
 * `tool_result` block, and an assistant turn with tool calls becomes `tool_use` blocks — the shape
 * Anthropic requires.
 */
function toWire(messages: ChatMessage[]): { system: string | undefined; messages: Anthropic.MessageParam[] } {
  const systems: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        systems.push(m.content);
        break;
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "tool":
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
        });
        break;
      case "assistant": {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content !== null && m.content.length > 0) blocks.push({ type: "text", text: m.content });
        for (const t of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: t.id, name: t.name, input: parseArgs(t.arguments) });
        }
        out.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
        break;
      }
    }
  }

  return { system: systems.length > 0 ? systems.join("\n\n") : undefined, messages: out };
}

function toWireToolChoice(choice: "auto" | "none" | "required"): Anthropic.ToolChoice {
  switch (choice) {
    case "auto":
      return { type: "auto" };
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
  }
}

interface BuiltBody {
  params: Anthropic.MessageCreateParamsNonStreaming;
  /** The tool name a forced-structured request must read back, or null when no schema was requested. */
  structuredTool: string | null;
}

/**
 * The single place a request body is built, shared by `complete()` and `stream()`.
 *
 * When `opts.schema` is present it installs a forced single-tool call — Anthropic's only reliable
 * structured-output mechanism — and returns the tool name so the readers know which `tool_use.input`
 * is the structured answer.
 */
function buildBody(cfg: AnthropicConfig, opts: CompleteOptions): BuiltBody {
  const { system, messages } = toWire(opts.messages);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    top_p: opts.topP ?? cfg.topP,
  };
  if (system !== undefined) params.system = system;

  if (opts.schema) {
    const name = opts.schemaName ?? STRUCTURED_TOOL_FALLBACK;
    params.tools = [
      {
        name,
        description: "Respond ONLY by calling this tool with the required structure.",
        input_schema: sanitizeSchema(opts.schema) as Anthropic.Tool.InputSchema,
      },
    ];
    params.tool_choice = { type: "tool", name };
    return { params, structuredTool: name };
  }

  if (opts.tools && opts.tools.length > 0) {
    params.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: sanitizeSchema(t.parameters) as Anthropic.Tool.InputSchema,
    }));
    if (opts.toolChoice) params.tool_choice = toWireToolChoice(opts.toolChoice);
  }

  return { params, structuredTool: null };
}

// ---------------------------------------------------------------------------------------------
// The wire -> our vocabulary
// ---------------------------------------------------------------------------------------------

interface Extracted {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

/** Pull text, thinking, and tool calls out of a non-streamed message's content blocks. */
function extractContent(content: Anthropic.ContentBlock[], structuredTool: string | null): Extracted {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  let structuredJson: string | null = null;

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "thinking") {
      reasoning += block.thinking;
    } else if (block.type === "tool_use") {
      const args = JSON.stringify(block.input ?? {});
      toolCalls.push({ id: block.id, name: block.name, arguments: args });
      if (structuredTool !== null && block.name === structuredTool) structuredJson = args;
    }
  }

  // For a forced-structured request, the "text" callers parse is the tool's JSON input.
  return { text: structuredJson ?? text, reasoning, toolCalls };
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

/** Build a client against the Anthropic Messages API (or a compatible base URL). Everything injected. */
export function createAnthropicLlm(cfg: AnthropicConfig): Llm {
  const client = new Anthropic({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });

  async function complete(opts: CompleteOptions, signal?: AbortSignal): Promise<CompletionResult> {
    const { params, structuredTool } = buildBody(cfg, opts);

    const startedAt = performance.now();
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(params, signal ? { signal } : {});
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    const { text, reasoning, toolCalls } = extractContent(message.content, structuredTool);

    return {
      text,
      choices: [text],
      reasoningText: reasoning.length > 0 ? reasoning : null,
      toolCalls,
      usage: toTokenUsage(message.usage.input_tokens, message.usage.output_tokens),
      latencyMs,
      firstTokenMs: null,
      model: message.model,
      finishReason: toFinishReason(message.stop_reason),
      // Anthropic does not expose token logprobs.
      logprobs: null,
    };
  }

  async function* stream(opts: CompleteOptions, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
    const { params, structuredTool } = buildBody(cfg, opts);

    const startedAt = performance.now();
    let firstTokenMs: number | null = null;

    let sdkStream;
    try {
      sdkStream = await client.messages.create({ ...params, stream: true }, signal ? { signal } : {});
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }

    let text = "";
    let reasoning = "";
    let model = cfg.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: Anthropic.StopReason | null = null;
    // Tool calls arrive by content-block index; id/name land on the block-start, args stream after.
    const tools = new Map<number, { id: string; name: string; args: string; structured: boolean }>();

    try {
      for await (const event of sdkStream) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens;
            model = event.message.model;
            break;
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              tools.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                args: "",
                structured: structuredTool !== null && event.content_block.name === structuredTool,
              });
            }
            break;
          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              firstTokenMs ??= Math.round(performance.now() - startedAt);
              text += delta.text;
              yield { kind: "text", text: delta.text };
            } else if (delta.type === "thinking_delta") {
              firstTokenMs ??= Math.round(performance.now() - startedAt);
              reasoning += delta.thinking;
              yield { kind: "reasoning", text: delta.thinking };
            } else if (delta.type === "input_json_delta") {
              firstTokenMs ??= Math.round(performance.now() - startedAt);
              const entry = tools.get(event.index);
              if (entry) entry.args += delta.partial_json;
              yield {
                kind: "tool_call_delta",
                index: event.index,
                id: entry?.id ?? null,
                name: entry?.name ?? null,
                argumentsDelta: delta.partial_json,
              };
            }
            break;
          }
          case "message_delta":
            if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
            outputTokens = event.usage.output_tokens;
            break;
          default:
            // content_block_stop, message_stop, and any future event: nothing to accumulate.
            break;
        }
      }
    } catch (error) {
      throw await toActionableError(error, cfg, client);
    }

    // A cancelled stream must not look like a finished one. See the OpenAI adapter for the full note:
    // the SDK swallows the abort and ends the iterator cleanly, so we ask the signal directly.
    if (signal?.aborted === true) {
      throw new LlmAbortedError("The request was cancelled.");
    }

    const toolCalls: ToolCall[] = [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }));
    const structuredJson = [...tools.values()].find((v) => v.structured)?.args ?? null;

    yield {
      kind: "done",
      result: {
        text: structuredJson ?? text,
        choices: [structuredJson ?? text],
        reasoningText: reasoning.length > 0 ? reasoning : null,
        toolCalls,
        usage: toTokenUsage(inputTokens, outputTokens),
        latencyMs: Math.round(performance.now() - startedAt),
        firstTokenMs,
        model,
        finishReason: toFinishReason(stopReason),
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

    return { baseUrl: cfg.baseUrl, models, servingConfiguredModel: models.includes(cfg.model) };
  }

  /**
   * Prove the backend actually enforces structure. On Anthropic that is a forced tool call, which is
   * reliable — but the harness never assumes; it runs the same canary the OpenAI adapter does, through
   * `complete()`, and reads the result back.
   */
  async function probeSchemaEnforcement(): Promise<SchemaProbeResult> {
    const canary: JsonSchema = {
      type: "object",
      properties: { zzz_canary: { type: "integer" } },
      required: ["zzz_canary"],
      additionalProperties: false,
    };
    const result = await complete({
      messages: [{ role: "user", content: "Tell me about Canada." }],
      schema: canary,
      schemaName: "canary",
      maxTokens: 128,
    });

    try {
      const parsed: unknown = JSON.parse(result.text);
      if (isPlainObject(parsed) && typeof parsed["zzz_canary"] === "number") {
        return { enforced: true, raw: result.text, detail: "Forced tool call returned the canary structure." };
      }
      return {
        enforced: false,
        raw: result.text,
        detail: "The forced tool call did not return the requested shape. Structure is not being enforced.",
      };
    } catch {
      return {
        enforced: false,
        raw: result.text,
        detail: "The model answered in prose instead of the forced structured tool. Structure was not enforced.",
      };
    }
  }

  return { complete, stream, health, probeSchemaEnforcement };
}

// ---------------------------------------------------------------------------------------------
// Errors you can act on
// ---------------------------------------------------------------------------------------------

async function toActionableError(error: unknown, cfg: AnthropicConfig, client: Anthropic): Promise<Error> {
  // MUST come first: an aborted request and a dead server look nearly identical from the SDK's side.
  if (error instanceof APIUserAbortError) {
    return new LlmAbortedError("The request was cancelled.");
  }

  if (error instanceof APIConnectionError) {
    return new LlmUnreachableError(
      [
        `Cannot reach the Anthropic Messages API at ${cfg.baseUrl}`,
        ``,
        `  • Is LLM_BASE_URL right?   (currently ${cfg.baseUrl})`,
        `  • Is LLM_API_KEY set to a valid key?`,
      ].join("\n"),
    );
  }

  if (error instanceof APIError && error.status === 404) {
    const served = await listModelsQuietly(client);
    const known = served.length > 0 ? served.map((m) => `      - ${m}`).join("\n") : `      (none reported)`;
    return new LlmModelNotFoundError(
      [
        `The Anthropic API is up, but is not serving "${cfg.model}".`,
        ``,
        `  It is serving:`,
        known,
        ``,
        `  Set LLM_MODEL in .env to one of the above.`,
      ].join("\n"),
    );
  }

  if (error instanceof APIError) {
    return new LlmError(`Anthropic request failed (HTTP ${String(error.status)}): ${error.message}`);
  }

  return error instanceof Error ? error : new LlmError(String(error));
}

/** Best-effort: we're already in an error path, so a second failure must not mask the first. */
async function listModelsQuietly(client: Anthropic): Promise<string[]> {
  try {
    const page = await client.models.list();
    return page.data.map((m) => m.id);
  } catch {
    return [];
  }
}
