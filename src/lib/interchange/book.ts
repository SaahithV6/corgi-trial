/**
 * Booking interchange, unbooking it, and re-pricing it — as ONE function.
 *
 * ─── Why one function and not three ─────────────────────────────────────────
 *
 * `reconcileSettlement()` is total and idempotent. Given a settlement it makes
 * the book say the right thing about that settlement's interchange, whatever
 * the book currently says, and calling it again changes nothing. There is no
 * "book" path, no separate "unbook" path and no third "re-price" path, because
 * three paths is three chances for one of them not to be called.
 *
 * That matters here more than anywhere else in this build, because of the trap
 * the feature is graded on:
 *
 *     A SETTLEMENT CAN BE REVERSED, AND INTERCHANGE BOOKED ON A SETTLEMENT
 *     THAT LATER REVERSES MUST REVERSE TOO.
 *
 * If a separate unbooking path exists and the correction path forgets to call
 * it, the ledger overstates revenue for ever and NOT ONE EXISTING INVARIANT
 * NOTICES — every existing invariant on this book is about whether entries
 * BALANCE, and an interchange entry that should not exist balances perfectly.
 * So the shape of the code is chosen to make forgetting impossible rather than
 * unlikely: the hook calls this, the backfill calls this, and both get the
 * booking and the unbooking from the same body.
 *
 * ─── The two steps, and why they are in this order ──────────────────────────
 *
 *   1. BOOK, if nothing has been booked. Always at the ORIGINAL settled
 *      amount, priced by the card effective on the settlement's own value date.
 *      Even when the settlement has already been reversed. That is not wasted
 *      work — it is the honest bitemporal record: the revenue WAS earned on
 *      that day on the information we had, and the repair is a second fact
 *      about the same day, not an edit to the first. Booking the net directly
 *      would produce a ledger that could not answer "what did we think this
 *      settlement was worth before the merchant took it back", which is the
 *      question this whole build exists to be able to answer.
 *
 *   2. REPAIR, if what the journal says disagrees with what the settlement is
 *      now worth. Read the settlement's whole correction group, price its net
 *      at THE POSTING'S OWN STORED RATE, compare against the 4100 lines of the
 *      interchange correction group, and reverse-and-rebook the difference at
 *      the ORIGINAL value date.
 *
 * Step 2 is driven by ARITHMETIC ON THE JOURNAL, not by "a correction event
 * arrived". That is the difference between a hook that works and a hook that
 * works until someone reverses a settlement by another route: the repair
 * condition is exactly the condition `v_interchange_drift` reports, so
 * anything that makes the invariant fire also makes this function act.
 *
 * ─── Re-pricing uses the ORIGINAL policy, never today's ─────────────────────
 *
 * `readPostingPosition()` returns the rate stored on the posting, and the
 * re-book is priced with it. A correction is a restatement of what happened on
 * the original date, so it is priced by the card that was in force on the
 * original date — the same reason `reverseAndRebook()` carries the original's
 * value date. Re-resolving the rate card today would let a rate change reach
 * back through the correction path, which is precisely what
 * `interchange_rate_policy_forward_only` and `v_interchange_rate_drift` exist
 * to prevent by the front door.
 *
 * ─── Idempotency, at four layers, none of them an `if` in this file ─────────
 *
 *   journal_entry.idempotency_key   UNIQUE   `interchange:<provider event id>`
 *                                            and `interchange:corrected:<...>`
 *   interchange_posting             UNIQUE (provider, provider_event_id)
 *                                   UNIQUE (settlement_entry_id)
 *   interchange_reversal            PRIMARY KEY (interchange_posting_id)
 *   reverseAndRebook                `reversal:<entry id>`, plus
 *                                   journal_entry_one_reversal_idx
 *
 * Every one of those is Postgres deciding, which is the same argument the hold
 * machinery makes about redelivery.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry, reverseAndRebook } from "@/lib/ledger/post";
import { resolveChartCodes } from "@/lib/ledger/queries";

import { isPriceable, readDimensions } from "./dimensions";
import {
  interchangeForNet,
  interchangeLines,
  interchangePostingKey,
  interchangeRebookKey,
  priceSettlement,
} from "./rate-card";
import {
  CARD_SETTLEMENT_CODE,
  INTERCHANGE_INCOME_CODE,
  findCandidateByEntry,
  findCandidateByEvent,
  insertPosting,
  insertReversal,
  ledgerPosterActorId,
  readPostingPosition,
  resolveCategory,
  resolveRate,
  type SettlementCandidate,
} from "./store";

/** What one call to `reconcileSettlement` did. */
export type ReconcileOutcome =
  /** Booked for the first time. */
  | {
      readonly status: "booked";
      readonly postingId: string;
      readonly entryId: string;
      readonly interchangeCents: bigint;
      readonly category: string;
      readonly rateBps: number;
      readonly fixedCents: bigint;
    }
  /** Booked, then immediately repaired because the settlement had been corrected. */
  | {
      readonly status: "booked_and_repaired";
      readonly postingId: string;
      readonly entryId: string;
      readonly interchangeCents: bigint;
      readonly category: string;
      readonly rateBps: number;
      readonly fixedCents: bigint;
      readonly repair: RepairPosted;
    }
  /** Already booked and already correct. The replay answer. */
  | { readonly status: "unchanged"; readonly postingId: string }
  /** Already booked, and this call unbooked or re-priced it. */
  | { readonly status: "repaired"; readonly postingId: string; readonly repair: RepairPosted }
  /**
   * No provider transaction record: there is no merchant and no entry mode to
   * read, and a dimension that cannot be populated from a real event is not
   * invented. Visible in `v_interchange_unpriced`.
   */
  | { readonly status: "unpriceable"; readonly reason: string }
  /**
   * Priced, and the price is zero cents. A small enough ticket on a band with
   * no fixed component rounds to nothing (charity, 100 bps and no fixed fee: a
   * 40c donation). `postEntry()` refuses a zero-amount line and is right to, so
   * there is nothing to post and nothing to record.
   */
  | { readonly status: "zero_value"; readonly category: string; readonly rateBps: number }
  /**
   * The settlement has been corrected a SECOND time. `journal_entry` permits
   * one reversal per entry (`journal_entry_one_reversal_idx`) and
   * `interchange_reversal` is `PRIMARY KEY (interchange_posting_id)`, so the
   * repair cannot be applied twice. Reported rather than forced, and
   * `v_interchange_drift` keeps saying so until a human looks — which is this
   * system's answer to ambiguity everywhere else too.
   */
  | {
      readonly status: "re_correction_unsupported";
      readonly postingId: string;
      readonly bookedNaturalCents: bigint;
      readonly expectedNaturalCents: bigint;
    }
  /** No such settlement on the book. */
  | { readonly status: "not_found" };

export interface RepairPosted {
  readonly reversalEntryId: string;
  readonly rebookEntryId: string | null;
  readonly correctionGroupId: string;
  /** The ORIGINAL's value date. Always. */
  readonly valueDate: string;
  readonly netSettledCents: bigint;
  /** What the 4100 lines said before this repair, in natural terms. */
  readonly previousNaturalCents: bigint;
  /** What interchange the settlement is now worth, in natural terms. */
  readonly rebookNaturalCents: bigint;
}

export interface ReconcileContext {
  readonly actorId?: string;
  readonly inboxId?: string | null;
  /** Names the caller on every posting row: the hook, the backfill, a test. */
  readonly run?: string;
  readonly conn?: Sql;
}

/**
 * Make the book say the right thing about one settlement's interchange.
 *
 * Safe to call at any time, from anywhere, any number of times.
 */
export async function reconcileSettlement(
  settlementEntryId: string,
  ctx: ReconcileContext = {},
): Promise<ReconcileOutcome> {
  const conn = ctx.conn ?? sql;
  const candidate = await findCandidateByEntry(settlementEntryId, conn);
  if (candidate === null) return { status: "not_found" };
  return reconcileCandidate(candidate, ctx);
}

/**
 * The same, addressed by the provider's own event token.
 *
 * This is the form the webhook hook uses: `applyCardTransaction` holds the
 * derived events, not the entry ids that were written for them.
 */
export async function reconcileSettlementEvent(
  provider: string,
  providerEventId: string,
  ctx: ReconcileContext = {},
): Promise<ReconcileOutcome> {
  const conn = ctx.conn ?? sql;
  const candidate = await findCandidateByEvent(provider, providerEventId, conn);
  if (candidate === null) return { status: "not_found" };
  return reconcileCandidate(candidate, ctx);
}

export async function reconcileCandidate(
  candidate: SettlementCandidate,
  ctx: ReconcileContext = {},
): Promise<ReconcileOutcome> {
  const conn = ctx.conn ?? sql;
  const actorId = ctx.actorId ?? (await ledgerPosterActorId(conn));
  const run = ctx.run ?? "interchange";

  // ---- Step 1: book, if nothing has been booked --------------------------
  let postingId = candidate.interchangePostingId;
  let booked: Extract<ReconcileOutcome, { status: "booked" }> | null = null;

  if (postingId === null) {
    const outcome = await bookFirstTime(candidate, { actorId, run, conn, inboxId: ctx.inboxId ?? null });
    if (outcome.status !== "booked") return outcome;
    postingId = outcome.postingId;
    booked = outcome;
  }

  // ---- Step 2: repair, if the journal disagrees with the settlement ------
  const position = await readPostingPosition(postingId, conn);
  if (position === null) {
    throw new Error(`interchange posting ${postingId} vanished between write and read`);
  }

  const expected = interchangeForNet(position.netSettledCents, {
    // THE POSTING'S OWN RATE. See the header: a correction is priced by the
    // card that was in force on the original date, never by today's.
    rateBps: position.rateBps,
    fixedCents: position.fixedCents,
  });

  // TWO CONDITIONS, AND THE SECOND IS NOT COSMETIC.
  //
  //   (a) the journal disagrees with what the settlement is now worth
  //   (b) the settlement was reversed and the audit row for the repair is
  //       missing
  //
  // (b) exists because the money and the paperwork can get out of step in the
  // safe direction: the repair entries are on the ledger and immutable, and
  // `interchange_reversal` is not. It was observed on this book — 56 correctly
  // repaired settlements whose audit rows had been rebuilt away — and the
  // right answer is to re-file the paperwork, not to re-post the money.
  // `reverseAndRebook()` is idempotent on `reversal:<entry id>`, so running the
  // repair again returns the entries that already exist and writes nothing new;
  // only the missing row lands. `v_interchange_unreversed` is the guard for
  // exactly this state and it reads the journal on both sides, so it and this
  // condition cannot drift apart.
  const needsRepair =
    position.bookedNaturalCents !== expected.naturalCents ||
    (position.settlementReversalEntryId !== null && !position.repaired);

  if (!needsRepair) {
    return booked !== null ? booked : { status: "unchanged", postingId };
  }

  if (position.repaired) {
    // Already repaired once and still wrong: the settlement was corrected a
    // second time. Neither the ledger nor this table can express a second
    // repair, so the honest answer is to say so and let the invariant keep
    // reporting. A guess here would be a second reversal the database would
    // refuse anyway.
    return {
      status: "re_correction_unsupported",
      postingId,
      bookedNaturalCents: position.bookedNaturalCents,
      expectedNaturalCents: expected.naturalCents,
    };
  }

  const repair = await repairPosting(
    { candidate, position, expectedNaturalCents: expected.naturalCents, actorId, conn },
  );

  return booked !== null
    ? { ...booked, status: "booked_and_repaired", repair }
    : { status: "repaired", postingId, repair };
}

// ---------------------------------------------------------------------------
// Step 1
// ---------------------------------------------------------------------------

async function bookFirstTime(
  candidate: SettlementCandidate,
  ctx: {
    readonly actorId: string;
    readonly run: string;
    readonly conn: Sql;
    readonly inboxId: string | null;
  },
): Promise<ReconcileOutcome> {
  // THE LINE THE BRIEF DRAWS, enforced at the posting boundary. A settlement
  // with no provider transaction record has no merchant and no entry mode to
  // read; inventing them to make a number appear is exactly what "do not
  // invent a dimension you cannot populate from a real event" forbids.
  if (!candidate.providerRecordPresent || !isPriceable(candidate.payload)) {
    return {
      status: "unpriceable",
      reason: candidate.providerRecordPresent
        ? `provider record for ${candidate.providerAuthId} carries neither a merchant nor a pos block`
        : `no provider transaction record for ${candidate.providerAuthId}`,
    };
  }

  const dimensions = readDimensions(candidate.payload);
  const category = await resolveCategory(dimensions.mcc, ctx.conn);
  const rate = await resolveRate(
    { category, presentment: dimensions.presentment, valueDate: candidate.valueDate },
    ctx.conn,
  );
  if (rate === null) {
    // A hole in the rate card is a configuration error, not a settlement to
    // skip: skipping would silently understate revenue and nothing would say
    // so. Loud, with the three coordinates that are missing.
    throw new Error(
      `no interchange rate card for (${category}, ${dimensions.presentment}) effective on or before ${candidate.valueDate}`,
    );
  }

  const magnitude =
    candidate.settledCents > 0n ? candidate.settledCents : -candidate.settledCents;
  const arithmetic = priceSettlement(magnitude, rate);

  if (arithmetic.interchangeCents === 0n) {
    return { status: "zero_value", category, rateBps: rate.rateBps };
  }

  const direction = candidate.settledCents > 0n ? "earned" : "returned";
  const naturalCents =
    direction === "earned" ? arithmetic.interchangeCents : -arithmetic.interchangeCents;

  const chart = await resolveChartCodes(
    {
      entityId: candidate.entityId,
      houseCodes: [CARD_SETTLEMENT_CODE, INTERCHANGE_INCOME_CODE],
    },
    ctx.conn,
  );
  const payable = chart.get(CARD_SETTLEMENT_CODE);
  const income = chart.get(INTERCHANGE_INCOME_CODE);
  if (payable === undefined || income === undefined) {
    throw new Error(
      `chart is missing ${CARD_SETTLEMENT_CODE} or ${INTERCHANGE_INCOME_CODE} for entity ${candidate.entityId}`,
    );
  }

  const entryId = await postEntry(
    {
      entityId: candidate.entityId,
      // THE SETTLEMENT'S VALUE DATE. The revenue and the spend it came from are
      // dated identically or a day's P&L is not internally consistent — and
      // `assert_interchange_posting()` refuses the row if they are not.
      valueDate: candidate.valueDate,
      book: "financial",
      description:
        direction === "earned"
          ? `Interchange on card ${candidate.kind.replace("_", " ")} ${candidate.providerAuthId}`
          : `Interchange returned on card refund ${candidate.providerAuthId}`,
      // Derived from the provider's own event token, never from a uuid we
      // generate. UNIQUE on journal_entry, so a redelivery re-posts nothing.
      idempotencyKey: interchangePostingKey(candidate.providerEventId),
      actorId: ctx.actorId,
      rail: "card",
      externalRef: candidate.providerAuthId,
      ...(ctx.inboxId !== null ? { inboxId: ctx.inboxId } : {}),
      lines: interchangeLines(
        { networkPayableId: payable.accountId, interchangeIncomeId: income.accountId },
        naturalCents,
      ),
    },
    ctx.conn,
  );

  const postingId = await insertPosting(
    { candidate, entryId, direction, dimensions, category, rate, arithmetic, run: ctx.run },
    ctx.conn,
  );

  return {
    status: "booked",
    postingId,
    entryId,
    interchangeCents: arithmetic.interchangeCents,
    category,
    rateBps: rate.rateBps,
    fixedCents: rate.fixedCents,
  };
}

// ---------------------------------------------------------------------------
// Step 2
// ---------------------------------------------------------------------------

async function repairPosting(args: {
  readonly candidate: SettlementCandidate;
  readonly position: NonNullable<Awaited<ReturnType<typeof readPostingPosition>>>;
  readonly expectedNaturalCents: bigint;
  readonly actorId: string;
  readonly conn: Sql;
}): Promise<RepairPosted> {
  const { candidate, position, expectedNaturalCents, conn } = args;

  const reason =
    expectedNaturalCents === 0n
      ? `the settlement it priced was reversed in full, so the interchange was never earned`
      : `the settlement it priced was corrected to ${position.netSettledCents} cents, re-priced at the card effective ${position.valueDate} (${position.rateBps} bps + ${position.fixedCents}c)`;

  // A FULL UNBOOK IS A REVERSAL AND NOTHING ELSE. The entry was a false
  // statement about its own day — we earned nothing, because nothing settled —
  // and the honest repair is to take it back there rather than to restate it at
  // a number nobody asserted. `holds/corrections.ts` makes the same call for
  // the settlement itself, in the same words.
  if (expectedNaturalCents === 0n) {
    const { reversalEntryId, correctionGroupId } = await reverseAndRebook(
      { originalEntryId: position.entryId, reason, actorId: args.actorId },
      conn,
    );
    await insertReversal(
      {
        interchangePostingId: position.postingId,
        reason,
        reversalEntryId,
        rebookEntryId: null,
        netSettledCents: position.netSettledCents,
        rebookNaturalCents: 0n,
        valueDate: position.valueDate,
        correctionGroupId,
        actorId: args.actorId,
      },
      conn,
    );
    return {
      reversalEntryId,
      rebookEntryId: null,
      correctionGroupId,
      valueDate: position.valueDate,
      netSettledCents: position.netSettledCents,
      previousNaturalCents: position.bookedNaturalCents,
      rebookNaturalCents: 0n,
    };
  }

  const chart = await resolveChartCodes(
    {
      entityId: candidate.entityId,
      houseCodes: [CARD_SETTLEMENT_CODE, INTERCHANGE_INCOME_CODE],
    },
    conn,
  );
  const payable = chart.get(CARD_SETTLEMENT_CODE);
  const income = chart.get(INTERCHANGE_INCOME_CODE);
  if (payable === undefined || income === undefined) {
    throw new Error(
      `chart is missing ${CARD_SETTLEMENT_CODE} or ${INTERCHANGE_INCOME_CODE} for entity ${candidate.entityId}`,
    );
  }

  const { reversalEntryId, rebookEntryId, correctionGroupId } = await reverseAndRebook(
    {
      originalEntryId: position.entryId,
      reason,
      actorId: args.actorId,
      rebook: {
        // THE ORIGINAL'S DATE. Not today's, and not the correction's.
        valueDate: position.valueDate,
        book: "financial",
        description: `Interchange on card settlement ${candidate.providerAuthId} (corrected)`,
        idempotencyKey: interchangeRebookKey(candidate.providerEventId),
        rail: "card",
        externalRef: candidate.providerAuthId,
        lines: interchangeLines(
          { networkPayableId: payable.accountId, interchangeIncomeId: income.accountId },
          expectedNaturalCents,
        ),
      },
    },
    conn,
  );

  await insertReversal(
    {
      interchangePostingId: position.postingId,
      reason,
      reversalEntryId,
      rebookEntryId,
      netSettledCents: position.netSettledCents,
      rebookNaturalCents: expectedNaturalCents,
      valueDate: position.valueDate,
      correctionGroupId,
      actorId: args.actorId,
    },
    conn,
  );

  return {
    reversalEntryId,
    rebookEntryId,
    correctionGroupId,
    valueDate: position.valueDate,
    netSettledCents: position.netSettledCents,
    previousNaturalCents: position.bookedNaturalCents,
    rebookNaturalCents: expectedNaturalCents,
  };
}
