"use client";

import Link from "next/link";
import { Menu, Search } from "lucide-react";
import { MotionConfig } from "motion/react";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";

import { LogoMark, Wordmark } from "@/components/brand/logo";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toggleSidebar } from "@/lib/preferences";
import { isModKey } from "@/lib/shortcuts";

import { CommandPalette } from "./command-palette";
import { ActiveSidebar, Sidebar } from "./sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const openPalette = useCallback(() => {
    setMobileNavOpen(false);
    setPaletteOpen(true);
  }, []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isModKey(e, "k")) {
        e.preventDefault();
        setMobileNavOpen(false);
        setPaletteOpen((open) => !open);
      } else if (isModKey(e, ".")) {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const sidebarProps = { onSearch: openPalette };

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={300}>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <div className="flex h-dvh overflow-hidden">
          <aside
            id="app-sidebar"
            aria-label="Sidebar"
            className="hidden w-64 shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-out md:block sidebar-collapsed:w-14"
          >
            <Suspense fallback={<Sidebar {...sidebarProps} pathname={null} />}>
              <ActiveSidebar {...sidebarProps} />
            </Suspense>
          </aside>

          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Main navigation</SheetDescription>
              <Suspense fallback={<Sidebar {...sidebarProps} pathname={null} variant="mobile" />}>
                <ActiveSidebar {...sidebarProps} variant="mobile" onNavigate={closeMobileNav} />
              </Suspense>
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:hidden">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation"
                className="-ml-2 flex size-9 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Menu className="size-5" />
              </button>
              <Link href="/" className="flex items-center gap-2" aria-label="Clawde home">
                <LogoMark className="text-primary" />
                <Wordmark />
              </Link>
              <button
                type="button"
                onClick={openPalette}
                aria-label="Search"
                className="-mr-2 ml-auto flex size-9 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Search className="size-5" />
              </button>
            </header>
            <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
              {children}
            </main>
          </div>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </TooltipProvider>
    </MotionConfig>
  );
}
