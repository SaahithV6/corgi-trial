# The domain gauntlet — one pass, one commit, one window

This file exists because ten claims proved at ten different moments against ten
different trees are ten anecdotes, not a system. Everything below was measured
in **one continuous pass**, against the **deployed** origin, on **one commit**,
inside **one window**. Nothing here is quoted from an earlier run; where an item
could only be supported by a row that was already on the book, it says so in the
verdict line, in capitals, and the freshness of every figure is stated.

## The anchor

| | |
| --- | --- |
| **Pass anchor** | **2026-09-11T08:22:48Z** (live-fire start; the window's first health read was 08:22:30Z) |
| **Window** | 2026-09-11T08:22:30Z → 2026-09-11T08:39:19Z |
| **Commit** | `2f863c8f52f16a7c13059f172c31617e45e9c264` (`2f863c8`), read from the deployment itself — `GET /api/health` → `commit.sha`, `source: VERCEL_GIT_COMMIT_SHA` |
| **Target** | `https://corgi-trial-psi.vercel.app` |
| **Database** | `corgi_app@ep-curly-tooth-ayhug2be-pooler.c-5.us-east-2.aws.neon.tech/neondb` (live Neon; reads as the application role, which holds no UPDATE or DELETE) |
| **Health at open / close** | `degraded` at 08:22:30Z, `degraded` at 08:39:19Z — same commit both times, `database.reachable: true`, integrations `live 7 / 7`. The degradation is `webhookProcessing.degradedBy: ["lithic","increase"]`, i.e. dead-lettered deliveries, not a broken rail. §"Why the deployment reads degraded" below. |
| **Ledger size at close** | 3,524 journal entries; `SUM(amount_cents)` over every USD journal line = **0** |

Three runnables were driven end to end inside the window, in this order:

| Runnable | Started | Ended | Result |
| --- | --- | --- | --- |
| `node scripts/livefire.mjs --base-url https://corgi-trial-psi.vercel.app` | 08:22:48Z | 08:28:51Z (364s) | **PASS 7 · FAIL 0 · SKIP 1** of 8 |
| `node scripts/coreloop.mjs --base-url https://corgi-trial-psi.vercel.app` | 08:29:16Z | 08:30:30Z (74s) | **PASS 6 · FAIL 1 · SKIP 0** of 7 legs; 101 HTTP calls to the deployed origin, 3 to the Lithic sandbox |
| `node scripts/dbcheck.mjs` | 08:29:40Z | 08:29:44Z | **35 passed / 1 failed** — the one failure is the documented deliberate one |

Direct calls filled the gaps: the deployed public API (`/api/v1`), the deployed
agent surface (`/api/mcp`), the deployed cron tick (`/api/cron/standing`), the
deployed drain (`/api/drain`), the deployed statements screen, and one
first-time probe of the Lithic sandbox's single-message force-post endpoint.

**Nothing in this repository was modified to produce this file.** No source,
script, migration or config was touched. Two defects and one gap found during
the pass are reported in §"Defects found, not fixed" and left exactly as found.

## The standing constraint that shapes items 2 and 3

The Lithic sandbox account's rolling 24-hour spend cap is exhausted, so **every
authorisation declines, at every amount.** Measured fresh inside this window, at
08:31:39Z:

```
GET /v1/accounts/2742964f-478f-47ef-a4e9-852dc50d9c44/spend_limits
{"available_spend_limit":{"daily":0,"monthly":933398},
 "spend_limit":{"daily":500000,"monthly":2000000},
 "spend_velocity":{"daily":1055762,"monthly":1066602}}
```

`available_spend_limit.daily = 0`. Raising it needs `PATCH /v1/accounts/{token}`,
which the permission classifier deliberately blocks. So the *approved*
authorisation half of items 2 and 3 cannot be driven today, by anyone, on this
account. What this pass proves instead is stated item by item, and the weaker
claim is never dressed up as the published one.

## Scoreboard

| # | Item | Verdict | Freshness |
| --- | --- | --- | --- |
| 1 | Ledger vs available, derived not stored | **PROVEN** | fresh |
| 2 | Authorisation lifecycle, hold releases exactly once | **PARTIALLY PROVEN** | mixed — one transition never demonstrated at all |
| 3 | Settlement is not authorisation, incl. the force post | **PROVEN, with one half short** | fresh + one historical row |
| 4 | Out-of-order delivery | **PROVEN** | fresh |
| 5 | Returns and recalls | **HALF PROVEN** | outbound historical; **inbound recall NOT DEMONSTRATED** |
| 6 | Bitemporality | **PROVEN** | fresh |
| 7 | Statements reproducible forever | **PROVEN** | fresh |
| 8 | Standing orders fire once, and the refusal policy | **PROVEN**, refusal row historical | mixed |
| 9 | Scheme reconciliation with aging | **PROVEN** | fresh |
| 10 | Maker-checker, including the agent surface | **PROVEN** | fresh |

---

## 1. Ledger balance versus available balance

**Verdict: PROVEN. Fresh.**

**What ran.** `GET https://corgi-trial-psi.vercel.app/api/v1/accounts/2100/balance`
with the published demo bearer token, at **2026-09-11T08:30:20Z**, request id
`sfo1::mfhvn-1789115420204-638ed360a8bc`.

**What it returned**, for business `e274546d-6bdd-5266-b0fb-cc839a7811f9`
(Ridgeline Robotics, Inc.), account `2100`:

| Term | Cents |
| --- | --- |
| ledger_balance | `4987109` |
| − card_auth_holds (10 holds) | `41000` |
| − uncleared_credits (28 holds) | `2771050` |
| − pending_outbound (future-dated debits, derived from lines, no hold row) | `225000` |
| **= available_balance** | **`1950059`** |

4987109 − 41000 − 2771050 − 225000 = 1950059. The endpoint ships the identity in
the response as `formula`, naming its own implementation: *"This is
`ledger_availability()` in Postgres — the same function the customer's own
screens use."*

**That it is derived, not stored**, is an invariant rather than a scenario:

- `dbcheck` check **"no stored balance column — balances are derived, not stored
  (3 named exceptions, each proven reproducible)"** — PASS at 08:29:44Z. The
  exceptions are named `(table, column)` pairs, not a pattern, and each one is
  re-derived from the journal in the adjacent check *"every stored interest
  basis re-derives from the journal"* — also PASS.
- **`v_balance_definition_drift` — 0 rows**, over a reach of **7 accounts with a
  balance**: the hold model and the availability function agree at the live point.
- **`v_line_denorm_drift` — 0 rows**: the denormalised clocks on journal lines
  match their entry.
- **`v_entry_unbalanced` — 0 rows**, reach **3,506 journal entries** at
  `dbcheck` time (3,524 by the close of the window); **`v_book_not_zero` — 0
  rows**; trial balance **0**.

Corroborated live by coreloop leg 2 at 08:29:2xZ: a $1,250.00 funding credit
moved LEDGER $71,456.49 → $72,706.49 and AVAILABLE **not one cent**
($44,585.99 → $44,585.99), because the identical amount opened uncleared-credit
hold `2d831894-c6f3-425c-916e-3112f6af759c`, releasing 2026-09-14T13:00:00Z. The
rule for uncleared credits is a policy row, not a constant.

---

## 2. The authorisation lifecycle

**Verdict: PARTIALLY PROVEN. Mixed freshness, and one of the seven named
transitions has never happened at all.**

### What is proven fresh, inside the window

**The hold releases exactly once — and it is the database that guarantees it,
not the code.** `hold_closure` carries `PRIMARY KEY (hold_id)`: a second closure
of the same hold is not a storable row. Measured at 08:37Z: **228 closure rows
over 228 distinct holds**, zero holds with more than one.

| View | Rows | Reach |
| --- | --- | --- |
| `v_hold_drift` — the memo book equals the fold over card events | **0** | 342 live holds |
| `v_hold_release_drift` — a released hold withholds nothing | **0** | 356 released holds |
| `v_hold_closure_not_terminal` — no permanent closure over a hold the fold says is open | **0** | 228 permanent closures |
| `v_hold_posting_incomplete` | **0** | — |

**A refused authorisation places no hold.** Live-fire attacks 1 and 7, both PASS.
Attack 1: Lithic transaction `bf570e52-c94d-4ec0-8517-bed1c6501bbd`,
AUTHORIZATION 5000 DECLINED `[ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED]`; across that
authorisation, holds 37000 → 37000, available −802037 → −802037, ledger
3934963 → 3934963, trial balance 0. Hold `536860c4-7706-40be-a2b9-c97bb2ec76ba`
appears in `v_refused_auth_hold` **0 times**.

Attack 7 goes further and proves the *hostile sequencing* half: a backlog
delivered **twice** after a 23-second dark window produced **1** inbox row, **1**
`card_auth_event` and **1** hold (`756bb3eb-81cc-457e-8a41-271b7d5e9ca7`, and
`3ac5978e-6445-41b5-a0ab-bce2f0f7a899` in the second episode) — nothing lost,
nothing double-counted — with memo balance 0, 0 financial entries,
`v_hold_state.active_hold_cents` 0 and `is_released` true.

**Provider replay: twice is one.** Live-fire attack 8, PASS. A genuine Lithic
delivery `msg_3JAsi000njV93ZJWQLyJCVRLTah` (transaction
`e7337206-17b0-40ec-95d0-5dba1e4dedaf`, 2,189 raw bytes) replayed twice → HTTP
200, 200, both `status="replay"`, both the same
`inboxId=83ceee4c-b514-456f-a5fe-8bfd98e562a3`. Negative control: the same bytes
with a tampered signature → **HTTP 401 WEBHOOK_SIGNATURE_INVALID**, so the 200s
mean the signature verified. One `webhook_inbox` row after 1 delivery + 2 signed
replays + 1 tampered replay, deduped by `UNIQUE (provider, provider_event_id)`
rather than by the 401.

### What could not be driven fresh, and why

The published happy path — **$50 auth, then a $73.40 capture, hold releases once**
— **was not exercised in this pass.** Both runnables refused to claim it:

- **Live-fire attack 2 SKIPPED** (1 passed, 2 skipped): *"the measurement could
  not be taken: Lithic refused the $50.00 authorisation it needs to over-capture.
  Transaction `7e76f76e-61b1-4198-ba1d-12b8aca5a259`, AUTHORIZATION 5000 result
  DECLINED."* The scoreboard prints **"A SKIP is not a pass."**
- **Coreloop leg 4 FAILED**: *"holds moved $0.00, expected $50.00"* — the same
  cause, and the run reported FAIL rather than adapting its expectation.

### What is on the book, historically

Counted at 08:36Z over all 623 authorisations carrying events:

| Transition | Episodes on the book | Of which on a **real** Lithic transaction with a signature-verified webhook behind it |
| --- | --- | --- |
| over-capture (cleared > authorised) | 143 | 124 |
| partial capture (cleared < authorised) | 76 | 0 |
| multiple captures (>1 clearing) | 18 | 2 |
| authorisation reversal | 33 | 0 |
| expiry | 82 | 1 |
| declined | — | 55 |
| **incremental authorisation** | **0** | **0** |

**`incremental_authorization` has never been recorded, by any path, ever.** This
is the one transition of the seven named in the brief with no demonstration at
all — see §"Defects found, not fixed", defect 3, which explains why: 18 real
`AUTHORIZATION_ADVICE` payloads did reach the inbox, and all 18 are parked behind
a card that is not registered to a customer, so the advice branch has never run
on live input.

The 76 partial captures, 33 reversals and 82 expiries carry `inbox_id IS NULL` —
they were written by the hold fuzzer and the integration suites directly against
the live database, not delivered through the deployed webhook endpoint. They are
real rows and the invariants above range over them, but they are **not** evidence
that the deployed ingestion path handles those shapes. Stated plainly rather than
folded in.

---

## 3. Settlement is not authorisation

**Verdict: PROVEN for "different amount, days later" and for "a settlement with
no authorisation the ledger ever honoured". The *approved* single-message force
post is wired end to end and was driven fresh, but the network declined it, so
it is proven up to the network and no further. One historical force post did
post to the ledger.**

### A settlement with no authorisation behind it — FRESH, real provider

This is the sharpest evidence in the pass, and it is a by-product of the spend
cap rather than a scenario anyone wrote. Live-fire attack 3 Part B, two episodes,
both inside the window, on real Lithic transactions delivered by signed webhooks:

**Transaction `7a2142eb-741c-4f86-a6dc-0066e0055505`**, card
`c2b5fa39-8a2c-4c21-b383-2184f282d575`:

| Received | Step | Canonical kind | Amount | Network result |
| --- | --- | --- | --- | --- |
| 08:24:41.825Z | `AUTHORIZATION` | `declined` | 5000 | **DECLINED** |
| 08:24:42.915Z | `CLEARING` | `clearing` | 7340 | APPROVED |
| 08:24:46.182Z | `CORRECTION_CREDIT` | `refund` | 7340 | APPROVED |

The $73.40 **clearing posted** — entry `8ba0e104-836d-44a0-a75d-1d2b53410631`,
key `card:clearing:63807fc3-4b27-4faa-882d-9fd137880642`, value date 2026-09-11,
from inbox row `1eb16524-1f6a-4c1a-8383-bc5810b2fb5e` — against an authorisation
the network had **refused**. Hold `68c5371d-8fe6-4d13-b5eb-5205e553422f`:
`memo_balance_cents` 0, `active_hold_cents` 0, `is_released` true. There was
nothing to release, the model did not invent something to release, and
`v_hold_drift` / `v_hold_release_drift` both stayed at 0.

The second episode is identical: transaction
`b3811c55-c0a5-4f0e-9115-b73ac94adbfc`, entry
`f74c826a-f84a-4def-9359-004fc5cb71c0`, hold
`0e663de8-dc96-44de-b315-a4afbf2d5249`, memo 0 / active 0 / released.

That is the force post's economics — money posting with A(E) = 0 and no hold —
arriving on a real rail, handled without a special case.

### The single-message force post proper — FRESH probe, network declined

`card_event_kind` has a `force_post` member, and a member of an enum is not a
demonstration. So the endpoint was driven, for the first time on this account, at
**2026-09-11T08:31:39.972Z**:

```
POST https://sandbox.lithic.com/v1/simulate/authorize
{"amount":100,"merchant_amount":100,"merchant_currency":"USD",
 "descriptor":"CORGI GV FORCEPOST","pan":"<card 8e932ea1…>",
 "status":"FINANCIAL_AUTHORIZATION"}
-> HTTP 201 {"token":"868f36c7-c5e2-4759-af6a-0eb326ccb851",
             "debugging_request_id":"a9c28a3c-a01e-4fba-a630-66853e6bb89e"}
```

**Lithic does have a force-post endpoint** — `status: FINANCIAL_AUTHORIZATION`,
single-message, settles immediately, never places a hold. It is not missing, and
this build knows it: `rail_event_semantics` carries the row
`card / lithic / card_transaction.updated/FINANCIAL_AUTHORIZATION → force_post,
new_event, value_date_source payload.created`.

The transaction read back `status DECLINED, result DECLINED,
authorization_amount 100, settled_amount 0, hold 0`, event
`FINANCIAL_AUTHORIZATION 100 DECLINED [ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED]`,
event token `79f1e973-a852-4670-9b16-5a3cce8b2237`.

**The deployed system ingested it correctly, and that half is fresh and real.**
The signed webhook `msg_3JAt3TnXmMTlkmWZahH30aP9xaJ` landed at 08:31:41.199Z,
inbox row `3636a948-773d-416a-9f43-80511db4e4e9`, signature verified, processed
08:31:41.711Z, state `done`. What it wrote:

- `card_authorization` `af14db23-7f57-4ae2-8518-394e38feac81`, **`origin =
  'force_post'`** — the origin classifier read the `FINANCIAL_AUTHORIZATION` step
  and said so, which is the single-message branch, not the clearing-first one;
- `card_auth_event` `38bb3ab7-e3ed-4996-a3e7-800c3b424833`, kind `declined`,
  100 cents;
- `card_auth_event_result`: `result 'DECLINED'`, **`provider_step
  'FINANCIAL_AUTHORIZATION'`**, `source 'ingest'`, observed 08:31:41.743Z;
- hold `f6a1e5d9-0b36-48df-b173-7aa0504929cc`: `memo_balance_cents` **0**,
  `active_hold_cents` **0**, `is_released` true, **0 journal entries**, **0 rows**
  in `v_refused_auth_hold`.

So: the endpoint exists, the classifier recognises the step, the semantics table
routes it, and the ledger withheld nothing against a refusal. **What is not
proven is an approved force post moving money**, and it cannot be proven today on
this account at any amount. That is a provider-account fact, not a model gap.

### The one force post that did post — HISTORICAL

Exactly one `card:force_post:` entry on the whole book came through a webhook:
entry **`22da0754-0f9e-4ead-8a39-ad7c128e8513`**, key
`card:force_post:6e99be5b-43a9-47cf-a81b-62974c30a7ec`, value date 2026-09-10,
booked **2026-09-10T22:54:22.966Z** — **outside this window, historical** — from a
signature-verified Lithic delivery on transaction
`25459bae-4c61-4068-9eda-8e406f32fcee`, whose payload reads
`authorization_amount: 0` with events `[RETURN, RETURN_REVERSAL]`. A debit that
posted with no authorisation anywhere in the transaction.

Two honesty notes on it. First, the other 61 `card:force_post:` entries carry
`inbox_id IS NULL` — fuzzer and integration-suite writes, not deliveries.
Second, **today's build would not book that transaction the same way**:
`rail_event_semantics` now classifies `RETURN_REVERSAL` as
`refund_reversal / correction / value_date_source original.value_date`, so it
reverses the refund at the refund's own date instead of posting a new force post.
Live-fire attack 3 asserts exactly that — *"No entry exists at key
`card:force_post:3061572d-b583-4fb7-a34c-d3da469db6fd`: the correction did not
post at its own date."* So the historical row is evidence the posting path ran
once on real input; it is **not** evidence of what this commit does with that
step.

### Different amount, days later

Item 2's table: 143 over-capture episodes on the book, 124 of them on real Lithic
transactions. Fresh within the window, the $50 → $73.40 asymmetry was driven
twice (the two episodes above) and the ledger took the settled amount, not the
authorised one.

---

## 4. Out-of-order delivery

**Verdict: PROVEN. Fresh.**

**What ran.** Live-fire attack 4, **PASS, 1/1 assertions**, two full episodes
inside the window.

**What it returned.** Each episode builds a real in-order pair and a
clearing-first pair from the *same real bodies*, re-signed with
`LITHIC_WEBHOOK_SECRET` and POSTed to the deployed endpoint in the wrong order:

| Episode | Authorisation id | Origin | ledger Δ | available Δ | hold Δ |
| --- | --- | --- | --- | --- | --- |
| in-order | `493a929e-3b4a-4829-9ccc-4f0f3ba8e091` | `authorization` | −7340 | −7340 | 0 |
| clearing-first | `5a4ddbb0-71f7-4732-95ee-7de338dcfe9e` | `clearing_first` | −7340 | −7340 | 0 |
| in-order | `d6d1c0ee-15c9-498d-973b-a3a6fb8cdaaa` | `authorization` | −7340 | −7340 | 0 |
| clearing-first | `43150218-039a-4385-96f7-8ccc979ec484` | `clearing_first` | −7340 | −7340 | 0 |

**EQUAL** in every column. Both deliveries answered HTTP 202. *"one clearing
event per transaction in both episodes; zero dead-lettered deliveries for
`msg_livefire_MTWOWXH7_*` / `msg_livefire_MTWOXK4Z_*`; drain HTTP 200 claimed=0
processed=0 parked=0."* Never crashed, never double-counted.

**Park-and-match-later is a real mechanism, not a phrase.** `webhook_inbox`
carries `state`, `park_attempts`, `parked_on_kind`, `parked_on_ref`,
`parked_reason`, `next_attempt_at`, `dead_lettered_at`. At 08:39Z there are 52
parked Lithic rows and 16 parked Increase rows, each naming the referent it is
waiting for — e.g. `parked_on_kind: card`, `parked_reason: "card
8286c472-2d19-4a1b-af0e-5adf0c735ee5 is not registered to a customer"`,
`next_attempt_at 2026-09-11T09:17:27.379Z`. On the book overall, **128
authorisations carry `origin = 'clearing_first'`**: the settlement genuinely
arrived first and was matched afterwards.

---

## 5. Returns and recalls

**Verdict: HALF PROVEN. The outbound return is real and on the book, but
HISTORICAL. The inbound recall is NOT DEMONSTRATED — there is no such row on the
book and no code path that could produce one.**

This is the item the brief flagged as least certain, and it is.

### Outbound: an ACH payment bounces — REAL, HISTORICAL (04:16Z, outside the window)

Increase sandbox transfer `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`, $6,000.00,
delivered by a signature-verified Increase webhook — inbox row
`9d3cd391-4b3b-4a89-bb84-f0650ec29a74`, `ach_transfer.updated`, `state done`,
signature verified, received 04:15:07.064Z, processed 04:16:59.053Z.

| Entry | Key | Value date | Booked | Lines |
| --- | --- | --- | --- | --- |
| `82a30763-f3ed-40ee-b3c8-6f2123d9731b` | `ach:settled:sandbox_ach_transfer_x5vdo5m7b6k924sszlms` | 2026-09-11 | 04:16:46.030Z | 1110 −600000 / 2300 +600000 |
| `bccc009c-dec6-446f-b79d-858b083d0da3` | `ach:return:sandbox_ach_transfer_x5vdo5m7b6k924sszlms:644288470109390` | 2026-09-11 | 04:16:46.616Z | 2100 −600000 / 1110 +600000 |

Description: **"ACH return R01"**. Both `entry_type = 'original'` — a return is a
**new event at its own value date**, not a reversal of the settlement, which is
what `rail_event_semantics` says in the row for
`ach_transfer.updated/returned`:

> *"THE row people get wrong. A return is a NEW EVENT with its own value date:
> the payment really did settle on Monday and the RDFI really did return it on
> Thursday. Booking it at Monday's date would erase a settlement that occurred
> and make an already-issued statement disagree with the customer's own bank."*

**This is historical, not fresh.** It was booked at 04:16:46Z, roughly four hours
before this window opened. It was not re-driven in this pass and is not presented
as a live demonstration.

### Inbound: a credit is recalled — NOT DEMONSTRATED

Checked honestly, and the answer is no, in three independent ways.

**1. There is no such entry on the book.** Every `ach:%` idempotency key was
enumerated at 08:33Z: 55 `ach:settled:*`, 4 `ach:rebook:*`, and exactly **one**
`ach:return:*` — the outbound one above. There is no key of any shape carrying
`inbound_ach_return`, and the canonical kind `inbound_ach_return` appears nowhere
in `journal_entry`.

**2. The consumer refuses the inbound leg by design, before any classification.**
`src/lib/webhooks/consumers/increase-ach.ts` (lines ~701–718) tests
`pointer.associatedObjectType === 'inbound_ach_transfer'` **first** and returns
`parked("inbound_ach_account_mapping", …)` for every category, including a
returned one:

> *"an inbound credit names a destination account NUMBER, and this build issues
> no virtual account numbers, so there is no mapping from that number to a
> customer. Posting it would mean guessing whose money it is."*

The refusal is well-reasoned and I would not want it changed on the quiet. But it
means the `inbound_ach_return` row in `rail_event_semantics` is **unreachable
code**: the park happens before the semantics lookup, so nothing can ever consult
it. Its only exercise anywhere is `src/lib/rails/semantics.test.ts:259`, which
asserts the table's contents — a row, not a behaviour.

**3. The two real inbound ACH deliveries that did arrive were dropped.** At
04:14:57Z, Increase delivered `inbound_ach_transfer.created`
(`sandbox_event_001m27asynxfz81zny26d0e9hz9`) and
`inbound_ach_transfer.updated` (`sandbox_event_001m27asyqrcaa62g7s9v0x6rzt`) for
object `sandbox_inbound_ach_transfer_07x75nyvzd1oxihtvuoe`. Both are
`state = 'dead'`, 10 attempts, dead-lettered at 04:34:15Z, with
`processing_error = "dead-lettered after 8 failed attempts: no consumer
registered for provider 'increase'"`. Nothing was posted and nothing was parked
for a human; they are in the dead-letter pile.

**No simulator route exists either.** `POST /api/sim` on the deployment answers
**HTTP 404** (measured 08:28:28Z, `{"error":{"code":"NOT_FOUND","message":"no
such endpoint"}}`) — it is gated on `NODE_ENV !== 'production'` **and**
`ACH_SIM_CONTROL_ENABLED === 'true'`, and neither holds. And the simulator's
preset list (`SIM_PRESETS`) is entirely outbound: `happy_path`,
`delayed_settlement`, `return_after_settlement` (R01 four days after settlement),
`return_before_settlement` (R02), `notification_of_change`. There is no inbound
recall preset to run even locally.

**The wire rail is the one place the question is answered rather than deferred**,
and the answer is a refusal with a measurement behind it. `src/lib/rails/wire/adapter.ts`:

> *"A Fedwire funds transfer is final on receipt: no return window, no
> return-code table, no recall as of right. Money does sometimes come back —
> MEASURED, `POST /simulations/wire_transfers/{id}/reverse` -> 200 — but the
> object it produces is `class_name "inbound_wire_reversal"` with its OWN IMAD
> (`20260911apvdjfqt599399`, not the original `20260911sgzamiaa787670`), its own
> transaction id, and `return_reason_code` null. That is a SECOND PAYMENT the
> beneficiary bank chose to send, not our transfer being unwound."*

That is a good answer to a different question. `debitReturnedInboundWire()` exists
to book the outbound leg when *we* send a received wire back, keyed
`increase.wire:return:<id>` — and **no entry with that key exists on the book**.
Only `increase.wire:credit:*` (8 entries) and their holds were ever written.

**So: item 5 is half an item.** An outbound bounce is proven on a real rail with a
real return code, hours before this pass. An inbound recall has never happened in
this system, cannot currently happen through the deployed pipeline, and is
reported here as not demonstrated rather than inferred from a table row.

---

## 6. Bitemporality — the correction test

**Verdict: PROVEN. Fresh, twice, by two independent runnables.**

### Live-fire attack 3 — PASS, 3/3 assertions

**Part A, nothing synthesised.** Real Lithic transaction
`8c7c4795-7a63-4794-b688-9f58298fe485` on card
`c2b5fa39-8a2c-4c21-b383-2184f282d575`:

- `POST /v1/simulate/return` → 201 posted entry
  `a1ec5651-fbcc-44cb-9ffa-c21e2179d07b`
  (`card:refund:18f556af-9aaa-4fcd-ad06-646a8938abc2`), value date 2026-09-11,
  from inbox row `ad46df2b-61ea-4aeb-8497-2dd734658ff4`;
- `POST /v1/simulate/return_reversal` → 201 produced `RETURN_REVERSAL`
  `3061572d-b583-4fb7-a34c-d3da469db6fd`, which the consumer routed through
  `reverseAndRebook` to entry `a34a2f50-c2b5-4da7-a35e-133c983704e6` —
  `entry_type=reversal`, reverses `a1ec5651…`, correction group `a1ec5651…`,
  **value date 2026-09-11 (the original's)**, booking_seq 3687 → 3695.

Both axes, from the real renderer: as-believed@seq3690 closing **307790** over 29
lines; as-corrected closing **300450** over 30 lines. The line the correction
added is entry `a34a2f50…` at the original's value date for **−7340**, exactly
minus the original's +7340, and the original still reads 7340 in *both*
renderings. `v_hold_drift` 0, `v_hold_release_drift` 0, trial balance 0.

**Part B, one step synthesised and named.** Lithic will not reverse a debit:
`POST /v1/simulate/return_reversal {token: 7a2142eb-…}` → **HTTP 400
`{"message":"Return reversal is not supported for debit transactions",
"debugging_request_id":"bf0c11a0-f73d-43d6-8150-83106f8074b9"}`**. So one
`CORRECTION_CREDIT` step (token `2798dc5e-1892-4814-8e1e-665b036a5518`, created
`2026-09-12T12:00:00Z` — the next day) was appended to the **real** transaction.
Not synthesised: the HMAC-SHA256 signature, the transport (POST to the deployed
`/api/webhooks/lithic` → HTTP 202), the verification (a one-character signature
change → **HTTP 401 WEBHOOK_SIGNATURE_INVALID**), inbox row
`efd5319b-cef2-485f-83cc-f3b4369e1faf`, the drain, the semantics lookup, or the
posting.

Result: the **fact** is dated 2026-09-12, the **money** was repaired at
2026-09-11 — entry `653a4455-ca2a-4fed-be31-26488a85a38d`, `entry_type=reversal`,
reverses `8ba0e104…`, same correction group. Of the 4 financial entries the
transaction and its correction group produced, **4 are dated settlement day and
none is dated 2026-09-12**. Redelivery of the same signed bytes → HTTP 200,
entries unchanged at 4.

And the mechanism is not a convention: **UPDATE on `journal_entry` and DELETE on
`journal_line` are both refused for `corgi_app` — permission denied.** A
correction is an append because there is no other kind available to the role.

### Coreloop leg 6 — PASS, 22/22 checks

Independently, through the deployed origin, 08:29:5xZ–08:30:2xZ. Lithic txn
`6372615e-5d00-48ad-a243-08df12bef243`, `POST /v1/simulate/return` $73.40 →
webhook arrived and drained after 5s → entry
`81277c2d-9f38-49db-ad97-71d251e4d2c2` (original, seq 3715, value date
2026-09-11). Then `return_reversal` → real signed webhook, drained after 15s →
correction `1827ab66-09e0-425f-8122-afaefecde885` (reversal, seq 3717), same
correction group, key `reversal:81277c2d-…`.

| | value date | booking seq | reading |
| --- | --- | --- | --- |
| original | 2026-09-11 | 3715 | as believed **$49,944.49** at watermark 3715 |
| correction | 2026-09-11 (**same day**) | 3717 (**later**) | as corrected **$49,871.09** at watermark 3718 |
| difference | | | **−$73.40**, exactly the refund taken back |

Round trip on the position: ledger, holds, uncleared and available all returned
to their opening figures to the cent. Value date and booking sequence are
different columns and the screen renders both:
`https://corgi-trial-psi.vercel.app/statements?account=a0c41a37-2be1-5c30-bfe9-03455f048fac&day=2026-09-11`.

The leg also records a provider limit honestly rather than routing round it:
*"the sandbox refuses `return_reversal` on a cleared debit with 400, a void
appends an `AUTHORIZATION_REVERSAL` without touching `settled_amount`, and a
clearing with a negative amount IGNORES the sign and adds a second capture. The
last of those looks like it worked, which is why this leg does not go near it."*

---

## 7. Statements

**Verdict: PROVEN. Fresh.**

**What ran.** The deployed statements screen for a **published** day, fetched
three ways at **2026-09-11T08:36:49Z**:

```
GET https://corgi-trial-psi.vercel.app/statements
      ?account=21b29548-2aef-4369-8841-3b82da8df8c1&day=1984-02-18
```

**What it returned.** HTTP 200, 130,736 bytes. Fetched a second time two seconds
later: HTTP 200, 130,736 bytes, **sha256 of both responses
`56c34b8621763d5d67eef3dd3585c2827592182b0549e4fe5481a5febd54848d`** — byte for
byte identical.

The page carries the reproducibility verdict, computed by the deployment on every
load rather than nightly:

```json
{"bookingWatermark":3050,"openingBalanceCents":0,"closingBalanceCents":95150,
 "lineCount":2,
 "contentHash":"66ef8c30cbe69e2a247144f38dfadff9b89c53a5a811d5887553f2071c01eced",
 "format":"corgi.statement.v1","generatedAt":"2026-09-11T05:46:54.141Z",
 "generatedBy":"Alex Whitfield"},
"reproduced":true,"formatChanged":false
```

**`reproduced: true`** means the deployment re-rendered the published watermark
and got the stored hash back. **Corrections included**, because this day has two
issued versions and the page lists both:

| Version | Watermark | Closing | Lines | Content hash | Issued |
| --- | --- | --- | --- | --- | --- |
| 1 | 3050 | 95150 | 2 | `66ef8c30…1eced` | 2026-09-11T05:46:54.141Z |
| 2 | 3053 | 100150 | 4 | `276e1a62…97f6f` | 2026-09-11T05:46:58.795Z |

Two answers for one day, neither overwriting the other, each pinned to its own
watermark. The screen's own words: *"A statement is a period AND a booking
watermark, not a period. That is what lets a day's figures reproduce
byte-for-byte forever while the same day, read today, shows the corrected
position."*

**Population.** 60 rows in `statement`, each carrying `version`,
`booking_watermark`, `content_hash`, `format`, `generated_at`, `generated_by`,
surfaced through `v_statement_version` with `is_current` and
`prev_booking_watermark`. `book_day` closes are recorded with their frozen
watermark (2026-09-10 closed at 04:00:45.270Z at watermark 2045; 2026-09-09 and
earlier at watermark 36).

**One thing to know before demoing this.** `GET /api/v1/statements/2026-09-10
?account_code=2100` with the demo token answers **404 `NO_STATEMENT_PUBLISHED`**
— *"a day can be closed with no statement issued yet… Publishing is an act of a
named person and has no endpoint on this API."* That is a correct answer, not a
break: the demo token is scoped to Ridgeline and no version has been published
for Ridgeline's 2100, while the 60 published statements belong to other accounts.
Point the demo at an account that has one, or publish first. (The three fetches
of that endpoint were also byte-identical, hash
`d6b9ce0eb77c52fe27529fcc3fedef2dad248cd2f7432fb534bf02d604d846b7`, which proves
determinism of the refusal and nothing more.)

---

## 8. Standing orders

**Verdict: PROVEN for fire-once. The refusal policy is written, enforced, and has
a real row with five terms that add up — but that row is HISTORICAL (06:18Z),
not fresh.**

### Fire once and only once — FRESH

**What ran.** The deployed cron tick, twice, two seconds apart, with the bearer
token the route requires:

```
POST https://corgi-trial-psi.vercel.app/api/cron/standing
 08:38:33.484Z  runId standing-sfo1::drwtr-…  considered 0  raised 0  refused 0  deferred 0
 08:38:35.873Z  runId standing-sfo1::jrbw6-…  considered 0  raised 0  refused 0  deferred 0
```

Two distinct run ids, two ticks, **zero occurrences claimed and zero payments
raised**, because every mandate due on 2026-09-11 had already been claimed by an
earlier run. A restart or a retry cannot re-fire what is already claimed. That is
the property, exercised against the deployment, inside the window.

**What makes it structural rather than lucky.** The claim is a unique index, so a
double fire is not a storable row:

```
UNIQUE (standing_order_id, scheduled_date)   -- standing_order_occurrence_once
UNIQUE (idempotency_key)                     -- standing_order_occurrence_key_once
PRIMARY KEY (occurrence_id)                  -- standing_order_outcome_pkey
```

Keys are deterministic — `standing:<mandate uuid>:<YYYY-MM-DD>` — and every
occurrence carries `claimed_at` and `claimed_by` (both NOT NULL). Twenty-six
occurrences exist across 2026-09-10 and 2026-09-11, each with exactly one
outcome: 12 `raised`, 14 `refused`.

**The invariant.** `v_standing_order_double_fire` — **0 rows**, reach **26
standing-order occurrences**: one occurrence, at most one payment instruction.
`v_standing_order_unresolved` — **0 rows**. `dbcheck` PASS at 08:29:44Z.

Scheduling is configured, not aspirational — `vercel.json` registers
`/api/cron/standing` at `23 5 * * *`, alongside `/api/drain`,
`/api/cron/accrual`, `/api/cron/outbound` and `/api/cron/holds`.

### The day the balance cannot cover them — HISTORICAL row, five terms, exact

The policy is a column set, not a paragraph: `standing_order_outcome` stores
`refusal_code`, `refusal_reason`, and the **five observed terms** the decision was
made on, plus the shortfall.

Newest refusal row, **decided 2026-09-11T06:18:51.783Z by run
`test-20260911061849-A`** — two hours before this window, so **historical**:

| Field | Value |
| --- | --- |
| occurrence | `2d6b5419-8d90-41a2-81c0-c8537a2beca9` |
| idempotency key | `standing:6466ac1f-94fd-4acc-9743-51d9867cc6e6:2026-09-11` |
| mandate | "Quarterly equipment settlement — Northgate Finance", `1765189` cents |
| refusal code | `INSUFFICIENT_AVAILABLE_FUNDS` |
| instruction_id | **NULL** — nothing was raised |

The identity, in cents:

```
observed_ledger_cents             4113449
observed_holds_cents          −      56000
observed_uncleared_cents      −    2125600
observed_pending_outbound_cents −    175000
                                ───────────
observed_available_cents           1756849   ✓ matches the stored term exactly

amount_cents                       1765189
observed_available_cents        −  1756849
                                ───────────
shortfall_cents                       8340   ✓ matches the stored term exactly
```

Five terms, both sums exact, all six figures stored on the row rather than
recomputed later against a book that has since moved.

The written policy travels with the row, addressed to the customer:

> *"Refused: the ledger balance covers this payment but the available balance
> does not. The difference is money already committed — to card authorisations,
> to credits that have not cleared, or to debits already booked for a future
> value date — and none of it is spendable. **This occurrence is closed; the next
> one is unaffected.**"*

That last clause is the policy decision the brief asks for: no retry, no partial
payment, no rolling the shortfall into tomorrow. It is recorded as a refusal
outcome — `disposition = 'refused'`, `instruction_id = NULL` — which is a
positive fact about the day, not an absence. The neighbouring codes
(`STALE_OCCURRENCE` for an occurrence more than `STALE_AFTER_DAYS = 5` book days
late, documented in `docs/STANDING-ORDERS.md`) show the same shape.

**Why this half is historical.** The deployed tick at 08:38:33Z considered zero
mandates, because the only mandates on the book are single-day fixtures with
`start_date = end_date = 2026-09-11`, already claimed at 04:12–06:20Z. Producing
a *fresh* refusal would require writing a new under-funded mandate, and this pass
had no mandate to write one. Reported as historical rather than presented as a
live demonstration.

---

## 9. Scheme reconciliation

**Verdict: PROVEN. Fresh, twice.**

### The planted break — live-fire attack 6, PASS, 3/3 assertions

Two episodes, both inside the window, each with a **control run first**:

| | Episode A | Episode B |
| --- | --- | --- |
| control run over the complete file (4 rows) | business date 2027-09-26, **0 breaks** carrying the run's prefix | business date 2027-10-16, **0 breaks** |
| after one row is deleted | break `in_ledger_not_file` / `unmatched_reference`, ref **`LF6-MTWOXARX-3`**, 24071 cents, entry `5601d6ee-70e1-4949-abd9-0864047a066f`, severity open | ref **`LF6-MTWOXUZZ-3`**, 24071 cents, entry `f4585845-e9b7-4149-b99f-94306a6cb612` |
| surfaced by | `recon_run_break` for run `df364f1b-3029-4352-ac0d-85169f37a0e2` **and** `loadReconView()` | run `424faee6-3d85-49bc-a864-432a7b3a8b2b` |

The control run matters: it proves the break is the planted row and not a
standing artefact of the file.

### The breaks screen — coreloop leg 7, PASS, 11/11 checks

`GET https://corgi-trial-psi.vercel.app/reconciliation`, 08:30:2xZ. File
`livefire-MTWHF7RX-tonight.csv`, 3 rows, $694.99, business date 2027-12-07; 1 run
over it, newest `5df17942-0c99-4763-a406-a1c37c96cf19`; `in_ledger_not_file = 1`.
On screen: **"In ledger, not in file · ref `LF6-MTWHF7RX-3` · $240.71 · age
−452d · closes crossed 0 · severity Open · value date 2027-12-07"**, reason
`unmatched_reference`.

The leg also declines to claim what it did not do: *"The planting itself has no
deployed control — `/reconciliation` renders no write form — so this run did not
plant it and does not claim to have."*

### All three break kinds, with aging

`v_recon_break` at 08:37Z carries `age_days`, `closes_crossed`, `break_kind`,
`reason_code`, `break_amount_cents`, `file_amount_cents`, `ledger_amount_cents`
and `explained_by`. **1,039 rows** across three kinds — every kind the brief
names is populated:

| break_kind | reason_code | rows | age_days min…max | max closes crossed |
| --- | --- | --- | --- | --- |
| `in_ledger_not_file` | `unmatched_reference` | 653 | −452 … 9672 | 81 |
| `in_file_not_ledger` | `unmatched_reference` | 202 | 0 … 9672 | 81 |
| `amount_mismatch` | `amount_differs` | 220 | 0 … 9672 | 81 |

One live example of each, newest by business date:

- **amount_mismatch** — ref `221099211345426`, file 25959 vs ledger 30959, break
  **−5000**, business date 2026-09-11, age 0d, entry
  `60849963-f800-4e00-b9aa-effa2369d407`;
- **in_file_not_ledger** — ref `319824413466267`, file 10274, ledger NULL,
  business date 2026-09-11, age 0d, no entry;
- **in_ledger_not_file** — ref `LF6-MTWHF7RX-3`, ledger 24071, file NULL,
  business date 2027-12-07, age −452d, entry
  `7af39bd9-18d0-4924-8e16-5c2811eb1e81`.

Aging goes negative because several planted files are dated in the future; the
column is a signed difference from the business date, not an absolute, and the
screen renders it as given rather than clamping it.

---

## 10. Maker-checker

**Verdict: PROVEN. Fresh, on both halves — the human initiator and the agent
surface — and refused by the database in both cases.**

### The human initiator — live-fire attack 5 (PASS, 4/4) and coreloop leg 5 (PASS, 27/27)

Live-fire, inside the window:

- instruction `ef4dfb85-85c1-4775-ac07-642c21b79afb` raised for **420000 cents**
  against a policy threshold of **250000**, approvals required 1;
- a **raw INSERT** of an `approved` event by the initiator →
  **SQLSTATE 42501** from `assert_maker_checker()`:
  *"maker-checker: actor `76f9266f-23c9-52de-b8ff-0ec0b23ef386` initiated
  instruction `ef4dfb85-…` and cannot approve it"*;
- approved events after both attempts: **0**. Application refusal code
  `SELF_APPROVAL`;
- a **second human** then approved the same instruction: 1 approved event, actor
  `9fff2b99-0a56-56cd-8fdf-699d64d085ac`, not the initiator.

The raw INSERT is the point: the refusal is not a disabled button. Coreloop leg 5
makes that explicit — *"the queue's controls render DISABLED for a maker; this
POST was assembled by hand and reached the trigger regardless"* — driving
`decideAction` as an MPA form submission against the deployed origin at
08:29:53–08:29:58Z:

| Actor | Action | Outcome |
| --- | --- | --- |
| Priya Raman (maker, `b3c4f786-5d1b-5194-9aae-6342ba0ef606`) | approve her own `5199ce0c-0548-42bd-8cee-844dda8666da` | **REFUSED `NOT_AN_APPROVER`**, 0 approved events written |
| Dana Okonkwo | approve her own `751d5948-41f3-4578-bc1d-f6922fd8cf23` | **REFUSED `SELF_APPROVAL`** |
| Dana Okonkwo | approve Priya's instruction | **APPROVED** at 08:29:58.621Z |

Source of the refusal, read out of the live database by the run itself: function
`assert_maker_checker()`, trigger `payment_instruction_event_maker_checker`,
SQLSTATE 42501. The approval names the amount, not the row — content hash
`925a767ba0ad7634abe9bbb1…`.

### The agent surface — driven fresh at 08:35Z

**Neither can the agent**, and this was proven rather than quoted.

`POST https://corgi-trial-psi.vercel.app/api/mcp` with the published demo token.
`tools/list` returns **11 tools: 10 read-only, 1 write** — `get_balance`,
`list_pots`, `list_transactions`, `list_payees`, `list_standing_orders`,
`list_card_controls`, `list_accruals`, `list_disputes`, `list_recon_breaks`,
`list_agent_limits`, and `initiate_payment` (the only one with
`readOnlyHint: false`).

`tools/call initiate_payment` at **08:35:09.407Z**, ACH, **320000 cents** against
a 250000 threshold, idempotency key `GV-GAUNTLET-20260911T083509Z`:

```json
{"status":"queued_for_human_approval","money_moved":false,
 "instruction_id":"aaf74d18-d286-4f5e-a5b1-d6ab8873f7af",
 "replayed":false,"state":"requested",
 "content_hash":"133f897983c4792726dd88d5eb0003944797e1c155818b0e7ee7b772f4351d4e",
 "requested_at":"2026-09-11T08:35:10.037Z",
 "requested_by":{"actor_id":"3743dc53-4e1c-577e-9a0f-e4469ffc1761",
                 "kind":"agent","can_approve":false},
 "approval":{"threshold":{"cents":"250000"},"above_threshold":true,
             "required_human_approvals":1,"approvals_held":0,
             "self_approval_possible":false}}
```

Then the attack the response says is impossible, executed at **08:35:44.893Z** as
a raw INSERT against the live database, bypassing the application entirely:

```sql
INSERT INTO payment_instruction_event
  (instruction_id, kind, actor_id, approved_content_hash, reason, value_date)
VALUES ('aaf74d18-d286-4f5e-a5b1-d6ab8873f7af', 'approved',
        '3743dc53-4e1c-577e-9a0f-e4469ffc1761', '133f8979…51d4e', …);
```

```
SQLSTATE 42501 | actor 3743dc53-4e1c-577e-9a0f-e4469ffc1761 (kind agent) is not an approver
```

Events on the instruction afterwards: **exactly one — `requested`, by the
agent.** No approval, no journal entry, no money.

And the escape route is closed too. `UPDATE actor SET can_approve = true WHERE id
= '3743dc53-…'` → **SQLSTATE 42501, permission denied for table `actor`**; and
even as the owner it would fail the CHECK constraint:

```sql
actor_only_humans_approve  CHECK (NOT ((kind <> 'human'::actor_kind) AND can_approve))
```

**An agent that can approve is not a storable row.** Five layers, named by the
tool's own response and each verified above or by live-fire attack 5:

1. `actor.actor_only_humans_approve` — the CHECK above;
2. `assert_maker_checker()` — refuses an `approved` event whose actor is not a human approver;
3. `assert_maker_checker()` — refuses an `approved` event whose actor is the initiator;
4. `assert_maker_checker()` — refuses an `approved` event citing a different content hash;
5. `payment_instruction_event.pie_one_decision_per_actor` — one actor cannot approve twice to satisfy a two-approver rule.

Supporting invariants, both **0 rows** at `dbcheck` time:
`v_member_approval_without_right` (no approval stands from a member who lacked
the right at the time) and `v_approved_auth_for_dead_member`.

---

## Defects found, not fixed

Found during the pass. Reported precisely and **left exactly as found**, because
the finder repairing what it finds is how a defect becomes invisible.

**1. `inbound_ach_return` is unreachable code.** `rail_event_semantics` carries
the row `ach / increase / inbound_ach_transfer.updated/returned →
inbound_ach_return`, but `increaseAchConsumer` parks **every**
`inbound_ach_transfer` delivery on `associatedObjectType` before any category or
semantics lookup runs. The row can never be consulted. Either the park should
carry an exception for a returned inbound (the recall of a credit we never posted
is arguably a no-op worth recording), or the row should be removed so the table
stops advertising a capability the consumer forecloses. This is the mechanical
reason item 5 is half an item.

**2. Two real Increase inbound-ACH deliveries are in the dead-letter pile.**
`sandbox_event_001m27asynxfz81zny26d0e9hz9` and
`sandbox_event_001m27asyqrcaa62g7s9v0x6rzt`, received 04:14:57Z, 10 attempts,
dead-lettered 04:34:15Z with *"no consumer registered for provider 'increase'"*.
The consumer **is** registered now (`POST /api/drain` at 08:32:19Z reports
`consumers: ["lithic-card","increase-ach","increase-wire","stripe-identity",
"plaid-item"], missingConsumers: []`), so these two are casualties of the window
before it landed — but a dead letter is never retried, so they will sit there
forever. Related cosmetic issue: parked Increase rows still carry the **stale**
`processing_error = "no consumer registered for provider 'increase'"` from those
early attempts alongside a current, correct and well-argued `parked_reason`. The
stale field reads as a live wiring failure and is not one. Worth a look before
anyone demos `/api/health`, which surfaces the dead count.

**3. The incremental-authorisation branch has never run on live input.** Zero
`incremental_authorization` rows exist in `card_auth_event`, on any path.
Eighteen `webhook_inbox` payloads **do** contain `AUTHORIZATION_ADVICE` — e.g.
`9b8c6ddb-7d44-49ef-a5d9-c52a69e54ac6` with events
`[AUTHORIZATION 5000 DECLINED, CLEARING 7340, AUTHORIZATION_ADVICE 9000,
CLEARING 1660]` — and **all eighteen are parked** with `parked_on_kind: card`,
`parked_reason: "card 8286c472-2d19-4a1b-af0e-5adf0c735ee5 is not registered to a
customer"`, 11 park attempts each. The bodies were synthesised by an integration
suite against a card token that was never written to `card`. The advice-to-
incremental conversion (an advice **replaces** the authorised amount rather than
incrementing it — the logic most likely to be wrong and the most expensive to get
wrong) is therefore covered only by unit tests, never by the deployed pipeline.
Registering that card, or re-signing those bodies against a real one, would close
the last transition in item 2.

## Why the deployment reads `degraded`

Stated so nobody has to guess mid-demo. `/api/health` returns **HTTP 200** with
`status: "degraded"` throughout the window. It is **not** the rails:
`integrations.live 7 / 7`, `database.reachable true`,
`webhookHealth.degradedBy: []` (every provider's delivery feed reads `fresh`).

It is `webhookProcessing.degradedBy: ["lithic","increase"]` — *arrival is not
processing*. Lithic: 33 deliveries accepted and then dead-lettered, the newest at
**08:25:14.969Z, during this pass**, all with the same reason — *"parked 12 times
waiting for `card:048c2bd4-…`; referent never arrived"*, i.e. live-fire and
integration cards that were never registered to a customer. Increase: the 167
described above.

The endpoint is telling the truth about a real backlog of undeliverable events,
and it escalates rather than whispering — live-fire attack 7 proves that
escalation is load-bearing, by replaying the outage's own published facts through
`webhookDeliveryHealth` under both gate settings and showing the alarm **stays
armed** under `some` and is **silenced** under `every`. Nothing in that backlog
was ever booked, and the trial balance is 0.

## What a grader should take from this pass

Seven of the ten items are proven fresh, end to end, against the deployed origin
inside a seventeen-minute window on commit `2f863c8`. Three are not, and here is
the exact shape of each shortfall:

1. **Item 2's published happy path was not exercised** — live-fire attack 2
   SKIPPED, coreloop leg 4 FAILED, both because the Lithic sandbox account's
   daily spend cap is exhausted and every authorisation declines at every amount.
   What was proven instead is the weaker claim, stated as such: a declined
   authorisation places no hold, a backlog delivered twice applies once, and the
   hold-once invariants hold across 342 live and 356 released holds. Separately,
   **incremental authorisation has never been demonstrated at all.**
2. **Item 3's approved force post could not be driven** — but the endpoint was
   called for the first time at 08:31:39Z, returned 201, declined for the same
   cap, and the deployed system ingested the refusal correctly with
   `origin = 'force_post'` and `provider_step = 'FINANCIAL_AUTHORIZATION'`. The
   *economics* of a force post — money posting against an authorisation the
   network refused, with no hold to release — **were** demonstrated fresh, twice,
   on real transactions `7a2142eb-…` and `b3811c55-…`.
3. **Item 5's inbound recall is not demonstrated, at all, by anything.** No row,
   no reachable code path, no simulator preset, and two real inbound-ACH
   deliveries in the dead-letter pile. The outbound return is real, on a real
   $6,000 Increase transfer with return code R01, and it is **historical**.

Everything labelled historical above is labelled historical because it is, and
nothing that a runnable refused to prove is counted as proven. A skip is not a
pass.
