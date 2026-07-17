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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, rollup, type CoverageReport, type Topic } from "@evaluator/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { GitStore, type Actor } from "./git-store";
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

export interface StudioOptions {
  /** The KB folder: `manifest.meta.yaml` + `topics/<seg…>/*.yaml` (+ the generated `manifest.yaml`). */
  kbDir: string;
  /** Where coverage runs are written: `<id>-<epoch>.json`, as the CLI writes them. */
  coverageDir: string;
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
/** The actor is not allowed to touch this path (topic scoping) → 403. Used from Phase 3. */
class Forbidden extends Error {}

/** Everything a request handler needs: the injected dirs plus the git safety net over the KB. */
interface Ctx extends StudioOptions {
  git: GitStore;
}

/**
 * Until SSO lands (Phase 1), every commit is attributed to a single placeholder actor. `resolveActor`
 * will replace this with the identity the auth proxy injects, threaded in exactly the same spot.
 */
const DEFAULT_ACTOR: Actor = { name: "KB Studio", email: "studio@localhost" };

export function createStudioServer(opts: StudioOptions): Server {
  const ctx: Ctx = { ...opts, git: new GitStore(opts.kbDir) };
  return createServer((req, res) => {
    void handle(req, res, ctx);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { kbDir, coverageDir } = ctx;
  const actor = DEFAULT_ACTOR;
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/") return serveHtml(res);
    if (method === "GET" && path === "/api/manifest") return sendJson(res, 200, readManifestDir(kbDir));
    if (method === "POST" && path === "/api/topics") return await postTopic(req, res, ctx, actor);
    if (method === "DELETE" && path.startsWith("/api/topics/")) return await deleteTopic(res, ctx, path, actor);
    if (method === "PUT" && path === "/api/meta") return await putMeta(req, res, ctx, actor);
    if (method === "POST" && path === "/api/export") return postExport(res, ctx);
    if (method === "GET" && path === "/api/nodes") return sendJson(res, 200, { nodes: listNodes(kbDir) });
    if (method === "POST" && path === "/api/nodes") return await postNode(req, res, ctx, actor);
    if (method === "PUT" && path.startsWith("/api/nodes/")) return await putNode(req, res, ctx, path, actor);
    if (method === "DELETE" && path.startsWith("/api/nodes/")) return await deleteNode(req, res, ctx, path, actor);
    if (method === "GET" && path === "/api/history") return await getHistory(req, res, ctx);
    if (method === "POST" && path === "/api/restore") return await postRestore(req, res, ctx, actor);
    if (method === "GET" && path === "/api/coverage") return listCoverage(res, coverageDir);
    if (method === "GET" && path.startsWith("/api/coverage/")) return getCoverage(req, res, coverageDir, path);

    // Anything else GET and not under /api is a front-end asset (or the SPA fallback).
    if (method === "GET" && !path.startsWith("/api/")) return serveStatic(res, path);

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendError(res, err);
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

async function postTopic(req: IncomingMessage, res: ServerResponse, ctx: Ctx, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
  const body = await readBody(req);
  const topic = parseTopic(body["topic"]); // ConfigError → 422 on a malformed topic
  if (!TOPIC_ID_RE.test(topic.id)) throw new BadRequest(`unsafe topic id "${topic.id}"`);

  const path = topicPath(kbDir, topic.path, topic.id);
  const old = previousTopicPath(kbDir, body["previous"], topic); // a rename/move source, or null

  await git.commit({
    actor,
    message: `kb: ${old ? "rename" : "save"} topic ${topic.path.join("/")}/${topic.id}`,
    // Write the new file first, then delete the old one, so a failure never orphans (unchanged order).
    mutate: () => {
      mkdirSync(dirname(path), { recursive: true });
      git.atomicWrite(path, renderTopicFile(topic));
      if (old && existsSync(old)) rmSync(old);
    },
  });

  sendJson(res, 200, { ok: true });
}

/**
 * Resolve the on-disk source path of a rename/move from the optional `previous: {path, id}` body field,
 * or null when it's absent, malformed, or points at the same identity. Segment/id safety is re-checked
 * here so a crafted `previous` can never delete outside `topics/`.
 */
function previousTopicPath(kbDir: string, previous: unknown, topic: Topic): string | null {
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
    return topicPath(kbDir, pPath as string[], pId);
  }
  return null;
}

async function deleteTopic(res: ServerResponse, ctx: Ctx, path: string, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
  const parts = refSegments(path, "/api/topics/"); // [seg, seg, …, id]
  const id = parts.pop() ?? "";
  if (parts.length === 0 || !parts.every((s) => SEGMENT_RE.test(s)) || !TOPIC_ID_RE.test(id)) {
    throw new BadRequest("bad topic ref");
  }

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

async function putMeta(req: IncomingMessage, res: ServerResponse, ctx: Ctx, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
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
async function postNode(req: IncomingMessage, res: ServerResponse, ctx: Ctx, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
  const body = await readBody(req);
  const path = safePath(body["path"], "node path");
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
async function putNode(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
  const from = refSegments(path, "/api/nodes/");
  if (from.length === 0 || !from.every((s) => SEGMENT_RE.test(s))) throw new BadRequest("bad node ref");
  const body = await readBody(req);
  const to = safePath(body["to"], "target path");
  if (from.join("/") === to.join("/")) return sendJson(res, 200, { ok: true, moved: 0 });

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
async function deleteNode(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
  const node = refSegments(path, "/api/nodes/");
  if (node.length === 0 || !node.every((s) => SEGMENT_RE.test(s))) throw new BadRequest("bad node ref");
  const cascade = new URL(req.url ?? "", "http://localhost").searchParams.get("cascade") === "1";
  const dir = join(kbDir, "topics", ...node);
  const count = countSubtreeTopics(dir);
  if (count && !cascade) {
    throw new BadRequest(
      `node "${node.join("/")}" has ${String(count)} topic(s) — move or delete them first, or pass ?cascade=1.`,
    );
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

function postExport(res: ServerResponse, ctx: Ctx): void {
  const { kbDir, git } = ctx;
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
async function getHistory(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const { kbDir, git } = ctx;
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
async function postRestore(req: IncomingMessage, res: ServerResponse, ctx: Ctx, actor: Actor): Promise<void> {
  const { kbDir, git } = ctx;
  const body = await readBody(req);
  const sha = body["sha"];
  // A git revision the History/Trash view handed us: a hex sha, optionally with a `~N`/`^` suffix.
  if (typeof sha !== "string" || !/^[0-9a-f]{4,40}(?:~\d+|\^+)?$/i.test(sha)) throw new BadRequest("bad sha");
  const path = safePath(body["path"], "restore path");
  const id = body["id"];
  if (typeof id !== "string" || !TOPIC_ID_RE.test(id)) throw new BadRequest("bad restore id");

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
  process.stderr.write(`kb-studio: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  sendJson(res, 500, { error: "internal error" });
}

// ---- entrypoint (the only place that listens) ---------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kbDir = process.env["KB_DIR"] ?? join(process.cwd(), "kb");
  const coverageDir = process.env["KB_COVERAGE_DIR"] ?? join(process.cwd(), "kb-coverage");
  const port = Number(process.env["KB_STUDIO_PORT"] ?? "4319");
  createStudioServer({ kbDir, coverageDir }).listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `\n  KB Studio → http://127.0.0.1:${String(port)}\n` + `  authoring ${kbDir}\n  viewing   ${coverageDir}\n\n`,
    );
  });
}
