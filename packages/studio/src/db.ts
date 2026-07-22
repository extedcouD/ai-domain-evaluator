/**
 * The MongoDB backing store — the single source of truth for the KB, replacing the git worktree tree.
 *
 * A canonical `workspaces.main` holds the shared KB; each author gets a personal `workspaces.<slug>`
 * copy (cloned from main on first write); `topics` holds one document per topic per workspace (with
 * tombstones for user-side deletions); `config.access` is the singleton scoping policy; `revisions` is
 * an append-only audit log (the History/Trash surface + a TTL so it self-prunes).
 *
 * Deployment target is a STANDALONE mongod (self-hosted on EC2): NO transactions and NO change streams.
 * Correctness therefore rests on two primitives only — single-document atomic ops (`findOneAndUpdate`
 * with a hash guard, unique `{workspace,key}` index) and one process-wide `async-mutex` for the
 * multi-document sequences (sync / merge / clone). This module owns the connection, the typed
 * collection accessors, and the index set; all logic lives in `store.ts` / `merge.ts` / `history.ts`.
 */
import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";

import type { CoverageReport, SerializedError } from "@evaluator/core";

export { ObjectId };

export type TopicKind = "real" | "canary";

/** The manifest identity carried on a workspace (mirrors `manifest.meta.yaml`). */
export interface WorkspaceMeta {
  id: string;
  version: string;
  subject?: string;
  levels?: string[];
}

/**
 * A workspace: `"main"` is canonical (owner null); every other is one author's copy. `ready` is false
 * only while the clone-from-main is in flight, so a crashed clone is redone rather than half-read. The
 * "merge request" is simply `reviewStatus:"requested"` — there is no snapshot; the diff is computed live.
 */
export interface WorkspaceDoc {
  _id: string; // "main" | loginSlug(email)
  owner: string | null; // email; null for main
  ownerName?: string;
  createdAt: Date;
  updatedAt: Date;
  ready: boolean;
  meta: WorkspaceMeta;
  metaHash: string;
  baseMetaHash: string | null; // user ws only (the main metaHash it forked from); null on main
  nodes: string[][]; // explicitly-created (possibly empty) taxonomy folders
  reviewStatus: "none" | "requested";
  reviewRequestedAt: Date | null;
  reviewNote: string | null;
  lastSyncedAt: Date | null;
  lastMergedAt: Date | null;
}

/**
 * One topic in one workspace. `key = [...path, id].join("/")` is the stable identity a merge joins on;
 * `hash` is the content hash (optimistic-concurrency token); `baseHash` is main's hash this forked from
 * (null = added in this ws; always null on main). `deleted` is a tombstone (user ws only) so a user's
 * deletion can be carried to main by a merge.
 */
export interface TopicDoc {
  _id: ObjectId;
  workspace: string;
  key: string;
  path: string[];
  id: string;
  title: string;
  kind: TopicKind;
  questions: string[];
  hash: string;
  baseHash: string | null;
  deleted: boolean;
  updatedAt: Date;
  updatedBy: string;
}

/** The singleton access policy (`config._id:"access"`) — replaces the git-tracked `access.yaml`. */
export interface AccessDoc {
  _id: string; // always "access"
  admins: string[];
  users: { email: string; scopes: string[][] }[];
  defaultScopes: string[][]; // [] ⇒ default role = viewer
  updatedAt: Date;
  updatedBy: string;
}

/**
 * A viewer's request for write access (`accessRequests` collection). A viewer picks the taxonomy
 * path(s) they want to edit; an admin grants (merging those — or adjusted — scopes into the access
 * policy, promoting the requester to an author) or denies. Only ONE `pending` request may exist per
 * email at a time (a partial-unique index enforces it), so submitting again upserts.
 */
export interface AccessRequestDoc {
  _id: ObjectId;
  email: string; // requester (from the trusted proxy identity)
  name: string;
  paths: string[][]; // the taxonomy path(s) they asked to edit
  note: string | null; // optional message to the admins
  status: "pending" | "granted" | "denied";
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null; // admin email who granted/denied
}

/** A point-in-time copy of a topic, stored on a revision so a delete/edit stays restorable. */
export interface TopicSnapshot {
  key: string;
  path: string[];
  id: string;
  title: string;
  kind: TopicKind;
  questions: string[];
  hash: string;
}

export type RevisionAction =
  | "save"
  | "rename"
  | "delete"
  | "node-create"
  | "node-move"
  | "node-delete"
  | "meta"
  | "restore"
  | "merge"
  | "sync"
  | "access"
  | "import";

/** One append-only audit entry — the History log and the Trash view read these. `_id` hex plays the old git "sha". */
export interface RevisionDoc {
  _id: ObjectId;
  workspace: string;
  actor: { name: string; email: string };
  ts: Date;
  action: RevisionAction;
  topicKey?: string;
  before?: TopicSnapshot | null; // restore source (the pre-change content)
  after?: TopicSnapshot | null;
  message: string;
}

export type EvalProvider = "openai" | "anthropic";

export type EvalRunStatus = "running" | "succeeded" | "failed" | "canceled";

/** The NON-SECRET echo of a run's transport config. The API key is deliberately absent — see EvalRunDoc. */
export interface EvalEndpoint {
  provider: EvalProvider;
  baseUrl: string;
  model: string;
}

/**
 * One coverage evaluation a user kicked off from the dashboard: a probe of a user-supplied endpoint
 * (the source) graded by a second user-supplied endpoint (the judge), run against the KB in a
 * workspace. The API keys used to reach both endpoints live ONLY in the runner's memory for the run's
 * lifetime and are NEVER written here — only the provider/baseUrl/model echo is. `report` is the
 * finished `CoverageReport` (the same JSON the CLI writes to a file), embedded on success. Reads are
 * scoped by `actor`; a run that outlives its process is reaped to `failed` on the next boot.
 */
export interface EvalRunDoc {
  _id: string; // runId
  actor: string; // owner email
  workspace: string; // the KB workspace the run probed
  subject: string;
  manifestId: string;
  manifestVersion: string;
  status: EvalRunStatus;
  source: EvalEndpoint;
  judge: EvalEndpoint;
  progress: { done: number; total: number };
  report: CoverageReport | null; // embedded on success
  error: SerializedError | null; // set on failure
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The connected database plus typed accessors for every collection. */
export interface DbHandle {
  client: MongoClient;
  db: Db;
  workspaces: Collection<WorkspaceDoc>;
  topics: Collection<TopicDoc>;
  config: Collection<AccessDoc>;
  revisions: Collection<RevisionDoc>;
  accessRequests: Collection<AccessRequestDoc>;
  evalRuns: Collection<EvalRunDoc>;
  close(): Promise<void>;
}

/** Connect and return the typed collection handles. The caller owns the lifetime (`close()` on shutdown). */
export async function connectDb(uri: string, dbName: string): Promise<DbHandle> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  return {
    client,
    db,
    workspaces: db.collection<WorkspaceDoc>("workspaces"),
    topics: db.collection<TopicDoc>("topics"),
    config: db.collection<AccessDoc>("config"),
    revisions: db.collection<RevisionDoc>("revisions"),
    accessRequests: db.collection<AccessRequestDoc>("accessRequests"),
    evalRuns: db.collection<EvalRunDoc>("evalRuns"),
    close: () => client.close(),
  };
}

/** How long revisions live before the TTL index prunes them (audit trail depth). */
function historyTtlSeconds(): number {
  const days = Number(process.env["KB_HISTORY_TTL_DAYS"] ?? "365");
  return (Number.isFinite(days) && days > 0 ? days : 365) * 86400;
}

/**
 * Create every index the store relies on. Idempotent (safe to call on every boot). The UNIQUE
 * `{workspace,key}` index is the correctness anchor: it makes "two topics at the same key in one
 * workspace" impossible, so an add/add race surfaces as a duplicate-key error instead of silent
 * divergence.
 */
export async function ensureIndexes(h: DbHandle): Promise<void> {
  await h.workspaces.createIndex({ reviewStatus: 1 });
  await h.topics.createIndex({ workspace: 1, key: 1 }, { unique: true });
  await h.topics.createIndex({ workspace: 1, deleted: 1 });
  await h.revisions.createIndex({ workspace: 1, ts: -1 });
  await h.revisions.createIndex({ workspace: 1, topicKey: 1, ts: -1 });
  await h.revisions.createIndex({ ts: 1 }, { expireAfterSeconds: historyTtlSeconds() });
  // At most one OPEN request per email (submitting again upserts); the status/date index feeds the admin queue.
  await h.accessRequests.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });
  await h.accessRequests.createIndex({ status: 1, createdAt: -1 });
  // The dashboard lists a user's own runs newest-first; this index serves both that and the admin `?all=1` scan.
  await h.evalRuns.createIndex({ actor: 1, createdAt: -1 });
}
