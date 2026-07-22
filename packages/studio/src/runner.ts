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
 * cancelled, and a per-actor + global cap bounds how much work one server carries at once.
 *
 * Correctness across a restart: in-memory state does not survive a crash, so `reapOrphans()` flips any
 * `running` doc left by a dead process to `failed` on the next boot (its keys are already gone).
 */
import { coverage, createJudge, createModelKnowledgeSource, defaultProfile, serializeError, type Run } from "@evaluator/core";
import type { CoverageReport } from "@evaluator/core";

import type { DbHandle } from "./db";
import { makeLlm, type EndpointConfig } from "./llm-factory";
import type { ManifestStore } from "./store";

/** At most this many runs execute across the whole server at once (excess is refused, not queued). */
const MAX_GLOBAL = 2;
/** At most this many concurrent runs per user, so one person cannot monopolise the server. */
const MAX_PER_ACTOR = 1;
/** Don't write progress to Mongo more than once per this interval (a run emits an event per topic). */
const PROGRESS_THROTTLE_MS = 1000;

/** Raised when the concurrency cap is hit → the route maps it to 429. */
export class TooManyRuns extends Error {}

interface LiveRun {
  actor: string;
  canceled: boolean;
  cancel: (reason?: string) => void;
}

export interface StartOpts {
  actor: string;
  workspace: string;
  source: EndpointConfig;
  judge: EndpointConfig;
}

export class EvalRunner {
  private readonly live = new Map<string, LiveRun>();
  private counter = 0;

  constructor(
    private readonly db: DbHandle,
    private readonly store: ManifestStore,
  ) {}

  /** How many concurrent runs `actor` currently has in flight. */
  private activeForActor(actor: string): number {
    let n = 0;
    for (const r of this.live.values()) if (r.actor === actor) n++;
    return n;
  }

  /**
   * Insert a run doc and kick off the probe in the background. Returns the runId immediately. Throws
   * `TooManyRuns` when a cap is hit, or `ConfigError` (→ 422) when the workspace's KB won't assemble.
   */
  async start(opts: StartOpts): Promise<string> {
    if (this.live.size >= MAX_GLOBAL) throw new TooManyRuns("the server is busy running other evaluations — try again shortly");
    if (this.activeForActor(opts.actor) >= MAX_PER_ACTOR) throw new TooManyRuns("you already have a run in progress — wait for it to finish");

    // Assemble the manifest BEFORE inserting a run doc, so a bad/empty KB fails fast (ConfigError → 422)
    // rather than leaving a doomed run in the list. The engine reads no files; we hand it a plain object.
    const manifest = await this.store.assembledManifest(opts.workspace);
    const profile = defaultProfile(manifest.subject);

    const sourceLlm = await makeLlm(opts.source);
    const judgeLlm = await makeLlm(opts.judge);

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
      source: { provider: opts.source.provider, baseUrl: opts.source.baseUrl, model: opts.source.model },
      judge: { provider: opts.judge.provider, baseUrl: opts.judge.baseUrl, model: opts.judge.model },
      progress: { done: 0, total: manifest.topics.length },
      report: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    });

    // The source is graded by a SEPARATE judge endpoint — a source must never grade itself. Both keys
    // live only in the closures `makeLlm` returned above; nothing about them is written to the doc.
    const run = coverage(createModelKnowledgeSource(sourceLlm, profile), createJudge(judgeLlm, profile), manifest, {
      sourceLabel: `${opts.source.provider}:${opts.source.model}`,
    });
    this.live.set(id, { actor: opts.actor, canceled: false, cancel: (reason) => run.cancel(reason) });

    void this.drive(id, run, manifest.topics.length);
    return id;
  }

  /** Cancel a live run (cooperative, via the engine's AbortSignal). Returns false if it wasn't live. */
  cancel(id: string): boolean {
    const entry = this.live.get(id);
    if (!entry) return false;
    entry.canceled = true;
    entry.cancel("canceled by user");
    return true;
  }

  /** Flip any `running` doc from a previous (now-dead) process to `failed` — its keys are gone. */
  async reapOrphans(): Promise<void> {
    await this.db.evalRuns.updateMany(
      { status: "running" },
      {
        $set: {
          status: "failed",
          error: { name: "Interrupted", message: "the server restarted while this run was in progress", expected: true },
          finishedAt: new Date(),
        },
      },
    );
  }

  /** Drain the run's events for progress, then persist the terminal outcome. Never throws. */
  private async drive(id: string, run: Run<CoverageReport>, total: number): Promise<void> {
    let done = 0;
    let lastWrite = 0;

    // The coverage op yields exactly one `notice` per topic — count them for a live progress bar.
    const drain = (async (): Promise<void> => {
      for await (const ev of run.events) {
        if (ev.type !== "notice") continue;
        done = Math.min(done + 1, total);
        const nowMs = Date.now();
        if (nowMs - lastWrite >= PROGRESS_THROTTLE_MS) {
          lastWrite = nowMs;
          await this.db.evalRuns.updateOne({ _id: id, status: "running" }, { $set: { "progress.done": done } });
        }
      }
    })().catch(() => undefined);

    try {
      const report = await run.result;
      await drain;
      await this.db.evalRuns.updateOne(
        { _id: id },
        { $set: { status: "succeeded", report, "progress.done": total, finishedAt: new Date() } },
      );
    } catch (err) {
      await drain;
      const canceled = this.live.get(id)?.canceled ?? false;
      await this.db.evalRuns.updateOne(
        { _id: id },
        {
          $set: canceled
            ? { status: "canceled", finishedAt: new Date() }
            : { status: "failed", error: serializeError(err), finishedAt: new Date() },
        },
      );
    } finally {
      this.live.delete(id);
    }
  }
}
