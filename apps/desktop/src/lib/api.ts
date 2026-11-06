/**
 * Client for the local Clawde API. Handles the browser session and CSRF token transparently:
 * the first authenticated call creates (or recovers) a session, and mutations send X-CSRF-Token.
 */

export const API_PORT = 8000;

/** Same hostname as the page so the SameSite=Strict session cookie is sent (127.0.0.1 vs localhost matter). */
export function apiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_CLAWDE_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof window === "undefined") return `http://127.0.0.1:${API_PORT}`;
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The API could not be reached at all (not running, wrong port, blocked). */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super("The local API is not reachable.", { cause });
    this.name = "ApiUnreachableError";
  }
}

type ErrorBody = { detail?: { code?: string; message?: string } | string | unknown[] };

async function toApiError(resp: Response): Promise<ApiError> {
  let code = `http_${resp.status}`;
  let message = resp.statusText || "Request failed";
  try {
    const body = (await resp.json()) as ErrorBody;
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) {
      code = "validation_error";
      message = "The request was not valid.";
    } else if (body.detail && typeof body.detail === "object") {
      code = body.detail.code ?? code;
      message = body.detail.message ?? message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(resp.status, code, message);
}

async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${apiBase()}${path}`, { ...init, credentials: "include", cache: "no-store" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiUnreachableError(err);
  }
}

let csrfToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

type SessionInfo = { csrf_token: string; created_at: string; expires_at: string };

/** Returns a CSRF token, creating a session if needed. Concurrent callers share one request. */
export function ensureSession(): Promise<string> {
  if (csrfToken) return Promise.resolve(csrfToken);
  sessionPromise ??= (async () => {
    try {
      let resp = await rawFetch("/api/session");
      if (resp.status === 401) resp = await rawFetch("/api/session", { method: "POST" });
      if (!resp.ok) throw await toApiError(resp);
      const info = (await resp.json()) as SessionInfo;
      csrfToken = info.csrf_token;
      return info.csrf_token;
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

/** For tests and logout. */
export function resetSession(): void {
  csrfToken = null;
  sessionPromise = null;
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean };

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const auth = opts.auth ?? true;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && method !== "GET") headers["X-CSRF-Token"] = await ensureSession();
    else if (auth) await ensureSession();
    return rawFetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  };

  let resp = await send();
  // Session expired or was revoked (e.g. API data reset): start a fresh one and retry once.
  if (auth && (resp.status === 401 || (resp.status === 403 && method !== "GET"))) {
    const err = await toApiError(resp.clone());
    if (["no_session", "session_expired", "csrf_failed"].includes(err.code)) {
      resetSession();
      resp = await send();
    }
  }
  if (!resp.ok) throw await toApiError(resp);
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

// ---- Typed endpoints ----

export type Health = {
  status: "ok" | "degraded";
  version: string;
  database: { status: "ok" | "error"; revision: string | null; head_revision: string | null };
};

export type AuditEvent = {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
};

export type AuditPage = { events: AuditEvent[]; next_before_id: number | null };

export const api = {
  health: (signal?: AbortSignal) => apiRequest<Health>("/api/health", { auth: false, signal }),
  audit: (params: { limit?: number; beforeId?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.beforeId) q.set("before_id", String(params.beforeId));
    const qs = q.toString();
    return apiRequest<AuditPage>(`/api/audit${qs ? `?${qs}` : ""}`, { signal });
  },
};
