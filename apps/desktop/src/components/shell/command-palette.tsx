"use client";

import { useRouter } from "next/navigation";
import { Monitor, Moon, PanelLeft, Sun } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV_ITEMS } from "@/lib/navigation";
import { setThemePreference, toggleSidebar, type ThemePreference } from "@/lib/preferences";

const THEME_COMMANDS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Use light theme", icon: Sun },
  { value: "dark", label: "Use dark theme", icon: Moon },
  { value: "system", label: "Use system theme", icon: Monitor },
];

/**
 * Search & commands. In this milestone it searches navigation and app commands;
 * conversation and project search are added once that data exists (Milestones 5 and 7).
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Jump to a section or run a command"
    >
      <Command>
        <CommandInput placeholder="Search sections and commands…" />
        <CommandList>
          <CommandEmpty>No matching sections or commands.</CommandEmpty>
          <CommandGroup heading="Go to">
            {NAV_ITEMS.filter((item) => item.href !== null).map((item) => (
              <CommandItem
                key={item.id}
                value={item.label}
                keywords={[item.description, ...(item.keywords ?? [])]}
                onSelect={() => run(() => router.push(item.href as string))}
              >
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
                <span className="truncate text-xs text-muted-foreground">{item.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Appearance">
            {THEME_COMMANDS.map((t) => (
              <CommandItem
                key={t.value}
                value={t.label}
                keywords={["theme", "appearance", t.value]}
                onSelect={() => run(() => setThemePreference(t.value))}
              >
                <t.icon aria-hidden="true" />
                <span>{t.label}</span>
              </CommandItem>
            ))}
            <CommandItem
              value="Toggle sidebar"
              keywords={["collapse", "expand", "panel"]}
              onSelect={() => run(toggleSidebar)}
            >
              <PanelLeft aria-hidden="true" />
              <span>Toggle sidebar</span>
              <CommandShortcut>Ctrl .</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
