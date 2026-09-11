/**
 * Is a database configured for this deployment?
 *
 * ============================================================================
 * THIS FILE IMPORTS NOTHING, AND THAT IS THE ENTIRE REASON IT EXISTS.
 * ============================================================================
 *
 * The same function used to live at the bottom of `./live-source.ts`, and
 * `page.tsx` reached it with `const { hasDatabase } = await import("./live-source")`.
 * That line could not do what its comment said. Importing `./live-source`
 * evaluates its module graph, which reaches `@/lib/ledger/db`, which reads
 * `@/lib/env`, which parses `process.env` at module scope and throws
 * `EnvironmentError` when `APP_DATABASE_URL` is absent — deliberately, so a
 * malformed database URL kills the process at boot rather than at the first
 * request that needs money.
 *
 * So the guard was unreachable in exactly the case it was written for: the
 * import on the line above it only succeeds when a database IS configured, and
 * `hasDatabase()` returns false only when one is not. With no database the
 * page did not render "no database configured" — it threw before it could
 * decide anything, and the operator got the framework's error page.
 *
 * The predicate is the same one `@/lib/env.schema` gates the boot on: a
 * non-empty `APP_DATABASE_URL`. It does not prove the database is reachable —
 * nothing but a query proves that, and a query that fails is reported by
 * `createLiveTriageSource()` as a failed read.
 */

export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.length > 0;
}
