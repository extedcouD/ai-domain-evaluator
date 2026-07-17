# ai-harness-evaluator

Scaffolding around an LLM — steering, brakes, and instruments for a **black box** you cannot see
inside. It probes any model (or RAG index, MCP tool, or agent) against a declared manifest of topics
plus fabricated **canaries**, and reports **coverage, confabulation, and self-consistency** — without
ground truth. It is **model-, vendor-, and domain-agnostic**: it talks to OpenAI-compatible and
Anthropic backends behind one seam, and the domain it evaluates is **data** (a `subject` string in a
KB folder), never code.

The whole thing is a response to one fact:

> **A backend that cannot do something does not tell you so. It returns `200 OK`.**

Ask for a JSON schema on a server that doesn't enforce one → you get prose, 200 OK, a full `usage`
object. Ask a model about a spec topic it has no grounding for → you get a fluent, confident,
plausible answer. From the outside, "it works" and "it silently made something up" are the same
bytes. So the harness never trusts a backend or a knowledge source — it **probes** with canaries a
grounded source would refuse, and when something is missing it **reports it out loud** instead of
degrading silently.

## Why a second harness

This grew out of an ONDC-specific knowledge harness. Exploration showed the evaluation subsystem was
already structurally generic — the domain coupling was **~6 prompt strings**, nothing architectural.
So this is a from-scratch rebuild that keeps the ideas and raises the engineering bar:

- **Domain-as-data.** A `SubjectProfile` (built from a `subject` noun-phrase a KB declares in its
  manifest) supplies the source/judge/validator framing. Core names no domain; ONDC lives only in
  `kb/`.
- **Two providers prove the seam.** OpenAI-compatible **and** Anthropic, behind one `Llm` interface,
  as separate packages so SDK deps are opt-in. Finish reasons are normalized to a neutral enum; no
  provider vocabulary leaks into the engine.
- **Real release hygiene.** pnpm workspaces, tsup builds (ESM + types), vitest, eslint (flat), and
  changesets. The SDK walls and layer DAG are **lint-enforced**, not conventions.

## Packages

| package                        | what it is                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `@evaluator/core`              | The vendor- and domain-neutral library: the `Llm`/`KnowledgeSource`/`Judge` seams, the `Run` event machinery, schema sanitizing, the `SubjectProfile`, and the `coverage`/`validate`/`rollup` probes. Names no model, vendor, or domain. |
| `@evaluator/provider-openai`   | OpenAI-compatible adapter (LM Studio, vLLM, Ollama, llama.cpp, a hosted API). The only package that may import the OpenAI SDK. |
| `@evaluator/provider-anthropic`| Anthropic Messages API adapter (structured output via a forced tool call). The only package that may import the Anthropic SDK. |
| `@evaluator/reporter`          | A sink over the event stream — zero-dep JSONL + pretty console. The engine holds no logger.   |
| `@evaluator/cli`               | The scripted front-end: `--health`, `--check-schema`, `--coverage`, `--validate`.            |
| `@evaluator/studio`            | Local browser tool to author the KB folder-first + view/compare coverage (node:http API + Vite/React UI). |

## Quick start

```bash
pnpm install
pnpm test           # vitest — needs NO model (fakes only). See "Testing against liars".
pnpm typecheck      # tsc across every package + the studio's DOM tsconfig
pnpm lint           # eslint — THIS is what enforces the architecture
pnpm build          # tsup builds every publishable package

cp .env.example .env   # set LLM_PROVIDER, LLM_MODEL, and (for a hosted API) LLM_BASE_URL/LLM_API_KEY

pnpm dev -- --health                     # what is the server actually serving?
pnpm dev -- --check-schema               # does this backend REALLY enforce structured output?
pnpm dev -- --coverage kb                # what does the source know about the KB's subject?
pnpm dev -- --validate "<a question>"    # is the source's answer self-consistent?
pnpm dev -- "why is the sky blue?"       # one unconstrained completion

pnpm studio          # author the KB (folder-first) + view coverage in the browser
```

`pnpm test` requires **no running model**. `pnpm dev` and `pnpm studio` need a backend — set `.env`.

For getting a *trustworthy* signal out of a run — judge/source separation, canary budgeting,
paraphrase counts, and the temperature caveat — see [`docs/best-practices.md`](docs/best-practices.md).

## Architecture

**The seam is one interface, four methods** — `complete`, `stream`, `health`,
`probeSchemaEnforcement`. Each provider is a `create*Llm(cfg): Llm`. Swapping backends is a config
change and `LLM_PROVIDER` flip; nothing downstream moves. Two invariants worth knowing:

- **`complete()` is not sugar over `stream()`.** Streamed usage needs `stream_options.include_usage`
  (many servers don't implement it and report zero), and `n`/schemas behave differently under
  `stream: true`. They are two real wire calls sharing one body builder.
- **A cancelled run must not look like a finished one.** The SDKs swallow an abort and end the stream
  cleanly, so each adapter asks the signal directly and throws `LlmAbortedError`.

**The engine ↔ front-end contract is a stream of JSON-serializable events.** The engine never prints
and never returns an object with methods; a `Run<T>` gives you `events` (an `AsyncIterable`) and
`result` (a `Promise`). The event queue never blocks the producer, and `events` is single-consumer —
which is why `@evaluator/reporter` exposes an `onEvent` hook rather than iterating twice.

**The judge is schema-guarded with a heuristic fallback.** Every verdict is validated with Zod after
the call; when a backend ignores the schema, the judge falls back to a deterministic heuristic and
records it in `warnings()`, so a report can say it ran blind. The canary bite-rate depends only on a
refuse-vs-answer classification, so it survives a weak judge.

**The KB is folder-first.** `kb/` is one file per topic (`kb/topics/<seg…>/<id>.yaml`, ragged to any
depth) plus `kb/manifest.meta.yaml` (`{ id, version, subject, levels }`); `kb/manifest.yaml` is a
generated, committed snapshot. The folder→manifest merge is a front-end concern
(`@evaluator/studio/manifest-folder`); the engine parses no YAML. A topic's `path` mirrors its folder
chain; `subject` is the only place a KB names its domain.

### Testing against liars

Tests run against real `node:http` servers that **lie on demand** — never mocks. The bug this project
exists to catch *is* a wire behavior (a server accepting a field and ignoring it), and you cannot
reproduce a server lying to you by stubbing out the server. The fakes can ignore a schema, abort
mid-stream, stream without usage, think until they run out of budget, or split a tool call's
arguments mid-string. Both providers are held to the same suite.

## Status

Built and tested: the core library, both providers, the reporter, the CLI, and the KB Studio (API +
folder reader + browser UI). Not built (by design — no speculative code): a generalized capability
probe beyond schema enforcement, a ground-truth/correctness layer (attaches as a sibling
`kb/truth/<id>`), and a multi-executor router. Build those when there is a task that needs them.
