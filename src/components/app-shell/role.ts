import { cookies } from "next/headers";

/**
 * The two demo roles.
 *
 * §16 of the ledger design puts maker-checker on money out: the person who
 * initiates a payment is never the person who approves it. The console has to
 * make that visible, so it has two roles and shows plainly which one you are
 * acting as.
 *
 * ============================================================================
 * This is a DEMO AFFORDANCE, NOT AN AUTHORISATION BOUNDARY.
 *
 * A cookie the browser can set is not an access-control decision. The real
 * check belongs on the server, against a session claim, at the point of the
 * write — inside the route handler that moves money, not in a render. Nothing
 * on this screen writes, so nothing here is load-bearing; when approvals ship,
 * the approver check must be re-derived server-side from the session and this
 * cookie must not be trusted for it.
 * ============================================================================
 */
export const ROLES = ["staff", "approver"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_COOKIE = "corgi_demo_role";

export const ROLE_LABEL: Record<Role, string> = {
  staff: "Staff",
  approver: "Approver",
};

export const ROLE_SUMMARY: Record<Role, string> = {
  staff:
    "Can read every balance and prepare money movement. Cannot approve it: §16 puts maker-checker on money out, and the maker is never the checker.",
  approver:
    "Can approve outbound payments and close manual holds. Cannot approve anything they prepared themselves.",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.some((role) => role === value);
}

/** The role this session is acting as. Defaults to the least privileged. */
export async function readRole(): Promise<Role> {
  const store = await cookies();
  const raw = store.get(ROLE_COOKIE)?.value;
  return isRole(raw) ? raw : "staff";
}
