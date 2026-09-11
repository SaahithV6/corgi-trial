# Pots — sub-accounts, and transfers that touch no rail

Stretch ladder, item four, verbatim:

> Sub-accounts or pots, with instant internal transfers that are pure ledger
> moves.

This is the cheapest possible proof that the ledger is a real ledger rather than
a balance table with extra steps, because an internal transfer touches no rail
at all. If a pot can only be built by adding a column beside the balance, the
balance was never derived. If it can be built by adding a **node to the account
tree** and letting every existing query fall out correctly, it was.

What follows is the design, the one place the existing schema was wrong, and the
real figures from the live database.

---

## 1. What a pot IS, in the chart of accounts

A pot is a **real ledger account**: a child of the customer's own `2100` deposit
leaf, in the financial book, credit-normal, carrying the same `business_id` as
its parent.

```
2000  Liabilities
└── 2100  Customer deposits                      (control account, not postable)
    └── 2100  Ridgeline Robotics — main balance  (business_id = e274546d…)
        ├── 2100.a94a4e92…  pot “Payroll — October”
        └── 2100.ef7dd5c5…  pot “Sales tax”
```

The money never leaves `2100`'s subtree. It is still owed to the same customer;
it is earmarked, not moved anywhere. So the **deposit control account still
equals total customer money**, which is the property that makes it a control
account at all.

### Why the code is `2100.<pot uuid>`

Three properties, all load-bearing:

1. **It is not the string `'2100'`.** Every consumer in this codebase addresses
   a customer's *spendable* account with an exact equality — `code = '2100' AND
   business_id = …`. That is true of `availableBalance()`,
   `v_available_balance`, `v_overdrawn_accounts`, `listDepositAccounts()`, the
   statements reader, the holds store and the recon demo. A pot is invisible to
   every one of them, and §2 is entirely about why that is the right answer
   rather than a lucky one.
2. **It is unique per pot**, so `UNIQUE NULLS NOT DISTINCT (entity_id, code,
   business_id)` from `0001` permits many pots per business. Had pots reused the
   bare code `'2100'`, that constraint would have allowed exactly one.
3. **The separator is `.`, not `/`.** `chart.ts` reserves `/` for the *display*
   form of a per-business leaf (`2100/<business uuid>`) and
   `parsePerBusinessCode()` splits on it. A pot code must never parse as one of
   those, and with `.` it cannot.

### What is deliberately absent

- **No balance column**, on `pot` or anywhere. A pot's balance is
  `SUM(journal_line)` over its account, like every other balance here.
  `scripts/dbcheck.mjs` fails the build if a stored one appears.
- **No transfer table.** An internal transfer *is* a journal entry — two lines,
  one entity, one customer, `rail = 'internal'`. A `pot_transfer` row would be a
  second copy of the truth, free to drift from the first. The movements list on
  `/pots` is a query over `journal_entry` and `journal_line` and nothing else.
- **No `pot_closure`.** Closing a pot proves nothing this feature is for, and
  `UPDATE` on `pot` is refused by trigger, so it could not have been a status
  flag anyway. Cut, listed below.

### How a pot is created

`corgi_app` holds `SELECT` on `account` and nothing more — opening an account
has always been a seed/migration act. Pots are the first feature that needs one
opened while the system is running, and the answer is the shape `0001` already
uses for `ledger_append()`: a `SECURITY DEFINER` function with a pinned
`search_path`, revoked from `PUBLIC`, granted to `corgi_app`.

`pot_open(business, name, purpose, actor)` reads the entity, the currency and
the parent **from the customer's own deposit leaf**, so a pot cannot be opened
in the wrong book, the wrong currency, or under somebody else's business. Both
writes — the `account` row and the `pot` row — are inside it, so there is no way
to create half a pot.

The application gains exactly one new capability: *open a pot under this
business's own deposit leaf*. Not `INSERT` on `account`, which would let it open
anything anywhere.

---

## 2. Does moving money into a pot change AVAILABLE?

**Yes. Available on the main balance drops by exactly the amount moved.**

### The argument

A pot that leaves available alone is a label on a spreadsheet. The entire point
of "set aside $12,000 for payroll" is that the $12,000 cannot be spent by a card
swipe on the 14th. If a fuel-pump authorisation can still eat it, the pot did
nothing except reassure somebody.

So the pot has to ring-fence. The interesting part is **how little it took**:

```
available = ledger − active card holds − uncleared credits
```

…where `ledger` is the balance of the account whose code is exactly `'2100'`.
An internal transfer **debits the main leaf** and **credits the pot**. The main
leaf's balance falls by the amount moved, so `available` falls with it.

Not one line of `src/lib/ledger/**` was changed to get that. `availableBalance()`
does not know pots exist and does not need to: it asks for one account by an
exact code and gets one account. The ring-fence is what happens when the pot is a
**real account** and the transfer is a **real posting**. A design where
`available` had to be taught about pots would have been a design where the pot
was not really an account.

Two consequences fall out for free, and both are worth stating because neither
was written:

- **Standing orders respect pots.** `src/lib/standing/fire.ts` refuses an
  occurrence for insufficient *available* balance, reading the same function. So
  money in a pot is money a standing order will not take, and the refusal
  already records all four figures on the outcome row.
- **The card console's balance facts respect pots.**
  `src/app/(app)/accounts/actions.ts` reads `availableBalance()` for the same
  numbers.

### What does NOT change

The customer's **total deposit liability**. They own exactly what they owned a
moment ago:

```
main + Σ pots = total
```

That is the identity `/pots` renders — with the right-hand side derived a second,
independent way (`v_pot_subtree`, a recursive walk of `account.parent_id` that
never reads the `pot` table) and the difference printed as a figure. A screen
that says "balanced ✓" is asking to be believed.

### The asymmetry between a pot and a deposit account

| | deposit account (`2100`) | pot (`2100.<uuid>`) |
| --- | --- | --- |
| may go negative | **yes** | **no** |
| why | an over-captured fuel-pump authorisation settles above the amount authorised and the honest answer is an overdraft (`1190`, `v_overdrawn_accounts`) | nothing external can post to a pot; a negative one would only ever be a bug in `decideMove()` |

`v_pot_negative` is an invariant view for exactly that reason.

### And the gate is `available`, not `ledger`

A move **into** a pot is capped by *available*, not by the ledger balance. A $50
card authorisation is money already committed to a merchant; an ACH credit that
has not cleared can still be pulled back. Both sit in the ledger balance and
neither is spendable, so earmarking either would let a pot promise money a
settlement is about to take. That refusal — ledger covers it, available does not
— is the screen's `?state=edge`.

A move **out** of a pot is capped by the pot's own balance instead. A pot has no
holds against it, so its available balance *is* its ledger balance.

---

## 3. The invariant that a new account level was supposed not to break

`0001` says of `v_deposit_control_drift`:

> Written as a subtree walk rather than "sum the 2100 children" so that adding a
> sub-account level later cannot silently break it.

**That claim was verified against the live database before a line of this feature
was written, and it is half true.**

The probe: one pot account under Ridgeline's `2100` leaf, one $500.00 internal
transfer, inside a transaction that was rolled back. The view has two sides:

| side | how it is written | did it see the pot? |
| --- | --- | --- |
| `subtree_cents` | `WITH RECURSIVE` over `account.parent_id` | **yes** — exactly as advertised |
| `reported_cents` | `SUM(v_ledger_balance) WHERE code = '2100'` | **no** — a flat code filter |

Result:

```
drift BEFORE: []
drift AFTER:  [{ subtree_cents: 13577077, reported_cents: 13527077 }]
                                 difference: 50000 = the money in the pot
```

So the sub-account level **did** silently break it — on the side nobody was
looking at. The recursive half of the claim held; the flat half was the whole
problem the comment thought it had solved.

### The fix, and why it is not "relax the check until the feature passes"

`0015` generalises `reported_cents` from a code filter to:

```sql
WHERE v.business_id IS NOT NULL
  AND (v.code = '2100' OR v.account_id IN (SELECT id FROM deposit_tree))
```

That is a **strict superset** of the rows the old predicate matched. The old
disjunct is kept verbatim — including its ability to catch a customer deposit
leaf that had been reparented *out* of the tree, which a membership test alone
would miss — and the tree-membership disjunct is added. Anything the old view
would have caught, the new one still catches; it now also catches a
customer-scoped account inside the control subtree that nobody is reporting.

With zero pots on the book the two predicates select the identical row set, and
`src/lib/pots/pots.integration.test.ts` asserts the difference *is exactly the
pot balances* rather than describing it:

```ts
expect(subtree - oldReported).toBe(pots);
```

`CREATE OR REPLACE VIEW`, not `DROP` + `CREATE`, so the grant `0008` issued
survives and the column names, order and types must match — which is a useful
thing for Postgres to refuse.

### The four invariant views this feature adds

| view | must be empty because |
| --- | --- |
| `v_pot_identity_drift` | `main + Σ pots` equals the recursive walk of that customer's deposit subtree |
| `v_pot_negative` | a pot cannot be overdrawn |
| `v_pot_orphan` | every pot's account is a liability leaf parented directly on that business's own `2100` |
| `v_internal_transfer_impure` | every pot transfer is exactly two lines, both inside one customer's deposit subtree, and touches nothing else |

All four are read live on `/pots` and rendered with their row counts, because
the claim "a new level in the account tree did not break the ledger" is exactly
the sort of claim that is true on the day it ships and quietly false a week
later.

---

## 4. The internal transfer

Two lines, one entity, one customer, one book:

```
DEBIT   2100                    $12,000.00     we owe them less on this leaf
CREDIT  2100.a94a4e92…          $12,000.00     we owe them more on that one
                                ─────────
                                     $0.00
```

Both accounts are credit-normal liabilities inside one customer's own deposit
subtree, so the entry sums to zero **within the customer's own money**. No asset
account moves, no settlement account moves, no provider is called, no webhook is
expected, nothing is scheduled and nothing can be returned three days later.

`rail = 'internal'`; `external_ref`, `inbox_id` and `hold_id` are all `NULL`,
because there is no external fact for them to point at. Those four columns are
printed on the movements table for that reason: the claim is that no rail was
touched, and the evidence is the columns that would carry a rail if one had
been.

**That is why it is instant.** Not "we made it fast" — there is nothing to wait
for. Every other money movement in this system is slow because a third party has
to agree; this one has no third party.

### What it is not exempt from

It goes through `postEntry()` like everything else, which means `ledger_append()`
— the advisory lock, the serialised `booking_seq`, the monotonic `booking_time`,
the hash chain, the denormalised clocks, and the `UNIQUE` idempotency key. It is
append-only. It is bitemporal: value date and booking sequence are separate
columns on it exactly as they are on a card clearing.

### The idempotency key

```
pot:<pot uuid>:<in|out>:<reference>
```

Derived from source facts, never from a uuid we generate. There is no provider
event behind an internal transfer — that is the point of it — so the source facts
are the ones a person supplies: **which pot**, **which direction**, and the
**reference** they are moving the money for.

**The amount is deliberately not in the key.** If it were, re-submitting
`payroll-2026-10` for a different figure would quietly post a *second* transfer,
which is the exact failure idempotency exists to prevent. The reference names the
movement; one movement is one entry. A resubmit is reported as a replay, with the
entry that already exists. A transfer posted for the *wrong* amount is a
correction, and gets the same answer as everywhere else in this system: a
reversal at the original value date plus a re-book.

### Concurrency

`lock_business_deposits(business)` is the first statement in the transaction. It
row-locks the customer's `2100` leaf and every pot beneath it, ordered by `id` so
two movers cannot deadlock, and holds to the caller's `COMMIT`. Without it, two
concurrent moves could each read $100.00 available and each post $80.00, leaving
the customer $60.00 overdrawn against a check both passed.

`corgi_app` cannot take that lock itself — `SELECT … FOR UPDATE` needs `UPDATE`
privilege — so, as with `lock_card_authorization()` in `0008`, it is taken by a
definer function whose entire surface is one uuid in, one boolean out.

`decideMove()` therefore runs **twice**: once to draw the screen (a forecast) and
once inside the transaction behind the lock (the decision). Same pure function
both times; there is no second copy of the rule for the demo to disagree with.

### Why no maker-checker

§16's threshold is on the **money-out** path, and this path has none. After the
entry the bank owes the customer exactly what it owed before, to the cent, and
they can move it straight back. There is no counterparty to defraud and nothing
to recall. Requiring a second approver for a transfer that cannot lose anybody
money trains people to click through approvals, which is the failure mode
maker-checker exists to prevent.

### Reversibility

Money out of a pot is **another ordinary entry** — `entry_type = 'original'`, its
own idempotency key, its own booking sequence. Nothing about the entry that put
the money in is touched, and no path in this codebase could touch it:
`corgi_app` holds no `UPDATE` or `DELETE` on `journal_entry` or `journal_line`,
and `pnpm db:check` proves it by attempting both.

Undoing a transfer is not a correction. Nothing was wrong, so there is nothing to
reverse.

---

## 5. The screen

`/pots`, five states, all reachable from the query string:

| URL | state |
| --- | --- |
| `/pots` | **live** — pots, balances, journal entries, invariants |
| `/pots?state=loading` | the real skeleton, behind a real Suspense boundary, held open by a slow read |
| `/pots?state=empty` | a customer with no pots; the identity degenerates to `main = total` and still holds |
| `/pots?state=error` | the read failed; nothing posted, retry is live |
| `/pots?state=edge` | **live** — a move of one cent *more* than the live available balance, refused, with the subtraction that refused it |

…plus `?business=<uuid>`.

**`default` and `edge` are live.** The claim being graded is that a pot is a real
account, that a transfer is a real journal entry, and that moving money into one
really does reduce what can be spent. A fixture would answer all three by
construction and prove none of them.

The edge state is live for the same reason and one more: the point of a refusal
is that the *system* decided it. Only the **amount** is synthetic —
`available + 1 cent`, chosen so the refusal is the tightest possible one, because
a refusal that misses by $10,000 proves only that a big number is bigger. The
four balances it is judged against are this moment's real `availableBalance()`,
and the function that refuses is `decideMove()`, the same one the transaction
runs. The probe never reaches `postEntry()` and never takes the lock: a render
must not write.

`loading`, `empty` and `error` are fixtures so they can be shown in order in
front of a panel — the first needs a slow database, the second needs a customer
nobody has given a pot to, the third needs the database to be down. Every fixture
state prints **FIXTURE** on its own face.

---

## 6. Real figures, from the live database

`2026-09-10`, Ridgeline Robotics, Inc. (`e274546d-6bdd-5266-b0fb-cc839a7811f9`),
seeded by `src/lib/pots/demo.ts`, every write through `openPot()` /
`movePotFunds()` → `postEntry()` → `ledger_append()`.

**Before**

```
main       $34,247.63
pots            $0.00
total      $34,247.63    subtree $34,247.63
holds         $360.00    uncleared $13,753.00
available  $20,134.63
```

**Entry `5f2dd85e-ab0a-4af7-aaf1-887390730e24`** — seq 1215, value date
2026-09-10, key `pot:a94a4e92-19af-4004-8fc9-d3b77f23df0c:in:payroll-2026-10`,
$12,000.00 into “Payroll — October” (account `2100.a94a4e92-19af-4004-8fc9-d3b77f23df0c`)

```
main       $34,247.63 → $22,247.63     (−$12,000.00)
available  $20,134.63 →  $8,134.63     (−$12,000.00)
total      $34,247.63 → $34,247.63     (unchanged)
```

**Entry `88abe276-11e7-479b-aa09-2414f9ef86bc`** — seq 1216, value date
2026-09-10, key `pot:ef7dd5c5-9479-4be8-9675-6ec3490ccca7:in:salestax-2026-q3`,
$3,400.00 into “Sales tax” (account `2100.ef7dd5c5-9479-4be8-9675-6ec3490ccca7`)

```
main       $22,247.63 → $18,847.63     (−$3,400.00)
available   $8,134.63 →  $4,734.63     (−$3,400.00)
total      $34,247.63 → $34,247.63     (unchanged)
```

**Entry `c2a254d1-5c92-4237-9fab-423110346966`** — seq 1217, value date
2026-09-10, key
`pot:ef7dd5c5-9479-4be8-9675-6ec3490ccca7:out:salestax-2026-q3-partial-release`,
$400.00 **out** of “Sales tax”

```
main       $18,847.63 → $19,247.63     (+$400.00)
available   $4,734.63 →  $5,134.63     (+$400.00)
total      $34,247.63 → $34,247.63     (unchanged)
```

`entry_type = 'original'`. Not a reversal, not a correction, and not an edit:
nothing was wrong with entry `88abe276…`, and it still says exactly what it said.

**After**

```
main       $19,247.63
pots       $15,000.00     [Payroll — October $12,000.00, Sales tax $3,000.00]
total      $34,247.63     subtree $34,247.63     difference $0.00
holds         $360.00     uncleared $13,753.00
available   $5,134.63
```

Available fell by $15,400.00 and came back by $400.00 — net $15,000.00, which is
exactly what is in the pots. The total never moved. The two derivations of the
total agree.

**Re-running the seeder writes nothing**, and the log says which mechanism
refused each half:

```
open “Payroll — October”
  already exists (pot a94a4e92…) — refused by UNIQUE (business_id, name)
move $12,000.00 into “Payroll — October”
  replay — entry 5f2dd85e… already existed under key
  pot:a94a4e92…:in:payroll-2026-10; nothing written
```

### The fixture customer, exercised end to end

`src/lib/pots/pots.integration.test.ts`, on its own business
(`70747300-0000-5000-a000-000000000001`, "Pots Integration Fixture Co."), pot
`3101edbc-a24a-4db3-9d25-2d43d79ee312`:

| what | entry / outcome |
| --- | --- |
| $1,200.00 in | `d343bb1c-1d21-4ffc-aaf5-b62286bddf67` — main −$1,200.00, available −$1,200.00, total ±$0.00 |
| same reference again | replay: the **same** entry id, journal entry count unchanged |
| available + 1¢ in | refused `INSUFFICIENT_AVAILABLE`, short by 1¢, no entry written under the key |
| pot balance + 1¢ out | refused `INSUFFICIENT_POT`, short by 1¢ |
| $1,200.00 out | `9d211652-3b5c-47b1-8907-980131c81737` — balances return; **two** entries exist, both `entry_type = 'original'`; `UPDATE` on the first is refused by the database |

### Invariants after the money moved

```
node scripts/dbcheck.mjs   →  14 passed, 0 failed

v_deposit_control_drift      0 rows
v_pot_identity_drift         0 rows
v_pot_negative               0 rows
v_pot_orphan                 0 rows
v_internal_transfer_impure   0 rows
v_entry_unbalanced           0 rows
v_line_denorm_drift          0 rows
v_hold_drift                 0 rows
v_book_not_zero              0 rows
trial balance                0
```

---

## 7. Reproducing it

```bash
set -a; . ./.env; set +a

node scripts/migrate.mjs                                 # applies 0015_pots.sql
RUN_DB_TESTS=1 pnpm vitest run src/lib/pots              # the full suite, live
RUN_POT_DEMO=1 pnpm vitest run src/lib/pots/demo         # seeds the demo pots
node scripts/dbcheck.mjs                                 # 14 / 14
```

Both seeding halves are idempotent by a `UNIQUE` index rather than by an `if` —
`pot(business_id, name)` and `journal_entry.idempotency_key` — and
`demo.test.ts` asserts that a second run changes no balance and writes no entry.

---

## 8. Cut list

Not built, and what week two would do:

- **Closing a pot.** Needs a `pot_closure` table shaped like `hold_closure`
  (PRIMARY KEY on `pot_id`, so closure is exactly-once by construction) and a
  guard refusing closure while the balance is non-zero. Nothing this feature
  claims depends on it, and `UPDATE` on `pot` is refused, so it could never have
  degenerated into a status flag.
- **Renaming a pot.** Same reason it is absent: a pot's name is quoted in the
  `description` of every entry that moved money into it, so a rename would make
  a past entry's description a lie. The honest version is a `pot_rename` append
  table with the name resolved as-of a booking sequence.
- **Pot-to-pot transfers.** The posting is the same shape (two lines, both
  inside one customer's subtree, sums to zero) and `v_internal_transfer_impure`
  already accepts it. Only the form and `findPot()` are single-pot; the ledger
  side needs nothing.
- **Scheduled earmarks** — "move 20% of every inbound credit into Sales tax".
  This is a standing order whose rail is `internal`, and standing orders already
  exist. The interesting question is the policy for the day available cannot
  cover it, which `src/lib/standing/**` has already had to answer.
- **Pots on the statement.** A closed day's statement is currently the `2100`
  leaf. With pots it should show the leaf and the subtree separately, and the
  reproducibility guarantee makes that a schema question rather than a rendering
  one.
- **An MCP read tool for pots.** Three reads and one write already exist; a
  `pots.list` read tool is a twenty-line addition, and a `pots.move` **write**
  tool would have to land in the approval queue like every other agent write —
  which, given §4's argument that internal transfers need no maker-checker, is a
  question worth answering deliberately rather than by default.

## 9. Files

| path | what |
| --- | --- |
| `db/migrations/0015_pots.sql` | `pot`, `pot_open()`, `lock_business_deposits()`, six views, the `v_deposit_control_drift` generalisation |
| `src/lib/pots/model.ts` | the rules, pure: `decideMove()`, `transferLegs()`, `moveIdempotencyKey()`, `identityOf()` |
| `src/lib/pots/store.ts` | every read; no writes |
| `src/lib/pots/transfer.ts` | `openPot()`, `movePotFunds()` — the only two writes |
| `src/lib/pots/screen.ts` | the live data source; the one `bigint → number` narrowing |
| `src/lib/pots/demo.ts` | idempotent demo seeding, through the same two writes |
| `src/lib/pots/model.test.ts` | 22 unit tests, no database |
| `src/lib/pots/pots.integration.test.ts` | 8 tests against the live ledger |
| `src/lib/pots/demo.test.ts` | seeds and re-seeds the demo pots, live |
| `src/app/(app)/pots/page.tsx` | the route and its five states |
| `src/app/(app)/pots/actions.ts` | the two server actions |
| `src/components/pots/**` | the screen |
