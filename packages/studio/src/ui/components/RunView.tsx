/**
 * RunView — the Evaluate tab. Point the harness at YOUR endpoint, pick the protocol, and run a
 * coverage probe against the KB in Studio, then read the report back here.
 *
 *   Left: a form with two credential blocks — the endpoint under test (the source) and a trusted
 *   judge endpoint (a source must never grade itself). API keys are typed into local state only and
 *   POSTed once; they are never stored server-side and never come back.
 *
 *   Right: the user's runs (status + live progress), and — for a finished run — the exact same report
 *   surface the Coverage tab renders (`SingleReport`), fed by the embedded report the server returns.
 */
import { useState } from "react";
import type { Dispatch } from "react";

import type { Action } from "../state";
import type { EvalProvider, EvalRunDetail, EvalRunStatus, EvalRunSummary, RunRequest } from "../types";
import { SingleReport } from "./CoverageView";

/** The sensible default base URL per protocol (mirrors the CLI / env seam). */
const DEFAULT_BASE: Record<EvalProvider, string> = {
  openai: "http://localhost:1234/v1",
  anthropic: "https://api.anthropic.com",
};

const KNOWN_BASES = new Set(Object.values(DEFAULT_BASE));

interface EndpointDraft {
  provider: EvalProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function blankEndpoint(provider: EvalProvider): EndpointDraft {
  return { provider, baseUrl: DEFAULT_BASE[provider], model: "", apiKey: "" };
}

function endpointComplete(e: EndpointDraft): boolean {
  return /^https?:\/\//i.test(e.baseUrl.trim()) && e.model.trim() !== "" && e.apiKey !== "";
}

const STATUS_LABEL: Record<EvalRunStatus, string> = {
  running: "running",
  succeeded: "done",
  failed: "failed",
  canceled: "canceled",
};

const STATUS_COLOR: Record<EvalRunStatus, string> = {
  running: "var(--color-neutral-500)",
  succeeded: "var(--color-good, #2e7d32)",
  failed: "var(--color-bad, #c62828)",
  canceled: "var(--color-neutral-400)",
};

function EndpointFields({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: EndpointDraft;
  onChange: (next: EndpointDraft) => void;
}): React.JSX.Element {
  // Switching protocol swaps the base URL only when it's still a known default (never clobbers a custom one).
  const setProvider = (provider: EvalProvider): void => {
    const baseUrl = value.baseUrl.trim() === "" || KNOWN_BASES.has(value.baseUrl.trim()) ? DEFAULT_BASE[provider] : value.baseUrl;
    onChange({ ...value, provider, baseUrl });
  };
  return (
    <fieldset className="run-endpoint" style={{ border: "1px solid var(--color-neutral-200)", borderRadius: 8, padding: 12, margin: 0 }}>
      <legend style={{ fontWeight: 600, padding: "0 6px" }}>{title}</legend>
      <p className="hint" style={{ marginTop: 0 }}>
        {hint}
      </p>
      <div className="field">
        <label>Protocol</label>
        <select value={value.provider} onChange={(e) => setProvider(e.target.value as EvalProvider)}>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic Messages</option>
        </select>
      </div>
      <div className="field">
        <label>Base URL</label>
        <input value={value.baseUrl} placeholder={DEFAULT_BASE[value.provider]} onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} />
      </div>
      <div className="field">
        <label>Model</label>
        <input value={value.model} placeholder="model name your endpoint serves" onChange={(e) => onChange({ ...value, model: e.target.value })} />
      </div>
      <div className="field">
        <label>API key</label>
        <input
          type="password"
          autoComplete="off"
          value={value.apiKey}
          placeholder="sent once, never stored"
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
        />
      </div>
    </fieldset>
  );
}

function RunForm({ onSubmit, disabled }: { onSubmit: (req: RunRequest) => void; disabled: boolean }): React.JSX.Element {
  const [source, setSource] = useState<EndpointDraft>(() => blankEndpoint("openai"));
  const [judge, setJudge] = useState<EndpointDraft>(() => blankEndpoint("anthropic"));
  const ready = endpointComplete(source) && endpointComplete(judge);

  const submit = (): void => {
    onSubmit({
      source: { provider: source.provider, baseUrl: source.baseUrl.trim(), model: source.model.trim(), apiKey: source.apiKey },
      judge: { provider: judge.provider, baseUrl: judge.baseUrl.trim(), model: judge.model.trim(), apiKey: judge.apiKey },
    });
  };

  return (
    <div className="run-form" style={{ display: "grid", gap: 14 }}>
      <EndpointFields
        title="Endpoint under test"
        hint="Your model/agent endpoint. Its coverage of the KB is what gets measured."
        value={source}
        onChange={setSource}
      />
      <EndpointFields
        title="Judge endpoint"
        hint="A separate, trusted model that grades the answers — a source must not grade itself."
        value={judge}
        onChange={setJudge}
      />
      <button className="btn btn-primary" type="button" disabled={!ready || disabled} onClick={submit} title={ready ? "" : "Fill in both endpoints first"}>
        {disabled ? "Starting…" : "Run coverage"}
      </button>
      <p className="hint">The run probes the KB exactly as you see it in Studio. Keys are used for this run only and never saved.</p>
    </div>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
  onCancel,
}: {
  run: EvalRunSummary;
  selected: boolean;
  onSelect: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const pct = run.progress.total ? Math.round((run.progress.done / run.progress.total) * 100) : 0;
  return (
    <li
      className={`run-row${selected ? " sel" : ""}`}
      onClick={onSelect}
      style={{
        listStyle: "none",
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? "var(--color-neutral-100)" : "transparent",
        border: "1px solid var(--color-neutral-200)",
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600 }}>{run.source.model || run.source.provider}</span>
        <span style={{ color: STATUS_COLOR[run.status], fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>{STATUS_LABEL[run.status]}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
        {run.source.provider} · {run.manifestId}@{run.manifestVersion}
      </div>
      {run.status === "running" ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ height: 4, background: "var(--color-neutral-200)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${String(pct)}%`, height: "100%", background: "var(--color-neutral-500)" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
              {run.progress.done}/{run.progress.total} topics
            </span>
            <button
              className="btn btn-secondary sm"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : run.status === "succeeded" && run.metrics ? (
        <div style={{ fontSize: 11, color: "var(--color-neutral-500)", marginTop: 4 }}>
          grounded {Math.round(run.metrics.groundedRate * 100)}% · refused {Math.round(run.metrics.refusalRate * 100)}% · canary-bite{" "}
          {Math.round(run.metrics.canaryBiteRate * 100)}%
        </div>
      ) : run.status === "failed" && run.error ? (
        <div style={{ fontSize: 11, color: STATUS_COLOR.failed, marginTop: 4 }}>{run.error.message.split("\n")[0]}</div>
      ) : null}
    </li>
  );
}

function ReportPane({ detail, levels }: { detail: EvalRunDetail | undefined; levels: string[] }): React.JSX.Element {
  if (!detail) return <div className="empty">Select a run.</div>;
  if (detail.status === "running") {
    const pct = detail.progress.total ? Math.round((detail.progress.done / detail.progress.total) * 100) : 0;
    return (
      <div className="empty">
        <div className="big">Probing… {pct}%</div>
        {detail.progress.done}/{detail.progress.total} topics graded against {detail.manifestId}@{detail.manifestVersion}.
      </div>
    );
  }
  if (detail.status === "failed") {
    return (
      <div className="banner warn" style={{ whiteSpace: "pre-wrap" }}>
        Run failed: {detail.error?.message ?? "unknown error"}
      </div>
    );
  }
  if (detail.status === "canceled") return <div className="empty">This run was canceled before it finished.</div>;
  if (!detail.report) return <div className="empty">Loading report…</div>;
  return <SingleReport report={detail.report} levels={levels} />;
}

export function RunView(props: {
  runs: EvalRunSummary[];
  selected: string | null;
  details: Record<string, EvalRunDetail>;
  levels: string[];
  submitting: boolean;
  onSubmit: (req: RunRequest) => void;
  onCancel: (id: string) => void;
  dispatch: Dispatch<Action>;
}): React.JSX.Element {
  const { runs, selected, details, levels, submitting, onSubmit, onCancel, dispatch } = props;
  const detail = selected ? details[selected] : undefined;

  return (
    <section className="view run-view">
      <div className="cov-wrap" style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 18 }}>
          <RunForm onSubmit={onSubmit} disabled={submitting} />
          <div>
            <h6 style={{ color: "var(--color-neutral-600)", margin: "0 0 8px" }}>Your runs</h6>
            {runs.length ? (
              <ul style={{ margin: 0, padding: 0 }}>
                {runs.map((r) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    selected={r.id === selected}
                    onSelect={() => dispatch({ type: "selectEvalRun", id: r.id })}
                    onCancel={() => onCancel(r.id)}
                  />
                ))}
              </ul>
            ) : (
              <div className="hint">No runs yet — fill in the form and run one.</div>
            )}
          </div>
        </div>
        <div>
          <ReportPane detail={detail} levels={levels} />
        </div>
      </div>
    </section>
  );
}
