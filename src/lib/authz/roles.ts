/**
 * The principals this build can act as, and nothing else.
 *
 * ============================================================================
 * THIS IS AUTHORISATION, NOT AUTHENTICATION.
 *
 * There is still no password, no session store and no sign-up: `docs/DEMO.md`
 * §1 says "there is nothing to sign into" and that is still true. The cookie
 * below says WHO THIS SESSION CLAIMS TO BE. It is a demo credential and anyone
 * can type it.
 *
 * What changed is the layer underneath. Until now the claim decided only what
 * the console DREW: `/client` was a view of the same all-businesses console,
 * and the same session that rendered the customer surface could open
 * `/accounts` and read every business on the book. The per-business `WHERE
 * business_id = $1` predicates in `src/app/(app)/client/live-source.ts` were
 * correct and scoped nothing that a user actually clicks, because the layer a
 * user clicks had no boundary in it at all.
 *
 * Now the claim decides what the SERVER WILL SERVE, and it decides it in one
 * place (`policy.ts`), by default deny. Swapping the demo credential for a
 * verified session claim is one function — `readRole()` in
 * `src/components/app-shell/role.ts` stops reading a cookie and starts reading
 * a signed subject — and every caller below it is unchanged, because no caller
 * reads the cookie itself.
 * ============================================================================
 *
 * Pure on purpose: no `next/headers`, no `server-only`, no database. It is
 * imported by the Edge middleware, by a server layout, by a client component
 * and by the tests, and all four must get the same answer.
 */

/**
 * Three principals, and the third is a different KIND of thing from the first
 * two.
 *
 * `staff` and `approver` are both Corgi employees; the difference between them
 * is maker-checker (§16), which the DATABASE enforces via
 * `assert_maker_checker()`. Neither is a tenant boundary and neither was ever
 * meant to be.
 *
 * `customer` is a tenant. It is scoped to one business and it may not read the
 * operator console at all. That is the boundary this module exists for.
 */
export const ROLES = ["staff", "approver", "customer"] as const;

export type Role = (typeof ROLES)[number];

/** Corgi employees. Both may read the whole book; see `policy.ts`. */
export const OPERATOR_ROLES: readonly Role[] = ["staff", "approver"];

export const ROLE_COOKIE = "corgi_demo_role";

export const ROLE_LABEL: Record<Role, string> = {
  staff: "Staff",
  approver: "Approver",
  customer: "Customer",
};

export const ROLE_SUMMARY: Record<Role, string> = {
  staff:
    "Can read every balance and prepare money movement. Cannot approve it: §16 puts maker-checker on money out, and the maker is never the checker.",
  approver:
    "Can approve outbound payments and close manual holds. Cannot approve anything they prepared themselves.",
  customer:
    "A business banking with Corgi. Sees their own balance, activity, cards, pots, disputes and payments — and nothing else. Every operator screen refuses this principal on the server, with the code OPERATOR_ONLY.",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.some((role) => role === value);
}

/** True for a Corgi employee. False for a customer and for anything unknown. */
export function isOperator(role: Role): boolean {
  return OPERATOR_ROLES.includes(role);
}

/**
 * The role carried by a raw `Cookie:` header value.
 *
 * Here rather than in `role.ts` because the middleware has a `NextRequest` and
 * no `cookies()`, and a second parser would be a second answer to the same
 * question. Anything unrecognised is the LEAST privileged operator role, which
 * is what this build has always defaulted to — see `readRole()`.
 */
export function roleFromCookieValue(value: string | undefined): Role {
  return isRole(value) ? value : "staff";
}
