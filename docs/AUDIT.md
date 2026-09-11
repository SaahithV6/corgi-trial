# The actor trail

*Who did what to this business, in order.*

The ledger answers "what happened to the **money**", and it answers it four
ways over: privileges, triggers, no `ON CONFLICT DO UPDATE`, and a sha256 hash
chain. `pnpm db:check` proves the application role cannot physically express
`UPDATE` on a money table.

Nothing answered "who **did** that". The facts existed — an approvals trail, an
MCP audit log, `kyb_verification_leg`, `standing_order_outcome`,
`webhook_inbox`, and about thirty other stores — but scattered, in four
different shapes, with four different ideas of what an actor is. There was no
way to ask the first question a regulator or an incident review asks.

`/audit` is that question, answered from the rows that already exist.

---

## 1. The survey: every place an action IS recorded

Thirty-nine stores. Each one is registered in `audit_source` with a written
reason, and `v_actor_action` (migration `0035_audit.sql` §5) projects each into
one common shape.

| Surface | Store | Actor model it uses |
| --- | --- | --- |
| accounts | `account_opening` | `opened_by` → `actor` |
| kyb | `kyb_verification_leg` | `decided_by_actor_id` + `decided_by_kind`, **or the provider** when null |
| payments | `payment_instruction_event` | `actor_id` → `actor` |
| standing orders | `standing_order`, `standing_order_cancellation` | `created_by` / `cancelled_by` |
| standing orders | `standing_order_occurrence` (+ its outcome) | `claimed_by` / `decided_by_run`, **free text** |
| cards | `card` | **no actor column at all** |
| cards | `card_control_version` | `created_by` |
| cards | `card_auth_decision` | `source` text (`provider` \| `harness`) |
| cards | `card_auth_event` | the issuer processor |
| holds | `hold_closure`, `hold_closure_reversal` | `actor_id` |
| disputes | `dispute_event` | `actor_id` |
| fx | `fx_quote`, `fx_quote_acceptance`, `fx_quote_settlement` | `created_by` / `accepted_by` / `settled_by` |
| payees | `payee`, `payee_verification`, `payee_acknowledgement`, `payee_archival`, `payee_candidate_refusal` | `created_by` / `checked_by` / `acknowledged_by` / `archived_by` / `attempted_by` |
| pots | `pot` | `opened_by` |
| statements | `statement` | `generated_by` |
| interest | `interest_schedule`, `interest_day` (+ posting) | `created_by` / `decided_by_run` |
| fees | `accrual_schedule`, `accrual_day` (+ posting) | `created_by` / `decided_by_run` |
| interchange | `interchange_posting`, `interchange_reversal` | `posted_by_run` text / `created_by` |
| ledger | `journal_entry` | `actor_id` |
| webhooks | `webhook_inbox` | the provider |
| book | `book_day` | `closed_by` |
| recon | `recon_run`, `scheme_file`, `recon_break_note` | `run_by` / `imported_by` / `created_by` |
| chaos | `chaos_event` | `actor` **free text** |
| policy | `interest_rate_policy`, `interchange_rate_policy` | `created_by` |
| agent | `mcp_audit` | `actor_id` → `actor`, **or nothing** when the token itself was refused |

**Four shapes, exactly as advertised.** A `uuid` into `actor`; a free-text run
name (`test-20260910223609-A`, `interchange:backfill`); a provider string
(`lithic`, `stripe-identity`); and nothing at all. The trail normalises all four
into five actor kinds — §3.

Measured on the live book at the time of writing: **11,139 rows across 39
sources, 11,139 projected, 0 dropped** — the last of which is `mcp_audit`,
which was registered but empty until the agent surface was wired to it (§2.1a).

---

## 2. The second list: every place an action is taken and recorded NOWHERE

This is the more valuable half, and it is printed on the screen — not only
here — because a trail that shows only what it has is exactly the trail that
reads complete and is not.

### 2.1 Actions with no durable record anywhere

**1. ~~Every MCP read call.~~ CLOSED — see §2.1a.** This was the worst gap on
the book and it is the one item on this list that has been shut. The section
below is kept as the record of what it was and how it was closed, because a
list of holes that silently loses an entry is the same defect as a trail that
reads complete.

**2. A webhook that fails signature verification.**
`src/lib/webhooks/route-handler.ts` returns 401 with the body *"signature
verification failed; nothing was stored"*. Someone hammering the Lithic
endpoint with forged events leaves **no row in this database at all**; only a
log line. This is the exact shape of the trap: `webhook_inbox` holds only the
*accepted* callbacks, so a trail built on it reads complete while every refused
attempt is invisible. The fix is a `webhook_rejection` table (provider, reason,
source ip, `received_at` — never the body, which is unauthenticated input) on
the 401 path, and the precedent already exists in this schema:
`payee_candidate_refusal` records exactly this class of fact for payees.

**3. Which role a console operator was acting as.**
`src/components/app-shell/role.ts` is a cookie, and says so in its own header:
*"a cookie the browser can set is not an access-control decision"*. There is no
record of who switched to `approver` and when. Today nothing is load-bearing on
it; when real sessions land, the switch becomes an auditable act.

### 2.1a The MCP gap, and how it was closed

**What it was.** `src/lib/mcp/audit.ts` builds a complete audit record for every
call — the tool, the business scope, the redacted arguments, the outcome, and
every **refusal** — and wrote it to one JSON line on stdout and nowhere else.
Ten read tools served a customer's balances, transactions, payees, pots,
standing orders, card controls, accruals, disputes and reconciliation breaks to
an autonomous agent, and this database held no record that any of it happened.
A projection cannot read a row that was never written, which made this the one
surface where the read-versus-write argument in §4 came out on the side of
writing.

**What closed it.** `0035_audit.sql` §2 had already created `mcp_audit`,
defended exactly like a money table, and `src/lib/audit/sink.ts` was already the
writer. What was missing was the call site, in a file another worker owned.
It is now:

```ts
// src/app/api/mcp/route.ts — POST
const log   = logger({ requestId: requestIdFrom(request.headers) });
const trail = durableAuditSink({ log });

const server = createMcpServer({
  …,
  audit: teeAuditSink(loggerAuditSink(log), trail.sink),
});

const response = await server.handlePost(request);
return stamp(response, await trail.settle());   // x-corgi-audit: persisted | degraded
```

Three things about that shape are decisions rather than style:

- **The tee order.** `loggerAuditSink` is first because it touches no database,
  so the record exists before anything reaches for Postgres. Lose the database
  and the record degrades from durable to a log retention window, not to
  nothing.
- **`settle()` is awaited.** The obvious writer here is
  `void insert(entry).catch(log)`, and it is the trap this table exists to
  avoid: on a serverless runtime the instance is frozen the moment the response
  is returned, so a detached insert can be dropped *along with its own catch
  handler*. No row, no error line, no gap anybody can see — a failure to audit
  that silently succeeds. Awaiting costs one round-trip per call and is the
  price of the table meaning anything.
- **An audit failure fails open for the call and closed for the claim.** The
  call is served; the claim that it is on the trail is withdrawn, in an
  error-level `mcp.audit.persist_failed` line *and* in `x-corgi-audit:
  degraded` on the response, so the caller learns it and not only the operator.
  The house position in `docs/AGENT-LIMITS.md` — a check that cannot record its
  own failure is worse than no check — binds, and is satisfied there rather
  than by a refusal. The reason not to refuse is that `server.handlePost`
  builds the record in a `finally`, **after** dispatch: the gateway has already
  issued its `SELECT`s and the balance is already in the response object, so
  refusing would withhold the answer while leaving the data access identical. A
  gate that runs after the thing it gates is theatre. The honest fail-closed
  design is two-phase — an `attempted` row before dispatch, a `completed` row
  after — and it is the right build the day this surface grows a read whose
  mere execution is the sensitive act. It has none today, and the one **write**
  tool never depended on this table at all: an agent-initiated payment is
  recorded synchronously and transactionally in `payment_instruction` plus its
  `requested` event. The full argument is the header of
  `src/lib/audit/sink.ts`; the failure paths are executed against an injected
  failing handle in `src/lib/audit/sink.test.ts`, with no credentials, because
  a failure path nobody has run is a comment.

**The rows, from real calls against the running server.** `at`, `request_id` and
`client_key` dropped for width; nothing else is:

```
 tool              | outcome        | error_code        | actor_id  | business_id | grant_label           | grant_fp | arguments                                               | duration_ms
-------------------+----------------+-------------------+-----------+-------------+-----------------------+----------+---------------------------------------------------------+-------------
 get_balance       | ok             | (null)            | 3743dc53… | e274546d…   | demo-read-and-propose | 7b5c37ab | {}                                                      | 1988
 approve_payment   | protocol_error | REFUSED_OPERATION | 3743dc53… | e274546d…   | demo-read-and-propose | 7b5c37ab | {"instruction_id": "any"}                               | 1
 list_transactions | protocol_error | INVALID_ARGUMENTS | 3743dc53… | e274546d…   | demo-read-and-propose | 7b5c37ab | {"limit": 5, "business_id": "1151e7b5-…-68cd714178ce"}  | 2
 (null)            | refused        | UNKNOWN_TOKEN     | (null)    | (null)      | (null)                | (null)   | (null)                                                  | 1
```

Row 2 is a refused tool name — an agent probing for an operation this surface
deliberately does not have, which is the signal the table exists for. Row 3 is a
scope violation, and it keeps both halves of the fact: `arguments` holds the
business the agent **asked** for, the `business_id` column holds the one its
token is **scoped** to. Row 4 is a refusal at the door, with a null actor,
because an unknown token has no actor and inventing one would be the only
dishonest row in this schema — it is projected as book-wide rather than dropped.

No token is in any of them. `grant_fp` is four bytes of the token's sha256:

```
SELECT count(*) FROM mcp_audit
 WHERE (arguments::text || coalesce(result::text,'')
        || coalesce(grant_fp,'') || coalesce(grant_label,'')) LIKE '%corgi_mcp_demo%';
 → 0
```

And the refusal cannot be turned into a success afterwards:

```
UPDATE mcp_audit SET outcome = 'ok' WHERE outcome = 'refused';
 → ERROR: permission denied for table mcp_audit
DELETE FROM mcp_audit WHERE outcome = 'refused';
 → ERROR: permission denied for table mcp_audit
```

**The registration moved with the call site and not before it.**
`0037_mcp_audit_wiring.sql` appends a superseding `audit_source` row taking
`mcp_audit` from `awaiting_wiring` to `projected`. It is an `INSERT` and not an
`UPDATE`: the history of what this trail claimed to cover is itself evidence,
and `audit_source_no_update_delete` would refuse the alternative anyway. The
`awaiting_wiring` disposition existed precisely so that "zero rows because
nobody writes it" could never be mistaken for "zero rows because nothing
happened", so flipping it early would have been the lie it was built to
prevent.

### 2.2 Actions recorded, but with no actor — the `unattributed` kind

These have a row and a timestamp and no answer to "who". They are projected
into the trail as `actor_kind = 'unattributed'`, drawn in the negative colour,
and never quietly rendered as `system`.

| Store | What is unattributed | What it needs |
| --- | --- | --- |
| `card` | **A card was issued to a person.** 352 rows on this book; 84 on Ridgeline alone. | `issued_by uuid REFERENCES actor(id) NOT NULL` |
| `approval_policy` | **The maker-checker threshold itself.** No actor column *and no timestamp column* — who raised the approval threshold, and when, is not merely unattributed, it is unrecordable. The single highest-value unaudited action in the schema. | `created_by uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()` |
| `actor` | **The register of who exists.** Creating a user, granting `can_approve`, or removing a team member leaves no row anywhere: no `actor_event` table, no `created_by`, no removal concept. *"Who removed a team member"* is currently unanswerable. | an append-only `actor_event (actor_id, kind, by_actor_id, occurred_at, reason)` |
| `business` | Who onboarded this legal entity. `created_at` only. | `created_by uuid NOT NULL` |
| `funds_availability_policy` | Who changed how long a wire credit is withheld. `created_at`, no `created_by`. | `created_by uuid NOT NULL` |

Ridgeline Robotics carries **84 unattributed actions** out of 2,209. Every one
of them is a card issued to a named person by nobody.

### 2.3 Stores that exist and are not yet on the trail

`v_audit_source_unclaimed` reported nine on its **first run**, and they were
not planted — they are tables two other live workers created while this was
being built:

```
card_member, team_member, team_member_version,
outbound_event, outbound_endpoint, outbound_endpoint_secret,
outbound_attempt, outbound_delivery, outbound_cursor
```

`team_member_version` is, on its face, the answer to *"who removed a team
member"*. It is **not** projected, on purpose:

- those schemas are being written right now and are not stable, and a view that
  depends on a column blocks the `ALTER`/`DROP` that changes it — a projection
  added too early would turn another worker's migration red;
- more importantly, **the screen reporting them is the feature working.** The
  trail says out loud that it does not cover the team and outbound-event
  surfaces yet, instead of reading complete. Claiming each one is a one-row
  `INSERT` into `audit_source` plus one `UNION ALL` branch.

`outbound_endpoint_secret` must stay excluded on a stronger ground than
staleness: it holds signing secrets, and an audit trail is the worst possible
place for them.

---

## 3. The actor model

Five kinds, where the schema's `actor_kind` enum has three
(`human | agent | system`).

| Kind | What it is | Autonomous? |
| --- | --- | --- |
| `human` | A named person. The **only** kind that can approve anything. | no |
| `agent` | An autonomous MCP client acting under a token. | yes |
| `system` | A cron tick, a nightly run, the ledger poster. | yes |
| `provider` | A third-party callback: Lithic, Increase, Stripe, Plaid. | yes |
| `unattributed` | The store recorded the act and not the actor. | yes |

**Why `provider` is not in the `actor` table.** A provider is a counterparty,
not a principal of ours. Giving Lithic a row in `actor` would make it eligible
for a `can_approve` column, and the only thing standing between an agent and a
self-approved payment in this system is
`CONSTRAINT actor_only_humans_approve CHECK (NOT (kind <> 'human' AND can_approve))`.
The trail therefore carries `provider` as a kind and `NULL` as the actor id.

**Why `system` is not merged into `agent`.** "The accrual run posted this" and
"a model decided to post this" are different facts. `docs/AGENT-LIMITS.md` is
the written statement of that boundary; collapsing the two kinds would make its
observable half meaningless. A cron tick is not a person *and* it is not a
judgement call.

**Why `unattributed` is a kind and not a blank.** It is a first-class value
because it is a defect. Rendering an unattributed act as `system` is how a hole
becomes invisible, and the 84 card issuances in §2.2 are exactly the population
that would disappear.

**At a glance.** `src/components/audit/ActorBadge.tsx` gives `agent` the
negative tone and the word **AGENT** in capitals, and `unattributed` the
negative tone and the words *no actor recorded*. Colour is never the only
channel — every badge carries its own word and a `title` with the full
sentence. `?state=edge` is the agent filter, live off the book.

---

## 4. Read, not write — the decision and the argument

The trail **reads** thirty-nine existing stores. It is not a write path that
every surface must call.

### Why

**A write path is invisible exactly where a surface forgets to call it, and
there is no way to check.** That is the failure this repository has now found
seventeen times: every guard that failed did so because what it excluded was
shaped exactly like the thing it existed to catch, and each one reported
healthy. A write path fails in precisely that shape — the surface that never
calls the logger is absent from the trail, the trail reads complete, and the
omission surfaces in an audit rather than in CI. You cannot write the
completeness check for it, because **there is no catalog of call sites**.

**A projection has exactly one failure mode, and it is detectable.** The mode
is "a store exists and is not read", and there *is* a catalog of tables. §7 of
the migration diffs `information_schema.tables` against the registry: every
base table must be projected or excluded with a written reason, and anything
else is reported. That check found nine unclaimed tables on its first run
before anyone looked — see §2.3.

**It is retroactive.** A write path starts at its deploy and leaves everything
before it invisible forever. This projects the 2,860 journal entries, 925
provider callbacks and 426 approval events that were already on the book, from
the moment it shipped.

**It cannot be edited, because it owns no rows.** The strongest available form
of "append-only" is having nothing to update. Every row on the timeline is read
live out of a store `corgi_app` holds no `UPDATE` and no `DELETE` on, and
`v_audit_source_mutable` re-derives that from
`information_schema.role_table_grants` on every render rather than asserting it
in a comment.

**It cannot double-count or drift.** A write path introduces a second copy of
every fact, and two copies of a fact are two things that can disagree. The
projection *is* the fact.

### What reading costs, stated rather than hidden

1. **A surface that records nothing durably cannot be read into existence.**
   There was exactly one such surface — the MCP read log — and it now has a
   table, a writer and a call site (§2.1a). The cost is real, it was bounded to
   one place, and that place is closed. Note what the projection could not have
   done for it: no view over the existing schema could have recovered a refused
   call, because a refusal touches no other table by definition.
2. **Semantics live in a view.** Adding a source means editing SQL, and a view
   with thirty-nine `UNION ALL` branches is a big object. It is mechanical, it
   is reviewable in one sitting, and the coverage check makes a mistake in any
   branch loud.
3. **Attribution is derived, not recorded.** A ledger entry's business comes
   from the first per-business leaf it touches; a webhook's comes from the
   first entry or card event that cites it. Where that cannot be resolved the
   row is projected with `business_id IS NULL` and shown as book-wide — never
   dropped.

### The rule that makes it safe

**Every join in the projection is a `LEFT JOIN`.** An `INNER JOIN` to `account`
silently drops rows whose parent was never written, which is the shape of the
bug the trail exists to find. Nothing may drop a row; a row that cannot be
attributed gets `business_id IS NULL`, and §6 asserts
`projected_rows = stored_rows` for every source.

---

## 5. Completeness, measured

`/breaks` prints *"showing 7 of 7, the engine reported 7, this screen hides
none"*. The equivalent claim for an actor trail is harder, because the thing it
could be missing is not a row — it is a whole store. So the screen makes four
statements, each of which is a live query:

| View | Claim | Status on the live book |
| --- | --- | --- |
| `v_audit_coverage` | rows counted directly off each table = rows out of the projection | 39 sources, 11,139 = 11,139, **0 dropped** |
| `v_audit_coverage_drift` | **must be empty** | empty |
| `v_audit_source_unclaimed` | **must be empty**: every base table classified | **9 rows** — see §2.3 |
| `v_audit_source_mutable` | **must be empty**: no projected source is app-mutable | empty |
| `v_audit_source_weak` | report: projected sources with no UPDATE/DELETE trigger | 1 row: `chaos_event` (grants only, no trigger) |

Re-measured after `mcp_audit` was wired and its disposition moved to
`projected` — which is the change that puts it in front of the two invariants
that bind `projected` sources only:

```
 source     | disposition | stored_rows | projected_rows | dropped_rows | attributed_rows
------------+-------------+-------------+----------------+--------------+-----------------
 mcp_audit  | projected   | 6           | 6              | 0            | 5

 drift 0 | mutable 0 | unclaimed 9 | weak 1 | 39 sources | stored 11,139 = projected 11,139
```

The total moves between readings — other surfaces are writing to this book
while you read it — and that is fine, because the claim is not a number. The
claim is that two independently computed counts are equal, and
`v_audit_coverage_drift` is the assertion.

Six rows: the four quoted in §2.1a, plus a `list_agent_limits` and a
`tools/list` made afterwards to re-verify the route. `attributed_rows` is 5 of
6 on purpose: the refusal at the door has no business,
because an unknown token has no scope. It is projected as book-wide, never
dropped — §4's rule holds for the newest source as it does for the oldest.
`mcp_audit` does not appear in `v_audit_source_mutable` (`corgi_app` holds only
`SELECT` and `INSERT`) and does not appear in `v_audit_source_weak` (it carries
`mcp_audit_no_update_delete`, so the table owner cannot rewrite it either).

The two counts in `v_audit_coverage` are computed **independently on purpose**.
Deriving `stored_rows` from the projection would make the check tautological —
green because it is the same number twice, which is the same defect as a guard
that cannot fail.

### The invariant, made to fail on purpose

`v_audit_coverage_drift` had **no reach** on the book as it stood: every
`accrual_day` had a posting, every `standing_order_occurrence` had an outcome,
every `card_auth_event` had an authorisation. Green because there was nothing
to be green about. So the reachable state was created and the guard broken, in
a transaction that was rolled back — the same method as
`scripts/dbcheck.mjs --prove`:

1. Plant the real state a `LEFT JOIN` exists for: an `accrual_day` a nightly
   run **claimed and never decided**. (`v_accrual_unresolved` exists for
   exactly this.)
2. Read the coverage row. Then change one `LEFT JOIN accrual_posting` to
   `JOIN accrual_posting` and read it again.

```
planted: accrual_day 2027-10-06 — claimed, never decided
LEFT JOIN  : stored 36  projected 36  | v_audit_coverage_drift = 0
INNER JOIN : stored 36  projected 35  | v_audit_coverage_drift = 1

 source       disposition  stored_rows  projected_rows  dropped_rows
 accrual_day  projected    36           35              1
rolled back — nothing written
```

**Delta: 0 → 1.** The guard reports the exact source and the exact count. It
runs as a test:
`src/lib/audit/audit.integration.test.ts` → *"CAN report a dropped row —
proven, not assumed"*.

That test opens **its own owner connection**, and the reason is the feature
working: `corgi_app` holds no `CREATE` on schema `public` and no `INSERT` on
`accrual_day`, so the application role physically cannot rehearse this failure.
Proving a guard can fail requires breaking it, and breaking it requires the
owner — the same split `scripts/migrate.mjs` (`DIRECT_URL`) and
`scripts/dbcheck.mjs` (`APP_DATABASE_URL`) already keep.

### `v_audit_source_unclaimed` was born failing

It was never green. On first execution against this database it returned the
nine tables in §2.3, created by other workers during this build, and the screen
printed them in red. The detector is the **widest possible one** — every base
table in `public`, no `LIKE`, no column-shape heuristic, no "looks like an
event" pattern — because a narrower detector can be fooled by a store shaped
exactly like the thing it would skip. Over-reporting costs one row of typing;
under-reporting costs an audit.

---

## 6. Append-only, four layers, same as the money tables

The trail owns two tables — `audit_source` (the registry) and `mcp_audit` — and
both carry the same defence `0001` §13 gives `journal_entry`:

1. `corgi_app` holds `INSERT` + `SELECT` on `mcp_audit`, `SELECT` only on
   `audit_source`. No `UPDATE`, no `DELETE`, no `TRUNCATE`.
2. `BEFORE UPDATE OR DELETE ... EXECUTE FUNCTION audit_append_only()` — which
   raises regardless of role, because privileges never bind a table **owner**.
3. `BEFORE TRUNCATE ... EXECUTE FUNCTION audit_no_truncate()` — `TRUNCATE` is
   not `DELETE`.
4. No `UPDATE` path in application code. `audit_source` is written by
   migrations only; a later migration that starts projecting a store **appends
   a superseding row** and `v_audit_source` takes the latest per table. The
   history of what the trail claimed to cover is itself evidence.

Proven by `audit.integration.test.ts` → *"refuses an UPDATE on the two tables
the trail does own"*.

`webhook_inbox` is the one projected source `corgi_app` can `UPDATE`, and it is
a **named carve-out with a named guard**, not a privilege pattern.
`webhook_inbox_guard()` refuses `DELETE` outright and refuses any change to
`provider`, `provider_event_id`, `payload`, `event_type`, `received_at`,
`raw_body`, `headers` or `signature_verified_at` — which is exactly and only
the set of columns the projection reads. The mutable processing state
(`state`, `attempts`, `processed_at`, the park fields) is **not evidence and is
not projected**. Any other table that acquires `UPDATE` still fails
`v_audit_source_mutable`.

---

## 7. Secrets

The projection is the redaction boundary, so every reader of `v_actor_action`
inherits it rather than re-implementing it. It never selects:

- `card.provider_card_token` — card identity is `last_four` only;
- `webhook_inbox.raw_body` or `headers` — unauthenticated input, and the
  headers carry the signature;
- `outbound_endpoint_secret.*` — excluded from the registry outright;
- any full account number. None exists in this schema to leak: `payee` and
  `payment_instruction.counterparty` already store
  `account_number_last4` plus the ABA routing number, which the Fed publishes
  and which is what an investigator needs in order to name the receiving
  institution.

Asserted by `audit.integration.test.ts` → *"never projects a card token, a PAN
or a full account number"*, which greps `pg_get_viewdef()` rather than trusting
the source file.

---

## 8. The screen

`/audit`. Five URL states, all reachable from the query string:

| URL | State | Source |
| --- | --- | --- |
| `/audit` | default | **live** — the busiest business, every action, in order |
| `/audit?state=loading` | loading | fixture, held open 2.5 s so the skeleton is real |
| `/audit?state=empty` | empty | **live** — the quietest business filtered to agent actions: genuinely `0 of 9` |
| `/audit?state=error` | error | a throw shaped like a Neon connect timeout |
| `/audit?state=edge` | edge | **live** — `actor_kind = 'agent'` |

Filters and the drill-through are URL state too: `?business=`, `?kind=`,
`?surface=`, `?source=`, `?scope=all`, `?order=occurred`, `?page=`, `?action=`.

**The edge state is the agent** because it is the row a reviewer looks at
hardest and the one most likely to render wrong: every other row on the screen
is a person, and a template that reads well for a person reads *reassuringly*
for a model. It is live rather than a fixture — a fixture would prove the
component renders, not that an agent is distinguishable in data we did not
write for the demo.

**Both time axes.** Every row carries `occurred_at` (when it happened) and
`recorded_at` (when we learned). Most stores keep one clock, so the second
column renders as `—` with the pair in the tooltip — printing two identical
timestamps would imply a second observation that never took place. A row where
they genuinely disagree gets a **learned later** badge; 1,026 of Ridgeline's
2,209 actions do. The list is ordered by **one named axis at a time** and the
header says which: `recorded` is an incident review walking backwards through
what we learned, `occurred` is a regulator asking what happened on Tuesday.
`v_business_timeline` also exposes `sort_at = GREATEST(occurred_at,
recorded_at)` and the screen deliberately does **not** use it: a blended order
answers both questions by answering neither, and on this book it floats a
live-fire entry value-dated 2027-12-07 above everything that happened today.

**Drill-through.** Clicking an action prints the source table and the primary
key of the row it came from — `SELECT * FROM <source> WHERE id = '<pk>'` —
plus the projected `detail`, and links on to the screen that owns the subject
where one exists. It does not invent links: a subject with no screen prints its
id and stops, because a dead link in an audit trail is worse than no link.

---

## 9. Known follow-ups, each a small named change

1. ~~**Wire `mcp_audit`.**~~ **Done** — §2.1a. `src/app/api/mcp/route.ts` tees
   into `src/lib/audit/sink.ts` and awaits the row before the response leaves;
   `0037_mcp_audit_wiring.sql` moved the registration to `projected`. What
   remains here is smaller and named: the two-phase `attempted`/`completed`
   write, which is only worth building if this surface ever gains a read whose
   execution is itself the sensitive act.
2. **`/audit` is not in the nav or on the front door.** Both files belong to
   other workers in this build:
   - `src/components/app-shell/NavLinks.tsx` — one entry,
     `{ href: "/audit", label: "Audit trail" }`, in the operations group.
   - `src/components/home/ScreenLinks.tsx` — one entry in `SCREENS`.
     `ScreenLinks.test.ts` walks `src/app/(app)` and fails until every route is
     either listed or given a reason in `NOT_ON_THE_FRONT_DOOR`, which is the
     correct behaviour and is the same ratchet that currently also reports
     `/events`. **That test was already failing on `/events` before `/audit`
     existed**; `/audit` adds a second line to a list that was not empty.

   Suggested entry:

   ```ts
   {
     href: "/audit",
     title: "Audit trail",
     summary:
       "Who did what to one business, in order, projected from every append-only store on the book.",
     why: "It reconciles itself: 39 sources, stored rows versus projected rows, 0 dropped — and it prints the stores it does NOT cover rather than reading complete.",
   },
   ```
3. **The two invariants are not in `dbcheck`.** `scripts/` belongs to another
   worker. `v_audit_coverage_drift` and `v_audit_source_mutable` are both
   "MUST RETURN ZERO ROWS" views in the exact shape that file's
   `INVARIANT_VIEWS` array takes; they run in `audit.integration.test.ts` in
   the meantime, because an assertion nothing runs is a comment. Adding them
   also requires the mirrored edit in `src/lib/chaos/invariants.ts` that
   `src/lib/chaos/invariants.test.ts` enforces.
4. **Claim `team_member_version` and the `outbound_*` tables** once those
   schemas settle — §2.3.
5. **Record webhook signature rejections** — §2.1, item 2.
6. **Add the five missing actor columns** — §2.2. Each is a new migration, not
   an `ALTER` of an applied one.
