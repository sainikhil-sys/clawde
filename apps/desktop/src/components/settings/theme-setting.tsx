"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { useThemePreference } from "@/hooks/use-preferences";
import { setThemePreference, type ThemePreference } from "@/lib/preferences";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function ThemeSetting() {
  const theme = useThemePreference();
  return (
    <fieldset>
      <legend className="sr-only">Theme</legend>
      <div className="grid grid-cols-3 gap-2 sm:max-w-sm">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-md border px-3 py-3 text-sm transition-colors hover:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-ring",
              theme === opt.value && "border-primary bg-accent font-medium",
            )}
          >
            <input
              type="radio"
              name="theme"
              value={opt.value}
              checked={theme === opt.value}
              onChange={() => setThemePreference(opt.value)}
              className="sr-only"
            />
            <opt.icon className={cn("size-4", theme === opt.value && "text-primary")} aria-hidden="true" />
            {opt.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
