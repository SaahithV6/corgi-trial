import "server-only";

/**
 * The card correction path: the one place a provider event stops being a new
 * line on today's statement and becomes a repair of an old one.
 *
 * ─── What was missing, and why it mattered ──────────────────────────────────
 *
 * `reverseAndRebook()` has existed and been well tested since the ledger was
 * written, and until this module it had exactly two non-test callers, both of
 * them demo harnesses. Nothing on the card rail called it. So the sentence in
 * the brief — "when a merchant reverses a settlement, the customer's balance
 * and their statement must both show the corrected position for the day it
 * happened" — was true of the machinery and false of the rail: a
 * `RETURN_REVERSAL` arriving from Lithic was posted by `postCardMovement()` as
 * an ordinary `force_post` at its OWN value date, so the day it corrected kept
 * its wrong figure for ever and the statement grew a second line instead of
 * correcting itself.
 *
 * `rail_event_semantics` had already said the opposite, in a reviewed row, for
 * both card correction steps. This module is what makes the code obey it.
 *
 * ─── The decision source is the table, never a switch in here ───────────────
 *
 * Nothing below tests `stepType === 'RETURN_REVERSAL'`. The caller resolves
 * every step against `rail_event_semantics` and hands this module the ones the
 * table classified `correction` (`valueDateAnchor === 'original'`). Adding a
 * correction step to the card rail is a row and a test, not an edit here.
 *
 * ─── What "the original" is, when the payload will not say ──────────────────
 *
 * A correction carries no field naming the entry it corrects. Lithic's
 * `events[]` array is flat: a `RETURN_REVERSAL` sits beside the `RETURN` it
 * undoes with nothing joining them but the transaction they share. So the link
 * has to be inferred, and an inference that can change its mind is a
 * double-posting bug waiting for a redelivery.
 *
 * The rule is therefore a PURE FUNCTION OF THE EVENT SET, in the same sense
 * `H(E)` is (see ./model.ts), and it is deliberately narrow:
 *
 *   1. Candidates are the events of this authorisation that moved the
 *      financial book in the OPPOSITE direction to the correction.
 *   2. If EXACTLY ONE candidate has the same magnitude, that is the target and
 *      the correction is a full reversal. This is the measured shape: Lithic's
 *      `RETURN_REVERSAL` is always the whole `RETURN`.
 *   3. Otherwise, if there is EXACTLY ONE candidate at all, the correction is
 *      partial: reverse it and re-book the net at the same value date.
 *   4. Otherwise the caller PARKS. Two identical clearings and one correction
 *      is genuinely ambiguous, and this system's answer to ambiguity is a
 *      human, not a guess. See `CorrectionUnmatched`.
 *
 * ─── Why this is idempotent without a single `if` ───────────────────────────
 *
 * Both writes carry keys derived from immutable facts and `UNIQUE` on
 * `journal_entry.idempotency_key` decides the replay:
 *
 *   reversal   `reversal:<original entry id>`      chosen by reverseAndRebook
 *   rebook     `card:correction:<provider event id>`   chosen here
 *
 * The target is resolved from `card_auth_event` — append-only, so a redelivery
 * sees the same set — to the entry keyed `card:<kind>:<provider event id>`,
 * which exists once and for ever. The chain is never followed to a rebook: if
 * it were, a replay would reverse the repair instead of re-deciding the same
 * repair, and the keys would no longer collide. So a redelivered correction
 * re-derives exactly the same two keys and Postgres writes nothing, which is
 * the same argument the rest of the hold machinery makes.
 *
 * ─── What this does NOT touch, deliberately ─────────────────────────────────
 *
 * The hold. A correction is a statement about MONEY, not about the
 * authorisation lifecycle: the clearing really did arrive, the network is only
 * saying its amount was wrong. `A(E)` and `C(E)` stay exactly what
 * `v_card_auth_hold` computes from the same rows, so `v_hold_drift` and
 * `v_hold_release_drift` stay at zero across a correction — the TypeScript
 * model and the SQL view are held equal by invariant and neither moved.
 */

import { reverseAndRebook } from "@/lib/ledger/post";
import { sql, type Sql } from "@/lib/ledger/db";

import { financialPostingKey, movesFinancialBook, type CardEvent } from "./model";
import type { AuthorizationIdentity } from "./store";

/**
 * Which way a financial card event pushes the customer's balance.
 *
 * `debit` takes money away (a clearing, a force post); `credit` gives it back
 * (a refund). It is read off the canonical kind rather than off a sign in the
 * payload, because Lithic's own signs are inconsistent between the transaction
 * and its events — see the header of ./lithic-events.ts.
 */
export type MoneyDirection = "debit" | "credit";

export function directionOf(event: CardEvent): MoneyDirection | null {
  if (!movesFinancialBook(event.kind)) return null;
  return event.kind === "refund" ? "credit" : "debit";
}

function opposite(direction: MoneyDirection): MoneyDirection {
  return direction === "debit" ? "credit" : "debit";
}

/** The idempotency key of the re-book half of a partial correction. */
export function correctionRebookKey(providerEventId: string): string {
  return `card:correction:${providerEventId}`;
}

// ---------------------------------------------------------------------------
// 1. Choosing the target
// ---------------------------------------------------------------------------

/** Why a correction could not be matched. Carried to the caller for the park. */
export interface CorrectionUnmatched {
  readonly status: "unmatched";
  readonly reason: string;
  /** How many opposite-direction candidates were in the set. */
  readonly candidates: number;
}

export interface CorrectionMatch {
  readonly status: "matched";
  readonly target: CardEvent;
  /** True when magnitudes agree and the correction wipes the entry out. */
  readonly full: boolean;
}

export type CorrectionTargetChoice = CorrectionMatch | CorrectionUnmatched;

/**
 * Pick the card event a correction corrects, from the authorisation's event
 * set. Pure: no database, no clock, so the four cases are provable in a unit
 * test and the answer cannot depend on which delivery asked.
 */
export function chooseCorrectionTarget(
  correction: CardEvent,
  events: readonly CardEvent[],
): CorrectionTargetChoice {
  const direction = directionOf(correction);
  if (direction === null) {
    return {
      status: "unmatched",
      reason: `correction event ${correction.providerEventId} has kind '${correction.kind}', which moves no money; there is nothing for it to correct`,
      candidates: 0,
    };
  }

  const wanted = opposite(direction);
  const candidates = events.filter(
    (e) =>
      e.providerEventId !== correction.providerEventId &&
      directionOf(e) === wanted &&
      e.amountCents > 0n,
  );

  const exact = candidates.filter((e) => e.amountCents === correction.amountCents);
  if (exact.length === 1 && exact[0] !== undefined) {
    return { status: "matched", target: exact[0], full: true };
  }

  if (exact.length > 1) {
    return {
      status: "unmatched",
      reason:
        `${exact.length} ${wanted} events of ${correction.amountCents} cents could each be the one ` +
        `correction ${correction.providerEventId} undoes, and nothing in the payload says which`,
      candidates: candidates.length,
    };
  }

  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { status: "matched", target: candidates[0], full: false };
  }

  return {
    status: "unmatched",
    reason:
      candidates.length === 0
        ? `no ${wanted} card event has posted on this authorisation yet, so correction ${correction.providerEventId} has nothing to correct — it may have arrived before the movement it corrects`
        : `${candidates.length} ${wanted} events could be the one correction ${correction.providerEventId} partially corrects, and nothing in the payload says which`,
    candidates: candidates.length,
  };
}

// ---------------------------------------------------------------------------
// 2. Reading the entry that target event posted
// ---------------------------------------------------------------------------

export interface TargetEntry {
  readonly entryId: string;
  /** The ORIGINAL value date. The whole reason this module exists. */
  readonly valueDate: string;
  /** Signed cents on the customer's own leaf: positive is a debit. */
  readonly customerCents: bigint;
  readonly lines: readonly { accountId: string; amountCents: bigint; currency: string }[];
}

/**
 * The financial entry a card event posted, found by the key that event's
 * posting was given. Never by "the most recent entry on this account": that
 * would be a different answer after a redelivery.
 */
export async function readTargetEntry(
  target: CardEvent,
  identity: AuthorizationIdentity,
  conn: Sql = sql,
): Promise<TargetEntry | null> {
  const key = financialPostingKey(target.kind, target.providerEventId);

  const [entry] = await conn<{ id: string; value_date: string }[]>`
    SELECT id, value_date::text AS value_date
      FROM journal_entry
     WHERE idempotency_key = ${key}`;
  if (!entry) return null;

  const lines = await conn<{ account_id: string; amount_cents: bigint; currency: string }[]>`
    SELECT account_id, amount_cents, currency
      FROM journal_line WHERE entry_id = ${entry.id}::uuid
     ORDER BY ordinal`;

  const customer = lines.find((l) => l.account_id === identity.accountId);
  if (customer === undefined) return null;

  return {
    entryId: entry.id,
    valueDate: entry.value_date,
    customerCents: customer.amount_cents,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      amountCents: l.amount_cents,
      currency: l.currency,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. Posting the correction
// ---------------------------------------------------------------------------

export interface CorrectionPosted {
  readonly status: "posted";
  readonly providerEventId: string;
  readonly targetEntryId: string;
  readonly reversalEntryId: string;
  readonly rebookEntryId: string | null;
  readonly correctionGroupId: string;
  /** The value date the repair was booked AT — the original's, always. */
  readonly valueDate: string;
  /** What the customer's leaf now nets to for this event, in signed cents. */
  readonly netCustomerCents: bigint;
}

export type CorrectionResult = CorrectionPosted | CorrectionUnmatched;

export interface PostCorrectionArgs {
  readonly identity: AuthorizationIdentity;
  /** The correction event, as `rail_event_semantics` classified it. */
  readonly event: CardEvent;
  /** Every canonical event of this authorisation, as the database holds them. */
  readonly events: readonly CardEvent[];
  /** The provider's transaction token, for `external_ref` on the re-book. */
  readonly externalRef: string;
  readonly actorId: string;
  readonly inboxId: string | null;
  /** The step name the table classified, for the audit trail on the entries. */
  readonly stepType: string;
}

/**
 * Apply one correction event to the ledger.
 *
 * Reverses the entry it corrects AT THAT ENTRY'S VALUE DATE, and re-books the
 * remainder there too when the correction is partial. Both halves land in the
 * original's correction group, so the audit trail for "what happened to this
 * money" is one query on `correction_group_id`.
 *
 * Returns `unmatched` rather than throwing when there is nothing to correct or
 * the choice is ambiguous: the caller parks, and a park is recoverable in a way
 * an exception in a webhook handler is not.
 */
export async function postCardCorrection(
  args: PostCorrectionArgs,
  conn: Sql = sql,
): Promise<CorrectionResult> {
  const choice = chooseCorrectionTarget(args.event, args.events);
  if (choice.status === "unmatched") return choice;

  const entry = await readTargetEntry(choice.target, args.identity, conn);
  if (entry === null) {
    return {
      status: "unmatched",
      reason:
        `card event ${choice.target.providerEventId} (${choice.target.kind}) is in the event set but ` +
        `has posted no financial entry yet, so correction ${args.event.providerEventId} has nothing to reverse`,
      candidates: 1,
    };
  }

  // The correction's own effect on the customer, signed the way the ledger
  // signs a line: a debit correction takes money away.
  const correctionSigned =
    directionOf(args.event) === "credit" ? -args.event.amountCents : args.event.amountCents;
  const net = entry.customerCents + correctionSigned;

  const reason =
    `${args.stepType} ${args.event.providerEventId} corrects it` +
    (net === 0n ? " in full" : ` to ${net} cents on the customer`);

  // A full correction is a reversal and nothing else — the entry was a false
  // statement about its own day, and the honest repair is to take it back
  // there rather than to restate it at a number nobody asserted.
  if (net === 0n) {
    const { reversalEntryId, correctionGroupId } = await reverseAndRebook(
      { originalEntryId: entry.entryId, reason, actorId: args.actorId },
      conn,
    );
    return {
      status: "posted",
      providerEventId: args.event.providerEventId,
      targetEntryId: entry.entryId,
      reversalEntryId,
      rebookEntryId: null,
      correctionGroupId,
      valueDate: entry.valueDate,
      netCustomerCents: 0n,
    };
  }

  // Partial: the same two accounts, at the same value date, for the corrected
  // figure. Rebuilding the lines from the ORIGINAL's rather than from the chart
  // means a re-book cannot silently land on a different pair of accounts than
  // the entry it replaces.
  const other = entry.lines.find((l) => l.accountId !== args.identity.accountId);
  if (entry.lines.length !== 2 || other === undefined) {
    return {
      status: "unmatched",
      reason:
        `entry ${entry.entryId} has ${entry.lines.length} lines; a partial card correction can only ` +
        `re-book a two-line entry without inventing an allocation`,
      candidates: 1,
    };
  }

  const { reversalEntryId, rebookEntryId, correctionGroupId } = await reverseAndRebook(
    {
      originalEntryId: entry.entryId,
      reason,
      actorId: args.actorId,
      rebook: {
        // THE ORIGINAL'S DATE. Not today's, and not the correction's.
        valueDate: entry.valueDate,
        book: "financial",
        description: `Card ${args.stepType} ${args.externalRef} (corrected)`,
        idempotencyKey: correctionRebookKey(args.event.providerEventId),
        rail: "card",
        externalRef: args.externalRef,
        ...(args.inboxId !== null ? { inboxId: args.inboxId } : {}),
        lines: [
          { accountId: args.identity.accountId, amountCents: net },
          { accountId: other.accountId, amountCents: -net },
        ],
      },
    },
    conn,
  );

  return {
    status: "posted",
    providerEventId: args.event.providerEventId,
    targetEntryId: entry.entryId,
    reversalEntryId,
    rebookEntryId,
    correctionGroupId,
    valueDate: entry.valueDate,
    netCustomerCents: net,
  };
}
