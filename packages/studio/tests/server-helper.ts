/**
 * Server-test scaffolding: boot a real `node:http` KB Studio over an in-memory mongod, seed a main
 * workspace + access policy, and provide a `reqAs(email, …)` that speaks the trusted identity header.
 */
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DbHandle, WorkspaceMeta } from "../src/db";
import { createStudioServer } from "../src/server";
import { ManifestStore, type TopicInput } from "../src/store";

import { freshDb } from "./mongo-helper";

export interface Studio {
  base: string;
  db: DbHandle;
  store: ManifestStore;
  exportDir: string;
  coverageDir: string;
  close: () => void;
}

const cleanups: Studio[] = [];
const dirs: string[] = [];

export function tempDir(prefix = "kb-srv-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Seed the canonical main workspace + a policy. Returns the store to add topics with. */
export async function seedMain(db: DbHandle, opts: { meta?: WorkspaceMeta; admins?: string[]; users?: { email: string; scopes: string[][] }[]; defaultScopes?: string[][] } = {}): Promise<ManifestStore> {
  const store = new ManifestStore(db);
  const meta = opts.meta ?? { id: "test-kb", version: "1.0" };
  const now = new Date();
  await db.workspaces.insertOne({
    _id: "main",
    owner: null,
    createdAt: now,
    updatedAt: now,
    ready: true,
    meta,
    metaHash: store.metaHash(meta),
    baseMetaHash: null,
    nodes: [],
    reviewStatus: "none",
    reviewRequestedAt: null,
    reviewNote: null,
    lastSyncedAt: null,
    lastMergedAt: null,
  });
  await db.config.insertOne({
    _id: "access",
    admins: opts.admins ?? ["studio@localhost"],
    users: opts.users ?? [],
    defaultScopes: opts.defaultScopes ?? [],
    updatedAt: now,
    updatedBy: "seed",
  });
  return store;
}

export const topic = (path: string[], id: string, over: Partial<TopicInput> = {}): TopicInput => ({
  id,
  path,
  title: `Title ${id}`,
  kind: "real",
  questions: ["q one", "q two"],
  ...over,
});

/** Boot a studio server over a freshly-seeded db. */
export async function startStudio(opts: { multiUser?: boolean; seed?: (store: ManifestStore, db: DbHandle) => Promise<void>; access?: Parameters<typeof seedMain>[1] } = {}): Promise<Studio> {
  const db = await freshDb();
  const store = await seedMain(db, opts.access ?? {});
  if (opts.seed) await opts.seed(store, db);
  const exportDir = tempDir("kb-export-");
  const coverageDir = tempDir("kb-cov-");
  const server = createStudioServer(opts.multiUser ? { db, coverageDir, exportDir, multiUser: true } : { db, coverageDir, exportDir });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const studio: Studio = { base: `http://127.0.0.1:${String(port)}`, db, store, exportDir, coverageDir, close: () => server.close() };
  cleanups.push(studio);
  return studio;
}

export async function req<T = unknown>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(base + path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T };
}

export async function reqAs<T = unknown>(base: string, email: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
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

export function teardown(): void {
  for (const s of cleanups.splice(0)) {
    s.close();
    void s.db.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
