"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Pencil, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useState, type ReactNode } from "react";

import { useApiHealth } from "@/hooks/use-api-health";
import { useConversationSearch, useConversations, useFolders } from "@/hooks/use-chat";
import { api, ApiError, type Conversation, type ConversationFilter, type Folder } from "@/lib/api";
import { cn } from "@/lib/utils";

import { ConversationMenu } from "./conversation-menu";

type Tab = "all" | "pinned" | "archived";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pinned", label: "Pinned" },
  { id: "archived", label: "Archived" },
];

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function ConversationHistory() {
  const health = useApiHealth();
  const apiUp = health.isSuccess;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [tab, setTab] = useState<Tab>("all");
  const [folderId, setFolderId] = useState<string | undefined>(undefined);

  const filter: ConversationFilter = {
    limit: 200,
    archived: tab === "archived",
    ...(tab === "pinned" ? { pinned: true } : {}),
    ...(folderId ? { folderId } : {}),
  };
  const list = useConversations(filter, apiUp && !deferredQuery);
  const search = useConversationSearch(deferredQuery, apiUp);
  const folders = useFolders(apiUp);

  if (!apiUp) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to see your conversations."}
      </p>
    );
  }

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_14rem]">
      <div className="min-w-0">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <label htmlFor="history-search" className="sr-only">
            Search conversations
          </label>
          <input
            id="history-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles and messages…"
            className="h-10 w-full rounded-lg border bg-card pr-3 pl-9 text-sm outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>

        {deferredQuery ? (
          <SearchResults query={deferredQuery} state={search} />
        ) : (
          <>
            <div role="tablist" aria-label="Filter" className="mt-4 flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    tab === t.id && "bg-accent font-medium text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
              {folderId && (
                <button
                  onClick={() => setFolderId(undefined)}
                  className="ml-auto rounded-md border px-2.5 py-1 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Folder: {folders.data?.find((f) => f.id === folderId)?.name ?? "…"} ✕
                </button>
              )}
            </div>
            {list.isPending ? (
              <Empty>Loading…</Empty>
            ) : list.isError ? (
              <p className="mt-6 text-sm text-destructive">Couldn&apos;t load conversations.</p>
            ) : list.data.length === 0 ? (
              <Empty>
                {tab === "archived"
                  ? "No archived conversations."
                  : tab === "pinned"
                    ? "Nothing pinned. Pin a conversation from its menu."
                    : folderId
                      ? "This folder is empty. Move conversations here from their menu."
                      : "No conversations yet."}
              </Empty>
            ) : (
              <ul className="mt-4 divide-y rounded-lg border">
                {list.data.map((c) => (
                  <Row
                    key={c.id}
                    conversation={c}
                    meta={`${c.message_count} messages · ${dateFormat.format(new Date(c.updated_at))}`}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <FolderPanel
        folders={folders.data ?? []}
        loading={folders.isPending}
        selected={folderId}
        onSelect={setFolderId}
      />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function Row({ conversation, meta, snippet }: { conversation: Conversation; meta: string; snippet?: string }) {
  return (
    <li className="group flex items-start gap-2 px-4 py-3 hover:bg-accent/40">
      <Link href={`/chat/${conversation.id}`} className="min-w-0 flex-1 outline-none focus-visible:underline">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{conversation.title}</span>
          {conversation.pinned && <span className="text-xs text-muted-foreground">Pinned</span>}
          {conversation.archived && <span className="text-xs text-muted-foreground">Archived</span>}
        </span>
        {snippet && <span className="mt-0.5 block truncate text-sm text-muted-foreground">{snippet}</span>}
        <span className="mt-0.5 block text-xs text-muted-foreground">{meta}</span>
      </Link>
      <ConversationMenu conversation={conversation} />
    </li>
  );
}

function SearchResults({ query, state }: { query: string; state: ReturnType<typeof useConversationSearch> }) {
  if (state.isPending) return <Empty>Searching…</Empty>;
  if (state.isError) return <p className="mt-6 text-sm text-destructive">Search failed.</p>;
  if (state.data.length === 0) return <Empty>No conversations match &ldquo;{query}&rdquo;.</Empty>;
  return (
    <ul className="mt-4 divide-y rounded-lg border" aria-label="Search results">
      {state.data.map((h) => (
        <Row
          key={h.conversation.id}
          conversation={h.conversation}
          snippet={h.match === "message" ? h.snippet : undefined}
          meta={`${h.match === "title" ? "Title match" : "Message match"} · ${dateFormat.format(new Date(h.conversation.updated_at))}`}
        />
      ))}
    </ul>
  );
}

function FolderPanel({
  folders,
  loading,
  selected,
  onSelect,
}: {
  folders: Folder[];
  loading: boolean;
  selected?: string;
  onSelect: (id: string | undefined) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["folders"] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "That didn't work.");
  const create = useMutation({ mutationFn: api.createFolder, onSuccess: refresh });
  const rename = useMutation({
    mutationFn: ({ id, n }: { id: string; n: string }) => api.renameFolder(id, n),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteFolder, onSuccess: refresh });

  return (
    <aside aria-labelledby="folders-heading">
      <h2 id="folders-heading" className="text-sm font-medium">
        Folders
      </h2>
      {loading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No folders yet.</p>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {folders.map((f) => (
            <li key={f.id} className="group flex items-center gap-1">
              {editing === f.id ? (
                <form
                  className="flex flex-1 gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!editName.trim()) return;
                    rename.mutate(
                      { id: f.id, n: editName.trim() },
                      { onSuccess: () => setEditing(null), onError: fail },
                    );
                  }}
                >
                  <label htmlFor={`folder-${f.id}`} className="sr-only">
                    Folder name
                  </label>
                  <input
                    id={`folder-${f.id}`}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                    autoFocus
                    maxLength={200}
                    className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-sm outline-none focus:border-ring"
                  />
                </form>
              ) : (
                <button
                  onClick={() => onSelect(selected === f.id ? undefined : f.id)}
                  aria-pressed={selected === f.id}
                  className={cn(
                    "flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    selected === f.id && "bg-accent font-medium",
                  )}
                >
                  <span className="truncate">{f.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{f.conversation_count}</span>
                </button>
              )}
              <button
                aria-label={`Rename folder ${f.name}`}
                onClick={() => {
                  setEditing(f.id);
                  setEditName(f.name);
                }}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                aria-label={`Delete folder ${f.name}`}
                title="Delete folder (conversations are kept)"
                onClick={() =>
                  remove.mutate(f.id, {
                    onSuccess: () => selected === f.id && onSelect(undefined),
                    onError: fail,
                  })
                }
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate(name.trim(), { onSuccess: () => setName(""), onError: fail });
        }}
      >
        <label htmlFor="new-folder" className="sr-only">
          New folder name
        </label>
        <input
          id="new-folder"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New folder"
          maxLength={200}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring"
        />
        <button
          type="submit"
          aria-label="Create folder"
          disabled={!name.trim() || create.isPending}
          className="flex size-8 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FolderPlus className="size-4" />
        </button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">Deleting a folder keeps its conversations.</p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </aside>
  );
}
