/**
 * The KB folder convention — one topic per file under `kb/topics/<seg…>/<id>.yaml`, plus
 * `kb/manifest.meta.yaml` holding `{ id, version, subject?, levels? }` — merged into one validated
 * `Manifest`.
 *
 * This is a FRONT-END module: it reads the filesystem and parses YAML, which core deliberately does
 * NOT do (`parseManifest` takes an already-parsed object). It is imported by both the CLI
 * (`--coverage kb`) and the Studio server, via the `@evaluator/studio/manifest-folder` export subpath
 * — importing the subpath boots nothing, so the CLI does not drag the server (or a listening port) in.
 *
 * The folder IS the source of truth; `kb/manifest.yaml` is a generated snapshot (`renderManifestYaml`).
 * A topic's RAGGED `path` mirrors the folder chain from `topics/` down to the file. Two invariants are
 * asserted on read — the file's `path` deep-equals its folder chain, and `basename === id` — so a
 * hand-edit or a moved file is caught loudly. Depth is unbounded and ragged.
 *
 * `subject` — the domain the KB is about — rides in `manifest.meta.yaml` and flows straight through
 * `assembleManifest` into the `Manifest`; core turns it into the `SubjectProfile`.
 *
 * Ground truth stays OUT of here: a topic is `id/path/title/questions/kind` and nothing else. A future
 * correctness layer attaches as a sibling `kb/truth/<id>` keyed by the same id — not a field here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { ConfigError, parseManifest, type Manifest, type Topic } from "@evaluator/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * A safe taxonomy-path SEGMENT: lowercase alnum, dots (for versions like `1.2.0`), and dashes. It
 * cannot be `.`/`..` (must start with an alnum) and has no slash — a safe single path component. This
 * MUST stay byte-identical to core's `SEGMENT_RE`, or the reader and the engine disagree on a segment
 * like `1.2.0`. A topic id/basename is stricter (no dots — the one dot is the `.yaml`).
 */
export const SEGMENT_RE = /^[a-z0-9][a-z0-9.-]*$/;
export const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The parsed `manifest.meta.yaml` object (`{ id, version, subject?, levels? }`), or `{}` if absent. */
export function readMetaObject(dir: string): Record<string, unknown> {
  const p = join(dir, "manifest.meta.yaml");
  if (!existsSync(p)) return {};
  const raw = parseYaml(readFileSync(p, "utf8")) as unknown;
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** The taxonomy level LABELS declared in `meta.levels`, validated as non-empty strings. Display only. */
export function declaredLevels(meta: Record<string, unknown>): string[] {
  const raw = meta["levels"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`manifest.meta.yaml "levels" must be a list of level labels.`);
  return raw.map((l) => {
    if (typeof l !== "string" || l.trim() === "") {
      throw new ConfigError(`Invalid level label "${String(l)}" in manifest.meta.yaml. Expected a non-empty string.`);
    }
    return l;
  });
}

/**
 * Every taxonomy NODE (a directory under `topics/`, at any depth), with whether it directly holds
 * topics. Empty nodes surface (so you can create a subtree before filling it), in deterministic DFS
 * order over sorted segments. Never throws on an empty KB. Unsafe/hidden directory names (failing
 * `SEGMENT_RE`) are skipped.
 */
export function listNodes(dir: string): { path: string[]; hasTopics: boolean }[] {
  const root = join(dir, "topics");
  const out: { path: string[]; hasTopics: boolean }[] = [];
  const walk = (prefix: string[]): void => {
    const here = join(root, ...prefix);
    if (!existsSync(here)) return;
    for (const ent of readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory() || !SEGMENT_RE.test(ent.name)) continue;
      const path = [...prefix, ent.name];
      const childDir = join(root, ...path);
      out.push({ path, hasTopics: readdirSync(childDir).some((f) => f.endsWith(".yaml")) });
      walk(path);
    }
  };
  walk([]);
  return out;
}

/**
 * Pure: shape a meta object + a list of topic objects into a validated `Manifest`. No filesystem.
 * Delegates to core's `parseManifest` (the single Zod gate), so a folder can never produce a manifest
 * the engine would reject. Unknown meta keys are stripped by Zod.
 */
export function assembleManifest(meta: unknown, topics: unknown[]): Manifest {
  const metaObj = meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  return parseManifest({ ...metaObj, topics });
}

/** Validate a single already-parsed topic object, reusing `parseManifest`. Throws `ConfigError`. */
export function parseTopic(raw: unknown): Topic {
  const first = parseManifest({ id: "_", version: "_", topics: [raw] }).topics[0];
  if (first === undefined) throw new ConfigError("Invalid topic: nothing to parse.");
  return first;
}

/**
 * The safe on-disk path of one topic file. Rejects an UNSAFE path segment or id (traversal, slashes,
 * bad dots) BEFORE building the path, so a crafted value like `../../etc/passwd` cannot escape the
 * topics directory. It validates the *shape* only — any safe segment chain is a legal path.
 */
export function topicPath(dir: string, path: string[], id: string): string {
  if (path.length === 0) throw new ConfigError("A topic path must have at least one segment.");
  for (const seg of path) {
    if (!SEGMENT_RE.test(seg)) throw new ConfigError(`Unsafe path segment "${seg}". Expected ${String(SEGMENT_RE)}.`);
  }
  if (!TOPIC_ID_RE.test(id)) throw new ConfigError(`Unsafe topic id "${id}". Expected ${String(TOPIC_ID_RE)}.`);
  return join(dir, "topics", ...path, `${id}.yaml`);
}

/** Depth-first walk of `topics/`, collecting every `<seg…>/<id>.yaml` with its folder-derived path. */
function walkTopics(root: string, prefix: string[] = []): { path: string[]; id: string; file: string }[] {
  const here = join(root, ...prefix);
  const out: { path: string[]; id: string; file: string }[] = [];
  for (const ent of readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isDirectory()) {
      if (SEGMENT_RE.test(ent.name)) out.push(...walkTopics(root, [...prefix, ent.name])); // skip unsafe/hidden dirs
    } else if (ent.isFile() && ent.name.endsWith(".yaml")) {
      out.push({ path: prefix, id: basename(ent.name, ".yaml"), file: join(here, ent.name) });
    }
  }
  return out;
}

/**
 * Read `kb/manifest.meta.yaml` + every `kb/topics/<seg…>/*.yaml` into a validated `Manifest`, in a
 * deterministic order (by path then id) so the generated snapshot is stable to diff. Throws
 * `ConfigError` on a missing meta file, an empty topic set, a topic sitting directly under `topics/`,
 * or a folder/path or filename/id mismatch. This is the reader both `--coverage kb` and
 * `GET /api/manifest` go through.
 */
export function readManifestDir(dir: string): Manifest {
  const metaPath = join(dir, "manifest.meta.yaml");
  if (!existsSync(metaPath)) {
    throw new ConfigError(`No manifest.meta.yaml in ${dir}. Expected ${metaPath} holding { id, version }.`);
  }
  const meta = readMetaObject(dir);
  const root = join(dir, "topics");
  const found = existsSync(root) ? walkTopics(root) : [];
  found.sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")) || a.id.localeCompare(b.id));

  const topics: unknown[] = [];
  for (const { path, id, file } of found) {
    if (path.length === 0) {
      throw new ConfigError(
        `Topic file ${file} sits directly under topics/ — every topic needs at least one path segment (a folder).`,
      );
    }
    const raw = parseYaml(readFileSync(file, "utf8")) as unknown;
    assertTopicFile(raw, path, id, file);
    topics.push(raw);
  }

  if (topics.length === 0) {
    throw new ConfigError(`No topic files found under ${root}/<seg…>/*.yaml.`);
  }

  return assembleManifest({ ...meta }, topics);
}

/** Serialize a `Manifest` back to the committed `kb/manifest.yaml`, with a do-not-edit banner. */
export function renderManifestYaml(m: Manifest): string {
  const banner =
    "# GENERATED FILE — do not edit by hand.\n" +
    "# Source of truth: kb/manifest.meta.yaml + kb/topics/<seg…>/<id>.yaml.\n" +
    "# Regenerate via KB Studio's Export button, or `evaluator --coverage kb` reads the folder directly.\n\n";
  return banner + stringifyYaml(m);
}

/**
 * The two folder invariants: the file's `id` must equal its basename, and its `path` must deep-equal
 * the folder chain it sits in. A mismatch means a hand-edit or a move silently changed what the
 * manifest says — caught here rather than shipped. Full schema validation (title, questions, kind) is
 * left to `parseManifest` in `assembleManifest`; this only guards the redundancy the folder introduces.
 */
function assertTopicFile(raw: unknown, expectedPath: string[], id: string, file: string): void {
  if (raw === null || typeof raw !== "object") {
    throw new ConfigError(`Topic file ${file} is not a YAML mapping.`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj["id"] !== id) {
    throw new ConfigError(`Topic id "${String(obj["id"])}" in ${file} does not match its filename (expected "${id}").`);
  }
  const p = obj["path"];
  const matches = Array.isArray(p) && p.length === expectedPath.length && p.every((seg, i) => seg === expectedPath[i]);
  if (!matches) {
    throw new ConfigError(
      `Topic path ${JSON.stringify(p)} in ${file} does not match its folder [${expectedPath.join("/")}].`,
    );
  }
}
