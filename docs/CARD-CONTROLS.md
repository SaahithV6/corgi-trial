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
about a second. **ASA is currently DISENROLLED and the program is in exactly the
state it was in before**, which is deliberate: enrolling points every
authorisation on the program at one URL, and enrolling before the responder is
deployed would decline every card in the estate, including the ones the core-loop
demo uses. Enrollment is a one-line `POST` away and §8 gives the exact command.

`GET /v1/auth_rules` answers `404` on this program, so Lithic's own server-side
Auth Rules product is not available here. ASA is.

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
statement with a `LEFT JOIN` to `v_card_control_current` and a
`CROSS JOIN LATERAL` aggregate.

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

**Server-side execution is 0.11 ms.** The partial index
`card_auth_decision_velocity_idx … WHERE outcome = 'approve'` is used, as
designed. The 600 ms deadline is roughly a **5,000× margin** over the work.

From this laptop — cross-region, over the WAN, the worst case available to
measure — 40 runs of the full query gave **min 61.6 / p50 71.6 / p95 85.5 ms**,
against a bare `SELECT 1` round trip of **p50 67.4 ms** on the same connection.
So the query costs about **4 ms over the network floor**, and essentially all of
the 70 ms is my house. The deployed function runs in `iad1`, in the same region
as the database, where that floor is single-digit milliseconds.

The integration suite asserts the whole read-plus-decide path completes in under
3000 ms (`cards.integration.test.ts`, scenario 7) so a regression fails the
build rather than a cardholder.

**One thing that is NOT yet optimal and is not hidden.** The plan shows a
`Seq Scan on card` — 142 rows on this book, 0.07 ms — because the planner does
not bother with `card_provider_key UNIQUE (provider, provider_card_token)` at
that size. It will use it when the table is large. No index was added for it,
because adding an index the planner already has is how a schema grows things
nobody can explain.

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

### The fail-closed path, proven against a database that is genuinely gone

Not a mocked timer. `APP_DATABASE_URL` was pointed at an RFC1918 blackhole
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

Total rows written by all of the above: **zero**, which the database confirms
(`SELECT count(*) FROM card_auth_decision WHERE source = 'provider'` → `0`).

**The cold start is the real tail, and it is a platform property.** A Vercel
Node function that has been idle pays module evaluation before our first line
runs. The route's import graph is kept deliberately small — `budget`, `asa`,
`decide`, `provider`, `store`, `log`, `rawbody`, and `@/lib/ledger/db` — and it
imports no React, no page code and no provider SDK. It cannot be measured here
because the route is not deployed (§7); the measurement to take after deploying
is in §8.

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
3. **The deadline is ours and it is generous.** 600 ms against a measured 0.11 ms
   of server-side work and a 6000 ms provider ceiling. Missing it does not mean
   "the database is busy", it means the database is gone. Fail-open arguments
   are arguments about *load*; this branch is about an *outage*.
4. **It is auditable either way.** Every fail-closed decline is a
   `card_auth_decision` row with the rule, the driver error and the latency, so
   the customer who was declined can be found, told and made whole. A silent
   fail-open leaves nothing to find.

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

Migration `0014_card_controls.sql`, modelled on `approval_policy` from 0001 for
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

### The rules, in evaluation order

First match wins. `RULE_ORDER` is a separate constant from the display order, so
reordering a table on a screen cannot change what a card is allowed to buy;
`decide.test.ts` asserts the two sets are identical so a rule cannot be added to
the type and forgotten.

| # | Rule | Outcome | Wire result |
| --- | --- | --- | --- |
| 1 | `control_store_unavailable` | decline | `VELOCITY_EXCEEDED` |
| 2 | `card_not_under_control` | approve | `APPROVED` |
| 3 | `balance_inquiry_not_a_purchase` | approve | `APPROVED` |
| 4 | `credit_not_a_purchase` | approve | `APPROVED` |
| 5 | `no_controls_configured` | approve | `APPROVED` |
| 6 | `card_frozen` | decline | `CARD_PAUSED` |
| 7 | `mcc_blocked` | decline | `UNAUTHORIZED_MERCHANT` |
| 8 | `per_transaction_limit_exceeded` | decline | `VELOCITY_EXCEEDED` |
| 9 | `daily_limit_exceeded` | decline | `VELOCITY_EXCEEDED` |
| 10 | `monthly_limit_exceeded` | decline | `VELOCITY_EXCEEDED` |
| 11 | `within_controls` | approve | `APPROVED` |

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
  `cards.integration.test.ts`, 11 scenarios, including the database refusing an
  `UPDATE` on a control version.
* The hot-path query plan and its 0.11 ms execution (§3).
* **The route itself**, over HTTP, signed with Lithic's real ASA secret: all
  four refusal paths, the fail-closed decline against a genuinely unreachable
  database, and the measured 1.01 s worst case (§3).

### NOT real, and not claimed

* **Lithic is not currently calling this system.** ASA is disenrolled (§1, call
  7). The responder route `POST /api/webhooks/lithic-auth` exists, builds, and is
  in the route manifest — but it **is not deployed**, because publishing it
  needed a deploy this agent was not permitted to run. No row in
  `card_auth_decision` carries `source = 'provider'`, and none will until §8 is
  done.
* **The route's APPROVE branch has not been driven over HTTP against a live
  database.** It could have been — but the route hardcodes `source = 'provider'`,
  because it cannot tell a self-signed local request from a real one, and a row
  saying `provider` that Lithic did not send would corrupt the one column this
  whole section rests on. So the happy path over HTTP is left for enrollment
  (§8). It differs from the decline path by no branch at all — same read, same
  `decide()`, same `appendDecision()`, same `asaResponseBody()` — and both are
  covered by the unit and integration suites.
* Every decision row written so far carries **`source = 'harness'`**. The harness
  (`src/lib/cards/harness.ts`) drives the *same* parser, the *same* decision
  function, the *same* control read and the *same* append — what is synthesised
  is **the HTTP delivery and the payload**, and nothing else.
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

## 8. Finishing the live proof — the exact steps

Two commands, in this order. **The order matters**: enrolling before the
responder is deployed points every card on the program at a 404 and declines the
estate.

```bash
# 1. Deploy, so the responder exists at a public URL.
vercel deploy --prod            # or push; the route is src/app/api/webhooks/lithic-auth

# 2. Confirm the responder answers before enrolling anything.
curl -s https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth | jq
#    expect 405 with the budget document — proves the route is live, not a 404

# 3. Enroll.
set -a; . ./.env; set +a
curl -s -X POST https://sandbox.lithic.com/v1/responder_endpoints \
  -H "Authorization: $LITHIC_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"AUTH_STREAM_ACCESS","url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth"}'
#    expect {"enrolled": true}
```

### Then the live-fire script the brief asks for

1. On `/accounts`, set the card's **per-transaction limit to $10.00** and block
   MCC **5542**, with a note. That appends control version N+1.
2. Simulate a **$50 fuel-pump authorisation** from the console above (MCC 5542).
3. Expect: Lithic calls `POST /api/webhooks/lithic-auth`, we answer
   `{"result": "UNAUTHORIZED_MERCHANT"}`, and the transaction comes back
   `DECLINED`. `GET /v1/transactions/{token}` shows the decline; the decision
   history on `/accounts` shows the row with rule `mcc_blocked`, the blocked
   list it matched against, the control version, the latency in microseconds,
   and the badge **provider**.
4. Raise the limit, unblock 5542, re-run: `APPROVED`, rule `within_controls`,
   and the earlier declined row still says `decline` and still cites the old
   version.

### Measurements to take once deployed

* **Cold start.** Leave the function idle 15 min, fire one authorisation, read
  `elapsedUs` from the `asa.decided` log line. That is the number the budget in
  §3 cannot predict from here.
* **Warm p50/p95.** Ten authorisations back to back; `elapsedUs` and
  `decisionLatencyUs` are on every log line and `decision_latency_us` is on every
  row.
* **Re-run the §2 timeout probe against our own responder** rather than against
  a public echo service, which removes the third-party caveat.

### Rolling back

```bash
curl -s -X DELETE "https://sandbox.lithic.com/v1/responder_endpoints?type=AUTH_STREAM_ACCESS" \
  -H "Authorization: $LITHIC_API_KEY"
```

Disenrolling restores the program's default behaviour — Lithic applies its own
$5000/day limit to programs with no ASA responder — and the decision history
stays exactly where it is, because it is append-only.

---

## 9. The console panel

`src/components/accounts/CardControlsPanel.tsx`. It shows the current control
set per card, the forms that append a new version, the latency budget (imported
from the module the route runs to, so it cannot drift), whether Lithic is
actually enrolled (read live from the provider), and the decision history with
the rule, the reason, the control version, the latency and the source lane.

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

### Mounting it

**The panel is written but NOT mounted**, because `src/app/(app)/accounts/page.tsx`
is owned elsewhere. It is two lines:

```tsx
import { CardControlsPanel } from "@/components/accounts/CardControlsPanel";

// inside AccountsPage, after <DemoAccountDirectory /> — note that
// `searchParams` is already awaited into `view` above, so resolve it once:
//   const resolved = await searchParams;
//   const view = parseConsoleView(resolved);
<div id="card-controls" className="scroll-mt-6">
  <CardControlsPanel searchParams={resolved} businessId={view.businessId} />
</div>
```

`CardControlsPanel` is a synchronous server component that renders its own
Suspense boundaries, so it needs no `<Suspense>` wrapper at the call site and
cannot slow the page above it.

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
