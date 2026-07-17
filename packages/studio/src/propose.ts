/**
 * The review flow — how a user's branch of KB edits reaches `main`. A user works isolated on
 * `user/<login>`; "submit for review" pushes that branch and opens a PR; a reviewer (admin) merges it.
 * `syncFromMain` keeps a long-lived draft current. These are thin, pure operations over a `Workspace`
 * (its git + branch) and a `Forge` (the PR host) — the server layers HTTP + authorization on top.
 */
import type { Forge, Proposal } from "./forge";
import type { Workspace } from "./workspace";

export interface ReviewConfig {
  forge: Forge;
  /** The git remote user branches are pushed to (default `origin`). */
  remote: string;
  /** The branch proposals target and drafts sync from (default `main`). */
  baseBranch: string;
  /** Emails allowed to merge a proposal. (Phase 3 moves this into access.yaml.) */
  admins: string[];
}

/** Push the caller's branch and open (or return the existing) PR. Requires multi-user mode. */
export async function submitForReview(ws: Workspace, review: ReviewConfig): Promise<Proposal> {
  if (!ws.branch) throw new Error("nothing to propose — not on a user branch (single-workspace mode)");
  await ws.git.push(review.remote, ws.branch);
  return review.forge.openOrGet({
    head: ws.branch,
    base: review.baseBranch,
    title: `KB updates from ${ws.actor.name}`,
    body: `Proposed by ${ws.actor.name} <${ws.actor.email}> via KB Studio.`,
  });
}

/** The open review queue. */
export function listProposals(review: ReviewConfig): Promise<Proposal[]> {
  return review.forge.listOpen();
}

/** Merge a proposal into the base branch (the reviewer's action; the server checks admin first). */
export function mergeProposal(review: ReviewConfig, number: number): Promise<void> {
  return review.forge.merge(number);
}

/** Bring the base branch into the caller's draft. Conflicts are reported, not thrown (the tree stays clean). */
export function syncFromMain(ws: Workspace, review: ReviewConfig): Promise<{ merged: boolean; conflicted: boolean }> {
  return ws.git.mergeRef(review.baseBranch);
}

/** Is the workspace's actor allowed to merge? */
export function isAdmin(review: ReviewConfig, ws: Workspace): boolean {
  return review.admins.includes(ws.actor.email);
}
