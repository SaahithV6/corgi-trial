# Standing orders

> **Standing orders.** Scheduled payments that fire once and only once across
> restarts and retries, with a written policy for the day the balance cannot
> cover them.
>
> — the brief, gauntlet item 8

Two claims, and this document defends both. The first is a property of the
schema. The second is a decision, and decisions have alternatives that were
rejected for reasons, so the reasons are written down.

Everything below was measured against the live Neon database on 2026‑09‑10. The
ids are real; you can look them up.

---

## 1. The shape

| Thing | Where |
| --- | --- |
| Schema, constraints, triggers, views | `db/migrations/0012_standing_orders.sql` |
| The calendar (the ONLY definition of when a mandate is due) | `standing_order_due_dates()`, in that migration |
| Pure rules — the funding decision, the freshness decision | `src/lib/standing/types.ts` |
| Every SQL statement standing orders issue | `src/lib/standing/store.ts` |
| The firing routine | `src/lib/standing/fire.ts` |
| The screen's read path | `src/lib/standing/screen.ts` |
| The screen | `/standing-orders` |
| The tick | `POST /api/cron/standing` |
| The proof | `src/lib/standing/standing.integration.test.ts` |

Four tables, all append-only:

```
standing_order                 the mandate. mandate_key UNIQUE, derived from the
                               thing that authorised it (a lease id, a signed
                               form) — never a generated uuid.

standing_order_cancellation    PRIMARY KEY (standing_order_id). One row, once,
                               and no UPDATE to undo it with. Same construction
                               as hold_closure.

standing_order_occurrence      THE UNIT. One (standing order, scheduled date)
                               pair. UNIQUE (standing_order_id, scheduled_date)
                               plus a GENERATED ALWAYS idempotency_key.

standing_order_outcome         PRIMARY KEY (occurrence_id). Raised or refused,
                               with the four balances as observed.
```

`corgi_app` holds `SELECT, INSERT` and nothing else on all four, with an
explicit `REVOKE UPDATE, DELETE, TRUNCATE` and 0001's `ledger_row_is_immutable()`
trigger as a second layer that also binds the table owner. These are not money
rows — no journal line is written by anything in this feature — but they are the
*audit* of money movement, and an audit trail you can `UPDATE` is a story.

---

## 2. Fires once, and only once

### The unit is the occurrence, not the order

"Fires once" is meaningless said of a standing order: a monthly rent mandate is
*supposed* to fire twelve times a year. The thing that must happen at most once
is one **(standing order, scheduled date)** pair. So that pair is a row, and it
carries the constraint:

```sql
CONSTRAINT standing_order_occurrence_once UNIQUE (standing_order_id, scheduled_date)
```

### The key is derived by the database

```sql
idempotency_key text GENERATED ALWAYS AS (
  'standing:' || standing_order_id::text || ':'
    || lpad(EXTRACT(YEAR  FROM scheduled_date)::int::text, 4, '0') || '-'
    || lpad(EXTRACT(MONTH FROM scheduled_date)::int::text, 2, '0') || '-'
    || lpad(EXTRACT(DAY   FROM scheduled_date)::int::text, 2, '0')
) STORED
```

DECISIONS' rule is that an idempotency key comes from **source facts**, never
from a uuid we generated. `standing:<order>:<date>` is exactly that — but if the
*application* computed it, the application could compute it wrong, and a wrong
key is a second payment. So Postgres computes it. There is no argument for a
caller to get wrong.

The date is spelled out with `EXTRACT` and `lpad` rather than `to_char` because
a generated column's expression must be `IMMUTABLE`, and every textual rendering
of a date — `to_char()`, `date::text`, `format()` — is only `STABLE`: `DateStyle`
is a session setting that changes the answer. An idempotency key whose value
depends on a session GUC is a key that silently becomes a different key, which
is the precise shape of a double payment.

That string is handed to `requestPayment()`, where
`payment_instruction.idempotency_key` is itself `UNIQUE` (0001 §12). **A double
fire is refused by a unique index in Postgres, twice, on two different tables.**

### At-most-once claiming, at-least-once idempotent effect

The same construction the webhook drain uses, because it is the same problem.

Each occurrence is processed inside one transaction that opens by taking

```sql
SELECT lock_standing_order(:id)   -- SELECT … FOR UPDATE, SECURITY DEFINER
```

`corgi_app` holds no `UPDATE` on `standing_order` and must not, so it cannot
write `FOR UPDATE` itself; the definer function can do nothing except take that
one lock on that one table. This is exactly 0008's construction for card
authorisations.

**The lock is not what makes this safe.** A lock is a liveness device that a
crashed process releases; a unique index is a safety device that a crashed
process cannot. The lock stops two concurrent ticks doing the same work twice;
the constraints stop them *paying* twice, and those are different guarantees.

`requestPayment()` opens its own transaction, so it is called on the pooled
handle rather than inside ours. That is not a wart — it is the crash-safe
ordering:

| Crash point | What survives | What the next tick does |
| --- | --- | --- |
| after the instruction commits, before our transaction does | the instruction | re-derives the same key, finds it via `instructionForKey()`, records the occurrence as `raised` citing it. **One payment.** |
| after our transaction commits | everything | nothing; the occurrence is decided and leaves the queue |
| before either | nothing | claims the date afresh |

There is no ordering in which two instructions exist, because there is no
ordering in which the key differs.

> One operational constraint this creates: the connection pool must hold more
> than `2 × concurrent ticks`, because a tick holds an open transaction while
> `requestPayment()` uses a second connection. `max: 5` in `src/lib/ledger/db.ts`
> covers the two-tick case with room to spare.

### The proof — run, live, 2026‑09‑10

`src/lib/standing/standing.integration.test.ts` creates a mandate and then
starts **two full runs of the firing routine concurrently** with `Promise.all`.
Not two sequential calls, which any `if` would survive.

```
$ set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/standing
  ✓ src/lib/standing/types.test.ts (14 tests)
  ✓ src/lib/standing/standing.integration.test.ts (10 tests) 9674ms
  Tests  24 passed (24)
```

Both runs reported doing the work:

```json
{"event":"standing.complete","runId":"test-20260910223609-A","considered":2,"raised":1,"refused":1}
{"event":"standing.complete","runId":"test-20260910223609-B","considered":2,"raised":1,"refused":1}
```

Postgres is the witness, and Postgres says one:

```
occurrence      e8cdd0cc-58b6-4199-876f-4a8a5f022d33
idempotency key standing:4249d885-2a9c-44e4-8144-6146ca785c56:2026-09-10
instructions    1                       <- SELECT count(*) FROM payment_instruction
                                           WHERE idempotency_key = <that key>
outcome rows    1   disposition = raised
instruction     9acd68f0-d6f8-4a40-91e8-4362abe56e4f   $4,000.00   approvals required: 1
```

One run raised it (`created: true`); the other found the key already taken and
recorded what Postgres already held (`replayed: true`). A third, sequential run
saw nothing at all to do: `considered: 0`.

The suite also goes straight at the constraints, bypassing the application:

- a hand-written second `INSERT` for the same `(order, date)` → refused,
  `duplicate key`;
- an `INSERT` for a date the schedule does not generate → refused by
  `assert_standing_order_occurrence()`, which calls the *same*
  `standing_order_due_dates()` the firing routine calls;
- `UPDATE` / `DELETE` on an occurrence or an outcome → `permission denied`.

And two invariant views, both empty:

```
v_standing_order_unresolved    0    claimed and never decided
v_standing_order_double_fire   0    a scheduled date naming >1 instruction
```

**The second one used to be empty for the wrong reason, and that is worth more
than the guard itself.**

The sentence that stood here said `v_standing_order_double_fire` *"cannot be
non-empty while `payment_instruction.idempotency_key` is `UNIQUE`"*, offered as a
strength — an emptiness that is a consequence of a constraint rather than of
anybody's discipline. It was the opposite. The old body joined
`payment_instruction ON pi.idempotency_key = o.idempotency_key`, a **UNIQUE**
column, and then asked for `count(DISTINCT pi.id) > 1`. At most one row can
match a UNIQUE value, so the `HAVING` was unsatisfiable: the view was
`WHERE false` with extra steps, and its emptiness was a consequence of nothing at
all. Four places in this repo quoted that emptiness as proof, this document among
them.

**Migration 0023 replaced the body.** It joins on the mandate's *keyspace* —
`'standing:<order id>:%'` — and attributes an instruction to an occurrence by the
derived key **or** by the occurrence's scheduled date. That catches the double
fire the UNIQUE index structurally cannot see: a second instruction for the same
mandate and the same date under a different *spelling* of the key. Which is
exactly what §2 of this document already argues at length — **a wrong key is a
second payment** — so the guard now checks the thing the prose beside it always
claimed it checked.

#### It has now been watched failing, and the delta is quoted

Migration 0023 recorded the demonstration as a comment
(`SELECT * FROM v_standing_order_double_fire;  -- one row, instructions = 2`).
Between that migration and 2026-09-11, **nobody ran it.** A demonstration
written into a file is a description of a measurement, not a measurement — which
is the precise mistake the paragraph above is about, so it is closed here rather
than repeated.

Run against this database, in a transaction that was rolled back:

```
before                                         0 rows
-- a second payment_instruction on the SAME occurrence, in the mandate's
-- keyspace, under a different spelling of the derived key:
--   standing:6d27bdba-c9ab-4df1-912c-cd6ff033a6b0:2026-09-11
--     ... the real one, written by the firing routine
--   standing:6d27bdba-c9ab-4df1-912c-cd6ff033a6b0:2026-9-11#retry-after-a-restart
--     ... the plant: an unpadded, DateStyle-dependent key from a retry
after                                          1 row
    standing_order_id  6d27bdba-c9ab-4df1-912c-cd6ff033a6b0
    scheduled_date     2026-09-11
    instructions       2
    instruction_keys   {both of the above}
after ROLLBACK                                 0 rows
```

The row names **both** keys, which is the whole point: the UNIQUE index on
`payment_instruction.idempotency_key` is perfectly satisfied by that pair, so
the constraint the old body leaned on is exactly the one that cannot see this
failure.

It is no longer a one-off. `node scripts/dbcheck.mjs --prove` builds that state
on every run, asserts the count moves `0 -> 1`, and then re-reads the view
outside the transaction to assert the rollback left nothing behind — alongside
the same treatment for all twenty-two invariant views on the gate's list.

**Its blind spot, stated because a guard whose limits are not written down is
back to being believed for the wrong reason:** an instruction raised *outside*
the `standing:` keyspace is indistinguishable from a legitimate manual payment,
and this view will not find it. Shape-matching on amount, payee and date was
tried as a way to close that, and it returned **five false positives** against
the live book — a customer who pays the same supplier the same amount on the same
day of the month by hand is not a double fire, and a guard that says they are is
one operators learn to ignore.

**This is instance 8 of a pattern this build has now recorded twenty-two
times**, and it was the second *view* found to be empty for the wrong reason,
after `v_hold_drift` — whose `WHERE NOT is_released AND memo <> target` excludes
a spuriously-closed hold *by construction* and therefore cannot see the exact
failure it exists to catch (`CUT-LIST.md` §3.2). The full list, with the
exclusion clause in each, is `docs/DEBRIEF.md` §1; the arithmetic that
reconciled three disagreeing counts into one is `DECISIONS.md` 058. The pattern
is the honest through-line: **a zero-row invariant proves nothing until somebody
has watched it return a row.**

That sentence is now executable rather than aspirational. `pnpm db:check` runs
the invariant views on every pass; `node scripts/dbcheck.mjs --prove` makes
**every one of them** fail on purpose in a rolled-back transaction, and coverage
is computed from the same list the gate checks, so a view added without a proof
is a named failure on the next run rather than a quiet gap.

### It does not build a second way to move money

A firing occurrence calls `requestPayment()` — the same function the console
form and the MCP write tool call. From that line onwards a scheduled rent
payment and a hand-typed one are the same row in the same table under the same
policy version, and:

- the **KYB gate** runs, inside `requestPayment()`'s transaction;
- the **approval policy in force on the value date** is cited on the row;
- the mandate's `created_by` becomes the instruction's `requested_by`, so
  `assert_maker_checker()` refuses an approval from the person who set the
  standing order up. **Nothing in `fire.ts` arranges that.** It falls out of
  using the one path.

Note what "fired" does *not* mean: money moved. A standing order raises an
instruction; a second human releases it. The $4,000 instruction above sits in
the approvals queue needing one approver, exactly as if Priya had typed it.

---

## 3. The policy for the day the balance cannot cover it

### The decision

> **Refuse the occurrence and close it.** No partial payment, no carry-forward,
> no queue. The occurrence is recorded as attempted‑and‑refused with its reason
> and the four balances as observed. The next occurrence is unaffected and comes
> round on its own date.

Implemented in `decideFunding()`, `src/lib/standing/types.ts`, in five lines.

### Checked against AVAILABLE, not the ledger

```
available = ledger − active card authorisations − uncleared credits
```

`availableBalance()` in `src/lib/ledger/balances.ts`. Why not the ledger
balance:

- **An active card authorisation is money the customer has already committed.**
  A $50 fuel-pump hold that has not settled is not spendable, even though no
  journal line has moved it. Paying rent out of it creates an overdraft the
  customer never agreed to, on the day the pump captures.
- **An uncleared credit can still be taken back.** ACH gives the originator days
  to return it. Standing orders leave on rails that are slower to recall than
  the credit is, so funding one from an uncleared deposit is lending — and this
  is a current account, not a credit facility.

The refusal stores **all four** figures, not just the verdict, so the case that
matters is on the screen: **the ledger covered it and available did not.**

### The live refusal, 2026‑09‑10

```
occurrence        f7c3a4c7-d00b-4223-b1e0-574cc3b4a2fb
mandate           Quarterly equipment settlement — Northgate Finance
idempotency key   standing:3e06bbf8-39ca-4c52-8742-7a32117a2fc5:2026-09-10
disposition       refused
code              INSUFFICIENT_AVAILABLE_FUNDS
instruction_id    NULL

amount due            $20,871.93
observed ledger       $21,081.93     <- COVERS IT
observed card holds    −$310.00
observed uncleared        $0.00
observed available    $20,771.93     <- DOES NOT
shortfall                $100.00
```

The ledger balance covered this payment by $210 and the payment was refused.
That difference is one live card authorisation on Ridgeline's account. A system
that checked the ledger balance here would have paid, and would have been wrong.

The figures are **stored as observed**, not re-derived on read. That is
deliberate and it is the same axis as `statement.closing_balance_cents`:
re-deriving them tomorrow answers a different question ("what is the balance
now") and would quietly rewrite the reason a payment was refused. They are named
`observed_*` rather than `*_balance_*` because `pnpm db:check` fails the build on
a stored balance column and is right to — these are a measurement taken once,
not a cache of anything.

### What was rejected, and why

**Partial payment — almost always wrong, and here it is simply wrong.**
A mandate says "$4,000 on the 1st". Sending $2,613.44 invents an instruction
nobody authorised. It will not match the payee's invoice, so it creates a
reconciliation break at *both* ends; the landlord's system books a short payment
and starts an arrears process anyway; and the customer is now out $2,613.44 and
still in default. A partial payment converts a clean, recoverable failure into
two messes. There are domains where partial settlement is correct — a card
network capturing less than it authorised — and a scheduled instruction to a
third party is not one of them, because the *amount* is half of what was
authorised.

**Carry forward until funded — unbounded, and it fires at 3am at a size nobody
expected.** The debit lands on a day nobody chose, possibly doubled against the
next scheduled one, possibly weeks later when the customer has forgotten it was
outstanding. The queue has no natural bound: nothing says when a carried-forward
occurrence stops being owed. This is the failure the requirement itself warns
about, and it is worse than not paying because it *moves money* unpredictably.

**Refuse and retry tomorrow — a softer version of the same problem.** It is
defensible, and it is what many banks do for direct debits (a three-day retry
window). We rejected it for this system for two reasons. It makes the value date
of the payment differ from the scheduled date, which breaks the invariant that
an occurrence's value date *is* its scheduled date — the one the outcome trigger
enforces, and the one that keeps the ledger and the calendar telling the same
story. And it produces a payment on day two that nobody is watching for, whereas
a refusal on day one produces a row on a screen and, in a real deployment, a
notification. **The customer topping the account up and the payment being
re-raised is a decision a human should make, and it takes one click.**

**Refuse and skip — what we do.** The cost is honest: a missed rent payment is a
real consequence, and this policy accepts it rather than papering over it. What
it buys is that the failure is *loud, dated, bounded and attributable*. The
occurrence exists, with a reason, on the day it was due.

### The refusal is a row, not a silence

This is the part that actually matters. "It never fired and nobody knows why" is
a **missing** row, and no amount of care makes an absence noticeable. So:

| Condition | Code | Outcome |
| --- | --- | --- |
| available < amount | `INSUFFICIENT_AVAILABLE_FUNDS` | refused, four balances + shortfall stored |
| occurrence more than 5 book days late | `STALE_OCCURRENCE` | refused, days late in the reason |
| counterparty no longer parses | `INVALID_DESTINATION` | refused |
| mandate's account belongs to no business | `UNSCOPED_ACCOUNT` | refused — a payment that cannot be funds-checked is not raised |
| KYB gate says no, schema refuses the request | the gate's own code | refused |
| `POLICY_MISSING` / `UNAVAILABLE` | — | **deferred**: claimed, undecided, visible in `v_standing_order_unresolved`, re-driven next tick |

The last row is the one exception and it is deliberate. Both conditions are
facts about the *system* rather than about the payment — a rail with no approval
policy in force is a row nobody wrote; `UNAVAILABLE` is the database going away.
Recording either as a refusal would permanently kill a real payment because of a
transient condition. So the occurrence is committed **claimed and undecided**,
which is a queryable state rather than a label, and the derived key makes the
retry free.

### Freshness is asked BEFORE funding

`STALE_AFTER_DAYS = 5`. An occurrence more than five book days late is refused
whether or not the money is there.

The ordering is load-bearing. "The scheduler was down for a fortnight and has
now woken up with fourteen days of rent to pay" is a conversation, not an
automatic debit. Asking funding first would let a well-funded account absorb the
whole backlog silently — the same 3am surprise, arriving by a different door.
Five days is long enough that a weekend plus a bank holiday plus a bad deploy
does not silently drop a payment, and short enough that anything older gets a
human.

`CATCH_UP_WINDOW_DAYS = 45` is deliberately wider. Everything between the two is
still **claimed and recorded** — as `refused / STALE_OCCURRENCE` — because the
failure mode that hurts is a missing row, not a refusal. Past 45 days a date
that was never claimed is not materialised at all; that limit is stated here
rather than left to be discovered.

An occurrence that WAS claimed and never decided is re-driven at **any** age.
A claim is a durable statement that this date is owed, and it must never age out
of the queue.

---

## 4. The calendar lives in SQL, in one place

`standing_order_due_dates(order, from, to)`. The firing routine's "what is owed
today", the screen's "next occurrence", and the trigger that validates an
occurrence insert all resolve through it. There is no month-end arithmetic in
TypeScript for it to drift from.

DECISIONS 024 is the argument. The TypeScript hold model and the SQL hold view
were held equal by an invariant, and when they disagreed on one edge case there
was no cheap fix — changing either alone turns a documentation gap into a live
drift alarm. The lesson is not "write better tests", it is "do not have two
definitions".

Month-end clamping is the case that matters and it is one line:
`LEAST(day_of_month, days-in-that-month)`. A mandate for the 31st is due on
30 April and on 28 February, not skipped. Asserted against the live database:

```
standing_order_due_dates(<order>, '2027-01-01', '2027-04-30')
  → 2027-01-31, 2027-02-28, 2027-03-31, 2027-04-30
```

Book time is `America/New_York` everywhere, including in
`v_standing_order_next` and `bookToday()`. `CURRENT_DATE` on a UTC server rolls
the schedule over five hours early every night, which quietly fires a mandate on
the wrong side of a month end.

---

## 5. The tick

`POST /api/cron/standing` (and `GET`, for a browser during a demo).

**Authentication is `/api/drain`'s, deliberately identical:** the
`x-vercel-cron` header, or `Authorization: Bearer $DRAIN_TOKEN`. One shared
operator credential for the two scheduled jobs rather than a second variable
that has to be remembered on every deploy and is a silent 401 when it is not.

The drain's endpoint could argue it was harmless if left open, because draining
is idempotent. **This one cannot make that argument and does not try.** Firing
is idempotent, but a stranger who can make a bank's scheduler run on demand can
change *when* a payment lands, and "when" is half of what a standing order is.
There is no unauthenticated path.

### Vercel Hobby caps crons at daily. Say so.

On the Hobby plan a cron fires **once a day, at an approximate time**. That is
the tightest schedule the platform runs, and this build does not imply a tighter
one anywhere. An occurrence due on the 1st is claimed by the first tick on or
after the 1st, not at midnight on it.

The design does not need a tighter schedule — the unit of work is a **date**, the
calendar is a SQL function, and a tick that runs late still claims exactly the
dates that are owed. A missed day is not a lost payment either: `listDue()` looks
back over the catch-up window, so a tick that did not run yesterday picks
yesterday up today. What a tick can never do is claim a date twice, and that is
the property being graded.

**`vercel.json` needs a `crons` entry for this route and does not have one yet.**
That file is owned by the trial lead, not by this feature; the entry to add,
beside the existing `/api/drain` one, is:

```json
{ "path": "/api/cron/standing", "schedule": "23 5 * * *" }
```

Until that lands, the tick runs on demand:

```bash
curl -X POST -H "Authorization: Bearer $DRAIN_TOKEN" https://<host>/api/cron/standing
```

---

## 6. The screen

`/standing-orders`. Five states, all reachable from the query string:

| URL | State |
| --- | --- |
| `/standing-orders` | **live** — mandates, next occurrence, and every occurrence they produced |
| `?state=loading` | the real skeleton, held open by a genuinely slow read |
| `?state=empty` | no mandate set up; an honest blank |
| `?state=error` | the query failed; nothing fired, retry is live |
| `?state=edge` | **an occurrence refused for insufficient AVAILABLE balance while the LEDGER balance covered it** |

Plus `?order=<uuid>` to filter to one mandate and `?occurrence=<uuid>` to drill
into one decision, both URL state and both deep-linkable.

`default` is the only state that reads the database — that is where the real
refusal above lives, and a fixture would answer the graded question by
construction. The other four are fixtures even when a database is configured, so
they can be shown in order in front of a panel **without firing a payment**. The
edge state is a fixture for a reason worth stating plainly: reproducing it on
demand requires the account's ledger balance to sit above the amount and its
available balance below, which is a transient condition of somebody else's card
holds. The same shape exists in the live history as the real refused row.

The screen never writes. Firing is a cron and an authenticated POST; a render is
not an operator action, and a page that raised a payment because somebody hit
reload would be the worst bug in this repository.

**Navigation:** `/standing-orders` is not yet in `NavLinks.tsx`, which is owned
by the trial lead. It needs one entry, between Approvals and Reconciliation.

---

## 7. What this feature does not do

Stated rather than left to be discovered.

- **No console form to create or cancel a mandate.** `createStandingOrder()` and
  `cancelStandingOrder()` exist and are exercised by the integration suite, but
  the screen is read-only. A mandate is a standing authority to move money with
  nobody watching; putting its creation behind the same maker-checker treatment
  as a payment is the right next step and is not built.
- **No notification on refusal.** The refusal is a row and it is on a screen.
  In a real deployment it would also be an email to the account owner and a
  webhook; there is no delivery channel in this build to hang that on.
- **No retry-tomorrow option per mandate.** The policy is one policy, applied to
  every mandate. A per-mandate `on_insufficient_funds` column is an obvious
  extension and was deliberately not built, because one policy that is written
  down beats a column with three values and no document.
- **No business-day awareness.** A mandate due on a Saturday fires on the
  Saturday; the ACH rail's own effective-date handling decides when it lands.
  Moving the *scheduled* date for weekends and Federal holidays would mean a
  holiday calendar in the database, and a half-populated holiday calendar is
  worse than none.
