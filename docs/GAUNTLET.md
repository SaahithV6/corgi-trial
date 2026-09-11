# The domain gauntlet — measured pass

Ten claims, each driven against the **deployed** system inside one window, on
one commit. Every verdict below carries the command that produced it and the
output line it produced. Nothing here is read off the source.

## The anchor

| | |
| --- | --- |
| **Window** | 2026-09-11T21:54:50Z → 2026-09-11T22:04:29Z |
| **Commit** | `5cd3729f598d27505d094054cc3892648ed04b66` (`5cd3729`), read from the deployment itself — `GET /api/health` → `commit.sha`, `source: VERCEL_GIT_COMMIT_SHA` |
| **Target** | `https://corgi-trial-psi.vercel.app` |
| **Health at open** | `"status":"ok"`, `database.reachable: true`, latency 149 ms, integrations `live 7 / 7` |
| **Database** | read as `corgi_app`, the application role — no UPDATE, no DELETE on money tables |
| **Book size** | 10,566 journal lines; `SUM(amount_cents)` over every line = **0** |

### What was driven

| Runnable | Result |
| --- | --- |
| `node scripts/livefire.mjs` | **PASS 6 · FAIL 1 · SKIP 1** of 8 attacks, 339s |
| `node scripts/dbcheck.mjs` | **49 passed / 6 failed** — all six print `ON THE REGISTER`, zero print `NOT ON THE REGISTER` |
| `node scripts/coreloop.mjs` | **DID NOT RUN** — see below |
| SQL against the live book | read-only `SELECT`, every figure below |

**`coreloop.mjs` is down on this commit.** It crashes on its first leg:

```
Error: GET /onboarding answered 401, expected 200
    at getPage (file:///home/lain_iwakura/Documents/corgi-trial/scripts/coreloop.mjs:306:11)
```

This is the console going behind a passphrase, not a ledger fault — the same
cause as attack 7 below. The seven-leg loop is therefore **not evidence in this
pass**, and no verdict below leans on it.

### Rows written to the book

The live-fire run writes; the SQL did not. Attacks 1, 3, 4, 5, 6, 7 and 8 each
opened or wrote to their own isolated live-fire business
(`f1e1fa7e-0000-4000-8000-00000000000N`). No row was written to Ridgeline
Robotics, Kettle & Crumb Bakery or Silverline Freight. Nothing in the repository
was modified except this file.

## Scoreboard

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Ledger vs available, derived not stored | **HOLDS** |
| 2 | Authorisation lifecycle, hold releases exactly once | **PARTIAL** — over-capture closure |
| 3 | Settlement is not authorisation | **HOLDS** |
| 4 | Out-of-order delivery | **HOLDS** |
| 5 | Returns and recalls | **PARTIAL** — card rail only |
| 6 | Bitemporality | **HOLDS** |
| 7 | Statements reproducible forever | **HOLDS** |
| 8 | Standing orders fire once, refusal policy | **HOLDS** |
| 9 | Scheme reconciliation with aging | **HOLDS** |
| 10 | Maker-checker, including the agent surface | **HOLDS** |

---

## 1 — Ledger vs available · **HOLDS**

Available is a **view**, not a column. `dbcheck` asserts it structurally:

```
PASS  no stored balance column — balances are derived, not stored (3 named exceptions, each proven reproducible)
```

The three exceptions are snapshots that must be frozen by definition
(`statement.opening_balance_cents` / `closing_balance_cents`,
`interest_posting.basis_balance_cents`,
`standing_order_outcome.observed_available_cents`) — each a record of what was
believed at a stated instant, not a second live balance.

The derivation is exact on every account on the book:

```sql
select count(*) as accounts,
       count(*) filter (where (ledger_balance_cents - active_holds_cents
                               - pending_outbound_cents) = available_cents) as identity_holds
from v_available_balance;
```
```
accounts: 7   identity_holds: 7
```

The three components are separately visible, so the rule about uncleared credits
is legible rather than folded in:

```
business 7e57b115-…00f2  ledger 50445699  holds 50445599  (card 48945599 + uncleared 1500000)  available 100
business 1151e7b5-…78ce  ledger  4394696  holds  5637000  (card    87000 + uncleared 5550000)  available -1242304
```

The second row is the point: **available goes negative while the ledger stays
positive**, because uncleared credit is withheld. A stored balance could not do
that without drifting. `v_balance_definition_drift` = **0 rows**;
`v_book_not_zero` = **0 rows**.

Live-fire attack 1 (`$50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not
move`) **PASSED** in this run.

> **Demo:** `/client` → the balance card. Point at the ledger figure and the
> available figure side by side, then at the held line between them.
> Command version, ~10s:
> `node -e "…" ` or the SQL above — the line to read aloud is **`accounts: 7  identity_holds: 7`**.

## 2 — Authorisation lifecycle · **PARTIAL**

**The half that holds.** Every transition in the brief exists on the book as a
real provider event, not a fixture shape:

```sql
select kind, count(*) as n, count(*) filter (where is_final) as final
from card_auth_event group by 1 order by 2 desc;
```
```
authorization              910      final 0
clearing                   488      final 37
force_post                 211      final 125
refund                     186      final 0
expiry                     143      final 143
declined                   115      final 0
authorization_reversal      77      final 0
incremental_authorization   13      final 0
```

All seven named transitions are present — including `incremental_authorization`
and `expiry`, and `clearing` at 488 events of which only 37 are final, which is
multiple and partial capture measured rather than asserted.

**"Exactly once" is a primary key, not application logic:**

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='hold_closure'::regclass;
```
```
hold_closure_pkey   PRIMARY KEY (hold_id)
```

A hold physically cannot be closed twice, in any arrival order, by any writer —
the second attempt is a duplicate-key error from Postgres. `v_hold_release_drift`
= **0 rows** confirms no hold is withholding money it should have released.

**The named half that does not hold: over-capture.** Live-fire attack 2 **SKIPs**,
and the SKIP is the honest answer rather than a gap:

> over-capture is not terminal, measured — Lithic accepted an advice for 9000
> after a 7340 over-capture of a 5000 auth, the hold reopened for 1660, and the
> network captured it.

A closure on `C >= A` would free still-authorised money. The system therefore
declines to treat capture-exceeds-auth as terminal, and the attack that wanted
to prove terminality skips instead of lying. This is a decision with a measured
basis — but it is still a lifecycle transition the gauntlet asks to see closed
and this build does not close it, so the item is **PARTIAL**, not HOLDS.

`dbcheck` carries the consequence openly as a standing red:
`v_hold_closure_unexplained` — 4 rows, `test_harness`, $132.00, `ON THE REGISTER`.

> **Demo:** run `node scripts/livefire.mjs --only 2` and read the SKIP text out
> loud — the string to point at is **"over-capture is not terminal"**. Then show
> `hold_closure_pkey PRIMARY KEY (hold_id)` for the exactly-once half. Owning the
> SKIP in front of a panel is stronger than hiding it.

## 3 — Settlement is not authorisation · **HOLDS**

All three shapes are on the book, through the same path, with no special-casing —
the discriminator is `kind` on a single `card_auth_event` table, not a branch.

**Different amount.** Measured in attack 3: a clearing of `-7340` against its own
authorisation, corrected later to the same figure — the amounts differ from the
auth and the book takes it.

**No auth at all (force post).** The strongest single number here:

```sql
select count(*) as force_post_events, count(distinct auth_id) as auths
from card_auth_event where kind='force_post';
```
```
force_post_events: 211   auths: 181
```

211 force posts stand on the book. A force post is a settlement that never had an
authorisation; it is carried by the same table, the same `value_date`, the same
posting path.

**Days later.** Clearing lags its authorisation by up to 1 day on this book
(`max_days_lag: 1`). The mechanism is date-independent — `value_date` is a column
the provider event supplies — but the *observed* spread is one day, not the
multi-day spread the brief pictures. The mechanism holds; the demonstration is
short. Item 6 below carries a real two-day lag, which is where the panel should
be pointed for that half.

> **Demo:** the SQL above. On-screen string: **`force_post_events: 211`** — then
> say "none of those 211 ever had an authorisation, and nothing branches on that."

## 4 — Out-of-order delivery · **HOLDS**

This is the cleanest result in the pass. Live-fire attack 4 **PASSED**, 1/1:

```
4  Settlement before its authorisation ends exactly where in-order does      PASS
   evidence: in-order episode a00096b7-…: ledger delta -7340, available delta -7340, hold delta 0
   evidence: clearing-first episode 3116e215-… (origin clearing_first; constructed from the
     real bodies above and re-signed with LITHIC_WEBHOOK_SECRET, POSTed clearing-first,
     HTTP 202 then 202): ledger delta -7340, available delta -7340, hold delta 0 — EQUAL
   evidence: one clearing event per transaction in both episodes; zero dead-lettered
     deliveries for msg_livefire_MTXI1F8T_*; drain HTTP 200 claimed=0 processed=0 parked=0
```

**EQUAL** is the whole claim: arrival order changed, the destination did not.
"One clearing event per transaction in both episodes" is the never-double-count
half, and the run did not crash.

The parking machinery is visible on the standing book — 37 rows held, each with a
written reason:

```
state: done 1627   dead 246   parked 37
```
```
Increase wire sandbox_wire_transfer_3keg22… carries Idempotency-Key 'corgi-itest-…',
which names no payment_instruction on this book. NOTHING WAS POSTED. Either the
instruction has not been written yet, or this wire was originated outside this system —
and a wire with no approval behind it is an incident for a person, not a row for a consumer.
```

`NOTHING WAS POSTED` is the never-double-count guarantee stated by the system
itself, at the moment it declines to guess.

> **Demo:** `node scripts/livefire.mjs --only 4`, ~40s. Point at the two delta
> lines and the word **`EQUAL`**.

## 5 — Returns and recalls · **PARTIAL** *(weakest of the ten)*

**The half that holds: the card rail, live.** Returns are booked, and they are
booked at the day the money moved, not the day we heard:

```sql
select rail, entry_type, count(*) from journal_entry
where description ilike '%return%' or description ilike '%recall%' group by 1,2;
```
```
card  original  90     card  reversal  86     ach  original  7
```
```
Reversal of 822e274f-…: RETURN_REVERSAL a26139fd-… corrects it in full
  rail card   value_date 2026-09-10   booking_time 2026-09-11   days_late 1
```

`value_date 2026-09-10, booking_time 2026-09-11` is the claim exactly: learned
Friday, **booked to Thursday**. The classifier backs it structurally —
`RETURN` is `new_event` (the money really did come back, on its own day),
`RETURN_REVERSAL` is `correction` (a mistake, repaired at the original date):

```
card  card_transaction.updated/RETURN            new_event
card  card_transaction.updated/RETURN_REVERSAL   correction
```

That distinction is the hard part of this item and the system gets it right.

**The named half that does not hold: the ACH and wire rails have never been
exercised.** The semantics table classifies all of them —

```
ach   ach_transfer.updated/returned              new_event
ach   inbound_ach_transfer.updated/returned      new_event
wire  inbound_wire_transfer.updated/reversed     new_event
wire  wire_transfer.updated/reversed             new_event
```

— but **zero such webhooks have ever been delivered**:

```sql
select event_type, count(*) from webhook_inbox
where event_type ilike '%return%' or event_type ilike '%revers%' group by 1;
```
```
(0 rows)
```

So "an outbound bounces days later" and "an inbound is recalled" are, on the ACH
and wire rails, **classified and coded but never run**. The brief's two literal
scenarios are the two that have not been driven. The card rail proves the
booking discipline; it does not prove these rails.

**What would prove it:** POST a signed
`inbound_ach_transfer.updated/returned` and an `ach_transfer.updated/returned`
body at `/api/webhooks/increase` with a `value_date` two or more days back —
exactly the construction attack 4 already performs for Lithic — then assert the
resulting entry's `value_date` equals the original settlement date and the
day's closed statement moves. The harness to do it exists; it has not been
pointed at this rail.

> **Demo:** the card half only, and say so. SQL above; the string to point at is
> **`value_date 2026-09-10 / booking_time 2026-09-11`**. Do not claim the ACH
> bounce in front of a panel — it is the one a payments person will ask to see.

## 6 — Bitemporality · **HOLDS**

The brief's scenario is on the book literally. Booking seqs **3 / 4 / 5**:

```
seq 3  original  value_date 2026-09-08  booking_time 2026-09-10  "Settlement, wrong amount"
seq 4  reversal  value_date 2026-09-08  booking_time 2026-09-10  "Reversal of 356253e8-…: merchant reversed the settlement"
seq 5  rebook    value_date 2026-09-08  booking_time 2026-09-10  "Settlement, corrected"
```

**2026-09-08 is a Tuesday. 2026-09-10 is a Thursday.** A merchant reversed
Tuesday's settlement on Thursday, and all three entries carry Tuesday's value
date. The correction is an append — `original`, `reversal`, `rebook`, bound by
one `correction_group_id`.

Both readings the brief demands are queryable, by moving one watermark:

```sql
select w.label, (select coalesce(sum(l.amount_cents),0)
   from journal_entry e join journal_line l on l.entry_id=e.id
   where e.correction_group_id='356253e8-0d0b-4ccf-9286-4e1198ad0391'
     and l.account_id='a0c41a37-2be1-5c30-bfe9-03455f048fac'
     and e.booking_seq <= w.wm) as tuesday_position_cents
from (values ('Wed: believed',3),('after reversal',4),('today: corrected',5)) as w(label,wm);
```
```
Wed: believed        9000
after reversal          0
today: corrected     7340
```

One value date, three knowledge states: Tuesday was believed to be **$90.00**,
then **$0.00**, and is now **$73.40** — and the system can still produce all
three. Attack 3 **PASSED** and drove the same shape end to end on the deployed
origin, including the statement:

```
as-believed@seq12276 closing 393251 over 124 lines; as-corrected closing 400591 over 125 lines
THE LINE THE CORRECTION ADDED: entry ea80d026-… at value date 2026-09-11, signed 7340
the fact is dated 2026-09-12 (the day we learned) and the MONEY was repaired at 2026-09-11
```

And the reason it cannot be done any other way:

```
evidence: UPDATE on journal_entry and DELETE on journal_line are both refused for
corgi_app: permission denied. A correction is an append; there is no other kind
available to this role.
```

> **Demo:** the three-line watermark query, ~15s. Point at **`9000 → 0 → 7340`**
> and say "same day, three different Wednesdays." This is the best single demo
> in the set — lead with it.

## 7 — Statements · **HOLDS**

Every published statement re-derives from events, identically:

```sql
select verdict, count(*) from v_statement_rederived group by 1;
```
```
reproduces: 62
```

62 of 62, no other verdict exists in the result. `v_statement_content_drift` =
**0 rows** — no published statement's stored content disagrees with what the
events now produce. The view compares `published_opening_cents` /
`published_closing_cents` / `published_line_count` / `content_hash` against
freshly re-derived figures at the statement's own `booking_watermark`, so
"identical every time" is checked on the hash, not on a total.

Corrections included: attack 3 above rendered the same closed day twice at two
watermarks and got 124 lines and 125 lines — the closed day absorbed the
correction and stayed reproducible at both.

> **Demo:** `/client/statements`, open a closed month, then the SQL above.
> On-screen string: **`reproduces: 62`**.

## 8 — Standing orders · **HOLDS**

```sql
select count(*) from v_standing_order_double_fire;   -->  0
```

Zero double fires across every restart and retry this book has seen.

The policy for the day the balance cannot cover them is **written and exercised**,
not just documented:

```sql
select disposition, refusal_code, count(*) from standing_order_outcome group by 1,2;
```
```
refused   INSUFFICIENT_AVAILABLE_FUNDS   17
raised    (null)                         15
```

17 refusals actually happened. The refusal is a **recorded outcome with its own
row**, not a silent skip — and the row carries the figures the decision was made
on (`observed_ledger_cents`, `observed_holds_cents`, `observed_uncleared_cents`,
`observed_available_cents`, `shortfall_cents`, `decided_at`, `decided_by_run`).
Note it refuses on **available**, not ledger — consistent with item 1.

> **Demo:** `/client` → "Recurring", then the SQL above. Point at
> **`refused INSUFFICIENT_AVAILABLE_FUNDS 17`** and then at `shortfall_cents` on
> one row — "it wrote down what it saw when it said no."

## 9 — Scheme reconciliation · **HOLDS**

All three break kinds are live, and aging is a column, not a promise:

```sql
select break_kind, count(*) as n, min(age_days), max(age_days), sum(break_amount_cents)
from v_recon_break group by 1;
```
```
in_ledger_not_file   1759   $-138,271.66
amount_mismatch       299      $1,532.84
in_file_not_ledger    268    $180,091.10
```

`v_recon_break` carries `age_days`, `break_kind`, `reason_code`,
`break_amount_cents`, `external_ref` and `explained_by` — a breaks screen with
aging, as asked.

**They planted one, and it was caught.** Attack 6 **PASSED**, 3/3, and the
control run is what makes it evidence:

```
evidence: control run over the complete file (4 rows, business date 2027-11-20):
  0 breaks carrying the LF6-MTXI1QMY- prefix
evidence: break in_ledger_not_file / unmatched_reference: ref LF6-MTXI1QMY-3,
  amount 139 cents, entry ac020e54-…, value date 2027-11-20, severity open
evidence: recon_run_break for run 310c4c32-… and loadReconView() both carry
  ref LF6-MTXI1QMY-3 as in_ledger_not_file
```

Complete file → 0 breaks. Delete one row → exactly that row breaks, by
reference, at the right amount, in both the table and the screen's own loader.

> **Demo:** `node scripts/livefire.mjs --only 6`, ~30s. Point at
> **`0 breaks`** on the control and then **`ref LF6-…-3, amount 139 cents`** on
> the planted one. The control line is the one that makes it a measurement.

## 10 — Maker-checker · **HOLDS**

**The refusal is in the database.** Attack 5 **PASSED**, 4/4:

```
evidence: instruction 607b5f15-… raised for 420000 cents (policy threshold 250000),
  approvals required 1
evidence: raw INSERT of an 'approved' event by the initiator -> SQLSTATE 42501 from
  assert_maker_checker(): "maker-checker: actor 76f9266f-… initiated instruction
  607b5f15-… and cannot approve it"
evidence: approved events for 607b5f15-…: 0 after both attempts; application refusal
  code SELF_APPROVAL
evidence: a second human approved the same instruction: 1 approved event,
  actor 9fff2b99-… (not the initiator)
```

A **raw INSERT**, bypassing the application entirely, was refused. The guard is a
trigger, `payment_instruction_event_maker_checker` on
`payment_instruction_event`, raising `42501`. The fourth line matters as much as
the third: a *different* human succeeded, so the guard blocks self-approval
rather than approval.

Thresholds are per-rail, effective-dated and argued:

```
wire      threshold 0        approvals 2   "Every wire, at any amount, needs two distinct human approvers."
usdc      threshold 100000   approvals 1   "irreversible the moment it confirms — there is no recall window"
ach       threshold 250000   approvals 1
internal  threshold 0        approvals 0   "both legs are ours, nothing leaves the FBO account"
```

**The agent surface lands in the queue.** The single cleanest number in the pass:

```sql
select a.kind, count(*) filter (where e.kind='requested') as requested,
       count(*) filter (where e.kind='approved') as approved
from payment_instruction_event e join actor a on a.id=e.actor_id group by 1;
```
```
human   requested 483   approved 258
agent   requested 193   approved   0
```

**Agents have raised 193 instructions and approved zero.** Not "are not supposed
to" — have not, across the whole history of the book. The agent surface writes
into the queue and has never once cleared it.

> **Demo:** `node scripts/livefire.mjs --only 5`, ~25s — point at
> **`SQLSTATE 42501 … cannot approve it`**. Then the SQL above and the line
> **`agent requested 193 approved 0`**. Two commands, under two minutes, and the
> second one is the one that lands.

---

## Known reds, reported as found

**Attack 7 — FAIL, as briefed.** It asserts the provider-down banner by fetching
an operator route that became `401` when the console went behind auth:

```
7  Issuing-provider webhook outage degrades visibly, invents no money      FAIL
   1/3 assertions failed — "the account UI shows a provider-down state":
   AssertionError: expected '<!DOCTYPE html><html lang="en"><head>…' to contain 'id="balances"'
```

**The money half of attack 7 passed.** The failure is the banner's *address*, not
the ledger:

```
dark window 22s: the swallowed event 481ddb5a-… produced 0 inbox rows and 0
authorisations; trial balance 0 unchanged
recovery: the backlog delivered twice (HTTP 202 then 200) produced 1 inbox row,
1 card_auth_event and 1 hold 966e6b90-…, whose memo account carries exactly 1
entry of -5000 (the $50.00 withheld once, not twice)
available -125000 -> -130000 (exactly -5000), holds 125000 -> 130000 (exactly +5000),
ledger unchanged at 0
```

Invented no money while dark, withheld exactly once on recovery. Another worker
is repointing the assertion at `/client`. Left exactly as found.

**dbcheck — 6 reds, all argued.** `v_refused_auth_hold` (311), `v_hold_expiry_drift`
(15), `v_advice_delta_unsound` (1), `v_hold_closure_unexplained` (4),
`v_pot_line_provenance` (2), `v_memo_line_placement` (15). Every one prints
`ON THE REGISTER — a standing red with a written argument. Still a FAIL, still
counted.` **Zero print `NOT ON THE REGISTER`.** The gate also proves its own
reach — 39 of 39 invariant views ranged over, and `--prove` makes every one fail
on purpose.

## The weakest of the ten

**Item 5, returns and recalls.** It is the only item where the brief's literal
scenarios — an outbound that bounces days later, an inbound that is recalled —
have **never been delivered to the system at all**. Zero return or reversal
webhooks exist in `webhook_inbox` across the whole book. What carries the item is
the card rail's `RETURN` / `RETURN_REVERSAL` traffic, which is real, correctly
split between `new_event` and `correction`, and correctly value-dated at one day
back — but the card rail is not the ACH rail, and a return is exactly where the
two rails differ most.

It is also the item with the most to lose: items 1, 6 and 7 all depend on
corrections landing at the right value date, and item 5 is the one that would
have stress-tested that at a multi-day lag. Every other item on this list has
been driven end to end at least once. This one has been driven on a substitute.

Second weakest is item 2, but for an honest reason — the over-capture SKIP is a
measured decision with a provider observation behind it, not an untested path.
