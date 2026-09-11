import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The passphrase check, and nothing else.
 *
 * Separate from `session.ts` on purpose: this module uses `node:crypto` and so
 * must never be reachable from `src/middleware.ts`, which runs on the Edge.
 * Middleware verifies a SIGNATURE; only the sign-in server action ever sees a
 * passphrase, and that runs on Node.
 *
 * The comparison is lifted from `src/app/api/cron/_auth.ts` deliberately —
 * same shape, same reasoning, one habit in this codebase rather than two:
 *
 *   Both sides are hashed to a fixed 32 bytes first, because `timingSafeEqual`
 *   THROWS on a length mismatch and catching that throw would itself be the
 *   length oracle. Hashing first makes every comparison 32 bytes wide whatever
 *   the operands were, so the only thing timing can reveal is that a
 *   comparison happened.
 *
 * There is deliberately NO distinction between "wrong passphrase" and "no such
 * user", because there are no users: one refusal, one message, no oracle.
 */

export type PassphraseVerdict =
  | { readonly ok: true }
  /** `CONSOLE_PASSWORD` is unset in this environment. The console is closed. */
  | { readonly ok: false; readonly reason: "NOT_CONFIGURED" }
  /** Something was presented and it was not the passphrase. */
  | { readonly ok: false; readonly reason: "REFUSED" };

/** Constant-time equality over two secrets of any length. */
function holds(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Does `presented` hold the console passphrase?
 *
 * Fails closed on an unset variable. An unconfigured environment is not an
 * open one — the same rule `authoriseScheduled()` is written under, and the
 * reason `/api/drain` cannot be opened by deleting a variable.
 *
 * Note that the empty string is compared rather than short-circuited when a
 * passphrase IS configured: an empty submission takes the same path, and the
 * same time, as a wrong one.
 */
export function verifyPassphrase(presented: string): PassphraseVerdict {
  const expected = process.env.CONSOLE_PASSWORD;
  if (expected === undefined || expected === "") {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }
  return holds(presented, expected) ? { ok: true } : { ok: false, reason: "REFUSED" };
}
