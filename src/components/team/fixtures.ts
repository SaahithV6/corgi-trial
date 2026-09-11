/**
 * The two states that cannot be produced on a live database on demand.
 *
 * `empty` needs a business nobody has added a member to; `error` needs the
 * database to be gone. Neither is a thing to arrange mid-demo, so both are
 * fixtures — and both print FIXTURE on their own face, because a screen that
 * looks live and is not is the fastest way to fail this trial.
 *
 * The two that ARE live are `default` and `edge`, and `edge` is a filter over
 * the same rows rather than a second read. The claim being graded is that
 * removing somebody leaves their outstanding authorisation alone; a fixture
 * would answer that by construction and prove nothing.
 *
 * Nothing here writes and nothing here reads.
 */

import type { TeamScreen } from "@/lib/team/screen";

const BUSINESSES = [
  { id: "00000000-0000-4000-8000-000000000001", legalName: "Northwind Fabrication LLC" },
] as const;

/**
 * A business with an account and no people.
 *
 * Not an error and not a broken state: KYB has passed, the 2100 leaf is open,
 * and nobody has been added yet. The first admin is created by Corgi ops at
 * account opening — `team_add_member()` refuses an author who holds no
 * `administer_team` in the business, and the first admin of a business cannot
 * be appointed by that business's first admin.
 */
export const EMPTY_TEAM: TeamScreen = {
  businessId: BUSINESSES[0].id,
  legalName: BUSINESSES[0].legalName,
  members: [],
  businesses: [...BUSINESSES],
  balance: { ledgerCents: 250_000n, holdsCents: 0n, availableCents: 250_000n },
  /**
   * EMPTY, AND THAT IS THE POINT OF THIS LINE.
   *
   * It used to carry `v_approved_auth_for_dead_member` and
   * `v_member_approval_without_right`, each with `rows: 0`, which `TeamView`
   * draws as two GREEN badges under the caption "2 invariants, counted on this
   * request". Nothing was counted on that request; this file runs no query and
   * cannot. A green nought in that column is how this console says a guard
   * held, and "no purchase was approved under member terms that were suspended
   * at the instant it was decided" is a statement about a book — the strongest
   * one on the screen. A fixture may draw a team. It may not certify one.
   *
   * The panel's caption is derived from `live` as well, so this state says
   * plainly that it counted none rather than leaving a reader to notice an
   * empty table.
   */
  invariants: [],
  asOf: "2026-09-11T00:00:00.000Z",
  live: false,
};

export const EMPTY_NOTE =
  "A business that has passed KYB and has an open account, and to which nobody has been added yet. Nothing is wrong. The first admin is created by Corgi ops at account opening, because a business's first admin cannot appoint themselves — team_add_member() refuses an author who does not already hold administer_team.";

export const ERROR_NOTE =
  "The team read failed. NOTHING WAS WRITTEN: this path only reads, and it never posts. Note what a failure means here versus on the authorisation path — a screen that cannot read the team shows this; the real-time authorisation decision, given the same failure, DECLINES, because a revocation that only holds while the database is reachable has not been made.";
