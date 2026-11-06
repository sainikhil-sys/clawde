"use client";

import { AlertTriangle, RotateCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ArtifactKind } from "@/lib/api";
import { MESSAGE_PREFIX, parseRuntimeMessage, runtimeUrl } from "@/lib/sandbox";
import { cn } from "@/lib/utils";

type Status = "loading" | "rendered" | "error" | "unreachable";

/**
 * Live preview of an artifact in the isolated sandbox.
 *
 * Each render loads a fresh runtime document (no state carries over between versions). The runtime announces
 * `ready`, we send the source once, and it reports `rendered`, errors, or things the CSP blocked.
 */
export function ArtifactFrame({
  kind,
  source,
  theme,
  className,
}: {
  kind: Exclude<ArtifactKind, "code">;
  source: string;
  theme: "light" | "dark";
  className?: string;
}) {
  const [nonce, setNonce] = useState(0);
  // A fresh runtime document (and fresh status) whenever what we render changes.
  const key = `${nonce}:${kind}:${theme}:${source.length}:${hash(source)}`;
  return (
    <FrameRun
      key={key}
      kind={kind}
      source={source}
      theme={theme}
      className={className}
      onRetry={() => setNonce((n) => n + 1)}
    />
  );
}

function FrameRun({
  kind,
  source,
  theme,
  className,
  onRetry,
}: {
  kind: Exclude<ArtifactKind, "code">;
  source: string;
  theme: "light" | "dark";
  className?: string;
  onRetry: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errors, setErrors] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const sent = useRef(false);

  useEffect(() => {
    // The sandbox server may not be running: say so instead of showing a blank box forever.
    const timer = window.setTimeout(() => {
      setStatus((s) => (s === "loading" && !sent.current ? "unreachable" : s));
    }, 8000);

    function onMessage(event: MessageEvent) {
      const win = frame.current?.contentWindow;
      // Only the iframe we created, whose document has an opaque origin ("null").
      if (!win || event.source !== win || event.origin !== "null") return;
      const msg = parseRuntimeMessage(event.data);
      if (!msg) return;
      if (msg.type === "ready" && !sent.current) {
        sent.current = true;
        win.postMessage({ type: `${MESSAGE_PREFIX}render`, kind, source, theme }, "*");
      } else if (msg.type === "rendered") {
        setStatus((s) => (s === "error" ? s : "rendered"));
      } else if (msg.type === "error") {
        setStatus("error");
        setErrors((e) => (e.length >= 20 ? e : [...e, msg.message]));
      } else if (msg.type === "blocked") {
        setBlocked((b) => (b.includes(msg.what) || b.length >= 20 ? b : [...b, msg.what]));
      }
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [kind, source, theme]);

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <iframe
        ref={frame}
        src={runtimeUrl()}
        title="Artifact preview"
        // allow-scripts only: no allow-same-origin (opaque origin), no forms, popups, top navigation, downloads
        // or modals.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        className="min-h-0 w-full flex-1 border-0 bg-white"
        data-testid="artifact-frame"
      />
      {status === "unreachable" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center text-sm">
          <AlertTriangle className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">The preview sandbox isn&apos;t running</p>
          <p className="max-w-sm text-muted-foreground">
            Start it with <code className="rounded bg-muted px-1">pnpm dev:sandbox</code>. Previews run there, on a
            separate origin, so artifact code never runs inside this app.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 hover:bg-accent"
          >
            <RotateCw className="size-3.5" /> Try again
          </button>
        </div>
      )}
      {(errors.length > 0 || blocked.length > 0) && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-t bg-background px-3 py-2 text-xs" role="status">
          {errors.map((e, i) => (
            <p key={`e${i}`} className="flex gap-1.5 text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="font-mono break-all">{e}</span>
            </p>
          ))}
          {blocked.length > 0 && (
            <p className="flex gap-1.5 text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Blocked by the sandbox (artifacts run offline):{" "}
                <span className="font-mono break-all">{blocked.join(", ")}</span>
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}
