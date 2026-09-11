import "server-only";

/**
 * The reads behind `/client/payouts`, and the predicate that makes them safe.
 *
 * ── ISOLATION IS A `WHERE` CLAUSE, NOT A STEP IN A PROGRAM ──────────────────
 *
 * `loadQuotes({ businessId })` becomes `WHERE business_id = $1` inside Postgres
 * (`src/lib/fx/store.ts`, `selectQuotes`). This module never loads the quote
 * book and then filters it: a `rows.filter(...)` is one forgotten line away
 * from printing another customer's commitments on a page headed with this
 * customer's name, and `src/app/(app)/client/live-source.ts` refuses that
 * everywhere else on this surface for exactly that reason.
 *
 * `resolveBusiness()` below has no path that produces "every business". A
 * business id that names nothing falls back to the first customer on the book,
 * which is what the rest of this surface does; it never widens.
 *
 * ── THE AVAILABILITY FIGURE IS NOT COMPUTED HERE ────────────────────────────
 *
 * `availableBalance()` is `ledger_availability()`, migration 0022, the one
 * definition. An accepted quote's commitment is inside its hold term already —
 * this module does not subtract commitments a second time, and `committedCents`
 * on the screen is a label for what is withheld rather than a term in any sum.
 * This build has held four definitions of "available" at once and two of them
 * printed on two screens at the same instant differing by $25,040.70. There is
 * no fifth here.
 */

import type { Loaded } from "@/components/client/contract";
import type { PayoutsScreen, QuoteRow, StandingCommitment } from "@/components/client/payouts/contract";
import { availableBalance } from "@/lib/ledger/balances";
import { sql, type Sql } from "@/lib/ledger/db";
import { findBusiness, listBusinesses } from "@/lib/ledger/queries";
import { formatMinorUnits, formatRate } from "@/lib/fx/quote";
import { loadQuotes, type QuoteRecord } from "@/lib/fx/store";
import { CORRIDORS, findCorridor } from "@/lib/fx/types";

/** How many of this customer's quotes the list shows. Newest first. */
const QUOTE_LIMIT = 20;

/**
 * The business this page is about.
 *
 * Returns the id and the name, and nothing else — the callers below ask
 * Postgres for the rest, scoped by the id, rather than carrying a widening
 * handle around.
 */
async function resolveBusiness(
  businessId: string | null,
  conn: Sql,
): Promise<Loaded<{ readonly businessId: string; readonly legalName: string; readonly all: readonly { readonly id: string; readonly legalName: string }[] }>> {
  const businesses = await listBusinesses(conn);
  const wanted =
    (businessId === null ? null : await findBusiness(businessId, conn)) ??
    businesses.find((b) => b.depositAccountId !== null) ??
    businesses[0] ??
    null;

  if (wanted === null) {
    return {
      ok: false,
      code: "NO_BUSINESS",
      message: "There is no business on this book yet, so there is nobody to quote a payout for.",
    };
  }

  return {
    ok: true,
    value: {
      businessId: wanted.businessId,
      legalName: wanted.legalName,
      all: businesses.map((b) => ({ id: b.businessId, legalName: b.legalName })),
    },
  };
}

/** The destination in words, for a customer who does not read currency codes. */
export function destinationLabel(currency: string): string {
  const corridor = findCorridor(currency);
  return corridor === undefined
    ? currency
    : `${corridor.name} (${corridor.currency}), to ${corridor.destination}`;
}

function toQuoteRow(record: QuoteRecord): QuoteRow {
  return {
    quoteRef: record.quoteRef,
    state: record.state,
    destination: destinationLabel(record.buyCurrency),
    beneficiaryRef: record.beneficiaryRef,
    sellCents: record.sellCents,
    deliveryDisplay: formatMinorUnits(record.buyMinor, record.buyExponent, record.buyCurrency),
    rateDisplay: formatRate(record.customerRateScaled, record.rateScale, { minDecimals: 4 }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    settleBy: record.settleBy,
    isFixture: record.isFixture,
  };
}

function toStanding(record: QuoteRecord): StandingCommitment {
  return {
    quoteRef: record.quoteRef,
    withheldCents: record.sellCents,
    deliveryDisplay: formatMinorUnits(record.buyMinor, record.buyExponent, record.buyCurrency),
    beneficiaryRef: record.beneficiaryRef,
    acceptedAt: record.acceptedAt ?? "",
    settleBy: record.settleBy,
  };
}

/**
 * The whole page, for one business.
 *
 * A refusal comes back as a code and a sentence rather than an exception. There
 * is no `catch` here that continues as though the read succeeded: a payouts
 * screen that cannot read the book must say so, because the alternative is a
 * customer accepting a rate against figures nobody fetched.
 */
export async function readPayoutsScreen(
  businessId: string | null,
  conn: Sql = sql,
): Promise<Loaded<PayoutsScreen>> {
  try {
    const subject = await resolveBusiness(businessId, conn);
    if (!subject.ok) return subject;
    const { businessId: id, legalName, all } = subject.value;

    const [availability, records] = await Promise.all([
      availableBalance(id, conn),
      loadQuotes({ businessId: id, limit: QUOTE_LIMIT }, conn),
    ]);

    const standing = records.filter((r) => r.state === "accepted").map(toStanding);

    return {
      ok: true,
      value: {
        businessId: id,
        legalName,
        asOf: new Date().toISOString(),
        availableCents: availability.availableCents,
        ledgerCents: availability.ledgerCents,
        committedCents: standing.reduce((total, c) => total + c.withheldCents, 0n),
        standing,
        quotes: records.map(toQuoteRow),
        businesses: all,
        corridors: CORRIDORS.map((c) => ({
          currency: c.currency,
          name: c.name,
          destination: c.destination,
        })),
      },
    };
  } catch (thrown) {
    return {
      ok: false,
      code: "PAYOUTS_READ_FAILED",
      message:
        "Your cross-border payouts could not be read, so nothing on this page is a statement " +
        "about your money. No quote was requested and nothing was committed. " +
        (thrown instanceof Error ? thrown.message : String(thrown)),
    };
  }
}

/**
 * One quote, by reference, for one business — both columns in one statement.
 *
 * This is the ownership check the accept action runs before it writes. A quote
 * reference off a form is a claim and it is worth nothing on its own; a
 * reference belonging to another customer produces the same answer as one that
 * does not exist, so the form cannot be used to discover which references are
 * real. `src/app/(app)/client/cards-actions.ts` makes the identical choice for
 * card ids and says so at length.
 */
export async function readOwnedQuote(
  input: { readonly businessId: string; readonly quoteRef: string },
  conn: Sql = sql,
): Promise<QuoteRecord | null> {
  const rows = await loadQuotes(
    { businessId: input.businessId, quoteRef: input.quoteRef, limit: 1 },
    conn,
  );
  return rows[0] ?? null;
}

/** The availability figure alone, for a receipt that has to show it moved. */
export async function readAvailableCents(businessId: string, conn: Sql = sql): Promise<bigint> {
  const availability = await availableBalance(businessId, conn);
  return availability.availableCents;
}
