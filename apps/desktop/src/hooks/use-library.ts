"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiHealth } from "@/hooks/use-api-health";
import { api, type ProfileInput } from "@/lib/api";

export function useHardware() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["hardware"],
    queryFn: ({ signal }) => api.hardware(signal),
    enabled: health.isSuccess,
    refetchInterval: 5000,
  });
}

export function useModelDetail(id: string | null) {
  return useQuery({
    queryKey: ["model-detail", id],
    queryFn: ({ signal }) => api.modelDetail(id as string, signal),
    enabled: !!id,
  });
}

export function useRouting() {
  const health = useApiHealth();
  return useQuery({ queryKey: ["routing"], queryFn: ({ signal }) => api.routing(signal), enabled: health.isSuccess });
}

export function useProfiles() {
  const health = useApiHealth();
  return useQuery({ queryKey: ["profiles"], queryFn: ({ signal }) => api.profiles(signal), enabled: health.isSuccess });
}

export function useEvalSuites() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["eval-suites"],
    queryFn: ({ signal }) => api.evalSuites(signal),
    enabled: health.isSuccess,
  });
}

export function useEvalRuns(modelId?: string) {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["eval-runs", modelId ?? null],
    queryFn: ({ signal }) => api.evalRuns(modelId, signal),
    enabled: health.isSuccess,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running" || r.status === "queued") ? 1500 : false),
  });
}

export function useEvalRun(id: string | null) {
  return useQuery({
    queryKey: ["eval-run", id],
    queryFn: ({ signal }) => api.evalRun(id as string, signal),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" || q.state.data?.status === "queued" ? 1500 : false),
  });
}

export function useLibraryActions() {
  const qc = useQueryClient();
  const models = () => {
    void qc.invalidateQueries({ queryKey: ["models"] });
    void qc.invalidateQueries({ queryKey: ["model-detail"] });
    void qc.invalidateQueries({ queryKey: ["hardware"] });
  };
  const profiles = () => {
    void qc.invalidateQueries({ queryKey: ["profiles"] });
    models();
  };
  return {
    refreshModels: models,
    setModelProfile: useMutation({
      mutationFn: ({ id, profileId }: { id: string; profileId: string | null }) => api.setModelProfile(id, profileId),
      onSuccess: models,
    }),
    unload: useMutation({ mutationFn: api.unloadModel, onSuccess: models }),
    remove: useMutation({ mutationFn: api.deleteModel, onSuccess: models }),
    updateRouting: useMutation({
      mutationFn: api.updateRouting,
      onSuccess: (data) => qc.setQueryData(["routing"], data),
    }),
    createProfile: useMutation({ mutationFn: api.createProfile, onSuccess: profiles }),
    updateProfile: useMutation({
      mutationFn: ({ id, body }: { id: string; body: ProfileInput }) => api.updateProfile(id, body),
      onSuccess: profiles,
    }),
    deleteProfile: useMutation({ mutationFn: api.deleteProfile, onSuccess: profiles }),
    startEval: useMutation({
      mutationFn: api.startEval,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["eval-runs"] }),
    }),
    cancelEval: useMutation({
      mutationFn: api.cancelEval,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["eval-runs"] }),
    }),
    deleteEval: useMutation({
      mutationFn: api.deleteEval,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["eval-runs"] }),
    }),
  };
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "unknown";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatParams(n: number | null | undefined): string | null {
  if (!n) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  return `${Math.round(n / 1e6)}M`;
}
