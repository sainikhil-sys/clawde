/**
 * Client for the local Clawde API. Handles the browser session and CSRF token transparently:
 * the first authenticated call creates (or recovers) a session, and mutations send X-CSRF-Token.
 */

import { parseSse } from "./sse";

export const API_PORT = 8000;

/** Same hostname as the page so the SameSite=Strict session cookie is sent (127.0.0.1 vs localhost matter). */
export function apiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_CLAWDE_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof window === "undefined") return `http://127.0.0.1:${API_PORT}`;
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The API could not be reached at all (not running, wrong port, blocked). */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super("The local API is not reachable.", { cause });
    this.name = "ApiUnreachableError";
  }
}

type ErrorBody = { detail?: { code?: string; message?: string } | string | unknown[] };

async function toApiError(resp: Response): Promise<ApiError> {
  let code = `http_${resp.status}`;
  let message = resp.statusText || "Request failed";
  try {
    const body = (await resp.json()) as ErrorBody;
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) {
      code = "validation_error";
      message = "The request was not valid.";
    } else if (body.detail && typeof body.detail === "object") {
      code = body.detail.code ?? code;
      message = body.detail.message ?? message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(resp.status, code, message);
}

async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${apiBase()}${path}`, { ...init, credentials: "include", cache: "no-store" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiUnreachableError(err);
  }
}

let csrfToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

type SessionInfo = { csrf_token: string; created_at: string; expires_at: string };

/** Returns a CSRF token, creating a session if needed. Concurrent callers share one request. */
export function ensureSession(): Promise<string> {
  if (csrfToken) return Promise.resolve(csrfToken);
  sessionPromise ??= (async () => {
    try {
      let resp = await rawFetch("/api/session");
      if (resp.status === 401) resp = await rawFetch("/api/session", { method: "POST" });
      if (!resp.ok) throw await toApiError(resp);
      const info = (await resp.json()) as SessionInfo;
      csrfToken = info.csrf_token;
      return info.csrf_token;
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

/** For tests and logout. */
export function resetSession(): void {
  csrfToken = null;
  sessionPromise = null;
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean };

/** Authenticated fetch with session/CSRF handling and one retry on an expired session. Throws on non-2xx. */
export async function apiFetch(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const auth = opts.auth ?? true;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && method !== "GET") headers["X-CSRF-Token"] = await ensureSession();
    else if (auth) await ensureSession();
    return rawFetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  };

  let resp = await send();
  // Session expired or was revoked (e.g. API data reset): start a fresh one and retry once.
  if (auth && (resp.status === 401 || (resp.status === 403 && method !== "GET"))) {
    const err = await toApiError(resp.clone());
    if (["no_session", "session_expired", "csrf_failed"].includes(err.code)) {
      resetSession();
      resp = await send();
    }
  }
  if (!resp.ok) throw await toApiError(resp);
  return resp;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const resp = await apiFetch(path, opts);
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

// ---- Typed endpoints ----

export type Health = {
  status: "ok" | "degraded";
  version: string;
  database: { status: "ok" | "error"; revision: string | null; head_revision: string | null };
};

export type AuditEvent = {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
};

export type AuditPage = { events: AuditEvent[]; next_before_id: number | null };

export type ModelInfo = {
  id: string;
  provider: string;
  provider_ref: string;
  display_name: string;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  format: string | null;
  size_bytes: number | null;
  context_length: number | null;
  capabilities: string[];
  available: boolean;
  chat: boolean;
  last_synced_at: string;
};

export type ProviderStatus = {
  name: string;
  status: "ok" | "unavailable" | "error";
  message: string | null;
  model_count: number;
};
export type ModelList = { models: ModelInfo[]; providers: ProviderStatus[] };

export type AppSettings = { network_access_enabled: boolean; default_model: string | null };

export type MessageStatus = "streaming" | "complete" | "error" | "cancelled";
export type ChatMessage = {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  status: MessageStatus;
  model_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  finish_reason: string | null;
  created_at: string;
  /** This message and its alternatives (edits / regenerations), oldest first. Present on detail reads. */
  sibling_ids?: string[];
  attachments?: AttachmentBrief[];
};

export type AttachmentKind = "pdf" | "docx" | "xlsx" | "csv" | "json" | "markdown" | "text" | "code" | "image";
export type AttachmentStatus = "pending" | "processing" | "ready" | "failed";
export type AttachmentBrief = {
  id: string;
  filename: string;
  kind: AttachmentKind;
  size_bytes: number;
  status: AttachmentStatus;
  page_count: number | null;
  meta: Record<string, unknown>;
};
export type Attachment = AttachmentBrief & {
  conversation_id: string | null;
  mime_type: string;
  error: string | null;
  char_count: number | null;
  created_at: string;
};
export type AttachmentText = { id: string; offset: number; text: string; total_chars: number; truncated: boolean };
export type DocumentUse = {
  mode: "none" | "full" | "excerpts";
  semantic?: boolean;
  files: {
    id: string;
    filename: string;
    excerpts: number | null;
    total_excerpts: number;
    image_visible: boolean | null;
  }[];
};

export type Conversation = {
  id: string;
  title: string;
  project_id: string | null;
  folder_id: string | null;
  pinned: boolean;
  archived: boolean;
  model_id: string | null;
  current_leaf_id?: string | null;
  created_at: string;
  updated_at: string;
};
export type ConversationSummary = Conversation & { message_count: number };
export type ConversationDetail = Conversation & { messages: ChatMessage[] };

export type GenerationParams = {
  temperature: number;
  top_p: number;
  max_tokens: number;
  context_length: number;
  response_format: "text" | "json";
};

export type Folder = { id: string; name: string; created_at: string; updated_at: string; conversation_count: number };
export type PromptTemplate = { id: string; name: string; content: string; created_at: string; updated_at: string };
export type SearchHit = {
  conversation: Conversation;
  match: "title" | "message";
  snippet: string;
  message_id: string | null;
};
export type ConversationFilter = {
  archived?: boolean;
  pinned?: boolean;
  folderId?: string;
  projectId?: string;
  limit?: number;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  conversation_count: number;
  knowledge_count: number;
};
export type ProjectPatch = Partial<Pick<Project, "name" | "description" | "instructions">> & { archived?: boolean };
export type ProjectHit = { kind: "conversation" | "knowledge"; id: string; title: string; snippet: string };
export type ConversationPatch = Partial<Pick<Conversation, "title" | "pinned" | "archived" | "folder_id">>;

export type TurnEvent =
  | {
      event: "start";
      data: {
        conversation: Conversation;
        /** Null for regenerate / continue. */
        user_message: ChatMessage | null;
        assistant_message: ChatMessage;
        history_messages_dropped: number;
        documents?: DocumentUse;
      };
    }
  | { event: "token"; data: { text: string } }
  | {
      event: "done";
      data: { message: ChatMessage; finish_reason: string; total_duration_ms: number | null; json_valid?: boolean };
    }
  | { event: "error"; data: { code: string; message: string; message_id: string } };

export const api = {
  health: (signal?: AbortSignal) => apiRequest<Health>("/api/health", { auth: false, signal }),
  audit: (params: { limit?: number; beforeId?: number } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.beforeId) q.set("before_id", String(params.beforeId));
    const qs = q.toString();
    return apiRequest<AuditPage>(`/api/audit${qs ? `?${qs}` : ""}`, { signal });
  },
  models: (signal?: AbortSignal) => apiRequest<ModelList>("/api/models", { signal }),
  settings: (signal?: AbortSignal) => apiRequest<AppSettings>("/api/settings", { signal }),
  updateSettings: (patch: Partial<AppSettings>) =>
    apiRequest<AppSettings>("/api/settings", { method: "PATCH", body: patch }),
  conversations: (filter: ConversationFilter = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (filter.archived) q.set("archived", "true");
    if (filter.pinned !== undefined) q.set("pinned", String(filter.pinned));
    if (filter.folderId) q.set("folder_id", filter.folderId);
    if (filter.projectId) q.set("project_id", filter.projectId);
    if (filter.limit) q.set("limit", String(filter.limit));
    const qs = q.toString();
    return apiRequest<ConversationSummary[]>(`/api/conversations${qs ? `?${qs}` : ""}`, { signal });
  },
  searchConversations: (query: string, signal?: AbortSignal) =>
    apiRequest<SearchHit[]>(`/api/conversations/search?q=${encodeURIComponent(query)}`, { signal }),
  updateConversation: (id: string, patch: ConversationPatch) =>
    apiRequest<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteConversation: (id: string) =>
    apiRequest<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  selectBranch: (id: string, messageId: string) =>
    apiRequest<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}/branch`, {
      method: "PUT",
      body: { message_id: messageId },
    }),
  exportConversation: async (id: string, format: "markdown" | "json") => {
    const resp = await apiFetch(`/api/conversations/${encodeURIComponent(id)}/export?format=${format}`);
    const disposition = resp.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `conversation.${format === "json" ? "json" : "md"}`;
    return { blob: await resp.blob(), filename };
  },
  folders: (signal?: AbortSignal) => apiRequest<Folder[]>("/api/folders", { signal }),
  createFolder: (name: string) => apiRequest<Folder>("/api/folders", { method: "POST", body: { name } }),
  renameFolder: (id: string, name: string) =>
    apiRequest<Folder>(`/api/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  deleteFolder: (id: string) => apiRequest<void>(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  templates: (signal?: AbortSignal) => apiRequest<PromptTemplate[]>("/api/templates", { signal }),
  createTemplate: (body: { name: string; content: string }) =>
    apiRequest<PromptTemplate>("/api/templates", { method: "POST", body }),
  attachment: (id: string, signal?: AbortSignal) =>
    apiRequest<Attachment>(`/api/attachments/${encodeURIComponent(id)}`, { signal }),
  attachmentText: (id: string, offset = 0, limit = 20_000, signal?: AbortSignal) =>
    apiRequest<AttachmentText>(`/api/attachments/${encodeURIComponent(id)}/text?offset=${offset}&limit=${limit}`, {
      signal,
    }),
  deleteAttachment: (id: string) =>
    apiRequest<void>(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** URL of the original file (images render inline; other types download). Sent with the session cookie. */
  attachmentContentUrl: (id: string) => `${apiBase()}/api/attachments/${encodeURIComponent(id)}/content`,
  downloadAttachment: async (id: string) => {
    const resp = await apiFetch(`/api/attachments/${encodeURIComponent(id)}/content`);
    const disposition = resp.headers.get("Content-Disposition") ?? "";
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? "file";
    return { blob: await resp.blob(), filename: decodeURIComponent(filename) };
  },
  projects: (archived = false, signal?: AbortSignal) =>
    apiRequest<Project[]>(`/api/projects${archived ? "?archived=true" : ""}`, { signal }),
  project: (id: string, signal?: AbortSignal) =>
    apiRequest<Project>(`/api/projects/${encodeURIComponent(id)}`, { signal }),
  createProject: (body: { name: string; description?: string; instructions?: string }) =>
    apiRequest<Project>("/api/projects", { method: "POST", body }),
  updateProject: (id: string, patch: ProjectPatch) =>
    apiRequest<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteProject: (id: string) => apiRequest<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  projectKnowledge: (id: string, signal?: AbortSignal) =>
    apiRequest<Attachment[]>(`/api/projects/${encodeURIComponent(id)}/knowledge`, { signal }),
  searchProject: (id: string, query: string, signal?: AbortSignal) =>
    apiRequest<ProjectHit[]>(`/api/projects/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`, {
      signal,
    }),
  exportProject: async (id: string) => {
    const resp = await apiFetch(`/api/projects/${encodeURIComponent(id)}/export`);
    const disposition = resp.headers.get("Content-Disposition") ?? "";
    const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? "project.zip";
    return { blob: await resp.blob(), filename };
  },
  deleteTemplate: (id: string) => apiRequest<void>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  conversation: (id: string, signal?: AbortSignal) =>
    apiRequest<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`, { signal }),
  createConversation: (body: { title?: string; model_id?: string; project_id?: string } = {}) =>
    apiRequest<Conversation>("/api/conversations", { method: "POST", body }),
};

export type TurnRequest =
  | {
      kind: "send";
      content: string;
      model_id: string;
      params: GenerationParams;
      edit_of?: string;
      attachment_ids?: string[];
    }
  | { kind: "regenerate"; message_id: string; model_id: string; params: GenerationParams }
  | { kind: "continue"; message_id: string; params: GenerationParams };

const TURN_PATH: Record<TurnRequest["kind"], string> = {
  send: "messages",
  regenerate: "regenerate",
  continue: "continue",
};

/**
 * Starts a turn (send, regenerate or continue) and yields the reply as it streams. Aborting `signal`
 * stops generation on the server (the partial reply is kept and marked "cancelled").
 */
export async function* streamTurn(
  conversationId: string,
  request: TurnRequest,
  signal: AbortSignal,
): AsyncGenerator<TurnEvent> {
  const { kind, ...body } = request;
  const resp = await apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}/${TURN_PATH[kind]}`, {
    method: "POST",
    body,
    signal,
  });
  if (!resp.body) throw new ApiError(500, "no_body", "The server sent an empty response.");
  for await (const ev of parseSse(resp.body)) {
    yield { event: ev.event, data: JSON.parse(ev.data) } as TurnEvent;
  }
}

/**
 * Uploads a file with progress (fetch has no upload progress, so this uses XMLHttpRequest).
 * Resolves with the stored attachment (status "pending"; poll until "ready" or "failed").
 */
export async function uploadAttachment(
  file: File,
  opts: {
    conversationId?: string | null;
    /** Upload into a project's knowledge instead of a chat. */
    projectId?: string;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Attachment> {
  const send = async (retry: boolean): Promise<Attachment> => {
    const token = await ensureSession();
    const form = new FormData();
    form.append("file", file, file.name);
    if (opts.conversationId) form.append("conversation_id", opts.conversationId);
    return new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const path = opts.projectId
        ? `/api/projects/${encodeURIComponent(opts.projectId)}/knowledge`
        : "/api/attachments";
      xhr.open("POST", `${apiBase()}${path}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("X-CSRF-Token", token);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      };
      xhr.onerror = () => reject(new ApiUnreachableError(new Error("network error")));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      xhr.onload = () => {
        let body: ErrorBody & Partial<Attachment> = {};
        try {
          body = JSON.parse(xhr.responseText || "{}");
        } catch {
          /* non-JSON */
        }
        if (xhr.status === 201) return resolve(body as Attachment);
        const detail = typeof body.detail === "object" && body.detail && !Array.isArray(body.detail) ? body.detail : {};
        const code = (detail as { code?: string }).code ?? `http_${xhr.status}`;
        if (retry && ["no_session", "session_expired", "csrf_failed"].includes(code)) {
          resetSession();
          return resolve(send(false));
        }
        reject(new ApiError(xhr.status, code, (detail as { message?: string }).message ?? "Upload failed."));
      };
      opts.signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(form);
    });
  };
  return send(true);
}
