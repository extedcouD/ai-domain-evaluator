/**
 * Header — brand, manifest identity, the Author/Coverage/Admin view switch, and chrome. The "Manifest ▾"
 * panel edits the manifest identity via the shared `MetaForm` (PUT /api/meta) and holds the Export
 * button. The Admin tab shows only to admins (mirrors the review gate). A theme toggle stamps
 * `data-theme` on the root.
 */
import { type Dispatch } from "react";

import type { Action, View } from "../state";
import type { Identity, Manifest, NodeInfo } from "../types";
import { MetaForm } from "./MetaForm";

function IdentityPanel({
  manifest,
  nodes,
  onSaveMeta,
  onExport,
}: {
  manifest: Manifest | null;
  nodes: NodeInfo[];
  onSaveMeta: (id: string, version: string, subject: string, levels: string[]) => void;
  onExport: () => void;
}): React.JSX.Element {
  return (
    <details className="identity-panel">
      <summary className="btn btn-secondary sm">Manifest ▾</summary>
      <div className="identity-body">
        <MetaForm manifest={manifest} nodes={nodes} onSaveMeta={onSaveMeta} onExport={onExport} />
      </div>
    </details>
  );
}

export function Header(props: {
  view: View;
  manifest: Manifest | null;
  nodes: NodeInfo[];
  theme: "light" | "dark" | null;
  dispatch: Dispatch<Action>;
  onSaveMeta: (id: string, version: string, subject: string, levels: string[]) => void;
  onExport: () => void;
  onOpenHistory: () => void;
  identity: Identity | null;
  onOpenProposals: () => void;
}): React.JSX.Element {
  const { view, manifest, dispatch, identity } = props;
  const topicCount = manifest?.topics.length ?? 0;
  const dateRight = view === "coverage" ? "Coverage run" : view === "admin" ? "Admin" : `Authoring · ${String(topicCount)} topics`;
  // The Admin tab is admin-only (mirrors the review gate). Everyone sees Author/Coverage.
  const isAdmin = identity?.role === "admin";
  const views: View[] = isAdmin ? ["author", "coverage", "admin"] : ["author", "coverage"];
  const viewLabel: Record<View, string> = { author: "Author", coverage: "Coverage", admin: "Admin" };
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.7 14.3 5 8 8.3 1.7 5 8 1.7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M2.4 8 8 11 13.6 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.4 11 8 14 13.6 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h1 className="brand-word">KB Studio</h1>
        </div>
        <div className="topbar-actions">
          <div className="view-switch">
            {views.map((v) => (
              <button
                key={v}
                type="button"
                className={`seg${view === v ? " active" : ""}`}
                onClick={() => dispatch({ type: "setView", view: v })}
              >
                {viewLabel[v]}
              </button>
            ))}
          </div>
          <IdentityPanel manifest={manifest} nodes={props.nodes} onSaveMeta={props.onSaveMeta} onExport={props.onExport} />
          {identity?.review && (
            <button
              className="btn btn-secondary sm"
              type="button"
              title="Review — submit your branch for review, sync with main, and merge proposals"
              onClick={props.onOpenProposals}
            >
              ⇧ Review
            </button>
          )}
          <button
            className="btn btn-secondary sm"
            type="button"
            title="History &amp; Trash — every change is a commit; deleted topics are recoverable here"
            onClick={props.onOpenHistory}
          >
            ⟲ History
          </button>
          <button
            className="icon-btn"
            type="button"
            title="Toggle theme"
            onClick={() => dispatch({ type: "setTheme", theme: props.theme === "dark" ? "light" : "dark" })}
          >
            ◑
          </button>
        </div>
      </div>

      <div className="topbar-rule" />
      <div className="dateline">
        <span className="manifest-id">
          {manifest?.id ?? "…"}
          <span className="ver">@{manifest?.version ?? "?"}</span>
        </span>
        {manifest?.subject ? (
          <>
            <span className="dateline-sep">·</span>
            <span className="manifest-subject">{manifest.subject}</span>
          </>
        ) : (
          <span className="spacer" />
        )}
        <span className="dateline-sep">·</span>
        <span className="dateline-right">{dateRight}</span>
        {identity && (
          <span className="identity-chip" title={`signed in as ${identity.actor.email} (${identity.role})`}>
            {identity.actor.name} · {identity.role} · <code>{identity.workspace}</code>
          </span>
        )}
      </div>
      <div className="topbar-divider" />
    </header>
  );
}
