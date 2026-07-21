/**
 * KB Studio — a local browser tool to author the manifest and view coverage reports.
 *
 * A zero-dependency `node:http` JSON API over the KB folder + the `kb-coverage/*.json` reports, plus a
 * static server for the built front-end (`dist/`, produced by Vite — see src/ui + vite.config.ts). It
 * is a FRONT-END: it does its own filesystem + YAML I/O and never touches a provider SDK (lint-walled).
 *
 * It deliberately does NOT run coverage probes — that needs a model, `.env`, and the engine's `Run`,
 * which is the CLI's job (`evaluator --coverage kb`). The Studio authors the manifest and *views* the
 * reports the CLI writes.
 *
 * `createStudioServer({ kbDir, coverageDir })` is a factory (dirs injected) so tests point it at temp
 * dirs. Only the entrypoint guard at the bottom calls `listen()`, so importing this module binds no
 * port. Every write validates each path segment + id before touching a path, so a crafted request
 * cannot escape the KB directory.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, rollup, type CoverageReport, type Topic } from "@evaluator/core";
import { simpleGit } from "simple-git";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  canWrite,
  isAdmin as isAccessAdmin,
  policyToData,
  readAccess,
  renderAccessYaml,
  roleFor,
  scopesFor,
  type AccessPolicy,
  type PolicyData,
} from "./access";
import { makeActorResolver, type Actor } from "./actor";
import { createGitHubForge } from "./forge";
import { GitStore } from "./git-store";
import {
  declaredLevels,
  listNodes,
  parseTopic,
  readManifestDir,
  readMetaObject,
  renderManifestYaml,
  SEGMENT_RE,
  topicPath,
  TOPIC_ID_RE,
} from "./manifest-folder";
import { isAdmin, listProposals, mergeProposal, refreshBase, submitForReview, syncFromMain, type ReviewConfig } from "./propose";
import { singleWorkspaceRouter, worktreeRouter, type Workspace, type WorkspaceRouter } from "./workspace";

export interface StudioOptions {
  /**
   * The KB folder: `manifest.meta.yaml` + `topics/<seg…>/*.yaml` (+ the generated `manifest.yaml`). In
   * multi-user mode this is the MAIN worktree's KB — a read reference whose repo-relative location is
   * mirrored into each per-user worktree; requests never write it directly.
   */
  kbDir: string;
  /** Where coverage runs are written: `<id>-<epoch>.json`, as the CLI writes them (shared, read-only). */
  coverageDir: string;
  /**
   * Enable branch-per-user routing. When set, each authenticated actor is routed to their own git
   * worktree on `user/<login>` and the identity header is trusted; when absent, everyone shares `kbDir`
   * (single-workspace — the Phase 0 behavior every existing test relies on).
   */
  multiUser?: {
    /** The git repo root (its main worktree holds the canonical KB). */
    repoDir: string;
    /** A directory OUTSIDE the main tree that holds the per-user worktrees. */
    worktreesDir: string;
  };
  /**
   * The review flow (Phase 2): push a user branch + open/merge PRs via a `Forge`. Only meaningful with
   * `multiUser`. Absent → the `/api/proposals` + `/api/sync` routes report "review not enabled".
   */
  review?: ReviewConfig;
}

const REAL_HEADER = "# Real topic — a genuine topic the source SHOULD be able to answer.\n";
const CANARY_HEADER =
  "# Canary — a FABRICATED topic that does NOT exist. A well-grounded source abstains; a confabulator\n" +
  "# answers it confidently, so its confident answers to REAL topics are worth nothing either.\n";
const META_HEADER =
  "# Manifest identity + subject. Topics live in topics/<seg…>/<id>.yaml; bump version when the set changes.\n\n";

/** The built front-end lives here after `vite build`. Absent in a fresh checkout / in tests. */
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

/** A malformed request (bad path ref, unparseable body) → 400. Distinct from a ConfigError (422). */
class BadRequest extends Error {}
/** A well-formed request for a thing that isn't there → 404. */
class NotFound extends Error {}
/** The target changed under the caller (stale optimistic-concurrency token) → 409. Used from Phase 4. */
class Conflict extends Error {}
/** The actor is not allowed to touch this path (topic scoping / merge) → 403. */
class Forbidden extends Error {}
/** An upstream (the PR forge, or a git push) failed → 502, so the message reaches the user, not a 500. */
class BadGateway extends Error {}

/** Everything a request handler needs beyond its own workspace: shared dirs + the per-request routers. */
interface Ctx {
  coverageDir: string;
  /** The CANONICAL KB (the main tree), the one authoritative source of `access.yaml` — never a worktree. */
  canonicalKbDir: string;
  /** GitStore committing to the canonical KB — where admin access-policy edits land (its own mutex). */
  canonicalGit: GitStore;
  /** The git repo root in multi-user mode (to fast-forward local `main` after a merge); null in single mode. */
  repoDir: string | null;
  resolveActor: (req: IncomingMessage) => Actor;
  router: WorkspaceRouter;
  review: ReviewConfig | null;
}

export function createStudioServer(opts: StudioOptions): Server {
  // Multi-user mode is where the identity header is trusted; single mode never reads it (DEFAULT_ACTOR).
  const resolveActor = makeActorResolver({ trustProxy: opts.multiUser !== undefined });
  const router: WorkspaceRouter = opts.multiUser
    ? worktreeRouter({ repoDir: opts.multiUser.repoDir, worktreesDir: opts.multiUser.worktreesDir, kbDir: opts.kbDir })
    : singleWorkspaceRouter(opts.kbDir);
  const ctx: Ctx = {
    coverageDir: opts.coverageDir,
    canonicalKbDir: opts.kbDir,
    canonicalGit: new GitStore(opts.kbDir),
    repoDir: opts.multiUser?.repoDir ?? null,
    resolveActor,
    router,
    review: opts.review ?? null,
  };
  return createServer((req, res) => {
    void handle(req, res, ctx);
  });
}

/** Enforce topic scoping before a write. A no-op in open mode (no `access.yaml`). */
function guardScope(policy: AccessPolicy | null, actor: Actor, path: string[], verb = "edit"): void {
  if (!canWrite(policy, actor.email, path)) {
    throw new Forbidden(`not allowed to ${verb} "${path.join("/")}" — outside your assigned scope`);
  }
}

/** Enforce an admin-only op (identity edits). Only bites when an `access.yaml` policy exists. */
function guardAdmin(policy: AccessPolicy | null, actor: Actor, verb: string): void {
  if (policy !== null && !isAccessAdmin(policy, actor.email)) throw new Forbidden(`only an admin can ${verb}`);
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";

    // Non-workspace routes: the SPA shell, static assets, and the shared (read-only) coverage reports.
    if (method === "GET" && path === "/") return serveHtml(res);
    if (method === "GET" && path === "/api/coverage") return listCoverage(res, ctx.coverageDir);
    if (method === "GET" && path.startsWith("/api/coverage/")) return getCoverage(req, res, ctx.coverageDir, path);
    if (method === "GET" && !path.startsWith("/api/")) return serveStatic(res, path);

    // Everything else under /api is workspace-scoped: resolve the caller, then their worktree.
    if (path.startsWith("/api/")) {
      const actor = ctx.resolveActor(req);
      const ws = await ctx.router.resolve(actor);
      return await handleKb(req, res, ctx, ws, method, path);
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendError(res, err);
  }
}

/** Dispatch the workspace-scoped routes against the caller's resolved workspace. */
async function handleKb(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  ws: Workspace,
  method: string,
  path: string,
): Promise<void> {
  // The scoping policy comes from the CANONICAL KB (main), so a user's worktree copy can't self-escalate.
  const policy = readAccess(ctx.canonicalKbDir);

  if (method === "GET" && path === "/api/whoami") {
    return sendJson(res, 200, {
      actor: ws.actor,
      branch: ws.branch,
      role: roleFor(policy, ws.actor.email),
      scopes: scopesFor(policy, ws.actor.email),
      review: ctx.review !== null,
    });
  }
  if (method === "GET" && path === "/api/manifest") return sendJson(res, 200, manifestWithVersions(ws.kbDir));
  if (method === "POST" && path === "/api/topics") return await postTopic(req, res, ws, policy);
  if (method === "DELETE" && path.startsWith("/api/topics/")) return await deleteTopic(res, ws, path, policy);
  if (method === "PUT" && path === "/api/meta") return await putMeta(req, res, ws, policy);
  if (method === "POST" && path === "/api/export") return postExport(res, ws);
  if (method === "GET" && path === "/api/nodes") return sendJson(res, 200, { nodes: listNodes(ws.kbDir) });
  if (method === "POST" && path === "/api/nodes") return await postNode(req, res, ws, policy);
  if (method === "PUT" && path.startsWith("/api/nodes/")) return await putNode(req, res, ws, path, policy);
  if (method === "DELETE" && path.startsWith("/api/nodes/")) return await deleteNode(req, res, ws, path, policy);
  if (method === "GET" && path === "/api/history") return await getHistory(req, res, ws);
  if (method === "POST" && path === "/api/restore") return await postRestore(req, res, ws, policy);

  // Phase 2 — the review flow (only when a Forge is configured).
  if (method === "POST" && path === "/api/proposals") return await postProposal(res, ctx, ws);
  if (method === "GET" && path === "/api/proposals") return await getProposals(res, ctx);
  if (method === "POST" && path.startsWith("/api/proposals/")) return await postMergeProposal(res, ctx, ws, path, policy);
  if (method === "POST" && path === "/api/sync") return await postSync(res, ctx, ws);

  // Admin — manage the access policy (commits to canonical `main`) + an operational overview.
  if (method === "GET" && path === "/api/access") return getAccess(res, ws, policy);
  if (method === "PUT" && path === "/api/access") return await putAccess(req, res, ctx, ws, policy);
  if (method === "DELETE" && path === "/api/access") return await deleteAccess(res, ctx, ws, policy);
  if (method === "GET" && path === "/api/admin/overview") return await getOverview(res, ctx, ws, policy);

  sendJson(res, 404, { error: "not found" });
}

// ---- review flow (Phase 2) ----------------------------------------------------------------------

/** The configured review flow, or a 400 telling the caller it isn't enabled on this deployment. */
function requireReview(ctx: Ctx): ReviewConfig {
  if (!ctx.review) throw new BadRequest("review flow not enabled on this server");
  return ctx.review;
}

/** Push the caller's branch and open (or return) its PR. Upstream failures surface as 502, not 500. */
async function postProposal(res: ServerResponse, ctx: Ctx, ws: Workspace): Promise<void> {
  const review = requireReview(ctx);
  try {
    const proposal = await submitForReview(ws, review);
    sendJson(res, 200, proposal);
  } catch (err) {
    throw new BadGateway(err instanceof Error ? err.message : String(err));
  }
}

async function getProposals(res: ServerResponse, ctx: Ctx): Promise<void> {
  const review = requireReview(ctx);
  try {
    sendJson(res, 200, { proposals: await listProposals(review) });
  } catch (err) {
    throw new BadGateway(err instanceof Error ? err.message : String(err));
  }
}

/** Merge a proposal (admin only) — `POST /api/proposals/<n>/merge`. */
async function postMergeProposal(res: ServerResponse, ctx: Ctx, ws: Workspace, path: string, policy: AccessPolicy | null): Promise<void> {
  const review = requireReview(ctx);
  const n = Number(refSegments(path, "/api/proposals/")[0]);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest("bad proposal number");
  // Admin comes from access.yaml when present (Phase 3), else the KB_ADMINS list on the review config.
  const admin = policy !== null ? isAccessAdmin(policy, ws.actor.email) : isAdmin(review, ws);
  if (!admin) throw new Forbidden("only an admin can merge a proposal");
  try {
    await mergeProposal(review, n);
  } catch (err) {
    throw new BadGateway(err instanceof Error ? err.message : String(err));
  }
  // The PR is merged on the forge; catch the deployment's local `main` up so drafts + new worktrees see
  // it. Best-effort — a failure here doesn't undo the merge, so it must not fail the response.
  if (ctx.repoDir) {
    try {
      await refreshBase(ctx.repoDir, review.remote, review.baseBranch);
    } catch (err) {
      process.stderr.write(`kb-studio: base refresh after merge failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  sendJson(res, 200, { ok: true });
}

/** Bring the base branch into the caller's draft (`POST /api/sync`); a conflict is reported, not thrown. */
async function postSync(res: ServerResponse, ctx: Ctx, ws: Workspace): Promise<void> {
  const review = requireReview(ctx);
  const result = await syncFromMain(ws, review);
  sendJson(res, 200, result);
}

// ---- admin: access policy + overview ------------------------------------------------------------

/** `GET /api/access` — the policy the Admin page edits. `configured:false` = open mode (no access.yaml). */
function getAccess(res: ServerResponse, ws: Workspace, policy: AccessPolicy | null): void {
  guardAdmin(policy, ws.actor, "view the access policy");
  sendJson(res, 200, { configured: policy !== null, ...policyToData(policy) });
}

/**
 * `PUT /api/access` — write the access policy to the CANONICAL `access.yaml` and commit it, so it takes
 * effect immediately (readAccess is mtime-cached off that file). Admin-only, but a no-op guard in open
 * mode — which is exactly the first-admin bootstrap: the first save names an admin and turns enforcement on.
 */
async function putAccess(req: IncomingMessage, res: ServerResponse, ctx: Ctx, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  guardAdmin(policy, ws.actor, "change the access policy");
  const data = validateAccessBody(await readBody(req));
  const file = join(ctx.canonicalKbDir, "access.yaml");
  const contents = renderAccessYaml(data);
  await ctx.canonicalGit.commit({
    actor: ws.actor,
    message: "kb: update access policy",
    mutate: () => ctx.canonicalGit.atomicWrite(file, contents),
  });
  await pushCanonical(ctx);
  sendJson(res, 200, { ok: true });
}

/** `DELETE /api/access` — remove `access.yaml`, returning the deployment to open mode. Admin-only. */
async function deleteAccess(res: ServerResponse, ctx: Ctx, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  guardAdmin(policy, ws.actor, "disable access control");
  const file = join(ctx.canonicalKbDir, "access.yaml");
  if (!existsSync(file)) throw new NotFound("access control is already off (no access.yaml)");
  await ctx.canonicalGit.commit({
    actor: ws.actor,
    message: "kb: disable access control (remove access.yaml)",
    mutate: () => rmSync(file),
  });
  await pushCanonical(ctx);
  sendJson(res, 200, { ok: true });
}

/** Publish a canonical-tree commit to the remote base branch (multi-user only). A push failure is a 502. */
async function pushCanonical(ctx: Ctx): Promise<void> {
  if (!ctx.review || !ctx.repoDir) return; // single/dev mode: commit locally, nothing to push
  try {
    await ctx.canonicalGit.push(ctx.review.remote, ctx.review.baseBranch);
  } catch (err) {
    throw new BadGateway(
      `saved locally but push to ${ctx.review.remote}/${ctx.review.baseBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Validate + normalize a `PolicyData` body. Rejects a zero-admin policy (that would lock everyone out). */
function validateAccessBody(body: Record<string, unknown>): PolicyData {
  const admins = emailList(body["admins"], "admins");
  if (admins.length < 1) throw new BadRequest("at least one admin is required — use DELETE /api/access to turn access control off");
  const usersRaw = body["users"];
  if (!Array.isArray(usersRaw)) throw new BadRequest("users must be an array");
  const users = usersRaw.map((u) => {
    const email = u !== null && typeof u === "object" ? (u as Record<string, unknown>)["email"] : undefined;
    if (typeof email !== "string" || email.trim() === "") throw new BadRequest("each user needs a non-empty email");
    return { email: email.trim(), scopes: scopeList((u as Record<string, unknown>)["scopes"]) };
  });
  return { admins, users, defaultScopes: scopeList(body["defaultScopes"]) };
}

/** A list of non-empty, trimmed email strings. */
function emailList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new BadRequest(`${what} must be an array`);
  return value.map((e) => {
    if (typeof e !== "string" || e.trim() === "") throw new BadRequest(`each ${what} entry must be a non-empty email`);
    return e.trim();
  });
}

/** A list of scope prefixes; each is an array of safe path segments (an empty [] = the root). */
function scopeList(value: unknown): string[][] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequest("scopes must be an array of path arrays");
  return value.map((scope) => {
    if (!Array.isArray(scope) || !scope.every((s) => typeof s === "string" && SEGMENT_RE.test(s))) {
      throw new BadRequest(`unsafe scope ${JSON.stringify(scope)}`);
    }
    return scope as string[];
  });
}

/** `GET /api/admin/overview` — deployment mode + who has an open draft branch (Users & Activity, Status). */
async function getOverview(res: ServerResponse, ctx: Ctx, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  guardAdmin(policy, ws.actor, "view the admin overview");
  const branches = ctx.repoDir ? await listUserBranches(ctx.repoDir) : [];
  sendJson(res, 200, {
    mode: ctx.repoDir ? "multi" : "single",
    reviewEnabled: ctx.review !== null,
    accessConfigured: policy !== null,
    kbAdmins: ctx.review?.admins ?? [],
    branches,
  });
}

/** The per-user draft branches (`user/<login>`) with their last commit — best-effort, `[]` on any error. */
async function listUserBranches(repoDir: string): Promise<{ branch: string; login: string; author: string; date: string; message: string }[]> {
  try {
    const fmt = ["%(refname:short)", "%(authorname)", "%(committerdate:iso-strict)", "%(subject)"].join("\x1f");
    const out = await simpleGit(repoDir).raw(["for-each-ref", `--format=${fmt}`, "refs/heads/user/"]);
    return out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((line) => {
        const [branch = "", author = "", date = "", ...subj] = line.split("\x1f");
        return { branch, login: branch.replace(/^user\//, ""), author, date, message: subj.join("\x1f") };
      });
  } catch {
    return [];
  }
}

// ---- path helpers -------------------------------------------------------------------------------

/** Split a `/api/…/a/b/c` URL tail into decoded segments, guarding each against `SEGMENT_RE`. */
function refSegments(path: string, prefix: string): string[] {
  return path
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
}

/** A body field that must be an array of safe path segments. Throws BadRequest otherwise. */
function safePath(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((s) => typeof s === "string" && SEGMENT_RE.test(s))) {
    throw new BadRequest(`unsafe ${what} ${JSON.stringify(value)}`);
  }
  return value as string[];
}

/** Count the `.yaml` topics anywhere under a directory subtree. */
function countSubtreeTopics(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith(".yaml")) n++;
    else if (ent.isDirectory()) n += countSubtreeTopics(join(dir, ent.name));
  }
  return n;
}

/** Every directory anywhere under a subtree (including empty ones), as segment paths relative to `base`. */
function collectDirs(base: string, prefix: string[] = []): string[][] {
  const here = join(base, ...prefix);
  const out: string[][] = [];
  if (!existsSync(here)) return out;
  for (const ent of readdirSync(here, { withFileTypes: true })) {
    if (ent.isDirectory() && SEGMENT_RE.test(ent.name)) {
      const path = [...prefix, ent.name];
      out.push(path);
      out.push(...collectDirs(base, path));
    }
  }
  return out;
}

/** Every topic file under a subtree, with its full folder-derived path (relative to `topics/`). */
function collectSubtree(kbDir: string, prefix: string[]): { path: string[]; id: string; file: string }[] {
  const base = join(kbDir, "topics", ...prefix);
  const out: { path: string[]; id: string; file: string }[] = [];
  if (!existsSync(base)) return out;
  for (const ent of readdirSync(base, { withFileTypes: true })) {
    if (ent.isDirectory() && SEGMENT_RE.test(ent.name)) out.push(...collectSubtree(kbDir, [...prefix, ent.name]));
    else if (ent.isFile() && ent.name.endsWith(".yaml")) {
      out.push({ path: prefix, id: ent.name.slice(0, -".yaml".length), file: join(base, ent.name) });
    }
  }
  return out;
}

// ---- topics ------------------------------------------------------------------------------------

/** A short content hash used as an optimistic-concurrency token for a topic file. */
function version(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** The manifest plus a `versions` map (topicKey → content hash) the UI sends back as `baseVersion`. */
function manifestWithVersions(kbDir: string): Record<string, unknown> {
  const manifest = readManifestDir(kbDir);
  const versions: Record<string, string> = {};
  for (const t of manifest.topics) {
    const file = topicPath(kbDir, t.path, t.id);
    if (existsSync(file)) versions[[...t.path, t.id].join("/")] = version(readFileSync(file, "utf8"));
  }
  return { ...manifest, versions };
}

async function postTopic(req: IncomingMessage, res: ServerResponse, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  const body = await readBody(req);
  const topic = parseTopic(body["topic"]); // ConfigError → 422 on a malformed topic
  if (!TOPIC_ID_RE.test(topic.id)) throw new BadRequest(`unsafe topic id "${topic.id}"`);

  const path = topicPath(kbDir, topic.path, topic.id);
  const prev = previousTopicRef(kbDir, body["previous"], topic); // a rename/move source, or null
  guardScope(policy, actor, topic.path, prev ? "move" : "save");
  if (prev) guardScope(policy, actor, prev.path, "move"); // moving OUT of a node needs scope there too

  // Optimistic concurrency: if the caller sent the version it edited from and the on-disk file has moved
  // since (another tab, or a shared workspace), refuse with 409 + the current copy instead of clobbering.
  const baseVersion = typeof body["baseVersion"] === "string" ? body["baseVersion"] : null;
  const checkFile = prev ? prev.file : path;
  if (baseVersion !== null && existsSync(checkFile)) {
    const onDisk = readFileSync(checkFile, "utf8");
    const currentVersion = version(onDisk);
    if (currentVersion !== baseVersion) {
      return sendJson(res, 409, { error: "this topic changed since you opened it", current: parseTopic(parseYaml(onDisk)), currentVersion });
    }
  }

  const content = renderTopicFile(topic);
  await git.commit({
    actor,
    message: `kb: ${prev ? "rename" : "save"} topic ${topic.path.join("/")}/${topic.id}`,
    // Write the new file first, then delete the old one, so a failure never orphans (unchanged order).
    mutate: () => {
      mkdirSync(dirname(path), { recursive: true });
      git.atomicWrite(path, content);
      if (prev && existsSync(prev.file)) rmSync(prev.file);
    },
  });

  sendJson(res, 200, { ok: true, version: version(content) });
}

/**
 * Resolve a rename/move source from the optional `previous: {path, id}` body field — its on-disk `file`
 * (to delete) and `path` (to scope-check) — or null when absent, malformed, or the same identity.
 * Segment/id safety is re-checked here so a crafted `previous` can never delete outside `topics/`.
 */
function previousTopicRef(kbDir: string, previous: unknown, topic: Topic): { file: string; path: string[] } | null {
  if (previous === null || typeof previous !== "object") return null;
  const p = previous as Record<string, unknown>;
  const pPath = p["path"];
  const pId = p["id"];
  if (
    Array.isArray(pPath) &&
    pPath.every((s) => typeof s === "string" && SEGMENT_RE.test(s)) &&
    pPath.length > 0 &&
    typeof pId === "string" &&
    TOPIC_ID_RE.test(pId) &&
    ((pPath as string[]).join("/") !== topic.path.join("/") || pId !== topic.id)
  ) {
    return { file: topicPath(kbDir, pPath as string[], pId), path: pPath as string[] };
  }
  return null;
}

async function deleteTopic(res: ServerResponse, ws: Workspace, path: string, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  const parts = refSegments(path, "/api/topics/"); // [seg, seg, …, id]
  const id = parts.pop() ?? "";
  if (parts.length === 0 || !parts.every((s) => SEGMENT_RE.test(s)) || !TOPIC_ID_RE.test(id)) {
    throw new BadRequest("bad topic ref");
  }
  guardScope(policy, actor, parts, "delete");

  const target = topicPath(kbDir, parts, id);
  if (!existsSync(target)) throw new NotFound("no such topic");
  await git.commit({
    actor,
    message: `kb: delete topic ${parts.join("/")}/${id}`,
    mutate: () => rmSync(target),
  });
  sendJson(res, 200, { ok: true });
}

function renderTopicFile(topic: Topic): string {
  const header = topic.kind === "canary" ? CANARY_HEADER : REAL_HEADER;
  // Explicit key order for stable, readable diffs (id, path, title, kind, questions).
  const ordered = { id: topic.id, path: topic.path, title: topic.title, kind: topic.kind, questions: topic.questions };
  return header + stringifyYaml(ordered);
}

// ---- meta + export ------------------------------------------------------------------------------

async function putMeta(req: IncomingMessage, res: ServerResponse, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  guardAdmin(policy, actor, "edit the manifest identity"); // meta is a KB-wide setting
  const body = await readBody(req);
  const id = body["id"];
  const version = body["version"];
  if (typeof id !== "string" || id.trim() === "" || typeof version !== "string" || version.trim() === "") {
    throw new BadRequest("id and version must be non-empty strings");
  }
  // Preserve existing meta; allow explicit updates. Identity, the subject, and level labels share the file.
  const meta: Record<string, unknown> = { ...readMetaObject(kbDir), id, version };
  const subject = body["subject"];
  if (subject === "" || subject === null) delete meta["subject"];
  else if (typeof subject === "string") meta["subject"] = subject;
  if (body["levels"] !== undefined) meta["levels"] = body["levels"];

  // Build (and validate `levels` via declaredLevels) BEFORE the commit, so a bad request never lands a
  // no-op commit; the mutation then only writes bytes.
  const contents = renderMeta(meta);
  await git.commit({
    actor,
    message: `kb: update manifest identity (${id} ${version})`,
    mutate: () => git.atomicWrite(join(kbDir, "manifest.meta.yaml"), contents),
  });
  sendJson(res, 200, { ok: true });
}

/** Serialize `manifest.meta.yaml` content — `{ id, version }`, the subject, and the level LABELS. */
function renderMeta(meta: Record<string, unknown>): string {
  const out: Record<string, unknown> = { id: meta["id"], version: meta["version"] };
  if (typeof meta["subject"] === "string" && meta["subject"].trim() !== "") out["subject"] = meta["subject"];
  const levels = declaredLevels(meta); // throws ConfigError → 422 on a bad label
  if (levels.length) out["levels"] = levels;
  return META_HEADER + stringifyYaml(out);
}

// ---- nodes (taxonomy path folders) --------------------------------------------------------------

/** Create a node: make its (empty) folder subtree so it shows up before it has topics. */
async function postNode(req: IncomingMessage, res: ServerResponse, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  const body = await readBody(req);
  const path = safePath(body["path"], "node path");
  guardScope(policy, actor, path, "create a node at");
  // git doesn't track empty dirs, so this commit is typically a no-op — the folder still exists on disk
  // for listNodes, and it becomes real history the moment the node holds a topic.
  await git.commit({
    actor,
    message: `kb: create node ${path.join("/")}`,
    mutate: () => mkdirSync(join(kbDir, "topics", ...path), { recursive: true }),
  });
  sendJson(res, 200, { ok: true });
}

/** Rename/move a node: move its subtree, prefix-rewriting each contained topic's `path`. */
async function putNode(req: IncomingMessage, res: ServerResponse, ws: Workspace, path: string, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  const from = refSegments(path, "/api/nodes/");
  if (from.length === 0 || !from.every((s) => SEGMENT_RE.test(s))) throw new BadRequest("bad node ref");
  const body = await readBody(req);
  const to = safePath(body["to"], "target path");
  if (from.join("/") === to.join("/")) return sendJson(res, 200, { ok: true, moved: 0 });
  // A move must be within scope on BOTH sides, or it could smuggle a subtree across an ownership boundary.
  guardScope(policy, actor, from, "move");
  guardScope(policy, actor, to, "move into");

  const fromDir = join(kbDir, "topics", ...from);
  const toDir = join(kbDir, "topics", ...to);
  if (countSubtreeTopics(toDir) > 0) throw new BadRequest(`target "${to.join("/")}" already exists and has topics`);

  // Re-path + RE-VALIDATE every moved topic up front (ConfigError → 422), so the commit's mutation is
  // pure fs work that can't throw halfway and leave a partial move uncommitted in the working tree.
  const dirs = collectDirs(fromDir);
  const moves = collectSubtree(kbDir, from).map((item) => {
    const raw = parseYaml(readFileSync(item.file, "utf8")) as Record<string, unknown>;
    const newPath = [...to, ...item.path.slice(from.length)]; // replace the `from` prefix with `to`
    const topic = parseTopic({ ...raw, path: newPath });
    return { src: item.file, dest: topicPath(kbDir, topic.path, topic.id), contents: renderTopicFile(topic) };
  });

  await git.commit({
    actor,
    message: `kb: move node ${from.join("/")} → ${to.join("/")} (${String(moves.length)} topic(s))`,
    mutate: () => {
      // Recreate the full directory shape FIRST — including topic-less branches — so an empty subtree
      // still exists at `to` after `fromDir` is removed.
      mkdirSync(toDir, { recursive: true });
      for (const rel of dirs) mkdirSync(join(toDir, ...rel), { recursive: true });
      // Write-new-then-remove per file, so a mid-move failure never orphans a topic.
      for (const m of moves) {
        mkdirSync(dirname(m.dest), { recursive: true });
        git.atomicWrite(m.dest, m.contents);
        rmSync(m.src);
      }
      if (existsSync(fromDir)) rmSync(fromDir, { recursive: true, force: true });
    },
  });
  sendJson(res, 200, { ok: true, moved: moves.length });
}

/** Delete a node: refuses a non-empty subtree unless `?cascade=1`, which also removes its topic files. */
async function deleteNode(req: IncomingMessage, res: ServerResponse, ws: Workspace, path: string, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  const node = refSegments(path, "/api/nodes/");
  if (node.length === 0 || !node.every((s) => SEGMENT_RE.test(s))) throw new BadRequest("bad node ref");
  guardScope(policy, actor, node, "delete");
  const url = new URL(req.url ?? "", "http://localhost");
  const cascade = url.searchParams.get("cascade") === "1";
  const dir = join(kbDir, "topics", ...node);
  const count = countSubtreeTopics(dir);
  if (count && !cascade) {
    throw new BadRequest(
      `node "${node.join("/")}" has ${String(count)} topic(s) — move or delete them first, or pass ?cascade=1.`,
    );
  }
  // A cascade wipes a whole subtree — require the caller to echo the node path (type-to-confirm), so a
  // stray click can't nuke a populated node. (Every removed file is still restorable from history.)
  if (count && cascade && url.searchParams.get("confirm") !== node.join("/")) {
    throw new BadRequest(`cascade delete of "${node.join("/")}" needs confirm=${node.join("/")}`);
  }
  await git.commit({
    actor,
    message: `kb: delete node ${node.join("/")}${count ? ` (${String(count)} topic(s))` : ""}`,
    mutate: () => {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  });
  sendJson(res, 200, { ok: true, deleted: count });
}

function postExport(res: ServerResponse, ws: Workspace): void {
  const { kbDir, git } = ws;
  const manifest = readManifestDir(kbDir); // ConfigError → 422 if the folder is invalid
  const path = join(kbDir, "manifest.yaml");
  // A derived, gitignored artifact — write it atomically but don't commit (Phase 0 gitignores it).
  git.atomicWrite(path, renderManifestYaml(manifest));
  sendJson(res, 200, { ok: true, path, topics: manifest.topics.length });
}

// ---- history + restore (the safety net's read + recovery surface) -------------------------------

/**
 * `GET /api/history` → recent KB commits + deleted topics (the History/Trash panel). `?path=<seg…/id>`
 * narrows to one topic's commit log (no deletions). Empty arrays when the KB dir isn't a git repo.
 */
async function getHistory(req: IncomingMessage, res: ServerResponse, ws: Workspace): Promise<void> {
  const { kbDir, git } = ws;
  const url = new URL(req.url ?? "", "http://localhost");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const pathParam = url.searchParams.get("path");

  let absPath: string | undefined;
  if (pathParam) {
    const segs = pathParam.split("/").filter(Boolean);
    const id = segs.pop() ?? "";
    if (segs.length === 0 || !segs.every((s) => SEGMENT_RE.test(s)) || !TOPIC_ID_RE.test(id)) {
      throw new BadRequest("bad history path");
    }
    absPath = topicPath(kbDir, segs, id);
  }

  const commits = await git.logCommits(absPath, limit);
  const deletions = absPath ? [] : await git.listDeletions(limit);
  sendJson(res, 200, { commits, deletions });
}

/** `POST /api/restore { sha, path, id }` → bring a topic file back from a prior commit, as a new commit. */
async function postRestore(req: IncomingMessage, res: ServerResponse, ws: Workspace, policy: AccessPolicy | null): Promise<void> {
  const { kbDir, git, actor } = ws;
  const body = await readBody(req);
  const sha = body["sha"];
  // A git revision the History/Trash view handed us: a hex sha, optionally with a `~N`/`^` suffix.
  if (typeof sha !== "string" || !/^[0-9a-f]{4,40}(?:~\d+|\^+)?$/i.test(sha)) throw new BadRequest("bad sha");
  const path = safePath(body["path"], "restore path");
  const id = body["id"];
  if (typeof id !== "string" || !TOPIC_ID_RE.test(id)) throw new BadRequest("bad restore id");
  guardScope(policy, actor, path, "restore");

  const absPath = topicPath(kbDir, path, id);
  try {
    await git.restore({ sha, absPath, actor, message: `kb: restore topic ${path.join("/")}/${id}` });
  } catch {
    throw new NotFound("nothing to restore at that revision");
  }
  sendJson(res, 200, { ok: true });
}

// ---- coverage (read-only) -----------------------------------------------------------------------

function listCoverage(res: ServerResponse, coverageDir: string): void {
  if (!existsSync(coverageDir)) return sendJson(res, 200, []);
  const summaries = readdirSync(coverageDir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const r = JSON.parse(readFileSync(join(coverageDir, file), "utf8")) as Record<string, unknown>;
      return {
        file,
        generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
        manifestId: r["manifestId"] ?? null,
        manifestVersion: r["manifestVersion"] ?? null,
        source: r["source"] ?? null,
        totals: r["totals"] ?? null,
        metrics: r["metrics"] ?? null,
      };
    })
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || b.file.localeCompare(a.file));
  sendJson(res, 200, summaries);
}

function getCoverage(req: IncomingMessage, res: ServerResponse, coverageDir: string, path: string): void {
  const file = decodeURIComponent(path.split("/").filter(Boolean)[2] ?? "");
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file) || file.includes("..")) throw new BadRequest("bad filename");
  const p = join(coverageDir, file);
  if (!existsSync(p)) throw new NotFound("no such report");
  const report = JSON.parse(readFileSync(p, "utf8")) as CoverageReport;
  // `?tree=1`: attach the per-level rollup so the browser gets it without importing the engine (which
  // would drag a provider SDK into the bundle). The rollup is a pure fold — computing it here is free.
  const wantTree = new URL(req.url ?? "", "http://localhost").searchParams.get("tree") === "1";
  sendJson(res, 200, wantTree ? { ...report, tree: rollup(report).root } : report);
}

// ---- static front-end ---------------------------------------------------------------------------

function serveHtml(res: ServerResponse): void {
  const indexPath = join(DIST, "index.html");
  if (existsSync(indexPath)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(indexPath, "utf8"));
    return;
  }
  // No build yet — a hermetic placeholder so `GET /` works (and the test asserts "KB Studio") without
  // running Vite. `pnpm studio` serves the real UI via Vite; `vite build` populates dist/.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    "<!doctype html><meta charset=utf-8><title>KB Studio</title><h1>KB Studio</h1>" +
      "<p>UI not built. Run <code>pnpm studio</code> for dev, or <code>pnpm --filter @evaluator/studio build</code>.</p>",
  );
}

function serveStatic(res: ServerResponse, path: string): void {
  const rel = path.replace(/^\/+/, "");
  if (rel !== "" && !rel.includes("..")) {
    const file = join(DIST, rel);
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "content-type": contentType(file) });
      res.end(readFileSync(file));
      return;
    }
  }
  // A request with a file extension is an ASSET (e.g. /assets/index-abc.js). If it isn't in dist/, that
  // is a genuine 404 — NEVER fall back to index.html, or the browser receives HTML for a
  // `<script type=module>` and dies. The SPA fallback is only for extensionless navigation routes.
  if (/\.[a-z0-9]+$/i.test(rel)) return sendJson(res, 404, { error: "not found" });
  serveHtml(res);
}

function contentType(file: string): string {
  const ext = extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  return map[ext] ?? "application/octet-stream";
}

// ---- plumbing -----------------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString()));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
  if (raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequest("invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object") throw new BadRequest("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof BadRequest) return sendJson(res, 400, { error: err.message });
  if (err instanceof Forbidden) return sendJson(res, 403, { error: err.message });
  if (err instanceof NotFound) return sendJson(res, 404, { error: err.message });
  if (err instanceof Conflict) return sendJson(res, 409, { error: err.message });
  if (err instanceof ConfigError) return sendJson(res, 422, { error: err.message });
  if (err instanceof BadGateway) return sendJson(res, 502, { error: err.message });
  process.stderr.write(`kb-studio: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  sendJson(res, 500, { error: "internal error" });
}

// ---- entrypoint (the only place that listens) ---------------------------------------------------

/** Build the review flow from env: needs a GitHub token + `owner/repo`. Absent → no review flow. */
function reviewFromEnv(): ReviewConfig | undefined {
  const token = process.env["KB_GITHUB_TOKEN"];
  const repo = process.env["KB_GITHUB_REPO"]; // "owner/repo"
  const [owner, name] = (repo ?? "").split("/");
  if (!token || !owner || !name) return undefined;
  const admins = (process.env["KB_ADMINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    forge: createGitHubForge({ token, owner, repo: name }),
    remote: process.env["KB_REVIEW_REMOTE"] ?? "origin",
    baseBranch: process.env["KB_REVIEW_BASE"] ?? "main",
    admins,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kbDir = process.env["KB_DIR"] ?? join(process.cwd(), "kb");
  const coverageDir = process.env["KB_COVERAGE_DIR"] ?? join(process.cwd(), "kb-coverage");
  const port = Number(process.env["KB_STUDIO_PORT"] ?? "4319");

  // Multi-user (branch-per-user) mode: opt in with KB_MULTI_USER=1. Needs the repo root + a worktrees dir
  // OUTSIDE it, and MUST sit behind the SSO proxy — so it binds all interfaces (the proxy is the only gate,
  // and the trusted identity header is honored). Single mode stays loopback-only, exactly as before.
  const multiUser =
    process.env["KB_MULTI_USER"] === "1"
      ? {
          repoDir: process.env["KB_REPO_DIR"] ?? process.cwd(),
          worktreesDir: process.env["KB_WORKTREES_DIR"] ?? join(process.cwd(), ".kb-worktrees"),
        }
      : undefined;
  const review = multiUser ? reviewFromEnv() : undefined; // review only makes sense per-user branch
  const host = multiUser ? "0.0.0.0" : "127.0.0.1";

  createStudioServer({
    kbDir,
    coverageDir,
    ...(multiUser ? { multiUser } : {}),
    ...(review ? { review } : {}),
  }).listen(port, host, () => {
    process.stdout.write(
      `\n  KB Studio → http://${host}:${String(port)}\n` +
        `  authoring ${kbDir}${multiUser ? `  (multi-user: worktrees in ${multiUser.worktreesDir})` : ""}` +
        `${review ? "  (review: PRs enabled)" : ""}\n  viewing   ${coverageDir}\n\n`,
    );
  });
}
