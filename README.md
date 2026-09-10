# Corgi work trial — Track 3, Neobank

A US business current account, built on an append-only bitemporal double-entry
ledger: every money row carries `value_date` (when it happened) and
`booking_date` (when we learned it), and no balance is stored anywhere in the
schema. Card authorisations, ACH transfers and a stablecoin payout sit behind
one rail adapter interface; card and ACH events arrive as signed provider
webhooks, land in an inbox, and are turned into journal lines out of band. The
application connects to Postgres as a role that holds `SELECT` and `INSERT` on
the money tables and no `UPDATE`, `DELETE` or `TRUNCATE`, so a posted entry
cannot be edited by the program that wrote it.

Live: **https://corgi-trial-psi.vercel.app**
Decision log: [`DECISIONS.md`](./DECISIONS.md) — 24 entries, append-only, written
as the build happened. It is the spine of this submission.

Demo roles and a five-minute click path: [`docs/DEMO.md`](./docs/DEMO.md).
What was cut and what week two is: [`docs/CUT-LIST.md`](./docs/CUT-LIST.md).

---

## Live versus simulated

**`/api/health` is authoritative. If anything below disagrees with that page,
the page is right.** The table is not written by hand: every verdict on it is
computed by `probeIntegrations()` (`src/lib/integrations/probe.ts`) at the
moment you load the endpoint, and the evidence column is the string that probe
returned. A slot is labelled `live` only when a real authenticated call to the
provider returned 2xx. `unreachable` does not earn `live`, because saying
"live" on a hopeful guess is the precise failure this project is trying not to
commit.

Read at 2026-09-10T17:41:58Z. `integrations.live` **5** of `integrations.total`
**7**.

| Slot | Provider | Verdict | Evidence string returned by the probe |
| --- | --- | --- | --- |
| `card_issuing` *(must be live)* | Lithic sandbox | **live** | `GET /v1/cards -> 200` |
| `card_webhooks` | Lithic | **simulated** | `credential present but NOT probed — no round trip proves this slot works` |
| `director_kyc` *(must be live)* | Persona sandbox, or Stripe Identity | **live** | `Stripe Identity enabled (Persona not configured)` |
| `business_registry` | Stripe Connect (enabled, but v1 retired) — simulated | **simulated** | `Connect is enabled, but Stripe has retired Accounts v1 for new integrations and POST /v2/core/accounts is not wired here, so no connected account can be created; the registry leg runs simulated and is labelled so.` |
| `open_banking` | Plaid sandbox | **live** | `POST /institutions/get -> 200` |
| `ach_rail` | Increase sandbox | **live** | `GET /accounts -> 200` |
| `stablecoin` | USDC on Base Sepolia | **simulated** | `holds 20.00 USDC but only 0 wei gas; a transfer needs ~390000000000 — cannot send` |

Both slots the brief requires to be live — `card_issuing` and `director_kyc` —
are live.

### The one row in that table that is weaker than the others

`card_webhooks` says `simulated`. It previously said `live`, and its evidence
said `no probe defined for this
slot`. That verdict is **not** earned by a round trip. `probeIntegrations()`
has no probe for the slot, so it falls back to the environment-derived status,
which is true when `LITHIC_WEBHOOK_SECRET` is set. A present string is not
evidence of anything — that is the whole argument of DECISIONS 011 — so the
label deserves a sentence rather than a tick.

What actually backs it is stronger than a probe would be: the Lithic webhook
endpoint is registered at the provider, real deliveries arrive signed, the
generic Standard Webhooks verifier accepts them, and they drain into journal
lines. As of the same read, `webhook_inbox` holds 53 rows in state `done` and
11 in state `parked`, all of them from genuine provider deliveries. But the
evidence string on the page does not say that, so this README does.

### The two simulated slots, said plainly

**`business_registry` is simulated because every KYB option on the brief's own
menu is gated.** Persona's business verification wants a sales conversation
(their API-first KYB guide opens by telling you to contact your Persona team);
Middesk and Sumsub the same; Stripe Connect cannot be enabled without first
completing "Verify your business". Measured, not read off a support page:
`POST /v1/accounts` returns 400 *"You can only create new accounts if you've
signed up for Connect"*. I stopped there rather than invent a company to get
past a form. The registry leg runs behind the same interface as a labelled
simulator and the composite KYB result degrades its own evidence label to
`simulated` when either leg was (`src/lib/kyb/`).

**`stablecoin` is simulated because the wallet cannot pay for gas.** It holds
20.00 USDC on Base Sepolia and 0 wei of ETH. An ERC-20 transfer needs roughly
390000000000 wei at current gas price, so the rail can read the chain and
cannot move a cent. Its probe used to call `balanceOf`, get a 200 and report
LIVE — the same lie in a friendlier shape (DECISIONS 016).

### Why this table is computed rather than typed

Three probes in this build reported a healthy slot that could not do its job,
and each was caught only by measuring: a placeholder key marked LIVE by string
presence (011); Stripe reporting LIVE off `GET /v1/balance` with Connect
disabled (015); Stripe reporting LIVE off `GET /v1/accounts`, which also
answers 200 with Connect disabled (017). `/api/health` also once published two
contradicting verdicts for the same slot — the authoritative table said
`business_registry: simulated` while a nested copy under
`integrations.webhooks[].slots[]` said `live`, because that copy read
credential presence instead of the probe (021). The second opinion was removed
rather than reconciled, and `src/app/api/health/consistency.test.ts` now fails
the build if any nested slot disagrees with the authoritative verdict.

---

## Running it from a clean clone

Node 22+ and pnpm. Verified against `package.json` and the scripts themselves;
every command below was run.

```bash
pnpm install
```

### Environment

`src/lib/env.schema.ts` is the contract. **Exactly one variable is required to
boot: `APP_DATABASE_URL`.** A missing provider key is not an error — it selects
that slot's simulator, and the selection is reported by `/api/health`. That is
deliberate: a slot can only be labelled `simulated` if the system is allowed to
run without its key.

> `.env.example` predates the owner/app role split in DECISIONS 008. It still
> names a single `DATABASE_URL` and does not list `DIRECT_URL`, `DRAIN_TOKEN`
> or `MCP_AGENT_TOKENS`. Copy it for the provider-key comments, which are still
> accurate, but take the variable names from `src/lib/env.schema.ts` and the
> list below.

```bash
cp .env.example .env      # then edit; .env is gitignored and must stay that way
```

| Variable | Required | What it is |
| --- | --- | --- |
| `APP_DATABASE_URL` | **yes** | Neon **pooled** URI for the restricted `corgi_app` role. Never the owner. This is the only connection the running application ever uses. |
| `DIRECT_URL` | for scripts | Neon **unpooled owner** URI. Used only by `scripts/migrate.mjs` and `scripts/seed.mjs`. Session advisory locks do not survive PgBouncer, so migrations must not use the pooler. |
| `LITHIC_API_KEY`, `LITHIC_WEBHOOK_SECRET` | no | Card issuing and its webhooks. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | no | Open banking. Sandbox secret only. |
| `INCREASE_API_KEY`, `INCREASE_WEBHOOK_SECRET` | no | ACH. Absent means the labelled ACH simulator is selected, with a `warn` log line saying so. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Stripe Identity for director KYC. A key beginning `sk_live` is refused at boot. |
| `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET` | no | Not configured in this deployment; director KYC runs on Stripe Identity instead. |
| `USDC_SENDER_PRIVATE_KEY`, `USDC_SENDER_ADDRESS`, `BASE_SEPOLIA_RPC_URL`, `USDC_CONTRACT_ADDRESS` | no | Base Sepolia. Testnet key only. |
| `DRAIN_TOKEN` | no | Bearer token for `POST /api/drain`. Without it the endpoint accepts only the Vercel cron header. |
| `MCP_AGENT_TOKENS` | no | JSON array of agent grants for `POST /api/mcp`. See [`docs/MCP.md`](./docs/MCP.md). |
| `SIM_CONTROL_ENABLED` | no | Exposes `/api/sim`. Must be absent or `false` in any shared environment. |

An environment variable set to the empty string counts as absent. A hosting
dashboard where somebody adds the key and leaves the value blank produces `""`,
and treating that as present would mark a slot LIVE with no credential behind
it.

### Migrate, seed, run

The Node scripts read `process.env` directly and do **not** load `.env`
themselves — `next dev` does, they do not. Export it first:

```bash
set -a; . ./.env; set +a

pnpm migrate              # node scripts/migrate.mjs, on DIRECT_URL
node scripts/seed.mjs     # reference data only; there is no pnpm alias for it
pnpm db:check             # 14 checks, as corgi_app
pnpm dev                  # http://localhost:3000
```

`pnpm migrate` applies `db/migrations/*.sql` in order, each in its own
transaction, and records a `node:crypto` SHA-256 per file. A migration whose
contents changed after it was applied is **refused**, not re-run. A second run
is all-skip:

```
  skip   0001_ledger.sql (already applied)
  skip   0002_webhook_inbox.sql (already applied)
  skip   0003_harden_definer.sql (already applied)
  skip   0005_kyb.sql (already applied)
  skip   0006_recon.sql (already applied)
  skip   0007_approvals.sql (already applied)
  skip   0008_holds.sql (already applied)
migrations up to date
```

`scripts/seed.mjs` creates the book entity, the chart of accounts, three
businesses in three KYB states, the actors, the approval and funds-availability
policies, and the `rail_event_semantics` mapping. It posts **zero** journal
entries, on purpose: seeding money would be a second, unverified write path
around `ledger_append()`. It is idempotent — every id is a UUIDv5 over a stable
name — so a second run reports `no change`. It connects as the owner, because
`corgi_app` cannot express an `INSERT` on `account`; if this script ever
succeeds on `APP_DATABASE_URL`, the privilege model has been widened by
accident. See [`db/seed/README.md`](./db/seed/README.md).

`scripts/dbreset.mjs` (`pnpm db:reset`) drops and rebuilds, and refuses to run
if `journal_entry` has any rows unless explicitly forced.

---

## The commands that prove things

### `pnpm db:check` — attempt the forbidden, assert the refusal

Connects as `corgi_app` — not the owner, because privileges never bind a table
owner — and tries `UPDATE`, `DELETE` and `TRUNCATE` on the money tables. A
success here is a failure. Run against production, 2026-09-10:

```
LEDGER INVARIANTS — attempting the forbidden, expecting refusal

  PASS  UPDATE journal_entry is refused — permission denied for table journal_entry
  PASS  DELETE FROM journal_entry is refused — permission denied for table journal_entry
  PASS  TRUNCATE journal_entry is refused — permission denied for table journal_entry
  PASS  UPDATE journal_line is refused — permission denied for table journal_line
  PASS  DELETE FROM journal_line is refused — permission denied for table journal_line
  PASS  TRUNCATE journal_line is refused — permission denied for table journal_line
  PASS  grants on card_auth_event — INSERT,SELECT
  PASS  grants on hold_closure — INSERT,SELECT
  PASS  grants on journal_entry — INSERT,SELECT
  PASS  grants on journal_line — INSERT,SELECT
  PASS  every entry sums to zero — checked all entries
  PASS  trial balance is zero — sum of all lines
  PASS  no stored balance column — balances are derived, not stored
  PASS  denormalised clocks match their entry — zero drift

  14 passed, 0 failed
```

### `node scripts/livefire.mjs` — the published attacks, against production

The seven published attacks plus the replay claim, as eight test files with no
mocks in the directory. Every assertion is against the live Neon database, a
live provider sandbox, or the deployed URL.

```bash
node scripts/livefire.mjs                 # all of them
node scripts/livefire.mjs --only 3,5,6    # a subset, by attack number
```

Needs `APP_DATABASE_URL`, `LITHIC_API_KEY`, `LITHIC_WEBHOOK_SECRET` and
`DRAIN_TOKEN` in the environment, and a seeded database. It runs serially:
Lithic's simulate endpoints are capped at 1 RPS. The verdict per attack is
derived from Vitest's own JSON result, not from anything a test says about
itself, and **a test that cannot prove its claim skips rather than passes**.
See [`src/test/livefire/README.md`](./src/test/livefire/README.md).

Without `LIVEFIRE=1` every file in that directory skips, so `pnpm test` does
not fire real card authorisations at a provider.

### `pnpm test` — the unit and in-memory suite

```
 Test Files  48 passed | 14 skipped (62)
      Tests  833 passed | 88 skipped (921)
   Duration  1.47s
```

The 14 skipped files are the live-fire suite and the database integration
suites; they run when `LIVEFIRE=1` or `RUN_DB_TESTS=1` / `APP_DATABASE_URL` is
present. `pnpm typecheck` and `pnpm lint` are the other two gates, and
`scripts/precommit.sh` runs all three plus a secret scan over every tracked
file before any commit.

---

## Architecture in one screen

The money path, from a provider POST to a journal line:

```
POST /api/webhooks/{provider}                    src/app/api/webhooks/[provider]/route.ts
  │
  ├─ await req.text()          raw BYTES, before anything parses them.
  │                            Providers sign the bytes they sent, not the JSON
  │                            value those bytes denote. One space of
  │                            whitespace is a different signature.
  ├─ verifier.verify(raw, hdr) 401 and NOTHING stored if this fails. An
  │                            unauthenticated body is not evidence.
  ├─ JSON.parse(raw)           only now
  └─ INSERT INTO webhook_inbox ... ON CONFLICT (provider, provider_event_id)
                               DO NOTHING RETURNING id
                               The returned row count IS the decision. Replay
                               dies here, at the database, with no SELECT-then-
                               INSERT race and no `if` in application code.
     → 202 accepted, or 200 on a replay. Nothing has been processed yet.

              after() nudge ──┐   fast path; explicitly droppable
              Vercel cron ────┼──▶ drain()          src/lib/webhooks/drain.ts
     POST /api/drain (bearer) ┘   the demo, and the debrief
                                    │
                                    ├─ dispatchUntilIdle(): claim a row under a
                                    │  lease, hand it to a consumer, then
                                    │  processed / ignored / parked / retry /
                                    │  dead-letter.       src/lib/webhooks/dispatch.ts
                                    ▼
                     consumers/lithic-card            src/lib/webhooks/consumers/
                                    │
                                    ▼
                     applyCardEvent()                 src/lib/holds/apply.ts
                       H(E) = 0 if closed(E) else max(A(E) − C(E), 0)
                       computed over the event SET read back from the database,
                       never over the payload and never from the provider's
                       own status field
                       ├─ memo postings   → 9100/<business>  moves AVAILABLE only
                       └─ financial postings → 2100/<business>  moves the LEDGER
                                    │
                                    ▼
                     postEntry()                      src/lib/ledger/post.ts
                                    │
                                    ▼
                     ledger_append()                  db/migrations/0001_ledger.sql
                       the ONLY sanctioned writer. Assigns booking_seq under the
                       append lock, forces booking_time monotonic, extends the
                       tamper-evident hash chain.
                                    ▼
                     journal_entry / journal_line     append-only. No UPDATE
                                                      privilege exists to revoke.
```

**Where the ledger lives.** `db/migrations/0001_ledger.sql` — the tables, the
four immutability layers, `ledger_append()`, and the derived views.
`src/lib/ledger/` is the typed access layer: `chart.ts` (the chart of accounts
as data, imported by the seed so SQL and TypeScript cannot drift), `post.ts`
(the only caller of `ledger_append()`), `balances.ts` and `queries.ts` (folds).
No balance is stored: `v_ledger_balance`, `v_hold_state` and
`v_available_balance` are views, and `available = ledger − active holds −
uncleared credits` is computed at request time in integer cents.

**Where the rails live.** `src/lib/rails/` — one `PaymentRail` interface with
four methods, satisfied by the Increase ACH adapter, a labelled ACH simulator
and the Lithic card adapter. No ACH nouns at the top level: routing numbers
live inside one variant of a `Destination` union, and SEC codes are reached
through an `AuthorizationKind` intent, because the caller knows how the
customer authorised the payment and does not know that Nacha exists. There is
deliberately no `verifyWebhook` on the interface — verification happens once,
upstream, in the generic Standard Webhooks verifier.

**What the drain does.** The webhook route stops at "verified and persisted",
because Plaid fails a delivery that is not answered within ten seconds and then
retries for twenty-four hours, so no consumer may run inline. The drain is the
half that turns a stored delivery into money, and it has three triggers chosen
because each fails differently: `after()` in the route is a nudge and is
allowed to be dropped; the cron is the guarantee; an authenticated `POST
/api/drain` is the demo. The inbox row is durable before any of the three runs,
so losing all three loses latency and cannot lose money.

**The rest of it.** `src/lib/approvals/` (maker-checker, enforced by a database
trigger and not by a handler), `src/lib/recon/` (the nightly file against the
book, three break categories, aging measured in day closes), `src/lib/kyb/`,
`src/lib/mcp/` (four tools; the write tool queues a request a person must work
through — [`docs/AGENT-LIMITS.md`](./docs/AGENT-LIMITS.md) is the list of what
it deliberately cannot do and why).

---

## Four things measured against reality rather than read in docs

**1. Lithic's `status` field lies about the hold.** The docs contradict
themselves on repeat clearings, so it was measured against the live sandbox
(DECISIONS 006):

```
authorize 1000            status=PENDING   hold=-1000  settled=0
clearing 600  (partial)   status=SETTLED   hold=-400   settled=-600
clearing 300  (2nd)       status=SETTLED   hold=-100   settled=-900
authorize 5000            status=PENDING   hold=-5000  settled=0
clearing 7340 (over-cap)  status=SETTLED   hold=0      settled=-7340
```

`status` flips to `SETTLED` while 400 cents are still authorised. A consumer
that releases the hold on `status == "SETTLED"` — the obvious implementation —
frees money that is still held. `amounts.hold.amount` is signed negative, which
gets the direction wrong as well as the amount. Both traps are avoided by
reading neither field: the hold is a pure function of the event set,
`H(E) = 0 if closed(E) else max(A(E) − C(E), 0)`, derived before the
measurement and reproducing Lithic's own arithmetic in all three cases — 400,
100 and 0. `card_authorization` has no status column as a result.

**2. An ACH return does not erase the settlement.** A full lifecycle through
the Increase sandbox (DECISIONS 019):

```
create   $742.19 outbound ACH credit   status=pending_submission
submit                                 status=submitted
settle                                 status=submitted  settled_at=16:13:05
return   R01 insufficient_fund         status=returned   settled_at=16:13:05
                                                         return_at=16:13:21
```

Two findings. Increase has no `settled` status at all — a settled transfer
stays `submitted` and merely grows `settlement.settled_at`, so a consumer
keying release off `status` releases nothing, ever. And after the return,
`settled_at` is still populated and the transfer id is unchanged: the provider
models a return as a *second money movement*, not as an edit of the first. That
decides a row in `rail_event_semantics` that is otherwise easy to get backwards.
An ACH return is a **new event at a new value date** — the money really did
leave on Monday and really did come back on Thursday, and Monday's statement
must still show the payment. A card clearing reversal is the opposite: a
**correction at the original value date**, because the clearing should never
have posted at that amount. One wrong row there silently corrupts every past
statement it touches while all five invariant views keep returning zero rows,
the hash chain still verifies, and reconciliation stays clean.

**3. The application connects as a role that physically cannot `UPDATE` a money
row.** Not "does not" — cannot. The interesting part is how the gap was found
(DECISIONS 008). The `REVOKE` was in the migration and correct from the first
hour, and it was worth nothing at runtime, because the application connected as
`neondb_owner` and privileges never bind a table owner. `pnpm db:check`
reported 9 failures out of 14 the first time it was ever run, ninety seconds
after it existed. Reading the migration would have passed it. There was a
second-order false negative hiding behind the first: as the owner, `UPDATE …
WHERE true` on an empty table matched no rows, so the row-level trigger never
fired and the statement *succeeded*. As `corgi_app` the privilege check fires
before row matching, so the refusal is provable against an empty table. Fixed
by giving `corgi_app` a password and making `APP_DATABASE_URL` the only URL the
application ever sees; the owner URL is `DIRECT_URL` and runs migrations only.

**4. Probe the capability, not the credential.** Four probes in this build
reported green while the thing they were probing could not work, and every one
was caught by measuring rather than by reading. A placeholder key marked a slot
LIVE because the string was non-empty (011). Stripe answered `GET /v1/balance`
with 200 while Connect was disabled, which proves the credential and nothing
about the capability the slot exists to provide (015). The USDC probe called
`balanceOf`, got 200, and reported LIVE on a wallet with zero gas (016). The
*fixed* Stripe probe called `GET /v1/accounts` — which also returns 200 with
Connect disabled, because reading connected accounts is permitted when you have
none and can create none (017). The rule that survived all four: **probe with
the call the slot's real work depends on, and confirm it fails when the
capability is absent.** A probe nobody has watched fail is not a probe. The
Stripe probe is now a parameterless `POST /v1/accounts`, measured in both
directions; Stripe evaluates the Connect entitlement before it validates
parameters, and nothing is created either way.

---

## Honest current state

**Live fire against production: 7 PASS, 0 FAIL, 1 SKIP.** A skip is not a pass.
Each one prints the sentence naming exactly what could not be proven.

**Attack 2 — the money is right and one row is absent.** On the $50
authorisation cleared at $73.40 the hold *is* released: the memo entries are the
opening delta and its exact negation and nothing else, the ledger posts exactly
7340 in exactly one financial entry, the hold withholds nothing afterwards, and
`available == ledger − holds − uncleared` exactly, in integers, with no clamp.
What is missing is a `hold_closure` row, so the attack's literal wording — "the
hold releases exactly once", read as one closure row — cannot be demonstrated.
The cause is a disagreement between two of my own artefacts, not a money error:
`src/lib/holds/model.ts` computes `closed(E) = is_final OR close/expiry OR
(A <= 0)`, Lithic has no last-capture flag so `is_final` is never set on a
CLEARING, and with A=5000 against C=7340 that is false — while `DESIGN.md` §8.3
row 2, the same over-capture, says `closed = y`. I wrote the one-line `C >= A`
fix, watched three model tests fail, and reverted it: `v_hold_drift` holds the
TypeScript model and the SQL view equal *by invariant*, so changing one side
alone converts a prose mismatch into a live drift alarm, and an invariant
reporting drift is indistinguishable from a ledger that has actually drifted.
The full reasoning is DECISIONS 024. Week two is one migration that moves both
sides together with `v_hold_drift` proving they still agree.

**Attack 7 — a genuine missing feature.** `/api/health` reports credential and
capability liveness per slot and says nothing about webhook *delivery
freshness*, so an issuing-provider outage is invisible to it, and no
provider-down state renders on the account screen. Everything the outage
attack asserts about the money already holds — through the dark window the
trial balance does not move, the swallowed event has zero inbox rows, nothing
is invented; on recovery a doubled backlog produces one inbox row, one
`card_auth_event`, one hold, and available drops by exactly 5000. Only the
"degrades visibly" half is unproven. The data to build it already exists in
`webhook_inbox.received_at`, the test greps for `lastDelivery`, `deliveryLag`,
`secondsSinceLastDelivery`, `webhookHealth` or `feedStale` and will pass the
moment one lands, and it is the top item on
[`docs/CUT-LIST.md`](./docs/CUT-LIST.md).

**Other things not done, in one place.** The USDC payout is blocked on testnet
gas rather than on code. Persona is not signed up, so director KYC runs on
Stripe Identity, which cannot script a `declined` or `needs_review` outcome —
the non-happy-path KYC states are not third-party. Eleven webhook deliveries
are `parked` rather than processed: they are authorisations on Lithic cards
created directly in the sandbox and never registered to a customer here, so the
consumer will not guess whose money to move. They are verified, durable, and
post the moment a card is claimed. Two dead sandbox credentials remain in the
git history of this private repo; both were rotated or expired before the
scrub, and the history purge needs a force push that has not been taken
(DECISIONS 023). Three card holds carry a `hold_closure` row that the event
fold disagrees with — the residue of a bug the code no longer has; the
arithmetic and the reasoning are in [`docs/CUT-LIST.md`](./docs/CUT-LIST.md).
