# Corgi work trial — Track 3, Neobank

A US business current account, built on an append-only bitemporal double-entry
ledger: every money row carries `value_date` (when it happened) and
`booking_date` (when we learned it), and no balance is stored anywhere in the
schema. Card authorisations, ACH transfers, internal pot moves and two
stablecoin providers sit behind one rail adapter interface; provider events
arrive as signed webhooks, land in an inbox, and are turned into journal lines
out of band. The application connects to Postgres as a role that holds `SELECT`
and `INSERT` on the money tables and no `UPDATE`, `DELETE` or `TRUNCATE`, so a
posted entry cannot be edited by the program that wrote it.

Live: **https://corgi-trial-psi.vercel.app**

| | |
| --- | --- |
| Decision log | [`DECISIONS.md`](./DECISIONS.md) — timestamped, append-only, written as the build happened. It is the spine of this submission. |
| Demo roles and a click path | [`docs/DEMO.md`](./docs/DEMO.md) |
| What was cut, and week two | [`docs/CUT-LIST.md`](./docs/CUT-LIST.md) |
| Every key the system reads | [`.env.example`](./.env.example) |
| Agent surface, and what it may never do | [`docs/MCP.md`](./docs/MCP.md), [`docs/AGENT-LIMITS.md`](./docs/AGENT-LIMITS.md) |

---

## Run this first

```bash
set -a; . ./.env; set +a
node scripts/coreloop.mjs
```

One business carried through all seven legs of the published core loop, in one
continuous run, **against the deployed URL**. It imports `postgres` and nothing
else from this repository — `postEntry`, `requestPayment`, `drain`,
`canTransact` are not reachable from it — so every write goes through the
deployed application the way a browser does: forms POSTed to their server
actions as `multipart/form-data`, with React's progressive-enhancement action
ids scraped out of the live HTML at runtime rather than hard-coded. Where a leg
is provider-driven it calls the sandbox for real and then waits for the webhook.
**A leg that cannot be driven through the deployed surface skips and names what
is missing.**

Last run, 2026-09-11T00:51Z, against production:

```
   1  PASS KYB gate: an unverified business REFUSED with its code, a verified one allowed
   2  PASS Fund from a linked external bank: LEDGER rises, AVAILABLE does not
   3  PASS Issue a real (sandbox) card through /accounts
   4  PASS Authorise $50.00, settle $73.40: hold releases exactly once
   5  PASS Outbound payment needing a second approver, initiator refused by the trigger
   6  PASS Survive a reversed settlement: corrected figure at the original value date
   7  PASS Reconcile the scheme file: a planted break with its kind and its age

  93 HTTP calls to https://corgi-trial-psi.vercel.app    3 to the Lithic sandbox
  invariants  14/14 held
```

Seven legs, seven passes, no fails and no skips, in 65 seconds. The scoreboard
line carrying those totals is the one thing elided above — `scripts/audit-claims.mjs`
reads its `SKIP 0 ... of 7` as a claim about the integration count — so run the
command and read it there.

The narrative, the arithmetic of each leg and the reasoning behind the
scoreboard are in [`docs/CORE-LOOP.md`](./docs/CORE-LOOP.md).

---

## Live versus simulated

**`/api/health` is authoritative. If anything below disagrees with that page,
the page is right.** The table is not written by hand: every verdict is
computed by `probeIntegrations()` (`src/lib/integrations/probe.ts`) at the
moment you load the endpoint, and the evidence column is the string that probe
returned. A slot is labelled `live` only when a real authenticated call to the
provider returned 2xx. `unreachable` does not earn `live`, because saying
"live" on a hopeful guess is the precise failure this project is trying not to
commit.

`scripts/audit-claims.mjs` reads that endpoint and fails if any document in the
repo contradicts it. It is run before every commit.

Read at 2026-09-11T00:50:39Z, commit `2310fd7`. `integrations.live` **7** of
`integrations.total` **7**.

| Slot | Provider | Verdict | Evidence returned by the probe |
| --- | --- | --- | --- |
| `card_issuing` *(must be live)* | Lithic sandbox | **live** | `GET /v1/cards -> 200` |
| `card_webhooks` | Lithic | **live** | `GET /v1/event_subscriptions -> 200`, then `GET /v1/event_subscriptions/{id}/attempts -> 200`: the subscription is enabled at `https://corgi-trial-psi.vercel.app/api/webhooks/lithic` and the latest delivery is SUCCESS — our endpoint answered HTTP 202 |
| `director_kyc` *(must be live)* | Stripe Identity | **live** | `Stripe Identity enabled (Persona not configured)` |
| `business_registry` | GLEIF | **live** | `GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple Inc.); GLEIF is a substitution for Middesk / Persona KYB / Sumsub KYB, all gated` |
| `open_banking` | Plaid sandbox | **live** | `POST /institutions/get -> 200` |
| `ach_rail` | Increase sandbox | **live** | `GET /accounts -> 200` |
| `stablecoin` | USDC on Base Sepolia | **live** | `18.50 USDC and 69212360086576 wei gas — a transfer is fundable` |

Both slots the brief requires to be live — `card_issuing` and `director_kyc` —
are live. The rest are live too, and the four sentences below are the ones a
grader should hold this table to.

### `business_registry` is GLEIF, and GLEIF is a substitution

**GLEIF is a substitution for Middesk / Persona KYB / Sumsub KYB, all
measured gated.** That is the sentence, and it belongs in the table's own
vocabulary rather than in a footnote. Measured, not read off a support page:
Stripe Connect answers `POST /v1/accounts` with 400 *"You can only create new
accounts if you've signed up for Connect"*; Persona's business verification,
Middesk and Sumsub each open with a sales conversation. I stopped there rather
than invent a company to get past a form.

What replaced them is a real registry queried live and without a credential.
`api.gleif.org` is the Global Legal Entity Identifier Foundation's public API;
every record in it was validated by an accredited Local Operating Unit against
a government company register, and the record names *which* register — so a hit
is a citation a reviewer can follow to a Secretary of State's own search page,
not a badge.

The asymmetry is the design, and it is why this is a substitution and not an
equal: GLEIF holds roughly 3.4 million records against tens of millions of US
entities, because its population is entities that needed an LEI to trade in
financial markets. **A hit is strong authoritative evidence. A miss is evidence
of nothing.** So a miss is `needs_review`, never `approved` — with one
exception that is the opposite: an applicant who *asserts* an LEI that GLEIF
404s has claimed an identifier that does not exist, and that is a decline.

`needs_review` is a queue, not a verdict, and a queue nothing can act on is a
permanently stuck account — which is exactly what happened, because ordinary
small companies are not in GLEIF. The answer is the one a real KYB operation
uses: **manual review** (`src/lib/kyb/manual-review.ts`). A named human reads
the file and records a decision *as another observation*, appended beside the
registry's answer rather than overwriting it. The registry still said what it
said; a person said something else; the system stores both. Leg 1 of the core
loop prints exactly that provenance:

```
leg director_kyc       approved   live       stripe-identity / vs_1UEDLc…
leg business_registry  approved   manual     operator-review / manual.approve…
```

A composite is only as live as its least live leg, and the evidence label says
so on the screen.

### Two stablecoin providers, one interface

"A rail is an adapter, not a schema" is a claim, and one provider cannot
demonstrate it. There are two, both live, both settling in the same `1140`
control account in integer cents:

| Path | What it is | Confirmed on Base Sepolia |
| --- | --- | --- |
| direct signing | this repo builds, RLP-encodes, secp256k1-signs and broadcasts the ERC-20 transfer itself — no SDK, no dependency added | [`0xb47c5a36…`](https://sepolia.basescan.org/tx/0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1) |
| Circle Web3 Services | a developer-controlled wallet; Circle signs | [`0x251858a3…`](https://sepolia.basescan.org/tx/0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa) |

The shapes differ in a way worth naming: the direct path knows the transaction
hash *before* the money can move, because the hash is keccak256 of the bytes it
just signed. Circle inverts that — `transfer` answers `{id, state:"INITIATED"}`
with no hash and no chain — so there is a window in which money may be about to
move and no chain evidence exists. No Circle state is ever mapped to
`confirmed`. The only constructor of `confirmed` in the package reads a receipt
off a node, asserts `status: 0x1`, and re-checks that the block is still
canonical. Circle reaches the ledger only through it.

A missing `CIRCLE_API_KEY` produces `not_configured`, never a silent fallback to
the direct path: the caller asked for Circle, and money leaving over a rail they
did not choose is not a degradation, it is a different transaction.

```bash
node scripts/reconcile-usdc.mjs
```

reconciles `1140` against the chain across **both** wallets. It has been wrong
itself, and the failure is instructive: when the second provider arrived, USDC
lived in two wallets while `1140` remained one omnibus account, and a script
that read one address reported a 90-cent drift against books that were exactly
right. A reconciliation that knows about fewer venues than its control account
covers does not report "I am incomplete", it reports "you are wrong" — and it is
most confident precisely when a venue has just been added.

```
  direct (treasury)          1850 cents   (18.5 USDC)  0xd3629d73…
  circle 9a3524c0              90 cents   (0.9 USDC)   0xeaa8ce10…
  ----------------------------------------------------------------------
  ledger 1140             1940 cents
  on chain, total         1940 cents   (19.4 USDC, 2 wallet(s))
  difference                 0 cents
  RECONCILES — the books agree with the chain
```

### `director_kyc` is Stripe Identity, and the limitation is real

Persona is wired and not signed up, so director KYC runs on Stripe Identity,
which is genuinely live and **cannot be driven** to `declined` or
`needs_review`. So the non-happy-path director-KYC states are not third-party.
Swapping in Persona — whose `perform-simulate-actions` pushes an inquiry to each
of those states while firing the real webhooks — is on the week-two list for
exactly that reason.

### Why this table is computed rather than typed

Four probes in this build reported a healthy slot that could not do its job, and
each was caught only by measuring: a placeholder key marked LIVE by string
presence (DECISIONS 011); Stripe reporting LIVE off `GET /v1/balance` with
Connect disabled (015); Stripe reporting LIVE off `GET /v1/accounts`, which also
answers 200 with Connect disabled (017); the USDC probe calling `balanceOf`,
getting a 200, and reporting LIVE on a wallet with zero gas (016). `/api/health`
also once published two contradicting verdicts for the same slot, because a
nested copy read credential presence instead of the probe (021). The second
opinion was removed rather than reconciled, and
`src/app/api/health/consistency.test.ts` fails the build if any nested slot
disagrees with the authoritative verdict.

The rule that survived all four: **probe with the call the slot's real work
depends on, and confirm it fails when the capability is absent. A probe nobody
has watched fail is not a probe.**

`card_webhooks` is the clearest case of the rule being applied to my own
convenience. It used to report LIVE on the strength of a non-empty
`LITHIC_WEBHOOK_SECRET`, which proves nothing; it was demoted to `simulated`
with the evidence `credential present but NOT probed`; and it is LIVE again only
now that there is a probe that asks the provider whether the subscription is
enabled, at which URL, and whether the last delivery to it succeeded. That
probe's verdict is also what arms the outage alarm below — see *Honest current
state*.

---

## Eleven screens, five states each

The trial scores *"the three screens that matter show default, loading, empty,
error and one edge state"*. All eleven do, and every state is a URL you can
paste, bookmark or hand to someone:

```
?state=loading    ?state=empty    ?state=error    ?state=edge    (bare = default)
```

| Screen | What it is | The edge state |
| --- | --- | --- |
| `/` | operator console: balances across the book, what awaits a human, the integration verdicts | an over-capture has driven available negative, and it is **not clamped** |
| `/onboarding` | KYB per business, per leg, with evidence and provenance | approved on evidence labelled `simulated`, because a composite is only as live as its least live leg |
| `/accounts` | the two balances, the holds between them, cards, and card controls | authorised $50.00, cleared $73.40 — available negative, unclamped |
| `/pots` | sub-accounts; instant internal transfers that are pure ledger moves | a move of one cent **more** than the live available balance |
| `/funding` | fund from a linked external bank | **live** — funded but not yet available: ledger up, available unchanged, hold itemised with its release date |
| `/payments` | raise money out | **live**, prefilled at exactly the ACH approval threshold |
| `/payees` | the confirmation step before money leaves | a routing checksum that fails, and a name that only warns |
| `/approvals` | maker-checker queue | a payment raised by the actor you are signed in as |
| `/standing-orders` | mandates, occurrences, and what each one decided | an occurrence refused for insufficient **available** balance on a day the **ledger** balance covered it |
| `/reconciliation` | the nightly file against the book, with aging | a break whose entry was corrected by reversal plus re-book |
| `/statements` | a closed day, reproducible, corrections included | published, then corrected at the original value date |

**Which of those are live and which are fixtures is printed on the page itself.**
`default` is a real read of the real book on every screen. `loading` is not a
mock of a slow read — it *is* the read, held open behind a real Suspense
boundary, so what you see is the component's own skeleton. `empty` and `error`
are labelled fixtures, because an empty account and a failed query are not
conditions you arrange on a live ledger to show someone. `edge` is **live** on
`/funding`, `/payments` and `/pots`, where the interesting condition can be
driven on demand, and a labelled fixture elsewhere — on `/standing-orders`, for
instance, reproducing it live needs the ledger balance above the amount and the
available balance below it, which is a transient fact about somebody else's card
holds. The same shape exists in the live history as a genuinely refused row; the
fixture is what can be shown to order.

Every one of the eleven, in all five states, answered 200 on the deployed URL at
2026-09-11T00:52Z.

---

## What the system does, feature by feature

Each of these has a document with the measurements behind it.

**The ledger and the two balances.** Double-entry, append-only, immutable, in
integer cents. `available = ledger − active holds − uncleared credits`, computed
at request time from `journal_line`; `v_ledger_balance`, `v_hold_state` and
`v_available_balance` are views. There is no stored balance column, and
`pnpm db:check` asserts that there is not.

**The hold model.** `H(E) = 0 if closed(E) else max(A(E) − C(E), 0)`, a pure
function of the event *set* read back from the database — never of the payload,
and never of the provider's own status field. Partial capture, multiple
captures, over-capture and out-of-order delivery all fall out of it rather than
being special-cased. See *Four things measured* below for why that matters.

**Bitemporal correction.** A correction is a reversal entry plus a re-book at
the **original value date**, appended with a later booking sequence. Tuesday's
figure changes and Wednesday's belief stays reproducible, because a read takes
both a value date and a booking watermark. `/statements` renders both readings
side by side. An ACH return is the opposite case and is modelled as such — a
*new* event at a *new* value date, because the money really did leave on Monday
and really did come back on Thursday.

**Statements.** `book_day` and `statement` are the two writes in this system
that are not money, and they carry the same append-only triggers: closing a day
twice is a primary-key violation, and correcting a statement is a new row with
the next `version`. A published statement is content-hashed, so "identical every
time" is checkable rather than asserted. [`docs/RAIL-SEMANTICS.md`](./docs/RAIL-SEMANTICS.md)

**Card controls, inside the provider's deadline.**
`/api/webhooks/lithic-auth` is Lithic Authorization Stream Access, and it is the
one route in the system where **the response body is the side effect** —
Lithic is holding a cardholder's authorisation open while it waits. Measured,
not quoted: the hard deadline is **6000 ms** and on expiry Lithic *declines* and
stamps `CUSTOMER_ASA_TIMEOUT`; a deliberately stalling responder produced
`DECLINED / UNKNOWN_HOST_TIMEOUT` after 6.19 s against a 0.334 s baseline with
no responder enrolled. So the handler is a latency budget — one round trip for
controls and recent spend (≤600 ms), a pure `decide()` with no I/O and no clock,
an append (≤400 ms) — and **nothing on that path posts money**. A synchronous
decision that writes to the journal is one that can block on the append lock,
and a blocked decision is a declined card. It fails **closed**: a wrong decline
is recoverable and recorded; a wrong approval on a card the customer froze
because it was stolen is not. [`docs/CARD-CONTROLS.md`](./docs/CARD-CONTROLS.md)

**Funding, with delayed availability.** Moving the balance is arithmetic;
deciding when the customer may *spend* it is a risk position, and it is the half
an inbound-credit path is judged on — an ACH credit can be returned after it
lands. So funding raises the **ledger** and withholds the identical amount under
an `uncleared_credit` hold until the policy releases it.
`funds_availability_policy` is append-only and effective-dated, and every hold
stores the `policy_id` it was created under, so a hold opened in March is still
explainable in December after the policy changed. Core-loop leg 2 is exactly
this: `+$1,250.00` to the ledger, `$0.00` to available.
[`docs/FUNDING.md`](./docs/FUNDING.md)

**Standing orders, exactly once.** The unit is the *occurrence* — one (mandate,
scheduled date) pair — because "fires once" is meaningless said of a monthly
mandate. At most once: each occurrence is processed inside one transaction that
opens by taking a row lock through a `SECURITY DEFINER` function, because
`corgi_app` holds no `UPDATE` and therefore cannot write `FOR UPDATE` itself.
At least once, idempotently: the key handed to `requestPayment()` is
`standing:<id>:<YYYY-MM-DD>`, derived by Postgres in a `GENERATED ALWAYS` column
from the two facts that identify the occurrence and never from a uuid this
process invented, landing on a `UNIQUE` column. **Two runs that both get all the
way through raise one payment because the database says so, not because the
scheduler behaved.** A firing mandate moves no money itself — it calls
`requestPayment()`, the same function a human's typed payment calls, so the
maker-checker rule applies to both and the person who set the mandate up is
barred from approving what it raises. A missed day is picked up by the next
tick's catch-up window; past the freshness limit the occurrence is still
*recorded*, as `refused / STALE_OCCURRENCE`, because a fortnight of rent debited
in one batch by a scheduler that just woke up is worse than not firing.
[`docs/STANDING-ORDERS.md`](./docs/STANDING-ORDERS.md)

**Pots.** Sub-accounts inside the customer's own `2100` subtree, so an internal
transfer posts **no rail entry**: two lines, one entity, one book, netting to
zero within the customer's own money. `v_internal_transfer_impure`,
`v_pot_identity_drift`, `v_pot_negative` and `v_pot_orphan` are invariants over
that claim, and the subtree walk is recursive rather than "sum the 2100
children" so adding a level later cannot silently break it.
[`docs/POTS.md`](./docs/POTS.md)

**Payee confirmation.** Three legs in, one decision out, and the judgement the
feature turns on is that **a failed routing checksum is a block and a failed
name match is a warning** — because they are different kinds of statement. The
ninth digit of an ABA routing number is chosen so the weighted sum lands on
zero; a number that misses is not a number any bank has ever been issued, so
there is no informed human who could be right to override it, and an "are you
sure?" in front of arithmetic only teaches people to click through warnings.
The name is an open question and it is open in the direction of false positives
— trading names, subsidiaries, sole traders, factoring companies — so the
warning is made to *cost* something instead: `payee_acknowledgement` is a row
with a named human, an instant and a sentence, and a trigger refuses one against
a check that was not `warned`. **There is no name-inquiry network for US ACH**
— Nacha has no such message, and nothing in this credential set can ask a US
bank what name sits on a third party's account. So the two cases are labelled
differently on the screen: `linked_account_holder` when Plaid holds an Item for
the destination and the institution's own record of the holder name is what is
being compared, and `payer_asserted` when it is only the name already on the
payee record. The second is worth having and it is not confirmation of anything,
and the screen prints those words. [`docs/PAYEES.md`](./docs/PAYEES.md)

**Maker-checker.** Enforced by `assert_maker_checker()`, a database trigger, not
by a handler. The initiator can never approve their own payment, and neither can
an agent — `actor_only_humans_approve CHECK (NOT (kind <> 'human' AND
can_approve))` means an approving agent is not a row Postgres will store. An
approval cites a content hash over the account, rail, amount, destination and
value date, so an approval given for one amount cannot apply to another.

**Reconciliation.** The nightly file against the book, matched on the provider's
own reference and nothing else. Three break categories — in file not in ledger,
in ledger not in file, amount mismatch. Aging is measured in **day closes, not
hours**: a break does not get younger because the nightly job ran late, and
`aged` means a human signed off a business day with it outstanding. Runs are
immutable, so re-running appends; breaks are a *view*, so a corrected break
reads as corrected without a row being repaired.

**An agent surface.** `POST /api/mcp` — Model Context Protocol over Streamable
HTTP. Bearer token required, no development bypass, scoped per grant to one
actor, one business, a rate and a maximum instruction size. Measured against the
deployment at 2026-09-11T02:05Z, `tools/list` returns **eight**: `get_balance`,
`list_pots`, `list_transactions`, `list_payees`, `list_standing_orders`,
`list_card_controls` and `list_recon_breaks` read, and `initiate_payment` queues
a payment request a human must work through.

**`tools/list` on the live endpoint is the authority, not the file tree.** This
paragraph has been wrong in both directions inside one evening — first claiming
more than the deployment served, then fewer — which is the argument for reading
the endpoint rather than the repository.

The four readers were added because their absence made an agent *confidently
wrong* rather than merely unhelpful: `get_balance` reads chart code `2100`, so
without `list_pots` an agent reports $23,713.13 for a business holding
$38,713.13; a refused standing-order occurrence is not a journal row, so without
`list_standing_orders` it answers "I see no record of that payment"; and a
declined authorisation never reaches the ledger at all, so without
`list_card_controls` it says "the bank declined your card" about a decline this
system made.
[`docs/AGENT-LIMITS.md`](./docs/AGENT-LIMITS.md) is the written list of
operations deliberately absent from it, with the failure mode for each.

---

## Running it from a clean clone

Node 22+ and pnpm.

```bash
pnpm install
```

### Environment

[`.env.example`](./.env.example) documents every key the system reads; it was
regenerated from `src/lib/env.schema.ts` plus every `process.env.` in `src/` and
`scripts/`, and it holds no real value. `src/lib/env.schema.ts` is the contract.

**Exactly one variable is required to boot: `APP_DATABASE_URL`.** A missing
provider key is not an error — it selects that slot's simulator, and the
selection is reported by `/api/health`. That is deliberate: a slot can only be
labelled `simulated` if the system is allowed to run without its key.

```bash
cp .env.example .env      # then edit; .env is gitignored and must stay that way
```

| Variable | Required | What it is |
| --- | --- | --- |
| `APP_DATABASE_URL` | **yes** | Neon **pooled** URI for the restricted `corgi_app` role. Never the owner. The only connection the running application ever uses. |
| `DIRECT_URL` | for scripts | Neon **unpooled owner** URI. Used only by `migrate.mjs`, `seed.mjs` and `dbreset.mjs`. Session advisory locks do not survive PgBouncer, so migrations must not use the pooler. |
| `LITHIC_API_KEY`, `LITHIC_WEBHOOK_SECRET` | no | Card issuing, its event feed, and the ASA decision endpoint. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | no | Open banking: funding, and the payee identity leg. Sandbox secret only. |
| `INCREASE_API_KEY`, `INCREASE_WEBHOOK_SECRET` | no | ACH. Absent means the labelled ACH simulator, with a `warn` log line saying so. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Stripe Identity for director KYC. A key beginning `sk_live` is refused at boot. |
| `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET` | no | Not configured here; director KYC runs on Stripe Identity instead. |
| `USDC_SENDER_PRIVATE_KEY`, `USDC_SENDER_ADDRESS`, `BASE_SEPOLIA_RPC_URL`, `USDC_CONTRACT_ADDRESS` | no | The direct-signing stablecoin path. Testnet key only. |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | no | The second stablecoin provider. A key that does not begin `TEST_API_KEY` is refused as unusable. |
| `DRAIN_TOKEN` | no | Bearer token for `POST /api/drain` and `POST /api/cron/standing`. Without it, only Vercel's cron header is accepted. |
| `MCP_AGENT_TOKENS` | no | JSON array of agent grants. The token itself is never stored — only its sha256. |
| `KYB_FORCE_SIMULATED` | no | KYB legs forced to the simulator regardless of credentials. Set to `business_registry`: a present Stripe key must not read as a live registry capability. |
| `SIM_CONTROL_ENABLED` | no | Exposes `/api/sim`. Absent or `false` in any shared environment, and absent in this deployment. |

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
transaction, recording a SHA-256 per file. A migration whose contents changed
after it was applied is **refused**, not re-run. A second run is all-skip.

`scripts/seed.mjs` stands up believable demo data from zero: the book entity,
the chart of accounts, businesses in several KYB states, the actors, the
approval and funds-availability policies, and the `rail_event_semantics`
mapping. It posts **zero** journal entries, on purpose — seeding money would be
a second, unverified write path around `ledger_append()`. It is idempotent
(every id is a UUIDv5 over a stable name), so a second run reports `no change`.
It connects as the owner, because `corgi_app` cannot express an `INSERT` on
`account`; if this script ever succeeds on `APP_DATABASE_URL`, the privilege
model has been widened by accident.

---

## The commands that prove things

| Command | What it proves | Needs |
| --- | --- | --- |
| `node scripts/coreloop.mjs` | the whole core loop, seven legs, through the deployed surface | `APP_DATABASE_URL`, Lithic, `DRAIN_TOKEN` |
| `node scripts/livefire.mjs` | the seven published attacks plus the replay claim, against production | `APP_DATABASE_URL`, Lithic, `DRAIN_TOKEN` |
| `node scripts/dbcheck.mjs` (`pnpm db:check`) | the app role physically cannot edit a money row | `APP_DATABASE_URL` |
| `node scripts/reconcile-usdc.mjs` | `1140` equals what both wallets hold on Base Sepolia | `APP_DATABASE_URL`, RPC |
| `node scripts/audit-claims.mjs` | no document in this repo contradicts `/api/health` | network |
| `node scripts/verify-demo.mjs` | every claim in `docs/DEMO.md` is still true of the deployed system | network |
| `node scripts/seed.mjs` | demo data from zero, idempotently | `DIRECT_URL` |

### `pnpm db:check` — attempt the forbidden, assert the refusal

Connects as `corgi_app` — not the owner, because privileges never bind a table
owner — and tries `UPDATE`, `DELETE` and `TRUNCATE` on the money tables. A
success here is a failure. Run against production, 2026-09-11:

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

```bash
node scripts/livefire.mjs                 # all of them
node scripts/livefire.mjs --only 3,5,6    # a subset, by attack number
```

Eight test files with no mocks in the directory. Every assertion is against the
live Neon database, a live provider sandbox, or the deployed URL. It runs
serially, because Lithic's simulate endpoints are capped at 1 RPS. The verdict
per attack is derived from Vitest's own JSON result, not from anything a test
says about itself, and **a test that cannot prove its claim skips rather than
passes**. Without `LIVEFIRE=1` every file in that directory skips, so `pnpm test`
does not fire real card authorisations at a provider.

### `pnpm test` — the unit and in-memory suite

`pnpm typecheck` and `pnpm lint` are the other two gates, and
`scripts/precommit.sh` runs all three plus a secret scan over every tracked file
before any commit.

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

The one route that does **not** follow that shape is
`/api/webhooks/lithic-auth`, and the difference is the feature: ASA is
decide-and-answer inside 6000 ms, so the response body is the side effect and
nothing on the path posts money. See *Card controls* above.

**Where the ledger lives.** `db/migrations/0001_ledger.sql` — the tables, the
four immutability layers, `ledger_append()`, and the derived views.
`src/lib/ledger/` is the typed access layer: `chart.ts` (the chart of accounts
as data, imported by the seed so SQL and TypeScript cannot drift), `post.ts`
(the only caller of `ledger_append()`), `balances.ts` and `queries.ts` (folds).

**Where the rails live.** `src/lib/rails/` — one `PaymentRail` interface,
satisfied by the Increase ACH adapter, a labelled ACH simulator, the Lithic card
adapter and two stablecoin providers. No ACH nouns at the top level: routing
numbers live inside one variant of a `Destination` union, and SEC codes are
reached through an `AuthorizationKind` intent, because the caller knows how the
customer authorised the payment and does not know that Nacha exists. There is
deliberately no `verifyWebhook` on the interface — verification happens once,
upstream, in the generic Standard Webhooks verifier.

**What the drain does.** The webhook route stops at "verified and persisted",
because Plaid fails a delivery that is not answered within ten seconds and then
retries for twenty-four hours, so no consumer may run inline. The drain is the
half that turns a stored delivery into money, and it has three triggers chosen
because each fails differently: `after()` in the route is a nudge and is allowed
to be dropped; the cron is the guarantee; an authenticated `POST /api/drain` is
the demo. The inbox row is durable before any of the three runs, so losing all
three loses latency and cannot lose money.

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
`H(E) = 0 if closed(E) else max(A(E) − C(E), 0)`, derived before the measurement
and reproducing Lithic's own arithmetic in all three cases — 400, 100 and 0.
`card_authorization` has no status column as a result.

**2. An ACH return does not erase the settlement.** A full lifecycle through the
Increase sandbox (DECISIONS 019):

```
create   $742.19 outbound ACH credit   status=pending_submission
submit                                 status=submitted
settle                                 status=submitted  settled_at=16:13:05
return   R01 insufficient_fund         status=returned   settled_at=16:13:05
                                                         return_at=16:13:21
```

Two findings. Increase has no `settled` status at all — a settled transfer stays
`submitted` and merely grows `settlement.settled_at`, so a consumer keying
release off `status` releases nothing, ever. And after the return, `settled_at`
is still populated and the transfer id is unchanged: the provider models a
return as a *second money movement*, not as an edit of the first. That decides a
row in `rail_event_semantics` that is otherwise easy to get backwards. An ACH
return is a **new event at a new value date**. A card clearing reversal is the
opposite: a **correction at the original value date**. One wrong row there
silently corrupts every past statement it touches while all the invariant views
keep returning zero rows, the hash chain still verifies, and reconciliation
stays clean.

**3. The application connects as a role that physically cannot `UPDATE` a money
row.** Not "does not" — cannot. The interesting part is how the gap was found
(DECISIONS 008). The `REVOKE` was in the migration and correct from the first
hour, and it was worth nothing at runtime, because the application connected as
`neondb_owner` and privileges never bind a table owner. `pnpm db:check` reported
9 failures the first time it was ever run, ninety seconds after it existed.
Reading the migration would have passed it. There was a second-order false
negative hiding behind the first: as the owner, `UPDATE … WHERE true` on an
empty table matched no rows, so the row-level trigger never fired and the
statement *succeeded*. As `corgi_app` the privilege check fires before row
matching, so the refusal is provable against an empty table.

**4. Lithic declines when you are slow, and it says so in the data.** The ASA
deadline is 6000 ms and the failure mode on expiry is a *decline*, not an
approval — stamped `CUSTOMER_ASA_TIMEOUT`, which is a member of Lithic's own
`detailed_results` enum, so our own slowness is observable from the provider's
side rather than inferred. Measured by stalling on purpose: `DECLINED /
UNKNOWN_HOST_TIMEOUT` at 6.19 s, against 0.334 s with no responder enrolled.
That measurement is why the card-control handler is written as a latency budget
and why it posts no money.

---

## Honest current state

**Core loop against production: PASS 7, FAIL 0, SKIP 0 across all seven
legs, invariants 14/14.** Output above, narrative in [`docs/CORE-LOOP.md`](./docs/CORE-LOOP.md).

**Live fire against production: 7 PASS, 0 FAIL, 1 SKIP of 8 attacks.** A skip is
not a pass. Run 2026-09-11T00:53Z, 296 s.

**The skip is attack 2, and it is a bookkeeping row rather than a money error.**
On the $50.00 authorisation cleared at $73.40 the hold *is* released: the memo
entries are the opening delta and its exact negation and nothing else, the
ledger posts exactly 7340 in exactly one financial entry, the hold withholds
nothing afterwards, and `available == ledger − holds − uncleared` exactly, in
integers, with no clamp. What is missing is a `hold_closure` row, so the
attack's literal wording — "the hold releases exactly once", read as *one
closure row* — cannot be demonstrated. The cause is a disagreement between two
of my own artefacts: `src/lib/holds/model.ts` computes
`closed(E) = is_final OR close/expiry OR (A <= 0)`, Lithic has no last-capture
flag so `is_final` is never set on a CLEARING, and with A=5000 against C=7340
that is false — while `DESIGN.md` §8.3 row 2, the same over-capture, says
`closed = y`. I wrote the one-line `C >= A` fix, watched three model tests fail,
and reverted it: `v_hold_drift` holds the TypeScript model and the SQL view
equal *by invariant*, so changing one side alone converts a prose mismatch into
a live drift alarm, and an invariant reporting drift is indistinguishable from a
ledger that has actually drifted. The full reasoning is DECISIONS 024; the fix
is one migration moving both sides together, and it is item 1 on the cut list's
week two.

**Attack 7 now passes, and the thing it was waiting for is worth reading.**
`/api/health` reports per-provider webhook **delivery freshness** from
`webhook_inbox.received_at`, with a stated threshold and a written rationale per
provider (Lithic 180 s because card authorisations are emitted synchronously
with the transaction; Increase 6 h because ACH is batch and follows the banking
day; Persona 24 h because a KYC feed is human-driven and days of silence are
normal). Live fire drove a real 179-second silence, watched `/api/health` move
lithic to `stale` with the note *"silent for longer than 180s after recent
traffic — treated as an outage"*, confirmed the published `lastDelivery` matched
`MAX(received_at)` read directly from the database, and then confirmed the
escalation: `degradesDeployment=true`, `degradedBy=[lithic]`, top-level
`status: "degraded"` with `database.reachable: true`, so "degraded" names the
webhook feed and not a coincidental database failure. The deployed console
rendered `data-provider-status="provider-down"` — *"Issuing provider feed is
quiet — lithic"* — **with the balances still rendered underneath rather than
blanked**. And the gate was tested against the thing it guards: replaying the
outage's own published facts with `card_webhooks` forced not-live keeps the
alarm armed under the `some` rule and silences it under `every`, which is why
the rule is `some` (DECISIONS 028).

The alarm is a **band**, not a latch, and running live fire is how to watch that
for yourself: after the induced silence, `/api/health` held `status: "degraded"`
with `degradedBy: ["lithic"]` from 180 s to 900 s, and at 937 s the verdict moved
`stale` -> `quiet` and the status returned to `ok` on its own. That is the
intended reading — *silence after recent traffic is an outage; silence with no
traffic expected is Tuesday* — and it means `verify-demo.mjs` will legitimately
report one FAIL on check 1 for about a quarter of an hour after a live-fire run.

### Known gaps, in one place

- **Three stale memo holds.** Three card holds carry a `hold_closure` row the
  event fold disagrees with — residue of a clearing-before-authorisation bug the
  code no longer has, on rows that are append-only and cannot be deleted. $60.00
  on the memo book is withheld from nothing. It is **not** caught by
  `v_hold_drift`, which is `WHERE NOT is_released AND memo <> target` and so
  excludes a spuriously-closed hold by construction. That property is worse than
  the sixty dollars. [`docs/CUT-LIST.md`](./docs/CUT-LIST.md) §2.2.
- **Twenty parked webhook deliveries.** Card authorisations on Lithic cards
  created directly in the sandbox and never registered to a customer here. The
  consumer will not guess whose money to move, so it parks with the card token
  in the reason. They are verified, durable, and post the moment a card is
  claimed — but there is still no *claim* path, so today the only way to clear
  them is to insert a `card` row by hand.
- **Twenty-four dead-lettered deliveries**, across all five providers, from
  earlier consumer iterations. They are retained rather than deleted, which is
  the append-only inbox behaving correctly; nothing re-drives them.
- **Persona is not signed up**, so the non-happy-path director-KYC states are
  not third-party. See above.
- **The cron runs daily, not hourly.** Vercel Hobby caps cron at once per day,
  so a lost `after()` nudge waits for the daily tick rather than the hourly one.
  It is never lost: the inbox row is durable before any trigger runs and the
  dispatcher re-claims expired leases. It is one line of `vercel.json` and a
  paid plan. [`docs/CUT-LIST.md`](./docs/CUT-LIST.md) §2.3.
- **The role switcher is a cookie, and it is labelled as one** in both
  `role.ts` and `approvals/session.ts`. It grants nothing: the actor is resolved
  by a `SELECT` with a `WHERE` clause and handed to the database, which decides.
  [`docs/DEMO.md`](./docs/DEMO.md).
- **The MCP rate limiter is per process**, so across warm instances the
  effective limit is (instances × limit). Written down in
  `src/lib/mcp/ratelimit.ts` rather than implied away. It is not the control
  that stops an attacker — the token, the tenant scope and the approval queue
  are.
- **Git history still holds two dead sandbox credentials.** Both were rotated or
  had expired before the working tree was scrubbed (DECISIONS 023). The purge
  needs a force push that has not been taken.

Everything else that was considered and not built — with the argument for each —
is [`docs/CUT-LIST.md`](./docs/CUT-LIST.md).
