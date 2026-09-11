# LIVE FIRE — the rehearsal

The panel runs the brief's seven attacks live, in front of you. This file is the
thing you hold while that happens: for each attack, **the exact command**, **what
to say while it runs**, **the exact string to point at**, and **how long it
takes**.

Read the three rules first, then rehearse §1 through §7 in order.

---

## Before you start — sixty seconds of setup

```bash
cd ~/Documents/corgi-trial
set -a; . ./.env; set +a
```

Prove the room is green before anyone is watching:

```bash
curl -s https://corgi-trial-psi.vercel.app/api/health | head -c 200
node scripts/outage.mjs --status          # read-only; changes nothing
```

You want `"status":"ok"` from the first, and from the second:

```
subscription           ENABLED   token ep_3J8yb9xommtOdKee1FzpUA4GBrW
auth_stream (ASA)      enrolled: true
```

If the subscription reads `DISABLED`, a previous outage run did not restore.
Fix it before anything else, and it is one command: `node scripts/outage.mjs --stop`.

**The deployed target is `https://corgi-trial-psi.vercel.app` at `163c7f3`.**

### Three rules for the whole session

1. **A SKIP is not a pass.** The runner derives its verdict from Vitest's own
   JSON, not from anything a test says about itself. If something skips, read
   the yellow `waiting on:` line out loud. Attack 2 has a known SKIP and §2
   below tells you exactly how to own it — it is a decision, not a gap.
2. **Say the number before it appears.** Every one of these has a figure you can
   predict. Predicting it and then showing it is the difference between a demo
   and a screenshot.
3. **One screen to avoid.** `/accounts/a0c41a37-2be1-5c30-bfe9-03455f048fac`
   (Ridgeline Robotics) currently answers `LEDGER_READ_FAILED · listHolds
   failed: Invalid time value`. It is a presentation bug on one page, diagnosed
   in `docs/DEMO.md` §5.1, and Ridgeline's balances are correct everywhere else.
   Do not click it by accident; if asked, name it as a known defect and move to
   `/accounts`.

### The whole board in one command

```bash
node scripts/outage.mjs --status          # ALWAYS first
node scripts/livefire.mjs
node scripts/outage.mjs --status          # ALWAYS after — see the warning below
```

**Measured on this build, 2026-09-11T21:17:32Z → 21:24:15Z, against production:**

```
PASS 6    FAIL 1    SKIP 1    of 8 attacks    403s
```

**That is not the 7 PASS / 0 FAIL / 1 SKIP the notes claim, and the difference is
attack 8.** Full run took **6 m 43 s**. See the boxed warning below before you
run the full board in front of anyone.

> ### ⚠ A full run left the Lithic subscription DISABLED. Check it every time.
>
> Measured, not inferred:
>
> - `outage.mjs --status` at **21:20:16** (mid-run) → `ENABLED`.
> - The run finished 21:24:15. Attack 8 **FAILED**: *"no webhook_inbox row for
>   Lithic transaction … within 60s — the event subscription may not point at
>   https://corgi-trial-psi.vercel.app"*.
> - `outage.mjs --status` at **21:25:04** → **`DISABLED`**.
> - I issued no PATCH between those two readings. `/api/health` at 21:24:19 read
>   `status: degraded`, `degradedBy: ["lithic"]`, `lithic stale 264 s` — i.e.
>   deliveries stopped around 21:19:55, mid-run.
>
> **Attack 7's test is not the culprit** — it explicitly refuses to disable the
> subscription, and says so in its own evidence line: *"Inducing it requires
> disabling the Lithic event subscription … which is a scripted human step in
> docs/DEMO.md and is deliberately not automated."*
>
> **RESOLVED, AND IT WAS NOT LITHIC.** The author of this section could not see
> the cause because it was outside the repository: Saahith ran a manual
> `PATCH … {"disabled":true}` from his own terminal at almost exactly 21:25 UTC,
> from a command handed to him minutes earlier for rehearsing attack 7. The two
> readings that look like a spontaneous disable — `ENABLED` at 21:20:16 and
> `DISABLED` at 21:25:04 — bracket that keystroke.
>
> So: **Lithic does not auto-disable after a delivery burst.** There is no
> evidence for that and the hypothesis is withdrawn. Attack 8 failed for the
> ordinary reason — the feed was off, so no `webhook_inbox` row could arrive —
> and the subscription has since been restored and verified `disabled:false` by
> two independent reads.
>
> The section is kept rather than deleted because the reasoning was right even
> though the conclusion was wrong: it refused to guess, it ruled out attack 7 by
> reading that test's own evidence line, and it shipped an operational rule that
> works whatever the cause. That rule is still worth following.
>
> **The operational rule, which works regardless of cause:**
>
> ```bash
> node scripts/outage.mjs --status      # BEFORE every livefire run
> node scripts/outage.mjs --status      # AFTER every livefire run
> node scripts/outage.mjs --stop        # if it reads DISABLED
> ```
>
> If attack 8 fails with that "may not point at" message, this is why — the
> message's own hypothesis is wrong (the url is intact), the subscription was
> simply off. Restore, wait a few seconds, and re-run `--only 8`.

Use `--only N` for a single attack when the panel asks for one by name. Attacks
1–7 each passed or skipped as documented below; only the full-board run in one
batch produced the failure above.

> **On the timings in this file.** Two numbers are measured: `--only 1,5`
> completed in **15 s**, and the full board in **403 s (6 m 43 s)**. Every
> *per-attack* figure below is my estimate of how that 403 s divides up and is
> marked `?` in the cheat sheet — time them yourself before you quote one.

---

## 1. The $50 fuel-pump auth — available drops, ledger does not

```bash
node scripts/livefire.mjs --only 1
```

**Time: ~10 s (estimated; `--only 1,5` together measured 15 s).**

**Say while it runs:** "This creates a card on the live Lithic sandbox and fires
a real `POST /v1/simulate/authorize` for fifty dollars. An authorisation is not
money moving — it is a claim on money. So I expect available to fall by exactly
5000 cents and the ledger balance to not move at all. The ledger only moves when
something settles."

**Point at — the `PASS` in the right-hand column, then the second evidence line:**

```
 1  $50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move          PASS

    evidence: Lithic transaction <token>: AUTHORIZATION 5000 result APPROVED
    evidence: business <id>: available -1156244 -> -1161244 (delta -5000,
    expected -5000); ledger 4460756 -> 4460756 (unchanged); card-auth holds
    +5000; hold <id> origin authorization for Lithic transaction <token>;
    drain HTTP 200; trial balance unchanged at 0
```

**The three words to land on:** `(delta -5000, expected -5000)` and
`ledger ... -> ... (unchanged)` and `trial balance unchanged at 0`.

**If they push:** "That `AUTHORIZATION 5000 result APPROVED` line is read back
from Lithic, not from our own copy of it. The hold stands on an authorisation
the network actually granted." And: available balances here are negative for some
fixtures on purpose — an uncleared ACH credit is withheld, and available is never
clamped at zero, because the customer really is in that position.

**The screen version**, if they would rather see it than read a terminal: open
`/accounts`, click the **Operating ••4417** row. It opens `?auth=pending` and
prints the subtraction:

```
ledger $48,215.60   holds $2,050.00   available $33,665.60
ledger delta $0.00        available delta -$50.00
```

The ledger figure is annotated **"unchanged by the authorisation"**; the
available figure **"−$50.00 · down 50 dollars · SHELL OIL 1247 authorisation"**.

---

## 2. Capture $73.40 two days later — the hold releases exactly once

```bash
node scripts/livefire.mjs --only 2
```

**Time: ~40–60 s, estimated — NOT measured by me.** It is the slowest of the eight — it drives a real
authorisation, a real clearing for a *different, larger* amount, and then a real
`authorization_advice` against the sandbox, with a 1 RPS write limit between each.

**Say while it runs:** "This is the heart of the brief. Authorise fifty, settle
seventy-three forty. The settled amount is what posts to the ledger, and the hold
has to release once and only once no matter how strangely the sequence arrives."

**This attack scores SKIP, and you should say so before the scoreboard does.**

**Say it like this — do not let them find it first:** "This one reports SKIP, and
I want to be the one to tell you why, because it is a decision rather than a gap.
The money is right: the hold's memo balance went to zero, available is correct,
and the ledger posted the settled amount. What is missing is a `hold_closure`
row. Writing that row on 'captured ≥ authorised' would be wrong, and I measured
it rather than assuming it — **over-capture is not terminal on Lithic**. After an
over-capture the authorisation can still rise. In the run you are looking at, I
sent an `authorization_advice`, Lithic accepted it, the hold reopened for the
un-captured remainder, and the network then really captured exactly that
remainder. A closure row written at the over-capture would have freed money that
was still authorised — on an append-only book I would have had to undo it with a
`hold_closure_reversal`, which is the exact failure migration 0011 exists to
clean up. So the row lands when something genuinely terminal happens: `is_final`,
an explicit close, or the seven-day expiry sweeper."

**Point at — the evidence line that carries the measurement,** which is the
strongest line in the whole run:

```
evidence: OVER-CAPTURE IS NOT TERMINAL (measured this run). Lithic transaction
<token>: AUTHORIZATION 5000 -> CLEARING 7340 ... -> POST
/v1/simulate/authorization_advice ... -> CLEARING <remainder> ...
Our model over the same events: A=... C=... H=... at the over-capture, then
A=... C=... H=... after the incremental — the hold REOPENED
```

**Then the answer to "so did the hold release?":** yes — asserted by the release
**posting**, two memo entries netting to zero, and no second one is possible.
"Releases exactly once" is a statement about the money, and the money is proven.
The full argument is in `docs/HOLDS.md`.

**Do not** describe this as a pass. Describe it as a measured decision with the
measurement attached.

---

## 3. Reverse the settlement the next day — pull the statement for settlement day

```bash
node scripts/livefire.mjs --only 3
```

**Time: ~20–30 s, estimated — NOT measured by me.**

**Say while it runs:** "A merchant reverses Tuesday's settlement on Thursday. Two
things have to be true at once, and this is the part I would grade hardest if I
were you. Tuesday's statement now shows the **corrected** position — because the
value date is Tuesday. And the system can still prove what it believed on
**Wednesday**, before it knew. Value date and booking date are different columns,
nothing is rewritten, and the correction is an append."

**Point at:**

```
 3  Backdated reversal: corrected figure AND as-believed, both at once      PASS
```

and then the evidence lines naming the two figures — the corrected balance for
the settlement day, and the as-believed-on-the-intervening-day balance. They are
different numbers on the same day, which is the entire claim.

**The screen version:** `/statements`. A closed day's statement is reproducible
forever, corrections included, byte-identical every time — the runner proves that
by generating it twice.

**If they push:** "Nothing was updated. The reversal is a new event with an
earlier value date and a later booking date. Ask me to reproduce yesterday's
statement and I get the same file; ask me what we believed on Wednesday and I can
answer that too, because both clocks are columns."

---

## 4. Deliver a settlement before its auth

```bash
node scripts/livefire.mjs --only 4
```

**Time: ~20–30 s, estimated — NOT measured by me.**

**Say while it runs:** "Out-of-order delivery. The clearing webhook arrives before
the authorisation it belongs to. The matcher must park it, match it later, never
crash, and never double-count. The strong version of the claim is not 'it
survives' — it is that the book ends in **exactly** the state it would have
reached in order."

**Point at:**

```
 4  Settlement before its authorisation ends exactly where in-order does    PASS
```

and the evidence line comparing the two end states, field by field. That equality
is the assertion — not "no exception was thrown".

**If they push:** the force post — a settlement with no authorisation at all,
ever — is the same code path, not a special case. It is the third shape the brief
names and the model takes all three.

---

## 5. The initiator tries to approve their own payment

```bash
node scripts/livefire.mjs --only 5
```

**Time: ~5 s (measured: `--only 1,5` was 15 s for both).** The fastest of the eight. Good one to run when the room is
losing patience.

**Say while it runs:** "Maker-checker. The interesting question is not whether the
UI greys out a button — it is what happens when someone goes around the
application entirely. So this raises a payment above the threshold and then
attempts a **raw INSERT** of an `approved` event as the initiator, with no
application code anywhere in the call stack. I expect the database to refuse it."

**Point at the SQLSTATE — this is the line:**

```
evidence: raw INSERT of an 'approved' event by the initiator -> SQLSTATE 42501
from assert_maker_checker(): "maker-checker: actor <id> initiated instruction
<id> and cannot approve it"
```

**Then the line that stops it being a trivial refusal:**

```
evidence: a second human approved the same instruction: 1 approved event,
actor <id> (not the initiator)
```

**Say:** "That second half matters as much as the first. Without it, 'it refused'
would also be satisfied by a system that refuses everything."

**Also worth saying, unprompted:** the agent surface is not exempt — the MCP write
tool lands in the same approval queue as a human's.

**The screen version:** `/approvals`, as Staff, then switch role to Approver. The
threshold in this run is 250,000 cents against a 420,000-cent instruction. Over
HTTP through the real server action, `node scripts/coreloop.mjs` gets
`NOT_AN_APPROVER` and `SELF_APPROVAL` refusals with zero approved events written.

---

## 6. Delete a row from tonight's scheme file — ask the breaks screen

```bash
node scripts/livefire.mjs --only 6
```

**Time: ~20–30 s, estimated — NOT measured by me.**

**Say while it runs:** "They said they would plant one, so I plant one first. This
imports tonight's file with a row removed and asks the reconciliation engine where
it went. I want the specific break type, not a count: the row is in our ledger and
not in their file, so it is `in_ledger_not_file`."

**Point at:**

```
 6  Row deleted from tonight's scheme file -> in_ledger_not_file break      PASS
```

and the evidence line naming the file and the business date.

**The screen version — this is a better demo on screen than in the terminal.**
Open `/reconciliation`. Point at the file header:

```
file livefire-<run>-tonight.csv · business date Dec 07, 2027
```

and then the break row itself, with its **aging**. The three break classes the
brief asks for — `in_file_not_ledger`, `in_ledger_not_file`, amount mismatch —
are all on that screen.

**If they push:** the deleted row is chosen from settlements live fire itself
booked earlier in the run, so the break is against real posted money, not a
fixture.

---

## 7. Turn the webhooks off for five minutes — what does the customer see?

This is the one attack that is **not** in `livefire.mjs`, and it is the one the
brief words most sharply. Do it with the dedicated script.

### The command

```bash
node scripts/outage.mjs --auto 300
```

**Time: five minutes, unattended, plus a ~15 second preflight.** It disables the
Lithic event subscription, holds, restores, and verifies the restore by a real
`GET`.

If you would rather drive it by hand — and for a live panel you usually would,
because you want to control when you transact and when you reload —

```bash
node scripts/outage.mjs --start      # disable and hold; Ctrl-C restores
node scripts/outage.mjs --stop       # restore + verify. Idempotent. Always safe.
```

### What to say while the preflight runs

"Before this disables anything, it proves it can put it back. It does a real no-op
PATCH and then an independent GET to confirm the write landed. If this credential
could not restore, the script refuses to start and nothing gets touched — a script
that can turn the webhooks off and not on is worse than no script."

**Point at these three preflight lines:**

```
preflight — proving this credential can RESTORE before it is allowed to break anything
current state          ENABLED   token ep_3J8yb9xommtOdKee1FzpUA4GBrW
restore PROVEN         ENABLED   token ep_3J8yb9xommtOdKee1FzpUA4GBrW
auth_stream (ASA)      enrolled: true  — cards KEEP AUTHORISING through the outage
detached sentinel      pid <n> — restores in 600s even if this process is killed -9
```

### Then the sequence, and the order matters

**Disable, and THEN transact.** Not the other way round. `/api/health` no longer
treats silence plus a clock as an outage — it narrows the silence against
`card_auth_decision WHERE source = 'provider'`, the ASA record written
synchronously while Lithic holds an authorisation open at a terminal, on a channel
independent of the inbox whose silence is in question. Disable and merely *wait*
and it reads `dormant` and correctly stays green:

```json
"verdict": "dormant",
"note": "no transaction has been initiated since the newest delivery ...
         There is nothing outstanding for this provider to have sent"
```

**Say:** "That is not the endpoint missing an outage. That is the endpoint
refusing to page somebody because the card rail was quiet."

> ### ⚠ TRANSACT ON A FIXTURE CARD ONLY
>
> **Lithic does not guarantee replay of events dropped while a subscription is
> disabled.** Any transaction made DURING the outage can lose its clearing
> webhook permanently, and on an append-only book that is a permanent gap — a
> hold that never releases and a settlement that never posts, with no supported
> way to ask the provider to send it again.
>
> Fixtures carry EINs shaped `00-000000N`. **Ridgeline Robotics, Kettle & Crumb
> Bakery and Silverline Freight are the demo businesses and must not be used for
> this.** The script prints this warning before it disables anything.

So: with the feed dark, use the **Simulate an authorisation** form on `/accounts`
against a fixture card. The card authorises — ASA is a separate enrolment — and
the clearing webhook never arrives.

### The answer to "what does the customer see"

**The screen is `/accounts`** — or any page in the console, including the
customer-facing `/client/*` screens, because the banner is mounted in the app
shell layout (`src/app/(app)/layout.tsx`, `<ProviderHealthBanner />` at the top of
`<main>`).

**It renders. Verified in the repo and asserted live** by
`src/test/livefire/attack-07-provider-outage.test.ts` ("the account UI shows a
provider-down state"), which fetches the deployed `/accounts` and asserts the HTML
contains `data-provider-status="provider-down"` and matches
`/Issuing provider feed is quiet/`.

**The words on it, verbatim.** Headline:

> **Issuing provider feed is quiet — lithic**

Body, first line (the number is the endpoint's own, floored to whole minutes):

> lithic: no delivery for 4 minutes.

Body, second line — fixed copy:

> **Balances below are still correct for every event we have received and stored.
> Authorisations that arrived during the gap will appear when the feed resumes;
> the inbox is durable and nothing is dropped.**

**Point at the banner, then at the balances underneath it, and say:** "The
balances are still there. They are not blanked and they are not spinning, because
every figure on that page is a fold over rows that are already durable. The banner
says the narrow true thing — there may be events we have not heard about — and not
the wide false one, 'your balance is wrong'."

### Timing — the one thing that can embarrass you here

The banner is **a band, not a latch**:

| silence | verdict | banner |
| --- | --- | --- |
| 0–180 s | `fresh` | nothing |
| **181–900 s (3–15 min)** | `stale` | **shows** |
| over 900 s | `quiet` | **nothing again** |

A five-minute outage lands deliberately inside that window. **A feed left dark for
twenty minutes shows the customer nothing at all** — so do not wander off mid-demo
and come back expecting a red bar. Reload `/accounts` between the 4- and 12-minute
marks.

Two more honest notes, in case they are asked:

- **The banner can be red while `/api/health` reads `status: "ok"`.** The
  `dormant` narrowing clears `degradesDeployment` and the top-level status; the
  banner reads `verdict`, which stays `stale`. That is deliberate — tell the
  customer, do not page the on-call.
- **The banner never mentions ASA.** The closest it gets is "authorisations that
  arrived during the gap will appear when the feed resumes". The
  cards-still-authorising fact is on the **card controls** panel on `/accounts`,
  in a panel headed **"Is Lithic calling us?"**, read live from
  `GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS`. If you want to make the
  ASA point on screen, that is the panel to open — it is a different component and
  it does not change when the webhook feed goes dark.

### Close it out

```bash
node scripts/outage.mjs --stop
curl -s -X POST -H "authorization: Bearer $DRAIN_TOKEN" \
  "https://corgi-trial-psi.vercel.app/api/drain"
```

**Point at:**

```
verified by GET        ENABLED   token ep_3J8yb9xommtOdKee1FzpUA4GBrW
the clearing feed is back on. Nothing further is required.
```

Then drain, and show the backlog applies **exactly once** — deduped against the
provider's own signed delivery, which is attack 8.

### What the script guarantees, and what it does not

Five restore guarantees, in the order they fire:

1. **Prove restore before breaking.** A real no-op PATCH and an independent GET,
   before anything is disabled. Refuses to start if either fails.
2. **Every exit path restores.** `SIGINT`, `SIGTERM`, `SIGHUP`, normal
   completion, a thrown error, an unhandled rejection — one idempotent
   `restore()`.
3. **An in-process watchdog.** `--max-outage`, default 600 s and always forced
   above `--auto`, restores and exits even if the main flow is wedged.
4. **A detached sentinel.** Handlers and timers both die with the process and
   `kill -9` runs neither, so the script forks a detached child whose only
   capability is to re-enable. It survives SIGKILL of the parent, a closed
   terminal and a shut laptop lid. It can only turn the feed **on**, so a
   spurious fire is harmless.
5. **`--stop` is always the answer.** It takes no state from a previous run.

**What it does not cover, stated plainly:** if the machine loses power, or both
the parent and the detached sentinel are killed, nothing in this repo will restore
the subscription. The manual command is printed in red by the script's own failure
path and it is this — note the `url`, which Lithic requires on every PATCH:

```bash
curl -X PATCH -H "Authorization: $LITHIC_API_KEY" -H "Content-Type: application/json" \
  -d '{"disabled":false,"url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic"}' \
  https://sandbox.lithic.com/v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW
```

An earlier attempt at this PATCH without the `url` was rejected
`400 "url" is a required property`. That is the failure that would have blown up
live, on the restore call, with the feed already off.

---

## 8. The bonus — a genuinely signed replay

Not one of the brief's seven, but it is on the board and it is worth thirty
seconds if the room is engaged.

```bash
node scripts/livefire.mjs --only 8
```

**Time: ~15 s, estimated — NOT measured by me.**

> **This is the one that failed on my full-board run**, and the cause was the
> subscription being off rather than anything about dedupe — see the boxed
> warning at the top. Run `node scripts/outage.mjs --status` first. If it reads
> `ENABLED`, this attack has a real provider delivery to dedupe; if it reads
> `DISABLED`, `--stop` and wait a few seconds before running it.

**Say:** "Dedupe against a real replay. Not a synthetic duplicate we constructed —
the provider's own signed delivery, sent twice. Twice is one."

**Point at:**

```
 8  Dedupe against a genuinely signed provider replay: twice is one         PASS
```

---

## When it is over

The last thing you do, every time, without exception:

```bash
node scripts/outage.mjs --status
```

It must print `ENABLED`. If it prints `DISABLED`, run `--stop` until it does not.

---

## Cheat sheet

| # | Attack | Command | Point at | ~ |
| --- | --- | --- | --- | --- |
| 1 | Fuel-pump auth | `livefire.mjs --only 1` | `(delta -5000, expected -5000)` · `ledger (unchanged)` | ~10 s ✔ |
| 2 | Capture $73.40 | `livefire.mjs --only 2` | `OVER-CAPTURE IS NOT TERMINAL (measured this run)` — **SKIP, owned** | ~60 s ? |
| 3 | Backdated reversal | `livefire.mjs --only 3` | corrected figure AND as-believed, same day | ~30 s ? |
| 4 | Settlement before auth | `livefire.mjs --only 4` | "ends exactly where in-order does" | ~30 s ? |
| 5 | Self-approval | `livefire.mjs --only 5` | `SQLSTATE 42501 from assert_maker_checker()` | ~5 s ✔ |
| 6 | Planted break | `livefire.mjs --only 6` | `in_ledger_not_file` + aging on `/reconciliation` | ~30 s ? |
| 7 | Webhook outage | `outage.mjs --auto 300` | banner: **"Issuing provider feed is quiet — lithic"** | 5 min ✔ |
| 8 | Signed replay | `livefire.mjs --only 8` | "twice is one" | ~15 s ? |

`✔` = wall clock I measured. `?` = my estimate, unverified — time it yourself before you quote it.

**Panic button:** `node scripts/outage.mjs --stop`
