"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApiHealth } from "@/hooks/use-api-health";
import {
  ACTIVE_RUN_STATUSES,
  api,
  streamAgentRun,
  type AgentRunDetail,
  type AgentStep,
  type ToolPolicy,
} from "@/lib/api";

export function useAgentRuns() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["agent-runs"],
    queryFn: ({ signal }) => api.agentRuns(signal),
    enabled: health.isSuccess,
    // Keep statuses fresh while something is running.
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE_RUN_STATUSES.includes(r.status)) ? 2000 : false),
  });
}

export function useAgentTools() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["agent-tools"],
    queryFn: ({ signal }) => api.agentTools(signal),
    enabled: health.isSuccess,
  });
}

export function useSandboxStatus() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["sandbox-status"],
    queryFn: ({ signal }) => api.sandboxStatus(false, signal),
    enabled: health.isSuccess,
  });
}

export function useWorkspaceFiles() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["workspace-files"],
    queryFn: ({ signal }) => api.workspaceFiles(signal),
    enabled: health.isSuccess,
  });
}

export function useAgentActions() {
  const qc = useQueryClient();
  const runs = () => void qc.invalidateQueries({ queryKey: ["agent-runs"] });
  return {
    start: useMutation({ mutationFn: api.startAgentRun, onSuccess: runs }),
    cancel: useMutation({ mutationFn: api.cancelAgentRun, onSuccess: runs }),
    retry: useMutation({ mutationFn: api.retryAgentRun, onSuccess: runs }),
    remove: useMutation({ mutationFn: api.deleteAgentRun, onSuccess: runs }),
    decide: useMutation({
      mutationFn: ({
        runId,
        stepId,
        approve,
        note,
      }: {
        runId: string;
        stepId: string;
        approve: boolean;
        note?: string;
      }) => api.decideAgentStep(runId, stepId, approve, note),
    }),
    setPermission: useMutation({
      mutationFn: (permissions: Record<string, ToolPolicy>) => api.updateToolPermissions(permissions),
      onSuccess: (tools) => qc.setQueryData(["agent-tools"], tools),
    }),
    prepareSandbox: useMutation({
      mutationFn: api.prepareSandbox,
      onSuccess: (status) => qc.setQueryData(["sandbox-status"], status),
    }),
  };
}

function upsertStep(steps: AgentStep[], step: AgentStep): AgentStep[] {
  const i = steps.findIndex((s) => s.id === step.id);
  const next = i === -1 ? [...steps, step] : steps.map((s, j) => (j === i ? step : s));
  return next.sort((a, b) => a.index - b.index);
}

/** A run with its steps, kept up to date over SSE while it's active (falls back to polling if the stream drops). */
export function useLiveAgentRun(runId: string) {
  const qc = useQueryClient();
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        for await (const ev of streamAgentRun(runId, ctrl.signal)) {
          if (ev.event === "snapshot") setDetail(ev.data);
          else if (ev.event === "run") setDetail((d) => (d ? { ...d, ...ev.data.run } : d));
          else if (ev.event === "step") setDetail((d) => (d ? { ...d, steps: upsertStep(d.steps, ev.data.step) } : d));
        }
        // The stream ends when the run finishes: take one fresh read so nothing between snapshot and end is missed.
        const final = await api.agentRun(runId, ctrl.signal);
        if (!cancelled) {
          setDetail(final);
          void qc.invalidateQueries({ queryKey: ["agent-runs"] });
          void qc.invalidateQueries({ queryKey: ["workspace-files"] });
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err);
        // Retry the stream shortly (e.g. the API restarted).
        window.setTimeout(() => !cancelled && setNonce((n) => n + 1), 2000);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [runId, nonce, qc]);

  return { detail, error, reload: () => setNonce((n) => n + 1), setDetail };
}
