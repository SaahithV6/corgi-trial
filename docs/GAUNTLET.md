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
| **Health at open / close** | `degraded` at 08:22:30Z, `degraded` at 08:39:19Z — same commit both times, `database.reachable: true`, integrations `live 7 / 7`. The degradation was `webhookProcessing.degradedBy: ["lithic","increase"]`, i.e. dead-lettered deliveries, not a broken rail. **Re-read 2026-09-11T09:38:36Z on commit `544b481`: `status: "ok"`**, `live 7 / 7`, database 149 ms — the dead-letter backlog no longer degrades the deployment at all (`webhookProcessing.degradedBy: []`). It reads `degraded` again for 180–900 s after any live-fire run, for the Lithic quiet band rather than the backlog. §"Why the deployment read `degraded`" below. |
| **Ledger size at close** | 3,524 journal entries; `SUM(amount_cents)` over every USD journal line = **0** |

Three runnables were driven end to end inside the window, in this order:

| Runnable | Started | Ended | Result |
| --- | --- | --- | --- |
| `node scripts/livefire.mjs --base-url https://corgi-trial-psi.vercel.app` | 08:22:48Z | 08:28:51Z (364s) | **PASS 7 · FAIL 0 · SKIP 1** of 8 |
| `node scripts/coreloop.mjs --base-url https://corgi-trial-psi.vercel.app` | 08:29:16Z | 08:30:30Z (74s) | **PASS 6 · FAIL 1 · SKIP 0** of 7 legs; 101 HTTP calls to the deployed origin, 3 to the Lithic sandbox |
| `node scripts/dbcheck.mjs` | 08:29:40Z | 08:29:44Z | **35 passed / 1 failed** — the one failure is the documented deliberate one. **Re-run 09:40Z: 36 passed / 2 failed**; `v_hold_expiry_drift` joined the gate as a second deliberate red, 9 rows, all released, **zero cents of exposure**. **Re-run 10:07Z: 36 passed / 4 failed** — `v_advice_delta_unsound` (1 row) and `v_hold_closure_unexplained` (4 rows) arrived red from migrations 0042/0043, landed by another worker and not diagnosed in this pass |

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

> **The scoreboard above is the record of the pass and is left exactly as it was
> measured.** Items **2** and **5** each carry an `### ADDENDUM` at the end of
> their section, measured *after* the window (09:03Z–09:17Z) and labelled with
> its own freshness caveat. Item 2's incremental authorisation moves to
> **PROVEN**; item 5's inbound leg moves from *"no reachable code path"* to
> **reachable, classified and exercised — and booking nothing, for a reason that
> is now measured.** Nothing above was edited to say so. Item 5 then carries a
> **second** addendum, measured later still (09:47Z–10:12Z), which moves its
> inbound leg to **PROVEN**: per-business virtual account numbers were issued, a
> real inbound ACH credit was attributed and held unavailable, and a real recall
> booked the corrected position. The scoreboard row still reads HALF PROVEN
> because that is what the pass measured.

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

**`incremental_authorization` had never been recorded, by any path, at the time
of this pass** — the one transition of the seven named in the brief with no
demonstration at all, because 18 real `AUTHORIZATION_ADVICE` payloads had
reached the inbox and all 18 were parked behind a card not registered to a
customer. **This is CLOSED. Re-measured 2026-09-11T09:53Z: `card_auth_event`
holds 8 `incremental_authorization` rows and all 18 of those payloads are
`state = 'done'`.** The ADDENDUM at the end of this section carries the run; the
table above is left as it was measured at 08:22–08:39Z.

The 76 partial captures, 33 reversals and 82 expiries carry `inbox_id IS NULL` —
they were written by the hold fuzzer and the integration suites directly against
the live database, not delivered through the deployed webhook endpoint. They are
real rows and the invariants above range over them, but they are **not** evidence
that the deployed ingestion path handles those shapes. Stated plainly rather than
folded in.

### ADDENDUM — 2026-09-11T09:03:12Z → 09:04:11Z, after the pass

**The incremental branch has now run on live input. The verdict moves from
"one transition never demonstrated at all" to PROVEN, and the run found two
things unit tests could not.**

**Freshness and honesty caveat, first.** This addendum was measured **after** the
window above closed, against the **live Neon database** and the **live Lithic
sandbox**, driven **locally** by a new runnable —
`src/lib/cards/advice-wake.integration.test.ts`,
`RUN_DB_TESTS=1 pnpm test src/lib/cards/advice-wake`. The deployed origin is
still `2f863c8` and no code change was needed for this half: the eighteen
payloads were already in `webhook_inbox`, received and signature-verified **by
the deployed endpoint**, and the only action taken was `registerCard()`. So the
*ingestion* is the deployment's; the *drain* that processed them was local.

**What was done.** Six real Lithic cards — not one; the defect report named only
the most recent — were registered to the customer `attack-02` itself picks (the
first business with a `2100`/`9100` pair by id): **Kettle & Crumb Bakery LLC**,
`1151e7b5-b75b-5f58-bdbf-68cd714178ce`. All six were verified to exist at the
provider (`GET /v1/cards/{token}`, account `2742964f-478f-47ef-a4e9-852dc50d9c44`):

| Card token | Lithic memo | deliveries woken |
| --- | --- | --- |
| `8286c472-2d19-4a1b-af0e-5adf0c735ee5` | livefire overcapture-not-terminal MTWGH101 | 4 parked |
| `86c28a0d-e876-437e-a894-6dbfc1d97d93` | livefire overcapture-not-terminal MTWFOB0Y | 4 parked |
| `aaa0c8b6-02d2-4257-a3ae-8f3d06273a80` | livefire overcapture-not-terminal MTWFP25K | 4 parked |
| `9d673124-0d76-4194-8158-b34a60b1f372` | overcapture-incremental probe | 6 parked |
| `732415b1-d257-4c62-ba75-ab3061b52f6b` | overcapture-incremental probe 2 | 8 parked |
| `49a4c0e8-3c65-40c8-a916-23cdc5d2c3f7` | a3 correction probe | **8 dead-lettered, requeued** |

Then `unparkWaitingFor([{kind:'card', ref}])` — the same call the dispatcher
makes when a consumer reports a card ref — and `drain()`. One drain:
`claimed 41, processed 34, parked 7, deadLettered 0`, 74.3s.

**Result.** All **18** `AUTHORIZATION_ADVICE` deliveries are `state = 'done'`
(were 14 parked + 4 dead). `card_auth_event.incremental_authorization`:
**0 → 8**, every one `result = 'APPROVED'`, `provider_step =
'AUTHORIZATION_ADVICE'`:

| Provider event id | Advice says | Stored as | A(E) after |
| --- | --- | --- | --- |
| `720b4cec-1f4f-4919-b734-c8802a4c90e8` | 6000 | incremental 6000 | 6000 |
| `96341b20-795d-4caf-9314-e213ae9eee52` | 9000 | **incremental 3000** | 9000 |
| `18a1f550-aba3-42df-b512-6f67a38a58e3` | 9000 | incremental 9000 | 9000 |
| `d94e58f6-c395-472d-a1b9-11d1a233ce3d` | 6500 | incremental 6500 | 6500 |
| `fedb5fc7-f128-413c-aa14-69017a18196b` | 9000 | incremental 9000 | 9000 |
| `8e6b0809-cf1c-4afa-8363-c83461452401` | 9000 | incremental 9000 | 9000 |
| `bdae6687-e3c2-4da8-81a6-4adb4cc11e31` | 9000 | incremental 9000 | 9000 |
| `535f87ec-7e6a-4599-8b8f-db3c8e0c5957` | **0** | **incremental 7340** | 0 |

**An advice REPLACES, and the proof is the second row.** Transaction
`1df0baa5-319c-46cb-8e19-fcec89b55f56` carries two advices, 6000 then 9000. The
second is stored as a delta of **+3000**, not +9000. Had the conversion been an
addition, A(E) would have settled at 15000 against a $90.00 fuel stop and
**$150.00 of a customer's money would have been withheld — with the book
balanced, the hash chain verified and every invariant green.** There is no alarm
for that answer. It is now asserted against the provider's own bytes.

**H(E) afterwards, and the hold releasing exactly once.** Transaction
`4d9ddc8d-…` (card `8286c472-…`): `AUTHORIZATION 5000 DECLINED | CLEARING 7340 |
AUTHORIZATION_ADVICE 9000 | CLEARING 1660`. Hold
`29217d35-36fc-44ad-9812-d510ec53ac52` — **opened once** by the advice
(memo entry `be1c9deb-…`, `hold:29217d35…:after:fedb5fc7-…`, 9900 +1660 / 9100
−1660) and **released once** by the final clearing (memo entry `5f05af8c-…`,
9900 −1660 / 9100 +1660). Final `memo_balance_cents` 0, `active_hold_cents` 0.
Financial: `card:clearing:49f2c15c-…` 7340 and `card:clearing:a126f07f-…` 1660,
with their two interchange entries — $90.00, once. Across all nine woken
authorisations: memo 0, active 0, **`hold_closure` 228 → 228** (no new closure,
none duplicated).

**Nothing double-counted, and no invariant moved.** Journal entries
3,531 → 3,577; **trial balance 0** on both sides; Kettle & Crumb's `2100`
−3,905,603 → −3,839,423 (a **$661.80** net debit of real card spend);
`v_refused_auth_hold` **149 → 149** — `node scripts/dbcheck.mjs` read
**35 passed, 1 failed** at 08:29:44Z, the same deliberate one. *(Re-run 09:40Z:
**36 passed, 2 failed**; `v_refused_auth_hold` is 154 as the book keeps running,
and `v_hold_expiry_drift` is the second deliberate red.)* `v_entry_unbalanced`,
`v_book_not_zero`, `v_hold_drift`, `v_hold_release_drift`,
`v_hold_closure_not_terminal`, `v_hold_posting_incomplete`, `v_line_denorm_drift`
— all 0 rows after.

### Two things the real payloads found that unit tests had not

**1. `A(E)` is unfloored, and real provider data drove it negative.** Transaction
`5892c550-b966-4afb-b681-a6456e1cf3c4` (card `49a4c0e8-…`, delivered
2026-09-10T22:35Z, dead-lettered, requeued here). Its six events, **sorted by
`created`** — which is not the order Lithic delivers them in:

```
22:35:26  AUTHORIZATION          5000  APPROVED   A = 5000
22:35:27  CLEARING               7340  APPROVED   C = 7340
22:35:31  AUTHORIZATION_REVERSAL 7340  APPROVED   A = -2340   <-- negative
22:35:32  AUTHORIZATION_REVERSAL 5000  APPROVED   A = -7340
22:35:35  AUTHORIZATION_ADVICE      0  APPROVED   delta +7340, A = 0
22:35:37  CLEARING               7340  APPROVED   C = 14680
```

Lithic reversed **7340** against an authorisation of **5000** — the clearing's
amount, not the authorisation's — and `deriveCardEvents` subtracts a reversal
from the running authorised total with no floor, so `A(E)` went to −7340. The
next advice, an **absolute 0**, was then converted against that negative base and
stored as an `incremental_authorization` of **7340**. No money was affected:
`H = max(A − C, 0)` clamps, and the hold stayed at 0 throughout. But
`authorisedCents` was reported as a negative number on a real transaction, and a
clamp is the only thing standing between that and a wrong hold. Reported, not
repaired — `src/lib/holds/**` was out of this change's write set, and the repair
(floor `A` at 0, or reject a reversal larger than the outstanding authorisation)
is a decision about the model, not a bug fix.

**2. The absolute→delta conversion is order-free per payload and NOT order-free
across payloads.** `src/lib/holds/lithic-events.ts` says the advice conversion is
"a pure function of the payload and therefore still order-free". Per payload,
true. Across the eighteen deliveries it is not, because they are eighteen
**snapshots** of six transactions: delivery 3 carries a prefix of what delivery 4
carries, `deriveCardEvents` converts an advice against the running total **of the
snapshot it is handed**, and `insertCardEvents` writes with
`ON CONFLICT (auth_id, provider_event_id) DO NOTHING`. **The first snapshot to
carry an advice fixes that advice's delta for ever**, and a later, fuller one
cannot correct it. On `535f87ec-…` the stored delta is +7340, the fullest
snapshot's answer; the three-event prefix snapshot would have stored −5000, and
whichever was drained first would have won. A(E) immediately after the advice is
the advice's absolute amount either way — that is what makes "replaces" robust —
but reversals arriving afterwards would then fold onto a different base. That is
why the runnable asserts the **identity** (*after each advice, A(E) equals the
advice's absolute amount*) rather than re-deriving each delta, and why the naive
assertion failed first.

### And the published happy path, which the pass could not drive

Card `49a4c0e8-…`'s backlog is from **2026-09-10T22:35Z**, before the sandbox
daily spend cap was exhausted, and it contains what the cap denied this pass:
`AUTHORIZATION 5000 **APPROVED**` followed by `CLEARING 7340` — the brief's own
$50 → $73.40 over-capture, on a real signature-verified delivery. Two honesty
notes on it. First, it is **historical input processed fresh**, not a fresh
authorisation. Second, **no hold was ever opened for it**: the fullest snapshot
was drained first, and the fold over the complete event set gives A = 0 against
C = 14680, so the hold delta was 0 at every step. The ledger took $146.80 in two
clearings (`card:clearing:45701807-…`, `card:clearing:60e8438f-…`). The
authorised amount and its approval are on the book; the hold lifecycle is not
demonstrated by this transaction and is not claimed from it.

The same card's second transaction, `85ab32c9-a155-4a2f-b0a6-41220d1863cc`
(`authorization_amount 0`, events `[RETURN −7340, RETURN_REVERSAL 7340]`), went
through the **correction** path on real input: refund entry
`d570a14b-2b4f-443d-9608-beb4508c83bd` (`card:refund:38e64623-…`, value date
**2026-09-10**), then `817e2cb3-0b0e-40e4-9b86-ba316ced26f6`,
`entry_type = 'reversal'`, `reverses_entry_id = d570a14b-…`, correction group
`d570a14b-…`, **value date 2026-09-10 — the original's** — with the interchange
entry reversed alongside it (`bbae1089-…` → `03e5bad5-…`). That is item 6's
machinery firing on a delivery that had been dead-lettered.

**Revised verdict for item 2: PROVEN for the incremental authorisation, on eight
real advices across six real transactions, with the hold opening once and
releasing once and no invariant moved. The published $50/$73.40 happy path is
proven up to its ledger postings on historical real input and NOT as a hold
lifecycle. Two model findings are reported above and deliberately not repaired.**

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
parked Lithic rows and 16 parked Increase rows *(re-read 09:47Z: **27 Lithic, 119
Increase** — the Lithic backlog drained and the Increase wire traffic parked)*,
each naming the referent it is waiting for — e.g. `parked_on_kind: card`, `parked_reason: "card
8286c472-2d19-4a1b-af0e-5adf0c735ee5 is not registered to a customer"`,
`next_attempt_at 2026-09-11T09:17:27.379Z`. On the book overall, **128
authorisations carry `origin = 'clearing_first'`**: the settlement genuinely
arrived first and was matched afterwards.

---

## 5. Returns and recalls

**Verdict: HALF PROVEN. The outbound return is real and on the book, but
HISTORICAL. The inbound recall is NOT DEMONSTRATED — there is no such row on the
book.** *(The second half of that sentence read "and no code path that could
produce one" and was **retracted by the ADDENDUM at the end of this section**,
which made the path reachable and then found it wrong. The verdict itself does
not move: still not demonstrated.)*

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
meant the `inbound_ach_return` row in `rail_event_semantics` was **unreachable
code**: the park happened before the semantics lookup, so nothing could ever
consult it, and its only exercise anywhere was
`src/lib/rails/semantics.test.ts:259`, which asserts the table's contents — a
row, not a behaviour. **This is superseded by the ADDENDUM at the end of this
section**: the consumer now reads the inbound object back and asks the table
*before* it refuses, which made the row reachable — and the moment it was
reachable it turned out to be wrong. Read the addendum, not this paragraph.

**3. The two real inbound ACH deliveries that did arrive were dropped — and
have since been recovered.** At 04:14:57Z, Increase delivered
`inbound_ach_transfer.created` (`sandbox_event_001m27asynxfz81zny26d0e9hz9`) and
`inbound_ach_transfer.updated` (`sandbox_event_001m27asyqrcaa62g7s9v0x6rzt`) for
object `sandbox_inbound_ach_transfer_07x75nyvzd1oxihtvuoe`. Both were
`state = 'dead'`, 10 attempts, dead-lettered at 04:34:15Z, with
`processing_error = "dead-lettered after 8 failed attempts: no consumer
registered for provider 'increase'"` — nothing posted and nothing parked for a
human. **Re-read 2026-09-11T09:47Z: both are `state = 'parked'`,
`processing_error` NULL**, carrying the attribution refusal quoted in the
addendum below. Nothing was posted then and nothing is posted now; the
difference is that a human can now see why.

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

### ADDENDUM — 2026-09-11T08:53Z → 09:17Z, after the pass

**The question was asked properly and the answer is NO — an inbound ACH credit
cannot be attributed on this build, and it is measured, not argued. The
unreachable row was therefore NOT deleted: it was made reachable, and the moment
it was reachable it turned out to be WRONG.**

**Freshness and honesty caveat, first.** The provider calls, the webhook
deliveries and the database are all live and fresh. The consumer change and
`db/migrations/0039_inbound_recall.sql` are **applied to the live Neon database**
but the deployed origin is still `2f863c8`, so the drain that processed these
deliveries ran **locally** against the live database. The three deliveries
themselves were received and signature-verified **by the deployed endpoint**.

#### 1. Can an inbound ACH credit be attributed? Measured: no.

```
GET https://sandbox.increase.com/account_numbers   (2026-09-11)
-> exactly ONE object:
   sandbox_account_number_96mzhz3n61f5p0jpvytc
   account_number 7467448488   routing_number 123308582   name "primary"
   account_id sandbox_account_zkfx1wcn4brwoaiyksj6
```

One account number, on the programme's own FBO account, **shared by all six
businesses on this book.** An inbound ACH credit names `account_number_id`, so
the field that should say whose money it is names the programme. There is no
`account_number → business` table in `db/migrations/` and no path that issues
per-customer numbers. The refusal is the schema's, and it is correct.

**And the wire rail's answer does not transfer — which was the specific thing
worth checking.** `increase-wire.ts` books an inbound credit in exactly one case,
`wire_transfer.updated/reversed`, and it can only do so because attribution comes
from **our own outbound transfer**: `Idempotency-Key: payment:<instruction id>` →
`payment_instruction` → account → business. Nothing is read off the inbound
message. ACH has no analogue, because when an outbound ACH payment of ours comes
back it does not arrive as an `inbound_ach_transfer` at all — it arrives as a
`return` block on the **same** `ach_transfer` object, which is the $6,000.00 R01
already proven above. There is no second route in.

#### 2. So the row was made reachable — and was wrong

The consumer now reads the inbound object back and asks the table **before** it
refuses (`src/lib/webhooks/consumers/increase-ach.ts` §4b). Doing so exposed a
defect nothing could previously have exposed. Measured, fresh, end to end:

```
POST /simulations/inbound_ach_transfers {amount: 250000, "ACME SUPPLY CO"}
  -> sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b
     status "accepted", effective_date "2026-09-11",
     trace_number "848154134534850", transfer_return null      08:53:53Z

POST /inbound_ach_transfers/{id}/transfer_return
     {reason: "credit_entry_refused_by_receiver"}
  -> status "returned", ONE new block:
     "transfer_return": {"reason": "credit_entry_refused_by_receiver",
                         "returned_at": "2026-09-11T08:53:59Z",
                         "transaction_id": "sandbox_transaction_wqd6t4p2k5berabecln8"}
```

The seeded row said the recall's value date comes from
`payload.return.created_at`. **The inbound object has no `return` key and no
`created_at` inside one.** That path is the *outbound* object's shape, copied
across by analogy and never measured — because the only code that would have read
it could not be reached. `valueDateFromSource()` would have returned `null` and
parked on every recall for ever.

`0039_inbound_recall.sql` corrects it to `payload.transfer_return.returned_at`.
This is the one case `docs/RAIL-SEMANTICS.md` §5 sanctions changing a live row
without a repair pass alongside: **the row has dated zero postings.**
`SELECT count(*) FROM journal_entry WHERE idempotency_key LIKE 'ach:inbound:%'`
was 0 before and is 0 after. The same migration rewrites both inbound notes,
which described a build that credits a `2100` leaf and opens a `9200` hold — a
capability this build does not have. `canonical_kind` and `semantics` were not
touched: both classifications were right.

#### 3. What the recall now does, end to end, on real deliveries

Three signature-verified deliveries about that transfer reached the **deployed**
endpoint:

| Inbox id | Increase event id | Category | Received |
| --- | --- | --- | --- |
| `68a6c694-a7fd-40e2-bf02-fe0522e8e653` | `sandbox_event_001m27trqh0yenq86vd5051adke` | `inbound_ach_transfer.updated` | 08:53:55.138Z |
| `eff43123-a0ee-44ef-b799-2ace9aafa050` | `sandbox_event_001m27trqfr15eprg7vfwj95gxx` | `inbound_ach_transfer.created` | 08:53:55.164Z |
| `56ebb594-6699-4c45-a472-66515ce8262d` | `sandbox_event_001m27trxvap0pb8jn5a933s7jj` | `inbound_ach_transfer.updated` | 08:54:01.201Z |

Under `2f863c8` all three parked on `inbound_ach_account_mapping` and were on
their way to a dead letter. After the change, drained at **09:17:23.885Z /
09:17:24.414Z / 09:17:24.844Z** — **all three `state = 'done'`**, including the
`.created` arrival notification, which converged because every delivery reads the
same current object back and sees the return.

**The ledger consequence is nothing, and that is the honest answer rather than a
disappointing one.** No entry was written: `ach:inbound:%` is still 0 keys, the
trial balance is 0, and `node scripts/dbcheck.mjs` read **35 passed,
1 failed** at the time — the same deliberate `v_refused_auth_hold`, unchanged at
149 rows. *(Re-run 09:40Z: **36 passed, 2 failed**, `v_refused_auth_hold` 154,
`v_hold_expiry_drift` 9.)*
There was no position to correct, because the credit was never bookable.

**What did change is the inbox, and it is the part that matters
operationally.** Before, a recalled credit left two deliveries re-checking for
five hours and then dead-lettering onto a staff screen under *"an operator must
attribute it by hand"* — pointing a human at money that had already gone back to
the originator. The recall is the fact that **ends** that question, so the
consumer resolves the delivery and names the transfer, which wakes the parked
arrival delivery. Both clear. **The park stopped being a leak.**

#### 4. The credit that has NOT been recalled is still parked, on purpose

`sandbox_inbound_ach_transfer_07x75nyvzd1oxihtvuoe` — the $10,000.00 from
"CORGI TREASURY", `status accepted`, the one the defect report found
dead-lettered — is back in `parked` (redriven) and stays there, with a reason
that now names what it refused and why:

> *"…the object names account_number_id `sandbox_account_number_96mzhz3n61f5p0jpvytc`,
> which is the programme's single FBO number and is shared by every business on
> this book. Nothing was posted. An operator must attribute it by hand, or return
> it to the originator. rail_event_semantics classifies this as
> `inbound_ach_credit` at value date 2026-09-11, from CORGI TREASURY, amount
> 1000000 cents."*

That is real, unattributable money and a live question for a person. **The
consumer never returns it itself** — returning an inbound credit is an operator
action against the provider API, and a webhook consumer that could send money
back is a webhook consumer that could send money.

`0039` adds the operator surface the refusal never had,
`v_inbound_ach_unattributed` — **a report, not an invariant; rows are expected,
and it must not be added to `scripts/dbcheck.mjs`**:

| inbound_transfer_id | age_days | deliveries | still_parked | resolved | recalled |
| --- | --- | --- | --- | --- | --- |
| `sandbox_inbound_ach_transfer_07x75nyvzd1oxihtvuoe` | 0 | 2 | 2 | 0 | **false** |
| `sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b` | 0 | 3 | 0 | 3 | **true** |

#### Revised verdict for item 5

**Outbound: PROVEN, historical** — unchanged from above; the real $6,000.00 R01.

**Inbound: the recall is now REACHABLE, CLASSIFIED BY THE TABLE, DATED FROM THE
FIELD THE TABLE NAMES, AND EXERCISED ON A REAL INCREASE RECALL — and it books
nothing, because this build cannot attribute an inbound credit and therefore
never booked one.** The brief's sentence *"the corrected position appears on the
day it happened"* is **not** demonstrated for the inbound leg and is not claimed:
there was no position to correct. What is demonstrated is the refusal, measured
rather than asserted, and a recall that releases the refusal instead of leaking
into the dead-letter pile.

**The row was not deleted.** Deleting it would have thrown away the only thing
that turned out to be worth knowing — that it named a field the provider does not
send — and would have removed the classification a build with per-customer
account numbers will need on day one. Making it reachable was the cheaper answer
and the more honest one: the table now says what happens, and what happens is
what the consumer does.

### ADDENDUM 2 — 2026-09-11T09:47Z → 10:12Z. The gap was the schema, and it is closed

**The inbound leg is now PROVEN, on real Increase objects, end to end: a credit
arrives at a business's own account number, is attributed, is held under the ACH
availability policy, and is recalled — and the recall books a correcting position
at the day the provider says it happened.** One thing this sandbox cannot produce
is named at the bottom rather than staged around.

**Freshness and honesty caveat, unchanged from ADDENDUM 1.** The provider calls,
the webhook deliveries and the database are live and fresh. The webhooks were
received and signature-verified by the **deployed** endpoint. The consumer change
and `db/migrations/0042_virtual_account_numbers.sql` are applied to the live Neon
database, but the deployed origin is still older than this code, so the drain
that booked these entries ran **locally** against the live database.

#### 1. What ADDENDUM 1 measured is what got fixed

ADDENDUM 1's answer was *"no, and it is measured"*: `GET /account_numbers`
returned exactly one object, the programme's own `primary` number, shared by
every business. So the field that should identify the customer identified the
programme.

`POST /account_numbers` issues more of them. MEASURED, 2026-09-11T09:47Z:

```
POST /account_numbers
     {account_id: sandbox_account_zkfx1wcn4brwoaiyksj6,
      name: "Ridgeline Robotics, Inc.", inbound_ach: {debit_status: "blocked"}}
  -> 200  sandbox_account_number_bh5spt0xmebnj6xq6t3l
          account_number 3164662367  routing_number 123308582  status "active"
```

`scripts/provision-account-numbers.mjs` issued one per business with a `2100`
deposit leaf — seven — and recorded whose each is in `virtual_account_number`:

| business | routing / account | `account_number_id` |
| --- | --- | --- |
| Ridgeline Robotics, Inc. | 123308582 / 3164662367 | `sandbox_account_number_bh5spt0xmebnj6xq6t3l` |
| Kettle & Crumb Bakery LLC | 123308582 / 4629029952 | `sandbox_account_number_zpftz6nlr9yc0b47x4tk` |
| Holds Integration Fixture Co. | 123308582 / 1974459830 | `sandbox_account_number_49ummbukvor7j75lxisw` |
| Pots Integration Fixture Co. | 123308582 / 3538495975 | `sandbox_account_number_93axp4osgowil557ps55` |
| Hold Fuzzer Fixture Co. | 123308582 / 2169552990 | `sandbox_account_number_quey4w91fia43l18yys3` |
| Live Fire — attack 7 | 123308582 / 8900127506 | `sandbox_account_number_lb1cizms7t2nqui3g7tc` |
| Live Fire — attack 3 | 123308582 / 7345287035 | `sandbox_account_number_ttzizcgbmj8zra4fd8od` |

Silverline Freight Co. got none and the reason is on the report row: it has no
`2100` leaf, so there is nowhere for money addressed to it to land. The
programme's own `primary` number is deliberately mapped to **nobody**.

Two measurements came out of running it, neither of them guessed:

- **A repeat `POST` with a used `Idempotency-Key` answers `409
  idempotency_key_already_used_error` and names the object it already issued in
  `resource_id` — it does not replay it.** The script's recovery is to fetch that
  id, which is why a crash between the provider call and the table insert costs
  nothing. Found by running the script twice.
- **`company_name` longer than 16 bytes is rejected** (`Your request contains
  invalid parameters`) — the NACHA Company Name field, enforced rather than
  truncated.

#### 2. The credit, on a real inbound ACH to a business's own number

`sandbox_inbound_ach_transfer_osq6n9a04iypwl40byz1`, **$1,874.25**, addressed to
Kettle & Crumb's own number `4629029952`, `effective_date 2026-09-11`,
`status accepted`, trace `940308578992411`, originator `ITEM FIVE SUPPLY`. The deliveries reached the deployed
endpoint and were drained through the consumer:

| Entry | Key | Value date | Booked | Lines |
| --- | --- | --- | --- | --- |
| `a0f7e533-8858-494b-b67b-0fed8ca37319` | `ach:inbound:sandbox_inbound_ach_transfer_osq6n9a04iypwl40byz1` | 2026-09-11 | 10:08:06.364Z | 1110 +187425 / 2100 Kettle −187425 |
| memo | `hold:0f736c97-…:after:increase.ach:inbound:…osq6n9a04iypwl40byz1` | 2026-09-11 | 10:08:06.364Z | 9200 Kettle −187425 / 9900 +187425 |

**The ledger moved and available did not.** Hold `0f736c97-2a4c-4072-8fd9-e182c35e2d47`,
kind `uncleared_credit`, policy `3bae7e8b` (`ach`/`new`, 2 banking days, 09:00
ET), `available_at 2026-09-15T13:00:00Z`. That is the ACH half of the
availability contrast, and it is the same code the wire rail runs — the only
difference is the policy row, which says zero days for a wire and two for a
stranger's ACH. `v_wire_availability_drift` is still **0 rows**.

#### 3. The recall, on the real return endpoint, at the day it happened

```
POST /inbound_ach_transfers/sandbox_inbound_ach_transfer_osq6n9a04iypwl40byz1/transfer_return
     {reason: "credit_entry_refused_by_receiver"}
  -> status "returned", transfer_return {
       reason: "credit_entry_refused_by_receiver",
       returned_at: "2026-09-11T10:08:11Z",
       transaction_id: "sandbox_transaction_rkx1o76pz439jbr7crkg"}
```

| Entry | Key | Value date | Booked | Lines |
| --- | --- | --- | --- | --- |
| `86a8aa94-5e3a-4c08-bffd-dfe94291d24f` | `ach:inbound:recall:…osq6n9a04iypwl40byz1:sandbox_transaction_rkx1o76pz439jbr7crkg` | 2026-09-11 | 10:08:13.265Z | 2100 Kettle +187425 / 1110 −187425 |
| memo | `hold:0f736c97-…:after:recall:…osq6n9a04iypwl40byz1` | 2026-09-11 | 10:08:13.265Z | 9200 Kettle +187425 / 9900 −187425 |

Both `entry_type = 'original'`: a recall is a **new event**, never a reversal of
the arrival, so the arrival stands on the arrival's day — entry
`a0f7e533-…` is untouched and still dated 2026-09-11, which the test re-reads
after the recall rather than assuming.

**The hold is closed in the same transaction, and that is the part that is easy
to get wrong.** Available = ledger − holds. A recall that debited the customer
and left the arrival's hold standing would withhold the same money twice —
available would fall by $3,748.50 for a customer who never had $1,874.25.
`hold_closure` on `0f736c97` = 1 row, memo balance back to zero,
`v_hold_release_drift` still **0 rows**.

#### 4. And it attributes, rather than merely posting

A build that credited "the only business on the book" would satisfy everything
above. So the same run sent **$943.18** to Ridgeline's own number
(`sandbox_inbound_ach_transfer_jhn7tpytnmta0umg0oke`) and asserted that
Ridgeline's ledger moved by exactly that and **Kettle's did not move at all**.
Entry `9ed8e2ec-a847-44ea-910b-5bd9d19b44e7`, value date 2026-09-11, hold
`e7be0a75-…` still **open** until 2026-09-15T13:00Z — nobody recalled that one,
so it is money a customer has and cannot yet spend.

Re-runnable, and it is the artifact rather than this table:

```
set -a; . ./.env; set +a; RUN_INBOUND_RECALL=1 pnpm vitest run \
  src/lib/rails/increase/inbound-recall.integration.test.ts
```

#### 5. The redrive: 29 rows, 29 still parked, nothing forced

Every delivery parked for want of a mapping was made due and driven through the
current consumer at 10:11Z:

| parked on | deliveries | after the redrive |
| --- | --- | --- |
| `inbound_ach_account_mapping` | 2 (`sandbox_inbound_ach_transfer_07x75nyvzd1oxihtvuoe`, $10,000.00 from CORGI TREASURY) | **still parked** |
| `inbound_wire_account_mapping` | 27 (13 inbound wires) | **still parked** |

**Not one of them posted, and that is the correct result.** Every one names
`sandbox_account_number_96mzhz3n61f5p0jpvytc` — the programme's shared FBO
number — which is mapped to nobody on purpose. Attributing them would mean
picking a business for money that was addressed to the programme, which is the
exact failure this whole change exists to make unnecessary. What did change is
the reason, which now names the number and says why it cannot be mapped instead
of claiming this build issues none:

> *"…names account_number_id `sandbox_account_number_96mzhz3n61f5p0jpvytc`, and
> NOTHING ON THIS BOOK SAYS WHOSE THAT NUMBER IS — there is no
> `virtual_account_number` row for it… It is most likely the programme's own FBO
> number, which is shared and is deliberately mapped to nobody."*

The 27 inbound wire deliveries keep the older wording, because
`src/lib/webhooks/consumers/increase-wire.ts` still says *"this build issues no
virtual account numbers"* and that sentence is now false. The wire consumer was
outside this change's write set; the lookup it needs is the same one
(`virtual_account_number` is keyed on provider, not on rail) and is one call.
**Reported, not fixed.**

#### 6. The one thing this sandbox cannot show

`POST /simulations/inbound_ach_transfers` **rejects `effective_date`** —
`{"field":"effective_date","message":"Unexpected parameter."}`, measured — so an
inbound arrival is always dated today, and a recall of it on the same day lands
on the same value date. The two dates are read from two different provider fields
and the test asserts each against the field it came from
(`payload.effective_date`, `payload.transfer_return.returned_at`), but the
**visible** day separation the brief pictures — Tuesday's credit, Thursday's
recall — cannot be produced for an inbound ACH on this sandbox. Item 6 proves
that separation on the value-date axis with real backdated corrections; this item
proves the two events are dated from the provider's own fields and that the
earlier one is never rewritten by the later one.

#### Revised verdict for item 5

**Outbound: PROVEN, historical** — the real $6,000.00 R01, unchanged.

**Inbound: PROVEN, fresh.** A real inbound ACH credit attributed to the business
whose virtual account number it named, booked at the provider's effective date,
held unavailable by the funds-availability policy, recalled on the real return
endpoint, and booked back at the recall's own value date with the arrival still
standing and the hold closed exactly once. The refusal that was the item's honest
answer before is intact and was re-measured: 29 deliveries addressed to the
shared number were redriven and all 29 stayed parked.

**What is still not demonstrated, and is not claimed:** an inbound recall
separated from its credit by a calendar day, because this sandbox will not date
an arrival in the past; and inbound WIRE attribution, because the wire consumer
was not in this change's write set.

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
earlier run. A restart or a retry cannot re-fire an occurrence that is already
claimed **under the same key**. That is the property, exercised against the
deployment, inside the window — and the qualifier is load-bearing; see the
correction below.

**What makes it structural rather than lucky.** The claim is a unique index, so a
double fire **under one key** is not a storable row:

```
UNIQUE (standing_order_id, scheduled_date)   -- standing_order_occurrence_once
UNIQUE (idempotency_key)                     -- standing_order_occurrence_key_once
PRIMARY KEY (occurrence_id)                  -- standing_order_outcome_pkey
```

Keys are deterministic — `standing:<mandate uuid>:<YYYY-MM-DD>`, **generated in
Postgres rather than by application code**, which is the whole argument of
migration 0012 §2 — and every occurrence carries `claimed_at` and `claimed_by`
(both NOT NULL). Twenty-six occurrences exist across 2026-09-10 and 2026-09-11,
each with exactly one outcome: 12 `raised`, 14 `refused`.

**The invariant.** `v_standing_order_double_fire` — **0 rows**, reach **26
standing-order occurrences**. `v_standing_order_unresolved` — **0 rows**.
`dbcheck` PASS at 08:29:44Z.

> **CORRECTION, 2026-09-11T09:55Z — the unique index defends the key, not the
> keyspace, and the gloss above overstated it.** *"One occurrence, at most one
> payment instruction"* is not what `UNIQUE (idempotency_key)` proves. An
> instruction raised for the same mandate and the same date under a **different
> spelling** of the derived key satisfies every index quoted above and is a
> second payment. `v_standing_order_double_fire` was itself unable to see that
> for days — its old body joined `payment_instruction` on that UNIQUE column and
> asked for `count > 1`, which no state of the database can satisfy — and
> migration 0023 repointed it at the mandate's keyspace. **It has now been made
> to fail**: `node scripts/dbcheck.mjs --prove` at 09:41Z plants
> `standing:6d27bdba-…:2026-09-11` alongside
> `standing:6d27bdba-…:2026-9-11#retry-after-a-restart`, the view goes 0 → 1
> naming **both** keys in `instruction_keys`, and it is 0 again after the
> rollback. So the 0 rows above are now a measurement rather than a tautology,
> and the reason the count is trustworthy is the proof, not the index.
> `docs/STANDING-ORDERS.md` §2 carries the full delta.

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

**1. `inbound_ach_return` was unreachable code — MADE REACHABLE, AND THEN FOUND
WRONG.** `rail_event_semantics` carries the row `ach / increase /
inbound_ach_transfer.updated/returned → inbound_ach_return`, and
`increaseAchConsumer` parked **every** `inbound_ach_transfer` delivery on
`associatedObjectType` before any category or semantics lookup ran, so the row
could never be consulted. **The honest repair was taken: it was made reachable
rather than deleted** (§5 ADDENDUM, 08:53Z–09:17Z) — the consumer reads the
inbound object back and asks the table before refusing. Doing so exposed a
defect nothing could previously have exposed, which is the whole argument for
not deleting an unreachable row on the grounds that nothing runs it. **Item 5 is
still half an item**, for the reason the addendum measures: one shared FBO
account number for six businesses means an inbound credit cannot be attributed
at all.

**2. Two real Increase inbound-ACH deliveries were in the dead-letter pile —
CLOSED.** `sandbox_event_001m27asynxfz81zny26d0e9hz9` and
`sandbox_event_001m27asyqrcaa62g7s9v0x6rzt`, received 04:14:57Z, 10 attempts,
dead-lettered 04:34:15Z with *"no consumer registered for provider 'increase'"*.
The consumer **is** registered (`POST /api/drain` at 08:32:19Z reports
`consumers: ["lithic-card","increase-ach","increase-wire","stripe-identity",
"plaid-item"], missingConsumers: []`), and the claim that stood here — *"a dead
letter is never retried, so they will sit there forever"* — **was wrong**: they
were redriven.

**Measured 2026-09-11T09:47Z against the live database.** Increase holds **124
`done` and 119 `parked` rows and zero dead**; not one of its 243 rows carries a
`dead_lettered_at` at all. **No row anywhere in `webhook_inbox` carries the
string "no consumer registered"**, so the stale `processing_error` field
described here is gone too. The two named events are `parked` with
`processing_error` NULL and the attribution refusal in `parked_reason`.
`/api/health` reads `status: "ok"` in consequence.

**Lithic's 26 dead letters are not closed and are not softened here.** Every one
is *"parked 12 times waiting for `card:<token>`; referent never arrived"* — an
authorisation on a card created directly in the sandbox and never registered to
a customer. **There is still no claim path**: nothing maps an orphan card token
to a business, so clearing them needs a hand-written `INSERT`.

**3. The incremental-authorisation branch had never run on live input —
CLOSED.** When this was written, zero `incremental_authorization` rows existed in
`card_auth_event` on any path. **Measured 2026-09-11T09:53Z: there are 8**, and
all eighteen of the `AUTHORIZATION_ADVICE` payloads below are now `state =
'done'` rather than parked. The account of how it stood is kept because the
mechanism is the point:

Eighteen `webhook_inbox` payloads **do** contain `AUTHORIZATION_ADVICE` — e.g.
`9b8c6ddb-7d44-49ef-a5d9-c52a69e54ac6` with events
`[AUTHORIZATION 5000 DECLINED, CLEARING 7340, AUTHORIZATION_ADVICE 9000,
CLEARING 1660]` — and **all eighteen were parked** with `parked_on_kind: card`,
`parked_reason: "card 8286c472-2d19-4a1b-af0e-5adf0c735ee5 is not registered to a
customer"`, 11 park attempts each. The bodies were synthesised by an integration
suite against a card token that was never written to `card`. The advice-to-
incremental conversion (an advice **replaces** the authorised amount rather than
incrementing it — the logic most likely to be wrong and the most expensive to get
wrong) is therefore covered only by unit tests, never by the deployed pipeline.
Registering that card, or re-signing those bodies against a real one, would close
the last transition in item 2.

## Why the deployment read `degraded` — and reads `ok` now

**Re-read 2026-09-11T09:38:36Z, commit `544b481`: `status: "ok"`.** This section
is kept because the reason it said `degraded` is the interesting half, and
because the half that fixed it is not the half anyone would guess.

Stated as it stood: `/api/health` returned **HTTP 200** with
`status: "degraded"` throughout the window. It was **not** the rails:
`integrations.live 7 / 7`, `database.reachable true`,
`webhookHealth.degradedBy: []` (every provider's delivery feed read `fresh`).

It was `webhookProcessing.degradedBy: ["lithic","increase"]` — *arrival is not
processing*. Lithic: 33 deliveries accepted and then dead-lettered, the newest at
**08:25:14.969Z, during this pass**, all with the same reason — *"parked 12 times
waiting for `card:048c2bd4-…`; referent never arrived"*, i.e. live-fire and
integration cards that were never registered to a customer. Increase: the 167
described above.

**What changed, measured 09:47Z–09:59Z:** Increase went **167 → 0** dead — the
consumer was registered and the backlog redriven, and no `increase` row carries
a `dead_lettered_at` any more. Lithic went **33 → 26**, and the endpoint now
reports those 26 as `supersededByConsumption: true`, `degradesDeployment:
false` — *"history, not a live drop"* — with `clearedBy: "node
scripts/redrive.mjs --apply"` naming a fix nobody has run. So
`webhookProcessing.degradedBy` is `[]` and the dead-letter reason for `degraded`
is gone.

**`degraded` has not gone away, and the reason it appears now is a better one.**
Read at 09:59:12Z it is `degraded` because `webhookHealth.degradedBy:
["lithic"]` — 538 s since the last Lithic delivery, inside the documented
180–900 s `stale` band, *"silent for longer than 180s after recent traffic —
treated as an outage"*. That is live-fire attack 7's own induced silence, still
clearing. Past 900 s it returns to `ok` by itself. **And 26 undeliverable card
authorisations are still sitting there with no claim path**; `status: "ok"` at
rest should not be read as saying otherwise.

The endpoint was telling the truth about a real backlog of undeliverable events,
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
   hold-once invariants hold across 342 live and 356 released holds. *(Separately,
   this list said **incremental authorisation has never been demonstrated at
   all**. That is no longer true: 8 `incremental_authorization` rows at 09:53Z —
   item 2's ADDENDUM. The spend-cap half of the shortfall stands.)*
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

---

# THE TEN, AS CLICK PATHS — walked against production 2026-09-11 ~18:30Z

Every URL below was fetched from **https://corgi-trial-psi.vercel.app** while
writing this section and the quoted figures are what came back. Where a thing
cannot be done from a UI surface it says so in bold; that is not a hedge, it is
the answer.

`$B` = `https://corgi-trial-psi.vercel.app`. All eleven routes answered 200.

**The three graded hardest come first**, in the brief's own order: the hold model
under hostile sequencing, the bitemporal correction, and whether available
balance is derived truth or a stored lie.

---

## H1 (item 2) — The hold model under hostile sequencing · 90s

**URL:** `$B/accounts/holds/af08eac0-2666-42d2-a323-c0f98b1752bb`

One page, six events, the whole lifecycle. Point at the table **"Every card
event in this authorisation's event set, with the running fold at each step"**.
Its rows, as served:

| kind | amount | A(E) so far | C(E) so far |
|---|---|---|---|
| authorisation reversal | $73.40 | -$73.40 | $0.00 |
| authorisation | $50.00 | -$23.40 | $0.00 |
| clearing | $73.40 | -$23.40 | $73.40 |
| incremental authorisation | $73.40 | $50.00 | $73.40 |
| clearing | $73.40 | $50.00 | $146.80 |
| authorisation reversal | $50.00 | $0.00 | $146.80 |

Then point at **the fold**: `A(E) — authorised $0.00`, `C(E) — captured
$146.80`, `H(E) — held $0.00`, and the sentence above it: **"H(E) is not stored
anywhere. It is this arithmetic, over the set above."**

Five of the seven lifecycle steps are on this one screen — authorisation,
**incremental**, **two separate captures**, **over-capture** (C(E) $146.80
exceeds A(E), and the page says why: *"May exceed A(E) — fuel pumps and tips
over-capture routinely"*), and **reversal**. The best line to read aloud is the
order-independence note under the table: *"the order of the rows changes every
one of them and changes none of the totals below. That is the order-independence
claim, visible rather than asserted."*

**Expiry** is the sixth kind and is not on this hold — 143 `expiry` events exist
on the book; `$B/accounts/holds/05055d30-3ef8-4f9c-ab28-ecbc1a5ee2f4` carries
one alongside a `clearing_first` origin.

**To TRIGGER lifecycle steps live:** `$B/accounts` → **"Simulate an
authorisation"** (amount, MCC, descriptor → real `POST /v1/simulate/authorize`),
then **"Settle it"** per hold (blank amount = full). Re-submitting "Settle it"
is how you show partial capture, multiple captures and over-capture from the
UI — the row renders the form even on a closed hold precisely so over-capture is
demonstrable. **Not triggerable from any form:** incremental authorisation,
authorisation reversal, expiry. Those arrive only as genuine Lithic network
payloads.

---

## H2 (item 6) — The bitemporal correction · 60s · "we run this live"

**Use a real demo business.** Ridgeline Robotics, value date 2026-09-08,
correction group `e397837a-4c5d-4d40-b2fc-0b1f38c708c2`: a settlement booked at
the wrong amount (seq 3915), reversed (seq 3916), re-booked corrected (seq
3917) — all three at value date **2026-09-08**, all three booked **2026-09-11**.

**ONE URL shows both figures at once** — this is the whole demo:

```
$B/transactions?account=a0c41a37-2be1-5c30-bfe9-03455f048fac&asOf=2026-09-08&asKnownAt=2026-09-11T09:46:46.200Z
```

Point at the panel **"2026-09-08 — closing balance, read twice / Same value
date. Same rows. One argument changed."** It carries, side by side:

- badge **"the belief changed"**
- **As believed then · $50,998.07** · booking watermark **3915**
- **Difference · +$16.60** · *over 1 later act*
- **As corrected — everything we know · $51,014.67** · booking watermark 11966

Then move the booking axis past the correction and show it converge:

```
$B/transactions?account=a0c41a37-2be1-5c30-bfe9-03455f048fac&asOf=2026-09-08&asKnownAt=2026-09-11T09:46:47.000Z
```

→ badge **"the two queries agree"**, As believed **$51,014.67**, Difference
**$0.00**, watermark **3917**. Same day, same rows; the only thing that moved is
what we had learned.

Below it, **"What we learned after that point, and when"** itemises the acts
that make up the +$16.60, and the page states the cut's own limits out loud:
*"The cut is on `booking_seq`, not on a timestamp"*, `Proved: no correction act
is split`, and a named `Not proved:` clause.

**A sharper pair, on a fixture account** (73 milliseconds apart, $50.00 of
difference) if you want the correction act visible by name:

```
$B/transactions?account=2eb04bde-236e-4c3a-b89f-657cc7dc61eb&asOf=1988-06-21&asKnownAt=2026-09-11T04:58:08.573Z   -> As believed $951.50   (wm 2680)
$B/transactions?account=2eb04bde-236e-4c3a-b89f-657cc7dc61eb&asOf=1988-06-21&asKnownAt=2026-09-11T04:58:08.647Z   -> As believed $1,001.50 (wm 2682)
```

Both read **As corrected $28,840.09** — the corrected figure is the same from
either standpoint, which is the point. The act is named on screen: *"Reversal of
`91d5a24f`…: statement proof MTWHJLCM: merchant reversed and re-presented"*, seq
2681. It is on **Hold Fuzzer Fixture Co.**, not one of the three demo
businesses — prefer Ridgeline above in front of a panel.

**DO NOT use `$B/transactions?state=edge` for this.** It is a genuinely
interesting screen — it lands mid-write to spring the cut-snap guard — but as
served today it resolves to a fuzz-fixture account whose two readings are
**identical** ($494,456.99 both, Difference $0.00, *"the two queries agree"*).
A panel would see two of the same number.

**A correction cannot be ENTERED from the UI.** `reverseAndRebook()` is reached
only from webhook consumers, cron repair paths and scripts. `/transactions` is a
viewing surface; the presenter picks two watermarks, never authors a correction.

**Second surface, and it is arguably the better one:** `$B/statements?state=edge`
— see item 7.

---

## H3 (item 1) — Available is derived, not stored · 45s

**URL:** `$B/accounts`. The **"Customer deposit accounts"** table has **"Ledger
balance"** and **"Available balance"** as adjacent columns, one row per account.
That is the 10-second version.

**The 45-second version, which is the one that answers the question**, is the
itemised derivation. On the time-travel page or the account screen, point at
**"Available balance at that point, itemised — The five terms of available
balance"**, served as:

```
Settled ledger balance          $494,456.99
less active holds               -$19,083.00
less uncleared credits           -$5,000.00
less committed outflows              $0.00
Available                      $470,373.99
```

with the caption *"The same function the live screens call."* One definition:
SQL function `ledger_availability(...)` in `db/migrations/0022_balance_definitions.sql`,
which **returns a table, not a stored row**; `v_available_balance` and the
TypeScript `accountAvailability()` both call it. There is no `available_cents`
column on any table and `pnpm db:check` fails the build if one ever appears.

**The proof that it is not a clamped lie:** `$B/accounts?state=edge` renders an
available balance that is **negative and not floored at zero**. Live fire attack
2 asserted the same thing against production this morning: *"available ==
ledger(4475436) − holds(67000) − uncleared(5550000) exactly, not clamped — and
it IS negative, reported as negative rather than floored at zero."*

---

## 3 — Settlement is not authorisation, including a force post with no auth · 60s

**URL:** `$B/accounts/holds/01dfc4ff-bb96-4f68-8027-eef6f07a9ea7` —
`origin = force_post`. The event table shows a **force post** row feeding
`+ C(E)` with no authorisation term beneath it. 60 authorisations on this book
carry `origin = force_post`; 208 `force_post` events in total.

The arithmetic claim to make: C(E) is `Σ over {clearing, force_post}` and A(E)
is `Σ over {authorization, incremental_authorization} − Σ over
{authorization_reversal}` — printed on the page. A settlement that never had an
authorisation simply has no A(E) term; nothing branches on it.

**A fresh force post cannot be produced from any UI form.** The forms on
`/accounts` only drive Lithic's two-message flow. A bare force post requires
`POST https://sandbox.lithic.com/v1/simulate/authorize {"status":
"FINANCIAL_AUTHORIZATION", ...}` by hand. Viewable in the UI; not inducible
from it.

---

## 4 — Out-of-order delivery, settlement before its auth · 90s

**Inducible from the UI.** `$B/chaos` → arm **"Reorder buffer (seconds)"**
(`reorder_window`, effect text *"We release our own deliveries backwards inside
a window"*) → **Start an episode** → the clearing webhook is delivered before the
authorisation for a real $50.00 / $73.40 pair. The resulting hold reads
`origin: clearing_first`.

**To show the finished article instead:**
`$B/accounts/holds/05055d30-3ef8-4f9c-ab28-ecbc1a5ee2f4` — `origin =
clearing_first`. 214 authorisations on this book carry that origin. The line to
point at is on the hold page itself: *"How we first heard of it. Recorded for
reporting; **nothing branches on it** — a clearing that beat its authorisation
takes the identical arithmetic path."*

**Proven against production this morning** by live fire attack 4, PASS: in-order
episode `9311f116` and clearing-first episode `aac5b0c1` (re-signed and POSTed
clearing-first, HTTP 202 then 202) both produced ledger delta -7340, available
delta -7340, hold delta 0 — **EQUAL**.

---

## 5 — Returns and recalls, corrected on the day it happened · 60s

**URL:** `$B/statements?state=edge` — see item 7; it is the same screen and it is
showing exactly this. As served, the correction is a **card refund reversal of
-$73.40** and the page states the principle in its own words:

> *"The correction is an ADDITION to the record — a reversal and a re-book
> appended at the original value date — not an edit of it."*

**Inbound ACH recall on a real demo business:** Kettle & Crumb Bakery LLC
carries an arrival and a recall at the **same value date 2026-09-11**.
`recallInboundAch()` books the recall as a new entry at the recall's own value
date and never edits the original. Also surfaced read-only on `$B/dashboard`
under **"Inbound credits nobody can attribute"**.

**Not inducible from any UI form.** A return/recall arrives only from a real
signed Increase webhook; producing a fresh one means
`POST /inbound_ach_transfers/{id}/transfer_return` against the Increase sandbox
by hand.

---

## 7 — A closed day, reproducible forever, identical every time · 60s

**URL:** `$B/statements?state=edge`. This is one of the two strongest screens in
the build. Point at the table **"Each reading's booking watermark, closing
figure and content hash"**, served as:

| Reading | Watermark | Lines | Closing | Content hash, recomputed now |
|---|---|---|---|---|
| As believed | 11958 | 134 | $66,655.91 | `6eab9049a805…bb28` |
| As corrected | 11966 | 135 | $66,582.51 | `7a157759d70f…bdce` |

with the badge **DERIVED, NOT STORED** and this sentence, which is the answer to
the question being asked:

> *"Neither figure above is stored anywhere. Both are `renderStatement(period,
> watermark)` — the same function, the same rows, the same canonical form — run
> twice with one argument changed, on this request. Re-running either at its own
> watermark produces the same bytes forever: no row can appear below a watermark
> after the fact, because `booking_seq` is drawn while holding the ledger append
> lock, so sequence order is commit order; and no row below it can change,
> because the money tables are append-only and the application role holds no
> `UPDATE`."*

**To show identical-every-time:** reload the URL. The hashes are recomputed from
the ledger on every page load — the page is never prerendered — so an unchanged
hash across two loads is a real reproduction, not a cache. For a file the panel
can keep, press **Download statement PDF** twice and compare the printed
**document fingerprint**.

The page also closes the loop on item 5: *"Total movement since the left-hand
reading … -$73.40"*, **"The difference is accounted for"**, and *"The acts above
sum to exactly the difference between the two readings. Nothing on this day
changed that we cannot name and point at."*

---

## 8 — Standing orders, fire-once, insufficient-funds policy written · 90s

**URL:** `$B/standing-orders`.

**Creating a mandate IS a UI action** — the `MandatePanel` form at the foot of
the page (`createStandingOrderAction`) returns a receipt saying exactly when it
will first fire. Proven: `standing_order` 48 → 49.

**The written policy is on screen**, under the heading **"What happens when the
money is not there"** — *"The written policy, in the place it has to be
readable — beside the row it explains."* Its four claims, verbatim:

- **"Refuse the occurrence and close it."** No partial payment, no
  carry-forward, no queue that fires whenever the money happens to arrive.
- **"Checked against AVAILABLE, not the ledger."** *"Money committed to a hold
  is already spent."*
- **"The refusal is a row, not a silence."** *"'It never fired and nobody knows
  why' is the failure that actually hurts, and it is a MISSING row — so a
  refusal is a present one."*
- Two **rejected** alternatives argued explicitly: partial payment (*"invents an
  instruction nobody authorised"*) and carry-forward (*"that is the 3am
  surprise"*).

Point also at the two live invariant tiles: **Claimed, undecided `0`** and
**Double fires `0`**, with the note that the second *"cannot be non-zero while
`payment_instruction.idempotency_key` is UNIQUE — its emptiness is a consequence
of a constraint, not of anybody being careful."*

`$B/standing-orders?state=edge` shows a real refused occurrence: code
**`INSUFFICIENT_AVAILABLE_FUNDS`**, *"the ledger balance covers this payment but
the available balance does not."* That is item 1 and item 8 in the same row.

**FIRING cannot be done from any UI surface.** `runStandingOrders()` is behind
`POST /api/cron/standing`, bearer-token only, and the actions file deliberately
does not import it. The fire-once move in front of a panel is:

```bash
curl -s -X POST -H "authorization: Bearer $DRAIN_TOKEN" "$B/api/cron/standing"
```

---

## 9 — Scheme reconciliation with an aging breaks screen · 90s

**URL:** `$B/reconciliation`. As served:

```
business date  Dec 08, 2027      run #1      watermark seq 5788      LIVE LEDGER
Matched  3 / 3      Breaks  1      Net difference  +$240.71      Past a close  0
```

**The aging buckets are there**, as filter chips with live counts: **0-1 days
`1` · 2-3 days `0` · 4-7 days `0` · 8-30 days `0` · 31+ days `0`**, plus an
**Age** column and a **Severity** ladder on the break table. The sentence to
read aloud is underneath it:

> *"Aging is measured from the value date and from day closes, not from when the
> job last ran — a break does not get younger because the nightly run was late.
> Severity escalates when a break has been open across a day close: somebody
> signed off a business day with it outstanding."*

The run list shows **"A run is immutable. Re-running appends; it never
revises."** with a content hash per run (`17fc3d148063…`).

**"We will plant one" — already planted, this morning, PASS.** Live fire attack
6 deleted a row from tonight's scheme file and the break appeared:
`in_ledger_not_file / unmatched_reference`, ref **`LF6-MTXAKI1J-3`**, 139 cents,
business date 2027-10-18, severity `open`, recon run
`6424e1d5-074a-43cf-8a90-1d074c5b69a5`. It is on the screen now.

**A RECONCILIATION RUN CANNOT BE TRIGGERED FROM ANY UI SURFACE.** Re-verified at
11:29 today: `/reconciliation` and `/breaks` each contain a single `page.tsx`
with no `actions.ts`, no form and no server action, and `runReconciliation()` /
`seedReconDemo()` have **zero callers anywhere under `src/app/**` or
`src/components/**`**. The only API route is `GET
/api/v1/reconciliation/breaks`, marked `readOnly: true`. To produce a fresh run
in front of a panel you run `node scripts/livefire.mjs --only 6`. Say that
plainly rather than hunting for a button.

**`$B/breaks?state=edge`** is the sharper screen: a break whose correction group
is incomplete — a reversal with no re-book yet — so every signal reads
"explained" while money is still missing.

*Cosmetic flaw a panel may notice:* the Age column currently reads **`-453d`**,
because attack 6 forward-dates its synthetic business date to 2027-10-18 on
purpose so the run is reachable from the breaks screen. The severity is right
(`day still open`); the number is negative.

---

## 10 — Maker-checker; the initiator can never approve their own · 60s

**URL:** `$B/approvals?state=edge`. As served: actor **Priya Raman**, badge
**"cannot approve"**, and the demo-state caption states the trap and springs it:

> *"The row at the top was raised by whoever you are currently acting as.
> Approve is disabled with the reason stated — **flip the role switcher and it
> stays disabled, because the reason is who raised it, not which role you
> hold.**"*

Flip the switcher in front of them. That is the demo.

Point at the panel **"Maker-checker on money out, and where it is actually
enforced"**:

> *"The initiator of a payment can never approve it. That is not a rule this
> screen applies: it is a trigger on `payment_instruction_event` that raises
> SQLSTATE 42501 when an `approved` row's actor is the instruction's
> `requested_by`."*

**Proven against the production database this morning**, live fire attack 5,
PASS — a raw `INSERT` bypassing the app entirely:

```
SQLSTATE 42501 from assert_maker_checker():
  "maker-checker: actor 76f9266f-23c9-52de-b8ff-0ec0b23ef386 initiated
   instruction f1031501-1129-4153-8260-e5a5419df67f and cannot approve it"
approved events after both attempts: 0
then a SECOND human approved the same instruction: 1 approved event
```

**Nor can the agent surface**, and it is blocked three ways, independently:

1. `assert_maker_checker()` also refuses any actor whose `kind <> 'human'`.
2. `CHECK (NOT (kind <> 'human' AND can_approve))` on `actor` — an approving
   agent row is structurally impossible, not merely rejected.
3. The MCP port never exposes the verb. `src/lib/mcp/approvals-port.ts`:
   *"WHAT THIS PORT DELIBERATELY DOES NOT EXPOSE, and must never grow:
   `approvePayment`, `rejectPayment`, `cancelPayment`, `releasePayment` … None
   of them is reachable from a bearer token."* The agent can only
   `initiate_payment`, which queues a request a human works through.

`$B/client/approvals?state=edge` is the customer-facing mirror of the same rule.

---

## What could NOT be demonstrated from a UI surface

Stated plainly, because a confident guess is worth less than a named gap:

| # | Thing | Where it can be shown | Where it CANNOT |
|---|---|---|---|
| 3 | A **fresh** bare force post | hold page, `origin = force_post` | no form; raw `simulate/authorize` with `FINANCIAL_AUTHORIZATION` |
| 5 | A **fresh** return / recall | `/statements?state=edge`, `/dashboard` | no form; Increase sandbox API by hand |
| 6 | **Entering** a correction | `/transactions`, `/statements` (viewing both figures) | `reverseAndRebook()` has no UI caller |
| 8 | **Firing** a standing order | mandate creation works from the form | `POST /api/cron/standing`, bearer token |
| 9 | **Running** a reconciliation | breaks + aging + runs all render | no form anywhere; `scripts/livefire.mjs --only 6` |
| 2 | incremental auth / reversal / expiry | all visible on hold pages | only real Lithic network payloads |

Also worth knowing before someone asks: **Silverline Freight Co. exists as a
business row but has no deposit accounts on this book** — only Ridgeline
Robotics and Kettle & Crumb Bakery do. Do not open a Silverline account screen
in front of a panel expecting balances.
