# Disputes, and provisional credit done honestly

Stretch-ladder item 5: *"Dispute intake on a settled card transaction, with
provisional credit done honestly."*

Provisional credit is real money, moved on a maybe. The customer gets their
$73.40 back while the network decides, and the bank may never see it again.
Two things are usually got wrong, and this document says which one we avoided
and how — because on this feature the argument is worth more than the code.

---

## 0. What is live, and what is ours

Measured, not assumed:

```
POST https://sandbox.lithic.com/v1/simulate/chargeback   -> 404
POST https://sandbox.lithic.com/v1/simulate/dispute      -> 404
```

Lithic's sandbox has **no dispute simulator**. So:

| Fact | Whose |
| --- | --- |
| The card | **LIVE** — a real Lithic sandbox card |
| The authorisation and the clearing | **LIVE** — real webhooks, signature-verified, through the inbox |
| The settled charge under dispute | **LIVE** — a real `journal_entry`, posted from that clearing |
| Intake, provisional credit, evidence | **OURS** — an operator workflow |
| The network's verdict | **OPERATOR-DRIVEN** — there is nobody to ask |

That table is printed on `/disputes` itself, not buried here. `recordDecision()`
takes the outcome as an argument for exactly this reason, and
`dispute.network_case_ref` is nullable because in this deployment there is no
network case to reference.

---

## 1. The clawback is a NEW EVENT, not a correction

> A refund is final. Provisional credit is *reversible*, and reversing it must
> not look like a new debit the customer did not make.

The question: when we lose the dispute and take the money back, is that a
**correction of the grant** (a reversal at the grant's own value date) or a
**new event** on the day the network decided?

**It is a new event.** The test that decides it is the one DECISIONS 019 already
applied to an ACH return:

> **Did the FACT change, or was the RECORD wrong?**

- **A card clearing reversal is a CORRECTION.** The merchant reversing
  Tuesday's settlement means the settlement should never have posted at that
  amount. The record was wrong about Tuesday, so Tuesday's statement must now
  show the corrected figure, and `reverseAndRebook()` carries the original's
  value date precisely so that it does.

- **An ACH return is a NEW EVENT.** Increase's own behaviour confirmed it: the
  return does not erase the settlement, `settled_at` stays populated. The money
  really did leave on the settle date and really did come back on the return
  date. Two facts, two days.

- **A dispute clawback is the ACH case, not the card-reversal case.** On the day
  we granted provisional credit, the grant was *correct*: on the evidence we
  had, we chose to advance the customer their money, **we wrote to them saying
  so**, and their balance really did go up. Nothing about that day was
  mis-recorded. What changed is that the network later decided the charge was
  valid — a **new fact**, learned on a **new day**, creating a **new
  obligation** running the other way.

Reversing the grant at its original value date would be a lie in both
directions:

* the customer's statement for the grant day would show **no credit**, even
  though we had told them there was one; and
* the decision day would show **nothing happening**, even though that is the day
  the money came back.

So `reverseAndRebook()` is the **wrong tool here**, and calling it would be the
exact bug this feature exists to avoid. The integration test asserts the
consequence rather than describing it: both entries are `entry_type = 'original'`
and neither is a `reversal`.

### Where a correction WOULD be right

The case next door. An operator who granted credit **against the wrong
transaction**, or **for the wrong amount**, has a *mis-recorded grant* — the
record is wrong, the fact never changed — and that **is** a correction at the
original value date, through `reverseAndRebook()`.

That path is **not built**. It is on the cut list, and the reason is scope
rather than doubt: correcting a grant means re-sizing the memo hold behind it,
which is a second mechanism, and a half-built correction path is worse than a
stated one. The distinction lives in `db/migrations/0019_disputes.sql` and in
`clawbackLines()` so that whoever builds it inherits the argument.

---

## 2. Provisional credit must NOT inflate available balance

> Is the `uncleared_credit` hold exactly right here — or exactly wrong, because
> a dispute credit is not awaiting *settlement*, it is awaiting a *decision*?

Two separable facts, and conflating them is the second common error:

1. **Does the customer's LEDGER balance show the credit?** Yes, immediately, at
   the value date we granted it. We told them it was there; the statement has to
   agree.
2. **Can they SPEND it?** No. Not until the case resolves.

The second is the whole feature:

> **THE HOLD IS WHAT MAKES THE CLAWBACK SAFE.**

If the credit were spendable and the dispute is lost, taking it back overdraws a
customer who did nothing wrong. With the hold, available balance is unchanged
across the entire episode, and losing cannot put the customer in the red.

Live, on the real book. Case **DSP-20260911-8U46YC**, worked end to end through
the deployed console on 2026-09-11 against the real Lithic clearing
`6644e337-1e64-4abc-bc6c-b0f2d31e6e17`.

**The first five columns are what `/disputes?state=edge` renders on the
deployed URL today** (commit `0fa057d`) — those six figures were read off it.
**The last three are in this repository and not yet deployed**: they are the
repair described below, asserted in `disputes.integration.test.ts` against the
live book, and they will appear on the screen at the next deploy.

| step | booking seq | ledger | − holds | = available | this case: ledger | − holds | = available |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before the claim | 5676 | $86,110.21 | $20,336.18 | $65,774.03 | $0.00 | $0.00 | **$0.00** |
| provisional credit granted | 5678 | $86,183.61 | $20,409.58 | $65,774.03 | $73.40 | $73.40 | **$0.00** |
| after the case resolved | 5762 | $86,110.21 | $20,111.18 | $65,999.03 | $0.00 | $0.00 | **$0.00** |

The case's ledger contribution moves twice. Its contribution to available does
not move once.

### The last three columns exist because the first three were nearly a lie
<!-- Source-side repair, 2026-09-11. Not on the deployed URL until the next deploy. -->

**Read the account-wide `available` column: $65,774.03, $65,774.03,
$65,999.03.** It moved. The earlier version of this document printed the same
three rows with the caption *"available does not move once"* and no fourth
figure to back it — and that caption was a claim about a WHOLE-ACCOUNT number.

`positionAt()` answers for the entire deposit account at a booking watermark,
so everything else that happened to this customer in between lands in it.
Between watermark 5678 and watermark 5762, on the shared book, an unrelated
card authorisation for **$225.00** released. Nothing was mis-posted and the
dispute behaved exactly as designed; the screen was simply asserting an
invariant over a number that other work can move. On a quiet book the three
figures come out equal and it is tempting to publish that equality as the
proof. It is not a proof. It is a coincidence of scheduling, and the first busy
evening takes it away.

So the claim now lives on **this case's own contribution** — a fold over this
dispute's own journal lines and nothing else, in `caseContributionAt()` in
`src/lib/disputes/screen.ts`:

* the customer's `2100` leaf, financial book, negated (a credit is a negative
  line and raises the balance a customer recognises); and
* the customer's `9200` leaf, memo book, negated the same way.

Those cannot be perturbed by anything else on the book, so
`caseAvailableCents == 0` at every watermark is evidence rather than weather.
The account-wide columns are still printed, because they are what the customer
actually sees, and they are still the right thing to SHOW — they are just not
the thing to make a claim about.

The assertion is in `disputes.integration.test.ts` ("carries THIS CASE'S own
contribution"), it runs over every clawed-back case the committed book carries,
and it was made to fail first: widen the fold to count the house legs and it
goes red with `expected -7340 to be +0`.

**Do not read this as "the dispute machinery was wrong".** It was not: the
grant, the hold and the clawback all behaved exactly as designed, and the
account-wide numbers above are correct numbers. What was wrong was a *caption* —
an invariant asserted over a figure that other work can move — and the fix is to
assert it over a figure that nothing else can. That distinction is worth more
than the three columns: on a shared book, "it came out equal when I looked" and
"it cannot come out unequal" are different claims, and only the second one is
evidence.

### Is Reg E not violated by holding it?

No, and this is the domain point that decides the whole design. **Regulation E's
"give the consumer full use of the funds during the investigation" rule applies
to CONSUMER accounts.** This is a US *business* current account. Reg E does not
reach it; what governs is the card network's dispute rules and our deposit
agreement, and they leave availability to us.

So on a business book, provisional credit is a **commercial courtesy**, not a
statutory obligation, and holding it is legitimate. On a consumer book you would
have to release the hold at the moment of grant — and then eat the overdraft
risk on a loss, which is precisely the trade Reg E makes on the consumer's
behalf. The mechanism here supports both: it is one `hold_closure` row apart.

### Why `uncleared_credit`, and why `manual` is a trap

`manual` is the semantically tempting kind — released only by an explicit
decision, which is exactly what a dispute needs. **It is a trap**, and the
reason is measurable:

```ts
// src/lib/ledger/balances.ts, availableBalance()
COALESCE((SELECT SUM(ABS(cents)) FROM active_holds WHERE kind = 'card_auth'),         0)  AS holds_cents,
COALESCE((SELECT SUM(ABS(cents)) FROM active_holds WHERE kind = 'uncleared_credit'),  0)  AS uncleared_cents
...
availableCents: ledgerCents - holdsCents - unclearedCents
```

`availableBalance()` sums `card_auth` and `uncleared_credit` **and nothing
else**. A `manual` hold falls through the floor: it would withhold nothing in
the TypeScript path while `v_available_balance` (which folds *every* kind
through `v_hold_state`) subtracted it — the two would disagree about the same
hold, which is exactly the state migration 0011 existed to clean up. **A hold
kind that availability does not subtract is worse than a slightly stretched
label.**

So the kind is `uncleared_credit`. The 9200 control account's own note already
describes the shape — "credited when a credit posts to the ledger before it is
safe to spend" — and a dispute credit is one.

### `available_at = 'infinity'`, and why that is not a sentinel

`hold_clock` in 0001 requires an uncleared-credit hold to carry an `available_at`,
and `v_hold_state` releases such a hold when `now() >= available_at`.

A dispute credit is **not awaiting settlement, it is awaiting a decision**, so no
clock may ever release it. We set:

```sql
available_at = 'infinity'::timestamptz
```

which is not a far-future number somebody picked — it is the literal statement
that **the clock arm never fires**. `now() >= 'infinity'` is false, for all time,
by definition. Release is a `hold_closure` row and nothing else, which makes it
exactly-once by primary key.

**A deadline was deliberately kept out of `available_at`.** The network's outside
date (120 days, the outer edge of the Visa dispute lifecycle once representment
and pre-arbitration are allowed for) lives on `dispute.network_outside_date` and
drives an **ageing column on the screen**. Putting it in `available_at` would
have made `v_hold_release_drift` — a view asserted to be empty *for ever*, and
checked by `pnpm db:check` — fire on an ordinary business condition.

> Invariants are for impossible states. Deadlines are for operators.

---

## 3. The lifecycle is policed by a trigger

```
raised
  ├── provisional_credit_authorized   (a second human, above threshold)
  ├── provisional_credit_granted  ───► money moves, hold opens
  ├── provisional_credit_declined ───► no money moves
  ├── evidence_submitted          (repeatable, until a decision)
  │
  ├── won  ───────► credit_finalized       hold releases; credit stands
  ├── lost ───────► credit_clawed_back     customer repays   (the EDGE case)
  │           └──► credit_written_off      we eat it -> 5200
  └── withdrawn    (only while nothing has been advanced)
```

`assert_dispute_lifecycle()` is a `BEFORE INSERT` trigger on `dispute_event`, in
the shape `0007_approvals.sql` established. It refuses, among others:

* anything before `raised`, and a second `raised`;
* a second answer to the provisional-credit question;
* a grant at or above the threshold without the required authorisations;
* a "granted" event that does not cite **both** its journal entry and its hold;
* an amount that does not match the claim;
* **a withdrawal after money has been advanced** — that is a loss, not a
  withdrawal, and the operator must record it lost and then claw back or write
  off;
* `credit_finalized` on a case that was not won, and `credit_clawed_back` /
  `credit_written_off` on one that was not lost;
* **anything at all after a resolution.** A closed case is terminal.

`canTransition()` in `src/lib/disputes/model.ts` mirrors those rules. It is
**advisory only** — it exists so an operator reads "this case was already
decided" instead of a raw `55006`. If it were deleted tomorrow nothing illegal
would become possible.

`assert_dispute_intake()` is the same idea applied to *what may be disputed*:

* it must be a **card** entry in the **financial** book that **debited this
  customer** — an authorisation never reaches the financial book, so "you cannot
  dispute a hold" is structural rather than a rule anyone has to remember;
* **you cannot dispute money that has already come back** — the test is run over
  the whole **correction group**, so a settlement the merchant already reversed
  nets to zero and there is nothing left to claim;
* the sum of live claims against one charge may not exceed the charge, checked
  under `pg_advisory_xact_lock` on the disputed entry so a concurrent second
  claim cannot slip between the check and the insert;
* the deposit leaf and the memo leaf must belong to the **same** business.

### One transaction per transition, with the event inside it

Every operation opens one transaction that does the hold row, the posting
through `postEntry()`, **and** the `dispute_event` that cites them. The trigger
fires on the event insert, so a posting whose event is refused is rolled back
*with it*. There is no window in which money has moved and the case does not say
so, and none in which the case says so and the money has not moved.

---

## 4. The postings

The original clearing was `DR 2100/<customer>` / `CR 2200`. Nothing below
touches `2200` again: we already paid the merchant, and whether we get it back
is what the dispute is *about*.

| step | debit | credit | value date |
| --- | --- | --- | --- |
| provisional credit granted | `1120` receivable | `2100/<customer>` | the day we grant |
| ↳ the hold (memo book) | `9900` contra | `9200/<customer>` | same day |
| **lost → clawed back** | `2100/<customer>` | `1120` | **the day the NETWORK decided** |
| lost → written off | `5200` losses | `1120` | the day the network decided |
| won → finalised | *(financial book: nothing)* | | |
| ↳ the hold releases (memo) | `9200/<customer>` | `9900` contra | |

Four choices worth defending:

**`1120`, not `5200`, on the grant.** Advancing the money is not an expense and
not a refund; it is a **claim we have filed with the network**, which is what
1120 holds. It becomes an expense only if we lose *and* choose not to take it
back.

**Nothing ever debits `1110`.** Winning a dispute is a *promise* of money, not
an arrival. The chart's own note on 1110 forbids it: cash is debited "when funds
actually land there and never when a provider merely promises them." So
`credit_finalized` posts **nothing in the financial book** — the receivable
stays on 1120 until a scheme file funds it, which is exactly what 1120 is for
and exactly what reconciliation will then match. Winning does not credit the
customer a second time; it makes the credit they already have **spendable**.

**Both answers to "who eats it" are built.** `credit_clawed_back` takes it off
the customer; `credit_written_off` puts it on 5200, the account whose own note in
the chart names this case. Somebody always absorbs a lost dispute, and making it
an explicit operator choice beats a codebase that quietly decides.

**Every idempotency key is derived from the dispute id and the step** —
`dispute:provisional_credit:<id>`, `dispute:clawback:<id>`, and so on. A
double-submitted form posts once, decided by
`journal_entry.idempotency_key`'s unique index under the append lock, not by an
`if` anybody can forget.

---

## 5. Should a second human sign off a large advance? Yes.

**Decision: yes, above $50.00, one Corgi approver — enforced in the dispute's own
lifecycle trigger, not by routing through `payment_instruction`.**

### Why not `payment_instruction`

The approvals machinery in 0007 is bound to an instruction with a **rail**, a
**counterparty**, a **content hash** and a **release that submits to a
provider**. A provisional credit has no counterparty and no rail leg — it never
leaves the bank. Routing it through `payment_instruction` would mean fabricating
a payment that the payments queue, the release path and scheme reconciliation
would then all have to special-case.

### What IS reused

Everything genuinely shared, which is most of it:

* **`approval_policy`** — the same effective-dated, append-only table the payment
  rails are judged under. A `card` row now exists. `dispute.policy_id` pins the
  version the case was judged under, so raising the threshold later cannot make
  today's grants look like control failures.
* **`actor.can_approve` and `actor_only_humans_approve`** from 0001 — an agent
  approver is unrepresentable, not merely refused.
* **The maker-checker rule itself**, clause for clause.

Only the event stream is the dispute's own, because the subject is the dispute.

### One clause 0007 does not have

> **The counterparty to the advance cannot authorise it.**

Provisional credit is the bank advancing its own money **to this customer**. An
approver belonging to the disputing business would be approving a payment to
themselves. So the authoriser must be a human approver with
`business_id IS NULL`, who is not the raiser. Alex Whitfield holds
`can_approve = true` on Ridgeline's own payments and is refused here, by name,
in the integration test.

### Why $50.00 and not $2,500.00

The ACH threshold is set by **recoverability** — an entry is recallable for two
banking days, which bounds the damage. Provisional credit has **no recall window
at all**: if we advance and lose, we recover only from a balance that may not be
there months later, and there is no account number, no name and no counterparty
to verify against. The only control that exists is a second person reading the
case.

So the threshold is set by the **cost of the control** rather than the size of
the loss: below about fifty dollars the fully-loaded cost of an analyst reading a
case exceeds the expected loss from advancing it unreviewed, which is why real
issuers auto-grant small disputes and review the rest. A production book would
tier it — auto below $50, one checker to $2,500, two above. The policy table is
append-only and effective-dated precisely so that change is an INSERT.

The threshold is also deliberately **below** the canonical $73.40 fuel-pump
charge, so the graded path exercises the control rather than stepping around it.

---

## 6. The screen

`/disputes`, five URL-driven states, `?state=`:

| state | live? | what it shows |
| --- | --- | --- |
| `default` | **live** | every case, the customer's live position, and the settled charges still disputable |
| `loading` | fixture | a genuinely slow source behind a real Suspense boundary |
| `empty` | fixture | a customer who has never disputed anything — not an error |
| `error` | fixture | the read failed; nothing posted, retry is live |
| `edge` | **live** | **a case LOST after provisional credit was granted** |

The edge state is live on purpose. A fabricated clawback proves nothing; the
claim is that the ledger really behaves this way, and every entry id on that
screen can be looked up. It renders:

* both financial entries with `entry_type`, value date and booking sequence —
  the correction-versus-new-event decision, checkable rather than asserted;
* both memo entries, so the hold's life is visible;
* the three-row balance table above;
* the full `dispute_event` stream, with who did what and on which value date.

`?case=<uuid>` pins a specific case. Every case reference in the table links to
its own episode.

**The nav links here now.** That line landed in
`src/components/app-shell/NavLinks.tsx`; `Disputes` sits between `Payouts` and
`Reconciliation` on the deployed console and the screen no longer needs a URL
typed by hand.

### One thing the screen cannot do, and it matters for §1

**The intake form has no value-date field.** `raiseDispute()` takes one — it is
how `dispute.value_date` and therefore `network_outside_date` are set — but
`raiseDisputeAction` does not pass one, so a claim is always recorded as raised
on the day the button was pressed. A customer who rang on Monday and whose case
is opened on Wednesday gets a 120-day network clock starting Wednesday.

The Work-a-case panel *does* carry a value date, and it applies to every
transition including the grant and the clawback, so the day the network decided
is fully operator-controlled. Only intake is pinned to today.

---

## 7. What this cost the invariants

`node scripts/dbcheck.mjs` reads **42 passed, 4 failed** as of 2026-09-11 after
thirty complete episodes moved real money on the live book. The four failures
are the deliberate red-on-arrival findings this repository publishes rather than
hides (`v_refused_auth_hold`, `v_hold_expiry_drift`, `v_advice_delta_unsound`,
`v_hold_closure_unexplained`) — none of them is a dispute view, and
`v_dispute_ledger_double_count` is empty. In particular
`v_hold_release_drift` stays empty because every closure is written in the same
transaction as the memo posting that drives the hold to zero — closure **first**,
posting **second**, so a crash between them leaves available balance already
correct and the posting as bookkeeping.

`src/lib/ledger/boundary.test.ts` is a ratchet on how many places outside
`src/lib/ledger/**` write SQL against `journal_entry`, `journal_line` and
`account`. The dispute module's whole bill is **12 references in one file**
(`src/lib/disputes/store.ts`); `screen.ts`, the components and the actions have
zero. Two queries that would have been obvious to write here are borrowed
instead: the ledger half of the bitemporal balance is `balanceAsBelieved()` from
the ledger module, and the memo-hold balance is `memoHoldBalance()` from the
holds module — the same question about the same tables, asked once.

---

## 8. Known gaps, honestly

All found by running the feature against the live book rather than by reading
it, and all recorded here rather than quietly fixed. **The first two are now
CLOSED** and are kept here with their closing evidence, because a gap list that
only grows is a gap list nobody re-reads.

1. ~~**A clawback entry was itself disputable.**~~ **CLOSED by migration 0023
   §3a.** The rule — a disputable charge must **also credit `2200`**, the shape
   of a real clearing or force post, the customer debited *and the network
   paid* — is now inside `assert_dispute_intake()`, so a caller that never asks
   `listDisputableCharges()` meets it anyway. The TypeScript clause stays as a
   courtesy in front of the enforcement, which is the right order.

   Fired for real on 2026-09-11, as `corgi_app`, in a rolled-back transaction
   against the clawback this document's own episode posted:

   ```
   INSERT INTO dispute (… disputed_entry_id = 'f4c38dc9-0300-4ced-880a-c83da986173e' …)
   ERROR 42501: entry f4c38dc9-0300-4ced-880a-c83da986173e debits the customer but
                credits no network settlement payable (2200): it is not a card
                clearing, so there is nothing to dispute and no network case to file
   ```

   The control for it matters as much as the refusal: the *same* INSERT aimed at
   the real Lithic clearing `6644e337-…` was **accepted** (and rolled back). The
   guard is the 2200 clause, not a blanket refusal. The one dispute that was
   raised against a clawback before 0023 — `ccbf1b9e-67f0-47b4-af8e-54640bbeebc9`
   against `104a6564-ba16-4610-a859-725c110de23a` — is left standing, because
   deleting history to make a guard look older than it is would be the worse
   crime.

2. ~~**`v_dispute_ledger` double-counts one entry on a WON case.**~~ **CLOSED by
   migration 0023 §3b**, and fixed by ANTI-JOIN rather than by `DISTINCT`: the
   memo source yields only what the events do not already carry, so a duplicate
   arising any *other* way still surfaces instead of being silenced along with
   this one. `v_dispute_ledger_double_count` is the standing assertion over it
   and is in `dbcheck`. Measured empty on 2026-09-11, including immediately
   after DSP-20260911-8U46YC closed: eight lines, four entries, each exactly
   once.

3. **No correction path for a mis-keyed grant.** See §1. The argument is
   written; the code is not. Still open.

4. **The two-value-date case is unexercised on the live book.** §1's whole
   argument is that the grant stands on its day and the clawback on the decision
   day, and `DISPUTE_STATUS_MEANING.closed_lost_recovered` says so to the
   operator in as many words. The mechanism is real — `clawBackCredit()` takes
   the value date, and the Work-a-case panel exposes it — but **every clawback
   on this book carries its grant's value date**: eleven cases as of
   2026-09-11, all same-day, because nobody has ever typed a different one.

   What IS proved, on DSP-20260911-8U46YC: the grant (`e71c9140-…`, seq 5677)
   and the clawback (`f4c38dc9-…`, seq 5762) are two separate entries, both
   `entry_type = 'original'`, in two different `correction_group_id`s, with
   `reverses_entry_id` NULL on both. Nothing was rewritten. What is NOT proved
   by any episode is the pair of *dates*, and a same-day episode cannot prove
   it. It needs a case granted on one book day and decided on the next; the
   honest way to get one is to leave a case open overnight, not to type
   yesterday into a form.

5. **The intake form cannot date a claim.** See §6. `network_outside_date` — the
   120-day network clock the ageing column runs on — therefore always starts on
   the day the case was keyed rather than the day the customer rang.

### Cut list, week two

* A value date on the intake form, so the 120-day clock starts on the day the
  customer rang. One field, one schema line, one argument already written.
* The correction path, with hold re-sizing.
* Partial dispute amounts exercised end to end (the schema and both triggers
  already allow them; only the demo claims the full charge).
* A scheme-file row shape for chargeback recoveries, so `1120` can be
  reconciled rather than merely accumulated.
* Ageing on the breaks screen for cases past `network_outside_date`.
* Customer-facing notice generation — Reg E requires written notice of
  provisional credit on consumer accounts, and a business book should send one
  anyway.

---

## 9. What was actually fired, on the deployed system, on 2026-09-11

Not a checklist. Every line below is a real call with a real id, either through
`https://corgi-trial-psi.vercel.app/disputes` as an operator or as `corgi_app`
against the live Neon book in a transaction that was rolled back. Where a
refusal is quoted, it is the text the refuser produced, not a paraphrase.

### The episode

One complete case, worked through the deployed console.

| | |
| --- | --- |
| case | **DSP-20260911-8U46YC**, `8bfa7f1f-f530-4956-a47d-62cfe07f396f` |
| customer | Ridgeline Robotics, Inc. — `2100` leaf `a0c41a37-2be1-5c30-bfe9-03455f048fac` |
| the charge | `6644e337-1e64-4abc-bc6c-b0f2d31e6e17`, $73.40, value date 2026-09-11 |
| its shape | `DR 2100/Ridgeline 7340` / `CR 2200 −7340` — a clearing, and the 2200 leg is why it is disputable |
| its provenance | Lithic card ••2989, provider auth `4bf213f2-fdd9-4869-832a-59e5402ba295`, origin `authorization`, delivered by webhook `msg_3JBVu9Ce4g7Y5Zbk7wy5uifhItj` (`card_transaction.updated`, `signature_verified_at` set, state `done`, received 13:51 UTC) |
| raised by | Priya Raman — Corgi staff, `can_approve = false` |
| authorised by | Dana Okonkwo — Corgi approver, `business_id IS NULL` |
| the hold | `24b03c1c-5151-4d68-9251-c6b7f8ded9ed`, `uncleared_credit`, `available_at = 'infinity'` — checked: `now() >= available_at` is **false** |

Four entries, eight lines, each appearing exactly once in `v_dispute_ledger`:

| step | entry | book | seq | type | lines |
| --- | --- | --- | ---: | --- | --- |
| provisional credit | `e71c9140-afeb-4a30-bdcc-7ff9d6ae0217` | financial | 5677 | original | `CR 2100 −7340` / `DR 1120 +7340` |
| the hold opens | `a5cdc333-795d-4d65-83ea-7b26ef3f6504` | memo | 5678 | original | `CR 9200 −7340` / `DR 9900 +7340` |
| the hold releases | `e0c04c09-c6cf-4082-84b6-13bbf2028fc6` | memo | 5761 | original | `DR 9200 +7340` / `CR 9900 −7340` |
| the clawback | `f4c38dc9-0300-4ced-880a-c83da986173e` | financial | 5762 | original | `DR 2100 +7340` / `CR 1120 −7340` |

**Nothing is a reversal.** All four carry `entry_type = 'original'`, all four
sit in their own `correction_group_id`, and `reverses_entry_id` is NULL on every
one. The clawback is a new event, and it is checkable rather than asserted.

### What the customer sees, and why it is not two charges

Their `2100` leaf, in booking order, for 2026-09-11:

```
5497   Card clearing 4bf213f2-fdd9-4869-832a-59e5402ba295          + $73.40
5677   Provisional credit DSP-20260911-8U46YC — fraud              − $73.40
5762   Dispute DSP-20260911-8U46YC lost — provisional credit recovered  + $73.40
```

Three lines, net **one** charge of $73.40 — exactly what they spent. The third
line is not a purchase and does not read as one: it names the case, says the
case was lost, and says the thing being recovered is the credit we advanced. A
customer reading it sees the money we gave them going back, not a second visit
from the merchant. The middle line is the letter we sent them, on the ledger,
on the day we sent it — which is the whole reason it must not be reversed away.

### Every refusal, fired

Through the deployed console, as an operator:

| control pressed | acting as | refusal |
| --- | --- | --- |
| Grant provisional credit | Priya Raman (raiser) | `NEEDS_AUTHORIZATION` — *"This advance is at or above the threshold and needs 1 authorisation(s) from a Corgi approver who did not raise it; it has 0."* |
| Authorise the advance | Priya Raman (raiser) | `REFUSED_BY_POLICY` — *"actor b3c4f786-5d1b-5194-9aae-6342ba0ef606 (kind human) is not an approver"* |
| Customer withdrew | Dana Okonkwo | `CREDIT_OUTSTANDING` — *"Provisional credit is outstanding, so this is not a withdrawal — it is a loss. Record the case lost, then claw back or write off."* |

The screen prints the prediction beside the control rather than hiding it: the
grant button reads **"Grant provisional credit (will be refused)"** with
`no posting` beside it while the case is unauthorised, and flips to
**"Grant provisional credit"** with `posts money` the moment a second human has
signed. Nothing is greyed out — a control you are not entitled to press is shown
and refused, because a disabled button invites somebody to find out who can.

At the trigger, as `corgi_app`, each in its own rolled-back transaction:

| probe | SQLSTATE | what `assert_dispute_*` said |
| --- | --- | --- |
| dispute the clawback entry `f4c38dc9-…` | 42501 | *"entry … debits the customer but credits no network settlement payable (2200): it is not a card clearing, so there is nothing to dispute and no network case to file"* |
| **control:** the same INSERT against the real clearing | — | **accepted**, then rolled back |
| Dana Okonkwo authorises the case Dana raised | 42501 | *"maker-checker: actor 76f9266f-… raised dispute … and cannot authorise its provisional credit"* |
| Alex Whitfield authorises (an approver — but **Ridgeline's own**) | 42501 | *"actor 3b805475-… belongs to a customer business and cannot authorise an advance to a customer"* |
| the Corgi payments agent authorises | 42501 | *"actor 3743dc53-… (kind agent) is not an approver"* |
| `provisional_credit_granted` citing no entry and no hold | 23502 | *"a granted provisional credit must cite both its journal entry and its hold"* |
| file evidence on the closed case | 55006 | *"dispute 8bfa7f1f-… is resolved and closed; evidence_submitted is not available any more"* |

The Alex Whitfield row is the clause `0007` does not have, and it is the one
worth reading twice: he holds `can_approve = true` and approves Ridgeline's own
payments every day. He is refused **here** because the money being advanced is
being advanced *to Ridgeline*, and an approver inside the counterparty is an
approver approving a payment to themselves.

### The one intake refusal the operator never has to meet

`listDisputableCharges()` filters the 2200 rule out of the dropdown before an
operator can pick it, so the trigger refusal above is the second line of
defence and not the first. Checked on the live screen after the episode closed:
the clawback `f4c38dc9-…` is a card-rail entry that debits Ridgeline $73.40 on
2026-09-11 and is **absent** from the settled-charge list, while the
still-unclaimed clearing on card ••9128 is present. A list is a courtesy; the
trigger is the rule; both are in place and they agree.
