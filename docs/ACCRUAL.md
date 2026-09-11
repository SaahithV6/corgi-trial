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
| Overdraft interest on negative balances | an interest *income* account — **does not exist** | not built, §7 |
| Interest paid on credit balances | an interest *expense* account — **does not exist** | not built, §7 |

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

## 7. The accounts that are missing, named exactly

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
- **One product.** Overdraft interest and credit interest are designed for
  (§7) and not built, because the accounts they need do not exist and
  inventing one silently would have been the worse mistake.
- **No mid-month price change on the live book.** `accrual_schedule` is
  effective-dated and `accrual_schedule_no_overlap` enforces one live price per
  account per product, so a price change is a new row — but nothing has
  exercised that path yet, and the interesting question it raises (does the
  month's allocation restart, or does the customer pay a pro-rata of each
  price?) is answered by the schema, not by a decision anyone has written down.
