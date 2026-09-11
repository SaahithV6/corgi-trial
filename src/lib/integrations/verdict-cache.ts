/**
 * The memory of verdicts that were EARNED, so a throttled reading does not
 * have to invent one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — the measurement, not the theory
 * ---------------------------------------------------------------------------
 * `/api/health` reported `open_banking` as live, then simulated, then live
 * again across readings seconds apart, roughly one compliance run in three,
 * while `POST /institutions/get` answered 200 in 17-34ms when called by hand.
 * Three hypotheses were measured against the sandbox rather than argued:
 *
 *   probe timeout   REJECTED. The readings that flipped answered in 13-39ms,
 *                   two orders of magnitude inside the 4,000ms budget. The
 *                   slowest Plaid response ever observed here was 3,199ms and
 *                   it was a 200.
 *   cold start      REJECTED. The flip tracks the NUMBER of health calls, not
 *                   the age of the function instance: the eleventh call in a
 *                   burst flips whether it lands on a warm instance or a cold
 *                   one.
 *   rate limiting   CONFIRMED. Plaid rations `/institutions/get` per client_id.
 *                   Measured on 2026-09-11: after the bucket refilled, calls
 *                   1-10 returned 200 and call 11 returned HTTP 429
 *                   `INSTITUTIONS_GET_LIMIT` / `RATE_LIMIT_EXCEEDED`, and the
 *                   same shape reproduced against the deployment — ten
 *                   consecutive `live` readings followed by three `simulated`
 *                   ones, each carrying the evidence string
 *                   `POST /institutions/get -> 429`.
 *
 * Each health request spent one unit of a ten-unit budget, and a single
 * compliance run reads the endpoint four or more times while audit-claims
 * reads it again. The budget is per credential, so every caller — the
 * deployment, a monitor, a script on a laptop — draws on the same ten.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS MODULE ENCODES
 * ---------------------------------------------------------------------------
 * A 429 is not a fact about the credential. It is a fact about how often WE
 * asked. The provider never looked at the key, so the reading reached no
 * verdict at all — and a reading that reached no verdict must not be allowed
 * to overwrite one that did.
 *
 * So: a verdict the provider actually pronounced (it accepted the credential,
 * or it rejected it) is remembered with the instant it was pronounced. A later
 * reading that cannot reach the provider reports THAT verdict together with
 * its age, rather than downgrading the slot on evidence it does not have.
 *
 * Two bounds keep this from becoming "always say live", which would defeat the
 * entire point of an endpoint whose verdicts are earned by round trips:
 *
 *   * only `live` and `unauthorised` are ever remembered — the two outcomes
 *     where the provider evaluated the credential and said something about it.
 *     `unreachable`, `rate_limited`, `not_configured` and `unprobed` are
 *     absences of a verdict and are never written here, so no absence can be
 *     replayed as if it were a verdict.
 *   * every recall is bounded by a caller-supplied max age and returns that
 *     age, which `/api/health` publishes. A quotation with no age on it is a
 *     claim about the present tense that nobody checked; with the age on it,
 *     it is a dated fact a reader can discount.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is process memory, not storage. On Vercel it lives for the life of one
 * function instance, so a cold instance starts with no memory and probes for
 * real — which is the correct failure direction: the worst a lost cache can do
 * is force an honest round trip. It is deliberately NOT written to the
 * database: a health endpoint that needs a write to answer has acquired a new
 * way to fail, and `/api/health` must not throw.
 */

import type { IntegrationSlot } from "@/lib/env";

/**
 * The verdicts a provider can PRONOUNCE. Both mean the credential was looked
 * at: one accepted, one rejected. Nothing else earns a place in this cache,
 * which is what stops it from laundering silence into a claim.
 */
export type EarnedLiveness = "live" | "unauthorised";

export interface EarnedVerdict {
  readonly liveness: EarnedLiveness;
  /** The evidence string from the round trip that earned it, verbatim. */
  readonly detail: string;
  /** That round trip's latency, not this reading's. */
  readonly latencyMs: number;
  /** Epoch ms of the round trip. Published, never inferred. */
  readonly provenAtMs: number;
}

/** An earned verdict plus how old it is at the moment it is quoted. */
export interface RecalledVerdict extends EarnedVerdict {
  readonly ageMs: number;
}

/**
 * The last ROUND TRIP, verdict or not. Separate from the verdict memory on
 * purpose, and added after the first version of this fix was measured.
 *
 * That version quoted correctly but still called Plaid on every reading once
 * the quotation went stale, so a burst of health checks against an already
 * empty bucket spent thirteen more units of the ration in forty seconds —
 * keeping the bucket empty, delaying its refill, and doing it on behalf of an
 * endpoint whose whole complaint was that it asked too often. Backing off
 * needs the time of the last ATTEMPT, which the verdict memory deliberately
 * does not hold: a throttled attempt is not a verdict and must not be stored
 * as one.
 */
export interface Attempt {
  readonly liveness: string;
  readonly detail: string;
  readonly atMs: number;
}

const memory = new Map<IntegrationSlot, EarnedVerdict>();
const attempts = new Map<IntegrationSlot, Attempt>();

/**
 * Remember a verdict a provider actually pronounced.
 *
 * Callers pass the liveness they got; anything that is not an earned verdict
 * is dropped here rather than at the call site, so a new liveness value added
 * to `probe.ts` cannot silently become quotable by being forgotten in one
 * branch of one probe.
 */
export function rememberVerdict(
  slot: IntegrationSlot,
  verdict: { liveness: string; detail: string; ms: number },
  nowMs: number,
): void {
  if (verdict.liveness !== "live" && verdict.liveness !== "unauthorised") return;
  memory.set(slot, {
    liveness: verdict.liveness,
    detail: verdict.detail,
    latencyMs: verdict.ms,
    provenAtMs: nowMs,
  });
}

/**
 * The last earned verdict for this slot, if it is younger than `maxAgeMs`.
 *
 * `null` when nothing was ever earned, or when what was earned is too old to
 * quote. Both cases mean the same thing to the caller — say what you measured
 * this time, and say that you could not reach a verdict — which is why they
 * are not distinguished in the return type.
 */
export function recallVerdict(
  slot: IntegrationSlot,
  maxAgeMs: number,
  nowMs: number,
): RecalledVerdict | null {
  const held = memory.get(slot);
  if (held === undefined) return null;
  const ageMs = nowMs - held.provenAtMs;
  // A negative age means the clock moved backwards under us. Refuse rather
  // than quote a verdict from the future.
  if (ageMs < 0 || ageMs > maxAgeMs) return null;
  return { ...held, ageMs };
}

/**
 * Record that a round trip happened and what came back, verdict or not.
 *
 * Called on every real attempt, including the ones that reached nothing, so a
 * rationed slot can decline to spend another unit of the ration until its
 * refresh interval has passed since the last ATTEMPT rather than since the
 * last success.
 */
export function rememberAttempt(
  slot: IntegrationSlot,
  verdict: { liveness: string; detail: string },
  nowMs: number,
): void {
  attempts.set(slot, { liveness: verdict.liveness, detail: verdict.detail, atMs: nowMs });
}

/** The last round trip for this slot, or null if none has happened here yet. */
export function recallAttempt(slot: IntegrationSlot): Attempt | null {
  return attempts.get(slot) ?? null;
}

/** Drop everything. Exists for tests; nothing in the request path calls it. */
export function forgetVerdicts(): void {
  memory.clear();
  attempts.clear();
}
