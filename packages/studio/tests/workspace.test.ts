/**
 * Phase 1 — branch-per-user isolation. In multi-user mode the server routes each authenticated actor
 * (identified by the trusted `x-forwarded-email` header the SSO proxy injects) to their OWN git worktree
 * on `user/<login>`. These tests prove the core guarantee: one user's edits are invisible to another and
 * never touch `main` — a user physically cannot clobber shared work.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loginSlug } from "../src/workspace";
import { createStudioServer } from "../src/server";

interface Studio {
  base: string;
  repoDir: string;
  close: () => void;
}
interface ManifestResp {
  topics: { id: string }[];
}
interface WhoamiResp {
  actor: { name: string; email: string };
  branch: string | null;
}

const live: Studio[] = [];
const dirs: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function seedTopic(kbDir: string, path: string[], id: string): void {
  const t = { id, path, title: `Title ${id}`, kind: "real", questions: ["q one", "q two"] };
  const folder = join(kbDir, "topics", ...path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.yaml`), JSON.stringify(t));
}

/** A multi-user server over a temp git repo (repo root IS the KB) with per-user worktrees off to the side. */
async function startMulti(): Promise<Studio> {
  const repoDir = mkdtempSync(join(tmpdir(), "kb-multi-repo-"));
  const worktreesDir = mkdtempSync(join(tmpdir(), "kb-multi-wt-"));
  dirs.push(repoDir, worktreesDir);
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "seed@test"]);
  git(repoDir, ["config", "user.name", "Seed"]);
  writeFileSync(join(repoDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\n');
  seedTopic(repoDir, ["protocol"], "seed-a");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "seed"]);

  const server = createStudioServer({ kbDir: repoDir, coverageDir: repoDir, multiUser: { repoDir, worktreesDir } });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  const studio: Studio = { base: `http://127.0.0.1:${String(port)}`, repoDir, close: () => server.close() };
  live.push(studio);
  return studio;
}

/** A request as a given user — the SSO proxy's injected identity header. */
async function reqAs<T = unknown>(
  base: string,
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { "x-forwarded-email": email };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
}

const topicBody = (id: string) => ({ topic: { id, path: ["protocol"], title: id, kind: "real", questions: ["a", "b"] } });

afterEach(() => {
  for (const s of live.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("branch-per-user routing", () => {
  it("derives a safe branch slug from an email", () => {
    expect(loginSlug({ name: "Bob", email: "bob@corp.com" })).toBe("bob-corp-com");
    expect(loginSlug({ name: "X", email: "" })).toBe("x");
  });

  it("whoami reports the caller's identity and their user branch", async () => {
    const s = await startMulti();
    const who = await reqAs<WhoamiResp>(s.base, "bob@corp.com", "GET", "/api/whoami");
    expect(who.status).toBe(200);
    expect(who.json.actor.email).toBe("bob@corp.com");
    expect(who.json.branch).toBe("user/bob-corp-com");
  });

  it("routes each user to their own branch — edits are isolated and never touch main", async () => {
    const s = await startMulti();

    // Bob adds a topic; it commits to his branch, authored as Bob.
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topicBody("bob-topic"))).status).toBe(200);

    // Bob sees his topic + the seed; Carol sees ONLY the seed (isolation).
    const bobView = await reqAs<ManifestResp>(s.base, "bob@corp.com", "GET", "/api/manifest");
    const carolView = await reqAs<ManifestResp>(s.base, "carol@corp.com", "GET", "/api/manifest");
    expect(bobView.json.topics.map((t) => t.id).sort()).toEqual(["bob-topic", "seed-a"]);
    expect(carolView.json.topics.map((t) => t.id).sort()).toEqual(["seed-a"]);

    // Carol adds her own; still invisible to Bob.
    expect((await reqAs(s.base, "carol@corp.com", "POST", "/api/topics", topicBody("carol-topic"))).status).toBe(200);
    const bobAgain = await reqAs<ManifestResp>(s.base, "bob@corp.com", "GET", "/api/manifest");
    expect(bobAgain.json.topics.map((t) => t.id).sort()).toEqual(["bob-topic", "seed-a"]);

    // main is untouched — neither user's work has landed there yet.
    expect(git(s.repoDir, ["log", "main", "--format=%s"]).trim()).toBe("seed");
    // Each user branch carries exactly one new commit, authored as that user.
    expect(git(s.repoDir, ["log", "user/bob-corp-com", "-1", "--format=%an|%s"]).trim()).toBe("bob|kb: save topic protocol/bob-topic");
    expect(git(s.repoDir, ["log", "user/carol-corp-com", "-1", "--format=%an|%s"]).trim()).toBe("carol|kb: save topic protocol/carol-topic");
  });

  it("reuses an existing user branch across sessions (worktree recreated, history kept)", async () => {
    const s1 = await startMulti();
    expect((await reqAs(s1.base, "bob@corp.com", "POST", "/api/topics", topicBody("first"))).status).toBe(200);
    s1.close();
    live.splice(0); // don't double-close; keep dirs for the second server

    // A fresh server over the SAME repo: Bob's branch already exists, so his prior work is still there.
    const server = createStudioServer({
      kbDir: s1.repoDir,
      coverageDir: s1.repoDir,
      multiUser: { repoDir: s1.repoDir, worktreesDir: dirs[1]! },
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    const base = `http://127.0.0.1:${String(port)}`;
    live.push({ base, repoDir: s1.repoDir, close: () => server.close() });

    const view = await reqAs<ManifestResp>(base, "bob@corp.com", "GET", "/api/manifest");
    expect(view.json.topics.map((t) => t.id).sort()).toEqual(["first", "seed-a"]);
  });
});
