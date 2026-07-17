/**
 * Workspace routing — where a request's reads and writes land.
 *
 * Single mode (the Phase 0 default): everyone shares one KB dir + one GitStore. Multi-user mode
 * (branch-per-user): each actor is routed to their own git WORKTREE checked out on `user/<login>`, so a
 * user only ever writes their own branch — they physically cannot touch `main` or another user's work.
 * Worktrees share the repo's object store (cheap) and are created lazily on first request, serialized
 * behind a mutex and cached so the git work happens once per user.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { Mutex } from "async-mutex";
import { simpleGit, type SimpleGit } from "simple-git";

import type { Actor } from "./git-store";
import { GitStore } from "./git-store";

export interface Workspace {
  /** The KB dir this request reads/writes — a per-user worktree in multi-user mode. */
  kbDir: string;
  /** The GitStore committing to this workspace's branch. */
  git: GitStore;
  /** The user branch (`user/<login>`) in multi-user mode; null when everyone shares one workspace. */
  branch: string | null;
  actor: Actor;
}

export interface WorkspaceRouter {
  resolve(actor: Actor): Promise<Workspace>;
}

/** A safe git branch / directory component derived from an actor's email (or name). */
export function loginSlug(actor: Actor): string {
  const base = (actor.email || actor.name).toLowerCase();
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

/** Single shared workspace — the Phase 0 behavior. `branch` is null (nobody is on a private branch). */
export function singleWorkspaceRouter(kbDir: string): WorkspaceRouter {
  const git = new GitStore(kbDir);
  return { resolve: (actor) => Promise.resolve({ kbDir, git, branch: null, actor }) };
}

export interface WorktreeRouterOptions {
  /** The git repo root (its main worktree holds the canonical KB on the base branch). */
  repoDir: string;
  /** A directory OUTSIDE the main tree that holds the per-user worktrees. */
  worktreesDir: string;
  /** The KB dir in the main tree — its repo-relative location is mirrored inside each worktree. */
  kbDir: string;
  /** The branch new user branches are based on (default: the repo's current HEAD, usually `main`). */
  baseBranch?: string;
}

/** Per-user worktree router: `actor → worktree on user/<login>`, created lazily and cached per login. */
export function worktreeRouter(opts: WorktreeRouterOptions): WorkspaceRouter {
  const kbSubdir = relative(opts.repoDir, opts.kbDir); // "" when the repo root IS the KB
  const cache = new Map<string, Workspace>();
  const mutex = new Mutex();

  return {
    async resolve(actor) {
      const login = loginSlug(actor);
      const hit = cache.get(login);
      if (hit) return { ...hit, actor };
      // Serialize creation: two concurrent first-requests from one user must not both `worktree add`.
      return mutex.runExclusive(async () => {
        const again = cache.get(login);
        if (again) return { ...again, actor };
        const wtPath = join(opts.worktreesDir, login);
        const branch = `user/${login}`;
        await ensureWorktree(opts.repoDir, wtPath, branch, opts.baseBranch);
        const kbDir = kbSubdir === "" ? wtPath : join(wtPath, kbSubdir);
        const ws: Workspace = { kbDir, git: new GitStore(kbDir), branch, actor };
        cache.set(login, ws);
        return ws;
      });
    },
  };
}

/** Ensure a worktree for `branch` exists at `wtPath`, creating the branch from the base on first use. */
async function ensureWorktree(repoDir: string, wtPath: string, branch: string, baseBranch?: string): Promise<void> {
  if (existsSync(join(wtPath, ".git"))) return; // a linked worktree already lives here
  const git = simpleGit(repoDir);
  mkdirSync(dirname(wtPath), { recursive: true });
  await git.raw(["worktree", "prune"]); // clear stale records (a worktree dir removed without `remove`)
  if (await branchExists(git, branch)) {
    await git.raw(["worktree", "add", wtPath, branch]);
  } else {
    const base = baseBranch ?? (await currentBranch(git));
    await git.raw(["worktree", "add", "-b", branch, wtPath, base]);
  }
}

async function branchExists(git: SimpleGit, branch: string): Promise<boolean> {
  // `branch --list` prints the branch (exit 0) or nothing (exit 0) — unlike `show-ref --quiet`, whose
  // exit-1-on-missing simple-git's `.raw` does NOT reject, so a try/catch there reads as "always exists".
  const out = await git.raw(["branch", "--list", branch]);
  return out.trim() !== "";
}

async function currentBranch(git: SimpleGit): Promise<string> {
  try {
    return (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim() || "main";
  } catch {
    return "main";
  }
}
