# Authentication

**One shared operator passphrase, held in an environment variable, gating the
operator console.** That is the whole of it, and the scope is deliberate. This
document says what it does, what it does not do, and what a real deployment
would need instead — because an honest boundary beats a half-built identity
system, and a reader should not have to guess which one they are looking at.

---

## The gap this closes

Until now, `corgi_demo_role` was **a cookie a visitor sets on themselves**.

The authorisation boundary built on top of it is real and was never the
problem: default deny in `src/lib/authz/policy.ts`, enforced in
`src/middleware.ts` before any route or server action runs, re-derived by
`src/app/(app)/layout.tsx`, and re-derived again by 37 operator actions through
`src/lib/authz/action-guard.ts`. A customer is refused `/accounts` with a named
code, and that has been provable from outside with one `curl` for two days.

But every one of those decisions rested on a claim nobody verified. Anyone who
knew the cookie name was staff:

```
curl -H 'cookie: corgi_demo_role=staff' https://…/accounts   →  200, every business on the book
```

That was documented rather than hidden — `roles.ts` says "THIS IS
AUTHORISATION, NOT AUTHENTICATION" in a box at the top, `docs/DEMO.md` §1 said
"there is nothing to sign into" — and it was the last structural hole in the
build.

It is now closed. The same request answers:

```
HTTP/1.1 401 Unauthorized
x-corgi-authz: deny; SIGN_IN_REQUIRED
```

---

## What Saahith must set, and where

| Variable | Where | Required? | What happens without it |
| --- | --- | --- | --- |
| `CONSOLE_PASSWORD` | Vercel → Project → Settings → Environment Variables (Production, Preview) | **Yes, to open the console at all** | Every operator route answers **503 `CONSOLE_NOT_CONFIGURED`**. `/`, `/signin` and `/client/**` are unaffected. |
| `CONSOLE_SESSION_SECRET` | same place | No | The session signing key is derived from `CONSOLE_PASSWORD` instead. Setting an independent one is strictly better and a real deployment should. |

Set it, then **redeploy** — Next.js reads `process.env` in the running
deployment, and an existing deployment does not pick up a new variable.

There is exact precedent for this handover in this repo: `CRON_SECRET` is set
in Vercel and read by `src/app/api/cron/_auth.ts`. This follows the same shape
on purpose — a secret that only ever exists in the environment, a constant-time
comparison, and a refusal that says nothing about which secret is missing.

**The passphrase is not in this repository and must never be.** No literal, no
default, no `.env.example` sample value, no log line, no test fixture — the
tests generate a throwaway value per run with `randomUUID()`.

---

## How it works

### 1. `/signin` — the gate

`src/app/signin/page.tsx`, deliberately **outside** the `(app)` route group: a
signed-out visitor must be able to reach it, so it cannot live inside the shell
the gate refuses.

The form posts `signInAction` (`src/app/signin/actions.ts`), a server action, so
it works with JavaScript disabled — the same property the role switcher has and
the one `scripts/verify-demo.mjs` depends on.

The passphrase is compared **constant-time** in `src/lib/auth/password.ts`. Both
sides are hashed to a fixed 32 bytes first and then compared with
`timingSafeEqual`, because `timingSafeEqual` throws on a length mismatch and
catching that throw would itself be the length oracle. That is lifted verbatim
in shape from `src/app/api/cron/_auth.ts`, so this codebase has one habit here
rather than two.

**There is no oracle.** A wrong passphrase, a prefix of the right one, a longer
one and an empty submission all produce the same redirect and the same message.
There is nothing to distinguish "wrong password" from "no such user" because
there are no users.

### 2. The session cookie

On success the server sets `corgi_console`:

```
Set-Cookie: corgi_console=v1.<expiry-ms>.<nonce>.<hmac>; Path=/; Max-Age=28800;
            Secure; HttpOnly; SameSite=lax
```

* **Signed** — HMAC-SHA256 over `v1.<expiry>.<nonce>` under a server-only key.
* **`httpOnly`** — this is the load-bearing one and the whole difference from
  `corgi_demo_role`. A visitor cannot write it and a script on the page cannot
  read it, so the claim it carries is the server's and not theirs.
* **`secure`**, **`sameSite=lax`**, **8-hour expiry**.
* **It carries no secret.** The passphrase never reaches the browser.

The signature is verified **before** the expiry is parsed, so an unsigned token
never reaches the reading of a field it controls. An edited token — real
signature, expiry pushed out — fails as `BAD_SESSION`.

Verification uses `crypto.subtle`, not `node:crypto`, because
`src/middleware.ts` runs on the Edge runtime and the server action runs on Node,
and one verifier for one token is worth more than a synchronous API. A second
implementation would be a second answer to the same question.

### 3. The middleware gate

`src/middleware.ts` gained a third control, running **before** the role
decision, because *who are you* is answered before *may you*:

```ts
if (!pathname.startsWith("/api/") && surfaceOf(pathname) === "operator") { … }
```

**The gate's population is `surfaceOf() === "operator"` — the same default-deny
classification the authorisation boundary already uses.** That is the anti-rot
property, and it is the reason this is four lines rather than a list: a route
added tomorrow is operator *because it is not on the customer allow list*, so it
is gated tomorrow with nobody remembering anything.
`src/lib/authz/coverage.test.ts` pins the matcher against a filesystem walk of
`src/app`, so the gate cannot lose coverage silently either.

`/api/*` is out of scope, unchanged: those routes authenticate with a bearer
token or a provider signature, and a browser cookie is not what grants them.

### 4. What stays open, and why

`/`, `/signin` and the whole `/client` tree answer with no session.

This is a **hard constraint from the demo**, not an oversight. `docs/DEMO.md`
says the credential *is* the role switch and `scripts/verify-demo.mjs` §8 posts
that switch from `/` specifically, "so the switch works from the URL in the
email, before any navigation". A customer is not staff, and `/` is where the
switch lives.

So: **authentication gates the CONSOLE; role selection stays a switch *behind*
that gate.** One passphrase gets you in; the switch then chooses Staff,
Approver or Customer, exactly as before.

`/signin` is ungated by being the one addition to the customer allow list in
`src/lib/authz/policy.ts` — written down where `coverage.test.ts` checks it,
rather than special-cased inside the middleware where nobody would find it
again.

### 5. Fail closed

**An unset `CONSOLE_PASSWORD` closes the console. It does not open it.**

Every operator route answers 503 with `x-corgi-authz: deny;
CONSOLE_NOT_CONFIGURED` and a page that names the variable. `/signin` renders
the same refusal instead of a form, so there is nothing to submit.

This is not defensive decoration. An unset secret meaning "no auth" is exactly
the shape this repo has spent two days removing: `x-vercel-cron` was a header a
client could type and it was the whole gate on five money-moving routes. The
customer surface is deliberately unaffected — closing the console must not take
the product down.

### 6. Sign out, and who is signed in

`src/components/app-shell/SessionBadge.tsx` renders in the console header, next
to the role switcher, and says two different things on purpose:

* *"Acting as: Staff / Approver / Customer"* — **authorisation**, a claim about
  which principal to draw for.
* *"Signed in as operator · until HH:MM UTC"* — **authentication**, the fact
  underneath it.

Conflating those two is the misreading this whole change exists to remove.

**Sign out** deletes the session cookie and leaves `corgi_demo_role` alone: the
role cookie is not a credential, and clearing it would silently reset a grader's
demo state on a control that has nothing to do with authentication.

---

## What this is NOT

Said plainly, because the scope was a decision:

* **Not per-user accounts.** One shared passphrase. There is no "who signed in",
  only "someone holding the passphrase signed in". The audit trail's actor
  attribution still comes from `resolveActor()` and the seeded actors, and it
  was never driven by this cookie.
* **Not a password database.** No users table, no per-user hashing, no salt —
  because there is nothing to store. The single secret lives in the environment.
* **Not registration, not password reset, not invitations.**
* **Not MFA.**
* **Not session revocation.** There is no session store, so an individual
  session cannot be killed. Rotating `CONSOLE_PASSWORD` invalidates *every* live
  session at once, because the signing key is derived from it — that is the only
  revocation this build has, and it is why the expiry is 8 hours and is printed
  in the header rather than hidden.
* **Not rate limiting on the sign-in form.** The comparison is constant-time and
  gives away nothing, but nothing here slows an attacker down. `/api/mcp` has a
  rate limiter (`src/lib/mcp/ratelimit.ts`); this does not.
* **Not a change to the authorisation boundary.** `authorize()` and
  `surfaceOf()` are untouched; the customer allow list gained `/signin` and
  nothing else.

## What a real deployment needs instead

1. **Per-user identities** — a user record per operator, so "who approved this
   payment" is answered by the session rather than by a seeded actor predicate.
   The database already enforces maker-checker on the actor
   (`assert_maker_checker()`, SQLSTATE 42501); it just is not fed a real one.
2. **Hashed credentials** — argon2id or scrypt per user, never a shared secret
   and never a single environment variable that every operator knows.
3. **MFA** — TOTP at minimum, WebAuthn preferably, for anything that reads every
   business on a book or moves money.
4. **A session store, so sessions can be revoked** — individually, on password
   change, and on offboarding. A stateless signed token cannot be withdrawn
   before it expires, which is fine for eight hours of a trial and not fine for
   an employee who left this morning.
5. **SSO / SCIM** — in practice an operator console for a regulated business is
   behind the company IdP, with joiner-mover-leaver automated rather than
   remembered.
6. **Rate limiting and lockout** on the sign-in path, plus an alert on a burst of
   failures.
7. **An audit record of authentication itself** — sign-in, sign-out, failure,
   with source IP. This build audits what was *done*; it does not audit who
   *arrived*.
8. **Per-tenant customer authentication.** `/client` is currently reachable
   without any credential at all, and its tenant scoping comes from
   `WHERE business_id = $1` against a business the demo picks. A real customer
   surface needs the customer to sign in and the business id to come from their
   session, not from the route.

Point 8 is the largest remaining hole and it is named here rather than implied:
**this change authenticates the operator console and nothing else.**

---

## Proving it

Every one of these was run against a local production build with a throwaway
passphrase, and the outputs are in the change report.

```bash
# no cookie → refused, and told where to go
curl -i https://…/accounts
# → HTTP/1.1 401 Unauthorized ; x-corgi-authz: deny; SIGN_IN_REQUIRED ; body links /signin?next=%2Faccounts

# customer surface and the front door are unaffected
curl -o /dev/null -w '%{http_code}\n' https://…/ https://…/client https://…/signin
# → 200 200 200
```

The rest is covered by tests that run in CI with no secret:

* `src/lib/auth/session.test.ts` — 18 checks: round trip, forged signature,
  edited expiry, rotated passphrase, expired token, unset variable, cookie
  attributes, and the `?next=` open-redirect guard.
* `src/lib/authz/enforcement.test.ts` — the gate through the **real**
  `middleware()` export Next.js invokes: unauthenticated 401 whatever the role
  cookie says, forged and edited cookies refused, POSTs refused so a server
  action cannot run, `/` and `/client` never gated, a signed-in customer still
  403 `OPERATOR_ONLY`, and 503 with `CONSOLE_PASSWORD` unset.
* `src/lib/authz/coverage.test.ts` — unchanged and still passing; `/signin` is
  classified in `ROUTE_SURFACE`, so the register and the runtime agree.
* `scripts/verify-demo.mjs` — step 0 signs in with `$CONSOLE_PASSWORD` and every
  request after carries the session. It **fails**, loudly, if the variable is
  absent from the shell or from the deployment.
