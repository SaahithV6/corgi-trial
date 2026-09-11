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

Live, on the real book (`/disputes?state=edge` renders exactly this table):

| step | booking seq | ledger | − holds | = available |
| --- | ---: | ---: | ---: | ---: |
| before the claim | 1477 | $27,189.32 | $19,164.00 | **$8,025.32** |
| provisional credit granted | 1479 | $27,262.72 | $19,237.40 | **$8,025.32** |
| after the case resolved | 1481 | $27,189.32 | $19,164.00 | **$8,025.32** |

The ledger moves twice. Available does not move once.

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

**The nav does not link here yet.** `src/components/app-shell/NavLinks.tsx` is
owned by another workstream, and `typedRoutes` means the link only compiles once
this route exists — which it now does. One line, `{ href: "/disputes", label:
"Disputes" }`, is all it needs. Until then the screen is reachable by URL.

---

## 7. What this cost the invariants

`pnpm db:check` passes in full (22/22 at the time of writing) after ten
complete episodes moved real money on the live book, including every invariant
view. In particular
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

Three, all found by running the feature against the live book rather than by
reading it, and all recorded here rather than quietly fixed:

1. **A clawback entry was itself disputable.** It is a card-rail entry that
   debits the customer, so it matched the intake query. The guard added is that
   a disputable charge must **also credit `2200`** — the shape of a real clearing
   or force post: the customer was debited *and the network was paid*. That
   guard currently lives in `listDisputableCharges()`, which both the form and
   `raiseDispute()` go through. **It belongs in `assert_dispute_intake()`**, and
   0019 is applied and therefore immutable, so it wants a follow-up migration.

2. **`v_dispute_ledger` double-counts one entry on a WON case.** The view unions
   entries cited by an event with the memo entries reachable through the grant's
   hold, and those sets overlap in exactly one place: the finalising event cites
   the hold *release*, which is also a memo posting on that hold. `UNION` does
   not collapse them because `event_kind` differs. Deduped at the read site with
   `DISTINCT ON (entry_id, ordinal)`; the fix belongs in the view.

3. **No correction path for a mis-keyed grant.** See §1. The argument is
   written; the code is not.

### Cut list, week two

* The correction path, with hold re-sizing.
* Partial dispute amounts exercised end to end (the schema and both triggers
  already allow them; only the demo claims the full charge).
* A scheme-file row shape for chargeback recoveries, so `1120` can be
  reconciled rather than merely accumulated.
* Ageing on the breaks screen for cases past `network_outside_date`.
* Customer-facing notice generation — Reg E requires written notice of
  provisional credit on consumer accounts, and a business book should send one
  anyway.
