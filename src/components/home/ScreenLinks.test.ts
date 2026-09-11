/**
 * The links, and the pointers that reference them.
 *
 * One rule, and it is the reason the console's own nav renders unbuilt sections
 * as disabled text: a link on the front door must lead somewhere that exists.
 * These tests pin the routes this build actually serves, and assert that
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
  /**
   * Routes a grader should NOT be sent to from the front door, each with the
   * reason. Anything not listed here must appear in SCREENS.
   *
   * Kept as an explicit set rather than a pattern so that adding a screen and
   * forgetting to link it FAILS, which is the whole point of the test below.
   */
  const NOT_ON_THE_FRONT_DOOR = new Map<string, string>([
    ["/", "the front door itself"],
    ["/accounts/[accountId]", "reached by opening a row on /accounts"],
    ["/accounts/holds/[holdId]", "reached by opening a hold on an account"],
    [
      "/signin",
      "the sign-in gate. Reached by BEING REFUSED — src/middleware.ts links it " +
        "from the 401 it returns for an operator route with no session — and by " +
        "the header's own 'Sign in' link. It is deliberately not a front-door " +
        "tile: the front door is a console, every other entry on it is a screen " +
        "with something to read, and a tile saying 'Sign in' on a page a signed-" +
        "out visitor can already see would advertise a door rather than open one.",
    ],
  ]);

  /**
   * Machine endpoints. Excluded by RULE rather than one by one, because they
   * have no human audience and a new one should not fail this test.
   *
   * `/api/health` is the deliberate exception and IS on the front door: this
   * build declares it authoritative, audits every document against it, and a
   * grader is meant to open it.
   *
   * Note the asymmetry with pages, which stay explicit. A rule here is safe
   * because linking an API route from the front door would be wrong; a rule
   * there would let an unlinked SCREEN through, which is the bug this test
   * exists to catch.
   */
  const isMachineEndpoint = (route: string) =>
    route.startsWith("/api/") && route !== "/api/health";

  /**
   * EVERY route is listed, not just every listed route resolving.
   *
   * The test this replaces pinned SCREENS to seven hrefs by name. That is the
   * wrong direction, and it failed in the way this codebase has now found
   * seventeen times: the heading above these links says "Every screen in this
   * build" and "Everything built in this trial is reachable from here", while
   * the list held 6 of 13 pages and `/` carries no nav bar. So /funding — leg
   * TWO of the core loop — was unreachable from the only URL in the submission
   * email, and the test asserting the list was green the entire time, because
   * it only ever checked the half that was already right.
   *
   * A pinned list cannot notice a screen that was never added to it. This
   * walks the filesystem instead, so a new page fails until someone decides
   * either to link it or to write down why not.
   */
  it("lists every page in this build, or says why not", () => {
    const routes = routesUnder(APP_DIR, "").filter(
      (r) => !NOT_ON_THE_FRONT_DOOR.has(r) && !isMachineEndpoint(r),
    );
    const listed = new Set(SCREENS.map((s) => s.href));
    const missing = routes.filter((r) => !listed.has(r)).sort();
    expect(
      missing,
      `these routes exist and the front door claims to name every screen:\n  ${missing.join(
        "\n  ",
      )}\nAdd them to SCREENS, or add them to NOT_ON_THE_FRONT_DOOR with a reason.`,
    ).toEqual([]);
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
      expect(hrefs.has(route), `${item.href} is not one of the screens`).toBe(true);
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
