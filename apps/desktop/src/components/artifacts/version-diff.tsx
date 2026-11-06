"use client";

import { diffLines } from "diff";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

/** Line-by-line comparison of two versions (unchanged runs longer than 6 lines are collapsed). */
export function VersionDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  const added = parts.filter((p) => p.added).reduce((n, p) => n + (p.count ?? 0), 0);
  const removed = parts.filter((p) => p.removed).reduce((n, p) => n + (p.count ?? 0), 0);

  return (
    <div className="font-mono text-[0.8rem] leading-relaxed" aria-label="Changes">
      <p className="sticky top-0 border-b bg-background px-3 py-1.5 font-sans text-xs text-muted-foreground">
        {added === 0 && removed === 0
          ? "No differences."
          : `+${added} line${added === 1 ? "" : "s"}, −${removed} line${removed === 1 ? "" : "s"}`}
      </p>
      {parts.map((part, i) => {
        const lines = part.value.replace(/\n$/, "").split("\n");
        if (!part.added && !part.removed && lines.length > 6) {
          return (
            <div key={i}>
              <Lines lines={lines.slice(0, 2)} mark=" " />
              <p className="bg-muted/50 px-3 py-0.5 font-sans text-xs text-muted-foreground">
                {lines.length - 4} unchanged lines
              </p>
              <Lines lines={lines.slice(-2)} mark=" " />
            </div>
          );
        }
        return (
          <Lines
            key={i}
            lines={lines}
            mark={part.added ? "+" : part.removed ? "−" : " "}
            className={cn(
              part.added && "bg-emerald-500/12 text-emerald-900 dark:text-emerald-200",
              part.removed && "bg-red-500/12 text-red-900 dark:text-red-200",
            )}
          />
        );
      })}
    </div>
  );
}

function Lines({ lines, mark, className }: { lines: string[]; mark: string; className?: string }) {
  return (
    <div className={className}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-6 shrink-0 text-center select-none opacity-60" aria-hidden="true">
            {mark}
          </span>
          <span className="pr-3 break-all whitespace-pre-wrap">{line || " "}</span>
        </div>
      ))}
    </div>
  );
}
