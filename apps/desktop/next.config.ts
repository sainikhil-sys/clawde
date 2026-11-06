import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

function loopbackOrigins(envUrl: string | undefined, port: number): string[] {
  if (envUrl) return [new URL(envUrl).origin];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

const apiOrigins = loopbackOrigins(process.env.NEXT_PUBLIC_CLAWDE_API_URL, 8000).join(" ");
const sandboxOrigins = loopbackOrigins(process.env.NEXT_PUBLIC_CLAWDE_SANDBOX_URL, 3901).join(" ");

/**
 * Content-Security-Policy for the app itself. The app talks only to itself and the local API, and frames only
 * the artifact sandbox. Inline scripts are allowed because pages are prerendered (partial prerendering), so a
 * per-request nonce isn't available; the main defences against untrusted content are elsewhere: model output
 * is rendered as Markdown without raw HTML, and artifact code only ever runs in the sandbox origin.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${apiOrigins}`,
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigins}${isDev ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
  `frame-src ${sandboxOrigins}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  // A separate build folder lets end-to-end tests build without disturbing a running `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // Keep the dev-only indicator away from the sidebar's bottom-left controls.
  devIndicators: { position: "bottom-right" },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
