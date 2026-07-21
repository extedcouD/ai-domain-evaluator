/**
 * Topic scoping — who may write which part of the taxonomy. Pure logic only: no I/O, no YAML.
 *
 * The policy now lives in Mongo (`config.access`, see `access-store.ts`); this module just holds the
 * in-memory `AccessPolicy` shape and the pure predicates over it. A write is allowed when its target
 * path sits under one of the actor's scope PREFIXES; admins write anywhere. There is no longer an "open
 * mode": a policy always exists (seeded on first boot), and a signed-in user who is neither an admin nor
 * a listed user falls to `defaultScopes` — empty by default, i.e. a read-only VIEWER.
 *
 * CRITICAL — the policy is the single canonical `config.access` document, never anything a user can
 * write, so a scoped author cannot escalate themselves. Access changes require an admin (`PUT /api/access`).
 */

export interface AccessPolicy {
  admins: Set<string>;
  /** email → the path-prefixes that email may write within. */
  scopes: Map<string, string[][]>;
  /** Scopes for users not listed under `users` ([] → read-only viewer). */
  defaultScopes: string[][];
}

/**
 * The policy as plain, serializable data — the shape stored in Mongo, read by the Admin page
 * (`GET /api/access`) and posted back (`PUT /api/access`). `users` is a list (not a Map) so it survives
 * JSON.
 */
export interface PolicyData {
  admins: string[];
  users: { email: string; scopes: string[][] }[];
  defaultScopes: string[][];
}

/** Build the in-memory policy (Sets/Maps) from its stored `PolicyData` form. */
export function policyFromData(data: PolicyData): AccessPolicy {
  const scopes = new Map<string, string[][]>();
  for (const u of data.users) scopes.set(u.email, u.scopes);
  return { admins: new Set(data.admins), scopes, defaultScopes: data.defaultScopes };
}

/** Flatten a parsed policy (Sets/Maps) into `PolicyData`. `null` → empty lists. */
export function policyToData(policy: AccessPolicy | null): PolicyData {
  if (policy === null) return { admins: [], users: [], defaultScopes: [] };
  return {
    admins: [...policy.admins],
    users: [...policy.scopes.entries()].map(([email, scopes]) => ({ email, scopes })),
    defaultScopes: policy.defaultScopes,
  };
}

/** `prefix` is a taxonomy prefix of `path` (an empty prefix — the root — matches everything). */
function isPrefix(prefix: string[], path: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((seg, i) => seg === path[i]);
}

/** Admin per the policy. A missing policy (`null`) is NOT admin. */
export function isAdmin(policy: AccessPolicy | null, email: string): boolean {
  return policy !== null && policy.admins.has(email);
}

/** The write scopes for an email — `[[]]` (root) for an admin, else their listed scopes or the defaults. */
export function scopesFor(policy: AccessPolicy | null, email: string): string[][] {
  if (policy === null) return [];
  if (policy.admins.has(email)) return [[]];
  return policy.scopes.get(email) ?? policy.defaultScopes;
}

/** May this email write at `path`? Admin → yes; otherwise the path must sit under one of their scopes. */
export function canWrite(policy: AccessPolicy | null, email: string, path: string[]): boolean {
  if (policy !== null && policy.admins.has(email)) return true;
  return scopesFor(policy, email).some((prefix) => isPrefix(prefix, path));
}

export type Role = "admin" | "author" | "viewer";

/** A coarse role for the UI: admin, an author (has write scopes), or a read-only viewer. */
export function roleFor(policy: AccessPolicy | null, email: string): Role {
  if (policy !== null && policy.admins.has(email)) return "admin";
  return scopesFor(policy, email).length > 0 ? "author" : "viewer";
}
