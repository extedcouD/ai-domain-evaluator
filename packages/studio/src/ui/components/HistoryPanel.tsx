/**
 * HistoryPanel — the visible half of the git safety net. A modal over `GET /api/history` with two tabs:
 * History (the recent commit log — proof that every change is attributed and traceable) and Trash (the
 * recoverable deletions, each with a one-click Restore). Nothing here is ever truly lost.
 */
import { useState } from "react";

import { topicRefFromFile } from "../derive";
import type { DeletedEntry, HistoryData } from "../types";

/** ISO 8601 → "MMM D, HH:mm" without a date lib; falls back to the raw string on a bad value. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function HistoryPanel({
  data,
  onRestore,
  onClose,
}: {
  data: HistoryData | null;
  onRestore: (entry: DeletedEntry) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<"history" | "trash">("history");

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="history-panel"
        role="dialog"
        aria-label="History and Trash"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-head">
          <div className="view-switch">
            <button
              type="button"
              className={`seg${tab === "history" ? " active" : ""}`}
              onClick={() => setTab("history")}
            >
              History
            </button>
            <button
              type="button"
              className={`seg${tab === "trash" ? " active" : ""}`}
              onClick={() => setTab("trash")}
            >
              Trash{data ? ` · ${String(data.deletions.length)}` : ""}
            </button>
          </div>
          <button className="icon-btn" type="button" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="history-body">
          {!data ? (
            <div className="history-empty">Loading…</div>
          ) : tab === "history" ? (
            data.commits.length === 0 ? (
              <div className="history-empty">
                No history yet. Every edit will appear here as a commit you can trace back.
              </div>
            ) : (
              <ul className="history-list">
                {data.commits.map((c) => (
                  <li key={c.sha} className="history-row">
                    <code className="history-sha">{c.sha.slice(0, 7)}</code>
                    <div className="history-main">
                      <div className="history-msg">{c.message}</div>
                      <div className="history-meta">
                        {c.author} · {shortDate(c.date)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : data.deletions.length === 0 ? (
            <div className="history-empty">Trash is empty — no deleted topics to recover.</div>
          ) : (
            <ul className="history-list">
              {data.deletions.map((d) => {
                const ref = topicRefFromFile(d.file);
                return (
                  <li key={`${d.restoreSha}:${d.file}`} className="history-row">
                    <span className="history-trash-icon" aria-hidden="true">
                      🗑
                    </span>
                    <div className="history-main">
                      <div className="history-msg">{ref ? [...ref.path, ref.id].join(" / ") : d.file}</div>
                      <div className="history-meta">
                        deleted by {d.deletedBy} · {shortDate(d.deletedAt)}
                      </div>
                    </div>
                    <button
                      className="btn btn-secondary sm"
                      type="button"
                      disabled={!ref}
                      onClick={() => onRestore(d)}
                    >
                      Restore
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="history-foot hint">
          Every create, edit, rename, and delete is a git commit. Deletions stay recoverable here — nothing
          is ever hard-lost.
        </div>
      </div>
    </div>
  );
}
