import { describe, expect, it } from "vitest";

import { validate, type ValidationReport } from "@evaluator/core";
import { confabulatingSource, fakeJudge, honestSource, refusingSource } from "./fake-knowledge";

const ANSWER =
  "The on_search callback returns a catalog of specific concrete offers. " +
  "The authorization header signing uses a specific ed25519 field.";

async function run(source: Parameters<typeof validate>[0], answer?: string): Promise<ValidationReport> {
  const opts = answer === undefined ? { question: "Explain on_search" } : { question: "Explain on_search", answer };
  return validate(source, fakeJudge(), { ...opts, probes: 2 }).result;
}

describe("validate", () => {
  it("supports claims a source affirms consistently and whose negation it rejects", async () => {
    const report = await run(honestSource([]), ANSWER);

    expect(report.claims.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.supported).toBe(report.claims.length);
    expect(report.summary.contradicted).toBe(0);
    // The opaque-source capability is named, not silently skipped.
    expect(report.grounding.evidenceCheck).toBe("unavailable");
  });

  it("CATCHES a confabulator that affirms both a claim and its negation", async () => {
    const report = await run(confabulatingSource(), ANSWER);

    expect(report.summary.contradicted).toBe(report.claims.length);
    expect(report.claims.every((c) => !c.negationRejected)).toBe(true);
  });

  it("reports a prose refusal as no-answer instead of decomposing it into claims", async () => {
    // No answer supplied → it asks the (refusing) source, which returns fluent prose that is a refusal.
    const report = await run(refusingSource());

    expect(report.refused).toBe(true);
    expect(report.claims).toEqual([]);
  });

  it("is JSON-clean", async () => {
    const report = await run(honestSource([]), ANSWER);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
