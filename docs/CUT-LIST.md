# What I did not build, what changed, and what week two is

Three sections. The first is the cut list as I published it at T+2h and what
actually happened to each line. The second is the things this build finished
*deliberately incomplete* — discovered while building, left standing, and worth
more said out loud than hidden. The third is week two in value order.

Nothing here is a surprise to `DECISIONS.md`; the entry number is given where
one exists.

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

| Cut at T+2h | Still cut? | What actually happened |
| --- | --- | --- |
| Mobile app | yes | Responsive web console, as planned. Three screens: `/accounts`, `/approvals`, `/reconciliation`. `Payments` and `Statements` are in the nav as plainly disabled text rather than as links that 404. |
| Standing orders | yes | Unchanged. Still the second week-two item. |
| Public API | **replaced by something else** | No REST API. An **MCP surface** shipped instead — `POST /api/mcp`, four tools, three read and one that queues a payment request a human must work through. That was not on the v0 plan at all. The list of operations deliberately absent from it, with the failure mode for each, is [`AGENT-LIMITS.md`](./AGENT-LIMITS.md). |
| Sub-accounts and pots | yes | Unchanged. `v_deposit_control_drift` is written as a recursive subtree walk rather than "sum the 2100 children" so that adding a level later cannot silently break it. |
| Disputes with provisional credit | yes | Unchanged. Still the third week-two item. |
| Wires | **half** | No wire rail. But `approval_policy` seeds a `wire` row at threshold $0 with `required_approvals = 2`, because two *distinct* approvers is what makes the maker-checker rules demonstrable at all, and the seed opens two approver actors for exactly that reason. The policy exists; the rail does not. |
| Interest and fee accrual | yes | Unchanged. The chart of accounts has `4200 Fee income` and `5100 Network and processing fees` sitting empty. |
| Card controls in the real-time auth webhook | yes | Unchanged — and it came off the *week two* list too. See below. |

### The four things that moved

**Card controls dropped from the top of week two, and not for the reason I
predicted.** The v0 email said I would drop it "if the core is standing early".
The core does stand — money moves end to end on the deployed URL — but that is
not why it moved. It moved because live fire found a gap that did not exist as a
concept at T+2h: `/api/health` reports nothing about webhook delivery freshness,
so an issuing-provider outage is invisible to the one endpoint whose job is to
be believed (attack 7, DECISIONS 024). An outage you cannot see is worth more
than a control you have not shipped.

**The provider table changed, and it changed downwards.** T+2h promised six live
slots. `/api/health` reports **five live of seven**, and the two that moved are
named in the README with the evidence string that demoted them. `business_registry`
is simulated because every KYB option on the brief's own menu is gated behind a
sales conversation or a business verification (DECISIONS 015, 018). `stablecoin`
is simulated because the wallet holds 20.00 USDC and 0 wei of gas (DECISIONS
016). Persona was promised LIVE and is not signed up; director KYC runs on
Stripe Identity, which is live, and which cannot script a `declined` or
`needs_review` outcome — so the non-happy-path KYC states are not third-party.

**The force post stopped being a question and became a documented absence.**
The v0 email asked the graders whether they knew a way to originate one. Ninety
minutes later every `simulate` path in Lithic's OpenAPI spec had been
enumerated: there is no `/v1/simulate/force_post`, no `force` anywhere, and
`/v1/simulate/clearing` requires a parent authorisation token so it cannot
produce an unmatched clearing (DECISIONS 004). The domain model accepts an
unmatched clearing as a first-class case anyway — the matcher does not require
an authorisation to exist — `FINANCIAL_AUTHORIZATION` exercises the same
no-hold-to-release path, and the scheme-file simulator ships genuine unmatched
clearings.

**A statement renderer was never explicitly cut and was never built.** The
`statement` table exists, with `opening_balance_cents` and
`closing_balance_cents` deliberately stored as the as-published axis of the
bitemporal model (DECISIONS 008), and nothing writes to it. So live fire's
"pull Tuesday's statement" is executed as `ledgerBalanceAsOf(account, day)`,
which is the fold a statement is a rendering of, and the evidence line says so.
This is the one cut I would have put on the v0 list if I had seen it coming.

---

## 2. Deliberately unfinished, and left visible

Each of these is a thing I could have hidden and did not. They are ordered by
how much they would cost if nobody ever fixed them.

### 2.1 The over-capture `hold_closure` row, and why reverting was right

**Status: money correct, one bookkeeping row absent. DECISIONS 024.**

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
that has actually drifted. With seventy-five minutes to a deadline, changing a
definition that a live invariant compares against is the wrong trade. Nothing
about the money is wrong: H = 0 either way, `db:check` is 14 of 14, and all five
invariant views return zero rows.

The fix is one migration moving `v_card_auth_hold` and `model.ts` to close on
`C >= A AND sawAuthorisation` **together**, with `v_hold_drift` proving they
still agree, and then an amendment to §8.2's diagram, which the test comment
already flags as looser than the SQL.

### 2.2 Three stale memo holds

**Status: $60.00 on the memo book withheld from nothing. Residue of a bug the
code no longer has, on rows that cannot be deleted.**

Measured against production on 2026-09-10. Three card holds on Ridgeline
Robotics carry a `hold_closure` row while the event fold still says they are
open:

| `hold_id` | A | C | `target_hold_cents` | `memo_balance_cents` | `is_closed` | `closure_posted` |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `6481a5c4…` | 5000 | 3000 | 2000 | 2000 | false | **true** |
| `e8173742…` | 5000 | 3000 | 2000 | 2000 | false | **true** |
| `636977c6…` | 5000 | 3000 | 2000 | 2000 | false | **true** |

All three closure rows carry `reason = "authorisation fully reversed"`, which is
the fallback branch `closureReason()` returns when the only thing that made
`closed(E)` true was `A <= 0`. That is the signature of the clearing-first bug:
a settlement arriving before its authorisation produces the event set
`{clearing 3000}`, where `A = 0` satisfies `A <= 0` and `closed` is true — and
`hold_closure` is append-only with `PRIMARY KEY (hold_id)`, so a closure written
on the strength of it can never be undone by the authorisation that follows.

The code no longer does this. `src/lib/holds/apply.ts` writes a closure on
`state.terminallyClosed`, not on `state.closed`, and `terminallyClosed` requires
`sawAuthorisation` — because `A <= 0` is only terminal once there is something
to have reversed. `holds.integration.test.ts` asserts zero closures on the
out-of-order pair, and live-fire attack 4 exercises the same path against the
deployed system. These three rows predate that guard.

**What it costs today.** `v_hold_state.is_released` is
`EXISTS(hold_closure) OR …`, so availability treats these holds as released:
`v_available_balance.active_holds_cents` for Ridgeline reads 20000 while the
memo balances of its live holds sum to 26000. Sixty dollars is withheld from
nothing. **It is not caught by the invariant**, and that is the part worth
saying: `v_hold_drift` is `WHERE NOT hs.is_released AND memo <> target`, so a
hold with a spurious closure row is outside the check by construction. The book
still nets to zero (`v_book_not_zero` is empty), so nothing is unbalanced — the
memo book is simply holding a balance nothing reads.

**Why it is still here.** `hold_closure` is append-only and `corgi_app` holds no
`DELETE`, which is the guarantee working exactly as designed. Cleaning it means
a superseding row, which means a `hold_closure` reversal concept that does not
exist yet, and inventing one under deadline is how the append-only guarantee
gets quietly weakened. The honest fix is week two: widen `v_hold_drift` to
compare `memo_balance_cents` against `target_hold_cents` for *closed* holds too,
so a spurious closure is reported rather than excluded; then decide what
supersedes a wrong closure row.

### 2.3 The cron runs daily, not hourly

**Status: worst-case latency, never worst-case correctness. DECISIONS 022.**

This is a Vercel Hobby account, and Hobby caps cron jobs at once per day. The
hourly schedule I wanted was rejected at deploy time with
`Hobby accounts are limited to daily cron jobs`, so `vercel.json` runs
`/api/drain` at `17 4 * * *`.

What that costs: if every `after()` nudge for a delivery were lost — an instance
recycled at exactly the wrong moment — the row waits for the daily tick instead
of the hourly one. It is not lost. The inbox row is durable before any trigger
runs, the dispatcher re-claims rows whose lease has expired, and a row stays
`pending` until a consumer succeeds. If the panel asks "what if the nudge is
lost", the answer is "up to twenty-four hours on this plan, and here is the line
that changes it". It is one line of `vercel.json` and a paid plan, and it is
here rather than smuggled into the README as though the guarantee were tighter
than it is.

### 2.4 Eleven parked deliveries

**Status: correct behaviour, visible on purpose.**

`webhook_inbox` currently holds 53 rows in state `done` and **11 in state
`parked`**. Every one of the eleven is a card authorisation on a Lithic card
created directly in the sandbox and never registered to a customer here. The
consumer will not guess whose money to move, so it parks the event with the card
token in the reason and stops.

I would rather a grader saw that than a clean zero. They are verified, durable,
and they post the moment a card is claimed — which is the whole argument for
parking rather than dead-lettering or dropping. What is genuinely missing is the
*claim* path: there is no screen or script that maps an orphan card token to a
business, so today the only way to clear them is to insert a `card` row by hand.

### 2.5 Webhook delivery freshness, and a provider-down state

**Status: the reason attack 7 skips. Top of week two.**

`/api/health` reports credential and capability liveness per slot and says
nothing about how long it has been since a provider last delivered anything, so
an issuing-provider outage is invisible to the one endpoint the README tells
people to believe. `src/components/account/data-contract.ts` carries balances,
holds and postings and no provider or feed health field, so no component can
render one.

Everything the outage attack asserts about the *money* already holds — through
the dark window the trial balance does not move, the swallowed event has zero
inbox rows, nothing is invented; on recovery a doubled backlog produces one
inbox row, one `card_auth_event`, one hold, and available drops by exactly 5000.
Only "degrades visibly" is unproven. The data already exists in
`webhook_inbox.received_at`, and the test greps for `lastDelivery`,
`deliveryLag`, `secondsSinceLastDelivery`, `webhookHealth` or `feedStale` and
passes the moment one lands.

### 2.6 Smaller things, named so they are not discovered

- **`.env.example` is stale.** It predates the owner/app role split in DECISIONS
  008: it names a single `DATABASE_URL` and lists neither `DIRECT_URL`,
  `DRAIN_TOKEN` nor `MCP_AGENT_TOKENS`. Its provider-key comments are still
  accurate. The authoritative contract is `src/lib/env.schema.ts`, and the
  README's environment table is written from it.
- **`src/lib/rails/README.md` §1 is stale in the safe direction.** It says the
  Increase ACH adapter is a "LIVE code path, NEVER RUN" with no key in the repo.
  That was true when it was written and stopped being true at DECISIONS 019,
  where a full create/submit/settle/return lifecycle ran against the live
  sandbox. The document under-claims; it does not over-claim.
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

---

## 3. Week two, in value order

Ordered by what each is worth, not by what is quickest. One sentence of
reasoning each.

**1. Delivery freshness on `/api/health`, and a stale-feed state on the account
screen.** It is the only one of the eight published attacks with no coverage at
all, the data is already sitting in `webhook_inbox.received_at`, and a health
endpoint that cannot see an outage is a health endpoint that will report green
through one.

**2. Close `closed(E)` on `C >= A AND sawAuthorisation`, in `v_card_auth_hold`
and `model.ts`, in one migration.** It is the last place where two of my own
artefacts disagree about the same number, and every day it stays open is a day
somebody could resolve it in the wrong direction and turn a prose mismatch into
a live drift alarm.

**3. Widen `v_hold_drift` to cover closed holds, then decide what supersedes a
wrong `hold_closure` row.** The three stale memo holds are outside the invariant
*by construction*, which means the check cannot currently see the exact failure
it exists to catch, and that is a worse property than the sixty dollars it is
sitting on.

**4. A statement renderer, and reproducibility for a closed day.** The whole
bitemporal argument is currently demonstrated through a fold rather than through
the artefact a customer actually receives, and `statement`'s stored opening and
closing balances only earn their exemption from the no-stored-balances rule once
something publishes them.

**5. Gas, then a USDC payout that confirms on chain.** The brief says a payout
that confirms on a testnet is worth far more than a slide about one, this is
blocked on a faucet rather than on code, and it is the difference between five
live slots and six.

**6. A card-claim path for parked deliveries.** Eleven verified events are
waiting on a mapping that today only exists as a hand-written `INSERT`, and a
queue whose only drain is a DBA is a queue that grows.

**7. Persona for director KYC, replacing Stripe Identity.** Stripe Identity is
live and cannot be *driven* — Persona's `perform-simulate-actions` pushes an
inquiry to pending, declined and needs_review while firing the real webhooks for
each, which is what makes the non-happy-path states genuinely third-party rather
than rows I flipped.

**8. Card controls inside the provider's real-time auth decision webhook.** It
was top of the v0 list and it still deserves to be built early, because it is
the only feature here that has to answer inside a network timeout and therefore
the only one whose design is worth proving before the code that depends on it
exists.

**9. Standing orders, with exactly-once firing across restarts.** The scheduler
problem is genuinely hard and genuinely uninteresting to a grader until the
ledger underneath it is trusted, which is why it sits below everything that
makes the ledger more trustworthy.

**10. Disputes with provisional credit.** It is the richest remaining domain
problem — provisional credit is money you lend against an outcome you do not yet
know — and it needs the statement renderer above it to be worth anything, so it
is last by dependency rather than by importance.

**Off the list on purpose:** the mobile app, sub-accounts and pots, interest and
fee accrual, a public REST API. Nothing on this build has bent to accommodate
them, and each stays cut in week two.
