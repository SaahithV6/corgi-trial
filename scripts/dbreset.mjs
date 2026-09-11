#!/usr/bin/env node
/**
 * Drop and rebuild the schema from migrations. DESTRUCTIVE.
 *
 * Exists for one reason: during the build, a migration file can change after
 * it has been applied. migrate.mjs refuses that (correctly — an applied
 * migration is immutable), so the only honest recovery while there is no real
 * data is to rebuild from zero. It refuses to run if the journal has rows.
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const url = process.env.DIRECT_URL;
if (!url) { console.error("DIRECT_URL is not set"); process.exit(1); }
const sql = postgres(url, { max: 1, onnotice: () => {} });

const exists = await sql`SELECT to_regclass('public.journal_entry') IS NOT NULL AS t`;
if (exists[0].t) {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM journal_entry`;
  if (n > 0 && process.env.FORCE_RESET !== "yes") {
    console.error(`REFUSING: journal_entry has ${n} rows.`);
    console.error("Rebuilding would destroy posted money. Set FORCE_RESET=yes only if you are certain.");
    process.exit(1);
  }
}

console.log("dropping schema public ...");
await sql.unsafe("DROP SCHEMA public CASCADE");
await sql.unsafe("CREATE SCHEMA public");
await sql.unsafe("GRANT USAGE ON SCHEMA public TO corgi_app");
await sql.end();

console.log("re-running migrations ...");
const r = spawnSync("node", ["scripts/migrate.mjs"], { stdio: "inherit", env: process.env });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log("re-granting corgi_app ...");
const s2 = postgres(url, { max: 1, onnotice: () => {} });
await s2.unsafe("GRANT USAGE ON SCHEMA public TO corgi_app");
await s2.unsafe("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO corgi_app");
await s2.unsafe("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM corgi_app");
await s2.unsafe(`GRANT SELECT, INSERT ON journal_entry, journal_line, card_authorization,
  card_auth_event, hold, hold_closure, book_day, statement, scheme_file, scheme_file_row,
  recon_match, recon_break_note, payment_instruction, payment_instruction_event TO corgi_app`);
await s2.unsafe("GRANT SELECT, INSERT, UPDATE ON webhook_inbox TO corgi_app");
await s2.unsafe(`GRANT SELECT ON business, actor, account, book_entity,
  funds_availability_policy, rail_event_semantics, approval_policy TO corgi_app`);

// RE-GRANT SELECT ON EVERY VIEW, BECAUSE THIS SCRIPT ATE TWO OF THEM.
//
// The REVOKE above says ALL TABLES, and in Postgres that includes views. The
// hardcoded re-grant list below it names not one view — so every view grant a
// migration had issued was silently dropped and only the ones issued by LATER
// migrations survived.
//
// It was not theoretical. `0002` granted v_webhook_dead_letter and
// v_webhook_parked; this script revoked them in the same batch, and both were
// unreadable by the app role for the rest of the build. 107 of 109 views were
// fine purely because their migrations happened to run after the last reset.
// The apply timestamps show the cut exactly: 0001/0002/0003 share one batch
// with the reset, 0005 onward came hours later.
//
// Worse than the outage: NOTHING READ THEM. A documented staff surface was
// dead with no degraded screen and no logged error, because `home/summary.ts`
// and `chaos/observe.ts` count dead and parked straight off `webhook_inbox`.
// The privilege being gone was invisible from inside the product.
//
// A hardcoded list cannot notice a view nobody added it to — the same failure
// this build has catalogued twenty-four times. So this is derived from the
// catalogue rather than typed: every view in `public`, whatever a migration
// called it, every time this script runs.
//
// Tables stay explicit above, deliberately. A view is a read; a table is a
// write surface, and `corgi_app` holding SELECT+INSERT on the money tables and
// nothing else is the whole four-layer immutability argument. Blanket-granting
// tables would undo it.
const views = await s2.unsafe(
  `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`,
);
for (const v of views) {
  await s2.unsafe(`GRANT SELECT ON "${v.table_name}" TO corgi_app`);
}
console.log(`re-granted SELECT on ${views.length} view(s) — derived from the catalogue, not a list`);

await s2.end();
console.log("done — run `node scripts/dbcheck.mjs` to prove the invariants");
