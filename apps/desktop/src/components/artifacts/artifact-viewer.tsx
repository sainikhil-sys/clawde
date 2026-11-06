"use client";

import { Check, Copy, Download, ExternalLink, History, Maximize2, Minimize2, Pencil, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useArtifact, useArtifactActions, useArtifactVersion, useArtifactVersions } from "@/hooks/use-artifacts";
import { ApiError, type ArtifactDetail, type ArtifactKind } from "@/lib/api";
import { getThemePreference, resolveTheme, subscribePreferences } from "@/lib/preferences";
import { cn } from "@/lib/utils";

import { ArtifactFrame } from "./artifact-frame";
import { CodeEditor } from "./code-editor";
import { VersionDiff } from "./version-diff";

export const KIND_LABELS: Record<ArtifactKind, string> = {
  html: "HTML",
  react: "React",
  svg: "SVG",
  markdown: "Markdown",
  mermaid: "Mermaid",
  chart: "Chart",
  javascript: "JavaScript",
  code: "Code",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribePreferences,
    () => resolveTheme(getThemePreference()),
    () => "light",
  );
}

type Tab = "preview" | "code" | "history";

export function ArtifactViewer({
  artifactId,
  initialVersion,
  onClose,
  variant = "panel",
}: {
  artifactId: string;
  /** Show this version first (e.g. the one a reply produced). Defaults to the current version. */
  initialVersion?: number;
  onClose?: () => void;
  variant?: "panel" | "page";
}) {
  const artifact = useArtifact(artifactId);
  if (artifact.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading artifact…</p>;
  if (artifact.isError) {
    const gone = artifact.error instanceof ApiError && artifact.error.status === 404;
    return (
      <div className="p-4 text-sm">
        <p className={gone ? "text-muted-foreground" : "text-destructive"}>
          {gone ? "This artifact was deleted." : "Couldn't load the artifact."}
        </p>
        {onClose && (
          <button type="button" onClick={onClose} className="mt-2 text-xs underline">
            Close
          </button>
        )}
      </div>
    );
  }
  return (
    <Viewer
      key={artifactId}
      artifact={artifact.data}
      initialVersion={initialVersion}
      onClose={onClose}
      variant={variant}
    />
  );
}

function Viewer({
  artifact,
  initialVersion,
  onClose,
  variant,
}: {
  artifact: ArtifactDetail;
  initialVersion?: number;
  onClose?: () => void;
  variant: "panel" | "page";
}) {
  const theme = useResolvedTheme();
  const runnable = artifact.kind !== "code";
  const [tab, setTab] = useState<Tab>(runnable ? "preview" : "code");
  const [viewing, setViewing] = useState<number>(initialVersion ?? artifact.current_version);
  const [draft, setDraft] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const actions = useArtifactActions();
  const versions = useArtifactVersions(artifact.id, artifact.version_count > 1 || tab === "history");
  const isCurrent = viewing === artifact.current_version;
  const old = useArtifactVersion(artifact.id, isCurrent ? null : viewing);
  const content = isCurrent ? artifact.content : (old.data?.content ?? "");
  const shown = draft ?? content;
  const dirty = draft !== null && draft !== content;

  // A new version arrived (save, restore, or the model updated it): follow it unless the user is editing.
  const [seenCurrent, setSeenCurrent] = useState(artifact.current_version);
  if (artifact.current_version !== seenCurrent) {
    setSeenCurrent(artifact.current_version);
    if (draft === null) setViewing(artifact.current_version);
  }

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);

  function save() {
    if (draft === null) return;
    setError(null);
    actions.save.mutate(
      { id: artifact.id, content: draft },
      {
        onSuccess: (r) => {
          setDraft(null);
          setViewing(r.artifact.current_version);
        },
        onError: (err) => fail(err, "Couldn't save."),
      },
    );
  }

  function restore(version: number) {
    setError(null);
    actions.restore.mutate(
      { id: artifact.id, version },
      {
        onSuccess: (r) => {
          setDraft(null);
          setViewing(r.artifact.current_version);
          setTab(runnable ? "preview" : "code");
        },
        onError: (err) => fail(err, "Couldn't restore that version."),
      },
    );
  }

  return (
    <div
      ref={container}
      className={cn("flex h-full min-h-0 flex-col bg-background", fullscreen && "h-screen")}
      aria-label={`Artifact: ${artifact.title}`}
      role="region"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" title={artifact.title}>
            {artifact.title}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {KIND_LABELS[artifact.kind]}
            {artifact.language ? ` · ${artifact.language}` : ""} · version {viewing} of {artifact.current_version}
            {!isCurrent && " (older version)"}
          </p>
        </div>
        <ToolButton
          label={copied ? "Copied" : "Copy source"}
          onClick={() => {
            void navigator.clipboard.writeText(shown).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </ToolButton>
        <ToolButton
          label="Download"
          onClick={() => actions.download(artifact.id, viewing).catch((err) => fail(err, "Download failed."))}
        >
          <Download className="size-4" />
        </ToolButton>
        {runnable && (
          <ToolButton
            label={fullscreen ? "Exit full screen" : "Full screen"}
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void container.current?.requestFullscreen?.();
            }}
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </ToolButton>
        )}
        {variant === "panel" && (
          <Link
            href={`/artifacts/${artifact.id}`}
            aria-label="Open in Artifacts"
            title="Open in Artifacts"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-4" />
          </Link>
        )}
        {onClose && (
          <ToolButton label="Close artifact" onClick={onClose}>
            <X className="size-4" />
          </ToolButton>
        )}
      </header>

      <div role="tablist" aria-label="Artifact view" className="flex shrink-0 gap-1 border-b px-2 py-1">
        {(runnable ? (["preview", "code", "history"] as const) : (["code", "history"] as const)).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setCompare(null);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              tab === t && "bg-accent font-medium text-foreground",
            )}
          >
            {t === "preview" ? "Preview" : t === "code" ? "Code" : "History"}
          </button>
        ))}
        {dirty && (
          <span className="ml-auto self-center text-xs text-amber-700 dark:text-amber-400">Unsaved changes</span>
        )}
      </div>

      {!isCurrent && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">Viewing version {viewing}.</span>
          <button
            type="button"
            onClick={() => restore(viewing)}
            disabled={actions.restore.isPending}
            className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 hover:bg-accent disabled:opacity-50"
          >
            <RotateCcw className="size-3" /> Restore as current
          </button>
          <button
            type="button"
            onClick={() => setViewing(artifact.current_version)}
            className="h-7 rounded-md px-2 hover:bg-accent"
          >
            Back to current
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "preview" && runnable && (
          <>
            {!isCurrent && old.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">Loading version…</p>
            ) : (
              <ArtifactFrame
                kind={artifact.kind as Exclude<ArtifactKind, "code">}
                source={shown}
                theme={theme}
                className="h-full"
              />
            )}
          </>
        )}
        {tab === "code" && (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
              <CodeEditor
                value={shown}
                onChange={isCurrent ? (v) => setDraft(v) : undefined}
                readOnly={!isCurrent}
                kind={artifact.kind}
                language={artifact.language}
                theme={theme}
              />
            </div>
            {isCurrent && (
              <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-xs">
                <Pencil className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 text-muted-foreground">
                  {dirty
                    ? runnable
                      ? "The preview shows your unsaved changes."
                      : "Unsaved changes."
                    : "Edit the source here; saving adds a new version."}
                </span>
                <button
                  type="button"
                  disabled={!dirty}
                  onClick={() => setDraft(null)}
                  className="h-7 rounded-md border px-2 hover:bg-accent disabled:opacity-40"
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={!dirty || actions.save.isPending}
                  onClick={save}
                  className="h-7 rounded-md bg-primary px-2 text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
                >
                  Save as version {artifact.current_version + 1}
                </button>
              </div>
            )}
          </div>
        )}
        {tab === "history" && (
          <HistoryTab
            artifact={artifact}
            versions={versions.data ?? []}
            loading={versions.isPending}
            viewing={viewing}
            compare={compare}
            onCompare={setCompare}
            onView={(v) => {
              setDraft(null);
              setViewing(v);
              setTab(runnable ? "preview" : "code");
            }}
            onRestore={restore}
          />
        )}
      </div>
      {error && (
        <p className="shrink-0 border-t px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SOURCE_LABEL = { model: "Written by the model", user: "Edited by you", restore: "Restored" } as const;

function HistoryTab({
  artifact,
  versions,
  loading,
  viewing,
  compare,
  onCompare,
  onView,
  onRestore,
}: {
  artifact: ArtifactDetail;
  versions: {
    version: number;
    source: "model" | "user" | "restore";
    note: string;
    created_at: string;
    chars: number;
  }[];
  loading: boolean;
  viewing: number;
  compare: { from: number; to: number } | null;
  onCompare: (c: { from: number; to: number } | null) => void;
  onView: (version: number) => void;
  onRestore: (version: number) => void;
}) {
  if (compare) return <CompareView artifactId={artifact.id} {...compare} onBack={() => onCompare(null)} />;
  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading history…</p>;
  return (
    <ol className="h-full overflow-y-auto p-2" aria-label="Versions">
      {[...versions].reverse().map((v) => (
        <li
          key={v.version}
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-md px-2 py-2 text-sm",
            v.version === viewing && "bg-accent/60",
          )}
        >
          <History className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Version {v.version}
              {v.version === artifact.current_version && (
                <span className="ml-2 rounded-full border px-1.5 text-xs font-normal">current</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {SOURCE_LABEL[v.source]}
              {v.note ? ` · ${v.note}` : ""} · {timeFormat.format(new Date(v.created_at))} · {v.chars.toLocaleString()}{" "}
              characters
            </p>
          </div>
          <div className="flex gap-1 text-xs">
            <button
              type="button"
              onClick={() => onView(v.version)}
              className="h-7 rounded-md border px-2 hover:bg-accent"
            >
              View
            </button>
            {v.version > 1 && (
              <button
                type="button"
                onClick={() => onCompare({ from: v.version - 1, to: v.version })}
                className="h-7 rounded-md border px-2 hover:bg-accent"
              >
                Changes
              </button>
            )}
            {v.version !== artifact.current_version && (
              <>
                <button
                  type="button"
                  onClick={() => onCompare({ from: v.version, to: artifact.current_version })}
                  className="h-7 rounded-md border px-2 hover:bg-accent"
                >
                  Compare with current
                </button>
                <button
                  type="button"
                  onClick={() => onRestore(v.version)}
                  className="h-7 rounded-md border px-2 hover:bg-accent"
                >
                  Restore
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function CompareView({
  artifactId,
  from,
  to,
  onBack,
}: {
  artifactId: string;
  from: number;
  to: number;
  onBack: () => void;
}) {
  const a = useArtifactVersion(artifactId, from);
  const b = useArtifactVersion(artifactId, to);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <button type="button" onClick={onBack} className="h-7 rounded-md border px-2 hover:bg-accent">
          Back
        </button>
        <span className="text-muted-foreground">
          Version {from} → version {to}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {a.isPending || b.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : a.isError || b.isError ? (
          <p className="p-4 text-sm text-destructive">Couldn&apos;t load these versions.</p>
        ) : (
          <VersionDiff before={a.data.content} after={b.data.content} />
        )}
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
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
