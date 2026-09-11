# GAUNTLET 1–5 — driven, not read

Audited against the deployed build at `https://corgi-trial-psi.vercel.app`, commit
`463488a`, on 2026-09-11 between 22:30 and 23:05 UTC. Every verdict below is
backed by a command that was run and output that came back. Where a claim could
not be driven, it says so and says what would drive it.

The bar is not "is it present". The bar is: **would a reasonable engineer, told
only the repo's own sentence about a limitation, correctly predict what happens
when they press the button?** Where they would be surprised, it is called a
defect wearing a disclosure.

| # | Requirement | Verdict |
|---|---|---|
| 1 | Ledger vs available, derived from events | **HOLDS.** One function body, no stored column, uncleared-credit rule driven live. Two guards are weaker than they look — finding 2, 3 |
| 2 | Authorisation lifecycle, hold releases exactly once | **HOLDS.** Exactly-once is a primary key, not an argument. The over-capture gap is a genuine, measured decision — see §2 |
| 3 | Settlement ≠ authorisation, incl. force post | **HOLDS.** All three shapes live, nothing branches on origin. "Days later" is unit-proven only, and carries a table-vs-code divergence — finding 1 |
| 4 | Out-of-order delivery: park, match later, never double-count | **HOLDS.** Three unique constraints, not logic. Proven live this session by accident |
| 5 | Returns and recalls, corrected position on the day it happened | **HOLDS for inbound ACH — driven live this session, first attempt.** Outbound ACH return and wire reversal remain **UNEXERCISED** |

The headline of this audit is point 5. The previous audit recorded it as PARTIAL
on the grounds that no return or recall webhook had ever been delivered and the
card rail was carrying the requirement as a substitute. That was true of the
book as it stood. **It is no longer true.** The inbound-ACH recall path was
driven end to end against the live Increase sandbox and the deployed webhook
endpoint during this audit, and it worked correctly on the first attempt. The
detail is in §5.

---

## 1. Ledger vs available — HOLDS

Available is not a column and, better than the claim states, it is not even a
view body: `v_available_balance` is a *call* into one Postgres function,
`ledger_availability(account, value_date, booking_seq, as_of)`
(`db/migrations/0022_balance_definitions.sql:155`, current version
`0053_fx_commitment_hold.sql:218`). Four terms, one body:

```
available = ledger_settled_cents(...)   -- value_date <= p AND booking_seq <= p
          - hold_cents                  -- card_auth + manual, value-date gated
          - uncleared_cents
          - pending_outbound_cents      -- future-dated debits, netted per entry
```

The view exposes every term in its own output shape, which is what makes it
checkable rather than merely asserted:

```
account_id, business_id, ledger_balance_cents, active_holds_cents,
available_cents, card_hold_cents, uncleared_credit_cents,
pending_outbound_cents, value_date, booking_watermark
```

Three properties worth naming. It is **not clamped** — an over-captured fuel-pump
authorisation settles above the amount authorised and the view says the customer
is overdrawn rather than flooring at zero (`0022:255-259`). The release predicate
is re-derived at the parameterised instant, so an uncleared credit becomes
available **by the clock, with no posting and no job**. And the four rival
TypeScript definitions of "available" that used to exist have been collapsed into
calls on this one body; the MCP agent's fifth copy was deleted outright
(`src/lib/mcp/gateway.ts:95-144`).

### Two caveats about the guards — the guards are weaker than they look

**The "no stored balance column" check is name-shaped, and one table was named
around it.** `scripts/dbcheck.mjs:121-127` fails the build on any base-table
column matching `%balance%` or `available_cents`, with two argued exceptions. But
`db/migrations/0012_standing_orders.sql:364` says in its own comment:

> `-- Deliberately NOT named *_balance_* or 'available_cents': 'pnpm db:check'`
> `-- fails the build on a stored balance column, and it is right to, so these`
> `-- carry the 'observed_' prefix`

Those columns are defensible — they are as-observed audit figures behind a refusal
decision, CHECK-constrained in `0023_guard_repairs.sql:208-225` to make the five
terms add up on the row, and read only as history. But **the guard did not catch
them; the argument did.** A future `observed_*` column that *is* read as a live
position would pass the check.

**Half of `v_balance_definition_drift` is a tautology.** Its second disjunct
(`0022_balance_definitions.sql:378-384`):

```sql
OR ab.available_cents <> (ab.ledger_balance_cents - ab.active_holds_cents - ab.pending_outbound_cents)
```

cannot ever fire. Within the same view `active_holds_cents := hold + uncleared`
and `available_cents := ledger − hold − uncleared − pending`, both taken from one
`ledger_availability()` row. The subtraction is algebraically identical by
construction. Only the **first** disjunct — availability's hold terms versus an
independently-evaluated `Σ v_hold_state.active_hold_cents` — is a real test. This
matters because the tautological half is the half that *reads* like "available is
not a stored number", and it proves nothing about that. The real proof of that
claim is the absent column plus the single function body, not this view.

Both caveats are reported as findings. Neither moves the verdict: the derivation
is genuinely single-bodied and genuinely unstored.

### Driven

The uncleared-credit rule — the one part of point 1 that is a *policy* and not
just arithmetic — was exercised live in §5. An inbound ACH credit of
**$4,123.00** was booked against a fixture business. Immediately afterwards:

```
ledger_balance_cents : -85481845
active_holds_cents   :    840600   (card_hold 428300 + uncleared_credit 412300)
available_cents      : -86322445
```

The **ledger moved by the full $4,123.00 and available did not move at all** —
the credit was simultaneously posted and withheld under the `ach/new`
funds-availability policy, two banking days, released `2026-09-15 09:00 ET`. The
hold is a real row in the memo book (`journal_entry` booking_seq 12324,
`book='memo'`), not a flag, which is what makes it provable from events.

The policy behind that hold is **data**, not code: `funds_availability_policy`
keyed `(rail, counterparty_class, effective_from)`, append-only, and
`hold.policy_id` FKs the exact row the hold was opened under. Where no policy row
covers a credit, nothing is booked at all —
`src/lib/rails/increase/inbound-ach-ledger.ts:326`: *"a credit whose availability
nobody has decided is not one this system will make spendable by default."*
Refusal rather than a default is the right shape and it is the shape here.

### Invariants read green

```
v_entry_unbalanced         = 0
v_book_not_zero            = 0
v_balance_definition_drift = 0     (but see the tautology caveat above)
v_hold_drift               = 0
v_hold_release_drift       = 0
```

**Verdict: HOLDS.** Available is derived from one function body, there is no
stored available column, the derivation is visible term by term in the view's own
output, and the uncleared-credit rule was observed binding and then releasing on
live data during this audit. The two guard weaknesses above are real and are
reported, but they weaken the *proof*, not the property.

---

## 2. Authorisation lifecycle — HOLDS, with one gap that is a genuine decision

`hold_closure` has `PRIMARY KEY (hold_id)`. That is the "exactly once" guarantee,
and it is structural rather than procedural: no arrival order can write a second
row, because the database will not accept one. Arrival order is therefore not a
correctness argument the code has to make — it is a constraint the schema
enforces.

### The named gap, and the measurement that settles it

**Over-capture writes no `hold_closure` row.** This is true and it is the thing
the previous audit flagged. The question the brief asks is whether that is a
genuine decision or an excuse. It is a genuine decision, and here is why.

Measured on the live book:

```sql
select count(*), count(*) filter (where exists(select 1 from hold_closure c
                                               where c.hold_id = s.hold_id))
  from v_card_auth_state s ...
 where s.captured_cents > s.auth_net_cents and s.auth_net_cents > 0;
```

```
288 over-captured authorisations with A > 0
 67 carry a hold_closure row    (these are force_post origin: A=441, C=11478)
221 carry none
```

Sampling the 221, every single one reads:

```
A = 5000, C = 7340, target_hold_cents = 0, memo_balance_cents = 0
is_closed = false, is_released = false, closures = 0
```

**`memo_balance_cents = 0`.** That is the load-bearing number. The customer's
money is already free. `H = max(A − C, 0)` clamps the hold to zero the moment
capture exceeds authorisation, and `v_available_balance.active_holds_cents` reads
the memo book, not the `is_released` flag. So the missing `hold_closure` row
withholds **nothing**. A reasonable engineer told "over-capture writes no closure
row" might reasonably fear money is stuck; it is not, and that is the one thing
they might get wrong, so it is stated plainly here.

The reason the row is *correctly* absent is in `src/lib/holds/model.ts` and it is
a measured fact about Lithic, not a rationalisation. `terminallyClosed` is
deliberately narrower than `closed`, because `hold_closure` is append-only and
irreversible — so its predicate must be **monotone**: true on a set implies true
on every superset. Three arms qualify (`sawFinal`, `sawClose`, `expired`); `A ≤ 0`
does not, because `A` is a running total that can go back up.

Over-capture is the case that proves it. Lithic accepted an `AUTHORIZATION_ADVICE`
for 9000 after a 7340 over-capture of a 5000 authorisation; the hold **reopened
for 1660** and the network then captured it. Closing on `captured >= authorised`
would have written an unremovable row freeing money that was still authorised.
The 221 rows above are that shape sitting on the book right now, holding nothing
and correctly still open.

**This is a decision, not an excuse.** The disclosure is accurate and the
behaviour a reader would predict from it is the behaviour they get — with the
one caveat above, which is why this document states the `memo_balance_cents = 0`
measurement rather than leaving "no closure row" to be read as "money stuck".

### A smaller, real gap

The `hold_closure` row written by the inbound-ACH recall path (§5) carries
`source = NULL`:

```json
{"hold_id":"24662d6d-...","source":null,
 "reason":"inbound ACH sandbox_inbound_ach_transfer_0t67lp0xhi46quk9zsxr was
           recalled on 2026-09-11 (credit_entry_refused_by_receiver); ..."}
```

Every other writer declares one (`posting_path`, `expiry_sweep`,
`availability_sweep`, `dispute`, `wire_availability`, `repair`, `test_harness`).
`v_hold_closure_census` therefore files recall closures under `(undeclared)` with
`in_guard: false`. No money is affected — `defect_shape` is 0 for that bucket —
but the recall path is outside the census guard that covers the other writers.
This is a one-line omission, not a design position, and it is not disclosed
anywhere. **Reported as a finding.**

**Verdict: HOLDS.** Exactly-once is enforced by the primary key, not by argument.
The over-capture gap is a correct and measured decision. The `source = NULL`
omission is a genuine small defect, reported above.

---

## 3. Settlement is not authorisation — HOLDS

All three shapes are on the live book as first-class origins, not special cases:

```sql
select origin, count(*) from card_authorization group by 1;
```

```
authorization  : 833
clearing_first : 222
force_post     :  60
```

`force_post` is **settlement with no authorisation at all** — 60 of them, booked
through the same `card_authorization` row shape as everything else. `clearing_first`
is a clearing that arrived before its authorisation (see §4). Neither is a branch
bolted onto the authorisation path; both are values of a single `origin` column,
which is what "no special-casing" has to mean to be worth anything.

The absence of special-casing is structural, not stylistic.
`src/lib/holds/store.ts:184-186`: *"`origin` is recorded for reporting and
NOTHING branches on it."* `db/migrations/0001_ledger.sql:487` declines to give
`card_authorization` a status column at all — *"State is a fold over
`card_auth_event`, which is why a settlement arriving before its own
authorisation needs no special case: there is no order to be out of."* And there
is no force-post branch in the posting path: `apply.ts:290` calls
`ensureAuthorization` unconditionally, so a force post creates the same identity
row, computes `H = max(0 − 0, 0) = 0`, and `postHoldDelta` posts nothing because
the delta is zero. No `if`.

Driven: `holds.integration.test.ts:578-635` posts a $500,000
`FINANCIAL_AUTHORIZATION` with no authorisation behind it, asserts
`holdCents === 0n`, asserts available falls by the full amount and goes negative,
and asserts the account appears in `v_overdrawn_accounts`. That is the honest
answer rather than a clamp.

**Different amount** is routine and visible: the 5000/7340 pairs in §2 are an
authorisation of $50.00 settling at $73.40, with available moving by −7340, not
by −5000.

### "Days later" is the weak leg, and there is a live divergence in it

This is where a reader should slow down, and where I have to correct a quote I
would otherwise have used as evidence. `rail_event_semantics` says:

> `card_transaction.updated/CLEARING` → `value_date_source = payload.created`,
> *"Value date is the LOCAL TRANSACTION DATE, not the settlement date: a Friday
> dinner that clears on Monday is Friday's spend."*

**The code does not do that.** `src/lib/holds/lithic-events.ts:463` reads
`lithicEvent.created` — the clearing event's own date, i.e. the *settlement*
date — not `txn.created`:

```ts
const valueDate = bookDate(new Date(lithicEvent.created ?? txn.created));
```

So on the card rail the Friday dinner that clears on Monday books as **Monday's**
spend, which is the opposite of what the reviewed policy row claims. Three things
make this a disclosed divergence rather than a hidden bug, and one thing keeps it
a finding anyway:

- It is **pinned as a characterisation test**. `src/lib/rails/semantics.test.ts:1026`
  asserts `CLEARING: { kindMatches: true, datedAsTableSays: false }`, with
  fixtures `TXN_CREATED = 2026-09-04` (Friday) against
  `EVENT_CREATED = 2026-09-07` (Monday). The days-later path *is* exercised, and
  the test asserts the code picks Monday.
- `docs/RAIL-SEMANTICS.md:143-165` tabulates it: *"The table is a set of claims.
  Wiring the reader does not by itself make the posting code obey it."*
- `value_date_source` is **inert on the card rail**. Nothing under
  `src/lib/holds/` reads the column; only the ACH and wire consumers resolve it
  through `valueDateFromSource()`. So "the ledger reads the table" is true for
  dates on ACH and wire, and not true on cards.

**The finding:** a reader who queries `rail_event_semantics` to learn how a card
clearing is dated will get the wrong answer, and the table is presented
everywhere else as the authoritative statement of exactly that. Disclosed in a
doc and pinned in a test is better than silent, but the data and the code
disagree, and the data is the thing the system invites you to trust.

Separately, `scripts/coreloop.mjs:1728-1732` states outright that the live loop
never drives a genuinely late settlement — *"'days later' is the one half of this
leg the sandbox cannot be made to perform: Lithic clears on demand."* So for
cards, "days later" is **unit-proven only**.

**Verdict: HOLDS.** All three shapes are on the live book (1,115 rows across the
three origins), they run through one code path with nothing branching on origin,
and different-amount and no-auth-at-all are both driven. "Days later" is proven at
unit level rather than under live drive, and carries the table-versus-code
divergence above as a reported finding.

---

## 4. Out-of-order delivery — HOLDS

`clearing_first` being a first-class `origin` with **222 rows on the live book** is
the verdict: a settlement arriving before its authorisation is a state the
schema names, not an error it recovers from.

The parking machinery is live and visible in `v_webhook_parked` right now — 31
`card_transaction.updated` deliveries parked on `parked_on_kind = 'card'` with
`parked_reason` "card … is not registered to a customer", each carrying
`park_attempts` and `next_attempt_at` for redrive. Parking is on a *named
dependency*, so the arrival of the thing being waited for is what wakes the
parked delivery.

### Never double-count — driven live, unplanned

This was demonstrated by accident during §5, which makes it better evidence than
a designed test. Five webhook deliveries landed for the same inbound ACH transfer:

```
inbound_ach_transfer.updated  done  sandbox_event_001m299zx7fnxnmdk1va6nqj4w   (real, from Increase)
inbound_ach_transfer.created  done  sandbox_event_001m299zx4ym7xktw3m5gs2edg   (real, from Increase)
inbound_ach_transfer.created  done  sandbox_event_gauntlet5_cbfd38cb859b45a0   (constructed, re-signed by this audit)
inbound_ach_transfer.updated  done  sandbox_event_001m29a1x1cjy2z5sdwbbswk7t   (real, from Increase)
inbound_ach_transfer.updated  done  sandbox_event_gauntlet5_a1ab4dc654174446   (constructed, re-signed by this audit)
```

Note the first line: an `.updated` for this transfer was delivered and processed
**before** the `.created` that describes its arrival. That is the out-of-order
case, delivered by the real provider, unprompted.

Five deliveries, all `done`, none parked, none dead. The book carries **exactly
two** financial entries for the transfer (booking_seq 12323 and 12344) and
**exactly two** memo entries (12324 and 12345). My duplicate `.created` delivery
processed at 22:39:39 and left `booking_watermark` unchanged at 12324 — it booked
nothing, because the idempotency key
`ach:inbound:sandbox_inbound_ach_transfer_0t67lp0xhi46quk9zsxr` was already taken.

Idempotency is keyed on the **provider object**, not on the delivery. That is the
right key: it is what makes a redelivery, a duplicate, and an out-of-order arrival
all collapse to the same already-booked entry.

### It is constraints, not logic

The no-double-count guarantee is three unique indexes and no `if`:

| Layer | Constraint | Where |
|---|---|---|
| Envelope | `webhook_inbox UNIQUE (provider, provider_event_id)` | `0001_ledger.sql`; documented `0002:198` |
| The money | `journal_entry.idempotency_key text NOT NULL UNIQUE` | `0001_ledger.sql:289` |
| Domain | `card_auth_event_dedup UNIQUE (auth_id, provider_event_id)` | `0001_ledger.sql:517` |

Ingestion is a single `INSERT ... ON CONFLICT DO NOTHING` whose row count
distinguishes a first delivery from a redelivery — *"There is no
SELECT-then-INSERT anywhere in the codebase."* The money check is made twice
inside `ledger_append`, once cheap and once under `pg_advisory_xact_lock`, and a
replay **returns the original entry id at the original value date** rather than
re-dating it (`0001_ledger.sql:886-896`). The domain index is what makes the card
event stream a *set*, which is what makes `H(E)` order-free.

The comment at `0001_ledger.sql:282` states the intent exactly: *"Last line of
defence: even if the inbox and the event-stream unique keys were both bypassed,
the money cannot be written twice."*

### How parking wakes up

`parked_on_kind`/`parked_on_ref` are `NOT NULL` when parked
(`webhook_inbox_parked_needs_referent`, `0002:139`), so a park always names what
it is waiting for. A consumer that succeeds returns a `produced` list of the
things it made real, and `unparkWaitingFor()` flips every parked row matching
those `(kind, ref)` pairs back to `pending` in one statement. Under it sits a
timer: the claim query takes `state IN ('pending','parked') AND next_attempt_at <= now()`,
so *"a park never depends on another event turning up for the row to be looked at
again."* Parks are bounded at 12 attempts, then dead-letter naming the exact
string that did not match.

### One caveat on the existing test

`src/test/livefire/attack-04-settlement-before-authorisation.test.ts` drives this
properly — real Lithic sandbox, real deliveries pulled back out of `webhook_inbox`,
re-signed clearing-first, every event token re-issued so episode B is not a replay
of episode A, and it asserts equal deltas plus exactly one clearing per token plus
zero dead letters. But **almost every failure path in it is `ctx.skip(reason)`
rather than a failure.** A missing credential, a poll that times out, a card that
never registers — all skip. A skip is not a pass, and a reader of a green run
should confirm the evidence lines were actually written rather than that the test
did not fail.

**Verdict: HOLDS.** Out-of-order arrival is a named origin with 222 instances and
no branch reads it; the guarantee is three database constraints rather than
logic; parking is live, named and bounded; and no-double-count was proven on live
data this session with five deliveries — one of them genuinely out of order from
the real provider — collapsing to two entries.

---

## 5. Returns and recalls — the inbound half, driven live

### What the previous audit found, and what changed

The previous audit recorded: ACH and wire returns have zero webhooks ever
delivered; `webhook_inbox` has no return or reversal row book-wide; the card rail
carries item 5 as a substitute. It flagged this as the disclosure most likely to
be covering a gap, because the brief says returns are where the design shows and
the literal scenario had never been exercised.

**The code path exists, it is correct, and it was merely unexercised.** It has now
been exercised. This section is the record.

### The construction

Increase webhooks are **thin**. The delivery body is an event pointer only:

```json
{"id":"sandbox_event_...","type":"event","category":"inbound_ach_transfer.updated",
 "created_at":"...","associated_object_id":"sandbox_inbound_ach_transfer_...",
 "associated_object_type":"inbound_ach_transfer"}
```

There is no transfer body in the webhook, so a return **cannot** be faked by
writing a payload — the consumer re-fetches the object from the Increase API and
reads its true status. That is a nice property and it is why this test is real:
the only way to drive a return is to actually return a transfer at the provider.

So the transfer was created and returned for real, on the live Increase sandbox,
against a **fixture** business (Holds Integration Fixture Co., EIN `00-0000000`,
virtual account number `sandbox_account_number_49ummbukvor7j75lxisw`):

```
POST https://sandbox.increase.com/simulations/inbound_ach_transfers
     {"account_number_id":"sandbox_account_number_49ummbukvor7j75lxisw",
      "amount":412300,"company_name":"GAUNTLET5 CO"}
 ->  id sandbox_inbound_ach_transfer_0t67lp0xhi46quk9zsxr
     status "accepted", effective_date "2026-09-11", trace 610029771703037,
     transfer_return null

POST https://sandbox.increase.com/inbound_ach_transfers/
       sandbox_inbound_ach_transfer_0t67lp0xhi46quk9zsxr/transfer_return
     {"reason":"credit_entry_refused_by_receiver"}
 ->  status "returned"
     transfer_return {reason: "credit_entry_refused_by_receiver",
                      returned_at: "2026-09-11T22:40:16Z",
                      transaction_id: "sandbox_transaction_06uy6i0uzphu870sdd41"}
```

Event pointers were then signed under Standard Webhooks with this deployment's
own `INCREASE_WEBHOOK_SECRET` (raw bytes, not base64-decoded — Increase's scheme,
matching `increaseVerifier`) and POSTed to the **deployed** endpoint:

```
POST https://corgi-trial-psi.vercel.app/api/webhooks/increase
 ->  HTTP 202 {"status":"accepted","inboxId":"9539bf26-...","eventType":"inbound_ach_transfer.created"}
 ->  HTTP 202 {"status":"accepted","inboxId":"95d1dea5-...","eventType":"inbound_ach_transfer.updated"}
```

Increase's own subscription also delivered the same events independently, so both
real and constructed deliveries were processed. Everything below is read back out
of the live database.

### What the book did

Four entries, in two pairs:

```
seq   book       value_date   description
12323 financial  2026-09-11   Inbound ACH credit from GAUNTLET5 CO — trace 610029771703037
12324 memo       2026-09-11   Uncleared credit held to 2026-09-15 09:00:00 ET (ach/new, 2 banking days)
12344 financial  2026-09-11   Inbound ACH recalled (credit_entry_refused_by_receiver) — sandbox_inbound_ach_transfer_0t67lp0xhi46quk9zsxr
12345 memo       2026-09-11   Uncleared-credit hold released — the credit was recalled, so there is nothing left to withhold
```

The arrival: DR 1110 / CR the business's 2100 leaf, +412300. The recall: the same
two accounts the other way. The hold opened at 12324 and was closed at 12345 **in
the same transaction as the recall posting**.

### The corrected position

```
                       before recall     after recall
ledger_balance_cents     -85481845        -85894145     (−412300, the credit going back)
active_holds_cents          840600           428300     (−412300, the hold released)
uncleared_credit_cents      412300                0
available_cents          -86322445        -86322445     ← unchanged
```

**Available is identical before and after the recall, and identical to what it
was before the credit ever arrived.** That is the whole point of the scenario. If
the recall had debited the customer without releasing the hold, available would
have fallen by $4,123.00 a second time — the customer would have been charged
twice for money that never became theirs. It did not.

### It is a new event, not a rewrite

Both financial entries:

```
seq 12323  entry_type=original  reverses_entry_id=null  correction_group_id=eeccb6d3-... (itself)
seq 12344  entry_type=original  reverses_entry_id=null  correction_group_id=aa0a2a73-... (itself)
```

The recall is an **original entry in its own correction group**. It does not
reverse the arrival, does not share the arrival's correction group, and does not
touch the arrival's value date. The credit really did arrive on 2026-09-11 and the
arrival day's statement still says so; the recall is a second fact on the day it
happened. This is the structural form of "the corrected position appears on the
day it happened", and `rail_event_semantics` records the rule as data:

> `inbound_ach_transfer.updated/returned` → `semantics = new_event`,
> `value_date_source = payload.transfer_return.returned_at`

Note that source field. Migration `0039_inbound_recall.sql` documents that this
row originally read `payload.return.created_at`, copied by analogy from the
**outbound** `ach_transfer` object, which the inbound object does not carry — so
`valueDateFromSource()` found nothing, returned null, and the consumer parked. A
recall that could never be dated could never be acted on. The row was corrected
against a measured sandbox response. **That correction is why this test passed
today rather than parking.**

### Exactly one closure

```sql
select * from hold_closure where hold_id = '24662d6d-55df-4328-96fa-bf0dd443f28c';
```

One row. `PRIMARY KEY (hold_id)` guarantees there can never be a second,
regardless of how many of the five deliveries arrive or in what order.

### Invariants after the run

```
v_entry_unbalanced          = 0
v_book_not_zero             = 0
v_hold_drift                = 0
v_hold_release_drift        = 0
v_hold_closure_not_terminal = 0
v_balance_definition_drift  = 0
v_value_date_unexplained    = 0
```

### What this does NOT prove — stated plainly

Three honest limits, each with what would close it:

1. **No day gap on the book for the inbound recall.** Both entries carry value
   date 2026-09-11, because the Increase sandbox will not backdate:
   `effective_date` is rejected as an unexpected parameter on
   `POST /simulations/inbound_ach_transfers`, and `transfer_return` stamps
   `returned_at` at the wall clock. So the *structural* claim — new event, own
   correction group, own value-date source, arrival untouched — is proven on live
   data, but two different dates on two entries is not.

   It is proven **at unit level for the outbound return**, and with the right
   fixture: `src/lib/webhooks/consumers/increase-ach.test.ts:243` takes one
   transfer carrying `settlement.settled_at = 2026-09-11T14:00:05Z` and
   `return.created_at = 2026-09-14T09:30:00Z`, and asserts the resolver returns
   `2026-09-11` for the settlement source and `2026-09-14` for the return source.
   Settled Friday, returned Monday, two different days off one object. The
   resolver also refuses to guess: a source the object cannot answer returns null
   and the caller **parks** rather than falling back to the delivery's own
   timestamp — *"the whole reason the table names a field is that 'when we were
   told' and 'when it happened' are different days, and a fallback would quietly
   book the wrong one."* And if anyone flips a row to `correction`, three separate
   guards park rather than post at a date the consumer invented
   (`increase-ach.ts:509`, `952`, `1317`).

   **What would close it fully:** the repo has a time-travel facility
   (`src/lib/timetravel`, `docs/TIMETRAVEL.md`); driving the same two deliveries
   with the clock advanced between them would put the gap on the book. Not
   attempted in this window.

2. **The outbound ACH return is still unexercised end to end.**
   `ach_transfer.updated/returned` has a semantics row — the one the table itself
   calls *"THE row people get wrong"* — declaring `new_event` at
   `payload.return.created_at`, and the posting branch exists
   (`increase-ach.ts:635`, DR 1110 / CR 2100, idempotency key
   `ach:return:<transfer id>:<trace number>`, with trace in the key so a
   dishonoured return could be a second row). The unit coverage above is good.
   What does not exist is coverage of the **HTTP route → signature → inbox →
   drain → journal** chain for a return: no test POSTs to
   `/api/webhooks/increase` at all. The existing provider-driven test
   (`increase-ach.test.ts:570-636`, behind `RUN_INCREASE_ORIGINATE=1`) calls
   `simulateSubmit`/`simulateSettle`/`simulateReturn` and then asserts the
   **provider's** status is `returned` — it does not assert the ledger. The
   ledger half replays inbox rows in-process through `increaseAchConsumer.handle()`,
   bypassing the route.

   **What would close it:** the construction in this section, which is now known
   to work. The extra step versus the inbound case is that an outbound return
   parks unless a real approved-and-released `payment_instruction` exists whose
   `idempotency_key` matches the transfer's — `findOutboundLink` matches on that
   string, and without it the delivery parks on kind `payment_instruction`.

3. **Wire reversal is still unexercised.** Two semantics rows exist
   (`wire_transfer.updated/reversed` → `wire_return_of_funds` at
   `payload.reversal.created_at`, and `inbound_wire_transfer.updated/reversed` →
   `inbound_wire_returned`), both with measured provenance notes, and the posting
   branch is live in a separate consumer (`increase-wire.ts:836`).

   I initially read the wire rail's 112 dead-lettered `wire_transfer.updated`
   deliveries as ill health blocking this. **That reading was wrong, and the
   correction is worth recording.** Every one of them carries:

   > *"Increase wire `sandbox_wire_transfer_…` carries Idempotency-Key
   > `corgi-itest-1789100770329`, which names no payment_instruction on this book.
   > NOTHING WAS POSTED. Either the instruction has not been written yet, or this
   > wire was originated outside this system — and a wire with no approval behind
   > it is an incident for a person…"*

   These are integration-test wires originated **outside** this system. The
   consumer refused to post money against them, parked, re-checked twelve times,
   and dead-lettered with the exact unmatched string named. That is the refusal
   working exactly as designed — arguably the single best-behaved thing I saw
   today — not a broken rail. The wire consumer is registered and healthy
   (`src/lib/webhooks/drain.ts:99`).

   **What would close it:** originate a wire through this system for a fixture
   business so a `payment_instruction` exists, settle it, then
   `POST /wire_transfers/{id}/reverse` and deliver the event pointer.

### Verdict

**HOLDS for the inbound ACH recall** — driven end to end this session, against the
live provider and the deployed endpoint, correct on the first attempt: the recall
posted as a new event at its own value date, the arrival's day was left intact,
the uncleared-credit hold closed exactly once in the same transaction, and
available returned to precisely its pre-credit figure.

**The disclosure was accurate, not a cover.** The previous audit was right that the
scenario had never been run and right to be suspicious. But the machinery was
real: it booked correctly the first time it was asked to, with no code change, and
the one thing that would have made it fail silently — the mis-copied
`value_date_source` — had already been found and corrected by measurement in
migration 0039. That is the opposite of a gap wearing a disclosure.

**The outbound ACH return and the wire reversal remain PARTIAL** — code path and
semantics rows present, never driven. §5's construction is the recipe; it is
reproducible in minutes.

---

## Rows this audit committed

All against **fixture** businesses. No Ridgeline Robotics, Kettle & Crumb Bakery
or Silverline Freight row was written; those were read only.

Business: **Holds Integration Fixture Co.**, EIN `00-0000000`,
id `7e57b115-0000-5000-a000-000000000001`.

| Table | Rows | Detail |
|---|---|---|
| `webhook_inbox` | 2 | `9539bf26-251d-475f-94f9-1dffb04f4784` (`inbound_ach_transfer.created`), `95d1dea5-186b-43d8-8166-b046b27b10a9` (`inbound_ach_transfer.updated`). Both `done`. Constructed and re-signed by this audit. |
| `journal_entry` | 4 | booking_seq 12323, 12324, 12344, 12345 — see §5. Posted by the consumer, not by hand. |
| `journal_line` | 8 | two per entry |
| `hold` | 1 | `24662d6d-55df-4328-96fa-bf0dd443f28c`, kind `uncleared_credit`, $4,123.00 |
| `hold_closure` | 1 | for the above |

Increase sandbox objects created: `sandbox_inbound_ach_transfer_0t67lp0xhi46quk9zsxr`
(returned), and the three event deliveries Increase's own subscription generated
for it, which also landed in `webhook_inbox`.

Every posting above was made by the deployed consumer in response to a signed
webhook. Nothing was inserted directly. The ledger is append-only, so none of it
comes back — which is why it was aimed at a fixture.

## Findings

Ordered by how likely they are to mislead a reader, which is the axis this audit
was asked to judge on.

1. **`rail_event_semantics` and the card posting code disagree about how a
   clearing is dated** (§3). The table says local transaction date
   (`payload.created`); `lithic-events.ts:463` uses the clearing event's own date.
   The table is presented throughout as the authoritative, queryable statement of
   value-date policy, and on the card rail the column is never read. Pinned as
   `datedAsTableSays: false` and tabulated in `docs/RAIL-SEMANTICS.md`, so it is
   disclosed — but a reader who queries the table gets the wrong answer, and the
   system invites you to query the table.

2. **Half of `v_balance_definition_drift` cannot fire** (§1). The second disjunct
   is an algebraic identity over a single `ledger_availability()` row. It is the
   half that reads like "available is not a stored number" and it tests nothing.
   The same tautology is re-asserted in-process at `scripts/coreloop.mjs:1699`.

3. **The "no stored balance column" guard is a name pattern, and
   `standing_order_outcome` says in its own migration comment that it was named to
   avoid it** (§1). The columns are defensible on their merits; the guard is not
   what establishes that.

4. **`hold_closure.source` is NULL on the inbound-ACH recall path** (§2). Every
   other closure writer declares a source; recall closures land in
   `v_hold_closure_census`'s `(undeclared)` bucket with `in_guard: false`. No money
   effect (`defect_shape` is 0 for that bucket), not disclosed anywhere, one-line
   fix. Observed on the row this audit's own drive produced.

5. **No end-to-end HTTP coverage of any return** (§5). Nothing in the repo POSTs
   to `/api/webhooks/increase`. The return tests either assert the provider's
   status or replay inbox rows in-process through the consumer, so the
   route → signature → inbox → drain → journal chain for a return was untested
   until this session drove it by hand.

6. **`attack-04` skips rather than fails on most unhappy paths** (§4). A green run
   is not by itself evidence the attack ran; the evidence lines are.

7. **Outbound ACH return and wire reversal remain unexercised** (§5). Recipes for
   both are in §5 and the inbound construction is proven to work.

### Not findings, recorded because they look like ones

- **112 dead-lettered wire deliveries** are correct refusals of wires originated
  outside this system with no `payment_instruction` behind them, each naming the
  exact unmatched idempotency key. Working as designed. See §5, limit 3.
- **221 over-captured authorisations with no `hold_closure` row** withhold nothing
  (`memo_balance_cents = 0`) and are correctly non-terminal. See §2.
- **31 parked card deliveries** on "card is not registered to a customer" are the
  parking mechanism doing its job, bounded at 12 attempts. See §4.
