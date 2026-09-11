/**
 * The vocabulary of opening an account.
 *
 * Pure types and pure data: no `postgres`, no `server-only`, no I/O. The
 * screen, the action and the drift test all import from here, so the words are
 * the same in all three.
 */

import {
  PER_BUSINESS_PARENTS,
  perBusinessAccountName,
  type ChartAccount,
} from "@/lib/ledger/chart";

/** One leaf of a customer's chart, after `business_accounts_open()` ran. */
export type OpenedAccount = {
  /** The rollup this leaf hangs off: `2100`, `9100`, `9200`. */
  readonly rollupCode: string;
  readonly accountId: string;
  /** `account.code` as stored — BARE, never the qualified display form. */
  readonly code: string;
  readonly name: string;
  /**
   * Did THIS call create it?
   *
   * The field that makes idempotence visible instead of inferred. A second
   * call returns the same three account ids with `opened: false`, which is a
   * different and much more useful answer than "no error".
   */
  readonly opened: boolean;
};

/**
 * What happened when approval was applied to a business.
 *
 * `kind` is deliberately three-valued rather than a boolean, because the three
 * cases are genuinely different things to say to an operator:
 *
 *   opened      this call opened at least one leaf. The interesting one.
 *   already     approved, and every leaf was already there. A no-op, and the
 *               proof that opening twice opens once.
 *   not_yet     not approved. NOT an error: `openAccountsOnApproval()` runs
 *               after every KYB write, and most KYB writes do not approve
 *               anything. A business that is still `needs_review` having no
 *               accounts is the system working.
 */
export type OpenAccountsOutcome =
  | {
      readonly kind: "opened" | "already";
      readonly businessId: string;
      readonly accounts: readonly OpenedAccount[];
      /** The deposit leaf — where money actually lands. */
      readonly depositAccountId: string;
    }
  | {
      readonly kind: "not_yet";
      readonly businessId: string;
      /** The derived KYB status that is not `approved`, for the sentence. */
      readonly status: string;
      readonly accounts: readonly [];
    };

/**
 * The codes `openBusinessAccounts()` can refuse with.
 *
 * Each maps to a `RAISE` in `db/migrations/0021_open_accounts.sql`, and the
 * mapping is by SQLSTATE rather than by message text — a refusal identified by
 * string matching is a refusal one rewording away from being silently
 * reclassified as an unknown failure.
 */
export const OPEN_REFUSAL = {
  /** SQLSTATE 42501 raised by the gate, or by the agent check. */
  KYB_NOT_APPROVED: "KYB_NOT_APPROVED",
  ACTOR_MAY_NOT_OPEN: "ACTOR_MAY_NOT_OPEN",
  /** SQLSTATE 23503: no such business, no such actor, or the chart is missing. */
  NOTHING_TO_OPEN: "NOTHING_TO_OPEN",
  /** Anything else the database said. Never swallowed, never guessed at. */
  ACCOUNT_OPEN_FAILED: "ACCOUNT_OPEN_FAILED",
} as const;

export type OpenRefusalCode = (typeof OPEN_REFUSAL)[keyof typeof OPEN_REFUSAL];

/**
 * The chart shape this module opens, derived from `chart.ts` and from nothing
 * else.
 *
 * `db/migrations/0021` carries the same three rows because a plpgsql function
 * cannot import TypeScript. That duplication is the risk this constant exists
 * to make checkable: `shape.test.ts` reads the migration file off disk and
 * asserts, with no database, that its `per_business_rollup` seed is exactly
 * this list — codes, order and leaf names.
 */
export const PER_BUSINESS_ROLLUPS: readonly ChartAccount[] = PER_BUSINESS_PARENTS;

/**
 * The suffix a leaf of `parentCode` is named with, i.e.
 * `perBusinessAccountName()` with the legal name stripped off.
 *
 * The migration stores the suffix (`business current account`) and composes
 * `legal_name || ' — ' || suffix` in SQL. This function is how the drift test
 * recovers the same string from the TypeScript side without hardcoding it
 * twice.
 */
export function leafNameSuffix(parentCode: string): string {
  // A placeholder no real legal name contains, so the split below stays
  // unambiguous even for a company whose own name carries an em dash.
  const marker = "<legal-name>";
  const composed = perBusinessAccountName(parentCode, marker);
  const prefix = `${marker} — `;
  if (!composed.startsWith(prefix)) {
    throw new Error(
      `perBusinessAccountName('${parentCode}') no longer starts with the legal name and an em dash; the migration composes the name that way and the two have drifted`,
    );
  }
  return composed.slice(prefix.length);
}
