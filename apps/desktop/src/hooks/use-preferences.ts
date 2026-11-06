"use client";

import { useSyncExternalStore } from "react";
import {
  getSidebarState,
  getThemePreference,
  subscribePreferences,
  type SidebarState,
  type ThemePreference,
} from "@/lib/preferences";

/** Server snapshots are fixed defaults; the real values are already on <html> via the boot script. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribePreferences, getThemePreference, () => "system");
}

export function useSidebarState(): SidebarState {
  return useSyncExternalStore(subscribePreferences, getSidebarState, () => "expanded");
}
