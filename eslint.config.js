// @ts-check
/**
 * THIS FILE IS WHAT ENFORCES THE ARCHITECTURE — not the READMEs, not discipline.
 *
 * Two things it guarantees:
 *   1. The SDK walls. `openai` may be imported ONLY inside @evaluator/provider-openai;
 *      `@anthropic-ai/sdk` ONLY inside @evaluator/provider-anthropic. Every other package —
 *      above all @evaluator/core — is vendor-neutral, and a stray SDK import fails `pnpm lint`.
 *   2. The core layer DAG: `operations -> {transport-seam, profile} -> runtime`. A file may import
 *      DOWN a layer, never UP.
 *
 * CRITICAL, and the reason this file looks repetitive: ESLint flat config does NOT merge two config
 * objects that both set `no-restricted-imports` — for a given file, the LAST matching object wins
 * OUTRIGHT and silently deletes the earlier rule. So every scope below states its own COMPLETE
 * `no-restricted-imports`. To add a restriction to a scope, extend that scope's array; never add a
 * second block that also sets the rule for the same files. (Verified with a deliberate bark test.)
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** @type {import("eslint").Linter.RestrictedImportsOptions["paths"]} */
const OPENAI_SDK = [{ name: "openai", message: "Only @evaluator/provider-openai may import the OpenAI SDK." }];
/** @type {import("eslint").Linter.RestrictedImportsOptions["paths"]} */
const ANTHROPIC_SDK = [
  { name: "@anthropic-ai/sdk", message: "Only @evaluator/provider-anthropic may import the Anthropic SDK." },
];
/** @type {import("eslint").Linter.RestrictedImportsOptions["patterns"]} */
const OPENAI_PATTERNS = [{ group: ["openai/*"], message: "Only @evaluator/provider-openai may import the OpenAI SDK." }];
/** @type {import("eslint").Linter.RestrictedImportsOptions["patterns"]} */
const ANTHROPIC_PATTERNS = [
  { group: ["@anthropic-ai/sdk/*"], message: "Only @evaluator/provider-anthropic may import the Anthropic SDK." },
];
const UI_PATHS = [
  { name: "react", message: "No UI framework outside a UI package." },
  { name: "react-dom", message: "No UI framework outside a UI package." },
  { name: "ink", message: "No UI framework outside a UI package." },
];
const ENV_PATHS = [
  { name: "dotenv", message: "The library reads no environment; only an entrypoint may load dotenv." },
  { name: "dotenv/config", message: "The library reads no environment; only an entrypoint may load dotenv." },
];

/** Ban all direct process access + console — for pure libraries that must not print or read the world. */
const NO_IO = {
  "no-console": "error",
  "no-restricted-syntax": [
    "error",
    {
      selector: "MemberExpression[object.name='process']",
      message: "A pure library touches no `process` — inject config, emit events, never read env or print.",
    },
  ],
};

const restricted = (/** @type {any} */ opts) => ["error", opts];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A leading underscore is the conventional "deliberately unused" marker; honor it everywhere.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // ─── @evaluator/core — vendor-neutral, prints nothing, reads no env ────────────────────────────
  // The public barrel re-exports every layer, so it carries no layer rule, only the walls.
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      ...NO_IO,
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...UI_PATHS, ...ENV_PATHS],
        patterns: [...OPENAI_PATTERNS, ...ANTHROPIC_PATTERNS],
      }),
    },
  },
  // runtime is the base layer: it may reach NOWHERE else inside core.
  {
    files: ["packages/core/src/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...UI_PATHS, ...ENV_PATHS],
        patterns: [
          ...OPENAI_PATTERNS,
          ...ANTHROPIC_PATTERNS,
          { group: ["**/transport-seam/**", "**/operations/**", "**/profile/**"], message: "runtime is the base layer — it imports nothing else in core." },
        ],
      }),
    },
  },
  // transport-seam and profile sit above runtime, below operations.
  {
    files: ["packages/core/src/transport-seam/**/*.ts", "packages/core/src/profile/**/*.ts"],
    rules: {
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...UI_PATHS, ...ENV_PATHS],
        patterns: [
          ...OPENAI_PATTERNS,
          ...ANTHROPIC_PATTERNS,
          { group: ["**/operations/**"], message: "transport-seam/profile may not reach UP into operations." },
        ],
      }),
    },
  },

  // ─── Provider adapters: each is the ONLY place its SDK may appear ───────────────────────────────
  {
    files: ["packages/provider-openai/src/**/*.ts"],
    rules: {
      ...NO_IO,
      // openai allowed here; the Anthropic SDK and UI are not.
      "no-restricted-imports": restricted({
        paths: [...ANTHROPIC_SDK, ...UI_PATHS, ...ENV_PATHS],
        patterns: [...ANTHROPIC_PATTERNS],
      }),
    },
  },
  {
    files: ["packages/provider-anthropic/src/**/*.ts"],
    rules: {
      ...NO_IO,
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...UI_PATHS, ...ENV_PATHS],
        patterns: [...OPENAI_PATTERNS],
      }),
    },
  },

  // ─── @evaluator/reporter — a sink over the event stream; writes files/streams but no SDK, no UI ──
  {
    files: ["packages/reporter/src/**/*.ts"],
    rules: {
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...UI_PATHS, ...ENV_PATHS],
        patterns: [...OPENAI_PATTERNS, ...ANTHROPIC_PATTERNS],
      }),
    },
  },

  // ─── @evaluator/cli — an entrypoint: may read env, select providers, and print ──────────────────
  // Still forbidden from importing the raw SDKs directly (it goes through the provider packages).
  {
    files: ["packages/cli/src/**/*.ts"],
    rules: {
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...UI_PATHS],
        patterns: [...OPENAI_PATTERNS, ...ANTHROPIC_PATTERNS],
      }),
    },
  },

  // ─── @evaluator/studio — the node:http API + folder reader (no SDK, no React outside ui/) ────────
  {
    files: ["packages/studio/src/**/*.ts"],
    ignores: ["packages/studio/src/ui/**"],
    rules: {
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...UI_PATHS],
        patterns: [...OPENAI_PATTERNS, ...ANTHROPIC_PATTERNS],
      }),
    },
  },
  // The browser bundle: React is expected; the SDKs and node env are not.
  {
    files: ["packages/studio/src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restricted({
        paths: [...OPENAI_SDK, ...ANTHROPIC_SDK, ...ENV_PATHS],
        patterns: [...OPENAI_PATTERNS, ...ANTHROPIC_PATTERNS],
      }),
    },
  },

  // Tests may await without an inner await (fixtures), and use non-null assertions freely.
  {
    files: ["packages/*/tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Config files are plain JS / untyped-lint.
  {
    files: ["**/*.config.{js,ts}", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
