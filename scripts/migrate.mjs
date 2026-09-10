#!/usr/bin/env node
// Apply db/migrations/*.sql in order, each in its own transaction.
// Deliberately boring: no migration framework, no state table beyond
// schema_migrations, nothing that could reorder or silently skip a file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

// Migrations run on the DIRECT (unpooled) connection. Neon's pooler is
// PgBouncer in transaction mode, where a session-level advisory lock does not
// survive between statements and some DDL misbehaves. The app uses the pooled
// URL; migrations must not.
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error("DIRECT_URL / DATABASE_URL is not set"); process.exit(1); }

// max:1 — migrations must run on one connection, in order. Advisory lock
// makes a second concurrent runner wait rather than interleave.
const sql = postgres(url, { max: 1, onnotice: () => {} });

const dir = join(process.cwd(), "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

await sql`SELECT pg_advisory_lock(hashtext('corgi_migrations'))`;
await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  sha256 text NOT NULL
)`;

for (const f of files) {
  const body = readFileSync(join(dir, f), "utf8");
  const sha = await sql`SELECT encode(digest(${body}, 'sha256'), 'hex') AS h`
    .catch(() => [{ h: "pgcrypto-not-ready" }]);
  const [row] = await sql`SELECT sha256 FROM schema_migrations WHERE filename = ${f}`;
  if (row) {
    if (row.sha256 !== sha[0].h && sha[0].h !== "pgcrypto-not-ready") {
      console.error(`REFUSING: ${f} already applied but its contents changed.`);
      console.error("A migration is immutable once applied. Write a new one.");
      process.exit(1);
    }
    console.log(`  skip   ${f} (already applied)`);
    continue;
  }
  process.stdout.write(`  apply  ${f} ... `);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (filename, sha256) VALUES (${f}, ${sha[0].h})`;
    });
    console.log("ok");
  } catch (e) {
    console.log("FAILED");
    console.error(`\n${e.message}`);
    if (e.position) {
      const upto = body.slice(0, Number(e.position));
      console.error(`  at line ${upto.split("\n").length}: ${body.split("\n")[upto.split("\n").length - 1]?.trim()}`);
    }
    process.exit(1);
  }
}
await sql`SELECT pg_advisory_unlock(hashtext('corgi_migrations'))`;
await sql.end();
console.log("migrations up to date");
