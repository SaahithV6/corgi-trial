import Link from "next/link";
import type { Route } from "next";

import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";

import type { ClientHeader } from "./contract";
import {
  CLIENT_SCREENS,
  CLIENT_STATES,
  CLIENT_STATE_LABELS,
  clientHref,
  type ClientScreenHref,
  type ClientState,
  type ClientView,
} from "./view-state";

/* -------------------------------------------------------------------------- */
/* The five states, as links                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What each state means ON THIS SURFACE, said per screen.
 *
 * The hints are per screen rather than shared, because "edge" means a different
 * thing on a balance than on a card and a reader deserves to be told which one
 * they are about to see. They are also the honest labels: where a state is a
 * fixture it says FIXTURE, and where it is live it says live.
 */
export const STATE_HINTS: Record<ClientScreenHref, Record<ClientState, string>> = {
  "/client": {
    default: "Live. This business's real balance, read through ledger_availability() — the same function the staff console reads.",
    loading: "The real skeleton, held open by a genuinely slow read. Not a mock.",
    empty: "FIXTURE. An account that has just opened: nothing in, nothing held, and the arithmetic still shown.",
    error: "FIXTURE. The read failed. Nothing moved — this screen only reads.",
    edge: "LIVE. A business whose available balance is NEGATIVE while its ledger balance is positive: money has landed and not cleared. Correct, not clamped, and real on this book.",
  },
  "/client/activity": {
    default: "Live. Every movement on this business's current account, newest first, in plain language.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A customer with no transactions yet.",
    error: "FIXTURE. The read failed. Nothing moved.",
    edge: "LIVE. Only the corrections — a settlement that was taken back, shown beside the entry it reverses. Both are still on the record.",
  },
  "/client/cards": {
    default: "Live. The card for each person on the team, what it can and cannot do, and every authorisation decision on it.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A team with no cards issued yet.",
    error: "FIXTURE. The read failed. No card was affected.",
    edge: "LIVE. Only the declines, each with the sentence it was recorded with at the moment it was decided.",
  },
  "/client/pay": {
    default: "Live. The real form, against the live approval policy and this business's own confirmed payees.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A business that has not passed its checks, so it cannot send money.",
    error: "FIXTURE. The preflight read failed, so the form is not drawn.",
    edge: "LIVE, prefilled at exactly the approval threshold — one cent under is unattended, this is not.",
  },
  "/client/funding": {
    default: "Live. The external accounts this business has linked, and what each one is able to do right now.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A customer who has linked no bank yet.",
    error: "FIXTURE. The link could not be read, so no account is offered \u2014 funding from a link we cannot verify is the one thing this screen must not do.",
    edge: "LIVE. An item that needs a human to re-authenticate. Plaid said so itself, in a webhook we kept; the money is not gone and nothing is broken except the permission.",
  },
  "/client/team": {
    default: "Live. Everyone on this team, their card, and what each card is allowed to do.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A business with nobody on the team yet.",
    error: "FIXTURE. The team could not be read. No membership and no card was affected.",
    edge: "LIVE. A membership that has ended \u2014 the person is kept, the card is closed at the issuer, and nothing is deleted.",
  },
  "/client/standing-orders": {
    default: "Live. The payments this business has scheduled, and the next date each one comes round.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A customer with nothing scheduled.",
    error: "FIXTURE. The mandates could not be read. Nothing was scheduled and nothing fired \u2014 a render never fires a payment.",
    edge: "LIVE. A mandate on a day the balance could not cover it: refused and closed, not sent short and not carried over, with both figures and the shortfall on the row.",
  },
  "/client/statements": {
    default: "Live. Closed days only, each rebuilt from the ledger and hash-checked on the page load that shows it.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A business with no closed day yet.",
    error: "FIXTURE. The book could not be read, so no statement is drawn \u2014 a statement from numbers nobody read is the one artefact here that would be worth nothing.",
    edge: "LIVE. A day carrying a correction: the settlement, the reversal and the re-book, with the closing balance already holding the corrected figure.",
  },
  "/client/open": {
    default: "Live. The registry leg is a real call to GLEIF on submit; the answer you see is the register's own.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. The blank form, before anything has been submitted.",
    error: "FIXTURE. The register could not be reached, so no answer is claimed \u2014 an application cannot be approved by a check that did not run.",
    edge: "FIXTURE. An application the register declined. No account was opened and none will be on this application.",
  },
  "/client/pots": {
    default: "Live. This business's own pots, their balances, and the identity that must hold: main + every pot = the whole account.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A customer who has not opened a pot yet.",
    error: "FIXTURE. The read failed. No pot was affected \u2014 this state only reads.",
    edge: "LIVE. A pot drained to exactly $0.00. Zero is a legal, ordinary state; one cent past it is refused by the database, not by the form.",
  },
  "/client/disputes": {
    default: "Live. This business's settled card charges, what is still unclaimed on each, and every case already raised.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A customer with nothing to dispute.",
    error: "FIXTURE. The read failed. No claim was affected.",
    edge: "LIVE. Only the charges already claimed \u2014 filing again returns the case that exists rather than opening a second.",
  },
  "/client/payouts": {
    default: "Live. A real rate from frankfurter.dev, and every commitment this business is already standing behind.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. A customer who has never asked for a quote.",
    error: "FIXTURE. The rate could not be read, so no quote is offered \u2014 a quote with no rate behind it would be the whole feature undone.",
    edge: "LIVE. A business whose available balance is already committed to a standing quote, so the next acceptance is refused rather than overdrawn.",
  },
  "/client/approvals": {
    default: "Live. The policy in force, and the payment named by ?payment= if there is one.",
    loading: "The real skeleton, held open by a genuinely slow read.",
    empty: "FIXTURE. Nothing is waiting on you.",
    error: "FIXTURE. The read failed. No decision was recorded.",
    edge: "LIVE. The same payment, judged for the person you are acting as — including the refusal when that person is the one who raised it.",
  },
};

export function ClientStateBar({
  screen,
  view,
}: {
  readonly screen: ClientScreenHref;
  readonly view: ClientView;
}) {
  const hints = STATE_HINTS[screen];
  return (
    <aside
      aria-label="Demo states"
      className="rounded-lg border border-dashed border-border-strong px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Demo state
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {CLIENT_STATES.map((state) => {
            const current = state === view.state;
            return (
              <Link
                key={state}
                href={
                  clientHref(screen, {
                    state,
                    businessId: view.businessId,
                    paymentId: view.paymentId,
                  }) as Route
                }
                aria-current={current ? "page" : undefined}
                title={hints[state]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {CLIENT_STATE_LABELS[state]}
              </Link>
            );
          })}
        </div>
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {hints[view.state]}
      </p>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Whose book                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The business selector — and the sentence that says what it is not.
 *
 * ===========================================================================
 * THIS IS NOT AN AUTHORISATION MECHANISM AND IT MUST NEVER BECOME ONE
 * ===========================================================================
 *
 * `src/components/app-shell/role.ts` carries the same warning about the role
 * cookie and it is the right shape to copy: a control the browser can set is a
 * DEMO AFFORDANCE, not an access-control decision.
 *
 * What makes this one safe to ship today is that it does not grant a view — it
 * chooses a subject for a query whose isolation is already a `WHERE` clause.
 * The console it sits inside is open by construction (`docs/DEMO.md` §1: there
 * is nothing to sign into), so this selector reveals nothing that `/accounts`
 * does not already show a stranger.
 *
 * What replaces it is one line: `businessId` stops coming from `searchParams`
 * and starts coming from a verified session claim. Every read beneath it is
 * unchanged, because every read already treats the id as a predicate the
 * database applies rather than as permission the screen grants.
 */
export function BusinessPicker({
  screen,
  view,
  header,
}: {
  readonly screen: ClientScreenHref;
  readonly view: ClientView;
  readonly header: ClientHeader;
}) {
  return (
    <form action={screen} method="get" className="flex flex-wrap items-end gap-2">
      {view.state === "default" ? null : (
        <input type="hidden" name="state" value={view.state} />
      )}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Signed in as
        </span>
        <select
          name="business"
          defaultValue={header.businessId}
          className={`rounded border border-border-strong bg-surface px-2 py-1.5 text-sm ${FOCUS_RING}`}
        >
          {header.businesses.length === 0 ? (
            <option value={header.businessId}>{header.legalName}</option>
          ) : (
            header.businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.legalName}
                {b.hasAccount ? "" : " — no account yet"}
              </option>
            ))
          )}
        </select>
      </label>
      <button
        type="submit"
        className={`rounded border border-border-strong px-2.5 py-1.5 text-xs font-medium ${FOCUS_RING}`}
      >
        Switch
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* The header every client screen wears                                       */
/* -------------------------------------------------------------------------- */

export function ClientHeaderBar({
  screen,
  view,
  header,
  title,
  subtitle,
}: {
  readonly screen: ClientScreenHref;
  readonly view: ClientView;
  readonly header: ClientHeader;
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <header className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold tracking-tight">{title}</h1>
            {header.live ? (
              <Badge tone="positive">live</Badge>
            ) : (
              <Badge tone="negative">fixture</Badge>
            )}
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{subtitle}</p>
          <p className="mt-2 text-sm font-medium">{header.legalName}</p>
          <p className="text-xs text-muted">
            {header.accountName ?? "No current account has been opened yet."}
          </p>
        </div>
        <BusinessPicker screen={screen} view={view} header={header} />
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Failure, and waiting                                                       */
/* -------------------------------------------------------------------------- */

export function ClientErrorPanel({
  code,
  message,
}: {
  readonly code: string;
  readonly message: string;
}) {
  return (
    <Panel
      title="We could not load this"
      description="Nothing moved. Every read on this surface is a SELECT, and the application role this build connects as holds no UPDATE or DELETE on a money table at all."
      actions={<RetryButton label="Try again" />}
    >
      <div className="px-5 py-5">
        <Note emphasis title={code}>
          {message}
        </Note>
      </div>
    </Panel>
  );
}

/** The real skeleton. `?state=loading` slows the read; it does not fake this. */
export function ClientSkeleton({ rows = 4 }: { readonly rows?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your account.</span>
      <div className="rounded-lg border border-border bg-surface px-5 py-6">
        <div className="h-3 w-40 rounded bg-surface-raised" />
        <div className="mt-4 h-9 w-56 rounded bg-surface-raised" />
        <div className="mt-3 h-3 w-72 rounded bg-surface-raised" />
      </div>
      <div className="rounded-lg border border-border bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-b-0">
            <div className="h-3 w-24 rounded bg-surface-raised" />
            <div className="h-3 flex-1 rounded bg-surface-raised" />
            <div className="h-3 w-20 rounded bg-surface-raised" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Where you are                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The customer's own five screens.
 *
 * Rendered inside the client layout as well as being carried in the console's
 * nav, because a customer surface that can only be reached through a staff nav
 * is not a surface, it is a bookmark. Both lists exist and both are checked:
 * `NavLinks.test.ts` asserts the console nav carries every front-door screen,
 * and this one is what a reader actually uses once they are here.
 */
export function ClientNav({
  current,
  view,
}: {
  readonly current: ClientScreenHref;
  readonly view: ClientView;
}) {
  return (
    <nav aria-label="Your account" className="flex flex-wrap items-center gap-1">
      {CLIENT_SCREENS.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={
              clientHref(item.href, {
                state: view.state,
                businessId: view.businessId,
              }) as Route
            }
            aria-current={active ? "page" : undefined}
            className={`rounded px-3 py-1.5 text-sm ${FOCUS_RING} ${
              active
                ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border)]"
                : "text-muted hover:text-text"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
