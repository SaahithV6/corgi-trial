# COMPLIANCE — the flapping label, and what `scripts/compliance.mjs` has left

`node scripts/compliance.mjs` is the mechanical reading of the trial rules.
This file is the argued reading of its output: what the one non-reproducible
verdict actually was, why the fix is the fix and not one of the three
alternatives, and — for everything still red or still UNKNOWN — whether it is
unknowable in principle or merely unmeasured, and who can close it.

---

## 1. The bug: `open_banking` flapped `live` → `simulated` → `live`

### What was reported

`scripts/compliance.mjs` AF2 samples `/api/health` three times seconds apart
and fails if any slot changes its mind. Roughly one run in three it failed on
`open_banking`, while `POST /institutions/get` answered 200 in 17-34ms eight
times consecutively when called by hand. A label that is not reproducible is
not honest labelling, and this endpoint is the one the README defers to.

### What it actually was — measured, not reasoned

Three hypotheses. Two were killed by measurement; one was confirmed twice.

**Probe timeout — REJECTED.** `TIMEOUT_MS` is 4,000ms. The readings that
flipped came back in **13-39ms**. Two orders of magnitude inside the budget, so
nothing was aborting. (One real observation belongs here anyway: while
throttling is *about* to bite, Plaid starts holding responses for ~3.1-3.2s —
the slowest response seen in any run was 3,199ms, and it was a 200. That is
inside the 4s budget but not by much, and it is a latent second failure mode
worth knowing about.)

**Cold start — REJECTED.** The flip tracks the *number of health calls*, not
the age of the function instance. The eleventh reading in a burst flips whether
it lands on a warm instance or a freshly woken one, and a burst that stops at
ten never flips at all.

**Rate limiting — CONFIRMED.** Plaid rations `/institutions/get` per
`client_id`. Measured directly against the sandbox on 2026-09-11:

```
A +0s  200  449ms                         <- the window had just refilled
B +4s  call#2  200          B +21s call#7  200
B +5s  call#3  200          B +22s call#8  200
B +8s  call#4  200          B +25s call#9  200
B +12s call#5  200          B +29s call#10 200
B +16s call#6  200          B +33s call#11 429 INSTITUTIONS_GET_LIMIT
QUOTA: 10 successful calls after reset
```

`error_code: INSTITUTIONS_GET_LIMIT`, `error_type: RATE_LIMIT_EXCEEDED`.
**Ten calls per credential per window, 429 on the eleventh.**

And then reproduced end to end against the deployment — fourteen consecutive
`GET /api/health`, reading only `open_banking`:

```
 1 simulated unreachable  39ms  POST /institutions/get -> 429
 2 live      live        730ms  POST /institutions/get -> 200
 3..11 live  live      18-29ms  POST /institutions/get -> 200
12 simulated unreachable  16ms  POST /institutions/get -> 429
13 simulated unreachable  16ms  POST /institutions/get -> 429
14 simulated unreachable  13ms  POST /institutions/get -> 429
```

Ten `live`, then the ration ran out. That is the flap, on demand.

### Why it surfaced now, and why "one run in three"

The probe spent **one unit of a ten-unit budget per health request**. A single
compliance run reads `/api/health` at least four times by itself (the banner
reading, AF2's two stability samples, NN1's direct GET), `audit-claims.mjs`
reads it again inside AF2, and the budget is per *credential* — so a script on
a laptop, an uptime monitor and the deployed function all draw on the same ten.
The eleventh reading was routine, not exotic. Whether a given run crossed the
line depended on what else had touched Plaid in the preceding minute, which is
exactly the shape of "roughly one run in three".

The recent narrowing of `fromStatus()` did not cause this and was correct: 429
used to return `live`, which published the self-refuting evidence string
`POST /institutions/get -> 429` beside a LIVE label. That narrowing converted a
silent wrong answer into a visible flapping one. **That is a strict improvement
and the flap is the bug it exposed, not a bug it introduced.**

---

## 2. The fix, and the three alternatives it beat

Four options were on the table. The measurement decides between them.

| Option | Verdict |
| --- | --- |
| **A short retry inside the probe** | **Rejected — it makes it worse.** The window is measured in tens of seconds, not milliseconds; a retry inside the function's 15s budget would 429 again *and spend another unit of the ration*, keeping the bucket empty for longer. Retrying is the behaviour that caused this. |
| **A longer budget for this slot** | **Rejected — it treats a symptom nobody has.** The failing calls answered in 13-39ms. Nothing timed out. A bigger budget changes nothing about a 429. |
| **Report a distinct verdict for throttling** | **Adopted, but not sufficient alone.** `rate_limited` is honest and it is the right word — 429 is a fact about how often *we* asked, not about the credential, which Plaid never even evaluated. But on its own the label still oscillates LIVE ↔ SIMULATED across readings, which is the original complaint. |
| **Cache the last verdict with an explicit age** | **Adopted as the core of the fix.** It is the only option that makes the label reproducible *without* claiming anything that was not earned, and it fixes the cause — the polling rate — rather than the symptom. |

### What now happens, precisely

`src/lib/integrations/verdict-cache.ts` remembers the last verdict **a provider
actually pronounced** — `live` (it accepted the credential) or `unauthorised`
(it rejected it) — with the instant it was pronounced.
`src/lib/integrations/probe.ts` applies a per-slot ration policy:

```
open_banking: refresh every 20s, stop quoting after 5 minutes
              "Plaid allows 10 /institutions/get per credential per window"
```

1. **Inside 20s of the last round trip** the slot is not probed at all. The
   earned verdict is reported with `fresh: false`, `provenAt`, `ageSeconds`,
   and an evidence string that says it is a quotation and how old it is.
2. **Past 20s**, one real round trip fires.
3. **If that round trip reaches no verdict** — 429, or the network failed — the
   last earned verdict is still reported, with its age and with the reason this
   reading reached nothing. We do not downgrade a slot on evidence we do not
   have.
4. **And we back off.** The 20s interval counts from the last *attempt*, not
   the last success, so a throttled window is not answered by hammering the
   provider that is throttling us. (This was a regression in the first cut of
   this fix and it was caught by measurement: polling an already-empty bucket
   spent thirteen further units of the ration in forty seconds.)
5. **Past 5 minutes with nothing earned**, quoting stops. The slot reports
   `rate_limited` — `SIMULATED`, with `INSTITUTIONS_GET_LIMIT` in the evidence.
   That is the endpoint admitting it has not been able to check, which is the
   one answer that must never be smoothed away.

### Why this is not "making it always say `live`"

That was the explicit trap, so here is the case, point by point.

* **Only verdicts a provider pronounced are ever remembered.** `unreachable`,
  `rate_limited`, `not_configured` and `unprobed` are absences of a verdict and
  are never written to the cache, so no absence can be replayed as a claim.
* **The cache is symmetric.** `unauthorised` is quoted exactly as readily as
  `live`. A cache that quoted through a throttled window only when the news was
  good would be an instrument for producing green; `verdict-cache.test.ts`
  pins this.
* **Every quotation is dated, in machine-readable fields**, not only in prose:
  `fresh: false`, `provenAt`, `ageSeconds`. A reader is never asked to take a
  dated fact for a present-tense one.
* **There is a cliff.** Five unbroken minutes with no verdict and the slot goes
  SIMULATED. Measured, cold cache, bucket emptied from outside the process, six
  consecutive readings:

  ```
  status=simulated liveness=rate_limited fresh=null age=null
    POST /institutions/get -> 429 INSTITUTIONS_GET_LIMIT — Plaid rationed this
    reading; the credential was never evaluated [no verdict earned within the
    last 300s, so nothing is claimed for this slot]
  ```

  Reproducible, and reproducibly *not* live. The verdict is still earned by a
  round trip; what changed is that the endpoint now says *which* round trip.
* **A revoked credential is caught within 20 seconds**, because the refresh
  cadence is 20 seconds — not within five minutes. Five minutes is the bound on
  quoting only when Plaid is refusing to answer at all.

### Why only Plaid

`RATIONED` has exactly one entry. Every other slot still round-trips on every
reading. Quoting is a concession bought by a *measured* ration, not a default:
applied to `card_issuing` or `card_webhooks` it would put a delay between a
Lithic outage and this endpoint admitting to it, and
`attack-07-provider-outage` exists to say that delay is unacceptable. A slot
joins that table when someone measures a ration on it, and the measurement goes
in the comment beside it.

### One alternative that was measured and *not* taken

`POST /link/token/create` — the call the funding flow actually makes — has far
more headroom: **22 consecutive calls, zero 429s, no latency creep**, against
`/institutions/get`'s ten. Probing the endpoint the application depends on is
also the principle `business_registry` already follows ("the probe must ask the
provider the APPLICATION uses"). It was rejected for two reasons. It *creates a
provider object* on every health check, and `/api/health` is polled; and a
bigger bucket only moves the cliff rather than removing it — the label would
still be one busy afternoon away from flapping, and the cadence fix is what
makes it reproducible at any bucket size. It remains the right change if Plaid
ever tightens `/institutions/get` further.

### Also fixed, while in here

* `ageSeconds` was published as `-1` for every unrationed slot, because the
  round trip that earns a fresh verdict finishes *after* the reading starts. A
  one-second lie in the field whose entire job is to stop small lies. Clamped.
* `delivery-health.test.ts` proved its "the delivery vocabulary shares no word
  with the liveness vocabulary" invariant against a **hand-copied list that had
  already drifted** — it was missing `unprobed`. It is now pinned to the
  `Liveness` union at compile time, so adding a verdict and forgetting that
  file fails `pnpm typecheck` instead of silently narrowing the guard.

### The ten consecutive readings

Against the production build, ten `GET /api/health` in a row, `open_banking`
only:

```
 1 live  fresh=true  age=0s  POST /institutions/get -> 200
 2 live  fresh=false age=0s  ... [quoted, not re-probed: earned 0s ago]
 3 live  fresh=false age=1s  ... [quoted, not re-probed: earned 1s ago]
 4 live  fresh=false age=1s  ... [quoted, not re-probed: earned 1s ago]
 5 live  fresh=false age=1s  ... [quoted, not re-probed: earned 1s ago]
 6 live  fresh=false age=2s  ... [quoted, not re-probed: earned 2s ago]
 7 live  fresh=false age=2s  ... [quoted, not re-probed: earned 2s ago]
 8 live  fresh=false age=3s  ... [quoted, not re-probed: earned 3s ago]
 9 live  fresh=false age=3s  ... [quoted, not re-probed: earned 3s ago]
10 live  fresh=false age=3s  ... [quoted, not re-probed: earned 3s ago]
```

Ten identical verdicts, one Plaid call. And under attack — the bucket emptied
from outside the process, then polled every 2s for a minute — nineteen readings
held `live` on three round trips, with the evidence naming the throttle and the
back-off each time.

---

## 3. What is left, and who can close it

Scoreboard against the deployment, `node scripts/compliance.mjs`:

```
PASS 28   FAIL 2   WARN 0   UNKNOWN 4   CITED 7   of 41 checks
```

The three items the previous run flagged — the two committed secrets, the float
in `probe.ts`, and migration 0018's append-only trigger — now pass. **AF2 still
fails against the deployed URL because the deployment is still running the
pre-fix code**; against a build with the fix in it, AF2 passes, including its
delegation to `audit-claims.mjs` (exit 0, "no document contradicts the
endpoint"). Deploying moves the scoreboard to **PASS 29 · FAIL 1**.

### FAIL — AF5, and it is outside this workstream

`"Secrets committed to the repo." — GIT HISTORY, not just the tip`. Three
file/shape pairs are alive in history across all refs:

| Where | Shape | Commits |
| --- | --- | --- |
| `src/lib/cards/asa.test.ts` | `whsec_[A-Za-z0-9+/]{20,}` | 12 — `f97af3e`, `8443e7b`, `2217231`, `e468356`, `9a76568`, … |
| `src/lib/rails/plaid/client.test.ts` | `access-(sandbox\|development\|production)-…` | 11 — `e468356`, `d6154f7`, `38d8667`, `2310fd7`, `6038184`, … |
| `docs/EVALUATION.md` | `access-(sandbox\|development\|production)-…` | 2 — `467f460`, `c551b9f` |

Three things are true and all three matter:

1. **At the tip, all three are fixtures.** `asa.test.ts` builds its secret as
   `whsec_${base64("fixture-only-never-a-real-secret")}`; `client.test.ts` uses
   the literal `'access-sandbox-x'`; `EVALUATION.md` says
   `access-sandbox-REDACTED-ROTATED`.
2. **AF5's other assertion passes**: "no current `.env` secret value appears in
   any commit (17 values pickaxed with `git log -S`)".
3. **It is still a FAIL**, and correctly so. The rule is about the repo, and
   the repo includes its history. DECISIONS 023's own rule — rotate before
   cleaning — applies to what is in those older commits.

**This is not fixable by editing a file, and it is outside this workstream's
write scope in both directions**: the paths belong to other modules, and the
remedy is history surgery. `SETUP.local.md` already carries the exact
remediation, which is two commands (drop `refs/original`, expire the reflog and
`gc --prune=now`) followed by a force-push. Routing this rather than touching
it.

### UNKNOWN ×4 — unknowable in principle, or merely unmeasured?

**AF6 — "code you cannot explain line by line". Unknowable in principle.**
Whether a human can answer when a grader points at a line is a property of the
debrief, not of the repo, and no static check can stand in for it. The tool
says so and refuses to fake it, which is the correct behaviour; the mechanisable
subset it does assert is a proxy for explainability, not a substitute. This one
should stay UNKNOWN for ever.

**SP2 — graders invited on GitHub. Merely unmeasured, and now measured.** The
check says "collaborator invitations are GitHub account state, not repo
content". True of the *file tree*, but the GitHub REST API answers it in one
call, and it does:

```
$ gh api repos/SaahithV6/corgi-trial/invitations
mojafa             read  2026-09-10T00:32:41Z
AlexanderReinicke  read  2026-09-10T00:32:41Z
$ gh api repos/SaahithV6/corgi-trial/collaborators
SaahithV6  (admin)
```

**Both graders hold pending read invitations, sent 2026-09-10T00:32:41Z**, on a
repo that is `PRIVATE`. So the fact is now established — pending, not accepted,
which is the expected state until they click. To make the *tool* measure it,
SP2 needs to shell to `gh api repos/<slug>/invitations` and
`…/collaborators`, assert both logins appear in the union, and report UNKNOWN
with the reason when `gh` is absent or unauthenticated (the check must not turn
a missing CLI into a pass). `scripts/compliance.mjs` is outside this
workstream's write scope, so this is a routed suggestion, not a change.

**SP4 — the five-minute video. Merely unmeasured, and cheap to fix.** The check
reasons that the link belongs in the submission email rather than the repo.
That is true of where it is *sent*, but nothing stops the repo from also
holding it: one line in `docs/DEMO.md` with the unlisted URL makes SP4 a
`fetch` of that URL asserting a 200 and a `video/*`-ish response — and it
would catch the classic failure of a Loom link that is private or has expired.
What stays unmeasurable is "under five minutes" without downloading and probing
the media, and the honest form of that is a WARN naming the duration if the
provider's oEmbed endpoint gives one. Both `docs/DEMO.md` and the script are
outside this write scope.

**SP5 — evidence of the live integrations. Half unmeasured, half unknowable.**
Whether a shared folder or read-only dashboard access has actually been granted
to two people at Corgi is account state in three third-party consoles, and no
API this repo holds credentials for can observe another party's access —
unknowable from here. What *is* measurable, and currently is not: that
`docs/EVIDENCE-PACK.md` contains a resolvable link per live slot, and that the
webhook delivery log it cites is non-empty in `webhook_inbox` for each provider
claimed live. That turns "somebody says the evidence exists" into "the evidence
is reachable", which is most of the value.

### Not a pass, and not a failure: CITED ×7

The seven live-fire scenarios are cited to `scripts/livefire.mjs`, not run,
because they drive production and the provider sandboxes and take minutes.
CITED is not PASS and the scoreboard says so. Run them before the debrief.

---

## 4. Rules this file was written under

* Never claim a capability not proven by a real call. Every number above is a
  measurement with its output pasted, including the ones that killed two of my
  own hypotheses and one of my own first attempts at the fix.
* A check that cannot be performed reports UNKNOWN with a reason, never PASS.
  That is why `rate_limited` exists as a verdict at all, and why the five-minute
  cliff is in the code.
* `/api/health` is the authority, and no verdict was weakened to make a check
  pass. The `open_banking` label is still earned by a round trip; the endpoint
  now publishes *which* round trip, and how long ago.

---

## 5. The guard audit — instances 16, 17 and 18 of 22

> **NUMBERING RECONCILED 2026-09-11T09:58Z.** These three were numbered
> *sixteen, seventeen and eighteen* when this section was written, and **they
> keep those numbers** — the canonical list in `docs/DEBRIEF.md` §1 now runs to
> **22** and rows 16, 17 and 18 are §5.1, §5.4 and §5.5 below, unchanged. Two
> other documents were counting differently and are corrected rather than this
> one: `DECISIONS.md` 056 said its three brought the count "to nineteen" when
> they are 19, 20 and 21, and `docs/EVALUATION.md` called `card_auth_event`'s
> missing `result` column "the fifteenth guard" where it is 13. The arithmetic
> is in `DECISIONS.md` 058.

Written 2026-09-11T05:40Z after three measurements that reported healthy while
the thing they measured was broken. All three are the same shape, which this
log had by then recorded sixteen times and has now recorded **twenty-two**:
**the exclusion was built in the shape of the failure.** Everything below is a measurement with its output, taken against
the production database and the deployed endpoint.

### 5.1 `v_refused_auth_hold` — the guard could not see its own failure

0026 created it to catch "a hold withholding money against an authorisation the
network refused", and it reached, correctly, outside the fold to what Lithic
actually said. Then it wrote the reach as an **INNER JOIN** to
`card_auth_event_result` plus `AND r.result IS NOT NULL`. Those are the two
ways this schema spells *we have no verdict*, and losing the verdict is the bug
0026 exists to catch — before 0026 the outcome was discarded at ingest. The
guard excluded, by construction, exactly the state the bug produces.

Measured before the repair:

| | |
|---|---|
| authorisation-kind events on holds withholding money | **130** |
| of those, carrying no verdict — invisible to the guard | **98 (75%)** |
| holds affected | **86** |
| money withheld behind a missing verdict | **$5,665.60** |
| rows the guard reported | **0** |

`v_hold_drift` and `v_hold_release_drift` were empty throughout and were both
telling the truth: two derivations of the same impoverished input agree
perfectly, and that agreement is all a drift view measures.

**Repaired in `db/migrations/0032_guard_repairs.sql`** — a LEFT JOIN with
`r.result IS DISTINCT FROM 'APPROVED'`, and a `verdict` column separating
`refused` from `unanswered`. The burden of proof was backwards: the old
predicate made the database prove a refusal before it would report withheld
money, and an authorisation holding a customer's money with no recorded outcome
is an unanswered question, not a pass.

### 5.2 What the repaired guard found on its first run: the bug is live again

Not history. Of the 47 card events ingested since 0026 committed at 04:32Z,
**not one had a verdict row**, and **22 of them were authorisations Lithic
DECLINED** — stored under `kind = 'authorization'`, which feeds A(E). Not one
row in the whole of `card_auth_event` carries the `declined` kind 0026 added.

**The ingest write path in this repository is correct; the host serving
Lithic's deliveries is running a build that predates 0026.** The two are
distinguished by measurement, not by reading the code:

* the repository's path has written **18 `source = 'ingest'` verdict rows** into
  this same database, from the 16 deliveries it handled at 05:04–05:06Z — so
  the code works when it runs;
* in the same window, deliveries carrying `result: "DECLINED"` produced
  `kind = 'authorization'` rows with **no verdict row at all**. 0026's code
  cannot produce that state: it maps a refused step to `declined`, and if it
  somehow did not, the `card_auth_event_result_agrees_with_kind` trigger would
  refuse the INSERT and park the delivery. Those deliveries are `state = 'done'`;
* `/api/health` on the deployment reports `commit.sha 4c682e1d…`.

Two code versions are writing to one database and the one Lithic posts to is
the old one. **Nothing in this system compares the deployed commit to the
repository**, which is why forty minutes of re-run bug went unnoticed by an
endpoint that publishes the commit sha on every request.

0032 recovered every verdict that was retained in `webhook_inbox` and never
read, then repaired the money the same way 0026 did — a `hold_closure` and a
reversal **at the original value date**, appended, never edited:

```
NOTICE: 0032: repaired 12 hold(s) with 12 reversal entr(ies); 60000 cents returned to customers
NOTICE: 0032: every PROVEN refusal is repaired; v_hold_drift and v_hold_release_drift are empty
NOTICE: 0032: 74 hold(s) remain UNANSWERED, withholding 506560 cents ...
```

$600.00 back, of which **$300.00 was Kettle & Crumb Bakery's** money.

### 5.3 The red that is the correct answer

> **As measured at 05:40Z, and left as measured.** `dbcheck` has since grown
> from fifteen invariant views to twenty-two and gained a second deliberate red.
> **Re-measured 2026-09-11T09:40Z it reads 36 passed, 2 failed**, and
> `v_refused_auth_hold` is **154 rows / 130 holds / $9,786.20**, all
> `unanswered` — the population grows because the book keeps running, and the
> exclusion is still refused. §5.9 carries the second red.

`pnpm db:check` was **30 passed, 1 failed** at 05:40Z, and the failure was
`v_refused_auth_hold`:

```
FAIL  v_refused_auth_hold is empty — 86 row(s) — no hold withholds money against
      an authorisation not recorded as APPROVED
      unanswered    74 hold(s),   86 event(s), $5,065.60 withheld  <- no verdict was
      ever observed for these events. NOT repairable by inventing one; see 0032.
```

Those 74 holds are pre-0026 events ingested by direct `applyCardTransaction()`
calls that carried no `inbox_id` and left no payload behind — the hold fuzzer,
the integration fixtures, the seed. 0026 recorded them honestly as
`source = 'not_retained'`: we looked, and there is nothing to read.

They are **not excluded**, and the temptation to exclude them is precisely the
defect this section is about. `not_retained` is written only by a migration and
is CHECK-constrained to carry no verdict, so an exclusion would be *safe* —
and it would still be an exclusion shaped like the failure, in a guard whose
entire history is that exact mistake. A guard tuned until it is green is a
green tick nobody earned.

CI is unaffected: `.github/workflows/ci.yml` runs typecheck, lint and unit
tests, and touches no database. `scripts/compliance.mjs` AF3 spawns `dbcheck`
and asserts exit 0, so **AF3 will report this failure**, correctly, until the
verdicts exist.

### 5.4 `/api/health` read a dead rail as maximally fresh

Webhook freshness was `MAX(webhook_inbox.received_at)`. A rail that **receives
everything and processes nothing** is therefore maximally fresh. Measured at
05:20Z:

| | |
|---|---|
| Increase deliveries accepted, verified, then dead-lettered | **179** |
| stated reason | `no consumer registered for provider 'increase'` |
| newest, relative to the reading | **4 minutes old** |
| what `/api/health` reported | **`increase: fresh`** |

It was not lying about what it measured. It was measuring arrival, and arrival
is not health — a delivery sitting unconsumed is the opposite of health.

**`src/app/api/health/processing.ts`** adds the honest signal: the most recent
delivery this system actually **consumed** (`MAX(processed_at)` where
`state = 'done'`), plus the depth, age and stated reason of what is parked and
what has been dead-lettered. A third vocabulary — `consuming` / `backlogged` /
`dropping` / `never_consumed` / `idle` / `unmeasured` — disjoint from both the
liveness and the freshness vocabularies, asserted by a test and pinned to
`Liveness` by the compiler, so `live` + `fresh` + `dropping` reads as three
answers to three questions rather than a contradiction.

`dropping` and `never_consumed` degrade the deployment **without** the four
conditions `delivery-health.ts` requires for silence, and the asymmetry is the
argument: silence is an absence of evidence and is indistinguishable from
nobody using a feed, while a dead letter is a delivery we accepted, verified,
retried to exhaustion and abandoned. Gating loss on `gatesDeploymentStatus`
would disarm the alarm with the flag that exists to stop a quiet KYC feed
crying wolf — the same blind spot, one module further along.

Measured against the live database through the endpoint itself:

```
status: degraded
degradedBy (freshness):  []
degradedBy (processing): ["increase"]
  lithic    backlogged   consumed 05:33:58Z  parked 52  dead 23
  increase  dropping     consumed 05:17:41Z  parked  0  dead 66   no consumer registered
  plaid     consuming    consumed 04:17:08Z  parked  0  dead  0
  persona   idle         consumed —          parked  0  dead  0
  stripe    consuming    consumed 04:19:00Z  parked  0  dead  0
```

**`probe.ts` was deliberately not changed.** The `ach_rail` probe proves the
Increase credential works outbound, and it does — that verdict is true and was
never the problem. Teaching a liveness probe about inbound consumption would
put a second opinion about liveness inside the endpoint DECISIONS 021 fixed for
having exactly that. One opinion per question; this was a missing question, not
a wrong answer.

### 5.5 `scripts/coreloop.mjs` picked the business that proved the least

The subject ranking read `kyb_evidence` out of `v_business_kyb` and then never
used it, so among the businesses the deployed gate ALLOWS the tiebreak fell to
`legs_on_file` and then to `localeCompare` — and the alphabet chose **"Hold
Fuzzer Fixture Co."**, approved on both legs by `simulated-hold-fuzzer`, to
demonstrate leg 1's *"real KYB check"*.

Evidence is now a ranking term ahead of the alphabet: the gate's answer, then
the rolled evidence tier (`live > manual > simulated`, the enum's own order and
the one `v_business_kyb` already rolls with `max()`), then how many legs stand
on a live third-party answer, then legs on file, then the name. Measured
against the deployed gate:

```
ALLOWED KYB_ALLOWED  Ridgeline Robotics, Inc.      evidence manual    live legs 1
                     registry operator-review / director stripe-identity   <- default subject
ALLOWED KYB_ALLOWED  Kettle & Crumb Bakery LLC     evidence manual    live legs 0
ALLOWED KYB_ALLOWED  Hold Fuzzer Fixture Co.       evidence simulated live legs 0
```

The header now names the provider behind each leg rather than only the strength
of the weakest one, and a run whose best available evidence is `simulated` says
so in yellow on its own face.

**The claim "core loop passes 7/7 on a second business" was unsupported**, and
the reason was structural: the script had no business selector at all, so there
was no argument that could make it carry a different subject. `--business <uuid
| name substring>` and `--list-subjects` now exist. The flag overrides the
ranking and **nothing else** — every candidate is still pressed against the
deployed `/onboarding` gate first, and a name matching nothing is a hard exit
rather than a silent fall back to the ranked subject.

Proven by a real run, not by the flag existing:

```
node scripts/coreloop.mjs --business Kettle --only 1
  1  PASS  KYB gate: an unverified business REFUSED with its code, a verified one allowed
     10/10 checks · 3.0s · 74 HTTP calls to https://corgi-trial-psi.vercel.app
```

**7/7 on a second business is still unproven** and must not be claimed. Leg 1
is proven on two businesses; the remaining six legs drive Lithic, Plaid and the
approval queue and take minutes, and nobody has run them end to end on a second
subject. The honest statement is the one this file makes: the claim is now
*makeable* by running one command, and it has not been run.

### 5.6 Every other guard, and the two that are not what they look like

`scripts/dbcheck.mjs` gained two sections that make this audit re-runnable
instead of a paragraph:

* **GUARD REACH** — the population each invariant ranges over. A guard whose
  predicate is sound but whose population is empty is green because there is
  nothing to be green about, which is not a failure and is not the evidence the
  tick looks like either. It prints, and it does not touch the tally.
* **`--prove`** — the house rule executed rather than asserted. 0023 and 0024
  made their views fail on purpose before trusting them; 0026 and 0028 wrote
  the rule down and left the demonstration as prose, which is how a guard that
  could not fail shipped with a paragraph explaining why it could. Measured,
  each in a transaction that rolled back, with nothing left behind:

```
PASS  v_refused_auth_hold(refused) CAN fail — 0 -> 1 after a DECLINED verdict on a live hold's authorisation
PASS  v_refused_auth_hold(unanswered) CAN fail — 86 -> 87 after an authorisation event with NO verdict recorded
PASS  ingest cannot file a refusal as an authorisation — card_auth_event … was refused by the network (DECLINED)
PASS  v_wire_availability_drift CAN fail — 0 -> 1 after a wire credit spendable an hour after it was booked
```

**`v_wire_availability_drift` (0025) was never wired into `dbcheck` at all.**
0025 created it under the heading "the proof that availability is immediate, as
a view that must be empty" and nothing ever queried it — the fifth invariant in
this build to pass through that state, after 0022's, 0026's and 0028's. It now
runs on every `pnpm db:check` and is empty over a population of 10 wire-credit
holds.

It was listed in a second array, `UNMIRRORED_INVARIANT_VIEWS`, because
`src/lib/chaos/invariants.test.ts` parses the `INVARIANT_VIEWS` literal out of
`dbcheck.mjs` and asserts the chaos dashboard lists exactly the same views in
the same order — a right test that would have gone red on a one-sided edit, and
`src/lib/chaos/**` was outside this change's remit. **Closed. Verified
2026-09-11T09:56Z: there is no second array in `scripts/dbcheck.mjs` at all, and
`INVARIANT_VIEWS` in `scripts/dbcheck.mjs` and in
`src/lib/chaos/invariants.ts` are the same 22 views in the same order.** The
mirroring test is what holds them that way.

#### `v_hold_closure_not_terminal` discriminated on free text — REPAIRED by 0040

**This section is kept as written and then answered, because the fix it asked
for is the one that shipped.** What it said, at the time:

> The view's population is
>
> ```sql
> WHERE hc.reason = ANY (ARRAY[
>   'authorisation closed or expired by the network', 'final capture received',
>   'authorisation expiry reached', 'authorisation fully reversed',
>   'authorisation expired unused'])
> ```
>
> — five string literals matched against a free-text `reason` column written by
> the very code paths the guard exists to police. The intent is right: it
> separates a **posting-path** closure (a bug, if the fold still says the
> authorisation is open) from an **operator** closure (legitimate — 0011: "the
> operator overrides the model"). The mechanism is a string.
>
> The fix is the one `card_auth_event_result.source` already models: give
> `hold_closure` a `source` column, CHECK-constrained, written at every call
> site, and filter the view on that. It is not done here because `hold_closure`
> is append-only — an added column is NULL on all existing rows for ever.

By the time `db/migrations/0040_hold_closure_source.sql` was written the book
had grown: **228 closures, of which the reason list could see 126. 102 rows —
45% — were outside the invariant by construction**, and migration 0032's own
twelve closures were among them, excluded by the *wording* of their message
rather than by anyone's intent.

**The objection above was wrong, and that is the interesting part.** "An added
column is NULL on all existing rows for ever" assumes the only way to fill one
is `UPDATE`, which `hold_closure_no_update_delete` refuses — to the owner as
well as to `corgi_app`, which is exactly its job (0001 §13). But `ALTER TABLE`
is DDL, and `ALTER COLUMN ... TYPE ... USING <expr>` is the one form of DDL
whose expression may read the row's own columns. So the backfill is a type
change that keeps the type:

```sql
ALTER TABLE hold_closure ADD COLUMN source text;            -- all NULL, DDL
ALTER TABLE hold_closure ALTER COLUMN source TYPE text
  USING (CASE ... END);                                     -- classified, DDL
```

No `UPDATE` is executed, no trigger is disabled, and `UPDATE hold_closure SET
source = source` in the very next statement is still refused with 55006 —
verified in a rolled-back transaction before the migration was written.
`hold_id`, `reason`, `actor_id` and `closed_at` come out of the rewrite
bit-identical: this classifies history, it does not rewrite it.

**The set of values is derived from the code, not invented** — every `INSERT
INTO hold_closure` in the repository, and then every call site of the two
functions that contain them: `posting_path` (`holds/apply.ts`),
`expiry_sweep` (`holds/expiry.ts`), `availability_sweep`
(`rails/plaid/adapter.ts`), `wire_availability` (`rails/wire/ledger.ts`),
`dispute` (`disputes/store.ts`), `repair` (migrations 0026 and 0032),
`test_harness` (`holds.integration.test.ts` case 7b) and `operator`, which has
no writer today and is in the CHECK because 0011 §3 and 0028 both reason about
one. The backfill attributed **228 of 228** rows; the `ELSE NULL` arm matched
none, and the migration refuses to apply if a `card_auth` closure is left
unattributed.

The view now filters `source IN ('posting_path','expiry_sweep')` — the two
writers that claim *the hold model's terminal predicate* licensed a permanent
row, which is the only thing the invariant asserts.

**Why the other 102 are out, with the numbers:**

| source | rows | in the guard | carries the guard's defect shape |
|---|---|---|---|
| `posting_path` | 56 | **yes** | 0 |
| `expiry_sweep` | 70 | **yes** | 0 |
| `repair` | 52 | no | **52 — $2,551.00** |
| `test_harness` | 15 | no | **4 — $132.00** |
| `dispute` | 23 | no | n/a (no card authorisation) |
| `wire_availability` | 12 | no | n/a (no card authorisation) |
| `operator`, `availability_sweep` | 0 | — | — |

The `repair` line is the one that has to be argued. All 52 of those closures
stand over authorisations the fold still calls OPEN and they are *right* to:
0026 and 0032 closed holds whose network verdict was `DECLINED` and whose
verdict never reached `card_auth_event`, so the fold's **input** is what is
wrong. Had `repair` been admitted, this view would have reported 52 rows on the
day it shipped, every one of them correct. The guard that owns that population
is `v_refused_auth_hold`, which reads the provider's verdict rather than the
fold, and which is red on exactly that evidence.

**The `test_harness` line is a finding, and it is printed rather than filed.**
Four closures written by an early version of `holds.integration.test.ts` case 7b
— before that test grew the `expiry.expireOne()` tidy-up it now ends with —
stand over $33.00 authorisations the fold still calls open, memo book already at
zero. No guard on this build could see them: `v_hold_drift` is `WHERE NOT
is_released`, `v_hold_release_drift` needs a non-zero memo balance, and
`v_hold_closure_not_terminal` did not admit their wording. They are outside the
repaired guard too, because the model's terminal predicate never licensed them
— a test fabricated them to simulate a crash.

So the repair is not only the column. `v_hold_closure_census`, and the
`GUARD REACH` section that prints it, carries a `defect_shape` column: rows the
guard does **not** range over that carry its shape anyway. *Outside the guard*
is a legitimate answer. *Outside the guard and therefore nobody looked* is the
failure this build keeps rediscovering, and that column is the difference.

**And the rule that keeps it honest is enforced in the gate, not in a trigger.**
A card-auth closure written without a `source` would be NULL, fall outside the
view, and reproduce 0028's defect in a new field — so `dbcheck` carries
"every card-auth closure declares its writer" as a pass/fail check. A BEFORE
INSERT trigger was written and worked (23514 on an undeclared card-auth closure,
an undeclared uncleared-credit closure allowed, `source = 'nonsense'` refused by
the CHECK) and is deliberately **not** in the migration: a migration lands the
instant it runs while the deployed build is whatever was last pushed, and §5.2
of this file is about that gap lasting eight hours. In that window the trigger
would refuse a *correct* closure written by a deployed `apply.ts` that cannot
know about a column which did not exist when it was built, and a customer's card
hold would sit on their money until the deploy caught up. Refusing a correct
write to enforce a label on it is the wrong trade; turning CI red on the first
offending row is the same rule collected a few minutes later.

#### The rest: every one of them made to fail, on purpose

**This table used to be an argument. It is now a measurement.** It read "can it
fail? — yes", with a sentence of reasoning beside each view, for nineteen views
of which exactly two had ever been watched doing it. Three of those sentences
had already turned out to be wrong somewhere else in this file. Reasoning about
whether a guard *can* fail is how `v_standing_order_double_fire` spent days
being quoted as proof while being unsatisfiable.

`node scripts/dbcheck.mjs --prove` now builds the violating state for **every
invariant view on the list**, inside a transaction that is rolled back, asserts
the count moves, and then re-reads the view outside the transaction to assert
the rollback left nothing. Coverage is *computed*, not claimed: the driver walks
the same arrays the gate checks, and a view with no proof registered is a named
FAILURE on the next run.

```
--prove covered 22 of 22 invariant views
(24 proofs, 8 of them needing a trigger disabled on the owner connection)
```

| view | delta | how it was made to fail |
|---|---|---|
| `v_entry_unbalanced` | 0 → 1 | one extra line appended to a balanced entry |
| `v_line_denorm_drift` | 0 → 1 | a line dated a day ahead of its entry (+1/−1, so the entry still balances and only the clock drifts) |
| `v_book_not_zero` | 0 → 1 | one unbalanced line takes an entity's whole book off zero |
| `v_deposit_control_drift` | 0 → 1 | customer money booked to the HOUSE `2100` root, inside the control total and outside every customer's balance |
| `v_hold_drift` | 0 → 1 | an incremental authorisation the memo book was never told about |
| `v_hold_release_drift` | 0 → 1 | an operator closure over a hold still carrying memo money |
| `v_hold_closure_not_terminal` | 0 → 1 | a `posting_path` closure over an authorisation the fold calls open |
| `v_hold_closure_not_terminal` | 0 → **0** | *the same row declared `repair`* — 0 is the pass, and it is the `source` column working in the negative direction |
| `v_hold_expiry_drift` | 9 → 10 | a hold and its authorisation given expiry instants one second apart |
| `v_balance_definition_drift` | 0 → 1 | a card hold whose own clock ran out while the authorisation's has not — the same asymmetry, turned into money |
| `v_refused_auth_hold` (refused) | 0 → 1 | a `DECLINED` verdict on a live hold's authorisation |
| `v_refused_auth_hold` (unanswered) | 154 → 155 *(re-read 09:41Z; it was 149 → 150 at 05:40Z — the population grows with the book, and the claim is the delta of exactly one, not the base)* | an authorisation event with no verdict at all — the one 0026's body could not express |
| `v_wire_availability_drift` | 0 → 1 | a wire credit spendable an hour after it was booked |
| `v_accrual_month_drift` | 0 → 1 | **a whole February built first** — this guard's population is empty, so the month had to be created before it could be broken |
| `v_accrual_ledger_drift` | 0 → 1 | an accrual day posted against an entry belonging to a different day |
| `v_interest_ledger_drift` | 0 → 1 | an interest posting citing another day's entry |
| `v_interest_rate_drift` | 0 → 4 | a rate row backdated behind `interest_rate_policy_forward_only` |
| `v_standing_order_double_fire` | 0 → 1 | **a second instruction for one occurrence under a different spelling of the derived key — see §5.8** |
| `v_dispute_ledger_double_count` | 0 → 2 | two dispute events of different kinds citing one entry; the delta is one row per LINE of that entry |
| `v_approved_auth_for_dead_member` | 0 → 1 | an approval recorded against a member version that says `removed` |
| `v_member_approval_without_right` | 0 → 1 | an approval filed by a member whose role at the time was `viewer` |
| `v_interchange_unreversed` | 0 → 1 | the network takes a settlement back and the interchange is left standing |
| `v_interchange_drift` | 0 → 1 | the same reversal, asked what the interchange is now *worth* |
| `v_interchange_rate_drift` | 0 → 77 | one backdated rate row re-prices every settlement in that category |

**Where a trigger had to be disabled, the output says so, and that is evidence
rather than an apology.** Eight of the twenty-four proofs run on the OWNER
connection because `corgi_app` cannot disable a trigger at all — which is layer
1 holding, not a limitation being routed around. A view whose violating state
cannot be written through the product is a view standing *behind* a constraint
that already refuses the bug, and the pair is worth printing:

| view | triggers that had to be switched off | what that proves |
|---|---|---|
| `v_accrual_month_drift`, `v_accrual_ledger_drift` | `accrual_posting_lifecycle` | the lifecycle trigger derives `accrual:<schedule>:<date>` itself and refuses a posting that cites an entry it did not key |
| `v_interest_ledger_drift` | `interest_posting_lifecycle` | same, for interest |
| `v_interest_rate_drift`, `v_interchange_rate_drift` | the two `*_forward_only` triggers | a backdated re-rate is unwritable through the product; the view is what would see it if it ever were |
| `v_dispute_ledger_double_count` | `dispute_event_lifecycle` | a dispute cannot re-enter a state it has already passed |
| `v_approved_auth_for_dead_member` | `team_member_version_chain` | the *removed-member version* is the hard part: 0033's version chain refuses one appended out of band |
| `v_member_approval_without_right` | `payment_instruction_event_maker_checker` **and** `payment_instruction_event_team` | **two** triggers, which is the finding: 0001's maker-checker and 0033's team check COMPOSE rather than overlap |

`v_entry_unbalanced` is the mirror image and is printed too: its violating state
*is* writable, because `journal_line_balanced` is `DEFERRABLE INITIALLY
DEFERRED` and fires at COMMIT. The proof forces the check early with
`SET CONSTRAINTS journal_line_balanced IMMEDIATE` and records the refusal beside
the delta, so both halves are on the record — the constraint refuses the commit,
and the view would see the state if the constraint ever failed to.

**No view on this list turned out to be structurally incapable of returning a
row.** `v_accrual_month_drift` came closest and is a different thing: its
predicate is sound and its *population* is empty (zero complete accrual months
on this book), which `GUARD REACH` has always printed as `EMPTY … green because
there is nothing to be green about`. The proof builds the population before
breaking it, which is the only way to tell the two apart.

### 5.7 The one this audit could not close

`scripts/audit-claims.mjs` enforces that no document contradicts `/api/health`,
and `/api/health` means **the deployed one**. 5.2 established that the deployed
build predates the repository. So the authority every document is checked
against is currently a build nobody in this repository is looking at, and the
check cannot see that: it compares documents to the endpoint and never compares
the endpoint to the tree.

The cheap fix is mechanical — `/api/health` already publishes
`commit.sha`; compare it to `HEAD` and report `stale-deployment` when they
differ. It is not done here because `scripts/audit-claims.mjs` was outside this
change's remit. Until it is, "the deployed endpoint is the authority" carries an
unstated second clause: *and nothing checks that the authority is current.*
### 5.8 `v_standing_order_double_fire` has now been watched failing

0012 shipped it joining `payment_instruction` on a **UNIQUE** column and asking
for `count(DISTINCT pi.id) > 1` — unsatisfiable, `WHERE false` with extra steps
— and its emptiness was quoted as proof in a test, in a document and in
`compliance.mjs`. 0023 repaired the body by pointing it at the mandate's
*keyspace* rather than at one derived key.

Between 0023 and now, **nobody had seen the repaired body return a row.** It has
now, against this database, in a transaction that was rolled back:

```
before                                  0 rows
INSERT a second payment_instruction on the SAME occurrence, under a
different spelling of the derived key:
  standing:6d27bdba-…:2026-09-11                     (the real one)
  standing:6d27bdba-…:2026-9-11#retry-after-a-restart (the plant)
after                                   1 row, instructions = 2
after ROLLBACK                          0 rows
```

The row names both keys in `instruction_keys`, which is the whole point: the
UNIQUE index on `idempotency_key` is perfectly satisfied by that pair, so the
constraint the old body leaned on is exactly the one that cannot see this. It is
`node scripts/dbcheck.mjs --prove` from now on, on every run.

### 5.9 `v_hold_expiry_drift` — the second deliberate red

A card hold's expiry is stored **twice**: `hold.expires_at`, which
`ledger_availability()` reads, and `card_authorization.expires_at`, which
`v_card_auth_hold` reads. `ensureAuthorization()` writes one value into both, so
they are *meant* to be identical — but that is a convention inside one function.
No foreign key, no CHECK, and until migration 0040 no view that would say
anything if they diverged.

**Nine holds on this database already disagree, by 135–158 milliseconds**, all
of them fixtures that bypassed `ensureAuthorization()` and ran two separate
`now() + interval '7 days'` statements. **Exposure today is zero cents:** all
nine are closed, released and withholding nothing.

The view is therefore **non-empty on arrival, and that is correct**.
`WHERE external_ref NOT LIKE 'lithic:team-test-%'` would make it green and would
still be an exclusion shaped like the failure — the sentence §5.3 already
records about the other deliberate red. `dbcheck` now reads **36 passed, 2
failed**, and both failures are the honest kind.

It is not hypothetical. `--prove` turns the same asymmetry into money against a
different guard: a card hold whose own clock has run out while its
authorisation's has not is dropped by `ledger_availability()` and kept by
`v_hold_state`, so the customer's available balance and the hold model disagree
about the same dollars — `v_balance_definition_drift` 0 → 1.

**One thing this could not close.** `v_hold_expiry_drift` runs from a second
array in `scripts/dbcheck.mjs`, not from `INVARIANT_VIEWS`, because
`src/lib/chaos/invariants.test.ts` asserts that list equals the chaos
dashboard's copy in `src/lib/chaos/invariants.ts`, and `src/lib/chaos/**` was
outside this change's write scope. Appending to the first array without the
mirroring edit turns `pnpm test` red for someone who cannot fix it. It is
checked, it counts towards the same tally and `--prove` proves it like every
other view; what is missing is the chaos dashboard counting it. Four views now
sit in that position (`v_interchange_*` and this one) and they should be moved
into `INVARIANT_VIEWS` and mirrored in one commit by whoever owns that
directory.

