# Where the tests run — and what `pnpm test` is silent about

> `pnpm test` read **2,556 passed / 381 skipped**, and in the 381 were **every
> database-backed suite and all eight live-fire attacks**. Both halves of that
> sentence were true. Only the first half was printed.

That is this codebase's defining failure in its most ordinary form: a number
that reports healthy about a population it excludes. It is the same shape as
`v_standing_order_double_fire` joining a UNIQUE column and asking for
`count > 1`; the same shape as GUARD REACH measuring `hold_closure` instead of
the guard's own predicate; the same shape as a KYB requirement scored against
a *summary* of the brief instead of the brief. Every time, the artefact was
accurate about what it looked at and mute about what it did not.

Three things changed, and none of them is "run the database suites in CI".

## 1. The skip is printed next to the number, every run

`vitest.config.ts` carries a reporter that prints, after every run including a
fully green one:

```
────────────────────────────────────────────────────────────────────────────
  WHAT THIS RUN DID NOT RUN — 391 skipped, next to the 2568 that passed
────────────────────────────────────────────────────────────────────────────

  41 of 185 suites did not execute at all.
  A skipped test is not a passing test. Grouped by what this environment
  did not provide, read out of each suite's own source:

  RUN_DB_TESTS
      23 suite(s), 223 test(s)
      set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run --no-file-parallelism \
          <paths below>
        src/lib/accrual/accrual.integration.test.ts (11)
        …
```

**It is not a list of suites.** A hand-typed list is exactly what GUARD REACH
was, and GUARD REACH was wrong by ten rows for as long as it existed. The
reporter opens each skipped file and reads the gate out of that file's own
source: an env name is reported when the file **compares** it on its own line
(`=== "1"`, `!== ""`, `typeof … !== "string"`) or defaults it to the **empty**
string — this repo's idiom for a credential one may not hold. A name read with
a real default (`process.env["LIVEFIRE_BASE_URL"] ?? "https://…"`) is a knob,
not a gate, and is left out, because a list padded with things that are not
the reason teaches the reader to stop reading the list.

Consequence: **a new gated suite appears in the output the first time it is
skipped**, with nobody remembering to add it.

The reporter also names something neither number could ever have contained: a
suite that **throws while being collected** contributes zero passes and zero
skips, and is invisible to both. Those are printed first, separately.

## 2. The suites run, from a developer machine, under named commands

CI holds no database URL and no provider key, **on purpose**, so that this
repository builds on a fork and so that no green tick is ever bought with a
secret. That decision is worth keeping and it is kept. What was missing was
the other half — somewhere the suites *do* run, named, documented, and run
before submission rather than discussed.

| Command | What it runs | Cost |
| --- | --- | --- |
| `pnpm test` | everything hermetic. Prints the skip summary. | free |
| `pnpm test:db` | `RUN_DB_TESTS=1 RUN_LIVE_TESTS=1`, whole suite, sequential | live Neon; every money-table suite but one is rolled back |
| `pnpm test:probes` | `RUN_LIVE_PROBES=1` — the Increase probes | two authenticated GETs, read-only |
| `pnpm test:livefire` | `LIVEFIRE=1` — the eight attacks and chaos mode | real Lithic sandbox cards, real webhook deliveries |
| `pnpm test:optin` | `RUN_LITHIC_TESTS=1 RUN_POT_DEMO=1 EVENTS_LIVE=1` | a real card, real demo-pot money, a third-party echo host |
| `pnpm test:submission` | all of the above, then `dbcheck` and `dbcheck --prove` | **this is the one that runs before submission** |

Each sources `./.env` itself if it is there, so the commands in this table are
the whole command — there is no prelude to remember.

### What `pnpm test:db` actually measured, 2026-09-11 04:18–04:35 PDT

```
Test Files  1 failed | 169 passed | 15 skipped (185)
     Tests  1 failed | 2904 passed | 54 skipped (2959)
```

**2,904 tests ran against the live Neon book**, up from 2,568 — the whole
database estate, `holds.integration` included, every money-table suite but one
inside a rolled-back transaction. One failure, diagnosed below, and it is not
the code's.

> **"every money-table suite but one" was wrong when it was written, and by
> more than one.** It counted the `RUN_DB_TESTS` population, and
> `src/lib/recon/planted-break.test.ts` is not in it — that file gates on
> `APP_DATABASE_URL` and had been committing to the journal on every plain
> `pnpm test` for as long as it has existed. It is wrapped as of 12:45Z. The
> sentence is a small, exact instance of this document's own opening
> complaint: a number that reports healthy about a population it excludes.
> The 2,904 figure itself stands — that run really did execute those tests;
> only the claim about what was wrapped was short by a file.

The remaining 54 are the four opt-in gates above, each named in
that run's own skip block with the command that runs it; 6 more were `it.skip`
inside suites that did run, `RUN_LITHIC_TESTS`'s twelfth team scenario among
them.

`pnpm test:optin` is separate on purpose and stays separate. Its three gates
are not habit: `RUN_POT_DEMO` moves real money on the demo business rather
than on a fixture company, `RUN_LITHIC_TESTS` creates a real card at Lithic,
and `EVENTS_LIVE` depends on `httpbin.org` — and, as that suite's own header
says, *a suite that goes red when a third party has a bad afternoon teaches
people to ignore red suites*. Those reasons still hold. `RUN_LIVE_PROBES` did
not: it is two read-only GETs, and its stated reason was only ever "CI holds
no credentials", which says nothing about a developer machine that does. It is
now run by name.

## 3. CI states the qualification where the tick is

`.github/workflows/ci.yml` cuts the reporter's own block out of the run it
just produced and writes it into `$GITHUB_STEP_SUMMARY`, so a reader who sees
green on the Actions page sees what that green excludes in the same glance.
A final step **fails the build** if a run that skipped tests produced no skip
block: a reporter that silently stops reporting is the same failure again, one
level up.

## Why `--no-file-parallelism`

Not a style preference, and not caution. **Measured** — and re-measured on
2026-09-11, either side of wrapping `holds`, because the paragraph this section
used to carry named the wrong cause.

### What it used to say, and what was wrong with it

> `holds.integration.test.ts` fails five of its twelve cases when it is run in
> the same parallel pass as `ledger`, `fx`, `pots` and `statements` … these
> suites share one live book, and `ledger_append` takes `pg_advisory_xact_lock`
> per entity and holds it to end of transaction, so a suite-wide transaction in
> one file stalls or perturbs the arithmetic another file is asserting on.

The observation was real. **The diagnosis was not, and it was not testable as
written** — "contention" was inferred from the fact that the suites were
parallel, never from the amounts. The amounts say something else.

### The measurement

Same command every time, six suite-files in one parallel pass:

```sh
set -a; . ./.env; set +a
RUN_DB_TESTS=1 RUN_LIVE_TESTS=1 pnpm vitest run \
  src/lib/holds/holds.integration.test.ts \
  src/lib/ledger/ledger.integration.test.ts \
  src/lib/fx/fx.integration.test.ts \
  src/lib/pots/pots.integration.test.ts \
  src/lib/statements/statements.integration.test.ts
```

| | `holds` (12) | `ledger` (10) | `statements` (6) | `fx` (22) | `pots` (8) | wall |
| --- | --- | --- | --- | --- | --- | --- |
| **before**, run 1 | 2 red | — | 1 red | — | — | 115s |
| **before**, run 2 | — | — | 1 red | — | — | 120s |
| **before**, run 3 | 4 red | 1 red | 1 red | — | — | 112s |
| **after**, run 1 | — | — | — | — | — | 124s |
| **after**, run 2 | 2 red | — | — | — | — | 117s |
| **after**, run 3 | — | — | — | — | — | 129s |
| **after**, run 4 | — | — | — | — | — | 120s |
| **after**, run 5 | 1 red | — | — | — | — | 119s |
| **after**, run 6 | — | — | — | — | — | 120s |

**The other suites stopped failing completely.** `statements` was red in three
parallel runs out of three and is red in none of six; `ledger` in one of three
and none of six. Both failures were the same shape and it was the shape the
wrapping was predicted to fix — `statements`' is literally

```
something was booked between the two renders; the two documents are of
different watermarks and are correctly different: expected 4917 to be 4911
```

— six journal entries appearing between two renders of the same closed day.
`holds` was committing twenty-six per run. It is now committing two.

### What is still red, and it is not parallelism

`holds` still failed three cases across six parallel runs, and **every one of
them was traced to a writer that file parallelism has no authority over.**

- **after-run 2** — `expected 10000n to be 5000n`, then `expected -4000n to be
  1000n`: a 5,000-cent hold appearing and then being released mid-scenario.
  Chaos mode, posting `CHAOS_AUTH_CENTS` and `CHAOS_CLEARING_CENTS` onto this
  suite's fixture business (see the previous section). The financial leaf
  carries five `card:clearing:<uuid>` entries of exactly **7340** in that
  window, and the memo leaf the matching **−5000 / +5000** pairs. Chaos mode
  runs in a different process from vitest; `--no-file-parallelism` does not
  reach it.
- **after-run 5** — `expected 122500n to be -2500n`, a discrepancy of exactly
  **125,000 cents with no journal entry anywhere to explain it**. There was
  none: an `uncleared_credit` hold of $1,250.00 on the fixture reached its
  `available_at` of `2026-09-11T13:00:00Z` in the middle of that run.
  **Availability releases an uncleared credit ON THE CLOCK, with no posting**,
  so `hold_cents` fell by 125,000 between the scenario's two reads and nothing
  was written that any diff of the journal could have shown. A watcher polling
  `ledger_availability()` on the pool once a second through the whole of
  after-run 6 recorded a single, unchanging line — the terms are rock steady at
  rest, and they move on a clock.

### So: is `--no-file-parallelism` a workaround or a constraint?

**Keep it, and for a better reason than the one it had.** On the evidence
above, the contention between these five files is gone — the wrapping removed
it, and six runs found none. But six runs is not proof, and two of the three
things that did go red came from outside the vitest process entirely: a chaos
episode started from the deployed console, and a funds-availability clock. A
sequential run does not fix either; it only narrows the window in which either
can land, and narrowing that window is worth having when the alternative is a
red suite that is correct.

What has changed is what the flag is for. It is no longer load-bearing for
`ledger` and `statements` — they now pass in parallel because the file that was
perturbing them stopped writing. It is retained as **margin against a shared
live book with writers that are not tests**, which is what this database
actually is.

## Why `pnpm test:livefire` raises the timeout, and what that found

The eight attacks run. With `LIVEFIRE=1` at the repository's 30s
`testTimeout`, seven pass and **attack 07 cannot pass at any speed**:

```
ATTACK 7 — … invents no money while the feed is dark
Error: Test timed out in 30000ms.
```

Its own inner steps declare 60s, 90s and 60s budgets, inside an `it` that
declares no timeout of its own — so its ceiling was 30s while its floor was
210s. Measured at `--testTimeout=300000` it takes **218s and passes all three
cases**, the long one being the 180s health-endpoint read that is the outage
window itself. That is the mirror image of a guard that cannot fail: a guard
that cannot pass, reporting red about a system that is right. It is fixed
where it is safe to fix — in `pnpm test:livefire`, for that directory only.
A global 300s would turn every genuinely hung unit test into a five-minute
wait for 2,568 tests that finish in twenty seconds.

`vitest.config.ts` keeps `testTimeout: 30_000` for exactly that reason, and
now says so beside the number.

Result, measured 2026-09-11:

| Attack | |
| --- | --- |
| 01 fuel-pump authorisation | pass |
| 02 over-capture and release | pass |
| 03 bitemporal correction | pass |
| 04 settlement before authorisation | pass |
| 05 maker-checker | pass |
| 06 planted break | pass |
| 07 provider outage | pass (218s; red at the 30s default) |
| 08 real-provider replay | pass |
| `chaos.livefire` | **red** — see below |

## Standing reds, as of 2026-09-11, and what each one is

Run, not reasoned about. **Do not re-skip any of these.**

### `src/lib/rails/increase/probe.integration.test.ts` — a tripwire that fired

```
expected { supported: true, proof: 'measured' } to match { supported: true, proof: 'unexercised' }
```

This is the file working. Its own header says the last case *"still pins all
four to `unexercised` because that is what `INCREASE_SUPPORT` … still
DECLARES … so it goes red the moment somebody makes the declaration true,
which is the point at which this comment and that assertion are both
replaced."* Somebody made the declaration true. The assertion was not
replaced — and nobody saw, because nothing on this machine or in CI had ever
set `RUN_LIVE_PROBES=1`. **A guard designed to fire, that fired, into an empty
room.** The repair is in `src/lib/rails/increase/probe.integration.test.ts`
and `src/lib/rails/adapters/ach.ts`, owned by whoever promoted the cell.

### `src/lib/timetravel/timetravel.integration.test.ts` — real, and not ours

**Closed 2026-09-11 12:55Z. Green, and green for the right reason.** The
paragraphs below are kept because the diagnosis was correct and the number it
turned up is bigger than the one it was written about.

```
holds the value axis still: a different day does not move with the cut
expected 1492544n to be 1493778n
```

Reproducible: the absolute numbers move between runs, the delta is **1234
cents every time**. The test reads one account's closing balance for value
date `1979-01-02` at two instants on the booking axis, and a day that early
should have nothing on it at either.

It has something on it now. A property suite belonging to another worker was
planting centuries-backdated entries on the live book. So the guard was
telling the truth about the book, which is a fact about the ledger a reviewer
can read off the statements screen, not only about the test.

#### The suite, and the exact generator

`src/lib/recon/planted-break.test.ts`, and it is not a fuzz suite — it is the
graded planted-break requirement, running against the live database. The
generator is one line:

```ts
const DATE_SPACE_DAYS = 146_097;                          // one Gregorian cycle
const businessDate = dayFromEpoch(-1 - randomInt(DATE_SPACE_DAYS));
                                                          // 1600-01-02 … 1999-12-31
```

Every run books five inbound ACH settlements on that date — `DR 1130 / CR
2100` — and then corrects one of them with `reverseAndRebook()` at
`MISMATCH_DELTA = 1_234n`. **That constant is the 1,234 cents, exactly.**

**How it escaped last night's wrapping pass.** That pass was over the
`RUN_DB_TESTS` population. This file gates on `typeof
process.env.APP_DATABASE_URL === "string"` instead — deliberately, and its own
header gives the reason: *"A graded requirement should not be behind an
environment variable somebody has to know about."* The reason is good and the
gate is kept. It just meant the file was never in the set anybody looked at,
and it ran on every plain `pnpm test` on a machine with `.env` sourced.

#### What was actually on the book

Not 308 lines. Measured 2026-09-11 12:30Z, across **four** writers:

| ref | entries | value dates | writer |
| --- | --- | --- | --- |
| `PLANT-` | 1,580 | 1606-04-01 … 2013-08-16 | `src/lib/recon/planted-break.test.ts` |
| `STMT-` | 104 | 1980-12-09 … 2011-11-19 | `statements.integration.test.ts`, exempt-must-commit |
| `LF3-` | 16 | 2000-05-05 … 2011-08-06 | live fire attack 3, an earlier revision |
| `LF6-` | 12 | 2002-02-15 … 2010-05-11 | live fire attack 6 |

1,712 entries whose value date cannot be real, on a book whose entity was
created on 2026-09-10. The 1,279 `PLANT-` rows in 2000–2013 are the residue of
the `Date.now() % 5000` window that preceded the 146,097-day one.

Two consequences worse than a red test:

* **`bestDemonstration()` was returning a fixture.** What
  `/transactions?state=edge` resolves to — the console's flagship bitemporal
  demonstration — is the most recent correction act on any deposit account,
  and that was correction group `4da141c3`, *"Planted settlement
  PLANT-MTWVSLD39…"*, value-dated **1956-09-24**. A reviewer opening the edge
  case was shown a test fixture. It self-heals now the planting has stopped —
  a real act overtakes it on `booking_seq` — and `landmarks.ts` is deliberately
  **not** filtered, because a live demonstration that skips rows it dislikes is
  not live.
* **The test's own premise was false.** `other = "1979-01-02"` was commented
  *"a value date years before the act's own"*. With the act at 1956, 1979 is
  **after** it, so the act's own reversal and re-book were inside the
  cumulative closing the case asserted could not contain them.

#### What was done

1. **`planted-break.test.ts` is wrapped**, per suite, in a transaction that is
   rolled back. **Wrapped, not bounded** — the absurd date is load-bearing:
   the file's own header argues that a 146,097-day CSPRNG draw is what makes
   two concurrent runs independent and what stops a synthetic date being
   mistaken for a seeded one. Narrowing the generator would trade a real
   isolation property for a cosmetic one. Per suite rather than per test
   because the file is explicitly one story told in steps. Measured: eight
   cases, 9.5s, and a targeted count either side of the run is **unchanged**.
2. **The 1,712 rows stay.** Not deleted — append-only, and there is no DELETE
   for any role including the owner. Not reversed either: they are not *wrong*,
   they are balanced postings a suite really made, so a reversal would assert
   an error that did not happen — and a reversal carries the **original** value
   date, so 1,712 of them would put 1,712 more impossible dates on the book to
   complain about the first 1,712. The correction would be shaped like the
   defect.
3. **They are made legible instead.**
   `db/migrations/0047_value_date_sanity.sql` marks 1,596 of them per row in
   `journal_value_date_residue` with the file that wrote them and a sentence
   saying why, declares the two writers still sanctioned to back-date
   (`STMT-`, `LF6-`) in the view where adding a third costs a migration, and
   stands `v_value_date_unexplained` over everything booked after. `PLANT-` is
   deliberately **not** a declared writer: one new `PLANT-` entry now means the
   wrapping came off.
4. **The assertion is green, and it asserts more than it did.** See
   `docs/TIMETRAVEL.md` §"Holding the value axis still".

#### The finding underneath all of it

**Nothing on this book could say a value date was impossible.** Twenty-five
invariants asked whether entries balance, whether two derivations of a number
agree, and whether an act had the right to happen. Not one looked at *when* an
entry claimed to have happened, and `ledger_append()` takes a `p_value_date
date` with no bound on it at all — 1500 is as acceptable to this schema as
today. The only thing in the whole system that noticed 1,712 impossible rows
was one assertion in `src/lib/timetravel/`, going red by 1,234 cents, three
files from the cause.

`v_value_date_unexplained` is the twenty-sixth invariant and is the first
guard on the value axis. It is **green by attribution, not by narrowing**:
0047 filters nothing out of the predicate, it names every row.

There is **no CHECK constraint** on `journal_entry.value_date`, and that is a
decision rather than an omission. A `CHECK` — even `NOT VALID`, 0041-style —
would refuse the statements seeder and live-fire attack 6 **mid-run**, and
breaking two working suites in order to catch a third is a worse trade than
reporting all three. The band is enforced by a guard that reports, not by a
constraint that refuses.

**Also checked, since nothing had:** the future side of the band is **empty**.
The furthest-dated entry on this book is 2027-12-07 — standing orders,
value-dated ahead on purpose, and the quadrant `docs/TIMETRAVEL.md` relies on
for `asKnownAt` < `asOf`. 14.9 months out, inside the 18-month window, nothing
beyond it.

### `src/lib/chaos/chaos.livefire.test.ts` — asserts something known false

All six cases fail on one helper, `invariantsMustHold()`, which requires every
invariant view to be empty:

```
v_refused_auth_hold: 212 row(s)
v_hold_expiry_drift: 11 row(s)
v_advice_delta_unsound: 1 row(s)
v_hold_closure_unexplained: 4 row(s)
```

Those are the **four deliberate, documented, unrepairable findings** that
`node scripts/dbcheck.mjs` reports and that this build has accepted in writing
(0032, 0040, 0043, docs/HOLDS.md §10.4). The chaos suite cannot pass while
they stand, and no amount of chaos is being measured by it — it fails before
it arms anything. It needs the same treatment `dbcheck` already gives them: a
known-population baseline it asserts has not **grown**, rather than a zero it
asserts absolutely. `src/lib/chaos/**` is not this change's to edit.

### `src/lib/rails/increase/inbound-recall.integration.test.ts` — red in CI, invisible here

It imports `@/lib/ledger/db` at module scope, so with no `APP_DATABASE_URL` it
throws during **collection**:

```
EnvironmentError: Environment is invalid. 1 problem(s): APP_DATABASE_URL is required
```

Every other gated suite in this repo imports the database *inside* the gated
`describe`, which is why they skip instead of exploding. Locally, with `.env`
sourced, this file collects and then skips, so it looks fine. **In CI — no
`.env`, by design — `pnpm test` is red on this one file**, and it contributes
neither a pass nor a skip to either number while doing it. That is why the
reporter now prints collection failures first and separately. The fix is one
line in that file: move the `@/lib/ledger/db` import under the gate.

### The one that went green while this was being written

`src/lib/rails/wire/outbound.integration.test.ts` was red at 03:44
(`WIRE_ROUTING_NUMBER_NOT_CONFIRMED` not carried on the thrown error) and
green at 03:46 with seven cases. Another worker fixed it mid-run. Recorded
because a red observed once and not reproduced is worth exactly one sentence,
and no more than one.

---

# Integration tests against the live book

This database is LIVE. It is the one the deployed system at
`https://corgi-trial-psi.vercel.app` reads, and it is the one a reviewer opens.
Every row an integration test leaves behind is a row somebody may read off a
screen as a fact about this business.

## The rule

> **An integration test that writes to a money table runs inside a transaction
> that is rolled back.**

Money tables are `journal_entry`, `journal_line`, `hold`, `hold_closure`,
`statement`, `book_day`, and everything that cites them — `dispute`,
`payment_instruction`, `payee`, `card`, `pot`.

The rule is not "mock the database". The opposite: the rows are really written,
the triggers really fire, the generated columns are really computed by the
server, the grants really refuse what they refuse, and every assertion is made
against real Postgres. What changes is only that the transaction is thrown away
at the end instead of committed.

This is not a substitute for `DELETE`, it is the reason `DELETE` is never
needed. **Do not delete from a money table.** Append-only is the point, and the
residue already on the book stays there.

## The mechanism

The pattern was proved in `src/lib/fx/fx.integration.test.ts` and is copied,
not shared — a test helper module would be a fourth place to look when a suite
misbehaves, and each file's copy is annotated with what that file needs it for.

```ts
async function rolledBack(body: (tx: Sql) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  try {
    await sql.begin(async (raw) => {
      await body(nested(raw));
      throw new Error(ROLLBACK);       // the only way out without a COMMIT
    });
  } catch (thrown) {
    if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
  }
  if (failure !== null) throw failure; // a real failure still goes red
}
```

### `nested()` — the shim, and why it is not optional

Production code calls `conn.begin(...)` to make a posting and its bookkeeping
atomic. **postgres.js puts `begin` on the POOL only** — look at the
`Object.assign` in `postgres/src/index.js`, where `begin` sits alongside
`listen` and `end` and is not among the methods `Sql(handler)` gives a
transaction scope. A transaction handle gets `savepoint` instead.

So `postEntry(args, tx)` works and `releasePayment(args, tx)` throws
`conn.begin is not a function`. `savepoint(fn)` and `begin(fn)` are the same
function internally (`scope(c, fn, name)`), differing only in whether a
savepoint name is issued, and a nested savepoint rolls back independently while
leaving the outer transaction usable — which is exactly `conn.begin`'s
semantics. So each suite installs `begin` as a savepoint on the handle it
passes down:

```ts
function nested(handle: unknown): Sql {
  const scoped = handle as Scoped;
  if (typeof scoped.begin !== "function") {
    scoped.begin = (first: unknown, second?: unknown) => {
      const body = (typeof first === "function" ? first : second) as
        (inner: unknown) => Promise<unknown>;
      return scoped.savepoint((inner) => Promise.resolve(body(nested(inner))));
    };
  }
  return handle as Sql;
}
```

`Sql(handler)` builds a fresh object per scope, so the property is added to
that one transaction's handle and to nothing else.

**Without this shim the only way to wrap these suites would be to stop calling
the production functions and hand-write their INSERTs in the test** — which
would mean the integration tests no longer test the code that runs. That is why
the shim exists and why it is worth the fifteen lines of comment each copy
carries.

### `onSavepoint` / `expectRefusal` — refusals inside a transaction

**A statement Postgres refuses aborts the whole transaction.** Every statement
after it fails with `current transaction is aborted` until somebody rolls back.

Outside a transaction this never came up, so several production functions
catch a trigger's `RAISE EXCEPTION` and return a refusal value — the right
shape for a console screen, and it means the exception never escapes to tell
the caller the connection is now unusable. Inside a transaction that turns one
working control into a cascade of unrelated failures.

The fix is a savepoint, and the body **must throw** to get out of it:
postgres.js issues `ROLLBACK TO SAVEPOINT` on a rejected body and `RELEASE` on
a resolved one, and `RELEASE` on an aborted subtransaction fails exactly the
same way. So capture the value, then throw a sentinel.

Call sites that need it today:

| Suite | Call | Refusal |
| --- | --- | --- |
| `disputes` | `authorizeProvisionalCredit` ×4 | maker-checker trigger, `42501` |
| `pots` | `openPot` in `beforeAll` | `pot_name_unique`, `23505` |
| `pots` | the `UPDATE journal_line` probe | grant, `42501` |
| `wire/outbound` | `approvePayment` by the initiator | maker-checker trigger |

**Never weaken an assertion to make a wrapped test pass.** If wrapping changes
what a test can see, that is a finding about the test — write it down, as those
four call sites do.

### Per-test or per-suite?

Per test, by default: `fx`, `ledger`, `plaid/funding`, `disputes`, `statements`,
`wire`, `holds` each open and discard one transaction per scenario.

`holds` is per test even though several of its scenarios look like one story —
because they are not. Each opens its own card and its own authorisation and
asserts a delta against its own `before` read, so nothing any scenario leaves
is read by the next one. The one place a scenario genuinely needs two things to
see each other, scenario 5's in-order and reversed sequences, they share that
scenario's single transaction and the comparison between them is the assertion.
Per test also keeps the `pg_advisory_xact_lock` window down to one scenario —
three to six seconds — rather than the hundred and ten the whole file takes.

Per suite only when the scenarios are **one story told in steps**, where each
step reads back what the previous step left — `wire/outbound` (a maker-checker
flow whose fourth step approves the instruction the third step raised) and
`pots` (whose replay test replays the move the previous test posted). Those open
the transaction in `beforeAll` and roll it back in `afterAll`.

The cost of the per-suite form, stated plainly: **`ledger_append` takes
`pg_advisory_xact_lock` per entity and holds it to end of transaction.** From
the moment a suite-wide transaction posts until it rolls back, every other
writer to that entity's ledger waits. Keep the window short, and **never hold it
across a provider round trip** — make the Plaid, Lithic and Increase calls
before opening the transaction, as `plaid/funding` and `wire` do.

## Suites that are exempt, and why

Being expensive is not a reason to be exempt. These are.

### Genuinely must commit

**`src/lib/cards/advice-wake.integration.test.ts`** — both grounds at once.
Its one action is *remediation*: it registers six cards that eighteen real
signature-verified deliveries are parked on, requeues the dead letters and
unparks them. Rolled back, those eighteen stay stuck for ever and every
assertion in the file becomes false. And its claims are about durability across
transactions — "the advice branch HAS run on live input", "no payload is left
parked" — while `drain()` is the production consumer, takes no connection, and
commits each delivery separately *because that is the idempotency contract
under test*. Forcing it into one transaction would test something else with the
same name.

*Reduced anyway:* the drain now runs only when that run actually woke
something. It used to run up to eight times unconditionally, which made a
finished suite a production worker over whatever the deployed system had in its
inbox that second — `releaseAvailableCredits()` included. Steady-state per-run
cost is now zero by construction.

**`settleAnythingLeftOpen()`** in `disputes.integration.test.ts` `beforeAll` —
remediation, same argument. It drives cases abandoned by interrupted runs to a
terminal state through the ordinary transitions. Repair that is rolled back has
repaired nothing. It is now the only thing in that file that can write, and it
drains to a no-op.

**`seedStatementDemo()`** in `statements.integration.test.ts` — it *is* the
seeder for the `/statements` screen, whose default state reads the live
database. A seeder whose output is discarded has seeded nothing. Its second
call also asserts that it found what its first call **committed** and declined
to issue a second version: idempotency across time, which one transaction
cannot exhibit.

**`accrual`, `interest`, `interchange`** — already stated in-file. The canonical
form is `interest.integration.test.ts`: *"could not clean up: `journal_entry`
has no DELETE for this role, by design."*

**`holds` scenario 7 only** — "the release posts EXACTLY ONCE when two workers
race it". The whole claim is about two workers that cannot see each other, and
two transactions that cannot see each other is what a transaction IS. Wrapped,
both `settleHoldPosting()` calls would share one handle, `lockAuthorization()`
would be re-entrant, and the assertion would pass without a race having
happened. The reason is written beside the test, in the file, at length. Its
eleven siblings are wrapped.

### Fixtures, not per-run cost

`provisionTestAccount()` in `pots` and `holds` (owner connection, `ON CONFLICT
DO NOTHING`), the opening floats (fixed idempotency keys), and the pots fixture
pot. Written once by the first run that ever executed; every run since replays
them for nothing. They must outlive the transaction because later runs look
them up.

### Not wrapped because they cost nothing

Tests that only read, and tests whose subject is a statement the database
refuses outright — the `UPDATE journal_entry` probe, the `DELETE FROM
statement` probe, `publishStatement` on an unclosed day, a non-positive funding
amount. There is nothing to roll back, and running them on the pool keeps them
honest: a rollback could otherwise be mistaken for the reason the book was
unchanged.

### External sandboxes are never rolled back

Plaid Items, Lithic cards, Increase wires. They are somebody else's system,
that is what a live integration means, and it was always true. What the rule
changes is only that **our** book no longer keeps a copy of the bookkeeping.

## Checking your work

```sh
set -a; . ./.env; set +a
RUN_DB_TESTS=1 pnpm vitest run --no-file-parallelism <path>

node scripts/dbcheck.mjs            # 37 passed / 5 failed as of 2026-09-11 13:08Z.
                                    # FOUR are the deliberate/red-on-arrival
                                    # findings — leave them failing. The FIFTH
                                    # is new and is NOT deliberate: see
                                    # v_hold_release_drift below.
                                    # GUARD REACH must read "26 of 26 views".
node scripts/dbcheck.mjs --prove    # "covered 26 of 26 invariant views"
                                    # and must stay complete.
```

The two figures in that block are **counts of a list, not of a memory**. The
tally moves the day somebody adds a check, and it has, twice: this section read
"36 passed / 2 failed" and "22 of 22" until it was corrected on 2026-09-11,
by which time the script itself read 37/4 and 25/25 — and it read 37/4 and
25/25 until `v_value_date_unexplained` was added the same afternoon, which made
it **38/4 and 26/26**. It read 38/4 for about half an hour. **At 13:00:00Z it
became 37/5**, and the fifth is not one of the four — see the next paragraph.
Quote the script, not this file, and if the two disagree the script is right.

### `v_hold_release_drift` — 13 rows, arrived on a clock at 13:00:00Z

Not deliberate, not accepted, and **not the holds suite's**: every one of the
thirteen is an `uncleared_credit` hold from **Plaid funding**, `external_ref`
`plaid:…`, created between 2026-09-10 22:36Z and 2026-09-11 03:39Z, and every
one of them carries `available_at = 2026-09-11T13:00:00.000Z`. The view was
empty at 12:24Z and at 12:47Z; it was 13 rows at 13:08Z. Nothing wrote them.
**A clock struck.**

That is the finding. `v_hold_release_drift` is `is_released AND
memo_balance_cents <> 0`, and an uncleared-credit hold becomes released the
instant `available_at` passes — with **no posting**, because availability reads
the clock and the memo book does not. So the memo book goes on carrying money
availability has already given back, and the gap opens by itself. For CARD
holds this is exactly the gap `sweepExpiredHolds()` closes, and
`/api/cron/holds` runs it nightly (vercel.json, 08:11). **There is no
equivalent for the uncleared-credit half**, and `sweepIncompleteHoldPostings()`
deliberately does not cover it — see the header on
`src/app/api/cron/holds/route.ts`: *"Completion deliberately does NOT touch
`v_hold_release_drift`: posting a release there would silence 0011's alarm
while leaving a false closure standing."* That reasoning is about a FALSE
CLOSURE. These thirteen have no closure at all; they were released by the
clock, exactly as designed. The reasoning does not reach them.

**69 more uncleared-credit holds have an `available_at` still in the future**,
so this view grows on its own until something posts the release leg for a
credit whose availability clock has run out. That is a product repair in the
funding path, not a test repair, and it is not in this change's write scope —
recorded here so the next reader of `dbcheck` does not file the fifth failure
under "the four deliberate ones" and stop looking.

> **`package.json` still says 25.** `pnpm test:submission` prints
> *"(must read: covered 25 of 25 invariant views)"* above the `--prove` run.
> That banner is stale and `package.json` is outside this change's write scope.
> The script's own line is the authority; it reads 26 of 26.

**GUARD REACH is now complete and cannot quietly stop being complete.** It was
fifteen hand-typed rows against twenty-five gated invariants — built because a
guard that cannot fail is a green tick, and incomplete by exactly the same
construction. It now walks `GATED_INVARIANTS`, the one list all three
consumers share, and a view with no reach query is a named `FAIL` in the tally
rather than an absence that prints as nothing. Two of the ten that were
missing are worth reading when you run it: `v_member_approval_without_right`
reaches 30 of 177 `approved` events and
`v_team_terms_by_unauthorised_author` reaches 2 of 373 member-version rows,
both because they resolve their subject through an INNER JOIN to a
`team_member` row — so an actor with no membership of that business is not
judged and not reported. That is 0033's defect, one table over.

A suite is done when it is **green** and a row count taken either side of the
run is **unchanged**. Count with a targeted query — `journal_entry` alone moves
under you because other work is running against this database, so filter on
something the suite owns, such as its own idempotency-key prefix or
`external_ref`.

## Status

| Suite | Wrapped | Per-run cost |
| --- | --- | --- |
| `fx` | per scenario | 0 |
| `ledger` | per scenario | 0 |
| `plaid/funding` | per scenario | 0 |
| `pots` | per suite | 0 |
| `statements` | per scenario | 0 |
| `disputes` | per scenario | 0 |
| `wire` | the one booking test | 0 |
| `wire/outbound` | per suite | 0 — **green as of 2026-09-11 03:46**, seven cases, fixed mid-session by another worker. The "RED for an unrelated reason" note this row used to carry is spent. |
| `recon/planted-break` | per suite | 0 — **wrapped 2026-09-11 12:45**, eight cases, 9.5s. It was never on this table, which is why it was never wrapped: it gates on `APP_DATABASE_URL` rather than `RUN_DB_TESTS`, so it ran on every plain `pnpm test` and was outside the population last night's pass ranged over. It had committed **1,580** entries value-dated 1606–2013. |
| `holds` | per scenario, except scenario 7 | **1 card, 1 authorisation, 1 hold, 2 card events, 2 memo entries** — scenario 7's footprint and nothing else. Was 12 / 12 / 12 / 22 / 26 before, measured either side of the run on 2026-09-11 05:28 and 05:45 PDT. |
| `advice-wake` | exempt, by design | 0 in steady state |
| `accrual`, `interest`, `interchange` | exempt, by design | stated in-file |

`holds.integration.test.ts` was the one that was left. It is wrapped as of
2026-09-11 12:45Z. Every function it drives takes a connection and
`applyCardTransaction` accepts `{ conn }`, so ten of its twelve cases moved
inside `rolledBack()` unchanged — not one assertion was weakened to get them
there, and the suite is green, twelve of twelve, alone and in the parallel
pass.

**Scenario 7 still commits, and the reason is written beside it in the file.**
"7. the release posts EXACTLY ONCE when two workers race it" `Promise.all`s two
`settleHoldPosting` calls on SEPARATE POOL CONNECTIONS. Two concurrent
transactions cannot see each other's uncommitted rows; wrap it and both workers
run on one handle, the `lockAuthorization()` is re-entrant, the race never
happens and `[-6000n, 0n]` passes for a reason that has nothing to do with
concurrency. That is a guard that cannot fail, wearing the name of one that
can. Its cost is the one row of the table above.

The two cross-checks at the foot of that file are not wrapped either, for the
opposite reason: they only read, and the last of them asserts that the WHOLE
LIVE BOOK is clean. Inside a transaction it would be asserting that over a
snapshot containing the suite's own uncommitted writes, which is a weaker
claim wearing the same name.

### The three `sql.begin` blocks that used to COMMIT — what they left

All three were inspected against the live book before anything was changed, by
reading back every authorisation of a completed run:

- **the block in scenario 7** (records the final capture without settling the
  hold, so a release is genuinely outstanding when the two workers start) —
  still commits, with scenario 7, by the argument above. It leaves the hold at
  memo balance 0 and **no `hold_closure` row**, because `settleHoldPosting()`
  posts the money and does not close. Not drift: `v_hold_drift` reads
  `NOT is_released`, and the fold over `E` is 0 there too.
- **the block in 7b** — the important one. It writes a `hold_closure` on a hold
  whose event set does not license one, which is precisely the state
  `v_hold_drift` and `v_hold_closure_not_terminal` exist to catch, and which is
  how an earlier version of this file left four orphan closures that had to be
  retired by hand. **It left no residue in its final form**: the two repairs
  that follow it — `settleHoldPosting()` and then `expireOne()` — ran in every
  run that got that far, the closure is declared `test_harness` (0040) so it is
  out of `v_hold_closure_not_terminal` by construction, and `expireOne()` adds
  the `expiry` fact that makes it genuinely terminal. The exposure was never
  the block; it was *"in every run that got that far"*. A run that threw in
  between left the fabricated closure committed. It is now a savepoint inside
  the scenario's transaction and cannot outlive the assertion it was made for.
- **the block in 8b** (opens a hold on an authorisation whose `expires_at` is
  already an hour in the past) — left a hold that the same test's sweep closed
  and squared in the same run, `source = expiry_sweep`, memo 0. No residue.

So: **none of the three was leaving residue on a run that completed.** What was
leaving residue was a run that did *not* complete, and scenario 4b is the proof
— see below.

### What the residue had actually done

Two things, both visible on screens rather than inferred:

1. **`v_overdrawn_accounts` showed the fixture's 2100 leaf at −$858,207.45.**
   Scenario 4b posts a $500,000 force-post and refunds it four statements
   later. Committing, any assertion between those two lines that threw left the
   force-post on the book and the refund unreached — and that assertion is a
   delta assertion, so a concurrent writer was enough to throw it. It had
   happened more than once. The view the middle of that test *reads* was
   reporting the wreckage of earlier runs of that test.

2. **Chaos mode had silently retargeted itself onto this suite's fixture.**
   `src/lib/chaos/driver.ts:defaultBusinessId()` picks the business with the
   most cards. Twelve cards a run made *Holds Integration Fixture Co.* the
   largest cardholder on the book — 345 cards against Ridgeline's 201 — so
   every `chaos_run` for hours had `business_id` = the holds fixture, landing
   `CHAOS_AUTH_CENTS` ($50.00) and `CHAOS_CLEARING_CENTS` ($73.40) on the exact
   account these scenarios measure deltas against. That is the whole of the
   next section.
