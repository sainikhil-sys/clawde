"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMemoryActions } from "@/hooks/use-memories";
import { useProjects } from "@/hooks/use-projects";
import { ApiError, type Memory, type MemoryCreate, type MemoryKind } from "@/lib/api";

export const KIND_LABELS: Record<MemoryKind, string> = {
  preference: "Preference",
  summary: "Conversation summary",
  project: "Project memory",
  knowledge: "Knowledge",
  temporary: "Temporary context",
};

export const KIND_HELP: Record<MemoryKind, string> = {
  preference: "Something about you. Included in every chat.",
  summary: "A summary of one conversation. Recalled in other chats when relevant.",
  project: "A note for one project. Only recalled in that project's chats.",
  knowledge: "Reference text. Recalled in any chat when relevant.",
  temporary: "Context for one conversation only, optionally expiring.",
};

const EXPIRY_OPTIONS = [
  { label: "Until I delete it", hours: 0 },
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
];

const MAX_CHARS: Record<MemoryKind, number> = {
  preference: 4000,
  summary: 4000,
  project: 4000,
  knowledge: 200_000,
  temporary: 4000,
};

type CreatableKind = MemoryCreate["kind"];

export type MemoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this memory instead of creating one. */
  memory?: Memory;
  /** Defaults for a new memory. */
  initial?: Partial<MemoryCreate>;
  /** Kinds offered when creating (first is the default). */
  kinds?: CreatableKind[];
  /** Scope for kinds that need one. */
  projectId?: string;
  conversationId?: string;
  onSaved?: (memory: Memory) => void;
};

export function MemoryDialog(props: MemoryDialogProps) {
  // Remount per opening so the form starts from the right values.
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">{props.open && <MemoryForm {...props} />}</DialogContent>
    </Dialog>
  );
}

function MemoryForm({
  onOpenChange,
  memory,
  initial,
  kinds = ["preference", "knowledge", "project"],
  projectId,
  conversationId,
  onSaved,
}: MemoryDialogProps) {
  const { create, update } = useMemoryActions();
  const editing = !!memory;
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? initial?.kind ?? kinds[0]);
  const [title, setTitle] = useState(memory?.title ?? initial?.title ?? "");
  const [content, setContent] = useState(memory?.content ?? initial?.content ?? "");
  const [importance, setImportance] = useState(memory?.importance ?? initial?.importance ?? 3);
  const [pinned, setPinned] = useState(memory?.pinned ?? initial?.pinned ?? false);
  const [expiry, setExpiry] = useState(0);
  const [project, setProject] = useState(memory?.project_id ?? projectId ?? "");
  const [error, setError] = useState<string | null>(null);
  const projects = useProjects(false);
  const needsProject = !editing && kind === "project" && !projectId;
  const pending = create.isPending || update.isPending;
  const tooLong = content.length > MAX_CHARS[kind];

  const submit = () => {
    setError(null);
    const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't save the memory.");
    if (editing) {
      update.mutate(
        { id: memory.id, patch: { title, content, importance, pinned } },
        {
          onSuccess: (m) => {
            onSaved?.(m);
            onOpenChange(false);
          },
          onError: fail,
        },
      );
      return;
    }
    const body: MemoryCreate = {
      ...initial,
      kind: kind as CreatableKind,
      title: title.trim(),
      content: content.trim(),
      importance,
      pinned,
    };
    if (kind === "project") body.project_id = project || undefined;
    if (kind === "temporary") {
      body.conversation_id = conversationId;
      if (expiry) body.expires_in_hours = expiry;
    }
    create.mutate(body, {
      onSuccess: (m) => {
        onSaved?.(m);
        onOpenChange(false);
      },
      onError: fail,
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing ? "Edit memory" : "New memory"}</DialogTitle>
        <DialogDescription>{KIND_HELP[kind]}</DialogDescription>
      </DialogHeader>

      {!editing && kinds.length > 1 && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Kind</legend>
          <div className="flex flex-wrap gap-1.5">
            {kinds.map((k) => (
              <label
                key={k}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm has-checked:border-ring has-checked:bg-accent"
              >
                <input
                  type="radio"
                  name="memory-kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="sr-only"
                />
                {KIND_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {needsProject && (
        <div className="space-y-1.5">
          <label htmlFor="memory-project" className="text-sm font-medium">
            Project
          </label>
          <select
            id="memory-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Choose a project…</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="memory-title" className="text-sm font-medium">
          Title <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id="memory-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="memory-content" className="text-sm font-medium">
          Memory
        </label>
        <textarea
          id="memory-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={kind === "knowledge" ? 8 : 4}
          autoFocus
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        <p className={tooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {content.length.toLocaleString()} / {MAX_CHARS[kind].toLocaleString()} characters
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <label htmlFor="memory-importance" className="text-sm font-medium">
            Importance
          </label>
          <select
            id="memory-importance"
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "(low)" : n === 5 ? "(high)" : ""}
              </option>
            ))}
          </select>
        </div>
        {!editing && kind === "temporary" && (
          <div className="space-y-1.5">
            <label htmlFor="memory-expiry" className="text-sm font-medium">
              Keep for
            </label>
            <select
              id="memory-expiry"
              value={expiry}
              onChange={(e) => setExpiry(Number(e.target.value))}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin (always include when in scope)
        </label>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="h-8 rounded-md border px-3 text-sm hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!content.trim() || tooLong || pending || (needsProject && !project)}
          className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
        >
          {editing ? "Save" : "Save memory"}
        </button>
      </DialogFooter>
    </form>
  );
}
