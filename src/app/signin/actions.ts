"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  SESSION_COOKIE,
  SESSION_COOKIE_CLEARED,
  SESSION_COOKIE_OPTIONS,
  SIGN_IN_PATH,
  mintSession,
  safeNext,
} from "@/lib/auth/session";
import { verifyPassphrase } from "@/lib/auth/password";

/**
 * Sign in, and sign out.
 *
 * ============================================================================
 * THIS MODULE EXPORTS ASYNC FUNCTIONS AND NOTHING ELSE.
 *
 * A `"use server"` module may only export async functions — every export is
 * compiled into a callable endpoint, and a constant exported from one of these
 * files is a build error that presents as a broken page. That cost this repo
 * `/team` for hours. So the strings and the cookie options live in
 * `@/lib/auth/session` and are imported here.
 * ============================================================================
 *
 * A server action rather than a route handler, for two reasons. The form works
 * with JavaScript disabled, which is the same property the role switcher has
 * and the same property `scripts/verify-demo.mjs` depends on. And adding a
 * `route.ts` under `src/app` would put a new endpoint in front of
 * `ScreenLinks.test.ts`'s filesystem walk for no gain.
 */

/**
 * Check the passphrase and, if it holds, set the session cookie.
 *
 * Every failure path ends at `/signin` with a code in the query string and
 * NOTHING ELSE. In particular there is no message distinguishing "wrong
 * passphrase" from "no such operator", because there are no operators to have:
 * one shared passphrase, one refusal, no oracle. The one thing that IS
 * distinguished is `not-configured`, and that is a property of the deployment
 * rather than of the submission — it tells an administrator what to fix and
 * tells an attacker only that the console is shut.
 */
export async function signInAction(formData: FormData): Promise<void> {
  const presented = formData.get("passphrase");
  const next = safeNext(
    typeof formData.get("next") === "string" ? String(formData.get("next")) : undefined,
  );
  const query = next === null ? "" : `&next=${encodeURIComponent(next)}`;

  // A missing or non-string field is still compared, against the empty string,
  // so a malformed submission takes the same path and the same time as a wrong
  // one rather than returning early on a shape check.
  const verdict = verifyPassphrase(typeof presented === "string" ? presented : "");

  if (!verdict.ok) {
    redirect(
      verdict.reason === "NOT_CONFIGURED"
        ? `${SIGN_IN_PATH}?error=not-configured${query}`
        : `${SIGN_IN_PATH}?error=refused${query}`,
    );
  }

  const token = await mintSession();
  if (token === null) {
    // Unreachable while `verifyPassphrase` has returned ok — both read the same
    // variable — but it is not asserted away. A null token means no signing key
    // and therefore no session; the only safe answer is the closed one.
    redirect(`${SIGN_IN_PATH}?error=not-configured${query}`);
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);

  redirect(next ?? "/accounts");
}

/**
 * Sign out: delete the session cookie.
 *
 * The role cookie is deliberately LEFT ALONE. It is not a credential and never
 * was — it selects which principal the console draws for, and clearing it
 * would silently reset a grader's demo state on a control that has nothing to
 * do with authentication. Signing out removes the thing that was verified;
 * the switch keeps whatever it was set to, behind the gate, for next time.
 */
export async function signOutAction(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", SESSION_COOKIE_CLEARED);
  redirect(`${SIGN_IN_PATH}?signed-out=1`);
}
