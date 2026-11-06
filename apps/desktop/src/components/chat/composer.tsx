"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const MAX_HEIGHT_PX = 280;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  generating,
  canSend,
  disabledReason,
  toolbar,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  generating: boolean;
  canSend: boolean;
  /** Shown as the placeholder when sending is not possible. */
  disabledReason?: string;
  toolbar: ReactNode;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with content up to a limit, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const sendable = canSend && !generating && value.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (sendable) onSend();
      }}
      className="rounded-xl border bg-card shadow-xs transition-colors focus-within:border-ring/60"
    >
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (sendable) onSend();
          }
        }}
        placeholder={canSend ? "Message Clawde…" : (disabledReason ?? "Chat is unavailable")}
        className="block max-h-[280px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[0.95rem] leading-relaxed outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">{toolbar}</div>
        {generating ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background outline-none hover:bg-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!sendable}
            aria-label="Send message"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
}
