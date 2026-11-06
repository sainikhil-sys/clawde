"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApiHealth } from "@/hooks/use-api-health";
import { useProjectActions, useProjects } from "@/hooks/use-projects";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function ProjectsIndex() {
  const health = useApiHealth();
  const [showArchived, setShowArchived] = useState(false);
  const list = useProjects(showArchived);
  const [creating, setCreating] = useState(false);

  if (!health.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to see your projects."}
      </p>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter" className="flex gap-1">
          {[
            { v: false, label: "Active" },
            { v: true, label: "Archived" },
          ].map((t) => (
            <button
              key={t.label}
              role="tab"
              aria-selected={showArchived === t.v}
              onClick={() => setShowArchived(t.v)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                showArchived === t.v && "bg-accent font-medium text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" /> New project
        </button>
      </div>

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      ) : list.isError ? (
        <p className="text-sm text-destructive">Couldn&apos;t load projects.</p>
      ) : list.data.length === 0 ? (
        <section className="rounded-lg border border-dashed px-6 py-12 text-center">
          <FolderKanban className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 text-base font-medium">{showArchived ? "No archived projects" : "No projects yet"}</h2>
          {!showArchived && (
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              A project keeps related chats together with shared instructions and knowledge files that every chat in it
              can draw on.
            </p>
          )}
        </section>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.data.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="block h-full rounded-lg border bg-card p-4 outline-none transition-colors hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block truncate font-medium">{p.name}</span>
                <span className="mt-1 line-clamp-2 block min-h-10 text-sm text-muted-foreground">
                  {p.description || "No description"}
                </span>
                <span className="mt-3 block text-xs text-muted-foreground">
                  {p.conversation_count} chat{p.conversation_count === 1 ? "" : "s"} · {p.knowledge_count} file
                  {p.knowledge_count === 1 ? "" : "s"} · updated {dateFormat.format(new Date(p.updated_at))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { create } = useProjectActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate(
              { name: name.trim(), description: description.trim() },
              {
                onSuccess: (p) => {
                  onOpenChange(false);
                  setName("");
                  setDescription("");
                  router.push(`/projects/${p.id}`);
                },
                onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't create the project."),
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>You can add instructions and knowledge files next.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="project-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              autoFocus
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="project-description" className="text-sm font-medium">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
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
              disabled={!name.trim() || create.isPending}
              className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
            >
              Create project
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
