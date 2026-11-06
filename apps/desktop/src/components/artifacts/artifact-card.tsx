"use client";

import {
  ChevronRight,
  Code2,
  FileText,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Network,
  PieChart,
  Terminal,
} from "lucide-react";

import type { ArtifactKind, ArtifactRef } from "@/lib/api";

import { KIND_LABELS } from "./artifact-viewer";

const ICONS: Record<ArtifactKind, typeof Code2> = {
  html: LayoutTemplate,
  react: LayoutTemplate,
  svg: ImageIcon,
  markdown: FileText,
  mermaid: Network,
  chart: PieChart,
  javascript: Terminal,
  code: Code2,
};

/** Stands in for an `<artifact>` block inside a reply; opens the artifact panel. */
export function ArtifactCard({
  title,
  kind,
  complete,
  streaming,
  artifact,
  onOpen,
}: {
  title: string;
  kind: ArtifactKind;
  complete: boolean;
  /** The reply is still being generated. */
  streaming: boolean;
  /** The saved artifact (absent until the reply finishes). */
  artifact?: ArtifactRef;
  onOpen?: (ref: ArtifactRef) => void;
}) {
  const Icon = ICONS[kind];
  const status = !complete
    ? streaming
      ? "Writing…"
      : "Incomplete: the reply stopped before the artifact was finished"
    : artifact
      ? `${KIND_LABELS[artifact.kind]} · version ${artifact.version}`
      : streaming
        ? "Saving…"
        : "Not saved";
  const clickable = !!artifact && !!onOpen;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => artifact && onOpen?.(artifact)}
      className="my-3 flex w-full max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:border-border"
      aria-label={clickable ? `Open artifact ${artifact?.title ?? title}` : `Artifact ${title}: ${status}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
        {!complete && streaming ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{artifact?.title ?? title}</span>
        <span className="block truncate text-xs text-muted-foreground">{status}</span>
      </span>
      {clickable && <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />}
    </button>
  );
}
