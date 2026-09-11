/**
 * Reading and writing quotes. The only module in this directory that opens a
 * connection.
 *
 * ── THREE RULES IT KEEPS ────────────────────────────────────────────────────
 *
 * 1. IT NEVER UPDATES ANYTHING. `corgi_app` holds SELECT and INSERT on all
 *    five tables and nothing else (0017 §7 for the four, 0041 §6 for
 *    `fx_quote_fixture`), so this is a privilege rather than a convention — an
 *    UPDATE written here would not compile into a working query, it would be
 *    refused by the server.
 *
 * 2. IT LETS THE CONTROLS FIRE AND TRANSLATES THE RESULT. The expiry is not
 *    re-checked in TypeScript before the INSERT. `fx_quote_acceptance_guard()`
 *    decides, and `refusalFrom()` below turns its `RAISE EXCEPTION` into
 *    something an operator can read. This is the rule
 *    `src/lib/approvals/refusal.ts` states at length and for the same reason:
 *    a second, weaker copy of a control rots independently, and the copy that
 *    rots is always the one people actually hit. It also closes the race that
 *    a pre-check cannot — between `SELECT expires_at` and `INSERT`, the offer
 *    can lapse.
 *
 * 3. IT NEVER READS A STATE COLUMN, BECAUSE THERE IS NOT ONE. Everything comes
 *    through `v_fx_quote_marked`, which is 0017's `v_fx_quote` — `state`
 *    derived from the presence of rows and a comparison against `now()` — with
 *    0041's provenance columns LEFT JOINed on.
 *
 * ── AND ONE MORE, ADDED AFTER IT WENT WRONG ─────────────────────────────────
 *
 * 4. IT DOES NOT HIDE A FIXTURE, IT LABELS ONE. `fx.integration.test.ts` used
 *    to commit against the live database, and seven of the eight rows in
 *    `fx_quote_settlement` are what it left behind. The fix is `0041`, and the
 *    shape of the fix matters: `is_fixture` is a COLUMN on every row, never a
 *    predicate in the query below. A filter that drops test rows from the
 *    quote book is one widened predicate away from dropping a real failure
 *    from it, and it would be dropping it from the screen whose entire job is
 *    to be the record. `loadQuotes` returns the fixtures; `quoteView()` prints
 *    the label; the count on `/payouts` does not move.
 *
 * ── WHOSE NAME GOES ON AN ACCEPTANCE ────────────────────────────────────────
 *
 * The system actor `ledger-poster`, not a human — the same choice
 * `src/app/(app)/pots/actions.ts` makes and for the same stated reason. The
 * console's role switcher is a demo affordance and not an authorisation
 * boundary; this deployment cannot authenticate a person, and writing a human
 * name onto a commitment we cannot prove that human made would put a lie in
 * the audit trail of exactly the record that exists to be trusted. A real
 * deployment binds `accepted_by` to the authenticated session, and the column
 * is already the right shape for it. docs/FX.md §8 says so out loud.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { err, fail, ok, type ErrorShape, type Result } from "@/lib/result";

import {
  DEFAULT_FEE_BPS,
  DEFAULT_FEE_FLAT_CENTS,
  DEFAULT_QUOTE_TTL_SECONDS,
  DEFAULT_SETTLEMENT_WINDOW_SECONDS,
  DEFAULT_SPREAD_BPS,
  isQuoteState,
  requireCorridor,
  type FxRefusalCode,
  type QuoteState,
  type RateEvidence,
  type RateObservation,
} from "./types";

/* -------------------------------------------------------------------------- */
/* The row shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One quote as `v_fx_quote` returns it, with bigints kept as bigints.
 *
 * `db.ts` configures the driver to parse `bigint` into `BigInt`, never into a
 * JS number — which is the reason every cents field below can be trusted.
 */
export interface QuoteRecord {
  readonly quoteId: string;
  readonly quoteRef: string;
  readonly entityId: string;
  readonly businessId: string;
  readonly businessName: string;

  readonly sellCurrency: string;
  readonly sellCents: bigint;
  readonly feeFlatCents: bigint;
  readonly feeBps: number;
  readonly feeCents: bigint;
  readonly netCents: bigint;

  readonly spreadBps: number;
  readonly midRateScaled: bigint;
  readonly customerRateScaled: bigint;
  readonly rateScale: bigint;

  readonly buyCurrency: string;
  readonly buyExponent: number;
  readonly buyMinor: bigint;

  readonly rail: string;
  readonly beneficiaryRef: string;
  readonly destinationAddress: string | null;

  readonly rateSource: string;
  readonly rateEvidence: RateEvidence;
  readonly rateLiteral: string;
  readonly rateDate: string;
  readonly rateFetchedAt: string;
  readonly rateHttpStatus: number | null;

  readonly createdAt: string;
  readonly createdByName: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: bigint;
  readonly settlementWindowSeconds: number;

  readonly acceptedAt: string | null;
  readonly acceptedByName: string | null;
  readonly acceptanceReference: string | null;
  readonly acceptedWithSecondsToSpare: bigint | null;
  readonly settleBy: string | null;

  readonly settledAt: string | null;
  readonly txHash: string | null;
  readonly entryId: string | null;
  readonly settlementMidRateScaled: bigint | null;
  readonly settlementCostCents: bigint | null;
  readonly varianceCents: bigint | null;

  readonly state: QuoteState;

  /**
   * Written by a test, not by a customer. `fx_quote_fixture`, 0041.
   *
   * NOT a reason to hide the row — it is the reason the row can be shown. See
   * rule 4 in the header.
   */
  readonly isFixture: boolean;
  /** What wrote it: a file path, so a reader can open it. `null` when real. */
  readonly fixtureSource: string | null;
  /** Why it is not a customer commitment, in a sentence. `null` when real. */
  readonly fixtureReason: string | null;
}

type QuoteRow = {
  quote_id: string;
  quote_ref: string;
  entity_id: string;
  business_id: string;
  business_name: string;
  sell_currency: string;
  sell_cents: bigint;
  fee_flat_cents: bigint;
  fee_bps: number;
  fee_cents: bigint;
  net_cents: bigint;
  spread_bps: number;
  mid_rate_scaled: bigint;
  customer_rate_scaled: bigint;
  rate_scale: bigint;
  buy_currency: string;
  buy_exponent: number;
  buy_minor: bigint;
  rail: string;
  beneficiary_ref: string;
  destination_address: string | null;
  rate_source: string;
  rate_evidence: RateEvidence;
  rate_literal: string;
  rate_date: string;
  rate_fetched_at: string;
  rate_http_status: number | null;
  created_at: string;
  created_by_name: string;
  expires_at: string;
  expires_in_seconds: bigint;
  settlement_window_seconds: number;
  accepted_at: string | null;
  accepted_by_name: string | null;
  acceptance_reference: string | null;
  accepted_with_seconds_to_spare: bigint | null;
  settle_by: string | null;
  settled_at: string | null;
  tx_hash: string | null;
  entry_id: string | null;
  settlement_mid_rate_scaled: bigint | null;
  settlement_cost_cents: bigint | null;
  variance_cents: bigint | null;
  state: string;
  is_fixture: boolean;
  fixture_source: string | null;
  fixture_reason: string | null;
};

function toRecord(row: QuoteRow): QuoteRecord {
  if (!isQuoteState(row.state)) {
    // v_fx_quote's CASE is exhaustive, so this is unreachable unless the view
    // and this union have drifted — which is exactly when a loud failure is
    // worth more than a cast.
    throw new Error(`v_fx_quote returned an unknown state '${row.state}' for ${row.quote_ref}`);
  }
  return {
    quoteId: row.quote_id,
    quoteRef: row.quote_ref,
    entityId: row.entity_id,
    businessId: row.business_id,
    businessName: row.business_name,
    sellCurrency: row.sell_currency,
    sellCents: row.sell_cents,
    feeFlatCents: row.fee_flat_cents,
    feeBps: row.fee_bps,
    feeCents: row.fee_cents,
    netCents: row.net_cents,
    spreadBps: row.spread_bps,
    midRateScaled: row.mid_rate_scaled,
    customerRateScaled: row.customer_rate_scaled,
    rateScale: row.rate_scale,
    buyCurrency: row.buy_currency,
    buyExponent: row.buy_exponent,
    buyMinor: row.buy_minor,
    rail: row.rail,
    beneficiaryRef: row.beneficiary_ref,
    destinationAddress: row.destination_address,
    rateSource: row.rate_source,
    rateEvidence: row.rate_evidence,
    rateLiteral: row.rate_literal,
    rateDate: row.rate_date,
    rateFetchedAt: row.rate_fetched_at,
    rateHttpStatus: row.rate_http_status,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    expiresAt: row.expires_at,
    expiresInSeconds: row.expires_in_seconds,
    settlementWindowSeconds: row.settlement_window_seconds,
    acceptedAt: row.accepted_at,
    acceptedByName: row.accepted_by_name,
    acceptanceReference: row.acceptance_reference,
    acceptedWithSecondsToSpare: row.accepted_with_seconds_to_spare,
    settleBy: row.settle_by,
    settledAt: row.settled_at,
    txHash: row.tx_hash,
    entryId: row.entry_id,
    settlementMidRateScaled: row.settlement_mid_rate_scaled,
    settlementCostCents: row.settlement_cost_cents,
    varianceCents: row.variance_cents,
    state: row.state,
    isFixture: row.is_fixture,
    fixtureSource: row.fixture_source,
    fixtureReason: row.fixture_reason,
  };
}

/**
 * The one SELECT. Both reads go through it, so there is exactly one list of
 * columns and one mapping, and a column added to the view cannot arrive on one
 * screen and not the other.
 *
 * Instants are rendered to ISO-8601 by Postgres rather than by the driver, so
 * the string a component receives is the same string whatever the server's
 * local timezone happens to be. `rate_date` is a CALENDAR DATE and is rendered
 * bare — turning it into an instant is how a value date lands on the wrong
 * day (see src/lib/format/datetime.ts).
 */
async function selectQuotes(
  conn: Sql,
  where: {
    readonly businessId: string | null;
    readonly quoteRef: string | null;
    readonly limit: number;
  },
): Promise<readonly QuoteRow[]> {
  return conn<QuoteRow[]>`
    SELECT quote_id, quote_ref, entity_id, business_id, business_name,
           sell_currency, sell_cents, fee_flat_cents, fee_bps, fee_cents, net_cents,
           spread_bps, mid_rate_scaled, customer_rate_scaled, rate_scale,
           buy_currency, buy_exponent, buy_minor,
           rail::text AS rail, beneficiary_ref, destination_address,
           rate_source, rate_evidence::text AS rate_evidence, rate_literal,
           to_char(rate_date, 'YYYY-MM-DD') AS rate_date,
           to_char(rate_fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS rate_fetched_at,
           rate_http_status,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           created_by_name,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
           expires_in_seconds, settlement_window_seconds,
           to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at,
           accepted_by_name, acceptance_reference, accepted_with_seconds_to_spare,
           to_char(settle_by AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS settle_by,
           to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS settled_at,
           tx_hash, entry_id, settlement_mid_rate_scaled, settlement_cost_cents, variance_cents,
           state,
           -- 0041. A COLUMN, never a predicate: see rule 4 in the header.
           is_fixture, fixture_source, fixture_reason
      FROM v_fx_quote_marked
     WHERE (${where.businessId}::uuid IS NULL OR business_id = ${where.businessId}::uuid)
       AND (${where.quoteRef}::text IS NULL OR quote_ref = ${where.quoteRef}::text)
     ORDER BY created_at DESC
     LIMIT ${where.limit}`;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface QuoteFilter {
  readonly businessId?: string;
  readonly quoteRef?: string;
  readonly limit?: number;
}

/** The quote book, newest first. Reads only; nothing here calls a rate source. */
export async function loadQuotes(
  filter: QuoteFilter = {},
  conn: Sql = sql,
): Promise<readonly QuoteRecord[]> {
  const rows = await selectQuotes(conn, {
    businessId: filter.businessId ?? null,
    quoteRef: filter.quoteRef ?? null,
    limit: Math.min(Math.max(filter.limit ?? 25, 1), 200),
  });
  return rows.map(toRecord);
}

/** One quote by its human handle, or `null`. */
export async function loadQuoteByRef(
  quoteRef: string,
  conn: Sql = sql,
): Promise<QuoteRecord | null> {
  const rows = await selectQuotes(conn, { businessId: null, quoteRef, limit: 1 });
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export interface BusinessOption {
  readonly businessId: string;
  readonly legalName: string;
}

/** The customers a quote can be raised for. */
export async function loadBusinesses(conn: Sql = sql): Promise<readonly BusinessOption[]> {
  const rows = await conn<{ id: string; legal_name: string }[]>`
    SELECT b.id, b.legal_name
      FROM business b
     WHERE EXISTS (
       SELECT 1 FROM account a
        WHERE a.business_id = b.id AND a.code = '2100'
     )
     ORDER BY b.legal_name`;
  return rows.map((r) => ({ businessId: r.id, legalName: r.legal_name }));
}

/** The system actor every write on this path is attributed to. See the header. */
export async function quoteActorId(conn: Sql = sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no 'ledger-poster' system actor; run scripts/seed.mjs");
  }
  return row.id;
}

/* -------------------------------------------------------------------------- */
/* The quote reference                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Crockford base32, which drops I, L, O and U.
 *
 * A quote reference is read down a phone and typed back into a support tool,
 * so the alphabet that matters is the one where 1/I/L and 0/O cannot be
 * confused. U is dropped as well, which is Crockford's own reason and a good
 * one: it keeps the set from accidentally spelling things.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `FXQ-` plus eight random Crockford characters. 32^8 ≈ 1.1e12. */
export function newQuoteRef(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // 256 is not a multiple of 32 — but it is 8 × 32, so masking the low five
    // bits is exactly uniform rather than approximately so.
    out += CROCKFORD[byte & 0x1f];
  }
  return `FXQ-${out}`;
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

/** The code a caller gets when the reference names nothing on file. */
const NOT_FOUND: FxRefusalCode = "FX_QUOTE_NOT_FOUND";

type PgErrorLike = { readonly code?: unknown; readonly message?: unknown };

function pgMessage(thrown: unknown): string {
  if (typeof thrown !== "object" || thrown === null) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  const candidate = thrown as PgErrorLike;
  return typeof candidate.message === "string" ? candidate.message : String(thrown);
}

function pgCode(thrown: unknown): string {
  if (typeof thrown !== "object" || thrown === null) return "";
  const candidate = thrown as PgErrorLike;
  return typeof candidate.code === "string" ? candidate.code : "";
}

/**
 * A database refusal as something an operator can read.
 *
 * Keyed on the exception text from 0017, quoted beside each branch so an edit
 * to either side is visible. The raw server text is never rendered — it names
 * internal ids and table structure, and `ErrorShape.message` is documented as
 * safe to show.
 */
function refusalFrom(thrown: unknown): ErrorShape {
  const message = pgMessage(thrown);
  const code = pgCode(thrown);

  // 0017 §4: 'quote % expired at % and cannot be accepted at %'
  if (message.includes("cannot be accepted at")) {
    return {
      code: "FX_QUOTE_EXPIRED",
      message:
        "That quote had already expired when the acceptance reached the database, so no " +
        "commitment was created and nothing was written. The rate you were looking at is " +
        "no longer one anybody would deal at — request a new quote.",
    };
  }

  // 23505 on fx_quote_acceptance_pkey: two acceptances of one offer.
  if (code === "23505" && message.includes("fx_quote_acceptance")) {
    return {
      code: "FX_QUOTE_ALREADY_ACCEPTED",
      message:
        "That quote has already been accepted. An acceptance is once and once only — the quote " +
        "id is the primary key of the acceptance table — so this second attempt wrote nothing " +
        "and the commitment already on file is unchanged.",
    };
  }

  if (code === "23505" && message.includes("fx_quote_settlement")) {
    return {
      code: "FX_QUOTE_ALREADY_SETTLED",
      message:
        "That quote has already funded a payout. One accepted rate settles one transfer; a " +
        "second transfer needs a second quote.",
    };
  }

  // 0017 §5: 'quote % was never accepted' / 'settlement window has closed'
  if (message.includes("was never accepted")) {
    return {
      code: "FX_QUOTE_NOT_ACCEPTED",
      message:
        "That quote was never accepted, so there is no commitment for a payout to settle " +
        "against. Nothing was written.",
    };
  }
  if (message.includes("settlement window has closed")) {
    return {
      code: "FX_QUOTE_COMMITMENT_LAPSED",
      message:
        "The settlement window on that acceptance has closed. We honoured the rate for the " +
        "whole window the offer named; past it the commitment lapses and the payout needs a " +
        "fresh quote.",
    };
  }
  if (message.includes("settlement does not add up")) {
    return {
      code: "FX_SETTLEMENT_UNBALANCED",
      message:
        "The settlement figures do not add up: what the customer paid, less our fee, less what " +
        "the delivery cost, is not the variance being recorded. Nothing was written.",
    };
  }

  // 0017 §7: the append-only triggers, SQLSTATE 55006.
  if (code === "55006" && message.includes("append-only violation")) {
    return {
      code: "FX_IMMUTABLE",
      message:
        "Quotes, acceptances and settlements are append-only. There is no edit path — a wrong " +
        "quote is superseded by a new one, never corrected in place.",
    };
  }

  return {
    code: "FX_WRITE_FAILED",
    message: "The write was refused by the database and nothing was recorded.",
  };
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateQuoteInput {
  readonly businessId: string;
  readonly buyCurrency: string;
  readonly sellCents: bigint;
  readonly beneficiaryRef: string;
  readonly destinationAddress?: string | null;
  /** The reading this quote is priced from. Stored alongside, never re-fetched. */
  readonly observation: RateObservation;
  readonly ttlSeconds?: number;
  readonly settlementWindowSeconds?: number;
  readonly feeFlatCents?: bigint;
  readonly feeBps?: number;
  readonly spreadBps?: number;
}

/**
 * Write the observation and the quote, in one transaction.
 *
 * The two are written together because a quote without the reading it was
 * priced from is a commitment whose provenance is a paragraph in a log.
 *
 * NOTHING HERE COMPUTES THE COMMITMENT. `fee_cents`, `customer_rate_scaled`
 * and `buy_minor` are GENERATED columns; this INSERT supplies the terms and
 * the database derives the promise. `priceQuote()` in ./quote.ts computes the
 * same numbers for the screen before anything is stored, and
 * `fx.integration.test.ts` asserts the two agree — but the row the customer is
 * shown afterwards is read back from the database, not from the preview.
 *
 * `expires_at` is computed from the DATABASE's `now()`, not the application's.
 * Otherwise a lambda whose clock has drifted a few seconds can write an offer
 * that expires before it was created, or one that stands longer than it should
 * — and the expiry is the control this whole feature turns on.
 */
export async function createQuote(
  input: CreateQuoteInput,
  conn: Sql = sql,
): Promise<Result<QuoteRecord, ErrorShape>> {
  const corridor = requireCorridor(input.buyCurrency);
  const ttl = input.ttlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  const window = input.settlementWindowSeconds ?? DEFAULT_SETTLEMENT_WINDOW_SECONDS;
  const quoteRef = newQuoteRef();

  try {
    const inserted = await conn.begin(async (tx) => {
      const t = tx as unknown as Sql;
      const actorId = await quoteActorId(t);

      const businesses = await tx<{ entity_id: string }[]>`
        SELECT entity_id FROM business WHERE id = ${input.businessId}::uuid`;
      const business = businesses[0];
      if (business === undefined) return null;

      const observations = await tx<{ id: string }[]>`
        INSERT INTO fx_rate_observation
          (source, evidence, base_currency, quote_currency,
           rate_scaled, rate_scale, rate_literal, rate_date, http_status)
        VALUES
          (${input.observation.source},
           ${input.observation.evidence}::fx_rate_evidence,
           ${input.observation.baseCurrency},
           ${input.observation.quoteCurrency},
           ${input.observation.rateScaled},
           ${input.observation.rateScale},
           ${input.observation.literal},
           ${input.observation.rateDate}::date,
           ${input.observation.httpStatus})
        RETURNING id`;
      const observationId = observations[0]?.id;
      if (observationId === undefined) throw new Error("the rate observation insert returned no id");

      const quotes = await tx<{ quote_ref: string }[]>`
        INSERT INTO fx_quote
          (entity_id, business_id, quote_ref, sell_cents,
           fee_flat_cents, fee_bps, spread_bps,
           observation_id, mid_rate_scaled, rate_scale,
           buy_currency, buy_exponent, beneficiary_ref, destination_address,
           created_by, expires_at, settlement_window_seconds)
        VALUES
          (${business.entity_id}::uuid, ${input.businessId}::uuid, ${quoteRef},
           ${input.sellCents},
           ${input.feeFlatCents ?? DEFAULT_FEE_FLAT_CENTS},
           ${input.feeBps ?? DEFAULT_FEE_BPS},
           ${input.spreadBps ?? DEFAULT_SPREAD_BPS},
           ${observationId}::uuid,
           ${input.observation.rateScaled},
           ${input.observation.rateScale},
           ${corridor.currency}, ${corridor.exponent},
           ${input.beneficiaryRef},
           ${input.destinationAddress ?? null},
           ${actorId}::uuid,
           now() + ${ttl}::int * interval '1 second',
           ${window})
        RETURNING quote_ref`;
      return quotes[0]?.quote_ref ?? null;
    });

    if (inserted === null) {
      return fail(
        "FX_NO_SUCH_BUSINESS",
        "There is no such customer, so no quote was created. Nothing was written.",
      );
    }

    const record = await loadQuoteByRef(inserted, conn);
    if (record === null) {
      return fail("FX_WRITE_FAILED", "The quote was written but could not be read back.");
    }
    return ok(record);
  } catch (thrown) {
    return err(refusalFrom(thrown));
  }
}

/* -------------------------------------------------------------------------- */
/* Accept                                                                     */
/* -------------------------------------------------------------------------- */

export interface AcceptQuoteInput {
  readonly quoteRef: string;
  readonly reference?: string | null;
}

/**
 * Accept an offer. The expiry is decided by the trigger, not by this function.
 *
 * There is deliberately no `SELECT expires_at` before the INSERT. Two reasons,
 * and the second is the one that matters: a pre-check is a second copy of the
 * control and it would be the copy people hit, and between reading the expiry
 * and writing the row the offer can lapse — a race a pre-check cannot close
 * and the trigger closes by construction.
 */
export async function acceptQuote(
  input: AcceptQuoteInput,
  conn: Sql = sql,
): Promise<Result<QuoteRecord, ErrorShape>> {
  try {
    const written = await conn.begin(async (tx) => {
      const t = tx as unknown as Sql;
      const actorId = await quoteActorId(t);
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM fx_quote WHERE quote_ref = ${input.quoteRef}`;
      const quote = rows[0];
      if (quote === undefined) return false;

      await tx`
        INSERT INTO fx_quote_acceptance (quote_id, accepted_by, reference)
        VALUES (${quote.id}::uuid, ${actorId}::uuid, ${input.reference ?? null})`;
      return true;
    });

    if (!written) {
      return fail(
        NOT_FOUND,
        `There is no quote ${input.quoteRef}. Nothing was written.`,
      );
    }

    const record = await loadQuoteByRef(input.quoteRef, conn);
    if (record === null) {
      return fail("FX_WRITE_FAILED", "The acceptance was written but the quote could not be read back.");
    }
    return ok(record);
  } catch (thrown) {
    return err(refusalFrom(thrown));
  }
}

/* -------------------------------------------------------------------------- */
/* Rate provenance, on its own                                                */
/* -------------------------------------------------------------------------- */

/**
 * Write one rate reading and return its id.
 *
 * `createQuote()` writes the observation the quote is priced FROM, inside the
 * quote's own transaction. This writes the observation a payout is SETTLED
 * against, which is a different reading taken at a different time and is the
 * one `fx_quote_settlement.settlement_observation_id` points at.
 *
 * Storing it matters for the same reason storing the quote-time reading
 * matters: `variance_cents` is only auditable if the rate it was computed from
 * is on file with its source, its literal and the status code of the call. A
 * variance derived from a number that exists only in a script's memory is a
 * number nobody can check.
 */
export async function recordRateObservation(
  observation: RateObservation,
  conn: Sql = sql,
): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    INSERT INTO fx_rate_observation
      (source, evidence, base_currency, quote_currency,
       rate_scaled, rate_scale, rate_literal, rate_date, http_status)
    VALUES
      (${observation.source},
       ${observation.evidence}::fx_rate_evidence,
       ${observation.baseCurrency},
       ${observation.quoteCurrency},
       ${observation.rateScaled},
       ${observation.rateScale},
       ${observation.literal},
       ${observation.rateDate}::date,
       ${observation.httpStatus})
    RETURNING id`;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("the rate observation insert returned no id");
  return id;
}

/* -------------------------------------------------------------------------- */
/* Settle                                                                     */
/* -------------------------------------------------------------------------- */

export interface RecordSettlementInput {
  readonly quoteRef: string;
  /** The chain's handle. This row is written after a receipt, never after a broadcast. */
  readonly txHash: string;
  /** The journal entry `postUsdcPayout()` produced, when the caller has it. */
  readonly entryId?: string | null;
  /** The mid at the moment we settled. Not the quoted mid — that is the point. */
  readonly settlementMidRateScaled: bigint;
  readonly settlementRateScale: bigint;
  readonly settlementObservationId?: string | null;
  readonly settlementCostCents: bigint;
  /** Signed: positive we kept the difference, negative we ate it. */
  readonly varianceCents: bigint;
}

/**
 * Record that a payout consumed an accepted quote.
 *
 * CALLED AFTER THE RECEIPT, NEVER AFTER THE BROADCAST. `tx_hash` is NOT NULL
 * for exactly that reason, and `postUsdcPayout()` holds itself to the same
 * rule one table over: a submitted transaction is not a confirmed one.
 *
 * The trigger checks the two preconditions this function does not: that the
 * quote was accepted, and that its settlement window is still open. It also
 * re-derives the variance identity and refuses a row that does not add up.
 */
export async function recordQuoteSettlement(
  input: RecordSettlementInput,
  conn: Sql = sql,
): Promise<Result<QuoteRecord, ErrorShape>> {
  try {
    const written = await conn.begin(async (tx) => {
      const t = tx as unknown as Sql;
      const actorId = await quoteActorId(t);
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM fx_quote WHERE quote_ref = ${input.quoteRef}`;
      const quote = rows[0];
      if (quote === undefined) return false;

      await tx`
        INSERT INTO fx_quote_settlement
          (quote_id, settled_by, tx_hash, entry_id,
           settlement_mid_rate_scaled, settlement_rate_scale, settlement_observation_id,
           settlement_cost_cents, variance_cents)
        VALUES
          (${quote.id}::uuid, ${actorId}::uuid, ${input.txHash.toLowerCase()},
           ${input.entryId ?? null}::uuid,
           ${input.settlementMidRateScaled}, ${input.settlementRateScale},
           ${input.settlementObservationId ?? null}::uuid,
           ${input.settlementCostCents}, ${input.varianceCents})`;
      return true;
    });

    if (!written) {
      return fail(
        NOT_FOUND,
        `There is no quote ${input.quoteRef}. Nothing was written.`,
      );
    }

    const record = await loadQuoteByRef(input.quoteRef, conn);
    if (record === null) {
      return fail("FX_WRITE_FAILED", "The settlement was written but the quote could not be read back.");
    }
    return ok(record);
  } catch (thrown) {
    return err(refusalFrom(thrown));
  }
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

export interface MarkFixtureInput {
  readonly quoteRef: string;
  /** What wrote it. A file path, so the next reader can open it. */
  readonly source: string;
  /** Why it is not a customer commitment, in a sentence somebody can act on. */
  readonly reason: string;
}

/**
 * Declare a quote — and therefore its observation, acceptance and settlement —
 * a test artefact rather than a customer commitment.
 *
 * ── WHY THIS FUNCTION EXISTS AT ALL ─────────────────────────────────────────
 *
 * `fx.integration.test.ts` now runs inside transactions that are rolled back,
 * so almost nothing it writes survives. There is exactly ONE scenario that
 * cannot: the expiry control. Proving it needs the wall clock to advance
 * between the moment an offer is raised and the moment it is accepted, and
 * `now()` inside a Postgres transaction is `transaction_timestamp()` — it does
 * not advance, by design, because two statements in one transaction must agree
 * on whether the offer was still open. A quote raised and expired inside one
 * transaction is not a thing that can exist.
 *
 * So that one test commits, and this is how it pays for it: it marks what it
 * commits, in the same transaction, as it commits it. There is no window in
 * which an unlabelled fixture is visible to anybody, and no follow-up step
 * that could be forgotten.
 *
 * ── WHY IT CANNOT INSTEAD DELETE ────────────────────────────────────────────
 *
 * Because `fx_quote` is append-only at two layers — `corgi_app` holds no
 * DELETE, and `ledger_row_is_immutable()` catches the table owner as well —
 * and that is the correct design, not an obstacle to route around. The honest
 * correction to a row in an append-only book is another row. 0041 is the long
 * version of this paragraph.
 *
 * Idempotent by PRIMARY KEY: marking twice is one row and a no-op, so a
 * re-run cannot fail on its own tidiness.
 */
export async function markQuoteAsFixture(
  input: MarkFixtureInput,
  conn: Sql = sql,
): Promise<Result<true, ErrorShape>> {
  try {
    const rows = await conn<{ quote_id: string }[]>`
      INSERT INTO fx_quote_fixture (quote_id, marked_by, source, reason)
      SELECT q.id, a.id, ${input.source}, ${input.reason}
        FROM fx_quote q
       CROSS JOIN LATERAL (
         SELECT id FROM actor
          WHERE kind = 'system' AND display_name = 'ledger-poster'
          LIMIT 1
       ) a
       WHERE q.quote_ref = ${input.quoteRef}
      ON CONFLICT (quote_id) DO NOTHING
      RETURNING quote_id`;
    // Zero rows means either "already marked" or "no such quote". Only the
    // second is a failure, and it is worth separating: a marker that silently
    // did nothing is exactly the failure mode this whole change is about.
    if (rows.length === 0) {
      const existing = await conn<{ n: bigint }[]>`
        SELECT count(*) AS n FROM fx_quote WHERE quote_ref = ${input.quoteRef}`;
      if ((existing[0]?.n ?? 0n) === 0n) {
        return fail(
          NOT_FOUND,
          `There is no quote ${input.quoteRef}, so nothing was marked.`,
        );
      }
    }
    return ok(true);
  } catch (thrown) {
    return err(refusalFrom(thrown));
  }
}

/** One settlement, with the evidence for whether it is real beside it. */
export interface SettlementRecord {
  readonly quoteRef: string;
  readonly businessName: string;
  readonly beneficiaryRef: string;
  readonly settledAt: string;
  readonly txHash: string;
  readonly entryId: string | null;
  /** Derived from the journal, not from `entry_id` being non-null. */
  readonly hasEntry: boolean;
  readonly settlementCostCents: bigint;
  readonly varianceCents: bigint;
  readonly isFixture: boolean;
  readonly fixtureSource: string | null;
  readonly fixtureReason: string | null;
}

/**
 * Every settlement ever recorded. UNFILTERED, and that is the feature.
 *
 * "How many cross-border payouts has this system actually settled" used to be
 * `SELECT count(*) FROM fx_quote_settlement`, which answered eight with no way
 * to tell that seven were a test's. It is this instead, where the answer
 * carries its evidence on the row — `isFixture`, and `hasEntry` taken from the
 * journal rather than from the settlement's own claim to have posted.
 *
 * The `WHERE` belongs to the reader. A count that has already decided which
 * rows the reader is allowed to see is not a count of anything.
 */
export async function loadSettlementBook(conn: Sql = sql): Promise<readonly SettlementRecord[]> {
  const rows = await conn<
    {
      quote_ref: string;
      business_name: string;
      beneficiary_ref: string;
      settled_at: string;
      tx_hash: string;
      entry_id: string | null;
      has_entry: boolean;
      settlement_cost_cents: bigint;
      variance_cents: bigint;
      is_fixture: boolean;
      fixture_source: string | null;
      fixture_reason: string | null;
    }[]
  >`
    SELECT quote_ref, business_name, beneficiary_ref,
           to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS settled_at,
           tx_hash, entry_id, has_entry,
           settlement_cost_cents, variance_cents,
           is_fixture, fixture_source, fixture_reason
      FROM v_fx_quote_settlement
     ORDER BY settled_at`;
  return rows.map((r) => ({
    quoteRef: r.quote_ref,
    businessName: r.business_name,
    beneficiaryRef: r.beneficiary_ref,
    settledAt: r.settled_at,
    txHash: r.tx_hash,
    entryId: r.entry_id,
    hasEntry: r.has_entry,
    settlementCostCents: r.settlement_cost_cents,
    varianceCents: r.variance_cents,
    isFixture: r.is_fixture,
    fixtureSource: r.fixture_source,
    fixtureReason: r.fixture_reason,
  }));
}
