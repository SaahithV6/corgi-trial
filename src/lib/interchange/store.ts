/**
 * Every database statement the interchange machinery issues, and nothing else.
 *
 * Three rules hold throughout, and they are the same three `holds/store.ts`
 * states:
 *
 *   1. NOTHING here inserts into `journal_entry` or `journal_line`. Money is
 *      written by `postEntry()` -> `ledger_append()` and by nothing else, so
 *      every posting gets the advisory lock, the serialised `booking_seq`, the
 *      monotonic `booking_time`, the hash chain and the idempotent replay.
 *
 *   2. Nothing here UPDATEs anything. `interchange_posting`,
 *      `interchange_reversal`, `interchange_rate_policy`, `interchange_mcc` and
 *      `interchange_category` are all SELECT+INSERT for `corgi_app`, with
 *      `ledger_row_is_immutable()` behind that for the owner. Every "change" is
 *      an INSERT that some unique index may refuse, and a refusal is the
 *      answer, not an error to work around.
 *
 *   3. NO SQL AGAINST `journal_entry`, `journal_line` OR `account`. That is the
 *      boundary `src/lib/ledger/boundary.test.ts` ratchets, and a module
 *      outside `src/lib/ledger/**` with its own copy of those joins is a module
 *      with its own answer to what a balance is — which is how this system
 *      once ended up with four of them. Ledger questions are asked through
 *      `src/lib/ledger/readers.ts` (`resolveChartCodes`) or through a view the
 *      migration declares (`v_interchange_candidate`,
 *      `v_interchange_settlement_net`, `v_interchange_booked`), never inline.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import type { SettlementDimensions } from "./dimensions";
import type {
  InterchangeArithmetic,
  InterchangeDirection,
  Presentment,
  RateCardEntry,
} from "./rate-card";

/** House account: what we owe the card network for cleared spend. */
export const CARD_SETTLEMENT_CODE = "2200";
/** House account: our share of the interchange on card spend. */
export const INTERCHANGE_INCOME_CODE = "4100";

/**
 * One card settlement on the book, with everything needed to price it.
 *
 * Mirrors `v_interchange_candidate` column for column. `payload` is the
 * provider's own transaction record as JSON — `null` when there is none, which
 * is how a settlement built by an integration test by hand is told apart from
 * one the network actually sent.
 */
export interface SettlementCandidate {
  readonly settlementEntryId: string;
  readonly valueDate: string;
  readonly entityId: string;
  readonly providerAuthId: string;
  readonly providerEventId: string;
  readonly kind: string;
  /** The customer's own leg, SIGNED: positive is a debit, i.e. a purchase. */
  readonly settledCents: bigint;
  readonly depositAccountId: string;
  readonly businessId: string;
  readonly authId: string;
  readonly cardId: string;
  readonly provider: string;
  readonly payload: unknown;
  readonly providerRecordPresent: boolean;
  /** Already priced: the `interchange_posting` id, or `null`. */
  readonly interchangePostingId: string | null;
  /** The settlement has been reversed by a correction: the reversal entry id. */
  readonly settlementReversalEntryId: string | null;
}

interface CandidateRow {
  settlement_entry_id: string;
  value_date: string;
  entity_id: string;
  provider_auth_id: string;
  provider_event_id: string;
  kind: string;
  settled_cents: bigint;
  deposit_account_id: string;
  business_id: string;
  auth_id: string;
  card_id: string;
  provider: string;
  payload: unknown;
  provider_record_present: boolean;
  interchange_posting_id: string | null;
  settlement_reversal_entry_id: string | null;
}

function toCandidate(row: CandidateRow): SettlementCandidate {
  return {
    settlementEntryId: row.settlement_entry_id,
    valueDate: row.value_date,
    entityId: row.entity_id,
    providerAuthId: row.provider_auth_id,
    providerEventId: row.provider_event_id,
    kind: row.kind,
    settledCents: row.settled_cents,
    depositAccountId: row.deposit_account_id,
    businessId: row.business_id,
    authId: row.auth_id,
    cardId: row.card_id,
    provider: row.provider,
    payload: row.payload,
    providerRecordPresent: row.provider_record_present,
    interchangePostingId: row.interchange_posting_id,
    settlementReversalEntryId: row.settlement_reversal_entry_id,
  };
}

/** One settlement, by the journal entry that posted it. */
export async function findCandidateByEntry(
  settlementEntryId: string,
  conn: Sql = sql,
): Promise<SettlementCandidate | null> {
  const rows = await conn<CandidateRow[]>`
    SELECT settlement_entry_id, to_char(value_date, 'YYYY-MM-DD') AS value_date, entity_id,
           provider_auth_id, provider_event_id, kind, settled_cents, deposit_account_id,
           business_id, auth_id, card_id, provider, payload, provider_record_present,
           interchange_posting_id, settlement_reversal_entry_id
      FROM v_interchange_candidate
     WHERE settlement_entry_id = ${settlementEntryId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : toCandidate(row);
}

/**
 * One settlement, by the provider event token that produced it.
 *
 * The live hook knows the event, not the entry: `postCardMovement()` returns
 * entry ids in a list with nothing tying each to its event. Looking the
 * settlement up by the provider's own immutable token is both the stable key
 * and the one a redelivery re-derives identically.
 */
export async function findCandidateByEvent(
  provider: string,
  providerEventId: string,
  conn: Sql = sql,
): Promise<SettlementCandidate | null> {
  const rows = await conn<CandidateRow[]>`
    SELECT settlement_entry_id, to_char(value_date, 'YYYY-MM-DD') AS value_date, entity_id,
           provider_auth_id, provider_event_id, kind, settled_cents, deposit_account_id,
           business_id, auth_id, card_id, provider, payload, provider_record_present,
           interchange_posting_id, settlement_reversal_entry_id
      FROM v_interchange_candidate
     WHERE provider = ${provider} AND provider_event_id = ${providerEventId}`;
  const row = rows[0];
  return row === undefined ? null : toCandidate(row);
}

/** Every settlement on the book, oldest first. Drives the backfill. */
export async function listCandidates(
  filter: { readonly onlyProviderRecords?: boolean; readonly limit?: number } = {},
  conn: Sql = sql,
): Promise<readonly SettlementCandidate[]> {
  const rows = await conn<CandidateRow[]>`
    SELECT settlement_entry_id, to_char(value_date, 'YYYY-MM-DD') AS value_date, entity_id,
           provider_auth_id, provider_event_id, kind, settled_cents, deposit_account_id,
           business_id, auth_id, card_id, provider, payload, provider_record_present,
           interchange_posting_id, settlement_reversal_entry_id
      FROM v_interchange_candidate
     WHERE (${filter.onlyProviderRecords ?? false}::boolean = false
            OR provider_record_present)
     ORDER BY value_date, settlement_entry_id
     LIMIT ${filter.limit ?? 100_000}`;
  return rows.map(toCandidate);
}

/**
 * The merchant category band for one MCC.
 *
 * `null` MCC still resolves — to the default band, because the fallback is a
 * ROW (`interchange_category.is_default`) and not a constant written in two
 * places. A payload that carried no MCC is priced at the standard band rather
 * than refused: we have the provider's own record that it settled.
 */
export async function resolveCategory(mcc: string | null, conn: Sql = sql): Promise<string> {
  const rows = await conn<{ category: string | null }[]>`
    SELECT interchange_category_of(${mcc}) AS category`;
  const category = rows[0]?.category;
  if (category === null || category === undefined) {
    throw new Error(
      "no default interchange category: interchange_category has no is_default row, so an unmapped MCC cannot be priced",
    );
  }
  return category;
}

/**
 * The rate card as it stood on a settlement's value date.
 *
 * THE VALUE DATE, never today's. This is the first of the three layers that
 * make "a changed rate must not retroactively re-price a settlement from last
 * week" true: resolution happens on the date the spend happened, so a replay
 * of an old settlement gets the old card back by construction.
 */
export async function resolveRate(
  args: {
    readonly category: string;
    readonly presentment: Presentment;
    readonly valueDate: string;
  },
  conn: Sql = sql,
): Promise<RateCardEntry | null> {
  // NOTE THE `::text::interchange_presentment` AND THE `presentment::text`.
  // Neither is decoration. This connection runs through Neon's pooler, which
  // keeps server-side prepared statements alive across client connections; a
  // statement whose PARAMETER or RESULT carries an enum pins that enum's OID
  // into a cached plan, and after the type is replaced the pooled backend
  // answers `cache lookup failed for type <oid>` to a caller that has done
  // nothing wrong. Measured against this database while iterating on migration
  // 0031. Passing and returning text keeps every enum OID out of the wire
  // protocol; the CAST still happens inside Postgres, so the resolution is the
  // enum's, not a string comparison's.
  const rows = await conn<
    {
      id: string;
      category: string;
      presentment: Presentment;
      effective_from: string;
      rate_bps: number;
      fixed_cents: bigint;
    }[]
  >`
    SELECT id, category, presentment::text AS presentment,
           to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
           rate_bps, fixed_cents
      FROM interchange_rate_at(${args.category},
                               ${args.presentment}::text::interchange_presentment,
                               ${args.valueDate}::date)`;
  const row = rows[0];
  // interchange_rate_at() is a set-returning function over a composite type, so
  // "no card" comes back as one row of NULLs rather than as zero rows.
  if (row === undefined || row.id === null) return null;
  return {
    policyId: row.id,
    category: row.category,
    presentment: row.presentment,
    effectiveFrom: row.effective_from,
    rateBps: row.rate_bps,
    fixedCents: row.fixed_cents,
  };
}

/**
 * Record the priced settlement beside the entry that booked it.
 *
 * Every operand of the arithmetic is stored and every one is re-derived by
 * `interchange_posting_arithmetic`, so a row that disagrees with DESIGN §12.2
 * by one cent cannot be written. `ON CONFLICT DO NOTHING` against
 * `UNIQUE (provider, provider_event_id)` is the exactly-once story: a
 * redelivered webhook cannot book a second interchange entry, and that is
 * decided by Postgres rather than by an `if` in this process.
 *
 * Returns the posting id — the existing one when this call lost the race,
 * which is the same contract `postEntry()` has and for the same reason.
 */
export async function insertPosting(
  args: {
    readonly candidate: SettlementCandidate;
    readonly entryId: string;
    readonly direction: InterchangeDirection;
    readonly dimensions: SettlementDimensions;
    readonly category: string;
    readonly rate: RateCardEntry;
    readonly arithmetic: InterchangeArithmetic;
    readonly run: string;
  },
  conn: Sql = sql,
): Promise<string> {
  const { candidate: c, arithmetic: a, dimensions: d } = args;

  await conn`
    INSERT INTO interchange_posting (
      provider, provider_event_id, auth_id, card_id, business_id,
      deposit_account_id, settlement_entry_id, entry_id, value_date,
      direction, settled_cents,
      mcc, category, presentment, entry_mode, terminal_type, network, descriptor,
      policy_id, rate_bps, fixed_cents,
      numerator, denominator, whole_cents, remainder_units, rounding,
      ad_valorem_cents, interchange_cents, posted_by_run)
    VALUES (
      ${c.provider}, ${c.providerEventId}, ${c.authId}::uuid, ${c.cardId}::uuid,
      ${c.businessId}::uuid, ${c.depositAccountId}::uuid,
      ${c.settlementEntryId}::uuid, ${args.entryId}::uuid, ${c.valueDate}::date,
      ${args.direction}::text::interchange_direction, ${c.settledCents},
      ${d.mcc}, ${args.category}, ${d.presentment}::text::interchange_presentment,
      ${d.entryMode}, ${d.terminalType}, ${d.network}, ${d.descriptor},
      ${args.rate.policyId}::uuid, ${args.rate.rateBps}, ${args.rate.fixedCents},
      ${a.numerator}, ${a.denominator}, ${a.wholeCents}, ${a.remainderUnits},
      ${a.rounding}::text::interest_rounding,
      ${a.adValoremCents}, ${a.interchangeCents}, ${args.run})
    ON CONFLICT (provider, provider_event_id) DO NOTHING`;

  const rows = await conn<{ id: string }[]>`
    SELECT id FROM interchange_posting
     WHERE provider = ${c.provider} AND provider_event_id = ${c.providerEventId}`;
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      `interchange posting for ${c.provider}:${c.providerEventId} was neither written nor found`,
    );
  }
  return id;
}

/**
 * Record that a posting's revenue has been unbooked or re-priced.
 *
 * `PRIMARY KEY (interchange_posting_id)` makes this exactly-once BY
 * CONSTRUCTION — `hold_closure`'s shape and `hold_closure`'s reason. Returns
 * true if this call was the one that wrote it.
 */
export async function insertReversal(
  args: {
    readonly interchangePostingId: string;
    readonly reason: string;
    readonly reversalEntryId: string;
    readonly rebookEntryId: string | null;
    readonly netSettledCents: bigint;
    readonly rebookNaturalCents: bigint;
    readonly valueDate: string;
    readonly correctionGroupId: string;
    readonly actorId: string;
  },
  conn: Sql = sql,
): Promise<boolean> {
  const rows = await conn`
    INSERT INTO interchange_reversal (
      interchange_posting_id, reason, reversal_entry_id, rebook_entry_id,
      net_settled_cents, rebook_natural_cents, value_date, correction_group_id,
      created_by)
    VALUES (
      ${args.interchangePostingId}::uuid, ${args.reason},
      ${args.reversalEntryId}::uuid, ${args.rebookEntryId}::uuid,
      ${args.netSettledCents}, ${args.rebookNaturalCents},
      ${args.valueDate}::date, ${args.correctionGroupId}::uuid,
      ${args.actorId}::uuid)
    ON CONFLICT (interchange_posting_id) DO NOTHING
    RETURNING interchange_posting_id`;
  return rows.length > 0;
}

/** What one priced settlement looks like now, after every correction. */
export interface PostingPosition {
  readonly postingId: string;
  readonly entryId: string;
  readonly valueDate: string;
  readonly rateBps: number;
  readonly fixedCents: bigint;
  /** The customer's leg across the settlement's whole correction group. */
  readonly netSettledCents: bigint;
  /** What the 4100 lines of the interchange group actually say, in natural terms. */
  readonly bookedNaturalCents: bigint;
  /**
   * The JOURNAL entry that reversed the settlement, if one exists.
   *
   * Read from `journal_entry.reverses_entry_id`, not from a status column and
   * not from an audit table — the same source `v_interchange_unreversed` uses,
   * so the condition that makes the guard fire is the condition that makes the
   * repair run.
   */
  readonly settlementReversalEntryId: string | null;
  /** The JOURNAL entry that reversed the interchange, if one exists. */
  readonly journalReversalEntryId: string | null;
  /**
   * An `interchange_reversal` audit row exists.
   *
   * NOT the same question as `journalReversalEntryId !== null`, and the
   * difference matters: the journal is the money and this table is the
   * paperwork. A repair whose paperwork is missing is still a correct book,
   * and the reconcile re-files it rather than re-posting anything.
   */
  readonly repaired: boolean;
}

/**
 * Read a posting's position straight out of the views the invariant uses.
 *
 * Deliberately the SAME two views `v_interchange_drift` reads, rather than a
 * private query that computes the same thing. The repair and the invariant must
 * not be able to disagree about what the book currently says, and the cheapest
 * way to guarantee that is for both to ask one question.
 */
export async function readPostingPosition(
  postingId: string,
  conn: Sql = sql,
): Promise<PostingPosition | null> {
  const rows = await conn<
    {
      id: string;
      entry_id: string;
      value_date: string;
      rate_bps: number;
      fixed_cents: bigint;
      net_settled_cents: bigint;
      booked_natural_cents: bigint;
      settlement_reversal_entry_id: string | null;
      journal_reversal_entry_id: string | null;
      repaired: boolean;
    }[]
  >`
    SELECT ip.id, ip.entry_id, to_char(ip.value_date, 'YYYY-MM-DD') AS value_date,
           ip.rate_bps, ip.fixed_cents,
           COALESCE(n.net_customer_cents, 0)::bigint   AS net_settled_cents,
           COALESCE(b.booked_natural_cents, 0)::bigint AS booked_natural_cents,
           n.settlement_reversal_entry_id,
           b.journal_reversal_entry_id,
           (ir.interchange_posting_id IS NOT NULL)     AS repaired
      FROM interchange_posting ip
      LEFT JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
      LEFT JOIN v_interchange_booked         b ON b.interchange_posting_id = ip.id
      LEFT JOIN interchange_reversal        ir ON ir.interchange_posting_id = ip.id
     WHERE ip.id = ${postingId}::uuid`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    postingId: row.id,
    entryId: row.entry_id,
    valueDate: row.value_date,
    rateBps: row.rate_bps,
    fixedCents: row.fixed_cents,
    netSettledCents: row.net_settled_cents,
    bookedNaturalCents: row.booked_natural_cents,
    settlementReversalEntryId: row.settlement_reversal_entry_id,
    journalReversalEntryId: row.journal_reversal_entry_id,
    repaired: row.repaired,
  };
}

/**
 * The system actor interchange posts under. Resolved by name, not hard-coded as
 * a uuid, so a re-seed cannot leave a dangling foreign key in this module.
 * `holds/store.ts` resolves the same actor the same way.
 */
export async function ledgerPosterActorId(conn: Sql = sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("no 'ledger-poster' system actor; run scripts/seed.mjs");
  return id;
}
