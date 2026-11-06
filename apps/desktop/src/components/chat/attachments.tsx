"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Download,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  Loader2,
  type LucideIcon,
  X,
} from "lucide-react";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type AttachmentBrief, type AttachmentKind } from "@/lib/api";
import { cn } from "@/lib/utils";

const ICONS: Record<AttachmentKind, LucideIcon> = {
  pdf: FileText,
  docx: FileText,
  markdown: FileText,
  text: FileText,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  json: FileJson,
  code: FileCode,
  image: ImageIcon,
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function kindFromName(name: string): AttachmentKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["xlsx", "csv", "tsv"].includes(ext)) return ext === "xlsx" ? "xlsx" : "csv";
  if (ext === "json") return "json";
  if (["pdf", "docx", "md", "txt", "log", "markdown"].includes(ext)) return ext === "pdf" ? "pdf" : "text";
  return "code";
}

/** One-line description: pages, sheets, rows or dimensions. */
export function attachmentDetails(a: Pick<AttachmentBrief, "kind" | "page_count" | "meta" | "size_bytes">): string {
  const m = a.meta as Record<string, unknown>;
  const parts = [formatBytes(a.size_bytes)];
  if (a.page_count) parts.push(`${a.page_count} page${a.page_count === 1 ? "" : "s"}`);
  if (a.kind === "image" && m.width) parts.push(`${m.width}×${m.height}`);
  if (Array.isArray(m.sheets)) parts.push(`${m.sheets.length} sheet${m.sheets.length === 1 ? "" : "s"}`);
  if (typeof m.rows === "number" && a.kind === "csv") parts.push(`${m.rows} rows`);
  return parts.join(" · ");
}

type ChipProps = {
  name: string;
  kind?: AttachmentKind;
  detail: string;
  state?: "uploading" | "processing" | "ready" | "failed";
  progress?: number;
  error?: string;
  onRemove?: () => void;
  onOpen?: () => void;
};

export function AttachmentChip({ name, kind, detail, state = "ready", progress, error, onRemove, onOpen }: ChipProps) {
  const Icon = ICONS[kind ?? kindFromName(name)];
  const busy = state === "uploading" || state === "processing";
  const status =
    state === "uploading"
      ? `Uploading ${Math.round((progress ?? 0) * 100)}%`
      : state === "processing"
        ? "Reading file…"
        : state === "failed"
          ? (error ?? "Failed")
          : detail;
  return (
    <div
      className={cn(
        "group/chip relative flex max-w-64 min-w-0 items-center gap-2 rounded-lg border bg-background py-1.5 pr-2 pl-2 text-left",
        state === "failed" && "border-destructive/50",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen || state !== "ready"}
        className="flex min-w-0 flex-1 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        aria-label={onOpen && state === "ready" ? `Preview ${name}` : undefined}
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
            state === "failed" && "bg-destructive/10 text-destructive",
          )}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : state === "failed" ? (
            <AlertCircle className="size-4" aria-hidden="true" />
          ) : (
            <Icon className="size-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{name}</span>
          <span
            className={cn("block truncate text-xs text-muted-foreground", state === "failed" && "text-destructive")}
            role={state === "failed" ? "alert" : undefined}
          >
            {status}
          </span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
      )}
      {state === "uploading" && (
        <span
          className="absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-[width]"
          style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** Preview of an uploaded file: the image itself, or its extracted text. */
export function AttachmentPreview({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: AttachmentBrief | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isImage = attachment?.kind === "image";
  const text = useQuery({
    queryKey: ["attachment-text", attachment?.id],
    queryFn: ({ signal }) => api.attachmentText(attachment!.id, 0, 20_000, signal),
    enabled: open && !!attachment && !isImage,
  });
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function download() {
    if (!attachment) return;
    setDownloadError(null);
    try {
      const { blob, filename } = await api.downloadAttachment(attachment.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("Couldn't download the file.");
    }
  }

  const meta = (attachment?.meta ?? {}) as Record<string, unknown>;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{attachment?.filename}</DialogTitle>
          <DialogDescription>{attachment ? attachmentDetails(attachment) : ""}</DialogDescription>
        </DialogHeader>
        {!!meta.no_text_layer && (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            This PDF has no text layer (it may be a scan). Text recognition (OCR) isn&apos;t installed, so the model
            can&apos;t read its contents.
          </p>
        )}
        {!!meta.truncated && (
          <p className="text-xs text-muted-foreground">Very long file: only the first 2 million characters are used.</p>
        )}
        <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
          {attachment && isImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by the local API with the session cookie
            <img
              src={api.attachmentContentUrl(attachment.id)}
              alt={attachment.filename}
              className="mx-auto max-h-[65vh] object-contain"
            />
          ) : text.isPending ? (
            <p className="p-4 text-sm text-muted-foreground">Loading text…</p>
          ) : text.isError ? (
            <p className="p-4 text-sm text-destructive">Couldn&apos;t load the extracted text.</p>
          ) : (
            <pre className="p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {text.data.text}
            </pre>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {text.data?.truncated
              ? `Showing the first ${text.data.text.length.toLocaleString()} of ${text.data.total_chars.toLocaleString()} characters.`
              : isImage
                ? "Original image"
                : "Text extracted from the file, as the model sees it."}
          </span>
          <button
            type="button"
            onClick={() => void download()}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="size-3.5" /> Download original
          </button>
        </div>
        {downloadError && <p className="text-xs text-destructive">{downloadError}</p>}
      </DialogContent>
    </Dialog>
  );
}
