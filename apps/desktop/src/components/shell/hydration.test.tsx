/**
 * Regression test for a hydration mismatch: with partial prerendering, the sidebar hydrated first and
 * fetched API health, so the chat segment's first client render differed from its server HTML.
 * `useApiHealth` must report "pending" until hydration has finished.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

import { ApiStatusLine } from "@/components/status/api-status";

import { RecentConversations } from "./recent-conversations";

function Tree({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <ApiStatusLine />
      <RecentConversations pathname="/" />
    </QueryClientProvider>
  );
}

describe("hydration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("first client render matches the server even when health is already cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/health"))
          return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
        if (url.endsWith("/api/session")) return Response.json({ csrf_token: "t", created_at: "", expires_at: "" });
        if (new URL(url).pathname === "/api/conversations")
          return Response.json([{ id: "a", title: "Saved chat", message_count: 2 }]);
        return new Response(null, { status: 404 });
      }),
    );

    // Server: nothing fetched yet.
    const serverHtml = renderToString(<Tree client={new QueryClient()} />);
    expect(serverHtml).toContain("Checking local API");

    // Client: another part of the page already fetched health before this part hydrates.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["health"], { status: "ok", version: "0.1.0", database: { status: "ok" } });

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));

    await act(async () => {
      hydrateRoot(container, <Tree client={client} />, {
        onRecoverableError: (err) => errors.push(String(err)),
      });
    });
    spy.mockRestore();

    expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
    // After hydration the real state shows up.
    await vi.waitFor(() => expect(container.textContent).toContain("Local API connected"));
    await vi.waitFor(() => expect(container.textContent).toContain("Saved chat"));
    container.remove();
  });
});
