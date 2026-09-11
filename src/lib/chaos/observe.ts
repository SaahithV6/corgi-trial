/**
 * What the dashboard reads: the invariants, the inbox, and the customer's
 * position — measured while chaos is running.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE INTERESTING FRAME IS NOT "NOTHING HAPPENED"
 *
 * A chaos dashboard that shows four green ticks and a flat line has proved
 * nothing, because a system that is doing nothing at all shows the same
 * picture. What this module reads is chosen so the screen shows the MECHANISM
 * working:
 *
 *   parked         climbing while deliveries land for a card nobody has bound
 *                  to a customer — the system holding a verified money event
 *                  and refusing to post it because it will not guess whose
 *                  money to move — and then draining to zero when the card is
 *                  registered.
 *   suppressed     the duplicate control's copies, absorbed by
 *                  `webhook_inbox UNIQUE (provider, provider_event_id)`.
 *   dead letters   bounded failure, in front of a human, rather than silence.
 *   invariants     all fourteen, all empty, THROUGHOUT. This is the claim.
 *   position       ledger balance flat while available drops — the brief's own
 *                  first live-fire line.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE INVARIANT LIST IS A COPY, AND THAT IS DELIBERATE
 *
 * It lives in `./invariants.ts` and mirrors `scripts/dbcheck.mjs` exactly. It
 * is duplicated rather than imported because `scripts/**` is not part of the
 * TypeScript program, and `invariants.test.ts` reads the gate off disk to
 * assert the two lists are identical. See that file for the failure it exists
 * to catch.
 * ───────────────────────────────────────────────────────────────────────────
 */

import 'server-only';

import { availableBalance, trialBalanceCents } from '@/lib/ledger/balances';
import { sql, type Sql } from '@/lib/ledger/db';

import { INVARIANT_VIEWS } from './invariants';

// Re-exported so `observe.ts` stays the one import surface for the dashboard,
// while the list itself lives in a module with no imports that the gate-sync
// test can read without a database.
export { INVARIANT_VIEWS };

export interface InvariantReading {
  readonly view: string;
  readonly claim: string;
  /** Rows returned. Anything but zero is a violated invariant. */
  readonly rows: number;
  /** Set when the view could not be read at all. Not a pass. */
  readonly error: string | null;
}

/**
 * Read every invariant.
 *
 * A view this role cannot read is NOT a pass, exactly as `dbcheck.mjs` decides
 * it. An unreadable invariant and a satisfied one look identical to a caller
 * that treats an exception as zero, and that is the failure mode this whole
 * repository keeps finding in its own guards.
 */
export async function readInvariants(conn: Sql = sql): Promise<InvariantReading[]> {
  const readings: InvariantReading[] = [];
  for (const [view, claim] of INVARIANT_VIEWS) {
    try {
      const rows = await conn.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${view}`);
      readings.push({ view, claim, rows: rows[0]?.n ?? 0, error: null });
    } catch (thrown) {
      readings.push({
        view,
        claim,
        rows: -1,
        error: thrown instanceof Error ? thrown.message.split('\n')[0]?.slice(0, 120) ?? 'unreadable' : 'unreadable',
      });
    }
  }
  return readings;
}

export interface InboxCounters {
  readonly pending: number;
  readonly parked: number;
  readonly dead: number;
  readonly done: number;
}

export interface ParkedByKind {
  readonly kind: string;
  readonly ref: string | null;
  readonly count: number;
  readonly reason: string | null;
}

/** Counts across the WHOLE inbox — every provider, chaos and real alike. */
export async function readInboxCounters(conn: Sql = sql): Promise<InboxCounters> {
  const rows = await conn<{ state: string; n: number }[]>`
    SELECT state::text AS state, count(*)::int AS n
      FROM webhook_inbox
     GROUP BY state`;
  const byState = new Map(rows.map((r) => [r.state, r.n]));
  return {
    pending: byState.get('pending') ?? 0,
    parked: byState.get('parked') ?? 0,
    dead: byState.get('dead') ?? 0,
    done: byState.get('done') ?? 0,
  };
}

/**
 * What the parked rows are waiting for.
 *
 * Grouped by `parked_on_kind` because that is the sentence worth showing: not
 * "seven things are stuck" but "seven deliveries are waiting for a card to be
 * registered, and nothing has been posted against a customer we had to guess".
 */
export async function readParkedByKind(conn: Sql = sql): Promise<ParkedByKind[]> {
  const rows = await conn<
    { parked_on_kind: string | null; parked_on_ref: string | null; n: number; reason: string | null }[]
  >`
    SELECT parked_on_kind,
           parked_on_ref,
           count(*)::int  AS n,
           min(parked_reason) AS reason
      FROM webhook_inbox
     WHERE state = 'parked'
     GROUP BY parked_on_kind, parked_on_ref
     ORDER BY count(*) DESC, parked_on_kind
     LIMIT 20`;
  return rows.map((r) => ({
    kind: r.parked_on_kind ?? 'unknown',
    ref: r.parked_on_ref,
    count: r.n,
    reason: r.reason,
  }));
}

export interface ChaosInboxRow {
  readonly id: string;
  readonly providerEventId: string;
  readonly eventType: string | null;
  readonly state: string;
  readonly receivedAt: string;
  readonly attempts: number;
  readonly parkAttempts: number;
  readonly parkedOnKind: string | null;
  readonly parkedOnRef: string | null;
  readonly parkedReason: string | null;
  readonly runId: string | null;
  readonly shapedBy: string | null;
}

/**
 * The inbox rows chaos originated, for one run.
 *
 * Found by the key space and the in-band marker, both of which are inside the
 * signed bytes — NOT by a column chaos added to `webhook_inbox`. Chaos does not
 * get to alter the money pipeline's schema in order to watch itself.
 */
export async function readChaosInbox(runId: string, conn: Sql = sql): Promise<ChaosInboxRow[]> {
  const rows = await conn<
    {
      id: string;
      provider_event_id: string;
      event_type: string | null;
      state: string;
      received_at: Date;
      attempts: number;
      park_attempts: number;
      parked_on_kind: string | null;
      parked_on_ref: string | null;
      parked_reason: string | null;
      run_id: string | null;
      shaped_by: string | null;
    }[]
  >`
    SELECT id, provider_event_id, event_type, state, received_at, attempts,
           park_attempts, parked_on_kind, parked_on_ref, parked_reason,
           run_id, shaped_by
      FROM v_chaos_inbox
     WHERE run_id = ${runId}
     ORDER BY received_at`;
  return rows.map((r) => ({
    id: r.id,
    providerEventId: r.provider_event_id,
    eventType: r.event_type,
    state: r.state,
    receivedAt: r.received_at.toISOString(),
    attempts: r.attempts,
    parkAttempts: r.park_attempts,
    parkedOnKind: r.parked_on_kind,
    parkedOnRef: r.parked_on_ref,
    parkedReason: r.parked_reason,
    runId: r.run_id,
    shapedBy: r.shaped_by,
  }));
}

export interface Position {
  readonly businessId: string;
  readonly ledgerCents: bigint;
  readonly availableCents: bigint;
  readonly holdsCents: bigint;
}

/**
 * The customer's position, through the ledger's own reader.
 *
 * `availableBalance` is `src/lib/ledger/balances`'s answer and this module does
 * not have a second one. The brief's first live-fire line — "available drops,
 * ledger balance does not" — is a statement about these two numbers, and it
 * would be worth nothing if chaos computed them itself.
 */
export async function readPosition(businessId: string): Promise<Position> {
  const balance = await availableBalance(businessId);
  return {
    businessId,
    ledgerCents: balance.ledgerCents,
    availableCents: balance.availableCents,
    holdsCents: balance.holdsCents,
  };
}

export async function readTrialBalance(): Promise<bigint> {
  return trialBalanceCents();
}

export interface ChaosObservation {
  readonly invariants: readonly InvariantReading[];
  readonly invariantsHold: boolean;
  readonly invariantsUnreadable: number;
  readonly inbox: InboxCounters;
  readonly parked: readonly ParkedByKind[];
  readonly trialBalanceCents: bigint;
  readonly position: Position | null;
  readonly asOf: string;
}

/**
 * One read, one instant.
 *
 * `asOf` is taken ONCE, before the reads, so a screenshot of this screen is a
 * consistent statement about one moment rather than a collage of several. That
 * is the same rule `payments/live-source.ts` states, and it matters more here:
 * the whole claim is "these held WHILE that ran", and a collage cannot make it.
 */
export async function observe(
  businessId: string | null,
  conn: Sql = sql,
): Promise<ChaosObservation> {
  const asOf = new Date().toISOString();
  const [invariants, inbox, parked, trial, position] = await Promise.all([
    readInvariants(conn),
    readInboxCounters(conn),
    readParkedByKind(conn),
    readTrialBalance(),
    businessId === null ? Promise.resolve(null) : readPosition(businessId),
  ]);

  return {
    invariants,
    // An unreadable view is not a satisfied one. Both conditions, explicitly.
    invariantsHold: invariants.every((i) => i.error === null && i.rows === 0),
    invariantsUnreadable: invariants.filter((i) => i.error !== null).length,
    inbox,
    parked,
    trialBalanceCents: trial,
    position,
    asOf,
  };
}
