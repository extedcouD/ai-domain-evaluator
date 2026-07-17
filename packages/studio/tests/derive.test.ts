import { describe, expect, it } from "vitest";

import { suggestLevelLabels } from "../src/ui/derive";

describe("suggestLevelLabels", () => {
  it("sizes the label list to the DEEPEST folder path (ragged taxonomy)", () => {
    const labels = suggestLevelLabels([["retail", "1.2.0", "search"], ["protocol"]]);
    expect(labels).toHaveLength(3);
  });

  it("labels a depth whose segments are all version-like as 'version'", () => {
    const labels = suggestLevelLabels([
      ["retail", "1.2.0", "search"],
      ["retail", "1.1.0", "select"],
      ["logistics", "2.0.0", "track"],
    ]);
    expect(labels).toEqual(["domain", "version", "level 3"]);
  });

  it("names the first level 'domain' and others 'level N' when nothing version-like", () => {
    expect(suggestLevelLabels([["a", "b", "c"]])).toEqual(["domain", "level 2", "level 3"]);
  });

  it("treats v-prefixed and dashed segments (v2, 2024-01) as versions", () => {
    expect(suggestLevelLabels([["api", "v2"], ["api", "v3"]])).toEqual(["domain", "version"]);
    expect(suggestLevelLabels([["releases", "2024-01"], ["releases", "2024-02"]])).toEqual(["domain", "version"]);
  });

  it("does NOT call a mixed depth 'version' (only when EVERY segment matches)", () => {
    const labels = suggestLevelLabels([["retail", "1.2.0"], ["retail", "search"]]);
    expect(labels).toEqual(["domain", "level 2"]);
  });

  it("returns [] for an empty structure (nothing to auto-fill)", () => {
    expect(suggestLevelLabels([])).toEqual([]);
    expect(suggestLevelLabels([[]])).toEqual([]);
  });
});
