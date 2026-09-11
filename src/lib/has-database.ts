/**
 * Is a database configured for this deployment?
 *
 * ============================================================================
 * THIS FILE IMPORTS NOTHING, AND THAT IS THE ENTIRE REASON IT EXISTS.
 * ============================================================================
 *
 * Six screens used to ask this question the way `/dashboard` did:
 *
 *     const { hasDatabase } = await import("./live-source");
 *     if (!hasDatabase()) return createFixtureSource("default");
 *
 * That line cannot do what its comment says. Importing a live source evaluates
 * its module graph, which reaches `@/lib/ledger/db`, which reads `@/lib/env`,
 * which parses `process.env` at module scope and throws `EnvironmentError`
 * when `APP_DATABASE_URL` is absent — deliberately, so a malformed database
 * URL kills the process at boot rather than at the first request that needs
 * money.
 *
 * So the guard was unreachable in exactly the case it was written for: the
 * import on the line above only succeeds when a database IS configured, and
 * this predicate returns false only when one is not. Measured on four of the
 * six — `/disputes` and `/pots` threw while the page module was loading,
 * `/standing-orders` and `/reconciliation` threw inside the render — and the
 * operator got the framework's error page, not a screen saying what was wrong.
 *
 * A predicate that imports nothing cannot be the thing that crashes for the
 * condition it is asked about. That is the whole design of this file, and it
 * is why it holds no other function: every import added here is a chance for
 * the question "is there a database" to require one.
 *
 * The predicate is the same one `@/lib/env.schema` gates the boot on: a
 * non-empty `APP_DATABASE_URL`. It does not prove the database is REACHABLE —
 * nothing but a query proves that, and a query that fails is reported by each
 * screen's live source as a failed read, on the same refusal path.
 *
 * `src/app/(app)/dashboard/has-database.ts` is a byte-identical copy, written
 * an hour earlier for the same defect on that screen. It is not imported from
 * here because `src/app/(app)/dashboard/**` belongs to another worker on this
 * build; the two should become one import of this module the moment one person
 * owns both.
 */

export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.length > 0;
}
