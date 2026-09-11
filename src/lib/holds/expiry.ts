/**
 * The expiry sweep.
 *
 * A card authorisation the merchant never captures does not get a webhook
 * saying so. It simply stops mattering, seven days later, by the network's own
 * rules. The design's answer to "what if your release job doesn't run" is that
 * the release predicate is derived — `v_card_auth_hold.is_closed` already
 * contains `now() >= expires_at`, so the ledger's own view of the hold goes to
 * zero on the clock with nothing running at all.
 *
 * This sweep therefore does not compute anything the database did not already
 * know. It does two things the database cannot do for itself:
 *
 *   1. writes the `hold_closure` row that `availableBalance()` reads, which is
 *      what frees the money on the customer's screen;
 *   2. appends the memo entry that drives the hold account back to zero, so the
 *      memo book agrees with the fold and `v_hold_drift` stays empty.
 *
 * Both are bookkeeping and both are idempotent. Running it twice is running it
 * once: the closure row has `PRIMARY KEY (hold_id)`, the expiry fact carries a
 * derived, stable `provider_event_id` so `UNIQUE (auth_id, provider_event_id)`
 * refuses the second copy, and the release posting is the same
 * compare-and-append every other path uses — `Δ = 0` after the first run.
 *
 * Running it NEVER is also safe, and that is the more interesting claim: the
 * customer's available balance is only wrong if `availableBalance()` counts a
 * hold that the clock has already released, which is exactly why the closure
 * row is written first and the posting second.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { bookDate } from "@/lib/mcp/time";

import { settleHoldPosting } from "./apply";
import { holdState } from "./model";
import {
  closeHold,
  findExpiredAuthorizations,
  insertCardEvents,
  ledgerPosterActorId,
  loadCardEvents,
  lockAuthorization,
  type AuthorizationIdentity,
} from "./store";

/**
 * The `provider_event_id` of the synthetic expiry fact.
 *
 * Derived from the authorisation, not generated, so it is the same string on
 * every sweep for ever. That is what makes the fact — and therefore the
 * release posting keyed `hold:<hold_id>:after:expiry:<auth_id>` — appear at
 * most once no matter how many sweeps run or how many run concurrently.
 */
export function expiryEventId(authId: string): string {
  return `expiry:${authId}`;
}

export interface ExpirySweepResult {
  readonly examined: number;
  readonly closed: number;
  readonly released: number;
  readonly releasedCents: bigint;
}

/**
 * Close and release every card hold whose clock has run out.
 *
 * `limit` bounds the batch so a serverless invocation finishes; call it again
 * until `examined` comes back below the limit.
 */
export async function sweepExpiredHolds(
  opts: {
    readonly now?: Date;
    readonly limit?: number;
    readonly actorId?: string;
    readonly conn?: Sql;
  } = {},
): Promise<ExpirySweepResult> {
  const conn = opts.conn ?? sql;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const actorId = opts.actorId ?? (await ledgerPosterActorId(conn));

  const due = await findExpiredAuthorizations(now, limit, conn);

  let closed = 0;
  let released = 0;
  let releasedCents = 0n;

  for (const identity of due) {
    const result = await expireOne(identity, { now, actorId, conn });
    if (result.closurePosted) closed += 1;
    if (result.deltaCents !== 0n) {
      released += 1;
      releasedCents -= result.deltaCents; // Δ is negative on a release.
    }
  }

  return { examined: due.length, closed, released, releasedCents };
}

/** One authorisation's expiry. Exported so a test can run it twice on purpose. */
export async function expireOne(
  identity: AuthorizationIdentity,
  args: { readonly now: Date; readonly actorId: string; readonly conn?: Sql },
): Promise<{ closurePosted: boolean; deltaCents: bigint; entryId: string | null }> {
  const conn = args.conn ?? sql;
  const eventId = expiryEventId(identity.authId);
  const valueDate = bookDate(args.now);

  const closurePosted = await conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    await lockAuthorization(identity.authId, tx);

    // The expiry joins E as a first-class fact rather than being inferred at
    // read time, so the event stream stays a complete account of what happened
    // to this authorisation. Amount zero: an expiry releases whatever remains,
    // it does not assert a figure of its own, and `H` reads `closed` from the
    // kind rather than from the amount.
    await insertCardEvents(
      identity.authId,
      [
        {
          kind: "expiry",
          amountCents: 0n,
          isFinal: true,
          valueDate,
          providerEventId: eventId,
        },
      ],
      null,
      tx,
    );

    const events = await loadCardEvents(identity.authId, tx);
    const state = holdState(events, { expiresAt: identity.expiresAt, now: args.now });
    if (!state.terminallyClosed) {
      // Unreachable while this function is only called for due authorisations,
      // and cheap insurance if that ever stops being true: an expiry sweep must
      // never close a hold the model still considers open.
      return false;
    }

    return closeHold(identity.holdId, "authorisation expired unused", args.actorId, tx);
  });

  const settled = await settleHoldPosting(
    identity,
    {
      providerEventId: eventId,
      valueDate,
      externalRef: identity.authId,
      actorId: args.actorId,
      now: args.now,
      description: "Card hold released on expiry",
    },
    conn,
  );

  return { closurePosted, deltaCents: settled.deltaCents, entryId: settled.entryId };
}
