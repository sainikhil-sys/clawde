"use client";

import { useState } from "react";

import { shortModelName } from "@/components/chat/model-select";
import { useModels } from "@/hooks/use-chat";
import { useLibraryActions, useRouting } from "@/hooks/use-library";
import { api, ApiError, type RouteDecision } from "@/lib/api";

import { FitBadge } from "./model-library";

const TASK_LABEL: Record<string, string> = {
  chat: "General chat",
  code: "Code",
  math: "Maths and calculations",
  document: "Questions about attached files",
  vision: "Images (needs a vision model)",
};

export function RoutingPanel() {
  const routing = useRouting();
  const models = useModels();
  const actions = useLibraryActions();
  const [text, setText] = useState("");
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chatModels = (models.data?.models ?? []).filter((m) => m.chat);
  if (!routing.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const r = routing.data;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="assign-heading" className="space-y-3 rounded-lg border p-4">
        <h2 id="assign-heading" className="font-medium">
          Auto model choice
        </h2>
        <p className="text-sm text-muted-foreground">
          When a chat&apos;s model is set to <strong>Auto</strong>, each message is classified and sent to the model you
          pick for that kind of task, if it fits in free memory. Otherwise the default model, or the largest capable
          model that fits, is used. Every reply shows which model answered and why. Picking a model yourself always
          overrides this.
        </p>
        <ul className="space-y-2">
          {r.tasks.map((task) => (
            <li key={task} className="flex items-center gap-3 text-sm">
              <label htmlFor={`route-${task}`} className="w-56 shrink-0">
                {TASK_LABEL[task] ?? task}
              </label>
              <select
                id={`route-${task}`}
                value={r.assignments[task] ?? ""}
                onChange={(e) =>
                  actions.updateRouting.mutate(
                    { assignments: { ...r.assignments, [task]: e.target.value } },
                    { onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't save.") },
                  )
                }
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">No preference</option>
                {chatModels
                  .filter((m) => task !== "vision" || m.capabilities.includes("vision"))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {shortModelName(m.id)}
                    </option>
                  ))}
              </select>
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-3 border-t pt-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={r.keep_one_model_loaded}
            onChange={(e) => actions.updateRouting.mutate({ keep_one_model_loaded: e.target.checked })}
          />
          <span>
            <span className="block font-medium">Keep one chat model in memory</span>
            <span className="block text-muted-foreground">
              Unload the previous model before switching, so models don&apos;t compete for RAM. Switching takes a few
              seconds longer.
            </span>
          </span>
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      <section aria-labelledby="preview-heading" className="space-y-3 rounded-lg border p-4">
        <h2 id="preview-heading" className="font-medium">
          Try it
        </h2>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            api
              .previewRoute({ text })
              .then(setDecision)
              .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't route that."));
          }}
        >
          <textarea
            aria-label="Message to route"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Type a message to see which model Auto would use"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="h-8 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
          >
            Show choice
          </button>
        </form>
        {decision && (
          <div className="space-y-2 text-sm" aria-label="Routing decision">
            <p>
              <strong>{shortModelName(decision.model_id)}</strong> for a <em>{decision.task}</em> message:{" "}
              {decision.reason}.
            </p>
            <ul className="space-y-1 text-xs">
              {decision.considered.map((c) => (
                <li key={c.model_id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{shortModelName(c.model_id)}</span>
                  <FitBadge fit={c.fit} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
