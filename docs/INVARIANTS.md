# INVARIANTS — what each guard actually asks, and what it therefore cannot see

This document exists because of one accident.

While proving `v_pot_line_provenance`, migration 0052's author seeded the probe
on a pot this book had already drained to $0.00. Moving $50.00 out of an empty
pot took it to −$5,000 cents, `v_pot_negative` fired, and the provenance proof
failed for a reason that had nothing to do with provenance. The seed was
re-pinned onto a pot that actually held the money and the proof passed.

The accident is the finding:

> **A balance guard catches a foreign write only when the amount happens to
> break a balance.** Drain the pot first, or move LESS than it holds, and the
> identical unauthorized write is invisible — because the balance views ask
> about the NUMBER, and none of them asks WHO WROTE THE LINE.

That is the 27th catalogued instance of this repository's through-line defect:
*a guard reports healthy because what it excluded was shaped exactly like the
failure it existed to catch.* For pots it is closed structurally. The open
question was how many of the other thirty invariants have the same shape.

All thirty-one were read — **the SQL body, not the one-line summary**. Two
proofs earlier in this build were written off summaries and both were wrong.

The gate now stands at **37 views, 48 passed / 5 failed, 37 of 37 proven (52
proofs)**. Five views were added by the 0052–0056 work and a sixth —
`v_pot_guard_disarmed`, 0057's — by the pass that wrote *The fifth red* below.

**There are five reds now, not four.** The fifth, `v_pot_line_provenance` at 2
rows, is the only one this build inflicted on itself: a probe proving 0057's
concurrency claim committed two unlabelled foreign pot writes to this book, the
ledger is append-only, and they cannot be removed. It is argued in full in
*The fifth red* and on `RED_REGISTER` in `scripts/dbcheck.mjs`. Nothing changes
it, ever.

---

## Part 1 — the classification

**Balance-shaped** — it compares amounts, totals or differences. A quantity is
the whole predicate.
**Structural** — it asks about provenance, identity, authorship, or the shape
of an entry. Not answerable by choosing a smaller number.
**Existence-shaped** — it asserts a row is present or absent.
**Mixed** — the load-bearing predicate is named in the row.

`Dodge?` means: *can the unauthorized write this guard is positioned over be
sized or placed so the guard's own predicate stays false?* **Constructed** means
it was written against the live book in a rolled-back transaction and the guard
read before and after — not reasoned about.

| # | View | Class | Load-bearing predicate | Dodge? |
|---|---|---|---|---|
| 1 | `v_entry_unbalanced` | Balance | `sum(amount_cents) <> 0` per entry/currency | **No** — see §"why four are sound" |
| 2 | `v_line_denorm_drift` | Structural | `l.value_date <> e.value_date OR l.booking_seq <> e.booking_seq` | No |
| 3 | `v_hold_drift` | Balance | `memo_balance <> target_hold`, gated `NOT is_released` | **Yes — constructed (D‑D)** |
| 4 | `v_hold_release_drift` | Balance | `is_released AND memo_balance <> 0` | **Yes — constructed (D‑C)** |
| 5 | `v_book_not_zero` | Balance | `sum(amount_cents) <> 0` per entity/book/currency | **No** — see §"why four are sound" |
| 6 | `v_deposit_control_drift` | Balance | `subtree_cents <> reported_cents` | **Yes — constructed (D‑A, D‑I)**. The worst. |
| 7 | `v_accrual_month_drift` | Mixed | `accrued <> monthly` — **gated by `month_complete`** | **Yes — measured**: population is 0 |
| 8 | `v_accrual_ledger_drift` | Mixed | amount equality **on `l.account_id = s.account_id` only** + date equality | **Yes — by placement** |
| 9 | `v_standing_order_double_fire` | Existence | `count(DISTINCT pi.id) > 1` over a `LIKE 'standing:<id>:%'` population | Yes — by key, not by amount |
| 10 | `v_dispute_ledger_double_count` | Existence | `count(*) > 1` per (dispute, entry, ordinal) | **No** — counting, no amount to choose |
| 11 | `v_balance_definition_drift` | Balance | two hold derivations + an identity over one view's own columns | **Yes — constructed (D‑A, D‑C, D‑D, D‑I)** |
| 12 | `v_interest_ledger_drift` | Mixed | amount equality on three named accounts + date equality | **Yes — by placement** (a fourth account is unchecked) |
| 13 | `v_interest_rate_drift` | Structural | posted policy/rate/day-count vs `interest_rate_at(tier, date)` | No |
| 14 | `v_refused_auth_hold` | Mixed | `result IS DISTINCT FROM 'APPROVED'` — **gated by `active_hold_cents > 0`** | **Yes — measured**: 525 of 883 excluded |
| 15 | `v_hold_closure_not_terminal` | Structural | `source IN ('posting_path','expiry_sweep')` + no reversal + `NOT is_closed` | Not by amount — by declared `source` |
| 16 | `v_wire_availability_drift` | Structural | `h.available_at > e.booking_time` (time, not money) | No |
| 17 | `v_approved_auth_for_dead_member` | Structural | `is_violation` over a classification of the cardholder's terms | No |
| 18 | `v_member_approval_without_right` | Structural | `is_violation` over a classification of the principal | No |
| 19 | `v_interchange_unreversed` | Existence | settlement reversal exists, interchange reversal does not | **No** — existence, no amount to choose |
| 20 | `v_interchange_drift` | Balance | `booked <> interchange_natural_cents(net, rate, fixed)` | **Yes** — a *conforming* fabrication satisfies the formula |
| 21 | `v_interchange_rate_drift` | Structural | posted policy vs `interchange_rate_at(cat, presentment, date)` | No |
| 22 | `v_hold_expiry_drift` | Structural | `h.expires_at IS DISTINCT FROM ca.expires_at` | No |
| 23 | `v_advice_delta_unsound` | Mixed | **`(absolute − signed_delta) < 0`** + payload missing | **Yes — measured**: 12 of 13 unquestioned |
| 24 | `v_hold_closure_unexplained` | Existence | closure + `NOT is_closed` + no reversal + no non-APPROVED result | No |
| 25 | `v_team_terms_by_unauthorised_author` | Structural | `is_violation` over a classification of the author | No |
| 26 | `v_value_date_unexplained` | Mixed | **a band** `[entity − 1y, today + 18m]` + a provenance classification | **Yes — constructed (D‑H)** |
| 27 | `v_internal_transfer_impure` | Structural | shape, over a population the writer **selects itself into** | Not by amount — by key; **and by null-swallow, constructed (D‑G)** |
| 28 | `v_pot_identity_drift` | Balance | `main + Σpots <> subtree walk` | **Yes — constructed (D‑F)**, any amount |
| 29 | `v_pot_negative` | Balance | `balance_cents < 0` | **Yes — constructed (D‑E)**. Instance 27 itself. |
| 30 | `v_pot_orphan` | Structural | the pot's account is a liability leaf under that business's own `2100` | No |
| 31 | `v_pot_line_provenance` | Structural | provenance of every line on a pot account, keyed on the chart | No |
| **32** | **`v_deposit_cross_customer`** *(0054, new)* | Structural | `customer_count > 1` or `house_deposit_lines > 0`, over the parent chain | No |
| **33** | **`v_memo_line_placement`** *(0054, new)* | Structural | every memo line on `hold.memo_account_id` or a house memo account | No |
| **34** | **`v_deposit_outflow_unexplained`** *(0055, new)* | Structural | an outflow carries a citation, a webhook, a fixture row, or `external_ref` | **Partly** — arm 4 is a label; see §"the boundary" |
| **35** | **`v_fx_commitment_unheld`** *(0053, wired in)* | Balance | `active_hold_cents <> sell_cents` on a standing commitment | **No** — see §"why four are sound" |
| **36** | **`v_advice_base_drift`** *(0056, new)* | Structural | `absolute − signed_delta = fold of prior events` | No |

### The tally, stated conservatively

Of the original 31: **9 pure Balance · 6 Mixed · 12 Structural · 4 Existence.**

**Fifteen guards turn on a quantity. Eleven of those fifteen are dodgeable.
Four are not, and saying so is the point of having read them.**

### Why those four are sound — the claim someone will try hardest to break

"Not dodgeable" is worthless unless it says *why the quantity cannot be tuned*.
Each of these four has a different reason:

**1. `v_entry_unbalanced` — the tolerance has no width, and the two sides are
not two quantities.** It does not compare A to B; it compares `sum(lines)` to
the constant `0`. There is no second quantity to move in sympathy, so there is
no pair of amounts that is both unbalanced and passing. And the state cannot
persist even briefly: `journal_line_balanced` is a DEFERRABLE INITIALLY
DEFERRED constraint trigger that fires at COMMIT, so a violating entry can only
exist inside an open transaction. *Its real limit is scope, not calibration —
a forgery that balances was never in its remit, and that is why views 32/34
exist.*

**5. `v_book_not_zero` — same reason, one aggregation level up**, and with the
same constraint behind it. Grouping by (entity, book, currency) cannot be
escaped by choosing amounts, because every entry that balances contributes zero
to every group it touches.

**10. `v_dispute_ledger_double_count` and 19. `v_interchange_unreversed` —
there is no amount in the predicate at all.** One counts rows per
(dispute, entry, ordinal); the other asks whether a reversal row exists. You
cannot make `count(*) > 1` false by choosing a smaller number, because the
number being counted is a row count, not money. To dodge either you must change
*what rows exist*, which is the structural question, not the balance one.

**35. `v_fx_commitment_unheld` — the two quantities are the same number by
construction.** It compares the hold's `active_hold_cents` to the quote's
`sell_cents`. `sell_cents` is fixed on the quote row and `fee_cents`,
`customer_rate_scaled` and `buy_minor` are `GENERATED ALWAYS` from it, so the
price cannot be restated after acceptance; the hold amount is what the
acceptance path places. There is no slack to distribute between them. *Its real
limit is its population, addressed in §"the watermark" below.*

And the honest note from the other side: **structural does not mean sound.**
`v_internal_transfer_impure` (27) is structural and is the weakest guard in this
table, because its *population* is the writer's own idempotency key.

---

## Part 2 — the dodges, constructed

All executed against the live Neon book as `corgi_app` — the role the product
runs as — through `ledger_append()`, in transactions that were rolled back. No
trigger disabled. No actor impersonated.

### D‑A — `v_deposit_control_drift`, between two customers

`$250,000.00` from one customer's `2100` into another's. **Nine balance guards,
every one green:** `v_entry_unbalanced`, `v_book_not_zero`,
`v_deposit_control_drift`, `v_pot_identity_drift`, `v_pot_negative`,
`v_internal_transfer_impure`, `v_balance_definition_drift`,
`v_pot_line_provenance`, `v_value_date_unexplained` — all `0 -> 0`.

Why: `v_deposit_control_drift` is the *only* invariant over the whole customer
deposit subtree, and **both of its sides count the same accounts.** Every
customer `2100` is a child of the house `2100` (in the walk) and carries a
`business_id` (in the report). A movement within that population moves both
sides equally, **for any amount**. Not loose calibration — structurally
incapable.

> **CLOSED** by `v_deposit_cross_customer`. Verified `0 -> 1`.

### D‑I — the same guard, straight out of the book

`$500,000.00` from a customer's `2100` into house `1000 Cash at bank`.
**Twelve guards green**, including `v_deposit_cross_customer` — correctly, it
*is* one customer.

> **CLOSED** by `v_deposit_outflow_unexplained`. Verified `0 -> 1`.

### D‑I′ — the dodge that decided the design

The **identical** theft, one account over: into `1110 Cash — FBO settlement
account at sponsor bank`. An asset. Real money. And an account **any whitelist
must contain, because 145 legitimate entries use it.** Every guard green.

This is why option (A) — *"customer money may not leave `2100` except through a
named set of house accounts"* — was **rejected**. `1000` receives no legitimate
traffic on this book, so a whitelist of the ten accounts that do would have
caught D‑I and shipped green with a passing proof attached. D‑I′ shows that
would have been worthless: its discriminating power against anyone who reads
the chart is **zero**. It catches the dodge written first and fails the dodge
one line different — `v_internal_transfer_impure`'s defect in a different
column.

**The underlying reason, which is the part worth keeping:** a legitimate payout
and a theft are **the same transaction** — customer liability down, house asset
down, two balanced lines, one currency, one entity. Side by side with a real
cited ACH payout, D‑I differs in nothing a balance or a chart shape can see.
*The difference is not in the money. It is in whether anybody asked for it* —
and that is a row in another table, not a number.

### D‑C — `v_hold_release_drift`, by netting to zero

`+$100,000.00` then `−$100,000.00` on a released hold's own memo account. Fires
only on `memo_balance <> 0`. **Left open — see Part 4.**

### D‑D — `v_hold_drift`, by placement

`$85,000.00` credited to Ridgeline's `9100` memo account under **Kettle's** live
hold. All eight hold/balance guards unchanged. `v_hold_state` folds only
`l.account_id = h.memo_account_id`, so the money is in **neither side** of the
comparison. Two derivations that both exclude the same money agree perfectly.

> **CLOSED** by `v_memo_line_placement`. Verified `0 -> 1`.

**A defence found by trying to get past it.** The first form of this probe used
`hold_id` NULL. The database refused it: `je_memo_has_hold CHECK (book =
'financial' OR hold_id IS NOT NULL)`.

### D‑E / D‑F / D‑G — the pot family

`$11,880.01` out of a `$12,000.00` pot (instance 27 reproduced); the whole pot
into its own main at any amount; and **D‑G, the null-swallow** — `$12,000.00`
into the **house** `2100` under a *well-formed* `pot:` key naming the pot it
actually touched, with `v_internal_transfer_impure` at `0 -> 0` because
`count(DISTINCT business_id)` skips NULLs.

### D‑H — `v_value_date_unexplained`, by one day

Band `[2025-09-10, 2028-03-11]`. Identical `$300,000.00` write:
`2025-09-11` → `0 -> 0`; `2025-09-09` → `0 -> 1`.

### Measured rather than written

**`v_refused_auth_hold` (14)** — the gate `active_hold_cents > 0` is *a balance
question asked before the structural one*. `GUARD REACH` now prints
`ranges over 358 of 883 — 525 rows (59%) are OUTSIDE this guard by
construction`. At the time of measurement: 257 seen / $19,654.27 vs **338
invisible / $20,159.93**, including **87 on holds the fold calls OPEN** and
**60 outright `DECLINED`**. None of it is exposure — a hold at zero withholds
nothing — *which is exactly why nothing surfaced it: the guard's own gate made
the gap look like emptiness.*

**`v_advice_delta_unsound` (23)** — 12 of 13 advices had a base ≥ 0 and were
never questioned again. **CLOSED** by `v_advice_base_drift`.

**`v_accrual_month_drift` (7)** — five accrual months, none complete. The
guard's population is **zero**; `GUARD REACH` prints `EMPTY`.

---

## Part 3 — what was closed

Three migrations, five views, all **green on arrival**, all proven, all wired
into `scripts/dbcheck.mjs` *and* `src/lib/chaos/invariants.ts`.

### 0054 — `v_deposit_cross_customer`, `v_memo_line_placement`

Reach 3,110 entries and 1,547 memo entries (**all of them** — total by CHECK
constraint, asserted at commit as well as printed).

### 0055 — `v_deposit_outflow_unexplained`

Reach 3,088 outflow entries. **The honest tick is a distribution, not a zero**,
and `dbcheck` prints it:

```
v_deposit_outflow_unexplained — 3088 deposit outflow(s), BY THE ANCHOR EACH CARRIES
    cited by an operational record    2667     $3,626,492.19
    external reference only            364    $20,084,160.01  <- A LABEL: free text
    declared test fixture               49       $595,973.68
    provider webhook retained            8        $18,188.68
```

**The boundary.** Arm 1 is a foreign key — the row must exist in another table
and the database checks it. Arm 4 is a string. **This guard catches a writer
that FORGOT, not an attacker that LIED.** $20M of the $24M rests on the weak
arm. That is on the screen every run rather than in a comment.

**The sound-but-red version, left for a `RED_REGISTER` argument.** Requiring arm
1 alone is the attacker-resistant guard. It is **red at 406 rows,
$20,696,710.17** — and **303 of those are card settlements** whose provenance is
real (a Lithic network reference) but has no foreign key in this schema. The
rest: ~51 `test:` fixtures, 25 `stmt:`/`statements:`, 13 `ach:`, 11
`increase.wire`, 3 `usdc`. Shipping that red would put 303 correct postings on
the failure list, and a red that is mostly correct behaviour teaches people to
ignore reds. It belongs to whoever owns the card book.

**The fixture table, and where it is stricter than 0047.**
`journal_deposit_outflow_fixture` declares the 49 unanchored entries, backfilled
**once**, so a future unanchored outflow is not excused. 0047 grants `corgi_app`
INSERT on its residue table; **0055 does not.** A guard about money leaving a
customer's account must not be insertable by the role that moves the money, or
the module could excuse itself in the same transaction. A future exemption costs
a migration.

**Why not a key-prefix whitelist either:** 3,043 entries under **24 distinct
(prefix, rail) combinations**. That is `v_internal_transfer_impure`'s defect at
150× scale.

### 0056 — `v_advice_base_drift`

Reach `12 of 13 — 1 row (8%) OUTSIDE this guard by construction`.

The base is not merely supposed to be non-negative; it is supposed to be **a
particular number** — the authorisation's net immediately before the event. One
right-hand side, computed from rows.

**The exclusion, and why it is not the disease.** The 13th row is the
negative-base advice `a299ea01-…`, already red under `v_advice_delta_unsound`,
already on `RED_REGISTER`, already documented in 0043. Firing here too would put
**one defect on the board twice** and take the failure count to five while the
number of findings stayed at four. *Inflating a red is the same disservice as
suppressing one.* The migration asserts at commit that the owning guard still
reports every row this one declines — an exclusion whose owner has stopped
looking is a blind spot with a citation.

**A near miss worth recording:** the first draft took the authorisation fold
from a query that INNER JOINed `card_auth_event_result`, silently dropping every
event whose verdict was never recorded — *the exact state 98 events were in when
0026 shipped a guard that excluded its own bug.* The wrong fold and the right
one disagree about this book. The defect this migration is about was one SQL
revision from being reproduced inside it.

### Wired in from another agent — `v_fx_commitment_unheld`

Accepting an FX quote reserved **nothing**: two acceptances of $21,308.95 each
against $35,514.93 available left availability unmoved and the payout gate
cleared both. Repaired with an ordinary `manual` hold through the existing model
— no second definition of availability.

**The watermark, checked adversarially rather than read.** Its population is
acceptances at or after `fx_commitment_regime.effective_from`; 35 predate it.
A population boundary that can be walked forward is a population the writer
chooses — so I attacked it: **UPDATE, DELETE, TRUNCATE and a second regime row,
as `corgi_app` and as the OWNER. Eight attempts, eight refusals.** `corgi_app`
holds SELECT only; the owner is stopped by `ledger_row_is_immutable()` triggers,
which is the layer that counts because privileges never bind the table owner;
and `singleton boolean PRIMARY KEY CHECK (singleton)` makes a second row
impossible, so the boundary cannot be widened by addition either — and the
`CROSS JOIN fx_commitment_regime` in both views cannot multiply rows.
**No finding. The claim holds.**

It reads `ranges over 0 of 35 — 35 rows (100%) are OUTSIDE this guard by
construction`: green over an empty population today, which `--prove` is what
makes meaningful.

### And one thing instrumented rather than closed

`v_refused_auth_hold`'s `GUARD REACH` line was a single number. It now carries a
total and prints the 59% it declines to look at. **The guard itself is not
widened** — folding a new finding into an old excuse is how a suppression gets
written.

---

## Part 4 — what is left open, ranked

**#1 — The attacker-resistant deposit-outflow guard.** Arm 1 alone. Red at 406
rows / $20,696,710.17, 303 of them card settlements with no FK. Needs a
`RED_REGISTER` argument, or a schema change giving card settlements a citation.

**#2 — `v_refused_auth_hold`'s balance gate.** 525 of 883 outside, now printed,
still unguarded. The structural companion would arrive red with ~595 rows.

**#3 — D‑C: memo entries that net to zero, and memo entries after closure.**
Both resist the obvious repair: *"no memo posting after closure" is not true of
this book* — 271 memo entries are booked after their hold's closure and they are
ordinary settlement traffic. A guard asserting it would arrive red with 271 rows
of correct behaviour.

**#4 — `v_value_date_unexplained`'s band.** Dodgeable by one day.

**#5 — The shared advice blind spot.** Both `v_advice_delta_unsound` and
`v_advice_base_drift` draw their population from
`card_auth_event_result.provider_step`, which **ingest writes**. An advice
mislabelled at the front door is invisible to both. No reach line can show this;
0026's bug was exactly a front-door loss.

**#6 — `v_accrual_month_drift`'s empty population.** Not a defect; the tick is
worth nothing today and `GUARD REACH` says `EMPTY`.

---

## The rule, stated so the next guard can be checked against it

1. **Ask what the predicate compares.** If it is a quantity, assume it is
   dodgeable until you have constructed the dodge or shown the two quantities
   cannot be tuned independently — and write down *which*.
2. **Ask where the population comes from.** If a writer can leave it by
   choosing a different key, rail, description, entry type **or destination
   account**, the population is a label and the guard belongs to the writer.
3. **Ask what the gate excludes before the real question is asked.**
   `active_hold_cents > 0`, `month_complete`, `NOT is_released`,
   `disposition = 'posted'`, `base < 0` — every one decides whether to look, and
   `GUARD REACH` must print how much it declined to look at.
4. **Count nulls separately.** `count(DISTINCT x)` skips them, and in this
   schema `NULL` means *the bank itself*.
5. **An exclusion is only legitimate if its owner is named, on the same gate,
   and actually firing** — and that should be asserted at commit, not promised
   in a comment.
6. **Do not inflate the red count either.** One defect reported twice makes the
   number on the screen stop meaning the number of things wrong.
7. **Pin proof seeds in a total order, and pin proof AMOUNTS to the seed.** A
   probe carrying a literal `$500,000.00` went BLOCKED within the hour because
   other suites commit to this live book and the richest account fell past it.
   Where a companion proof must read several guards, **scope them to the rows
   the probe touches** rather than dropping the noisy ones — dropping views to
   buy quiet is the disease, not the cure.
8. **If a probe must COMMIT, every leg that succeeds goes through the real
   application path — only the leg you expect to be REFUSED may be foreign.**
   A refused write leaves no residue; a committed foreign write is permanent on
   an append-only ledger. Learned at the cost of the two rows in
   *The fifth red* below.

---

## The fifth red — the one this build inflicted on itself

`v_pot_line_provenance` reads **2** on this book and both rows are ours. They
are on `RED_REGISTER` in `scripts/dbcheck.mjs`, which is where a reader running
the gate will meet them; this section is the longer version and the citation
that entry points at.

### What the rows are

| booking_seq | entry id | idempotency_key | description |
|---|---|---|---|
| 11785 | `ae4eb87a-173d-4a0e-bfdf-487dad1391eb` | `race-1789147074432-A` | the winner's release |
| 11787 | `8cf85c29-105a-4d39-a0a3-2aaaf086170f` | `race-1789147074432-restore` | putting the money back |

Two lines each, one currency, one customer, `rail = 'internal'`, each netting
to zero and the pair netting to zero against each other. The view reports them
under `no pot: key — the writer never claimed this was a pot operation`.
Exposure is **zero cents**, and every balance guard over that money —
`v_pot_negative`, `v_pot_identity_drift`, `v_pot_orphan`,
`v_internal_transfer_impure`, `v_deposit_control_drift` — is green over them.
That green is not reassurance: it is D‑E/D‑F/D‑G restated, the exact blindness
0052 built this view to cover, demonstrated one more time on rows we wrote
ourselves.

### Why they exist

0057 claims the negative-pot guard closes the check‑then‑act race between two
concurrent writers. That claim is not provable in a rolled‑back transaction:
an uncommitted row is invisible to the other session, so a probe that never
commits proves the guard fires, not that it serialises. Proving it needed a
writer that actually **COMMITS**.

The claim is true — the loser blocked on `lock_business_deposits()` held by the
winner, woke to a balance including the winner's release, and was refused
`POT_WOULD_GO_NEGATIVE`. The cost was two foreign pot writes committed to a
live book.

### Why there is no repair

`journal_entry` and `journal_line` are append‑only: 0001 §13 revokes UPDATE and
DELETE from `corgi_app` and PUBLIC and `ledger_row_is_immutable()` refuses them
for everybody else. `pot` is append‑only (0015 §1). `idempotency_key` is
immutable. So the rows cannot be removed, and the `pot:` key that would have
made them legible cannot be written onto them afterwards. A compensating pair
would be two *more* unlabelled entries and would take the view to **4**.

The two remaining exits are the ones this repo has a name for. An exemption in
0052, or filtering these entry ids out of the view, is migration **0026's**
anti‑pattern — a guard amended to exclude by construction the exact state the
bug produced — which is the origin of the 28‑instance through‑line this whole
document is about. Excluding our own defect from the single guard that saw it
would retire the guard to clean the scoreboard, and the scoreboard is not the
asset.

So: **nothing changes it, ever.** It is the only entry on the register with no
repair condition and no expiry.

### The lesson, stated as a rule

> **If a probe must COMMIT, every leg that succeeds goes through the real
> application path. Only the leg you expect to be REFUSED may be foreign.**

A refused write leaves no residue. The probe should have posted the **winner**
through `movePotFunds()` and left only the **loser** foreign — the loser was
refused, so the identical proof was available at a cost of nothing. This is
rule 8 for the list above, and it was learned the expensive way.

### What is asserted, and where

Not a count. `src/lib/pots/pots.integration.test.ts` test 13 pins the two
**entry ids** and fails on any pot‑touching entry that is not one of them —
immutable primary keys rather than `<= 2`, because a count is a tolerance and a
tolerance absorbs the next mistake in silence. `scripts/dbcheck.mjs` goes on
reporting all of them, to everybody, as a **FAIL** that still counts and still
exits 1.

---

## Cross-customer PREVENTION — specified, not shipped, and why

`v_deposit_cross_customer` (0054) **detects** an entry that moves money between
two customers' deposit subtrees, or posts straight onto the house `2100`
control account. Nothing **prevents** it. `scripts/dbcheck.mjs` records the
measurement in its own words — $250,000.00 from one customer's `2100` into
another's, through `ledger_append()` as `corgi_app` with every trigger armed,
and *"Every trigger on this book accepts it."*

It was designed as migration **0058**, on 0057's form, and then **not applied**.
This section is the design and the stop, so the next pass starts from the
findings rather than from the question.

### The predicate, and why it is the right shape

Refuse any transaction leaving a journal entry where, over the entry's lines:

```
customer_deposit_lines > 0                        -- the population
AND (   count(DISTINCT business_id)
          FILTER (WHERE inside_subtree AND business_id IS NOT NULL) > 1
     OR count(*) FILTER (WHERE inside_subtree AND business_id IS NULL) > 0 )
```

That is `v_deposit_cross_customer`'s predicate verbatim, and it is
**not amount-dodgeable**: unlike a negative pot, contamination between two
customers is wrong at every amount, so there is no calibration to beat. The
population is the parent chain from the deposit control account over `account`,
which is `SELECT`-only to `corgi_app` — a fact about the chart, not a label
(anchor rule, decision 4).

Note the second clause. House accounts carry `business_id IS NULL` and
`count(DISTINCT …)` **skips nulls**, so a move onto the control account reads as
*one customer*. 0052 and 0054 both handle this with an explicit
`FILTER (WHERE business_id IS NULL)` and so must this — rule 4 above.

### The boundary: CLEAR, and not the one that was feared

The warning carried into this work was that a guard here might refuse real
traffic, because *a legitimate payout and a theft are the same transaction* and
the difference lives in another table. **That risk belongs to 0055's
`v_deposit_outflow_unexplained`, not to this predicate**, and the distinction is
structural:

* A payout moves a customer's `2100` down and a **house asset** down —
  `1000 Cash at bank`, `1110 Cash — FBO settlement`. Those accounts are **not
  inside the deposit subtree**. The entry is `reach = 'one customer'`,
  `house_deposit_lines = 0`, and this guard passes it. 0054's own header says so
  explicitly, and ranks that case as *what it does not examine*.
* The same is true of wires, card settlements, interest postings and fee
  accruals: every one is one customer against a house account **outside** the
  `2100` subtree.

So no authorisation reference is needed to separate the two, and the stop
condition on that ground does **not** bind. The evidence is that the predicate
is **green over the whole history of this book** — 3,053 entries touching a
customer deposit account, every rail, every key prefix, every entry type, 0
violations — which is a wider exercise of real traffic than any probe run could
manufacture.

### 0057's four decisions, carried over — three hold, one does NOT

1. **On the table, not in `ledger_append()`** — **holds, unchanged.**
   `corgi_app` holds `GRANT SELECT, INSERT ON journal_line`, so a guard in a
   function has the reach of whoever chooses to call it.
2. **`DEFERRABLE INITIALLY DEFERRED`** — **holds, and harder.** The predicate is
   an aggregate over the *whole entry*; it is not even answerable until every
   line exists. An immediate check would make arrival order a special case,
   which the hold model spent 0008 and 0036 removing.
3. **The trigger takes the lock itself** — **the principle holds and 0057's
   LOCK IS THE WRONG ONE.** This is the finding worth keeping. 0057 locks the
   customer's deposit family because its aggregate spans *all history*, so a
   concurrent uncommitted row is invisible. This aggregate spans **one entry**,
   whose lines are almost always all in the writer's own transaction — so the
   0057 race does not exist in that form. The race that *does* exist is
   narrower and real: `corgi_app` can append lines to an **already-committed**
   entry (`--prove`'s `v_entry_unbalanced` probe does exactly that). Two
   concurrent transactions each appending a balanced, single-customer pair to
   one committed entry each pass, and the committed end state spans two
   customers. `lock_business_deposits()` **does not close it** — the two
   writers take two *different* business locks and never meet. The correct lock
   is on the **entry**: `SELECT 1 FROM journal_entry WHERE id = NEW.entry_id FOR
   UPDATE` inside the `SECURITY DEFINER` function. It is free on the legitimate
   path (you are locking a row you just inserted, which nobody else can see) and
   mandatory for the foreign writer. *Do not copy 0057's lock line across.*
4. **Anchor on a fact about the chart** — **holds**, see the predicate above.

Cost note, measured: the chart is 37 financial accounts at a maximum depth of
3, so membership should be decided by walking **up** from `NEW.account_id` via
`parent_id` (O(depth), 2–3 rows), not by 0054's recursive walk **down** from the
root, which a per-row trigger would pay for on every journal line.

Whatever ships must also ship its own `v_..._guard_disarmed` view — 0057's form,
reading `pg_trigger`, with the `ABSENT` arm as a `NOT EXISTS` — registered in
`INVARIANT_VIEWS` in **both** `scripts/dbcheck.mjs` and
`src/lib/chaos/invariants.ts` (a parity test asserts the two lists are equal),
with a `GUARD REACH` row and a `--prove` entry.

### Why it was stopped

Not on the predicate, and not on the boundary — both are sound and are written
out above. It was stopped on **time against irreversibility**. A migration is
immutable once applied (`scripts/migrate.mjs` refuses a changed file), this is a
**live book** under a submission deadline, and the remaining window did not
cover writing the guard, exercising it against real ACH payouts, wires, card
settlements, interest postings and fee accruals, *and* having room to be wrong.

A guard that refuses correct behaviour on a live book is worse than the
detection it replaces. Shipping the detection we have, with the prevention
specified to the point where it is half an hour of typing, is the better trade —
and saying so is the point of this section rather than leaving a TODO.

**Ranked #1 of what is open.**
