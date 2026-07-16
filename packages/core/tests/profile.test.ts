import { describe, expect, it } from "vitest";

import { DEFAULT_SUBJECT, defaultProfile } from "@evaluator/core";

describe("defaultProfile — domain-as-data", () => {
  const SUBJECT = "the ONDC protocol specifications";

  it("weaves the subject into every prompt, so a KB names its domain exactly once", () => {
    const p = defaultProfile(SUBJECT);
    expect(p.subject).toBe(SUBJECT);
    expect(p.sourceSystem).toContain(SUBJECT);
    expect(p.judgeSystem).toContain(SUBJECT);
    expect(p.affirmationPhrasings("X").every((s) => s.includes(SUBJECT) && s.includes("X"))).toBe(true);
    expect(p.assessPhrasing("Y")).toContain(SUBJECT);
    expect(p.assessPhrasing("Y")).toContain("Y");
    expect(p.caveat).toContain(SUBJECT);
  });

  it("preserves the abstention permission — the thing that makes a canary meaningful", () => {
    // Strip this and every source confabulates, and the probe measures nothing.
    expect(defaultProfile(SUBJECT).sourceSystem.toLowerCase()).toMatch(/do not know|say so|rather than guessing/);
  });

  it("forbids the judge from answering the question itself", () => {
    expect(defaultProfile(SUBJECT).judgeSystem.toLowerCase()).toContain("never answer");
  });

  it("falls back to a neutral subject that names no domain", () => {
    expect(defaultProfile().subject).toBe(DEFAULT_SUBJECT);
    expect(defaultProfile().sourceSystem).not.toMatch(/ONDC/);
  });

  it("honours an override for a bespoke source framing", () => {
    expect(defaultProfile(SUBJECT, { sourceSystem: "custom framing" }).sourceSystem).toBe("custom framing");
  });
});
