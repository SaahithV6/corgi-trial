# LEDGER GRANTS — which relations the app role may write, and who decides

Migration: `db/migrations/0066_money_write_reach.sql`.
Guard view: `v_money_writable_by_app`. Walk: `money_reachable_relations(text[])`.

---

## 1. The finding

`db/migrations/0029_chaos.sql:62` justifies the only full `UPDATE, DELETE`
grant `corgi_app` holds anywhere on this schema:

> None of the four has a `cents` column, a foreign key into `account`,
> `journal_entry`, `journal_line`, `hold` or `card_auth_event`, or any way to
> be read by the balance derivation.

The grant it justifies, verbatim (`0029_chaos.sql:388-395`):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_control  TO corgi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_run      TO corgi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_delivery TO corgi_app;
GRANT SELECT, INSERT                 ON chaos_event    TO corgi_app;
```

The first clause of that sentence is **false**, about a table in the same file:

| table | columns (live) |
|---|---|
| `chaos_control` | `control`, `armed_at`, `expires_at`, `armed_by`, `armed_by_id`, `params` |
| `chaos_run` | `id`, `started_at`, `finished_at`, `started_by`, `card_token`, `business_id`, `card_registered`, `transaction_token`, **`auth_cents bigint`**, **`clearing_cents bigint`**, `controls`, `note` |
| `chaos_delivery` | `id`, `run_id`, `seq`, `step`, `copy_index`, `provider`, `webhook_id`, `raw_body`, `headers`, `planned_at`, `released_at`, `outcome`, `inbox_id`, `detail` |
| `chaos_event` | `id`, `at`, `kind`, `control`, `run_id`, `actor`, `detail`, `params` |

`chaos_run` carries two `cents` columns, about ninety lines below the sentence
that denies it.

## 2. The verdict: a wrong comment, not a wrong grant

**These are not money rows.** A `cents` column is not what makes a row a money
row; being a row a balance is derived from is. Measured against the live
database:

1. **`ledger_availability()` does not reach them.** Its five terms read
   `journal_line`, `journal_entry`, `account` (through `ledger_settled_cents()`),
   `hold`, `card_authorization`, `card_auth_event`, `hold_closure`,
   `hold_closure_reversal`. No chaos relation appears, directly or through a
   view.
2. **No foreign key.** The only FKs any chaos table carries are
   `chaos_delivery.run_id -> chaos_run` and `chaos_event.run_id -> chaos_run`.
   `chaos_run.business_id` is a bare `uuid`, deliberately.
3. **No function on the database mentions a chaos table.** The only views that
   do are the four `v_chaos_*`, plus `v_audit_source_count` (a row-count
   census) and `v_actor_action`, whose `chaos_event` branch emits
   `NULL::bigint AS amount_cents`.
4. **`scripts/rebuild.mjs` does not contain the string `chaos`.** Its inputs
   are `account`, `journal_entry`, `journal_line`, `hold`, `hold_closure`,
   `hold_closure_reversal`, `card_authorization`, `card_auth_event`,
   `webhook_inbox`, `statement`, `book_day`, `business`.
5. **The cents columns are not even read by what spends them.**
   `startChaosRun()` (`src/lib/chaos/driver.ts`) writes both from the module
   constants `CHAOS_AUTH_CENTS` / `CHAOS_CLEARING_CENTS` and signs the delivery
   bodies **from the same constants, not from the row**. The row's only reader
   in the repository is `src/app/(app)/chaos/live-source.ts`, a dashboard.
   Editing `auth_cents` after the fact edits a caption.

So `chaos_run` is a simulation *log* of what a scripted card episode was told
to be worth. The money that episode moves is posted by the ordinary consumer
reading `webhook_inbox`, which is guarded where it has always been guarded.

**This is not the automatic fail. It is a comment that was wrong about its own
file.** Nothing was revoked, because there was nothing to revoke.

## 3. What 0066 changed

* **Corrected comments** on `chaos_run`, `chaos_run.auth_cents` and
  `chaos_run.clearing_cents` — 0029 is immutable, so the correction goes where
  `\d+ chaos_run` prints it.
* **Narrowed the grant** so the claim is a privilege rather than a promise:

  ```sql
  REVOKE UPDATE ON chaos_run FROM corgi_app;
  GRANT  UPDATE (card_registered, finished_at, note) ON chaos_run TO corgi_app;
  ```

  The app's only update of this table is `driver.ts:543`,
  `UPDATE chaos_run SET card_registered = true`. `finished_at` and `note` are
  included because 0029's header says a run "closes when the episode ends" and
  that writer has not been written yet. `auth_cents`, `clearing_cents`,
  `business_id`, `card_token`, `transaction_token` are now immutable to the app:
  they are what the run *was*. `chaos_control`, `chaos_delivery` and
  `chaos_event` are untouched — the off switch is a `DELETE` and the outbox
  release is an `UPDATE`, both by design.

## 4. The guard

`money_reachable_relations(p_roots text[] DEFAULT NULL)` computes **from the
catalog** the set of relations a balance can see. It seeds at
`ledger_availability`, `ledger_settled_cents`, `v_available_balance` and walks
to a fixed point:

| edge | source |
|---|---|
| view → relation | `pg_rewrite` / `pg_depend` (exact) |
| function → relation | words in `prosrc` |
| function → function | words in `prosrc` |
| view → function | words in `pg_get_viewdef` (not recorded in `pg_depend`) |

Today it returns ten: `account`, `card`, `card_auth_event`,
`card_authorization`, `hold`, `hold_closure`, `hold_closure_reversal`,
`journal_entry`, `journal_line`, `v_available_balance`.

`v_money_writable_by_app` intersects that set with
`information_schema.role_table_grants` for `corgi_app` on `UPDATE`/`DELETE`.
**It must be empty.** It is empty today.

Why this and not a list: "no `UPDATE` on money rows" is enforced by
`%I_no_update_delete` triggers and withheld privileges on the sixty-eight
tables somebody remembered. Nothing noticed the sixty-ninth — which is exactly
how 0029's sentence stayed wrong. Join a new table into anything a balance
reads and it is in the population the moment the migration commits; nobody
declares it and nobody can forget to.

**The textual edges over-approximate on purpose.** `card` is in the set today
because the words "the card model" appear in a comment inside
`ledger_availability`'s body. A wider reachability set can only make the guard
stricter than the truth; a narrower one is the failure this exists to stop, and
a hand-written list is narrower by construction.

## 5. The proof, at the bottom of 0066

A guard nobody has seen red is a claim. Four steps, the shape 0062 uses when it
reads `pg_locks` for a real `RowShareLock` instead of trusting a function that
returns true:

* **A — not vacuous.** The walk must contain `journal_line`, `journal_entry`,
  `account`, `hold`, `card_auth_event`, or "empty" means the walk found nothing.
* **B — the guard fires.** `GRANT UPDATE ON journal_line TO corgi_app` inside a
  PL/pgSQL subtransaction; the view must name it; the subtransaction is rolled
  back by `RAISE`. The grant never commits, and the guard has been seen red and
  green again.
* **C — the refusal is real at the engine.** As `corgi_app`,
  `UPDATE journal_entry SET hold_id = hold_id WHERE false` must fail `42501`.
  `WHERE false`, and the privilege is checked at plan time, so no row is
  considered on either branch.
* **D — the control.** As `corgi_app`, `UPDATE chaos_run SET note = note WHERE
  false` must **succeed** and `... SET auth_cents = auth_cents WHERE false` must
  be **refused**. Without the pair, C proves only that the role is feeble.

`neondb_owner` is a member of `corgi_app` with `admin_option` but
`set_option = false` (PostgreSQL 18 separates the SET half of membership), so C
and D take `GRANT corgi_app TO CURRENT_USER WITH SET TRUE` inside their own
subtransaction and roll it back; the block then asserts
`NOT pg_has_role(current_user, 'corgi_app', 'SET')` so the migration cannot
leave a privilege behind. Run output:

```
NOTICE: 0066 proof A: 10 relations are reachable from a balance: ...
NOTICE: 0066 proof B: guard went red on a planted UPDATE grant and green again
        when the subtransaction rolled back.
NOTICE: 0066 proofs C and D: UPDATE on journal_entry refused (42501); UPDATE on
        chaos_run.note allowed; UPDATE on chaos_run.auth_cents refused. No row
        was written on any branch.
NOTICE: 0066: v_money_writable_by_app is empty, and has been seen red.
```

## 6. HANDOFF — the gate entry, for whoever owns `scripts/dbcheck.mjs`

The proof re-runs only when 0066 is re-applied. To put the guard on every gate
run, the view needs a row in **both** lists — `scripts/dbcheck.mjs` asserts its
`GATED_INVARIANTS` equal to `src/lib/chaos/invariants.ts`'s `INVARIANT_VIEWS`
via `src/lib/chaos/invariants.test.ts`, so adding it to one alone turns that
test red. Both files were another agent's during this pass.

In `src/lib/chaos/invariants.ts`, `INVARIANT_VIEWS`:

```ts
  ['v_money_writable_by_app', 'nothing a balance can reach is writable by the app role'],
```

In `scripts/dbcheck.mjs`, `GATED_INVARIANTS` (same text), and in `REACH`:

```js
  ["v_money_writable_by_app", "relations reachable from a balance",
   "SELECT count(*)::int AS n FROM money_reachable_relations()"],
```

The REACH count is the *population the guard ranges over* — the ten relations a
balance can see — which is the number that should move when somebody adds a
table to the balance path. It is not the violation count; the violation count is
the emptiness check itself.
