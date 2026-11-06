/**
 * Live (in-flight) assistant turns, keyed by conversation id.
 *
 * Kept outside React components so a reply keeps streaming when the user navigates (e.g. from the home
 * page to /chat/[id], or to another section), and so Stop works from wherever the conversation is shown.
 * Persisted messages come from the API via React Query; this store only holds what is still streaming.
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  api,
  ApiError,
  ApiUnreachableError,
  streamTurn,
  type ChatMessage,
  type DocumentUse,
  type MemoryUse,
  type GenerationParams,
  type TurnRequest,
} from "./api";

export type TurnPhase = "sending" | "streaming" | "settling";

export type LiveTurn = {
  conversationId: string;
  kind: TurnRequest["kind"];
  /** The new user message (send / edit). Null for regenerate and continue. */
  user: ChatMessage | null;
  assistant: ChatMessage;
  phase: TurnPhase;
  historyDropped: number;
  /** How attached files were given to the model this turn (full text or excerpts). */
  documents?: DocumentUse;
  /** Which saved memories (and whether the rolling summary) went into this turn. */
  memory?: MemoryUse;
  /** Persisted messages from this id onwards are replaced by the live turn (edit / regenerate). */
  replaceFrom?: string;
  /** Set when the request failed before the server accepted it; the draft can be restored. */
  failed?: { message: string; content: string };
};

type Listener = () => void;
const turns = new Map<string, LiveTurn>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function set(id: string, update: (t: LiveTurn) => LiveTurn) {
  const cur = turns.get(id);
  if (!cur) return;
  turns.set(id, update(cur));
  emit();
}

export function subscribeTurns(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTurn(conversationId: string | null): LiveTurn | undefined {
  return conversationId ? turns.get(conversationId) : undefined;
}

export function isGenerating(conversationId: string | null): boolean {
  const t = getTurn(conversationId);
  return !!t && !t.failed && t.phase !== "settling";
}

/** Clear a failed turn after its draft has been restored to the composer. */
export function dismissFailedTurn(conversationId: string) {
  if (turns.get(conversationId)?.failed) {
    turns.delete(conversationId);
    emit();
  }
}

export function stopTurn(conversationId: string) {
  controllers.get(conversationId)?.abort();
}

function placeholder(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  modelId: string | null,
): ChatMessage {
  return {
    id: `local-${role}-${Date.now()}`,
    conversation_id: conversationId,
    parent_id: null,
    role,
    content,
    status: role === "user" ? "complete" : "streaming",
    model_id: role === "assistant" ? modelId : null,
    prompt_tokens: null,
    completion_tokens: null,
    error: null,
    finish_reason: null,
    created_at: new Date().toISOString(),
  };
}

function describeError(err: unknown): string {
  if (err instanceof ApiUnreachableError) return "Couldn't reach the local API. Is it running?";
  if (err instanceof ApiError) return err.message;
  return "Something went wrong while sending.";
}

export type StartTurnOptions = {
  conversationId: string;
  request: TurnRequest;
  queryClient: QueryClient;
  /** For regenerate / continue: the existing assistant message (continue keeps its text). */
  existing?: ChatMessage;
  /** Called once the server has accepted the turn (e.g. to clear attached files from the composer). */
  onAccepted?: () => void;
};

/**
 * Starts streaming a turn. Resolves when it has fully finished and been reconciled with the server copy
 * (the UI does not need to await it).
 */
export async function startTurn({
  conversationId: id,
  request,
  queryClient,
  existing,
  onAccepted,
}: StartTurnOptions): Promise<void> {
  if (isGenerating(id)) return;
  const modelId = "model_id" in request ? request.model_id : (existing?.model_id ?? null);
  const draft = request.kind === "send" ? request.content : "";

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  turns.set(id, {
    conversationId: id,
    kind: request.kind,
    user: request.kind === "send" ? placeholder(id, "user", request.content, null) : null,
    assistant:
      request.kind === "continue" && existing
        ? { ...existing, status: "streaming", error: null }
        : placeholder(id, "assistant", "", modelId),
    phase: "sending",
    historyDropped: 0,
    replaceFrom:
      request.kind === "send" ? request.edit_of : request.kind === "regenerate" ? request.message_id : undefined,
  });
  emit();

  let accepted = false;
  let assistantId: string | null = existing?.id ?? null;
  try {
    for await (const ev of streamTurn(id, request, ctrl.signal)) {
      if (ev.event === "start") {
        accepted = true;
        onAccepted?.();
        assistantId = ev.data.assistant_message.id;
        set(id, (t) => ({
          ...t,
          user: ev.data.user_message ?? t.user,
          assistant: ev.data.assistant_message,
          phase: "streaming",
          historyDropped: ev.data.history_messages_dropped,
          documents: ev.data.documents,
          memory: ev.data.memory,
        }));
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } else if (ev.event === "token") {
        set(id, (t) => ({ ...t, assistant: { ...t.assistant, content: t.assistant.content + ev.data.text } }));
      } else if (ev.event === "done") {
        set(id, (t) => ({
          ...t,
          assistant: { ...ev.data.message, sibling_ids: t.assistant.sibling_ids, artifacts: ev.data.artifacts ?? [] },
        }));
        if (ev.data.artifacts?.length) void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      } else if (ev.event === "error") {
        set(id, (t) => ({ ...t, assistant: { ...t.assistant, status: "error", error: ev.data.message } }));
      }
    }
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    if (aborted && accepted) {
      set(id, (t) => ({ ...t, assistant: { ...t.assistant, status: "cancelled" } }));
    } else if (!accepted) {
      // Nothing was saved server-side: give any draft back and show why.
      set(id, (t) => ({
        ...t,
        failed: { message: aborted ? "Stopped before sending." : describeError(err), content: draft },
      }));
      controllers.delete(id);
      return;
    } else {
      set(id, (t) => ({ ...t, assistant: { ...t.assistant, status: "error", error: describeError(err) } }));
    }
  } finally {
    controllers.delete(id);
  }

  set(id, (t) => ({ ...t, phase: "settling" }));
  await reconcile(id, assistantId, queryClient);
  turns.delete(id);
  emit();
}

/** Refetch until the server copy of the reply is no longer "streaming" (a stop is persisted asynchronously). */
async function reconcile(id: string, assistantId: string | null, queryClient: QueryClient) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const detail = await api.conversation(id);
      queryClient.setQueryData(["conversation", id], detail);
      const saved = detail.messages.find((m) => m.id === assistantId);
      if (!assistantId || (saved && saved.status !== "streaming")) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  void queryClient.invalidateQueries({ queryKey: ["conversations"] });
}

/** Messages to display: the persisted branch with the live turn merged in. */
export function mergeLiveTurn(persisted: ChatMessage[], live: LiveTurn | undefined): ChatMessage[] {
  if (!live || live.failed) return persisted;
  if (live.kind === "continue") {
    return persisted.map((m) => (m.id === live.assistant.id ? { ...live.assistant, sibling_ids: m.sibling_ids } : m));
  }
  let base = persisted;
  if (live.replaceFrom) {
    const idx = persisted.findIndex((m) => m.id === live.replaceFrom);
    if (idx >= 0) base = persisted.slice(0, idx);
  }
  const liveIds = new Set([live.user?.id, live.assistant.id]);
  base = base.filter((m) => !liveIds.has(m.id));
  return live.user ? [...base, live.user, live.assistant] : [...base, live.assistant];
}

export type { GenerationParams };

/** Test helper. */
export function _resetChatStore() {
  for (const c of controllers.values()) c.abort();
  turns.clear();
  controllers.clear();
  emit();
}
