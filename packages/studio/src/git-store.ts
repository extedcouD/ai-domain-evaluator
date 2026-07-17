/**
 * GitStore — the safety net that makes every KB mutation an attributed, recoverable git commit.
 *
 * The KB is already a git-tracked folder of one-topic-per-file YAML, so "don't lose work to deletion"
 * reduces to "make every write a commit and never hard-lose history." This wraps the KB directory's
 * git repo and gives the server four things:
 *   1. `commit()` — run the fs mutation, then stage + commit it, authored as the acting user. All
 *      commits pass through ONE async mutex, because two concurrent `git add`/`commit` would race the
 *      index. Reads never take the lock.
 *   2. `atomicWrite()` — temp-file + rename, so a reader (or a crash) never sees a half-written file.
 *   3. `logCommits()` / `listDeletions()` / `showFile()` — the history + trash views.
 *   4. `restore()` — bring a file back from any prior commit (a deleted topic, a bad edit, a whole
 *      cascade-deleted subtree — restored file by file).
 *
 * It resolves the repo root once (`git rev-parse --show-toplevel`) so it works whether the KB dir IS
 * the repo or a subdirectory of it: every git path is made relative to the root, and staging is scoped
 * to the KB prefix so an unrelated dirty index elsewhere is never swept into a KB commit. When the dir
 * is NOT inside a git repo (e.g. a test temp dir, or git unavailable) every method degrades to a plain
 * fs write / empty history — the server keeps working, just without the safety net.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";

import { Mutex } from "async-mutex";
import { simpleGit, type SimpleGit } from "simple-git";

/** Who a commit is attributed to. Sourced from the authenticated request (see `actor.ts`, Phase 1). */
export interface Actor {
  name: string;
  email: string;
}

/** One commit, as the History view shows it. */
export interface HistoryEntry {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

/** A file that was deleted in some commit, with the sha to restore its pre-deletion content from. */
export interface DeletedEntry {
  /** Repo-root-relative path of the deleted file, e.g. `kb/topics/ondc/x.yaml`. */
  file: string;
  /** The commit BEFORE the deletion — `showFile(restoreSha, …)` yields the last live content. */
  restoreSha: string;
  deletedAt: string;
  deletedBy: string;
  message: string;
}

// Record/field separators for a single parseable `git log` — bytes that never occur in git metadata.
const REC = "\x1e";
const FIELD = "\x1f";

export class GitStore {
  private git: SimpleGit | null = null;
  /** Posix-style path of the KB dir relative to the repo root (`""` when the KB dir IS the root). */
  private kbPrefix = "";
  private readonly mutex = new Mutex();
  private initialized = false;

  constructor(private readonly kbDir: string) {}

  /** Locate the repo root once. Idempotent; leaves `git` null (all ops no-op) when not a repo. */
  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const root = (await simpleGit(this.kbDir).revparse(["--show-toplevel"])).trim();
      this.git = simpleGit(root);
      // `--show-toplevel` returns the CANONICAL root (symlinks resolved, e.g. macOS `/private/var/…`),
      // so canonicalize the KB dir too — otherwise `relative()` between a symlinked and a real path
      // yields a `../…` escape and every stage/commit fails with "outside repository".
      this.kbPrefix = relative(root, realpathSync(this.kbDir)).split(sep).join("/");
    } catch {
      this.git = null; // not a git repo (or no git binary) — degrade to plain fs writes
    }
  }

  /** Is the KB dir inside a git repo? When false, `commit` still writes but records no history. */
  async isRepo(): Promise<boolean> {
    await this.init();
    return this.git !== null;
  }

  /**
   * Repo-root-relative, posix-style path for an absolute path under the KB dir. Computed KB-relative
   * first (symlink-agnostic), then prefixed with `kbPrefix` (the canonical root→KB offset), so it works
   * whether the file exists yet or not and regardless of a `/private` symlink.
   */
  private rel(absPath: string): string {
    const relToKb = relative(this.kbDir, absPath);
    return (this.kbPrefix === "" ? relToKb : `${this.kbPrefix}/${relToKb}`).split(sep).join("/");
  }

  /** The pathspec scoping every stage/commit to the KB, so unrelated staged changes are never swept in. */
  private get pathspec(): string {
    return this.kbPrefix === "" ? "." : this.kbPrefix;
  }

  /**
   * Write to `${file}.tmp-<rand>` then rename over the target — atomic on one filesystem, so a
   * concurrent reader sees either the old bytes or the new, never a truncated write. The parent dir
   * must already exist (callers `mkdirSync` it first, matching the pre-existing server behavior).
   */
  atomicWrite(file: string, contents: string): void {
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
  }

  /**
   * Run `mutate()` (the fs writes) then commit the result, attributed to `actor`. Serialized through
   * the mutex so concurrent writes can never corrupt the index. Returns the new sha, or null when the
   * dir isn't a repo or the mutation produced no change (e.g. a no-op rename). `mutate`'s return value
   * is passed straight back so a handler can compute something inside the critical section.
   */
  async commit<T>(opts: { actor: Actor; message: string; mutate: () => T }): Promise<{ result: T; sha: string | null }> {
    const { actor, message, mutate } = opts;
    await this.init();
    return this.mutex.runExclusive(async () => {
      const result = mutate();
      const git = this.git;
      if (!git) return { result, sha: null };

      await git.raw(["add", "-A", "--", this.pathspec]);
      const status = (await git.raw(["status", "--porcelain", "--", this.pathspec])).trim();
      if (status === "") return { result, sha: null }; // nothing actually changed

      // `-c user.*` sets the committer for THIS commit only (no global git config needed on the host);
      // `--author` records the acting user. Both point at `actor`, so blame and history name the person.
      await git.raw([
        "-c",
        `user.name=${actor.name}`,
        "-c",
        `user.email=${actor.email}`,
        "commit",
        "-m",
        message,
        `--author=${actor.name} <${actor.email}>`,
        "--",
        this.pathspec,
      ]);
      const sha = (await git.revparse(["HEAD"])).trim();
      return { result, sha };
    });
  }

  /** Recent commits touching the KB (or one file when `absPath` is given). Empty when not a repo. */
  async logCommits(absPath: string | undefined, limit: number): Promise<HistoryEntry[]> {
    await this.init();
    if (!this.git) return [];
    const fmt = ["%H", "%an", "%ae", "%aI", "%s"].join(FIELD);
    const args = ["log", "-n", String(limit), `--pretty=format:${fmt}`];
    if (absPath) args.push("--follow", "--", this.rel(absPath));
    else args.push("--", this.pathspec);
    const out = await this.git.raw(args);
    return out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((line) => {
        const [sha = "", author = "", email = "", date = "", ...msg] = line.split(FIELD);
        return { sha, author, email, date, message: msg.join(FIELD) };
      });
  }

  /**
   * Files deleted under the KB, newest first — the "Trash" view. Each carries `restoreSha` (the commit
   * before the deletion) so `restore` can pull the last live content. Only topic YAML files under
   * `topics/` are surfaced (the recoverable unit); node-only or meta churn is ignored.
   */
  async listDeletions(limit: number): Promise<DeletedEntry[]> {
    await this.init();
    if (!this.git) return [];
    const fmt = [REC, "%H", "%aI", "%an", "%s"].join(FIELD);
    const out = await this.git.raw([
      "log",
      "-n",
      String(limit),
      "--diff-filter=D",
      "--name-only",
      `--pretty=format:${fmt}`,
      "--",
      this.pathspec,
    ]);
    const entries: DeletedEntry[] = [];
    let cur: { sha: string; date: string; author: string; message: string } | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith(REC)) {
        const [, sha = "", date = "", author = "", ...msg] = line.split(FIELD);
        cur = { sha, date, author, message: msg.join(FIELD) };
      } else if (cur && line.trim() !== "" && /\/topics\/.*\.yaml$/.test(`/${line}`)) {
        entries.push({
          file: line,
          restoreSha: `${cur.sha}~1`,
          deletedAt: cur.date,
          deletedBy: cur.author,
          message: cur.message,
        });
      }
    }
    return entries.slice(0, limit);
  }

  /** The bytes of a file as of a commit. Throws if the path didn't exist at that commit. */
  async showFile(sha: string, absPath: string): Promise<string> {
    await this.init();
    if (!this.git) throw new Error("not a git repo");
    return this.git.raw(["show", `${sha}:${this.rel(absPath)}`]);
  }

  /**
   * Restore a file to its content at `sha` and commit that restoration (attributed to `actor`). Reads
   * the historical bytes OUTSIDE the mutex (history is immutable), then writes+commits inside it.
   */
  async restore(opts: { sha: string; absPath: string; actor: Actor; message: string }): Promise<{ sha: string | null }> {
    const contents = await this.showFile(opts.sha, opts.absPath);
    const { result: _r, sha } = await this.commit({
      actor: opts.actor,
      message: opts.message,
      mutate: () => {
        mkdirSync(dirname(opts.absPath), { recursive: true });
        this.atomicWrite(opts.absPath, contents);
      },
    });
    return { sha };
  }

  /** Best-effort push for off-site backup — never throws to a caller; failures are the caller's to log. */
  async push(remote: string, branch: string): Promise<void> {
    await this.init();
    if (!this.git) return;
    await this.git.push(remote, branch);
  }
}
