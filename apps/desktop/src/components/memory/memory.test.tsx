import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/memory",
}));

import { resetSession } from "@/lib/api";

import { MemoryUsed } from "./memory-used";
import { MemoryView } from "./memory-view";

const PREF = {
  id: "m1",
  kind: "preference",
  title: "",
  content: "Prefers metric units.",
  importance: 4,
  pinned: false,
  project_id: null,
  conversation_id: null,
  source: "user",
  meta: {},
  expires_at: null,
  embedding_model: null,
  use_count: 2,
  last_used_at: "2026-11-05T10:00:00Z",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  project_name: null,
  conversation_title: null,
};
const PROJECT_NOTE = {
  ...PREF,
  id: "m2",
  kind: "project",
  content: "The greenhouse is locked on Sundays.",
  project_id: "p1",
  project_name: "Garden",
  use_count: 0,
  last_used_at: null,
};

let memories: unknown[] = [];
let settings = {
  network_access_enabled: false,
  default_model: null,
  memory_enabled: true,
  memory_auto_summarise: true,
};
const calls: { url: string; method: string; body: unknown }[] = [];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: u.pathname + u.search, method, body });
      if (u.pathname === "/api/health")
        return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      if (u.pathname === "/api/session") return Response.json({ csrf_token: "tok", created_at: "", expires_at: "" });
      if (u.pathname === "/api/settings" && method === "PATCH") {
        settings = { ...settings, ...body };
        return Response.json(settings);
      }
      if (u.pathname === "/api/settings") return Response.json(settings);
      if (u.pathname === "/api/projects") return Response.json([]);
      if (u.pathname === "/api/memories/stats")
        return Response.json({
          counts: { preference: 1, summary: 0, project: 1, knowledge: 0, temporary: 0 },
          total: memories.length,
          embedding_model: null,
        });
      if (u.pathname === "/api/memories/preview")
        return Response.json({
          candidates: 2,
          semantic: false,
          tokens: 30,
          skipped_for_budget: 0,
          chosen: [
            {
              id: "m1",
              kind: "preference",
              title: "",
              passage: 0,
              text: "Prefers metric units.",
              relevance: 0,
              importance: 0.75,
              recency: 0.9,
              score: 0.32,
              pinned: false,
              always: true,
            },
          ],
          others: [],
        });
      if (u.pathname === "/api/memories" && method === "POST")
        return Response.json({ ...PREF, id: "m9", ...body }, { status: 201 });
      if (u.pathname === "/api/memories") return Response.json(memories);
      if (u.pathname === "/api/memories/m1" && method === "DELETE") return new Response(null, { status: 204 });
      if (u.pathname === "/api/memories/m1") return Response.json(PREF);
      if (u.pathname === "/api/memories/gone")
        return Response.json({ detail: { code: "memory_not_found", message: "Memory not found." } }, { status: 404 });
      return new Response(null, { status: 404 });
    }),
  );
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("memory", () => {
  beforeEach(() => {
    calls.length = 0;
    memories = [];
    settings = {
      network_access_enabled: false,
      default_model: null,
      memory_enabled: true,
      memory_auto_summarise: true,
    };
    resetSession();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("explains memory when empty and creates a preference", async () => {
    const user = userEvent.setup();
    renderWith(<MemoryView />);
    expect(await screen.findByText("Nothing saved yet")).toBeInTheDocument();
    expect(screen.getByText(/Matching by keywords/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New memory" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Memory"), "I live in Oslo.");
    await user.selectOptions(within(dialog).getByLabelText("Importance"), "5");
    await user.click(within(dialog).getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/memories")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      kind: "preference",
      title: "",
      content: "I live in Oslo.",
      importance: 5,
      pinned: false,
    });
  });

  it("lists memories with their kind, scope and use, and deletes after confirmation", async () => {
    memories = [PREF, PROJECT_NOTE];
    const user = userEvent.setup();
    renderWith(<MemoryView />);
    const list = await screen.findByRole("list", { name: "Memories" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Preference");
    expect(items[0]).toHaveTextContent("used 2×");
    expect(items[1]).toHaveTextContent("Project: Garden");
    expect(within(items[1]).getByRole("link", { name: "Garden" })).toHaveAttribute("href", "/projects/p1");
    expect(items[1]).toHaveTextContent("not used yet");

    await user.click(within(items[0]).getByRole("button", { name: "Delete memory" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("will never be recalled again");
    await user.click(within(confirm).getByRole("button", { name: "Delete memory" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/memories/m1")).toBe(true));
  });

  it("switches memory off from the page", async () => {
    const user = userEvent.setup();
    renderWith(<MemoryView />);
    const toggle = await screen.findByRole("checkbox", { name: /Use memory in chats/ });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ memory_enabled: false }));
  });

  it("shows what a message would recall, with the score breakdown", async () => {
    const user = userEvent.setup();
    renderWith(<MemoryView />);
    await user.type(await screen.findByLabelText("Message to test"), "how far is it");
    await user.click(screen.getByRole("button", { name: "Test" }));
    const result = await screen.findByLabelText("Recall result");
    expect(result).toHaveTextContent("1 passage would be recalled out of 2 memories in scope");
    expect(within(result).getByRole("table")).toHaveTextContent("always included");
    expect(within(result).getByRole("table")).toHaveTextContent("0.32");
    expect(calls.find((c) => c.url === "/api/memories/preview")?.body).toEqual({ query: "how far is it" });
  });

  it("lists the memories a reply used, including deleted ones", async () => {
    const user = userEvent.setup();
    renderWith(<MemoryUsed ids={["m1", "gone"]} />);
    await user.click(screen.getByRole("button", { name: "Used 2 saved memories" }));
    expect(await screen.findByText("Prefers metric units.")).toBeInTheDocument();
    expect(screen.getByText("A memory that has since been deleted")).toBeInTheDocument();
  });
});
