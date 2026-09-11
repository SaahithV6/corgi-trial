# `/api/health` — the five questions, and why they are five

`GET /api/health` answers five questions about this deployment. They are
separate fields with **disjoint verdict vocabularies**, because they are
separate questions and a reader must never have to reconcile them.

| # | Field | Question | Vocabulary | Source |
|---|-------|----------|-----------|--------|
| 1 | `integrations.slots` | Does the credential work, and can the slot do its job? | `live` `simulated` `unauthorised` `unreachable` `rate_limited` `not_configured` `unprobed` | a real authenticated round trip per provider (`probe.ts`) |
| 2 | `integrations.webhookHealth` | Is the provider still talking to us? | `fresh` `stale` `quiet` `never` `unknown` | `MAX(webhook_inbox.received_at)` |
| 3 | `integrations.transactionInitiation` | Was there anything for it to say? | `transacting` `dormant` `uncounted` `unattributable` | `card_auth_decision.decided_at` where `source = 'provider'` |
| 4 | `integrations.webhookProcessing` | Did we do anything with what arrived? | `consuming` `backlogged` `dropping` `refused` `superseded` `never_consumed` `idle` `unmeasured` | `webhook_inbox.processed_at + state` |
| 5 | `integrations.plaidItems` | Do we hold a usable funding source? | `healthy` `needs_reauth` `revoked` `orphaned` `absent` `unread` | Plaid's own words, recorded when it said them |

`lithic: live` + `stale` + `dormant` + `consuming` is four facts about four
questions, not a contradiction. No string in one vocabulary appears in another,
and `initiation.test.ts` and `processing.test.ts` both assert it, with the
liveness list pinned to the `Liveness` union by the compiler so it cannot
drift.

---

## Question 3 is new. This is why.

### The reading that forced it

Measured against production at `2026-09-11T17:56Z`:

```json
{ "provider": "lithic", "staleAfterSeconds": 180, "quietAfterSeconds": 900,
  "gatesDeploymentStatus": true,
  "lastDelivery": "2026-09-11T17:48:27.752Z", "secondsSinceLastDelivery": 489,
  "verdict": "stale", "degradesDeployment": true,
  "note": "silent for longer than 180s after recent traffic — treated as an outage" }
```

`status` was `degraded`. Everything else was green: the database reachable,
integrations 7 of 7 live, `webhookProcessing.degradedBy: []`, and the Lithic
probe reading `GET /v1/cards -> 200` **in the same response**.

There was no outage. A burst of test traffic had ended at 17:33:20 and nobody
had swiped a card in the eight minutes since.

### The defect

`MAX(received_at)` cannot distinguish two different facts:

1. the provider **stopped delivering while transactions were still happening** —
   that is loss, and it must degrade the deployment;
2. **nobody transacted**, so there was nothing to deliver — that is a quiet
   Thursday, and it must not.

It measures *time since the last webhook* when the question is *are we losing
deliveries*. That is this repository's signature defect: a guard reporting on a
population chosen by something other than the capability it stands for. The
delivery module's own header already names this failure — a threshold any
looser and "this endpoint reports degraded overnight because nobody swiped a
card, which trains its readers to ignore it". The threshold was made tight. The
question was left wrong.

### The fix is not a wider threshold

`staleAfterSeconds` stays at 180. Widening a guard until it stops complaining is
the banned move in this codebase, and it would also be wrong: with a real outage
during a demo, 180s is the right sensitivity, and `initiation.test.ts` asserts
that an outage with traffic in it still degrades at **181 seconds**.

What changed is the population the verdict is read against, not the clock.

### The deciding fact

**`card_auth_decision` where `source = 'provider'`.**

That table is the durable record of Auth Stream Access. Lithic calls
`/api/webhooks/lithic-auth` *synchronously*, holding a cardholder's
authorisation open at a terminal, and waits for our answer. A row with
`source = 'provider'` means a real card was presented at a real terminal at
`decided_at`. `source = 'harness'` means we replayed an ASA-shaped payload
locally; migration 0014 made that a column rather than a convention precisely so
the second can never be presented as the first, and this module reads only the
first.

**It is on a different channel from the thing it measures.** The ASA path writes
no journal entry, no hold and no `webhook_inbox` row — see the header of
`src/app/api/webhooks/lithic-auth/route.ts`, which argues why nothing on the
synchronous path may touch the ledger. The money moves later, on the
asynchronous `card_transaction.updated` delivery into the inbox. So an ASA
decision is evidence of a transaction that survives the feed going dark, which
is the only kind of evidence that can settle the question.

#### What was rejected, and why

`card_authorization.first_seen_at`, `card_auth_event.received_at` and
`hold.created_at` all look like records of a transaction, and all three are
written **by the consumer of the webhook**. None of them can be newer than the
delivery whose absence is in question, so asking them "did a transaction happen
since the last delivery?" returns "no", always, by construction — the same shape
of mistake one layer down.

#### Measured, not assumed

Every one of the 88 provider-sourced ASA decisions in this database was followed
by a `card_transaction.updated` delivery carrying the same transaction token:

```
matched 88 of 88   lag: min 0.384s   p50 0.797s   p95 1.338s   max 1.739s
```

Approvals *and* declines. So an ASA decision with no delivery after it is a
delivery we are owed and were not given, and 88/88 says the inference holds for
every outcome rather than only for approvals.

---

## The narrowing, and its three fail-closed defaults

`attributeDeliverySilence()` in `src/app/api/health/initiation.ts` folds the
initiation read together with the delivery verdicts and returns both the
narrowed delivery field and the evidence, as one value — so the published
`degradesDeployment` and the published reason for it cannot drift apart.

**It only ever subtracts an alarm, only from `stale`, and only on a counted
zero.**

| Verdict | Meaning | Effect |
|---------|---------|--------|
| `transacting` | ≥1 transaction initiated after the newest delivery | alarm stands |
| `dormant` | a counted zero: nothing initiated since the newest delivery | **alarm removed** |
| `uncounted` | the query did not run, or the count did not parse | alarm stands |
| `unattributable` | this system records no initiation ledger for this provider | alarm stands |

Absent evidence reads as the alarm, never as the all-clear. Three places
enforce it:

* **A read that did not run is `uncounted`.** `toCount()` returns `NaN` rather
  than `0` for a value it cannot parse, because zero is the one value that takes
  an alarm away and it may only ever come from the database having actually
  counted.
* **A provider with no initiation ledger is `unattributable`.**
  `INITIATION_SOURCES` is an explicit allow-list, not
  `Object.keys(DELIVERY_THRESHOLDS)`. A sixth provider that gates deployment
  status keeps its alarm until somebody names the table that records its
  traffic, rather than inheriting a silent `dormant` from a count that was zero
  because nothing was ever counted. That inversion — "absent evidence of a
  fault" becoming "proven refusal" — is what made the first draft of the
  dead-letter narrowing wrong one module over.
* **Any initiation after the last delivery is `transacting`.** Not "any *overdue*
  initiation" — any at all. A grace period would be a second number to defend
  and it would be the wrong shape: the narrowing only ever runs on a feed that
  is already past its staleness threshold, so an in-flight delivery cannot be
  mistaken for a lost one without the clock having already said `stale` on its
  own.

### `quiet` and `never` are untouched

Both words are load-bearing — "this provider has gone quiet" and "we have never
heard from this provider" are different facts with different fixes — and neither
degrades anything today, so there is nothing here to narrow. Asserted byte for
byte in `initiation.test.ts`.

### The verdict is untouched too

A narrowed provider still reads `verdict: "stale"` with its real
`secondsSinceLastDelivery`. That is a true statement about `MAX(received_at)` and
it stays on the record. What changes is whether that silence is read *as* an
outage, and the `note` says so in words:

> silent for longer than 180s, and NOTHING WAS INITIATED in that silence:
> `card_auth_decision (source = 'provider')` holds no transaction after the
> newest delivery, so there is nothing this provider owed us and did not send.
> Silence with no traffic behind it is disuse, not an outage — see
> `transactionInitiation`.

`delivery-health.ts` already publishes four other stale-but-not-degrading
sentences for exactly this shape (not gating, not live, no verifier). This is
the fifth. An unexplained `degraded` is worse than an explained one; a false
`ok` is worse than both.

---

## Cost

One extra round trip on the connection the `select 1` has already warmed,
started in parallel with the probes so its wall time hides inside their 4s
budget. Measured against the production branch:

```
warm wire latency: 151ms, 72ms, 67ms
EXPLAIN (ANALYZE, BUFFERS):
  Function Scan on unnest p  (actual time=0.068..0.069 rows=1 loops=1)
    -> Index Only Scan using webhook_inbox_provider_received_idx  (Heap Fetches: 1)
    -> Index Scan using card_auth_decision_card_idx
  Buffers: shared hit=8   Execution Time: 0.120 ms
```

0.12ms of database time, 8 buffer hits, no sequential scan. The counts are
bounded by `initiationHorizonSeconds()` — twice the widest quiet window of any
attributable provider, 1800s today — so they cannot grow with the decision log.
The bound is safe rather than merely convenient: the narrowing only runs on a
`stale` provider, and `stale` means the last delivery is no older than
`quietAfterSeconds` (past that the verdict is `quiet`, which degrades nothing
and is never narrowed), so every initiation that could be "after the last
delivery" on a degrading provider is inside the horizon by construction.

Its own 2.5s timeout matches the other two enrichment reads. It never throws: a
health endpoint that cannot answer because its own enrichment query failed has
become the outage.

---

## What makes the deployment `degraded`

```
status = ok  iff  database.reachable
              and webhookHealth.degradedBy    is empty   (silence WITH traffic behind it)
              and webhookProcessing.degradedBy is empty   (deliveries dropped)
```

* `not_configured` integrations do **not** degrade. A provider we have not wired
  is a scope decision, not an outage.
* A **dead webhook feed** degrades under five conditions, all of them: a gating
  provider (Lithic alone today), verdict `stale` rather than `quiet` or `never`,
  a probe that says the integration really is live, a registered verifier, and —
  new — something initiated in the silence that was never delivered.
* A **dropped delivery** degrades under none of those, because it is not
  silence. "Nobody used this integration" cannot produce a dead letter.
* `plaidItems` never degrades: `needs_reauth`'s exit condition is a person
  logging into their bank.
