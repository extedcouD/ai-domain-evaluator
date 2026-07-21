/**
 * Three-way merge at TOPIC granularity (no line merging) between a user workspace and main.
 *
 * For each topic key we hold three facts: `mine` (the user doc — live, tombstone, or absent), `base`
 * (the user doc's `baseHash` — main's hash it forked from; null = added here), and `theirs` (main's
 * current doc). The classification below is the single source of truth; sync, merge, the proposal diff,
 * and conflict resolution all read it. Meta is out of this path: only admins edit meta (directly on
 * main), so an author's copy never diverges — sync just fast-forwards it.
 *
 * All multi-document sequences here run under the server's process-wide write mutex, so during a merge
 * nothing else writes main: the re-diff sees a stable snapshot and the guarded ops can't be undercut —
 * that is what makes the merge effectively all-or-nothing without transactions.
 */
import type { Actor } from "./actor";
import type { DbHandle, TopicDoc, TopicSnapshot } from "./db";
import { appendRevision } from "./history";
import { MAIN, snapshotOf, type ManifestStore } from "./store";

export type ChangeClass = "add" | "edit" | "delete" | "conflict";
export type ConflictKind = "edit/edit" | "add/add" | "delete/edit" | "edit/delete";

/** One item in the proposal/conflict view — the author-facing shape. */
export interface Change {
  key: string;
  class: ChangeClass;
  conflictKind?: ConflictKind;
  path: string[];
  title: string;
  mine: TopicSnapshot | null; // null = the author deleted it
  theirs: TopicSnapshot | null; // null = absent on main
}

export interface SyncResult {
  merged: number; // == pulled (kept for the existing toast, which reads `merged`/`conflicted`)
  conflicted: number;
  pulled: number;
  conflicts: Change[];
}

type Cls =
  | "unchanged"
  | "add"
  | "edit"
  | "delete"
  | "conflict"
  | "converged" // mine == theirs but base differs → just rebase base
  | "pull-new" // main gained a topic since the fork
  | "pull-edit" // main edited a topic the author hasn't touched
  | "pull-delete" // main deleted a topic the author hasn't touched
  | "drop-tombstone"; // author's tombstone but main is already absent

interface Item {
  key: string;
  cls: Cls;
  conflictKind?: ConflictKind;
  mine: TopicDoc | null;
  theirs: TopicDoc | null;
  base: string | null;
}

/** Classify one key from its three facts. Exhaustive over the merge table. */
function classify(key: string, mine: TopicDoc | null, theirs: TopicDoc | null): Item {
  const base = mine ? mine.baseHash : null;
  const item = (cls: Cls, conflictKind?: ConflictKind): Item =>
    conflictKind ? { key, cls, conflictKind, mine, theirs, base } : { key, cls, mine, theirs, base };

  if (!mine) return item(theirs ? "pull-new" : "unchanged"); // only-on-main → pull it in

  if (!mine.deleted) {
    // mine is LIVE
    if (base === null) {
      // added in this workspace
      if (!theirs) return item("add");
      return theirs.hash === mine.hash ? item("converged") : item("conflict", "add/add");
    }
    const mineChanged = mine.hash !== base;
    if (!theirs) return mineChanged ? item("conflict", "edit/delete") : item("pull-delete");
    const theirsChanged = theirs.hash !== base;
    if (!mineChanged && !theirsChanged) return item("unchanged");
    if (mineChanged && !theirsChanged) return item("edit");
    if (!mineChanged && theirsChanged) return item("pull-edit");
    return theirs.hash === mine.hash ? item("converged") : item("conflict", "edit/edit");
  }

  // mine is a TOMBSTONE
  if (base === null || !theirs) return item("drop-tombstone"); // never on main, or already gone
  return theirs.hash === base ? item("delete") : item("conflict", "delete/edit");
}

/** Classify every key in union(user docs incl tombstones, main live docs). */
async function classifyWorkspace(db: DbHandle, ws: string): Promise<Item[]> {
  const [userDocs, mainDocs] = await Promise.all([
    db.topics.find({ workspace: ws }).toArray(),
    db.topics.find({ workspace: MAIN, deleted: false }).toArray(),
  ]);
  const mine = new Map(userDocs.map((d) => [d.key, d]));
  const theirs = new Map(mainDocs.map((d) => [d.key, d]));
  const keys = new Set([...mine.keys(), ...theirs.keys()]);
  return [...keys].map((key) => classify(key, mine.get(key) ?? null, theirs.get(key) ?? null)).sort((a, b) => a.key.localeCompare(b.key));
}

function toChange(it: Item): Change {
  const src = it.mine && !it.mine.deleted ? it.mine : (it.theirs ?? it.mine);
  const change: Change = {
    key: it.key,
    class: (it.cls === "conflict" ? "conflict" : it.cls) as ChangeClass,
    path: src?.path ?? it.key.split("/").slice(0, -1),
    title: src?.title ?? it.key,
    mine: it.mine && !it.mine.deleted ? snapshotOf(it.mine) : null,
    theirs: it.theirs ? snapshotOf(it.theirs) : null,
  };
  if (it.conflictKind) change.conflictKind = it.conflictKind;
  return change;
}

/** The author's changes vs main (add/edit/delete) plus conflicts — the proposal diff. */
export async function diffWorkspace(db: DbHandle, ws: string): Promise<Change[]> {
  const items = await classifyWorkspace(db, ws);
  return items.filter((i) => i.cls === "add" || i.cls === "edit" || i.cls === "delete" || i.cls === "conflict").map(toChange);
}

/** Roll a change list into the counts the proposal card shows. */
export function summarize(changes: Change[]): { added: number; edited: number; deleted: number; conflicted: number } {
  return {
    added: changes.filter((c) => c.class === "add").length,
    edited: changes.filter((c) => c.class === "edit").length,
    deleted: changes.filter((c) => c.class === "delete").length,
    conflicted: changes.filter((c) => c.class === "conflict").length,
  };
}

/** Copy a main doc into the user workspace (a pull or a "take theirs"), keyed to `base`. */
async function copyIntoUser(db: DbHandle, ws: string, main: TopicDoc, actor: Actor, base: string): Promise<void> {
  await db.topics.updateOne(
    { workspace: ws, key: main.key },
    {
      $set: {
        workspace: ws,
        key: main.key,
        path: main.path,
        id: main.id,
        title: main.title,
        kind: main.kind,
        questions: main.questions,
        hash: main.hash,
        baseHash: base,
        deleted: false,
        updatedAt: new Date(),
        updatedBy: actor.email,
      },
    },
    { upsert: true },
  );
}

/**
 * Sync main into a user workspace: untouched topics fast-forward (including deletes), new-in-main topics
 * are copied in, converged topics rebase their base, both-modified topics are reported as conflicts (to
 * resolve, not applied). Meta fast-forwards too. Response is a superset of the old `{merged,conflicted}`.
 */
export async function syncFromMain(db: DbHandle, store: ManifestStore, ws: string, actor: Actor): Promise<SyncResult> {
  const items = await classifyWorkspace(db, ws);
  const conflicts: Change[] = [];
  let pulled = 0;
  for (const it of items) {
    switch (it.cls) {
      case "pull-new":
      case "pull-edit":
        if (it.theirs) {
          await copyIntoUser(db, ws, it.theirs, actor, it.theirs.hash);
          pulled++;
        }
        break;
      case "pull-delete":
      case "drop-tombstone":
        await db.topics.deleteOne({ workspace: ws, key: it.key });
        if (it.cls === "pull-delete") pulled++;
        break;
      case "converged":
        if (it.theirs) await db.topics.updateOne({ workspace: ws, key: it.key }, { $set: { baseHash: it.theirs.hash } });
        break;
      case "conflict":
        conflicts.push(toChange(it));
        break;
      default:
        break; // add / edit / delete / unchanged: the author's own state, left as-is
    }
  }
  const main = await store.getWorkspace(MAIN);
  if (main) {
    await db.workspaces.updateOne(
      { _id: ws },
      { $set: { meta: main.meta, metaHash: main.metaHash, baseMetaHash: main.metaHash, lastSyncedAt: new Date(), updatedAt: new Date() } },
    );
  }
  await appendRevision(db, {
    workspace: ws,
    actor,
    action: "sync",
    message: `synced from main — ${String(pulled)} pulled, ${String(conflicts.length)} conflict(s)`,
  });
  return { merged: pulled, conflicted: conflicts.length, pulled, conflicts };
}

export type MergeResult = { ok: true; merged: number } | { ok: false; conflicts: Change[] };

/**
 * Merge a user workspace INTO main (admin action, all-or-nothing). Re-diffs against main now; ANY
 * conflict aborts with the conflict list (the author must sync + resolve first). Otherwise each clean
 * change is applied to main with a hash-guarded op, a revision is recorded, and the author's fork is
 * rebased (baseHash caught up, tombstones dropped) so a follow-up diff is empty.
 */
export async function mergeToMain(db: DbHandle, ws: string, actor: Actor): Promise<MergeResult> {
  const items = await classifyWorkspace(db, ws);
  const conflicts = items.filter((i) => i.cls === "conflict");
  if (conflicts.length) return { ok: false, conflicts: conflicts.map(toChange) };

  let merged = 0;
  for (const it of items) {
    if (it.cls === "add" || it.cls === "edit") {
      if (!it.mine) continue;
      const content = {
        workspace: MAIN,
        key: it.key,
        path: it.mine.path,
        id: it.mine.id,
        title: it.mine.title,
        kind: it.mine.kind,
        questions: it.mine.questions,
        hash: it.mine.hash,
        baseHash: null,
        deleted: false,
        updatedAt: new Date(),
        updatedBy: actor.email,
      };
      if (it.cls === "add") {
        await db.topics.updateOne({ workspace: MAIN, key: it.key }, { $set: content }, { upsert: true });
      } else {
        // edit: guard on the fork hash (always non-null for a main-derived edit).
        await db.topics.findOneAndUpdate({ workspace: MAIN, key: it.key, ...(it.base !== null ? { hash: it.base } : {}) }, { $set: content });
      }
      await appendRevision(db, { workspace: MAIN, actor, action: "save", topicKey: it.key, after: snapshotOf(it.mine), message: `merged ${it.cls} ${it.key} from ${ws}` });
      await db.topics.updateOne({ workspace: ws, key: it.key }, { $set: { baseHash: it.mine.hash } });
      merged++;
    } else if (it.cls === "delete") {
      const removed = await db.topics.findOneAndDelete({ workspace: MAIN, key: it.key, ...(it.base !== null ? { hash: it.base } : {}) });
      await appendRevision(db, {
        workspace: MAIN,
        actor,
        action: "delete",
        topicKey: it.key,
        before: removed ? snapshotOf(removed) : null,
        message: `merged delete ${it.key} from ${ws}`,
      });
      await db.topics.deleteOne({ workspace: ws, key: it.key }); // drop the author's tombstone
      merged++;
    }
  }
  await db.workspaces.updateOne({ _id: ws }, { $set: { reviewStatus: "none", lastMergedAt: new Date(), updatedAt: new Date() } });
  await appendRevision(db, { workspace: MAIN, actor, action: "merge", message: `merged ${String(merged)} change(s) from ${ws}` });
  return { ok: true, merged };
}

/**
 * Resolve one conflicted topic. `theirs` copies main's current version into the author's copy (or
 * accepts main's deletion); `mine` keeps the author's content and rebases its base onto main's current
 * hash (turning the conflict into a clean add/edit/delete for the next merge).
 */
export async function resolveConflict(
  db: DbHandle,
  ws: string,
  key: string,
  choose: "mine" | "theirs",
  actor: Actor,
): Promise<boolean> {
  const items = await classifyWorkspace(db, ws);
  const it = items.find((i) => i.key === key && i.cls === "conflict");
  if (!it) return false;

  if (choose === "theirs") {
    if (it.theirs) await copyIntoUser(db, ws, it.theirs, actor, it.theirs.hash);
    else await db.topics.deleteOne({ workspace: ws, key }); // main deleted it → accept the deletion
  } else {
    // keep mine; rebase base onto main's current hash (null when main has none) so it reads as clean.
    await db.topics.updateOne({ workspace: ws, key }, { $set: { baseHash: it.theirs ? it.theirs.hash : null } });
  }
  await appendRevision(db, { workspace: ws, actor, action: "sync", topicKey: key, message: `resolved conflict on ${key} → ${choose}` });
  return true;
}
