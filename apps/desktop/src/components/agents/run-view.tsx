"use client";

import {
  AlertCircle,
  Ban,
  Check,
  ChevronDown,
  CircleDashed,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Markdown } from "@/components/chat/markdown";
import { shortModelName } from "@/components/chat/model-select";
import { useAgentActions, useLiveAgentRun } from "@/hooks/use-agents";
import { ACTIVE_RUN_STATUSES, ApiError, type AgentRunDetail, type AgentStep } from "@/lib/api";
import { cn } from "@/lib/utils";

import { StatusBadge } from "./agents-index";

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

export function RunView({ runId }: { runId: string }) {
  const { detail, error } = useLiveAgentRun(runId);
  if (!detail) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>
        {gone
          ? "This run doesn't exist (it may have been deleted)."
          : error
            ? "Couldn't load the run; retrying…"
            : "Loading run…"}
      </p>
    );
  }
  return <RunBody run={detail} />;
}

function RunBody({ run }: { run: AgentRunDetail }) {
  const router = useRouter();
  const actions = useAgentActions();
  const [error, setError] = useState<string | null>(null);
  const active = ACTIVE_RUN_STATUSES.includes(run.status);
  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.message : fallback);
  const pending = run.steps.find((s) => s.status === "waiting_approval");

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-start gap-3">
          <h1 className="min-w-0 flex-1 font-heading text-2xl font-medium text-balance">{run.task}</h1>
          <StatusBadge status={run.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {shortModelName(run.model_id)} · up to {run.max_steps} steps
          {run.retry_of && (
            <>
              {" "}
              · retry of{" "}
              <Link href={`/agents/${run.retry_of}`} className="underline">
                an earlier run
              </Link>
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {active ? (
            <button
              type="button"
              onClick={() => actions.cancel.mutate(run.id, { onError: (err) => fail(err, "Couldn't cancel.") })}
              disabled={actions.cancel.isPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
            >
              <Square className="size-3.5" /> Cancel run
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() =>
                  actions.retry.mutate(run.id, {
                    onSuccess: (next) => router.push(`/agents/${next.id}`),
                    onError: (err) => fail(err, "Couldn't retry."),
                  })
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
              >
                <RotateCcw className="size-3.5" /> Retry
              </button>
              <button
                type="button"
                onClick={() =>
                  actions.remove.mutate(run.id, {
                    onSuccess: () => router.push("/agents"),
                    onError: (err) => fail(err, "Couldn't delete."),
                  })
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" /> Delete run
              </button>
            </>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </header>

      {run.plan.length > 0 && (
        <section aria-labelledby="plan-heading" className="rounded-lg border p-4">
          <h2 id="plan-heading" className="text-sm font-medium">
            Plan
          </h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {run.plan.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </section>
      )}

      {pending && <ApprovalCard run={run} step={pending} />}

      <section aria-labelledby="steps-heading">
        <h2 id="steps-heading" className="mb-2 text-sm font-medium">
          Steps
        </h2>
        <ol className="space-y-2" aria-label="Steps">
          {run.steps
            .filter((s) => s.kind !== "plan")
            .map((s) => (
              <StepItem key={s.id} step={s} />
            ))}
          {run.status === "planning" && (
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Planning…
            </li>
          )}
          {run.status === "running" && !run.steps.some((s) => s.status === "running") && (
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Thinking…
            </li>
          )}
        </ol>
      </section>

      {run.status === "completed" && run.result && (
        <section aria-labelledby="result-heading" className="rounded-lg border bg-card p-4">
          <h2 id="result-heading" className="mb-2 text-sm font-medium">
            Result
          </h2>
          <Markdown content={run.result} />
        </section>
      )}
      {run.error && (
        <p className="flex gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {run.error}
        </p>
      )}
    </div>
  );
}

function ApprovalCard({ run, step }: { run: AgentRunDetail; step: AgentStep }) {
  const { decide } = useAgentActions();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = (approve: boolean) =>
    decide.mutate(
      { runId: run.id, stepId: step.id, approve, note: note.trim() },
      { onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't send your decision.") },
    );
  const isCode = step.tool === "python";
  return (
    <section
      aria-labelledby="approval-heading"
      className="rounded-lg border-2 border-amber-500/60 bg-amber-500/5 p-4"
      role="alertdialog"
      aria-describedby="approval-description"
    >
      <h2 id="approval-heading" className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-amber-600" aria-hidden="true" />
        The agent wants to {isCode ? "run code" : step.tool === "write_file" ? "write a file" : `use ${step.tool}`}
      </h2>
      <p id="approval-description" className="mt-1 text-sm text-muted-foreground">
        {step.thought || "No reason given."} Nothing happens until you decide.
      </p>
      <ArgsView step={step} />
      <label htmlFor="approval-note" className="mt-3 block text-xs text-muted-foreground">
        Note for the agent (optional)
      </label>
      <input
        id="approval-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
      />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => send(true)}
          disabled={decide.isPending}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
        >
          <Check className="size-4" /> Approve
        </button>
        <button
          type="button"
          onClick={() => send(false)}
          disabled={decide.isPending}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
        >
          <X className="size-4" /> Deny
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  );
}

function ArgsView({ step }: { step: AgentStep }) {
  const args = step.args;
  if (step.tool === "python" && typeof args.code === "string") {
    return (
      <pre className="mt-3 max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{args.code}</pre>
    );
  }
  if (step.tool === "write_file" && typeof args.path === "string") {
    return (
      <div className="mt-3 space-y-1">
        <p className="text-xs">
          {args.mode === "append" ? "Append to" : "Write"} <code className="rounded bg-muted px-1">{args.path}</code> in
          the workspace:
        </p>
        <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
          {String(args.content ?? "")}
        </pre>
      </div>
    );
  }
  return (
    <pre className="mt-3 max-h-60 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
      {JSON.stringify(args, null, 2)}
    </pre>
  );
}

const STEP_ICON = {
  done: Check,
  error: AlertCircle,
  denied: Ban,
  cancelled: Ban,
  waiting_approval: ShieldAlert,
  running: Loader2,
  pending: CircleDashed,
} as const;

function StepItem({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(step.kind === "final");
  if (step.kind === "note") {
    return <li className="text-xs text-muted-foreground">{step.output}</li>;
  }
  if (step.kind === "final") {
    return (
      <li className="flex gap-2 text-sm">
        <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
        <span>Final answer{step.thought ? `: ${step.thought}` : ""}</span>
      </li>
    );
  }
  if (step.kind === "error") {
    return (
      <li className="flex gap-2 text-sm text-muted-foreground">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>Unusable reply from the model: {step.error} (it was asked to try again)</span>
      </li>
    );
  }
  const Icon = STEP_ICON[step.status];
  const approvalNote =
    step.approval === "approved"
      ? "approved by you"
      : step.approval === "denied"
        ? "denied by you"
        : step.approval === "policy_denied"
          ? "blocked: tool is turned off"
          : step.approval === "auto"
            ? "allowed"
            : null;
  const reduced = step.data.reduced_isolation === true;
  return (
    <li className="rounded-lg border" aria-label={`Step ${step.index}: ${step.tool}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            step.status === "running" && "animate-spin",
            step.status === "done" && "text-emerald-600",
            (step.status === "error" || step.status === "denied") && "text-destructive",
            step.status === "waiting_approval" && "text-amber-600",
          )}
          aria-hidden="true"
        />
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono text-xs">{step.tool}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{step.thought}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {step.status.replace("_", " ")}
          {approvalNote ? ` · ${approvalNote}` : ""}
          {reduced ? " · reduced isolation" : ""}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2 text-xs">
          <ArgsView step={step} />
          {step.output && (
            <div>
              <p className="mb-1 text-muted-foreground">Result</p>
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono whitespace-pre-wrap">
                {step.output}
              </pre>
            </div>
          )}
          {step.error && <p className="text-destructive">{step.error}</p>}
          {step.finished_at && (
            <p className="text-muted-foreground">Finished {timeFormat.format(new Date(step.finished_at))}</p>
          )}
        </div>
      )}
    </li>
  );
}
