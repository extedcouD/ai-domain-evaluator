import { describe, expect, it } from "vitest";

import { ConfigError, parseManifest, topicKey, type Topic } from "@evaluator/core";

const topic: Topic = {
  id: "a",
  path: ["retail", "1.2.0"],
  title: "A",
  questions: ["What is A?"],
  kind: "real",
};

const valid = {
  id: "kb",
  version: "1",
  subject: "the ONDC protocol specifications",
  levels: ["domain", "version"],
  topics: [topic],
};

describe("parseManifest", () => {
  it("accepts a valid manifest and preserves the subject (domain-as-data)", () => {
    const m = parseManifest(valid);
    expect(m.subject).toBe("the ONDC protocol specifications");
    expect(m.topics[0]?.kind).toBe("real");
  });

  it("treats subject as optional — core stays domain-neutral without one", () => {
    const noSubject = { id: "kb", version: "1", topics: [topic] };
    expect(parseManifest(noSubject).subject).toBeUndefined();
  });

  it("rejects an empty topic set", () => {
    expect(() => parseManifest({ ...valid, topics: [] })).toThrow(ConfigError);
  });

  it("rejects an uppercase path segment but allows dots so a version is a legal segment", () => {
    expect(() => parseManifest({ ...valid, topics: [{ ...topic, path: ["Retail"] }] })).toThrow(ConfigError);
    expect(() => parseManifest({ ...valid, topics: [{ ...topic, path: ["1.2.0"] }] })).not.toThrow();
  });
});

describe("topicKey", () => {
  it("joins full path + id so two same-id topics under different paths never collide", () => {
    expect(topicKey({ path: ["retail", "1.2.0", "search"], id: "x" })).toBe("retail/1.2.0/search/x");
    expect(topicKey({ path: ["protocol"], id: "x" })).toBe("protocol/x");
  });
});
