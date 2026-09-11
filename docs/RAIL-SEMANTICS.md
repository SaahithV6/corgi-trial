# `rail_event_semantics` — what it governs, and how to add a row

**Status: LOAD-BEARING.** Delete a row and the Lithic consumer stops processing
that lifecycle step. There is a test that proves exactly that
(`src/lib/rails/semantics.test.ts`, "parks if the row it needs is DELETED").

Before this was wired the table had 22 seeded rows and zero readers
(DECISIONS 027, finding 2). It now has one reader,
`src/lib/rails/semantics.ts`, and **three** consumers that ask it:
`consumers/lithic-card.ts`, `consumers/increase-wire.ts`, and
`consumers/increase-ach.ts` — the last of which asks on **both** legs of the
ACH rail as of 2026-09-11 (§4b). **Thirty rows are live and `scripts/seed.mjs`
now seeds all thirty**: the eight wire rows `0025_wires.sql` inserted directly
have been mirrored into the seed, and the seed no longer carries a stale copy of
the row `0039_inbound_recall.sql` corrected. §7 is the record of that gap and of
how it is now asserted shut.

---

## 1. The one question this table answers

For each provider event type: **when this event arrives, is it a correction of
something we already booked, or a new event in its own right?**

| | means | `value_date` comes from |
| --- | --- | --- |
| `correction` | the original posting was a **false statement about its own value date** | the **original entry's** value date. `value_date_source` is the literal string `original.value_date`, because there is no payload field to read |
| `new_event` | the original was **true then**, and the world changed after | **its own** date, read from the payload field named in `value_date_source` |

The rule of thumb that fills the table (DESIGN.md §6.1): *was the original
posting a false statement about its own value date?* If yes, correction. If it
was true then and the world changed after, new event.

### The two rows that are opposite, and why

**An ACH return is a NEW EVENT at a NEW value date.** This is measured, not
reasoned (DECISIONS 019): after a return on Increase, the transfer's
`settlement.settled_at` is *still populated* and the transfer id is *unchanged*.
The provider models a return as a second money movement, not as an edit of the
first — because that is what it is. The money really did leave on the settle
date and really did come back later. **A statement for the settle date should
still show the payment.** Booking the return at the settlement's value date
would erase a settlement that occurred and make an already-issued statement
disagree with the customer's own bank.

**A card clearing reversal is a CORRECTION at the ORIGINAL value date**, because
the clearing should never have posted at that amount. That day has to be made
whole.

The two look nearly identical in the API and are opposite in the ledger. That
is the whole reason this is a table.

### Why it is data and not an `if`

Getting one row backwards **silently corrupts every past statement it touches
while all five invariants keep passing, the hash chain verifies, and
reconciliation stays clean.** Nothing goes red. There is no alarm for it, and
there cannot be one — a wrongly-dated entry is a perfectly well-formed entry.

The only defence against that is *review*, and you cannot review a branch buried
three modules deep inside a webhook handler. So the decision is 30 rows with a
`note` on each, and it is reviewed the way any other change is reviewed.

---

## 2. The key

`PRIMARY KEY (provider, provider_event_type)`.

Several providers fire **one** webhook type for every step of a lifecycle and
put the step inside the payload:

- Lithic sends `card_transaction.updated` for an authorisation, a clearing, an
  expiry and a reversal alike; the step is `events[].type`.
- Increase sends `ach_transfer.updated` for submission, settlement, return and
  notification-of-change alike.

If the key were the webhook type alone, the entire card lifecycle would collapse
into a single ungovernable row. So the key is `<event type>/<nested step>`:

```
card_transaction.updated/CLEARING
ach_transfer.updated/returned
usdc.transfer.reorged          <- no nested step; the type is the whole key
```

`semanticsKey(eventType, nestedStep)` in `src/lib/rails/semantics.ts` is the
only place that composition is written down.

---

## 3. What happens when a provider ships an event type nobody has classified

**The event parks. It is never guessed at, never defaulted, and never dropped.**

`resolveEventSemantics()` answers `classified` or `unclassified` and nothing
else. There is no fallback to a same-provider row, no fallback to the bare
webhook type with the step stripped off, and no "assume `new_event`, it's the
common case". A default is precisely how a missing row hides: the event posts,
the numbers look plausible, and nobody ever learns that nobody ever decided.

Concretely, for a Lithic delivery carrying an unclassified step:

1. The consumer returns `parked("rail_event_semantics", "<the key>")` **before**
   the payload reaches the ledger. Nothing is written to the money tables.
2. The `webhook_inbox` row goes to state `parked` with the key recorded in
   `parked_on_ref`, so `SELECT ... WHERE parked_on_kind = 'rail_event_semantics'`
   lists everything waiting on a classification.
3. The dispatcher re-checks it on a timer — 30s doubling to an hour, twelve
   times, a little over five hours.
4. Past twelve parks the row is **dead-lettered** and shows up on the staff
   screen in front of a human.
5. **Adding the row drains it.** The reader re-reads the table on a cache miss,
   so a row added while events are parked takes effect on the next re-check with
   no deploy and no data loss. The raw body was stored and verified at ingest, so
   nothing about the event has been lost in the meantime.

Refusal is **all-or-nothing per delivery**: one unclassified step parks the whole
payload. A provider hands us the entire lifecycle array in every delivery, and
there is no way to act on the classified half while leaving the rest for later
without inventing an ordering the dispatcher explicitly refuses to promise.

### Known gap: four Lithic event types have no row

Lithic's `TransactionEventType` union has 14 members. The table classifies 10.
These four are recognised by `src/lib/holds/lithic-events.ts` and **have no
row**, so a delivery containing one will park:

| Event type | What the code does with it today |
| --- | --- |
| `BALANCE_INQUIRY` | recognised and skipped; posts nothing |
| `CREDIT_AUTHORIZATION` | recognised and skipped; posts nothing |
| `CREDIT_AUTHORIZATION_ADVICE` | converted to a memo hold delta |
| `FINANCIAL_CREDIT_AUTHORIZATION` | **posts money to the customer** |

None has ever been seen in this system — every `card_transaction.updated`
delivery in `webhook_inbox` carries only `AUTHORIZATION` and `CLEARING` — but the
last of those four moves money at a value date nobody has reviewed, which is
exactly the case this table exists to catch. Parking is the correct answer until
somebody adds the rows. See §5 for how.

---

## 4. What the table currently claims vs. what the code currently does

The table is a set of claims. Wiring the reader does **not** by itself make the
posting code obey it, and it is important not to over-claim here.

`src/lib/rails/semantics.test.ts` §6 is a **characterisation test** that compares
each Lithic row against what `deriveCardEvents` + `postCardMovement` actually do.
Five of the ten card rows diverge today:

| Step | Table says | Code does |
| --- | --- | --- |
| `CLEARING` | `new_event` @ `payload.created` — the **local transaction date** | dates it at `events[].created`, the clearing's own date |
| `FINANCIAL_AUTHORIZATION` | `new_event` @ `payload.created` | dates it at `events[].created` |
| `RETURN_REVERSAL` | `correction` @ **original** value date | ordinary posting at the event's own date, canonical kind `force_post` |
| `CORRECTION_DEBIT` | `correction` @ **original** value date | ordinary posting at the event's own date, canonical kind `force_post` |
| `CORRECTION_CREDIT` | `correction` @ **original** value date | ordinary posting at the event's own date, canonical kind `refund` |

The first two are invisible in the sandbox, where a transaction clears the same
day it is authorised; they differ for a Friday dinner that clears on Monday.

The last three matter more: **the card path has no correction route at all.**
Nothing under `src/lib/holds/` calls `reverseAndRebook()`, so a card correction
posts as a new entry at its own date rather than as a reversal at the original's.
The ACH and USDC rows have no consumer at all yet, so they are unexercised
rather than divergent.

Closing any of those five turns the characterisation test red on purpose:
nobody should close a gap without being told the table already agreed with the
fix. **The `semantics` column is not yet what dates a card posting** — say that,
not "the ledger reads the table".

---

## 4b. The inbound ACH rows: what being unreachable hid

**2026-09-11, after `docs/GAUNTLET.md` was written.** The gauntlet reported the
two inbound ACH rows as **unreachable code**:

```
ach / increase / inbound_ach_transfer.created           -> inbound_ach_credit
ach / increase / inbound_ach_transfer.updated/returned  -> inbound_ach_return
```

`increaseAchConsumer` parked every `inbound_ach_transfer` delivery on
`associated_object_type` *before* any semantics lookup ran, so neither row could
ever be consulted. The consumer now consults them
(`src/lib/webhooks/consumers/increase-ach.ts` §4b), and the first thing that
happened when it did was that **one of the two turned out to be wrong.** That is
the whole case against leaving a row unreachable: an unread row cannot be
falsified by anything, so it stays plausible for ever.

### The measurement

`rail_event_semantics` shipped the recall row with
`value_date_source = payload.return.created_at`, which is the **outbound**
`ach_transfer` shape, copied across by analogy. The inbound object does not have
it. Measured end to end on the Increase sandbox, 2026-09-11:

```
POST /simulations/inbound_ach_transfers
     {account_number_id: sandbox_account_number_96mzhz3n61f5p0jpvytc,
      amount: 250000, company_name: "ACME SUPPLY CO"}
  -> sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b
     status "accepted", effective_date "2026-09-11", transfer_return null

POST /inbound_ach_transfers/{id}/transfer_return
     {reason: "credit_entry_refused_by_receiver"}
  -> status "returned", and the ONE new block on the object:
     "transfer_return": {"reason": "credit_entry_refused_by_receiver",
                         "returned_at": "2026-09-11T08:53:59Z",
                         "transaction_id": "sandbox_transaction_wqd6t4p2k5berabecln8"}
```

| | outbound `ach_transfer` | inbound `inbound_ach_transfer` |
| --- | --- | --- |
| the return block | `return` | **`transfer_return`** |
| its instant | `return.created_at` | **`transfer_return.returned_at`** |
| the reason code | `return.return_reason_code` | `transfer_return.reason` |
| the trace number | `return.trace_number` | `trace_number`, on the object itself |

`valueDateFromSource()` walks the path the table names and returns `null` when it
is absent, and the consumer parks rather than guessing a date. So the row as
shipped could never have dated a recall even once the branch existed.
`db/migrations/0039_inbound_recall.sql` corrects it to
`payload.transfer_return.returned_at`.

### Why correcting was allowed here, when §5 says "don't"

§5's rule is that a wrong row needs the row **plus a correction pass over the
entries it mis-dated**, and the pass is the hard half. There was nothing to
correct: the row was unreachable for its entire life, so it has dated **zero**
postings — `SELECT count(*) FROM journal_entry WHERE idempotency_key LIKE
'ach:inbound:%'` was 0 before the change and is 0 after it. This is the cheap
case the rule contemplates, and it is the only kind of row change that should be
made without a repair alongside it.

### The claim that was withdrawn at the same time

Both notes described a build that posts an inbound credit to a customer's `2100`
leaf and opens a `9200` uncleared-credit hold. **This build cannot**, and one
measurement says why:

```
GET /account_numbers -> exactly ONE object
  sandbox_account_number_96mzhz3n61f5p0jpvytc  (7467448488 / 123308582)
  on the programme's own FBO account sandbox_account_zkfx1wcn4brwoaiyksj6
```

Six businesses share that number. An inbound ACH credit names
`account_number_id`, so the field that is supposed to say whose money it is names
the programme; there is no `account_number -> business` table in the schema and
no path that issues per-customer numbers. So an inbound credit cannot be
attributed, is never booked, and the recall row's premise — *"an inbound credit
we already posted has been returned"* — is false here. `canonical_kind` and
`semantics` were **not** touched: both classifications were right. What was wrong
was one field name and two sentences of scope.

**Superseded in part, 2026-09-11.** `db/migrations/0042_virtual_account_numbers.sql`
issues per-customer virtual account numbers and maps `account_number_id` to one
business, so the withdrawn claim above — that an inbound credit cannot be
attributed and is never booked — no longer describes the build. Both inbound ACH
notes in the live table were rewritten by 0042 and say what the consumer does
now; the seed carries that text verbatim (§7). The measurement that forced the
`value_date_source` correction is unaffected, because it was about the shape of
the provider's object and not about what this build does with it.

The wire rail's answer does not transfer, and it is worth knowing why rather than
assuming it should: `increase-wire.ts` books an inbound credit in exactly one
case, `wire_transfer.updated/reversed`, where attribution comes from **our own
outbound transfer** (`Idempotency-Key: payment:<instruction id>` → instruction →
account → business). ACH has no analogue, because when an outbound ACH payment of
ours comes back it does not arrive as an `inbound_ach_transfer` at all — it
arrives as a `return` block on the same `ach_transfer`, which `applyStep`'s
`ach_return` arm has booked since it was written.

---

## 5. How to add a row safely

Rows live in `RAIL_EVENT_SEMANTICS` in `scripts/seed.mjs`. That array is the
source of truth; the database is a deployed copy of it.

1. **Answer the question, in writing.** *Was the original posting a false
   statement about its own value date?* Put the answer in the `note` column, in
   a sentence, with the evidence. "Measured on <provider> on <date>: after the
   event, `<field>` was still populated" beats any amount of reasoning.

2. **Add the row to `RAIL_EVENT_SEMANTICS`.** Keep the field order — the test
   parses the file. `providerEventType` must be the composed key from §2.

3. **Make the two columns agree.** A `correction` row **must** carry
   `valueDateSource: "original.value_date"`, and a `new_event` row must **not**.
   `checkedRow()` throws `RailSemanticsIntegrityError` on the read path if they
   disagree, because a row where those two halves contradict each other has one
   of them wrong and there is no safe way to guess which.

4. **Add the test.** One `it()` per row in `EXPECTED` in
   `src/lib/rails/semantics.test.ts`, with the reason in the `why` field — that
   string becomes the test name, so `pnpm test` prints the review.
   **A row without a test fails the suite**: the key sets are compared, in CI,
   with no database. That is the point of a test per row rather than per rail —
   a rail-level test passes with twenty-one right rows and one wrong one.

5. **Seed it.** `set -a; . ./.env; set +a; node scripts/seed.mjs`. The insert is
   `ON CONFLICT ... DO UPDATE`, so re-seeding is safe and updates in place.

6. **Verify against the live database.**
   `set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/rails/semantics.test.ts`
   asserts the deployed table is exactly what the seed file seeds — same keys in
   both directions, same rails, same canonical kinds, same semantics, same
   value-date sources, and the same `note`. A key that is live and not seeded
   fails naming the key; see §7.

### Changing an existing row

Don't, without evidence. A row that has been live has already dated postings;
flipping it changes what future events do but not what past ones did, so the
book ends up with two conventions and no marker between them. If a row is
genuinely wrong, the fix is the row **plus** a correction pass over the entries
it mis-dated, and the correction pass is the hard half.

---

## 6. Files

| Path | Role |
| --- | --- |
| `db/migrations/0001_ledger.sql` | the table, `PRIMARY KEY (provider, provider_event_type)` |
| `db/migrations/0025_wires.sql` | the eight wire rows, inserted directly with their measurements |
| `db/migrations/0039_inbound_recall.sql` | the inbound ACH recall row corrected, and the inbound credit note's claim withdrawn (§4b) |
| `db/migrations/0042_virtual_account_numbers.sql` | both inbound ACH notes rewritten again, once an inbound credit became attributable |
| `scripts/seed.mjs` | `RAIL_EVENT_SEMANTICS` — all 30 rows, source of truth for the table |
| `src/lib/rails/semantics.ts` | the reader. No default, ever |
| `src/lib/rails/semantics.test.ts` | 30 assertions, one per seeded row, plus the characterisation test and the live comparison (§7) |
| `src/lib/webhooks/consumers/lithic-card.ts` | the card consumer that asks |
| `src/lib/webhooks/consumers/increase-wire.ts` | the wire consumer that asks |
| `src/lib/webhooks/consumers/increase-ach.ts` | the ACH consumer that asks — outbound in §4, inbound in §4b |
| `research/ledger/DESIGN.md` §6.1, §14 | the design |
| `DECISIONS.md` 019, 027 | the measurement, and the over-claim it corrects |

---

## 7. The live table and `scripts/seed.mjs` both hold 30 rows

**This section used to be a warning. It is now a record and a rule.**

### What the gap was

`scripts/seed.mjs` carried 22 rows and the deployed table held 30, because
migrations had written to it directly:

| | rows | what it wrote |
| --- | --- | --- |
| `scripts/seed.mjs` | 22 | the card, ACH and USDC rows |
| `0025_wires.sql` | +8 | the wire rows, with the Fedwire measurements in each note |
| `0039_inbound_recall.sql` | 0 | **changed** two existing rows: one `value_date_source`, two notes |
| `0042_virtual_account_numbers.sql` | 0 | **changed** the same two notes again, once an inbound credit became attributable |

`RUN_DB_TESTS=1 pnpm test src/lib/rails/semantics.test.ts` had been red since
0025 on the length check (`expected live to have a length of 22 but got 30`).

**The red test was the symptom and not the danger.** The insert in the seed is

```sql
ON CONFLICT (provider, provider_event_type) DO UPDATE
  SET rail = EXCLUDED.rail, canonical_kind = EXCLUDED.canonical_kind,
      semantics = EXCLUDED.semantics,
      value_date_source = EXCLUDED.value_date_source,
      note = EXCLUDED.note
```

so the seed does not merely lag the table, it **overwrites** it. With the seed
holding `payload.return.created_at`, the next `node scripts/seed.mjs` would have
put back a path that does not exist on an `inbound_ach_transfer` object.
`valueDateFromSource()` returns `null` for a path that is absent and the consumer
parks rather than guessing, so every inbound recall would have parked with no
value date — a measured fix reverted by a routine command, with nothing red to
say so. Eight wire rows were exposed the other way round: a database stood up
from the seed alone came up with no wire classifications at all.

### What is true now

Both hold the same 30 rows, and the three copies are tied together:

| | rows |
| --- | --- |
| `scripts/seed.mjs`, `RAIL_EVENT_SEMANTICS` | 30 — the 22 plus the eight wire rows, mirrored verbatim from `0025_wires.sql` |
| `src/lib/rails/semantics.test.ts`, `EXPECTED` | 30 — one reviewed `it()` per row |
| the deployed table | 30 |

The inbound recall row reads `payload.transfer_return.returned_at` in all three,
and both inbound ACH notes are the deployed text — 0039's measurement and 0042's
rewrite — so a re-seed carries them forward instead of reverting them.

**Verified, not asserted:** `node scripts/seed.mjs` was run against Neon after
the change and reported `rail_event_semantics  no change  30 already present`,
and a column-by-column re-read of the table before and after was identical.

### How it stays shut

`src/lib/rails/semantics.test.ts` §7 no longer compares a count. It compares the
KEY SETS in both directions and then every one of the seven columns, `note`
included:

* **a key live and not in the seed** fails naming that key, with the sentence
  that a migration inserted it, the seed will not remove it, but a database
  stood up from the seed alone comes up without it and every delivery it
  classifies parks;
* **a key in the seed and not live** fails with the re-seed command;
* **any column that differs**, `note` included, fails on that row — because
  `note = EXCLUDED.note` means a stale note in the seed is a review sentence a
  re-seed silently reverts, which is the same failure as a stale
  `value_date_source` with a smaller blast radius.

`pnpm test` without credentials is unaffected: the live half is gated behind
`RUN_DB_TESTS=1`, and the `seed ↔ EXPECTED` half runs in CI with no database.

### The rule this leaves behind

**A migration may deploy a row. It may not be the only place the row exists.**
If you write `INSERT INTO rail_event_semantics` in a migration, add the row to
`RAIL_EVENT_SEMANTICS` in `scripts/seed.mjs` and to `EXPECTED` in
`src/lib/rails/semantics.test.ts` in the same change — §5 is the checklist — and
if you CHANGE a deployed row, mirror the new `value_date_source` and the new
`note` into the seed in that same change. The seed is the source of truth for
this table; a migration is how a change reaches the deployed copy of it.
