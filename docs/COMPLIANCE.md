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

## 5. The guard audit — sixteen, seventeen and eighteen

Written 2026-09-11T05:40Z after three measurements that reported healthy while
the thing they measured was broken. All three are the same shape, which this
log has now recorded sixteen times: **the exclusion was built in the shape of
the failure.** Everything below is a measurement with its output, taken against
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

`pnpm db:check` is **30 passed, 1 failed**, and the failure is
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

It is listed in a second array, `UNMIRRORED_INVARIANT_VIEWS`, and that needs a
follow-up by whoever owns `src/lib/chaos/**`:
`src/lib/chaos/invariants.test.ts` parses the `INVARIANT_VIEWS` literal out of
`dbcheck.mjs` and asserts the chaos dashboard lists exactly the same views in
the same order. That test is right. Adding the wire view to the mirrored array
without the matching edit in `src/lib/chaos/invariants.ts` — outside this
change's remit — would turn the suite red. **So the chaos dashboard currently
checks 15 invariants where `dbcheck` checks 16**, and the fix is a two-line
addition to `src/lib/chaos/invariants.ts`.

#### `v_hold_closure_not_terminal` discriminates on free text

The one finding that is not yet repaired, and the one most likely to become the
nineteenth instance. The view's population is

```sql
WHERE hc.reason = ANY (ARRAY[
  'authorisation closed or expired by the network', 'final capture received',
  'authorisation expiry reached', 'authorisation fully reversed',
  'authorisation expired unused'])
```

— five string literals matched against a free-text `reason` column written by
the very code paths the guard exists to police. The intent is right: it
separates a **posting-path** closure (a bug, if the fold still says the
authorisation is open) from an **operator** closure (legitimate — 0011: "the
operator overrides the model"). The mechanism is a string.

Measured over 184 closures on card authorisations:

| | |
|---|---|
| closures inside the reason list — the guard's whole population | **90** |
| closures outside it, invisible by construction | **64 (35%)** |
| rows the view would report if the reason filter were dropped | **56** |

All 56 are legitimate operator closures today — disputes, the wire availability
sweep, the chaos driver's `simulated crash before release`, and the refusal
repairs 0026 and 0032 wrote. The guard is correct right now. It is correct **by
the wording of a sentence**: 0032's own closures landed outside the list by the
accident of how their message reads, not by any declared intent, and a
posting-path closure reworded by one character leaves the guard's population
silently and for ever.

The fix is the one `card_auth_event_result.source` already models: give
`hold_closure` a `source` column (`posting_path` / `operator` / `migration`),
CHECK-constrained, written at every call site, and filter the view on that. It
is not done here because `hold_closure` is append-only — an added column is
NULL on all 184 existing rows for ever, and "NULL means we do not know which
path wrote this" is the same unanswered state 5.1 is about. It wants the same
treatment: a new column, a backfill from what can be proven, `NULL` where it
cannot, and a guard that reports the NULLs rather than excluding them.

#### The rest, checked and clear

| guard | can it fail? | evidence |
|---|---|---|
| `v_entry_unbalanced`, `v_line_denorm_drift`, `v_book_not_zero` | yes | plain aggregates over 2,700+ entries |
| `v_hold_drift` / `v_hold_release_drift` | yes | complementary predicates (`NOT is_released` / `is_released`) cover every hold between them — 0011's blind spot is closed |
| `v_deposit_control_drift` | yes | subtree sum vs reported sum, no exclusions |
| `v_accrual_ledger_drift`, `v_interest_ledger_drift`, `v_interest_rate_drift` | yes | made to fail by 0024, over 34 and 25 posted days |
| `v_accrual_month_drift` | **vacuous today** | `WHERE month_complete` over **0 complete accrual months**. The predicate is sound; there is nothing in its population. Reported by GUARD REACH, not counted as a failure |
| `v_standing_order_double_fire` | yes | 0023 repointed it at the mandate keyspace; 22 occurrences in reach |
| `v_dispute_ledger_double_count` | yes | the `UNION` in `v_dispute_ledger` de-duplicates on four columns, so two dispute events citing one entry under different kinds survive it and collide on `(dispute_id, entry_id, ordinal)` — 150 lines in reach |
| `v_balance_definition_drift` | yes | two independent bodies compared at one instant, 7 accounts in reach |
| `v_refused_auth_hold` | yes, **now** | `--prove`, both verdicts, above |
| `v_hold_closure_not_terminal` | yes, over 49% of its subject | see above |
| `v_wire_availability_drift` | yes | `--prove`, above |

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
