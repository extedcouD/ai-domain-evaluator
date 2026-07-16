/**
 * The coverage manifest — the version-controlled, inspectable answer to "what do we EXPECT the
 * source to cover, and how would we know if it is bluffing?"
 *
 * This is the piece that turns "I don't know what's in my sources or whether it's complete" into
 * something explicit and diffable. It is the reference the `coverage` probe measures a source
 * against: without a declared list of expected topics, "complete" is undefinable.
 *
 * Two kinds of topic live here, and the second is the load-bearing one:
 *   - `real`   — a genuine topic the source SHOULD be able to answer.
 *   - `canary` — a FABRICATED topic (a non-existent field, an invented enum value) the source should
 *                NOT be able to answer. It is the `zzz_canary` trick from `probeSchemaEnforcement`
 *                applied to knowledge: a well-grounded source abstains, and a confabulator answers it
 *                confidently — which tells you its confident answers to the REAL topics are worth
 *                nothing either.
 *
 * Purity: this module only PARSES an already-parsed object into a validated `Manifest`. It does not
 * read files and it does not parse YAML — the engine reads no filesystem (a front-end does that and
 * hands the parsed object in, exactly as `parseEnv` stays pure). Taking a string here would drag a
 * YAML parser into core, and YAML can produce `Date`s that break the `Json<T>` promise downstream.
 */
import { z } from "zod";

import { ConfigError } from "../../runtime/errors";

/**
 * A safe taxonomy-path SEGMENT: lowercase alphanumerics, dots, and dashes. Dots are allowed so a
 * version like `1.2.0` is a legal segment; it still cannot be `.` or `..` (a segment must START with
 * an alnum) and has no slash, so every segment is a safe single path component. Deliberately NOT an
 * enum of known segments — the taxonomy is DATA (folders are the source of truth), not a vocabulary
 * hardcoded here. This pattern MUST stay byte-identical to the folder module's `SEGMENT_RE`
 * (@evaluator/studio/manifest-folder), or the reader and the engine disagree on a segment like `1.2.0`.
 */
const SEGMENT_RE = /^[a-z0-9][a-z0-9.-]*$/;

const TopicSchema = z.object({
  /** Stable id, unique within its folder (the filesystem enforces that); the basename of its file. */
  id: z.string().min(1),
  /**
   * The topic's place in the taxonomy — an ordered, RAGGED path of arbitrary depth (`[domain]` or
   * `[domain, version, usecase]`). Mirrored by folders: `kb/topics/<seg…>/<id>.yaml`. Ragged means
   * different subtrees may be different depths; the only rule is each segment is a safe slug. There is
   * no fixed set of legal paths and no declared target — folders are the source of truth.
   */
  path: z.array(z.string().regex(SEGMENT_RE, "path segment must be lowercase alnum, dots, and dashes")).min(1),
  title: z.string().min(1),
  /**
   * The phrasings the probe will ask. At least two are recommended for `real` topics: the probe
   * checks self-consistency ACROSS phrasings (varying the prompt, not the sampler — temperature
   * defaults to 0 and `n` is silently ignored by common backends), and a topic answered one way and
   * refused another is itself a finding.
   */
  questions: z.array(z.string().min(1)).min(1),
  kind: z.enum(["real", "canary"]),
});

const ManifestSchema = z.object({
  id: z.string().min(1),
  /** Bump when the topic set changes, so a report names the manifest it was measured against. */
  version: z.string().min(1),
  /**
   * The subject the source is expected to be expert on, as a noun-phrase (e.g. "the ONDC protocol
   * specifications"). This is DOMAIN-AS-DATA: it is the ONLY place a KB names its domain, and a
   * front-end turns it into a `SubjectProfile` that supplies the source/judge/validator prompts.
   * Optional — core defaults to a neutral subject when a KB omits it.
   */
  subject: z.string().min(1).optional(),
  /**
   * The taxonomy's level LABELS — display names for each depth (e.g. `[domain, version, usecase]`),
   * purely for reporting and authoring. Optional, and NOT validated against a topic's actual depth: the
   * taxonomy is ragged, so a shorter path is legal even when more labels are declared. This is a name
   * for a level, never a constraint on what paths may exist — folders remain the source of truth.
   */
  levels: z.array(z.string().min(1)).optional(),
  topics: z.array(TopicSchema).min(1),
});

export type Topic = z.infer<typeof TopicSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * The stable cross-run correlation key for a topic: its full taxonomy path joined with its id. A bare
 * `id` is only unique WITHIN its folder, so across a deep taxonomy two `search` topics under different
 * paths would collide; this is what a coverage diff joins on. Pure — no I/O, no clock.
 */
export function topicKey(t: Pick<Topic, "path" | "id">): string {
  return [...t.path, t.id].join("/");
}

/**
 * Validate an already-parsed object into a `Manifest`. Throws `ConfigError` — a manifest is
 * configuration, and a half-valid one is worse than none. Mirrors `parseEnv`.
 */
export function parseManifest(raw: unknown): Manifest {
  const result = ManifestSchema.safeParse(raw);

  if (!result.success) {
    throw new ConfigError(
      `Invalid knowledge manifest:\n\n${z.prettifyError(result.error)}\n\n` +
        `A manifest needs an id, a version, and at least one topic; each topic needs an id, a ragged ` +
        `path, a title, at least one question, and kind "real" or "canary".`,
    );
  }

  return result.data;
}
