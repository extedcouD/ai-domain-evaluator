/**
 * The public surface of @evaluator/core.
 *
 * If it is not exported here, a front-end (or a provider adapter) cannot import it — which is what
 * makes "the front-end is decoupled" a fact about the module graph rather than a promise about
 * discipline. Deliberately re-exports NO provider SDK, no `dotenv`, no `process.env`, and nothing
 * that prints.
 */

// ── runtime: the vocabulary and the run machinery ──────────────────────────────────────────────
export { toRun } from "./runtime/run";
export type { Run } from "./runtime/run";
export { serializeError } from "./runtime/serialize";
export type { Json, SerializedError } from "./runtime/serialize";
export type { EventBody, HarnessEvent, RunKind } from "./runtime/events";
export {
  HarnessError,
  ConfigError,
  LlmError,
  LlmUnreachableError,
  LlmModelNotFoundError,
  LlmAbortedError,
  EngineError,
  SchemaRepairExhaustedError,
  CapabilityUnavailableError,
} from "./runtime/errors";
export type {
  AssistantMessage,
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  FinishReason,
  HealthResult,
  JsonSchema,
  Llm,
  LlmChunk,
  LlmConfig,
  Role,
  SchemaProbeResult,
  SystemMessage,
  TokenLogprob,
  TokenUsage,
  ToolCall,
  ToolMessage,
  ToolResult,
  ToolSpec,
  UserMessage,
} from "./runtime/types";

// ── transport seam: schema sanitizing + env parsing (no SDK, no env read) ──────────────────────
export { sanitizeSchema, isPlainObject } from "./transport-seam/sanitizeSchema";
export { parseEnv, toLlmConfig } from "./transport-seam/config";
export type { Config, Provider } from "./transport-seam/config";

// ── profile: domain-as-data ────────────────────────────────────────────────────────────────────
export { defaultProfile, DEFAULT_SUBJECT } from "./profile/profile";
export type { SubjectProfile, ProfileOverrides } from "./profile/profile";

// ── operations/knowledge: the coverage & validation subsystem ──────────────────────────────────
export { createModelKnowledgeSource } from "./operations/knowledge/source";
export type { KnowledgeAnswer, KnowledgeSource } from "./operations/knowledge/source";
export { parseManifest, topicKey } from "./operations/knowledge/manifest";
export type { Manifest, Topic } from "./operations/knowledge/manifest";
export { createJudge } from "./operations/knowledge/judge";
export type { AnswerVerdict, Judge, Specificity, Stance } from "./operations/knowledge/judge";
export { coverage } from "./operations/knowledge/coverage";
export type {
  CoverageOptions,
  CoverageReport,
  TopicResult,
  TopicStatus,
} from "./operations/knowledge/coverage";
export { rollup } from "./operations/knowledge/rollup";
export type { CoverageNode, CoverageTree } from "./operations/knowledge/rollup";
export { validate } from "./operations/knowledge/validate";
export type { ClaimResult, ClaimVerdict, ValidateOptions, ValidationReport } from "./operations/knowledge/validate";
