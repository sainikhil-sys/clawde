"use client";

import { useRouter } from "next/navigation";
import { MessageSquare, Monitor, Moon, PanelLeft, Sun } from "lucide-react";
import { useDeferredValue, useState } from "react";

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
import { useApiHealth } from "@/hooks/use-api-health";
import { useConversationSearch } from "@/hooks/use-chat";
import { NAV_ITEMS } from "@/lib/navigation";
import { setThemePreference, toggleSidebar, type ThemePreference } from "@/lib/preferences";

const THEME_COMMANDS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Use light theme", icon: Sun },
  { value: "dark", label: "Use dark theme", icon: Moon },
  { value: "system", label: "Use system theme", icon: Monitor },
];

/**
 * Search & commands: conversations (titles and message text, searched by the API), sections and app
 * commands. Project search is added with projects in Milestone 7.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const health = useApiHealth();
  const results = useConversationSearch(deferred, open && health.isSuccess && deferred.length >= 2);

  function run(action: () => void) {
    onOpenChange(false);
    setQuery("");
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
        <CommandInput
          placeholder="Search conversations, sections and commands…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No matching sections or commands.</CommandEmpty>
          {deferred.length >= 2 && health.isSuccess && (
            // Results come from the server (they may match message text), so cmdk's own filter is bypassed.
            <CommandGroup heading="Conversations" forceMount>
              {results.isPending && (
                <CommandItem forceMount disabled value="__searching">
                  Searching…
                </CommandItem>
              )}
              {results.data?.length === 0 && (
                <CommandItem forceMount disabled value="__none">
                  No conversations match
                </CommandItem>
              )}
              {results.data?.map((h) => (
                <CommandItem
                  key={h.conversation.id}
                  forceMount
                  value={`conversation-${h.conversation.id}`}
                  onSelect={() => run(() => router.push(`/chat/${h.conversation.id}`))}
                >
                  <MessageSquare aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{h.conversation.title}</span>
                    {h.match === "message" && (
                      <span className="block truncate text-xs text-muted-foreground">{h.snippet}</span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
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
