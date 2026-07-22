/**
 * KB Studio — a browser tool to author the manifest and view coverage reports, backed by MongoDB.
 *
 * A `node:http` JSON API over the Mongo store (`workspaces`/`topics`/`config`/`revisions`) plus a static
 * server for the built front-end (`dist/`). It is a FRONT-END: it does its own storage I/O and never
 * touches a provider SDK (lint-walled). It does NOT run coverage probes — that needs a model + the
 * engine's `Run`, which is the CLI's job; the Studio authors the manifest and VIEWS the reports the CLI
 * writes into `coverageDir`.
 *
 * Storage model: `main` is the canonical KB (admins edit it directly); each author works in a personal
 * `workspaces.<slug>` copy cloned from main on first write; viewers are read-only. Correctness on a
 * STANDALONE mongod comes from hash-guarded single-doc ops + ONE process-wide write mutex — every
 * mutating request runs under `ctx.mutex`, so multi-doc sequences (clone/sync/merge) get a total order
 * and reads never block. Path segments + ids are validated before every write, so a crafted request
 * cannot reach an unsafe key.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Mutex } from "async-mutex";
import { ConfigError, rollup, type CoverageReport, type Topic } from "@evaluator/core";

import {
  canWrite,
  isAdmin as isAccessAdmin,
  policyToData,
  roleFor,
  scopesFor,
  withGrantedScopes,
  type AccessPolicy,
  type PolicyData,
  type Role,
} from "./access";
import { countPending, getRequest, listPending, pendingFor, resolveRequest, submitRequest } from "./access-requests";
import { readPolicy, seedPolicy, writePolicy } from "./access-store";
import { DEFAULT_ACTOR, makeActorResolver, type Actor } from "./actor";
import { connectDb, ensureIndexes, type DbHandle, type EvalRunDoc, type EvalScope, type TopicSnapshot, type WorkspaceMeta } from "./db";
import { appendRevision, getRevision, listDeletions, listHistory } from "./history";
import type { EndpointConfig } from "./llm-factory";
import { declaredLevels, parseTopic, renderManifestYaml, SEGMENT_RE, TOPIC_ID_RE } from "./manifest-folder";
import { mergeToMain, resolveConflict, syncFromMain } from "./merge";
import { importKb } from "./migrate";
import { getProposal, listProposals, requestReview, withdrawReview } from "./proposals";
import { EvalRunner, TooManyRuns } from "./runner";
import { atomicWrite, docToTopic, HashConflict, MAIN, ManifestStore, topicKeyOf } from "./store";
import { ensureUserWorkspace, intendedWorkspace, loginSlug, readWorkspace } from "./workspaces";

export interface StudioOptions {
  /** The connected database (injected so tests can point at an in-memory mongod). */
  db: DbHandle;
  /** Where coverage runs are written by the CLI: `<id>-<epoch>.json` (shared, read-only). */
  coverageDir: string;
  /** Where `POST /api/export` writes `manifest.yaml` (the evaluator CLI consumes YAML). */
  exportDir: string;
  /**
   * Trust the SSO proxy's identity header and route authors to their own workspace. When absent,
   * everyone is one dev actor on `main` (the single-user local experience).
   */
  multiUser?: boolean;
}

/** The built front-end lives here after `vite build`. Absent in a fresh checkout / in tests. */
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

/**
 * The sub-path the app is mounted under (e.g. "/kb-studio"), normalised to a leading slash and no
 * trailing slash, or "" for root. Must match the UI's Vite `base` (see vite.config.ts). Requests may
 * arrive WITH this prefix (an outer proxy that preserves the path) or WITHOUT it (a proxy that rewrites
 * `/kb-studio/*` → `/*`); `stripBase` folds both to the root-relative paths the router matches, so the
 * deployment works either way.
 */
/** Normalise a raw `KB_BASE_PATH` (e.g. "kb-studio", "/kb-studio/") to a leading slash + no trailing, or "". */
export function normalizeBasePath(raw: string | undefined): string {
  const inner = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return inner ? `/${inner}` : "";
}

/** Remove the mount prefix from an incoming pathname, if present, so routing is always root-relative. */
export function stripBase(path: string, base: string): string {
  if (!base) return path;
  if (path === base) return "/";
  if (path.startsWith(`${base}/`)) return path.slice(base.length);
  return path;
}

const BASE_PATH = normalizeBasePath(process.env["KB_BASE_PATH"]);

/** A malformed request (bad path ref, unparseable body) → 400. */
class BadRequest extends Error {}
/** A well-formed request for a thing that isn't there → 404. */
class NotFound extends Error {}
/** The actor is not allowed to touch this path (scoping / admin op) → 403. */
class Forbidden extends Error {}

/** Everything a request handler needs: the store, the write mutex, shared dirs, and identity. */
interface Ctx {
  db: DbHandle;
  store: ManifestStore;
  runner: EvalRunner;
  mutex: Mutex;
  coverageDir: string;
  exportDir: string;
  multiUser: boolean;
  resolveActor: (req: IncomingMessage) => Actor;
}

export function createStudioServer(opts: StudioOptions): Server {
  const store = new ManifestStore(opts.db);
  const runner = new EvalRunner(opts.db, store);
  // A run that outlived a previous process left a stale `running` doc (its keys are gone); reap it.
  void runner.reapOrphans();
  const ctx: Ctx = {
    db: opts.db,
    store,
    runner,
    mutex: new Mutex(),
    coverageDir: opts.coverageDir,
    exportDir: opts.exportDir,
    multiUser: opts.multiUser ?? false,
    resolveActor: makeActorResolver({ trustProxy: opts.multiUser === true }),
  };
  return createServer((req, res) => {
    void handle(req, res, ctx);
  });
}

/**
 * First-boot bootstrap: ensure indexes, auto-import the YAML KB into `main` when the folder is present
 * and main is empty, and seed the access policy when none exists. Idempotent — safe on every boot.
 */
export async function bootstrapKb(db: DbHandle, opts: { kbDir: string; seedAdmins: string[]; actor: Actor }): Promise<void> {
  await ensureIndexes(db);
  const main = await db.workspaces.findOne({ _id: MAIN });
  if (!main && existsSync(join(opts.kbDir, "manifest.meta.yaml"))) {
    try {
      await importKb(db, opts.kbDir, { seedAdmins: opts.seedAdmins, actor: opts.actor });
    } catch (err) {
      process.stderr.write(`kb-studio: first-boot auto-import skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  const cfg = await db.config.findOne({ _id: "access" });
  if (!cfg) await seedPolicy(db, opts.seedAdmins, opts.actor);
}

// ---- authorization helpers ----------------------------------------------------------------------

/** Enforce topic scoping before a write. */
function guardScope(policy: AccessPolicy | null, actor: Actor, path: string[], verb = "edit"): void {
  if (!canWrite(policy, actor.email, path)) {
    throw new Forbidden(`not allowed to ${verb} "${path.join("/")}" — outside your assigned scope`);
  }
}

/** Enforce an admin-only op. */
function guardAdmin(policy: AccessPolicy | null, actor: Actor, verb: string): void {
  if (!isAccessAdmin(policy, actor.email)) throw new Forbidden(`only an admin can ${verb}`);
}

/** Resolve identity + role + the workspace a READ should serve (an author's copy, or main). */
async function resolveRead(ctx: Ctx, req: IncomingMessage): Promise<{ actor: Actor; role: Role; policy: AccessPolicy | null; ws: string }> {
  const actor = ctx.resolveActor(req);
  const policy = await readPolicy(ctx.db);
  const role = roleFor(policy, actor.email);
  const ws = await readWorkspace(ctx.db, role, actor);
  return { actor, role, policy, ws };
}

/** Run a mutating handler under the process write mutex, with resolved identity + policy. */
function handleWrite(ctx: Ctx, req: IncomingMessage, fn: (actor: Actor, role: Role, policy: AccessPolicy | null) => Promise<void>): Promise<void> {
  const actor = ctx.resolveActor(req);
  return ctx.mutex.runExclusive(async () => {
    const policy = await readPolicy(ctx.db);
    const role = roleFor(policy, actor.email);
    await fn(actor, role, policy);
  });
}

/** The workspace a WRITE lands in — an author's copy (cloned on first write) or main. In-mutex only. */
function targetWs(ctx: Ctx, actor: Actor, role: Role): Promise<string> {
  return role === "author" ? ensureUserWorkspace(ctx.db, ctx.store, actor) : Promise.resolve(MAIN);
}

// ---- top-level routing --------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  try {
    const path = stripBase(new URL(req.url ?? "/", "http://localhost").pathname, BASE_PATH);
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/") return serveHtml(res);
    if (method === "GET" && path === "/api/coverage") return listCoverage(res, ctx.coverageDir);
    if (method === "GET" && path.startsWith("/api/coverage/")) return getCoverage(req, res, ctx.coverageDir, path);
    if (method === "GET" && !path.startsWith("/api/")) return serveStatic(res, path);

    if (path.startsWith("/api/")) return await handleKb(req, res, ctx, method, path);

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendError(res, err);
  }
}

async function handleKb(req: IncomingMessage, res: ServerResponse, ctx: Ctx, method: string, path: string): Promise<void> {
  if (method === "GET" && path === "/api/whoami") return await getWhoami(req, res, ctx);
  if (method === "GET" && path === "/api/manifest") return await getManifest(req, res, ctx);
  if (method === "POST" && path === "/api/topics") return await postTopic(req, res, ctx);
  if (method === "DELETE" && path.startsWith("/api/topics/")) return await deleteTopic(req, res, ctx, path);
  if (method === "PUT" && path === "/api/meta") return await putMeta(req, res, ctx);
  if (method === "POST" && path === "/api/export") return await postExport(req, res, ctx);
  if (method === "GET" && path === "/api/nodes") return await getNodes(req, res, ctx);
  if (method === "POST" && path === "/api/nodes") return await postNode(req, res, ctx);
  if (method === "PUT" && path.startsWith("/api/nodes/")) return await putNode(req, res, ctx, path);
  if (method === "DELETE" && path.startsWith("/api/nodes/")) return await deleteNode(req, res, ctx, path);
  if (method === "GET" && path === "/api/history") return await getHistory(req, res, ctx);
  if (method === "POST" && path === "/api/restore") return await postRestore(req, res, ctx);

  // Eval runs — kick off a coverage probe against a user-supplied endpoint and read the results back.
  if (method === "POST" && path === "/api/runs") return await postRun(req, res, ctx);
  if (method === "GET" && path === "/api/runs") return await getRuns(req, res, ctx);
  if (method === "POST" && path.startsWith("/api/runs/")) return await postRunAction(req, res, ctx, path);
  if (method === "GET" && path.startsWith("/api/runs/")) return await getRun(req, res, ctx, path);
  if (method === "DELETE" && path.startsWith("/api/runs/")) return await deleteRun(req, res, ctx, path);

  // Review flow.
  if (method === "POST" && path === "/api/proposals") return await postProposal(req, res, ctx);
  if (method === "GET" && path === "/api/proposals") return await getProposals(req, res, ctx);
  if (method === "DELETE" && path === "/api/proposals") return await deleteProposal(req, res, ctx);
  if (method === "POST" && path === "/api/sync/resolve") return await postSyncResolve(req, res, ctx);
  if (method === "POST" && path === "/api/sync") return await postSync(req, res, ctx);
  if (method === "GET" && path.startsWith("/api/proposals/")) return await getProposalDetail(res, ctx, path);
  if (method === "POST" && path.startsWith("/api/proposals/")) return await postMerge(req, res, ctx, path);

  // Request access (viewer asks; admin grants/denies).
  if (method === "POST" && path === "/api/access-requests") return await postAccessRequest(req, res, ctx);
  if (method === "GET" && path === "/api/access-requests") return await getAccessRequests(req, res, ctx);
  if (method === "POST" && path.startsWith("/api/access-requests/")) return await postAccessRequestDecision(req, res, ctx, path);

  // Admin.
  if (method === "GET" && path === "/api/access") return await getAccess(req, res, ctx);
  if (method === "PUT" && path === "/api/access") return await putAccess(req, res, ctx);
  if (method === "GET" && path === "/api/admin/overview") return await getOverview(req, res, ctx);

  sendJson(res, 404, { error: "not found" });
}

// ---- whoami + manifest --------------------------------------------------------------------------

async function getWhoami(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { actor, role, policy } = await resolveRead(ctx, req);
  // A non-admin sees their own open request (drives the "requested" state); an admin sees the queue depth.
  const accessRequest = role === "admin" ? null : await pendingFor(ctx.db, actor.email);
  const pendingRequests = role === "admin" ? await countPending(ctx.db) : 0;
  sendJson(res, 200, {
    actor,
    workspace: intendedWorkspace(role, actor),
    role,
    scopes: scopesFor(policy, actor.email),
    review: ctx.multiUser,
    accessRequest,
    pendingRequests,
  });
}

async function getManifest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { ws } = await resolveRead(ctx, req);
  sendJson(res, 200, await ctx.store.manifestWithVersions(ws));
}

// ---- topics -------------------------------------------------------------------------------------

/** A restorable snapshot from a topic + its hash (for a save/rename revision). */
function topicSnapshot(topic: Topic, hash: string): TopicSnapshot {
  return { key: topicKeyOf(topic), path: topic.path, id: topic.id, title: topic.title, kind: topic.kind, questions: topic.questions, hash };
}

/** Resolve the optional rename/move source `{path,id}` from the body, re-validated for path safety. */
function previousTopicRef(previous: unknown, topic: Topic): { path: string[]; id: string } | null {
  if (previous === null || typeof previous !== "object") return null;
  const p = previous as Record<string, unknown>;
  const pPath = p["path"];
  const pId = p["id"];
  if (
    Array.isArray(pPath) &&
    pPath.length > 0 &&
    pPath.every((s) => typeof s === "string" && SEGMENT_RE.test(s)) &&
    typeof pId === "string" &&
    TOPIC_ID_RE.test(pId) &&
    ((pPath as string[]).join("/") !== topic.path.join("/") || pId !== topic.id)
  ) {
    return { path: pPath as string[], id: pId };
  }
  return null;
}

async function postTopic(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const topic = parseTopic(body["topic"]); // ConfigError → 422
  if (!TOPIC_ID_RE.test(topic.id)) throw new BadRequest(`unsafe topic id "${topic.id}"`);
  const previous = previousTopicRef(body["previous"], topic);
  const baseVersion = typeof body["baseVersion"] === "string" ? body["baseVersion"] : null;

  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardScope(policy, actor, topic.path, previous ? "move" : "save");
    if (previous) guardScope(policy, actor, previous.path, "move");
    const ws = await targetWs(ctx, actor, role);
    try {
      const { hash, renamedFrom } = await ctx.store.putTopic(ws, topic, { previous, baseVersion, actor });
      await appendRevision(ctx.db, {
        workspace: ws,
        actor,
        action: renamedFrom ? "rename" : "save",
        topicKey: topicKeyOf(topic),
        after: topicSnapshot(topic, hash),
        message: `${renamedFrom ? "rename" : "save"} topic ${topicKeyOf(topic)}`,
      });
      sendJson(res, 200, { ok: true, version: hash });
    } catch (err) {
      if (err instanceof HashConflict) {
        return sendJson(res, 409, { error: "this topic changed since you opened it", current: docToTopic(err.current), currentVersion: err.current.hash });
      }
      throw err;
    }
  });
}

async function deleteTopic(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const parts = refSegments(path, "/api/topics/");
  const id = parts.pop() ?? "";
  if (parts.length === 0 || !parts.every((s) => SEGMENT_RE.test(s)) || !TOPIC_ID_RE.test(id)) throw new BadRequest("bad topic ref");

  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardScope(policy, actor, parts, "delete");
    const ws = await targetWs(ctx, actor, role);
    const removed = await ctx.store.deleteTopic(ws, parts, id);
    if (!removed) throw new NotFound("no such topic");
    await appendRevision(ctx.db, {
      workspace: ws,
      actor,
      action: "delete",
      topicKey: removed.key,
      before: { key: removed.key, path: removed.path, id: removed.id, title: removed.title, kind: removed.kind, questions: removed.questions, hash: removed.hash },
      message: `delete topic ${removed.key}`,
    });
    sendJson(res, 200, { ok: true });
  });
}

// ---- meta + export ------------------------------------------------------------------------------

async function putMeta(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const id = body["id"];
  const version = body["version"];
  if (typeof id !== "string" || id.trim() === "" || typeof version !== "string" || version.trim() === "") {
    throw new BadRequest("id and version must be non-empty strings");
  }

  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardAdmin(policy, actor, "edit the manifest identity"); // meta is a KB-wide, admin-only setting
    const ws = await targetWs(ctx, actor, role); // admins → main
    const current = await ctx.store.getWorkspace(ws);
    const meta: WorkspaceMeta = { id: id.trim(), version: version.trim() };
    const subject = body["subject"];
    const keptSubject = subject === "" || subject === null ? undefined : typeof subject === "string" ? subject : current?.meta.subject;
    if (keptSubject) meta.subject = keptSubject;
    const levels = body["levels"] !== undefined ? declaredLevels({ levels: body["levels"] }) : (current?.meta.levels ?? []); // ConfigError → 422
    if (levels.length) meta.levels = levels;

    await ctx.store.putMeta(ws, meta);
    await appendRevision(ctx.db, { workspace: ws, actor, action: "meta", message: `update manifest identity (${meta.id} ${meta.version})` });
    sendJson(res, 200, { ok: true });
  });
}

async function postExport(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { ws } = await resolveRead(ctx, req);
  const manifest = await ctx.store.assembledManifest(ws); // ConfigError → 422
  const file = join(ctx.exportDir, "manifest.yaml");
  atomicWrite(file, renderManifestYaml(manifest));
  sendJson(res, 200, { ok: true, path: file, topics: manifest.topics.length });
}

// ---- nodes --------------------------------------------------------------------------------------

async function getNodes(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { ws } = await resolveRead(ctx, req);
  sendJson(res, 200, { nodes: await ctx.store.listNodes(ws) });
}

async function postNode(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const path = safePath(body["path"], "node path");
  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardScope(policy, actor, path, "create a node at");
    const ws = await targetWs(ctx, actor, role);
    await ctx.store.createNode(ws, path);
    await appendRevision(ctx.db, { workspace: ws, actor, action: "node-create", message: `create node ${path.join("/")}` });
    sendJson(res, 200, { ok: true });
  });
}

async function putNode(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const from = refSegments(path, "/api/nodes/");
  if (from.length === 0 || !from.every((s) => SEGMENT_RE.test(s))) throw new BadRequest("bad node ref");
  const body = await readBody(req);
  const to = safePath(body["to"], "target path");
  if (from.join("/") === to.join("/")) return sendJson(res, 200, { ok: true, moved: 0 });
  if (to.length > from.length && from.every((s, i) => s === to[i])) throw new BadRequest("cannot move a node into its own subtree");

  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardScope(policy, actor, from, "move");
    guardScope(policy, actor, to, "move into");
    const ws = await targetWs(ctx, actor, role);
    if ((await ctx.store.subtreeTopicCount(ws, to)) > 0) throw new BadRequest(`target "${to.join("/")}" already exists and has topics`);
    const moved = await ctx.store.moveNode(ws, from, to, actor);
    await appendRevision(ctx.db, { workspace: ws, actor, action: "node-move", message: `move node ${from.join("/")} → ${to.join("/")} (${String(moved)} topic(s))` });
    sendJson(res, 200, { ok: true, moved });
  });
}

async function deleteNode(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const node = refSegments(path, "/api/nodes/");
  if (node.length === 0 || !node.every((s) => SEGMENT_RE.test(s))) throw new BadRequest("bad node ref");
  const url = new URL(req.url ?? "", "http://localhost");
  const cascade = url.searchParams.get("cascade") === "1";
  const confirm = url.searchParams.get("confirm");

  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardScope(policy, actor, node, "delete");
    const ws = await targetWs(ctx, actor, role);
    const count = await ctx.store.subtreeTopicCount(ws, node);
    if (count && !cascade) throw new BadRequest(`node "${node.join("/")}" has ${String(count)} topic(s) — move or delete them first, or pass ?cascade=1.`);
    if (count && cascade && confirm !== node.join("/")) throw new BadRequest(`cascade delete of "${node.join("/")}" needs confirm=${node.join("/")}`);

    const removed = await ctx.store.deleteNode(ws, node, cascade);
    for (const d of removed) {
      await appendRevision(ctx.db, {
        workspace: ws,
        actor,
        action: "delete",
        topicKey: d.key,
        before: { key: d.key, path: d.path, id: d.id, title: d.title, kind: d.kind, questions: d.questions, hash: d.hash },
        message: `delete topic ${d.key} (cascade ${node.join("/")})`,
      });
    }
    await appendRevision(ctx.db, { workspace: ws, actor, action: "node-delete", message: `delete node ${node.join("/")}${count ? ` (${String(count)} topic(s))` : ""}` });
    sendJson(res, 200, { ok: true, deleted: count });
  });
}

// ---- history + restore --------------------------------------------------------------------------

async function getHistory(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { ws } = await resolveRead(ctx, req);
  const url = new URL(req.url ?? "", "http://localhost");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const pathParam = url.searchParams.get("path");

  let topicKey: string | undefined;
  if (pathParam) {
    const segs = pathParam.split("/").filter(Boolean);
    const id = segs.pop() ?? "";
    if (segs.length === 0 || !segs.every((s) => SEGMENT_RE.test(s)) || !TOPIC_ID_RE.test(id)) throw new BadRequest("bad history path");
    topicKey = [...segs, id].join("/");
  }

  const commits = await listHistory(ctx.db, ws, topicKey !== undefined ? { limit, topicKey } : { limit });
  const deletions = topicKey ? [] : await listDeletions(ctx.db, ws, limit);
  sendJson(res, 200, { commits, deletions });
}

async function postRestore(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const sha = body["sha"];
  if (typeof sha !== "string") throw new BadRequest("bad sha");
  const path = safePath(body["path"], "restore path");
  const id = body["id"];
  if (typeof id !== "string" || !TOPIC_ID_RE.test(id)) throw new BadRequest("bad restore id");

  await handleWrite(ctx, req, async (actor, role, policy) => {
    guardScope(policy, actor, path, "restore");
    const rev = await getRevision(ctx.db, sha);
    const before = rev?.before;
    if (!before) throw new NotFound("nothing to restore at that revision");
    const ws = await targetWs(ctx, actor, role);
    const topic: Topic = { id: before.id, path: before.path, title: before.title, kind: before.kind, questions: before.questions };
    const { hash } = await ctx.store.putTopic(ws, topic, { actor });
    await appendRevision(ctx.db, { workspace: ws, actor, action: "restore", topicKey: before.key, after: { ...before, hash }, message: `restore topic ${before.key}` });
    sendJson(res, 200, { ok: true });
  });
}

// ---- review flow --------------------------------------------------------------------------------

async function postProposal(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const note = typeof body["note"] === "string" ? body["note"] : null;
  await handleWrite(ctx, req, async (actor, role) => {
    if (role !== "author") throw new BadRequest("nothing to propose — you are not working in a personal workspace");
    const ws = await targetWs(ctx, actor, role);
    await requestReview(ctx.db, ws, note);
    const proposals = await listProposals(ctx.db);
    const mine = proposals.find((p) => p.workspace === ws);
    sendJson(res, 200, mine ?? { id: ws, workspace: ws, author: actor.email, authorName: actor.name, state: "requested", createdAt: null, note, changes: { added: 0, edited: 0, deleted: 0, conflicted: 0 } });
  });
}

async function getProposals(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  await resolveRead(ctx, req); // identity resolved for consistency; the queue itself is not secret
  sendJson(res, 200, { proposals: await listProposals(ctx.db) });
}

async function getProposalDetail(res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const id = refSegments(path, "/api/proposals/")[0];
  if (!id) throw new BadRequest("bad proposal id");
  const detail = await getProposal(ctx.db, id);
  if (!detail) throw new NotFound("no such proposal");
  sendJson(res, 200, detail);
}

async function deleteProposal(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  await handleWrite(ctx, req, async (actor, role) => {
    if (role !== "author") throw new BadRequest("no proposal to withdraw");
    const ws = loginSlug(actor);
    await withdrawReview(ctx.db, ws);
    sendJson(res, 200, { ok: true });
  });
}

async function postMerge(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const segs = refSegments(path, "/api/proposals/");
  const id = segs[0];
  if (!id || segs[1] !== "merge") throw new BadRequest("bad merge ref");
  await handleWrite(ctx, req, async (actor, _role, policy) => {
    guardAdmin(policy, actor, "merge a proposal");
    const result = await mergeToMain(ctx.db, id, actor);
    if (!result.ok) return sendJson(res, 409, { error: "the proposal conflicts with main — the author must sync and resolve first", conflicts: result.conflicts });
    sendJson(res, 200, { ok: true, merged: result.merged });
  });
}

async function postSync(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  await handleWrite(ctx, req, async (actor, role) => {
    if (role !== "author") throw new BadRequest("nothing to sync — you are not working in a personal workspace");
    const ws = await targetWs(ctx, actor, role);
    sendJson(res, 200, await syncFromMain(ctx.db, ctx.store, ws, actor));
  });
}

async function postSyncResolve(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const key = body["key"];
  const choose = body["choose"];
  if (typeof key !== "string" || (choose !== "mine" && choose !== "theirs")) throw new BadRequest("resolve needs { key, choose: 'mine'|'theirs' }");
  await handleWrite(ctx, req, async (actor, role) => {
    if (role !== "author") throw new BadRequest("no conflict to resolve");
    const ws = loginSlug(actor);
    const ok = await resolveConflict(ctx.db, ws, key, choose, actor);
    if (!ok) throw new NotFound("no such conflict");
    sendJson(res, 200, { ok: true });
  });
}

// ---- admin: access policy + overview ------------------------------------------------------------

async function getAccess(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { actor, policy } = await resolveRead(ctx, req);
  guardAdmin(policy, actor, "view the access policy");
  sendJson(res, 200, { configured: policy !== null, ...policyToData(policy) });
}

async function putAccess(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const data = validateAccessBody(await readBody(req));
  await handleWrite(ctx, req, async (actor, _role, policy) => {
    // First-admin bootstrap: with no policy yet, anyone may set it (naming themselves admin).
    if (policy !== null) guardAdmin(policy, actor, "change the access policy");
    await writePolicy(ctx.db, data, actor);
    await appendRevision(ctx.db, { workspace: MAIN, actor, action: "access", message: "update access policy" });
    sendJson(res, 200, { ok: true });
  });
}

async function getOverview(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { actor, policy } = await resolveRead(ctx, req);
  guardAdmin(policy, actor, "view the admin overview");
  const wsDocs = await ctx.db.workspaces.find({ _id: { $ne: MAIN } }).sort({ updatedAt: -1 }).toArray();
  const workspaces = wsDocs.map((w) => ({
    workspace: w._id,
    owner: w.owner,
    ownerName: w.ownerName ?? null,
    updatedAt: w.updatedAt.toISOString(),
    reviewStatus: w.reviewStatus,
  }));
  sendJson(res, 200, {
    mode: ctx.multiUser ? "multi" : "single",
    reviewEnabled: ctx.multiUser,
    accessConfigured: policy !== null,
    kbAdmins: policy ? [...policy.admins] : [],
    workspaces,
  });
}

// ---- access requests (viewer asks for write access; admin grants/denies) ------------------------

/** A viewer files (or replaces) their open request naming the path(s) they want to edit. */
async function postAccessRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const paths = scopeList(body["paths"]); // reuses the policy scope validator (safe segments)
  if (paths.length === 0) throw new BadRequest("pick at least one path to request access to");
  const noteRaw = body["note"];
  const note = typeof noteRaw === "string" && noteRaw.trim() !== "" ? noteRaw.trim() : null;

  const { actor, role } = await resolveRead(ctx, req);
  if (role === "admin") throw new BadRequest("you already have full access");
  sendJson(res, 200, await submitRequest(ctx.db, actor, paths, note));
}

/** The open request queue (admin-only — requests carry emails and notes). */
async function getAccessRequests(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { actor, policy } = await resolveRead(ctx, req);
  guardAdmin(policy, actor, "view access requests");
  sendJson(res, 200, { requests: await listPending(ctx.db) });
}

/** Grant (`/grant`) or deny (`/deny`) a pending request. Granting merges scopes into the access policy. */
async function postAccessRequestDecision(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const segs = refSegments(path, "/api/access-requests/");
  const id = segs[0];
  const action = segs[1];
  if (!id || (action !== "grant" && action !== "deny")) throw new BadRequest("bad access-request ref");
  const body = action === "grant" ? await readBody(req) : {};

  await handleWrite(ctx, req, async (actor, _role, policy) => {
    guardAdmin(policy, actor, "decide access requests");
    if (action === "deny") {
      const denied = await resolveRequest(ctx.db, id, "denied", actor);
      if (!denied) throw new NotFound("no such pending request");
      return sendJson(res, 200, { ok: true, request: denied });
    }
    const request = await getRequest(ctx.db, id);
    if (!request || request.status !== "pending") throw new NotFound("no such pending request");
    // The admin may override the requested paths with an explicit `scopes`; otherwise grant what was asked.
    const scopes = body["scopes"] !== undefined ? scopeList(body["scopes"]) : request.paths;
    await writePolicy(ctx.db, withGrantedScopes(policyToData(policy), request.email, scopes), actor);
    const granted = await resolveRequest(ctx.db, id, "granted", actor);
    await appendRevision(ctx.db, {
      workspace: MAIN,
      actor,
      action: "access",
      message: `grant ${request.email} write access to ${scopes.map((s) => s.join("/") || "root").join(", ")}`,
    });
    sendJson(res, 200, { ok: true, request: granted ?? request });
  });
}

/** Validate + normalize a `PolicyData` body. Rejects a zero-admin policy (that would lock everyone out). */
function validateAccessBody(body: Record<string, unknown>): PolicyData {
  const admins = emailList(body["admins"], "admins");
  if (admins.length < 1) throw new BadRequest("at least one admin is required");
  const usersRaw = body["users"];
  if (!Array.isArray(usersRaw)) throw new BadRequest("users must be an array");
  const users = usersRaw.map((u) => {
    const email = u !== null && typeof u === "object" ? (u as Record<string, unknown>)["email"] : undefined;
    if (typeof email !== "string" || email.trim() === "") throw new BadRequest("each user needs a non-empty email");
    return { email: email.trim(), scopes: scopeList((u as Record<string, unknown>)["scopes"]) };
  });
  return { admins, users, defaultScopes: scopeList(body["defaultScopes"]) };
}

function emailList(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new BadRequest(`${what} must be an array`);
  return value.map((e) => {
    if (typeof e !== "string" || e.trim() === "") throw new BadRequest(`each ${what} entry must be a non-empty email`);
    return e.trim();
  });
}

function scopeList(value: unknown): string[][] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequest("scopes must be an array of path arrays");
  return value.map((scope) => {
    if (!Array.isArray(scope) || !scope.every((s) => typeof s === "string" && SEGMENT_RE.test(s))) throw new BadRequest(`unsafe scope ${JSON.stringify(scope)}`);
    return scope as string[];
  });
}

// ---- path helpers -------------------------------------------------------------------------------

/** Split a `/api/…/a/b/c` URL tail into decoded segments (raw — callers validate). */
function refSegments(path: string, prefix: string[] | string): string[] {
  const p = typeof prefix === "string" ? prefix : prefix.join("");
  return path.slice(p.length).split("/").filter(Boolean).map(decodeURIComponent);
}

/** A body field that must be an array of safe path segments. */
function safePath(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((s) => typeof s === "string" && SEGMENT_RE.test(s))) {
    throw new BadRequest(`unsafe ${what} ${JSON.stringify(value)}`);
  }
  return value as string[];
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
  const wantTree = new URL(req.url ?? "", "http://localhost").searchParams.get("tree") === "1";
  sendJson(res, 200, wantTree ? { ...report, tree: rollup(report).root } : report);
}

// ---- eval runs (run a coverage probe against a user endpoint) -----------------------------------

/** Validate one endpoint block from a run body into an `EndpointConfig` (secret included). */
function parseEndpoint(raw: unknown, label: string): EndpointConfig {
  if (raw === null || typeof raw !== "object") throw new BadRequest(`${label} config is required`);
  const o = raw as Record<string, unknown>;

  const provider = o["provider"];
  if (provider !== "openai" && provider !== "anthropic") throw new BadRequest(`${label} provider must be "openai" or "anthropic"`);

  const baseUrl = o["baseUrl"];
  // Same guard the env schema applies: bare "localhost:8000" parses as scheme "localhost:", so require http(s).
  if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) throw new BadRequest(`${label} baseUrl must be an http(s) URL, e.g. https://api.example.com`);
  try {
    new URL(baseUrl);
  } catch {
    throw new BadRequest(`${label} baseUrl is not a valid URL`);
  }

  const model = o["model"];
  if (typeof model !== "string" || model.trim() === "") throw new BadRequest(`${label} model is required`);

  const apiKey = o["apiKey"];
  if (typeof apiKey !== "string" || apiKey === "") throw new BadRequest(`${label} apiKey is required (any non-empty string works for a keyless local server)`);

  const cfg: EndpointConfig = { provider, baseUrl, model: model.trim(), apiKey };
  const temperature = o["temperature"];
  if (typeof temperature === "number" && temperature >= 0 && temperature <= 2) cfg.temperature = temperature;
  return cfg;
}

/** Validate the optional topic-scope: an array of `topicKey` strings, or null/absent = the whole KB. */
function parseScope(raw: unknown): EvalScope {
  if (raw === undefined || raw === null) return { topicKeys: null };
  if (!Array.isArray(raw) || !raw.every((k) => typeof k === "string")) throw new BadRequest("topicKeys must be an array of strings or null");
  return { topicKeys: raw };
}

/** A run doc as the dashboard lists it: identity, status, progress, and headline numbers — never the report body or a key. */
function runSummary(d: EvalRunDoc): Record<string, unknown> {
  return {
    id: d._id,
    actor: d.actor,
    status: d.status,
    workspace: d.workspace,
    subject: d.subject,
    manifestId: d.manifestId,
    manifestVersion: d.manifestVersion,
    scope: d.scope,
    source: d.source,
    judge: d.judge,
    progress: d.progress,
    totals: d.report?.totals ?? null,
    metrics: d.report?.metrics ?? null,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    startedAt: d.startedAt?.toISOString() ?? null,
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

async function postRun(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const body = await readBody(req);
  const source = parseEndpoint(body["source"], "source");
  const judge = parseEndpoint(body["judge"], "judge");
  const scope = parseScope(body["topicKeys"]);
  // The run probes the KB as THIS user sees it in Studio (an author's own copy, or main).
  const { actor, ws } = await resolveRead(ctx, req);
  try {
    const id = await ctx.runner.start({ actor: actor.email, workspace: ws, scope, source, judge });
    sendJson(res, 202, { id, status: "running" });
  } catch (err) {
    if (err instanceof TooManyRuns) return sendJson(res, 429, { error: err.message });
    throw err; // ConfigError (empty/invalid KB, empty scope) → 422 via sendError
  }
}

/** `POST /api/runs/:id/pause` and `/resume` — owner-or-admin. Resume re-supplies the (never-stored) keys. */
async function postRunAction(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const segs = refSegments(path, "/api/runs/");
  const id = segs[0];
  const action = segs[1];
  if (!id || (action !== "pause" && action !== "resume")) throw new BadRequest("bad run action");
  const { actor, policy } = await resolveRead(ctx, req);
  const doc = await ctx.db.evalRuns.findOne({ _id: id });
  if (!doc) throw new NotFound("no such run");
  if (doc.actor !== actor.email && !isAccessAdmin(policy, actor.email)) throw new Forbidden("this run belongs to someone else");

  if (action === "pause") {
    const paused = ctx.runner.pause(id);
    return sendJson(res, 200, { ok: true, status: paused ? "paused" : doc.status });
  }

  // resume — only a paused/interrupted run, and only with fresh keys (they were never stored).
  if (doc.status !== "paused" && doc.status !== "interrupted") throw new BadRequest("this run is not paused — nothing to resume");
  const body = await readBody(req);
  const source = parseEndpoint(body["source"], "source");
  const judge = parseEndpoint(body["judge"], "judge");
  try {
    await ctx.runner.resume({ doc, actor: actor.email, source, judge });
    sendJson(res, 202, { id, status: "running" });
  } catch (err) {
    if (err instanceof TooManyRuns) return sendJson(res, 429, { error: err.message });
    throw err; // ConfigError (scope now empty) → 422
  }
}

async function getRuns(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { actor, policy } = await resolveRead(ctx, req);
  const all = new URL(req.url ?? "", "http://localhost").searchParams.get("all") === "1" && isAccessAdmin(policy, actor.email);
  const filter = all ? {} : { actor: actor.email };
  const docs = await ctx.db.evalRuns.find(filter).sort({ createdAt: -1 }).limit(100).toArray();
  sendJson(res, 200, { runs: docs.map(runSummary) });
}

async function getRun(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const id = refSegments(path, "/api/runs/")[0];
  if (!id) throw new BadRequest("bad run id");
  const { actor, policy } = await resolveRead(ctx, req);
  const doc = await ctx.db.evalRuns.findOne({ _id: id });
  if (!doc) throw new NotFound("no such run");
  if (doc.actor !== actor.email && !isAccessAdmin(policy, actor.email)) throw new Forbidden("this run belongs to someone else");
  // On success, attach the per-level rollup + a generatedAt, so the client feeds the exact same shape
  // the file-based viewer renders (see getCoverage). The live `log` drives the running view's feed.
  const report = doc.report ? { ...doc.report, generatedAt: doc.finishedAt?.toISOString() ?? "", tree: rollup(doc.report).root } : null;
  sendJson(res, 200, { ...runSummary(doc), log: doc.log, report });
}

async function deleteRun(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
  const id = refSegments(path, "/api/runs/")[0];
  if (!id) throw new BadRequest("bad run id");
  const { actor, policy } = await resolveRead(ctx, req);
  const doc = await ctx.db.evalRuns.findOne({ _id: id });
  if (!doc) throw new NotFound("no such run");
  if (doc.actor !== actor.email && !isAccessAdmin(policy, actor.email)) throw new Forbidden("this run belongs to someone else");
  const wasLive = ctx.runner.cancel(id);
  sendJson(res, 200, { ok: true, status: wasLive ? "canceled" : doc.status });
}

// ---- static front-end ---------------------------------------------------------------------------

function serveHtml(res: ServerResponse): void {
  const indexPath = join(DIST, "index.html");
  if (existsSync(indexPath)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(indexPath, "utf8"));
    return;
  }
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
  if (err instanceof ConfigError) return sendJson(res, 422, { error: err.message });
  process.stderr.write(`kb-studio: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  sendJson(res, 500, { error: "internal error" });
}

// ---- entrypoint (the only place that connects + listens) ----------------------------------------

/** Parse `KB_DEV_ACTOR` ("Name <email>" or "email"), or fall back to DEFAULT_ACTOR. */
function devActor(): Actor {
  const raw = process.env["KB_DEV_ACTOR"]?.trim();
  if (!raw) return DEFAULT_ACTOR;
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: (m[1] ?? "").trim() || m[2] || raw, email: m[2] ?? raw };
  return { name: raw.split("@")[0] || raw, email: raw };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async (): Promise<void> => {
    const uri = process.env["MONGODB_URI"] ?? "mongodb://127.0.0.1:27017";
    const dbName = process.env["KB_DB_NAME"] ?? "kb_studio";
    const kbDir = process.env["KB_DIR"] ?? join(process.cwd(), "kb");
    const coverageDir = process.env["KB_COVERAGE_DIR"] ?? join(process.cwd(), "kb-coverage");
    const exportDir = process.env["KB_EXPORT_DIR"] ?? kbDir;
    const port = Number(process.env["KB_STUDIO_PORT"] ?? "7674");
    const multiUser = process.env["KB_MULTI_USER"] === "1";

    const envAdmins = (process.env["KB_ADMINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const dev = devActor();
    // Multi-user seeds from KB_ADMINS; single-user (dev) seeds the dev actor so `pnpm studio` stays frictionless.
    const seedAdmins = envAdmins.length ? envAdmins : multiUser ? [] : [dev.email];
    const host = multiUser ? "0.0.0.0" : "127.0.0.1";

    const db = await connectDb(uri, dbName);
    await bootstrapKb(db, { kbDir, seedAdmins, actor: dev });

    createStudioServer({ db, coverageDir, exportDir, multiUser }).listen(port, host, () => {
      process.stdout.write(
        `\n  KB Studio → http://${host}:${String(port)}\n` +
          `  db        ${uri}/${dbName}${multiUser ? "  (multi-user: per-author workspaces)" : ""}\n` +
          `  export    ${exportDir}\n  viewing   ${coverageDir}\n\n`,
      );
    });
  })().catch((err: unknown) => {
    process.stderr.write(`kb-studio: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
