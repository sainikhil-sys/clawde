import { describe, expect, it, vi } from "vitest";

import {
  getSidebarState,
  getThemePreference,
  preferenceBootScript,
  setSidebarState,
  setThemePreference,
  SIDEBAR_KEY,
  subscribePreferences,
  THEME_KEY,
  toggleSidebar,
} from "./preferences";

function mockSystemDark(dark: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: dark && query.includes("dark"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

describe("theme preference", () => {
  it("defaults to system and ignores invalid stored values", () => {
    expect(getThemePreference()).toBe("system");
    localStorage.setItem(THEME_KEY, "neon");
    expect(getThemePreference()).toBe("system");
  });

  it("persists the choice and applies the dark class", () => {
    setThemePreference("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setThemePreference("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the OS when set to system", () => {
    mockSystemDark(true);
    setThemePreference("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("notifies subscribers on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePreferences(listener);
    setThemePreference("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setThemePreference("light");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("sidebar state", () => {
  it("toggles, persists and mirrors to <html>", () => {
    expect(getSidebarState()).toBe("expanded");
    toggleSidebar();
    expect(getSidebarState()).toBe("collapsed");
    expect(document.documentElement.dataset.sidebar).toBe("collapsed");
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");
    setSidebarState("expanded");
    expect(getSidebarState()).toBe("expanded");
  });
});

describe("boot script", () => {
  it("restores stored preferences before hydration", () => {
    mockSystemDark(false);
    localStorage.setItem(THEME_KEY, "dark");
    localStorage.setItem(SIDEBAR_KEY, "collapsed");
    new Function(preferenceBootScript)();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.sidebar).toBe("collapsed");
  });

  it("falls back to system theme and expanded sidebar", () => {
    mockSystemDark(false);
    new Function(preferenceBootScript)();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(document.documentElement.dataset.sidebar).toBe("expanded");
  });
});
