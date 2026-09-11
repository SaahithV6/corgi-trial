import { Suspense } from "react";
import { randomUUID } from "node:crypto";

import Link from "next/link";
import type { Metadata } from "next";

import { isErr } from "@/lib/result";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { DEMO_ACCOUNTS } from "@/components/account/fixtures";
import { listLiveAccounts } from "@/components/account/live-data-source";
import { DEMO_STATE_LABELS, demoQuery } from "@/components/account/demo-state";

import {
  ConsoleErrorPanel,
  ConsoleSkeleton,
  DemoStateBar,
  ProvenanceLine,
} from "@/components/accounts/ConsoleChrome";
import { ConsoleView } from "@/components/accounts/ConsoleView";
import {
  isLiveConsole,
  parseConsoleView,
  type ConsoleView as ConsoleViewState,
} from "@/components/accounts/console-state";
import { CardControlsPanel } from "@/components/accounts/CardControlsPanel";
import { fixtureConsole, holdOpenForLoadingState } from "@/components/accounts/fixtures";
import { loadConsole } from "@/components/accounts/live-source";

import { systemClock } from "@/lib/timetravel/clock";
import {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  parseTimeTravelParams,
  withTimeTravel,
  type TimeTravelRequest,
} from "@/lib/timetravel/params";
import { RefusalPanel } from "@/components/timetravel/Refusal";
import { TimeTravelBar } from "@/components/timetravel/TimeTravelBar";
import { CutNotice } from "@/components/timetravel/CutNotice";

import { TimeTravelUnavailableNote, TravelledDirectory } from "./time-travel";
import {
  drainAction,
  issueCardAction,
  simulateAuthorizeAction,
  simulateClearingAction,
} from "./actions";

export const metadata: Metadata = {
  title: "Accounts · Corgi ops console",
};

/**
 * Never prerendered. Every figure below is a fold over the journal taken at
 * request time; baking one into a build artefact would put a deploy-time
 * balance on a screen an operator reads as current.
 */
export const dynamic = "force-dynamic";

/**
 * The ceiling on this page's Server Actions, in seconds.
 *
 * `simulateAuthorizeAction` calls a provider and then waits — bounded — for the
 * webhook it triggered to become a hold, and then for the compare-and-append to
 * move the memo book. Worst case that is about fifteen seconds of deliberate
 * waiting, which is comfortably past the platform's default for a page
 * function. Set at the page level because that is what governs every action
 * invoked from it.
 *
 * It is a CEILING, not a target: the actions have their own budgets and give up
 * long before this, so a slow round trip becomes a stated `pending` result
 * rather than a request that dies at the platform's limit with nothing to show.
 */
export const maxDuration = 60;

/**
 * `/accounts` — the card and hold console.
 *
 * This screen exists to make one idea operable rather than merely legible:
 * THE LEDGER BALANCE AND THE AVAILABLE BALANCE ARE DIFFERENT NUMBERS, AND THE
 * HOLDS ARE THE ENTIRE DIFFERENCE.
 *
 * So it is not a report. From here an operator can, against the real provider
 * and the real deployed pipeline:
 *
 *   1. issue a card on Lithic and bind it to a customer's chart of accounts;
 *   2. put an authorisation on that card through Lithic's sandbox simulator,
 *      and watch AVAILABLE fall by exactly the authorised amount while LEDGER
 *      does not move a cent;
 *   3. clear it, in whole or in part or for more than was authorised, and
 *      watch the hold resolve and the ledger finally move;
 *   4. open any hold and read the event set and the fold that produced H(E).
 *
 * None of those steps posts money from this file. Each one calls a provider;
 * the webhook that comes back is what posts, through the same inbox, the same
 * dispatcher and the same consumer a production authorisation would take. See
 * the header of `./actions.ts`.
 *
 * Five states, all in the query string, all with a URL that reproduces them:
 *
 *   (none)          LIVE — real cards, real holds, real balances
 *   ?state=loading  the live read, held open so the real skeleton can be seen
 *   ?state=empty    a verified customer with an account and nothing on it
 *   ?state=error    the console read failed; retry is live
 *   ?state=edge     the over-capture — authorised $50.00, cleared $73.40, and
 *                   an available balance that is negative and NOT clamped
 *
 * The Suspense boundary is what makes the loading state honest: `ConsoleSection`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per state and per customer, so switching re-suspends
 * instead of showing the previous customer's balances under a new heading.
 *
 * ===========================================================================
 * TIME TRAVEL: PARTIAL, AND LABELLED AS PARTIAL
 * ===========================================================================
 *
 * `?asOf=<date>&asKnownAt=<timestamp>` is honoured by the DEPOSIT DIRECTORY on
 * this screen and NOT by the card and hold console. The directory is pure
 * ledger — `settledBalanceCents` and `accountAvailability` called with a
 * travelled snapshot — and the console reads through a module owned by another
 * worker that takes its own live snapshot internally.
 *
 * So the console carries an explicit PINNED TO NOW note whenever the URL names
 * a point, naming the module and the reason. A screen that ignored the
 * parameter while showing a time-travel control would be a lie, and this build
 * fails harder for a false label than for a missing feature.
 *
 * WITH NEITHER PARAMETER PRESENT NOTHING ON THIS PAGE CHANGES AT ALL. The
 * parse reports `absent`, none of the time-travel components render, no extra
 * query is issued, and the page is exactly the one that was here before.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const view = parseConsoleView(resolvedSearchParams);
  const live = isLiveConsole(view);

  // ONE CLOCK, TAKEN ONCE. Nothing below calls `new Date()`.
  const parsed = parseTimeTravelParams(resolvedSearchParams, systemClock.now());
  const travelling = parsed.ok && !parsed.request.absent;
  const basePath = accountsBasePath(resolvedSearchParams);
  const liveHref = withTimeTravel(basePath, { asOf: null, asKnownAt: null });

  // An impossible coordinate is refused BEFORE a connection is opened, and it
  // replaces the screen rather than sitting above a page full of figures that
  // silently answer a different question.
  if (!parsed.ok) {
    return (
      <div className="space-y-6">
        <RefusalPanel refusals={parsed.refusals} liveHref={liveHref} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">
          Cards, holds and the two balances
        </h1>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          Ledger balance is what the journal has booked. Available balance is
          what can be spent. Neither is a stored column — both are folds over
          journal lines — and every cent of the difference between them is a
          hold, itemised below with the arithmetic that sized it.
        </p>
      </header>

      <ProvenanceLine live={live} />

      {travelling ? (
        <Suspense fallback={null}>
          <TimeTravelSection request={parsed.request} basePath={basePath} liveHref={liveHref} />
        </Suspense>
      ) : (
        <TimeTravelEntryPoint basePath={basePath} />
      )}

      <DemoStateBar view={view} />

      <Suspense
        key={`${view.state}:${view.businessId ?? "default"}`}
        fallback={<ConsoleSkeleton />}
      >
        <ConsoleSection view={view} />
      </Suspense>

      <Suspense fallback={null}>
        <AccountDirectory />
      </Suspense>

      <DemoAccountDirectory />

      {/*
        Card controls, decided inside Lithic's Authorization Stream Access
        timeout. Measured, not quoted: the hard deadline is 6000ms and Lithic
        DECLINES when it expires — a stalling responder produced
        `DECLINED / UNKNOWN_HOST_TIMEOUT` with `CUSTOMER_ASA_TIMEOUT` after
        6.19s, against a 0.334s baseline with no responder enrolled.

        The panel reads Lithic's enrollment endpoint live, so it states on its
        face whether the provider is actually calling us rather than implying
        it.
      */}
      <CardControlsPanel searchParams={resolvedSearchParams} businessId={view.businessId} />
    </div>
  );
}

/**
 * The console itself.
 *
 * An async server component so the skeleton above is a real fallback rather
 * than a mock. It resolves the data source — live database or fixture — and
 * hands the server actions down as props, which is what lets the presentation
 * components stay ignorant of the route they are mounted on.
 *
 * `formKey` is minted here, per render. It becomes Lithic's `Idempotency-Key`
 * on card creation, so a double-submitted form returns the card the first
 * submission created instead of putting a second one on the program.
 */
async function ConsoleSection({ view }: { readonly view: ConsoleViewState }) {
  const live = isLiveConsole(view);

  // The loading state is not a mock of a slow read; it IS a slow read, and the
  // page's Suspense boundary shows the real skeleton for as long as it takes.
  await holdOpenForLoadingState(view.state);

  const result = live ? await loadConsole(view.businessId) : fixtureConsole(view.state);

  if (isErr(result)) return <ConsoleErrorPanel error={result.error} />;

  const { businesses, snapshot } = result.value;

  if (snapshot === null) {
    return (
      <Panel
        title="No customer has both leaves of the chart"
        description="A card needs a 2100 deposit account to spend from and a 9100 memo account to hold against."
      >
        <p className="px-5 py-8 max-w-prose text-sm text-muted">
          No business on this book has both. A business gets its accounts when
          KYB approves it, and not before — you cannot owe money to a business
          you have not verified. Approve one on{" "}
          <Link
            href="/onboarding"
            className={`underline underline-offset-4 ${FOCUS_RING}`}
          >
            onboarding
          </Link>{" "}
          and this console will have somewhere to work.
        </p>
      </Panel>
    );
  }

  return (
    <ConsoleView
      snapshot={snapshot}
      live={live}
      view={view}
      businesses={businesses}
      formKey={randomUUID()}
      actions={{
        issueCard: issueCardAction,
        authorize: simulateAuthorizeAction,
        clearing: simulateClearingAction,
        drain: drainAction,
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The directory                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every deposit account on the book, read live.
 *
 * Kept because the console works one customer at a time and the per-account
 * screen at `/accounts/[accountId]` is where postings live. The figures come
 * from the same fold that screen renders, so a row here and the page it links
 * to cannot quote different numbers.
 */
async function AccountDirectory() {
  const live = await listLiveAccounts();

  return (
    <Panel
      title="Every deposit account"
      description="The whole book, folded at request time. Each row links to that account's own screen: postings on both clocks, holds, and the bitemporal statement."
      actions={<Badge tone="positive">live ledger</Badge>}
    >
      {isErr(live) ? (
        <div className="px-5 py-8">
          <p className="text-sm text-negative">
            The account list could not be read.
          </p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-[8rem_1fr]">
            <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
            <dd className="font-mono text-xs">{live.error.code}</dd>
            <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
            <dd className="max-w-prose text-sm">{live.error.message}</dd>
          </dl>
          <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
            This is a read failure. Nothing moved — the ledger is append-only and
            a query cannot alter it.
          </p>
        </div>
      ) : live.value.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">
          No customer deposit accounts have been opened. A business gets its 2100
          account when KYB approves it, and not before — you cannot owe money to
          a business you have not verified.
        </p>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Customer deposit accounts with their ledger and available balances,
              read live from the journal
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  Account
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Ledger balance
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Available balance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {live.value.map((account) => (
                <tr key={account.accountId}>
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={`/accounts/${account.accountId}`}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      {account.accountName} ••{account.last4}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">
                      {account.businessName}
                    </span>
                  </th>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={account.ledgerCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={account.availableCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

/**
 * The fixture accounts behind the per-account screen's own five states.
 *
 * Labelled, and kept in their own table, because a directory that mixes seeded
 * demo money with real balances under one heading is how a screenshot ends up
 * in a deck claiming the wrong thing.
 */
function DemoAccountDirectory() {
  return (
    <Panel
      title="Demo accounts"
      description="Fixtures behind the account screen's five URL-driven states. They write nothing and read nothing: an over-capture, an empty account and a failed query are not conditions you seed on a live ledger to show someone."
      actions={<Badge tone="quiet">fixture</Badge>}
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Demo accounts, with the state each row opens in
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Account
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Ledger balance
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Available balance
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Opens in
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {DEMO_ACCOUNTS.map((account) => {
              // The bare default URL is live now, so the demo account that
              // quotes the default fixture opens with the authorisation toggle
              // instead — the one other view that is still a fixture.
              const query = demoQuery({
                state: account.state,
                authPending: account.state === "default",
              });

              return (
                <tr key={account.accountId}>
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={`/accounts/${account.accountId}${query}`}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      {account.accountName} ••{account.last4}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">
                      {account.businessName}
                    </span>
                  </th>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={account.ledgerCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={account.availableCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right text-xs text-muted`}>
                    {DEMO_STATE_LABELS[account.state]}
                    {account.state === "default" ? " · auth pending" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Time travel                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The travelled half of this screen.
 *
 * An async server component behind its own Suspense boundary, so resolving the
 * point and folding five accounts at it never delays the console above — the
 * two are independent reads and the slower one must not hold the faster one
 * hostage.
 */
async function TimeTravelSection({
  request,
  basePath,
  liveHref,
}: {
  readonly request: TimeTravelRequest;
  readonly basePath: string;
  readonly liveHref: string;
}) {
  const { ledgerConnection } = await import("@/lib/ledger/queries");
  const { resolveTimePoint } = await import("@/lib/timetravel/point");
  const { correctionLandmarks } = await import("@/lib/timetravel/landmarks");
  // `busiestDepositAccountId` is in `readers.ts` and is NOT on the `queries.ts`
  // forwarding surface. Imported by path rather than added to that surface,
  // because `src/lib/ledger/**` is not this worker's to edit — reported in
  // `docs/TIMETRAVEL.md` as a one-line export that belongs there.
  const { mostActiveDepositAccountId } = await import("@/lib/ledger/readers");

  const conn = await ledgerConnection();
  const point = await resolveTimePoint(request, conn, systemClock);

  // The control needs somewhere to get its landmarks from. The busiest deposit
  // account is the one a demo is most likely to have driven, and the bar says
  // which account they came from rather than implying they are book-wide.
  const busiest = await mostActiveDepositAccountId({}, conn);
  const landmarks =
    busiest === null ? [] : await correctionLandmarks({ accountId: busiest }, conn);

  return (
    <div className="space-y-6">
      <TimeTravelBar
        point={point}
        basePath={basePath}
        landmarks={landmarks}
        liveHref={liveHref}
      />
      <CutNotice point={point} />
      <TravelledDirectory point={point} />
      <TimeTravelUnavailableNote point={point} />
    </div>
  );
}

/**
 * The way in, when no point is named.
 *
 * Deliberately a link and not a rendered control: with no parameter this page
 * must be byte-for-byte the page it was before, and a control that reads the
 * ledger to populate itself is not nothing. It is also the only route to
 * `/transactions`, which is not in the nav — `src/components/app-shell/NavLinks.tsx`
 * belongs to another worker and adding an entry there is a one-line change
 * that is theirs to make.
 */
function TimeTravelEntryPoint({ basePath }: { readonly basePath: string }) {
  return (
    <aside
      aria-label="Time travel"
      className="rounded-lg border border-dashed border-border-strong px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Time travel
        </span>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Every figure on this console is a fold over journal lines at a value
          date and a booking watermark. Name a point in the URL —{" "}
          <span className="font-mono text-text">?{AS_OF_PARAM}=</span> and{" "}
          <span className="font-mono text-text">?{AS_KNOWN_AT_PARAM}=</span> —
          and the deposit directory re-renders there.{" "}
          <Link
            href="/transactions"
            className={`underline underline-offset-4 ${FOCUS_RING}`}
          >
            /transactions
          </Link>{" "}
          honours both axes in full, with the acts that changed the answer.
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Link
          href={withTimeTravel(basePath, { asKnownAt: null, asOf: null })}
          aria-current="page"
          className={`rounded bg-surface-raised px-2 py-1 text-xs font-medium shadow-[inset_0_0_0_1px_var(--color-border-strong)] ${FOCUS_RING}`}
        >
          now
        </Link>
        <Link
          href="/transactions?state=edge"
          className={`rounded px-2 py-1 text-xs text-muted hover:text-text ${FOCUS_RING}`}
        >
          show me a corrected day
        </Link>
      </div>
    </aside>
  );
}

/** This route with its own query state, as the base every time link builds on. */
function accountsBasePath(
  params: Record<string, string | string[] | undefined>,
): string {
  const out = new URLSearchParams();
  for (const key of ["state", "business", "card", AS_OF_PARAM, AS_KNOWN_AT_PARAM]) {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== undefined && value !== "") out.set(key, value);
  }
  const query = out.toString();
  return query === "" ? "/accounts" : `/accounts?${query}`;
}
