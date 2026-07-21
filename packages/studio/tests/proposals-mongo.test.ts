/**
 * Phase 4 — the review flow over HTTP: author edits → propose → admin sees the live diff → admin edits
 * the same topic → merge 409 → author syncs + resolves → merge succeeds → the change is on main for a
 * viewer to see. Also covers withdraw and the "only an author can propose" guard.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { reqAs, startStudio, teardown, topic, type Studio } from "./server-helper";
import { startMongo, stopMongo } from "./mongo-helper";

beforeAll(startMongo, 60_000);
afterAll(stopMongo);
afterEach(teardown);

const ALICE = { name: "Alice", email: "alice@corp.com" };

async function studio(): Promise<Studio> {
  return startStudio({
    multiUser: true,
    access: { admins: ["alice@corp.com"], users: [{ email: "bob@corp.com", scopes: [["protocol", "foundation"]] }], defaultScopes: [] },
    seed: (store) => store.putTopic("main", topic(["protocol", "foundation"], "seed"), { actor: ALICE }).then(() => undefined),
  });
}

const edit = (title: string) => ({ topic: { id: "seed", path: ["protocol", "foundation"], title, kind: "real", questions: ["a", "b"] } });
interface Proposal {
  id: string;
  workspace: string;
  author: string;
  state: string;
  changes: { added: number; edited: number; deleted: number; conflicted: number };
}
interface ManifestResp {
  topics: { id: string; title: string }[];
}

describe("review flow (HTTP)", () => {
  it("propose lists a live-diff proposal; only an author may propose", async () => {
    const s = await studio();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", edit("bob-edit"));
    const p = await reqAs<Proposal>(s.base, "bob@corp.com", "POST", "/api/proposals", { note: "please review" });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ id: "bob-corp-com", workspace: "bob-corp-com", state: "requested" });
    expect(p.json.changes.edited).toBe(1);

    // The queue lists it; the detail carries the live change set.
    const queue = await reqAs<{ proposals: Proposal[] }>(s.base, "alice@corp.com", "GET", "/api/proposals");
    expect(queue.json.proposals.map((x) => x.id)).toEqual(["bob-corp-com"]);
    const detail = await reqAs<{ workspace: string; changes: { key: string; class: string }[] }>(s.base, "alice@corp.com", "GET", "/api/proposals/bob-corp-com");
    expect(detail.json.changes.find((c) => c.key === "protocol/foundation/seed")?.class).toBe("edit");

    // An admin (on main) cannot propose.
    expect((await reqAs(s.base, "alice@corp.com", "POST", "/api/proposals")).status).toBe(400);
  });

  it("conflict → 409 on merge → author syncs + resolves → merge succeeds → viewer sees it", async () => {
    const s = await studio();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", edit("bob-edit"));
    await reqAs(s.base, "bob@corp.com", "POST", "/api/proposals");

    // Admin edits the same topic on main → the proposal now conflicts.
    await reqAs(s.base, "alice@corp.com", "POST", "/api/topics", edit("alice-edit"));
    const blocked = await reqAs<{ conflicts: { key: string }[] }>(s.base, "alice@corp.com", "POST", "/api/proposals/bob-corp-com/merge");
    expect(blocked.status).toBe(409);
    expect(blocked.json.conflicts.map((c) => c.key)).toContain("protocol/foundation/seed");

    // Author syncs (sees the conflict) and keeps their version.
    const sync = await reqAs<{ conflicts: { key: string }[]; conflicted: number }>(s.base, "bob@corp.com", "POST", "/api/sync");
    expect(sync.json.conflicted).toBe(1);
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/sync/resolve", { key: "protocol/foundation/seed", choose: "mine" })).status).toBe(200);

    // Now the admin merge succeeds and main carries bob's title.
    expect((await reqAs(s.base, "alice@corp.com", "POST", "/api/proposals/bob-corp-com/merge")).status).toBe(200);
    const viewer = await reqAs<ManifestResp>(s.base, "carol@corp.com", "GET", "/api/manifest");
    expect(viewer.json.topics.find((t) => t.id === "seed")?.title).toBe("bob-edit");
    // The proposal drained from the queue.
    expect((await reqAs<{ proposals: Proposal[] }>(s.base, "alice@corp.com", "GET", "/api/proposals")).json.proposals).toHaveLength(0);
  });

  it("an author can withdraw a proposal", async () => {
    const s = await studio();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", edit("bob-edit"));
    await reqAs(s.base, "bob@corp.com", "POST", "/api/proposals");
    expect((await reqAs<{ proposals: Proposal[] }>(s.base, "alice@corp.com", "GET", "/api/proposals")).json.proposals).toHaveLength(1);
    expect((await reqAs(s.base, "bob@corp.com", "DELETE", "/api/proposals")).status).toBe(200);
    expect((await reqAs<{ proposals: Proposal[] }>(s.base, "alice@corp.com", "GET", "/api/proposals")).json.proposals).toHaveLength(0);
  });
});
