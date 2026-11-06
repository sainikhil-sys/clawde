"use client";

import { Archive, ArchiveRestore, Download, Folder, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";

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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConversationActions, useFolders } from "@/hooks/use-chat";
import { ApiError, type Conversation } from "@/lib/api";
import { cn } from "@/lib/utils";

const NO_FOLDER = "__none__";

export function ConversationMenu({
  conversation,
  onDeleted,
  triggerClassName,
}: {
  conversation: Pick<Conversation, "id" | "title" | "pinned" | "archived" | "folder_id">;
  onDeleted?: () => void;
  triggerClassName?: string;
}) {
  const { update, remove, exportAs } = useConversationActions();
  const [open, setOpen] = useState(false);
  const folders = useFolders(open);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [error, setError] = useState<string | null>(null);
  const id = conversation.id;

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : "That didn't work. Is the API running?");

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Options for ${conversation.title}`}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent",
              triggerClassName,
            )}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => {
              setTitle(conversation.title);
              setError(null);
              setRenaming(true);
            }}
          >
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => update.mutate({ id, patch: { pinned: !conversation.pinned } }, { onError: fail })}
          >
            {conversation.pinned ? <PinOff /> : <Pin />} {conversation.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Folder /> Move to folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              {folders.isPending ? (
                <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
              ) : (
                <DropdownMenuRadioGroup
                  value={conversation.folder_id ?? NO_FOLDER}
                  onValueChange={(v) =>
                    update.mutate({ id, patch: { folder_id: v === NO_FOLDER ? null : v } }, { onError: fail })
                  }
                >
                  <DropdownMenuRadioItem value={NO_FOLDER}>No folder</DropdownMenuRadioItem>
                  {folders.data?.map((f) => (
                    <DropdownMenuRadioItem key={f.id} value={f.id}>
                      {f.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
              {folders.data?.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Create folders on the All chats page.</p>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() => update.mutate({ id, patch: { archived: !conversation.archived } }, { onError: fail })}
          >
            {conversation.archived ? <ArchiveRestore /> : <Archive />} {conversation.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void exportAs(id, "markdown").catch(fail)}>
            <Download /> Export as Markdown
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void exportAs(id, "json").catch(fail)}>
            <Download /> Export as JSON
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && !renaming && !confirmDelete && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = title.trim();
              if (!t) return;
              update.mutate({ id, patch: { title: t } }, { onSuccess: () => setRenaming(false), onError: fail });
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription className="sr-only">Enter a new title</DialogDescription>
            </DialogHeader>
            <label htmlFor={`rename-${id}`} className="sr-only">
              Title
            </label>
            <input
              id={`rename-${id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              autoFocus
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <button
                type="button"
                onClick={() => setRenaming(false)}
                className="h-8 rounded-md border px-3 text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || update.isPending}
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
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{conversation.title}&rdquo; and all of its messages, including earlier versions, will be
              permanently deleted from this computer. This can&apos;t be undone. Export it first if you want a copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                remove.mutate(id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    onDeleted?.();
                  },
                  onError: fail,
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
