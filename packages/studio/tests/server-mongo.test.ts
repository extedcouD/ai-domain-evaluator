/**
 * Phase 2 — the server on Mongo, single-user (everyone on `main`). Ports the old `server.test.ts`
 * contract to the Mongo store: manifest read, topic CRUD, optimistic-concurrency 409, meta, nodes
 * (create/move/cascade), export, coverage, and history/restore — all wire shapes unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest } from "@evaluator/core";
import { parse as parseYaml } from "yaml";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { req, startStudio, teardown, topic, type Studio } from "./server-helper";
import { startMongo, stopMongo } from "./mongo-helper";

beforeAll(startMongo, 60_000);
afterAll(stopMongo);
afterEach(teardown);

interface ManifestResp {
  id: string;
  version: string;
  subject?: string;
  levels?: string[];
  topics: { id: string; path: string[]; kind: string }[];
  versions: Record<string, string>;
}

function seedReport(coverageDir: string, file: string, generatedAt: string): void {
  writeFileSync(
    join(coverageDir, file),
    JSON.stringify({
      generatedAt,
      manifestId: "test-kb",
      manifestVersion: "1.0",
      source: "fake-model",
      totals: { topics: 1, real: 1, canary: 0 },
      metrics: { groundedRate: 1, refusalRate: 0, inconsistencyRate: 0, canaryBiteRate: 0 },
      topics: [{ key: "protocol/t1", id: "t1", path: ["protocol"], title: "T1", kind: "real", status: "grounded", agreement: 1, sample: "s", detail: "d" }],
      judge: { schemaEnforced: true, warnings: [] },
      caveats: ["measures coverage, not correctness"],
    }),
  );
}

async function withSeed(): Promise<Studio> {
  return startStudio({ seed: (store) => store.putTopic("main", topic(["protocol"], "seed-a"), { actor: { name: "s", email: "studio@localhost" } }).then(() => undefined) });
}

describe("KB Studio server (Mongo, single-user)", () => {
  it("GET / serves the HTML shell", async () => {
    const s = await withSeed();
    const res = await fetch(s.base + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("KB Studio");
  });

  it("whoami reports admin on main in single-user mode", async () => {
    const s = await withSeed();
    const { json } = await req<{ role: string; workspace: string; review: boolean }>(s.base, "GET", "/api/whoami");
    expect(json).toMatchObject({ role: "admin", workspace: "main", review: false });
  });

  it("GET /api/manifest assembles the workspace into a validated manifest with versions", async () => {
    const s = await startStudio({
      seed: async (store) => {
        await store.putTopic("main", topic(["protocol"], "real-a"), { actor: { name: "s", email: "studio@localhost" } });
        await store.putTopic("main", topic(["protocol"], "canary-x", { kind: "canary" }), { actor: { name: "s", email: "studio@localhost" } });
      },
    });
    const { status, json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(status).toBe(200);
    expect(json.id).toBe("test-kb");
    expect(json.topics.map((t) => t.id).sort()).toEqual(["canary-x", "real-a"]);
    expect(json.versions["protocol/real-a"]).toBeTruthy();
  });

  it("POST /api/topics creates a nested-path topic reflected by GET /api/manifest", async () => {
    const s = await withSeed();
    const t = { id: "new-one", path: ["retail", "1.2.0", "search"], title: "New", kind: "real", questions: ["a", "b"] };
    expect((await req(s.base, "POST", "/api/topics", { topic: t })).status).toBe(200);
    const { json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(json.topics.find((x) => x.id === "new-one")?.path).toEqual(["retail", "1.2.0", "search"]);
  });

  it("POST /api/topics with `previous` moves across paths", async () => {
    const s = await startStudio({ seed: (store) => store.putTopic("main", topic(["protocol"], "old-id"), { actor: { name: "s", email: "studio@localhost" } }).then(() => undefined) });
    const t = { id: "old-id", path: ["onboard"], title: "Moved", kind: "real", questions: ["a", "b"] };
    expect((await req(s.base, "POST", "/api/topics", { topic: t, previous: { path: ["protocol"], id: "old-id" } })).status).toBe(200);
    const { json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(json.topics.map((x) => `${x.path.join("/")}/${x.id}`)).toEqual(["onboard/old-id"]);
  });

  it("optimistic concurrency: a stale baseVersion is 409'd with the current copy; a fresh one wins", async () => {
    const s = await startStudio({ seed: (store) => store.putTopic("main", topic(["protocol"], "race"), { actor: { name: "s", email: "studio@localhost" } }).then(() => undefined) });
    const v0 = (await req<ManifestResp>(s.base, "GET", "/api/manifest")).json.versions["protocol/race"];

    const first = await req<{ version: string }>(s.base, "POST", "/api/topics", { topic: topic(["protocol"], "race", { title: "v2" }), baseVersion: v0 });
    expect(first.status).toBe(200);
    expect(first.json.version).not.toBe(v0);

    const stale = await req<{ currentVersion: string; current: { title: string } }>(s.base, "POST", "/api/topics", { topic: topic(["protocol"], "race", { title: "v3" }), baseVersion: v0 });
    expect(stale.status).toBe(409);
    expect(stale.json.currentVersion).toBe(first.json.version);
    expect(stale.json.current.title).toBe("v2");

    const retry = await req(s.base, "POST", "/api/topics", { topic: topic(["protocol"], "race", { title: "v3" }), baseVersion: first.json.version });
    expect(retry.status).toBe(200);
  });

  it("rejects an invalid topic with 422 and guards traversal in the id with 400", async () => {
    const s = await withSeed();
    expect((await req(s.base, "POST", "/api/topics", { topic: { id: "bad", path: ["protocol"], title: "X", kind: "nonsense", questions: ["a"] } })).status).toBe(422);
    expect((await req(s.base, "POST", "/api/topics", { topic: { id: "../../evil", path: ["protocol"], title: "X", kind: "real", questions: ["a"] } })).status).toBe(400);
    expect((await req(s.base, "DELETE", "/api/topics/protocol/" + encodeURIComponent("../x"))).status).toBe(400);
  });

  it("DELETE removes a topic, then 404 on the second try", async () => {
    const s = await startStudio({ seed: (store) => store.putTopic("main", topic(["retail", "1.2.0"], "kill-me"), { actor: { name: "s", email: "studio@localhost" } }).then(() => undefined) });
    expect((await req(s.base, "DELETE", "/api/topics/retail/1.2.0/kill-me")).status).toBe(200);
    expect((await req(s.base, "DELETE", "/api/topics/retail/1.2.0/kill-me")).status).toBe(404);
  });

  it("PUT /api/meta updates identity, subject, and level labels", async () => {
    const s = await withSeed();
    expect((await req(s.base, "PUT", "/api/meta", { id: "renamed-kb", version: "2.0", subject: "the ONDC protocol", levels: ["domain", "usecase"] })).status).toBe(200);
    const { json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(json).toMatchObject({ id: "renamed-kb", version: "2.0", subject: "the ONDC protocol", levels: ["domain", "usecase"] });
    expect((await req(s.base, "PUT", "/api/meta", { id: "", version: "2.0" })).status).toBe(400);
  });

  it("nodes: create, list (nested + empty), move a subtree, and cascade-delete", async () => {
    const s = await startStudio({
      seed: async (store) => {
        await store.putTopic("main", topic(["protocol", "sub"], "keep"), { actor: { name: "s", email: "studio@localhost" } });
        await store.putTopic("main", topic(["other"], "survivor"), { actor: { name: "s", email: "studio@localhost" } });
      },
    });
    expect((await req(s.base, "POST", "/api/nodes", { path: ["logistics"] })).status).toBe(200);
    const nodes = (await req<{ nodes: { path: string[]; hasTopics: boolean }[] }>(s.base, "GET", "/api/nodes")).json.nodes;
    const byPath = new Map(nodes.map((n) => [n.path.join("/"), n.hasTopics]));
    expect(byPath.get("protocol/sub")).toBe(true);
    expect(byPath.get("logistics")).toBe(false);

    expect((await req(s.base, "POST", "/api/nodes", { path: ["../evil"] })).status).toBe(400);

    const moved = await req<{ moved: number }>(s.base, "PUT", "/api/nodes/protocol", { to: ["spec"] });
    expect(moved.json.moved).toBe(1);
    const m = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(m.json.topics.find((t) => t.id === "keep")?.path).toEqual(["spec", "sub"]);

    // Cascade needs the type-to-confirm token.
    expect((await req(s.base, "DELETE", "/api/nodes/spec?cascade=1")).status).toBe(400);
    expect((await req(s.base, "DELETE", "/api/nodes/spec?cascade=1&confirm=spec")).status).toBe(200);
    expect((await req<ManifestResp>(s.base, "GET", "/api/manifest")).json.topics.some((t) => t.id === "keep")).toBe(false);
  });

  it("POST /api/export writes a manifest.yaml that parses back to the merged manifest", async () => {
    const s = await startStudio({
      seed: async (store) => {
        await store.putTopic("main", topic(["protocol"], "real-a"), { actor: { name: "s", email: "studio@localhost" } });
        await store.putTopic("main", topic(["retail", "1.2.0", "search"], "gen-a"), { actor: { name: "s", email: "studio@localhost" } });
      },
    });
    const { status, json } = await req<{ topics: number; path: string }>(s.base, "POST", "/api/export", {});
    expect(status).toBe(200);
    expect(json.topics).toBe(2);
    const out = join(s.exportDir, "manifest.yaml");
    expect(existsSync(out)).toBe(true);
    const parsed = parseManifest(parseYaml(readFileSync(out, "utf8")));
    expect(parsed.topics.map((t) => t.id).sort()).toEqual(["gen-a", "real-a"]);
  });

  it("history + restore: a deleted topic is recoverable from Trash", async () => {
    const s = await startStudio({ seed: (store) => store.putTopic("main", topic(["protocol"], "gone"), { actor: { name: "s", email: "studio@localhost" } }).then(() => undefined) });
    await req(s.base, "DELETE", "/api/topics/protocol/gone");
    const hist = await req<{ commits: { message: string }[]; deletions: { file: string; restoreSha: string }[] }>(s.base, "GET", "/api/history");
    expect(hist.json.deletions.map((d) => d.file)).toContain("topics/protocol/gone.yaml");
    const entry = hist.json.deletions.find((d) => d.file === "topics/protocol/gone.yaml")!;
    expect((await req(s.base, "POST", "/api/restore", { sha: entry.restoreSha, path: ["protocol"], id: "gone" })).status).toBe(200);
    expect((await req<ManifestResp>(s.base, "GET", "/api/manifest")).json.topics.some((t) => t.id === "gone")).toBe(true);
  });

  it("GET /api/coverage lists newest-first; GET /api/coverage/:file returns one and rejects bad names", async () => {
    const s = await withSeed();
    seedReport(s.coverageDir, "test-kb-100.json", "2026-01-01T00:00:00.000Z");
    seedReport(s.coverageDir, "test-kb-200.json", "2026-06-01T00:00:00.000Z");
    const list = await req<{ file: string }[]>(s.base, "GET", "/api/coverage");
    expect(list.json.map((r) => r.file)).toEqual(["test-kb-200.json", "test-kb-100.json"]);
    const one = await req<{ topics: { status: string }[] }>(s.base, "GET", "/api/coverage/test-kb-200.json");
    expect(one.json.topics[0]?.status).toBe("grounded");
    expect((await req(s.base, "GET", "/api/coverage/" + encodeURIComponent("../../etc/passwd"))).status).toBe(400);
    expect((await req(s.base, "GET", "/api/coverage/nope.json")).status).toBe(404);
  });
});
