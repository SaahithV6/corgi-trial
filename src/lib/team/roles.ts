/**
 * The role model. Four roles, four capabilities, one table.
 *
 * Nothing here imports a database, a provider client or `server-only`: it is
 * shared by the decision path (pure), the screens (server components), the
 * server actions and the tests.
 *
 * ─── WHY THESE FOUR ─────────────────────────────────────────────────────────
 *
 * Each one exists because a sentence of the brief requires it, and none exists
 * because a matrix looked asymmetric:
 *
 *   "Users need to see their balance."                  -> viewer
 *   "Users need to approve payments above a threshold." -> approver
 *   ...and a payment must be raised before it is approved  -> initiator
 *   ...and somebody holds the roles, the limits and the cards -> admin
 *
 * Four roles that are enforced beat twelve that are documented. Every
 * capability below is read by a database trigger (`assert_team_maker_checker`,
 * `assert_team_initiator`, `assert_team_member_version`) or by the real-time
 * authorisation decision. None of them is read only by a screen.
 *
 * ─── THIS TABLE IS A COPY, AND THE COPY IS CHECKED ──────────────────────────
 *
 * The authority is `team_role_can(role, capability)` in migration 0033, because
 * the triggers that actually refuse things are in SQL and cannot call
 * TypeScript. This file exists so a screen can grey out a button without a
 * round trip. Two copies of a permission matrix is exactly how a permission
 * system becomes decorative, so `team.integration.test.ts` asserts the two
 * agree CELL BY CELL against the live database — all sixteen cells, plus an
 * unknown capability, which must be false on both sides.
 */

/** The four roles, in increasing order of what they may do. */
export const TEAM_ROLES = ["viewer", "initiator", "approver", "admin"] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Membership state.
 *
 *   active     normal.
 *   suspended  reversible. Cards stop authorising; the person stays.
 *   removed    TERMINAL. No further version of these terms may be written.
 *              Their history stands, their outstanding authorisations still
 *              settle, and their card stops.
 */
export const MEMBER_STATES = ["active", "suspended", "removed"] as const;

export type MemberState = (typeof MEMBER_STATES)[number];

export const TEAM_CAPABILITIES = [
  "view_balance",
  "raise_payment",
  "approve_payment",
  "administer_team",
] as const;

export type TeamCapability = (typeof TEAM_CAPABILITIES)[number];

/**
 * The matrix. Mirrors `team_role_can()` in 0033 exactly.
 *
 * `admin` carries `approve_payment` deliberately, and the objection to that is
 * real: an administrator who can also approve holds unilateral control in a
 * one-admin business — they choose the approvers AND are one. Taking approval
 * away from admins does not fix it (the admin promotes a compliant subordinate
 * instead). It is fixed by the independence rule in `assert_team_maker_checker`:
 * an approval is refused when the initiator administers the approver. So an
 * admin's own above-threshold payment needs a PEER admin or a Corgi staff
 * approver, and a business with one admin must appoint a second before that
 * admin can move large money. See docs/TEAM.md §5.
 */
const MATRIX: Readonly<Record<TeamRole, readonly TeamCapability[]>> = {
  viewer: ["view_balance"],
  initiator: ["view_balance", "raise_payment"],
  approver: ["view_balance", "raise_payment", "approve_payment"],
  admin: ["view_balance", "raise_payment", "approve_payment", "administer_team"],
};

export function roleCan(role: TeamRole, capability: TeamCapability): boolean {
  return MATRIX[role].includes(capability);
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && TEAM_ROLES.some((r) => r === value);
}

export function isMemberState(value: unknown): value is MemberState {
  return typeof value === "string" && MEMBER_STATES.some((s) => s === value);
}

/** One sentence per role, for the screen. The same words the docs use. */
export const ROLE_SUMMARY: Readonly<Record<TeamRole, string>> = {
  viewer:
    "Sees the balance and the transactions. Raises nothing, approves nothing. The role a bookkeeper or an investor gets.",
  initiator:
    "Raises payments and holds a card. Cannot approve — the maker is never the checker, and that is a database constraint rather than a screen.",
  approver:
    "Raises payments and approves other people's. Still cannot approve their own: assert_maker_checker() refuses it.",
  admin:
    "Runs the team: adds members, sets roles and personal spend limits, removes people. Can also approve — but never a payment raised by somebody they administer.",
};

/**
 * The three states a member can be in, as a sentence about their card.
 *
 * The card is the part people ask about, so the summary is written from the
 * card's point of view rather than the membership's.
 */
export const STATE_SUMMARY: Readonly<Record<MemberState, string>> = {
  active: "Their card authorises inside their limits.",
  suspended:
    "Their card declines every purchase (rule member_suspended). Reversible: a later version of their terms turns it back on.",
  removed:
    "Terminal. Their card declines every purchase and is closed at the issuer. Nothing of theirs is deleted, and an authorisation that was outstanding when they were removed still settles.",
};
