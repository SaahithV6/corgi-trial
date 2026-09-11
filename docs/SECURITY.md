# Security — the scheduled-job boundary

> Scope note. This file is about ONE boundary: who is allowed to make a
> scheduled job run. It is not a full threat model of the system. It exists
> because that boundary was measured, found open, and closed, and the
> measurement is worth keeping.

---

## 1. The defect (D04x)

`/api/drain`, `/api/cron/standing`, `/api/cron/accrual`, `/api/cron/outbound`
and `/api/cron/holds` all authorised like this:

```ts
function authorised(req: Request): boolean {
  if (req.headers.get("x-vercel-cron")) return true;   // <—
  const secret = process.env.DRAIN_TOKEN;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}
```

`x-vercel-cron` is set by Vercel when the platform invokes a cron. It is not a
signature and carries no proof. The open question was only whether Vercel
strips a client-supplied copy at the edge. There was no `middleware.ts` in the
repo to strip it either.

**It does not strip it.** Measured, not reasoned about.

### 1.1 The measurement

Against the deployed origin `https://corgi-trial-psi.vercel.app` (commit
`5f330f4`), from an ordinary laptop on the public internet, 2026-09-11
~10:30 UTC. Nothing but `curl`, no credential of any kind.

**Control — no headers:**

```
$ curl -i https://corgi-trial-psi.vercel.app/api/drain
HTTP/2 401
x-vercel-id: sfo1::iad1::br8jn-1789122649384-f692ee7fa5a2
{"requestId":"sfo1::br8jn-...","error":{"code":"UNAUTHORISED",
 "message":"drain requires the cron header or a bearer token"}}
```

**The same request with one typed header:**

```
$ curl -i https://corgi-trial-psi.vercel.app/api/drain -H 'x-vercel-cron: 1'
HTTP/2 200
x-vercel-id: sfo1::iad1::nqs29-1789122655504-783ca65e7232
{"requestId":"sfo1::nqs29-...","claimed":21,"processed":0,"ignored":0,
 "parked":20,"retried":0,"deadLettered":1,"unparked":0,
 "consumers":["lithic-card","increase-ach","increase-wire","stripe-identity",
 "plaid-item"],"missingConsumers":[],"durationMs":3088,
 "creditsReleased":0,"creditSweepError":null}
```

Twenty-one inbox rows claimed and processed by an anonymous caller. The
platform passes the header through verbatim. The exposure is real, not
theoretical, and it was the full extent of the gate.

**And on a route that posts money**, without posting any. `/api/cron/accrual`
checks auth BEFORE it validates its input, so an invalid `bookDate` separates
"the gate opened" from "the tick ran". Two requests differing only in one
header:

```
$ curl -i '…/api/cron/accrual?bookDate=not-a-date' -H 'x-vercel-cron: 1'
HTTP/2 400
{"error":{"code":"INVALID_INPUT","message":"a business date is YYYY-MM-DD"}}

$ curl -i '…/api/cron/accrual?bookDate=not-a-date'
HTTP/2 401
{"error":{"code":"UNAUTHORISED",
 "message":"the accrual tick requires the cron header or a bearer token"}}
```

`400` is the auth gate open. The header alone got a stranger past the door of
the endpoint that posts journal entries against customer deposit accounts.

### 1.2 Why "it is idempotent" was not a defence

The drain's own header already said it: draining is idempotent by
construction — leases, `FOR UPDATE SKIP LOCKED`, idempotent consumers — so an
unauthenticated caller could not corrupt the book, and the route authenticated
anyway because free load is still a cost. That reasoning is right and it is not
the whole risk.

Two of the five **post money**:

- `/api/cron/accrual` appends a journal entry against a customer's deposit
  account with no human in between.
- `/api/cron/standing` raises payment instructions on the schedule's behalf.

Both are idempotent per `(schedule, date)`. Neither is *harmless*. A stranger
who can make a bank's scheduler run on demand does not change the arithmetic —
they change **when** it happens, and for an accrual and a standing order "when"
is half of what the thing is. Choosing the moment a fee is dated, or the moment
a rent payment is raised, is an attack that every individual posting survives
being individually correct. `/api/cron/holds` is the same shape: it releases
holds and posts through `ledger_append()`.

---

## 2. The fix

Three changes, in decreasing order of how much they matter.

### 2.1 The routes require a bearer token, always — `src/app/api/cron/_auth.ts`

`x-vercel-cron` grants nothing. It is not read as a credential anywhere in the
repo any more. Every scheduled route calls one function, and that function
accepts exactly one kind of proof: `Authorization: Bearer <secret>`, matching
either of two secrets, compared in constant time (both sides SHA-256'd to a
fixed 32 bytes first, so `timingSafeEqual` cannot throw on a length mismatch
and the throw cannot become a length oracle — the same shape `src/lib/mcp/
auth.ts` uses).

| Secret | Held by | Why it is accepted |
| --- | --- | --- |
| `CRON_SECRET` | Vercel | When this variable is set on the project, the platform sends `Authorization: Bearer $CRON_SECRET` on every cron invocation. **This is the verifiable version of the claim the header was making.** |
| `DRAIN_TOKEN` | a human | The existing operator credential. The demo, `scripts/coreloop.mjs`, `scripts/redrive.mjs` and the live-fire attack tests all present it. Keeping it means the fix costs the debrief nothing. |

It **fails closed**: if neither variable is set the answer is 401, not "well,
nothing is configured, so let it through". An unconfigured environment is not an
open one.

### 2.2 The header is deleted before a route can see it — `src/middleware.ts`

Defence in depth, and cheap. The matcher covers `/api/drain` and
`/api/cron/:path*`; on those paths `x-vercel-cron` is removed from the request
before the handler runs, so a future author who reaches for it cannot be fooled
by it either. The response carries `x-stripped-request-headers: x-vercel-cron`
when it fires, so the control is provable from outside with one `curl` rather
than only by reading the file and hoping the matcher matched.

**It strips unconditionally, because it cannot do otherwise.** Middleware runs
inside the deployment, after the platform's ingress has already added the
header for a genuine cron. A real invocation and a forged one are byte-identical
at that point. That is not a limitation of this file — it is the whole reason
the header was never evidence, restated as code.

Two things are deliberately **not** stripped: `x-vercel-id` (`requestIdFrom()`
uses it to keep a trace across the edge) and `x-vercel-forwarded-for`
(`src/lib/webhooks/refusals.ts` uses it to attribute a source IP). Both are
equally forgeable. Both are used only for observability and never for a grant,
and both are indistinguishable from the real thing here, so stripping them
would destroy real diagnostics to prevent a fake log line. See §5.

> `middleware.ts` is the deprecated name in Next.js 16 — the convention was
> renamed to `proxy.ts`. It still resolves (`next/dist/build/index.js` accepts
> both and emits a `warnOnce`; having *both* files is a hard error), and the
> running dev server confirms it: `⚠ The "middleware" file convention is
> deprecated. Please use "proxy" instead.` Renaming is a mechanical follow-up:
> `npx @next/codemod@canary middleware-to-proxy .`

### 2.3 The failure is loud — `scheduled.auth.refused`

The worst outcome of this fix is not a hole, it is five schedules that 401 in
silence for a week. So every refusal logs, and a refusal that carries
`x-vercel-cron` — i.e. one that looks like the platform's own cron being turned
away — logs at **ERROR** with a hint naming the variable to set:

```json
{"level":"error","event":"scheduled.auth.refused","job":"accrual",
 "reason":"NO_BEARER","looksLikePlatformCron":true,
 "cronCredentialConfigured":false,"operatorCredentialConfigured":true,
 "hint":"Vercel Cron only sends Authorization: Bearer $CRON_SECRET when
         CRON_SECRET is set on the project. Set it and redeploy, or this
         schedule will not run. See docs/SECURITY.md."}
```

`scheduled.auth.refused` with `looksLikePlatformCron: true` is the line to grep
for in the Vercel log if the outbound queue or the hold sweeps stop moving. A
stranger cannot manufacture that line, because the middleware removed the
header before the route ran.

The **response body** says only `"… requires a bearer token"`. Which secrets are
configured is a fact for the operator's log, not for the internet.

---

## 3. ⚠ DEPLOY REQUIREMENT — Saahith must set `CRON_SECRET`

**This is not optional and it is not already done.** `vercel env ls production`
on 2026-09-11 listed seventeen variables; `CRON_SECRET` was not among them.
Until it is set **and a new deployment is made**, Vercel Cron sends no
`Authorization` header at all, and all five schedules in `vercel.json` will
answer 401 for ever:

| Path | Schedule (UTC) | What stops if it 401s |
| --- | --- | --- |
| `/api/drain` | `17 4 * * *` | the inbound webhook inbox stops being guaranteed |
| `/api/cron/standing` | `23 5 * * *` | standing orders stop firing |
| `/api/cron/accrual` | `41 6 * * *` | fee/interest accrual stops posting |
| `/api/cron/outbound` | `53 7 * * *` | customer webhooks stop being delivered |
| `/api/cron/holds` | `11 8 * * *` | expired holds are never released |

### The two commands

Give `CRON_SECRET` the **same value `DRAIN_TOKEN` already has**. That needs no
new secret anywhere, changes no script, and keeps one credential for one
privilege class. Nothing below prints it:

```bash
cd ~/Documents/corgi-trial
set -a; . ./.env; set +a
printf '%s' "$DRAIN_TOKEN" | vercel env add CRON_SECRET production
vercel --prod          # env vars only reach a NEW deployment
```

A different random value works too — the routes accept either secret — at the
cost of a second thing to remember.

### Prove it without waiting for 04:17 UTC

A genuine cron request is exactly `Authorization: Bearer $CRON_SECRET`. So this
*is* the genuine path, sent by hand:

```bash
curl -i https://corgi-trial-psi.vercel.app/api/drain \
  -H "Authorization: Bearer $DRAIN_TOKEN"          # expect 200

curl -i https://corgi-trial-psi.vercel.app/api/drain \
  -H 'x-vercel-cron: 1'                            # expect 401
                                                   # + x-stripped-request-headers
```

---

## 4. Proof, both directions

Run locally against a real Next 16.3.4 server (an isolated copy of `src/`, with
`CRON_SECRET` and `DRAIN_TOKEN` both set), 2026-09-11.

**Forged header refused — all five routes, every one `401` and every one
carrying `x-stripped-request-headers: x-vercel-cron`:**

| Request | Before | After |
| --- | --- | --- |
| `GET /api/drain -H 'x-vercel-cron: 1'` | `200`, 21 rows claimed | `401` |
| `GET /api/cron/accrual?bookDate=not-a-date -H 'x-vercel-cron: 1'` | `400` (gate open) | `401` |
| `GET /api/cron/standing -H 'x-vercel-cron: 1'` | gate open | `401` |
| `GET /api/cron/outbound -H 'x-vercel-cron: 1'` | gate open | `401` |
| `GET /api/cron/holds -H 'x-vercel-cron: 1'` | gate open | `401` |
| `GET /api/drain -H 'x-vercel-cron: 1' -H 'authorization: Bearer wrong'` | `200` | `401` |

**Genuine invocation still works** — sent in the exact shape Vercel Cron uses,
`x-vercel-cron: 1` *plus* `Authorization: Bearer $CRON_SECRET`:

| Request | Result |
| --- | --- |
| `/api/cron/accrual?bookDate=not-a-date` | `400 INVALID_INPUT` — the gate opened, and no money was posted proving it |
| `/api/drain` | `200`, `claimed: 89, parked: 86, ignored: 1, deadLettered: 2` |
| `/api/cron/outbound` | `200`, `entriesScanned: 172, eventsCreated: 72` |
| `/api/cron/holds` | `200` (see §6) |
| `/api/drain` with `Bearer $DRAIN_TOKEN` and **no** cron header | `200` — the operator/demo path is unbroken |
| `/api/cron/standing` with `Bearer $DRAIN_TOKEN` | `200`, `considered: 0` — today's date already claimed, which is the idempotence working |

**Unit tests** — `src/app/api/cron/_auth.test.ts`, 12 cases, in `pnpm test`:
both credentials accepted; forged header alone refused; forged header plus a
wrong bearer refused; a near-miss token of identical length refused; the secret
outside the `Bearer` scheme refused; `NOT_CONFIGURED` fails closed even with the
header; and the middleware assertion that `x-vercel-cron` is absent from the
forwarded request while `x-vercel-id` and `authorization` survive.

**What was NOT proved by a real call:** the genuine path on the *deployed*
origin, because `CRON_SECRET` does not exist there yet and this change is not
deployed. §3 has the one `curl` that closes that gap the moment it is.

---

## 5. Adjacent, not fixed

`src/lib/webhooks/refusals.ts` ranks `x-vercel-forwarded-for` as "most trusted"
when attributing a source IP. It is client-forgeable for exactly the same
reason `x-vercel-cron` was. It is **not** the same severity — it grants nothing,
it only decides which IP a refusal is logged against — and it is in
`src/lib/**`, outside this change's write scope. Left alone deliberately, and
written down here rather than silently "fixed" by stripping a header that
genuine requests also carry.

---

## 6. Found while proving it: the hold sweep had never returned 200

`/api/cron/holds` answered `500 HOLD_SWEEP_FAILED: Do not know how to serialize
a BigInt` on the very first authenticated call. `ExpirySweepResult.releasedCents`
and `HoldCompletionSweepResult.withheldCents` are `bigint`, and the throw is
raised by `NextResponse.json` *inside* the `try`, **after both sweeps have
already committed**. So the job worked and reported failure — every night, on
every run, including when there was nothing to sweep, because `0n` is still a
BigInt. `/api/cron/accrual` and `/api/cron/standing` both narrow their bigints
to decimal strings at the edge; this route did not.

Fixed in the same change, since the route was already open on the bench and it
is squarely a scheduled-job defect: the route's own `catch` comment argues that
a silent 500 would look like a healthy book, and this was the exact inverse — an
alarm that cried wolf nightly on a job that was fine. It now returns
`200 {"completion":{…,"withheldCents":"0"},"expiry":{…,"releasedCents":"0"}}`.

---

## 7. Tenant-isolation audit of the API and MCP surfaces (attack pass)

> Scope. This section records an adversarial pass over every `/api/v1`
> endpoint, every MCP tool, and every customer server action, looking for the
> six failure classes in the brief: IDOR, enumeration oracles, injection,
> excess privilege, token-scope escape, and secret leakage. It was done by
> reading each path against the house standard — a SQL predicate carrying BOTH
> `id` and `business_id`, never a read-then-compare — and by read-only probes
> against the deployed origin. **No hole was found in `src/lib/api/**` or
> `src/lib/mcp/**`.** The items below are the residual risks worth naming; the
> two that are not already self-documented are outside this change's write
> scope and are reported for routing, not fixed here.

### 7.1 What holds (verified)

- **Scope comes only from the token.** Every `/api/v1` route and every MCP tool
  passes `ctx.grant.businessId` / `ctx.grant.actorId` into the gateway; none
  reads a business/account/actor id from the query, body, or a tool argument.
  `FORBIDDEN_QUERY_PARAMETERS` (http.ts) and the strict tool schemas
  (mcp/validate.ts, `additionalProperties:false`) refuse `business_id` etc. as
  unknown params rather than silently honouring them.
- **The gateway is the one boundary.** Every read in `mcp/gateway.ts` joins to
  `account` and filters `a.business_id = $businessId`; house accounts
  (`business_id IS NULL`, e.g. `1110`) are not addressable. `snapshot()` and
  `getPaymentRoute` re-check the resolved account's `business_id` against the
  grant even though the lookup was already scoped — belt-and-braces, not a
  read-then-compare that a later edit could drop.
- **No oracle.** A cross-tenant account code, payment id, quote ref, pot id or
  card id returns the SAME refusal as a nonexistent one (404 `ACCOUNT_NOT_FOUND`
  / `NO_SUCH_INSTRUCTION`, or the `NOT_YOURS` sentence). Bad/unknown/revoked
  tokens are byte-identical (`UNKNOWN_TOKEN`, "token is not recognised").
  Confirmed on prod: bogus bearer → 401 `UNKNOWN_TOKEN`.
- **No injection.** Every query is tagged-template `sql``` (parameterised);
  no `sql.unsafe`, no string interpolation into SQL, a URL, or a header
  anywhere in the two trees. The cursor is versioned base64url JSON, validated
  `^[0-9]{1,20}$` before `BigInt`, and a tampered cursor is refused rather than
  paged from the top.
- **Privilege.** No `UPDATE`/`DELETE`/`INSERT`/`TRUNCATE` SQL in either tree;
  writes go through `@/lib/approvals`' `requestPayment` (append-only,
  `corgi_app` INSERT). The only raw `journal_line`/`account` read outside
  `src/lib/ledger/` is the recon-breaks EXISTS predicate in `mcp/gateway.ts`,
  which is the documented, ratchet-allowlisted exception.
- **Token / write controls.** `findGrant` is constant-time (`timingSafeEqual`,
  no early break); auth fails closed with zero grants; `ABOVE_TOKEN_CEILING`
  and the `WRITE_LIMIT_PER_MINUTE` write budget are enforced in both `handle.ts`
  and `server.ts`; the actor must resolve to `kind='agent', can_approve=false`
  with a matching `business_id`.
- **Secrets.** `initiate_payment` / `POST /api/v1/payments` never accept a full
  account number (last-4 only); `redactArguments` masks account_number/iban/pan
  and drops token/secret/ssn keys before the audit line; card provider tokens
  are dropped in the gateway projection; the Plaid `access_token` wrapper
  (`toJSON()`→`[redacted]`) is used at its only two call sites in
  `rails/plaid/item-store.ts`.

### 7.2 Residual risks (reported, not fixed — outside write scope)

1. **[medium] Operator server actions rely on middleware pathname, not their
   own role check.** `src/middleware.ts` authorises on the request `pathname`.
   A Next.js server action POSTs to the *page the browser is on*, so an operator
   action invoked from a `/client/*` (customer-surface) path would clear the
   middleware role gate, and `layout.tsx`'s guard does not run for an action
   that renders no page (the file says so itself). The boundary therefore also
   depends on operator action IDs not being reachable from customer bundles.
   *Exploit (unverified — needs a valid operator action id):* as `role=customer`,
   `POST /client/pots` with an operator action's `Next-Action` header and body.
   *Fix:* have each operator server action re-derive `authorize(role, …)` from
   the cookie itself (defence in depth), or route operator actions through an
   operator-only endpoint. `src/middleware.ts`, `src/lib/authz/**` — not owned.
   I could not confirm exploitability within the window (would require a live
   mutation against another tenant).

2. **[low] Per-process rate limiter.** `mcp/ratelimit.ts` self-documents that
   buckets are per-lambda, so N warm instances permit N× the configured rate;
   `clientKey` trusts `x-real-ip`/`x-forwarded-for` (best-effort, not a
   boundary). Both are honest, pre-existing limitations. The real controls are
   the token, tenant scope, and the approval queue. Fix if it matters: a shared
   counter (Redis / bounded Postgres window).

### 7.3 What I could NOT test

- Live cross-tenant **mutation** (would require a valid token for another
  business and would write rows to the append-only ledger). All mutation
  reasoning is by code path, not by executing a write against a peer tenant.
- The §7.2.1 server-action vector end to end (needs an operator action id and a
  live POST; not attempted against production).
- Multi-instance rate-limit behaviour on the live deployment.
