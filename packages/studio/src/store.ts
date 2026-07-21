/**
 * ManifestStore — topic/meta/node CRUD over Mongo, the read+write surface the server sits on.
 *
 * Every write is a single-document atomic op guarded by a content hash, so an optimistic-concurrency
 * clash surfaces as a `HashConflict` (→ 409) instead of a lost update — this is what closes the old
 * check-then-write race the git store had. Multi-document sequences (clone, sync, merge) live in
 * `merge.ts`/`workspaces.ts` under the shared process mutex; this module's methods are the primitives
 * they compose.
 *
 * The manifest a workspace serves is ASSEMBLED through core's Zod gate (`assembleManifest`), exactly as
 * the folder reader was, so a workspace can never serve a manifest the engine would reject. Reads never
 * lock; the server serializes writes.
 */
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";

import type { Manifest, Topic } from "@evaluator/core";

import type { Actor } from "./actor";
import type { DbHandle, TopicDoc, TopicKind, TopicSnapshot, WorkspaceDoc, WorkspaceMeta } from "./db";
import { assembleManifest } from "./manifest-folder";

/** The canonical workspace id. */
export const MAIN = "main";

/** Raised when a guarded write loses a race — carries the current on-store doc for the 409 body. */
export class HashConflict extends Error {
  constructor(public readonly current: TopicDoc) {
    super("this topic changed since you opened it");
  }
}

/** A plain topic (no db fields) — what the manifest is assembled from and the API speaks. */
export interface TopicInput {
  id: string;
  path: string[];
  title: string;
  kind: TopicKind;
  questions: string[];
}

/** `[...path, id].join("/")` — the stable per-workspace identity a merge joins on. */
export function topicKeyOf(t: { path: string[]; id: string }): string {
  return [...t.path, t.id].join("/");
}

/** A topic doc (or input) as the plain `Topic` the API/manifest use. */
export function docToTopic(d: TopicInput): Topic {
  return { id: d.id, path: d.path, title: d.title, kind: d.kind, questions: d.questions };
}

/** A restorable snapshot of a topic doc (stored on delete/edit revisions). */
export function snapshotOf(d: TopicDoc): TopicSnapshot {
  return { key: d.key, path: d.path, id: d.id, title: d.title, kind: d.kind, questions: d.questions, hash: d.hash };
}

/** Does `path` sit at or under `prefix`? (`[]` matches everything.) */
function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((seg, i) => seg === path[i]);
}

/** Pre-order DFS ordering over segment paths: a parent sorts before its children, siblings lexically. */
function cmpPathDfs(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = (a[i] as string).localeCompare(b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Atomic write via temp-file + rename, so a reader (or a crash) never sees a half-written export. */
export function atomicWrite(file: string, contents: string): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export class ManifestStore {
  constructor(private readonly db: DbHandle) {}

  /** The content hash of a topic — the optimistic-concurrency token. Order-stable field list. */
  topicHash(t: TopicInput): string {
    const ordered = { id: t.id, path: t.path, title: t.title, kind: t.kind, questions: t.questions };
    return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
  }

  /** The content hash of a workspace's manifest identity — the token for meta merge/concurrency. */
  metaHash(meta: WorkspaceMeta): string {
    const ordered = { id: meta.id, version: meta.version, subject: meta.subject ?? null, levels: meta.levels ?? null };
    return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
  }

  // ---- reads ------------------------------------------------------------------------------------

  getWorkspace(ws: string): Promise<WorkspaceDoc | null> {
    return this.db.workspaces.findOne({ _id: ws });
  }

  getTopic(ws: string, key: string): Promise<TopicDoc | null> {
    return this.db.topics.findOne({ workspace: ws, key });
  }

  /** All non-deleted topics in a workspace. */
  liveTopics(ws: string): Promise<TopicDoc[]> {
    return this.db.topics.find({ workspace: ws, deleted: false }).toArray();
  }

  /** Every topic doc in a workspace INCLUDING tombstones — the merge input. */
  allTopics(ws: string): Promise<TopicDoc[]> {
    return this.db.topics.find({ workspace: ws }).toArray();
  }

  /** Live topic count anywhere under a path prefix — used to gate node deletes/moves. */
  async subtreeTopicCount(ws: string, prefix: string[]): Promise<number> {
    const docs = await this.liveTopics(ws);
    return docs.filter((d) => pathStartsWith(d.path, prefix)).length;
  }

  /**
   * The workspace's manifest, assembled through core's Zod gate (so it can never serve a manifest the
   * engine would reject). Throws `ConfigError` (→ 422) exactly as the folder reader did when the
   * assembled set is invalid (e.g. empty). Returns the topics in a deterministic order for stable export.
   */
  async assembledManifest(ws: string): Promise<Manifest> {
    const wsDoc = await this.getWorkspace(ws);
    const meta = wsDoc?.meta ?? { id: "kb", version: "0" };
    const topics = await this.liveTopics(ws);
    topics.sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")) || a.id.localeCompare(b.id));
    return assembleManifest({ ...meta }, topics.map(docToTopic));
  }

  /** The assembled manifest plus a `versions` map (key → hash) the UI echoes back as `baseVersion`. */
  async manifestWithVersions(ws: string): Promise<Record<string, unknown>> {
    const manifest = await this.assembledManifest(ws);
    const topics = await this.liveTopics(ws);
    const versions: Record<string, string> = {};
    for (const d of topics) versions[d.key] = d.hash;
    return { ...manifest, versions };
  }

  /**
   * The taxonomy nodes (folders) in a workspace: the union of every topic's ancestor paths and the
   * explicitly-created empty folders, in pre-order DFS. `hasTopics` is whether a live topic sits
   * DIRECTLY in that folder. Byte-compatible with the old folder `listNodes` (shape + order).
   */
  async listNodes(ws: string): Promise<{ path: string[]; hasTopics: boolean }[]> {
    const [wsDoc, topics] = await Promise.all([this.getWorkspace(ws), this.liveTopics(ws)]);
    const dirs = new Map<string, string[]>();
    const withTopics = new Set<string>();
    const addPrefixes = (p: string[]): void => {
      for (let i = 1; i <= p.length; i++) {
        const pre = p.slice(0, i);
        dirs.set(pre.join("/"), pre);
      }
    };
    for (const t of topics) {
      addPrefixes(t.path);
      withTopics.add(t.path.join("/"));
    }
    for (const n of wsDoc?.nodes ?? []) addPrefixes(n);
    return [...dirs.values()]
      .sort(cmpPathDfs)
      .map((path) => ({ path, hasTopics: withTopics.has(path.join("/")) }));
  }

  // ---- topic writes -----------------------------------------------------------------------------

  /**
   * Create/update a topic (optionally a rename/move via `previous`). Guarded by `baseVersion`: if the
   * caller edited from a version that has since moved, throws `HashConflict` with the current doc.
   * Returns the new content hash. In a user workspace a rename tombstones the old key and adds the new
   * one (`baseHash:null`) — "folder rename = delete + add", so a merge degrades it to delete/edit rather
   * than tracking renames.
   */
  async putTopic(
    ws: string,
    topic: TopicInput,
    opts: { previous?: { path: string[]; id: string } | null; baseVersion?: string | null; actor: Actor },
  ): Promise<{ hash: string; renamedFrom: string | null }> {
    const key = topicKeyOf(topic);
    const hash = this.topicHash(topic);
    const now = new Date();
    const previous = opts.previous ?? null;
    const previousKey = previous ? topicKeyOf(previous) : null;
    const isRename = previousKey !== null && previousKey !== key;
    const checkKey = isRename ? previousKey : key;
    const baseVersion = opts.baseVersion ?? null;

    // Optimistic concurrency: only bites when the caller sent the version it edited from AND a live doc
    // at that key has since moved. A missing doc (a fresh add) skips the check, matching the old server.
    if (baseVersion !== null) {
      const atCheck = await this.getTopic(ws, checkKey);
      if (atCheck && !atCheck.deleted && atCheck.hash !== baseVersion) throw new HashConflict(atCheck);
    }

    const content = { path: topic.path, id: topic.id, title: topic.title, kind: topic.kind, questions: topic.questions, hash };
    const existingAtKey = isRename ? await this.getTopic(ws, key) : await this.getTopic(ws, checkKey);

    if (existingAtKey && !existingAtKey.deleted && !isRename) {
      // A plain edit of a live doc — atomically guarded when a baseVersion was supplied, so two
      // concurrent tabs can't both win. baseHash is left untouched (an edit stays keyed to its fork).
      if (baseVersion !== null) {
        const res = await this.db.topics.findOneAndUpdate(
          { _id: existingAtKey._id, hash: baseVersion },
          { $set: { ...content, deleted: false, updatedAt: now, updatedBy: opts.actor.email } },
        );
        if (!res) {
          const cur = await this.getTopic(ws, key);
          if (cur) throw new HashConflict(cur);
          // The doc vanished under us (concurrent delete) — fall through to a fresh insert below.
          await this.insertOrRevive(ws, key, content, now, opts.actor.email);
        }
      } else {
        await this.db.topics.updateOne(
          { _id: existingAtKey._id },
          { $set: { ...content, deleted: false, updatedAt: now, updatedBy: opts.actor.email } },
        );
      }
    } else {
      // A new key, or reviving a tombstone at this key: upsert. A genuine insert gets baseHash null; a
      // revive keeps the existing baseHash (it is still keyed to whatever main forked from).
      await this.insertOrRevive(ws, key, content, now, opts.actor.email);
    }

    if (isRename) await this.removeAt(ws, checkKey);
    return { hash, renamedFrom: isRename ? checkKey : null };
  }

  /** Insert a fresh topic (baseHash null) or revive a tombstone at `key`, preserving its baseHash. */
  private async insertOrRevive(
    ws: string,
    key: string,
    content: { path: string[]; id: string; title: string; kind: TopicKind; questions: string[]; hash: string },
    now: Date,
    by: string,
  ): Promise<void> {
    await this.db.topics.updateOne(
      { workspace: ws, key },
      {
        $set: { workspace: ws, key, ...content, deleted: false, updatedAt: now, updatedBy: by },
        $setOnInsert: { baseHash: null },
      },
      { upsert: true },
    );
  }

  /**
   * Remove a topic at `key`: a hard delete on main or for a topic added in this ws (baseHash null),
   * otherwise a tombstone so a user's deletion can propagate to main on merge. Returns the pre-removal
   * doc (for a revision `before`), or null when nothing live was there.
   */
  async removeAt(ws: string, key: string): Promise<TopicDoc | null> {
    const doc = await this.getTopic(ws, key);
    if (!doc || doc.deleted) return null;
    if (ws === MAIN || doc.baseHash === null) {
      await this.db.topics.deleteOne({ _id: doc._id });
    } else {
      await this.db.topics.updateOne({ _id: doc._id }, { $set: { deleted: true, updatedAt: new Date() } });
    }
    return doc;
  }

  /** Delete a topic by coordinates. Returns the removed doc, or null when it wasn't there (→ 404). */
  deleteTopic(ws: string, path: string[], id: string): Promise<TopicDoc | null> {
    return this.removeAt(ws, topicKeyOf({ path, id }));
  }

  // ---- meta -------------------------------------------------------------------------------------

  /** Update a workspace's manifest identity. `baseMetaHash` is left untouched (an edit stays keyed to its fork). */
  async putMeta(ws: string, meta: WorkspaceMeta): Promise<void> {
    await this.db.workspaces.updateOne(
      { _id: ws },
      { $set: { meta, metaHash: this.metaHash(meta), updatedAt: new Date() } },
    );
  }

  // ---- nodes (taxonomy folders) -----------------------------------------------------------------

  /** Create an (empty) taxonomy folder so it lists before it has topics. */
  async createNode(ws: string, path: string[]): Promise<void> {
    await this.db.workspaces.updateOne({ _id: ws }, { $addToSet: { nodes: path }, $set: { updatedAt: new Date() } });
  }

  /**
   * Move a folder subtree `from`→`to`, re-pathing every contained topic (its hash changes with its path).
   * In a user workspace each moved topic becomes tombstone-old + add-new (via `putTopic`+`previous`), so
   * a merge sees deletes and adds — the "folder rename degrades to delete/edit" rule. Returns the count moved.
   */
  async moveNode(ws: string, from: string[], to: string[], actor: Actor): Promise<number> {
    const live = await this.liveTopics(ws);
    const under = live.filter((d) => pathStartsWith(d.path, from));
    for (const d of under) {
      const newPath = [...to, ...d.path.slice(from.length)];
      await this.putTopic(ws, { ...docToTopic(d), path: newPath }, { previous: { path: d.path, id: d.id }, actor });
    }
    // Re-key the explicit (possibly empty) folders too, so an empty subtree survives the move: any node
    // at/under `from` is rewritten with the `to` prefix; the rest are left as-is.
    const wsDoc = await this.getWorkspace(ws);
    const rekeyed = (wsDoc?.nodes ?? []).map((n) => (pathStartsWith(n, from) ? [...to, ...n.slice(from.length)] : n));
    const seen = new Set<string>();
    const nodes: string[][] = [];
    for (const n of [...rekeyed, to]) {
      const k = n.join("/");
      if (!seen.has(k)) {
        seen.add(k);
        nodes.push(n);
      }
    }
    await this.db.workspaces.updateOne({ _id: ws }, { $set: { nodes, updatedAt: new Date() } });
    return under.length;
  }

  /**
   * Delete a folder: an empty one just drops the marker; a populated one requires `cascade` (the server
   * gates on a type-to-confirm token). Returns removed docs so the caller can log a revision per topic
   * (keeping each restorable from Trash).
   */
  async deleteNode(ws: string, path: string[], cascade: boolean): Promise<TopicDoc[]> {
    const live = await this.liveTopics(ws);
    const under = live.filter((d) => pathStartsWith(d.path, path));
    const removed: TopicDoc[] = [];
    if (cascade) {
      for (const d of under) {
        const doc = await this.removeAt(ws, d.key);
        if (doc) removed.push(doc);
      }
    }
    // Drop the folder markers at/under `path`.
    const wsDoc = await this.getWorkspace(ws);
    const nodes = (wsDoc?.nodes ?? []).filter((n) => !pathStartsWith(n, path));
    await this.db.workspaces.updateOne({ _id: ws }, { $set: { nodes, updatedAt: new Date() } });
    return removed;
  }
}
