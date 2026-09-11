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
`wire` each open and discard one transaction per scenario.

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
RUN_DB_TESTS=1 pnpm vitest run <path>
node scripts/dbcheck.mjs            # 36 passed / 2 failed, both deliberate
node scripts/dbcheck.mjs --prove    # 22 of 22, and must stay complete
```

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
| `wire/outbound` | per suite | 0 — but the suite is RED for an unrelated reason; see its header |
| `holds` | **not yet** | holds, closures, cards, auths and entries per run, plus three `sql.begin` blocks that COMMIT |
| `advice-wake` | exempt, by design | 0 in steady state |
| `accrual`, `interest`, `interchange` | exempt, by design | stated in-file |

`holds.integration.test.ts` is the one that is left. It is wrappable — every
function it drives takes a connection, and `applyCardTransaction` accepts
`{ conn }` — with one scenario that is genuinely exempt on the durability
ground: **"7. the release posts EXACTLY ONCE when two workers race it"** runs
two `settleHoldPosting` calls concurrently on separate connections, and two
concurrent workers cannot see each other's uncommitted transaction. That one
stays committing, with the reason written beside it.
