/**
 * Workspace routing — which Mongo workspace a request reads and writes.
 *
 * `main` is canonical. Admins edit it directly; viewers read it (writes are refused by scope). An
 * author works in a personal COPY (`workspaces.<slug>`) that is cloned from main on their FIRST write,
 * so they can never touch main or another author's copy. The clone is crash-safe via a `ready` flag and
 * runs inside the server's write mutex (single node process → no two clones race), so this module never
 * locks itself.
 */
import type { Actor } from "./actor";
import type { DbHandle } from "./db";
import { ObjectId } from "./db";
import { MAIN, type ManifestStore } from "./store";

/** A safe workspace id derived from an actor's email (or name). */
export function loginSlug(actor: Actor): string {
  const base = (actor.email || actor.name).toLowerCase();
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

/** The workspace an actor is CONCEPTUALLY on (for whoami/UI): their slug if an author, else main. */
export function intendedWorkspace(role: "admin" | "author" | "viewer", actor: Actor): string {
  return role === "author" ? loginSlug(actor) : MAIN;
}

/** The workspace a READ should serve: an author's ready copy if it exists, else main (pre-first-write). */
export async function readWorkspace(db: DbHandle, role: "admin" | "author" | "viewer", actor: Actor): Promise<string> {
  if (role !== "author") return MAIN;
  const ws = loginSlug(actor);
  const doc = await db.workspaces.findOne({ _id: ws });
  return doc && doc.ready ? ws : MAIN;
}

/**
 * Ensure the author's workspace exists as a ready clone of main, returning its id. MUST be called inside
 * the write mutex (it does no locking of its own). Idempotent: a ready workspace is returned untouched;
 * a fresh or half-cloned (crashed) one is (re)built — the `ready` flag flips true only after the copy
 * completes, so a crash mid-clone is redone rather than half-served.
 */
export async function ensureUserWorkspace(db: DbHandle, store: ManifestStore, actor: Actor): Promise<string> {
  const ws = loginSlug(actor);
  const existing = await db.workspaces.findOne({ _id: ws });
  if (existing && existing.ready) return ws;

  const main = await db.workspaces.findOne({ _id: MAIN });
  if (!main) throw new Error("main workspace is missing — import the KB first");

  const now = new Date();
  await db.workspaces.updateOne(
    { _id: ws },
    {
      $set: {
        owner: actor.email,
        ownerName: actor.name,
        updatedAt: now,
        ready: false,
        meta: main.meta,
        metaHash: main.metaHash,
        baseMetaHash: main.metaHash,
        nodes: main.nodes,
        reviewStatus: "none",
        reviewRequestedAt: null,
        reviewNote: null,
        lastSyncedAt: now,
        lastMergedAt: null,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  // Replace any stale copy, then clone main's live topics with baseHash = hash (the fork point).
  await db.topics.deleteMany({ workspace: ws });
  const mainTopics = await store.liveTopics(MAIN);
  if (mainTopics.length) {
    await db.topics.insertMany(
      mainTopics.map((t) => ({
        _id: new ObjectId(),
        workspace: ws,
        key: t.key,
        path: t.path,
        id: t.id,
        title: t.title,
        kind: t.kind,
        questions: t.questions,
        hash: t.hash,
        baseHash: t.hash,
        deleted: false,
        updatedAt: now,
        updatedBy: actor.email,
      })),
    );
  }
  await db.workspaces.updateOne({ _id: ws }, { $set: { ready: true, updatedAt: new Date() } });
  return ws;
}
