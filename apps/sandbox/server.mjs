// Static server for the artifact runtime. It runs on its own origin (a different port from the app), so even
// if an artifact escaped the iframe sandbox it would not share the app's origin, storage or API.
//
// Security properties:
// - Loopback only (refuses other hosts unless CLAWDE_SANDBOX_ALLOW_REMOTE_BIND=1).
// - GET/HEAD only; only files inside dist/ with known extensions; no directory listings.
// - The runtime page gets a CSP with connect-src 'none' (no fetch/XHR/WebSocket), no external scripts, styles,
//   images, fonts or frames, no form submission, and frame-ancestors limited to the Clawde web UI.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function runtimeCsp(frameAncestors) {
  return [
    "default-src 'none'",
    // 'unsafe-inline' and 'unsafe-eval' are needed to run artifact code (inline scripts, Babel for JSX). That is
    // acceptable only because the page is isolated: opaque origin, no network, no access to the app.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors.join(" ")}`,
  ].join("; ");
}

export function createSandboxServer({ frameAncestors }) {
  const csp = runtimeCsp(frameAncestors);
  return createServer((req, res) => {
    const common = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // The runtime has an opaque origin, so its own script requests are cross-origin.
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...common, Allow: "GET, HEAD" }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://sandbox").pathname);
    } catch {
      res.writeHead(400, common).end();
      return;
    }
    if (pathname === "/" || pathname === "/runtime") pathname = "/runtime.html";
    const file = path.resolve(ROOT, `.${pathname}`);
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(ROOT + path.sep) || !type || pathname.includes("\0")) {
      res.writeHead(404, common).end();
      return;
    }
    let size;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch {
      res.writeHead(404, common).end();
      return;
    }
    const headers = {
      ...common,
      "Content-Type": type,
      "Content-Length": size,
      "Cache-Control": pathname.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache",
    };
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = csp;
    else headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.CLAWDE_SANDBOX_HOST ?? "127.0.0.1";
  const port = Number(process.env.CLAWDE_SANDBOX_PORT ?? 3901);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!loopback && process.env.CLAWDE_SANDBOX_ALLOW_REMOTE_BIND !== "1") {
    console.error(`Refusing to bind the sandbox to ${host}. It must stay on loopback.`);
    process.exit(1);
  }
  const frameAncestors = (process.env.CLAWDE_SANDBOX_FRAME_ANCESTORS ?? "http://127.0.0.1:3000 http://localhost:3000")
    .split(/\s+/)
    .filter(Boolean);
  createSandboxServer({ frameAncestors }).listen(port, host, () => {
    console.log(`sandbox: serving artifact runtime at http://${host}:${port}/runtime.html`);
  });
}
