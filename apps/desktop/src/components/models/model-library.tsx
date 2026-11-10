"use client";

import { Cpu, HardDrive, Library, MemoryStick } from "lucide-react";
import { useState } from "react";

import { useApiHealth } from "@/hooks/use-api-health";
import { useModels } from "@/hooks/use-chat";
import { formatBytes, formatParams, useHardware } from "@/hooks/use-library";
import type { Fit, ModelInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

import { AddModels } from "./add-models";
import { EvaluationsPanel } from "./evaluations";
import { ModelDetailDialog } from "./model-detail";
import { ProfilesPanel } from "./profiles";
import { RoutingPanel } from "./routing";

const TABS = [
  { key: "installed", label: "Installed" },
  { key: "add", label: "Add models" },
  { key: "routing", label: "Routing" },
  { key: "profiles", label: "Behaviour profiles" },
  { key: "evaluations", label: "Evaluations" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export const FIT_LABEL: Record<Fit, string> = {
  fits: "Fits",
  tight: "Tight",
  wont_fit: "Won't fit",
  unknown: "Size unknown",
};

export function FitBadge({ fit, title }: { fit: Fit; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        fit === "fits" && "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
        fit === "tight" && "border-amber-500/60 text-amber-700 dark:text-amber-400",
        fit === "wont_fit" && "border-destructive/50 text-destructive",
        fit === "unknown" && "text-muted-foreground",
      )}
    >
      {FIT_LABEL[fit]}
    </span>
  );
}

export function ModelLibrary() {
  const health = useApiHealth();
  const [tab, setTab] = useState<Tab>("installed");
  if (!health.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to see your models."}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      <HardwareStrip />
      <div role="tablist" aria-label="Model Library" className="flex flex-wrap gap-1 border-b pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              tab === t.key && "bg-accent font-medium text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "installed" && <InstalledModels />}
      {tab === "add" && <AddModels />}
      {tab === "routing" && <RoutingPanel />}
      {tab === "profiles" && <ProfilesPanel />}
      {tab === "evaluations" && <EvaluationsPanel />}
    </div>
  );
}

function HardwareStrip() {
  const hw = useHardware();
  const h = hw.data;
  return (
    <section aria-label="Hardware" className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-3">
      <div className="flex items-start gap-2">
        <MemoryStick className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="font-medium">Memory</p>
          <p className="text-muted-foreground">
            {h ? `${formatBytes(h.ram_available)} free of ${formatBytes(h.ram_total)}` : "…"}
          </p>
          {h && h.loaded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Loaded:{" "}
              {h.loaded.map((l) => `${l.model_id.split(":").slice(1).join(":")} (${formatBytes(l.bytes)})`).join(", ")}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Cpu className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="font-medium">CPU</p>
          <p className="text-muted-foreground">{h ? `${Math.round(h.cpu_percent)}% of ${h.cpu_count} threads` : "…"}</p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <HardDrive className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="font-medium">GPU</p>
          <p className="text-muted-foreground" title={h?.gpu_note}>
            {h ? (h.gpu_percent == null ? "Not measured" : `${Math.round(h.gpu_percent)}% (3D engine)`) : "…"}
          </p>
        </div>
      </div>
    </section>
  );
}

function InstalledModels() {
  const models = useModels();
  const [open, setOpen] = useState<string | null>(null);
  if (models.isPending) return <p className="text-sm text-muted-foreground">Loading models…</p>;
  if (models.isError) return <p className="text-sm text-destructive">Couldn&apos;t load models.</p>;
  const { providers } = models.data;
  const list = models.data.models;
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-2 text-xs" aria-label="Providers">
        {providers.map((p) => (
          <li
            key={p.name}
            className={cn(
              "rounded-full border px-2.5 py-1",
              p.status === "ok" ? "text-foreground" : "text-muted-foreground",
            )}
            title={p.message ?? undefined}
          >
            {PROVIDER_LABEL[p.name] ?? p.name}:{" "}
            {p.status === "ok" ? `${p.model_count} model${p.model_count === 1 ? "" : "s"}` : p.message}
          </li>
        ))}
      </ul>
      {list.length === 0 ? (
        <section className="rounded-lg border border-dashed px-6 py-12 text-center">
          <Library className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 text-base font-medium">No models installed</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Add one from the Ollama library or Hugging Face (needs network access), or import a GGUF file you already
            have.
          </p>
        </section>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Installed models">
          {list.map((m) => (
            <li key={m.id}>
              <ModelCard model={m} onOpen={() => setOpen(m.id)} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Memory estimates are for a 4k-token context: the weights plus the attention cache. &ldquo;Fits&rdquo; means it
        fits in the memory free right now; the card also says whether it fits this computer at all.
      </p>
      <ModelDetailDialog modelId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  transformers: "Transformers",
};

function ModelCard({ model: m, onOpen }: { model: ModelInfo; onOpen: () => void }) {
  const evals = m.evaluation;
  const caps = ["instruction", "reasoning", "knowledge", "tools"]
    .map((k) => evals?.[k] as { score: number | null; title: string } | undefined)
    .filter((s): s is { score: number | null; title: string } => !!s && s.score != null);
  const refusal = evals?.refusal as { over_refusal: number | null; under_refusal: number | null } | undefined;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block h-full w-full rounded-lg border bg-card p-4 text-left transition-colors hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${m.display_name} details`}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{m.display_name}</span>
          <span className="block text-xs text-muted-foreground">
            {[
              PROVIDER_LABEL[m.provider] ?? m.provider,
              m.architecture ?? m.family,
              formatParams(m.parameter_count) ?? m.parameter_size,
              m.quantization,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {m.loaded && <span className="rounded-full bg-accent px-2 py-0.5 text-xs">Loaded</span>}
        {!m.chat && <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Embeddings</span>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">On disk</dt>
        <dd>{formatBytes(m.size_bytes)}</dd>
        <dt className="text-muted-foreground">Context</dt>
        <dd>{m.context_length ? `${m.context_length.toLocaleString()} tokens` : "unknown"}</dd>
        <dt className="text-muted-foreground">Memory needed</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          {formatBytes(m.estimated_ram_bytes)}
          {!m.estimate_exact && m.estimated_ram_bytes ? <span className="text-muted-foreground">(approx.)</span> : null}
          {m.fit_now && <FitBadge fit={m.fit_now} title="Compared with the memory free right now" />}
        </dd>
        <dt className="text-muted-foreground">Licence</dt>
        <dd className="truncate" title={m.license ?? undefined}>
          {m.license ?? "Not stated"}
        </dd>
        {m.capabilities.length > 0 && (
          <>
            <dt className="text-muted-foreground">Capabilities</dt>
            <dd>{m.capabilities.join(", ")}</dd>
          </>
        )}
      </dl>
      {m.fit_total === "wont_fit" && (
        <p className="mt-2 text-xs text-destructive">Too large for this computer&apos;s memory.</p>
      )}
      <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
        {evals ? (
          <>
            Evaluated: {caps.map((c) => `${c.title} ${Math.round((c.score ?? 0) * 100)}%`).join(" · ")}
            {refusal && (
              <>
                {" "}
                · Over-refusal {pct(refusal.over_refusal)}, under-refusal {pct(refusal.under_refusal)}
              </>
            )}
          </>
        ) : (
          "Not evaluated yet"
        )}
      </div>
    </button>
  );
}

export function pct(v: number | null | undefined): string {
  return v == null ? "n/a" : `${Math.round(v * 100)}%`;
}
