/**
 * The chaos screen's data contract.
 *
 * Nothing under `src/components/chaos/**` opens a connection, imports
 * `postgres`, or reaches into `src/lib/chaos/*` for anything but these types.
 * The live implementation is `src/app/(app)/chaos/live-source.ts`; the fixture
 * implementation is `./fixtures.ts`; the view renders whichever it is handed
 * and cannot tell them apart.
 *
 * MONEY CROSSES AS A DECIMAL STRING OF CENTS, never as a number. `bigint` is
 * not JSON-safe and `number` is not money, so the contract carries `"7340"`
 * and the view hands it to `<Money cents={BigInt(...)} />`. The formatting
 * decision stays in `src/lib/format/money.ts` where it belongs, and no figure
 * on this screen is ever a float.
 */

import type { Result, ErrorShape } from '@/lib/result';

/**
 * Where the numbers came from. Rendered on the screen, always.
 *
 * This codebase's posture is that a figure without provenance is a rumour, and
 * on THIS screen it matters more than anywhere else: the whole claim is "the
 * invariants held while that ran", and a fixture cannot make it.
 */
export type ChaosSource = 'live' | 'fixture';

export type ChaosControlName =
  | 'webhooks_off'
  | 'settlement_delay'
  | 'duplicate_delivery'
  | 'reorder_window';

export interface ChaosControlView {
  readonly control: ChaosControlName;
  readonly label: string;
  /** What this control does to DELIVERY. Never what it does to a provider. */
  readonly effect: string;
  readonly armed: boolean;
  /** The armed parameter in words: "3 copies", "45 seconds". */
  readonly setting: string;
  readonly expiresAt: string | null;
  readonly secondsRemaining: number;
  readonly armedBy: string | null;
}

export interface ChaosDeliveryView {
  readonly seq: number;
  readonly step: 'authorization' | 'clearing';
  readonly copyIndex: number;
  readonly webhookId: string;
  readonly plannedAt: string;
  readonly releasedAt: string | null;
  readonly outcome: 'withheld' | 'accepted' | 'replay' | 'dead_on_arrival' | 'rejected' | 'failed';
  readonly detail: string | null;
}

export interface ChaosInboxRowView {
  readonly providerEventId: string;
  readonly eventType: string | null;
  readonly state: string;
  readonly receivedAt: string;
  readonly parkAttempts: number;
  readonly parkedOnKind: string | null;
  readonly parkedOnRef: string | null;
  readonly parkedReason: string | null;
  readonly shapedBy: string | null;
}

export interface ChaosOutboxTotals {
  readonly deliveries: number;
  readonly withheld: number;
  readonly accepted: number;
  /** Absorbed by webhook_inbox UNIQUE (provider, provider_event_id). */
  readonly suppressedReplays: number;
  readonly refused: number;
  readonly duplicateCopies: number;
}

export interface ChaosRunView {
  readonly id: string;
  readonly startedAt: string;
  readonly startedBy: string;
  readonly summary: string;
  readonly cardToken: string;
  readonly cardRegistered: boolean;
  readonly businessId: string | null;
  readonly authCents: string;
  readonly clearingCents: string;
  readonly controls: readonly ChaosControlName[];
  readonly deliveries: readonly ChaosDeliveryView[];
  readonly inbox: readonly ChaosInboxRowView[];
  readonly totals: ChaosOutboxTotals;
}

export interface InvariantView {
  readonly view: string;
  readonly claim: string;
  /** Rows returned. Zero is the assertion. -1 means it could not be read. */
  readonly rows: number;
  readonly error: string | null;
}

export interface PositionView {
  readonly businessId: string;
  readonly businessName: string | null;
  readonly ledgerCents: string;
  readonly availableCents: string;
  readonly holdsCents: string;
}

export interface ChaosStateView {
  readonly on: boolean;
  readonly controls: readonly ChaosControlView[];
  readonly allClearAt: string | null;
  readonly secondsUntilAllClear: number;
  /** Controls that ran out without anyone pressing off. History, not chaos. */
  readonly expired: readonly { readonly control: string; readonly expiresAt: string }[];
}

export interface TimelineEntryView {
  readonly at: string;
  readonly kind: string;
  readonly control: string | null;
  readonly actor: string;
  readonly detail: string;
}

export interface ChaosView {
  readonly source: ChaosSource;
  readonly asOf: string;
  readonly chaos: ChaosStateView;
  readonly invariants: readonly InvariantView[];
  readonly invariantsHold: boolean;
  readonly invariantsUnreadable: number;
  readonly inbox: {
    readonly pending: number;
    readonly parked: number;
    readonly dead: number;
    readonly done: number;
  };
  readonly parked: readonly {
    readonly kind: string;
    readonly ref: string | null;
    readonly count: number;
    readonly reason: string | null;
  }[];
  readonly trialBalanceCents: string;
  readonly position: PositionView | null;
  readonly latestRun: ChaosRunView | null;
  readonly timeline: readonly TimelineEntryView[];
}

export interface ChaosDataSource {
  load(): Promise<Result<ChaosView, ErrorShape>>;
}
