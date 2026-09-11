# Card controls, enforced inside the provider's authorisation timeout

Stretch-ladder item 2, verbatim from `docs/BRIEF.md`:

> Card controls — per-card limits, merchant-category blocks — enforced in the
> real-time auth decision webhook inside the provider's timeout.

It is the only item on that ladder that *has* to be real-time, which is the
whole reason it is worth building: everything else on the list can be a job that
runs later, and this one cannot. Lithic calls us and **waits**. The response
body is the side effect.

This document is the engineering argument, the measurements behind it, and an
exact statement of what is real and what is not.

---

## 1. Is ASA enableable on this program? Yes. Measured.

Every call below was made against the live Lithic sandbox on **2026-09-10**,
with the program's own API key. Nothing here is inferred from documentation.

| # | Call | Code | Body |
| --- | --- | --- | --- |
| 1 | `GET /v1/auth_stream` | `200` | `{"enrolled": false}` |
| 2 | `GET /v1/auth_stream/secret` | `200` | `{"secret": "whsec_…"}` — present, and **distinct from `LITHIC_WEBHOOK_SECRET`** |
| 3 | `GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` | `200` | `{"enrolled": false, "url": null}` |
| 4 | `POST /v1/responder_endpoints` `{"type":"AUTH_STREAM_ACCESS","url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth"}` | `200` | `{"enrolled": true}` |
| 5 | `GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` | `200` | `{"enrolled": true, "url": "https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth"}` |
| 6 | `DELETE /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` | `200` | `{}` |
| 7 | `GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` | `200` | `{"enrolled": false, "url": null}` |

Calls 4–7 were run as a single unbroken sequence so the program sat enrolled for
about a second, then it was disenrolled again — deliberately, because enrolling
points every authorisation on the program at one URL and enrolling before the
responder is deployed would decline every card in the estate.

**That is no longer the state. The responder is deployed and ASA is ENROLLED**,
re-read live on **2026-09-11T14:03Z** with the program's own key:

```
GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS
  200  {"enrolled": true, "url": "https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth"}
GET /v1/auth_stream
  200  {"enrolled": true}
GET https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth
  405  the budget document — so the URL Lithic holds is a responder, not a 404
```

**Lithic is calling this system for every authorisation on the program**, and
§§2, 3, 5 and 8 below are the measurements from those calls, with the provider's
own transaction tokens.

`GET /v1/auth_rules` answers `404` on this program, so Lithic's own server-side
Auth Rules product is not available here. ASA is.

**One provider fact that only shows up once you are enrolled.** Lithic does not
put our `result` on the wire verbatim. A `VELOCITY_EXCEEDED` from us comes back
on the transaction as `result: USER_TRANSACTION_LIMIT` with
`detailed_results: ["CARD_SPEND_LIMIT_EXCEEDED"]` — which reads, from the
outside, exactly like Lithic's own per-card `spend_limit` firing. It is not:
the cards below are all `spend_limit: 500000` per transaction and every decline
quoted here is ours. `UNAUTHORIZED_MERCHANT` and `APPROVED` do pass through
unchanged. So **the provider's transaction record cannot always tell you which
system declined, and `card_auth_decision` is the only place that can** — which
is a much better argument for the decision log than the one this document
started with.

---

## 2. The provider's timeout, measured rather than quoted

Lithic's documentation says 6 seconds. Their OpenAPI document carries
`CUSTOMER_ASA_TIMEOUT` as a member of the transaction `detailed_results` enum.
Neither of those is a measurement, so here is one.

**Method.** Enroll an ASA responder that accepts the connection and stalls for
20 s (`https://httpbin.org/delay/20`), fire one `POST /v1/simulate/authorize`
for $1.00, and time the call. `simulate/authorize` does not return until the ASA
round trip is over, so its wall time *is* the provider's wait plus a small
constant. A baseline authorisation with no responder enrolled measures that
constant. Then read what Lithic recorded on the transaction.

**Result.**

```
baseline, ASA NOT enrolled:
  elapsed 0.334 s
  transaction aff752c2-…  status PENDING   result APPROVED
    AUTHORIZATION  APPROVED  ['APPROVED']  100

ASA enrolled at a responder that stalls for 20 s:
  elapsed 6.527 s
  transaction 936326fe-…  status DECLINED  result UNKNOWN_HOST_TIMEOUT
    AUTHORIZATION  UNKNOWN_HOST_TIMEOUT  ['CUSTOMER_ASA_TIMEOUT']  100
```

**What that establishes.**

* The provider waits **6.527 − 0.334 ≈ 6.19 s**, i.e. the hard timeout is
  **6000 ms**, and the documented figure is the real one.
* **On timeout Lithic DECLINES.** It does not approve, it does not retry into an
  approval, and it does not fall back to the card's own `spend_limit`. The
  transaction ends `DECLINED / UNKNOWN_HOST_TIMEOUT` with the detailed result
  `CUSTOMER_ASA_TIMEOUT`.
* Our slowness is therefore **observable from the provider's side**. That is
  worth more than it looks: a timeout is not a silent degradation we would have
  to infer from our own logs, it is a property stamped on the transaction that
  reconciliation can find.

Lithic additionally recommend answering within **3000 ms**, because acquirer-side
timeouts downstream of Lithic can void a transaction Lithic itself would still
have waited for. That recommendation, not the 6000 ms ceiling, is our SLO.

The probe left the estate clean: the enrolled window was ~30 s, the enrollment
was deleted immediately, and the baseline authorisation's $1.00 hold was expired
(`simulate/void` with `AUTHORIZATION_EXPIRY`) so it did not leave a dangling
hold on the demo book.

**One honest caveat about the probe.** The stalling responder was
`httpbin.org/delay/20`, a public echo service, so one sandbox ASA payload was
delivered to a third party. It contained a sandbox transaction token, a sandbox
card token, a test card's last four, an invented merchant and $1.00. No PAN, no
real personal data, no real money — an ASA request does not carry a PAN. It was
the only way to measure a stall without a deployed responder of our own.

---

## 3. The latency budget

`src/lib/cards/budget.ts` holds these as constants, `budget.test.ts` asserts the
arithmetic, and the console panel renders them by importing the same module — so
there is no second copy that can drift into marketing.

| Step | Budget | Why |
| --- | --- | --- |
| Read the raw bytes | — | one `await request.text()`, once; the signature is over the bytes as sent |
| Verify HMAC | ~0.1 ms | in-process `node:crypto` over ~4 KB |
| Fetch the ASA secret | ≤ 400 ms | **cold instance only**, then cached for 10 min |
| Read controls + spend | ≤ 600 ms | **one** round trip, **one** statement |
| `decide()` | < 1 ms | pure: no I/O, no clock, no database handle in scope |
| Append the decision | ≤ 400 ms | one insert, append-only, no locks |
| **Our ceiling** | **1400 ms** | asserted `< 3000 ms` in `budget.test.ts` |

### How we actually stay inside it

**One statement, not three.** The obvious shape is: find the card, read its
controls, sum its spend. That is three round trips, three chances to hang, and a
deadline that cannot say which one failed. `readControlsAndSpend()` is a single
statement with a `LEFT JOIN` to `v_card_control_current`, a second to
`v_team_member_current` through `card_member`, and **two** `CROSS JOIN LATERAL`
aggregates — the card's velocity and the person's. Adding the person (0033) cost
this path no round trip and no second deadline, which is the only reason a
per-member limit could be put on the hot path at all.

**Measured, against the live database.** `EXPLAIN (ANALYZE)` on the hot-path
query, run on Neon:

```
Limit (actual time=0.110..0.111 rows=1 loops=1)
  ...
  ->  Index Scan using card_auth_decision_velocity_idx on card_auth_decision d
        Index Cond: ((card_id = c.id) AND (source = 'provider')
                     AND (decided_at >= (now() - '40 days'::interval)))
Planning Time: 0.325 ms
```

**Server-side execution was 0.11 ms** on that plan, and is **0.665 ms** on the
2026-09-11 re-take with 0033's per-member joins in the same statement. The
partial index `card_auth_decision_velocity_idx … WHERE outcome = 'approve'` is
used, as designed, and so is its per-member sibling. The 600 ms deadline is
roughly a **900× margin** over the work.

From this laptop — cross-region, over the WAN, the worst case available to
measure — 40 runs of the full query gave **min 61.6 / p50 71.6 / p95 85.5 ms**,
against a bare `SELECT 1` round trip of **p50 67.4 ms** on the same connection.
So the query costs about **4 ms over the network floor**, and essentially all of
the 70 ms is my house. The deployed function runs in `iad1`, in the same region
as the database, where that floor is single-digit milliseconds.

The integration suite asserts the whole read-plus-decide path completes in under
3000 ms (`cards.integration.test.ts`, scenario 7) so a regression fails the
build rather than a cardholder.

**The plan above is from 2026-09-10 and is superseded** by the one in *The
latency actually observed* below, re-taken on 2026-09-11 with migration 0033's
per-member joins in the statement: **0.665 ms, one statement, both partial
indexes used.** Two notes on it that the older plan got wrong in opposite
directions:

* It said `card_provider_key UNIQUE (provider, provider_card_token)` was **not**
  being used — a `Seq Scan on card`, 142 rows — and predicted the planner would
  pick it up as the table grew. It has. No index was ever added for it, which is
  the point: adding an index the planner already has is how a schema grows things
  nobody can explain.
* Two seq scans remain, on `card_control_version` and `team_member_version`,
  from the `DISTINCT ON` views. 62 and 571 rows. Same argument, same answer.

### The latency actually observed, on Lithic's own deliveries

**2026-09-11, 14:04–14:22Z, 37 real ASA deliveries** from the enrolled provider
to the deployed responder. `decision_latency_us` is on every row, so this is
read out of `card_auth_decision` rather than out of a log drain:

| Lane | n | min | p50 | max |
| --- | --- | --- | --- | --- |
| warm instance | 22 | **11.7 ms** | **14.2 ms** | 30.9 ms |
| first request on a new instance | 13 | 125 ms | 156 ms | 508 ms |
| the induced control-store outage (§5) | 2 | 600.4 ms | 600.4 ms | 600.4 ms |

**Across every provider-lane decision this system has ever made (59 rows): zero
over the 1400 ms handler budget, zero over Lithic's 3000 ms recommendation, zero
over the 6000 ms timeout.**

The two lanes are the cold start, and it is smaller than the budget allowed for
it: the 400 ms secret-fetch line item buys a *median* of 142 ms of extra work on
a new instance, and the worst new-instance decision all afternoon was 508 ms —
still inside the 600 ms control-read deadline on its own, let alone the handler
ceiling. The split is bimodal with nothing between 31 ms and 125 ms, which is
what a per-instance one-off cost looks like and not what load looks like.

**From the provider's side.** `POST /v1/simulate/authorize` does not return
until the ASA round trip is over, so its wall time is Lithic's own work plus
ours. Twelve warm runs: **min 285 ms, p50 290 ms, max 377 ms** — against the
**334 ms** baseline §2 measured with *no responder enrolled at all*. Our whole
synchronous decision is inside the noise of Lithic's own round trip.

**The hot-path query plan, re-run today on the live book** with the per-member
joins 0033 added:

```
Limit  (actual time=0.575..0.579 rows=1 loops=1)
  ->  Index Scan using card_provider_key on card c
  ->  Index Scan using card_auth_decision_velocity_idx on card_auth_decision d
  ->  Index Scan using card_auth_decision_member_velocity_idx on card_auth_decision d_1
Planning Time: 1.156 ms
Execution Time: 0.665 ms
```

**One statement, 0.665 ms, both partial indexes used** — the card's velocity and
the *person's* velocity are two `CROSS JOIN LATERAL` aggregates in the same
query, so 0033 cost this path no round trip and no second deadline. Two seq
scans remain, on `card_control_version` (62 rows) and `team_member_version`
(571 rows), from the `DISTINCT ON` views; at 0.665 ms against a 600 ms budget
that is a ~900× margin and adding indexes the planner is declining to use would
be schema nobody can explain. And `card_provider_key` **is** being used now,
which §3 previously recorded as not-yet-used: the `card` table grew past the
point where the planner preferred a seq scan, exactly as predicted.

### The route itself, exercised over HTTP

Measured against the route running locally, with requests **signed using the
real ASA HMAC secret fetched from Lithic** — the same value the route fetches
for itself. Not a mock: the bytes were signed the way Lithic signs them and
verified by the code that will verify Lithic's.

```
GET  /api/webhooks/lithic-auth        -> 405 + the budget document

A. no signature headers at all         -> 401 SIGNATURE_INVALID   196 ms  (cold: includes the secret fetch)
B. signature made with a wrong secret  -> 401 SIGNATURE_INVALID     8 ms
C. correct signature, body tampered    -> 401 SIGNATURE_INVALID     6 ms
D. correct signature, 10-minute replay -> 401 SIGNATURE_INVALID     5 ms
E. correct signature, non-ASA body     -> 422 ASA_PAYLOAD_INVALID   5 ms
```

Two facts fall out of the timings. The first request costs **196 ms** because a
cold instance fetches the ASA secret from Lithic; every subsequent one is
**5–8 ms**, so the 400 ms secret budget is real and the cache works. And none of
the five wrote a `card_auth_decision` row, which is correct: a refusal is not a
decision.

### The fail-closed path, driven by the provider, against a control store that is genuinely unreachable

**2026-09-11T14:09:07Z.** Not a mocked timer, and not a local process this time:
the deployed responder, answering a real Lithic delivery, while the control
store could not be read.

**The method.** A separate owner session opened a transaction and took
`ACCESS EXCLUSIVE` on `card_control_version` — the relation the one hot-path
statement must read — then a real `POST /v1/simulate/authorize` for $5.00 was
fired at Noor Haddad's card (`84b40e67-…`, a card that **does** have controls and
**does** belong to a member, so a fail-open would have been a visible wrong
answer). The transaction was rolled back 1.5 s later; the window was 2.8 s, the
session carried `idle_in_transaction_session_timeout` and `lock_timeout` so it
could not outlive the demonstration, and nothing was written by it.

**The result, from both sides.**

```
lithic transaction  8025729c-f3a8-4aa1-bfd5-b42405e16f9a
  status DECLINED   result USER_TRANSACTION_LIMIT
  event  AUTHORIZATION  ["CARD_SPEND_LIMIT_EXCEEDED"]  token a4f680ba-…

card_auth_decision
  outcome  decline
  rule     control_store_unavailable
  result   VELOCITY_EXCEEDED
  source   provider
  request_id            a4f680ba-…      ← Lithic's own event token
  decision_latency_us   600390          ← the 600 ms deadline, to the microsecond
  inputs.detail         "DeadlineExceededError: control read exceeded its 600 ms budget"
  inputs.fail_mode      "closed"
```

**Every part of the argument in §5 was exercised at once**: the read gave up at
its deadline rather than at Lithic's; the verdict was a decline and not a guess;
the row exists with the driver's own error on it; and the cardholder was refused
on a card whose controls we could not honour rather than approved on one we
could not check. `simulate/authorize` returned in **1271 ms** — inside the 1400 ms
handler ceiling, well under the 3000 ms recommendation, and a fifth of the
6000 ms at which Lithic would have declined for us with `CUSTOMER_ASA_TIMEOUT`.

**And it found a bug, which is why you do this live.** The one delivery produced
**two** rows — see *The bug the live fail-closed run found*, below.

**The earlier, harsher version of this proof**, kept because it covers the case
the lock does not — the whole database gone, so the append cannot land either.
`APP_DATABASE_URL` was pointed at an RFC1918 blackhole
(`10.255.255.1:5432`) so the TCP connect never completes, and a correctly signed
$50 fuel-pump authorisation was sent three times:

```
run 1: HTTP 200 in 1541 ms  rule=control_store_unavailable  decisionUs=601652
run 2: HTTP 200 in 1018 ms  rule=control_store_unavailable  decisionUs=601658
run 3: HTTP 200 in 1011 ms  rule=control_store_unavailable  decisionUs=600136
       {"result":"VELOCITY_EXCEEDED","token":"…"}
```

and the structured log line for run 3:

```json
{"event":"asa.decided","outcome":"decline","result":"VELOCITY_EXCEEDED",
 "rule":"control_store_unavailable","storeStatus":"unavailable",
 "decisionLatencyUs":600136,"elapsedUs":1004096,
 "handlerBudgetMs":1400,"overBudget":false,"overProviderRecommendation":false,
 "decisionId":null}
{"event":"asa.decision_lost","authRef":"1850686a-…"}
```

**This is the worst case the system has**, and it is what the whole design is
sized for:

* the control read gave up at **601 ms**, the deadline, to the millisecond;
* the whole handler answered in **1.01 s** — inside our 1400 ms ceiling, a third
  of Lithic's 3000 ms recommendation, and a sixth of the 6000 ms at which
  Lithic would have declined for us;
* the verdict was a **decline**, not a guess;
* the append failed too (same dead database), the response went out anyway, and
  `after()` retried and then logged `asa.decision_lost` — the degradation is
  loud rather than silent.

Total rows written by that local run: **zero**, which the database confirmed at
the time (`SELECT count(*) FROM card_auth_decision WHERE source = 'provider'` →
`0`).

**The two outages are not the same outage, and the difference matters.** The
blackhole kills the whole database, so the decline is correct and *unrecorded* —
the honest limit of the audit argument, and the hole DECISIONS.md 043 named. The
table lock kills only the relation the controls live in, so the decline is
correct **and recorded**, because `INSERT INTO card_auth_decision` takes
`ROW EXCLUSIVE` on a different table and never waits on it. Between them they
bracket the real world: the customer who was declined by an outage can be found
whenever the outage is smaller than "everything", and cannot when it is not.

### The bug the live fail-closed run found

**One delivery, two rows.** Transaction
`8025729c-f3a8-4aa1-bfd5-b42405e16f9a` appears **twice** in
`card_auth_decision`, 355 ms apart, with the *same* `request_id`
(`a4f680ba-…`, Lithic's own webhook id) and the *same*
`decision_latency_us` of 600390. Two independent invocations cannot agree to
the microsecond; this was one invocation writing twice.

**Why.** `withDeadline()` **races, it does not cancel** — which the function's
own header has always said. So when the 400 ms append budget expired, the insert
was still in flight; `appendDecision()` reported `null`; the route read that null
as *"the row was not written"* and re-issued the insert from `after()`. The
original then committed anyway.

**Why it is not the duplicate delivery §6 defends.** §6 argues, correctly, that
a second *delivery* is a second decision and deserves its own row — Lithic
documents rare duplicates, and suppressing the second would be an UPDATE-shaped
lie. That argument is about two ASA requests. This was one ASA request and two
inserts, which is a lie of the ordinary kind.

**Why it is worse than an untidy audit trail.** The velocity figure is
`SUM(amount_cents)` over approvals. A duplicated **approve** does not merely look
wrong, it *spends the limit twice*: one $200 authorisation would have consumed
$400 of the cardholder's daily allowance and declined a legitimate purchase
later the same day. The row that duplicated here was a decline, which consumes
nothing — so this cost the book nothing and the next one would have.

**The fix**, in `src/lib/cards/store.ts` and the route:

* `startDecisionAppend()` issues the insert with **no** deadline and never
  rejects; `awaitDecisionAppend()` is the caller's willingness to wait.
* `after()` now **awaits that same promise** instead of starting a new one, and
  logs `asa.decision_recorded_late` when it lands.
* Only if the original genuinely *rejects* does the route re-append — through
  `reappendDecisionIfMissing()`, whose insert is guarded by `WHERE NOT EXISTS`
  on `(provider, provider_auth_token, source, request_id)` for the case where it
  committed and lost its connection before `RETURNING` came back. That guard is
  a subquery, not a round trip, and the hot path's insert is untouched.
* `reappendDecisionIfMissing()` returns **three** outcomes, not two:
  `appended`, `already_recorded`, `failed`. Collapsing the first two would have
  the route raise `asa.decision_lost` about a row that is sitting right there.
* `request_id` is Lithic's `webhook-id`, which is per *message*, so a genuine
  second delivery carries a different one and still gets its own row.

Regression-guarded by scenario 8 of `cards.integration.test.ts`, against the
live database: append with a 1 ms budget, assert the caller gets `null`, assert
the promise still yields a row, assert the re-append answers
`already_recorded`, assert `count(*) = 1`.

**The two rows are still there**, and they always will be — the table is
append-only and there is no verb that could remove them. That is the correct
outcome and it is also the honest cost of finding a bug in production: the
decision log for that transaction permanently records one delivery twice, and
this paragraph is the only thing that can explain it.

**The cold start is the real tail, and it is a platform property.** A Vercel
Node function that has been idle pays module evaluation before our first line
runs. The route's import graph is kept deliberately small — `budget`, `asa`,
`decide`, `provider`, `store`, `log`, `rawbody`, and `@/lib/ledger/db` — and it
imports no React, no page code and no provider SDK. The deployed figures are in
*The latency actually observed* above: a new instance costs a median of ~142 ms
more than a warm one and at worst 508 ms, all of it inside the 600 ms
control-read deadline on its own. What has still not been produced is a function
that has genuinely been idle for fifteen minutes — this book is under continuous
traffic — so the "new instance" lane is an inference from a bimodal
distribution, and §7 says so.

---

## 4. The decision path does not touch the ledger

`src/lib/cards/store.ts` and the route reach **no** journal table. Not
`journal_entry`, not `journal_line`, not `hold`, not `card_auth_event`, not
`ledger_append()`. Scenario 2 of the integration suite fingerprints
`count(*)` and `SUM(amount_cents)` over `journal_line` either side of a live
decision and asserts the two are identical.

**Why.** A synchronous decision that writes is a synchronous decision that can
block on the journal's append lock, and **a blocked decision is a declined
card** — at 6000 ms Lithic declines on our behalf, as §2 measured. The
authorisation path's job is to answer; money still moves on the ordinary
asynchronous `card_transaction.updated` delivery into
`/api/webhooks/lithic`, through the same inbox, the same dispatcher and the same
consumer it always did. Two paths, one for the answer and one for the money,
and only the second one has the ledger's guarantees because only the second one
needs them.

The corollary, stated because it will be the first question: **available balance
is not checked here.** `v_available_balance` is a fold over `journal_line` — the
most expensive read in the system and the one that contends with the append
lock. It is the ledger's answer to "may this money be spent"; card controls are
the customer's answer to "may this card spend it". Conflating them would put the
journal on the critical path of every authorisation on the program. Lithic
enforces its own per-card `spend_limit` independently, which is the backstop.

---

## 5. Fail closed, and the argument against it

**If the control store does not answer inside its 600 ms deadline, this system
DECLINES.** Rule `control_store_unavailable`, in `src/lib/cards/decide.ts`.

### The case for failing OPEN, which is real

Most issuers fail open. Availability is the product. Visa and Mastercard both
run stand-in processing precisely so a cardholder is not stranded by an issuer's
outage. A decline at a fuel pump at midnight is a concrete harm to a person who
did nothing wrong, and the customer never asked our database to be reachable.

### Why we fail closed anyway

1. **The failure modes are not symmetric.** A wrong decline is recoverable: the
   acquirer may retry, the cardholder may use another card, and we hold the row
   that says why. A wrong approval is not: the money has moved on a card the
   customer froze *because it was stolen*, and the only remedy left is a dispute
   we will lose.
2. **Freeze is the promise this feature makes.** Limits and category blocks are
   preferences. Freeze is a commitment, and a card control product whose off
   switch works only while the database is healthy has not shipped an off
   switch.
3. **The deadline is ours and it is generous.** 600 ms against a measured
   0.665 ms of server-side work and a 6000 ms provider ceiling. Missing it does not mean
   "the database is busy", it means the database is gone. Fail-open arguments
   are arguments about *load*; this branch is about an *outage*.
4. **It is auditable either way.** Every fail-closed decline is a
   `card_auth_decision` row with the rule, the driver error and the latency, so
   the customer who was declined can be found, told and made whole. A silent
   fail-open leaves nothing to find.

#### Argument 4 was not true on any screen, until 2026-09-11

Worth spelling out, because it is the kind of hole a document like this is
supposed to find and this one did not until somebody opened the deployed page
and counted rows.

A fail-closed decline is written with `card_id = NULL` — necessarily, because
the read that would have produced the id is the read that failed.
`v_card_auth_decision` derives `business_id` by joining `card` on `card_id`, so
that row's `business_id` is NULL too, and `listDecisions()` filters on
`business_id`. **The most important row in the feature rendered on nobody's
console.** The fail-closed decline for transaction
`8025729c-f3a8-4aa1-bfd5-b42405e16f9a` — Noor Haddad's card, Ridgeline Robotics
— was in the table, and "the customer who was declined can be found" was a claim
about a SQL prompt rather than about the product.

`listDecisions()` now resolves the business from the **token** when the id is
missing, through `card_provider_key UNIQUE (provider, provider_card_token)`. The
row appears on its owner's screen with the card's last four, the rule, the
driver's error and 600,390 µs on it.

The asymmetry is kept on purpose: `card_not_under_control` stays invisible,
because for that token there is no `card` row to resolve to. *"We could not read
the controls on YOUR card"* and *"that is not a card of yours"* get different
answers here for exactly the reason `decide()` gives them opposite defaults.

### The deliberate fail-OPEN, which is a different question

Rule `card_not_under_control`: an ASA request naming a card token this book has
never registered is **approved**. That is not inconsistent with the above — it is
the opposite situation. There, the read *succeeded* and told us the truth, which
is that we hold no controls for that card. ASA enrollment is program-wide;
declining every card we did not create would turn a new feature into an outage
for every card that predates it.

The distinction is exactly **"we know the answer is no controls"** versus
**"we do not know the answer"**, and the two get opposite defaults. The decision
row records which one happened: `inputs.fail_mode` is `"open"` or `"closed"`,
and `decide.test.ts` asserts both.

### Authentication fails closed too

An ASA request whose signature does not verify — or which carries no signature
headers, or which arrives when the ASA HMAC secret could not be fetched — gets
`401` and no decision row, because nothing was decided. Lithic does not retry a
4xx and declines on a refusal, which is the outcome we want: **an unauthenticated
request must never be able to approve a card payment.**

---

## 6. Controls as data, versioned — following `approval_policy`

Migration `0014_card_controls.sql`, extended by `0033_team.sql` with the
person-scoped half (`team_member_version` for the terms, `member_id` and
`member_version_id` on the decision log, and the partial index
`card_auth_decision_member_velocity_idx` that makes the per-person velocity sum
an index scan). Modelled on `approval_policy` from 0001 for
the reason 0007's header gives: *a payment is judged under a policy VERSION,
cited by id, so a later policy change cannot retroactively make a past approval
look wrong.*

### `card_control_version`

Append-only, one row per change, `UNIQUE (card_id, version)` with a trigger
asserting contiguity and monotonic `effective_from`. Carries the on/off switch
(`card_state`), three limits (`per_txn`, `daily`, `monthly` — each nullable), a
`text[]` of blocked MCCs with a CHECK that every element is four digits, a
mandatory `note`, and `created_by`.

* **A change is version N+1, never an UPDATE of version N.** The same
  `ledger_row_is_immutable()` trigger the journal uses is on this table.
* **`NULL` limit ≠ `0` limit.** `NULL` is "no limit of this kind"; `0` is "this
  card may spend nothing". Both are reachable from the screen and they mean
  different things. A single sentinel would collapse them, and the collapse
  always goes the dangerous way.
* **MCCs are strings.** `'0742'` is a veterinary surgeon; `742` is nothing. An
  operator's malformed code is refused by name, never padded — padding `763` to
  `0763` blocks agricultural co-operatives nobody chose.
* **Concurrency is decided by Postgres.** Two operators saving in the same second
  both compute N+1; the unique constraint lets one through and the other is
  retried once *against the version the winner wrote*, so the second save lands
  on top of the first instead of silently discarding it.

### `card_auth_decision`

Append-only. Every decision, provider-driven or harness-driven, with:

| Column | What it is for |
| --- | --- |
| `rule`, `reason` | which rule fired, and a sentence a cardholder can read |
| `inputs` (jsonb) | the exact figures the rule compared — money as **decimal strings**, never JSON numbers |
| `control_version_id` | the version this was judged under. **Pinned.** |
| `member_id`, `member_version_id` | who it was decided for, and the terms they were judged under. **Pinned**, for the same reason. NULL for a card with no member — 0033 |
| `decision_latency_us` | microseconds. Milliseconds would round a 700 µs decision to 1 and a 400 µs one to 0 |
| `result_code` | the value put on the wire, from Lithic's `asa-response` enum |
| `source` | `provider` or `harness` — the honesty column, see §7 |

Scenario 4 of the integration suite proves the point that makes this a bank
feature rather than an if-statement: it takes a decline recorded under control
version 2, raises the per-transaction limit to $10,000 in version 3, re-reads the
decision, and asserts it still says `decline`, still cites version 2, and still
records `limit_cents: "1000"`. **A later change cannot retroactively re-judge a
past authorisation.**

There is deliberately **no** unique constraint on the provider's auth token.
Lithic documents rare duplicate ASA deliveries, and a duplicate delivery *is* a
second decision: it was asked again, answered again, and took its own amount of
time. Suppressing the second row would be an UPDATE-shaped lie in an append-only
table. The idempotency that matters — one hold, one posting — lives on the
asynchronous path, keyed by `journal_entry.idempotency_key`, and nothing here
posts.

**That argument was used to excuse a bug it does not cover.** On 2026-09-11 one
delivery wrote two rows because the handler re-issued an insert it thought had
failed — see *The bug the live fail-closed run found* in §3. Two *deliveries*
deserve two rows; two *inserts* for one delivery do not, and no constraint on
this table was ever going to tell them apart, because they are indistinguishable
in the data and distinguishable only in the code. The guard is in the code: the
retry awaits the original insert, and the last-resort re-append is keyed on
`(provider, provider_auth_token, source, request_id)` — where `request_id` is
Lithic's per-MESSAGE `webhook-id`, so a genuine second delivery still gets its
own row.

### The rules, in evaluation order

First match wins. `RULE_ORDER` is a separate constant from the display order, so
reordering a table on a screen cannot change what a card is allowed to buy;
`decide.test.ts` asserts the two sets are identical so a rule cannot be added to
the type and forgotten.

| # | Rule | Scope | Outcome | Wire result |
| --- | --- | --- | --- | --- |
| 1 | `control_store_unavailable` | — | decline | `VELOCITY_EXCEEDED` |
| 2 | `card_not_under_control` | — | approve | `APPROVED` |
| 3 | `balance_inquiry_not_a_purchase` | — | approve | `APPROVED` |
| 4 | `credit_not_a_purchase` | — | approve | `APPROVED` |
| 5 | `member_removed` | person | decline | `CARD_PAUSED` |
| 6 | `member_suspended` | person | decline | `CARD_PAUSED` |
| 7 | `card_frozen` | card | decline | `CARD_PAUSED` |
| 8 | `mcc_blocked` | card | decline | `UNAUTHORIZED_MERCHANT` |
| 9 | `per_transaction_limit_exceeded` | card | decline | `VELOCITY_EXCEEDED` |
| 10 | `daily_limit_exceeded` | card | decline | `VELOCITY_EXCEEDED` |
| 11 | `monthly_limit_exceeded` | card | decline | `VELOCITY_EXCEEDED` |
| 12 | `member_per_transaction_limit_exceeded` | person | decline | `VELOCITY_EXCEEDED` |
| 13 | `member_daily_limit_exceeded` | person | decline | `VELOCITY_EXCEEDED` |
| 14 | `member_monthly_limit_exceeded` | person | decline | `VELOCITY_EXCEEDED` |
| 15 | `no_controls_configured` | — | approve | `APPROVED` |
| 16 | `within_controls` | — | approve | `APPROVED` |

**Two scopes, one decision, no second round trip.** Rules 5, 6 and 12–14 came
with migration 0033 and they cost this path nothing it was not already paying:
the member, their terms and their spend-to-date arrive in the **same single
statement** under the **same 600 ms deadline** as the card's — two
`CROSS JOIN LATERAL` aggregates rather than one, each on its own partial index
(§3's plan shows both being used). There is no second query and no new way to be
slow, which settles what direction the new rules fail in: exactly the direction
the old ones already did.

**The person's spend is summed across every card they hold**, which is the whole
point of a per-person allowance — one that reset every time somebody was issued
a second card would not be an allowance. Proven live in §8.

**The card is checked before the person, and it is this way round on purpose.**
First match wins, so the scope checked first is the one whose reason the
cardholder gets. The card is the narrower instrument and the thing an operator
most recently touched; the person is the outer envelope, and *"you are inside
every limit on this card but outside your own monthly allowance"* is the
sentence that should come second.

**Except for removal and suspension, which are checked first** — before the
card's own controls *and* before `no_controls_configured`. That ordering is the
whole of "removing somebody stops their card": `no_controls_configured`
approves, so a removed member holding a card nobody had configured would
otherwise keep spending. They still sit *after* the two not-a-purchase rules,
so a **refund** to a removed person's card is still approved: the money returns
to the *business's* 2100, not to the individual, and revoking somebody's ability
to spend is not revoking the business's ability to be repaid.

Four notes on choices a reviewer should push on:

* **Rule 1's wire code is approximate and the doc says so rather than hiding it.**
  Lithic's `asa-response.result` enum has no "issuer system unavailable" member
  (the full list is in `types.ts`, copied verbatim from their OpenAPI document).
  `VELOCITY_EXCEEDED` is chosen because it is the only decline in that enum the
  network documents as **retryable by the acquirer**, which is the right
  operational signal for an outage. The *true* reason is on the row, so the
  dispute is answerable even though the wire code is a compromise.
* **A refund is not spend.** Rules 3 and 4 approve without consuming velocity,
  and `PURCHASE_STATUSES` — one constant, used by both `isPurchase()` and the
  SQL filter — keeps the two halves in step. A control that declined a $40
  refund because the card had spent its daily limit would leave a customer
  unable to receive their own money back.
* **No MCC on the request is not a match.** Declining on the absence of evidence
  would decline a real purchase because a terminal sent a malformed field. The
  approving row records `mcc: null`, so the gap is visible rather than assumed
  away.
* **Limits are inclusive.** A $10 limit permits $10. `spend + this amount > limit`
  is the comparison, not `spend > limit` — the difference between a limit that
  means what it says and one that means $9.99.

### The velocity figure, and its known cost

Spend-to-date is the sum of amounts **this system approved**, from
`card_auth_decision` — not the settled figure from the journal, and not the
outstanding hold. The ASA call happens before anything asynchronous has arrived,
so a ledger-derived figure would let five $9 authorisations in four seconds all
pass a $20 daily limit. Our own decision log is the only source that already
knows.

**The cost, stated rather than buried:** an authorisation we approved that is
later voided keeps its slot until the window rolls. A voided $200 auth holds $200
of the daily limit until midnight in `America/New_York`. The error is towards
declining rather than towards letting a limit be exceeded, which is the correct
direction for a control — but it is an error, and the fix (subtracting decisions
whose authorisation later reversed) is a second query on a path with a latency
budget. Not done. Week three.

Windows are **book** windows — `book_date()`, `America/New_York`, the same clock
a statement closes on. A daily limit that reset at UTC midnight would reset at
7pm local and nobody would be able to explain why.

---

## 7. What is real, and what is synthesised

Presenting a simulated integration as live is the fastest way to fail this
trial, so this section is a list and not a paragraph.

### Real, proven by a call whose response is quoted in this document

* ASA is **enableable** on this program (§1, calls 1–7, all `200`).
* The ASA HMAC secret **exists** and is **distinct** from `LITHIC_WEBHOOK_SECRET`.
* The provider's timeout is **6000 ms** and it **declines** on timeout, stamping
  `CUSTOMER_ASA_TIMEOUT` (§2, with the transaction tokens).
* The control store, the versioned chain, the append-only decision log, the
  decision function, the parser and the SQL all run against **live Neon** —
  `cards.integration.test.ts`, 12 scenarios, including the database refusing an
  `UPDATE` on a control version.
* The hot-path query plan and its 0.665 ms execution, with both partial indexes
  used (§3).
* **The route itself**, over HTTP, signed with Lithic's real ASA secret: all
  four refusal paths, the fail-closed decline against a genuinely unreachable
  database, and the measured 1.01 s worst case (§3).
* **Lithic is calling this system.** ASA is enrolled at the deployed responder
  (§1), and every claim in §8 is a real transaction token you can `GET` from
  `https://sandbox.lithic.com/v1/transactions/{token}` with the program's key.
* **Every distinct control kind**, driven by the provider: a per-card
  per-transaction limit, a per-card daily limit, a merchant-category block, and
  a per-member daily limit summed across two cards (§8).
* **The APPROVE branch, over HTTP, from the provider, under configured
  controls** — `bc441c48-…`, rule `within_controls`, control version 1 and
  member terms version 1 both pinned on the row. This was the gap §7 used to
  name; it is closed.
* **The fail-closed decline, driven by the provider**, against a control store
  made genuinely unreadable (§3), with the row and the provider's matching
  `DECLINED` transaction.
* **A card issued through the console is born under a control version**, and the
  provider then decides on it under that version: card
  `e2d9252d-…`, four real `simulate/authorize` calls, four `within_controls`
  rows citing control version 1, warm-lane latency 14,729 µs (§11).
* **The default declines nothing the issuer would not already have declined** —
  it is set equal to the `spend_limit` the same issuance call sends Lithic, and
  `defaults.test.ts` asserts the equality against a second, independent
  statement of the figure (§11).

### NOT real, and not claimed

* **The §2 timeout probe has still not been re-run against our own responder.**
  The 6000 ms figure and the `CUSTOMER_ASA_TIMEOUT` stamp come from the
  `httpbin.org/delay/20` probe of 2026-09-10, with the third-party caveat §2
  states. Re-running it now would mean disenrolling the live responder and
  pointing every card on the program at a stalling URL for the duration, which
  is not a thing to do to a shared book with other work in flight. The figure it
  produced is corroborated by Lithic's documentation and by their OpenAPI enum,
  and by nothing else.
* **No cold start has been isolated.** §3's "first request on a new instance"
  lane is inferred from a bimodal distribution with nothing between 31 ms and
  125 ms, which is what a per-instance one-off looks like — but the deployed
  function is under continuous traffic from other work on this book, so an
  instance that has been idle for fifteen minutes could not be produced to
  order. The figures are honest; the lane label is an inference.
* **The double-append fix is in the tree and is not yet on the deployed
  instance.** The bug in *The bug the live fail-closed run found* was diagnosed
  against the deployed commit and fixed against `src/lib/cards/store.ts` and the
  route, green on `pnpm typecheck`, `pnpm lint` and the live integration suite —
  but publishing it needs `vercel deploy --prod`, which this agent was not
  permitted to run. **Until that deploy, a delivery whose append misses its
  400 ms budget can still record itself twice.**
* Every decision row written by the **harness** carries `source = 'harness'`.
  The harness (`src/lib/cards/harness.ts`) drives the *same* parser, the *same*
  decision function, the *same* control read and the *same* append — what is
  synthesised is **the HTTP delivery and the payload**, and nothing else.
* The payload shape in `src/lib/cards/fixtures.ts` is built field-by-field from
  Lithic's own published OpenAPI document (schemas `authorization`,
  `asa_request_card`, `transaction_merchant`, `converted_amount`,
  `asa_request_status`), with their own examples where they gave one. **It is a
  shape, not a capture.** A fixture built from a schema proves the parser handles
  the documented contract; only a real delivery proves the provider sends what it
  documents.

### The separation is enforced in SQL, not by convention

`source` is `NOT NULL` with a CHECK. The velocity sum filters on it, so a harness
replay can never eat a real card's daily limit and a real purchase can never make
a harness assertion pass (integration scenario 3c asserts exactly this). The
console renders the lane as a badge on every row. The panel reads Lithic's own
`GET /v1/responder_endpoints` live and says, in words, whether the provider is
calling us — so the screen cannot imply what the data does not support.

---

## 8. The live proof — every control kind, driven by the provider

**2026-09-11, 14:04–14:22Z. Deployed responder, enrolled ASA, real Lithic
sandbox transactions.** Every token below resolves at
`GET https://sandbox.lithic.com/v1/transactions/{token}` with the program's key,
and every decision below is a row in `card_auth_decision` with
`source = 'provider'` and a `request_id` equal to Lithic's own authorisation
event token.

The opportunity this run depended on: the account's daily spend limit was raised
from $5,000 to **$500,000** (`GET /v1/accounts` → `spend_limit.daily 50000000`),
so authorisations **approve** again and the approve branch could finally be
driven from the provider's side rather than argued for.

### The cast

| | Card | Lithic card token | Holder |
| --- | --- | --- | --- |
| A | `…2656` | `84b40e67-0eb3-4309-953e-cfd3b7305d70` | Noor Haddad, Ridgeline Robotics |
| B | `…7024` | `b6a110cf-23e5-404c-91c3-57f417d26991` | Noor Haddad — **a second card, issued for this proof** |
| N | `…2989` | `171dd636-6566-4bc2-b3a1-951b50e157fa` | nobody: a card in this book with **no member** |
| X | `…` | `94c5c5c8-2a30-4a6f-b7fb-f3b262574463` | a real Lithic card **never registered here** |

Noor's own terms (`team_member_version`, migration 0033) were set to
per-transaction $2,000 / daily $300 / monthly $20,000 for the member run and
restored afterwards.

### The runs

| # | What it proves | Lithic transaction | Lithic says | We said | µs |
| --- | --- | --- | --- | --- | --- |
| 1 | **an approval that should approve**, under configured controls | `bc441c48-20c9-466c-81f7-07ac8cc1fc1a` | `PENDING` / `APPROVED` | approve · `within_controls` | 174,820 |
| 2 | **per-card per-transaction limit** — $50 against $10 | `e8ec5521-5fcd-47bc-8f2d-945bca77a3e0` | `DECLINED` / `USER_TRANSACTION_LIMIT` | decline · `per_transaction_limit_exceeded` | 157,788 |
| 3 | **merchant-category block** — $50 at MCC 5542 | `8637c2d6-932c-40c1-8448-42e78659115e` | `DECLINED` / `UNAUTHORIZED_MERCHANT` | decline · `mcc_blocked` | 14,441 |
| 4 | **per-card daily limit** — $10 on top of $20, against $25/day | `daca48ff-42e9-4eef-880d-eb44e3af2990` | `DECLINED` / `USER_TRANSACTION_LIMIT` | decline · `daily_limit_exceeded` | 152,485 |
| 5a | $200 on card **B**, which has **no card controls at all** | `cba42fca-2b7f-482c-90d4-ab1c442fd15b` | `PENDING` / `APPROVED` | approve · `within_controls` | 144,101 |
| 5b | **per-member limit summed across cards** | `47e85347-2ea5-4485-8877-628538344b21` | `DECLINED` / `USER_TRANSACTION_LIMIT` | decline · `member_daily_limit_exceeded` | 15,635 |
| 6a | a card with **no member** is judged by its own controls, as before | `caecdc7c-6758-4f23-9c2c-10b690ae27ec` | `DECLINED` / `USER_TRANSACTION_LIMIT` | decline · `per_transaction_limit_exceeded`, `member_id: null` | 143,752 |
| 6b | …and approved when within them | `744a38f9-b033-46fc-8290-f9fcc508ee34` | `PENDING` / `APPROVED` | approve · `within_controls`, `member_id: null` | 14,533 |
| 7 | **the deliberate fail-OPEN**: a token this book has never seen | `eab6c411-39f0-4c68-8ca8-97935436321b` | `PENDING` / `APPROVED` | approve · `card_not_under_control`, `fail_mode: open` | 14,214 |
| 8 | **fail-CLOSED**: the control store made genuinely unreadable (§3) | `8025729c-f3a8-4aa1-bfd5-b42405e16f9a` | `DECLINED` / `USER_TRANSACTION_LIMIT` | decline · `control_store_unavailable`, `fail_mode: closed` | 600,390 |

### Run 5 is the one worth reading twice

The per-member limit is only a limit if it is **one envelope over every card the
person holds**. The two halves of run 5, with the figures straight off the rows:

```
5a  $200 on card B  ->  approve
      member_daily_limit_cents  30000
      member_daily_spend_cents   2000     (the $20 from run 1, on card A)
5b  $200 on card A  ->  decline  member_daily_limit_exceeded
      scope              "member"
      window             "day"    window_basis "book_date (America/New_York)"
      limit_cents        30000
      spend_cents        22000    <-- $20 on card A  +  $200 on card B
      would_total_cents  42000
      over_by_cents      12000
```

**Card A's own daily spend at that moment was $20.** Nothing about card A's own
controls could have produced that decline: version 5 on card A had
`per_txn 200000, daily NULL, monthly NULL` — deliberately opened right up, so
the only thing left that could refuse was the person. The $22,000 in
`spend_cents` is arithmetic that can only come from summing both cards, and the
row cites `member_version 2` so the terms it was judged under are pinned.

### And the version pinning, which is what makes this a bank feature

Card A moved through six control versions during the run, and every decision
cites the one that was current when it was made: run 2 cites version 2 with
`limit_cents 1000`, run 3 cites version 3 with `blocked_mccs "5542"`, run 4
cites version 4 with `limit_cents 2500`. Version 6 now has no blocks and a
$2,000 limit. **Run 3's row still says `decline`, still says `mcc_blocked`, and
still cites version 3.** A later control change cannot retroactively re-judge a
past authorisation — asserted for the harness lane in integration scenario 4,
and demonstrated here against the provider's own traffic.

### The book was left as it was found

* Every approval in the table above was expired with
  `POST /v1/simulate/void {type: "AUTHORIZATION_EXPIRY"}`, so the run left no
  dangling hold on the demo book: `bc441c48`, `cba42fca`, `744a38f9` and
  `eab6c411` all read `EXPIRED` at Lithic.
* Noor's terms were restored to per-transaction $2,000 / daily $5,000 / monthly
  $20,000 as terms version 3; card A rests at control version 6 mirroring them;
  card N's limits were lifted in version 2.
* **`card_control_version` is append-only, so "restored" means a new version and
  not an erased one.** Card N had *no* controls before this run and now has two
  versions, the second with every limit `NULL` — which approves exactly as it
  did before, under rule `within_controls` rather than
  `no_controls_configured`. That is a permanent, visible footprint of the proof
  and it is stated here rather than tidied away.
* `node scripts/dbcheck.mjs` reads **38 passed / 4 failed** and `--prove` covers
  **26 of 26** invariant views, before and after.

### Re-running it

```bash
set -a; . ./.env; set +a

# the responder is live and enrolled — confirm both before touching anything
curl -s https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth            # 405 + budget
curl -s "https://sandbox.lithic.com/v1/responder_endpoints?type=AUTH_STREAM_ACCESS" \
     -H "Authorization: $LITHIC_API_KEY"                                        # {"enrolled": true, ...}

# one authorisation: the simulator is keyed by PAN, not by card token
curl -s "https://sandbox.lithic.com/v1/cards/$CARD_TOKEN" -H "Authorization: $LITHIC_API_KEY"   # .pan
curl -s -X POST https://sandbox.lithic.com/v1/simulate/authorize \
  -H "Authorization: $LITHIC_API_KEY" -H 'content-type: application/json' \
  -d '{"amount":5000,"merchant_amount":5000,"merchant_currency":"USD",
       "descriptor":"CORGI FUEL PUMP","pan":"'"$PAN"'","status":"AUTHORIZATION","mcc":"5542"}'
# then GET /v1/transactions/{token} and read card_auth_decision for the same token
```

`POST /v1/simulate/authorize` answers **201**, not 200, and it returns a token
for a decline as well as an approval — so never read the presence of a token as
approval; read the transaction.

### Rolling back the enrollment

```bash
curl -s -X DELETE "https://sandbox.lithic.com/v1/responder_endpoints?type=AUTH_STREAM_ACCESS" \
  -H "Authorization: $LITHIC_API_KEY"
```

Disenrolling restores the program's default behaviour — Lithic applies its own
$5000/day limit to programs with no ASA responder — and the decision history
stays exactly where it is, because it is append-only.

---

## 9. The console panel

`src/components/accounts/CardControlsPanel.tsx`. It shows how much of the
customer's estate is under control at all (§11), the current control set per
card, the forms that append a new version, the latency budget (imported from the
module the route runs to, so it cannot drift), whether Lithic is actually
enrolled (read live from the provider), and the decision history with the rule,
the reason, the control version, the latency and the source lane.

### Five URL-driven states, on `?controls=`

A different parameter from the console's `?state=` on purpose, so the two can be
posed independently — the card console can be in its over-capture edge state
while the control panel shows a fail-closed decline.

| URL | State |
| --- | --- |
| `/accounts` | **default** — live: real control versions, real decisions, real enrollment status |
| `/accounts?controls=loading` | **loading** — the real skeleton, in front of a genuinely slow read (3 s), not a mock of one |
| `/accounts?controls=empty` | **empty** — a card that exists and has never had a control set. Not an error |
| `/accounts?controls=error` | **error** — the panel's own read failed. Names the difference between this and the decision path, which would decline |
| `/accounts?controls=edge` | **edge** — the fail-closed decline: `control_store_unavailable`, 601,412 µs, recorded and explainable |

The three fixture states write nothing and read nothing, the same rule the card
console follows: a fail-closed decline is not a condition you produce on a live
database to show someone.

### It is mounted, and it renders the live decisions

`src/app/(app)/accounts/page.tsx` mounts it after `<DemoAccountDirectory />`.
`CardControlsPanel` is a synchronous server component that renders its own
Suspense boundaries, so it needs no `<Suspense>` wrapper at the call site and
cannot slow the page above it.

**Read off the deployed page on 2026-09-11T14:20Z**, Ridgeline Robotics, after
the §8 run — counted in the rendered DOM rather than asserted about:

```
"Card controls" heading            present
enrollment status                  present
within_controls                    12 rows
per_transaction_limit_exceeded      9
daily_limit_exceeded                2
member_daily_limit_exceeded         1
mcc_blocked                         1
badge "provider"                   26      badge "harness"  10
latencies rendered in µs           25
```

The first reading of that same page is what found the §5 visibility bug:
`control_store_unavailable` appeared **0** times, on a page belonging to the
customer whose card had just been declined by it. It appears now.

**It has been rendered, not merely compiled.** A component no route mounts is a
component `tsc` checks and nothing ever runs, which is how a crash ends up in
somebody else's page for reasons they will reasonably assume are theirs. So
`src/lib/cards/panel.render.test.ts` renders all five states through
`renderToReadableStream`, waits on `stream.allReady` so every Suspense boundary
resolves, and re-throws from `onError` rather than letting React log a
recoverable error and emit a fallback that would pass. The live states read Neon
and probe Lithic's enrollment endpoint for real; nothing in it writes.

---

## 10. What is deliberately not built

* **A voided authorisation does not give its velocity slot back** until the
  window rolls (§6). Conservative direction; a second query on a budgeted path.
* **No per-merchant or per-country rules.** MCC and amount are the two controls
  that earn their place; a rule engine is a different feature.
* **No partial approval.** `approved_amount` is never sent. A limit is a
  refusal, not a negotiation: partially approving an authorisation that broke a
  limit would create a hold for an amount the customer never agreed to and a
  settlement the control never judged.
* **No `CHALLENGE`.** It needs a cardholder phone number and an SMS flow, and a
  challenge nobody can answer is a slower decline.
* **A signature refusal writes no decision row.** Nothing was decided, so there
  is nothing to record — but it means an attack on this endpoint is visible only
  in the structured log (`asa.refused`, with `signatureHeadersPresent` and
  `secretsAvailable`) and not on a screen. If ASA runs in anger, that log line
  wants an alert.
* **The ASA HMAC secret is fetched at runtime, not configured.** One fewer
  secret to distribute, and a 10-minute cache picks up a rotation inside the
  24 hours Lithic keeps the old key alive. The cost is a dependency: if Lithic's
  API is unreachable on a cold instance we cannot verify, and we decline. Same
  fail-closed argument, applied to authentication.
* **A voided authorisation's velocity slot, again** — now with a live example.
  §8 expired four approvals with `simulate/void`, and all four still hold their
  slot in today's daily window. Card A's $20 and card B's $200 are gone from
  Lithic and still counted by us until midnight in `America/New_York`. The error
  is towards declining, which is the right direction for a control; it is still
  an error, and the fix is a second query on a budgeted path.

### Still owed, named rather than left to be discovered

* **The double-append fix is not deployed.** It is in the tree and green; it
  needs `vercel deploy --prod`. Until then the deployed responder can still
  record one delivery twice when an append misses its 400 ms budget — a decline
  that merely looks wrong, an approve that would spend its limit twice.
* **The §2 timeout probe against our own responder.** Removing the
  `httpbin.org` caveat means disenrolling the live responder and pointing every
  card on the program at a stalling URL. Not while other work shares this book.
* **A real cold start.** The deployed function is never idle long enough on this
  book to isolate one; §3's cold lane is inferred from the shape of the
  distribution and says so.
* **An alert on `asa.refused`.** Still the only trace of an attack on this
  endpoint, and still only in the log.

---

## 11. The gap this feature had, and the default that closes it

Everything above is about a decision path that works. This section is about the
fact that, for most of this book's estate, **it had nothing to decide with**.

### The finding, measured before anything was changed

`2026-09-11T15:20Z`, against the live book:

```
SELECT source, outcome, rule, count(*) FROM card_auth_decision GROUP BY 1,2,3;

  128 decisions, 68 of them source = 'provider'.
  Of 51 provider-lane APPROVALS:
      no_controls_configured   38
      card_not_under_control   10
      within_controls           3

SELECT count(*), count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM card_control_version v WHERE v.card_id = c.id)) FROM card c;

  911 cards.  31 with any control version at all.
```

**Forty-eight of fifty-one approvals were produced by a rule that judged
nothing.** §8 proved every control kind against the provider's own traffic at a
p50 of 14.2 ms, and then that machinery sat over a book where almost no card
was under it. The real-time decision path was mute on nearly every
authorisation it saw.

### Why. It is not `decide()`, and `no_controls_configured` is not the bug

Rule 15 is **intended**, and it stays exactly as it is. The control read
*succeeded* and told the truth — nobody has said anything about this card — so
it approves, with `fail_mode` on the row. That is the same fail-OPEN argument
rule 2 makes at the scope boundary (§5), it is unit-tested, and flipping it
would decline live cards for a reason no customer chose.

The gap is **provisioning**, and it is one sentence long:

> Before today, `setCardControls()` had exactly **one caller in the entire
> tree** — `setCardControlsAction`, the `/accounts` server action, reachable
> only by a human pressing Save.

Both issuance paths — `issueCardAction()` in
`src/app/(app)/accounts/actions.ts` and `issueCardForMember()` in
`src/lib/team/lifecycle.ts` — call Lithic's `createCard()`, then
`registerCard()`, and stop. **No control is created when a card is issued, by
anybody.** A card was born uncontrolled unless somebody remembered to open a
screen and type limits in. Thirty-one people remembered, out of nine hundred
and eleven cards.

So the answer to "is `no_controls_configured` an intended default or an
accident of nothing calling the writer" is **both, in different places**: an
intended default sitting on top of an unintended gap. Only the second is a bug,
and only the second was changed.

### The default: a per-transaction ceiling of $5,000.00, and why that one

Three defaults were available and they are genuinely different products.

**A daily limit is the most useful and the wrong default.** Whatever number is
picked, no customer picked it. The first thing it does is decline a real
purchase at a counter on a card whose owner never agreed to it, and the
operator who has to explain it cannot, because the honest answer is "an
engineer guessed". A daily limit is the right *second* control: set on the
screen, by a person, as version 2, with the mandatory note saying why.

**An MCC block list is the most opinionated and the worst default.** A block
list is a policy about what a business may buy, and we do not know Kettle &
Crumb's policy. Inventing one declines at the till with
`UNAUTHORIZED_MERCHANT`, which reads to the cardholder as a broken card rather
than as a rule.

**A per-transaction ceiling is the least surprising, and one particular
per-transaction ceiling is provably behaviour-neutral.** Both issuance paths
already send Lithic `spend_limit: 500000` with
`spend_limit_duration: "TRANSACTION"` (`CARD_SPEND_LIMIT_CENTS`). Every card
this system has ever issued is **already** under a $5,000 per-transaction
ceiling enforced by the issuer, whether or not ASA is enrolled and whether or
not this system is up. Setting our default equal to it means

> **the set of authorisations this default newly declines is EMPTY**

because it is the same predicate on the same axis with the same inclusivity —
`spend + amount > limit`, so $5,000 exactly is permitted on both sides. That is
not "a number large enough that it probably will not fire". It is a number that
*cannot* fire without Lithic having already declined, which is the only kind of
default that can be applied to a book with live demo cards on it without a
rehearsal. `defaults.test.ts` asserts the equality against a second,
independent statement of the figure, so raising the provider-side limit and
forgetting ours fails a test rather than a cardholder.

**What it buys, given that it declines nothing.** Four things, and the fourth
is the one that matters most:

1. **The decision is judged rather than waved through.** The row changes from
   `no_controls_configured` — `control_version_id` NULL, nothing to cite in a
   dispute — to `within_controls` with a **pinned** control version.
2. **The off switch exists.** `card_state` is a real field with a real current
   value, so freezing the card is a version bump on an existing chain rather
   than the first control anyone ever set. Freeze is the promise this feature
   makes (§5); it should not depend on having been configured first.
3. **Attribution is honest.** Version 1 is authored by a `system` actor,
   `card-control-default` (migration 0051), not by the operator who pressed
   Issue — who issued a card and did not choose a limit. The invariant that
   falls out is one query: **version 1 is the program default; every later
   version is a human on the console.**
4. **Rule 15 becomes a signal instead of noise.** It stops being what normally
   happens and starts meaning exactly one thing: *a card reached this book
   without going through an issuance path that applies the default.* That is a
   provisioning gap, and §11's coverage panel is where an operator sees it.

**And the honest cost, stated rather than buried:** this default makes nobody
safer. It tightens nothing. It converts an unjudged approval into a judged one
and gives the operator somewhere to stand; the actual safety is the daily limit
a human sets as version 2. Claiming otherwise would be claiming a capability no
call has proven.

### Why it is not a trigger, and why the migration writes no control rows

An `AFTER INSERT ON card` trigger would cover every path at once — console,
team, live-fire fixtures, the chaos driver — without editing a module anybody
else owns. It is still wrong, for one reason that outweighs the convenience: it
would make an uncontrolled card **unrepresentable**, and `no_controls_configured`
is a branch this system must keep being able to reach. *A fail-open that cannot
be produced is a fail-open that cannot be tested* — `cards.integration.test.ts`
and the panel's `?controls=empty` state both need a card that has never had a
control set, and demonstrating rule 15 in a debrief is worth more than being
able to say every row has a default.

For the same class of reason, **migration 0051 writes not one
`card_control_version` row**, not even for the cards backfilled below. Controls
have one writer and it is the application. A migration that INSERTed control
rows would be a second writer of the values the card network receives inside
Lithic's authorisation window — precisely the surface `src/lib/mcp/limits.ts`
and `src/lib/api/limits.ts` argue must stay narrow, because *a control change
IS an authorisation decision made in advance, with no person on the path*. The
MCP surface and the public API remain read-only on controls, unchanged.

0051 creates two things and nothing else: the `card-control-default` actor, and
`v_card_control_coverage`.

### The backfill: five cards, named, and the ~880 deliberately left alone

The selection rule, stated so it can be argued with: **a card is backfilled if
and only if a person holds it.** Run through `applyDefaultControls()` — the same
function issuance uses, so a backfilled card and a newly-issued one are
byte-identical at version 1 — from `defaults.test.ts` under
`RUN_CARD_CONTROL_BACKFILL=1`, on `2026-09-11T15:32Z`:

| Lithic card token | Holder | | Outcome |
| --- | --- | --- | --- |
| `e54d6e93-631a-4d9d-9f39-f6e395f655aa` | Alex Whitfield | ••3787 | **applied** — version 1 |
| `249a5d92-a3f0-450b-938c-d1c07e9e534e` | Cass Brennan *(removed)* | ••5601 | **applied** — version 1 |
| `b6a110cf-23e5-404c-91c3-57f417d26991` | Noor Haddad · second card | ••7024 | **applied** — version 1 |
| `d7a79245-c8a0-48b2-a987-3780adeb25b1` | Ruth Castellanos | ••7282 | **applied** — version 1 |
| `43ea116a-b1ed-4023-83b5-ff69bf3e46f1` | Theo Marchetti *(removed)* | ••9128 | **applied** — version 1 |
| `84b40e67-0eb3-4309-953e-cfd3b7305d70` | Noor Haddad | ••2656 | `already_controlled` — **untouched**, at version 6 from §8 |

Five cards written. Nothing else in the estate was touched.

**What was deliberately left alone, and why the residue is honest rather than
unfinished:**

* **~740 fixture cards** — `asa-harness-…`, `test-…`, `team-…`, `fuzz-…`,
  `completion-…`, and the `holds` / `hold` nicknames. They belong to the
  integration, fuzz and completion suites. Giving them controls would move a
  number on a screen and change nothing about any authorisation. That is
  padding, and padding a coverage figure is the same sin as a simulated
  integration presented as live.
* **~200 one-shot `live-fire …` and `corgi core loop …` cards.** Each was
  created by one scripted run, took its single authorisation, and will never
  take another. The *next* core-loop run issues through the console action and
  gets the default without anybody backfilling anything — proven below.
* **Noor's ••2656**, already at version 6 from §8's live proof. The function
  reported `already_controlled` and wrote nothing, which is what the
  `WHERE NOT EXISTS` guard is for.

Two of the five belong to **removed** members. Their cards already decline on
rule 5, `member_removed`, checked before any card-scoped rule — so the default
changes nothing for them either. They are in the list because the selection
rule is about who holds a card, not about whether the control will ever be the
binding one.

### Proven end to end, by the provider, on a card issued after the change

Not argued — driven. `scripts/coreloop.mjs --only 3` against a locally-running
build of the changed code, which POSTs the real `/accounts` issue-card form:

```
Lithic card    e2d9252d-65df-4453-a28e-5f6098d232f7   ••7867
Spend limit    $5,000.00 per transaction              <- what we told Lithic
Card controls  version 1 · program default · $5,000.00 per transaction,
               no daily or monthly limit, no blocked categories
```

Then four real `POST /v1/simulate/authorize` calls at that card's PAN, answered
by the **deployed, enrolled** ASA responder reading the same Neon book:

| Lithic transaction | Amount | We said | Control version | µs |
| --- | --- | --- | --- | --- |
| `44d9a606-22bb-494f-b87f-7300dd6d0b2a` | $50.00 | approve · `within_controls` | **1**, pinned | 173,125 |
| `4dd0644a-928b-4199-976e-6a381f51dcb6` | $10.00 | approve · `within_controls` | **1**, pinned | 147,112 |
| `b0637f39-28c5-40a8-baf9-2d13ad6d0087` | $10.00 | approve · `within_controls` | **1**, pinned | **14,729** |
| `2fb3e6a5-0691-424d-b26a-03d1f2ebf458` | $10.00 | approve · `within_controls` | **1**, pinned | — |

`member_id: null`, `per_txn_limit_cents: "500000"`, `blocked_mcc_count: 0`,
`daily_limit_cents: null`. **This is the card that would have produced
`no_controls_configured` yesterday**: no member, and — before the default — no
controls. The same authorisation, the same verdict, now with something to cite.

The third row is the warm-instance lane at **14.7 ms**, against the 14.2 ms p50
§3 measured before this change. The first two are the cold lane §3 describes.
**Nothing moved.**

All four approvals were expired with
`POST /v1/simulate/void {type: "AUTHORIZATION_EXPIRY"}` — all four read
`EXPIRED` at Lithic — so the run left no dangling hold on the demo book.

### The hot path, re-planned, unchanged

`EXPLAIN (ANALYZE)` on the hot-path statement after the change, live:

```
Limit  (actual time=0.164..0.168 rows=1 loops=1)
  ->  Index Scan using card_provider_key on card c
  ->  Index Scan using card_auth_decision_velocity_idx on card_auth_decision d
  ->  Index Scan using card_auth_decision_member_velocity_idx on card_auth_decision d_1
Planning Time: 1.653 ms
Execution Time: 0.339 ms
```

**One statement, both partial indexes used, 0.339 ms** — against 0.665 ms on the
§3 re-take. `readControlsAndSpend()` was not edited: a card with a default
control version resolves through the `LEFT JOIN v_card_control_current` that was
already there, and the row it finds is the row that join was already looking
for. **No round trip was added**, because none could be: the decision path ends
in a DECLINE if it misses its window, so a control that is correct and late is a
decline. The two remaining seq scans are the same two §3 names.

`v_card_control_coverage` is read by a server component and by nothing else. The
decision path holds a card token, not a business id, and could not call it.

### The gap, made visible — the coverage panel

`/accounts` now opens the card-controls section with **"How much of this
customer's estate is under control"**, three counts from
`v_card_control_coverage`. They are the three branches `decide()` actually
takes, which is why they are these three and not a configured/not pair:

| Bucket | What judges the next authorisation |
| --- | --- |
| **Under a card control** | a control version exists — rules 7 to 11, and the decision pins the version |
| **Covered by their holder** | no control version, but a team member holds it — rules 5, 6 and 12 to 14 |
| **Judged against nothing** | neither. Rule 15, `no_controls_configured`. The loud one |

`has_member` is the bare EXISTS and not "has a member *with limits*",
deliberately: rules 5 and 6 fire on a member's **state** regardless of their
terms, so Theo's card — whose holder is removed, and whose every authorisation
therefore declines — must not be reported as uncontrolled. All five panel states
still render (`panel.render.test.ts`, 7 tests, live Neon, `stream.allReady`).

**Read off the page, counted in the rendered DOM** rather than asserted about —
`/accounts?business=e274546d-…`, Ridgeline Robotics, `2026-09-11T15:44Z`:

```
"How much of this customer's estate is under control"   present
"164 of 228 cards (72%) would have their next authorisation judged
 against something."
Under a card control        27
Covered by their holder    137
Judged against nothing      64     <- the badge reads "64 unjudged"
```

Before this work that page said nothing at all about the other two hundred
cards, which is how thirty-eight approvals-that-judged-nothing went unnoticed
on a screen somebody opened every day.

### Re-measured afterwards, and the number that went UP

`2026-09-11T15:40Z`, the same three counts:

| | before (15:20Z) | after (15:40Z) | again (15:46Z) |
| --- | --- | --- | --- |
| `no_controls_configured` | 38 | **44** | 44 |
| `card_not_under_control` | 10 | **11** | 11 |
| `within_controls` | 3 | **7** | 7 |
| cards, total | 911 | 928 | 935 |
| cards under a control version | 31 | **40** | 43 |

The third column is six minutes later and is here on purpose: **this book does
not hold still.** The three approval counts are stable; the card totals are not,
because other suites are creating cards continuously. Any figure in this
document is a reading with a timestamp, not a constant.

**`no_controls_configured` went UP by six, and that is the honest headline.**
Four of the seven `within_controls` are mine, from the run above, and all nine
new control versions are mine. The six new rule-15 approvals and the seventeen
new cards are **not**: they were written while this work was in progress by the
live-fire and core-loop suites other agents are running on this book, which
register cards straight through `registerCard()` and therefore never touch the
default.

That is not a defect in the default; it is the exact residue the default was
scoped to leave, and it is worth naming precisely because the flattering way to
report this section would be to have measured before those runs landed.

### Still owed, named rather than left to be discovered

* **`issueCardForMember()` does not apply the default.**
  `src/lib/team/lifecycle.ts` is the *other* issuance path — the one where a
  real person gets a card — and it is owned by another slice of this build; it
  was not edited. One line (`applyDefaultControls({ cardId: binding.cardId })`
  after `registerCard()`) closes it. Until then, a card issued from `/team`
  relies on its holder's terms, which is why the coverage panel counts
  "covered by their holder" separately instead of pretending it is the same
  thing.
* **Test and live-fire fixtures still register directly.** `registerCard()` in
  `src/lib/holds/store.ts` is the one chokepoint every path goes through, and
  it is the correct long-term home for the default — but putting it there
  means a control row appearing for every fixture the fuzz suite creates, which
  is the trigger argument in a different costume. The considered answer is that
  the default belongs on the **product** issuance paths (two of them, one done)
  and that fixtures should show up as uncontrolled, because they are.
* **No screen yet lists *which* cards are uncontrolled**, only how many. The
  view has the rows (`SELECT * FROM v_card_control_coverage WHERE cover =
  'uncontrolled'`); the panel renders the newest six cards of a business and a
  count. A "show me the unjudged ones" filter is week two.
