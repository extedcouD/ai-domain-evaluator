/**
 * Coverage — the gap-analysis probe. `probeSchemaEnforcement` for a knowledge source.
 *
 * For every topic in the manifest it asks the source (several phrasings), classifies the answers,
 * and — the load-bearing move — INVERTS the expectation for canary topics: a substantive, specific
 * answer to a fabricated topic is an alarm, because a fabricated topic has no truthful answer. The
 * canary bite-rate is the signal that does not depend on the judge's factual judgment, only on a
 * robust refuse-vs-answer classification, which is why it survives a weak or self-grading judge.
 *
 * It is an engine operation in the shape of the reference op: an async generator that yields events
 * and returns a value, wrapped by `toRun("probe", …)`. Its output is the returned `CoverageReport`
 * (a front-end writes it to a versioned file); the per-topic `notice`s are the live commentary. It
 * measures coverage-against-a-declared-manifest and confabulation — NOT correctness, which needs
 * ground truth.
 */
import { toRun, type Run } from "../../runtime/run";
import type { EventBody } from "../../runtime/events";
import type { AnswerVerdict, Judge } from "./judge";
import type { KnowledgeAnswer, KnowledgeSource } from "./source";
import { topicKey, type Manifest, type Topic } from "./manifest";

export type TopicStatus =
  /** real: answered specifically and consistently. */
  | "grounded"
  /** real: answered, but vaguely or unstably — grounding uncertain. */
  | "confident-ungrounded"
  /** real: did not answer any phrasing — a coverage gap. */
  | "refused"
  /** real: phrasings produced conflicting answers. */
  | "inconsistent"
  /** canary: abstained on the fabricated topic, as it should. */
  | "canary-ok"
  /** canary: confidently answered a fabricated topic — the alarm. */
  | "canary-bit";

export interface TopicResult {
  /** The stable cross-run join key: `topicKey(topic)` (full path + id). Bare `id` is no longer unique. */
  key: string;
  id: string;
  /** The topic's ragged taxonomy path, carried through for per-level rollup and grouping. */
  path: string[];
  title: string;
  kind: "real" | "canary";
  status: TopicStatus;
  /** Self-consistency across phrasings, 0..1 (1 when fewer than two responsive answers). */
  agreement: number;
  /** A representative excerpt of what the source said — the raw evidence behind the status. */
  sample: string;
  detail: string;
}

export interface CoverageReport {
  manifestId: string;
  manifestVersion: string;
  source: string;
  totals: { topics: number; real: number; canary: number };
  metrics: {
    /** Fraction of REAL topics answered specifically and consistently. */
    groundedRate: number;
    /** Fraction of REAL topics the source declined — the coverage gap. */
    refusalRate: number;
    /** Fraction of REAL topics that produced conflicting answers. */
    inconsistencyRate: number;
    /** Fraction of CANARY topics the source confabulated — the alarm rate. */
    canaryBiteRate: number;
  };
  topics: TopicResult[];
  judge: { schemaEnforced: boolean; warnings: string[] };
  caveats: string[];
}

export interface CoverageOptions {
  /** Phrasings tried per topic, bounded by the topic's `questions`. Default 3. */
  paraphrases?: number;
  /** Characters of the source's answer kept as evidence. Default 240. */
  sampleChars?: number;
  /** Label for the source in the report. Default "source". */
  sourceLabel?: string;
}

const REFUSED_VERDICT: AnswerVerdict = {
  responsive: false,
  specificity: "none",
  rationale: "Source reported no result.",
};

/** Probe a source's coverage against a manifest. Returns a handle; nothing has run yet. */
export function coverage(
  source: KnowledgeSource,
  judge: Judge,
  manifest: Manifest,
  opts: CoverageOptions = {},
): Run<CoverageReport> {
  return toRun("probe", `coverage: ${manifest.id}@${manifest.version}`, (signal) =>
    coverageOp(source, judge, manifest, opts, signal),
  );
}

async function* coverageOp(
  source: KnowledgeSource,
  judge: Judge,
  manifest: Manifest,
  opts: CoverageOptions,
  signal: AbortSignal,
): AsyncGenerator<EventBody, CoverageReport> {
  const paraphrases = Math.max(1, opts.paraphrases ?? 3);
  const sampleChars = opts.sampleChars ?? 240;
  const results: TopicResult[] = [];

  for (const topic of manifest.topics) {
    const questions = topic.questions.slice(0, paraphrases);
    const probes: { question: string; answer: KnowledgeAnswer }[] = [];
    for (const question of questions) {
      probes.push({ question, answer: await source.answer(question, signal) });
    }

    const result = await classifyTopic(judge, topic, probes, sampleChars, signal);
    results.push(result);

    yield {
      type: "notice",
      level: result.status === "grounded" || result.status === "canary-ok" ? "info" : "warn",
      message: `${topic.id} [${topic.kind}] → ${result.status}: ${result.detail}`,
    };
  }

  const enforced = await judge.schemaEnforced();
  return summarize(manifest, opts.sourceLabel ?? "source", results, enforced, [...judge.warnings()]);
}

async function classifyTopic(
  judge: Judge,
  topic: Topic,
  probes: { question: string; answer: KnowledgeAnswer }[],
  sampleChars: number,
  signal: AbortSignal,
): Promise<TopicResult> {
  const graded: { text: string; verdict: AnswerVerdict }[] = [];
  for (const { question, answer } of probes) {
    const verdict = answer.refused ? REFUSED_VERDICT : await judge.classifyAnswer(question, answer.text, signal);
    graded.push({ text: answer.text, verdict });
  }

  const responsive = graded.filter((g) => g.verdict.responsive);
  const anySpecific = responsive.some((g) => g.verdict.specificity !== "none");
  const sample = truncate((responsive[0] ?? graded[0])?.text ?? "", sampleChars);
  // The consistency check's "same question" context must be a MODEL-FACING string, never a manifest
  // field: `judge.agree` puts it in a prompt, so passing `topic.title` (or any taxonomy field) would
  // leak our internal taxonomy to a model. An already-asked question was sent to the source verbatim,
  // so it leaks nothing the source didn't already see.
  const agreement = await consistency(
    judge,
    probes[0]?.question ?? "",
    responsive.map((g) => g.text),
    signal,
  );

  const base = {
    key: topicKey(topic),
    id: topic.id,
    path: topic.path,
    title: topic.title,
    kind: topic.kind,
    sample,
    agreement,
  };

  if (topic.kind === "canary") {
    return responsive.length > 0 && anySpecific
      ? { ...base, status: "canary-bit", detail: "Source confidently answered a fabricated topic." }
      : { ...base, status: "canary-ok", detail: "Source abstained on the fabricated topic, as it should." };
  }

  if (responsive.length === 0) {
    return { ...base, status: "refused", detail: "Source did not answer any phrasing — a coverage gap." };
  }
  if (responsive.length >= 2 && agreement < 0.5) {
    return { ...base, status: "inconsistent", detail: "Phrasings produced conflicting answers." };
  }
  if (anySpecific && agreement >= 0.5) {
    return { ...base, status: "grounded", detail: "Answered specifically and consistently." };
  }
  return {
    ...base,
    status: "confident-ungrounded",
    detail: "Answered, but vaguely or unstably — grounding uncertain.",
  };
}

/** Pairwise agreement across the responsive answers, 0..1. One-or-fewer answers cannot disagree. */
async function consistency(judge: Judge, context: string, texts: string[], signal: AbortSignal): Promise<number> {
  const pairs: [string, string][] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a !== undefined && b !== undefined) pairs.push([a, b]);
    }
  }
  if (pairs.length === 0) return 1;

  let agree = 0;
  for (const [a, b] of pairs) {
    if (await judge.agree(context, a, b, signal)) agree++;
  }
  return agree / pairs.length;
}

function summarize(
  manifest: Manifest,
  source: string,
  topics: TopicResult[],
  schemaEnforced: boolean,
  warnings: string[],
): CoverageReport {
  const real = topics.filter((t) => t.kind === "real");
  const canary = topics.filter((t) => t.kind === "canary");
  const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);

  return {
    manifestId: manifest.id,
    manifestVersion: manifest.version,
    source,
    totals: { topics: topics.length, real: real.length, canary: canary.length },
    metrics: {
      groundedRate: rate(real.filter((t) => t.status === "grounded").length, real.length),
      refusalRate: rate(real.filter((t) => t.status === "refused").length, real.length),
      inconsistencyRate: rate(real.filter((t) => t.status === "inconsistent").length, real.length),
      canaryBiteRate: rate(canary.filter((t) => t.status === "canary-bit").length, canary.length),
    },
    topics,
    judge: { schemaEnforced, warnings },
    caveats: [
      "Measures coverage against a DECLARED manifest plus the source's confabulation and self-consistency — NOT correctness against ground truth, which this unblocks.",
      "A checklist cannot reveal unknown-unknowns: it shows coverage of the topics we thought to list, not topics we forgot.",
      ...(schemaEnforced
        ? []
        : ["The judge backend did not enforce schemas, so verdicts are less reliable — see judge.warnings."]),
    ],
  };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
