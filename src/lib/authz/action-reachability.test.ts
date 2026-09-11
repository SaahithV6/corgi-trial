/**
 * The guard's population, at the layer the middleware cannot see.
 *
 * ============================================================================
 * WHAT THIS PINS, AND WHY A ROUTE WALK DOES NOT PIN IT
 * ============================================================================
 *
 * `coverage.test.ts` walks the routes and proves a customer is refused every
 * operator PAGE. It cannot prove anything about server ACTIONS, because an
 * action is not a route: a Next.js server action POSTs to whatever page the
 * browser is currently on, so `middleware()` reads a `/client/*` pathname and
 * allows it, and the `(app)` layout — which re-derives the same decision and
 * fails closed — never runs, because an action that renders no page never
 * reaches a layout. The middleware checks WHERE YOU ARE, not WHAT YOU ARE
 * CALLING.
 *
 * Measured on this build (`next start`, production bundle, 2026-09-11):
 *
 *     POST /client/pay        Cookie: corgi_demo_role=customer
 *                             $ACTION_ID_608bbab98fcb26b40e5e6638e2aa564f1a21baf0a3
 *     -> 500, and in the server log:
 *        TypeError: Cannot read properties of undefined (reading 'get')
 *
 * That stack is `raisePaymentAction` reading `formData.get(...)`. The OPERATOR
 * action's body executed, under a customer cookie, at a customer pathname. It
 * stopped on an argument-shape error, not on an authorisation decision.
 *
 * ─── THE BLAST RADIUS IS NOT "EVERY OPERATOR ACTION" ─────────────────────────
 *
 * It is exactly the operator actions Next.js has bundled into a `/client/*`
 * page entry, and nothing else. For an action that is NOT in the current page's
 * entry, `selectWorkerForForwarding()` (next/dist/server/app-render/
 * manifests-singleton.js) sends the POST on to the page that does own it — a
 * real HTTP request to that operator pathname, carrying the same cookie — and
 * the middleware refuses THAT one. Measured, same server, same cookie:
 *
 *     POST /statements  Next-Action: 408e36cb...  -> 403  deny; OPERATOR_ONLY
 *
 * So the population that matters is an IMPORT GRAPH, not a route list, and it
 * is chosen by whoever adds an `import` to a component under the customer
 * surface — which is precisely the shape of defect this repo has catalogued
 * thirty-one times: the guard's population picked by something other than the
 * capability it protects.
 *
 * ─── SO THIS TEST IS THE POPULATION ──────────────────────────────────────────
 *
 * It walks the customer surface, collects every operator action module reached
 * from it, and FAILS BY NAME on any that is not written down below. Default
 * deny: an import nobody registered is a failing test, not a silent grant. Pull
 * a thirty-sixth operator action onto `/client` next week and CI says so before
 * a customer does.
 *
 * The two entries below are NOT blessings. They are open findings, named, with
 * the reason they are open and what closing them needs. The test's job is to
 * stop the list growing while they are open.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The customer product surface: its pages, and the components they render. */
const CUSTOMER_SURFACE_DIRS = [
  fileURLToPath(new URL("../../app/(app)/client", import.meta.url)),
  fileURLToPath(new URL("../../components/client", import.meta.url)),
];

/**
 * Operator action modules the customer surface imports today.
 *
 * Each value is why it is open. Neither is a per-tenant action: both take the
 * row id straight from the form with no `AND business_id` beside it, which is
 * what separates them from the customer's own four actions (`fileDisputeAction`,
 * the pot actions, the payout quote actions and the card-control actions), every
 * one of which carries a both-column predicate.
 */
const KNOWN_OPERATOR_IMPORTS: Readonly<Record<string, string>> = {
  "@/app/(app)/payments/actions":
    "raisePaymentAction, rendered by src/components/client/PaymentForm.tsx on " +
    "/client/pay. `accountId` comes from the form and is resolved without a " +
    "tenant predicate, so a customer session can raise an instruction against " +
    "an account that is not theirs. Closing it needs the account read inside " +
    "requestPayment() to carry the business alongside the id — a change in " +
    "src/lib/approvals/, not a role check here: a role check would refuse the " +
    "customer their own /client/pay screen.",
  "@/app/(app)/approvals/actions":
    "decideAction, rendered by src/components/client/ApproveForm.tsx on " +
    "/client/approvals. `instructionId` comes from the form. The content hash " +
    "pins the decision to an amount and maker-checker is a database trigger, " +
    "but neither of those is a tenant boundary, so a customer session can " +
    "approve or release an instruction belonging to another business. Same " +
    "shape of fix, same module.",
};

/** Every `.ts`/`.tsx` file under the customer surface, tests excluded. */
function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      found.push(...sourcesUnder(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    found.push(full);
  }
  return found;
}

const SOURCES = CUSTOMER_SURFACE_DIRS.flatMap(sourcesUnder);

/** `@/app/(app)/<something>/actions` — the operator ones are the non-client ones. */
const ACTION_IMPORT = /from\s+"(@\/app\/\(app\)\/[^"]*actions[^"]*)"/g;

/** Which operator action modules does the customer surface reach? */
function operatorActionImports(): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  for (const file of SOURCES) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(ACTION_IMPORT)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      // `@/app/(app)/client/...` is the customer's own action surface.
      if (specifier.startsWith("@/app/(app)/client/")) continue;
      byModule.set(specifier, [...(byModule.get(specifier) ?? []), file]);
    }
  }
  return byModule;
}

describe("operator actions reachable from the customer surface", () => {
  it("found the customer surface at all — a walk that finds nothing proves nothing", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    expect(SOURCES.some((file) => file.endsWith("/components/client/PaymentForm.tsx"))).toBe(
      true,
    );
  });

  /**
   * THE ROT TEST. Import a thirty-sixth operator action into a `/client`
   * component and this fails by name until somebody writes down why a customer
   * session may execute it.
   */
  it("imports no operator action module that is not a written-down finding", () => {
    const reached = [...operatorActionImports().keys()].sort();
    const unregistered = reached.filter(
      (specifier) => KNOWN_OPERATOR_IMPORTS[specifier] === undefined,
    );
    expect(
      unregistered,
      "the customer surface now reaches these operator action modules and nobody\n" +
        `has said why a customer session may execute them:\n  ${unregistered.join("\n  ")}\n` +
        "A server action POSTs to the page the browser is on, so middleware.ts sees\n" +
        "a /client/* pathname and allows it, and the (app) layout never runs for an\n" +
        "action. Either give the action a both-column tenant predicate the way the\n" +
        "customer's own four actions do, or stop importing it here.",
    ).toEqual([]);
  });

  it("names no finding that the customer surface no longer reaches", () => {
    // The converse: a finding that has been fixed must leave, or the register
    // becomes a list of scares nobody reads.
    const reached = new Set(operatorActionImports().keys());
    const stale = Object.keys(KNOWN_OPERATOR_IMPORTS)
      .filter((specifier) => !reached.has(specifier))
      .sort();
    expect(stale, `these are recorded as open and are no longer imported:\n  ${stale.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("still leaves the customer's own four actions alone", () => {
    // They are correct, they are load-bearing, and this test must never be the
    // reason somebody deletes one. Named so a future edit has to face them.
    const ownSurface = SOURCES.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const own of [
      "@/app/(app)/client/disputes/actions",
      "@/app/(app)/client/pots/actions",
      "@/app/(app)/client/payouts/actions",
      "@/app/(app)/client/cards-actions",
    ]) {
      expect(ownSurface, `${own} is no longer rendered by the customer surface`).toContain(own);
    }
  });
});
