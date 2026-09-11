/**
 * Booking a wire.
 *
 * ─── THE CLAIM THIS FILE EXISTS TO MAKE GOOD ────────────────────────────────
 *
 * An inbound wire is available IMMEDIATELY — ledger balance and available
 * balance move together, unlike the ACH funding leg where available
 * deliberately does not move — and that falls out of the existing model rather
 * than being special-cased into it.
 *
 * "Falls out" is a strong claim, so here is the standard it is being held to:
 * THERE IS NO BRANCH IN THIS FILE THAT MENTIONS A RAIL. `creditInboundWire()`
 * writes the same `uncleared_credit` hold row, cites a `policy_id` from the
 * same `funds_availability_policy` table, posts the same memo pair against the
 * same 9200/9900 accounts, and reads the same `scheduleAvailability()` from
 * the ACH funding path — `../plaid/availability.ts`, imported rather than
 * copied, precisely so that "the arithmetic is the same" is checkable and not
 * assertable. Search this file for `if` and you will find no rail in one.
 *
 * The wire is available immediately because of ONE ROW OF DATA:
 *
 *     funds_availability_policy
 *       rail='wire' counterparty_class='n/a' effective_from=2026-09-11
 *       banking_days_hold=0  release_local_time='00:00:00'
 *
 * `addBankingDays(d, 0) === d` (../plaid/availability.ts documents that the
 * zero case returns the date unchanged, naming wire as the reason), and
 * `bankingInstant(d, '00:00')` is midnight ET on the credit's own value date.
 * The value date of a wire is the day it arrived. So `available_at` is always
 * already in the past when the entry commits, and `ledger_availability()`'s
 * existing release predicate --
 *
 *     OR (held.kind = 'uncleared_credit' AND p_as_of >= held.available_at)
 *
 * -- releases the hold at the same instant the credit is booked. The hold is
 * BORN RELEASED.
 *
 * ─── WHY THE HOLD IS STILL WRITTEN ──────────────────────────────────────────
 *
 * The obvious shortcut is to skip the hold when the policy says zero days.
 * It was rejected, and the reason is the whole argument:
 *
 *   A hold that is never written proves nothing. "Available moved" would then
 *   be true because this code CHOSE not to withhold anything — a special case
 *   with better manners. Writing the hold and watching the balance function
 *   release it means the MODEL released it. The proof is
 *   `v_wire_availability_drift` (migration 0025 §4), a view whose rows are
 *   holds that actually bound, which must be empty.
 *
 * ─── AND THE ONE PLACE IT DID *NOT* FALL OUT — FOUND BY dbcheck ─────────────
 *
 * The availability ARITHMETIC fell out with no change: the first version of
 * this function wrote the hold, wrote the memo posting, and
 * `ledger_availability()` released it on the clock exactly as hoped. Ledger
 * and available moved together on the first run.
 *
 * `node scripts/dbcheck.mjs` then went to 21/22, and the failing row was
 * this wire's hold:
 *
 *     v_hold_release_drift is empty — 1 row(s)
 *         — a released hold withholds nothing
 *
 * `v_hold_release_drift` (migration 0011 §3) is the OTHER half of the hold
 * invariant, and it is a different claim from the balance one: "a released
 * hold must be FLAT — whatever it was withholding has been given back in the
 * memo book. Anything else means availability and the memo book disagree
 * about the same hold, which is the shape of every over-release bug there is."
 *
 * Two definitions of released, and they are both right:
 *
 *   ledger_availability()      released = the CLOCK has passed available_at.
 *                              Nothing needs to have been written.
 *   v_hold_release_drift       released ⇒ the memo book has been SQUARED,
 *                              which only happens when somebody posts the
 *                              reversing entry.
 *
 * On ACH nobody notices the gap, because the sweeper closes the hold and posts
 * the reversing memo entry a day or two later and the window between "the
 * clock passed" and "the sweep ran" is minutes. A zero-day policy makes that
 * window the WHOLE LIFE OF THE HOLD: a wire hold is released the instant it is
 * created, so there is no "later" for a sweeper to be. Left alone, every wire
 * credit would sit in `v_hold_release_drift` until the next sweep, and the
 * invariant that catches over-release bugs would be permanently non-empty on
 * a rail that has none.
 *
 * So this function does what the sweeper does, in the same transaction: closes
 * the hold with `closeHold()` and posts the reversing memo entry. THAT is the
 * special case, and it is worth being precise about what kind it is — it is
 * not a rail branch and not a second availability rule, it is this path taking
 * responsibility for a release that has no later. The predicate that decides
 * is `schedule.availableAt <= now`, which mentions no rail and would fire for
 * any zero-day policy on any rail.
 *
 * The result is the ACH shape with the days taken out. An ACH credit produces
 * three entries — financial, memo hold, memo release — spread over one to two
 * banking days. A wire produces the same three, in one transaction.
 *
 * ─── WHAT IS GENUINELY DIFFERENT, AND IT IS NOT THE AVAILABILITY ────────────
 *
 * One thing about a wire credit differs from an ACH credit, and it is the
 * CONTRA LEG, not the hold:
 *
 *   ACH   DR 1130  "ACH receivable — inbound in transit"
 *   WIRE  DR 1110  "Cash — FBO settlement account at sponsor bank"
 *
 * 1130 exists because an inbound ACH credit is a promise about a future
 * settlement day: we have been told about money that has not funded the FBO
 * account yet. A wire has no such gap — `acceptance.accepted_at` equals
 * `created_at`, MEASURED — so the money is in the FBO account at the moment we
 * hear about it, and 1110's own chart note says it is "debited when funds
 * actually land there ... never when a provider merely promises them".
 * 1130 also carries `railControl: 'ach'`, so posting a wire to it would
 * contradict the chart's own metadata.
 *
 * THAT is the asymmetry, and notice where it landed: in the choice of an
 * account, which is a fact about where the money is, not in the hold model,
 * the availability arithmetic or the balance definition. None of those three
 * learned that wires exist.
 */

import 'server-only';

import { sql, type Sql } from '@/lib/ledger/db';
import { postEntry } from '@/lib/ledger/post';
// NAMED READERS, not SQL of our own. See `resolveWireChart`.
import {
  mainDepositAccountId,
  readAccountIdentity,
  resolveChartCodes,
} from '@/lib/ledger/queries';
// The SAME closure writer the ACH availability sweeper uses. Imported rather
// than re-implemented so "released" is written one way: `hold_closure`, once,
// by a unique primary key, and never a second row.
import { closeHold } from '@/lib/holds/store';

import {
  scheduleAvailability,
  type AvailabilitySchedule,
  type ValueDate,
} from '../plaid/availability';
import { effectiveAvailabilityPolicy } from '../plaid/adapter';

import { WIRE_PROVIDER, type InboundWireCredit } from './types';

/* -------------------------------------------------------------------------- */
/* Chart codes                                                                */
/* -------------------------------------------------------------------------- */

/** Cash actually at the sponsor bank. A wire has landed when we hear of it. */
const FBO_CASH_CODE = '1110';
// 2100 is not here: `mainDepositAccountId()` owns that code, and a second
// copy of it in this file would be a second opinion about which leaf is
// spendable — pot sub-accounts carry '2100.<uuid>' and only that reader
// excludes them by construction.
const UNCLEARED_HOLD_CODE = '9200';
const MEMO_CONTRA_CODE = '9900';

/**
 * The counterparty class for wire, and why there is only one.
 *
 * The ACH classes — `self` / `known` / `new` — exist to price RETURN RISK, and
 * they can only price it because a return is possible. Grading wire senders
 * into risk bands would imply the bands buy something; they buy nothing,
 * because the money is already ours and cannot be taken back. `n/a` is the
 * honest class and it is the one the policy row is keyed on.
 */
const WIRE_COUNTERPARTY_CLASS = 'n/a';

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

export class WireBookingRefused extends Error {
  override readonly name = 'WireBookingRefused';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* The chart, resolved                                                        */
/* -------------------------------------------------------------------------- */

interface WireChart {
  readonly entityId: string;
  readonly depositAccountId: string;
  readonly memoAccountId: string;
  readonly cashAccountId: string;
  readonly memoContraAccountId: string;
}

/**
 * The four accounts a wire credit touches, through NAMED READERS.
 *
 * Not a self-join across `account`, which is what the first draft wrote and
 * what `src/lib/ledger/boundary.test.ts` immediately failed it for — a rail
 * that has learnt the ledger's schema is a rail that will answer a chart
 * question differently from the ledger one day. `resolveChartCodes()` exists
 * for exactly this shape ("give me these HOUSE codes and these CUSTOMER codes,
 * for this entity and this business") and the Plaid adapter's own four-deep
 * self-join is the debt it was extracted from.
 *
 * Three reads rather than one, and that is the price: the entity has to be
 * known before the chart can be asked for, and the deposit leaf is what knows
 * it. All three are index lookups and none of them is inside the transaction
 * that posts.
 */
async function resolveWireChart(businessId: string, conn: Sql): Promise<WireChart> {
  const depositAccountId = await mainDepositAccountId(businessId, conn);
  if (depositAccountId === null) {
    throw new WireBookingRefused(
      'NO_DEPOSIT_ACCOUNT',
      `Business ${businessId} has no 2100 deposit account on this book, so there is nowhere for a wire to land. A business gets one when it is onboarded.`,
    );
  }

  const deposit = await readAccountIdentity(depositAccountId, conn);
  if (deposit === null) {
    throw new WireBookingRefused(
      'NO_DEPOSIT_ACCOUNT',
      `Deposit account ${depositAccountId} could not be read back. Nothing was booked.`,
    );
  }

  const chart = await resolveChartCodes(
    {
      entityId: deposit.entityId,
      businessId,
      houseCodes: [FBO_CASH_CODE, MEMO_CONTRA_CODE],
      businessCodes: [UNCLEARED_HOLD_CODE],
    },
    conn,
  );

  const cash = chart.get(FBO_CASH_CODE);
  const memo = chart.get(UNCLEARED_HOLD_CODE);
  const contra = chart.get(MEMO_CONTRA_CODE);
  // A code with no account is ABSENT from the map, so "the chart is missing X"
  // stays this module's error to raise — which is the contract
  // `resolveChartCodes` documents, and it is the right side of the line: the
  // ledger knows what the chart holds, the rail knows what it needs.
  if (cash === undefined || memo === undefined || contra === undefined) {
    const missing = [
      cash === undefined ? FBO_CASH_CODE : null,
      memo === undefined ? UNCLEARED_HOLD_CODE : null,
      contra === undefined ? MEMO_CONTRA_CODE : null,
    ].filter((code): code is string => code !== null);
    throw new WireBookingRefused(
      'CHART_INCOMPLETE',
      `The chart is missing ${missing.join(', ')} for entity ${deposit.entityId}${
        missing.includes(UNCLEARED_HOLD_CODE) ? ` / business ${businessId}` : ''
      }. A wire credit needs cash, an uncleared-credit leaf and a memo contra before it can post.`,
    );
  }

  return {
    entityId: deposit.entityId,
    depositAccountId,
    memoAccountId: memo.accountId,
    cashAccountId: cash.accountId,
    memoContraAccountId: contra.accountId,
  };
}

/** The system actor money posts under. Resolved by name, never hard-coded. */
async function posterActorId(conn: Sql): Promise<string> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
  if (row === undefined) {
    throw new WireBookingRefused(
      'NO_POSTER_ACTOR',
      "No 'ledger-poster' system actor exists; run scripts/seed.mjs.",
    );
  }
  return row.id;
}

/* -------------------------------------------------------------------------- */
/* Value date                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The business day a wire belongs to: the day it was ACCEPTED, in book time.
 *
 * Never our clock, and never UTC. A wire accepted at 2026-09-11T02:30Z is a
 * 2026-09-10 wire in America/New_York, and dating it 09-11 would put money on
 * a statement for a day it did not arrive. `en-CA` formats as YYYY-MM-DD and
 * `Intl` carries the DST table, which is the same technique
 * `src/lib/mcp/time.ts` uses and the reason no arithmetic on epoch offsets
 * appears here.
 */
const bookDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function wireValueDate(acceptedAtIso: string): ValueDate {
  const at = new Date(acceptedAtIso);
  if (Number.isNaN(at.getTime())) {
    throw new WireBookingRefused(
      'UNREADABLE_ACCEPTANCE_TIME',
      `Cannot date a wire from "${acceptedAtIso}". The value date is read off the network's acceptance timestamp and is never substituted with our own clock.`,
    );
  }
  return bookDateFormat.format(at);
}

/* -------------------------------------------------------------------------- */
/* The external reference                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `increase.wire:<transfer id>` — the join key for the hold, both entries and
 * `hold_ref UNIQUE (kind, external_ref)`.
 *
 * The provider id rather than the IMAD, deliberately, and the two are not
 * interchangeable here. The IMAD is the SETTLEMENT's identity (see
 * `wireSettlementRef`); the external ref is the ARRIVAL's, and a wire can be
 * read back by its provider id when it has no IMAD yet. Using a nullable field
 * as a uniqueness key is how a second copy of a credit gets booked.
 */
export function wireExternalRef(transferId: string): string {
  return `${WIRE_PROVIDER}:${transferId}`;
}

/* -------------------------------------------------------------------------- */
/* Inbound: the credit                                                        */
/* -------------------------------------------------------------------------- */

export interface WireCreditReceipt {
  readonly entryId: string;
  /** The memo entry that OPENS the hold. Always written. */
  readonly memoEntryId: string;
  /**
   * The memo entry that CLOSES it, written in the same transaction whenever
   * the hold's release moment had already passed — which on this rail is
   * always. Null only for a policy that genuinely withholds something, which
   * no wire policy version has ever done.
   */
  readonly releaseEntryId: string | null;
  readonly holdId: string;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: ValueDate;
  readonly schedule: AvailabilitySchedule;
  /**
   * True when the hold was already released at the instant it was written —
   * which on this rail is always, and is the fact being proven. Computed by
   * comparing the schedule against the acceptance, NOT asserted.
   */
  readonly availableImmediately: boolean;
  /** False on a replay: the hold already existed and nothing was written. */
  readonly created: boolean;
}

export interface CreditInboundWireArgs {
  readonly businessId: string;
  readonly credit: InboundWireCredit;
  readonly conn?: Sql | undefined;
  readonly actorId?: string | undefined;
}

/**
 * Book an inbound wire, and open the availability hold the policy asks for.
 *
 * One transaction: the hold row, the financial entry and the memo entry commit
 * together or not at all. Identical in structure to `fundFromLinkedAccount()`
 * on the ACH side, for the same reason — a crash between the financial entry
 * and the memo one would leave the customer able to spend money that has not
 * cleared. On this rail the window would be harmless, because the money HAS
 * cleared; keeping the transaction anyway is what makes the two paths the same
 * path and therefore comparable.
 *
 * Replay is decided by the database, not by an `if`: `hold_ref UNIQUE (kind,
 * external_ref)` on the hold, and `journal_entry`'s idempotency key on both
 * entries. A redelivered `inbound_wire_transfer.created` books nothing twice.
 */
export async function creditInboundWire(
  args: CreditInboundWireArgs,
): Promise<WireCreditReceipt> {
  const conn = args.conn ?? sql;
  const credit = args.credit;

  if (credit.amount.currency !== 'USD') {
    throw new WireBookingRefused(
      'CURRENCY_NOT_USD',
      `A Fedwire funds transfer is USD; refusing to book ${credit.amount.currency}.`,
    );
  }
  if (credit.amount.amount <= 0n) {
    throw new WireBookingRefused(
      'INVALID_AMOUNT',
      'A wire credit must be a positive integer number of cents. Zero is not a receipt and a negative one is a payment wearing a receipt’s clothes.',
    );
  }

  const valueDate = wireValueDate(credit.acceptedAt);
  const externalRef = wireExternalRef(credit.transferId);

  // The policy row in force for this rail ON THIS VALUE DATE — chosen by the
  // value date and never by today, so a policy change tomorrow cannot
  // retroactively alter how long a credit booked today was held.
  const policy = await effectiveAvailabilityPolicy(
    { rail: 'wire', counterpartyClass: WIRE_COUNTERPARTY_CLASS, valueDate },
    conn,
  );
  if (policy === null) {
    // NOT a default of "release immediately", even though that is the answer
    // this rail's policy gives. A missing row means nobody has decided, and
    // guessing zero is the one answer that can lose money — the identical
    // refusal the ACH path makes, kept identical on purpose.
    throw new WireBookingRefused(
      'NO_AVAILABILITY_POLICY',
      `No funds_availability_policy row covers rail 'wire' / counterparty class '${WIRE_COUNTERPARTY_CLASS}' at value date ${valueDate}. Nothing was booked: a credit whose availability nobody has decided is not one this system will make spendable by default, and "wires are immediate" is a policy row, not a constant.`,
    );
  }

  const schedule = scheduleAvailability(policy, valueDate);
  const chart = await resolveWireChart(args.businessId, conn);
  const actorId = args.actorId ?? (await posterActorId(conn));
  const amountCents = credit.amount.amount;

  const origin =
    credit.returnOfWireTransferId === null
      ? `${credit.debtorName ?? 'an unidentified sender'}`
      : `the beneficiary bank returning wire ${credit.returnOfWireTransferId}`;
  const imad = credit.imad === null ? 'no IMAD on the message' : `IMAD ${credit.imad}`;

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO hold (account_id, memo_account_id, kind, external_ref,
                        value_date, available_at, policy_id)
      VALUES (${chart.depositAccountId}::uuid, ${chart.memoAccountId}::uuid,
              'uncleared_credit', ${externalRef}, ${valueDate}::date,
              ${schedule.availableAt.toISOString()}::timestamptz, ${policy.id}::uuid)
      ON CONFLICT (kind, external_ref) DO NOTHING
      RETURNING id`;

    const created = inserted.length > 0;
    const holdId =
      inserted[0]?.id ??
      (
        await tx<{ id: string }[]>`
          SELECT id FROM hold
           WHERE kind = 'uncleared_credit' AND external_ref = ${externalRef}`
      )[0]?.id;

    if (holdId === undefined) {
      throw new WireBookingRefused(
        'HOLD_NOT_WRITTEN',
        `Failed to create or find the availability hold for ${externalRef}.`,
      );
    }

    const entryId = await postEntry(
      {
        entityId: chart.entityId,
        valueDate,
        book: 'financial',
        description: `Inbound wire from ${origin} — ${imad}, final on receipt`,
        idempotencyKey: `${WIRE_PROVIDER}:credit:${credit.transferId}`,
        actorId,
        rail: 'wire',
        externalRef,
        lines: [
          // DR 1110. The money is AT the bank, not owed to us by one. See the
          // header for why this is 1110 and the ACH path is 1130.
          { accountId: chart.cashAccountId, amountCents },
          // CR the customer. Money in is a credit to a deposit account,
          // because the customer having money is the bank owing money.
          { accountId: chart.depositAccountId, amountCents: -amountCents },
        ],
      },
      tx,
    );

    const memoEntryId = await postEntry(
      {
        entityId: chart.entityId,
        valueDate,
        book: 'memo',
        description: `Wire availability hold, ${policy.bankingDaysHold} banking days to ${schedule.releaseDate} ${policy.releaseLocalTime} ET — released on creation`,
        idempotencyKey: `hold:${holdId}:after:${externalRef}`,
        actorId,
        rail: 'wire',
        externalRef,
        holdId,
        lines: [
          // The 9200 leaf is credit-normal, so a POSITIVE hold is a NEGATIVE
          // amount_cents. Getting that inversion wrong is the classic error.
          { accountId: chart.memoAccountId, amountCents: -amountCents },
          { accountId: chart.memoContraAccountId, amountCents },
        ],
      },
      tx,
    );

    // Computed, not asserted: had the hold's release moment already passed by
    // the time the money arrived? `ledger_availability` uses
    // `p_as_of >= available_at`, so this is the same predicate read from the
    // other side. NOTE THAT IT NAMES NO RAIL — a zero-day ACH policy would
    // take this branch too, and should.
    const availableImmediately =
      schedule.availableAt.getTime() <= Date.parse(credit.acceptedAt);

    let releaseEntryId: string | null = null;
    if (availableImmediately) {
      // THE PART THAT DID NOT FALL OUT. See the header. A hold that is
      // released the instant it is created has no "later" for the ACH
      // availability sweeper to run in, and `v_hold_release_drift` requires a
      // released hold to be flat in the memo book — so the release is done
      // here, in this transaction, exactly as the sweeper would do it.
      //
      // Closure FIRST, posting second, which is the sweeper's own crash-safety
      // order: `v_hold_state` reads released off this row, so a process that
      // died between them would leave the customer's available balance
      // already correct.
      await closeHold(
        holdId,
        `wire funds availability reached at ${schedule.availableAt.toISOString()} — a zero-day policy releases on arrival, so the release is posted with the credit rather than swept later`,
        actorId,
        tx,
      );

      releaseEntryId = await postEntry(
        {
          entityId: chart.entityId,
          // The credit's OWN value date, not "today in book time" as the ACH
          // sweeper uses. The sweeper is right for ACH: release is a new event
          // that really happened on a later day. Here there is no later day —
          // the release happened on the day the wire arrived — and dating it
          // anywhere else would put a memo entry on a business day nothing
          // happened on.
          valueDate,
          book: 'memo',
          description: 'Wire availability hold released — final on receipt, nothing to withhold',
          idempotencyKey: `hold:${holdId}:after:availability:${schedule.availableAt.toISOString()}`,
          actorId,
          rail: 'wire',
          externalRef,
          holdId,
          lines: [
            // Debit the customer's 9200 leaf back down to zero.
            { accountId: chart.memoAccountId, amountCents },
            { accountId: chart.memoContraAccountId, amountCents: -amountCents },
          ],
        },
        tx,
      );
    }

    return {
      entryId,
      memoEntryId,
      releaseEntryId,
      holdId,
      externalRef,
      amountCents,
      valueDate,
      schedule,
      availableImmediately,
      created,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Inbound: sending it back                                                   */
/* -------------------------------------------------------------------------- */

export interface WireReturnReceipt {
  readonly entryId: string;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: ValueDate;
}

/**
 * We received a wire and sent it back out.
 *
 * `POST /inbound_wire_transfers/{id}/reverse` is a PRODUCTION method with
 * `reason: "creditor_request"` — the creditor being us (MEASURED). So this is
 * not a recall arriving from the network; it is this bank ORIGINATING a
 * payment in the other direction, and the ledger says so:
 *
 *   * ITS OWN VALUE DATE, the day we sent it, not the day the wire arrived.
 *     `rail_event_semantics` row `inbound_wire_transfer.updated/reversed` is
 *     `new_event` for exactly this reason. Backdating it to the arrival would
 *     make the statement for the arrival day claim the wire never landed —
 *     and it did land, provably, with an IMAD.
 *   * A NEW ENTRY, never an edit of the credit. Append-only is not a
 *     performance characteristic here, it is the correct model: two things
 *     happened.
 *
 * It is deliberately NOT routed through `requestPayment()`, and that is not a
 * second money-out path. `requestPayment` raises a CUSTOMER INSTRUCTION and
 * gates it with maker-checker; this is a RAIL EVENT, reachable only from a
 * provider fact we observed, in the same way an ACH return debits back an
 * inbound credit without anyone approving the return. A maker-checker queue in
 * front of a movement no human chose would be a queue nobody could clear.
 *
 * The customer can end up overdrawn, and that is the honest outcome:
 * `ledger_availability` is explicitly allowed to go negative rather than
 * clamp, because clamping hides a real overdraft behind a floor.
 */
export async function debitReturnedInboundWire(args: {
  readonly businessId: string;
  readonly inboundTransferId: string;
  readonly amountCents: bigint;
  readonly reversedAt: string;
  readonly reason: string;
  readonly conn?: Sql | undefined;
  readonly actorId?: string | undefined;
}): Promise<WireReturnReceipt> {
  const conn = args.conn ?? sql;
  if (args.amountCents <= 0n) {
    throw new WireBookingRefused(
      'INVALID_AMOUNT',
      'A returned wire must be a positive integer number of cents.',
    );
  }

  const valueDate = wireValueDate(args.reversedAt);
  const externalRef = `${WIRE_PROVIDER}:return:${args.inboundTransferId}`;
  const chart = await resolveWireChart(args.businessId, conn);
  const actorId = args.actorId ?? (await posterActorId(conn));

  const entryId = await postEntry(
    {
      entityId: chart.entityId,
      valueDate,
      book: 'financial',
      description: `Inbound wire ${args.inboundTransferId} returned to sender (${args.reason}) — a new outbound wire, not a recall of the receipt`,
      idempotencyKey: `${WIRE_PROVIDER}:return:${args.inboundTransferId}`,
      actorId,
      rail: 'wire',
      externalRef,
      lines: [
        // DR the customer: their balance falls on the day the money left.
        { accountId: chart.depositAccountId, amountCents: args.amountCents },
        // CR cash: it is no longer in the FBO account.
        { accountId: chart.cashAccountId, amountCents: -args.amountCents },
      ],
    },
    conn,
  );

  return { entryId, externalRef, amountCents: args.amountCents, valueDate };
}

/* -------------------------------------------------------------------------- */
/* The proof, read back                                                       */
/* -------------------------------------------------------------------------- */

export interface WireAvailabilityProof {
  readonly holdId: string;
  readonly externalRef: string;
  readonly creditedAt: string;
  readonly availableAt: string;
  readonly creditedCents: bigint;
  /** What the hold withholds right now, under `ledger_availability`'s own predicate. */
  readonly heldCents: bigint;
  readonly bankingDaysHold: number;
  readonly releaseLocalTime: string;
}

/**
 * `v_wire_credit`, read.
 *
 * The three numbers a demo needs side by side: what was credited, what is
 * withheld, and the policy that decided. Run it straight after booking a wire
 * and read the zero in `heldCents` — that zero is `ledger_availability()`'s
 * own release predicate answering, not this module's opinion.
 */
export async function readWireCredits(
  accountId: string,
  conn: Sql = sql,
): Promise<readonly WireAvailabilityProof[]> {
  const rows = await conn<
    {
      hold_id: string;
      external_ref: string;
      credited_at: Date;
      available_at: Date;
      credited_cents: bigint | null;
      held_cents: bigint | null;
      banking_days_hold: number | null;
      release_local_time: string | null;
    }[]
  >`
    SELECT hold_id, external_ref, credited_at, available_at,
           credited_cents, held_cents, banking_days_hold, release_local_time
      FROM v_wire_credit
     WHERE account_id = ${accountId}::uuid
     ORDER BY credited_at DESC`;

  return rows.map((r) => ({
    holdId: r.hold_id,
    externalRef: r.external_ref,
    creditedAt: r.credited_at.toISOString(),
    availableAt: r.available_at.toISOString(),
    // `amount_cents * normal_side` is ALREADY the customer-facing sign: a
    // deposit account is credit-normal, so a credit of -75000 amount_cents
    // times normal_side -1 is +75000 — the number on their statement. The
    // first draft negated both of these and reported a $750 receipt as
    // -75000; `v_wire_credit` is read by a demo, so the sign is asserted in
    // the integration test rather than reasoned about at the call site.
    creditedCents: r.credited_cents ?? 0n,
    heldCents: r.held_cents ?? 0n,
    bankingDaysHold: r.banking_days_hold ?? 0,
    releaseLocalTime: r.release_local_time ?? '00:00:00',
  }));
}

/**
 * The invariant, read: holds on this rail that actually bound.
 *
 * MUST BE EMPTY. A row is a bug in the posting path or in the policy data, and
 * nothing repairs it by editing a number — the fix is a new policy version or
 * a correcting entry.
 */
export async function readWireAvailabilityDrift(
  conn: Sql = sql,
): Promise<readonly { readonly holdId: string; readonly externalRef: string; readonly withheldFor: string }[]> {
  const rows = await conn<
    { hold_id: string; external_ref: string; withheld_for: string }[]
  >`
    SELECT hold_id, external_ref, withheld_for::text AS withheld_for
      FROM v_wire_availability_drift`;
  return rows.map((r) => ({
    holdId: r.hold_id,
    externalRef: r.external_ref,
    withheldFor: r.withheld_for,
  }));
}
