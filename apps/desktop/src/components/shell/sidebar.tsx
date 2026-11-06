"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import type { ReactNode } from "react";

import { LogoMark, Wordmark } from "@/components/brand/logo";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebarState, useThemePreference } from "@/hooks/use-preferences";
import { isActivePath, NAV_ITEMS, type NavItem } from "@/lib/navigation";
import { setThemePreference, toggleSidebar, type ThemePreference } from "@/lib/preferences";
import { cn } from "@/lib/utils";

import { RecentConversations } from "./recent-conversations";

type SidebarProps = {
  /** Current pathname, or null while it is not yet known (prerender fallback). */
  pathname: string | null;
  onSearch: () => void;
  /** Called after any navigation, used by the mobile drawer to close itself. */
  onNavigate?: () => void;
  /** Mobile drawer never collapses and has no collapse control. */
  variant?: "desktop" | "mobile";
};

const itemClass =
  "group/nav flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm text-sidebar-foreground/80 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";

export function Sidebar({ pathname, onSearch, onNavigate, variant = "desktop" }: SidebarProps) {
  const sidebarState = useSidebarState();
  const collapsed = variant === "desktop" && sidebarState === "collapsed";
  // Labels hide via CSS on desktop (attribute set before paint), never on mobile.
  const hideWhenCollapsed = variant === "desktop" ? "sidebar-collapsed:hidden" : "";

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <Link
          href="/"
          onClick={onNavigate}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            variant === "desktop" && "sidebar-collapsed:hidden",
          )}
          aria-label="Clawde home"
        >
          <LogoMark className="text-primary" />
          <Wordmark />
        </Link>
        {variant === "desktop" && (
          <SidebarTooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut={["Ctrl", "."]} enabled>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring sidebar-collapsed:mx-auto"
            >
              <PanelLeftClose className="size-4 sidebar-collapsed:hidden" />
              <PanelLeftOpen className="hidden size-4 sidebar-collapsed:block" />
            </button>
          </SidebarTooltip>
        )}
      </div>

      <nav aria-label="Main" className="px-2">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <SidebarTooltip label={item.label} enabled={collapsed}>
                {item.href === null ? (
                  <button type="button" onClick={onSearch} className={itemClass}>
                    <item.icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className={cn("truncate", hideWhenCollapsed)}>{item.label}</span>
                    <KbdGroup className={cn("ml-auto", hideWhenCollapsed)}>
                      <Kbd>Ctrl</Kbd>
                      <Kbd>K</Kbd>
                    </KbdGroup>
                    {collapsed && <span className="sr-only">{item.label}</span>}
                  </button>
                ) : (
                  <NavLink item={item} pathname={pathname} onNavigate={onNavigate} labelClass={hideWhenCollapsed} />
                )}
              </SidebarTooltip>
            </li>
          ))}
        </ul>
      </nav>

      <section
        aria-labelledby="recents-heading"
        className={cn("mt-6 min-h-0 flex-1 overflow-y-auto px-4 pb-2", hideWhenCollapsed)}
      >
        <h2 id="recents-heading" className="text-xs font-medium text-muted-foreground">
          Recents
        </h2>
        <RecentConversations pathname={pathname} onNavigate={onNavigate} />
      </section>

      <div className={cn("mt-auto shrink-0 border-t border-sidebar-border p-2", collapsed && "flex justify-center")}>
        <ThemeCycleButton collapsed={collapsed} labelClass={hideWhenCollapsed} />
      </div>
    </div>
  );
}

/** Reads the pathname. Must sit inside <Suspense> because of Cache Components prerendering. */
export function ActiveSidebar(props: Omit<SidebarProps, "pathname">) {
  const pathname = usePathname();
  return <Sidebar {...props} pathname={pathname} />;
}

function NavLink({
  item,
  pathname,
  onNavigate,
  labelClass,
}: {
  item: NavItem;
  pathname: string | null;
  onNavigate?: () => void;
  labelClass: string;
}) {
  const href = item.href as string;
  const active = pathname !== null && isActivePath(pathname, href);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(itemClass, active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground")}
    >
      <item.icon className={cn("size-4 shrink-0", active && "text-primary")} aria-hidden="true" />
      <span className={cn("truncate", labelClass)}>{item.label}</span>
    </Link>
  );
}

const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];
const THEME_META: Record<ThemePreference, { label: string; icon: typeof Sun }> = {
  system: { label: "System theme", icon: Monitor },
  light: { label: "Light theme", icon: Sun },
  dark: { label: "Dark theme", icon: Moon },
};

function ThemeCycleButton({ collapsed, labelClass }: { collapsed: boolean; labelClass: string }) {
  const theme = useThemePreference();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  const { label, icon: Icon } = THEME_META[theme];
  return (
    <SidebarTooltip label={`${label}. Switch to ${next}`} enabled={collapsed}>
      <button
        type="button"
        onClick={() => setThemePreference(next)}
        aria-label={`${label}. Switch to ${next} theme`}
        className={cn(itemClass, collapsed && "w-9 justify-center px-0")}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className={cn("truncate", labelClass)}>{label}</span>
      </button>
    </SidebarTooltip>
  );
}

function SidebarTooltip({
  label,
  shortcut,
  enabled,
  children,
}: {
  label: string;
  shortcut?: string[];
  enabled: boolean;
  children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        {label}
        {shortcut && (
          <KbdGroup>
            {shortcut.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </KbdGroup>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
