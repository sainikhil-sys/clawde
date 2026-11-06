"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiHealth } from "@/hooks/use-api-health";
import { api, type ArtifactDetail, type ArtifactSave } from "@/lib/api";

export function useArtifacts(filter: { conversationId?: string; q?: string } = {}) {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["artifacts", filter],
    queryFn: ({ signal }) => api.artifacts(filter, signal),
    enabled: health.isSuccess,
  });
}

export function useArtifact(id: string | null) {
  return useQuery({
    queryKey: ["artifact", id],
    queryFn: ({ signal }) => api.artifact(id as string, signal),
    enabled: !!id,
  });
}

export function useArtifactVersions(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ["artifact-versions", id],
    queryFn: ({ signal }) => api.artifactVersions(id as string, signal),
    enabled: !!id && enabled,
  });
}

/** Content of a specific version (current version comes from useArtifact). */
export function useArtifactVersion(id: string | null, version: number | null) {
  return useQuery({
    queryKey: ["artifact-version", id, version],
    queryFn: ({ signal }) => api.artifactVersion(id as string, version as number, signal),
    enabled: !!id && version != null,
    staleTime: Infinity, // versions never change
  });
}

export function useArtifactActions() {
  const qc = useQueryClient();
  const settle = (art: ArtifactDetail) => {
    qc.setQueryData(["artifact", art.id], art);
    void qc.invalidateQueries({ queryKey: ["artifact-versions", art.id] });
    void qc.invalidateQueries({ queryKey: ["artifacts"] });
  };
  return {
    create: useMutation({ mutationFn: api.createArtifact, onSuccess: settle }),
    save: useMutation({
      mutationFn: ({ id, content }: { id: string; content: string }) => api.saveArtifact(id, content),
      onSuccess: (r: ArtifactSave) => settle(r.artifact),
    }),
    restore: useMutation({
      mutationFn: ({ id, version }: { id: string; version: number }) => api.restoreArtifactVersion(id, version),
      onSuccess: (r: ArtifactSave) => settle(r.artifact),
    }),
    rename: useMutation({
      mutationFn: ({ id, title }: { id: string; title: string }) => api.renameArtifact(id, title),
      onSuccess: settle,
    }),
    remove: useMutation({
      mutationFn: api.deleteArtifact,
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["artifacts"] }),
    }),
    download: async (id: string, version?: number) => {
      const { blob, filename } = await api.downloadArtifact(id, version);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
