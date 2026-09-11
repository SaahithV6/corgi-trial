import "server-only";

/**
 * The two questions every write on this surface has to answer before it does
 * anything, and the only place either is answered.
 *
 *   1. WHO IS ACTING?      An active admin of THIS business — resolved from the
 *                          database, never from the form.
 *   2. IS THIS ROW THEIRS? A member id off a form is a claim worth nothing.
 *
 * ===========================================================================
 * BOTH ARE PREDICATES, NOT FILTERS
 * ===========================================================================
 *
 * `WHERE business_id = $1 AND state = 'active' AND role = 'admin'` and
 * `WHERE member_id = $1 AND business_id = $2` are evaluated by Postgres before
 * a row exists to be filtered. Neither is a `.find()` over a list read earlier.
 * A filter is a step in a program and steps get reordered or dropped by whoever
 * next edits the paging logic; a predicate cannot be got wrong by a later edit
 * because there is no later step. `src/app/(app)/client/pots/actions.ts` makes
 * exactly this argument about pot ids and this file holds the same line for
 * member ids.
 *
 * ===========================================================================
 * THE SAME SENTENCE FOR "NOT REAL" AND "NOT YOURS"
 * ===========================================================================
 *
 * `ownedMember()` returns `null` for both, and the callers say one thing for
 * both. Telling them apart would turn these forms into an oracle for which
 * member ids exist on the platform — the same refusal
 * `setClientCardControlsAction` makes about card ids, for the same reason.
 *
 * ===========================================================================
 * THE RE-READ IS THE POINT
 * ===========================================================================
 *
 * A display name used for type-to-confirm comes from `ownedMember()`, which is
 * a fresh SELECT inside the action — never from a hidden input in the same
 * request that supplied the name to match. A confirmation checked against
 * something the attacker also sent is not a confirmation.
 */

import { sql, type Sql } from "@/lib/ledger/db";
import { isMemberState, isTeamRole, type MemberState, type TeamRole } from "@/lib/team/roles";

import type { ActingAdmin } from "@/components/client/team/contract";

type AdminRow = {
  readonly member_id: string;
  readonly actor_id: string;
  readonly display_name: string;
  readonly role: string;
};

/**
 * The admin this surface acts as.
 *
 * DETERMINISTIC: the longest-standing active admin, ordered by when they joined
 * and then by membership sequence, so the same business resolves to the same
 * person on every request and a receipt naming them is reproducible. Ties are
 * impossible in practice and broken by `membership_seq` anyway.
 *
 * `null` is a real, rendered state: a business whose first admin has not been
 * created yet by Corgi ops. A business cannot appoint its own first
 * administrator — that is the bootstrapping problem `team_add_member()`'s staff
 * branch exists to solve — so the screen says so and refuses every write.
 */
export async function resolveActingAdmin(
  businessId: string,
  conn: Sql = sql,
): Promise<ActingAdmin | null> {
  const rows = await conn<AdminRow[]>`
    SELECT member_id, actor_id, display_name, role
      FROM v_team_member
     WHERE business_id = ${businessId}::uuid
       AND state = 'active'
       AND role = 'admin'
     ORDER BY joined_at, membership_seq
     LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  if (!isTeamRole(row.role)) return null;
  return {
    memberId: row.member_id,
    actorId: row.actor_id,
    displayName: row.display_name,
    role: row.role,
  };
}

export type OwnedMember = {
  readonly memberId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly role: TeamRole;
  readonly state: MemberState;
  readonly actorCanApprove: boolean;
};

/**
 * The member named by a form, IF they are on this business's team.
 *
 * Both columns in one predicate. A member id belonging to another customer
 * produces the same `null` as one that names nothing at all.
 */
export async function ownedMember(
  memberId: string,
  businessId: string,
  conn: Sql = sql,
): Promise<OwnedMember | null> {
  const rows = await conn<
    {
      readonly member_id: string;
      readonly actor_id: string;
      readonly display_name: string;
      readonly role: string;
      readonly state: string;
      readonly actor_can_approve: boolean;
    }[]
  >`
    SELECT member_id, actor_id, display_name, role, state, actor_can_approve
      FROM v_team_member
     WHERE member_id = ${memberId}::uuid
       AND business_id = ${businessId}::uuid`;
  const row = rows[0];
  if (row === undefined) return null;
  // A text column out of Postgres is a claim until it is checked. The CHECK
  // constraint in 0033 means only four roles and three states can be in these
  // columns, so this can only fire if the schema and this file have drifted —
  // and a row we cannot parse must be refused, never rendered as the least
  // privileged thing we understand.
  if (!isTeamRole(row.role) || !isMemberState(row.state)) return null;
  return {
    memberId: row.member_id,
    actorId: row.actor_id,
    displayName: row.display_name,
    role: row.role,
    state: row.state,
    actorCanApprove: row.actor_can_approve,
  };
}
