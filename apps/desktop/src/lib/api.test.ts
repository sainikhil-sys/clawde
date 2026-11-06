import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, apiRequest, ApiUnreachableError, resetSession } from "./api";

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

const session = { csrf_token: "csrf-1", created_at: "", expires_at: "" };

describe("api client", () => {
  beforeEach(() => resetSession());
  afterEach(() => vi.unstubAllGlobals());

  it("targets the API on the page's hostname with credentials", async () => {
    const calls = mockFetch(() => jsonResponse(200, { status: "ok", version: "0.1.0", database: { status: "ok" } }));
    await api.health();
    expect(calls[0].url).toBe(`http://${window.location.hostname}:8000/api/health`);
    expect(calls[0].init.credentials).toBe("include");
  });

  it("creates a session on 401, then sends the CSRF token on mutations", async () => {
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/api/session") && (init.method ?? "GET") === "GET") return jsonResponse(401, {});
      if (url.endsWith("/api/session") && init.method === "POST") return jsonResponse(201, session);
      return jsonResponse(200, { ok: true });
    });
    await apiRequest("/api/settings", { method: "PATCH", body: { default_model: "x" } });
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect((patch.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-1");
    expect(patch.init.body).toBe(JSON.stringify({ default_model: "x" }));
  });

  it("shares one session request between concurrent calls", async () => {
    const calls = mockFetch((url) =>
      url.endsWith("/api/session") ? jsonResponse(200, session) : jsonResponse(200, {}),
    );
    await Promise.all([apiRequest("/api/a"), apiRequest("/api/b"), apiRequest("/api/c")]);
    expect(calls.filter((c) => c.url.endsWith("/api/session"))).toHaveLength(1);
  });

  it("recovers once from an expired session", async () => {
    let settingsCalls = 0;
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/api/session")) {
        return jsonResponse(200, { ...session, csrf_token: init.method === "POST" ? "csrf-2" : "csrf-1" });
      }
      settingsCalls += 1;
      if (settingsCalls === 1) return jsonResponse(401, { detail: { code: "session_expired", message: "x" } });
      return jsonResponse(200, { recovered: true });
    });
    await expect(apiRequest("/api/settings")).resolves.toEqual({ recovered: true });
    expect(calls.filter((c) => c.url.endsWith("/api/settings"))).toHaveLength(2);
  });

  it("surfaces structured API errors", async () => {
    mockFetch((url) =>
      url.endsWith("/api/session")
        ? jsonResponse(200, session)
        : jsonResponse(413, { detail: { code: "body_too_large", message: "Too big" } }),
    );
    const err = await apiRequest("/api/x", { method: "POST", body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 413, code: "body_too_large", message: "Too big" });
  });

  it("reports an unreachable API distinctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.health()).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
