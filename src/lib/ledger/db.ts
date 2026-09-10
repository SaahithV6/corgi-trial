import "server-only";
import postgres from "postgres";
import { env } from "@/lib/env";

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
