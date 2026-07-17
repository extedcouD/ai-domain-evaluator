/**
 * TopicList — the author workspace. Shows the manifest topics under the selected path PREFIX, grouped
 * by full path with breadcrumb headers, each group laid out as a responsive card grid (the browser
 * picks the column count from the width). A compact card shows id/title/kind + a status pill (when a
 * coverage report is loaded); clicking it replaces that grid cell with the expanded editor card, which
 * grows vertically in place. SEVERAL can be open at once (each autosaves independently) — an open card
 * is any topic whose `topicKey` matches an editor in `editors`. A brand-new topic (an editor with no
 * `original`) renders as an expanded card in its target group, or an ad-hoc group if that path is empty.
 */
import type { Dispatch } from "react";

import {
  emptyHealth,
  groupByPath,
  healthOf,
  inScope,
  pathKey,
  topicKey,
  visibleTopics,
  type Filters,
  type StatusBucket,
  type StatusIndex,
} from "../derive";
import type { Action, EditorState } from "../state";
import type { Kind, Manifest, Topic } from "../types";
import { TopicEditorFields } from "./TopicEditorFields";
import { HealthTags, Meter, StatusPill } from "./common";

const KIND_CHIPS: { kind: Kind; label: string; cls: string }[] = [
  { kind: "real", label: "real", cls: "" },
  { kind: "canary", label: "canary", cls: "k-canary" },
];

const STATUS_CHIPS: { bucket: StatusBucket; label: string; cls: string }[] = [
  { bucket: "ok", label: "grounded", cls: "" },
  { bucket: "gap", label: "gap", cls: "" },
  { bucket: "caution", label: "caution", cls: "" },
  { bucket: "alarm", label: "alarm", cls: "k-canary" },
];

/** A compact topic card (collapsed state). Clicking it opens the expanded editor card in its place. */
function TopicCard({
  t,
  index,
  hasCoverage,
  onOpen,
}: {
  t: Topic;
  index: StatusIndex;
  hasCoverage: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const result = index[[...t.path, t.id].join("/")];
  return (
    <button type="button" className={`topic-card${t.kind === "canary" ? " canary" : ""}`} onClick={onOpen}>
      <span className="tc-top">
        <span className="tc-dot" />
        <span className="tc-title">{t.title || "Untitled topic"}</span>
      </span>
      <span className="tc-id">{t.id}</span>
      <span className="tc-sample">{t.questions[0] || "No probe questions yet"}</span>
      <span className="tc-meta">
        <span className="tc-probes">{t.questions.length} probe{t.questions.length === 1 ? "" : "s"}</span>
        <span className={`r-kind ${t.kind}`}>{t.kind === "canary" ? "⚑ canary" : "real"}</span>
        {hasCoverage ? (result ? <StatusPill status={result.status} /> : <span className="pill s-none">no data</span>) : null}
      </span>
    </button>
  );
}

export function TopicList(props: {
  manifest: Manifest | null;
  manifestError: string | null;
  index: StatusIndex;
  hasCoverage: boolean;
  selectedPath: string[];
  query: string;
  kindFilter: Kind | null;
  statusFilter: StatusBucket | null;
  dispatch: Dispatch<Action>;
  onNewTopic: (kind: Kind) => void;
  onOpenTopic: (topic: Topic) => void;
  editors: EditorState[];
  onCloseEditor: (eid: string) => void;
  onDeleteEditor: (eid: string) => void;
  onKeepMine: (eid: string) => void;
  onTakeTheirs: (eid: string) => void;
  /** The user's write scopes (path-prefixes); `[[]]` = root = everything (admin / open mode). */
  scopes: string[][];
}): React.JSX.Element {
  const { manifest, dispatch, editors } = props;
  const filters: Filters = { query: props.query, kind: props.kindFilter, status: props.statusFilter };
  const topics = manifest?.topics ?? [];
  const visible = visibleTopics(topics, props.selectedPath, filters, props.index);
  const groups = groupByPath(visible);

  // Split the open editors into "editing an existing topic" (keyed by its on-disk topicKey, so a row
  // can find its accordion) and brand-new drafts (grouped by target path, rendered as synthetic rows).
  const editorsByKey = new Map<string, EditorState>();
  const draftsByPath = new Map<string, EditorState[]>();
  for (const ed of editors) {
    if (ed.original) {
      editorsByKey.set(topicKey(ed.original), ed);
    } else {
      const k = pathKey(ed.path);
      const arr = draftsByPath.get(k) ?? [];
      arr.push(ed);
      draftsByPath.set(k, arr);
    }
  }
  const groupKeys = new Set(groups.map((g) => pathKey(g.path)));
  // Draft groups whose path has no existing visible group get their own ad-hoc header at the top.
  const orphanDraftGroups = [...draftsByPath.entries()].filter(([k]) => !groupKeys.has(k));

  const renderEditor = (ed: EditorState): React.JSX.Element => (
    <TopicEditorFields
      key={ed.eid}
      editor={ed}
      index={props.index}
      hasCoverage={props.hasCoverage}
      canDelete={inScope(ed.path, props.scopes)}
      dispatch={dispatch}
      onClose={() => props.onCloseEditor(ed.eid)}
      onDelete={() => props.onDeleteEditor(ed.eid)}
      onKeepMine={() => props.onKeepMine(ed.eid)}
      onTakeTheirs={() => props.onTakeTheirs(ed.eid)}
    />
  );

  return (
    <section className="view">
      <div className="toolbar">
        <input
          className="search"
          placeholder="Search topics…"
          value={props.query}
          onChange={(e) => dispatch({ type: "setQuery", query: e.target.value })}
        />
        <div className="chips">
          {KIND_CHIPS.map((c) => (
            <button
              key={c.kind}
              type="button"
              className={`chip ${c.cls}${props.kindFilter === c.kind ? " on" : ""}`}
              onClick={() => dispatch({ type: "toggleKindFilter", kind: c.kind })}
            >
              {c.label}
            </button>
          ))}
          {props.hasCoverage
            ? STATUS_CHIPS.map((c) => (
                <button
                  key={c.bucket}
                  type="button"
                  className={`chip ${c.cls}${props.statusFilter === c.bucket ? " on" : ""}`}
                  onClick={() => dispatch({ type: "toggleStatusFilter", bucket: c.bucket })}
                >
                  {c.label}
                </button>
              ))
            : null}
        </div>
        <div className="spacer" />
        <button className="btn sm" type="button" onClick={() => props.onNewTopic("real")}>
          ＋ New topic
        </button>
      </div>

      <div className="list">
        {orphanDraftGroups.map(([k, ds]) => (
          <div className="group" key={`__draft_${k}`}>
            <div className="acc-new-group">{ds[0]!.path.join(" / ") || "(no path)"} · new topic</div>
            <div className="card-grid">{ds.map(renderEditor)}</div>
          </div>
        ))}

        {props.manifestError ? (
          <div className="empty">
            <div className="big">Manifest invalid</div>
            <div className="err" style={{ whiteSpace: "pre-wrap" }}>
              {props.manifestError}
            </div>
            {editors.length === 0 ? <div className="hint">Press “＋ New topic” to add one back — that doesn’t need a valid manifest.</div> : null}
          </div>
        ) : (
          <>
            {groups.length === 0 && orphanDraftGroups.length === 0 ? (
              <div className="empty">
                <div className="big">{topics.length ? "No matches" : "No topics yet"}</div>
                {topics.length ? "Nothing matches the current search or filters." : "Press “＋ New topic” to author the first one."}
              </div>
            ) : (
              groups.map((g) => {
                const under = topics.filter((t) => pathKey(t.path) === pathKey(g.path));
                const health = props.hasCoverage ? healthOf(under, props.index) : emptyHealth();
                const groupDrafts = draftsByPath.get(pathKey(g.path)) ?? [];
                return (
                  <div className="group" key={pathKey(g.path)}>
                    <div className="group-head">
                      <span className="g-name">{g.path.join(" / ")}</span>
                      <span className="g-count">
                        {g.topics.length}
                        {g.topics.length !== under.length ? `/${String(under.length)}` : ""}
                      </span>
                      {props.hasCoverage ? (
                        <span className="g-health">
                          <span className="g-tags">
                            <HealthTags counts={health} hasCoverage />
                          </span>
                          <Meter counts={health} />
                        </span>
                      ) : null}
                    </div>
                    <div className="card-grid">
                      {groupDrafts.map(renderEditor)}
                      {g.topics.map((t) => {
                        const ed = editorsByKey.get(topicKey(t));
                        return ed ? (
                          renderEditor(ed)
                        ) : (
                          <TopicCard
                            key={t.id}
                            t={t}
                            index={props.index}
                            hasCoverage={props.hasCoverage}
                            onOpen={() => props.onOpenTopic(t)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </section>
  );
}
