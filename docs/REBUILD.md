# REBUILD — throw the derived state away and rebuild it from the events

```
set -a; . ./.env; set +a
node scripts/rebuild.mjs              # the summary
node scripts/rebuild.mjs --verbose    # every finding, with real ids
node scripts/rebuild.mjs --limit 10   # cap the statements re-rendered
```

Exit `0` when everything agrees, `1` when anything disagrees, `2` when the
script could not run at all. It holds no `UPDATE` and no `DELETE` and it never
repairs anything — a disagreement is a finding, not a work item for a cron job.

---

## 1. Why this exists, and why it is different in kind

The domain gauntlet's first item says the available balance must be

> derived and provable from events — never a second stored number that drifts
> and gets "fixed" by a cron job.

This repo argues that everywhere. There is no balance column in the money
schema; `dbcheck` scans `information_schema` for one and names its three
exceptions individually. `v_balance_definition_drift` holds
`ledger_availability()`'s hold terms equal to `v_hold_state`'s own answer.
`v_hold_drift` holds the memo book equal to the fold over the card events.
Those invariants are real and they have caught real bugs.

They are also all the same shape: **one derivation held equal to another
derivation, inside the same database, in the same language.** That is a weaker
claim than it looks, and this codebase has catalogued the failure mode
twenty-two times under its own name — *a guard computed from the same input as
the thing it guards cannot fail*. Two SQL bodies over the same rows, in the
same engine, with the same assumptions about what `now()` means, agree for
reasons that have nothing to do with the ledger being right.

So this is the strong form of the claim instead:

> **Throw the derived state away. Rebuild every number from the immutable facts
> alone, in a different language, in a different process, with no application
> code loaded. Then assert the rebuild is identical to what production
> reports.**

A reviewer who sees a from-scratch reconstruction agreeing with production
stops asking whether the ledger drifts, because drift would show up here as a
mismatch with an account id attached.

It is also the most honest answer to *"can you explain this system"*. A rebuild
is an executable specification of what every stored number means. If you want
to know what `available_cents` is, the answer is `availability()` in
`scripts/rebuild.mjs`: forty lines, no SQL, four named decisions.

---

## 2. What it consults, and what it refuses to consult

The rule is one line: **consult the schema for a FACT, never for a
DERIVATION.**

Consulting the database for an account's normal side would be fine if
`normal_side` were a fact. It is a `GENERATED ALWAYS` column, which makes it a
derivation, so the script reads `account.type` and computes the sign itself.
Consulting `book_date()` for the business day of an instant would be asking
Postgres to apply a rule; the script reads `book_tz()` — a configuration
constant — and derives the civil date with `Intl`.

### Facts it reads

| Table | Columns |
| --- | --- |
| `account` | `id, entity_id, code, name, type, book, business_id` |
| `journal_entry` | `id, value_date, booking_seq, entity_id, book, entry_type, hold_id, description, external_ref, rail, reverses_entry_id, correction_group_id` |
| `journal_line` | `entry_id, ordinal, account_id, amount_cents, currency, value_date, booking_seq` |
| `hold` | `id, account_id, memo_account_id, kind, value_date, expires_at, available_at` |
| `hold_closure` | `hold_id` |
| `hold_closure_reversal` | `hold_id` |
| `card_authorization` | `id, hold_id, provider, provider_auth_id, expires_at` |
| `card_auth_event` | `auth_id, kind, amount_cents, is_final, provider_event_id, received_at` |
| `webhook_inbox` | `id, provider_event_id, payload` — the raw provider payload |
| `statement` | the published artefact rows, as the thing to check against |
| `book_day`, `business` | which days are closed; names for the report |
| `book_tz()` | the book's timezone |

No aggregate, no `CASE`, no predicate that encodes a rule. Every row above
comes back raw and every fold happens in JavaScript.

### Derivations it re-expresses

| Derivation | Production body it does **not** call |
| --- | --- |
| `normal_side` from `account.type` | the `GENERATED` column |
| the business day of an instant | `book_date()` |
| the settled ledger balance | `ledger_settled_cents()` |
| `A(E)`, `C(E)`, `closed(E)`, `H(E)` | `v_card_auth_state`, `v_card_auth_hold` |
| a hold's memo balance | `v_hold_state` |
| the release predicate — **both flavours** | `v_hold_state` and `ledger_availability()` |
| the five availability terms | `ledger_availability()`, `v_available_balance` |
| the trial balance | `v_trial_balance` |
| a statement's canonical form and its sha256 | `src/lib/statements/render.ts` |

`scripts/rebuild.mjs` imports `postgres` and `node:crypto` and **nothing
else**. It does not import one line of `src/`. Importing
`balance-definitions.ts` would be asking the same code the same question, which
is the exact failure the script exists to rule out.

### The point in the two clocks

A balance question has three arguments — which business day, which booking
watermark, which instant — so the comparison pins all three, once, and both
sides answer at the same point:

```
asOf      now()                        the transaction's START, so it does not
                                       move under the run. It is ALSO the exact
                                       instant v_hold_state and v_card_auth_hold
                                       evaluate their release predicates at,
                                       because they call now() too.
valueDate book_date(asOf)              re-derived from book_tz()
watermark MAX(booking_seq) visible     in this snapshot
```

Everything runs inside

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
```

as `corgi_app`. `READ ONLY` means Postgres refuses any write this file could
contain, on top of a role that holds no `UPDATE` or `DELETE` on a money table
anyway. `REPEATABLE READ` means every read comes from one MVCC snapshot, which
matters as much: twelve agents write this repo concurrently and the book moves
while the script runs. Without a fixed snapshot a "mismatch" could simply be
two reads taken either side of a posting — and a proof that reports races as
drift is worse than no proof.

`v_available_balance` is deliberately **not** one of the things compared: it
pins itself to `clock_timestamp()`, which moves inside a transaction, so it
answers a question about a slightly different instant every time it is read.
Its entire body is `ledger_availability()` at the live point, and that function
*is* compared, at a point this script controls.

---

## 3. The fourteen checks

Measured **2026-09-11T09:12:26Z**, value date `2026-09-11`, watermark
`booking_seq <= 3797`, against the live Neon database as `corgi_app`.

| # | Check | Scope | Result |
| --- | --- | --- | --- |
| 1 | value date re-derived from `book_tz()` | `America/New_York` → `2026-09-11` | OK |
| 2 | `normal_side` re-derived from `account.type` | 53 accounts | OK |
| 3 | `journal_line`'s denormalised clocks match their entry | 7,187 lines | OK |
| 4 | every entry sums to zero, per currency | 3,591 entries | OK |
| 5 | every line sits in its entry's book | 3,591 entries | OK |
| 6 | **settled ledger balance** vs `ledger_settled_cents()` | 53 accounts | OK |
| 7 | `hold.expires_at` agrees with its authorisation's | 632 authorisations | **9 findings** |
| 8 | **H(E)** folded from the event set vs `v_card_auth_hold` | 632 authorisations | OK |
| 9 | **hold memo balance and release** vs `v_hold_state` | 718 holds | OK |
| 10 | a released hold holds nothing | 718 holds | OK |
| 11 | **available balance and all five terms** vs `ledger_availability()` | 7 deposit accounts | OK |
| 12 | **trial balance**, per entity and per book | 2 groups | OK |
| 13 | **statement content hash**, re-rendered from the journal | 60 statements, 60 on a closed day | OK |
| 14 | every settled Lithic delivery is present in the book | 600 deliveries, 877 event tokens | OK |

**Wall clock 2.5 s**, of which most is six round trips to Neon. 3,591 entries,
7,187 lines, 718 holds, 632 authorisations and 1,213 card events folded, and 60
statements re-rendered and re-hashed.

Check 8 is the one worth reading the code for. `H(E) = 0 if closed(E) else
max(A(E) − C(E), 0)` is a pure function of a set, and re-expressing it is a
page of JavaScript with no `previous state` argument anywhere in it — which is
the entire out-of-order story. Σ, ∃ and `max` are permutation-invariant, so a
settlement arriving before its authorisation is not a case to handle; it is the
same set assembled in a different order, and a function of a set cannot tell
the difference.

Check 9 is subtler and is the reason this script re-expresses the release
predicate **twice**. `v_hold_state` and `ledger_availability()` are genuinely
different bodies: one evaluates at `now()`, the other at a parameter; one reads
`card_authorization.expires_at`, the other reads `hold.expires_at`; one folds
every card event, the other folds only those received by its instant.
Collapsing them into one JavaScript function would have hidden a difference
between them instead of finding one. It found one.

### Rebuilt, and agreeing with production, at that instant

| Business | ledger | holds | uncleared | committed out | **available** |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hold Fuzzer Fixture Co. | $521,036.91 | $7,633.20 | $5,000.00 | $0.00 | **$508,403.71** |
| Holds Integration Fixture Co. | $144,196.35 | $2,852.00 | $1,250.00 | $0.00 | **$140,094.35** |
| Kettle & Crumb Bakery LLC | $38,394.23 | $370.00 | $47,000.00 | $0.00 | **−$8,975.77** |
| Live Fire — attack 3 (bitemporal) | $3,004.50 | $0.00 | $0.00 | $0.00 | **$3,004.50** |
| Live Fire — attack 7 (provider outage) | $0.00 | $0.00 | $0.00 | $0.00 | **$0.00** |
| Pots Integration Fixture Co. | $25,000.92 | $0.00 | $0.00 | $0.00 | **$25,000.92** |
| Ridgeline Robotics, Inc. | $52,371.09 | $410.00 | $30,210.50 | $2,250.00 | **$19,500.59** |

Kettle & Crumb is negative and stays negative: $47,000.00 of inbound credits
are inside their funds-availability window against $38,394.23 settled. It is
not clamped, for the reason it has never been clamped — hiding an overdraft
behind a cosmetic floor loses money.

The figures move between runs, because the book moves. The *agreement* does
not.

---

## 4. The finding

**Nine holds carry an `expires_at` that differs from their own authorisation's,
by 135–158 ms.**

```
hold 36a36a47-f8b5-43b5-a508-e19bfd7b7ecd  auth 4a972301-1fa6-443b-b9d5-32c3d79cea84  +135.502 ms
hold 62d65e62-0936-4693-bfbf-4cacda480d9a  auth ca1fc485-24b1-4fd8-a40a-9304a08803e7  +136.830 ms
hold 9a95a564-9793-4ca8-99c3-6a923f677be7  auth a0d558aa-11eb-479c-b117-dd4877e8308c  +144.395 ms
hold 619da0df-8ba6-470a-b5e7-3d4b56ced7c0  auth dc14386c-a08b-4b67-9710-afd5f1543037  +140.552 ms
hold 95bf0c0a-0a9b-4b5d-942b-ea23866e836a  auth 3aa1dc44-620e-46a0-98ed-2b921aa88deb  +148.856 ms
hold 8c24d59f-2337-4d5b-b747-c382df4937d9  auth 80fde47f-3dc9-4655-a7d5-c19779564638  +157.832 ms
hold 715f7471-deef-4d20-b481-ee981ae71f6b  auth ad5fa9e8-1834-4c9b-804b-36002e951ea2  +148.924 ms
hold 70bf2f39-fb05-45be-8cad-dbccde476397  auth c5e5ca6e-c678-4857-9c0f-426aa10af866  +151.392 ms
hold 25d3bdf6-e551-4aa3-95e5-20e96b145460  auth 5a8fc6d4-0844-4116-ad04-046f13b93aea  +149.404 ms
```

**Why it matters at all.** Two production bodies evaluate the same card model
and they read the expiry from two different tables:

* `v_card_auth_hold.is_closed` uses `now() >= card_authorization.expires_at`
* `ledger_availability()` uses `p_as_of >= hold.expires_at`

So for the gap between the two timestamps — seven days from now, for about a
seventh of a second — those two bodies disagree about whether the hold has
expired. `v_balance_definition_drift` would report it, and nothing repairs what
that view reports.

**What it is not.** The production writer cannot produce this.
`ensureAuthorization()` in `src/lib/holds/store.ts` takes one `expiresAt`
argument and passes the same `args.expiresAt.toISOString()` into both inserts,
so the two rows are written from a single clock read. All nine offenders carry
external refs of the form `lithic:team-test-…` and `lithic:completion-…-bypass`
— test fixtures that bypass `ensureAuthorization()` and write the two rows with
two separate `now() + interval '7 days'` expressions in two separate
statements. The 135–158 ms is the round trip between them.

**What it costs today: nothing.** All nine are closed, released, and holding
$0.00 — every one has two events and `is_closed` is already true, so neither
predicate is reading the expiry at all any more. The exposure is exactly zero
cents and will stay zero.

**Why it is still worth writing down.** The invariant "a hold and its
authorisation expire at the same instant" is a *convention held inside one
function*, not a constraint. There is no foreign key, no `CHECK`, and no view
asserting it. A fixture proved it is writable, and a fixture is only a fixture
until a rail adapter does the same thing. The one-line fix is a view in the
`v_hold_drift` family:

```sql
CREATE VIEW v_hold_expiry_drift AS
SELECT h.id AS hold_id, ca.id AS auth_id, h.expires_at, ca.expires_at AS auth_expires_at
  FROM hold h JOIN card_authorization ca ON ca.hold_id = h.id
 WHERE h.expires_at IS DISTINCT FROM ca.expires_at;
```

It would be non-empty today with these nine rows, which is the correct
behaviour: an invariant view that starts non-empty is a bill, not a licence.
That is a migration this worker was not scoped to write, and writing one to
make a finding disappear would be the wrong instinct anyway.

**Also observed, and already known.** Three `webhook_inbox` rows — all `done`,
all received in a two-minute window on 2026-09-10T16:23Z — store their payload
double-encoded, because a bare `::jsonb` cast makes the driver send a
JSON-typed parameter and Postgres quotes it a second time. `payload->>'token'`
reads nothing on those rows. This is the bug `docs/ARCHITECTURE.md` §5 already
records and the posting path was fixed to `::text::jsonb`; the rows written
before the fix stayed, because nothing in this system rewrites a row. Check 14
decodes them rather than skipping them, and once decoded both real payloads
name an authorisation the book already holds. **No ledger consequence.**

---

## 5. What this does NOT prove

This section is the reason the rest of the document is worth anything. A proof
that will not say where it stops is an advertisement.

### It cannot detect a row that was never written.

This is the big one and there is no clever way around it. The rebuild folds the
same rows production folds. If a fact never became a row, the rebuild is
missing exactly the fact production is missing, and the two agree perfectly
about a book that is wrong.

Concretely, **none** of these would show up as a mismatch:

* a Lithic webhook that never reached the endpoint at all
* a delivery the signature verifier rejected
* a consumer that decided an event was irrelevant and posted nothing
* an authorisation that expired without anyone hearing about it
* money that moved at the provider and was never reported

Check 14 reaches one edge of that gap and no further. It reads the raw
`webhook_inbox` payload — a source outside the ledger — and asserts that every
delivery the dispatcher marked `done` left a trace: the transaction token names
a `card_authorization`, and every event token inside it names a
`card_auth_event`. 600 deliveries, 877 event tokens, all present. That catches
"we accepted it and then dropped it on the floor". It cannot catch "it never
arrived", because nothing in this database knows about a webhook that was never
delivered. **Detecting that needs the provider's own list, which is
reconciliation** — `scripts/reconcile-usdc.mjs`, the scheme-file recon run, and
`docs/RECON.md` — and reconciliation is a different proof from this one. They
are complements, not substitutes.

### Check 14 proves presence, not correctness.

It asserts the rows exist. It does **not** assert that a `CLEARING` in the
payload became a `clearing` of the right magnitude on the right authorisation.
Doing that would mean re-implementing `src/lib/holds/lithic-events.ts` — 485
lines with real judgement in them: settlement-versus-event amount precedence,
`AUTHORIZATION_ADVICE` being absolute rather than incremental, `CLEARING`
polarity deciding refund versus capture. A second copy of a mapper with
judgement in it is not an independent check; it is a second thing to keep in
sync, which is the failure this whole script exists to avoid. The two event
types the adapter deliberately drops (`BALANCE_INQUIRY`,
`CREDIT_AUTHORIZATION`) are named in the script as a literal set, so quietly
adding a third would surface as a finding rather than as silence.

### It does not prove the definition is the right one.

It proves production computes the definition stated in `availability()` and
`holdModel()`. If that definition is wrong — if a future-dated debit should not
be subtracted, if manual holds should not count — then production and the
rebuild are wrong together, in step, and this script reports nothing. The
argument for the definition is in `docs/BALANCE-DEFINITIONS.md` §3 and it is a
judgement call about risk, not an arithmetic result. **Agreement is not
correctness.**

### Some checks are stronger than others, and they are not labelled in the output.

* **Strongest: the statement content hash (13).** `statement.content_hash` is a
  *stored* number, written once at publication and physically immutable
  afterwards. Re-deriving it from journal rows, in a different process, with an
  independently written canonical encoder, and getting the same 32 bytes is a
  claim about the past that nothing in the current code could have faked. All
  60 reproduce.
* **Strong: availability, H(E), the hold state (8, 9, 11).** Different
  language, different process, no application code loaded, arithmetic written
  from the definitions.
* **Weakest: the trial balance (12).** Both sides fold the same
  `amount_cents` column and the only difference is where the addition happens.
  It would catch a corrupted read path and essentially nothing else. It is in
  the list because the brief asks for it, and it is named here as weak because
  pretending otherwise would devalue the other thirteen.

### It does not verify the hash chain.

Each `journal_entry` carries a SHA-256 of its own content chained to its
predecessor, computed inside `ledger_append()`. That is the layer that detects
an operator holding the *owner* role — the one actor privileges and triggers
cannot bind. This script checks that the numbers derived from the rows are
right; it does not check that the rows themselves have not been substituted by
someone who could bypass every other layer. Those are different attacks and
they want different proofs.

### It is a point-in-time run, not a gate.

It is not wired into `pnpm test`, and deliberately: CI holds no database
credentials, which is the property that lets the ledger modules be imported by
a test with no secrets at all. This is an operator command you run in front of
someone, like `pnpm db:check`. It proves the book was consistent at the instant
in its header and makes no claim about the next posting.

### It compares against a function, not against the screens.

Check 11 calls `ledger_availability()` at a controlled snapshot. The screens
read `v_available_balance`, whose body is a call to that same function at
`clock_timestamp()`. So the chain is: rebuild → `ledger_availability()` → the
screens. If a *screen* subtracted something extra after reading the view, this
script would not see it. `src/lib/ledger/boundary.test.ts` is the control for
that — it fails if any module outside `src/lib/ledger/**` grows new raw SQL
against `journal_entry`, `journal_line` or `account`.

---

## 6. How to read a mismatch

The output prints the database's answer first and the rebuild's second, and
says so.

**A mismatch is not evidence that the rebuild is wrong.** The interesting
possibility is the other one. Before touching `rebuild.mjs`, take the id it
printed and ask the book directly:

```sql
-- the account, both ways
SELECT * FROM ledger_availability('<account>'::uuid, '<value date>'::date, <watermark>::bigint, now());
SELECT * FROM v_available_balance WHERE account_id = '<account>'::uuid;

-- the hold, and the events under it
SELECT * FROM v_hold_state     WHERE hold_id = '<hold>'::uuid;
SELECT * FROM v_card_auth_hold WHERE hold_id = '<hold>'::uuid;
SELECT kind, amount_cents, is_final, received_at, provider_event_id
  FROM card_auth_event ev JOIN card_authorization ca ON ca.id = ev.auth_id
 WHERE ca.hold_id = '<hold>'::uuid ORDER BY received_at;

-- and the invariants that should already have complained
SELECT * FROM v_balance_definition_drift;
SELECT * FROM v_hold_drift;
SELECT * FROM v_hold_release_drift;
```

The order matters. If `v_hold_drift` is non-empty too, the posting path is
wrong and the rebuild found it. If every invariant view is empty and only the
rebuild disagrees, then either the rebuild's arithmetic is wrong **or** the
invariant views and the production body share the assumption the rebuild
declined to share — which is the case they exist to be unable to catch, and the
whole reason this script is written in another language.

Whatever the answer: **report it, do not repair it.** There is no repair path
here and there should not be. `scripts/repair-0011-spurious-closures.mjs` and
its two siblings exist because three specific bugs wrote three specific wrong
rows, each with a migration explaining itself; they append corrections, they do
not overwrite. A rebuild that could fix what it found would be a cron job that
repairs a drifting balance, which is the thing the first line of the gauntlet
forbids.
