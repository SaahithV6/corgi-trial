# Wires — the rail that cannot be taken back

`src/lib/rails/wire/` is a second Increase rail behind `src/lib/rails/contract.ts`.
It is **LIVE**: a real wire went out on Increase's sandbox Fedwire, settled the
same day with an IMAD, and a real inbound wire was credited to a customer with
immediate availability. Every id in this document is a sandbox object anyone
holding the credential can `GET`.

The brief calls wires *"if you are ambitious"* and `docs/CUT-LIST.md` had them
cut. They are here because the interesting part is not that a wire is another
way to move money — it is that **a wire is final**, and finality is the one
premise the ACH design in this repo is built on the negation of. Everything
below is a consequence of that single difference.

**Read §4 first if you only read one section.** It is the answer to whether
immediate availability fell out of the model, and the answer is *mostly, and
the place it did not is the more interesting half*.

---

## 1. What Increase's sandbox actually offers for wires

Measured 2026-09-11 against `https://sandbox.increase.com` with this trial's
key. Status codes are what came back, not what the docs promise.

| Call | Status | What it proves |
| --- | --- | --- |
| `GET /wire_transfers?limit=1` | **200** | the wire capability is entitled on this key — this is the rail's `probe` |
| `POST /wire_transfers` | **200** | a wire can be originated |
| `GET /wire_transfers/{id}` | **200** | the authoritative read-back |
| `POST /simulations/wire_transfers/{id}/submit` | **200** | a wire can be driven to settlement |
| `POST /simulations/wire_transfers/{id}/reverse` | **200** | money can come back — see §3 for what that actually is |
| `GET /inbound_wire_transfers?limit=1` | **200** | — |
| `POST /simulations/inbound_wire_transfers` | **200** | an inbound wire can be received |
| `GET /inbound_wire_transfers/{id}` | **200** | — |
| `POST /inbound_wire_transfers/{id}/reverse` | **200** | we can send a received wire back out. **Not a simulation** — a production method |
| `GET /inbound_wire_drawdown_requests?limit=1` | **200** | — |
| `GET /wire_drawdown_requests?limit=1` | **403** `private_feature_error` | **not available.** "This API method is in private beta." |
| `GET /simulations` | 404 | there is no index; the simulation endpoints are per-resource |

**So: a wire can be driven end to end to settlement, and back.** One capability
is closed to us and is named precisely rather than worked around: **wire
drawdown requests are 403 on this key**, so this rail does not pull money by
wire and does not pretend to.

### The five things the sandbox taught that the docs did not

**1. The wire endpoint has moved to ISO 20022 and the ACH endpoint has not.**
The first `POST /wire_transfers` sent the fields every published example uses
and got a 400 naming four of them at once:

```
message_to_recipient: Unexpected parameter.
remittance:           Required parameter.
beneficiary_name:     Unexpected parameter.
creditor:             Required parameter.
```

`beneficiary_name` and `message_to_recipient` still come **back** on the
response as compatibility aliases and are refused on the way **in**. The
working body is `creditor: { name }` plus
`remittance: { category: 'unstructured', unstructured: { message } }`. An
adapter that assumed one provider means one request shape would have shipped a
rail that 400s on every call, and there is no way to learn that except by
making the call.

**2. There is no settlement object. Submission *is* settlement.**
`src/lib/rails/types.ts` documents *THE INCREASE TRAP* for ACH: a settled ACH
transfer keeps `status: "submitted"` and grows a `settlement.settled_at`, so
every ACH adapter must **promote**. The wire endpoint has the mirror-image
trap:

```
status:      pending_creating  ->  complete      (one simulated submit)
submission:  null              ->  { input_message_accountability_data,
                                     submitted_at }
settlement:  no such field, at any point
```

Fedwire is real-time gross settlement: the Fed accepting the message **is** the
transfer of funds. An adapter that waited for `settlement.settled_at` here
because "that is how Increase does it" would wait for ever and never release a
thing. `outboundWireEvent()` reads `submission.submitted_at` as `settledAt`,
and `semantics.test.ts` asserts the field's **absence** from the measured
payload so that a future refactor cannot quietly reintroduce the assumption.

**3. The sandbox advances wires on its own after about five seconds.**
The $42.00 wire raised through `requestPayment()` was never given a
`simulateSubmit` and went `complete` anyway — created `04:31:57Z`, submitted
`04:32:02Z`. `simulateSubmit` makes it immediate rather than making it happen.
Worth knowing before writing a test that asserts `pending_creating`.

**4. `creditor.name` maxes at 140 characters — not 22.**
Measured by binary search: 140 is a 200, 141 is a 400 reading
`creditor.name: Maximum length is 140. Your data is 141 characters long.`
22 is ACH's `individual_name`, a Nacha field, and assuming one provider means
one field length is the same mistake as assuming one provider means one request
shape. `payeeCandidateSchema` allows a `holderName` of 200, so the gap is
reachable. `client.ts` **refuses** above 140 rather than truncating, and that
differs from the ACH adapter on purpose: 22 characters fits almost no legal
name, so truncation there is the only workable answer, whereas 140 is generous
and a name that does not fit is a data problem. Silently shortening a
beneficiary on an **irrevocable** payment would change who the message is
addressed to, after two humans approved the instruction that named them.

**5. A simulated inbound wire accepts only two fields.**
`POST /simulations/inbound_wire_transfers` takes `account_number_id` and
`amount`. `debtor`, `remittance`, `originator_name` and
`originator_routing_number` were each rejected by name with *"Unexpected
parameter."* So the sender on a simulated arrival is Increase's own fixture
(`debtor_routing_number: 101050001`) and cannot be chosen. That limit is stated
in `client.ts` rather than worked around, because a caller who believed it
could set the sender would be building payee matching on a value it does not
control.

### Webhooks: live, verified, and with nowhere to go

The deployed endpoint's Increase subscription is `selected_event_categories:
null` — everything — so wire events already arrive there. On 2026-09-11 it
received and signature-verified:

| category | count |
| --- | --- |
| `wire_transfer.created` | 1 |
| `wire_transfer.updated` | 4 (one per status step) |
| `inbound_wire_transfer.created` | 1 |
| `inbound_wire_transfer.updated` | 1 |
| `transaction.created` / `pending_transaction.*` | 6 |

All thirteen sit in `webhook_inbox` with `signature_verified_at` set, `state =
'pending'`, and `processing_error = "no consumer registered for provider
'increase'"`. **Registering that consumer is `src/lib/webhooks/**`, which is
outside this scope** — see §7.

The body is a **pointer**, exactly like ACH's:

```json
{"type":"event","associated_object_id":"sandbox_inbound_wire_transfer_00lkxr57i04x31blx06x",
 "associated_object_type":"inbound_wire_transfer","category":"inbound_wire_transfer.created",
 "created_at":"2026-09-11T03:59:30Z","id":"sandbox_event_001m279xnvhmtzj5x07tbpmys5y"}
```

Nothing about the money is in it, so `observe()` reads the object back — which
is also what makes out-of-order delivery harmless here. `observe` is marked
`measured` on a stricter basis than the other cells: not that a delivery
arrived, but that the function was run against the **exact verified bytes** of
one, read out of `webhook_inbox`, in `wire.integration.test.ts`.

---

## 2. The capability matrix

`+` supported and exercised · `-` not supported, with a reason in the code

| Rail | Provider | Evidence | originate | observe | settle | reverse | probe |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Increase wire (Fedwire) | `increase.wire` | live | + | + | + | **-** | + |

Four `measured` cells is unusual in this repo, and it is not a relaxed
standard. `docs/RAILS.md` holds the Increase **ACH** row at `~` for four
operations on the explicit grounds that `GET /accounts` returning 200 proves a
credential and nothing else. The same standard applied here gives the opposite
answer for a boring reason: **the calls were made**, and every cell's
`evidence` string names the call and the object it produced, so any of them can
be re-earned in seconds:

```
set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \
  src/lib/rails/wire/wire.integration.test.ts \
  src/lib/rails/wire/outbound.integration.test.ts
```

### The probe asks `/wire_transfers`, not `/accounts`

Increase gates features **per key**: the same credential that answers 200 on
`GET /wire_transfers` answers **403 `private_feature_error`** on
`/wire_drawdown_requests`. A probe that read `/accounts` would report LIVE for
a key with no wire entitlement at all — a real round trip proving the wrong
proposition, which is liveness-by-presence one indirection removed. The
integration test asserts **both** status codes side by side so the distinction
is exercised and not merely argued.

---

## 3. `reverse` is false, and why that is not a cop-out

**A wire genuinely cannot `reverse`, and the type says so rather than throwing
at runtime.** `supports.reverse.supported === false`, there is no `reverse`
method on the adapter, `canObserve()` still narrows, and nothing in
`semantics.ts` constructs a `RailEvent` of type `returned` — `adapter.test.ts`
iterates every wire status and asserts it.

The interesting part is that **money did come back**, measured, and the rail
still refuses the capability. `POST /simulations/wire_transfers/{id}/reverse`
returned 200 and produced:

```
class_name:                            "inbound_wire_reversal"
input_message_accountability_data:     "20260911apvdjfqt599399"   <- the reversal's
                                       "20260911sgzamiaa787670"   <- the original's
transaction_id:                        a DIFFERENT transaction
return_reason_code:                    null
```

Read those four lines together and they are the whole argument:

- **A different IMAD means the network saw a different message.** The IMAD is
  Fedwire's own identifier for a payment. Two messages, two payments.
- **`inbound`** — it came the other way.
- **`return_reason_code` is `null`.** Increase has the field; the network did
  not fill it, because unlike ACH there is no wire return-code table to fill it
  *from*. ACH has R01–R85 and a whole `ReturnCategory` union built on them.
  Fedwire has nothing of the kind, and the null is the evidence.

So what came back is a **second payment the beneficiary's bank chose to send**,
referencing the first. We cannot cause it, are not owed it, and have no code to
classify it by. `reverse` is a capability of the rail; this is a thing that
sometimes happens near it.

This is a *different* refusal from USDC's, and the difference is worth keeping.
USDC's is physics: a confirmed chain transfer cannot be unmade. A wire's is law
and network design: the money **can** come back, and we have watched it — what
we cannot do is compel it.

### Where it goes instead

`adapter.wireReturnOfFunds(transferId)` — on the concrete adapter's surface,
never on the contract — turns the provider's `reversal` field into an
`InboundWireCredit`, the *same type* an ordinary arrival produces, booked by the
*same function* with the *same posting, hold, policy and availability*. Because
it is the same event: a wire arrived.

- The **original stays settled**, at its original amount and time, after the
  reversal. `readOrigination()` asserts it.
- The money coming back takes **its own value date**, from its own timestamp —
  `rail_event_semantics` row `wire_transfer.updated/reversed`, `new_event`,
  `payload.reversal.created_at`. Taking the original's value date would make
  the ledger claim the payment never happened on the day it provably did.
- Its **settlement identity is the reversal's IMAD**, not the original's.
  Keying it on the original would make a settle-then-return pair look like one
  event seen twice, which is exactly what `reportSettlements` dedupes on.

The mirror case is symmetrical: `POST /inbound_wire_transfers/{id}/reverse` is
a **production** method taking `reason: "creditor_request"` — the creditor
being us. That is this bank **originating** a wire in the other direction, so
`debitReturnedInboundWire()` books it on the day we sent it and leaves the
arrival day untouched.

### The eight semantics rows

All eight are `new_event`, and that is a finding rather than a default.
`correction` means *the original posting was a false statement about its own
value date*. Nothing a wire does is ever that: it settles once, for the
instructed amount, on the day the Fed accepted the message, and no later fact
can make that day untrue.

| `provider_event_type` | canonical | value date from |
| --- | --- | --- |
| `wire_transfer.created` | `wire_originated` | `payload.created_at` |
| `wire_transfer.updated/submitted` | `wire_submitted` | `payload.submission.submitted_at` |
| `wire_transfer.updated/complete` | `wire_settled` | `payload.submission.submitted_at` |
| `wire_transfer.updated/reversed` | `wire_return_of_funds` | `payload.reversal.created_at` |
| `wire_transfer.updated/canceled` | `wire_canceled` | `payload.cancellation.canceled_at` |
| `wire_transfer.updated/rejected` | `wire_rejected` | `payload.created_at` |
| `inbound_wire_transfer.created` | `inbound_wire_credit` | `payload.acceptance.accepted_at` |
| `inbound_wire_transfer.updated/reversed` | `inbound_wire_returned` | `payload.reversal.reversed_at` |

Note the row that is **not** there: there is no `value_date_source` anywhere in
this table reading `settlement.settled_at`, because on this rail there is no
such field.

---

## 4. Did immediate availability fall out of the model?

**The arithmetic did. The hold model's second invariant did not, and finding
that out is the most useful thing this rail did.**

### What fell out, with no code change at all

`funds_availability_policy` is effective-dated data keyed `(rail,
counterparty_class, effective_from)`. `src/lib/rails/plaid/availability.ts`
already documented the zero case *and already named wire as the reason*:

> `count === 0` returns `date` UNCHANGED … a zero-day policy (wire, internal,
> card refund) means "available immediately".

`ledger_availability()` (migration 0022) releases an uncleared-credit hold on
`p_as_of >= held.available_at` and nothing else. So with the right policy row,
a wire hold is released the instant it is created, by the balance function, with
no branch anywhere. `creditInboundWire()` **imports** `scheduleAvailability`
from the ACH funding path rather than copying it, precisely so "the arithmetic
is the same" is checkable rather than assertable.

**The hold is still written, deliberately.** Skipping it when the policy says
zero days is the obvious shortcut and it was rejected: "available moved" would
then be true because this code *chose* not to withhold anything — a special
case with better manners. Writing the hold and watching the balance function
release it means the **model** released it. `v_wire_availability_drift`
(migration 0025 §4) is that claim as a query: one row per wire hold that
actually bound. It must be empty. It is.

### The one row of data that made it exact

The seeded wire policy already said `banking_days_hold = 0`. It also carried
`release_local_time = '09:00'`, which is the column's ACH-shaped default:

```
scheduleAvailability({bankingDaysHold: 0, releaseLocalTime: '09:00'}, '2026-09-11')
   -> available_at = 2026-09-11 09:00 America/New_York
```

Fedwire's operating day opens at **21:00 ET the previous calendar day** and
closes at 18:00 ET. A wire received at 08:00 ET is an ordinary wire, and under
that row it would be withheld for an hour — from a customer, on a rail that
cannot be reversed, for no risk that exists. Whether the hold binds would depend
on what time of day the money arrived, which is the definition of an accident.

Migration 0025 supersedes it — effective-dated append, never an edit, which is
what the table was built for:

```
rail='wire' counterparty_class='n/a' effective_from=2026-09-11
banking_days_hold=0  release_local_time='00:00:00'
```

Midnight ET on the value date is the only release time under which "0 banking
days" means what it says. `counterparty_class` stays `'n/a'`: the ACH classes
(`self` / `known` / `new`) exist to price **return risk**, and they can only
price it because a return is possible. Grading wire senders into risk bands
would imply the bands buy something.

### And the part that did NOT fall out

The first version booked a wire, ledger and available moved together on the
first run — and then `node scripts/dbcheck.mjs` went to **21/22**:

```
FAIL  v_hold_release_drift is empty — 1 row(s) — a released hold withholds nothing
```

`v_hold_release_drift` (migration 0011 §3) is the **other half** of the hold
invariant, and a different claim from the balance one:

> A released hold must be FLAT: whatever it was withholding has been given back
> in the memo book. Anything else means availability and the memo book disagree
> about the same hold, which is the shape of every over-release bug there is.

**Two definitions of "released", both correct:**

| | released means |
| --- | --- |
| `ledger_availability()` | the **clock** has passed `available_at`. Nothing needs to have been written. |
| `v_hold_release_drift` | the memo book has been **squared**, which happens only when somebody posts the reversing entry. |

On ACH nobody notices the gap, because the availability sweeper closes the hold
and posts the reversing memo entry a day or two later, and the window between
"the clock passed" and "the sweep ran" is minutes. **A zero-day policy makes
that window the whole life of the hold.** A wire hold is released the instant it
is created, so there is no "later" for a sweeper to be in. Left alone, every
wire credit would sit in `v_hold_release_drift` permanently, and the invariant
that catches over-release bugs would be non-empty on a rail that has none.

So `creditInboundWire()` does what the sweeper does, in the same transaction:
`closeHold()` then the reversing memo entry. **That is the special case, and it
is worth being precise about what kind it is** — not a rail branch and not a
second availability rule. The predicate is `schedule.availableAt <= arrival`,
which names no rail and would fire for a zero-day policy on any of them. It is
this path taking responsibility for a release that has no later.

The result is the ACH shape with the days taken out. An ACH credit produces
three entries — financial, memo hold, memo release — spread over one to two
banking days. A wire produces the same three, in one transaction.

**The finding, stated as a recommendation:** the availability sweeper's
contract should be *"a hold whose release has passed is closed and squared"*,
and the writer of a hold should be responsible for it when the release has
already passed at write time. Today that responsibility is implicit and lives
only in the sweeper, which is fine while every policy is ≥ 1 day and stops
being fine the moment one is not.

### The asymmetry, and where it actually landed

```
ACH inbound    DR 1130  ACH receivable — inbound in transit
WIRE inbound   DR 1110  Cash — FBO settlement account at sponsor bank
```

1130 exists because an inbound ACH credit is a promise about a future
settlement day. A wire has no such gap — `acceptance.accepted_at` **equals**
`created_at`, measured, there is no pending stage at all — so the money is in
the FBO account at the moment we hear about it, and 1110's own chart note says
it is *"debited when funds actually land there … never when a provider merely
promises them"*. (1130 also carries `railControl: 'ach'`, so posting a wire to
it would contradict the chart's own metadata.)

Notice where that asymmetry landed: **in the choice of an account** — a fact
about where the money is — and not in the hold model, the availability
arithmetic, or the balance definition. None of those three learned that wires
exist.

### Proven, not asserted

`wire.integration.test.ts`, as deltas around one real inbound wire:

```
after.ledgerCents    - before.ledgerCents    === +75000n
after.availableCents - before.availableCents === +75000n     <- ACH moves only the first
after.unclearedCents - before.unclearedCents === 0n
```

plus: the hold row exists and cites a `policy_id`; its `available_at` is
already in the past at the instant it was written; `hold_closure` names the
zero-day reason; `v_hold_release_drift` for that hold is empty; and a replay
books nothing twice (`hold_ref UNIQUE (kind, external_ref)` and the entry
idempotency key decide, not an `if`).

---

## 5. The approval threshold: $0, two approvers

Migration 0025 §2 supersedes the wire policy with the same numbers and the
argument attached, because `note` is where an approver meets the reasoning.

### Why $0, when ACH is $2,500

**ACH's threshold is not a statement about size.** Its own note says so: *"an
ACH entry is recallable for two banking days, which bounds the damage."*
$2,500 is the price of the band **below** which an unattended agent may act,
and that band exists only because a mistake inside it is recoverable by a
mechanism that exists. A wire has no such mechanism at any amount, so **there
is no amount at which the band can be drawn**. The threshold is $0 because the
recoverability it would be measuring is $0.

The disputes rail reached the same conclusion from the same premise and landed
on **$50**, not $0, and that difference is the load-bearing half. When
recoverability is zero the threshold stops pricing **loss** and starts pricing
**review**: what does a second human cost, and how often is the bill paid.
Provisional credits are frequent, small and mechanical, so the review has to be
cheap enough to be worth having — $50 is where it becomes so. Wires are the
opposite on all three counts. A business current account originates a handful a
month, each already carrying a $25–$35 network fee that has priced micro-wires
out of existence. The review is paid for a handful of times a month and buys
the only control this rail has. Break-even sits below the smallest wire anybody
sends, so the floor is the honest answer.

### Why two approvers, when USDC — also irreversible — takes one

Not "more money, more caution". **The two rails fail differently.**

| | the failure mode | what catches it |
| --- | --- | --- |
| USDC | a **malformed** destination — mistyped or swapped address | arithmetic (EIP-55). A second human adds little to a checksum. |
| Wire | a **well-formed** instruction — real beneficiary, real bank, valid ABA, sent from a real employee's real mailbox | nothing but a second person who was not in the email thread |

Business email compromise is the attack this rail carries, and nothing about a
BEC instruction is wrong on its face. The only control that has ever worked
against it is out-of-band confirmation by a second human. `required_approvals =
2` is that control, enforced where the database can see it —
`assert_maker_checker()` already refuses a second decision by the same actor
and refuses any agent at all.

### What the table cannot say

One `(threshold_cents, required_approvals)` pair is **one band**. ACH gets two
out of it because its threshold does the splitting: below $2,500, zero
approvers. Wire, with the threshold at the floor, has one band and no way to
express *"two approvers above $250,000, one below"*. A ladder needs a second
column or a row per band, which is a schema change 0025 deliberately does not
make. **It is the week-two item.**

Proven in `outbound.integration.test.ts` against a **$42.00** wire — far below
ACH's $2,500 — which still required two distinct humans:

```
requested  Priya Raman      (can_approve = false)
approved   Dana Okonkwo
approved   Miles Ferrara
released   Miles Ferrara    entry a54424b2-deda-42b9-a140-de9b77041b6d
```

Priya approving her own payment is refused **by the database**. One approval
leaves the instruction in state `approved` with `approvalsHeld = 1` against
`approvalsRequired = 2`, and `releasePayment()` refuses — a distinction worth
naming, because a screen that gated on the *status* rather than the *count*
would release a two-approver wire on one signature.

---

## 6. Findings for the owners of code this rail could not touch

### a. Where the wire ABA comes from — RESOLVED 2026-09-11

*This section reported a finding. It was acted on, then the fix and this rail
disagreed, and the disagreement is now decided. Kept in full because the shape
is more useful than the answer.*

**The finding, as reported.** `destinationSchema`'s wire variant was
`{ type: 'wire', holderName, bic, accountNumberLast4 }`. A BIC is a SWIFT
identifier used on cross-border payments; **a domestic Fedwire beneficiary is
addressed by a 9-digit ABA — specifically the WIRE variant**, a different
number from the same bank's ACH variant. `gatePaymentOnPayee()` opened with
`destination.type === "ach" ? destination.routingNumber : null` and returned
early on null, so **a wire received neither the check-digit arithmetic nor the
standing-warning check** — on the one rail where money cannot be recovered.

**What happened next.** `wireRoutingNumber` was added to the wire variant and
the gate began refusing a wire without one
(`PAYEE_WIRE_ROUTING_NUMBER_MISSING`). That closed the hole and opened a
conflict: this rail resolved the ABA **from the confirmed payee book** at send
time, and `outbound.integration.test.ts` deliberately raised a BIC-only wire to
say so. Four of its six tests went red on a real design disagreement, not on a
bug.

**The decision: the payee book is authoritative, and the instruction carries a
copy of the book's number.** Argued in full in the header of
`src/lib/payees/gate.ts` and in docs/PAYEES.md §5c. The short form is
**maker-checker**: `payment_instruction.content_hash` is what an approver must
cite and it covers `counterparty`, so leaving the ABA off the instruction puts
*which bank receives the money* outside the thing two humans signed, to be
re-resolved later from a table that grows rows. The book is append-only but not
frozen — archive a payee, append a same-name same-last-four payee at a
different bank, and an already-approved wire addresses itself somewhere new
with no approval having changed.

**What that changed here.**

| Where | Change |
| --- | --- |
| `src/lib/payees/store.ts` | `loadWireBeneficiaries()` — the `(rail = 'wire', holderName, accountNumberLast4)` predicate, written **once**. Two copies of it would be two answers to "did a human confirm this beneficiary", at the two moments that decide it. |
| `gatePaymentOnPayee()` | Refuses `PAYEE_WIRE_PAYEE_NOT_ON_BOOK` and `PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED`, **wire only**. Both refusals already existed inside `originateApprovedWire()`, two approvals and a ledger entry too late. This is §7's item 2, done. |
| `resolveWireBeneficiary()` | Uses that reader, and adds `WIRE_ROUTING_NUMBER_NOT_CONFIRMED`: the approved number must **still** be the book's at the moment the message is addressed. It refuses rather than quietly substituting the book's current number for the one two people signed for. |
| `outbound.integration.test.ts` | Now carries `wireRoutingNumber` — a copy of the number the test itself put on the book one step earlier — and asserts the sent wire, the book and the approved instruction all name it. |

**The pre-`wireRoutingNumber` instructions are untouched.** Ten of them,
including the $42.00 wire that really went out, carry `{holderName, bic,
accountNumberLast4}`. `resolveWireBeneficiary()` treats an absent
`wireRoutingNumber` exactly as before — resolved from the book, ambiguity
refused — because a required field would rewrite history by refusing to read
it. The gate runs on the way *in* and never on the way out.

**The ACH asymmetry is preserved and is the point.** `gatePaymentOnPayee()`
still allows an unregistered ACH destination: "it breaks the one-off refund, the
emergency supplier payment, the payment raised by the MCP agent from an
invoice". Every one of those costs is a cost of **delay**, and on ACH a delay is
recoverable because the entry is. On a wire it is not, and *"urgent payment,
right now, to a beneficiary nobody has seen before"* is a verbatim description
of business email compromise. `payees.integration.test.ts` asserts both
directions: the same unknown beneficiary is refused on wire and allowed on ACH.

### b. `RailSettlement` carries no direction

`reportSettlements()` nets `returned` negative and everything else positive. It
has no concept of an outbound payment versus an inbound receipt, so summing a
$2,500 wire we sent and a $12,500 wire we received gives `+$15,000`. On ACH
this was masked because the feed was effectively one-directional. It is a
property of `contract.ts`, not of this rail, and it is asserted as-is in
`adapter.test.ts` with a comment rather than worked around.

### c. One vendor, two rails, one webhook provider key

`webhook_inbox.provider` is `'increase'` — the vendor, correctly, because that
is what signs the request. `RailDelivery.provider` matches
`identity.provider`, which is `increase.ach` or `increase.wire` — the rail.
A dispatcher needs to route between them; `isWireDelivery(category)` is exported
from `src/lib/rails/wire/types.ts` so that decision is one import and not a
`startsWith` at the call site.

### d. `observe()` dispatches on `associated_object_type`, never on an id prefix

Worth recording because the ACH adapter had exactly this bug and it was fixed
the same night: `parseEvent()` gated on
`associated_object_id.startsWith('ach_transfer_')` while **every sandbox id is
`sandbox_ach_transfer_...`**, so every sandbox settlement and return was
classified "unmodelled" and dropped with a 200 — the failure mode that looks
like success from both ends.

This rail cannot have that bug by construction: it routes on `category` through
`isWireDelivery()` and then branches on `pointer.associated_object_type`. No id
prefix is ever inspected. `measured.ts` holds real `sandbox_wire_transfer_...`
and `sandbox_inbound_wire_transfer_...` ids, so the unit tests exercise the
exact prefix that broke ACH.

### e. `src/lib/ledger/boundary.test.ts` caught this rail immediately, and was right

The first `resolveWireChart()` was a four-deep self-join across `account`,
copied in spirit from the Plaid adapter's. The boundary test failed it by name
within a minute. It is now three named readers — `mainDepositAccountId`,
`readAccountIdentity`, `resolveChartCodes` — and the same happened a second
time when `outbound.integration.test.ts` reached for `journal_line` to check
which legs a released wire posted to; that is now `listLedgerLines`.

**`src/lib/rails/wire/` adds no line to the allowlist and should stay off it.**
The ratchet asserts the allowlist has no stale entries, so a line added for
this rail becomes a red test for whoever runs next.

---

## 7. What this rail does not do, and who owns it

| Gap | Owner | The change |
| --- | --- | --- |
| **No webhook consumer is registered for `increase`.** 13 verified wire deliveries sit in `webhook_inbox` as `pending`, "no consumer registered". `observe()` is written, tested against real bytes, and nothing calls it in the deployed system. | `src/lib/webhooks/**` | register a consumer for `increase` that routes on `isWireDelivery(category)` to `increaseWireAdapter().observe()` and on everything else to the ACH adapter |
| **The rail is not in `allRailAdapters()`**, so it does not appear on `/api/health` or in the generated matrix in `docs/RAILS.md`. Deliberate: `contract.test.ts` asserts that table appears **verbatim** in `docs/RAILS.md`, so a sixth row turns the suite red until the doc is regenerated — and both files belong to the rails owner. | `src/lib/rails/adapters/index.ts`, `docs/RAILS.md` | `rails.push(increaseWireAdapter({ env }))` plus a regenerated table |
| **Wire drawdown requests.** 403 `private_feature_error`. Not built, not simulated, not claimed. | Increase | request access |
| **A wire approval ladder** (two approvers over $X, one under). | `db/migrations`, `approval_policy` | §5 |
| **Nothing calls `debitReturnedInboundWire()` automatically.** It is written and reachable; wiring it to an observed `inbound_wire_transfer.updated/reversed` needs the consumer above. | `src/lib/webhooks/**` | as above |

### What `/payments` needs

**Nothing, to raise a wire.** `PAYOUT_RAILS` already contains `wire`,
`PaymentForm.tsx` already renders a wire branch (beneficiary name, BIC, last
four), `buildDestination()` already assembles the `wire` variant, and
`releasePayment()` already maps wire to house account 1110 with the right
reasoning already written down. The screen offers the rail today.

**Three things would make it correct.** All three are now done, and items 1 and
2 are what §6a settled:

1. ~~**Replace the BIC field with a 9-digit wire routing number.**~~ **Done.**
   `wireRoutingNumber` is on the wire variant and `bic` is demoted to an
   optional extra for genuinely cross-border wires. It is the field a payments
   clerk actually has, it is what Fedwire routes on, and it is what
   `src/lib/payees/` already validates.
2. ~~**Offer a payee picker on the wire branch.**~~ **Done**, and the refusal
   moved with it. `originateApprovedWire()` refuses a beneficiary that is not on
   the confirmed payee book, so a free-text field let a clerk raise a wire that
   nobody could send — a refusal two approvals and one ledger entry too late.
   `gatePaymentOnPayee()` now makes it at `requestPayment()`
   (`PAYEE_WIRE_PAYEE_NOT_ON_BOOK`), the picker makes it unreachable from the
   screen, and the rail still checks at the moment the money leaves. The picker
   is **not** the control: the public API and the MCP write tool reach
   `requestPayment()` without passing this way.
3. ~~**Show `required_approvals` on the form before submitting.**~~ The wire
   branch now says two humans at any amount rather than "reached the
   threshold", which read oddly next to $42.

---

## 8. Real ids

Everything below is a sandbox object from 2026-09-11. Nothing here is a
fixture.

**The outbound wire raised through `requestPayment()` — the full maker-checker path**

```
payment_instruction  f087aacb-860f-4565-8ca0-bca9f31abeec   $42.00, rail=wire
  requested  Priya Raman · approved  Dana Okonkwo · approved  Miles Ferrara
  released   Miles Ferrara -> journal_entry a54424b2-deda-42b9-a140-de9b77041b6d
             (DR 2100/ridgeline, CR 1110 cash)
increase     sandbox_wire_transfer_zyh1tf6lb5ajt4k2m8ob   status complete
             Idempotency-Key  payment:f087aacb-860f-4565-8ca0-bca9f31abeec
             routing_number   021000021   (the WIRE variant)
             IMAD             20260911iatzjxbq493260
             transaction      sandbox_transaction_w6cqs3ecp6te88nrhvz0
```

**The wire that was originated, settled and then reversed**

```
sandbox_wire_transfer_897tmwn18z27tzkqbkhe        $2,500.00
  submission IMAD   20260911sgzamiaa787670    transaction sandbox_transaction_2ff00n3glfneatkctcl9
  reversal   IMAD   20260911apvdjfqt599399    transaction sandbox_transaction_z2nbixfsj9yy6kmf1nc0
             class_name inbound_wire_reversal · return_reason_code null
```

**Inbound wires, credited with immediate availability**

```
sandbox_inbound_wire_transfer_qxg617pukmm33vughtkx  $750.00  IMAD 20260911nnrntqts224262
sandbox_inbound_wire_transfer_nfsbmdtuyq8i7ryymosd  $750.00  IMAD 20260911oxamxcar049693
sandbox_inbound_wire_transfer_4v9mzsz726uiuai1yyl0  $750.00  IMAD 20260911wihcknqw040554
```

each producing three journal entries — financial credit (DR 1110 / CR 2100),
memo hold, memo release — all on value date 2026-09-11, with
`available_at = 2026-09-11T04:00:00Z` (midnight ET) which is **before** the
credit committed. `v_wire_credit` reads:

```
credited_cents 75000 · held_cents 0 · banking_days_hold 0 · release_local_time 00:00:00
```

**The inbound wire we sent back out**

```
sandbox_inbound_wire_transfer_00lkxr57i04x31blx06x  $12,500.00
  acceptance  accepted_at 2026-09-11T03:59:29Z == created_at   (no pending stage)
  reversal    reason "creditor_request", reversed_at 2026-09-11T04:04:04Z
```

**Verdicts**

```
v_wire_availability_drift   0 rows      (no wire hold ever bound)
v_hold_release_drift        0 rows      (every released hold is flat)
node scripts/dbcheck.mjs    28 passed, 0 failed
```

---

## 9. The files

```
db/migrations/0025_wires.sql      policy rows, 8 semantics rows, 2 views
src/lib/rails/wire/
  types.ts        vocabulary + the measured Increase wire shapes
  client.ts       the ISO-20022 endpoints; `simulate*` names the counterparty ones
  semantics.ts    provider objects -> RailEvent. Pure: no network, no db, no clock
  adapter.ts      the contract's five operations, one refused
  ledger.ts       booking a wire; the immediate-availability proof
  outbound.ts     the provider leg of an approved, released instruction
  measured.ts     real bytes off the sandbox and out of webhook_inbox
  index.ts
  *.test.ts       51 unit, 11 integration (gated on RUN_DB_TESTS=1 + the key)
```

Nothing outside those paths was modified.
