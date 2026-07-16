/**
 * The vocabulary the rest of the codebase speaks.
 *
 * Nothing here is imported from a provider SDK, and nothing here names a model, vendor, or runtime.
 * That is deliberate: a provider adapter (@evaluator/provider-openai, @evaluator/provider-anthropic)
 * translates between these types and whatever backend is plugged in. If SDK types leaked past that
 * boundary, the seam would only be a seam by convention — and the harness could not ship as something
 * a different model connects to.
 *
 * Everything here is also JSON-serializable, which is a second and separate promise. See
 * `serialize.ts` for why `JSON.stringify` will not warn you when you break that.
 */

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  /** Null when the turn was purely a tool call — the model said nothing, it just reached for a tool. */
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  /** Which call this answers. Omitting it is a 400 from every backend. */
  toolCallId: string;
  content: string;
}

/**
 * A discriminated union, rather than one `{ role, content }` shape with optional extras.
 *
 * The flat shape would let you write `{ role: "user", toolCallId: "x" }` — nonsense the compiler
 * would wave through — and, worse, would let you build a tool result with no `toolCallId` at all.
 * That is a 400 from every backend, and it is the single easiest thing to get wrong when writing an
 * agent loop, because nothing catches it until the wire does. Make it unrepresentable.
 */
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** Derived, so it cannot drift from the union above. */
export type Role = ChatMessage["role"];

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  /** The model reads this. It is a prompt, not documentation — write it for the model. */
  description: string;
  /** JSON Schema for the arguments object. Sanitized before it goes on the wire, same as `schema`. */
  parameters: JsonSchema;
}

/**
 * A tool call the model asked for.
 *
 * `arguments` is RAW TEXT — deliberately not `unknown`, not a parsed object. A model that is not
 * under a grammar emits broken JSON, trailing commas, markdown fences, and the occasional apology.
 * The repair loop needs the broken text to hand back, and a human debugging it needs to see exactly
 * what came off the wire. Parse it with the tool's own schema, and treat failure as ordinary —
 * because on half the backends in this space, it is.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  /** What the model gets to see. Serialize it yourself; the seam does not guess at your types. */
  content: string;
  /**
   * True means the tool threw. The model still sees `content` — an error it can read is a repairable
   * state, and hiding it just makes the model call the tool again in exactly the same way.
   */
  isError: boolean;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

/** A JSON Schema document, e.g. the output of `z.toJSONSchema(MySchema)`. */
export type JsonSchema = Record<string, unknown>;

/**
 * Everything a provider adapter needs to talk to a backend. Injected, never read from the
 * environment.
 *
 * Deliberately vendor-neutral: there is no `schemaMode` here. HOW a schema is attached to a request
 * is a per-provider concern (OpenAI's `response_format` vs Anthropic's forced tool call), so it lives
 * in each provider's own config type, not in the shared shape every backend must satisfy.
 */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TokenLogprob {
  token: string;
  logprob: number;
}

/**
 * A normalized reason a completion ended, mapped by each adapter from its wire vocabulary.
 *
 * The original harness leaked OpenAI's `"length"` string all the way into the budget brake, so an
 * Anthropic backend (which says `"max_tokens"`) would have silently failed the same check. This enum
 * is the neutral vocabulary every provider maps onto: OpenAI `length`→`length`, Anthropic
 * `max_tokens`→`length`, `tool_use`/`tool_calls`→`tool_calls`, and so on. `other` is the honest
 * bucket for a value we don't model, so a new backend never silently reads as `stop`.
 */
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

export interface CompletionResult {
  /** Text of the first choice. Convenience for the common n === 1 case. */
  text: string;
  /**
   * All choices, in order.
   *
   * NOT necessarily of length `n`. Ollama accepts `n: 5`, returns 200, and hands back exactly one
   * choice. Check a capability probe before you believe this array.
   */
  choices: string[];
  /**
   * The model's scratchpad, if it has one. Null when the model didn't think, or isn't the type that
   * does.
   *
   * This field exists because dropping it is a SILENT failure, and an expensive one. A hybrid-
   * reasoning model streams its thinking in a sibling field (`reasoning_content` / `thinking`) that
   * the provider SDKs do not type. Ignore it, and a short `maxTokens` produces a call that returns
   * 200 OK, bills you for every completion token, and hands back an empty string — because the model
   * spent its entire budget thinking and never reached the answer. Nothing anywhere reports a problem.
   *
   * Keeping it separate from `text` is what lets a caller tell "the model said nothing" from "the
   * model thought and ran out of room", which are the same bytes and very different bugs.
   */
  reasoningText: string | null;
  /** Tools the model asked for. Empty when it asked for none. Reassembled from wire fragments. */
  toolCalls: ToolCall[];
  /**
   * Zeroes when the server didn't report usage.
   *
   * A streamed call against a server with no usage support reports nothing, and that is precisely why
   * `complete()` is a real non-streaming request rather than a wrapper around `stream()`.
   */
  usage: TokenUsage;
  /** Wall-clock round trip, including network. */
  latencyMs: number;
  /** Time to first token. Null when the call wasn't streamed — there were no tokens to be first. */
  firstTokenMs: number | null;
  /** Model the server reports it actually used, which may differ from what we asked for. */
  model: string;
  /** Normalized by the adapter; `null` when the backend reported nothing. */
  finishReason: FinishReason | null;
  /** Only when `logprobs` was asked for AND the backend honors it. First choice only. */
  logprobs: TokenLogprob[] | null;
}

/**
 * A complete, serializable description of one model call.
 *
 * There is deliberately no `AbortSignal` in here. This object is an instrument reading — you want to
 * log it, diff it, replay it — and `JSON.stringify` does not throw on an `AbortSignal`. It emits `{}`
 * and moves on, so the field would silently vanish from every request you ever captured.
 * Cancellation is a call-lifecycle concern, not a model parameter, and it goes in a second argument
 * where it belongs.
 */
export interface CompleteOptions {
  messages: ChatMessage[];
  /**
   * When present, the model is constrained to emit JSON matching this schema.
   * Pass the output of `z.toJSONSchema(...)`; it is sanitized for the backend before being sent.
   * Always validate the response with the same Zod schema afterwards — see `probeSchemaEnforcement`
   * for why you cannot assume the constraint was applied.
   */
  schema?: JsonSchema;
  /** Schema name, required by some structured-output backends (e.g. OpenAI's `json_schema`). */
  schemaName?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Number of completions to sample. Not honored by every backend; verify before relying on it. */
  n?: number;
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  /** Varies emulated samples. Backends that don't know it ignore it, which is harmless. */
  seed?: number;
  logprobs?: boolean;
}

/** One increment of a streaming response. The seam's unit of liveness. */
export type LlmChunk =
  | { kind: "text"; text: string }
  /**
   * Scratchpad. A hybrid-reasoning model thinking out loud, before it says anything.
   *
   * Kept SEPARATE from `text` rather than merged into it: it is not the answer, so appending it would
   * corrupt the answer; and it is exactly what an instrument should show — a UI can render it dim, or
   * fold it away, but only if it can tell the two apart. Dropping it, which is what a naive reader of
   * the wire format does, is worse than either. See `reasoningText` on `CompletionResult`.
   */
  | { kind: "reasoning"; text: string }
  /**
   * A fragment of a tool call, exactly as the wire sent it.
   *
   * `argumentsDelta` is a SLICE OF A JSON STRING, not JSON. Servers split it anywhere — mid-token,
   * mid-string, mid-escape. It exists so a UI can show a call taking shape. Do not act on it. Act on
   * `CompletionResult.toolCalls`, which the adapter reassembles, because stitching index-keyed
   * fragments back together is a wire detail, and wire details do not cross the seam.
   */
  | { kind: "tool_call_delta"; index: number; id: string | null; name: string | null; argumentsDelta: string }
  /** Always last, exactly once. A stream that ends without it is a server that hung up mid-completion. */
  | { kind: "done"; result: CompletionResult };

export interface HealthResult {
  baseUrl: string;
  /** Model IDs the server reports it is serving. */
  models: string[];
  /** Whether the configured model is among them. */
  servingConfiguredModel: boolean;
}

/** Did the backend actually apply the schema, or merely accept it? */
export interface SchemaProbeResult {
  enforced: boolean;
  /** What came back, so a failure is diagnosable rather than just a boolean. */
  raw: string;
  detail: string;
}

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/**
 * The transport seam — what it means to "be a backend".
 *
 * Swapping backends means constructing a different adapter (each `create*Llm(cfg)` returns this),
 * and touching nothing downstream of it.
 *
 * `signal` is a second parameter rather than a field on `opts`; see the note on `CompleteOptions`.
 * The signal is the only way to cancel a call you are still awaiting the first chunk of, which is the
 * common case for a ctrl-C.
 */
export interface Llm {
  complete(opts: CompleteOptions, signal?: AbortSignal): Promise<CompletionResult>;
  stream(opts: CompleteOptions, signal?: AbortSignal): AsyncIterable<LlmChunk>;
  health(): Promise<HealthResult>;
  probeSchemaEnforcement(): Promise<SchemaProbeResult>;
}
