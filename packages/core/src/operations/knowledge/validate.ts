/**
 * Validate — answer-level faithfulness, without ground truth.
 *
 * You cannot check an answer against the subject's truth (that needs ground truth this whole effort
 * unblocks). But you CAN interrogate the source about its own answer and catch it contradicting
 * itself — which is a real, ground-truth-free signal. For each atomic claim in an answer:
 *
 *   1. Self-consistency — re-ask the source to assess the claim, several phrasings. A stable stance
 *      is evidence the "knowledge" is real; a stance that flips with the wording is not.
 *   2. Negation canary — ask the source about the claim's OPPOSITE. A source that affirms both a
 *      claim and its negation is confabulating; its agreement is worthless. This is the claim-level
 *      version of the coverage canary.
 *
 * Claim-vs-EVIDENCE grounding (does a returned citation actually support the claim?) is NOT done
 * here, and the report says so plainly: the bare model is opaque and exposes no evidence. That check
 * arrives with the first source that returns evidence — the harness routes around the missing
 * capability and reports it rather than pretending. Shares its judge/consistency primitives with
 * `coverage`; the two operations are not duplicates, they compose the same parts.
 *
 * The re-questioning phrasings and the caveat come from the `SubjectProfile` — they used to hard-name
 * "the ONDC spec". Now they name whatever subject the KB declared.
 */
import { defaultProfile, type SubjectProfile } from "../../profile/profile";
import { toRun, type Run } from "../../runtime/run";
import type { EventBody } from "../../runtime/events";
import type { Judge, Stance } from "./judge";
import type { KnowledgeAnswer, KnowledgeSource } from "./source";

export type ClaimVerdict = "supported-by-consistency" | "contradicted" | "unverifiable";

export interface ClaimResult {
  text: string;
  verdict: ClaimVerdict;
  /** Consistency of the source's stance across affirmation phrasings, 0..1. */
  agreement: number;
  /** Did the source reject the claim's negation? A source that affirms both is confabulating. */
  negationRejected: boolean;
  detail: string;
}

export interface ValidationReport {
  question: string;
  answerSample: string;
  refused: boolean;
  claims: ClaimResult[];
  summary: { supported: number; contradicted: number; unverifiable: number };
  /** Named, not hidden: the opaque-source capability the harness cannot exercise yet. */
  grounding: { evidenceCheck: "unavailable"; note: string };
  judge: { schemaEnforced: boolean; warnings: string[] };
  caveats: string[];
}

export interface ValidateOptions {
  question: string;
  /** The answer to validate. If omitted, the source is asked the question first. */
  answer?: string;
  /** The subject profile supplying re-questioning phrasings and the caveat. Defaults to neutral. */
  profile?: SubjectProfile;
  /** Affirmation phrasings per claim. Default 2. */
  probes?: number;
  /** Cap on claims examined. Default 8. */
  maxClaims?: number;
  sampleChars?: number;
}

const GROUNDING_NOTE =
  "This source is opaque — it exposes no evidence to check claims against. Groundedness here is " +
  "inferred from self-consistency and confabulation, not from source citations. A claim-vs-evidence " +
  "check is added when a source returns evidence.";

/** Validate an answer (or the source's own answer) to a question. Returns a handle; nothing has run. */
export function validate(source: KnowledgeSource, judge: Judge, opts: ValidateOptions): Run<ValidationReport> {
  return toRun("probe", `validate: ${opts.question.slice(0, 50)}`, (signal) => validateOp(source, judge, opts, signal));
}

async function* validateOp(
  source: KnowledgeSource,
  judge: Judge,
  opts: ValidateOptions,
  signal: AbortSignal,
): AsyncGenerator<EventBody, ValidationReport> {
  const sampleChars = opts.sampleChars ?? 240;
  const probes = Math.max(1, opts.probes ?? 2);
  const maxClaims = Math.max(1, opts.maxClaims ?? 8);
  const profile = opts.profile ?? defaultProfile();

  const answer: KnowledgeAnswer =
    opts.answer !== undefined ? { text: opts.answer, refused: false } : await source.answer(opts.question, signal);

  // A prose refusal ("I don't have information about that") carries refused:false and non-empty text,
  // so it would otherwise be decomposed into junk claims. When we fetched the answer ourselves, ask
  // the judge whether it is actually an answer. A caller-supplied answer is taken at its word.
  const noAnswer =
    answer.refused ||
    answer.text.trim() === "" ||
    (opts.answer === undefined && !(await judge.classifyAnswer(opts.question, answer.text, signal)).responsive);

  if (noAnswer) {
    yield { type: "notice", level: "warn", message: "The source produced no answer to validate." };
    return report(profile, opts.question, answer, true, [], sampleChars, await judge.schemaEnforced(), [
      ...judge.warnings(),
    ]);
  }

  yield { type: "notice", level: "info", message: `Validating answer to: ${opts.question}` };

  const claims = (await judge.decompose(answer.text, signal)).slice(0, maxClaims);
  const results: ClaimResult[] = [];
  for (const claim of claims) {
    const result = await checkClaim(source, judge, profile, claim, probes, signal);
    results.push(result);
    yield {
      type: "notice",
      level: result.verdict === "contradicted" ? "warn" : "info",
      message: `claim → ${result.verdict}: ${truncate(claim, 80)}`,
    };
  }

  return report(profile, opts.question, answer, false, results, sampleChars, await judge.schemaEnforced(), [
    ...judge.warnings(),
  ]);
}

async function checkClaim(
  source: KnowledgeSource,
  judge: Judge,
  profile: SubjectProfile,
  claim: string,
  probes: number,
  signal: AbortSignal,
): Promise<ClaimResult> {
  // 1. Affirmation consistency: ask the source to assess the claim itself, several phrasings.
  const stances: Stance[] = [];
  for (const phrasing of profile.affirmationPhrasings(claim).slice(0, probes)) {
    const a = await source.answer(phrasing, signal);
    stances.push(a.refused ? "unsure" : await judge.assessStance(claim, a.text, signal));
  }
  const affirms = stances.filter((s) => s === "affirms").length;
  const denies = stances.filter((s) => s === "denies").length;
  const agreement = stances.length === 0 ? 0 : Math.max(affirms, denies) / stances.length;

  // 2. Negation canary: does the source ALSO affirm the opposite?
  const negation = await judge.negate(claim, signal);
  const negAnswer = await source.answer(profile.assessPhrasing(negation), signal);
  const negStance: Stance = negAnswer.refused ? "denies" : await judge.assessStance(negation, negAnswer.text, signal);
  const negationRejected = negStance !== "affirms";

  if (affirms > 0 && affirms > denies && negationRejected && agreement >= 0.5) {
    return {
      text: claim,
      verdict: "supported-by-consistency",
      agreement,
      negationRejected,
      detail: "Source consistently affirmed the claim and rejected its negation.",
    };
  }
  if (!negationRejected || denies > affirms) {
    return {
      text: claim,
      verdict: "contradicted",
      agreement,
      negationRejected,
      detail: negationRejected
        ? "Source denied its own claim under re-questioning."
        : "Source affirmed both the claim and its negation — confabulation.",
    };
  }
  return {
    text: claim,
    verdict: "unverifiable",
    agreement,
    negationRejected,
    detail: "Source's stance was inconsistent or unsure.",
  };
}

function report(
  profile: SubjectProfile,
  question: string,
  answer: KnowledgeAnswer,
  refused: boolean,
  claims: ClaimResult[],
  sampleChars: number,
  schemaEnforced: boolean,
  warnings: string[],
): ValidationReport {
  return {
    question,
    answerSample: truncate(answer.text, sampleChars),
    refused,
    claims,
    summary: {
      supported: claims.filter((c) => c.verdict === "supported-by-consistency").length,
      contradicted: claims.filter((c) => c.verdict === "contradicted").length,
      unverifiable: claims.filter((c) => c.verdict === "unverifiable").length,
    },
    grounding: { evidenceCheck: "unavailable", note: GROUNDING_NOTE },
    judge: { schemaEnforced, warnings },
    caveats: [
      profile.caveat,
      ...(schemaEnforced ? [] : ["The judge backend did not enforce schemas — verdicts are less reliable."]),
    ],
  };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
