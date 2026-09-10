"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { ROLE_COOKIE, isRole } from "@/components/app-shell/role";

/**
 * Switch the demo role.
 *
 * A server action rather than client state, so the role survives a reload and
 * a deep link, and so the switch works with JavaScript disabled — the switcher
 * is a plain `<form>` with two submit buttons.
 *
 * See the warning in `role.ts`: this cookie is a demo affordance. It selects
 * what the console *shows*; it must never be what the server *believes* when a
 * payment is approved.
 */
export async function setRoleAction(formData: FormData): Promise<void> {
  const requested = formData.get("role");
  const role = isRole(requested) ? requested : "staff";

  const store = await cookies();
  store.set(ROLE_COOKIE, role, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30,
  });

  revalidatePath("/", "layout");
}
