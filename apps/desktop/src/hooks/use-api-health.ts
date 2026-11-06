"use client";

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { api, type Health } from "@/lib/api";

const noopSubscribe = () => () => {};

/** False during server render and the hydration pass, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export type ApiHealthState = {
  data: Health | undefined;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  refetch: () => void;
};

/**
 * Polls the API health endpoint so the UI reflects the API starting or stopping.
 *
 * Until hydration completes it always reports "pending". With partial prerendering, parts of the page
 * hydrate at different times, and a health result fetched by an earlier part would otherwise make a
 * later part's first client render differ from its server HTML.
 */
export function useApiHealth(): ApiHealthState {
  const hydrated = useHydrated();
  const q = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 10_000,
    retry: false,
  });
  if (!hydrated) {
    return { data: undefined, isPending: true, isSuccess: false, isError: false, refetch: () => void q.refetch() };
  }
  return {
    data: q.data,
    isPending: q.isPending,
    isSuccess: q.isSuccess,
    isError: q.isError,
    refetch: () => void q.refetch(),
  };
}
