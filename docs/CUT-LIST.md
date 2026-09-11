# What I did not build, what changed, and what week two is

Four sections. The first is the cut list as I published it at T+2h and what
actually happened to each line — **six of the eight were built**. The second is
the stretch ladder, where **all six rungs are built** and three of them carry a
gap that is named rather than hidden. The third is the things this build
finished *deliberately incomplete*: discovered while building, left standing,
and worth more said out loud than buried. The fourth is week two in value order,
and the top of it changed — the three features that used to lead it exist, and
what replaced them is the two places this system disagrees with itself.

A cut list with no argument is a to-do list, so every line keeps its reasoning.
Nothing here is a surprise to `DECISIONS.md`; the entry number is given where one
exists.

**Every figure below was measured against production between 03:35 and 04:05 on
2026-09-11**, by running the thing rather than reading about it:
`node scripts/coreloop.mjs` (7 pass, 0 fail, 0 skip of 7 legs, invariants 25/25),
`node scripts/livefire.mjs` (5 pass, 2 fail, 1 skip of 8 attacks),
`node scripts/compliance.mjs` (28 pass, 2 fail, 4 unknown, 7 cited of 41),
`pnpm db:check` (25/25), `POST /api/mcp tools/list` (8), `/api/health`
(7 live of 7), and one pass over all fourteen screens in all five states. Where a
number here disagrees with what those commands say today, they are right.

---

## 1. Cut list v0, and what changed

The T+2h email (`thread/T+2h_attack_plan.md`) said this:

> **Not building:** the mobile app (responsive web instead), standing orders,
> the public API, sub-accounts and pots, disputes with provisional credit,
> wires, interest and fee accrual, card controls in the real-time auth decision
> webhook.
>
> **Week two, in order:** card controls inside the provider's auth timeout,
> since that is the only one that has to be real-time and therefore the only one
> whose design I would want to prove early; then standing orders with
> exactly-once firing across restarts; then disputes.
>
> If the core is standing early I will take card controls off this list rather
> than adding polish.

| Cut at T+2h | Status now | What actually happened |
| --- | --- | --- |
| Mobile app | **still cut** | Responsive web console, as planned — but **fourteen** screens rather than the three that were promised, each with five URL-driven states, all measured answering 200 with five distinct renders on 2026-09-11. Nothing is "in the nav as disabled text" any more; that placeholder is gone because the screens behind it exist. |
| Standing orders | **built** | `/standing-orders`, migration 0012, `src/lib/standing/`. Exactly-once at the occurrence level, enforced by a `GENERATED ALWAYS` idempotency key on a `UNIQUE` column rather than by scheduler discipline. `v_standing_order_double_fire` is empty. See §2 and [`STANDING-ORDERS.md`](./STANDING-ORDERS.md). |
| Public API | **replaced, and still no REST** | An **MCP surface** shipped instead — `POST /api/mcp`. `tools/list` on the deployed endpoint answered with **eight** at 2026-09-11T03:39Z: seven read and one that queues a payment request a human must work through. That was not on the v0 plan at all. The operations deliberately absent from it, with the failure mode for each, are [`AGENT-LIMITS.md`](./AGENT-LIMITS.md). A public REST API is still cut, and it is a week-two item rather than a permanent one. |
| Sub-accounts and pots | **built** | `/pots`, migration 0015, `src/lib/pots/`. Instant internal transfers that are pure ledger moves — two lines inside the customer's own `2100` subtree, no rail entry, no asset account touched. Four invariant views hold that claim: `v_internal_transfer_impure`, `v_pot_identity_drift`, `v_pot_negative`, `v_pot_orphan`, all empty. The subtree walk stayed recursive, which is what made adding the level cheap. |
| Disputes with provisional credit | **built** | `/disputes`, migration 0019, `src/lib/disputes/`. 16 rows in `dispute` at 2026-09-11T04:05Z. The judgement it turns on is in §2. |
| Wires | **still cut, policy still there** | No wire rail. `approval_policy` still seeds a `wire` row at threshold $0 with `required_approvals = 2`, because two *distinct* approvers is what makes the maker-checker rules demonstrable at all, and the seed opens two approver actors for exactly that reason. The policy exists; the rail does not, and a payment cannot be raised on it. |
| Interest and fee accrual | **built** | `/accruals`, migration 0020, `src/lib/accrual/`. `4200 Fee income` is no longer an empty row in the chart of accounts. The residual-penny rule is a `CHECK` constraint, and two invariant views over it are now in `pnpm db:check`. See §2 and [`ACCRUAL.md`](./ACCRUAL.md). |
| Card controls in the real-time auth webhook | **built** | `/api/webhooks/lithic-auth`, migration 0014, `src/lib/cards/`. Decided inside Lithic's measured 6000 ms ASA deadline. See §2 and [`CARD-CONTROLS.md`](./CARD-CONTROLS.md). |

**Six of the eight moved, and only three of those were the three the T+2h email
named for week two.** That is worth saying plainly rather than presenting it as
a plan executed: the v0 list was a decent set of bets, and the ordering it
proposed was wrong twice. Card controls came *off* the week-two list because live fire
found a gap that did not exist as a concept when the list was written — nothing
reported webhook delivery freshness, so an issuing-provider outage was invisible
to the one endpoint whose job is to be believed — and an outage you cannot see is
worth more than a control you have not shipped. Then the freshness work landed
and card controls came back, because a real `card_webhooks` probe is what arms
the alarm and the ASA endpoint is what made that probe worth writing. A cut list
is a record of judgement under time pressure, and the judgement being recorded
here includes the two calls that changed.

---

## 2. The stretch ladder, item by item

The brief's stretch ladder has six rungs. **All six are built.** That sentence
is the reason this section is the longest one here: a ladder with nothing left on
it is the easiest place in a submission to over-claim, so every rung below says
what is real, and three of them say at length what is not.

**Card controls in the real-time auth decision webhook — built.** This is the
one that moved twice, and both moves are worth the sentence. It came *off* the
week-two list because live fire found a gap that did not exist as a concept at
T+2h: `/api/health` reported nothing about webhook delivery freshness, so an
issuing-provider outage was invisible to the one endpoint whose job is to be
believed. An outage you cannot see is worth more than a control you have not
shipped. Then the freshness work landed, and card controls came *back* — and
they turned out to share a dependency with it, because a real
`card_webhooks` probe is what arms the outage alarm and the ASA endpoint is
what made that probe worth writing.

What it is: the only route in the system where the response body *is* the side
effect, because Lithic is holding a cardholder's authorisation open while it
waits. The deadline was measured rather than quoted — 6000 ms hard, and on
expiry Lithic **declines**, stamping `CUSTOMER_ASA_TIMEOUT`; a deliberately
stalling responder produced `DECLINED / UNKNOWN_HOST_TIMEOUT` at 6.19 s against
a 0.334 s baseline with no responder enrolled. So the handler is a latency
budget, `decide()` is pure, and **nothing on the path posts money**: a
synchronous decision that writes can block on the append lock, and a blocked
decision is a declined card. It fails closed.

**Sub-accounts or pots, with instant internal transfers that are pure ledger
moves — built.** See §1.

**A payee confirmation step that catches the mistyped account before the money
leaves — built.** `/payees`, migration 0016. The judgement it turns on: **a
failed routing checksum is a block and a failed name match is a warning**,
because they are different kinds of statement. The checksum is closed
arithmetic — a number that misses is not one any bank has been issued, so there
is no informed human who could be right to override it, and an "are you sure?"
in front of arithmetic teaches people to click through warnings. The name is an
open question, open in the direction of false positives, so the warning is made
to *cost* something instead: an acknowledgement row with a named human, an
instant and a sentence, and a trigger that refuses one against a check that was
not `warned`.

The honest limit is stated on the screen rather than in a footnote: **there is
no name-inquiry network for US ACH.** Nacha has no such message, and nothing in
this credential set can ask a bank what name sits on a third party's account —
measured, with the calls in [`PAYEES.md`](./PAYEES.md). So the screen labels
which kind of check it did: `linked_account_holder` when Plaid holds an Item for
the destination and the institution's own record of the holder name is what was
compared, `payer_asserted` when it is only the name already on the payee record.
The second is worth having and it is not confirmation of anything.

**Dispute intake on a settled card transaction, with provisional credit done
honestly — built.** `/disputes`, migration 0019, 16 cases on the live book. The judgement it
turns on is what happens when a dispute is **lost**: the clawback is a **new
event at a new value date**, not a correction of the provisional credit. We did
not grant that credit in error — we granted it on an outcome that had not
happened yet — and reversing it at the original value date would delete the fact
that the customer had the money for three weeks, which is a fact a regulator and
the customer both care about. The credit itself is real money in the ledger on
the day it is granted **and it is held**, because we may have to take it back.

The honest limit is on the screen rather than in a footnote, because this is the
feature where a workflow could most easily be dressed up as an integration:
`POST /v1/simulate/chargeback` and `POST /v1/simulate/dispute` are both **404**
in Lithic's sandbox — measured, printed in [`DISPUTES.md`](./DISPUTES.md) §0. So
the card, the authorisation, the clearing and the settled charge under dispute
are **live**; the intake, the provisional credit and the evidence workflow are
**ours**; and the network's verdict is **operator-driven, because there is nobody
to ask**. `recordDecision()` takes the outcome as an argument for exactly that
reason and `dispute.network_case_ref` is nullable because in this deployment
there is no network case to reference.

**Interest or fee accrual computed at end of day, visibly, on the ledger —
built.** `/accruals`, migration 0020, `/api/cron/accrual`. A monthly platform
fee, accrued daily across the days of the calendar month it belongs to, debiting
the customer's deposit account and crediting `4200 Fee income` — which is no
longer one of the two empty rows in the chart of accounts this list used to point
at. It is the only money movement in this system that no provider tells us about,
which makes it the direct test of whether an append-only design survives a
*computed* entry rather than an observed one.

The reason it earns its place is non-negotiable 9 rather than the stretch ladder:
*"pro-rata maths always leaves a penny, and someone has to eat it
deterministically."* A month's price does not divide into its days. The screen
shows which day carried the leftover, why, and that the month still sums to the
price to the cent — and the rule is a `CHECK` constraint in the migration, not a
paragraph. `v_accrual_month_drift` and `v_accrual_ledger_drift` are invariants
over it and both are in `pnpm db:check` now.

**The cross-border USDC payout with an FX quote the customer accepts first —
built, and the last mile is not.** This was "half" on the previous version of
this list, with the honest note that a schema and a library are not a feature.
They are a feature now: `/payouts` renders the quote book and the live rate
behind each quote, a customer can accept one, and the payout gate refuses an
unquoted payout with `FX_QUOTE_NOT_ACCEPTED`. Measured 2026-09-11T04:05Z: 40 rows
in `fx_quote` across the book, and the screen's default business shows 25 quotes,
9 of them live commitments, 0 priced off the fallback rate.

The mid rate is genuinely live — `frankfurter.dev`, the ECB's daily reference
rates republished, no key and no signup — and the spread is ours, and that split
is printed on the screen rather than described here. **Nothing in this feature
touches `journal_line`.** The only non-USD number in the database is
`fx_quote.buy_minor`; it is a promise, not a balance; no view adds it to a
dollar; and `fx.integration.test.ts` asserts that
`SELECT DISTINCT currency FROM journal_line` returns `['USD']` after the whole
suite has run. Multi-currency is explicitly out of scope and finishing this did
not introduce it.

**Three things about it are not built, and they are on the screen** ([`FX.md`](./FX.md) §7):

- **There is no off-ramp partner, so no peso has ever been delivered.** The USDC
  leg is real and confirms on Base Sepolia. The step after it — somebody in
  Mexico handing the beneficiary pesos — needs a licence this build does not
  have. Every delivery amount is a *commitment*: priced honestly, recorded
  honestly, never described as money that moved.
- **Nothing is hedged.** A production desk would cover an accepted commitment the
  moment it is accepted. We carry it, and the screen shows the live position on
  every open commitment rather than hiding that we do.
- **The Send button does not send.** It runs the gate against the real database,
  reports the verdict, and prints the operator CLI that will send it. Signing
  needs `USDC_SENDER_PRIVATE_KEY`, and the sanctioned path is
  `scripts/payout-usdc.mjs`, which prints the transaction hash **before** it
  broadcasts so a crash between the two is recoverable. A button on a public URL
  that signs with a wallet key on every click is a worse design, and a
  three-minute wait for a receipt does not fit in a serverless function anyway.

**Corridors are a closed list of five** — MXN, PHP, INR, BRL, JPY — rather than
"whatever the rate source returns". Listing thirty currencies would dress the
missing off-ramp up as coverage. JPY is on the list specifically because its
minor-unit exponent is 0, which keeps the arithmetic general instead of letting
`× 100` hide everywhere.

### The two other things that moved

**The provider table changed, and this time it changed upwards.** T+2h promised
six live slots and the mid-build reading was five of seven, with the two that
moved named in the README along with the evidence string that demoted them.
`/api/health` now reports **7 live of 7**, and the two recoveries were not
achieved by relabelling:

- `business_registry` was simulated because every KYB option on the brief's own
  menu is gated (DECISIONS 015, 018). It is now live against **GLEIF**, and the
  README says in those words that **GLEIF is a substitution for Middesk /
  Persona KYB / Sumsub KYB, all measured gated**. A hit there is a citation a
  reviewer can follow to a government register; a miss is evidence of nothing,
  so a miss is `needs_review`, never `approved`. That honesty created a second
  problem — ordinary small companies are not in GLEIF, so every business on the
  book stuck in a queue nothing could act on — and the answer was **manual
  review** (migration 0013), where a named human records a decision *as another
  observation* beside the registry's answer rather than overwriting it. The
  alternatives were to weaken the gate or to give a fictional business a real
  company's LEI, and both were disqualifying.
- `stablecoin` was simulated because the wallet held USDC and zero gas
  (DECISIONS 016). It is now live, funded, and has two providers behind one
  interface.

**A statement renderer was never explicitly cut, was never built, and now is.**
The v0 list missed it entirely; the mid-build cut list called it "the one cut I
would have put on the v0 list if I had seen it coming". `/statements`, migration
0009 and `src/lib/statements/` now close a day and publish a document pinned to
it, content-hashed so "identical every time" is checkable rather than asserted.
`book_day` holds 84 closed days and `statement` holds 40 published documents.
Both tables carry the append-only triggers, so closing a day twice is a
primary-key violation and correcting a statement is a new row with the next
`version` — not a convention the module follows, a capability the application
does not have.

**The force post stopped being a question and became a documented absence.**
Unchanged from the mid-build list, and still worth keeping: the v0 email asked
the graders whether they knew a way to originate one. Ninety minutes later every
`simulate` path in Lithic's OpenAPI spec had been enumerated — there is no
`/v1/simulate/force_post`, no `force` anywhere, and `/v1/simulate/clearing`
requires a parent authorisation token so it cannot produce an unmatched
clearing (DECISIONS 004). The domain model accepts an unmatched clearing as a
first-class case anyway: the matcher does not require an authorisation to exist,
`FINANCIAL_AUTHORIZATION` exercises the same no-hold-to-release path, and the
scheme-file simulator ships genuine unmatched clearings.

---

## 3. Deliberately unfinished, and left visible

Each of these is a thing I could have hidden and did not. They are ordered by
how much they would cost if nobody ever fixed them.

### 3.1 The over-capture `hold_closure` row, and why reverting was right

**Status: money correct, one bookkeeping row absent. It is the single skip in
live fire. DECISIONS 024.**

On the fuel-pump over-capture — authorise $50.00, clear $73.40 — the hold is
released. Two memo entries netting to exactly zero, one release posting, the
ledger posts 7340 in exactly one financial entry, the hold withholds nothing
afterwards, and `available == ledger − holds − uncleared` in integers with no
clamp. What is missing is a row in `hold_closure`, so the published attack's
literal wording, read as "one closure row", cannot be demonstrated. The row
appears only when the seven-day expiry sweeper runs.

The cause is a disagreement between two artefacts I wrote myself.
`src/lib/holds/model.ts` computes `closed(E) = is_final OR close/expiry OR
(A <= 0)`, and `lithic-events.ts` deliberately never sets `is_final` on a
CLEARING because Lithic offers no last-capture flag. With A=5000 and C=7340,
`A > 0`, so `closed` is false — while `DESIGN.md` §8.3 row 2, describing exactly
this case, says `closed = y`.

**I wrote the fix and reverted it.** Adding a `C >= A` arm to `closed(E)` made
three model tests fail, and the comment on one of them is the reason the fix is
not one line:

> `v_card_auth_hold` agrees; the ASCII diagram in DESIGN §8.2 is looser than the
> SQL, and the SQL is what `v_hold_drift` compares against.

The TypeScript model and the SQL view are held equal **by a live invariant**.
Changing one side without the other does not fix a disagreement — it creates a
worse one. `v_hold_drift` would start reporting drift on every over-captured
hold, and an invariant that reports drift is indistinguishable from a ledger
that has actually drifted. Changing a definition that a live invariant compares
against, under deadline, is the wrong trade. Nothing about the money is wrong:
H = 0 either way, `db:check` is 25 of 25, and every invariant view returns zero
rows.

The fix is one migration moving `v_card_auth_hold` and `model.ts` to close on
`C >= A AND sawAuthorisation` **together**, with `v_hold_drift` proving they
still agree, and then an amendment to §8.2's diagram, which the test comment
already flags as looser than the SQL.

### 3.2 Three stale memo holds

**Status: $60.00 on the memo book withheld from nothing. Residue of a bug the
code no longer has, on rows that cannot be deleted. Still three, verified
2026-09-11.**

Three card holds on Ridgeline Robotics carry a `hold_closure` row while the
event fold still says they are open. All three closure rows carry
`reason = "authorisation fully reversed"`, which is the fallback branch
`closureReason()` returns when the only thing that made `closed(E)` true was
`A <= 0`. That is the signature of the clearing-first bug: a settlement arriving
before its authorisation produces the event set `{clearing 3000}`, where `A = 0`
satisfies `A <= 0` and `closed` is true — and `hold_closure` is append-only with
`PRIMARY KEY (hold_id)`, so a closure written on the strength of it can never be
undone by the authorisation that follows.

The code no longer does this. `src/lib/holds/apply.ts` writes a closure on
`state.terminallyClosed`, not on `state.closed`, and `terminallyClosed` requires
`sawAuthorisation` — because `A <= 0` is only terminal once there is something
to have reversed. `holds.integration.test.ts` asserts zero closures on the
out-of-order pair, and live-fire attack 4 exercises the same path against the
deployed system and passes. These three rows predate that guard.

**What it costs today.** `v_hold_state.is_released` is
`EXISTS(hold_closure) OR …`, so availability treats these holds as released, and
$60.00 is withheld from nothing. **It is not caught by the invariant**, and that
is the part worth saying: `v_hold_drift` is
`WHERE NOT hs.is_released AND memo <> target`, so a hold with a spurious closure
row is outside the check *by construction*. The book still nets to zero
(`v_book_not_zero` is empty), so nothing is unbalanced — the memo book is simply
holding a balance nothing reads.

**Why it is still here.** `hold_closure` is append-only and `corgi_app` holds no
`DELETE`, which is the guarantee working exactly as designed. Migration 0011
introduced a `hold_closure_reversal` concept for precisely this shape; what has
not been decided is whether these three rows should be superseded or left as
the historical record they are, and inventing that policy under deadline is how
an append-only guarantee gets quietly weakened. The honest fix is week two:
widen `v_hold_drift` to compare `memo_balance_cents` against
`target_hold_cents` for *closed* holds too, so a spurious closure is reported
rather than excluded, and then decide.

### 3.3 The cron runs daily, not hourly

**Status: worst-case latency, never worst-case correctness. DECISIONS 022.**

This is a Vercel Hobby account, and Hobby caps cron jobs at once per day. The
hourly schedule I wanted was rejected at deploy time with
`Hobby accounts are limited to daily cron jobs`.

What that costs the webhook drain: if every `after()` nudge for a delivery were
lost — an instance recycled at exactly the wrong moment — the row waits for the
daily tick instead of the hourly one. It is not lost. The inbox row is durable
before any trigger runs, the dispatcher re-claims rows whose lease has expired,
and a row stays `pending` until a consumer succeeds.

What it costs the standing-order tick is less than it looks, and that is a
design property rather than luck: the unit of work is a **date**, the calendar
is a SQL function, and a tick that runs late still claims exactly the dates that
are owed. A missed day is picked up by the next tick's catch-up window. Past the
freshness limit the occurrence is still *recorded* — as
`refused / STALE_OCCURRENCE` — because a fortnight of rent debited in one batch
by a scheduler that has just woken up is worse than not firing. What a tick can
never do is claim a date twice, and that is the property being graded.

It is one line of `vercel.json` and a paid plan, and it is here rather than
smuggled into the README as though the guarantee were tighter than it is.

### 3.4 Thirty-five parked deliveries, and twenty-eight dead-lettered ones

**Status: correct behaviour, visible on purpose.**

`webhook_inbox` holds 424 rows in state `done`, **35** in state `parked`, **28**
in state `dead` and 15 still `pending` — measured 2026-09-11T04:05Z, and the
parked count grows every time live fire runs.

Every one of the parked rows is a card authorisation on a Lithic card created
directly in the sandbox and never registered to a customer here. The consumer
will not guess whose money to move, so it parks the event with the card token in
the reason and stops. I would rather a grader saw that than a clean zero: they
are verified, durable, and they post the moment a card is claimed, which is the
whole argument for parking rather than dead-lettering or dropping. What is
genuinely missing is the *claim* path — there is no screen or script that maps
an orphan card token to a business, so today the only way to clear them is to
insert a `card` row by hand.

The dead-lettered rows are spread across all five providers and come from
earlier consumer iterations. They are retained rather than deleted, which is the
append-only inbox behaving as designed, and nothing re-drives them. A
re-drive path for a dead letter whose consumer has since been fixed is a real
gap and not a large one.

### 3.5 The cross-border payout has no last mile

**Status: the quote is built and accepted on a screen; the peso is not
delivered. Measured 2026-09-11T04:05Z — 40 quotes in `fx_quote`, 25 on the
screen's default business, 9 of them live commitments.**

The previous version of this entry said the FX schema and library had no route
above them, which was the most misleading state anything in this repo was in: a
schema and a library that look like a feature from the file tree and cannot be
reached from the product. That is closed — `/payouts` renders the quote book, a
customer accepts a quote, and the payout gate refuses an unquoted payout with
`FX_QUOTE_NOT_ACCEPTED`.

What replaces it as the honest gap is one step further down the path, and it is
§2's three bullets: **no off-ramp partner, so no peso has ever been delivered;
nothing is hedged; and the Send button does not sign.** All three are printed on
the screen above the button rather than left here. The USDC leg either side of
that gap is real and confirms on Base Sepolia.

### 3.6 Smaller things, named so they are not discovered

- **The Increase adapter's four money operations have still never run.** Its
  `probe` is `measured` — `GET /accounts?limit=1` answers 200 from the adapter
  and from the deployed system on every `/api/health` request — and
  `originate`, `observe`, `settle` and `reverse` are `~` on the capability
  matrix in [`RAILS.md`](./RAILS.md) §3: supported, and never run against the
  provider. The full create/submit/settle/return lifecycle at DECISIONS 019 was
  driven against the live Increase sandbox **by hand, not through this
  adapter** — the sandbox transfer carries no `Idempotency-Key` and
  `initiateCredit` always sends one, which is how we know. Two real Increase
  deliveries have reached the deployed webhook endpoint and had their
  signatures verified; both were dead-lettered with "no consumer registered for
  provider 'increase'", so `parseEvent` has never seen a real delivery either.
  Letting the one earned cell promote its neighbours would be liveness by
  presence wearing a round trip as a disguise.
- **Two live-fire attacks fail against the current book, and neither is a money
  error.** Attack 3's assertion (3) and attack 7's position-freeze cross-check
  both assume a quieter database than this one now is. §3.7 has the diagnosis
  and the reproduction.
- **Three lines of the disputes UI divide money by 100 and call `toFixed(2)`.**
  `src/components/disputes/DisputeForms.tsx:164`, `:182` and `:453`.
  `node scripts/compliance.mjs` fails **NN9 — "Money is never a float"** on
  them, and it is right to: `src/lib/format/money.ts` exists precisely to make
  that impossible, its header says "there is no `/ 100`, no `toFixed`", and
  these three bypass it. **No money is computed from them** — two render an
  `<option>` label and one fills a form default that is re-parsed into cents
  server-side — so nothing in the ledger is wrong, and that is the reason it is
  in this list rather than in a panic. It is also the reason it matters: the
  README says money is never a float, and three lines in the working tree say
  otherwise, which is precisely the kind of gap "code you cannot explain when
  we point at it" describes. The fix is to call `formatCents()`, and it is
  minutes.

- **Git history still holds two dead sandbox credentials.** Both were rotated or
  had already expired before the working tree was scrubbed (DECISIONS 023). The
  purge needs a `filter-branch` and a force push, which is destructive and
  irreversible and has not been taken. It is written up rather than quietly
  skipped.
- **The MCP rate limiter is per process.** `RateLimiter` holds its buckets in
  memory, so across several warm instances the effective limit is
  (instances × limit). It is written down in `src/lib/mcp/ratelimit.ts` rather
  than implied away. It is not the control that stops an attacker — the token,
  the tenant scope and the approval queue are — it is the control that stops a
  well-meaning agent in a retry loop from consuming an approver's afternoon.
- **The role switcher is a cookie, and it is labelled as one.** `role.ts` and
  `approvals/session.ts` both carry a header saying it is a demo affordance and
  not an authorisation boundary, and naming the one function that replaces it.
  Nothing is granted by it: the actor is resolved by a `SELECT` with a `WHERE`
  clause and handed to the database, which decides. See [`DEMO.md`](./DEMO.md).
- **`/api/sim` exists behind `SIM_CONTROL_ENABLED`.** Absent or `false` in any
  shared environment, and absent in this deployment.
- **Some `edge` states are labelled fixtures.** On `/funding`, `/payments` and
  `/pots` the edge state is live. Elsewhere it is a fixture and the page says
  so — `/standing-orders`, for instance, needs the ledger balance above the
  amount and the available balance below it, which is a transient fact about
  somebody else's card holds. The same shape exists in the live history as a
  genuinely refused row; the fixture is what can be shown to order.

### 3.7 Two live-fire assertions that no longer hold, and why

**Status: measured 2026-09-11T03:43Z, PASS 5 / FAIL 2 / SKIP 1 of 8. Neither
failure is a money error, and saying so is not the same as proving it, so both
diagnoses below name the query that settles them.**

The previous reading of this file was 7 PASS / 0 FAIL / 1 SKIP. Two attacks
moved to FAIL in the hours since, and the useful thing about both is that they
failed for the same reason: **each carries an assertion that the rest of the
book is quiet, and the book stopped being quiet when funding, payments, accrual
and disputes started posting every day.**

**Attack 3, assertion (3) — "the correction grew a line on the day we learned:
expected 9 to be +0".** Reproduced exactly, twice, forty minutes apart, both
times at 9, so it is systematic rather than a race. The attack's real claim is
that a correction posts at the **original** value date and does **not** also
post at its own — and that claim is asserted separately, by idempotency key
(`card:refund:<token>`), and **it passes**. So do every positive half: the
reversal carries settlement day's value date, reverses the clearing, joins its
correction group, has a later `booking_seq`, and settlement day's statement moves
by exactly −$73.40 with exactly one more line. What fails is the *additional*
assertion that the statement for the learning day has zero lines at all — which
was true when the only thing that could touch that day was the correction under
test. It is not true now:

```sql
SELECT e.idempotency_key FROM journal_line l
  JOIN journal_entry e ON e.id = l.entry_id
  JOIN account a ON a.id = l.account_id
 WHERE l.value_date = DATE '2026-09-11' AND a.code = '2100';
-- plaid:funding:…, payment:release:…  — nine of them on that account
```

Plaid funding credits and released payments, booked by the funding and payments
screens on the day they happened. The test is measuring the book's ordinary
business and calling it a stray correction. **The fix is to scope the assertion
to the correction's own entries rather than to the day**, which is a test change
and a small one. It is written here rather than made, because editing an attack
so that it stops failing is exactly the move this document exists to refuse:
somebody else should get to look at the assertion first.

**Attack 7, the position-freeze cross-check — "expected -35270n to be
-40270n".** The attack has three assertions and two pass: the outage is visible
(`/api/health` moves lithic to `stale` at 183 s inside its own 180–900 s band,
escalates to top-level `status: "degraded"` with `degradesDeployment=true` and
`database.reachable=true`, and the deployed console renders
`data-provider-status="provider-down"` **with the balances still underneath
rather than blanked**), and the gate is proven against the thing it guards.

The one that fails is the whole-business position check — and **re-running
attack 7 on its own passes 3/3**, which is what identifies the fault, because the
difference between the two runs is not the code.

The check is guarded. The test only asserts it when the window was quiet, and it
decides quiet like this:

```sql
SELECT count(*)::int FROM journal_entry
 WHERE booking_time >= <window opened> AND book = 'financial';
```

**The guard is scoped to the financial book, and the quantity it guards is moved
by the memo book.** A hold opening or releasing is a memo posting, so an in-flight
hold from an earlier attack in the same run lands inside the window, moves
available, and the guard does not see it — and a full run has five earlier
attacks placing and releasing card holds on the same business. In the isolated
run the guard fired for an unrelated reason (a foreign *financial* write), the
check was **reported rather than asserted**, and the figure it reported was
exactly right: available `54880 -> 49880`, ledger unchanged at `104880`.

The per-hold assertions carry the money claim in both runs and hold in both:
exactly **one** memo entry for the recovered hold, of exactly **−5000** cents
(withheld once, not twice), **zero** financial entries against the swallowed
token, and exactly **one** `card_auth_event` for two deliveries. The fault is in
the guard's scope rather than in the hold. The fix is to count memo postings
against the business as well, or to drop the cross-check entirely and keep the
per-hold assertions, which are strictly stronger than it — and, as with attack 3,
it is written here rather than made.

Both are on week two, at items 4 and 5, above the wire rail and below the
`closed(E)` fix.

---

## 4. Week two, in value order

Ordered by what each is worth, not by what is quickest. One sentence of
reasoning each.

**The list changed shape since the last version, and the change is the honest
headline: the three items that used to be 1, 2 and 3 — disputes, accrual, and
the FX quote — are built.** What replaced them at the top is not new scope. It
is the two places this system disagrees with itself, because a ledger that
disagrees with itself is worth more attention than a feature that does not
exist yet.

**1. Close `closed(E)` on `C >= A AND sawAuthorisation`, in `v_card_auth_hold`
and `model.ts`, in one migration.** It is the last place two of my own artefacts
disagree about the same number, it is the only live-fire *skip*, and every day it
stays open is a day somebody could resolve it in the wrong direction and turn a
prose mismatch into a live drift alarm. §3.1 is why the one-line version of this
fix was written and reverted.

**2. Widen `v_hold_drift` to cover closed holds, then decide what supersedes a
wrong `hold_closure` row.** The three stale memo holds are outside the invariant
*by construction* — `WHERE NOT is_released AND memo <> target` excludes a
spuriously-closed hold — which means the check cannot currently see the exact
failure it exists to catch, and that is a worse property than the sixty dollars
it is sitting on.

**3. Widen attack 7's quiet-window guard to the memo book, or delete the check.**
It decides "the window was quiet" by counting **financial** entries and then
asserts a quantity the **memo** book moves, so an in-flight hold from an earlier
attack in the same run walks straight through it — which is why the attack passes
in isolation and fails in a full run (§3.7). The per-hold assertions beside it are
strictly stronger and were never in doubt, so the honest options are to fix the
guard or to admit the cross-check adds nothing.

**4. Scope attack 3's assertion (3) to the correction's own entries.** Reproduced
twice at the same number, root cause identified, fix understood, deliberately not
made — see §3.7 on why editing an attack so it stops failing is the wrong order
of operations under deadline.

**5. Wires.** `approval_policy` already carries a `wire` row at threshold $0
requiring two distinct approvers, so the control surface is built and only the
rail is missing; it is below the ledger-integrity items because a second same-day
rail teaches less than a correct hold model, and above the mobile app because it
moves money.

**6. The off-ramp for the cross-border payout.** The quote is accepted, the USDC
confirms on Base Sepolia, and nobody hands the beneficiary pesos — which makes
the delivery amount a commitment rather than a delivery, and every screen says
so. Closing it needs a licensed partner rather than code, which is why it is
here rather than higher.

**7. A card-claim path for parked deliveries, and a re-drive for dead letters.**
Twenty verified events are waiting on a mapping that today exists only as a
hand-written `INSERT`, and a queue whose only drain is a DBA is a queue that
grows.

**8. Persona for director KYC, replacing Stripe Identity.** Stripe Identity is
live and cannot be *driven* — Persona's `perform-simulate-actions` pushes an
inquiry to pending, declined and needs_review while firing the real webhooks for
each, which is what makes the non-happy-path states genuinely third-party rather
than rows I flipped.

**9. Run the Increase adapter's four `~` operations against the sandbox.** The
credential authenticates and the probe is measured; `originate`, `observe`,
`settle` and `reverse` have never been sent. The wire shapes come from
`research/ach/NOTES.md`, where not one line is marked `[MEASURED]`, and the
cheapest way to find out whether `submitted + settlement.settled_at -> settled`
actually fires is to fire it.

**10. A public REST API.** The MCP surface already proves the hard half — an
external caller that can read the book and can only *request* money movement — so
a REST API is mostly serialisation and versioning, which is valuable to a
customer and teaches a grader nothing the agent surface has not already shown.

**11. The mobile app.** The console is responsive and all fourteen screens work
on a phone; a native app is a distribution decision rather than a domain one, and
nothing in this build would change to accommodate it.

**Off the list on purpose, in week two and after:**

- **Multi-currency.** The brief rules it explicitly out of scope, and the FX
  quote above is deliberately built so that finishing it does *not* introduce
  it: a quote is a promise, not a balance, and no view adds `buy_minor` to a
  dollar.
- **Our own card processing, identity checks or bank linking.** "Buy, don't
  build." Rebuilding what could have been integrated is a scoping mistake, and
  the one slot where every vendor was gated was answered by substituting a
  different real provider and labelling it, not by writing our own registry.
- **An authentication system.** Cut on day one and still cut. The role switcher
  is a cookie, it is labelled as one in two file headers, it grants nothing, and
  the function that replaces it is named in both. Building auth would consume a
  day and prove nothing about a ledger.
