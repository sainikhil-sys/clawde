"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { LogoMark } from "@/components/brand/logo";
import { useApiHealth } from "@/hooks/use-api-health";
import {
  useAppSettings,
  useConversation,
  useGenerationParams,
  useLiveTurn,
  useModels,
  useUpdateSettings,
} from "@/hooks/use-chat";
import { api, ApiError, ApiUnreachableError } from "@/lib/api";
import { dismissFailedTurn, startTurn, stopTurn, type LiveTurn } from "@/lib/chat-store";

import { Composer } from "./composer";
import { GenerationSettings } from "./generation-settings";
import { MessageList } from "./message-list";
import { ModelSelect } from "./model-select";

/** `conversationId` null = a new chat (home page). The conversation is created on first send. */
export function ChatView({ conversationId }: { conversationId: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const health = useApiHealth();
  const apiUp = health.isSuccess;
  const models = useModels();
  const settings = useAppSettings();
  const updateSettings = useUpdateSettings();
  const conversation = useConversation(conversationId);
  const live = useLiveTurn(conversationId);
  const [params, setParams] = useGenerationParams();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const chatModels = useMemo(() => (models.data?.models ?? []).filter((m) => m.chat), [models.data]);
  const modelId = useMemo(() => {
    const candidates = [pickedModel, conversation.data?.model_id, settings.data?.default_model];
    for (const c of candidates) if (c && chatModels.some((m) => m.id === c)) return c;
    // Nothing chosen yet: start with the smallest model, which responds fastest on CPU-only machines.
    const smallest = [...chatModels].sort((a, b) => (a.size_bytes ?? Infinity) - (b.size_bytes ?? Infinity))[0];
    return smallest?.id ?? null;
  }, [pickedModel, conversation.data?.model_id, settings.data?.default_model, chatModels]);
  const selectedModel = chatModels.find((m) => m.id === modelId) ?? null;

  // A request that failed before the server accepted it hands the draft back. Adjusting state during
  // render (instead of in an effect) avoids an extra render pass; the store entry is cleared afterwards.
  const [handledFailure, setHandledFailure] = useState<LiveTurn | undefined>(undefined);
  if (live?.failed && live !== handledFailure) {
    setHandledFailure(live);
    const { content, message } = live.failed;
    setDraft((d) => d || content);
    setSendError(message);
  }
  useEffect(() => {
    if (conversationId && handledFailure?.failed) dismissFailedTurn(conversationId);
  }, [conversationId, handledFailure]);

  const messages = useMemo(() => {
    const persisted = conversation.data?.messages ?? [];
    if (!live || live.failed) return persisted;
    const liveIds = new Set([live.user.id, live.assistant.id]);
    return [...persisted.filter((m) => !liveIds.has(m.id)), live.user, live.assistant];
  }, [conversation.data?.messages, live]);
  const generating = !!live && !live.failed && live.phase !== "settling";

  // Follow the stream unless the user has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const providerDown = models.data?.providers.find((p) => p.status !== "ok");
  let blocked: string | undefined;
  if (!apiUp) blocked = health.isPending ? "Connecting to the local API…" : "The local API is not running";
  else if (models.isPending) blocked = "Loading models…";
  else if (models.isError) blocked = "Couldn't load models";
  else if (chatModels.length === 0) blocked = providerDown ? "Ollama isn't running" : "No chat models installed";

  async function send() {
    const content = draft.trim();
    if (!content || !modelId || generating) return;
    setSendError(null);
    setDraft("");
    stickToBottom.current = true;
    let id = conversationId;
    if (!id) {
      try {
        const conv = await api.createConversation({ model_id: modelId });
        id = conv.id;
      } catch (err) {
        setDraft(content);
        setSendError(
          err instanceof ApiUnreachableError
            ? "Couldn't reach the local API."
            : err instanceof ApiError
              ? err.message
              : "Couldn't start a conversation.",
        );
        return;
      }
    }
    void startTurn({ conversationId: id, content, modelId, params, queryClient });
    if (!conversationId) router.push(`/chat/${id}`);
  }

  function chooseModel(id: string) {
    setPickedModel(id);
    // New chats start with the last model you picked.
    if (id !== settings.data?.default_model) updateSettings.mutate({ default_model: id });
  }

  const notFound = conversation.error instanceof ApiError && conversation.error.status === 404;
  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          {notFound ? (
            <div className="py-16 text-center">
              <h1 className="font-heading text-2xl font-medium">Conversation not found</h1>
              <p className="mt-2 text-muted-foreground">It may have been deleted.</p>
              <Link href="/" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
                Start a new chat
              </Link>
            </div>
          ) : conversationId && conversation.isPending && !live ? (
            <p className="py-16 text-center text-sm text-muted-foreground" role="status">
              Loading conversation…
            </p>
          ) : conversation.isError && !notFound ? (
            <p className="py-16 text-center text-sm text-destructive" role="alert">
              Couldn&apos;t load this conversation: {conversation.error.message}
            </p>
          ) : empty ? (
            <EmptyChat />
          ) : (
            <>
              {conversation.data && <h1 className="sr-only">{conversation.data.title}</h1>}
              {live && live.historyDropped > 0 && (
                <p className="mb-6 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  {live.historyDropped} older message{live.historyDropped === 1 ? " was" : "s were"} left out to fit the
                  model&apos;s context window.
                </p>
              )}
              <MessageList messages={messages} phase={live?.phase} />
            </>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
        <StatusNotice
          apiUp={apiUp}
          apiPending={health.isPending}
          modelsError={models.isError}
          providerMessage={providerDown?.message ?? null}
          noModels={apiUp && models.isSuccess && chatModels.length === 0}
          onRetry={() => void models.refetch()}
        />
        {sendError && (
          <p className="mb-2 text-sm text-destructive" role="alert">
            {sendError}
          </p>
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={() => conversationId && stopTurn(conversationId)}
          generating={generating}
          canSend={!blocked && !!modelId && !notFound}
          disabledReason={blocked}
          autoFocus
          toolbar={
            <>
              <ModelSelect models={chatModels} value={modelId} onChange={chooseModel} disabled={generating} />
              <GenerationSettings
                params={params}
                onChange={setParams}
                maxContext={selectedModel?.context_length ?? null}
              />
            </>
          }
        />
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Runs locally on your computer. Models can be wrong; check important answers.
        </p>
      </div>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center pt-[12vh] text-center">
      <LogoMark className="size-8 text-primary" />
      <h1 className="mt-5 font-heading text-3xl font-medium tracking-tight text-balance sm:text-4xl">
        What would you like to work on?
      </h1>
    </div>
  );
}

function StatusNotice({
  apiUp,
  apiPending,
  modelsError,
  providerMessage,
  noModels,
  onRetry,
}: {
  apiUp: boolean;
  apiPending: boolean;
  modelsError: boolean;
  providerMessage: string | null;
  noModels: boolean;
  onRetry: () => void;
}) {
  let body: React.ReactNode = null;
  if (!apiUp && !apiPending) {
    body = (
      <>
        The local API isn&apos;t running. Start it with <code className="font-mono">pnpm dev:api</code>.
      </>
    );
  } else if (apiUp && modelsError) {
    body = <>Couldn&apos;t load the model list.</>;
  } else if (noModels && providerMessage) {
    body = <>{providerMessage} Start the Ollama app, then retry.</>;
  } else if (noModels) {
    body = (
      <>
        No chat models are installed in Ollama. Install one from a terminal, for example{" "}
        <code className="font-mono">ollama pull llama3.2</code>, then retry.
      </>
    );
  }
  if (!body) return null;
  return (
    <div
      className="mb-2 flex items-start justify-between gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
      role="status"
    >
      <p>{body}</p>
      {apiUp && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md border bg-background px-2 py-0.5 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      )}
    </div>
  );
}
