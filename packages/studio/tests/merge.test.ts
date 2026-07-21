/**
 * Phase 4 — the three-way merge engine. Exercises each classification row (add/edit/delete, the four
 * conflict kinds, converged, and the pull-* fast-forwards), the all-or-nothing merge under a concurrent
 * admin edit, the sync → resolve → re-merge round trip, and folder-rename-as-(delete+add).
 */
import type { DbHandle, WorkspaceMeta } from "../src/db";
import { diffWorkspace, mergeToMain, resolveConflict, syncFromMain } from "../src/merge";
import { ManifestStore, topicKeyOf, type TopicInput } from "../src/store";
import { ensureUserWorkspace } from "../src/workspaces";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshDb, startMongo, stopMongo } from "./mongo-helper";

let db: DbHandle;
let store: ManifestStore;
let ws: string;

const ALICE = { name: "Alice", email: "alice@corp.com" }; // admin, edits main
const BOB = { name: "Bob", email: "bob@corp.com" }; // author, owns `ws`

beforeAll(startMongo, 60_000);
afterAll(stopMongo);
beforeEach(async () => {
  db = await freshDb();
  store = new ManifestStore(db);
  const meta: WorkspaceMeta = { id: "test-kb", version: "1.0" };
  await db.workspaces.insertOne({
    _id: "main",
    owner: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ready: true,
    meta,
    metaHash: store.metaHash(meta),
    baseMetaHash: null,
    nodes: [],
    reviewStatus: "none",
    reviewRequestedAt: null,
    reviewNote: null,
    lastSyncedAt: null,
    lastMergedAt: null,
  });
});
afterEach(() => db.close());

const t = (path: string[], id: string, over: Partial<TopicInput> = {}): TopicInput => ({ id, path, title: `Title ${id}`, kind: "real", questions: ["a", "b"], ...over });
const onMain = (topic: TopicInput) => store.putTopic("main", topic, { actor: ALICE });
const onWs = (topic: TopicInput, previous?: { path: string[]; id: string }) => store.putTopic(ws, topic, previous ? { actor: BOB, previous } : { actor: BOB });

/** Seed main topics then clone Bob's workspace from it. */
async function fork(...topics: TopicInput[]): Promise<void> {
  for (const topic of topics) await onMain(topic);
  ws = await ensureUserWorkspace(db, store, BOB);
}

const classOf = (changes: { key: string; class: string; conflictKind?: string }[], key: string) => changes.find((c) => c.key === key);
const mainKeys = async (): Promise<string[]> => (await store.liveTopics("main")).map((d) => d.key).sort();

describe("merge classification + operations", () => {
  it("clean add / edit / delete flow through diff and merge to main", async () => {
    await fork(t(["a"], "keep"), t(["a"], "edit-me"), t(["a"], "del-me"));
    await onWs(t(["a"], "added")); // add
    await onWs(t(["a"], "edit-me", { title: "changed" })); // edit
    await store.deleteTopic(ws, ["a"], "del-me"); // delete (tombstone)

    const diff = await diffWorkspace(db, ws);
    expect(classOf(diff, "a/added")?.class).toBe("add");
    expect(classOf(diff, "a/edit-me")?.class).toBe("edit");
    expect(classOf(diff, "a/del-me")?.class).toBe("delete");

    const res = await mergeToMain(db, ws, BOB);
    expect(res.ok).toBe(true);
    expect(await mainKeys()).toEqual(["a/added", "a/edit-me", "a/keep"]);
    expect((await store.getTopic("main", "a/edit-me"))?.title).toBe("changed");
    // After merge the author's fork is rebased: a re-diff is empty.
    expect(await diffWorkspace(db, ws)).toHaveLength(0);
  });

  it("edit/edit conflict blocks an all-or-nothing merge (nothing lands)", async () => {
    await fork(t(["a"], "x"), t(["a"], "y"));
    await onWs(t(["a"], "x", { title: "bob" })); // bob edits x
    await onWs(t(["a"], "newly-added")); // and adds one cleanly
    await onMain(t(["a"], "x", { title: "alice" })); // admin edits x → conflict

    const diff = await diffWorkspace(db, ws);
    expect(classOf(diff, "a/x")?.conflictKind).toBe("edit/edit");

    const res = await mergeToMain(db, ws, BOB);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflicts.map((c) => c.key)).toContain("a/x");
    // All-or-nothing: the clean add did NOT land on main.
    expect(await store.getTopic("main", "a/newly-added")).toBe(null);
  });

  it("add/add and converged are distinguished by content", async () => {
    await fork(t(["a"], "base"));
    // add/add, different content → conflict
    await onWs(t(["a"], "dup", { title: "bob" }));
    await onMain(t(["a"], "dup", { title: "alice" }));
    // add/add, identical content → converged (not a conflict)
    await onWs(t(["a"], "same", { title: "shared" }));
    await onMain(t(["a"], "same", { title: "shared" }));

    const diff = await diffWorkspace(db, ws);
    expect(classOf(diff, "a/dup")?.conflictKind).toBe("add/add");
    expect(classOf(diff, "a/same")).toBeUndefined(); // converged is not a change
  });

  it("delete/edit and edit/delete are conflicts", async () => {
    await fork(t(["a"], "d"), t(["a"], "e"));
    await store.deleteTopic(ws, ["a"], "d"); // bob deletes d
    await onMain(t(["a"], "d", { title: "alice" })); // admin edits d → delete/edit
    await onWs(t(["a"], "e", { title: "bob" })); // bob edits e
    await store.deleteTopic("main", ["a"], "e"); // admin deletes e → edit/delete

    const diff = await diffWorkspace(db, ws);
    expect(classOf(diff, "a/d")?.conflictKind).toBe("delete/edit");
    expect(classOf(diff, "a/e")?.conflictKind).toBe("edit/delete");
  });

  it("sync fast-forwards untouched topics (pull new/edit/delete)", async () => {
    await fork(t(["a"], "stable"), t(["a"], "will-edit"), t(["a"], "will-del"));
    // Main moves on; bob has touched none of these.
    await onMain(t(["a"], "brand-new"));
    await onMain(t(["a"], "will-edit", { title: "main-edit" }));
    await store.deleteTopic("main", ["a"], "will-del");

    const result = await syncFromMain(db, store, ws, BOB);
    expect(result.conflicted).toBe(0);
    expect(result.pulled).toBe(3);
    const keys = (await store.liveTopics(ws)).map((d) => d.key).sort();
    expect(keys).toEqual(["a/brand-new", "a/stable", "a/will-edit"]);
    expect((await store.getTopic(ws, "a/will-edit"))?.title).toBe("main-edit");
  });

  it("sync → resolve(mine) → re-merge lands the author's version", async () => {
    await fork(t(["a"], "x"));
    await onWs(t(["a"], "x", { title: "bob" }));
    await onMain(t(["a"], "x", { title: "alice" }));

    // Merge blocked by conflict.
    expect((await mergeToMain(db, ws, BOB)).ok).toBe(false);
    // Sync surfaces the conflict…
    const sync = await syncFromMain(db, store, ws, BOB);
    expect(sync.conflicts.map((c) => c.key)).toContain("a/x");
    // …author keeps theirs, then merge succeeds and main takes bob's title.
    expect(await resolveConflict(db, ws, "a/x", "mine", BOB)).toBe(true);
    const merged = await mergeToMain(db, ws, BOB);
    expect(merged.ok).toBe(true);
    expect((await store.getTopic("main", "a/x"))?.title).toBe("bob");
  });

  it("sync → resolve(theirs) discards the author's edit", async () => {
    await fork(t(["a"], "x"));
    await onWs(t(["a"], "x", { title: "bob" }));
    await onMain(t(["a"], "x", { title: "alice" }));
    await syncFromMain(db, store, ws, BOB);
    expect(await resolveConflict(db, ws, "a/x", "theirs", BOB)).toBe(true);
    // The conflict is gone and merge is a no-op for x (main keeps alice's title).
    expect(await diffWorkspace(db, ws)).toHaveLength(0);
    expect((await store.getTopic(ws, "a/x"))?.title).toBe("alice");
  });

  it("a folder rename in a user workspace merges as delete-old + add-new", async () => {
    await fork(t(["old"], "a"), t(["old"], "b"));
    const moved = await store.moveNode(ws, ["old"], ["new"], BOB);
    expect(moved).toBe(2);

    const diff = await diffWorkspace(db, ws);
    expect(classOf(diff, "old/a")?.class).toBe("delete");
    expect(classOf(diff, "new/a")?.class).toBe("add");

    const res = await mergeToMain(db, ws, BOB);
    expect(res.ok).toBe(true);
    expect(await mainKeys()).toEqual(["new/a", "new/b"]);
    expect(topicKeyOf({ path: ["new"], id: "a" })).toBe("new/a"); // sanity on the key form
  });
});
