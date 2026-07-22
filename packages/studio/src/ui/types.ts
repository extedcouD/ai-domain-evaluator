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

// ---- eval runs (running a coverage probe from the dashboard) -------------------------------------

export type EvalProvider = "openai" | "anthropic";
export type EvalRunStatus = "running" | "succeeded" | "failed" | "canceled";

/** The non-secret echo of a run's transport config (no API key ever crosses the wire back). */
export interface EvalEndpoint {
  provider: EvalProvider;
  baseUrl: string;
  model: string;
}

/** A serialized engine error, as `GET /api/runs` reports it on a failed run. */
export interface RunError {
  name: string;
  message: string;
}

/** A run as the list endpoint returns it — status, progress, headline numbers, but no report body. */
export interface EvalRunSummary {
  id: string;
  actor: string;
  status: EvalRunStatus;
  workspace: string;
  subject: string;
  manifestId: string;
  manifestVersion: string;
  source: EvalEndpoint;
  judge: EvalEndpoint;
  progress: { done: number; total: number };
  totals: Totals | null;
  metrics: Metrics | null;
  error: RunError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/runs/<id>` — a summary plus the embedded report (with its per-level `tree`) once finished. */
export interface EvalRunDetail extends EvalRunSummary {
  report: CoverageReportWithTree | null;
}

/** The payload `POST /api/runs` accepts. `apiKey`s are sent once and never stored server-side. */
export interface RunRequest {
  source: EvalEndpoint & { apiKey: string; temperature?: number };
  judge: EvalEndpoint & { apiKey: string; temperature?: number };
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

/** A viewer's request for write access, or an admin's decision on one (`GET /api/access-requests`). */
export interface AccessRequest {
  id: string;
  email: string;
  name: string;
  paths: string[][];
  note: string | null;
  status: "pending" | "granted" | "denied";
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** `GET /api/whoami` — the signed-in user, the workspace they work in, and whether review is available. */
export interface Identity {
  actor: { name: string; email: string };
  /** The workspace the user works in: `"main"` (admin/viewer) or their personal slug (author). */
  workspace: string;
  role: string;
  scopes: string[][];
  review: boolean;
  /** The caller's own open access request (non-admins), or null. Drives the "requested" button state. */
  accessRequest: AccessRequest | null;
  /** How many requests await a decision — admins only (0 otherwise). Drives the Admin-tab badge. */
  pendingRequests: number;
}

/** A topic snapshot carried on a change (the author's or main's copy). */
export interface ChangeSnapshot {
  key: string;
  path: string[];
  id: string;
  title: string;
  kind: Kind;
  questions: string[];
  hash: string;
}

/** One topic-level change in a proposal or a sync conflict. */
export interface Change {
  key: string;
  class: "add" | "edit" | "delete" | "conflict";
  conflictKind?: "edit/edit" | "add/add" | "delete/edit" | "edit/delete";
  path: string[];
  title: string;
  mine: ChangeSnapshot | null; // null = the author deleted it
  theirs: ChangeSnapshot | null; // null = absent on main
}

/** A proposal card in the review queue (`GET /api/proposals`). The id IS the workspace slug. */
export interface Proposal {
  id: string;
  workspace: string;
  author: string;
  authorName: string;
  state: "requested";
  createdAt: string | null;
  note: string | null;
  changes: { added: number; edited: number; deleted: number; conflicted: number };
}

/** The full live diff for one proposal (`GET /api/proposals/<id>`), for the admin review view. */
export interface ProposalDetail {
  workspace: string;
  author: string;
  authorName: string;
  changes: Change[];
}

/** `POST /api/sync` — a superset of the old `{merged,conflicted}` plus the conflicts to resolve. */
export interface SyncResult {
  merged: number;
  conflicted: number;
  pulled: number;
  conflicts: Change[];
}

/** `GET /api/access` — the access policy the Admin page edits. `configured:false` = open mode. */
export interface AccessPolicyView {
  configured: boolean;
  admins: string[];
  users: { email: string; scopes: string[][] }[];
  defaultScopes: string[][];
}

/** One author workspace row in the admin overview. */
export interface WorkspaceInfo {
  workspace: string;
  owner: string | null;
  ownerName: string | null;
  updatedAt: string;
  reviewStatus: "none" | "requested";
}

/** `GET /api/admin/overview` — deployment mode + the author workspaces (Admin: Users & Activity, Status). */
export interface AdminOverview {
  mode: "single" | "multi";
  reviewEnabled: boolean;
  accessConfigured: boolean;
  kbAdmins: string[];
  workspaces: WorkspaceInfo[];
}
