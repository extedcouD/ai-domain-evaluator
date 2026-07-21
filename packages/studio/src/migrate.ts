/**
 * One-time import of the YAML KB folder into Mongo — the migration off git, and the first-boot
 * auto-import. `importKb` reads the existing Zod-validated folder (`readManifestDir`) and lands it as
 * `workspaces.main` + its topics, then imports `access.yaml` (if present) or seeds the policy from
 * `KB_ADMINS`, and records an `import` revision.
 *
 * Run standalone as `pnpm studio:migrate` (`tsx packages/studio/src/migrate.ts`), which aborts if main
 * is already populated unless `--force` (which wipes topics/workspaces/revisions first; `config.access`
 * is only touched with `--force-access`). The same `importKb` is called by the server on first boot.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import type { Actor } from "./actor";
import { writePolicy, seedPolicy } from "./access-store";
import type { PolicyData } from "./access";
import { connectDb, ensureIndexes, ObjectId, type DbHandle, type TopicDoc, type WorkspaceMeta } from "./db";
import { appendRevision } from "./history";
import { declaredLevels, listNodes, readManifestDir, readMetaObject } from "./manifest-folder";
import { ManifestStore, topicKeyOf } from "./store";

const MIGRATE_ACTOR: Actor = {
  name: process.env["KB_GIT_NAME"] ?? "KB Studio",
  email: process.env["KB_GIT_EMAIL"] ?? "kb-studio@localhost",
};

export interface ImportOptions {
  force?: boolean;
  forceAccess?: boolean;
  actor?: Actor;
  /** The admin emails to seed the policy from when no `access.yaml` exists (first-boot bootstrap). */
  seedAdmins?: string[];
}

export interface ImportResult {
  imported: boolean;
  topics: number;
  reason?: string;
}

/** Parse a legacy `access.yaml` into `PolicyData` (migrate only — the app no longer reads YAML policy). */
function parseAccessYaml(text: string): PolicyData {
  const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const asPrefixes = (v: unknown): string[][] => {
    if (!Array.isArray(v)) return [];
    const out: string[][] = [];
    for (const item of v) if (Array.isArray(item) && item.every((s) => typeof s === "string")) out.push(item);
    return out;
  };
  const o = asRecord(parseYaml(text));
  const admins = Array.isArray(o["admins"]) ? o["admins"].filter((s): s is string => typeof s === "string") : [];
  const users: { email: string; scopes: string[][] }[] = [];
  for (const [email, cfg] of Object.entries(asRecord(o["users"]))) users.push({ email, scopes: asPrefixes(asRecord(cfg)["scopes"]) });
  return { admins, users, defaultScopes: asPrefixes(asRecord(o["defaults"])["scopes"]) };
}

/**
 * Import `kbDir` into Mongo as the main workspace. Idempotent guard: aborts when main is already
 * populated unless `force`. Returns whether it imported and how many topics.
 */
export async function importKb(db: DbHandle, kbDir: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const actor = opts.actor ?? MIGRATE_ACTOR;
  const store = new ManifestStore(db);

  const populated = (await db.topics.countDocuments({ workspace: "main" })) > 0 || (await db.workspaces.findOne({ _id: "main" })) !== null;
  if (populated && !opts.force) return { imported: false, topics: 0, reason: "main workspace is already populated (use --force to overwrite)" };
  if (opts.force) {
    await db.topics.deleteMany({});
    await db.workspaces.deleteMany({});
    await db.revisions.deleteMany({});
    if (opts.forceAccess) await db.config.deleteMany({});
  }

  const manifest = readManifestDir(kbDir); // Zod-validated read of the folder
  const meta: WorkspaceMeta = { id: manifest.id, version: manifest.version };
  if (manifest.subject) meta.subject = manifest.subject;
  const levels = declaredLevels(readMetaObject(kbDir));
  if (levels.length) meta.levels = levels;

  const emptyNodes = listNodes(kbDir).filter((n) => !n.hasTopics).map((n) => n.path);
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
    nodes: emptyNodes,
    reviewStatus: "none",
    reviewRequestedAt: null,
    reviewNote: null,
    lastSyncedAt: null,
    lastMergedAt: null,
  });

  const topicDocs: TopicDoc[] = manifest.topics.map((t) => ({
    _id: new ObjectId(),
    workspace: "main",
    key: topicKeyOf(t),
    path: t.path,
    id: t.id,
    title: t.title,
    kind: t.kind,
    questions: t.questions,
    hash: store.topicHash(t),
    baseHash: null,
    deleted: false,
    updatedAt: now,
    updatedBy: actor.email,
  }));
  if (topicDocs.length) await db.topics.insertMany(topicDocs);

  // Access policy: import an existing access.yaml, else seed from the admin list.
  const accessFile = join(kbDir, "access.yaml");
  const configExists = (await db.config.findOne({ _id: "access" })) !== null;
  if (existsSync(accessFile) && (!configExists || opts.forceAccess)) {
    await writePolicy(db, parseAccessYaml(readFileSync(accessFile, "utf8")), actor);
  } else if (!configExists) {
    await seedPolicy(db, opts.seedAdmins ?? [], actor);
  }

  await appendRevision(db, { workspace: "main", actor, action: "import", message: `imported ${String(topicDocs.length)} topics from ${kbDir}` });
  return { imported: true, topics: topicDocs.length };
}

/** CLI entrypoint: `tsx packages/studio/src/migrate.ts [--force] [--force-access]`. */
async function main(): Promise<void> {
  const uri = process.env["MONGODB_URI"] ?? "mongodb://127.0.0.1:27017";
  const dbName = process.env["KB_DB_NAME"] ?? "kb_studio";
  const kbDir = process.env["KB_DIR"] ?? join(process.cwd(), "kb");
  const force = process.argv.includes("--force");
  const forceAccess = process.argv.includes("--force-access");
  const seedAdmins = (process.env["KB_ADMINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  process.stdout.write(`kb-studio migrate → ${uri}/${dbName}\n  importing ${kbDir}${force ? " (force)" : ""}\n`);
  const db = await connectDb(uri, dbName);
  try {
    await ensureIndexes(db);
    const result = await importKb(db, kbDir, { force, forceAccess, seedAdmins });
    if (result.imported) process.stdout.write(`  ✓ imported ${String(result.topics)} topics into workspaces.main\n`);
    else process.stdout.write(`  ✗ skipped: ${result.reason ?? "nothing to do"}\n`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`migrate failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
