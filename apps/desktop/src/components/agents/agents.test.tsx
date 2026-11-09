import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/agents",
}));

import { resetSession } from "@/lib/api";

import { AgentsIndex } from "./agents-index";
import { RunView } from "./run-view";

const TOOLS = [
  {
    name: "read_file",
    description: "Read",
    risk: "read",
    policy: "auto",
    allowed: ["auto", "ask", "deny"],
    needs_project: false,
  },
  {
    name: "write_file",
    description: "Write",
    risk: "write",
    policy: "ask",
    allowed: ["ask", "deny"],
    needs_project: false,
  },
  {
    name: "python",
    description: "Run",
    risk: "execute",
    policy: "ask",
    allowed: ["ask", "deny"],
    needs_project: false,
  },
];
const RUN = {
  id: "r1",
  task: "Save the answer",
  status: "waiting_approval",
  model_id: "ollama:llama3.2:latest",
  project_id: null,
  plan: ["Compute", "Save"],
  result: null,
  error: null,
  max_steps: 12,
  retry_of: null,
  created_at: "2026-11-07T10:00:00Z",
  updated_at: "2026-11-07T10:00:00Z",
  finished_at: null,
};
const STEP = {
  id: "s2",
  run_id: "r1",
  index: 2,
  kind: "tool",
  thought: "Save the result",
  tool: "write_file",
  risk: "write",
  args: { path: "result.txt", content: "42", mode: "overwrite" },
  status: "waiting_approval",
  approval: null,
  output: "",
  data: {},
  error: null,
  created_at: "2026-11-07T10:00:01Z",
  finished_at: null,
};
const CALC = {
  ...STEP,
  id: "s1",
  index: 1,
  tool: "calculator",
  risk: "compute",
  args: { expression: "6*7" },
  status: "done",
  approval: "auto",
  output: "6*7 = 42",
  thought: "Compute",
};

const calls: { path: string; method: string; body: unknown }[] = [];
let runs: unknown[] = [];

function sse(events: [string, unknown][]) {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

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
      if (u.pathname === "/api/settings") return Response.json({ default_model: "ollama:llama3.2:latest" });
      if (u.pathname === "/api/models")
        return Response.json({
          models: [{ id: "ollama:llama3.2:latest", chat: true, available: true, capabilities: ["completion"] }],
          providers: [],
        });
      if (u.pathname === "/api/projects") return Response.json([]);
      if (u.pathname === "/api/agents/tools") return Response.json(TOOLS);
      if (u.pathname === "/api/agents/permissions")
        return Response.json(TOOLS.map((t) => (t.name === "read_file" ? { ...t, policy: "deny" } : t)));
      if (u.pathname === "/api/agents/sandbox")
        return Response.json({
          docker: "not_running",
          image: "python:3.12-slim",
          detail: "Docker is installed but its engine isn't running.",
          fallback_limits: "timeout 30s, 512 MB memory, no child processes (Windows Job Object)",
          active_tier: "fallback",
          network_access_enabled: false,
        });
      if (u.pathname === "/api/agents/workspace") return Response.json([{ path: "result.txt", size: 2, modified: "" }]);
      if (u.pathname === "/api/agents/runs" && method === "POST")
        return Response.json({ ...RUN, id: "new1", steps: [] }, { status: 201 });
      if (u.pathname === "/api/agents/runs") return Response.json(runs);
      if (u.pathname === "/api/agents/runs/r1/events")
        return sse([
          ["snapshot", { ...RUN, steps: [{ ...CALC, kind: "plan", id: "s0", index: 0, tool: null }, CALC, STEP] }],
        ]);
      if (u.pathname === "/api/agents/runs/r1") return Response.json({ ...RUN, steps: [CALC, STEP] });
      if (u.pathname === "/api/agents/runs/r1/steps/s2/decision") return Response.json({ ok: true });
      return new Response(null, { status: 404 });
    }),
  );
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("agents", () => {
  beforeEach(() => {
    calls.length = 0;
    runs = [];
    push.mockClear();
    resetSession();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts a task and shows the safety settings honestly", async () => {
    const user = userEvent.setup();
    renderWith(<AgentsIndex />);
    expect(await screen.findByText("No agent runs yet")).toBeInTheDocument();
    // The fallback sandbox is labelled as reduced isolation.
    expect(await screen.findByText("Reduced isolation.")).toBeInTheDocument();
    expect(screen.getByText(/Docker is installed but its engine/)).toBeInTheDocument();

    // Writing files can't be set to run without asking.
    const writeSelect = await screen.findByLabelText("Permission for write_file");
    expect(within(writeSelect).queryByRole("option", { name: "Allow" })).not.toBeInTheDocument();
    expect(
      within(writeSelect)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Ask first", "Off"]);
    await user.selectOptions(screen.getByLabelText("Permission for read_file"), "deny");
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/agents/permissions")?.body).toEqual({
        tool_permissions: { read_file: "deny" },
      }),
    );

    await user.type(screen.getByLabelText("Task"), "Summarise notes.md");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start agent" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/agents/new1"));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/agents/runs")?.body).toEqual({
      task: "Summarise notes.md",
      model_id: "ollama:llama3.2:latest",
      max_steps: 12,
    });
    expect(screen.getByRole("list", { name: "Workspace files" })).toHaveTextContent("result.txt");
  });

  it("shows the plan, steps and an approval prompt, and sends the decision", async () => {
    const user = userEvent.setup();
    renderWith(<RunView runId="r1" />);
    expect(await screen.findByRole("heading", { name: "Save the answer" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("calculator");

    const prompt = screen.getByRole("alertdialog");
    expect(prompt).toHaveTextContent("The agent wants to write a file");
    expect(prompt).toHaveTextContent("result.txt");
    expect(prompt).toHaveTextContent("Nothing happens until you decide.");
    await user.type(within(prompt).getByLabelText("Note for the agent (optional)"), "ok");
    await user.click(within(prompt).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/decision"))?.body).toEqual({ approve: true, note: "ok" }),
    );
    // Active runs can be cancelled.
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeInTheDocument();
  });
});
