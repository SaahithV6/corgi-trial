import { cookies, headers } from "next/headers";

import { SESSION_COOKIE, SIGN_IN_PATH, verifySession } from "@/lib/auth/session";
import { surfaceOf } from "@/lib/authz";

import { FOCUS_RING } from "../ui/primitives";

/**
 * THE CONSOLE SAYS IT IS READ-ONLY, RATHER THAN LETTING YOU FIND OUT ON CLICK.
 *
 * ============================================================================
 * THE HOUSE PRECEDENT
 * ============================================================================
 *
 * `/approvals` renders its approve and reject controls DISABLED, with the
 * reason printed beside them — "Acting as Priya Raman, who holds no approval
 * rights", "You raised this payment, so you cannot approve it" — and
 * `scripts/verify-demo.mjs` step 11 asserts exactly that: the reason is on the
 * page *before the button is pressed*. The argument there is that learning you
 * cannot do something before you try is better than learning it after, and it
 * applies unchanged to a signed-out visitor reading the console.
 *
 * So a stranger does not get a console of live-looking buttons that answer 303
 * on click. They get the console, visibly inert, with one line saying why and
 * the way in.
 *
 * ============================================================================
 * WHY CSS AND NOT A PROP ON EVERY CONTROL
 * ============================================================================
 *
 * There are thirty-odd form components under `src/components/**`, owned by
 * several people, and threading a `readOnly` prop through all of them would be
 * the failure this repository has catalogued thirty times: a guard whose
 * POPULATION is chosen by hand, one control at a time, by the person least
 * likely to be thinking about it. A form added tomorrow would look live.
 *
 * The population here is instead STRUCTURAL — every `<form>` beneath `#main`,
 * which is every server action on the screen, because a Next server action is
 * submitted by a form and there is no other write path in this UI. A form
 * added tomorrow is inert the moment it renders, with nobody remembering
 * anything. That is the same argument `policy.ts` makes for default deny, one
 * layer up in the DOM.
 *
 * It works with JavaScript off, which matters: the role switcher and the
 * sign-in form are both no-JS server actions and `verify-demo.mjs` drives them
 * that way, so a client-side sweep would be a control that is absent for
 * exactly the client this build tests with.
 *
 * ============================================================================
 * IT IS COSMETICS DOWNSTREAM OF THE GUARD. IT IS NOT THE GUARD.
 * ============================================================================
 *
 * `NavLinks.tsx` says the same thing about hiding a link and it is worth
 * repeating here, because a styled-out button is even easier to mistake for a
 * boundary than a missing link. `pointer-events: none` is defeated by the
 * devtools in about four seconds. The actual refusals are `src/middleware.ts`
 * control 3 (the POST never reaches the route) and
 * `src/lib/authz/action-guard.ts` (the action refuses from the cookie even if
 * the middleware's pathname check was bypassed). This only stops the chrome
 * from advertising a capability the server will refuse.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY LEFT LIVE
 * ============================================================================
 *
 * Everything in the header, because the header is not under `#main`: the ROLE
 * SWITCHER keeps working signed out — `docs/DEMO.md` says the credential IS
 * the switch and `verify-demo.mjs` steps 8 and 9 post it — and so does the
 * sign-in link. Links are left live everywhere, because a link is a read and
 * reading is the thing this page is now for.
 */

/** The attribute the rules below hang off. Set by `src/app/(app)/layout.tsx`. */
export const READ_ONLY_ATTRIBUTE = "data-console-readonly";

/**
 * Is this request looking at an operator screen with no session?
 *
 * Re-derived from the cookie rather than read off a header the middleware set,
 * for the reason `SessionBadge` gives: a component that trusts a header is a
 * component a matcher gap can lie to. `verifySession` is cheap and it is the
 * same call the middleware makes.
 *
 * The pathname header is the one thing it cannot re-derive — a server
 * component has no URL — so its ABSENCE is treated as operator, which is the
 * safe direction: an unknown screen is painted read-only rather than live.
 */
export async function consoleIsReadOnly(): Promise<boolean> {
  const pathname = (await headers()).get("x-corgi-pathname");
  if (pathname !== null && surfaceOf(pathname) === "customer") return false;

  const store = await cookies();
  return !(await verifySession(store.get(SESSION_COOKIE)?.value)).ok;
}

/**
 * The banner, and the rules that make the controls beneath it look refused.
 *
 * Rendered as the first child of `#main` so it is the first thing read on the
 * screen, above the figures it is qualifying.
 */
export async function ReadOnlyNotice() {
  const pathname = (await headers()).get("x-corgi-pathname");
  const next =
    pathname === null || pathname === ""
      ? SIGN_IN_PATH
      : `${SIGN_IN_PATH}?next=${encodeURIComponent(pathname)}`;

  return (
    <>
      {/*
        Scoped to the attribute, so nothing here can leak onto a signed-in
        render: when the layout does not set `data-console-readonly="true"`,
        every selector below matches nothing.

        `:not([data-readonly-exempt])` is the escape hatch for a control that
        is genuinely a read — a GET filter form, say. Nothing uses it on the
        operator surface today; it exists so that the answer to "this one form
        is not a write" is an attribute with a name a reviewer can grep for,
        rather than an exception carved into these selectors later.
      */}
      <style>{`
        [${READ_ONLY_ATTRIBUTE}="true"] #main form:not([data-readonly-exempt]) {
          position: relative;
        }
        [${READ_ONLY_ATTRIBUTE}="true"] #main form:not([data-readonly-exempt]) button,
        [${READ_ONLY_ATTRIBUTE}="true"] #main form:not([data-readonly-exempt]) select,
        [${READ_ONLY_ATTRIBUTE}="true"] #main form:not([data-readonly-exempt]) textarea,
        [${READ_ONLY_ATTRIBUTE}="true"] #main form:not([data-readonly-exempt]) input:not([type="hidden"]) {
          opacity: 0.45;
          cursor: not-allowed;
          pointer-events: none;
          filter: grayscale(1);
        }
        [${READ_ONLY_ATTRIBUTE}="true"] #main form:not([data-readonly-exempt])::after {
          content: "Read-only — sign in to act";
          display: block;
          flex-basis: 100%;
          margin-top: 0.375rem;
          font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--color-muted, #57534e);
        }
      `}</style>

      <section
        role="status"
        aria-label="This console is read-only"
        className="mb-6 rounded-lg border border-border-strong bg-surface px-5 py-4"
      >
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          Read-only · not signed in
        </p>
        <h2 className="mt-1.5 text-sm font-semibold tracking-tight">
          You can read every screen in this console. You cannot change anything.
        </h2>
        <p className="mt-2 max-w-prose text-sm text-muted">
          The controls below are painted inert on purpose, because a button that
          looks live and fails on click is worse than one that says why first —
          the same rule the approvals queue follows when it disables a decision
          nobody may take. Every write is refused by the server whatever this
          page draws:{" "}
          <code className="font-mono text-[13px]">SIGN_IN_REQUIRED</code>, in the
          middleware before the route runs and again inside the action itself.
        </p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          The role switch in the header keeps working either side of this — it
          chooses which principal the console draws for, and it never was the
          credential. Reads being open to anyone is a deliberate trade for a work
          trial and it is written out, with what it costs, in{" "}
          <code className="font-mono">docs/AUTH.md</code>.
        </p>
        <p className="mt-3">
          <a
            href={next}
            className={`inline-block rounded border border-border-strong bg-surface-raised px-3 py-1.5 text-sm font-medium ${FOCUS_RING}`}
          >
            Sign in to act
          </a>
        </p>
      </section>
    </>
  );
}
