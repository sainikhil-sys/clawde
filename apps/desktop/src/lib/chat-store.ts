/**
 * Live (in-flight) assistant turns, keyed by conversation id.
 *
 * Kept outside React components so a reply keeps streaming when the user navigates (e.g. from the home
 * page to /chat/[id], or to another section), and so Stop works from wherever the conversation is shown.
 * Persisted messages come from the API via React Query; this store only holds what is still streaming.
 */

import type { QueryClient } from "@tanstack/react-query";

import { api, ApiError, ApiUnreachableError, streamMessage, type ChatMessage, type GenerationParams } from "./api";

export type TurnPhase = "sending" | "streaming" | "settling";

export type LiveTurn = {
  conversationId: string;
  user: ChatMessage;
  assistant: ChatMessage;
  phase: TurnPhase;
  historyDropped: number;
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
  modelId: string,
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
    created_at: new Date().toISOString(),
  };
}

function describeError(err: unknown): string {
  if (err instanceof ApiUnreachableError) return "Couldn't reach the local API. Is it running?";
  if (err instanceof ApiError) return err.message;
  return "Something went wrong while sending.";
}

/**
 * Starts streaming a reply. Resolves when the turn has fully finished and been reconciled with the
 * server copy (it does not need to be awaited by the UI).
 */
export async function startTurn(opts: {
  conversationId: string;
  content: string;
  modelId: string;
  params: GenerationParams;
  queryClient: QueryClient;
}): Promise<void> {
  const { conversationId: id, content, modelId, params, queryClient } = opts;
  if (isGenerating(id)) return;

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  turns.set(id, {
    conversationId: id,
    user: placeholder(id, "user", content, modelId),
    assistant: placeholder(id, "assistant", "", modelId),
    phase: "sending",
    historyDropped: 0,
  });
  emit();

  let accepted = false;
  let assistantId: string | null = null;
  try {
    for await (const ev of streamMessage(id, { content, model_id: modelId, params }, ctrl.signal)) {
      if (ev.event === "start") {
        accepted = true;
        assistantId = ev.data.assistant_message.id;
        set(id, (t) => ({
          ...t,
          user: ev.data.user_message,
          assistant: ev.data.assistant_message,
          phase: "streaming",
          historyDropped: ev.data.history_messages_dropped,
        }));
        // The title is set on the first message; refresh the sidebar.
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } else if (ev.event === "token") {
        set(id, (t) => ({ ...t, assistant: { ...t.assistant, content: t.assistant.content + ev.data.text } }));
      } else if (ev.event === "done") {
        set(id, (t) => ({ ...t, assistant: ev.data.message }));
      } else if (ev.event === "error") {
        set(id, (t) => ({ ...t, assistant: { ...t.assistant, status: "error", error: ev.data.message } }));
      }
    }
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    if (aborted && accepted) {
      set(id, (t) => ({ ...t, assistant: { ...t.assistant, status: "cancelled" } }));
    } else if (!accepted) {
      // Nothing was saved server-side (or the stop came before the server accepted it): give the draft back.
      set(id, (t) => ({
        ...t,
        failed: { message: aborted ? "Stopped before sending." : describeError(err), content },
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

/** Test helper. */
export function _resetChatStore() {
  for (const c of controllers.values()) c.abort();
  turns.clear();
  controllers.clear();
  emit();
}
