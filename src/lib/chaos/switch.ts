/**
 * The switches: arm, disarm, and the one function that answers "is chaos on".
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE RULE THIS MODULE ENFORCES, AND WHERE IT ACTUALLY LIVES
 *
 * A demo control that can be left on is worse than no demo control. If the
 * deployed URL is showing a graders' demo, a forgotten switch is
 * indistinguishable from a broken build — and the person who forgot it is by
 * definition not looking.
 *
 * So the bound is NOT here. `armControl` validates, and validation in an
 * application is a promise. The bound is `chaos_control_bounded` in migration
 * 0029:
 *
 *     CHECK (expires_at > armed_at
 *            AND expires_at <= armed_at + interval '10 minutes')
 *
 * There is no code path, no direct `psql`, and no future worker's bug that can
 * write a chaos switch lasting eleven minutes. Postgres refuses the row. The
 * check in `armControl` exists to produce a readable error before Postgres
 * produces an unreadable one; the bounds themselves live in `./bounds.ts`, which
 * has no database import so `bounds.test.ts` can exercise them without one.
 *
 * And expiry is not a sweeper. `v_chaos_active` filters on `now()`, so a
 * control that has run out is not "ignored by the reader that remembered to
 * check" — it is ABSENT from the only relation anything reads. There is no
 * cron to fail, no job to be dropped by a recycled instance, and no window in
 * which one reader thinks chaos is on and another thinks it is off.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHY OFF IS A DELETE. `chaos_control` has no `enabled` column. A switch whose
 * off state is another row is a switch with two truths, and the first time
 * those two truths disagree it will be in front of the panel. Absence is off.
 */

import 'server-only';

import { sql, type Sql } from '@/lib/ledger/db';

import {
  ChaosControlError,
  validateArm,
  type ArmRequest,
} from './bounds';
import {
  CHAOS_MAX_SECONDS,
  CHAOS_PROVIDER,
  isChaosControl,
  type ActiveControl,
  type ChaosControl,
  type ChaosParams,
  type ChaosState,
  type ExpiredControl,
} from './types';

// The bounds live in `./bounds.ts`, which has no database import, so the gate
// can exercise them without a Postgres connection. Re-exported here because
// this is the module callers reach for when they arm something.
export { ChaosControlError, validateArm, type ArmRequest };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ActiveRow {
  control: string;
  armed_at: Date;
  expires_at: Date;
  armed_by: string;
  params: Record<string, unknown>;
  seconds_remaining: number;
}

interface ExpiredRow {
  control: string;
  armed_at: Date;
  expires_at: Date;
  armed_by: string;
  seconds_since_expiry: number;
}

function toParams(control: ChaosControl, raw: Record<string, unknown>): ChaosParams {
  switch (control) {
    case 'webhooks_off':
      return { control, provider: CHAOS_PROVIDER };
    case 'settlement_delay':
      return { control, seconds: typeof raw['seconds'] === 'number' ? raw['seconds'] : 0 };
    case 'duplicate_delivery':
      return { control, copies: typeof raw['copies'] === 'number' ? raw['copies'] : 1 };
    case 'reorder_window':
      return { control, seconds: typeof raw['seconds'] === 'number' ? raw['seconds'] : 1 };
  }
}

/**
 * The whole answer to "is chaos on", from one read.
 *
 * EVERY caller uses this — the banner, the dashboard, the planner, the release
 * gate and each server action. The failure this shape exists to prevent is a
 * page that renders "chaos off" from one query while an action reads "chaos
 * on" from another, which is how a screenshot ends up disagreeing with the
 * system it is a screenshot of.
 */
export async function readChaosState(conn: Sql = sql): Promise<ChaosState> {
  const [activeRows, expiredRows] = await Promise.all([
    conn<ActiveRow[]>`
      SELECT control, armed_at, expires_at, armed_by, params, seconds_remaining
        FROM v_chaos_active
       ORDER BY expires_at DESC`,
    conn<ExpiredRow[]>`
      SELECT control, armed_at, expires_at, armed_by, seconds_since_expiry
        FROM v_chaos_expired
       ORDER BY expires_at DESC
       LIMIT 20`,
  ]);

  const active: ActiveControl[] = activeRows.flatMap((row) => {
    if (!isChaosControl(row.control)) return [];
    return [
      {
        control: row.control,
        armedAt: row.armed_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        armedBy: row.armed_by,
        secondsRemaining: row.seconds_remaining,
        params: toParams(row.control, row.params),
      },
    ];
  });

  const expired: ExpiredControl[] = expiredRows.flatMap((row) => {
    if (!isChaosControl(row.control)) return [];
    return [
      {
        control: row.control,
        armedAt: row.armed_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        armedBy: row.armed_by,
        secondsSinceExpiry: row.seconds_since_expiry,
      },
    ];
  });

  // The LAST control to run out is when the screen is clean again. Reported as
  // one instant because "chaos is off at 21:09:14Z" is a sentence a grader can
  // hold in their head, and four separate countdowns is not.
  const allClearAt =
    active.length === 0
      ? null
      : active
          .map((c) => c.expiresAt)
          .sort()
          .at(-1) ?? null;

  return {
    on: active.length > 0,
    active,
    expired,
    allClearAt,
    secondsUntilAllClear: active.reduce((max, c) => Math.max(max, c.secondsRemaining), 0),
    readAt: new Date().toISOString(),
  };
}

/** Is `webhooks_off` armed right now? The release gate's only question. */
export function webhooksOff(state: ChaosState): boolean {
  return state.active.some((c) => c.control === 'webhooks_off');
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/**
 * Arm one control. Re-arming resets the clock rather than adding a second row.
 *
 * The `expires_at` is computed by POSTGRES (`now() + interval`) and not by this
 * process, so the bound is measured against the same clock the expiry filter
 * uses. A serverless instance with a skewed clock cannot buy itself extra time.
 */
export async function armControl(req: ArmRequest, conn: Sql = sql): Promise<ActiveControl> {
  const { params } = validateArm(req);
  const seconds = Math.trunc(req.seconds);

  try {
    await conn`
      INSERT INTO chaos_control (control, armed_at, expires_at, armed_by, armed_by_id, params)
      VALUES (
        ${req.control},
        now(),
        now() + make_interval(secs => ${seconds}),
        ${req.actor},
        ${req.actorId ?? null},
        ${conn.json(params)}
      )
      ON CONFLICT (control) DO UPDATE
         SET armed_at    = now(),
             expires_at  = now() + make_interval(secs => ${seconds}),
             armed_by    = EXCLUDED.armed_by,
             armed_by_id = EXCLUDED.armed_by_id,
             params      = EXCLUDED.params`;
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (message.includes('chaos_control_bounded')) {
      // The database said no. This is the guard working, and the message says
      // so rather than reporting a generic write failure.
      throw new ChaosControlError(
        `the database refused this arming: a chaos control may not outlive its arming by more ` +
          `than ${String(CHAOS_MAX_SECONDS / 60)} minutes (chaos_control_bounded, migration 0029).`,
      );
    }
    throw thrown;
  }

  await recordChaosEvent(
    {
      kind: 'armed',
      control: req.control,
      actor: req.actor,
      detail: `armed ${req.control} for ${String(seconds)}s`,
      params,
    },
    conn,
  );

  const state = await readChaosState(conn);
  const armed = state.active.find((c) => c.control === req.control);
  if (armed === undefined) {
    // Only reachable if `seconds` was so small the row expired between the
    // INSERT and the read. Reported rather than papered over.
    throw new ChaosControlError(
      `${req.control} was armed and had already run out by the time it was read back`,
    );
  }
  return armed;
}

/** Turn one control off. A DELETE, because absence is off. */
export async function disarmControl(
  control: ChaosControl,
  actor: string,
  conn: Sql = sql,
): Promise<boolean> {
  const rows = await conn<{ control: string }[]>`
    DELETE FROM chaos_control WHERE control = ${control} RETURNING control`;
  if (rows.length === 0) return false;
  await recordChaosEvent(
    { kind: 'disarmed', control, actor, detail: `disarmed ${control}`, params: {} },
    conn,
  );
  return true;
}

/**
 * The big red button: every control off, in one statement.
 *
 * Present on every state of the screen — including the state where nothing is
 * armed — because the moment somebody needs it is the moment they are not sure
 * what is armed, and a button that appears only when it is needed is a button
 * nobody can find.
 */
export async function disarmAll(actor: string, conn: Sql = sql): Promise<number> {
  const rows = await conn<{ control: string }[]>`DELETE FROM chaos_control RETURNING control`;
  await recordChaosEvent(
    {
      kind: 'disarmed_all',
      actor,
      detail:
        rows.length === 0
          ? 'all chaos off pressed; nothing was armed'
          : `all chaos off: ${rows.map((r) => r.control).join(', ')}`,
      params: {},
    },
    conn,
  );
  return rows.length;
}

/**
 * Delete rows that have already run out.
 *
 * NOT a safety mechanism — `v_chaos_active` already excludes them and nothing
 * reads `chaos_control` directly. This is housekeeping so the screen's "ran out
 * without being turned off" list stays short, and it is safe to never run.
 */
export async function sweepExpired(conn: Sql = sql): Promise<number> {
  const rows = await conn<{ control: string }[]>`
    DELETE FROM chaos_control WHERE expires_at <= now() RETURNING control`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

export interface ChaosEventInput {
  readonly kind:
    | 'armed'
    | 'disarmed'
    | 'disarmed_all'
    | 'expired'
    | 'run_started'
    | 'run_finished'
    | 'released'
    | 'card_registered';
  readonly control?: ChaosControl | undefined;
  readonly runId?: string | undefined;
  readonly actor: string;
  readonly detail: string;
  readonly params?: Record<string, unknown> | undefined;
}

/**
 * Append one line to the chaos audit trail.
 *
 * This is what answers the only question that matters after a demo — WAS IT
 * ON, AND WHO TURNED IT ON — and it is why `chaos_event` holds a `detail`
 * sentence rather than a code a reader has to look up.
 */
export async function recordChaosEvent(input: ChaosEventInput, conn: Sql = sql): Promise<void> {
  await conn`
    INSERT INTO chaos_event (kind, control, run_id, actor, detail, params)
    VALUES (
      ${input.kind},
      ${input.control ?? null},
      ${input.runId ?? null},
      ${input.actor},
      ${input.detail},
      ${conn.json((input.params ?? {}) as Parameters<typeof conn.json>[0])}
    )`;
}

export interface ChaosTimelineEntry {
  readonly at: string;
  readonly kind: string;
  readonly control: string | null;
  readonly actor: string;
  readonly detail: string;
}

export async function readChaosTimeline(limit = 25, conn: Sql = sql): Promise<ChaosTimelineEntry[]> {
  const rows = await conn<
    { at: Date; kind: string; control: string | null; actor: string; detail: string }[]
  >`
    SELECT at, kind, control, actor, detail
      FROM chaos_event
     ORDER BY at DESC, id DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    at: r.at.toISOString(),
    kind: r.kind,
    control: r.control,
    actor: r.actor,
    detail: r.detail,
  }));
}
