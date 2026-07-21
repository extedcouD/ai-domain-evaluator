/**
 * ProposalsPanel — the review flow's UI, Mongo-native. An author submits their workspace for review,
 * syncs main into it, resolves any conflicts inline, or withdraws. A reviewer (admin) sees the queue of
 * workspaces under review, expands one to inspect its live diff, and merges it. Nothing lands on `main`
 * until a reviewer merges; a conflicting proposal shows a banner and cannot merge until the author syncs.
 */
import { useState } from "react";

import type { Change, Identity, Proposal, ProposalDetail } from "../types";

const CLASS_LABEL: Record<Change["class"], string> = { add: "added", edit: "edited", delete: "deleted", conflict: "conflict" };
const CLASS_CLS: Record<Change["class"], string> = { add: "s-ok", edit: "s-warn", delete: "s-muted", conflict: "s-alarm" };

function ChangeRow({ c }: { c: Change }): React.JSX.Element {
  return (
    <li className="history-row">
      <code className={`history-sha ${CLASS_CLS[c.class]}`}>{c.conflictKind ?? CLASS_LABEL[c.class]}</code>
      <div className="history-main">
        <div className="history-msg">{c.title}</div>
        <div className="history-meta">
          <code>{c.key}</code>
        </div>
      </div>
    </li>
  );
}

function ConflictResolver({ conflicts, onResolve, onDismiss }: { conflicts: Change[]; onResolve: (key: string, choose: "mine" | "theirs") => void; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="banner warn" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>{conflicts.length} conflict(s) to resolve</strong>
        <button className="mini" type="button" title="Dismiss" style={{ marginLeft: "auto" }} onClick={onDismiss}>
          ✕
        </button>
      </div>
      <ul className="history-list" style={{ marginTop: 8 }}>
        {conflicts.map((c) => (
          <li key={c.key} className="history-row">
            <div className="history-main">
              <div className="history-msg">{c.title}</div>
              <div className="history-meta">
                <code>{c.key}</code> · {c.conflictKind}
              </div>
            </div>
            <div className="review-btns">
              <button className="btn btn-secondary sm" type="button" onClick={() => onResolve(c.key, "mine")}>
                Keep mine
              </button>
              <button className="btn btn-secondary sm" type="button" onClick={() => onResolve(c.key, "theirs")}>
                Take theirs
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProposalsPanel({
  identity,
  proposals,
  details,
  syncConflicts,
  onSubmit,
  onWithdraw,
  onSync,
  onResolve,
  onDismissConflicts,
  onExpand,
  onMerge,
  onClose,
}: {
  identity: Identity | null;
  proposals: Proposal[] | null;
  details: Record<string, ProposalDetail>;
  syncConflicts: Change[] | null;
  onSubmit: (note?: string) => void;
  onWithdraw: () => void;
  onSync: () => void;
  onResolve: (key: string, choose: "mine" | "theirs") => void;
  onDismissConflicts: () => void;
  onExpand: (id: string) => void;
  onMerge: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const workspace = identity?.workspace ?? "main";
  const isAuthor = identity?.role === "author" && workspace !== "main";
  const isAdmin = identity?.role === "admin";
  const mine = proposals?.find((p) => p.workspace === workspace) ?? null;

  const toggle = (id: string): void => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!details[id]) onExpand(id);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="history-panel" role="dialog" aria-label="Review" onClick={(e) => e.stopPropagation()}>
        <div className="history-head">
          <strong>Review</strong>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {isAuthor ? (
          <div className="review-actions">
            <div className="review-branch">
              Your workspace <code>{workspace}</code>
              {mine ? " · submitted for review" : ""}
            </div>
            {!mine && (
              <input className="f" style={{ marginBottom: 8 }} placeholder="note for the reviewer (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            )}
            <div className="review-btns">
              {mine ? (
                <button className="btn btn-secondary sm" type="button" onClick={onWithdraw}>
                  Withdraw
                </button>
              ) : (
                <button className="btn btn-primary sm" type="button" onClick={() => onSubmit(note.trim() || undefined)}>
                  Submit for review
                </button>
              )}
              <button className="btn btn-secondary sm" type="button" onClick={onSync}>
                Sync with main
              </button>
            </div>
          </div>
        ) : (
          <div className="review-actions">
            <div className="review-branch">
              You are on <code>main</code> — review and merge proposals below.
            </div>
          </div>
        )}

        {syncConflicts && <ConflictResolver conflicts={syncConflicts} onResolve={onResolve} onDismiss={onDismissConflicts} />}

        <div className="history-body">
          {!proposals ? (
            <div className="history-empty">Loading…</div>
          ) : proposals.length === 0 ? (
            <div className="history-empty">No open proposals. An author submits their workspace to open one.</div>
          ) : (
            <ul className="history-list">
              {proposals.map((p) => {
                const c = p.changes;
                const detail = details[p.id];
                const open = expanded === p.id;
                return (
                  <li key={p.id} className="history-row" style={{ flexWrap: "wrap" }}>
                    <button className="icon-btn" type="button" title={open ? "Collapse" : "Expand"} onClick={() => toggle(p.id)}>
                      {open ? "▾" : "▸"}
                    </button>
                    <div className="history-main">
                      <div className="history-msg">
                        <code>{p.workspace}</code> · by {p.authorName}
                      </div>
                      <div className="history-meta">
                        +{c.added} ~{c.edited} −{c.deleted}
                        {c.conflicted > 0 && <span className="s-alarm"> · {c.conflicted} conflict(s)</span>}
                        {p.note ? ` · “${p.note}”` : ""}
                      </div>
                    </div>
                    {isAdmin && (
                      <button className="btn btn-secondary sm" type="button" disabled={c.conflicted > 0} title={c.conflicted > 0 ? "Author must sync + resolve first" : "Merge into main"} onClick={() => onMerge(p.id)}>
                        Merge
                      </button>
                    )}
                    {open && (
                      <ul className="history-list" style={{ flexBasis: "100%", marginTop: 8, paddingLeft: 12 }}>
                        {!detail ? (
                          <div className="history-empty">Loading diff…</div>
                        ) : detail.changes.length === 0 ? (
                          <div className="history-empty">No changes.</div>
                        ) : (
                          detail.changes.map((ch) => <ChangeRow key={ch.key} c={ch} />)
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="history-foot hint">
          Submitting flags your workspace for review. Changes reach <code>main</code> only after an admin merges — a conflicting proposal must be
          synced and resolved first.
        </div>
      </div>
    </div>
  );
}
