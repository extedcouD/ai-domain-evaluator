/**
 * Reducing a JSON Schema to the subset every grammar backend can actually compile.
 *
 * This is vendor-neutral on purpose: both provider adapters send a schema to some constrained-decoding
 * backend (OpenAI `response_format`, vLLM `structured_outputs`, Anthropic tool `input_schema`), and
 * every one of them disagrees about JSON Schema by *rejecting* keywords it doesn't know. So the reducer
 * lives in core and both adapters call it. Keeping it here also keeps the SDKs out: sanitizing a schema
 * is our logic, not the SDK's.
 */
import type { JsonSchema } from "../runtime/types";

/**
 * The `format` values the strictest common backend (vLLM's xgrammar pre-filter) will accept.
 * Source: has_xgrammar_unsupported_json_features(), vllm/v1/structured_output/backend_xgrammar.py
 */
const ALLOWED_FORMATS = new Set([
  "email",
  "date",
  "time",
  "date-time",
  "duration",
  "ipv4",
  "ipv6",
  "hostname",
  "uuid",
  "uri",
  "uri-reference",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
]);

/** Keywords the strictest backend rejects outright. */
const UNSUPPORTED_KEYWORDS = new Set([
  "multipleOf",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "patternProperties",
  "propertyNames",
]);

/** Keys whose value is itself a schema. */
const SCHEMA_VALUED = new Set([
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
]);

/** Keys whose value is an array of schemas. */
const SCHEMA_ARRAY_VALUED = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Keys whose value is a map of name -> schema. The *names* are user data, not keywords. */
const SCHEMA_MAP_VALUED = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce a JSON Schema to the subset every grammar backend can compile.
 *
 * Backends disagree about JSON Schema, and they disagree by *rejecting* — xgrammar 400s on a
 * `format` it doesn't know, GBNF quietly ignores keywords, Outlines is stricter still. Rather than
 * branch per backend, we emit the intersection: what the strictest one accepts is accepted
 * everywhere. Zod 4 will happily produce `format: "nanoid"`, `"emoji"`, `"cuid"` — none of which
 * survive here.
 *
 * Constraints dropped here are not enforced *during decoding*. Validate them with the Zod schema
 * after the call — which is the point of Zod being the single source of truth, and the reason the
 * repair loop must run even when the grammar IS live. Often nothing is lost: `z.nanoid()` emits both
 * a `format` and a `pattern`, and only the `format` is stripped.
 *
 * Note this walks *schema positions* rather than deleting keys by name: a schema may legitimately
 * contain a property literally called "contains" or "format", and those must survive.
 */
export function sanitizeSchema(schema: JsonSchema): JsonSchema {
  return sanitizeNode(schema) as JsonSchema;
}

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeNode);
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;

    // Harmless to most servers, but it's noise on the wire and some validators choke on it.
    if (key === "$schema") continue;

    if (key === "format" && typeof value === "string" && !ALLOWED_FORMATS.has(value)) {
      continue;
    }

    if (SCHEMA_MAP_VALUED.has(key) && isPlainObject(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        mapped[name] = sanitizeNode(sub);
      }
      out[key] = mapped;
      continue;
    }

    if (SCHEMA_ARRAY_VALUED.has(key) && Array.isArray(value)) {
      out[key] = value.map(sanitizeNode);
      continue;
    }

    if (SCHEMA_VALUED.has(key)) {
      out[key] = isPlainObject(value) ? sanitizeNode(value) : value;
      continue;
    }

    // `type`, `required`, `enum`, `const`, `minimum`, `pattern`, ... — leave alone.
    out[key] = value;
  }

  return out;
}
