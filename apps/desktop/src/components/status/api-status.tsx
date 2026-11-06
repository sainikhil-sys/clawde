"use client";

import { useApiHealth } from "@/hooks/use-api-health";
import { cn } from "@/lib/utils";

type State = "checking" | "connected" | "degraded" | "offline";

function useApiState(): { state: State; version?: string; detail?: string } {
  const { data, isPending, isError } = useApiHealth();
  if (isPending) return { state: "checking" };
  if (isError || !data) return { state: "offline" };
  if (data.status !== "ok") {
    return {
      state: "degraded",
      version: data.version,
      detail: `Database ${data.database.status}, revision ${data.database.revision ?? "none"} (expected ${data.database.head_revision ?? "?"})`,
    };
  }
  return { state: "connected", version: data.version };
}

const LABEL: Record<State, string> = {
  checking: "Checking local API…",
  connected: "Local API connected",
  degraded: "Local API has a database problem",
  offline: "Local API not running",
};

const DOT: Record<State, string> = {
  checking: "bg-muted-foreground/40",
  connected: "bg-primary",
  degraded: "bg-amber-500",
  offline: "bg-destructive",
};

/** One-line status, used on the home page. */
export function ApiStatusLine({ className }: { className?: string }) {
  const { state, version } = useApiState();
  return (
    <p role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <span aria-hidden="true" className={cn("size-2 rounded-full", DOT[state])} />
      {LABEL[state]}
      {version && state === "connected" && <span className="font-mono text-xs">v{version}</span>}
    </p>
  );
}

/** Detailed status with instructions, used in Settings. */
export function ApiStatusPanel() {
  const { state, version, detail } = useApiState();
  return (
    <div className="space-y-3 text-sm">
      <ApiStatusLine className="text-foreground" />
      {state === "connected" && (
        <p className="text-muted-foreground">
          Version <span className="font-mono">{version}</span>. Data is stored in a local SQLite database in your user
          data folder.
        </p>
      )}
      {state === "degraded" && <p className="text-muted-foreground">{detail}</p>}
      {state === "offline" && (
        <div className="space-y-2 text-muted-foreground">
          <p>Start it from the repository folder:</p>
          <pre className="w-fit rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">pnpm dev:api</pre>
          <p>This page checks again every 10 seconds.</p>
        </div>
      )}
    </div>
  );
}
