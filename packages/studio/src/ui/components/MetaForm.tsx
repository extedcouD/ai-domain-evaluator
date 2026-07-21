/**
 * MetaForm — the manifest identity editor: `{ id, version }`, the source subject (a noun-phrase naming
 * the domain), and the taxonomy level LABELS (`levels`, PUT /api/meta), plus the Export button
 * (regenerates the committed manifest.yaml). Shared by the Header's "Manifest ▾" disclosure and the
 * Admin page, so both edit identity through one form.
 */
import { useEffect, useState } from "react";

import { suggestLevelLabels } from "../derive";
import type { Manifest, NodeInfo } from "../types";

export function MetaForm({
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
    <>
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
    </>
  );
}
