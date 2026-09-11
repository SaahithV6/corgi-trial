import { cookies } from "next/headers";

import { ROLE_COOKIE, roleFromCookieValue } from "@/lib/authz";

/**
 * The demo roles, and the one function that reads which one this session claims.
 *
 * ============================================================================
 * WHAT CHANGED, AND WHY THE WARNING BELOW IS NOW ONLY HALF TRUE
 * ============================================================================
 *
 * This file used to open: "This is a DEMO AFFORDANCE, NOT AN AUTHORISATION
 * BOUNDARY… Nothing on this screen writes, so nothing here is load-bearing."
 *
 * That was an accurate description of a two-role console where both roles were
 * Corgi staff. It stopped being adequate the moment `/client` shipped, because
 * a customer surface with no customer principal is not a boundary at all — and
 * on production `f33a288` it wasn't: `/client` rendered links to all sixteen
 * operator screens and every one of them served the same session.
 *
 * So there is now a third role, `customer`, and it IS load-bearing for
 * authorisation. What has NOT changed, and must not be misread:
 *
 *   THE COOKIE IS STILL NOT AUTHENTICATION. Anyone can type it. It says which
 *   principal this session CLAIMS to be; it does not verify the claim, because
 *   this build has no sign-in (`docs/DEMO.md` §1) and building one was
 *   explicitly out of scope.
 *
 *   IT STILL GRANTS NOTHING ON A WRITE. `resolveActor()` selects a seeded actor
 *   by PREDICATE and the database decides — approving your own payment is
 *   SQLSTATE 42501 from `assert_maker_checker()` whatever the cookie says.
 *
 *   WHAT IT NOW DOES is RESTRICT. `customer` cannot reach an operator screen,
 *   and that decision is made in `@/lib/authz` — once — and enforced in
 *   `src/middleware.ts` and again in `src/app/(app)/layout.tsx`. A restriction
 *   driven by an unverified claim is safe in a way a grant is not: the worst a
 *   forged cookie can do here is lock its own sender out.
 *
 * When a real session ships, ONE function changes: `readRole()` stops reading a
 * cookie and starts reading a verified subject claim. Every caller is unchanged
 * because no caller reads the cookie itself.
 * ============================================================================
 *
 * The definitions live in `@/lib/authz/roles.ts` rather than here, because the
 * Edge middleware needs them and this module imports `next/headers`. They are
 * re-exported from this path so that every existing importer is unchanged and
 * there is still exactly one list of roles in the build.
 */
export {
  ROLES,
  ROLE_COOKIE,
  ROLE_LABEL,
  ROLE_SUMMARY,
  isOperator,
  isRole,
  type Role,
} from "@/lib/authz";

import type { Role } from "@/lib/authz";

/**
 * The role this session is acting as. Defaults to the least privileged.
 *
 * "Least privileged" means `staff` and not `customer`, which looks backwards
 * for one second and is not: a customer is a *different tenant*, not a lower
 * rank, and defaulting a stranger into somebody's tenant would be a worse
 * answer than defaulting them into the read-only operator role this demo has
 * always opened in. `scripts/verify-demo.mjs` §7 pins that default.
 */
export async function readRole(): Promise<Role> {
  const store = await cookies();
  return roleFromCookieValue(store.get(ROLE_COOKIE)?.value);
}
