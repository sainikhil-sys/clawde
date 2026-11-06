import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isActivePath, NAV_ITEMS } from "./navigation";

describe("NAV_ITEMS", () => {
  // The spec's eight sections in its order, plus Memory (M8) next to Projects, which it relates to.
  it("lists the main sections in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "New chat",
      "Search",
      "Projects",
      "Memory",
      "Artifacts",
      "Agents",
      "Research Studio",
      "Model Library",
      "Settings",
    ]);
  });

  it("has unique ids and hrefs", () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    const hrefs = NAV_ITEMS.flatMap((i) => (i.href ? [i.href] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("points every route item at a real page file", () => {
    const appDir = path.resolve(__dirname, "../app");
    for (const item of NAV_ITEMS) {
      if (item.href === null) continue;
      const page = path.join(appDir, item.href, "page.tsx");
      expect(existsSync(page), `${item.label} → ${page}`).toBe(true);
    }
  });
});

describe("isActivePath", () => {
  it("matches root only exactly", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/projects", "/")).toBe(false);
  });

  it("matches a section and its children but not lookalike prefixes", () => {
    expect(isActivePath("/projects", "/projects")).toBe(true);
    expect(isActivePath("/projects/abc", "/projects")).toBe(true);
    expect(isActivePath("/projects-archive", "/projects")).toBe(false);
  });
});
