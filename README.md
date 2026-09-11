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

**Current reading, 2026-09-11T09:49:20Z → 09:50:44Z, against production:
`PASS 6 · FAIL 1 · SKIP 0` across all seven legs, 84 s, invariants 36/2, on
Ridgeline Robotics, Inc.** Leg 4 fails — *"holds moved $0.00, expected
$50.00"* — because the Lithic sandbox account's daily spend cap is exhausted and
every authorisation declines at every amount; a declined authorisation correctly
places no hold, so the leg reports that it could not be proven rather than
passing on a weaker claim. **The subject also changed from Kettle & Crumb to
Ridgeline Robotics**, because DECISIONS 057 found the run was ranking businesses
by `localeCompare` after reading KYB evidence and never using it — see below.
Run the command and read the current scoreboard there.

The capture below is the **04:03Z run**, kept because it is the shape of the
output and because the leg-by-leg narrative refers to it. It is a record, not
the current state:

```
  THE BUSINESS — every figure below belongs to this one entity
    legal name        Kettle & Crumb Bakery LLC
    business id       1151e7b5-b75b-5f58-bdbf-68cd714178ce

  WHY THIS BUSINESS — the deployed gate was asked, live, before anything else ran
    REFUSED  KYB_PENDING   Holds Integration Fixture Co.   pending/simulated, 0 leg(s)
    ALLOWED  KYB_ALLOWED   Kettle & Crumb Bakery LLC       approved/manual,   2 leg(s)

   1  PASS KYB gate: an unverified business REFUSED with its code, a verified one allowed
   2  PASS Fund from a linked external bank: LEDGER rises, AVAILABLE does not
   3  PASS Issue a real (sandbox) card through /accounts
   4  PASS Authorise $50.00, settle $73.40: hold releases exactly once
   5  PASS Outbound payment needing a second approver, initiator refused by the trigger
   6  PASS Survive a reversed settlement: corrected figure at the original value date
   7  PASS Reconcile the scheme file: a planted break with its kind and its age

  97 HTTP calls to https://corgi-trial-psi.vercel.app    3 to the Lithic sandbox
  invariants  25 passed, 0 failed
  Kettle & Crumb Bakery LLC   opening $498.80 available  ->  closing $425.40 available
```

Seven legs, seven passes, no fails and no skips, in 85 seconds.

**How the run picks its business, and the mistake that changed it.** The 04:03Z
run above picked **Kettle & Crumb Bakery LLC** on the argument that it was
deliberately not the demo favourite: every screenshot in this repo is of
Ridgeline Robotics, Ridgeline is the one business the seed script ever opened
accounts for, and Kettle & Crumb held **zero accounts, zero journal lines and
zero payments** until a KYB approval opened its chart of accounts at request time — the thing migration `0021_open_accounts.sql`
exists to make true, because the brief's loop opens with *"open an account behind
a real KYB check"* and until that migration the check was real and the opening
was a seeding act. The run prints the gate's answer for every business on the
book before leg 1, so you can see the refusal and the allowance side by side
rather than taking the subject on trust.
[`docs/ACCOUNT-OPENING.md`](./docs/ACCOUNT-OPENING.md)

The scoreboard line carrying the run's totals is the one thing elided above —
`scripts/audit-claims.mjs` reads its `SKIP 0 ... of 7` as a claim about the
integration count — so run the command and read it there.

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

> **And it is currently red for a reason that is not this table.** At
> 2026-09-11T09:39Z it exits 1 with seven findings, **none of which is a
> simulated slot presented as live** — there is no simulated slot. Its first
> rule matches any *"N of 7"* in any document and is firing on coreloop's seven
> legs, the rail capability matrix's seven adapters, and one line of the cut
> list quoting the checker's own earlier bug. The fix is one line in that
> script. See *The five compliance failures* below.

Read at 2026-09-11T09:38:36Z, commit `544b481` — re-read at 09:59:12Z on commit
`2c13805`, unchanged. `integrations.live` **7** of `integrations.total` **7**.
Every evidence string below was returned by that reading.

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
are live. The rest are live too, and the sections below are the ones a grader
should hold this table to.

### Every verdict says how old it is

Each slot in the JSON carries `fresh`, `provenAt` and `ageSeconds` beside its
verdict, because "live" and "was live when we last managed to ask" are different
claims and only one of them should be readable as the other.

On six of the seven slots they are the same thing: the probe round-trips on every
load, so `fresh: true` and `ageSeconds: 0`. **`open_banking` is the exception,
and it is rationed on purpose.** Plaid allows ten `/institutions/get` calls per
credential per window and answers the eleventh with
`429 INSTITUTIONS_GET_LIMIT` — measured directly against the sandbox, not read
off a page — and a compliance run reads `/api/health` four or more times by
itself. So the slot round-trips at most once per twenty seconds, and in between
it **quotes its last earned verdict with the age attached rather than re-asking**:

```
POST /institutions/get -> 200                                   fresh=true   age=0
POST /institutions/get -> 200 [quoted, not re-probed: earned 0s ago;
  Plaid allows 10 /institutions/get per credential per window,
  so this slot round-trips at most once per 20s]                fresh=false  age=0
```

Two readings 0.5 s apart, both taken while writing this paragraph. Past five
unbroken minutes of being unable to check, the quote stops: the slot reports
`rate_limited`, that reading is **simulated**, and the evidence says Plaid
rationed it and the credential was never evaluated. This applies to Plaid and
nothing else — applied to `card_issuing` or `card_webhooks` it would put a
five-minute delay between a Lithic outage and the endpoint admitting to it, and
attack 7 is the test that says that delay is unacceptable. The reasoning and the
measurement that produced the flap it fixes are in
[`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) §1.

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

## Every screen, five states each — the fourteen that matter, described

The trial scores *"the three screens that matter show default, loading, empty,
error and one edge state"*. **Every screen does**, and every state is a URL you
can paste, bookmark or hand to someone:

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
| `/payouts` | cross-border: an FX quote the customer accepts before any USDC moves | an expired quote |
| `/approvals` | maker-checker queue | a payment raised by the actor you are signed in as |
| `/standing-orders` | mandates, occurrences, and what each one decided | an occurrence refused for insufficient **available** balance on a day the **ledger** balance covered it |
| `/accruals` | the daily fee accrual, and who eats the residual penny | the day the residual penny lands |
| `/disputes` | a claim against a settled card charge, and the provisional credit between claim and verdict | lost after provisional credit, clawed back |
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

**Re-measured 2026-09-11T10:04Z against the deployed URL by
`node scripts/verify-demo.mjs`: the console now serves 21 screens, and
all 21 answered 200 in all five states — 105 renders, every one 200, and for
every screen the five renders were five distinct documents.** A screen that
ignored the parameter and served its default five times would be caught by that,
and a screen that answered 200 with an empty body would be caught by it too. The
nav carries 20 of them; `/` is the console behind the wordmark.

**The table above describes fourteen, not twenty-one, and that is a gap in this
README rather than in the build.** `/transactions`, `/economics`, `/team`,
`/audit`, `/events`, `/chaos` and `/breaks` are served, navigable and pass the
same five-state check; they have no row here saying what their edge state is.
*(The earlier figure in this section was "all fourteen screens", measured
03:41Z, when fourteen is what the console served.)*

---

## What the system does, feature by feature

Each of these has a document with the measurements behind it.

**The ledger and the two balances.** Double-entry, append-only, immutable, in
integer cents. Available is computed at request time from `journal_line`;
`v_ledger_balance`, `v_hold_state` and `v_available_balance` are views. There is
no stored balance column, and `pnpm db:check` asserts that there is not.

**One definition of available balance — after four were found disagreeing.**
This is the finding the track says it grades hardest (*"whether available balance
is derived truth or a stored lie"*), and it was arrived at from the wrong side:
there were **four** live definitions of available, and two of them printed at the
same instant, on two screens, for the same account, and disagreed by
**$30,662.10**. A balance derived four ways is a stored lie with extra steps —
the number the customer sees still depends on which code path reached them, and
`db:check` stays green throughout because no *stored* number has drifted.

No two of the four shared a ledger term, a hold-release predicate and a set of
hold kinds. One counted every journal line regardless of value date; one excluded
future-dated credits from the ledger term **and subtracted their holds anyway**,
charging the customer for the same dollar twice; one silently dropped `manual`
holds, so an operator hold freed the money it was placed to withhold.

The definition that replaced them:

> **Available is the money you could spend right now without relying on something
> that has not happened yet.**

```
available = ledger − active holds − uncleared credits − committed outflows
```

and the asymmetry in it is the decision, not an oversight. **A future-dated
credit is not available** — nobody can spend a 2027 standing-order settlement in
2026. **A future-dated debit is subtracted anyway** — money already booked to
leave has been committed, and a customer who can spend it again before it settles
is one we have overdrawn on their own behalf. Symmetry in *value date* would be
asymmetry in *risk*, and the risk is whose money it is. The committed-outflow
term is a **derived** hold: the journal entry is already there, so it needs no
`hold` row and cannot double-count against a memo hold, which is the bug class
migration 0011 exists to record.

A view cannot take an argument and this question has three — which business day,
which booking watermark, which instant — so the canonical definition is a
Postgres function, `ledger_availability(account, value_date, booking_seq, as_of)`
(migration 0022), and `v_available_balance` and the TypeScript both call it. They
cannot drift because there is only one of them — and `v_balance_definition_drift`
is the invariant that says so, which migration 0022 declares must be empty and
which nothing was querying until it was added to `pnpm db:check`.
[`docs/BALANCE-DEFINITIONS.md`](./docs/BALANCE-DEFINITIONS.md)

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

**A refusal shows its arithmetic, and a `CHECK` makes it add up.**
`standing_order_outcome` stores the five figures the decision was made on —
ledger, holds, uncleared credits, pending outbound, available — and a constraint
enforces the identity between them, so a refused occurrence cannot record a
reason whose numbers do not subtract. The first real refusal on the live book
reads `$65,754.40 − $411.00 − $16,329.40 − $44,914.00 = $4,100.00`, short by
$100.00. The pending-outbound term is the one that was missing until the four
definitions of available became one; without it that row would have shown a
**$44,914.00 gap** on screen between the balance it cited and the balance it
subtracted from — a refusal the customer could not check, which is the worst kind
of refusal to give.
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

**A rail is an adapter, not a schema — and the contract says which operations
are proven.** `src/lib/rails/contract.ts` names five operations from what the
five adapters actually do: `originate`, `observe`, `settle`, `reverse`, `probe`.
**`probe` is the only universal one**, 5 of 5, and that is the finding rather
than a disappointment: "is this integration live, and is what it produces
evidence of anything" is asked of every slot by the one rule in this trial that
fails a submission outright, and it had five implementations and no interface.

An unsupported operation is **a type, not a throw** — the method is absent, so
calling it is a compile error rather than a `RailError` at 3am — and a supported
one carries its proof: `measured` against the provider, `simulated` against our
own simulator, or `unexercised`. The matrix is generated from the adapters and
`contract.test.ts` fails if it is not in [`docs/RAILS.md`](./docs/RAILS.md)
verbatim, so a rail that gains an operation turns the suite red until the table
is regenerated.

**Read the Increase row.** `probe` is `+`: `GET /accounts?limit=1` answers 200
from this adapter and from the deployed system on every `/api/health` request.
The other four are **`~` — supported, and never run against the provider**. A
read of `/accounts` proves the credential authenticates and the host answers. It
does not prove that `POST /ach_transfers` maps a `TransferRequest` correctly,
that the `submitted + settlement.settled_at -> settled` promotion fires, or that
an R01 arrives shaped the way `research/ach/NOTES.md` guessed — and letting one
earned cell promote its neighbours is liveness by presence wearing a round trip
as a disguise. Two real Increase deliveries have reached the deployed webhook
endpoint and had their signatures verified; both were dead-lettered with "no
consumer registered for provider 'increase'", so `parseEvent` has still never
seen a real delivery. The ACH lifecycle in *Four things measured* below was
driven against the live Increase sandbox and is real; it was **not** driven
through this adapter, and the sandbox transfer carries no `Idempotency-Key`,
which is how we know.

**Disputes, and provisional credit done honestly.** A claim against a card charge
that has already settled, and the money that sits between the claim and the
network's answer. Provisional credit is real money moved on a maybe: it posts to
the ledger on the day it is granted **and is held**, because we may have to take
it back. The clawback when a dispute is lost is a **new event at a new value
date**, not a correction of the credit — we did not grant it in error, we granted
it on an outcome that had not happened yet, and rewriting the grant would delete
the fact that the customer had the money for three weeks. What is live here is
printed on the screen rather than in this file: the card, the authorisation, the
clearing and the settled charge are real Lithic webhooks through the inbox; the
intake, the credit and the evidence workflow are **ours**; and the network's
verdict is operator-driven because `POST /v1/simulate/chargeback` and
`/v1/simulate/dispute` are both **404** in Lithic's sandbox — measured.
[`docs/DISPUTES.md`](./docs/DISPUTES.md)

**Daily accrual, and who eats the residual penny.** A monthly platform fee,
accrued daily across the days of the calendar month it belongs to, debited from
the customer's deposit account and credited to `4200 Fee income` — the one money
movement in this system that no provider tells us about, which is the direct test
of whether an append-only design survives a *computed* entry rather than an
observed one. The brief's rule is the feature: *"pro-rata maths always leaves a
penny, and someone has to eat it deterministically."* A month's price does not
divide into its days, so the screen shows exactly which day carried the leftover
and why the month still sums to the price to the cent — and the rule is a `CHECK`
constraint in migration 0020, not a paragraph. `v_accrual_month_drift` and
`v_accrual_ledger_drift` are invariants over it, both in `pnpm db:check`.
[`docs/ACCRUAL.md`](./docs/ACCRUAL.md)

**The cross-border payout, with an FX quote the customer accepts first.** The
customer agrees a price before anything moves, and the rate they saw is the rate
they get — which means somebody carries the market between those two moments, and
`/payouts` shows who and how much. The mid rate is **live** off
`frankfurter.dev` (ECB daily reference rates, no key, no signup) and the spread
is ours; that split is printed on the screen. **Nothing here touches
`journal_line`.** A quote is a customer-facing commitment about a payout that has
not happened yet, so the only non-USD number in the database is
`fx_quote.buy_minor`, it is a promise rather than a balance, and no view ever
adds it to a dollar — `fx.integration.test.ts` asserts that
`SELECT DISTINCT currency FROM journal_line` returns `['USD']` after the whole
suite has run. Multi-currency is explicitly out of scope and finishing this
feature does not introduce it. What is **not** built is said on the screen and in
§7 of the doc: there is no off-ramp partner, so no peso has ever been delivered;
nothing is hedged; and the Send button does not sign — it runs the gate against
the real database, reports the verdict, and prints the operator CLI that does.
[`docs/FX.md`](./docs/FX.md)

**Opening an account is a consequence of approval.** The brief's loop opens with
*"open an account behind a real KYB check"*, and until migration 0021 the check
was real and the opening was a seeding act: `scripts/seed.mjs` created the
per-customer leaves for the one business a hardcoded fixture said
`opensAccounts: true`, and nothing in `src/lib/**` could open an account at all.
Two of the three demo businesses could not hold money, and passing KYB would not
have changed it, because approval was wired to nothing. Now
`business_accounts_open()` is a `SECURITY DEFINER` function that reads
`v_business_kyb` **itself**, refuses anything but `approved`, and opens the `2100`
deposit leaf and both memo leaves in one function so there is no half-opened
business — because `corgi_app` holding `INSERT` on `account` would mean an
application that can decide where money may land. There is no "open accounts"
button anywhere, and that absence is the design.
[`docs/ACCOUNT-OPENING.md`](./docs/ACCOUNT-OPENING.md)

**An agent surface.** `POST /api/mcp` — Model Context Protocol over Streamable
HTTP. Bearer token required, no development bypass, scoped per grant to one
actor, one business, a rate and a maximum instruction size. Measured against the
deployment at 2026-09-11T03:39Z, `tools/list` returns **eight** — seven read and
one write: `get_balance`,
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
| `KYB_FORCE_SIMULATED` | no | KYB legs forced to the simulator regardless of credentials, and **the only way the registry leg can become simulated**. Leave it unset: `.env.example` shipped it set to `business_registry` from when that leg probed gated Stripe Connect, and a fresh clone copying that file got a simulated registry leg for an integration that is live and needs no credential. It is now commented out, with the reason beside it. |
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
pnpm db:check             # 25 checks, as corgi_app
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
| `node scripts/compliance.mjs` | all 41 rules of the trial, run rather than remembered | `APP_DATABASE_URL`, network |
| `node scripts/verify-demo.mjs` | every claim in `docs/DEMO.md` is still true of the deployed system | network |
| `node scripts/seed.mjs` | demo data from zero, idempotently | `DIRECT_URL` |

### `pnpm db:check` — 38 checks: attempt the forbidden, then assert the invariants

Connects as `corgi_app` — not the owner, because privileges never bind a table
owner — and tries `UPDATE`, `DELETE` and `TRUNCATE` on the money tables. A
success here is a failure.

**Current reading, 2026-09-11T09:40Z: `36 passed, 2 failed`** over **22
invariant views**. Both failures are deliberate and neither is softened — they
are set out under *Honest current state* below. `node scripts/dbcheck.mjs
--prove` additionally makes **every one of those 22 views fail on purpose**, in
a rolled-back transaction: 24 proofs, 8 of them needing a trigger disabled on
the owner connection, coverage computed from the same array the gate walks.

The capture below is an **older run, kept because it is the output a reader
wants to see the shape of** — production, 2026-09-11T04:02Z, when the gate held
11 invariant views rather than 22:

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

INVARIANT VIEWS — each MUST return zero rows

  PASS  v_entry_unbalanced is empty — every entry sums to zero, per currency
  PASS  v_line_denorm_drift is empty — denormalised clocks match their entry
  PASS  v_hold_drift is empty — the memo book equals the fold over card events
  PASS  v_hold_release_drift is empty — a released hold withholds nothing
  PASS  v_book_not_zero is empty — the whole book nets to zero, per entity and book
  PASS  v_deposit_control_drift is empty — the deposits subtree equals what we report
  PASS  v_accrual_month_drift is empty — a month's daily shares sum to the fee exactly
  PASS  v_accrual_ledger_drift is empty — every accrual claim matches the entry it cites
  PASS  v_standing_order_double_fire is empty — one occurrence, at most one payment instruction
  PASS  v_dispute_ledger_double_count is empty — one dispute line, one row
  PASS  v_balance_definition_drift is empty — the hold model and availability agree, at the live point

  25 passed, 0 failed
```

**The second block is the half that was missing, and it is the more interesting
half.** Those views existed and were queried by hand and by individual test
files; nothing ran them on the way to a commit, which meant the check most likely
to catch a ledger going wrong was the one nobody was running. `v_balance_
definition_drift` is the sharpest case: migration 0022 *declares* that it must be
empty, and until today nothing asked it.

**And two of them were empty for the wrong reason**, which is the finding worth
carrying into a debrief rather than the count:

- `v_standing_order_double_fire` joined `payment_instruction` on
  `idempotency_key` — a **UNIQUE** column — and then asked whether more than one
  distinct instruction matched. At most one row can match a unique value, so the
  `HAVING` was unsatisfiable: the view was `WHERE false` with extra steps. Its
  body now joins on the mandate's *keyspace* and attributes an instruction to an
  occurrence by the derived key **or** the scheduled date, which catches the
  double fire a unique index structurally cannot see — a second instruction for
  the same mandate and date under a different *spelling* of the key. Proven by
  planting an unpadded, `DateStyle`-dependent key on a real occurrence: the new
  body returns one row listing both spellings, the old body returned nothing.
- `v_hold_drift` is `WHERE NOT is_released AND memo <> target`, which excludes a
  spuriously-closed hold **by construction**, so it cannot see the exact failure
  it exists to catch. That one is still open and is item 2 on week two.

**A zero-row invariant proves nothing until somebody has watched it return a
row.** Both of those had been quoted as evidence, in this repo, in writing.

### `node scripts/compliance.mjs` — the trial's own rules, run rather than remembered

41 checks: the six automatic fails, the ten non-negotiables, the ten items of the
Track 3 domain gauntlet, the seven live-fire scenarios and the eight items of the
submission package, each read out of `docs/TRIAL-VERBATIM.md` and `docs/BRIEF.md`
and asserted against this repo and its deployment.

Three rules it is written under, and the third is the one that makes it worth
running: **a verdict is derived, never asserted** — a check that made no
assertion at all reports UNKNOWN, and there is deliberately no code path from
"nothing went wrong" to PASS; **a check that cannot be performed reports UNKNOWN
with the reason**, never PASS, because a compliance tool that guesses converts an
unexamined risk into a green line; and **a claim already proven end to end by
`coreloop.mjs` or `livefire.mjs` is CITED rather than re-run**, and CITED is
never counted as a pass. Every HTTP call is a GET except an unsigned POST to each
webhook route — refused at signature verification before anything is stored,
which is the evidence — and every SQL statement is a SELECT except the
deliberately-forbidden UPDATE whose refusal is the point.

Its current output is in *Honest current state* below, including the two rules it
fails.

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

**It writes to production, and attack 7 takes the issuing feed dark for three
minutes on purpose**, so `/api/health` reports `degraded` for the fifteen minutes
after a run and `verify-demo.mjs` check 1 fails for the same fifteen minutes.
That is the alarm working. The current result — 5 PASS, 2 FAIL, 1 SKIP of 8 —
and the diagnosis of each failure are in *Honest current state* below.

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

**2. An ACH return does not erase the settlement.** A full lifecycle driven
against the live Increase sandbox (DECISIONS 019) — by hand, not through the
adapter, which is why the adapter's `originate`/`observe`/`settle`/`reverse`
cells stay `~` on the capability matrix:

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

**Re-measured against production between 09:38Z and 10:05Z on 2026-09-11**, by
running each command rather than by remembering what it last said. Where a
number here disagrees with what those commands print today, they are right.
Every figure that moved since the previous reading is shown with the old one
beside it, because a figure that quietly improves is as hard to trust as one
that quietly rots.

> **The deployed origin moved during this reading.** `/api/health` reported
> commit `544b481` at 09:38:36Z and `2c13805` at 09:59:12Z.

**Core loop: PASS 6, FAIL 1, SKIP 0 across all seven legs, invariants 36/2**, in
84 s, on **Ridgeline Robotics, Inc.** *(was: 7/0/0 on Kettle & Crumb Bakery
LLC.)* Two things changed and both are worth saying out loud:

- **Leg 4 now fails** — *"holds moved $0.00, expected $50.00"*. The Lithic
  sandbox account's daily spend cap is exhausted, so every authorisation
  declines at every amount, and a declined authorisation correctly places no
  hold. The leg is honest about not being provable rather than passing on a
  weaker claim.
- **The subject changed**, because DECISIONS 057 found the run was picking its
  business by `localeCompare` after reading KYB evidence and never using it —
  which had chosen a business approved by the *simulator* to demonstrate leg 1's
  *"real KYB check"*. Evidence tier is now a ranking term ahead of the alphabet,
  and Ridgeline's director leg is live on Stripe Identity.

Narrative in [`docs/CORE-LOOP.md`](./docs/CORE-LOOP.md).

**`pnpm db:check`: 36 passed, 2 failed** over 22 invariant views *(was: 25
passed, 0 failed over 11)*. **Both failures are deliberate standing reds, both
would go green with one `WHERE` clause, and both `WHERE` clauses would be
shaped like the failure they hide:**

- **`v_refused_auth_hold` — 154 rows**, 130 holds, **$9,786.20 withheld**, every
  one `verdict = 'unanswered'`: an authorisation is holding a customer's money
  and no verdict from the network was ever recorded for it. These are pre-0026
  fixture events whose payloads were not retained, so the verdict cannot be
  recovered and **will not be invented**. Migration 0032 declined to exclude
  them: *"the exclusion would be safe, and would still be an exclusion shaped
  like the failure."*
- **`v_hold_expiry_drift` — 9 rows**, all released, **zero cents of exposure**.
  A card hold's expiry is stored twice — `hold.expires_at`, which
  `ledger_availability()` reads, and `card_authorization.expires_at`, which
  `v_card_auth_hold` reads. Nine fixtures bypassed `ensureAuthorization()` and
  took two separate `now()` readings 135–158 ms apart. No money is at risk; what
  is at risk is that for the width of that gap two bodies would answer *"has
  this hold expired?"* differently and nothing would say so.

**`compliance.mjs` AF3 spawns `dbcheck` and asserts exit 0, so AF3 reports these
as a violation, correctly, and will until they are genuinely closed.**

> **LATER READING, 2026-09-11T10:07Z — and it moved again while this sweep was
> being written.** `node scripts/dbcheck.mjs` now reports **36 passed, 4
> failed**. `scripts/dbcheck.mjs` was rewritten at 10:06Z and migrations `0042`
> and `0043` landed, both by other workers, and **two new invariant views
> arrived already red**: `v_advice_delta_unsound` (**1 row** — *"an advice is
> never converted against a base an authorised amount cannot take"*) and
> `v_hold_closure_unexplained` (**4 rows** — *"no unreversed closure stands over
> an open authorisation the provider's verdicts do not explain"*). The two
> deliberate reds described here are unchanged at 154 and 9 rows. **Neither new
> failure has been diagnosed by this worker and neither is claimed to be
> deliberate** — they are reported because the number is 4 and saying 2 would be
> the exact habit this sweep exists to break. Run the command; do not quote
> either figure without doing so.


**`node scripts/dbcheck.mjs --prove`: 22 of 22 invariant views, 24 proofs**, 8
of them needing a trigger disabled on the owner connection because `corgi_app`
cannot disable one at all — which is layer 1 holding, not a limitation being
routed around. **No view turned out to be structurally incapable of returning a
row.** The sharpest result is `v_member_approval_without_right`, which needs
**two** triggers switched off — `payment_instruction_event_maker_checker` and
`payment_instruction_event_team` — and that is the finding rather than the
workaround: 0001's maker-checker and 0033's team check **compose rather than
overlap**, so the state that view reports is unreachable through the product.

**`/api/health`: 7 live of 7**, both must-be-live slots among them. Top-level
`status` reads **`ok` at rest** and **`degraded` for 180–900 s after a live-fire
run** — the Lithic feed's `stale` band, *"silent for longer than 180s after
recent traffic — treated as an outage"*. Measured `ok` at 09:38:36Z and
`degraded` at 09:59:12Z, ten minutes after live fire. The dead-letter backlog no
longer degrades it at all (`webhookProcessing.degradedBy: []`).

**`tools/list` on the deployed MCP endpoint: 8 tools**, seven read and one
write.

**All 21 screens answered 200 in all five states** — 105 renders, every one
200, five distinct documents per screen, measured 10:04Z *(was: fourteen
screens, 04:05Z)*. The nav serves 20 routes and `/` links to all of them.

**`node scripts/compliance.mjs`: PASS 25, FAIL 5, UNKNOWN 4, CITED 7, of 41
checks**, in 22 s *(was: PASS 28, FAIL 2)*. CITED is not a pass and UNKNOWN is
not a pass. The four UNKNOWNs are honest ones — whether the author can explain a
line under questioning is not mechanisable and the tool refuses to fake a check
for it; and the GitHub invitations, the video link and the evidence-pack sharing
are account state outside this repo. **The five FAILs are below and three of
them are guards tripping on something other than what they guard.**

**Live fire: PASS 7, FAIL 0, SKIP 1 of 8 attacks**, 334 s *(was: 5 PASS / 2 FAIL
/ 1 SKIP)*. Attacks 3 and 7 both now pass every assertion. **A skip is still not
a pass**, and this run's skip is worse than the last one's, for a reason given
below.

### The five compliance failures

**AF5 — "Secrets committed to the repo", read against git history rather than
the tip.** **Four file/shape pairs** are alive in history across 97 commits
*(was three; the Plaid-shaped token left the list and two `whsec_`-shaped
strings in `src/lib/chaos/` joined it)*. The credentials were rotated or had
already expired before the working tree was scrubbed (DECISIONS 023). The
purge needs a `filter-branch` and a force push, which is destructive and
irreversible and has not been taken. The check is right to fail; the working tree
is clean and the credentials are dead. The same run also asserts that **no
current `.env` secret value appears in any commit** (17 values pickaxed with
`git log -S`).

**AF3 — "UPDATE or DELETE on money rows."** It spawns `dbcheck` and asserts exit
0. `dbcheck` is 36/2 and both failures are the deliberate reds above, so this is
red for a reason that is written down and not repaired away. Its own direct
assertion passes: **no `UPDATE`/`DELETE`/`TRUNCATE` against any of the 35 money
tables in 835 code files**, with 15 occurrences that are statements written to be
refused, counted as proof rather than breach.

**AF2 — "A simulated integration presented as live."** Its three own assertions
all pass: seven slots enumerated with per-slot evidence, every slot reading
`live` carrying an HTTP status or an on-chain fact rather than a present key,
and the verdict reproducible across three readings seconds apart. It fails
**only** on its delegation to `scripts/audit-claims.mjs`, which exits 1 with
seven findings — and **not one of them is a simulated slot presented as live.**
That checker matches any *"N of 7"* in any document and fires on three unrelated
populations of seven: coreloop's seven legs, the rail capability matrix's seven
adapters, and one line of the cut list **quoting the checker's own earlier bug**.
`/api/health` has no simulated slot for its second rule to catch. This is the
document auditor's blind spot recurring: it was taught a second *spelling* of the
claim and never taught what the denominator means. The fix is one line in that
script — require the word `live` beside the number, or scope the rule to lines
naming a slot.

**AF1 — "Localhost only, or a video in place of a URL."** The deployed origin is
public HTTPS and all 11 console screens answer 200 from it. The check trips on
one line of `docs/EVENTS.md` that **lists `localhost` among the blocked SSRF
hosts**. A string match on a line about refusing localhost, not a localhost
deployment.

**G1 — a stored balance column, and two of this repo's own gates disagree about
it.** `compliance.mjs` fails on `interest_posting.basis_balance_cents`;
`dbcheck` passes it as one of three named exceptions and **re-derives every
stored basis from the journal at its recorded watermark, row by row**. `dbcheck`
does the harder check. **The disagreement is not resolved**, and it should be
before anyone has to explain it in a room.

**NN9 — "Money is never a float".** Three lines of
`src/components/disputes/DisputeForms.tsx` — 164, 182 and 453 — divide cents by
100 and call `.toFixed(2)`. `src/lib/format/money.ts` exists to make exactly that
impossible and its header says so in the first paragraph: *"there is no `/ 100`,
no `toFixed`"*. No money is computed from these three — two render an `<option>`
label and one fills a form default that is re-parsed into cents on the server —
so nothing in the ledger is wrong. **It is still a false claim in this
README's own terms until it is fixed**, which is why it is here and not in a
footnote. The fix is `formatCents()` and it is minutes.

### The live-fire skip, and the two live-fire failures that have since closed

**Re-run 2026-09-11T09:43:31Z → 09:49:05Z: PASS 7 · FAIL 0 · SKIP 1, 334 s.**
Attacks 3 and 7 both now pass every assertion — 3/3 each. The two failures
described below are genuinely closed rather than re-labelled, and **the accounts
of them are kept**, because what each one turned out to be is the useful part
and because this README quoted "7 PASS / 0 FAIL" for hours while it was 5/2/1.

**The skip is still attack 2, and this run's version of it is worse than the
one described below.** It reported *"1 passed, 2 skipped — the attack is NOT
proven · waiting on: (no reason recorded — investigate)"*. A skip that cannot
name what it is waiting on is a worse artefact than one that can, and it is
reported here as such rather than rounded to "still skipping". The underlying
cause is unchanged and is measured elsewhere: **the Lithic sandbox account's
daily spend cap is exhausted**, so every authorisation declines at every amount
and the $50-auth/$73.40-capture sequence cannot be driven at all — which is also
why coreloop leg 4 fails.

**What the skip meant when the cap was not in the way, and it is a bookkeeping
row rather than a money error.**
On the $50.00 authorisation cleared at $73.40 the hold *is* released: the memo
entries are the opening delta and its exact negation and nothing else, the ledger
posts exactly 7340 in exactly one financial entry, the hold withholds nothing
afterwards, and `available == ledger − holds − uncleared` exactly, in integers,
with no clamp — and it is reported **negative** rather than floored at zero. What
is missing is a `hold_closure` row, so the attack's literal wording — "the hold
releases exactly once", read as *one closure row* — cannot be demonstrated. The
cause is a disagreement between two of my own artefacts:
`src/lib/holds/model.ts` computes `closed(E) = is_final OR close/expiry OR
(A <= 0)`, Lithic has no last-capture flag so `is_final` is never set on a
CLEARING, and with A=5000 against C=7340 that is false — while `DESIGN.md` §8.3
row 2, the same over-capture, says `closed = y`. I wrote the one-line `C >= A`
fix, watched three model tests fail, and reverted it: `v_hold_drift` holds the
TypeScript model and the SQL view equal *by invariant*, so changing one side
alone converts a prose mismatch into a live drift alarm, and an invariant
reporting drift is indistinguishable from a ledger that has actually drifted. The
full reasoning is DECISIONS 024; the fix is one migration moving both sides
together, and it is item 1 on the cut list's week two.

**Attack 3 *used to fail* on one of three assertions, and the failing one was
not the attack's claim. It passes 3/3 as at 09:49Z; this is the account of it.** *"the correction grew a line on the day we learned: expected 9
to be +0"* — reproduced exactly, twice, forty minutes apart, both times at 9, so
it is systematic and not a race. The claim the attack exists to prove is that a
correction posts at the **original** value date and does **not** also post at its
own; that is asserted separately by idempotency key and **it passes**, as does
every positive half — the reversal carries settlement day's value date, reverses
the clearing, joins its correction group, has a later `booking_seq`, and
settlement day's statement moves by exactly −$73.40 with exactly one more line.
What fails is the *additional* assertion that the learning day's statement has
zero lines at all. That day now carries nine, and they are Plaid funding credits
and released payments booked by the funding and payments screens — ordinary
business the test is reading as a stray correction. The assertion needs scoping
to the correction's own entries; that is a test change, it is deliberately not
made here, and [`docs/CUT-LIST.md`](./docs/CUT-LIST.md) §3.7 carries the query
that shows the nine rows.

**Attack 7 *used to fail* on its position-freeze cross-check while passing the
two assertions the attack is named for. It passes 3/3 as at 09:49Z; this is the
account of it, and the guard defect it exposed is real whether or not the run is
green.** The outage is visible and it escalates:
`/api/health` moved lithic to `stale` at 183 s inside its own 180–900 s band,
with `degradesDeployment=true`, `degradedBy=["lithic"]`, top-level
`status: "degraded"` and `database.reachable: true` — so "degraded" names the
webhook feed rather than a coincidental database failure — and the deployed
console rendered `data-provider-status="provider-down"`, *"Issuing provider feed
is quiet — lithic"*, **with the balances still rendered underneath rather than
blanked**. The gate was then tested against the thing it guards: replaying the
outage's own published facts with `card_webhooks` forced not-live keeps the alarm
armed under the `some` rule and silences it under `every`, which is why the rule
is `some` (DECISIONS 028). The third assertion compares the business's whole
position before and after and expected available $50.00 lower; it came back
equal. **Re-running attack 7 on its own passes 3/3** — which is what identifies
the fault, because the difference between the two runs is not the code:

The whole-position check is guarded. The test only asserts it when the window was
quiet, and it decides quiet with
`SELECT count(*) FROM journal_entry WHERE booking_time >= <window opened> AND
book = 'financial'`. **The guard is scoped to the financial book, and the
quantity it guards is moved by the memo book.** A hold opening or releasing is a
memo posting, so an in-flight hold from an earlier attack in the same run lands
inside the window, moves available, and is invisible to the guard — and in a full
run there are five earlier attacks that place and release card holds on the same
business. In the isolated run the guard fired for an unrelated reason (a foreign
*financial* write), the check was reported rather than asserted, and the reported
figure was exactly right: available `54880 -> 49880`, ledger unchanged.

The narrower per-hold assertions carry the money claim in both runs and hold in
both: exactly one memo entry for the recovered hold, of exactly −5000 cents —
withheld once, not twice — zero financial entries against the swallowed token,
and exactly one `card_auth_event` for two deliveries. **The fault is in the
guard's scope, not in the hold**, and the fix is one word: count memo postings
against the business too, or drop the cross-check and keep the per-hold
assertions that are strictly stronger than it.
[`docs/CUT-LIST.md`](./docs/CUT-LIST.md) §3.7.

**The alarm is a band, not a latch**, and running live fire is how to watch that
for yourself: after an induced silence, `/api/health` holds `status: "degraded"`
with `degradedBy: ["lithic"]` from 180 s to 900 s, and past 900 s the verdict
moves `stale` -> `quiet` and the status returns to `ok` on its own. That is the
intended reading — *silence after recent traffic is an outage; silence with no
traffic expected is Tuesday* — and it means `scripts/verify-demo.mjs` will
legitimately report one FAIL on check 1 for about a quarter of an hour after a
live-fire run.

### `node scripts/verify-demo.mjs`: 17 PASS, 1 FAIL, 1 SKIP of 19, exit 1

**Re-run 2026-09-11, finished 10:04:31Z** *(was 11 PASS / 2 FAIL / 1 SKIP of 14
at 04:02:56Z)*. The script grew from 14 checks to 19 and the two parser failures
described below are gone.

**The one FAIL is check 1 — `/api/health` `status` is `"degraded"`, expected
`"ok"` — and it is this README's own documented behaviour rather than a
defect.** Live fire had run 15 minutes earlier, Lithic had been silent 538 s,
and the 180–900 s band treats silence after recent traffic as an outage. Past
900 s the endpoint returns to `ok` on its own. **A check that goes red for a
correct reason is still red**, and the honest reading is that `verify-demo` and
the health band disagree about whether a just-attacked system should be called
healthy — not that either is wrong.

**The one SKIP is check 12**, which says so plainly: *"the database-level refusal
is not asserted by THIS script"*. Live-fire attack 5 and coreloop leg 5 both
assert it against SQLSTATE 42501 from `assert_maker_checker()`. A skip is not a
pass, and this one names the command that does prove it.

**What the two old FAILs were, kept because the reasoning is the useful part.**
Two of the fourteen checks parsed the account screen's availability table by
taking the **first four** money figures out of it, and that table gained a fifth
row — **Committed outflows** — when the four disagreeing definitions of available
balance were reduced to one. So the parser read the committed-outflows figure as
the available balance and reported a mismatch against a screen whose arithmetic
was exact. The fix was to read the last figure rather than the fourth. It was
never *"adjust the checker until it agrees"*: the screen was right throughout and
the parser was reading the wrong row.

### Known gaps, in one place

- **Stale memo holds — now counted rather than estimated.** A card hold can
  carry a `hold_closure` row the event fold disagrees with, on rows that are
  append-only and cannot be deleted. This bullet used to say *"three holds,
  $60.00"*; migration 0040 added `v_hold_closure_census`, which measures it, and
  at 2026-09-11T09:52Z it reports **56 closures of that shape — $2,683.00**: 52
  written by `repair` (0026 and 0032 closing holds the fold calls open **on
  purpose**, because the fold's input had lost the network's refusal) and 4 by
  `test_harness` ($132.00). **The shape is still outside `v_hold_drift`**, which
  is `WHERE NOT is_released AND memo <> target` and so excludes a
  spuriously-closed hold by construction, and that property is worse than any of
  the dollar figures. [`docs/CUT-LIST.md`](./docs/CUT-LIST.md) §2.2.
- **146 parked webhook deliveries**, measured 2026-09-11T09:47Z *(was 35 at
  04:05Z)*: **27 Lithic and 119 Increase**. The Lithic rows are card
  authorisations on cards created directly in the sandbox and never registered
  to a customer here — the consumer will not guess whose money to move, so it
  parks with the card token in the reason. The Increase rows are wire
  deliveries and one $10,000.00 inbound ACH credit parked *on purpose*: the
  object names the programme's single shared FBO account number, so the field
  that should say whose money it is names the programme. They are verified,
  durable, and post the moment the referent is claimed — but there is still no
  *claim* path for an orphan card token, so the only way to clear those is to
  insert a `card` row by hand, and the count grows every time live fire runs.
- **26 dead-lettered deliveries, all of them Lithic**, measured 09:47Z *(was 28
  across all providers)*. Every one is *"parked 12 times waiting for
  `card:<token>`; referent never arrived"*. They are retained rather than
  deleted, which is the append-only inbox behaving correctly.
  `/api/health` reports them `supersededByConsumption: true`,
  `degradesDeployment: false` — *"history, not a live drop"* — and names the fix
  nobody has run: `clearedBy: "node scripts/redrive.mjs --apply"`.
- **Increase's dead letters are now zero** *(they were 167, all reading "no
  consumer registered for provider 'increase'")*. The consumer is registered and
  the backlog was redriven: 124 `done`, 119 `parked`, **0 dead**, and not one of
  the 243 rows carries a `dead_lettered_at` at all. **No row anywhere in
  `webhook_inbox` still carries that string.**
- **Persona is not signed up**, so the non-happy-path director-KYC states are
  not third-party. See above.
- **The cron runs daily, not hourly.** Vercel Hobby caps cron at once per day,
  so a lost `after()` nudge waits for the daily tick rather than the hourly one.
  It is never lost: the inbox row is durable before any trigger runs and the
  dispatcher re-claims expired leases. It is one line of `vercel.json` and a
  paid plan. [`docs/CUT-LIST.md`](./docs/CUT-LIST.md) §2.3.
- **Three lines of the disputes UI divide money by 100.** See NN9 above. Display
  only, nothing computed from it, and still a contradiction of this README until
  it calls `formatCents()`.
- **The Increase adapter's four money operations have now run, and R02–R29 have
  not.** All five cells — `originate`, `observe`, `settle`, `reverse`, `probe` —
  read `proof: 'measured'`, earned on
  `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`, **$6,000.00**, carrying an
  `Idempotency-Key` only this repo's `createAchTransfer` sends. *(The evidence
  string this bullet used to rest on described a **different** transfer —
  `…s2iljuavdzp2p68rh7v7`, key null — which is exactly the evidence that it did
  not come from here.)* **The gap moved one level down and is not closed: R01
  `insufficient_fund` is measured end to end; R02–R29 are table-driven and
  unexercised.** One earned return code does not promote its neighbours.
- **No off-ramp partner on the cross-border payout.** The USDC leg confirms on
  Base Sepolia; nobody hands the beneficiary pesos, so every delivery amount is a
  commitment and the screen says so. Nothing is hedged, and the Send button runs
  the gate and prints the operator CLI rather than signing.
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
