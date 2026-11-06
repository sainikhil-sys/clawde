import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

import { resetSession } from "@/lib/api";
import { _resetChatStore } from "@/lib/chat-store";

import { ChatView } from "./chat-view";

const MODEL = {
  id: "ollama:llama3.2:latest",
  provider: "ollama",
  provider_ref: "llama3.2:latest",
  display_name: "llama3.2:latest",
  family: "llama",
  parameter_size: "3.2B",
  quantization: "Q4_K_M",
  format: "gguf",
  size_bytes: 2_000_000_000,
  context_length: 131072,
  capabilities: ["completion"],
  available: true,
  chat: true,
  last_synced_at: "",
};

function msg(id: string, role: string, content: string, status = "complete") {
  return {
    id,
    conversation_id: "c1",
    parent_id: null,
    role,
    content,
    status,
    model_id: role === "assistant" ? MODEL.id : null,
    prompt_tokens: null,
    completion_tokens: role === "assistant" ? 3 : null,
    error: null,
    created_at: "2026-11-06T10:00:00Z",
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function sseResponse(events: [string, unknown][], hold?: Promise<void>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [i, [event, data]] of events.entries()) {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        if (hold && i === 1) await hold;
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

let models: { models: unknown[]; providers: unknown[] };
let conversationDetail: unknown;
let streamHandler: Handler;
let branchDetail: unknown = null;
const calls: { url: string; init: RequestInit }[] = [];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (url.endsWith("/api/health"))
        return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      if (url.endsWith("/api/session")) return Response.json({ csrf_token: "t", created_at: "", expires_at: "" });
      if (url.endsWith("/api/models")) return Response.json(models);
      if (url.endsWith("/api/settings")) return Response.json({ network_access_enabled: false, default_model: null });
      if (url.endsWith("/api/conversations") && method === "POST") {
        return Response.json({ id: "c1", title: "New conversation", model_id: MODEL.id }, { status: 201 });
      }
      if (url.endsWith("/api/conversations")) return Response.json([]);
      if (/\/api\/conversations\/c1\/(messages|regenerate|continue)$/.test(url)) return streamHandler(url, init);
      if (url.endsWith("/api/conversations/c1/branch")) return Response.json(branchDetail ?? conversationDetail);
      if (url.endsWith("/api/conversations/c1")) return Response.json(conversationDetail);
      return new Response(null, { status: 404 });
    }),
  );
}

function renderChat(id: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatView conversationId={id} />
    </QueryClientProvider>,
  );
}

describe("ChatView", () => {
  beforeEach(() => {
    calls.length = 0;
    push.mockClear();
    resetSession();
    _resetChatStore();
    models = { models: [MODEL], providers: [{ name: "ollama", status: "ok", message: null, model_count: 1 }] };
    conversationDetail = { id: "c1", title: "Hi", model_id: MODEL.id, messages: [] };
    branchDetail = null;
    stub();
  });
  afterEach(() => {
    _resetChatStore();
    vi.unstubAllGlobals();
  });

  it("creates a conversation on first send, streams the reply and navigates to it", async () => {
    const user = userEvent.setup();
    streamHandler = () =>
      sseResponse([
        [
          "start",
          {
            conversation: {},
            user_message: msg("u1", "user", "Hi"),
            assistant_message: msg("a1", "assistant", "", "streaming"),
            history_messages_dropped: 0,
          },
        ],
        ["token", { text: "Hel" }],
        ["token", { text: "lo!" }],
        ["done", { message: msg("a1", "assistant", "Hello!"), finish_reason: "stop", total_duration_ms: 10 }],
      ]);
    conversationDetail = {
      id: "c1",
      title: "Hi",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "Hi"), msg("a1", "assistant", "Hello!")],
    };

    renderChat(null);
    const box = await screen.findByPlaceholderText("Message Clawde…");
    await user.type(box, "Hi{Enter}");

    await waitFor(() => expect(push).toHaveBeenCalledWith("/chat/c1"));
    const send = calls.find((c) => c.url.endsWith("/messages"))!;
    expect(JSON.parse(send.init.body as string)).toMatchObject({ content: "Hi", model_id: MODEL.id });
    expect((send.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("t");
  });

  it("shows streamed text and lets the user stop", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let aborted = false;
    streamHandler = (_url, init) => {
      init.signal?.addEventListener("abort", () => (aborted = true));
      return sseResponse(
        [
          [
            "start",
            {
              conversation: {},
              user_message: msg("u1", "user", "Tell me"),
              assistant_message: msg("a1", "assistant", "", "streaming"),
              history_messages_dropped: 0,
            },
          ],
          ["token", { text: "Once upon" }],
          ["token", { text: " a time" }],
        ],
        hold,
      );
    };
    renderChat("c1");
    const box = await screen.findByPlaceholderText("Message Clawde…");
    await user.type(box, "Tell me{Enter}");

    expect(await screen.findByText("Once upon")).toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop generating" });
    conversationDetail = {
      id: "c1",
      title: "Tell me",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "Tell me"), msg("a1", "assistant", "Once upon", "cancelled")],
    };
    await user.click(stop);
    expect(aborted).toBe(true);
    await act(async () => release());
    expect(await screen.findByText(/Stopped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("explains when no chat models are installed", async () => {
    models = { models: [], providers: [{ name: "ollama", status: "ok", message: null, model_count: 0 }] };
    renderChat(null);
    expect(await screen.findByText(/No chat models are installed/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("No chat models installed")).toBeInTheDocument();
  });

  it("explains when Ollama is not running", async () => {
    models = {
      models: [],
      providers: [{ name: "ollama", status: "unavailable", message: "Ollama is not reachable.", model_count: 0 }],
    };
    renderChat(null);
    expect(await screen.findByText(/Ollama is not reachable. Start the Ollama app/)).toBeInTheDocument();
  });

  it("restores the draft when the server rejects the message", async () => {
    const user = userEvent.setup();
    streamHandler = () =>
      Response.json({ detail: { code: "model_unavailable", message: "Model is not available." } }, { status: 400 });
    renderChat("c1");
    const box = await screen.findByPlaceholderText("Message Clawde…");
    await user.type(box, "keep me{Enter}");
    expect(await screen.findByText("Model is not available.")).toBeInTheDocument();
    expect(box).toHaveValue("keep me");
  });

  it("renders saved messages of an existing conversation", async () => {
    conversationDetail = {
      id: "c1",
      title: "Old",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "question"), msg("a1", "assistant", "answer")],
    };
    renderChat("c1");
    expect(await screen.findByText("answer")).toBeInTheDocument();
    expect(screen.getByText("question")).toBeInTheDocument();
    expect(screen.getByText(/3 tokens/)).toBeInTheDocument();
  });

  it("edits a message as a new version and sends edit_of", async () => {
    const user = userEvent.setup();
    conversationDetail = {
      id: "c1",
      title: "Old",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "first draft"), msg("a1", "assistant", "answer")],
    };
    streamHandler = () =>
      sseResponse([
        [
          "start",
          {
            conversation: {},
            user_message: msg("u2", "user", "second draft"),
            assistant_message: msg("a2", "assistant", "", "streaming"),
            history_messages_dropped: 0,
          },
        ],
        ["token", { text: "better answer" }],
        ["done", { message: msg("a2", "assistant", "better answer"), finish_reason: "stop", total_duration_ms: 1 }],
      ]);
    renderChat("c1");
    await screen.findByText("first draft");
    await user.click(screen.getByRole("button", { name: "Edit message" }));
    const box = screen.getByLabelText("Edit message");
    await user.clear(box);
    await user.type(box, "second draft");
    await user.click(screen.getByRole("button", { name: "Send edit" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/messages"))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/messages"))!.init.body as string);
    expect(body).toMatchObject({ content: "second draft", edit_of: "u1" });
  });

  it("regenerates a reply via the regenerate endpoint", async () => {
    const user = userEvent.setup();
    conversationDetail = {
      id: "c1",
      title: "Old",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "q"), msg("a1", "assistant", "first answer")],
    };
    streamHandler = () =>
      sseResponse([
        [
          "start",
          {
            conversation: {},
            user_message: null,
            assistant_message: msg("a2", "assistant", "", "streaming"),
            history_messages_dropped: 0,
          },
        ],
        ["done", { message: msg("a2", "assistant", "second answer"), finish_reason: "stop", total_duration_ms: 1 }],
      ]);
    renderChat("c1");
    await screen.findByText("first answer");
    await user.click(screen.getByRole("button", { name: "Regenerate reply" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/regenerate"))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/regenerate"))!.init.body as string);
    expect(body).toMatchObject({ message_id: "a1", model_id: MODEL.id });
  });

  it("switches between versions of a reply", async () => {
    const user = userEvent.setup();
    const a1 = { ...msg("a1", "assistant", "version one"), sibling_ids: ["a1", "a2"] };
    const a2 = { ...msg("a2", "assistant", "version two"), sibling_ids: ["a1", "a2"] };
    conversationDetail = { id: "c1", title: "Old", model_id: MODEL.id, messages: [msg("u1", "user", "q"), a2] };
    branchDetail = { id: "c1", title: "Old", model_id: MODEL.id, messages: [msg("u1", "user", "q"), a1] };
    renderChat("c1");
    expect(await screen.findByText("version two")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous version" }));
    expect(await screen.findByText("version one")).toBeInTheDocument();
    const put = calls.find((c) => c.url.endsWith("/branch"))!;
    expect(put.init.method).toBe("PUT");
    expect(JSON.parse(put.init.body as string)).toEqual({ message_id: "a1" });
  });

  it("offers Continue on a stopped reply", async () => {
    conversationDetail = {
      id: "c1",
      title: "Old",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "q"), msg("a1", "assistant", "half an ans", "cancelled")],
    };
    renderChat("c1");
    expect(await screen.findByRole("button", { name: /Continue/ })).toBeInTheDocument();
  });

  it("renders assistant replies as Markdown", async () => {
    conversationDetail = {
      id: "c1",
      title: "Old",
      model_id: MODEL.id,
      messages: [msg("u1", "user", "q"), msg("a1", "assistant", "**important** and `code`")],
    };
    const { container } = renderChat("c1");
    await screen.findByText("important");
    expect(container.querySelector("strong")?.textContent).toBe("important");
  });
});
