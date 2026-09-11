/**
 * The memo hold an approved payment places, and the two ways it comes off.
 *
 * ── THE DEFECT THIS CLOSES, MEASURED ────────────────────────────────────────
 *
 * `releasePayment()` posted money with NO availability check at all. The
 * `availableCents` comparison lived only at REQUEST time
 * (`src/lib/mcp/tool-initiate-payment.ts:379`) and never ran again, so an
 * approved instruction was an unreserved claim on a balance anything else was
 * free to spend. Against the live book, in a rolled-back transaction:
 *
 *     AVAILABLE $25,000.92 → request $20,000.00 → approve ×2
 *     AFTER     available $25,000.92                      ← UNMOVED
 *     DRAIN     $24,000.00 leaves by another path
 *     RELEASE   POSTS. ledger −$18,999.08
 *
 * One person, no concurrency needed: request, wait, release.
 *
 * ── IT REUSES THE HOLD MODEL RATHER THAN INVENTING A RESERVATION ────────────
 *
 * An approved payment is an ordinary `hold` row of kind `manual`, its memo
 * posting goes through `postEntry()` → `ledger_append()` like every other
 * posting, and `ledger_availability()` — the ONE definition of available
 * balance, five terms, migration 0022 — picks it up through its EXISTING hold
 * term with no change to how that term is computed. Nothing here computes an
 * availability of its own, and migration 0061 does not touch that function. A
 * second way to withhold money would be a sixth definition of available
 * balance, which is the defect 0022 exists to have ended. This is 0053's shape
 * for FX commitments, one morning later, for the same class of defect.
 *
 * ── WHY THE CHECK IS AT APPROVAL AND NOT AT RELEASE ─────────────────────────
 *
 * Refusing at release refuses after the money was promised: the checker has
 * signed, the beneficiary has been told, and the only thing the system can say
 * is no — while the balance sat unreserved the whole time, so the refusal is
 * not even reliable (the drain could land a second later). A hold placed when
 * the approval that COMPLETES THE POLICY lands withholds the money from that
 * instant, and the drain is what gets refused. The decision that commits the
 * money is the one that must be able to say "not enough".
 *
 * ── CLOSED vs TERMINALLY CLOSED, WHICH DECIDES WHETHER A ROW IS WRITTEN ─────
 *
 * `src/lib/holds/model.ts` draws the distinction and migrations 0011 and 0028
 * both paid for getting it wrong: only the MONOTONE subset of "closed" may
 * write the APPEND-ONLY `hold_closure` row, because that row cannot be
 * unwritten. This hold comes off on exactly two facts, and both are terminal
 * by the same trigger — `assert_payment_lifecycle()` allows nothing after
 * either, `payment_instruction_event` is append-only (0001 §13), so each is an
 * EXISTS over a growing set and an EXISTS never un-fires:
 *
 *   RELEASED   `releasePayment()` posted the FINANCIAL debit in the same
 *              transaction. The money is no longer promised, it is gone.
 *              `source = 'payment_release'`. A later `returned` or `failed` is
 *              a new money movement with its own posting, not an edit to this
 *              one, so it does not reopen the hold.
 *   WITHDRAWN  `rejected` or `cancelled`. Nothing follows either in the state
 *              machine, so the promise is off and the money must stop being
 *              withheld at once. `source = 'payment_withdrawn'`.
 *
 * NO CLOCK. `hold.available_at` is left NULL deliberately: an approved payment
 * has no deadline of its own — nothing in this system expires an approval — so
 * a clock here would free a customer's committed money at an instant no policy
 * names. 0053 could derive a lapse because the settlement window is printed on
 * the offer; there is no such number here, so the hold comes off only on a
 * fact.
 */

import "server-only";

import { closeHold, houseAccountId, memoHoldBalance, MEMO_CONTRA_CODE } from "@/lib/holds/store";
import { readAccountIdentity } from "@/lib/ledger/readers";
import { accountAvailability, readSnapshot } from "@/lib/ledger/balance-definitions";
import { type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { resolveChartCodes } from "@/lib/ledger/readers";

import type { QueuedPayment } from "./types";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The memo leaf an approved payment's hold is credited to. `9400`, created by
 * migration 0061, a sibling of 9100/9200/9300.
 *
 * A HOUSE account, and the trade-off is argued in 0061 §1: both `v_hold_state`
 * and `ledger_availability()` read a hold's memo balance keyed on the HOLD
 * (`e.hold_id = h.id AND l.account_id = h.memo_account_id`), never on the
 * account alone, so two customers' holds sharing one leaf cannot contaminate
 * each other's availability. What is lost is a statement line, not a number.
 */
export const RELEASE_HOLD_MEMO_CODE = "9400";

/** The customer's own deposit leaf. An approval holds against this and nothing else. */
export const CUSTOMER_DEPOSIT_CODE = "2100";

/**
 * `hold.external_ref`, which is half of `hold_ref UNIQUE (kind, external_ref)`.
 *
 * That index is what makes placing the hold once-only BY CONSTRUCTION rather
 * than by a check this module performs. It is deliberately NOT what any guard
 * joins on — migration 0040 is fifty lines on what happens when an invariant
 * discriminates on a string instead of a foreign key — so
 * `payment_release_hold` carries the binding and this carries the label.
 */
export function releaseHoldExternalRef(instructionId: string): string {
  return `payment:${instructionId}`;
}

/** The idempotency key of the memo posting that OPENS an approval hold. */
export function releaseHoldOpenKey(instructionId: string): string {
  return `payment-hold:${instructionId}:open`;
}

/** The idempotency key of the memo posting that RELEASES one. */
export function releaseHoldCloseKey(
  instructionId: string,
  reason: "released" | "withdrawn",
): string {
  return `payment-hold:${instructionId}:close:${reason}`;
}

/**
 * The refusal an approval gets when the money is not there.
 *
 * IT IS THROWN, NOT RETURNED, and that is the whole reason this type exists.
 * The `approved` event is inserted one statement earlier in the SAME
 * transaction — 0061 §2's trigger refuses a hold for an instruction nobody has
 * approved, which is what makes "a hold implies an approval" a constraint
 * rather than a calling convention — so the only honest undo for an approval
 * whose money is not there is never to have written it. Returning a value from
 * a `sql.begin()` callback COMMITS; throwing rolls back. `decide.ts` catches
 * this one shape and turns it into a `Result` refusal.
 */
export class InsufficientFundsToApprove extends Error {
  readonly availableCents: bigint;
  readonly amountCents: bigint;
  constructor(message: string, availableCents: bigint, amountCents: bigint) {
    super(message);
    this.name = "InsufficientFundsToApprove";
    this.availableCents = availableCents;
    this.amountCents = amountCents;
  }
}

/** A dollar figure for a refusal message. Integer arithmetic, no `toFixed`. */
function usd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Serialise every approval against one deposit account, for the life of this
 * transaction.
 *
 * WITHOUT THIS THE FUNDS CHECK IS DECORATION: two approvals racing on one
 * balance both read the same availability, both find it sufficient, and both
 * commit. A `SELECT … FOR UPDATE` on the account row is not available —
 * Postgres wants the UPDATE privilege for a row lock and `corgi_app`
 * deliberately holds none on `account` — so an advisory lock keyed on the
 * deposit account, taken BEFORE the read and released at COMMIT.
 *
 * LOCK ORDER. `ledger_append()` takes `pg_advisory_xact_lock(hashtext(
 * 'ledger_append:' || entity))` and `src/lib/fx/hold.ts` takes
 * `fx_commitment:<account>`. This path takes its own namespace first and the
 * ledger's second, exactly as the FX path does, so the two are always acquired
 * in the same order and there is no cycle to close.
 */
async function lockAccountApprovals(depositAccountId: string, conn: Sql): Promise<void> {
  await conn`SELECT pg_advisory_xact_lock(hashtextextended(${`payment_hold:${depositAccountId}`}, 0))`;
}

export interface ReleaseHoldAccounts {
  readonly depositAccountId: string;
  readonly memoAccountId: string;
  readonly entityId: string;
  readonly valueDate: string;
}

export interface PlacedReleaseHold {
  readonly holdId: string;
  readonly memoEntryId: string;
  readonly withheldCents: bigint;
  readonly availableBeforeCents: bigint;
}

/**
 * The customer's deposit leaf, the memo leaf, the entity and the business day.
 *
 * THROUGH THE LEDGER'S OWN NAMED READERS, not through SQL of this module's
 * own: `resolveChartCodes()` answers "which account is 9400 for this entity"
 * in one round trip and `readSnapshot()` answers "which business day is it"
 * from the database's `book_date()`. That boundary is what keeps one answer to
 * "which account is 2100" — `src/lib/ledger/boundary.test.ts` enforces it.
 */
async function resolveHoldAccounts(
  args: { readonly accountId: string; readonly entityId: string; readonly businessId: string },
  conn: Sql,
): Promise<ReleaseHoldAccounts | null> {
  const [chart, snapshot] = await Promise.all([
    resolveChartCodes(
      {
        entityId: args.entityId,
        businessId: args.businessId,
        houseCodes: [RELEASE_HOLD_MEMO_CODE],
        businessCodes: [],
      },
      conn,
    ),
    readSnapshot(conn),
  ]);
  const memo = chart.get(RELEASE_HOLD_MEMO_CODE);
  if (memo === undefined) return null;
  return {
    depositAccountId: args.accountId,
    memoAccountId: memo.accountId,
    entityId: args.entityId,
    valueDate: snapshot.valueDate,
  };
}

/**
 * Withhold an approved payment's amount. Called immediately after the
 * `approved` event that completed the instruction's policy lands, in the same
 * transaction.
 *
 * THE LOCK IS TAKEN BEFORE THE READ and held to commit, so the availability
 * this acts on is still true when the hold is posted.
 *
 * THE LIVE WATERMARK HAS NO TIME PREDICATE, which `readSnapshot()` documents
 * and this path depends on: `now()` inside a transaction is the transaction's
 * START while `ledger_append()` stamps `booking_time` from `clock_timestamp()`,
 * so a time-filtered watermark would make this read blind to a hold posted a
 * statement earlier in the same transaction — the original bug in a hat.
 *
 * Throws `InsufficientFundsToApprove` when the money is not there. See that
 * class for why it throws instead of returning.
 */
export async function placeApprovalHold(
  payment: QueuedPayment,
  args: { readonly entityId: string; readonly businessId: string; readonly actorId: string },
  conn: Sql,
): Promise<PlacedReleaseHold | null> {
  const { instruction } = payment;
  const accounts = await resolveHoldAccounts(
    { accountId: instruction.accountId, entityId: args.entityId, businessId: args.businessId },
    conn,
  );
  if (accounts === null) {
    throw new Error(
      `the chart has no ${RELEASE_HOLD_MEMO_CODE} memo account on this entity, so an approved ` +
        "payment cannot be withheld and the approval was not recorded",
    );
  }

  await lockAccountApprovals(accounts.depositAccountId, conn);

  // ALREADY WITHHELD, so there is nothing to do and nothing to check.
  // A 2-of-3 policy calls this on every approval past the threshold, and a
  // second availability check would compare the balance against a hold THIS
  // INSTRUCTION already placed and refuse the approval for want of money it
  // is itself withholding.
  const existing = await conn<{ hold_id: string }[]>`
    SELECT hold_id FROM payment_release_hold
     WHERE instruction_id = ${instruction.id}::uuid`;
  if (existing[0] !== undefined) return null;

  const snapshot = await readSnapshot(conn);
  const availability = await accountAvailability(accounts.depositAccountId, snapshot, conn);
  const available = availability.availableCents;

  if (available < instruction.amountCents) {
    throw new InsufficientFundsToApprove(
      `Approving this payment would commit ${usd(instruction.amountCents)} and only ` +
        `${usd(available)} is available, so the approval was refused and nothing was written — ` +
        "no approval, no hold, nothing posted. An approved payment reserves the money it will " +
        "release, which is why an earlier approval still awaiting release reduces what is " +
        "available here. Fund the account, or release or withdraw an approved payment already " +
        "standing, and approve again.",
      available,
      instruction.amountCents,
    );
  }

  // `hold_ref UNIQUE (kind, external_ref)` decides, not this INSERT: two
  // approvers racing the final approval produce one hold row, and the loser's
  // `payment_release_hold` INSERT has already lost to its PRIMARY KEY.
  //
  // `available_at` IS NULL ON PURPOSE — see the header. An approval has no
  // clock, so this hold is released only by a `hold_closure` row.
  const holds = await conn<{ id: string }[]>`
    INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, available_at)
    VALUES (${accounts.depositAccountId}::uuid,
            ${accounts.memoAccountId}::uuid,
            'manual',
            ${releaseHoldExternalRef(instruction.id)},
            ${accounts.valueDate}::date,
            NULL)
    ON CONFLICT (kind, external_ref) DO NOTHING
    RETURNING id`;
  const placed = holds[0];
  if (placed === undefined) {
    // Someone else placed it in a transaction that has already committed. The
    // money is withheld either way, which is the invariant; nothing to do.
    return null;
  }
  const holdId = placed.id;

  await conn`
    INSERT INTO payment_release_hold (instruction_id, hold_id, amount_cents, placed_by)
    VALUES (${instruction.id}::uuid, ${holdId}::uuid, ${instruction.amountCents}, ${args.actorId}::uuid)`;

  const contraId = await houseAccountId(MEMO_CONTRA_CODE, accounts.entityId, conn);

  const memoEntryId = await postEntry(
    {
      entityId: accounts.entityId,
      valueDate: accounts.valueDate,
      book: "memo",
      description:
        `Payment ${instruction.id} approved — ${usd(instruction.amountCents)} withheld until ` +
        "it is released or withdrawn",
      idempotencyKey: releaseHoldOpenKey(instruction.id),
      actorId: args.actorId,
      rail: instruction.rail,
      externalRef: instruction.idempotencyKey,
      holdId,
      lines: [
        // Credit the memo leaf: more held is a bigger obligation, and the leaf
        // is credit-normal, so a POSITIVE hold is a NEGATIVE amount_cents.
        { accountId: accounts.memoAccountId, amountCents: -instruction.amountCents },
        // Debit the contra, so the memo book nets to zero on its own.
        { accountId: contraId, amountCents: instruction.amountCents },
      ],
    },
    conn,
  );

  return {
    holdId,
    memoEntryId,
    withheldCents: instruction.amountCents,
    availableBeforeCents: available,
  };
}

export interface ReleasedApprovalHold {
  readonly holdId: string | null;
  readonly closurePosted: boolean;
  readonly releasedCents: bigint;
  readonly entryId: string | null;
}

/**
 * Take the hold off, on one of the two terminal facts.
 *
 * Called INSIDE the transaction that writes that fact, so the closure and the
 * fact commit together or not at all. Both the closure row and the memo
 * reversal are idempotent — `hold_closure`'s PRIMARY KEY is `hold_id`, and the
 * memo posting's idempotency key is derived from the instruction — so a replay
 * appends nothing.
 *
 * The amount is the MEMO BOOK'S OWN BALANCE read inside the transaction, via
 * `memoHoldBalance()`, which is the reader `apply.ts` uses for exactly this
 * sum. That is what keeps one answer to "what is this hold withholding".
 */
export async function closeApprovalHold(
  args: {
    readonly instructionId: string;
    readonly actorId: string;
    readonly reason: "released" | "withdrawn";
    readonly note: string;
  },
  conn: Sql,
): Promise<ReleasedApprovalHold> {
  // The entity comes off a NAMED READER, not off an `account` join.
  //
  // `boundary.test.ts` counts the modules that may touch `account` directly and
  // this is not one of them. 0053's FX hold learned the same thing an hour
  // earlier and took its entity off `fx_quote.entity_id` for the same reason:
  // the join was there to fetch one column, and fetching one column is what a
  // reader is for.
  const rows = await conn<
    { hold_id: string; memo_account_id: string; account_id: string; value_date: string }[]
  >`
    SELECT prh.hold_id, h.memo_account_id, h.account_id,
           to_char(h.value_date, 'YYYY-MM-DD') AS value_date
      FROM payment_release_hold prh
      JOIN hold h ON h.id = prh.hold_id
     WHERE prh.instruction_id = ${args.instructionId}::uuid`;
  const row = rows[0];
  if (row === undefined) {
    // An instruction approved before migration 0061's regime instant holds
    // nothing. There is no hold to take off and that is not an error — it is
    // the honest scope of a new control, counted by v_payment_release_census.
    return { holdId: null, closurePosted: false, releasedCents: 0n, entryId: null };
  }

  const identity = await readAccountIdentity(row.account_id, conn);
  if (identity === null) {
    // Fail closed. The hold names an account the chart cannot resolve, which
    // is not a state this book can be in — refusing is the only honest move,
    // because posting the closure would free money against an account nobody
    // can identify.
    throw new Error(
      `PAYMENT_HOLD_ACCOUNT_UNRESOLVED: hold ${row.hold_id} names account ` +
        `${row.account_id}, which the chart does not resolve. No closure was posted.`,
    );
  }

  const memoCents = await memoHoldBalance(row.hold_id, row.memo_account_id, conn);

  const closurePosted = await closeHold(
    row.hold_id,
    args.note,
    args.actorId,
    conn,
    // Declared, so `v_hold_closure_census` can count it by construction rather
    // than by matching English against `reason` — migration 0040's whole point.
    (args.reason === "released" ? "payment_release" : "payment_withdrawn") as never,
  );

  if (memoCents === 0n) {
    return { holdId: row.hold_id, closurePosted, releasedCents: 0n, entryId: null };
  }

  const contraId = await houseAccountId(MEMO_CONTRA_CODE, identity.entityId, conn);
  const { valueDate } = await readSnapshot(conn);

  const entryId = await postEntry(
    {
      entityId: identity.entityId,
      valueDate,
      book: "memo",
      description:
        args.reason === "released"
          ? `Payment ${args.instructionId} released — the hold its approval placed comes off`
          : `Payment ${args.instructionId} withdrawn — the hold its approval placed comes off`,
      idempotencyKey: releaseHoldCloseKey(args.instructionId, args.reason),
      actorId: args.actorId,
      holdId: row.hold_id,
      lines: [
        // Debit the memo leaf back down to zero. Credit-normal, so giving the
        // money back is a POSITIVE amount_cents.
        { accountId: row.memo_account_id, amountCents: memoCents },
        { accountId: contraId, amountCents: -memoCents },
      ],
    },
    conn,
  );

  return { holdId: row.hold_id, closurePosted, releasedCents: memoCents, entryId };
}
