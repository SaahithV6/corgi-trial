# Gauntlet 6–10 and the stretch ladder — driven, not read

Audited 2026-09-11 against the deployed console `https://corgi-trial-psi.vercel.app`
(commit `463488a`) and the live book behind it. Every screen claim below was
established in a browser. Every ledger claim was established in SQL. Where the two
disagree the browser wins; nothing here disagreed.

Read-only audit. **No rows were written.** No form was submitted, no write action
was invoked, no fixture was created. `scripts/livefire.mjs` was not run.

The bar applied throughout is the one in the brief: *would an engineer told only the
disclosed sentence correctly predict what happens when they press the button?* Where
the answer is no, it is written up as a defect wearing a disclosure, not as an honest
answer.

---

## 6 — Bitemporality · **PASS**

A merchant reversed Tuesday's settlement on Thursday. `journal_entry` carries both
axes: `value_date` (when it happened) and `booking_seq` / `booking_time` (when we
learned). A correction is never an update — it is a `reversal` plus a `rebook`
sharing one `correction_group_id`, appended above the original.

Tuesday 2026-09-08, Ridgeline's current account, reading the same day at three
booking positions:

| booking position | Tuesday's settlement reads |
|---|---|
| `booking_seq <= 3` | `9000` — the wrong amount, as first booked |
| `booking_seq <= 4` | `0` — reversed, nothing where the merchant's money was |
| `booking_seq <= 5` | `7340` — rebooked at the corrected amount |

Seq 3 is `original` "Settlement, wrong amount"; seq 4 is `reversal` "…merchant
reversed the settlement"; seq 5 is `rebook` "Settlement, corrected". All three carry
`value_date = 2026-09-08` and `correction_group_id = 356253e8-…`. Tuesday's position
therefore changes without Tuesday's date changing, which is the whole claim.

`book_day` for 2026-09-08 closed at `booking_watermark = 36`, so the group sits
**below** the close watermark and is inside the closed day — it is a correction to a
closed day, not a late arrival to an open one.

### Correction to the handoff note

The note handed to this audit says the correction on **Ridgeline's published
statement** is the group at booking seqs 3/4/5. Measured, that is not so, and the
distinction matters because the next auditor will look for a statement that does not
exist.

- Seqs 3/4/5 are a real seeded correction on Ridgeline's account, value date
  2026-09-08. **Ridgeline has no statement for 2026-09-08.** Its statements are
  1988/2006/2008/2011 fixtures plus 2026-07-24 (v1–v4) and 2026-07-25 (v1–v3).
- The correction that actually appears on a **published** Ridgeline statement is
  group `eaf694e2-1266-43d9-b782-41101e000af4`, booking seqs **508 / 509 / 510**,
  value date **2026-07-25**: `-24,850` clearing, reversed, rebooked at `-19,850`
  ("merchant reversed the clearing and re-presented for less"). That is the
  correction the customer statement screen narrates at Version 3.

Both statements are true and neither is a defect. The handoff note conflated them.
The note was right about the thing it was warning against: `e397837a…` is not it.

### The one soft edge, named

`booking_time` on seqs 3, 4 and 5 is `2026-09-10T01:48:23.681Z`,
`…24.316Z`, `…24.397Z` — 0.7 seconds apart, all on Thursday. The *narrative* is
"booked Tuesday, reversed Thursday"; the *data* is "all three booked within one
second of each other at seed time". Belief at a past instant is therefore
reconstructible by **booking position**, which is exact, and is **not** reconstructible
by wall-clock timestamp, which would answer "what did you believe on Wednesday?"
with "nothing, none of this existed yet."

This is not a defect in the model — booking_seq is the correct as-of axis and the
screens use it. It is a limit on what the seeded fixture can demonstrate, and an
engineer told only "the system can prove what it believed on Wednesday" would
reasonably expect a time-addressed query to work. Say *booking position*, not
*Wednesday*, and the claim is exact.

**Not reached:** the operator time-travel control at `/statements` and
`/accounts` (`time-travel.tsx`) was not driven in the browser. The watermark walk
above is SQL. What would settle it: open `/statements`, move the as-of control to
positions 2, 4 and 5 and read `9000 → 0 → 7340` off the screen.

---

## 7 — Statements reproducible forever · **PASS**

`v_statement_rederived` re-derives every published statement from the journal at its
own frozen `booking_watermark` and compares to the stored `content_hash`.

**62 of 62 rows, verdict `reproduces`. There is no other verdict in the view** —
not `drifts`, not `ambiguous`, not null. That is the strong form: the failure
verdicts exist in the view's vocabulary and no row reaches them.

Corrections are included rather than smoothed away. Ridgeline 2026-07-25 goes
v1 (watermark 508, 2 lines) → v2 (510, 4 lines) → v3 (982, 4 lines): the line count
rises because the reversal and the rebook are *both* on the statement, and v3 at a
far later watermark still closes at the same `2,206,105` as v2 — later bookings did
not disturb a closed day.

Driven on the customer surface at `/client/statements`, the page renders, in its own
words:

- `Version 3`
- `Day signed off · issued 2026-09-11T04:45:57.542Z · frozen at booking position 982`
- `A correction is on this statement`
- `This statement was rebuilt twice while this page loaded, and came out identical both times`
- `Earlier versions of this day` — Version 1 and Version 2, kept, not replaced

The last one is the part that matters: the screen does not assert reproducibility, it
performs it on load and reports the result. A customer, not an operator, sees this.

---

## 8 — Standing orders, once and only once, with a written policy · **PASS**

This was flagged as the one most likely to be soft. It is not. It is the strongest
of the eleven.

### The policy is on the customer's screen, in words

`/client/standing-orders` carries a section headed **"If the money is not there on
the day"**, subtitled *"Written down before it happens, so it is a rule and not a
surprise."* It states, on the screen, to the customer:

- the payment is **refused and closed** — not sent short, not carried over, not queued;
- the next occurrence is **unaffected** and comes round on its own date;
- the test is against **available** balance, not ledger balance, and it says why:
  unsettled card authorisations, uncleared credits, and debits already booked to a
  future value date;
- that a payment can therefore be refused on a day the ledger figure looked
  sufficient — and that *both* figures are recorded on the row;
- **why** partial payment is refused ("$2,613.44 is a different payment — it will not
  match the invoice") and **why** carry-forward is refused ("the debit then lands on
  a day nobody chose, at a size nobody expected, possibly doubled");
- a separate rule that an occurrence more than five days late is refused rather than
  paid unannounced.

This is a policy, on a screen, in the customer's language, not a paragraph in
`docs/STANDING-ORDERS.md`. It survives the test in the brief exactly.

### The refusal path actually fires

The customer's own history table ("What has happened — a refusal is a row here,
never a silence") shows real refusals with the shortfall on the row:

```
2026-09-11  Quarterly equipment settlement  $4,278.40  Not sent
            On the day: ledger $27,357.07, available $4,177.57, short by $100.83
2026-09-11  Quarterly equipment settlement  $17,651.89 Not sent
            On the day: ledger $41,134.49, available $17,568.49, short by $83.40
2026-09-10  Rent — Unit 4, Ridgeline Works  $4,000.00  Not sent
            On the day: ledger $50,274.52, available -$1,601.48, short by $5,601.48
```

Backed in the schema: `standing_order_outcome` stores `refusal_code`,
`refusal_reason`, `observed_ledger_cents`, `observed_holds_cents`,
`observed_uncleared_cents`, `observed_pending_outbound_cents`,
`observed_available_cents` and `shortfall_cents` — the observation as of the day, not
a figure recomputed later. The negative-available case renders as
`available -$1,601.48 / negative $1,601.48`, so a customer is not left to parse a
minus sign.

### Once and only once is a constraint, not a convention

```
standing_order_occurrence_once     UNIQUE (standing_order_id, scheduled_date)
standing_order_occurrence_key_once UNIQUE (idempotency_key)
```

`v_standing_order_double_fire` returns **0 rows**. The screen explains the mechanism
rather than asserting the outcome: *"the second attempt collides with the first and
does nothing. That is what stops you being charged twice — not the scheduler being
careful, which is a thing software forgets to be."* A restart, a retry and two
concurrent runners all land on the same unique key.

---

## 9 — Scheme reconciliation with aging · **PASS, with one defect in the aging column**

All three break categories exist in the book and are named on the screen, no more and
no fewer:

| break_kind | rows | age_days min | age_days max |
|---|---|---|---|
| `in_ledger_not_file` | 1,776 | **−453** | 153,565 |
| `amount_mismatch` | 299 | 0 | 153,565 |
| `in_file_not_ledger` | 268 | 0 | 153,565 |

Driven at `/reconciliation`, the breaks screen renders category chips
(`All 1 · In file, not in ledger 0 · In ledger, not in file 1 · Amount mismatch 0`)
and an explicit **AGE** filter row (`Any · 0-1 days · 2-3 days · 4-7 days · 8-30 days ·
31+ days`), with an **AGE** column on every row. A person finds a break by clicking a
chip, not by writing a query. `PAST A CLOSE 0` is a separate tile —
`closes_crossed` is a real column, so "how many closes has this survived" is answered
alongside "how old is it".

`/breaks` goes further and classifies each break against the book:
`UNEXPLAINED 1 · CORRECTION IN FLIGHT 0 · CORRECTED 0 · CORRECTED, STILL SHORT 0`,
each with an outstanding amount and a `show only these` filter. That is the right
shape — a break the book can narrate is ranked differently, never hidden.

The planted row is findable by a person: `In ledger, not in file · LF6-MTX1R8MG-3 ·
$240.71 · +$240.71 · Open`, reached in two clicks from the nav. Planted
`in_file_not_ledger` rows carry `PLANT-…-UNBOOKED` references and are present in
quantity.

### Defect: the aging column renders negative ages

115 of the 1,776 `in_ledger_not_file` breaks have **negative** `age_days`, minimum
**−453**. The screen prints this verbatim: the live break reads **`-453d`** with
`day still open` beneath it, and the age filter simultaneously classifies it under
**`0-1 days`**. A break cannot be minus 453 days old.

The cause is a file whose `business_date` is `Dec 08, 2027` — in the future relative
to today, 2026-09-11 — so `age_days` is a signed date difference that was never
clamped or rejected. The consequence is not cosmetic: an ops person triaging by age
will find the oldest, worst breaks sorted to the *young* end of the list, and the
`31+ days` bucket will under-count. "Worst first, then oldest, then largest" is the
screen's stated sort, and for these 115 rows it is wrong.

Nothing discloses this. It is not a disclosure covering a defect — it is an
undisclosed defect. Either reject a settlement file dated in the future at ingest, or
clamp `age_days` at 0 and render "dated in the future" as its own severity.

---

## 10 — Maker-checker · **PASS**

Enforced by a database trigger, `assert_maker_checker()`, not by a screen. On any
`payment_instruction_event` of kind `approved`:

```sql
-- (a) an automated surface can never approve
IF v_actor.kind <> 'human' OR NOT v_actor.can_approve THEN
  RAISE EXCEPTION 'actor % (kind %) is not an approver' USING ERRCODE = '42501';

-- (b) the initiator can never approve their own payment
IF NEW.actor_id = v_pi.requested_by THEN
  RAISE EXCEPTION 'maker-checker: actor % initiated instruction % and cannot approve it';

-- (c) approve-the-hash
IF NEW.approved_content_hash IS DISTINCT FROM v_pi.content_hash THEN
  RAISE EXCEPTION 'approval for % cites the wrong content hash';
```

(c) is the one nobody asks for and it is the one that matters: an approval is bound
to the exact content it approved, so amending a payment after approval invalidates the
approval rather than riding on it.

On `submitted`, the threshold check counts `DISTINCT actor_id` where
`a.kind = 'human'` **and** `e.actor_id <> v_pi.requested_by` — the initiator's own
approval cannot be counted toward the required number even if one were somehow filed.
A second trigger, `assert_team_maker_checker()`, adds tenancy, current-role and
**independence** (`an admin's payment needs a peer admin or a Corgi staff approver`),
taking `lock_business_team()` first so a removal in flight cannot race the read.

**The agent surface: 0 approvals, and it is structurally 0.** `actor` holds 596
`human`, 3 `system`, 1 `agent`. `v_payment_approval_census` returns exactly two rows —
`corgi_staff_break_glass` 203 and `member_with_the_right` 56, both
`is_violation = false`. **There is no agent row, no self-approval row, and no
violation row anywhere in the census or in `v_payment_approval_judged`.** The agent
tried: `mcp_audit` records `approve_payment` twice and `approve_instruction` once,
all `protocol_error`. It is refused at the same place a person is refused, by clause
(a), which is what "neither can the agent surface" has to mean.

I could not reproduce the exact figure "agent requested 193" from the tables I read
(`mcp_audit` shows 7 `initiate_payment` calls across all outcomes). **Approved 0 is
confirmed and is the load-bearing half.** The 193 needs its source named by whoever
quoted it.

### Driven in the browser

At `/approvals`, signed out, acting as Approver, the pending queue renders a payment
whose `INITIATOR` is `Dana Okonkwo` with a `that is you` badge beside the name, and
beneath it:

> `1 of 1 approval held — distinct humans, none of them Dana Okonkwo.`

The Approve button is rendered **disabled**, and the reason beside it is specific to
*why*, not generic:

> `You raised this payment, so you cannot approve it. The initiator is never the
> checker — and this is …`

Six such rows render with that reason. This is the finding the browser was needed
for: the page is also globally read-only (`SIGN_IN_REQUIRED`), and a lazier
implementation would have let the sign-in disable swallow the self-approval disable,
leaving the maker-checker reason untested and invisible. It does not. The two reasons
are distinct and the self-approval one is the one shown on the initiator's own row.

The screen states its own status correctly: *"Where you see a disabled button below,
the screen is telling you in advance what the database would do. It is not the check.
Every decision is sent to Postgres and refused there."* That sentence passes the
brief's test — an engineer told only that would correctly predict that removing the
`disabled` attribute changes nothing.

---

## Stretch ladder

The standing claim under audit: *every stretch item exists on both the customer and
the operator surface, except interest accrual and payee confirmation, which are
operator-only by design.*

Route-level, the claim's shape holds: `src/app/(app)/client/` contains `payouts`,
`cards`, `pots`, `disputes`, `statements`, `standing-orders`, `pay`, `funding`,
`activity`, `approvals`, `team`, `open` — and contains **no** `accruals` and **no**
`payees`. Those two are operator-only, as stated.

### 1. USDC payout with a customer-accepted FX quote · **PASS**

`fx_quote` 124 · `fx_quote_acceptance` **46** · `fx_quote_settlement` **9**.
Acceptance is a separate table from the quote, so "the customer accepted *this* rate"
is a fact with its own row rather than a field on the quote that could be backdated.
`v_fx_commitment_unheld` = **0**: every accepted commitment has its
`fx_commitment_hold`, so no accepted quote is exposed to rate movement without the
money being held against it. Customer surface `/client/payouts` and operator
`/payouts` both exist. **Not driven in the browser** — reachability is from the route
tree and the nav (`Send abroad` on the customer bar, `Payouts` on the operator bar),
not from a walked flow.

### 2. Card controls enforced in the real-time auth decision · **PASS on the customer surface, SOFT on "enforced"**

Driven at `/client/cards`: a customer gets real, usable controls — `Most in one
payment`, `Most in a day`, `Most in a month`, `Merchant types this card cannot be
used at`, an `active` / `frozen` radio pair, and a per-card `Freeze … now` button.
That is the customer half, and it is genuine.

The enforcement half does not fully hold up. `v_card_auth_judged_census`:

| source | outcome | judged | decisions |
|---|---|---|---|
| provider | approve | **false** | **98** |
| provider | approve | true | 13 |
| provider | decline | true | 14 |
| provider | decline | false | 4 |
| harness | approve | true | 44 |
| harness | decline | true | 36 |
| harness | decline | false | 8 |

**`v_card_auth_approval_unjudged` returns 98 rows, $4,345.09 of approvals that our
controls never judged.** The real-time path demonstrably works — 14 provider declines
and 36 harness declines *were* judged against a rule — but 98 provider approvals went
through with `judged = false`. `v_card_control_coverage` explains most of it: many
cards read `cover = 'uncontrolled'` (`has_controls = false`, `control_version = null`),
so there was no rule to apply.

That is defensible and it is also exactly the shape the brief warns about. "Card
controls are enforced in the real-time auth decision" is true of a controlled card and
silently untrue of an uncontrolled one, and an engineer told only that sentence would
not predict 98 unjudged approvals. The honest sentence is: *controls are enforced on
cards that have them; a card with no control version is approved unjudged, and the
count is on the board.* The count being on the board — as a named view, not a
footnote — is the redeeming part, and is why this is soft rather than a defect wearing
a disclosure.

### 3. Interest or fee accrual visible on the ledger · **PASS** (operator-only, correctly disclosed)

`interest_posting` 29 · `accrual_posting` 37. The drift views are the proof:
`v_interest_ledger_drift` **0**, `v_accrual_ledger_drift` **0**,
`v_interest_unresolved` **0**. Drift zero means the accrual subledger and the journal
agree — accrual is *on* the ledger, not beside it in a table that happens to render.
Operator-only is stated and is true: there is no `client/accruals` route. **Not driven
in the browser** — `/accruals` was not opened.

### 4. Sub-accounts / pots as pure ledger moves · **PASS**

`v_pot_negative` **0** · `v_pot_orphan` **0** · `v_pot_identity_drift` **0**.
Identity-drift zero is the one that makes "pure ledger moves" real: a pot's balance is
derived from journal lines and cannot disagree with them, so moving money into a pot
is a posting and not a counter. `v_pot_line_provenance` carries 2 rows, and the
guard `v_pot_guard_disarmed` exists as a check on the check. Both surfaces present
(`/pots`, `/client/pots`). **Not driven in the browser** by me — another agent held
`/client/pots` open in a separate tab during this window.

### 5. Dispute intake with provisional credit · **PASS**

29 disputes, **25 with `provisional_credit_granted`**, and
`v_dispute_ledger_double_count` **0** — the provisional credit is not counted twice
against the customer's balance, which is the failure mode this feature invites.
`assert_dispute_lifecycle()` is a full state machine in the database: provisional
credit cannot be authorised by a non-human or by the raiser or by anyone belonging to
the customer being advanced money; a granted credit **must** cite both its
`entry_id` and its `hold_id` (*"an event that says 'credit granted' without an entry
is a claim the ledger cannot confirm"*); a dispute with credit outstanding cannot be
quietly `withdrawn` — it must be recorded lost and then clawed back or written off.
Both surfaces present (`/disputes`, `/client/disputes`). **Not driven in the browser.**

### 6. Payee confirmation catching a mistyped account · **PASS** (operator-only, correctly disclosed)

`payee` 478 · `payee_verification` **491** · `payee_acknowledgement` **94** ·
`payee_candidate_refusal` **34**. The 34 refusals are the claim: candidates that were
put forward and **refused**, which is what "catching a mistyped account" has to look
like in data. Acknowledgement is a separate table from verification, so "we checked"
and "the customer confirmed" are distinct facts.

The customer surface is not blind to it: `/client/standing-orders` states *"Only
payees you have already confirmed"* under the payee picker, and the picker's options
include a payee named **`Never checked — account ending 1111`** — so an unconfirmed
payee is visible *and labelled as unconfirmed* to the customer. The confirmation
**step** itself is operator-only, as disclosed. **Not driven in the browser** —
`/payees` was not opened.

---

## Disclosures judged to be covering a defect

1. **Aging on the breaks screen (item 9).** No disclosure at all, and a real defect:
   115 breaks carry negative `age_days`, rendered as `-453d`, bucketed into
   `0-1 days`. The screen's stated sort ("worst first, then oldest") is wrong for
   those rows. This is the one thing in 6–10 that would mislead an operator doing
   their job.
2. **"Card controls enforced in the real-time auth decision" (stretch 2).** The
   sentence does not predict 98 unjudged provider approvals on uncontrolled cards.
   Not concealed — `v_card_auth_approval_unjudged` is a first-class view and the
   number is readable — but the summary sentence is broader than the behaviour.
   Narrow the sentence to the cards it is true of.
3. **"Prove what it believed on Wednesday" (item 6).** Provable by booking position,
   not by timestamp; the fixture's three bookings are 0.7 seconds apart. The claim as
   worded overpromises a time-addressed query the data cannot answer. The model is
   right; the sentence should say *booking position*.

Nothing else in these eleven read as a euphemism. Items 7, 8 and 10 in particular
state their own mechanism rather than their own success, which is the opposite
failure mode from the one being hunted.

## Weakest of the eleven

**Stretch 2, card controls in the real-time auth decision.** It is the only item where
the capability is genuinely present, genuinely reachable from the customer's own
screen, and still does not do the thing its sentence claims for a measurable and
material slice of traffic — 98 approvals, $4,345.09, judged by nothing. Items 6–10
either hold outright or hold with a naming problem. This one holds with a coverage
hole, and coverage holes are what an auditor plants against.

Item 9's negative aging is the worse *bug*; stretch 2 is the weaker *claim*.

## What I did not reach

Stated plainly rather than skipped quietly. A skip is not a pass.

- The operator time-travel control at `/statements` / `/accounts` — item 6's
  watermark walk is SQL-proved, screen-unproved.
- `/payouts` and `/client/payouts` driven end to end (stretch 1).
- `/accruals` opened (stretch 3).
- `/pots` and `/client/pots` driven (stretch 4).
- `/disputes` and `/client/disputes` driven (stretch 5).
- `/payees` opened (stretch 6).
- The `/reconciliation` settlement-file picker, which would show all three break
  categories on one file rather than the one category the default file carries. The
  three categories are proved present in the book by SQL and proved present as chips
  on the screen; a single file exercising all three was not exhibited.

Each of those is a five-minute browser walk. What would settle every one of them is
the same thing: open the screen, and press the control.
