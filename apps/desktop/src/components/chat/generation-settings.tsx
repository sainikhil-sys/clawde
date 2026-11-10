"use client";

import { SlidersHorizontal } from "lucide-react";
import { useId } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BehaviourProfile, GenerationParams } from "@/lib/api";

type Field = {
  key: Exclude<keyof GenerationParams, "response_format">;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
};

const FIELDS: Field[] = [
  {
    key: "temperature",
    label: "Temperature",
    hint: "Higher is more varied, lower is more focused.",
    min: 0,
    max: 2,
    step: 0.05,
  },
  { key: "top_p", label: "Top-p", hint: "Limits choices to the most likely tokens.", min: 0.05, max: 1, step: 0.05 },
  { key: "max_tokens", label: "Max output tokens", hint: "Upper limit on reply length.", min: 16, max: 8192, step: 16 },
  {
    key: "context_length",
    label: "Context window",
    hint: "Tokens of history the model sees. Larger uses more RAM. Capped at the model's maximum.",
    min: 1024,
    max: 32768,
    step: 1024,
  },
];

export function GenerationSettings({
  params,
  onChange,
  maxContext,
  custom = true,
  onReset,
  profiles,
  profileId,
  onProfileChange,
}: {
  params: GenerationParams;
  onChange: (p: GenerationParams) => void;
  maxContext: number | null;
  /** The user changed these settings (otherwise the behaviour profile or app defaults apply). */
  custom?: boolean;
  onReset?: () => void;
  /** Behaviour profiles, to choose one for this chat. */
  profiles?: BehaviourProfile[];
  profileId?: string | null;
  onProfileChange?: (id: string | null) => void;
}) {
  const baseId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Generation settings"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Generation</h3>
          {custom && onReset && (
            <button
              type="button"
              onClick={onReset}
              className="rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Use defaults
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {custom
            ? "Your settings apply to every chat in this browser."
            : "Using the chat's behaviour profile, or the app defaults. Change a setting to override it."}
        </p>
        {onProfileChange && profiles && (
          <label className="block space-y-1 text-sm">
            <span>Behaviour profile for this chat</span>
            <select
              value={profileId ?? ""}
              onChange={(e) => onProfileChange(e.target.value || null)}
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">From the project or model</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {FIELDS.map((f) => {
          const max = f.key === "context_length" && maxContext ? Math.min(f.max, maxContext) : f.max;
          const id = `${baseId}-${f.key}`;
          const value = params[f.key];
          return (
            <div key={f.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={id} className="text-sm">
                  {f.label}
                </label>
                <span className="font-mono text-xs text-muted-foreground">{value}</span>
              </div>
              <input
                id={id}
                type="range"
                min={f.min}
                max={max}
                step={f.step}
                value={Math.min(value, max)}
                onChange={(e) => onChange({ ...params, [f.key]: Number(e.target.value) })}
                className="w-full accent-[var(--primary)]"
                aria-describedby={`${id}-hint`}
              />
              <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                {f.hint}
              </p>
            </div>
          );
        })}
        <label className="flex items-start gap-2.5 border-t pt-3 text-sm">
          <input
            type="checkbox"
            checked={params.response_format === "json"}
            onChange={(e) => onChange({ ...params, response_format: e.target.checked ? "json" : "text" })}
            className="mt-0.5 accent-[var(--primary)]"
          />
          <span>
            JSON mode
            <span className="block text-xs text-muted-foreground">
              Constrain replies to valid JSON (structured output). Ask for the shape you want in your message.
            </span>
          </span>
        </label>
      </PopoverContent>
    </Popover>
  );
}
