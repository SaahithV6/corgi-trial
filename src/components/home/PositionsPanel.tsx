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
import type { AccountPosition, BookTotals } from "./console-contract";

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
  const plural = totals.accounts === 1 ? "account" : "accounts";

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
            cents={totals.ledgerCents}
            detail={`Σ over ${totals.accounts} ${plural} at ${totals.businesses} ${
              totals.businesses === 1 ? "business" : "businesses"
            }. A fold over immutable journal lines — there is no balance column.`}
          />
          <Figure
            label="Available balance"
            cents={totals.availableCents}
            detail={
              totals.negativeAvailable === 0
                ? "Ledger minus every hold still withholding money. No account is currently negative."
                : `${totals.negativeAvailable} ${
                    totals.negativeAvailable === 1 ? "account is" : "accounts are"
                  } below zero — an over-capture, shown rather than clamped.`
            }
          />
          <Figure
            label="Withheld"
            cents={totals.withheldCents}
            detail="Card authorisations, manual holds and uncleared credits. Off balance sheet: the memo book sums to zero on its own."
          />
        </dl>

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
                        <span className="mt-0.5 block text-xs text-muted">
                          {position.accountName} ••{position.last4}
                        </span>
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
