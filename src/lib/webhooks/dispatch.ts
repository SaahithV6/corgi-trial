/**
 * The dispatcher: one loop over the inbox, one consumer per provider.
 *
 * It knows four things and no more — how to claim due rows oldest-first, how to
 * hand a row to the consumer registered for its provider, how to interpret the
 * three answers a consumer can give, and when to stop retrying. It contains no
 * provider names, no event types, and no ledger vocabulary, which is what makes
 * requirement 6 true: adding a fifth provider is a `consumers.register(...)`
 * call and nothing in this file moves.
 *
 * Three properties it is built to have:
 *
 *   Out-of-order is not a case.   The dispatcher makes no ordering promise at
 *     all, so consumers cannot come to depend on one. Events are claimed oldest
 *     first only because that is the fairest queue discipline, and a failure on
 *     one row never blocks the rest of the batch.
 *
 *   Missing referents park, they do not crash or vanish.   A consumer that
 *     needs an entity we have not heard of yet returns `parked(kind, ref)`. The
 *     row goes to state 'parked' with the referent recorded, and is woken the
 *     moment some other event reports having created it — or on a timed
 *     re-check, so a park is never load-bearing on another event arriving.
 *
 *   Retry is bounded.   Exponential backoff with jitter, a cap on failed
 *     attempts and a separate cap on parks. Past either cap the row is
 *     dead-lettered and shows up on the staff screen. Nothing retries for ever.
 */

import type { Logger as AppLogger } from '../log';
import type { EntityRef, InboxEvent, InboxStore, ProviderName } from './inbox';

/**
 * The dispatcher logs through the app's structured logger, minus the parts it
 * has no business with (`child`, `requestId`): a cron invocation has no request
 * to correlate to, and the three level methods are all it needs.
 */
export type DispatchLogger = Pick<AppLogger, 'info' | 'warn' | 'error'>;

// ---------------------------------------------------------------------------
// 1. The consumer contract
// ---------------------------------------------------------------------------

export type ConsumerResult =
  /** Effects applied (or the event was a no-op for us). `produced` names the
   *  entities this event brought into existence, which is what wakes parked
   *  events waiting for them. */
  | { status: 'processed'; produced?: readonly EntityRef[] | undefined }
  /** A well-formed event this consumer deliberately does not act on. Ends the
   *  row's life exactly like 'processed'; it exists so the logs can tell the
   *  difference between "handled" and "recognised and skipped". */
  | { status: 'ignored'; reason?: string | undefined }
  /** The event refers to something we have not seen yet. Not an error, not a
   *  drop: park it against the referent and try again when it shows up. */
  | { status: 'parked'; waitingFor: EntityRef; reason?: string | undefined };

export const processed = (produced?: readonly EntityRef[] | undefined): ConsumerResult => ({
  status: 'processed',
  produced,
});
export const ignored = (reason?: string | undefined): ConsumerResult => ({ status: 'ignored', reason });
export const parked = (kind: string, ref: string, reason?: string | undefined): ConsumerResult => ({
  status: 'parked',
  waitingFor: { kind, ref },
  reason,
});

export interface ConsumerContext {
  /** Injected, never `new Date()` inline, so tests are deterministic. */
  now: Date;
  /** Which delivery attempt this is (1 on the first pickup). */
  attempt: number;
  logger: DispatchLogger;
}

export interface WebhookConsumer {
  readonly provider: ProviderName;
  /**
   * MUST be idempotent: the same event may be handed to you again after a
   * crash, a lease expiry, or a park/unpark round trip. The inbox guarantees a
   * provider event is stored once; it cannot guarantee it is *handled* once,
   * because a process can die between the effect and the row update. Make the
   * effect a function of a set (a unique key on the write), not an increment.
   */
  handle(event: InboxEvent, ctx: ConsumerContext): Promise<ConsumerResult> | ConsumerResult;
}

export class ConsumerRegistry {
  private readonly byProvider = new Map<ProviderName, WebhookConsumer>();

  register(consumer: WebhookConsumer, opts: { replace?: boolean } = {}): this {
    if (this.byProvider.has(consumer.provider) && !opts.replace) {
      throw new Error(
        `a consumer is already registered for provider '${consumer.provider}'; pass { replace: true } if that is deliberate`,
      );
    }
    this.byProvider.set(consumer.provider, consumer);
    return this;
  }

  get(provider: ProviderName): WebhookConsumer | undefined {
    return this.byProvider.get(provider);
  }

  providers(): ProviderName[] {
    return [...this.byProvider.keys()].sort();
  }
}

/** Process-wide registry. Wire it once at startup; see README §6. */
export const consumers = new ConsumerRegistry();

// ---------------------------------------------------------------------------
// 2. Retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Failed attempts (crashes and thrown errors) before dead-lettering. */
  maxFailedAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Parks before we give up waiting for a referent that never arrives. */
  maxParkAttempts: number;
  parkBaseDelayMs: number;
  parkMaxDelayMs: number;
  /** Fraction of the delay to randomise, 0..1. Stops a burst of failures from
   *  retrying in lockstep for ever. */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  // Eight matches Lithic's own delivery schedule (immediate, 5s, 5m, 30m, 2h,
  // 5h, 10h, 10h). If the provider gave up after eight, so do we.
  maxFailedAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 60 * 60_000,
  // Twelve parks at 30s doubling to a 1h cap is a little over five hours of
  // waiting for a referent. Anything slower than that is a missing event, not
  // a late one, and belongs in front of a human.
  maxParkAttempts: 12,
  parkBaseDelayMs: 30_000,
  parkMaxDelayMs: 60 * 60_000,
  jitter: 0.2,
};

/**
 * Exponential backoff with full-jitter-lite: delay = base * 2^(n-1), capped,
 * then multiplied by a factor in [1 - jitter, 1]. `random` is injected so the
 * tests can assert exact numbers.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; jitter: number },
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  // 2^30 caps the exponent so the shift cannot overflow into Infinity/NaN.
  const raw = opts.baseDelayMs * Math.pow(2, Math.min(n - 1, 30));
  const capped = Math.min(raw, opts.maxDelayMs);
  const factor = 1 - opts.jitter * random();
  return Math.max(0, Math.round(capped * factor));
}

/**
 * Failures are pickups that were not parks. `attempts` counts every time the
 * dispatcher claimed the row (including the pickups that ended in a park, and
 * including pickups where the worker died before answering); `park_attempts`
 * counts the parks. The difference is the number of times we tried and it went
 * wrong, which is the number the retry budget is about.
 */
export function failedAttempts(event: Pick<InboxEvent, 'attempts' | 'parkAttempts'>): number {
  return Math.max(0, event.attempts - event.parkAttempts);
}

// ---------------------------------------------------------------------------
// 3. The dispatcher
// ---------------------------------------------------------------------------

const NULL_LOGGER: DispatchLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface DispatchDeps {
  store: InboxStore;
  registry?: ConsumerRegistry | undefined;
  policy?: RetryPolicy | undefined;
  /** Rows per batch. Small enough that a serverless invocation finishes. */
  batchSize?: number | undefined;
  /** How long a claimed row is hidden from other workers. Must comfortably
   *  exceed the slowest consumer, or two workers will run the same event. */
  leaseMs?: number | undefined;
  now?: (() => Date) | undefined;
  random?: (() => number) | undefined;
  logger?: DispatchLogger | undefined;
}

export interface DispatchSummary {
  claimed: number;
  processed: number;
  ignored: number;
  parked: number;
  retried: number;
  deadLettered: number;
  unparked: number;
}

const EMPTY_SUMMARY: DispatchSummary = {
  claimed: 0,
  processed: 0,
  ignored: 0,
  parked: 0,
  retried: 0,
  deadLettered: 0,
  unparked: 0,
};

/**
 * Claim one batch and process it. Call from a cron route, a queue worker, or
 * `waitUntil()` after an ack — the inbox does not care which, because the row
 * is already durable before this ever runs.
 */
export async function dispatchOnce(deps: DispatchDeps): Promise<DispatchSummary> {
  const store = deps.store;
  const registry = deps.registry ?? consumers;
  const policy = deps.policy ?? DEFAULT_RETRY_POLICY;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const logger = deps.logger ?? NULL_LOGGER;
  const batchSize = deps.batchSize ?? 25;
  const leaseMs = deps.leaseMs ?? 60_000;

  const batch = await store.claimBatch({ limit: batchSize, now: now(), leaseMs });
  const summary: DispatchSummary = { ...EMPTY_SUMMARY, claimed: batch.length };

  // Sequential on purpose. These are money events; a bounded, boring, one-at-a
  // -time loop is easier to reason about than a concurrency limiter, and the
  // batch size is the throughput knob. One row failing does not stop the rest —
  // every outcome below is caught and recorded, never thrown out of the loop.
  for (const event of batch) {
    const at = now();
    const consumer = registry.get(event.provider);

    if (!consumer) {
      // Not a crash and not a drop. A provider whose consumer has not been
      // deployed yet retries on the normal schedule and dead-letters if it
      // never appears, which is exactly the behaviour we want during a rollout.
      await applyFailure(
        store,
        event,
        `no consumer registered for provider '${event.provider}'`,
        policy,
        at,
        random,
        summary,
        logger,
      );
      continue;
    }

    let result: ConsumerResult;
    try {
      result = await consumer.handle(event, {
        now: at,
        attempt: event.attempts,
        logger,
      });
    } catch (err) {
      await applyFailure(store, event, errorText(err), policy, at, random, summary, logger);
      continue;
    }

    switch (result.status) {
      case 'processed':
      case 'ignored': {
        await store.markProcessed(event.id, at);
        if (result.status === 'processed') summary.processed += 1;
        else summary.ignored += 1;

        // The referent has arrived: wake anything parked on it. This is the
        // fast path; the timed re-check on each parked row is the safety net.
        const produced = result.status === 'processed' ? (result.produced ?? []) : [];
        if (produced.length > 0) {
          summary.unparked += await store.unparkWaitingFor(produced, at);
        }
        break;
      }

      case 'parked': {
        const parksSoFar = event.parkAttempts + 1;
        if (parksSoFar > policy.maxParkAttempts) {
          await store.deadLetter(event.id, {
            error: `parked ${event.parkAttempts} times waiting for ${refText(result.waitingFor)}; referent never arrived`,
            now: at,
          });
          summary.deadLettered += 1;
          logger.error('webhook.dead_letter', {
            id: event.id,
            provider: event.provider,
            waitingFor: refText(result.waitingFor),
          });
          break;
        }
        const delay = backoffDelayMs(
          parksSoFar,
          { baseDelayMs: policy.parkBaseDelayMs, maxDelayMs: policy.parkMaxDelayMs, jitter: policy.jitter },
          random,
        );
        await store.park(event.id, {
          waitingFor: result.waitingFor,
          reason: result.reason ?? `waiting for ${refText(result.waitingFor)}`,
          now: at,
          nextAttemptAt: new Date(at.getTime() + delay),
        });
        summary.parked += 1;
        logger.info('webhook.parked', {
          id: event.id,
          provider: event.provider,
          waitingFor: refText(result.waitingFor),
          retryInMs: delay,
        });
        break;
      }
    }
  }

  return summary;
}

/** Drain the queue in batches until a batch comes back empty, or we hit the
 *  batch cap. The cap is what keeps a serverless invocation inside its budget. */
export async function dispatchUntilIdle(
  deps: DispatchDeps & { maxBatches?: number | undefined },
): Promise<DispatchSummary> {
  const maxBatches = deps.maxBatches ?? 10;
  const total: DispatchSummary = { ...EMPTY_SUMMARY };
  for (let i = 0; i < maxBatches; i++) {
    const summary = await dispatchOnce(deps);
    total.claimed += summary.claimed;
    total.processed += summary.processed;
    total.ignored += summary.ignored;
    total.parked += summary.parked;
    total.retried += summary.retried;
    total.deadLettered += summary.deadLettered;
    total.unparked += summary.unparked;
    if (summary.claimed === 0) break;
  }
  return total;
}

async function applyFailure(
  store: InboxStore,
  event: InboxEvent,
  error: string,
  policy: RetryPolicy,
  at: Date,
  random: () => number,
  summary: DispatchSummary,
  logger: DispatchLogger,
): Promise<void> {
  // `attempts` was already incremented by claimBatch, so this count includes
  // the attempt that just failed.
  const failures = failedAttempts(event);
  if (failures >= policy.maxFailedAttempts) {
    await store.deadLetter(event.id, {
      error: `dead-lettered after ${failures} failed attempts: ${error}`,
      now: at,
    });
    summary.deadLettered += 1;
    logger.error('webhook.dead_letter', {
      id: event.id,
      provider: event.provider,
      providerEventId: event.providerEventId,
      attempts: failures,
      error,
    });
    return;
  }
  const delay = backoffDelayMs(
    failures,
    { baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs, jitter: policy.jitter },
    random,
  );
  await store.recordFailure(event.id, {
    error,
    now: at,
    nextAttemptAt: new Date(at.getTime() + delay),
  });
  summary.retried += 1;
  logger.warn('webhook.retry_scheduled', {
    id: event.id,
    provider: event.provider,
    attempt: failures,
    retryInMs: delay,
    error,
  });
}

function refText(ref: EntityRef): string {
  return `${ref.kind}:${ref.ref}`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
