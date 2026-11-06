import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat/c1",
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
  size_bytes: 2e9,
  context_length: 131072,
  capabilities: ["completion"],
  available: true,
  chat: true,
  last_synced_at: "",
};

function attachment(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: null,
    filename: "notes.txt",
    kind: "text",
    mime_type: "text/plain",
    size_bytes: 120,
    status,
    error: null,
    char_count: 20,
    page_count: null,
    meta: {},
    created_at: "",
    ...extra,
  };
}

/** Stand-in for XMLHttpRequest uploads: records requests and answers with `uploadResponse`. */
let uploadResponse: { status: number; body: unknown } = { status: 201, body: attachment("att1", "pending") };
const uploads: { url: string; headers: Record<string, string>; form: FormData }[] = [];
class FakeXHR {
  status = 0;
  responseText = "";
  withCredentials = false;
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  private headers: Record<string, string> = {};
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  abort() {
    this.onabort?.();
  }
  send(form: FormData) {
    uploads.push({ url: this.url, headers: this.headers, form });
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
      this.status = uploadResponse.status;
      this.responseText = JSON.stringify(uploadResponse.body);
      this.onload?.();
    }, 5);
  }
}

let attachmentStatus = "ready";
const calls: { url: string; init: RequestInit }[] = [];

function sse(events: [string, unknown][]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const [e, d] of events) c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
      c.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function msg(id: string, role: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: "c1",
    parent_id: null,
    role,
    content,
    status: "complete",
    model_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    error: null,
    finish_reason: null,
    created_at: "2026-11-06T10:00:00Z",
    ...extra,
  };
}

let detail: unknown;

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/api/health") return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      if (path === "/api/session") return Response.json({ csrf_token: "tok", created_at: "", expires_at: "" });
      if (path === "/api/models")
        return Response.json({
          models: [MODEL],
          providers: [{ name: "ollama", status: "ok", message: null, model_count: 1 }],
        });
      if (path === "/api/settings") return Response.json({ network_access_enabled: false, default_model: null });
      if (path === "/api/attachments/att1")
        return Response.json(
          attachment(
            "att1",
            attachmentStatus,
            attachmentStatus === "failed" ? { error: "This PDF is password-protected." } : {},
          ),
        );
      if (path === "/api/attachments/att1/text")
        return Response.json({
          id: "att1",
          offset: 0,
          text: "Extracted notes body",
          total_chars: 20,
          truncated: false,
        });
      if (path === "/api/conversations/c1/messages")
        return sse([
          [
            "start",
            {
              conversation: {},
              user_message: msg("u1", "user", "summarise"),
              assistant_message: msg("a1", "assistant", "", { status: "streaming" }),
              history_messages_dropped: 0,
              documents: {
                mode: "full",
                files: [{ id: "att1", filename: "notes.txt", excerpts: null, total_excerpts: 1, image_visible: null }],
              },
            },
          ],
          ["done", { message: msg("a1", "assistant", "Summary."), finish_reason: "stop", total_duration_ms: 1 }],
        ]);
      if (path === "/api/conversations/c1") return Response.json(detail);
      return new Response(null, { status: 404 });
    }),
  );
}

function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatView conversationId="c1" />
    </QueryClientProvider>,
  );
}

describe("attachments in the composer", () => {
  beforeEach(() => {
    calls.length = 0;
    uploads.length = 0;
    attachmentStatus = "ready";
    uploadResponse = { status: 201, body: attachment("att1", "pending") };
    detail = { id: "c1", title: "Files", model_id: MODEL.id, messages: [] };
    resetSession();
    _resetChatStore();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    stubFetch();
  });
  afterEach(() => {
    _resetChatStore();
    vi.unstubAllGlobals();
  });

  it("uploads, waits for processing and sends the attachment id", async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByPlaceholderText("Message Clawde…");
    await user.upload(screen.getByTestId("file-input"), new File(["hello"], "notes.txt", { type: "text/plain" }));

    expect(uploads).toHaveLength(1);
    expect(uploads[0].headers["X-CSRF-Token"]).toBe("tok");
    expect((uploads[0].form.get("file") as File).name).toBe("notes.txt");
    expect(uploads[0].form.get("conversation_id")).toBe("c1");

    const files = screen.getByLabelText("Files to send");
    await waitFor(() => expect(within(files).getByText(/ready/)).toBeInTheDocument(), { timeout: 3000 });

    await user.type(screen.getByPlaceholderText("Message Clawde…"), "summarise{Enter}");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/messages"))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/messages"))!.init.body as string);
    expect(body.attachment_ids).toEqual(["att1"]);
    // Sent files leave the composer.
    await waitFor(() => expect(screen.queryByLabelText("Files to send")).not.toBeInTheDocument());
  });

  it("shows why a file was rejected and blocks sending until it's removed", async () => {
    const user = userEvent.setup();
    uploadResponse = {
      status: 415,
      body: { detail: { code: "unsupported_file", message: "This file looks like a program, not a document." } },
    };
    renderChat();
    await screen.findByPlaceholderText("Message Clawde…");
    await user.upload(screen.getByTestId("file-input"), new File(["MZ"], "tool.pdf"));
    expect(await screen.findByText("This file looks like a program, not a document.")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Message Clawde…"), "hi{Enter}");
    expect(await screen.findByText(/Remove the files that couldn't be attached/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/messages"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Remove tool.pdf" }));
    expect(screen.queryByText("tool.pdf")).not.toBeInTheDocument();
  });

  it("reports files that fail during processing", async () => {
    const user = userEvent.setup();
    attachmentStatus = "failed";
    renderChat();
    await screen.findByPlaceholderText("Message Clawde…");
    await user.upload(screen.getByTestId("file-input"), new File(["%PDF"], "locked.pdf"));
    expect(await screen.findByText("This PDF is password-protected.", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("warns that a text-only model can't see images", async () => {
    const user = userEvent.setup();
    uploadResponse = { status: 201, body: attachment("att1", "pending", { kind: "image", filename: "chart.png" }) };
    renderChat();
    await screen.findByPlaceholderText("Message Clawde…");
    await user.upload(screen.getByTestId("file-input"), new File(["png"], "chart.png", { type: "image/png" }));
    expect(await screen.findByText(/can't see images/)).toBeInTheDocument();
  });

  it("shows attachments on sent messages and previews their text", async () => {
    const user = userEvent.setup();
    detail = {
      id: "c1",
      title: "Files",
      model_id: MODEL.id,
      messages: [
        msg("u1", "user", "summarise", {
          attachments: [
            {
              id: "att1",
              filename: "notes.txt",
              kind: "text",
              size_bytes: 120,
              status: "ready",
              page_count: null,
              meta: {},
            },
          ],
        }),
        msg("a1", "assistant", "Summary."),
      ],
    };
    renderChat();
    const chips = await screen.findByLabelText("Attached files");
    await user.click(within(chips).getByRole("button", { name: "Preview notes.txt" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Extracted notes body")).toBeInTheDocument();
  });
});
