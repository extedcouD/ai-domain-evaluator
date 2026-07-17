/**
 * Pure derivations shared by the reducer, the components, and the tests. No React, no DOM, no fetch,
 * no clock — every function here is a total function of its arguments, so the grouping/filtering/health
 * logic can be unit-tested directly and reused between the author list, the tree spine, and coverage.
 *
 * The taxonomy is a RAGGED nested path (`string[]`), not a flat area. The stable cross-run identity of
 * a topic is its `topicKey` = `[...path, id].join("/")`; coverage joins (A-vs-B) key on it.
 */
import type {
  CoverageReport,
  Kind,
  Metrics,
  NodeInfo,
  Topic,
  TopicResult,
  TopicStatus,
} from "./types";

// ---- validation (mirrors the server's manifest-folder regexes) ---------------------------------

/** A safe path SEGMENT: lowercase alnum start, then alnum/dot/dash (dots allow versions like 1.2.0). */
export const SEGMENT_RE = /^[a-z0-9][a-z0-9.-]*$/;
/** A topic id: lowercase alnum start, then alnum/dash — NO dots (the one dot is the `.yaml`). */
export const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Tolerate a legacy/undefined `path` (a report predating the path[] migration) — a missing path must
// never throw and blank the whole app. The server normalizes reports too; this is belt-and-suspenders.
export const topicKey = (t: { path?: string[]; id: string }): string =>
  [...(Array.isArray(t.path) ? t.path : []), t.id].join("/");

export const pathKey = (path: string[]): string => (Array.isArray(path) ? path : []).join("/");

/** Does `path` sit at or under `prefix`? (`[]` is the root prefix, matching everything.) */
export function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((seg, i) => path[i] === seg);
}

/**
 * Parse a repo-relative topic file path (`…/topics/<seg…>/<id>.yaml`) into `{ path, id }`, or null when
 * it isn't a topic file. Turns a Trash entry's `file` back into the coordinates `POST /api/restore` wants.
 */
export function topicRefFromFile(file: string): { path: string[]; id: string } | null {
  const body = /topics\/(.+)\.yaml$/.exec(file)?.[1];
  if (!body) return null;
  const segs = body.split("/");
  const id = segs.pop();
  if (!id || segs.length === 0) return null;
  return { path: segs, id };
}

export const pct = (x: number): string => `${String(Math.round((x || 0) * 100))}%`;

// ---- status → visual buckets -------------------------------------------------------------------

export type StatusBucket = "ok" | "caution" | "gap" | "alarm";

export const STATUS_CLASS: Record<TopicStatus, string> = {
  grounded: "s-ok",
  "canary-ok": "s-ok",
  "confident-ungrounded": "s-warn",
  inconsistent: "s-warn",
  refused: "s-muted",
  "canary-bit": "s-alarm",
};

export const STATUS_BUCKET: Record<TopicStatus, StatusBucket> = {
  grounded: "ok",
  "canary-ok": "ok",
  "confident-ungrounded": "caution",
  inconsistent: "caution",
  refused: "gap",
  "canary-bit": "alarm",
};

export interface MetricDef {
  key: keyof Metrics;
  label: string;
  good: "up" | "down";
  alarm?: boolean;
}

export const METRICS: MetricDef[] = [
  { key: "groundedRate", label: "grounded", good: "up" },
  { key: "refusalRate", label: "refused", good: "down" },
  { key: "inconsistencyRate", label: "inconsistent", good: "down" },
  { key: "canaryBiteRate", label: "canary-bite", good: "down", alarm: true },
];

// ---- coverage status index ---------------------------------------------------------------------

export type StatusIndex = Record<string, TopicResult>;

/** Index a report's topics by `topicKey`, so the author list can overlay each topic's latest status. */
export function statusIndex(report: CoverageReport | null | undefined): StatusIndex {
  const out: StatusIndex = {};
  if (!report) return out;
  for (const t of report.topics) out[t.key || topicKey(t)] = t;
  return out;
}

// ---- health counts -----------------------------------------------------------------------------

export interface HealthCounts {
  ok: number;
  caution: number;
  gap: number;
  alarm: number;
  unknown: number;
  total: number;
}

export function emptyHealth(): HealthCounts {
  return { ok: 0, caution: 0, gap: 0, alarm: 0, unknown: 0, total: 0 };
}

export function addHealth(into: HealthCounts, from: HealthCounts): void {
  into.ok += from.ok;
  into.caution += from.caution;
  into.gap += from.gap;
  into.alarm += from.alarm;
  into.unknown += from.unknown;
  into.total += from.total;
}

/** Health of a set of topics, looked up in a status index. `unknown` counts topics with no result. */
export function healthOf(topics: Topic[], index: StatusIndex): HealthCounts {
  const c = emptyHealth();
  for (const t of topics) {
    c.total++;
    const r = index[topicKey(t)];
    if (!r) c.unknown++;
    else c[STATUS_BUCKET[r.status]]++;
  }
  return c;
}

// ---- filtering + grouping ----------------------------------------------------------------------

export interface Filters {
  query: string;
  kind: Kind | null;
  status: StatusBucket | null;
}

export function matchesFilters(t: Topic, f: Filters, index: StatusIndex): boolean {
  if (f.kind && t.kind !== f.kind) return false;
  if (f.status) {
    const r = index[topicKey(t)];
    if (!r || STATUS_BUCKET[r.status] !== f.status) return false;
  }
  if (f.query) {
    const q = f.query.toLowerCase();
    const hay = `${t.title} ${t.id} ${t.path.join("/")} ${t.questions.join(" ")}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Real topics before canaries, then by id — the stable within-group order. */
function byKindThenId(a: Topic, b: Topic): number {
  if (a.kind !== b.kind) return a.kind === "real" ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Topics under a path prefix, passing the filters, sorted by full path then kind then id. */
export function visibleTopics(topics: Topic[], prefix: string[], f: Filters, index: StatusIndex): Topic[] {
  return topics
    .filter((t) => pathStartsWith(t.path, prefix) && matchesFilters(t, f, index))
    .sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path)) || byKindThenId(a, b));
}

export interface TopicGroup {
  path: string[];
  topics: Topic[];
}

/** Group an already-ordered topic list into consecutive same-path runs (the breadcrumb groups). */
export function groupByPath(topics: Topic[]): TopicGroup[] {
  const out: TopicGroup[] = [];
  for (const t of topics) {
    const last = out[out.length - 1];
    if (last && pathKey(last.path) === pathKey(t.path)) last.topics.push(t);
    else out.push({ path: t.path, topics: [t] });
  }
  return out;
}

// ---- taxonomy node tree ------------------------------------------------------------------------

export interface TreeNode {
  segment: string;
  path: string[];
  hasTopics: boolean;
  children: TreeNode[];
}

/** Build a nested tree from the flat `GET /api/nodes` list (which is already DFS/sorted). */
export function buildNodeTree(nodes: NodeInfo[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byKey = new Map<string, TreeNode>();
  // Sort by depth then path so a parent is always created before its children.
  const sorted = [...nodes].sort((a, b) => a.path.length - b.path.length || pathKey(a.path).localeCompare(pathKey(b.path)));
  for (const n of sorted) {
    const seg = n.path[n.path.length - 1] ?? "";
    const node: TreeNode = { segment: seg, path: n.path, hasTopics: n.hasTopics, children: [] };
    byKey.set(pathKey(n.path), node);
    if (n.path.length <= 1) {
      roots.push(node);
    } else {
      const parent = byKey.get(pathKey(n.path.slice(0, -1)));
      if (parent) parent.children.push(node);
      else roots.push(node); // orphan (shouldn't happen) — surface it rather than drop it
    }
  }
  return roots;
}

/** A version-like segment: `v1`, `1.2`, `1.2.0`, `2024-01` — a depth of these is auto-labelled "version". */
const VERSIONISH = /^v?\d+(?:[.-]\d+)+$|^v\d+$/i;

/**
 * Suggest taxonomy level LABELS from the folder structure. The folders give the DEPTH (how many labels
 * are needed) and the segment names at each depth — but not a level's human meaning, so each slot gets a
 * best-effort, editable default: a depth whose segments are ALL version-like → "version"; the first
 * level → "domain"; otherwise "level N". Labels are display-only metadata, so this is a starting point
 * the author renames, never a constraint (see the manifest `levels` schema comment in core).
 */
export function suggestLevelLabels(paths: string[][]): string[] {
  const depth = paths.reduce((m, p) => Math.max(m, p.length), 0);
  const out: string[] = [];
  for (let i = 0; i < depth; i++) {
    const segs = paths.map((p) => p[i]).filter((s): s is string => s !== undefined);
    const allVersion = segs.length > 0 && segs.every((s) => VERSIONISH.test(s));
    out.push(allVersion ? "version" : i === 0 ? "domain" : `level ${String(i + 1)}`);
  }
  return out;
}

// ---- compare (A vs B) --------------------------------------------------------------------------

export interface Transition {
  key: string;
  id: string;
  path: string[];
  title: string;
  from: TopicStatus;
  to: TopicStatus;
  note: string;
  cls: string;
}

/** Classify a status transition — only a rising canary-bite is a hard REGRESSION. */
function classify(from: TopicStatus, to: TopicStatus): { note: string; cls: string } {
  if (to === "canary-bit") return { note: "REGRESSION", cls: "s-alarm" };
  if (from === "canary-bit" && to === "canary-ok") return { note: "fixed", cls: "s-ok" };
  if (to === "grounded") return { note: "coverage gain", cls: "s-ok" };
  if (from === "grounded") return { note: "regression", cls: "s-warn" };
  return { note: "changed", cls: "s-muted" };
}

/** Join newer vs older report topics by `topicKey`, keeping only those whose status changed. */
export function statusTransitions(newer: CoverageReport, older: CoverageReport): Transition[] {
  const oldByKey = new Map<string, TopicResult>();
  for (const t of older.topics) oldByKey.set(t.key || topicKey(t), t);

  const out: Transition[] = [];
  for (const t of newer.topics) {
    const k = t.key || topicKey(t);
    const prev = oldByKey.get(k);
    if (!prev || prev.status === t.status) continue;
    const { note, cls } = classify(prev.status, t.status);
    out.push({ key: k, id: t.id, path: t.path, title: t.title, from: prev.status, to: t.status, note, cls });
  }
  return out.sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path)) || a.id.localeCompare(b.id));
}

export interface MetricDelta {
  def: MetricDef;
  now: number;
  delta: number;
  better: boolean;
  regression: boolean;
}

export function metricDeltas(newer: Metrics, older: Metrics): MetricDelta[] {
  return METRICS.map((def) => {
    const now = newer[def.key] || 0;
    const delta = now - (older[def.key] || 0);
    const better = def.good === "up" ? delta > 0 : delta < 0;
    return { def, now, delta, better, regression: !!def.alarm && delta > 0 };
  });
}
