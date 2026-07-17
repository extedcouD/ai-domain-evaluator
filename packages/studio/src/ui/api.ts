/**
 * A tiny typed `fetch` wrapper over the Studio's JSON API. Every call reads the body once, and a
 * non-2xx response throws an `Error` carrying the server's `{ error }` message (falling back to the
 * status text) plus the numeric `status`, so callers can distinguish a 422 (invalid folder) from a
 * 404 (missing topic). This is the ONLY place the UI talks to the network; components dispatch actions
 * with the results.
 */

export interface ApiError extends Error {
  status: number;
  /** The parsed response body, so callers can read structured detail (e.g. a 409's `current` topic). */
  body: unknown;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };

  const res = await fetch(path, init);
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof (data).error === "string"
        ? (data as { error: string }).error
        : res.statusText || `HTTP ${String(res.status)}`;
    const err = new Error(message) as ApiError;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

export const get = <T>(path: string): Promise<T> => request<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}): Promise<T> => request<T>("POST", path, body);
export const put = <T>(path: string, body: unknown = {}): Promise<T> => request<T>("PUT", path, body);
export const del = <T>(path: string): Promise<T> => request<T>("DELETE", path);

/** Join taxonomy path segments (and an optional trailing id) into an API ref, each URL-encoded. */
export function encodeRef(...segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}
