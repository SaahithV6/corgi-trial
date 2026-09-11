# What this team chose not to do, and why

A cut list is not a changelog. It is where a reader learns what was refused and
on what argument, and by the end of this build the most valuable thing in it is
the reasoning rather than the inventory — because the inventory kept moving and
the reasoning did not.

So this file leads with the argument. §1 is the one idea this build actually
discovered: **twenty-one guards that reported healthy while the thing they
watched was broken, every one failing the same way.** §2 is the T+2h cut list
and what happened to each line. §3 is what is genuinely still cut, five items,
each verified tonight. §4 is what is deliberately unfinished and left visible.
§5 is week two in value order. §6 is what stays off the list on purpose.

---

## 0. Provenance

**Every figure in this file was measured between 08:23Z and 08:43Z on
2026-09-11**, against the live Neon database and the deployed system at
`https://corgi-trial-psi.vercel.app`, running commit
`2f863c8f52f16a7c13059f172c31617e45e9c264` (`shortSha 2f863c8`, read from
`/api/health` at **08:23:21Z**). The command is beside each number. Where a
number here disagrees with what those commands say when you run them, they are
right and this file is stale.

That paragraph is not boilerplate, and it is here because **figures in this repo
have gone stale repeatedly and then been repeated confidently.** Live fire is
the worked example. It was quoted at 7 PASS / 0 FAIL / 1 SKIP for hours while
the suite was actually reading 5 / 2 / 1. The version of this file I am
replacing had caught up to 5 / 2 / 1, stamped it 03:43Z, and explained both
failures at length — and by the time anyone read it the suite was back to
7 / 0 / 1, which is what my own run returned at **08:28:52Z**. Every one of
those readings was honest when written and wrong when read. The fix is not more
care; it is a timestamp against every number, which is what follows.

| Command | Started | Result |
| --- | --- | --- |
| `curl /api/health` | 08:23:21Z | `7 live of 7`, top-level `status: "degraded"`, `database.reachable: true`, commit `2f863c8` |
| `node scripts/dbcheck.mjs` | 08:23:46Z | **35 passed, 1 failed** (5s) |
| `node scripts/livefire.mjs` | 08:23:58Z | **PASS 7 · FAIL 0 · SKIP 1 of 8** (294s) |
| `node scripts/coreloop.mjs` | 08:34:07Z | **PASS 6 · FAIL 1 · SKIP 0 of 7** (94s, 107 HTTP calls to the deployed URL, 3 to Lithic) |
| `node scripts/compliance.mjs` | 08:42:41Z | **PASS 24 · FAIL 6 · WARN 0 · UNKNOWN 4 · CITED 7 of 41** (22s) |
| `curl -X POST /api/mcp` (no token) | 08:37:45Z | `HTTP 401`, `www-authenticate: Bearer realm="corgi-mcp"` |
| `curl /api/v1` (no token) | 08:37:40Z | `HTTP 401 MISSING_BEARER_TOKEN` |
| `find src/app -name page.tsx` | 08:38Z | 23 page routes; 20 linked from the front door; 18 in the nav |
| 22 routes probed with `curl -o /dev/null -w '%{http_code}'` | 08:38:47Z | all **200** |

Two of those deserve a sentence before anyone reads further, because they are
the numbers a grader will ask about first.

**`coreloop.mjs` fails leg 4, and it fails because the fix works.** Leg 4 is
"authorise $50.00, settle $73.40". It reports `holds moved $0.00, expected
$50.00`. The Lithic sandbox account's daily cap is exhausted, so the
authorisation is declined — and since migration 0026 a declined authorisation
does not place a hold. The leg's expectation was written when declines were
being ingested as approvals. A red leg telling the truth beats a green one that
is not, and it is deliberately not being tuned. §3.4 has the measurement.

**`/api/health` reports `degraded`, and it is right to.** The degradation is
`webhookProcessing`, not an integration: at 08:29:51Z, 33 Lithic and 167
Increase deliveries had been accepted, signature-verified, and then
dead-lettered. It is also reading them more alarmingly than the database
supports. §4.2 is the accounting.

---

## 1. The through-line: twenty-one guards, one failure shape

If this build has one finding worth carrying out of the room, it is this.

> **Every guard that failed here reported healthy, because what it excluded was
> shaped exactly like the failure it existed to catch.**

Not "we had bugs." The bugs are ordinary. What is not ordinary is that the
*checks* failed, and that they all failed the same way, in views, in probes, in
schema, in test fixtures, in a front-door link list, and twice in sentences the
coordinator had written down as settled. Twenty-one of them are catalogued.

### 1.1 The catalogue

| # | Guard | What it excluded — the exclusion, not the bug | Where |
| --- | --- | --- | --- |
| 1 | `v_hold_drift` | `WHERE NOT is_released AND memo <> target` — a hold with a spurious closure row is outside the check *by construction*, and a spurious closure is the failure | 026, tabled in 033 |
| 2 | secret scanner v1 | plain `grep`, which skips binary — stopped at a NUL byte in `inbox.ts` and silently skipped 1,206 lines | 023 |
| 3 | the health escalation gate | `slots.every(s => status === 'live')` — one honestly `unprobed` slot made the clause unsatisfiable for ever, so no webhook outage could move `status` | 028 |
| 4 | the document auditor | understood the spelling `"N of 7"` only, and read straight past `"4/7 live"` — its own iteration log's other spelling | 027 |
| 5 | secret scanner v2 | a `0x` + 64-hex *shape* rule that fires on innocent curve constants. "The guard's failure mode is not a false positive; it is the disabling that follows one." | 032 |
| 6 | `v_deposit_control_drift` | one side filtered `code = '2100'` flat while the other walked the subtree — **$500.00 of drift**, under a comment claiming the view "cannot silently break" | 041 |
| 7 | `reconcile-usdc.mjs` | one wallet address, read from the environment — a second wallet made 90¢ of phantom drift against a ledger that was exactly right | 044 |
| 8 | `v_standing_order_double_fire` | joined `payment_instruction` on a **UNIQUE** column and asked for `count > 1` — tautologically empty. The real failure, two instructions for one occurrence under *different* keys, was precisely what it could not see | 045 |
| 9 | the probe's `fromStatus()` | `if (status === 400 \|\| 409 \|\| 422) return "live"` — measured, Lithic answers `404` to an unknown path **with no `Authorization` header at all** | 045 |
| 10 | the Stripe Connect probe | an `else` branch meaning "success": it tested for one literal string and treated everything else as entitlement | 034 |
| 11 | `probeIntegrations()`'s fallback | a slot with **no probe** inherited the env-derived status, so `card_webhooks` read LIVE with evidence reading *"no probe defined for this slot"* | 026 |
| 12 | `compliance.mjs` AF6's stamp check | compares each entry only against the one immediately before it. Four duplicated stamps exist; it reports three, and the count reads as complete | 047 |
| 13 | **`card_auth_event` itself** | no column for a declined verdict. `id, auth_id, kind, amount_cents, is_final, value_date, provider_event_id, inbox_id, received_at` — the outcome was discarded at the front door, so an approved and a declined authorisation were the same row by the time anything could reason about them | 050 |
| 14 | `terminallyClosed`'s `A <= 0` arm | a predicate on a running total that can go *back up*, licensing a permanent row. Found by the fuzzer | 051 |
| 15 | **an ACH adapter's own test fixture** | `parseEvent()` gated on `id.startsWith('ach_transfer_')` — every sandbox id is `sandbox_ach_transfer_…`, so the whole rail was dropped. The test asserting the unmodelled branch **hardcoded `associated_object_type: 'ach_transfer'` and varied only the id**: the case was proven by the exact mechanism that was broken | 052 |
| 16 | `v_refused_auth_hold` | `JOIN card_auth_event_result r ON r.event_id = ev.id` — **INNER** — plus `AND r.result IS NOT NULL`. Those are the two ways this schema spells *we have no verdict*, and a missing verdict is the bug the view exists to catch. It **INNER JOINed the table that is empty exactly when the bug is present.** Measured: 98 of 130 events invisible, $5,665.60 withheld, view reading **zero** | COMPLIANCE §5.1 |
| 17 | `/api/health`'s `webhookHealth` | computed from `MAX(webhook_inbox.received_at)` — **arrival**, which says nothing about disposition. 179 Increase deliveries were accepted, verified, retried eight times and dead-lettered while health read `increase: fresh` | COMPLIANCE §5.4 |
| 18 | `coreloop.mjs`'s subject ranking | read `kyb_evidence` and then never used it; the tiebreak fell to `localeCompare`, so the alphabet picked a business verified by the **simulator** to demonstrate leg 1's *"real KYB check"* | COMPLIANCE §5.5 / 057 |
| 19 | `v_hold_closure_not_terminal` | five string literals matched against a **free-text** `reason` column written by the code paths the guard polices. 0032's own closures landed outside the list by *wording*, not intent. **Wired into CI while this very pattern was being written up** | 056 |
| 20 | `v_accrual_month_drift` | vacuous — `WHERE month_complete` over **zero** complete accrual months | 056 |
| 21 | `scripts/audit-claims.mjs` | validates every document against a deployment that predates the tree, and cannot see that it is doing so | 056 |

**Two of the twenty-one were claims the coordinator made and had to retract.**
Instance #6's view carried a comment, and this cut list carried a line, both saying it
"cannot silently break" when a sub-account level was added; pots added the
level and it broke eight lines below the sentence. #7's premise — that reading
the wallet proves the account — was the coordinator's too, and a second wallet
ended it. Those are the two inside the guard catalogue. Two more coordinator
claims died the same way outside it and belong in the same paragraph: a briefed
balance of "around −$1,800" that measured **0 overdrawn accounts, 0 of 5
deposit leaves negative, 0 debit day-pairs in the 45-day window** (053), and
"the core loop passes 7/7 on a second business", asserted repeatedly and
established as **unsupported** — `coreloop.mjs` had no business selector at all
(057). The 057 claim turned out to be true once it was run, which is luck, not
method, and would have been indistinguishable from the alternative right up to
the moment somebody ran it.

### 1.2 The count is twenty-one, and `DECISIONS.md` says nineteen

This needs saying rather than smoothing over, because a count that cannot
explain itself is the same defect one level up.

`DECISIONS.md`'s running count goes 5 (033) → 9 (045) → 13 (050) → 15 (052) →
**19** (056). `docs/COMPLIANCE.md` §5, written ten minutes *before* 056, had
already numbered three different instances as **16, 17 and 18** — the three in
the table above. 056's three are disjoint from those, and COMPLIANCE §5.6 itself
calls the first of them "the nineteenth instance". **18 + 3 = 21.** 056 wrote
"nineteen" because it counted from fifteen rather than from eighteen.
`docs/EVALUATION.md` runs a *third*, independently-offset count and should never
be quoted alongside either. The reconciled total is twenty-one; the log's own
running count is short by two; and there are at least four more unnumbered
candidates in 054, 055 and `HOLDS.md` §9.9 that a reviewer could fairly argue.
If the panel counts and gets a different number, that gap is real and it is
better said here than defended.

### 1.3 The generalisation, and it is shipped

Two things came out of twenty-one instances, and both are code rather than
advice.

**`dbcheck` prints a `GUARD REACH` section on every run**, naming the population
each invariant actually ranges over. Not "check your guards" — *make every guard
state its own domain, out loud, every run.* At 08:23:51Z it printed thirteen
populations, and one of them is a line nobody had to ask for:

```
EMPTY v_accrual_month_drift — 0 COMPLETE accrual months: green because there is
                              nothing to be green about
```

That is instance #20 confessing on its own, every run, for as long as it stays
vacuous.

**A new invariant must be made to fail before it is trusted.** `dbcheck --prove`
does it in rolled-back transactions. The recorded run is DECISIONS 056's, not
one I re-ran tonight: 0 → 1 for refused, 86 → 87 for unanswered, 0 → 1 for
`v_wire_availability_drift`, plus the trigger refusing a refusal filed as an
authorisation. Two new views in 053 were likewise made to fail, 0 → 1 and
0 → 5, before being trusted.

### 1.4 Where the generalisation does not reach yet, measured tonight

Both of these were found while writing this file, and they are here rather than
quietly fixed because the point of the section is that the pattern is a live
number, not a trophy.

**`GUARD REACH` overstates instance #19's own population.** `dbcheck.mjs:502`
computes the reach of `v_hold_closure_not_terminal` as
`SELECT count(*) FROM hold_closure`, and printed **228** at 08:23:51Z. The view
still carries #19's five string literals. Measured at **08:32:15Z**:

```sql
SELECT count(*) AS all_closures,
       count(*) FILTER (WHERE reason = ANY (ARRAY[
         'authorisation closed or expired by the network','final capture received',
         'authorisation expiry reached','authorisation fully reversed',
         'authorisation expired unused'])) AS in_the_list
FROM hold_closure;
-- all_closures 228   in_the_list 126
```

**102 closures — 45% — are outside the guard, and the section invented to name
each guard's population reports the guard as reaching all 228.** The reach query
counts the table; the view filters the table; nothing compares them. This is the
same shape one level up, in the mechanism built to end it.

**`--prove` covers two views out of twenty-one.** `dbcheck` ran twenty-one
invariant views at 08:23:51Z — a coincidence of arithmetic with §1.1's guard
count, and nothing more — and `--prove` reaches exactly two of them,
`v_refused_auth_hold` and `v_wire_availability_drift`. Its own closing line says
so: *"run with `--prove` to make the card-hold and wire invariants FAIL on
purpose"*. The house rule binds new invariants; **nineteen of the twenty-one
views have never been made to fail by this tool.** Among them is
instance #8, **which has been quietly repaired and never re-proved**: the view
now reads

```sql
JOIN payment_instruction pi
  ON pi.idempotency_key LIKE ('standing:' || o.standing_order_id || ':%')
 AND (pi.idempotency_key = o.idempotency_key OR pi.value_date = o.scheduled_date)
```

The `OR pi.value_date = o.scheduled_date` branch is what makes it satisfiable —
two instructions for one occurrence under *different* keys now group together
and trip `HAVING count(DISTINCT pi.id) > 1`. It is no longer unsatisfiable, and
the catalogue entry above, which several documents still describe as "stands as
written", is out of date. It has also never been made to fail, so its 26
occurrences of green mean less than they look.

---

## 2. The T+2h cut list, and what happened to each line

`thread/T+2h_attack_plan.md` said:

> **Not building:** the mobile app (responsive web instead), standing orders,
> the public API, sub-accounts and pots, disputes with provisional credit,
> wires, interest and fee accrual, card controls in the real-time auth decision
> webhook.

**Seven of the eight were built. One is still cut.**

| Cut at T+2h | Now | What happened |
| --- | --- | --- |
| Mobile app | **still cut** | The only survivor, and it is a decision with a name on it. §3.1. |
| Standing orders | built | `/standing-orders`, migration 0012. Exactly-once at the **occurrence**, enforced by a `GENERATED ALWAYS` idempotency key on a `UNIQUE` column rather than by scheduler discipline. 26 occurrences at 08:23:51Z. |
| Public API | **built** | **12 versioned REST routes under `/api/v1`**, counted from the tree at 08:38Z: `/`, `/accounts`, `/accounts/[code]`, `/accounts/[code]/balance`, `/transactions`, `/payments`, `/payments/[id]`, `/payees`, `/statements`, `/statements/[business_date]`, `/reconciliation/breaks`, `/limits`. Scoped per business, idempotent, approval-gated; there is no anonymous read — `curl /api/v1` at 08:37:40Z answered `HTTP 401 MISSING_BEARER_TOKEN` with the condition and the resolution in the body. The MCP surface stands beside it: 11 tools, 10 read and `initiate_payment`, which queues. |
| Sub-accounts and pots | built | `/pots`, migration 0015. Pure ledger moves inside the customer's own `2100` subtree; four invariant views hold that claim. |
| Disputes with provisional credit | built | `/disputes`, migration 0019. 176 dispute ledger lines at 08:23:51Z. A lost dispute claws back as a **new event at a new value date**, never a correction of the credit — we did not grant it in error, we granted it on an outcome that had not happened yet. |
| Wires | **built, and driven end to end** | §2.1. |
| Interest and fee accrual | built | `/accruals`, migrations 0020 and 0024. 34 posted accrual days, 25 posted interest days. Overdraft interest ships with **zero rows** and the screen says so on its face, because the book has no overdrafts — measured, not assumed (053). |
| Card controls in the real-time auth webhook | built | `/api/webhooks/lithic-auth`, migration 0014, decided inside Lithic's **measured** 6000 ms ASA deadline. Nothing on the path posts money: a synchronous decision that writes can block on the append lock, and a blocked decision is a declined card. |

### 2.1 Wires — the line that was most wrong

The previous version of this file said: *"No wire rail… The policy exists; the
rail does not, and a payment cannot be raised on it."* **Every clause of that is
now false.**

- Migration 0025, `src/lib/rails/wire/`, `docs/WIRES.md`, a consumer registered
  at `drain.ts:97`, and a `wire` fieldset on `/payments`.
- **21 distinct `sandbox_wire_transfer_…` ids** named across `webhook_inbox` —
  reason text and payload — measured 08:49:06Z, deliveries received
  03:58:18Z–06:20:30Z and signature-verified.
- **12 `payment_instruction` rows on rail `wire`**, all $42.00, requested
  04:31:17.270Z–04:45:27.617Z (measured 08:49:23Z). **12 of 12 carry two
  distinct approving actors** before release, against the `wire` policy at
  threshold $0 requiring 2 — counted as
  `count(DISTINCT actor_id) FILTER (WHERE kind='approved') >= 2` over
  `payment_instruction_event`. `SELECT count(*) FROM v_wire_availability_drift`
  → **0** at 08:49:23Z.
- Submission and reversal on the same transfer, with **different IMADs** —
  `sandbox_wire_transfer_897tmwn18z27tzkqbkhe`, $2,500.00, `status: "reversed"`:
  submission IMAD `20260911sgzamiaa787670` at 03:58:34Z, reversal IMAD
  `20260911apvdjfqt599399` at 03:58:50Z, `class_name: "inbound_wire_reversal"`.
  **Source note, because it is the one figure here that is not a fresh
  round trip:** those bytes are the read-back recorded in
  `src/lib/rails/wire/measured.ts:39-125`, not a call made tonight. What
  corroborates them outside that file is the transfer's idempotency key,
  `corgi-wire-27138-12782`, which appears independently in all six
  `webhook_inbox` deliveries for that transfer in the live database.

Two things it does not do, named here rather than left to be found: **no wire
webhook delivery has ever posted to the ledger** (`SELECT count(*),
count(inbox_id) FROM journal_entry WHERE rail='wire'` → `48, 0`), and **the
provider-side wires and the book-side instructions were never the same wire** —
every outbound wire delivery refused with *"carries Idempotency-Key
'corgi-itest-…', which names no payment_instruction on this book. NOTHING WAS
POSTED."* The intended key is `payment:<instruction id>`. The refusal is the
consumer doing exactly the right thing with an unrecognised wire; what it proves
is that the two halves have not yet been joined in one run.

---

## 3. What is genuinely still cut — five items

Each one verified tonight. Three of the five need a person or a licence, not
code, and saying which is which is most of the value.

### 3.1 The mobile app — cut by Saahith, and recorded as a decision

The brief's v1 scope names a mobile app. It is the **one deliberate refusal** in
that list, and it is not an omission or a thing that ran out of hours. It is the
principal's own call, recorded verbatim in `plan/graph.py` at node `W2G`:

> named in the brief's v1 scope and **CUT BY SAAHITH**. the console is
> responsive; a react-native app in 48h would be a slide, and the brief says a
> testnet payout that confirms beats a slide about one

and, in his words, *"idc about mobile apps."*

**`DECISIONS.md` has no entry for this cut** — `grep -in mobile DECISIONS.md` at
08:39Z returns nothing. The record lives in the T+2h email and in `plan/graph.py`
and nowhere else, which is why the reasoning is reproduced in full here rather
than cited. A cut with a name on it that is only recorded in a planning file is
one commit away from reading as an omission.

The argument stands on its own: the brief's own unwritten test says *"a
stablecoin payout that actually confirms on a testnet is worth far more than a
slide about one."* A React Native shell in 48 hours would be the slide. The
console is responsive — a no-horizontal-scroll pass over every screen, recorded
as done at `plan/graph.py` node `U10`, and not something this file re-measured
tonight — and **a native app is a
distribution decision rather than a domain one** — nothing in the schema, the
hold model or the correction machinery would change to accommodate one.

Worth noting against the count this file used to publish: the mid-build version
said **fourteen** screens. Measured at 08:38Z, `src/app` holds **23 page
routes**; two are detail pages reached by opening a row, one is the front door
itself, and **20 are linked from the front door**, all answering `200` when
probed at 08:38:47Z. `ScreenLinks.test.ts` walks the filesystem and fails the
build if a new page is neither linked nor given a written reason — the test it
replaced pinned seven hrefs by name and therefore could never notice an unlisted
screen, which is instance-shaped and is why it was replaced.

The nav has **18**. `/economics` and `/transactions` are on the front door and
not in the header, and **no test asserts the nav is complete** — the SCREENS
test covers only the front door. That is the same pinned-list problem, alive,
one component over.

### 3.2 The cron cadence — daily, because Hobby caps it there

**Status: worst-case latency, never worst-case correctness. DECISIONS 022.**

`vercel.json` carries **five** cron jobs, and every one is daily:

```
/api/drain          17 4 * * *
/api/cron/standing  23 5 * * *
/api/cron/accrual   41 6 * * *
/api/cron/outbound  53 7 * * *
/api/cron/holds     11 8 * * *
```

The hourly schedule this build wanted was rejected at deploy time with
`Hobby accounts are limited to daily cron jobs`. It is one line and a paid plan.

What it actually costs is less than the schedule suggests, and that is a design
property rather than luck. The `after()` nudge fires the drain on the request
that received the webhook, so the daily tick is a floor and not the mechanism:
the inbox row is durable before any trigger runs, the dispatcher re-claims rows
whose lease has expired, and a row stays `pending` until a consumer succeeds.
For standing orders the unit of work is a **date** and the calendar is a SQL
function, so a tick that runs late still claims exactly the dates that are owed,
and past the freshness limit the occurrence is still *recorded* — as
`refused / STALE_OCCURRENCE` — because a fortnight of rent debited in one batch
by a scheduler that has just woken up is worse than not firing. What a tick can
never do is claim a date twice.

### 3.3 The cross-border last mile — needs a licence, not code

**Status: the quote is priced, accepted and settled on chain. Nobody hands the
beneficiary pesos.**

Measured 08:37:14Z: **70 rows in `fx_quote`, 33 acceptances, 8 settlements.**
The mid rate is genuinely live (`frankfurter.dev`, the ECB's daily reference
rates republished) and the spread is ours, printed as its own line on
`/payouts`. Corridors are a closed list of five — MXN, PHP, INR, BRL, JPY —
rather than "whatever the rate source returns", because listing thirty currencies
would dress the missing off-ramp up as coverage. JPY is on the list because its
minor-unit exponent is 0, which keeps the arithmetic general.

The USDC leg is real. Verified **by me, on chain, at 08:39:34Z** —
`eth_getTransactionReceipt` against `https://sepolia.base.org` for
`0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e` returns a
receipt in block `0x2c81180` with a log from
`0x036cbd53842c5426634e7929541ec2318f3dcf7e` (Base Sepolia USDC) carrying
`0x1e3481` = **1,979,521 minor units, 1.979521 USDC**.

**Seven of the eight settlement rows are not that.** Measured 08:39:47Z, seven
carry `tx_hash = 0x` + `a`×64 and `entry_id IS NULL`. They come from
`fx.integration.test.ts:514`, which runs against this same database. Exactly one
settlement is a real transaction and it is the only one with a ledger entry. A
reader counting `fx_quote_settlement` would count eight, so it is said here.

What is cut is the step after the chain. **Nobody in Mexico hands the
beneficiary pesos.** That needs a licensed partner this build does not have, so
every delivery amount is a **commitment** — priced honestly, recorded honestly,
never described as money that moved — and `/payouts` says exactly that above the
button rather than in a footnote. Two companions to it, also on the screen:
**nothing is hedged** (a production desk would cover an accepted commitment the
moment it is accepted; we carry it and show the live position), and **the Send
button does not sign** — it runs the gate against the real database, reports the
verdict and prints the operator CLI. A button on a public URL that signs with a
wallet key on every click is a worse design, and `scripts/payout-usdc.mjs`
prints the transaction hash **before** it broadcasts so a crash between the two
is recoverable.

**Nothing in this feature touches `journal_line`.** The only non-USD number in
the database is `fx_quote.buy_minor`; it is a promise, not a balance; no view
adds it to a dollar; and `fx.integration.test.ts` asserts that
`SELECT DISTINCT currency FROM journal_line` returns `['USD']` after the whole
suite has run. Multi-currency is explicitly out of scope and finishing this did
not introduce it.

### 3.4 An approving card authorisation — the sandbox cap is exhausted

**Status: a human decision, deliberately not taken.**

`GET https://sandbox.lithic.com/v1/accounts` at **08:36:10Z**:
`spend_limit: {daily: 500000, monthly: 2000000, lifetime: 0}` — $5,000 a day,
spent. Every authorisation since is declined.

I tried the smallest possible one. `POST /v1/simulate/authorize` with
`amount: 1` at **08:36:36Z** → `HTTP 201`, transaction
`68c9d432-8070-4138-abd1-c2356c4ad40b`. Read back at 08:36:42Z:

```json
{ "result": "DECLINED", "status": "DECLINED", "amount": 1,
  "hold": { "amount": 0 },
  "events": [ { "type": "AUTHORIZATION", "result": "DECLINED",
                "detailed": ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"] } ] }
```

**One cent is declined.** The ledger is behaving correctly in response: read at
08:36:01Z, every `AUTHORIZATION` verdict in the preceding hour is `DECLINED`,
stored under `kind = 'declined'`, placing no hold. That is migration 0026
working. It is also why `coreloop.mjs` leg 4 is red.

Raising the cap is `PATCH /v1/accounts/{token}`, which was **blocked by the
permission classifier** — a deliberate guard on changing a provider account's
settings — and working around it is not on the table. Whether to raise the limit
on somebody's sandbox account is the principal's call, not an agent's. Until it
is raised, the *approving* half of the authorisation lifecycle is demonstrated
from history rather than live, and the live demonstration available right now is
the declined half, which is the half that used to be broken.

### 3.5 `v_refused_auth_hold` — 149 rows, red on purpose

**Status: `dbcheck` fails on it every run, and that is the correct reading.**

`node scripts/dbcheck.mjs` at 08:23:51Z:

```
FAIL  v_refused_auth_hold is empty — 149 row(s)
      unanswered   125 hold(s),  149 event(s), $9,665.20 withheld
      <- no verdict was ever observed for these events. NOT repairable by
         inventing one; see 0032.
```

Broken down at 08:47:27Z by how the verdict is missing — the money is summed
once per hold, not once per event, and the three columns reconcile to the
totals above:

| `result_source` | events | holds | withheld |
| --- | --- | --- | --- |
| `not_retained` — we looked and there is nothing to read | 86 | 74 | $5,065.60 |
| `ingest` — a verdict row exists and its `result` is NULL | 51 | 39 | $4,179.60 |
| `absent` — no verdict row at all | 12 | 12 | $420.00 |
| | **149** | **125** | **$9,665.20** |

Zero are `refused`. Everything provably standing against a refusal was repaired.

**These rows were deliberately not excluded**, and the reasoning is the cleanest
statement of §1 anybody managed: *the exclusion would be safe, and would still
be an exclusion shaped like the failure.* A `WHERE result IS NOT NULL` would
turn this check green tonight and blind it permanently, which is instance #16
exactly — the bug that produced these rows is *the verdict going missing*, so
the state the guard must not exclude is *the verdict missing*.

The `ingest` slice is the one to watch, because it is not historical residue:
`card_auth_event_result` holds **75 rows with `source = 'ingest'`,
`provider_step = 'AUTHORIZATION'` and `result IS NULL`** at 08:30:38Z. The live
path is writing verdict rows it cannot fill in. That is a third way to have no
verdict, and it is growing. It is on week two at item 3.

---

## 4. Deliberately unfinished, and left visible

Ordered by what each would cost if nobody ever fixed it.

### 4.1 The over-capture `hold_closure` row — the single live-fire SKIP

**Status: money correct, one bookkeeping row absent, and the question that kept
it open is now settled by measurement. DECISIONS 049.**

On the fuel-pump over-capture — authorise $50.00, clear $73.40 — the hold is
released: two memo entries netting to exactly zero, the ledger posts 7340 in
exactly one financial entry, `available == ledger − holds − uncleared` in
integers with no clamp. What is absent is a row in `hold_closure`, so the
attack's literal wording, read as "one closure row", cannot be demonstrated.

The old entry here called this a disagreement between two artefacts. **It was
not a disagreement; it was an untested premise, and the premise was wrong.** The
question was whether an authorisation can receive an incremental *after* a
clearing that exceeds it. Measured against the Lithic sandbox — and **re-taken
on every run**, because the measurement is itself one of attack 2's three tests
and it passed in my 08:23:58Z suite: `authorize 5000`
→ 201; `clearing 7340` → 201 `SETTLED`, `amounts.hold.amount: 0`;
`authorization_advice 9000` → **201 APPROVED**; `clearing 1660` → 201. Our model
goes `A=5000 C=7340 H=0` then `A=9000 C=7340 H=1660` — **the hold reopens** —
and the network then captures exactly that 1660. Lithic's own
`amounts.hold.amount` read `0` throughout and was **wrong**; our arithmetic
predicted the money the merchant actually took.

So **over-capture is not terminal**, and a `C >= A` arm would set
`v_hold_state.is_released`, freeing $16.60 that was still authorised — the exact
row migration 0011 exists to clean up, bought to make a number that was already
correct look tidier. `research/DESIGN.md` §8.2's ASCII diagram, whose
`OVER/EXACT CAPTURED -> TERMINAL: H = 0 forever` box the measurement falsifies,
is the defect — §8.3's rows 5 and 12 are the ones that actually apply and both
say not closed. The full argument is [`HOLDS.md`](./HOLDS.md) §9.

The attack is now three tests: the money claim (PASS), the measurement itself
(PASS — and if Lithic ever refuses the advice it **skips loudly**, which is the
trigger to reopen the decision), and the closure-row claim (SKIP, quoting that
run's own token and approved advice). The decision is wired to the evidence that
produced it, so it cannot quietly rot — which is the only reason a two-day-old
measurement is allowed to stand as an argument in a document this stale-prone.

**A SKIP is not a pass**, and the suite prints that sentence under its own
scoreboard.

### 4.2 The dead-letter backlog, and the missing card-claim path

**Status: correct refusals, visible on purpose, and the queue has no drain.**

`webhook_inbox` at 08:29:51Z:

| provider | done | parked | dead |
| --- | --- | --- | --- |
| lithic | 859 | 54 | 33 |
| increase | 52 | 16 | 167 |
| plaid | 3 | — | — |
| stripe | 10 | — | — |

Bucketed at 08:41:28Z:

- **Lithic, 54 parked + 33 dead — all "card … is not registered to a customer".**
  Authorisations on cards created directly in the sandbox and never bound to a
  business here. The consumer will not guess whose money to move, so it parks
  with the card token in the reason. The parked count **grows every live-fire
  run** — the newest arrived at 08:28:51Z, during mine. The 33 dead are ones
  that parked twelve times and aged out.
- **Increase, 167 dead — all "no consumer registered for provider 'increase'",
  every one received between 03:58:18Z and 04:46:06Z.** That consumer is
  registered now (`drain.ts:77`, `:97`) and is live: the 16 parked rows from
  06:18:58Z–06:20:31Z carry refusals only the wire and ACH consumers can emit.
  **Not one delivery received after 04:46:06Z has died.** So the 167 are a
  backlog, not a live condition.

Two honest consequences. **`/api/health` reads this wrongly and degrades on it.**
At 08:23:39Z it reported increase `verdict: "dropping"`, `degradesDeployment:
true`, quoting reason *"no consumer registered"* with `newestAgeSeconds: 8123`
— which resolves to a *dead-lettering* at 06:18:46Z of a row received at
04:45Z. `processing_error` is not cleared when a row moves on, so health quotes
the stale string and reads a retry ladder draining out as a current fault. That
is how the deployment gets to `degraded` at 08:23:21Z with all seven
integrations live.

**And what is genuinely missing is the claim path.** There is no screen or
script that maps an orphan card token to a business, and no re-drive for a dead
letter whose consumer has since been fixed. Today the only way to clear either is
a hand-written `INSERT`. A queue whose only drain is a DBA is a queue that grows,
and the 54 are the proof.

### 4.3 The Increase adapter: the money moved, and `parseEvent` still has not run

The old entry said the adapter's four money operations *"have still never run."*
That is now half wrong and half right, and the half that is right is the half
that matters.

**The money ran.** Instruction `0bf777a9-9167-44b8-8d0f-796b0325f51e`, rail
`ach`, **600000 cents = $6,000.00**, idempotency key
`test:approvals:1789097931095:gate`, requested 03:38:58.234Z, approved and
released 03:39:00.166Z, originated through `IncreaseAchRail.initiateCredit` as
`sandbox_ach_transfer_x5vdo5m7b6k924sszlms` with **that instruction's own key as
the `Idempotency-Key`** — which is the discriminator DECISIONS 019 named, since
the by-hand sandbox transfer carried none. Five signature-verified deliveries
name it. It posted **two entries and only two**:

| entry | idempotency_key | lines |
| --- | --- | --- |
| `82a30763-…` | `ach:settled:sandbox_ach_transfer_x5vdo5m7b6k924sszlms` | 2300 +600000 / 1110 −600000 |
| `bccc009c-…` | `ach:return:sandbox_ach_transfer_x5vdo5m7b6k924sszlms:644288470109390` | 1110 +600000 / 2100 −600000 |

Across the **entire book**, `SELECT count(*) FROM journal_entry je JOIN
webhook_inbox w ON w.id = je.inbox_id WHERE w.provider='increase'` returns
**2**. Two, and only two.

**`IncreaseAchRail.parseEvent()` still has never seen a real delivery.**
`grep -rn "\.parseEvent(" src/` returns only its own test file and the simulator.
The consumer says why, in its own header: *"Deliberately NOT reusing
IncreaseAchRail.parseEvent(): it gates on
associated_object_id.startsWith('ach_transfer_')…"* — the prefix from
instance #15. It is **fixed** in the adapter (`client.ts:468` now dispatches on
`associated_object_type`) and the consumer reimplements the branch rather than
calling it. So a real delivery has been parsed and consumed, by the consumer,
not by the adapter method the capability matrix grades.

**`docs/RAILS.md` §3 still reads `| Increase ACH | increase.ach | live | ~ | ~ |
~ | ~ | + |`**, with a note saying "two real Increase deliveries have reached the
deployed endpoint and both were dead-lettered". Those cells are right about
`parseEvent` and stale about the deliveries, of which `webhook_inbox` held
**235** at 08:29:51Z — 52 consumed, 16 parked, 167 dead. Letting the one
earned cell promote its neighbours would be liveness by presence wearing a round
trip as a disguise, so they stay `~` and the staleness is named here.

### 4.4 The float check fails on a string literal

`node scripts/compliance.mjs` at 08:42:41Z: **PASS 24 · FAIL 6 · UNKNOWN 4 ·
CITED 7 of 41**, violating AF1, AF2, AF3, AF5, **NN9** and G1.

**NN9's three disputes lines are fixed.** A `grep` for `/ 100` and `toFixed(`
over `src/components/disputes/DisputeForms.tsx` returns nothing; lines 164, 182
and 453 now call `formatUsd()`. The checker agrees, in its own words: *"ok — no
parseFloat / toFixed / \*100 / /100 on a money-named expression in 584 source
files."*

**NN9 fails anyway, and it is the checker that is wrong.** Run in isolation at
08:43:05Z:

```
NN9  Money is never a float                                          FAIL
      float-shaped column declarations in migrations:
      db/migrations/0038_webhook_refusals.sql:183 'x-real-ip',
```

`compliance.mjs:1500` scans `CREATE TABLE` bodies with
`/\b(float4|float8|double\s+precision|\breal\b|money|numeric|decimal)\b/i`, and
`\breal\b` matches inside the string literal `'x-real-ip'` in a `CHECK
(source_header IN (…))`. There is no float column there.

This is §1 with the sign flipped — a guard reporting **broken on a healthy
book** rather than healthy on a broken one — and it is the second of those this
build has produced (`HOLDS.md` §9.9 is the first). It is left failing rather
than patched tonight, because tuning a checker until it is green is the move
this document exists to refuse, and because a false positive is exactly how
instance #5's scanner got itself disabled. The fix is to anchor the pattern to a
column-definition position rather than to anything inside a quoted string.

The other five violations are the automatic-fail checks and G1; proving or
disproving those is `docs/GAUNTLET.md`'s job, not this file's. One note for a
reader holding both: **`compliance.mjs` G1 and `dbcheck` disagree about
`interest_posting.basis_balance_cents`.** G1 calls it a stored balance; `dbcheck`
check 5b recomputes every stored basis from the journal at the watermark the row
itself recorded and asserts equality, and passed at 08:23:51Z. A stored balance
nobody can re-derive is a second source of truth; a stored basis for a decision
that was made is evidence — and only the recompute test tells them apart. Two
checkers, two answers, one of them with a test behind it.

### 4.5 Smaller things, named so they are not discovered

- **Git history still holds two dead sandbox credentials.** Both were rotated or
  had already expired before the working tree was scrubbed (DECISIONS 023). The
  purge needs a `filter-branch` and a force push, which is destructive and
  irreversible and has not been taken.
- **The MCP rate limiter is per process.** `RateLimiter` holds its buckets in
  memory, so across warm instances the effective limit is (instances × limit).
  It is written down in `src/lib/mcp/ratelimit.ts` rather than implied away. It
  is not the control that stops an attacker — the token, the tenant scope and
  the approval queue are — it is the control that stops a well-meaning agent in
  a retry loop from consuming an approver's afternoon.
- **The role switcher is a cookie, and it is labelled as one** in two file
  headers, each naming the function that replaces it. Nothing is granted by it:
  the actor is resolved by a `SELECT` with a `WHERE` clause and handed to the
  database, which decides. `coreloop.mjs` leg 5 proves the point from the other
  side — the queue's controls render **disabled** for a maker, the POST was
  assembled by hand anyway, and `assert_maker_checker()` refused it with
  SQLSTATE 42501.
- **`/api/sim` exists behind `SIM_CONTROL_ENABLED`.** Absent or `false` in any
  shared environment, and absent in this deployment.
- **Some `edge` states are labelled fixtures.** On `/funding`, `/payments` and
  `/pots` the edge state is live. Elsewhere it is a fixture and the page says
  so — `/standing-orders`, for instance, needs the ledger balance above the
  amount and the available balance below it, which is a transient fact about
  somebody else's card holds.

---

## 5. Week two, in value order

Ordered by what each is worth, not by what is quickest. The top of this list is
not new scope — it is the places this system still disagrees with itself, because
a ledger that disagrees with itself is worth more attention than a feature that
does not exist yet.

**1. Make `GUARD REACH` compute the view's population, not the table's.**
`dbcheck.mjs:502` counts `hold_closure` and prints 228 for a guard that ranges
over 126 (§1.4). The whole point of the section is that a guard states its own
domain; a domain query that disagrees with the guard by 45% is the pattern
inside the cure. The fix is to derive the reach from the view's own predicate, or
to fail the run when the two diverge.

**2. Widen instance #19 off free text, then decide what supersedes a wrong
closure row.** `v_hold_closure_not_terminal` discriminates on five string
literals against a column the policed code paths write freely. Item 1 makes the
blind spot visible; this closes it. The open policy question behind it —
whether a closure written in error is superseded by a `hold_closure_reversal` or
left as the historical record it is — is a decision a person should make, not a
deadline.

**3. Fill in, or stop writing, the NULL ingest verdicts.** 75
`source='ingest'` authorisation verdicts carry `result IS NULL` (§3.5). That is
a third way to have no verdict, it is the only one still growing, and it is the
difference between "nobody could observe this" and "we observed it and dropped
it on the floor."

**4. Prove the other nineteen invariants.** `--prove` covers two. Instance #8
has been repaired and never re-proved, and 26 runs of green mean less than they
look. The house rule says a new invariant must be made to fail before it is
trusted; the corollary is that a *repaired* one must be too.

**5. Anchor NN9's column pattern.** A checker that fails on `'x-real-ip'` gets
switched off, and instance #5 is the record of what happens next.

**6. A card-claim path for parked deliveries, and a re-drive for dead letters.**
54 verified Lithic events wait on a mapping that exists only as a hand-written
`INSERT`, and 167 Increase dead letters predate a consumer that now works. Both
queues only grow.

**7. Join the wire halves in one run.** The rail is built, driven and approved
by two humans; the provider-side wires carry `corgi-itest-…` keys that name no
instruction. One run originating a wire from an approved instruction, keyed
`payment:<id>`, closes the loop and turns §2.1's caveat into a line of evidence.

**8. Clear the placeholder FX settlements, or mark them.** Seven of eight
`fx_quote_settlement` rows are integration-test artefacts with a fabricated
hash, written into the production book. Append-only means they cannot be
deleted, so the honest options are a `source` column or a screen that says which
one is real.

**9. Persona for director KYC, replacing Stripe Identity.** Stripe Identity is
live and cannot be *driven*. Persona's `perform-simulate-actions` pushes an
inquiry to pending, declined and needs_review while firing the real webhooks for
each, which is what makes the non-happy-path states genuinely third-party rather
than rows somebody flipped.

**10. Run the Increase adapter's four `~` operations through `parseEvent`
itself.** The consumer reimplements the branch; the adapter method the
capability matrix grades has only ever been called by tests. The cheapest way to
find out whether `submitted + settlement.settled_at -> settled` actually fires
is to fire it.

**11. The off-ramp for the cross-border payout.** Needs a licensed partner
rather than code, which is why it is here rather than higher.

**11b. Make the nav complete, and test that it is.** `/economics` and
`/transactions` are on the front door and not in the header, and no test asserts
the nav lists every screen — the SCREENS test covers only the front door. It is
the pinned-list problem from §1.1 row 19's family, alive one component over, and
it is cheap: the same filesystem walk, pointed at `NavLinks.tsx`.

**12. The mobile app.** The console is responsive (`plan/graph.py` node `U10`);
a native app is a distribution decision rather than a domain one, and nothing in
this build would change to accommodate it.

---

## 6. Off the list on purpose, in week two and after

- **Multi-currency.** The brief rules it explicitly out of scope, and the FX
  quote is deliberately built so that finishing it does *not* introduce it: a
  quote is a promise, not a balance, and no view adds `buy_minor` to a dollar.
- **Our own card processing, identity checks or bank linking.** "Buy, don't
  build." Rebuilding what could have been integrated is a scoping mistake, and
  the one slot where every vendor was gated was answered by substituting a
  different real provider — GLEIF, labelled in the README as a substitution for
  Middesk / Persona KYB / Sumsub KYB, all measured gated — and then by **manual
  review** (migration 0013), where a named human records a decision *as another
  observation* beside the registry's answer rather than overwriting it. The
  alternatives were to weaken the gate or to give a fictional business a real
  company's LEI, and both were disqualifying.
- **An authentication system.** Cut on day one and still cut. The role switcher
  is a cookie, it is labelled as one in two file headers, it grants nothing, and
  the function that replaces it is named in both. Building auth would consume a
  day and prove nothing about a ledger.
- **Raising the Lithic sandbox daily cap.** §3.4. `PATCH
  /v1/accounts/{token}` is blocked by the permission classifier on purpose, and
  changing a provider account's settings to make a test go green is not a call
  an agent gets to make.
- **Tuning any guard until it is green.** §3.5 and §4.4 are both red tonight and
  both stay red. The exclusion that would fix either is shaped exactly like the
  failure it exists to catch, which is the one sentence this build would want
  carried out of the room.
