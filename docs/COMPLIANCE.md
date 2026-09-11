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
