# RESILIENCE — what happens when every provider fails

The brief's live-fire item is *"turn off your issuing provider's webhooks for
five minutes mid-demo and ask what the customer sees."* This document answers
that question for every provider and every failure mode, and it distinguishes
three things that are easy to blur:

- **what the code does** — measured or read, with a file and a line;
- **what the customer is told** — the actual sentence on the actual screen;
- **whether that sentence is true.**

The third column is the one that matters. A system that fails closed and then
tells the customer "everything is fine" has not failed safely; it has lied.

Scope: `src/lib/rails/**` and `src/lib/webhooks/**`. Findings outside that
boundary are reported, not fixed, and are marked **[not mine]**.

---

## 0. The live-fire measurements

Run against the real sandboxes on 2026-09-11 with this repo's own credentials.
This is what the providers actually do, not what their docs say they do.

| probe | result |
| --- | --- |
| Lithic, revoked credential | `HTTP 401`, `{"message":"Please provide an API key in the form 'Authorization: [api-key]'"}` |
| Lithic, valid credential, unknown path | `HTTP 404`, `{"message":"Not Found"}` |
| Increase, revoked credential | `HTTP 401`, RFC 9457 body, `"type":"invalid_api_key_error"`, `"reason":"no_credential"` |
| Increase, valid credential, unknown path | `HTTP 404`, `"type":"api_method_not_found_error"` |
| Plaid, revoked secret | **`HTTP 400`**, `"error_code":"INVALID_FIELD"` |
| Base Sepolia RPC, unsupported method | **`HTTP 403`**, `{"error":{"code":-32601,"message":"rpc method is unsupported"}}` |
| Base Sepolia RPC, non-JSON request body | **`HTTP 400`**, `{"error":{"code":-32700,"message":"parse error"}}` |

Three of these are the interesting ones, and each broke an assumption in the
code:

1. **Plaid does not answer 401 for a bad credential. It answers 400.** Any
   classifier that reads "401/403 ⇒ credential problem, other 4xx ⇒ our bug"
   gets Plaid exactly backwards. `src/lib/rails/plaid/client.ts:373` survives
   this by keying on Plaid's own `error_code` rather than on the status, and
   `src/lib/rails/adapters/openbanking.ts:133-140` special-cases Plaid's 400 as
   `unauthorised` instead of using the shared `livenessFromStatus` rule that
   treats 400 as "live". Both are correct, and both are correct *by having been
   written deliberately*, not by accident.
2. **The RPC node puts its JSON-RPC error behind a non-2xx status.** This broke
   the stablecoin client. See §5, defect 1 — it was a double-payment-adjacent
   bug and it is fixed.
3. **A 403 from the node does not mean "forbidden".** It meant "this node does
   not implement that method" (`-32601`), which is permanent and never worth a
   retry, while a 503 is. Classifying on the HTTP status alone conflates them.

---

## 1. Timeout — the ASA path

This is the sharpest case in the system because it is **synchronous**: Lithic
holds the authorisation open, and at **6000 ms it declines on our behalf** and
stamps the transaction `CUSTOMER_ASA_TIMEOUT`. It does not approve. There is no
version of this where being slow costs the customer money.

The budget is one file, `src/lib/cards/budget.ts` **[not mine]**:

```
PROVIDER_TIMEOUT_MS      = 6000   // Lithic's hard ceiling
PROVIDER_RECOMMENDED_MS  = 3000   // the SLO
SECRET_FETCH_BUDGET_MS   =  400
CONTROL_READ_BUDGET_MS   =  600
DECISION_APPEND_BUDGET_MS=  400
HANDLER_BUDGET_MS        = 1400   // the sum
```

`budget.test.ts` asserts `PROVIDER_TIMEOUT_MS === 6000` and
`HANDLER_BUDGET_MS * 2 < PROVIDER_TIMEOUT_MS`, so the headroom is a test, not a
hope.

### What happens at 5999 ms

**Nothing, because nothing watches a 6000 ms clock.** The guards are per-step
and much tighter, and the one that fires in practice is the 600 ms control
read. At 601 ms `readControlsAndSpend` returns — as a *value*, not a throw —
`{ status: "unavailable", detail: "…exceeded its 600 ms budget" }`, and
`decide()` rule 1 declines:

```
outcome: "decline"
result:  "VELOCITY_EXCEEDED"
rule:    "control_store_unavailable"
judged:  false
reason:  "The card control store did not answer inside its deadline, so the
          controls on this card could not be honoured. This system declines
          rather than guesses."
inputs:  { fail_mode: "closed", detail: … }
```

`VELOCITY_EXCEEDED` is chosen because Lithic's `asa-response.result` enum has no
"issuer system unavailable" member and this is the one decline the network
documents as acquirer-retryable. That is a deliberate, commented choice, not a
convenient default.

**The customer sees that sentence verbatim.** `CardsView.tsx` renders
`decision.reason` directly and prints `decision.rule` beside it; there is no
rule-to-sentence lookup table anywhere in the build, so the sentence the
customer reads is the sentence `decide()` composed inside the window. **True.**

### What happens at 6001 ms

The honest answer: **we do not answer, and Lithic declines on expiry.** The
route carries `maxDuration = 5`, so a pathological invocation is killed by the
platform at ~5000 ms and emits a `FUNCTION_INVOCATION_TIMEOUT` 504 — not a
decline we chose. Lithic reads the 5xx as retryable and, failing that, declines
at 6000 ms.

> **Finding (reported, not fixed — `src/app/api/webhooks/lithic-auth/route.ts`
> is not mine).** The comment at `route.ts:88-92` claims `maxDuration = 5`
> exists so a pathological case "dies inside Lithic's 6000 ms window with a
> decline we chose, rather than at the platform's own limit". Hitting
> `maxDuration` **is** dying at the platform's own limit, and it yields a 504,
> not a chosen decline. The claim is one step stronger than the code supports.
> The code is fine; the sentence should be corrected.

### Is the decline recorded as ours or theirs?

**Structurally, and that turns out to be the strongest available answer.**

- A decline *we* made writes a `card_auth_decision` row carrying `rule`,
  `reason`, `judged` and `inputs`.
- A decline *Lithic* made on timeout writes **no such row** — we never reached a
  verdict. It surfaces on the other lane, `card_auth_event_result.result`, as
  Lithic's verbatim string: `UNKNOWN_HOST_TIMEOUT`. The live book holds one.

So "row present" = ours, "no row, and an event result" = theirs. This matters
more than it looks, because `docs/CARD-CONTROLS.md:295-307` records a measured
case where a genuine fail-closed decline of ours appeared on *Lithic's* side as
`DECLINED / USER_TRANSACTION_LIMIT / ["CARD_SPEND_LIMIT_EXCEEDED"]` — identical
to Lithic's own spend-limit firing. **The provider's record cannot always tell
you which system declined. `card_auth_decision` is the only place that can.**

> **Gap (reported).** `detailed_results` — the array actually carrying
> `CUSTOMER_ASA_TIMEOUT` — is typed at `src/lib/rails/lithic/types.ts:287`
> (mine) but never persisted; the write side is `src/lib/holds/lithic-events.ts`
> **[not mine]**. So the string that names a Lithic timeout decline is a
> measured fact in our docs and never a stored one. One column on
> `card_auth_event_result` would close it.

### The park that looks like a bug and is not

If the handler is slow but does eventually finish — say at 7 s — it still writes
a decision row, possibly `approve`, for an authorisation Lithic already declined
at 6000 ms. Nothing reconciles that divergence today. It is bounded (the row is
`judged: false` reasoning over stale inputs) and it is visible (the latency is
on the row), but it is a real seam and it is named here rather than left to be
found.

---

## 2. Timeout — everything else

Every outbound client has an `AbortController` or `AbortSignal.timeout`. The
defaults, and what comes back:

| client | budget | on timeout |
| --- | --- | --- |
| `lithic/client.ts:180` | 15 s | **bare `AbortError`** — see defect 3 |
| `increase/client.ts:922` | 15 s | `RailError` `network_error`, `retryable: true` |
| `plaid/client.ts:334` | 15 s | `RailError` `network_error`, `retryable: true` |
| `stablecoin/client.ts:87` | 15 s | `RpcError` naming the method |
| `circle-client.ts:123` | 20 s | `CircleError` with **`status: 0`** |
| `wire/client.ts:145` | 30 s | `RailError` `network_error`, `retryable: true` |
| `adapters/probe-http.ts:39` | 4 s | `{ res: null, err }` — never throws |

`circle-client.ts` is the one to copy. `status: 0` means *we do not know* —
explicitly distinct from a 401, and `circle-provider.ts:422` branches on it.
A timeout is not a decline; a system that cannot tell them apart will eventually
report one as the other.

`wire/client.ts` is deliberately 30 s, twice the others, and the reasoning at
`:192-209` is the best-documented timeout decision in the repo — a Fedwire
origination cannot be recovered, so giving up early is the expensive mistake.

> **Finding (reported).** In `wire/client.ts:212-223` a `TimeoutError` from
> `AbortSignal.timeout` and a caller-initiated abort from `opts.signal` are
> indistinguishable — both become `network_error, retryable: true`. A user
> closing a page therefore produces an error claiming a Fedwire origination is
> safe to retry. Narrow, but it is the irrevocable rail.

> **Finding (reported).** `plaid/client.ts:334` creates the `AbortController`
> *before* `limiter.run()` (`:339`). The 8/sec limiter serialises admissions, so
> the 15 s clock starts while the request is still queued — under burst the
> timeout can fire before the request is ever issued, producing a spurious
> `network_error`. `lithic/client.ts:196` avoids this by creating the controller
> inside the limiter.

---

## 3. 5xx and malformed response

### The cross-cutting finding: nothing retries a 5xx

`RailError.retryable` is **write-only**. Every client computes it carefully:

```
$ grep -rn "\.retryable\b" src --include=*.ts | grep -v "retryable:" | grep -v .test.ts
src/lib/rails/types.ts:546:    this.retryable = opts.retryable;
```

Nothing reads it. The only retry machinery in the repo is
`webhooks/dispatch.ts`, and it covers *inbound* events, not outbound calls. The
sole exception is Lithic's 429-only loop (`lithic/client.ts:224`, 2 attempts).

This is defensible — every mutating call carries an idempotency key, so an
*operator* can retry safely, and automatic retry of a money instruction is a
decision that should be made deliberately rather than inherited from a library.
But `retryable` currently documents an intention the system does not act on, and
a reviewer could easily read it as a guarantee. Say it out loud or wire it up.

Idempotency keys, for the record: Increase sends `clientReferenceId`
(`:920`); Wire sends `instruction.clientReferenceId` (`:327`); Circle generates
one per mutating call and returns it to the caller (`:295/:320/:351`); Lithic
builds headers once *outside* the retry loop (`:183-190`) so its 429 replay
carries the same key; Plaid has no idempotency concept at all and
`exchangePublicToken` is explicitly marked non-retryable. The stablecoin path
substitutes determinism: same nonce ⇒ same signed bytes ⇒ same tx hash, known
*before* broadcast, which is why `adapter.ts` can treat "already known" as
success rather than as a rejection.

### Malformed responses: zod validates none of this

`zod` is a dependency, used in `env.schema.ts`, `mcp/` and the server actions.
There is **zero zod under `src/lib/rails/` or `src/lib/webhooks/`**. The four
bank rails do `return JSON.parse(text) as T` and trust it. The only real
response-shape validation in the whole rails tree is hand-rolled and lives in
`stablecoin/` — `hex.ts:27 quantity()` and `circle-types.ts:150 record()/str()`.

`quantity()` is the model to copy: every number from the chain comes through one
door that rejects anything not matching `/^0x[0-9a-f]+$/i`, so a node returning
`null`, `"0"` or a decimal string produces a named error at the boundary instead
of a `NaN` four frames later.

Where a malformed body *is* handled well: `increase/client.ts:966-974` and
`plaid/client.ts:390-398` both raise a named `malformed_response`,
`retryable: true`. Where it is not, see §5.

---

## 4. Signature failure, duplicate delivery, out-of-order

These three are the part of the system that was already right, and the reason is
that each is enforced by a structure rather than by a branch.

### Raw body before parse — verified

The route handler's entire body is `await ingestWebhook(provider, req, …)`, and
`ingestWebhook` calls `await req.text()` as its first statement, verifies the
signature over those exact bytes, and only then calls `parseVerifiedJson(raw)`.
Nothing in `route-handler.ts` touches `req.json()`. Because the App Router body
is a **one-shot stream**, the ordering is not enforced by a comment or a review
— once `ingestWebhook` has consumed it, nothing downstream *can* re-read or
re-serialise it. The function is named `parseVerifiedJson` precisely so that
calling it early reads wrong.

This matters because `JSON.parse` → `JSON.stringify` is not the identity
function, and every provider signs the bytes it sent. The canonical Standard
Webhooks vector, reproduced in `rawbody.test.ts`:

```
{"test": 2432232314}   ->  v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=
{"test":2432232314}    ->  v1,Vif40peJBP7Iyl0XGmu61n4MwdrcHov5CFREBpE0svs=
```

One space, completely different signature, and the symptom is that *every*
genuine delivery is rejected — which sends people to rotate the secret, which
does nothing.

A bad signature gets **401 and no row**. That is deliberate: an unauthenticated
body is not evidence of anything, and persisting it would let anyone who can
reach the URL fill the inbox. The refusal itself is still recorded, separately,
via `refusals.ts` — so "nothing was stored" does not mean "nothing was seen".
Measured in the suite: `signature_mismatch`, `timestamp_outside_window`,
`signature_absent` and `unknown_provider` all produce refusal records.

Five schemes, each with its own trap, all pinned by tests: Lithic and Increase
differ in **key encoding** (base64-decoded body vs the raw secret string) and
`secretEncoding` is a required parameter with no default, because guessing it
rejects every real delivery; Plaid pins `alg: "ES256"` so `alg: "none"` fails,
and caches keys **per `kid`** (Plaid's own published sample caches one key
globally, which breaks on their first rotation); Persona publishes no tolerance
at all, so the ±300 s window is *ours* and the docs say so; comparisons are
constant-time with both sides hashed to 32 bytes first, because letting
`timingSafeEqual`'s length-mismatch exception escape differently from a mismatch
is itself an oracle.

### Replay — one statement, no branch

```sql
insert into webhook_inbox (...) values (...)
on conflict (provider, provider_event_id) do nothing
returning id
```

The row count **is** the decision: one row = first delivery, zero rows =
Postgres has seen it. No `SELECT` first (that has a race between two
statements), no `if` in application code that could be wrong. Both outcomes are
2xx, because a replay is the provider doing exactly what its documentation says
— answering 409 only produces more replays.

The honest cost, stated in the README and repeated here: **Plaid ships no event
id**, so the dedupe key is `sha256:<hex of raw body>`. Two genuinely distinct
Plaid webhooks with byte-identical bodies collapse into one row. That is
acceptable *only* because every Plaid webhook is a "something changed, come and
re-read it" notification whose consumer re-fetches. It would be wrong for an
event carrying an amount, and if we ever take money instructions from Plaid this
has to change.

### Out-of-order — settlement before its auth

Gauntlet item 4. The dispatcher makes **no ordering promise at all**, so no
consumer can come to depend on one. A consumer that needs an entity it has not
heard of returns `parked(kind, ref)`:

- the row moves to `parked` with `(parked_on_kind, parked_on_ref)` recorded in
  the consumer's own vocabulary — and a **check constraint refuses a park with
  no referent**, because that would be a queue nothing could drain;
- it is woken two ways: immediately, when any consumer reports `processed([{kind,
  ref}])` (one `UPDATE` moves every row waiting on that referent back to
  `pending`), and independently on its own exponential re-check timer — so a
  park is never load-bearing on some other event turning up;
- parks are counted **separately** from failures, so waiting does not spend the
  retry budget, but they are still bounded at 12 (~5 hours), after which the row
  is dead-lettered, because an event waiting five hours for an authorisation is
  a missing event, not a late one.

`dispatch.test.ts` drives clearing-before-authorisation directly and asserts the
row parks, then completes when the auth arrives, and separately asserts that
*every permutation* of the event set reaches the same effects and the same
terminal states. Never crashes, never double-counts. **This works.**

Two details that are load-bearing and easy to lose:

- `attempts` is incremented **when the dispatcher claims the row, not when it
  fails**. That is the whole poison-message defence: a worker that dies
  mid-event has still spent an attempt, so an event that reliably kills workers
  cannot loop for ever. The retry budget is `attempts - park_attempts` — one
  subtraction, two independent caps.
- A claimed row stays `pending` and carries a `locked_until` lease. **A lease is
  a timeout, not a state**, so a worker that dies releases its work by doing
  nothing at all.

### Lithic parks events for unregistered cards — correct, leave it

That is the system refusing to guess whose money it is. Similarly, Increase's 37
dead letters are all refusals with **zero** fault deaths. Neither is a bug.

> **Rule observed, not tested:** I did not disable a Lithic event subscription.
> Lithic does not guarantee replay of events dropped while a subscription is
> down, so the five-minute outage in the brief would punch a permanent,
> unrecoverable hole in an append-only book. The webhook-outage question is
> answered above by structure — verify, persist, ack fast, process async, with a
> cron that drains independently — rather than by creating a gap to look at.

---

## 5. Defects found and fixed

Both are in `src/lib/rails/stablecoin/client.ts`, both were found by the live
probes in §0, and both had money consequences.

### Defect 1 — a non-2xx threw the node's own error away

**Before** (`client.ts`, the `call()` body):

```ts
if (!response.ok) {
  throw new RpcError(`${method}: HTTP ${response.status}`, method, await response.text().catch(() => null));
}
const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
if (body.error) { ... }
```

`response.ok` was checked **first**. But §0 measured the real node answering
`HTTP 403` and `HTTP 400` with a perfectly good JSON-RPC error body. Both
collapsed to the string `"eth_x: HTTP 403"`, and the `code` and `message` were
discarded into an unparsed `raw` blob.

That is not cosmetic. `sendUsdcPayout` recovers an already-broadcast transaction
by matching `/already known|known transaction/i` against **exactly this
message** (`adapter.ts`, step 10). A node reporting "already known" behind a
non-2xx — which the measurement proves nodes do — could not match, so a
re-broadcast of a transaction already sitting in the mempool came back as
`broadcast_rejected`.

**The customer was told their payout failed while it was live on chain**, which
is both untrue and the wrong direction to be wrong in: it invites a human to
send the money a second time.

**After:** read the bytes once, parse first, classify second. A JSON-RPC error
wins regardless of status; the node's sentence stays at the front where a human
and a substring match both find it; the status is appended as audit detail;
`RpcError` gained `rpcCode` and `httpStatus` fields so callers can branch on
`-32601` (permanent) versus a 503 (retryable) without regexing prose.

### Defect 2 — a malformed `eth_getLogs` was a licence to pay twice

**Before** (`transferLogs`):

```ts
if (!Array.isArray(logs)) return [];
```

An **empty array** is an answer: "no such transfer in this range." A **non-array
is not an answer at all.** `findExistingTransfer` is the crash-window
duplicate-payment guard — it asks this exact question to learn whether a payout
we may already have broadcast is on chain. Returning `[]` for a node that
answered `null`, an object or a string told that guard *"this payout has never
been sent"* on no evidence, and the adapter went on to broadcast.

**After:** a non-array raises a named `RpcError` naming `eth_getLogs` and
refusing to read the answer as "no transfer found". Refusing costs a failed
payout attempt; guessing cost the customer a second payment. Fail closed.

### Also fixed in passing

`await response.json()` was unguarded and sat *outside* the `try`. A 200
carrying a proxy's HTML error page — exactly what a load balancer returns during
an outage — escaped as a bare `SyntaxError`, a different class from the
`RpcError` every caller catches, so a named refusal became an unhandled 500. It
is now a named `RpcError` carrying a 120-character preview of the offending
bytes.

### Both outputs

```
$ npx vitest run src/lib/rails/stablecoin/client.test.ts
 ✓ src/lib/rails/stablecoin/client.test.ts (15 tests) 14ms
      Tests  15 passed (15)

$ npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test.json
(clean)

$ npx eslint src
(clean)

$ npx vitest run
 Test Files  3 failed | 177 passed | 53 skipped (233)
      Tests  2896 passed | 529 skipped (3425)
```

The three failing suites (`cards/race.probe`, `api/health/item-health`,
`webhooks/consumers/plaid-item`) fail at **collection** with
`EnvironmentError: Environment is invalid` — missing env vars on this machine.
They are pre-existing, untouched by this work, and no test in them ran.

`client.test.ts` is new and pins all of it: the measured 403/-32601 and
400/-32700 shapes, the already-known recovery through a 503, the HTML error page
at 200, a truncated payload, an empty body, a JSON array, and — separately —
that `transferLogs` still returns `[]` for a genuinely empty result while
refusing `null`, an object, and a missing `result` key.

---

## 6. Defects found and NOT fixed

Reported rather than fixed, either because they are outside my boundary or
because the deadline did not leave room to prove a change. Each is real.

### Mine, unfixed for time — the dispatcher can abandon a batch

`dispatch.ts` says, above the loop: *"One row failing does not stop the rest —
every outcome below is caught and recorded, never thrown out of the loop."*
**That is true of the consumer and false of the store.** `consumer.handle()` is
inside a `try`, but `store.markProcessed`, `store.park`, `store.deadLetter`,
`store.recordFailure` and `store.unparkWaitingFor` are all **outside** it. A DB
blip on `markProcessed` — or the guard trigger refusing a transition — throws
out of `dispatchOnce`, abandoning every remaining row in the batch and surfacing
as a 500 from the cron route.

Nothing is *lost* (the abandoned rows keep their leases and are re-claimed on
the next tick, and consumers are idempotent), so this is a liveness and
truthfulness bug rather than a money bug — but the comment asserts a property
the code does not have. The fix is a per-row guard around the outcome-application
so a store error becomes a recorded failure for that row and the loop continues,
with a nested guard for the case where the store is entirely down. Contained,
and it needs a test I did not have time to write.

### Swallow-class defects in the other rails

These return a **default that looks like success**, which is the specific shape
the brief calls out. Listed in severity order.

1. **`lithic/client.ts:162-168`** —
   ```ts
   function safeJsonParse(text: string): unknown {
     try { return JSON.parse(text) as unknown; } catch { return text; }
   }
   ```
   combined with `:215-217` `if (response.ok) return parsed as T`. A non-JSON
   200 returns **the raw HTML string cast to `Card`/`Transaction`**. Then
   `normalizeTransaction` (`:811`) absorbs it silently — `txn.events ?? []`, and
   `absCents()` (`:710`) returns `0` for anything non-numeric. **A Cloudflare
   interstitial normalises to a clean `holdCents: 0, hasOutstandingHold: false`
   record: a garbage payload reads as "hold fully released."** This is the worst
   one in the tree.
2. **`wire/client.ts:225-246`** — same pattern on the rail whose own header says
   the money "cannot be recovered". A non-JSON 200 returns the raw string as
   `IncreaseWireTransfer`; an **empty** 200 returns `null` cast to it, and
   `wire/adapter.ts` then dereferences it. The input side of this file is
   validated meticulously (currency, positivity, `MAX_SAFE_INTEGER`, a named
   `beneficiary_name_too_long`); the output side is not validated at all.
3. **`circle-client.ts:172-178`** — a malformed 200 becomes the raw string,
   which `circleData()` rejects with a **generic `Error`, not a `CircleError`**.
   `circle-provider.ts:538-542` is `if (error instanceof CircleError) return
   refuse(…); throw error;` — so a malformed 200 from Circle **escapes the
   refusal contract** and propagates. The file already knows the right pattern:
   `:208-210` raises a proper `CircleError` on a bad 200 shape.
4. **`lithic/client.ts:196-211`** — the fetch has `try/finally` with **no
   `catch`**, so a timeout escapes as a bare `DOMException: AbortError` and a DNS
   failure as a raw `TypeError`. Neither is a `LithicApiError`, neither carries a
   status, and `err.isRateLimited` is `undefined` on both. Lithic is the only one
   of the seven clients with no named transport error.
5. **`stablecoin/client.ts:153-158`** (mine) — a bare `catch` around
   `eth_maxPriorityFeePerGas` falling back to `eth_gasPrice`. Intended for
   "method not implemented", but it catches a timeout, a 500, a rate limit and a
   malformed quantity too, silently issuing a second RPC. `gasPrice` is a valid
   upper bound so the risk is overpayment rather than loss, but the original
   failure is erased with no log. Left alone because narrowing it on the
   `-32601` code now available from defect 1 is the right fix and it wants a
   test.
6. **`circle-provider.ts:564-566`** — `catch { statedUnits = null; }` skips the
   amount cross-check at `:567` entirely, with no log. That check exists
   precisely to catch "an amount Circle reinterpreted".
7. **Minor, logged here for completeness:** `achsim/rail.ts:326` (a malformed
   scenario becomes the default scenario — simulator only);
   `route-handler.ts:303-310` (env parse failure falls back to raw values —
   justified, since health must answer, and the fallback cannot over-report, but
   the parse error is discarded); `consumers/lithic-card.ts:96` and
   `consumers/payload.ts:35` (stored-payload parse errors dropped, though callers
   do treat `null` as a refusal).

**Unchecked casts, no schema:** `increase/client.ts:967` and `plaid/client.ts:391`
are both `JSON.parse(text) as T`. Concretely, `increase/client.ts:522-528`
returns `page.data` from a 200 `{}` as `undefined` typed
`readonly IncreaseAccountNumber[]`, and the caller iterates it. A handful of zod
schemas at these seven boundaries would close the entire class.

### Correct by construction, cited so it is not "fixed" later

`adapters/probe-http.ts:84-89` catches and returns `{ res: null, err }`. That is
a **named result**, not a default — `err` is recorded and rendered — and it is
the only place in the repo that classifies credential expiry correctly by
construction (`livenessFromStatus:41-47`, 401/403 ⇒ `unauthorised`, 429 ⇒ its
own verdict, 400/409/422 ⇒ `live` because an authenticated rejection on content
proves the provider is up).

`increase/client.ts:666-671`, `consumers/increase-ach.ts:1262` and
`consumers/increase-wire.ts:462` are **deliberately unguarded** — the webhook
read-backs are left to throw so `dispatch.ts` retries rather than marking a row
done on an unknown state. Do not add a `catch` there.

A zero `blockHash` is a **preconfirmation, not a reorg**; `stablecoin/adapter.ts`
handles it and this work did not touch that path.

---

## 7. Partial failure — money on one side only

The question is: provider succeeded and our write failed, or the reverse. What
reconciles it?

**The stablecoin path is the strongest, and it is the model.** The tx hash is
known **before** broadcast, because the signed bytes are deterministic (same
nonce ⇒ same bytes ⇒ same hash). That single fact buys three things:

1. the operator gets the hash *before* the money can move (`onSigned`);
2. a retry of the identical transaction is recognised by the node as "already
   known", which `adapter.ts` treats as **success, not rejection** — the
   idempotency key and the transaction are the same object;
3. `findExistingTransfer` can ask the chain "did I already send this?" before
   sending — which is exactly the guard defect 2 was undermining.

And if the local hash ever disagrees with the node's, `adapter.ts:453` **stops**
rather than continuing, because the idempotency key would not name the
transaction. That is the right instinct: when the key and the effect can no
longer be proven to refer to the same thing, do nothing.

**On the inbound side**, the boundary is stated honestly rather than papered
over: *the inbox guarantees an event is **stored** once, not **handled** once.* A
process can die between applying an effect and marking the row done, so the
effect is retried. That is why every consumer must be idempotent, and why the
ledger keeps its own idempotency keys derived from `provider_event_id` as the
last line of defence. Exactly-once *delivery* does not exist; exactly-once
*state* does, and it is bought in the consumer.

**Recovery** is `scripts/redrive.mjs` plus `requeueDeadLetter`, which puts a row
back in the queue with the counters reset — `dead` is not a grave, it is a
queue with a human in front of it. `done` *is* terminal, enforced by the guard
trigger, not by convention.

---

## 8. Credential expiry mid-flight

Measured in §0. What the code does with it:

| provider | expiry looks like | distinguished? |
| --- | --- | --- |
| Plaid | **HTTP 400**, `error_code: ITEM_LOGIN_REQUIRED` / `INVALID_API_KEYS` | **Yes** — `client.ts:373` uses Plaid's verbatim `error_code`, and `openbanking.ts:133` special-cases the 400. Best in the repo. |
| Circle | `CircleError.status` 401 vs status 0 | **Yes**, and `circle-provider.ts:422` branches on it. |
| probe-http | 401/403 ⇒ `unauthorised` | **Yes**, by construction. |
| Increase | `type: invalid_api_key_error`, `reason: no_credential` | **Partly** — the code is Increase's `type`, so it *is* nameable, but nothing branches on it; it is `retryable: false` like any 4xx. |
| Lithic | HTTP 401 | **No** — `LithicApiError` treats 401, 403, 404, 422 and 500 identically apart from `isRateLimited`. |
| Wire | HTTP 401 | **No** — `http_401` and `http_400` differ only by the number in the string. |
| Stablecoin RPC | gateway 401/403 | **Now partly** — defect 1's fix means a gateway 403 with a JSON-RPC body keeps its code; a bare 403 is still just a status. |

Absent-credential (as opposed to *rejected*-credential) is handled cleanly
everywhere: `not_configured` at `increase/client.ts:887`, `wire/client.ts:165`,
`circle-registry.ts:173`. The system knows the difference between "no key" and
"a key the provider refused", which is more than most.

---

## 9. What I could not induce, and why

- **A real Lithic ASA timeout.** Driving one requires stalling our own handler
  past 6000 ms against a live authorisation. The measurement already exists in
  `docs/CARD-CONTROLS.md` §2 from an earlier run — a stalling responder at
  **6.527 s** produced `DECLINED / UNKNOWN_HOST_TIMEOUT` with
  `['CUSTOMER_ASA_TIMEOUT']`, against a **0.334 s** baseline. I cite it rather
  than re-running it, because re-running it costs a real declined authorisation
  on a real card for no new information.
- **A Lithic webhook outage.** Deliberately not induced — see the boxed note in
  §4. Disabling a subscription creates permanent gaps in an append-only book,
  and Lithic does not guarantee replay.
- **A provider 5xx on demand.** None of the four sandboxes offers a fault
  injector. The 5xx paths are covered by injected-`fetch` tests
  (`client.test.ts` drives 502 and 503 through the real client code, only the
  transport is a double) rather than by live fire, and I am saying so rather
  than implying otherwise.
- **Real credential *revocation* mid-flight**, as opposed to a bad credential at
  call time. Revoking a live sandbox key would break the other four agents
  working in this repo. A garbage credential produces the identical 401/400 —
  §0 — and that is what I measured.
- **The dispatcher batch-abandonment fix** (§6). Found, understood, scoped, not
  shipped: it needs a test, and an unproven change to the money path at the
  deadline is worse than a documented one.

---

## 10. The one-line answers

- **Timeout on the ASA path?** We decline at 600 ms with
  `control_store_unavailable`, and the customer reads the true sentence
  explaining it. Past 6000 ms Lithic declines for us and the absence of a
  `card_auth_decision` row is what records that it was theirs.
- **5xx or malformed?** Named `RailError`/`RpcError`/`CircleError` codes on
  Increase, Plaid, Circle and stablecoin. **Lithic and Wire will hand you a
  string cast to a money object** — §6, items 1 and 2, unfixed.
- **Bad signature?** 401, no row, raw body verified before parse — structurally,
  not by review — and the refusal itself still recorded.
- **Duplicate?** `UNIQUE (provider, provider_event_id)`, one statement, the row
  count is the decision, 2xx either way.
- **Out-of-order?** Parks with a named referent and a check constraint that
  refuses an undrainable park; woken by the referent's arrival or by its own
  timer; bounded at ~5 hours; every permutation tested to the same terminal
  state.
- **Partial failure?** The hash is known before broadcast; "already known" is
  success; a hash mismatch stops everything; the inbox promises stored-once and
  says so, and idempotent consumers buy handled-once.
- **Credential expiry?** Plaid, Circle and the probe get it right by name.
  Lithic and Wire cannot tell a dead key from a bad request.
