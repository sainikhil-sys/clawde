"use client";

import { Plus, Search, Shapes, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApiHealth } from "@/hooks/use-api-health";
import { useArtifactActions, useArtifacts } from "@/hooks/use-artifacts";
import { useAppSettings, useUpdateSettings } from "@/hooks/use-chat";
import { ApiError, ARTIFACT_KINDS, type Artifact, type ArtifactKind } from "@/lib/api";

import { KIND_LABELS } from "./artifact-viewer";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const STARTERS: Record<ArtifactKind, string> = {
  html: "<!doctype html>\n<html>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>\n",
  react:
    'import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <button className="m-6 rounded border px-4 py-2" onClick={() => setCount(count + 1)}>\n      Clicked {count} times\n    </button>\n  );\n}\n',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <circle cx="50" cy="50" r="40" fill="#c96442" />\n</svg>\n',
  markdown: "# Title\n\nWrite here.\n",
  mermaid: "graph TD\n  A[Start] --> B[Finish]\n",
  chart:
    '{\n  "type": "bar",\n  "data": {\n    "labels": ["A", "B", "C"],\n    "datasets": [{ "label": "Values", "data": [3, 5, 2] }]\n  }\n}\n',
  javascript: 'console.log("Hello from the sandbox");\n',
  code: "",
};

export function ArtifactsIndex() {
  const health = useApiHealth();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query);
  const list = useArtifacts({ q });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Artifact | null>(null);
  const { remove } = useArtifactActions();
  const [error, setError] = useState<string | null>(null);

  if (!health.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to see your artifacts."}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <ArtifactSettings />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search artifacts"
            placeholder="Search by title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus:border-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" /> New artifact
        </button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading artifacts…</p>
      ) : list.isError ? (
        <p className="text-sm text-destructive">Couldn&apos;t load artifacts.</p>
      ) : list.data.length === 0 ? (
        <section className="rounded-lg border border-dashed px-6 py-12 text-center">
          <Shapes className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 text-base font-medium">{q.trim() ? "No artifacts match" : "No artifacts yet"}</h2>
          {!q.trim() && (
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Ask for a web page, a component, a diagram or a chart in a chat, open a code block from a reply as an
              artifact, or start one here. Previews run in an isolated sandbox with no network access.
            </p>
          )}
        </section>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Artifacts">
          {list.data.map((a) => (
            <li key={a.id} className="group relative">
              <Link
                href={`/artifacts/${a.id}`}
                className="block h-full rounded-lg border bg-card p-4 pr-12 outline-none transition-colors hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block truncate font-medium">{a.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {KIND_LABELS[a.kind]}
                  {a.language ? ` · ${a.language}` : ""} · {a.version_count} version{a.version_count === 1 ? "" : "s"}
                </span>
                <span className="mt-2 block truncate text-xs text-muted-foreground">
                  {a.conversation_title ? `From “${a.conversation_title}” · ` : ""}updated{" "}
                  {dateFormat.format(new Date(a.updated_at))}
                </span>
              </Link>
              <button
                type="button"
                aria-label={`Delete ${a.title}`}
                onClick={() => setDeleting(a)}
                className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewArtifactDialog open={creating} onOpenChange={setCreating} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              All {deleting?.version_count} version{deleting?.version_count === 1 ? "" : "s"} will be permanently
              deleted. The conversation it came from is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onError: (err) => setError(err instanceof ApiError ? err.message : "Delete failed."),
                })
              }
            >
              Delete artifact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ArtifactSettings() {
  const settings = useAppSettings();
  const update = useUpdateSettings();
  return (
    <label className="flex items-start gap-3 rounded-lg border p-4">
      <input
        type="checkbox"
        className="mt-1"
        checked={settings.data?.artifacts_enabled ?? false}
        disabled={!settings.data || update.isPending}
        onChange={(e) => update.mutate({ artifacts_enabled: e.target.checked })}
      />
      <span>
        <span className="block text-sm font-medium">Let models create artifacts</span>
        <span className="block text-sm text-muted-foreground">
          Models are told how to write artifacts (about 350–400 tokens of instructions per message). Small models
          sometimes don&apos;t follow the format; you can always open a code block from a reply as an artifact instead.
        </span>
      </span>
    </label>
  );
}

function NewArtifactDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { create } = useArtifactActions();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ArtifactKind>("html");
  const [language, setLanguage] = useState("python");
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
              {
                kind,
                title: title.trim(),
                content: STARTERS[kind] || `# ${title.trim()}\n`,
                language: kind === "code" ? language.trim() || undefined : undefined,
              },
              {
                onSuccess: (a) => {
                  onOpenChange(false);
                  router.push(`/artifacts/${a.id}`);
                },
                onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't create the artifact."),
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>New artifact</DialogTitle>
            <DialogDescription>It starts with a small example you can edit.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="artifact-title" className="text-sm font-medium">
              Title
            </label>
            <input
              id="artifact-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="artifact-kind" className="text-sm font-medium">
                Type
              </label>
              <select
                id="artifact-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as ArtifactKind)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {ARTIFACT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            {kind === "code" && (
              <div className="flex-1 space-y-1.5">
                <label htmlFor="artifact-language" className="text-sm font-medium">
                  Language
                </label>
                <input
                  id="artifact-language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  maxLength={40}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </div>
            )}
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
              disabled={!title.trim() || create.isPending}
              className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
            >
              Create
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
