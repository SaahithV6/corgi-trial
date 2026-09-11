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
 * Steps 1–5 are one transaction and steps 1, 6, 7 are a second. The split is
 * deliberate and it is the crash-safety argument made physical: the closure row
 * is durable before the release posting is attempted, and `availableBalance()`
 * reads "released" as that row existing. A process that dies between the two
 * leaves the customer's available balance already correct; the posting lands on
 * the next event or on the expiry sweep, and lands as a no-op if the balance is
 * already zero.
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
 * AT LEAST ONCE IN EFFECT: availability does not depend on the posting. It
 * subtracts `hold_closure`-open holds only, so the moment the closure row
 * commits the money is free, whether or not the memo entry ever lands.
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
import type { Transaction } from "@/lib/rails/lithic/types";
import { resolveEventSemanticsBatch } from "@/lib/rails/semantics";

import { postCardCorrection, type CorrectionPosted } from "./corrections";
import { deriveCardEvents, type DerivedCardEvents } from "./lithic-events";
import { holdState, type CardEvent, type HoldState } from "./model";
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
 * Steps 1–5: record the facts, move the money they moved, close the hold if the
 * event set says it is finished.
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
      ? await closeHold(identity.holdId, closureReason(state), ctx.actorId, tx)
      : false;

    return {
      status: "recorded" as const,
      identity,
      newEvents,
      state,
      closurePosted,
      financialEntryIds,
      events,
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

  // The event whose arrival prompted this recompute. Deterministic: the last
  // member of the payload's derived set, so a replay of the same payload
  // produces the same idempotency key and therefore the same no-op.
  const trigger = derived.events.at(-1);
  const providerEventId = trigger?.providerEventId ?? `state:${derived.providerAuthId}`;
  const valueDate = trigger?.valueDate ?? derived.valueDate;

  const settled = await settleHoldPosting(
    recorded.identity,
    {
      providerEventId,
      valueDate,
      externalRef: derived.providerAuthId,
      actorId,
      now,
      inboxId,
    },
    conn,
  );

  return {
    status: "applied",
    authId: recorded.identity.authId,
    holdId: recorded.identity.holdId,
    providerAuthId: derived.providerAuthId,
    newEvents: recorded.newEvents,
    state: recorded.state,
    closurePosted: recorded.closurePosted,
    deltaCents: settled.deltaCents,
    memoEntryId: settled.entryId,
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
        derived.providerView.eventDerivedHoldCents !== settled.holdCents),
  };
}
