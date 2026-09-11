# BALANCE DEFINITIONS — 2026-09-11T02:31Z

> Everything below is a MEASUREMENT taken at the timestamp in this heading,
> against the live Neon database, with `node scripts/dbcheck.mjs` green at
> 20/20. The book is being written to continuously by other work on this
> build, so the figures move; the *differences* are what this file is for and
> they were reproducible across every run.

## The defect, in one line

There were **four** live definitions of "available balance" and **two of them
printed at the same instant, on two screens, for the same account, and
disagreed by $22,605.00.**

That is the failure mode "derived, never stored" exists to prevent, arrived at
by a different road. A balance derived four ways is a stored lie with extra
steps: the number the customer sees still depends on which code path reached
them.

---

## 1. What each one actually computed, measured

Where the function lived, what predicate it applied, and therefore what
question it was really asking.

| # | Function | Ledger term | Hold release predicate | Hold kinds counted | Future-dated |
|---|----------|-------------|------------------------|--------------------|--------------|
| 1 | `availableBalance()` — `src/lib/ledger/balances.ts` | **every line**, no predicate at all | `hold_closure` row only (less its 0011 reversal) | `card_auth`, `uncleared_credit` — **`manual` silently dropped** | credits **and** debits included |
| 2 | `ledgerBalanceCents()` — `src/lib/ledger/queries.ts` | `value_date <= snapshot` **and** `booking_seq <= watermark` | n/a (ledger only) | n/a | both excluded |
| 3 | `readBalanceCents()` — `src/app/(app)/funding/live-source.ts` | #2 | `listHoldRows`: closure **or** the card model **or** the clock | `card_auth`, `manual`, `uncleared_credit` | credits excluded from the ledger term, **but their holds still deducted** |
| 4 | `v_available_balance` — migration 0001 | `v_ledger_balance`: every line, no predicate | `v_hold_state.is_released`: closure **or** card model **or** clock | all three, undifferentiated | included |
| — | `ledgerBalanceAsOf()` | `value_date <=`, watermark open | n/a | n/a | excluded |
| — | `balanceAsBelieved()` | both axes, watermark passed in | n/a | n/a | excluded |
| — | `memoHoldBalance()` — `src/lib/holds/store.ts` | one hold's memo account | n/a | n/a | n/a |
| — | `trialBalanceCents()` | whole financial book | n/a | n/a | n/a |

Read across the rows: **no two of #1–#4 shared a ledger term, a release
predicate and a set of hold kinds.** Each was individually defensible and no
two answered the same question.

`memoHoldBalance` and `trialBalanceCents` were never rivals — one is a single
hold's memo balance and the other is the whole book — and they are untouched.

---

## 2. The measured disagreement, before

Three customer deposit accounts, one instant, four definitions.

### Ridgeline Robotics, Inc. — `a0c41a37-…f048fac`

| definition | ledger | holds | uncleared | committed out | **available** |
|---|---|---|---|---|---|
| `availableBalance()` (accounts console) | $27,189.32 | $411.00 | $18,753.00 | n/a | **$8,025.32** |
| `readBalanceCents()` (funding screen) | $49,794.32 | $411.00 | $18,753.00 | n/a | **$30,630.32** |
| `ledgerBalanceAsOf(today)` | $49,794.32 | — | — | — | — |

**Two screens, same account, same instant: $22,605.00 apart.** ($30,662.10 when
the funding screen first wrote its own copy; $25,040.70 at 02:10Z. The number
moves because the book moves; the disagreement never went away.)

The gap is entirely future-dated postings on the deposit account:

* **−$37,462.00** of outbound ACH debits value-dated **tomorrow**
* **+$5,000.00** of inbound funding value-dated **tomorrow**
* **+$9,857.00** of standing-order settlement credits value-dated **2027**

`availableBalance()` counted all of it. `readBalanceCents()` counted none of
it. Neither was right.

### Kettle & Crumb Bakery LLC — `392043e2-…75108b`

| definition | ledger | holds | uncleared | **available** |
|---|---|---|---|---|
| `availableBalance()` | $16,779.80 | $0.00 | $17,000.00 | **−$220.20** |
| `readBalanceCents()` | −$220.20 | $0.00 | $17,000.00 | **−$17,220.20** |

**$17,000.00 apart, on an account holding $16,779.80.** This is the *other*
bug, and it is worse than the first because both screens are wrong in the same
direction as far as the customer is concerned:

$17,000.00 of inbound credits are value-dated **tomorrow**, and so are the
uncleared-credit holds guarding them. `readBalanceCents()` excluded the
credits from its ledger term (`value_date <= today`) **and then subtracted the
holds anyway** — charging the customer for the same dollar twice, once by
leaving it out and once by deducting it. On Ridgeline the same bug was worth
$5,000.00.

### Pots Integration Fixture Co.

All four definitions agreed at $24,996.61. An account with no holds and no
future-dated postings cannot tell these definitions apart — which is exactly
why the disagreement survived as long as it did.

---

## 3. The decision: does "available" include an entry dated tomorrow?

**The answer is different for a credit and for a debit, and the asymmetry is
the point.**

### A future-dated CREDIT is not available.

A customer cannot spend tomorrow's settlement today. There is no reading of
"available" under which $9,857.00 of standing-order credits value-dated **2027**
are spendable in 2026, and `availableBalance()` was handing the demo business
exactly that.

### A future-dated DEBIT is subtracted anyway.

Money already booked to leave the account has been committed. An outbound ACH
originated today for tomorrow's settlement is gone as far as spending power is
concerned. A customer who can spend it *again* in the window before it settles
is a customer we have overdrawn on their own behalf — and $37,462.00 of these
are sitting on the demo account right now.

### These are not opposite rules.

They are the same rule applied where prudence points opposite ways:

> **Available is the money you could spend right now without relying on
> something that has not happened yet.**

Symmetry here would be the mistake. A definition symmetric in *value date* is
asymmetric in *risk*, and the risk is whose money it is.

### Why this is not a hold

The pending-outbound term is a **derived hold**. It needs no `hold` row because
the journal entry is already there, and it cannot double-count against a memo
hold because the two live in different books. The alternative design — have the
outbound rail place a `manual` hold at origination — is strictly worse here:
it puts the same fact in two places and needs a release path, which is the
class of bug migration 0011 exists to record.

### And a hold only withholds from its own value date

A hold value-dated tomorrow guards a credit that is not in the ledger term
either. `hold.value_date > snapshot.valueDate` is therefore "pending": listed
on the screen, folded into nothing. This is the $17,000.00 above.

### And manual holds count

`availableBalance()` bucketed `card_auth` and `uncleared_credit` and dropped
`manual` on the floor — an operator hold that freed the money it was placed to
withhold. $0.00 in this database today, which is precisely why it survived
unnoticed.

---

## 4. The three questions, and where they live now

`src/lib/ledger/balance-definitions.ts`. Every other balance function in the
system is a call into it.

| Question | Function | Meaning |
|---|---|---|
| **Q1** | `settledBalanceCents(account, snapshot)` | the settled ledger balance at a value date **and** a booking watermark — the bitemporal claim |
| **Q2** | `accountAvailability(account, snapshot)` | `ledger − holds − uncleared − committed outflows` |
| **Q3** | `believedBalanceCents(account, valueDate, watermark)` | what we believed about a business day at a point in transaction time |

Q3 is mechanically Q1 with a past watermark and is deliberately not collapsed
into it: a caller reaching for "what did we believe" should not have to know
that.

### What became an alias

| Name | Kept because | Now |
|---|---|---|
| `ledgerBalanceAsOf()` | called by `src/lib/mcp/**` (not this worker's to edit) | Q1, watermark read rather than assumed infinite |
| `balanceAsBelieved()` | called by `src/lib/mcp/**` | Q3 |
| `bookingWatermarkAt()` | called by `src/lib/mcp/**` | unchanged — the historical watermark Q3 takes |
| `availableBalance()` | called by `pots`, `standing`, `cards`, `rails`, `mcp`, two screens and six test suites | Q2, business-scoped |
| `ledgerBalanceCents()` | called by the account and funding screens | Q1 |
| `readSnapshot()` | called by three screens | moved into the canonical module |
| `readBalanceCents()` | the funding screen's own receipt path | Q2, account-scoped |
| `trialBalanceCents()` | the whole-book invariant | unchanged |
| `memoHoldBalance()` | one hold's memo balance — never a rival | unchanged |

No exported name or signature was removed. That was deliberate: five other
workers are live in `src/lib/{integrations,disputes,accrual,onboarding,kyb,cards,mcp}`
and `src/lib/rails`, and a rename would have meant editing files that are not
this worker's to edit. **The behaviour changed; the call sites did not have to.**

---

## 5. The view and the function cannot drift

A view cannot take an argument and a balance question has three — which
business day, which booking watermark, which instant. So the canonical
definition is a **Postgres function**, and everything else calls it:

```
        ledger_availability(account, value_date, booking_seq, as_of)
                     |                    |
                     |                    +--> v_available_balance   (the live point)
                     +--> accountAvailability() / availableBalance()  (TypeScript)
```

**There is one body.** The SQL view and the TypeScript function cannot drift
because neither of them *contains* a definition — they contain a call. That is
the `v_hold_drift` bargain kept by construction rather than by invariant, which
is strictly stronger.

`v_hold_drift` is still the right shape for the seam that is genuinely two
bodies, so there is one of those too: **`v_balance_definition_drift`** holds
`ledger_availability()`'s hold terms equal to `v_hold_state`'s own answer at the
live point. They are separate bodies — `v_hold_state` evaluates its release
predicate at `now()`, the function evaluates it at a parameter — so an edit to
either that changes what "released" means makes the view non-empty. It must
return zero rows; nothing repairs what it reports.

Asserted by `src/lib/ledger/ledger.integration.test.ts` (`RUN_DB_TESTS=1`):
the view and the function are read for every deposit account and compared term
by term, and the drift view is asserted empty. Measured: **0 rows.**

### One thing that had to change to make this safe

`readSnapshot()` now takes its point from `clock_timestamp()`, not `now()`, and
the live watermark has no time predicate at all.

`now()` inside a transaction is the transaction's **start**, and
`ledger_append()` stamps `booking_time` from `clock_timestamp()`. A watermark of
`MAX(booking_seq) WHERE booking_time <= now()`, read inside the transaction that
just posted an entry, **excludes that entry** — and standing orders and pot
transfers both funds-check inside the transaction that posts. MVCC already
decides what a transaction can see; `MAX` over that is exactly "everything we
have learned". The time predicate belongs on the *historical* watermark
(`bookingWatermarkAt`), where it is the entire point.

---

## 6. Every figure that moved

Measured at the heading timestamp. `availableBalance()` is what the accounts
console printed; `readBalanceCents()` is what the funding screen printed.

| Account | was (console) | was (funding) | **now** | moved by | why it was wrong |
|---|---|---|---|---|---|
| Ridgeline Robotics | $8,025.32 | $30,630.32 | **−$1,831.68** | −$9,857.00 vs console, −$32,462.00 vs funding | console handed the customer $9,857.00 of 2027 credits as spendable today; funding let them spend $37,462.00 that is already booked to leave tomorrow, while double-charging them $5,000.00 of holds against credits it had already excluded |
| Kettle & Crumb Bakery | −$220.20 | −$17,220.20 | **−$220.20** | $0.00 vs console, +$17,000.00 vs funding | funding deducted $17,000.00 of uncleared holds whose credits its own ledger term had already excluded — the same dollar twice |
| Pots Integration Fixture | $24,996.61 | $24,996.61 | **$24,996.61** | $0.00 | nothing to disagree about |
| Holds Integration Fixture | agreed | agreed | unchanged | $0.00 | no future-dated postings |

Ridgeline is now **negative**, and that is the honest answer: $49,794.32 settled,
$411.00 authorised on cards, $13,753.00 inside its funds-availability window and
$37,462.00 already committed out. It is not clamped, for the reason it has never
been clamped — an over-capture settles above what was authorised and hiding an
overdraft behind a cosmetic floor loses money.

### Changes with no figure attached, today

| Change | Exposure today | Why it was wrong |
|---|---|---|
| `manual` holds now count towards `available` | $0.00 | `availableBalance()` dropped them entirely — an operator hold that freed the money it was placed to withhold |
| release predicate is now the model's, not closure-only | $0.00 | `availableBalance()` kept withholding an expired authorisation until a sweep wrote a `hold_closure` row; `v_hold_state` and `listHoldRows` released it on the clock. A missed sweep stranded the customer's money |
| `v_available_balance.ledger_balance_cents` is now the settled balance | see table above | it was `v_ledger_balance` — every line, both axes open |
| `v_available_balance.active_holds_cents` now excludes future-dated holds and no longer mixes in uncleared credits | see table above | uncleared credits now have their own column, and so do committed outflows |

---

## 7. The boundary

`src/lib/ledger/boundary.test.ts` fails if any module outside
`src/lib/ledger/**` writes SQL against `journal_entry`, `journal_line` or
`account`.

Measured now: **235 references across 50 files.** Every one is allowlisted
**with its owning module named**, and the test is a ratchet:

* a file not on the list may have **no** references
* a file on the list may have **fewer** than its recorded count
* a file on the list may not have **more**
* a file on the list that is now clean must be **removed** from it

So the list can only shrink, and the number in it is a bill rather than a
licence. By module, heaviest first:

| module | refs | what it is really asking for |
|---|---|---|
| live-fire suite | 33 | assertions about postings; these are attack scripts and are expected to read raw |
| `pots` | 29 | a subtree balance, and the movements behind one pot |
| `statements` | 23 | a closed day's postings, reproducibly |
| `holds` | 19 | one hold's memo balance and its entries |
| `rails` | 16 | the entry behind a provider reference |
| `accrual` | 15 | a day's interest base |
| `home` | 15 | the console summary |
| `recon` | 15 | the entries behind a recon group |
| `disputes` | 12 | the charge behind a dispute |
| `mcp` | 11 | read tools over balances and entries |
| `onboarding` | 11 | the chart of accounts for a new business |
| accounts console | 10 | balances and holds, mostly already available by name |
| `approvals` | 9 | the instruction behind an approval |
| `payees` | 6 | the account a payee points at |
| `fx` | 4 | the entry behind a quote |
| `kyb`, `standing`, `webhooks`, `cards` | 2, 2, 2, 1 | one-off reads |

**What would pay it down** — not "wrap every query". Four or five *named*
readers in `src/lib/ledger/` would retire most of the list: a day's postings,
a subtree balance, the entries behind an external reference, the chart for a
business. That is week-two work. What the test buys today is that the list
cannot get longer while nobody is looking.

---

## 8. What was not touched

* `src/lib/{integrations,disputes,accrual,onboarding,kyb,cards,mcp}/**` and
  `src/lib/rails/**` — other workers are live in them. Every balance function
  they call kept its name and its signature, so none of them needed an edit.
* `scripts/coreloop.mjs` re-expresses the availability query on purpose, so
  that its verdict does not run through application code. It is a yardstick,
  not a second opinion, and it is a script rather than a module — the boundary
  test does not scan it. **It has not been updated to the new definition**, so
  its `available` column still reads `ledger(every line) − card holds −
  uncleared`. Its assertions are all *deltas*, which is why it still holds.
* `listPostingRows()` still excludes future-dated entries from the activity
  table. The committed outflows that now reduce `available` are therefore not
  yet listed among the postings that explain it. The screens name the figure;
  they do not yet itemise it. That is the first thing to fix next.
