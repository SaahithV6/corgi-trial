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
import { readAccountIdentity, resolveChartCodes } from "@/lib/ledger/readers";
import { IncreaseAchRail, type IncreaseAchTransfer } from "@/lib/rails/increase/client";
import {
  describeResolutions,
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
  transfer: IncreaseAchTransfer,
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
// 5. The consumer
// ---------------------------------------------------------------------------

export interface IncreaseConsumerDeps {
  /** Injected in tests. Defaults to the real sandbox client at call time. */
  readonly getTransfer?: (id: string) => Promise<IncreaseAchTransfer>;
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
        // Money we are being SENT. The table classifies it
        // (`inbound_ach_transfer.created` -> `inbound_ach_credit`), and this
        // consumer still refuses to post it, for a reason that is about the
        // schema and not about the rail: an inbound credit names a destination
        // account NUMBER, and this build issues no virtual account numbers, so
        // there is no mapping from that number to a customer. Posting it would
        // mean guessing whose money it is.
        //
        // PARK, not ignore. Parking is bounded — twelve re-checks, then a dead
        // letter in front of a human — and a credit nobody can attribute is
        // exactly what an operator should be shown. Ignoring it would file
        // somebody's money under "recognised and skipped".
        return parked(
          "inbound_ach_account_mapping",
          pointer.associatedObjectId,
          `inbound ACH ${pointer.associatedObjectId} (${pointer.category}): this build issues no ` +
            `virtual account numbers, so there is no way to tell which customer an inbound credit ` +
            `belongs to. Nothing was posted. An operator must attribute it by hand.`,
        );
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
