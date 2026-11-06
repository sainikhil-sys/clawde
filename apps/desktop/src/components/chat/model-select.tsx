"use client";

import { ChevronDown } from "lucide-react";

import type { ModelInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

export function modelLabel(m: ModelInfo): string {
  const meta = [m.parameter_size, m.quantization].filter(Boolean).join(" · ");
  return meta ? `${m.display_name}  (${meta})` : m.display_name;
}

/** Short display name for a model id like "ollama:llama3.2:latest". */
export function shortModelName(modelId: string | null): string {
  if (!modelId) return "";
  const ref = modelId.slice(modelId.indexOf(":") + 1);
  return ref.endsWith(":latest") ? ref.slice(0, -":latest".length) : ref;
}

export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelInfo[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <span className="sr-only">Model</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || models.length === 0}
        className={cn(
          "h-8 max-w-56 min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent pr-7 pl-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {value === null && <option value="">Choose a model</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelLabel(m)}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" aria-hidden="true" />
    </label>
  );
}
