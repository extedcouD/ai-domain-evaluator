/**
 * The scripted front-end, and the only place the environment meets the seam.
 *
 *   evaluator "why is the sky blue?"            one unconstrained completion
 *   evaluator --health                          what is the server actually serving?
 *   evaluator --check-schema                    does this backend REALLY enforce schemas?
 *   evaluator --coverage <kb-dir|manifest.yaml> what does the source actually know?
 *   evaluator --validate "<question>"           is the source's answer self-consistent?
 *
 * The provider is chosen by LLM_PROVIDER (openai | anthropic); the domain is read from the KB's
 * `subject`, so nothing here names ONDC.
 */
import {
  HarnessError,
  type Config,
  type CoverageNode,
  type HarnessEvent,
  type Llm,
  type Manifest,
  type SubjectProfile,
} from "@evaluator/core";

const USAGE = [
  `Usage:`,
  `  evaluator "<prompt>"                        send one unconstrained completion`,
  `  evaluator --health                          list the models the server is serving`,
  `  evaluator --check-schema                    prove the backend enforces structured output`,
  `  evaluator --coverage <kb-dir|manifest.yaml> probe what the source actually knows`,
  `  evaluator --validate "<question>" [--subject "<domain>"]   validate answer self-consistency`,
  ``,
  `Provider is selected by LLM_PROVIDER (openai | anthropic). See .env.example.`,
  ``,
].join("\n");

/** Every run's structured event trace lands here (JSONL). Gitignored; see @evaluator/reporter. */
const LOG_FILE = "logs/harness.jsonl";

/** The CLI's bespoke live line for a probe run. Handed to `logRun` as its renderer. */
function printNotice(event: HarnessEvent): void {
  if (event.type === "notice") {
    process.stdout.write(`  ${event.level === "warn" ? "!" : "·"} ${event.message}\n`);
  }
}

/** Print the coverage rollup as an indented tree, so a ragged taxonomy is quantified per level. */
function printCoverageTree(root: CoverageNode): void {
  const line = (node: CoverageNode, depth: number): void => {
    const t = node.totals;
    const m = node.metrics;
    const parts = [`${String(t.topics)} topic${t.topics === 1 ? "" : "s"}`];
    if (t.real > 0) {
      parts.push(`grounded ${pct(m.groundedRate)}`, `refused ${pct(m.refusalRate)}`);
      if (m.inconsistencyRate > 0) parts.push(`inconsistent ${pct(m.inconsistencyRate)}`);
    }
    if (t.canary > 0) parts.push(`CANARY-BITE ${pct(m.canaryBiteRate)}`);
    process.stdout.write(`  ${"  ".repeat(depth + 1)}${node.segment}  ${parts.join(" · ")}\n`);
    for (const child of node.children) line(child, depth + 1);
  };
  if (root.children.length === 0) return;
  process.stdout.write(`\n  coverage by level:\n`);
  for (const child of root.children) line(child, 0);
}

/** Construct the transport for the configured provider. The CLI goes through the provider PACKAGES. */
async function makeLlm(config: Config): Promise<Llm> {
  const { toLlmConfig } = await import("@evaluator/core");
  const base = toLlmConfig(config);

  if (config.LLM_PROVIDER === "anthropic") {
    const { createAnthropicLlm } = await import("@evaluator/provider-anthropic");
    return createAnthropicLlm(base);
  }

  const { createOpenAiLlm } = await import("@evaluator/provider-openai");
  const schemaMode = process.env["OPENAI_SCHEMA_MODE"] === "structured_outputs" ? "structured_outputs" : "json_schema";
  return createOpenAiLlm({ ...base, schemaMode });
}

/** Pull `--subject "<phrase>"` out of the args, returning the phrase (or undefined) and the rest. */
function takeSubject(args: string[]): { subject: string | undefined; rest: string[] } {
  const i = args.indexOf("--subject");
  if (i === -1) return { subject: undefined, rest: args };
  const subject = args[i + 1];
  const rest = [...args.slice(0, i), ...args.slice(subject === undefined ? i + 1 : i + 2)];
  return { subject, rest };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(USAGE);
    return 1;
  }

  // Imported here, not at the top of the file: `env.ts` throws while it is being *imported* if the
  // environment is bad. A static import would blow up before the handler below exists.
  const { config } = await import("./env");
  const core = await import("@evaluator/core");
  const { logRun } = await import("@evaluator/reporter");

  const llm = await makeLlm(config);
  const baseUrl = core.toLlmConfig(config).baseUrl;

  if (args[0] === "--health") {
    const result = await llm.health();

    process.stdout.write(`${config.LLM_PROVIDER} · ${result.baseUrl}\n\n`);
    for (const model of result.models) {
      process.stdout.write(`  ${model === config.LLM_MODEL ? "*" : " "} ${model}\n`);
    }

    if (!result.servingConfiguredModel) {
      process.stdout.write(`\n! LLM_MODEL is "${config.LLM_MODEL}", which the server is not serving.\n`);
      return 1;
    }

    process.stdout.write(`\n(* = LLM_MODEL)\n`);
    return 0;
  }

  if (args[0] === "--check-schema") {
    process.stdout.write(`Probing ${config.LLM_PROVIDER} at ${baseUrl} (${config.LLM_MODEL})...\n\n`);
    const probe = await llm.probeSchemaEnforcement();

    if (probe.enforced) {
      process.stdout.write(`  PASS — ${probe.detail}\n  got: ${probe.raw}\n`);
      return 0;
    }

    process.stderr.write(
      [
        `  FAIL — ${probe.detail}`,
        ``,
        `  got: ${probe.raw.slice(0, 200)}`,
        ``,
        `  This backend accepts the schema and returns 200, but does not apply it.`,
        `  Every schema you send is decorative. Switch backends, or stop relying on constrained output.`,
        ``,
      ].join("\n"),
    );
    return 1;
  }

  if (args[0] === "--coverage") {
    const manifestPath = args[1];
    if (manifestPath === undefined) {
      process.stderr.write(`Usage: evaluator --coverage <kb-dir | manifest.yaml>\n`);
      return 1;
    }

    // The engine reads no files. The front-end does the I/O and hands the engine a plain object.
    // A directory is the folder-first KB (kb/topics/<seg…>/*.yaml merged); a file is a single manifest.yaml.
    const { statSync, readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    let manifest: Manifest;
    try {
      if (statSync(manifestPath).isDirectory()) {
        const { readManifestDir } = await import("@evaluator/studio/manifest-folder");
        manifest = readManifestDir(manifestPath);
      } else {
        const { parse: parseYaml } = await import("yaml");
        manifest = core.parseManifest(parseYaml(readFileSync(manifestPath, "utf8")));
      }
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        process.stderr.write(`No manifest at "${manifestPath}" — pass a kb/ folder or a manifest.yaml.\n`);
        return 1;
      }
      throw err;
    }

    // Domain-as-data: the KB names its own subject, and that becomes the source/judge framing.
    const profile: SubjectProfile = core.defaultProfile(manifest.subject);
    process.stdout.write(
      `Probing ${config.LLM_MODEL} against ${manifest.id}@${manifest.version} ` +
        `(${String(manifest.topics.length)} topics · subject: ${profile.subject})...\n\n`,
    );

    const run = core.coverage(core.createModelKnowledgeSource(llm, profile), core.createJudge(llm, profile), manifest, {
      sourceLabel: config.LLM_MODEL,
    });
    // logRun is the single events consumer: it writes the structured JSONL trace AND, via onEvent,
    // prints our bespoke notice lines. The report value still comes from run.result.
    await logRun(run, { file: LOG_FILE, onEvent: printNotice });
    const report = await run.result;
    const m = report.metrics;

    process.stdout.write(
      `\n  grounded ${pct(m.groundedRate)} · refused ${pct(m.refusalRate)} · ` +
        `inconsistent ${pct(m.inconsistencyRate)} · CANARY-BITE ${pct(m.canaryBiteRate)}\n`,
    );
    printCoverageTree(core.rollup(report).root);
    for (const w of report.judge.warnings) process.stdout.write(`  ⚠ ${w}\n`);

    // The report crosses the boundary as data; the front-end owns the wall-clock and the file.
    mkdirSync("kb-coverage", { recursive: true });
    const out = `kb-coverage/${manifest.id}-${String(Date.now())}.json`;
    writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`);
    process.stdout.write(`\n  wrote ${out}\n`);

    // A bitten canary is the alarm — exit non-zero so a script/CI notices the source confabulates.
    return m.canaryBiteRate > 0 ? 1 : 0;
  }

  if (args[0] === "--validate") {
    const { subject, rest } = takeSubject(args.slice(1));
    const question = rest.join(" ").trim();
    if (question === "") {
      process.stderr.write(`Usage: evaluator --validate "<question>" [--subject "<domain>"]\n`);
      return 1;
    }

    const profile = core.defaultProfile(subject);
    process.stdout.write(`Validating the source's answer to: ${question} (subject: ${profile.subject})\n\n`);

    const run = core.validate(core.createModelKnowledgeSource(llm, profile), core.createJudge(llm, profile), {
      question,
      profile,
    });
    await logRun(run, { file: LOG_FILE, onEvent: printNotice });
    const report = await run.result;
    const s = report.summary;

    process.stdout.write(
      `\n  ${String(s.supported)} supported · ${String(s.contradicted)} contradicted · ` +
        `${String(s.unverifiable)} unverifiable (of ${String(report.claims.length)} claims)\n`,
    );
    process.stdout.write(`  grounding: ${report.grounding.evidenceCheck} — ${report.grounding.note}\n`);
    for (const w of report.judge.warnings) process.stdout.write(`  ⚠ ${w}\n`);

    return report.summary.contradicted > 0 ? 1 : 0;
  }

  const result = await llm.complete({ messages: [{ role: "user", content: args.join(" ") }] });
  const { promptTokens, completionTokens, totalTokens } = result.usage;

  process.stdout.write(`${result.text}\n\n`);
  process.stdout.write(
    `--- ${String(promptTokens)} prompt + ${String(completionTokens)} completion ` +
      `= ${String(totalTokens)} tokens · ${String(result.latencyMs)} ms · ${result.model}\n`,
  );
  return 0;
}

/** A rate in [0,1] as a whole-number percentage, for the one-line summary. */
function pct(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

try {
  process.exitCode = await main();
} catch (error) {
  // A missing env var and a server that isn't running are both ordinary, expected states. They get
  // a message you can act on. Anything else is a real bug, and keeps its stack trace.
  if (error instanceof HarnessError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
