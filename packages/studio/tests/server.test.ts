import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseManifest } from "@evaluator/core";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { createStudioServer } from "../src/server";

interface Studio {
  base: string;
  kbDir: string;
  coverageDir: string;
  close: () => void;
}
interface ManifestResp {
  id: string;
  version: string;
  subject?: string;
  levels?: string[];
  topics: { id: string; path: string[]; kind: string }[];
}
interface NodesResp {
  nodes: { path: string[]; hasTopics: boolean }[];
}
interface CoverageSummary {
  file: string;
  generatedAt: string;
  metrics: { groundedRate: number };
}
interface CoverageReportResp {
  topics: { status: string }[];
}

const live: Studio[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kb-studio-srv-"));
  dirs.push(d);
  return d;
}
function seedTopic(kbDir: string, path: string[], id: string, over: Record<string, unknown> = {}): void {
  const t = { id, path, title: `Title ${id}`, kind: "real", questions: ["q one", "q two"], ...over };
  const folder = join(kbDir, "topics", ...path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.yaml`), JSON.stringify(t));
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
      topics: [
        {
          key: "protocol/t1",
          id: "t1",
          path: ["protocol"],
          title: "T1",
          kind: "real",
          status: "grounded",
          agreement: 1,
          sample: "s",
          detail: "d",
        },
      ],
      judge: { schemaEnforced: true, warnings: [] },
      caveats: ["measures coverage, not correctness"],
    }),
  );
}

async function start(seed?: (kbDir: string) => void): Promise<Studio> {
  const kbDir = tempDir();
  const coverageDir = tempDir();
  writeFileSync(join(kbDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\n');
  if (seed) seed(kbDir);
  else seedTopic(kbDir, ["protocol"], "seed-a");

  const server = createStudioServer({ kbDir, coverageDir });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  const studio: Studio = { base: `http://127.0.0.1:${String(port)}`, kbDir, coverageDir, close: () => server.close() };
  live.push(studio);
  return studio;
}

async function req<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(
    base + path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
}

afterEach(() => {
  for (const s of live.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("KB Studio server", () => {
  it("GET / serves the HTML shell", async () => {
    const s = await start();
    const res = await fetch(s.base + "/");
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("KB Studio");
  });

  it("GET /api/manifest merges the folder into a validated manifest", async () => {
    const s = await start((kb) => {
      seedTopic(kb, ["protocol"], "real-a");
      seedTopic(kb, ["protocol"], "canary-x", { kind: "canary" });
    });
    const { status, json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(status).toBe(200);
    expect(json.id).toBe("test-kb");
    expect(json.topics.map((t) => t.id).sort()).toEqual(["canary-x", "real-a"]);
  });

  it("GET /api/manifest returns 422 when a topic file is invalid", async () => {
    const s = await start((kb) => seedTopic(kb, ["protocol"], "bad", { questions: [] }));
    const { status, json } = await req<{ error: string }>(s.base, "GET", "/api/manifest");
    expect(status).toBe(422);
    expect(json.error).toMatch(/manifest/i);
  });

  it("POST /api/topics creates a nested-path file reflected by GET /api/manifest", async () => {
    const s = await start();
    const topic = { id: "new-one", path: ["retail", "1.2.0", "search"], title: "New", kind: "real", questions: ["a", "b"] };
    const { status } = await req(s.base, "POST", "/api/topics", { topic });
    expect(status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "retail", "1.2.0", "search", "new-one.yaml"))).toBe(true);
    const { json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(json.topics.find((t) => t.id === "new-one")?.path).toEqual(["retail", "1.2.0", "search"]);
  });

  it("POST /api/topics with `previous` moves across paths (old file gone, new present)", async () => {
    const s = await start((kb) => seedTopic(kb, ["protocol"], "old-id"));
    const topic = { id: "old-id", path: ["onboard"], title: "Moved", kind: "real", questions: ["a", "b"] };
    const { status } = await req(s.base, "POST", "/api/topics", {
      topic,
      previous: { path: ["protocol"], id: "old-id" },
    });
    expect(status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "protocol", "old-id.yaml"))).toBe(false);
    expect(existsSync(join(s.kbDir, "topics", "onboard", "old-id.yaml"))).toBe(true);
  });

  it("optimistic concurrency: a stale baseVersion is 409'd (with the current copy), a fresh one wins", async () => {
    const s = await start((kb) => seedTopic(kb, ["protocol"], "race"));
    const m = await req<{ versions: Record<string, string> }>(s.base, "GET", "/api/manifest");
    const v0 = m.json.versions["protocol/race"];
    expect(v0).toBeTruthy();

    // First save from the real version succeeds and returns the new version.
    const t2 = { id: "race", path: ["protocol"], title: "v2", kind: "real", questions: ["a", "b"] };
    const first = await req<{ version: string }>(s.base, "POST", "/api/topics", { topic: t2, baseVersion: v0 });
    expect(first.status).toBe(200);
    expect(first.json.version).not.toBe(v0);

    // A second save still using the ORIGINAL (now stale) version is refused, with the server's current copy.
    const t3 = { id: "race", path: ["protocol"], title: "v3", kind: "real", questions: ["a", "b"] };
    const stale = await req<{ currentVersion: string; current: { title: string } }>(s.base, "POST", "/api/topics", { topic: t3, baseVersion: v0 });
    expect(stale.status).toBe(409);
    expect(stale.json.currentVersion).toBe(first.json.version);
    expect(stale.json.current.title).toBe("v2");

    // Retrying with the fresh version wins.
    const retry = await req(s.base, "POST", "/api/topics", { topic: t3, baseVersion: first.json.version });
    expect(retry.status).toBe(200);
  });

  it("a save without baseVersion skips the optimistic check (backward compatible)", async () => {
    const s = await start((kb) => seedTopic(kb, ["protocol"], "nov"));
    const topic = { id: "nov", path: ["protocol"], title: "changed", kind: "real", questions: ["a", "b"] };
    const { status } = await req(s.base, "POST", "/api/topics", { topic });
    expect(status).toBe(200);
  });

  it("rejects an invalid topic with 422 and writes nothing", async () => {
    const s = await start();
    const topic = { id: "bad-kind", path: ["protocol"], title: "X", kind: "nonsense", questions: ["a"] };
    const { status } = await req(s.base, "POST", "/api/topics", { topic });
    expect(status).toBe(422);
    expect(existsSync(join(s.kbDir, "topics", "protocol", "bad-kind.yaml"))).toBe(false);
  });

  it("guards against path traversal in the topic id (400, nothing escapes)", async () => {
    const s = await start();
    const topic = { id: "../../evil", path: ["protocol"], title: "X", kind: "real", questions: ["a"] };
    const { status } = await req(s.base, "POST", "/api/topics", { topic });
    expect(status).toBe(400);
    expect(existsSync(join(s.kbDir, "..", "evil.yaml"))).toBe(false);
    const del = await req(s.base, "DELETE", "/api/topics/protocol/" + encodeURIComponent("../x"));
    expect(del.status).toBe(400);
  });

  it("DELETE removes a nested topic file, then 404 on the second try", async () => {
    const s = await start((kb) => seedTopic(kb, ["retail", "1.2.0"], "kill-me"));
    const { status } = await req(s.base, "DELETE", "/api/topics/retail/1.2.0/kill-me");
    expect(status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "retail", "1.2.0", "kill-me.yaml"))).toBe(false);
    const missing = await req(s.base, "DELETE", "/api/topics/retail/1.2.0/kill-me");
    expect(missing.status).toBe(404);
  });

  it("PUT /api/meta updates identity, the subject, and level labels", async () => {
    const s = await start();
    const { status } = await req(s.base, "PUT", "/api/meta", {
      id: "renamed-kb",
      version: "2.0",
      subject: "the ONDC protocol specifications",
      levels: ["domain", "usecase"],
    });
    expect(status).toBe(200);
    const { json } = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(json.id).toBe("renamed-kb");
    expect(json.version).toBe("2.0");
    expect(json.subject).toBe("the ONDC protocol specifications");
    expect(json.levels).toEqual(["domain", "usecase"]);
    const bad = await req(s.base, "PUT", "/api/meta", { id: "", version: "2.0" });
    expect(bad.status).toBe(400);
  });

  it("GET /api/nodes lists folder nodes, nested and empty", async () => {
    const s = await start((kb) => seedTopic(kb, ["retail", "1.2.0", "search"], "a"));
    await req(s.base, "POST", "/api/nodes", { path: ["logistics"] });
    const { status, json } = await req<NodesResp>(s.base, "GET", "/api/nodes");
    expect(status).toBe(200);
    const byPath = new Map(json.nodes.map((n) => [n.path.join("/"), n.hasTopics]));
    expect(byPath.get("retail/1.2.0/search")).toBe(true);
    expect(byPath.get("retail")).toBe(false);
    expect(byPath.get("logistics")).toBe(false); // created but empty
  });

  it("POST /api/nodes creates a node, DELETE removes it, and unsafe names are rejected", async () => {
    const s = await start();
    const create = await req(s.base, "POST", "/api/nodes", { path: ["logistics"] });
    expect(create.status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "logistics"))).toBe(true);

    const bad = await req(s.base, "POST", "/api/nodes", { path: ["../evil"] });
    expect(bad.status).toBe(400);
    expect(existsSync(join(s.kbDir, "topics", "..", "evil"))).toBe(false);

    const del = await req(s.base, "DELETE", "/api/nodes/logistics");
    expect(del.status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "logistics"))).toBe(false);
  });

  it("DELETE /api/nodes refuses a non-empty subtree unless cascade", async () => {
    const s = await start((kb) => seedTopic(kb, ["protocol", "sub"], "keep"));
    const blocked = await req(s.base, "DELETE", "/api/nodes/protocol");
    expect(blocked.status).toBe(400);
    expect(existsSync(join(s.kbDir, "topics", "protocol", "sub", "keep.yaml"))).toBe(true);
    // A cascade needs the type-to-confirm token (the node path) as well as ?cascade=1.
    const noConfirm = await req(s.base, "DELETE", "/api/nodes/protocol?cascade=1");
    expect(noConfirm.status).toBe(400);
    const cascade = await req(s.base, "DELETE", "/api/nodes/protocol?cascade=1&confirm=protocol");
    expect(cascade.status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "protocol"))).toBe(false);
  });

  it("PUT /api/nodes moves a subtree, rewriting each topic's path prefix", async () => {
    const s = await start((kb) => {
      seedTopic(kb, ["protocol"], "t1");
      seedTopic(kb, ["protocol"], "t2");
      seedTopic(kb, ["protocol", "sub"], "t3");
    });
    const { status, json } = await req<{ moved: number }>(s.base, "PUT", "/api/nodes/protocol", { to: ["spec"] });
    expect(status).toBe(200);
    expect(json.moved).toBe(3);
    expect(existsSync(join(s.kbDir, "topics", "protocol"))).toBe(false);
    expect(existsSync(join(s.kbDir, "topics", "spec", "t1.yaml"))).toBe(true);
    expect(existsSync(join(s.kbDir, "topics", "spec", "sub", "t3.yaml"))).toBe(true);
    const m = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(m.json.topics.every((t) => t.path[0] === "spec")).toBe(true);
    expect(m.json.topics.find((t) => t.id === "t3")?.path).toEqual(["spec", "sub"]);
  });

  it("PUT /api/nodes renames an EMPTY node (moves it, does not delete it)", async () => {
    // Regression: a freshly-created node has no topics, so the move loop is a no-op. The destination
    // folder must still be created before the source is removed — otherwise renaming an empty node
    // silently deletes it. (Empty subnodes under a renamed parent must survive for the same reason.)
    const s = await start();
    await req(s.base, "POST", "/api/nodes", { path: ["logistics"] });
    await req(s.base, "POST", "/api/nodes", { path: ["logistics", "1.0.0"] }); // empty subnode

    const { status } = await req<{ moved: number }>(s.base, "PUT", "/api/nodes/logistics", { to: ["shipping"] });
    expect(status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "logistics"))).toBe(false);
    expect(existsSync(join(s.kbDir, "topics", "shipping"))).toBe(true);
    expect(existsSync(join(s.kbDir, "topics", "shipping", "1.0.0"))).toBe(true);

    const nodes = await req<NodesResp>(s.base, "GET", "/api/nodes");
    const paths = nodes.json.nodes.map((n) => n.path.join("/"));
    expect(paths).toContain("shipping");
    expect(paths).toContain("shipping/1.0.0");
    expect(paths).not.toContain("logistics");
  });

  it("POST /api/export writes a manifest.yaml that parses back to the merged manifest", async () => {
    const s = await start((kb) => {
      seedTopic(kb, ["protocol"], "real-a");
      seedTopic(kb, ["retail", "1.2.0", "search"], "gen-a");
    });
    const { status, json } = await req<{ topics: number }>(s.base, "POST", "/api/export", {});
    expect(status).toBe(200);
    expect(json.topics).toBe(2);
    const out = join(s.kbDir, "manifest.yaml");
    expect(existsSync(out)).toBe(true);
    const parsed = parseManifest(parseYaml(readFileSync(out, "utf8")));
    expect(parsed.topics.map((t) => t.id).sort()).toEqual(["gen-a", "real-a"]);
  });

  it("GET /api/coverage lists reports newest-first; GET /api/coverage/:file returns one and rejects bad names", async () => {
    const s = await start();
    seedReport(s.coverageDir, "test-kb-100.json", "2026-01-01T00:00:00.000Z");
    seedReport(s.coverageDir, "test-kb-200.json", "2026-06-01T00:00:00.000Z");

    const list = await req<CoverageSummary[]>(s.base, "GET", "/api/coverage");
    expect(list.status).toBe(200);
    expect(list.json.map((r) => r.file)).toEqual(["test-kb-200.json", "test-kb-100.json"]);
    expect(list.json[0]?.metrics.groundedRate).toBe(1);

    const one = await req<CoverageReportResp>(s.base, "GET", "/api/coverage/test-kb-200.json");
    expect(one.status).toBe(200);
    expect(one.json.topics[0]?.status).toBe("grounded");

    const bad = await req(s.base, "GET", "/api/coverage/" + encodeURIComponent("../../etc/passwd"));
    expect(bad.status).toBe(400);
    const missing = await req(s.base, "GET", "/api/coverage/nope.json");
    expect(missing.status).toBe(404);
  });
});
