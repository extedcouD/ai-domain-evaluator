import { describe, expect, it } from "vitest";

import { ConfigError, parseEnv, toLlmConfig } from "@evaluator/core";

describe("parseEnv", () => {
  it("defaults the provider to openai and coerces numbers out of strings", () => {
    const c = parseEnv({ LLM_MODEL: "qwen", TEMPERATURE: "0.7", MAX_TOKENS: "512" });
    expect(c.LLM_PROVIDER).toBe("openai");
    expect(c.TEMPERATURE).toBe(0.7);
    expect(c.MAX_TOKENS).toBe(512);
  });

  it("throws loudly when LLM_MODEL is missing", () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
    expect(() => parseEnv({})).toThrow(/LLM_MODEL/);
  });

  it("rejects a base URL missing its scheme rather than failing later at request time", () => {
    // Bare z.url() would ACCEPT this — the WHATWG parser reads "localhost:" as the scheme.
    expect(() => parseEnv({ LLM_MODEL: "qwen", LLM_BASE_URL: "localhost:8000" })).toThrow(ConfigError);
  });

  it("rejects an unknown provider", () => {
    expect(() => parseEnv({ LLM_MODEL: "qwen", LLM_PROVIDER: "cohere" })).toThrow(ConfigError);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(parseEnv({ LLM_MODEL: "qwen" }))).toBe(true);
  });
});

describe("toLlmConfig", () => {
  it("defaults the base URL per provider when the env omits it", () => {
    expect(toLlmConfig(parseEnv({ LLM_MODEL: "m" })).baseUrl).toBe("http://localhost:1234/v1");
    expect(toLlmConfig(parseEnv({ LLM_MODEL: "m", LLM_PROVIDER: "anthropic" })).baseUrl).toBe(
      "https://api.anthropic.com",
    );
  });

  it("passes an explicit base URL through, and carries no provider-specific knob", () => {
    const cfg = toLlmConfig(parseEnv({ LLM_MODEL: "m", LLM_BASE_URL: "http://x:9/v1" }));
    expect(cfg.baseUrl).toBe("http://x:9/v1");
    // The generic seam config names no schema mode — that lives in the provider that needs it.
    expect(cfg).not.toHaveProperty("schemaMode");
  });
});
