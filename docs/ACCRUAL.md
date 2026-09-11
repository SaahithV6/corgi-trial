# Daily accrual, and who eats the residual penny

Stretch ladder item 3: *"Interest or fee accrual computed at end of day,
visibly, on the ledger."*

And, more to the point, non-negotiable 9:

> Money is never a float. Integer minor units or exact decimals. State your
> currency handling and your rounding rule. **Pro-rata maths always leaves a
> penny, and someone has to eat it deterministically.**

This document is the written half. The enforced half is
`db/migrations/0020_accrual.sql`, and there is more of it there than there is
here — the rule is a `CHECK` constraint, not a paragraph.

- Code: `src/lib/accrual/**`
- Screen: `/accruals` (`src/app/(app)/accruals`, `src/components/accrual/**`)
- Job: `/api/cron/accrual`
- Tests: `src/lib/accrual/types.test.ts` (pure, ~40k assertions),
  `src/lib/accrual/accrual.integration.test.ts` (live database, real money)

---

## 1. What is accrued, and why it is this

**A monthly platform fee, accrued daily, pro-rata across the days of the
calendar month it belongs to.** Debit the customer's deposit account, credit
`4200 Fee income`.

Three candidates were on the table. Only one could be posted without inventing
an account, and it is also the one where the residual penny bites hardest.

| Candidate | Account it needs | Status |
| --- | --- | --- |
| Monthly platform fee, accrued daily | `4200 Fee income` — **exists** | **BUILT** |
| Overdraft interest on negative balances | `4400` — **added by 0024** | **BUILT**, §11 — *no rows: nothing is overdrawn, §12* |
| Interest paid on credit balances | `5400` — **added by 0024** | **BUILT**, §11 — live on five accounts |

`4200`'s own description in `src/lib/ledger/chart.ts` names the product:

> *"Fees we charge the customer — wire, expedited ACH, **monthly platform** —
> credited here at the same instant the customer's deposit account is debited
> for them."*

So nothing was invented and nothing was stretched.

**Why overdraft interest was not silently posted to 4200.** It would have been
one line of code. It is wrong for the reason `4300`'s own note already gives
about a different account: *"It is not fee income — 4200 is what we charge, and
netting variance into it would make a spread look like a price."* A fee is a
charge for a service; interest is priced on a balance and a number of days.
Reg DD discloses the two differently, an APR hidden inside a fee line is a
compliance problem as well as an accounting one, and a second meaning quietly
loaded onto an existing account is exactly the kind of drift this ledger is
built to refuse. §7 names the account to add instead.

**A note on the premise.** The brief for this work said the book *has*
overdrawn accounts. It does not, today: `v_overdrawn_accounts` returns zero
rows and every deposit leaf is in credit. Overdraft interest would therefore
have shipped as a feature with no rows, which is not evidence of anything.

---

## 2. The rounding rule, which is the one already written down

`research/ledger/DESIGN.md` §12 — the rule the T+2h attack plan committed to on
the thread ("banker's rounding with the residual penny assigned
deterministically to the earliest line") — has two clauses, and **the whole
skill in daily accrual is knowing which one applies.**

| | Rule | When |
| --- | --- | --- |
| §12.2 | round **half to even** | one value → one cent amount |
| §12.3 | **largest remainder** — floor each share, distribute the shortfall one penny at a time | one amount → N shares |
| §12.4 | ties, and therefore the residual penny, break by **ordinal ascending** | always |
| §12.5 | the template is arranged so the **house** absorbs | when there is a house line in the split |

**A monthly fee accrued daily is §12.3, not §12.2.** That is the load-bearing
sentence in this document.

Half-even applied per day to a $25.00 plan over 30 days gives `round(83.33) =
83¢` every day, thirty times, and bills **$24.90** for a $25.00 product. Every
individual day is "correctly rounded" and the month is wrong by a dime —
$1.20 a year per customer, and a support ticket the first time somebody adds
up their statement. Rounding the days is the bug. **Allocating the month is the
fix.**

### The arithmetic

Because every day's share of `F/N` has the *same* fractional remainder,
§12.3's largest-remainder comparison is an N-way tie and §12.4's tiebreak
decides the entire allocation on its own. The ordinal is the day of the month.

```
F = the monthly price, in integer cents      (the basis)
N = days in the calendar month               (28 | 29 | 30 | 31)
d = day of the month, 1..N                   (the §12.4 ordinal)

q        = F div N                    the base share, floor division
r        = F mod N                    the residual pennies, 0 <= r < N
share(d) = q + (1 if d <= r else 0)
cum(d)   = q*d + min(d, r)
cum(N)   = q*N + r = F                exactly, by construction, always
```

Worked, for the plan on the live book:

```
$25.00 a month, September, 30 days

  2500 div 30 = 83        every day gets 83c
  2500 mod 30 = 10        ten pennies will not divide

  days  1..10   84c       <- each carries one of the ten
  days 11..30   83c

  10 x 84 + 20 x 83 = 840 + 1660 = 2500       not 2499, not 2501
```

`v_accrual_month_drift` asks exactly that question of every closed month and
**must return zero rows**.

---

## 3. Where the residual penny landed, with a real example

On the live book, on 2026-09-10, three plans accrued side by side. Same rule,
three different answers, and the difference is the whole point:

| Plan | F | q = F div 30 | r = F mod 30 | day 10 | day 11 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Business Standard | 2500¢ | 83¢ | 10 | **84¢** ← carries a penny | 83¢ |
| Business Plus | 4999¢ | 166¢ | 19 | **167¢** ← carries a penny | **167¢** |
| Starter | 999¢ | 33¢ | 9 | 33¢ ← past the first 9 | 33¢ |

Day 10 is the last day the Standard plan carries a penny and day 11 is the
first it does not. That one-cent step is real, dated, and on the ledger — it is
the `?state=edge` state of `/accruals`, and the live rows behind it are in §8.

---

## 4. Who eats it — the policy, stated with its edges

**Over a complete month, nobody eats anything.** The postings sum to exactly
the price. That is what largest-remainder buys and it is not an approximation:
`v_accrual_month_drift` is empty or the feature is broken.

**Within the month, the residual is a timing assignment**, and it lands on the
earliest days because §12.4 says lowest ordinal first and the ordinal is the
day. The consequence has to be stated rather than left to be discovered:

> **Partial-month policy.** Accrual starts on the schedule's `start_date` and
> stops on its `end_date`; there is no true-up. Because the residual pennies
> are front-loaded, an account **closed mid-month** has paid up to `F mod N`
> cents — at most 30¢ on a $25.00 plan, at most 30¢ on any plan, since
> `r < N <= 31` — *more* than exact straight-line pro-rata, and an account
> **opened mid-month** pays up to the same amount *less*. The bound is one
> cent per day of the month, it is symmetric between the two cases, and it is
> disclosed here.

**Why not defer the pennies to the end of the month instead**, so a partial
month always rounds in the customer's favour? Because that would be a *second*
rounding convention in this ledger. §12.4 is already implemented by the
interchange allocation and the USDC dust path, both of which take the lowest
ordinal. Two rules that agree in the common case and diverge at the edges is a
reconciliation break waiting to happen — the brief's own words — and the
30¢ bound is smaller than the cost of having to explain which allocation uses
which rule. If the business decides partial months must always favour the
customer, the right fix is to change §12.4 **everywhere at once**, in DESIGN.md
first, not to special-case accrual.

### The sub-cent case, which is the other end of the same rule

A plan priced below one cent a day — 20¢ a month over 31 days — has `q = 0` and
`r = 20`. Days 1–20 accrue a penny each; days 21–31 accrue **nothing**.
`postEntry()` refuses a zero-amount line ("always an allocation bug") and it is
right to, so those eleven days are recorded as `disposition = 'skipped'` with a
sentence saying why, rather than as a missing row or an entry that says
nothing. The month still sums to exactly 20¢.

This is live on the book as a two-day probe schedule; see §8.

---

## 5. Exactly-once, and what actually guarantees it

The shape is `src/lib/standing/`'s, deliberately, because the requirement is
the same one.

**The unit is the (schedule, date) pair.** "Accrues once" is meaningless said of
a schedule, which is supposed to accrue every day.

1. **At most once — the claim.** `accrual_day` is `UNIQUE (schedule_id,
   accrual_date)`. Each day is processed in one transaction that opens by
   taking `lock_accrual_schedule()` — `SELECT … FOR UPDATE` through a
   `SECURITY DEFINER` function, because `corgi_app` holds no `UPDATE` on that
   table and cannot write `FOR UPDATE` itself. Two concurrent ticks serialise
   there.

2. **At least once — and the effect is idempotent.** The idempotency key is

   ```
   accrual:<schedule id>:<YYYY-MM-DD>
   ```

   a `GENERATED ALWAYS … STORED` column derived by Postgres **from the two
   source facts that identify the day, never from a uuid the job made up**.
   The date is assembled from `EXTRACT`ed integers rather than `to_char()`,
   because every textual rendering of a date is only `STABLE` (`DateStyle` is a
   session GUC) and a generated column must be `IMMUTABLE`. A key that depends
   on a session setting is a key that silently becomes a different key, which
   is the exact shape of a double debit.

   That string goes to `postEntry()`, where `journal_entry.idempotency_key` is
   `UNIQUE`. A second tick re-derives the same string and `ledger_append()`
   returns the **original** entry id having written nothing.

3. **The lock is not the safety device.** It is a liveness device — a crashed
   process releases it. The unique indexes are what a crashed process cannot
   release, and they are what the guarantee rests on.

**One transaction per day.** Unlike `standing/fire.ts`, which must call
`requestPayment()` on the pooled handle because that function opens its own
transaction, `postEntry()` takes a connection — so the claim, the journal entry
and the outcome row commit together or not at all. A crash cannot leave an
entry without an audit row or an audit row without an entry.

---

## 6. Decisions worth defending

**Value date is the accrual date, not the run date.** A tick that runs on
Friday and catches up Tuesday, Wednesday and Thursday posts three entries with
*those* value dates and Friday's `booking_seq`. Tuesday's statement shows
Tuesday's fee. `assert_accrual_posting()` refuses any entry whose `value_date`
is not the claim's `accrual_date`, so this cannot be got wrong by accident. A
backdated accrual landing inside a closed book day shows up in
`v_late_postings` and produces a statement v2 — designed behaviour, not a
surprise.

**An accrual is not funds-checked.** The fee accrued because the month passed,
not because the balance allowed it. Refusing to accrue on a thin balance would
make that day's statement wrong and stop the month summing to the price. So a
fee **can** push a deposit account into a debit balance — which is precisely
the condition `v_overdrawn_accounts` exists to surface, and precisely what an
overdraft-interest product would then price. A decision, not an omission.

**TypeScript computes, Postgres verifies.** `allocateDay()` and
`accrual_daily_share()` are not two definitions held equal by hope.
`accrual_posting_arithmetic` is a `CHECK` constraint that re-derives all seven
relations from the three inputs, so a row whose arithmetic disagrees with the
rule **cannot be stored** and the transaction that tried rolls back, taking the
journal entry with it. DECISIONS 024's lesson was that two definitions cannot
be fixed one at a time; this is a computation plus a proof.

**The arithmetic is stored, not re-derived at read time.** Same reasoning as
`standing_order_outcome.observed_*`: these are the figures the decision was
made against. But they are not trusted — see above.

**No float, including intermediates.** Every operand is `bigint` cents or a
small integer count of days. There is no `/` on a `number`, no `Math.round`, no
`toFixed`. `bigint` division truncates toward zero and every operand is
positive, so `F / N` *is* the floor — the same answer Postgres gives, which is
what lets the database check the work. The pure test asserts the month sums
exactly for every price from 1¢ to $50.00 across all four month lengths, and
for a price larger than `Number.MAX_SAFE_INTEGER`.

**The residual within the entry.** The two-line fee entry puts the house line
(`4200`) at **ordinal 0**, which is §12.5's template. This particular entry has
no residual to assign — two equal and opposite lines — so the ordering changes
nothing here. It is written that way anyway, because the rule is one rule and
not "the rule, except where it does not currently matter". The residual penny
in daily accrual is placed **across days**, not across lines.

---

## 7. The accounts that were missing, named exactly — and since added

> **Superseded by §11.** Migration 0024 adds both of these rows to
> `src/lib/ledger/chart.ts` and to the live chart, verbatim as named below,
> and builds the product. The section is kept unedited because the *argument*
> for why they had to be new accounts is the argument 0024 rests on, and
> because §11 corrects one thing this section got wrong about how the
> extension would be shaped. The correction is in §11.2.

Neither was invented. If the business wants either product, these are the rows
to add to `src/lib/ledger/chart.ts` and seed:

```ts
{
  code: "4400",
  name: "Interest income — overdraft",
  type: "income",            // credit-normal
  book: "financial",
  parent: "4000",
  postable: true,
  why: "Interest charged on a customer's debit deposit balance, accrued daily on the balance actually outstanding at the end of each business date. Separate from 4200 because a fee is a price for a service and interest is a price for time and money: Reg DD discloses them differently, and an APR netted into fee income makes a rate look like a charge — the same error 4300's note forbids in the other direction.",
},
{
  code: "5400",
  name: "Interest expense — credit balances",
  type: "expense",           // debit-normal
  book: "financial",
  parent: "5000",
  postable: true,
  why: "Interest we pay customers on credit balances, accrued daily. Not 5100: that is what the network and the sponsor bank charge us, and netting what we owe customers into what providers charge us would hide both.",
},
```

With those in place, overdraft interest is an `ALTER TYPE accrual_product ADD
VALUE 'overdraft_interest'`, a `rate_bps integer` column beside `monthly_cents`
with a `CHECK` that exactly one is set per product, and one more `IMMUTABLE`
function — `accrual_daily_interest(balance_cents, rate_bps, days_in_year)`
rounding **half to even** per §12.2, because that one *is* a single value
producing a single cent amount. No rewrite: the product is a column, the
pricing is a row, the arithmetic is a function.

**The other reason to prefer half-even there and largest-remainder here** is
worth stating so the two do not look inconsistent: a monthly fee is one amount
being *divided*, so the shares must add back up to it. Daily interest is a
*fresh* calculation each day on a balance that changes — there is no total to
add back up to, so there is nothing to allocate and §12.2 is the applicable
rule. Same DESIGN §12, different clause, for a stated reason.

---

## 8. Proof: what is on the live book

Run twice for two consecutive business dates, then twice more for the same
date. Every row below is real, in Neon, posted through `postEntry()`.

```
tick A   bookDate 2026-09-09   considered 27   posted 27   postedCents 2565
tick B   bookDate 2026-09-10   considered  3   posted  3   postedCents  284
tick C   bookDate 2026-09-10   considered  0   posted  0   postedCents    0   <- replay
tick D   bookDate 2026-09-10   considered  0   posted  0   postedCents    0   <- replay, concurrent with C
```

The residual-penny transition, on Ridgeline's $25.00 plan:

| value date | F | N | d | q | r | residual | amount | cum | entry id | booking_seq |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: |
| 2026-09-09 | 2500 | 30 | 9 | 83 | 10 | **+1¢** | 84¢ | 756¢ | `55c208fb-7b92-4d30-a175-34f705bc4d24` | 1381 |
| 2026-09-10 | 2500 | 30 | 10 | 83 | 10 | **+1¢** | 84¢ | 840¢ | `96d5a30b-c9bc-49c9-93a3-82dd7a856041` | 1386 |

and the same day on the Starter plan, where the residual has run out:

| value date | F | N | d | q | r | residual | amount | cum | entry id |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| 2026-09-09 | 999 | 30 | 9 | 33 | 9 | **+1¢** | 34¢ | 306¢ | `446d5792-d06f-4e33-926a-2c045ffb9917` |
| 2026-09-10 | 999 | 30 | 10 | 33 | 9 | — | 33¢ | 339¢ | `c72f6a8b-61d0-4327-a429-7b19d90acda6` |

The sub-cent case, on the two-day probe schedule (20¢ a month, 31-day August):

| value date | F | N | d | q | r | amount | disposition | entry |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 2026-08-20 | 20 | 31 | 20 | 0 | 20 | 1¢ | posted | `3aae3348-77ff-4de3-ac01-b3c3b9c58d51` |
| 2026-08-21 | 20 | 31 | 21 | 0 | 20 | 0¢ | **skipped** | none — nothing to post |

Month roll-up, as of 2026-09-10, from `v_accrual_month`:

```
2026-09  Business Plus      F=4999  r=19  applied=10  posted=10  accrued=1670  remaining=3329
2026-09  Business Standard  F=2500  r=10  applied=10  posted=10  accrued= 840  remaining=1660
2026-09  Starter            F= 999  r= 9  applied= 9  posted=10  accrued= 339  remaining= 660
```

Invariants: `v_accrual_month_drift` **0**, `v_accrual_ledger_drift` **0**,
`v_accrual_unresolved` **0**. `node scripts/dbcheck.mjs` **20/20**. The whole
book still sums to zero.

**The double-run proof, at its lowest layer.** The integration suite takes a
real accrual entry, replays its exact posting through `postEntry()` with the
same derived key, and asserts the ledger hands back the *original* entry id and
that `count(*) FROM journal_entry` is unchanged. That assertion cannot go
vacuous once the days are accrued, which is why it is there as well as the
tick-level replay tests.

---

## 9. The job

`/api/cron/accrual`, authenticated exactly like `/api/drain` and
`/api/cron/standing`: the `x-vercel-cron` header, or a `DRAIN_TOKEN` bearer.
One shared operator credential for the scheduled jobs rather than a third
variable that is a silent 401 when it is forgotten.

This endpoint is the only scheduled job on this console that **moves money with
no human in between** — the drain processes webhooks and the standing tick
raises an instruction into the approvals queue. So there is no unauthenticated
path, even though accruing is idempotent. "Idempotent" is not "harmless": a
stranger who can pass `bookDate` can choose which day a fee is dated.

`bookDate` can point the tick at an **earlier** day — that is how a debrief
replays a date and how an operator closes a gap by hand. It cannot point at a
later one: `runAccrual()` asks the database what day it is and refuses, because
a fee accrued for a day that has not happened could only be undone on an
append-only ledger by a reversal plus a re-book of a charge that never should
have existed.

**On the Vercel Hobby plan a cron fires once a day, at an approximate time.**
That is the tightest schedule the platform runs and this document says so
rather than implying tighter. *"End of day"* here means **for the business
date**, not *at 23:59:59* — the entry carries the accrual date as its value
date, so a tick that runs late posts to the right day and a tick that missed a
week posts seven correctly dated entries. What a tick can never do is accrue a
date twice.

Catch-up window: 45 days (`CATCH_UP_WINDOW_DAYS`). Unlike a standing order,
a missed accrual day is not a conversation — the fee accrued whether or not the
job ran and the amount is bounded by the monthly price — so the window exists
only to stop a year-old schedule backfilling a year in one serverless
invocation. Anything older stays visible in the gap counter on `/accruals`.

---

## 10. Known gaps

- **`v_accrual_gap` bounds itself with `CURRENT_DATE`**, which resolves against
  the session `TimeZone` (UTC on Neon) rather than the book day
  (America/New_York). Between 19:00 and midnight Eastern it is already on
  tomorrow and reports every schedule as owing a day that has not happened.
  Nothing is mis-posted — the tick takes its date from `bookToday()` and
  refuses to run ahead of the book — and `readInvariants()` deliberately does
  not use the view, asking the same question with the book date instead. The
  view itself needs a one-line fix in a later migration: 0020 is applied, and
  an applied migration is immutable.
- **`v_accrual_month_drift` and `v_accrual_ledger_drift` are not in
  `scripts/dbcheck.mjs`'s `INVARIANT_VIEWS` list.** They are asserted empty by
  the integration suite and rendered on `/accruals`, but dbcheck is the script
  that runs in the debrief and they belong in it. Two lines, and it becomes
  22/22.
- **No nav entry.** `/accruals` is reachable by URL; adding it to
  `src/components/app-shell/NavLinks.tsx` is one line.
- **No cron entry in `vercel.json`.** The route exists and is authenticated;
  nothing schedules it yet.
- ~~**One product.**~~ **Closed by migration 0024.** Both interest sides are
  built; see §11. What remains open is that *overdraft* interest has posted
  nothing, because nothing on this book is overdrawn — which is a fact about
  the book and not about the feature. §12 measures it.
- **No mid-month price change on the live book.** `accrual_schedule` is
  effective-dated and `accrual_schedule_no_overlap` enforces one live price per
  account per product, so a price change is a new row — but nothing has
  exercised that path yet, and the interesting question it raises (does the
  month's allocation restart, or does the customer pay a pro-rata of each
  price?) is answered by the schema, not by a decision anyone has written down.

---
---

# Part two — interest, the other half of the ladder

> Everything above this line is the platform fee and migration 0020. Everything
> below is interest and migration `db/migrations/0024_interest.sql`. They are
> one feature, one screen and **one tick**; they are two rounding rules,
> because `DESIGN.md` §12 has two and each product meets the precondition of a
> different one. That sentence is the whole of §13.

- Code: `src/lib/accrual/interest-types.ts` (the rule, pure),
  `interest-store.ts` (every statement), `interest.ts` (the tick's second leg)
- Screen: the lower half of `/accruals`; `src/components/accrual/Interest*.tsx`
- Job: `/api/cron/accrual` — **the same one**, no second cron, no second route
- Tests: `src/lib/accrual/interest-types.test.ts` (pure),
  `interest.integration.test.ts` (live database, real money)

---

## 11. What is accrued, and why it is one product with two sides

**Daily interest on a customer's deposit balance**, priced on the settled
ledger balance at the end of each business date.

| The balance that day | Side | Entry |
| --- | --- | --- |
| positive — the customer is in credit | `credit` — **we pay** | debit `5400 Interest expense — credit balances`, credit the deposit account |
| negative — the customer is overdrawn | `overdraft` — **we charge** | debit the deposit account, credit `4400 Interest income — overdraft` |
| exactly zero | `flat` | nothing. A decided day with no entry |

Both chart accounts are the ones §7 named, added verbatim to
`src/lib/ledger/chart.ts` and to the live chart by 0024 §7.

### 11.1 One enrolment, one rate card, two sides

§7 sketched the extension as two products —
`ALTER TYPE accrual_product ADD VALUE 'overdraft_interest'` and another for the
credit side. **That is the one thing §7 got wrong, and it is worth saying
why.** A business current account does not have an overdraft product and a
credit product; it has *a rate card with two rates*, and which one applies on a
given day is decided by the sign of the balance on that day.

Modelled as two products, an account enrolled in both would claim the same date
twice and one of the two claims would always decide `skipped` — doubling the
rows, and making the day an account crosses zero look like two products handing
off. Modelled as one enrolment, **the crossing is a single account's single
timeline**: the day before prices on `5400`, the day after prices on `4400`,
and nothing is reconfigured, redeployed or enrolled for that to happen.

`interest_side_of(balance)` is a function, not a column somebody sets.

### 11.2 Why it is not `accrual_product = 'interest'` on 0020's tables

§7 also assumed the extension would be a column on `accrual_schedule` and an
enum value. It cannot be, and the reason was measured rather than assumed:

```
BEGIN;
ALTER TYPE accrual_product ADD VALUE 'interest';
SELECT 'interest'::accrual_product;
ERROR:  unsafe use of new value "interest" of enum type accrual_product
```

PostgreSQL 18.6, on this database. The restriction is documented and permanent:
a value added by `ALTER TYPE` cannot be **used** until the adding transaction
commits, and `scripts/migrate.mjs` applies each file inside one transaction —
correctly, because a half-applied migration is worse than a refused one. One
migration can add the value or use it, never both.

The second reason is the better one. `accrual_posting` carries seven stored
relations re-derived by `accrual_posting_arithmetic`, and
`assert_accrual_posting()` asserts the entry is exactly two lines, a debit to
the deposit account and a credit to `4200`. Every one of those is fee-shaped.
Making them hold interest too would mean nullable columns, a `CHECK` that
branches and a lifecycle trigger with two arms — **weakening a working proof to
avoid writing a second one.** So 0024 does not alter a table, replace a view or
drop a constraint that 0020 created. It reuses the *construction*:

| 0020, for the fee | 0024, for interest |
| --- | --- |
| `accrual_schedule` | `interest_schedule` |
| `accrual_day` — `UNIQUE (schedule_id, accrual_date)` | `interest_day`, same |
| `idempotency_key` GENERATED `accrual:<sched>:<date>` | GENERATED `interest:<sched>:<date>` |
| `accrual_posting` PK `accrual_day_id` | `interest_posting` PK `interest_day_id` |
| `lock_accrual_schedule()` SECURITY DEFINER | `lock_interest_schedule()` |
| `accrual_due_dates()` | `interest_due_dates()` |
| `runAccrual()` | **the same `runAccrual()`**, second leg |

**The fee leg runs first**, and the ordering is load-bearing: the fee is a
debit dated *D*, so the end-of-day-*D* balance interest is priced on includes
it. Under a cent of interest on these balances, and an ordering that changes a
number is a decision rather than an accident of a loop.

---

## 12. The measurement: what the book actually shows about overdrafts

The brief for this work said one account was "now around −$1,800" and asked for
that to be verified rather than inherited. It was, before a line was written,
at the live booking watermark:

| Question | Answer |
| --- | --- |
| `SELECT count(*) FROM v_overdrawn_accounts` | **0** |
| Deposit leaves with a settled balance < 0 today | **0 of 5** |
| (deposit leaf, value date) pairs in debit on **any** date in the 45-day catch-up window | **0** |
| Any account in the whole chart with a negative natural balance | **0** |

`v_overdrawn_accounts` is `code = '2100' AND business_id IS NOT NULL AND
balance_cents < 0`. It was empty when 0020's author checked it and it is empty
now — and the *stronger* question, asked across every value date in the window
rather than only today, is empty too. Every deposit leaf on this book is in
credit and has been.

**So `4400 Interest income — overdraft` ships with zero rows, and the screen
says so on its face** rather than an overdraft being manufactured to
photograph. The rate is on the card (18.00% a year), the enrolment already
carries it, `interest_side_of()` already selects it, and the first business
date on which an account closes in debit will price on `4400` with nothing
deployed. `readInterestInvariants()` re-asks both questions on every render, so
the panel changes by itself when the book does.

What *is* demonstrated is **credit interest** — what we pay for holding a
balance — on five real accounts. It is also the larger of the two numbers a
deposit-taking business has, which is why it lives in its own expense account
rather than netted into `5100`.

---

## 13. The rounding rule: DESIGN §12.2, and why §12.3 is *undefined* here

§2 argues that a monthly fee accrued daily is **§12.3, largest remainder**, and
that is right: the month has a total — the quoted price — the days are shares
of it, and the shares must add back up to it exactly.

**Daily interest is §12.2, round half to even.** And §12.3 is not merely worse
here:

> **Largest-remainder needs a source amount to distribute. Daily interest has
> none.** There is no month-total to allocate, because the balance changes
> every day and the month's interest is not a known number until the month has
> happened. You cannot floor N shares of a number you do not have, and you
> cannot distribute a shortfall against a total that does not exist.

What daily interest *is*, exactly, is **one value — a balance, a rate and one
day — becoming one cent amount**, which is §12.2's sentence with nothing left
to interpret.

### 13.1 The arithmetic, in integers

```
B   = the settled ledger balance at end of the business date, signed cents
R   = the annual rate for this side, in BASIS POINTS (150 = 1.50% a year)
Y   = the day-count denominator (365; see §14)

side = credit if B > 0, overdraft if B < 0, flat if B = 0
N    = |B| * R                the numerator   -- MAGNITUDE: the sign is carried
D    = 10000 * Y              the denominator    by `side`, not by the division
q    = N div D                whole cents
r    = N mod D                the sub-cent fraction, 0 <= r < D

2r > D  ->  q + 1             past the half: round up
2r < D  ->  q                 short of the half: round down
2r = D  ->  q + (q mod 2)     EXACTLY the half: round to the EVEN cent
```

`2r` against `D` rather than `r` against `D/2` is deliberate: `D/2` on integers
truncates for an odd `D` and would silently classify some genuine ties as
"down", which is exactly the bias half-even exists to remove.

**Half to EVEN and not half up** for §12.2's own stated reason — *"half-up
biases every tie in one direction, and over a year of interchange that bias is
a real number"*. Here the tie is the exact half cent, and half-up would hand it
to the same party every single time: to us on an overdraft, to the customer on
a credit balance.

**Rounding is symmetric in the sign.** The magnitude is rounded and the side is
carried separately. Truncating division on a signed basis would round every
overdraft charge *away* from zero and every credit payment *toward* it — a
systematic bias in the bank's favour that no line of code would have had to
state out loud.

### 13.2 Nobody eats a residual penny here, and that is not a contradiction

§4 says who eats the fee's residual penny, because §12.3's residual is **real
money** that has to land on one of the shares: the shares must sum to a source.

§12.2 has no residual to place. The sub-cent fraction **never existed as
money**, no party was ever credited with it, and the entry is two equal and
opposite lines summing to zero. It is also why §12.6's dust clearing account
`2900` is *not* engaged: 2900 exists for dust that arrived as a real external
amount — a USDC transfer with six decimals — where truncating would break the
identity between customer balances and our obligation. A fraction of a cent of
interest is not money that arrived; it is precision that was never claimed.

The bound is **half a cent per account per day**, it is unbiased by
construction, and `remainder_units` is stored on the row and rendered on the
screen so the fraction that was dropped is visible rather than merely absent.

**So there are still exactly two rounding rules in this ledger.** They are the
two `DESIGN.md` §12 already had, and each product uses the one whose
precondition it actually meets. Three would be worse; two that were invented
for a feature would be worse still.

---

## 14. Day count: ACT/365 fixed, defended

A rate is per annum and a day is a fraction of a year; the convention is *which
fraction*, and "the usual one" is not an answer.

**ACT/365 FIXED.** Numerator: the actual number of days, which here is always 1
because this is a daily accrual. Denominator: 365, in every year, leap or not.

1. **It is the US deposit convention.** 12 CFR 1030 (Reg DD) Appendix A
   computes the daily periodic rate as the nominal annual rate divided by 365.
   A deposit product whose disclosed APY is computed on `/365` and whose ledger
   accrues on `/360` discloses one number and pays another.

2. **ACT/360 pays and charges 1.389% more per year for the same quoted rate**
   (365/360). That is defensible on a commercial loan quoted that way and
   indefensible on a disclosed deposit rate. This is a business *current
   account*, both sides are disclosed, so both sides get `/365`.

3. **Fixed rather than ACT/ACT.** In a leap year the 366th day accrues at
   `1/365`, so a leap year pays `366/365` of the nominal rate — 0.27% more
   interest, in the customer's favour on a credit balance and against them on
   an overdraft. The alternative changes the denominator mid-product, which
   means two statements a year apart divide by different numbers for no reason
   a customer can see. Disclosed here rather than discovered in February 2028.

The denominator is a **column** on the rate policy, constrained to `(360, 365)`
so the convention is data a row states and a reviewer reads, rather than a
constant nobody can find.

---

## 15. Rates are configuration, effective-dated, and cannot reach back

`approval_policy` (0001 §12) and `funds_availability_policy` (0001 §5) are the
pattern: a policy is a fact with a lifespan, it lives in its own versioned
table, it is append-only, and a change is a **new row with a later effective
date**. `interest_rate_policy` is the third of them.

**The rate is on the rate card, not on the enrolment.** A schedule cites a
`tier`, not a rate. One new policy row re-prices every enrolled account from a
date forward; putting the rate on the schedule would mean N new schedule rows
per change and N chances to write a different number on one of them.

Three layers make "a rate change must not retroactively re-price yesterday"
true, and only the first is a convention:

1. **Resolution is on the ACCRUAL date.**
   `interest_rate_at(tier, accrual_date)` is the greatest `effective_from` not
   after that date. A replay of an old day passes that old day and gets the old
   card back — by construction, not by anyone remembering.

2. **`interest_rate_policy_forward_only` refuses the INSERT.** A new row's
   `effective_from` must be strictly later than *every existing row for its
   tier* **and** strictly later than *every date already accrued under it*. The
   second condition is the one with teeth: without it, a row dated April
   satisfies the first condition when the newest card is from March, and
   silently re-prices five months of postings that are already on the ledger.
   Refusing the insert is the right remedy, because afterwards the postings are
   immutable and the only repair is a reversal and a re-book of every affected
   day.

3. **`v_interest_rate_drift` must return zero rows.** The same question asked
   of the whole book at any moment: every posting must still resolve to the
   card effective on its own accrual date. It is what would catch a policy row
   inserted behind the trigger's back, and it is in `scripts/dbcheck.mjs`.

The exclusion constraint `interest_schedule_no_overlap` does the matching job
for enrolments: one live enrolment per account, so two overlapping ones cannot
each claim the same day and pay the customer twice with both halves
arithmetically perfect.

---

## 16. The basis: the settled ledger balance, at a recorded watermark

Interest is priced on `ledger_settled_cents(account, accrual_date,
observed_booking_seq)` — **migration 0022's canonical balance**, not a fifth
private copy of one. Both bitemporal predicates are load-bearing:

```
value_date  <= the accrual date      which business days count
booking_seq <= the watermark         what we had LEARNED when we priced it
```

**Not the available balance.** Available subtracts holds, and a hold is money
we have not yet been asked for: the customer still holds the funds and we still
owe them, so we still owe interest on them. A card authorisation is not a
withdrawal.

**The watermark is stored, and that is a bitemporal decision with a
consequence.** A correction backdated into a day already priced does **not**
re-price that day: the posting stands, the row records exactly which watermark
it was priced at, and the number remains reproducible from the row. Re-pricing
would mean reversing and re-booking an interest charge that was correct on the
information available — a real product (an interest adjustment) and named as a
gap in §19 rather than half-built here.

### 16.1 `basis_balance_cents` is evidence, not a stored balance

`scripts/dbcheck.mjs` check 5 refuses stored balance columns, and it is close
to this ledger's thesis: a stored balance is a second source of truth that
drifts from the rows it summarises. The exemption for this column is **named as
a `(table, column)` pair, never as a pattern**, and it is paid for by check 5b,
which recomputes every stored basis from the journal through
`ledger_settled_cents()` at the watermark the row itself recorded and asserts
equality.

Two conditions hold, and both are checkable rather than asserted:

- **It is reproducible.** `booking_seq` is monotonic, so
  `ledger_settled_cents(account, date, seq)` is frozen for all time. Check 5b
  re-derives it row by row; it was made to fail, against this database in a
  rolled-back transaction, by storing a fabricated balance behind a disabled
  trigger (1 row reported).
- **Nothing reads it as a balance.** No screen, no API and no other calculation
  takes a current position from it. It is an input to an audit trail and the
  operand of the fraction printed beside it. The balance the enrolment table
  shows is computed on every read and is not this column.

`assert_interest_posting()` re-derives the basis at insert as well, so the
figure on the row is one Postgres agreed with rather than one the job asserted.

### 16.2 Interest credited daily compounds daily, and that is visible

Each day's interest is posted to the deposit account at that day's value date,
so the **next** day's basis includes it. The product therefore compounds daily
and the effective annual yield is slightly above the quoted rate.

That is a consequence of *"accrued at end of day, visibly, on the ledger"*
rather than a separate decision. The alternative — accruing to a holding
account and crediting monthly, so the month does not compound — would require a
second balance definition that excludes interest lines from its own basis,
which is exactly the drift 0022 spent a pass undoing. It is visible in the
worked example below: the balance rises by the previous day's interest.

---

## 17. Proof: what is on the live book

Run for two consecutive business dates, then twice more for the same date,
concurrently. Every row below is real, in Neon, posted through `postEntry()`.

```
tick A   bookDate 2026-09-10   interest considered 20   posted 20
tick B   bookDate 2026-09-11   interest considered  5   posted  5
tick C   bookDate 2026-09-11   interest considered  0   posted  0   creditInterestCents 0   <- replay
tick D   bookDate 2026-09-11   interest considered  0   posted  0   creditInterestCents 0   <- replay, concurrent with C
```

`currentBookingWatermark()` is identical before and after C and D. It is
monotonic and every append bumps it, so "unchanged across two concurrent full
ticks" is a stronger statement than a row count and cannot be true by accident.

### 17.1 The edge: the day the price of money changed under one account

Kettle & Crumb Bakery LLC, `standard` card, ACT/365, across the change on
2026-09-09. **These are the `?state=edge` rows.**

| value date | basis | wm | rate | card effective | N ÷ D | q | r | 2r vs D | rounding | posted | entry id |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: | --- |
| 2026-09-07 | $2,003.00 | 2243 | 150 bps | 2026-09-07 | 30045000 ÷ 3650000 | 8 | 845000 | 1690000 < 3650000 | down | **8¢** | `1c4b26b5-4947-4c49-bbfd-99fac2a62342` |
| 2026-09-08 | $2,003.08 | 2248 | 150 bps | 2026-09-07 | 30046200 ÷ 3650000 | 8 | 846200 | 1692400 < 3650000 | down | **8¢** | `c4798e18-f946-424d-ac38-303383310bc9` |
| 2026-09-09 | $2,003.16 | 2253 | **125 bps** | **2026-09-09** | 25039500 ÷ 3650000 | 6 | 3139500 | 6279000 > 3650000 | **up** | **7¢** | `fd6589a5-8b22-49a4-9f2c-53b5becb9503` |
| 2026-09-10 | $1,049.03 | 2258 | 125 bps | 2026-09-09 | 13112875 ÷ 3650000 | 3 | 2162875 | 4325750 > 3650000 | up | **4¢** | `4043ca72-0cea-48bc-83ef-9e8379f88526` |
| 2026-09-11 | $31,656.67 | 2263 | 125 bps | 2026-09-09 | 395708375 ÷ 3650000 | 108 | 1508375 | 3016750 < 3650000 | down | **108¢** | `de73e0f2-6e33-422d-b97c-21dd55c863e2` |

Read the 8th and the 9th together. **The balance went UP by 8¢** — the 8th's
interest was credited to the account, §16.2 — **and the amount posted went DOWN
by a cent.** Nothing but the rate change can explain that. Re-running the 8th
today still resolves the 1.50% card and still produces 8¢, because
`interest_rate_at()` takes the accrual date.

It is also both directions of §12.2 in adjacent rows: the 8th rounds **down**
and the 9th rounds **up**, with the `2r` comparison printed on each.

Two lines per entry, checked by `assert_interest_posting()` before the row
would store, for 2026-09-09:

```
5400 Interest expense — credit balances    +7   debit    (a cost to us)
2100/Kettle & Crumb                        -7   credit   (we owe them more)
                                          ----
                                             0
```

### 17.2 The zero-cent days, on real accounts and real dates

Both are `disposition = 'skipped'` with a reason: `postEntry()` refuses a
zero-amount line and is right to, so a day that prices at nothing is a
**decided** day with no entry rather than a missing row.

| business | value date | basis | rate | N ÷ D | side | why |
| --- | --- | ---: | ---: | --- | --- | --- |
| Pots Integration Fixture Co. | 2026-08-20 | **$0.00** | — | 0 ÷ 3650000 | `flat` | a balance of exactly zero has no side and is owed nothing either way |
| Pots Integration Fixture Co. | 2026-08-21 | **$0.00** | — | 0 ÷ 3650000 | `flat` | as above |
| Hold Fuzzer Fixture Co. | 2026-08-20 | $2,359.48 | 1 bp | 235948 ÷ 3650000 | `credit` | 0.065 of a cent — under half, so §12.2 rounds it to nothing |
| Hold Fuzzer Fixture Co. | 2026-08-21 | $2,359.48 | 1 bp | 235948 ÷ 3650000 | `credit` | as above |

The 1 bp card is a second tier (`probe`) created by the integration suite —
`interest_rate_policy_forward_only` is per-tier, so an August window cannot be
hung off `standard`, and that is the constraint working rather than a loophole.

### 17.3 The invariants, and that they can fail

| view | now | made to fail, in a rolled-back transaction |
| --- | ---: | --- |
| `v_interest_ledger_drift` | **0** | 0 → **1** after a posting was made to cite an entry belonging to a different day, with `interest_posting_lifecycle` disabled |
| `v_interest_rate_drift` | **0** | 0 → **5** after a rate row was backdated behind `interest_rate_policy_forward_only` |
| dbcheck 5b (basis recompute) | **0** | 0 → **1** after a fabricated balance was stored behind the disabled trigger |

Both views are now in `scripts/dbcheck.mjs`'s `INVARIANT_VIEWS`, and they were
made to fail **before** they were listed there — 0023's lesson applied on the
way in rather than after the fact. `node scripts/dbcheck.mjs` is **28/28**.

The forward-only trigger is asserted directly too: the integration suite tries
to insert a rate effective on a date already accrued, and on a date before the
first card, and both are refused.

---

## 18. Decisions worth defending

**The unit is the (enrolment, date) pair, and the key is derived by Postgres.**
`interest:<enrolment id>:<YYYY-MM-DD>`, `GENERATED ALWAYS … STORED`, from the
two source facts. The `interest:` prefix rather than `accrual:` means a fee day
and an interest day for the same account on the same date can never collide in
`journal_entry.idempotency_key` — and a human reading a key knows which product
wrote it.

**The lock is a liveness device, not the safety device.** A crashed process
releases a lock. It cannot release a unique index, and the unique indexes are
what the guarantee rests on.

**Value date is the accrual date.** `assert_interest_posting()` refuses any
entry whose `value_date` is not the claim's date, so a tick catching up three
days posts three entries with those three value dates and today's `booking_seq`.

**Interest is not funds-checked, and overdraft interest especially is not.**
Charging an overdrawn account is charging an account that by definition cannot
afford it. That is what an overdraft is.

**A basis disagreement rolls the day back rather than storing a wrong number.**
The watermark is read, then the balance is read parameterised by it, then the
trigger re-derives both. If a concurrent transaction commits an entry whose
booking sequence was assigned before this run read the maximum, the two answers
differ and the INSERT is refused — the day rolls back whole and the next tick
prices it against a watermark that has settled. A retry is the failure mode; a
wrong number is not.

**No float, including intermediates.** Every operand is `bigint` or a small
integer count of basis points or days. `bigint` division truncates toward zero
and the numerator is a magnitude, so `N / D` *is* the floor — the same answer
Postgres gives, which is what lets the database check the work. The pure suite
sweeps every balance from 0 to $20,000 across six rates and both signs,
asserting `|amount × D − N| × 2 ≤ D` by cross-multiplication so the comparison
itself never leaves the integers, and it holds past
`Number.MAX_SAFE_INTEGER`.

**The tie is tested in both directions, on inputs that produce it.** A tie
needs `|balance| × rate` to be an odd multiple of `1825000 = 73 × 25000`;
$365.00 at 150 bps gives `q = 1` (odd → up to 2¢) and at 250 bps gives `q = 2`
(even → stays at 2¢). Half-up would have said 2¢ and 3¢. A rounding rule whose
tiebreak is never taken is a rounding rule nobody has tested.

**The tie has never occurred on this book, and the screen says so.** At these
balances and these rates the numerator is never an odd multiple of 1,825,000,
so `tie_to_even` has a count of zero on the summary tile — implemented,
exercised in the pure suite, and not yet needed live. Saying that is better
than implying the tile is proof of something.

---

## 19. Known gaps

- **No interest adjustment.** A correction backdated into a day already priced
  does not re-price that day (§16). The right product is an *interest
  adjustment* — a reversal plus a re-book at the original day's value date,
  keyed `interest-adj:<enrolment>:<date>:<watermark>` so a second adjustment
  for the same repriced watermark is idempotent too — and it is named here
  rather than half-built.
- **Overdraft interest has no rows.** §12. A fact about the book, measured, not
  a gap in the feature — but it means the overdraft path's *entry shape* is
  proven only by `assert_interest_posting()`'s code and the pure suite's
  symmetry test, never yet by a posted entry.
- **No monthly credit cycle.** Interest is credited daily and therefore
  compounds daily (§16.2). A real product usually accrues daily and credits
  monthly; that is a different product, not a bug fix, and it would need the
  accrued-not-yet-credited balance to be a ledger position rather than a
  calculation.
- **`v_interest_month` has no drift view, deliberately.** Daily interest has no
  monthly total to sum back to, so there is nothing for a `month_drift` view to
  assert. Inventing one would be pretending §12.3 applies.
- **One rate card in production use.** `standard`. The `probe` tier exists only
  to exercise the zero-cent paths, and per-tier rate independence is therefore
  demonstrated but not used.
- **No nav entry and no cron entry**, inherited from §10 and unchanged: the
  interest leg rides the same `/api/cron/accrual` that nothing schedules yet.

---

# Part three — §20: the day that was priced before it closed

> Added 2026-09-11 after an audit of this document against the live book. It
> reports one defect that was real and unrepairable, the fix that stops it
> recurring, and two claims above that were true when written and are false now.
> Nothing in Parts one and two has been edited; a document that quietly
> rewrites its own history is the same failure as a ledger that does.

## 20.1 What was wrong

**"Interest computed at end of day" was not true. It was computed whenever the
tick ran, including in the middle of an open business date — and the index that
makes the tick exactly-once is the same index that makes that permanent.**

§16 defines the basis as *"the settled ledger balance at the end of the business
date"*. `runAccrual()` refused a `bookDate` in the future (§9) and allowed
`bookDate = today`, which was also the default the cron used. A date that has
not ended does not have an end-of-day balance, so what the tick actually priced
was *the balance at the instant it ran*.

`interest_day` is `UNIQUE (schedule_id, accrual_date)`. That is §5's whole
guarantee — and it means the first tick to touch an open date freezes a mid-day
figure as that date's end-of-day basis for ever. §19 already records that there
is no *interest adjustment* product, so there is no repair path either.

## 20.2 The measurement, on this book, with the ids

Every one of the five enrolments had **2026-09-11** priced at a watermark
early in that same business date. What the day actually closed at, at watermark
5568, is the second column:

| business | priced on, at wm | the same date, at the live watermark | posted |
| --- | ---: | ---: | ---: |
| Hold Fuzzer Fixture Co. | $499,854.26 @ 2266 | $534,030.87 | 1712¢ credit |
| **Holds Integration Fixture Co.** | **$145,315.17 @ 2265** | **−$858,941.45** | **498¢ credit** |
| Kettle & Crumb Bakery LLC | $31,656.67 @ 2263 | $45,866.63 | 108¢ credit |
| Pots Integration Fixture Co. | $25,000.06 @ 2262 | $25,000.92 | 86¢ credit |
| Ridgeline Robotics, Inc. | $33,843.03 @ 2264 | $58,638.31 | 116¢ credit |

Pots Integration's 86¢ of movement is the day's own interest entry landing
after the watermark it was priced at, which is by construction. The other four
are real money that arrived after the tick. One of them **changed sign**.

Entry `47ad3ebe-1b69-4c6d-9c9a-bdb25d0fbf0a`, value date 2026-09-11, seq 2266,
key `interest:d2db66df-5837-4a97-892b-4cefa7b76cca:2026-09-11`, two lines:

```
5400 Interest expense — credit balances              +498   debit
2100/Holds Integration Fixture Co.                   −498   credit
```

Its line memo reads *"we pay 1.25% a year on a credit balance: $145,315.17 …"*
The account closed that business date **$858,941.45 overdrawn**. At the 1800 bps
overdraft rate on the same card the day was worth roughly **$423.53 charged to
`4400`**, in the other direction. Both the amount and the side are wrong, the
posting is immutable, and the claim is already made.

## 20.3 Two statements in Parts one and two that are now false

- **§12 and the screen: "`v_overdrawn_accounts` returns 0".** It returns **1**,
  for $858,941.45, as of 2026-09-11. The screen re-asked the question on every
  render — which is why it changed by itself — but its two branches were
  "overdraft interest is live" and "nothing has ever been in debit", and the
  book is in neither state. `OverdraftMeasurement` now has a third branch for
  the state it is actually in: **an account is overdrawn and `4400` has no rows,
  and here is why.** The "Charged on overdrafts" tile no longer says "no deposit
  account has been in debit" while one is.
- **§12's bound: "0 (deposit leaf, value date) pairs in debit on any date in the
  45-day window".** It is 1 — 2026-09-11, the same account. Re-measured, not
  inherited.

## 20.4 The fix

`interestPricingHorizon(bookDate)` in `src/lib/accrual/interest-store.ts`. The
interest leg's window now ends at **`book_date(now()) - 1`**, in book time. A
caller that asks for today is **held, not refused**: the tick prices every
closed date it owes, reports `pricedThrough` and `openDateHeld` on the run
report, and takes today on the first tick after midnight. Nothing is lost — the
day accrued whether or not the job ran, and the entry carries the date it
accrued *for*.

**The fee leg is deliberately not held back.** A platform fee is `F`, `N` and
`d`: a price, a calendar and an ordinal. It reads no balance, so an open day
cannot make it wrong, and delaying a correct number buys nothing.

Consequences, stated rather than discovered:

- `v_interest_gap` will normally show one pair per enrolment — today's — until
  midnight. That is the horizon, not a stalled tick, and the screen's note says
  so. Anything **older** than today persisting still means the tick is not
  running.
- The newest interest date on `/accruals` is yesterday's, by design.
- The five rows of 20.2 stay exactly as they are. `readInterestInvariants()`
  counts them (`pricedBeforeClose`, `pricedBeforeCloseCents` — 5 and $25.20) and
  the screen prints the count with the reason, because an append-only ledger
  cannot un-say something and the honest alternative to a repair is a label.

`src/lib/accrual/interest.integration.test.ts` asserts the horizon in both
directions and asserts a tick asked for today names no day later than
yesterday. It was "made to fail" the hard way: by the five rows above, on the
live book, before the guard existed.

## 20.5 What is still weaker than it reads

- **`v_accrual_month_drift` has never had a population.** It is gated on
  `month_complete`, which is `days_decided = days_in_month`, and no
  (schedule, month) pair on this book has ever been complete: every fee
  schedule started 2026-09-01 and September is not over, and the two
  probe/partial schedules can never be complete for their month by
  construction. `scripts/dbcheck.mjs` says so in as many words — *"0 COMPLETE
  accrual months: green because there is nothing to be green about"* — and
  `--prove` constructs a complete month to show the view can fail. So the guard
  is provable and currently vacuous, and §2's "`v_accrual_month_drift` is empty
  or the feature is broken" should be read as "will be, from the first complete
  month".
- **§4's sub-cent example says "the month still sums to exactly 20¢".** That is
  a property of the rule. On the book the probe schedule ran two days of a
  31-day August and accrued 1¢; the other 29 days were never claimed, so
  nothing sums to 20¢ and `v_accrual_month_drift` cannot see it either. True of
  the arithmetic, not of the rows.
- **A backdated correction still does not re-price a day already priced** (§16,
  §19). The horizon fixes the *forward* case — pricing a day too early — and
  does nothing about the *backward* one, which needs the interest adjustment
  §19 names.
- **`/api/cron/accrual`'s own comments** still describe the tick as pricing
  "the book date" without the horizon. The route is outside this document's
  edit surface; the behaviour is in `interest.ts` and is what runs.

## 20.6 The tick that was run to check all of this, with its ids

A real enrolment, a real tick, a real replay — because everything on the book
was already caught up and a tick with nothing to do proves nothing.

Schedule `fcaa98c2-d87b-446b-87df-84d9aab443f8`, Kettle & Crumb Bakery LLC
(`392043e2-…`), Business Standard, **$25.00 a month, from 2026-09-10**, key
`audit:2026-09-11:kettle:platform_fee`. September has 30 days, so

```
F = 2500      N = 30
q = 2500 div 30 = 83          r = 2500 mod 30 = 2500 − 2490 = 10
d = 10:  10 <= 10  ->  83 + 1 = 84c     cum = 83*10 + min(10,10) = 840
d = 11:  11 >  10  ->  83     = 83c     cum = 83*11 + min(11,10) = 923
```

| tick | bookDate | considered | posted | cents | entry |
| --- | --- | ---: | ---: | ---: | --- |
| A | 2026-09-10 | 1 | 1 | 84 | `2beff7da-9ebe-4c59-95f2-17c6bde12993` seq 5670 |
| B | 2026-09-10 | 0 | 0 | 0 | replay |
| C | 2026-09-10 | 0 | 0 | 0 | replay, concurrent with B |
| E | 2026-09-11 | 1 | 1 | 83 | `aeb0d32d-fc68-4f67-b9bd-f8b03925693b` seq 5671 |

Tick A ran on 2026-09-11 and posted an entry dated 2026-09-10: value date and
booking sequence are different columns, and this is the row that shows it.
The line memo is the arithmetic, verbatim from the journal:

> *"$25.00 ÷ 30 days = 83¢ per day, with 10¢ left over. day 10 is one of the
> first 10, so it carries one of those pennies: 83¢ + 1¢ = 84¢."*

`accrual_posting` stores `monthly_cents 2500, days_in_month 30, day_of_month 10,
base_share_cents 83, residual_pennies 10, residual_applied true, amount_cents 84,
cumulative_cents 840`, and `accrual_posting_arithmetic` re-derived all seven
before the row would store.

**Three separate refusals, asked directly of the database:**

```
replay of the same key through postEntry()
    -> the ORIGINAL entry id 2beff7da-…, journal_entry count 4712 -> 4712

INSERT INTO accrual_day (…, idempotency_key, …)
    -> cannot insert a non-DEFAULT value into column "idempotency_key"

INSERT INTO accrual_day (schedule, 2026-09-10) a second time
    -> duplicate key value violates unique constraint "accrual_day_once"
```

**And the rate card, §15, asked three ways in rolled-back transactions:**

```
'standard' effective 2026-09-08  -> tier standard already has a rate effective 2026-09-09;
                                    a rate change is a LATER row, never an earlier or equal one
'standard' effective 2026-09-11  -> tier standard has already accrued through 2026-09-11;
                                    a rate effective 2026-09-11 would retroactively re-price
                                    days already on the ledger
'standard' effective 2026-09-01  -> (the first clause again)
```

Every Kettle posting still resolves the card effective on its **own** accrual
date — 150 bps for 09-07 and 09-08, 125 bps from 09-09 — so 2026-09-09's 7¢ is
still 7¢:

```
B = 200316c   R = 125 bps   Y = 365
N = 200316 × 125 = 25,039,500          D = 10000 × 365 = 3,650,000
q = 6   r = 25,039,500 − 21,900,000 = 3,139,500
2r = 6,279,000  >  3,650,000   ->  UP  ->  7c        entry fd6589a5-8b22-49a4-9f2c-53b5becb9503
```

and the day before it, on a balance 8¢ HIGHER, is 8¢ — because the rate changed,
not the balance:

```
B = 200308c   R = 150 bps
N = 30,046,200      q = 8      r = 846,200
2r = 1,692,400  <  3,650,000   ->  DOWN ->  8c       entry c4798e18-f946-424d-ac38-303383310bc9
```

`v_accrual_month_drift`, `v_accrual_ledger_drift`, `v_interest_ledger_drift` and
`v_interest_rate_drift` were **0 rows** before and after, `node
scripts/dbcheck.mjs` read **38 passed / 4 failed** (the four deliberate ones),
and `--prove` covered **26 of 26**.

---

# Part four — §21: what was done about the five days

> Added 2026-09-11, after §20. §20 reported the defect, shipped the horizon and
> said the five rows "stay exactly as they are" because a correction "cannot be
> expressed in the existing model". The first half of that is still true and the
> second half was giving up too early. This section is the correction, its
> argument, and the one thing the calendar will not let it do today.

## 21.1 The question, stated so the answer is not obvious

Five posted interest days were priced on a balance that was not their own
business date's closing balance. `interest_day` is `UNIQUE (schedule_id,
accrual_date)`, so none of them can be priced again. Three answers were on the
table:

| | What it says | Verdict |
| --- | --- | --- |
| **A. Leave them, make them legible** | A marker recording the priced-at and closed-at watermarks, so the book carries its own correction | **Half of the answer. Not all of it.** |
| **B. Correct by append** | Reverse the wrong postings and re-book what the closed balance earned or owed, at the original value date | **The answer — and it cannot be done today** |
| **C. Loosen the index** | Let a second `interest_day` re-price the date | **Refused, §21.3** |

**A is not an alternative to B; it is the first half of B.** A correction needs
a population, and a population that is a `WHERE` clause inside a repair script
is a population nobody else can see — 0048's rule. So the marker is built first
and the repair ranges over it, and that is why both exist rather than either.

## 21.2 Why leaving them labelled is not enough, even though §16 seems to allow it

§16 says a correction backdated into a day already priced does **not** re-price
that day: *"the posting stands, the row records exactly which watermark it was
priced at."* Read quickly, that exempts these five.

It does not, and the distinction is the whole of this section. §16's argument is
**bitemporal**: the figure was correct *on the information available at the end
of the business date it priced*, and a later-learned fact does not make a past
belief wrong. That is a real and defensible product rule.

**These five rows are not that.** Their recorded watermark is not "what we had
learned by the end of 2026-09-11". It is *what we had learned at 00:21 on
2026-09-11*, with twenty-three hours of that business date still to happen. The
posting did not price a closed day on old information; it priced a day that had
not happened yet. §16's defence covers a stale belief about a finished day. It
does not cover a guess about an unfinished one.

So the difference between the two is not the amount. It is that one is a
*decision the ledger is entitled to stand behind* and the other is a *wrong
input*, and an append-only ledger has exactly one remedy for a wrong input.

The amount happens to make the point anyway. Entry
`47ad3ebe-1b69-4c6d-9c9a-bdb25d0fbf0a` pays Holds Integration Fixture Co. 498¢
of **credit** interest out of `5400` for a business date that account closed
**$858,941.45 overdrawn**. At the 1800 bps overdraft rate on the same card, that
date is worth **$423.59 charged to `4400`** at booking watermark 5859 — the
other side of the book. (That figure is still moving; §21.6.)

A customer was paid, for a day on which they owed. A label on that is a label on
a wrong payment, not a correction of one.

## 21.3 Why the correction is not a second `interest_day`, and what it is instead

The obvious shape is a second claim on the same (enrolment, date) with a later
watermark. **That is the one thing that must not happen.** `interest_day_once`
is not an obstacle in front of the correction; it is the exactly-once guarantee
the entire tick rests on, and it is the property that *made this defect
detectable*. A model that permits a second claim to fix a bad first one permits
a second claim, full stop — and then "the tick priced this day twice" and "an
operator repaired this day" are the same row shape.

> **A correction that cannot be expressed in the existing model is a reason to
> think harder, not to reach around the model.**

Thinking harder gives this: **the adjustment is not the same kind of fact as the
day.** `interest_day` claims *"this enrolment's 11 September has been decided"*
— and that claim is true, and stays true. It **was** decided. Wrongly. The
adjustment claims something else entirely: *"the decision recorded for that day
priced a balance that was not that date's closing balance, and at watermark W
the date was worth this instead."*

Two different sentences about one day. Two claim spaces. `interest_day`'s
uniqueness is untouched, and `interest_adjustment` (`db/migrations/0049_interest_basis_watermark.sql`
§3) is exactly-once in its own right on `(interest_day_id, repriced_at_seq)`,
with the generated key §19 named without building:

```
interest-adj:<enrolment>:<date>:<watermark>
```

**The money is the journal's own correction machinery and not a second one.**
0001 already has `entry_type` (`original`, `reversal`, `rebook`),
`reverses_entry_id`, `correction_group_id`, a unique index making an entry
reversible at most once, and `assert_reversal_is_exact()` forcing a reversal to
carry the **original's value date** and be its exact arithmetic negation account
by account. That is the brief's bitemporal correction test, already enforced.
`interest_adjustment` moves no money; it records why those entries exist and
holds the corrected decision to the same arithmetic as the wrong one.

**A reversal plus a re-book, not one netting entry.** A single net entry for
Holds Integration would be arithmetically equivalent and would hide the two
facts a reader needs: 498¢ of credit interest paid and taken back, and ~$423.59
of overdraft interest charged. Those land on **different accounts**, `5400` and
`4400`. A netted entry would have to pick one, which is the error `4300`'s own
note forbids — netting variance into an account makes a spread look like a
price.

## 21.4 The order of operations, which is the whole of the arithmetic

The corrected basis must be *"what the date closed at as if the wrong entry had
never happened"*. Naively that needs hand arithmetic — read the balance, subtract
the wrong entry's effect — and hand arithmetic outside `ledger_settled_cents()`
is a fifth private definition of the balance, which is the drift 0022 spent a
pass undoing.

It is not needed. **Post the reversal first, then read the watermark.**

```
   original  (wrong)      seq 2266    value date D
   reversal               seq W-1     value date D     exact negation, by trigger
   read watermark W                                    both are inside it
   basis := ledger_settled_cents(account, D, W)        they CANCEL, account by account
   re-book                seq W+1     value date D     outside its own basis
```

Because `assert_reversal_is_exact()` guarantees the negation, the pair sums to
zero on every account, so the balance the ledger's own function returns at `W`
**is** the closing balance with the wrong entry removed. No subtraction is
written anywhere. And the re-book is booked *after* `W` is read, so it is
outside its own basis — precisely the arrangement `basisAt()` makes for an
ordinary day, for the same reason.

`repriced_at_seq` is stored and the trigger refuses any row where it is *below*
the reversal's booking sequence, because a basis read before the reversal still
carries the money it is replacing.

## 21.5 The correction stores no balance, and the guard is why

The first draft of `interest_adjustment` copied `interest_posting`'s shape:
basis, numerator, denominator, quotient, remainder, rounding, amount, with all
eight relations re-derived in a `CHECK`. It was written, applied to this
database, and removed, because `scripts/dbcheck.mjs` failed on it immediately:

```
FAIL  no stored balance column — interest_adjustment.basis_balance_cents
      42 passed, 5 failed
```

Check 5's exemption list is *"a `(table, column)` **pair**, never a pattern"*
(§16.1), and the one interest exemption it grants is paid for by check 5b
recomputing every stored basis from the journal. **A second table claiming the
same exemption needs a second 5b, and a new money table whose first act is to
widen the ledger's own anti-drift check is the wrong trade.** The guard was
right and the first design was wrong; 0049 was rolled back — zero rows were at
stake — and re-applied without it.

So the adjustment stores **`repriced_at_seq` and nothing else about the
balance** — and nothing derived from it either, not even the numerator, which is
the balance times the rate wearing a hat. The basis is

```
ledger_settled_cents(account, accrual_date, repriced_at_seq)
```

frozen for all time because `booking_seq` is monotonic and the journal is
append-only. **That is §16.1's own reproducibility argument arriving at the
stronger conclusion: if the number re-derives from immutable rows, do not keep a
copy of it.**

The price is that the eight relations cannot be a `CHECK` here — a `CHECK` may
not read another table and the operand lives in the journal. They are re-derived
by `assert_interest_adjustment()` at insert, and then asked **again of the live
book on every read** by `v_interest_adjustment` and `v_interest_adjustment_drift`.
A `CHECK` fires once; a drift view re-asks for ever.

## 21.6 The one thing the calendar will not allow today

**All five mispriced days are value-dated 2026-09-11, which is today.**

The re-book prices the balance the date actually closed at. That date has not
closed. Any figure read now is a mid-day figure — *which is the defect, committed
a second time, deliberately, by the repair*. This is not a theoretical worry:

| business | at watermark 5568 | at watermark 5859, hours later |
| --- | ---: | ---: |
| Hold Fuzzer Fixture Co. | $534,030.87 | **$527,828.87** |
| Kettle & Crumb Bakery LLC | $45,866.63 | **$45,301.36** |
| Ridgeline Robotics, Inc. | $58,638.31 | **$58,346.31** |
| Holds Integration Fixture Co. | −$858,941.45 | −$858,941.45 |
| Pots Integration Fixture Co. | $25,000.92 | $25,000.92 |

Three of the five had already moved, in both directions, within one afternoon. A
correction computed from any of those numbers is a second wrong number with a
better story.

So **the rule the fix enforces is applied to the fix itself**:

- `interest_adjustment_after_close` — `CHECK (adjusted_on_book_date >
  accrual_date)`, a real constraint over two columns of the adjustment's own
  row, with `adjusted_on_book_date` assigned by the trigger and not by the
  caller.
- `assert_interest_adjustment()` raises the same refusal with a sentence.
- `adjustOneMispricedDay()` asks in TypeScript first, so the operator gets the
  sentence and no reversal is posted for a correction that cannot complete.
- `v_interest_mispriced_uncorrected` is gated on `accrual_date <
  book_date(now())`, so the queue is **empty until midnight**.

`scripts/repair-0049-mispriced-interest.mjs` run at 11:00 on 2026-09-11 prints
all five, marks every one `HELD — the date has not closed`, flags the one where
`** SIDE FLIPS **`, and posts nothing. **The first run after 00:00
America/New_York corrects all five at value date 2026-09-11.**

**That zero is not health, and the code says so in as many words.** §20.5 made
the same point about `v_accrual_month_drift` — *"green because there is nothing
to be green about"* — and the same honesty is owed here: the queue is empty
because of the calendar, not because the work is done.

## 21.7 The defect, made unrepresentable — three layers, only one a convention

| | Layer | What survives without it |
| --- | --- | --- |
| 1 | `interestPricingHorizon()` — the interest leg's window ends at `book_date(now()) − 1`; a tick asked for today is **held**, reports `pricedThrough` and `openDateHeld`, and takes today after midnight | delete it and layers 2 and 3 still hold |
| 2 | **`assert_interest_posting()` refuses a posting whose day has not closed**, and assigns `interest_posting.basis_book_date` itself | the product cannot express the defect at all |
| 3 | `v_interest_priced_before_close` — the question asked of the whole book on every read, with the priced-at figures beside the recomputed closed-at ones | it would report a sixth |

**`basis_book_date` is the column §20 asked for.** `observed_booking_seq` already
records *where in the ledger* the basis was read; what it could not say is
*whether the date had ended when it was read* — a watermark is a position in a
total order, not a wall clock, and `2266` does not visibly mean "00:21 on the
morning of the day being priced". It is **nullable on purpose**: rows written
before 0049 get `NULL` rather than a backfilled `book_date(now())`, because that
value would be a fabrication about a past event — 0047 §1's rule. The marker view
answers the question for those rows from `interest_day.claimed_at` in book time
instead, with `COALESCE` and not a filter: a predicate that excluded the rows
written before the guard existed would hide precisely the rows the guard was
written for.

**Why the guard is on the POSTING and not on the CLAIM.** Two reasons, and the
second decided it:

1. The posting is where the **basis** is. A claim is a date and a schedule; it
   prices nothing. The sentence that must be unrepresentable — *"a basis read
   from an open day"* — is about the posting row.
2. `scripts/dbcheck.mjs --prove` reaches the `v_interest_ledger_drift` failure
   state by inserting an `interest_day` for `max(accrual_date) + 1` — **tomorrow,
   on this book** — with `interest_posting_lifecycle` deliberately disabled. A
   guard on the claim would have refused that insert and silently removed a
   prover, leaving `--prove` a check short with nothing saying so. A guard on the
   posting sits inside the trigger the prover already turns off, on purpose, for
   a reason it already states. **The guard keeps its teeth against the product
   and takes none away from the proof.**

**The fee leg is deliberately ungated, and that asymmetry is the point.** A
platform fee is `F`, `N` and `d` — a price, a calendar and an ordinal. It reads
no balance, so an open day cannot make it wrong, and delaying a correct number
buys nothing. The leg that reads a balance waits for the balance to exist; the
leg that does not, does not. Both are in one tick, `/api/cron/accrual`, and the
route now says so in its own comments (§20.5's last open item).

## 21.8 Proof, on this database, with the ids

**The horizon, asked directly.**

```
interestPricingHorizon('2026-09-11')  ->  { horizon: '2026-09-10', openDateHeld: true  }
interestPricingHorizon('2026-09-10')  ->  { horizon: '2026-09-10', openDateHeld: false }
interestPricingHorizon('2026-09-12')  ->  { horizon: '2026-09-10', openDateHeld: true  }
```

**The fee leg, unheld, on the live book.** Tick `audit-tick-e` ran at 10:13
America/New_York on 2026-09-11 with `bookDate = 2026-09-11` and claimed an
`accrual_day` for **2026-09-11**, posting 83¢ —
`aeb0d32d-fc68-4f67-b9bd-f8b03925693b`, key `accrual:fcaa98c2-…:2026-09-11`,
value date 2026-09-11, seq 5671. So the fee leg does price an open date, today,
through the same `bookDate` the interest leg holds back.

That entry is evidence for the fee half only: every `interest_day` for
2026-09-11 was *already* claimed by 00:21, so that tick's interest leg would
have found nothing to do with or without the horizon. The interest half is
carried by the three direct calls above, by `listInterestDue()` being handed the
horizon rather than the book date, by the integration suite's assertion that a
tick asked for today names no day later than yesterday, and — the layer that
does not depend on any of them — by the database refusal below.

**Layer 2, made to fail, in rolled-back transactions on a real enrolment:**

```
price 2026-09-11 (today)      -> REFUSED  "refusing to price 2026-09-11 on 2026-09-11: the
                                           basis is the settled balance at the END of a
                                           business date, and 2026-09-11 has not closed…"
price 2026-09-12 (tomorrow)   -> REFUSED  same refusal
price 2026-09-10 (closed)     -> ACCEPTED  basis_book_date 2026-09-11
```

The third line is the one that matters as much as the first two: a guard that
refuses everything is also "working".

**The repair, end to end, against the live database, rolled back.** Everything
on this book was already caught up and a repair with nothing to do proves
nothing — so a day with the *exact shape of the five*, including the sign flip,
was constructed inside one transaction on the `Live Fire — attack 3` fixture
leaf and the production module was run against it:

```
  priced   $4,006.00 @wm 5859   ->    14c credit        (a true answer to the wrong question)
  closes  -$895,993.86          ->  44186c overdraft    date_has_closed true
  v_interest_mispriced_uncorrected sees it: YES

  adjustOneMispricedDay()  ->  adjusted
     reversal  d6e742d2-3d4a-4eb0-a6c4-cc08d3dbd224
     rebook    e43dbdf2-f14c-4464-b303-e8fbda7c0f5e
     claim     3bef402b-…   interest-adj:768e8c22-…:2026-09-10:5920
     14c credit -> 44186c overdraft on -$895,994.00 @wm 5920

  the correction group, as the journal holds it:
     2026-09-10  original  5400              14
     2026-09-10  original  2100/fixture     -14
     2026-09-10  reversal  5400             -14
     2026-09-10  reversal  2100/fixture      14
     2026-09-10  rebook    4400          -44186
     2026-09-10  rebook    2100/fixture   44186

  replay  ->  replayed, "this day has already been adjusted; nothing posted"
              interest_adjustment rows for this day: 1

  v_interest_adjustment_drift 0   v_interest_ledger_drift 0   v_interest_rate_drift 0
  v_book_not_zero 0   v_entry_unbalanced 0   still queued 0
```

Three entry types, one correction group, **all six lines at the original value
date**, and the side crossing `5400` → `4400`. Then `ROLLBACK`: the book's
watermark was 5859 before and 5859 after, and `interest_adjustment` holds zero
rows.

**`v_interest_adjustment_drift`, made to fail** in the same transaction:
`0 → 1` after a row one cent out was written with
`interest_adjustment_lifecycle` disabled on the owner connection. It is a view
and not a `dbcheck` line because `scripts/dbcheck.mjs` is outside 0049's edit
surface; `scripts/repair-0049-mispriced-interest.mjs` asserts it on every run
and exits non-zero if it is not empty.

**Two bugs the proof found that no amount of reading would have.**

- `reverseAndRebook(args, tx)` throws `tx.begin is not a function`. postgres.js
  3.4 puts `begin` on the pool only; a transaction scope gets `savepoint`. The
  alternatives were to run the reversal in its own transaction — a crash between
  it and the re-book leaves a day whose interest has been taken back and not
  replaced, a *third* wrong number — or to stop calling the one correction
  primitive in this system and write a second negation. Neither. The same shim
  `src/lib/ledger/ledger.integration.test.ts` already carries, with the same
  note, now lives in `interest-adjust.ts`.
- The `interest_adjustment` design that failed `dbcheck`, §21.5.

**`scripts/dbcheck.mjs`** reads **42 passed / 4 failed** — the same four
deliberate ones — and **`--prove` covers 30 of 30 invariant views (37 proofs)**,
unchanged by 0049.

## 21.9 The screen, and the claim it used to make

§12 and the deployed tile said *"no deposit account has been in debit"* while
`v_overdrawn_accounts` returned one row at $858,941.45. `OverdraftMeasurement`'s
third branch is now the one that renders, verified by rendering
`InterestSection` against the live read rather than by reading the JSX:

```
INVARIANTS  {"ledgerDrift":0,"rateDrift":0,"unresolved":0,"gap":0,
             "overdrawnAccounts":1,"overdrawnDaysInWindow":1,"overdrawnCents":85894145,
             "pricedBeforeClose":5,"pricedBeforeCloseCents":2520,
             "mispricedUncorrected":0,"adjustments":0,"adjustmentDrift":0}

tile   "Charged on overdrafts  $0.00 — nothing yet, and 1 account is overdrawn
        right now; read the measurement below"
panel  "An account IS overdrawn — and 4400 still has no rows. Both, with the reason."
```

The string *"no deposit account has been in debit"* does not appear in the
rendered output. The panel now also says what is being done: the correction is
by append, the queue holds `mispricedUncorrected`, `interest_adjustment` holds
`adjustments`, and the queue is zero **because the dates have not closed**, not
because there is nothing to do.

## 21.10 What is still open

- **The five days are not yet corrected.** They are marked, queued, and the path
  is proven — on a constructed day with their exact shape, not on them. The run
  after midnight America/New_York is what finishes it, and until then this
  section is a plan with a proof rather than a completed repair. Saying that is
  better than implying otherwise.
- **`v_interest_mispriced_uncorrected` is not in `scripts/dbcheck.mjs`.** Partly
  because that file is outside this change's edit surface, and partly because it
  is a **work queue, not an invariant** — a queue that fails the build the moment
  a real defect is found trains people to silence it. When the five are corrected
  and it is structurally empty, it can be listed, and it will have been made to
  fail by the book rather than by a fixture.
- **`v_interest_adjustment_drift` is not in `INVARIANT_VIEWS` either**, for the
  edit-surface reason alone. It is an invariant, it has been made to fail, and it
  belongs there in the pass that can write that file.
- **The adjustment path has no vitest integration test.** It cannot live in the
  app-role suite: constructing a day with the defect's shape needs
  `interest_posting_lifecycle` disabled, which requires the owner connection. The
  proof is `scripts/repair-0049-mispriced-interest.mjs` plus the rolled-back
  owner-connection run recorded in §21.8.
- **The backward case is still open.** §16 and §19's real subject — a correction
  backdated into a day that was priced correctly at the end of that day — is
  untouched. 0049 fixes the *forward* case, pricing a day too early. A genuine
  re-price after a backdated correction would be a second `interest_adjustment`
  at a later watermark, which the table permits by design and which no code path
  yet creates.
- **No cron entry still.** `/api/cron/accrual` is authenticated and nothing
  schedules it, inherited from §10 and §19 and unchanged. The horizon makes this
  worse in one specific way worth naming: a tick that runs once a day now prices
  *yesterday*, so a day of interest is at most two ticks behind the book rather
  than one.
