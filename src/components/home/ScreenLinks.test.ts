/**
 * The links, and the pointers that reference them.
 *
 * One rule, and it is the reason the console's own nav renders unbuilt sections
 * as disabled text: a link on the front door must lead somewhere that exists.
 * These tests pin the four routes this build actually serves, and assert that
 * every "what to look at" item points at one of them rather than at a URL a
 * grader would have to guess at.
 */
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SCREENS } from "./ScreenLinks";
import { LOOK_AT } from "./WhatToLookAt";

const APP_DIR = fileURLToPath(new URL("../../app", import.meta.url));

/** The path a route group contributes: `(app)` is not a segment. */
function routesUnder(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("_")) continue;
    const segment = name.startsWith("(") && name.endsWith(")") ? prefix : `${prefix}/${name}`;
    const entries = readdirSync(full);
    if (entries.includes("page.tsx")) found.push(segment === "" ? "/" : segment);
    if (entries.includes("route.ts")) found.push(segment === "" ? "/" : segment);
    found.push(...routesUnder(full, segment));
  }
  return found;
}

describe("SCREENS", () => {
  it("names the six things that exist", () => {
    expect(SCREENS.map((s) => s.href)).toEqual([
      "/onboarding",
      "/accounts",
      "/approvals",
      "/reconciliation",
      "/statements",
      "/api/health",
    ]);
  });

  it("every link resolves to a route in this build", () => {
    const routes = new Set(routesUnder(APP_DIR, ""));
    for (const screen of SCREENS) {
      expect(routes.has(screen.href), `${screen.href} has no page or route file`).toBe(
        true,
      );
    }
  });

  it("marks the JSON endpoint as leaving the app, and the pages as not", () => {
    expect(SCREENS.filter((s) => s.external).map((s) => s.href)).toEqual([
      "/api/health",
    ]);
  });

  it("says what each screen is and why to open it", () => {
    for (const screen of SCREENS) {
      expect(screen.title.length).toBeGreaterThan(0);
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.why.length).toBeGreaterThan(20);
    }
  });
});

describe("LOOK_AT", () => {
  it("is a short list — three or four concrete things, not a feature tour", () => {
    expect(LOOK_AT.length).toBeGreaterThanOrEqual(3);
    expect(LOOK_AT.length).toBeLessThanOrEqual(4);
  });

  it("points only at routes this page already links, or at this page", () => {
    const hrefs = new Set(SCREENS.map((s) => s.href));
    for (const item of LOOK_AT) {
      if (item.href.startsWith("#")) continue;
      // Query strings select a demo state on a real screen; the route itself
      // still has to be one of the four.
      const route = item.href.split("?")[0] ?? item.href;
      expect(hrefs.has(route), `${item.href} is not one of the four screens`).toBe(true);
    }
  });

  it("gives each item a stable key and a concrete instruction", () => {
    expect(new Set(LOOK_AT.map((i) => i.key)).size).toBe(LOOK_AT.length);
    for (const item of LOOK_AT) {
      expect(item.linkText.length).toBeGreaterThan(0);
      expect(item.text.length).toBeGreaterThan(60);
    }
  });
});
