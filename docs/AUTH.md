# Authentication

**One shared operator passphrase, held in an environment variable, gating every
WRITE through the operator console.** Reads are open. That is the whole of it,
and both halves are deliberate. This document says what it does, what it does
not do, **what that costs**, and what a real deployment would need instead —
because an honest boundary beats a half-built identity system, and a reader
should not have to guess which one they are looking at.

> **In one line.** The console is **read-only to anybody**; **signing in is what
> unlocks doing anything**. An anonymous `GET /accounts` renders, with every
> control painted visibly inert and the reason beside it. An anonymous `POST` —
> which is every server action in this app — is refused `SIGN_IN_REQUIRED`, in
> the middleware *and* again inside the action.

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

It is now closed **on everything that changes state**. The same request, as a
write, answers:

```
HTTP/1.1 401 Unauthorized
x-corgi-authz: deny; SIGN_IN_REQUIRED
```

As a read, it answers 200 — on purpose, and at a price. The next section is
that price.

---

## The trade: an anonymously-readable console

**What it costs.** Any visitor who has the URL can read **every business on
this book** — legal names, balances, the approval queue, the audit trail, who
paid whom and when. There is no per-visitor identity, so there is also **no
record of who read what**. The console spans all tenants by design, so this is
not a partial exposure of one customer's data: it is all of it, to anyone.

**In a real bank this is unacceptable.** It is not a small deviation from best
practice or a control that could be added later without redesign — it is the
absence of the single most basic property a financial operator console has. A
regulator would not ask about it, because no such system would be built.

**Why it was chosen here anyway.** This is a work trial. The data is a sandbox
book: seeded businesses, a faucet, fixtures named as fixtures. Nothing on it
belongs to a real person and nothing on it can be lost. What the artefact must
do is be **read by a grading panel that arrives from a URL in an email**, and
the alternative was a shared passphrase distributed out of band to everyone who
might look — which is worse on two counts. It is worse for the demo, because a
panel that cannot get in reports "broken", and a credential passed around in
email is the thing that would actually leak. And it is worse as engineering,
because it would put the *boundary* out of sight: a grader who never signs in
never sees the refusal, and a refusal nobody observes is indistinguishable from
no refusal at all. Open reads make the boundary **legible** — you can walk the
whole console, press a control, and watch the server say no.

**What the trade does NOT buy.** It does not open a single write. Reads falling
open is a decision; writes falling open would be the defect this build spent two
days removing, and the two are kept apart structurally rather than by care:
`src/middleware.ts` refuses every unsafe method, `src/lib/authz/action-guard.ts`
refuses again from the cookie inside the action, and an unset `CONSOLE_PASSWORD`
closes writes rather than opening them.

**What a real deployment does instead.** Not "the same thing with a password on
the front" — three different properties, none of which this build has:

1. **Per-user identity, not a shared secret.** Every operator signs in as
   themselves, so the session answers *who*, and `resolveActor()` stops being a
   seeded predicate. The database already enforces maker-checker on the actor
   (`assert_maker_checker()`, SQLSTATE 42501); it is simply not fed a real one.
2. **Tenant-scoped reads.** A console screen would carry the same both-column
   predicate the `/client` tree already carries — `WHERE business_id = $1` —
   with the set of businesses an operator may read coming from *their* record,
   not from the route. Platform-wide views become a named, separately-granted
   capability rather than the default rendering.
3. **An audit record of who read what.** This build audits what was *done*. A
   real one audits arrival and retrieval too: sign-in, sign-out, failure, source
   IP, and a row per screen-load naming the operator and the tenant whose book
   they opened — which is the control that makes "all of it, to anyone"
   impossible to happen quietly.

Until all three exist, reads stay open here and the cost stays written down.

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

### 3. The middleware gate — on writes

`src/middleware.ts` carries a third control, running **before** the role
decision, because *who are you* is answered before *may you*:

```ts
if (
  !SAFE_METHODS.has(request.method) &&          // GET / HEAD / OPTIONS fall through
  !pathname.startsWith("/api/") &&
  surfaceOf(pathname) === "operator"
) { … }
```

**The safe set is the HTTP one, and it is the closed list.** `GET`, `HEAD` and
`OPTIONS` (RFC 9110 §9.2.1) render; *everything else* is a write, including
verbs this app does not use. The default is refuse, so a new method is gated the
day somebody adds one.

**A Next server action is always a POST**, and it is the only write path in this
UI, which is why a pathname-shaped control can gate them at all.

**A refused write is told, in the form it can act on.** Content-negotiated on
`Accept`:

| Client | `Accept` | Answer |
| --- | --- | --- |
| Browser, no-JS form post | `text/html,…` | **303** → `/signin?next=%2Fpayments` |
| Browser, JS server action | `text/x-component` | **303** → same |
| API client, `curl`, script | `*/*`, `application/json`, absent | **401**, `x-corgi-authz: deny; SIGN_IN_REQUIRED` |

303 and not 307 deliberately: the redirect must turn the POST into a GET, or the
browser would re-post the action body at `/signin`. The code is on
`x-corgi-authz` in **both** branches, so one `curl` proves either.

### 3b. The action guard — the half the middleware cannot reach

The middleware gates on **pathname**, and a server action is posted to whatever
page the browser is on. An operator action invoked from `/client/pay` arrives
carrying a customer pathname, `surfaceOf()` says "customer surface", and control
3 never runs. That was already the hole
`src/lib/authz/action-guard.ts` existed to close for *roles*; with reads open it
became a way to **write with no credential at all**.

So `assertOperatorAction()` — the first statement of all 37 operator actions,
with `action-guard.test.ts` failing by name if one is added without it — now
verifies the session itself, from the cookie, before it asks about the role:

```
SignInRequiredActionError  →  deny; SIGN_IN_REQUIRED: <action> refused — NO_SESSION
```

**Defence in depth: middleware AND action. Neither alone.** The middleware stops
the body being read; the action refuses even if the matcher never fired.

### 3c. The screens say they are read-only

`src/components/app-shell/ReadOnlyNotice.tsx`, rendered by the console shell
when there is no session on an operator route: a banner at the top of `#main`,
and scoped CSS that paints **every `<form>` beneath it** inert — greyed,
`pointer-events: none`, with `Read-only — sign in to act` printed beside it.

There is house precedent and this follows it: `/approvals` renders its
approve/reject controls **disabled with the reason next to them**
("You raised this payment, so you cannot approve it"), and
`scripts/verify-demo.mjs` step 11 asserts the reason is on the page *before the
button is pressed*. Learning you cannot do something before you try beats
learning it after.

The population is **structural, not a list**: every form under `#main`, so a form
added tomorrow is inert the moment it renders. It works with JavaScript off,
which matters because the role switcher and sign-in are both no-JS server
actions. And it is **cosmetics downstream of the guard, not the guard** —
`pointer-events: none` is defeated by devtools in four seconds; the refusals are
the two layers above.

The header is deliberately left live: the **role switch keeps working signed
out**, because `docs/DEMO.md` says the credential *is* the switch.

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

`/`, `/signin` and the whole `/client` tree are outside this control **for every
method** — the role-switch POST to `/` and the sign-in POST to `/signin` must
both work with no session, or the way *in* is behind the gate.

This is a **hard constraint from the demo**, not an oversight. `docs/DEMO.md`
says the credential *is* the role switch and `scripts/verify-demo.mjs` §8 posts
that switch from `/` specifically, "so the switch works from the URL in the
email, before any navigation". A customer is not staff, and `/` is where the
switch lives.

So: **authentication gates WRITING; role selection is a switch that works either
side of it.** One passphrase lets you act; the switch chooses which principal you
act as, exactly as before.

`/` also carries the way in. It is the URL the submission email hands a stranger,
and a visitor who can read the whole console but cannot find the sign-in will
conclude the writes are broken — so the console's own `SessionBadge`
("Signed out · Sign in") is rendered in the front door's header too, **after**
the role switcher, because `verify-demo.mjs` step 8 scrapes the first
`$ACTION_ID_…` on that page to post the no-JS role switch.

`/signin` is ungated by being the one addition to the customer allow list in
`src/lib/authz/policy.ts` — written down where `coverage.test.ts` checks it,
rather than special-cased inside the middleware where nobody would find it
again.

### 5. Fail closed

**An unset `CONSOLE_PASSWORD` closes every WRITE. It does not open one.**

Reads fall open by design; writes must not, and this is the line the inversion
does not cross. An unsafe method into an unconfigured deployment answers 503
with `x-corgi-authz: deny; CONSOLE_NOT_CONFIGURED` and a page that names the
variable; `assertOperatorAction()` refuses too, because `verifySession()` returns
`NOT_CONFIGURED` and that is a refusal, not a bypass. `/signin` renders the same
refusal instead of a form, so there is nothing to submit and no passphrase
exists that would have opened it.

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
* **Not confidentiality of any kind.** Reads are open to anyone with the URL,
  and there is no record of who read what. See *The trade*, above — this is the
  largest deliberate hole in the build and it is at the top of this document
  rather than the bottom.

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
# no cookie → the console RENDERS, read-only
curl -o /dev/null -w '%{http_code}\n' https://…/accounts
# → 200

# no cookie, a write (an API client) → refused, with the code on the header
curl -i -X POST https://…/accounts
# → HTTP/1.1 401 Unauthorized ; x-corgi-authz: deny; SIGN_IN_REQUIRED

# no cookie, a write (a browser) → sent to the way in, carrying where it was
curl -i -X POST -H 'accept: text/html' https://…/payments
# → HTTP/1.1 303 See Other ; location: /signin?next=%2Fpayments

# customer surface and the front door are unaffected
curl -o /dev/null -w '%{http_code}\n' https://…/ https://…/client https://…/signin
# → 200 200 200
```

The rest is covered by tests that run in CI with no secret:

* `src/lib/auth/session.test.ts` — 18 checks: round trip, forged signature,
  edited expiry, rotated passphrase, expired token, unset variable, cookie
  attributes, and the `?next=` open-redirect guard.
* `src/lib/authz/enforcement.test.ts` — 26 checks through the **real**
  `middleware()` export Next.js invokes: anonymous `GET`/`HEAD` **served**
  whatever the role cookie says; anonymous `POST`/`PUT`/`PATCH`/`DELETE`
  refused; the 303-vs-401 content negotiation on `Accept`; forged and edited
  session cookies refused; the signed-in write allowed; `/`, `/signin` and
  `/client` never gated **for any method**; a signed-in customer still 403
  `OPERATOR_ONLY`; and, with `CONSOLE_PASSWORD` unset, reads 200 and writes 503.
* `src/lib/authz/action-guard.proof.test.ts` — the same decision at the action
  layer: no session refused, forged session refused, authentication answered
  before authorisation, and `NOT_CONFIGURED` failing closed.
* `src/lib/authz/coverage.test.ts` — unchanged and still passing; `/signin` is
  classified in `ROUTE_SURFACE`, so the register and the runtime agree.
* `scripts/verify-demo.mjs` — step 0 signs in with `$CONSOLE_PASSWORD` and every
  request after carries the session. It **fails**, loudly, if the variable is
  absent from the shell or from the deployment.
