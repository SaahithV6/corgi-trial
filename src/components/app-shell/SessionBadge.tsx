import { cookies } from "next/headers";

import { signOutAction } from "@/app/signin/actions";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

import { FOCUS_RING } from "../ui/primitives";

/**
 * Who is signed in, and the way out.
 *
 * ============================================================================
 * WHY THE HEADER SAYS TWO DIFFERENT THINGS NOW
 * ============================================================================
 *
 * `RoleSwitcher` next to this says "Acting as: Staff / Approver / Customer".
 * That is an AUTHORISATION control and it always was — a claim the session
 * makes about which principal to draw for.
 *
 * This says "Signed in", and it is the AUTHENTICATION fact underneath it: a
 * session cookie on this request carried a valid HMAC under a key only the
 * server holds. The two are deliberately rendered as different things, because
 * conflating them is exactly the misreading this build spent two days removing
 * — for a long time the role cookie LOOKED like a credential, and a header
 * that showed only "Acting as Staff" invited a reader to believe it was one.
 *
 * ============================================================================
 * IT IS AN INDICATOR, NOT A GUARD
 * ============================================================================
 *
 * `src/middleware.ts` already refused this request if there was no valid
 * session — before this component, before the layout, before the page. So the
 * signed-out branch below is normally unreachable on an operator screen, and
 * it exists for the same reason `RefusalScreen` does: this component also
 * renders on `/client`, which is NOT behind the gate, and on that surface
 * "signed out" is the honest and expected answer.
 *
 * It re-derives rather than trusting a header, because a header is a thing the
 * middleware sets and a component that reads one is a component that can be
 * lied to by a matcher gap. `verifySession` is cheap and it is the same call
 * the middleware makes.
 */
export async function SessionBadge() {
  const store = await cookies();
  const verdict = await verifySession(store.get(SESSION_COOKIE)?.value);

  if (!verdict.ok) {
    return (
      <span className="flex items-center gap-2 text-[11px] text-muted">
        <span
          aria-hidden="true"
          className="inline-block size-1.5 rounded-full bg-border-strong"
        />
        <span>
          Signed out
          {verdict.reason === "EXPIRED_SESSION" ? " — the session expired" : ""}
        </span>
        <a href="/signin" className={`underline underline-offset-2 ${FOCUS_RING}`}>
          Sign in
        </a>
      </span>
    );
  }

  /**
   * The expiry is printed because there is no revocation in this build and a
   * session that simply stops working is a worse surprise than one whose end
   * was on screen the whole time. `docs/AUTH.md` names revocation as one of
   * the things a real deployment needs and this does not have.
   */
  const expires = new Date(verdict.expiresAt).toISOString().slice(11, 16);

  return (
    <form action={signOutAction} className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <span
          aria-hidden="true"
          className="inline-block size-1.5 rounded-full bg-positive"
        />
        <span>
          Signed in as <span className="font-medium text-text">operator</span>
        </span>
        <span className="hidden sm:inline" title="Sessions last 8 hours and cannot be revoked individually; rotating CONSOLE_PASSWORD ends all of them.">
          · until {expires} UTC
        </span>
      </span>
      <button
        type="submit"
        className={`rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-muted hover:text-text ${FOCUS_RING}`}
      >
        Sign out
      </button>
    </form>
  );
}
