import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiStatusPanel } from "./api-status";

function renderWithQuery() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ApiStatusPanel />
    </QueryClientProvider>,
  );
}

describe("ApiStatusPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows connected state and version from /api/health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "ok",
          version: "0.1.0",
          database: { status: "ok", revision: "0001_initial", head_revision: "0001_initial" },
        }),
      ),
    );
    renderWithQuery();
    expect(await screen.findByText("Local API connected")).toBeInTheDocument();
    expect(screen.getAllByText(/0\.1\.0/).length).toBeGreaterThan(0);
  });

  it("explains how to start the API when it is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderWithQuery();
    expect(await screen.findByText("Local API not running")).toBeInTheDocument();
    expect(screen.getByText("pnpm dev:api")).toBeInTheDocument();
  });

  it("flags a database migration mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "degraded",
          version: "0.1.0",
          database: { status: "error", revision: null, head_revision: "0001_initial" },
        }),
      ),
    );
    renderWithQuery();
    expect(await screen.findByText("Local API has a database problem")).toBeInTheDocument();
    expect(screen.getByText(/expected 0001_initial/)).toBeInTheDocument();
  });
});
