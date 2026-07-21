/**
 * The revision log — the append-only audit trail that replaces `git log` + the trash view. Every
 * mutation writes one `revisions` document (attributed, timestamped); the History panel reads them back
 * and the Trash view surfaces the recoverable deletions. A TTL index on `ts` prunes old entries.
 *
 * The old API spoke git shapes, so these keep them: a `HistoryEntry.sha` is the revision `_id` hex, and
 * a Trash `file` keeps the `topics/<key>.yaml` form the UI turns back into `{path,id}` for restore.
 */
import type { Actor } from "./actor";
import { ObjectId, type DbHandle, type RevisionAction, type RevisionDoc, type TopicSnapshot } from "./db";

/** One log entry, as `GET /api/history` returns it (git-compatible field names). */
export interface HistoryEntry {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

/** A recoverable deletion, as the Trash view shows it. */
export interface DeletedEntry {
  file: string;
  restoreSha: string;
  deletedAt: string;
  deletedBy: string;
  message: string;
}

export interface RevisionInput {
  workspace: string;
  actor: Actor;
  action: RevisionAction;
  message: string;
  topicKey?: string;
  before?: TopicSnapshot | null;
  after?: TopicSnapshot | null;
}

/** Append one revision, returning its `_id` hex (the value that plays the old git "sha"). */
export async function appendRevision(db: DbHandle, input: RevisionInput): Promise<string> {
  const _id = new ObjectId();
  const doc: RevisionDoc = {
    _id,
    workspace: input.workspace,
    actor: { name: input.actor.name, email: input.actor.email },
    ts: new Date(),
    action: input.action,
    message: input.message,
  };
  if (input.topicKey !== undefined) doc.topicKey = input.topicKey;
  if (input.before !== undefined) doc.before = input.before;
  if (input.after !== undefined) doc.after = input.after;
  await db.revisions.insertOne(doc);
  return _id.toHexString();
}

/** Recent log entries for a workspace, newest first; `topicKey` narrows to one topic's history. */
export async function listHistory(db: DbHandle, ws: string, opts: { limit: number; topicKey?: string }): Promise<HistoryEntry[]> {
  const filter = opts.topicKey !== undefined ? { workspace: ws, topicKey: opts.topicKey } : { workspace: ws };
  const docs = await db.revisions.find(filter).sort({ ts: -1 }).limit(opts.limit).toArray();
  return docs.map((r) => ({
    sha: r._id.toHexString(),
    author: r.actor.name,
    email: r.actor.email,
    date: r.ts.toISOString(),
    message: r.message,
  }));
}

/**
 * Recoverable deletions in a workspace — the most recent delete per key whose topic is NOT currently
 * live (a topic deleted then re-created has left Trash). Newest first, capped at `limit`.
 */
export async function listDeletions(db: DbHandle, ws: string, limit: number): Promise<DeletedEntry[]> {
  const liveKeys = new Set((await db.topics.find({ workspace: ws, deleted: false }).toArray()).map((d) => d.key));
  const deletes = await db.revisions.find({ workspace: ws, action: "delete" }).sort({ ts: -1 }).toArray();
  const out: DeletedEntry[] = [];
  const seen = new Set<string>();
  for (const r of deletes) {
    const key = r.before?.key ?? r.topicKey;
    if (!key || seen.has(key) || liveKeys.has(key)) continue;
    seen.add(key);
    out.push({
      file: `topics/${key}.yaml`,
      restoreSha: r._id.toHexString(),
      deletedAt: r.ts.toISOString(),
      deletedBy: r.actor.name,
      message: r.message,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Fetch a revision by its hex `_id` (the "sha"), or null when the id is malformed or absent. */
export async function getRevision(db: DbHandle, sha: string): Promise<RevisionDoc | null> {
  if (!/^[0-9a-f]{24}$/i.test(sha)) return null;
  return db.revisions.findOne({ _id: new ObjectId(sha) });
}
