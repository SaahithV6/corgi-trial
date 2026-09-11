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
  BusinessView,
  FundableAccountView,
  FundingDataSource,
  FundingSnapshot,
  PolicyView,
  ProviderView,
  TransactGateView,
  UnclearedHoldView,
} from "@/components/funding/data-contract";
import { formatUsd } from "@/lib/format/money";
import type { TransactDecision } from "@/lib/kyb";
import { transactGateForBusiness } from "@/lib/kyb/wire";
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
 *
 * ===========================================================================
 * `available_at` CAN BE `infinity`, AND THAT USED TO TAKE THE WHOLE SCREEN DOWN
 * ===========================================================================
 *
 * `hold.available_at` is a `timestamptz`, and `timestamptz` has two values that
 * are not instants: `infinity` and `-infinity`. `src/lib/disputes/store.ts`
 * writes the first one deliberately — a dispute's provisional credit is an
 * `uncleared_credit` hold that is released by a person deciding the case, never
 * by a clock, and "no release instant" is exactly what `infinity` means.
 *
 * `postgres` parses it into a `Date` whose time value is `NaN`. Neither
 * `=== null` nor a truthiness check sees that, so both lines below used to run
 * on it: `Intl.DateTimeFormat.formatToParts(invalid)` threw
 * `RangeError: Invalid time value`, and `Date.prototype.toISOString` would have
 * thrown the same. The throw was caught by `getSnapshot`'s own catch, which
 * turned ONE unformattable row into `FUNDING_PREFLIGHT_FAILED` for the entire
 * book — no balances, no policy table, and no form, for every customer.
 *
 * Measured 2026-09-10: nine such rows, all on Ridgeline Robotics, all
 * `external_ref = dispute:<id>`, and the business that could not be funded
 * because of them was Kettle & Crumb.
 *
 * So the guard is `Number.isFinite(at.getTime())` and it is applied ONCE, here,
 * at the only place a `Date` from the hold table becomes text. A hold with no
 * release instant is not an error and is not drawn as a date: it carries
 * `neverReleases` and the table says what actually frees it.
 */
function isInstant(at: Date): boolean {
  return Number.isFinite(at.getTime());
}

function toUnclearedHoldView(row: HoldRow, bankingDateOf: (at: Date) => string): UnclearedHoldView {
  const parsed = parsePlaidExternalRef(row.externalRef);
  const releasesOnAClock = row.availableAt !== null && isInstant(row.availableAt);

  return {
    holdId: row.holdId,
    descriptor: row.descriptor,
    externalRef: row.externalRef,
    itemId: parsed?.itemId ?? null,
    plaidAccountId: parsed?.accountId ?? null,
    amountDisplay: formatUsd(row.remainingCents),
    releaseDate: releasesOnAClock ? bankingDateOf(row.availableAt as Date) : null,
    availableAt: releasesOnAClock ? (row.availableAt as Date).toISOString() : null,
    neverReleases: row.availableAt !== null && !isInstant(row.availableAt),
    released: row.closed,
    closedReason: row.closedReason,
    // `placed_at` is `created_at`, which is `NOT NULL DEFAULT now()` and cannot
    // be infinite — but it is the same class of value and is guarded the same
    // way rather than left as the next thing to throw.
    placedAt: isInstant(row.placedAt) ? row.placedAt.toISOString() : "(no placement instant)",
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
      // `infinity` parses to a `Date` whose time value is `NaN`, and every
      // comparison against `NaN` is false — so a naive `bt - at` returns `NaN`
      // and hands `Array.prototype.sort` a comparator with no opinion, which is
      // an unspecified order. A hold that never releases sorts LAST among equal
      // amounts, deliberately: it is not the one whose release date a customer
      // is ringing up about.
      const at = a.availableAt === null || !isInstant(a.availableAt) ? null : a.availableAt.getTime();
      const bt = b.availableAt === null || !isInstant(b.availableAt) ? null : b.availableAt.getTime();
      if (at === null && bt !== null) return 1;
      if (bt === null && at !== null) return -1;
      if (at !== null && bt !== null && at !== bt) return bt - at;
      return a.holdId.localeCompare(b.holdId);
    });
}

/* -------------------------------------------------------------------------- */
/* One account, and the blast radius of its failure                           */
/* -------------------------------------------------------------------------- */

/**
 * ONE ACCOUNT'S FAILURE IS ONE ACCOUNT'S FAILURE.
 *
 * This used to be a bare `await` inside a `Promise.all` inside the snapshot's
 * single `try`, which made the screen an all-or-nothing read over the entire
 * book: every customer's balances and holds had to be formattable for any
 * customer to see a form. That is the generality bug in one line, and it is the
 * one that actually fired — see `toUnclearedHoldView` for the nine rows and the
 * business they took down.
 *
 * The catch is HERE, per account, and it is deliberately narrow. It does not
 * substitute a zero balance: a balance nobody could read is `null`, the row
 * says so with the code, and `available` is never printed as a number this
 * module invented. Whatever else this screen does, it does not put a figure on
 * a page that no query produced.
 */
async function readAccount(
  row: { accountId: string; businessId: string; accountName: string; legalName: string; currency: string },
  snapshot: LedgerSnapshot,
  conn: Sql,
  bankingDateOf: (at: Date) => string,
  gate: TransactGateView,
): Promise<FundableAccountView> {
  const identity = {
    id: row.accountId,
    businessId: row.businessId,
    businessName: row.legalName,
    accountName: row.accountName,
    currency: row.currency,
    gate,
  } as const;

  try {
    const [availability, holds] = await Promise.all([
      accountAvailability(row.accountId, snapshot, conn),
      listHoldRows(row.accountId, snapshot, conn),
    ]);

    return {
      ...identity,
      balance: foldBalance(availability),
      unclearedHolds: orderUnclearedHolds(holds).map((hold) =>
        toUnclearedHoldView(hold, bankingDateOf),
      ),
      readError: null,
    };
  } catch (thrown) {
    return {
      ...identity,
      balance: null,
      unclearedHolds: null,
      readError: {
        code: "ACCOUNT_READ_FAILED",
        message:
          `The balances and holds for ${row.legalName} could not be read, so no figure is shown for ` +
          `this account rather than a zero standing in for one. Every other account on this book is ` +
          `unaffected and still fundable. ${describeThrown(thrown)}`,
      },
    };
  }
}

/** A thrown value, as one safe sentence. Never a connection string, never a row. */
function describeThrown(thrown: unknown): string {
  if (typeof thrown === "object" && thrown !== null && "code" in thrown) {
    return `Postgres reported ${String((thrown as { code?: unknown }).code)}.`;
  }
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  return "The failure carried no code and no message.";
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `canTransact()`'s answer, flattened. No judgement is added: a refusal's code
 * and message travel verbatim, and the only sentence written here is the
 * wording of an allowance, which `canTransact` does not supply.
 *
 * Deliberately the same shape and the same reasoning as
 * `payments/live-source.ts`. Two screens asking the same question must not
 * describe the answer in two different vocabularies, or an operator comparing
 * them has to work out whether the difference is real.
 */
function toGateView(decision: TransactDecision): TransactGateView {
  return decision.allowed
    ? {
        allowed: true,
        code: null,
        message:
          decision.evidence === "live"
            ? "Approved on live third-party evidence. This business may be funded from a linked external bank."
            : "Approved, but on simulated or manual evidence: this deployment's policy allows it, and the label says exactly what it rests on.",
        status: decision.status,
        evidence: decision.evidence,
      }
    : {
        allowed: false,
        code: decision.code,
        message: decision.message,
        status: decision.status,
        evidence: decision.evidence,
      };
}

/**
 * Every business on the book, with no join to `account`.
 *
 * TWO REASONS IT IS SHAPED THIS WAY. The first is honesty: a business with no
 * deposit account — Silverline Freight Co. is one — is invisible to an
 * account-shaped list, so a screen built on `listDepositAccounts()` alone can
 * never answer "why can I not fund Silverline". It can now: the gate refuses it
 * `KYB_NEEDS_REVIEW` and the row also says no account has been opened.
 *
 * The second is the ledger boundary. `src/lib/ledger/boundary.test.ts` forbids
 * any module outside `src/lib/ledger/**` from writing SQL against `account`,
 * `journal_entry` or `journal_line`, and this file is not on its allowlist and
 * is not going on it. `business` and `v_business_kyb` are neither; the account
 * side of the join is `listDepositAccounts()`, which is the ledger module's own
 * named reader, and the two are matched in memory.
 */
async function listGatedBusinesses(
  conn: Sql,
  depositAccountByBusiness: ReadonlyMap<string, string>,
): Promise<readonly BusinessView[]> {
  const rows = await conn<{ id: string; legal_name: string; ein: string | null }[]>`
    SELECT b.id, b.legal_name, b.ein
      FROM business b
     ORDER BY b.legal_name`;

  return Promise.all(
    rows.map(async (row): Promise<BusinessView> => {
      // Both gates, exactly as `/payments` reads them: what this deployment
      // does, and what a real-money deployment requiring live evidence would do.
      const [now, strict] = await Promise.all([
        transactGateForBusiness(row.id, { conn }),
        transactGateForBusiness(row.id, { conn, policy: { requireLiveEvidence: true } }),
      ]);
      return {
        id: row.id,
        legalName: row.legal_name,
        ein: row.ein,
        depositAccountId: depositAccountByBusiness.get(row.id) ?? null,
        gate: toGateView(now),
        gateIfLiveRequired: toGateView(strict),
      };
    }),
  );
}

/**
 * Which business this view is pointed at.
 *
 * The reference from the query string is matched against the list that was
 * just read; an id that is not on it falls back to the default rather than
 * reaching a query. The DEFAULT is the first business that may transact AND has
 * an account to fund — not simply the first row, because ordering by legal name
 * would land the screen on a fixture company and make the product look as
 * though funding only works for whoever happens to sort first. If no business
 * can be funded, the first business is selected anyway, so the screen has a
 * subject to explain the refusal about.
 */
function selectBusiness(
  businesses: readonly BusinessView[],
  requested: string | null,
): string | null {
  const asked = requested === null ? undefined : businesses.find((b) => b.id === requested);
  const fundable = businesses.find((b) => b.gate.allowed && b.depositAccountId !== null);
  return (asked ?? fundable ?? businesses[0])?.id ?? null;
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
    async getSnapshot(businessId: string | null): Promise<Result<FundingSnapshot, ErrorShape>> {
      try {
        const snapshot = await readSnapshot(conn);
        const bankingDateOf = bankingDateFormatter();

        const [accountRows, policyRows] = await Promise.all([
          listDepositAccounts(conn),
          listAvailabilityPolicies(conn),
        ]);

        // First account per business. The bare `2100` leaf is one per business
        // by construction — pot sub-accounts carry a qualified `2100.<uuid>`
        // code (migration 0015) and `listDepositAccounts` does not return them.
        const depositAccountByBusiness = new Map<string, string>();
        for (const row of accountRows) {
          if (!depositAccountByBusiness.has(row.businessId)) {
            depositAccountByBusiness.set(row.businessId, row.accountId);
          }
        }

        const businesses = await listGatedBusinesses(conn, depositAccountByBusiness);
        const gateByBusiness = new Map(businesses.map((b) => [b.id, b.gate]));

        const accounts = await Promise.all(
          accountRows.map((row) =>
            readAccount(row, snapshot, conn, bankingDateOf, gateByBusiness.get(row.businessId) ?? {
              // A 2100 account whose business row has vanished is a broken
              // foreign key, not a permission. It is refused, with a code.
              allowed: false,
              code: "KYB_NOT_STARTED",
              message:
                "No business row backs this account, so there is no verification to read and nothing may be funded into it.",
              status: null,
              evidence: null,
            }),
          ),
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
          businesses,
          selectedBusinessId: selectBusiness(businesses, businessId),
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
        // WHAT IS LEFT IN HERE, NOW THAT ONE ACCOUNT CANNOT REACH IT. The
        // snapshot, the account list, the business list with its gates, and the
        // policy table: four reads that are about the BOOK rather than about
        // one customer, and if any of them fails there is genuinely no screen
        // to draw. A single customer's balances failing is handled in
        // `readAccount` and never arrives here — which is the difference
        // between a screen that degrades and a screen that disappears.
        return fail(
          "FUNDING_PREFLIGHT_FAILED",
          `The account list, the business list, the KYB gate or the funds_availability_policy table could not be read, so the screen cannot be drawn honestly and the form is not drawn at all. ${describeThrown(thrown)} Nothing was funded — this is a read, and a read cannot post an entry.`,
        );
      }
    },
  };
}
