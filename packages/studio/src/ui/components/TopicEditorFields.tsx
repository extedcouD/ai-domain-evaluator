/**
 * TopicEditorFields — the topic editor's form body plus footer actions, rendered inline (as an accordion
 * under its topic row in `TopicList`, not a slide-in sheet). A single compact header row holds the title,
 * an auto-slugged/validated id, and the real/canary toggle; the probe phrasings (≥1) are authored as a
 * chip list — type in the add box and press ↵ to commit a chip, click a chip to edit it in place, ✕ to
 * remove. The path is fixed at creation-time (set from the selected tree node) and is not editable here.
 * There is no Save button — App autosaves each open editor on a debounce (a changed id renames via the
 * server's `previous`), and the footer shows the live Saving…/Saved/Can't-save state. The card collapses
 * (accordion-style) via the ▴ caret in its top bar — there is no Close button; Duplicate (opens a fresh
 * copy) and Delete live in the footer. Chip draft / which-chip-is-editing is ephemeral local state; the
 * phrasing array itself is the editor's source of truth (dispatched via `editorSetQuestions`).
 */
import { useState, type Dispatch } from "react";

import { topicKey, type StatusIndex } from "../derive";
import { validateEditor, type Action, type EditorState } from "../state";
import { StatusPill } from "./common";

export function TopicEditorFields(props: {
  editor: EditorState;
  index: StatusIndex;
  hasCoverage: boolean;
  dispatch: Dispatch<Action>;
  onClose: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { editor: e, dispatch } = props;
  const eid = e.eid;
  const editing = e.original !== null;
  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(e.id);
  const result = e.original ? props.index[topicKey(e.original)] : undefined;
  const errs = validateEditor(e);

  // Autosave status shown where Save used to be: a pending/dirty (valid) editor is "Saving…", an
  // invalid one can't be written yet, otherwise it's persisted.
  const pending = e.saving || (e.dirty && errs.length === 0);
  const saveState = pending ? "saving" : errs.length ? "invalid" : "saved";
  const saveLabel = pending ? "Saving…" : errs.length ? `Can't save — ${errs[0] ?? "incomplete"}` : "Saved";

  // Ephemeral chip-editor state: the add-box draft and which committed chip is being edited in place.
  const [draft, setDraft] = useState("");
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  // The committed phrasings (blanks never survive here, so an index into this list is a clean key).
  const phrases = e.questions.filter((q) => q.trim().length > 0);

  const commit = (arr: string[]): void => dispatch({ type: "editorSetQuestions", eid, questions: arr.length ? arr : [""] });

  const addDraft = (): void => {
    const v = draft.trim();
    if (!v) return;
    commit([...phrases, v]);
    setDraft("");
  };

  const removeAt = (i: number): void => {
    if (editIndex === i) setEditIndex(null);
    commit(phrases.filter((_, j) => j !== i));
  };

  const startEdit = (i: number): void => {
    setEditIndex(i);
    setEditValue(phrases[i] ?? "");
  };

  const commitEdit = (i: number): void => {
    const v = editValue.trim();
    commit(v ? phrases.map((p, j) => (j === i ? v : p)) : phrases.filter((_, j) => j !== i));
    setEditIndex(null);
  };

  return (
    <div className="acc-editor">
      <button type="button" className="acc-bar" title="Collapse" aria-label="Collapse" onClick={props.onClose}>
        <span className="acc-caret">▴</span>
        <span className="acc-bar-label">Collapse</span>
      </button>
      {result ? (
        <div className="acc-ctx">
          <StatusPill status={result.status} />
          <span className="ci-detail">{result.detail || "Not yet probed."}</span>
          <span className="ci-agree">
            {result.agreement.toFixed(2)}
            <span>agree</span>
          </span>
        </div>
      ) : null}

      <div className="acc-head">
        <label className="field grow">
          <span className="fl">Title</span>
          <input
            className="f f-title"
            placeholder="Validity of an on_search response"
            value={e.title}
            onChange={(ev) => dispatch({ type: "editorField", eid, field: "title", value: ev.target.value })}
          />
        </label>
        <label className="field">
          <span className="fl">ID</span>
          <input
            className={`f f-id${!idValid && e.id ? " bad" : ""}`}
            placeholder="on-search-validation"
            value={e.id}
            title="lowercase-dashes — the filename & stable key"
            onChange={(ev) => dispatch({ type: "editorField", eid, field: "id", value: ev.target.value })}
          />
        </label>
        <div className="field">
          <span className="fl">Kind</span>
          <div className="kind-switch">
            {(["real", "canary"] as const).map((k) => (
              <button
                key={k}
                type="button"
                data-kind={k}
                className={e.kind === k ? "on" : ""}
                onClick={() => dispatch({ type: "editorSetKind", eid, kind: k })}
              >
                {k === "real" ? "● Real" : "◆ Canary"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!idValid && e.id ? <div className="err-inline">invalid id — lowercase letters, digits, and dashes only</div> : null}

      <div className="acc-head-row">
        <label>
          Probe questions{" "}
          <span className="hint">{e.kind === "real" ? "≥2 checks consistency across wordings" : "an invented topic to catch confident guessing"}</span>
        </label>
        <span className="hint q-count">
          {phrases.length} phrasing{phrases.length === 1 ? "" : "s"}
        </span>
      </div>

      <input
        className="f q-add"
        placeholder="Type a phrasing, press ↵"
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            addDraft();
          }
        }}
      />

      {phrases.length ? (
        <div className="q-chips">
          {phrases.map((q, i) =>
            editIndex === i ? (
              <input
                key={i}
                className="q-chip-edit"
                autoFocus
                value={editValue}
                onChange={(ev) => setEditValue(ev.target.value)}
                onBlur={() => commitEdit(i)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    commitEdit(i);
                  } else if (ev.key === "Escape") {
                    setEditIndex(null);
                  }
                }}
              />
            ) : (
              <span className="q-chip" key={i}>
                <button type="button" className="q-chip-text" title="Click to edit" onClick={() => startEdit(i)}>
                  {q}
                </button>
                <button type="button" className="q-chip-x" title="Remove" onClick={() => removeAt(i)}>
                  ✕
                </button>
              </span>
            ),
          )}
        </div>
      ) : null}

      {e.error ? <div className="err">{e.error}</div> : null}

      <div className="acc-foot">
        <span className={`save-state ${saveState}`} title={errs.length ? errs.join("\n") : undefined}>
          {saveState === "saving" ? <span className="save-dot" /> : null}
          {saveLabel}
        </span>
        <span className="spacer" />
        <button className="btn subtle sm" type="button" title="Duplicate as a new topic" onClick={() => dispatch({ type: "editorDuplicate", eid })}>
          Duplicate
        </button>
        {editing ? (
          <button className="btn danger sm" type="button" onClick={props.onDelete}>
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}
