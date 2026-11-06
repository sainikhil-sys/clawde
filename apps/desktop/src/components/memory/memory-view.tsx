"use client";

import { Brain, Download, FileUp, Pencil, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

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
import { useApiHealth } from "@/hooks/use-api-health";
import { useAppSettings, useUpdateSettings } from "@/hooks/use-chat";
import { useMemories, useMemoryActions, useMemoryStats } from "@/hooks/use-memories";
import { useProjects } from "@/hooks/use-projects";
import { api, ApiError, MEMORY_KINDS, type Memory, type MemoryKind, type MemoryPreview } from "@/lib/api";
import { cn } from "@/lib/utils";

import { KIND_LABELS, MemoryDialog } from "./memory-dialog";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function MemoryView() {
  const health = useApiHealth();
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [query, setQuery] = useState("");
  const list = useMemories({ kind: kind === "all" ? undefined : kind, q: query });
  const stats = useMemoryStats();
  const actions = useMemoryActions();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!health.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to see your memory."}
      </p>
    );
  }

  const fail = (err: unknown, fallback: string) =>
    setNotice({ text: err instanceof ApiError ? err.message : fallback, error: true });

  return (
    <div className="space-y-8">
      <MemorySettings embeddingModel={stats.data?.embedding_model ?? null} />

      <section aria-labelledby="memory-list-heading">
        <h2 id="memory-list-heading" className="sr-only">
          Saved memory
        </h2>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Kind" className="flex flex-wrap gap-1">
            {(["all", ...MEMORY_KINDS] as const).map((k) => {
              const count = k === "all" ? stats.data?.total : stats.data?.counts[k];
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    kind === k && "bg-accent font-medium text-foreground",
                  )}
                >
                  {k === "all" ? "All" : KIND_LABELS[k]}
                  {count !== undefined && <span className="ml-1.5 text-xs text-muted-foreground">{count}</span>}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" /> New memory
            </button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={actions.importFile.isPending}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <FileUp className="size-4" /> {actions.importFile.isPending ? "Importing…" : "Import document"}
            </button>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              data-testid="memory-import-input"
              accept=".pdf,.docx,.xlsx,.csv,.json,.md,.markdown,.txt,.py,.js,.ts,.tsx,.html,.css"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setNotice(null);
                actions.importFile.mutate(
                  { file },
                  {
                    onSuccess: (m) => setNotice({ text: `Imported “${m.title}” as knowledge.` }),
                    onError: (err) => fail(err, "Couldn't import that file."),
                  },
                );
              }}
            />
          </div>
        </div>

        <div className="relative mb-4">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search memory"
            placeholder="Search memory"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus:border-ring"
          />
        </div>

        {notice && (
          <p className={cn("mb-3 text-sm", notice.error ? "text-destructive" : "text-muted-foreground")} role="status">
            {notice.text}
          </p>
        )}

        {list.isPending ? (
          <p className="text-sm text-muted-foreground">Loading memory…</p>
        ) : list.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load memory.</p>
        ) : list.data.length === 0 ? (
          <section className="rounded-lg border border-dashed px-6 py-12 text-center">
            <Brain className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-4 text-base font-medium">
              {query.trim()
                ? "No memory matches"
                : kind === "all"
                  ? "Nothing saved yet"
                  : `No ${KIND_LABELS[kind].toLowerCase()} yet`}
            </h3>
            {!query.trim() && kind === "all" && (
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Save preferences and notes here, use “Remember this” on a message, or summarise a conversation. You can
                see, edit and delete everything Clawde remembers.
              </p>
            )}
          </section>
        ) : (
          <ul className="space-y-3" aria-label="Memories">
            {list.data.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                onEdit={() => setEditing(m)}
                onDelete={() => setDeleting(m)}
                onTogglePin={() =>
                  actions.update.mutate(
                    { id: m.id, patch: { pinned: !m.pinned } },
                    { onError: (err) => fail(err, "Couldn't update the memory.") },
                  )
                }
              />
            ))}
          </ul>
        )}

        <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
          <button
            type="button"
            onClick={() => actions.exportAll().catch((err) => fail(err, "Export failed."))}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
          >
            <Download className="size-4" /> Export all (JSON)
          </button>
          <button
            type="button"
            onClick={() => setDeletingAll(true)}
            disabled={!stats.data?.total}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="size-4" /> Delete all memory
          </button>
        </div>
      </section>

      <RecallInspector />

      <MemoryDialog
        open={creating}
        onOpenChange={setCreating}
        kinds={["preference", "knowledge", "project"]}
        initial={kind === "project" || kind === "knowledge" || kind === "preference" ? { kind } : undefined}
      />
      <MemoryDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} memory={editing ?? undefined} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed immediately and will never be recalled again. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleting && actions.remove.mutate(deleting.id, { onError: (err) => fail(err, "Delete failed.") })
              }
            >
              Delete memory
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deletingAll} onOpenChange={setDeletingAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all memory?</AlertDialogTitle>
            <AlertDialogDescription>
              All {stats.data?.total ?? 0} memories (preferences, summaries, project notes, knowledge and temporary
              context) will be permanently deleted. Conversations and projects are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                actions.removeAll.mutate(undefined, {
                  onSuccess: (r) => setNotice({ text: `Deleted ${r.deleted} memories.` }),
                  onError: (err) => fail(err, "Delete failed."),
                })
              }
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MemorySettings({ embeddingModel }: { embeddingModel: string | null }) {
  const settings = useAppSettings();
  const update = useUpdateSettings();
  const toggles = [
    {
      key: "memory_enabled" as const,
      label: "Use memory in chats",
      help: "Relevant memories are added to the model's context. Each reply shows which ones it used.",
    },
    {
      key: "memory_auto_summarise" as const,
      label: "Summarise long conversations",
      help: "When a conversation outgrows the model's context window, the model writes a summary that stands in for the older messages.",
    },
  ];
  return (
    <section aria-label="Memory settings" className="rounded-lg border p-4">
      <div className="space-y-3">
        {toggles.map((t) => (
          <label key={t.key} className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.data?.[t.key] ?? false}
              disabled={!settings.data || update.isPending}
              onChange={(e) => update.mutate({ [t.key]: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">{t.label}</span>
              <span className="block text-sm text-muted-foreground">{t.help}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
        {embeddingModel ? (
          `Matching by meaning and keywords (embeddings from ${embeddingModel}).`
        ) : (
          <>
            Matching by keywords. Install an embedding model (for example{" "}
            <code className="rounded bg-muted px-1">ollama pull nomic-embed-text</code>) to also match by meaning.
          </>
        )}
      </p>
    </section>
  );
}

function MemoryCard({
  memory: m,
  onEdit,
  onDelete,
  onTogglePin,
}: {
  memory: Memory;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = m.content.length > 280;
  const scope = m.project_id ? (
    <Link href={`/projects/${m.project_id}`} className="hover:underline">
      {m.project_name ?? "Project"}
    </Link>
  ) : null;
  const conversation = m.conversation_id ? (
    <Link href={`/chat/${m.conversation_id}`} className="hover:underline">
      {m.conversation_title ?? "Conversation"}
    </Link>
  ) : null;
  return (
    <li className="rounded-lg border bg-card p-4" aria-label={m.title || m.content.slice(0, 60)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border px-2 py-0.5 text-foreground">{KIND_LABELS[m.kind]}</span>
            {m.pinned && <span className="rounded-full bg-accent px-2 py-0.5 text-foreground">Pinned</span>}
            {scope && <span>Project: {scope}</span>}
            {conversation && <span>Chat: {conversation}</span>}
          </div>
          {m.title && <h3 className="mt-2 truncate font-medium">{m.title}</h3>}
          <p className={cn("mt-1 text-sm whitespace-pre-wrap", !expanded && long && "line-clamp-3")}>{m.content}</p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {expanded ? "Show less" : `Show all (${m.content.length.toLocaleString()} characters)`}
            </button>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Importance {m.importance}/5 ·{" "}
            {m.use_count
              ? `used ${m.use_count}×, last ${dateTimeFormat.format(new Date(m.last_used_at as string))}`
              : "not used yet"}
            {" · "}
            {m.source === "import"
              ? `imported from ${String(m.meta.filename ?? "a file")}`
              : m.source === "summary"
                ? `summarised by ${String(m.meta.model_id ?? "a model")}`
                : m.source === "message"
                  ? "saved from a message"
                  : "added by you"}
            {" · "}
            updated {dateFormat.format(new Date(m.updated_at))}
            {m.expires_at && ` · expires ${dateTimeFormat.format(new Date(m.expires_at))}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <IconButton label={m.pinned ? "Unpin" : "Pin"} onClick={onTogglePin}>
            {m.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </IconButton>
          <IconButton label="Edit memory" onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label="Delete memory" onClick={onDelete}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** Type a message and see exactly which memories would be recalled, with the score breakdown. */
function RecallInspector() {
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [result, setResult] = useState<MemoryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const projects = useProjects(false);

  return (
    <section aria-labelledby="recall-heading" className="rounded-lg border p-4">
      <h2 id="recall-heading" className="font-medium">
        Test recall
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        See which memories a message would bring into a chat, and why. Testing doesn&apos;t count as use.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim()) return;
          setPending(true);
          setError(null);
          api
            .previewMemory({ query: query.trim(), project_id: projectId || undefined })
            .then(setResult)
            .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't test recall."))
            .finally(() => setPending(false));
        }}
      >
        <input
          aria-label="Message to test"
          placeholder="A message you might send…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 min-w-56 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
        />
        <select
          aria-label="Chat location"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Chat outside projects</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              In project: {p.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!query.trim() || pending}
          className="h-9 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
        >
          Test
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {result && (
        <div className="mt-4" aria-label="Recall result">
          <p className="text-sm text-muted-foreground">
            {result.chosen.length === 0
              ? `Nothing would be recalled (${result.candidates} memories in scope).`
              : `${result.chosen.length} passage${result.chosen.length === 1 ? "" : "s"} would be recalled out of ${result.candidates} memories in scope (about ${result.tokens} tokens), matched by ${result.semantic ? "meaning and keywords" : "keywords"}.`}
            {result.skipped_for_budget > 0 &&
              ` ${result.skipped_for_budget} more matched but didn't fit the memory budget.`}
          </p>
          {result.chosen.length > 0 && (
            <table className="mt-2 w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-normal">Memory</th>
                  <th className="py-1 text-right font-normal">Relevance</th>
                  <th className="py-1 text-right font-normal">Importance</th>
                  <th className="py-1 text-right font-normal">Recency</th>
                  <th className="py-1 text-right font-normal">Score</th>
                </tr>
              </thead>
              <tbody>
                {result.chosen.map((c) => (
                  <tr key={`${c.id}-${c.passage}`} className="border-t align-top">
                    <td className="py-1.5 pr-3">
                      <span className="text-xs text-muted-foreground">
                        {KIND_LABELS[c.kind]}
                        {c.pinned ? " · pinned" : c.always ? " · always included" : ""}
                      </span>
                      <span className="block line-clamp-2">{c.title || c.text}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{c.relevance.toFixed(2)}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.importance.toFixed(2)}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.recency.toFixed(2)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{c.score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Score = 0.60 × relevance + 0.25 × importance + 0.15 × recency. Pinned memories come first; preferences and
            temporary context are always eligible; other memories need some relevance to the message.
          </p>
        </div>
      )}
    </section>
  );
}
