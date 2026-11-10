"use client";

import { useState } from "react";

import { shortModelName } from "@/components/chat/model-select";
import { useModels } from "@/hooks/use-chat";
import { formatBytes, useEvalRun, useEvalRuns, useEvalSuites, useLibraryActions } from "@/hooks/use-library";
import { ApiError, type EvalSummary, type SuiteSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

import { pct } from "./model-library";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Capabilities and behaviour, shown separately. Never phrased as "unrestricted" or a safety rating. */
export function EvalSummaryView({ summary }: { summary: EvalSummary }) {
  const suites = Object.entries(summary).filter(
    (e): e is [string, SuiteSummary] => typeof e[1] === "object" && e[1] !== null && "kind" in (e[1] as object),
  );
  const caps = suites.filter(([, s]) => s.kind === "capability");
  const behaviour = suites.filter(([, s]) => s.kind === "behaviour");
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <div aria-label="Capabilities">
        <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Capabilities</p>
        <ul className="space-y-1">
          {caps.map(([key, s]) => (
            <li key={key} className="flex justify-between gap-2">
              <span>{s.title}</span>
              <span className="tabular-nums">
                {s.passed}/{s.total}
                {s.admits_unknown != null && (
                  <span className="text-muted-foreground">
                    {" "}
                    · says &ldquo;don&apos;t know&rdquo; {pct(s.admits_unknown)}
                  </span>
                )}
              </span>
            </li>
          ))}
          {summary.speed && (
            <li className="flex justify-between gap-2 text-muted-foreground">
              <span>Speed</span>
              <span className="tabular-nums">
                {summary.speed.tokens_per_s ?? "?"} tokens/s · first token {summary.speed.first_token_ms ?? "?"} ms
              </span>
            </li>
          )}
          {summary.memory?.loaded_bytes ? (
            <li className="flex justify-between gap-2 text-muted-foreground">
              <span>Memory while running</span>
              <span>{formatBytes(summary.memory.loaded_bytes)}</span>
            </li>
          ) : null}
        </ul>
      </div>
      {behaviour.length > 0 && (
        <div aria-label="Behaviour">
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Behaviour (what it declined)
          </p>
          <ul className="space-y-1">
            {behaviour.map(([key, s]) => (
              <li key={key} className="space-y-0.5">
                <div className="flex justify-between gap-2">
                  <span>Declined reasonable requests</span>
                  <span className="tabular-nums">{pct(s.over_refusal)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Went along with clearly harmful requests</span>
                  <span className="tabular-nums">{pct(s.under_refusal)}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">
            Observed on a small test set and scored by a refusal-phrase heuristic; read the outputs. This describes
            behaviour in these tests, not a safety rating. App safeguards (tool approvals, the sandbox) apply whatever
            the model does.
          </p>
        </div>
      )}
    </div>
  );
}

export function EvaluationsPanel() {
  const models = useModels();
  const suites = useEvalSuites();
  const runs = useEvalRuns();
  const actions = useLibraryActions();
  const [modelId, setModelId] = useState("");
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chatModels = (models.data?.models ?? []).filter((m) => m.chat);
  const selected = chosen ?? suites.data?.map((s) => s.key) ?? [];
  const busy = runs.data?.some((r) => r.status === "running" || r.status === "queued");
  return (
    <div className="space-y-6">
      <section aria-labelledby="new-eval-heading" className="space-y-3 rounded-lg border p-4">
        <h2 id="new-eval-heading" className="font-medium">
          Evaluate a model
        </h2>
        <p className="text-sm text-muted-foreground">
          Small fixed test sets, run with temperature 0 and a fixed seed so results are repeatable. Each output is kept
          so you can check the scoring. Capabilities and behaviour are reported separately.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {suites.data?.map((s) => (
            <label key={s.key} className="flex items-start gap-2 text-sm" title={s.description}>
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(s.key)}
                onChange={(e) =>
                  setChosen(e.target.checked ? [...selected, s.key] : selected.filter((k) => k !== s.key))
                }
              />
              <span>
                {s.title} <span className="text-muted-foreground">({s.cases})</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Model to evaluate"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Choose a model</option>
            {chatModels.map((m) => (
              <option key={m.id} value={m.id}>
                {shortModelName(m.id)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!modelId || selected.length === 0 || busy || actions.startEval.isPending}
            onClick={() => {
              setError(null);
              actions.startEval.mutate(
                { model_id: modelId, suites: selected },
                {
                  onSuccess: (run) => setOpen(run.id),
                  onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't start."),
                },
              );
            }}
            className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
          >
            Run evaluation
          </button>
        </div>
        {busy && <p className="text-xs text-muted-foreground">An evaluation is running; one at a time.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      <section aria-labelledby="eval-history-heading">
        <h2 id="eval-history-heading" className="mb-2 font-medium">
          Results
        </h2>
        {runs.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">No evaluations yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Evaluation runs">
            {runs.data?.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent/50"
                  aria-expanded={open === r.id}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{shortModelName(r.model_id)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.suites.join(", ")} · {dateFormat.format(new Date(r.created_at))}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      r.status === "failed" && "text-destructive",
                      r.status === "running" && "text-foreground",
                      r.status !== "running" && r.status !== "failed" && "text-muted-foreground",
                    )}
                  >
                    {r.status === "running" ? `Running ${r.progress}/${r.total}` : r.status}
                  </span>
                </button>
                {open === r.id && <RunDetail runId={r.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const run = useEvalRun(runId);
  const actions = useLibraryActions();
  const [showAll, setShowAll] = useState(false);
  if (!run.data) return <p className="px-4 pb-3 text-sm text-muted-foreground">Loading…</p>;
  const r = run.data;
  const results = showAll ? r.results : r.results.filter((x) => x.passed === false || x.error);
  return (
    <div className="space-y-3 border-t bg-muted/20 px-4 py-3">
      {r.error && <p className="text-sm text-destructive">{r.error}</p>}
      {Object.keys(r.summary).length > 0 && <EvalSummaryView summary={r.summary} />}
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="h-7 rounded-md border px-2 hover:bg-accent"
        >
          {showAll ? "Show only failures" : `Show all ${r.results.length} outputs`}
        </button>
        {r.status === "running" ? (
          <button
            type="button"
            onClick={() => actions.cancelEval.mutate(r.id)}
            className="h-7 rounded-md border px-2 hover:bg-accent"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => actions.deleteEval.mutate(r.id)}
            className="h-7 rounded-md border px-2 text-destructive hover:bg-destructive/10"
          >
            Delete
          </button>
        )}
        <span className="self-center text-muted-foreground">
          seed {r.seed} · suite versions {Object.values(r.suite_versions).join(", ")}
        </span>
      </div>
      <ul className="space-y-2" aria-label="Evaluation outputs">
        {results.map((x) => (
          <li key={`${x.suite}-${x.case_id}`} className="rounded-md border bg-background p-2 text-xs">
            <p className="flex gap-2">
              <span
                className={cn("font-medium", x.passed ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}
              >
                {x.error ? "error" : x.passed ? "pass" : "fail"}
              </span>
              <span className="text-muted-foreground">
                {x.suite} · {x.case_id}
                {x.category ? ` · ${x.category.replace("_", " ")}` : ""}
              </span>
            </p>
            <p className="mt-1">{x.prompt}</p>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 whitespace-pre-wrap">
              {x.error ?? x.output}
            </pre>
          </li>
        ))}
        {results.length === 0 && <li className="text-xs text-muted-foreground">No failures.</li>}
      </ul>
    </div>
  );
}
