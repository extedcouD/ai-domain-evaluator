/**
 * Knowledge sources that lie, and a judge that doesn't need a model.
 *
 * The failure this layer exists to catch is a source answering fluently about something it has no
 * grounding for. You cannot reproduce that by stubbing — so these are real `KnowledgeSource`
 * implementations with deterministic, adversarial behaviour, and the tests assert the probe CAUGHT
 * the lie (a confabulator biting a canary, a refuser leaving a coverage gap).
 *
 * `fakeJudge` implements the `Judge` interface directly with the same deterministic rules the real
 * `createJudge` falls back to, so the probe operations can be tested without a model. The real
 * judge's schema-enforcement guard is tested separately (`judge.test.ts`) against a lying `Llm`.
 */
import type { AnswerVerdict, Judge, KnowledgeSource, Stance } from "@evaluator/core";

const REFUSAL = /\b(do not have|don't have|no reliable information|not.*in the spec|does not appear|incorrect)\b/i;
const NEGATION_MARKER = "it is not true that";

/** Answers everything confidently and specifically — including fabricated topics and negations. */
export function confabulatingSource(): KnowledgeSource {
  return {
    answer: (q) =>
      Promise.resolve({
        text: `Yes, regarding "${q.slice(0, 40)}" — this is correct; it uses specific, concrete fields A, B, and C.`,
        refused: false,
      }),
  };
}

/** Refuses everything. A source that never abstains selectively is confabulating; this one abstains always. */
export function refusingSource(): KnowledgeSource {
  return {
    answer: () => Promise.resolve({ text: "I do not have reliable information about that.", refused: false }),
  };
}

/**
 * The well-behaved source: specific answers to real topics, abstention on canaries, and — for the
 * validator's probes — affirms a claim but denies its negation.
 */
export function honestSource(canaryQuestions: Iterable<string>): KnowledgeSource {
  const canaries = new Set(canaryQuestions);
  return {
    answer: (q) => {
      if (q.toLowerCase().includes(NEGATION_MARKER)) {
        return Promise.resolve({ text: "No, that is incorrect per the specification.", refused: false });
      }
      if (canaries.has(q)) {
        return Promise.resolve({
          text: "I do not have reliable information about that; it does not appear in the spec.",
          refused: false,
        });
      }
      return Promise.resolve({
        text: "Yes — per the specification this is correct and well-defined, using specific concrete fields.",
        refused: false,
      });
    },
  };
}

function isRefusal(text: string): boolean {
  return REFUSAL.test(text) || text.trim().length === 0;
}

/** A deterministic judge: the real judge's heuristic fallback, with no model behind it. */
export function fakeJudge(): Judge {
  return {
    decompose: (answerText) =>
      Promise.resolve(
        answerText
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 12),
      ),

    classifyAnswer: (_question, answerText): Promise<AnswerVerdict> => {
      const responsive = !isRefusal(answerText);
      const specificity = responsive
        ? /\b(specific|concrete|field|endpoint)\b/i.test(answerText)
          ? "specific"
          : "vague"
        : "none";
      return Promise.resolve({ responsive, specificity, rationale: "fake judge" });
    },

    agree: (_question, a, b) => Promise.resolve(!isRefusal(a) && !isRefusal(b)),

    negate: (claim) => Promise.resolve(`It is not true that ${claim}`),

    assessStance: (_statement, sourceAnswer): Promise<Stance> => {
      if (/\b(no|not|incorrect|false|invalid)\b/i.test(sourceAnswer)) return Promise.resolve("denies");
      if (/\b(yes|correct|true|valid)\b/i.test(sourceAnswer)) return Promise.resolve("affirms");
      return Promise.resolve("unsure");
    },

    schemaEnforced: () => Promise.resolve(true),
    warnings: () => [],
  };
}
