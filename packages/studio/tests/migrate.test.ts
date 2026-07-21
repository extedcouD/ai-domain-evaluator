/**
 * Phase 1 — the YAML→Mongo migration. Proves `importKb` lands the folder as `workspaces.main` + topics
 * (baseHash null), respects the not-empty guard unless `--force`, imports an `access.yaml` into
 * `config.access`, seeds from an admin list when there's no policy file, and records an import revision.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DbHandle } from "../src/db";
import { importKb } from "../src/migrate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshDb, startMongo, stopMongo } from "./mongo-helper";

let db: DbHandle;
const dirs: string[] = [];

beforeAll(startMongo, 60_000);
afterAll(stopMongo);
beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => {
  void db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedTopic(kbDir: string, path: string[], id: string, over: Record<string, unknown> = {}): void {
  const folder = join(kbDir, "topics", ...path);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.yaml`), JSON.stringify({ id, path, title: `Title ${id}`, kind: "real", questions: ["a", "b"], ...over }));
}

function makeKb(over?: { access?: string }): string {
  const kbDir = mkdtempSync(join(tmpdir(), "kb-migrate-"));
  dirs.push(kbDir);
  writeFileSync(join(kbDir, "manifest.meta.yaml"), 'id: test-kb\nversion: "1.0"\nsubject: the ONDC protocol\nlevels: [domain, usecase]\n');
  seedTopic(kbDir, ["ondc", "general"], "buyer-app");
  seedTopic(kbDir, ["ondc", "protocol"], "beckn", { kind: "canary" });
  mkdirSync(join(kbDir, "topics", "ondc", "empty-node"), { recursive: true }); // an empty folder
  if (over?.access) writeFileSync(join(kbDir, "access.yaml"), over.access);
  return kbDir;
}

describe("importKb (YAML → Mongo)", () => {
  it("imports the folder as workspaces.main + topics with baseHash null", async () => {
    const kbDir = makeKb();
    const result = await importKb(db, kbDir, { seedAdmins: ["alice@corp.com"] });
    expect(result.imported).toBe(true);
    expect(result.topics).toBe(2);

    const main = await db.workspaces.findOne({ _id: "main" });
    expect(main?.meta).toMatchObject({ id: "test-kb", version: "1.0", subject: "the ONDC protocol", levels: ["domain", "usecase"] });
    expect(main?.ready).toBe(true);
    expect(main?.nodes.map((n) => n.join("/"))).toContain("ondc/empty-node");

    const topics = await db.topics.find({ workspace: "main" }).toArray();
    expect(topics.map((t) => t.id).sort()).toEqual(["beckn", "buyer-app"]);
    expect(topics.every((t) => t.baseHash === null && t.deleted === false)).toBe(true);
    expect(topics.find((t) => t.id === "beckn")?.kind).toBe("canary");

    // Seeded policy: alice is admin, everyone else a viewer (empty default scopes).
    const access = await db.config.findOne({ _id: "access" });
    expect(access?.admins).toEqual(["alice@corp.com"]);
    expect(access?.defaultScopes).toEqual([]);

    // An import revision was recorded.
    expect(await db.revisions.countDocuments({ workspace: "main", action: "import" })).toBe(1);
  });

  it("aborts when main is already populated, unless --force", async () => {
    const kbDir = makeKb();
    await importKb(db, kbDir, {});
    const again = await importKb(db, kbDir, {});
    expect(again.imported).toBe(false);
    expect(again.reason).toMatch(/populated/i);

    const forced = await importKb(db, kbDir, { force: true });
    expect(forced.imported).toBe(true);
    expect(await db.topics.countDocuments({ workspace: "main" })).toBe(2);
  });

  it("imports an existing access.yaml into config.access", async () => {
    const kbDir = makeKb({
      access: "admins:\n  - alice@corp.com\nusers:\n  bob@corp.com:\n    scopes:\n      - [ondc, protocol]\ndefaults:\n  scopes: []\n",
    });
    await importKb(db, kbDir, {});
    const access = await db.config.findOne({ _id: "access" });
    expect(access?.admins).toEqual(["alice@corp.com"]);
    expect(access?.users).toEqual([{ email: "bob@corp.com", scopes: [["ondc", "protocol"]] }]);
  });
});
