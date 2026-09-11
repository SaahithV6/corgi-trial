import "server-only";

/**
 * The live read behind `/client/standing-orders`.
 *
 * ===========================================================================
 * WHY THIS READER EXISTS RATHER THAN `listStandingOrders()`
 * ===========================================================================
 *
 * `listStandingOrders()` in `@/lib/standing/store` is PLATFORM-WIDE: it selects
 * from `v_standing_order_schedule` with no predicate at all and a `LIMIT`, so
 * on this book it returns every customer's mandates in one list. That is the
 * right reader for `/standing-orders`, which is the operator's screen and is
 * meant to see the whole book. It is the wrong reader for a customer screen,
 * and the fix is NOT to call it and filter afterwards — that would make tenant
 * isolation a step in a program rather than a predicate Postgres evaluates
 * before the rows exist. `src/app/(app)/client/live-source.ts` makes exactly
 * this refusal for the approvals queue, and this file makes it again.
 *
 * So every statement below carries `WHERE acc.business_id = $1`, reaching the
 * business through the account the mandate is paid from — which is the same
 * join `v_standing_order_schedule` already does, and the same column the
 * funding check is scoped by (`availableBalance(businessId)`).
 *
 * ===========================================================================
 * NOTHING HERE FIRES ANYTHING
 * ===========================================================================
 *
 * Reads only. `runStandingOrders()` is not imported, cannot be reached from
 * this module, and is not reachable from the page that renders it. A render
 * that raised a payment because somebody hit reload would be the worst bug in
 * this repository — `StandingView.tsx` says so, and it stays true on this
 * surface because the only writes are server actions behind a pressed button.
 */

import { destinationSchema } from "@/lib/approvals/types";
import type { PayoutRail } from "@/lib/approvals/types";
import { availableBalance } from "@/lib/ledger/balances";
import { sql, type Sql } from "@/lib/ledger/db";
import { findAccount, findBusiness, listBusinesses } from "@/lib/ledger/queries";
import { loadPayeeBook } from "@/lib/payees/store";
import { bookToday } from "@/lib/standing";
import type { StandingOrderCadence } from "@/lib/standing/types";

/* -------------------------------------------------------------------------- */
/* The contract the screen renders                                            */
/* -------------------------------------------------------------------------- */

/**
 * Money crosses into this contract as a STRING of minor units, never a
 * `number`. The view formats it and the forms post text back; no float is
 * constructed at any point between the column and the pixel.
 */
export type ClientMandate = {
  readonly id: string;
  readonly reference: string;
  readonly rail: PayoutRail;
  readonly amountCents: string;
  readonly currency: string;
  readonly payeeLabel: string;
  readonly cadence: StandingOrderCadence;
  readonly dayOfMonth: number | null;
  readonly dayOfWeek: number | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly nextDueDate: string | null;
  readonly cancelled: boolean;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly createdAt: string;
};

export type ClientOccurrence = {
  readonly occurrenceId: string;
  readonly standingOrderId: string;
  readonly reference: string;
  readonly scheduledDate: string;
  readonly amountCents: string;
  readonly currency: string;
  readonly disposition: "raised" | "refused" | null;
  readonly instructionId: string | null;
  readonly refusalCode: string | null;
  readonly refusalReason: string | null;
  readonly observedLedgerCents: string | null;
  readonly observedAvailableCents: string | null;
  readonly shortfallCents: string | null;
};

export type ClientPayeeOption = {
  readonly payeeId: string;
  readonly label: string;
  readonly rail: PayoutRail;
};

export type BusinessRef = {
  readonly id: string;
  readonly legalName: string;
};

export type ClientStandingScreen = {
  readonly businessId: string;
  readonly legalName: string;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly currency: string;
  readonly businesses: readonly BusinessRef[];
  readonly bookDate: string;
  readonly availableCents: string;
  readonly mandates: readonly ClientMandate[];
  readonly occurrences: readonly ClientOccurrence[];
  readonly payees: readonly ClientPayeeOption[];
  /**
   * Minted on the server, once per render, and carried in the create form's
   * hidden field. A double-press or a replayed POST therefore reaches
   * `ON CONFLICT (mandate_key) DO NOTHING` under the SAME key and returns the
   * mandate that already exists. Generating it in the browser would produce a
   * fresh key per attempt, which is the duplicate the UNIQUE index refuses.
   */
  readonly mandateKey: string;
};

export type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/* -------------------------------------------------------------------------- */
/* Whose book                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the requested business, or fall back to the first on the book.
 *
 * An unparseable or unknown id lands on the default customer. It NEVER widens
 * to "every business" — there is no path through this function that produces a
 * subject spanning tenants.
 */
export async function resolveBusiness(
  businessId: string | null,
  conn: Sql = sql,
): Promise<Loaded<{ id: string; legalName: string; currency: string; refs: BusinessRef[] }>> {
  const businesses = await listBusinesses(conn);
  const wanted =
    (businessId === null ? null : await findBusiness(businessId, conn)) ??
    businesses.find((b) => b.depositAccountId !== null) ??
    businesses[0] ??
    null;

  if (wanted === null) {
    return { ok: false, code: "NO_BUSINESS", message: "There is no business on this book yet." };
  }

  return {
    ok: true,
    value: {
      id: wanted.businessId,
      legalName: wanted.legalName,
      currency: wanted.currency ?? "USD",
      refs: businesses.map((b) => ({ id: b.businessId, legalName: b.legalName })),
    },
  };
}

/**
 * The account a mandate is paid from, resolved from the BUSINESS.
 *
 * Never taken as a form field. `/client/pay` resolves its account the same way
 * — by predicate on `business_id` — and the create action calls this function
 * rather than reading an `accountId` the browser sent, so a POST naming another
 * customer's account changes nothing, because no field of that name is read.
 */
export async function accountForBusiness(
  businessId: string,
  conn: Sql = sql,
): Promise<{ accountId: string; accountName: string; currency: string } | null> {
  const account = await findAccount(
    { businessId, code: "2100", book: "financial" },
    conn,
  );
  if (account === undefined || account === null) return null;
  return {
    accountId: account.accountId,
    accountName: account.name,
    currency: account.currency,
  };
}

/* -------------------------------------------------------------------------- */
/* The scoped reads                                                           */
/* -------------------------------------------------------------------------- */

type ScheduleRow = {
  readonly id: string;
  readonly reference: string;
  readonly rail: PayoutRail;
  readonly amount_cents: bigint;
  readonly currency: string;
  readonly counterparty: unknown;
  readonly cadence: StandingOrderCadence;
  readonly day_of_month: number | null;
  readonly day_of_week: number | null;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly created_at: Date;
  readonly cancelled: boolean;
  readonly cancelled_at: Date | null;
  readonly cancellation_reason: string | null;
  readonly next_due_date: string | null;
};

/** How the destination reads to the person who set it up. Never a raw jsonb. */
function payeeLabel(raw: unknown): string {
  const parsed = destinationSchema.safeParse(raw);
  if (!parsed.success) return "a destination this bank can no longer read";
  const value = parsed.data as Record<string, unknown>;
  const holder = typeof value["holderName"] === "string" ? value["holderName"] : "a payee";
  const last4 = typeof value["accountNumberLast4"] === "string" ? value["accountNumberLast4"] : null;
  return last4 === null ? holder : `${holder} — account ending ${last4}`;
}

/**
 * This business's mandates. One statement, the predicate inside it.
 *
 * `acc.business_id = $1` is evaluated by Postgres. There is no `.filter()` on
 * the result and the returned rows carry no tenant discriminator for a view
 * component to have to check.
 */
export async function listMandatesForBusiness(
  businessId: string,
  conn: Sql = sql,
): Promise<readonly ClientMandate[]> {
  const rows = await conn<ScheduleRow[]>`
    SELECT so.id,
           so.reference,
           so.rail::text AS rail,
           so.amount_cents,
           so.currency,
           so.counterparty,
           so.cadence::text AS cadence,
           so.day_of_month,
           so.day_of_week,
           so.start_date::text AS start_date,
           so.end_date::text AS end_date,
           so.created_at,
           (c.standing_order_id IS NOT NULL) AS cancelled,
           c.cancelled_at,
           c.reason AS cancellation_reason,
           n.next_due_date::text AS next_due_date
      FROM standing_order so
      JOIN account acc ON acc.id = so.account_id
      LEFT JOIN standing_order_cancellation c ON c.standing_order_id = so.id
      LEFT JOIN v_standing_order_next n ON n.standing_order_id = so.id
     WHERE acc.business_id = ${businessId}::uuid
     ORDER BY (c.standing_order_id IS NOT NULL), so.created_at DESC
     LIMIT 50`;

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    rail: row.rail,
    amountCents: row.amount_cents.toString(),
    currency: row.currency,
    payeeLabel: payeeLabel(row.counterparty),
    cadence: row.cadence,
    dayOfMonth: row.day_of_month,
    dayOfWeek: row.day_of_week,
    startDate: row.start_date,
    endDate: row.end_date,
    nextDueDate: row.next_due_date,
    cancelled: row.cancelled,
    cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at.toISOString(),
  }));
}

type HistoryRow = {
  readonly occurrence_id: string;
  readonly standing_order_id: string;
  readonly reference: string;
  readonly scheduled_date: string;
  readonly amount_cents: bigint;
  readonly currency: string;
  readonly disposition: "raised" | "refused" | null;
  readonly instruction_id: string | null;
  readonly refusal_code: string | null;
  readonly refusal_reason: string | null;
  readonly observed_ledger_cents: bigint | null;
  readonly observed_available_cents: bigint | null;
  readonly shortfall_cents: bigint | null;
};

/** What this business's mandates have actually done. Same predicate, same join. */
export async function listOccurrencesForBusiness(
  businessId: string,
  conn: Sql = sql,
): Promise<readonly ClientOccurrence[]> {
  const rows = await conn<HistoryRow[]>`
    SELECT h.occurrence_id,
           h.standing_order_id,
           h.reference,
           h.scheduled_date::text AS scheduled_date,
           h.amount_cents,
           h.currency,
           h.disposition::text AS disposition,
           h.instruction_id,
           h.refusal_code,
           h.refusal_reason,
           h.observed_ledger_cents,
           h.observed_available_cents,
           h.shortfall_cents
      FROM v_standing_order_history h
      JOIN standing_order so ON so.id = h.standing_order_id
      JOIN account acc ON acc.id = so.account_id
     WHERE acc.business_id = ${businessId}::uuid
     ORDER BY h.scheduled_date DESC
     LIMIT 25`;

  return rows.map((row) => ({
    occurrenceId: row.occurrence_id,
    standingOrderId: row.standing_order_id,
    reference: row.reference,
    scheduledDate: row.scheduled_date,
    amountCents: row.amount_cents.toString(),
    currency: row.currency,
    disposition: row.disposition,
    instructionId: row.instruction_id,
    refusalCode: row.refusal_code,
    refusalReason: row.refusal_reason,
    observedLedgerCents:
      row.observed_ledger_cents === null ? null : row.observed_ledger_cents.toString(),
    observedAvailableCents:
      row.observed_available_cents === null ? null : row.observed_available_cents.toString(),
    shortfallCents: row.shortfall_cents === null ? null : row.shortfall_cents.toString(),
  }));
}

/**
 * Is this mandate on this business?
 *
 * One statement, both columns, answered by Postgres before a row exists to be
 * filtered. A mandate belonging to another business produces the same answer
 * as a mandate that does not exist, so the cancel form cannot be used to
 * discover which ids are real.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ownsMandate(
  standingOrderId: string,
  businessId: string,
  conn: Sql = sql,
): Promise<boolean> {
  if (!UUID.test(standingOrderId) || !UUID.test(businessId)) return false;
  const rows = await conn<{ id: string }[]>`
    SELECT so.id
      FROM standing_order so
      JOIN account acc ON acc.id = so.account_id
     WHERE so.id = ${standingOrderId}::uuid
       AND acc.business_id = ${businessId}::uuid
     LIMIT 1`;
  return rows.length === 1;
}

/* -------------------------------------------------------------------------- */
/* The whole screen                                                           */
/* -------------------------------------------------------------------------- */

export async function readClientStandingScreen(
  businessId: string | null,
  mandateKey: string,
  conn: Sql = sql,
): Promise<Loaded<ClientStandingScreen>> {
  try {
    const subject = await resolveBusiness(businessId, conn);
    if (!subject.ok) return subject;
    const { id, legalName, refs } = subject.value;

    const [account, mandates, occurrences, payees, availability, book] = await Promise.all([
      accountForBusiness(id, conn),
      listMandatesForBusiness(id, conn),
      listOccurrencesForBusiness(id, conn),
      loadPayeeBook({ businessId: id }, conn),
      availableBalance(id, conn),
      bookToday(conn),
    ]);

    return {
      ok: true,
      value: {
        businessId: id,
        legalName,
        accountId: account?.accountId ?? null,
        accountName: account?.accountName ?? null,
        currency: account?.currency ?? subject.value.currency,
        businesses: refs,
        bookDate: book,
        availableCents: availability.availableCents.toString(),
        mandates,
        occurrences,
        // The payee book is already `WHERE business_id = $1`, so the only
        // destinations offered are ones THIS customer confirmed. There is no
        // path on this screen to a beneficiary somebody else confirmed, and no
        // free-text routing number either: a standing authority to pay with
        // nobody watching is not the place to introduce a brand-new payee.
        payees: payees
          .filter((p) => !p.archived && p.rail === "ach")
          .map((p) => ({
            payeeId: p.payeeId,
            rail: p.rail,
            label: `${p.displayName}${
              p.accountNumberLast4 === null ? "" : ` — account ending ${p.accountNumberLast4}`
            }`,
          })),
        mandateKey,
      },
    };
  } catch (thrown) {
    return {
      ok: false,
      code: "STANDING_READ_FAILED",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}
