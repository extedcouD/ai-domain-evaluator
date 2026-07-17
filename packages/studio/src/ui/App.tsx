/**
 * App — owns the reducer, performs all network I/O, and wires the two views (Author / Coverage), the
 * editor, and the toast. Every side effect (fetch, timer, confirm, the DOM, the clock) lives HERE;
 * `state.ts` stays a pure fold, dispatched to with the results.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { del, encodeRef, get, post, put } from "./api";
import { statusIndex, topicRefFromFile } from "./derive";
import {
  editorMoved,
  editorTopic,
  initialState,
  reducer,
  validateEditor,
  type View,
} from "./state";
import type {
  CoverageReportWithTree,
  CoverageSummary,
  DeletedEntry,
  HistoryData,
  Identity,
  Kind,
  Manifest,
  NodeInfo,
  Proposal,
  Topic,
} from "./types";
import { CoverageView } from "./components/CoverageView";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { PathTree } from "./components/PathTree";
import { ProposalsPanel } from "./components/ProposalsPanel";
import { Toast } from "./components/Toast";
import { TopicList } from "./components/TopicList";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function hashView(): View | null {
  const h = window.location.hash.replace(/^#/, "").split("/")[0];
  return h === "coverage" || h === "author" ? h : null;
}

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const inflight = useRef(new Set<string>());

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

  const toast = useCallback((message: string, kind: "info" | "error" = "info") => {
    dispatch({ type: "toast", message, kind });
  }, []);

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
      if (!e || e.saving || validateEditor(e).length) return;
      const topic = editorTopic(e);
      const payload = JSON.stringify(topic);
      if (savedPayload.current.get(eid) === payload) return; // nothing new since the last good save
      const body = editorMoved(e) && e.original ? { topic, previous: e.original } : { topic };
      dispatch({ type: "editorSaving", eid, saving: true });
      try {
        await post("/api/topics", body);
        savedPayload.current.set(eid, payload);
        dispatch({ type: "editorSaved", eid, identity: { path: topic.path, id: topic.id } });
        await Promise.all([loadManifest(), loadNodes()]);
      } catch (err) {
        // Remember the doomed payload so we don't hammer the server with an identical write; the error
        // stays visible and any further edit (a new payload) retries.
        savedPayload.current.set(eid, payload);
        dispatch({ type: "editorError", eid, error: errMsg(err) });
      }
    },
    [loadManifest, loadNodes],
  );

  useEffect(() => {
    for (const [eid, e] of Object.entries(state.editors)) {
      if (e.saving || validateEditor(e).length) continue;
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

  const onOpenTopic = (topic: Topic): void => dispatch({ type: "openEditorEdit", topic });

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
  const submitForReview = async (): Promise<void> => {
    try {
      const p = await post<Proposal>("/api/proposals", {});
      toast(`opened PR #${String(p.number)} for review`);
      await loadProposals();
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const syncWithMain = async (): Promise<void> => {
    try {
      const r = await post<{ merged: boolean; conflicted: boolean }>("/api/sync", {});
      toast(r.conflicted ? "sync hit conflicts — resolve on your branch" : "synced with main", r.conflicted ? "error" : "info");
      if (!r.conflicted) await Promise.all([loadManifest(), loadNodes()]);
    } catch (err) {
      toast(errMsg(err), "error");
    }
  };

  const mergeProposal = async (n: number): Promise<void> => {
    try {
      await post(`/api/proposals/${String(n)}/merge`, {});
      toast(`merged #${String(n)}`);
      await loadProposals();
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
      />

      <div className={`body${state.view === "coverage" ? " cov" : ""}`}>
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
                scopes={state.identity?.scopes ?? [[]]}
              />
            </main>
          </>
        ) : (
          <main className="workspace">
            <CoverageView runs={state.runs} runA={state.runA} runB={state.runB} reports={state.reports} levels={state.manifest?.levels ?? []} dispatch={dispatch} />
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
          onSubmit={() => void submitForReview()}
          onSync={() => void syncWithMain()}
          onMerge={(n) => void mergeProposal(n)}
          onClose={() => dispatch({ type: "setProposalsOpen", open: false })}
        />
      )}

      <Toast toast={state.toast} />
    </div>
  );
}
