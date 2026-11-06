"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** Polls the API health endpoint so the UI reflects the API starting or stopping. */
export function useApiHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 10_000,
    retry: false,
  });
}
