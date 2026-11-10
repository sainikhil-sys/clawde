"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes, formatParams, useLibraryActions, useModelDetail, useProfiles } from "@/hooks/use-library";
import { ApiError } from "@/lib/api";

import { EvalSummaryView } from "./evaluations";
import { FitBadge } from "./model-library";

export function ModelDetailDialog({ modelId, onClose }: { modelId: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!modelId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {modelId && <Detail modelId={modelId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const detail = useModelDetail(modelId);
  const profiles = useProfiles();
  const actions = useLibraryActions();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLicence, setShowLicence] = useState(false);
  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);
  if (detail.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (detail.isError) return <p className="text-sm text-destructive">Couldn&apos;t load this model.</p>;
  const m = detail.data;
  const rows: [string, string | null][] = [
    ["Model id", m.id],
    ["Provider", m.provider],
    ["Architecture", m.architecture ?? m.family],
    ["Parameters", formatParams(m.parameter_count) ?? m.parameter_size],
    ["Quantization", m.quantization],
    ["Format", m.format],
    ["On disk", formatBytes(m.size_bytes)],
    ["Context window", m.context_length ? `${m.context_length.toLocaleString()} tokens` : null],
    ["Layers", m.details.layers ? String(m.details.layers) : null],
    [
      "Attention heads (KV)",
      m.details.head_count ? `${m.details.head_count} (${m.details.head_count_kv ?? "?"})` : null,
    ],
    ["Capabilities", m.capabilities.join(", ") || null],
  ];
  return (
    <div className="space-y-5">
      <DialogHeader>
        <DialogTitle>{m.display_name}</DialogTitle>
        <DialogDescription>
          Details read from the model itself. Capabilities are what the provider reports; evaluations below show what
          was observed.
        </DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        <dt className="text-muted-foreground">Memory (4k context)</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {formatBytes(m.estimated_ram_bytes)}
          {m.fit_now && <FitBadge fit={m.fit_now} title="Memory free right now" />}
          <span className="text-xs text-muted-foreground">
            {m.fit_total === "wont_fit" ? "too large for this computer" : "fits this computer"}
            {m.estimate_exact ? "" : " (approximate)"}
          </span>
        </dd>
      </dl>

      <section aria-labelledby="licence-heading" className="space-y-1.5">
        <h3 id="licence-heading" className="text-sm font-medium">
          Licence
        </h3>
        <p className="text-sm">{m.license ?? "The model doesn't state a licence. Check its source before using it."}</p>
        {m.license_text && (
          <>
            <button type="button" onClick={() => setShowLicence((v) => !v)} className="text-xs underline">
              {showLicence ? "Hide full licence" : "Show full licence"}
            </button>
            {showLicence && (
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                {m.license_text}
              </pre>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Clawde shows the licence and doesn&apos;t change it; following its terms (and any acceptable-use policy it
          includes) is up to you.
        </p>
      </section>

      <section aria-labelledby="profile-heading" className="space-y-1.5">
        <h3 id="profile-heading" className="text-sm font-medium">
          Behaviour profile
        </h3>
        <select
          aria-label="Behaviour profile for this model"
          value={m.behaviour_profile_id ?? ""}
          onChange={(e) =>
            actions.setModelProfile.mutate(
              { id: m.id, profileId: e.target.value || null },
              { onError: (err) => fail(err, "Couldn't save.") },
            )
          }
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">None</option>
          {profiles.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Used for chats with this model unless the project or chat sets its own.
        </p>
      </section>

      <section aria-labelledby="eval-heading" className="space-y-2">
        <h3 id="eval-heading" className="text-sm font-medium">
          Latest evaluation
        </h3>
        {m.evaluation ? (
          <EvalSummaryView summary={m.evaluation} />
        ) : (
          <p className="text-sm text-muted-foreground">Not evaluated yet. Run one from the Evaluations tab.</p>
        )}
      </section>

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {m.loaded && (
          <button
            type="button"
            onClick={() => actions.unload.mutate(m.id, { onError: (err) => fail(err, "Couldn't unload.") })}
            className="h-8 rounded-md border px-3 text-sm hover:bg-accent"
          >
            Unload from memory
          </button>
        )}
        {(m.provider === "ollama" || m.provider === "transformers") &&
          (confirm ? (
            <>
              <span className="self-center text-sm">Delete the model files? This can&apos;t be undone.</span>
              <button
                type="button"
                onClick={() =>
                  actions.remove.mutate(m.id, { onSuccess: onClose, onError: (err) => fail(err, "Couldn't delete.") })
                }
                className="h-8 rounded-md bg-destructive px-3 text-sm text-white hover:bg-destructive/90"
              >
                Delete model
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="h-8 rounded-md border px-3 text-sm">
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" /> Delete…
            </button>
          ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
