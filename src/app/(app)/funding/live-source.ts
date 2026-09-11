import "server-only";

/**
 * The live implementation of the funding screen's data contract.
 *
 * It lives under `src/app/(app)/funding/` rather than in `src/lib/` for the
 * same reason `payments/live-source.ts` does: `src/lib/**` is largely owned by
 * other workers on this build. Everything else about it follows the pattern
 * `src/components/account/live-data-source.ts` set — one place, and one place
 * only, where database shapes (bigint cents, a `HoldRow`, a
 * `funds_availability_policy` row) become the flat, JSON-safe shape a React
 * tree renders.
 *
 * Three narrowings happen here and nowhere else:
 *
 *   bigint -> string   a balance becomes `$2,500.00` HERE, through `formatUsd`,
 *                      because the contract deliberately carries no cent counts
 *                      at all. See the note at the top of `data-contract.ts`.
 *   Date -> ISO        an `available_at` becomes an ISO 8601 UTC string. The
 *                      release DATE travels beside it as `YYYY-MM-DD`, because
 *                      a banking day and an instant are different facts.
 *   throw -> value     every failure is a `Result`, so the screen's error state
 *                      is a branch and not an error boundary.
 *
 * ONE SNAPSHOT ANSWERS EVERY READ. `readSnapshot()` fixes `now()`, today in
 * book time and the booking watermark once, and every balance and hold below is
 * read against it — so the headline decomposition is a fold over exactly the
 * holds the table lists, and not a collage of three round trips.
 *
 * WHAT THIS MODULE DOES NOT DO: call Plaid. Drawing the screen must not depend
 * on a provider being reachable, and a page that made five HTTP requests to
 * sandbox.plaid.com on every render would be a page that shows an outage as a
 * blank screen. The only thing said about Plaid here is whether the credentials
 * are present, which is a fact about this process. Every claim about Plaid's
 * behaviour on this screen comes from a button somebody pressed.
 */

import type {
  BalanceView,
  FundableAccountView,
  FundingDataSource,
  FundingSnapshot,
  PolicyView,
  ProviderView,
  UnclearedHoldView,
} from "@/components/funding/data-contract";
import { formatUsd } from "@/lib/format/money";
import {
  accountAvailability,
  type Availability,
} from "@/lib/ledger/balance-definitions";
import {
  listDepositAccounts,
  listHoldRows,
  readSnapshot,
  type HoldRow,
  type LedgerSnapshot,
  type Sql,
} from "@/lib/ledger/queries";
import { sql } from "@/lib/ledger/db";
import {
  listAvailabilityPolicies,
  plaidWebhookUrl,
} from "@/lib/rails/plaid/adapter";
import { PlaidClient } from "@/lib/rails/plaid/client";
import { parsePlaidExternalRef } from "@/lib/rails/plaid/types";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

/* -------------------------------------------------------------------------- */
/* Balances                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The decomposition, taken from the ONE definition.
 *
 * `available` is not computed here any more. It is `accountAvailability()`,
 * which is a call to `ledger_availability()` in Postgres, which is also what
 * `v_available_balance` calls and what `availableBalance()` calls. There is
 * one body and this screen no longer has an opinion.
 *
 * It is allowed to go negative. An over-captured fuel-pump authorisation
 * settles above the amount authorised and the honest answer is that the
 * customer is overdrawn; clamping to zero here would hide a real overdraft
 * behind a cosmetic floor.
 */
function foldBalance(availability: Availability): BalanceView {
  return {
    ledgerDisplay: formatUsd(availability.ledgerCents),
    availableDisplay: formatUsd(availability.availableCents),
    cardHoldsDisplay: formatUsd(availability.holdsCents),
    unclearedDisplay: formatUsd(availability.unclearedCents),
    pendingOutboundDisplay: formatUsd(availability.pendingOutboundCents),
    availableIsNegative: availability.availableCents < 0n,
  };
}

/**
 * The figures for ONE account, as bigint cents, against one snapshot.
 *
 * ===========================================================================
 * WHAT THIS USED TO BE, AND WHY IT IS NOW FOUR LINES
 * ===========================================================================
 *
 * This function was the THIRD definition of "available" in the system. It was
 * written because the first two disagreed and the screen had to print one
 * number, and the comment that used to sit here said so, at length, and then
 * printed the number anyway:
 *
 *   `ledgerBalanceCents()` filtered `value_date <= today AND booking_seq <=
 *   watermark`. `availableBalance()` summed EVERY line with no value-date
 *   predicate at all. On the seeded demo business the two differed by
 *   $25,040.70 (measured 2026-09-11T02:10Z; $30,662.10 when this comment was
 *   first written), because the book carries $37,212.00 of debits value-dated
 *   tomorrow and a run of standing-order credits dated 2027.
 *
 * Both were wrong, in opposite directions, and this screen was wrong in a
 * third: it excluded future-dated CREDITS from the ledger term and then
 * subtracted the uncleared-credit holds guarding those same credits, charging
 * the customer $3,750.00 twice.
 *
 * Migration 0022 answered the question the disagreement was really about, once
 * and in one place. See `src/lib/ledger/balance-definitions.ts` and
 * `docs/BALANCE-DEFINITIONS.md`.
 */
export type BalanceCents = Availability;

export async function readBalanceCents(
  accountId: string,
  conn: Sql = sql,
): Promise<BalanceCents> {
  const snapshot = await readSnapshot(conn);
  return accountAvailability(accountId, snapshot, conn);
}

/* -------------------------------------------------------------------------- */
/* Holds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One uncleared-credit hold, flattened.
 *
 * `remainingCents` is what the hold actually withholds — `H(E)` — and it is the
 * figure printed, not `authorisedCents`. For an uncleared credit the two are
 * the same until something releases it, and printing the derived one keeps the
 * itemised row and the headline honest with each other by construction.
 *
 * The release date is derived from the instant in the BANKING timezone, not in
 * UTC: 09:00 in New York is 13:00Z in summer, and `toISOString().slice(0, 10)`
 * on a hold that releases at 20:00 ET would print tomorrow's date.
 */
function toUnclearedHoldView(row: HoldRow, bankingDateOf: (at: Date) => string): UnclearedHoldView {
  const parsed = parsePlaidExternalRef(row.externalRef);

  return {
    holdId: row.holdId,
    descriptor: row.descriptor,
    externalRef: row.externalRef,
    itemId: parsed?.itemId ?? null,
    plaidAccountId: parsed?.accountId ?? null,
    amountDisplay: formatUsd(row.remainingCents),
    releaseDate: row.availableAt === null ? null : bankingDateOf(row.availableAt),
    availableAt: row.availableAt === null ? null : row.availableAt.toISOString(),
    released: row.closed,
    closedReason: row.closedReason,
    placedAt: row.placedAt.toISOString(),
    policy: row.policy,
  };
}

/* -------------------------------------------------------------------------- */
/* The source                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `YYYY-MM-DD` for an instant, in the banking timezone.
 *
 * Built from the policy's own timezone rather than the server's, for the reason
 * `availability.ts` gives at length: the clock that decides when money becomes
 * spendable is the bank's, and it is not UTC for eight months of the year.
 */
function bankingDateFormatter(): (at: Date) => string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (at: Date) => {
    const parts = fmt.formatToParts(at);
    const find = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${find("year")}-${find("month")}-${find("day")}`;
  };
}

/**
 * Uncleared-credit holds, largest first, then latest-releasing first.
 *
 * ORDERED HERE AND NOT IN THE SCREEN, because this is the last place in the
 * system that still holds the cent counts. The contract carries formatted
 * strings only, so a component that wanted the biggest hold would have to
 * compare `"$2,500.00"` against `"$1.00"` as text — which is either a parse or
 * a wrong answer, and both are money arithmetic in a browser.
 *
 * The order is not cosmetic: the edge state names ONE hold in prose, and the
 * one worth naming is the largest, with the furthest-out release breaking a
 * tie, because that is the hold whose absence from `available` a customer would
 * actually ring up about. Ties beyond that fall back to the hold id so the
 * order is total and a screenshot is reproducible.
 */
function orderUnclearedHolds(holds: readonly HoldRow[]): readonly HoldRow[] {
  return holds
    .filter((hold) => hold.kind === "uncleared_credit")
    .slice()
    .sort((a, b) => {
      if (a.remainingCents !== b.remainingCents) {
        return a.remainingCents > b.remainingCents ? -1 : 1;
      }
      const at = a.availableAt?.getTime() ?? 0;
      const bt = b.availableAt?.getTime() ?? 0;
      if (at !== bt) return bt - at;
      return a.holdId.localeCompare(b.holdId);
    });
}

async function readAccount(
  row: { accountId: string; businessId: string; accountName: string; legalName: string; currency: string },
  snapshot: LedgerSnapshot,
  conn: Sql,
  bankingDateOf: (at: Date) => string,
): Promise<FundableAccountView> {
  const [availability, holds] = await Promise.all([
    accountAvailability(row.accountId, snapshot, conn),
    listHoldRows(row.accountId, snapshot, conn),
  ]);

  return {
    id: row.accountId,
    businessId: row.businessId,
    businessName: row.legalName,
    accountName: row.accountName,
    currency: row.currency,
    balance: foldBalance(availability),
    unclearedHolds: orderUnclearedHolds(holds).map((hold) =>
      toUnclearedHoldView(hold, bankingDateOf),
    ),
  };
}

function providerView(): ProviderView {
  const client = new PlaidClient();
  return {
    // A fact about this process's environment, and nothing more. It is not a
    // claim that Plaid is reachable, and the screen never renders "connected"
    // on the strength of it.
    configured: client.configured,
    environment: client.environment,
    webhookUrl: plaidWebhookUrl(),
  };
}

export function createLiveFundingSource(conn: Sql = sql): FundingDataSource {
  return {
    async getSnapshot(): Promise<Result<FundingSnapshot, ErrorShape>> {
      try {
        const snapshot = await readSnapshot(conn);
        const bankingDateOf = bankingDateFormatter();

        const [accountRows, policyRows] = await Promise.all([
          listDepositAccounts(conn),
          listAvailabilityPolicies(conn),
        ]);

        const accounts = await Promise.all(
          accountRows.map((row) => readAccount(row, snapshot, conn, bankingDateOf)),
        );

        const policies: readonly PolicyView[] = policyRows.map((policy) => ({
          id: policy.id,
          rail: policy.rail,
          counterpartyClass: policy.counterpartyClass,
          bankingDaysHold: policy.bankingDaysHold,
          releaseLocalTime: policy.releaseLocalTime,
          note: policy.note,
        }));

        return ok({
          accounts,
          policies,
          // `book_date(now())` from the database, so the business day boundary
          // is the Fed/ACH one and there is one definition of it rather than two.
          defaultValueDate: snapshot.valueDate,
          provider: providerView(),
          asOf: snapshot.asOf.toISOString(),
        });
      } catch (thrown) {
        // A read failure, and the first thing the screen has to say is that it
        // is one. Nothing here writes: no Item was created, no entry was posted,
        // and a SELECT cannot fund an account.
        const detail =
          typeof thrown === "object" && thrown !== null && "code" in thrown
            ? String((thrown as { code?: unknown }).code)
            : "unknown";
        return fail(
          "FUNDING_PREFLIGHT_FAILED",
          `The balances, holds and availability policy could not be read (${detail}), so the screen cannot be drawn honestly and the form is not drawn at all. Nothing was funded — this is a read, and a read cannot post an entry.`,
        );
      }
    },
  };
}
