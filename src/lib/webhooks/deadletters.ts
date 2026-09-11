/**
 * Two ways a delivery ends up in `state = 'dead'`, and they are not the same
 * event.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT THAT FORCED THIS FILE
 * ---------------------------------------------------------------------------
 * Measured against the production database at 2026-09-11T16:05Z:
 *
 *   90 dead letters — 37 Increase, 53 Lithic. EVERY ONE of them has
 *   `park_attempts = 12` (the whole park ladder) and `attempts -
 *   park_attempts` in 1..4 (nowhere near the 8-failure budget). Not one of
 *   them is a delivery that was retried to exhaustion and abandoned. Every one
 *   is a consumer that looked at money it could not attribute, refused to
 *   guess, said so in a full sentence, waited five hours for a referent that
 *   was never going to arrive, and was then timed out by the park ladder.
 *
 * `/api/health` read `dropping` on Increase and degraded the deployment for
 * it. `dropping` is documented as "accepted, verified, retried to exhaustion,
 * and abandoned … somebody told us something about money and we threw it
 * away". That is not what happened. Nothing was thrown away: 90 rows are
 * sitting in `v_webhook_dead_letter` with the reason on them, which is where a
 * person is supposed to find them.
 *
 * The tell is that the SAME FACT produced two different verdicts. Lithic's 53
 * park-exhaustions, newest 111s old, read `backlogged` and did not degrade.
 * Increase's 37, newest 117s old, read `dropping` and did. The only
 * discriminator is `dead_lettered_at > max(processed_at)` — whether other,
 * unrelated deliveries happened to be consumed in between. Lithic is busy;
 * the Increase feed went quiet at 14:52. A verdict about one provider's health
 * that flips on that provider's traffic VOLUME is computed from an input that
 * cannot express the thing it claims to measure, which is the failure this
 * build has now found twenty-seven times.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ARITHMETIC ON COLUMNS AND NOT A STRING MATCH
 * ---------------------------------------------------------------------------
 * The obvious implementation is `processing_error LIKE '%referent never
 * arrived%'`. That is the exclusion this repo has been burned by: a guard that
 * reports healthy because what it excluded was SHAPED LIKE the failure. A
 * consumer is free to write any sentence it likes into a park reason, so a
 * string test would let a consumer silence the alarm by phrasing.
 *
 * The dispatcher's own two terminal branches are separable without reading a
 * single character of prose, because each one is reached by exhausting a
 * DIFFERENT counter, and the counters are on the row:
 *
 *   fault     `applyFailure()` dead-letters only when
 *             `attempts - park_attempts >= policy.maxFailedAttempts`. A
 *             consumer threw, or no consumer was registered, every time, up to
 *             the budget. THIS is what `dropping` describes.
 *
 *   refusal   the `parked` branch dead-letters only when
 *             `park_attempts + 1 > policy.maxParkAttempts`, which leaves
 *             `park_attempts` pinned at exactly `maxParkAttempts` and
 *             `parked_on_ref` set. The consumer answered, coherently, every
 *             time; what it answered was "I will not act on this".
 *
 * All three clauses of `isRefusalDeath` are load-bearing, and the third is the
 * one that is easy to leave out:
 *
 *   park_attempts >= maxParkAttempts   the ladder actually ran out, rather
 *                                      than the row having parked once
 *                                      on its way to somewhere else.
 *   parked_on_ref is not null          a consumer named the thing it was
 *                                      waiting for. `park()` is the only
 *                                      writer of this column.
 *   attempts - park_attempts
 *     < maxFailedAttempts              AND IT NEVER BLEW THE FAILURE BUDGET.
 *                                      Without this, a row that parked its
 *                                      full twelve, got unparked (which
 *                                      deliberately does NOT clear
 *                                      `parked_on_ref`), and then threw eight
 *                                      times would be classified a refusal and
 *                                      disappear from the alarm. That is a
 *                                      real drop wearing a refusal's clothes,
 *                                      and it is the exact hole the narrowing
 *                                      in this file has to not have.
 *
 * A row that satisfies none of these — no consumer registered, a consumer that
 * threw, a body that would not parse — is a `fault`, and `fault` is the
 * default. Anything this file cannot positively prove is a refusal stays in
 * the alarm.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * A refusal is not a success and this file never says it is. The 37 Increase
 * rows include a $10,000.00 inbound ACH credit that nobody has booked and
 * nobody can attribute. It is unbooked money and it needs a person. The claim
 * here is narrower and it is the only one the evidence supports: it was not
 * LOST. It was accepted, verified, classified, declined in writing, and filed
 * where staff look. "We refused to act on this and said why" and "we are
 * losing deliveries" are different outages with different owners, and giving
 * them the same word is how the word stops meaning anything.
 */

import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './dispatch';

/**
 * Why a row is in `state = 'dead'`.
 *
 * Deliberately NOT a member of any `/api/health` vocabulary: this is a fact
 * about one row, and the endpoint's verdicts are facts about a provider.
 */
export type DeadLetterCause = 'fault' | 'refusal';

/** The three columns the classification reads, and no others. */
export interface DeadLetterCounters {
  /** Every pickup, parks included. `webhook_inbox.attempts`. */
  readonly attempts: number;
  /** Pickups that ended in a park. `webhook_inbox.park_attempts`. */
  readonly parkAttempts: number;
  /** The referent a consumer named, or null. `webhook_inbox.parked_on_ref`. */
  readonly parkedOnRef: string | null;
}

/**
 * True only when the row demonstrably died of an exhausted park ladder.
 *
 * Fails closed: every uncertainty is a `fault`, which keeps it in the alarm.
 */
export function isRefusalDeath(
  row: DeadLetterCounters,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (row.parkedOnRef === null) return false;
  if (row.parkAttempts < policy.maxParkAttempts) return false;
  // The failure budget was never spent. See the header: this is the clause
  // that stops a genuine retry-to-exhaustion hiding behind an old park.
  return row.attempts - row.parkAttempts < policy.maxFailedAttempts;
}

/** The same question, answered with the word rather than a boolean. */
export function deadLetterCause(
  row: DeadLetterCounters,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): DeadLetterCause {
  return isRefusalDeath(row, policy) ? 'refusal' : 'fault';
}

/**
 * The same predicate as SQL, so a query and a process cannot drift apart.
 *
 * Returned as a string rather than a tagged template because the two callers
 * want it in different drivers (`postgres` tagged templates in the health
 * endpoint, a plain fragment in `scripts/redrive.mjs`). The only values
 * interpolated are the two integers off `policy`, which are module constants
 * in this repo and are coerced with `Math.trunc` regardless, so this cannot
 * become an injection site even if a caller passes a policy from elsewhere.
 *
 * @param alias the table alias the columns are on, e.g. `w` for `… from
 *              webhook_inbox w`. Pass `''` for unqualified columns.
 */
export function refusalDeathSql(alias = 'w', policy: RetryPolicy = DEFAULT_RETRY_POLICY): string {
  const q = alias === '' ? '' : `${alias}.`;
  const parks = Math.trunc(policy.maxParkAttempts);
  const failures = Math.trunc(policy.maxFailedAttempts);
  return (
    `(${q}parked_on_ref is not null` +
    ` and ${q}park_attempts >= ${parks}` +
    ` and ${q}attempts - ${q}park_attempts < ${failures})`
  );
}

/** Its negation, named so a caller does not have to write `not (...)`. */
export function faultDeathSql(alias = 'w', policy: RetryPolicy = DEFAULT_RETRY_POLICY): string {
  return `(not ${refusalDeathSql(alias, policy)})`;
}
