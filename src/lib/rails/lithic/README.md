# Lithic card rail adapter

Sandbox-first adapter for Lithic's card rail. No SDK — `fetch` plus `node:crypto`.

| File | What it is |
|---|---|
| `types.ts` | Wire types for `Card`, `Transaction`, `TransactionEvent`, and the `LithicEventType` discriminated union. All money is integer cents (`number`). |
| `client.ts` | Typed calls: `createCard`, `getCard`, `listCards`, `simulateAuthorize`, `simulateClearing`, `simulateVoid`, `simulateReturn`, `getTransaction`, `listTransactions`, plus `normalizeTransaction()`. |
| `verify.ts` | `verifyLithicWebhook()` — Standard Webhooks (Svix) signature verification. |
| `ratelimit.ts` | Serial promise-queue rate limiter. Every simulate call goes through it. |
| `*.test.ts` | 61 tests: limiter timing and concurrency, signature verification, and `normalizeTransaction` against the exact measured sandbox numbers. |

Run them: `pnpm vitest run src/lib/rails/lithic`

Configuration is read **at call time**, never captured at import time:

```
LITHIC_API_KEY=<bare uuid from app.lithic.com/settings>   # required, server-side only
LITHIC_BASE_URL=https://sandbox.lithic.com/v1             # optional override
```

Auth is `Authorization: <key>` — the **raw** key. No `Bearer`, no `Basic`, no base64.

---

## The two traps

Both were found by measuring the live sandbox, not by reading the docs. Both are
the kind of thing that silently produces a wrong balance rather than an error.
They are why `normalizeTransaction()` exists.

### Trap 1 — `status` lies about the hold

`status` flips to `SETTLED` on the **first** clearing, while a partial hold is
still outstanding. Measured, amounts in cents:

| Step | `status` | `amounts.hold.amount` | `amounts.settlement.amount` |
|---|---|---|---|
| `authorize 1000` | `PENDING` | `-1000` | `0` |
| `clearing 600` | **`SETTLED`** | **`-400`** | `-600` |
| `clearing 300` (2nd) | **`SETTLED`** | **`-100`** | `-900` |
| `authorize 5000` then `clearing 7340` | `SETTLED` | `0` | `-7340` |
| `FINANCIAL_AUTHORIZATION 2500` | `SETTLED` | `0` | `-2500` |

Releasing a hold on `status === 'SETTLED'` — the obvious implementation, and
the one most people write — frees 400 cents that are still authorised and hands
the cardholder spending power they do not have.

`status` is a **message-flow marker**: "a clearing message arrived". It is not a
description of the money. The adapter exposes it as
`providerSaysSettled`, deliberately named so that reaching for it as a
hold-release predicate looks wrong at the call site.

**Use `hasOutstandingHold` / `holdCents` instead.**

### Trap 2 — `amounts.hold.amount` is signed negative

A 1000-cent debit hold reads `-1000`. So does the settlement figure. A naive
read gets both the direction and the magnitude of the money wrong, and `Math.abs`
sprinkled at the call sites is how that becomes inconsistent across a codebase.

`normalizeTransaction()` returns positive magnitudes (`holdCents`,
`settledCents`, each event's `amountCents`) with direction carried separately,
and preserves the raw signed provider fields under `raw` so the reconciliation
view can still show what Lithic actually said.

### The third, independent check

`normalizeTransaction()` also recomputes the hold from the event set alone:

```
H(E) = max( authorised(E) − released(E), 0 )
```

where `authorised` is the last `AUTHORIZATION_ADVICE` amount if any advice
exists (an advice **overrides** the amount — it is absolute, not a delta) and
otherwise the sum of the authorisations; `released` is the sum of the clearings,
reversals and expiries. This reproduces all five measured cases including the
over-capture, where it correctly clamps at 0 rather than going negative.

It is exposed as `eventDerivedHoldCents`, with `holdMatchesEvents` flagging
divergence. Two independent derivations of the same number, from a provider
that has already been caught contradicting itself once, is cheap insurance —
and when they disagree, that disagreement is the reconciliation signal.

```ts
const n = normalizeTransaction(await getTransaction(token));

if (n.hasOutstandingHold) { /* still holding n.holdCents */ }   // correct
if (n.providerSaysSettled) { /* releases 400 cents too early */ } // WRONG

if (!n.holdMatchesEvents) { /* provider view and event view diverged — break */ }
```

---

## Rate limits

Lithic limits by resource **and** by HTTP method. The sandbox simulate surface
is the tightest thing on the platform:

| Surface | Sandbox write | Sandbox read |
|---|---|---|
| `POST /v1/simulate/*` | **1 / second** | — |
| `POST /v1/cards` | 2 / second | 15 / second |
| everything else | 1 / second | 15 / second |

A breach returns `429` with `retry-after: 1`. Consequences that shape the code:

- An auth-then-clearing pair is two simulate writes and therefore **cannot take
  less than a second**. A fifty-transaction seed takes ≥100 seconds. That is
  structural; budget for it rather than trying to tune around it.
- `ratelimit.ts` serialises the admission decision inside a single promise
  chain, so concurrent callers cannot each observe an empty window and fire
  together. Admissions are FIFO, and a rejected task does not wedge the queue.
- The limiter paces request **starts**, matching how the provider counts, so a
  slow response does not silently shrink the effective rate.
- `client.ts` additionally retries a `429` twice, honouring `retry-after`, for
  the case where our window and Lithic's have drifted.
- **Scope**: the limiters are per-process, in-memory singletons. Under
  serverless fan-out the global rate becomes `instances × limit`. Run seeding
  and backfills as one long-lived process, and share the exported
  `simulateLimiter` rather than constructing a competing one.

Also worth knowing: Lithic's fair-use policy allows API key revocation
**without prior notice** for traffic inconsistent with legitimate development.
Do not loop-hammer the sandbox from CI.

---

## The void finding — `simulate/void` did not take effect

**What was measured.** `POST /v1/simulate/void` returned HTTP 200 with a
`debugging_request_id` and left the transaction `PENDING` with the hold
unchanged at `-3000`. No error, no event appended, no effect.

**What the docs say.** Only `token` is required. `amount` is optional with
`minimum: 0`, described as *"Amount (in cents) to void. Typically this will
match the amount in the original authorization, but can be less."* The endpoint
summary adds: *"Voids a pending authorization. If `amount` is not set, the full
amount will be voided. Can be used on partially voided transactions but not
partially cleared transactions."* The documented success code is **201**, not
the 200 we saw. `type` defaults to `AUTHORIZATION_REVERSAL`.

**Most likely cause, and it is not proven.** Lithic's own documentation sample
body is `{"amount": 0, "token": "..."}`, and the schema explicitly permits
`amount: 0`. A zero-amount void is a legitimate request that voids nothing and
succeeds — which is exactly a 200 with a debugging id and an unchanged hold.
Anything that serialises an absent amount as `0` or `null` — a client that
spreads `{ amount: params.amount }` with `params.amount === undefined` through
`JSON.stringify`, or a `?? 0` default — produces this silently.

**What this adapter does about it.**

1. `amount` is **omitted from the JSON entirely** when `amountCents` is
   undefined. Never `null`, never `0`.
2. `amountCents: 0` is **rejected client-side** with a `RangeError` explaining
   that omitting the field is how you void the full amount, so the no-op cannot
   happen by accident.
3. `simulateVoidAndVerify()` reads the transaction before and after, and returns
   `{ tookEffect, holdReleasedCents, before, after }`. **Check `tookEffect`, not
   the HTTP status.** It costs three rate-limited calls (~3s in sandbox), so it
   is for the seed script and for tests that assert a void worked — not the
   default path.

**Honest status: unresolved.** The fix above is a well-supported hypothesis, not
a confirmed one — it has not been re-run against the sandbox since the key is
held elsewhere. Until someone runs `simulateVoidAndVerify` and sees
`tookEffect: true`, **treat void as unproven on this rail** and say so in the
demo rather than implying it works.

Other possibilities not yet ruled out, in rough order of likelihood:

- The target transaction had already been partially cleared. The docs exclude
  that case explicitly ("not partially cleared transactions") and the sandbox
  may express the refusal as a successful no-op rather than a 422.
- Void processing is asynchronous beyond the wait used, and the re-read raced
  it. Cheap to rule out: re-read after ~5 seconds.
- `type: "AUTHORIZATION_EXPIRY"` behaves differently from the
  `AUTHORIZATION_REVERSAL` default. Worth one call to check; expiry always
  applies to the full pending amount, so it is also the more forgiving path.

**No production-shaped fallback exists.** `POST
/v1/transactions/{token}/expire_authorization` is documented as available to
Processor Gateway clients only, so it is not a self-serve substitute.

**The ledger does not depend on this.** A void is just another event in the
event set, and `H(E) = max(authorised − released, 0)` already treats
`AUTHORIZATION_REVERSAL` and `AUTHORIZATION_EXPIRY` as releasing. If the
provider never emits the event, the hold expires on Lithic's own 7-day timer;
nothing in the hold model is waiting on this endpoint.

---

## Idempotency

**Outbound.** `Idempotency-Key` is documented on `POST /v1/cards` and that is
the only place this adapter sends one by default (auto-generated per call).
Pass `options.idempotencyKey` — the ledger row id, not a random uuid — whenever
*your* process might retry the operation; an auto-generated key only protects
against a retry inside a single `createCard` call.

The simulate endpoints do **not** document idempotency support. Do not pretend
otherwise: a retried `simulate/authorize` creates a second transaction. Guard
those at the caller, with a unique key in Postgres written before the call and
reconciled after, rather than relying on the provider.

**Inbound.** `webhook-id` is the idempotency key. It is stable across Lithic's
entire retry schedule (immediate → +5s → +5m → +30m → +2h → +5h → +10h → +10h,
8 attempts, then dropped), so duplicate delivery is normal operation, not an
error. Unique-index it. A subscription failing continuously for 5 days is
auto-disabled.

---

## Webhook verification

Lithic uses **Standard Webhooks** — the official `lithic-node` SDK imports
`standardwebhooks` and calls `wh.verify(body, headers)`. `verify.ts` is a
dependency-free reimplementation of exactly that scheme, so it is byte
compatible with Svix. The same headers and algorithm cover Auth Stream Access
and Tokenization Decisioning.

```
signedContent = `${webhook-id}.${webhook-timestamp}.${rawBody}`
key           = base64Decode(secret without the "whsec_" prefix)
expected      = base64(HMAC_SHA256(key, utf8(signedContent)))
valid         iff some space-delimited `v1,<sig>` entry constant-time-equals expected
              AND |now − timestamp| ≤ 300s
```

Three things to get right:

- **`rawBody` must be the bytes as received** — `await req.text()` on the App
  Router. `req.json()` followed by `JSON.stringify` changes the bytes and every
  signature fails, in a way that looks like a secret problem. The canonical test
  vector's body is `{"test": 2432232314}`; the space after the colon is
  load-bearing, and `verify.test.ts` asserts that re-serialising it fails.
- **Multiple signatures are normal.** `webhook-signature` is space-delimited and
  carries entries for both keys during a rotation (the old secret stays valid
  for 24h). Any single matching `v1` entry is sufficient; other versions are
  skipped rather than failed.
- **The key is the base64-**decoded** secret body**, not the string.

Correctness is proved rather than asserted: `STANDARD_WEBHOOKS_TEST_VECTOR` is
the canonical vector, and its signature
`v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=` is the same string Lithic
prints in its own multi-signature example. `runStandardWebhooksSelfTest()` runs
it inline; `verify.test.ts` covers valid, tampered, re-serialised, wrong-secret,
wrong-version, missing-header, stale, future-dated, and rotated multi-signature
cases.

A structurally unusable secret **throws** (`LithicWebhookSecretError`) instead
of returning a rejection. A missing `LITHIC_WEBHOOK_SECRET` must not present as
"every webhook is a forgery" while the handler quietly drops live traffic.

---

## Other things that bite

- **`merchant_currency` requires `merchant_amount`.** Measured: sending the
  currency alone is rejected with `'merchant_currency' requires that
  'merchant_amount' is set`. And omitting the currency is worse — the simulator
  accepts only USD/GBP/EUR and **defaults to GBP**. `simulateAuthorize` always
  sends both, with `merchant_amount` mirroring `amount` unless overridden.
- **A decline still returns a `token`.** The presence of a token in the
  `simulate/authorize` response does not mean approved. Read the resulting
  transaction's `status` / `result`.
- **`POST /v1/cards` returns 200; the simulate endpoints return 201.** Do not
  write `status === 201` checks across the board. The client checks `res.ok`.
- **Sandbox returns the full PAN and CVV**; production does not unless you are
  PCI-DSS compliant, and `GET /v1/cards` (list) returns the non-PCI shape in
  both. `pan`/`cvv` are optional on the `Card` type for that reason. Only the
  simulate path may read `pan`. Persist `token` and `last_four`.
- **`SINGLE_USE` cards close after one successful auth** and will silently break
  a multi-step lifecycle demo. Use `VIRTUAL`.
- **Default $5,000/day transaction limit** on non-ASA sandbox accounts. Raise it
  with `PATCH /v1/accounts/{account_token}` (amounts in cents).
- **`pending_amount` does not exist on the card `Transaction`.** It lives on the
  separate Financial Transaction resource. On this object the equivalent is
  `amounts.hold.amount`. Pick one view and stay in it.
- **Enrolling an ASA responder endpoint changes `simulate/authorize` semantics**
  — the simulator will then call your endpoint and require valid JSON back. A
  broken ASA endpoint breaks otherwise-working simulations. Enrol it last, and
  keep the disenroll call handy.
- **No force post exists.** There is no `/v1/simulate/force_post`, and
  `simulate/clearing` requires a prior authorisation token, so the sandbox
  cannot originate an unmatched clearing. `FINANCIAL_AUTHORIZATION` is the
  closest real behaviour: single-message, settles immediately, no hold — the
  same no-hold-to-release path. See DECISIONS.md 004.
