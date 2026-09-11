/**
 * The bounds, with no database and no clock of their own.
 *
 * Separated from `switch.ts` for the reason `src/lib/holds/index.ts` states
 * about `model.ts`: "no database and no clock of their own, which is why the
 * interesting properties are provable without one". The bounds ARE the safety
 * story of this feature, and a bound that can only be exercised through a
 * Postgres connection is a bound that will not be exercised by the gate.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS FILE IS THE SECOND LINE OF DEFENCE, NOT THE FIRST
 *
 * The first is `chaos_control_bounded` in `db/migrations/0029_chaos.sql`:
 *
 *     CHECK (expires_at > armed_at
 *            AND expires_at <= armed_at + interval '10 minutes')
 *
 * That is the one that holds. It cannot be routed around by a bug here, by a
 * future worker's helper, or by somebody with a `psql` prompt. What this file
 * adds is a READABLE refusal before Postgres gives an unreadable one, and a
 * place to put the per-control parameter ranges, which are a product decision
 * rather than a safety one.
 *
 * If these two ever disagree, the database wins and `armControl` translates
 * its complaint into English. That path is deliberate and is exercised.
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  CHAOS_MAX_COPIES,
  CHAOS_MAX_REORDER_SECONDS,
  CHAOS_MAX_SECONDS,
  CHAOS_MAX_SETTLEMENT_DELAY_SECONDS,
  CHAOS_MIN_COPIES,
  CHAOS_PROVIDER,
  type ChaosControl,
} from './types';

export class ChaosControlError extends Error {
  override readonly name = 'ChaosControlError';
}

export interface ArmRequest {
  readonly control: ChaosControl;
  readonly seconds: number;
  readonly actor: string;
  readonly actorId?: string | undefined;
  /** Control-specific: `seconds` for the timing controls, `copies` for the duplicate. */
  readonly value?: number | undefined;
}

/** Defaults the screen offers when nobody types a number. */
export const CHAOS_DEFAULT_SETTLEMENT_DELAY_SECONDS = 45;
export const CHAOS_DEFAULT_COPIES = 3;
export const CHAOS_DEFAULT_REORDER_SECONDS = 20;

/**
 * Validate one arm request and produce the `params` jsonb.
 *
 * Throws rather than returning a Result because every caller is a server
 * action that turns a throw into a refusal message, and a bound that can be
 * ignored by forgetting to check a return value is not a bound.
 */
export function validateArm(req: ArmRequest): { params: Record<string, number | string> } {
  if (!Number.isFinite(req.seconds) || req.seconds <= 0) {
    throw new ChaosControlError('a chaos control must be armed for a positive number of seconds');
  }
  if (req.seconds > CHAOS_MAX_SECONDS) {
    throw new ChaosControlError(
      `a chaos control may be armed for at most ${String(CHAOS_MAX_SECONDS)}s (${String(
        CHAOS_MAX_SECONDS / 60,
      )} minutes). This is also a CHECK constraint in migration 0029: the database refuses a ` +
        'longer arming whatever this code says.',
    );
  }

  switch (req.control) {
    case 'webhooks_off':
      return { params: { provider: CHAOS_PROVIDER } };

    case 'settlement_delay': {
      const seconds = req.value ?? CHAOS_DEFAULT_SETTLEMENT_DELAY_SECONDS;
      if (
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > CHAOS_MAX_SETTLEMENT_DELAY_SECONDS
      ) {
        throw new ChaosControlError(
          `settlement delay must be 1..${String(CHAOS_MAX_SETTLEMENT_DELAY_SECONDS)} seconds`,
        );
      }
      return { params: { seconds } };
    }

    case 'duplicate_delivery': {
      const copies = req.value ?? CHAOS_DEFAULT_COPIES;
      if (!Number.isInteger(copies) || copies < CHAOS_MIN_COPIES || copies > CHAOS_MAX_COPIES) {
        throw new ChaosControlError(
          `duplicate delivery must send ${String(CHAOS_MIN_COPIES)}..${String(
            CHAOS_MAX_COPIES,
          )} copies. One copy is not chaos.`,
        );
      }
      return { params: { copies } };
    }

    case 'reorder_window': {
      const seconds = req.value ?? CHAOS_DEFAULT_REORDER_SECONDS;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > CHAOS_MAX_REORDER_SECONDS) {
        throw new ChaosControlError(
          `the reorder window must be 1..${String(CHAOS_MAX_REORDER_SECONDS)} seconds`,
        );
      }
      return { params: { seconds } };
    }
  }
}
