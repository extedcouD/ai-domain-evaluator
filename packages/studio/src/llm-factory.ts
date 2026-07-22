/**
 * Build a transport (`Llm`) from a per-REQUEST config, bypassing the env seam.
 *
 * Mirrors the CLI's `makeLlm` (packages/cli/src/cli.ts) but takes its inputs from an API body rather
 * than `process.env`, so a user can point a run at their OWN endpoint and protocol from the dashboard.
 * The provider PACKAGES are imported here (dynamically, exactly as the CLI does) — the eslint SDK wall
 * bans only the raw `openai`/`@anthropic-ai/sdk` SDKs, never these wrappers, so this stays architecture-
 * legal. The API key is passed through and captured by the returned client; it is never persisted.
 */
import type { Llm, LlmConfig } from "@evaluator/core";

import type { EvalProvider } from "./db";

/** A single endpoint's transport config as the API accepts it (source or judge). Includes the SECRET. */
export interface EndpointConfig {
  provider: EvalProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** OpenAI-only knob; ignored for Anthropic. Defaults to the portable `json_schema` path. */
  schemaMode?: "json_schema" | "structured_outputs";
}

/** Construct the transport for the endpoint's protocol. Async because the provider package is lazy-imported. */
export async function makeLlm(cfg: EndpointConfig): Promise<Llm> {
  const base: LlmConfig = {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature ?? 0,
    topP: cfg.topP ?? 1,
    maxTokens: cfg.maxTokens ?? 1024,
  };

  if (cfg.provider === "anthropic") {
    const { createAnthropicLlm } = await import("@evaluator/provider-anthropic");
    return createAnthropicLlm(base);
  }

  const { createOpenAiLlm } = await import("@evaluator/provider-openai");
  return createOpenAiLlm({ ...base, schemaMode: cfg.schemaMode ?? "json_schema" });
}
