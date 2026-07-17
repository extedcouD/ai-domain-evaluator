/**
 * CoverageTreeGauges — the per-level drill-down for a single report, fed by its `tree` (`CoverageNode`).
 * Rendered as a real table (level path / topics / grounded / refused / inconsistent / bite), one row per
 * node, indented and disclosure-toggled by depth so a ragged taxonomy of any depth reads top to bottom:
 * "retail 80% grounded → retail 1.2.0 60% → retail 1.2.0 search: gap". Each row is tagged with its
 * depth's LABEL from the manifest `levels` (domain/version/usecase…), so raw segments read as a hierarchy.
 */
import { useState } from "react";

import { pathKey, STATUS_BUCKET } from "../derive";
import type { CoverageNode } from "../types";

function TreeRow({ node, depth, levels }: { node: CoverageNode; depth: number; levels: string[] }): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  const label = levels[depth] ?? ""; // the human name for this taxonomy depth; "" past the declared labels
  const hasChildren = node.children.length > 0;
  const real = node.topics.filter((t) => t.kind === "real");
  const canary = node.topics.filter((t) => t.kind === "canary");
  const grounded = real.filter((t) => STATUS_BUCKET[t.status] === "ok").length;
  const refused = real.filter((t) => STATUS_BUCKET[t.status] === "gap").length;
  const inconsistent = real.filter((t) => STATUS_BUCKET[t.status] === "caution").length;
  const bite = canary.filter((t) => STATUS_BUCKET[t.status] === "alarm").length;
  return (
    <>
      <tr>
        <td>
          <div className="ct-name-cell" style={{ paddingLeft: depth * 16 }}>
            {hasChildren ? (
              <button className="mini tw" type="button" onClick={() => setOpen(!open)} title={open ? "Collapse" : "Expand"}>
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="tw-spacer" />
            )}
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13 }}>{node.segment || "all"}</span>
            {label ? (
              <span style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-neutral-500)" }}>
                {label}
              </span>
            ) : null}
          </div>
        </td>
        <td style={{ color: "var(--color-neutral-600)" }}>{node.totals.topics}</td>
        <td style={{ textAlign: "right" }}>{grounded}</td>
        <td style={{ textAlign: "right", color: "var(--color-neutral-600)" }}>{refused}</td>
        <td style={{ textAlign: "right", color: "var(--color-neutral-600)" }}>{inconsistent}</td>
        <td style={{ textAlign: "right", color: bite > 0 ? "var(--color-accent-2)" : "var(--color-neutral-600)", fontWeight: bite > 0 ? 600 : 400 }}>
          {bite}
        </td>
      </tr>
      {open && hasChildren ? node.children.map((c) => <TreeRow key={pathKey(c.path)} node={c} depth={depth + 1} levels={levels} />) : null}
    </>
  );
}

export function CoverageTreeGauges({ tree, levels }: { tree: CoverageNode; levels: string[] }): React.JSX.Element {
  return (
    <>
      <h6 style={{ color: "var(--color-neutral-600)", margin: "0 0 10px" }}>Per-level drill-down</h6>
      {tree.children.length ? (
        <table className="table" style={{ marginBottom: 34 }}>
          <thead>
            <tr>
              <th>level path</th>
              <th>topics</th>
              <th style={{ textAlign: "right" }}>grounded</th>
              <th style={{ textAlign: "right" }}>refused</th>
              <th style={{ textAlign: "right" }}>inconsistent</th>
              <th style={{ textAlign: "right" }}>bite</th>
            </tr>
          </thead>
          <tbody>
            {tree.children.map((c) => (
              <TreeRow key={pathKey(c.path)} node={c} depth={0} levels={levels} />
            ))}
          </tbody>
        </table>
      ) : (
        <div className="hint" style={{ marginBottom: 24 }}>
          No taxonomy nodes in this report.
        </div>
      )}
    </>
  );
}
