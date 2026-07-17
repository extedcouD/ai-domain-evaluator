/**
 * Topic scoping — who may write which part of the taxonomy.
 *
 * A git-tracked `access.yaml` at the KB root maps users to scope PREFIXES (a topic's `path` array). A
 * write is allowed when its target path sits under one of the actor's scopes; admins may write anywhere.
 * Enforcement is OPT-IN: no `access.yaml` → "open mode", everyone may write (the Phase 0–2 behavior every
 * existing test relies on). Scoping only bites once the file exists.
 *
 * CRITICAL — the policy is read from the CANONICAL KB (the main tree), never a user's worktree, so a
 * scoped author cannot edit `access.yaml` on their own branch to escalate. A real change to access lands
 * only through a reviewed merge to `main`, which requires an admin.
 *
 * ```yaml
 * # access.yaml
 * admins: [alice@corp.com]          # full access: any path, cascade-delete, edit meta, merge proposals
 * users:
 *   bob@corp.com:  { scopes: [[ondc, protocol, foundation]] }
 *   carol@corp.com: { scopes: [[ondc, protocol, domains, retail]] }
 * defaults: { scopes: [] }          # everyone else: read-only (omit or [] = no write)
 * ```
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export interface AccessPolicy {
  admins: Set<string>;
  /** email → the path-prefixes that email may write within. */
  scopes: Map<string, string[][]>;
  /** Scopes for users not listed under `users` (default: none → read-only). */
  defaultScopes: string[][];
}

interface CacheEntry {
  mtimeMs: number;
  policy: AccessPolicy;
}
const cache = new Map<string, CacheEntry>();

/** Read `<kbDir>/access.yaml` (mtime-cached), or null when absent → open mode (everyone may write). */
export function readAccess(kbDir: string): AccessPolicy | null {
  const file = join(kbDir, "access.yaml");
  if (!existsSync(file)) {
    cache.delete(kbDir);
    return null;
  }
  const mtimeMs = statSync(file).mtimeMs;
  const hit = cache.get(kbDir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.policy;
  const policy = parseAccess(readFileSync(file, "utf8"));
  cache.set(kbDir, { mtimeMs, policy });
  return policy;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** A list of path-prefixes: only well-formed `string[]` entries survive (a bad entry is dropped, not fatal). */
function asPrefixes(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  const out: string[][] = [];
  for (const item of v) {
    if (Array.isArray(item) && item.every((s) => typeof s === "string")) out.push(item);
  }
  return out;
}

function parseAccess(text: string): AccessPolicy {
  const o = asRecord(parseYaml(text) as unknown);
  const adminList = Array.isArray(o["admins"]) ? o["admins"] : [];
  const admins = new Set<string>(adminList.filter((s): s is string => typeof s === "string"));
  const scopes = new Map<string, string[][]>();
  for (const [email, cfg] of Object.entries(asRecord(o["users"]))) {
    scopes.set(email, asPrefixes(asRecord(cfg)["scopes"]));
  }
  const defaultScopes = asPrefixes(asRecord(o["defaults"])["scopes"]);
  return { admins, scopes, defaultScopes };
}

/** `prefix` is a taxonomy prefix of `path` (an empty prefix — the root — matches everything). */
function isPrefix(prefix: string[], path: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((seg, i) => seg === path[i]);
}

/** Admin per the policy. Open mode (no policy) is NOT admin — admin-only ops simply aren't enforced there. */
export function isAdmin(policy: AccessPolicy | null, email: string): boolean {
  return policy !== null && policy.admins.has(email);
}

/** The write scopes for an email — `[[]]` (root) in open mode or for an admin. */
export function scopesFor(policy: AccessPolicy | null, email: string): string[][] {
  if (policy === null || policy.admins.has(email)) return [[]];
  return policy.scopes.get(email) ?? policy.defaultScopes;
}

/** May this email write at `path`? True in open mode; otherwise admin, or path under one of their scopes. */
export function canWrite(policy: AccessPolicy | null, email: string, path: string[]): boolean {
  if (policy === null || policy.admins.has(email)) return true;
  return scopesFor(policy, email).some((prefix) => isPrefix(prefix, path));
}

export type Role = "admin" | "author" | "viewer";

/** A coarse role for the UI. Open mode reads as `admin` (nothing is restricted). */
export function roleFor(policy: AccessPolicy | null, email: string): Role {
  if (policy === null || policy.admins.has(email)) return "admin";
  return scopesFor(policy, email).length > 0 ? "author" : "viewer";
}
