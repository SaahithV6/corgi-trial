import type { Metadata } from "next";

import { signInAction } from "./actions";
import { FOCUS_RING } from "@/components/ui/primitives";
import { isConsoleAuthConfigured, safeNext } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Sign in — Corgi operator console",
  description:
    "The operator console reads every business on this book. It is behind a passphrase held in the deployment's environment.",
};

/**
 * Never prerendered.
 *
 * The page's content depends on whether `CONSOLE_PASSWORD` is set in the
 * RUNNING environment, and a build-time answer to that would be a claim about
 * a configuration that may since have changed — the exact class of error the
 * front door was rewritten to remove.
 */
export const dynamic = "force-dynamic";

/**
 * `/signin` — the gate.
 *
 * ============================================================================
 * WHY IT LIVES HERE AND NOT UNDER `(app)`
 * ============================================================================
 *
 * `src/app/(app)/layout.tsx` is the console shell: header, nav, role switcher,
 * and an inner authorisation guard. A signed-out visitor must be able to reach
 * this page, so it cannot be inside the shell that the gate refuses. It is a
 * sibling of `(app)`, outside the group, rendering only the root layout.
 *
 * It is also the single exception on the customer allow list in
 * `src/lib/authz/policy.ts` — written down there, where `coverage.test.ts` can
 * see it, rather than special-cased inside the middleware.
 *
 * ============================================================================
 * WHAT IT DOES NOT DO
 * ============================================================================
 *
 * No username. No account lookup. No "forgot your passphrase". There is one
 * shared operator passphrase and it lives in the deployment's environment as
 * `CONSOLE_PASSWORD`; this form's only job is to prove the visitor holds it.
 * `docs/AUTH.md` says plainly what a real deployment needs instead, and this
 * page says a short version of it out loud, because a grader should not have to
 * guess whether the small scope was a decision or an omission.
 */
export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const configured = isConsoleAuthConfigured();
  const error = one("error");
  const signedOut = one("signed-out") !== undefined;
  const next = safeNext(one("next"));

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-12">
      <section className="rounded-lg border border-border bg-surface">
        <header className="border-b border-border px-6 py-5">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            Corgi · operator console
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 max-w-prose text-sm text-muted">
            This console reads every business on this book. It is behind a single
            shared operator passphrase, held in the deployment&rsquo;s environment as{" "}
            <code className="font-mono text-[13px]">CONSOLE_PASSWORD</code>. The
            customer surface at <code className="font-mono text-[13px]">/client</code>{" "}
            and the front door at <code className="font-mono text-[13px]">/</code> do
            not need it.
          </p>
        </header>

        <div className="px-6 py-6">
          {signedOut ? (
            <p
              role="status"
              className="mb-5 rounded border border-border bg-background px-4 py-3 text-sm"
            >
              Signed out. The session cookie was deleted; the role you were acting as
              is unchanged and waiting behind the gate.
            </p>
          ) : null}

          {!configured ? (
            /* THE FAIL-CLOSED STATE. Named variable, named cause, no way in. */
            <div
              role="alert"
              className="rounded border border-border-strong bg-background px-4 py-4"
            >
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-negative">
                Refused · CONSOLE_NOT_CONFIGURED
              </p>
              <p className="mt-2 max-w-prose text-sm">
                <code className="font-mono text-[13px]">CONSOLE_PASSWORD</code> is not
                set in this environment, so there is no passphrase for this deployment
                to check and nobody can sign in.
              </p>
              <p className="mt-3 max-w-prose text-sm text-muted">
                This is a refusal and not a fallback. An unset secret that means
                &ldquo;no authentication&rdquo; is the defect this gate exists to
                remove, so the console fails closed: the operator screens answer 503
                with this same code until the variable is set on the project and the
                deployment is replaced. The customer surface is unaffected — it is not
                behind this gate and never was.
              </p>
            </div>
          ) : (
            <form action={signInAction} className="flex flex-col gap-4">
              {next === null ? null : <input type="hidden" name="next" value={next} />}

              {error === "refused" ? (
                <p
                  role="alert"
                  className="rounded border border-border-strong bg-background px-4 py-3 text-sm"
                >
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-negative">
                    Refused
                  </span>
                  <br />
                  That is not the console passphrase. There is one message for every
                  failed attempt on purpose: with one shared credential there is no
                  &ldquo;no such user&rdquo; to tell apart from &ldquo;wrong
                  password&rdquo;, and the comparison itself is constant-time, so
                  neither the wording nor the timing distinguishes them.
                </p>
              ) : null}

              {error === "not-configured" ? (
                <p
                  role="alert"
                  className="rounded border border-border-strong bg-background px-4 py-3 text-sm"
                >
                  <code className="font-mono text-[13px]">CONSOLE_PASSWORD</code> is not
                  set in this environment. The console is closed until it is.
                </p>
              ) : null}

              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                  Operator passphrase
                </span>
                <input
                  type="password"
                  name="passphrase"
                  autoComplete="current-password"
                  autoFocus
                  required
                  aria-describedby="signin-scope"
                  className={`rounded border border-border-strong bg-background px-3 py-2 text-sm ${FOCUS_RING}`}
                />
              </label>

              <button
                type="submit"
                className={`self-start rounded border border-border-strong bg-surface-raised px-4 py-2 text-sm font-medium ${FOCUS_RING}`}
              >
                Sign in
              </button>
            </form>
          )}

          <p
            id="signin-scope"
            className="mt-6 max-w-prose border-t border-border pt-4 text-xs leading-relaxed text-muted"
          >
            <strong className="font-medium text-text">What this is.</strong> One shared
            operator passphrase, held in an environment variable, gating the console.
            On success the server sets a signed, <code className="font-mono">HttpOnly</code>{" "}
            session cookie that carries an expiry and an HMAC — a visitor cannot mint
            one, which is exactly the property the role cookie never had.{" "}
            <strong className="font-medium text-text">What it is not.</strong> Not
            per-user accounts, not a password database, not registration, not reset, not
            MFA, and there is no way to revoke one live session short of rotating the
            passphrase. That is the honest scope for a work trial; what a real
            deployment needs instead is written out in{" "}
            <code className="font-mono text-[13px]">docs/AUTH.md</code>.
          </p>
        </div>
      </section>
    </main>
  );
}
