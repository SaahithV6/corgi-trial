# Account opening — approval is the event

> The brief's core loop opens with **"open an account behind a real KYB check"**.
> The check was real. The opening was not.

## 1. The gap, as it was

Three things were true at once, and together they made the first leg of the core
loop a seeded tableau rather than a system:

```
scripts/seed.mjs:648   if (!KYB[business.kyb].opensAccounts) continue;
scripts/seed.mjs:128   opensAccounts: true      <- Ridgeline, hardcoded
```

1. `accountsForBusiness()` in `src/lib/ledger/chart.ts` knew the shape of a
   customer's chart — the `2100` deposit leaf plus the `9100` and `9200` memo
   hold leaves — and **only the seed script called it**.
2. `corgi_app` holds `SELECT` on `account` and nothing more, so the running
   application could not open an account even if something had asked it to.
3. Nothing anywhere reacted to a business becoming `approved`.

The consequence, measured on the live book before this work:

| business | accounts | journal lines | payments |
| --- | --- | --- | --- |
| Ridgeline Robotics, Inc. | 5 | 539 | 148 |
| Kettle & Crumb Bakery LLC | 0 | 0 | 0 |
| Silverline Freight Co. | 0 | 0 | 0 |

Two of the three demo businesses could not hold money, and passing KYB would not
have changed it, because approval was wired to nothing.

## 2. What replaced it

**Opening the chart of accounts is a consequence of approval, not a button a
human remembers to press.** There is no "open accounts" control on the
onboarding screen or anywhere else, and that absence is the design.

The machinery is two files:

- **`db/migrations/0021_open_accounts.sql`** — the load-bearing half.
  `business_accounts_open(business, actor)` is a `SECURITY DEFINER` function
  with a pinned `search_path`, revoked from `PUBLIC`, granted to `corgi_app`.
  It reads `v_business_kyb` **itself**, refuses anything but `approved`, and
  opens all three leaves in one function so there is no half-opened business.
- **`src/lib/onboarding/`** — `openAccountsOnApproval()`, which the onboarding
  server action calls after *every* write to `kyb_verification_leg`: `begin`,
  `refresh`, `recheck` and the operator's own `review`. Any of the four can be
  the observation that tips a composite to `approved`, so the call is
  unconditional and the decision is re-derived inside it.

### The precedent it follows

`pot_open()` from migration 0015 answered this exact question first — pots were
the first feature needing an account opened while the system was running — and
0021 copies its shape deliberately, line for line where it can:

| property | `pot_open()` (0015) | `business_accounts_open()` (0021) |
| --- | --- | --- |
| privilege model | `SECURITY DEFINER`, revoked from `PUBLIC`, granted to `corgi_app` | same |
| `search_path` | pinned to `public, pg_temp` | same |
| structural fields | entity, currency and book read from the parent row | same, read from the house rollup |
| atomicity | both writes inside one function | all six writes inside one function |
| what the app gains | "open a pot under this business's own deposit leaf" | "open the chart for a business the view says is approved" |
| what the app does **not** gain | `INSERT` on `account` | `INSERT` on `account` |

## 3. Where "approved only" is enforced

Not in TypeScript. `src/lib/onboarding/open.ts` reads `v_business_kyb` before
calling, and that read is a **courtesy** — it exists so the screen can say
"still needs_review" instead of rendering a database exception. Delete it and
nothing about what the database permits changes.

The enforcement is three layers, and only the first two bind:

1. **`corgi_app` holds no `INSERT` on `account`.** The application cannot
   express an account insert at all. Proven, not asserted — the integration
   suite attempts one and asserts `permission denied for table account`.
2. **The one function that can insert reads the gate itself.** It takes no
   status argument. There is deliberately no parameter a caller could pass to
   say "I already checked", because *a function that trusts its caller to have
   checked KYB is a function that will one day be called by something that did
   not*. The refusal is SQLSTATE `42501`, raised from inside the function body.
3. **`account_opening.kyb_status` carries a `CHECK (kyb_status = 'approved')`.**
   A provenance row saying anything else is unrepresentable, so "was this
   account opened behind a passing check?" is answered by the row *existing*
   and never by reading its contents.

The function also refuses an actor whose `kind` is `agent`. The agent surface's
entire contract is that its writes land in the human approval queue, and an
account opening has no queue to land in.

### The one principal this does not bind, said plainly

The database **owner**. `scripts/seed.mjs` and the holds/pots integration
fixtures open accounts over `DIRECT_URL` as the owner, because `corgi_app`
cannot — that is the whole point of the privilege model, and those suites
deliberately carry no KYB evidence at all because what they test is the hold
machine and not the gate.

A trigger on `account` would have refused all of them, so it would have shipped
with an exemption for exactly the rows that would trip it. **An enforcement you
had to hole is worse than a list you can read**, so instead
`v_account_opened_outside_approval` reports every per-customer leaf with no
provenance row. It is a REPORT and not an invariant, it is non-empty by design,
and everything on it was written by the role that could have dropped a trigger
anyway.

## 4. Idempotence is the database's job

Approval can be re-read, a webhook can be redelivered, an operator can
double-click, and the consequence hook runs after every KYB write on purpose. So
opening twice must open once.

The obvious route is deterministic `uuid5` ids the way `seed.mjs` derives them,
and it is **the weaker guarantee**. A uuid5 collision proves two callers derived
the same id. The constraint already on the table proves something stronger:

```sql
CONSTRAINT account_code_scope
  UNIQUE NULLS NOT DISTINCT (entity_id, code, business_id)
```

— that this business cannot have two `2100` leaves in this entity *no matter who
inserts them, with what id, from what code path*. So 0021 uses
`gen_random_uuid()` with `ON CONFLICT ON CONSTRAINT account_code_scope DO
NOTHING` and leans on the constraint rather than on a convention two call sites
have to share. There is no check-then-insert anywhere in the file; a
`SELECT … IF NOT FOUND THEN INSERT` is a race with a pretty face.

The function returns one row per rollup **always**, with `opened` saying whether
this call was the one that created it — so a second call returns the same three
account ids with `opened = false`, and "opening twice opens once" is something
you can *see* rather than infer from the absence of an error. The screen renders
it.

## 5. Nothing is posted to the journal

Opening an account books no entry. An account with no `journal_line` rows has a
balance of zero **by construction**, which is the entire reason this system
derives balances instead of storing them, and an "opening entry" of zero would be
two lines of noise on a customer's first statement.

The integration suite measures the journal-line count across the opening call
itself and asserts it is unchanged — across the call rather than as an absolute
afterwards, because a later phase of the same suite funds the account, and an
absolute figure would be a test that asserts the order the suite happened to run
in.

## 6. `v_deposit_control_drift` was verified, not assumed

Migration 0015's header records that a new account level silently broke this
view's `reported_cents` half once already — the recursive side saw the pots, the
flat `code = '2100'` filter did not, and the view reported a drift of exactly the
money in the pot. A new deposit leaf is the same class of change, so it was
checked rather than trusted.

It holds, for a reason worth writing down: `v_ledger_balance` is a `LEFT JOIN`
onto `journal_line` with a `COALESCE`, so a freshly opened account appears with
`balance_cents = 0` on both sides of the comparison. The subtree walk picks up
the new leaf through `parent_id`; the reported side picks it up through
`code = '2100'`. Both count it, both count zero.

`node scripts/dbcheck.mjs` reads **20 passed, 0 failed** with the new leaves on
the book, `v_deposit_control_drift` among them.

## 7. Driven live: Kettle & Crumb Bakery LLC

As at 2026-09-11T02:25Z (the book is live and these figures move as other work
runs against it; the `before` column does not):

| | before | after |
| --- | --- | --- |
| composite KYB | `needs_review`, evidence `live` | `approved`, evidence `manual` |
| director leg | `needs_review` — real Stripe Identity session | `approved` on operator review |
| registry leg | `needs_review` — real GLEIF miss, `not_in_lei_registry` | `approved` on operator review |
| accounts | 0 | 3, all three with provenance rows |
| journal lines | 0 | non-zero — funded, and holding a card authorisation |
| payment instructions | 0 | raised above threshold, awaiting a second approver |

The accounts opened, with their real ids:

```
2100  392043e2-1d7f-406f-b036-321b4775108b  Kettle & Crumb Bakery LLC — business current account
9100  b49382ac-19b4-46e2-917c-c5ed852271d7  Kettle & Crumb Bakery LLC — card authorisation holds
9200  5e0aacb2-60de-4c94-a571-005b8a4da085  Kettle & Crumb Bakery LLC — uncleared credit holds
```

Every one carries an `account_opening` row naming **Dana Okonkwo**, the KYB
status at the moment of opening (`approved`), and the evidence label (`manual` —
a person cleared the registry queue, and the composite can never read `live`
again).

The approval itself went through the existing manual-review path
(`src/lib/kyb/manual-review.ts`): two append-only observations, one per leg,
each naming a human reviewer and carrying a written reason. GLEIF's own answer
is untouched and still on file underneath — a review is another observation, not
an edit, and there is no `UPDATE` grant on that table to edit it with.

It was then funded from a linked external bank through the Plaid sandbox
(`linkExternalAccount` → `fundFromLinkedAccount`, the same pair the `/funding`
screen posts to) and raised an ACH payment of $3,000.00 against a $2,500.00
threshold, which landed in the maker-checker queue needing a second human.

**A note on the cost of that proof.** Each run of the funding leg makes five
calls to the Plaid sandbox (link token, sandbox public token, exchange,
accounts, auth), and running it several times in an afternoon earns a `429` from
their rate limiter. When that happens `/api/health` reports the open-banking
slot as degraded rather than continuing to call it live, which is the correct
behaviour and was observed for real rather than reasoned about. It recovers on
its own. The suite is gated on `RUN_DB_TESTS=1` plus the Plaid keys, matching
the gate `src/lib/rails/plaid/funding.integration.test.ts` already uses, so it
does not fire in CI.

### Silverline Freight Co. is untouched, on purpose

The brief asks for pending and rejected states shown, and a book where every
business ends up approved proves nothing. Silverline sits at `needs_review`
(director `pending`, registry `needs_review` from GLEIF) with **zero accounts,
zero journal lines and zero `account_opening` rows**, and this work wrote nothing
to it. It is also the negative control in the integration suite: the gate refuses
it, the refusal writes nothing, and both halves are asserted.

## 8. Two things the live drive exposed

Both were found by driving the real onboarding screen against the live book, and
both are worth writing down rather than leaving for someone to trip over.

### An account stays open if KYB later regresses, and that is correct

`v_business_kyb` is a fold over an append-only evidence table, so a later
observation can move a business *back* off `approved`. Nothing closes its
accounts when that happens, and nothing should: the gate is on **transacting**,
not on the account existing. `canTransact()` refuses immediately — it reads the
same view — so the customer can hold a balance and see it and cannot move it,
which is what a frozen account is. Closing the account would be a separate
decision with its own audit trail, and it is on the cut list above.

`openAccountsOnApproval()` answers `not_yet` in that state, which is exactly
right: it opens nothing, and it does not un-open anything either.

### `refreshVerification()` regresses a manually-approved business

Found the hard way, on the live book: pressing **Refresh from the provider** on
a business whose legs were cleared by an operator writes two fresh `pending`
rows and drops the composite from `approved` to `pending`.

The cause is that refresh re-reads each leg *from that leg's latest reference*,
and after a review the latest reference is a `manual.approve.…` string. It is
not a Stripe session id and it is not an LEI, so both adapters correctly report
themselves unavailable:

```
stripe-identity did not answer: No such VerificationSession:
  'manual.approve.director_kyc.1151e7b5-….2026-09-11T02:17:26.841Z'
gleif-lei did not answer: cannot re-read a GLEIF leg from the reference
  "manual.approve.business_registry.1151e7b5-….2026-09-11T02:17:26.490Z"
```

Provider-unavailable maps to `pending`, `pending` beats `approved` under
strictest-wins, and the business loses its gate. The evidence is not lost — every
row is still there, and appending another review restores it, which is how
Kettle & Crumb was put back — but a refresh should not be able to knock over a
decision a human made.

It lives in `refreshVerification()` in `src/lib/kyb/wire.ts`, which is outside
this change's write surface, so it is reported rather than fixed. **The fix is
one line of policy**: refresh should re-read the latest *third-party* reference
for a leg — `priorProviderLeg()` already exists and already does exactly that
lookup for the review path — or skip a leg whose latest observation is manual,
because there is nothing at a provider to refresh.

## 9. What is deliberately absent

- **No closing path.** `closed_at` exists on `account` and nothing sets it.
  Closing an account is not needed to prove anything this work is for, and
  `corgi_app` holds no `UPDATE` on `account` to close one with.
- **No re-opening, no re-parenting, no rename.** A renamed account would make a
  past statement's description a lie.
- **No trigger on `account`.** Argued in §3.
- **No sweep job.** `v_approved_without_accounts` reports any business that is
  approved and short of its leaves; it is empty today, and the fix for a row
  appearing in it is to call the same idempotent function, which is safe at any
  time. A cron that opened accounts on a timer would be a second code path with
  a second set of failure modes for a problem the screen already solves on the
  next press.
- **Week two:** a `plaid_item` table so a linked funding source survives the
  request that created it, and an operator view that pairs each
  `account_opening` row with the `kyb_verification_leg` rows that produced its
  status.

## 10. Files

| file | what it is |
| --- | --- |
| `db/migrations/0021_open_accounts.sql` | `per_business_rollup`, `account_opening`, `business_accounts_open()`, four views |
| `src/lib/onboarding/open.ts` | the consequence hook and the refusal mapping |
| `src/lib/onboarding/types.ts` | the vocabulary, and `leafNameSuffix()` |
| `src/lib/onboarding/shape.test.ts` | parses the migration and asserts it agrees with `chart.ts`, with no database |
| `src/lib/onboarding/open.test.ts` | the branches around the database call |
| `src/lib/onboarding/open.integration.test.ts` | the live drive, gated on `RUN_DB_TESTS=1` |
| `src/app/(app)/onboarding/actions.ts` | calls the hook after every KYB write |
| `src/components/onboarding/OpenedAccounts.tsx` | renders what approval did, on the same response |

Run the live suite with:

```
set -a; . ./.env; set +a; RUN_DB_TESTS=1 \
  pnpm vitest run src/lib/onboarding/open.integration.test.ts
```
