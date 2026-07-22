import { describe, expect, it } from "vitest";

import {
  coverage,
  type CoverageReport,
  type Judge,
  type KnowledgeAnswer,
  type KnowledgeSource,
  type Manifest,
} from "@evaluator/core";
import { confabulatingSource, fakeJudge, honestSource, refusingSource } from "./fake-knowledge";

const manifest: Manifest = {
  id: "test-kb",
  version: "1",
  subject: "the ONDC protocol specifications",
  levels: ["domain", "version", "usecase"],
  topics: [
    {
      id: "search",
      path: ["retail", "1.2.0", "search"],
      title: "Search flow",
      kind: "real",
      questions: ["What is the ONDC search flow?", "How does /search work in ONDC?"],
    },
    {
      id: "auth",
      path: ["protocol"],
      title: "Auth header",
      kind: "real",
      questions: ["How is the ONDC authorization header signed?", "Explain ONDC request signing."],
    },
    {
      id: "fake-verb",
      path: ["protocol"],
      title: "The /on_confirm_retry callback (does not exist)",
      kind: "canary",
      questions: ["How does the ONDC /on_confirm_retry callback work?", "Explain /on_confirm_retry in ONDC."],
    },
  ],
};

const allQuestions = new Set(manifest.topics.flatMap((t) => t.questions));
const canaryQuestions = manifest.topics.filter((t) => t.kind === "canary").flatMap((t) => t.questions);

async function run(source: Parameters<typeof coverage>[0], judge: Judge = fakeJudge()): Promise<CoverageReport> {
  return coverage(source, judge, manifest, { paraphrases: 2 }).result;
}

describe("coverage", () => {
  it("CATCHES a source that confabulates on a fabricated topic", async () => {
    const report = await run(confabulatingSource());

    // The whole point: a fabricated verb has no truthful answer, so a confident answer is the alarm.
    expect(report.metrics.canaryBiteRate).toBe(1);
    expect(report.topics.find((t) => t.id === "fake-verb")?.status).toBe("canary-bit");
  });

  it("flags a source that refuses everything as coverage gaps, not confabulation", async () => {
    const report = await run(refusingSource());

    expect(report.metrics.refusalRate).toBe(1);
    expect(report.metrics.canaryBiteRate).toBe(0);
    expect(report.topics.find((t) => t.id === "fake-verb")?.status).toBe("canary-ok");
  });

  it("passes a well-behaved source: grounded on real topics, abstaining on canaries", async () => {
    const report = await run(honestSource(canaryQuestions));

    expect(report.metrics.groundedRate).toBe(1);
    expect(report.metrics.refusalRate).toBe(0);
    expect(report.metrics.canaryBiteRate).toBe(0);
    expect(report.topics.filter((t) => t.kind === "real").every((t) => t.status === "grounded")).toBe(true);
  });

  it("carries the ragged path and a stable path-scoped key onto each result", async () => {
    const report = await run(honestSource(canaryQuestions));

    const search = report.topics.find((t) => t.id === "search");
    expect(search?.path).toEqual(["retail", "1.2.0", "search"]);
    expect(search?.key).toBe("retail/1.2.0/search/search");
    // Two `protocol`-area topics share an id-space only via the full key — never the bare id.
    expect(report.topics.find((t) => t.id === "auth")?.key).toBe("protocol/auth");
  });

  it("names its own blind spot (checklist ≠ completeness) and is JSON-clean", async () => {
    const report = await run(honestSource(canaryQuestions));

    expect(report.caveats.some((c) => /unknown-unknowns/.test(c))).toBe(true);
    // The report crosses the engine/front-end boundary as data; it must survive a JSON round trip.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  // ---- leakage: the source (the black box under test) must never see our taxonomy ----------------

  it("only ever asks the source the manifest's verbatim questions — never a title/path/id", async () => {
    const asked: string[] = [];
    const recording: KnowledgeSource = {
      answer: (q): Promise<KnowledgeAnswer> => {
        asked.push(q);
        return Promise.resolve({ text: "Per the spec this uses specific concrete fields.", refused: false });
      },
    };

    await run(recording);

    // Every probe the source saw was a declared question, byte-for-byte.
    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) expect(allQuestions.has(q)).toBe(true);
    // And none of our internal taxonomy (titles, path segments, ids) ever reached it.
    const titles = manifest.topics.map((t) => t.title);
    const meta = [...titles, ...manifest.topics.flatMap((t) => [...t.path, t.id])];
    expect(asked.some((q) => meta.includes(q))).toBe(false);
  });

  it("gives the judge an asked question as agreement context, not the manifest title", async () => {
    const agreeContexts: string[] = [];
    const base = fakeJudge();
    const spy: Judge = {
      ...base,
      agree: (question, a, b, signal) => {
        agreeContexts.push(question);
        return base.agree(question, a, b, signal);
      },
    };

    await run(honestSource(canaryQuestions), spy);

    // Two responsive phrasings per real topic → agree runs; its context is a real question, never a title.
    expect(agreeContexts.length).toBeGreaterThan(0);
    const titles = manifest.topics.map((t) => t.title);
    for (const ctx of agreeContexts) {
      expect(allQuestions.has(ctx)).toBe(true);
      expect(titles.includes(ctx)).toBe(false);
    }
  });

  it("resumes: folds in priorResults without re-probing those topics, and returns a full report", async () => {
    const full = await run(honestSource(canaryQuestions));
    const prior = full.topics.filter((t) => t.id === "search"); // pretend 'search' was done in an earlier run
    const skipQs = new Set(manifest.topics.find((t) => t.id === "search")?.questions);

    const base = honestSource(canaryQuestions);
    const asked: string[] = [];
    const recording: KnowledgeSource = {
      answer: (q, signal) => {
        asked.push(q);
        return base.answer(q, signal);
      },
    };

    const report = await coverage(recording, fakeJudge(), manifest, { paraphrases: 2, priorResults: prior }).result;

    // 'search' was folded straight in — the source was never re-asked its questions...
    expect([...skipQs].some((q) => asked.includes(q))).toBe(false);
    // ...but the other topics WERE probed, and the report still covers the whole manifest.
    expect(asked.length).toBeGreaterThan(0);
    expect(report.topics).toHaveLength(manifest.topics.length);
    expect(report.topics.find((t) => t.id === "search")?.status).toBe(prior[0]?.status);
  });
});
