import { describe, expect, it } from "vitest";

import { createJudge } from "@evaluator/core";
import { fakeLlm } from "./fake-llm";

describe("createJudge schema-enforcement guard", () => {
  // The judge depends on the exact thing this repo says you cannot trust: a backend applying the
  // schema. Against one that returns 200 + prose, the verdict must degrade to a heuristic and SAY SO,
  // never silently pass junk through as a confident classification.
  it("still returns a verdict and reports it ran unconstrained when the backend ignores schemas", async () => {
    const judge = createJudge(fakeLlm({ enforced: false }));

    const verdict = await judge.classifyAnswer("What is X?", "X is a specific concrete thing with fields.");
    expect(typeof verdict.responsive).toBe("boolean"); // produced by the fallback, not a crash

    expect(await judge.schemaEnforced()).toBe(false);
    expect(judge.warnings().length).toBeGreaterThan(0);
    expect(judge.warnings().some((w) => /schema/i.test(w))).toBe(true);
  });

  it("returns the validated verdict and no warnings when the backend honours the schema", async () => {
    const judge = createJudge(
      fakeLlm({
        enforced: true,
        reply: () => JSON.stringify({ responsive: true, specificity: "specific", rationale: "ok" }),
      }),
    );

    const verdict = await judge.classifyAnswer("q", "a");
    expect(verdict).toEqual({ responsive: true, specificity: "specific", rationale: "ok" });
    expect(await judge.schemaEnforced()).toBe(true);
    expect(judge.warnings()).toEqual([]);
  });

  it("recovers a verdict a weak backend wrapped in prose and ```fences```", async () => {
    const judge = createJudge(
      fakeLlm({
        enforced: true,
        reply: () => 'Sure!\n```json\n{"agree": true}\n```\nHope that helps.',
      }),
    );
    // agree() parses the fenced object rather than falling back.
    expect(await judge.agree("q", "a", "b")).toBe(true);
    expect(judge.warnings()).toEqual([]);
  });
});
