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
      if (url.endsWith("/api/conversations/c1/messages")) return streamHandler(url, init);
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
});
