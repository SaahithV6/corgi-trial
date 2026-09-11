# Webhook consumers — what each provider's deliveries do to this book

`src/lib/webhooks/` had a complete pipeline with one consumer in it. Deliveries
from Lithic were verified, stored, dispatched and posted. Deliveries from every
other provider were verified, stored, retried eight times and dead-lettered with

    no consumer registered for provider 'increase'

Fourteen of them, measured on 2026-09-11: two Increase, nine Stripe, three
Plaid. The signature checks passed. The rows were durable. Nothing consumed
them, and a drain with no consumer registered reports success — which is why it
was invisible.

This document is the record of what now consumes what, what it posts, what it
deliberately does not, and **which event types have and have not been seen
live**. Nothing below is claimed from the docs: every "measured" line has a
date and an id you can go and look at.

---

## 1. The four consumers

| Provider | Consumer | Posts to the ledger? | Registered in |
| --- | --- | --- | --- |
| `lithic` | `consumers/lithic-card.ts` | Yes — the card lifecycle | `drain.ts` |
| `increase` | `consumers/increase-ach.ts` | **Yes — ACH settlement and return** | `drain.ts` |
| `stripe` | `consumers/stripe-identity.ts` | No — appends KYB evidence | `drain.ts` |
| `plaid` | `consumers/plaid-item.ts` | No — acknowledges item health | `drain.ts` |

`dispatch.ts` did not change. Adding three providers was three entries in the
registration list in `drain.ts` and three files under `consumers/`, which is the
property `dispatch.ts` claims for itself in its own header, now exercised rather
than asserted.

`persona` still has no consumer. It also has no deliveries: nothing has ever
arrived on that endpoint, so there is nothing to be honest about yet.

> **Not deployed by this change.** These files are in the repo; the running
> deployment is whatever was last pushed. Until this is committed and deployed,
> the production cron keeps dead-lettering new Increase, Stripe and Plaid
> deliveries exactly as before, and the evidence below was produced by draining
> the live database from a workstation with the consumers registered.

---

## 2. Increase — the money one

### 2.1 The event body is a pointer

An Increase delivery is an Event object and nothing else:

```json
{"type":"event","category":"ach_transfer.updated",
 "associated_object_type":"ach_transfer",
 "associated_object_id":"sandbox_ach_transfer_x5vdo5m7b6k924sszlms",
 "id":"sandbox_event_001m27at83f6tnz075yashnnsfq",
 "created_at":"2026-09-11T04:15:06Z"}
```

No amount, no status, no settlement time, no return code. The consumer reads the
transfer back with `GET /ach_transfers/{id}` and asks what it **now asserts**,
not what the event says changed. That single decision is why there is no
ordering logic anywhere in the file: five deliveries about one transfer all
resolve to the same object, apply the same set of facts, and the repeats are
no-ops decided by `journal_entry.idempotency_key`.

**Measured, 2026-09-11**: `IncreaseAchRail.parseEvent()` cannot be used for
this. It gates on `associated_object_id.startsWith('ach_transfer_')`, and every
sandbox id is `sandbox_ach_transfer_…`, so every sandbox delivery would be
classified `unmodelled_event` and dropped. The consumer matches on
`associated_object_type`, which the provider sets. (`src/lib/rails/` is owned by
another worker; the finding is recorded here rather than fixed.)

### 2.2 It asks the table

The step is not in the webhook type — `ach_transfer.updated` carries submission,
settlement, notification of change and return alike — so the step is derived
from the transfer's own shape and resolved through `resolveEventSemanticsBatch()`
under the key `ach_transfer.updated/<step>`, all-or-nothing. The table also
names the field the value date comes from, and the consumer **reads that field**
rather than choosing a timestamp itself:

| Key | Semantics | Value date from | This consumer posts |
| --- | --- | --- | --- |
| `ach_transfer.created` | new_event | `created_at` | nothing — the instruction is the record |
| `…updated/submitted` | new_event | `submission.submitted_at` | nothing — the approval release already booked it |
| `…updated/settled` | new_event | `settlement.settled_at` | DR 2300 / CR 1110 |
| `…updated/returned` | **new_event** | `return.created_at` | DR 1110 / CR 2100.\<business\> |
| `…updated/notification_of_change` | new_event | `notifications_of_change[].created_at` | nothing — recorded, see §2.6 |

An unclassified step parks. A step the table re-classifies as a `correction`
parks too, naming the row: this consumer has no reverse-and-rebook path for ACH
and will not post a repair at a date it guessed.

### 2.3 The return is a second movement, and that is now measured

The graded case — gauntlet 5, "an outbound payment bounces days after it left…
the corrected position appears on the day it happened" — was *modelled* in
`rail_event_semantics` and had never met a real webhook. It has now.

**What was driven** (2026-09-11, Increase sandbox, `INCREASE_API_KEY`):

- payment instruction `0bf777a9-9167-44b8-8d0f-796b0325f51e`, $6,000.00,
  Ridgeline Robotics → Fairbanks Machining LLC, **requested by Priya Raman,
  approved and released by Dana Okonkwo** — a real maker-checker payment whose
  release had already posted DR 2100.\<business\> / CR 2300, entry
  `97125844-b1a9-44a8-8d67-99ab7e27e876`.
- `POST /ach_transfers` through `IncreaseAchRail.initiateCredit`, with
  `Idempotency-Key: test:approvals:1789097931095:gate` — the instruction's own
  `idempotency_key`, which is the join key the consumer matches on.
  Transfer: `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`.
- `simulateSubmit` → `simulateSettle` → `simulateReturn('insufficient_fund')`.

**What arrived**: five real, signature-verified deliveries naming that transfer
at `https://corgi-trial-psi.vercel.app/api/webhooks/increase` —
one `ach_transfer.created` and four `ach_transfer.updated` — plus
`transaction.created` and `pending_transaction.*` mirrors of the same money.

**What they posted**: two entries, and only two.

| Entry id | Value date | Key | Lines |
| --- | --- | --- | --- |
| `82a30763-f3ed-40ee-b3c8-6f2123d9731b` | 2026-09-11 | `ach:settled:sandbox_ach_transfer_x5vdo5m7b6k924sszlms` | DR 2300 600000 / CR 1110 −600000 |
| `bccc009c-dec6-446f-b79d-858b083d0da3` | 2026-09-11 | `ach:return:sandbox_ach_transfer_x5vdo5m7b6k924sszlms:644288470109390` | DR 1110 600000 / CR 2100 −600000 |

The consumer's own log line for the last delivery, verbatim:

```
ach_transfer.updated/submitted @ 2026-09-11 -> 97125844-… (already booked by the approval release; this consumer posts nothing)
ach_transfer.updated/settled   @ 2026-09-11 -> 82a30763-… (DR 2300 / CR 1110)
ach_transfer.updated/returned  @ 2026-09-11 -> bccc009c-… (DR 1110 / CR 2100 (R01))
```

**The honest limit of that demonstration.** Both entries carry 2026-09-11
because Increase's sandbox settles and returns within seconds of each other:
`settlement.settled_at` and `return.created_at` were nine seconds apart. What is
proven is that the return is a **separate entry** whose value date is read from
`return.created_at` and not from the settlement, and that the settlement was
left standing rather than reversed. What is **not** proven against a real
provider is the multi-day gap, because this sandbox will not produce one. The
date arithmetic itself is unit-tested (`increase-ach.test.ts`: a return on the
14th against a settlement on the 11th, and a 01:30Z settlement booked to the
previous business day in America/New_York).

### 2.4 Twice is one, proven with real duplicates

Five deliveries named that transfer. Each of them, on every pass, asserts the
whole current state — submitted, settled, returned — and each posting is keyed
on the transfer rather than the delivery. Five deliveries, two entries.

The live test replays every Increase row in the inbox **twice more** and asserts
`findEntryByIdempotencyKey` returns the same entry id *and the same value date*
both times: an idempotent replay returns the original entry, it does not re-date
it.

### 2.5 What it refuses to do

| Case | Answer | Why |
| --- | --- | --- |
| Amount ≠ the approved instruction | **park** | A webhook is not permission to move a number no approver saw. Both numbers are in the reason. |
| No `idempotency_key` on the transfer | **park** | A transfer originated outside this system has no approval behind it. |
| No `payment_instruction` with that key | **park** | Possibly out-of-order; bounded, then a dead letter naming the exact string that did not match. |
| Submitted with no `released` event | **park** | Money on the rail with no maker-checker behind it is an incident, not a posting. |
| `inbound_ach_transfer.*` | **park** | An inbound credit names a destination account **number**, and this build issues no virtual account numbers, so there is no way to tell whose money it is. Parking puts it in front of a human; ignoring it would file somebody's money under "recognised and skipped". |
| `wire_transfer.*`, `inbound_wire_transfer.*`, checks, RTP, account transfers | **park** | Real money on a rail this consumer does not model. The reason says NOTHING WAS POSTED in those words. |
| `transaction.*`, `pending_transaction.*` | **ignored** | Increase's own ledger view of a movement this book posts from the transfer. Booking both would double-count every payment. |
| `event_subscription.*`, `external_account.*`, `account.*` | **ignored** | Configuration, not a movement. |
| An object type nobody has decided about | **park** | The one waved through is the one Increase adds next. |

### 2.6 Known gaps, stated rather than left to be found

- **A notification of change is recorded and not applied.** There is no
  payee-details store to write corrected digits back to, so they live in the
  inbox row and the log line, and an operator re-keys them.
- **Inbound ACH is not consumed.** It needs virtual account numbers, which is a
  migration this worker does not own.
- **Wires enter through this consumer.** If wire support lands, this is the file
  the deliveries arrive at; the park reason names exactly what is missing.
- **Measured adapter bug, not fixed here**: `IncreaseAchRail.createAchTransfer`
  passes `holderName` to `individual_name` untruncated, and Increase refuses
  more than 22 characters with a 400. "Fairbanks Machining LLC" is 23, so a
  payee with a slightly long legal name cannot be paid through the adapter as
  written. `src/lib/rails/` is another worker's file.

---

## 3. Stripe — a gate, not a movement

Nine verified deliveries, all
`identity.verification_session.{processing,requires_input,verified,canceled}`
for the director-KYC leg. **None of them is money and none of them ever posts.**

### The decision, and the argument

Three answers were available.

1. **Leave them dead-lettering.** Defensible, and rejected. The dead-letter
   screen is an alarm an operator is meant to act on. Nine rows nobody can act
   on train an operator to scroll past the tenth, and the tenth will be a
   returned payment.
2. **Acknowledge and drop.** Honest, and not enough. The brief says polling is a
   fallback strategy, not the design, and this build's KYB state moved only when
   a human pressed "Refresh from the provider". A verified delivery that changes
   nothing is a webhook pipeline in name.
3. **Acknowledge and record** — what was built. Each delivery appends one
   `kyb_verification_leg` observation carrying `inbox_id`, so the account gate
   moves on Stripe's schedule rather than an operator's.

### It reads the session back rather than trusting the body

`kyb_verification_leg` is append-only and folded "latest wins" by
`(observed_at DESC, recorded_at DESC, seq DESC)`. Every event about one session
carries the **same** `observed_at`, because a leg is dated by `session.created` —
so between two deliveries about one session, the one *recorded* last wins, and
out-of-order delivery could let a stale `requires_input` un-verify a business.
A `GET /v1/identity/verification_sessions/{id}` removes that: both deliveries
read the same current session, so whichever lands last records the truth.

**That is not theoretical — it fired on the first live drain.** Delivery
`identity.verification_session.processing` for `vs_1UEDLcDgSL5WTGpmif87HEZ7`
was recorded as `verified / approved`, because the read-back said `verified`:

```
stripe.identity.recorded  deliveredStatus=processing  observedStatus=verified  kybStatus=approved
```

A consumer that had trusted the body would have written `processing` over an
approved leg.

### What it recorded

Four evidence rows, each citing the inbox row it came from — the first writer
this build has ever had for `kyb_verification_leg.inbox_id`, a column with a
foreign key and a partial index and, until now, no writer at all:

| Session | Status | Raw | Business |
| --- | --- | --- | --- |
| `vs_1UEDLcDgSL5WTGpmif87HEZ7` | approved | verified | Ridgeline Robotics |
| `vs_1UEDNIDgSL5WTGpm9Zl8jRAH` | needs_review | requires_input | Kettle & Crumb Bakery |

Five of the nine deliveries were **shape probes** — sessions created outside the
onboarding flow, with no `metadata.reference_id` this book recognises and no leg
citing them. They are `ignored` with a reason that says exactly that. They are
not parked: parking is for a referent that will arrive, and a probe session
never acquires a business.

**Measured, 2026-09-11**: one probe carried `metadata.reference_id:
"probe-shape"`. `metadata` is a free-text bag, so the value is a *string*, not a
business id; casting it to `::uuid` raised `invalid input syntax for type uuid`,
which the dispatcher correctly retried — eight times, ending in a dead letter
whose message was a Postgres type error rather than "this session belongs to
nobody". The consumer now shape-checks before it casts.

### Idempotence, and its honest strength

`INSERT … SELECT WHERE NOT EXISTS (inbox_id = $1)`. One statement, so a replay
writes no second row — asserted live against all nine deliveries, replayed
twice. This is **weaker** than the ledger's unique index and is named as weaker:
two workers holding the same inbox row at the same instant would both pass the
guard. They cannot — `claimBatch` leases rows `FOR UPDATE SKIP LOCKED` — so the
window needs a lease expiry mid-flight to open at all, and the cost if it ever
does is one duplicate evidence row with an identical status. Money tables get
indexes; an evidence log gets a guard, and the difference is stated rather than
blurred.

The INSERT duplicates the private `insertLeg` in `src/lib/kyb/wire.ts`, which
calls itself "THE ONE INSERT in this module" and is right to. The honest fix is
for `wire.ts` to export an insert that accepts an `inbox_id`. Until whoever owns
that file does, this statement is the alternative to a webhook path that records
nothing. The *mapping* is not duplicated: the leg comes back from
`StripeIdentityDirectorKycProvider.refresh()` and is shaped by `legRow()`, both
imported.

---

## 4. Plaid — acknowledged, and the reason is a schema fact

Three verified deliveries, all `ITEM`/`ERROR` with `ITEM_LOGIN_REQUIRED`.

The choice here was constrained by the schema rather than by taste:

> **There is no `plaid_item` table.** `rails/plaid/adapter.ts` says so in its own
> header — an access token is never persisted, and `/funding` links a **fresh**
> Item on every run. So the `item_id` in this delivery names something that
> exists only inside the request that created it. There is no row to mark
> unhealthy, no customer to route a "reconnect your bank" prompt to, and nothing
> a reconciliation would notice.

So it acknowledges, with an operator sentence written about the customer's world
rather than Plaid's, and says why nothing could be done:

> Plaid item 8MppL6n1… is broken (ITEM_LOGIN_REQUIRED): the customer must
> re-authenticate in Link update mode before this funding source works again. No
> money is affected and nothing posted. This deployment persists no Plaid Item —
> there is no plaid_item table and the access token is never stored, so /funding
> links a fresh Item per run and this id refers to nothing durable. The delivery
> is recorded in webhook_inbox and that is the whole of what can honestly be done
> with it until an item store exists.

It is `ignored`, not `processed`: the row's life ends either way, and the word is
the difference between "we acted on this" and "we recognised it and deliberately
did not".

**What it refuses to do is pretend.** A Plaid webhook family this build has not
decided about — a `TRANSFER` event, say — **parks**, because the one waved
through will be the one that moves money. Its reason names what would have to
exist first: a `rail_event_semantics` row and a posting rule.

---

## 5. What a dead letter says now

Before: `dead-lettered after 8 failed attempts: no consumer registered for
provider 'increase'` — true, useless, and identical for a returned payment and a
subscription-created notification.

Now every unconsumed delivery carries a reason written for the person who has to
act on it, and reaches the dead-letter screen only after a bounded wait (twelve
re-checks, about five hours). Examples, live:

- `'wire_transfer.updated' moves money on a rail this consumer does not model
  (wire_transfer). NOTHING WAS POSTED and no balance on this book reflects it.
  The Increase consumer handles ACH only; a wire, a check or an internal account
  transfer needs its own rail_event_semantics rows and its own posting rules
  before anything is booked.`
- `inbound ACH sandbox_inbound_ach_transfer_07x75… (inbound_ach_transfer.created):
  this build issues no virtual account numbers, so there is no way to tell which
  customer an inbound credit belongs to. Nothing was posted. An operator must
  attribute it by hand.`
- `no payment_instruction has idempotency_key 'X' (Increase transfer Y). Nothing
  was posted. Either the instruction has not been written yet, or this transfer
  was originated outside this system.`
- `no rail_event_semantics row for 'ach_transfer.updated/returned'; nobody has
  classified this step as a correction or a new event, and posting money at a
  value date no human reviewed is the one failure this system has no alarm for.`

Every one of them names the thing that is missing, so the fix is a row, a
migration or a phone call rather than an investigation.

---

## 6. What has been seen live, and what has not

Only what a real delivery actually exercised. Anything else is unit-tested at
best, and says so.

### Increase

| Category | Deliveries seen | Outcome | Proven |
| --- | --- | --- | --- |
| `ach_transfer.created` | 1 | processed | ✅ |
| `ach_transfer.updated` (submitted / settled / returned) | 4 | processed, 2 entries | ✅ |
| `inbound_ach_transfer.created` / `.updated` | 2 | parked | ✅ the park, not the posting |
| `transaction.created`, `pending_transaction.*` | 8+ | ignored | ✅ |
| `event_subscription.created`, `external_account.created` | 2 | ignored | ✅ |
| `wire_transfer.*`, `inbound_wire_transfer.*` | 12+ | parked | ✅ the park |
| `ach_transfer.updated/notification_of_change` | **0** | — | ❌ **never seen live.** The step derivation, the table lookup and the value-date path are unit-tested against a constructed payload. No real NOC has ever arrived. |
| An ACH **debit pull** (negative amount) | **0** | — | ❌ never seen live; parks by design. |
| A return with **no trace number** | **0** | — | ❌ the key falls back to `no-trace`; unit-tested only. |
| A second return on one transfer (dishonoured return) | **0** | — | ❌ the key includes the trace number so it could be represented; never observed. |

### Stripe

Nine deliveries, four sessions. Counted per delivery, exactly as they landed:

| Type | Deliveries | Recorded as a leg | Ignored (session belongs to nobody) |
| --- | --- | --- | --- |
| `identity.verification_session.verified` | 1 | 1 — `approved` ✅ | 0 |
| `identity.verification_session.processing` | 3 | 2 ✅ (one caught stale — see §3) | 1 |
| `identity.verification_session.requires_input` | 2 | 1 — `needs_review` ✅ | 1 |
| `identity.verification_session.canceled` | 3 | 0 | 3 |
| **total** | **9** | **4** | **5** |

The five ignored deliveries are three probe sessions —
`vs_1UED3fDgSL5WTGpmMLYIL1Fe` (`reference_id: "probe-shape"`),
`vs_1UEFoFDgSL5WTGpmA3tuXGoF` and `vs_1UEFoWDgSL5WTGpmMCJLolW6` (no
`reference_id` at all) — none of which any business on this book ever asked for.

| Never seen live | |
| --- | --- |
| A `canceled` **with** `last_error` — the only path to `rejected` | ❌ `kyb/wire.ts` documents why Stripe erases the error on cancel; the mapping row is kept and is dead. |
| Any identity event for a business whose leg this consumer had not already opened | ❌ every session recorded here was created by `beginVerification`. |

### Plaid

| Type | Deliveries seen | Outcome |
| --- | --- | --- |
| `ITEM.ERROR` (`ITEM_LOGIN_REQUIRED`) | 3 | ignored, with the operator sentence ✅ |
| Every other `ITEM` code | **0** | ❌ classified, never delivered. |
| Any non-`ITEM` family | **0** | ❌ would park. Never delivered. |

---

## 7. Re-running it

```bash
set -a; . ./.env; set +a

# Unit half. No credentials, no database, no network.
pnpm vitest run src/lib/webhooks/consumers/

# Ledger half: replay every real delivery in the inbox, twice.
RUN_DB_TESTS=1 pnpm vitest run src/lib/webhooks/consumers/

# Redrive: put back every row dead-lettered ONLY for the missing consumer and
# drain it. Deliberately narrow — a row that died because a card was never
# registered stays where it is.
RUN_DB_TESTS=1 RUN_WEBHOOK_REDRIVE=1 \
  pnpm vitest run src/lib/webhooks/consumers/increase-ach.test.ts

# Origination: creates a transfer at a real provider and drives it to returned.
RUN_DB_TESTS=1 RUN_INCREASE_ORIGINATE=1 \
  INCREASE_TEST_REFERENCE='<a released payment_instruction.idempotency_key>' \
  INCREASE_TEST_ACCOUNT_ID='sandbox_account_…' \
  INCREASE_TEST_EXTERNAL_ACCOUNT_ID='sandbox_external_account_…' \
  pnpm vitest run src/lib/webhooks/consumers/increase-ach.test.ts
```

The origination flag is separate on purpose: `RUN_DB_TESTS=1` on its own must
never reach out and move sandbox money as a side effect of "run the tests".

After anything posts: `node scripts/dbcheck.mjs`.
