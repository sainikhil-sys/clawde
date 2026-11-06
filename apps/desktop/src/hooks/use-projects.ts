"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiHealth } from "@/hooks/use-api-health";
import { api, type ProjectPatch } from "@/lib/api";

export function useProjects(archived = false) {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["projects", archived],
    queryFn: ({ signal }) => api.projects(archived, signal),
    enabled: health.isSuccess,
  });
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: ({ signal }) => api.project(id as string, signal),
    enabled: !!id,
  });
}

export function useProjectKnowledge(id: string) {
  return useQuery({
    queryKey: ["project-knowledge", id],
    queryFn: ({ signal }) => api.projectKnowledge(id, signal),
    // Keep polling while files are still being read.
    refetchInterval: (q) =>
      q.state.data?.some((a) => a.status === "pending" || a.status === "processing") ? 1000 : false,
  });
}

export function useProjectSearch(id: string, query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["project-search", id, q],
    queryFn: ({ signal }) => api.searchProject(id, q, signal),
    enabled: q.length > 0,
  });
}

export function useProjectActions() {
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: ["projects"] });
    if (id) void qc.invalidateQueries({ queryKey: ["project", id] });
  };
  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: () => refresh(),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ProjectPatch }) => api.updateProject(id, patch),
    onSuccess: (data) => {
      qc.setQueryData(["project", data.id], data);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: ["project", id] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      refresh();
    },
  });
  async function exportZip(id: string) {
    const { blob, filename } = await api.exportProject(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return { create, update, remove, exportZip };
}
