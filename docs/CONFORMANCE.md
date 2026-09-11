# CONFORMANCE — the brief, line by line, against what is actually running

**Measured 2026-09-11, 18:25–18:40 UTC**, against deployment commit `11658fa`
at <https://corgi-trial-psi.vercel.app> and against the live database as
`corgi_app` (read-only role).

## How to read this

Every line below is **DONE**, **PARTIAL** or **ABSENT**, and every line carries
the thing that was run, queried or fetched. Where a claim could not be
established, the line says so and says why — an unestablished claim is recorded
as unestablished, never rounded up.

**A skip is not a pass.** Four probes in this build have reported LIVE for
things that did not exist, and each was caught only by measuring. Nothing here
is taken from a document, from `/api/health`'s own summary, or from another
script's scoreboard without a second, independent read.

**What this document does not cover.** `scripts/livefire.mjs` was not run — it
posts real sandbox money and another agent owns it. The live-fire section
(§6) is therefore scored on *residue*: rows that a livefire run left in this
database, which is weaker evidence than running it, and each line says so.

### What was run

| Instrument | Result |
| --- | --- |
| `node scripts/dbcheck.mjs` | **47 passed, 6 failed** — §9 |
| `node scripts/coreloop.mjs --base-url https://corgi-trial-psi.vercel.app` | **7 PASS / 0 FAIL / 0 SKIP**, 103 HTTP calls, 89s, run `CL-MTXAIWE5` |
| `node scripts/audit-claims.mjs` | `7 of 7 live`; *no document contradicts the endpoint* |
| `curl` against the deployed origin | 31 screens, all HTTP 200; `/api/v1`, `/api/mcp`, `/api/webhooks/lithic-auth` |
| `curl` direct to Lithic / Stripe / Base Sepolia | independent of `/api/health` — §3 |
| 24 SQL queries as `corgi_app` | schema, invariant views, residue |

---

## 1. The brief's own paragraphs

### 1.1 "Customers hold a balance, send and receive payments, and get a card for each person on the team."

**DONE.**

- Balance: `ledger_availability(p_account uuid, p_value_date date, p_booking_seq
  bigint, p_as_of timestamptz)` returns `TABLE(ledger_cents, hold_cents,
  uncleared_cents, pending_outbound_cents, available_cents)` — one definition,
  five terms. Read live off `pg_proc`.
- Send and receive: 5,131 journal entries over five rails —
  `card` 2,937 · `ach` 2,061 · `internal` 92 · `wire` 51 · `usdc` 10.
  (`select rail, count(*) from journal_entry group by 1`.)
- A card per person: 1,055 `card` rows against 584 `team_member` rows across
  8 businesses. Ridgeline Robotics holds 270 cards / 565 members; Kettle &
  Crumb 146 / 19.

**One honest qualification.** Two demo businesses have members and cards;
**Silverline Freight Co. has 0 cards and 0 team members**. The card-per-team-
member story is demonstrable on Ridgeline and on Kettle & Crumb, and is empty
on the third demo business. If a grader opens Silverline first they see nothing.

### 1.2 "A card authorisation puts a hold on funds before any money actually moves."

**DONE**, and measured end to end on the deployed URL in this run, not asserted.

Core loop leg 4, Ridgeline Robotics, card `e5de1361-7be4-4212-95fb-41ad1aca29fb`
(last four 7123), Lithic transaction `adc9a9eb-a549-4233-a994-603c8eea31c2`,
descriptor `CORGI PUMP CL-MTXAIWE5`, MCC 5542 (fuel pump):

```
on the AUTHORISATION       LEDGER        HOLDS    UNCLEARED  PENDING OUT    AVAILABLE
  before               $66,655.91      $410.00   $28,451.18    $2,500.00   $35,294.73
  after                $66,655.91      $460.00   $28,451.18    $2,500.00   $35,244.73
  delta                     $0.00      +$50.00        $0.00        $0.00      -$50.00
```

The ledger did not move. Available fell by exactly the authorised amount. Hold
`92a1ea32-555d-4e9e-9583-05b00908e1d3`.

### 1.3 "The amount that finally settles can be different … and it can arrive days later."

**PARTIAL — the *different amount* half is DONE; the *days later* half is
PARTIAL.**

*Different amount — DONE.* Same leg, three seconds later: cleared **$73.40**
against a **$50.00** authorisation.

```
AUTH -> SETTLEMENT         LEDGER        HOLDS    UNCLEARED  PENDING OUT    AVAILABLE
  before               $66,655.91      $410.00   $28,451.18    $2,500.00   $35,294.73
  after                $66,582.51      $410.00   $28,451.18    $2,500.00   $35,221.33
  delta                   -$73.40        $0.00        $0.00        $0.00      -$73.40
```

Entry `475aebe0-250f-40a7-9ec5-6c4d58854f9a`, booking seq 11942. The hold shows
1 opening memo entry and 1 releasing — **released exactly once**; memo balance
$0.00; `hold_closure` rows 0. The $23.40 over-capture is not special-cased.

*Days later — PARTIAL, and the missing half is the clock, not the model.* The
Lithic sandbox clears on demand; the clearing above arrived 3s after its
authorisation. The value-date axis is exercised separately and genuinely: the
book carries corrections booked **three days after their value date** —
e.g. entry `fb37aa68-8f6b-4939-b429-fab3a853d351`, value date 2026-09-08,
booked 2026-09-11, *"merchant reversed the settlement"* — and one booked
**48 days** after (`eaf8f391-…`, value date 2026-07-24, booked 2026-09-10,
*"merchant reversed the clearing and re-presented for less"*). So a settlement
whose value date is days behind its booking date exists on this book and reads
correctly. What has not been demonstrated is a *provider* delivering a clearing
days after its auth, because no sandbox on the menu will wait.

### 1.4 "The ledger is append only and immutable."

**DONE**, enforced by the database and not by convention.

`dbcheck` probes it by attempting the writes as `corgi_app`:

```
PASS  UPDATE journal_entry is refused — permission denied for table journal_entry
PASS  DELETE FROM journal_entry is refused — permission denied for table journal_entry
PASS  TRUNCATE journal_entry is refused — permission denied for table journal_entry
PASS  UPDATE journal_line is refused — permission denied for table journal_line
PASS  DELETE FROM journal_line is refused — permission denied for table journal_line
PASS  TRUNCATE journal_line is refused — permission denied for table journal_line
PASS  grants on journal_entry — INSERT,SELECT
PASS  grants on journal_line — INSERT,SELECT
PASS  grants on card_auth_event — INSERT,SELECT
PASS  grants on hold_closure — INSERT,SELECT
```

`journal_entry` additionally carries `prev_hash` and `hash` (bytea) — a hash
chain over the book, which the brief never asked for.

### 1.5 "When a merchant reverses a settlement or a payment is recalled, the customer's balance and their statement must both show the corrected position for the day it happened."

**DONE.** Core loop leg 6 drove it against the deployment with a **real,
signed Lithic webhook**, drained after 15s:

```
BOTH TIME AXES, on 2026-09-11, account a0c41a37-2be1-5c30-bfe9-03455f048fac:
  value date    original 2026-09-11   correction 2026-09-11   SAME DAY
  booking seq   original 11949   correction 11959   LATER
  as believed         $66,655.91   read at watermark 11949
  as corrected        $66,582.51   read at watermark 11960
  difference             -$73.40   exactly the refund taken back
```

The correction is entry `bd372233-7d25-4091-b00b-60b71207ea6c`, `entry_type =
reversal`, `reverses_entry_id = d8ebd9f5-…`, `correction_group_id` = the
original's id, idempotency key `reversal:d8ebd9f5-…`. Nothing was edited: the
pre-correction watermark still returns the pre-correction number.

Statement URL rendered by the run:
`/statements?account=a0c41a37-2be1-5c30-bfe9-03455f048fac&day=2026-09-11` —
it renders both readings and the watermark.

**Qualification, stated plainly:** that live pair lands on the *same* value
date. The cross-day form ("Tuesday reversed on Thursday") is on this book from
earlier runs — §1.3 cites `fb37aa68-…` at +3 days — but it was not the pair
this run drove. A grader who asks for the cross-day correction *live* should be
pointed at leg 6's machinery plus `fb37aa68-…`, not told the live run did it.

### 1.6 "Businesses pass a check before the account opens."

**DONE as a gate; PARTIAL as self-serve onboarding.**

The gate is real and was asked, live, before anything else ran (coreloop
leg 1, 10/10 checks):

```
ALLOWED  KYB_ALLOWED  Ridgeline Robotics, Inc.          approved/manual, 2 leg(s), 1 live
REFUSED  KYB_PENDING  Holds Integration Fixture Co.     pending/simulated, 0 leg(s), 0 live
REFUSED  KYB_PENDING  Live Fire — attack 3              pending/simulated, 0 leg(s), 0 live
```

The refusal is enforced on the **money path**, not only the screen:
`POST /payments` for a pending business returned `KYB_PENDING` with
**rows written: 0** — `canTransact()` refused before a payment instruction
could be written.

*The PARTIAL half.* Self-serve onboarding stops at a privilege boundary.
`corgi_app` holds `SELECT` and only `SELECT` on `business`, so an applicant
cannot open a business row without a `SECURITY DEFINER` function that does not
exist. **This is least privilege working as designed, not an omission** — the
application role is not allowed to mint legal entities — but it does mean a
grader cannot type a new company into `/onboarding` and watch it appear. The
screen renders (HTTP 200, 299 KB) and the gate is live; the row-creation step
is operator-side.

### 1.7 "Cards come from an issuer processor, payments ride real rails, and customers fund the account from an external bank they link themselves."

**DONE for cards and rails. PARTIAL for "they link themselves."**

- Cards: Lithic sandbox, live — §3.1.
- Rails: Increase sandbox live for ACH; USDC live on Base Sepolia; `wire` and
  `internal` also ledgered. Five rails in `journal_entry.rail`.
- Funding: Plaid sandbox is live (`POST /institutions/get -> 200`, verified
  independently) and coreloop leg 2 funded $1,250.00 from a linked external
  bank through the deployed `/funding` form. What was **not** established is a
  grader completing Plaid Link *themselves* in a browser from a cold start —
  the link is pre-established on the seeded businesses. Recorded as
  unestablished rather than assumed.

### 1.8 "Users need to see their balance."

**DONE.** `/dashboard`, `/accounts`, `/client` all HTTP 200 and render live
figures. Cross-checked from a second surface: the MCP `get_balance` tool on the
deployment returned

> ledger balance $66,582.51, available $35,221.33. The -$31,361.18 difference
> is 10 open card authorisation hold(s) totalling $410.00, 29 uncleared
> credit(s) totalling $28,451.18, and $2,500.00 already booked to leave on a
> future value date.

— identical to the figures `ledger_availability()` returned to the core loop.
Two independent readers, same number.

### 1.9 "Users need to approve payments above a threshold."

**DONE**, and the refusal comes from the database.

Coreloop leg 5 (27/27 checks): $3,200.00 ACH raised by Priya Raman against a
$2,500.00 threshold, instruction `1989b801-0df8-4e31-8595-91e57b8d920a`.

```
initiator  Priya Raman pressed approve on her own instruction
  -> REFUSED  NOT_AN_APPROVER   approved events written: 0
approver   Dana Okonkwo pressed approve on her own
  -> REFUSED  SELF_APPROVAL
function   assert_maker_checker()  trigger payment_instruction_event_maker_checker
SQLSTATE   42501 — 'maker-checker: actor % initiated instruction % and cannot approve it'
```

The queue's controls render **disabled** for a maker; the run assembled the
POST by hand and reached the trigger anyway — so the guard is not the UI.

### 1.10 "Users need to reconcile the scheme file."

**PARTIAL — and this is the sharpest partial in the document.**

*The half that is DONE:* reconciliation is a real feature with real history.
104 runs in `recon_run`; tables `recon_run`, `recon_run_break`, `recon_match`,
`recon_break_note` plus six views. `/reconciliation` and `/breaks` both render
live, classify into exactly three categories (in-file-not-ledger,
in-ledger-not-file, amount mismatch), age each break on **two clocks** (value
date for unexplained; date-of-learning for corrections in flight), escalate
severity across a day close, and carry a content hash per run. `/breaks` adds a
fourth axis nobody asked for — whether the book can *explain* the break
(unexplained / correction in flight / corrected / corrected-still-short).
Coreloop leg 7 confirmed the planted break surfaces with its category, its
reference `LF6-MTX1R8MG-3`, $240.71, and its age.

*The half that is ABSENT:* **a user cannot run a reconciliation, or plant or
upload a file, from any deployed surface.** Measured directly: `/reconciliation`
contains exactly **one** `<form>` and its only buttons are `Staff` and
`Approver` — the role switch. Coreloop's own leg 7 says it in its output:
*"The planting itself has no deployed control — /reconciliation renders no
write form — so this run did not plant it and does not claim to have."*

The brief's sentence is *"Users need to reconcile the scheme file."* On this
build a user can **read** a reconciliation someone else ran from a script. That
is a read screen over a batch job, not the verb in the sentence.

**Whose decision:** not recorded as one. No cut-list row was found covering it.
Treat it as a gap, not a choice.

---

## 2. The v1 scope list

| Item | Verdict | Evidence |
| --- | --- | --- |
| Onboarding and identity checks | **PARTIAL** | Gate live and enforced on the money path (§1.6). Self-serve business creation blocked by least privilege — `corgi_app` has SELECT-only on `business`. `/onboarding` 200. |
| Accounts and balances | **DONE** | `/accounts` 200 (1.7 MB), `ledger_availability()` five terms, `v_balance_definition_drift` = 0. |
| Inbound and outbound payments | **DONE** | 2,061 `ach` entries, 51 `wire`, 10 `usdc`; leg 2 inbound $1,250, leg 5 outbound $3,200. |
| Card authorisation and settlement | **DONE** | §1.2, §1.3. All eight lifecycle kinds present in `card_auth_event` — §5.2. |
| Holds | **DONE** | 574 live holds covered by `v_hold_drift`, 598 released covered by `v_hold_release_drift`; both 0. |
| Standing orders | **DONE** | 49 mandates, 32 occurrences, **32 claimed, 32 distinct idempotency keys** — one occurrence, one claim. `v_standing_order_double_fire` = 0. `/standing-orders` 200. |
| Statements | **DONE** | 62 statement rows over 30 periods, each with `version`, `booking_watermark`, `content_hash`. Re-generation appends a version at a new watermark rather than revising — measured: period 1981-12-07 on account 21b29548 holds versions 1 and 2 at watermarks 4045 and 4047, two distinct hashes. §5.7 on reproducibility. |
| **A mobile app** | **ABSENT — decision** | **Cut deliberately, on Saahith's own repeated instruction.** Reasoning: 48 hours, and a React Native shell would have bought a screenshot at the cost of the hold model and the bitemporal machinery — the two things the brief says are graded hardest. The console is responsive and `/client` is the customer surface. This is the single largest *named* v1 omission and it should be said out loud in the debrief before anyone finds it. |
| Admin console | **DONE** | 22 operator screens, all HTTP 200: dashboard, accounts, pots, funding, payments, payees, payouts, approvals, standing-orders, accruals, disputes, reconciliation, breaks, statements, transactions, economics, team, triage, audit, events, chaos, onboarding. |
| A public API | **DONE** | `/api/v1` — 401 `MISSING_BEARER_TOKEN` anonymously; with a bearer token returns a typed account list with `payable` / `payable_note` semantics (a pot is readable but not payable, and the API says why). Endpoints: accounts, accounts/[code]/balance, limits, payees, payments, payments/[id], reconciliation/breaks, statements, statements/[business_date], transactions. |

---

## 3. The five required integrations

`/api/health` reports `"live":7,"total":7`. **Every row below was re-verified
by calling the provider directly, not through the app.** `audit-claims.mjs`
separately reports `truth: 7 of 7 live` and `no document contradicts the
endpoint`.

### 3.1 Card issuing — **Must be live** → **DONE, live**

Independent verification, direct to the sandbox:

```
GET https://sandbox.lithic.com/v1/cards?page_size=1   -> 200
GET https://sandbox.lithic.com/v1/event_subscriptions -> 200
  { "token":"ep_3J8yb9xommtOdKee1FzpUA4GBrW",
    "disabled": false,
    "url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic" }
```

The subscription points at the **deployed** origin, and health reports the
latest delivery SUCCESS with our endpoint answering HTTP 202 at
2026-09-11T17:48:26Z. Real cards exist and carry this build's fingerprints —
`corgi · Marguerite Okonkwo`, `livefire correction MTX8J264`, `livefire
overcapture-not-terminal MTX8ILUY`. Coreloop issued a new one this run and
authorised on it. Three calls went from the core-loop run straight to the
Lithic sandbox.

Also live and separately useful: `/api/webhooks/lithic-auth`, the real-time
auth-decision (ASA) endpoint, returns **401** to an unsigned POST.

### 3.2 KYB / KYC — **Must be live** → **PARTIAL. Read this row carefully.**

This is the row most likely to be challenged, so it is split into its two legs
exactly as the system splits them.

| Leg | State | What actually answers |
| --- | --- | --- |
| `director_kyc` | **LIVE** | **Stripe Identity**, key mode `sk_test`, account `acct_1ToXpoDgSL5WTGpm` (verified by direct call to `api.stripe.com/v1/account`). Ridgeline's director leg carries a real verification session id: `vs_1UEDLcDgSL5WTGpmif87HEZ7`. |
| `business_registry` | **LIVE PROBE, MANUAL VERDICT** | The probe is **GLEIF's LEI register** (`api.gleif.org/v1/lei-records/{lei} -> 200`) — a real third-party register, free and ungated. But Ridgeline's registry leg was **approved by an operator**, not by a provider: `operator-review (manual) / manual.approve.business_registry.e274546d-…2026-09-10T23:05:12.526Z`. |

**Persona is not configured at all.** `PERSONA_API_KEY` is empty
(`len=0`); `/api/health` reports the Persona webhook slot
`"status":"not_configured"`, `"missingEnv":["PERSONA_WEBHOOK_SECRET"]`.
`KYB_FORCE_SIMULATED` is empty, so nothing is being forced.

**The honest sentence.** The brief names *Persona KYB, Middesk, Sumsub* and
marks the slot **Must be live**. None of those three is wired, because all
three gate their sandboxes behind business verification that cannot be passed
in a weekend — which the trial's own rules anticipate. What is live is the
*director identity* leg (Stripe Identity, genuinely live) and a *real registry
lookup* (GLEIF, genuinely live). What is **not** live is a KYB provider
rendering a verdict on the business: the verdict on Ridgeline was a named
human's review.

This is defensible and it is already labelled that way inside the system — the
health payload itself says *"GLEIF is a substitution for Middesk / Persona KYB
/ Sumsub KYB, all gated"*, and coreloop prints `registry operator-review
(manual) · director stripe-identity (live)` rather than calling the whole slot
live. **It must be said out loud in the debrief before a grader asks**, because
the trial's automatic-fail list includes *"a simulated integration presented as
live"* and this row is one imprecise sentence away from looking like that. It
is not that today: nothing in the repo or the endpoint claims a KYB provider
approved this business.

Note the health payload marks `business_registry` with `"mustBeLive": false`
while the brief marks the KYB/KYC slot **Must be live**. The endpoint's own
flag is therefore softer than the brief on exactly the leg that is manual.

### 3.3 Payment rails — "Live or simulated" → **DONE, live**

`GET https://sandbox.increase.com/accounts?limit=1 -> 200`, verified directly.
Increase webhook consumer registered at `/api/webhooks/increase` with a
verifier. Returns and recalls are modelled — §5.5. An ACH simulator
(`achsim`) also exists behind the same interface and ships settlement files;
it is labelled `achsim` in `recon_run.provider`, not disguised.

### 3.4 Open banking funding — "Live or simulated" → **DONE, live**

`POST /institutions/get -> 200` against Plaid sandbox, 40 ms. Webhook consumer
registered at `/api/webhooks/plaid` with a verifier. §1.7 records the one part
not established (a grader completing Link themselves).

### 3.5 Stablecoin — "Live strongly preferred" → **DONE, live on testnet**

Verified by calling the chain directly, not the app:

```
eth_blockNumber  -> 0x2c87547   (block 46,626,119, Base Sepolia)
eth_call balanceOf(0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918)
  on 0x036CbD53842c5426634e7929541eC2318f3dCF7e (canonical Base Sepolia USDC)
  -> 13.058440 USDC
```

Gas is funded (68,384,981,507,408 wei). Ten `usdc` entries stand in
`journal_entry` under nine external references — **the rail is ledgered in USD
cents like every other rail**, which is the point the brief was making. 110
`fx_quote` rows back the FX-quote-first flow.

---

## 4. The core loop — seven arrows, end to end on the deployed URL

`node scripts/coreloop.mjs --base-url https://corgi-trial-psi.vercel.app`
→ **PASS 7 · FAIL 0 · SKIP 0**, 89 s, **103 HTTP calls to the deployed origin**
and 3 to the Lithic sandbox. Run id `CL-MTXAIWE5`, 2026-09-11T18:29:19Z.

The script imports `postgres` and nothing else from this repo — no application
function is reachable from it. Every write is a `multipart/form-data` POST to a
server action whose id is scraped from the live HTML at runtime.

| # | Arrow | Verdict | The number that proves it |
| --- | --- | --- | --- |
| 1 | open an account behind a real KYB check | **PASS** (10/10) | pending business refused `KYB_PENDING`, **0 rows written**; verified business allowed |
| 2 | fund it from a linked external bank | **PASS** (7/7) | ledger +$1,250.00, available **+$0.00** — an uncleared-credit hold `36a0f1c9-…` withholds the identical amount until 2026-09-14T13:00Z |
| 3 | issue a real (sandbox) card | **PASS** (9/9) | Lithic card `e5de1361-…`, last four 7123, OPEN, $5,000.00 per-transaction control at version 1 |
| 4 | authorise, then settle for a different amount days later | **PASS** (24/24) | $50.00 → $73.40, hold released exactly once. *"Days later"* is the sandbox's limit, not the model's — §1.3 |
| 5 | send an outbound payment that needs a second approver | **PASS** (27/27) | maker refused by `assert_maker_checker()`, SQLSTATE 42501, 0 approval events written |
| 6 | survive a reversed settlement | **PASS** (22/22) | real signed Lithic `return_reversal` webhook; both time axes printed; pre-correction watermark still returns the pre-correction number |
| 7 | reconcile the scheme file | **PASS** (11/11) | break `LF6-MTX1R8MG-3`, $240.71, category `in_ledger_not_file`, aged, severity Open — **read only; see §1.10** |

Position across the whole run, one business, one definition:

```
Ridgeline Robotics, Inc.
  opening $35,294.73 available -> closing $35,221.33 available
  (ledger $66,582.51, holds $410.00, uncleared $28,451.18, pending out $2,500.00)
```

**Rows this document's own run wrote** (declared, per the rule that says to):
on Ridgeline Robotics — one $1,250.00 funding entry plus its uncleared-credit
hold; one new Lithic card `e5de1361-…`; one $50.00 authorisation and its hold;
one $73.40 clearing; one $3,200.00 payment instruction `1989b801-…` raised and
approved; one $73.40 refund and its reversal `bd372233-…`. Net effect on
available: **−$73.40**. Ridgeline's ledger is unchanged at $66,582.51 from
before the refund pair. Nothing was written to Kettle & Crumb or Silverline.

---

## 5. The domain gauntlet, ten items

### 5.1 Ledger balance versus available balance — **DONE**

**Available is derived. There is no second stored number.** Verified against
`information_schema`, not against a document:

- Searching every column named `%available%` across the database returns
  **ten hits, and only two are `available_cents` — both on VIEWS**
  (`v_available_balance`, `v_balance_definition_drift`). No base table carries
  an available balance.
- Every balance-ish column on a **base table**, in full:
  `hold.available_at` (a timestamp, not money),
  `interest_posting.basis_balance_cents`,
  `standing_order_outcome.observed_available_cents`,
  `statement.opening_balance_cents`, `statement.closing_balance_cents`.
  Those last three are records of *what was observed at a moment* — an interest
  basis, a standing order's decision input, a closed statement — not a live
  balance anything reads. `dbcheck` covers them by name:
  `PASS no stored balance column — balances are derived, not stored (3 named
  exceptions, each proven reproducible)` and `PASS every stored interest basis
  re-derives from the journal — ledger_settled_cents at the recorded watermark,
  row by row`.
- **`hold` itself carries no amount column and no status column.** Its columns
  are `id, account_id, memo_account_id, kind, external_ref, value_date,
  expires_at, available_at, policy_id, created_at`. A hold's size is the fold
  over its memo entries. There is nothing to drift.
- `v_balance_definition_drift` = **0 rows** over 7 accounts with a balance —
  the hold model and `ledger_availability()` agree at the live point.
- The five terms are named on every figure the core loop printed, and the run
  re-adds them in JavaScript from a separate body: *"If AVAILABLE is not exactly
  the four terms printed beside it, it came from somewhere else."*

### 5.2 The authorisation lifecycle — **DONE**

Every transition named in the brief exists as an event kind on this book:

| kind | rows |
| --- | --- |
| `authorization` | 880 |
| `clearing` | 476 |
| `force_post` | 208 |
| `refund` | 180 |
| `expiry` | 143 |
| `declined` | 115 |
| `authorization_reversal` | 77 |
| `incremental_authorization` | 13 |

Partial capture, multiple captures and over-capture are the `clearing` arm
against an `authorization` of a different size — leg 4 drove an over-capture
($50 → $73.40) and the run's own note reads *"The over-capture of $23.40 is not
special-cased anywhere."*

**"The hold releases exactly once, no matter how strangely the sequence
arrives":** `v_hold_release_drift` = **0** over 598 released holds, and
`v_hold_drift` = **0** over 574 live holds — the memo book equals the fold over
card events.

### 5.3 Settlement is not authorisation — **DONE**

Three shapes, all three present and none special-cased: different amount
(leg 4), later (§1.3), and **no auth at all — 208 `force_post` events**.

### 5.4 Out-of-order delivery — **DONE**

Two mechanisms, both live:

- **Parking.** `v_webhook_parked` holds real parked events with a written
  reason and a backoff. Example, verbatim from the view: Increase wire
  `sandbox_wire_transfer_7gjchnjxs3o1je2xaqb2` carries an idempotency key that
  *"names no payment_instruction on this book. NOTHING WAS POSTED. Either the
  instruction has not been written yet, or this wire was originated outside
  this system — and a wire with no approval behind it is an incident for a
  person, not a row for a consumer."* 11 park attempts, next attempt scheduled,
  waiting 07:01:35. It did not crash and it did not guess.
- **Deliberate reordering.** `chaos_run` carries runs with control
  `reorder_window`, noted *"clearing immediately (once), then authorization
  +1s (once)"* — the settlement webhook arriving before its auth, on purpose,
  on card `1d339adb-…`, auth 5000c / clearing 7340c. Also `settlement_delay`.

Idempotency: **1,811 rows in `webhook_inbox`, and all 1,811 have
`signature_verified_at` set.** Not one unsigned event was consumed.

### 5.5 Returns and recalls — **DONE.** `/api/webhooks/increase` live with a
registered verifier; a dedicated migration `0039_inbound_recall.sql`; 568
reversal entries on the book; the corrected position appears at the original
value date (§1.5, §1.3).

### 5.6 Bitemporality — the correction test — **DONE.** §1.5. `journal_entry`
carries `value_date` (date), `booking_seq` (bigint) and `booking_time`
(timestamptz) as three separate columns, plus `reverses_entry_id` and
`correction_group_id`. `ledger_availability()` takes `p_value_date`,
`p_booking_seq` **and** `p_as_of` — the as-of read is in the one definition,
not bolted on beside it. 980 entries value-dated 2026-09-10 were last booked
2026-09-11; 93 value-dated 09-08 were booked 09-10/09-11.

### 5.7 Statements — **PARTIAL.**

*DONE:* statements are versioned and content-addressed — `statement` carries
`version`, `booking_watermark`, `content_hash`, `generated_at`, `generated_by`,
`line_count`. A re-run appends a new version at a new watermark; it never
revises. 62 rows over 30 periods, max version 4, 62 distinct hashes.

*Not established:* **I could not prove "identical every time."** The right test
is *regenerate a closed period at the same watermark and compare
`content_hash`* — every pair of versions on this book sits at a *different*
watermark (e.g. 4045 vs 4047), which is correct behaviour but means the
determinism claim is untested by the data alone. There is no
`v_statement_*_drift` view in the 37 that `dbcheck` gates. Running that
comparison needs a write (a regeneration), which this agent does not do. **This
is a real hole in the proof, not in the design, and it is one command from
being closed by whoever owns statements.**

### 5.8 Standing orders — **DONE.** 49 mandates. 32 occurrences, **32 claimed,
32 distinct idempotency keys** — the claim is the idempotency key, so a retry
across a restart cannot fire twice. `v_standing_order_double_fire` = 0. The
insufficient-funds policy is written in `docs/STANDING-ORDERS.md` and
`standing_order_outcome.observed_available_cents` records the balance the
decision was made against — the policy leaves evidence, which is the part that
usually goes missing.

### 5.9 Scheme reconciliation — **PARTIAL.** §1.10. Engine, three categories,
breaks screen with aging on two clocks and severity escalation across a day
close: all present and live. **No surface runs it or plants into it.**

### 5.10 Maker-checker — **DONE**, including the agent clause.

§1.9 covers the human half. The agent half is enforced and was verified on the
deployment: the MCP surface exposes **11 tools — 10 read, 1 write** — and the
write tool's own description begins *"Queue an outbound payment for HUMAN
APPROVAL. This tool does not pay anyone."* The server instructions returned by
`initialize` say: *"You cannot approve, release, submit or cancel a payment
through this surface; those operations are not exposed to any agent."* There is
also a tool — `list_agent_limits` — that returns the operations this bank
deliberately does not hand an agent, with the argument for each, which is the
brief's "written list" made queryable.

The ten read tools: `get_balance`, `list_pots`, `list_transactions`,
`list_payees`, `list_standing_orders`, `list_card_controls`, `list_accruals`,
`list_disputes`, `list_recon_breaks`, `list_agent_limits`. The brief's minimum
was three.

---

## 6. Live fire, seven items

**Caveat, stated once and applying to every row:** `scripts/livefire.mjs` was
not run by this agent — it posts real sandbox money and another agent owns it.
Rows marked *residue* are scored on artefacts a previous livefire run left in
the database and at Lithic, which is weaker than watching it happen.

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Create a card, simulate a $50 fuel-pump auth: available drops, ledger does not | **DONE — driven live this run** | Coreloop leg 3+4, MCC 5542, descriptor `CORGI PUMP CL-MTXAIWE5`. Ledger $0.00 delta, available −$50.00. §1.2 |
| 2 | Capture $73.40 two days later; hold releases exactly once; ledger posts the settled amount | **PARTIAL — driven live, minus the two days** | Coreloop leg 4: $73.40 posted, 1 opening + 1 releasing memo entry, `hold_closure` rows 0, memo balance $0.00. The two-day gap is the sandbox's limit (§1.3) |
| 3 | Reverse that settlement the next day and pull up the statement for settlement day | **DONE — driven live this run** | Coreloop leg 6, real signed webhook, both axes, statement URL rendered. Same-day rather than next-day; the cross-day form is on the book from earlier runs (§1.5) |
| 4 | Deliver a settlement before its auth and watch the matcher | **DONE — residue, and it is good residue** | `chaos_run` control `reorder_window`, note *"clearing immediately (once), then authorization +1s (once)"*, card `1d339adb-…`, auth 5000c / clearing 7340c, started 2026-09-11T10:50:23Z. Parking mechanism independently verified live in `v_webhook_parked` (§5.4) |
| 5 | Payment initiator tries to approve their own above-threshold payment | **DONE — driven live this run** | Coreloop leg 5. Both refusals, both from the trigger, 0 events written |
| 6 | Delete one row from tonight's scheme file and ask the breaks screen where it went | **PARTIAL** | The break surfaces correctly and is classified and aged (`LF6-MTX1R8MG-3`, $240.71, `in_ledger_not_file`) — verified live on `/breaks`. **The deletion cannot be performed from any surface** (§1.10). A grader who says "delete a row and show me" needs a script run in a terminal |
| 7 | Turn off the issuing provider's webhooks for five minutes mid-demo; what does the customer see? | **PARTIAL — the machinery is there; the customer-facing answer is not established** | `/chaos` renders live (HTTP 200). Tables `chaos_control`, `chaos_run`, `chaos_delivery`, `chaos_event` and views `v_chaos_active` / `v_chaos_expired` / `v_chaos_outbox` / `v_chaos_inbox` all exist and carry rows. `/api/health` carries per-provider webhook staleness thresholds with written rationale (Lithic: stale after 180s, quiet after 900s, *gates deployment status*) and a `degradedBy` list. **What I did not establish is what the customer sees on `/client` during an outage** — that needs the harness driven, which I did not do |

---

## 7. Stretch ladder, six items

| Item | Verdict | Evidence |
| --- | --- | --- |
| Cross-border USDC payout with an FX quote the customer accepts first | **DONE** | USDC live on Base Sepolia (§3.5); 110 `fx_quote` rows; `/payouts` and `/client/payouts` render; FX commitments open a hold at acceptance — `fx-commitment:<id>:open`, e.g. *"FX commitment FXQ-SXHC9QTN accepted — $123.45 withheld until the payout settles or the window closes"*. `v_fx_commitment_unheld` = 0: every standing commitment withholds exactly the price it committed. **But see §9.6 — the FX commitment memo posting is the unargued red.** |
| Card controls enforced in the real-time auth decision webhook | **DONE** | `/api/webhooks/lithic-auth` (ASA) deployed, returns 401 unsigned. Controls are versioned: coreloop read *"Card controls version 1 · program default · $5,000.00 per transaction, no daily or monthly limit, no blocked categories"* off the live card. `list_card_controls` exposed over MCP. `/team` renders. |
| Interest or fee accrual computed at end of day, visibly, on the ledger | **DONE** | 29 `interest_posting` rows. `/accruals` 200 (405 KB), `/economics` 200. `v_accrual_ledger_drift` = 0 (every accrual claim matches the entry it cites), `v_interest_ledger_drift` = 0, `v_interest_rate_drift` = 0 (no day re-priced by a later rate), `v_accrual_month_drift` = 0. `PASS every stored interest basis re-derives from the journal`. `/api/cron/accrual` exists. |
| Sub-accounts or pots, instant internal transfers that are pure ledger moves | **DONE** | 3 pots; 92 `internal` entries. `v_internal_transfer_impure` = 0 (an internal transfer touches only the customer's own subtree), `v_pot_identity_drift` = 0 (main + every pot = the whole subtree), `v_pot_negative` = 0, `v_pot_orphan` = 0, `v_pot_guard_disarmed` = 0. The API refuses to debit a pot directly and explains why. **See §9.5 — the pots concurrency probe left the fifth red.** |
| Dispute intake on a settled card transaction, provisional credit done honestly | **DONE** | 29 disputes; `dispute` carries `disputed_entry_id`, `memo_account_id`, `network`, `network_code`, `network_case_ref`. `v_dispute_ledger_double_count` = 0 — one dispute line, one row, so the episode screen counts money once. `/disputes` and `/client/disputes` render. |
| Payee confirmation that catches the mistyped account before the money leaves | **DONE** | 478 payees, **94 `payee_acknowledgement` rows** each carrying a `verification_id`. `list_payees` over MCP returns *"each with its last verification"*. `/payees` 200 (2.0 MB). |

All six attempted. None is a stub.

---

## 8. "What we grade hardest"

### 8.1 The hold model under hostile sequencing — **DONE**

Three guards, all at zero, all with their population printed rather than
assumed:

```
v_hold_drift               0   over 574 live holds
v_hold_release_drift       0   over 598 released holds
v_hold_closure_not_terminal 0  over 223 of 354 closures, BY DECLARED WRITER
```

The third is the interesting one and it is honest about its own reach.
`dbcheck` prints exactly which closures the guard ranges over and which sit
outside it, by the writer each closure declares:

```
IN   expiry_sweep        114    IN   posting_path        109
out  repair               52    out  test_harness         25
out  dispute              23    out  availability_sweep   13
out  wire_availability    12    out  (undeclared)          6
```

and states the rule: *"out = a repair, an operator override, a dispute, a
rail's availability sweep or a test fixture: none of them claims the hold
model's terminal predicate licensed the row, which is the only thing this guard
asserts. Every one is counted here."* Backed by
`PASS every card-auth closure declares its writer — hold_closure.source is
non-NULL on every closure the invariant's population is drawn from`.

Hostility is applied on purpose, not hoped for: `chaos_run` reorders clearings
ahead of authorisations; `v_webhook_parked` shows the matcher parking rather
than guessing; the fuzzer wrote authorisations at value dates like 1642-08-31
and 1956-09-24 and the book absorbed them.

### 8.2 The bitemporal correction — **DONE**

§1.5 and §5.6. Value date and booking date are different columns, the as-of
read is a parameter of the one availability function, and the live run printed
both axes with the pre-correction watermark still returning the pre-correction
number. Corrections are `reverses_entry_id` + a re-book inside one
`correction_group_id`, never an edit — and the database physically refuses an
edit (§1.4).

### 8.3 Is available balance derived truth or a stored lie? — **DERIVED TRUTH**

§5.1, and it is stronger than the brief asks. There is no `available_cents`
column on any table. `hold` has no amount column at all. There is one
definition, `ledger_availability()`, with five terms, and
`v_balance_definition_drift` compares it against an independently-computed
recomputation and reads **0**. Two independent surfaces (the core loop's own
JavaScript re-addition, and the MCP `get_balance` tool on the deployment)
returned the same $35,221.33 against $66,582.51 ledger.

There is no cron that "fixes" a balance. There is nothing for a cron to fix.

---

## 9. The red register — six failing invariants, reported in full

`node scripts/dbcheck.mjs` → **47 passed, 6 failed**. All six are named here
with what they are and what the build says about each. Five carry a written
argument on the script's own `RED_REGISTER`. **The sixth does not, and that is
the finding of this document.**

`dbcheck --prove` additionally makes **every one of the 37 invariant views fail
on purpose**, each inside a rolled-back transaction — a guard nobody has seen
fail is a claim, so each one has been seen to fail.

### 9.1 `v_refused_auth_hold` — 311 rows, $22,546.00 withheld — ON THE REGISTER

Authorisation events on holds still withholding money with no `APPROVED`
verdict. Every row is `unanswered` — not a recorded refusal, but **no verdict
observed at all**. Migration 0032 repaired the `refused` half (12 holds,
$600.00). An unanswered event cannot be repaired the same way *"because the
repair would be inventing the verdict nobody recorded."* Narrowing the view to
require a recorded verdict is precisely the `INNER JOIN … IS NOT NULL` that
0026 shipped and 0032 removed — a guard excluding by construction the exact
state the bug produces. Argued in `docs/DASHBOARD.md`, `docs/COMPLIANCE.md`
§5.1, `docs/CUT-LIST.md` row 16.

**This is the largest red by money.** Cleared by a verdict arriving from the
provider, or by any row appearing under `verdict = 'refused'`, which is
repairable and must be.

### 9.2 `v_hold_expiry_drift` — 15 rows, **$0.00 exposure** — ON THE REGISTER

A card hold's expiry stored twice and disagreeing: `hold.expires_at` (which
`ledger_availability()` reads) against `card_authorization.expires_at` (which
`v_card_auth_hold` reads). **Every row is a fixture** that bypassed
`ensureAuthorization()` and ran two separate `now() + interval '7 days'`
statements 135–176 ms apart. All closed, all released, zero cents withheld.
Repairing means rewriting `expires_at` on rows in two append-only tables.
Argued in `docs/HOLDS.md` §10.5.

The register's own note: it is the **composition** of the rows that matters,
not the count — growth is expected while fixtures write two clocks.

### 9.3 `v_advice_delta_unsound` — 1 row, $0.00 exposure — ON THE REGISTER

One advice was converted against an authorised amount of −7340. **The
conversion is already fixed** (`base = max(A, 0)`), so no future advice can take
this shape. The stored row is not repairable: there is no
`card_auth_event_reversal`, and the only compensation available is appending an
`authorization_reversal 7340` — *"a SECOND fact the network never sent. That is
the sin being corrected, not a cure for it."* Argued in `docs/HOLDS.md` §11.4.

### 9.4 `v_hold_closure_unexplained` — 4 rows, $132.00 — ON THE REGISTER

Four standing closures over authorisations the fold still calls OPEN, all
`test_harness`. Both repairs were priced and both are worse: a synthetic
`expiry` event is a false statement in an append-only table, and a closure
reversal plus completion would **re-withhold $132.00 this book has already,
deliberately, given back**. Argued in `docs/HOLDS.md` §11.5–11.6.

**Time bomb, and it is worth knowing before the debrief:** on **2026-09-17**
the real clock reaches `expires_at`, `is_closed` and `is_released` both flip,
and these four land on `v_hold_release_drift` — which is one of the three
headline-zero guards — *"until a sweep that nothing currently schedules is
run"* (decision 046).

### 9.5 `v_pot_line_provenance` — 2 rows, $0.00 exposure — ON THE REGISTER

Two journal entries (`race-1789147074432-A` and `race-…-restore`, booking seqs
11785 and 11787) moved pot money on the internal rail under a key with no
`pot:` prefix. They net to zero as a pair. **The build wrote them itself**,
proving 0057's concurrency claim, and the register says so in capitals:
*"IT CAUGHT US."* The probe should have posted the winner through
`movePotFunds()` and left only the loser foreign — the loser was refused, and a
refused write leaves no residue, so the identical proof was available at a cost
of nothing.

There is no repair: the tables are append-only and `idempotency_key` is
immutable. The register's condition is unusual and correct: **"changes it:
NOTHING, EVER."** What must not change is the count — a third row is a new
foreign pot write. `src/lib/pots/pots.integration.test.ts` test 13 pins the two
**entry ids** (not a count, *"because a count is a tolerance and tolerances
absorb the next mistake silently"*).

### 9.6 `v_memo_line_placement` — 4 rows — **NOT ON THE REGISTER**

`dbcheck` says so itself, in its own words:

> **NOT ON THE REGISTER — no written argument covers this red.** It was not one
> of the four decided failures when this block was written, so nothing here
> excuses it: diagnose it, repair it, or argue it in writing and add it to
> RED_REGISTER in this file.

**Diagnosis, done here.** All four rows are **FX commitment holds opened today
between 17:45:08Z and 17:51:12Z** — within the hour before this document was
written. Entry `dbfd9cf3-…` (`fx-commitment:d6e6747a-…:open`,
FXQ-FCQ2B3TB, **$470,372.99**), `0f2853fb-…`, `a2850137-…`, `743eb3a7-…`
(FXQ-Y7XJ7WJ3 / FXQ-SXHC9QTN / FXQ-0QX763X2, $123.45 each).

The view classifies them `"the contra side is not a single house memo line"`.
The mechanism, read off `v_memo_line_placed`'s definition and the rows:

- Both legs of the entry land on accounts with **`business_id IS NULL`** —
  `9300 "Holds - accepted FX commitments"` and `9900 "Memo contra"`. The view
  counts `house_memo_lines` as lines whose account has no `business_id`, and
  requires exactly **1**. It gets **2**.
- The cause: **account `9300` is a single shared house account**
  (`d183dff6-a1c5-4f6b-9209-59dda8b8aa5b`, `business_id` NULL) that **every**
  FX commitment hold parks on, regardless of which customer it belongs to.
  Every other hold kind parks on a per-business memo account.

**What this does and does not cost.**

- It does **not** contaminate availability. `v_hold_state` scopes the memo
  balance by `hold_id` via `journal_entry.hold_id`, not by account balance, so
  each of the four reads its own amount ($470,372.99 / $123.45 / $123.45 /
  $123.45). `v_balance_definition_drift` = 0 and `v_book_not_zero` = 0 over the
  whole book.
- It does mean **"how much is this customer withholding against FX?" cannot be
  read off an account balance** — only by folding entries by hold — and the
  memo book is not segregated per business for this one hold kind. That is the
  blindness the view was built to catch, and it caught it.
- The four holds are **live**: `is_released = false`, `expires_at` NULL,
  `available_at` 2026-09-12, total **$470,743.34** still withheld. **They sit on
  fixture businesses** — *Hold Fuzzer Fixture Co.* and *Live Fire — attack 3
  (bitemporal correction)* — **not on Ridgeline, Kettle & Crumb or Silverline.**
  No demo balance is depressed by them.

**Verdict: a real, live, undocumented red on code written today.** It is the
only one of the six with no argument behind it, and the build's own rule —
diagnose, repair, or argue in writing — has not yet been applied to it. That is
the one thing on this list a grader can fairly call an omission rather than a
decision.

*(Note: `scripts/coreloop.mjs` prints `4 excused on dbcheck's register` and
lists `v_pot_line_provenance` alongside `v_memo_line_placement` as "red, and not
on either list". Its excused-list is one entry stale — `v_pot_line_provenance`
**is** on the register per `dbcheck`. Cosmetic, but two scripts disagree.)*

---

## 10. Defects found while measuring, outside the brief's checklist

### 10.1 The operator/customer boundary is written but **NOT DEPLOYED**

`src/middleware.ts` and `src/lib/authz/**` implement a default-deny boundary —
a customer session must be refused every operator screen with **HTTP 403** and
the code `OPERATOR_ONLY` on the response header and in the body.

**Measured against the deployed URL, twice, eight minutes apart:**

```
curl -b 'corgi_demo_role=customer' https://corgi-trial-psi.vercel.app/accounts
  -> HTTP 200            (expected 403)
  -> no x-corgi-authz header at all
curl -b 'corgi_demo_role=customer' https://corgi-trial-psi.vercel.app/payments
  -> HTTP 200            (expected 403)
```

`/api/health` reports commit `11658fa` both times. The local files were last
written at 11:15–11:18 local today. **The boundary exists in the working tree
and does not exist on the URL a grader will open.** Until a deploy lands,
`docs/DEMO.md`'s customer/operator separation is a claim about the repo, not
about the deployment — and the middleware's own comment describes the exact
defect it was written to fix as still live in production.

**This needs a deploy, not a fix.**

### 10.2 Duplicate migration numbers

`db/migrations/` contains two `0053_`, two `0054_` and two `0056_` files:

```
0053_card_auth_judged.sql      0053_fx_commitment_hold.sql
0054_deposit_and_memo_provenance.sql   0054_fx_commitment_regime_immutable.sql
0056_advice_base_reconstruction.sql    0056_plaid_item_state.sql
```

Apply order between each pair is decided by filename sort, not by intent. It
has not broken anything — the book is consistent — but it is a question a
grader can ask that has no good answer, and it is 30 seconds of explanation.

---

## 11. Everything not DONE, ranked by what it costs against the brief

| Rank | Item | Verdict | Cost |
| --- | --- | --- | --- |
| 1 | **Operator boundary not on the deployed URL** (§10.1) | **ABSENT on deployment** | A customer cookie reads every business on the book. Not a brief line, but it is the kind of thing live fire finds in thirty seconds, and the repo says it is fixed. **Deploy.** |
| 2 | **"Users need to reconcile the scheme file"** — no run/plant/upload control on any surface (§1.10, §5.9, live fire 6) | **PARTIAL** | A named brief sentence and a named live-fire attack ("delete one row from tonight's file and ask your breaks screen"). The screen is excellent; the verb is missing. A grader will ask to run it. |
| 3 | **`v_memo_line_placement`** — unargued red on code written today (§9.6) | **PARTIAL / open** | The build's stated rule is that an honest partial beats a claimed whole. Six reds with five arguments is five arguments; the sixth reads as an oversight. Either the argument or the fix. |
| 4 | **A mobile app** (§2) | **ABSENT — decision, Saahith's** | Named in the v1 scope list. Defensible and deliberate; it must be *said*, not discovered. |
| 5 | **KYB/KYC "Must be live"** — director leg live (Stripe Identity), business verdict manual, GLEIF as the registry probe (§3.2) | **PARTIAL** | One of only two Must-be-live rows. Already labelled honestly everywhere I checked. The risk is a loose sentence in the demo, not the build. |
| 6 | **Statement reproducibility unproven** (§5.7) | **Not established** | "A closed day's statement is reproducible forever, identical every time" is gauntlet item 7 and no measurement on this book proves it. The design supports it; nothing demonstrates it. |
| 7 | **Self-serve onboarding stops at a privilege boundary** (§1.6) | **PARTIAL — by design** | Least privilege working. Costs a demo beat, not a point, as long as it is explained as the design choice it is. |
| 8 | **"Days later" settlement** (§1.3) | **PARTIAL — provider limit** | The sandbox will not wait. The value-date axis is proven separately. Say it before it is asked. |
| 9 | **Plaid Link not completed by a stranger** (§1.7) | **Not established** | The brief says "an external bank they link themselves." Plaid is live and funding works; the self-link is pre-established. |
| 10 | **Customer-visible degradation during a provider outage** (live fire 7) | **Not established** | Harness, thresholds and health gating all exist. What `/client` shows during the outage was not measured. |
| 11 | **Silverline Freight Co. — 0 cards, 0 members** (§1.1) | **Cosmetic** | One of three demo businesses is empty on the brief's headline feature. |
| 12 | **Duplicate migration numbers** (§10.2) | **Cosmetic** | A question with no good answer. |

---

## 12. What holds

Stated as plainly as the gaps, because both are the point:

- **Available balance is derived truth.** No table carries it. `hold` carries
  no amount. One function, five terms, and a guard that recomputes it
  independently and reads 0.
- **The ledger cannot be edited.** Not by policy — by `permission denied`,
  proven by attempting it.
- **The hold releases exactly once.** 574 live, 598 released, drift 0 on both,
  under deliberately reordered webhooks.
- **The correction is bitemporal and was driven live** through a real signed
  provider webhook on the deployed URL today.
- **The maker-checker refusal comes from a database trigger**, reached by a
  hand-assembled POST that bypassed the disabled UI control.
- **Seven of seven integration slots answered a direct call** that did not go
  through this application.
- **The core loop ran 7/7 with 0 skips**, 103 HTTP calls against the deployed
  origin, in 89 seconds, today.
- **1,811 of 1,811 webhooks were signature-verified.** Not one unsigned event
  was consumed.
- **Six invariants fail and all six are printed**, five with written arguments
  that price the repair and reject it. A build that hides its reds does not
  print its reds' populations.
