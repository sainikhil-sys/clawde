import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects",
}));

import { resetSession } from "@/lib/api";

import { ProjectView } from "./project-view";
import { ProjectsIndex } from "./projects-index";

const PROJECT = {
  id: "p1",
  name: "Thesis",
  description: "PhD research",
  instructions: "Be rigorous.",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  archived_at: null,
  conversation_count: 1,
  knowledge_count: 1,
};

let projects: unknown[] = [];
const calls: { url: string; init: RequestInit }[] = [];
const xhrUploads: string[] = [];

class FakeXHR {
  status = 201;
  responseText = "{}";
  withCredentials = false;
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  abort() {}
  send() {
    xhrUploads.push(this.url);
    setTimeout(() => {
      this.responseText = JSON.stringify({ id: "k2", filename: "new.md", status: "pending" });
      this.onload?.();
    }, 1);
  }
}

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const u = new URL(url);
      const method = init.method ?? "GET";
      if (u.pathname === "/api/health")
        return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      if (u.pathname === "/api/session") return Response.json({ csrf_token: "tok", created_at: "", expires_at: "" });
      if (u.pathname === "/api/projects" && method === "POST")
        return Response.json({ ...PROJECT, id: "new1", name: "New one" }, { status: 201 });
      if (u.pathname === "/api/projects") return Response.json(projects);
      if (u.pathname === "/api/projects/p1" && method === "PATCH")
        return Response.json({ ...PROJECT, ...JSON.parse(init.body as string) });
      if (u.pathname === "/api/projects/p1" && method === "DELETE") return new Response(null, { status: 204 });
      if (u.pathname === "/api/projects/p1") return Response.json(PROJECT);
      if (u.pathname === "/api/projects/p1/knowledge")
        return Response.json([
          {
            id: "k1",
            filename: "outline.md",
            kind: "markdown",
            size_bytes: 2048,
            status: "ready",
            page_count: null,
            meta: {},
            error: null,
          },
        ]);
      if (u.pathname === "/api/conversations")
        return Response.json([
          { id: "c1", title: "Literature review", message_count: 4, updated_at: "2026-11-02T10:00:00Z" },
        ]);
      return new Response(null, { status: 404 });
    }),
  );
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("projects", () => {
  beforeEach(() => {
    calls.length = 0;
    xhrUploads.length = 0;
    push.mockClear();
    projects = [];
    resetSession();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("explains projects when there are none and creates one", async () => {
    const user = userEvent.setup();
    renderWith(<ProjectsIndex />);
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Name"), "New one");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/new1"));
    const post = calls.find((c) => c.init.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toMatchObject({ name: "New one" });
  });

  it("lists projects with counts", async () => {
    projects = [PROJECT];
    renderWith(<ProjectsIndex />);
    const card = await screen.findByRole("link", { name: /Thesis/ });
    expect(card).toHaveAttribute("href", "/projects/p1");
    expect(card).toHaveTextContent("1 chat · 1 file");
  });

  it("shows instructions, knowledge and chats, and saves instructions", async () => {
    const user = userEvent.setup();
    renderWith(<ProjectView projectId="p1" />);
    expect(await screen.findByRole("heading", { name: "Thesis" })).toBeInTheDocument();
    expect(await screen.findByText("outline.md")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Literature review/ })).toHaveAttribute("href", "/chat/c1");

    const box = screen.getByLabelText("Project instructions");
    expect(box).toHaveValue("Be rigorous.");
    await user.clear(box);
    await user.type(box, "Cite every source.");
    await user.click(screen.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const patch = calls.find((c) => c.init.method === "PATCH")!;
    expect(JSON.parse(patch.init.body as string)).toEqual({ instructions: "Cite every source." });
  });

  it("uploads knowledge to the project endpoint", async () => {
    const user = userEvent.setup();
    renderWith(<ProjectView projectId="p1" />);
    await screen.findByText("outline.md");
    await user.upload(screen.getByTestId("knowledge-input"), new File(["# notes"], "new.md"));
    await waitFor(() => expect(xhrUploads).toEqual(["http://localhost:8000/api/projects/p1/knowledge"]));
  });

  it("confirms before deleting and explains what is lost", async () => {
    const user = userEvent.setup();
    renderWith(<ProjectView projectId="p1" />);
    await screen.findByRole("heading", { name: "Thesis" });
    await user.click(screen.getByRole("button", { name: "Project options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete project" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("1 chat, 1 knowledge file and search index will be permanently deleted");
    await user.click(within(dialog).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects"));
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(true);
  });
});
