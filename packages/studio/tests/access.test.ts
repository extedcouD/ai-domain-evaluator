/**
 * Phase 3 — topic scoping. A git-tracked `access.yaml` grants each user write scopes (path-prefixes);
 * admins write anywhere. These tests prove enforcement server-side: in-scope writes pass, out-of-scope
 * writes are 403, viewers are read-only, meta is admin-only, cascade needs type-to-confirm, and — the
 * security crux — the policy is read from the CANONICAL KB, so a user cannot edit their worktree's
 * `access.yaml` to escalate. (No `access.yaml` = open mode, covered by every other test file.)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStudioServer } from "../src/server";

interface Studio {
  base: string;
  repoDir: string;
  worktreesDir: string;
  close: () => void;
}
interface Whoami {
  role: string;
  scopes: string[][];
}

const live: Studio[] = [];
const dirs: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}
function seedTopic(kbDir: string, path: string[], id: string): void {
  const folder = join(kbDir, "topics", ...path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.yaml`), JSON.stringify({ id, path, title: id, kind: "real", questions: ["a", "b"] }));
}

const ACCESS_YAML = `admins:
  - alice@corp.com
users:
  bob@corp.com:
    scopes:
      - [protocol, foundation]
defaults:
  scopes: []
`;

async function startScoped(): Promise<Studio> {
  const repoDir = mkdtempSync(join(tmpdir(), "kb-access-repo-"));
  const worktreesDir = mkdtempSync(join(tmpdir(), "kb-access-wt-"));
  dirs.push(repoDir, worktreesDir);
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "seed@test"]);
  git(repoDir, ["config", "user.name", "Seed"]);
  writeFileSync(join(repoDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\n');
  writeFileSync(join(repoDir, "access.yaml"), ACCESS_YAML);
  seedTopic(repoDir, ["protocol", "foundation"], "in-scope");
  seedTopic(repoDir, ["protocol", "domains"], "out-scope");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "seed"]);

  const server = createStudioServer({ kbDir: repoDir, coverageDir: repoDir, multiUser: { repoDir, worktreesDir } });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  const studio: Studio = { base: `http://127.0.0.1:${String(port)}`, repoDir, worktreesDir, close: () => server.close() };
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

const topic = (path: string[], id: string) => ({ topic: { id, path, title: id, kind: "real", questions: ["a", "b"] } });

afterEach(() => {
  for (const s of live.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("topic scoping", () => {
  it("whoami reflects each user's role and scopes", async () => {
    const s = await startScoped();
    expect((await reqAs<Whoami>(s.base, "alice@corp.com", "GET", "/api/whoami")).json).toMatchObject({ role: "admin", scopes: [[]] });
    expect((await reqAs<Whoami>(s.base, "bob@corp.com", "GET", "/api/whoami")).json).toMatchObject({ role: "author", scopes: [["protocol", "foundation"]] });
    expect((await reqAs<Whoami>(s.base, "carol@corp.com", "GET", "/api/whoami")).json).toMatchObject({ role: "viewer", scopes: [] });
  });

  it("an author writes inside their scope but is 403 outside it", async () => {
    const s = await startScoped();
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topic(["protocol", "foundation"], "bob-new"))).status).toBe(200);
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topic(["protocol", "domains"], "bob-sneak"))).status).toBe(403);
    // …and cannot delete a topic outside their scope.
    expect((await reqAs(s.base, "bob@corp.com", "DELETE", "/api/topics/protocol/domains/out-scope")).status).toBe(403);
    // …but can delete one inside it.
    expect((await reqAs(s.base, "bob@corp.com", "DELETE", "/api/topics/protocol/foundation/in-scope")).status).toBe(200);
  });

  it("a viewer (unlisted, no default scopes) is read-only", async () => {
    const s = await startScoped();
    expect((await reqAs<{ topics: unknown[] }>(s.base, "carol@corp.com", "GET", "/api/manifest")).status).toBe(200);
    expect((await reqAs(s.base, "carol@corp.com", "POST", "/api/topics", topic(["protocol", "foundation"], "nope"))).status).toBe(403);
  });

  it("an admin writes anywhere and owns meta; a non-admin cannot edit meta", async () => {
    const s = await startScoped();
    expect((await reqAs(s.base, "alice@corp.com", "POST", "/api/topics", topic(["protocol", "domains"], "alice-anywhere"))).status).toBe(200);
    expect((await reqAs(s.base, "alice@corp.com", "PUT", "/api/meta", { id: "test-kb", version: "2.0" })).status).toBe(200);
    expect((await reqAs(s.base, "bob@corp.com", "PUT", "/api/meta", { id: "test-kb", version: "9.9" })).status).toBe(403);
  });

  it("cascade delete needs the type-to-confirm token", async () => {
    const s = await startScoped();
    const noConfirm = await reqAs(s.base, "alice@corp.com", "DELETE", "/api/nodes/protocol/foundation?cascade=1");
    expect(noConfirm.status).toBe(400);
    const confirmed = await reqAs(s.base, "alice@corp.com", "DELETE", "/api/nodes/protocol/foundation?cascade=1&confirm=protocol/foundation");
    expect(confirmed.status).toBe(200);
  });

  it("uses the CANONICAL policy — tampering with a worktree's access.yaml does not escalate", async () => {
    const s = await startScoped();
    // Force Bob's worktree to exist, then rewrite ITS access.yaml to make him an admin everywhere.
    await reqAs(s.base, "bob@corp.com", "GET", "/api/whoami");
    writeFileSync(join(s.worktreesDir, "bob-corp-com", "access.yaml"), "admins:\n  - bob@corp.com\n");
    // The server still reads the canonical (main) policy, so Bob remains scoped.
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topic(["protocol", "domains"], "still-blocked"))).status).toBe(403);
    expect((await reqAs<Whoami>(s.base, "bob@corp.com", "GET", "/api/whoami")).json.role).toBe("author");
  });
});
