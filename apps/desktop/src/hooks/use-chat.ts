"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { api, type AppSettings, type GenerationParams } from "@/lib/api";
import { getTurn, subscribeTurns, type LiveTurn } from "@/lib/chat-store";

export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: ({ signal }) => api.models(signal), staleTime: 30_000 });
}

export function useAppSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => api.settings(signal) });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.updateSettings(patch),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
}

export function useConversations(enabled = true) {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: ({ signal }) => api.conversations(signal),
    enabled,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ["conversation", id],
    queryFn: ({ signal }) => api.conversation(id as string, signal),
    enabled: !!id,
  });
}

export function useLiveTurn(conversationId: string | null): LiveTurn | undefined {
  return useSyncExternalStore(
    subscribeTurns,
    () => getTurn(conversationId),
    () => undefined,
  );
}

export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 1024,
  context_length: 4096,
};
const PARAMS_KEY = "clawde.generation-params";

function readParams(): GenerationParams {
  try {
    const raw = window.localStorage.getItem(PARAMS_KEY);
    if (!raw) return DEFAULT_PARAMS;
    const parsed = JSON.parse(raw) as Partial<GenerationParams>;
    return { ...DEFAULT_PARAMS, ...parsed };
  } catch {
    return DEFAULT_PARAMS;
  }
}

const paramListeners = new Set<() => void>();
let paramsCache: GenerationParams | null = null;

/** Generation controls, remembered per browser (a convenience; behaviour profiles arrive in M11). */
export function useGenerationParams(): [GenerationParams, (p: GenerationParams) => void] {
  const params = useSyncExternalStore(
    (l) => {
      paramListeners.add(l);
      return () => paramListeners.delete(l);
    },
    () => (paramsCache ??= readParams()),
    () => DEFAULT_PARAMS,
  );
  const setParams = useCallback((p: GenerationParams) => {
    paramsCache = p;
    try {
      window.localStorage.setItem(PARAMS_KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable: keep for this session */
    }
    for (const l of paramListeners) l();
  }, []);
  return [params, setParams];
}
