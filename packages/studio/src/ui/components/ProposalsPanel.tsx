/**
 * ProposalsPanel — the review flow's UI. "Submit for review" pushes your branch and opens a PR; "Sync
 * with main" pulls the latest shared KB into your draft; the list is the open review queue, each with a
 * Merge button (the server enforces admin-only — a non-admin gets a clear error). Your edits reach the
 * shared KB only after a reviewer merges, so nothing lands on `main` unreviewed.
 */
import type { Identity, Proposal } from "../types";

export function ProposalsPanel({
  identity,
  proposals,
  onSubmit,
  onSync,
  onMerge,
  onClose,
}: {
  identity: Identity | null;
  proposals: Proposal[] | null;
  onSubmit: () => void;
  onSync: () => void;
  onMerge: (n: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const branch = identity?.branch ?? null;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="history-panel" role="dialog" aria-label="Review" onClick={(e) => e.stopPropagation()}>
        <div className="history-head">
          <strong>Review</strong>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="review-actions">
          <div className="review-branch">
            {branch ? (
              <>
                Your branch <code>{branch}</code>
              </>
            ) : (
              "single-workspace mode — no branch to propose"
            )}
          </div>
          <div className="review-btns">
            <button className="btn btn-primary sm" type="button" disabled={!branch} onClick={onSubmit}>
              Submit for review
            </button>
            <button className="btn btn-secondary sm" type="button" disabled={!branch} onClick={onSync}>
              Sync with main
            </button>
          </div>
        </div>

        <div className="history-body">
          {!proposals ? (
            <div className="history-empty">Loading…</div>
          ) : proposals.length === 0 ? (
            <div className="history-empty">No open proposals. Submit your branch to open one for review.</div>
          ) : (
            <ul className="history-list">
              {proposals.map((p) => (
                <li key={p.number} className="history-row">
                  <code className="history-sha">#{String(p.number)}</code>
                  <div className="history-main">
                    <div className="history-msg">
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                    </div>
                    <div className="history-meta">
                      {p.branch} · by {p.author}
                    </div>
                  </div>
                  <button className="btn btn-secondary sm" type="button" onClick={() => onMerge(p.number)}>
                    Merge
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="history-foot hint">
          Submit pushes your branch and opens a PR. Changes reach the shared KB only after a reviewer merges
          — nothing lands on <code>main</code> unreviewed.
        </div>
      </div>
    </div>
  );
}
