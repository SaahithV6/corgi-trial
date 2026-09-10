# Debrief preparation

75 minutes, and they drive for 65 of them. The failing condition is code you
cannot explain when someone points at it. This document is the 30-minute
version of the whole build: the five ideas everything else hangs off, a file
tour, the questions a hostile expert actually asks with answers that cite a
file, the weak spots said out loud before they are found, three things to
volunteer, and a ten-minute demo.

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
| 14–20 | **§5**, the three findings | Get 5.1 and 5.2 into the first fifteen minutes of the debrief. |
| 20–26 | **§6**, the click path | Walk it once in a browser while reading, so the numbers are familiar rather than surprising. |
| 26–30 | **§3.1, §3.5, §3.6** | The three questions most likely to be asked first and hardest. |

**§2 is reference, not reading.** It is one entry per module, ordered by the
path money takes; open it when they point at something. The appendix at the
bottom is the same thing as a one-line lookup table.

**Before the room:** run `node scripts/livefire.mjs` and `pnpm db:check` against
the final commit, load `/api/health`, and use those numbers rather than any
figure written down here — everything quoted in this document was true when it
was measured and some of it moves every time a webhook lands.

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

`POST /api/mcp`, Model Context Protocol over Streamable HTTP, four tools:
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
`initiateCredit` in that. USDC has no adapter (research draft only) and
`internal` is a `RailKind` with nothing behind it. What holds the interface
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

**Know the number before you quote it.** Everything now says **4 live of 7** —
README, DEMO, the T+24h email and the endpoint — after `card_webhooks` moved
from `live` to `unprobed` when the fallback bug was fixed. It briefly disagreed,
which is the point: docs drift from systems, so read `/api/health` on the day.
Load `/api/health` on the day and read its number, and if they notice the
difference, that *is* the answer: one fewer claimed integration is a better score
on integration reality, not a worse one, because the rubric grades honest
labelling and the brief calls presenting a simulated integration as live the
fastest way to fail the trial.

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

**One caveat to own before they find it:** `fromStatus()` in `probe.ts` maps a
non-auth 4xx to `live`, on the reasoning that being told the request was wrong
proves the credential was accepted. That is the one place a non-2xx earns LIVE.
It is deliberate — it is what makes the parameterless `POST /v1/accounts` Stripe
probe work at all, since a Connect-enabled account answers with a
parameter-validation 400 — but it is a rule worth stating rather than being
caught by.

### 2.14 KYB — `src/lib/kyb/*`, `db/migrations/0005_kyb.sql`

A composite of two legs: director KYC (live, on Stripe Identity) and business
registry (simulated). The composite degrades its own evidence label to
`simulated` when either leg was.

**Questioned:** *"Why is the registry leg simulated?"*
**Answer:** every KYB option on the brief's own menu is gated. Persona KYB and
Sumsub want a sales conversation; Middesk and Stripe Connect require completing
"Verify your business" first. Measured rather than read off a support page:
`POST /v1/accounts` returns 400 *"You can only create new accounts if you've
signed up for Connect"*. I stopped there rather than invent a company to get past
a form. The simulator sits behind the same interface as the real leg, is typed
`KybLegProvider<'simulated'>` so it cannot claim otherwise, and prefixes every
reason string with `simulated:` so a screenshot of the evidence pack cannot be
mistaken for a provider's own words.

**The mechanism worth showing if they push:** `CompositeKybResult` has no
`evidence` field — it has a private `#legs` and an `evidence` *getter* that folds
`degradeEvidence()` over the legs. Six forgery routes are closed and each is
asserted by `composite.test.ts`: private `#legs` makes the class nominally typed
so no object literal satisfies it; the constructor is private so it cannot be
subclassed; `Object.freeze(this)` blocks `defineProperty`;
`Object.freeze(prototype)` blocks a getter swap; `rehydrate()` takes legs rather
than a stored label, because a stored `kyb_status` is a cache and if the row
disagrees with the legs the legs win; and the type-level `DegradeEvidence<A,B>`
returns `'live'` only when both are. The same rule is restated a fourth time in
Postgres: `v_business_kyb` derives evidence with `bool_and(evidence = 'live')`,
and a CHECK refuses a leg row claiming `live` while carrying a simulator's mark.
The counter-intuitive branch to defend is `failedLeg()`: a provider that does not
answer is labelled **simulated**, not live — we wrote that row, and labelling it
live would claim a third party said something when no third party said anything.

**Say this before they grep for it.** Nothing outside `src/lib/kyb/` imports the
module — it is fully unwired, there is no onboarding route, and
`kybHealthReport()` has no non-test callers. `src/lib/kyb/README.md` §4 shows a
line `kyb: kybHealthReport(env),` as being in `/api/health`'s response body and
it is not. That is a documentation overclaim of exactly the class this build
docks itself a point for, and it should be corrected or struck rather than
defended. Related: `PERSONA_INQUIRY_TEMPLATE_ID` and `KYB_FORCE_SIMULATED` are in
neither `env.schema.ts` nor `.env`, so in this deployment the director leg could
not select Persona even with a key. And if the module *were* wired to
`/api/health` unchanged it would reintroduce the 021 two-opinions bug, because
`selectRegistryLeg` marks the Stripe leg live on key presence alone while
`probe.ts` proves that same credential cannot do the job.

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
and queue one payment request. That is four tools and the list is closed.

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

### 3.10 Others they are likely to ask

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
delta. And the evaluator disclosed its own damage: it ran the suite against the
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

### 4.2 Live-fire attack 7 — the outage was invisible, and the fix landed after the last run

**Say:** "At the last recorded live-fire run this skipped, because `/api/health`
reported credential liveness and nothing about delivery freshness. Both missing
pieces have since landed and I have not re-run live fire against them, so I am
not claiming it passes — here is the command that decides it."

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

**Command:** `node scripts/livefire.mjs --only 7`.
**Week two:** run it, and if it passes, update `src/test/livefire/README.md` §4
and `docs/CUT-LIST.md` §2.5, which both still describe it as missing.

### 4.3 The two simulated slots

**`business_registry`.** Say: "Every KYB option on the brief's own menu is gated,
and I measured that rather than reading it off a support page." Persona KYB and
Sumsub want a sales conversation; Middesk and Stripe Connect require business
verification first; `POST /v1/accounts` returns 400 *"You can only create new
accounts if you've signed up for Connect"*. The registry runs behind the same
interface as a labelled simulator and the composite degrades its own evidence
string. **Week two:** it is not on the list — the honest position is that this
slot cannot be made live inside a trial, and the fix is a Middesk or Persona KYB
sales conversation, not code.

**`stablecoin`.** Say: "We hold twenty dollars of USDC and zero wei of gas, so
the rail can read the chain and cannot move a cent." The probe used to call
`balanceOf`, get a 200, and report LIVE. **Week two:** item 5 — gas from Coinbase
CDP, then a payout that confirms on Base Sepolia. It is blocked on a faucet, not
on code, and it is the difference between five live slots and six.

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
- **The KYB module is unwired and its README overclaims.** Nothing outside
  `src/lib/kyb/` imports it and `kybHealthReport()` has no callers, so the
  composite, the six closed forgery routes and the four-layer honest-labelling
  argument are all real and none of them is reachable from a running request.
  Week two: an onboarding route, plus wiring `kybHealthReport` in a way that does
  not create a second opinion about liveness (see §2.14).
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
- **Several documents are stale in the under-claiming direction.** README says
  "24 entries" (there are 26) and that there is no statement renderer; CUT-LIST
  §3.4 and `src/test/livefire/README.md` §4 say the same, and CUT-LIST §2.5 says
  delivery freshness is missing. All of those landed after the docs were written.
  Say it before they do — under-claiming is the safe direction, but only if you
  are the one who points at it.
- **No authentication.** Cut on day one, never built, and `docs/DEMO.md` says so
  in its first section rather than presenting a role switch as a login.

---

## 5. The three findings to volunteer unprompted

These are the ones that show the work was done against reality. Get at least the
first two out early — they are the strongest evidence in the build that the
design was tested rather than described.

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
   We hold twenty dollars and can move none of it.
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

---

## 6. A ten-minute demo script

Have two things open before you start: the deployed URL and a terminal with
`set -a; . ./.env; set +a` already run. Say the sentence, then let the number do
the work. Times are cumulative.

### 0:00 — `/api/health` — "start with the thing that can contradict me"

**Say:** "Every live-versus-simulated label in the README is computed by this
endpoint at the moment you load it, by a real authenticated call, and the
evidence column is the string the probe returned. If the README ever disagrees
with this page, the page is right."

**Point at:** `integrations.live` — **read the number off the page, do not quote
the README's 5**; it is 4 of 7 as of the last measured run, because
`card_webhooks` moved to `unprobed`. Then the `simulated` rows and their evidence
strings — *"Connect not enabled…"* and *"holds 20.00 USDC but only
0 wei gas; a transfer needs ~390000000000 — cannot send"*; then `webhookHealth`,
which is a *different* question with a deliberately disjoint vocabulary
(`fresh | stale | quiet | never | unknown`) so a provider can be live and stale at
once with no contradiction to resolve.

**Volunteer:** "The count went *down* during this build and that is the point.
`card_webhooks` used to read `live` off the back of a non-empty
`LITHIC_WEBHOOK_SECRET`, because a slot with no probe inherited the env-derived
status — announced by an evidence string that said 'no probe defined for this
slot' while the label claimed otherwise. It now reads `unprobed`, labelled
SIMULATED. What actually backs that slot is stronger than a probe would be: the
endpoint is registered at Lithic, real signed deliveries arrive, and they drain
into journal lines — but the page will not claim what it has not proven."

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

### 8:30 — the terminal, twice

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

### 10:00 — hand over

**Closing sentence:** "The last full live-fire run against production was six
pass, zero fail, two skip — and a skip is not a pass, so each one prints the
sentence naming exactly what could not be proven. The decision log is 26 entries,
append-only, and the entries where I was wrong are still in it above the entries
that correct them. Point at anything."

**Before the debrief, re-run it** — `node scripts/livefire.mjs` — and use that
run's scoreboard rather than the recorded one. Two reasons: attack 7's two
missing halves have landed since, and attack 8 is sensitive to Lithic's rate
limit, so a run that shared the budget with something else can fail for a reason
that has nothing to do with the claim. If it does, say which.

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
| Every decision, in order, including the reversed ones | `DECISIONS.md` |
