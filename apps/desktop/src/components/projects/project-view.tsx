"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Download,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useRef, useState, type ReactNode } from "react";

import { AttachmentChip, AttachmentPreview, attachmentDetails } from "@/components/chat/attachments";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApiHealth } from "@/hooks/use-api-health";
import { useConversations } from "@/hooks/use-chat";
import { ACCEPT } from "@/hooks/use-composer-attachments";
import { useProject, useProjectActions, useProjectKnowledge, useProjectSearch } from "@/hooks/use-projects";
import { api, ApiError, uploadAttachment, type Attachment, type Project } from "@/lib/api";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export function ProjectView({ projectId }: { projectId: string }) {
  const health = useApiHealth();
  const project = useProject(health.isSuccess ? projectId : null);

  if (!health.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to open this project."}
      </p>
    );
  }
  if (project.isPending) return <p className="text-sm text-muted-foreground">Loading project…</p>;
  if (project.isError) {
    const missing = project.error instanceof ApiError && project.error.status === 404;
    return (
      <div className="py-12 text-center">
        <h1 className="font-heading text-2xl font-medium">
          {missing ? "Project not found" : "Couldn't load the project"}
        </h1>
        <Link href="/projects" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          All projects
        </Link>
      </div>
    );
  }
  return <ProjectBody project={project.data} />;
}

function ProjectBody({ project }: { project: Project }) {
  const archived = project.archived_at !== null;
  return (
    <div>
      <ProjectHeader project={project} />
      {archived && (
        <p className="mb-6 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          This project is archived. Unarchive it to start new chats.
        </p>
      )}
      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-8">
          <ProjectConversations project={project} />
          <ProjectSearch projectId={project.id} />
        </div>
        <div className="space-y-8">
          <InstructionsEditor project={project} />
          <KnowledgePanel projectId={project.id} />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id={id} className="text-sm font-medium">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  const router = useRouter();
  const { update, remove, exportZip } = useProjectActions();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [error, setError] = useState<string | null>(null);
  const archived = project.archived_at !== null;

  return (
    <header className="mb-8 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <Link href="/projects" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Projects
        </Link>
        <h1 className="mt-1 font-heading text-3xl font-medium tracking-tight break-words">{project.name}</h1>
        {project.description && <p className="mt-2 max-w-2xl text-muted-foreground">{project.description}</p>}
        {error && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      {!archived && (
        <Link
          href={`/projects/${project.id}/new`}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquarePlus className="size-4" /> New chat
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Project options"
            className="flex size-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => {
              setName(project.name);
              setDescription(project.description);
              setEditing(true);
            }}
          >
            <Pencil /> Edit name and description
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              update.mutate(
                { id: project.id, patch: { archived: !archived } },
                { onError: (e) => setError(errorText(e, "Couldn't update the project.")) },
              )
            }
          >
            {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void exportZip(project.id).catch((e) => setError(errorText(e, "Export failed.")))}
          >
            <Download /> Export as zip
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 /> Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-md">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate(
                { id: project.id, patch: { name: name.trim(), description: description.trim() } },
                { onSuccess: () => setEditing(false), onError: (err) => setError(errorText(err, "Couldn't save.")) },
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>Edit project</DialogTitle>
              <DialogDescription className="sr-only">Change the name and description</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <label htmlFor="edit-project-name" className="text-sm font-medium">
                Name
              </label>
              <input
                id="edit-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-project-description" className="text-sm font-medium">
                Description
              </label>
              <textarea
                id="edit-project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={3}
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
              />
            </div>
            <DialogFooter>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="h-8 rounded-md border px-3 text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || update.isPending}
                className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
              >
                Save
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{project.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {project.conversation_count} chat{project.conversation_count === 1 ? "" : "s"},{" "}
              {project.knowledge_count} knowledge file{project.knowledge_count === 1 ? "" : "s"} and search index will
              be permanently deleted from this computer. Export it first if you want a copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                remove.mutate(project.id, {
                  onSuccess: () => router.push("/projects"),
                  onError: (err) => {
                    setConfirmDelete(false);
                    setError(errorText(err, "Couldn't delete the project."));
                  },
                });
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}

function InstructionsEditor({ project }: { project: Project }) {
  const { update } = useProjectActions();
  const [value, setValue] = useState(project.instructions);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== project.instructions;
  return (
    <Section title="Instructions" description="Given to the model at the start of every chat in this project.">
      <label htmlFor="project-instructions" className="sr-only">
        Project instructions
      </label>
      <textarea
        id="project-instructions"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        rows={7}
        maxLength={20_000}
        placeholder="e.g. Answer as a senior reviewer. Prefer concise bullet points. Our stack is Python 3.12 and PostgreSQL."
        className="w-full resize-y rounded-md border bg-card px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring"
      />
      <div className="mt-2 flex items-center justify-end gap-3 text-xs">
        {error && <span className="text-destructive">{error}</span>}
        {saved && !dirty && <span className="text-muted-foreground">Saved</span>}
        <button
          type="button"
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate(
              { id: project.id, patch: { instructions: value } },
              {
                onSuccess: () => {
                  setSaved(true);
                  setError(null);
                },
                onError: (e) => setError(errorText(e, "Couldn't save.")),
              },
            )
          }
          className="h-7 rounded-md bg-primary px-3 text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
        >
          Save instructions
        </button>
      </div>
    </Section>
  );
}

type Upload = { localId: string; name: string; progress: number; error?: string };

function KnowledgePanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const files = useProjectKnowledge(projectId);
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["project-knowledge", projectId] });
    void qc.invalidateQueries({ queryKey: ["project", projectId] });
  }

  function add(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setUploads((u) => [...u, { localId, name: file.name, progress: 0 }]);
      uploadAttachment(file, {
        projectId,
        onProgress: (p) => setUploads((u) => u.map((x) => (x.localId === localId ? { ...x, progress: p } : x))),
      })
        .then(() => {
          setUploads((u) => u.filter((x) => x.localId !== localId));
          refresh();
        })
        .catch((e) =>
          setUploads((u) =>
            u.map((x) => (x.localId === localId ? { ...x, error: errorText(e, "Upload failed.") } : x)),
          ),
        );
    }
  }

  return (
    <Section
      title="Knowledge"
      description="Files every chat in this project can draw on. The most relevant passages are used for each question."
      action={
        <>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            data-testid="knowledge-input"
            onChange={(e) => {
              if (e.target.files?.length) add(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Upload className="size-3.5" /> Add files
          </button>
        </>
      }
    >
      <div
        className="space-y-1.5"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) add(e.dataTransfer.files);
        }}
      >
        {uploads.map((u) => (
          <AttachmentChip
            key={u.localId}
            name={u.name}
            detail=""
            state={u.error ? "failed" : "uploading"}
            progress={u.progress}
            error={u.error}
            onRemove={u.error ? () => setUploads((list) => list.filter((x) => x.localId !== u.localId)) : undefined}
          />
        ))}
        {files.isPending ? (
          <p className="text-sm text-muted-foreground">Loading files…</p>
        ) : files.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t load files.</p>
        ) : files.data.length === 0 && uploads.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No files yet. Add documents, notes or code, or drop them here.
          </p>
        ) : (
          files.data.map((a) => (
            <AttachmentChip
              key={a.id}
              name={a.filename}
              kind={a.kind}
              detail={attachmentDetails(a)}
              state={a.status === "ready" ? "ready" : a.status === "failed" ? "failed" : "processing"}
              error={a.error ?? undefined}
              onOpen={() => setPreview(a)}
              onRemove={() =>
                api
                  .deleteAttachment(a.id)
                  .then(refresh)
                  .catch((e) => setError(errorText(e, "Couldn't remove the file.")))
              }
            />
          ))
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <AttachmentPreview attachment={preview} open={preview !== null} onOpenChange={(o) => !o && setPreview(null)} />
    </Section>
  );
}

function ProjectConversations({ project }: { project: Project }) {
  const list = useConversations({ projectId: project.id, limit: 200 });
  return (
    <Section title="Chats">
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading chats…</p>
      ) : list.isError ? (
        <p className="text-sm text-destructive">Couldn&apos;t load chats.</p>
      ) : list.data.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          No chats in this project yet.{" "}
          {project.archived_at === null && (
            <Link href={`/projects/${project.id}/new`} className="font-medium text-primary hover:underline">
              Start one
            </Link>
          )}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.data.map((c) => (
            <li key={c.id}>
              <Link
                href={`/chat/${c.id}`}
                className="block px-4 py-3 outline-none hover:bg-accent/40 focus-visible:bg-accent"
              >
                <span className="block truncate text-sm font-medium">{c.title}</span>
                <span className="text-xs text-muted-foreground">
                  {c.message_count} messages · {dateFormat.format(new Date(c.updated_at))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ProjectSearch({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const results = useProjectSearch(projectId, deferred);
  return (
    <Section title="Search this project" description="Chats and knowledge files in this project only.">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <label htmlFor="project-search" className="sr-only">
          Search this project
        </label>
        <input
          id="project-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats and files…"
          className="h-9 w-full rounded-md border bg-card pr-3 pl-9 text-sm outline-none focus:border-ring"
        />
      </div>
      {deferred.trim() && (
        <div className="mt-3">
          {results.isPending ? (
            <p className="text-sm text-muted-foreground">Searching…</p>
          ) : results.isError ? (
            <p className="text-sm text-destructive">Search failed.</p>
          ) : results.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing in this project matches.</p>
          ) : (
            <ul className="divide-y rounded-lg border" aria-label="Project search results">
              {results.data.map((h) => (
                <li key={`${h.kind}-${h.id}`} className="px-4 py-2.5">
                  {h.kind === "conversation" ? (
                    <Link href={`/chat/${h.id}`} className="text-sm font-medium hover:underline">
                      {h.title}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{h.title}</span>
                  )}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {h.kind === "conversation" ? "Chat" : "File"}
                  </span>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{h.snippet}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
