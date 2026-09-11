import "server-only";

import { sql } from "@/lib/ledger/db";
import { releaseAvailableCredits } from "@/lib/rails/plaid/adapter";
import { logger } from "@/lib/log";

import {
  consumers,
  dispatchUntilIdle,
  type DispatchSummary,
} from "./dispatch";
import { createPostgresInboxStore, sqlExecutorFromPostgresJs } from "./inbox";

/**
 * The drain: the thing that actually turns a stored webhook into money.
 *
 * The route handler deliberately stops at "verified and persisted". That is
 * the right contract — a provider needs its 2xx inside seconds and Plaid
 * retries for twenty-four hours if it does not get one, so no consumer runs
 * inline. But it means the inbox is only half a pipeline until something
 * drains it, and until this module existed nothing did. Rows accumulated,
 * verified and durable, and no journal line was ever written from one.
 *
 * Three triggers, deliberately, because each fails differently:
 *
 *   1. `after()` from the webhook route — the fast path. Runs once the
 *      response is already on its way, so it costs the provider nothing.
 *      Not relied upon: a nudge that *usually* runs is the worst kind of
 *      delivery mechanism, because it works right up until it matters.
 *   2. A cron hitting /api/drain — the guarantee. If every nudge is lost, a
 *      row is still processed on the next tick.
 *   3. /api/drain by hand — for the demo, and for the debrief, where being
 *      able to say "watch, I will drain it now" beats waiting for a timer.
 *
 * The inbox row is durable before any of these run, so losing all three loses
 * latency and never loses money.
 */

let registered = false;
let registeredNames: string[] = [];

/**
 * Register the consumers.
 *
 * Imported dynamically so that a consumer module still being written does not
 * break the build or the deploy. If one is missing we log loudly and drain
 * what we can; silently draining zero consumers would look identical to
 * working, which is the failure mode this whole build keeps guarding against.
 */
async function ensureConsumers(): Promise<{ registered: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];

  if (registered) return { registered: registeredNames, missing };

  // The specifier is held in a variable on purpose. The consumer module is
  // authored separately, and a STATIC import of a file that does not exist yet
  // fails the typecheck and the build for everyone. A variable specifier keeps
  // this module compiling and turns a missing consumer into a loud runtime
  // warning, which is the failure we can actually see and act on.
  const wanted: { name: string; specifier: string; register: string; export: string }[] = [
    {
      name: "lithic-card",
      specifier: "./consumers/lithic-card",
      register: "registerLithicCardConsumer",
      export: "lithicCardConsumer",
    },
  ];

  for (const w of wanted) {
    try {
      // Accept either shape a consumer module can offer: an explicit
      // register* function (preferred — the author controls replace
      // semantics) or a bare exported consumer object.
      const mod = (await import(/* @vite-ignore */ w.specifier)) as Record<string, unknown>;
      const register = mod[w.register] as
        | ((r: typeof consumers, o: { replace?: boolean }) => unknown)
        | undefined;
      const bare = (mod[w.export] ?? mod["consumer"]) as
        | Parameters<typeof consumers.register>[0]
        | undefined;
      if (typeof register === "function") {
        register(consumers, { replace: true });
        found.push(w.name);
      } else if (bare) {
        consumers.register(bare, { replace: true });
        found.push(w.name);
      } else {
        missing.push(`${w.name}: loaded but exported neither ${w.register}() nor ${w.export}`);
      }
    } catch (e) {
      missing.push(`${w.name}: ${e instanceof Error ? e.message.slice(0, 90) : "load failed"}`);
    }
  }
  registeredNames = found;

  registered = true;
  return { registered: found, missing };
}

export interface DrainResult extends DispatchSummary {
  consumers: string[];
  missingConsumers: string[];
  durationMs: number;
  /** Uncleared credits that matured and were released by this run. */
  creditsReleased: number;
  /** Non-null if the sweep failed. The drain still succeeds; this is reported. */
  creditSweepError: string | null;
}

export async function drain(opts: { maxBatches?: number } = {}): Promise<DrainResult> {
  const started = Date.now();
  const log = logger({ requestId: `drain-${started}` });
  const { registered: names, missing } = await ensureConsumers();

  if (missing.length) {
    // Loud, not silent. A drain with no consumer registered processes nothing
    // and reports success, which is indistinguishable from a healthy quiet
    // system unless somebody says so.
    log.warn("drain.consumer_missing", { missing });
  }

  const summary = await dispatchUntilIdle({
    store: createPostgresInboxStore(sqlExecutorFromPostgresJs(sql)),
    registry: consumers,
    // Small batches: a serverless invocation has to finish, and a half-done
    // batch is fine because the lease expires and the rows are claimed again.
    batchSize: 20,
    leaseMs: 60_000,
    maxBatches: opts.maxBatches ?? 5,
    logger: log,
  });

  // Release uncleared credits that have matured.
  //
  // `releaseAvailableCredits()` was written, tested, and CALLED BY NOTHING. A
  // funds-availability policy that nobody sweeps is a promise the system makes
  // and never keeps: `v_hold_state.is_released` flips true the moment
  // `now() >= available_at`, while the memo book still withholds the money —
  // which is exactly the shape `v_hold_release_drift` exists to report. Every
  // uncleared hold in this book matures at the same instant, so the drift
  // would have arrived all at once and in silence.
  //
  // It belongs on the drain rather than a new cron because the drain already
  // has the two properties this needs: it runs on a schedule AND on every
  // webhook nudge, and it is safe to run at any time. The sweep is idempotent
  // by construction — the release entry's key is derived from the hold id and
  // its immutable `available_at`, so a second sweep posts nothing.
  //
  // A failure here must NOT fail the drain. Releasing a credit and processing a
  // webhook are independent jobs that happen to share a trigger, and a sweep
  // that can block webhook processing is a worse bug than a late release.
  let creditsReleased = 0;
  let creditSweepError: string | null = null;
  try {
    const released = await releaseAvailableCredits({});
    creditsReleased = released.released;
    if (creditsReleased > 0) log.info("drain.credits_released", { count: creditsReleased });
  } catch (thrown) {
    creditSweepError = thrown instanceof Error ? thrown.message : String(thrown);
    log.warn("drain.credit_sweep_failed", { error: creditSweepError });
  }

  const result: DrainResult = {
    ...summary,
    consumers: names,
    missingConsumers: missing,
    durationMs: Date.now() - started,
    creditsReleased,
    creditSweepError,
  };
  log.info("drain.complete", result as unknown as Record<string, unknown>);
  return result;
}
