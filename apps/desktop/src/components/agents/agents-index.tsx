"use client";

import { Bot, Download, Play, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { shortModelName } from "@/components/chat/model-select";
import { useAgentActions, useAgentRuns, useAgentTools, useSandboxStatus, useWorkspaceFiles } from "@/hooks/use-agents";
import { useApiHealth } from "@/hooks/use-api-health";
import { useAppSettings, useModels } from "@/hooks/use-chat";
import { useProjects } from "@/hooks/use-projects";
import { api, ApiError, type AgentRunStatus, type ToolPolicy, type ToolRisk } from "@/lib/api";
import { cn } from "@/lib/utils";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export const STATUS_LABELS: Record<AgentRunStatus, string> = {
  planning: "Planning",
  running: "Running",
  waiting_approval: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function StatusBadge({ status }: { status: AgentRunStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs",
        status === "waiting_approval" && "border-amber-500/60 text-amber-700 dark:text-amber-400",
        status === "completed" && "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
        (status === "failed" || status === "interrupted") && "border-destructive/50 text-destructive",
        (status === "running" || status === "planning") && "text-foreground",
        status === "cancelled" && "text-muted-foreground",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const RISK_LABELS: Record<ToolRisk, string> = {
  read: "Reads your data",
  compute: "Computation only",
  write: "Writes files",
  execute: "Runs code",
};

export function AgentsIndex() {
  const health = useApiHealth();
  if (!health.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        {health.isPending ? "Connecting to the local API…" : "Start the local API to use agents."}
      </p>
    );
  }
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-8">
        <NewTask />
        <RunHistory />
      </div>
      <div className="space-y-8">
        <SandboxPanel />
        <PermissionsPanel />
        <WorkspacePanel />
      </div>
    </div>
  );
}

function NewTask() {
  const router = useRouter();
  const models = useModels();
  const settings = useAppSettings();
  const projects = useProjects(false);
  const { start } = useAgentActions();
  const [task, setTask] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [maxSteps, setMaxSteps] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const chatModels = useMemo(() => (models.data?.models ?? []).filter((m) => m.chat && m.available), [models.data]);
  const modelId =
    picked ?? chatModels.find((m) => m.id === settings.data?.default_model)?.id ?? chatModels[0]?.id ?? "";

  return (
    <section aria-labelledby="new-task-heading" className="rounded-lg border p-4">
      <h2 id="new-task-heading" className="font-medium">
        New task
      </h2>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start.mutate(
            {
              task: task.trim(),
              model_id: modelId || undefined,
              project_id: projectId || undefined,
              max_steps: maxSteps,
            },
            {
              onSuccess: (run) => router.push(`/agents/${run.id}`),
              onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't start the agent."),
            },
          );
        }}
      >
        <label htmlFor="agent-task" className="sr-only">
          Task
        </label>
        <textarea
          id="agent-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          maxLength={8000}
          placeholder="Describe what the agent should do, e.g. “Summarise notes.md into summary.md”"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="agent-model" className="block text-xs text-muted-foreground">
              Model
            </label>
            <select
              id="agent-model"
              value={modelId}
              onChange={(e) => setPicked(e.target.value)}
              className="h-9 max-w-56 rounded-md border bg-background px-2 text-sm"
            >
              {chatModels.length === 0 && <option value="">No chat models available</option>}
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {shortModelName(m.id)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="agent-project" className="block text-xs text-muted-foreground">
              Project scope
            </label>
            <select
              id="agent-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 max-w-48 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">None (data outside projects)</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="agent-steps" className="block text-xs text-muted-foreground">
              Max steps
            </label>
            <input
              id="agent-steps"
              type="number"
              min={1}
              max={40}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Math.max(1, Math.min(40, Number(e.target.value) || 1)))}
              className="h-9 w-20 rounded-md border bg-background px-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={!task.trim() || !modelId || start.isPending}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Play className="size-4" /> Start agent
          </button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          Reliability depends on the model: small models may need more steps or go off track. Writing files and running
          code always wait for your approval.
        </p>
      </form>
    </section>
  );
}

function RunHistory() {
  const runs = useAgentRuns();
  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading" className="mb-3 font-medium">
        History
      </h2>
      {runs.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : runs.isError ? (
        <p className="text-sm text-destructive">Couldn&apos;t load runs.</p>
      ) : runs.data.length === 0 ? (
        <section className="rounded-lg border border-dashed px-6 py-10 text-center">
          <Bot className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <h3 className="mt-3 text-sm font-medium">No agent runs yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Every run keeps its plan, each tool call with its result, and your approvals.
          </p>
        </section>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Agent runs">
          {runs.data.map((r) => (
            <li key={r.id}>
              <Link
                href={`/agents/${r.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{r.task}</span>
                  <span className="block text-xs text-muted-foreground">
                    {shortModelName(r.model_id)} · {dateFormat.format(new Date(r.created_at))}
                  </span>
                </span>
                <StatusBadge status={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SandboxPanel() {
  const status = useSandboxStatus();
  const { prepareSandbox } = useAgentActions();
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  return (
    <section aria-labelledby="sandbox-heading" className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="sandbox-heading" className="text-sm font-medium">
          Python sandbox
        </h2>
        <button
          type="button"
          aria-label="Check again"
          title="Check again"
          onClick={() => api.sandboxStatus(true).then(() => status.refetch())}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      {!s ? (
        <p className="mt-2 text-xs text-muted-foreground">Checking…</p>
      ) : s.active_tier === "docker" ? (
        <p className="mt-2 flex gap-2 text-xs">
          <ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>
            Docker container: no network, read-only filesystem, 512 MB memory, 1 CPU, no extra privileges. {s.detail}
          </span>
        </p>
      ) : (
        <div className="mt-2 space-y-2 text-xs">
          <p className="flex gap-2">
            <ShieldAlert className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>
              <strong className="font-medium">Reduced isolation.</strong> Code runs as a separate local process (
              {s.fallback_limits}) without your environment variables, but it isn&apos;t cut off from your files or the
              network. Review every run before approving it.
            </span>
          </p>
          <p className="text-muted-foreground">
            {s.docker === "no_image"
              ? `Docker is running; the ${s.image} image needs to be downloaded once.`
              : s.detail}
          </p>
          {s.docker === "no_image" && (
            <>
              <button
                type="button"
                disabled={!s.network_access_enabled || prepareSandbox.isPending}
                onClick={() => {
                  setError(null);
                  prepareSandbox.mutate(undefined, {
                    onError: (err) => setError(err instanceof ApiError ? err.message : "Download failed."),
                  });
                }}
                className="h-7 rounded-md border px-2 hover:bg-accent disabled:opacity-50"
              >
                {prepareSandbox.isPending ? "Downloading…" : `Download ${s.image}`}
              </button>
              {!s.network_access_enabled && (
                <p className="text-muted-foreground">
                  This needs internet access, which is off. Turn it on in{" "}
                  <Link href="/settings" className="underline">
                    Settings
                  </Link>{" "}
                  first.
                </p>
              )}
            </>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}

function PermissionsPanel() {
  const tools = useAgentTools();
  const { setPermission } = useAgentActions();
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="permissions-heading" className="rounded-lg border p-4">
      <h2 id="permissions-heading" className="text-sm font-medium">
        Tool permissions
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Turned-off tools are never offered to the model. Writing files and running code always ask first.
      </p>
      {tools.isPending ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : tools.isError ? (
        <p className="mt-2 text-xs text-destructive">Couldn&apos;t load tools.</p>
      ) : (
        <ul className="mt-3 space-y-2.5" aria-label="Tools">
          {tools.data.map((t) => (
            <li key={t.name} className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs">{t.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {RISK_LABELS[t.risk]}
                  {t.needs_project ? " · project runs only" : ""}
                </span>
              </span>
              <select
                aria-label={`Permission for ${t.name}`}
                value={t.policy}
                onChange={(e) => {
                  setError(null);
                  setPermission.mutate(
                    { [t.name]: e.target.value as ToolPolicy },
                    { onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't save.") },
                  );
                }}
                className="h-7 rounded-md border bg-background px-1 text-xs"
              >
                {t.allowed.map((p) => (
                  <option key={p} value={p}>
                    {p === "auto" ? "Allow" : p === "ask" ? "Ask first" : "Off"}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}

function WorkspacePanel() {
  const files = useWorkspaceFiles();
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="workspace-heading" className="rounded-lg border p-4">
      <h2 id="workspace-heading" className="text-sm font-medium">
        Workspace
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The only folder the file tools can read and write (inside the app&apos;s data folder).
      </p>
      {files.isPending ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : files.isError ? (
        <p className="mt-2 text-xs text-destructive">Couldn&apos;t list files.</p>
      ) : files.data.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Empty.</p>
      ) : (
        <ul className="mt-2 space-y-1" aria-label="Workspace files">
          {files.data.map((f) => (
            <li key={f.path} className="flex items-center gap-1 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                {f.path}
              </span>
              <span className="text-muted-foreground">{f.size.toLocaleString()} B</span>
              <button
                type="button"
                aria-label={`Download ${f.path}`}
                onClick={() =>
                  api
                    .downloadWorkspaceFile(f.path)
                    .then(({ blob, filename }) => {
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = filename;
                      a.click();
                      URL.revokeObjectURL(url);
                    })
                    .catch(() => setError("Download failed."))
                }
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Download className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${f.path}`}
                onClick={() =>
                  api
                    .deleteWorkspaceFile(f.path)
                    .then(() => files.refetch())
                    .catch(() => setError("Delete failed."))
                }
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
