#!/usr/bin/env node
/**
 * Redrive the dead letters whose reason is no longer true.
 *
 * ─── THE FAULT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * 167 signature-verified Increase deliveries were accepted, retried eight
 * times, and dead-lettered with `no consumer registered for provider
 * 'increase'`. Every one of them arrived between 03:58:18Z and 04:46:06Z on
 * 2026-09-11, which is the window in which that sentence was TRUE. A consumer
 * has been registered since — 54 deliveries from the same provider have been
 * consumed after it — and nothing has died on this feed since 06:18:45Z.
 *
 * `processing_error` is never cleared, so `/api/health` went on quoting the
 * dead sentence, the processing verdict stayed `dropping`, and the deployment
 * read `degraded` for a reason that had already been fixed. A permanently
 * degraded status nobody can clear is a status people stop reading, which is
 * the same failure as a guard that cries wolf. This is the thing that clears
 * it — and it clears it by doing the work, not by editing the symptom.
 *
 * ─── WHAT IT IS ALLOWED TO WRITE, AND WHY THAT IS NOT A BACK DOOR ───────────
 *
 * `webhook_inbox` is append-only about the PROVIDER and one-way about US.
 * `webhook_inbox_guard()` (db/migrations/0002) refuses DELETE outright, refuses
 * any change to `provider`, `provider_event_id`, `payload`, `event_type`,
 * `received_at`, `raw_body`, `headers` or `signature_verified_at`, refuses to
 * move `processed_at` twice, and refuses to move a row out of `done`. It
 * explicitly PERMITS `dead -> pending` with both counters zeroed, in those
 * words, because requeueing a dead letter after the bug is fixed is a
 * legitimate staff action. 0002 §6 grants `corgi_app` UPDATE on exactly the
 * processing columns and no others.
 *
 * So this script connects as `corgi_app` — never as the owner — and every
 * statement it issues is one the database would refuse if it were wrong about
 * this. Nothing here touches a money row: `journal_entry` and `journal_line`
 * are append-only to everybody, the redriven deliveries reach the ledger
 * through `postEntry()` inside the consumers exactly as a first delivery would,
 * and the idempotency keys are derived from the TRANSFER rather than the
 * delivery, so a redrive of a delivery that was already booked posts nothing.
 * A redriven delivery that posts nothing is a result, and this script reports
 * it as one.
 *
 * ─── WHAT IT REFUSES TO REDRIVE ─────────────────────────────────────────────
 *
 * Only rows whose recorded reason is one this build has since fixed, and only
 * after the deployed drain has told us, in its own words, which consumers are
 * registered right now. If the provider has no consumer in that list, the
 * reason is still true and the rows stay dead. "Redrive everything and see"
 * is how a poison event loops for ever.
 *
 * ─── AND THEN IT MAKES THE REASONS CURRENT ──────────────────────────────────
 *
 * A dead letter should say why it is dead TODAY. Two corrections, after the
 * drain has settled:
 *
 *   parked rows  `park()` in src/lib/webhooks/inbox.ts writes `parked_reason`
 *                and leaves `processing_error` untouched, so a row that failed
 *                once and later parked carries two fields disagreeing about
 *                itself — a correct `parked_reason` beside a stale error. The
 *                parked reason is the current one and the only one; the stale
 *                error is cleared. (The durable fix belongs in `park()`, which
 *                this change does not own. See the report.)
 *   dead rows    anything still dead carrying a superseded reason is restamped
 *                with what is true now, naming the redrive that proved it.
 *
 * Usage:
 *
 *   node scripts/redrive.mjs                        # dry run, changes nothing
 *   node scripts/redrive.mjs --apply                # requeue, drain, report
 *   node scripts/redrive.mjs --apply --no-drain     # requeue only
 *   node scripts/redrive.mjs --provider increase    # default: every provider
 *   node scripts/redrive.mjs --url https://…        # the deployment to drain
 */
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APPLY = has("--apply");
const DRAIN = !has("--no-drain");
const PROVIDER = valueOf("--provider", null);
const DEPLOYMENT = (valueOf("--url", process.env.REDRIVE_BASE_URL ?? "https://corgi-trial-psi.vercel.app")).replace(/\/+$/, "");
const MAX_DRAIN_CALLS = Number(valueOf("--max-drain-calls", "12"));

/**
 * The reasons this build has since fixed, as SQL LIKE patterns.
 *
 * A LIST, not a wildcard. Each entry is a fault that was diagnosed and closed,
 * so a row carrying it is dead for a reason that no longer exists. Anything
 * else stays dead: an operator redriving a reason nobody has fixed is just
 * restarting the failure.
 */
const SUPERSEDED_REASONS = [
  {
    like: "%no consumer registered for provider%",
    fixed:
      "a consumer is registered for this provider now (src/lib/webhooks/drain.ts registers one per provider)",
  },
];

// ---------------------------------------------------------------------------
// Connection — as the APPLICATION role, never the owner
// ---------------------------------------------------------------------------

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("APP_DATABASE_URL is not set (must be the corgi_app role, not the owner)");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });

const money = (cents) => {
  const n = BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return `${neg ? "-" : ""}$${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
};

async function stateCounts() {
  const rows = await sql`
    SELECT provider, state, count(*)::int AS n
      FROM webhook_inbox
     ${PROVIDER ? sql`WHERE provider = ${PROVIDER}` : sql``}
     GROUP BY 1, 2 ORDER BY 1, 2`;
  return rows;
}

function printCounts(label, rows) {
  console.log(`\n  ${label}`);
  for (const r of rows) console.log(`    ${r.provider.padEnd(10)} ${r.state.padEnd(8)} ${String(r.n).padStart(5)}`);
}

/** Ask the DEPLOYMENT which consumers it has, rather than assuming. */
async function registeredConsumers() {
  const token = process.env.DRAIN_TOKEN;
  if (!token) throw new Error("DRAIN_TOKEN is not set; the drain endpoint cannot be called");
  const res = await fetch(`${DEPLOYMENT}/api/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`drain refused: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  return body;
}

async function drainOnce() {
  const token = process.env.DRAIN_TOKEN;
  const res = await fetch(`${DEPLOYMENT}/api/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`drain failed: ${res.status} ${JSON.stringify(body.error ?? body)}`);
  return body;
}

// ---------------------------------------------------------------------------
// 1. What is dead, and is its reason still true
// ---------------------------------------------------------------------------

console.log("\nREDRIVE — dead letters whose reason has since been fixed\n");
console.log(`  database    ${url.replace(/:\/\/[^@]*@/, "://***@")}`);
console.log(`  deployment  ${DEPLOYMENT}`);
console.log(`  mode        ${APPLY ? "APPLY" : "dry run (nothing is written)"}`);

const before = await stateCounts();
printCounts("inbox before", before);

const PATTERNS = SUPERSEDED_REASONS.map((r) => r.like);

const candidates = await sql`
  SELECT id, provider, provider_event_id, event_type, received_at,
         dead_lettered_at, attempts, park_attempts, processing_error
    FROM webhook_inbox
   WHERE state = 'dead'
     AND ${PROVIDER ? sql`provider = ${PROVIDER}` : sql`true`}
     AND processing_error LIKE ANY (${PATTERNS})
   ORDER BY received_at`;

const stillDead = await sql`
  SELECT provider, processing_error, count(*)::int AS n
    FROM webhook_inbox
   WHERE state = 'dead'
     AND ${PROVIDER ? sql`provider = ${PROVIDER}` : sql`true`}
     AND (processing_error IS NULL OR NOT (processing_error LIKE ANY (${PATTERNS})))
   GROUP BY 1, 2 ORDER BY 3 DESC`;

console.log(`\n  ${candidates.length} dead letter(s) carry a reason this build has since fixed:`);
{
  const byProvider = new Map();
  for (const c of candidates) {
    const k = `${c.provider} · ${c.event_type ?? "(unparsed)"}`;
    byProvider.set(k, (byProvider.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }
}

if (stillDead.length > 0) {
  console.log(`\n  and ${stillDead.reduce((s, r) => s + r.n, 0)} dead letter(s) are NOT redriven, because nobody has fixed their reason:`);
  for (const r of stillDead) {
    console.log(`    ${String(r.n).padStart(4)}  ${r.provider} — ${String(r.processing_error ?? "(none)").slice(0, 120)}`);
  }
}

if (candidates.length === 0) {
  console.log("\n  nothing to redrive.\n");
  await sql.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Is the reason actually fixed? Ask the deployment, do not assume.
// ---------------------------------------------------------------------------

let firstDrain = null;
const providersToRedrive = new Set(candidates.map((c) => c.provider));
try {
  firstDrain = await registeredConsumers();
  console.log(`\n  deployed consumers: ${firstDrain.consumers.join(", ") || "(none)"}`);
  if (firstDrain.missingConsumers?.length) {
    console.log(`  MISSING: ${firstDrain.missingConsumers.join("; ")}`);
  }
} catch (e) {
  console.error(`\n  could not reach the drain endpoint: ${e.message}`);
  console.error("  refusing to redrive: the reason these rows died cannot be shown to be fixed.\n");
  await sql.end();
  process.exit(1);
}

const unserved = [...providersToRedrive].filter(
  (p) => !firstDrain.consumers.some((c) => c === p || c.startsWith(`${p}-`)),
);
if (unserved.length > 0) {
  console.error(`\n  refusing to redrive ${unserved.join(", ")}: still no consumer registered. The recorded reason is TRUE.\n`);
  await sql.end();
  process.exit(1);
}

if (!APPLY) {
  console.log("\n  dry run: re-run with --apply to requeue these and drain.\n");
  await sql.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Requeue — the one transition the guard trigger permits
// ---------------------------------------------------------------------------

const startedAt = new Date();
const note = (original) =>
  `redriven ${startedAt.toISOString()} by scripts/redrive.mjs — ${SUPERSEDED_REASONS[0].fixed}; superseded reason was: ${String(original).slice(0, 200)}`;

let requeued = 0;
for (const row of candidates) {
  const res = await sql`
    UPDATE webhook_inbox
       SET state = 'pending',
           dead_lettered_at = null,
           next_attempt_at = now(),
           locked_until = null,
           attempts = 0,
           park_attempts = 0,
           processing_error = ${note(row.processing_error)}
     WHERE id = ${row.id} AND state = 'dead'
    RETURNING id`;
  requeued += res.length;
}
console.log(`\n  requeued ${requeued} of ${candidates.length} (dead -> pending, counters zeroed)`);

// ---------------------------------------------------------------------------
// 4. Drain the deployment until it is idle
// ---------------------------------------------------------------------------

const totals = { claimed: 0, processed: 0, ignored: 0, parked: 0, retried: 0, deadLettered: 0, unparked: 0 };
if (DRAIN) {
  console.log("\n  draining the deployment:");
  for (let call = 1; call <= MAX_DRAIN_CALLS; call += 1) {
    const r = await drainOnce();
    for (const k of Object.keys(totals)) totals[k] += r[k] ?? 0;
    console.log(
      `    call ${String(call).padStart(2)}  claimed ${String(r.claimed).padStart(3)}  processed ${String(r.processed).padStart(3)}  ignored ${String(r.ignored).padStart(3)}  parked ${String(r.parked).padStart(3)}  retried ${String(r.retried).padStart(3)}  dead ${String(r.deadLettered).padStart(3)}  ${r.durationMs}ms`,
    );
    if ((r.claimed ?? 0) === 0) break;
  }
  console.log(`    total     claimed ${totals.claimed}  processed ${totals.processed}  ignored ${totals.ignored}  parked ${totals.parked}  retried ${totals.retried}  dead ${totals.deadLettered}`);
}

// ---------------------------------------------------------------------------
// 5. What posted — real entries, real ids, or an explicit nothing
// ---------------------------------------------------------------------------

const posted = await sql`
  SELECT e.id, e.idempotency_key, e.description, e.value_date, e.external_ref, e.rail, e.inbox_id
    FROM journal_entry e
   WHERE e.booking_time >= ${startedAt}
   ORDER BY e.booking_seq`;

console.log(`\n  ledger entries posted since ${startedAt.toISOString()}: ${posted.length}`);
if (posted.length === 0) {
  console.log("    NOTHING POSTED. That is a result, not a failure: every redriven delivery either");
  console.log("    was a ledger mirror of a movement already booked, parked for a referent this book");
  console.log("    does not have, or resolved to an entry whose idempotency key already existed.");
}
for (const e of posted) {
  const lines = await sql`
    SELECT a.code, a.name, l.amount_cents
      FROM journal_line l JOIN account a ON a.id = l.account_id
     WHERE l.entry_id = ${e.id} ORDER BY a.code`;
  console.log(`    ${e.idempotency_key}`);
  console.log(`      ${e.description} · value date ${new Date(e.value_date).toISOString().slice(0, 10)} · rail ${e.rail ?? "-"} · ref ${e.external_ref ?? "-"}`);
  for (const l of lines) console.log(`      ${l.code} ${l.name.padEnd(50)} ${money(l.amount_cents).padStart(14)}`);
}

// ---------------------------------------------------------------------------
// 6. Make every recorded reason current
// ---------------------------------------------------------------------------

// 6a. A parked row's current reason is `parked_reason`. One row, one opinion:
//     the stale `processing_error` beside it is cleared.
const clearedParks = await sql`
  UPDATE webhook_inbox
     SET processing_error = null
   WHERE state = 'parked'
     AND ${PROVIDER ? sql`provider = ${PROVIDER}` : sql`true`}
     AND processing_error IS NOT NULL
     AND parked_reason IS NOT NULL
  RETURNING id, provider`;
console.log(`\n  cleared a stale processing_error beside a current parked_reason on ${clearedParks.length} parked row(s)`);

// 6b. Anything still dead carrying a superseded reason is restamped with what
//     is true today. A dead letter that quotes a fault nobody has had for five
//     hours is archaeology, and archaeology in an alarm field is how an alarm
//     stops being read.
const restamped = await sql`
  UPDATE webhook_inbox
     SET processing_error = ${`redriven ${startedAt.toISOString()} and died again; see parked_reason / the consumer's own error. Original: `} || left(coalesce(processing_error, ''), 160)
   WHERE state = 'dead'
     AND ${PROVIDER ? sql`provider = ${PROVIDER}` : sql`true`}
     AND processing_error LIKE ${SUPERSEDED_REASONS[0].like}
  RETURNING id`;
if (restamped.length > 0) {
  console.log(`  restamped ${restamped.length} dead letter(s) whose reason was superseded`);
}

const after = await stateCounts();
printCounts("inbox after", after);

const stillStale = await sql`
  SELECT count(*)::int AS n FROM webhook_inbox
   WHERE processing_error LIKE ${SUPERSEDED_REASONS[0].like}`;
console.log(`\n  rows still carrying the superseded reason anywhere: ${stillStale[0].n}`);
console.log("");

await sql.end();
