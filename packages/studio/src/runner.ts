/**
 * EvalRunner — run a coverage probe against a USER-SUPPLIED endpoint from the dashboard.
 *
 * This is the one thing the Studio server was deliberately built NOT to do (see server.ts header): run
 * probes, not just view them. It stays inside the architecture — it reaches an LLM only through the
 * provider PACKAGES via `makeLlm`, never a raw SDK — and it borrows the engine's in-process `Run` as
 * the unit of work, so there is no job queue to operate.
 *
 * A run executes DETACHED from the request that created it. The two API keys (source + judge) are
 * captured in the `Llm` closures below and NEVER persisted; when the run ends — or the process exits —
 * they are gone. Progress is streamed into the `evalRuns` collection (throttled); the finished
 * `CoverageReport` is embedded on success. A small in-memory registry tracks live runs so they can be
 * paused/cancelled, and a per-actor + global cap bounds how much work one server carries at once.
 *
 * Durable pause/resume (no job queue): coverage is per-topic-independent and every resolved topic is
 * checkpointed to the doc's `log`. So PAUSE is a cooperative abort that keeps the log; RESUME rebuilds
 * the completed `TopicResult`s from the log and re-runs coverage with `priorResults`, which skips the
 * done topics and only pays for what's left. A process that dies mid-run leaves its doc `interrupted`
 * (via `reapOrphans`) — still resumable, since resume re-supplies the keys (they were never stored).
 */
import { coverage, createJudge, createModelKnowledgeSource, defaultProfile, serializeError, topicKey, ConfigError } from "@evaluator/core";
import type { CoverageReport, Manifest, Run, TopicResult } from "@evaluator/core";
import type { UpdateFilter } from "mongodb";

import { RUN_LOG_CAP, type DbHandle, type EvalRunDoc, type EvalScope, type RunCurrent, type RunLogEntry } from "./db";
import { makeLlm, type EndpointConfig } from "./llm-factory";
import type { ManifestStore } from "./store";

/** At most this many runs execute across the whole server at once (excess is refused, not queued). */
const MAX_GLOBAL = 2;
/** At most this many concurrent runs per user, so one person cannot monopolise the server. */
const MAX_PER_ACTOR = 1;
/** Don't write progress to Mongo more than once per this interval (a run emits several events per topic). */
const PROGRESS_THROTTLE_MS = 600;

/** Raised when the concurrency cap is hit → the route maps it to 429. */
export class TooManyRuns extends Error {}

interface LiveRun {
  actor: string;
  /** Why the run is being aborted, so `drive` knows whether to record `paused` or `canceled`. */
  intent: "cancel" | "pause";
  /** Set the moment we abort on purpose, so a real error is never mistaken for a user action. */
  aborted: boolean;
  cancel: (reason?: string) => void;
}

export interface StartOpts {
  actor: string;
  workspace: string;
  scope: EvalScope;
  source: EndpointConfig;
  judge: EndpointConfig;
}

export interface ResumeOpts {
  doc: EvalRunDoc;
  actor: string;
  source: EndpointConfig;
  judge: EndpointConfig;
}

/** Narrow a manifest to the run's scope. `topicKeys: null` = the whole KB. Empty selection → 422. */
function filterManifest(manifest: Manifest, scope: EvalScope): Manifest {
  if (scope.topicKeys === null) return manifest;
  const want = new Set(scope.topicKeys);
  const topics = manifest.topics.filter((t) => want.has(topicKey(t)));
  if (topics.length === 0) throw new ConfigError("no topics selected — pick at least one topic to evaluate");
  return { ...manifest, topics };
}

/** Rebuild the engine's `TopicResult` from a checkpointed log entry (the resume seam). */
function entryToTopicResult(e: RunLogEntry): TopicResult {
  return {
    key: [...e.path, e.id].join("/"),
    id: e.id,
    path: e.path,
    title: e.title,
    kind: e.kind,
    status: e.status as TopicResult["status"],
    agreement: e.agreement,
    sample: e.sample,
    detail: e.detail,
  };
}

export class EvalRunner {
  private readonly live = new Map<string, LiveRun>();
  private counter = 0;

  constructor(
    private readonly db: DbHandle,
    private readonly store: ManifestStore,
  ) {}

  private activeForActor(actor: string): number {
    let n = 0;
    for (const r of this.live.values()) if (r.actor === actor) n++;
    return n;
  }

  /** Enforce the global + per-actor concurrency caps. Throws `TooManyRuns` (→ 429). */
  private guardCapacity(actor: string): void {
    if (this.live.size >= MAX_GLOBAL) throw new TooManyRuns("the server is busy running other evaluations — try again shortly");
    if (this.activeForActor(actor) >= MAX_PER_ACTOR) throw new TooManyRuns("you already have a run in progress — wait for it to finish");
  }

  /**
   * Insert a run doc and kick off the probe in the background. Returns the runId immediately. Throws
   * `TooManyRuns` (429) or `ConfigError` (422) when the KB won't assemble / the scope selects nothing.
   */
  async start(opts: StartOpts): Promise<string> {
    this.guardCapacity(opts.actor);

    // Assemble + scope the manifest BEFORE inserting a doc, so a bad/empty selection fails fast rather
    // than leaving a doomed run in the list. The engine reads no files; we hand it a plain object.
    const manifest = filterManifest(await this.store.assembledManifest(opts.workspace), opts.scope);
    const profile = defaultProfile(manifest.subject);

    const id = `evalrun_${String(++this.counter)}_${String(Date.now())}`;
    const now = new Date();
    await this.db.evalRuns.insertOne({
      _id: id,
      actor: opts.actor,
      workspace: opts.workspace,
      subject: profile.subject,
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      status: "running",
      scope: opts.scope,
      source: { provider: opts.source.provider, baseUrl: opts.source.baseUrl, model: opts.source.model },
      judge: { provider: opts.judge.provider, baseUrl: opts.judge.baseUrl, model: opts.judge.model },
      progress: { done: 0, total: manifest.topics.length, current: null },
      log: [],
      report: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    });

    await this.launch(id, opts.actor, manifest, profile, opts.source, opts.judge, []);
    return id;
  }

  /**
   * Resume a paused/interrupted run with FRESH keys (never stored). Rebuilds the completed results
   * from the log and re-runs coverage over the same scoped manifest, skipping what's already done.
   * The caller (route) has verified ownership and that the doc is resumable.
   */
  async resume(opts: ResumeOpts): Promise<void> {
    this.guardCapacity(opts.actor);
    const manifest = filterManifest(await this.store.assembledManifest(opts.doc.workspace), opts.doc.scope);
    const profile = defaultProfile(manifest.subject);
    const priorResults = opts.doc.log.map(entryToTopicResult);

    // Keep progress.done at its checkpointed value; the first new topic.probe will re-assert it.
    await this.db.evalRuns.updateOne(
      { _id: opts.doc._id },
      { $set: { status: "running", "progress.total": manifest.topics.length, "progress.current": null, error: null, finishedAt: null } },
    );
    await this.launch(opts.doc._id, opts.actor, manifest, profile, opts.source, opts.judge, priorResults);
  }

  /** Build the transports, register the live run, and drive it in the background. Keys stay in closures. */
  private async launch(
    id: string,
    actor: string,
    manifest: Manifest,
    profile: ReturnType<typeof defaultProfile>,
    source: EndpointConfig,
    judge: EndpointConfig,
    priorResults: readonly TopicResult[],
  ): Promise<void> {
    const sourceLlm = await makeLlm(source);
    const judgeLlm = await makeLlm(judge);
    // The source is graded by a SEPARATE judge endpoint — a source must never grade itself.
    const run = coverage(createModelKnowledgeSource(sourceLlm, profile), createJudge(judgeLlm, profile), manifest, {
      sourceLabel: `${source.provider}:${source.model}`,
      priorResults,
    });
    this.live.set(id, { actor, intent: "cancel", aborted: false, cancel: (reason) => run.cancel(reason) });
    void this.drive(id, run, manifest.topics.length);
  }

  /** Stop a live run and keep its progress — resumable. Returns false if it wasn't live. */
  pause(id: string): boolean {
    return this.abort(id, "pause", "paused by user");
  }

  /** Cancel a live run for good (cooperative abort). Returns false if it wasn't live. */
  cancel(id: string): boolean {
    return this.abort(id, "cancel", "canceled by user");
  }

  private abort(id: string, intent: "cancel" | "pause", reason: string): boolean {
    const entry = this.live.get(id);
    if (!entry) return false;
    entry.intent = intent;
    entry.aborted = true;
    entry.cancel(reason);
    return true;
  }

  /** Flip any `running` doc from a previous (now-dead) process to `interrupted` — resumable, keys gone. */
  async reapOrphans(): Promise<void> {
    await this.db.evalRuns.updateMany(
      { status: "running" },
      {
        $set: {
          status: "interrupted",
          "progress.current": null,
          error: { name: "Interrupted", message: "the server restarted while this run was in progress — resume to continue", expected: true },
        },
      },
    );
  }

  /**
   * Drain the run's structured event stream into the doc — the in-flight topic (`topic.probe`) and
   * each resolved topic (`topic.result`) as a live activity log — then persist the terminal outcome.
   * Writes are throttled and batched (a run emits several events per topic). Never throws.
   */
  private async drive(id: string, run: Run<CoverageReport>, total: number): Promise<void> {
    let done = 0;
    let current: RunCurrent | null = null;
    let pending: RunLogEntry[] = [];
    let lastWrite = 0;

    const flush = async (force: boolean): Promise<void> => {
      const nowMs = Date.now();
      if (!force && nowMs - lastWrite < PROGRESS_THROTTLE_MS) return;
      lastWrite = nowMs;
      const entries = pending;
      pending = [];
      const update: UpdateFilter<EvalRunDoc> = { $set: { "progress.done": done, "progress.current": current } };
      if (entries.length > 0) update.$push = { log: { $each: entries, $slice: -RUN_LOG_CAP } };
      await this.db.evalRuns.updateOne({ _id: id, status: "running" }, update);
    };

    const drain = (async (): Promise<void> => {
      for await (const ev of run.events) {
        if (ev.type === "topic.probe") {
          current = { index: ev.index, id: ev.id, kind: ev.kind, title: ev.title };
          done = ev.index; // topics before the in-flight one are done
          await flush(false);
        } else if (ev.type === "topic.result") {
          pending.push({
            seq: ev.seq,
            at: ev.at,
            index: ev.index,
            id: ev.id,
            kind: ev.kind,
            title: ev.title,
            path: ev.path,
            status: ev.status,
            agreement: ev.agreement,
            sample: ev.sample,
            detail: ev.detail,
          });
          done = ev.index + 1;
          current = null;
          await flush(false);
        }
      }
    })().catch(() => undefined);

    try {
      const report = await run.result;
      await drain;
      await flush(true); // land any entries the throttle held back
      await this.db.evalRuns.updateOne(
        { _id: id },
        { $set: { status: "succeeded", report, "progress.done": total, "progress.current": null, finishedAt: new Date() } },
      );
    } catch (err) {
      await drain;
      await flush(true);
      const entry = this.live.get(id);
      if (entry?.aborted) {
        // A deliberate stop. Pause keeps the run resumable (no finishedAt); cancel is terminal.
        const set: Record<string, unknown> =
          entry.intent === "pause" ? { status: "paused", "progress.current": null } : { status: "canceled", "progress.current": null, finishedAt: new Date() };
        await this.db.evalRuns.updateOne({ _id: id }, { $set: set });
      } else {
        await this.db.evalRuns.updateOne(
          { _id: id },
          { $set: { status: "failed", error: serializeError(err), "progress.current": null, finishedAt: new Date() } },
        );
      }
    } finally {
      this.live.delete(id);
    }
  }
}
