# Holds — and the closure row we deliberately do not write

This file settles one question that had been left open through three passes of
the build: **on a fuel-pump over-capture, why is there no `hold_closure` row?**

It is settled by measurement, not by argument. The short version:

> Writing that row requires over-capture to be *terminal* — nothing may raise
> the authorised amount afterwards. **It is not terminal.** Measured against the
> Lithic sandbox: after a clearing that exceeds the authorisation and drives the
> transaction to `SETTLED` with `amounts.hold.amount = 0`, Lithic accepts an
> incremental authorisation (`201`, `AUTHORIZATION_ADVICE … result: APPROVED`),
> the hold reopens for the un-captured remainder, and the network then really
> captures that remainder. A closure row written at the over-capture would have
> freed money that was still authorised.

So `closed(E)` keeps its four arms, the `C ≥ A` migration was **not** written
(the number 0026 has since been taken by the declined-authorisation fix, §7), and
live-fire attack 2 skips its "one closure row" claim on the strength of a
measurement that is re-taken on every run.

**Then the fuzzer found the same mistake one disjunct over.** `A ≤ 0` is also a
condition a later incremental can undo, it also licensed a permanent row, and
neither this file nor migration 0011 had looked at it. That is **§8**, migration
**0028**, and it is the more important half of this document.

**Then the mirror arrived: a hold withholding *nothing* while the fold said $50
was authorised.** That is **§9**, migration **0036** — the two-phase split
removed, an automatic sweep for the openings no delivery will ever finish, and,
in **§9.8**, the one property that separates `v_hold_drift` from the nineteen
guards on this build that reported healthy while the thing they watched was
broken.

---

## 1. The model, for context

`src/lib/holds/model.ts`, mirrored exactly by `v_card_auth_hold` in migration
0001:

```
A(E) = Σ amount over {authorization, incremental_authorization}
     − Σ amount over {authorization_reversal}
C(E) = Σ amount over {clearing, force_post}

closed(E)        = sawFinal ∨ sawClose ∨ expired ∨ (count > 0 ∧ A ≤ 0)
terminallyClosed = sawFinal ∨ sawClose ∨ expired            ← 0028; see §8
H(E)             = 0                   if closed(E)
                 = max(A − C, 0)       otherwise
```

Three things follow that the rest of this file leans on.

**`H` is a function of the event SET.** Σ, ∃, `max` and one clock comparison are
all permutation-invariant, which is the whole out-of-order story.

**The TypeScript and the SQL are held equal by an invariant, not by discipline.**
`v_hold_drift` compares the memo book against `v_card_auth_hold.target_hold_cents`
for every hold that is not released. Change `closed(E)` in one place and the
invariant reports drift — and an invariant reporting drift is indistinguishable
from a ledger that has actually drifted. **Any change to `closed(E)` is one
migration that moves both, or it is not made.**

**That rule is about `closed(E)`, and only about `closed(E)`.** The two
predicates answer different questions — `closed` is "withhold nothing NOW",
`terminallyClosed` is "…and nothing can undo that" — and only the first has a
counterpart in SQL. `v_card_auth_hold.is_closed`, `v_hold_state.is_released`,
`ledger_availability()` and `holdItemisationAsOf()` all express `closed(E)`.
**Nothing in the database has ever expressed `terminallyClosed`**, which is
precisely how it was able to be wrong for the whole build with every invariant
green. §8 is what happened.

## 2. The question

An over-capture — `A = 5000`, `C = 7340` — satisfies none of the four closure
arms. `sawFinal` is false because Lithic's `CLEARING` carries no last-capture
flag; nothing closed or expired; `A = 5000 > 0`. So `closed(E)` is **false**, and
`H = max(5000 − 7340, 0) = 0` by the `max`, not by the closure.

The money is right either way: the release posting takes the hold's memo balance
to zero and `availableBalance` reads that balance. What is absent is a
`hold_closure` row, which the published attack's wording ("the hold releases
exactly once") can be read as naming.

The candidate fix was a fifth arm, `C ≥ A`. It is **arithmetically a no-op for
`H`** — `max(A − C, 0)` is already 0 once `C` reaches `A`. Its only effects are:

1. it writes a `hold_closure` row, which is append-only, `PRIMARY KEY (hold_id)`;
2. it makes `v_hold_state.is_released` true, which zeroes `active_hold_cents`
   **regardless of the memo balance**.

Both effects are about what happens *next*. So the question was never "does the
arm break `H`". It was: **is over-capture terminal?**

## 3. The measurement

Run 2026-09-11 against `https://sandbox.lithic.com/v1`, and re-run by live-fire
attack 2 on every invocation. Card created for the measurement is deliberately
**not** registered with `registerCard`, so the probe cannot move the ledger.

| # | Call | Result |
| --- | --- | --- |
| 1 | `POST /v1/simulate/authorize` `{amount: 5000, …, status: "AUTHORIZATION"}` | `201`, transaction token |
| 2 | `POST /v1/simulate/clearing` `{token, amount: 7340}` | `201`; transaction → `status: SETTLED`, `amounts.hold.amount: 0`, `amounts.settlement.amount: -7340`, event `CLEARING 7340 result APPROVED` |
| 3 | **`POST /v1/simulate/authorization_advice` `{token, amount: 9000}`** | **`201`**; transaction gains event **`AUTHORIZATION_ADVICE 9000 result APPROVED`** |
| 4 | `POST /v1/simulate/clearing` `{token, amount: 1660}` | `201`; event `CLEARING 1660 result APPROVED`, `amounts.settlement.amount: -9000` |

Two transactions carrying the full sequence, from two separate runs:
`1df0baa5-319c-46cb-8e19-fcec89b55f56` and
`faae9502-16fe-4020-8374-40b54f47bd70`.

`authorization_advice` is Lithic's sandbox mechanism for an incremental
authorisation, and its `amount` is **absolute, not a delta**
(`research/lithic/NOTES.md` §3c): `9000` means "the authorised amount is now
$90.00", not "add $90.00".

### What our own model makes of those events

`deriveCardEvents` + `holdState`, fed the real transaction as Lithic returns it:

| after | A | C | `closed` | H |
| --- | --- | --- | --- | --- |
| the authorisation | 5000 | 0 | false | 5000 |
| **the over-capture (step 2)** | 5000 | 7340 | **false** | **0** |
| **the incremental (step 3)** | **9000** | 7340 | **false** | **1660 — reopened** |
| the second clearing (step 4) | 9000 | 9000 | false | 0 |

The row that matters is the third. **The hold comes back, for exactly 1660 — and
step 4 shows the network then captured exactly that 1660.** The model's reopened
figure was not a bookkeeping artefact; it was the money the merchant went on to
take.

Note that Lithic's own `amounts.hold.amount` read `0` throughout steps 2–4 and
was wrong about step 3 — the same trap DECISIONS 006 records for `status`. Our
arithmetic tracked the network's *behaviour* where the network's own field did
not.

## 4. The decision

**Leave `closed(E)` alone. No `C ≥ A` arm. No migration for it.** (The number
0026 was reserved for it at the time and has since gone to the
declined-authorisation fix, §7. The `A ≤ 0` arm that §8 removes is a *different*
disjunct and a different migration, 0028.)

The argument, in the order the objections arrive:

**"The arm is free — `H` is 0 either way."** True of `H`, false of
`is_released`. At step 3 the model wants 1660 withheld. With the arm, the
`hold_closure` row written at step 2 is still there — append-only, one row per
hold — and `v_hold_state.is_released` reads it first, so `active_hold_cents`
would be forced to 0 while the memo book says 1660. The customer would be free
to spend money the network has authorised and is about to take.

**"But `hold_closure_reversal` exists now (migration 0011) — a wrong closure is
correctable."** It is, and that genuinely changed the shape of the risk: the
failure is no longer permanent, and `v_hold_release_drift` (`is_released` AND
`memo_balance_cents <> 0`) catches exactly the state that used to hide from
`v_hold_drift`'s `WHERE NOT is_released`. That was the objection that kept this
open, and it has moved.

It does not carry the decision, because *correctable* is not *correct*. Adding
the arm means knowingly shipping a writer whose normal output is the row that
0011 was written to clean up — $60 across three holds, freed, invisible. The
reversal machinery is a repair path for a bug we fixed, not a licence to
reintroduce the bug behind it. Every over-captured hold that later takes an
incremental would need an operator to notice a drift row and append a
compensating entry, to buy a row that changes no number.

**"Isn't `DESIGN.md` §8.3 row 2 saying this case closes?"** Read the arrival
order in that row: `auth 50 → clearing 73.40 **final**`. Row 2 stipulates a
final flag, and it closes on `sawFinal`, not on `C ≥ A`. Lithic's `CLEARING`
carries no such flag, so row 2 is not the row that applies to the live attack.
The rows that do apply are §8.3 **row 5** ("Multiple captures, never flagged
final … `closed: n (A−C=0)`") and **row 12** (clearing-not-final then a late
auth, `closed: n → n`), and **both say the hold is not closed**. The transition
table and `model.ts` agree.

The one artefact that does disagree is the ASCII diagram in §8.2, whose
`OVER/EXACT CAPTURED` box flows into a state labelled `TERMINAL: H = 0 forever`.
`model.test.ts` already carried a comment flagging that diagram as looser than
the SQL. **The measurement above falsifies that box directly**: H went 0 → 1660.
The diagram is the thing to amend, not the model. (`research/DESIGN.md` is
frozen source material for this build; the correction is recorded here.)

**"So where does the closure row come from?"** From something that really is
terminal, via `terminallyClosed` — `sawFinal` (a single-message
`FINANCIAL_AUTHORIZATION`, or an `AUTHORIZATION_EXPIRY`), an explicit operator
`closeHold()`, or the seven-day expiry sweeper. `terminallyClosed` already
narrows the `A ≤ 0` arm with `sawAuthorisation` for the same reason this file
gives: a clearing-first identity has `A = 0` because nothing authorised anything
yet, and closing on it would free a hold the late authorisation is about to
open. The over-capture belongs on the same distinction, on the same side of it.

### What would flip this decision

One measurement: **Lithic refusing an incremental after an over-capture.** If
`POST /v1/simulate/authorization_advice` on an over-captured transaction returns
a non-`201`, or appends an `AUTHORIZATION_ADVICE` with `result` other than
`APPROVED`, then over-capture is terminal in fact and the `C ≥ A` arm is safe.
Attack 2's measurement test checks for exactly that outcome on every run and
**skips loudly, naming this file**, if it ever sees it. The decision is wired to
its evidence rather than filed away.

If that day comes, the change is one migration (0026 or its successor) that
moves **both** `closed(E)` in `model.ts` and `v_card_auth_hold.is_closed` in
SQL, with the closure written through the `terminallyClosed` path, and
`v_hold_drift` empty afterwards proving the two still agree.

## 5. What live-fire attack 2 now says

`src/test/livefire/attack-02-over-capture-release.test.ts`, three tests:

1. **The money claim — PASSES.** Authorise $50.00 on a registered card, clear
   $73.40, then read the live database: exactly two memo entries against the
   hold (−5000 and +5000, netting to zero, so exactly one release posting and no
   second is representable), exactly one financial entry of 7340 under the
   transaction's `external_ref`, `holdsCents` back where it started, and
   `available == ledger − holds − uncleared` exactly, in integers, with no floor.
2. **The measurement — PASSES.** Runs the sequence in §3 against Lithic on an
   unregistered card and asserts that the post-over-capture incremental is
   approved and that `holdState` reopens the hold to 1660, which the network then
   captures. If Lithic ever refuses, this test skips with the refusal quoted, and
   that skip is the signal to revisit §4.
3. **The closure-row claim — SKIPS, by decision.** The skip reason now quotes the
   measurement taken on that same run — transaction token, HTTP status, the
   approved advice, the reopened amount — rather than citing a disagreement
   between two documents. It also states where the row does land.

A skip is not a pass and is never counted as one. This one names a measured
provider behaviour, which is worth more than a green tick bought by writing a
row we have measured we would have to reverse.

## 6. The invariant pair — now a trio

The first two must be empty, always, and they cover every hold row between them:

* `v_hold_drift` — a **live** hold's memo balance equals the fold over its card
  events. Defined `WHERE NOT is_released`.
* `v_hold_release_drift` — a **released** hold withholds nothing
  (`memo_balance_cents = 0`). Migration 0011's complement, added because a
  spurious closure sets `is_released` and therefore hid itself from the first
  view.

Both of those catch the **damage**. Migration 0028 added the one that catches
the **cause**, one step earlier:

* `v_hold_closure_not_terminal` — a `hold_closure` the posting path wrote, not
  since reversed, whose fold over the full event set now says the authorisation
  is **open**. A closure the model no longer believes is a closure that was
  written on a reversible condition, which is 0011's bug and 0028's bug both.
  It reports before the memo book has moved, so before any money is misstated.

Note that `v_hold_closure_not_terminal` is **not yet in `scripts/dbcheck.mjs`**,
whose `INVARIANT_VIEWS` list is hardcoded and was outside 0028's mandate. It is
read by `scripts/repair-0028-premature-closures.mjs` on every run, which is
exercise but is not CI. The one-line addition is written into the migration.

Confirmed empty before and after this work; `node scripts/dbcheck.mjs` is green
on all its checks (28/28 after 0028 was applied).

Measured while considering the arm: **88 card-auth holds** in the live database
currently satisfy `C ≥ A` with `is_closed = false` (87 strictly over-captured,
1 exact), and **every one of them has a memo balance of 0**. So adding the arm
would not have alarmed either view *today*. That is precisely what makes it a
trap — it looks free right up until the first incremental arrives on an
over-captured hold, and then it is silent in one view and only caught by the
other.

## 7. The declined authorisation that held the customer's money — CLOSED

This section used to be headed "Open, and not mine to close here". It named the
bug, named the transaction, and handed it on. Migration **0026** closes it.

### 7.1 What was wrong

A Lithic `AUTHORIZATION` carries a `result`: `APPROVED` when the network
authorised the money, and something else when it did not. `deriveCardEvents`
never read it. Not "read it and branched wrongly" —
`src/lib/holds/lithic-events.ts` contained **zero** occurrences of `result`,
`APPROVED` or `DECLINED`, and `card_auth_event` had **no column to put the
answer in**: `id, auth_id, kind, amount_cents, is_final, value_date,
provider_event_id, inbox_id, received_at`. An approved authorisation and a
refused one were, row for row, **literally the same row**.

So every refusal raised `A(E)` by its full amount and withheld the customer's
money — for nothing — until the seven-day expiry sweeper reached it.

The trigger was mundane and is worth stating because it is the sort of thing
that happens in production: the sandbox account carries a **$5,000 rolling
24-hour spend limit**, a live-fire run exhausted it, and authorisations started
declining. Live-fire attack 2's own authorisation, Lithic transaction
`041d610c-a71a-432e-ad62-ca16b6d882b0`, reads

```
AUTHORIZATION 5000 result DECLINED detailed_results ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]
```

and the ledger placed the full $50.00 hold on it. **Attacks 1 and 2 were
passing because we ingested declines as approvals.** Their arithmetic was
right; their input was fabricated.

### 7.2 Blast radius, counted rather than estimated

Counted from the raw provider payloads retained in `webhook_inbox`, which
`webhook_inbox_guard()` makes immutable, on 2026-09-11:

| | At first measurement | At final repair |
| --- | --- | --- |
| authorisations carrying a refused A-raising event | 60 | **90** |
| authorised amount that never existed | $2,951.00 | **$4,451.00** |
| holds **still withholding money** | 24 | — |
| holds repaired | — | **40** |
| reversal entries appended | — | **40** |
| money returned to customers | — | **$1,951.00** |

Verdicts seen: `DECLINED` (the overwhelming majority),
`UNAUTHORIZED_MERCHANT`, `UNKNOWN_HOST_TIMEOUT`, `USER_TRANSACTION_LIMIT`.

By business, as repaired:

| Business | Holds | Returned |
| --- | --- | --- |
| Kettle & Crumb Bakery LLC | 28 | $1,400.00 |
| Holds Integration Fixture Co. | 10 | $500.00 |
| Ridgeline Robotics, Inc. | 2 | $51.00 |

**Why the number grew while it was being fixed, and why that is the finding
rather than an embarrassment.** The first count — 24 holds, $1,151.00 — was
taken an hour before the migration; 27 were repaired when it ran; 13 more
arrived afterwards and were repaired by a re-run of the migration's own §4 and
§6 logic, which is idempotent at every step (`ON CONFLICT` on the verdict table
and on `hold_closure`, `reversal:<entry id>` as the ledger idempotency key).

Those 13 did not come from nowhere. **They were created by the deployed
production build, which still carries the pre-0026 ingest**, while the live-fire
suite ran against it. Every figure here is a snapshot of a bug that is still
being committed by the host serving the demo URL, and it will keep growing until
that host is redeployed. See §7.9.

Holds that were no longer withholding anything had already been swept by the
seven-day expiry clock. That is not a defence. The customer could not spend
their own money for a week because a transaction the network refused looked to
us exactly like one it approved.

Two of the refusals deserve naming. `UNAUTHORIZED_MERCHANT` on
`b1bd8d71-554a-46fc-b80a-fe90044868a8` is **our own ASA responder** declining a
merchant-category block — the card-controls feature working perfectly — and then
the ledger withheld $50.00 anyway. `UNKNOWN_HOST_TIMEOUT` /
`CUSTOMER_ASA_TIMEOUT` on `936326fe-7cca-4d39-b4be-9a2022f12e1b` is our
responder failing to answer inside Lithic's window, which declined the
transaction, and we held $1.00 against it.

### 7.3 Why no invariant saw it — the fourth blind spot of the same shape

`v_hold_drift` and `v_hold_release_drift` cover every hold row between them
(§6), and **both were empty throughout**. They were telling the truth.

`v_hold_drift` compares the memo book against the fold over `card_auth_event`.
The memo book said 5000. The fold said 5000. They agreed exactly — because the
fold's input had already thrown the verdict away at the front door. **Two
derivations of the same impoverished input agree perfectly, and that agreement
is what the invariant measures.** It is not the same thing as being right.

This is the fourth time this exact shape has appeared in this build:

| | The guard | Why it could not see the bug |
| --- | --- | --- |
| 0011 | `v_hold_drift` | defined `WHERE NOT is_released`, and the bug set `is_released` |
| 0023 | `v_standing_order_double_fire` | joined on a UNIQUE column, so no database state could make it return a row |
| 0023 | `standing_order_outcome`'s identity | asserted four terms after 0022 gave availability a fifth |
| **0026** | `v_hold_drift` / `v_hold_release_drift` | both derived from the same event set, which had already lost the field |

The pattern, and it is the thing worth taking out of this debrief: **a guard
computed from the same input as the thing it guards cannot fail.** The fix is
always the same — the invariant has to reach *outside* the derivation, to what
the provider actually said.

`v_refused_auth_hold` (0026 §5) is that reach. It joins the hold to
`card_auth_event_result`, which carries Lithic's own `result` verbatim, and asks
a question neither of the other two views can express:

> is this customer's money being withheld on the strength of an authorisation
> the network refused?

MUST BE EMPTY. It reports on `active_hold_cents > 0` — money actually withheld
right now — not on the presence of a refused event, because a refusal on a hold
that withholds nothing is history, not harm.

### 7.4 What changed at ingest

**A refused step is recorded, and weighs nothing.**

`card_event_kind` gains **`declined`** (0026 §1). `deriveCardEvents` reads
`event.result` and, when it is present and not `APPROVED`, pushes the step under
that kind — real amount, real value date, real Lithic event token, so a
redelivery still deduplicates through `UNIQUE (auth_id, provider_event_id)`, and
the row is still in the one event log that the hold detail screen, the statement
machinery and `queries.ts` all read. **A customer looking at a declined
transaction sees that it happened.** It simply moves no money.

The reason that works without touching `model.ts` is the part worth reading
twice, because §1 of this file says any change to `closed(E)` is "one migration
that moves both, or it is not made". This change moves **neither**. Both
implementations select the kinds that feed a term by MEMBERSHIP of a fixed list:

```
TypeScript   RAISES_AUTH / LOWERS_AUTH / CAPTURES / CLOSES — four Sets
SQL          SUM(...) FILTER (WHERE ev.kind IN ('authorization', ...))
```

A kind in none of those lists feeds `A(E)`, `C(E)` and closure exactly nothing —
**in both implementations, by construction**, with no edit to either and
therefore no way for the two to drift apart. `movesFinancialBook()` is the same
shape, so it posts no money either. Proven live against this database: a
`declined` row added to an authorisation left `v_card_auth_hold` reading
`A=10000 C=0 count=3`, i.e. it contributed zero to both sums while counting as a
member of `E`.

Three consequences, all deliberate:

* **`event_count` DOES count it**, so an authorisation whose only event is a
  refusal is `closed` by the `A ≤ 0` arm with `target_hold_cents = 0`. Correct,
  and matched exactly by `holdState`, whose `count` increments for every member.
* **`terminallyClosed` stays false**, because `sawAuthorisation` only rises on
  `RAISES_AUTH`. No `hold_closure` row is written on a refusal. That is not
  fussiness: `041d610c` carries `AUTHORIZATION 5000 DECLINED` followed by
  `CLEARING 7340 APPROVED`, and the sandbox drove it to `SETTLED`. A hold closed
  at the decline would have left the capture nothing to reconcile against.
* **`isFinal` is false.** A refusal is not the network saying "no further
  capture is coming"; it is the network saying "this one did not happen".

**The rule is uniform, not authorisation-only.** A `CLEARING`, a `RETURN` or a
credit step whose `result` is not `APPROVED` gets the same treatment. No
non-APPROVED capture has ever been observed in this sandbox, so that arm is
asserted against a synthetic payload rather than a measured one — and it is
asserted, rather than left to chance, because the alternative failure is posting
money for a capture the network refused, which is much the worse of the two.

**Silence is not a refusal.** `result` is optional on Lithic's
`TransactionEvent`. An absent verdict means "we were not told", which is a
different claim from "we were told no", and is stored as NULL rather than
guessed. A system that read silence as a refusal would silently stop placing
holds the first time a provider changed a payload shape.

### 7.5 Where the verdict is stored, and why it is not a column

`card_auth_event_result`: one row per event, `PRIMARY KEY (event_id)`,
append-only, written inside the same transaction as the fact it describes.

It wants to be a column on `card_auth_event` and it cannot be one.
`card_auth_event` is append-only in two layers — `corgi_app` holds SELECT and
INSERT only, and `card_auth_event_no_update_delete` refuses UPDATE for **every**
role, the owner included. An added column would be NULL on all 735 existing rows
for ever, and the only way to fill it would be to disable the trigger that
exists to stop exactly that. "UPDATE or DELETE on money rows. Anywhere. Ever."
is an automatic fail and it has no backfill exemption.

`result` is **nullable, and that is the point** — 0023's house style on
`standing_order_outcome.observed_pending_outbound_cents`, applied again. The
backfill reads the raw payloads that really were retained (`source =
'retained_payload'`, 322 of 753 rows) and writes NULL with `source =
'not_retained'` for the rest (431), which were ingested by direct
`applyCardTransaction()` calls that carried no `inbox_id` and left no payload
behind. `'not_retained'` says *we looked, and there is nothing to read* — a
different claim from "no row here yet", and a different claim again from
`APPROVED`. **A value nobody measured is not invented.**

A `CHECK` and a trigger turn the column into a guard rather than a field. From
`source = 'ingest'` onward, a step the network refused **cannot be stored under
a kind that feeds `A(E)` or `C(E)`**, and an approved step cannot be stored as
`declined`; the INSERT is refused and the webhook parks. Both arms were made to
fire against this database, in a transaction that was rolled back, before this
was written. The trigger returns early when a verdict is already on file, so a
redelivered webhook — which attack 8 does on purpose — is still a no-op.

### 7.6 The repair

Same class as 0011's $60 over-release, handled the same way: **appended at the
original value dates, never edited.** Two appends per hold, and both are
required, because either alone trips an invariant — which is the pair doing its
job:

* the memo entry that opened the hold is **reversed at its own `value_date`**
  (2026-09-10 for most, 2026-09-11 for the rest), not today's. The money was
  withheld on the 10th, so the 10th is the day that has to stop being wrong.
  Reversal only, no rebook: there is nothing to re-book. `entry_type =
  'reversal'`, `reverses_entry_id` set, `correction_group_id` inherited,
  `idempotency_key = reversal:<original entry id>` so a re-run appends nothing.
  Without it, `v_hold_release_drift` reports.
* a **`hold_closure`** row, because the fold cannot be made to say zero — the
  stored `kind` on those already-written rows is `authorization` and always will
  be, so `target_hold_cents` will read 5000 for ever. Without it, `v_hold_drift`
  reports. This is precisely the case 0011 blessed: *"An operator may close a
  hold the fold still considers open — that is what `closeHold()` is FOR … The
  operator overrides the model; the operator does not get to leave money
  withheld."*

**40 holds, 40 reversal entries, $1,951.00 returned** (27 by the migration, 13
by an idempotent re-run over rows production created afterwards). The repair
lives in the
migration rather than in a script — which is where 0011 put its own — because
0011's repair needed operator judgement (four conditions, refusing loudly on
anything that failed one) and this one has none: the predicate is
`v_refused_auth_hold`, a view created six lines above it, and running both in
one transaction means the database never contains the invariant *and* the rows
that violate it. Money moves through `ledger_append()` and nothing else, here as
everywhere; `postEntry()` is a thin typed wrapper over that same function, so
calling it from SQL is the same single write path, not a way around it. The
migration re-reads all three views before it commits and **raises if any is
non-empty**, so a repair that did not work rolls itself back.

### 7.7 What live-fire attacks 1 and 2 say now

They read the provider's verdict — asked of Lithic, not of our own copy, because
the whole class of bug this closes is our copy having dropped the answer — and
branch on it:

* **APPROVED** → the published attack, unchanged.
* **REFUSED** → assert the invariant 0026 installs (available, holds, ledger and
  the trial balance must not move at all, and the hold must carry zero memo
  entries), and then **FAIL**, naming the refusal, the `detailed_results`, the
  account's measured spend-limit headroom, and the fact that raising it is
  blocked.

**A refusal is not skipped.** A skip in this suite means "the pipeline did not
run, so the claim is unproven" and is never counted as a pass. This is a
different thing: the pipeline ran perfectly and the *demo* could not be
performed. Turning that into a skip would be tuning a test to avoid a red, and a
red test telling the truth beats a green one that is not. Attack 2's
**measurement** test does skip on a refusal, and that is a different judgement
for a different reason — it needs an approved authorisation to over-capture
before its question can be asked at all, so a refusal leaves the question
unasked rather than answered wrongly.

### 7.8 Can an approving authorisation be had without changing account settings?

**No.** Measured and documented, in that order.

`GET /v1/accounts/2742964f-478f-47ef-a4e9-852dc50d9c44/spend_limits`, live:

```json
{ "available_spend_limit": { "daily": 0, "monthly": 1228950 },
  "spend_limit":           { "daily": 500000, "monthly": 2000000 },
  "spend_velocity":        { "daily": 760210, "monthly": 771050 } }
```

Daily headroom is **zero**, and velocity is $2,602.10 *past* the limit. So:

* **A smaller amount does not help — MEASURED, not inferred.** Not merely
  "`available_spend_limit.daily = 0`, so one cent exceeds it": a **one-cent**
  authorisation was actually sent, on a card deliberately NOT registered with
  `registerCard` so the probe could not move the ledger. Lithic transaction
  `f3d7bcef-597b-41e0-803d-ae6020779e1a`:

  ```
  POST /v1/simulate/authorize {amount: 1, mcc: "5542"} -> 201
  transaction result DECLINED status DECLINED
    AUTHORIZATION 1 result DECLINED ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]
  ```

  The floor is not low. There is no floor. (`spend_velocity.daily` read 835270
  immediately before and immediately after that call, so the declined attempt
  did not itself consume any further headroom.)
* **A different card does not help.** The limit is on the ACCOUNT. Lithic:
  *"Authorization was declined because authorization amount exceeds the
  **account's** available daily spend limit"*, and cards carry a single
  `spend_limit` while accounts carry the daily/monthly/lifetime set. There is
  exactly one account on this key (`GET /v1/accounts` returns one row).
* **Refunds do not drain it.** *"for all non-lifetime spend limit durations,
  credits are not factored into the spend limit calculation in any way"*.
* **Nothing else can originate an approval.** `/v1/simulate/clearing`,
  `/authorization_advice`, `/void` and `/return_reversal` all require a `token`
  from an authorisation that already approved. Force post — which *would* bypass
  the limit — is *"not currently supported"* in sandbox.
  `FINANCIAL_AUTHORIZATION` is a `status` on `/simulate/authorize`, not an
  exemption from it.
* **ASA cannot rescue it.** Limit checks run BEFORE the ASA request: *"If any of
  these checks fail, the transaction is declined and your ASA endpoint will not
  receive a request."* Our own `UNKNOWN_HOST_TIMEOUT` / `CUSTOMER_ASA_TIMEOUT`
  refusal is the same mechanism from the other side.
* **The window is ROLLING, not a midnight reset.** *"Daily limits look back 24
  hours from the time of authorization."* So there is no cliff to wait for:
  capacity returns incrementally as each authorisation ages past its own T+24h.
  With velocity $2,602.10 over the limit, a meaningful amount of headroom
  requires most of a day's worth of authorisations to age out.

Two routes exist and **neither is ours to take**:

1. **`PATCH /v1/accounts/{token}`** — raise the limit. The permission classifier
   blocks it deliberately; it was not attempted and no substitute for it was
   sought.
2. **Create a second Lithic account** via `POST /v1/account_holders`
   (`KYB_BASIC` + Lithic's own published fake identities, then self-accept
   through `/v1/simulate/account_holders/enrollment_review`). This does not
   alter the existing account's settings, and as an ASA-enrolled program a new
   account should carry no default limits at all. It was **not done**: it moves
   the demo onto a different provider account, which changes the integration's
   topology and the evidence pack, and that is a decision for a human. It is
   also documented-but-unproven — no call was made — so it is written here as a
   documented route and not as a measured capability.

**So the honest answer is: only by raising the limit, or by standing up a new
provider account. Both are the user's call.** Waiting is the third option and it
is slow.

### 7.8b The honest live-fire line

Full suite, `node scripts/livefire.mjs`, against production, after the fix:

```
PASS 4    FAIL 3    SKIP 1    of 8 attacks
```

It was **5 PASS / 2 FAIL / 1 SKIP** before. The suite got worse, and the book
got better. That is the trade this change is: two of those five passes were
being bought by ingesting declines as approvals.

| # | Attack | Verdict | |
| --- | --- | --- | --- |
| 1 | fuel-pump auth: AVAILABLE drops 5000 | **FAIL** | refused auth; production still placed the hold |
| 2 | $73.40 capture releases exactly once | **FAIL** | same refusal; no hold to release |
| 3 | backdated reversal | FAIL | not this change's file; see below |
| 4 | settlement before its authorisation | PASS | |
| 5 | maker-checker self-approval | PASS | |
| 6 | planted scheme-file break | PASS | |
| 7 | provider outage | SKIP | outage could not be induced |
| 8 | signed provider replay dedupe | PASS | |

**Attacks 1 and 2 are the correct outcome and must not be tuned away.** Both now
read the provider's verdict, and both found `AUTHORIZATION 5000 result DECLINED
detailed_results [ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED]` — so the demo the
published attack asks for cannot be performed at all. What they then assert is
the invariant 0026 installs, and it is worth reading the actual failure:

```
1  $50 fuel-pump auth                                                  FAIL
   AssertionError: expected 60000n to be 55000n
   evidence: REFUSED BY THE NETWORK. Lithic transaction
   47f53bfa-a74a-45ef-9615-97f83479e955: AUTHORIZATION 5000 result DECLINED
   detailed_results [ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED]. holds 55000 -> 60000
   (must be UNCHANGED — a refused authorisation withholds nothing) ...
   THE HOLD WAS PLACED ANYWAY: +5000 cents withheld from a business for a
   purchase the network refused. ... the code serving
   https://corgi-trial-psi.vercel.app predates 0026 — the fix is in the
   repository and has not been deployed to the host that processed this
   delivery.
```

So this red is carrying two separate facts and both are worth having: the
authorisation was refused, **and** the deployed build is still placing the hold.
The test found the deployment gap on its own.

Note `v_refused_auth_hold 0` in that same evidence line while $50.00 was being
wrongly withheld. That is §7.3's lesson reappearing immediately and it is the
first entry in §7.9.

**Attack 3 is not this change's file** (`attack-03` belongs to another agent) and
its failure is not caused by this one: 0026 alters ingest only for steps whose
`result` is not `APPROVED`, and every `RETURN` / `RETURN_REVERSAL` in attack 3's
episode is `APPROVED`. Its own evidence shows the tell — one attempt rendered a
statement with `closing undefined` over `[object Object]` lines and a difference
of `NaN`, while a second attempt on the same run rendered cleanly and asserted
the full `-7340`. That is a concurrent writer on a shared database, not a
correction defect.

**Attack 7's SKIP is unchanged** and unrelated: Lithic never crossed its 180s
staleness threshold within 309s of deliberate silence, so the outage could not
be induced. A skip is not a pass and is not counted as one.

`node scripts/dbcheck.mjs` finishes **28 passed, 0 failed**, with `v_hold_drift`
and `v_hold_release_drift` both empty.

### 7.9 What this change did NOT do, and the follow-ups it names

* **`v_refused_auth_hold` is not in `scripts/dbcheck.mjs`.** Its
  `INVARIANT_VIEWS` list is hard-coded and that file was outside this change's
  remit. 0023 records what happens to a view asserted to be empty and never
  queried — *"a view that is asserted to be empty and never queried is a
  comment"* — so this is stated here rather than left to be discovered. **First
  follow-up: add it.**
* **The view depends on ingest recording a verdict.** A `card_auth_event` row
  written by code that predates 0026 has no `card_auth_event_result` row and is
  therefore invisible to it. The 0026 backfill closed that for every row that
  existed when it ran, and the ingest path closes it going forward — but a
  deployed build older than this change leaves a gap, and while that gap is open
  the view can read empty while money is wrongly withheld. The stronger
  formulation joins `webhook_inbox` directly, so that the invariant depends on
  nothing our own pipeline did. **Second follow-up, and it is the same lesson as
  §7.3.**
* **`HoldEventRow`'s label maps.** `KIND_LABEL` and `KIND_TERM` in
  `src/components/accounts/HoldDetailView.tsx` are `Record<CardEventKind, …>`
  and have no entry for `declined`, so the row renders with its amount, date and
  token but a blank label. `src/components/**` was outside this change's remit.
  **Third follow-up: one line in each map.**
* **The 58 already-stored refusals keep `kind = 'authorization'` for ever.**
  They are immutable rows and rewriting them is the one thing that is genuinely
  not available. Their money is repaired; their `kind` is history, and
  `card_auth_event_result` records honestly what the network said about each of
  them. The trigger fires only on `source = 'ingest'` for exactly this reason —
  refusing to record what we found, in order to keep a constraint tidy, would
  leave the evidence out of the database.

---

**§8.2's ASCII diagram.** The `OVER/EXACT CAPTURED → TERMINAL: H = 0 forever`
box is falsified by §3 above. The transition table in §8.3 is correct as
written.

---

## 8. The same argument, one line over — migration 0028

Sections 2–4 spend two thousand words refusing to write a `hold_closure` row on
`C ≥ A`, because a later incremental can undo that condition and the row cannot
be undone. Migration 0011 made the same argument first, in the same words.

**`A ≤ 0` is a condition a later incremental can undo, it sat in the next
disjunct, and neither pass looked at it.**

### 8.1 What was wrong

`terminallyClosed` is the predicate that licenses the row. `hold_closure` is
append-only with `PRIMARY KEY (hold_id)`, so that predicate carries an
obligation `closed(E)` does not: it must be **monotone**. True on a subset must
mean true on every superset.

```
terminallyClosed = sawFinal ∨ sawClose ∨ expired ∨ (sawAuthorisation ∧ A ≤ 0)
                   \_______________________/   \____________________________/
                       monotone by construction          NOT monotone
```

Two are `∃` over a growing set; `expired` does not read the set at all. The
fourth is a predicate on a **running total that can go back up**. The fuzzer
(`docs/FUZZ.md`, 6.25M orderings) shrank it to two events, seed `5300024`:

```
E1 = { authorization 0 }                     → terminallyClosed TRUE, row written
E2 = E1 ∪ { incremental_authorization 1 }    → terminallyClosed FALSE, H = 1
```

**A $0 authorisation is card-on-file verification.** Lithic sends
`AUTHORIZATION amount: 0` and then an `AUTHORIZATION_ADVICE` carrying the real
figure. In one payload it is harmless. Split across two deliveries — the ordinary
case, and precisely the case the brief tells us to survive — the *first* delivery
closed the hold for ever. Second witness, the same defect with more steps:
`{auth 100, reversal 100}` followed by a late incremental.

The damage path is §6's own asymmetry playing out again. `v_hold_state.is_released`
reads the closure row **first**, so availability stops withholding money `H(E)`
still says is held; `settleHoldPosting()` then drives the memo book back up, and
the hold is simultaneously *released* and *carrying money* — the exact row shape
`v_hold_release_drift` was added in 0011 to report, and the exact shape
`v_hold_drift` cannot see because it is `WHERE NOT is_released`. On the $0 path
the row is written with reason `"authorisation fully reversed"`, which is **a
false statement in an append-only audit table** about an authorisation nobody
reversed.

### 8.2 The fix, and why it costs nothing

`A ≤ 0` moves **out** of `terminallyClosed` and **stays** in `closed(E)`. That
is the distinction `model.ts` already drew and simply mis-assigned.

No customer-visible number moves, and that is checkable rather than asserted:

* `H = max(A − C, 0)` is **already 0** when `A ≤ 0`. The hold figure is
  identical with the arm and without it.
* `v_card_auth_hold.is_closed` **keeps** the arm, because it mirrors `closed(E)`.
  So `v_hold_state.is_released` is still TRUE on a fully reversed authorisation
  and availability still frees the money on the customer's screen. It now does so
  **from the fold**, where a later event can move it, rather than **from a row**,
  where nothing can.
* `v_hold_drift` compares `memo_balance_cents` against `target_hold_cents`.
  Neither side reads `terminallyClosed`, so the invariant that holds the
  TypeScript and the SQL equal does not move either.

Verified before the edit was made, against the fuzzer's own generators at deep
scale — **320,000 sets, 5,118,851 orderings, 16,199,101 prefixes**:

| Checked | Result |
| --- | --- |
| Sets where `H` changed | **0** |
| Sets where `closed(E)` changed | **0** |
| New predicate ⇒ `closed(E)` | holds on every set |
| New predicate ⇒ `H = 0` | holds on every set |
| Non-monotone prefixes, new predicate | **0** |
| Non-monotone prefixes, old predicate | 141,209 |
| Sets that lose terminality | 11,236 |
| …of those, any with `H > 0` | **0** |

The last two rows are the argument in two numbers: eleven thousand sets stop
being *terminally* closed, and every one of them already held nothing and was
already `closed(E)`.

### 8.3 What the migration did NOT change, and why that is the finding

`v_card_auth_hold.is_closed` and `v_hold_state.is_released` were **not** altered.
That needs saying out loud, because the obvious reading of §1's "any change here
is one migration that moves both" is that a view must move too.

It does not, because **`terminallyClosed` has no SQL counterpart and never did.**
Every release predicate in the database expresses `closed(E)`:

| Object | Migration | Expresses |
| --- | --- | --- |
| `v_card_auth_hold.is_closed` | 0001 | `closed(E)` |
| `v_hold_state.is_released` | 0001, 0011 | closure row ∧ ¬reversal, ∨ `closed(E)`, ∨ the uncleared clock |
| `ledger_availability()` | 0022 | the same `closed(E)` fold, at a parameterised instant |
| `holdItemisationAsOf()` | — | scopes on the closure row, then **sizes on the memo balance** (0 on this arm anyway) |

All four say "withhold nothing now". **None says "and nothing can undo that."**
That judgement existed only in the writer — `apply.ts` step 5 — which is exactly
why it could be wrong in one place with nothing in the schema to disagree with
it, and why all three invariant views stayed green while it was.

Changing a view to match a predicate that is not in it would have moved
`is_released`, and moving `is_released` moves real money.

What was missing was not agreement between the model and the SQL. It was a view,
and `v_hold_closure_not_terminal` (§6) is it.

### 8.4 The live book: zero wrong closures

`scripts/repair-0028-premature-closures.mjs` exists, follows
`repair-0011-spurious-closures.mjs` exactly — append a `hold_closure_reversal`,
never an edit, never a delete — and **found nothing to repair.** Stated plainly,
because a manufactured repair would be worth less than an honest nil return.

At the time of the change the live book carried **124 `hold_closure` rows**, of
which 102 are on card authorisations. Classified:

| Reason | n | Written on |
| --- | --- | --- |
| `authorisation expired unused` | 49 | the expiry sweep — `sawFinal` ∧ `sawClose` |
| `final capture received` | 34 | `sawFinal` |
| `simulated crash before release` | 12 | an operator `closeHold()`, not the posting path |
| `authorisation fully reversed` | **6** | **the arm 0028 removed** |
| `authorisation closed or expired by the network` | 1 | `sawClose` |

Only the six matter, and none of them is an open defect:

* **Three** are the `origin = 'clearing_first'` holds migration 0011 already
  found and repaired — `A = 5000`, `C = 3000`, contradicted by the late
  authorisation, and each already carrying a `hold_closure_reversal` appended on
  2026-09-10. Those are 0011's bug, not this one, and they are already corrected.
* **Three** were written on this arm and **nothing has contradicted them**:
  `A = −5637` over four events, `C = 0`, the fold still says closed, memo balance
  0, both drift views silent. A post-0028 build would not write these rows. They
  are **not** reversed, and that is a decision rather than an oversight:
  `hold_closure_reversal` means *should never have been written*, which is a
  stronger claim than *a later build would not have written it*. No number is
  wrong on any of them, so appending three reversals that move nothing — into an
  append-only audit table, to make a report look tidier — would be manufacturing
  evidence. The repair script lists them as `LEAVE` on every run.

**The defect was latent, and here is how latent.** The only event kinds that can
raise `A` after a closure are `authorization` and `incremental_authorization`. In
the entire live book:

* **0** zero-amount authorisations have ever been ingested — witness A has never
  occurred;
* **0** `incremental_authorization` events have ever been ingested — the event
  that fires witness B has never arrived;
* 27 `authorization_reversal` events exist, and the three closures they produced
  are the uncontradicted ones above.

So the bug was real, reachable, and one Lithic card-on-file transaction away —
and it had not yet fired. `v_hold_closure_not_terminal` now reports it the day it
does, instead of `v_hold_release_drift` reporting it after the money has moved.

---

## 9. The opening whose memo posting never landed — migration 0036

Sections 7 and 8 are both about a hold withholding money it should not. This one
is the mirror: **a hold withholding nothing while the fold says $50 is
authorised.** Same invariant pair, opposite sign, and the opposite sign is the
one that survives, because nobody ever complains about being allowed to spend.

`v_hold_drift` was empty all evening. At 06:0xZ it came back with three rows,
then a fourth, then more while the repair was being written. Every one identical
in shape:

```
a single `authorization 5000`, is_final = false, verdict NULL,
no hold_closure row, and a memo book holding NOTHING
```

### 9.1 The hypothesis that was wrong

`apply.ts` split one event into two transactions — facts and closure first, the
memo posting second. Another agent instrumented the gap and measured **330ms**.
Nine agents had been killed mid-execution by a session rate limit earlier the
same night. A process killed inside that window commits transaction one and
never runs transaction two, which produces **exactly these rows**.

It is the right shape and it is not what happened. Three measurements killed it,
none of them an inference:

1. **`hold.external_ref`.** `ensureAuthorization()` builds it as
   `<provider> || ':' || <provider_auth_id>`. **470 of the 474** card
   authorisations in this database satisfy that. The **4** that do not are
   these, where `external_ref` *equals* `provider_auth_id` with no prefix — a
   row shape `ensureAuthorization()` cannot emit. They never went through
   `apply.ts` at all.
2. **`card_auth_event_result`.** Since 0026, `recordFacts()` writes a verdict row
   beside every fact **in the same transaction as the fact** — NULL when the
   payload carried no `result`, but a row. A crash between transaction one and
   transaction two would leave that row behind, because it *is* transaction one.
   These four events have **no verdict row at all**.
3. **`webhook_inbox`.** No row anywhere mentions them; every event carries
   `inbox_id IS NULL`. **There was no delivery to crash on.**

### 9.2 What it actually was

`src/lib/team/team.integration.test.ts` §9 — *"removing a member leaves an
outstanding authorisation untouched"* — hand-writes a `hold`, a
`card_authorization` and one `card_auth_event` with raw SQL against the **live
book**, under its own comment: *"No money — this suite never posts."*

It is right that it posts no money. **The memo book is not money; it is the
withholding.** Every run of that test leaves one hold whose fold says $50 and
whose memo book says nothing, and the suite was running on a loop while this was
being diagnosed: three rows at 06:06, a fourth at 06:07, two more by 06:20.

This is worth stating as a rule rather than as an incident. **A fixture that
writes facts into the money system inherits the money system's obligations.**
The test was careful about the half it knew about — no journal entry, no
capture, no settlement — and silently skipped the half it did not, which was the
only half that mattered for this hold.

### 9.3 The transient is real, and it is not this

The `apply.ts` window exists. Measured retrospectively over all 474
authorisations in this book, first fact to opening memo entry:

| | |
| --- | --- |
| p50 | **342 ms** — independently reproducing the 330ms instrumented figure |
| p95 | 2102 ms |
| max | 627 s |
| `<1s` | 286 holds |
| `<1m` | 72 holds |
| `<1h` | 3 holds |
| never posted | 113 holds — **112 with `target_hold_cents = 0`**, i.e. Δ was always zero and nothing was owed |

**Zero of the 470 holds that went through `apply.ts` are drifting.** The
transient is real, it is ~342ms, and it heals in process. The orphan does not
heal at all.

And the way the orphan eventually "heals" is the worst part. At `expires_at`,
seven days on, `v_card_auth_hold.is_closed` flips on the clock,
`v_hold_drift`'s `WHERE NOT is_released` stops matching, and **the row leaves
the guard without the money ever having been withheld.** The evidence heals; the
defect does not.

That distinction has a consequence the coordinator named and this file had never
written down: **`v_hold_drift` reading non-zero is not always the same event.**
Seconds of age means a delivery is in flight. Minutes means nothing is coming.
So `v_hold_posting_incomplete` (0036) carries `age`, `through_apply` and
`from_webhook` beside the figures, and an operator reads the cause off the row
instead of inferring it. The **guard** was not given a threshold and must never
be: tolerance belongs in the actor, not in the alarm.

### 9.4 The split, and why it is gone

`apply.ts`'s comment argued the split in the **release** direction: closure
first means available is correct early, which is customer-favourable.

The argument is sound, and it buys nothing, because `v_hold_state` does not read
release from the closure row alone:

```
is_released = (closure ∧ ¬reversal)
            ∨ (kind = 'card_auth' ∧ v_card_auth_hold.is_closed)
            ∨ (kind = 'uncleared_credit' ∧ now() ≥ available_at)
```

The second disjunct is `saw_final ∨ saw_close ∨ now() ≥ expires_at ∨ A ≤ 0`,
derived from the **event set**. For a card authorisation the money is free the
moment the **facts** commit, whether or not the closure row landed and whether
or not the posting did. **The split was protecting an outcome the derived
predicate already guarantees.**

Run the same argument in the **opening** direction and it inverts: the facts
commit, `H(E)` says $50 is authorised, and the entry that withholds it has not
landed, so the customer can spend money a merchant is going to claim.

So the two directions did not need opposite orderings. **The release direction
needed no ordering at all**, and steps 6–7 moved into the transaction that
already held the lock. Merging costs nothing new either: step 3 *already* calls
`postEntry()` → `ledger_append()` inside that transaction, so the memo posting
introduces no lock that was not taken there before and no ordering that was not
already established.

What it changes is the failure mode, in the right direction:

| | before | after |
| --- | --- | --- |
| crash mid-apply | facts commit, withholding does not — **fails open** | neither commits, envelope redelivered — **fails closed** |
| customer sees | money spendable that should not be | the authorisation has not appeared yet |

Between *"we forgot to withhold"* and *"we have not processed it yet"*, only the
second is a state a bank can be in.

### 9.5 And the recovery is still mandatory

Atomicity fixes this code. It fixes **none of the four holds that caused it**,
because none of them came through this code. It also does not fix:

* a deployed build older than the tree — decision 056 measured exactly that, the
  ingest fix sitting in the repository for eight hours while the host Lithic
  posts to ran the previous commit;
* anything already standing in the book.

So `src/lib/holds/completion.ts` is the sweeper, and it is the same shape as
`expiry.ts` at the other end of the lifecycle. It reads
`v_hold_posting_incomplete` — **defined `FROM v_hold_drift`**, so the repair
cannot range over fewer rows than the guard, and 0036 asserts that equality in
both directions at apply time — and calls `settleHoldPosting()`, the
compare-and-append `apply.ts` and `expiry.ts` already use. No second mechanism.

It is safe to run against a live delivery, and **not because it waits**: the row
lock makes two processors on one authorisation compute `Δ` and `Δ = 0`
respectively. `--min-age` exists so a human can ask for only the stuck ones; it
defaults to **0**, because a default that skipped rows would be one more guard
excluding the state it exists to catch.

**What is NOT yet true, said plainly.** Nothing *schedules* it. `vercel.json`
carries four crons — `/api/drain`, `/api/cron/standing`, `/api/cron/accrual`,
`/api/cron/outbound` — and none of them sweeps holds. That is not a new gap:
`sweepExpiredHolds()` has the same problem and decision 046 already named it,
*"three definitions of available, and the sweep nobody calls."* The sweep is
**automatic** in the sense that matters for correctness — it needs no human
judgement, it is idempotent, it is total, and it is exercised on every run of
`completion.test.ts` — but until a route and a cron line exist it is **operated,
not scheduled**, and `scripts/repair-0036-missing-memo.mjs` is how it is
operated. `src/app/**` and `vercel.json` were outside this change's write scope;
the missing piece is one route calling `sweepIncompleteHoldPostings()` and
`sweepExpiredHolds()` together, and one `crons` entry, and both sweeps should
land on it at the same time rather than this one going first.

**What it deliberately will not touch** is `v_hold_release_drift`.
`settleHoldPosting()` would happily repair those — fold says 0, memo says N,
Δ = −N — and that is precisely why it must not run there automatically. §8's
bug produced exactly that state, and the right repair was to reverse the
**wrong closure**, not to post the release the closure implied. A sweeper that
tidied the memo book would have made 0011's alarm go quiet while leaving a false
closure standing in an append-only audit table.

### 9.6 The repair, and what it decided

Three holds were repaired by the interchange agent through `settleHoldPosting()`
before this work started; three more were standing when it finished, and
`scripts/repair-0036-missing-memo.mjs --apply` completed them — **append only,
at the original value dates**:

| entry | value date | memo | key |
| --- | --- | --- | --- |
| `6306beef-bf83-4e15-8a83-df36a7267453` | 2026-09-11 | +$50.00 | `hold:619da0df…:after:lithic:team-test-mtwjzy0q-qabwth-e1` |
| `e1caec5d-43e6-44b8-8ede-5516698868c9` | 2026-09-11 | +$50.00 | `hold:95bf0c0a…:after:lithic:team-test-mtwkfjed-szl3mb-e1` |
| `79cde379-cf0c-4dc5-be55-d0eedc8aee00` | 2026-09-11 | +$50.00 | `hold:8c24d59f…:after:lithic:team-test-mtwkhl23-yto6ke-e1` |

**POST THE MEMO, DO NOT CLOSE THE HOLD**, and the argument matters more than the
outcome, because closing was the tempting answer. These authorisations do not
exist at Lithic. No merchant will ever capture them. Nothing is coming. It is
very easy to write a `hold_closure` reading *"fixture authorisation, never sent
to the network"* and have every view go quiet.

Two things forbid it.

**First, 0032 already refused this exact move, by name.** Its §3 repaired holds
standing against a **proven refusal** and left the `unanswered` ones alone:

> Reversing a hold we cannot show was refused would be the mirror of the bug
> being fixed — inventing a verdict in the customer's favour instead of in ours
> — and both are the same error: acting on a fact nobody measured.

These four carry `result = NULL`. They are `unanswered`. Closing them is
inventing a verdict.

**Second, the wording would have dodged the guard.** `v_hold_closure_not_terminal`
discriminates on five string literals matched against `hold_closure.reason`, and
decision 056 counted **64 of 184 closures (35%) invisible by construction** —
0032's own closures among them, *by wording, not intent*. A bespoke reason
string here is not a repair, it is the twentieth instance of the pattern this
log exists to track.

So the fold is treated as the truth it is: the event rows say $50 is authorised,
they are immutable, and the memo book follows them. The consequence is stated
rather than hidden — these holds now appear in `v_refused_auth_hold` as
`unanswered`, money withheld against an authorisation nobody can show was
approved, which is **exactly where they belong and exactly what they are.**
`dbcheck` stays red on that view. It is not to be tuned.

### 9.7 The attack that does not exist yet

The eight live-fire attacks replay webhooks, backdate corrections, reverse
settlements, delete a scheme row and pull a provider out from under us. **None
of them kills a process mid-apply**, and `dbcheck --prove` makes the
refused-auth and wire invariants fail on purpose but not this one. So
`v_hold_drift` has never been *seen* to fail in the under-withholding direction
— 023's rule, one more time: *a view asserted empty and never seen to fail is a
comment.*

`src/lib/holds/completion.test.ts` is that proof, and it is worth saying what it
cost, because the answer is "almost nothing": **four scenarios, no process
control, no signals.** The intermediate state is reached by running exactly the
statements the old transaction one ran — `ensureAuthorization`,
`lockAuthorization`, `insertCardEvents` — and then stopping. That is what a
`SIGKILL` leaves behind, reproduced deterministically and without a `SIGKILL`.

1. crash-shaped: guard fires, `through_apply = true`, sweep clears it, entry
   books at the original value date;
2. bypass-shaped: the team suite's raw-SQL shape, `through_apply = false`;
3. two sweepers racing one hold — `Δ` and `Δ = 0`, memo lands on 5000 and not
   10000;
4. an ordinary delivery leaves the sweep nothing to do.

**What a real live-fire attack would take, and why it is still worth adding.**
Scenario 1 proves the *state* is survivable. It does not prove the *process* is,
and those are different claims: killing the node process between the two writes
also exercises the webhook envelope staying `state != 'done'`, the redelivery,
and the inbox's own idempotency — none of which a same-process simulation
touches. Doing it for real needs a child process that applies one payload and
is `SIGKILL`ed at a deterministic point (an env-gated `throw` after
`recordFacts()` is the cheap version; a real signal needs the gap to still
exist, and after 0036 **it does not** — which is itself the strongest possible
result for that attack). The honest form of attack 9 post-0036 is therefore:
*kill the process mid-delivery, show that the book is unchanged rather than
half-changed, and show the redelivery completing it.* That is an afternoon, it
needs no provider, and it is the first attack in the set that would test the
recovery path rather than the happy path.

### 9.8 Why `v_hold_drift` worked when nineteen guards did not

This is the most transferable thing in this document and it is one sentence:

> **`v_hold_drift` compares two numbers that do not share an input.**

On one side, `memo_balance_cents`: the sum of journal lines on the hold's own
`9100` leaf — the book, written by `postEntry()` → `ledger_append()`, hashed and
append-only. On the other, `target_hold_cents`: `H(E)` folded over
`card_auth_event`, the provider's own facts. **Neither is computed from the
other, and neither is computed from anything the other reads.** A bug has to
corrupt both, in the same direction, by the same amount, to keep the view quiet.
Nothing in the incident above could do that: the memo posting was simply
missing, and the fold went on saying $50 because the fold does not read the memo
book.

Every guard on this build's list of nineteen failed one of exactly two ways.

**One: it compared a derivation against itself.** 0011's pair is the clearest
case *in the other direction* — `v_hold_drift` and `v_hold_release_drift` are
two readings of the same event set, and they agreed perfectly for eight hours
while the declined-hold bug ran, because the thing that was wrong was *upstream
of both of them*. 0032 wrote it down at the time: what caught that one was
joining to **what the provider actually said**, retained verbatim in
`webhook_inbox` — a third input neither derivation had. `v_standing_order_double_fire`
is the degenerate version: it joined `payment_instruction` on a UNIQUE column
and asked for `count > 1`, so it could not return a row under any state of the
database, and its emptiness was quoted in a test, a document and
`compliance.mjs` as proof.

**Two: it excluded exactly the state it existed to catch.** `v_refused_auth_hold`
shipped with `AND r.result IS NOT NULL` over an INNER JOIN — and *missing the
verdict* was the failure it was written for, so the state it was blindest to was
the state the bug produced. `v_hold_closure_not_terminal` discriminates on five
free-text reason strings and cannot see 35% of the closures in this database.
`v_accrual_month_drift` is `WHERE month_complete` over zero complete months.
`scripts/audit-claims.mjs` validates documents against a deployment that
predates the tree and cannot see that it is doing so.

So the property is not "write more guards". It is:

> **A guard is only worth its green tick if the two things it compares were
> derived from different inputs, and if the state it is looking for is inside
> the population it ranges over.**

`v_hold_drift` satisfies both. That is the whole reason it worked, and it is
testable at design time: name the two inputs; if you cannot name two, you have
written a tautology. `dbcheck`'s **GUARD REACH** section (decision 056) is the
second half of the same discipline made permanent — every invariant states the
population it ranges over, out loud, every run. This section is the first half:
every invariant should also be able to state **its two independent inputs**, and
a guard that cannot name them is a comment with a test runner attached.
