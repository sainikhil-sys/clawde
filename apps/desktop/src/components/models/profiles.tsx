"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLibraryActions, useProfiles } from "@/hooks/use-library";
import { ApiError, type BehaviourProfile, type ProfileInput } from "@/lib/api";

const EMPTY: ProfileInput = {
  name: "",
  description: "",
  system_prompt: "",
  temperature: null,
  top_p: null,
  max_tokens: null,
  context_length: null,
};

export function ProfilesPanel() {
  const profiles = useProfiles();
  const actions = useLibraryActions();
  const [editing, setEditing] = useState<BehaviourProfile | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A profile is a set of instructions and default settings. Attach one to a model, a project or a single chat;
          the most specific one applies. Settings you change in a chat still win.
        </p>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-primary-foreground"
        >
          <Plus className="size-4" /> New profile
        </button>
      </div>
      {profiles.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : profiles.data?.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No profiles yet.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Behaviour profiles">
          {profiles.data?.map((p) => (
            <li key={p.id} className="rounded-lg border p-4 text-sm">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{p.name}</span>
                  {p.description && <span className="block text-muted-foreground">{p.description}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => setEditing(p)}
                  className="h-7 rounded-md border px-2 text-xs hover:bg-accent"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() =>
                    actions.deleteProfile.mutate(p.id, {
                      onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't delete."),
                    })
                  }
                  className="h-7 rounded-md border px-2 text-xs text-destructive hover:bg-destructive/10"
                >
                  Delete
                </button>
              </div>
              {p.system_prompt && (
                <p className="mt-2 line-clamp-3 text-muted-foreground whitespace-pre-wrap">{p.system_prompt}</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {[
                  p.temperature != null && `temperature ${p.temperature}`,
                  p.max_tokens != null && `max ${p.max_tokens} tokens`,
                  p.context_length != null && `context ${p.context_length}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No sampling overrides"}
                {" · "}used by {p.used_by.models} model{p.used_by.models === 1 ? "" : "s"}, {p.used_by.projects} project
                {p.used_by.projects === 1 ? "" : "s"}, {p.used_by.conversations} chat
                {p.used_by.conversations === 1 ? "" : "s"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ProfileDialog editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ProfileDialog({ editing, onClose }: { editing: BehaviourProfile | "new" | null; onClose: () => void }) {
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {editing !== null && <ProfileForm editing={editing} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function num(v: string): number | null {
  return v.trim() === "" ? null : Number(v);
}

function ProfileForm({ editing, onClose }: { editing: BehaviourProfile | "new"; onClose: () => void }) {
  const actions = useLibraryActions();
  const [form, setForm] = useState<ProfileInput>(editing === "new" ? EMPTY : { ...editing });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ProfileInput>) => setForm((f) => ({ ...f, ...patch }));
  const save = () => {
    const done = {
      onSuccess: onClose,
      onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't save."),
    };
    if (editing === "new") actions.createProfile.mutate(form, done);
    else actions.updateProfile.mutate({ id: editing.id, body: form }, done);
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing === "new" ? "New behaviour profile" : `Edit “${editing.name}”`}</DialogTitle>
        <DialogDescription>Leave a setting empty to keep the app default.</DialogDescription>
      </DialogHeader>
      <label className="block space-y-1 text-sm">
        <span>Name</span>
        <input
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          maxLength={100}
          className="h-9 w-full rounded-md border bg-background px-3"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Description</span>
        <input
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          maxLength={500}
          className="h-9 w-full rounded-md border bg-background px-3"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Instructions</span>
        <textarea
          value={form.system_prompt}
          onChange={(e) => set({ system_prompt: e.target.value })}
          rows={5}
          placeholder="e.g. Answer concisely and cite sources."
          className="w-full rounded-md border bg-background px-3 py-2"
        />
      </label>
      <div className="grid grid-cols-2 gap-3 text-sm">
        {(
          [
            ["temperature", "Temperature", 0, 2, 0.05],
            ["top_p", "Top-p", 0.05, 1, 0.05],
            ["max_tokens", "Max output tokens", 1, 32768, 1],
            ["context_length", "Context window", 512, 131072, 512],
          ] as const
        ).map(([key, label, min, max, step]) => (
          <label key={key} className="space-y-1">
            <span>{label}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={form[key] ?? ""}
              onChange={(e) => set({ [key]: num(e.target.value) })}
              placeholder="default"
              className="h-9 w-full rounded-md border bg-background px-3"
            />
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <button type="button" onClick={onClose} className="h-8 rounded-md border px-3 text-sm">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!form.name.trim()}
          className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        >
          Save profile
        </button>
      </DialogFooter>
    </form>
  );
}
