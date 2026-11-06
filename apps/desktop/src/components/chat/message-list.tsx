"use client";

import { AlertCircle } from "lucide-react";

import type { ChatMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

import { shortModelName } from "./model-select";

export function MessageList({
  messages,
  phase,
}: {
  messages: ChatMessage[];
  phase?: "sending" | "streaming" | "settling";
}) {
  return (
    <ol className="space-y-6" aria-label="Conversation">
      {messages.map((m) => (
        <li key={m.id}>
          {m.role === "user" ? <UserMessage message={m} /> : <AssistantMessage message={m} phase={phase} />}
        </li>
      ))}
    </ol>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function AssistantMessage({ message, phase }: { message: ChatMessage; phase?: string }) {
  const streaming = message.status === "streaming";
  const waiting = streaming && message.content.length === 0;
  return (
    <article className="group" aria-busy={streaming}>
      {waiting ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span className="inline-block size-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          {phase === "sending" ? "Sending…" : "Loading model and thinking…"}
        </p>
      ) : (
        <div
          className={cn(
            "text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap",
            streaming &&
              "after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:animate-pulse after:bg-primary/70 after:align-middle after:content-['']",
          )}
        >
          {message.content}
        </div>
      )}

      {message.status === "error" && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{message.error ?? "The model failed to respond."}</span>
        </p>
      )}

      <p className="mt-2 flex gap-2 text-xs text-muted-foreground">
        {message.model_id && <span>{shortModelName(message.model_id)}</span>}
        {message.status === "cancelled" && <span>· Stopped</span>}
        {message.status === "complete" && message.completion_tokens != null && (
          <span>· {message.completion_tokens} tokens</span>
        )}
      </p>
    </article>
  );
}
