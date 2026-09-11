# What I did not build, what changed, and what week two is

Four sections. The first is the cut list as I published it at T+2h and what
actually happened to each line — several of them were built. The second is the
stretch ladder, which is where most of the movement is. The third is the things
this build finished *deliberately incomplete*: discovered while building, left
standing, and worth more said out loud than hidden. The fourth is week two in
value order.

A cut list with no argument is a to-do list, so every line keeps its reasoning.
Nothing here is a surprise to `DECISIONS.md`; the entry number is given where
one exists. Figures were measured against production on 2026-09-11.

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
| Mobile app | **still cut** | Responsive web console, as planned — but eleven screens rather than the three that were promised, each with five URL-driven states. Nothing is "in the nav as disabled text" any more; that placeholder is gone because the screens behind it exist. |
| Standing orders | **built** | `/standing-orders`, migration 0012, `src/lib/standing/`. Exactly-once at the occurrence level, enforced by a `GENERATED ALWAYS` idempotency key on a `UNIQUE` column rather than by scheduler discipline. Four live mandates on the book. See §2 and [`STANDING-ORDERS.md`](./STANDING-ORDERS.md). |
| Public API | **replaced, and still no REST** | An **MCP surface** shipped instead — `POST /api/mcp`, seven read tools and one that queues a payment request a human must work through. That was not on the v0 plan at all. The operations deliberately absent from it, with the failure mode for each, are [`AGENT-LIMITS.md`](./AGENT-LIMITS.md). A public REST API is still cut, and it is now a week-two item rather than a permanent one. |
| Sub-accounts and pots | **built** | `/pots`, migration 0015, `src/lib/pots/`. Instant internal transfers that are pure ledger moves — two lines inside the customer's own `2100` subtree, no rail entry, no asset account touched. Four invariant views hold that claim: `v_internal_transfer_impure`, `v_pot_identity_drift`, `v_pot_negative`, `v_pot_orphan`, all empty. The subtree walk stayed recursive, which is what made adding the level cheap. |
| Disputes with provisional credit | **still cut** | Unchanged, and now the top of week two. Reasoning in §4. |
| Wires | **still cut, policy still there** | No wire rail. `approval_policy` still seeds a `wire` row at threshold $0 with `required_approvals = 2`, because two *distinct* approvers is what makes the maker-checker rules demonstrable at all, and the seed opens two approver actors for exactly that reason. The policy exists; the rail does not, and a payment cannot be raised on it. |
| Interest and fee accrual | **still cut** | Unchanged. The chart of accounts has `4200 Fee income` and `5100 Network and processing fees` sitting empty, and nothing computes an end-of-day accrual. |
| Card controls in the real-time auth webhook | **built** | `/api/webhooks/lithic-auth`, migration 0014, `src/lib/cards/`. Decided inside Lithic's measured 6000 ms ASA deadline. See §2 and [`CARD-CONTROLS.md`](./CARD-CONTROLS.md). |

---

## 2. The stretch ladder, item by item

The brief's stretch ladder has six rungs. Four are built, one is half, one is
not.

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
honestly — not built.** Week two, item 1.

**Interest or fee accrual computed at end of day, visibly, on the ledger — not
built.** Week two, item 2.

**The cross-border USDC payout with an FX quote the customer accepts first —
half.** The payout is built twice over: two providers behind one interface, both
confirmed on Base Sepolia, reconciled against the chain across both wallets by
`scripts/reconcile-usdc.mjs`. The **quote** is the half that is not finished.
It is **actively landing as this is written**, which is the honest thing to say
about it rather than either claim or deny it. Measured at 2026-09-11T01:16Z:
migration 0017 is applied to production — `fx_quote`, `fx_quote_acceptance`,
`fx_quote_settlement`, `fx_rate_observation` and `v_fx_quote` all exist, holding
18 / 8 / 2 / 18 rows — and `src/lib/fx/` holds the rate, the quote arithmetic,
the gate and the store. What does **not** exist yet is the product path: no
route under `src/app` renders a quote, and nothing outside `src/lib/fx` imports
it, so a customer cannot be shown a rate and cannot accept one. Schema and a
library are not a feature, and a cut list exists precisely to stop somebody
discovering that for themselves. It stays on week two until a customer can
accept a quote on a screen and a payout can cite the acceptance. **Check
`/api/health` and the repo rather than this paragraph if the timestamp above is
old** — this is the one line in this document most likely to have moved.

The design decision the schema already commits to is worth recording, because it
is the one that could have gone wrong: **this is not a multi-currency ledger.**
Nothing in 0017 touches `journal_line` or adds a currency to it. A quote is a
customer-facing *commitment* about a payout that has not happened yet; the only
non-USD number in the database is `fx_quote.buy_minor`, it is a promise rather
than a balance, and no view ever adds it to a dollar.

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
H = 0 either way, `db:check` is 14 of 14, and every invariant view returns zero
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

### 3.4 Twenty parked deliveries, and twenty-four dead-lettered ones

**Status: correct behaviour, visible on purpose.**

`webhook_inbox` holds 259 rows in state `done`, **20** in state `parked` and
**24** in state `dead`.

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

### 3.5 The FX quote schema and library, with no route above them

**Status: migration 0017 applied, `src/lib/fx/` written and exercised, and
nothing under `src/app` reaches it — so it is in the file tree and not in the
product. Measured 2026-09-11T01:16Z; see §2, and check the repo rather than this
line, because it is the one most likely to have moved.**

### 3.6 Smaller things, named so they are not discovered

- **`src/lib/rails/README.md` §1 is stale in the safe direction.** It says the
  Increase ACH adapter is a "LIVE code path, NEVER RUN" with no key in the repo.
  That was true when written and stopped being true at DECISIONS 019, where a
  full create/submit/settle/return lifecycle ran against the live sandbox. The
  document under-claims; it does not over-claim.
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

---

## 4. Week two, in value order

Ordered by what each is worth, not by what is quickest. One sentence of
reasoning each.

**1. Dispute intake on a settled card transaction, with provisional credit done
honestly.** It is the richest remaining domain problem in the track — provisional
credit is money you lend against an outcome you do not yet know, which makes it
a conditional entry with its own reversal path — and the statement renderer it
depends on now exists, so the dependency that kept it last is gone.

**2. Interest and fee accrual computed at end of day, visibly, on the ledger.**
`4200` and `5100` are sitting empty in a chart of accounts that was designed for
them, an accrual is the one money movement in this system that no provider tells
us about, and "visibly, on the ledger" is a direct test of whether the
append-only design survives a computed entry rather than an observed one.

**3. The FX quote the customer accepts before the USDC payout.** Migration 0017
and `src/lib/fx/` are in production with no route above them, which is the most
misleading state anything in this repo is in — a schema and a library that look
like a feature from the file tree and cannot be reached from the product — and
finishing it is a screen and a payout that cites the acceptance.

**4. Close `closed(E)` on `C >= A AND sawAuthorisation`, in `v_card_auth_hold`
and `model.ts`, in one migration.** It is the last place two of my own artefacts
disagree about the same number and the only remaining live-fire skip, and every
day it stays open is a day somebody could resolve it in the wrong direction and
turn a prose mismatch into a live drift alarm.

**5. Widen `v_hold_drift` to cover closed holds, then decide what supersedes a
wrong `hold_closure` row.** The three stale memo holds are outside the invariant
*by construction*, which means the check cannot currently see the exact failure
it exists to catch, and that is a worse property than the sixty dollars it is
sitting on.

**6. Wires.** `approval_policy` already carries a `wire` row at threshold $0
requiring two distinct approvers, so the control surface is built and only the
rail is missing; it is below the ledger-integrity items because a second
same-day rail teaches less than a correct hold model, and above the mobile app
because it moves money.

**7. A card-claim path for parked deliveries, and a re-drive for dead letters.**
Twenty verified events are waiting on a mapping that today exists only as a
hand-written `INSERT`, and a queue whose only drain is a DBA is a queue that
grows.

**8. Persona for director KYC, replacing Stripe Identity.** Stripe Identity is
live and cannot be *driven* — Persona's `perform-simulate-actions` pushes an
inquiry to pending, declined and needs_review while firing the real webhooks for
each, which is what makes the non-happy-path states genuinely third-party rather
than rows I flipped.

**9. A public REST API.** The MCP surface already proves the hard half — an
external caller that can read the book and can only *request* money movement —
so a REST API is mostly serialisation and versioning, which is valuable to a
customer and teaches a grader nothing the agent surface has not already shown.

**10. The mobile app.** The console is responsive and the eleven screens work on
a phone; a native app is a distribution decision rather than a domain one, and
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
