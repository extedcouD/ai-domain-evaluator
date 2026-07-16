import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ConfigError } from "@evaluator/core";
import { readManifestDir, SEGMENT_RE } from "../src/manifest-folder";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Build a throwaway KB folder from a compact description and return its path. */
function makeKb(meta: string, topics: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kb-"));
  dirs.push(root);
  writeFileSync(join(root, "manifest.meta.yaml"), meta);
  for (const [rel, body] of Object.entries(topics)) {
    const file = join(root, "topics", rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  }
  return root;
}

const META = "id: demo-kb\nversion: 0.1.0\nsubject: the ONDC protocol specifications\nlevels: [domain, version, usecase]\n";

const searchTopic = [
  "id: on-search",
  "path: [retail, 1.2.0, search]",
  "title: Search flow",
  "kind: real",
  "questions:",
  "  - What is the search flow?",
].join("\n");

describe("readManifestDir", () => {
  it("merges a folder KB into a validated manifest, carrying the subject and the ragged path", () => {
    const kb = makeKb(META, { "retail/1.2.0/search/on-search.yaml": searchTopic });
    const manifest = readManifestDir(kb);

    expect(manifest.id).toBe("demo-kb");
    expect(manifest.subject).toBe("the ONDC protocol specifications");
    expect(manifest.topics[0]?.path).toEqual(["retail", "1.2.0", "search"]);
    expect(manifest.topics[0]?.id).toBe("on-search");
  });

  it("catches a filename that does not match the topic id inside it", () => {
    const kb = makeKb(META, { "retail/1.2.0/search/WRONG.yaml": searchTopic });
    expect(() => readManifestDir(kb)).toThrow(ConfigError);
  });

  it("catches a path field that does not match the folder chain", () => {
    const lying = searchTopic.replace("path: [retail, 1.2.0, search]", "path: [retail, 1.2.0, select]");
    const kb = makeKb(META, { "retail/1.2.0/search/on-search.yaml": lying });
    expect(() => readManifestDir(kb)).toThrow(/does not match its folder/);
  });

  it("throws when the meta file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-"));
    dirs.push(root);
    expect(() => readManifestDir(root)).toThrow(ConfigError);
  });
});

describe("SEGMENT_RE", () => {
  it("is the exact pattern core uses, so a version segment like 1.2.0 is legal in both", () => {
    // Byte-identical to core's manifest.ts SEGMENT_RE — the reader and the engine must agree.
    expect(SEGMENT_RE.source).toBe("^[a-z0-9][a-z0-9.-]*$");
    expect(SEGMENT_RE.test("1.2.0")).toBe(true);
    expect(SEGMENT_RE.test("Retail")).toBe(false);
  });
});
