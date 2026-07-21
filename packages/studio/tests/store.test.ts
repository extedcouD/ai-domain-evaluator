/**
 * Phase 1 — the Mongo storage layer. Proves the primitives the whole rework rests on: topic CRUD, the
 * hash-guard 409 (optimistic concurrency), node moves that re-key every contained topic, user-workspace
 * tombstones vs main hard-deletes, the unique `{workspace,key}` index (the add/add anchor), and that
 * `listNodes` reproduces the folder reader's shape + DFS order.
 */
import { ObjectId, type DbHandle, type TopicDoc, type WorkspaceMeta } from "../src/db";
import { HashConflict, ManifestStore, topicKeyOf, type TopicInput } from "../src/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { actor, freshDb, startMongo, stopMongo } from "./mongo-helper";

let db: DbHandle;
let store: ManifestStore;

beforeAll(startMongo, 60_000);
afterAll(stopMongo);
beforeEach(async () => {
  db = await freshDb();
  store = new ManifestStore(db);
  await seedWorkspace("main", { id: "test-kb", version: "1.0" });
});
afterEach(() => db.close());

async function seedWorkspace(id: string, meta: WorkspaceMeta): Promise<void> {
  await db.workspaces.insertOne({
    _id: id,
    owner: id === "main" ? null : "u@corp.com",
    createdAt: new Date(),
    updatedAt: new Date(),
    ready: true,
    meta,
    metaHash: store.metaHash(meta),
    baseMetaHash: id === "main" ? null : store.metaHash(meta),
    nodes: [],
    reviewStatus: "none",
    reviewRequestedAt: null,
    reviewNote: null,
    lastSyncedAt: null,
    lastMergedAt: null,
  });
}

const topic = (path: string[], id: string, over: Partial<TopicInput> = {}): TopicInput => ({
  id,
  path,
  title: `Title ${id}`,
  kind: "real",
  questions: ["q one", "q two"],
  ...over,
});

describe("ManifestStore", () => {
  it("creates, reads back, and deletes a topic (main = hard delete)", async () => {
    const { hash } = await store.putTopic("main", topic(["protocol"], "t1"), { actor: actor() });
    const doc = await store.getTopic("main", "protocol/t1");
    expect(doc?.hash).toBe(hash);
    expect(doc?.baseHash).toBe(null);

    const manifest = (await store.manifestWithVersions("main")) as { topics: { id: string }[]; versions: Record<string, string> };
    expect(manifest.topics.map((t) => t.id)).toEqual(["t1"]);
    expect(manifest.versions["protocol/t1"]).toBe(hash);

    const removed = await store.deleteTopic("main", ["protocol"], "t1");
    expect(removed?.id).toBe("t1");
    expect(await store.getTopic("main", "protocol/t1")).toBe(null);
  });

  it("hash-guards a stale save with HashConflict, carrying the current doc", async () => {
    const v1 = (await store.putTopic("main", topic(["protocol"], "race"), { actor: actor() })).hash;
    const v2 = (await store.putTopic("main", topic(["protocol"], "race", { title: "v2" }), { baseVersion: v1, actor: actor() })).hash;
    expect(v2).not.toBe(v1);

    await expect(store.putTopic("main", topic(["protocol"], "race", { title: "v3" }), { baseVersion: v1, actor: actor() })).rejects.toBeInstanceOf(
      HashConflict,
    );
    // A save with the fresh version wins.
    const v3 = await store.putTopic("main", topic(["protocol"], "race", { title: "v3" }), { baseVersion: v2, actor: actor() });
    expect(v3.hash).not.toBe(v2);
  });

  it("a save without a baseVersion skips the optimistic check", async () => {
    await store.putTopic("main", topic(["protocol"], "nov"), { actor: actor() });
    const r = await store.putTopic("main", topic(["protocol"], "nov", { title: "changed" }), { actor: actor() });
    expect(r.hash).toBeTruthy();
  });

  it("renames/moves a topic across paths (old key gone, new present)", async () => {
    await store.putTopic("main", topic(["protocol"], "old"), { actor: actor() });
    await store.putTopic("main", topic(["onboard"], "old"), { previous: { path: ["protocol"], id: "old" }, actor: actor() });
    expect(await store.getTopic("main", "protocol/old")).toBe(null);
    expect((await store.getTopic("main", "onboard/old"))?.id).toBe("old");
  });

  it("moveNode re-keys every contained topic and rewrites its path + hash", async () => {
    await store.putTopic("main", topic(["protocol"], "a"), { actor: actor() });
    await store.putTopic("main", topic(["protocol"], "b"), { actor: actor() });
    await store.putTopic("main", topic(["protocol", "sub"], "c"), { actor: actor() });

    const moved = await store.moveNode("main", ["protocol"], ["spec"], actor());
    expect(moved).toBe(3);
    expect(await store.getTopic("main", "protocol/a")).toBe(null);
    expect((await store.getTopic("main", "spec/a"))?.path).toEqual(["spec"]);
    expect((await store.getTopic("main", "spec/sub/c"))?.path).toEqual(["spec", "sub"]);
  });

  it("moveNode carries an EMPTY subnode (folder marker survives)", async () => {
    await store.createNode("main", ["logistics"]);
    await store.createNode("main", ["logistics", "1.0.0"]);
    await store.moveNode("main", ["logistics"], ["shipping"], actor());
    const nodes = (await store.listNodes("main")).map((n) => n.path.join("/"));
    expect(nodes).toContain("shipping");
    expect(nodes).toContain("shipping/1.0.0");
    expect(nodes).not.toContain("logistics");
  });

  it("listNodes lists nested + empty folders in pre-order DFS with hasTopics", async () => {
    await store.putTopic("main", topic(["retail", "1.2.0", "search"], "a"), { actor: actor() });
    await store.createNode("main", ["logistics"]);
    const nodes = await store.listNodes("main");
    const byPath = new Map(nodes.map((n) => [n.path.join("/"), n.hasTopics]));
    expect(byPath.get("retail/1.2.0/search")).toBe(true);
    expect(byPath.get("retail")).toBe(false);
    expect(byPath.get("logistics")).toBe(false);
    // Pre-order DFS: a parent precedes its children.
    const order = nodes.map((n) => n.path.join("/"));
    expect(order.indexOf("retail")).toBeLessThan(order.indexOf("retail/1.2.0"));
    expect(order.indexOf("retail/1.2.0")).toBeLessThan(order.indexOf("retail/1.2.0/search"));
  });

  it("a user-workspace delete tombstones (main-derived) but hard-deletes an added-here topic", async () => {
    await seedWorkspace("u", { id: "test-kb", version: "1.0" });
    // A main-derived topic (baseHash set) → tombstone on delete.
    await db.topics.insertOne(mkDoc("u", topic(["protocol"], "derived"), "basehash"));
    await store.deleteTopic("u", ["protocol"], "derived");
    const t = await store.getTopic("u", "protocol/derived");
    expect(t?.deleted).toBe(true);
    expect((await store.liveTopics("u")).length).toBe(0);

    // A topic added in this workspace (baseHash null) → hard delete.
    await store.putTopic("u", topic(["protocol"], "added"), { actor: actor() });
    await store.deleteTopic("u", ["protocol"], "added");
    expect(await store.getTopic("u", "protocol/added")).toBe(null);
  });

  it("the unique {workspace,key} index rejects an add/add collision", async () => {
    await db.topics.insertOne(mkDoc("main", topic(["protocol"], "dup"), null));
    await expect(db.topics.insertOne(mkDoc("main", topic(["protocol"], "dup"), null))).rejects.toMatchObject({ code: 11000 });
  });
});

function mkDoc(ws: string, t: TopicInput, baseHash: string | null): TopicDoc {
  return {
    _id: new ObjectId(),
    workspace: ws,
    key: topicKeyOf(t),
    path: t.path,
    id: t.id,
    title: t.title,
    kind: t.kind,
    questions: t.questions,
    hash: store.topicHash(t),
    baseHash,
    deleted: false,
    updatedAt: new Date(),
    updatedBy: "seed@corp.com",
  };
}
