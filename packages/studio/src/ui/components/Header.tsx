/**
 * Header — brand, manifest identity, the Author/Coverage view switch, and chrome. The "Manifest ▾"
 * panel edits the manifest identity `{ id, version }`, the source subject (a noun-phrase naming the
 * domain), and the taxonomy level LABELS (`levels`, PUT /api/meta), and holds the Export button
 * (regenerates the committed manifest.yaml). A theme toggle stamps `data-theme` on the root.
 */
import { useEffect, useState, type Dispatch } from "react";

import { suggestLevelLabels } from "../derive";
import type { Action, View } from "../state";
import type { Identity, Manifest, NodeInfo } from "../types";

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
  const [id, setId] = useState(manifest?.id ?? "");
  const [version, setVersion] = useState(manifest?.version ?? "");
  const [subject, setSubject] = useState(manifest?.subject ?? "");
  const [levels, setLevels] = useState<string[]>(manifest?.levels ?? []);

  // Resync the form when the loaded manifest changes underneath us.
  useEffect(() => {
    setId(manifest?.id ?? "");
    setVersion(manifest?.version ?? "");
    setSubject(manifest?.subject ?? "");
    setLevels(manifest?.levels ?? []);
  }, [manifest]);

  // Auto-labels derived from the folder taxonomy: prefer the full node list (includes empty folders);
  // fall back to topic paths when nodes haven't loaded. Labels are display-only, so this only seeds the
  // form — nothing persists until "Save identity".
  const folderPaths = nodes.length > 0 ? nodes.map((n) => n.path) : (manifest?.topics ?? []).map((t) => t.path);
  const suggested = suggestLevelLabels(folderPaths);

  return (
    <details className="identity-panel">
      <summary className="btn btn-secondary sm">Manifest ▾</summary>
      <div className="identity-body">
        <h6>Manifest identity</h6>
        <label>id</label>
        <input className="f" value={id} onChange={(e) => setId(e.target.value)} />
        <label>version</label>
        <input className="f" value={version} onChange={(e) => setVersion(e.target.value)} />

        <label>subject</label>
        <input
          className="f"
          placeholder="a noun-phrase naming the domain (e.g. the ONDC protocol specifications)"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />

        <div className="id-line" style={{ justifyContent: "space-between", marginBottom: 2 }}>
          <label style={{ margin: 0 }}>level labels</label>
          <button
            className="btn ghost sm"
            type="button"
            title="Fill one label per taxonomy depth from the current folder structure (editable)"
            disabled={suggested.length === 0}
            onClick={() => setLevels(suggested)}
          >
            ⣿ From folders
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
          {levels.map((l, i) => (
            <div className="id-line" key={i} style={{ width: "100%" }}>
              <input
                className="f"
                placeholder={`level ${String(i + 1)}`}
                value={l}
                onChange={(e) => setLevels(levels.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button className="mini" type="button" title="Remove level" onClick={() => setLevels(levels.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <button className="btn ghost sm" type="button" onClick={() => setLevels([...levels, ""])}>
          ＋ Add level label
        </button>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            className="btn-primary btn sm"
            type="button"
            onClick={() => onSaveMeta(id.trim(), version.trim(), subject.trim(), levels.map((l) => l.trim()).filter(Boolean))}
          >
            Save identity
          </button>
          <button className="btn ghost sm" type="button" style={{ marginLeft: "auto" }} onClick={onExport}>
            Export .yaml
          </button>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          Per-topic files are the source of truth. Export regenerates the committed manifest.yaml snapshot.
        </div>
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
  const dateRight = view === "coverage" ? "Coverage run" : `Authoring · ${String(topicCount)} topics`;
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
            {(["author", "coverage"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`seg${view === v ? " active" : ""}`}
                onClick={() => dispatch({ type: "setView", view: v })}
              >
                {v === "author" ? "Author" : "Coverage"}
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
        {identity?.branch && (
          <span className="identity-chip" title={`signed in as ${identity.actor.email} (${identity.role})`}>
            {identity.actor.name} · {identity.role} · <code>{identity.branch}</code>
          </span>
        )}
      </div>
      <div className="topbar-divider" />
    </header>
  );
}
