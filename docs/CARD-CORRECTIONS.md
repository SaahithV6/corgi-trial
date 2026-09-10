# Card corrections — what the provider can originate, and what we do with it

> "When a merchant reverses a settlement or a payment is recalled, the
> customer's balance and their statement must both show the corrected position
> for the day it happened." — the brief

Two things had to be true for that sentence to hold on the card rail, and until
this change only the first one was:

1. the ledger can reverse a past entry at its **original value date** without
   editing anything — `reverseAndRebook()` in `src/lib/ledger/post.ts`, well
   tested since the ledger was written;
2. a **provider event** actually reaches it.

`reverseAndRebook`'s only non-test callers were `src/lib/recon/demo.ts` and
`src/lib/statements/demo.ts`. Nothing under `src/lib/holds/` called it. A
`RETURN_REVERSAL` arriving from Lithic was posted by `postCardMovement()` as an
ordinary `force_post` at **its own** value date, so the day it corrected kept
its wrong figure for ever and the statement grew a second line on the day we
found out. `rail_event_semantics` had said the opposite, in a reviewed row,
since it was written.

This document records what Lithic's sandbox will and will not originate —
measured, with status codes — and how the correction path works.

---

## 1. What Lithic's sandbox can originate

Every path below was called with a live sandbox key. `{}` as the body, so an
endpoint that exists answers `400 Missing required parameter(s)` and one that
does not answers `404 Not Found`.

| `POST /v1/simulate/…` | Status | What came back |
|---|---|---|
| `authorize` | **400** | `Missing required parameter(s): amount, descriptor, pan` |
| `authorization_advice` | **400** | `Missing required parameter(s): amount, descriptor, pan. This endpoint accepts two different sets of body parameters: (Amount, Token) or (Amount, Pan, Descriptor)` |
| `clearing` | **400** | `Missing required parameter(s): token` |
| `void` | **400** | `Missing required parameter(s): token` |
| `return` | **400** | `Missing required parameter(s): descriptor, pan` |
| `return_reversal` | **400** | `Missing required parameter(s): token` |
| `credit_authorization_advice` | **400** | `Missing required parameter(s): amount, descriptor, pan` |
| `credit_authorization` | **404** | `Not Found` |
| `force_post` | **404** | `Not Found` |
| `financial_authorization` | **404** | `Not Found` |
| `correction` | **404** | `Not Found` |
| `correction_debit` | **404** | `Not Found` |
| `correction_credit` | **404** | `Not Found` |
| `clearing_reversal` | **404** | `Not Found` |
| `reversal` | **404** | `Not Found` |
| `settlement` | **404** | `Not Found` |
| `chargeback` | **404** | `Not Found` |
| `dispute` | **404** | `Not Found` |
| `expire_authorization` | **404** | `Not Found` |

**The card simulate surface is exactly seven endpoints.** It matches
`lithic-node`'s own `api.md` (`simulateAuthorization`, `simulateAuthorizationAdvice`,
`simulateClearing`, `simulateCreditAuthorization`, `simulateCreditAuthorizationAdvice`,
`simulateReturn`, `simulateReturnReversal`, `simulateVoid` — eight methods, seven
paths) with one wrinkle: **both** credit-authorisation helpers post to
`/v1/simulate/credit_authorization_advice`. The obvious-looking
`/v1/simulate/credit_authorization` is a 404, measured above, so a hand-rolled
client that guesses the path from the method name gets nothing.

`CORRECTION_CREDIT` and `CORRECTION_DEBIT` are real Lithic event types — they
are in the published `TransactionEventType` union — but **no sandbox endpoint
emits them**.

### Can a card clearing be reversed?

**No.** Measured against a transaction that had authorised $50.00 and cleared
$73.40 (token `5892c550-b966-4afb-b681-a6456e1cf3c4`):

| Attempt | Status | Effect on the transaction |
|---|---|---|
| `POST /simulate/return_reversal {token}` | **400** | `Return reversal is not supported for debit transactions` |
| `POST /simulate/void {token, amount: 7340}` | 201 | appends `AUTHORIZATION_REVERSAL −7340`. `settled_amount` unchanged. |
| `POST /simulate/void {token}` (no amount) | 201 | appends `AUTHORIZATION_REVERSAL −5000`. `settled_amount` unchanged. |
| `POST /simulate/clearing {token, amount: −7340}` | 201 | the sign is **ignored**: appends a second `CLEARING +7340`, taking `settled_amount` from 7340 to 14680. |
| `POST /simulate/authorization_advice {token, amount: 0}` | 201 | appends `AUTHORIZATION_ADVICE 0`. No effect on settled money. |

A void reverses the **authorisation**, never the settlement. A negative clearing
is a second capture, not a refund — which is worth knowing on its own, because
it is a plausible-looking way to double a customer's bill.

### What *can* be reversed: a `RETURN`

`POST /v1/simulate/return` creates an independent CREDIT transaction that
settles immediately (`RETURN`, `effective_polarity: CREDIT`). That one **can**
be reversed:

```
POST /v1/simulate/return  {amount: 7340, descriptor: …, pan: …}   -> 201
     transaction 85ab32c9-…, events: [RETURN −7340], settled −7340
POST /v1/simulate/return_reversal  {token: 85ab32c9-…}            -> 201
     ~45s later: events: [RETURN −7340, RETURN_REVERSAL +7340], settled 0
     and a real card_transaction.updated webhook fires
```

So Lithic **can** originate a genuine card correction event, end to end, with a
signed webhook — just not against a debit clearing.

### Two provider behaviours worth writing down

**Simulate side effects are asynchronous, and the transaction reads unchanged
until they land.** `return_reversal` took about 45 seconds. `void` took a few
seconds and, when it did appear, carried a **backdated** `created` — earlier than
the events that had already been read. A re-read a second later shows nothing
and looks exactly like "the endpoint does not work".

This resolves an open question in `src/lib/rails/lithic/README.md`, which
records `simulate/void` returning 200 with no effect and lists three candidate
explanations. The third one — "void processing is asynchronous beyond the wait
used, and the re-read raced it" — is the right one. Void *does* take effect; it
just cannot be observed on the timescale the original measurement used. It is
still not a settlement reversal.

**Rate limit.** `POST /v1/simulate/*` is 1 request/second in the sandbox.
Everything in this repo goes through `simulateLimiter` in
`src/lib/rails/lithic/ratelimit.ts`, including the one-off `return_reversal`
call in the live-fire test.

---

## 2. What the code does now

### The decision source is the table

`rail_event_semantics` carries one reviewed row per lifecycle step saying
whether the step is a NEW EVENT at its own value date or a CORRECTION at the
value date of the entry it repairs. The card rail has three correction rows:

| Step | `canonical_kind` (table) | `semantics` | `value_date_source` |
|---|---|---|---|
| `RETURN_REVERSAL` | `refund_reversal` | `correction` | `original.value_date` |
| `CORRECTION_DEBIT` | `correction_debit` | `correction` | `original.value_date` |
| `CORRECTION_CREDIT` | `correction_credit` | `correction` | `original.value_date` |

Nothing in `src/lib/holds/` tests `stepType === "RETURN_REVERSAL"`.
`applyCardTransaction` resolves every step in the payload through
`resolveEventSemanticsBatch()` and routes the ones whose `valueDateAnchor` is
`original`. Adding a correction step to the card rail is a row and a test, not
an edit to the money path.

### The path

```
card_transaction.updated
  └─ lithicCardConsumer            resolves rail_event_semantics; parks an
     │                             unclassified step rather than defaulting
     └─ applyCardTransaction
        ├─ recordFacts             every step enters card_auth_event, corrections
        │                          included — they are facts. postCardMovement is
        │                          SKIPPED for a correction: posting it here is
        │                          what put the repair on the wrong day.
        ├─ postCardCorrection      per correction step:
        │  ├─ chooseCorrectionTarget   pure; picks the movement being corrected
        │  └─ reverseAndRebook         reverses it AT ITS OWN VALUE DATE
        └─ settleHoldPosting       unchanged: the hold is a function of E
```

### Choosing what a correction corrects

Lithic's `events[]` is flat. A `RETURN_REVERSAL` sits beside the `RETURN` it
undoes with nothing joining them but the transaction they share — no
`corrects_event_token`, no reference number. So the link is inferred, and the
inference has to be a **pure function of the event set**, or a redelivery picks
a different target, produces a different `reversal:<id>` key, and the money is
corrected twice.

`chooseCorrectionTarget()` (`src/lib/holds/corrections.ts`) is pure, tested
without a database, and deliberately narrow:

1. candidates are the events of this authorisation that moved the financial
   book in the **opposite** direction, deduplicated on `providerEventId`;
2. exactly one candidate of the **same magnitude** → that is the target, and the
   correction is a **full reversal**;
3. otherwise exactly one candidate at all → **partial**: reverse it and re-book
   the net at the same value date;
4. otherwise → **unmatched**, and the consumer **parks**.

Case 4 covers two real situations. The correction arrived before the movement
it corrects (out-of-order delivery — the park's timed re-check drains it once
the clearing lands), or two identical clearings make the choice genuinely
ambiguous. A parked row is visible, bounded at twelve re-checks and then
dead-lettered in front of a human. **A correction is never posted at its own
date as a fallback**: that is the bug this path exists to remove, and doing it
under a friendlier name would reintroduce it.

### Idempotence, decided by Postgres

Both writes carry keys derived from immutable facts, and
`journal_entry.idempotency_key` is `UNIQUE`:

| Write | Key |
|---|---|
| reversal | `reversal:<original entry id>` (chosen by `reverseAndRebook`) |
| re-book (partial only) | `card:correction:<provider event id>` |

The target is resolved from `card_auth_event` — append-only, so a redelivery
sees the same set — down to the entry keyed `card:<kind>:<provider event id>`,
which exists once and for ever. **The correction chain is never followed**: if a
replay resolved to the re-book instead of the original, it would reverse the
repair rather than re-deciding the same repair, and the keys would no longer
collide. Redelivering a correction therefore re-derives exactly the same keys
and Postgres writes nothing.

### What a correction does NOT touch

**The hold.** A correction is a statement about MONEY, not about the
authorisation lifecycle: the clearing really did arrive, the network is only
saying its amount was wrong. `A(E)` and `C(E)` stay exactly what
`v_card_auth_hold` computes from the same rows, so `v_hold_drift` and
`v_hold_release_drift` stay at zero across a correction. The TypeScript model
and the SQL view are held equal by invariant and neither moved.

---

## 3. Two known, deliberate limitations

**The canonical kind is lossy.** `card_event_kind` is a database enum with eight
members and none of them is `refund_reversal`, `correction_debit` or
`correction_credit`; adding one is a migration. A `RETURN_REVERSAL` is therefore
stored as `force_post` and a `CORRECTION_CREDIT` as `refund` — the kinds whose
hold arithmetic is already identical. The step name survives separately on
`DerivedCardEvents.stepTypes`, which is what `rail_event_semantics` is keyed on
and what the routing reads, so nothing about the money depends on the enum
label. `src/lib/rails/semantics.test.ts` §6 pins this as a characterisation with
the reason attached.

**The reversal entry carries no `inbox_id`.** `reverseAndRebook` copies the
original's `rail`, `external_ref` and `hold_id` onto the reversal but not the
delivery that caused it, and it is in a module this change did not own. The
provenance is still recoverable — the reversal is in the original's
`correction_group_id`, the original carries the inbox row, and the reversal's
description names the provider event token that triggered it — but a
`WHERE inbox_id = …` will not find it. Worth a follow-up in
`src/lib/ledger/post.ts`.

---

## 4. Proof, on the deployed system

`src/test/livefire/attack-03-bitemporal-correction.test.ts`, run by
`node scripts/livefire.mjs --only 3` against `https://corgi-trial-psi.vercel.app`.
It runs in two parts because Lithic can originate the credit-side correction and
cannot originate the debit-side one.

### Part A — nothing synthesised

Lithic originates a $73.40 settlement and then reverses it. Both deliveries are
signed by Lithic and arrive at the deployed endpoint over the internet.

```
/v1/simulate/return            201  -> entry card:refund:<tok> at value date D,
                                       from webhook inbox row <id>
/v1/simulate/return_reversal   201  -> RETURN_REVERSAL <tok>
                                    -> entry_type=reversal, reverses the refund,
                                       same correction group, VALUE DATE D
no entry at card:force_post:<tok>   -> the correction did not post at its own date
statement for D (renderStatement):
   as-believed @ seq 1056   closing 9 611 501   58 lines
   as-corrected             closing 9 604 161   59 lines
   difference −7 340 = minus what the refund did to that day
trial balance 0 · v_hold_drift 0 · v_hold_release_drift 0
```

### Part B — the brief's sentence, with one step synthesised and named

A real $50 fuel-pump authorisation (MCC 5542) and a real $73.40 CLEARING, both
from Lithic. Lithic then refuses to reverse it — `400 Return reversal is not
supported for debit transactions` — and the test records that refusal as the
evidence for what it does next.

**Synthesised: one `CORRECTION_CREDIT` step**, dated the next day, appended to
the real transaction beside its real events.

**Not synthesised:** the signature (HMAC-SHA256 over
`<webhook-id>.<timestamp>.<body>` with the real `LITHIC_WEBHOOK_SECRET`), the
transport (`POST /api/webhooks/lithic` → 202), verification (a one-character
signature change → 401 `WEBHOOK_SIGNATURE_INVALID`, asserted as a negative
control), the inbox row, the dedupe, the drain, the `rail_event_semantics`
lookup, the target matching, or the posting.

```
fact  card_auth_event.value_date = 2026-09-11   the day we learned
money journal_entry.value_date   = 2026-09-10   SETTLEMENT DAY
      entry_type=reversal, reverses the clearing, same correction group

statement for 2026-09-10 (renderStatement):
   as-believed @ seq 1060   closing 9 596 821   60 lines
   as-corrected             closing 9 604 161   61 lines
   difference +7 340 = the capture given back, on the day it happened
statement for 2026-09-11:  0 lines
   the correction grew no second line on the day it arrived

redelivery of the same signed bytes -> HTTP 200, entries unchanged
trial balance 0 · v_hold_drift 0 · v_hold_release_drift 0
```

The one claim this cannot make is that Lithic emitted the `CORRECTION_CREDIT`
step. It cannot: the endpoints that would do so are 404 and the one that exists
refuses debit transactions, both measured above. Every other link in the chain
is real, and Part A shows the same code path driven by an event Lithic genuinely
produced.
