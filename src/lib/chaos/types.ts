/**
 * Chaos mode — the vocabulary.
 *
 * Four controls, each one a condition the brief's gauntlet names, and each one
 * a perturbation of DELIVERY and nothing else:
 *
 *   webhooks_off        availability  — "pull one of your providers out from
 *                                       under you"
 *   settlement_delay    timing        — "it can arrive days later"
 *   duplicate_delivery  multiplicity  — "we will replay events, twice is one"
 *   reorder_window      order         — "the settlement webhook can arrive
 *                                       before the auth it belongs to"
 *
 * NOTHING IN CHAOS MODE TOUCHES THE LEDGER. It decides when a delivery leaves
 * an outbox, how many copies leave, and in what order. What a delivery MEANS is
 * the consumer's business, and the consumer has never heard of this module.
 *
 * ---------------------------------------------------------------------------
 * THE BOUND, AND WHERE IT LIVES
 * ---------------------------------------------------------------------------
 *
 * `CHAOS_MAX_SECONDS` is 600 here and it is ALSO a CHECK constraint in
 * `db/migrations/0029_chaos.sql`. That duplication is deliberate: a bound that
 * lives only in the application is one refactor away from not existing, and the
 * property this build needs — that a forgotten switch cannot outlive the demo —
 * is worth asserting twice in two languages. Postgres is the one that decides.
 */

export const CHAOS_CONTROLS = [
  'webhooks_off',
  'settlement_delay',
  'duplicate_delivery',
  'reorder_window',
] as const;

export type ChaosControl = (typeof CHAOS_CONTROLS)[number];

export function isChaosControl(value: string): value is ChaosControl {
  return (CHAOS_CONTROLS as readonly string[]).includes(value);
}

/**
 * The hard ceiling on how long any control may stay armed, in seconds.
 *
 * Also `chaos_control_bounded` in migration 0029. Change one and the other
 * refuses the row, which is the correct failure: they are two spellings of one
 * decision and they must not be allowed to disagree quietly.
 */
export const CHAOS_MAX_SECONDS = 600;

/** What the arm form offers when nobody types a number. */
export const CHAOS_DEFAULT_SECONDS = 300;

/** Duplicate copies per delivery, inclusive bounds. 1 would not be chaos. */
export const CHAOS_MIN_COPIES = 2;
export const CHAOS_MAX_COPIES = 5;

/** How late a delayed settlement may be, in seconds. */
export const CHAOS_MAX_SETTLEMENT_DELAY_SECONDS = 300;

/** How wide a reorder buffer may be, in seconds. */
export const CHAOS_MAX_REORDER_SECONDS = 120;

/**
 * The provider whose deliveries chaos originates.
 *
 * One, on purpose. The card lifecycle is the heart of Track 3 and it is the
 * only rail where this deployment can mint a lifecycle that is worth watching.
 * A second entry here would be a promise chaos cannot keep.
 */
export const CHAOS_PROVIDER = 'lithic' as const;

/** The amounts the scripted episode uses — the brief's own fuel-pump pair. */
export const CHAOS_AUTH_CENTS = 50_00n;
export const CHAOS_CLEARING_CENTS = 73_40n;

// ---------------------------------------------------------------------------
// Control parameters
// ---------------------------------------------------------------------------

export type ChaosParams =
  | { readonly control: 'webhooks_off'; readonly provider: typeof CHAOS_PROVIDER }
  | { readonly control: 'settlement_delay'; readonly seconds: number }
  | { readonly control: 'duplicate_delivery'; readonly copies: number }
  | { readonly control: 'reorder_window'; readonly seconds: number };

/** An armed, unexpired control as `v_chaos_active` reports it. */
export interface ActiveControl {
  readonly control: ChaosControl;
  readonly armedAt: string;
  readonly expiresAt: string;
  readonly armedBy: string;
  readonly secondsRemaining: number;
  readonly params: ChaosParams;
}

/** A control that ran out and has not been swept. History, not chaos. */
export interface ExpiredControl {
  readonly control: ChaosControl;
  readonly armedAt: string;
  readonly expiresAt: string;
  readonly armedBy: string;
  readonly secondsSinceExpiry: number;
}

/**
 * The whole answer to "is chaos on".
 *
 * ONE function produces this and every screen, banner and action reads it. The
 * failure mode this shape exists to prevent is a page that renders "chaos off"
 * from one query while an action reads "chaos on" from another.
 */
export interface ChaosState {
  readonly on: boolean;
  readonly active: readonly ActiveControl[];
  readonly expired: readonly ExpiredControl[];
  /** ISO instant at which the LAST armed control runs out. Null when off. */
  readonly allClearAt: string | null;
  /** Seconds until `allClearAt`. Zero when off. */
  readonly secondsUntilAllClear: number;
  readonly readAt: string;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export type ChaosStep = 'authorization' | 'clearing';

export type ChaosDeliveryOutcome =
  | 'withheld'
  | 'accepted'
  | 'replay'
  | 'dead_on_arrival'
  | 'rejected'
  | 'failed';

export interface ChaosDeliveryRow {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly step: ChaosStep;
  readonly copyIndex: number;
  readonly webhookId: string;
  readonly plannedAt: string;
  readonly releasedAt: string | null;
  readonly outcome: ChaosDeliveryOutcome;
  readonly inboxId: string | null;
  readonly detail: string | null;
}

export interface ChaosRunRow {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly startedBy: string;
  readonly cardToken: string;
  readonly businessId: string | null;
  readonly cardRegistered: boolean;
  readonly transactionToken: string;
  readonly authCents: bigint;
  readonly clearingCents: bigint;
  readonly controls: readonly ChaosControl[];
  readonly note: string | null;
}

/**
 * The in-band marker every chaos body carries, INSIDE the signed bytes.
 *
 * Copied wholesale from `src/lib/rails/achsim/signing.ts`'s `simulated: true`,
 * and for the same reason: strip it to make a delivery look like the
 * provider's and the HMAC no longer verifies; keep the signature and the marker
 * is still there. There is no third option.
 */
export const CHAOS_MARKER = 'corgi_chaos' as const;

export interface ChaosMarker {
  readonly origin: 'corgi-chaos-mode';
  readonly run_id: string;
  readonly control: string;
  readonly note: string;
}

/** Every chaos `webhook-id` starts with this. See migration 0029 §"key space". */
export const CHAOS_EVENT_ID_PREFIX = 'chaos_';
