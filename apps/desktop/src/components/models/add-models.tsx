"use client";

import Link from "next/link";
import { useState } from "react";

import { useAppSettings } from "@/hooks/use-chat";
import { formatBytes, formatParams, useLibraryActions } from "@/hooks/use-library";
import { api, ApiError, streamProgress, type ImportInfo, type Progress } from "@/lib/api";

import { FitBadge } from "./model-library";

function ProgressLine({ p }: { p: Progress | null }) {
  if (!p) return null;
  const frac = p.total ? Math.min(1, (p.completed ?? 0) / p.total) : null;
  return (
    <div className="space-y-1" role="status">
      <p className="text-xs text-muted-foreground">
        {p.status}
        {frac != null && ` (${Math.round(frac * 100)}%)`}
      </p>
      {frac != null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${frac * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function useRunner() {
  const { refreshModels } = useLibraryActions();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    setProgress({ status: "starting" });
    try {
      await streamProgress(path, body, setProgress);
      setProgress({ status: done });
      refreshModels();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };
  return { progress, error, busy, run };
}

export function AddModels() {
  const settings = useAppSettings();
  const online = settings.data?.network_access_enabled ?? false;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {!online && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground lg:col-span-2">
          Downloading needs internet access, which is off. Turn it on in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>{" "}
          (each download is recorded in the activity log). Importing a file you already have works offline.
        </p>
      )}
      <OllamaPull online={online} />
      <HuggingFace online={online} />
      <ImportLocal />
    </div>
  );
}

function OllamaPull({ online }: { online: boolean }) {
  const [name, setName] = useState("");
  const r = useRunner();
  return (
    <section aria-labelledby="pull-heading" className="space-y-3 rounded-lg border p-4">
      <h2 id="pull-heading" className="font-medium">
        From the Ollama library
      </h2>
      <p className="text-sm text-muted-foreground">
        Any model in the Ollama library, for example <code>qwen2.5:0.5b</code>, <code>deepseek-r1:1.5b</code>,{" "}
        <code>mistral</code>, <code>hermes3</code> or <code>dolphin3</code>. Check its size and licence first.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void r.run("/api/models/pull", { name: name.trim() }, "Downloaded. It's now in your library.");
        }}
      >
        <input
          aria-label="Ollama model name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="model:tag"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button
          type="submit"
          disabled={!online || !name.trim() || r.busy}
          className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        >
          Download
        </button>
      </form>
      <ProgressLine p={r.progress} />
      {r.error && <p className="text-sm text-destructive">{r.error}</p>}
    </section>
  );
}

function HuggingFace({ online }: { online: boolean }) {
  const [repo, setRepo] = useState("");
  const r = useRunner();
  return (
    <section aria-labelledby="hf-heading" className="space-y-3 rounded-lg border p-4">
      <h2 id="hf-heading" className="font-medium">
        From Hugging Face (Transformers)
      </h2>
      <p className="text-sm text-muted-foreground">
        A repository with safetensors weights, run in-process on the CPU. Practical only for small models (about 1.5B
        parameters or less). Only weights, config and tokenizer files are downloaded; no code from the repository is
        ever run.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void r.run("/api/models/hf-download", { repo_id: repo.trim() }, "Downloaded. It's now in your library.");
        }}
      >
        <input
          aria-label="Hugging Face repository"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/model"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button
          type="submit"
          disabled={!online || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) || r.busy}
          className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        >
          Download
        </button>
      </form>
      <ProgressLine p={r.progress} />
      {r.error && <p className="text-sm text-destructive">{r.error}</p>}
    </section>
  );
}

function ImportLocal() {
  const [path, setPath] = useState("");
  const [info, setInfo] = useState<ImportInfo | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const r = useRunner();
  return (
    <section aria-labelledby="import-heading" className="space-y-3 rounded-lg border p-4 lg:col-span-2">
      <h2 id="import-heading" className="font-medium">
        Import a file you have
      </h2>
      <p className="text-sm text-muted-foreground">
        A <code>.gguf</code> file (added to Ollama) or a Hugging Face model folder with safetensors weights. Works
        offline. Paste the full path on this computer.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setInfo(null);
          api
            .inspectImport(path.trim())
            .then((i) => {
              setInfo(i);
              setName(
                (i.name ?? i.path.split(/[\\/]/).pop() ?? "model")
                  .toLowerCase()
                  .replace(/\.gguf$/, "")
                  .replace(/[^a-z0-9._-]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 60) || "model",
              );
            })
            .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't read that file."));
        }}
      >
        <input
          aria-label="Path to a model file or folder"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="C:\\models\\model.gguf"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono text-sm"
        />
        <button
          type="submit"
          disabled={!path.trim()}
          className="h-9 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
        >
          Read details
        </button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm" aria-label="Model file details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
            <dt className="text-muted-foreground">Format</dt>
            <dd>{info.format === "gguf" ? "GGUF (imported into Ollama)" : "Safetensors folder (Transformers)"}</dd>
            {info.architecture && (
              <>
                <dt className="text-muted-foreground">Architecture</dt>
                <dd>{info.architecture}</dd>
              </>
            )}
            {(info.parameter_count || info.quantization) && (
              <>
                <dt className="text-muted-foreground">Size</dt>
                <dd>{[formatParams(info.parameter_count), info.quantization].filter(Boolean).join(" · ")}</dd>
              </>
            )}
            <dt className="text-muted-foreground">On disk</dt>
            <dd>{formatBytes(info.size_bytes)}</dd>
            <dt className="text-muted-foreground">Memory (4k context)</dt>
            <dd className="flex items-center gap-2">
              {formatBytes(info.estimated_ram_bytes)}{" "}
              <FitBadge fit={info.fit_total} title="Compared with this computer's memory" />
            </dd>
            <dt className="text-muted-foreground">Licence</dt>
            <dd>{info.license ?? "Not stated in the file"}</dd>
          </dl>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void r.run("/api/models/import", { path: info.path, name }, "Imported. It's now in your library.");
            }}
          >
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">Name in your library</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                pattern="[a-z0-9][a-z0-9._-]*"
                className="h-9 rounded-md border bg-background px-3 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={!name || r.busy}
              className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
            >
              Import
            </button>
          </form>
          <ProgressLine p={r.progress} />
          {r.error && <p className="text-sm text-destructive">{r.error}</p>}
        </div>
      )}
    </section>
  );
}
