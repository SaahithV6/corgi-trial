/**
 * Who may open which screen. One decision, in one function, default deny.
 *
 * ============================================================================
 * WHY DEFAULT DENY, AND WHY THE ALLOW LIST IS THE CUSTOMER'S
 * ============================================================================
 *
 * This codebase has catalogued the same failure thirty times and it always has
 * the same shape: a guard whose POPULATION is chosen by something other than
 * the capability it protects. The front door listed 6 of 13 screens. The nav
 * carried 19 of 21. A deny-list of operator routes would be the thirty-first
 * instance — sixteen operator screens exist today, a seventeenth ships this
 * afternoon, and the person who adds it is exactly the person who will not
 * think about this file.
 *
 * So the list below is the CUSTOMER-REACHABLE set, which is small, closed, and
 * belongs to a single product surface. Everything else is operator-only
 * BECAUSE IT IS NOT ON THIS LIST — including every route that does not exist
 * yet. A new operator screen is covered the moment its directory is created,
 * with nobody remembering anything.
 *
 * `ROUTE_SURFACE` below is a second, belt-and-braces device and it is NOT what
 * the runtime consults: it is a register that `coverage.test.ts` checks against
 * a filesystem walk of `src/app`, so adding a route without classifying it is a
 * FAILING TEST rather than a silent grant. The failure is a prompt to a human;
 * the runtime has already denied.
 *
 * ============================================================================
 * WHAT THIS IS NOT
 * ============================================================================
 *
 * It is not authentication (`roles.ts` says so at length), and it is not the
 * tenant predicate. `WHERE business_id = $1` inside every client reader is what
 * keeps one customer's rows away from another's; this module keeps a customer
 * out of the console that reads ALL of them. Both are needed and neither
 * substitutes for the other.
 */

import { isOperator, type Role } from "./roles";

/* -------------------------------------------------------------------------- */
/* The customer-reachable surface — the ONLY allow list                       */
/* -------------------------------------------------------------------------- */

/**
 * Exact paths a customer may open, outside the `/client` tree.
 *
 * `/` is here and it is the one entry that deserves an argument, because `/`
 * renders the operator console's own summary figures.
 *
 * It stays reachable because it is where the role switch lives. `docs/DEMO.md`
 * says the credential IS the role switch and `scripts/verify-demo.mjs` §8 posts
 * that switch from `/` specifically — "so the switch works from the URL in the
 * email, before any navigation". Refusing `/` to a customer would strand the
 * person in the customer role with no way back, which is a worse demo and a
 * worse product than a summary they should not see.
 *
 * That is a REAL residual leak and it is written down rather than hidden: the
 * front door shows a customer platform-wide figures. Closing it needs `/` to
 * render a different page per principal, which is a page change and not a guard
 * change. It is the next thing to do, and it is named in the report.
 */
const CUSTOMER_EXACT: readonly string[] = ["/"];

/**
 * Path trees a customer may open.
 *
 * One entry, deliberately. `/client` is the customer product; every screen
 * under it is scoped to one business by the reader it calls. A new screen added
 * to that tree — `/client/open`, the KYB application being built beside this —
 * is reachable the moment it exists, which is correct: it is the customer's own
 * surface.
 */
const CUSTOMER_TREES: readonly string[] = ["/client"];

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

export type Surface = "customer" | "operator";

/**
 * Which product surface a path belongs to.
 *
 * Total, and biased to `operator`. An unknown path, a typo, a route that does
 * not exist, a path with a trailing slash — every one of them is operator, so
 * the failure mode of this function is "a customer is refused something they
 * could have had", never "a customer is served the console".
 */
export function surfaceOf(pathname: string): Surface {
  const path = normalise(pathname);
  if (CUSTOMER_EXACT.includes(path)) return "customer";
  for (const tree of CUSTOMER_TREES) {
    if (path === tree || path.startsWith(`${tree}/`)) return "customer";
  }
  return "operator";
}

/** Trailing slashes off, query and hash off, empty becomes `/`. */
function normalise(pathname: string): string {
  const withoutQuery = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (withoutQuery === "") return "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.replace(/\/+$/, "") || "/";
  }
  return withoutQuery;
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The one refusal this module can produce.
 *
 * A named code rather than a bare 403, for the same reason every other refusal
 * in this build carries one: a grader, a log line and a test should all be able
 * to say the same word about what happened.
 */
export const OPERATOR_ONLY = "OPERATOR_ONLY" as const;

export type RefusalCode = typeof OPERATOR_ONLY;

export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: RefusalCode;
      /** One sentence, addressed to the person who hit it. */
      readonly reason: string;
      /** Where they may go instead. Always non-empty. */
      readonly elsewhere: readonly string[];
    };

/**
 * May `role` open `pathname`?
 *
 * The whole policy, and it is three lines long on purpose. Anything that reads
 * a database, a header or a cookie belongs outside this function; a decision
 * that cannot be evaluated in a test without a server is a decision nobody
 * checks.
 */
export function authorize(role: Role, pathname: string): Decision {
  if (isOperator(role)) return { allowed: true };
  if (surfaceOf(pathname) === "customer") return { allowed: true };
  return {
    allowed: false,
    code: OPERATOR_ONLY,
    reason:
      "This is a Corgi operator screen. It reads every business on the book, so it is not served to a customer session — the server refused the request; the screen was not rendered and then hidden.",
    elsewhere: ["/client", "/"],
  };
}

/**
 * Apply the same decision to a list of links.
 *
 * The nav calls this, so the nav CANNOT disagree with the enforcement: a link
 * is painted if and only if the server would serve it. Hiding a link is not a
 * guard and this function is not the guard — `authorize()` is, at the layout
 * and in the middleware. This only stops the chrome from advertising a refusal.
 */
export function visibleTo<T extends { readonly href: string }>(
  role: Role,
  links: readonly T[],
): readonly T[] {
  return links.filter((link) => authorize(role, link.href).allowed);
}

/* -------------------------------------------------------------------------- */
/* The register — checked against the filesystem, not consulted at runtime     */
/* -------------------------------------------------------------------------- */

/**
 * Every page route in this build, classified by hand.
 *
 * NOT used by `authorize()`. Its only job is to fail `coverage.test.ts` when a
 * route appears under `src/app` that nobody has classified, so that "a new
 * operator screen is silently covered" is a thing a human has to CONFIRM rather
 * than a thing they can find out from an incident.
 *
 * Keep it in sync by adding the route. The test names the missing ones.
 */
export const ROUTE_SURFACE: Readonly<Record<string, Surface>> = {
  "/": "customer",

  "/client": "customer",
  // The four that completed the journey on the last day. A customer could not
  // previously open an account, link a bank, put a card in a colleague's hand,
  // or read their own statement — every one of those was the console doing the
  // customer's job. The runtime already allows these (the `/client` tree is the
  // allow list); naming them here is the register's half, so that a fifth
  // arriving tomorrow fails a test rather than appearing silently.
  "/client/funding": "customer",
  "/client/team": "customer",
  "/client/standing-orders": "customer",
  "/client/statements": "customer",
  "/client/activity": "customer",
  "/client/approvals": "customer",
  "/client/cards": "customer",
  "/client/disputes": "customer",
  "/client/pay": "customer",
  "/client/payouts": "customer",
  "/client/pots": "customer",
  "/client/open": "customer",

  "/accounts": "operator",
  "/accounts/[accountId]": "operator",
  "/accounts/holds/[holdId]": "operator",
  "/accruals": "operator",
  "/approvals": "operator",
  "/audit": "operator",
  "/breaks": "operator",
  "/chaos": "operator",
  "/dashboard": "operator",
  "/disputes": "operator",
  "/economics": "operator",
  "/events": "operator",
  "/funding": "operator",
  "/onboarding": "operator",
  "/payees": "operator",
  "/payments": "operator",
  "/payouts": "operator",
  "/pots": "operator",
  "/reconciliation": "operator",
  "/standing-orders": "operator",
  "/statements": "operator",
  "/team": "operator",
  "/transactions": "operator",
};
