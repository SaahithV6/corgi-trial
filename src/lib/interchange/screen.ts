/**
 * The unit-economics read.
 *
 * ─── The question this screen answers ───────────────────────────────────────
 *
 * IS THIS PROGRAMME PROFITABLE — per customer, FROM POSTINGS rather than from a
 * spreadsheet. Interchange earned on card spend, less the costs that are
 * already on this book: the platform fee we charge (revenue), the interest we
 * pay on deposits (cost), and whatever else has hit a house income or expense
 * account on an entry that moved that customer's money.
 *
 * Every figure is a sum of immutable journal lines. Nothing here is a stored
 * total, nothing is a projection, and nothing is computed in TypeScript from
 * something other than the ledger — the arithmetic lives in
 * `v_unit_economics`, `v_interchange_by_category` and `v_interchange_settlement`
 * (migration 0031), which is also what keeps this module clear of
 * `src/lib/ledger/boundary.test.ts`: a screen reaching into `journal_line` to
 * total a column is a screen with its own answer to what revenue is.
 *
 * ─── Portfolio totals are summed HERE and that is deliberate ────────────────
 *
 * `bigint` addition over the rows the view returned, not a second SQL
 * aggregate. A `SUM(SUM(...))` in the database would be a second definition of
 * the same total that could drift from the rows printed underneath it — and a
 * header that disagrees with the table below it is the defect this repository
 * spent a whole migration undoing (0022).
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import type { Presentment } from "./rate-card";

/** One customer's contribution, as the ledger has it. */
export interface UnitEconomicsRow {
  readonly businessId: string;
  readonly legalName: string;
  readonly pricedSettlements: number;
  readonly reversedSettlements: number;
  /** Every settlement priced, before corrections. */
  readonly grossSettledCents: bigint;
  /** What those settlements are worth NOW, after every correction. */
  readonly netSettledCents: bigint;
  readonly interchangeCents: bigint;
  readonly feeIncomeCents: bigint;
  readonly interestIncomeCents: bigint;
  readonly fxVarianceCents: bigint;
  readonly interestExpenseCents: bigint;
  readonly otherExpenseCents: bigint;
  readonly netContributionCents: bigint;
}

/** Interchange by the dimensions it was actually priced on. */
export interface CategoryRow {
  readonly category: string;
  readonly presentment: Presentment;
  readonly settlements: number;
  readonly grossSettledCents: bigint;
  readonly netSettledCents: bigint;
  readonly interchangeCents: bigint;
  /** Settlements whose fraction was EXACTLY half a cent and went to the even one. */
  readonly halfCentTies: number;
  /** The sub-cent fractions §12.2 dropped, in ten-thousandths of a cent. */
  readonly remainderUnitsDropped: bigint;
}

/** One version of one band of the rate card. */
export interface RateCardRow {
  readonly id: string;
  readonly category: string;
  readonly categoryDescription: string;
  readonly categoryIsDefault: boolean;
  readonly presentment: Presentment;
  readonly effectiveFrom: string;
  readonly supersededOn: string | null;
  readonly rateBps: number;
  readonly fixedCents: bigint;
  readonly note: string;
  readonly settlementsPriced: number;
  readonly mccsMapped: number;
}

/** One priced settlement, with the whole working. */
export interface SettlementRow {
  readonly id: string;
  readonly valueDate: string;
  readonly providerEventId: string;
  readonly businessName: string;
  readonly mcc: string | null;
  readonly category: string;
  readonly presentment: Presentment;
  readonly entryMode: string | null;
  readonly network: string | null;
  readonly descriptor: string | null;
  readonly direction: "earned" | "returned";
  readonly settledCents: bigint;
  readonly netSettledCents: bigint;
  readonly rateBps: number;
  readonly fixedCents: bigint;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly wholeCents: bigint;
  readonly remainderUnits: bigint;
  readonly rounding: string;
  readonly adValoremCents: bigint;
  readonly interchangeCents: bigint;
  readonly bookedNaturalCents: bigint;
  readonly settlementEntryId: string;
  readonly entryId: string;
  readonly reversalEntryId: string | null;
  readonly rebookEntryId: string | null;
  readonly reversalReason: string | null;
  readonly rateEffectiveFrom: string;
}

/** A settled card movement carrying no interchange, and why. */
export interface UnpricedRow {
  readonly settlementEntryId: string;
  readonly kind: string;
  readonly valueDate: string;
  readonly providerAuthId: string | null;
  readonly customerCents: bigint;
  readonly providerRecordPresent: boolean;
  readonly reason: string;
}

/** The three guards, so the screen states its own health rather than implying it. */
export interface GuardRow {
  readonly view: string;
  readonly claim: string;
  readonly rows: number;
}

export interface EconomicsView {
  readonly businesses: readonly UnitEconomicsRow[];
  readonly categories: readonly CategoryRow[];
  readonly rateCard: readonly RateCardRow[];
  readonly settlements: readonly SettlementRow[];
  readonly unpriced: readonly UnpricedRow[];
  readonly unpricedTotal: number;
  readonly guards: readonly GuardRow[];
  readonly asOf: string;
}

/** Live or fixture; the page picks. See `src/app/(app)/economics/page.tsx`. */
export interface EconomicsDataSource {
  readonly load: () => Promise<EconomicsView>;
}

/**
 * Can this deployment read a database at all?
 *
 * Checked WITHOUT importing `@/lib/env`, which throws on an incomplete
 * environment — the page has to be able to render the words "no database
 * configured" on a deployment that has none. Same shape as
 * `accrual/screen.ts`.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.length > 0;
}

const GUARDS: readonly { view: string; claim: string }[] = [
  {
    view: "v_interchange_unreversed",
    claim: "no revenue stands on a settlement the network took back",
  },
  {
    view: "v_interchange_drift",
    claim: "every priced settlement carries the interchange it is now worth",
  },
  {
    view: "v_interchange_rate_drift",
    claim: "no settlement has been re-priced by a rate that came later",
  },
];

export async function loadEconomicsView(conn: Sql = sql): Promise<EconomicsView> {
  const [businesses, categories, rateCard, settlements, unpriced, unpricedTotal, guards] =
    await Promise.all([
      readBusinesses(conn),
      readCategories(conn),
      readRateCard(conn),
      readSettlements(conn),
      readUnpriced(conn),
      countUnpriced(conn),
      readGuards(conn),
    ]);

  return {
    businesses,
    categories,
    rateCard,
    settlements,
    unpriced,
    unpricedTotal,
    guards,
    asOf: new Date().toISOString(),
  };
}

async function readBusinesses(conn: Sql): Promise<readonly UnitEconomicsRow[]> {
  const rows = await conn<
    {
      business_id: string;
      legal_name: string;
      priced_settlements: number;
      reversed_settlements: number;
      gross_settled_cents: bigint;
      net_settled_cents: bigint;
      interchange_cents: bigint;
      fee_income_cents: bigint;
      interest_income_cents: bigint;
      fx_variance_cents: bigint;
      interest_expense_cents: bigint;
      other_expense_cents: bigint;
      net_contribution_cents: bigint;
    }[]
  >`SELECT * FROM v_unit_economics ORDER BY net_contribution_cents DESC, legal_name`;

  return rows.map((r) => ({
    businessId: r.business_id,
    legalName: r.legal_name,
    pricedSettlements: r.priced_settlements,
    reversedSettlements: r.reversed_settlements,
    grossSettledCents: r.gross_settled_cents,
    netSettledCents: r.net_settled_cents,
    interchangeCents: r.interchange_cents,
    feeIncomeCents: r.fee_income_cents,
    interestIncomeCents: r.interest_income_cents,
    fxVarianceCents: r.fx_variance_cents,
    interestExpenseCents: r.interest_expense_cents,
    otherExpenseCents: r.other_expense_cents,
    netContributionCents: r.net_contribution_cents,
  }));
}

async function readCategories(conn: Sql): Promise<readonly CategoryRow[]> {
  const rows = await conn<
    {
      category: string;
      presentment: Presentment;
      settlements: number;
      gross_settled_cents: bigint;
      net_settled_cents: bigint;
      interchange_cents: bigint;
      half_cent_ties: number;
      remainder_units_dropped: bigint;
    }[]
  >`SELECT * FROM v_interchange_by_category
     ORDER BY interchange_cents DESC, category, presentment`;

  return rows.map((r) => ({
    category: r.category,
    presentment: r.presentment,
    settlements: r.settlements,
    grossSettledCents: r.gross_settled_cents,
    netSettledCents: r.net_settled_cents,
    interchangeCents: r.interchange_cents,
    halfCentTies: r.half_cent_ties,
    remainderUnitsDropped: r.remainder_units_dropped,
  }));
}

async function readRateCard(conn: Sql): Promise<readonly RateCardRow[]> {
  const rows = await conn<
    {
      id: string;
      category: string;
      category_description: string;
      category_is_default: boolean;
      presentment: Presentment;
      effective_from: string;
      superseded_on: string | null;
      rate_bps: number;
      fixed_cents: bigint;
      note: string;
      settlements_priced: bigint;
      mccs_mapped: bigint;
    }[]
  >`
    SELECT id, category, category_description, category_is_default,
           presentment::text AS presentment,
           to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
           to_char(superseded_on, 'YYYY-MM-DD')  AS superseded_on,
           rate_bps, fixed_cents, note, settlements_priced, mccs_mapped
      FROM v_interchange_rate_card
     ORDER BY category, presentment, effective_from`;

  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    categoryDescription: r.category_description,
    categoryIsDefault: r.category_is_default,
    presentment: r.presentment,
    effectiveFrom: r.effective_from,
    supersededOn: r.superseded_on,
    rateBps: r.rate_bps,
    fixedCents: r.fixed_cents,
    note: r.note,
    settlementsPriced: Number(r.settlements_priced),
    mccsMapped: Number(r.mccs_mapped),
  }));
}

/**
 * The most recent priced settlements, newest first.
 *
 * Bounded, and the bound is on the SCREEN rather than on the truth: the totals
 * above it come from the views, which see every row. A table that silently
 * summed only what it displayed would be a different number from the one in the
 * header, which is the exact defect 0022 exists to have ended.
 */
async function readSettlements(conn: Sql, limit = 60): Promise<readonly SettlementRow[]> {
  const rows = await conn<
    {
      id: string;
      value_date: string;
      provider_event_id: string;
      business_name: string;
      mcc: string | null;
      category: string;
      presentment: Presentment;
      entry_mode: string | null;
      network: string | null;
      descriptor: string | null;
      direction: "earned" | "returned";
      settled_cents: bigint;
      net_settled_cents: bigint;
      rate_bps: number;
      fixed_cents: bigint;
      numerator: bigint;
      denominator: bigint;
      whole_cents: bigint;
      remainder_units: bigint;
      rounding: string;
      ad_valorem_cents: bigint;
      interchange_cents: bigint;
      booked_natural_cents: bigint;
      settlement_entry_id: string;
      entry_id: string;
      reversal_entry_id: string | null;
      rebook_entry_id: string | null;
      reversal_reason: string | null;
      rate_effective_from: string;
    }[]
  >`
    SELECT id, to_char(value_date, 'YYYY-MM-DD') AS value_date, provider_event_id,
           business_name, mcc, category, presentment::text AS presentment,
           entry_mode, network, descriptor, direction::text AS direction,
           settled_cents, net_settled_cents, rate_bps, fixed_cents,
           numerator, denominator, whole_cents, remainder_units,
           rounding::text AS rounding, ad_valorem_cents, interchange_cents,
           booked_natural_cents, settlement_entry_id, entry_id,
           reversal_entry_id, rebook_entry_id, reversal_reason,
           to_char(rate_effective_from, 'YYYY-MM-DD') AS rate_effective_from
      FROM v_interchange_settlement
     ORDER BY value_date DESC, interchange_cents DESC, provider_event_id
     LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    valueDate: r.value_date,
    providerEventId: r.provider_event_id,
    businessName: r.business_name,
    mcc: r.mcc,
    category: r.category,
    presentment: r.presentment,
    entryMode: r.entry_mode,
    network: r.network,
    descriptor: r.descriptor,
    direction: r.direction,
    settledCents: r.settled_cents,
    netSettledCents: r.net_settled_cents,
    rateBps: r.rate_bps,
    fixedCents: r.fixed_cents,
    numerator: r.numerator,
    denominator: r.denominator,
    wholeCents: r.whole_cents,
    remainderUnits: r.remainder_units,
    rounding: r.rounding,
    adValoremCents: r.ad_valorem_cents,
    interchangeCents: r.interchange_cents,
    bookedNaturalCents: r.booked_natural_cents,
    settlementEntryId: r.settlement_entry_id,
    entryId: r.entry_id,
    reversalEntryId: r.reversal_entry_id,
    rebookEntryId: r.rebook_entry_id,
    reversalReason: r.reversal_reason,
    rateEffectiveFrom: r.rate_effective_from,
  }));
}

async function readUnpriced(conn: Sql, limit = 12): Promise<readonly UnpricedRow[]> {
  const rows = await conn<
    {
      settlement_entry_id: string;
      kind: string;
      value_date: string;
      provider_auth_id: string | null;
      customer_cents: bigint;
      provider_record_present: boolean;
      reason: string;
    }[]
  >`
    SELECT settlement_entry_id, kind, to_char(value_date, 'YYYY-MM-DD') AS value_date,
           provider_auth_id, customer_cents, provider_record_present, reason
      FROM v_interchange_unpriced
     ORDER BY value_date DESC, settlement_entry_id
     LIMIT ${limit}`;

  return rows.map((r) => ({
    settlementEntryId: r.settlement_entry_id,
    kind: r.kind,
    valueDate: r.value_date,
    providerAuthId: r.provider_auth_id,
    customerCents: r.customer_cents,
    providerRecordPresent: r.provider_record_present,
    reason: r.reason,
  }));
}

async function countUnpriced(conn: Sql): Promise<number> {
  const rows = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM v_interchange_unpriced`;
  return rows[0]?.n ?? 0;
}

/**
 * The three guards, counted.
 *
 * On the screen, on purpose. A revenue page that does not say whether its own
 * invariants hold is asking to be believed; this one prints the count and goes
 * red when it is not zero, which is the same thing `pnpm db:check` does in a
 * terminal.
 */
async function readGuards(conn: Sql): Promise<readonly GuardRow[]> {
  const out: GuardRow[] = [];
  for (const guard of GUARDS) {
    const rows = await conn.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${guard.view}`,
    );
    out.push({ view: guard.view, claim: guard.claim, rows: rows[0]?.n ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Portfolio totals — summed from the rows the screen renders, in bigint.
// ---------------------------------------------------------------------------

export interface PortfolioTotals {
  readonly businesses: number;
  readonly pricedSettlements: number;
  readonly reversedSettlements: number;
  readonly netSettledCents: bigint;
  readonly interchangeCents: bigint;
  readonly feeIncomeCents: bigint;
  readonly interestExpenseCents: bigint;
  readonly otherExpenseCents: bigint;
  readonly netContributionCents: bigint;
  /**
   * Interchange as basis points of net settled spend — the programme's
   * effective take rate.
   *
   * Integer division, deliberately: this is a ratio for a human to read and
   * never an amount of money, so it is computed as
   * `interchange * 10000 / netSettled` in `bigint` and truncated. No float
   * touches it, and it is `null` rather than zero when there is no spend,
   * because a take rate on nothing is not 0.00% — it does not exist.
   */
  readonly effectiveRateBps: bigint | null;
}

export function portfolioTotals(rows: readonly UnitEconomicsRow[]): PortfolioTotals {
  let pricedSettlements = 0;
  let reversedSettlements = 0;
  let netSettledCents = 0n;
  let interchangeCents = 0n;
  let feeIncomeCents = 0n;
  let interestExpenseCents = 0n;
  let otherExpenseCents = 0n;
  let netContributionCents = 0n;

  for (const r of rows) {
    pricedSettlements += r.pricedSettlements;
    reversedSettlements += r.reversedSettlements;
    netSettledCents += r.netSettledCents;
    interchangeCents += r.interchangeCents;
    feeIncomeCents += r.feeIncomeCents;
    interestExpenseCents += r.interestExpenseCents;
    otherExpenseCents += r.otherExpenseCents;
    netContributionCents += r.netContributionCents;
  }

  return {
    businesses: rows.length,
    pricedSettlements,
    reversedSettlements,
    netSettledCents,
    interchangeCents,
    feeIncomeCents,
    interestExpenseCents,
    otherExpenseCents,
    netContributionCents,
    effectiveRateBps:
      netSettledCents > 0n ? (interchangeCents * 10_000n) / netSettledCents : null,
  };
}

/** `165` -> `1.65%`. Integer arithmetic; the string is the only decimal. */
export function formatBps(bps: number | bigint): string {
  const value = typeof bps === "bigint" ? bps : BigInt(Math.trunc(bps));
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}%`;
}
