import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let pathname = "/projects";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

import { AppShell } from "./app-shell";

let conversations: unknown[] = [];

function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/health")) {
        return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      }
      if (url.endsWith("/api/session")) return Response.json({ csrf_token: "t", created_at: "", expires_at: "" });
      if (url.endsWith("/api/conversations")) return Response.json(conversations);
      return new Response(null, { status: 404 });
    }),
  );
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppShell>
        <p>page content</p>
      </AppShell>
    </QueryClientProvider>,
  );
}

function desktopSidebar() {
  return screen.getByRole("complementary", { name: "Sidebar" });
}

describe("AppShell", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    push.mockClear();
    pathname = "/projects";
    conversations = [];
    stubApi();
  });

  it("renders all main navigation entries and the page", () => {
    renderShell();
    const nav = within(desktopSidebar()).getByRole("navigation", { name: "Main" });
    for (const label of [
      "New chat",
      "Projects",
      "Artifacts",
      "Agents",
      "Research Studio",
      "Model Library",
      "Settings",
    ]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("button", { name: /Search/ })).toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("marks the current section with aria-current", () => {
    renderShell();
    const nav = within(desktopSidebar()).getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });

  it("collapses the sidebar from the button and from Ctrl+.", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(within(desktopSidebar()).getByRole("button", { name: "Collapse sidebar" }));
    expect(document.documentElement.dataset.sidebar).toBe("collapsed");
    expect(within(desktopSidebar()).getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.keyboard("{Control>}.{/Control}");
    expect(document.documentElement.dataset.sidebar).toBe("expanded");
  });

  it("opens search with Ctrl+K and navigates to the chosen section", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await user.type(within(dialog).getByRole("combobox"), "model");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/models");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument());
  });

  it("opens search from the sidebar Search item", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(within(desktopSidebar()).getByRole("button", { name: /Search/ }));
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
  });

  it("switches theme from the command palette", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await user.click(within(dialog).getByText("Use dark theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("clawde.theme")).toBe("dark");
  });

  it("shows an honest empty state for recents", async () => {
    renderShell();
    expect(await within(desktopSidebar()).findByText("No conversations yet.")).toBeInTheDocument();
  });

  it("lists recent conversations from the API and marks the open one", async () => {
    conversations = [
      { id: "a1", title: "Rust lifetimes", message_count: 2 },
      { id: "b2", title: "Trip plan", message_count: 4 },
    ];
    pathname = "/chat/b2";
    renderShell();
    const sidebar = desktopSidebar();
    const open = await within(sidebar).findByRole("link", { name: "Trip plan" });
    expect(open).toHaveAttribute("href", "/chat/b2");
    expect(open).toHaveAttribute("aria-current", "page");
    expect(within(sidebar).getByRole("link", { name: "Rust lifetimes" })).not.toHaveAttribute("aria-current");
  });

  it("opens the mobile navigation drawer", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("link", { name: "Model Library" })).toBeInTheDocument();
  });
});
