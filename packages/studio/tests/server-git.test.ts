/**
 * The git safety net (Phase 0). These tests run the server over a REAL git repo (a temp dir we
 * `git init`) and assert the behavior that makes deletion recoverable: every mutation is an attributed
 * commit, deletes are restorable from history, cascade-deletes come back file by file, and concurrent
 * writes serialize into a clean object store. The pre-existing server.test.ts covers the same endpoints
 * over a NON-git temp dir (graceful degradation), so both paths are held.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStudioServer } from "../src/server";

interface Studio {
  base: string;
  kbDir: string;
  close: () => void;
}
interface ManifestResp {
  topics: { id: string; path: string[] }[];
}
interface HistoryResp {
  commits: { sha: string; author: string; email: string; message: string }[];
  deletions: { file: string; restoreSha: string }[];
}

const live: Studio[] = [];
const dirs: string[] = [];

function git(kbDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: kbDir, encoding: "utf8" });
}

function seedTopic(kbDir: string, path: string[], id: string, over: Record<string, unknown> = {}): void {
  const t = { id, path, title: `Title ${id}`, kind: "real", questions: ["q one", "q two"], ...over };
  const folder = join(kbDir, "topics", ...path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.yaml`), JSON.stringify(t));
}

/**
 * A temp git repo with an initial commit so history/restore have a parent to reach. By default the KB
 * dir IS the repo root; `nested` puts it in a `kb/` subdirectory — the production topology, which
 * exercises the non-empty `kbPrefix` path (staging scoped to `kb`, root-relative git paths).
 */
async function startGit(seed?: (kbDir: string) => void, nested = false): Promise<Studio> {
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-studio-git-"));
  dirs.push(repoRoot);
  const kbDir = nested ? join(repoRoot, "kb") : repoRoot;
  mkdirSync(kbDir, { recursive: true });
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "seed@test"]);
  git(repoRoot, ["config", "user.name", "Seed"]);
  writeFileSync(join(kbDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\n');
  if (seed) seed(kbDir);
  else seedTopic(kbDir, ["protocol"], "seed-a");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "seed"]);

  const server = createStudioServer({ kbDir, coverageDir: kbDir });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  const studio: Studio = { base: `http://127.0.0.1:${String(port)}`, kbDir, close: () => server.close() };
  live.push(studio);
  return studio;
}

async function req<T = unknown>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
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

describe("KB Studio git safety net", () => {
  it("commits each topic write, attributed to the acting user", async () => {
    const s = await startGit();
    const topic = { id: "new-one", path: ["protocol"], title: "New", kind: "real", questions: ["a", "b"] };
    const { status } = await req(s.base, "POST", "/api/topics", { topic });
    expect(status).toBe(200);

    const subject = git(s.kbDir, ["log", "-1", "--format=%s"]).trim();
    const author = git(s.kbDir, ["log", "-1", "--format=%an <%ae>"]).trim();
    expect(subject).toBe("kb: save topic protocol/new-one");
    expect(author).toBe("KB Studio <studio@localhost>");
    // The working tree is clean — the write landed as a commit, not an uncommitted change.
    expect(git(s.kbDir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("a deleted topic is listed in history and restorable to its exact bytes", async () => {
    const s = await startGit((kb) => seedTopic(kb, ["retail", "1.2.0"], "kill-me"));
    const before = git(s.kbDir, ["show", "HEAD:topics/retail/1.2.0/kill-me.yaml"]);

    const del = await req(s.base, "DELETE", "/api/topics/retail/1.2.0/kill-me");
    expect(del.status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "retail", "1.2.0", "kill-me.yaml"))).toBe(false);

    const hist = await req<HistoryResp>(s.base, "GET", "/api/history");
    const gone = hist.json.deletions.find((d) => d.file.endsWith("retail/1.2.0/kill-me.yaml"));
    expect(gone).toBeTruthy();

    const restore = await req(s.base, "POST", "/api/restore", {
      sha: gone!.restoreSha,
      path: ["retail", "1.2.0"],
      id: "kill-me",
    });
    expect(restore.status).toBe(200);
    expect(git(s.kbDir, ["show", "HEAD:topics/retail/1.2.0/kill-me.yaml"])).toBe(before);
    const man = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(man.json.topics.some((t) => t.id === "kill-me")).toBe(true);
  });

  it("a cascade-deleted subtree is recoverable topic by topic", async () => {
    const s = await startGit((kb) => {
      seedTopic(kb, ["ondc", "protocol"], "a");
      seedTopic(kb, ["ondc", "protocol"], "b");
    });
    const del = await req(s.base, "DELETE", "/api/nodes/ondc/protocol?cascade=1&confirm=ondc/protocol");
    expect(del.status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "ondc", "protocol"))).toBe(false);

    const hist = await req<HistoryResp>(s.base, "GET", "/api/history");
    const dels = hist.json.deletions.filter((d) => /ondc\/protocol\/[ab]\.yaml$/.test(d.file));
    expect(dels).toHaveLength(2);
    for (const d of dels) {
      const id = d.file.endsWith("a.yaml") ? "a" : "b";
      const r = await req(s.base, "POST", "/api/restore", { sha: d.restoreSha, path: ["ondc", "protocol"], id });
      expect(r.status).toBe(200);
    }
    const man = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(man.json.topics.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  it("serializes concurrent writes into a clean object store (no index corruption)", async () => {
    const s = await startGit();
    const posts = Array.from({ length: 20 }, (_, i) => {
      const id = `t-${String(i).padStart(2, "0")}`;
      return req(s.base, "POST", "/api/topics", {
        topic: { id, path: ["bulk"], title: id, kind: "real", questions: ["a", "b"] },
      });
    });
    const results = await Promise.all(posts);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // fsck throws (non-zero exit) on any corruption; a clean repo proves the mutex serialized the commits.
    expect(() => git(s.kbDir, ["fsck", "--strict"])).not.toThrow();
    const man = await req<ManifestResp>(s.base, "GET", "/api/manifest");
    expect(man.json.topics.filter((t) => t.path[0] === "bulk")).toHaveLength(20);
  });

  it("a rename lands as one commit: old file gone, new present", async () => {
    const s = await startGit((kb) => seedTopic(kb, ["protocol"], "old-id"));
    const topic = { id: "new-id", path: ["protocol"], title: "Moved", kind: "real", questions: ["a", "b"] };
    const { status } = await req(s.base, "POST", "/api/topics", { topic, previous: { path: ["protocol"], id: "old-id" } });
    expect(status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "protocol", "old-id.yaml"))).toBe(false);
    expect(existsSync(join(s.kbDir, "topics", "protocol", "new-id.yaml"))).toBe(true);
    expect(git(s.kbDir, ["log", "-1", "--format=%s"]).trim()).toBe("kb: rename topic protocol/new-id");
  });

  it("works when the KB dir is a subdirectory of the repo (production topology)", async () => {
    const s = await startGit((kb) => seedTopic(kb, ["protocol"], "sub-a"), true);

    const topic = { id: "sub-b", path: ["protocol"], title: "Sub B", kind: "real", questions: ["a", "b"] };
    const save = await req(s.base, "POST", "/api/topics", { topic });
    expect(save.status).toBe(200);
    // A commit landed (scoped to the `kb/` prefix), authored by the studio actor.
    expect(git(s.kbDir, ["log", "-1", "--format=%s"]).trim()).toBe("kb: save topic protocol/sub-b");
    expect(git(s.kbDir, ["status", "--porcelain"]).trim()).toBe("");

    const del = await req(s.base, "DELETE", "/api/topics/protocol/sub-a");
    expect(del.status).toBe(200);
    const hist = await req<HistoryResp>(s.base, "GET", "/api/history");
    const gone = hist.json.deletions.find((d) => d.file.endsWith("protocol/sub-a.yaml"));
    expect(gone).toBeTruthy();
    // The recorded path is root-relative, so it carries the `kb/` prefix in this topology.
    expect(gone!.file.startsWith("kb/")).toBe(true);

    const restore = await req(s.base, "POST", "/api/restore", { sha: gone!.restoreSha, path: ["protocol"], id: "sub-a" });
    expect(restore.status).toBe(200);
    expect(existsSync(join(s.kbDir, "topics", "protocol", "sub-a.yaml"))).toBe(true);
  });

  it("restore rejects a bad sha (400) and a crafted id (400)", async () => {
    const s = await startGit();
    const badSha = await req(s.base, "POST", "/api/restore", { sha: "zzz;rm -rf", path: ["protocol"], id: "x" });
    expect(badSha.status).toBe(400);
    const badId = await req(s.base, "POST", "/api/restore", { sha: "abcdef0", path: ["protocol"], id: "../evil" });
    expect(badId.status).toBe(400);
  });
});
