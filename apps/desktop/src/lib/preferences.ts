/**
 * Per-device UI preferences (theme, sidebar). Stored in localStorage and mirrored onto <html>
 * so CSS can render the right state before React hydrates (see `preferenceBootScript`).
 * These are conveniences only; anything that must persist reliably lives in the API database.
 */

export type ThemePreference = "light" | "dark" | "system";
export type SidebarState = "expanded" | "collapsed";

export const THEME_KEY = "clawde.theme";
export const SIDEBAR_KEY = "clawde.sidebar";

const THEMES: readonly ThemePreference[] = ["light", "dark", "system"];

type Listener = () => void;
const listeners = new Set<Listener>();
let mediaQuery: MediaQueryList | null = null;

function emit() {
  for (const l of listeners) l();
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode, blocked): state still applies for this page */
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getThemePreference(): ThemePreference {
  const v = safeGet(THEME_KEY);
  return THEMES.includes(v as ThemePreference) ? (v as ThemePreference) : "system";
}

export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

function applyTheme(pref: ThemePreference) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveTheme(pref) === "dark");
  root.dataset.theme = pref;
}

export function setThemePreference(pref: ThemePreference) {
  safeSet(THEME_KEY, pref);
  applyTheme(pref);
  emit();
}

export function getSidebarState(): SidebarState {
  return document.documentElement.dataset.sidebar === "collapsed" ? "collapsed" : "expanded";
}

export function setSidebarState(state: SidebarState) {
  safeSet(SIDEBAR_KEY, state);
  document.documentElement.dataset.sidebar = state;
  emit();
}

export function toggleSidebar() {
  setSidebarState(getSidebarState() === "collapsed" ? "expanded" : "collapsed");
}

/** Subscribe for useSyncExternalStore. Also follows OS theme changes while preference is "system". */
export function subscribePreferences(listener: Listener): () => void {
  listeners.add(listener);
  if (!mediaQuery && typeof window.matchMedia === "function") {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", onSystemThemeChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && mediaQuery) {
      mediaQuery.removeEventListener("change", onSystemThemeChange);
      mediaQuery = null;
    }
  };
}

function onSystemThemeChange() {
  if (getThemePreference() === "system") {
    applyTheme("system");
    emit();
  }
}

/**
 * Runs inline in <head> before first paint. Kept dependency-free and tiny; must stay in sync
 * with the keys and class names above.
 */
export const preferenceBootScript = `(function(){try{var d=document.documentElement;var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)})||"system";if(t!=="light"&&t!=="dark")t="system";var dark=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);d.classList.toggle("dark",dark);d.dataset.theme=t;var s=localStorage.getItem(${JSON.stringify(
  SIDEBAR_KEY,
)});d.dataset.sidebar=s==="collapsed"?"collapsed":"expanded";}catch(e){}})();`;
