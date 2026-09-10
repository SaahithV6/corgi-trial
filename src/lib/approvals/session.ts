/**
 * Which actor the console is writing as.
 *
 * ============================================================================
 * THIS IS DEMO IDENTITY. IT IS NOT AUTHENTICATION.
 *
 * `src/components/app-shell/role.ts` says it plainly and says it first: the
 * role cookie is a demo affordance, and a cookie the browser can set is not an
 * access-control decision. It ends with the instruction this module exists to
 * honour — "when approvals ship, the approver check must be re-derived
 * server-side from the session and this cookie must not be trusted for it."
 *
 * So here is exactly what the cookie does and does not do.
 *
 * DOES: choose which of the seeded demo actors this session is acting as. That
 * is a demo control, equivalent to logging in as a different person.
 *
 * DOES NOT: grant anything. The actor id resolved here is passed to the
 * database, and the database decides. Switching to `approver` and pressing
 * approve on your own payment gets you SQLSTATE 42501 from
 * `assert_maker_checker()`, not an approval. Editing the cookie by hand cannot
 * produce an actor with `can_approve = true` that is not already one of the
 * seeded rows, because the resolution below is a SELECT with a WHERE clause,
 * not a value read out of the cookie.
 *
 * WHAT REPLACES IT: one function. `resolveActor()` stops reading a role and
 * starts reading a verified session claim — a subject id from a signed token —
 * and looks the actor up by that. Every caller is unchanged, because every
 * caller already treats the returned id as an assertion the database will
 * check rather than as permission.
 * ============================================================================
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { readRole, type Role } from "@/components/app-shell/role";

import type { ActorKind } from "./types";

export type SessionActor = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ActorKind;
  readonly canApprove: boolean;
  readonly role: Role;
};

type ActorRow = {
  readonly id: string;
  readonly display_name: string;
  readonly kind: ActorKind;
  readonly can_approve: boolean;
};

/**
 * Resolve the demo role to a seeded actor.
 *
 * Selected by PREDICATE, not by name. `approver` is "a human staff actor who
 * holds approval rights"; `staff` is "a human staff actor who does not". If the
 * seed renames Dana Okonkwo the console keeps working, and — more to the point
 * — the query cannot be steered into returning an actor that does not satisfy
 * the predicate, whatever arrives in the cookie.
 *
 * `business_id IS NULL` scopes both to Corgi staff. The customer's own signer
 * (Alex Whitfield, scoped to Ridgeline) is deliberately not reachable from this
 * switcher: a bank employee and a customer signer are different principals and
 * conflating them in a demo is how a demo teaches the wrong model.
 */
export async function resolveActor(role: Role, conn: Sql = sql): Promise<SessionActor | null> {
  const rows = await conn<ActorRow[]>`
    SELECT id, display_name, kind::text AS kind, can_approve
      FROM actor
     WHERE kind = 'human'
       AND business_id IS NULL
       AND can_approve = ${role === "approver"}
     ORDER BY display_name
     LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    canApprove: row.can_approve,
    role,
  };
}

/** The actor for the current request's role cookie. */
export async function currentActor(conn: Sql = sql): Promise<SessionActor | null> {
  return resolveActor(await readRole(), conn);
}

/**
 * The autonomous surface that raises instructions — the actor the MCP write
 * tool authenticates as.
 *
 * Exposed here so the approvals screen can name it beside a payment the agent
 * raised. It is `kind = 'agent'`, so `actor_only_humans_approve` makes it
 * impossible for this row to hold `can_approve`, and no code path — including
 * this one — can hand it approval rights.
 */
export async function agentActor(conn: Sql = sql): Promise<SessionActor | null> {
  const rows = await conn<ActorRow[]>`
    SELECT id, display_name, kind::text AS kind, can_approve
      FROM actor WHERE kind = 'agent' ORDER BY display_name LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    canApprove: row.can_approve,
    role: "staff",
  };
}
