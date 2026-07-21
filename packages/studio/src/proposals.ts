/**
 * The review flow, Mongo-native. A "merge request" is not a snapshot or a git PR — it is simply the
 * `reviewStatus:"requested"` flag on a user workspace, and the diff shown to a reviewer is computed LIVE
 * against main every time (`merge.ts#diffWorkspace`). This module owns request/list/get/withdraw; the
 * merge itself is `merge.ts#mergeToMain`, orchestrated by the server (admin-gated, under the mutex).
 */
import type { DbHandle } from "./db";
import { diffWorkspace, summarize, type Change } from "./merge";

/** A proposal card, as the review queue lists it (no git PR number/url — the id IS the workspace slug). */
export interface Proposal {
  id: string;
  workspace: string;
  author: string;
  authorName: string;
  state: "requested";
  createdAt: string | null;
  note: string | null;
  changes: { added: number; edited: number; deleted: number; conflicted: number };
}

/** The full live diff for one proposal — the admin review view. */
export interface ProposalDetail {
  workspace: string;
  author: string;
  authorName: string;
  changes: Change[];
}

/** Flag a workspace for review (the author's "submit"). */
export async function requestReview(db: DbHandle, ws: string, note: string | null): Promise<void> {
  await db.workspaces.updateOne(
    { _id: ws },
    { $set: { reviewStatus: "requested", reviewRequestedAt: new Date(), reviewNote: note, updatedAt: new Date() } },
  );
}

/** Withdraw a review request (the author's "withdraw"). */
export async function withdrawReview(db: DbHandle, ws: string): Promise<void> {
  await db.workspaces.updateOne({ _id: ws }, { $set: { reviewStatus: "none", reviewNote: null, updatedAt: new Date() } });
}

/** The open review queue, each card carrying its live change counts. */
export async function listProposals(db: DbHandle): Promise<Proposal[]> {
  const docs = await db.workspaces.find({ reviewStatus: "requested" }).sort({ reviewRequestedAt: 1 }).toArray();
  const out: Proposal[] = [];
  for (const w of docs) {
    const changes = await diffWorkspace(db, w._id);
    out.push({
      id: w._id,
      workspace: w._id,
      author: w.owner ?? w._id,
      authorName: w.ownerName ?? (w.owner ?? w._id),
      state: "requested",
      createdAt: w.reviewRequestedAt ? w.reviewRequestedAt.toISOString() : null,
      note: w.reviewNote,
      changes: summarize(changes),
    });
  }
  return out;
}

/** The full live diff for one requested workspace, or null when it isn't under review. */
export async function getProposal(db: DbHandle, id: string): Promise<ProposalDetail | null> {
  const w = await db.workspaces.findOne({ _id: id });
  if (!w || w.reviewStatus !== "requested") return null;
  return {
    workspace: w._id,
    author: w.owner ?? w._id,
    authorName: w.ownerName ?? (w.owner ?? w._id),
    changes: await diffWorkspace(db, id),
  };
}
