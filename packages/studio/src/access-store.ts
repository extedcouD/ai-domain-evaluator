/**
 * The access policy's Mongo home — read/write/seed of the singleton `config.access` document. This is
 * the canonical, single source of scoping truth (replacing the git-tracked `access.yaml`): every scope
 * check reads it, and only an admin can change it via `PUT /api/access`.
 */
import { policyFromData, type AccessPolicy, type PolicyData } from "./access";
import type { Actor } from "./actor";
import type { DbHandle } from "./db";

const ACCESS_ID = "access";

/** The stored policy as plain data, or null when none has been seeded yet. */
export async function readPolicyData(db: DbHandle): Promise<PolicyData | null> {
  const doc = await db.config.findOne({ _id: ACCESS_ID });
  if (!doc) return null;
  return { admins: doc.admins, users: doc.users, defaultScopes: doc.defaultScopes };
}

/** The stored policy as an in-memory `AccessPolicy` (Sets/Maps), or null when none exists. */
export async function readPolicy(db: DbHandle): Promise<AccessPolicy | null> {
  const data = await readPolicyData(db);
  return data ? policyFromData(data) : null;
}

/** Overwrite the policy (admin action). Upserts the singleton document, attributed to `actor`. */
export async function writePolicy(db: DbHandle, data: PolicyData, actor: Actor): Promise<void> {
  await db.config.updateOne(
    { _id: ACCESS_ID },
    { $set: { admins: data.admins, users: data.users, defaultScopes: data.defaultScopes, updatedAt: new Date(), updatedBy: actor.email } },
    { upsert: true },
  );
}

/**
 * Seed the policy from an admin list IF none exists yet — the first-boot bootstrap. A no-op when a
 * policy is already present, so it never clobbers a configured deployment. Defaults everyone else to a
 * read-only viewer (`defaultScopes: []`).
 */
export async function seedPolicy(db: DbHandle, admins: string[], actor: Actor): Promise<boolean> {
  const existing = await db.config.findOne({ _id: ACCESS_ID });
  if (existing) return false;
  await db.config.insertOne({
    _id: ACCESS_ID,
    admins: [...new Set(admins.filter((a) => a.trim() !== ""))],
    users: [],
    defaultScopes: [],
    updatedAt: new Date(),
    updatedBy: actor.email,
  });
  return true;
}
