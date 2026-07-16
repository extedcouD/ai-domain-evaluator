/**
 * Per-level rollup — turns a flat `CoverageReport` into a tree keyed by taxonomy path prefix, so
 * coverage can be quantified at every level of a ragged taxonomy ("retail is 80% grounded; retail
 * 1.2.0 is 60%; retail 1.2.0 search is a gap").
 *
 * It is a PURE fold over the data the engine already returned — no I/O, no clock, no model. That is
 * why it lives in core and not the front-end: the CLI's `--coverage` printout and the Studio's
 * per-level gauges both want the same aggregation, and "the engine hands back data; grouping is
 * computed" keeps that logic in one place, reachable through the public surface.
 *
 * A topic attaches at the node addressed by its FULL path; a node's totals/metrics aggregate its
 * direct topics plus every descendant. Ragged is handled for free: a node can hold both direct topics
 * and children (a topic at `[retail]` and another at `[retail, 1.2.0, search]` coexist). The four
 * rates are derived over the same denominators `summarize()` uses (real for grounded/refused/
 * inconsistent, canary for bite), so a node's numbers match what the CLI prints for that subtree.
 */
import type { CoverageReport, TopicResult } from "./coverage";

export interface CoverageNode {
  /** This node's own path segment; `""` at the root. */
  segment: string;
  /** The full prefix from the root to this node. */
  path: string[];
  totals: { topics: number; real: number; canary: number };
  metrics: {
    groundedRate: number;
    refusalRate: number;
    inconsistencyRate: number;
    canaryBiteRate: number;
  };
  /** Topics attached DIRECTLY at this exact path (a ragged node may have both these and children). */
  topics: TopicResult[];
  /** Sorted by segment for stable, diffable output. */
  children: CoverageNode[];
}

export interface CoverageTree {
  root: CoverageNode;
}

interface Counts {
  real: number;
  grounded: number;
  refused: number;
  inconsistent: number;
  canary: number;
  bit: number;
}

/** Aggregate a flat coverage report into a prefix tree with per-node totals and rates. Pure. */
export function rollup(report: CoverageReport): CoverageTree {
  const root = makeNode("", []);

  for (const topic of report.topics) {
    let node = root;
    for (const seg of topic.path) node = childFor(node, seg);
    node.topics.push(topic);
  }

  aggregate(root);
  return { root };
}

function makeNode(segment: string, path: string[]): CoverageNode {
  return {
    segment,
    path,
    totals: { topics: 0, real: 0, canary: 0 },
    metrics: { groundedRate: 0, refusalRate: 0, inconsistencyRate: 0, canaryBiteRate: 0 },
    topics: [],
    children: [],
  };
}

function childFor(node: CoverageNode, segment: string): CoverageNode {
  let child = node.children.find((c) => c.segment === segment);
  if (child === undefined) {
    child = makeNode(segment, [...node.path, segment]);
    node.children.push(child);
  }
  return child;
}

/** Post-order: sort children/topics, then set totals + rates from direct topics plus descendants. */
function aggregate(node: CoverageNode): Counts {
  node.children.sort((a, b) => a.segment.localeCompare(b.segment));
  node.topics.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  const counts: Counts = { real: 0, grounded: 0, refused: 0, inconsistent: 0, canary: 0, bit: 0 };
  for (const t of node.topics) addTopic(counts, t);
  for (const child of node.children) addCounts(counts, aggregate(child));

  node.totals = { topics: counts.real + counts.canary, real: counts.real, canary: counts.canary };
  node.metrics = {
    groundedRate: rate(counts.grounded, counts.real),
    refusalRate: rate(counts.refused, counts.real),
    inconsistencyRate: rate(counts.inconsistent, counts.real),
    canaryBiteRate: rate(counts.bit, counts.canary),
  };
  return counts;
}

function addTopic(counts: Counts, t: TopicResult): void {
  if (t.kind === "canary") {
    counts.canary++;
    if (t.status === "canary-bit") counts.bit++;
    return;
  }
  counts.real++;
  if (t.status === "grounded") counts.grounded++;
  else if (t.status === "refused") counts.refused++;
  else if (t.status === "inconsistent") counts.inconsistent++;
}

function addCounts(into: Counts, from: Counts): void {
  into.real += from.real;
  into.grounded += from.grounded;
  into.refused += from.refused;
  into.inconsistent += from.inconsistent;
  into.canary += from.canary;
  into.bit += from.bit;
}

function rate(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}
