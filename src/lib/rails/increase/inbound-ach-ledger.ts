/**
 * Booking an inbound ACH credit, and the recall that takes it back.
 *
 * ─── THE CLAIM THIS FILE EXISTS TO MAKE GOOD ────────────────────────────────
 *
 * An inbound ACH credit is subject to a funds-availability hold and an inbound
 * WIRE is not. Both arrive as money in the same FBO account; one is spendable
 * the instant it is booked and the other is not, and the difference must fall
 * out of the model rather than be special-cased into it.
 *
 * "Falls out" is a strong claim, so here is the standard it is held to. THERE
 * IS NO RAIL IN AN `if` IN THIS FILE. `creditInboundAch()` writes the same
 * `uncleared_credit` hold row as `creditInboundWire()`, cites a `policy_id`
 * from the same `funds_availability_policy` table, posts the same memo pair
 * against the same 9200/9900 accounts, and reads the same
 * `scheduleAvailability()` — `../plaid/availability.ts`, imported rather than
 * copied, so that "the arithmetic is the same" is checkable and not assertable.
 *
 * The two rails diverge on ONE ROW OF DATA each:
 *
 *     rail='wire' counterparty_class='n/a' banking_days_hold=0  release 00:00
 *     rail='ach'  counterparty_class='new' banking_days_hold=2  release 09:00 ET
 *
 * `addBankingDays(d, 0) === d`, so a wire hold is born released and
 * `v_wire_availability_drift` asserts it. `addBankingDays(d, 2)` is two banking
 * days later, so an ACH hold BINDS: the ledger balance moves and the available
 * balance does not, until the availability sweep on the drain releases it. Same
 * code, same table, two rows, two behaviours — which is the whole point of
 * having the policy be data.
 *
 * ─── WHY THE CLASS IS ALWAYS `new`, AND WHY THAT IS NOT LAZINESS ────────────
 *
 * The ACH classes price RETURN RISK: `self` is the customer's own verified
 * external account, `known` is a counterparty seen at least three times over
 * sixty days, `new` is a stranger. An inbound credit arrives from an originator
 * we have never underwritten, on a rail where an unauthorised debit can be
 * returned for sixty calendar days, and this build keeps no inbound-originator
 * history at all. Grading one into `known` would mean inventing the history the
 * class is defined by. `new` is the class the evidence supports, and it is the
 * only one of the three that cannot make money spendable too early.
 *
 * ─── 1110, NOT 1130, AND THE MEASUREMENT THAT DECIDES IT ────────────────────
 *
 *   1110  Cash — FBO settlement account at sponsor bank
 *   1130  ACH receivable — inbound in transit
 *
 * `rails/plaid/adapter.ts` debits 1130 because that path ORIGINATES a debit
 * pull that was never transmitted to any network: nobody has sent us anything
 * and the counterparty bank owes us. An `inbound_ach_transfer` is the opposite
 * situation — an ODFI really did send funds and Increase really did credit the
 * FBO account. MEASURED on `sandbox_inbound_ach_transfer_07x75nyvzd1oxihtvuoe`:
 * the object carries `acceptance.accepted_at` WITH A `transaction_id`, and
 * `settlement.settled_at`, at the same instant it was created. The money is at
 * the bank. 1110's own chart note says it is "debited when funds actually land
 * there ... never when a provider merely promises them", and 1130 carries
 * `railControl: 'ach'` for the outbound-receivable sense. So this path debits
 * 1110, exactly as the wire path does, and for the same reason: it is a fact
 * about where the money is, not a fact about which rail carried it.
 *
 * A transfer Increase has NOT yet accepted is refused rather than booked early
 * — see `ACCEPTANCE_REQUIRED` below. That is the case 1130 would be for, and
 * this build parks it instead of inventing a receivable it cannot discharge.
 *
 * ─── THE RECALL ─────────────────────────────────────────────────────────────
 *
 * `recallInboundAch()` is a NEW EVENT at the recall's own value date, never an
 * edit and never a reversal at the credit's date. The money really did arrive
 * on the effective date and really did go back on `transfer_return.returned_at`,
 * so the arrival day's statement still shows the arrival — which is what
 * `rail_event_semantics` says in the row for
 * `inbound_ach_transfer.updated/returned`, and what the brief means by "the
 * corrected position appears on the day it happened".
 *
 * IT ALSO CLOSES THE HOLD, in the same transaction, and that is the half that
 * is easy to miss. Available = ledger − holds. If the recall debited the
 * customer and left the uncleared-credit hold standing, the same money would be
 * withheld twice: the ledger would fall by the amount AND the hold would go on
 * withholding it, so available would fall by twice the credit for a customer
 * who never had it. The hold exists to withhold a credit that might be taken
 * back; once it HAS been taken back there is nothing left to withhold.
 */

import "server-only";

import { closeHold } from "@/lib/holds/store";
import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
// NAMED READERS, never SQL of our own against the ledger's tables. See
// `src/lib/ledger/boundary.test.ts`, which is a ratchet and is right to be.
import {
  holdMemoCents,
  mainDepositAccountId,
  readAccountIdentity,
  resolveChartCodes,
} from "@/lib/ledger/queries";

import { effectiveAvailabilityPolicy } from "../plaid/adapter";
import { scheduleAvailability, type AvailabilitySchedule, type ValueDate } from "../plaid/availability";

/* -------------------------------------------------------------------------- */
/* Chart codes and constants                                                  */
/* -------------------------------------------------------------------------- */

/** Cash actually at the sponsor bank. See the header on 1110 vs 1130. */
const FBO_CASH_CODE = "1110";
// 2100 is not here: `mainDepositAccountId()` owns that code, and a second copy
// of it would be a second opinion about which leaf is spendable.
const UNCLEARED_HOLD_CODE = "9200";
const MEMO_CONTRA_CODE = "9900";

/** See the header: the only class the evidence supports for a stranger. */
const INBOUND_COUNTERPARTY_CLASS = "new";

/** `ach:inbound:<transfer id>` — the credit. One per inbound transfer. */
export const INBOUND_CREDIT_KEY_PREFIX = "ach:inbound:";

/**
 * The hold's join key, and the credit's external ref.
 *
 * `increase.ach:inbound:<transfer id>`, matching `increase.wire:<transfer id>`
 * on the wire path. The provider's transfer id and never the trace number: a
 * trace number is the NACHA file's identity for the entry and is not unique
 * across originators, and `hold_ref UNIQUE (kind, external_ref)` is the thing
 * standing between one credit and two holds.
 */
export function inboundAchExternalRef(transferId: string): string {
  return `increase.ach:inbound:${transferId}`;
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

export class InboundAchBookingRefused extends Error {
  override readonly name = "InboundAchBookingRefused";
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

interface InboundAchChart {
  readonly entityId: string;
  readonly depositAccountId: string;
  readonly memoAccountId: string;
  readonly cashAccountId: string;
  readonly memoContraAccountId: string;
}

async function resolveChart(businessId: string, conn: Sql): Promise<InboundAchChart> {
  const depositAccountId = await mainDepositAccountId(businessId, conn);
  if (depositAccountId === null) {
    throw new InboundAchBookingRefused(
      "NO_DEPOSIT_ACCOUNT",
      `Business ${businessId} has no 2100 deposit account on this book, so there is nowhere for an inbound ACH credit to land. A business gets one when it is onboarded; until then a credit addressed to its account number is money with an owner and no account.`,
    );
  }

  const deposit = await readAccountIdentity(depositAccountId, conn);
  if (deposit === null) {
    throw new InboundAchBookingRefused(
      "NO_DEPOSIT_ACCOUNT",
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
  // stays this module's error to raise — the contract `resolveChartCodes`
  // documents, and the right side of the line: the ledger knows what the chart
  // holds, the rail knows what it needs.
  if (cash === undefined || memo === undefined || contra === undefined) {
    const missing = [
      cash === undefined ? FBO_CASH_CODE : null,
      memo === undefined ? UNCLEARED_HOLD_CODE : null,
      contra === undefined ? MEMO_CONTRA_CODE : null,
    ].filter((code): code is string => code !== null);
    throw new InboundAchBookingRefused(
      "CHART_INCOMPLETE",
      `The chart is missing ${missing.join(", ")} for entity ${deposit.entityId}${
        missing.includes(UNCLEARED_HOLD_CODE) ? ` / business ${businessId}` : ""
      }. An inbound ACH credit needs cash, an uncleared-credit leaf and a memo contra before it can post. NOTHING WAS POSTED.`,
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
    throw new InboundAchBookingRefused(
      "NO_POSTER_ACTOR",
      "No 'ledger-poster' system actor exists; run scripts/seed.mjs.",
    );
  }
  return row.id;
}

/* -------------------------------------------------------------------------- */
/* Inbound: the credit                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What this module needs to know about an arrival.
 *
 * Read off `IncreaseInboundAchTransfer` by the consumer, not re-read here: the
 * value date in particular comes from the field `rail_event_semantics` names
 * (`payload.effective_date`), resolved by the consumer's
 * `valueDateFromSource()`, so this module cannot pick a different day than the
 * table says. That is the point of passing it in rather than deriving it.
 */
export interface InboundAchCredit {
  readonly transferId: string;
  readonly amountCents: bigint;
  readonly valueDate: ValueDate;
  readonly originatorName: string | null;
  readonly traceNumber: string | null;
  readonly entryDescription: string | null;
  /** True once Increase has accepted it; false parks. See ACCEPTANCE_REQUIRED. */
  readonly accepted: boolean;
  readonly inboxId: string | null;
}

export interface InboundAchCreditReceipt {
  readonly entryId: string;
  /** The memo entry that OPENS the hold. Always written on a first booking. */
  readonly memoEntryId: string;
  readonly holdId: string;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: ValueDate;
  readonly schedule: AvailabilitySchedule;
  readonly policyId: string;
  /** False on a replay: the hold already existed and nothing new was written. */
  readonly created: boolean;
}

/**
 * Book an inbound ACH credit, and open the availability hold the policy asks
 * for.
 *
 * One transaction: the hold row, the financial entry and the memo entry commit
 * together or not at all. A crash between the financial entry and the memo one
 * would leave the customer able to spend money that has not cleared, which on
 * this rail is not a harmless window — it is the exact failure the hold exists
 * to prevent.
 *
 * Replay is decided by the database, not by an `if`: `hold_ref UNIQUE (kind,
 * external_ref)` on the hold and `journal_entry`'s idempotency key on both
 * entries. Every key is derived from the TRANSFER, never from the delivery, so
 * the `.created` notification and the `.updated` one that overtakes it both
 * assert the same fact and the second posts nothing.
 */
export async function creditInboundAch(args: {
  readonly businessId: string;
  readonly credit: InboundAchCredit;
  readonly conn?: Sql | undefined;
  readonly actorId?: string | undefined;
}): Promise<InboundAchCreditReceipt> {
  const conn = args.conn ?? sql;
  const credit = args.credit;

  if (credit.amountCents <= 0n) {
    throw new InboundAchBookingRefused(
      "INVALID_AMOUNT",
      "An inbound ACH credit must be a positive integer number of cents. Zero is not a receipt, and a negative one is a DEBIT PULL — money leaving over a rail this build does not model.",
    );
  }

  if (!credit.accepted) {
    // ACCEPTANCE_REQUIRED. Increase can hold an inbound transfer for a decision
    // before it credits the FBO account, and until it has, the money is not at
    // the sponsor bank. Booking DR 1110 then would assert cash we do not have;
    // booking DR 1130 would invent a receivable with no discharge path. The
    // delivery parks and the next re-check reads the object again — which is
    // the same convergence every other step on this rail relies on.
    throw new InboundAchBookingRefused(
      "ACCEPTANCE_REQUIRED",
      `Inbound ACH ${credit.transferId} has not been accepted by Increase yet: no acceptance and no settlement on the object, so the money is not in the FBO account. NOTHING WAS POSTED. The delivery re-checks and books it the moment the object says the funds landed.`,
    );
  }

  const externalRef = inboundAchExternalRef(credit.transferId);

  // The policy in force ON THIS VALUE DATE, never today's — so a policy change
  // tomorrow cannot retroactively alter how long a credit booked today was
  // held.
  const policy = await effectiveAvailabilityPolicy(
    { rail: "ach", counterpartyClass: INBOUND_COUNTERPARTY_CLASS, valueDate: credit.valueDate },
    conn,
  );
  if (policy === null) {
    // NOT a default of "release immediately". A missing row means nobody has
    // decided how long this money is at risk for, and guessing zero is the one
    // answer that can lose money. The identical refusal the Plaid funding path
    // and the wire path make, kept identical on purpose.
    throw new InboundAchBookingRefused(
      "NO_AVAILABILITY_POLICY",
      `No funds_availability_policy row covers rail 'ach' / counterparty class '${INBOUND_COUNTERPARTY_CLASS}' at value date ${credit.valueDate}. Nothing was booked: a credit whose availability nobody has decided is not one this system will make spendable by default.`,
    );
  }

  const schedule = scheduleAvailability(policy, credit.valueDate);
  const chart = await resolveChart(args.businessId, conn);
  const actorId = args.actorId ?? (await posterActorId(conn));
  const amountCents = credit.amountCents;
  const from = credit.originatorName ?? "an unnamed originator";
  const trace = credit.traceNumber === null ? "no trace number" : `trace ${credit.traceNumber}`;

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO hold (account_id, memo_account_id, kind, external_ref,
                        value_date, available_at, policy_id)
      VALUES (${chart.depositAccountId}::uuid, ${chart.memoAccountId}::uuid,
              'uncleared_credit', ${externalRef}, ${credit.valueDate}::date,
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
      throw new InboundAchBookingRefused(
        "HOLD_NOT_WRITTEN",
        `Failed to create or find the uncleared-credit hold for ${externalRef}.`,
      );
    }

    const entryId = await postEntry(
      {
        entityId: chart.entityId,
        valueDate: credit.valueDate,
        book: "financial",
        description: `Inbound ACH credit from ${from} — ${trace}${
          credit.entryDescription === null ? "" : `, "${credit.entryDescription}"`
        }`,
        idempotencyKey: `${INBOUND_CREDIT_KEY_PREFIX}${credit.transferId}`,
        actorId,
        rail: "ach",
        externalRef,
        ...(credit.inboxId === null ? {} : { inboxId: credit.inboxId }),
        lines: [
          // DR 1110: the funds are at the sponsor bank — see the header.
          { accountId: chart.cashAccountId, amountCents, memo: `inbound ACH from ${from}` },
          // CR the customer. Money in is a credit to a deposit account, because
          // the customer having money is the bank owing money.
          {
            accountId: chart.depositAccountId,
            amountCents: -amountCents,
            memo: `inbound ACH ${credit.transferId}`,
          },
        ],
      },
      tx,
    );

    const memoEntryId = await postEntry(
      {
        entityId: chart.entityId,
        valueDate: credit.valueDate,
        book: "memo",
        description: `Uncleared credit held to ${schedule.releaseDate} ${policy.releaseLocalTime} ET (${policy.rail}/${policy.counterpartyClass}, ${policy.bankingDaysHold} banking day${policy.bankingDaysHold === 1 ? "" : "s"})`,
        idempotencyKey: `hold:${holdId}:after:${externalRef}`,
        actorId,
        rail: "ach",
        externalRef,
        holdId,
        ...(credit.inboxId === null ? {} : { inboxId: credit.inboxId }),
        lines: [
          // The 9200 leaf is credit-normal, so a POSITIVE hold is a NEGATIVE
          // amount_cents. Getting that inversion wrong is the classic error.
          { accountId: chart.memoAccountId, amountCents: -amountCents },
          { accountId: chart.memoContraAccountId, amountCents },
        ],
      },
      tx,
    );

    return {
      entryId,
      memoEntryId,
      holdId,
      externalRef,
      amountCents,
      valueDate: credit.valueDate,
      schedule,
      policyId: policy.id,
      created,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Inbound: the recall                                                        */
/* -------------------------------------------------------------------------- */

export interface InboundAchRecall {
  readonly transferId: string;
  readonly amountCents: bigint;
  /** From `payload.transfer_return.returned_at` — the field the table names. */
  readonly valueDate: ValueDate;
  readonly reason: string;
  /** Increase's transaction id for the return. Part of the idempotency key. */
  readonly returnTransactionId: string | null;
  readonly inboxId: string | null;
}

export interface InboundAchRecallReceipt {
  readonly entryId: string;
  /** The memo entry that closes the availability hold. Null if it was flat. */
  readonly holdReleaseEntryId: string | null;
  readonly holdId: string | null;
  /** True if THIS call wrote the closure row, false if it was already closed. */
  readonly holdClosedHere: boolean;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: ValueDate;
}

/**
 * The credit went back to the originator. A NEW EVENT, at the day it happened.
 *
 * Never a reversal at the credit's value date: the arrival really did happen on
 * the effective date and the arrival day's statement must go on saying so. The
 * corrected position appears on the recall's own day, which is what makes the
 * ledger agree with the customer's own bank statement instead of with a tidier
 * story.
 *
 * The customer can end up overdrawn — they may have spent it once the hold
 * released — and that is the honest outcome. `ledger_availability` is
 * explicitly allowed to go negative rather than clamp, because clamping hides a
 * real overdraft behind a floor.
 */
export async function recallInboundAch(args: {
  readonly businessId: string;
  readonly recall: InboundAchRecall;
  readonly conn?: Sql | undefined;
  readonly actorId?: string | undefined;
}): Promise<InboundAchRecallReceipt> {
  const conn = args.conn ?? sql;
  const recall = args.recall;

  if (recall.amountCents <= 0n) {
    throw new InboundAchBookingRefused(
      "INVALID_AMOUNT",
      "A recall of an inbound ACH credit is the credit going back: a positive number of cents, taken the other way.",
    );
  }

  const externalRef = inboundAchExternalRef(recall.transferId);
  const chart = await resolveChart(args.businessId, conn);
  const actorId = args.actorId ?? (await posterActorId(conn));
  const amountCents = recall.amountCents;

  // The hold the arrival opened, if it is still there. Read OUTSIDE the
  // transaction deliberately: it is an index lookup on `hold_ref UNIQUE (kind,
  // external_ref)` and nothing writes holds for this ref except the credit
  // above, which has already committed by the time a recall can exist.
  const [holdRow] = await conn<{ id: string; memo_account_id: string }[]>`
    SELECT id, memo_account_id
      FROM hold
     WHERE kind = 'uncleared_credit' AND external_ref = ${externalRef}
     LIMIT 1`;

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    const entryId = await postEntry(
      {
        entityId: chart.entityId,
        // THE DAY IT HAPPENED, from `transfer_return.returned_at`, never today
        // and never the arrival's day.
        valueDate: recall.valueDate,
        book: "financial",
        description: `Inbound ACH recalled (${recall.reason}) — ${recall.transferId}`,
        // The return's own transaction id is in the key for the same reason the
        // outbound return keys on its trace number: one transfer carries one
        // return today and might carry a second tomorrow, and keying on the
        // transfer alone would make the second invisible — the failure mode
        // that looks like everything is fine.
        idempotencyKey: `${INBOUND_CREDIT_KEY_PREFIX}recall:${recall.transferId}:${
          recall.returnTransactionId ?? "no-transaction"
        }`,
        actorId,
        rail: "ach",
        externalRef,
        ...(recall.inboxId === null ? {} : { inboxId: recall.inboxId }),
        lines: [
          // DR the customer: the money they were credited has gone back.
          {
            accountId: chart.depositAccountId,
            amountCents,
            memo: `inbound ACH recalled (${recall.reason})`,
          },
          // CR 1110: it left the FBO account the way it came in.
          {
            accountId: chart.cashAccountId,
            amountCents: -amountCents,
            memo: `returned to the originator — ${recall.transferId}`,
          },
        ],
      },
      tx,
    );

    if (holdRow === undefined) {
      // No hold: either this book never booked the credit (the consumer refuses
      // to reach here in that case) or a repair removed it. Nothing to release.
      return {
        entryId,
        holdReleaseEntryId: null,
        holdId: null,
        holdClosedHere: false,
        externalRef,
        amountCents,
        valueDate: recall.valueDate,
      };
    }

    // Closure FIRST, posting second — the sweeper's own crash-safety order.
    // `v_hold_state` reads released off this row, so a process that died in
    // between would leave the customer's available balance already correct.
    //
    // NO `source` ARGUMENT, and the reason is a scope fact rather than a
    // preference. `ClosureSource` (src/lib/holds/store.ts) is a closed union of
    // eight writers and `hold_closure_source_known` (migration 0040) is the
    // matching CHECK; neither has a value for "the credit was recalled", and
    // both live outside this change's write set. Passing `wire_availability` or
    // `availability_sweep` would be a false statement about who closed this
    // hold, which is precisely what 0040 exists to stop — it replaced a guard
    // that discriminated on PROSE with one that discriminates on a value.
    //
    // The two sibling uncleared-credit closers pass none either
    // (`rails/plaid/adapter.ts`, `rails/wire/ledger.ts`); their historical rows
    // carry a source only because 0040 backfilled it from their reason strings.
    // So this closure reads `(undeclared)` in `dbcheck`'s GUARD REACH census,
    // alongside theirs, and hides nothing from a guard:
    // `v_hold_closure_not_terminal` cannot see an `uncleared_credit` hold at all
    // — it INNER JOINs `card_authorization` — and `dbcheck`'s source assertion
    // is drawn from the card-auth population only. The follow-up is one union
    // member, one CHECK arm and this argument.
    const holdClosedHere = await closeHold(
      holdRow.id,
      `inbound ACH ${recall.transferId} was recalled on ${recall.valueDate} (${recall.reason}); the credit this hold withheld has gone back to the originator, so there is nothing left to withhold`,
      actorId,
      tx,
    );

    // What the memo book still withholds — asked, not assumed. If the
    // availability sweep already released it, this is zero and the right amount
    // of bookkeeping is none.
    const held = await holdMemoCents(
      { holdId: holdRow.id, memoAccountId: holdRow.memo_account_id },
      tx,
    );
    if (held === 0n) {
      return {
        entryId,
        holdReleaseEntryId: null,
        holdId: holdRow.id,
        holdClosedHere,
        externalRef,
        amountCents,
        valueDate: recall.valueDate,
      };
    }

    const holdReleaseEntryId = await postEntry(
      {
        entityId: chart.entityId,
        // The RECALL's value date, because that is the day the hold stopped
        // being owed. Not today, and not the arrival's day.
        valueDate: recall.valueDate,
        book: "memo",
        description: "Uncleared-credit hold released — the credit was recalled, so there is nothing left to withhold",
        idempotencyKey: `hold:${holdRow.id}:after:recall:${recall.transferId}`,
        actorId,
        rail: "ach",
        externalRef,
        holdId: holdRow.id,
        ...(recall.inboxId === null ? {} : { inboxId: recall.inboxId }),
        lines: [
          // Debit the customer's 9200 leaf back to zero. `held` rather than the
          // recall amount: the memo book says what is actually withheld, and a
          // partial release earlier would make the two differ.
          { accountId: chart.memoAccountId, amountCents: held },
          { accountId: chart.memoContraAccountId, amountCents: -held },
        ],
      },
      tx,
    );

    return {
      entryId,
      holdReleaseEntryId,
      holdId: holdRow.id,
      holdClosedHere,
      externalRef,
      amountCents,
      valueDate: recall.valueDate,
    };
  });
}
