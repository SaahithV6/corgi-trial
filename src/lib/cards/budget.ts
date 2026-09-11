/**
 * The latency budget, as numbers a test can assert on rather than as prose.
 *
 * ─── What the provider actually does ────────────────────────────────────────
 *
 * Lithic's ASA webhook is synchronous: Lithic holds the authorisation open and
 * waits for our decision.
 *
 *   * HARD TIMEOUT 6000 ms. Documented by Lithic, and visible in their own
 *     OpenAPI document as the `CUSTOMER_ASA_TIMEOUT` member of the transaction
 *     `detailed_results` enum — i.e. the provider records our timeout as a
 *     property of the transaction, which is how it can be measured from the
 *     outside instead of taken on trust.
 *   * ON TIMEOUT LITHIC DECLINES. It does not approve. This is the single most
 *     important fact about the feature and it is why the numbers below are
 *     what they are: being slow is not "degraded", it is a declined card.
 *   * PROVIDER RECOMMENDATION 3000 ms, because acquirer-side timeouts
 *     downstream of Lithic can void a transaction that Lithic itself was still
 *     willing to wait for.
 *   * A 5xx or a network failure is RETRIED immediately; a 4xx is not.
 *
 * ─── Our budget ─────────────────────────────────────────────────────────────
 *
 * The target is the provider's recommendation, not its timeout. Designing to
 * 6000 ms would mean a system that is correct and useless.
 *
 *   verify signature          ~0.1 ms   HMAC-SHA256 over ~4 KB, in-process
 *   ASA secret (cold only)    <= 400 ms one fetch per instance, then cached
 *   controls + spend          <= 600 ms ONE round trip, one query
 *   decide()                    <1 ms   pure, no I/O
 *   ── response goes out here ──
 *   append the decision       <= 400 ms after the verdict is known
 *
 * Worst case before the response is written: 0.1 + 400 + 600 ≈ 1000 ms, plus a
 * cold start. Steady state on a warm instance is one database round trip.
 *
 * ─── Why the decision log is appended BEFORE the response ───────────────────
 *
 * It is the arrangement that costs latency, and it is chosen on purpose.
 * `after()` — which this codebase uses for the asynchronous webhook drain — is
 * explicitly a nudge there, because "a mechanism that usually runs is the
 * worst kind". A decision record is not a nudge: a decline a customer disputes
 * in March has to be explainable in September, and best-effort audit is not
 * audit. The write costs one round trip to a database we have already proven
 * reachable one line earlier, so the marginal risk is small and the marginal
 * evidence is total.
 *
 * `after()` is still wired, as the fallback for the case where the append
 * misses ITS deadline: the response has to go out, so the row is finished off
 * the critical path rather than dropped.
 */

/** Lithic's hard timeout. Ours to respect, not to configure. */
export const PROVIDER_TIMEOUT_MS = 6_000;

/** Lithic's recommended ceiling, and therefore our SLO. */
export const PROVIDER_RECOMMENDED_MS = 3_000;

/**
 * How long the one control read may take before we give up on it.
 *
 * 600 ms against a 6000 ms provider timeout. Deliberately far below what we
 * could afford, because the branch this deadline arms is fail-CLOSED (see the
 * header of `./decide.ts`) and a fail-closed branch that fires on ordinary
 * load would be a self-inflicted outage. At 600 ms a missed deadline means the
 * database is gone, not that it is busy: Neon in the same region as the
 * function answers this query in single-digit milliseconds.
 */
export const CONTROL_READ_BUDGET_MS = 600;

/** One fetch of the ASA HMAC secret, on a cold instance only. */
export const SECRET_FETCH_BUDGET_MS = 400;

/** The decision append, after the verdict is known. */
export const DECISION_APPEND_BUDGET_MS = 400;

/**
 * The whole handler's self-imposed ceiling. Nothing enforces it as a single
 * timer — the individual deadlines add up to less — but it is the number the
 * route logs against, so a breach is visible in the log line rather than only
 * in the provider's transaction record.
 */
export const HANDLER_BUDGET_MS =
  SECRET_FETCH_BUDGET_MS + CONTROL_READ_BUDGET_MS + DECISION_APPEND_BUDGET_MS;

export class DeadlineExceededError extends Error {
  override readonly name = "DeadlineExceededError";
  readonly budgetMs: number;

  constructor(label: string, budgetMs: number) {
    super(`${label} exceeded its ${budgetMs} ms budget`);
    this.budgetMs = budgetMs;
  }
}

/**
 * Race a promise against a deadline.
 *
 * The loser is NOT cancelled, and that is the honest thing to say about it:
 * `postgres` will finish its query and release its connection in its own time.
 * What the deadline buys is that OUR ANSWER is not waiting for it. On this
 * path that is the whole requirement — a query still running after we have
 * declined costs a connection, and a decision still pending after 6000 ms
 * costs the cardholder their purchase.
 *
 * The timer is cleared in `finally` so a fast path does not hold the event
 * loop open for the remainder of the budget. In a serverless function that is
 * not cosmetic: an un-cleared timer can keep an instance from being frozen
 * between invocations.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(label, budgetMs)), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A monotonic stopwatch in MICROSECONDS.
 *
 * Milliseconds would round a 700 µs decision to 1 and a 400 µs one to 0, and
 * the entire point of recording the number is to be able to say where the
 * budget went. `performance.now()` is a double of milliseconds with sub-µs
 * resolution and, unlike `Date.now()`, is monotonic — a decision that spans an
 * NTP step must not record a negative latency.
 */
export function stopwatch(): () => number {
  const started = performance.now();
  return () => Math.max(0, Math.round((performance.now() - started) * 1000));
}
