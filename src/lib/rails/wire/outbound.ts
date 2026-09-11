/**
 * Outbound wires — the provider leg, and nothing else.
 *
 * ─── THERE IS NO SECOND MONEY-OUT PATH, AND ALMOST NO NEW CODE ──────────────
 *
 * An outbound wire goes through `requestPayment()` exactly as an ACH payment
 * does, and it already worked before this rail existed. That is not an accident
 * and it is worth setting out, because the interesting finding is how little
 * had to be written:
 *
 *   `PAYOUT_RAILS`              already contains 'wire'
 *   `rail` enum (0001)          already contains 'wire'
 *   `destinationSchema`         already has a `wire` variant
 *   `approval_policy`           is effective-dated DATA keyed by rail, so the
 *                               wire threshold is a row, not a branch
 *   `transactGateForAccount()`  the KYB gate, inside requestPayment's own
 *                               transaction, rail-agnostic
 *   `assert_maker_checker()`    a database trigger, rail-agnostic
 *   `releasePayment()`          already maps wire to house account 1110 with
 *                               the right reasoning already written down:
 *                               "the cash is gone the moment a wire leaves;
 *                               there is no in-transit window worth modelling
 *                               on an irrevocable rail"
 *
 * So maker-checker, the KYB gate, payee confirmation, the content hash, the
 * approve-the-hash trigger and the ledger posting are all reached with zero
 * new code. What this file adds is the one thing that genuinely was missing:
 * putting the instruction on Fedwire afterwards.
 *
 * ─── WHERE THE WIRE ABA COMES FROM. DECIDED 2026-09-11 ──────────────────────
 *
 * This file used to record a finding: `destinationSchema`'s wire variant was
 * `{ type: 'wire', holderName, bic, accountNumberLast4 }`, a BIC is a SWIFT
 * identifier for a bank rather than a Fedwire address, so the ABA had nowhere
 * to live on the instruction and this module resolved it from the payee book
 * instead. `wireRoutingNumber` then arrived on the schema and
 * `gatePaymentOnPayee()` began demanding it — and the two halves of the rail
 * disagreed about where the address came from. That is now settled, and the
 * full argument is in the header of `src/lib/payees/gate.ts`:
 *
 *   THE CONFIRMED PAYEE BOOK IS AUTHORITATIVE, AND THE INSTRUCTION CARRIES A
 *   COPY OF THE BOOK'S NUMBER SO THAT IT IS INSIDE THE APPROVED CONTENT HASH.
 *
 * The short form of why: `payment_instruction.content_hash` is what an
 * approver must cite, and it covers `counterparty`. Leave the ABA off the
 * instruction and the one fact that decides WHICH BANK RECEIVES THE MONEY sits
 * outside the thing two humans signed, re-resolved later from a table that
 * grows rows. It reads well until somebody archives a payee and appends a
 * same-name, same-last-four payee at a different bank, at which point an
 * already-approved wire addresses itself somewhere new and no approval
 * changed, because no approval ever covered it.
 *
 * WHAT DID NOT CHANGE, AND IS THE CONTROL THIS RAIL ACTUALLY NEEDS:
 *
 *   THE BENEFICIARY MUST BE ON THE CONFIRMED BOOK. `gatePaymentOnPayee()`
 *   deliberately does NOT require a payee to be pre-registered, and its
 *   reasoning is right for ACH: "it breaks the one-off refund, the emergency
 *   supplier payment, the payment raised by the MCP agent from an invoice".
 *   Every one of those costs is a cost of DELAY, and on ACH a delay is
 *   recoverable because the entry is. On a wire it is not, and the attack is
 *   business email compromise: a well-formed instruction to a real bank for a
 *   real-sounding beneficiary, urgent, from a real mailbox. "Emergency
 *   supplier payment, right now, to a beneficiary nobody has seen before" is
 *   not an edge case this control breaks — it is a verbatim description of the
 *   fraud. So on this rail, and only this rail, the beneficiary must be on the
 *   book, with its routing number checked (`src/lib/payees/aba.ts`) and looked
 *   up in Increase's routing-number directory (`wire_transfers: "supported"`)
 *   before anyone can be asked to approve it.
 *
 * WHAT MOVED. That refusal used to happen HERE and nowhere else — after two
 * approvals and a ledger entry, which is a refusal two signatures too late.
 * The gate now makes it at `requestPayment()`, over the same reader
 * (`loadWireBeneficiaries`, one predicate, one file). This function keeps
 * making it too, because the gate speaks for the book as it was on the way IN
 * and this is the last moment before the money is unrecoverable — and it adds
 * one refusal the gate cannot make, `WIRE_ROUTING_NUMBER_NOT_CONFIRMED`, for
 * the case where the two moments disagree.
 */

import 'server-only';

import { getPayment } from '@/lib/approvals';
import type { PaymentDestination, QueuedPayment } from '@/lib/approvals/types';
import { sql, type Sql } from '@/lib/ledger/db';
import { readAccountIdentity } from '@/lib/ledger/queries';
import { checkRoutingNumber } from '@/lib/payees/aba';
import { loadWireBeneficiaries } from '@/lib/payees/store';

import type { RailOrigination } from '../contract';
import { usd } from '../types';

import { increaseWireAdapter, type IncreaseWireAdapter } from './adapter';
import type { WireBeneficiary, WireInstruction } from './types';

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

export class WireOriginationRefused extends Error {
  override readonly name = 'WireOriginationRefused';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* Resolving the beneficiary                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedWireBeneficiary {
  readonly payeeId: string;
  readonly displayName: string;
  readonly holderName: string;
  readonly wireRoutingNumber: string;
  readonly institutionName: string | null;
  /** Increase's routing directory on this number. Null when never asked. */
  readonly wireSupported: boolean | null;
  readonly lastVerifiedAt: string | null;
}

/**
 * Find the wire beneficiary on this business's payee book.
 *
 * Matched on `(rail = 'wire', holderName, accountNumberLast4)` — the three
 * things every wire instruction carries, including the ten that predate
 * `wireRoutingNumber`. Deliberately NOT matched on the BIC: a BIC identifies a
 * bank, not an account, and matching a beneficiary on their bank would happily
 * route a payment to the wrong customer of the right bank. The predicate is
 * `loadWireBeneficiaries()` and the gate uses the same one.
 *
 * Every refusal below is a REFUSAL and not a warning, which is the opposite of
 * how `gatePaymentOnPayee()` treats a name-match finding, and deliberately so:
 * a warning is overridable by a named human because names legitimately differ,
 * whereas none of these has a legitimate explanation at this point in the
 * flow. This sits after two humans have already approved, at the last moment
 * before the money is unrecoverable.
 */
export async function resolveWireBeneficiary(
  args: {
    readonly businessId: string;
    readonly destination: PaymentDestination;
  },
  conn: Sql = sql,
): Promise<ResolvedWireBeneficiary> {
  if (args.destination.type !== 'wire') {
    throw new WireOriginationRefused(
      'NOT_A_WIRE_DESTINATION',
      `This is a ${args.destination.type} destination; the wire rail will not originate it.`,
    );
  }
  const destination = args.destination;

  // ONE MATCHING RULE, AND IT LIVES IN `src/lib/payees/store.ts`. This used to
  // be a `loadPayeeBook()` plus a filter written here, which meant the gate at
  // `requestPayment()` and this function each owned a copy of the predicate
  // that decides which beneficiary a wire is for. Two copies of that rule is
  // two answers to "did a human confirm this beneficiary", and the whole
  // control is that they are the same answer at both moments.
  const matches = await loadWireBeneficiaries(
    {
      businessId: args.businessId,
      holderName: destination.holderName,
      accountNumberLast4: destination.accountNumberLast4,
    },
    conn,
  );

  // ─── THE APPROVED NUMBER MUST STILL BE THE BOOK'S NUMBER ─────────────────
  //
  // The instruction carries the wire ABA — see `gatePaymentOnPayee()`'s header
  // for the decision and why maker-checker is what settles it — and the gate
  // proved at `requestPayment()` that it came from the confirmed book. This
  // proves it is STILL the confirmed book's, now, at the last moment before
  // the money is unrecoverable.
  //
  // WHAT THAT CLOSES, EXACTLY. The payee book is append-only, but it is not
  // frozen: a payee can be archived and a same-name, same-last-four payee
  // added at a DIFFERENT bank, both of them appends. Without this check an
  // instruction approved on Tuesday would address itself to Thursday's book,
  // silently, with two signatures on a number nobody sent to. With it, the
  // divergence is a refusal before origination — a reconciliation break, which
  // this system has a screen for, rather than money at the wrong bank, which
  // nothing has a remedy for.
  //
  // `wireRoutingNumber` is `undefined` on the ten pre-`wireRoutingNumber`
  // instructions, including the $42.00 wire that really went out. Those keep
  // exactly the behaviour they had: resolved from the book, ambiguity refused
  // below. A required field here would rewrite history by refusing to read it.
  const stated = destination.wireRoutingNumber;
  const candidates =
    stated === undefined ? matches : matches.filter((p) => p.routingNumber === stated);

  if (stated !== undefined && candidates.length === 0 && matches.length > 0) {
    const known = [...new Set(matches.map((p) => p.routingNumber ?? 'none'))];
    throw new WireOriginationRefused(
      'WIRE_ROUTING_NUMBER_NOT_CONFIRMED',
      `The approved instruction addresses "${destination.holderName}" ••${destination.accountNumberLast4} at ${stated}, and this business's payee book does not confirm that beneficiary at that bank — it confirms ${known.join(' or ')}. The book changed after the payment was approved, or the number never came from it. Two people signed for ${stated} and a wire cannot be recalled, so nothing is sent and the number is not quietly swapped for the book's. Re-confirm the beneficiary on /payees and raise the payment again.`,
    );
  }

  if (candidates.length === 0) {
    throw new WireOriginationRefused(
      'WIRE_PAYEE_NOT_ON_BOOK',
      `No confirmed wire payee matches "${destination.holderName}" ••${destination.accountNumberLast4} on this business's payee book. A wire is final on receipt and business email compromise is a WELL-FORMED instruction, so this rail will not address a beneficiary nobody has checked. Add the payee, let the routing number be checked, then raise the payment. Nothing was sent and no money moved.`,
    );
  }

  // More than one match means two book entries claim the same beneficiary and
  // the same last four with different routing numbers. Picking one would be
  // picking which bank gets the money, which is not a decision code may make.
  const distinct = new Set(candidates.map((p) => p.routingNumber ?? ''));
  if (distinct.size > 1) {
    throw new WireOriginationRefused(
      'WIRE_PAYEE_AMBIGUOUS',
      `${candidates.length} payee records match "${destination.holderName}" ••${destination.accountNumberLast4} with ${distinct.size} different routing numbers. Resolving that by picking one would be choosing which bank receives the money. Archive the wrong record first.`,
    );
  }

  const payee = candidates[0];
  if (payee === undefined) {
    // Unreachable — `candidates.length === 0` is handled above — but
    // `noUncheckedIndexedAccess` is on and an assertion here would be a
    // non-null on a payments path.
    throw new WireOriginationRefused('WIRE_PAYEE_NOT_ON_BOOK', 'No payee resolved.');
  }

  const routingNumber = payee.routingNumber;
  if (routingNumber === null) {
    throw new WireOriginationRefused(
      'WIRE_PAYEE_HAS_NO_ROUTING_NUMBER',
      `Payee "${payee.displayName}" is on the book for the wire rail but carries no routing number, so there is no Fedwire address to send to. A BIC is not one: a domestic wire is routed by the bank's 9-digit WIRE ABA, which is a different number from its ACH ABA.`,
    );
  }

  // The check digit, again, here. It ran when the payee was saved; the money
  // leaves here. Arithmetic is free and a book row could have been written by
  // a path that did not check.
  const verdict = checkRoutingNumber(routingNumber);
  if (!verdict.valid) {
    throw new WireOriginationRefused(
      'WIRE_ROUTING_NUMBER_IMPOSSIBLE',
      `The routing number on payee "${payee.displayName}" is not a valid ABA: ${verdict.message}`,
    );
  }

  // A directory answer of FALSE is a refusal; a directory answer of NULL is
  // not. `wireSupported === false` means Increase's routing-number directory
  // says this institution does not receive wires — sending anyway produces a
  // rejection at best. `null` means nobody asked, or the sandbox directory
  // (which returns an empty array for real routing numbers, including
  // 021000021) had nothing to say, and absence of evidence stops nothing.
  if (payee.wireSupported === false) {
    throw new WireOriginationRefused(
      'WIRE_NOT_SUPPORTED_BY_INSTITUTION',
      `The routing-number directory reports that ${payee.institutionName ?? 'this institution'} (${routingNumber}) does not receive wires. This is very often the ACH variant of the routing number being used in a wire field — the seeded Plaid item, for instance, carries 011401533 for ACH and 021000021 for wire, and they are not interchangeable.`,
    );
  }

  return {
    payeeId: payee.payeeId,
    displayName: payee.displayName,
    holderName: payee.holderName,
    wireRoutingNumber: routingNumber,
    institutionName: payee.institutionName,
    wireSupported: payee.wireSupported,
    lastVerifiedAt: payee.checkedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Originating an approved, released instruction                              */
/* -------------------------------------------------------------------------- */

export interface OriginateApprovedWireArgs {
  readonly instructionId: string;
  /**
   * The full beneficiary account number, which the instruction deliberately
   * does not carry — `payment_instruction.counterparty` stores the last four
   * only, because "the approver needs to recognise the counterparty, not to be
   * able to re-key the payment somewhere else". It is supplied at the wire
   * boundary and never persisted here.
   */
  readonly beneficiaryAccountNumber: string;
  /** The Increase account the money leaves. */
  readonly sourceAccountId: string;
  readonly adapter?: IncreaseWireAdapter | undefined;
  readonly conn?: Sql | undefined;
}

export interface OriginatedWire {
  readonly origination: RailOrigination;
  readonly beneficiary: ResolvedWireBeneficiary;
  readonly instruction: WireInstruction;
}

/**
 * Put an already-approved, already-released instruction on Fedwire.
 *
 * THE ORDER MATTERS AND IT IS THIS WAY ROUND ON PURPOSE. The ledger entry is
 * written by `releasePayment()`, in its own transaction, with the `released`
 * event that authorises it — and only then does this run. So:
 *
 *   * an unapproved instruction can never reach Fedwire, because it can never
 *     be released, because `assert_payment_lifecycle()` refuses the event;
 *   * a wire that leaves and whose ledger entry is missing is impossible,
 *     because the entry came first;
 *   * a wire whose entry exists but which never left IS possible, and is the
 *     correct failure: it is a reconciliation break, which is a thing this
 *     system has a screen for, rather than money that moved with no record.
 *
 * IDEMPOTENCY IS THE INSTRUCTION ID. `Idempotency-Key: payment:<id>` — derived
 * from the instruction and nothing else, so a retry of the same intent returns
 * Increase's ORIGINAL wire transfer and a second wire cannot be sent by
 * pressing a button twice. A replay with different parameters is a 409, which
 * is a bug in our key generation and never a retry.
 */
export async function originateApprovedWire(
  args: OriginateApprovedWireArgs,
): Promise<OriginatedWire> {
  const conn = args.conn ?? sql;
  const adapter = args.adapter ?? increaseWireAdapter();

  const found = await getPayment(args.instructionId, conn);
  if (!found.ok) {
    throw new WireOriginationRefused(
      'PAYMENT_NOT_FOUND',
      `No payment instruction ${args.instructionId}. Nothing was sent.`,
    );
  }
  const payment: QueuedPayment = found.value;
  const instruction = payment.instruction;

  if (instruction.rail !== 'wire') {
    throw new WireOriginationRefused(
      'NOT_A_WIRE',
      `Instruction ${instruction.id} is a ${instruction.rail} payment. The wire rail will not originate it.`,
    );
  }

  // THE GUARD THAT MATTERS. Approval is enforced by the database; this is the
  // statement that the money has already been booked, which is what makes
  // sending it safe. `released` and `settled` both qualify — a redelivery
  // after settlement must find the original transfer through the idempotency
  // key, not be refused into a reconciliation break.
  if (payment.state !== 'released' && payment.state !== 'settled') {
    throw new WireOriginationRefused(
      'NOT_RELEASED',
      `Instruction ${instruction.id} is ${payment.state}, not released. A wire is final on receipt, so it is put on the network only after the ledger entry and the \`released\` event that authorises it have both committed. Nothing was sent.`,
    );
  }

  const businessId = (await readAccountIdentity(instruction.accountId, conn))?.businessId ?? null;
  if (businessId === null) {
    throw new WireOriginationRefused(
      'NO_BUSINESS',
      `Account ${instruction.accountId} has no business, so it has no payee book to confirm a wire beneficiary against.`,
    );
  }

  const beneficiary = await resolveWireBeneficiary(
    { businessId, destination: instruction.destination },
    conn,
  );

  // Narrow FIRST, then compare. The ternary that used to be inline here fell
  // back to `''` for a non-wire destination, and `''.endsWith('')` is true —
  // so the guard passed vacuously on exactly the input it should refuse.
  //
  // It was defended only by `resolveWireBeneficiary()` above happening to throw
  // NOT_A_WIRE_DESTINATION first. That is defence by line ordering: reorder
  // these two calls, or make that function tolerant, and this check disappears
  // in silence with no test failing. A guard whose correctness depends on a
  // neighbouring statement is not a guard.
  if (instruction.destination.type !== 'wire') {
    throw new WireOriginationRefused(
      'NOT_A_WIRE_DESTINATION',
      `Instruction ${instruction.id} is not addressed to a wire destination, so there are no last four digits for the approvers to have seen.`,
    );
  }

  if (!args.beneficiaryAccountNumber.endsWith(instruction.destination.accountNumberLast4)) {
    throw new WireOriginationRefused(
      'ACCOUNT_NUMBER_MISMATCH',
      'The full account number supplied does not end with the last four digits the approvers saw. The approved instruction and the wire being sent must be about the same account.',
    );
  }

  const wireBeneficiary: WireBeneficiary = {
    name: beneficiary.holderName,
    wireRoutingNumber: beneficiary.wireRoutingNumber,
    accountNumber: args.beneficiaryAccountNumber,
    ...(instruction.destination.type === 'wire'
      ? { accountNumberLast4: instruction.destination.accountNumberLast4 }
      : {}),
  };

  const wireInstruction: WireInstruction = {
    clientReferenceId: `payment:${instruction.id}`,
    sourceAccountId: args.sourceAccountId,
    beneficiary: wireBeneficiary,
    amount: usd(instruction.amountCents),
    // Increase REQUIRES remittance information (measured: a 400 naming the
    // field). The instruction's own id is the most useful thing to put on the
    // message — it is what a beneficiary quotes back when they query the
    // payment, and it joins the Fedwire message to our ledger without
    // exposing anything about the customer.
    remittance: `CORGI ${instruction.id.slice(0, 8).toUpperCase()}`,
  };

  const origination = await adapter.originate(wireInstruction);
  return { origination, beneficiary, instruction: wireInstruction };
}
