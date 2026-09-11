/**
 * The application's ONLY database handle.
 *
 * It connects as `corgi_app`, which holds SELECT and INSERT on the money
 * tables and nothing else. That is not a convention — the role physically
 * cannot express UPDATE or DELETE against journal_entry or journal_line, and
 * `pnpm db:check` proves it by attempting both and asserting refusal.
 *
 * The owner connection (DIRECT_URL) is deliberately NOT available here. It
 * exists for migrations and seeding, run from a terminal, never from a
 * request. Importing it into the app would hand the running system the one
 * capability the whole design exists to withhold.
 */

import "server-only";
import type { TransactionSql } from "postgres";
import postgres from "postgres";
import { env } from "@/lib/env";

export const sql = postgres(env.APP_DATABASE_URL, {
  // Vercel runs each lambda in its own process; a large pool per instance
  // exhausts Neon's connection limit under fan-out. The pooler multiplexes.
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  // BIGINT must not silently become a JS number. Money is bigint cents, and
  // Number.MAX_SAFE_INTEGER is ~$90 trillion — reachable in a fuzz test, and
  // a silent precision loss in a ledger is the worst class of bug there is.
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (v: bigint | number) => v.toString(),
      parse: (v: string) => BigInt(v),
    },
  },
  onnotice: () => {},
});

export type Sql = typeof sql;

/**
 * What a read needs: something you can issue a tagged-template query against.
 *
 * `Sql` is the pool; inside `sql.begin()` you hold a `TransactionSql`, which is
 * NOT assignable to it. Readers that only issue queries should not care which
 * they were handed — and the ones that take `Sql` force a caller inside a
 * transaction to either pass the pool (reading OUTSIDE its own transaction,
 * which is how `readSnapshot()` once called `now()` on a connection that had
 * not seen the rows it had just posted) or to give up and write the SQL
 * inline, which is the boundary leak `boundary.test.ts` ratchets against.
 *
 * Both failures push in the wrong direction, so the parameter type is the
 * union. A reader that genuinely needs pool-only behaviour asks for `Sql`.
 */
export type Queryable = Sql | TransactionSql<{ bigint: bigint }>;
