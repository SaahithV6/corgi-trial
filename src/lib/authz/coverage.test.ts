/**
 * The test that makes this a fix that lasts.
 *
 * A guard is only ever as good as the population it covers, and this codebase
 * has now found thirty instances of the same failure: the population was chosen
 * by hand, and the hand forgot. `ScreenLinks.test.ts` fixed it for the front
 * door by walking `src/app` instead of pinning a list. This does the same for
 * the guard.
 *
 * Two properties, and they are different.
 *
 *   1. RUNTIME: a route nobody classified is already refused to a customer,
 *      because `authorize()` defaults to deny. This test proves that on the
 *      routes that exist, including a synthetic one that does not.
 *
 *   2. REVIEW: a route nobody classified FAILS THIS TEST, so the decision is
 *      made deliberately by a person rather than inherited from a default they
 *      never saw. The default keeps the system safe; the test keeps the system
 *      honest.
 */
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ROUTE_SURFACE, authorize, surfaceOf } from "./policy";
import { config as middlewareConfig } from "@/middleware";

const APP_DIR = fileURLToPath(new URL("../../app", import.meta.url));

/** Every page route under `src/app`. `(app)` is a group, not a segment. */
function pagesUnder(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("_")) continue;
    const segment = name.startsWith("(") && name.endsWith(")") ? prefix : `${prefix}/${name}`;
    if (readdirSync(full).includes("page.tsx")) found.push(segment === "" ? "/" : segment);
    found.push(...pagesUnder(full, segment));
  }
  return found;
}

const ROUTES = ["/", ...pagesUnder(APP_DIR, "")].filter(
  (route, i, all) => all.indexOf(route) === i && !route.startsWith("/api/"),
);

describe("every route in this build", () => {
  it("found the routes at all — a walk that finds nothing proves nothing", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(ROUTES).toContain("/accounts");
    expect(ROUTES).toContain("/client");
  });

  /**
   * THE ROT TEST. Add `src/app/(app)/ledger-exports/page.tsx` and this fails by
   * name until somebody writes down which surface it belongs to.
   */
  it("is classified in ROUTE_SURFACE, or this fails by name", () => {
    const unclassified = ROUTES.filter((route) => ROUTE_SURFACE[route] === undefined).sort();
    expect(
      unclassified,
      `these routes exist and nobody has said who may open them:\n  ${unclassified.join(
        "\n  ",
      )}\nThe RUNTIME already refuses them to a customer — default deny in authorize().\n` +
        "This test is the review step: add each one to ROUTE_SURFACE in\n" +
        "src/lib/authz/policy.ts as 'operator' (almost always) or 'customer'\n" +
        "(only if it is the customer's own screen, scoped to one business).",
    ).toEqual([]);
  });

  it("names nothing in ROUTE_SURFACE that does not exist", () => {
    // The converse. A register full of routes that were deleted is a register
    // nobody trusts, and an entry classified 'customer' for a route that no
    // longer exists is a hole waiting for somebody to re-create the path.
    const live = new Set(ROUTES);
    const stale = Object.keys(ROUTE_SURFACE)
      .filter((route) => !live.has(route))
      .sort();
    expect(stale, `these are classified and have no page:\n  ${stale.join("\n  ")}`).toEqual(
      [],
    );
  });

  /**
   * The register and the runtime must agree. If they ever disagree the register
   * is the liar — `surfaceOf()` is what actually decides — and a reviewer
   * reading the register would be reading fiction.
   */
  it("is classified the same way by the register and by the runtime", () => {
    const disagreements = ROUTES.filter(
      (route) => ROUTE_SURFACE[route] !== surfaceOf(route),
    ).map((route) => `${route}: register says ${ROUTE_SURFACE[route]}, runtime says ${surfaceOf(route)}`);
    expect(disagreements).toEqual([]);
  });

  it("refuses a customer on every operator route, with no exceptions", () => {
    const served = ROUTES.filter(
      (route) => surfaceOf(route) === "operator" && authorize("customer", route).allowed,
    );
    expect(served, `a customer is served these operator routes:\n  ${served.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("serves staff and approver everything, so the console is unchanged", () => {
    for (const role of ["staff", "approver"] as const) {
      const refused = ROUTES.filter((route) => !authorize(role, route).allowed);
      expect(refused, `${role} is refused:\n  ${refused.join("\n  ")}`).toEqual([]);
    }
  });
});

describe("the middleware matcher", () => {
  /**
   * The guard runs in two places and this is the one with a matcher. The
   * existing comment in `middleware.ts` says it out loud — "a matcher is
   * exactly where coverage goes missing without anyone noticing" — and it was
   * right, so the matcher is checked against the same filesystem walk.
   *
   * The `(app)` layout re-derives the decision independently and fails closed,
   * so a matcher gap is a bug rather than a breach. This test is how the bug
   * gets found in CI instead of in a demo.
   */
  const matchers = (
    Array.isArray(middlewareConfig.matcher)
      ? middlewareConfig.matcher
      : [middlewareConfig.matcher]
  ) as string[];

  const matches = (route: string): boolean =>
    matchers.some((pattern) => new RegExp(`^${pattern}$`).test(route));

  it("covers every page route in this build", () => {
    const uncovered = ROUTES.filter((route) => !matches(route)).sort();
    expect(
      uncovered,
      `the middleware does not run for these:\n  ${uncovered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("still covers the scheduled routes it was written for", () => {
    for (const route of ["/api/drain", "/api/cron/accrual", "/api/cron/outbound"]) {
      expect(matches(route), `${route} is no longer covered`).toBe(true);
    }
  });

  it("still leaves the webhook routes out of its path", () => {
    // Deliberate, and unchanged: those routes verify a provider signature over
    // an exact raw body, and the existing decision was to keep middleware off
    // that path entirely rather than reason about whether it perturbs a stream.
    expect(matches("/api/webhooks/increase")).toBe(false);
  });
});
