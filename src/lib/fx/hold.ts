/**
 * The memo hold an accepted FX quote places, and the two ways it comes off.
 *
 * ── THE DEFECT THIS CLOSES, MEASURED ────────────────────────────────────────
 *
 * Before this module, `acceptQuote()` wrote one row in `fx_quote_acceptance`
 * and reserved nothing. Against the live book, in a rolled-back transaction:
 *
 *     AVAILABLE $35,514.93 → accept FXQ-2896RMDZ ($21,308.95)
 *                          → accept FXQ-0BF9XKXM ($21,308.95)
 *     AFTER     available $35,514.93                      ← UNMOVED
 *     GATE 1    CLEARS     GATE 2    CLEARS
 *     TOTAL     $42,617.90 cleared against $35,514.93 available
 *
 * Both commitments would later settle, both would debit the same 2100 leaf,
 * and nothing between acceptance and settlement reserved a cent. docs/FX.md §6
 * and §11.2 both named this and neither closed it.
 *
 * ── IT REUSES THE HOLD MODEL RATHER THAN INVENTING A RESERVATION ────────────
 *
 * An accepted commitment is an ordinary `hold` row of kind `manual`, its memo
 * posting goes through `postEntry()` → `ledger_append()` like every other
 * posting, and `ledger_availability()` — the ONE definition of available
 * balance, five terms, migration 0022 — picks it up through its existing hold
 * term with no change to how that term is computed. Nothing here computes an
 * availability of its own. A second way to withhold money would be a sixth
 * definition of available balance, which is exactly the defect 0022 exists to
 * have ended.
 *
 * ── CLOSED vs TERMINALLY CLOSED, WHICH DECIDES WHETHER A ROW IS WRITTEN ─────
 *
 * `src/lib/holds/model.ts` draws the distinction and migrations 0011 and 0028
 * both paid for getting it wrong: `closed(E)` frees the money, and only the
 * MONOTONE subset of it — `terminallyClosed` — may write the APPEND-ONLY
 * `hold_closure` row, because that row cannot be unwritten. A commitment hold
 * comes off in exactly two ways and only one of them writes a row.
 *
 *   SETTLED — `fx_quote_settlement` has a row for this quote. TERMINAL.
 *      `quote_id` is that table's PRIMARY KEY and the table is append-only at
 *      both layers (0017 §7), so this is an EXISTS over a growing set and an
 *      EXISTS never un-fires. The payout happened, the financial book moved,
 *      and the reason the money was freed will still be true for ever. It gets
 *      the `hold_closure` row, `source = 'fx_settlement'`.
 *
 *   LAPSED — `now() >= accepted_at + settlement_window_seconds`. NOT TERMINAL,
 *      and this is the one worth reading twice. The clock itself is monotone,
 *      so monotonicity is not the objection — `expired` is monotone in the card
 *      model and does write a row. The objection is that the row is a
 *      PERMANENT CLAIM ABOUT WHY, and that claim can be overtaken:
 *      `./settle.ts` says in terms that a LAPSED commitment still posts on the
 *      `--settle` recovery path, because the USDC may already have left before
 *      anybody noticed the window had closed. A closure row written by the
 *      clock would then stand for ever saying the hold was released because
 *      the customer ran out of time, on a commitment that in fact settled —
 *      a false permanent record, in the one book that exists to be trusted,
 *      and not erasable: the correction to an append-only row is another row
 *      (`hold_closure_reversal`), so the audit trail becomes three rows saying
 *      what one row should have said.
 *
 *      So the lapse frees the money FROM THE CLOCK, derived, at the
 *      parameterised instant, writing nothing — `hold.available_at` carries
 *      `settle_by` and migration 0053 §3 generalised the release arm in
 *      `v_hold_state` and `ledger_availability()` from "an uncleared credit
 *      whose availability instant has passed" to "any hold whose own clock has
 *      passed". If the settlement then lands, its closure row is the only
 *      permanent record and it says the true thing.
 *
 * ── WHAT THE SWEEP IS AND IS NOT ────────────────────────────────────────────
 *
 * The clock releases the money on the instant, with nothing running — that is
 * the whole point of a derived release, and it is why the customer is already
 * right. What the clock cannot do is move the MEMO BOOK, so a lapsed
 * commitment leaves a released hold carrying a balance, which is precisely
 * what `v_hold_release_drift` exists to shout about. `sweepLapsedCommitments()`
 * is the bookkeeping that answers it, and it is the same shape as
 * `sweepMaturedUnclearedCredits()` one directory over, for the same reason.
 * It decides nothing: the amount is the memo book's own balance read inside
 * the transaction, the value date is `book_date(available_at)` — the day the
 * WINDOW closed, not the day the sweep happened to run — and the idempotency
 * key is derived from both, so a second run appends nothing.
 */

import "server-only";

import { accountAvailability, readSnapshot } from "@/lib/ledger/balance-definitions";
import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { resolveChartCodes } from "@/lib/ledger/readers";
import { rootLogger } from "@/lib/log";
import {
  closeHold,
  houseAccountId,
  memoHoldBalance,
  MEMO_CONTRA_CODE,
} from "@/lib/holds/store";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The memo leaf a commitment hold is credited to. `9300`, named by
 * docs/FX.md §6 before it existed and created by migration 0053.
 *
 * A HOUSE account, unlike 9100 and 9200, and the trade-off is argued in 0053
 * §1: both `v_hold_state` and `ledger_availability()` read a hold's memo
 * balance keyed on the HOLD (`e.hold_id = h.id AND l.account_id =
 * h.memo_account_id`), never on the account alone, so two customers' holds
 * sharing one leaf cannot contaminate each other's availability. What is lost
 * is a statement line, not a number.
 */
export const FX_COMMITMENT_MEMO_CODE = "9300";

/** The customer's own deposit leaf. A commitment holds against this and nothing else. */
export const CUSTOMER_DEPOSIT_CODE = "2100";

/**
 * `hold.external_ref`, which is half of `hold_ref UNIQUE (kind, external_ref)`.
 *
 * That index is what makes placing the hold once-only BY CONSTRUCTION rather
 * than by a check this module performs — the same argument
 * `ensureAuthorization()` makes about a card authorisation. It is deliberately
 * NOT what any guard joins on: migration 0040 is fifty lines about what
 * happens when an invariant discriminates on a string instead of a foreign
 * key, so `fx_commitment_hold` carries the binding and this carries the label.
 */
export function commitmentExternalRef(quoteRef: string): string {
  return `fx_quote:${quoteRef}`;
}

/** The idempotency key of the memo posting that OPENS a commitment hold. */
export function commitmentOpenKey(quoteId: string): string {
  return `fx-commitment:${quoteId}:open`;
}

/** The idempotency key of the memo posting that RELEASES one. */
export function commitmentReleaseKey(quoteId: string, reason: "settled" | "lapsed"): string {
  return `fx-commitment:${quoteId}:release:${reason}`;
}

/** The sentence written onto the `hold_closure` row at settlement. */
export function commitmentClosureReason(quoteRef: string, txHash: string): string {
  return `FX commitment ${quoteRef} settled by ${txHash}`;
}

/* -------------------------------------------------------------------------- */
/* Placing the hold                                                           */
/* -------------------------------------------------------------------------- */

export interface CommitmentFundsInput {
  readonly quoteRef: string;
  readonly businessId: string;
  readonly entityId: string;
  /** The committed price. Read from `fx_quote`, never from a form. */
  readonly sellCents: bigint;
}

/**
 * What the funds check resolved, handed to `placeCommitmentHold()` so the two
 * halves cannot disagree about which accounts or which business day.
 */
export interface CommitmentReservation {
  readonly depositAccountId: string;
  readonly memoAccountId: string;
  readonly valueDate: string;
  /** `ledger_availability()`'s answer at the instant the lock was held. */
  readonly availableCents: bigint;
}

export interface PlaceCommitmentInput {
  readonly quoteId: string;
  readonly quoteRef: string;
  readonly entityId: string;
  readonly sellCents: bigint;
  readonly actorId: string;
  readonly reservation: CommitmentReservation;
}

export interface PlacedCommitment {
  readonly holdId: string;
  readonly memoEntryId: string;
  readonly withheldCents: bigint;
  readonly availableBeforeCents: bigint;
  readonly settleBy: string;
}

/**
 * Serialise every acceptance for one customer, for the life of this transaction.
 *
 * WITHOUT THIS THE FUNDS CHECK IS DECORATION. Two acceptances racing on one
 * balance both read the same availability, both find it sufficient, and both
 * commit — which is the bug this module exists to close, arriving through a
 * narrower door. A `SELECT ... FOR UPDATE` on the account row is not available:
 * Postgres requires the UPDATE privilege for a row lock and `corgi_app`
 * deliberately holds none on `account` (migration 0008 §2 makes the same point
 * about `card_authorization`).
 *
 * So an advisory lock keyed on the deposit account, in its own namespace,
 * taken BEFORE the read and released at COMMIT.
 *
 * LOCK ORDER, because a second lock in a system that already has one is how
 * deadlocks are made: `ledger_append()` takes
 * `pg_advisory_xact_lock(hashtext('ledger_append:' || entity))`. This path
 * takes THIS lock first and the ledger's second, and no other path takes this
 * one at all — so the two are always acquired in the same order and there is
 * no cycle to close.
 */
async function lockCustomerCommitments(depositAccountId: string, conn: Sql): Promise<void> {
  await conn`SELECT pg_advisory_xact_lock(hashtextextended(${`fx_commitment:${depositAccountId}`}, 0))`;
}

export interface CustomerAccounts {
  readonly depositAccountId: string;
  readonly memoAccountId: string;
  readonly valueDate: string;
}

/**
 * The two accounts and the business day.
 *
 * THROUGH THE LEDGER'S OWN NAMED READERS, not through SQL of this module's
 * own. `resolveChartCodes()` answers "which account is 2100 for this customer
 * and which is 9300 for this entity" in one round trip, and `readSnapshot()`
 * answers "which business day is it" from the database's `book_date()`. Both
 * are the boundary `src/lib/ledger/boundary.test.ts` enforces, and the reason
 * it exists is directly upstream of this file: six modules once carried four
 * different sets of predicates for "which account is 1130", which is four
 * different answers, and this system has already shipped four definitions of
 * available balance that disagreed by $25,040.70.
 *
 * The snapshot is taken INSIDE the caller's transaction and its watermark has
 * no time predicate, which is load-bearing here — see `availableCents()`.
 */
export async function resolveCommitmentAccounts(
  args: { readonly businessId: string; readonly entityId: string },
  conn: Sql,
): Promise<CustomerAccounts | null> {
  const [chart, snapshot] = await Promise.all([
    resolveChartCodes(
      {
        entityId: args.entityId,
        businessId: args.businessId,
        houseCodes: [FX_COMMITMENT_MEMO_CODE],
        businessCodes: [CUSTOMER_DEPOSIT_CODE],
      },
      conn,
    ),
    readSnapshot(conn),
  ]);

  const deposit = chart.get(CUSTOMER_DEPOSIT_CODE);
  const memo = chart.get(FX_COMMITMENT_MEMO_CODE);
  if (deposit === undefined || memo === undefined) return null;

  return {
    depositAccountId: deposit.accountId,
    memoAccountId: memo.accountId,
    valueDate: snapshot.valueDate,
  };
}

/**
 * `ledger_availability()` at the live point, inside this transaction.
 *
 * `accountAvailability(id, await readSnapshot(conn), conn)` — the ledger's own
 * named reader over the ONE definition, never a query of this module's.
 *
 * THE LIVE WATERMARK HAS NO TIME PREDICATE, which `readSnapshot()` documents
 * and this path depends on. `now()` inside a transaction is the transaction's
 * START while `ledger_append()` stamps `booking_time` from
 * `clock_timestamp()`, so a watermark filtered on `booking_time <= now()` read
 * in the transaction that just posted an entry EXCLUDES that entry. This path
 * reads availability immediately after posting a hold — twice, when two quotes
 * are accepted in one transaction — so a time-filtered watermark would make
 * the second acceptance blind to the first one's hold, which is the original
 * bug wearing a different hat.
 */
async function availableCents(depositAccountId: string, conn: Sql): Promise<bigint> {
  const snapshot = await readSnapshot(conn);
  const availability = await accountAvailability(depositAccountId, snapshot, conn);
  return availability.availableCents;
}

/** A dollar figure for a refusal message. Integer arithmetic, no `toFixed`. */
function usd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Can this customer commit this much? Takes the lock, reads availability,
 * WRITES NOTHING.
 *
 * SEPARATE FROM THE PLACING, and the split is the difference between a refusal
 * that wrote nothing and a refusal that has to un-write an acceptance. The
 * acceptance must be inserted BEFORE the hold — `fx_commitment_hold_precondi-
 * tions` (0053 §4) refuses a hold for a quote nobody has accepted, which is
 * what makes "a commitment hold implies a commitment" a constraint rather than
 * a calling convention — so the funds check has to happen before BOTH. An
 * append-only book has no way to take an acceptance back; the only honest undo
 * is never to have written it.
 *
 * THE LOCK IS TAKEN HERE AND HELD TO COMMIT, so the answer this returns is
 * still true when `placeCommitmentHold()` acts on it.
 *
 * Returns a refusal rather than throwing when the money is not there. A
 * customer trying to commit more than they hold has done nothing wrong; they
 * have been told no, with the number and the fix.
 */
export async function checkCommitmentFunds(
  input: CommitmentFundsInput,
  conn: Sql,
): Promise<Result<CommitmentReservation, ErrorShape>> {
  const accounts = await resolveCommitmentAccounts(
    { businessId: input.businessId, entityId: input.entityId },
    conn,
  );
  if (accounts === null) {
    return fail(
      "FX_COMMITMENT_NO_ACCOUNT",
      `That customer has no ${CUSTOMER_DEPOSIT_CODE} deposit account on this entity's chart, or ` +
        `the chart has no ${FX_COMMITMENT_MEMO_CODE} memo account to hold against, so the ` +
        "commitment cannot be withheld and the acceptance was not written. Open the customer's " +
        "accounts on /accounts before quoting them.",
    );
  }

  await lockCustomerCommitments(accounts.depositAccountId, conn);

  const available = await availableCents(accounts.depositAccountId, conn);
  if (available < input.sellCents) {
    return fail(
      "FX_COMMITMENT_EXCEEDS_AVAILABLE",
      `Accepting ${input.quoteRef} would commit ${usd(input.sellCents)} and only ` +
        `${usd(available)} is available, so the commitment was refused and nothing was ` +
        "written — no acceptance, no hold, no rate locked. An accepted quote reserves the " +
        "money it commits, which is why an earlier acceptance still standing reduces what is " +
        "available here. Fund the account, or settle or let lapse a commitment already " +
        "standing, and quote again at /payouts.",
    );
  }

  return ok({ ...accounts, availableCents: available });
}

/**
 * Withhold the committed price. Called immediately after the acceptance row
 * lands, in the same transaction, on a reservation `checkCommitmentFunds()`
 * has already approved under a lock this transaction still holds.
 */
export async function placeCommitmentHold(
  input: PlaceCommitmentInput,
  conn: Sql,
): Promise<PlacedCommitment> {
  const accounts = input.reservation;

  // `hold_ref UNIQUE (kind, external_ref)` decides, not this INSERT: two
  // workers racing one acceptance produce one hold row, and the loser's
  // acceptance INSERT has already lost to `fx_quote_acceptance`'s PRIMARY KEY
  // one statement earlier.
  //
  // `available_at` IS THE SETTLEMENT WINDOW, and it is the whole of the lapse
  // story: migration 0053 §3 releases any hold whose own clock has passed, so
  // this column frees the money on the instant, with nothing running and
  // WITHOUT a permanent closure row. See the header.
  //
  // IT IS COMPUTED IN SQL, FROM THE ACCEPTANCE ROW, and that is not fussiness.
  // The first version sent `accepted_at` out to TypeScript as an ISO-8601
  // string and added the window there, which silently truncated Postgres's
  // MICROSECOND timestamp to milliseconds — so `hold.available_at` and
  // `v_fx_quote.settle_by` disagreed by up to 999µs, two columns claiming to
  // be the same instant. The integration test asserting them equal is what
  // found it. Deriving it here means there is one expression for "when this
  // commitment lapses" and no clock leaves the database to be rounded.
  const holds = await conn<{ id: string; settle_by: string }[]>`
    INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, available_at)
    SELECT ${accounts.depositAccountId}::uuid,
           ${accounts.memoAccountId}::uuid,
           'manual',
           ${commitmentExternalRef(input.quoteRef)},
           ${accounts.valueDate}::date,
           a.accepted_at + q.settlement_window_seconds * interval '1 second'
      FROM fx_quote_acceptance a
      JOIN fx_quote q ON q.id = a.quote_id
     WHERE a.quote_id = ${input.quoteId}::uuid
    RETURNING id,
              to_char(available_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS settle_by`;
  const placedHold = holds[0];
  if (placedHold === undefined) {
    // The acceptance is inserted one statement earlier in the same
    // transaction, so zero rows here means the ordering has been changed and
    // the hold would otherwise be silently skipped — the original bug.
    throw new Error(
      `no commitment hold was placed for ${input.quoteRef}: no acceptance row was visible to this transaction`,
    );
  }
  const holdId = placedHold.id;
  const settleByIso = placedHold.settle_by;

  await conn`
    INSERT INTO fx_commitment_hold (quote_id, hold_id, sell_cents, placed_by)
    VALUES (${input.quoteId}::uuid, ${holdId}::uuid, ${input.sellCents}, ${input.actorId}::uuid)`;

  const contraId = await houseAccountId(MEMO_CONTRA_CODE, input.entityId, conn);

  const memoEntryId = await postEntry(
    {
      entityId: input.entityId,
      valueDate: accounts.valueDate,
      book: "memo",
      description:
        `FX commitment ${input.quoteRef} accepted — ${usd(input.sellCents)} withheld until ` +
        `the payout settles or the window closes ${settleByIso}`,
      idempotencyKey: commitmentOpenKey(input.quoteId),
      actorId: input.actorId,
      rail: "usdc",
      externalRef: input.quoteRef,
      holdId,
      lines: [
        // Credit the memo leaf: more held is a bigger obligation, and the leaf
        // is credit-normal, so a POSITIVE hold is a NEGATIVE amount_cents. The
        // inversion lives here and in `postHoldDelta()` and nowhere else.
        { accountId: accounts.memoAccountId, amountCents: -input.sellCents },
        // Debit the contra, so the memo book nets to zero on its own.
        { accountId: contraId, amountCents: input.sellCents },
      ],
    },
    conn,
  );

  return {
    holdId,
    memoEntryId,
    withheldCents: input.sellCents,
    availableBeforeCents: accounts.availableCents,
    settleBy: settleByIso,
  };
}

/* -------------------------------------------------------------------------- */
/* Taking it off: the terminal direction                                      */
/* -------------------------------------------------------------------------- */

export interface ReleasedCommitment {
  readonly holdId: string | null;
  readonly closurePosted: boolean;
  readonly releasedCents: bigint;
  readonly entryId: string | null;
}

/**
 * Release the commitment hold because the payout SETTLED. Terminal.
 *
 * Called inside `recordQuoteSettlement()`'s transaction, immediately after the
 * `fx_quote_settlement` row lands, so the closure and the fact that licenses it
 * commit together or not at all.
 *
 * CLOSURE FIRST, POSTING SECOND, exactly as `closeHold()`'s own header argues:
 * `ledger_availability()` reads "released" as that row standing, so a process
 * that dies between the two leaves the customer's available balance already
 * correct and the memo posting is bookkeeping that the sweep lands later.
 *
 * COMPARE-AND-APPEND, not "post the negative of what we opened with". The
 * amount is the memo book's OWN balance read inside this transaction, so a
 * second call — a replay, the loser of a race, a hold the lapse sweep already
 * flattened — computes zero and appends nothing. There is no double-release to
 * guard against because there is no second delta to compute.
 *
 * A quote with no commitment hold is NOT an error: all 35 acceptances that
 * predate migration 0053 have none, and settling one of those must still work.
 * It returns `holdId: null` and writes nothing.
 */
export async function releaseSettledCommitment(
  args: {
    readonly quoteId: string;
    readonly quoteRef: string;
    readonly txHash: string;
    readonly actorId: string;
  },
  conn: Sql,
): Promise<ReleasedCommitment> {
  // THE ENTITY COMES OFF THE QUOTE, NOT OFF THE ACCOUNT, and the memo balance
  // comes from `memoHoldBalance()`. Both are the ledger boundary being kept
  // rather than argued with: `fx_quote.entity_id` is NOT NULL and references
  // `book_entity` directly, so joining `account` to rediscover it would be
  // this module writing SQL against a ledger table to learn something the FX
  // schema already knows — and `memoHoldBalance()` is the reader `apply.ts`
  // uses for exactly this sum, which is what keeps one answer to "what is this
  // hold withholding".
  const rows = await conn<
    { hold_id: string; entity_id: string; memo_account_id: string }[]
  >`
    SELECT ch.hold_id, q.entity_id, h.memo_account_id
      FROM fx_commitment_hold ch
      JOIN hold     h ON h.id = ch.hold_id
      JOIN fx_quote q ON q.id = ch.quote_id
     WHERE ch.quote_id = ${args.quoteId}::uuid`;
  const row = rows[0];
  if (row === undefined) {
    return { holdId: null, closurePosted: false, releasedCents: 0n, entryId: null };
  }
  const memoCents = await memoHoldBalance(row.hold_id, row.memo_account_id, conn);

  const closurePosted = await closeHold(
    row.hold_id,
    commitmentClosureReason(args.quoteRef, args.txHash),
    args.actorId,
    conn,
    // Declared, so `v_hold_closure_census` can count it by construction rather
    // than by matching English against `reason` — migration 0040's whole point.
    "fx_settlement",
  );

  if (memoCents === 0n) {
    return { holdId: row.hold_id, closurePosted, releasedCents: 0n, entryId: null };
  }

  const contraId = await houseAccountId(MEMO_CONTRA_CODE, row.entity_id, conn);
  const { valueDate } = await readSnapshot(conn);

  const entryId = await postEntry(
    {
      entityId: row.entity_id,
      valueDate,
      book: "memo",
      description:
        `FX commitment ${args.quoteRef} released — the payout settled (${args.txHash})`,
      idempotencyKey: commitmentReleaseKey(args.quoteId, "settled"),
      actorId: args.actorId,
      rail: "usdc",
      externalRef: args.txHash,
      holdId: row.hold_id,
      lines: [
        // Debit the memo leaf back down to zero. It is credit-normal, so giving
        // the money back is a POSITIVE amount_cents.
        { accountId: row.memo_account_id, amountCents: memoCents },
        { accountId: contraId, amountCents: -memoCents },
      ],
    },
    conn,
  );

  return { holdId: row.hold_id, closurePosted, releasedCents: memoCents, entryId };
}

/* -------------------------------------------------------------------------- */
/* Taking it off: the clock, and the bookkeeping that follows it              */
/* -------------------------------------------------------------------------- */

export interface LapsedCommitment {
  readonly holdId: string;
  readonly quoteId: string;
  readonly quoteRef: string;
  readonly entityId: string;
  readonly memoAccountId: string;
  readonly memoBalanceCents: bigint;
  readonly settleBy: string;
  readonly releaseValueDate: string;
}

export interface CommitmentSweepResult {
  readonly examined: number;
  readonly released: number;
  readonly releasedCents: bigint;
  readonly failures: readonly { readonly holdId: string; readonly error: string }[];
}

/**
 * Commitment holds whose settlement window has closed and whose memo book has
 * not caught up.
 *
 * THE CUSTOMER IS ALREADY RIGHT when a row appears here, and that is the whole
 * reason this is bookkeeping rather than a repair: `is_released` came from
 * `now() >= hold.available_at` over a column written once at acceptance on a
 * table nothing may UPDATE, and `ledger_availability()` re-derives the same arm
 * at a parameterised instant. Nobody decided anything, so there is no act of
 * judgement that could be the thing that is wrong — the same argument
 * `findUnclearedReleasesDue()` makes one directory over, and the reason both
 * are safe to run and safe never to run.
 *
 * SETTLED COMMITMENTS ARE EXCLUDED even when they also lapsed. Their release is
 * the terminal one, with the closure row that says the true reason, and it
 * belongs to `releaseSettledCommitment()`. A hold that both settled and lapsed
 * must not be flattened here under a "the window closed" description.
 */
export async function findLapsedCommitments(
  opts: { readonly limit?: number; readonly conn?: Sql } = {},
): Promise<readonly LapsedCommitment[]> {
  const conn = opts.conn ?? sql;
  const limit = opts.limit ?? 100;

  const rows = await conn<
    {
      hold_id: string;
      quote_id: string;
      quote_ref: string;
      entity_id: string;
      memo_account_id: string;
      memo_balance_cents: bigint;
      settle_by: string;
      release_value_date: string;
    }[]
  >`
    SELECT ch.hold_id,
           ch.quote_id,
           q.quote_ref,
           q.entity_id,
           h.memo_account_id,
           hs.memo_balance_cents::bigint AS memo_balance_cents,
           to_char(h.available_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS settle_by,
           book_date(h.available_at)::text AS release_value_date
      FROM fx_commitment_hold ch
      JOIN hold         h  ON h.id = ch.hold_id
      JOIN fx_quote     q  ON q.id = ch.quote_id
      JOIN v_hold_state hs ON hs.hold_id = ch.hold_id
     WHERE h.available_at IS NOT NULL
       AND now() >= h.available_at
       AND hs.memo_balance_cents <> 0
       -- a settled commitment's release is the terminal one; see the doc above
       AND NOT EXISTS (SELECT 1 FROM fx_quote_settlement s WHERE s.quote_id = ch.quote_id)
       -- and a closure row means somebody already decided; this sweep does not
       -- second-guess one
       AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = ch.hold_id)
     ORDER BY h.available_at, ch.hold_id
     LIMIT ${limit}`;

  return rows.map((r) => ({
    holdId: r.hold_id,
    quoteId: r.quote_id,
    quoteRef: r.quote_ref,
    entityId: r.entity_id,
    memoAccountId: r.memo_account_id,
    memoBalanceCents: r.memo_balance_cents,
    settleBy: r.settle_by,
    releaseValueDate: r.release_value_date,
  }));
}

/**
 * Flatten one lapsed commitment's memo balance. Writes NO closure row.
 *
 * The value date is `book_date(available_at)` — the day the WINDOW closed, not
 * the day this happened to run — so the statement for the release day shows the
 * money freed on the day the commitment actually lapsed, and a re-run a week
 * later produces the identical entry. `booking_time` is still now(), which is
 * the honest bitemporal split: it happened then, we recorded it when we looked.
 */
export async function releaseLapsedCommitment(
  row: LapsedCommitment,
  args: { readonly actorId: string; readonly conn?: Sql },
): Promise<ReleasedCommitment> {
  const conn = args.conn ?? sql;

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    // Re-read inside the transaction: the queue was built outside it and a
    // settlement may have landed since, in which case the right amount of
    // bookkeeping here is none. The balance comes from `memoHoldBalance()`,
    // the same reader `apply.ts` and `releaseOne()` use, so there is one
    // answer to "what is this hold withholding" rather than one per module.
    const balance = await memoHoldBalance(row.holdId, row.memoAccountId, tx);
    const settlements = await tx<{ settled: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM fx_quote_settlement s
                      WHERE s.quote_id = ${row.quoteId}::uuid) AS settled`;
    const settled = settlements[0]?.settled ?? false;
    if (balance === 0n || settled) {
      return { holdId: row.holdId, closurePosted: false, releasedCents: 0n, entryId: null };
    }

    const contraId = await houseAccountId(MEMO_CONTRA_CODE, row.entityId, tx);

    const entryId = await postEntry(
      {
        entityId: row.entityId,
        valueDate: row.releaseValueDate,
        book: "memo",
        description:
          `FX commitment ${row.quoteRef} lapsed — the settlement window closed ${row.settleBy} ` +
          "and the rate is no longer held",
        idempotencyKey: commitmentReleaseKey(row.quoteId, "lapsed"),
        actorId: args.actorId,
        rail: "usdc",
        externalRef: row.quoteRef,
        holdId: row.holdId,
        lines: [
          { accountId: row.memoAccountId, amountCents: balance },
          { accountId: contraId, amountCents: -balance },
        ],
      },
      tx,
    );

    // closurePosted is FALSE and always will be. The lapse writes no
    // `hold_closure` row — see the header on closed vs terminallyClosed.
    return { holdId: row.holdId, closurePosted: false, releasedCents: balance, entryId };
  });
}

/**
 * Flatten every lapsed commitment the memo book is still carrying.
 *
 * Total and idempotent: a second run reads a zero balance and appends nothing.
 * A hold that throws is logged, counted and SKIPPED rather than aborting the
 * batch — one entity missing its 9900 house account must not stop every other
 * customer's memo book being put right, and the row stays in
 * `v_hold_release_drift`, loudly, until someone looks.
 */
export async function sweepLapsedCommitments(
  opts: {
    readonly limit?: number;
    readonly actorId?: string;
    readonly conn?: Sql;
  } = {},
): Promise<CommitmentSweepResult> {
  const conn = opts.conn ?? sql;
  const actorId = opts.actorId ?? (await commitmentActorId(conn));

  const due = await findLapsedCommitments({
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    conn,
  });

  let released = 0;
  let releasedCents = 0n;
  const failures: { holdId: string; error: string }[] = [];

  for (const row of due) {
    try {
      const result = await releaseLapsedCommitment(row, { actorId, conn });
      if (result.releasedCents === 0n) continue;
      released += 1;
      releasedCents += result.releasedCents;
      rootLogger.info("fx.commitment.lapsed.released", {
        holdId: row.holdId,
        quoteRef: row.quoteRef,
        releasedCents: result.releasedCents.toString(),
        settleBy: row.settleBy,
      });
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown.message : String(thrown);
      failures.push({ holdId: row.holdId, error });
      rootLogger.error("fx.commitment.lapsed.failed", { holdId: row.holdId, error });
    }
  }

  return { examined: due.length, released, releasedCents, failures };
}

/** The system actor every posting on this path is attributed to. */
async function commitmentActorId(conn: Sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no 'ledger-poster' system actor; run scripts/seed.mjs");
  }
  return row.id;
}
