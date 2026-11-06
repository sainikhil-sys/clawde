"use client";

import { Brain } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMemoryLookup } from "@/hooks/use-memories";

import { KIND_LABELS } from "./memory-dialog";

/** "2 memories" under a reply; opens the list of memories that were in the model's context for it. */
export function MemoryUsed({ ids }: { ids: string[] }) {
  const [open, setOpen] = useState(false);
  const lookup = useMemoryLookup(ids, open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Used ${ids.length} saved ${ids.length === 1 ? "memory" : "memories"}`}
        >
          <Brain className="size-3.5" aria-hidden="true" />
          {ids.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-xs font-medium">Saved memory in context for this reply</p>
        {lookup.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : lookup.isError ? (
          <p className="text-xs text-destructive">Couldn&apos;t load these memories.</p>
        ) : (
          <ul className="space-y-2">
            {lookup.data.map((m, i) =>
              m ? (
                <li key={m.id} className="text-xs">
                  <span className="text-muted-foreground">{KIND_LABELS[m.kind]}</span>
                  <span className="line-clamp-2 block">{m.title || m.content}</span>
                </li>
              ) : (
                <li key={ids[i]} className="text-xs text-muted-foreground">
                  A memory that has since been deleted
                </li>
              ),
            )}
          </ul>
        )}
        <Link href="/memory" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Manage memory
        </Link>
      </PopoverContent>
    </Popover>
  );
}
