/**
 * The same decision, re-derived where the middleware cannot reach: inside the
 * server action itself.
 *
 * ============================================================================
 * WHY THE MIDDLEWARE IS NOT ENOUGH
 * ============================================================================
 *
 * `src/middleware.ts` gates on PATHNAME. A Next.js server action POSTs to the
 * page the browser is currently on, so an operator action invoked from a
 * `/client/*` screen arrives carrying a `/client/*` pathname, `authorize()`
 * says "customer surface, allowed", and the `(app)` layout — which re-derives
 * the same decision and fails closed — never runs, because a layout does not
 * execute for an action that renders no page.
 *
 * Measured on this build before this file existed (`next start`, production
 * bundle, 2026-09-11), and written up in `action-reachability.test.ts`:
 *
 *     POST /client/pay  Cookie: corgi_demo_role=customer
 *                       $ACTION_ID_<raisePaymentAction>
 *     -> 500  TypeError: Cannot read properties of undefined (reading 'get')
 *
 * The operator action's BODY ran, under a customer cookie, and stopped on an
 * argument-shape error rather than on an authorisation decision.
 *
 * THE MIDDLEWARE CHECKS WHERE YOU ARE, NOT WHAT YOU ARE CALLING. So the action
 * stops trusting it. The middleware stays — this is defence in depth, not a
 * replacement — and every operator action calls `assertOperatorAction()` as its
 * first statement, which reads the cookie itself and asks `authorize()` again.
 *
 * ============================================================================
 * WHY A SENTINEL PATH AND NOT THE ACTION'S OWN ROUTE
 * ============================================================================
 *
 * `authorize()` takes a pathname, and an action does not have one it can trust:
 * the pathname it was posted to is precisely the thing that lied. Passing the
 * owning route instead ("this action belongs to /payouts") would be a string
 * every author has to type correctly — the guard's population chosen by hand
 * again, which is the defect this repository has catalogued thirty-odd times.
 *
 * So the guard asks about a path that CANNOT be on the customer surface and
 * never will be. `surfaceOf()` is total and biased to `operator`: anything not
 * `/` and not under `/client` is operator. The sentinel is therefore the
 * default-deny branch of the real policy function, evaluated for real — not a
 * second copy of the rule, and not a bare `isOperator()` that would drift from
 * `authorize()` the day the policy gains a third surface.
 *
 * ============================================================================
 * WHY IT THROWS
 * ============================================================================
 *
 * Because the thirty-seven operator actions return thirty-seven different
 * result shapes, and a guard that had to construct each of them would be a
 * guard that could be got wrong per action. A throw is uniform, is impossible
 * to forget to check, and cannot be accidentally swallowed into a "done"
 * branch. The message carries `OPERATOR_ONLY` — the same code the middleware
 * puts on `x-corgi-authz` — so a log line, a grader and a test all say the same
 * word about what happened.
 */

import { cookies } from "next/headers";

import {
  SESSION_COOKIE,
  SIGN_IN_REQUIRED,
  type ConsoleAuthRefusal,
  verifySession,
} from "@/lib/auth/session";

import { OPERATOR_ONLY, authorize } from "./policy";
import { ROLE_COOKIE, roleFromCookieValue, type Role } from "./roles";

/**
 * The path the guard authorises against. Not a route: nothing is served here,
 * and nothing ever will be. It exists so that "may this principal execute an
 * operator capability" is answered by `authorize()` itself, on its default-deny
 * branch, rather than by a hand-rolled second opinion.
 */
export const SERVER_ACTION_SENTINEL_PATH = "/__server-action__" as const;

/**
 * The AUTHENTICATION refusal, as an exception.
 *
 * ============================================================================
 * WHY AN ACTION CHECKS THE SESSION AND NOT ONLY THE ROLE
 * ============================================================================
 *
 * The console is readable with no session and writable only with one. The
 * middleware enforces that on `POST` to an operator pathname — and a server
 * action does not have to be posted to an operator pathname. It is posted to
 * WHATEVER PAGE THE BROWSER IS ON, which is the same hole, in the same file,
 * that `OperatorOnlyActionError` below exists to close: an operator action
 * invoked from `/client/pay` arrives with a customer pathname, `surfaceOf()`
 * says "customer surface", and control 3 never runs.
 *
 * Before this check, that was a way to write to the console with no
 * credential at all. So the action asks the question itself, from the cookie,
 * with no trust in the matcher having fired — the same defence-in-depth
 * argument the role check is written under, applied one layer up to the
 * question that now precedes it.
 *
 * `code` is the same string the middleware puts on `x-corgi-authz`, so a log
 * line, a grader and a test all say the same word about what happened.
 */
export class SignInRequiredActionError extends Error {
  readonly code = SIGN_IN_REQUIRED;
  readonly reason: ConsoleAuthRefusal;
  readonly actionName: string;

  constructor(actionName: string, reason: ConsoleAuthRefusal) {
    super(
      `deny; ${SIGN_IN_REQUIRED}: ${actionName} refused — ${reason}. ` +
        "This console is readable without a session and writable only with one. This is a " +
        "write, and no session cookie on this request carried a valid signature, so nothing " +
        "in the action's body ran. The refusal is not about where it was posted: a server " +
        "action carries the pathname of the page the browser is on, so the action re-derives " +
        "the decision from the cookie rather than trusting the middleware to have seen it. " +
        "Sign in at /signin with the console passphrase. See docs/AUTH.md.",
    );
    this.name = "SignInRequiredActionError";
    this.actionName = actionName;
    this.reason = reason;
  }
}

/** The refusal, as an exception. `code` is the same string the middleware sends. */
export class OperatorOnlyActionError extends Error {
  readonly code = OPERATOR_ONLY;
  readonly role: Role;
  readonly actionName: string;

  constructor(actionName: string, role: Role) {
    super(
      `deny; ${OPERATOR_ONLY}: ${actionName} refused to role '${role}'. ` +
        "This is an operator capability, not a screen, so the refusal is not about where it " +
        "was posted: a server action carries the pathname of the page the browser is on, the " +
        "middleware allowed that pathname, and the action re-derived the decision from the " +
        "cookie and refused it anyway. Nothing in the action's body ran.",
    );
    this.name = "OperatorOnlyActionError";
    this.actionName = actionName;
    this.role = role;
  }
}

/**
 * The role this request CLAIMS, read from the cookie by the action itself.
 *
 * Not from a header, not from an argument, not from anything the middleware
 * passed down — the point of this file is that the action believes nothing it
 * was handed. Anything unrecognised is `staff`, which is what `readRole()` and
 * the middleware already do; see `roles.ts` for why the default is an operator
 * role and why that is not a hole (the cookie is a demo credential either way,
 * and an absent cookie is an operator at a console, not a customer).
 */
export async function roleFromRequestCookie(): Promise<Role | null> {
  try {
    const store = await cookies();
    return roleFromCookieValue(store.get(ROLE_COOKIE)?.value);
  } catch (error) {
    if (error instanceof Error && OUTSIDE_A_REQUEST.test(error.message)) return null;
    throw error;
  }
}

/**
 * Next's own words when `cookies()` is reached with no request behind it —
 * `throwForMissingRequestStore`, next/dist/server/app-render/
 * work-unit-async-storage.external.js.
 *
 * Matched narrowly, and rethrown otherwise: any OTHER failure of the cookie
 * store is a failure to establish the principal, and a guard that cannot
 * establish the principal must not proceed.
 */
const OUTSIDE_A_REQUEST = /was called outside a request scope/;

/**
 * Refuse this action to a non-operator principal. First statement of every
 * operator server action; `action-guard.test.ts` fails by name when one is
 * added without it.
 */
export async function assertOperatorAction(actionName: string): Promise<void> {
  const role = await roleFromRequestCookie();

  // ── NO REQUEST, NO PRINCIPAL, NO DECISION ─────────────────────────────────
  //
  // `null` means Next found no request scope: nobody sent this, so there is
  // nobody to refuse. That is a direct call from a test, a script or a build —
  // `src/components/statements/pdf-action-no-database.test.ts` calls
  // `statementPdfAction({})` exactly this way, on purpose, to prove the
  // no-database refusal is still reachable.
  //
  // This is the one branch of this file that does not deny, so it is worth
  // being precise about why it grants nothing. Every HTTP entry into a Next app
  // establishes the work-unit store before user code runs — a page render, a
  // route handler, and a server action alike; that store is *why* `cookies()`
  // works inside an action at all. So an attacker's request can never reach
  // here with `null`: to get `null` you must already be executing inside this
  // process with an import statement, at which point the guard is not the thing
  // standing between you and the database.
  //
  // The narrow regex above is what keeps it honest. A cookie store that exists
  // but fails for any other reason rethrows, and the action dies rather than
  // running unauthorised.
  if (role === null) return;

  // ── AUTHENTICATION, THEN AUTHORISATION ────────────────────────────────────
  //
  // In that order, and the order is the point: "who are you" is answered before
  // "may you", here exactly as in `src/middleware.ts`. Reaching this line at
  // all means a request is executing an OPERATOR CAPABILITY — every caller of
  // this function is a write — and a write needs a session whatever role the
  // cookie claims. `verifySession` fails closed on an unset CONSOLE_PASSWORD
  // (`NOT_CONFIGURED`), so an unconfigured deployment refuses here too rather
  // than falling open, which is the inversion this whole build removed.
  //
  // The cookie store is read a second time rather than threaded through
  // `roleFromRequestCookie`, whose signature other callers depend on. The
  // first read already proved a request scope exists, so this one cannot be
  // the "outside a request" case and any throw from it is a real failure to
  // establish the principal — which must not proceed.
  const store = await cookies();
  const verdict = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (!verdict.ok) throw new SignInRequiredActionError(actionName, verdict.reason);

  const decision = authorize(role, SERVER_ACTION_SENTINEL_PATH);
  if (decision.allowed) return;
  throw new OperatorOnlyActionError(actionName, role);
}

/* -------------------------------------------------------------------------- */
/* The register of actions that are NOT operator-only                          */
/* -------------------------------------------------------------------------- */

/**
 * Action modules under `src/app/(app)` that a customer session may legitimately
 * execute, and why.
 *
 * This is NOT the guard's population. The guard's population is "every operator
 * action", decided by default: `action-guard.test.ts` walks the filesystem and
 * fails on any exported action that does not call `assertOperatorAction()`,
 * unless its module is named here with a reason. Adding an operator action
 * costs nothing; exempting one costs an entry somebody has to write and a
 * reviewer has to read.
 *
 * The `client/` tree is not listed because it is not exempted by name: it is
 * the customer's own product surface, every action in it carries a both-column
 * tenant predicate (`entryBelongsToBusiness`, `ownsPot`, `readOwnedQuote`, the
 * inline `AND c.business_id`), and those four are what actually scope a
 * customer's rows. The walk skips that tree wholesale.
 */
export const CUSTOMER_EXECUTABLE_ACTION_MODULES: Readonly<Record<string, string>> = {
  "src/app/(app)/actions.ts":
    "setRoleAction — the demo role switch itself. It is how a customer session " +
    "gets BACK to staff, so guarding it would strand the person in the role " +
    "they switched into with no way out. It writes one cookie and nothing else: " +
    "it reads no business, moves no money, and grants nothing the cookie did " +
    "not already grant (see docs/DEMO.md §1 — the credential IS the switch).",

  "src/app/(app)/payments/actions.ts":
    "raisePaymentAction — rendered by src/components/client/PaymentForm.tsx on " +
    "/client/pay, which is the customer's own screen. A role check here would " +
    "refuse the customer their own payment form. It is an OPEN FINDING for a " +
    "different reason, recorded in action-reachability.test.ts: `accountId` " +
    "comes from the form and is resolved without a tenant predicate, so the fix " +
    "is a both-column read inside requestPayment() (src/lib/approvals/), not a " +
    "role check here.",

  "src/app/(app)/approvals/actions.ts":
    "decideAction — rendered by src/components/client/ApproveForm.tsx on " +
    "/client/approvals. Same shape: the customer's own screen, so the refusal " +
    "cannot be by role. Same open finding — `instructionId` arrives from the " +
    "form with no `AND business_id` beside it — and the same fix, in the same " +
    "module, recorded in action-reachability.test.ts.",
};
