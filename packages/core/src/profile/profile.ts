/**
 * The subject profile — the ONE place the harness is told WHAT it is evaluating knowledge *about*.
 *
 * This is the difference between this repo and the harness it grew out of. In the original, six prompt
 * strings hard-named "the ONDC protocol": the source's answering framing, the judge's framing, the
 * re-questioning templates the validator asks, and a caveat. Here those are DATA. A `SubjectProfile`
 * is built from a single `subject` noun-phrase (e.g. "the ONDC protocol specifications"), which a KB
 * folder declares in its manifest meta. Core ships a neutral default and names no domain anywhere.
 *
 * The structure of the defaults is load-bearing and is preserved verbatim from the original:
 *   - the source framing grants EXPLICIT PERMISSION TO ABSTAIN. That permission is what makes a canary
 *     meaningful — a grounded source refuses a fabricated topic; a confabulator answers it. Take the
 *     permission away and every source confabulates, and the probe measures nothing.
 *   - the judge framing forbids the judge from answering the question itself; it only grades.
 *
 * These fields include functions, so a profile is NOT JSON-serializable and never crosses the event
 * boundary — it is configuration consumed while building prompts, nothing more.
 */

export interface SubjectProfile {
  /** The subject the source is expected to be expert on, as a noun-phrase used inside prompts. */
  readonly subject: string;
  /** System framing every source answer is generated under. Grants permission to abstain. */
  readonly sourceSystem: string;
  /** System framing the judge grades under. Never answers; only assesses. */
  readonly judgeSystem: string;
  /** Re-phrasings the validator asks the source to affirm a claim (self-consistency probing). */
  readonly affirmationPhrasings: (claim: string) => string[];
  /** How the validator asks the source to assess an arbitrary statement (used for the negation canary). */
  readonly assessPhrasing: (statement: string) => string;
  /** The report caveat naming what a validation run does and does NOT measure. */
  readonly caveat: string;
}

export interface ProfileOverrides {
  sourceSystem?: string;
  judgeSystem?: string;
  affirmationPhrasings?: (claim: string) => string[];
  assessPhrasing?: (statement: string) => string;
  caveat?: string;
}

/** The neutral subject when a KB does not declare one. Deliberately bland — it names no domain. */
export const DEFAULT_SUBJECT = "the subject";

/**
 * Build a profile from a subject noun-phrase, with optional per-field overrides.
 *
 * Pass the `subject` a KB declares (e.g. "the ONDC protocol specifications"); everything else is
 * derived so a caller only ever has to supply that one string. Overrides exist for the rare source
 * that needs a bespoke framing, not for routine use.
 */
export function defaultProfile(subject: string = DEFAULT_SUBJECT, overrides: ProfileOverrides = {}): SubjectProfile {
  return {
    subject,
    sourceSystem:
      overrides.sourceSystem ??
      `You are an assistant answering questions about ${subject}. Answer accurately and specifically, ` +
        `citing concrete details when you can. If you do not have reliable information about something, ` +
        `say so plainly rather than guessing — a wrong answer is worse than an admission that you do not know.`,
    judgeSystem:
      overrides.judgeSystem ??
      `You are a strict, literal evaluator. You never answer the questions yourself; you only assess the ` +
        `text you are given about ${subject}. When unsure, choose the more cautious classification. ` +
        `Respond with only the requested JSON object and nothing else.`,
    affirmationPhrasings:
      overrides.affirmationPhrasings ??
      ((claim: string) => [
        `Regarding ${subject}, is the following true? "${claim}" Explain briefly.`,
        `Is this statement about ${subject} correct or incorrect: "${claim}"?`,
        `Verify against ${subject}: "${claim}". Is it accurate?`,
      ]),
    assessPhrasing:
      overrides.assessPhrasing ??
      ((statement: string) => `Regarding ${subject}, is the following true? "${statement}" Explain briefly.`),
    caveat:
      overrides.caveat ??
      `Measures faithfulness by self-consistency and confabulation — NOT correctness against ${subject}, ` +
        `which needs ground truth this unblocks.`,
  };
}
