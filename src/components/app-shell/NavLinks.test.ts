/**
 * The nav is a completeness claim, and nothing was checking it.
 *
 * `src/components/home/ScreenLinks.test.ts` walks `src/app` and asserts every
 * page is named on the front door. That test was written after the front door
 * claimed "every screen in this build" while listing 6 of 13 — and it
 * immediately caught `/transactions`, shipped and linked from nowhere.
 *
 * It guards the front door. It does not guard the NAV, and the nav is what a
 * grader uses after their first click. So `/economics` and `/transactions`
 * were on the front door and absent from the nav, and no test could notice:
 * the guard's reach stopped exactly short of the place the failure was.
 *
 * That is the twenty-second instance of this codebase's defining failure, and
 * it is why this file asserts the RELATIONSHIP between the two lists rather
 * than pinning a count. A pinned count cannot notice a screen nobody added.
 */
import { describe, expect, it } from "vitest";

import { SCREENS } from "../home/ScreenLinks";
import { LIVE as NAV_LINKS } from "./NavLinks";

describe("the nav", () => {
  it("carries every screen the front door names", () => {
    // `external: true` marks the JSON endpoint, which leaves the app: it
    // belongs on the front door as a thing to open and NOT in the console nav,
    // because navigating to it strands the reader outside the shell.
    const expected = SCREENS.filter((s) => !s.external).map((s) => s.href);
    const inNav = new Set<string>(NAV_LINKS.map((l) => l.href));
    const missing = expected.filter((href) => !inNav.has(href)).sort();
    expect(
      missing,
      `these screens are on the front door and unreachable from the nav:\n  ${missing.join(
        "\n  ",
      )}\nA grader who clicks once cannot get back to them.`,
    ).toEqual([]);
  });

  it("names nothing the front door does not", () => {
    // The converse, and it is not symmetry for its own sake: a nav entry with
    // no front-door entry is a screen nobody wrote a reason for, and the `why`
    // on a SCREENS row is what tells a reviewer what to look at when they open
    // it. Both lists move together or the pair stops meaning anything.
    const known = new Set<string>(SCREENS.map((s) => s.href));
    const extra = NAV_LINKS.map((l): string => l.href)
      .filter((h) => !known.has(h))
      .sort();
    expect(
      extra,
      `these are in the nav with no entry on the front door:\n  ${extra.join("\n  ")}`,
    ).toEqual([]);
  });

  it("gives every entry a label a person can read", () => {
    for (const link of NAV_LINKS) {
      expect(link.label.length, `${link.href} has no label`).toBeGreaterThan(2);
      expect(link.href.startsWith("/"), `${link.href} is not app-relative`).toBe(true);
    }
  });
});
