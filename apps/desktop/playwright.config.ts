/**
 * End-to-end tests against the real stack: production build of the web UI, the real API with a throwaway
 * data folder, and the local Ollama server. Ports 3100/8100 and a separate build folder keep it isolated
 * from a running development setup. Uses the Microsoft Edge (or Chrome) already installed on the machine,
 * so no browser download is needed.
 *
 *   pnpm --filter desktop e2e
 */
import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WEB_PORT = 3100;
const API_PORT = 8100;
const repoRoot = path.resolve(__dirname, "../..");
const dataDir = process.env.CLAWDE_E2E_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "clawde-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel: process.env.CLAWDE_E2E_BROWSER ?? "msedge",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "uv run clawde-api serve",
      cwd: repoRoot,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        CLAWDE_DATA_DIR: dataDir,
        CLAWDE_PORT: String(API_PORT),
        CLAWDE_ALLOWED_ORIGINS: JSON.stringify([`http://127.0.0.1:${WEB_PORT}`]),
        CLAWDE_LOG_TO_FILE: "false",
      },
    },
    {
      command: `pnpm exec next build && pnpm exec next start -H 127.0.0.1 -p ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 300_000,
      reuseExistingServer: false,
      env: {
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_CLAWDE_API_URL: `http://127.0.0.1:${API_PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
