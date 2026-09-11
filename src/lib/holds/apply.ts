/**
 * The state machine, such as it is.
 *
 * There is no `switch` on a state here, and no state column anywhere for one to
 * switch on. Processing an event is:
 *
 *     1. lock the authorisation                (serialises processors)
 *     2. add the facts to E                    (unique index decides duplicates)
 *     3. post the money the facts moved        (idempotency key decides replays)
 *     4. H_new := H(E)                         (a function of a set)
 *     5. if closed(E), write hold_closure      (PK(hold_id): exactly once)
 *     6. H_cur := memo_balance(hold)           (the journal's own answer)
 *     7. append H_new − H_cur, if non-zero     (compare-and-append)
 *
 * ALL SEVEN ARE ONE TRANSACTION. They were not, and the change is migration
 * 0036's, so the argument that used to be here is worth keeping beside the one
 * that replaced it.
 *
 * ─── The split that used to be here, and why it is gone ─────────────────────
 *
 * Steps 1–5 were one transaction and steps 1, 6, 7 a second. The stated reason
 * was crash safety in the RELEASE direction: the closure row is durable before
 * the release posting is attempted, `availableBalance()` reads "released" as
 * that row existing, so a process that dies between the two leaves the
 * customer's available balance already correct and the posting lands later.
 *
 * That argument is sound, and it buys nothing, because `v_hold_state` does not
 * read release from the closure row alone:
 *
 *     is_released = (closure ∧ ¬reversal)
 *                 ∨ (kind = 'card_auth' ∧ v_card_auth_hold.is_closed)
 *                 ∨ (kind = 'uncleared_credit' ∧ now() ≥ available_at)
 *
 * The second disjunct is `saw_final ∨ saw_close ∨ now() ≥ expires_at ∨ A ≤ 0`,
 * derived from the EVENT SET. For a card authorisation the money is therefore
 * free the moment the FACTS commit, whether or not the closure row landed and
 * whether or not the posting did. The split was protecting a customer-
 * favourable outcome that the derived predicate already guarantees.
 *
 * Run the same argument in the OPENING direction and it inverts: the facts
 * commit, `H(E)` says $50 is authorised, and the memo entry that withholds it
 * has not landed. Availability subtracts the memo balance, which is zero, so
 * the customer can spend money a merchant is going to claim. Measured on this
 * book: 342ms at p50, 2.1s at p95, over 474 authorisations. A process killed
 * inside that window leaves it permanently.
 *
 * So the two directions did not need opposite orderings; the release direction
 * needed no ordering at all. Merging costs nothing new either: step 3 ALREADY
 * calls `postEntry()` → `ledger_append()` inside this transaction while holding
 * the row lock, so the memo posting introduces no lock that was not taken here
 * before and no ordering that was not already established.
 *
 * What merging does change is the failure mode, and it changes it in the right
 * direction. Before: the facts commit and the withholding does not, so a crash
 * fails OPEN — money spendable that should not be. After: neither commits, the
 * envelope stays undelivered, the redelivery replays the lot, and a crash fails
 * CLOSED. Between "we forgot to withhold" and "we have not processed it yet",
 * only the second is a state a bank can be in.
 *
 * `settleHoldPosting()` keeps its own transaction and stays exported, because
 * `expiry.ts`, `completion.ts` and `scripts/repair-0028-premature-closures.mjs`
 * all call it from outside a delivery, and because the compare-and-append being
 * runnable at any time from anywhere is the property the recovery rests on.
 *
 * ─── And the recovery is still required ─────────────────────────────────────
 *
 * Atomicity fixes this code. It does not fix a hold written by something that
 * is not this code — which is what actually produced migration 0036 — nor a
 * deployed build older than this one, nor anything already in the book. See
 * `completion.ts`.
 *
 * ─── Why this is exactly-once ────────────────────────────────────────────────
 *
 * AT MOST ONCE: the release posting happens under a row lock on the
 * authorisation, and its amount is `H_new − H_cur` read inside that lock, so no
 * two processors can both see `H_cur = 5000` and both post `−5000`. Behind the
 * lock, the entry carries `idempotency_key = hold:<hold_id>:after:<event_id>`,
 * `UNIQUE` on `journal_entry`, so even a bug that bypassed the lock could not
 * append a second delta for the same event.
 *
 * AT LEAST ONCE IN EFFECT: availability does not depend on the posting. For a
 * card authorisation it re-derives release from the event set, so the moment
 * the FACTS commit the money is free, whether or not the memo entry ever lands.
 *
 * AND THE EFFECT IS IDEMPOTENT: after a release `H_cur = 0`, so every
 * recomputation yields `Δ = 0` and appends nothing. At-most-once posting plus
 * an at-least-once idempotent effect is exactly-once.
 *
 * What is NOT made exactly-once is the message. It cannot be; Lithic will
 * deliver it eight times if it feels like it. What is made exactly-once is the
 * state transition, by making state a function of an accumulating SET rather
 * than an increment on a mutable counter.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { reconcileSettlementEvent, type ReconcileOutcome } from "@/lib/interchange";
import { rootLogger } from "@/lib/log";
import type { Transaction } from "@/lib/rails/lithic/types";
import { resolveEventSemanticsBatch } from "@/lib/rails/semantics";

import { postCardCorrection, type CorrectionPosted } from "./corrections";
import { deriveCardEvents, type DerivedCardEvents } from "./lithic-events";
import { holdState, movesFinancialBook, type CardEvent, type HoldState } from "./model";
import {
  CARD_AUTH_EXPIRY_DAYS,
  closeHold,
  ensureAuthorization,
  insertCardEvents,
  ledgerPosterActorId,
  loadCardEvents,
  lockAuthorization,
  memoHoldBalance,
  postCardMovement,
  postHoldDelta,
  resolveCard,
  type AuthorizationIdentity,
} from "./store";

export const LITHIC_PROVIDER = "lithic";

/** The only Lithic webhook type that carries the lifecycle. See semantics.ts. */
export const LITHIC_LIFECYCLE_EVENT = "card_transaction.updated";

export interface ApplyContext {
  readonly provider?: string;
  /** The `webhook_inbox` row this came from, for provenance on the entries. */
  readonly inboxId?: string | null;
  readonly now?: Date;
  readonly actorId?: string;
  readonly conn?: Sql;
}

export interface HoldOutcome {
  readonly authId: string;
  readonly holdId: string;
  readonly providerAuthId: string;
  /** Facts that were new to `E`. Zero means the delivery was a pure replay. */
  readonly newEvents: number;
  readonly state: HoldState;
  /** `hold_closure` written by THIS call (false if it already existed). */
  readonly closurePosted: boolean;
  /**
   * Provider event ids this payload says the network REFUSED.
   *
   * Reporting only — the money consequence is already structural, because a
   * refused step is ingested under a kind that feeds no term of `H(E)` and
   * moves no financial book. See `deriveCardEvents`.
   */
  readonly refusedEvents: readonly string[];
  /** `H_new − H_cur`. Zero means the memo book already said the right thing. */
  readonly deltaCents: bigint;
  readonly memoEntryId: string | null;
  readonly financialEntryIds: readonly string[];
  /**
   * Corrections applied by this call, each a reversal at the ORIGINAL entry's
   * value date. Empty for every ordinary lifecycle event.
   */
  readonly corrections: readonly CorrectionPosted[];
  /**
   * Correction steps that arrived with nothing to correct, or with an
   * ambiguous choice. The caller PARKS on these — it must not post them at
   * their own date, which is exactly the wrong answer this path exists to fix.
   */
  readonly unmatchedCorrections: readonly UnmatchedCorrection[];
  /**
   * The rail adapter's independent reading of the same transaction disagrees
   * with ours. Not an error and never resolved silently — it is a
   * reconciliation signal, and the honest place for it is a break, not a guess.
   */
  readonly providerDisagrees: boolean;
  /**
   * What this delivery did to INTERCHANGE, one entry per settlement event it
   * touched. Empty for a payload that carried no clearing, force post or
   * refund — an authorisation earns nothing, which is the whole point.
   *
   * See `interchangeHook()` below for why it is reported rather than thrown.
   */
  readonly interchange: readonly InterchangeStep[];
}

/** One settlement event's interchange outcome, for the caller's receipt. */
export interface InterchangeStep {
  readonly providerEventId: string;
  readonly outcome: ReconcileOutcome["status"] | "failed";
  /** Present when the reconcile threw. The money path already committed. */
  readonly error?: string;
}

export interface UnmatchedCorrection {
  readonly providerEventId: string;
  /** The Lithic step, as `rail_event_semantics` names it. */
  readonly stepType: string;
  readonly reason: string;
}

export type ApplyResult =
  | ({ readonly status: "applied" } & HoldOutcome)
  /** The card token is not registered. The caller parks; it must not guess. */
  | { readonly status: "unknown_card"; readonly providerCardToken: string }
  /**
   * A step in this payload has no `rail_event_semantics` row, so nobody has
   * decided whether it is a correction at the original value date or a new
   * event at its own. Nothing was applied. The caller parks.
   *
   * The consumer resolves the same table before it calls here and parks first,
   * so in the webhook path this is unreachable — it exists because
   * `applyCardTransaction` is also called directly, and a direct caller must
   * not be the one path that gets a silent default.
   */
  | { readonly status: "unclassified_step"; readonly key: string };

function expiryFor(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CARD_AUTH_EXPIRY_DAYS * 86_400_000);
}

/**
 * The event whose arrival prompts the recompute, and the date it books at.
 *
 * Deterministic: the last member of the payload's derived set, so a replay of
 * the same payload produces the same idempotency key and therefore the same
 * no-op. `completion.ts` resolves the same event from the database — the last
 * member of the SET under `loadCardEvents()`'s ordering — so a repair and a
 * redelivery collide on one key instead of appending twice.
 */
function triggerOf(derived: DerivedCardEvents): {
  providerEventId: string;
  valueDate: string;
} {
  const trigger = derived.events.at(-1);
  return {
    providerEventId: trigger?.providerEventId ?? `state:${derived.providerAuthId}`,
    valueDate: trigger?.valueDate ?? derived.valueDate,
  };
}

/**
 * Steps 1–7: record the facts, move the money they moved, close the hold if the
 * event set says it is finished, and drive the memo book to `H(E)`.
 *
 * One transaction. See the module header for why the memo posting moved in
 * here, and for the argument it displaced.
 */
async function recordFacts(
  derived: DerivedCardEvents,
  /**
   * The provider event ids `rail_event_semantics` classified `correction`.
   *
   * A correction is still a FACT and still enters `E` — the network really did
   * say this — but it must not post an ordinary entry at its own date, so the
   * financial posting is skipped here and `postCardCorrection` reverses the
   * entry it corrects at the ORIGINAL date instead.
   */
  correctionIds: ReadonlySet<string>,
  ctx: Required<Pick<ApplyContext, "provider" | "now" | "actorId">> & {
    inboxId: string | null;
    conn: Sql;
  },
): Promise<
  | { status: "unknown_card"; providerCardToken: string }
  | {
      status: "recorded";
      identity: AuthorizationIdentity;
      newEvents: number;
      state: HoldState;
      closurePosted: boolean;
      financialEntryIds: string[];
      events: CardEvent[];
      deltaCents: bigint;
      memoEntryId: string | null;
      holdCents: bigint;
    }
> {
  const card = await resolveCard(ctx.provider, derived.providerCardToken, ctx.conn);
  if (!card) {
    return { status: "unknown_card", providerCardToken: derived.providerCardToken };
  }

  return ctx.conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    const identity = await ensureAuthorization(
      {
        provider: ctx.provider,
        providerAuthId: derived.providerAuthId,
        card,
        origin: derived.origin,
        valueDate: derived.valueDate,
        expiresAt: expiryFor(derived.createdAt),
      },
      tx,
    );

    // Step 1. Everything after this point is serialised per authorisation.
    await lockAuthorization(identity.authId, tx);

    // Step 2. The unique index decides which of these are new.
    const newEvents = await insertCardEvents(
      identity.authId,
      derived.events,
      ctx.inboxId,
      tx,
    );

    // Step 2b. THE VERDICT, beside the fact and in the same transaction.
    //
    // `card_auth_event` is append-only in two layers — `corgi_app` holds
    // SELECT and INSERT only, and a trigger refuses UPDATE for every role
    // including the owner — so the network's `result` cannot live ON the row
    // and is appended next to it instead (migration 0026). One row per event,
    // `PRIMARY KEY (event_id)`, which is what makes it exactly-once in the
    // same way `hold_closure` is.
    //
    // It is written HERE, inside the same transaction as the facts, because a
    // fact whose verdict landed separately could be committed without one —
    // and "we recorded the event but not whether it happened" is precisely the
    // state this whole change exists to end.
    //
    // NULL when the payload carried no `result` for the step: that is "we were
    // not told", which is not the same claim as APPROVED and is not invented
    // into one. `source = 'ingest'` arms the trigger that refuses to let a
    // refused step be filed under a kind that feeds the hold arithmetic.
    for (const event of derived.events) {
      await tx`
        INSERT INTO card_auth_event_result
               (event_id, result, provider_step, source, inbox_id)
        SELECT cae.id,
               ${derived.results.get(event.providerEventId) ?? null},
               ${derived.stepTypes.get(event.providerEventId) ?? null},
               'ingest',
               ${ctx.inboxId}::uuid
          FROM card_auth_event cae
         WHERE cae.auth_id = ${identity.authId}::uuid
           AND cae.provider_event_id = ${event.providerEventId}
        ON CONFLICT (event_id) DO NOTHING`;
    }

    // Step 3. Money, through postEntry() and therefore through ledger_append().
    // Every one of these is idempotent on `card:<kind>:<provider_event_id>`, so
    // a redelivery re-posts nothing even though we attempt all of them again.
    const financialEntryIds: string[] = [];
    for (const event of derived.events) {
      // The one branch in the money path, and it is the table's decision, not
      // this module's: a `correction` row means this event restates a figure
      // that was already booked, so posting it here would put the repair on
      // today's statement and leave the day it repairs wrong for ever.
      if (correctionIds.has(event.providerEventId)) continue;

      const entryId = await postCardMovement(
        {
          identity,
          event,
          actorId: ctx.actorId,
          externalRef: derived.providerAuthId,
          inboxId: ctx.inboxId,
        },
        tx,
      );
      if (entryId !== null) financialEntryIds.push(entryId);
    }

    // Step 4. H(E) over the FULL set as the database now holds it — not over
    // the payload, and not over "the set plus this event". Reading it back is
    // what makes the answer independent of which delivery this was.
    const events = await loadCardEvents(identity.authId, tx);
    const state = holdState(events, { expiresAt: identity.expiresAt, now: ctx.now });

    // Step 5. Closure before release. See the module header.
    //
    // `terminallyClosed`, NOT `closed`: a settlement that beat its
    // authorisation is transiently "closed" by `A <= 0`, and `hold_closure` is
    // append-only, so a closure written there could never be undone by the
    // authorisation that follows. See the note on `HoldState.terminallyClosed`.
    const closurePosted = state.terminallyClosed
      ? await closeHold(identity.holdId, closureReason(state), ctx.actorId, tx, "posting_path")
      : false;

    // Steps 6 and 7. THE COMPARE-AND-APPEND, in this transaction.
    //
    // `H(E)` is final by step 4 and nothing after this point can change it:
    // the corrections that run once this commits reverse and re-book on the
    // FINANCIAL book only — `readTargetEntry()` finds its target by
    // `financialPostingKey()` and requires the customer's 2100 leaf among the
    // lines, so no correction can reach a memo entry — and the interchange
    // hook posts 2200/4100. So the memo book computed here is the memo book
    // this delivery ends with, and there is nothing to recompute afterwards.
    const trigger = triggerOf(derived);
    const current = await memoHoldBalance(identity.holdId, identity.memoAccountId, tx);
    const delta = state.holdCents - current;
    const memoEntryId = await postHoldDelta(
      {
        identity,
        deltaCents: delta,
        valueDate: trigger.valueDate,
        providerEventId: trigger.providerEventId,
        description:
          delta > 0n
            ? `Card hold opened/increased ${derived.providerAuthId}`
            : `Card hold reduced/released ${derived.providerAuthId}`,
        actorId: ctx.actorId,
        externalRef: derived.providerAuthId,
        inboxId: ctx.inboxId,
      },
      tx,
    );

    return {
      status: "recorded" as const,
      identity,
      newEvents,
      state,
      closurePosted,
      financialEntryIds,
      events,
      deltaCents: delta,
      memoEntryId,
      holdCents: state.holdCents,
    };
  });
}

function closureReason(state: HoldState): string {
  if (state.sawClose) return "authorisation closed or expired by the network";
  if (state.sawFinal) return "final capture received";
  if (state.expired) return "authorisation expiry reached";
  return "authorisation fully reversed";
}

/**
 * Steps 1, 6, 7: the compare-and-append.
 *
 * Recomputes `H(E)` from the database rather than trusting anything the caller
 * carried in, reads the memo book's own balance under the same lock, and
 * appends the difference. Safe to call at any time, from anywhere, any number
 * of times: the answer for a hold that is already right is `Δ = 0`, and `Δ = 0`
 * posts nothing.
 */
export async function settleHoldPosting(
  identity: AuthorizationIdentity,
  args: {
    readonly providerEventId: string;
    readonly valueDate: string;
    readonly externalRef: string;
    readonly actorId: string;
    readonly now: Date;
    readonly inboxId?: string | null;
    readonly description?: string;
  },
  conn: Sql = sql,
): Promise<{ deltaCents: bigint; entryId: string | null; holdCents: bigint }> {
  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    await lockAuthorization(identity.authId, tx);

    const events = await loadCardEvents(identity.authId, tx);
    const state = holdState(events, { expiresAt: identity.expiresAt, now: args.now });
    const current = await memoHoldBalance(identity.holdId, identity.memoAccountId, tx);
    const delta = state.holdCents - current;

    const entryId = await postHoldDelta(
      {
        identity,
        deltaCents: delta,
        valueDate: args.valueDate,
        providerEventId: args.providerEventId,
        description:
          args.description ??
          (delta > 0n
            ? `Card hold opened/increased ${args.externalRef}`
            : `Card hold reduced/released ${args.externalRef}`),
        actorId: args.actorId,
        externalRef: args.externalRef,
        inboxId: args.inboxId ?? null,
      },
      tx,
    );

    return { deltaCents: delta, entryId, holdCents: state.holdCents };
  });
}

/**
 * Ask `rail_event_semantics` which of this payload's steps are CORRECTIONS.
 *
 * The table is the decision source and there is no fallback: an unclassified
 * step ends the whole call, because acting on the classified half of a payload
 * would post some of a transaction's money and park the rest. See the
 * all-or-nothing note on `resolveEventSemanticsBatch`.
 */
async function correctionEventIds(
  derived: DerivedCardEvents,
  conn: Sql,
): Promise<{ ok: true; ids: ReadonlySet<string> } | { ok: false; key: string }> {
  const steps = [...derived.stepTypes.values()];
  if (steps.length === 0) return { ok: true, ids: new Set() };

  const resolution = await resolveEventSemanticsBatch(
    {
      provider: LITHIC_PROVIDER,
      eventType: LITHIC_LIFECYCLE_EVENT,
      nestedSteps: steps,
    },
    { conn },
  );
  if (resolution.status === "unclassified") return { ok: false, key: resolution.key };

  const correcting = new Set(
    resolution.resolved
      .filter((r) => r.valueDateAnchor === "original")
      .map((r) => r.row.providerEventType),
  );

  const ids = new Set<string>();
  for (const [eventId, stepType] of derived.stepTypes) {
    // The table's key is `<webhook type>/<step>`; the map holds the bare step.
    if (correcting.has(`${LITHIC_LIFECYCLE_EVENT}/${stepType}`)) ids.add(eventId);
  }
  return { ok: true, ids };
}

/**
 * Apply one `card_transaction.updated` payload end to end.
 *
 * Idempotent by construction at three layers: the inbox refuses a redelivered
 * envelope, `card_auth_event` refuses a redelivered fact, and `journal_entry`
 * refuses a redelivered posting. Calling this twice with the same payload
 * produces the same database as calling it once, and the second call is decided
 * by Postgres at every one of those layers rather than by a check in here.
 *
 * A CORRECTION step takes the fourth path, and it is the one this system is
 * graded on: it is recorded as a fact like everything else, but its money goes
 * through `reverseAndRebook()` at the value date of the entry it corrects, so
 * that day's statement corrects itself rather than growing a second line.
 */
export async function applyCardTransaction(
  txn: Transaction,
  ctx: ApplyContext = {},
): Promise<ApplyResult> {
  const conn = ctx.conn ?? sql;
  const provider = ctx.provider ?? LITHIC_PROVIDER;
  const now = ctx.now ?? new Date();
  const inboxId = ctx.inboxId ?? null;
  const actorId = ctx.actorId ?? (await ledgerPosterActorId(conn));

  const derived = deriveCardEvents(txn);

  const classified = await correctionEventIds(derived, conn);
  if (!classified.ok) return { status: "unclassified_step", key: classified.key };

  const recorded = await recordFacts(derived, classified.ids, {
    provider,
    now,
    actorId,
    inboxId,
    conn,
  });
  if (recorded.status === "unknown_card") return recorded;

  // Corrections, in their own transactions. AFTER `recordFacts` has committed,
  // because a correction reverses an entry the same delivery may have just
  // posted — Lithic sends the whole `events[]` array every time, so a payload
  // routinely carries a movement and its correction together.
  const corrections: CorrectionPosted[] = [];
  const unmatchedCorrections: UnmatchedCorrection[] = [];
  for (const event of recorded.events) {
    if (!classified.ids.has(event.providerEventId)) continue;
    const stepType = derived.stepTypes.get(event.providerEventId);
    // Only steps carried by THIS payload are acted on: the reloaded set can
    // hold events from earlier deliveries whose step name we no longer have,
    // and their corrections were applied when they arrived.
    if (stepType === undefined) continue;

    const result = await postCardCorrection(
      {
        identity: recorded.identity,
        event,
        events: recorded.events,
        externalRef: derived.providerAuthId,
        actorId,
        inboxId,
        stepType,
      },
      conn,
    );
    if (result.status === "posted") corrections.push(result);
    else
      unmatchedCorrections.push({
        providerEventId: event.providerEventId,
        stepType,
        reason: result.reason,
      });
  }

  // NOTE: there is no compare-and-append here any more. It happened inside
  // `recordFacts`, in the same transaction as the facts it is derived from.
  // See the module header. `settleHoldPosting()` is still the way to run one
  // from OUTSIDE a delivery, and `expiry.ts` and `completion.ts` both do.

  // THE INTERCHANGE HOOK. Last, and after the corrections, deliberately —
  // see `interchangeHook()`.
  const interchange = await interchangeHook(derived, classified.ids, {
    provider,
    actorId,
    inboxId,
    conn,
  });

  return {
    status: "applied",
    authId: recorded.identity.authId,
    holdId: recorded.identity.holdId,
    providerAuthId: derived.providerAuthId,
    newEvents: recorded.newEvents,
    state: recorded.state,
    closurePosted: recorded.closurePosted,
    refusedEvents: derived.refused,
    deltaCents: recorded.deltaCents,
    memoEntryId: recorded.memoEntryId,
    financialEntryIds: recorded.financialEntryIds,
    corrections,
    unmatchedCorrections,
    // The adapter reads the same events by a different route and also reports
    // what Lithic itself claims. Disagreement is surfaced, never reconciled by
    // preferring one side — guessing in the webhook handler is worse than a
    // break someone looks at.
    //
    // Suppressed once the authorisation is closed, and that is not a fudge: the
    // adapter models `max(A − C, 0)` and nothing else, while closure also comes
    // from `is_final`, an explicit close, a full reversal and the expiry clock.
    // After a close the two answers are MEANT to differ, so a flag there would
    // be noise rather than a signal, and a break nobody can action is worse
    // than no break at all.
    providerDisagrees:
      !recorded.state.closed &&
      (derived.providerView.holdMatchesEvents === false ||
        derived.providerView.eventDerivedHoldCents !== recorded.holdCents),
    interchange,
  };
}

/**
 * Book, unbook and re-price the interchange this delivery's settlements are
 * worth.
 *
 * ─── Why this is here and not in postCardMovement() ─────────────────────────
 *
 * INTERCHANGE IS EARNED ON THE CLEARING, NOT ON THE AUTHORISATION, and this
 * module is unusually strict about that distinction already: an authorisation
 * moves the memo book only and there is no code path from one to a financial
 * posting. Booking revenue at authorisation would book it on money that may
 * never settle — the amount can change, the capture can never arrive, and an
 * expiry or a full reversal ends with nothing having moved. So the hook fires
 * exactly where the money does.
 *
 * It is not inside `postCardMovement()` because the interchange entry is a
 * SEPARATE entry (2200/4100) and not a third line on the clearing:
 * `postCardCorrection()` refuses to re-book an entry that is not exactly two
 * lines, so a third line would break the correction path for every partially
 * corrected settlement on this book. See migration 0031 §2.
 *
 * ─── Why it runs LAST, after the corrections ────────────────────────────────
 *
 * Lithic sends the whole `events[]` array every time, so one payload routinely
 * carries a settlement AND the correction that undoes it. Running after
 * `postCardCorrection()` means `reconcileSettlementEvent()` sees the
 * settlement's correction group in its final state and books, then immediately
 * unbooks, in one call — which is the same pair of facts the ledger would
 * carry if they had arrived days apart. Running first would book the revenue
 * and leave the unbooking to a step that might not run.
 *
 * ─── Why it is a REPORT and not a throw ─────────────────────────────────────
 *
 * By the time this runs, the customer's money has already moved and committed.
 * Throwing here would fail the webhook consumer and force a redelivery of work
 * that is already done — harmless, because every layer is idempotent, but it
 * would also mean a hole in the rate card could stop card settlements being
 * processed at all. A revenue-recognition problem must not take the money path
 * down with it.
 *
 * So a failure is reported in three places instead of one: on the result, in
 * the structured log, and — because the settlement stays unpriced —
 * `v_interchange_unpriced` lists it with its reason until someone acts. The
 * repair is to call the reconcile again; it is idempotent and total.
 *
 * ─── Correction events are skipped, and cannot double-count anyway ──────────
 *
 * A step the table classified `correction` posted no financial entry of its
 * own (`recordFacts` skips it), so there is no `card:<kind>:<event>` entry for
 * `v_interchange_candidate` to find and the reconcile would return
 * `not_found`. The explicit skip is belt to that braces, and it keeps the
 * receipt honest: a correction is not a settlement and should not appear as
 * one.
 */
async function interchangeHook(
  derived: DerivedCardEvents,
  correctionIds: ReadonlySet<string>,
  ctx: {
    readonly provider: string;
    readonly actorId: string;
    readonly inboxId: string | null;
    readonly conn: Sql;
  },
): Promise<readonly InterchangeStep[]> {
  const steps: InterchangeStep[] = [];

  for (const event of derived.events) {
    if (correctionIds.has(event.providerEventId)) continue;
    // Only the kinds that moved the financial book can have earned anything.
    if (!movesFinancialBook(event.kind)) continue;

    try {
      const outcome = await reconcileSettlementEvent(ctx.provider, event.providerEventId, {
        actorId: ctx.actorId,
        inboxId: ctx.inboxId,
        run: "interchange:card-webhook",
        conn: ctx.conn,
      });
      steps.push({ providerEventId: event.providerEventId, outcome: outcome.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rootLogger.error("interchange.reconcile_failed", {
        provider: ctx.provider,
        providerEventId: event.providerEventId,
        providerAuthId: derived.providerAuthId,
        error: message,
      });
      steps.push({
        providerEventId: event.providerEventId,
        outcome: "failed",
        error: message,
      });
    }
  }

  return steps;
}
