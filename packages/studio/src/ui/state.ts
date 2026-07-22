/**
 * The KB Studio brain. Pure — no React, no DOM, no `fetch`, no `Date.now()`. Every async result (a
 * loaded manifest, a coverage report, a saved topic) enters as an ACTION dispatched by `App.tsx`, so
 * the whole UI is a fold over a list of actions and can be replayed and asserted without a renderer.
 * This mirrors the discipline of `packages/tui/src/state.ts`.
 *
 * The reducer owns view/selection/filters/editor/toast AND the loaded data snapshots (manifest, nodes,
 * runs, reports) — it just stores what App hands it. Side effects (network, timers, confirms, the DOM,
 * the clock) all live in App/hooks; the reducer never performs one.
 */
import { slug, topicKey, TOPIC_ID_RE, type StatusBucket } from "./derive";
import type {
  AccessPolicyView,
  AccessRequest,
  AdminOverview,
  Change,
  CoverageReportWithTree,
  CoverageSummary,
  EvalRunDetail,
  EvalRunSummary,
  HistoryData,
  Identity,
  Kind,
  Manifest,
  NodeInfo,
  Proposal,
  ProposalDetail,
  Topic,
} from "./types";

export type View = "author" | "coverage" | "evaluate" | "admin";

/** The topic editor's working copy. Several can be open at once (keyed by `eid` in `State.editors`),
 *  each autosaving independently. `original` is the identity currently on disk — null for a brand-new
 *  topic until its first successful save, then it tracks the last-saved {path,id}; when the id changes,
 *  App sends `previous: original` and the server renames. `saving` is set by App around the POST. */
export interface EditorState {
  eid: string;
  original: { path: string[]; id: string } | null;
  title: string;
  id: string;
  idEdited: boolean;
  path: string[];
  kind: Kind;
  questions: string[];
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** The content version this editor was opened/last-saved from — sent as `baseVersion` so a stale save 409s. */
  baseVersion: string | null;
  /** Set when a save 409'd: the server's current copy, offered as "take theirs". */
  conflict: { theirs: Topic; theirVersion: string } | null;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

export interface State {
  view: View;

  // Loaded data snapshots (App dispatches these after I/O).
  manifest: Manifest | null;
  manifestError: string | null;
  nodes: NodeInfo[];
  runs: CoverageSummary[];
  reports: Record<string, CoverageReportWithTree>;

  // Author view: selection + filters.
  selectedPath: string[]; // [] === the "All" root
  collapsed: Record<string, boolean>; // node path.join("/") → collapsed
  query: string;
  kindFilter: Kind | null;
  statusFilter: StatusBucket | null;

  // Open editors, keyed by a stable client-side `eid`. Multiple accordions can be open concurrently;
  // each one autosaves on its own debounce. Insertion order is preserved for stable rendering.
  editors: Record<string, EditorState>;

  // Coverage view: which run(s) are shown.
  runA: string | null; // file
  runB: string | null; // file (compare) or null

  // Evaluate view: the user's eval runs, the selected one, and its loaded detail (incl. report).
  evalRuns: EvalRunSummary[];
  evalSelected: string | null; // run id
  evalDetails: Record<string, EvalRunDetail>;

  toast: Toast | null;
  theme: "light" | "dark" | null; // null === follow the system

  // History / Trash panel: a modal over `GET /api/history` with one-click restore of deletions.
  historyOpen: boolean;
  history: HistoryData | null;

  // Identity (multi-user) + the review queue.
  identity: Identity | null;
  proposalsOpen: boolean;
  proposals: Proposal[] | null;
  /** The expanded live diff per proposal id (admin review view), fetched on demand. */
  proposalDetails: Record<string, ProposalDetail>;
  /** Unresolved conflicts from the last sync — drives the resolution modal (null = none/closed). */
  syncConflicts: Change[] | null;

  // Admin view (admins only): the access policy + an operational overview.
  access: AccessPolicyView | null;
  overview: AdminOverview | null;
  /** The open access-request queue (admin), fetched on entering the Admin view. */
  accessRequests: AccessRequest[] | null;

  // "Request access" modal (viewers): a viewer picks path(s) to ask for write access.
  requestAccessOpen: boolean;

  nextId: number;
}

export function initialState(): State {
  return {
    view: "author",
    manifest: null,
    manifestError: null,
    nodes: [],
    runs: [],
    reports: {},
    selectedPath: [],
    collapsed: {},
    query: "",
    kindFilter: null,
    statusFilter: null,
    editors: {},
    runA: null,
    runB: null,
    evalRuns: [],
    evalSelected: null,
    evalDetails: {},
    toast: null,
    theme: null,
    historyOpen: false,
    history: null,
    identity: null,
    proposalsOpen: false,
    proposals: null,
    proposalDetails: {},
    syncConflicts: null,
    access: null,
    overview: null,
    accessRequests: null,
    requestAccessOpen: false,
    nextId: 1,
  };
}

export type Action =
  | { type: "setView"; view: View }
  | { type: "manifestLoaded"; manifest: Manifest }
  | { type: "manifestError"; error: string }
  | { type: "nodesLoaded"; nodes: NodeInfo[] }
  | { type: "runsLoaded"; runs: CoverageSummary[] }
  | { type: "reportLoaded"; file: string; report: CoverageReportWithTree }
  // author selection / filters
  | { type: "selectPath"; path: string[] }
  | { type: "toggleCollapse"; path: string[] }
  | { type: "setQuery"; query: string }
  | { type: "toggleKindFilter"; kind: Kind }
  | { type: "toggleStatusFilter"; bucket: StatusBucket }
  // editor (each targets one open editor by `eid`, except the "open" actions which mint one)
  | { type: "openEditorEdit"; topic: Topic; version: string | null }
  | { type: "openEditorNew"; kind: Kind; path: string[] }
  | { type: "editorField"; eid: string; field: "title" | "id"; value: string }
  | { type: "editorSetKind"; eid: string; kind: Kind }
  | { type: "editorSetQuestions"; eid: string; questions: string[] }
  | { type: "editorSaving"; eid: string; saving: boolean }
  | { type: "editorSaved"; eid: string; identity: { path: string[]; id: string }; version: string | null }
  | { type: "editorError"; eid: string; error: string | null }
  | { type: "editorConflict"; eid: string; theirs: Topic; theirVersion: string }
  | { type: "editorResolveKeepMine"; eid: string }
  | { type: "editorResolveTakeTheirs"; eid: string }
  | { type: "editorDuplicate"; eid: string }
  | { type: "closeEditor"; eid: string }
  // coverage
  | { type: "selectRun"; slot: "a" | "b"; file: string | null }
  // evaluate
  | { type: "evalRunsLoaded"; runs: EvalRunSummary[] }
  | { type: "selectEvalRun"; id: string | null }
  | { type: "evalRunLoaded"; detail: EvalRunDetail }
  // chrome
  | { type: "toast"; message: string; kind: "info" | "error" }
  | { type: "dismissToast" }
  | { type: "setTheme"; theme: "light" | "dark" | null }
  // history / trash
  | { type: "setHistoryOpen"; open: boolean }
  | { type: "historyLoaded"; history: HistoryData }
  // identity + review
  | { type: "identityLoaded"; identity: Identity }
  | { type: "setProposalsOpen"; open: boolean }
  | { type: "proposalsLoaded"; proposals: Proposal[] }
  | { type: "proposalDetailLoaded"; id: string; detail: ProposalDetail }
  | { type: "syncConflictsLoaded"; conflicts: Change[] }
  | { type: "resolveSyncConflict"; key: string }
  | { type: "clearSyncConflicts" }
  // admin
  | { type: "accessLoaded"; access: AccessPolicyView }
  | { type: "overviewLoaded"; overview: AdminOverview }
  | { type: "accessRequestsLoaded"; requests: AccessRequest[] }
  // request access (viewer)
  | { type: "setRequestAccessOpen"; open: boolean };

function editorFor(eid: string, topic: Topic, baseVersion: string | null): EditorState {
  return {
    eid,
    original: { path: topic.path, id: topic.id },
    title: topic.title,
    id: topic.id,
    idEdited: true,
    path: topic.path,
    kind: topic.kind,
    questions: topic.questions.length ? topic.questions : [""],
    dirty: false,
    saving: false,
    error: null,
    baseVersion,
    conflict: null,
  };
}

function newEditor(eid: string, kind: Kind, path: string[]): EditorState {
  return {
    eid,
    original: null,
    title: "",
    id: "",
    idEdited: false,
    path,
    kind,
    questions: [""],
    dirty: false,
    saving: false,
    error: null,
    baseVersion: null,
    conflict: null,
  };
}

/** The `eid` of an already-open editor for this on-disk topic, if any (so re-opening focuses it). */
function openEidFor(state: State, topic: Topic): string | null {
  const key = topicKey(topic);
  for (const [eid, e] of Object.entries(state.editors)) {
    if (e.original && topicKey(e.original) === key) return eid;
  }
  return null;
}

/** Apply an editor sub-update by `eid` and mark it dirty + clear any stale error. */
function editEditor(state: State, eid: string, patch: Partial<EditorState>): State {
  const e = state.editors[eid];
  if (!e) return state;
  return { ...state, editors: { ...state.editors, [eid]: { ...e, ...patch, dirty: true, error: null } } };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "setView":
      return { ...state, view: action.view };

    case "manifestLoaded":
      return { ...state, manifest: action.manifest, manifestError: null };

    case "manifestError":
      return { ...state, manifest: null, manifestError: action.error };

    case "nodesLoaded":
      return { ...state, nodes: action.nodes };

    case "runsLoaded": {
      const first = action.runs[0]?.file ?? null;
      // Default run A to the newest run when nothing is selected yet (or the selection vanished).
      const runA = state.runA && action.runs.some((r) => r.file === state.runA) ? state.runA : first;
      const runB = state.runB && action.runs.some((r) => r.file === state.runB) ? state.runB : null;
      return { ...state, runs: action.runs, runA, runB };
    }

    case "reportLoaded":
      return { ...state, reports: { ...state.reports, [action.file]: action.report } };

    case "selectPath":
      return { ...state, selectedPath: action.path };

    case "toggleCollapse": {
      const k = action.path.join("/");
      return { ...state, collapsed: { ...state.collapsed, [k]: !state.collapsed[k] } };
    }

    case "setQuery":
      return { ...state, query: action.query };

    case "toggleKindFilter":
      return { ...state, kindFilter: state.kindFilter === action.kind ? null : action.kind };

    case "toggleStatusFilter":
      return { ...state, statusFilter: state.statusFilter === action.bucket ? null : action.bucket };

    case "openEditorEdit": {
      // Re-opening a topic that's already open is a no-op (its accordion stays as-is).
      if (openEidFor(state, action.topic)) return state;
      const eid = `e${String(state.nextId)}`;
      return { ...state, editors: { ...state.editors, [eid]: editorFor(eid, action.topic, action.version) }, nextId: state.nextId + 1 };
    }

    case "openEditorNew": {
      const eid = `e${String(state.nextId)}`;
      return { ...state, editors: { ...state.editors, [eid]: newEditor(eid, action.kind, action.path) }, nextId: state.nextId + 1 };
    }

    case "editorField": {
      const e = state.editors[action.eid];
      if (!e) return state;
      if (action.field === "title") {
        // Auto-slug the id from the title until the id has been hand-edited.
        const id = e.idEdited ? e.id : slug(action.value);
        return editEditor(state, action.eid, { title: action.value, id });
      }
      return editEditor(state, action.eid, { id: action.value, idEdited: true });
    }

    case "editorSetKind":
      return editEditor(state, action.eid, { kind: action.kind });

    case "editorSetQuestions":
      return editEditor(state, action.eid, { questions: action.questions });

    case "editorSaving": {
      const e = state.editors[action.eid];
      if (!e) return state;
      return { ...state, editors: { ...state.editors, [action.eid]: { ...e, saving: action.saving } } };
    }

    case "editorSaved": {
      const e = state.editors[action.eid];
      if (!e) return state;
      // Stamp the now-on-disk identity + version so the next save's `baseVersion` matches; clear saving/error.
      // `dirty` is left to the value it holds — the autosave loop compares payloads, not this flag.
      return {
        ...state,
        editors: {
          ...state.editors,
          [action.eid]: { ...e, original: action.identity, baseVersion: action.version, saving: false, dirty: false, error: null, conflict: null },
        },
      };
    }

    case "editorError": {
      const e = state.editors[action.eid];
      if (!e) return state;
      return { ...state, editors: { ...state.editors, [action.eid]: { ...e, saving: false, error: action.error } } };
    }

    case "editorConflict": {
      const e = state.editors[action.eid];
      if (!e) return state;
      return {
        ...state,
        editors: { ...state.editors, [action.eid]: { ...e, saving: false, conflict: { theirs: action.theirs, theirVersion: action.theirVersion } } },
      };
    }

    case "editorResolveKeepMine": {
      const e = state.editors[action.eid];
      if (!e || !e.conflict) return state;
      // Accept the server's copy as the new base, so the next save overwrites it with my working copy.
      return {
        ...state,
        editors: { ...state.editors, [action.eid]: { ...e, baseVersion: e.conflict.theirVersion, conflict: null, dirty: true, error: null } },
      };
    }

    case "editorResolveTakeTheirs": {
      const e = state.editors[action.eid];
      if (!e || !e.conflict) return state;
      const t = e.conflict.theirs;
      return {
        ...state,
        editors: {
          ...state.editors,
          [action.eid]: {
            ...e,
            title: t.title,
            id: t.id,
            idEdited: true,
            path: t.path,
            kind: t.kind,
            questions: t.questions.length ? t.questions : [""],
            baseVersion: e.conflict.theirVersion,
            conflict: null,
            dirty: false,
            error: null,
          },
        },
      };
    }

    case "editorDuplicate": {
      const src = state.editors[action.eid];
      if (!src) return state;
      // Open a fresh unsaved draft copy in its own accordion, leaving the source editor untouched.
      const base = src.id || slug(src.title) || "topic";
      const eid = `e${String(state.nextId)}`;
      const copy: EditorState = {
        ...src,
        eid,
        original: null, // a brand-new file once it first autosaves
        id: `${base}-copy`.slice(0, 60),
        idEdited: true,
        dirty: true,
        saving: false,
        error: null,
        baseVersion: null, // a fresh file: no prior version to guard against
        conflict: null,
      };
      return { ...state, editors: { ...state.editors, [eid]: copy }, nextId: state.nextId + 1 };
    }

    case "closeEditor": {
      if (!state.editors[action.eid]) return state;
      const editors = { ...state.editors };
      delete editors[action.eid];
      return { ...state, editors };
    }

    case "selectRun":
      return action.slot === "a" ? { ...state, runA: action.file } : { ...state, runB: action.file };

    case "evalRunsLoaded": {
      // Keep the current selection if it still exists; otherwise default to the newest run.
      const selected = state.evalSelected && action.runs.some((r) => r.id === state.evalSelected) ? state.evalSelected : (action.runs[0]?.id ?? null);
      return { ...state, evalRuns: action.runs, evalSelected: selected };
    }

    case "selectEvalRun":
      return { ...state, evalSelected: action.id };

    case "evalRunLoaded":
      return { ...state, evalDetails: { ...state.evalDetails, [action.detail.id]: action.detail } };

    case "toast":
      return { ...state, toast: { id: state.nextId, message: action.message, kind: action.kind }, nextId: state.nextId + 1 };

    case "dismissToast":
      return { ...state, toast: null };

    case "setTheme":
      return { ...state, theme: action.theme };

    case "setHistoryOpen":
      // Clear the stale snapshot on open so the panel shows a loading state, not last time's data.
      return { ...state, historyOpen: action.open, history: action.open ? null : state.history };

    case "historyLoaded":
      return { ...state, history: action.history };

    case "identityLoaded":
      return { ...state, identity: action.identity };

    case "setProposalsOpen":
      return { ...state, proposalsOpen: action.open, proposals: action.open ? null : state.proposals, proposalDetails: action.open ? {} : state.proposalDetails };

    case "proposalsLoaded":
      return { ...state, proposals: action.proposals };

    case "proposalDetailLoaded":
      return { ...state, proposalDetails: { ...state.proposalDetails, [action.id]: action.detail } };

    case "syncConflictsLoaded":
      return { ...state, syncConflicts: action.conflicts.length ? action.conflicts : null };

    case "resolveSyncConflict": {
      const left = (state.syncConflicts ?? []).filter((c) => c.key !== action.key);
      return { ...state, syncConflicts: left.length ? left : null };
    }

    case "clearSyncConflicts":
      return { ...state, syncConflicts: null };

    case "accessLoaded":
      return { ...state, access: action.access };

    case "overviewLoaded":
      return { ...state, overview: action.overview };

    case "accessRequestsLoaded":
      return { ...state, accessRequests: action.requests };

    case "setRequestAccessOpen":
      return { ...state, requestAccessOpen: action.open };
  }
}

/** Validate the editor's working topic client-side (mirrors the server's guards). Returns errors. */
export function validateEditor(e: EditorState): string[] {
  const errs: string[] = [];
  if (!TOPIC_ID_RE.test(e.id)) errs.push("id must be lowercase letters, digits, and dashes (no dots).");
  if (e.path.length === 0) errs.push("a topic needs at least one path segment.");
  if (!e.title.trim()) errs.push("title is required.");
  if (e.questions.filter((q) => q.trim()).length === 0) errs.push("at least one phrasing is required.");
  return errs;
}

/** The topic payload the editor would POST (trimmed, empty phrasings dropped). */
export function editorTopic(e: EditorState): Topic {
  return {
    id: e.id.trim(),
    path: e.path,
    title: e.title.trim(),
    kind: e.kind,
    questions: e.questions.map((q) => q.trim()).filter(Boolean),
  };
}

/** Did the editor's identity move? The editor can only change the id (not the path), so a changed
 *  id means the save is a rename and App sends `previous`. */
export function editorMoved(e: EditorState): boolean {
  if (!e.original) return false;
  return e.original.id !== e.id.trim();
}
