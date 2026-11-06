"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, ApiUnreachableError, uploadAttachment, type Attachment } from "@/lib/api";

export type PendingFile = {
  localId: string;
  name: string;
  size: number;
  /** Set once the upload finished. */
  attachment?: Attachment;
  progress: number;
  phase: "uploading" | "processing" | "ready" | "failed";
  error?: string;
};

export const MAX_FILES = 10;
/** Shown in the file picker; the server validates content regardless. */
export const ACCEPT =
  ".pdf,.docx,.xlsx,.csv,.tsv,.json,.md,.markdown,.txt,.log,.png,.jpg,.jpeg,.gif,.webp," +
  ".py,.js,.mjs,.ts,.tsx,.jsx,.java,.kt,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.swift,.sh,.ps1,.sql,.r," +
  ".html,.htm,.css,.scss,.xml,.svg,.yaml,.yml,.toml,.ini,.cfg,.vue,.svelte";

function describe(err: unknown): string {
  if (err instanceof ApiUnreachableError) return "Couldn't reach the local API.";
  if (err instanceof ApiError) return err.message;
  return "Upload failed.";
}

/** Files attached in the composer: uploads them immediately and tracks processing until ready. */
export function useComposerAttachments(conversationId: string | null) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const update = useCallback((localId: string, patch: Partial<PendingFile>) => {
    setFiles((list) => list.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));
  }, []);

  const add = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      setFiles((current) => {
        const room = MAX_FILES - current.length;
        const accepted = list.slice(0, Math.max(0, room));
        const rejected = list.slice(accepted.length);
        const next: PendingFile[] = accepted.map((file) => {
          const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const ctrl = new AbortController();
          controllers.current.set(localId, ctrl);
          uploadAttachment(file, {
            conversationId,
            signal: ctrl.signal,
            onProgress: (p) => update(localId, { progress: p }),
          })
            .then((att) => update(localId, { attachment: att, progress: 1, phase: "processing" }))
            .catch((err) => {
              if (err instanceof DOMException && err.name === "AbortError") return;
              update(localId, { phase: "failed", error: describe(err) });
            })
            .finally(() => controllers.current.delete(localId));
          return { localId, name: file.name, size: file.size, progress: 0, phase: "uploading" };
        });
        const tooMany: PendingFile[] = rejected.map((file) => ({
          localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          size: file.size,
          progress: 0,
          phase: "failed",
          error: `Up to ${MAX_FILES} files per message.`,
        }));
        return [...current, ...next, ...tooMany];
      });
    },
    [conversationId, update],
  );

  // Poll processing files until they are ready or failed.
  const processing = files.filter((f) => f.phase === "processing" && f.attachment);
  const processingKey = processing.map((f) => f.localId).join(",");
  useEffect(() => {
    if (!processingKey) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      for (const f of processing) {
        try {
          const att = await api.attachment(f.attachment!.id);
          if (cancelled) return;
          if (att.status === "ready") update(f.localId, { attachment: att, phase: "ready" });
          else if (att.status === "failed")
            update(f.localId, { attachment: att, phase: "failed", error: att.error ?? "The file couldn't be read." });
        } catch {
          /* transient; keep polling */
        }
      }
    }, 600);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the set of processing files changes
  }, [processingKey, update]);

  const remove = useCallback((localId: string) => {
    setFiles((list) => {
      const f = list.find((x) => x.localId === localId);
      controllers.current.get(localId)?.abort();
      // Unsent uploads are deleted on the server so they don't linger.
      if (f?.attachment) void api.deleteAttachment(f.attachment.id).catch(() => undefined);
      return list.filter((x) => x.localId !== localId);
    });
  }, []);

  /** Forget the files after they were sent (they now belong to the message). */
  const clear = useCallback(() => setFiles([]), []);

  const ready = files.filter((f) => f.phase === "ready" && f.attachment);
  const busy = files.some((f) => f.phase === "uploading" || f.phase === "processing");
  const failed = files.some((f) => f.phase === "failed");
  return { files, add, remove, clear, ready, busy, failed };
}
