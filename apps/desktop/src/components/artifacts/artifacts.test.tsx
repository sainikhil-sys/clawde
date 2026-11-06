import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/artifacts",
}));

import { MessageList, type MessageActions } from "@/components/chat/message-list";
import { resetSession, type ChatMessage } from "@/lib/api";

import { ArtifactViewer } from "./artifact-viewer";
import { ArtifactsIndex } from "./artifacts-index";

const ART = {
  id: "a1",
  identifier: "page",
  title: "Landing page",
  kind: "html",
  language: null,
  conversation_id: "c1",
  current_version: 2,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  version_count: 2,
  conversation_title: "Website",
  content: "<h1>v2</h1>",
};
const VERSIONS = [
  { version: 1, source: "model", message_id: "m1", note: "", created_at: "2026-11-01T10:00:00Z", chars: 11 },
  { version: 2, source: "user", message_id: null, note: "", created_at: "2026-11-02T10:00:00Z", chars: 11 },
];

let artifacts: unknown[] = [];
const calls: { path: string; method: string; body: unknown }[] = [];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      calls.push({ path: u.pathname, method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      if (u.pathname === "/api/health")
        return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      if (u.pathname === "/api/session") return Response.json({ csrf_token: "tok", created_at: "", expires_at: "" });
      if (u.pathname === "/api/settings")
        return Response.json({
          network_access_enabled: false,
          default_model: null,
          memory_enabled: true,
          memory_auto_summarise: true,
          artifacts_enabled: true,
        });
      if (u.pathname === "/api/artifacts" && method === "POST")
        return Response.json({ ...ART, id: "new1", current_version: 1, version_count: 1 }, { status: 201 });
      if (u.pathname === "/api/artifacts") return Response.json(artifacts);
      if (u.pathname === "/api/artifacts/a1") return Response.json(ART);
      if (u.pathname === "/api/artifacts/a1/versions") return Response.json(VERSIONS);
      if (u.pathname === "/api/artifacts/a1/versions/1")
        return Response.json({ ...VERSIONS[0], content: "<h1>v1</h1>" });
      if (u.pathname === "/api/artifacts/a1/versions/2")
        return Response.json({ ...VERSIONS[1], content: "<h1>v2</h1>" });
      if (u.pathname === "/api/artifacts/a1/versions/1/restore")
        return Response.json({
          artifact: { ...ART, current_version: 3, version_count: 3, content: "<h1>v1</h1>" },
          changed: true,
        });
      return new Response(null, { status: 404 });
    }),
  );
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("artifacts", () => {
  beforeEach(() => {
    calls.length = 0;
    artifacts = [];
    push.mockClear();
    resetSession();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("previews in a sandboxed iframe on the sandbox origin, never same-origin", async () => {
    renderWith(<ArtifactViewer artifactId="a1" />);
    const frame = await screen.findByTestId("artifact-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("http://localhost:3901/runtime.html");
    expect(screen.getByRole("region", { name: "Artifact: Landing page" })).toHaveTextContent("version 2 of 2");
  });

  it("shows history, compares versions and restores an old one", async () => {
    const user = userEvent.setup();
    renderWith(<ArtifactViewer artifactId="a1" />);
    await user.click(await screen.findByRole("tab", { name: "History" }));
    const list = await screen.findByRole("list", { name: "Versions" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Version 2current");
    expect(items[0]).toHaveTextContent("Edited by you");
    expect(items[1]).toHaveTextContent("Written by the model");

    await user.click(within(items[0]).getByRole("button", { name: "Changes" }));
    const diff = await screen.findByLabelText("Changes");
    expect(diff).toHaveTextContent("+1 line, −1 line");
    expect(diff).toHaveTextContent("<h1>v1</h1>");
    await user.click(screen.getByRole("button", { name: "Back" }));

    await user.click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/artifacts/a1/versions/1/restore")).toBe(true),
    );
  });

  it("lists artifacts and creates one with a starter", async () => {
    artifacts = [ART];
    const user = userEvent.setup();
    renderWith(<ArtifactsIndex />);
    const link = await screen.findByRole("link", { name: /Landing page/ });
    expect(link).toHaveAttribute("href", "/artifacts/a1");
    expect(link).toHaveTextContent("HTML · 2 versions");
    expect(link).toHaveTextContent("From “Website”");

    await user.click(screen.getByRole("button", { name: "New artifact" }));
    await user.type(screen.getByLabelText("Title"), "Diagram");
    await user.selectOptions(screen.getByLabelText("Type"), "mermaid");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/artifacts/new1"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      kind: "mermaid",
      title: "Diagram",
      content: "graph TD\n  A[Start] --> B[Finish]\n",
    });
  });

  it("replaces artifact blocks in replies with cards that open the artifact", async () => {
    const user = userEvent.setup();
    const onOpenArtifact = vi.fn();
    const onCodeToArtifact = vi.fn();
    const actions: MessageActions = {
      onEdit: vi.fn(),
      onRegenerate: vi.fn(),
      onContinue: vi.fn(),
      onSelectSibling: vi.fn(),
      onOpenAttachment: vi.fn(),
      onOpenArtifact,
      onCodeToArtifact,
    };
    const reply: ChatMessage = {
      id: "m2",
      conversation_id: "c1",
      parent_id: "m1",
      role: "assistant",
      content:
        'Here is the page.\n<artifact identifier="page" type="html" title="Landing page">\n<h1>v1</h1>\n</artifact>\n\n```python\nprint(1)\n```',
      status: "complete",
      model_id: "ollama:llama3.2",
      prompt_tokens: 1,
      completion_tokens: 1,
      error: null,
      finish_reason: "stop",
      created_at: "2026-11-01T10:00:00Z",
      artifacts: [{ id: "a1", identifier: "page", title: "Landing page", kind: "html", version: 1 }],
    };
    renderWith(<MessageList messages={[reply]} busy={false} actions={actions} />);
    expect(screen.queryByText(/<h1>v1<\/h1>/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open artifact Landing page" }));
    expect(onOpenArtifact).toHaveBeenCalledWith(reply.artifacts![0]);
    expect(screen.getByRole("button", { name: "Open artifact Landing page" })).toHaveTextContent("HTML · version 1");

    await user.click(screen.getByRole("button", { name: "Open as artifact" }));
    expect(onCodeToArtifact).toHaveBeenCalledWith(reply, "python", "print(1)");
  });
});
