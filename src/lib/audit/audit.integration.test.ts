/**
 * The actor trail, against the REAL Neon database.
 *
 * ============================================================================
 * WHY THESE ARE INTEGRATION TESTS AND NOT UNIT TESTS WITH A MOCK.
 *
 * Every claim this feature makes lives in Postgres: the projection is a view,
 * the completeness check is a diff against `information_schema`, and the
 * append-only guarantee is a privilege model plus a trigger. A mock would
 * assert that the application's copy of those rules works — and the whole
 * design is that the application has no copy.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials on purpose, skips
 * rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 * ============================================================================
 *
 * NOTHING HERE WRITES A ROW. The trail is a projection; the tests are reads.
 * The one test that needs a row that does not exist — a claimed-but-undecided
 * accrual day, to prove the coverage invariant can fail — creates it inside a
 * transaction that is rolled back, the way `scripts/dbcheck.mjs --prove` does.
 */

import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";

const RUN = process.env.RUN_DB_TESTS === "1";
const d = RUN ? describe : describe.skip;

d("the actor trail, against the live book", () => {
  let sql: typeof SqlHandle;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
  });

  it("drops no row from any projected source", async () => {
    // THE invariant. `stored_rows` is counted directly off each table with no
    // join and no predicate; `projected_rows` is counted off the projection.
    // They are computed independently so the check cannot read green by being
    // the same number twice.
    const drift = await sql`SELECT * FROM v_audit_coverage_drift`;
    expect(drift.map((r) => `${r["source"]}: ${r["stored_rows"]} stored, ${r["projected_rows"]} projected`)).toEqual([]);
  });

  it("CAN report a dropped row — proven, not assumed", async () => {
    // A guard nobody has seen fail is a claim. The reachable state is a
    // nightly run that CLAIMED a fee day and never decided it —
    // `v_accrual_unresolved` exists for exactly that — and the failure mode is
    // the obvious authoring mistake: an INNER JOIN where the projection needs
    // a LEFT JOIN. Rolled back; the book is untouched.
    //
    // THIS ONE TEST OPENS ITS OWN CONNECTION, and the reason is the feature
    // working: `@/lib/ledger/db` connects as `corgi_app`, which holds no
    // CREATE on schema `public` and no INSERT on `accrual_day`, so the
    // application role physically cannot rehearse this failure. Proving a
    // guard can fail requires breaking it, and breaking it requires the owner
    // — the same split `scripts/migrate.mjs` (DIRECT_URL) and
    // `scripts/dbcheck.mjs` (APP_DATABASE_URL) already keep.
    const ownerUrl = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
    if (!ownerUrl) return;
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });

    let proof: { left: Record<string, string>; inner: Record<string, string> } | null = null;

    // postgres.js rolls back when the callback throws, so the results are
    // stashed on the way out and a sentinel is thrown to undo everything —
    // including the CREATE OR REPLACE VIEW, which is transactional in
    // Postgres and therefore never visible to another connection or to the
    // next test in this file.
    await owner
      .begin(async (tx) => {
        const [schedule] = await tx`SELECT id, start_date FROM accrual_schedule ORDER BY created_at LIMIT 1`;
        if (!schedule) throw new Error("ROLLBACK-ON-PURPOSE");

        await tx`INSERT INTO accrual_day (schedule_id, accrual_date, claimed_by)
                 VALUES (${schedule["id"] as string},
                         ${schedule["start_date"] as Date}::date + 400, 'vitest-prove')`;

        const [withLeftJoin] = await tx`
          SELECT stored_rows, projected_rows FROM v_audit_coverage WHERE source = 'accrual_day'`;

        // The same branch with the one join changed, which is the obvious
        // authoring mistake this invariant exists to catch.
        await tx.unsafe(`
          CREATE OR REPLACE VIEW v_actor_action AS
          SELECT 'accrual_day'::text AS source,
                 'accrual_day:' || d.id::text AS action_id,
                 NULL::uuid AS business_id, (d.accrual_date::timestamptz) AS occurred_at,
                 COALESCE(ap.decided_at, d.claimed_at) AS recorded_at,
                 d.accrual_date AS value_date, 'system'::text AS actor_kind,
                 NULL::uuid AS actor_id, 'x'::text AS actor_label, 'fees'::text AS surface,
                 'fee.x'::text AS action, 'x'::text AS summary, NULL::bigint AS amount_cents,
                 'account'::text AS subject_kind, s.account_id::text AS subject_id,
                 NULL::uuid AS entry_id, '{}'::jsonb AS detail
            FROM accrual_day d
            JOIN accrual_posting ap ON ap.accrual_day_id = d.id
            LEFT JOIN accrual_schedule s ON s.id = d.schedule_id`);

        const [withInnerJoin] = await tx`
          SELECT stored_rows, projected_rows FROM v_audit_coverage WHERE source = 'accrual_day'`;

        proof = {
          left: withLeftJoin as unknown as Record<string, string>,
          inner: withInnerJoin as unknown as Record<string, string>,
        };
        throw new Error("ROLLBACK-ON-PURPOSE");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "ROLLBACK-ON-PURPOSE") throw error;
      })
      .finally(() => owner.end());

    if (!proof) return; // No accrual schedule on this book to prove it on.

    // This connection has no bigint parser configured (that is a property of
    // `@/lib/ledger/db`, which is deliberately not reachable from here), so
    // the counts arrive as strings and are coerced exactly once.
    const { left, inner } = proof as {
      left: Record<string, string>;
      inner: Record<string, string>;
    };
    // With the LEFT JOIN the planted, undecided day is still projected.
    expect(BigInt(left["stored_rows"] ?? "0")).toBe(BigInt(left["projected_rows"] ?? "0"));
    // With the INNER JOIN it disappears, and the invariant reports it.
    expect(BigInt(inner["projected_rows"] ?? "0")).toBeLessThan(
      BigInt(inner["stored_rows"] ?? "0"),
    );
  });

  it("holds no UPDATE, DELETE or TRUNCATE on any projected source", async () => {
    const mutable = await sql`SELECT * FROM v_audit_source_mutable`;
    expect(mutable.map((r) => r["table_name"])).toEqual([]);
  });

  it("refuses an UPDATE on the two tables the trail does own", async () => {
    // `audit_source` and `mcp_audit` are the only rows this feature writes,
    // and they carry the same four layers the money tables do. A who-did-what
    // row that can be UPDATEd is not evidence.
    for (const table of ["audit_source", "mcp_audit"]) {
      await expect(
        sql.unsafe(`UPDATE ${table} SET request_id = request_id WHERE false`),
      ).rejects.toThrow();
    }
  });

  it("distinguishes an autonomous agent from a person in the data", async () => {
    // Not a rendering claim — a data claim. If the two are indistinguishable
    // in SQL, no amount of badge styling makes the screen honest.
    const rows = await sql<{ actor_kind: string; n: bigint }[]>`
      SELECT actor_kind, count(*) AS n FROM v_business_timeline GROUP BY actor_kind`;
    const kinds = new Set(rows.map((r) => r.actor_kind));
    expect(kinds.has("agent")).toBe(true);
    expect(kinds.has("human")).toBe(true);
    expect(kinds.has("provider")).toBe(true);
  });

  it("never projects a card token, a PAN or a full account number", async () => {
    // The projection is the redaction boundary, so every reader of
    // `v_actor_action` inherits it rather than re-implementing it.
    const [row] = await sql<{ def: string }[]>`
      SELECT pg_get_viewdef('v_actor_action'::regclass, true) AS def`;
    const def = (row?.def ?? "").toLowerCase();
    for (const forbidden of ["provider_card_token", "raw_body", "account_number,", "card_number"]) {
      expect(def).not.toContain(forbidden);
    }
  });
});
