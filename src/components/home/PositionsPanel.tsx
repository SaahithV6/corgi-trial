import Link from "next/link";
import type { Route } from "next";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";

import { openAccountAction } from "./actions";
import type {
  AccountPosition,
  BookTotals,
  PositionTotals,
} from "./console-contract";

/**
 * The book, and the controls that act on it.
 *
 * ============================================================================
 * This is the first thing on the front door because it is the thing an
 * operator opens the console to see: how much customer money is on the book,
 * how much of it is actually spendable, and which business to open next.
 * ============================================================================
 *
 * Ledger and available sit side by side on purpose, and the gap between them
 * is printed rather than left to be inferred. Those two figures differing is
 * the single most important fact this system models — a balance is not a
 * number, it is two numbers, and every screen in this console shows both.
 *
 * No arithmetic happens in this file. `BookTotals` arrives folded from
 * `console-derive.ts`, in `bigint` cents, and every figure below is a field of
 * it or of an `AccountPosition`. `<Money>` renders `bigint` directly, so
 * nothing narrows on the way to the screen.
 *
 * ─── THE HEADLINE IS CUSTOMER MONEY, AND THE FIXTURES ARE PRINTED BESIDE IT ──
 *
 * Three of the seven deposit accounts on this book belong to test suites, not
 * to customers. One of them, `Holds Integration Fixture Co.`, sits at
 * -$858,941.45: its card-hold integration suite ran scenario 4b twenty-two
 * times over two days, force-posting $500,000.00 and refunding it a few
 * assertions later, and the final two runs before the suite was wrapped in a
 * rolled-back transaction threw in between. Twenty pairs net to zero; two
 * unpaired force-posts do not. Everything else that ever touched that leaf
 * sums to +$141,058.55.
 *
 * Summed in without a label, this panel's headline read, measured at
 * 2026-09-11T16:00Z: **the bank holds -$196,505.08 of customer money.** It
 * does not. Customers held $105,600.67 at that instant and the fixtures held
 * -$302,105.75. The customer figure moves because the demo book moves; the
 * sign of the headline is what changed and that does not.
 *
 * So the headline is `totals.live`, the fixture total is printed directly
 * underneath with a badge and a sentence saying what it is and is not, and
 * every fixture ROW is badged in place. **Nothing is filtered**: the table
 * still lists all seven, the account count does not move, and the two halves
 * reconcile to `totals` — which is the rule migration 0041 wrote for the same
 * problem on the FX book, because a filter that hides fixtures is one careless
 * predicate away from hiding a real failure, and it hides it from the screen
 * whose whole job is to be the record.
 *
 * Why the rows are not simply deleted or reversed: they are real, the hash
 * chain covers them, `scripts/rebuild.mjs` replays every one of them and
 * reports zero disagreements, and no provider ever sent the refund that would
 * justify appending one. See `@/lib/home/fixture-businesses`.
 */

const BUTTON =
  `inline-flex items-center rounded border border-border-strong px-3 py-1.5 text-xs font-medium ` +
  `enabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING}`;

/* -------------------------------------------------------------------------- */
/* The headline figures                                                       */
/* -------------------------------------------------------------------------- */

function Figure({
  label,
  cents,
  detail,
}: {
  readonly label: string;
  readonly cents: bigint;
  readonly detail: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </dt>
      <dd className="mt-1.5">
        <span className="block text-2xl font-semibold tracking-tight">
          <Money cents={cents} />
        </span>
        <span className="mt-1.5 block text-xs leading-relaxed text-muted">
          {detail}
        </span>
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* What is on this book that is NOT customer money                            */
/* -------------------------------------------------------------------------- */

/**
 * The fixture half of the book, stated rather than suppressed.
 *
 * This renders only when there is something to say — on a clean database
 * there are no fixture businesses and this is nothing. When there are, the
 * reconciliation is printed in full (`customers + fixtures = every open 2100
 * leaf`), so a reader who runs the sum by hand gets the same answer this
 * screen does and can see exactly where the difference went.
 */
function FixtureTotals({
  fixtures,
  all,
}: {
  readonly fixtures: PositionTotals;
  readonly all: BookTotals;
}) {
  if (fixtures.accounts === 0) return null;

  const n = fixtures.accounts;
  const noun = n === 1 ? "account" : "accounts";

  return (
    <div className="rounded-md border border-dashed border-border-strong bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Also on this book — test fixtures, not customers
        </span>
        <Badge tone="quiet">FIXTURE DATA</Badge>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted">ledger</dt>
          <dd className="font-medium">
            <Money cents={fixtures.ledgerCents} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">available</dt>
          <dd className="font-medium">
            <Money cents={fixtures.availableCents} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">
            {n} {noun}
          </dt>
          <dd className="text-muted">
            at {fixtures.businesses}{" "}
            {fixtures.businesses === 1 ? "business" : "businesses"}
          </dd>
        </div>
      </dl>

      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
        These {noun} belong to businesses opened by this repository&rsquo;s own
        test suites against the live database — they carry placeholder EINs,
        were never onboarded and were never verified. The rows are real
        postings and are left exactly where they are: this ledger is
        append-only, <code>scripts/rebuild.mjs</code> replays every one of them
        and reports zero disagreements, and no provider ever sent a correction
        that would justify appending one. They are <strong>not</strong> money
        owed to a customer, and they are not included in the three figures
        above. Together the two halves are the whole book:{" "}
        <Money cents={all.ledgerCents} /> ledger,{" "}
        <Money cents={all.availableCents} /> available, over {all.accounts}{" "}
        open <code>2100</code> {all.accounts === 1 ? "leaf" : "leaves"}.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function PositionsPanel({
  positions,
  totals,
  live,
}: {
  readonly positions: readonly AccountPosition[];
  readonly totals: BookTotals;
  readonly live: boolean;
}) {
  const customers = totals.live;
  const fixtures = totals.fixture;
  const plural = customers.accounts === 1 ? "account" : "accounts";

  return (
    <Panel
      id="positions"
      title="Customer money on this book"
      description="Ledger is the settled position; available is what the customer can actually spend. The difference is holds, and it is printed rather than implied."
      actions={
        <Badge tone={live ? "positive" : "quiet"}>
          {live ? "live query" : "fixture"}
        </Badge>
      }
    >
      <div className="space-y-5 px-5 py-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Figure
            label="Ledger balance"
            cents={customers.ledgerCents}
            detail={`Σ over ${customers.accounts} customer ${plural} at ${
              customers.businesses
            } ${
              customers.businesses === 1 ? "business" : "businesses"
            }. A fold over immutable journal lines — there is no balance column.`}
          />
          <Figure
            label="Available balance"
            cents={customers.availableCents}
            detail={
              customers.negativeAvailable === 0
                ? "Ledger minus every hold still withholding money. No customer account is currently negative."
                : `${customers.negativeAvailable} customer ${
                    customers.negativeAvailable === 1
                      ? "account is"
                      : "accounts are"
                  } below zero — an over-capture, shown rather than clamped.`
            }
          />
          <Figure
            label="Withheld"
            cents={customers.withheldCents}
            detail="Card authorisations, manual holds and uncleared credits. Off balance sheet: the memo book sums to zero on its own."
          />
        </dl>

        <FixtureTotals fixtures={fixtures} all={totals} />

        {positions.length === 0 ? (
          <p className="max-w-prose text-sm text-muted">
            No customer deposit accounts have been opened. A business gets its
            2100 account when KYB approves it, and not before — you cannot owe
            money to a business you have not verified.{" "}
            <Link
              href="/onboarding"
              className={`underline underline-offset-4 ${FOCUS_RING}`}
            >
              Verify one on Onboarding
            </Link>
            .
          </p>
        ) : (
          <>
            <TableScroll>
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Every customer deposit account, with its ledger balance,
                  available balance and the holds between them
                </caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className={TH_CLASS}>
                      Business
                    </th>
                    <th scope="col" className={`${TH_CLASS} text-right`}>
                      Ledger
                    </th>
                    <th scope="col" className={`${TH_CLASS} text-right`}>
                      Available
                    </th>
                    <th scope="col" className={`${TH_CLASS} text-right`}>
                      Held
                    </th>
                    <th scope="col" className={`${TH_CLASS} text-right`}>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {positions.map((position) => (
                    <tr key={position.accountId}>
                      <th
                        scope="row"
                        className={`${TD_CLASS} text-left font-normal`}
                      >
                        <span className="font-medium">{position.businessName}</span>
                        {position.fixture === null ? null : (
                          <>
                            {" "}
                            <Badge tone="quiet">FIXTURE</Badge>
                          </>
                        )}
                        <span className="mt-0.5 block text-xs text-muted">
                          {position.accountName} ••{position.last4}
                        </span>
                        {position.fixture === null ? null : (
                          <span className="mt-1 block max-w-prose text-[11px] leading-relaxed text-muted">
                            {position.fixture.reason} Written by{" "}
                            <code>{position.fixture.source}</code>.
                          </span>
                        )}
                      </th>
                      <td className={`${TD_CLASS} text-right`}>
                        <Money cents={position.ledgerCents} />
                      </td>
                      <td className={`${TD_CLASS} text-right`}>
                        <Money cents={position.availableCents} />
                      </td>
                      <td className={`${TD_CLASS} text-right`}>
                        <Money cents={position.activeHoldsCents} tone="neutral" />
                        {position.unclearedCreditsCents === 0n ? null : (
                          <span className="mt-0.5 block text-[11px] text-muted">
                            + uncleared{" "}
                            <Money
                              cents={position.unclearedCreditsCents}
                              tone="neutral"
                            />
                          </span>
                        )}
                      </td>
                      <td className={`${TD_CLASS} text-right`}>
                        <Link
                          href={`/accounts/${position.accountId}` as Route}
                          className={`inline-block underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                        >
                          Open
                          <span className="sr-only">
                            {" "}
                            {position.businessName}&rsquo;s account
                          </span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>

            <JumpToAccount positions={positions} />
          </>
        )}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The control                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Pick a business, go to its account.
 *
 * A plain `<form>` with a `<select>` and a submit button, posting to a server
 * action that does nothing but redirect. No client JavaScript, works on a
 * reload, and works with scripting off — the same discipline the role switcher
 * is built to. The account id is validated on the server before it reaches a
 * URL; see the header of `actions.ts`.
 */
function JumpToAccount({
  positions,
}: {
  readonly positions: readonly AccountPosition[];
}) {
  return (
    <form
      action={openAccountAction}
      className="flex flex-wrap items-end gap-3 border-t border-border pt-5"
    >
      <div>
        <label
          htmlFor="home-account-jump"
          className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          Go to a business&rsquo;s account
        </label>
        <select
          id="home-account-jump"
          name="accountId"
          defaultValue={positions[0]?.accountId ?? ""}
          className={`mt-1 min-w-64 rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING}`}
        >
          {positions.map((position) => (
            <option key={position.accountId} value={position.accountId}>
              {position.businessName} — {position.accountName} ••{position.last4}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={BUTTON}>
        Open account
      </button>

      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        Opens the full account: both balances, every hold with its arithmetic —
        authorised, cleared, remaining — and the postings behind them.
      </p>
    </form>
  );
}
