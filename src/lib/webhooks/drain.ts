import "server-only";

import { sql } from "@/lib/ledger/db";
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
  const wanted: { name: string; specifier: string }[] = [
    { name: "lithic-card", specifier: "./consumers/lithic-card" },
  ];

  for (const w of wanted) {
    try {
      const mod = (await import(/* @vite-ignore */ w.specifier)) as {
        consumer?: Parameters<typeof consumers.register>[0];
      };
      if (mod?.consumer) {
        consumers.register(mod.consumer, { replace: true });
        found.push(w.name);
      } else {
        missing.push(`${w.name}: module loaded but exported no 'consumer'`);
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

  const result: DrainResult = {
    ...summary,
    consumers: names,
    missingConsumers: missing,
    durationMs: Date.now() - started,
  };
  log.info("drain.complete", result as unknown as Record<string, unknown>);
  return result;
}
