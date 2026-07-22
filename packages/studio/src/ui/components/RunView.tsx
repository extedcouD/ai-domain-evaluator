/**
 * RunView — the Evaluate tab. Point the harness at YOUR endpoint, pick a protocol and a topic scope,
 * and run a coverage probe against the KB in Studio, then read the report back here.
 *
 *   Left: a form with a scope tree (which topics to cover) and two credential blocks — the endpoint
 *   under test (the source) and a trusted judge endpoint (a source must never grade itself). API keys
 *   are typed into local state only and POSTed once; never stored, never returned. Below it, the user's
 *   runs with live status + progress.
 *
 *   Right: a running run shows a live instrument (progress, current topic, tally, feed) with Pause; a
 *   paused/interrupted run shows the partial feed plus a Resume form (re-enter keys — they were never
 *   stored); a finished run shows the full report (`SingleReport`).
 *
 * Styling goes through the app's design-system classes so it themes light/dark like the rest of the app.
 */
import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";

import { pct, topicKey } from "../derive";
import type { Action } from "../state";
import type { EvalEndpoint, EvalProvider, EvalRunDetail, EvalRunStatus, EvalRunSummary, NodeInfo, ResumeRequest, RunLogEntry, RunRequest, Topic, TopicStatus } from "../types";
import { StatusPill } from "./common";
import { SingleReport } from "./CoverageView";
import { ScopeTree } from "./ScopeTree";

const DEFAULT_BASE: Record<EvalProvider, string> = {
  openai: "http://localhost:1234/v1",
  anthropic: "https://api.anthropic.com",
};
const KNOWN_BASES = new Set(Object.values(DEFAULT_BASE));

const STATUS_PILL: Record<EvalRunStatus, string> = {
  running: "s-warn",
  paused: "s-muted",
  interrupted: "s-warn",
  succeeded: "s-ok",
  failed: "s-alarm",
  canceled: "s-none",
};
const STATUS_LABEL: Record<EvalRunStatus, string> = {
  running: "running",
  paused: "paused",
  interrupted: "interrupted",
  succeeded: "done",
  failed: "failed",
  canceled: "canceled",
};

const TALLY: { status: TopicStatus; label: string }[] = [
  { status: "grounded", label: "grounded" },
  { status: "refused", label: "refused" },
  { status: "inconsistent", label: "inconsistent" },
  { status: "confident-ungrounded", label: "ungrounded" },
  { status: "canary-ok", label: "canary ok" },
  { status: "canary-bit", label: "canary bite" },
];

interface EndpointDraft {
  provider: EvalProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function blankEndpoint(provider: EvalProvider): EndpointDraft {
  return { provider, baseUrl: DEFAULT_BASE[provider], model: "", apiKey: "" };
}
function fromEcho(e: EvalEndpoint): EndpointDraft {
  return { provider: e.provider, baseUrl: e.baseUrl, model: e.model, apiKey: "" };
}
function endpointComplete(e: EndpointDraft): boolean {
  return /^https?:\/\//i.test(e.baseUrl.trim()) && e.model.trim() !== "" && e.apiKey !== "";
}
function toWire(e: EndpointDraft): RunRequest["source"] {
  return { provider: e.provider, baseUrl: e.baseUrl.trim(), model: e.model.trim(), apiKey: e.apiKey };
}
function progressPct(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

function EndpointCard({ title, hint, value, onChange }: { title: string; hint: string; value: EndpointDraft; onChange: (n: EndpointDraft) => void }): React.JSX.Element {
  const setProvider = (provider: EvalProvider): void => {
    const trimmed = value.baseUrl.trim();
    const baseUrl = trimmed === "" || KNOWN_BASES.has(trimmed) ? DEFAULT_BASE[provider] : value.baseUrl;
    onChange({ ...value, provider, baseUrl });
  };
  return (
    <div className="run-card">
      <div className="run-card-title">{title}</div>
      <p className="hint">{hint}</p>
      <label>Protocol</label>
      <select className="f" value={value.provider} onChange={(e) => setProvider(e.target.value as EvalProvider)}>
        <option value="openai">OpenAI-compatible</option>
        <option value="anthropic">Anthropic Messages</option>
      </select>
      <label>Base URL</label>
      <input className="f" value={value.baseUrl} placeholder={DEFAULT_BASE[value.provider]} onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} />
      <label>Model</label>
      <input className="f" value={value.model} placeholder="model your endpoint serves" onChange={(e) => onChange({ ...value, model: e.target.value })} />
      <label>API key</label>
      <input className="f" type="password" autoComplete="off" value={value.apiKey} placeholder="sent once, never stored" onChange={(e) => onChange({ ...value, apiKey: e.target.value })} />
    </div>
  );
}

function RunForm({ topics, nodes, onSubmit, disabled }: { topics: Topic[]; nodes: NodeInfo[]; onSubmit: (req: RunRequest) => void; disabled: boolean }): React.JSX.Element {
  const [source, setSource] = useState<EndpointDraft>(() => blankEndpoint("openai"));
  const [judge, setJudge] = useState<EndpointDraft>(() => blankEndpoint("anthropic"));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(topics.map(topicKey)));
  const [scopeOpen, setScopeOpen] = useState(false);
  const touched = useRef(false);

  // Default to "everything selected"; keep that synced as the manifest loads, until the user edits it.
  useEffect(() => {
    if (!touched.current) setSelected(new Set(topics.map(topicKey)));
  }, [topics]);

  const onScope = (next: Set<string>): void => {
    touched.current = true;
    setSelected(next);
  };

  const ready = endpointComplete(source) && endpointComplete(judge) && selected.size > 0;

  const submit = (): void => {
    const all = topics.map(topicKey);
    const topicKeys = selected.size >= all.length ? null : all.filter((k) => selected.has(k));
    onSubmit({ source: toWire(source), judge: toWire(judge), topicKeys });
  };

  return (
    <div className="run-form">
      <div className="run-card">
        <div className="run-card-title">Topics</div>
        <p className="hint">
          {selected.size >= topics.length ? "Covering the whole KB." : `Covering ${String(selected.size)} of ${String(topics.length)} topics.`}
        </p>
        <button type="button" className="btn btn-secondary sm" onClick={() => setScopeOpen((o) => !o)}>
          {scopeOpen ? "Hide topics ▾" : "Choose topics ▸"}
        </button>
        {scopeOpen && <ScopeTree topics={topics} nodes={nodes} selected={selected} onChange={onScope} />}
      </div>
      <EndpointCard title="Endpoint under test" hint="Your model/agent endpoint. Its coverage of the KB is what gets measured." value={source} onChange={setSource} />
      <EndpointCard title="Judge endpoint" hint="A separate, trusted model that grades the answers — a source must not grade itself." value={judge} onChange={setJudge} />
      <button className="btn btn-primary" type="button" disabled={!ready || disabled} onClick={submit} title={ready ? "" : "Pick topics and fill in both endpoints"}>
        {disabled ? "Starting…" : `Run coverage${selected.size < topics.length ? ` (${String(selected.size)})` : ""}`}
      </button>
      <p className="hint">Keys are used for this run only and never saved.</p>
    </div>
  );
}

/** Re-enter keys to resume a paused/interrupted run. Provider/URL/model are remembered; the scope is fixed. */
function ResumePanel({ run, disabled, onResume }: { run: EvalRunDetail; disabled: boolean; onResume: (req: ResumeRequest) => void }): React.JSX.Element {
  const [source, setSource] = useState<EndpointDraft>(() => fromEcho(run.source));
  const [judge, setJudge] = useState<EndpointDraft>(() => fromEcho(run.judge));
  const ready = endpointComplete(source) && endpointComplete(judge);
  return (
    <div className="run-form" style={{ marginTop: 16 }}>
      <div className="hint">Re-enter the API keys to continue from topic {run.progress.done + 1} of {run.progress.total}. Keys were never stored.</div>
      <EndpointCard title="Endpoint under test" hint="Same endpoint as before — just the key." value={source} onChange={setSource} />
      <EndpointCard title="Judge endpoint" hint="Same judge as before — just the key." value={judge} onChange={setJudge} />
      <button className="btn btn-primary" type="button" disabled={!ready || disabled} onClick={() => onResume({ source: toWire(source), judge: toWire(judge) })}>
        {disabled ? "Resuming…" : "Resume run"}
      </button>
    </div>
  );
}

function useElapsed(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!startedAt) return "0s";
  const secs = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  return secs < 60 ? `${String(secs)}s` : `${String(Math.floor(secs / 60))}m ${String(secs % 60)}s`;
}

function Tally({ log }: { log: RunLogEntry[] }): React.JSX.Element {
  const counts = new Map<string, number>();
  for (const e of log) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  return (
    <div className="live-tally">
      {TALLY.map((t) => {
        const n = counts.get(t.status) ?? 0;
        return (
          <div className={`live-chip${n ? " on" : ""}`} key={t.status}>
            <StatusPill status={t.status} />
            <span className="live-chip-n">{n}</span>
          </div>
        );
      })}
    </div>
  );
}

function FeedRow({ entry }: { entry: RunLogEntry }): React.JSX.Element {
  return (
    <div className="feed-row">
      <div className="feed-row-top">
        <StatusPill status={entry.status} />
        <span className="feed-id">{entry.id}</span>
        <span className={`r-kind ${entry.kind}`}>{entry.kind}</span>
        <span className="feed-agree" title="self-consistency across phrasings">
          {entry.agreement.toFixed(2)}
        </span>
      </div>
      <div className="feed-detail">{entry.detail}</div>
      {entry.sample ? <div className="feed-sample">“{entry.sample}”</div> : null}
    </div>
  );
}

function FeedList({ log }: { log: RunLogEntry[] }): React.JSX.Element {
  const feed = [...log].reverse(); // newest first
  return (
    <div className="live-feed">
      {feed.length ? feed.map((e) => <FeedRow key={e.seq} entry={e} />) : <div className="hint" style={{ padding: "10px 2px" }}>Waiting for the first topic to resolve…</div>}
    </div>
  );
}

function LiveProbe({ detail, onPause, onCancel }: { detail: EvalRunDetail; onPause: () => void; onCancel: () => void }): React.JSX.Element {
  const { progress, log } = detail;
  const elapsed = useElapsed(detail.startedAt);
  return (
    <div className="live">
      <div className="live-head">
        <div className="live-headrow">
          <div className="live-title">
            Probing {detail.source.model} · <span className="live-pct">{progressPct(progress.done, progress.total)}%</span>
          </div>
          <div className="live-controls">
            <button type="button" className="btn btn-secondary sm" onClick={onPause}>
              Pause
            </button>
            <button type="button" className="btn subtle sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
        <div className="live-sub">
          {progress.done}/{progress.total} topics · {elapsed} · {detail.manifestId}@{detail.manifestVersion}
        </div>
      </div>
      <div className="run-bar live-bar">
        <div className="run-bar-fill" style={{ width: `${String(progressPct(progress.done, progress.total))}%` }} />
      </div>
      <div className="live-now">
        <span className="live-dot" aria-hidden="true" />
        {progress.current ? (
          <span>
            interrogating <b>{progress.current.title || progress.current.id}</b> <span className={`r-kind ${progress.current.kind}`}>{progress.current.kind}</span>
            <span className="live-now-sub"> — asking the source, then grading with the judge…</span>
          </span>
        ) : (
          <span>working…</span>
        )}
      </div>
      <Tally log={log} />
      <FeedList log={log} />
    </div>
  );
}

function StoppedView({ detail, resuming, onResume }: { detail: EvalRunDetail; resuming: boolean; onResume: (req: ResumeRequest) => void }): React.JSX.Element {
  const paused = detail.status === "paused";
  return (
    <div className="live">
      <div className="live-head">
        <div className="live-title">
          {paused ? "Paused" : "Interrupted"} · {progressPct(detail.progress.done, detail.progress.total)}%
        </div>
        <div className="live-sub">
          {detail.progress.done}/{detail.progress.total} topics done · {detail.manifestId}@{detail.manifestVersion}
          {detail.error ? ` · ${detail.error.message.split("\n")[0]}` : ""}
        </div>
      </div>
      <div className="run-bar">
        <div className="run-bar-fill" style={{ width: `${String(progressPct(detail.progress.done, detail.progress.total))}%` }} />
      </div>
      <ResumePanel run={detail} disabled={resuming} onResume={onResume} />
      <Tally log={detail.log} />
      <FeedList log={detail.log} />
    </div>
  );
}

function ReportPane({
  detail,
  hasSelection,
  levels,
  resuming,
  onPause,
  onCancel,
  onResume,
}: {
  detail: EvalRunDetail | undefined;
  hasSelection: boolean;
  levels: string[];
  resuming: boolean;
  onPause: () => void;
  onCancel: () => void;
  onResume: (req: ResumeRequest) => void;
}): React.JSX.Element {
  if (!detail) {
    if (hasSelection) return <div className="empty">Loading run…</div>;
    return (
      <div className="empty">
        <div className="big">No run selected</div>
        Configure a scope + endpoint on the left and run a coverage probe.
      </div>
    );
  }
  if (detail.status === "running") return <LiveProbe detail={detail} onPause={onPause} onCancel={onCancel} />;
  if (detail.status === "paused" || detail.status === "interrupted") return <StoppedView detail={detail} resuming={resuming} onResume={onResume} />;
  if (detail.status === "failed") return <div className="banner warn run-error">Run failed: {detail.error?.message ?? "unknown error"}</div>;
  if (detail.status === "canceled") {
    return (
      <div className="empty">
        <div className="big">Canceled</div>
        This run was stopped before it finished.
      </div>
    );
  }
  if (!detail.report) return <div className="empty">Loading report…</div>;
  return <SingleReport report={detail.report} levels={levels} />;
}

function RunRow({ run, selected, onSelect, onPause, onCancel }: { run: EvalRunSummary; selected: boolean; onSelect: () => void; onPause: () => void; onCancel: () => void }): React.JSX.Element {
  const scoped = run.scope.topicKeys !== null;
  return (
    <li className={`run-row${selected ? " sel" : ""}`} onClick={onSelect}>
      <div className="run-row-head">
        <span className="run-row-model">{run.source.model || run.source.provider}</span>
        <span className={`pill ${STATUS_PILL[run.status]}`}>{STATUS_LABEL[run.status]}</span>
      </div>
      <div className="run-row-meta">
        {run.source.provider} · {run.manifestId}@{run.manifestVersion}
        {scoped ? ` · ${String(run.progress.total)} topics` : ""}
      </div>
      {run.status === "running" ? (
        <div className="run-progress">
          <div className="run-bar">
            <div className="run-bar-fill" style={{ width: `${String(progressPct(run.progress.done, run.progress.total))}%` }} />
          </div>
          <div className="run-progress-foot">
            <span className="hint">
              {run.progress.done}/{run.progress.total} topics
            </span>
            <span className="run-row-btns">
              <button className="btn btn-secondary sm" type="button" onClick={(e) => { e.stopPropagation(); onPause(); }}>
                Pause
              </button>
              <button className="btn subtle sm" type="button" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
                Cancel
              </button>
            </span>
          </div>
        </div>
      ) : run.status === "succeeded" && run.metrics ? (
        <div className="run-row-meta">
          grounded {pct(run.metrics.groundedRate)} · refused {pct(run.metrics.refusalRate)} · canary-bite {pct(run.metrics.canaryBiteRate)}
        </div>
      ) : run.status === "paused" || run.status === "interrupted" ? (
        <div className="run-row-meta">{run.progress.done}/{run.progress.total} done · select to resume</div>
      ) : run.status === "failed" && run.error ? (
        <div className="run-row-err">{run.error.message.split("\n")[0]}</div>
      ) : null}
    </li>
  );
}

export function RunView(props: {
  runs: EvalRunSummary[];
  selected: string | null;
  details: Record<string, EvalRunDetail>;
  levels: string[];
  topics: Topic[];
  nodes: NodeInfo[];
  submitting: boolean;
  resuming: boolean;
  onSubmit: (req: RunRequest) => void;
  onPause: (id: string) => void;
  onCancel: (id: string) => void;
  onResume: (id: string, req: ResumeRequest) => void;
  dispatch: Dispatch<Action>;
}): React.JSX.Element {
  const { runs, selected, details, levels, topics, nodes, submitting, resuming, onSubmit, onPause, onCancel, onResume, dispatch } = props;
  const detail = selected ? details[selected] : undefined;

  return (
    <section className="view">
      <div className="cov-wrap run-grid">
        <aside className="run-side">
          <RunForm topics={topics} nodes={nodes} onSubmit={onSubmit} disabled={submitting} />
          <div className="run-list-wrap">
            <h6>Your runs</h6>
            {runs.length ? (
              <ul className="run-list">
                {runs.map((r) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    selected={r.id === selected}
                    onSelect={() => dispatch({ type: "selectEvalRun", id: r.id })}
                    onPause={() => onPause(r.id)}
                    onCancel={() => onCancel(r.id)}
                  />
                ))}
              </ul>
            ) : (
              <div className="hint">No runs yet — fill in the form and run one.</div>
            )}
          </div>
        </aside>
        <div className="run-report">
          <ReportPane
            detail={detail}
            hasSelection={selected !== null}
            levels={levels}
            resuming={resuming}
            onPause={() => selected && onPause(selected)}
            onCancel={() => selected && onCancel(selected)}
            onResume={(req) => selected && onResume(selected, req)}
          />
        </div>
      </div>
    </section>
  );
}
