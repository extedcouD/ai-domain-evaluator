import { describe, expect, it } from "vitest";

import { rollup, type CoverageNode, type CoverageReport, type TopicResult, type TopicStatus } from "@evaluator/core";

function topic(path: string[], id: string, kind: "real" | "canary", status: TopicStatus): TopicResult {
  return { key: [...path, id].join("/"), id, path, title: id, kind, status, agreement: 1, sample: "", detail: "" };
}

function report(topics: TopicResult[]): CoverageReport {
  return {
    manifestId: "kb",
    manifestVersion: "1",
    source: "src",
    totals: {
      topics: topics.length,
      real: topics.filter((t) => t.kind === "real").length,
      canary: topics.filter((t) => t.kind === "canary").length,
    },
    metrics: { groundedRate: 0, refusalRate: 0, inconsistencyRate: 0, canaryBiteRate: 0 },
    topics,
    judge: { schemaEnforced: true, warnings: [] },
    caveats: [],
  };
}

function child(node: CoverageNode, segment: string): CoverageNode {
  const c = node.children.find((ch) => ch.segment === segment);
  if (c === undefined)
    throw new Error(`no child "${segment}" in [${node.children.map((ch) => ch.segment).join(", ")}]`);
  return c;
}

describe("rollup", () => {
  // A ragged tree: a topic sits directly at `retail`, a canary at `retail/1.2.0`, and two leaves below.
  const tree = rollup(
    report([
      topic(["retail", "1.2.0", "search"], "search", "real", "grounded"),
      topic(["retail", "1.2.0", "select"], "select", "real", "refused"),
      topic(["retail"], "overview", "real", "grounded"),
      topic(["retail", "1.2.0"], "fake", "canary", "canary-bit"),
      topic(["protocol"], "auth", "real", "inconsistent"),
    ]),
  ).root;

  it("aggregates totals and the four rates over a whole subtree", () => {
    expect(tree.totals).toEqual({ topics: 5, real: 4, canary: 1 });
    expect(tree.metrics.groundedRate).toBeCloseTo(2 / 4);
    expect(tree.metrics.refusalRate).toBeCloseTo(1 / 4);
    expect(tree.metrics.inconsistencyRate).toBeCloseTo(1 / 4);
    expect(tree.metrics.canaryBiteRate).toBe(1); // the one canary bit
  });

  it("scopes metrics to each path prefix (real denom is real-only; bite denom is canary-only)", () => {
    const v = child(child(tree, "retail"), "1.2.0");
    expect(v.totals).toEqual({ topics: 3, real: 2, canary: 1 });
    expect(v.metrics.groundedRate).toBeCloseTo(1 / 2);
    expect(v.metrics.refusalRate).toBeCloseTo(1 / 2);
    expect(v.metrics.canaryBiteRate).toBe(1);
  });

  it("attaches a ragged topic at its exact node, not a leaf", () => {
    const retail = child(tree, "retail");
    expect(retail.topics.map((t) => t.id)).toEqual(["overview"]); // the depth-1 topic sits here directly
    const v = child(retail, "1.2.0");
    expect(v.topics.map((t) => t.id)).toEqual(["fake"]); // the canary sits at the depth-2 node
    expect(child(v, "search").topics.map((t) => t.id)).toEqual(["search"]);
  });

  it("sorts children by segment for stable, diffable output", () => {
    const v = child(child(tree, "retail"), "1.2.0");
    expect(v.children.map((c) => c.segment)).toEqual(["search", "select"]);
    expect(tree.children.map((c) => c.segment)).toEqual(["protocol", "retail"]);
  });
});
