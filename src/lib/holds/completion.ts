/**
 * The completion sweep: the opening whose memo posting never landed.
 *
 * ─── What this is for ───────────────────────────────────────────────────────
 *
 * `expiry.ts` is the clock. This is its mirror at the other end of the
 * lifecycle. An authorisation arrives, the facts commit, and the memo entry
 * that withholds the money does not. The fold over the card events says $50 is
 * authorised; the memo book says nothing is held; the customer can spend money
 * a merchant is going to claim. `v_hold_drift` reports it, correctly and
 * immediately — and then nothing happens, because reporting is all a view can
 * do.
 *
 * ─── Why it is needed even though the opening is now atomic ─────────────────
 *
 * `applyCardTransaction()` posts the memo entry in the SAME transaction as the
 * facts, so no delivery it handles can leave this state. That closes the
 * window for one path. It does not close it for:
 *
 *   1. a hold written by something that is not `apply.ts` at all — the case
 *      that actually produced this file, where a test suite hand-wrote a hold,
 *      an authorisation and an event with raw SQL and never posted a memo
 *      entry because it never knew it had to;
 *   2. a build that is deployed and older than this one. Decision 056 measured
 *      exactly that: the repository's ingest fix sat in the tree for eight
 *      hours while the host Lithic posts to ran the previous commit;
 *   3. every hold already standing in the book from before the change.
 *
 * A code change fixes the code from now on. It does not fix the database, and
 * it does not fix the callers that never went through the code. The recovery
 * has to be a job.
 *
 * ─── Why it is safe to run at any moment, including mid-delivery ────────────
 *
 * It is not made safe by waiting. `completeOne()` goes through
 * `settleHoldPosting()`, which takes the same row lock on the authorisation
 * that every other processor takes, recomputes `H(E)` from the database inside
 * that lock, reads the memo book's own answer inside that lock, and appends
 * the difference. Racing a live delivery, one of the two computes `Δ` and the
 * other computes `Δ = 0` and posts nothing. That is the same
 * compare-and-append the whole module rests on, proved by scenario 7 of
 * `holds.integration.test.ts` with two workers on one event.
 *
 * `minAgeSeconds` therefore exists for the OPERATOR, not for correctness: it
 * lets a human ask "show me the ones nothing is coming for" without the
 * in-flight ones — measured at 342ms p50, 2.1s p95 — cluttering the report. It
 * defaults to zero, because a default that skipped rows would be a guard that
 * excluded the state it exists to catch, and this build has nineteen of those
 * written down already.
 *
 * ─── The idempotency key is the one the delivery would have used ────────────
 *
 * `hold:<hold_id>:after:<provider_event_id>`, where the event is the last
 * member of the set — which is what `derived.events.at(-1)` resolves to for
 * the delivery that opened the hold. So if the delivery whose posting was lost
 * is ever redelivered, `apply.ts` recomputes `Δ = 0` and appends nothing,
 * rather than racing a second entry in beside this one. The repair is
 * indistinguishable from the posting that should have happened, which is what
 * a repair to an append-only book ought to be.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { rootLogger } from "@/lib/log";

import { settleHoldPosting } from "./apply";
import { ledgerPosterActorId, type AuthorizationIdentity } from "./store";

/**
 * One row of `v_hold_posting_incomplete` — a card-auth hold whose memo book
 * disagrees with the fold over its event set, with the identity a repair needs
 * and the provenance a human needs.
 */
export interface IncompleteHoldPosting {
  readonly identity: AuthorizationIdentity;
  readonly provider: string;
  readonly providerAuthId: string;
  /** The memo book's own answer, in natural (positive) terms. */
  readonly memoBalanceCents: bigint;
  /** `H(E)` — what the fold over the card events says is held. */
  readonly targetHoldCents: bigint;
  /** `target − memo`. Positive means the customer is under-withheld. */
  readonly missingCents: bigint;
  readonly lastEventId: string;
  /** The ORIGINAL value date of that event. The repair books at it. */
  readonly lastEventValueDate: string;
  readonly lastEventAt: Date;
  readonly ageSeconds: number;
  /**
   * Did this identity come out of `ensureAuthorization()`?
   *
   * False means some other path wrote the rows directly, and that path is not
   * going to post the memo entry later — it never knew it had to.
   */
  readonly throughApply: boolean;
  /** Is there a `webhook_inbox` delivery behind any of these facts? */
  readonly fromWebhook: boolean;
}

export interface HoldCompletionResult {
  readonly holdId: string;
  readonly providerAuthId: string;
  /** `H(E) − memo`, as computed under the lock. Zero means it self-healed. */
  readonly deltaCents: bigint;
  readonly entryId: string | null;
}

export interface HoldCompletionSweepResult {
  readonly examined: number;
  /** Holds where a memo entry was actually appended. */
  readonly completed: number;
  /** Δ came back zero: something else finished it between the read and the lock. */
  readonly alreadyDone: number;
  /** Net cents moved into the memo book. Positive is money now withheld. */
  readonly withheldCents: bigint;
  readonly failures: readonly { holdId: string; error: string }[];
}

/**
 * The holds whose memo posting has not landed.
 *
 * Reads `v_hold_posting_incomplete`, which is defined FROM `v_hold_drift`, so
 * this cannot range over fewer rows than the invariant that reports them. See
 * migration 0036 §1 and §2 — the equality is asserted there, in both
 * directions, in the migration that creates the view.
 */
export async function findIncompleteHoldPostings(
  opts: {
    readonly minAgeSeconds?: number;
    readonly limit?: number;
    readonly conn?: Sql;
  } = {},
): Promise<IncompleteHoldPosting[]> {
  const conn = opts.conn ?? sql;
  const minAge = opts.minAgeSeconds ?? 0;
  const limit = opts.limit ?? 100;

  const rows = await conn<
    {
      hold_id: string;
      auth_id: string;
      provider: string;
      provider_auth_id: string;
      origin: string;
      expires_at: Date;
      account_id: string;
      memo_account_id: string;
      entity_id: string;
      memo_balance_cents: bigint;
      target_hold_cents: bigint;
      missing_cents: bigint;
      last_event_id: string;
      last_event_value_date: string;
      last_event_at: Date;
      age_seconds: number;
      through_apply: boolean;
      from_webhook: boolean;
    }[]
  >`
    SELECT hold_id, auth_id, provider, provider_auth_id, origin, expires_at,
           account_id, memo_account_id, entity_id,
           memo_balance_cents, target_hold_cents, missing_cents,
           last_event_id,
           last_event_value_date::text            AS last_event_value_date,
           last_event_at,
           EXTRACT(epoch FROM age)::float8        AS age_seconds,
           through_apply, from_webhook
      FROM v_hold_posting_incomplete
     WHERE EXTRACT(epoch FROM age) >= ${minAge}
     ORDER BY last_event_at
     LIMIT ${limit}`;

  return rows.map((r) => ({
    identity: {
      authId: r.auth_id,
      holdId: r.hold_id,
      accountId: r.account_id,
      memoAccountId: r.memo_account_id,
      entityId: r.entity_id,
      expiresAt: new Date(r.expires_at),
      origin: r.origin,
    },
    provider: r.provider,
    providerAuthId: r.provider_auth_id,
    memoBalanceCents: BigInt(r.memo_balance_cents),
    targetHoldCents: BigInt(r.target_hold_cents),
    missingCents: BigInt(r.missing_cents),
    lastEventId: r.last_event_id,
    lastEventValueDate: r.last_event_value_date,
    lastEventAt: new Date(r.last_event_at),
    ageSeconds: Number(r.age_seconds),
    throughApply: r.through_apply,
    fromWebhook: r.from_webhook,
  }));
}

/**
 * Finish one hold's opening.
 *
 * Nothing is decided here. The amount is `H(E) − memo_balance`, read inside
 * the authorisation's row lock by `settleHoldPosting()`, and the value date is
 * the one on the event that should have driven the posting — never today's,
 * because the day the money should have been withheld is the day the statement
 * has to show it.
 */
export async function completeOne(
  row: IncompleteHoldPosting,
  args: { readonly actorId: string; readonly now?: Date; readonly conn?: Sql },
): Promise<HoldCompletionResult> {
  const conn = args.conn ?? sql;
  const settled = await settleHoldPosting(
    row.identity,
    {
      providerEventId: row.lastEventId,
      valueDate: row.lastEventValueDate,
      externalRef: row.providerAuthId,
      actorId: args.actorId,
      now: args.now ?? new Date(),
      description: `Card hold posting completed by sweep ${row.providerAuthId}`,
    },
    conn,
  );
  return {
    holdId: row.identity.holdId,
    providerAuthId: row.providerAuthId,
    deltaCents: settled.deltaCents,
    entryId: settled.entryId,
  };
}

/**
 * Complete every hold whose memo posting never landed.
 *
 * `limit` bounds the batch so a serverless invocation finishes; call it again
 * until `examined` comes back below the limit. Total and idempotent: a second
 * run over the same holds computes `Δ = 0` for each and appends nothing.
 *
 * A hold that throws is logged, counted and SKIPPED rather than aborting the
 * batch. One authorisation whose entity is missing a house account must not
 * stop the other ninety-nine customers getting their holds back on the book,
 * and the row stays in `v_hold_drift` — loudly — until someone looks.
 */
export async function sweepIncompleteHoldPostings(
  opts: {
    readonly minAgeSeconds?: number;
    readonly limit?: number;
    readonly now?: Date;
    readonly actorId?: string;
    readonly conn?: Sql;
  } = {},
): Promise<HoldCompletionSweepResult> {
  const conn = opts.conn ?? sql;
  const now = opts.now ?? new Date();
  const actorId = opts.actorId ?? (await ledgerPosterActorId(conn));

  const due = await findIncompleteHoldPostings({
    ...(opts.minAgeSeconds !== undefined ? { minAgeSeconds: opts.minAgeSeconds } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    conn,
  });

  let completed = 0;
  let alreadyDone = 0;
  let withheldCents = 0n;
  const failures: { holdId: string; error: string }[] = [];

  for (const row of due) {
    try {
      const result = await completeOne(row, { actorId, now, conn });
      if (result.deltaCents === 0n) {
        alreadyDone += 1;
        continue;
      }
      completed += 1;
      withheldCents += result.deltaCents;
      rootLogger.info("holds.completion.posted", {
        holdId: result.holdId,
        providerAuthId: result.providerAuthId,
        deltaCents: result.deltaCents.toString(),
        entryId: result.entryId,
        ageSeconds: Math.round(row.ageSeconds),
        throughApply: row.throughApply,
        fromWebhook: row.fromWebhook,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rootLogger.error("holds.completion.failed", {
        holdId: row.identity.holdId,
        providerAuthId: row.providerAuthId,
        error: message,
      });
      failures.push({ holdId: row.identity.holdId, error: message });
    }
  }

  return { examined: due.length, completed, alreadyDone, withheldCents, failures };
}
