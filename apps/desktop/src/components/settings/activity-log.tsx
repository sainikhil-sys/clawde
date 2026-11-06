"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { useApiHealth } from "@/hooks/use-api-health";
import { api, ApiUnreachableError, type AuditEvent } from "@/lib/api";

const ACTION_LABELS: Record<string, string> = {
  "session.create": "Browser session started",
  "session.end": "Browser session ended",
  "settings.update": "Settings changed",
};

function describe(event: AuditEvent): string {
  const label = ACTION_LABELS[event.action] ?? event.action;
  const changes = event.details.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (!changes) return label;
  const parts = Object.entries(changes).map(([k, v]) => `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`);
  return `${label} (${parts.join(", ")})`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The audit log from the API: what happened, when. Read-only and stored locally. */
export function ActivityLog() {
  const health = useApiHealth();
  const apiUp = health.isSuccess;
  const query = useInfiniteQuery({
    queryKey: ["audit"],
    queryFn: ({ pageParam, signal }) => api.audit({ limit: 20, beforeId: pageParam }, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before_id ?? undefined,
    enabled: apiUp,
  });

  if (!apiUp) {
    return <p className="text-sm text-muted-foreground">Available when the local API is running.</p>;
  }
  if (query.isPending) {
    return <p className="text-sm text-muted-foreground">Loading activity…</p>;
  }
  if (query.isError) {
    const msg = query.error instanceof ApiUnreachableError ? "Lost connection to the local API." : query.error.message;
    return (
      <div className="space-y-2 text-sm">
        <p className="text-destructive">Couldn&apos;t load activity: {msg}</p>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="rounded-md border px-2.5 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      </div>
    );
  }

  const events = query.data.pages.flatMap((p) => p.events);
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity recorded yet.</p>;
  }
  return (
    <div className="space-y-3">
      <ol className="divide-y rounded-md border text-sm">
        {events.map((e) => (
          <li key={e.id} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-4">
            <time dateTime={e.created_at} className="shrink-0 text-xs text-muted-foreground sm:w-40">
              {dateFormat.format(new Date(e.created_at))}
            </time>
            <span className="min-w-0 break-words">{describe(e)}</span>
          </li>
        ))}
      </ol>
      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="rounded-md border px-2.5 py-1 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {query.isFetchingNextPage ? "Loading…" : "Show older"}
        </button>
      )}
    </div>
  );
}
