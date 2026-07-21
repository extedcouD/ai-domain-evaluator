/**
 * Phase 3 — multi-workspace isolation + access. An author works in a personal copy cloned from main on
 * first write; another author and main never see it; viewers are read-only; scoped authors are 403
 * outside their scope; admins edit main directly and own the policy. Also ports the access-policy admin
 * surface (grant a scope, non-admins locked out, zero-admin refused, unsafe scope refused).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { reqAs, startStudio, teardown, topic, type Studio } from "./server-helper";
import { startMongo, stopMongo } from "./mongo-helper";

beforeAll(startMongo, 60_000);
afterAll(stopMongo);
afterEach(teardown);

const ACTOR = { name: "seed", email: "alice@corp.com" };

/** A scoped multi-user studio: alice admin, bob scoped to protocol/foundation, everyone else viewer. */
async function scoped(): Promise<Studio> {
  return startStudio({
    multiUser: true,
    access: { admins: ["alice@corp.com"], users: [{ email: "bob@corp.com", scopes: [["protocol", "foundation"]] }], defaultScopes: [] },
    seed: async (store) => {
      await store.putTopic("main", topic(["protocol", "foundation"], "seed"), { actor: ACTOR });
      await store.putTopic("main", topic(["protocol", "domains"], "out-scope"), { actor: ACTOR });
    },
  });
}

interface Whoami {
  role: string;
  scopes: string[][];
  workspace: string;
}
interface ManifestResp {
  topics: { id: string }[];
}
const body = (path: string[], id: string) => ({ topic: { id, path, title: id, kind: "real", questions: ["a", "b"] } });

describe("multi-user workspaces + scoping", () => {
  it("whoami reflects each user's role, scopes, and workspace", async () => {
    const s = await scoped();
    expect((await reqAs<Whoami>(s.base, "alice@corp.com", "GET", "/api/whoami")).json).toMatchObject({ role: "admin", scopes: [[]], workspace: "main" });
    expect((await reqAs<Whoami>(s.base, "bob@corp.com", "GET", "/api/whoami")).json).toMatchObject({ role: "author", scopes: [["protocol", "foundation"]], workspace: "bob-corp-com" });
    expect((await reqAs<Whoami>(s.base, "carol@corp.com", "GET", "/api/whoami")).json).toMatchObject({ role: "viewer", scopes: [], workspace: "main" });
  });

  it("an author's edit is isolated: invisible to main, to another author, and to viewers", async () => {
    const s = await scoped();
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", body(["protocol", "foundation"], "bob-new"))).status).toBe(200);

    // Bob sees it in his own copy…
    expect((await reqAs<ManifestResp>(s.base, "bob@corp.com", "GET", "/api/manifest")).json.topics.some((t) => t.id === "bob-new")).toBe(true);
    // …but main (alice) does not, and neither does a viewer (who reads main).
    expect((await reqAs<ManifestResp>(s.base, "alice@corp.com", "GET", "/api/manifest")).json.topics.some((t) => t.id === "bob-new")).toBe(false);
    expect((await reqAs<ManifestResp>(s.base, "carol@corp.com", "GET", "/api/manifest")).json.topics.some((t) => t.id === "bob-new")).toBe(false);
  });

  it("an author is 403 outside their scope, ok inside it; a viewer is read-only", async () => {
    const s = await scoped();
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", body(["protocol", "foundation"], "ok"))).status).toBe(200);
    expect((await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", body(["protocol", "domains"], "sneak"))).status).toBe(403);
    expect((await reqAs(s.base, "carol@corp.com", "POST", "/api/topics", body(["protocol", "foundation"], "nope"))).status).toBe(403);
  });

  it("an admin edits main directly and owns meta; a non-admin cannot edit meta", async () => {
    const s = await scoped();
    expect((await reqAs(s.base, "alice@corp.com", "POST", "/api/topics", body(["protocol", "domains"], "alice-anywhere"))).status).toBe(200);
    expect((await reqAs<ManifestResp>(s.base, "alice@corp.com", "GET", "/api/manifest")).json.topics.some((t) => t.id === "alice-anywhere")).toBe(true);
    expect((await reqAs(s.base, "alice@corp.com", "PUT", "/api/meta", { id: "test-kb", version: "2.0" })).status).toBe(200);
    expect((await reqAs(s.base, "bob@corp.com", "PUT", "/api/meta", { id: "test-kb", version: "9.9" })).status).toBe(403);
  });

  it("a scoped author cannot self-escalate via the access policy", async () => {
    const s = await scoped();
    expect((await reqAs(s.base, "bob@corp.com", "GET", "/api/access")).status).toBe(403);
    expect((await reqAs(s.base, "bob@corp.com", "PUT", "/api/access", { admins: ["bob@corp.com"], users: [], defaultScopes: [] })).status).toBe(403);
    expect((await reqAs<Whoami>(s.base, "bob@corp.com", "GET", "/api/whoami")).json.role).toBe("author");
  });

  it("an admin grants a scope through the policy; it round-trips and takes effect", async () => {
    const s = await scoped();
    const put = await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", {
      admins: ["alice@corp.com"],
      users: [{ email: "dave@corp.com", scopes: [["protocol", "domains"]] }],
      defaultScopes: [],
    });
    expect(put.status).toBe(200);
    const view = await reqAs<{ users: { email: string; scopes: string[][] }[] }>(s.base, "alice@corp.com", "GET", "/api/access");
    expect(view.json.users).toContainEqual({ email: "dave@corp.com", scopes: [["protocol", "domains"]] });
    // Dave can now write in his new scope.
    expect((await reqAs(s.base, "dave@corp.com", "POST", "/api/topics", body(["protocol", "domains"], "dave-ok"))).status).toBe(200);
  });

  it("refuses a zero-admin policy and an unsafe scope; DELETE /api/access is gone", async () => {
    const s = await scoped();
    expect((await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: [], users: [], defaultScopes: [] })).status).toBe(400);
    expect((await reqAs(s.base, "alice@corp.com", "PUT", "/api/access", { admins: ["alice@corp.com"], users: [{ email: "x@y.com", scopes: [["../etc"]] }], defaultScopes: [] })).status).toBe(400);
    expect((await reqAs(s.base, "alice@corp.com", "DELETE", "/api/access")).status).toBe(404);
  });

  it("cascade delete needs the type-to-confirm token", async () => {
    const s = await scoped();
    expect((await reqAs(s.base, "alice@corp.com", "DELETE", "/api/nodes/protocol/foundation?cascade=1")).status).toBe(400);
    expect((await reqAs(s.base, "alice@corp.com", "DELETE", "/api/nodes/protocol/foundation?cascade=1&confirm=protocol/foundation")).status).toBe(200);
  });

  it("overview lists user workspaces with their review status", async () => {
    const s = await scoped();
    await reqAs(s.base, "bob@corp.com", "POST", "/api/topics", body(["protocol", "foundation"], "bob-x")); // clones bob's ws
    const overview = await reqAs<{ mode: string; workspaces: { workspace: string; reviewStatus: string }[] }>(s.base, "alice@corp.com", "GET", "/api/admin/overview");
    expect(overview.json.mode).toBe("multi");
    expect(overview.json.workspaces.map((w) => w.workspace)).toContain("bob-corp-com");
    expect(overview.json.workspaces.find((w) => w.workspace === "bob-corp-com")?.reviewStatus).toBe("none");
  });
});
