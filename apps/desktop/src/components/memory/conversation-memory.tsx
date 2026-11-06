"use client";

import { Brain, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMemories, useMemoryActions } from "@/hooks/use-memories";
import { ApiError } from "@/lib/api";

import { MemoryDialog } from "./memory-dialog";

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Header button for one conversation: its summary and temporary context. */
export function ConversationMemory({
  conversationId,
  modelId,
  disabled,
}: {
  conversationId: string;
  /** Model used to write the summary (the one selected in the composer). */
  modelId: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memories = useMemories({ conversationId }, open);
  const actions = useMemoryActions();
  const summary = memories.data?.find((m) => m.kind === "summary");
  const temporary = memories.data?.filter((m) => m.kind === "temporary") ?? [];
  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Conversation memory"
            title="Conversation memory"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
          >
            <Brain className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 gap-3">
          <section aria-label="Summary">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Summary</h2>
              <button
                type="button"
                disabled={disabled || !modelId || actions.summarise.isPending}
                onClick={() => {
                  setError(null);
                  actions.summarise.mutate(
                    { conversationId, modelId: modelId ?? undefined },
                    { onError: (err) => fail(err, "Couldn't summarise the conversation.") },
                  );
                }}
                className="h-7 rounded-md border px-2 text-xs hover:bg-accent disabled:opacity-50"
              >
                {actions.summarise.isPending ? "Summarising…" : summary ? "Update summary" : "Summarise"}
              </button>
            </div>
            {memories.isPending ? (
              <p className="mt-1 text-xs text-muted-foreground">Loading…</p>
            ) : summary ? (
              <>
                <p className="mt-1 max-h-48 overflow-y-auto text-xs whitespace-pre-wrap">{summary.content}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Written by {String(summary.meta.model_id ?? "a model")} ·{" "}
                  {dateTimeFormat.format(new Date(summary.updated_at))}. Used for older messages that no longer fit, and
                  recalled in other chats when relevant.
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                No summary yet. A summary is written automatically when the conversation outgrows the context window (if
                enabled in Memory), or you can write one now with the selected model.
              </p>
            )}
          </section>

          <section aria-label="Temporary context" className="border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Temporary context</h2>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent"
              >
                <Plus className="size-3" /> Add
              </button>
            </div>
            {temporary.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Notes for this conversation only, included with every message here.
              </p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {temporary.map((m) => (
                  <li key={m.id} className="flex items-start gap-2 text-xs">
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-pre-wrap">{m.content}</span>
                      {m.expires_at && (
                        <span className="text-muted-foreground">
                          Until {dateTimeFormat.format(new Date(m.expires_at))}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove temporary context"
                      onClick={() => actions.remove.mutate(m.id, { onError: (err) => fail(err, "Delete failed.") })}
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <Link href="/memory" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            Manage all memory
          </Link>
        </PopoverContent>
      </Popover>
      <MemoryDialog open={adding} onOpenChange={setAdding} kinds={["temporary"]} conversationId={conversationId} />
    </>
  );
}
