/**
 * Eval-run routes + runner: run a coverage probe against a user-supplied endpoint from the dashboard.
 *
 * The happy-path test drives a REAL coverage probe end-to-end against a `node:http` fake that speaks
 * the OpenAI protocol (same philosophy as the provider fakes), so it exercises the whole seam —
 * provider package → engine `coverage` → `evalRuns` doc — without a model. The load-bearing assertion
 * is that the API key used to reach the endpoint is NEVER written to Mongo.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DbHandle, EvalRunDoc } from "../src/db";
import { EvalRunner } from "../src/runner";
import { ManifestStore } from "../src/store";

import { startMongo, stopMongo } from "./mongo-helper";
import { reqAs, startStudio, teardown, topic, type Studio } from "./server-helper";

// A minimal OpenAI-compatible backend: lists a model, and answers every chat call. For a CONSTRAINED
// request (structured output / tool) it returns a valid JSON object so the provider never throws; the
// judge then validates it against its own schema and falls back to a heuristic, which is fine here.
async function fakeOpenai(): Promise<{ baseUrl: string; model: string; close: () => void }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c as string));
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const constrained = body["response_format"] !== undefined || (Array.isArray(body["tools"]) && body["tools"].length > 0);
      const content = constrained ? "{}" : "Canada is a country in North America.";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }),
      );
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, model: "fake-model", close: () => server.close() };
}

const ADMIN = "admin@corp.com";
const VIEWER = "viewer@corp.com";

/** A studio seeded with a couple of topics on main and `admin@corp.com` as the KB admin. */
async function studioWithKb(): Promise<Studio> {
  return startStudio({
    multiUser: true,
    access: { admins: [ADMIN] },
    seed: async (store) => {
      await store.putTopic("main", topic(["retail"], "returns"), { actor: { name: "seed", email: "seed" } });
      await store.putTopic("main", topic(["retail"], "made-up", { kind: "canary" }), { actor: { name: "seed", email: "seed" } });
    },
  });
}

function endpoint(baseUrl: string, model: string, apiKey: string): Record<string, unknown> {
  return { provider: "openai", baseUrl, model, apiKey };
}

/** Insert a finished run doc directly (for scoping tests that don't need a real probe). */
async function insertRun(db: DbHandle, over: Partial<EvalRunDoc>): Promise<string> {
  const id = over._id ?? `evalrun_test_${String(Math.round(performance.now() * 1000))}`;
  const now = new Date();
  await db.evalRuns.insertOne({
    _id: id,
    actor: "someone@corp.com",
    workspace: "main",
    subject: "the subject",
    manifestId: "test-kb",
    manifestVersion: "1.0",
    status: "succeeded",
    source: { provider: "openai", baseUrl: "http://x/v1", model: "m" },
    judge: { provider: "openai", baseUrl: "http://x/v1", model: "m" },
    progress: { done: 1, total: 1 },
    report: null,
    error: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    ...over,
  });
  return id;
}

beforeAll(startMongo);
afterAll(stopMongo);
afterEach(teardown);

describe("POST /api/runs validation", () => {
  it("rejects a missing or malformed endpoint block", async () => {
    const s = await studioWithKb();
    const bad = [
      { judge: endpoint("http://h/v1", "m", "k") }, // no source
      { source: { provider: "openai", baseUrl: "http://h/v1", model: "m" }, judge: endpoint("http://h/v1", "m", "k") }, // no apiKey
      { source: endpoint("localhost:1234", "m", "k"), judge: endpoint("http://h/v1", "m", "k") }, // not http(s)
      { source: { provider: "grok", baseUrl: "http://h/v1", model: "m", apiKey: "k" }, judge: endpoint("http://h/v1", "m", "k") }, // bad provider
      { source: endpoint("http://h/v1", "", "k"), judge: endpoint("http://h/v1", "m", "k") }, // empty model
    ];
    for (const body of bad) {
      const r = await reqAs(s.base, ADMIN, "POST", "/api/runs", body);
      expect(r.status).toBe(400);
    }
  });
});

describe("run ownership + listing", () => {
  it("scopes runs to their owner; admins can see all", async () => {
    const s = await studioWithKb();
    const mine = await insertRun(s.db, { actor: VIEWER });
    const theirs = await insertRun(s.db, { actor: "other@corp.com" });

    const viewerList = await reqAs<{ runs: { id: string }[] }>(s.base, VIEWER, "GET", "/api/runs");
    expect(viewerList.json.runs.map((r) => r.id)).toEqual([mine]);

    // The viewer cannot read someone else's run.
    const forbidden = await reqAs(s.base, VIEWER, "GET", `/api/runs/${theirs}`);
    expect(forbidden.status).toBe(403);

    // The admin sees only their own by default, but everyone with ?all=1.
    const adminAll = await reqAs<{ runs: { id: string }[] }>(s.base, ADMIN, "GET", "/api/runs?all=1");
    expect(adminAll.json.runs.map((r) => r.id).sort()).toEqual([mine, theirs].sort());

    // A missing run is a 404.
    const missing = await reqAs(s.base, ADMIN, "GET", "/api/runs/nope");
    expect(missing.status).toBe(404);
  });
});

describe("orphan reaping", () => {
  it("flips a stale running doc to failed", async () => {
    const s = await studioWithKb();
    const id = await insertRun(s.db, { status: "running", finishedAt: null });
    await new EvalRunner(s.db, new ManifestStore(s.db)).reapOrphans();
    const doc = await s.db.evalRuns.findOne({ _id: id });
    expect(doc?.status).toBe("failed");
    expect(doc?.error?.name).toBe("Interrupted");
  });
});

describe("end-to-end coverage run", () => {
  it("runs a probe against a fake endpoint, stores the report, and never persists the key", async () => {
    const s = await studioWithKb();
    const fake = await fakeOpenai();
    const SECRET = "sk-secret-DO-NOT-STORE";
    try {
      const start = await reqAs<{ id: string; status: string }>(s.base, ADMIN, "POST", "/api/runs", {
        source: endpoint(fake.baseUrl, fake.model, SECRET),
        judge: endpoint(fake.baseUrl, fake.model, `${SECRET}-judge`),
      });
      expect(start.status).toBe(202);
      const id = start.json.id;

      // Poll until the background run leaves the running state.
      let status = "running";
      for (let i = 0; i < 100 && status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const got = await reqAs<{ status: string }>(s.base, ADMIN, "GET", `/api/runs/${id}`);
        status = got.json.status;
      }

      const doc = await s.db.evalRuns.findOne({ _id: id });
      expect(doc, `run did not finish: ${doc?.error?.message ?? "still running"}`).toBeTruthy();
      expect(doc?.status, doc?.error?.message).toBe("succeeded");
      expect(doc?.report).toBeTruthy();
      expect(doc?.report?.totals.topics).toBe(2);
      expect(doc?.progress).toEqual({ done: 2, total: 2 });

      // The whole point: neither the source key nor the judge key is anywhere in the stored doc.
      expect(JSON.stringify(doc)).not.toContain(SECRET);
      expect(doc?.source).not.toHaveProperty("apiKey");

      // The finished detail carries the report + its per-level tree, ready for the viewer.
      const detail = await reqAs<{ report: { tree?: unknown; metrics: unknown } | null }>(s.base, ADMIN, "GET", `/api/runs/${id}`);
      expect(detail.json.report?.tree).toBeTruthy();
      expect(detail.json.report?.metrics).toBeTruthy();
    } finally {
      fake.close();
    }
  }, 20000);
});
