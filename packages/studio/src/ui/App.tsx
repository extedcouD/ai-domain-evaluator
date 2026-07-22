/**
 * App — owns the reducer, performs all network I/O, and wires the two views (Author / Coverage), the
 * editor, and the toast. Every side effect (fetch, timer, confirm, the DOM, the clock) lives HERE;
 * `state.ts` stays a pure fold, dispatched to with the results.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { del, encodeRef, get, post, put, type ApiError } from "./api";
import { statusIndex, topicKey, topicRefFromFile } from "./derive";
import {
  editorMoved,
  editorTopic,
  initialState,
  reducer,
  validateEditor,
  type View,
} from "./state";
import type {
  AccessPolicyView,
  AccessRequest,
  AdminOverview,
  CoverageReportWithTree,
  CoverageSummary,
  DeletedEntry,
  EvalRunDetail,
  EvalRunSummary,
  HistoryData,
  Identity,
  Kind,
  Manifest,
  NodeInfo,
  Proposal,
  ProposalDetail,
  ResumeRequest,
  RunRequest,
  SyncResult,
  Topic,
} from "./types";
import { AdminView, type AccessDraft } from "./components/AdminView";
import { CoverageView } from "./components/CoverageView";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { PathTree } from "./components/PathTree";
import { ProposalsPanel } from "./components/ProposalsPanel";
import { RequestAccessModal } from "./components/RequestAccessModal";
import { RunView } from "./components/RunView";
import { Toast } from "./components/Toast";
import { TopicList } from "./components/TopicList";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function hashView(): View | null {
  const h = window.location.hash.replace(/^#/, "").split("/")[0];
  return h === "coverage" || h === "author" || h === "admin" || h === "evaluate" ? h : null;
}

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const inflight = useRef(new Set<string>());
  const evalInflight = useRef(new Set<string>());
  const [submittingRun, setSubmittingRun] = useState(false);
  const [resumingRun, setResumingRun] = useState(false);

  // ---- loaders -----------------------------------------------------------------------------------
  const loadManifest = useCallback(async () => {
    try {
      dispatch({ type: "manifestLoaded", manifest: await get<Manifest>("/api/manifest") });
    } catch (e) {
      dispatch({ type: "manifestError", error: errMsg(e) });
    }
  }, []);

  const loadNodes = useCallback(async () => {
    try {
      const r = await get<{ nodes: NodeInfo[] }>("/api/nodes");
      dispatch({ type: "nodesLoaded", nodes: r.nodes });
    } catch {
      dispatch({ type: "nodesLoaded", nodes: [] });
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      dispatch({ type: "runsLoaded", runs: await get<CoverageSummary[]>("/api/coverage") });
    } catch {
      dispatch({ type: "runsLoaded", runs: [] });
    }
  }, []);

  const loadReport = useCallback(async (file: string) => {
    if (inflight.current.has(file)) return;
    inflight.current.add(file);
    try {
      const report = await get<CoverageReportWithTree>(`/api/coverage/${encodeURIComponent(file)}?tree=1`);
      dispatch({ type: "reportLoaded", file, report });
    } catch {
      /* leave it unloaded — the view shows a loading state */
    } finally {
      inflight.current.delete(file);
    }
  }, []);

  const loadEvalRuns = useCallback(async () => {
    try {
      const r = await get<{ runs: EvalRunSummary[] }>("/api/runs");
      dispatch({ type: "evalRunsLoaded", runs: r.runs });
    } catch {
      /* best-effort — the list just won't refresh */
    }
  }, []);

  const loadEvalRun = useCallback(async (id: string) => {
    if (evalInflight.current.has(id)) return;
    evalInflight.current.add(id);
    try {
      dispatch({ type: "evalRunLoaded", detail: await get<EvalRunDetail>(`/api/runs/${encodeURIComponent(id)}`) });
    } catch {
      /* leave it unloaded — the pane shows a loading state */
    } finally {
      evalInflight.current.delete(id);
    }
  }, []);

  const toast = useCallback((message: string, kind: "info" | "error" = "info") => {
    dispatch({ type: "toast", message, kind });
  }, []);

  const submitRun = useCallback(
    async (req: RunRequest): Promise<void> => {
      setSubmittingRun(true);
      try {
        const r = await post<{ id: string }>("/api/runs", req);
        toast("run started");
        dispatch({ type: "selectEvalRun", id: r.id });
        await loadEvalRuns();
      } catch (err) {
        dispatch({ type: "toast", message: errMsg(err), kind: "error" });
      } finally {
        setSubmittingRun(false);
      }
    },
    [toast, loadEvalRuns],
  );

  const cancelEvalRun = useCallback(
    async (id: string): Promise<void> => {
      try {
        await del(`/api/runs/${encodeURIComponent(id)}`);
        toast("run canceled");
        await Promise.all([loadEvalRuns(), loadEvalRun(id)]);
      } catch (err) {
        dispatch({ type: "toast", message: errMsg(err), kind: "error" });
      }
    },
    [toast, loadEvalRuns, loadEvalRun],
  );

  const pauseEvalRun = useCallback(
    async (id: string): Promise<void> => {
      try {
        await post(`/api/runs/${encodeURIComponent(id)}/pause`, {});
        toast("run paused");
        await Promise.all([loadEvalRuns(), loadEvalRun(id)]);
      } catch (err) {
        dispatch({ type: "toast", message: errMsg(err), kind: "error" });
      }
    },
    [toast, loadEvalRuns, loadEvalRun],
  );

  const resumeEvalRun = useCallback(
    async (id: string, req: ResumeRequest): Promise<void> => {
      setResumingRun(true);
      try {
        await post(`/api/runs/${encodeURIComponent(id)}/resume`, req);
        toast("run resumed");
        await Promise.all([loadEvalRuns(), loadEvalRun(id)]);
      } catch (err) {
        dispatch({ type: "toast", message: errMsg(err), kind: "error" });
      } finally {
        setResumingRun(false);
      }
    },
    [toast, loadEvalRuns, loadEvalRun],
  );

  const loadHistory = useCallback(async () => {
    try {
      dispatch({ type: "historyLoaded", history: await get<HistoryData>("/api/history") });
    } catch {
      dispatch({ type: "historyLoaded", history: { commits: [], deletions: [] } });
    }
  }, []);

  const openHistory = useCallback(() => {
    dispatch({ type: "setHistoryOpen", open: true });
    void loadHistory();
  }, [loadHistory]);

  const loadWhoami = useCallback(async () => {
    try {
      dispatch({ type: "identityLoaded", identity: await get<Identity>("/api/whoami") });
    } catch {
      /* whoami is best-effort chrome — leave identity null (single-user shows no chip) */
    }
  }, []);

  const loadProposals = useCallback(async () => {
    try {
      const r = await get<{ proposals: Proposal[] }>("/api/proposals");
      dispatch({ type: "proposalsLoaded", proposals: r.proposals });
    } catch {
      dispatch({ type: "proposalsLoaded", proposals: [] });
    }
  }, []);

  const openProposals = useCallback(() => {
    dispatch({ type: "setProposalsOpen", open: true });
    void loadProposals();
  }, [loadProposals]);

  const loadAccess = useCallback(async () => {
    try {
      dispatch({ type: "accessLoaded", access: await get<AccessPolicyView>("/api/access") });
    } catch {
      /* non-admin / not available — the Admin tab is admin-gated, so this is best-effort chrome */
    }
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      dispatch({ type: "overviewLoaded", overview: await get<AdminOverview>("/api/admin/overview") });
    } catch {
      /* best-effort */
    }
  }, []);

  const loadAccessRequests = useCallback(async () => {
    try {
      const r = await get<{ requests: AccessRequest[] }>("/api/access-requests");
      dispatch({ type: "accessRequestsLoaded", requests: r.requests });
    } catch {
      dispatch({ type: "accessRequestsLoaded", requests: [] });
    }
  }, []);

  // ---- boot --------------------------------------------------------------------------------------
  useEffect(() => {
    void loadManifest();
    void loadNodes();
    void loadRuns();
    void loadWhoami();
    const fromHash = hashView();
    if (fromHash) dispatch({ type: "setView", view: fromHash });
    try {
      const saved = window.localStorage.getItem("kb-theme");
      if (saved === "dark" || saved === "light") dispatch({ type: "setTheme", theme: saved });
    } catch {
      /* ignore */
    }
  }, [loadManifest, loadNodes, loadRuns, loadWhoami]);

  // Ensure the reports we need (newest for the overlay, plus A/B) are loaded.
  useEffect(() => {
    const wanted = new Set<string>();
    const newest = state.runs[0]?.file;
    if (newest) wanted.add(newest);
    if (state.runA) wanted.add(state.runA);
    if (state.runB) wanted.add(state.runB);
    for (const file of wanted) if (!state.reports[file]) void loadReport(file);
  }, [state.runs, state.runA, state.runB, state.reports, loadReport]);

  // Evaluate view: fetch the run list on entry.
  useEffect(() => {
    if (state.view === "evaluate") void loadEvalRuns();
  }, [state.view, loadEvalRuns]);

  // Load the selected run's detail (its report) — on selection, and whenever its status transitions.
  useEffect(() => {
    const sel = state.evalSelected;
    if (!sel) return;
    const run = state.evalRuns.find((r) => r.id === sel);
    if (!run) return;
    const loaded = state.evalDetails[sel];
    if (!loaded || loaded.status !== run.status) void loadEvalRun(sel);
  }, [state.evalSelected, state.evalRuns, state.evalDetails, loadEvalRun]);

  // Poll while any run is in flight: refresh the list and the selected running run's live progress.
  useEffect(() => {
    if (state.view !== "evaluate") return;
    if (!state.evalRuns.some((r) => r.status === "running")) return;
    const id = window.setInterval(() => {
      void loadEvalRuns();
      const sel = state.evalSelected;
      if (sel && state.evalRuns.find((r) => r.id === sel)?.status === "running") void loadEvalRun(sel);
    }, 1500);
    return () => window.clearInterval(id);
  }, [state.view, state.evalRuns, state.evalSelected, loadEvalRuns, loadEvalRun]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!state.toast) return;
    const id = window.setTimeout(() => dispatch({ type: "dismissToast" }), 2600);
    return () => window.clearTimeout(id);
  }, [state.toast]);

  // Theme: stamp the root + persist.
  useEffect(() => {
    if (state.theme) {
      document.documentElement.setAttribute("data-theme", state.theme);
      try {
        window.localStorage.setItem("kb-theme", state.theme);
      } catch {
        /* ignore */
      }
    }
  }, [state.theme]);

  // Hash ↔ view sync.
  useEffect(() => {
    const target = `#${state.view}`;
    if (window.location.hash !== target) window.location.hash = target;
  }, [state.view]);
  useEffect(() => {
    const onHash = (): void => {
      const v = hashView();
      if (v) dispatch({ type: "setView", view: v });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Admin view: load its data on entry; a non-admin who lands on #admin is bounced out (the tab is
  // already hidden for them, so this only catches a hand-typed hash).
  useEffect(() => {
    if (state.view !== "admin") return;
    if (state.identity && state.identity.role !== "admin") {
      dispatch({ type: "setView", view: "author" });
      return;
    }
    void loadAccess();
    void loadOverview();
    void loadProposals();
    void loadAccessRequests();
  }, [state.view, state.identity, loadAccess, loadOverview, loadProposals, loadAccessRequests]);

  // ---- derived -----------------------------------------------------------------------------------
  const newestFile = state.runs[0]?.file;
  const newestReport = newestFile ? state.reports[newestFile] : undefined;
  const index = useMemo(() => statusIndex(newestReport), [newestReport]);
  const hasCoverage = !!newestReport;

  const defaultNewPath = (): string[] => {
    if (state.selectedPath.length) return state.selectedPath;
    const top = state.nodes.find((n) => n.path.length === 1);
    return top ? top.path : [];
  };

  // ---- autosave ----------------------------------------------------------------------------------
  // The truth for "needs a write" is (current payload !== last-saved payload), tracked in a ref so an
  // in-flight save can't clobber edits made while it was running. One debounce timer per open editor;
  // a changed id renames via `previous` (the editor's on-disk `original`). `stateRef` gives the timer
  // callback the latest editor without re-arming on every keystroke.
  const stateRef = useRef(state);
  stateRef.current = state;
  const saveTimers = useRef<Map<string, number>>(new Map());
  const savedPayload = useRef<Map<string, string>>(new Map());

  const flushSave = useCallback(
    async (eid: string): Promise<void> => {
      const e = stateRef.current.editors[eid];
      // Never autosave over an unresolved conflict — the user must pick Keep mine / Take theirs first.
      if (!e || e.saving || e.conflict || validateEditor(e).length) return;
      const topic = editorTopic(e);
      const payload = JSON.stringify(topic);
      if (savedPayload.current.get(eid) === payload) return; // nothing new since the last good save
      const body: Record<string, unknown> = { topic };
      if (editorMoved(e) && e.original) body["previous"] = e.original;
      if (e.baseVersion) body["baseVersion"] = e.baseVersion; // optimistic-concurrency token
      dispatch({ type: "editorSaving", eid, saving: true });
      try {
        const resp = await post<{ version?: string }>("/api/topics", body);
        savedPayload.current.set(eid, payload);
        dispatch({ type: "editorSaved", eid, identity: { path: topic.path, id: topic.id }, version: resp.version ?? null });
        await Promise.all([loadManifest(), loadNodes()]);
      } catch (err) {
        const ae = err as ApiError;
        const b = ae.body as { current?: Topic; currentVersion?: string } | undefined;
        if (ae.status === 409 && b?.current && b.currentVersion) {
          // Someone else changed this topic. Stop autosaving and surface a conflict banner.
          savedPayload.current.set(eid, payload);
          dispatch({ type: "editorConflict", eid, theirs: b.current, theirVersion: b.currentVersion });
          return;
        }
        // Remember the doomed payload so we don't hammer the server; a further edit retries.
        savedPayload.current.set(eid, payload);
        dispatch({ type: "editorError", eid, error: errMsg(err) });
      }
    },
    [loadManifest, loadNodes],
  );

  useEffect(() => {
    for (const [eid, e] of Object.entries(state.editors)) {
      if (e.saving || e.conflict || validateEditor(e).length) continue; // a conflict pauses autosave until resolved
      const payload = JSON.stringify(editorTopic(e));
      if (savedPayload.current.get(eid) === payload) continue;
      // A just-opened, untouched existing topic is already on disk — seed its baseline and don't
      // re-write it. (A dirty editor, or a duplicate/draft, has no baseline and DOES need saving.)
      if (!savedPayload.current.has(eid) && !e.dirty) {
        savedPayload.current.set(eid, payload);
        continue;
      }
      const prev = saveTimers.current.get(eid);
      if (prev !== undefined) window.clearTimeout(prev);
      saveTimers.current.set(
        eid,
        window.setTimeout(() => {
          saveTimers.current.delete(eid);
          void flushSave(eid);
        }, 700),
      );
    }
    // Drop pending timers for editors that have since closed.
    for (const eid of [...saveTimers.current.keys()]) {
      if (!state.editors[eid]) {
        window.clearTimeout(saveTimers.current.get(eid));
        saveTimers.current.delete(eid);
      }
    }
  }, [state.editors, flushSave]);

  // ---- topic handlers ----------------------------------------------------------------------------
  const onNewTopic = (kind: Kind): void => dispatch({ type: "openEditorNew", kind, path: defaultNewPath() });

  const onOpenTopic = (topic: Topic): void =>
    dispatch({ type: "openEditorEdit", topic, version: state.manifest?.versions?.[topicKey(topic)] ?? null });

  // Conflict resolution: "keep mine" re-bases on the server's copy and lets autosave overwrite it;
  // "take theirs" replaces the working copy with the server's and marks it already-saved.
  const keepMine = (eid: string): void => {
    dispatch({ type: "editorResolveKeepMine", eid });
    savedPayload.current.delete(eid); // force the autosave loop to re-fire and push my version
  };
  const takeTheirs = (eid: string): void => {
    const e = state.editors[eid];
    if (!e?.conflict) return;
    const t = e.conflict.theirs;
    dispatch({ type: "editorResolveTakeTheirs", eid });
    // The editor now matches the server, so record that payload as saved (no spurious re-write).
    savedPayload.current.set(eid, JSON.stringify({ id: t.id, path: t.path, title: t.title, kind: t.kind, questions: t.questions }));
  };

  const onCloseEditor = (eid: string): void => {
    const e = state.editors[eid];
    // With autosave the only unsaved state is one that can't be saved (still invalid) — warn first.
    if (e?.dirty && validateEditor(e).length && !window.confirm("This topic isn't valid yet, so it hasn't been saved. Discard it?")) return;
    dispatch({ type: "closeEditor", eid });
  };

  const deleteTopic = async (eid: string): Promise<void> => {
    const e = state.editors[eid];
    if (!e) return;
    if (!e.original) {
      dispatch({ type: "closeEditor", eid }); // a never-saved draft: just drop it, nothing on disk
      return;
    }
    if (!window.confirm(`Delete ${e.original.id}?`)) return;
    try {
      await del(`/api/topics/${encodeRef(...e.original.path, e.original.id)}`);
      toast(`deleted ${e.original.id}`);
      savedPayload.current.delete(eid);
      dispatch({ type: "closeEditor", eid });
      await Promise.all([loadManifest(), loadNodes()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  // ---- node handlers -----------------------------------------------------------------------------
  const createNode = async (path: string[]): Promise<void> => {
    try {
      await post("/api/nodes", { path });
      toast(`created ${path.join("/")}`);
      await loadNodes();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const renameNode = async (from: string[], to: string[]): Promise<void> => {
    try {
      await put(`/api/nodes/${encodeRef(...from)}`, { to });
      toast(`${from.join("/")} → ${to.join("/")}`);
      if (state.selectedPath.join("/").startsWith(from.join("/"))) dispatch({ type: "selectPath", path: [] });
      await Promise.all([loadNodes(), loadManifest()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const deleteNode = async (path: string[], hasTopics: boolean): Promise<void> => {
    const label = path.join("/");
    let suffix = "";
    if (hasTopics) {
      // Type-to-confirm: nuking a populated subtree needs the exact node path (echoed to the server too).
      const typed = window.prompt(`This deletes node "${label}" and ALL its topics. Type the node path to confirm:`, "");
      if (typed !== label) {
        if (typed !== null) toast("name didn't match — nothing deleted", "error");
        return;
      }
      suffix = `?cascade=1&confirm=${encodeURIComponent(label)}`;
    } else if (!window.confirm(`Delete empty node "${label}"?`)) {
      return;
    }
    try {
      await del(`/api/nodes/${encodeRef(...path)}${suffix}`);
      toast(`deleted ${label}`);
      if (state.selectedPath.join("/").startsWith(label)) dispatch({ type: "selectPath", path: [] });
      await Promise.all([loadNodes(), loadManifest()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  // ---- meta handlers -----------------------------------------------------------------------------
  const saveMeta = async (id: string, version: string, subject: string, metaLevels: string[]): Promise<void> => {
    try {
      // The server clears the subject when sent "", so an empty box unsets it.
      await put("/api/meta", { id, version, subject, levels: metaLevels });
      toast("saved identity");
      await loadManifest();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const exportManifest = async (): Promise<void> => {
    try {
      const r = await post<{ topics: number }>("/api/export", {});
      toast(`wrote manifest.yaml (${String(r.topics)} topics)`);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const restoreTopic = async (entry: DeletedEntry): Promise<void> => {
    const ref = topicRefFromFile(entry.file);
    if (!ref) return;
    try {
      await post("/api/restore", { sha: entry.restoreSha, path: ref.path, id: ref.id });
      toast(`restored ${ref.id}`);
      await Promise.all([loadManifest(), loadNodes(), loadHistory()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  // ---- review handlers ---------------------------------------------------------------------------
  const submitForReview = async (note?: string): Promise<void> => {
    try {
      await post<Proposal>("/api/proposals", note ? { note } : {});
      toast("submitted for review");
      await loadProposals();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const withdrawProposal = async (): Promise<void> => {
    try {
      await del("/api/proposals");
      toast("withdrew your proposal");
      await loadProposals();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const syncWithMain = async (): Promise<void> => {
    try {
      const r = await post<SyncResult>("/api/sync", {});
      if (r.conflicts.length) {
        dispatch({ type: "syncConflictsLoaded", conflicts: r.conflicts });
        toast(`synced — ${String(r.conflicts.length)} conflict(s) to resolve`, "error");
      } else {
        toast(r.pulled ? `synced with main (${String(r.pulled)} update${r.pulled === 1 ? "" : "s"})` : "already up to date with main");
      }
      await Promise.all([loadManifest(), loadNodes()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const resolveSyncConflict = async (key: string, choose: "mine" | "theirs"): Promise<void> => {
    try {
      await post("/api/sync/resolve", { key, choose });
      dispatch({ type: "resolveSyncConflict", key });
      await Promise.all([loadManifest(), loadNodes()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const loadProposalDetail = useCallback(async (id: string): Promise<void> => {
    try {
      dispatch({ type: "proposalDetailLoaded", id, detail: await get<ProposalDetail>(`/api/proposals/${encodeURIComponent(id)}`) });
    } catch {
      /* best-effort — the row just won't expand */
    }
  }, []);

  const mergeProposal = async (id: string): Promise<void> => {
    try {
      await post(`/api/proposals/${encodeURIComponent(id)}/merge`, {});
      toast(`merged ${id}`);
      await Promise.all([loadProposals(), loadManifest(), loadNodes()]);
    } catch (err) {
      const ae = err as ApiError;
      const b = ae.body as { conflicts?: unknown[] } | undefined;
      if (ae.status === 409 && Array.isArray(b?.conflicts)) {
        toast(`cannot merge — ${String(b.conflicts.length)} conflict(s); the author must sync + resolve first`, "error");
      } else {
        toast(errMsg(err), "error");
      }
    }
  };

  // ---- admin handlers ----------------------------------------------------------------------------
  const saveAccess = async (draft: AccessDraft): Promise<void> => {
    try {
      await put("/api/access", draft);
      toast("saved access policy");
      // Reload the policy + overview, and whoami (the caller's own role may have changed).
      await Promise.all([loadAccess(), loadOverview(), loadWhoami()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  // ---- request-access handlers -------------------------------------------------------------------
  const submitAccessRequest = async (paths: string[][], note: string): Promise<void> => {
    try {
      await post("/api/access-requests", note ? { paths, note } : { paths });
      toast("access request sent");
      dispatch({ type: "setRequestAccessOpen", open: false });
      await loadWhoami(); // reflect the new pending state on the button
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const grantAccessRequest = async (id: string, scopes: string[][]): Promise<void> => {
    try {
      await post(`/api/access-requests/${encodeURIComponent(id)}/grant`, { scopes });
      toast("granted access");
      // The policy changed and the requester's role may flip — reload the affected surfaces.
      await Promise.all([loadAccessRequests(), loadAccess(), loadOverview(), loadWhoami()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const denyAccessRequest = async (id: string): Promise<void> => {
    try {
      await post(`/api/access-requests/${encodeURIComponent(id)}/deny`, {});
      toast("denied request");
      await Promise.all([loadAccessRequests(), loadWhoami()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  // ---- render ------------------------------------------------------------------------------------
  return (
    <div className="app">
      <Header
        view={state.view}
        manifest={state.manifest}
        nodes={state.nodes}
        theme={state.theme}
        dispatch={dispatch}
        onSaveMeta={(id, version, subject, lv) => void saveMeta(id, version, subject, lv)}
        onExport={() => void exportManifest()}
        onOpenHistory={openHistory}
        identity={state.identity}
        onOpenProposals={openProposals}
        onRequestAccess={() => dispatch({ type: "setRequestAccessOpen", open: true })}
      />

      <div className={`body${state.view !== "author" ? " cov" : ""}`}>
        {state.view === "author" ? (
          <>
            <PathTree
              nodes={state.nodes}
              manifest={state.manifest}
              index={index}
              hasCoverage={hasCoverage}
              selectedPath={state.selectedPath}
              collapsed={state.collapsed}
              dispatch={dispatch}
              onCreateNode={(p) => void createNode(p)}
              onRenameNode={(f, t) => void renameNode(f, t)}
              onDeleteNode={(p, h) => void deleteNode(p, h)}
              scopes={state.identity?.scopes ?? [[]]}
            />
            <main className="workspace">
              <TopicList
                manifest={state.manifest}
                manifestError={state.manifestError}
                index={index}
                hasCoverage={hasCoverage}
                selectedPath={state.selectedPath}
                query={state.query}
                kindFilter={state.kindFilter}
                statusFilter={state.statusFilter}
                dispatch={dispatch}
                onNewTopic={onNewTopic}
                onOpenTopic={onOpenTopic}
                editors={Object.values(state.editors)}
                onCloseEditor={onCloseEditor}
                onDeleteEditor={(eid) => void deleteTopic(eid)}
                onKeepMine={keepMine}
                onTakeTheirs={takeTheirs}
                scopes={state.identity?.scopes ?? [[]]}
              />
            </main>
          </>
        ) : state.view === "coverage" ? (
          <main className="workspace">
            <CoverageView runs={state.runs} runA={state.runA} runB={state.runB} reports={state.reports} levels={state.manifest?.levels ?? []} dispatch={dispatch} />
          </main>
        ) : state.view === "evaluate" ? (
          <main className="workspace">
            <RunView
              runs={state.evalRuns}
              selected={state.evalSelected}
              details={state.evalDetails}
              levels={state.manifest?.levels ?? []}
              topics={state.manifest?.topics ?? []}
              nodes={state.nodes}
              submitting={submittingRun}
              resuming={resumingRun}
              onSubmit={(req) => void submitRun(req)}
              onPause={(id) => void pauseEvalRun(id)}
              onCancel={(id) => void cancelEvalRun(id)}
              onResume={(id, req) => void resumeEvalRun(id, req)}
              dispatch={dispatch}
            />
          </main>
        ) : (
          <main className="workspace">
            <AdminView
              identity={state.identity}
              access={state.access}
              overview={state.overview}
              proposals={state.proposals}
              accessRequests={state.accessRequests}
              nodes={state.nodes}
              manifest={state.manifest}
              onSaveAccess={(draft) => void saveAccess(draft)}
              onGrantRequest={(id, scopes) => void grantAccessRequest(id, scopes)}
              onDenyRequest={(id) => void denyAccessRequest(id)}
              onSaveMeta={(id, version, subject, lv) => void saveMeta(id, version, subject, lv)}
              onExport={() => void exportManifest()}
            />
          </main>
        )}
      </div>

      {state.historyOpen && (
        <HistoryPanel
          data={state.history}
          onRestore={(entry) => void restoreTopic(entry)}
          onClose={() => dispatch({ type: "setHistoryOpen", open: false })}
        />
      )}

      {state.proposalsOpen && (
        <ProposalsPanel
          identity={state.identity}
          proposals={state.proposals}
          details={state.proposalDetails}
          syncConflicts={state.syncConflicts}
          onSubmit={(note) => void submitForReview(note)}
          onWithdraw={() => void withdrawProposal()}
          onSync={() => void syncWithMain()}
          onResolve={(key, choose) => void resolveSyncConflict(key, choose)}
          onDismissConflicts={() => dispatch({ type: "clearSyncConflicts" })}
          onExpand={(id) => void loadProposalDetail(id)}
          onMerge={(id) => void mergeProposal(id)}
          onClose={() => dispatch({ type: "setProposalsOpen", open: false })}
        />
      )}

      {state.requestAccessOpen && (
        <RequestAccessModal
          nodes={state.nodes}
          initialPaths={state.selectedPath.length ? [state.selectedPath] : []}
          pending={state.identity?.accessRequest ?? null}
          onSubmit={(paths, note) => void submitAccessRequest(paths, note)}
          onClose={() => dispatch({ type: "setRequestAccessOpen", open: false })}
        />
      )}

      <Toast toast={state.toast} />
    </div>
  );
}
