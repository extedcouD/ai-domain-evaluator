/**
 * Local mirrors of the engine's public shapes. These are DELIBERATELY hand-copied and NOT imported
 * from `@evaluator/core`: this file compiles into a browser bundle, and importing the engine would
 * drag the OpenAI SDK (and Node built-ins) into it. The server sends these shapes over `/api`; here
 * we only describe them for the type-checker. Keep them byte-compatible with the engine.
 */

export type Kind = "real" | "canary";

export interface Topic {
  id: string;
  path: string[];
  title: string;
  questions: string[];
  kind: Kind;
}

export interface Manifest {
  id: string;
  version: string;
  /** A noun-phrase naming the domain the source is about (e.g. "the ONDC protocol specifications"). */
  subject?: string;
  levels?: string[];
  topics: Topic[];
  /** topicKey (`[...path, id].join("/")`) → content hash, the optimistic-concurrency token per topic. */
  versions?: Record<string, string>;
}

export type TopicStatus =
  | "grounded"
  | "confident-ungrounded"
  | "refused"
  | "inconsistent"
  | "canary-ok"
  | "canary-bit";

export interface TopicResult {
  key: string;
  id: string;
  path: string[];
  title: string;
  kind: Kind;
  status: TopicStatus;
  agreement: number;
  sample: string;
  detail: string;
}

export interface Metrics {
  groundedRate: number;
  refusalRate: number;
  inconsistencyRate: number;
  canaryBiteRate: number;
}

export interface Totals {
  topics: number;
  real: number;
  canary: number;
}

export interface CoverageReport {
  manifestId: string;
  manifestVersion: string;
  source: string;
  totals: Totals;
  metrics: Metrics;
  topics: TopicResult[];
  judge: { schemaEnforced: boolean; warnings: string[] };
  caveats: string[];
  generatedAt?: string;
}

export interface CoverageNode {
  segment: string;
  path: string[];
  totals: Totals;
  metrics: Metrics;
  topics: TopicResult[];
  children: CoverageNode[];
}

/** `GET /api/coverage/<file>?tree=1` returns a report plus the per-level rollup on `tree`. */
export interface CoverageReportWithTree extends CoverageReport {
  tree?: CoverageNode;
}

export interface CoverageSummary {
  file: string;
  generatedAt: string;
  manifestId: string;
  manifestVersion: string;
  source: string;
  totals: Totals;
  metrics: Metrics;
}

export interface NodeInfo {
  path: string[];
  hasTopics: boolean;
}

/** One commit, as `GET /api/history` returns it (the History tab). */
export interface HistoryEntry {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

/** A deleted topic file with the revision to restore its last-live content from (the Trash tab). */
export interface DeletedEntry {
  file: string;
  restoreSha: string;
  deletedAt: string;
  deletedBy: string;
  message: string;
}

/** The `GET /api/history` payload: recent commits plus recoverable deletions. */
export interface HistoryData {
  commits: HistoryEntry[];
  deletions: DeletedEntry[];
}

/** `GET /api/whoami` — the signed-in user, their branch, and whether the review flow is available. */
export interface Identity {
  actor: { name: string; email: string };
  /** The user's branch in multi-user mode (`user/<login>`); null in single-workspace mode. */
  branch: string | null;
  role: string;
  scopes: string[][];
  review: boolean;
}

/** A pull request in the review queue (`GET /api/proposals`). */
export interface Proposal {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
}

/** `GET /api/access` — the access policy the Admin page edits. `configured:false` = open mode. */
export interface AccessPolicyView {
  configured: boolean;
  admins: string[];
  users: { email: string; scopes: string[][] }[];
  defaultScopes: string[][];
}

/** `GET /api/admin/overview` — deployment mode + active draft branches (Admin: Users & Activity, Status). */
export interface AdminOverview {
  mode: "single" | "multi";
  reviewEnabled: boolean;
  accessConfigured: boolean;
  kbAdmins: string[];
  branches: { branch: string; login: string; author: string; date: string; message: string }[];
}
