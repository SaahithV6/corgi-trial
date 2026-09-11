# `/dashboard` — the triage board

The screen an operator opens at the start of a shift.

This build has 21 screens. Opening it otherwise means already knowing which one
holds the thing that is wrong, which is exactly the knowledge a person starting
a shift does not have. The material for the answer was already computed — 30
invariant views, four of them deliberately red with arguments behind them, an
approvals queue, parked deliveries, dead letters, unattributed inbound credits,
recon breaks with aging, an audit trail over 39 action stores — and it was
spread across 21 places.

**It is not a metrics dashboard.** There is no counter on it that only ever goes
up. Every figure is either a queue depth that falls when somebody does the work,
or a comparison against something written down that is either matched or not.
"1,439 webhooks processed" is wallpaper and it is deliberately absent.

Three questions, in this order, and the order is the product.

---

## 1 · Is anything wrong right now?

### What it shows

Every view in `INVARIANT_VIEWS` — the gate's own list, 30 of them — read at one
instant through `readInvariants()` from `src/lib/chaos/observe.ts`. That is the
same function and the same list the chaos dashboard uses and that
`src/lib/chaos/invariants.test.ts` holds equal to `scripts/dbcheck.mjs`. This
screen does not have a second copy of the list and does not issue a second kind
of read.

Each reading is then put in one of six **bands**, and the band is the whole
screen:

| band | meaning |
| --- | --- |
| `unreadable` | the view could not be read. Never a pass, never folded into the counts. |
| `new` | red, and **not on the register**. Nobody has written down why it stands. |
| `grown` | on the register, and returning **more** rows than the register witnessed. The excess is ranked here, with the new findings. |
| `decided` | on the register, matching the watermark. Red on purpose, with the argument and the citation printed beside the count. |
| `shrunk` | on the register, returning **fewer**. Somebody repaired part of it; the watermark in the file is stale. |
| `holding` | zero rows, nothing on the register. |

### Where every number comes from

| figure | source |
| --- | --- |
| rows per view | `SELECT count(*) FROM <view>`, via `readInvariants()` |
| the claim beside each view | `INVARIANT_VIEWS`, the gate's own wording |
| the watermark | `DECIDED` in `src/components/dashboard/decided.ts`, copied from a named `dbcheck` run |
| the grouped breakdown under a red | the view's **own** classifying column — `verdict`, `finding`, `closure_source`, `is_released` |
| the witness rows | up to five rows of the view itself, ordered by the money column it names |
| `as of` / booking watermark | `readSnapshot()` — the ledger's own `clock_timestamp()` and `MAX(booking_seq)` |

### How a deliberate red reads differently from a new one

Both are red. They are the same fact — a view that must return zero rows is
returning rows — and painting the decided ones green would be the screen
overruling the gate. What separates them is:

1. **Band and position.** `new` and `grown` sit above `decided` on the page.
   The band header says, in prose, that nobody has argued for these.
2. **The argument.** A decided red carries four things the new one cannot: the
   argument in one paragraph, the population it ranges over, whether it is
   repairable at all, and the migration or document the argument lives in. A
   `new` red instead carries the sentence *"Nothing on this screen explains
   this. It is not on the register, so no argument has been written for it.
   Either write one — with a citation — or repair it."*
3. **The headline.** `headline()` says `Nothing new. 4 views red, every one of
   them on the register…` only when `unexplained === 0` and `unreadable === 0`.
   The moment either is non-zero the headline changes to name it.
4. **The counts.** `standingRows` is every red row on the book;
   `unexplainedRows` is only the part no argument covers. On this book today
   those read **274** and **0**.

The four on the register, with today's reading:

| view | rows | why it stands | citation |
| --- | --- | --- | --- |
| `v_refused_auth_hold` | 257 | every row is `unanswered` — no verdict was ever observed. 0032 repaired the `refused` half (12 holds, $600.00). You cannot repair an unanswered event by inventing the verdict nobody recorded. | `0032_guard_repairs.sql`; `dbcheck`'s `explain()` |
| `v_hold_expiry_drift` | 12 | `v_card_auth_hold` and `ledger_availability()` read two different `expires_at` columns; that they agree is a convention inside one function, not a constraint. Every row is released and withholds $0.00. | `src/lib/chaos/invariants.ts` (0040) |
| `v_advice_delta_unsound` | 1 | red on arrival by design. The conversion is fixed (`base = max(A,0)`); the stored row is not repairable, because the only compensation is a second event the network never sent. | `0043_auth_floor.sql`; `docs/FUZZ.md` |
| `v_hold_closure_unexplained` | 4 | a test fixture's closures, declared `test_harness`, over $132.00 the fold still says is authorised. 0043's header prices both repairs and both are worse. | `0043_auth_floor.sql`; `docs/HOLDS.md` §10.4 |

### Drill-through

The rule this screen is built to is that **a number you cannot get to the rows
of is a claim**. Each red view is read on its own terms — four bespoke
`SELECT`s, because the four views do not share a shape — and the result is a
group table (the same breakdown `dbcheck`'s `explain()` prints) plus up to five
witness rows.

Where a witness names a hold, its identifier links to
`/accounts/holds/<holdId>`. Where it does not — `v_advice_delta_unsound` names
an **event**, and this build has no per-event screen — the identifier is printed
as text and the panel says so rather than linking somewhere the row is not.

A red view **not** on that list of four gets no drill-through at all, and the
card says exactly that: *"It was not red when this screen was written, so
nothing here knows which of its columns identifies a row — and guessing would be
the screen inventing a taxonomy for rows it did not produce. Read it directly:
`SELECT * FROM <view>;`"*

### The comparator, and why the watermark is a literal

`src/lib/chaos/baseline.ts` is the shape this follows, and its rule is
explicit: capture the baseline from the live database at the start of a run,
never write it as a literal, because the standing populations move and *"a
hard-coded 212 would be a second lie with a shorter half-life than the first"*.

That rule is right for a chaos run and it cannot be obeyed here, for a reason
worth stating rather than working around: **a dashboard is a single reading. It
has no start-of-run to capture at.** One instant cannot tell you whether 257
rows are the accepted finding or a fresh incident of the same size.

So the comparison point is written down **with its provenance** — `witnessed`
plus `witnessedAt`, copied from a named `dbcheck` run — and rendered as a
watermark, never as a licence. Growth against it is reported as new; a shrink is
reported as a *stale watermark*, and is deliberately **not** lowered at render
time, because a literal that edits itself is exactly how one repair buys
permanent headroom. Lowering it is a two-line edit to `decided.ts`, made by a
person who has looked.

### Limits this panel states on its own face

- **It reads row counts only.** `readInvariants()` issues `SELECT count(*)`. It
  does **not** read GUARD REACH — the population each view ranges over — which
  `node scripts/dbcheck.mjs` prints. A zero here is a statement about the rows
  the view can see, and for several of these that is smaller than the claim.
- **`v_internal_transfer_impure`'s population is the writer's own label.** It is
  `rail = 'internal' AND idempotency_key LIKE 'pot:%'` — not a structural fact.
  $50.00 was moved out of a pot into `1000 Cash at bank` under an `ach:` key and
  this view, pot identity-drift and deposit-control all stayed at zero. GUARD
  REACH measures it at **20 of 88** rows; 68 (77%) are outside it by
  construction. The structural version keys on
  `journal_line.account_id IN (SELECT account_id FROM pot)` and does not exist
  yet — `docs/POTS.md` §10.3.
- **`v_member_approval_without_right` resolves partly by name, not by join.** It
  used to INNER JOIN `team_member`, so a principal with no membership of that
  business fell out of the FROM clause entirely — 33 of 186 approvals, neither
  judged nor reported. Migration 0046 widened it and GUARD REACH now reads
  **207 of 207**. But *judged* is not *checked by a join*: of the 207, **165 are
  permitted by name** as Corgi staff break-glass and 42 by membership. A zero
  means nobody unauthorised among the 42.
- **`v_hold_closure_not_terminal` ranges over 189 of 320 closures**, by declared
  writer; 131 (41%) are outside it. 52 excluded `repair` rows and 4 excluded
  `test_harness` rows carry the guard's own defect shape ($2,551.00 / $132.00).
- **`v_interchange_unreversed` ranges over 107 of 312** interchange postings.
- **`v_accrual_month_drift`'s population is empty** — 0 complete accrual months.
  It is green because there is nothing to be green about, which is not the same
  statement as its claim.

Each of those prints next to the view it belongs to, not in a footnote, and it
prints whether the view is red or holding.

---

## 2 · What is waiting on a human?

Five queues. The framing matters: **none of these is a failure.** Every one is
the system declining to guess, and the correct response to all five is a person,
not a retry.

| panel | source | drill-through |
| --- | --- | --- |
| Payments awaiting a second approver | `listQueue({ pendingOnly: true, limit: 200 })` — "pending" is the ABSENCE of a closing event, defined in SQL once | `/approvals` |
| Disputes awaiting a decision | `v_dispute_state`, using its own boolean columns (`needs_authorization AND NOT granted AND NOT declined AND NOT is_closed`) | `/disputes` |
| Reconciliation breaks, by age | `loadReconView({})` — the same read `/reconciliation` renders, severity and bucket from `src/lib/recon/aging.ts` | `/reconciliation?break=<kind>:<key>` |
| Parked deliveries | `readParkedByKind()` — grouped by `parked_on_kind` / `parked_on_ref`, with the consumer's own refusal verbatim | the referent id is printed; registering it drains the group |
| Dead letters | `v_webhook_dead_letter`, grouped by provider and referent kind, carrying the newest one's own `processing_error` | cleared by `scripts/redrive.mjs` |
| Inbound credits nobody can attribute | `v_inbound_ach_unattributed` — one row per transfer, however many deliveries it produced | the transfer id, printed |

### Ranking

Never by a score. Each queue is ordered by what its own rows say:

- approvals, by age of the oldest still-pending instruction;
- breaks, by `recon/aging.ts`'s own ladder, which is about **day closes**, not
  money — `aged` means somebody signed off a book day with this break open. This
  screen imports that order rather than restating it;
- parked, by how many deliveries wait on the same referent;
- dead letters, by count, with the oldest age the view itself computed;
- credits, by when the transfer was first seen.

**There is no cross-queue ranking.** An approvals queue and a recon break are
not commensurable, and collapsing them into one number is how a dashboard starts
lying.

### Limits this section states

- **The approvals count can be a floor.** `listQueue` caps at 200. When the page
  is full the screen prints "at least" and adds, in red, that the "oldest" shown
  is the oldest *on the page*, not on the book. On this book today the queue is
  **at the cap** — 200 read, 154 of them above threshold — so that note is live.
- **The breaks panel is scoped to one run and the book is not.**
  `/reconciliation` shows a (file, booking watermark) pair, which is how an ops
  team works; this panel shows the same run so every break links to a row that
  screen will actually contain. Across every file ever ingested there are
  **1,693** open breaks in `v_recon_break`. That figure is printed, is stated to
  be **not drillable from this screen**, and is stated to be **not comparable**
  with the run count — no screen in this build lists breaks across files.

---

## 3 · What did the machine do while I was away?

### The limit comes first, because it changes how every number below reads

**There is no cron-run table in this schema.** Nothing records that a tick
happened, what it answered, or how long it took. What this panel reads is the
**effect** of a tick — the newest row in the store each job writes into — and
three things follow, all printed at the top of the section:

1. A tick that ran and had nothing to do **writes nothing**. "No trace since
   Tuesday" cannot distinguish a job that stopped from a job with an empty
   in-tray. Several sweeps in this build ran for days doing exactly that and
   reported success.
2. A tick that **failed** writes nothing either. An HTTP 500 on a schedule is
   invisible here, and invisible in the database generally: the status code
   lives in the platform's function log, which this runtime cannot read.
3. A trace can be written by something that is **not** the cron. The
   standing-order refusals carry `decided_by_run`, and its prefix is the only
   thing that says whether a tick (`standing-…`) or a test harness (`test-…`)
   wrote the row. That column is printed for exactly this reason, and on this
   book **every recorded standing-order outcome carries a `test-` prefix**.

The fix for all three is a run-log table written by the route itself — one row
per tick, with its verdict and its duration. That is a migration, and it is
outside this screen's write scope. **It is the follow-up this document names.**

### What it shows, and where each number comes from

| panel | source |
| --- | --- |
| The five scheduled jobs | paths and cron expressions copied from `vercel.json`; `lastTraceAt` / `traceCount` from the store named beside each one |
| Webhook consumers, per provider | `readWebhookProcessing()` then `webhookProcessingHealth()` — the two functions `/api/health` itself calls, so the screen and the JSON cannot disagree. Verdicts are theirs: `consuming`, `backlogged`, `dropping`, `superseded`, `never_consumed`, `idle`, `unmeasured` |
| What the standing-order tick refused | `standing_order_outcome` where `disposition = 'refused'`, with `refusal_code`, the reason verbatim, and the availability terms it observed |
| Hold closures by declared writer | `hold_closure.source` — the same partition `dbcheck`'s GUARD REACH block prints |
| Outbound deliveries | `outbound_delivery` by state, with `last_status` |
| Non-human actions | `v_actor_action` filtered to `actor_kind <> 'human'`, ordered by `recorded_at` |
| What the trail does not cover | `loadCompleteness()` — the same read `/audit` renders |

Two details that are decisions, not defaults:

- **`recorded_at`, not `occurred_at`.** For a ledger entry `occurred_at` is its
  value date and can be in the future. Two clocks; this section is about when
  the book *learned*.
- **Outbound is the one place a status code is recorded**, because there the
  deliverer is the client and writes back what it got. That asymmetry with the
  inbound cron ticks is the whole point of the note at the top.

### The audit trail's account of its own gaps

Printed rather than summarised: 39 sources projected, how many await wiring, how
many are deliberately excluded, and how many of those are **HOLES** — a place an
action is taken and recorded nowhere, as opposed to one folded into another
source. On this book that is four: `actor`, `approval_policy`, `business`,
`funds_availability_policy`.

`unclaimed` (base tables nobody has classified) and `mutable` (projected sources
the app role can UPDATE or DELETE) **must** be empty for the trail to claim it
covers the schema. `unclaimed` is currently **not** empty, and the panel says so
in red, because a trail that reads complete and is not is worse than no trail.

---

## The five URL states

| state | live? | what it is |
| --- | --- | --- |
| (none) | **live** | every invariant view, every queue, the real traces |
| `?state=loading` | fixture | the real skeleton, held open by a genuinely slow read |
| `?state=empty` | fixture | a quiet shift: nothing red, nothing queued |
| `?state=error` | fixture | the read failed — never rendered as an all-clear |
| `?state=edge` | **fixture** | a **decided** red sitting next to a **new** one |

### Why `edge` is a fixture, and says so

The edge case this screen exists to show is a deliberate red beside one that is
not. **Against this book that state does not exist:** `node scripts/dbcheck.mjs`
reads 42 passed / 4 failed, and all four are on the register with their
arguments. There is no fifth, undecided red to show.

The two ways to manufacture one would be to drop a view off the register so a
decided red renders as new, or to draw a row that no view returned. Both are the
screen inventing a finding — the exact failure this build keeps cataloguing. So
`edge` is a fixture, it carries the FIXTURE badge, and it says in prose above the
panel that nothing on it is a statement about a real book.

The fixture shows all three interesting cases at once: `v_entry_unbalanced` at 1
row in the `new` band (an entry that does not sum to zero is the one failure this
system has no story for), `v_hold_expiry_drift` at 13 against a watermark of 12
in the `grown` band (twelve rows argued for, the thirteenth not), and
`v_refused_auth_hold` at 257 in the `decided` band.

**If a genuinely new red appears while the deployment is up, the DEFAULT state
shows it**, ranked above the decided four. No URL state is needed. That is the
design working, not a gap in it.

### With no database configured at all

The badge reads **NO DATABASE**, the board is replaced by the refusal panel, and
no count, no queue and no tick is drawn. The failure carries the code
`TRIAGE_NO_DATABASE` and `retryable: false`, so the panel drops its retry
control: a refresh does not configure a database.

This paragraph used to say that `default` fell back to the empty fixture with
the badge reading FIXTURE, and both halves of that were false.

It did not fall back — it threw. The guard read
`const { hasDatabase } = await import("./live-source")` on one line and
`if (!hasDatabase())` on the next, and importing `./live-source` reaches
`@/lib/ledger/db` → `@/lib/env`, which parses `process.env` at module scope and
throws `EnvironmentError` when `APP_DATABASE_URL` is absent. The import only
succeeds when a database IS configured; the predicate only returns false when
one is not. The guard was unreachable in exactly the case it was written for,
and the operator got the framework's error page.

And the fallback it described was itself the failure. The empty fixture is four
invariant views holding, no queue, nothing refused, under the headline
"Nothing new." — a clean shift, rendered by a deployment that had not read a
row. The one screen whose job is to say when something is wrong said nothing
was, precisely when it could see nothing at all. That is instance 26 of this
repository's catalogued failure, and it was documented here as the design.

The predicate now lives in `has-database.ts`, a file that imports nothing, so
asking whether there is a database cannot be the thing that crashes for not
having one. The refusal lives in `unreadable.ts` and is deliberately NOT in
`fixtures.ts`: a fixture is a drawing of a book, and this is a refusal to draw
one. `no-database.test.ts` renders the real page with `APP_DATABASE_URL`
deleted and asserts all of it — ungated, because CI is a machine with no
database, which is exactly the deployment it describes.

---

## Files

```
src/app/(app)/dashboard/page.tsx          the route, the five states, source selection
src/app/(app)/dashboard/has-database.ts   the predicate, in a file that imports nothing
src/app/(app)/dashboard/live-source.ts    the ONLY file behind /dashboard that knows a database exists
src/components/dashboard/decided.ts       the register, the reach limits, the comparator (no imports)
src/components/dashboard/decided.test.ts  the comparator, proved without a database
src/components/dashboard/data-contract.ts what the components render, and nothing else
src/components/dashboard/fixtures.ts      the four non-default states
src/components/dashboard/unreadable.ts    TRIAGE_NO_DATABASE — a refusal, not a fixture
src/components/dashboard/no-database.test.ts  the refusal, rendered with no database, ungated
src/components/dashboard/TriageView.tsx   the shell, the error panel, the skeleton
src/components/dashboard/WrongNow.tsx        section 1
src/components/dashboard/WaitingOnAHuman.tsx section 2
src/components/dashboard/WhileYouWereAway.tsx section 3
src/components/dashboard/triage.integration.test.ts  the whole read, against the live book
```

### What is composed rather than written

`readInvariants()`, `readParkedByKind()` (chaos) · `listQueue()` (approvals) ·
`loadReconView()`, `severityOf`/`ageBucketOf` via `readBreaks` (recon) ·
`readWebhookProcessing()` + `webhookProcessingHealth()` (health) ·
`loadCompleteness()` (audit) · `readSnapshot()` (ledger) ·
`formatUsd` through `<Money>` — money is `bigint` cents to the renderer, and the
one narrowing to `number` is `src/lib/recon/**`'s own, which refuses rather than
rounds.

### The SQL that is left, and why

Six statements, all `SELECT`, all against **views the schema already defines**
that have no named reader yet, and every one of them exists to fetch rows behind
a number rather than to compute one: the four witness/group pairs for the red
views, `v_dispute_state`, `v_webhook_dead_letter`, `v_inbound_ach_unattributed`,
one `count(*)` on `v_recon_break`, the scheduled-job traces, and the three
machine-activity groupings (`v_actor_action`, `standing_order_outcome`,
`hold_closure`, `outbound_delivery`).

None of them touches `journal_entry`, `journal_line` or `account`.
`src/lib/ledger/boundary.test.ts` is the ratchet that would catch it, and this
screen adds nothing to its allowlist.

### Nothing on this path writes

It issues only `SELECT`s, and the application role holds `SELECT` and `INSERT`
and nothing else on the money tables. In particular **it never calls a cron
route**: those routes sweep, and a dashboard that ran the machinery it reports
on would be manufacturing the evidence it prints.

---

## Known gaps

1. **`/dashboard` is not in the nav or on the front door.** Both lists —
   `src/components/home/ScreenLinks.tsx` and
   `src/components/app-shell/NavLinks.tsx` — are outside this change's write
   scope and are already red for `/client`, `/client/activity` and
   `/client/cards` from another branch. `ScreenLinks.test.ts` now also reports
   `/dashboard`. The fix is one entry in `SCREENS` and one in `LIVE`; see the
   handover note in the change's report.
2. **No cron run-log.** Section 3 reads effects, not ticks. A `cron_run` table
   written by each route — request id, path, started/finished, verdict, counts —
   would let the screen say "the accrual tick ran at 06:41 and posted nothing"
   instead of "nothing has been written into `accrual_posting` since 14:13".
3. **No drill-through for a view that is not one of the four.** By design today
   — see above — but a generic one is possible if every invariant view were made
   to expose a common `subject_kind` / `subject_id` pair.
4. **No book-wide breaks screen.** The 1,693 figure in section 2 is reported and
   not linked, because nothing in this build lists breaks across files.
