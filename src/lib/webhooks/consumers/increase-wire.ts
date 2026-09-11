/**
 * The Increase consumer — one vendor, two rails, and the dispatcher between
 * them.
 *
 * ===========================================================================
 * WHY THIS FILE IS THE `increase` CONSUMER AND NOT A SECOND ONE
 * ===========================================================================
 *
 * `ConsumerRegistry` is keyed on PROVIDER, and `webhook_inbox.provider` is
 * `'increase'` — the vendor, correctly, because the vendor is what signs the
 * request. But `RailDelivery.provider` is `increase.ach` or `increase.wire` —
 * the RAIL. One signature, two rails, and something has to route between them.
 *
 * So this module registers the consumer for `'increase'` and is the router:
 * `isWireDelivery(category)` sends a delivery to the wire path, and everything
 * else falls through to `increaseAchConsumer` UNCHANGED. Registering a second
 * consumer for the same provider is not possible and should not be — the
 * registry refuses it — and splitting the vendor into two provider slugs would
 * mean the webhook route, the signature verifier and the inbox all had to know
 * which rail a delivery belonged to before anything had parsed it.
 *
 * THE ACH PATH IS NOT TOUCHED. `increaseAchConsumer.handle()` is called, with
 * the same event and the same context, and its answer is returned verbatim. No
 * behaviour of the ACH rail changes: before this file, an `ach_transfer.*`
 * delivery reached that consumer through the registry; now it reaches it
 * through one function call. Everything that was `ignored`, `parked` or
 * `processed` stays exactly that.
 *
 * If this module fails to load, `drain.ts` still has the ACH entry registered
 * ahead of it and the ACH rail keeps working — the router is the thing that
 * degrades, not the rail underneath it.
 *
 * ===========================================================================
 * ROUTE ON `category`. NEVER ON AN ID PREFIX.
 * ===========================================================================
 *
 * This is not a style preference; it is a bug that already happened here and
 * cost the whole ACH rail. `parseEvent()` gated on
 * `associated_object_id.startsWith('ach_transfer_')` while EVERY SANDBOX ID IS
 * `sandbox_ach_transfer_...`, so every sandbox settlement and every return was
 * classified "unmodelled" and dropped with a 200 — the failure mode that looks
 * like success from both ends, because the provider sees a 2xx and the inbox
 * sees a processed row.
 *
 * `isWireDelivery()` is exported from `@/lib/rails/wire/types` for exactly this
 * decision, so it is one import rather than a `startsWith` at the call site,
 * and the four categories it answers for are written down in one place next to
 * the vocabulary they belong to. Below that, the branch is on
 * `associated_object_type` — also a declared field, also never a prefix.
 *
 * ===========================================================================
 * THE TRAP THIS RAIL CARRIES, AND IT IS THE MIRROR OF ACH'S
 * ===========================================================================
 *
 * A wire has NO SETTLEMENT OBJECT. Submission IS settlement.
 *
 *     status:      pending_creating  ->  complete
 *     submission:  null              ->  { input_message_accountability_data,
 *                                          submitted_at }
 *     settlement:  no such field, at any point
 *
 * Fedwire is real-time gross settlement: the Fed accepting the message IS the
 * transfer of funds. The Increase ACH endpoint has the opposite trap — a
 * settled ACH transfer keeps `status: "submitted"` and grows a
 * `settlement.settled_at`, so an ACH adapter must PROMOTE. A wire adapter that
 * waited for `settlement.settled_at` "because that is how Increase does it"
 * would wait for ever and release nothing. Nothing in this file reads a
 * settlement field, and nothing in `rail_event_semantics`'s eight wire rows
 * names one — `wire_transfer.updated/complete` takes its value date from
 * `payload.submission.submitted_at`.
 *
 * ===========================================================================
 * WHAT THIS CONSUMER POSTS, WHICH IS ALMOST NOTHING, AND WHY THAT IS RIGHT
 * ===========================================================================
 *
 * An outbound wire's money is booked by `releasePayment()`, in its own
 * transaction, with the `released` event that authorises it —
 * `DR 2100.<business> / CR 1110 cash`, straight to cash and with no in-transit
 * liability, because "the cash is gone the moment a wire leaves; there is no
 * in-transit window worth modelling on an irrevocable rail". The ACH path
 * raises `2300 ACH payable` at release and discharges it against cash when the
 * settlement notification lands, so ITS consumer posts at settlement. The wire
 * path has no payable to discharge, so there is nothing left for a settlement
 * notification to book, and booking one anyway would double the payment and it
 * would BALANCE, which is the worst kind of bug.
 *
 * So `wire_submitted` and `wire_settled` post nothing and say so. What they DO
 * is check that the release entry exists: a wire on the network with no
 * `released` event on this book is money that left outside maker-checker, and
 * that is an incident rather than a webhook. It parks, in front of a human.
 *
 * The one case that posts real money is `wire_return_of_funds` — see below.
 *
 * ===========================================================================
 * INBOUND WIRES ARE ATTRIBUTED NOW — BY LOOKUP, AND STILL NEVER BY GUESS
 * ===========================================================================
 *
 * This file used to park EVERY inbound wire with the sentence "this build
 * issues no virtual account numbers". That was true when it was written and it
 * stopped being true on 2026-09-11: `scripts/provision-account-numbers.mjs`
 * issued one number per business through `POST /account_numbers`,
 * `db/migrations/0042_virtual_account_numbers.sql` records whose each one is,
 * and `increase-ach.ts` has been attributing and BOOKING inbound ACH credits
 * against that table since. Twenty-seven wire deliveries went on parking under
 * the old sentence, and a park whose reason is false is worse than no park: an
 * operator reads it, believes the capability is missing, and stops looking.
 *
 * So the inbound branch now does exactly what the ACH one does:
 *
 *     findVirtualAccountNumber(inbound.account_number_id, conn)
 *
 * THE REFUSAL IS NOT WEAKENED — IT IS THE SAME REFUSAL WITH A TABLE BEHIND IT.
 * A number nobody has mapped still PARKS, under the same `waitingFor` kind, and
 * there is no fallback account, no "the only business on the book", and no
 * "whoever this originator paid last time". The programme's own shared `primary`
 * number (`sandbox_account_number_96mzhz3n61f5p0jpvytc`) is deliberately mapped
 * to NOBODY, and every wire that arrived before per-business numbers existed was
 * addressed to it — so those still park, and that is the honest answer rather
 * than a tidy screen. What changes is the sentence: it names the account number
 * that arrived, says how many numbers ARE mapped, and tells the operator what to
 * do. On this rail that matters more than on ACH, because a wire is final and we
 * cannot send it back without originating a new payment.
 *
 * WHAT IS DIFFERENT FROM ACH, AND IT IS THE WHOLE POINT OF THE RAIL BEING A ROW
 * OF DATA RATHER THAN AN `if`: the credit is booked by `creditInboundWire()`,
 * which reads `funds_availability_policy` for rail `wire` and finds 0 banking
 * days with a 00:00 release — so the hold opens and releases in the same
 * transaction and the money is spendable the instant it is booked. The ACH path
 * calls `creditInboundAch()`, the policy row says two banking days for a new
 * counterparty, and the same code holds the money. Neither behaviour is written
 * in a consumer. `v_wire_availability_drift` asserts the wire half — one row per
 * wire credit that became spendable LATER than the moment it was booked — and it
 * must stay empty.
 *
 * CANCELLED AND REJECTED WIRES PARK. Both mean the money did NOT leave, and
 * both therefore need the release entry reversed and re-booked — which is a
 * correction, and this consumer has no reverse-and-rebook path. Posting a
 * guess at a repair is worse than parking one in front of a person.
 *
 * ===========================================================================
 * WHAT AN INBOUND OBJECT ASSERTS, AND WHY THE DELIVERY'S CATEGORY DOES NOT
 * DECIDE
 * ===========================================================================
 *
 * Increase fires `inbound_wire_transfer.created` and then
 * `inbound_wire_transfer.updated`, and the body of both is a POINTER. So the
 * steps are derived from the OBJECT read back, exactly as `inboundAssertedSteps`
 * does on the ACH side: every accepted object asserts `.created`, and an object
 * carrying a `reversal` also asserts `.updated/reversed`. Keying off the
 * delivery's own category instead would ask `rail_event_semantics` for
 * `inbound_wire_transfer.updated/accepted`, which is not a row and never should
 * be — the table classifies FACTS ABOUT THE MONEY, and "we were told again" is
 * not one. Both deliveries therefore converge on the same steps, in order, and
 * a redelivery books nothing twice because every key is derived from the
 * transfer.
 *
 * ===========================================================================
 * WHAT IT DOES BOOK: MONEY THAT CAME BACK
 * ===========================================================================
 *
 * `wire_transfer.updated/reversed` is the one branch that posts. It is NOT a
 * reversal of our transfer, and the adapter's `supports.reverse === false` says
 * so: measured, the object carries `class_name: "inbound_wire_reversal"`, its
 * OWN IMAD (`20260911apvdjfqt599399`, not the original's
 * `20260911sgzamiaa787670`), its own transaction id, and
 * `return_reason_code: null` — null because, unlike ACH's R01–R85, Fedwire has
 * no return-code table to fill it from. A different Fedwire message is a
 * different payment. So what came back is A SECOND PAYMENT the beneficiary's
 * bank chose to send, and it is booked by `creditInboundWire()` — the same
 * function, the same posting, the same hold, the same policy and the same
 * availability as an ordinary arrival, because it is the same event: a wire
 * arrived.
 *
 * And unlike an ordinary arrival, THIS one can be attributed: the reversal
 * hangs off an outbound transfer whose `Idempotency-Key` is
 * `payment:<instruction id>`, and the instruction names the account, and the
 * account names the business. Nothing is guessed.
 *
 * Its value date is the REVERSAL's own `created_at`, which is what
 * `rail_event_semantics` says (`new_event`,
 * `value_date_source: payload.reversal.created_at`). Taking the original's
 * would make the ledger claim the payment never happened on the day it
 * provably did.
 *
 * ===========================================================================
 * IDEMPOTENCY AND OUT-OF-ORDER DELIVERY
 * ===========================================================================
 *
 * The body is a POINTER — `{type, associated_object_id, associated_object_type,
 * category, created_at, id}` and nothing about the money — so every branch
 * reads the object back, and the read-back reflects CURRENT state. That is
 * what makes out-of-order delivery harmless: whichever of `wire_transfer.
 * created`, the four `wire_transfer.updated` notifications and any redelivery
 * arrives first, they all resolve to the same object. Five deliveries about one
 * transfer therefore describe one settlement five times, and nothing
 * double-posts, because the one branch that writes is keyed in the database —
 * `hold_ref UNIQUE (kind, external_ref)` on the hold and the entry's own
 * idempotency key decide, not an `if`.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { readAccountIdentity } from "@/lib/ledger/readers";
import {
  countVirtualAccountNumbers,
  findVirtualAccountNumber,
} from "@/lib/rails/increase/account-numbers";
import { increaseWireAdapter, type IncreaseWireAdapter } from "@/lib/rails/wire/adapter";
import type { IncreaseWireClient } from "@/lib/rails/wire/client";
import {
  creditInboundWire,
  debitReturnedInboundWire,
  WireBookingRefused,
} from "@/lib/rails/wire/ledger";
import { inboundCredit, returnOfFunds, wireSemanticsKey } from "@/lib/rails/wire/semantics";
import {
  isWireDelivery,
  type IncreaseInboundWireTransfer,
  type IncreaseWireTransfer,
} from "@/lib/rails/wire/types";
import {
  resolveEventSemantics,
  type ClassifiedResolution,
  type RailEventSemantics,
} from "@/lib/rails/semantics";

import {
  consumers,
  parked,
  processed,
  type ConsumerContext,
  type ConsumerRegistry,
  type ConsumerResult,
  type WebhookConsumer,
} from "../dispatch";
import type { InboxEvent } from "../inbox";
import { increaseAchConsumer, INCREASE_WEBHOOK_PROVIDER } from "./increase-ach";
import { readStoredPayload, readString } from "./payload";

export { INCREASE_WEBHOOK_PROVIDER };

/** The object types the wire categories can point at. Declared, never sniffed. */
const OUTBOUND_OBJECT = "wire_transfer";
const INBOUND_OBJECT = "inbound_wire_transfer";

/**
 * The prefix `originateApprovedWire()` puts on its `Idempotency-Key`.
 *
 * `payment:<instruction id>` — derived from the instruction and nothing else,
 * so a retry of the same intent returns Increase's ORIGINAL transfer and a
 * second wire cannot be sent by pressing a button twice. It is also the only
 * join from a provider object back to this book, which is why it is a constant
 * here rather than a string literal in a condition.
 *
 * NOTE THAT THIS IS NOT THE ACH JOIN. There, the instruction's OWN
 * `idempotency_key` column is sent as the client reference, so
 * `findOutboundLink()` matches on that column. The wire path sends
 * `payment:<id>` instead, so the join is on the instruction's PRIMARY KEY.
 * Reusing the ACH lookup here would silently find nothing for every wire ever
 * sent, and finding nothing is indistinguishable from a delivery that arrived
 * early.
 */
const WIRE_CLIENT_REFERENCE_PREFIX = "payment:";

/* -------------------------------------------------------------------------- */
/* The pointer                                                                */
/* -------------------------------------------------------------------------- */

export interface WireEventPointer {
  readonly id: string;
  readonly category: string;
  readonly associatedObjectId: string;
  readonly associatedObjectType: string;
  readonly createdAt: string | null;
}

/**
 * A stored payload -> the pointer, or null if it is not an Increase event.
 *
 * Every field is read by NAME and none is inferred from the shape of another.
 * In particular `associatedObjectType` is read, not derived from
 * `associatedObjectId` — see the header.
 */
export function asWirePointer(payload: Record<string, unknown>): WireEventPointer | null {
  const id = readString(payload, ["id"]);
  const category = readString(payload, ["category"]);
  const associatedObjectId = readString(payload, ["associated_object_id"]);
  const associatedObjectType = readString(payload, ["associated_object_type"]);
  if (id === null || category === null || associatedObjectId === null) return null;
  if (associatedObjectType === null) return null;
  return {
    id,
    category,
    associatedObjectId,
    associatedObjectType,
    createdAt: readString(payload, ["created_at"]),
  };
}

/* -------------------------------------------------------------------------- */
/* The instruction behind an outbound wire                                    */
/* -------------------------------------------------------------------------- */

export interface WireOutboundLink {
  readonly instructionId: string;
  readonly accountId: string;
  readonly businessId: string | null;
  readonly amountCents: bigint;
  /** Null when nobody has released it on this book. That is an incident. */
  readonly releaseEntryId: string | null;
}

/**
 * Find the instruction an outbound wire was raised from.
 *
 * Joined on the instruction's PRIMARY KEY, taken from the provider's echo of
 * our own `Idempotency-Key`. No new column, no lookup table, and the same
 * string on both sides of the wire — which is what makes a support
 * conversation about one payment possible.
 *
 * The account's identity is read through the ledger's own named reader rather
 * than joined in above: `src/lib/ledger/boundary.test.ts` is a ratchet, and a
 * consumer that had learnt the shape of `account` would be a second answer to
 * "which business is this" waiting to disagree with the first.
 */
export async function findWireOutboundLink(
  clientReferenceId: string | null,
  conn: Sql,
): Promise<WireOutboundLink | null> {
  if (clientReferenceId === null) return null;
  if (!clientReferenceId.startsWith(WIRE_CLIENT_REFERENCE_PREFIX)) return null;
  const instructionId = clientReferenceId.slice(WIRE_CLIENT_REFERENCE_PREFIX.length);
  // A uuid, or this is not one of ours. Checked before it reaches a `::uuid`
  // cast, because a malformed id there is a 22P02 the dispatcher would retry
  // eight times and dead-letter, rather than the "not ours" it actually is.
  if (!/^[0-9a-fA-F-]{36}$/.test(instructionId)) return null;

  const [row] = await conn<
    {
      id: string;
      account_id: string;
      amount_cents: string;
      release_entry_id: string | null;
    }[]
  >`
    SELECT p.id,
           p.account_id,
           p.amount_cents::text AS amount_cents,
           (SELECT e.entry_id
              FROM payment_instruction_event e
             WHERE e.instruction_id = p.id
               AND e.kind IN ('released', 'submitted')
               AND e.entry_id IS NOT NULL
             ORDER BY e.occurred_at
             LIMIT 1) AS release_entry_id
      FROM payment_instruction p
     WHERE p.id = ${instructionId}::uuid
     LIMIT 1`;
  if (row === undefined) return null;

  const identity = await readAccountIdentity(row.account_id, conn);

  return {
    instructionId: row.id,
    accountId: row.account_id,
    businessId: identity?.businessId ?? null,
    amountCents: BigInt(row.amount_cents),
    releaseEntryId: row.release_entry_id,
  };
}

/* -------------------------------------------------------------------------- */
/* The consumer                                                               */
/* -------------------------------------------------------------------------- */

export interface IncreaseWireConsumerDeps {
  /** Injected in tests. Defaults to the real adapter, built at call time. */
  readonly adapter?: IncreaseWireAdapter | undefined;
  readonly conn?: Sql | undefined;
  /**
   * Where a non-wire Increase delivery goes. Defaults to the ACH consumer this
   * deployment already runs, which is the whole point: this module routes and
   * does not reimplement.
   */
  readonly ach?: WebhookConsumer | undefined;
  /**
   * Resolve semantics against these rows instead of the table. The seam is
   * `resolveEventSemantics`'s own (`opts.rows`), not a new one. NOTHING in
   * production passes it: the table is the decision.
   */
  readonly semanticsRows?: readonly RailEventSemantics[] | undefined;
}

export function createIncreaseWireConsumer(
  deps: IncreaseWireConsumerDeps = {},
): WebhookConsumer {
  const ach = deps.ach ?? increaseAchConsumer;
  // Built per call, not at module scope: the API key is read at call time, so a
  // rotated credential is picked up without a restart.
  const getAdapter = (): IncreaseWireAdapter => deps.adapter ?? increaseWireAdapter();

  return {
    provider: INCREASE_WEBHOOK_PROVIDER,

    async handle(event: InboxEvent, ctx: ConsumerContext): Promise<ConsumerResult> {
      const payload = readStoredPayload(event.payload);
      // Not a JSON object: the ACH consumer already has the sentence for that,
      // and two consumers with two wordings for one condition is two places to
      // read when somebody asks why a row was ignored.
      if (payload === null) return ach.handle(event, ctx);

      const category = readString(payload, ["category"]);
      // THE ROUTING DECISION, and the only one. `category` is a declared field
      // and `isWireDelivery()` is the rail's own predicate. No id is inspected.
      if (category === null || !isWireDelivery(category)) return ach.handle(event, ctx);

      return handleWireDelivery(event, ctx, payload, getAdapter(), deps);
    },
  };
}

async function handleWireDelivery(
  event: InboxEvent,
  ctx: ConsumerContext,
  payload: Record<string, unknown>,
  adapter: IncreaseWireAdapter,
  deps: IncreaseWireConsumerDeps,
): Promise<ConsumerResult> {
  const conn = deps.conn ?? sql;
  const pointer = asWirePointer(payload);
  if (pointer === null) {
    return parked(
      "increase_wire_pointer",
      event.id,
      `a delivery whose category is '${readString(payload, ["category"]) ?? "?"}' — a wire ` +
        `category — carries no usable pointer (id / associated_object_id / ` +
        `associated_object_type). NOTHING WAS POSTED. This is a wire event whose object cannot ` +
        `be read back, so an operator has to look at the stored body.`,
    );
  }

  /* ---- inbound: money arriving, and the table says whose ------------------- */

  if (pointer.associatedObjectType === INBOUND_OBJECT) {
    return applyInboundWire({ event, ctx, pointer, adapter, conn, deps });
  }

  if (pointer.associatedObjectType !== OUTBOUND_OBJECT) {
    // A wire CATEGORY pointing at something that is not a wire object. Nothing
    // has decided what that means, so nothing acts on it.
    return parked(
      "increase_wire_object_type",
      pointer.associatedObjectType,
      `'${pointer.category}' is a wire category but points at a '${pointer.associatedObjectType}', ` +
        `which nobody has decided about. It was verified and stored, and it is NOT being acted on.`,
    );
  }

  /* ---- the read-back ------------------------------------------------------ */

  // NOT wrapped in a try/catch. If the API call fails we do not know the state,
  // and answering `ignored` would mark the row done and lose the event. A throw
  // is a bounded retry in dispatch.ts, which is the correct outcome for "the
  // provider did not answer".
  const transfer: IncreaseWireTransfer = await adapter.client.getTransfer(
    pointer.associatedObjectId,
  );

  /* ---- the table decides what the step MEANS ------------------------------ */

  // `wireSemanticsKey()` composes `<category>/<status>` the way the eight wire
  // rows are keyed, and gives `wire_transfer.created` no step because there is
  // only one thing it can mean. The key is passed whole, so the rail owns the
  // composition and this consumer does not restate it.
  const key = wireSemanticsKey(pointer.category, transfer.status);
  const semantics = await resolveEventSemantics(
    { provider: INCREASE_WEBHOOK_PROVIDER, eventType: key },
    deps.semanticsRows === undefined ? { conn } : { rows: deps.semanticsRows },
  );

  if (semantics.status === "unclassified") {
    return parked(
      "rail_event_semantics",
      semantics.key,
      `no rail_event_semantics row for '${semantics.key}'; nobody has classified this step as a ` +
        `correction or a new event, and posting money at a value date no human reviewed is the ` +
        `one failure this system has no alarm for. NOTHING WAS POSTED.`,
    );
  }

  // A `correction` row means "this repairs a past posting at the PAST posting's
  // date", which needs `reverseAndRebook()` and a matched target entry. All
  // eight wire rows are `new_event` — nothing a wire does is ever a false
  // statement about its own value date — so this cannot fire today. It is kept
  // because the day somebody adds a correction row is the day this consumer
  // must refuse rather than post a repair at a date it guessed.
  if (semantics.valueDateAnchor === "original") {
    return parked(
      "rail_event_semantics",
      semantics.key,
      `rail_event_semantics classifies '${semantics.key}' as a CORRECTION at the original value ` +
        `date. This consumer books wire steps as new events only and has no reverse-and-rebook ` +
        `path for them, so nothing was posted.`,
    );
  }

  ctx.logger.info("increase.wire_transfer.semantics", {
    inboxId: event.id,
    transferId: transfer.id,
    category: pointer.category,
    status: transfer.status,
    key: semantics.key,
    canonical: semantics.row.canonicalKind,
  });

  return applyOutboundWire({ event, ctx, transfer, semantics, adapter, conn });
}

/* -------------------------------------------------------------------------- */
/* One inbound wire: whose it is, and what the object asserts                  */
/* -------------------------------------------------------------------------- */

/**
 * The steps the CURRENT inbound object asserts, in lifecycle order.
 *
 * The mirror of `inboundAssertedSteps()` on the ACH side, and the same argument:
 * the delivery body is a pointer, every delivery about one transfer reads back
 * the same current object, so what that object ASSERTS is the set of facts that
 * are true of it now. Two keys, both of which `rail_event_semantics` carries:
 *
 *   inbound_wire_transfer.created           -> inbound_wire_credit, value date
 *                                              payload.acceptance.accepted_at
 *   inbound_wire_transfer.updated/reversed  -> inbound_wire_returned, value date
 *                                              payload.reversal.reversed_at
 *
 * There is deliberately no `.updated/accepted`: being told a second time is not
 * a fact about the money.
 */
export function inboundWireAssertedSteps(
  transfer: IncreaseInboundWireTransfer,
): readonly string[] {
  const steps = [`${INBOUND_OBJECT}.created`];
  if (transfer.reversal !== null && transfer.reversal !== undefined) {
    steps.push(`${INBOUND_OBJECT}.updated/reversed`);
  }
  return steps;
}

async function applyInboundWire(args: {
  readonly event: InboxEvent;
  readonly ctx: ConsumerContext;
  readonly pointer: WireEventPointer;
  readonly adapter: IncreaseWireAdapter;
  readonly conn: Sql;
  readonly deps: IncreaseWireConsumerDeps;
}): Promise<ConsumerResult> {
  const { ctx, pointer, conn, deps } = args;

  // THE ONE PIECE OF INFORMATION THAT DECIDES WHOSE THIS IS lives on the
  // object, not in the delivery: the body is a pointer and carries no
  // `account_number_id`. So the object is read back, exactly as the outbound
  // path does.
  //
  // The capability check in front of it is about the INJECTED adapter, not
  // about Increase: a caller can hand this consumer a client that implements
  // only the outbound half, and a missing method is a TypeError that dispatch
  // would retry eight times and dead-letter with a stack trace instead of a
  // sentence. A named park says what is actually wrong. The real
  // `IncreaseWireClient` always implements it.
  const readBack = (args.adapter.client as Partial<IncreaseWireClient>).getInboundTransfer;
  if (typeof readBack !== "function") {
    return parked(
      "inbound_wire_account_mapping",
      pointer.associatedObjectId,
      `inbound wire ${pointer.associatedObjectId} (${pointer.category}): the wire client in use ` +
        `cannot read an inbound_wire_transfer back, and the destination account_number_id exists ` +
        `only on that object — so this credit cannot be matched against the virtual account ` +
        `numbers this programme has issued, and there is no way to tell whose money it is. ` +
        `NOTHING WAS POSTED. This is a wiring fault in the deployment, not a fact about the ` +
        `payment: the shipped client implements the read-back.`,
    );
  }

  // NOT wrapped in a try/catch, for the reason the outbound read-back gives: a
  // provider that did not answer is a bounded retry, not an `ignored` that
  // marks the row done and loses the event.
  const inbound: IncreaseInboundWireTransfer = await readBack.call(
    args.adapter.client,
    pointer.associatedObjectId,
  );

  /* ---- the table decides what each asserted step MEANS --------------------- */

  const resolutions: ClassifiedResolution[] = [];
  for (const key of inboundWireAssertedSteps(inbound)) {
    const semantics = await resolveEventSemantics(
      { provider: INCREASE_WEBHOOK_PROVIDER, eventType: key },
      deps.semanticsRows === undefined ? { conn } : { rows: deps.semanticsRows },
    );
    if (semantics.status === "unclassified") {
      return parked(
        "rail_event_semantics",
        semantics.key,
        `no rail_event_semantics row for '${semantics.key}'; nobody has classified this step as a ` +
          `correction or a new event, and posting money at a value date no human reviewed is the ` +
          `one failure this system has no alarm for. NOTHING WAS POSTED.`,
      );
    }
    if (semantics.valueDateAnchor === "original") {
      return parked(
        "rail_event_semantics",
        semantics.key,
        `rail_event_semantics classifies '${semantics.key}' as a CORRECTION at the original value ` +
          `date. An inbound wire and its return are two payments and two value dates, so this ` +
          `consumer books them as new events only and has no reverse-and-rebook path. NOTHING ` +
          `WAS POSTED.`,
      );
    }
    resolutions.push(semantics);
  }

  /* ---- WHOSE MONEY IS THIS? A lookup. Never a derivation, never a default -- */

  const owner = await findVirtualAccountNumber(inbound.account_number_id, conn);
  const amountCents = BigInt(Math.abs(inbound.amount));
  const reversal = inbound.reversal ?? null;

  ctx.logger.info("increase.inbound_wire_transfer.semantics", {
    inboxId: args.event.id,
    transferId: inbound.id,
    category: pointer.category,
    status: inbound.status,
    accountNumberId: inbound.account_number_id,
    attributedTo: owner === null ? null : `${owner.businessId} (${owner.legalName})`,
    steps: resolutions.map((r) => `${r.key} -> ${r.row.canonicalKind}`),
    amountCents: String(amountCents),
  });

  /* ---- nobody has said whose number this is -------------------------------- */

  if (owner === null) {
    if (reversal !== null) {
      // The refusal has been overtaken by events: this arrival was sent back
      // out of the FBO account before anyone attributed it, so there is no
      // longer a customer to find and nothing to correct — nothing was ever
      // booked. Reported and RESOLVED rather than parked, so it stops waking a
      // human every few minutes about money that has already left.
      ctx.logger.info("increase.inbound_wire_transfer.returned_unattributed", {
        inboxId: args.event.id,
        transferId: inbound.id,
        amountCents: String(amountCents),
        reason: reversal.reason,
        reversedAt: reversal.reversed_at,
        ledgerEffect:
          "none — the credit was never attributed, so it was never booked and there is nothing to correct",
      });
      return processed([{ kind: "inbound_wire_account_mapping", ref: inbound.id }]);
    }

    // THE REFUSAL, UNCHANGED IN SUBSTANCE AND TRUE IN ITS WORDING. Park, not
    // ignore: a credit nobody can attribute is exactly what an operator should
    // be shown, and filing it under "recognised and skipped" would lose
    // somebody's money quietly.
    const mapped = await countVirtualAccountNumbers(conn);
    return parked(
      "inbound_wire_account_mapping",
      inbound.id,
      `inbound wire ${inbound.id} (${pointer.category}, ${amountCents} cents) is addressed to ` +
        `account_number_id ${inbound.account_number_id}, and NOTHING ON THIS BOOK SAYS WHOSE ` +
        `THAT NUMBER IS — there is no virtual_account_number row for it, though ${mapped} ` +
        `number(s) are mapped. It is most likely the programme's own shared FBO number, which is ` +
        `deliberately mapped to nobody. NOTHING WAS POSTED and no balance reflects it. An ` +
        `operator must attribute it by hand, or send it back — and sending a wire back is ` +
        `ORIGINATING A NEW PAYMENT, because a Fedwire transfer is final on receipt. ` +
        `creditInboundWire() books it the moment somebody says whose it is; what this consumer ` +
        `will not do is guess.`,
    );
  }

  /* ---- it is somebody's, so book what the object asserts -------------------- */

  const credit = inboundCredit(inbound);
  if (credit === null) {
    // No `acceptance` block: Increase has not put the money in the FBO account,
    // so there is no receipt to book and the value date the table names does
    // not exist yet. Park rather than invent one.
    return parked(
      "inbound_wire_acceptance",
      inbound.id,
      `inbound wire ${inbound.id} is attributed to ${owner.legalName} but carries no ` +
        `'acceptance', so Increase has not credited the FBO account and there is no accepted_at ` +
        `to date the entry with — rail_event_semantics takes this credit's value date from ` +
        `payload.acceptance.accepted_at. Status is '${inbound.status}'. NOTHING WAS POSTED.`,
    );
  }

  const posted: string[] = [];

  try {
    const receipt = await creditInboundWire({
      businessId: owner.businessId,
      credit,
      conn,
    });
    posted.push(
      `${INBOUND_OBJECT}.created @ ${receipt.valueDate} -> ${receipt.entryId} ` +
        `(DR 1110 / CR 2100 ${owner.legalName}, ${receipt.amountCents} cents; hold ` +
        `${receipt.holdId} ${receipt.availableImmediately ? "released on arrival" : "HELD"}` +
        `${receipt.created ? "" : "; already booked, nothing posted twice"})`,
    );

    if (reversal !== null) {
      // WE SENT IT BACK. A production `POST /inbound_wire_transfers/{id}/reverse`
      // is this bank originating a payment in the other direction, so it is a
      // NEW entry at ITS OWN value date — never an edit of the credit, and never
      // backdated to the arrival, which provably happened.
      const returned = await debitReturnedInboundWire({
        businessId: owner.businessId,
        inboundTransferId: inbound.id,
        amountCents,
        reversedAt: reversal.reversed_at,
        reason: reversal.reason,
        conn,
      });
      posted.push(
        `${INBOUND_OBJECT}.updated/reversed @ ${returned.valueDate} -> ${returned.entryId} ` +
          `(DR 2100 ${owner.legalName} / CR 1110, ${returned.amountCents} cents, reason ` +
          `'${reversal.reason}')`,
      );
    }
  } catch (thrown) {
    // A REFUSAL IS A PARK, NOT A FAILURE. `WireBookingRefused` carries a code
    // and a sentence about a state a human has to change — a business with no
    // deposit leaf, an availability policy nobody wrote. Retrying it eight
    // times and dead-lettering would bury the sentence. Anything else is a
    // genuine fault and goes up, where dispatch retries it.
    if (!(thrown instanceof WireBookingRefused)) throw thrown;
    return parked("inbound_wire_booking", `${thrown.code}:${inbound.id}`, thrown.message);
  }

  ctx.logger.info("increase.inbound_wire_transfer.applied", {
    inboxId: args.event.id,
    transferId: inbound.id,
    businessId: owner.businessId,
    accountNumber: `${owner.routingNumber}/${owner.accountNumber}`,
    amountCents: String(amountCents),
    posted,
  });

  // Naming the transfer AND the mapping wakes every sibling delivery parked on
  // either — including the ones that parked under the old, now-false reason.
  return processed([
    { kind: "inbound_wire_transfer", ref: inbound.id },
    { kind: "inbound_wire_account_mapping", ref: inbound.id },
    { kind: "inbound_wire", ref: inbound.id },
  ]);
}

/* -------------------------------------------------------------------------- */
/* One classified step of one outbound wire                                   */
/* -------------------------------------------------------------------------- */

async function applyOutboundWire(args: {
  readonly event: InboxEvent;
  readonly ctx: ConsumerContext;
  readonly transfer: IncreaseWireTransfer;
  readonly semantics: ClassifiedResolution;
  readonly adapter: IncreaseWireAdapter;
  readonly conn: Sql;
}): Promise<ConsumerResult> {
  const { transfer, semantics, ctx, conn } = args;
  const canonical = semantics.row.canonicalKind;

  const link = await findWireOutboundLink(transfer.idempotency_key, conn);
  if (link === null) {
    // Genuinely out-of-order is possible — Increase can tell us about a
    // transfer before our own write of the instruction commits — so this parks
    // rather than failing. Bounded: twelve re-checks, then a dead letter naming
    // the exact string that did not match.
    return parked(
      "payment_instruction",
      transfer.idempotency_key ?? transfer.id,
      `Increase wire ${transfer.id} carries Idempotency-Key ` +
        `'${transfer.idempotency_key ?? "(none)"}', which names no payment_instruction on this ` +
        `book. NOTHING WAS POSTED. Either the instruction has not been written yet, or this wire ` +
        `was originated outside this system — and a wire with no approval behind it is an ` +
        `incident for a person, not a row for a consumer.`,
    );
  }

  switch (canonical) {
    case "wire_originated":
      // The table's own note: "Nothing about the money has happened yet, which
      // is why the ledger consequence of this row is nothing."
      return done(
        ctx,
        args.event.id,
        transfer,
        link,
        "created at the provider; the instruction is the record",
      );

    case "wire_submitted":
    case "wire_settled": {
      // SUBMISSION IS SETTLEMENT on this rail, and the money was booked at
      // release — DR 2100 / CR 1110, straight to cash, no payable to discharge.
      // So both steps post nothing. What they assert is that the release
      // happened at all.
      if (link.releaseEntryId === null) {
        return parked(
          "payment_instruction_release",
          link.instructionId,
          `Increase has put wire ${transfer.id} on Fedwire, but payment instruction ` +
            `${link.instructionId} has no 'released' event carrying a journal entry — nobody ` +
            `approved and released it on this book. NOTHING WAS POSTED. A wire is final on ` +
            `receipt, so money that left the rail outside maker-checker is an incident, not a ` +
            `webhook. Either the release is still in flight, or this needs a person now.`,
        );
      }
      return done(
        ctx,
        args.event.id,
        transfer,
        link,
        canonical === "wire_settled"
          ? `settled at ${transfer.submission?.submitted_at ?? "an unknown instant"} with IMAD ` +
              `${transfer.submission?.input_message_accountability_data ?? "(none)"}; already ` +
              `booked by the approval release (entry ${link.releaseEntryId}), so this consumer ` +
              `posts nothing — a wire has no in-transit payable to discharge`
          : `handed to Fedwire; already booked by the approval release (entry ` +
              `${link.releaseEntryId}), so this consumer posts nothing`,
      );
    }

    case "wire_return_of_funds": {
      // THE ONE BRANCH THAT POSTS. Not a reversal of our transfer — a SECOND
      // payment the beneficiary's bank chose to send, with its own IMAD and a
      // null return reason code. Booked as the arrival it is, by the same
      // function an ordinary inbound wire uses.
      const credit = returnOfFunds(transfer);
      if (credit === null) {
        return parked(
          "increase_wire_reversal",
          transfer.id,
          `rail_event_semantics classifies wire ${transfer.id} as a return of funds, but the ` +
            `object read back carries no 'reversal'. NOTHING WAS POSTED: the two disagree, and ` +
            `booking money on the strength of a status with no object behind it is a guess.`,
        );
      }
      if (link.businessId === null) {
        return parked(
          "account_business",
          link.accountId,
          `wire ${transfer.id} came back, but account ${link.accountId} has no business on this ` +
            `book, so there is no payee book, no chart and nowhere for the money to land. ` +
            `NOTHING WAS POSTED.`,
        );
      }

      const receipt = await creditInboundWire({
        businessId: link.businessId,
        credit,
        conn,
      });

      ctx.logger.info("increase.wire_transfer.return_booked", {
        inboxId: args.event.id,
        transferId: transfer.id,
        instructionId: link.instructionId,
        entryId: receipt.entryId,
        amountCents: receipt.amountCents.toString(),
        valueDate: receipt.valueDate,
        created: receipt.created,
      });

      return processed([
        { kind: "wire_transfer", ref: transfer.id },
        { kind: "payment_instruction", ref: link.instructionId },
        { kind: "inbound_wire", ref: credit.transferId },
      ]);
    }

    case "wire_canceled":
    case "wire_rejected":
      // THE MONEY DID NOT LEAVE, and the release entry says it did. Making that
      // right is a reversal plus a re-book against an instruction two humans
      // approved, which is a correction — and this consumer has no correction
      // path. Parking puts it in front of the person who can make that call.
      return parked(
        "wire_release_reversal",
        link.instructionId,
        `wire ${transfer.id} is ${transfer.status}: it never reached Fedwire and no money left. ` +
          `The release entry on payment instruction ${link.instructionId} still says it did, and ` +
          `putting that right is a reversal and a re-book against an instruction two humans ` +
          `approved — a correction, which this consumer deliberately has no path for. NOTHING ` +
          `WAS POSTED and the customer's balance is understated by the amount of this wire until ` +
          `somebody corrects it.`,
      );

    default:
      // A canonical kind the table knows and this consumer does not. Park: the
      // one that gets waved through is the one somebody adds next.
      return parked(
        "increase_wire_canonical_kind",
        canonical,
        `rail_event_semantics classifies '${semantics.key}' as '${canonical}', which this ` +
          `consumer has no branch for. It was verified and stored, and it is NOT being acted on.`,
      );
  }
}

/**
 * A step that is recognised, complete, and posts nothing.
 *
 * `processed`, not `ignored`. `ignored` means "a well-formed event this
 * consumer deliberately does not act on"; these ARE acted on — they are checked
 * against the instruction and against the release entry that authorised the
 * money, and they name the entities that wake anything parked on them. Naming
 * the transfer wakes a delivery parked on it; naming the instruction wakes one
 * that arrived before the instruction was written.
 *
 * The note is LOGGED rather than dropped: "nothing was posted, and here is the
 * entry that already carries this money" is the audit answer to "why is there
 * no journal entry for the settlement of this wire", and it is the question
 * this rail will be asked.
 */
function done(
  ctx: ConsumerContext,
  inboxId: string,
  transfer: IncreaseWireTransfer,
  link: WireOutboundLink,
  note: string,
): ConsumerResult {
  ctx.logger.info("increase.wire_transfer.applied", {
    inboxId,
    transferId: transfer.id,
    instructionId: link.instructionId,
    status: transfer.status,
    amountCents: link.amountCents.toString(),
    posted: "nothing",
    note,
  });
  return processed([
    { kind: "wire_transfer", ref: transfer.id },
    { kind: "payment_instruction", ref: link.instructionId },
  ]);
}

/** The consumer this deployment registers. */
export const increaseWireConsumer: WebhookConsumer = createIncreaseWireConsumer();

/**
 * Register it.
 *
 * `replace: true` is expected and correct: `drain.ts` registers the ACH-only
 * consumer first and this one second, so the router replaces it. That ordering
 * is deliberate — if this module fails to import, the ACH consumer is already
 * registered and the ACH rail keeps draining, which is exactly the degradation
 * `ensureConsumers()` was built to give.
 */
export function registerIncreaseWireConsumer(
  registry: ConsumerRegistry = consumers,
  opts: { replace?: boolean } = {},
): ConsumerRegistry {
  return registry.register(increaseWireConsumer, { replace: true, ...opts });
}
