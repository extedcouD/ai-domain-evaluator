/**
 * The code-forge seam — opening, listing, and merging pull requests — behind one interface, so the
 * review flow doesn't hard-depend on GitHub and tests can inject a fake (mirrors how the engine hides
 * the LLM behind one seam). The GitHub adapter talks to the REST API with plain `fetch` (Node 22 has it
 * global), so there's NO SDK dependency — consistent with the server's zero-dep posture.
 */

/** A pull request as the review UI shows it. */
export interface Proposal {
  number: number;
  title: string;
  url: string;
  /** The head branch, i.e. `user/<login>`. */
  branch: string;
  author: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
}

export interface Forge {
  /** Open a PR for `head` → `base`, or return the existing OPEN one (idempotent — safe to resubmit). */
  openOrGet(opts: { head: string; base: string; title: string; body: string }): Promise<Proposal>;
  /** All open PRs — the review queue. */
  listOpen(): Promise<Proposal[]>;
  /** Merge a PR into its base (the reviewer's action). */
  merge(number: number): Promise<void>;
}

export interface GitHubForgeOptions {
  token: string;
  owner: string;
  repo: string;
  /** Override for GitHub Enterprise; defaults to the public API. */
  apiBase?: string;
  /** Merge strategy (default `squash` — keeps `main` history one-commit-per-proposal). */
  mergeMethod?: "merge" | "squash" | "rebase";
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function toProposal(raw: unknown): Proposal {
  const o = obj(raw);
  const merged = o["merged_at"] != null;
  const state = str(o, "state"); // "open" | "closed"
  const num = o["number"];
  return {
    number: typeof num === "number" ? num : 0,
    title: str(o, "title"),
    url: str(o, "html_url"),
    branch: str(obj(o["head"]), "ref"),
    author: str(obj(o["user"]), "login"),
    state: merged ? "merged" : state === "closed" ? "closed" : "open",
    createdAt: str(o, "created_at"),
  };
}

/** A GitHub-backed `Forge` over the REST API using global `fetch` — no SDK. */
export function createGitHubForge(opts: GitHubForgeOptions): Forge {
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const repoUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };

  async function api(method: string, path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${repoUrl}${path}`, init);
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${String(res.status)}: ${await res.text()}`);
    if (res.status === 204) return null;
    const data: unknown = await res.json();
    return data;
  }

  return {
    async openOrGet({ head, base, title, body }) {
      const existing = await api("GET", `/pulls?state=open&head=${encodeURIComponent(`${opts.owner}:${head}`)}`);
      if (Array.isArray(existing) && existing.length > 0) return toProposal(existing[0]);
      return toProposal(await api("POST", "/pulls", { head, base, title, body }));
    },
    async listOpen() {
      const prs = await api("GET", "/pulls?state=open&per_page=100");
      return Array.isArray(prs) ? prs.map(toProposal) : [];
    },
    async merge(number) {
      await api("PUT", `/pulls/${String(number)}/merge`, { merge_method: opts.mergeMethod ?? "squash" });
    },
  };
}
