/**
 * PathTree — the left spine ("Explorer"). Renders the ragged taxonomy (`GET /api/nodes`) as a recursive,
 * collapsible drill-down: domain → version → usecase … Each node shows a folder/leaf icon, its segment, a
 * topic count, and — when a coverage report is loaded — a small health meter. Selecting a node filters the
 * topic list to that path PREFIX; an "All" root clears the filter. Right-clicking a node (or the root)
 * highlights it and opens a context menu to create a topic there, add a child node, rename/move it, or
 * delete it (with a cascade confirm handled by the parent when non-empty). Indentation is applied via
 * padding (not margin) on a `width: 100%; box-sizing: border-box` row, so deep nesting truncates the name
 * instead of pushing the row past the panel's edge; the panel itself is resizable via a drag handle on its
 * right edge, persisted in localStorage like the theme.
 */
import { useEffect, useRef, useState, type Dispatch } from "react";

import {
  buildNodeTree,
  emptyHealth,
  healthOf,
  inScope,
  pathKey,
  pathStartsWith,
  slug,
  type HealthCounts,
  type StatusIndex,
  type TreeNode,
} from "../derive";
import type { Action } from "../state";
import type { Manifest, NodeInfo, Topic } from "../types";
import { clampMenuPos, ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { HealthTags, Meter } from "./common";

type Editing =
  | { mode: "create"; parent: string[] }
  | { mode: "rename"; path: string[] }
  | null;

type Menu = { x: number; y: number; path: string[]; isRoot: boolean } | null;

interface Ctx {
  topics: Topic[];
  index: StatusIndex;
  hasCoverage: boolean;
  selectedPath: string[];
  collapsed: Record<string, boolean>;
  menuPath: string[] | null;
  dispatch: Dispatch<Action>;
  editing: Editing;
  setEditing: (e: Editing) => void;
  setMenu: (m: Menu) => void;
  onCreateNode: (path: string[]) => void;
  onRenameNode: (from: string[], to: string[]) => void;
  onDeleteNode: (path: string[], hasTopics: boolean) => void;
}

const INDENT_BASE = 8;
const INDENT_STEP = 14;

function healthUnder(ctx: Ctx, prefix: string[]): { count: number; health: HealthCounts } {
  const under = ctx.topics.filter((t) => pathStartsWith(t.path, prefix));
  return { count: under.length, health: ctx.hasCoverage ? healthOf(under, ctx.index) : emptyHealth() };
}

/** Minimal monochrome folder glyphs (currentColor), matching the disclosure triangle's weight. */
function TreeIcon({ kind }: { kind: "folder" | "folder-open" | "root" }): React.JSX.Element {
  if (kind === "root") {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <ellipse cx="8" cy="3.4" rx="5.3" ry="1.8" stroke="currentColor" strokeWidth="1.1" />
        <path d="M2.7 3.4V12.6C2.7 13.6 5.07 14.4 8 14.4C10.93 14.4 13.3 13.6 13.3 12.6V3.4" stroke="currentColor" strokeWidth="1.1" />
        <path d="M2.7 8C2.7 9 5.07 9.8 8 9.8C10.93 9.8 13.3 9 13.3 8" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    );
  }
  if (kind === "folder-open") {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5.5C2 4.67 2.67 4 3.5 4H6.17C6.57 4 6.94 4.16 7.22 4.43L7.52 4.73C7.79 5.01 8.17 5.17 8.57 5.17H12.5C13.1 5.17 13.55 5.55 13.4 6.13L12.3 11.13C12.19 11.63 11.74 12 11.23 12H3.5C2.67 12 2 11.33 2 10.5V5.5Z"
          stroke="currentColor"
          strokeWidth="1.15"
        />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.5C2 3.67 2.67 3 3.5 3H6.17C6.57 3 6.94 3.16 7.22 3.43L7.77 3.98C8.04 4.26 8.42 4.42 8.82 4.42H12.5C13.33 4.42 14 5.09 14 5.92V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.15"
      />
    </svg>
  );
}

function InlineInput({
  initial,
  indent,
  onCommit,
  onCancel,
}: {
  initial: string;
  indent?: number;
  onCommit: (v: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <div className="seg-area editing" style={indent ? { paddingLeft: indent } : undefined}>
      <input
        className="f"
        autoFocus
        placeholder="segment-name"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(slug(v));
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(slug(v))}
      />
    </div>
  );
}

function NodeRow({ node, depth, ctx }: { node: TreeNode; depth: number; ctx: Ctx }): React.JSX.Element {
  const key = pathKey(node.path);
  const selected = pathKey(ctx.selectedPath) === key;
  const contextActive = ctx.menuPath !== null && pathKey(ctx.menuPath) === key;
  const collapsed = ctx.collapsed[key] ?? false;
  const { count, health } = healthUnder(ctx, node.path);
  const isRenaming = ctx.editing?.mode === "rename" && pathKey(ctx.editing.path) === key;
  const indent = INDENT_BASE + depth * INDENT_STEP;

  if (isRenaming) {
    return <InlineInput initial={node.segment} indent={indent} onCancel={() => ctx.setEditing(null)} onCommit={(v) => {
      ctx.setEditing(null);
      if (v && v !== node.segment) ctx.onRenameNode(node.path, [...node.path.slice(0, -1), v]);
    }} />;
  }

  return (
    <>
      <div
        className={`seg-area${selected ? " sel" : ""}${contextActive ? " ctx" : ""}`}
        role="button"
        tabIndex={0}
        style={{ paddingLeft: indent }}
        onClick={() => ctx.dispatch({ type: "selectPath", path: node.path })}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = clampMenuPos(e.clientX, e.clientY);
          ctx.setMenu({ ...p, path: node.path, isRoot: false });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") ctx.dispatch({ type: "selectPath", path: node.path });
        }}
      >
        <div className="seg-top">
          {node.children.length > 0 ? (
            <button
              className="mini tw"
              type="button"
              title={collapsed ? "Expand" : "Collapse"}
              onClick={(e) => {
                e.stopPropagation();
                ctx.dispatch({ type: "toggleCollapse", path: node.path });
              }}
            >
              {collapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="tw-spacer" />
          )}
          <span className="seg-icon">
            <TreeIcon kind={node.children.length > 0 && !collapsed ? "folder-open" : "folder"} />
          </span>
          <span className="seg-name">{node.segment}</span>
          <span className="seg-count">{count}</span>
        </div>
        {ctx.hasCoverage ? (
          <>
            <Meter counts={health} />
            <div className="seg-tags">
              <HealthTags counts={{ ...health, total: count }} hasCoverage={ctx.hasCoverage} />
            </div>
          </>
        ) : null}
      </div>

      {ctx.editing?.mode === "create" && pathKey(ctx.editing.parent) === key ? (
        <InlineInput
          initial=""
          indent={INDENT_BASE + (depth + 1) * INDENT_STEP}
          onCancel={() => ctx.setEditing(null)}
          onCommit={(v) => {
            ctx.setEditing(null);
            if (v) ctx.onCreateNode([...node.path, v]);
          }}
        />
      ) : null}

      {!collapsed
        ? node.children.map((child) => <NodeRow key={pathKey(child.path)} node={child} depth={depth + 1} ctx={ctx} />)
        : null}
    </>
  );
}

const RAIL_MIN = 180;
const RAIL_MAX = 480;
const RAIL_DEFAULT = 232;
const RAIL_STORAGE_KEY = "kb-rail-width";

function clampRail(px: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

/** A VS Code–style drag handle on the panel's right edge; writes `--rail` live and persists on release. */
function ResizeHandle(): React.JSX.Element {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RAIL_STORAGE_KEY);
      if (saved) document.documentElement.style.setProperty("--rail", `${String(clampRail(Number(saved)))}px`);
    } catch {
      /* ignore */
    }
  }, []);

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const current = getComputedStyle(document.documentElement).getPropertyValue("--rail");
    const startWidth = parseInt(current, 10) || RAIL_DEFAULT;
    dragging.current = true;
    setActive(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return;
      const w = clampRail(startWidth + (ev.clientX - startX));
      document.documentElement.style.setProperty("--rail", `${String(w)}px`);
    };
    const onUp = (): void => {
      dragging.current = false;
      setActive(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--rail"), 10);
      try {
        if (w) window.localStorage.setItem(RAIL_STORAGE_KEY, String(w));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return <div className={`spine-resize${active ? " active" : ""}`} onMouseDown={onMouseDown} title="Drag to resize" />;
}

export function PathTree(props: {
  nodes: NodeInfo[];
  manifest: Manifest | null;
  index: StatusIndex;
  hasCoverage: boolean;
  selectedPath: string[];
  collapsed: Record<string, boolean>;
  dispatch: Dispatch<Action>;
  onCreateNode: (path: string[]) => void;
  onRenameNode: (from: string[], to: string[]) => void;
  onDeleteNode: (path: string[], hasTopics: boolean) => void;
  /** The user's write scopes; out-of-scope nodes hide Rename/Delete (the server enforces too). */
  scopes: string[][];
}): React.JSX.Element {
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const tree = buildNodeTree(props.nodes);
  const topics = props.manifest?.topics ?? [];

  const ctx: Ctx = {
    topics,
    index: props.index,
    hasCoverage: props.hasCoverage,
    selectedPath: props.selectedPath,
    collapsed: props.collapsed,
    menuPath: menu ? menu.path : null,
    dispatch: props.dispatch,
    editing,
    setEditing,
    setMenu,
    onCreateNode: props.onCreateNode,
    onRenameNode: props.onRenameNode,
    onDeleteNode: props.onDeleteNode,
  };

  const rootHealth = healthUnder(ctx, []);
  const rootActive = menu !== null && menu.isRoot;

  // Rename/Delete are shown only where the user may write (the server 403s anyway; this avoids the toast).
  const canEditMenu = menu !== null && !menu.isRoot && inScope(menu.path, props.scopes);
  const menuItems: ContextMenuItem[] = menu
    ? [
        { label: "＋  New sub-node", onClick: () => setEditing({ mode: "create", parent: menu.path }) },
        ...(canEditMenu
          ? [
              { label: "Rename…", onClick: () => setEditing({ mode: "rename", path: menu.path }) },
              {
                label: "Delete node",
                danger: true,
                onClick: () => {
                  const under = topics.filter((t) => pathStartsWith(t.path, menu.path));
                  ctx.onDeleteNode(menu.path, under.length > 0);
                },
              },
            ]
          : []),
      ]
    : [];

  return (
    <aside className="spine">
      <div className="spine-scroll ws-scroll">
        <div className="spine-label-row">
          <span className="spine-label">Explorer</span>
          <span className="spine-hint">right-click ⋯</span>
        </div>
        <div
          className={`seg-area${props.selectedPath.length === 0 ? " sel" : ""}${rootActive ? " ctx" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => props.dispatch({ type: "selectPath", path: [] })}
          onContextMenu={(e) => {
            e.preventDefault();
            const p = clampMenuPos(e.clientX, e.clientY);
            setMenu({ ...p, path: [], isRoot: true });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") props.dispatch({ type: "selectPath", path: [] });
          }}
        >
          <div className="seg-top">
            <span className="tw-spacer" />
            <span className="seg-icon">
              <TreeIcon kind="root" />
            </span>
            <span className="seg-name">{props.manifest?.id ?? "all"}</span>
            <span className="seg-count">{rootHealth.count}</span>
          </div>
          {props.hasCoverage ? (
            <>
              <Meter counts={rootHealth.health} />
              <div className="seg-tags">
                <HealthTags counts={{ ...rootHealth.health, total: rootHealth.count }} hasCoverage={props.hasCoverage} />
              </div>
            </>
          ) : null}
        </div>

        {tree.map((node) => (
          <NodeRow key={pathKey(node.path)} node={node} depth={0} ctx={ctx} />
        ))}

        {editing?.mode === "create" && editing.parent.length === 0 ? (
          <InlineInput
            initial=""
            onCancel={() => setEditing(null)}
            onCommit={(v) => {
              setEditing(null);
              if (v) props.onCreateNode([v]);
            }}
          />
        ) : (
          <button className="seg-area add-area" type="button" onClick={() => setEditing({ mode: "create", parent: [] })}>
            <span className="seg-name">＋ new node</span>
          </button>
        )}
      </div>

      <ResizeHandle />

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.isRoot ? (props.manifest?.id ?? "all") : menu.path.join("/")}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );
}
