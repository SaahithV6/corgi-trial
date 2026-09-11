/**
 * Chaos mode.
 *
 *   types.ts    the vocabulary, the bounds, the marker. No I/O.
 *   sign.ts     the signer, and the refusal that keeps it honest. No I/O.
 *   body.ts     Lithic's measured wire shape. Pure.
 *   plan.ts     four controls -> one release schedule. Pure.
 *   switch.ts   arm, disarm, and the one answer to "is chaos on".
 *   driver.ts   the outbox, and the door into the real delivery pipeline.
 *   observe.ts  the invariants, the inbox and the position, at one instant.
 *   baseline.ts the known population, and the change against it. Pure.
 *
 * The first four have no database and no clock of their own, which is why the
 * interesting properties — that duplicates share an id, that reordering really
 * reverses, that the marker cannot be stripped from a delivery that still
 * verifies — are provable without one.
 *
 * NOTHING OUTSIDE THIS DIRECTORY WAS CHANGED TO MAKE CHAOS WORK. There is no
 * chaos branch in `src/lib/webhooks/**`, `src/lib/holds/**` or
 * `src/lib/ledger/**`, and no column was added to `webhook_inbox`. If that
 * stops being true, chaos has become a feature the system accommodates rather
 * than a stress the system survives, and the finding is worth more than the
 * feature. See `docs/CHAOS.md` §6.
 */

export {
  CHAOS_AUTH_CENTS,
  CHAOS_CLEARING_CENTS,
  CHAOS_CONTROLS,
  CHAOS_DEFAULT_SECONDS,
  CHAOS_EVENT_ID_PREFIX,
  CHAOS_MARKER,
  CHAOS_MAX_COPIES,
  CHAOS_MAX_REORDER_SECONDS,
  CHAOS_MAX_SECONDS,
  CHAOS_MAX_SETTLEMENT_DELAY_SECONDS,
  CHAOS_MIN_COPIES,
  CHAOS_PROVIDER,
  isChaosControl,
  type ActiveControl,
  type ChaosControl,
  type ChaosDeliveryOutcome,
  type ChaosDeliveryRow,
  type ChaosMarker,
  type ChaosParams,
  type ChaosRunRow,
  type ChaosState,
  type ChaosStep,
  type ExpiredControl,
} from './types';

export {
  assertNotAProviderSecret,
  chaosSecret,
  chaosWebhookId,
  ChaosSecretMisuseError,
  CHAOS_WEBHOOK_SECRET_DEFAULT,
  CHAOS_WEBHOOK_SECRET_ENV,
  signChaosDelivery,
  type SignedChaosDelivery,
} from './sign';

export { chaosBody, newEpisodeIdentifiers, type ChaosBodyOptions } from './body';

export { describePlan, isDue, planDeliveries, type PlannedDelivery } from './plan';

export {
  armControl,
  ChaosControlError,
  disarmAll,
  disarmControl,
  readChaosState,
  readChaosTimeline,
  recordChaosEvent,
  sweepExpired,
  validateArm,
  webhooksOff,
  type ArmRequest,
  type ChaosTimelineEntry,
} from './switch';

export {
  readOutbox,
  registerEpisodeCard,
  releaseDueDeliveries,
  startChaosRun,
  type RegisterCardResult,
  type ReleaseResult,
  type StartRunOptions,
  type StartRunResult,
} from './driver';

export {
  captureBaseline,
  describeBaseline,
  describeGrowth,
  growth,
  ratchet,
  unreadable,
  type CapturedBaseline,
  type InvariantBaseline,
  type InvariantGrowth,
  type InvariantRowCount,
} from './baseline';

export {
  INVARIANT_VIEWS,
  observe,
  readChaosInbox,
  readInboxCounters,
  readInvariants,
  readParkedByKind,
  readPosition,
  type ChaosInboxRow,
  type ChaosObservation,
  type InboxCounters,
  type InvariantReading,
  type ParkedByKind,
  type Position,
} from './observe';
