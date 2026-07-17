/**
 * Phase 2 — the review flow. A user works on their own branch; "submit for review" PUSHES that branch
 * to `origin` and opens a PR (through an injected `Forge` — here a fake, so no network); a reviewer
 * (admin) merges it. These tests prove: submit publishes the branch + opens exactly one PR, the queue
 * lists it, a non-admin cannot merge, an admin can, and `sync` pulls new `main` work into a draft.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Forge, Proposal } from "../src/forge";
import { createStudioServer } from "../src/server";

interface Studio {
  base: string;
  repoDir: string;
  originDir: string;
  prs: () => Proposal[];
  close: () => void;
}
interface ManifestResp {
  topics: { id: string }[];
}

const live: Studio[] = [];
const dirs: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function seedTopic(kbDir: string, id: string): void {
  const folder = join(kbDir, "topics", "protocol");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.yaml`), JSON.stringify({ id, path: ["protocol"], title: id, kind: "real", questions: ["a", "b"] }));
}

/** An in-memory Forge, plus a peek at its PR list for assertions. */
function makeFakeForge(): { forge: Forge; prs: () => Proposal[] } {
  const prs: Proposal[] = [];
  let n = 0;
  const forge: Forge = {
    openOrGet({ head, title }) {
      const open = prs.find((p) => p.branch === head && p.state === "open");
      if (open) return Promise.resolve(open);
      const pr: Proposal = { number: ++n, title, url: `https://fake/pr/${String(n)}`, branch: head, author: head, state: "open", createdAt: "2026-01-01T00:00:00Z" };
      prs.push(pr);
      return Promise.resolve(pr);
    },
    listOpen: () => Promise.resolve(prs.filter((p) => p.state === "open")),
    merge: (number) => {
      const pr = prs.find((p) => p.number === number);
      if (pr) pr.state = "merged";
      return Promise.resolve();
    },
  };
  return { forge, prs: () => prs };
}

async function startReview(withReview = true): Promise<Studio> {
  const originDir = mkdtempSync(join(tmpdir(), "kb-origin-"));
  const repoDir = mkdtempSync(join(tmpdir(), "kb-review-repo-"));
  const worktreesDir = mkdtempSync(join(tmpdir(), "kb-review-wt-"));
  dirs.push(originDir, repoDir, worktreesDir);

  git(originDir, ["init", "--bare", "-q", "-b", "main"]);
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "seed@test"]);
  git(repoDir, ["config", "user.name", "Seed"]);
  writeFileSync(join(repoDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\n');
  seedTopic(repoDir, "seed-a");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "seed"]);
  git(repoDir, ["remote", "add", "origin", originDir]);
  git(repoDir, ["push", "-q", "-u", "origin", "main"]);

  const fake = makeFakeForge();
  const server = createStudioServer({
    kbDir: repoDir,
    coverageDir: repoDir,
    multiUser: { repoDir, worktreesDir },
    ...(withReview
      ? { review: { forge: fake.forge, remote: "origin", baseBranch: "main", admins: ["admin@corp.com"] } }
      : {}),
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  const studio: Studio = { base: `http://127.0.0.1:${String(port)}`, repoDir, originDir, prs: fake.prs, close: () => server.close() };
  live.push(studio);
  return studio;
}

async function reqAs<T = unknown>(base: string, email: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
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

describe("review flow", () => {
  it("submit pushes the user branch to origin and opens exactly one PR (idempotent)", async () => {
    const s = await startReview();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topicBody("bob-topic"));

    const first = await reqAs<Proposal>(s.base, "bob@corp.com", "POST", "/api/proposals");
    expect(first.status).toBe(200);
    expect(first.json.branch).toBe("user/bob-corp-com");
    // The branch is now on origin (published for review).
    expect(git(s.originDir, ["branch", "--list", "user/bob-corp-com"]).trim()).toContain("user/bob-corp-com");

    // Resubmitting returns the same PR, not a second one.
    const again = await reqAs<Proposal>(s.base, "bob@corp.com", "POST", "/api/proposals");
    expect(again.json.number).toBe(first.json.number);
    expect(s.prs().filter((p) => p.state === "open")).toHaveLength(1);
  });

  it("lists the open queue; a non-admin cannot merge, an admin can", async () => {
    const s = await startReview();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topicBody("bob-topic"));
    const pr = await reqAs<Proposal>(s.base, "bob@corp.com", "POST", "/api/proposals");

    const queue = await reqAs<{ proposals: Proposal[] }>(s.base, "carol@corp.com", "GET", "/api/proposals");
    expect(queue.json.proposals.map((p) => p.branch)).toEqual(["user/bob-corp-com"]);

    // Bob (author, not admin) is refused.
    const denied = await reqAs(s.base, "bob@corp.com", "POST", `/api/proposals/${String(pr.json.number)}/merge`);
    expect(denied.status).toBe(403);

    // The admin merges; the queue drains.
    const merged = await reqAs(s.base, "admin@corp.com", "POST", `/api/proposals/${String(pr.json.number)}/merge`);
    expect(merged.status).toBe(200);
    const after = await reqAs<{ proposals: Proposal[] }>(s.base, "admin@corp.com", "GET", "/api/proposals");
    expect(after.json.proposals).toHaveLength(0);
  });

  it("sync brings new main work into a user's draft", async () => {
    const s = await startReview();
    // Bob starts a branch (creating his worktree from the current main).
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topicBody("bob-topic"));

    // Meanwhile main gains a topic (committed directly on the main worktree).
    seedTopic(s.repoDir, "landed-on-main");
    git(s.repoDir, ["add", "-A"]);
    git(s.repoDir, ["commit", "-q", "-m", "add landed-on-main"]);

    // Before sync Bob doesn't see it; after sync he does — cleanly (no conflict).
    const before = await reqAs<ManifestResp>(s.base, "bob@corp.com", "GET", "/api/manifest");
    expect(before.json.topics.some((t) => t.id === "landed-on-main")).toBe(false);

    const sync = await reqAs<{ merged: boolean; conflicted: boolean }>(s.base, "bob@corp.com", "POST", "/api/sync");
    expect(sync.json.conflicted).toBe(false);
    const after = await reqAs<ManifestResp>(s.base, "bob@corp.com", "GET", "/api/manifest");
    expect(after.json.topics.map((t) => t.id).sort()).toEqual(["bob-topic", "landed-on-main", "seed-a"]);
  });

  it("merging fast-forwards the deployment's local main to the merged remote", async () => {
    const s = await startReview();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topicBody("bob-topic"));
    const pr = await reqAs<Proposal>(s.base, "bob@corp.com", "POST", "/api/proposals");

    // Simulate the PR landing on the forge: origin/main advances to Bob's branch tip.
    git(s.repoDir, ["push", "-q", "origin", "user/bob-corp-com:main"]);
    // Local main is still at the seed until the merge route refreshes it.
    expect(git(s.repoDir, ["log", "main", "--format=%s"]).trim()).toBe("seed");

    const merged = await reqAs(s.base, "admin@corp.com", "POST", `/api/proposals/${String(pr.json.number)}/merge`);
    expect(merged.status).toBe(200);
    // Now the deployment's local main includes Bob's merged commit.
    expect(git(s.repoDir, ["log", "main", "--format=%s"]).trim()).toContain("kb: save topic protocol/bob-topic");
  });

  it("proposal routes report not-enabled when no Forge is configured", async () => {
    const s = await startReview(false);
    const r = await reqAs<{ error: string }>(s.base, "bob@corp.com", "POST", "/api/proposals");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not enabled/i);
  });
});
