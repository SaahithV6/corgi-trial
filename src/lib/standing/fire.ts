/**
 * The firing routine. One tick of the schedule.
 *
 * ============================================================================
 * THIS FILE MOVES NO MONEY, AND THAT IS THE DESIGN.
 *
 * A standing order that fired money would be a second way to pay somebody,
 * with its own approval rules, its own KYB check and its own ledger writes —
 * three copies of a control that must never have two. So a firing standing
 * order does exactly what Priya does when she types a payment in: it calls
 * `requestPayment()`. From that line onwards a scheduled rent payment and a
 * hand-typed one are the same row in the same table under the same policy
 * version, and the maker-checker rule applies to both because
 * `assert_maker_checker()` is a trigger and not an `if`.
 *
 * In particular: the mandate's `created_by` becomes the instruction's
 * `requested_by`, so the person who set the standing order up is barred from
 * being the second pair of eyes on the payments it raises. Nothing here
 * arranges that. It falls out of using the one path.
 * ============================================================================
 *
 * ─── WHY THIS IS EXACTLY-ONCE ───────────────────────────────────────────────
 *
 * The unit is the OCCURRENCE — one (standing order, scheduled date) pair.
 * "Fires once" is meaningless said of a monthly mandate, which is supposed to
 * fire twelve times a year.
 *
 * AT MOST ONCE, THE CLAIM. Each occurrence is processed inside one transaction
 * that opens by taking `lock_standing_order()` — `SELECT … FOR UPDATE` on the
 * mandate row, through the SECURITY DEFINER function in migration 0012 §11,
 * because `corgi_app` holds no UPDATE on that table and therefore cannot write
 * `FOR UPDATE` itself. Two concurrent runs serialise there. The second one
 * then finds the occurrence already claimed and the outcome already recorded,
 * and does nothing.
 *
 * AT LEAST ONCE, THE EFFECT — AND THE EFFECT IS IDEMPOTENT. The lock is a
 * liveness device: a crashed process releases it. So it is deliberately NOT
 * what makes this safe. What makes it safe is that the idempotency key handed
 * to `requestPayment()` is
 *
 *     standing:<standing order id>:<YYYY-MM-DD>
 *
 * derived by Postgres in a GENERATED ALWAYS column from the two source facts
 * that identify the occurrence, never from a uuid this process generated. It
 * lands on `payment_instruction.idempotency_key`, which is UNIQUE. A second
 * fire — from a retry, a restart, a duplicated cron, a second region — is
 * refused by that index, and `requestPayment()` returns the ORIGINAL
 * instruction. Two runs that both get all the way through raise one payment
 * because the database says so, not because the scheduler behaved.
 *
 * ─── WHY THE CLAIM AND THE INSTRUCTION ARE IN DIFFERENT TRANSACTIONS ────────
 *
 * `requestPayment()` opens its own transaction, so it is called on the pooled
 * handle rather than inside ours. That is not a wart, it is the crash-safe
 * ordering, and it is worth being precise about which way round it fails:
 *
 *   - die AFTER the instruction commits and BEFORE our transaction does:
 *     the claim rolls back with it. The next run re-derives the same key,
 *     `instructionForKey()` finds the instruction that already exists, and the
 *     occurrence is recorded as `raised` citing it. One payment.
 *   - die AFTER our transaction commits: there is nothing left to do.
 *
 * There is no ordering in which two instructions exist, because there is no
 * ordering in which the key differs.
 *
 * ─── WHAT IS DELIBERATELY LEFT UNDECIDED ────────────────────────────────────
 *
 * Two `requestPayment()` failures are facts about the SYSTEM rather than about
 * the payment: `POLICY_MISSING` (nobody wrote an approval policy for this rail)
 * and `UNAVAILABLE` (the database went away). Recording either as a refusal
 * would permanently kill a real payment because of a transient condition. So
 * the occurrence is committed CLAIMED AND UNDECIDED, which is a queryable
 * state — `v_standing_order_unresolved` — and re-driven on the next tick,
 * where the derived key makes the retry free. A row that is visibly stuck
 * beats a row that quietly decided the wrong thing.
 */

import "server-only";

import { requestPayment } from "@/lib/approvals/instructions";
import { availableBalance } from "@/lib/ledger/balances";
import { sql, type Sql } from "@/lib/ledger/db";
import { logger, type Logger } from "@/lib/log";
import { isErr } from "@/lib/result";

import {
  bookToday,
  claimOccurrence,
  instructionForKey,
  listDue,
  lockStandingOrder,
  outcomeFor,
  recordOutcome,
  type DueItem,
} from "./store";
import {
  DEFERRABLE_CODES,
  INSUFFICIENT_FUNDS_CODE,
  INVALID_DESTINATION_CODE,
  STALE_OCCURRENCE_CODE,
  UNSCOPED_ACCOUNT_CODE,
  decideFreshness,
  decideFunding,
  standingOrderDestinationSchema,
  type AvailabilitySnapshot,
  type OccurrenceReport,
  type StandingOrderDestination,
  type StandingRunResult,
} from "./types";

/**
 * How many occurrences one tick will process.
 *
 * Bounded because a serverless invocation has to finish. Anything left over is
 * still owed, is still generated by `standing_order_due_dates()`, and is picked
 * up by the next tick — the queue is derived from the calendar, so nothing
 * needs to be remembered between runs for that to work.
 */
export const DEFAULT_RUN_LIMIT = 200;

export type StandingRunOptions = {
  /** Overrides the book date. Tests only; production asks the database. */
  readonly bookDate?: string;
  readonly limit?: number;
  readonly runId?: string;
  readonly logger?: Logger;
};

/** `standing-1757548800000-9f3c1a`. Recorded on every row this run writes. */
function newRunId(): string {
  return `standing-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
}

/* -------------------------------------------------------------------------- */
/* One occurrence                                                             */
/* -------------------------------------------------------------------------- */

type Decision =
  | { readonly kind: "raise"; readonly destination: StandingOrderDestination }
  | {
      readonly kind: "refuse";
      readonly code: string;
      readonly reason: string;
      readonly shortfallCents?: bigint;
    };

/**
 * Everything that can stop a scheduled payment, in the order it must be asked.
 *
 * The ordering is load-bearing in one place: FRESHNESS IS ASKED BEFORE FUNDING.
 * A three-week-old occurrence is refused for being three weeks old whether or
 * not the money is there, because "the scheduler was down and has now woken up
 * with a fortnight of rent to pay" is a conversation, not an automatic debit.
 * Asking funding first would let a well-funded account absorb the whole backlog
 * silently, which is the exact 3am surprise the requirement warns about.
 */
function decide(
  item: DueItem,
  bookDate: string,
  availability: AvailabilitySnapshot | null,
): Decision {
  const destination = standingOrderDestinationSchema.safeParse(item.counterparty);
  if (!destination.success) {
    return {
      kind: "refuse",
      code: INVALID_DESTINATION_CODE,
      reason:
        "Refused: the mandate's counterparty no longer describes a payee this bank can pay. " +
        "A standing order is an authority to move money on a schedule with nobody watching, " +
        "so a destination that does not parse is refused rather than interpreted.",
    };
  }

  const freshness = decideFreshness(item.scheduledDate, bookDate);
  if (freshness.kind === "refuse") {
    return { kind: "refuse", code: freshness.code, reason: freshness.reason };
  }

  if (availability === null) {
    return {
      kind: "refuse",
      code: UNSCOPED_ACCOUNT_CODE,
      reason:
        "Refused: this mandate's account belongs to no business, so there is no available " +
        "balance to check it against. A payment that cannot be funds-checked is not raised.",
    };
  }

  const funding = decideFunding(item.amountCents, availability);
  if (funding.kind === "refuse") {
    return {
      kind: "refuse",
      code: funding.code,
      reason: funding.reason,
      shortfallCents: funding.shortfallCents,
    };
  }

  return { kind: "raise", destination: destination.data };
}

function reportOf(
  item: DueItem,
  base: {
    readonly occurrenceId: string;
    readonly idempotencyKey: string;
    readonly claimedNow: boolean;
  },
  rest: Pick<
    OccurrenceReport,
    "action" | "instructionId" | "replayed" | "code" | "reason" | "availability"
  >,
): OccurrenceReport {
  return {
    standingOrderId: item.standingOrderId,
    reference: item.reference,
    scheduledDate: item.scheduledDate,
    occurrenceId: base.occurrenceId,
    idempotencyKey: base.idempotencyKey,
    claimedNow: base.claimedNow,
    amountCents: item.amountCents,
    ...rest,
  };
}

/**
 * Process exactly one occurrence.
 *
 * The whole of it runs inside one transaction holding the mandate's row lock,
 * with a single deliberate exception: `requestPayment()` is called on the
 * pooled handle and commits independently. See the header for why that
 * ordering is the crash-safe one.
 */
async function fireOne(
  item: DueItem,
  ctx: { readonly bookDate: string; readonly runId: string; readonly log: Logger },
): Promise<OccurrenceReport> {
  return await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    // 1. Serialise every processor of THIS mandate. Held to commit.
    await lockStandingOrder(item.standingOrderId, tx);

    // 2. The claim. At most one row can exist per (order, date); the unique
    //    constraint decides, and there is no SELECT-then-INSERT to race.
    const claim = await claimOccurrence(
      {
        standingOrderId: item.standingOrderId,
        scheduledDate: item.scheduledDate,
        runId: ctx.runId,
      },
      tx,
    );

    // 3. Already decided? Then this is a duplicate tick, and the honest report
    //    is what the database already holds — not a second decision.
    const settled = await outcomeFor(claim.occurrenceId, tx);
    if (settled !== null) {
      return reportOf(item, claim, {
        action: settled.disposition,
        instructionId: settled.instructionId,
        replayed: true,
        code: null,
        reason: null,
        availability: null,
      });
    }

    // 4. RECOVERY, AND IT IS ASKED BEFORE THE MONEY QUESTION.
    //
    //    If a previous attempt raised the instruction and died before writing
    //    the outcome, the funding decision has already been made and acted on.
    //    Re-asking it against today's balance could refuse a payment that is
    //    sitting in the approvals queue right now — the row would say refused
    //    and the queue would say pending, and both would be citing the same
    //    occurrence. So: if the derived key already names an instruction, this
    //    occurrence raised it, and the only thing left is to say so.
    const existing = await instructionForKey(claim.idempotencyKey, tx);
    if (existing !== null) {
      await recordOutcome(
        { occurrenceId: claim.occurrenceId, runId: ctx.runId, disposition: "raised", instructionId: existing },
        tx,
      );
      return reportOf(item, claim, {
        action: "raised",
        instructionId: existing,
        replayed: true,
        code: null,
        reason: null,
        availability: null,
      });
    }

    // 5. THE MONEY QUESTION, ASKED OF AVAILABLE AND NOT OF THE LEDGER.
    //
    //    `availableBalance()` = ledger − active holds − uncleared credits
    //    − committed outflows (migration 0022).
    //    A $50 fuel-pump authorisation is money the customer has already
    //    committed; an ACH credit that has not cleared can still be pulled
    //    back. Paying rent out of either is lending, and this is a current
    //    account. All four figures are carried onto the outcome row so the
    //    screen can show the case that matters: LEDGER SUFFICIENT, AVAILABLE
    //    NOT.
    const availability =
      item.businessId === null ? null : await availableBalance(item.businessId, tx);

    const decision = decide(item, ctx.bookDate, availability);

    if (decision.kind === "refuse") {
      await recordOutcome(
        {
          occurrenceId: claim.occurrenceId,
          runId: ctx.runId,
          disposition: "refused",
          code: decision.code,
          reason: decision.reason,
          ...(availability === null
            ? {}
            : {
                ledgerCents: availability.ledgerCents,
                holdsCents: availability.holdsCents,
                unclearedCents: availability.unclearedCents,
                availableCents: availability.availableCents,
              }),
          ...(decision.shortfallCents === undefined
            ? {}
            : { shortfallCents: decision.shortfallCents }),
        },
        tx,
      );
      ctx.log.info("standing.refused", {
        occurrenceId: claim.occurrenceId,
        idempotencyKey: claim.idempotencyKey,
        code: decision.code,
        amountCents: item.amountCents,
        ledgerCents: availability?.ledgerCents ?? null,
        availableCents: availability?.availableCents ?? null,
      });
      return reportOf(item, claim, {
        action: "refused",
        instructionId: null,
        replayed: false,
        code: decision.code,
        reason: decision.reason,
        availability,
      });
    }

    // 6. Raise it — through the one path, on the pooled handle, with the key
    //    the database derived. Nothing here computes that string.
    const raised = await requestPayment({
      accountId: item.accountId,
      rail: item.rail,
      amountCents: item.amountCents,
      currency: "USD",
      destination: decision.destination,
      valueDate: item.scheduledDate,
      requestedByActorId: item.createdByActorId,
      idempotencyKey: claim.idempotencyKey,
    });

    if (isErr(raised)) {
      if (DEFERRABLE_CODES.has(raised.error.code)) {
        // Committed claimed-and-undecided, on purpose. Visible in
        // v_standing_order_unresolved; re-driven next tick.
        ctx.log.warn("standing.deferred", {
          occurrenceId: claim.occurrenceId,
          idempotencyKey: claim.idempotencyKey,
          code: raised.error.code,
        });
        return reportOf(item, claim, {
          action: "deferred",
          instructionId: null,
          replayed: false,
          code: raised.error.code,
          reason: raised.error.message,
          availability,
        });
      }

      // Everything else — a KYB gate that says no, a destination the schema
      // refuses — is a fact about THIS payment, and closing the occurrence
      // with it is the honest record.
      await recordOutcome(
        {
          occurrenceId: claim.occurrenceId,
          runId: ctx.runId,
          disposition: "refused",
          code: raised.error.code,
          reason: raised.error.message,
          ...(availability === null
            ? {}
            : {
                ledgerCents: availability.ledgerCents,
                holdsCents: availability.holdsCents,
                unclearedCents: availability.unclearedCents,
                availableCents: availability.availableCents,
              }),
        },
        tx,
      );
      return reportOf(item, claim, {
        action: "refused",
        instructionId: null,
        replayed: false,
        code: raised.error.code,
        reason: raised.error.message,
        availability,
      });
    }

    await recordOutcome(
      {
        occurrenceId: claim.occurrenceId,
        runId: ctx.runId,
        disposition: "raised",
        instructionId: raised.value.instructionId,
      },
      tx,
    );

    ctx.log.info("standing.raised", {
      occurrenceId: claim.occurrenceId,
      idempotencyKey: claim.idempotencyKey,
      instructionId: raised.value.instructionId,
      // False means the unique index refused a second instruction and handed
      // back the first. That is the exactly-once guarantee firing.
      createdNow: raised.value.created,
      amountCents: item.amountCents,
      approvalsRequired: raised.value.approvalsRequired,
    });

    return reportOf(item, claim, {
      action: "raised",
      instructionId: raised.value.instructionId,
      replayed: !raised.value.created,
      code: null,
      reason: null,
      availability,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fire everything owed and not yet decided.
 *
 * Sequential rather than concurrent, on purpose. The occurrences of one mandate
 * would contend on the same row lock anyway, the work is tiny, and a serverless
 * function with a pool of five is not the place to fan out database
 * transactions that each hold a lock across a second connection's round trip.
 *
 * One occurrence that throws does not stop the tick. It is logged with its ids
 * and reported as `deferred`, its transaction is rolled back — so the claim
 * goes with it — and the next tick re-derives the same date from the calendar.
 */
export async function runStandingOrders(
  options: StandingRunOptions = {},
): Promise<StandingRunResult> {
  const started = Date.now();
  const runId = options.runId ?? newRunId();
  const log = (options.logger ?? logger({ requestId: runId })).child({ runId });

  const bookDate = options.bookDate ?? (await bookToday());
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RUN_LIMIT, 1), 1000);

  const due = await listDue(bookDate, limit);
  const occurrences: OccurrenceReport[] = [];

  for (const item of due) {
    try {
      occurrences.push(await fireOne(item, { bookDate, runId, log }));
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : "the occurrence could not be processed";
      log.error("standing.failed", {
        standingOrderId: item.standingOrderId,
        scheduledDate: item.scheduledDate,
        error: thrown,
      });
      occurrences.push({
        standingOrderId: item.standingOrderId,
        reference: item.reference,
        scheduledDate: item.scheduledDate,
        // The transaction rolled back, so no occurrence row exists to name.
        // The empty string says that rather than inventing an id.
        occurrenceId: item.occurrenceId ?? "",
        idempotencyKey: item.idempotencyKey ?? "",
        claimedNow: false,
        action: "deferred",
        instructionId: null,
        replayed: false,
        code: "OCCURRENCE_FAILED",
        reason: message,
        amountCents: item.amountCents,
        availability: null,
      });
    }
  }

  const result: StandingRunResult = {
    runId,
    asOf: new Date(started).toISOString(),
    bookDate,
    considered: due.length,
    raised: occurrences.filter((o) => o.action === "raised").length,
    refused: occurrences.filter((o) => o.action === "refused").length,
    deferred: occurrences.filter((o) => o.action === "deferred").length,
    occurrences,
    durationMs: Date.now() - started,
  };

  log.info("standing.complete", {
    bookDate,
    considered: result.considered,
    raised: result.raised,
    refused: result.refused,
    deferred: result.deferred,
    durationMs: result.durationMs,
  });

  return result;
}

/** Re-exported so the route and the tests have one import for the run. */
export { INSUFFICIENT_FUNDS_CODE, STALE_OCCURRENCE_CODE };
