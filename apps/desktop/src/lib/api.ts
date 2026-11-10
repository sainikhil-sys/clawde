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
  architecture?: string | null;
  parameter_count?: number | null;
  license?: string | null;
  behaviour_profile_id?: string | null;
  last_used_at?: string | null;
  /** RAM needed at 4k context (weights + KV cache). */
  estimated_ram_bytes?: number | null;
  estimate_exact?: boolean;
  fit_now?: Fit;
  fit_total?: Fit;
  loaded?: boolean;
  evaluation?: EvalSummary | null;
};
export type Fit = "fits" | "tight" | "wont_fit" | "unknown";
export type ModelDetail = ModelInfo & { license_text: string | null; details: Record<string, number> };
export type Hardware = {
  ram_total: number;
  ram_available: number;
  ram_used_percent: number;
  cpu_percent: number;
  cpu_count: number;
  gpu_percent: number | null;
  gpu_note: string;
  loaded: { model_id: string; bytes: number }[];
};
export type Routing = { tasks: string[]; assignments: Record<string, string>; keep_one_model_loaded: boolean };
export type RouteDecision = {
  mode: "auto";
  task: string;
  model_id: string;
  reason: string;
  considered: { model_id: string; fit: Fit; estimate_bytes: number | null }[];
};
export type BehaviourProfile = {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  context_length: number | null;
  created_at: string;
  updated_at: string;
  used_by: { models: number; projects: number; conversations: number };
};
export type ProfileInput = Omit<BehaviourProfile, "id" | "created_at" | "updated_at" | "used_by">;
export type SuiteSummary = {
  title: string;
  kind: "capability" | "behaviour";
  passed: number;
  total: number;
  errors: number;
  score: number | null;
  over_refusal?: number | null;
  under_refusal?: number | null;
  admits_unknown?: number | null;
  method?: string;
};
export type EvalSummary = {
  run_id?: string;
  finished_at?: string;
  speed?: { tokens_per_s: number | null; first_token_ms: number | null };
  memory?: { loaded_bytes: number | null };
} & Record<string, unknown>;
export type EvalSuite = {
  key: string;
  title: string;
  kind: "capability" | "behaviour";
  description: string;
  cases: number;
  version: string;
};
export type EvalRun = {
  id: string;
  model_id: string;
  model_digest: string | null;
  suites: string[];
  suite_versions: Record<string, string>;
  seed: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  total: number;
  summary: EvalSummary;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};
export type EvalResult = {
  suite: string;
  case_id: string;
  category: string;
  prompt: string;
  output: string;
  passed: boolean | null;
  verdict: Record<string, unknown>;
  latency_ms: number | null;
  tokens_per_s: number | null;
  error: string | null;
};
export type ImportInfo = {
  path: string;
  format: "gguf" | "safetensors";
  size_bytes: number;
  name: string | null;
  architecture: string | null;
  parameter_count: number | null;
  quantization: string | null;
  context_length: number | null;
  license: string | null;
  estimated_ram_bytes: number | null;
  fit_total: Fit;
  target: "ollama" | "transformers";
};
/** A line of progress from a download or import (Ollama style: status, completed/total bytes). */
export type Progress = { status?: string; completed?: number; total?: number; error?: string; folder?: string };

export type ProviderStatus = {
  name: string;
  status: "ok" | "unavailable" | "error";
  message: string | null;
  model_count: number;
};
export type ModelList = { models: ModelInfo[]; providers: ProviderStatus[] };

export type AppSettings = {
  network_access_enabled: boolean;
  default_model: string | null;
  /** Put relevant saved memories into chat context. */
  memory_enabled: boolean;
  /** Summarise a conversation into memory when it outgrows the context window. */
  memory_auto_summarise: boolean;
  /** Tell models they can create artifacts. */
  artifacts_enabled: boolean;
  /** Per-tool agent permission overrides (see /api/agents/tools for what is in force). */
  tool_permissions: Record<string, ToolPolicy>;
};

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
  /** Saved memories that were in context for this reply (ids may refer to since-deleted memories). */
  memory_ids?: string[] | null;
  /** Artifacts this reply created or updated, in the order they appear in its text. */
  artifacts?: ArtifactRef[];
  /** How the model was chosen (manual or auto, with the router's reason) and the profile used. */
  route?: { mode: "manual" | "auto"; model_id: string; task?: string; reason?: string; profile?: unknown } | null;
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

export type ToolPolicy = "auto" | "ask" | "deny";
export type ToolRisk = "read" | "compute" | "write" | "execute";
export type AgentTool = {
  name: string;
  description: string;
  risk: ToolRisk;
  policy: ToolPolicy;
  allowed: ToolPolicy[];
  needs_project: boolean;
};
export type AgentRunStatus =
  "planning" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export const ACTIVE_RUN_STATUSES: AgentRunStatus[] = ["planning", "running", "waiting_approval"];
export type AgentRun = {
  id: string;
  task: string;
  status: AgentRunStatus;
  model_id: string;
  project_id: string | null;
  plan: string[];
  result: string | null;
  error: string | null;
  max_steps: number;
  retry_of: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};
export type AgentStep = {
  id: string;
  run_id: string;
  index: number;
  kind: "plan" | "tool" | "final" | "error" | "note";
  thought: string;
  tool: string | null;
  risk: ToolRisk | null;
  args: Record<string, unknown>;
  status: "pending" | "waiting_approval" | "running" | "done" | "error" | "denied" | "cancelled";
  approval: "auto" | "approved" | "denied" | "policy_denied" | null;
  output: string;
  data: Record<string, unknown>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};
export type AgentRunDetail = AgentRun & { steps: AgentStep[] };
export type SandboxStatus = {
  docker: "ready" | "no_image" | "not_running" | "not_installed";
  image: string;
  detail: string;
  fallback_limits: string;
  active_tier: "docker" | "fallback";
  network_access_enabled: boolean;
};
export type WorkspaceFile = { path: string; size: number; modified: string };
export type AgentEvent =
  | { event: "snapshot"; data: AgentRunDetail }
  | { event: "run"; data: { run: AgentRun } }
  | { event: "step"; data: { step: AgentStep } }
  | { event: "ping"; data: Record<string, never> };

export const ARTIFACT_KINDS = ["html", "react", "svg", "markdown", "mermaid", "chart", "javascript", "code"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactRef = { id: string; identifier: string; title: string; kind: ArtifactKind; version: number };
export type Artifact = {
  id: string;
  identifier: string;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  conversation_id: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  version_count: number;
  conversation_title: string | null;
};
export type ArtifactDetail = Artifact & { content: string };
export type ArtifactVersion = {
  version: number;
  source: "model" | "user" | "restore";
  message_id: string | null;
  note: string;
  created_at: string;
  chars: number;
};
export type ArtifactVersionDetail = ArtifactVersion & { content: string };
export type ArtifactSave = { artifact: ArtifactDetail; changed: boolean };
export type ArtifactCreate = {
  kind: ArtifactKind;
  title: string;
  content: string;
  language?: string;
  conversation_id?: string;
  source_message_id?: string;
};

export const MEMORY_KINDS = ["preference", "summary", "project", "knowledge", "temporary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type Memory = {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  pinned: boolean;
  project_id: string | null;
  conversation_id: string | null;
  source: "user" | "message" | "import" | "summary";
  meta: Record<string, unknown>;
  expires_at: string | null;
  embedding_model: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  project_name: string | null;
  conversation_title: string | null;
};
export type MemoryCreate = {
  kind: Exclude<MemoryKind, "summary">;
  content: string;
  title?: string;
  importance?: number;
  pinned?: boolean;
  project_id?: string;
  conversation_id?: string;
  expires_in_hours?: number;
  source_message_id?: string;
};
export type MemoryPatch = Partial<Pick<Memory, "title" | "content" | "importance" | "pinned">> & {
  expires_in_hours?: number;
  clear_expiry?: boolean;
};
export type MemoryFilter = { kind?: MemoryKind; projectId?: string; conversationId?: string; q?: string };
export type MemoryStats = { counts: Record<MemoryKind, number>; total: number; embedding_model: string | null };
export type MemoryScore = {
  id: string;
  kind: MemoryKind;
  title: string;
  passage: number;
  text: string;
  relevance: number;
  importance: number;
  recency: number;
  score: number;
  pinned: boolean;
  always: boolean;
};
export type MemoryPreview = {
  candidates: number;
  semantic: boolean;
  tokens: number;
  skipped_for_budget: number;
  chosen: MemoryScore[];
  others: MemoryScore[];
};
/** What saved memory went into a reply (sent in the turn "start" event). */
export type MemoryUse = {
  enabled: boolean;
  used: { id: string; kind: MemoryKind; title: string; score: number; relevance: number; pinned: boolean }[];
  summary_used: boolean;
  summary_id?: string;
  candidates?: number;
  semantic?: boolean;
  skipped_for_budget?: number;
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
  behaviour_profile_id?: string | null;
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
  behaviour_profile_id?: string | null;
};
export type ProjectPatch = Partial<Pick<Project, "name" | "description" | "instructions" | "behaviour_profile_id">> & {
  archived?: boolean;
};
export type ProjectHit = { kind: "conversation" | "knowledge"; id: string; title: string; snippet: string };
export type ConversationPatch = Partial<
  Pick<Conversation, "title" | "pinned" | "archived" | "folder_id" | "behaviour_profile_id">
>;

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
        memory?: MemoryUse;
      };
    }
  | { event: "token"; data: { text: string } }
  | {
      event: "done";
      data: {
        message: ChatMessage;
        finish_reason: string;
        total_duration_ms: number | null;
        json_valid?: boolean;
        artifacts?: ArtifactRef[];
      };
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
  agentTools: (signal?: AbortSignal) => apiRequest<AgentTool[]>("/api/agents/tools", { signal }),
  updateToolPermissions: (permissions: Record<string, ToolPolicy>) =>
    apiRequest<AgentTool[]>("/api/agents/permissions", { method: "PUT", body: { tool_permissions: permissions } }),
  sandboxStatus: (refresh = false, signal?: AbortSignal) =>
    apiRequest<SandboxStatus>(`/api/agents/sandbox${refresh ? "?refresh=true" : ""}`, { signal }),
  prepareSandbox: () => apiRequest<SandboxStatus>("/api/agents/sandbox/prepare", { method: "POST" }),
  workspaceFiles: (signal?: AbortSignal) => apiRequest<WorkspaceFile[]>("/api/agents/workspace", { signal }),
  downloadWorkspaceFile: async (path: string) => {
    const resp = await apiFetch(`/api/agents/workspace/file?path=${encodeURIComponent(path)}`);
    return { blob: await resp.blob(), filename: path.split("/").pop() ?? "file" };
  },
  deleteWorkspaceFile: (path: string) =>
    apiRequest<void>(`/api/agents/workspace/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  agentRuns: (signal?: AbortSignal) => apiRequest<AgentRun[]>("/api/agents/runs", { signal }),
  agentRun: (id: string, signal?: AbortSignal) =>
    apiRequest<AgentRunDetail>(`/api/agents/runs/${encodeURIComponent(id)}`, { signal }),
  startAgentRun: (body: { task: string; model_id?: string; project_id?: string; max_steps?: number }) =>
    apiRequest<AgentRunDetail>("/api/agents/runs", { method: "POST", body }),
  cancelAgentRun: (id: string) =>
    apiRequest<AgentRunDetail>(`/api/agents/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  retryAgentRun: (id: string) =>
    apiRequest<AgentRunDetail>(`/api/agents/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  deleteAgentRun: (id: string) => apiRequest<void>(`/api/agents/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  decideAgentStep: (runId: string, stepId: string, approve: boolean, note = "") =>
    apiRequest<{ ok: true }>(
      `/api/agents/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/decision`,
      { method: "POST", body: { approve, note } },
    ),
  artifacts: (filter: { conversationId?: string; q?: string } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (filter.conversationId) q.set("conversation_id", filter.conversationId);
    if (filter.q?.trim()) q.set("q", filter.q.trim());
    const qs = q.toString();
    return apiRequest<Artifact[]>(`/api/artifacts${qs ? `?${qs}` : ""}`, { signal });
  },
  artifact: (id: string, signal?: AbortSignal) =>
    apiRequest<ArtifactDetail>(`/api/artifacts/${encodeURIComponent(id)}`, { signal }),
  createArtifact: (body: ArtifactCreate) => apiRequest<ArtifactDetail>("/api/artifacts", { method: "POST", body }),
  renameArtifact: (id: string, title: string) =>
    apiRequest<ArtifactDetail>(`/api/artifacts/${encodeURIComponent(id)}`, { method: "PATCH", body: { title } }),
  saveArtifact: (id: string, content: string) =>
    apiRequest<ArtifactSave>(`/api/artifacts/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      body: { content },
    }),
  artifactVersions: (id: string, signal?: AbortSignal) =>
    apiRequest<ArtifactVersion[]>(`/api/artifacts/${encodeURIComponent(id)}/versions`, { signal }),
  artifactVersion: (id: string, version: number, signal?: AbortSignal) =>
    apiRequest<ArtifactVersionDetail>(`/api/artifacts/${encodeURIComponent(id)}/versions/${version}`, { signal }),
  restoreArtifactVersion: (id: string, version: number) =>
    apiRequest<ArtifactSave>(`/api/artifacts/${encodeURIComponent(id)}/versions/${version}/restore`, {
      method: "POST",
    }),
  deleteArtifact: (id: string) => apiRequest<void>(`/api/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  downloadArtifact: async (id: string, version?: number) => {
    const resp = await apiFetch(
      `/api/artifacts/${encodeURIComponent(id)}/download${version ? `?version=${version}` : ""}`,
    );
    const disposition = resp.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "artifact.txt";
    return { blob: await resp.blob(), filename };
  },
  memories: (filter: MemoryFilter = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (filter.kind) q.set("kind", filter.kind);
    if (filter.projectId) q.set("project_id", filter.projectId);
    if (filter.conversationId) q.set("conversation_id", filter.conversationId);
    if (filter.q?.trim()) q.set("q", filter.q.trim());
    const qs = q.toString();
    return apiRequest<Memory[]>(`/api/memories${qs ? `?${qs}` : ""}`, { signal });
  },
  memory: (id: string, signal?: AbortSignal) =>
    apiRequest<Memory>(`/api/memories/${encodeURIComponent(id)}`, { signal }),
  memoryStats: (signal?: AbortSignal) => apiRequest<MemoryStats>("/api/memories/stats", { signal }),
  createMemory: (body: MemoryCreate) => apiRequest<Memory>("/api/memories", { method: "POST", body }),
  updateMemory: (id: string, patch: MemoryPatch) =>
    apiRequest<Memory>(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteMemory: (id: string) => apiRequest<void>(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteAllMemories: () => apiRequest<{ deleted: number }>("/api/memories?confirm=delete-all", { method: "DELETE" }),
  previewMemory: (body: { query: string; project_id?: string; conversation_id?: string }) =>
    apiRequest<MemoryPreview>("/api/memories/preview", { method: "POST", body }),
  exportMemories: async () => {
    const resp = await apiFetch("/api/memories/export");
    return { blob: await resp.blob(), filename: "clawde-memory.json" };
  },
  summariseConversation: (id: string, body: { model_id?: string } = {}) =>
    apiRequest<Memory>(`/api/conversations/${encodeURIComponent(id)}/summarise`, { method: "POST", body }),
  modelDetail: (id: string, signal?: AbortSignal) =>
    apiRequest<ModelDetail>(`/api/models/${encodeURIComponent(id)}/detail`, { signal }),
  setModelProfile: (id: string, profileId: string | null) =>
    apiRequest<ModelDetail>(`/api/models/${encodeURIComponent(id)}/profile`, {
      method: "PATCH",
      body: { behaviour_profile_id: profileId },
    }),
  unloadModel: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/models/${encodeURIComponent(id)}/unload`, { method: "POST" }),
  deleteModel: (id: string) => apiRequest<void>(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  hardware: (signal?: AbortSignal) => apiRequest<Hardware>("/api/models/system/hardware", { signal }),
  routing: (signal?: AbortSignal) => apiRequest<Routing>("/api/models/system/routing", { signal }),
  updateRouting: (body: { assignments?: Record<string, string>; keep_one_model_loaded?: boolean }) =>
    apiRequest<Routing>("/api/models/system/routing", { method: "PUT", body }),
  previewRoute: (body: { text: string; has_images?: boolean; has_documents?: boolean }) =>
    apiRequest<RouteDecision>("/api/models/system/routing/preview", { method: "POST", body }),
  inspectImport: (path: string) =>
    apiRequest<ImportInfo>("/api/models/import/inspect", { method: "POST", body: { path } }),
  profiles: (signal?: AbortSignal) => apiRequest<BehaviourProfile[]>("/api/profiles", { signal }),
  createProfile: (body: ProfileInput) => apiRequest<BehaviourProfile>("/api/profiles", { method: "POST", body }),
  updateProfile: (id: string, body: ProfileInput) =>
    apiRequest<BehaviourProfile>(`/api/profiles/${encodeURIComponent(id)}`, { method: "PUT", body }),
  deleteProfile: (id: string) => apiRequest<void>(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  evalSuites: (signal?: AbortSignal) => apiRequest<EvalSuite[]>("/api/evaluations/suites", { signal }),
  evalRuns: (modelId?: string, signal?: AbortSignal) =>
    apiRequest<EvalRun[]>(`/api/evaluations${modelId ? `?model_id=${encodeURIComponent(modelId)}` : ""}`, { signal }),
  evalRun: (id: string, signal?: AbortSignal) =>
    apiRequest<EvalRun & { results: EvalResult[] }>(`/api/evaluations/${encodeURIComponent(id)}`, { signal }),
  startEval: (body: { model_id: string; suites?: string[] }) =>
    apiRequest<EvalRun>("/api/evaluations", { method: "POST", body }),
  cancelEval: (id: string) =>
    apiRequest<EvalRun>(`/api/evaluations/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  deleteEval: (id: string) => apiRequest<void>(`/api/evaluations/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
      /** Omitted: the behaviour profile's defaults (or the app's) apply. */
      params?: GenerationParams;
      edit_of?: string;
      attachment_ids?: string[];
    }
  | { kind: "regenerate"; message_id: string; model_id: string; params?: GenerationParams }
  | { kind: "continue"; message_id: string; params?: GenerationParams };

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

/** Turns a document into a knowledge memory (only its extracted text is kept). */
export async function importMemoryFile(file: File, title?: string): Promise<Memory> {
  const send = async (retry: boolean): Promise<Memory> => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (title?.trim()) form.append("title", title.trim());
    const resp = await rawFetch("/api/memories/import", {
      method: "POST",
      headers: { "X-CSRF-Token": await ensureSession() },
      body: form,
    });
    if (resp.ok) return (await resp.json()) as Memory;
    const err = await toApiError(resp);
    if (retry && ["no_session", "session_expired", "csrf_failed"].includes(err.code)) {
      resetSession();
      return send(false);
    }
    throw err;
  };
  return send(true);
}

/** Live updates for an agent run: a snapshot, then run/step changes until it finishes. */
export async function* streamAgentRun(runId: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const resp = await apiFetch(`/api/agents/runs/${encodeURIComponent(runId)}/events`, { signal });
  if (!resp.body) return;
  for await (const ev of parseSse(resp.body)) {
    yield { event: ev.event, data: JSON.parse(ev.data) } as AgentEvent;
  }
}

/**
 * POST that streams newline-delimited JSON progress (model pull, import, Hugging Face download). Resolves when
 * the stream ends; throws on an error line.
 */
export async function streamProgress(
  path: string,
  body: unknown,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<Progress | null> {
  const resp = await apiFetch(path, { method: "POST", body, signal });
  if (!resp.body) return null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last: Progress | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const p = JSON.parse(line) as Progress;
      if (p.error) throw new ApiError(502, "progress_error", p.error);
      last = p;
      onProgress(p);
    }
  }
  return last;
}
