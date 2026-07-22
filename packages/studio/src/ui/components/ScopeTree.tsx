/**
 * ScopeTree — pick which topics a coverage run covers. A tri-state checkbox tree over the ragged
 * taxonomy (reusing `buildNodeTree`), so a huge KB can be scoped to a subtree, a few folders, or
 * individual topics before probing. Folders render collapsed and materialise their children only when
 * expanded, so even a many-thousand-topic manifest stays light.
 *
 * Selection is a Set of `topicKey`s owned by the parent (RunForm); this component is presentational and
 * calls `onChange` with the next set. RunForm turns "everything selected" into `topicKeys: null`.
 */
import { useMemo, useState } from "react";

import { buildNodeTree, pathKey, topicKey, type TreeNode } from "../derive";
import type { NodeInfo, Topic } from "../types";

type CheckState = "on" | "off" | "partial";

function Check({ state, onClick }: { state: CheckState; onClick: () => void }): React.JSX.Element {
  return (
    <span
      role="checkbox"
      aria-checked={state === "partial" ? "mixed" : state === "on"}
      tabIndex={0}
      className={`scope-check ${state}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {state === "on" ? "✓" : state === "partial" ? "–" : ""}
    </span>
  );
}

export function ScopeTree({
  topics,
  nodes,
  selected,
  onChange,
}: {
  topics: Topic[];
  nodes: NodeInfo[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { tree, topicsByPath, descKeys, allKeys } = useMemo(() => {
    const tree = buildNodeTree(nodes);
    const topicsByPath = new Map<string, Topic[]>();
    const descKeys = new Map<string, string[]>(); // pathKey → every topicKey at or under it
    const allKeys: string[] = [];
    for (const t of topics) {
      const key = topicKey(t);
      allKeys.push(key);
      const pk = pathKey(t.path);
      (topicsByPath.get(pk) ?? topicsByPath.set(pk, []).get(pk)!).push(t);
      // Register the key against every ancestor path (including its own folder).
      for (let i = 1; i <= t.path.length; i++) {
        const ak = pathKey(t.path.slice(0, i));
        (descKeys.get(ak) ?? descKeys.set(ak, []).get(ak)!).push(key);
      }
    }
    return { tree, topicsByPath, descKeys, allKeys };
  }, [topics, nodes]);

  const folderState = (path: string[]): CheckState => {
    const keys = descKeys.get(pathKey(path)) ?? [];
    if (keys.length === 0) return "off";
    let n = 0;
    for (const k of keys) if (selected.has(k)) n++;
    return n === 0 ? "off" : n === keys.length ? "on" : "partial";
  };

  const setKeys = (keys: string[], on: boolean): void => {
    const next = new Set(selected);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    onChange(next);
  };
  const toggleTopic = (key: string): void => setKeys([key], !selected.has(key));
  const toggleFolder = (path: string[]): void => {
    const keys = descKeys.get(pathKey(path)) ?? [];
    setKeys(keys, folderState(path) !== "on"); // partial or off → select all; on → clear
  };
  const toggleExpand = (pk: string): void => {
    const next = new Set(expanded);
    if (next.has(pk)) next.delete(pk);
    else next.add(pk);
    setExpanded(next);
  };

  const selectKind = (kind: "real" | "canary"): void => setKeys(topics.filter((t) => t.kind === kind).map(topicKey), true);

  const renderNode = (node: TreeNode, depth: number): React.JSX.Element => {
    const pk = pathKey(node.path);
    const isOpen = expanded.has(pk);
    const count = (descKeys.get(pk) ?? []).length;
    const directTopics = topicsByPath.get(pk) ?? [];
    return (
      <div key={pk}>
        <div className="scope-row" style={{ paddingLeft: `${String(depth * 16)}px` }}>
          <button type="button" className="scope-twist" onClick={() => toggleExpand(pk)} aria-label={isOpen ? "collapse" : "expand"}>
            {node.children.length || directTopics.length ? (isOpen ? "▾" : "▸") : "·"}
          </button>
          <Check state={folderState(node.path)} onClick={() => toggleFolder(node.path)} />
          <span className="scope-seg" onClick={() => toggleExpand(pk)}>
            {node.segment}
          </span>
          <span className="scope-count">{count}</span>
        </div>
        {isOpen && (
          <>
            {node.children.map((c) => renderNode(c, depth + 1))}
            {directTopics.map((t) => {
              const key = topicKey(t);
              return (
                <div key={key} className="scope-row leaf" style={{ paddingLeft: `${String((depth + 1) * 16)}px` }}>
                  <span className="scope-twist" />
                  <Check state={selected.has(key) ? "on" : "off"} onClick={() => toggleTopic(key)} />
                  <span className="scope-seg mono" onClick={() => toggleTopic(key)}>
                    {t.id}
                  </span>
                  <span className={`r-kind ${t.kind}`}>{t.kind}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="scope">
      <div className="scope-head">
        <span className="scope-summary">
          <b>{selected.size}</b> of {allKeys.length} topics
        </span>
        <div className="scope-actions">
          <button type="button" className="btn ghost sm" onClick={() => onChange(new Set(allKeys))}>
            All
          </button>
          <button type="button" className="btn ghost sm" onClick={() => onChange(new Set())}>
            None
          </button>
          <button type="button" className="btn ghost sm" onClick={() => selectKind("real")} title="Add all real topics">
            + real
          </button>
          <button type="button" className="btn ghost sm" onClick={() => selectKind("canary")} title="Add all canary topics">
            + canary
          </button>
        </div>
      </div>
      <div className="scope-tree">{tree.length ? tree.map((n) => renderNode(n, 0)) : <div className="hint">No topics in this KB.</div>}</div>
    </div>
  );
}
