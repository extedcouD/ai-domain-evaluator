import { z } from "zod";

import { ConfigError } from "../runtime/errors";
import type { LlmConfig } from "../runtime/types";

/**
 * The SHAPE of the environment, and how to read one — but never an actual read.
 *
 * `parseEnv` is a pure function from a bag of strings to a validated config. It does not touch
 * `process.env`, and this module does not import `dotenv`. That is the whole difference between a
 * library and an application: a library that demands a `.env` at import time cannot be embedded in
 * anything, and the harness is meant to ship — as a plugin, an MCP server, a tool a frontier model
 * calls.
 *
 * Somebody still has to read the actual environment. That somebody is the front-end
 * (`@evaluator/cli`), and a lint rule forbids this package from doing it. This schema is deliberately
 * PROVIDER-NEUTRAL: it carries `LLM_PROVIDER` to pick a transport, but no provider-specific knob
 * (OpenAI's schema mode, say) lives here — those belong to each provider package.
 */
const PROVIDERS = ["openai", "anthropic"] as const;

const EnvSchema = z.object({
  /** Which transport adapter to construct. */
  LLM_PROVIDER: z.enum(PROVIDERS).default("openai"),
  // The protocol check is doing real work: bare `z.url()` accepts "localhost:8000", because the
  // WHATWG parser reads it as scheme "localhost:" with path "8000". Forgetting the http:// is the
  // single likeliest .env typo. Optional here because the sensible default differs per provider —
  // `toLlmConfig` fills it in.
  LLM_BASE_URL: z
    .url({
      protocol: /^https?$/,
      error: "LLM_BASE_URL must be an http(s) URL, e.g. http://localhost:1234/v1",
    })
    .optional(),
  // Local servers ignore this, but the SDK still has to send an Authorization header.
  LLM_API_KEY: z.string().min(1).default("not-needed"),
  LLM_MODEL: z
    .string("LLM_MODEL is required — set it to the name your server is serving")
    .min(1, "LLM_MODEL must not be empty"),
  TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  TOP_P: z.coerce.number().gt(0).max(1).default(1),
  MAX_TOKENS: z.coerce.number().int().positive().default(1024),
});

export type Provider = (typeof PROVIDERS)[number];
export type Config = Readonly<z.infer<typeof EnvSchema>>;

/** The base URL to assume when the environment doesn't set one — different per provider. */
const DEFAULT_BASE_URL: Record<Provider, string> = {
  openai: "http://localhost:1234/v1",
  anthropic: "https://api.anthropic.com",
};

/**
 * Pure, so it can be tested without touching the real environment.
 * Throws — loudly and legibly — rather than returning a half-built config.
 */
export function parseEnv(env: NodeJS.ProcessEnv): Config {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(
      `Invalid environment:\n\n${z.prettifyError(result.error)}\n\n` + `Copy .env.example to .env and fill it in.`,
    );
  }

  return Object.freeze(result.data);
}

/** Adapt the SCREAMING_CASE environment into the provider-neutral shape the seam wants. */
export function toLlmConfig(config: Config): LlmConfig {
  return {
    baseUrl: config.LLM_BASE_URL ?? DEFAULT_BASE_URL[config.LLM_PROVIDER],
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    temperature: config.TEMPERATURE,
    topP: config.TOP_P,
    maxTokens: config.MAX_TOKENS,
  };
}
