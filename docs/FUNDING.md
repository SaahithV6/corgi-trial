# Funding — leg two of the core loop

> open an account behind a real KYB check → **fund it from a linked external
> bank** → issue a real (sandbox) card → authorise, then settle for a different
> amount days later → …

This file is the evidence for the bolded leg. Every id, request id and status
code below came back from a real call; nothing here is illustrative.

Route: `/funding`. Code: `src/lib/rails/plaid/**`, `src/app/(app)/funding/**`,
`src/components/funding/**`.

---

## 0. Any business, not the one this was built against

This section was written after `/funding` was found to work for exactly one
customer. It is first because it is the part of the screen most likely to be
wrong again.

### 0.1 The failure, and the measurement that found it

**Symptom.** `node scripts/coreloop.mjs` leg 2 skipped, with zero checks held:

```
waiting on: /funding renders, but carries no fund form with
            accountId/amount/valueDate/reference
```

The loop had stopped using Ridgeline Robotics. It now chooses its subject by
asking the deployed `/onboarding` gate, and it had chosen **Kettle & Crumb
Bakery LLC** (`1151e7b5-b75b-5f58-bdbf-68cd714178ce`, `2100` leaf
`392043e2-1d7f-406f-b036-321b4775108b`), which had passed KYB through the real
manual-review path and had its accounts opened by approval.

**Three plausible causes, all wrong.** The obvious hypotheses were that the
screen keyed off a linked Plaid Item only Ridgeline had, that it defaulted to a
business chosen by ordering, or that it required prior funding history. All
three were measured and none of them was it. `listDepositAccounts()` returns
every open `2100` leaf and has no Item predicate, no history predicate and no
per-business branch.

**What it actually was.** `GET https://corgi-trial-psi.vercel.app/funding`
returned **200 with one form on the page** — the error panel's retry button —
and the heading *"The funding screen could not be drawn"*, code
`FUNDING_PREFLIGHT_FAILED`, detail `(unknown)`. The `(unknown)` was the clue: the
detail is read from `thrown.code`, and a Postgres error always carries one, so
the thrown value was not a database error at all.

Reproduced locally against the same Neon database, with the snapshot's own catch
temporarily logging the value it swallows:

```
FUNDING_PREFLIGHT_DEBUG RangeError: Invalid time value
    at DateTimeFormat.formatToParts (<anonymous>)
    at bankingDateOf        (src/app/(app)/funding/live-source.ts:189)
    at toUnclearedHoldView  (src/app/(app)/funding/live-source.ts:161)
    at readAccount          (src/app/(app)/funding/live-source.ts:244)
    at getSnapshot          (src/app/(app)/funding/live-source.ts:274)
```

And the rows behind it:

```sql
SELECT h.id, h.available_at::text, h.external_ref
  FROM hold h JOIN account a ON a.id = h.account_id
 WHERE h.kind = 'uncleared_credit' AND a.code = '2100';
```

```
4abc7970-ad8c-44cc-89cb-8658f918a5a7 | infinity | dispute:2978c569-8f55-4890-98fb-bb16f150c558
1ddcc2dc-00fb-4b82-bf76-1ffd86a0ac01 | infinity | dispute:ccbf1b9e-67f0-47b4-af8e-54640bbeebc9
637fd155-5119-41cb-a9c6-70f3f5785dd5 | infinity | dispute:e5a07307-e1f4-45bd-b892-588b8bf6423b
…nine rows in total, every one of them Ridgeline Robotics, Inc.
```

**The root cause.** `hold.available_at` is a `timestamptz`, and `timestamptz`
has two values that are not instants: `infinity` and `-infinity`. Disputes write
the first one deliberately — a provisional credit is an `uncleared_credit` hold
released by a person deciding the case, never by a clock, and `infinity` is how
"no release instant" is said in Postgres. The `postgres` driver parses it into a
`Date` whose time value is `NaN`. Neither `=== null` nor a truthiness test sees
that, so `Intl.DateTimeFormat.formatToParts()` ran on it and threw.

**Why it took the whole screen.** The throw happened inside a `Promise.all` over
every deposit account, inside the snapshot's single `try`. One unformattable row
became `FUNDING_PREFLIGHT_FAILED` for the entire book. So: **nine rows belonging
to Ridgeline removed the funding form from every customer, and the business that
could not be funded was Kettle & Crumb.** Funding had not been built against
Ridgeline; it had been *last exercised* before disputes existed, and the two
screens had never been open on the same book.

That is the shape of a generality bug worth naming: not a hardcoded id, but a
read whose blast radius is the whole book when its subject is one customer.

### 0.2 What changed

1. **`infinity` is a value, not a crash.** `isInstant()` guards the one place a
   hold's `Date` becomes text. A hold with no release instant carries
   `neverReleases` and the table prints *"on a decision, not a clock"* with
   `available_at = infinity` beneath it — rather than a date nobody computed.
2. **One account's failure is one account's failure.** The `try` moved from the
   snapshot into `readAccount`. A degraded account carries `readError`, its
   `balance` and `unclearedHolds` are `null`, and the rest of the book still
   draws. No zero is ever substituted for a figure no query produced.
3. **`?business=<uuid>` is honoured**, the same lever `/accounts`, `/pots`,
   `/payouts` and `/disputes` already had. It composes with `?state=`, the demo
   state bar carries it forward, and the Suspense key includes it so switching
   customer re-suspends instead of showing the previous business's balances.
4. **The default is no longer ordering.** With no `?business=`, the screen
   selects the first business that **may transact and has a deposit account** —
   not `accounts[0]` of an `ORDER BY legal_name`, which is how the form used to
   open on whichever fixture company sorted first.
5. **The KYB gate is read and enforced.** Every business on the book gets
   `transactGateForBusiness()` under both policies, printed exactly as
   `/payments` prints them, and `fundFromExternalBankAction` calls
   `transactGateForAccount()` **before any Plaid call**. Funding is transacting;
   the brief's "unverified entities can look but not transact" has no inbound
   exemption.
6. **Linking is step one, with its own button.** `linkExternalBankAction` links
   a real Item for any gate-allowed business and posts nothing. Having no bank
   linked is now visibly the start of the leg rather than an unexplained
   inability to take it.

### 0.3 The gate table lists businesses, not accounts

`/payments` reads its gate per deposit account. This screen reads it per
**business**, because Silverline Freight Co.
(`3593cbbb-cd74-5078-ab3c-c4c546910f95`) has never had an account opened and is
therefore invisible to an account-shaped list — and "why can I not fund
Silverline" is a question the screen has to be able to answer about a customer
that has nothing yet. Measured on the live book:

| Business | Status | Evidence | Deposit account | This deployment | If live evidence required |
| --- | --- | --- | --- | --- | --- |
| Holds Integration Fixture Co. | `pending` | `simulated` | opened | `KYB_PENDING` | `KYB_PENDING` |
| Kettle & Crumb Bakery LLC | `approved` | `manual` | `392043e2-…` | **may be funded** | `KYB_EVIDENCE_MANUAL` |
| Pots Integration Fixture Co. | `pending` | `simulated` | opened | `KYB_PENDING` | `KYB_PENDING` |
| Ridgeline Robotics, Inc. | `approved` | `manual` | `a0c41a37-…` | **may be funded** | `KYB_EVIDENCE_MANUAL` |
| Silverline Freight Co. | `needs_review` | `live` | **none opened** | `KYB_NEEDS_REVIEW` | `KYB_NEEDS_REVIEW` |

The business list is read from `business` and `v_business_kyb`, never by joining
`account` — `src/lib/ledger/boundary.test.ts` forbids any module outside
`src/lib/ledger/**` from writing SQL against `account`, `journal_entry` or
`journal_line`, and this file is not on its allowlist and is not going on it.
The account half of the join is `listDepositAccounts()`, the ledger module's own
named reader, and the two are matched in memory.

### 0.4 The Plaid rate limit, and why nothing runs on render

`/institutions/get` is rationed at ten calls per credential per window — measured
today, and the reason the integration health probe caches its verdict. Linking
creates real objects at Plaid, so:

- **Nothing on this screen calls Plaid on render.** The only thing the snapshot
  says about Plaid is whether both credentials are present, which is a fact
  about this process. Every claim about Plaid's *behaviour* comes from a button
  somebody pressed.
- **Nothing polls.** There is no interval, no retry loop and no background
  refresh anywhere under `src/app/(app)/funding/**`.
- **A rate limit renders as a rate limit.** Both link paths surface Plaid's own
  `error_code` — `RATE_LIMIT_EXCEEDED` included — together with every call
  attempted, its HTTP status and Plaid's `request_id`. Nothing is smoothed into
  a link that did not happen.

Note that `linkExternalAccount()` does **not** call `/institutions/get` at all:
its five calls are `/link/token/create`, `/sandbox/public_token/create`,
`/item/public_token/exchange`, `/accounts/get` and `/auth/get`.

---

## 1. What is live, in one paragraph

Plaid is **live**. `/funding` links a real Plaid Item at a real institution over
five real HTTP requests to `sandbox.plaid.com`, reads that account's real ACH
routing and account numbers, and then posts a real double-entry deposit to the
live Neon database through `postEntry()`. The deposit raises the customer's
**ledger balance** by the full amount and raises their **available balance by
nothing at all**, because an inbound ACH credit can be returned after it lands;
the difference is an `uncleared_credit` hold that releases on the banking day
and the 09:00 America/New_York instant that `funds_availability_policy` names.

**No ACH entry is transmitted to any network.** `POST /ach_transfers` is not
called from this path, and the ACH numbers Plaid returns are not registered with
an originator. The deposit is booked at **origination** — the moment the pull is
instructed — against `1130 ACH receivable — inbound in transit`, which is what
that account exists for and is how a bank books a debit at file-cut before the
file goes out. `1110` is deliberately untouched: debiting it would claim real
dollars arrived at the sponsor bank, and none did. The journal entry's own
`description` carries the words `ORIGINATED, NOT TRANSMITTED` for ever.

---

## 2. The real Plaid session

Sandbox, `PLAID_CLIENT_ID` / `PLAID_SECRET`, 2026-09-10. Institution
`ins_109508` (First Platypus Bank) — non-OAuth, so no browser redirect.

### 2.1 The happy path, five calls

The run behind the `$5,000.00` deposit in §3, made by pressing the button on
`/funding` (the server-action log line for it is
`funding.booked … itemId=ZVDWW6Rd87CJVpG7n5WMSNkXjD1B8Xi8PNWro`):

| # | Call | Status | Plaid `request_id` | ms |
| - | ---- | -----: | ------------------ | -: |
| 1 | `POST /link/token/create` | 200 | `18596f26db11884` | 629 |
| 2 | `POST /sandbox/public_token/create` | 200 | `775622a8491827a` | 2041 |
| 3 | `POST /item/public_token/exchange` | 200 | `51c97124c67ffb6` | 247 |
| 4 | `POST /accounts/get` | 200 | `a8c0d64e77a1c7a` | 371 |
| 5 | `POST /auth/get` | 200 | `94dbf1415f29931` | 515 |

Ids that came back:

```
link_token   link-sandbox-1499ee8a-30e7-48af-b482-72d17f10885a  (expires 2026-09-11T02:40:47Z)
item_id      ZVDWW6Rd87CJVpG7n5WMSNkXjD1B8Xi8PNWro
account_id   E4EDDbXawefZa74RjdQpIKdG9Gd8zgFDzZEae   "Plaid Checking" ••0000 (checking)
routing      011401533        (ACH)
wire_routing 021000021        (Fedwire — a DIFFERENT number at the same bank)
auth_method  INSTANT_AUTH
institution  ins_109508 / First Platypus Bank
```

The `access_token` is not recorded here and is not recorded anywhere. See §6.

### 2.2 Link's UI is not driven, and that is said out loud

**Step 2 of the production flow is `/sandbox/public_token/create`, not Link.**
Link is an iframe a person clicks through; there is no server-side way to
complete it, so a server action cannot. What this codebase does instead:

- `POST /link/token/create` is called **for real** — it is the genuine first
  step of the production, browser-driven flow, and the `link-sandbox-…` token it
  returns is the one you would hand to `react-plaid-link`. It is minted, printed
  on the receipt with its four-hour expiry, and then **not used**.
- The flow continues through `POST /sandbox/public_token/create`.

That endpoint is **not a mock and not our simulator**. It is Plaid's own
endpoint on Plaid's own servers, and the Item it creates is indistinguishable
from one a person made by clicking: same `item_id` space, same access token,
same webhooks, same `/auth/get` numbers, same `ITEM_LOGIN_REQUIRED` failure
mode. Everything it returns is therefore `evidence: 'live'`. What it cannot do
is prove our Link UI works, because there is no Link UI — and that is the
honest limit of this leg.

### 2.3 Fundability — fourteen accounts, three that can fund

`ins_109508` returns **fourteen** accounts and **three** ACH number entries.
`numbers.ach` is a **flat array across all accounts**, in an order unrelated to
`accounts[]`, so it is always indexed by `account_id`; `numbers.ach[0]` is a bug
that happens to work on whichever account a developer tries first.

Offered as funding sources: `checking`, `savings`, `cash management` — and only
when Plaid actually returned ACH numbers for them. Refused: the credit card and
the business credit card (an ACH debit against a credit line is an entry that
will be returned), the CD and the HSA (depository, but not debitable on demand),
the mortgage, the auto loan, the student loan, the HELOC, the IRA and the 401k.

The full account number never leaves the server action: `PlaidLinkedAccount`
carries the mask and the routing number only, and the numbers map is a separate
value for exactly that reason.

---

## 3. The money that moved

Business: **Ridgeline Robotics, Inc.** (`e274546d-6bdd-5266-b0fb-cc839a7811f9`),
deposit account `a0c41a37-2be1-5c30-bfe9-03455f048fac`, value date `2026-09-10`.

The `$5,000.00` deposit raised through the screen:

| Figure | Before | After |
| ------ | -----: | ----: |
| Ledger balance | `$23,584.93` | `$28,584.93` |
| − Card holds | `$310.00` | `$310.00` |
| − Uncleared credits | `$2,503.00` | `$7,503.00` |
| **= Available** | **`$20,771.93`** | **`$20,771.93`** |

Ledger up by exactly the deposit. **Available unchanged, to the cent.** Card
holds untouched, because a deposit is not an authorisation.

What was written, in one transaction:

```
financial entry  d6ff93a9-534c-44cf-9e53-cbdca4e9c3b9   booking_seq 1015
   DEBIT   1130  ACH receivable — inbound in transit    +500000
   CREDIT  2100/<Ridgeline>                             -500000
   description "Inbound ACH funding from First Platypus Bank 0000 via Plaid
                — ORIGINATED, NOT TRANSMITTED (no ACH entry was sent to any network)"

memo entry       3bb58b8d-dfe6-4091-a1cb-842019d978e6
   CREDIT  9200/<Ridgeline>  uncleared-credit holds     -500000
   DEBIT   9900  memo contra                            +500000

hold             8ea2eeeb-66bd-42be-96c5-24de709af205   kind uncleared_credit
   external_ref  plaid:ZVDWW6Rd87CJVpG7n5WMSNkXjD1B8Xi8PNWro
                      :E4EDDbXawefZa74RjdQpIKdG9Gd8zgFDzZEae
                      :DEMO-FUNDING-2026-09-10
   policy_id     c2ada775-2384-54a8-9f9a-5efdd64f4390   (ach/self, 1 banking day, 09:00 ET)
   value_date    2026-09-10
   available_at  2026-09-11T13:00:00.000Z
```

Four further deposits were booked by the gated integration suite
(`src/lib/rails/plaid/funding.integration.test.ts`) against the same account:
`$2,500.00`, `$1.00`, `$1.00` (all `ach/self`) and `$1.00` (`ach/new`, releasing
`2026-09-14T13:00:00.000Z`). Their entries are `booking_seq` 1007–1014.

`node scripts/dbcheck.mjs` → **14 passed, 0 failed**, after all of it.

---

## 4. Availability — the interesting decision

Moving a balance is arithmetic. Deciding when the customer may **spend** it is a
risk position, and it is the one an inbound-credit path is judged on.

### 4.1 The policy is data

`funds_availability_policy` (migration 0001 §5) is append-only and
effective-dated, keyed `(rail, counterparty_class, effective_from)`. Nothing in
the code decides how long to hold anything: `availability.ts` reads
`banking_days_hold` and `release_local_time` off a row and answers *which
instant that is*. The rows in force:

| rail | counterparty | banking days | releases |
| ---- | ------------ | -----------: | -------- |
| ach | `new` | 2 | 09:00 ET |
| ach | `known` | 1 | 09:00 ET |
| ach | `self` | 1 | 09:00 ET |
| card | `n/a` | 0 | immediately |
| internal | `self` | 0 | immediately |
| usdc | `n/a` | 0 | on confirmations, not a timer |
| wire | `n/a` | 0 | immediately |

`self` is the honest default for a Plaid-linked account — it is the customer's
own bank — and it is **still a hold**, because a customer can overdraw their own
outside bank as easily as anyone else can.

Every hold stores the `policy_id` it was created under, so a hold opened in
March is still explainable in December after the policy changed: the hold cites
a row, and the row is still there. The version that judges a credit is chosen by
its **value date**, never by today.

A missing policy row is **not** a default of "release immediately" — it is
`NO_AVAILABILITY_POLICY` and nothing is booked. A credit whose availability
nobody has decided is not one this system will make spendable by guessing.

### 4.2 Two things everyone gets wrong

1. **The Federal Reserve's Saturday rule is not the federal government's.** When
   a fixed-date holiday falls on a **Saturday** the Fed is *open* on the
   preceding Friday — federal offices close, the Fed does not, and ACH settles.
   On a **Sunday** it closes the following Monday. Applying the federal-office
   rule shortens a hold by a day roughly twice a year, always in the direction of
   releasing money early. 2026 has exactly one of these: Independence Day is a
   Saturday, so `federalReserveHolidays(2026)` returns **ten** dates, not eleven,
   and `2026-07-03` is a banking day. There is a test asserting precisely that.
2. **The clock is the bank's, not the server's.** "09:00" is 09:00 in
   America/New_York — `13:00Z` in summer, `14:00Z` in winter. A release computed
   in UTC is an hour wrong for five months of the year, and on the 09:00 boundary
   that means the money is spendable an hour before the policy says it is.

The schedule also reports **which** days it skipped, so "available Tuesday"
becomes "available Tuesday, because Saturday and Sunday are not banking days and
Monday is Labor Day" — an answer an operator can check, and checking it is the
only way anyone ever notices the holiday table is wrong.

### 4.3 Release needs nothing to be running — and the bookkeeping that does

`v_hold_state`'s release predicate (migration 0011) already reads
`kind = 'uncleared_credit' AND now() >= available_at`, and
`ledger_availability()` (0022) re-derives the same arm at a parameterised
instant, so **available rises on the clock whether or not any sweep executes.**
Measured on Ridgeline's 2100 leaf across one of these boundaries, same value date
and same booking watermark:

| `p_as_of` | ledger | card holds | uncleared | available |
| --------- | -----: | ---------: | --------: | --------: |
| `2026-09-11T12:59:59Z` | 5,621,471 | 41,000 | 3,345,518 | **1,984,953** |
| `2026-09-11T13:00:01Z` | 5,621,471 | 41,000 | 1,720,118 | **3,610,353** |

$16,254.00, spendable on the instant the policy names, with nothing running.
**A sweep that never runs is safe. The customer's available balance is already
right.**

What a sweep is for is the two things the database cannot do for itself: write
the `hold_closure` row so every reader agrees — including `availableBalance()`,
whose predicate is closure-only and does not know about `available_at` — and post
the memo entry that drives the 9200 leaf back to zero so `v_hold_release_drift`
stays empty.

**That second one is bookkeeping, and on 2026-09-11 it was measured not
happening.** The guard was empty at 12:47Z and held thirteen rows at 13:17Z, all
thirteen `uncleared_credit`, all `available_at = 2026-09-11T13:00:00.000Z`, every
one with a single journal entry and no closure row. Nothing wrote them; a clock
struck. The full account is **docs/HOLDS.md §12** and migration **0048**; the
three things a reader of this file needs are:

1. **`releaseAvailableCredits()` is not missing — its schedule is unusable.**
   Every uncleared credit on the ACH rail matures at 09:00 ET (13:00Z in summer).
   `/api/drain` runs 04:17Z and `/api/cron/holds` 08:11Z; **both fire before the
   maturity, every day**, so a same-day release is impossible from either and the
   memo book is behind for ~19 hours by construction. `hold_closure.source =
   'availability_sweep'` had **zero rows** on this database when that was
   measured: the sweep had never once had a due hold at a moment it ran.
2. **The release's value date must come from the policy, not from the cron.**
   `releaseAvailableCredits()` books at `bookDateOf(now)`, so a batch swept the
   morning after maturity is value-dated the *following* banking day and the
   statement for the release day shows money withheld that the policy had freed.
   `sweepMaturedUnclearedCredits()` (`src/lib/holds/availability.ts`, scheduled
   third in `/api/cron/holds`) books at `book_date(hold.available_at)` — derived
   from immutable data, identical on every run for ever. Proved in a rolled-back
   transaction: a hold matured `2026-09-09T13:00Z` and swept on 2026-09-11 books
   value date **2026-09-09**.
3. **Pre-posting the release at funding time was considered and is wrong.** A
   value date is a day; `available_at` is an instant. Neither memo-balance
   predicate in this system has a value-date filter today, so a pre-posted
   release would flatten the hold immediately and **leg 2 of the core loop would
   fail on the spot** — ledger up, available up with it. Adding the filter makes
   it land at 00:00 ET instead of 09:00 ET, nine hours early, which is §4.2's
   one-hour mistake multiplied by nine. Money is not released early to keep a
   view green.

The 13 were repaired append-only at their own release value date by
`scripts/repair-0048-uncleared-release.mjs` — $17,504.00 back to the memo book,
`booking_seq` 5459–5471 — and **not one customer-facing figure moved**, which is
this section's claim restated as a measurement. The 42 uncleared credits maturing
`2026-09-14T13:00Z` and `2026-09-15T13:00Z` are handled by the sweep arriving.

Exactly-once comes from `hold_closure PRIMARY KEY (hold_id)` plus a release
idempotency key derived from the hold id and its immutable `available_at` — not
from a lock, because `corgi_app` holds no `UPDATE` on `hold` and `FOR UPDATE` is
not expressible. Both sweeps build **the same key**, so the drain and the holds
cron are two triggers for one append rather than two mechanisms.

---

## 5. The non-happy paths, driven for real

Both are real, both were driven against Plaid's sandbox, and neither is drawn on
the screen until somebody presses the button. Panel: **"When the bank connection
breaks"** on `/funding`.

### 5.1 Fails at LINK time — no Item is ever created

`override_password: "error_ITEM_LOCKED"` makes the create call itself fail.

```
POST /sandbox/public_token/create -> 400   request_id 5137ca2eef7e218
  error_type      ITEM_ERROR
  error_code      ITEM_LOCKED
  error_message   the account is locked. prompt the user to visit the
                  institution's site and unlock their account
  display_message The given account has been locked by the financial
                  institution. Please visit your financial institution's
                  website to unlock your account.
```

**No Item exists.** There is no access token, nothing to persist, nothing to
retry and nothing to reconnect — the unlock happens on the bank's own site.

### 5.2 Breaks AFTER linking — the Item exists and is dead

`POST /sandbox/item/reset_login` on a throwaway Item, then the asymmetry the
whole error design hangs on:

```
POST /sandbox/public_token/create -> 200
POST /item/public_token/exchange  -> 200   item xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7
POST /sandbox/item/reset_login    -> 200   {"reset_login": true}   request_id 04a25371f3c703c
POST /auth/get                    -> 400   ITEM_LOGIN_REQUIRED     request_id a1c6d80c3ce0a55
POST /item/get                    -> 200   request_id efb032c779683e9
    item.error.error_code       ITEM_LOGIN_REQUIRED
    status.last_webhook         {"code_sent":"ERROR","sent_at":"2026-09-10T22:15:13.382Z"}
```

**The diagnosis is the call that succeeds.** `/auth/get` can only tell you that
something failed. `/item/get` tells you *what* broke, and — via
`status.last_webhook` — that Plaid had already told us, at a timestamp. So
`/funding` renders the error state out of a successful response rather than out
of a caught exception, and shows the failed product call beside it.

`display_message` is **null** on `ITEM_LOGIN_REQUIRED`. A UI that renders only
that field shows a blank box on the single most common error a funding screen
has to explain, which is why `PLAID_ITEM_ERROR_COPY` exists.

There is no un-reset. Recovery is Link in update mode, which needs a browser, so
an Item broken here stays broken — which is exactly why it is never the Item
anything was funded from.

### 5.3 …and the webhook really arrived

Plaid fired the `ITEM`/`ERROR` webhook at
`https://corgi-trial-psi.vercel.app/api/webhooks/plaid`, it passed the existing
ES256 JWT verification in `src/lib/webhooks/route-handler.ts`, and it is in
`webhook_inbox`:

```
id                    a64a42bc-b040-4ba0-8d5e-0fb4476f39e9
provider              plaid
event_type            ITEM.ERROR
received_at           2026-09-10T22:47:23.312Z
signature_verified_at 2026-09-10T22:47:23.341Z
provider_event_id     sha256:…            (Plaid ships no event id; the body hash is the dedupe key)
payload.item_id       7k9de5pw8RuB7KEwvDWKfvNrwgwr3xiNwBodw
payload.error.error_code  ITEM_LOGIN_REQUIRED
```

Two earlier ones from the same probe are also in the inbox
(`bb7cd38b…` / item `xPJdr6LN…`, `d4b51b7f…` / item `8MppL6n1…`).

**No verification code was written for this leg.** The verifier already existed
and is registered in `route-handler.ts`; a second copy is how the fifth provider
gets verified differently from the first four.

---

## 6. What is NOT here, stated rather than discovered

### 6.1 The `access_token` is not persisted, because there is nowhere to put it

This schema has **no `plaid_item` table**, and adding one needs a migration this
worker does not own. So the token is used for the two reads inside one server
action and dropped on the floor. Consequences, all real:

- An Item **cannot be re-read on a later request**. `/funding` links a fresh
  Item on every run.
- The durable record of the linkage is the `external_ref` on the money rows —
  `plaid:<item_id>:<account_id>:<reference>` — on both journal entries and on the
  hold. That is genuinely immutable and genuinely queryable, and it means **an
  Item that has never funded anything is not stored at all.**
- The screen's holds table reads the item and account back out of that ref.

### 6.2 Idempotency is replay-safe within one Item, and not across two

Three unique indexes decide, with no `if` statement anywhere:

```
hold_ref UNIQUE (kind, external_ref)     the hold
journal_entry.idempotency_key UNIQUE     the financial entry
journal_entry.idempotency_key UNIQUE     the memo entry
```

Every key is derived from the source fact — the Plaid item id, the Plaid account
id and the caller's reference — never from a uuid generated on the request. The
integration suite proves it: the same request twice returns the same `holdId`,
the same `entryId` and the same `memoEntryId`, and the balance does not move on
the second call.

**But the item id is part of the key, and this path links a fresh Item every
run.** Two presses therefore carry two different item ids, two different external
refs and two different keys — so the indexes cannot see across them. That is the
double-click that books twice, and it is guarded rather than hoped about:
`alreadyFundedReference()` is a SELECT the server action runs *before* linking,
and a reference this business has already funded under is refused
`ALREADY_FUNDED` with the existing hold id, having sent nothing to Plaid.

It is a **guard, not a guarantee**. Two requests racing between that SELECT and
the INSERT both pass it. The guarantee is still the index and the index's reach
is still one Item. Closing the gap properly needs a `plaid_item` table.

*(Verified: pressing "fund" a second time with reference
`DEMO-FUNDING-2026-09-10` returned `ALREADY_FUNDED` in 312 ms with zero Plaid
calls, and the hold count did not change.)*

### 6.3 Two balance readers in this codebase disagree, and it is not rounding

Found while building this screen, and worth someone's attention:

- `ledgerBalanceCents(accountId, snapshot)` in `ledger/queries.ts` filters
  `value_date <= snapshot.valueDate AND booking_seq <= snapshot.watermark` —
  "what does the ledger say about **today**, using everything we know now".
- `availableBalance(businessId)` in `ledger/balances.ts` sums **every** line on
  the deposit account with **no value-date predicate at all**, so it includes
  future-dated postings.

On Ridgeline those two answers differ by **$30,662.10**, because the book carries
$37,212.00 of debits value-dated `2026-09-11` and a run of standing-order credits
dated 2027. Whichever is right for the account screen, `/funding` must not print
both — a headline and a receipt on one page disagreeing by five figures about the
same account at the same instant is a screen that has taught the reader its
numbers cannot be trusted. So this screen has **one** definition of its four
figures, `readBalanceCents()` in `app/(app)/funding/live-source.ts`, used by both
the headline and the receipt. `balances.ts` is not this worker's module to
change; the disagreement is recorded here rather than papered over.

### 6.4 Other limits

- **No `POST /ach_transfers`.** The pull is booked at origination and never
  transmitted. §1.
- **No Link UI.** §2.2.
- **No `/transactions` or balance refresh.** Plaid's own balance figure is shown
  verbatim as a string and never converted to money: `23631.9805` is a real
  sandbox value, it is not a cent count, and multiplying it by 100 is the float
  bug the whole ledger exists to avoid.
- **No return handling on this path.** An ACH return reverses 1130 and closes the
  hold; the semantics are in `rail_event_semantics` (a return is a `new_event`,
  not a correction) and the machinery is the ACH rail's, not this screen's.

---

## 7. Money discipline

- Every amount is `bigint` cents, end to end. No floats, no `parseFloat`, no
  `/ 100`, no `* 100`.
- The typed amount becomes money in exactly one place — `parseUsdToCents()` in
  `app/(app)/funding/actions.ts` — by integer string arithmetic. Anything with a
  sign, an exponent, three decimal places or a stray character is **refused**,
  not rounded.
- **The data contract carries no cent counts at all.** Every figure crossing to a
  component is a string already formatted by `src/lib/format/money.ts`, so the
  client cannot compare, divide or round money. The one place ordering needs the
  cents — picking the largest hold for the edge state's prose — happens on the
  server, in `live-source.ts`, where the `bigint`s still exist.
- Nothing writes to `journal_entry` or `journal_line` directly. `postEntry()` is
  the only write path, and `corgi_app` holds no `UPDATE` or `DELETE` on either.

---

## 8. The five states

`/funding?state=loading|empty|error|edge`, plus the bare route — and
`?business=<uuid>` orthogonally, on any of them.

| State | Live? | What it is |
| ----- | ----- | ---------- |
| *(none)* | **live** | Real balances, real holds, real policy table, the live form. |
| `loading` | fixture | The real Suspense skeleton, held open six seconds by a genuinely slow read. |
| `empty` | fixture | No deposit account on the book for a credit to land in. |
| `error` | fixture | The preflight read failed. Nothing funded; the form is not drawn. |
| `edge` | **live** | **Funded but not yet available**: ledger up, available unchanged, and the uncleared hold itemised with its release date. |

`edge` is live on purpose. "Funded but not yet available" is a real position in
the database — an `uncleared_credit` hold with a future `available_at` — and a
fixture of it would demonstrate the arithmetic while proving nothing about it. If
no such hold exists when you open it, it says so rather than drawing one.

`?business=` is a sixth dimension rather than a sixth state: it selects the
customer and every state honours it. `/funding?state=edge&business=<uuid>` is a
URL that reproduces one customer's uncleared position exactly, and the state bar
carries the selection across every link so switching states does not silently
move the reader to somebody else's balances.

## 9. Reproducing it

```bash
set -a; . ./.env; set +a

# the unit suites: no network, no database
pnpm vitest run src/lib/rails/plaid/

# the live one: links real Items and posts real money to Neon
RUN_DB_TESTS=1 pnpm vitest run src/lib/rails/plaid/funding.integration.test.ts

node scripts/dbcheck.mjs        # 14/14
```

The integration suite is gated on `RUN_DB_TESTS=1` **and** on both Plaid
credentials being present, so CI — which holds neither, deliberately — skips
rather than fails.
