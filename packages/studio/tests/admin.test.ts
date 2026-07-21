/**
 * The Admin page's backend — managing the access policy (`GET/PUT/DELETE /api/access`) and the
 * operational overview (`GET /api/admin/overview`). Proves the first-admin bootstrap (open mode → an
 * enforced policy naming yourself admin), that writes commit to the canonical tree, that a scoped
 * non-admin can neither read nor change the policy, that a zero-admin policy is refused, and that
 * DELETE returns to open mode.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
interface AccessView {
  configured: boolean;
  admins: string[];
  users: { email: string; scopes: string[][] }[];
  defaultScopes: string[][];
}
interface Overview {
  mode: string;
  reviewEnabled: boolean;
  accessConfigured: boolean;
  kbAdmins: string[];
  branches: { branch: string; login: string }[];
}

const live: Studio[] = [];
const dirs: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A multi-user studio with NO access.yaml — open mode, so the identity header is trusted and distinct. */
async function startOpen(): Promise<Studio> {
  const repoDir = mkdtempSync(join(tmpdir(), "kb-admin-repo-"));
  const worktreesDir = mkdtempSync(join(tmpdir(), "kb-admin-wt-"));
  dirs.push(repoDir, worktreesDir);
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "seed@test"]);
  git(repoDir, ["config", "user.name", "Seed"]);
  writeFileSync(join(repoDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\n');
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "seed"]);

  const server = createStudioServer({ kbDir: repoDir, coverageDir: repoDir, multiUser: { repoDir, worktreesDir } });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
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

describe("admin: access policy", () => {
  it("open mode reads as unconfigured and the first PUT bootstraps an admin (committed to main)", async () => {
    const s = await startOpen();
    const before = await reqAs<AccessView>(s.base, "alice@corp.com", "GET", "/api/access");
    expect(before.json.configured).toBe(false);

    const put = await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: ["alice@corp.com"], users: [], defaultScopes: [] });
    expect(put.status).toBe(200);
    expect(existsSync(join(s.repoDir, "access.yaml"))).toBe(true);
    expect(git(s.repoDir, ["log", "-1", "--pretty=%s"])).toContain("update access policy");

    const after = await reqAs<AccessView>(s.base, "alice@corp.com", "GET", "/api/access");
    expect(after.json).toMatchObject({ configured: true, admins: ["alice@corp.com"] });
    // whoami now reflects the enforced role.
    expect((await reqAs<{ role: string }>(s.base, "alice@corp.com", "GET", "/api/whoami")).json.role).toBe("admin");
  });

  it("once configured, a scoped non-admin can neither read nor change the policy but the admin can", async () => {
    const s = await startOpen();
    await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: ["alice@corp.com"], users: [], defaultScopes: [] });
    // Alice grants Bob a scope (round-trips through the YAML).
    await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", {
      admins: ["alice@corp.com"],
      users: [{ email: "bob@corp.com", scopes: [["protocol", "foundation"]] }],
      defaultScopes: [],
    });
    const policy = await reqAs<AccessView>(s.base, "alice@corp.com", "GET", "/api/access");
    expect(policy.json.users).toEqual([{ email: "bob@corp.com", scopes: [["protocol", "foundation"]] }]);

    // Bob (a scoped author) is locked out of the admin surface…
    expect((await reqAs(s.base, "bob@corp.com", "GET", "/api/access")).status).toBe(403);
    expect((await reqAs(s.base, "bob@corp.com", "PUT", "/api/access", { admins: ["bob@corp.com"], users: [], defaultScopes: [] })).status).toBe(403);
    // …and remains scoped to his path (worktree access.yaml can't escalate — enforced from canonical main).
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topic(["protocol", "foundation"], "bob-ok"))).status).toBe(200);
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topic(["protocol", "domains"], "bob-no"))).status).toBe(403);
  });

  it("refuses a zero-admin policy (would lock everyone out)", async () => {
    const s = await startOpen();
    await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: ["alice@corp.com"], users: [], defaultScopes: [] });
    expect((await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: [], users: [], defaultScopes: [] })).status).toBe(400);
  });

  it("rejects an unsafe scope segment", async () => {
    const s = await startOpen();
    const bad = await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", {
      admins: ["alice@corp.com"],
      users: [{ email: "bob@corp.com", scopes: [["../etc"]] }],
      defaultScopes: [],
    });
    expect(bad.status).toBe(400);
  });

  it("DELETE turns access control back off (open mode)", async () => {
    const s = await startOpen();
    await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: ["alice@corp.com"], users: [], defaultScopes: [] });
    expect((await reqAs(s.base, "alice@corp.com", "DELETE", "/api/access")).status).toBe(200);
    expect(existsSync(join(s.repoDir, "access.yaml"))).toBe(false);
    // Back to open mode: anyone can read (unconfigured) and write anywhere again.
    expect((await reqAs<AccessView>(s.base, "bob@corp.com", "GET", "/api/access")).json.configured).toBe(false);
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", topic(["anything", "here"], "bob-open"))).status).toBe(200);
    // DELETE again is a 404 (already off).
    expect((await reqAs(s.base, "alice@corp.com", "DELETE", "/api/access")).status).toBe(404);
  });

  it("overview reports the deployment mode and access state", async () => {
    const s = await startOpen();
    const open = await reqAs<Overview>(s.base, "alice@corp.com", "GET", "/api/admin/overview");
    expect(open.json).toMatchObject({ mode: "multi", reviewEnabled: false, accessConfigured: false });

    await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: ["alice@corp.com"], users: [], defaultScopes: [] });
    // Bob touches the studio, creating his draft branch.
    await reqAs(s.base, "bob@corp.com", "GET", "/api/whoami");
    const configured = await reqAs<Overview>(s.base, "alice@corp.com", "GET", "/api/admin/overview");
    expect(configured.json.accessConfigured).toBe(true);
    expect(configured.json.branches.map((b) => b.branch)).toContain("user/bob-corp-com");
  });
});
