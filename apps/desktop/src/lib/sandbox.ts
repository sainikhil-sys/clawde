/**
 * The artifact sandbox: a separate local server (apps/sandbox) on its own port, so artifact code never runs on
 * the app's origin. The iframe also has `sandbox="allow-scripts"` without `allow-same-origin`, which gives the
 * document an opaque origin: no cookies, no storage shared with anything, and no access to this page.
 */

export const SANDBOX_PORT = 3901;
export const MESSAGE_PREFIX = "clawde-artifact:";

export function sandboxOrigin(): string {
  const fromEnv = process.env.NEXT_PUBLIC_CLAWDE_SANDBOX_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof window === "undefined") return `http://127.0.0.1:${SANDBOX_PORT}`;
  return `${window.location.protocol}//${window.location.hostname}:${SANDBOX_PORT}`;
}

export function runtimeUrl(): string {
  return `${sandboxOrigin()}/runtime.html`;
}

export type RuntimeMessage =
  { type: "ready" } | { type: "rendered" } | { type: "error"; message: string } | { type: "blocked"; what: string };

/**
 * Validate a message from the runtime. Anything unexpected is ignored: the artifact controls what it posts,
 * so only these shapes, with bounded string fields, are ever acted on.
 */
export function parseRuntimeMessage(data: unknown): RuntimeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.type !== "string" || !d.type.startsWith(MESSAGE_PREFIX)) return null;
  const type = d.type.slice(MESSAGE_PREFIX.length);
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : "");
  switch (type) {
    case "ready":
    case "rendered":
      return { type };
    case "error":
      return { type, message: text(d.message) || "Unknown error" };
    case "blocked":
      return { type, what: text(d.what) };
    default:
      return null;
  }
}
