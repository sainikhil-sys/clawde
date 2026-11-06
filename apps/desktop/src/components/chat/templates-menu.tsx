"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookText, Trash2 } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTemplates } from "@/hooks/use-chat";
import { api, ApiError } from "@/lib/api";

/** Insert saved prompts into the composer, or save the current draft as a template. */
export function TemplatesMenu({ draft, onInsert }: { draft: string; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const templates = useTemplates(open);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["templates"] });
  const create = useMutation({ mutationFn: api.createTemplate, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteTemplate, onSuccess: refresh });
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "That didn't work.");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Prompt templates"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BookText className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <h3 className="text-sm font-medium">Prompt templates</h3>
        {templates.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : templates.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load templates.</p>
        ) : templates.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates yet. Save a draft below to reuse it later.</p>
        ) : (
          <ul className="-mx-1 max-h-60 space-y-0.5 overflow-y-auto">
            {templates.data.map((t) => (
              <li key={t.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    onInsert(t.content);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block truncate text-sm">{t.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.content}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete template ${t.name}`}
                  onClick={() => remove.mutate(t.id, { onError: fail })}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate({ name: name.trim(), content: draft }, { onSuccess: () => setName(""), onError: fail });
          }}
        >
          <label htmlFor="template-name" className="text-xs text-muted-foreground">
            Save the current draft as a template
          </label>
          <div className="flex gap-2">
            <input
              id="template-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
              maxLength={200}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
            />
            <button
              type="submit"
              disabled={!name.trim() || !draft.trim() || create.isPending}
              className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
            >
              Save
            </button>
          </div>
          {!draft.trim() && <p className="text-xs text-muted-foreground">Type something in the message box first.</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
      </PopoverContent>
    </Popover>
  );
}
