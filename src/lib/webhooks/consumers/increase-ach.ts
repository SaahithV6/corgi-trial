/**
 * The Increase consumer: ACH, and the return that is the whole point of it.
 *
 * Fourteen verified deliveries reached the deployed endpoint and were
 * dead-lettered with "no consumer registered for provider X". Two of them were
 * Increase. This file is the consumer that was missing, and it is written
 * against the one thing the ACH rail has that the card rail does not: a
 * movement that really happened and then really came back, days later, on its
 * own date.
 *
 * ─── THE EVENT BODY IS A POINTER ────────────────────────────────────────────
 *
 * Increase's webhook body is an Event object and nothing else:
 *
 *   {"type":"event","category":"ach_transfer.updated",
 *    "associated_object_type":"ach_transfer",
 *    "associated_object_id":"sandbox_ach_transfer_...","id":"event_...",
 *    "created_at":"..."}
 *
 * There is no amount in it, no status, no settlement timestamp and no return
 * code. Everything this consumer needs is read back with
 * `GET /ach_transfers/{id}`, which is why THE ORDER OF DELIVERY DOES NOT
 * MATTER HERE AT ALL. Every delivery about one transfer resolves to the same
 * current transfer, so a settlement notification that overtakes its submission
 * sees the same object the submission would have, applies the same set of
 * effects, and the second delivery is a no-op decided by
 * `journal_entry.idempotency_key` rather than by an `if`. The consumer does not
 * ask "what does this event say happened"; it asks "what does this transfer
 * now assert, and which of those facts have I not booked yet".
 *
 * `category` is used for exactly one decision — is this an `ach_transfer`, an
 * `inbound_ach_transfer`, or something with no money in it — and for the
 * `rail_event_semantics` key. It is never used to infer state.
 *
 * Deliberately NOT reusing `IncreaseAchRail.parseEvent()`: it gates on
 * `associated_object_id.startsWith('ach_transfer_')`, and every id in the
 * sandbox is prefixed `sandbox_ach_transfer_`, so every sandbox delivery would
 * be classified `unmodelled_event` and silently dropped. That is measured, not
 * guessed — the transfer this consumer was proven against is
 * `sandbox_ach_transfer_...`. This file matches on `associated_object_type`,
 * which is a field the provider sets rather than a prefix we hope for.
 *
 * ─── ASK THE TABLE ──────────────────────────────────────────────────────────
 *
 * The lifecycle step is not in the webhook type — Increase sends
 * `ach_transfer.updated` for submission, settlement, a notification of change
 * and a return alike — so the `rail_event_semantics` key is
 * `<category>/<step>` and the step is derived from the transfer's own shape
 * (`submission`, `settlement.settled_at`, `return`, `notifications_of_change`).
 * Every step this consumer is about to act on is resolved through
 * `resolveEventSemanticsBatch()` first, all-or-nothing, and an unclassified
 * step PARKS instead of posting. The table also names the field the value date
 * comes from, and this consumer READS THAT FIELD rather than deciding for
 * itself which timestamp a posting is dated by.
 *
 * The row that matters is `ach_transfer.updated/returned`:
 *
 *   semantics: new_event   value_date_source: payload.return.created_at
 *
 * A return is a NEW EVENT at a NEW value date. The money really did leave on
 * the settlement date and really did come back later, so the settlement stays
 * on the settlement day's statement and the return posts on the return day.
 * Booking it as a correction at the settlement date would erase a settlement
 * that happened and make an already-issued statement disagree with the
 * customer's own bank. If a future reviewer flips that row to `correction`,
 * this consumer does not quietly comply — it has no ACH correction path, so it
 * parks and says so. Guessing is the failure this table exists to prevent.
 *
 * ─── WHAT IT POSTS, AND WHAT IT REFUSES TO POST ─────────────────────────────
 *
 * An outbound ACH payment already has a ledger footprint before Increase ever
 * says a word: `approvals/release.ts` posts DR 2100.<business> / CR 2300 at
 * release, because the customer's money is committed the moment a second human
 * approves it. So:
 *
 *   submitted   posts NOTHING. The release entry IS the submitted leg, and
 *               this consumer names it in the log rather than booking it
 *               twice. If there is no release entry, the transfer exists on the
 *               rail without an approval behind it — that is a maker-checker
 *               alarm, not a posting, and it PARKS.
 *   settled     DR 2300 / CR 1110 at `settlement.settled_at`. The cash has now
 *               left the FBO account and the in-transit liability clears.
 *   returned    DR 1110 / CR 2100.<business> at `return.created_at`. The cash
 *               came back and the customer is made whole, on the day it
 *               happened, with the settlement still standing on its own day.
 *   NOC         posts NOTHING and moves no money; recorded, and see the honesty
 *               note on `applyStep` about where it is NOT stored.
 *
 * And money arriving, which used to post nothing at all because nothing could
 * say whose it was. §4b carries the measurement and the change:
 *
 *   inbound      DR 1110 / CR 2100.<business> at `effective_date`, plus the
 *   credit       uncleared-credit hold the ach/new availability policy asks for
 *                — two banking days, so the LEDGER balance moves and the
 *                AVAILABLE balance does not. Attribution is a LOOKUP against
 *                `virtual_account_number`, never a derivation and never a
 *                default: a credit naming a number nobody has mapped PARKS,
 *                exactly as every inbound credit did before.
 *   inbound      DR 2100.<business> / CR 1110 at
 *   recall       `transfer_return.returned_at` — a new event at the day it
 *                happened, with the arrival still standing on its own day —
 *                and it closes the hold the arrival opened, because a hold
 *                over a credit that has gone back withholds the money twice.
 *
 * Idempotence is three unique indexes and no `if`:
 *
 *   webhook_inbox  UNIQUE (provider, provider_event_id)  the envelope
 *   journal_entry  UNIQUE (idempotency_key)              the money
 *   ...and every key is derived from the TRANSFER, never from the delivery:
 *   `ach:settled:<transfer id>` and `ach:return:<transfer id>:<trace number>`.
 *   Ten deliveries about one settlement produce one entry.
 *
 * ─── WHAT HAS AND HAS NOT BEEN SEEN LIVE ────────────────────────────────────
 *
 * Measured against real, signature-verified Increase deliveries: see
 * docs/WEBHOOK-CONSUMERS.md, which lists every category this consumer has
 * actually been handed and every one it has not. Nothing in this header claims
 * a path is proven; that document says which ones are.
 */

import "server-only";

import { ledgerPosterActorId } from "@/lib/holds/store";
import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import {
  findEntryByIdempotencyKey,
  readAccountIdentity,
  resolveChartCodes,
} from "@/lib/ledger/readers";
import { findVirtualAccountNumber } from "@/lib/rails/increase/account-numbers";
import {
  IncreaseAchRail,
  type IncreaseAchTransfer,
  type IncreaseInboundAchTransfer,
} from "@/lib/rails/increase/client";
import {
  creditInboundAch,
  InboundAchBookingRefused,
  INBOUND_CREDIT_KEY_PREFIX,
  recallInboundAch,
} from "@/lib/rails/increase/inbound-ach-ledger";
import {
  describeResolutions,
  resolveEventSemantics,
  resolveEventSemanticsBatch,
  type ClassifiedResolution,
  type RailEventSemantics,
} from "@/lib/rails/semantics";

import {
  consumers,
  ignored,
  parked,
  processed,
  type ConsumerContext,
  type ConsumerRegistry,
  type ConsumerResult,
  type WebhookConsumer,
} from "../dispatch";
import type { InboxEvent } from "../inbox";
import { bookDateOfIso, readStoredPayload, readString } from "./payload";

/** The inbox's provider slug, and `rail_event_semantics.provider`. Same word. */
export const INCREASE_WEBHOOK_PROVIDER = "increase";

/** House accounts, by code. Ids are per-entity and resolved at posting time. */
export const ACH_PAYABLE_CODE = "2300";
export const FBO_CASH_CODE = "1110";

/** The object types this consumer models. Anything else is not ours. */
const OUTBOUND_OBJECT = "ach_transfer";
const INBOUND_OBJECT = "inbound_ach_transfer";

/**
 * The inbound ACH object, as Increase actually returns it.
 *
 * The type moved to `src/lib/rails/increase/client.ts` alongside
 * `getInboundTransfer()`, where the rest of this provider's wire shapes live,
 * and is re-exported here because the shape's difference from the OUTBOUND one
 * is a fact about this consumer's branches: `transfer_return.returned_at` and
 * not `return.created_at`, `trace_number` on the object and not on the return,
 * `account_number_id` — the field that says whose money it is. The measurement
 * behind each of those is on the type.
 */
export type { IncreaseInboundAchTransfer };

/**
 * Increase's own ledger view of a movement we book from the transfer.
 *
 * A settled ACH transfer produces an `ach_transfer.updated` AND a
 * `transaction.created`, and they are the same money seen twice — measured, on
 * 2026-09-11, when one $6,000.00 transfer produced five `ach_transfer.*`
 * deliveries and three `transaction`/`pending_transaction` ones. Booking from
 * both would double every payment on the book, so these are ignored ON PURPOSE
 * and the reason says which object carries the posting instead.
 */
const LEDGER_MIRROR_OBJECTS: ReadonlySet<string> = new Set([
  "transaction",
  "pending_transaction",
  "declined_transaction",
]);

/**
 * Objects that are configuration, not money: a subscription, an external
 * account, the account itself. Nothing they say can change a balance.
 */
const CONFIGURATION_OBJECTS: ReadonlySet<string> = new Set([
  "event_subscription",
  "external_account",
  "account",
  "account_number",
  "entity",
  "program",
  "routing_number",
  "oauth_connection",
  "group",
  "export",
  "file",
]);

/**
 * MONEY ON A RAIL THIS CONSUMER DOES NOT MODEL.
 *
 * These are NOT ignored. A wire really moves money, and filing one under
 * "recognised and skipped" is how a real movement disappears quietly. They park
 * — bounded, then a dead letter that names the rail and says nothing was
 * posted — because an operator should be told that money moved on a rail this
 * book has no consumer for, and told it in those words.
 */
const UNMODELLED_MONEY_OBJECTS: ReadonlySet<string> = new Set([
  "wire_transfer",
  "inbound_wire_transfer",
  "wire_drawdown_request",
  "check_transfer",
  "inbound_check_deposit",
  "account_transfer",
  "real_time_payments_transfer",
  "inbound_real_time_payments_transfer",
  "card_payment",
  "card_dispute",
  "ach_prenotification",
]);

// ---------------------------------------------------------------------------
// 1. The pointer
// ---------------------------------------------------------------------------

export interface EventPointer {
  readonly id: string;
  readonly category: string;
  readonly associatedObjectType: string;
  readonly associatedObjectId: string;
  readonly createdAt: string;
}

/**
 * Read the delivery as an Increase Event.
 *
 * Four fields and no more, because four is all the body has. A body missing any
 * of them is not an Increase event, and saying so is better than reaching into
 * it for a field that is not there.
 */
export function asEventPointer(payload: Record<string, unknown>): EventPointer | null {
  const id = readString(payload, ["id"]);
  const category = readString(payload, ["category"]);
  const associatedObjectType = readString(payload, ["associated_object_type"]);
  const associatedObjectId = readString(payload, ["associated_object_id"]);
  const createdAt = readString(payload, ["created_at"]);
  if (
    id === null ||
    category === null ||
    associatedObjectType === null ||
    associatedObjectId === null ||
    createdAt === null
  ) {
    return null;
  }
  return { id, category, associatedObjectType, associatedObjectId, createdAt };
}

// ---------------------------------------------------------------------------
// 2. Which steps does this transfer assert?
// ---------------------------------------------------------------------------

/**
 * The lifecycle steps the CURRENT transfer asserts, in lifecycle order.
 *
 * Not "what changed since last time" — there is no such thing here, because the
 * event carries no diff and the API offers no history. What the transfer
 * asserts is the set of facts that are true of it now, and every one of them is
 * booked under a key derived from the transfer, so re-asserting a fact already
 * booked costs one no-op INSERT and changes nothing.
 *
 * That is what makes out-of-order delivery a non-event on this rail: the
 * settlement delivery and the return delivery both assert
 * [submitted, settled, returned] once the return exists, and they converge.
 */
export function assertedSteps(transfer: IncreaseAchTransfer): string[] {
  const steps: string[] = [];
  if (transfer.submission?.submitted_at) steps.push("submitted");
  if (transfer.settlement?.settled_at) steps.push("settled");
  if ((transfer.notifications_of_change ?? []).length > 0) steps.push("notification_of_change");
  if (transfer.return !== null && transfer.return !== undefined) steps.push("returned");
  return steps;
}

/**
 * The value date for one step, from the field the TABLE names.
 *
 * `value_date_source` is a path like `payload.settlement.settled_at`. For
 * Increase "the payload" is the transfer read back, because the event body
 * carries none of these fields — the table is written in the vocabulary of the
 * object the fact lives on, and for this rail that object arrives one API call
 * later. `a[].b` takes the LAST element, which is the most recent notification
 * of change.
 *
 * A source the transfer cannot answer returns null and the caller PARKS. It
 * does not fall back to the event's own timestamp: the whole reason the table
 * names a field is that "when we were told" and "when it happened" are
 * different days, and a fallback would quietly book the wrong one.
 */
export function valueDateFromSource(
  // `unknown`, not `IncreaseAchTransfer`, because there are TWO objects on this
  // rail and the table names a field on whichever one the fact lives on: an
  // outbound `ach_transfer` and an inbound `inbound_ach_transfer`. The body
  // already walks the path with runtime checks at every hop, so widening the
  // parameter removes a cast rather than a guarantee. Every existing caller and
  // every existing test passes a narrower type and still typechecks.
  transfer: unknown,
  valueDateSource: string,
): string | null {
  const path = valueDateSource.replace(/^payload\./, "").split(".");
  let cursor: unknown = transfer;
  for (const rawSegment of path) {
    const isArray = rawSegment.endsWith("[]");
    const segment = isArray ? rawSegment.slice(0, -2) : rawSegment;
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (isArray) {
      if (!Array.isArray(cursor) || cursor.length === 0) return null;
      cursor = cursor[cursor.length - 1];
    }
  }
  // Increase dates `effective_date` as a bare YYYY-MM-DD and everything else as
  // an instant. A bare date is already a book date and must NOT be pushed
  // through a timezone conversion, which would move it a day.
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cursor)) return cursor;
  return bookDateOfIso(cursor);
}

// ---------------------------------------------------------------------------
// 3. The instruction behind the transfer
// ---------------------------------------------------------------------------

/**
 * What this consumer needs to know about our side of an outbound transfer.
 *
 * The join key is `idempotency_key`: `payment_instruction.idempotency_key` is
 * ours, we send it to Increase as the `Idempotency-Key` on
 * `POST /ach_transfers`, and Increase echoes it back on the transfer. It needs
 * no new column and no lookup table, and it is the same string on both sides of
 * the wire, which is what makes a support conversation possible.
 */
export interface OutboundLink {
  readonly instructionId: string;
  readonly accountId: string;
  readonly entityId: string;
  readonly amountCents: bigint;
  readonly releaseEntryId: string | null;
}

export async function findOutboundLink(
  clientReferenceId: string,
  conn: Sql,
): Promise<OutboundLink | null> {
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
               AND e.kind = 'released'
             ORDER BY e.occurred_at
             LIMIT 1) AS release_entry_id
      FROM payment_instruction p
     WHERE p.idempotency_key = ${clientReferenceId}
     LIMIT 1`;
  if (row === undefined) return null;

  // The entity is read through the ledger's own named reader rather than
  // joined in above. `src/lib/ledger/boundary.test.ts` is a ratchet: a module
  // outside `src/lib/ledger/` that writes its own SQL against `account`,
  // `journal_entry` or `journal_line` fails the build, and it is right to —
  // "which account is 1130" stood in six modules with four different sets of
  // predicates and therefore four different answers. This consumer adds none.
  const identity = await readAccountIdentity(row.account_id, conn);
  if (identity === null) return null;

  return {
    instructionId: row.id,
    accountId: row.account_id,
    entityId: identity.entityId,
    amountCents: BigInt(row.amount_cents),
    releaseEntryId: row.release_entry_id,
  };
}

/**
 * The two house accounts a settlement or a return touches, by code.
 *
 * One round trip for both, through `resolveChartCodes`, which is the reader
 * that owns the question. A code with no account is the CALLER's error to
 * raise, which is why the map is checked here rather than inside it.
 */
async function houseAccounts(
  entityId: string,
  codes: readonly string[],
  conn: Sql,
): Promise<ReadonlyMap<string, string>> {
  const resolved = await resolveChartCodes({ entityId, houseCodes: [...codes] }, conn);
  const out = new Map<string, string>();
  for (const code of codes) {
    const identity = resolved.get(code);
    if (identity === undefined) {
      throw new Error(`house account ${code} is missing from the chart`);
    }
    out.set(code, identity.accountId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Applying one classified step
// ---------------------------------------------------------------------------

export interface StepOutcome {
  readonly step: string;
  readonly canonicalKind: string;
  readonly valueDate: string;
  /** The entry this step is represented by, new or replayed. Null = no money. */
  readonly entryId: string | null;
  readonly note: string;
}

export type ApplyResult =
  | { readonly status: "applied"; readonly outcomes: readonly StepOutcome[] }
  | { readonly status: "park"; readonly kind: string; readonly ref: string; readonly reason: string };

/**
 * Book every classified step of one outbound transfer.
 *
 * One transaction for the whole delivery, so a crash halfway leaves the book
 * exactly as it was. It would be safe without one — each entry is keyed on the
 * transfer — but "half a delivery is applied" is a state nobody should ever
 * have to reason about in a debrief.
 */
export async function applyOutbound(args: {
  readonly transfer: IncreaseAchTransfer;
  readonly link: OutboundLink;
  readonly resolved: readonly ClassifiedResolution[];
  readonly inboxId: string;
  readonly conn?: Sql;
}): Promise<ApplyResult> {
  const conn = args.conn ?? sql;
  const { transfer, link } = args;
  const amountCents = BigInt(Math.abs(transfer.amount));

  // The approval authorised a number. If the rail is carrying a different one,
  // this consumer does not pick a side — it parks, in front of a human, with
  // both numbers in the reason. A webhook is not permission to move money the
  // maker-checker never saw.
  if (amountCents !== link.amountCents) {
    return {
      status: "park",
      kind: "payment_instruction_amount",
      ref: link.instructionId,
      reason:
        `Increase transfer ${transfer.id} is ${amountCents} cents; payment instruction ` +
        `${link.instructionId} was approved for ${link.amountCents} cents. Nothing was posted. ` +
        `An operator must decide which is right — the ledger will not reconcile a number no ` +
        `approver ever saw.`,
    };
  }

  const actorId = await ledgerPosterActorId(conn);

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const outcomes: StepOutcome[] = [];

    for (const resolution of args.resolved) {
      const row = resolution.row;

      // A `correction` row would mean "this repairs a past posting at the past
      // posting's date", which needs `reverseAndRebook()` and a matched target.
      // No ACH row is classified that way today, this consumer has no such
      // path, and inventing one on the fly is how a repair lands at the wrong
      // date. So it parks and names the row that would have to be implemented.
      if (resolution.valueDateAnchor === "original") {
        return {
          status: "park" as const,
          kind: "rail_event_semantics",
          ref: resolution.key,
          reason:
            `rail_event_semantics classifies '${resolution.key}' as a CORRECTION at the original ` +
            `value date. This consumer books ACH steps as new events only and has no ` +
            `reverse-and-rebook path for them, so it will not post this at a date it guessed.`,
        };
      }

      const valueDate = valueDateFromSource(transfer, row.valueDateSource);
      if (valueDate === null) {
        return {
          status: "park" as const,
          kind: "increase_value_date",
          ref: `${transfer.id}:${resolution.key}`,
          reason:
            `rail_event_semantics says the value date for '${resolution.key}' comes from ` +
            `'${row.valueDateSource}', and transfer ${transfer.id} does not carry it. Nothing ` +
            `was posted; the field usually appears on the next delivery.`,
        };
      }

      const outcome = await applyStep({
        canonicalKind: row.canonicalKind,
        step: resolution.key,
        valueDate,
        transfer,
        link,
        amountCents,
        actorId,
        inboxId: args.inboxId,
        conn: tx,
      });
      if (outcome.status === "park") return outcome;
      outcomes.push(outcome.outcome);
    }

    return { status: "applied" as const, outcomes };
  });
}

async function applyStep(args: {
  readonly canonicalKind: string;
  readonly step: string;
  readonly valueDate: string;
  readonly transfer: IncreaseAchTransfer;
  readonly link: OutboundLink;
  readonly amountCents: bigint;
  readonly actorId: string;
  readonly inboxId: string;
  readonly conn: Sql;
}): Promise<
  | { readonly status: "ok"; readonly outcome: StepOutcome }
  | { readonly status: "park"; readonly kind: string; readonly ref: string; readonly reason: string }
> {
  const { canonicalKind, step, valueDate, transfer, link, amountCents, conn } = args;
  const base = { step, canonicalKind, valueDate };

  switch (canonicalKind) {
    case "ach_originated":
      // "No money has moved and nothing posts to the financial book yet; the
      // payment_instruction is the record at this stage" — the table's own note.
      return {
        status: "ok",
        outcome: { ...base, entryId: null, note: "created at the provider; the instruction is the record" },
      };

    case "ach_submitted": {
      // The release entry IS this leg. `approvals/release.ts` posts
      // DR 2100.<business> / CR 2300 when the second approver presses release,
      // because that is when the customer's money is committed — not when the
      // ODFI happens to tell us. Posting it again here would double the
      // customer's debit and it would balance, which is the worst kind of bug.
      if (link.releaseEntryId === null) {
        return {
          status: "park",
          kind: "payment_instruction_release",
          ref: link.instructionId,
          reason:
            `Increase has submitted transfer ${transfer.id}, but payment instruction ` +
            `${link.instructionId} has no 'released' event — nobody approved it on this book. ` +
            `Nothing was posted. Either the release is still in flight, or money left the rail ` +
            `outside maker-checker and that is an incident, not a webhook.`,
        };
      }
      return {
        status: "ok",
        outcome: {
          ...base,
          entryId: link.releaseEntryId,
          note: "already booked by the approval release; this consumer posts nothing",
        },
      };
    }

    case "ach_settled": {
      // The cash actually left the FBO account: the in-transit liability we
      // raised at release is discharged against cash, on the settlement's own
      // date. The customer's balance does not move — it moved at release.
      const house = await houseAccounts(link.entityId, [ACH_PAYABLE_CODE, FBO_CASH_CODE], conn);
      const payable = house.get(ACH_PAYABLE_CODE) as string;
      const cash = house.get(FBO_CASH_CODE) as string;
      const entryId = await postEntry(
        {
          entityId: link.entityId,
          valueDate,
          book: "financial",
          description: `ACH settled — ${transfer.id}`,
          idempotencyKey: `ach:settled:${transfer.id}`,
          actorId: args.actorId,
          rail: "ach",
          externalRef: transfer.id,
          inboxId: args.inboxId,
          lines: [
            { accountId: payable, amountCents, memo: "ACH payable discharged" },
            { accountId: cash, amountCents: -amountCents, memo: "cash left the FBO account" },
          ],
        },
        conn,
      );
      return { status: "ok", outcome: { ...base, entryId, note: "DR 2300 / CR 1110" } };
    }

    case "ach_return": {
      // THE ROW PEOPLE GET WRONG, booked the way the table says. A new event at
      // its own value date: the settlement stays on the settlement day and this
      // lands on the return day. The customer is made whole and the cash comes
      // back into the FBO account.
      //
      // The trace number is in the key because a transfer can carry exactly one
      // return today and might carry a second (a dishonoured return) tomorrow —
      // keying on the transfer alone would make the second one invisible, which
      // is the failure mode that looks like everything is fine.
      const trace = transfer.return?.trace_number ?? "no-trace";
      const cash = (await houseAccounts(link.entityId, [FBO_CASH_CODE], conn)).get(
        FBO_CASH_CODE,
      ) as string;
      const reason = transfer.return?.raw_return_reason_code ?? transfer.return?.return_reason_code ?? "unknown";
      const entryId = await postEntry(
        {
          entityId: link.entityId,
          valueDate,
          book: "financial",
          description: `ACH return ${reason} — ${transfer.id}`,
          idempotencyKey: `ach:return:${transfer.id}:${trace}`,
          actorId: args.actorId,
          rail: "ach",
          externalRef: transfer.id,
          inboxId: args.inboxId,
          lines: [
            { accountId: cash, amountCents, memo: `returned by the RDFI (${reason})` },
            {
              accountId: link.accountId,
              amountCents: -amountCents,
              memo: `ACH return ${reason} — funds restored`,
            },
          ],
        },
        conn,
      );
      return { status: "ok", outcome: { ...base, entryId, note: `DR 1110 / CR 2100 (${reason})` } };
    }

    case "ach_notification_of_change": {
      // A NOC corrects the counterparty's routing or account number. No money
      // moves, so nothing posts — and being honest about the rest of it: this
      // build has NO payee-details store that a correction can be written back
      // to, so the corrected digits live in the inbox row and this log line and
      // nowhere else. An operator re-keys them. Saying that is better than a
      // consumer that looks like it applied a correction it never stored.
      const corrections = (transfer.notifications_of_change ?? [])
        .map((n) => `${n.change_code}=${n.corrected_data}`)
        .join(", ");
      return {
        status: "ok",
        outcome: {
          ...base,
          entryId: null,
          note: `notification of change recorded, not applied: ${corrections}`,
        },
      };
    }

    default:
      // A classified row whose canonical kind this consumer has never been
      // taught. The table decided something; this file cannot act on it. Park —
      // never post under a kind we do not understand.
      return {
        status: "park",
        kind: "increase_canonical_kind",
        ref: canonicalKind,
        reason:
          `rail_event_semantics classifies '${step}' as canonical kind '${canonicalKind}', which ` +
          `this consumer has no posting rule for. Nothing was posted.`,
      };
  }
}

// ---------------------------------------------------------------------------
// 4b. Money arriving — and the recall of money that arrived
// ---------------------------------------------------------------------------
//
// =============================================================================
// CAN AN INBOUND ACH CREDIT BE ATTRIBUTED? NOW YES — AND ONLY THROUGH A FACT
// =============================================================================
//
// It could not be, and the refusal that stood here was not a hunch about the
// schema. `GET /account_numbers` on the Increase sandbox, 2026-09-11, returned
// EXACTLY ONE object:
//
//     sandbox_account_number_96mzhz3n61f5p0jpvytc
//     account_number 7467448488   routing_number 123308582   name "primary"
//     account_id sandbox_account_zkfx1wcn4brwoaiyksj6
//
// One number, on the programme's own FBO account, shared by all six businesses
// on the book. An inbound ACH credit names `account_number_id`, and every
// inbound credit that could arrive named that one — so the field that is
// supposed to say whose money it is said "the programme's", which is not an
// answer. There was no `account_number -> business` table anywhere in
// `db/migrations/`, because no path issued per-customer numbers.
//
// `scripts/provision-account-numbers.mjs` now issues one number per business
// through `POST /account_numbers`, and
// `db/migrations/0042_virtual_account_numbers.sql` records whose each one is.
// So the question has an answer, and the answer is a LOOKUP:
// `findVirtualAccountNumber()` in `src/lib/rails/increase/account-numbers.ts`.
//
// -----------------------------------------------------------------------------
// THE REFUSAL IS NOT WEAKENED. IT IS THE SAME REFUSAL WITH A TABLE BEHIND IT
// -----------------------------------------------------------------------------
//
// A credit naming a number with no row in `virtual_account_number` still PARKS,
// with the same kind (`inbound_ach_account_mapping`) and the same disposition:
// nothing posted, an operator decides. There is NO fallback account, NO "the
// only business on the book", and NO "whoever this originator paid last time".
//
// That matters most for the number that is deliberately NOT mapped: the
// programme's own `primary`. Every historical inbound payment on this book was
// addressed to it — five inbound ACH deliveries and twenty-three inbound wires
// — and mapping it to some business would attribute all of them by decree. They
// were addressed to the programme. The honest answer for them is still that a
// person has to decide, and this consumer goes on saying so.
//
// The value of parking is that it refuses to guess. An attribution path with a
// default would keep the screens tidy and destroy exactly that.
//
// -----------------------------------------------------------------------------
// WHAT IT POSTS NOW, AND THE AVAILABILITY HALF THAT IS THE INTERESTING PART
// -----------------------------------------------------------------------------
//
//   inbound_ach_credit   DR 1110 / CR 2100.<business> at `effective_date`, PLUS
//                        an `uncleared_credit` hold under the ach/new
//                        funds-availability policy — two banking days. So the
//                        LEDGER balance moves and the AVAILABLE balance does
//                        not. Contrast the wire rail, where the same code and
//                        the same table release the hold on arrival because the
//                        policy row says zero days. Neither behaviour is an
//                        `if` in a consumer; both are a row of data.
//                        `creditInboundAch()` carries the argument.
//   inbound_ach_return   DR 2100.<business> / CR 1110 at
//                        `transfer_return.returned_at` — a NEW EVENT at the day
//                        it happened, never a correction at the arrival's date,
//                        because the money really did arrive on the effective
//                        date and the arrival day's statement must go on saying
//                        so. It also CLOSES the hold the arrival opened: a hold
//                        left standing against a credit that has gone back
//                        would withhold the same money twice.
//
// -----------------------------------------------------------------------------
// WHY THE WIRE RAIL'S ANSWER NEVER TRANSFERRED, AND STILL DOES NOT
// -----------------------------------------------------------------------------
//
// `increase-wire.ts` books exactly one inbound credit, and the reason it can is
// worth stating precisely: a `wire_transfer.updated/reversed` hangs off an
// OUTBOUND transfer WE sent, whose `Idempotency-Key` is
// `payment:<instruction id>`, and the instruction names the account and the
// account names the business. Attribution comes from our own book, not from the
// inbound message.
//
// ACH has no analogue. When an outbound ACH payment of ours comes back it does
// NOT arrive as an `inbound_ach_transfer`: it arrives as a `return` block on the
// SAME `ach_transfer` object, which `applyStep`'s `ach_return` arm has booked
// since it was written — proven on the real $6,000.00 R01 return of
// `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`. Every `inbound_ach_transfer` is
// therefore money from a stranger, and the ONLY thing on the message that can
// identify the receiver is the account number it was addressed to. That is why
// the fix had to be a virtual account number and could not be anything cleverer.
//
// -----------------------------------------------------------------------------
// AND A RECALL OF A CREDIT NOBODY COULD ATTRIBUTE IS STILL NOT A NO-OP
// -----------------------------------------------------------------------------
//
// Its LEDGER consequence is nothing — there is no entry to reverse and no hold
// to close, because nothing was booked. What is not nothing is what it does to
// the INBOX. A recalled credit used to leave its deliveries re-checking every
// few minutes for five hours and then dead-lettering onto a staff screen under
// "an operator must attribute it by hand", pointing a human at money that had
// already gone back to the originator. The recall is the fact that ENDS the
// operator's question, so this branch reports it and RESOLVES the delivery,
// naming the transfer so the parked `.created` sibling wakes and converges on
// the same read-back. Both rows clear. The park stops being a leak.
//
// WHAT THIS BRANCH NEVER DOES: initiate a money movement. Returning an inbound
// credit is an OPERATOR action taken against the Increase API, not something a
// webhook consumer decides for itself. A consumer that could send money back
// would be a consumer that could send money.

/**
 * The steps the CURRENT inbound object asserts, in lifecycle order.
 *
 * The same idea as `assertedSteps()` on the outbound path and for the same
 * reason: the event body is a pointer, every delivery about one transfer reads
 * back the same current object, and what that object ASSERTS is the set of
 * facts that are true of it now. Each is booked under a key derived from the
 * transfer, so a fact already booked costs one no-op INSERT.
 *
 * THE KEYS ARE TWO DIFFERENT EVENT TYPES, which is why this returns pairs
 * rather than nested steps. The table keys the arrival under the BARE
 * `inbound_ach_transfer.created` and the recall under
 * `inbound_ach_transfer.updated/returned`; it carries no `.updated/credit` row
 * and should not, because a credit is classified once, where it is created.
 *
 * THIS USED TO RETURN THE RECALL ALONE for a returned object, and that was
 * right when nothing could be booked: with no credit on the book there was
 * nothing for the arrival step to do. It is wrong now. A transfer that arrives
 * and is returned before we ever process a delivery asserts BOTH facts, and
 * booking only the return would debit a customer for a credit this book never
 * gave them. Both, in order, each at its own value date.
 */
export function inboundAssertedSteps(
  transfer: IncreaseInboundAchTransfer,
): readonly { readonly eventType: string; readonly nestedStep: string }[] {
  const steps = [{ eventType: `${INBOUND_OBJECT}.created`, nestedStep: "" }];
  if (transfer.transfer_return !== null && transfer.transfer_return !== undefined) {
    steps.push({ eventType: `${INBOUND_OBJECT}.updated`, nestedStep: "returned" });
  }
  return steps;
}

/** Has this book booked the credit for this transfer? */
async function inboundCreditEntryId(transferId: string, conn: Sql): Promise<string | null> {
  const entry = await findEntryByIdempotencyKey(`${INBOUND_CREDIT_KEY_PREFIX}${transferId}`, conn);
  return entry === null ? null : entry.entryId;
}

/**
 * Has Increase actually put the money in the FBO account?
 *
 * `acceptance` carries a `transaction_id` on Increase's own ledger, and
 * `settlement.settled_at` says the funds settled. Either is the money being
 * there. A transfer with neither has not been accepted yet — it can still be
 * declined — and `creditInboundAch()` refuses to book cash that has not landed.
 */
function inboundAccepted(transfer: IncreaseInboundAchTransfer): boolean {
  if (transfer.acceptance?.accepted_at) return true;
  return Boolean(transfer.settlement?.settled_at);
}

/**
 * One inbound ACH delivery, from the read-back to the answer.
 *
 * The shape mirrors the outbound path deliberately: read the object back, ask
 * the table what each asserted step means and where its value date comes from,
 * refuse anything the table classifies as a correction, and only then post.
 */
async function handleInbound(args: {
  readonly pointer: EventPointer;
  readonly event: InboxEvent;
  readonly ctx: ConsumerContext;
  readonly readInbound: (id: string) => Promise<IncreaseInboundAchTransfer>;
  readonly deps: IncreaseConsumerDeps;
}): Promise<ConsumerResult> {
  const { pointer, ctx } = args;
  const conn = args.deps.conn ?? sql;

  // THE ONE try/catch IN THIS FILE, AND THE REASON IT IS SAFE HERE AND NOT
  // TWENTY LINES DOWN. Nothing has been attributed yet, so nothing can be
  // mis-booked by a failed read: the fallback is the identical attribution
  // park, on a bounded schedule that retries the read. Below this point the
  // consumer posts, and every failure there is an unguarded throw — a bounded
  // retry in dispatch.ts — because a provider that did not answer is not a
  // provider that said "no".
  let transfer: IncreaseInboundAchTransfer;
  try {
    transfer = await args.readInbound(pointer.associatedObjectId);
  } catch (thrown) {
    return parked(
      "inbound_ach_account_mapping",
      pointer.associatedObjectId,
      `inbound ACH ${pointer.associatedObjectId} (${pointer.category}): the object could not be ` +
        `read back, so the virtual account numbers it was addressed to cannot be looked up and ` +
        `there is no way to tell which customer this credit belongs to — ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}. Nothing was posted. The ` +
        `read is retried on the next re-check; until it succeeds this park is the attribution ` +
        `refusal and nothing more.`,
    );
  }

  // The credit was refused at Increase: the money never reached the FBO
  // account, so there is nothing to attribute, nothing to post and no value
  // date to get wrong. Ending the row here is NOT the same answer as a
  // failure, which would burn the retry budget and dead-letter a non-event.
  // No table row is consulted because the table classifies MOVEMENTS, and a
  // declined inbound is the absence of one.
  if (transfer.decline !== null && transfer.decline !== undefined) {
    return ignored(
      `inbound ACH ${transfer.id} was DECLINED at Increase ` +
        `(${transfer.decline.reason ?? "no reason given"}); no money reached the FBO account and ` +
        `nothing was posted.`,
    );
  }

  // ASK THE TABLE, once per asserted fact. This is the lookup `docs/GAUNTLET.md`
  // reported as unreachable code: the consumer used to park on
  // `associated_object_type` before any of it ran.
  const asserted = inboundAssertedSteps(transfer);
  const resolutions: ClassifiedResolution[] = [];
  for (const step of asserted) {
    const semantics = await resolveEventSemantics(
      {
        provider: INCREASE_WEBHOOK_PROVIDER,
        eventType: step.eventType,
        nestedStep: step.nestedStep,
      },
      args.deps.semanticsRows === undefined ? {} : { rows: args.deps.semanticsRows },
    );
    if (semantics.status === "unclassified") {
      return parked(
        "rail_event_semantics",
        semantics.key,
        `no rail_event_semantics row for '${semantics.key}'; nobody has classified this step as a ` +
          `correction or a new event, and nothing about an inbound credit is decided by default.`,
      );
    }
    // The same refusal `applyOutbound` makes, kept identical on purpose: a
    // `correction` row means "repair a past posting at the past posting's
    // date", which needs `reverseAndRebook()` and a matched target, and this
    // consumer has no such path for ACH. It cannot fire today — both inbound
    // rows are `new_event` — and it is kept because the day somebody flips one
    // is the day this consumer must refuse rather than comply quietly.
    if (semantics.valueDateAnchor === "original") {
      return parked(
        "rail_event_semantics",
        semantics.key,
        `rail_event_semantics classifies '${semantics.key}' as a CORRECTION at the original value ` +
          `date. This consumer books ACH steps as new events only and has no reverse-and-rebook ` +
          `path for them, so nothing was posted.`,
      );
    }
    resolutions.push(semantics);
  }

  // THE FIELD THE TABLE NAMES, read off the object rather than chosen here.
  // For the arrival that is `effective_date`; for the recall it is
  // `transfer_return.returned_at` — measured, see `IncreaseInboundAchTransfer`
  // — and `db/migrations/0039_inbound_recall.sql` is what made it resolvable:
  // the row shipped naming `return.created_at`, copied from the OUTBOUND
  // object, which the inbound object does not carry.
  const dated: { readonly resolution: ClassifiedResolution; readonly valueDate: string }[] = [];
  for (const resolution of resolutions) {
    const valueDate = valueDateFromSource(transfer, resolution.row.valueDateSource);
    if (valueDate === null) {
      return parked(
        "increase_value_date",
        `${transfer.id}:${resolution.key}`,
        `rail_event_semantics says the value date for '${resolution.key}' comes from ` +
          `'${resolution.row.valueDateSource}', and inbound ACH ${transfer.id} does not carry it. ` +
          `Nothing was posted.`,
      );
    }
    dated.push({ resolution, valueDate });
  }

  // WHOSE MONEY IS THIS? A lookup against a fact somebody recorded, never a
  // derivation and never a default. Null is an answer: nobody has said.
  const owner = await findVirtualAccountNumber(transfer.account_number_id, conn);
  const amountCents = BigInt(Math.abs(transfer.amount));
  const recalled = transfer.transfer_return ?? null;

  ctx.logger.info("increase.inbound_ach_transfer.semantics", {
    inboxId: args.event.id,
    transferId: transfer.id,
    category: pointer.category,
    status: transfer.status,
    accountNumberId: transfer.account_number_id ?? null,
    attributedTo: owner === null ? null : `${owner.businessId} (${owner.legalName})`,
    steps: describeResolutions(resolutions),
    valueDates: dated.map((d) => `${d.resolution.key} @ ${d.valueDate}`),
  });

  /* ---- nobody has said whose number this is ------------------------------- */

  if (owner === null) {
    if (recalled !== null) {
      // The refusal has been overtaken by events. The money has gone back to
      // the originator, so there is no longer anything for an operator to
      // attribute — and pointing a person at it would waste their afternoon.
      // Nothing is posted, because nothing was ever booked to correct.
      ctx.logger.info("increase.inbound_ach_transfer.recalled", {
        inboxId: args.event.id,
        transferId: transfer.id,
        amountCents: String(amountCents),
        reason: recalled.reason ?? "unknown",
        returnedAt: recalled.returned_at ?? null,
        ledgerEffect:
          "none — the credit was never attributed, so it was never booked and there is nothing to correct",
      });
      return processed([{ kind: "inbound_ach_account_mapping", ref: transfer.id }]);
    }

    // THE REFUSAL, UNCHANGED IN SUBSTANCE. Park, not ignore — a credit nobody
    // can attribute is exactly what an operator should be shown, and filing it
    // under "recognised and skipped" would lose somebody's money quietly.
    const arrival = dated[0];
    return parked(
      "inbound_ach_account_mapping",
      transfer.id,
      `inbound ACH ${transfer.id} (${pointer.category}) names account_number_id ` +
        `${transfer.account_number_id ?? "(none)"}, and NOTHING ON THIS BOOK SAYS WHOSE THAT ` +
        `NUMBER IS — there is no virtual_account_number row for it, so there is no way to tell ` +
        `which customer this credit belongs to. It is most likely the programme's own FBO number, ` +
        `which is shared and is deliberately mapped to nobody. Nothing was posted. An operator ` +
        `must attribute it by hand, or return it to the originator. rail_event_semantics ` +
        `classifies this as '${arrival?.resolution.row.canonicalKind ?? "inbound_ach_credit"}' at ` +
        `value date ${arrival?.valueDate ?? "(unknown)"}, from ` +
        `${transfer.originator_company_name ?? "an unnamed originator"}, amount ${amountCents} ` +
        `cents.`,
    );
  }

  /* ---- it is somebody's, so book what the object asserts ------------------ */

  const posted: string[] = [];

  for (const { resolution, valueDate } of dated) {
    switch (resolution.row.canonicalKind) {
      case "inbound_ach_credit": {
        try {
          const receipt = await creditInboundAch({
            businessId: owner.businessId,
            credit: {
              transferId: transfer.id,
              amountCents,
              valueDate,
              originatorName: transfer.originator_company_name ?? null,
              traceNumber: transfer.trace_number ?? null,
              entryDescription: transfer.originator_company_entry_description ?? null,
              accepted: inboundAccepted(transfer),
              inboxId: args.event.id,
            },
            conn,
          });
          posted.push(
            `${resolution.key} @ ${valueDate} -> ${receipt.entryId} (DR 1110 / CR 2100 ` +
              `${owner.legalName}; held to ${receipt.schedule.releaseDate}, hold ${receipt.holdId})`,
          );
        } catch (thrown) {
          // A REFUSAL IS A PARK, NOT A FAILURE. `InboundAchBookingRefused`
          // carries a code and a sentence about a state a human has to change —
          // a business with no deposit leaf, a chart with no 9200, an
          // availability policy nobody wrote. Retrying it eight times and
          // dead-lettering would bury the sentence. Anything else thrown is a
          // genuine fault and goes up, where dispatch retries it.
          if (!(thrown instanceof InboundAchBookingRefused)) throw thrown;
          return parked("inbound_ach_booking", `${thrown.code}:${transfer.id}`, thrown.message);
        }
        break;
      }

      case "inbound_ach_return": {
        const booked = await inboundCreditEntryId(transfer.id, conn);
        if (booked === null) {
          // Reachable only if the arrival step above parked or was skipped —
          // it cannot happen in one pass, because the credit is booked first.
          // Kept because "recall an arrival this book never recorded" must
          // refuse rather than post a one-sided debit against a customer who
          // was never credited.
          return parked(
            "inbound_ach_credit_missing",
            transfer.id,
            `inbound ACH ${transfer.id} has been returned and this book carries no credit for it ` +
              `(${INBOUND_CREDIT_KEY_PREFIX}${transfer.id}). Debiting ${owner.legalName} for ` +
              `money they were never credited would be a posting with no event behind it. ` +
              `NOTHING WAS POSTED.`,
          );
        }
        try {
          const receipt = await recallInboundAch({
            businessId: owner.businessId,
            recall: {
              transferId: transfer.id,
              amountCents,
              valueDate,
              reason: recalled?.reason ?? "unknown",
              returnTransactionId: recalled?.transaction_id ?? null,
              inboxId: args.event.id,
            },
            conn,
          });
          posted.push(
            `${resolution.key} @ ${valueDate} -> ${receipt.entryId} (DR 2100 ${owner.legalName} / ` +
              `CR 1110; hold ${receipt.holdId ?? "none"} ` +
              `${receipt.holdClosedHere ? "closed here" : "already closed"}` +
              `${receipt.holdReleaseEntryId === null ? ", nothing left to release" : `, released by ${receipt.holdReleaseEntryId}`})`,
          );
        } catch (thrown) {
          if (!(thrown instanceof InboundAchBookingRefused)) throw thrown;
          return parked("inbound_ach_booking", `${thrown.code}:${transfer.id}`, thrown.message);
        }
        break;
      }

      default:
        return parked(
          "increase_canonical_kind",
          resolution.row.canonicalKind,
          `rail_event_semantics classifies '${resolution.key}' as canonical kind ` +
            `'${resolution.row.canonicalKind}', which this consumer has no rule for. Nothing was ` +
            `posted.`,
        );
    }
  }

  ctx.logger.info("increase.inbound_ach_transfer.applied", {
    inboxId: args.event.id,
    transferId: transfer.id,
    businessId: owner.businessId,
    accountNumber: `${owner.routingNumber}/${owner.accountNumber}`,
    amountCents: String(amountCents),
    // One line per step, naming the day each posting is dated. This is the
    // audit answer to "why is the recall dated Thursday and the credit still
    // dated Monday".
    posted,
  });

  // Naming the transfer wakes anything parked on it — including a sibling
  // delivery that parked on the attribution before the number was issued.
  return processed([
    { kind: "inbound_ach_transfer", ref: transfer.id },
    { kind: "inbound_ach_account_mapping", ref: transfer.id },
  ]);
}

// ---------------------------------------------------------------------------
// 5. The consumer
// ---------------------------------------------------------------------------

export interface IncreaseConsumerDeps {
  /** Injected in tests. Defaults to the real sandbox client at call time. */
  readonly getTransfer?: (id: string) => Promise<IncreaseAchTransfer>;
  /**
   * The inbound read-back, injectable for the same reason as the outbound one.
   *
   * The default WAS a bare `fetch` here, with a note saying it belonged on
   * `IncreaseAchRail` and was out of that change's write scope. It is there now
   * — `getInboundTransfer()` — and the difference is not tidiness: the client's
   * `request()` classifies errors, so a 500 from Increase, a malformed body and
   * "this transfer does not exist" stop being the same thrown `Error` at the
   * call site that has to decide whether to park or retry.
   */
  readonly getInboundTransfer?: (id: string) => Promise<IncreaseInboundAchTransfer>;
  readonly conn?: Sql;
  /**
   * Resolve semantics against these rows instead of the table. The seam is
   * `resolveEventSemantics`'s own (`opts.rows`), not a new one, and it exists
   * so the decision paths can be tested without a database. NOTHING in
   * production passes it: the table is the decision.
   */
  readonly semanticsRows?: readonly RailEventSemantics[];
}

export function createIncreaseAchConsumer(deps: IncreaseConsumerDeps = {}): WebhookConsumer {
  const readTransfer =
    deps.getTransfer ??
    (async (id: string) => {
      // Constructed per call, not at module scope: the API key is read at call
      // time so a rotated credential is picked up without a restart.
      const rail = new IncreaseAchRail({});
      const transfer = await rail.getTransfer(id);
      return transfer.raw as IncreaseAchTransfer;
    });

  const readInbound =
    deps.getInboundTransfer ??
    // Constructed per call, not at module scope, for the same reason as the
    // outbound read above: the API key is read at call time, so a rotated
    // credential is picked up without a restart.
    ((id: string) => new IncreaseAchRail({}).getInboundTransfer(id));

  return {
    provider: INCREASE_WEBHOOK_PROVIDER,

    async handle(event: InboxEvent, ctx: ConsumerContext): Promise<ConsumerResult> {
      const payload = readStoredPayload(event.payload);
      if (payload === null) return ignored("payload is not a JSON object");

      const pointer = asEventPointer(payload);
      if (pointer === null) {
        return ignored("payload is not an Increase event (no id / category / associated object)");
      }

      if (pointer.associatedObjectType === INBOUND_OBJECT) {
        return handleInbound({ pointer, event, ctx, readInbound, deps });
      }

      if (pointer.associatedObjectType !== OUTBOUND_OBJECT) {
        const object = pointer.associatedObjectType;

        if (LEDGER_MIRROR_OBJECTS.has(object)) {
          // Recognised and deliberately not acted on. Ending the row here is
          // NOT the same answer as a failure, which would retry eight times and
          // then dead-letter something that was never a problem.
          return ignored(
            `'${pointer.category}' is Increase's own ledger view of a movement this book posts ` +
              `from the transfer object (${pointer.associatedObjectId}). Booking it as well would ` +
              `double-count the payment, so it is recorded in the inbox and not posted.`,
          );
        }

        if (CONFIGURATION_OBJECTS.has(object)) {
          return ignored(
            `no money in '${pointer.category}': a ${object} is configuration, not a movement. ` +
              `Recorded in the inbox and not posted.`,
          );
        }

        if (UNMODELLED_MONEY_OBJECTS.has(object)) {
          return parked(
            "increase_unmodelled_rail",
            `${object}:${pointer.associatedObjectId}`,
            `'${pointer.category}' moves money on a rail this consumer does not model (${object}). ` +
              `NOTHING WAS POSTED and no balance on this book reflects it. The Increase consumer ` +
              `handles ACH only; a wire, a check or an internal account transfer needs its own ` +
              `rail_event_semantics rows and its own posting rules before anything is booked.`,
          );
        }

        // An object type nobody has decided about. PARK rather than ignore: the
        // one that gets waved through is the one Increase adds next, and the
        // cost of being wrong in that direction is a lost movement.
        return parked(
          "increase_object_type",
          object,
          `nobody has decided what an Increase '${object}' means for this book ` +
            `(${pointer.category}). It was verified and stored, and it is NOT being acted on. ` +
            `If it carries no money, add it to CONFIGURATION_OBJECTS; if it does, it needs ` +
            `rail_event_semantics rows and a posting rule first.`,
        );
      }

      // THE READ-BACK. Not wrapped in a try/catch: if the API call fails we do
      // not know the state, and answering `ignored` here would mark the row
      // done and lose the event. A throw is a bounded retry in dispatch.ts,
      // which is the correct outcome for "the provider did not answer".
      const transfer = await readTransfer(pointer.associatedObjectId);

      const steps = assertedSteps(transfer);
      if (steps.length === 0) {
        // The transfer exists and has been handed to nobody: no step, so the
        // bare category is the key and the table's `ach_transfer.created` row
        // answers it.
        steps.push("");
      }

      // THE STEP KEYS LIVE UNDER `.updated`, WHATEVER CATEGORY DELIVERED THEM.
      //
      // `rail_event_semantics` is keyed the way the provider fires: one webhook
      // type for the whole lifecycle, with the step nested —
      // `ach_transfer.updated/settled`, never `ach_transfer.created/settled`.
      // A `created` delivery whose read-back ALREADY shows a submission is the
      // ordinary out-of-order case (the transfer moved on while the first
      // notification was in flight), and asking the table for a key it was
      // never given would park a delivery that is perfectly classifiable.
      // MEASURED, 2026-09-11: the real `ach_transfer.created` delivery for
      // sandbox_ach_transfer_x5vdo5m7b6k924sszlms arrived after the transfer
      // had already been submitted, and parked on
      // 'ach_transfer.created/submitted' until this line existed.
      const eventTypeForSteps =
        steps.length === 1 && steps[0] === "" ? pointer.category : `${OUTBOUND_OBJECT}.updated`;

      const semantics = await resolveEventSemanticsBatch(
        {
          provider: INCREASE_WEBHOOK_PROVIDER,
          eventType: eventTypeForSteps,
          nestedSteps: steps,
        },
        deps.semanticsRows === undefined ? {} : { rows: deps.semanticsRows },
      );

      if (semantics.status === "unclassified") {
        return parked(
          "rail_event_semantics",
          semantics.key,
          `no rail_event_semantics row for '${semantics.key}'; nobody has classified this step as ` +
            `a correction or a new event, and posting money at a value date no human reviewed is ` +
            `the one failure this system has no alarm for`,
        );
      }

      // A `correction` row means "this repairs a past posting at the PAST
      // posting's date", which needs `reverseAndRebook()` and a matched target
      // entry. No ACH row is classified that way today and this consumer has no
      // such path, so it refuses BEFORE it touches the book — never posting a
      // repair at a date it guessed. `applyOutbound` keeps the same check, so
      // the two answers cannot drift apart.
      const correction = semantics.resolved.find((r) => r.valueDateAnchor === "original");
      if (correction !== undefined) {
        return parked(
          "rail_event_semantics",
          correction.key,
          `rail_event_semantics classifies '${correction.key}' as a CORRECTION at the original ` +
            `value date. This consumer books ACH steps as new events only and has no ` +
            `reverse-and-rebook path for them, so nothing was posted.`,
        );
      }

      ctx.logger.info("increase.ach_transfer.semantics", {
        inboxId: event.id,
        transferId: transfer.id,
        category: pointer.category,
        steps: describeResolutions(semantics.resolved),
      });

      const clientReferenceId = transfer.idempotency_key;
      if (clientReferenceId === null || clientReferenceId.length === 0) {
        return parked(
          "payment_instruction",
          transfer.id,
          `Increase transfer ${transfer.id} carries no idempotency_key, so it cannot be matched to ` +
            `a payment instruction on this book. Nothing was posted. A transfer originated outside ` +
            `this system has no approval behind it and must be attributed by an operator.`,
        );
      }

      const link = await findOutboundLink(clientReferenceId, deps.conn ?? sql);
      if (link === null) {
        // Genuinely out-of-order is possible here — the provider can tell us
        // about a transfer before our own write of the instruction commits —
        // so this parks rather than failing. Bounded: twelve re-checks, then a
        // dead letter naming the exact string that did not match.
        return parked(
          "payment_instruction",
          clientReferenceId,
          `no payment_instruction has idempotency_key '${clientReferenceId}' (Increase transfer ` +
            `${transfer.id}). Nothing was posted. Either the instruction has not been written yet, ` +
            `or this transfer was originated outside this system.`,
        );
      }

      if (transfer.amount < 0) {
        // A debit pull is money coming IN, with a different set of legs and a
        // different availability policy. It is not modelled, and half-modelling
        // it would be worse than saying so.
        return parked(
          "increase_debit_pull",
          transfer.id,
          `Increase transfer ${transfer.id} is a DEBIT (amount ${transfer.amount}): this consumer ` +
            `books outbound credits only. Nothing was posted.`,
        );
      }

      const applied = await applyOutbound({
        transfer,
        link,
        resolved: semantics.resolved,
        inboxId: event.id,
        ...(deps.conn === undefined ? {} : { conn: deps.conn }),
      });

      if (applied.status === "park") {
        ctx.logger.warn("increase.ach_transfer.parked", {
          inboxId: event.id,
          transferId: transfer.id,
          waitingFor: `${applied.kind}:${applied.ref}`,
          reason: applied.reason,
        });
        return parked(applied.kind, applied.ref, applied.reason);
      }

      ctx.logger.info("increase.ach_transfer.applied", {
        inboxId: event.id,
        transferId: transfer.id,
        instructionId: link.instructionId,
        status: transfer.status,
        amountCents: BigInt(Math.abs(transfer.amount)).toString(),
        // One line per step, naming the day each posting is dated. This is the
        // audit answer to "why is the return dated Thursday and the settlement
        // still dated Monday".
        posted: applied.outcomes.map(
          (o) => `${o.step} @ ${o.valueDate} -> ${o.entryId ?? "no posting"} (${o.note})`,
        ),
      });

      // Naming the transfer is what wakes anything parked on it, and naming the
      // instruction wakes a delivery that arrived before the instruction was
      // written.
      return processed([
        { kind: "ach_transfer", ref: transfer.id },
        { kind: "payment_instruction", ref: clientReferenceId },
      ]);
    },
  };
}

/** The consumer this deployment registers. */
export const increaseAchConsumer: WebhookConsumer = createIncreaseAchConsumer();

/**
 * Register it.
 *
 * An explicit call, not a module-level side effect: importing a file for a type
 * must not change behaviour, and registration order must not depend on import
 * order. The registry refuses a second registration for one provider unless
 * `replace` is passed.
 */
export function registerIncreaseAchConsumer(
  registry: ConsumerRegistry = consumers,
  opts: { replace?: boolean } = {},
): ConsumerRegistry {
  return registry.register(increaseAchConsumer, opts);
}
