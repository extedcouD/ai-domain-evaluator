/**
 * Actor resolution — who a request is, for commit attribution and (Phase 3) authorization.
 *
 * We deliberately do NOT build authentication into the server. An SSO reverse proxy (oauth2-proxy /
 * Authelia) terminates login and injects the user's identity as a trusted header; the server reads it.
 * The trust boundary is `trustProxy`: the header is honored ONLY when it's on, so the node port must
 * never be reachable except through the proxy. When it's off (local dev / single-user), every request is
 * one placeholder actor (or `KB_DEV_ACTOR`) — exactly the Phase 0 behavior.
 */
import type { IncomingMessage } from "node:http";

import type { Actor } from "./git-store";

export type { Actor };

/** The single placeholder identity used when no proxy identity is trusted (dev / single-user). */
export const DEFAULT_ACTOR: Actor = { name: "KB Studio", email: "studio@localhost" };

export interface ActorResolverOptions {
  /** Honor the identity header. When false, always return the dev/default actor. */
  trustProxy: boolean;
  /** Header carrying the user's email (default `x-forwarded-email`, overridable via KB_IDENTITY_HEADER). */
  emailHeader?: string;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Parse `KB_DEV_ACTOR` ("Name <email>" or "email") into an Actor, or undefined when unset. */
function devActor(): Actor | undefined {
  const raw = process.env["KB_DEV_ACTOR"]?.trim();
  if (!raw) return undefined;
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: (m[1] ?? "").trim() || m[2] || raw, email: m[2] ?? raw };
  return { name: raw.split("@")[0] || raw, email: raw };
}

/**
 * Build a `(req) => Actor` resolver. Reads the trusted email header (and `x-forwarded-user` for a display
 * name) when `trustProxy`; otherwise returns a fixed dev/default actor. Never throws — a missing header
 * under `trustProxy` falls back rather than failing the request (the proxy is the real gate).
 */
export function makeActorResolver(opts: ActorResolverOptions): (req: IncomingMessage) => Actor {
  const emailHeader = opts.emailHeader ?? process.env["KB_IDENTITY_HEADER"] ?? "x-forwarded-email";
  const fallback = devActor() ?? DEFAULT_ACTOR;
  return (req) => {
    if (!opts.trustProxy) return fallback;
    const email = headerValue(req, emailHeader)?.trim();
    if (!email) return fallback;
    const name = headerValue(req, "x-forwarded-user")?.trim() || email.split("@")[0] || email;
    return { name, email };
  };
}
