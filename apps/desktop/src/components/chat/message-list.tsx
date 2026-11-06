"use client";

import { AlertCircle, BookmarkPlus, ChevronLeft, ChevronRight, Pencil, Play, RefreshCw, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { AttachmentBrief, ChatMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

import { MemoryUsed } from "@/components/memory/memory-used";

import { AttachmentChip, attachmentDetails } from "./attachments";
import { CopyButton } from "./copy-button";
import { Markdown } from "./markdown";
import { shortModelName } from "./model-select";

export type MessageActions = {
  onEdit: (message: ChatMessage, newContent: string) => void;
  onRegenerate: (message: ChatMessage) => void;
  onContinue: (message: ChatMessage) => void;
  onSelectSibling: (messageId: string) => void;
  onOpenAttachment: (attachment: AttachmentBrief) => void;
  /** Save (part of) a message to memory. */
  onRemember?: (message: ChatMessage) => void;
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function Timestamp({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={fullFormat.format(d)}>
      {timeFormat.format(d)}
    </time>
  );
}

export function MessageList({
  messages,
  phase,
  busy,
  actions,
}: {
  messages: ChatMessage[];
  phase?: "sending" | "streaming" | "settling";
  /** A reply is generating: actions that start another turn are disabled. */
  busy: boolean;
  actions: MessageActions;
}) {
  const lastId = messages.at(-1)?.id;
  return (
    <ol className="space-y-7" aria-label="Conversation">
      {messages.map((m) => (
        <li key={m.id}>
          {m.role === "user" ? (
            <UserMessage message={m} busy={busy} actions={actions} />
          ) : (
            <AssistantMessage message={m} phase={phase} busy={busy} isLast={m.id === lastId} actions={actions} />
          )}
        </li>
      ))}
    </ol>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** "‹ 2 / 3 ›" switcher between alternative versions (edits or regenerations) of a message. */
function SiblingNav({
  message,
  busy,
  onSelect,
}: {
  message: ChatMessage;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const ids = message.sibling_ids ?? [];
  if (ids.length < 2) return null;
  const idx = ids.indexOf(message.id);
  return (
    <span className="inline-flex items-center text-xs text-muted-foreground" aria-label="Versions">
      <ActionButton label="Previous version" disabled={busy || idx <= 0} onClick={() => onSelect(ids[idx - 1])}>
        <ChevronLeft className="size-3.5" />
      </ActionButton>
      <span className="min-w-8 text-center tabular-nums">
        {idx + 1} / {ids.length}
      </span>
      <ActionButton
        label="Next version"
        disabled={busy || idx < 0 || idx >= ids.length - 1}
        onClick={() => onSelect(ids[idx + 1])}
      >
        <ChevronRight className="size-3.5" />
      </ActionButton>
    </span>
  );
}

function UserMessage({ message, busy, actions }: { message: ChatMessage; busy: boolean; actions: MessageActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const persisted = !message.id.startsWith("local-");

  if (editing) {
    const changed = draft.trim().length > 0 && draft !== message.content;
    return (
      <form
        className="ml-auto max-w-[85%] space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!changed) return;
          setEditing(false);
          actions.onEdit(message, draft.trim());
        }}
      >
        <label htmlFor={`edit-${message.id}`} className="sr-only">
          Edit message
        </label>
        <textarea
          id={`edit-${message.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
          rows={Math.min(10, Math.max(2, draft.split("\n").length))}
          className="block w-full resize-y rounded-xl border bg-card px-3.5 py-2.5 text-[0.95rem] leading-relaxed outline-none focus:border-ring/60"
        />
        <div className="flex justify-end gap-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(message.content);
            }}
            className="rounded-md border px-3 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!changed || busy}
            className="rounded-md bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            Send edit
          </button>
        </div>
        <p className="text-right text-xs text-muted-foreground">The original stays available as an earlier version.</p>
      </form>
    );
  }

  const files = message.attachments ?? [];
  return (
    <div className="group flex flex-col items-end">
      {files.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5" aria-label="Attached files">
          {files.map((a) => (
            <AttachmentChip
              key={a.id}
              name={a.filename}
              kind={a.kind}
              detail={attachmentDetails(a)}
              state={a.status === "failed" ? "failed" : "ready"}
              onOpen={() => actions.onOpenAttachment(a)}
            />
          ))}
        </div>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap">
        {message.content}
      </div>
      <div className="mt-1 flex items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <SiblingNav message={message} busy={busy} onSelect={actions.onSelectSibling} />
        {persisted && (
          <>
            <span className="px-1">
              <Timestamp iso={message.created_at} />
            </span>
            <CopyButton text={message.content} label="Copy message" />
            <ActionButton
              label="Edit message"
              disabled={busy}
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
            </ActionButton>
            {actions.onRemember && (
              <ActionButton label="Remember this" onClick={() => actions.onRemember?.(message)}>
                <BookmarkPlus className="size-3.5" />
              </ActionButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  phase,
  busy,
  isLast,
  actions,
}: {
  message: ChatMessage;
  phase?: string;
  busy: boolean;
  isLast: boolean;
  actions: MessageActions;
}) {
  const streaming = message.status === "streaming";
  const waiting = streaming && message.content.length === 0;
  const persisted = !message.id.startsWith("local-");
  const canContinue =
    isLast &&
    message.content.trim().length > 0 &&
    (message.status === "cancelled" ||
      message.status === "error" ||
      (message.status === "complete" && message.finish_reason === "length"));

  return (
    <article className="group" aria-busy={streaming}>
      {waiting ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span className="inline-block size-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          {phase === "sending" ? "Sending…" : "Loading model and thinking…"}
        </p>
      ) : (
        <div className={cn(streaming && "streaming-caret")}>
          <Markdown content={message.content} />
        </div>
      )}

      {message.status === "error" && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{message.error ?? "The model failed to respond."}</span>
        </p>
      )}
      {message.status === "complete" && message.finish_reason === "length" && (
        <p className="mt-2 text-xs text-muted-foreground">Stopped at the output token limit.</p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
        <SiblingNav message={message} busy={busy} onSelect={actions.onSelectSibling} />
        {persisted && !streaming && (
          <>
            <CopyButton text={message.content} label="Copy reply" />
            {message.status === "error" ? (
              <ActionButton label="Retry" disabled={busy} onClick={() => actions.onRegenerate(message)}>
                <RotateCcw className="size-3.5" />
              </ActionButton>
            ) : (
              <ActionButton label="Regenerate reply" disabled={busy} onClick={() => actions.onRegenerate(message)}>
                <RefreshCw className="size-3.5" />
              </ActionButton>
            )}
            {actions.onRemember && message.content.trim() && (
              <ActionButton label="Remember this" onClick={() => actions.onRemember?.(message)}>
                <BookmarkPlus className="size-3.5" />
              </ActionButton>
            )}
            {message.memory_ids && message.memory_ids.length > 0 && <MemoryUsed ids={message.memory_ids} />}
            {canContinue && (
              <button
                type="button"
                onClick={() => actions.onContinue(message)}
                disabled={busy}
                className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                <Play className="size-3" /> Continue
              </button>
            )}
          </>
        )}
        <span className="ml-1 flex items-center gap-1.5">
          {message.model_id && <span>{shortModelName(message.model_id)}</span>}
          {message.status === "cancelled" && <span>· Stopped</span>}
          {message.status === "complete" && message.completion_tokens != null && (
            <span>· {message.completion_tokens} tokens</span>
          )}
          {persisted && !streaming && (
            <span>
              · <Timestamp iso={message.created_at} />
            </span>
          )}
        </span>
      </div>
    </article>
  );
}
