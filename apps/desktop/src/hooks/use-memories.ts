"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiHealth } from "@/hooks/use-api-health";
import { api, ApiError, importMemoryFile, type MemoryFilter, type MemoryPatch } from "@/lib/api";

export function useMemories(filter: MemoryFilter = {}, enabled = true) {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["memories", filter],
    queryFn: ({ signal }) => api.memories(filter, signal),
    enabled: enabled && health.isSuccess,
  });
}

export function useMemoryStats() {
  const health = useApiHealth();
  return useQuery({
    queryKey: ["memory-stats"],
    queryFn: ({ signal }) => api.memoryStats(signal),
    enabled: health.isSuccess,
  });
}

/** Memories by id, for showing which ones a reply used. Deleted ones resolve to null. */
export function useMemoryLookup(ids: string[], enabled: boolean) {
  return useQuery({
    queryKey: ["memory-lookup", ids],
    enabled: enabled && ids.length > 0,
    queryFn: ({ signal }) =>
      Promise.all(
        ids.map((id) =>
          api.memory(id, signal).catch((err) => {
            if (err instanceof ApiError && err.status === 404) return null;
            throw err;
          }),
        ),
      ),
  });
}

export function useMemoryActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["memories"] });
    void qc.invalidateQueries({ queryKey: ["memory-stats"] });
    void qc.invalidateQueries({ queryKey: ["memory-lookup"] });
  };
  return {
    create: useMutation({ mutationFn: api.createMemory, onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: MemoryPatch }) => api.updateMemory(id, patch),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: api.deleteMemory, onSuccess: refresh }),
    removeAll: useMutation({ mutationFn: api.deleteAllMemories, onSuccess: refresh }),
    importFile: useMutation({
      mutationFn: ({ file, title }: { file: File; title?: string }) => importMemoryFile(file, title),
      onSuccess: refresh,
    }),
    summarise: useMutation({
      mutationFn: ({ conversationId, modelId }: { conversationId: string; modelId?: string }) =>
        api.summariseConversation(conversationId, modelId ? { model_id: modelId } : {}),
      onSuccess: refresh,
    }),
    exportAll: async () => {
      const { blob, filename } = await api.exportMemories();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
