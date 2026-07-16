/**
 * The judge — the classifier primitives that `coverage` and `validate` share.
 *
 * A judge is just an `Llm` used to grade text instead of generate answers, reached through a
 * Zod-constrained `complete()` call. It is a SEPARATE interface from the source (and a separately
 * injectable `Llm`) for two reasons the design leans on:
 *
 *   1. Circularity. In the first wiring the judge and the source are the same model, so a
 *      confabulator can rubber-stamp itself. Keeping the judge injectable means pointing it at a
 *      stronger model later is a config change, not a refactor. The strongest signal — canary
 *      bite-rate — leans only on a robust refuse-vs-answer classification, not on any factual
 *      judgment, precisely so a weak judge cannot poison it.
 *
 *   2. The judge depends on the very thing this repo says you cannot trust: schema enforcement. A
 *      backend that ignores the schema returns 200 and prose, and the verdict silently degrades. So
 *      EVERY verdict is validated with Zod after the call and falls back to a heuristic when
 *      validation fails; `schemaEnforced()` reports whether the backend was constrained at all, and
 *      every fallback is recorded in `warnings()` so a report can say the judge ran blind.
 *
 * Tests pass their own deterministic `Judge`; `createJudge(llm, profile?)` is the production wiring.
 * That keeps the probe operations' logic testable without a model and isolates the schema guard.
 */
import { z } from "zod";

import { defaultProfile, type SubjectProfile } from "../../profile/profile";
import type { ChatMessage, JsonSchema, Llm } from "../../runtime/types";

export type Specificity = "none" | "vague" | "specific";
export type Stance = "affirms" | "denies" | "unsure";

export interface AnswerVerdict {
  /** True only if the source actually attempted an answer — false for a refusal, hedge, or deflection. */
  responsive: boolean;
  /** How concrete the answer is: no detail, general, or citing specific details. */
  specificity: Specificity;
  rationale: string;
}

export interface Judge {
  /** Break an answer into atomic, independently-checkable claims. */
  decompose(answerText: string, signal?: AbortSignal): Promise<string[]>;
  /** Did the source answer the question, and how specifically? The refuse-vs-answer call. */
  classifyAnswer(question: string, answerText: string, signal?: AbortSignal): Promise<AnswerVerdict>;
  /** Do two answers to the same question say the same thing? Drives self-consistency. */
  agree(question: string, a: string, b: string, signal?: AbortSignal): Promise<boolean>;
  /** Produce a claim's negation, for the claim-level canary in `validate`. */
  negate(claim: string, signal?: AbortSignal): Promise<string>;
  /** Does `sourceAnswer` affirm, deny, or stay unsure about `statement`? */
  assessStance(statement: string, sourceAnswer: string, signal?: AbortSignal): Promise<Stance>;
  /** Whether the judge backend actually enforces JSON schemas. Probed once, cached. */
  schemaEnforced(): Promise<boolean>;
  /** Accumulated caveats — e.g. the judge ran unconstrained, or a verdict fell back to a heuristic. */
  warnings(): readonly string[];
}

// -------------------------------------------------------------------------------------------------
// Verdict schemas — the shape a constrained judge must return.
// -------------------------------------------------------------------------------------------------

const AnswerVerdictSchema = z.object({
  responsive: z.boolean(),
  specificity: z.enum(["none", "vague", "specific"]),
  rationale: z.string(),
});
const AgreeSchema = z.object({ agree: z.boolean() });
const NegateSchema = z.object({ negation: z.string() });
const StanceSchema = z.object({ stance: z.enum(["affirms", "denies", "unsure"]) });
const ClaimsSchema = z.object({ claims: z.array(z.string()) });

const UNCONSTRAINED =
  "The judge backend does not enforce JSON schemas (probe: the schema was accepted but ignored). " +
  "Verdicts were validated after the fact and may have fallen back to heuristics.";

/** A refusal/abstention, recognised without a model so canary detection survives a blind judge. */
const REFUSAL_RE =
  /\b(i (do not|don't|dont) (have|know|possess)|no (reliable )?information|not aware|cannot (find|provide)|unable to|i'm not sure|i am not sure|no such|does not exist|doesn't exist|not familiar)\b/i;

export function createJudge(llm: Llm, profile: SubjectProfile = defaultProfile()): Judge {
  const warnings = new Set<string>();
  let probe: Promise<boolean> | null = null;

  const schemaEnforced = (): Promise<boolean> => {
    probe ??= llm.probeSchemaEnforcement().then(
      (r) => {
        if (!r.enforced) warnings.add(UNCONSTRAINED);
        return r.enforced;
      },
      // A failed probe is itself a warning, not a crash — the judge still runs, just blind.
      () => {
        warnings.add(UNCONSTRAINED);
        return false;
      },
    );
    return probe;
  };

  /** One constrained verdict call. Returns null when the output does not satisfy the schema. */
  async function ask<T>(schema: z.ZodType<T>, name: string, user: string, signal?: AbortSignal): Promise<T | null> {
    const json = z.toJSONSchema(schema) as JsonSchema;
    const messages: ChatMessage[] = [
      { role: "system", content: profile.judgeSystem },
      { role: "user", content: user },
    ];
    const result = await llm.complete({ messages, schema: json, schemaName: name, maxTokens: 512 }, signal);
    const parsed = extractJson(result.text);
    const check = schema.safeParse(parsed);
    return check.success ? check.data : null;
  }

  const noteFallback = (what: string): void => {
    warnings.add(`A ${what} verdict did not validate against its schema; used a heuristic instead.`);
  };

  return {
    async decompose(answerText, signal) {
      const v = await ask(
        ClaimsSchema,
        "claims",
        `Break the following answer into a list of atomic, independently-checkable factual claims. ` +
          `Keep each claim short and self-contained.\n\nANSWER:\n${answerText}`,
        signal,
      );
      if (v && v.claims.length > 0) return v.claims;
      noteFallback("claim-decomposition");
      return sentenceSplit(answerText);
    },

    async classifyAnswer(question, answerText, signal) {
      const v = await ask(
        AnswerVerdictSchema,
        "answer_verdict",
        `A knowledge source was asked:\n${question}\n\nIt answered:\n${answerText}\n\n` +
          `Set "responsive" to true only if it genuinely attempts to answer (false if it refuses, ` +
          `deflects, or says it lacks the information). Set "specificity" to "none", "vague", or ` +
          `"specific" based on how much concrete detail it gives.`,
        signal,
      );
      if (v) return v;
      noteFallback("answer-classification");
      const responsive = !REFUSAL_RE.test(answerText) && answerText.trim().length > 0;
      return {
        responsive,
        specificity: responsive ? "vague" : "none",
        rationale: "Judge unavailable; classified by refusal heuristic.",
      };
    },

    async agree(question, a, b, signal) {
      const v = await ask(
        AgreeSchema,
        "agree",
        `Two answers were given to the same question:\n${question}\n\nANSWER A:\n${a}\n\nANSWER B:\n${b}\n\n` +
          `Do they make the same substantive claims (ignoring wording)? Set "agree" true or false.`,
        signal,
      );
      if (v) return v.agree;
      noteFallback("agreement");
      return jaccard(a, b) >= 0.3;
    },

    async negate(claim, signal) {
      const v = await ask(
        NegateSchema,
        "negation",
        `Write the direct logical negation of this claim as a single declarative sentence:\n${claim}`,
        signal,
      );
      if (v && v.negation.trim().length > 0) return v.negation;
      noteFallback("negation");
      return `It is not true that ${claim}`;
    },

    async assessStance(statement, sourceAnswer, signal) {
      const v = await ask(
        StanceSchema,
        "stance",
        `Statement:\n${statement}\n\nA source responded:\n${sourceAnswer}\n\n` +
          `Does the source affirm the statement is true, deny it, or stay unsure? ` +
          `Set "stance" to "affirms", "denies", or "unsure".`,
        signal,
      );
      if (v) return v.stance;
      noteFallback("stance");
      return stanceHeuristic(sourceAnswer);
    },

    schemaEnforced,
    warnings: () => [...warnings],
  };
}

// -------------------------------------------------------------------------------------------------
// Heuristic fallbacks — used only when a constrained verdict fails to validate.
// -------------------------------------------------------------------------------------------------

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // A model that isn't under a grammar wraps JSON in prose or ```fences```. Grab the object.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // give up; caller falls back
    }
  }
  return undefined;
}

function sentenceSplit(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

function stanceHeuristic(answer: string): Stance {
  if (/\b(no|not|incorrect|false|invalid|wrong|does not|doesn't)\b/i.test(answer)) return "denies";
  if (/\b(yes|correct|true|valid|right|indeed)\b/i.test(answer)) return "affirms";
  return "unsure";
}
