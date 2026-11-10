"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import {
  api,
  type AppSettings,
  type ConversationFilter,
  type ConversationPatch,
  type GenerationParams,
} from "@/lib/api";
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

export function useConversations(filter: ConversationFilter = {}, enabled = true) {
  return useQuery({
    queryKey: ["conversations", filter],
    queryFn: ({ signal }) => api.conversations(filter, signal),
    enabled,
  });
}

export function useConversationSearch(query: string, enabled = true) {
  const q = query.trim();
  return useQuery({
    queryKey: ["conversation-search", q],
    queryFn: ({ signal }) => api.searchConversations(q, signal),
    enabled: enabled && q.length > 0,
    staleTime: 5_000,
  });
}

export function useFolders(enabled = true) {
  return useQuery({ queryKey: ["folders"], queryFn: ({ signal }) => api.folders(signal), enabled });
}

export function useTemplates(enabled = true) {
  return useQuery({ queryKey: ["templates"], queryFn: ({ signal }) => api.templates(signal), enabled });
}

/** Mutations shared by the sidebar, the history page and the chat header. */
export function useConversationActions() {
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    void qc.invalidateQueries({ queryKey: ["conversation-search"] });
    void qc.invalidateQueries({ queryKey: ["folders"] });
    if (id) void qc.invalidateQueries({ queryKey: ["conversation", id] });
  };
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ConversationPatch }) => api.updateConversation(id, patch),
    onSuccess: (_d, { id }) => refresh(id),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConversation(id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: ["conversation", id] });
      refresh();
    },
  });
  async function exportAs(id: string, format: "markdown" | "json") {
    const { blob, filename } = await api.exportConversation(id, format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return { update, remove, exportAs };
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
  response_format: "text",
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
let customCache: boolean | null = null;

function readCustom(): boolean {
  try {
    return window.localStorage.getItem(PARAMS_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Generation controls, remembered per browser. Until the user changes them they aren't sent, so the chat's
 * behaviour profile (or the app defaults) applies; `resetParams` goes back to that.
 */
export function useGenerationParams(): [
  GenerationParams,
  (p: GenerationParams) => void,
  { custom: boolean; reset: () => void },
] {
  const custom = useSyncExternalStore(
    (l) => {
      paramListeners.add(l);
      return () => paramListeners.delete(l);
    },
    () => (customCache ??= readCustom()),
    () => false,
  );
  const reset = useCallback(() => {
    paramsCache = DEFAULT_PARAMS;
    customCache = false;
    try {
      window.localStorage.removeItem(PARAMS_KEY);
    } catch {
      /* storage unavailable */
    }
    for (const l of paramListeners) l();
  }, []);
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
    customCache = true;
    try {
      window.localStorage.setItem(PARAMS_KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable: keep for this session */
    }
    for (const l of paramListeners) l();
  }, []);
  return [params, setParams, { custom, reset }];
}
