# Debrief preparation

75 minutes, and they drive for 65 of them. The failing condition is code you
cannot explain when someone points at it. This document is the 30-minute
version of the whole build: the five ideas everything else hangs off, a file
tour, the questions a hostile expert actually asks with answers that cite a
file, the weak spots said out loud before they are found, the findings to
volunteer, the one pattern this build taught that generalises, and a ten-minute
demo.

Rules for the room, in order of how much they help:

1. **Answer with the file.** "That is `src/lib/holds/model.ts`, the fold is
   about forty lines down" beats a correct answer with no address.
2. **The database is the control; TypeScript is the translation.** Almost every
   "how do you stop X" question ends at a trigger, a unique index, a CHECK or a
   revoked privilege. Say which.
3. **A skip is not a pass.** Where something is unproven, say the sentence that
   names what is missing and the command that would prove it.
4. **If you do not know, say so and name the measurement.** Every good finding
   in this build came from measuring, and four bad ones came from assuming.

### If you have thirty minutes, read in this order

| Minutes | Read | Why |
| --- | --- | --- |
| 0–8 | **§1**, all five, out loud | These are the only things that must be recallable with no page in front of you. Everything in §2 and §3 is derivable from them. |
| 8–14 | **§4**, the framing sentence of each | The section that is rehearsal, not reference. Whichever weakness they find, you want to have said it first. |
| 14–19 | **§5**, the findings | Get 5.1, 5.2, 5.4 and 5.6 into the first fifteen minutes of the debrief. |
| 19–22 | **§6**, the nine guards | One table, one sentence. It is the only claim in here that generalises past this repo, so it is the one to be able to defend under push-back — and two of the nine are claims I made myself, in writing, about code that did not honour them. |
| 22–27 | **§7**, the click path | Walk it once in a browser while reading, so the numbers are familiar rather than surprising. |
| 27–30 | **§3.1, §3.5, §3.6** | The three questions most likely to be asked first and hardest. |

**§2 is reference, not reading.** It is one entry per module, ordered by the
path money takes; open it when they point at something. The appendix at the
bottom is the same thing as a one-line lookup table.

**Before the room:** run `node scripts/livefire.mjs`, `node scripts/coreloop.mjs`
and `pnpm db:check` against the final commit, load `/api/health`, and use those
numbers rather than any figure written down here — everything quoted in this
document was true when it was measured and some of it moves every time a webhook
lands. `node scripts/reconcile-usdc.mjs` takes ten seconds and is the one that
most usefully answers a question you cannot anticipate.

**The one structural thing that changed since the first draft of this document:**
§2 now runs to twenty-five entries because nine features landed in the last few
hours — the core loop as one command, provider-driven card corrections, standing
orders, Plaid funding, a live KYB registry with an operator review, pots, payee
confirmation, card controls inside the provider's timeout, and a second
stablecoin provider. Two of them **falsified claims this build had already made
in writing**, which is why §6 is now nine guards rather than five.

---

## 1. The five things to be able to say cold

### 1.1 A customer's deposit is our liability, so it is credit-normal — and the customer spending money is a DEBIT

When a business deposits $10,000 with us, our cash at the sponsor bank goes up
(debit, an asset) and our obligation to them goes up (credit, a liability). The
customer *having* money is the bank *owing* money. The operational consequence
is the one that matters: money leaving the customer's account is a **debit** to
their deposit account, because we now owe them less; money arriving is a credit.
That is why a bank statement shows deposits in the credit column — it is written
from the bank's side of the book. If a deposit account ever ends up
debit-normal, that is an overdraft, which is an asset of the bank, and we do not
auto-reclass it into an asset account in the journal because that emits reversing
entries every time a balance oscillates around zero; it is a reporting reclass in
`v_overdrawn_accounts`.

Where: `research/ledger/DESIGN.md` §2.1, `src/lib/ledger/chart.ts` (the chart of
accounts as data, with this in the file header as fact 1),
`db/migrations/0001_ledger.sql` account `2100 Customer deposits`, type
`liability`.

### 1.2 One signed column, so "the entry balances" and "the account balance" are the same SUM

`journal_line.amount_cents` is a signed `bigint`: **a debit is positive, a credit
is negative**, and there is no direction enum and no magnitude column. The payoff
is that two of the three hardest invariants in the system collapse into one
aggregate — "this entry balances" is `SUM(amount_cents) = 0` and "this account's
balance" is `SUM(amount_cents)`, multiplied by the account's `normal_side`
(+1 debit-normal, −1 credit-normal) only at the point a human reads it. No `CASE`
in any hot query, and one place where the two conventions meet. The price is that
a raw line reads `-5000` for a $50 credit, and the views translate.

Where: `db/migrations/0001_ledger.sql` — `journal_line.amount_cents bigint NOT
NULL CHECK (amount_cents <> 0)`, `account.normal_side` as a `GENERATED ALWAYS AS
... STORED` column, `v_ledger_balance`. `research/ledger/DESIGN.md` §2.2.

### 1.3 The hold is a pure function of the event set, so arrival order is not a case

    A(E) = Σ authorisations and incrementals − Σ authorisation reversals
    C(E) = Σ clearings and force posts
    closed(E) = isFinal ∨ close/expiry ∨ now ≥ expiresAt ∨ (E ≠ ∅ ∧ A ≤ 0)
    H(E) = 0 if closed(E) else max(A(E) − C(E), 0)

`H` is built out of Σ, ∃, max and one clock comparison over a **set**. Every one
of those is invariant under permutation, so a settlement that arrives before its
own authorisation is not a case to handle — it is the same set assembled in a
different order, and a function of a set cannot tell the difference. There is no
status column on `card_authorization` for an arrival order to corrupt.
Deduplication is structural, not logical: `card_auth_event` is
`UNIQUE (auth_id, provider_event_id)`, so a redelivered webhook never enters `E`
at all.

Where: `src/lib/holds/model.ts` (`holdState`), `db/migrations/0001_ledger.sql`
views `v_card_auth_state` and `v_card_auth_hold` — the SQL is authoritative, the
TypeScript is the readable copy, and `v_hold_drift` holds them equal.
`research/ledger/DESIGN.md` §8.1 and the 19-row transition table in §8.3.

### 1.4 `value_date` and `booking_seq` are two independent axes

`value_date` is the business day the money belongs to. `booking_seq` is the
position at which we learned about it. Neither is derivable from the other, and
every as-of question is two predicates on one query: `value_date <= X` picks the
business days, `booking_seq <= Y` picks what we had learned by then. Fix the
booking axis and vary the value axis and you get statements; fix the value axis
and vary the booking axis and you get "what did we believe about Tuesday, as of
Wednesday" — the question most ledgers cannot answer at all. `booking_seq` and
not `booking_time` because NTP can step a wall clock backwards, and because the
sequence is drawn *while holding the append advisory lock*, so sequence order is
commit order and an as-of snapshot can never gain rows below its watermark later.

Where: `src/lib/ledger/balances.ts` — `ledgerBalanceAsOf` is one predicate,
`balanceAsBelieved` is both. `ledger_append()` in
`db/migrations/0001_ledger.sql`: `pg_advisory_xact_lock(hashtext('ledger_append:'
|| p_entity::text))` then `nextval('journal_booking_seq')`.
`research/ledger/DESIGN.md` §5, §5.3.

### 1.5 The application connects as a role that physically cannot express UPDATE

Not "does not" — **cannot**. `src/lib/ledger/db.ts` opens exactly one handle, on
`APP_DATABASE_URL`, as `corgi_app`, which holds `SELECT, INSERT` on the money
tables and nothing else. The owner URL (`DIRECT_URL`) is used only by
`scripts/migrate.mjs` and `scripts/seed.mjs` from a terminal and is never
imported into the app. Immutability is four layers deep — privileges first,
`BEFORE UPDATE/DELETE/TRUNCATE` triggers second (they catch a future migration or
a human in psql, where privileges do not bind), "no `ON CONFLICT DO UPDATE` on a
money table" third, the hash chain fourth. The interesting part is how the gap
was found: the `REVOKE` was correct from hour one and worth nothing at runtime,
because the app was connecting as `neondb_owner` and privileges never bind a
table owner. `pnpm db:check` reported 9 failures of 14 the first time it ran.

Where: `src/lib/ledger/db.ts` (file header), `db/migrations/0001_ledger.sql` §13,
`scripts/dbcheck.mjs`, `DECISIONS.md` 008.

---

## 2. "Point at any file" — a guided tour

Each entry: what it is, the decision inside it a reviewer would question, and the
answer.

### 2.1 The ledger schema — `db/migrations/0001_ledger.sql` (1,187 lines)

Tables, the four immutability layers, `ledger_append()`, and every derived view.
Every money write in the system goes through one `SECURITY DEFINER` function
which takes the append lock, draws `booking_seq`, forces `booking_time` monotonic
(`GREATEST(clock_timestamp(), last + 1µs)`), extends a SHA-256 hash chain, and
writes the denormalised clocks onto the lines.

**Questioned:** *"You denormalised `value_date` and `booking_seq` onto
`journal_line`. That is a cache."*
**Answer:** normally yes, and it is safe here for a specific reason: the source
row is immutable, so there is no update path that could change one and not the
other. It buys a single-table index-only scan for every balance query
(`journal_line_balance_idx ... INCLUDE (amount_cents)`), it is written only by
`ledger_append()`, and `v_line_denorm_drift` is an invariant view that must
return zero rows. A cache whose inputs cannot change is memoisation of a pure
function; a stored balance whose inputs are mutable always drifts.

**Also worth knowing:** the balanced-entry check is a `DEFERRABLE INITIALLY
DEFERRED` constraint trigger, because lines are inserted one at a time and a
non-deferred trigger would fire after the first line and always fail. There is a
mirror trigger from the entry side for the "entry with no lines" case, which the
line-side trigger by construction cannot see.

### 2.2 The posting API — `src/lib/ledger/post.ts`

`postEntry()` is the only caller of `ledger_append()` in the codebase, and
`reverseAndRebook()` is the correction path: reverse at the **original's**
value_date, then re-book, both sharing a `correction_group_id`.

**Questioned:** *"Why is `postEntry` a thin wrapper? Just write the SQL where you
need it."*
**Answer:** because every guarantee that makes this ledger trustworthy lives
inside `ledger_append()` under the advisory lock, and `corgi_app` legitimately
holds `INSERT` — so a caller writing its own INSERT would get none of them and
the database would not stop it. The discipline is enforced by there being one
module that calls it. Note also the two paid-for bugs in the file: bigint does
not survive `JSON.stringify` (send the decimal string), and the lines array goes
through the driver's `json()` helper, not a stringify-plus-`::jsonb`, which
double-encodes into a jsonb scalar.

### 2.3 Balances — `src/lib/ledger/balances.ts`, `src/lib/ledger/queries.ts`

`ledgerBalanceAsOf`, `balanceAsBelieved`, `bookingWatermarkAt`,
`availableBalance`, `trialBalanceCents`. All SUMs. `queries.ts` is the account
screen's three questions: what is this account, what is it worth, what happened
to it.

**Questioned:** *"`availableBalance` doesn't read `v_available_balance`. Two
implementations."*
**Answer:** it is one expression written twice at different scopes, and the
reason is the two silent-zero bugs recorded in the file header — the `hold` table
has no `business_id` (tenancy is reached through `hold.account_id`), and summing
*all* lines of a hold's memo entries always gives zero, because the balanced-entry
trigger applies to the memo book too and both legs cancel. The sum must be
restricted to `l.account_id = h.memo_account_id`. Both bugs produced a silent
zero rather than an error, and an availability query that under-reports a hold
frees money that is still authorised.

**Also:** `availableCents` is allowed to go negative, deliberately. An
over-captured fuel-pump authorisation settles above the amount authorised and the
honest answer is that the customer is overdrawn; clamping hides a real overdraft
behind a cosmetic floor.

### 2.4 The chart of accounts — `src/lib/ledger/chart.ts`

Pure data plus pure functions, no I/O. `scripts/seed.mjs` imports it directly, so
the chart the database gets and the chart the application reasons about are the
same array.

**Questioned:** *"Why two books in one journal?"*
**Answer:** every account carries `book ∈ {financial, memo}`. Holds live in the
9xxx memo subtree so available balance is derivable as `ledger − active holds`
without a single hold posting polluting the financial trial balance. An entry may
not mix books (trigger-enforced), so each book independently sums to zero. Key
codes to have on the tip of your tongue: `2100` customer deposits, `2200` card
network settlement payable, `2300` ACH payable, `1130` ACH receivable, `1140`
USDC wallet, `9100` card-auth holds, `9900` memo contra, `2900` rounding residual.

### 2.5 Holds — `src/lib/holds/model.ts`, `apply.ts`, `expiry.ts`, `store.ts`, `lithic-events.ts`, `db/migrations/0008_holds.sql`

`model.ts` is `H(E)` as a pure function. `apply.ts` is the seven-step processing
path. `lithic-events.ts` maps Lithic's vocabulary to ours. `expiry.ts` is the
seven-day sweep. `0008` adds the three things `0001` lacked, each proven by the
statement that failed against the live database.

**Questioned:** *"What is `terminallyClosed` and why is there a second closure
predicate?"*
**Answer:** it is one case, and it is real. A settlement that beats its
authorisation creates an event set `{clearing 3000}` where `A = 0`, which
satisfies `A ≤ 0`, which makes `closed` true. Harmless for `H` — it is 0 either
way. But `hold_closure` is append-only with `PRIMARY KEY (hold_id)`, so a closure
row written on the strength of it could never be undone by the authorisation
about to arrive, and availability reads that row: the customer would spend money
they no longer have. `A ≤ 0` is only terminal once there is something to have
reversed, which is exactly what `sawAuthorisation` distinguishes. `apply.ts`
writes closures on `terminallyClosed`, never on `closed`.

**Questioned:** *"Why does `0008` create a `lock_card_authorization()` function
instead of just locking the row?"*
**Answer:** Postgres requires the `UPDATE` privilege for `SELECT ... FOR UPDATE`,
and the whole point of this ledger is that the application does not hold `UPDATE`
on a money table. Granting it to buy a mutual-exclusion primitive would trade the
immutability guarantee for a lock. So the lock is taken by a `SECURITY DEFINER`
function whose entire surface is one uuid in, one boolean out — it cannot read a
money row, cannot write anything, and cannot be coaxed into locking a different
table. It runs in the caller's transaction, so it is exactly the lock DESIGN §9
step 3 specifies.

**Questioned:** *"Advice events override the authorised amount, but you sum. That
is a bug."*
**Answer:** `AUTHORIZATION_ADVICE` is absolute (1000 → 1500 arrives as
`amount: 1500`), and our stored model sums because `v_card_auth_state` sums and
the memo book must agree with it or `v_hold_drift` reports. So `lithic-events.ts`
converts the advice into the delta that produces its absolute figure, using the
events preceding it *in the same payload*. That is still a function of the
payload alone, because Lithic's `events[]` is append-only: an event preceding the
advice can never appear in a later delivery than the advice does, so the running
total at the advice is identical in every payload containing it, and the derived
delta carries the advice's own token so a redelivery deduplicates.

### 2.6 Webhook inbox — `src/lib/webhooks/inbox.ts`, `db/migrations/0002_webhook_inbox.sql`

Verify the raw bytes, persist, return. `ingestWebhook()` never processes
anything, never touches the ledger, and never awaits a consumer — there is
nothing in the file that *could*.

**Questioned:** *"You store both `payload` (jsonb) and `raw_body` (text). That is
the same data twice."*
**Answer:** it is not. The provider signs the bytes it sent, and
`JSON.parse` then `JSON.stringify` is not the identity function — one space of
whitespace is a different signature. `raw_body` is what verification ran over and
what lets a signature be re-checked years later; `payload` is what you query. The
headers column is an **allowlist** of signature-bearing headers only, never
`Authorization` and never cookies, because this row is kept for years and must
not become a credential store.

**Questioned:** *"Why is `attempts` incremented on claim rather than on
failure?"*
**Answer:** so that a worker that dies mid-event still spends an attempt and a
poison event cannot loop forever. Parks are counted separately
(`park_attempts`), and the retry budget is `attempts − park_attempts`, because a
park is not a failure. The constraint `park_attempts <= attempts` keeps that
subtraction meaningful.

**Have ready:** the three production-only bugs (`DECISIONS.md` 020) — Postgres
deducing inconsistent types for a reused parameter, and `payload`/`headers`
landing as jsonb *strings* until they were cast `::text::jsonb`. None could be
caught by a test, because the in-memory store never parses SQL. Also: this file
contains a NUL byte, which made plain `grep` classify it as binary and silently
skip 1,206 lines — the reason the secret scanner now uses `grep -a`.

### 2.7 Dispatch and drain — `src/lib/webhooks/dispatch.ts`, `drain.ts`, `route-handler.ts`

`dispatchOnce()` claims a batch under a lease, hands each row to the consumer
registered for its provider, and interprets three answers: `processed`,
`ignored`, `parked`. `drain.ts` is what turns a stored delivery into money, with
three triggers chosen because each fails differently.

**Questioned:** *"Your dispatcher makes no ordering guarantee. Isn't that a
correctness problem?"*
**Answer:** it is deliberate — it makes no ordering promise **so that consumers
cannot come to depend on one**. Rows are claimed oldest-first because that is the
fairest queue discipline, not because anything relies on it, and correctness
comes from every consumer's effect being a function of a set. The loop is
sequential on purpose: these are money events, and a bounded one-at-a-time loop
is easier to reason about than a concurrency limiter, with batch size as the
throughput knob.

**Questioned:** *"Parking is a quarantine queue, and DESIGN §11 says you do not
have one."*
**Answer:** the distinction is that a park **names its referent**. The row goes
to state `parked` with `(parked_on_kind, parked_on_ref)` recorded — and the
migration's CHECK constraint refuses a park without one, because parking with no
referent is a queue nothing can drain. It is woken either by the fast path (a
later event reports producing that entity, and one UPDATE wakes everything
waiting on it) or by a timed re-check, so a park is never load-bearing on another
event arriving. Eleven live rows are parked today and each is a card authorisation
on a Lithic card never registered to a customer here — the consumer will not guess
whose money to move.

**Questioned:** *"`after()` might not run."*
**Answer:** correct, and it is documented as a **nudge**, never the mechanism —
"something that *usually* runs is the worst kind of delivery, because it works
right up until the day it matters". The guarantee is the cron; the demo is the
bearer-token POST. The inbox row is durable before any of the three runs, so
losing all three loses latency and cannot lose money. See §4.5 for the honest
limit on the cron.

**Route handler:** the load-bearing property is that the whole handler body is
one `await ingestWebhook(...)`, which reads `req.text()` first. Because the
request body is a one-shot stream, nothing downstream *can* re-read or
re-serialise it. That is enforced by there being exactly one call and the body
being gone afterwards, not by a comment; `route-handler.test.ts` asserts it with
a request whose `json()` throws.

### 2.8 Reconciliation — `db/migrations/0006_recon.sql`, `src/lib/recon/{parse,ingest,diff,aging,run,screen}.ts`

Import a settlement file, diff it against the journal on the provider's own
reference, classify every disagreement into exactly three categories, age them by
day closes. The diff itself is SQL (`v_recon_pair`, `v_recon_break`) with **no
second implementation in TypeScript**, so the live screen and the frozen audit
trail cannot drift.

**Questioned:** *"Real reconcilers fall back to amount + date. Your match rate is
artificially bad."*
**Answer:** and deliberately so. A same-amount, same-day heuristic pairs two
$40.00 coffee settlements at random, both "match", and a screen that should show
two breaks shows none. The failure is silent and — because `recon_match` is
append-only — permanent. `recon_match.match_rule` in `0001` admits a `'heuristic'`
value and nothing in this build writes it (`src/lib/recon/diff.ts`, file header).

**Questioned:** *"Why doesn't the diff read `recon_match`?"*
**Answer:** this is the flaw the recon build found in my own design draft
(`DECISIONS.md` 014). `recon_match` is UNIQUE on `entry_id`, so an entry paired
against last night's file could never pair again — and a diff driven by that
table would report a re-issued file as **perfect** while a deleted row silently
vanished. That is exactly the published attack. Pairing is therefore re-derived
from references on every run, and `recon_match` keeps its `0001` job: append-only
evidence of the first pairing, carrying both amounts as at that moment. Evidence
of what we concluded is not the same object as the conclusion.

**Questioned:** *"Aging in day closes is unusual."*
**Answer:** `closes_crossed` counts `book_day` rows closed at or after the
break's value date. "Open across a day close" means somebody signed off a
business day with the break outstanding, which is a categorically different
failure from "24 hours old", and a break does not get younger because the nightly
job ran late. Severity is **policy** and lives in one place in TypeScript
(`src/lib/recon/aging.ts`, unit-tested with no database), not in a `CASE` in SQL
and a mirror of it in code.

**One more, if it comes up:** `in_ledger_not_file` excludes correction groups
that net to zero. An entry booked and then reversed is agreement with a file that
never mentioned it, not a break — and reporting it would train the ops team to
ignore the screen.

### 2.9 Approvals — `db/migrations/0001_ledger.sql` §12, `0007_approvals.sql`, `src/lib/approvals/*`

Maker-checker on money out. `payment_instruction` is the request,
`payment_instruction_event` its append-only lifecycle,
`assert_maker_checker()` and `assert_payment_lifecycle()` the two triggers.

**Questioned:** *"There is no self-approval check in `approvePayment()`. Why
would you not defend in depth?"*
**Answer:** the standing instruction is at the top of
`src/lib/approvals/decide.ts`: there is no
`if (approverId === instruction.requestedBy)` and there must never be one. Three
reasons. A guard here would be a second copy of the rule, and two copies drift —
the MCP tool, a batch importer and a support script would each need their own. A
control exercised only on the happy path is not a control; routing every approval
through the trigger means the refusal is exercised by every approval the system
ever performs. And `approvals.integration.test.ts` asserts the **database**
refuses it against live Neon — if the rule lived in TypeScript, the test would be
asserting the behaviour of the thing it is testing. `src/lib/approvals/gate.ts`
carries the mirror disclaimer in capitals: it is a legibility layer, not the
control, and if the two ever disagree the database wins.

**Questioned:** *"Why hash the payment rather than approve a row id?"*
**Answer:** "Dana approved instruction 9f3a…" is worth nothing on its own.
`content_hash` is sha256 over (account, rail, amount, counterparty, value_date),
and an `approved` event must cite that exact hash or the trigger raises. Changing
any of those five fields means a new instruction row — the table is append-only —
so a stale approval is not "overridden" by any code, it simply does not apply.
"Approve $100 and submit $10,000" has no representation.

**Questioned:** *"`0007` says there is no unique index on the release. What stops
a double release?"*
**Answer:** the index cannot be written in that file — the planner resolves an
index predicate immediately and rejects a brand-new enum label, and the
`kind::text` workaround is refused because an index predicate must be IMMUTABLE.
Both were tried against the live database. It is not needed, because the
guarantee is stronger and elsewhere: releasing posts through `ledger_append()`
with `payment:release:<instruction id>`, derived from the instruction and nothing
else, so two concurrent releases produce one journal entry decided by
`journal_entry.idempotency_key` under the append lock. `release.ts` does the
posting and the `released` event in **one** `sql.begin()`, so a refused event
rolls the posting back with it — there is no window where money has moved and no
event says so.

### 2.10 Statements — `db/migrations/0009_statements.sql`, `src/lib/statements/{render,publish,read,compare}.ts`

A statement is a **(period, booking watermark) pair, not a period**. v1 of
Tuesday is frozen at Tuesday's close watermark and reproduces byte-identically
forever; Thursday's correction produces Tuesday **v2** at a later watermark, and
both are kept.

**Questioned:** *"You said no stored balances, and `statement` stores opening and
closing balance."*
**Answer:** this is the one deliberate exemption and `scripts/dbcheck.mjs`
excludes it **by name with the reasoning in a comment** so a reader sees the hole
and its justification together. A statement is a *published artefact*: the figure
it asserted must remain queryable forever exactly as published, even after a
later correction changes what the ledger now says that day was. That is the
as-published axis of the bitemporal model, not a drifting cache.

**Questioned:** *"How do you know your hash means anything?"*
**Answer:** the preimage is exactly four inputs — format version, account,
period, booking watermark — and every field is length-prefixed
(`<utf8 byte length>:<value>`) rather than delimiter-joined, because
`description` and `external_ref` are free text from a provider and a delimiter
admits a preimage ambiguity. `statement.id`, `version` and `generated_at` are
deliberately *not* in the preimage: a document is identified by what it says, not
by the row that stores it, and including them would make re-rendering incapable
of reproducing a published hash. `STATEMENT_FORMAT` is the first field so a
renderer change is loud rather than silent — and `0009` adds a renderer-version
column so "the ledger was tampered with" and "you deployed a new formatter" are
distinguishable.

**Note for the room:** the README, `docs/CUT-LIST.md` §3 item 4 and
`src/test/livefire/README.md` all say there is no statement renderer. That was
true when they were written and stopped being true a little over an hour later.
The screen is at `/statements` and it is in the nav; the docs are stale in the
*under*-claiming direction. Say so before they find it.

### 2.11 The agent surface — `src/lib/mcp/*`, `src/app/api/mcp/route.ts`, `docs/MCP.md`, `docs/AGENT-LIMITS.md`

`POST /api/mcp`, Model Context Protocol over Streamable HTTP, eight tools:
`get_balance`, `list_transactions`, `list_recon_breaks` read; `initiate_payment`
queues a request a person must work through.

**Questioned:** *"An agent that can move money is the whole risk. What stops
it?"*
**Answer:** four things, in the order they hold. (1) The tool does not exist —
`src/lib/mcp/tools.ts` is a closed list of four, `src/lib/mcp/approvals-port.ts`
exposes only `queuePayment` with a written "must never grow" list, and the MCP
module does not import `ledger/post.ts`, `approvals/decide.ts` or
`approvals/release.ts`, so there is no code path to reach by mistake. (2) The
token carries the scope: a grant names exactly one `business_id` and one
`actor_id`, and `FORBIDDEN_PARAMETER_NAMES` in `tools.ts` is the tenant boundary
written as data — no tool may declare a `business_id`, `account_id`, `actor_id`
(etc.) parameter, and `tools.test.ts` walks every registered schema recursively
and fails the build if one appears. (3) The database has the last word:
`verifyActor()` in `auth.ts` refuses a grant whose actor row is not
`kind = 'agent'` with `can_approve = false`, or whose business does not match.
(4) The `actor` CHECK `NOT (kind <> 'human' AND can_approve)` makes an approving
agent a row Postgres will not store, and `mcp.integration.test.ts` goes around
the application entirely, inserts the approval directly as this agent citing the
correct hash, and asserts SQLSTATE `42501`.

**Also refused, and worth knowing by name:** the pooled FBO house account `1110`
is unaddressable (`findAccount` filters `business_id = $1`, with the comment
saying *and not `OR business_id IS NULL`*); `card` and `internal` rails; a full
bank account number (only `account_number_last4`); an amount as a JSON number or
in dollars; a backdated value date; more than 90 days forward; an amount above
the token's ceiling; and a write budget of six per minute.

**Questioned:** *"Your entire multi-tenant boundary is a hand-written `WHERE
business_id = $1` in one TypeScript file. Where is row-level security?"*
**Answer — concede first.** RLS would be genuine defence in depth and it is not
there. What makes the hand-written boundary reviewable rather than hopeful is
that `businessId` is the **first parameter of every method on `interface
Gateway`** (`src/lib/mcp/types.ts`), so the scoping predicate is in the signature
of every query this surface can make and a reviewer checks the whole boundary by
reading one interface with one implementation. No argument can widen it, and that
is machine-checked rather than asserted. The predicate is pushed into SQL rather
than applied after the fetch, so there is no moment at which the process holds
another business's row in memory. And `mcp.integration.test.ts` runs the
identical call under two tokens against real rows and asserts business A's
account name appears nowhere in B's response. The boundary that matters for
*writes* is in the database already: the maker-checker trigger, the actor CHECK,
and `corgi_app` holding no UPDATE.

**Questioned:** *"Why is `initiate_payment` allowed to write at all?"*
**Answer:** the rule in `docs/AGENT-LIMITS.md` is: *an agent may state an
intention; it may not make a fact final, and it may not change the rules that
decide what is final.* The single test is "if this call were wrong, would a
person get to see it before the consequence?" For `initiate_payment` the answer
is yes by construction — its only consequence is that a row appears in a queue.
The tool's response also leads with the fact that no money has moved, because the
caller is usually a language model relaying to a person and "payment initiated"
gets repeated to a customer as "your payment has been sent".

**Volunteer the debatable ones** (they are already written down in
AGENT-LIMITS): freezing a card is safe-direction and arguably should be on the
surface; `internal` transfers are refused because the seeded policy is
zero-approval and that would make it the one rail that could move money
unattended; the surface is *stricter* than the bank's own below-threshold ACH
policy, which is defensible for a first release and not obviously right
permanently; and the rate limiter is per process, so across warm instances the
effective limit is instances × limit.

### 2.12 Rails — `src/lib/rails/types.ts`, `rails/{lithic,increase,achsim}`

One `PaymentRail` interface with four methods — `initiateCredit`,
`initiateDebit`, `getTransfer`, `parseEvent`. No ACH nouns at the top level:
routing numbers live inside one variant of a `Destination` union and SEC codes
are reached through an `AuthorizationKind` intent, because the caller knows how
the customer authorised the payment and does not know that Nacha exists.
`SEC_CODE_BY_AUTHORIZATION` in `rails/increase/client.ts` is the only table in
the repo that knows Nacha exists, and the simulator imports it *from* the live
adapter rather than copying it, so it cannot drift from the thing it simulates.

**Know the count before they count it.** Exactly **two** classes implement
`PaymentRail`: `IncreaseAchRail` and `AchSimRail`. Lithic is *not* one of them —
it is a function-style client plus the pure `normalizeTransaction()`, because a
card's economics are a hold that mutates over an event set and there is no
`initiateCredit` in that. USDC does not implement it either — it has its own
two-implementation interface, `StablecoinPayoutProvider` (§2.24), because a
payout that is named by a hash before it is broadcast is not the same shape as an
ACH transfer that is named by the provider afterwards. `internal` is a `RailKind`
with nothing behind it **at the rail layer** and it is no longer empty in the
ledger: a pot move posts `rail = 'internal'` and touches no adapter at all
(§2.21), which is the honest reading of "a rail is an adapter, not a schema".
Note also that two different types in this repo are called `PaymentRail` — the
adapter interface here, and a string union of rail names in
`src/lib/approvals/types.ts` — so ask which one they mean before answering. What
holds the interface
honest for the rails that do not implement it is `rails/types.test.ts`, which
carries `const _cardRail: PaymentRail = {…}` and a USDC equivalent as
**compile-time** stubs whose only job is to stop compiling if someone widens the
interface for ACH's benefit. Describe them as that, not as adapters.

**Questioned:** *"So your abstraction has been validated against ACH twice."*
**Answer:** correct, and the interface's job is narrower than "unify all rails" —
it is to keep one rail's vocabulary out of the top level, and it does that. What
it bought concretely: the ACH slot swaps live ↔ simulator with zero consumer
changes, and `achsim/rail.test.ts` runs the same out-of-order scenario in both
delivery orders and asserts the consumer lands in the same place. Forcing cards
behind those four methods would mean widening the interface, which is the one
thing `types.ts` forbids: *"widening this interface for one rail is how an
adapter rots back into a schema."*

**The simulator is worth volunteering, not hiding.** `achsim/` produces the seven
awkward cases a sandbox will not: delayed settlement, return-after-settlement,
return-before-settlement, a notification of change, a **settlement webhook
overtaking its own submission webhook**, a duplicate delivery with the same bytes
and signature, and a timed outage that queues webhooks into a catch-up burst. It
is deterministic (a virtual clock and a seeded PRNG; it imports neither
`Date.now()` nor `Math.random()`), and it cannot be mistaken for the live rail by
three independent means: `evidence: 'simulated'` written *after* the spread and
typed to the literal, a `"simulated": true` marker **inside the signed bytes**,
and `assertNotTheLiveSecret()`, which refuses at construction to be handed
`INCREASE_WEBHOOK_SECRET`. The out-of-order case is the subtle one and the code
says why: it holds the *submission* notification until 1 ms after the settlement
notification rather than moving settlement earlier, because "making settlement
itself arrive early would be time travel, not out-of-order delivery, and a
consumer that handled it would be handling something that cannot occur."

**Questioned:** *"Why is `parseEvent` async? Parsing should be pure."*
**Answer:** because on some rails the webhook is a *pointer*, not a payload.
Increase's body says only "ach_transfer_x changed", and the only way to learn how
is `getTransfer(x)`. That is a feature: the read-back reflects the latest state
whichever order the notifications arrived in, which makes out-of-order delivery
harmless. The interface also states that `parseEvent` **must never throw** on an
unrecognised payload — it returns `{ type: 'unknown' }`, because a throw becomes
a 5xx and a provider that collects enough 5xx responses disables the
subscription.

**Questioned:** *"There is no `verifyWebhook` on the rail interface."*
**Answer:** deliberate. Verification happens once, upstream, in the generic
Standard Webhooks verifier. Two workers independently implemented signature
verification early in the build — one generic, one Lithic-local — and the
Lithic-local copy was deleted rather than kept "just in case", because a
per-provider copy of a shared scheme is how the fifth provider ends up verified
differently from the first four (`DECISIONS.md` 007).

### 2.13 Integrations probe and health — `src/lib/integrations/probe.ts`, `delivery-health.ts`, `src/app/api/health/route.ts`

`probeIntegrations()` makes the cheapest authenticated call each provider offers
and returns one of five verdicts: `live`, `unauthorised`, `unreachable`,
`not_configured`, `unprobed`. Only `live` earns the LIVE label.
`delivery-health.ts` answers a *different* question — how long since this
provider last delivered anything — from `webhook_inbox.received_at`.

**Know the number before you quote it.** The endpoint now reads **7 of 7 live**:
`card_issuing`, `card_webhooks`, `director_kyc`, `business_registry`,
`open_banking`, `ach_rail`, `stablecoin`. The number has moved in both directions
during this build and each move was earned: `card_webhooks` went *down* to
`unprobed` when the fallback bug was fixed, then back up when it got a real
probe; `stablecoin` became live only when a payout confirmed on chain;
`business_registry` became live when the registry leg stopped being a simulator
and started reading GLEIF (§2.14) — and that last one needs its qualifier said in
the same breath, because GLEIF is a **substitution** for the three KYB vendors
the brief names, all of which are gated. Load `/api/health` on the day
and read its number, and if they notice a document disagreeing, that *is* the
answer: one fewer claimed integration is a better score on integration reality,
not a worse one, because the rubric grades honest labelling and the brief calls
presenting a simulated integration as live the fastest way to fail the trial.
`node scripts/audit-claims.mjs` is the mechanical version of that sentence — it
reads the endpoint and fails if any tracked Markdown file states a different
count or presents a simulated slot as live.

**Questioned:** *"`unreachable` isn't `live`, but it isn't a failure either. Why
does it read as SIMULATED?"*
**Answer:** the asymmetry is the whole point. Over-claiming is the automatic
fail; under-claiming is merely pessimistic. `unreachable` means we do not know,
and saying "live" on a hopeful guess is precisely the failure the brief names.
Same reasoning produced the `unprobed` verdict: a slot with no probe used to
inherit the env-derived status and reported `card_webhooks: live` with the
evidence string "no probe defined for this slot" — the 011 failure reintroduced
inside the module written to eliminate it (`DECISIONS.md` 026).

**Questioned:** *"Two health fields about the same provider. Which do I
believe?"*
**Answer:** both, because they answer different questions and the vocabularies
are **disjoint by construction**: liveness is `live | simulated | unauthorised |
unreachable | not_configured`, freshness is `fresh | stale | quiet | never |
unknown`. A provider can be live and stale at once and that is not a
contradiction — it is the outage the field exists to show. `delivery-health.ts`
is keyed by provider, never emits a `slot` or `status` field, and takes the probe
verdict as an *input* rather than recomputing it, because `/api/health` once
published two contradicting verdicts for the same slot and the fix was to stop
having two (`DECISIONS.md` 021,
`src/app/api/health/consistency.test.ts`).

**One caveat to own before they find it, and it got sharper today:**
`fromStatus()` in `probe.ts` maps a non-auth 4xx to `live`, on the reasoning that
being told the request was wrong proves the credential was accepted. That is the
one place a non-2xx earns LIVE, and it is deliberate — it is what makes the
parameterless `POST /v1/accounts` Stripe probe work at all, since a
Connect-enabled account answers with a parameter-validation 400.

**The reasoning does not hold for the whole range, and that is measurable.** A
**404** earns `live` under the same branch, and a 404 is the answer a provider
gives when nobody looked at your credential: measured just now against the live
sandbox, `GET /v1/not_a_real_endpoint` at Lithic answers **404 with the API key**
and **404 with no Authorization header at all**. So a mistyped path, or a
provider retiring an endpoint, would be reported as a live integration by a probe
that proved nothing — no active lie today, because every probe path is real and
`card_issuing` answers 200, but a latent one of exactly the shape §6 is about. A
**429** earns `live` too, and today `open_banking`'s evidence string is literally
`POST /institutions/get -> 429`: Plaid rate-limits per client, so the credential
*was* recognised and the verdict is defensible — but the slot's real work is not
fundable while it is throttled, which is the distinction §5.3's rule was written
to make. Week two is three lines: 404 and 429 get their own verdicts
(`unproven` / `throttled`), both labelled SIMULATED, neither collapsed into
`live`.

**Questioned — and this is the one to want:** *"`some`? So one live slot out of
two is enough to raise an alarm about the other."* The line is
`integrationLive: w.slots.some((s) => probedStatus.get(s.slot) === 'live')` in
`route.ts`, and the comment above it is long on purpose, because **the original
reason for it has expired and the decision survived**. It was `every` until
`DECISIONS.md` 028: Lithic owns `card_issuing` and `card_webhooks`,
`card_webhooks` had no probe and was honestly `unprobed`, so `every` was false
for ever, `degradesDeployment` could never be true, and no webhook outage could
move the top-level status — measured then, Lithic stale at 184s with `status:
"ok"`. `card_webhooks` now has a real probe and reads `live`, so that argument is
gone and `every` would work today.

**It is still wrong, and now for a measured reason.** `card_webhooks`'s probe
reads Lithic's *own* `/attempts` log, so its verdict is a **function of the
delivery loop's health** — it is not an independent witness. Feed
`judgeWebhookSubscription` the two degraded shapes this account has actually
produced and it returns not-live for both: a latest attempt of `FAILED 500`
(the real 16:18 incident — Lithic delivering, our endpoint refusing, deliveries
being *lost*) reads `unauthorised`, and an unreadable `/attempts` reads
`unreachable`. Replay this outage's own published facts through
`webhookDeliveryHealth` with `card_webhooks` forced not-live, same instant, same
threshold, only the gate changed:

    some  + card_webhooks not live -> degradesDeployment true,  degradedBy [lithic], degraded
    every + card_webhooks not live -> degradesDeployment false, degradedBy [],       "ok"

So **`every` is disarmed by the outage it exists to catch.** `some` is not
incidentally correct; it is the only one of the two that the failure cannot
silence, because no single slot's degradation reaches it. And it is the right
question anyway: the gate asks "do we have a working integration with this
provider whose silence would mean something", and one live slot answers it. An
`unprobed`, `unreachable` or `unauthorised` sibling is an absence of evidence
about one leg — and this system deliberately manufactures honest absences of
evidence, so an alarm that any of them can disarm is not an alarm.

`src/test/livefire/attack-07-provider-outage.test.ts` asserts both shapes rather
than only the live one, because both Lithic slots read `live` today so the live
escalation assertion would pass under `every` too and would say nothing about the
regression. See §6 — this is the fourth of the nine guards to fail this exact
way, and the `fromStatus()` caveat above is the ninth.

### 2.14 KYB — `src/lib/kyb/*`, `db/migrations/0005_kyb.sql`, `0013_kyb_manual_review.sql`

**This section was true this morning and is not any more.** The registry leg was
a labelled simulator; it now reads a real registry, and making it honest broke
the product before it fixed it. Both halves get told.

A composite of two legs: **director KYC** (live — Stripe Identity, which is on
the brief's own KYC menu) and **business registry** (live — GLEIF, which is
not). Four real endpoints against `api.gleif.org`, no credential, no mock in the
production path: `GET /api/v1/lei-records/{lei}`, `GET /api/v1/autocompletions`,
`GET /api/v1/lei-records?filter[entity.legalName]=…&filter[…country]=US`, and a
best-effort `GET /api/v1/registration-authorities/{code}` whose failure never
changes a verdict. Two candidate generators run concurrently and **neither
decides** — every candidate is re-matched in our own code — and if *both*
generators fail, `searchByName` throws rather than reporting a clean miss.

**Say the substitution out loud, first, in the same sentence as the word live.**
The brief names Persona KYB, Middesk and Sumsub. All three are gated behind a
sales conversation or a "verify your business" form, which was measured rather
than read off a support page. GLEIF is a real third party answering real
questions about real entities, and it is **not one of the three**: it is the
bottom of a precedence ladder every named vendor outranks, and two environment
variables move the leg the hour one becomes available. The slot label in
`/api/health` still reads `provider: "Stripe Connect (gated) — simulated"` from
`env.schema.ts` while its status reads `live` — under-claiming, safe direction,
and a contradiction on the page you will be showing, so name it before they read
it.

**Making it honest broke the core loop.** GLEIF's population is
financial-market participants, so every fictional business on this book answers
`not_in_lei_registry` → `needs_review`, and `canTransact()` (`kyb/types.ts:508`)
runs inside `requestPayment()`. Leg 5 of the core loop — an outbound payment
needing a second approver — was refused for every business on the book. Three
ways out, two disqualifying: weaken the gate (deletes the only sentence the
screen exists to make true), invent an LEI (put a real company's identifier on a
fictional business — the exact forgery this module is built against), or **review
it**, which is what a real KYB operation does with a registry miss.

**A review is another observation, not an edit.** It is an INSERT into
`kyb_verification_leg` like any other row; `corgi_app` holds `SELECT, INSERT` and
the grants are **restated** in 0013 because a table-level grant silently covers
new columns. The provider's row is never touched. The derived state is a view
(`v_business_kyb`) with no stored copy for an UPDATE to forge.

**The third evidence label, and the order that makes it free.** `live | manual |
simulated` is a **weakness** order, ascending — `EVIDENCE_WEAKNESS = { live: 0,
manual: 1, simulated: 2 }` — so `live` is strongest and the existing worst-wins
fold needed no special case. A human is not a third party, so an operator's
decision cannot be `live`; a named, accountable person with a written reason is
not a fixture either, so it cannot be `simulated`. The same order is the
declaration order of the `kyb_evidence` enum (`ALTER TYPE … ADD VALUE 'manual'
BEFORE 'simulated'`), which is what lets the view say `max(evidence)` — the
identical trick `kyb_status` already used for "strictest wins".

**The constraints that make the wrong thing unrepresentable.** `docs/KYB.md`
prints six; the migration adds **nine**, and the one the table omits is the one
that makes the headline constraint sound. In order: `actor_id_kind_uniq` (the
UNIQUE that gives the composite FK a target); `kyb_leg_reviewer_fk`, the
composite FK `(decided_by_actor_id, decided_by_kind) → actor(id, kind)`;
`kyb_leg_manual_has_reviewer`, an **equality** so a manual row must name a
reviewer *and* a provider row must not; `kyb_leg_reviewer_kind_matches`;
`kyb_leg_reviewer_is_human`; `kyb_leg_manual_has_reason` (≥ 20 characters — no
rubber stamps); `kyb_leg_reason_only_when_manual`; `kyb_leg_manual_reference`
(`provider = 'operator-review'` and a `manual.` prefix); and
`kyb_leg_operator_is_not_a_provider`.

**The mechanism to point at if they push on "an agent cannot approve a KYB
leg".** The FK is declared without `MATCH FULL`, so Postgres uses `MATCH SIMPLE`,
under which a composite FK is satisfied whenever **any** referencing column is
NULL. A row carrying an agent's uuid with a NULL kind would sail through the FK
untouched. `kyb_leg_reviewer_kind_matches` (id ⇒ kind not null) is what closes
that, and `kyb_leg_reviewer_is_human` then pins the kind to `human`. The trio is
sound; the doc's six-row table drops exactly the constraint that makes it sound,
and that is the answer to give rather than the table.

**One rule is application code, not schema, and say which.** *A review may never
clear a provider's decline* is `reviewRefusal()`
(`kyb/manual-review.ts:191`), returning `REVIEW_CANNOT_CLEAR_A_DECLINE`, called
twice — once by the screen to grey the control, once on the server before the
insert. There is no constraint for it and there cannot easily be one: the table
is append-only and a CHECK cannot see prior rows, so it would need a trigger.
Everything else in the list above is restated in SQL; this one is not.

**Own these three.** `DEFAULT_TRANSACT_POLICY` is `requireLiveEvidence: false`,
so the deployed gate lets a `manual`-evidence business transact — deliberate,
documented, and it means the one business that can move money on this book does
so on a human's say-so. The reviewer's identity comes from the role cookie, which
is demo-grade and labelled as such, so "Dana Okonkwo approved Ridgeline" is an
attribution anyone with the console can produce; the *agent cannot review* half
is a real absent capability, the *which human* half is not. And the environment
still drifts: `.env` has `KYB_FORCE_SIMULATED` unset (so GLEIF is live),
`.env.example` still ships `KYB_FORCE_SIMULATED=business_registry`, and
`docs/KYB.md` carries a stale section saying the flag currently suppresses the
leg.

### 2.15 The USDC rail — `src/lib/rails/stablecoin/*`, `scripts/payout-usdc.mjs`, `docs/STABLECOIN.md`

Seventeen modules behind **two** real payouts on two different providers. This
one is the direct rail, signed on our own machine: `0xb47c5a36…86a1`, receipt
`0x1`, block 46,651,201, 0.500000 USDC, 44,843 gas. The Circle one is §2.24, and
a document quoting "42 tests" or "one payout" predates it. `adapter.ts` is
refuse / sign / broadcast / wait / state-an-outcome; `ledger.ts` is the posting,
through `postEntry()` and nothing else; `allocation.ts` holds the two pure
decisions (minor units → balanced cents, block timestamp → value date) and is
separate precisely so it is testable in a CI that holds no credentials.

**The thing to point at first is the identifier, not the transfer.** An Ethereum
transaction hash is `keccak256` of the signed transaction's own bytes — nothing
about it is assigned by the network — so the name of this money movement exists
on our machine *before* a byte goes over the wire, and the script prints it
there. That is what lets it be the **idempotency key** rather than a receipt for
one. `journal_entry.idempotency_key` is UNIQUE, so a second posting is a no-op
decided by Postgres. The alternative — broadcast, then ask the node what it
called the transaction — has a window in which money has moved under a name we
do not yet know, and that is where double spends live.

**Questioned:** *"You hand-rolled a signer."* Yes, and the alternative was worse:
putting `viem` or `ethers` into the deployed application so an operator script
can sign a transaction. `keccak.ts` is not `createHash("sha3-256")` — FIPS-202
pads with `0x06`, Ethereum's pre-standard Keccak pads with `0x01`, and node's
OpenSSL has no `keccak256` at all. None of it was trusted until it was checked:
`keccak.test.ts` and `tx.test.ts` pin published vectors including the **EIP-155
example transaction**, whose exact `r` and `s` come back out — which is only
possible if the address derivation, the RLP, the hash and the signer are
simultaneously right. `tx.test.ts` then re-encodes *this* transaction from fields
read back with `eth_getTransactionByHash` and asserts the hash the network has,
with no private key involved. Volunteer the limit in the same breath: `pointMul`
is plain double-and-add and says so in its own comment, so the signer is not
constant-time and belongs in a KMS in production.

**Questioned:** *"Why is `evidence` on the outcome a literal?"* Same reason as
the KYB composite: an outcome that can claim `live` without a receipt is a
forgery route. `postUsdcPayout` takes a `ConfirmedPayout`, which is only
constructible after a receipt has been read, `status: 0x1` asserted and the block
re-checked as canonical. Broadcast, `reverted`, `reorged`, `unconfirmed`,
`dropped` and `refused` outcomes **cannot be passed to it at all**, so "we posted
a payment that never happened" is a compile error, not a code review. Every
non-refusal outcome carries the transaction hash, because an exception that
unwinds the stack with the hash inside it is how a payout becomes unfindable.

**The three gaps are §4.7 and they get volunteered, not defended.**

### 2.16 The commit gate — `scripts/precommit.sh`, `.secretscanignore`

Three scans and the three CI checks, chained with `&&` because a gate joined
with `;` is decoration. The scans are worth knowing apart, because each exists
because of a different real incident: an exact-value scan of staged files
(`DECISIONS.md` 032), a shape scan of provider prefixes, an editor-scratch-file
refusal (013), and a whole-tree credential scan with `grep -a` (023, and the NUL
byte that hid 1,206 lines).

**Questioned:** *"A grep for `0x` plus 64 hex is the obvious rule for a private
key. Why is it gone?"* Because it worked until this repo started doing
elliptic-curve arithmetic, and then the curve order, the field prime, both
generator coordinates, every keccak vector and the published EIP-155 signature
all matched it — **24 matches across `src/lib/rails/stablecoin/`, 23 distinct
values, not one of them a secret.** The failure mode of that rule is not the
false positive; it is that a rule firing on 24 innocent constants gets switched
off by whoever is in a hurry, and then it protects nothing. It now compares
against the **literal values in `.env`**, which has no false positives at all and
is strictly stronger for every secret this project holds, because it catches a
leaked key in any encoding position — prefix or not, hex or not.

**Questioned:** *"How does it know which `.env` values are secret?"* By key name,
and the direction is the point: it is a **whitelist of secret-bearing names**
(`KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|DSN`, plus `DATABASE_URL`,
`DIRECT_URL` and `APP_DATABASE_URL` named explicitly), not a blacklist of public
ones. You can enumerate your own credential names; you cannot enumerate every
public value that might legitimately appear in a document. The blacklist version
fired three times in one afternoon — on the wallet address, on the public RPC
endpoint, and on the literal string `business_registry` from a feature flag,
which appears in every document that discusses that slot. Note the three URLs:
they end in `_URL` like the public ones and carry a password in the userinfo, so
a suffix rule would have classed them as public. Proof rather than reasoning: the
real private key was planted in a staged file, the gate refused it, and it
flagged nothing else. The refusal prints the offending *file* and never the
matching line, because a gate that echoes the secret it caught has just put it in
a terminal scrollback and a CI log.

**Own this one before they find it:** a comment in that file says
`scripts/precommit.sh --audit` prints the classification "so the assumption can
be checked rather than trusted", and no argument handling exists in the script,
so the flag does nothing. It is a comment claiming a capability the file does not
have — the same class of over-claim as a probe reporting live without a round
trip — and the fix is one function or one deleted sentence.

**`.secretscanignore` is a file with justifications, not an inline exception.**
Two entries, each carrying the burden of proof: the scanner itself (its pattern
list contains the prefixes it hunts, so it matches itself) and `env.test.ts`,
whose `sk_live_abc123` is a deliberate **negative** fixture proving the
environment layer refuses live keys at boot. Deleting it would delete the proof.

### 2.17 The core loop, as one command — `scripts/coreloop.mjs` (2,189 lines)

The brief publishes the core loop as seven arrows. This is those seven arrows as
seven legs, run against the **deployed URL**, in one command:
`node scripts/coreloop.mjs`. `LEGS` at line 693 is the list, in the brief's own
order — KYB gate, fund from a linked bank, issue a card, authorise $50.00 and
settle $73.40, an outbound payment needing a second approver, survive a reversed
settlement, reconcile the scheme file.

**The property that makes it evidence rather than a demo: it imports nothing
from `src/`.** Lines 92–97 are the whole import list — four `node:` builtins and
`postgres`. It cannot accidentally test the code it is checking, because it does
not have it. What it drives is HTML: `parseForms()` (line 319) scrapes the
deployment's own forms, including the React server-action fields
(`$ACTION_ID_<hex>` for an unbound action, `$ACTION_<n>:0` carrying `{"id":…}`
for a bound one), and `submitForm()` replays them verbatim as
`multipart/form-data` — **the identical request a browser with JavaScript
disabled makes.** There is no `Next-Action` header anywhere in the file and no
hard-coded action id; if a form is renamed, the run fails rather than passing
against a stale constant. The action's *return value* is read back out of the
re-rendered page's bound-args field, so a leg reads the deployment's literal
result object rather than prose.

**Be precise about the scoreboard, because there are two of them.** The last
full run is recorded in `docs/CORE-LOOP.md` §5: `CL-MTW5GIX5`,
2026-09-10T23:19:44Z, **7 PASS, 0 FAIL, 0 SKIP**, invariants **14/14**, 91 HTTP
calls to the deployed origin and 3 to the Lithic sandbox, 56 seconds, exit 0.
That is the *core loop* over seven legs. `scripts/livefire.mjs` is a different
script over eight attacks and its last run was **7 PASS, 0 FAIL, 1 SKIP**
(§4.1). Do not let the two be conflated in the room — and say that the
core-loop scoreboard exists in the repo as the document's prose, not as a
checked-in transcript. Re-run it before the debrief and quote that run.

**The 14 invariants are not its own.** Lines 2107–2123 shell out to
`scripts/dbcheck.mjs` and require exactly `passed === 14 && failed === 0`: six
refusals (UPDATE/DELETE/TRUNCATE on `journal_entry` and `journal_line` as
`corgi_app`), four grant-surface checks, every entry balances, the trial balance
nets to zero, no stored balance column, no clock drift. Volunteer the limit in
the same breath: the hold-drift views are **not** among those 14 — they are
checked by the live-fire suite — and `dbcheck` is only meaningful if
`APP_DATABASE_URL` really is the `corgi_app` role, which the script states at
lines 15–19 and does not enforce.

**Two legs claim less than their titles.** Leg 4 cannot do "days later" — the
comment at line 1454 says so: Lithic clears on demand, so the clearing arrived
seconds after its authorisation, and the *value-date* half of the brief's
sentence is proven by leg 6 instead. Leg 7's title says "a planted break" and
the leg plants nothing: `/reconciliation` renders no write control, the break is
seeded, and the leg's own evidence says it "did not plant it and does not claim
to have". Both of those are in the file, in English, above the assertions.

**Questioned:** *"A runner that skips is a runner that passes."* `verdict()`
(line 740) has no branch that turns "nothing checked" into a pass, a skip alone
makes the exit code 1, and leg 6's only skip conditions are structural (no card
token, no `LITHIC_API_KEY`) rather than assertions. Leg 6 *was* a skip when the
script was first written and went green about ten minutes later when the card
correction path deployed — the honest version of that sentence is that the
assertions were not touched between the two runs and there is **no transcript in
the repo that proves it**, so say it as a claim about the design rather than as
evidence.

### 2.18 Card corrections — `src/lib/holds/corrections.ts`, `rail_event_semantics`

The brief's sentence is *"when a merchant reverses a settlement … the customer's
balance and their statement must both show the corrected position for the day it
happened."* Two things had to be true: the ledger can reverse a past entry at its
original value date (`reverseAndRebook()` in `post.ts`, true since the ledger was
written) and **a provider event actually reaches it**. Until this landed, the
second was false: `reverseAndRebook`'s only non-test callers were two demo
modules, and a `RETURN_REVERSAL` arriving from Lithic was posted as an ordinary
`force_post` at its **own** value date, so the day it corrected kept its wrong
figure for ever.

**Say what is corrected, exactly, because the obvious sentence is wrong.** It is
a **refund that is taken back**, not a settlement that is reversed:
`/simulate/return` then `/simulate/return_reversal`, on the card's own
transaction, producing a genuine signed Lithic delivery. A debit clearing
**cannot** be reversed in that sandbox, and the three ways to try are in the
code as a comment at `coreloop.mjs:1733` because each fails differently:
`return_reversal` on a cleared debit answers 400 *"Return reversal is not
supported for debit transactions"*; `void` appends an `AUTHORIZATION_REVERSAL`
and never touches `settled_amount`; and `clearing` with a **negative** amount
ignores the sign and adds a second capture — the dangerous one, because it looks
like it worked.

**The routing is a row, not an `if`.** `correctionEventIds()`
(`src/lib/holds/apply.ts:319`) selects the steps whose `rail_event_semantics`
row says `value_date_anchor = 'original'`; `valueDateAnchor()`
(`rails/semantics.ts:340`) is the whole decision, `semantics === "correction" ?
"original" : "event"`. There is no `stepType === 'RETURN_REVERSAL'` test in
`corrections.ts` — the four appearances of that string in the file are comments.
An **unclassified** step parks the whole payload rather than defaulting to
either behaviour, and `semantics.ts:208` *throws* if a `correction` row's
`value_date_source` is anything but `original.value_date`, so the two columns
cannot disagree.

**The two halves of the correction, and the idempotency.**
`chooseCorrectionTarget()` (line 134) is a pure function of the event set with
four branches and **parks rather than guesses** when two same-magnitude
candidates exist. A full correction (`net === 0n`) reverses with no re-book; a
partial reverses and re-books, and the re-book carries `valueDate:
entry.valueDate` under the comment *"THE ORIGINAL'S DATE. Not today's, and not
the correction's."* Both keys are derived, not generated —
`reversal:<original entry id>` and `card:correction:<provider event id>` — so a
redelivered webhook re-derives the same key and `journal_entry.idempotency_key`
being UNIQUE makes the second posting a no-op decided by Postgres.

**Own this before they grep it.** Two hard-coded switches survive and neither
decides correction-versus-new-event: `canonicalKind()` in `lithic-events.ts`
maps a step to a `card_event_kind` (both `RETURN_REVERSAL` and
`CORRECTION_DEBIT` land on `force_post`), and `directionOf()` in
`corrections.ts` reads the kind. The consequence is that the table's own
`canonical_kind` column is **decorative** — nothing reads it for behaviour, the
table says `refund_reversal` where the code stores `force_post`, and
`semantics.test.ts` pins that divergence as `kindMatches: false` rather than
hiding it. And `rail_event_semantics` is the one table the seed upserts
(`ON CONFLICT DO UPDATE`), which is defensible for reference data and does mean
a re-seed can rewrite a classification silently.

### 2.19 Standing orders — `src/lib/standing/*`, `db/migrations/0012_standing_orders.sql`

**The unit is the occurrence, not the order.** A mandate is a rule; the thing
that can fire twice is one dated instance of it, so that is the row:
`standing_order_occurrence (standing_order_id, scheduled_date)`. Exactly-once is
four constraints in a chain, and the answer to "how do you know it fires once"
is to name all four rather than the first: `UNIQUE (standing_order_id,
scheduled_date)` (0012:285), `UNIQUE (idempotency_key)` (0012:286),
`standing_order_outcome` keyed `occurrence_id PRIMARY KEY` (0012:344) — one
decision per occurrence — and `payment_instruction.idempotency_key` UNIQUE
(0001:647).

**The idempotency key is computed by Postgres, and the reason is a one-line
double payment.** 0012:270 is a `GENERATED ALWAYS … STORED` column:

    'standing:' || standing_order_id::text || ':'
      || lpad(EXTRACT(YEAR  FROM scheduled_date)::int::text, 4, '0') || '-'
      || lpad(EXTRACT(MONTH FROM scheduled_date)::int::text, 2, '0') || '-'
      || lpad(EXTRACT(DAY   FROM scheduled_date)::int::text, 2, '0')

Not `to_char`, and not `scheduled_date::text`: **textual date rendering in
Postgres is only `STABLE`, because it reads `DateStyle`.** A key whose value
depends on a session setting is a key that changes when a connection pool hands
you a different session — and two different keys for one occurrence is a second
payment. `EXTRACT` + `lpad` is IMMUTABLE, which is not merely asserted: Postgres
**refuses to create a generated column** whose expression is not immutable, so
the property is enforced by the DDL that carries it. The application never
computes the key at all — `claimOccurrence()` reads it back with `RETURNING`
(store.ts:464) and hands it to `requestPayment()`.

**Concurrency is proved, and be exact about what was proved.**
`standing.integration.test.ts:179` fires two overlapping `runStandingOrders()`
calls under `Promise.all` — one Node process, two real pooled connections, two
genuine server-side transactions — and asserts one instruction, one occurrence,
one outcome, one "raised fresh" and one "replayed". The mechanism is a
`SELECT … FOR UPDATE` through `lock_standing_order()` plus `ON CONFLICT DO
NOTHING` at three levels; not an advisory lock, and not application logic. Three
non-application attacks sit beside it: a hand-written duplicate INSERT
(`duplicate key`), an INSERT for a date the generator would not produce
(refused by `assert_standing_order_occurrence()`), and UPDATE/DELETE (refused).

**The policy is refuse-and-close, and it is checked against available.**
`types.ts:182` — if `availableCents >= amountCents` fund, else refuse with the
shortfall. No partial, no carry-forward, no retry queue: a decided occurrence
leaves the queue because `listDue()` returns only dates with no occurrence and
occurrences with no outcome. All four figures are persisted on the outcome row,
which is what makes the refusal explainable months later. The recorded refusal
is the one to quote, because it is the case that a ledger-balance check would
have got wrong: amount **$20,871.93**, ledger **$21,081.93 — covers it**,
available **$20,771.93 — does not**, shortfall **$100.00**, code
`INSUFFICIENT_AVAILABLE_FUNDS`. Say what made the gap: **$310.00 of card
authorisations**, with uncleared credits at $0.00 on that row. "Uncleared
absorbed it" is the funding story (§2.20), not this one.

**Own the guard that cannot fail.** `v_standing_order_double_fire` (0012:667)
joins `payment_instruction` to the outcome **on the idempotency key** and reports
`count(DISTINCT pi.id) > 1`. That column is UNIQUE, so the count can never
exceed one: the view is tautologically empty and detects nothing. The failure
worth detecting — two instructions for one occurrence under *different* keys,
i.e. the key was computed somewhere it should not have been — is exactly what it
cannot see. It is guard number eight in §6, and it was found while writing this
document.

### 2.20 Funding from a linked external bank — `src/lib/rails/plaid/*`, `/funding`

Leg two of the core loop, live against `sandbox.plaid.com` over raw `fetch` with
no SDK: `/link/token/create`, `/sandbox/public_token/create`,
`/item/public_token/exchange`, `/accounts/get`, `/auth/get`, `/item/get`,
`/sandbox/item/reset_login`. **State the limit in the same sentence as the
claim:** the Link *browser UI* is never driven — the link token is minted for
real and then not used, and the flow continues through Plaid's own sandbox
public-token endpoint. That is written three times in the code, not only in the
docs.

**The number that makes the point.** A $5,000 deposit moved the ledger and did
not move available:

    ledger        $23,584.93 -> $28,584.93
    card holds       $310.00 ->    $310.00
    uncleared      $2,503.00 ->  $7,503.00
    available     $20,771.93 -> $20,771.93

because the same transaction that posts the financial entry opens an
`uncleared_credit` hold for the same amount, and `availableBalance()` subtracts
it. The integration test asserts those as **deltas**, not absolutes, so it keeps
working on a book that other people are writing to.

**The availability policy is data, effective-dated, and cited by the hold.**
`funds_availability_policy` is keyed `(rail, counterparty_class,
effective_from)` and carries `banking_days_hold` and `release_local_time`; the
row is chosen by the credit's **value date**, not by today
(`effective_from <= valueDate ORDER BY effective_from DESC LIMIT 1`), and its
`policy_id` is stored on the hold — which is what makes a hold opened in March
still explainable in December after the policy changed. A missing row is
`NO_AVAILABILITY_POLICY` and nothing is booked; there is no default of zero.

**Banking days are computed, not looked up.** `availability.ts:177` derives the
eleven Federal Reserve holidays from their rules rather than from a table, and
it carries the Fed's Saturday rule — a holiday falling on a Saturday is **not**
observed on the Friday for banking purposes — which the test pins with
2026-07-03. The 09:00 ET conversion is `Intl.DateTimeFormat` on
`America/New_York` with a two-pass offset correction, tested on both sides of
the March DST boundary (`09:00 → 13:00Z` in September, `14:00Z` in January).

**And now the part that must be volunteered before it is found: there are three
definitions of "available" in this repo and they disagree.** See §4.8. This
section's numbers come from the funding screen's definition; the standing-order
refusal above comes from another.

### 2.21 Pots — `src/lib/pots/*`, `db/migrations/0015_pots.sql`, `/pots`

Stretch-ladder item four: *sub-accounts or pots, with instant internal transfers
that are pure ledger moves*. It is the cheapest possible proof that the ledger is
a ledger and not a balance table with extra steps, because an internal transfer
touches no rail at all — if a pot can only be built by adding a column beside the
balance, the balance was never derived.

**A pot is a node in the account tree.** `pot_open()` creates an account coded
`'2100.' || pot_id` (0015:199) whose parent is the business's own `2100` leaf.
The separator is `'.'` and not `'/'` deliberately: `chart.ts` reserves `'/'` for
the *display* form of a per-business leaf and `parsePerBusinessCode()` splits on
it, so a pot code must never parse as one of those. There is **no balance column
on `pot` or anywhere else**, and `corgi_app` holds `SELECT` on `pot` and nothing
more — the pot is opened through a `SECURITY DEFINER` function, so there is no
capability by which the application could write half of one.

**Available falls, with zero changes to `src/lib/ledger` — and say the mechanism
precisely, because the short version invites the wrong inference.** The transfer
is two lines: a **debit of the bare `2100` leaf** and a credit of the pot leaf.
`availableBalance()` (`balances.ts:127`) selects the deposit account by **exact
equality**, `code = '2100' AND business_id = $1` — no `LIKE`, no recursion — so
the debited leaf falls by the full amount and the credited pot leaf is invisible
to it. Available drops because the main leaf was debited; exact equality is what
stops the money being added straight back. `grep -i pot src/lib/ledger/**`
returns only the substring inside "idem**pot**encyKey". Every other consumer —
`listDepositAccounts`, holds, statements, the home summary, `v_available_balance`,
`v_overdrawn_accounts` — matches `'2100'` the same way, which is why a pot is
earmarked money everywhere at once without any of them learning a new concept.

**The invariant this feature falsified, which is the part worth volunteering.**
0001 says of `v_deposit_control_drift`: *"Written as a subtree walk rather than
'sum the 2100 children' so that adding a sub-account level later cannot silently
break it."* Half true. The view has two sides. The **subtree** side is a
`WITH RECURSIVE` walk over `account.parent_id` and picked the pot up with no
change, exactly as advertised. The **reported** side was
`SUM(v_ledger_balance) WHERE code = '2100'` — a flat code filter, which did not
recurse and did not see the pot. One pot and one $500.00 transfer, inside a
transaction that was rolled back, produced **subtree 13,577,077 vs reported
13,527,077** — a drift of exactly the 50,000 cents in the pot, reported by an
invariant that was supposed to be immune to this. The fix (0015:420,
`CREATE OR REPLACE` so 0008's grant survives) generalises the reported side to
`code = '2100' OR the account is in the deposit tree` — a **strict superset** of
the old row set, so it still catches a deposit leaf reparented *out* of the tree,
and with no pots on the book the two predicates select identically. The pots
integration test re-runs the **original** predicate verbatim and asserts it would
have drifted by exactly the pot balances, then asserts the new view is empty.
That is the negative test §6 asks for, built out of the guard's own exclusion
clause.

### 2.22 Payee confirmation — `src/lib/payees/*`, `db/migrations/0016_payees.sql`

Stretch-ladder item six. **Start with what the US does not have**: there is no
Confirmation of Payee for US ACH. Nacha has no name-inquiry message; the nearest
thing is a zero-dollar prenotification the receiving bank may answer days later
with a C01/C02/C03, or not at all. Nothing in this credential set can ask a US
bank what name sits on a stranger's account. So the design rule is **block on
arithmetic, warn on judgement**, and the arithmetic is the ABA check digit.

**The check digit was swept, and the sweep is the interesting half.** `aba.ts`
carries the weight vector `3,7,1,3,7,1,3,7,1`; the sweep runs over a fixed-seed
corpus of 500 checksum-valid numbers:

    single wrong digit        40,500 cases (500 x 9 positions x 9 digits)  100.00% caught
    adjacent transposition     3,656 cases (distinct-digit pairs)           89.03% caught
    transposition 3 apart      2,665 cases                                   0% caught
    transposition 6 apart      1,354 cases                                   0% caught

and the two failures are structural, not statistical. **Adjacent misses are
exactly the pairs differing by 5**: adjacent weight differences cycle −4, +6, −2,
each sharing a factor 2 with 10, so the shift vanishes iff the digits differ by 5
mod 10 — `{0↔5, 1↔6, 2↔7, 3↔8, 4↔9}` and nothing else. **Three and six apart are
caught 0% of the time** because the weight vector has period 3, so those
positions carry equal weights and the swap shifts the weighted sum by zero. A
check digit that catches every single-digit error and *none* of an entire
transposition class is a much more useful thing to be able to say than a
percentage.

**Two numbers, and know which is which.** 89.03% is this 500-number corpus;
`aba.ts`'s own comment says 88.9%, which is the population value (10 of 90
ordered distinct pairs miss). Both are right about different things and neither
says so, and the test asserts only a band (`0.1 < missRate < 0.125`), so the
89.03% in `docs/PAYEES.md` is not regression-guarded. "Exhaustive" means
exhaustive over the error space of that corpus, not over all valid routing
numbers.

**Why the screen offers no correction.** For an invalid number the weighted sum
is `S ≢ 0 (mod 10)`; changing position `i` shifts it by `w_i·(v − d_i)`, and
every weight (1, 3, 7) is a unit mod 10, so there is **exactly one** repairing
digit at every one of the nine positions. Nine repairs, always, for every invalid
routing number — so a suggestion list is nine equally likely guesses dressed as
help. `verify.ts:160` computes them and then filters substitutions out, keeping
only the transposition hint, whose text says to confirm against the payee's own
paperwork rather than taking a suggestion from us.

**The block is arithmetic, and it is enforced in four places.**
`assertBlockIsArithmetic()` (`verify.ts:546`) **throws** if any finding other
than `ROUTING_CHECKSUM_FAILED` carries severity `block`; the `payee` table has
`CHECK (routing_number IS NULL OR aba_checksum_ok(routing_number))`; the
verification table has `CHECK ((outcome = 'blocked') = (checksum_ok IS FALSE))`;
and the blocked UI branch has no continue control at all — absent, not disabled.
Severity has three values, not two (`block | warn | note`), and the payment gate
adds the fifth refusal: a `warned` payee whose warning has no
`payee_acknowledgement` row is refused as `PAYEE_WARNING_UNACKNOWLEDGED`, which
is a refusal to let an override be *implicit* rather than a block on judgement.

**And the provider does not do this for us — measured.** Increase's
`/routing_numbers` is live and answers a checksum-invalid `101050002` with
**200 and `data: []`** — the identical answer it gives for a real-but-unlisted
bank and for `000000000`. It validates *shape* (a 400 for eight digits, a 400 for
letters) and not arithmetic, so it cannot tell a failed checksum from an unknown
bank. That is the whole reason the local check digit is not redundant.

### 2.23 Card controls inside the provider's authorisation timeout — `src/lib/cards/*`, `src/app/api/webhooks/lithic-auth/route.ts`, `db/migrations/0014_card_controls.sql`

Stretch-ladder item two, and the only item on that ladder that *has* to be
real-time: everything else can be a job that runs later. Lithic calls us and
**waits**; the response body is the side effect.

**The deadline was measured, not read.** Enrol an ASA responder pointing at a
URL that stalls for twenty seconds, fire one `POST /v1/simulate/authorize`, and
time it: baseline with no responder **0.334 s → APPROVED**; with the stalling
responder **6.527 s → DECLINED, `UNKNOWN_HOST_TIMEOUT`, detailed result
`CUSTOMER_ASA_TIMEOUT`**. So the provider waits ≈6.19 s, consistent with the
documented 6000 ms, and — the part worth saying — **Lithic fails closed**. A
responder that goes quiet declines the cardholder; it does not wave the
transaction through. `PROVIDER_TIMEOUT_MS = 6_000` and
`PROVIDER_RECOMMENDED_MS = 3_000` are pinned in `budget.ts` with that
measurement above them.

**Our own budget is the one that actually fires, and the two must not be
confused.** `CONTROL_READ_BUDGET_MS = 600` (`budget.ts:69`) wraps the single
control query in `withDeadline`; when it expires, `store.ts` returns
`{ status: "unavailable" }` as a **value, not an exception**, and rule 1 of
`decide()` turns that into a decline. That is a tenth of the provider's deadline
and it is deliberate: we would rather answer "no" in 600 ms than be timed out at
6 s, because a timeout declines anyway *and* loses the record.

**Three decisions taken by Lithic's own traffic against the deployed endpoint,
read back out of `card_auth_decision`** (all `source = 'provider'`, 2026-09-11):

    00:42:24.687Z  decline  control_store_unavailable  601,521 us  $25.00 mcc 5812
                   result_code VELOCITY_EXCEEDED
                   inputs.detail "DeadlineExceededError: control read exceeded
                                  its 600 ms budget", fail_mode "closed"
    00:43:31.584Z  approve  card_not_under_control      14,297 us  $15.00 mcc 5812
                   fail_mode "open" — this card token is not in our book
    00:44:10.461Z  decline  mcc_blocked                147,419 us  $50.00 mcc 5542
                   result_code UNAUTHORIZED_MERCHANT, control version 1

and the provider's own record of the third one, which is the one to open in the
room: transaction `b1bd8d71-554a-46fc-b80a-fe90044868a8`, **status DECLINED,
result UNAUTHORIZED_MERCHANT**, 5000, network VISA, merchant `CORGI FUEL PUMP
LIVE`, mcc 5542, created 2026-09-11T00:44:10Z. Our row and Lithic's row agree to
the second. The enrolment is checkable in one call:
`GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` answers
`{"enrolled": true, "url": "https://corgi-trial-psi.vercel.app/api/webhooks/lithic-auth"}`.

**The two fail modes point in opposite directions, on purpose.** Rule 1
(`control_store_unavailable`) fails **closed** — we hold controls for this card
and cannot read them, so we decline rather than guess. Rule 2
(`card_not_under_control`) fails **open** — this token is not in our book at all,
we hold no opinion, and Lithic's own card limits still apply. `RULE_ORDER`
(`decide.ts:102`) is a separate constant from the display order precisely so that
reordering a screen cannot change what a card may buy, and `decide()` is pure: no
I/O, no clock, no `sql` handle in scope.

**Own the two holes before they are found.** First, the wire code for rule 1 is
`VELOCITY_EXCEEDED`, the same code as the three limit rules — an outage looks
like a velocity breach to the acquirer. Second, and worse: the argument for
failing closed is partly *"every fail-closed decline leaves a row, so the
customer can be found and made whole"* — but rule 1 fires **because the database
is gone**, so the append fails too, and `appendDecision` swallows it, retries once
through `after()`, logs `asa.decision_lost` and returns the verdict to Lithic
regardless. In the one case where fail-closed matters most, the evidence is a log
line, not a row. The cold-start row above exists only because that particular
outage was a slow read rather than an unreachable database.

### 2.24 A second stablecoin provider, behind the same interface — `src/lib/rails/stablecoin/circle-*.ts`

`StablecoinPayoutProvider` (`types.ts:341`) is four members: `id`, `label`,
`health()`, `send()`. Two implementations satisfy it — `directStablecoinProvider`
(`base.usdc`, the hand-rolled signer) and `circleStablecoinProvider`
(`circle.w3s`) — plus `unconfiguredCircleProvider()`, which satisfies the same
interface and **reports `not_configured` rather than throwing**, because a
provider that explodes on a missing key is a provider you cannot ask a health
question. Selection is `STABLECOIN_PROVIDER`, read explicitly
(`circle-registry.ts:126`) and never inferred from which credentials happen to be
present: asking for Circle without Circle configured yields the refusing provider
rather than a silent fall-back to the other rail.

**The second payout, on chain:** tx
`0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa`, block
**46,657,187** at 2026-09-10T23:24:22Z, receipt status `0x1`, 0.100000 USDC, Base
Sepolia (chain id 84532), Circle transaction
`a384de2e-ff91-5bc8-8c05-7f13112ba22b`, journal entry
`9ad9fac3-b0e5-4d87-a5b0-55027ede22d5` — DR 2100/Ridgeline 10¢, CR 1140 10¢.
Say the sentence that makes it worth more than a second demo: **the receipt was
read off Base Sepolia by us, not reported by Circle**, and the ERC-20 `Transfer`
log in that block was re-matched against our own amount and recipient.

**Why the wait stops at `CONFIRMED`.** Circle's own state ladder ran
`INITIATED` (no hash) → at ~10 s `CONFIRMED` with the hash → **and at 181 s it
was still `CONFIRMED`, not `COMPLETE`**. `COMPLETE` is Circle's only "success"
terminal state, so a consumer that waits for it is waiting for a provider's
opinion about a fact the chain settled at ~10 s. The loop's stop condition is the
**hash** (`circle-provider.ts:256`: `while (transaction.txHash === null && !isTerminal(...))`),
and from there the chain is the authority.

**The type gate, stated precisely.** `postUsdcPayout(input, conn)` takes an input
object whose `outcome` field is typed `ConfirmedPayout` — `Extract<PayoutOutcome,
{ kind: "confirmed" }>`. Circle's `INITIATED/QUEUED/SENT` map to `acknowledged`,
whose `txHash` is typed `null`, so handing an acknowledgement to the posting
function fails to compile twice over: the discriminant is wrong and the fields
are missing. Be exact about the limit when they push: it is a **discriminated
union, not a branded type**, and `postUsdcPayout` performs no runtime check on
`outcome.kind` — an `as ConfirmedPayout` cast would post. And the gate is on that
function, not on the journal: `scripts/book-usdc-funding.mjs` posts a USDC entry
through `postEntry()` directly. The honest claim is *"nothing routed through
`postUsdcPayout` can post an unconfirmed transfer"*, not *"no USDC entry can
exist without a receipt"*.

**Own the gap:** Circle has no operator entry point. `scripts/payout-usdc.mjs` is
the direct rail only; nothing outside the package and its tests drives
`circleStablecoinProvider`, `stablecoinProviderHealth()` is not wired into
`/api/health`, and `.env.example` documents no `CIRCLE_*` variable. The transfer
happened; the *path to repeat it* is a library call, not a command.

### 2.25 Reconciling 1140 against the chain — `scripts/reconcile-usdc.mjs`

`1140 USDC omnibus wallet — Base Sepolia` is **one account** (`chart.ts:148`,
materialised by the seed, not by a migration) and USDC now sits in **two**
wallets: the treasury wallet we sign for, and the Circle developer-controlled
wallet. The script used to read a single address out of the environment, so it
compared one wallet against an omnibus account covering two and reported **90
cents of drift against a ledger that was exactly right**. The arithmetic is
worth having in your head because a panel will make you do it: treasury 1,850¢ +
Circle 90¢ = **1,940¢**, which is exactly what 1140 says; read the treasury alone
and you get 1,850¢ against 1,940¢, and the missing 90¢ is not drift, it is a
venue you did not look at.

It now enumerates the wallets at runtime — env for the treasury, a live
`GET /v1/w3s/wallets` for Circle — and, crucially, **refuses to reconcile
against a subset**: a venue it knows about but cannot read sets `incomplete`, and
the final verdict is `ledgerCents === chainCents && !incomplete`, exit 1
otherwise. Today's run, live:

    direct (treasury)   1850 cents  (18.5 USDC)  0xd3629d73…2918
    circle 9a3524c0       90 cents  (0.9 USDC)   0xeaa8ce10…1e1c
    ledger 1140         1940 cents
    on chain, total     1940 cents  (19.4 USDC, 2 wallet(s))
    difference             0 cents
    RECONCILES — the books agree with the chain          exit 0

**Volunteer the hole in the fix**, because it is the same shape as the bug:
`incomplete` can only be set *inside* the branch guarded by `if (CIRCLE_API_KEY)`.
With that key unset the script reconciles the treasury alone, reports
"1 wallet(s)", and prints the original wrong answer as drift. A 200 with an
unexpected body, or a page-limited wallet list, is silent for the same reason.
The guard covers *unreachable Circle* and not *unconfigured Circle*, and the
second is the likelier of the two on a fresh machine.

---

## 3. The hard questions, with answers

### 3.1 "How do you know the hold releases exactly once?"

Four steps, and none of them is a check in application code.

1. **Dedup is structural.** `card_auth_event` is
   `UNIQUE (auth_id, provider_event_id)` with `ON CONFLICT DO NOTHING`, so `E` is
   a set decided by Postgres.
2. **The target is order-free.** `H(E)` is Σ, ∃, max and one clock comparison
   over that set, so every permutation converges on the same number.
3. **The posting is a compare-and-append under a row lock.** Under
   `lock_card_authorization()`, compute `H_new = H(E)`, read `H_cur =` the memo
   balance from the journal, append `H_new − H_cur` **only if non-zero**. No two
   processors can both see `H_cur = 5000` and both post −5000. Behind the lock,
   the entry carries `idempotency_key = hold:<hold_id>:after:<event_id>`, UNIQUE
   on `journal_entry`, so even a bug that bypassed the lock could not append a
   second delta for the same event.
4. **The effect does not depend on the posting.** Availability reads
   `CASE WHEN released THEN 0 ELSE memo_balance END`, and `released` is a
   `hold_closure` row existing — `PRIMARY KEY (hold_id)`, so closure is
   exactly-once by construction, there is no second row to write. If a process
   dies between closure and posting, the customer's available balance is
   *already* correct; the entry lands on the next event or the expiry sweep, and
   lands as `Δ = 0`.

At-most-once posting + at-least-once idempotent effect = exactly once. The place
people get this wrong is trying to make the *message* exactly-once. The message
cannot be; what is made exactly-once is the state transition, by making state a
function of an accumulating set rather than an increment on a mutable counter.

Files: `src/lib/holds/apply.ts` (module header states the seven steps and this
argument), `src/lib/holds/model.ts`, `db/migrations/0008_holds.sql` §2,
`research/ledger/DESIGN.md` §9.

**Volunteer the caveat:** on the over-capture case specifically, the release
happens and the closure row does not. See §4.1.

### 3.2 "What happens if the same webhook arrives twice?"

Three layers, all in the database, and the outermost one settles it before any
business logic runs:

1. `webhook_inbox` is `UNIQUE (provider, provider_event_id)`. Ingestion is a
   single `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, and **the row count
   is the decision** — first delivery returns 202 `accepted`, a replay returns
   200 `replay`. There is no SELECT-then-INSERT anywhere in the codebase, because
   that has a race between two statements and this has none.
2. `card_auth_event` is `UNIQUE (auth_id, provider_event_id)`, so even a provider
   that reissues an event under a new envelope id cannot double-count the
   underlying fact.
3. `journal_entry.idempotency_key` is UNIQUE and derived from the source fact —
   `card:clearing:<provider_event_id>` — so the money entry cannot be written
   twice even if both layers above were bypassed. `ledger_append()` looks the key
   up first and, on a replay, returns the original entry id and writes nothing.

**Proven, and the story of how it was nearly not proven, is worth telling.** An
earlier attempt replayed a stored delivery, saw the row count hold at 1, and
almost got reported as proof. It was not: both replays returned 401 because the
stored headers were double-encoded and carried no signature, so the count held
because the requests were rejected *before* the inbox
(`DECISIONS.md` 020). `src/test/livefire/attack-08-real-provider-replay.test.ts`
now proves four things before it will read the row count — the delivery is a real
Lithic one caused by this run, both replays are *accepted* with
`status: "replay"` (reachable only after verification succeeds), the echoed
`inboxId` is the original row's, and a negative control with a tampered signature
is answered 401.

### 3.3 "What if it arrives out of order?"

It is not a case. See §1.3: `H` is a function of a set. Concretely, for a
settlement that beats its authorisation, `card_authorization.origin` records
`clearing_first` for reporting and **the maths does not branch on it**. The
transition table in `research/ledger/DESIGN.md` §8.3 enumerates all nineteen
orderings including reversal-before-authorisation and incremental-before-original,
and `src/test/livefire/attack-04-settlement-before-authorisation.test.ts` runs
both orders against production and asserts the ledger, available and holds deltas
are equal in all three.

For other rails the mechanism is the same shape: state is a fold over the
entity's event set keyed by the provider's stable domain id, and for Increase the
webhook is a pointer so `parseEvent` reads back the current state, which is
order-independent by definition. For an event referring to an entity we have
never seen, the consumer parks against the named referent rather than guessing.

**The trap in the test, worth volunteering:** attack 4's first version reused
provider event ids to build the out-of-order episode and measured a ledger delta
of **zero**. `financialPostingKey` is `card:<kind>:<provider event id>`, so the
second episode's settlement was a replay of the first. The ledger was right; the
test was measuring the idempotency key instead of the ordering.

### 3.4 "Why is available balance not a column?"

Because the answer depends on which day you ask about and when you ask it,
independently — a stored number has one value and cannot express that. There is
no balance column anywhere in the schema, and `pnpm db:check` fails the build if
one appears (the check is `no stored balance column`, with `statement` excluded
by name and with its reasoning). `available = ledger − active holds − uncleared
credits` is one view over two SUMs, computed at request time in integer cents,
with the covering index `journal_line_balance_idx (account_id, value_date,
booking_seq) INCLUDE (amount_cents)` making it an index-only scan.

The attack on this requirement is to find the stored number and the job that
repairs it. There is nothing to find: DESIGN §17 lists the only nightly jobs —
verify the hash chain, verify `v_hold_drift` is empty, import scheme files, post
cosmetic hold releases, generate statements — and every one is a reader or an
appender. None repairs a number.

**If pushed on performance:** the escape hatch is written down and is *safe*
because it is memoisation of a pure function — an `account_balance_snapshot`
keyed on `(account_id, value_date, booking_watermark)`, all three components
immutable, truncatable at any time with no loss. It is deliberately not built,
because an unprofiled cache is premature. The distinction to insist on out loud:
a cache whose inputs are immutable cannot drift; a stored balance whose inputs
are mutable always will.

### 3.5 "Show me the money for a $50 auth cleared at $73.40"

Walk it in this order, and the numbers are exact.

**The authorisation ($50.00 = 5000 cents).** `movesFinancialBook('authorization')`
is false, so **there is no code path from an authorisation to a financial
posting** — that is why "the ledger does not move on an authorisation" is
structural rather than a rule to remember. `H` goes 0 → 5000, so `Δ = +5000` and
`postHoldDelta` writes one **memo** entry:

    book = memo, hold_id set
      9100/<business>   −5000    (credit: a bigger obligation to withhold)
      9900 memo contra  +5000    (debit: so the memo book nets to zero alone)

`9100` is a liability, so `normal_side = −1` and the memo balance reads **+5000**.
Available drops by exactly 5000. Ledger: unchanged.

**The clearing ($73.40 = 7340 cents).** Two entries, in this order:

    financial entry, value_date = card local transaction date
      2100/<business>   +7340    (DEBIT the deposit liability: we owe them less)
      2200 card settle  −7340    (credit: we now owe the network)

Then recompute over the whole set read back from the database: `A = 5000`,
`C = 7340`, `closed` is false (Lithic has no last-capture flag so `isFinal` is
never set on a CLEARING, and `A > 0`), remainder `5000 − 7340 = −2340` which is
negative, so `H = max(−2340, 0) = 0`. `Δ = 0 − 5000 = −5000`, and the memo entry
is the exact negation of the first:

    book = memo
      9100/<business>   +5000
      9900 memo contra  −5000

**Net effect.** Ledger down 7340. Holds back to 0. Available down 7340, not
12340 — the hold is released and the settlement charged, never both. The customer
was overdrawn by the 2340 that was never held, and `availableCents` is allowed to
go negative to say so.

**Then volunteer the gap before they find it:** no `hold_closure` row is written
on this path, because `terminallyClosed` is false for exactly the reason above.
The money is right, one bookkeeping row is absent, and §4.1 is the full answer.

Files: `src/lib/holds/store.ts` (`postCardMovement`, `postHoldDelta`),
`src/lib/holds/apply.ts`, `src/lib/holds/model.ts`,
`src/test/livefire/attack-02-over-capture-release.test.ts`.

### 3.6 "How would I corrupt this ledger if I were malicious?"

Take the question seriously and answer it as a list of what each attacker
actually gets.

- **Through the application.** Nothing. `corgi_app` holds `SELECT, INSERT` and
  cannot express `UPDATE`, `DELETE` or `TRUNCATE` on any money table. It is not
  the table owner and not a superuser, so it also cannot disable the triggers —
  `session_replication_role` is superuser-only. `pnpm db:check` attempts all
  three and asserts refusal, as that role, which matters because privileges never
  bind the owner and because an `UPDATE ... WHERE true` on an empty table as the
  owner matches no rows and "succeeds".
- **Through the one function that can write.** `ledger_append()` is `SECURITY
  DEFINER`, which is the textbook privilege-escalation shape: it would resolve
  unqualified names — `digest`, `nextval`, `format` — through the *caller's*
  `search_path`, and a caller who can create an object earlier in that path runs
  its own code as the owner inside the only function that writes to the journal.
  Not exploitable here (Postgres 18, `public` no longer grants CREATE to PUBLIC,
  and `has_schema_privilege('corgi_app','public','CREATE')` is false) and closed
  anyway in `0003`: `SET search_path = public, pg_temp`, with `pg_temp` named
  explicitly and placed **last**, because omitting it makes Postgres search it
  first and a temp object reopens the same hole.
- **As the database owner, with the triggers off.** This is the only real path,
  and it is what the hash chain is for. Every entry stores `prev_hash` and a
  SHA-256 over `(booking_seq, value_date, book, entry_type, idempotency_key,
  canonical lines)`. `verify_chain(entity)` walks it with a `LAG` window and
  returns a row for every entry whose `prev_hash` does not match its predecessor
  or whose own hash does not match its content — so a retroactive edit breaks the
  chain **at that entry and at every entry after it**. It runs in CI and nightly.
- **By poisoning the arrow rather than the money.** The subtle one, and it is
  guarded: `card` maps a provider card token to a business, and an UPDATE
  repointing a token from one customer to another would silently bill the wrong
  customer while every invariant kept passing. So `card` carries the same
  append-only triggers as a money table; re-issuing a card is a new row with a
  new token, which is also what the provider does (`db/migrations/0008_holds.sql`
  §3).
- **By getting one row of `rail_event_semantics` wrong.** This is the one I would
  attack. See §3.8 — it is named as the design's single biggest risk in DESIGN
  §18.4 and it is the failure that passes every invariant.

### 3.7 "What breaks if Neon goes down mid-drain?"

Nothing that costs money; you lose latency and you may re-do work.

The drain's unit of work is one claimed row. `claimBatch` runs
`FOR UPDATE SKIP LOCKED` inside a CTE and sets `locked_until = now + lease`,
leaving the row in state `pending` — **a lease is a timeout, not a state**. So a
worker that dies releases its work by doing nothing at all; nothing has to notice
the crash. When the lease expires the row is claimed again.

Inside the consumer, the effects are transactional. `recordFacts` is one
`conn.begin()` covering the identity, the lock, the event inserts, the financial
postings and the closure. `settleHoldPosting` is a second transaction taking the
same lock. A failure anywhere rolls back to a consistent point, and re-processing
is safe at every layer: the event unique index refuses the facts a second time,
`ledger_append()` returns the original entry on a replayed idempotency key, and
the compare-and-append computes `Δ = 0` when the memo book already says the right
thing.

The genuinely lossy case is the reverse: the database is up and the *route*
fails. That returns 500 and the provider retries — which is exactly what happened
in production when the inbox INSERT was rejected for a parameter-type deduction,
and the delivery **recovered** five minutes later once the cast was fixed
(`DECISIONS.md` 020). That is why an inbox failure returns 500 rather than
swallowing the delivery.

The honest limit: if every `after()` nudge is lost, the backstop is the daily
cron. See §4.5.

### 3.8 "Why is an ACH return a new event but a card clearing correction a correction?"

Because the question is: *was the original posting a false statement about its
own value date?*

- **A card clearing reversal: yes.** The $200 never economically happened on
  Tuesday, so Tuesday must be made whole. The reversal carries the **original's**
  value_date and its own booking position, and `assert_reversal_is_exact()`
  enforces that — it raises if the value dates differ, and it raises if the lines
  are not the exact arithmetic negation account by account.
- **An ACH return: no.** The payment genuinely settled on Monday and the RDFI
  genuinely returned it on Thursday with its own effective date. It takes **its
  own** value date. Booking it at Monday's would erase a settlement that really
  occurred and make an already-issued statement disagree with the customer's own
  bank.

This is not a branch inside a webhook handler; it is data, one row per provider
event type, in `rail_event_semantics` — so it can be reviewed and tested per row.
Twenty-two rows are seeded in `scripts/seed.mjs` (Lithic 10, Increase 7, Base 5),
each with a `value_date_source` naming the payload field and a note. The two
poles: `increase / ach_transfer.updated → returned` is `new_event` with
`value_date_source: payload.return.created_at`; Lithic's `RETURN_REVERSAL`,
`CORRECTION_DEBIT` and `CORRECTION_CREDIT` and Base's `usdc.transfer.reorged` are
`correction` with `value_date_source: original.value_date`.

**Volunteer the gap in the same breath, because a grep finds it in seconds:
nothing in `src/` reads that table yet.** The only mention outside the migration
and the seed is a comment. The decision is correct, reviewable and seeded; the
consumer that would consult it is the ACH one, which is not built, and the card
path currently carries its semantics in `lithic-events.ts` and
`postCardMovement()` instead. So the right sentence is "the mapping is data and
it is right, and today it is documentation rather than a dependency — the ACH
consumer is what turns it into a dependency", not "the ledger reads it".

**And it was confirmed by measurement, not by reading.** A full lifecycle through
the Increase sandbox: create $742.19, submit, settle, return R01. Two findings.
Increase has **no `settled` status** — a settled transfer stays `submitted` and
merely grows `settlement.settled_at`, so a consumer keying release off `status`
releases nothing, ever. And after the return, `settled_at` is still populated and
the transfer id is unchanged: the provider itself models a return as a second
money movement, not as an edit of the first (`DECISIONS.md` 019).

**Why it matters more than it looks:** one wrong row in that table silently
corrupts every past statement it touches while all five invariant views keep
returning zero rows, the hash chain still verifies, and reconciliation stays
clean. It is the only failure in this design that is invisible to every check the
design has.

### 3.9 "What does your agent surface let an agent do, and what does it refuse?"

**Can:** read its own business's balance, transactions and reconciliation breaks,
and queue one payment request. That is eight tools — seven read, one write — and the list is closed.

**Cannot, and the refusal is not in the tool list:** release a payment, approve
anything (including its own request), change an approval policy or threshold,
read or rotate credentials, post a reconciliation adjustment, close a book day,
issue or freeze a card, or write to the journal. Eight items, each with its
failure mode, in `docs/AGENT-LIMITS.md`.

**The one-sentence rule:** *an agent may state an intention; it may not make a
fact final, and it may not change the rules that decide what is final.* The test
is "if this call were wrong, would a person get to see it before the
consequence?" — yes for `initiate_payment` by construction, no for everything
else, either because there is no later step or because the operation *is* the
later step.

**Where each refusal actually lives**, weakest to strongest: the tool registry
(outermost, and the only layer a future contributor can change by accident); the
absence of an import (the MCP module never imports `ledger/post.ts`,
`approvals/decide.ts` or `approvals/release.ts`); the token scope plus
`FORBIDDEN_PARAMETER_NAMES`; `auth.ts` refusing a grant that points at a
non-agent actor; `assert_maker_checker()`; and the `actor` CHECK that makes an
approving agent unrepresentable.

Then volunteer the four debatable lines from §2.11 — it is a stronger answer than
a clean one.

### 3.10 "Kill your payout script after the broadcast. What happens when you run it again?"

The best question they can ask about the USDC rail, and there are exactly three
places to die, because a payout is two writes to two systems that cannot share a
transaction.

**1. Before broadcast.** Nothing was signed onto the wire. Nothing moved, nothing
posted, and a re-run reads the same nonce and sends exactly one transfer. Safe by
construction.

**2. After broadcast, before the receipt — the window that pays twice.** A
transaction sits in the mempool at nonce *N* and we never learned its fate. The
naive re-run reads `eth_getTransactionCount(pending)`, which **already counts the
in-flight transaction**, builds a second transfer at nonce *N+1*, and pays twice.
Closed by reading `pending` and `latest` separately and refusing while they
disagree:

    kind    REFUSED
    reason  transaction_in_flight
    detail  nonce pending=1 latest=0: 1 transaction(s) from this wallet are
            unmined. Broadcasting now would take nonce 1 and send a SECOND
            payout. Wait for the mempool to clear, then re-run.

If it mines, case 3 finds it; if it is dropped, `pending` falls back to `latest`
and the re-run sends one. Either way the hash was printed *before* the broadcast,
so `--settle <hash>` resumes directly. Step 5 of `sendUsdcPayout` in
`adapter.ts`.

**3. After the receipt, before the ledger write.** The money moved and nothing
records it. Closed by asking **the chain**, not a local row: `eth_getLogs` for an
ERC-20 `Transfer` from this wallet, to this recipient, for this amount, over the
last 10,000 blocks. A hit returns that transaction's receipt as `confirmed` with
`recovered: true`, having sent nothing, and the caller posts under the same
idempotency key. That is also why the second run of the demo prints
`already on chain as 0xb47c5a36…86a1 — sending nothing`, the same entry id, and
`entries with this key: 1`.

**Volunteer the limit of (3) rather than waiting for it.** The on-chain evidence
is `(token, from, to, amount)`, so two payouts agreeing on all four are
indistinguishable to the scan, and it reaches back 10,000 blocks and no further.
A production system carries a durable intent id, and the natural home for it is a
`usdc_payout` table this build does not have. It is correct for one payout
instruction at a time, which is what it claims and no more.

**And one deliberate `throw`:** if the node returns a hash different from the one
computed locally. That cannot happen unless the keccak or the RLP is wrong, and
if it does, the idempotency key names a transaction that does not exist — so the
process stops rather than posting.

### 3.11 Others they are likely to ask

**"Why no status column on the authorisation?"** Status is a view over events. A
status column is a cache with no key and no invalidation story, and it is the
single most common source of "the hold released twice". Lithic's own status field
proves the point: it flips to SETTLED while 400 cents are still authorised.

**"You take a global advisory lock on every append. That is a serialisation
point."** Yes, and it is stated as known risk #1 in DESIGN §18. The critical
section is a couple of inserts and a hash, which is thousands of entries per
second on one lock — far past this business. The scale-out path is to shard the
lock per `book_entity`, which the sequence and the chain should be anyway;
`closeDay` already takes the same lock scoped per entity, so the read side of
that is right already.

**"What if two clearings arrive with different provider ids for the same
capture?"** The ledger cannot tell a genuine second capture from a
network-duplicated one, because the network gave them different ids. It posts
both, reconciliation surfaces the second as `in_ledger_not_file`, and the fix is a
reversal at the original value date. That is row 19 of the transition table and it
is written down as the honest one: I would rather post and break than guess and
lose.

**"Who eats the residual penny?"** Nothing is ever divided in the ledger; division
happens only in allocation, and an allocation's output is always integers summing
exactly to its input (largest-remainder, ties broken by line `ordinal` then
`account_id`). Corgi's own income or expense line is placed at ordinal 0 by
construction, so the house absorbs the penny. Sub-cent dust that cannot be
allocated posts to `2900 Rounding residual clearing` as a real journal line, so
the entry still balances and the dust is a balance we can see and sweep.

**"Prove a closed day's statement reproduces."** `closeDay` takes the *same*
advisory lock `ledger_append()` takes before reading `MAX(booking_seq)` —
otherwise it could observe 39 while 38 is still in flight, and 38 would commit
*below* a published watermark, silently, months later. With the lock, the maximum
is a true high-water mark, every row below it is immutable, and the content hash
over the canonical rendering is a pure function of (format, account, period,
watermark).

### 3.12 "I just funded $5,000. When can I spend it?"

The honest answer has two halves and the second one is a bug, so lead with the
policy and then say the bug before they find it.

**The policy.** The credit posts to the ledger immediately and an
`uncleared_credit` hold for the same amount opens in the same transaction, so
ledger moves and available does not. The hold cites a row of
`funds_availability_policy` chosen by the credit's **value date** — ACH from the
customer's own verified account is one banking day, released at 09:00 ET — and
the instant is computed with a DST-correct conversion, not an offset. Banking
days are computed from the eleven Federal Reserve holiday rules, including the
Fed's Saturday rule.

**The bug.** There are two release predicates. `v_available_balance` releases on
the clock: `now() >= available_at`, nothing running. `availableBalance()` — the
function `/accounts`, the holds path and every standing order actually call —
releases only when a `hold_closure` row exists. The function that writes that
row, `releaseAvailableCredits()`, **has no caller anywhere in the repository**.
So on the SQL view the money appears at 09:00 ET and on the screen it never
does. §4.8 is the full map, including the dated prediction: ten uncleared holds
on this book mature at 2026-09-11T13:00Z, and at that instant
`v_hold_release_drift` goes non-empty — an invariant nothing currently queries.

### 3.13 "Your card controls run inside someone else's timeout. What happens when your database is gone?"

"We decline, in 600 ms, and I can show you the row." `CONTROL_READ_BUDGET_MS` is
600 — one tenth of Lithic's measured 6000 ms — and the control read is wrapped in
a deadline that returns a **value**, not an exception, so the unavailable store
is an input to `decide()` rather than an error path around it. Rule 1 of
`RULE_ORDER` turns it into a decline. The live row reads `decision_latency_us
601521`, `rule control_store_unavailable`, `inputs.detail "DeadlineExceededError:
control read exceeded its 600 ms budget"`, `fail_mode "closed"`.

Then volunteer the two things wrong with it. The wire code is
`VELOCITY_EXCEEDED`, the same code the three limit rules use, so on the acquirer's
side an outage is indistinguishable from a customer hitting a limit. And the
audit argument eats itself: the case for failing closed is partly "every decline
leaves a row", but rule 1 fires *because the database is unreachable*, so the
append fails too — it retries once through `after()` and then logs
`asa.decision_lost`. The row above exists only because that outage was a slow
read rather than a dead database. Contrast rule 2, which fails **open** on
purpose: a card token we have never seen is not a card whose controls failed, and
Lithic's own limits still apply.

### 3.14 "Why is the standing order's idempotency key computed in the database?"

Because the alternative is a double payment with no bug in it. The key is a
`GENERATED ALWAYS … STORED` column built from `EXTRACT` and `lpad` over
`scheduled_date`. `to_char` and `date::text` are only **`STABLE`** in Postgres —
they read `DateStyle` — so a key rendered through them changes when a pooled
connection hands you a session with a different setting, and two keys for one
occurrence is a second payment. `EXTRACT` + `lpad` is IMMUTABLE, and this is not
a claim: Postgres refuses to create a generated column whose expression is not
immutable, so the property is carried by the DDL rather than by a comment. The
application never computes the key at all — it reads it back with `RETURNING`.

The follow-up to expect is *"so what stops the app passing its own key?"* — the
trigger `assert_standing_order_outcome()`, which refuses any `raised` outcome
whose instruction key differs from the occurrence's, along with account, rail,
amount, currency and `value_date = scheduled_date`.

### 3.15 "You added a level to the account tree. What did it break?"

"One invariant, and it was the one whose comment said it could not be broken."
The pot is an account coded `2100.<uuid>` parented to the business's `2100` leaf.
`v_deposit_control_drift` compares a `WITH RECURSIVE` subtree walk against a
"reported" figure, and its own header says it was written as a subtree walk *so
that adding a sub-account level later cannot silently break it*. The subtree half
was exactly as advertised. The **reported** half was a flat `code = '2100'`
filter, which did not recurse and did not see the pot: one pot, one $500 transfer
inside a rolled-back transaction, and the view reported subtree 13,577,077
against reported 13,527,077 — drift of exactly the 50,000 cents in the pot.

The fix generalises the reported side to `code = '2100' OR the account is in the
deposit tree`, a strict superset of the old row set, and the pots integration
test re-runs the **original** predicate verbatim to assert it *would* have
drifted. That is the §6 rule applied rather than quoted: the negative test is
built out of the guard's own exclusion clause.

### 3.16 "Circle told you CONFIRMED, not COMPLETE. Why did you post?"

Because `COMPLETE` is Circle's opinion about a fact Base Sepolia had already
settled. Measured on the live transfer: `INITIATED` with no hash at t+0,
`CONFIRMED` with the hash at about ten seconds, and **still `CONFIRMED` at 181
seconds**. The wait loop's stop condition is the appearance of the **transaction
hash**, not a provider status, and from there the authority is the chain: read
the receipt, assert `status: 0x1`, re-check the block is canonical, and re-match
the ERC-20 `Transfer` log against our own amount and recipient. Only that
produces a `ConfirmedPayout`, and only a `ConfirmedPayout` can reach the posting
function.

Say the limit in the same breath: it is a discriminated union, not a branded
type, so a cast would defeat it; and the gate is on `postUsdcPayout`, not on the
journal — `scripts/book-usdc-funding.mjs` posts a USDC entry through `postEntry()`
directly, which is how the opening balance was booked.

---

## 4. Where we are weak, and how to say it

The brief says diagnose in front of them instead of defending. Each of these has
a one-sentence honest framing and a named week-two fix. Lead with the framing.

**The opening move for this whole section**, if they ask "what is wrong with your
build": we ran an adversarial evaluation against ourselves and it is checked in
at `docs/EVALUATION.md`, scoring **62/100** with the categories broken out and
the automatic-fail check run row by row. Its one-line verdict is the sentence to
borrow: *"the hard half is done and the easy half is missing — the ledger, the
hold algebra, the bitemporal model, the maker-checker triggers and the webhook
receiver are the parts most candidates get wrong, and they are right here. What
is absent is the wiring."* Two caveats to state with it. That score was taken at
16:45, before the drain, the consumers, the statements screen and delivery
freshness landed — Iteration 1 at the bottom of the same file measures the
delta — and it is now materially out of date in our favour, because "the wiring"
is most of what landed afterwards: the core loop runs end to end against the
deployed URL, the KYB gate is live and reachable, funding, standing orders, pots,
payee confirmation and card controls all have screens and provider traffic. Do
not quote 62 as a current number; quote it as the number that named what to build
next, and then say what got built. And the evaluator disclosed its own damage: it ran the suite against the
production database, so much of the ~50-row approvals queue visible in the demo
is evaluation residue, and it probably consumed the Lithic rate-limit budget that
made attack 8 fail on that run.

### 4.1 Live-fire attack 2 — the money is right and one row is absent

**Say:** "The hold releases and the arithmetic is exact; what is missing is a
`hold_closure` row, and the cause is a disagreement between two artefacts I wrote
myself, not a money error."

`model.ts` computes `closed(E) = isFinal ∨ close/expiry ∨ (A ≤ 0)`, and
`lithic-events.ts` deliberately never sets `isFinal` on a CLEARING because Lithic
offers no last-capture flag. With A = 5000 and C = 7340, `A > 0`, so `closed` is
false — while DESIGN §8.3 row 2, describing exactly this case, says `closed = y`.
I wrote the one-line `C >= A` fix, watched three model tests fail, and reverted
it: `v_hold_drift` holds the TypeScript model and the SQL view equal **by a live
invariant**, so changing one side alone converts a prose mismatch into a drift
alarm, and an invariant reporting drift is indistinguishable from a ledger that
has actually drifted. With seventy-five minutes to a deadline that was the wrong
trade.

**Week two:** one migration moving `v_card_auth_hold` and `model.ts` to close on
`C >= A AND sawAuthorisation` **together**, with `v_hold_drift` proving they still
agree, then amend DESIGN §8.2's diagram, which a test comment already flags as
looser than the SQL.

### 4.2 Live-fire attack 7 — the outage used to be invisible, and the gap it left was in the alarm, not the report

**Say:** "This one skipped for most of the build because `/api/health` reported
credential liveness and nothing about delivery freshness. It now passes, and it
passes by *inducing* the outage rather than by asserting round a missing feature
— the last full run was **7 PASS, 0 FAIL, 1 SKIP**, and the remaining skip is
attack 2 and is deliberate (§4.1)."

The suite delivers nothing for 180s, watches Lithic cross `fresh → stale` at lag
184s inside its own 180–900s band, cross-checks the published `lastDelivery`
against `MAX(webhook_inbox.received_at)` read straight from the database, and
asserts the *degraded* banner specifically rather than any banner, because the
"cannot reach health" variant carries the same attribute and would prove the
opposite. If the silence cannot be induced it SKIPs and names what stopped it.

**And the part worth volunteering** is what that run found: the escalation gate
read `slots.every(live)`, Lithic owned an honestly `unprobed` sibling slot, so
`degradesDeployment` was false permanently and **no webhook outage could move the
top-level status** — a reader of `webhookHealth` saw the outage and a monitor
watching `status` did not. It is `some` now, for a reason that has since been
re-derived from measurement rather than from that history (§2.13), and the test
asserts both gate shapes rather than only the one in use. That is guard four of
the nine in §6.

What already held through the dark window: the trial balance does not move, the
swallowed event has zero inbox rows, nothing is invented; on recovery a doubled
backlog produces one inbox row, one `card_auth_event`, one hold, and available
drops by exactly 5000. Only "degrades visibly" was unproven.
`src/lib/integrations/delivery-health.ts` and the `webhookHealth` field on
`/api/health` now exist, with a five-verdict vocabulary deliberately disjoint from
the liveness one, and `src/components/system/ProviderHealthBanner.tsx` renders it
in the console shell — deliberately saying "the feed has gone quiet and the
balances below are still correct for every event we have received", never
"healthy" from an absence, and never blanking the page.

**Command:** `node scripts/livefire.mjs --only 7`. Re-run it before the room and
quote that run, not this paragraph.
**Week two:** `src/test/livefire/README.md` §4 and `docs/CUT-LIST.md` §2.5 still
describe delivery freshness as missing. Both are stale in the under-claiming
direction; say it before they read it.

### 4.3 The slot that stopped being simulated, and the word that has to go with it

**`business_registry` is live, and the qualifier is not optional.** Say:
"Every KYB vendor on the brief's own menu is gated — Persona KYB and Sumsub want
a sales conversation, Middesk and Stripe Connect want business verification
first, and `POST /v1/accounts` answers 400 *'You can only create new accounts if
you've signed up for Connect'*. So the registry leg reads **GLEIF**, which is a
real third party answering real questions about real entities and is **not one of
the three vendors the brief names.** It is a substitution, it sits at the bottom
of a precedence ladder every named vendor outranks, and two environment variables
move it the hour one is available." That sentence is worth more in the room than
the label, because the label alone is the thing the trial fails people for.

Two consequences to volunteer with it. Making the leg honest **broke the core
loop** — every fictional business answers `not_in_lei_registry`, falls to
`needs_review`, and `canTransact()` refuses it — which is why the operator review
in §2.14 exists at all. And the deployed gate runs
`requireLiveEvidence: false`, so the one business that can move money on this
book does so on a named human's recorded judgement rather than on a vendor's
answer.

**`stablecoin` — the one that moved first, and the framing changed with it.**
For most of the build the honest sentence was "we hold twenty dollars of USDC and
zero wei of gas, so the rail can read the chain and cannot move a cent", after a
probe that called `balanceOf`, got a 200 and reported LIVE. Gas landed, and there
are now **two** confirmed payouts through **two** providers behind one interface:
`0xb47c5a36…86a1` (block 46,651,201, our own signer) and `0x251858a3…76fa`
(block 46,657,187, Circle). The probe reads the token balance, the gas balance
and the gas price together and claims live only if a transfer is fundable. **Say:**
"That slot was simulated this morning and the reason it is not any more is two
transactions you can open in a block explorer."

### 4.4 Three stale memo holds, and the invariant that cannot see them

**Say:** "Sixty dollars is withheld from nothing, the invariant that should catch
it is blind to it by construction, and that second fact is the worse one."

Three card holds on Ridgeline carry a `hold_closure` row while the event fold
still says they are open — all three with `reason = "authorisation fully
reversed"`, which is the signature of the clearing-first bug now guarded by
`terminallyClosed`. Availability treats them as released, so
`v_available_balance` reads 20000 of active holds while the live holds' memo
balances sum to 26000. And `v_hold_drift` is
`WHERE NOT is_released AND memo <> target`, so a spurious closure row puts the
row **outside the check by construction** — an invariant with a blind spot shaped
exactly like the bug it should catch, which is worse than no invariant because it
reports clean. Same class as the NUL byte that made the secret scanner skip 1,206
lines silently.

Why they are still there: `hold_closure` is append-only and `corgi_app` holds no
DELETE, which is the guarantee working. Cleaning them means inventing a
"supersedes a wrong closure" concept under deadline, and a repair script against
money rows under time pressure is a worse risk than three known-stale rows on the
safe side (they withhold nothing rather than double-withholding).

**Week two:** item 3 — widen `v_hold_drift` to compare `memo_balance_cents`
against `target_hold_cents` for *closed* holds too, so a spurious closure is
reported rather than excluded; then decide what supersedes a wrong closure row.

### 4.5 The cron runs daily, not hourly

**Say:** "This is a Vercel Hobby account and Hobby caps crons at once a day.
Worst-case latency, never worst-case correctness — and here is the line that
changes it."

The hourly schedule was rejected at deploy time with
`Hobby accounts are limited to daily cron jobs`, so `vercel.json` runs
`/api/drain` at `17 4 * * *`. If every `after()` nudge were lost, a row waits for
the daily tick. It is not lost: the inbox row is durable before any trigger runs,
the dispatcher re-claims rows whose lease has expired, and a row stays `pending`
until a consumer succeeds. If they ask "what if the nudge is lost", the answer is
"up to twenty-four hours on this plan". **Week two:** one line of `vercel.json`
and a paid plan.

### 4.6 The smaller ones, named before they are found

- **Eleven parked deliveries.** Correct behaviour, visible on purpose: card
  authorisations on Lithic cards never registered to a customer here, and the
  consumer will not guess whose money to move. Frame it as requirement 4 working
  rather than as a backlog — they are verified, durable, and they post the moment
  the card is claimed, because `unparkWaitingFor` wakes everything parked on that
  referent. What is missing is the *claim path* as a product surface:
  `registerCard()` exists in `src/lib/holds/store.ts` and is idempotent, and
  nothing outside the tests calls it, so clearing them today means running a
  function by hand. Week two, item 6 — "a queue whose only drain is a DBA is a
  queue that grows". (`docs/CUT-LIST.md` §2.4 says the only route is a
  hand-written INSERT; that is one revision stale, the function exists.)
- **Two dead sandbox credentials in git history.** Both rotated or already
  expired before the working tree was scrubbed. **Check the actual state before
  the debrief and say the true one:** `DECISIONS.md` 023 and `docs/CUT-LIST.md`
  §2.6 record the purge as blocked on a `filter-branch` plus force push that was
  not taken, while `docs/EVALUATION.md` Iteration 1 records it as rewritten and
  force-pushed. One of those is stale, and getting it wrong in the room is worse
  than either answer. Either way, the scanner now reads **every tracked file**,
  not just the staged diff, because the original only read the diff and by
  construction never re-examines an already-committed file.
- **The KYB module used to be unwired, and this bullet is kept because the shape
  of the correction matters.** It said nothing outside `src/lib/kyb/` imported the
  module, so the composite and its closed forgery routes were real and
  unreachable. That is no longer true: there is an onboarding route, the gate runs
  inside `requestPayment()`, and core-loop leg 1 presses it against the deployed
  URL and reads the refusal code back. What remains is narrower —
  `kybHealthReport()` still has no non-test caller, and wiring it naively would
  reintroduce the 021 two-opinions bug (§2.14).
- **Migration `0004` does not exist, and `scripts/migrate.mjs` has no gap
  detection.** It reads the directory, sorts, and applies what is there, so the
  absence is silent. A grader who lists `db/migrations/` will ask. The honest
  answer is that a numbering gap is not a missing migration and the applied set
  is complete — and that a runner that cannot tell those apart is a runner worth
  fixing, which is a few lines.
- **`RUN_DB_TESTS=1 pnpm test` runs against the production database.** Plain
  `pnpm test` is clean and fast (939 passed, 93 skipped, and `testTimeout` is
  30s because the 5s default was failing three live-fire attacks for being honest
  about how long a real webhook takes). But the database integration suites share
  one live database, which makes them order-dependent against each other *and*
  means a grader who runs them changes the demo and cannot undo it — the money
  tables are append-only. Say that **before** anyone types it. Week two: a Neon
  branch behind `TEST_DATABASE_URL`, with the runner refusing to start if it
  equals `APP_DATABASE_URL`.
- **`/api/sim` reads a different variable than the one documented.**
  `env.schema.ts` declares `SIM_CONTROL_ENABLED`; `src/app/api/sim/route.ts`
  checks `ACH_SIM_CONTROL_ENABLED` **and** `NODE_ENV !== 'production'`. Drift in
  the safe direction — setting the documented variable does not open the
  endpoint — but it is a mismatch, and the honest framing is that the belt held
  while the braces were mislabelled.
- **The MCP surface has no audit table.** It writes one structured JSON log line
  per call, with the full DDL sitting in a TODO in `src/lib/mcp/audit.ts`. The
  mitigation is real: the write tool's trail is already durable and immutable in
  `payment_instruction` and its `requested` event. Note the deliberate naming
  detail — the identity in the log is `grantFingerprint`, not `tokenFingerprint`,
  because the logger redacts any field whose name contains "token" and a field
  that is always `[redacted]` is a field that is not in the audit log.
- **The role switcher is a cookie and is labelled as one.** It grants nothing —
  `src/lib/approvals/session.ts` resolves the actor by a `SELECT` with a `WHERE`
  clause, so editing the cookie cannot produce an approver that is not already a
  seeded row, and the id is handed to the database which decides. Both `role.ts`
  and `session.ts` carry the disclaimer in capitals and name the one function that
  replaces it.
- **The MCP rate limiter is per process.** Across warm instances the effective
  limit is instances × limit. It is written down in `src/lib/mcp/ratelimit.ts`. It
  is not the control that stops an attacker — the token, the tenant scope and the
  approval queue are.
- **Several documents are stale in the under-claiming direction, and the list is
  now long enough to have its own section — §4.10, re-checked at 01:25Z.** The
  ones that are still open live there. Two examples of the drift running the
  *other* way, which is the reassuring half: README's decision-log count and the
  cut list's "pots are cut" row were both stale this evening and were corrected
  by their owners within the hour, and
  `src/test/livefire/attack-07-provider-outage.test.ts`'s header still records
  "`/api/health` reports 6 of 7 slots live", which was true at that commit and is
  7 now. Say it before they do —
  under-claiming is the safe direction, but only if you are the one who points at
  it, and the mechanical version, `node scripts/audit-claims.mjs`, covers the one
  claim that can fail the trial and none of the rest.
- **No authentication.** Cut on day one, never built, and `docs/DEMO.md` says so
  in its first section rather than presenting a role switch as a login.

### 4.7 The USDC payout's three honest gaps

**The opening sentence:** "The payout is real and confirmed. Three things about
it are not finished, and I would rather list them than have you find them."
`docs/STABLECOIN.md` §*What this does not do* is the written version, and it
carries three more (no durable intent table, a signer that is not constant-time
and is not a KMS, and a single confirmation).

**1. The ledger carries USDC in cents rather than as its own currency.**
`journal_line.currency` is `char(3)`, every seeded account is `'USD'`, and
`assert_entry_balanced()` requires **each currency in an entry to net to zero
independently** — so an entry whose debit is USD and whose credit is USDC cannot
balance, by construction, without an FX bridge account pair this chart does not
have. Widening the column would not fix that; it would move it. Chart account
1140 anticipated this and states its own unit — "carried in cents at 1 USDC = 100
cents … with sub-cent dust going to 2900 rather than being truncated" — which is
why there is no migration 0012. The two are still kept apart where they could
actually be added together by accident: `rails/types.ts` gives USDC its own
`Currency` code and the `Money` crossing the rail boundary is
`{ amount: 500000n, currency: 'USDC' }`; the narrowing to cents happens once,
visibly, at the posting boundary. USDC has six decimals, so 1.234567 USDC is
123.4567 cents and the four digits below the ledger's resolution post to a real
line (DR 124 / CR 123 / CR 1 to 2900) rather than being truncated. 0.50 USDC has
no dust and posts two lines.

**2. Gas is not posted.** Account 5300 ("Blockchain gas — USDC transfers") is the
right home and is deliberately empty. Gas is paid in ETH; the chart has no
ETH-denominated asset account to credit, and converting wei to cents needs an
ETH/USD rate this system has no live source for. **Inventing one would be worse
than the gap.** On Base Sepolia the figure is 269,058,000,000 wei — 2.7×10⁻⁷ ETH,
on the order of a tenth of a cent, so it rounds to zero cents and would be
rejected as a zero-amount line — but the accumulated figure is real on mainnet.
The actual `gasCostWei` is carried on the outcome and written into the entry
description, so nothing is lost, only unposted.

**3. Account 1140 does not reconcile to the wallet — CLOSED, and the way it
closed is the interesting part.** This used to read: the ledger says 1140 is
−$0.50, the chain says 19.50 USDC, and the difference is exactly the opening 20
USDC that arrived from the Circle faucet and never entered the books. It is
booked now, against a new `3200 Contributed capital — testnet funding`
(`scripts/book-usdc-funding.mjs`, key `usdc:opening-funding:circle-faucet`),
because an un-booked opening balance is a hole in the books rather than a
labelling problem. Today's live run of `node scripts/reconcile-usdc.mjs` is
**`RECONCILES`, exit 0**, 1,940 cents of ledger against 1,940 cents on chain
across **two** wallets.

And what it took to get there is §2.25: with the money in two wallets and 1140
being one omnibus account, the reconciler's old habit of reading a single address
reported 90 cents of drift against a ledger that was exactly right. A
reconciliation is at its most confident precisely when a new venue has just been
added, which is the last moment it should be — that is guard seven in §6.

### 4.8 Three definitions of "available", and they disagree by $30,662.10

**Say it first, in one sentence:** "Available is derived everywhere — there is no
stored balance — but *derived* is not the same as *agreed*, and this repo
currently derives it three ways from three different questions. That is the
weakest thing in the area you grade hardest, and here is the map."

| Where | What it means | Predicate |
| --- | --- | --- |
| `availableBalance()` — `src/lib/ledger/balances.ts:120`, used by `/accounts`, holds, standing orders, live fire | ledger − card holds − uncleared, over **every** line on the `2100` leaf | a hold counts as released only when a `hold_closure` row exists and is not reversed |
| `readBalanceCents()` — `src/app/(app)/funding/live-source.ts:137`, used by `/funding` and its receipt | the same four figures **as at a snapshot**: `value_date <= today AND booking_seq <= watermark` | same closure rule |
| `v_available_balance` — `db/migrations/0001_ledger.sql:1089` | the SQL view, built on `v_hold_state.is_released` | an uncleared credit is released **on the clock**: `now() >= available_at` |

The first two differ by **$30,662.10** on the seeded business, because the book
carries $37,212.00 of debits value-dated tomorrow and standing-order credits
dated 2027, and only one of the two applies a value-date predicate. That number
is not a discovery a reviewer makes — it is written in
`funding/live-source.ts:97` by the worker who found it, with the reason the
funding screen refuses to print both: *"a headline balance and a receipt on the
same page that disagree by $30,662.10 about the same account, at the same
instant, is a screen that has taught the reader its numbers cannot be trusted."*

**The third one is the sharper problem, and it is not cosmetic.** The view
releases an uncleared credit when the clock passes `available_at`; the function
releases it only when somebody writes a `hold_closure` row. The function that
would write that row, `releaseAvailableCredits()` (`plaid/adapter.ts:912`), has
**no caller anywhere in the repository** — not a route, not a cron, not a test.
`vercel.json` registers two crons and neither is it. So the honest answer to
"when does my $5,000 become spendable" is:

- on `v_available_balance`, at 09:00 ET the next banking day, with nothing
  running — which is the design as written; and
- on `/accounts` and inside a standing order's funds check, **never**, because
  no code path closes that hold.

And there is a third consequence worth saying before it is found:
`v_hold_release_drift` (0011:151) exists to assert "a released hold withholds
nothing". Because `is_released` goes true on the clock while the memo leaf still
carries the withheld amount, that invariant goes **non-empty the moment the hold
matures** — and nothing queries it. It is not in `dbcheck`'s 14, it is in no
test, it is on no route.

**Week two, in order:** wire `releaseAvailableCredits()` to the existing daily
drain (one import and one call — the function is written, tested and idempotent
by `hold_closure`'s own uniqueness), then collapse the first two definitions by
giving `availableBalance()` the snapshot predicate and letting the funding screen
delete its local copy. Do not do it in the other order: unifying the readers
while the sweep is unwired would make both screens agree on a number that is
wrong in the same direction.

### 4.9 Card controls: what the live decline proves, and what it does not

**Say:** "Three ASA decisions were taken by Lithic's own traffic against the
deployed endpoint, and one of them is a real decline. Everything else about this
feature is proven at a smaller radius than that, and here is the line."

**Proven with the provider in the loop**, `card_auth_decision` rows carrying
`source = 'provider'` (2026-09-11, and the enrolment is one call away:
`GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` → `{"enrolled": true, …}`):
a fail-closed decline at 601.5 ms when the control read blew its 600 ms budget;
three warm approvals at 14.3–15.1 ms under the fail-**open** rule for a card this
book does not hold; and the one to open in the room — `$50.00` at mcc 5542,
rule `mcc_blocked`, **147.4 ms**, our `UNAUTHORIZED_MERCHANT`, matched by Lithic's
own transaction `b1bd8d71-…`, status **DECLINED / UNAUTHORIZED_MERCHANT**,
network VISA, created 2026-09-11T00:44:10Z.

**Not proven at that radius, and do not let the sentence blur.** The *approve
under configured controls* branch has been driven against a live database in the
integration suite, not over HTTP by the provider — the warm approvals above are
rule 2, which approves precisely because the card is not under our control. The
limit rules (per-transaction, daily, monthly) are integration-tested with
`source = 'harness'` rows and a hard-coded latency. And `docs/CARD-CONTROLS.md`
§8 still reads as a to-do list for enrolment and says "Lithic is not currently
calling this system" — that document is stale in the under-claiming direction and
the database contradicts it; say so before they quote it back.

**Three more to volunteer.** The fail-closed decline cannot reliably leave the
row its own justification depends on (§3.13). A voided authorisation keeps its
daily-limit slot until the book window rolls — known, written down, not fixed. And
the ASA HMAC secret is fetched from Lithic at runtime with a ten-minute TTL, so a
cold instance during a Lithic **control-plane** outage cannot verify a signature
and refuses every authorisation — an availability dependency sitting in the auth
path, which is defensible and is not obvious.

### 4.10 The documents that are behind the system, named before they are read

Under-claiming is the safe direction, and it is only safe if you are the one
pointing at it. Everything below landed after the document that describes it, and
`node scripts/audit-claims.mjs` does **not** catch any of it — that script checks
the live/simulated count against the endpoint, which is exactly the class of drift
it was built for and exactly not this one.

**Checked at 2026-09-11T01:25Z, while three other documents were being rewritten
by the people who own them — so re-run this read on the morning rather than
trusting the table.** What it looked like at that instant:

| Document | What it still says | What is true |
| --- | --- | --- |
| `docs/CARD-CONTROLS.md` §7–§8 | ASA "is not deployed", "Lithic is not currently calling this system" | enrolled, deployed, seven provider-sourced decisions in `card_auth_decision`, one of them a real decline |
| `docs/STABLECOIN.md` §2 | booking the opening balance "needs an equity-contribution account the chart does not have" | `3200 Contributed capital — testnet funding` exists and the balance is booked; the reconciler exits 0 |
| `docs/KYB.md` | `KYB_FORCE_SIMULATED` currently suppresses the registry leg | unset in `.env`; **still set in `.env.example`**, so a fresh clone suppresses a working live integration |
| `src/lib/env.schema.ts` | `business_registry` provider label: "Stripe Connect (gated) — simulated" | the slot probes GLEIF and reads live — a live slot whose own label says "simulated", on the page you will be demoing |
| `src/lib/rails/types.test.ts` header | "three compile-time stubs" | two |
| `docs/EVALUATION.md` | 62/100, "what is absent is the wiring" | a fair verdict at 16:45 and not a current one (see the opener of this section) |

Two that were stale when this section was drafted and were fixed by their owners
within the hour — `README.md`'s "the stablecoin slot is simulated, no transaction
hash exists" and `docs/CUT-LIST.md`'s "pots are cut" — which is the pattern
working rather than an exception to it. Note that the cut list's replacement text
now says *"the subtree walk stayed recursive, which is what made adding the level
cheap"*: true of one half of `v_deposit_control_drift` and the reason the other
half went unexamined, so if they read that line, §3.15 is the answer.

The general version, which is the one they will actually take away: **this repo's
documents are written per feature by whoever built it, and no feature updates
another feature's document.** The mechanical check covers the one claim that can
fail the trial; everything else is convention, and convention drifted within
hours every time.

---

## 5. The findings to volunteer unprompted

These are the ones that show the work was done against reality. Get 5.1, 5.2 and
5.4 out early — they are the strongest evidence in the build that the design was
tested rather than described.

### 5.1 Lithic's `status` flips to SETTLED while a partial hold is still live

The docs contradict themselves on repeat clearings, so it was measured against
the live sandbox:

    authorize 1000            status=PENDING   hold=-1000  settled=0
    clearing 600  (partial)   status=SETTLED   hold=-400   settled=-600
    clearing 300  (2nd)       status=SETTLED   hold=-100   settled=-900
    authorize 5000            status=PENDING   hold=-5000  settled=0
    clearing 7340 (over-cap)  status=SETTLED   hold=0      settled=-7340

The answer was neither reading of the docs. A consumer that releases the hold on
`status == "SETTLED"` — the obvious implementation, and the one most candidates
will write — frees 400 cents that are still authorised. Second trap in the same
payload: `amounts.hold.amount` is signed **negative**, so a naive read gets the
direction wrong as well as the amount.

Both traps are avoided by reading neither field. `H(E) = 0 if closed(E) else
max(A − C, 0)` was derived from first principles *before* this measurement and
reproduces Lithic's own arithmetic in all three cases — 400, 100, and 0 on
over-capture. It agrees with the card network precisely where the provider's own
status field does not, which is what turned "no status column on
`card_authorization`" from a taste into an empirical result. (`DECISIONS.md` 006.)

### 5.2 An ACH return does not erase the settlement

Full lifecycle through the Increase sandbox: create $742.19 outbound, submit,
settle, return R01 insufficient funds. Two findings, both confirmed rather than
predicted. Increase has **no `settled` status** — a settled transfer stays
`submitted` and grows `settlement.settled_at`, so a consumer keying release off
`status` alone never releases one. And after the return, `settled_at` is still
populated and the original transfer id is unchanged: **the provider itself models
a return as a second money movement, not as an edit of the first.**

That decides a row in `rail_event_semantics` that is otherwise easy to get
backwards, and getting it backwards is the failure DESIGN §18.4 names as the
design's single biggest risk — one wrong row silently corrupts every past
statement it touches while all five invariants pass, the hash chain verifies, and
reconciliation stays clean. The provider's own behaviour now settles which way
the ACH row goes. (`DECISIONS.md` 019.)

### 5.3 Probe the capability, not the credential — wrong four times before it was right

Four probes reported a healthy slot that could not do its job, and every one was
caught by measuring rather than reading:

1. **A placeholder key marked a slot LIVE** because the string was non-empty
   (011). Fixed by making liveness a proven round trip, with four verdicts that
   must never be collapsed.
2. **Stripe answered `GET /v1/balance` with 200 while Connect was disabled**
   (015) — proves the credential and nothing about the capability the slot exists
   to provide.
3. **The USDC probe called `balanceOf`, got 200, and reported LIVE on a wallet
   with zero gas** (016). That one was worse than the others: it overstated a slot
   I was counting as one of two live integrations, in a README and in an email.
   We held twenty dollars and could move none of it — and the correction is the
   reason a payout exists at all (§5.4), because the probe was what forced the
   gas problem into the open instead of leaving it to be discovered in this room.
4. **The *fixed* Stripe probe called `GET /v1/accounts`** — which also returns 200
   with Connect disabled, because reading connected accounts is permitted when you
   have none and can create none (017). I replaced a wrong probe with a
   differently wrong probe and wrote a decision entry congratulating myself for
   it.

The rule that survived all four: **probe with the call the slot's real work
depends on, and confirm it fails when the capability is absent. A probe nobody
has watched fail is not a probe.** The Stripe probe is now a parameterless
`POST /v1/accounts` — Stripe evaluates the Connect entitlement *before* it
validates parameters, so the two directions are distinguishable and nothing is
created either way, which is what makes it safe from a health endpoint. Both
directions were measured.

**And there was a fifth.** `probeIntegrations()` had a fallback: a slot with no
probe inherited the env-derived status, so `card_webhooks` read **LIVE** with the
evidence string "no probe defined for this slot" — the 011 failure reintroduced
inside the module written to eliminate it, announced by an evidence string that
says nothing was proven while the label claims it was. I never looked at it
because I was checking the probes rather than the thing that runs when there is no
probe. Fixed with a new verdict, `unprobed`, rather than by widening an existing
one, because "we have not proven this" and "there is no credential" need
different words and both must read as SIMULATED. (`DECISIONS.md` 011, 015, 016,
017, 026.)

### 5.4 The transaction hash is computed before the broadcast, so it is the idempotency key rather than a receipt for one

The brief's own provider notes say a stablecoin payout that actually confirms on
a testnet is worth far more than a slide about one. This is that payout, and it
is verifiable by anyone in the room while you are talking:

    tx        0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1
    network   Base Sepolia, chain id 84532
    amount    0.500000 USDC (500000 minor units)
    nonce     0 — this wallet's first transaction ever
    receipt   status 0x1
    block     46651201 @ 2026-09-10T20:04:50Z
    gas       44843 used @ 6000000 wei = 269058000000 wei

    entry     9ab676c5-6c84-4124-bede-d2b9facf8558   rail usdc
              DR 2100/<business>  50
              CR 1140             50      balance 0
    value date 2026-09-10, from the BLOCK's own timestamp in book time

**The design idea, not the demo.** An Ethereum transaction hash is `keccak256`
of the signed transaction's own bytes; nothing about it is assigned by the
network. So the identifier for this money movement exists on our machine *before*
a byte goes over the wire, and `scripts/payout-usdc.mjs` prints it there —
`tx hash 0xb47c5a36…86a1 <- known BEFORE broadcast`. That is what makes it usable
as the **idempotency key**: `journal_entry.idempotency_key` is UNIQUE, so a second
posting of the same transfer is a no-op decided by Postgres. The alternative —
broadcast, then ask the node what it called the transaction — has a window in
which money has moved under a name we do not yet know, and that window is where
double spends live. The three crash points that fall out of it are §3.10, and the
one to lead with is the middle one: `getTransactionCount(pending)` already counts
the in-flight transaction, so the naive retry builds a second transfer at the next
nonce and pays twice. It refuses while `pending` and `latest` disagree.

**Say the value date out loud too.** It comes from the block's own timestamp
converted to America/New_York, not `Date.now()` and not when the receipt was
read — so a process restarted tomorrow that recovers yesterday's transfer still
posts it on yesterday, and a block at 02:00 UTC belongs to the previous New York
business day. `ledger.test.ts` pins that case.

**Volunteer §4.7 in the same breath.** The cents-not-USDC ledger, the unposted
gas and the wallet that 1140 does not reconcile to. The payout is the strongest
single artefact in the build and the three gaps are the reason it is worth
believing.

### 5.5 Lithic's card simulate surface is seven endpoints, and a debit clearing cannot be reversed at all

The brief's correction test says *a merchant reverses Tuesday's settlement on
Thursday*. On this provider you cannot do that directly, and finding out took
enumerating the surface with an empty body — an endpoint that exists answers
**400 "Missing required parameter(s)"**, one that does not answers **404**:

    exists (7)   authorize   authorization_advice   clearing   void   return
                 return_reversal   credit_authorization_advice
    404   (12)   credit_authorization  force_post  financial_authorization
                 correction  correction_debit  correction_credit
                 clearing_reversal  reversal  settlement  chargeback
                 dispute  expire_authorization

Then, against a transaction that had authorised $50.00 and cleared $73.40, the
three ways to reverse that clearing each fail differently:

    return_reversal   400  "Return reversal is not supported for debit transactions"
    void              201  appends AUTHORIZATION_REVERSAL; settled_amount unchanged
    clearing -7340    201  the sign is IGNORED; a second capture, settled 7340 -> 14680

**The third one is the finding.** It looks like it worked. A consumer that
trusted it would double the settlement and call it a correction. So the
correction path is driven where the provider actually supports it — a `return`
taken back by a `return_reversal` — and the code says so above the assertions
rather than in a document. Two caveats to give yourself: the enumeration is
recorded as a table rather than as a script, so re-derive it if it matters; and
the `void` row disagrees with an earlier measurement in
`src/lib/rails/lithic/README.md` (200, no event appended, no effect), which is
resolved in prose and not by a captured response. Say "these two measurements
disagree and here is which I would re-run" rather than picking one.

### 5.6 The ASA deadline is 6000 ms, the provider declines on expiry, and the deadline that actually fires is ours

Measured by stalling on purpose: enrol an ASA responder at a URL that sleeps for
twenty seconds, fire one simulated authorisation, and time it against a
no-responder baseline. **0.334 s → APPROVED** with no responder; **6.527 s →
DECLINED, `UNKNOWN_HOST_TIMEOUT`, `CUSTOMER_ASA_TIMEOUT`** with the stall. Two
facts fall out and both matter: the provider waits about **6.19 s**, consistent
with its documented 6000 ms, and **it fails closed** — a responder that goes
quiet declines the cardholder rather than waving the transaction through. That is
the opposite of the assumption most people make about a real-time decision hook,
and it changes the design: since silence declines anyway, there is nothing to be
gained by being slow, and everything to be gained by answering "no" early with a
record.

Which is why the deadline that actually fires is **600 ms, ours** — a tenth of
the provider's. It is a value returned from the store, not an exception thrown
past the decision, so "the control store did not answer" is an *input* to a pure
`decide()` rather than a hole in the control flow. The live row proves it fired:
601.5 ms, `control_store_unavailable`, `fail_mode "closed"`. Anyone quoting
"601 ms" as a provider timeout has conflated two numbers that are an order of
magnitude apart.

### 5.7 The ABA check digit catches every single-digit typo and cannot see a third of the transpositions

Swept over a fixed-seed corpus of 500 valid routing numbers:

    single wrong digit          40,500 cases   100.00% caught
    adjacent transposition       3,656 cases    89.03% caught
    transposition 3 apart        2,665 cases     0% caught
    transposition 6 apart        1,354 cases     0% caught

and the two failures are **structural, not statistical**, which is the whole
finding. The adjacent misses are exactly the digit pairs differing by **5** —
adjacent weight differences cycle −4, +6, −2, each sharing a factor of 2 with 10,
so the shift vanishes precisely when the digits differ by 5 mod 10. Three and six
apart are caught *never*, because the weight vector `3,7,1` repeats every three
digits, so those positions carry equal weights and the swap moves the weighted
sum by zero.

The design consequence is the second half. For an **invalid** number, every
weight is a unit mod 10, so there is exactly one repairing digit at each of the
nine positions: **nine repairs, always.** A "did you mean" list would be nine
equally likely guesses wearing the costume of help, so the screen offers none and
says to check the payee's own paperwork. And the provider will not do this for
you: Increase's `/routing_numbers` answers a checksum-invalid number with **200
and an empty list** — the same answer it gives for a real but unlisted bank. It
validates shape, not arithmetic.

### 5.8 Circle says CONFIRMED for a long time before it says COMPLETE

    t+0s      INITIATED   no txHash          the acknowledgement
    t+~10s    CONFIRMED   0x251858a3…        the money has moved
    t+181s    CONFIRMED   0x251858a3…        still not COMPLETE

`COMPLETE` is Circle's only success-terminal state, so a consumer that waits for
it waits minutes for a provider's opinion about a fact the chain settled in
seconds — and a poll timeout tuned to "Circle reaches a terminal state in
seconds" would have returned empty-handed on a transfer that had already
succeeded. The stop condition is therefore the **transaction hash**, after which
the chain is the authority: receipt `0x1`, block re-checked as canonical, and the
ERC-20 `Transfer` log re-matched against our own amount and recipient. The
provider is a broadcaster, not a witness. (The 180 s poll timeout in the code
still carries the comment that this measurement contradicts — it is a fair thing
for them to spot.)

---

## 6. Nine guards, one failure shape

If they take one thing away that is not about this repo, make it this. It is also
the one claim in here they can push back on, so it is worth having the
counter-argument ready.

    guard                         the exclusion                what it let through
    ----------------------------------------------------------------------------------
    1 v_hold_drift                WHERE NOT is_released        a wrong closure row
    2 secret scanner              plain grep                   1,206 lines after a NUL
                                                               byte
    3 escalation gate             slots.every(live)            any outage, once a slot
                                                               was honestly unprobed
    4 doc auditor                 "N of 7" only                it read past "4/7 live",
                                                               its own log's shorthand
    5 secret scanner v2           0x + 64 hex shape            would have fired on 24
                                                               curve constants, and a
                                                               rule that noisy gets
                                                               switched off
    6 v_deposit_control_drift     reported side was a flat     a pot: subtree 13,577,077
                                  code = '2100' filter         vs reported 13,527,077
    7 reconcile-usdc              one address from env         a second wallet: 90 cents
                                                               of "drift" against a
                                                               ledger that was right
    8 v_standing_order_double_    joins on a UNIQUE column     everything; the count it
      fire                                                     tests cannot exceed 1
    9 probe fromStatus()          any non-auth 4xx is `live`   a 404 — which Lithic
                                                               answers with no
                                                               credential at all

**Every one of those exclusions is shaped exactly like the failure the guard
exists to catch, and every one reported healthy while blind.** `v_hold_drift`
excludes released holds and the bug *is* a spurious release (§4.4). The scanner
skipped what looked binary, and a credential hiding past a NUL byte is precisely
what it would miss. The gate required *every* slot live, and an outage is what
makes a slot not live (§2.13, §4.2). The auditor understood one spelling of the
claim it guards, and the drifted document was written in the other spelling — its
own iteration log's. The shape rule matched 64 hex characters, and this repo's
honest constants are 64 hex characters (§2.16).

**And the four new ones, which are worse, because two of them are claims I made
myself.**

**Six.** `v_deposit_control_drift` carries a comment in its own migration saying
it was *"written as a subtree walk rather than 'sum the 2100 children' so that
adding a sub-account level later cannot silently break it"*, and `docs/CUT-LIST.md`
repeats it as a reason pots were safe to defer. Half true. The subtree side
recursed and saw the pot. The **reported** side was a flat `code = '2100'` filter
— the exact thing the comment promised it was not — and one pot with $500 in it
made the invariant report drift of exactly $500 (§3.15). The claim and the blind
spot were written into the same view, eight lines apart.

**Seven.** `scripts/reconcile-usdc.mjs` read one address out of the environment
and compared it against `1140`, an **omnibus** account. The moment a second
wallet existed it reported 90 cents of drift against a ledger that was exactly
right — and a reconciliation is at its most confident precisely when a new venue
has just been added, which is the last moment it should be. It enumerates wallets
at runtime now and **fails rather than reconciling against a subset**; and the fix
still carries a hole of the same shape, because `incomplete` can only be set
inside the branch that runs when `CIRCLE_API_KEY` is present (§2.25).

**Eight.** `v_standing_order_double_fire` joins `payment_instruction` to the
occurrence **on the idempotency key** and reports more than one instruction per
key. That column is UNIQUE. The count can never exceed one, so the view is
tautologically empty and detects nothing — and the failure worth detecting, two
instructions raised for one occurrence under *different* keys, is the one case it
cannot see. A test asserts it returns zero rows and presents that as evidence.

**Nine.** `fromStatus()` in the liveness probe treats any non-401/403 4xx as
`live`, reasoning that being told the request was wrong proves the credential was
accepted. Measured against the live sandbox while writing this document:
`GET /v1/not_a_real_endpoint` at Lithic answers **404 with the key and 404 with
no Authorization header at all**. A mistyped path or a retired endpoint would
therefore read as a live integration — the same failure as 011, wearing the
costume of the fix for 011 (§2.13).

**The one-line lesson: a guard must be tested against the thing it guards
against, not merely run.** Running it proves it does not crash. Only the failure
case proves it can see.

**The push-back to expect, and the answer.** *"That is just 'write a negative
test'."* It is more specific than that, and the extra specificity is what makes
it actionable: the negative test has to be constructed out of **the guard's own
exclusion clause** — the `WHERE NOT`, the `every`, the regex's one spelling, the
flat `= '2100'`, the single address, the `else` that means success. That clause
is the line nobody reads twice, because it is the part that was added to stop the
guard being annoying or to keep it cheap. Whoever narrowed it was solving a real
problem, which is why the narrowing always looks reasonable. The strong form of
the push-back is better still and worth conceding: *a guard whose exclusion you
cannot state in one sentence is not a guard you have understood* — and by that
standard three of the nine above were never understood by the person who wrote
them, and that person was me.

**There is one worked example of doing it right, and it is the one to show.** The
pots integration test re-runs the **original, broken** `v_deposit_control_drift`
predicate verbatim and asserts that it *would* have drifted by exactly the pot
balances, then asserts the new view is empty. That is the rule applied rather
than quoted: the negative test is built out of the clause that failed.

**The honest part, and say it.** The first four were found one at a time, each by
accident, by something else failing — an evaluator's clean scan, a README worker
refusing a claim it could not justify, a live-fire run, a stale checkpoint email.
The fifth was the first found by going looking, after the pattern had been written
down. Six and seven were **found by building the next feature**, not by auditing:
pots broke the view, and Circle broke the reconciler. Eight and nine were found
by running the rule on purpose over code that had not been read for it, which is
the first time in this build that the pattern was used as a tool rather than
recorded as a habit — and it took four minutes and two `curl`s to find the ninth.
The general rule came *after* the fourth instance, not before the first, and
claiming otherwise would be exactly the kind of tidying-up this document exists to
avoid.

**And the audit is still not finished.** Eight and nine are **open** — neither is
fixed, both are written down here and in `DECISIONS.md` with their week-two lines.
`v_hold_drift`'s blind spot is open too (§4.4), and `v_hold_release_drift` has a
different disease: it is correct and **nothing queries it**, so it will go
non-empty at 09:00 ET today without anyone hearing (§4.8). Seven invariant views
returned zero rows when this was written; that is a measurement, not a clean bill
of health for the guards nobody has read adversarially yet. `DECISIONS.md` 033 and
045.

---

## 7. A ten-minute demo script

Have two things open before you start: the deployed URL and a terminal with
`set -a; . ./.env; set +a` already run. Say the sentence, then let the number do
the work. Times are cumulative.

### 0:00 — `/api/health` — "start with the thing that can contradict me"

**Say:** "Every live-versus-simulated label in the README is computed by this
endpoint at the moment you load it, by a real authenticated call, and the
evidence column is the string the probe returned. If the README ever disagrees
with this page, the page is right."

**Point at:** `integrations.live` — **read the number off the page, do not quote
any number written down here**; every slot read live at the last measurement.
Then the `business_registry` row, and volunteer its qualifier rather than waiting
to be asked: its evidence string is *"GET api.gleif.org /v1/lei-records/{lei} ->
200 (Apple Inc.); GLEIF is a substitution for Middesk / Persona KYB / Sumsub KYB,
all gated"*, and its **provider** field still says "Stripe Connect (gated) —
simulated", which is stale in the safe direction and is on the screen. Then the
`stablecoin` row, whose evidence string is *"18.50 USDC and … wei gas — a
transfer is fundable"* and which reports live because a transfer can be paid for
and two were. Then `webhookHealth`, which is a
*different* question with a deliberately disjoint vocabulary
(`fresh | stale | quiet | never | unknown`) so a provider can be live and stale at
once with no contradiction to resolve.

**Volunteer:** "The count went *down* during this build before it went up, and
that is the point. `card_webhooks` used to read `live` off the back of a
non-empty `LITHIC_WEBHOOK_SECRET`, because a slot with no probe inherited the
env-derived status — announced by an evidence string that said 'no probe defined
for this slot' while the label claimed otherwise. It dropped to `unprobed`,
labelled SIMULATED, and stayed there until it earned a real probe: two
authenticated reads, the subscription list and that subscription's `/attempts`
log showing Lithic's own record of our endpoint answering 202. `stablecoin` went
the same way for a different reason — it was simulated while the wallet held
twenty dollars and no gas, and it is live because a payout confirmed on chain.
Nothing on this page is labelled by a string existing."

### 1:30 — `/accounts` → open **Operating ••4417**, then add `?auth=pending`

**Say:** "An authorisation moves available and does not move the ledger, and that
is structural: there is no code path from an authorisation to a financial
posting."

**Numbers on screen:**

    before                    ledger $48,215.60                        available $33,715.60
    after (?auth=pending)     ledger $48,215.60   holds $2,050.00      available $33,665.60
                              ledger delta $0.00        available delta -$50.00

**Then scroll to "How the available balance is derived":**

    ledger balance      $48,215.60
  − active holds         $2,050.00   (4 holds)
  − uncleared credits   $12,500.00   (1 pending · releases 09:00 ET)
  = available balance   $33,665.60

**Say:** "Four rows, exact, in integers, no clamp. And the Holds panel below
shows the arithmetic per hold — authorised, cleared, remaining — rather than a
verdict, because the remaining hold is `max(A − C, 0)` over the event set and not
a number any provider told us."

**Volunteer:** this account is a **fixture** and is badged as one; the state lives
entirely in the query string and nothing is written either way. There is no
`?auth=absent`, so the bare URL answers `ACCOUNT_NOT_FOUND` rather than quietly
showing a fixture.

### 3:00 — a real deposit account (the uuid-addressed rows, badged **live ledger**)

**Say:** "Nothing on this page came from a fixture. Those holds are real card
authorisations that arrived as signed Lithic deliveries, were verified, drained,
and posted to the memo book."

**Numbers:** `$46,877.93 − $200.00 − $0.00 = $46,677.93`, with the page stating
its **booking watermark** and its **as-of instant** — because a fold is only
meaningful with both clocks named.

### 4:00 — `/approvals` as Staff, then switch to Approver

**Say (as Priya Raman, badged *cannot approve*):** "Every approve control is
disabled with the reason attached, and the panel at the top names the trigger,
the SQLSTATE and the CHECK constraint. The screen is telling you in advance what
the database would do. It is not the check."

**Click Approver.** Header reads **Dana Okonkwo · can approve**. Payments raised
by Priya or by the agent become approvable; payments Dana raised herself are
marked **"that is you"** with reason `self_initiated`.

**Say:** "That is the whole maker-checker demonstration in one click. Nothing
about Dana's rights is wrong — she *is* an approver — so the refusal can only be
the maker-checker rule."

**Point at:** each row's **policy version** (`ach@2026-01-01`, threshold
$2,500.00, 1 approval), the count of distinct approvals held, and the **content
hash** — sha256 over account, rail, amount, destination and value date, which an
approval must cite, so an approval given for one amount cannot apply to another.

**Volunteer:** several rows were raised by **Corgi payments agent** over MCP. They
land in the same queue a person's do, they are labelled `agent`, and an approving
agent is not a row Postgres will store.

### 6:00 — `/reconciliation`

**Say:** "Last night's settlement file against our book, matched on the
provider's own reference and on nothing else. Three break categories, no more and
no fewer."

**Numbers:** file `livefire-…-tonight.csv`, matched 3 / 3, one open break, net
difference **+$240.71** — which is the published planted-break attack left where
it landed: live fire booked four inbound ACH settlements, imported the complete
file and reconciled it as a **control** (zero breaks), then deleted one row and
re-imported. The screen answers with the reference, `in_ledger_not_file`,
$240.71, and the entry id and value date attached.

**Say, pointing at "Runs over this file":** "A run is immutable, so re-running
appends a new run and never revises the old one — that is how 'was that break open
when we closed Tuesday' stays answerable weeks later. Breaks themselves are a
*view*, not a table, so one corrected ten minutes ago reads as corrected without
anything having repaired a row. And aging is measured in day closes, not hours: a
break does not get younger because the nightly job ran late."

### 7:30 — `/statements`

**Say:** "A statement is a (period, watermark) pair, not a period. v1 of a closed
day reproduces byte-identically forever because every row below its watermark is
immutable; when a correction lands with that day's value date we issue v2 and keep
both."

**Point at:** the *as published* and *as corrected* panels side by side, the
itemised late postings that explain the difference, and the content-hash
verification running **now** rather than being baked at build time.

**Volunteer:** the README and CUT-LIST still say this does not exist. It landed
after they were written.

### 8:30 — the terminal, three times

```bash
pnpm db:check
```

**Say:** "Connects as `corgi_app` — the role the application actually uses, not
the owner, because privileges never bind a table owner — and attempts UPDATE,
DELETE and TRUNCATE on `journal_entry` and `journal_line`. A success here is a
failure." **14 passed, 0 failed**, and the first six lines are `permission denied
for table journal_entry` / `journal_line`.

```bash
curl -X POST -H "Authorization: Bearer $DRAIN_TOKEN" \
  https://corgi-trial-psi.vercel.app/api/drain
```

**Say:** "And this is the one I would rather show than describe: the drain, on
demand, instead of waiting for the cron. The route stops at verified-and-persisted
because Plaid fails a delivery not answered in ten seconds and then retries for
twenty-four hours, so no consumer runs inline. The inbox row is durable before any
of the three triggers runs, so losing all three loses latency and cannot lose
money."

```bash
node scripts/payout-usdc.mjs
```

**Say:** "This already ran once, so watch what it does the second time. It reads
the chain, finds an ERC-20 `Transfer` from this wallet to that recipient for that
amount, and settles *that* transaction instead of sending a new one." The output
is `already on chain as 0xb47c5a36…86a1 — sending nothing`, `recovered yes`, the
same entry id `9ab676c5-…`, and `entries with this key 1`.

**Then say the thing that makes it work:** "The idempotency key is the
transaction hash, and the hash is `keccak256` of the signed bytes, so it exists on
this machine *before* the broadcast. That is why it is a key and not a receipt.
The alternative — broadcast, then ask the node what it called the transaction —
has a window where money has moved under a name we do not yet know." If there is
time, `--check` reads the chain and sends nothing, and §3.10 is the three crash
points. Volunteer §4.7's three gaps here rather than at the end.

### If they give you a fourth command, make it one of these

```bash
node scripts/coreloop.mjs            # the brief's seven arrows, against the URL
node scripts/reconcile-usdc.mjs      # two wallets, one omnibus account, exit 0
```

**Say, for the first:** "Seven legs, in the brief's own order, against the
deployed origin. It imports nothing from the application — it scrapes the
deployment's own forms and replays the server-action fields as
`multipart/form-data`, which is the request a browser with JavaScript disabled
makes. A skip alone makes the exit code 1."

**Say, for the second:** "This is the one that was wrong until a few hours ago.
`1140` is one omnibus account and the USDC now sits in two wallets, so reading a
single address reported ninety cents of drift against a ledger that was exactly
right. It enumerates the wallets at runtime now and refuses to reconcile against
a subset — and the fix still has a hole of the same shape, which is §6."

**And if the card controls come up, the row to read out is in the database, not
in a document:** `$50.00` at mcc 5542, rule `mcc_blocked`, **147.4 ms**, our
`UNAUTHORIZED_MERCHANT` — and Lithic's own transaction
`b1bd8d71-554a-46fc-b80a-fe90044868a8`, status **DECLINED /
UNAUTHORIZED_MERCHANT**, created 2026-09-11T00:44:10Z. Our record and theirs
agree to the second, which is the only version of this claim worth making.

### 10:00 — hand over

**Closing sentence:** "The last full live-fire run against production was seven
pass, zero fail, one skip — and a skip is not a pass, so it prints the sentence
naming exactly what could not be proven, and that one is deliberate. The core
loop is a separate seven-leg run against this URL and its last scoreboard was
seven pass, zero fail, **zero** skip. The decision log is 46 entries,
append-only, and the entries where I was wrong are still in it above the entries
that correct them — including two where the thing I was wrong about was a claim
about my own invariants. Point at anything."

**Before the debrief, re-run it** — `node scripts/livefire.mjs` — and use that
run's scoreboard rather than the recorded one, and run
`node scripts/audit-claims.mjs` so no document contradicts the endpoint on the
day. Attack 8 is sensitive to Lithic's rate limit, so a run that shared the
budget with something else can fail for a reason that has nothing to do with the
claim. If it does, say which.

**If they want to drive the code rather than the console:**
`node scripts/livefire.mjs --only 5` proves the maker-checker refusal at the
database with a raw INSERT and no application code in the call stack;
`--only 3` proves the corrected and as-believed figures are both true at once;
`--only 8` proves the replay dedupe against a genuinely signed provider delivery
with a tampered-signature negative control.

---

## Appendix — one-line file index for the tour

| Ask about | Open |
| --- | --- |
| The schema, immutability, `ledger_append()`, every view | `db/migrations/0001_ledger.sql` |
| Inbox states, lease, park, dead letter | `db/migrations/0002_webhook_inbox.sql` |
| `SECURITY DEFINER` hardening | `db/migrations/0003_harden_definer.sql` |
| Recon rejects, runs, the three break categories | `db/migrations/0006_recon.sql` |
| Payment lifecycle gate | `db/migrations/0007_approvals.sql` |
| View grants, the row lock without UPDATE, `card` | `db/migrations/0008_holds.sql` |
| Statement author + renderer version | `db/migrations/0009_statements.sql` |
| The only caller of `ledger_append()` | `src/lib/ledger/post.ts` |
| Both bitemporal axes as two predicates | `src/lib/ledger/balances.ts` |
| The one database handle, as `corgi_app` | `src/lib/ledger/db.ts` |
| `H(E)`, `closed`, `terminallyClosed` | `src/lib/holds/model.ts` |
| The seven-step apply path and the exactly-once argument | `src/lib/holds/apply.ts` |
| Lithic vocabulary → ours, and the three fields it refuses to read | `src/lib/holds/lithic-events.ts` |
| Verify → persist → 2xx, and the replay decision | `src/lib/webhooks/inbox.ts` |
| Claim, retry, park, dead-letter | `src/lib/webhooks/dispatch.ts` |
| The three triggers and why each fails differently | `src/lib/webhooks/drain.ts` |
| Matching on reference only, and why the diff ignores `recon_match` | `src/lib/recon/diff.ts` |
| Severity and aging as policy, in TypeScript | `src/lib/recon/aging.ts` |
| Why there is no self-approval check in application code | `src/lib/approvals/decide.ts` |
| Legibility layer, not the control | `src/lib/approvals/gate.ts` |
| Posting and event in one transaction | `src/lib/approvals/release.ts` |
| Four tools, closed list, forbidden parameter names | `src/lib/mcp/tools.ts` |
| Fail closed, token carries scope, database has the last word | `src/lib/mcp/auth.ts` |
| The tenant boundary, `businessId` first on every method | `src/lib/mcp/types.ts`, `gateway.ts` |
| The one write the agent can make, and everything it cannot | `src/lib/mcp/tool-initiate-payment.ts` |
| The eight refused operations and the rule underneath them | `docs/AGENT-LIMITS.md` |
| One `PaymentRail`, four methods, no ACH nouns at the top | `src/lib/rails/types.ts` |
| Increase has no `settled` status — the promotion line | `src/lib/rails/increase/client.ts` |
| The seven awkward ACH cases a sandbox will not produce | `src/lib/rails/achsim/engine.ts` |
| `status` is not the hold — the second opinion | `src/lib/rails/lithic/client.ts` |
| Correction vs new event, one row per provider event type | `scripts/seed.mjs` (`rail_event_semantics`) |
| Our own adversarial score, and what it says is missing | `docs/EVALUATION.md` |
| What was cut, what is deliberately unfinished, week two | `docs/CUT-LIST.md` |
| Five liveness verdicts, earned by a round trip | `src/lib/integrations/probe.ts` |
| Five freshness verdicts, disjoint by construction | `src/lib/integrations/delivery-health.ts` |
| Why the escalation gate is `some` and not `every` | `src/app/api/health/route.ts` (the comment above `integrationLive`) |
| The outage induced, and both gate shapes asserted | `src/test/livefire/attack-07-provider-outage.test.ts` |
| The payout: refuse, sign, broadcast, wait, state an outcome | `src/lib/rails/stablecoin/adapter.ts` |
| The hash that exists before the broadcast | `src/lib/rails/stablecoin/tx.ts` |
| Minor units → balanced cents; block timestamp → value date | `src/lib/rails/stablecoin/allocation.ts` |
| Only a `ConfirmedPayout` can reach the ledger | `src/lib/rails/stablecoin/ledger.ts` |
| The transaction, the three crash points, and what it does not do | `docs/STABLECOIN.md` |
| The commit gate, and the shape rule that was replaced | `scripts/precommit.sh`, `.secretscanignore` |
| Every document checked against the live endpoint | `scripts/audit-claims.mjs` |
| Every decision, in order, including the reversed ones | `DECISIONS.md` |
| The brief's seven arrows as seven legs against the deployed URL | `scripts/coreloop.mjs` |
| A correction at the original value date, routed by a table row | `src/lib/holds/corrections.ts`, `src/lib/rails/semantics.ts` |
| The occurrence, and the key Postgres computes with `EXTRACT`/`lpad` | `db/migrations/0012_standing_orders.sql` |
| Refuse-and-close, checked against available, all four figures kept | `src/lib/standing/types.ts`, `fire.ts` |
| Plaid link/item/auth, and the uncleared-credit hold | `src/lib/rails/plaid/adapter.ts` |
| Banking days, the Fed's Saturday rule, 09:00 ET across DST | `src/lib/rails/plaid/availability.ts` |
| GLEIF, and the four endpoints that decide nothing on their own | `src/lib/kyb/gleif.ts` |
| Nine constraints, the composite FK, and why MATCH SIMPLE matters | `db/migrations/0013_kyb_manual_review.sql` |
| A review may never clear a decline — in code, not in SQL | `src/lib/kyb/manual-review.ts` |
| A pot is a node in the account tree, and the view that broke | `db/migrations/0015_pots.sql` |
| The ABA sweep, the ±5 misses, and the nine repairs | `src/lib/payees/aba.ts`, `aba.test.ts` |
| Block on arithmetic, warn on judgement — and the throw that enforces it | `src/lib/payees/verify.ts` |
| 600 ms of ours inside 6000 ms of theirs, and a pure `decide()` | `src/lib/cards/budget.ts`, `decide.ts` |
| The responder Lithic actually calls | `src/app/api/webhooks/lithic-auth/route.ts` |
| Two providers, one interface, and the refusing unconfigured one | `src/lib/rails/stablecoin/circle-provider.ts`, `circle-registry.ts` |
| Wallets enumerated at runtime; failing beats reconciling a subset | `scripts/reconcile-usdc.mjs` |
