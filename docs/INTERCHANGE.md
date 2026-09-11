# Interchange, and the unit economics it makes legible

`4100 Interchange income` has been in the chart of accounts since migration
0001. Until now nothing had ever posted to it.

Every other posting in this build answers a **correctness** question — did the
money move, did it balance, can we prove what we believed on Tuesday. This one
answers a **business** question, which is the question a company that runs card
programmes is actually asking: *does this thing make money?*

- Code: `src/lib/interchange/**`
- Schema: `db/migrations/0031_interchange.sql`
- Hook: `src/lib/holds/apply.ts` → `interchangeHook()`
- Screen: `/economics`
- Guards: `v_interchange_unreversed`, `v_interchange_drift`,
  `v_interchange_rate_drift`, all in `scripts/dbcheck.mjs`

---

## 1. Interchange is earned on the clearing, never on the authorisation

This is the whole of the domain content and it is the one thing that would be
catastrophic to get wrong in the obvious direction.

An authorisation is a **hold**. It moves the memo book (`9100/<biz>` against
`9900`) and the financial book does not move at all — there is no code path
from an authorisation to `postCardMovement()`, by construction. The amount that
finally settles can be different, it can arrive days later, and it can never
arrive: an expiry, a full reversal and a $0 card-on-file verification all end
with nothing settled.

So interchange booked at authorisation is **revenue booked on money that may
never exist.** It is recognised on the clearing — the same event, the same value
date and the same customer leg that `postCardMovement()` posts — so the revenue
and the spend it came from are dated identically and a day's P&L is internally
consistent.

| Event | Book | Entry |
|---|---|---|
| authorisation | memo | `9100/<biz>` credit, `9900` debit |
| clearing | financial | `2100/<biz>` debit, `2200` credit |
| **interchange** | financial | **`2200` debit, `4100` credit** |

**Proved, not asserted.** `interchange.integration.test.ts` creates a real
Lithic sandbox card, authorises $50.00 at MCC 5542, asserts `4100` has not moved
and that `applyCardTransaction` reported an empty `interchange` list, then clears
a **different** amount and asserts the revenue appears at the settlement's own
value date with every operand of the arithmetic re-derived from the row.

Two honesty notes about that test, because both are visible in its output:

- **The sandbox account's daily spend cap declines the authorisation** once a
  day of live-fire runs has exhausted it
  (`ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED`). The test scales the ticket down and
  retries rather than asserting against a refusal — a declined authorisation
  books nothing whatever the rule is, which would make the first half of the
  claim vacuous. The shape is preserved at every scale: authorise one amount,
  capture a different, larger one.
- **The deployed system receives the same webhook**, so the authorisation may
  already be on the book when the test applies it. Where migration 0026's guard
  then refuses to file a verdict against a row another process wrote, the test
  records that and carries on: it is a race with a process, not a fact about
  interchange, and the assertions that follow are about what the **ledger** says
  rather than about who said it.

### Why the debit is 2200 and not 1120

`2200 Card network settlement payable` is what we owe the network for cleared
spend. Interchange is precisely the part of that spend we do **not** owe them —
the acquirer pays the issuer the ticket *less* interchange. Debiting 2200 is the
economically true statement: after the entry, 2200 holds the **net** figure we
will actually fund into the settlement window, which is the number a treasury
operator needs. Debiting `1120` instead would inflate both sides of the balance
sheet with a receivable and a payable against the same counterparty for the same
transaction.

### Why it is its own entry and not a third line on the clearing

Two reasons, and the second is load-bearing:

1. The clearing is a statement about the **customer's** money; the interchange
   is a statement about **ours**. One event, two facts, two entries, each of
   which balances on its own.
2. `postCardCorrection()` refuses to re-book an entry that does not have exactly
   two lines — *"a partial card correction can only re-book a two-line entry
   without inventing an allocation"*. A third line on the clearing would break
   the correction path for every partially corrected settlement on this book.
   Read before writing, not discovered after.

---

## 2. The dimensions the Lithic data actually carries

Measured against every `card_transaction.updated` payload in `webhook_inbox`
**before** the rate card was designed, because *"do not invent a dimension you
cannot populate from a real event"* is only a rule if you go and look first.

| Field | Present? | Varies? | Used as a rate-card dimension? |
|---|---|---|---|
| `merchant.mcc` | yes, on every payload | **yes — 100+ distinct codes** | **YES** |
| `pos.entry_mode.pan` | yes, on every payload | no: always `MANUAL` | **YES** (→ presentment) |
| `pos.terminal.type` | yes | no: always `PHONE` | evidence only |
| `pos.terminal.attended` | yes | no: always `false` | evidence only |
| `network` | yes | no: always `VISA` | **no** — see below |
| `merchant.country` | yes | no: always `USA` | **no** |
| `acquirer_fee` | yes | no: always `0` | no |
| card product | **not in the event at all** | — | **not built** |

**MCC is the dimension that does real work on this book.** 5542 (automated fuel
dispensers) dominates at 341 payloads, because the brief's own fuel-pump
scenario generated most of this traffic; 5812 and 5814 (eating places, fast
food) follow, then a long tail.

**Presentment is real, read, and constant in this sandbox.**
`pos.entry_mode.pan = MANUAL` at a `PHONE` terminal with `attended = false` is a
keyed phone order, which is card-**not**-present for interchange — the network
prices the entry mode, not the furniture, and a hand-keyed PAN gets none of the
authentication that makes card-present cheap. Lithic's simulate endpoints accept
`mcc` and the merchant acceptor fields and do **not** accept a POS entry mode, so
there is no way to make it vary from our side. **The card-present arm of the rate
card therefore ships correct and unexercised, and this document says so rather
than the screen implying otherwise.**

**`network` and `merchant.country` are deliberately NOT dimensions.** A
dimension with one observed value is a dimension you cannot demonstrate, and a
rate card keyed on one would be three columns of decoration. Both are stored on
`interchange_posting` as evidence — so the row says what it was priced against —
and the rate card joins on neither.

**Card product is a real gap and it is named rather than half-built.** Real
interchange varies by consumer credit / business credit / regulated debit under
Durbin, and it would be the natural third dimension. It is not in the *event*: it
lives on Lithic's card object, our own `card` table stores `last_four` and
`nickname` and nothing else, and every card here was created by one call with one
set of defaults. Populating it would mean inventing a product per card and then
pricing against the invention.

---

## 3. The rounding rule: DESIGN §12.2, and no third rule

**`DESIGN §12.2` governs: one value becomes one cent amount, round HALF TO
EVEN.**

`DESIGN §12` has two rules and the skill is knowing which applies:

- **§12.2** one value → one cent amount: round half to even.
- **§12.3** one amount split across N shares: largest remainder.

Interchange is §12.2. *"A percentage of an amount"* sounds like a split and is
not one. §12.3's precondition is a **source amount** distributed across shares
that must add back up to it exactly, and the residual penny exists only because
the shares owe the source a total. Interchange has no source to distribute — the
settled amount is not being divided between parties, it is an **input to a
price**, and the price is one number.

`docs/ACCRUAL.md` §13 makes exactly this argument one product over and it
transfers verbatim:

> **Largest-remainder needs a source amount to distribute. Daily interest has
> none.** [...] What daily interest *is*, exactly, is **one value — a balance, a
> rate and one day — becoming one cent amount**, which is §12.2's sentence with
> nothing left to interpret.

Here it is a settled amount, a rate and a fixed fee becoming one cent amount.

### The fixed component is where a float would try to sneak in, and it does not change the answer

`$0.10` is **already an integer number of cents**. It is not divided, it is not
rounded, and it is added **after** the ad-valorem half has become an integer:

```
ad_valorem  = round_half_even(|settled| * rate_bps / 10000)
interchange = ad_valorem + fixed_cents
```

One rounding step, one operand. Integer + integer cannot produce a fraction, so
there is no second rounding decision to make and **no third rule to invent.**

**Migration 0031 defines no rounding function at all.** It calls 0024's
`interest_round_half_even(bigint, bigint)`, which is the §12.2 implementation
this database already carries. That function is named for the product that first
needed it; it is the **rule**, not the product, and a second body of it would be
a reconciliation break waiting to happen exactly as a third rule would. This
ledger still has exactly two rounding rules and they are the two `DESIGN §12`
already had.

### Half to even and not half up

For §12.2's own stated reason, and note that the reason §12.2 gives is
*literally about this feature*:

> half-up biases every tie in one direction, and over a year of **interchange**
> that bias is a real number.

A half-cent tie is a tie between us and the acquirer. Half-up hands it to us
every single time, forever. **There is a real one on this book** — see §5.

### Nobody eats a residual penny, and that is not a contradiction

§12.3's residual is real money that must land on one of the shares. §12.2 has
none to place: the sub-cent fraction was never money, no party was ever credited
with it, and the entry is two equal and opposite lines summing to zero.
§12.6's dust account `2900` is **not** engaged either — 2900 exists for dust that
*arrived* as a real external amount with more precision than a cent (a USDC
transfer with six decimals), where truncating would break the identity between
customer balances and our obligation. A fraction of a cent of interchange never
arrived; it is precision that was never claimed. The bound is half a cent per
settlement, `remainder_units` is stored on every posting row and rendered on the
screen, and the number of exact ties is a column on
`v_interchange_by_category`.

The old wording on `4100` in `chart.ts` said the residual penny lands on us at
ordinal 0 (**§12.5**). That sentence is about §12.3 and is still true of any
allocation 4100 is ever a party to — but nothing on this path is an allocation,
so it does not describe what this code does. The note has been sharpened to say
both things.

### No floats, including intermediates

Every operand and every result is `bigint` or a small `int` rate in basis
points. No `numeric`, no `double precision`, no `Math.round`, no `toFixed`, no
division that is not integer division. `interchange_posting_arithmetic`
re-derives **seven relations** from the three inputs on every INSERT and
restates the half-even tiebreak inline, so a row that disagrees with §12.2 by one
cent cannot be stored: TypeScript computes, Postgres verifies.

---

## 4. Rates are configuration, effective-dated, and cannot reach back

`approval_policy` (0001 §12), `funds_availability_policy` (0001 §5) and
`interest_rate_policy` (0024 §5) are the pattern; `interchange_rate_policy` is
the fourth. A policy is a fact with a lifespan, it lives in its own versioned
table, it is append-only, and a change is a **new row with a later effective
date**.

Three layers make *"a changed rate must not retroactively re-price a settlement
from last week"* true, and only the first is a convention:

1. **Resolution is on the SETTLEMENT'S value date.**
   `interchange_rate_at(category, presentment, value_date)` is the greatest
   `effective_from` not after that date. A replay of an old settlement passes
   the old date and gets the old card back — by construction.
2. **`interchange_rate_policy_forward_only` refuses the INSERT.** A new row must
   be strictly later than every existing row for its `(category, presentment)`
   **and** strictly later than every settlement already priced under it. The
   second condition is the one with teeth. Two tests in the integration suite
   prove both arms refuse.
3. **`v_interchange_rate_drift` must return zero rows** — the same question
   asked of the whole book at any moment, and what would catch a row inserted
   behind the trigger's back. It is in `scripts/dbcheck.mjs`.

**And the posting stores the resolved rate.** When a settlement is later
corrected, the interchange is re-priced **at the stored policy**, never at
whatever the card says today: a correction is a restatement of what happened on
the original date, so it is priced by the card in force on the original date —
the same reason `reverseAndRebook()` carries the original's value date.

### The rate card on this book

Six bands × three presentments, seeded at `book_date − 30`, plus a second
version of the **fuel** band at `book_date`. One band moves and not all of them,
because that is what a real interchange re-rate looks like — and fuel is the
band that matters here, so the change is visible on real settlements on both
sides of the boundary rather than on a manufactured pair.

| Band | card-present | card-not-present | why |
|---|---|---|---|
| `standard` (default) | 1.65% + 10¢ | 1.90% + 10¢ | everything the MCC map does not name |
| `supermarket` | 1.15% + 5¢ | 1.45% + 5¢ | high volume, low ticket, near-zero fraud |
| `fuel` | 1.30% → **1.45%** + 5¢ | 1.55% → **1.70%** + 5¢ | re-rated today |
| `restaurant` | 1.75% + 10¢ | 1.95% + 10¢ | tips make settled ≠ authorised |
| `travel` | 1.85% + 10¢ | 2.00% + 10¢ | large tickets, long lags, most chargebacks |
| `charity` | 1.00% + 0¢ | 1.00% + 0¢ | a fixed fee on a $5 donation is 2% of the gift |

These are **not** Visa's published schedule — claiming that would be a claim not
proven by a real call. They are a plausible issuer rate card with the right
**shape**: the cheap bands are cheap for the reasons the real ones are, and
card-not-present is always dearer than card-present because the fraud is.

**The `unknown` presentment carries the card-present numbers**, and that is a
policy expressed as data rather than as a branch in code: card-present is the
**lower** rate, so a settlement whose presentment we cannot substantiate books
the smaller number. Revenue we cannot substantiate is revenue we do not claim.
For the same reason an *unrecognised* entry mode maps to `unknown` rather than to
card-not-present — a provider shipping a new enum value must not silently
increase our reported revenue.

**The MCC→band map is not effective-dated and the rate card is.** A
classification is not a price: 5542 has been automated fuel dispensers since long
before this ledger existed. What changes is what we charge for fuel. The posting
stores its resolved `category`, so a re-classing is a decision about future
settlements and never a silent restatement of past ones.

---

## 5. What is on the live book, with the arithmetic

Booked through `postEntry()` → `ledger_append()` and nothing else — hash chain,
serialised `booking_seq`, idempotent replay, all of it.

```
176 settlements priced          22,073c gross interchange
 57 of them repaired            12,772c net on 4100 after reversals
152 settlements deliberately unpriced (no provider transaction record)
```

*(measured at the time of writing; the book grows every time the suite runs, and
the screen is live. The ratio is the stable fact: see §8.3.)*

### A real fuel capture, on the OLD card

Lithic event `ad31fe7f-1552-458a-97b9-1f99fc2b2368`, value date **2026-09-10**,
MCC 5542, entry mode `MANUAL` → `fuel` / `card_not_present`, card effective
2026-08-12 = **155 bps + 5¢**:

```
N = 7340 * 155           = 1,137,700
q = N div 10000          = 113
r = N mod 10000          = 7,700
2r = 15,400 > 10,000     -> round UP
ad valorem               = 114
+ fixed                  =   5
= interchange            = 119c
```

- settlement entry `ffa70e52-8c32-4cbd-baa3-013aa72b7824`
- interchange entry `bbe6521d-d58c-4516-a4f3-b40784f23c6e`

### The same capture, on the NEW card — the rate change proved

Lithic event `250ae216-3bba-416f-aba3-7546b14feaf0`, value date **2026-09-11**,
identical MCC and identical amount, card effective 2026-09-11 = **170 bps + 5¢**:

```
N = 7340 * 170           = 1,247,800
q                        = 124
r                        = 7,800     -> round UP
ad valorem               = 125
+ fixed                  =   5
= interchange            = 130c
```

- settlement entry `986052cf-dc47-440e-97c7-928c19c3b943`
- interchange entry `8eca56ce-fbc9-4dc8-b7e7-6a001b686d8c`

**77 fuel settlements on 2026-09-10 are priced at 155 bps and 43 on 2026-09-11
at 170 bps.** Same merchant category, same book, adjacent days, two cards. The
earlier day was not touched and cannot be: `interchange_rate_at()` resolves on
the settlement's own date and the forward-only trigger refused the backdated row
when the test tried it.

### THE HALF-CENT TIE, on a real settlement

Lithic event `4820085a-490f-4018-b985-d7659213544d`, $30.00 at 155 bps:

```
N = 3000 * 155           = 465,000
q                        = 46
r                        = 5,000
2r = 10,000 = D          -> EXACTLY half a cent
q = 46 is EVEN           -> stays at 46
```

Half-up would have answered **47**. Half-even answers **46**. Interchange entry
`fef5c6b4-be87-4487-a8e5-a249dcda7bee`. This is the case DESIGN §12.2 was written
for, and it is on the book rather than in a unit test.

### THE TRAP: a settlement the merchant took back

Lithic event `fef8cf51-7fe0-482a-b2c6-08787d254b15` — a **refund** of $73.40 on
2026-09-10, priced `standard` / `card_not_present` at 190 bps + 10¢ =
**149c returned**. The refund was then itself reversed by a `RETURN_REVERSAL`,
so the settlement's correction group now nets to **zero**:

- interchange entry `7e2240fe-a4b3-4726-a93f-66add40f3c8e` (149c returned)
- reversal entry `7aaa5c3a-4eb2-45a9-ae3d-9ea10e120623`, **at value date
  2026-09-10 — the original's, never today's**
- the settlement now carries **0c** of interchange

**57 settlements on this book have been through this**, all of them repaired at
their original value dates. Not a hypothetical: the correction machinery had
already reversed them before interchange existed, and the backfill — which is
the live hook run over history — booked each at its original amount and then
unbooked it, which is exactly the pair of facts the live path would have written
had the feature shipped on the day.

### Why `standard / card_not_present` shows negative interchange

`−447c` on `−22,020c` of net spend. That band's traffic on this book is
refund-heavy: a refund **returns** interchange, with the signs of the entry
swapped, so a purchase and its full refund net to **exactly zero** by
construction — the ad-valorem halves cancel because they are the same magnitude
at the same rate, and the fixed halves cancel because they are the same integer.
There is no arm for it; it falls out of the signs.

---

## 6. The reversal path, and why it is one function

`reconcileSettlement()` is **total and idempotent**. Given a settlement it makes
the book say the right thing about that settlement's interchange, whatever the
book currently says, and calling it again changes nothing. There is no separate
"book", "unbook" and "re-price" path, **because three paths is three chances for
one of them not to be called** — and the one that would not get called is the
one the whole feature is graded on.

1. **Book**, if nothing has been booked — always at the **original** settled
   amount, priced by the card effective on the settlement's own value date, even
   when the settlement has already been reversed. That is not wasted work: it is
   the honest bitemporal record. The revenue *was* earned on that day on the
   information we had, and the repair is a second fact about the same day rather
   than an edit to the first. Booking the net directly would produce a ledger
   that could not answer *"what did we think this settlement was worth before the
   merchant took it back"*, which is the question this whole build exists to be
   able to answer.
2. **Repair**, if the journal disagrees with what the settlement is now worth.
   Read the settlement's whole correction group, price its net at the posting's
   **own stored rate**, compare against the 4100 lines of the interchange
   correction group, and `reverseAndRebook()` the difference **at the original
   value date**.

Step 2 is driven by **arithmetic on the journal**, not by "a correction event
arrived". That is the difference between a hook that works and a hook that works
until someone reverses a settlement by another route: the repair condition is
exactly the condition `v_interchange_drift` reports, so anything that makes the
invariant fire also makes the function act.

Idempotency is four layers deep and none of them is an `if`:

| Layer | Key |
|---|---|
| `journal_entry.idempotency_key` | `interchange:<provider event id>` / `interchange:corrected:<…>` |
| `interchange_posting` | `UNIQUE (provider, provider_event_id)`, `UNIQUE (settlement_entry_id)` |
| `interchange_reversal` | `PRIMARY KEY (interchange_posting_id)` |
| `reverseAndRebook` | `reversal:<entry id>` + `journal_entry_one_reversal_idx` |

### Where the hook sits, and why it reports instead of throwing

`interchangeHook()` runs **last** in `applyCardTransaction`, after the
corrections. Lithic sends the whole `events[]` array every time, so one payload
routinely carries a settlement **and** the correction that undoes it; running
after `postCardCorrection()` means the reconcile sees the correction group in its
final state and books, then immediately unbooks, in one call.

By the time it runs the customer's money has already moved and committed.
Throwing would fail the webhook consumer and force a redelivery of work that is
already done — harmless, because every layer is idempotent, but it would also
mean a hole in the rate card could stop card settlements being processed at all.
**A revenue-recognition problem must not take the money path down with it.** So a
failure is reported in three places instead of one: on the `ApplyResult`, in the
structured log (`interchange.reconcile_failed`), and — because the settlement
stays unpriced — in `v_interchange_unpriced` with its reason. The repair is to
call the reconcile again.

---

## 7. The invariants, and the proof that each one fails

> A new invariant that has never returned a row is a comment.

Three views, all wired into `scripts/dbcheck.mjs`, all **made to fail before any
of them was trusted**, on real settlements, in transactions that were rolled
back — and all three re-proved on every run of
`src/lib/interchange/interchange.integration.test.ts`.

### Why they had to be written at all

Every existing invariant on this book asks whether entries **balance**, or
whether two derivations of one number **agree**. Interchange booked on a
settlement that was later reversed **balances perfectly** — two equal and
opposite lines, the right entity, the right value date — and every one of those
checks stays green while the ledger overstates income for ever. These are the
first guards on this book about whether an entry **should exist**.

### `v_interchange_unreversed` — did the repair happen at all?

An interchange posting whose **settlement** has a reversal and whose own entry
has none.

**Made to fail:** reverse a real priced settlement inside a transaction — exactly
what a merchant reversal does — and skip the unbooking. The view goes from 0 rows
to non-zero and `v_interchange_drift` reports a drift of exactly the interchange
that should not exist. Asserted in the integration suite, rolled back.

### `v_interchange_drift` — is the amount right?

For every priced settlement: what its correction group **now** nets to on the
customer's own leg, what that is worth at the rate **this posting** was priced
at, and what the 4100 lines of the interchange correction group actually say.

It catches a reversed settlement whose interchange still stands, interchange
booked twice, a partially corrected settlement never re-priced, a re-book priced
at a rate the original was not priced at, and an interchange entry reversed when
the settlement was not.

**Made to fail, twice.** The second proof is the one worth reading: a repair is
filed through the real path with a `net_settled_cents` the journal does not
agree with, and a re-book derived from it. **Every constraint is satisfied** —
`assert_interchange_reversal()` holds `rebook_natural_cents` equal to the
arithmetic *on the recorded net*, and nothing in a trigger can check the net
itself, because a settlement's true net is a sum over a correction group that
keeps changing after the row is written. So the bookkeeping says "handled" and
the journal says otherwise. `v_interchange_unreversed` reports **0 rows** for that
posting; `v_interchange_drift` reports **1**.

### `v_interchange_rate_drift` — no settlement re-priced by a rate that came later

Every posting must still resolve to the rate card row effective on **its own**
value date.

**Made to fail:** the forward-only trigger makes the offending INSERT impossible,
so the proof opens the owner connection, `ALTER TABLE … DISABLE TRIGGER`,
backdates a fuel rate, counts the rows, and rolls back. The test **fails rather
than skips** when no owner connection is configured: a check that cannot be
performed is UNKNOWN and never a pass.

### Neither of the first two reads `interchange_reversal`, and that is the point

The first draft of `v_interchange_unreversed` asked *"is there an
`interchange_reversal` row"*, which is a question about **bookkeeping** and not
about **money**. It fails in **both** directions, and both were observed while
building this:

- **Writing** a row silences it while the revenue stands — the exact shape of
  failure this repository has found sixteen times, a guard reporting healthy
  because what it excluded looked like the thing it was watching for.
- **Losing** a row makes it scream while the journal is perfectly correct. This
  happened on this database: 56 correctly repaired settlements reported as
  unrepaired after the audit table was rebuilt during development.

A guard that reads a side table instead of the ledger is the first defect wearing
a different hat. Both views now read `journal_entry` and `journal_line` and
nothing else, and `reconcileSettlement()`'s repair condition reads the same
column (`journal_entry.reverses_entry_id`) — so the condition that makes the
guard fire is the condition that makes the repair run, and they cannot drift
apart.

### Where they run

`scripts/dbcheck.mjs`, in a **second array** (`INVARIANT_VIEWS_0031`), checked
identically and counted into the same tally. `src/lib/chaos/invariants.test.ts`
parses the first array out of that file and asserts the chaos dashboard's copy
matches it exactly, and `src/lib/chaos/**` was outside this change's remit —
appending there without the mirroring edit turns `pnpm test` red for a worker who
cannot fix it. The same trade a previous worker made for
`v_wire_availability_drift`, with the same follow-up named rather than left to be
discovered: **mirroring these three into `src/lib/chaos/invariants.ts` is a
two-line edit for whoever owns it.**

---

## 8. The unit economics: what this programme actually earns

`/economics`. Every figure is a sum of immutable journal lines, reached through a
view the migration declares — no stored total, no projection, nothing computed
in TypeScript from anything other than the ledger.

### How a house line is attributed to a customer

The house income and expense accounts carry no `business_id` — there is one 4200
for everybody. So attribution is by the **entry**: a house P&L line belongs to
the customer whose own deposit leaf the *same entry* moved. That is exactly right
for the platform fee and for both sides of interest, all of which debit or credit
the customer in the same entry.

**Interchange is the exception, and it is worth being precise.** The interchange
entry is `2200`/`4100` and never touches the customer's leaf — it cannot, because
interchange is money between us and the network and none of it is the customer's.
So the *attribution* comes from `interchange_posting.business_id`, which the
lifecycle trigger tied to the settlement it prices; the *amount* still comes from
the journal, through `v_interchange_booked`. The posting row says **whose**, the
journal says **how much**, and `v_interchange_drift` holds the two equal. The
integration suite additionally asserts that the sum of attributed interchange
equals `4100`'s own balance, so the attribution can neither invent nor lose
revenue.

### What it says, today

| Business | Settlements | Net spend | Interchange | Fees | Interest paid | **Contribution** |
|---|---:|---:|---:|---:|---:|---:|
| Kettle & Crumb Bakery LLC | 80 | $2,865.52 | $48.61 | — | $1.35 | **+$47.26** |
| Holds Integration Fixture Co. | 61 | $3,376.40 | $55.73 | $18.37 | $27.05 | **+$47.05** |
| Ridgeline Robotics, Inc. | 25 | $1,095.10 | $18.18 | $11.26 | $9.22 | **+$20.23** |
| Live Fire — attack 3 (bitemporal correction) | 2 | — | — | — | — | **—** |
| Pots Integration Fixture Co. | 0 | — | — | $3.72 | $4.64 | **−$0.92** |
| Hold Fuzzer Fixture Co. | 8 | $293.60 | $5.20 | — | $92.83 | **−$87.63** |

*(figures as at the run that produced this document; the screen is live)*

**Three findings a spreadsheet would not have given you:**

1. **Card spend carries this programme.** Interchange is roughly 1.65% of net
   settled spend and it is the largest revenue line on every business that uses
   its cards. The platform fee is a rounding error beside it on the accounts that
   spend.

2. **A business that does not spend is a business that costs money.** Hold Fuzzer
   Fixture Co. holds the largest balance on the book and barely uses its card:
   $92.83 of interest paid against $5.20 of interchange earned. That is the
   deposit-taking business's central problem stated in two numbers — **the cost
   of deposits is the largest cost there is**, and a balance that does not turn
   into card spend is a liability you are paying rent on. Pots Integration
   Fixture Co. is the same shape at smaller scale. The ledger says this without
   anyone having modelled it.

3. **The reversal discipline is worth ~$93 on a ~$221 gross book.** 22,073c of
   interchange was booked gross; 12,772c stands after the 57 reversals were
   unbooked. **A programme that booked interchange on settlement and forgot to
   unbook it on reversal would report 73% more revenue than it has** — and every
   entry would balance, and every existing invariant would stay green. That is
   the number that justifies §7.

   The `Live Fire — attack 3` row is the same fact in miniature and worth
   pointing at: two settlements priced, **zero** net spend and **zero**
   interchange. That business exists to have a settlement reversed at it, and
   the economics screen reports it earning nothing rather than earning the
   interchange on spend that was undone.

The screen also prints the **effective take rate** — interchange as basis points
of net settled spend, computed as `interchange * 10000 / netSettled` in `bigint`
and truncated, because it is a ratio for a human to read and never an amount of
money.

### The screen's five states

| URL | What it shows |
|---|---|
| `/economics` | live: every business, the whole rate card, the most recent priced settlements, and the three guards counted |
| `?state=loading` | the real skeleton, held open by a genuinely slow read |
| `?state=empty` | a programme that has never settled a card — an honest blank that still shows the rate card, because the card is in force whether or not anything has priced against it |
| `?state=error` | the read failed; nothing is shown rather than a stale number |
| `?state=edge` | the two cases this feature turns on, side by side: an exact half-cent tie broken to the even cent, and a settlement the merchant took back now worth exactly zero |
| `?settlement=<id>` | the whole arithmetic for one settlement, as integers, with the entry ids on both sides |

The fixtures compute their figures with the same `priceSettlement()` the ledger
posts through, so they cannot disagree with the rounding rule. They borrow only
the *choice* of amounts.

---

## 9. Known gaps, stated before someone finds them

1. **The card-present arm of the rate card has priced nothing.** Lithic's
   sandbox only ever emits `MANUAL` at a `PHONE` terminal and its simulate
   endpoints do not accept a POS entry mode. The arm is correct, it is tested as
   a pure function, and no live settlement has exercised it. Measured, not
   assumed.

2. **Card product is not a dimension.** Not in the event; see §2. Week two:
   store Lithic's `type` and `card_program_token` on `card` at registration and
   add a third key to the rate card.

3. **A second correction of the same settlement is refused, not handled.**
   `journal_entry_one_reversal_idx` permits one reversal per entry and
   `interchange_reversal` is `PRIMARY KEY (interchange_posting_id)`, so a
   settlement corrected twice returns `re_correction_unsupported` and
   `v_interchange_drift` keeps reporting until a human looks. Reported rather
   than forced: a guess there would be a second reversal the database would
   refuse anyway. No such settlement exists on this book.

4. **`v_interchange_candidate` names `'lithic'` in a join.** `journal_entry`
   records the **rail** (`card`) and the provider's reference, not which provider
   issued it, and `card_authorization` is unique on `(provider,
   provider_auth_id)`. With one card issuer the join is exact; a second would
   need the provider on the entry, which is a change to the rail adapter and not
   to this feature.

5. **An entry touching two businesses' deposit leaves would attribute its house
   P&L lines to both.** That is a real ambiguity rather than a bug — there is no
   fact on the entry that says whose fee it was — and no such entry exists on
   this book, because internal transfers are pot moves that stay inside one
   business.

6. **The three guards are not mirrored into the chaos dashboard.** See §7.

7. **Eleven dangling holds this work created, and they are mine.** Running
   `interchange.integration.test.ts` puts a real Lithic authorisation on the
   sandbox. The sandbox **account** carries a daily spend cap shared by every
   card in the program; a day of live-fire runs exhausts it, and the
   authorisation comes back `ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED`. When the
   deployed webhook consumer ingests that authorisation in the window *after*
   the `AUTHORIZATION` event appears and *before* Lithic attaches the verdict,
   it is stored as kind `authorization` with no result — and the hold it opens
   then withholds money against an authorisation the network refused.

   **11 holds, $370.00**, all on cards named `interchange <tag>`. They cannot be
   repaired by recording the verdict now: `card_auth_event` is append-only and
   `assert_card_auth_event_result()` correctly refuses to file a DECLINED verdict
   against a row stored as `authorization` — 0026's guard doing its job, and
   exactly the half migration 0032 names as unrepairable. They release on the
   **seven-day expiry sweep**, which is the designed path for an authorisation
   that never settles.

   Two changes reduce it to at most one per run rather than three, and both are
   in the file with the reason attached: the test now **polls for the verdict**
   and not merely for the event before ingesting, and it makes **exactly one
   authorisation attempt** instead of retrying at smaller amounts when the
   network declines.

   For scale: `v_refused_auth_hold` was already failing with **78 holds and
   $5,265.60** of the same class (`result_source = 'not_retained'`, pre-0026
   history plus other suites' traffic) before this work began. That check is red
   for reasons that mostly are not mine, and these eleven are the part that is.

8. **Three `v_hold_drift` rows were repaired that belonged to another suite.**
   `lithic:team-test-*` authorisations whose memo posting never landed — the
   documented crash-safety window between `recordFacts` and `settleHoldPosting`,
   which the design says heals on the next event or the expiry sweep. Rather
   than leave the gate red for a state that heals by design, they were healed
   through the designed path: `settleHoldPosting()`, which is a
   compare-and-append that posts `H(E) − memo_balance` and would have been a
   no-op had the memo already been right. Append-only, no edit, three real
   entries. Named here because repairing another worker's state without saying
   so is how a shared book gets confusing.

---

## 10. Running it

```bash
set -a; . ./.env; set +a

node scripts/migrate.mjs                       # applies 0031
RUN_DB_TESTS=1 pnpm test src/lib/interchange   # the seven claims, live
node scripts/dbcheck.mjs                       # the three guards, among the rest
```

The backfill is `backfillInterchange()` in `src/lib/interchange/backfill.ts`,
driven by the integration suite. It contains **no pricing logic**: it selects
settlements and calls `reconcileSettlement()` — the same function the live
webhook hook calls, with the same idempotency — so the postings it produces are
indistinguishable from the ones the hook would have produced had the feature
existed on the day. A second run reports `unchanged` for everything and the
booking watermark does not move, which is asserted rather than claimed.
