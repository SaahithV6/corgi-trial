# Independent evaluation — Corgi work trial, Track 3 (Neobank)

Evaluator: independent, adversarial, forbidden from fixing anything it found.
Evaluated **2026-09-11 04:49Z → 05:05Z** against deployed commit **`4c682e1`**
(`/api/health` → `commit.shortSha`, read 05:04:11.989Z).
Repo: `/home/lain_iwakura/Documents/corgi-trial` · Live: https://corgi-trial-psi.vercel.app

**Source of truth.** Scored against `docs/TRIAL-VERBATIM.md` and `docs/BRIEF.md`, read in
full before anything else was run. Where any other document in the repo disagrees with
those two, the other document is wrong and the disagreement is recorded as a finding.

**Method constraints, stated so they can be discounted.** I was instructed not to run git
commands, so every statement about git history below is quoted from `scripts/compliance.mjs`,
which does run them — it is the repo's own tool auditing itself, and I flag it as such.
I wrote no source file, script, migration or config. Every defect below is reported and
left in place.

**Concurrency caveat, and it matters.** Twelve-plus agents were writing this tree while I
read it. `scripts/dbcheck.mjs` changed **between two of my own runs** (mtime
`21:52:27 -0700`; 13 invariant views at 21:49, 15 at 21:57). Every figure below carries the
time it was taken, and every red result is attributed to either in-flight work or the
deployed build. Nothing is averaged into a mood.

---

## SUPERSEDED IN PART — re-measured 2026-09-11 between 09:38Z and 10:02Z

**Nothing below this banner has been edited. This report is a dated record of
what was true at 04:49Z–05:05Z against commit `4c682e1`, and rewriting its
measurements would destroy the only thing that makes it worth reading.** What
follows is what a re-run of its own commands now says, so a grader is not led by
a figure that has since moved. Where the two disagree, the re-run is right.

| What this report says | What it reads now | Taken at |
| --- | --- | --- |
| `dbcheck` **30 passed, 0 failed** (15 views) | **36 passed, 2 failed** (22 views); both failures are deliberate standing reds — `v_refused_auth_hold` 154 rows, all `unanswered`, $9,786.20 withheld, and `v_hold_expiry_drift` 9 rows, all released, **zero cents of exposure**. **36 passed, 4 failed at 10:07Z**: `v_advice_delta_unsound` (1 row) and `v_hold_closure_unexplained` (4 rows) arrived red from migrations 0042/0043 while this sweep ran; not diagnosed here. | 09:40Z / 10:07Z |
| — *(prove-mode did not exist)* | `dbcheck --prove` covers **22 of 22 invariant views, 24 proofs**, 8 needing a trigger disabled on the owner connection. **No view turned out structurally incapable of returning a row.** | 09:41Z |
| the deployment *"receives ACH webhooks and **drops all 179 of them**"* | **zero** Increase deliveries are dead-lettered; 124 `done`, 119 `parked`, and no row anywhere carries *"no consumer registered"* | 09:47Z |
| `/api/health` `status: ok`, 7 of 7 live, commit `4c682e1` | `status: "ok"`, 7 of 7 live, database 149 ms, commit **`544b481`** — and `degraded` at 09:59:12Z on commit **`2c13805`**, which is live fire's own Lithic quiet band (`webhookHealth.degradedBy: ["lithic"]`, 538 s inside a 180–900 s window), not the dead-letter backlog (`webhookProcessing.degradedBy: []`). **The deployment moved during this re-run.** | 09:38:36Z / 09:59:12Z |
| `livefire` **6 PASS / 2 FAIL / 0 SKIP** | **7 PASS / 0 FAIL / 1 SKIP** of 8, 334 s — attacks 3 and 7 both now pass every assertion; attack 2 skips | 09:43–09:49Z |
| `coreloop` **7 PASS / 0 FAIL / 0 SKIP** | **6 PASS / 1 FAIL / 0 SKIP** of 7 legs, 84 s. Leg 4 fails: *"holds moved $0.00, expected $50.00"*. The subject also changed to Ridgeline Robotics after DECISIONS 057 made KYB evidence a ranking term. | 09:49–09:50Z |
| `compliance.mjs` **PASS 28 · FAIL 2** | **PASS 25 · FAIL 5 · UNKNOWN 4 · CITED 7** of 41 — AF1, AF2, AF3, AF5, G1 | 09:51Z |
| `audit-claims.mjs` exit 0 | **exit 1, 7 contradictions** — every one a false positive of a regex that reads any *"N of 7"*, matching coreloop's seven legs and the rail matrix's seven adapters. No slot on `/api/health` is simulated. | 09:39Z |

**Three corrections to this report's own findings**, each named where it sits:

- **§7 row 8** says `v_standing_order_double_fire` *"was made to fail before
  being trusted"*. **That is the wrong order.** Migration 0023 repaired the body
  and recorded the demonstration as a SQL comment; **nobody ran it** between
  0023 and 2026-09-11, so it was trusted for days on the strength of a described
  measurement. It was made to fail for the first time at 09:41Z. The house rule
  was stated, not followed — which is this report's own §2 finding, one section
  over.
- **§7 row 5** says *"the deployed Increase consumer is absent"*. It is
  registered, 124 deliveries are consumed, and the ACH return path is exercised
  end to end — `ach:return:sandbox_ach_transfer_x5vdo5m7b6k924sszlms:…`, R01,
  $6,000.00.
- **§2 and §10** call `v_refused_auth_hold` *"the sixteenth guard"* and
  `card_auth_event`'s missing `result` column *"the fifteenth"*. **The first is
  right and the second is not.** On the reconciled list (`docs/DEBRIEF.md` §1,
  arithmetic in `DECISIONS.md` 058) the missing `result` column is **13**;
  `terminallyClosed`'s `A <= 0` arm is 14, `IncreaseAchRail.parseEvent` is 15,
  and `v_refused_auth_hold` is 16. The pattern now has **22** recorded
  instances, not sixteen.

---

## 0. What was actually run

| Command | Time (local −0700) | Result |
| --- | --- | --- |
| `node scripts/dbcheck.mjs` | 21:49:53 | **28 passed, 0 failed** (13 invariant views) |
| `node scripts/dbcheck.mjs` (re-run) | 21:57:18 | **30 passed, 0 failed** (15 views — file changed mid-evaluation) |
| `node scripts/compliance.mjs` | 21:49:52 → 21:50:12 | **PASS 28 · FAIL 2 · WARN 0 · UNKNOWN 4 · CITED 7** of 41 |
| `node scripts/coreloop.mjs` | 21:50:05 → 21:51:50 | **PASS 7 · FAIL 0 · SKIP 0** of 7 legs, 105s, 103 HTTP calls |
| `node scripts/livefire.mjs` | 21:53:33 → 22:00:30 | **PASS 6 · FAIL 2 · SKIP 0** of 8 attacks, 417s |
| `node scripts/audit-claims.mjs` | 21:53:35 | exit 0 — "no document contradicts the endpoint" |
| `node scripts/verify-demo.mjs` | 21:53:36 → 21:53:49 | **11 PASS · 2 FAIL · 1 SKIP** of 14 |
| `pnpm test` | 21:50:08 | **5 failed / 2124 passed / 278 skipped** (3 files failed of 152) |
| `pnpm typecheck` | 21:57:2x | **FAIL** — 1 error, `src/lib/timetravel/integrity.test.ts(112,18)` TS2352 |
| `pnpm build` | 21:57:53 | **exit 0**, 25 routes |
| `curl /api/health` | 21:50:12 and 22:04:11 | **200**, `status: ok`, 7 of 7 slots live, db 13ms |

Direct database readings (owner role, **read-only — I issued no write**), via
`psql`-equivalent `postgres` client against `DATABASE_URL`:

| Reading | Time (UTC) | Result |
| --- | --- | --- |
| All 68 `v_*` views, row counts | 04:53:08.984Z | see §2 |
| `card_auth_event` vs `card_auth_event_result` | 04:58:14.365Z | see §2 |
| Guard blind population | 04:58:40.546Z | see §2 |
| `card_auth_event_result.source` breakdown | 04:59:41.360Z | see §2 |
| `v_webhook_dead_letter` | 05:03:22.119Z / 05:03:38.128Z | see §3 |
| KYB state of every business | 04:55:59.599Z | see §4 |
| 15 screens × 5 states over HTTP | 22:01:27 −0700 | see §6 |

---

## 1. Score

| Area | Points | Score | One-line reason |
| --- | --- | --- | --- |
| Domain command | 30 | **24** | The mechanics genuinely live in the schema. The deployed build still places a hold on a **declined** authorisation. |
| A system that runs | 25 | **17** | Deployed and stable; 13 of 15 screens answer 200 in all five states; but the brief's first two live-fire scenarios fail on the URL. |
| Integration reality | 20 | **14** | Six providers really called, signatures proven with a negative control — and the ACH rail dead-letters every event it receives while health calls it fresh. |
| Live fire | 15 | **10** | 6 of 8 pass. The two failures are the headline scenarios — but the diagnosis printed in the failure text is exemplary and is worth most of the remaining credit. |
| Judgment and communication | 10 | **9** | 53 timestamped entries over 27 hours, a real cut list, and `docs/DEMO.md` documents its own failing checks instead of tuning them. |
| **Total** | **100** | **74** | |

This is a strong build. The gap between 74 and 90 is almost entirely one thing, and it is
in §7.

---

## 2. THE SIXTEENTH GUARD

> *Numbering note, 2026-09-11T09:58Z: **sixteen is right** on the reconciled list
> (`docs/DEBRIEF.md` §1, arithmetic in `DECISIONS.md` 058). The *"fifteenth
> guard"* this section cites below is **13** there, not 15. And the pattern now
> has **22** recorded instances, not sixteen.*

> `v_refused_auth_hold` — added tonight in migration `0026_auth_result.sql` (21:30) and
> wired into `pnpm db:check` at 21:52 — **reported zero rows at the exact moment two holds
> were withholding money against authorisations Lithic had just refused.**

### The claim it makes

`scripts/dbcheck.mjs`, run 21:57:18, prints:

```
  PASS  v_refused_auth_hold is empty — no hold withholds money against an
        authorisation the network refused
```

### What was true at the same moment

`node scripts/livefire.mjs`, attacks 1 and 2, run 21:53:33 → 22:00:30 against the deployed
URL:

```
 1  $50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move          FAIL
    evidence: REFUSED BY THE NETWORK. Lithic transaction
    f39f93ce-b645-4707-a37d-4e1b73c25b1f: AUTHORIZATION 5000 result DECLINED
    detailed_results [ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED]. … holds 10000 -> 15000
    (must be UNCHANGED — a refused authorisation withholds nothing) …
    v_refused_auth_hold 0.  THE HOLD WAS PLACED ANYWAY: +5000 cents withheld
    from a business for a purchase the network refused.

 2  $73.40 capture: hold released exactly once, available not clamped       FAIL
    … holds 15000 -> 20000 (must be UNCHANGED) … v_refused_auth_hold 0.
```

Two declined authorisations, $100.00 wrongly withheld, and the invariant built for exactly
this returned **0** both times. The live-fire script only caught it because it **asked
Lithic directly** what the verdict was. The guard could not.

### Why it cannot see it — the exclusion is the failure

```sql
CREATE VIEW v_refused_auth_hold AS
SELECT …
  FROM v_hold_state hs
  JOIN card_authorization    ca ON ca.hold_id  = hs.hold_id
  JOIN card_auth_event       ev ON ev.auth_id  = ca.id
  JOIN card_auth_event_result r ON r.event_id  = ev.id     -- ← INNER JOIN
 WHERE hs.active_hold_cents > 0
   AND ev.kind IN ('authorization','incremental_authorization')
   AND r.result IS NOT NULL                                 -- ← AND AGAIN
   AND r.result <> 'APPROVED';
```

There are exactly two ways this schema represents "we do not know the verdict":

1. **no `card_auth_event_result` row at all** — removed by the `JOIN`;
2. **a row with `result IS NULL`, `source = 'not_retained'`** — removed by `r.result IS NOT NULL`.

The failure this view exists to catch is *an authorisation the network refused whose verdict
was never recorded*. That is the fifteenth guard, verbatim: "`card_auth_event` has no column
recording whether an authorisation was declined." **The view's two exclusions are the two
spellings of that exact condition.** It is `WHERE NOT is_released` again, in a new table.

### Measured, not argued

Coverage of the whole event table (04:58:14.365Z):

| kind | events | with a result row | missing |
| --- | ---: | ---: | ---: |
| authorization | 365 | 352 | **13** |
| clearing | 209 | 202 | **7** |
| force_post | 81 | 76 | **5** |
| refund | 80 | 73 | **7** |
| authorization_reversal | 27 | 27 | 0 |
| expiry | 58 | 58 | 0 |

The guard's own domain — authorisation events on holds that **still withhold money**
(04:58:40.546Z):

```
candidate_auth_events                       124
no_result_row                                 6   ← dropped by the INNER JOIN
result_null_not_retained                     86   ← dropped by r.result IS NOT NULL
approved                                     32
refused_VISIBLE                               0
cents_withheld_behind_a_missing_verdict  790804   ← $7,908.04
```

**92 of 124 (74%) of the population this invariant exists to police is structurally
invisible to it, and $7,908.04 is currently withheld behind an authorisation whose verdict
the guard cannot read.** Its zero is a zero over an empty domain.

### The strongest form of it

`card_auth_event_result.source` across all 788 rows (04:59:41.360Z):

```
{ source: 'not_retained',     n: 431, with_verdict:   0 }
{ source: 'retained_payload', n: 357, with_verdict: 357 }
```

**Not one row has `source = 'ingest'`.** `src/lib/holds/apply.ts:233` — the live write path
that records the verdict "beside the fact and in the same transaction" — has produced
**zero rows in production**. Every result row in the database came from migration 0026's
one-time backfill. And every card event arriving since the migration has no result row at
all:

```
04:57  force_post     *** NO RESULT ROW ***
04:56  refund         *** NO RESULT ROW ***
04:56  clearing       *** NO RESULT ROW ***
04:56  authorization  *** NO RESULT ROW ***
04:55  authorization  *** NO RESULT ROW ***
04:54  authorization  *** NO RESULT ROW ***
```

`src/lib/holds/store.ts:283` is the only writer of `card_auth_event`, and the result INSERT
sits immediately after it in the same transaction in the current source. So the deployed
build does not contain that change — which live fire diagnosed correctly and unprompted:
*"the code serving https://corgi-trial-psi.vercel.app predates 0026 — the fix is in the
repository and has not been deployed."*

### The finding, stated precisely

The bug is in-flight and undeployed; that is forgivable and was self-diagnosed. **The guard
is the finding.** `v_refused_auth_hold` was wired into the invariant gate at 21:52, *before*
the write path that populates its only input was deployed — so it went green at the exact
moment it was least able to see anything, and `pnpm db:check` has been printing "30 passed,
0 failed" over it ever since.

**The house rule was not followed here.** `scripts/dbcheck.mjs` documents, in its own
comments, that the 0023 and 0024 invariants were "made to fail on purpose, against this
database, in a transaction that was rolled back" before being listed — with the deltas
recorded (`v_interest_ledger_drift 0 -> 1`, `v_interest_rate_drift 0 -> 5`). For the two
added tonight the comment says only that `v_hold_closure_not_terminal` "catches 0011's three
spurious closures … and it is empty against this database today," and for
`v_refused_auth_hold` it makes **no made-to-fail claim at all**. It was asserted, not
demonstrated. Had someone tried to make it fail, they would have had to insert a refused
verdict — and would have discovered that no live event has one.

### A second, smaller instance of the same list problem

`v_wire_availability_drift` (migration `0025_wires.sql`, 21:24 tonight) is an
invariant-shaped, expected-zero view that **is not in `INVARIANT_VIEWS` at all**. Nor are
`v_pot_identity_drift`, `v_pot_negative`, `v_pot_orphan`, `v_internal_transfer_impure`,
`v_business_account_malformed`, `v_accrual_gap`, `v_interest_gap` or `v_overdrawn_accounts`.
I queried all 68 `v_*` views directly at 04:53:08.984Z: **every one of them returns zero
rows today**, so nothing is currently broken behind them. But `dbcheck`'s coverage list is
hand-maintained, and its own preamble already records this happening twice before
("0022's `v_balance_definition_drift` sat unqueried for a day that way"). It is happening a
third time.

`v_account_opened_outside_approval` returns **10 rows** and is correctly and explicitly
documented as `'REPORT, not an invariant … Non-empty by design'`. That is not a finding —
it is the distinction being drawn properly, and it is the right call.

---

## 3. The ACH rail: received, verified, and dropped — while health calls it fresh

> **CLOSED 2026-09-11T09:47Z, and the guard finding in this section is not.** The
> drop is gone: Increase has **124 `done`, 119 `parked`, 0 dead**, not one of its
> 243 rows carries a `dead_lettered_at`, and no row anywhere in `webhook_inbox`
> carries *"no consumer registered"*. The guard defect this section identifies —
> `webhookHealth` computed from `MAX(received_at)`, so a rail that receives
> everything and processes nothing reads as maximally fresh — **was real and was
> repaired**: `/api/health` now publishes a separate `webhookProcessing` block
> keyed on `processed_at` and disposition. It is instance **17** on the
> reconciled list.


`/api/health` at 05:04:11.989Z:

```
ach_rail | live | evidence: GET /accounts -> 200
webhookHealth → increase: verdict "fresh", degradesDeployment false,
                note "delivered within 21600s"
```

`v_webhook_dead_letter`, read 05:03:22.119Z:

```
{ provider: 'increase', n: 179, newest: 2026-09-11T04:46:06.024Z }
{ provider: 'lithic',   n:  17, newest: 2026-09-10T22:35:54.909Z }
```

The dead-letter reason, read 05:03:38.128Z — most recent row dead-lettered at
**05:00:29.150Z, four minutes before I read it**:

```
processing_error: "dead-lettered after 8 failed attempts:
                   no consumer registered for provider 'increase'"
```

**179 Increase ACH webhooks have been received, signature-verified, stored, retried eight
times each and discarded** because the deployed build registers no consumer for them.
`src/lib/webhooks/drain.ts:76` registers `increase-ach` in the repo — and the comment beside
it says this precise bug was already found once: *"fourteen of them, two of which were
Increase ACH events on a money rail … the difference was invisible because a drain with no
consumer reports success."* The fix is in the tree and is not on the deployed host.

**And the health guard still cannot see it.** `webhookHealth` is computed from
`MAX(webhook_inbox.received_at)` — arrival — and measures nothing about disposition. A rail
that receives every event and processes none reads as *maximally fresh*. What that guard
excludes (the outcome of the delivery) is shaped exactly like the failure it exists to
catch. This is the same defect as §2 in a different subsystem, and it is the closest thing
in this build to a second sixteenth guard.

`v_webhook_parked` also holds 55 Lithic events, newest 05:01:15.124Z.

---

## 4. The six automatic fails

| # | Rule | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Localhost only, or a video in place of a URL | **PASS** | `curl https://corgi-trial-psi.vercel.app/api/health` → 200 at 21:50:12 and 22:04:11. 13 of 15 console screens answer 200 (§6). `compliance.mjs` AF1 PASS. |
| 2 | A simulated integration presented as live | **PASS, with one label to fix** | `compliance.mjs` AF2 PASS; `audit-claims.mjs` exit 0. Every live slot carries call evidence, and I re-derived it independently (§5). **But** the `business_registry` slot publishes `"provider":"Stripe Connect (gated) — simulated"` together with `"status":"live"` — a self-contradicting string on the one axis this trial auto-fails for. The direction is *understating* (the leg really is live via GLEIF, proven in the DB at 04:55:59Z), so it is not a fail — but a grader reading that line will stop. **Fix the string.** |
| 3 | UPDATE or DELETE on money rows. Anywhere. Ever. | **PASS — strongest-proven rule in the build** | `dbcheck` 21:57: real `UPDATE`/`DELETE`/`TRUNCATE` attempted against `journal_entry`, `journal_line`, `card_auth_event`, `hold_closure` — all refused, `permission denied`. `compliance.mjs` AF3: 35 money tables, **81 append-only triggers read from `pg_trigger`, not from a migration**; `has_table_privilege` confirms `corgi_app` holds no UPDATE/DELETE/TRUNCATE on any of them; live refusals on `statement`, `payment_instruction`, `pot`. Defence in depth, verified at the database. |
| 4 | Live-mode keys, real money, real personal data | **PASS** | `compliance.mjs` AF4 PASS. I re-checked independently: `STRIPE_SECRET_KEY` begins `sk_test_` (read 21:55:21); chain id 84532 (Base Sepolia); Plaid/Increase/Lithic/Persona base URLs unset or sandbox. No production provider host in the health evidence. |
| 5 | Secrets committed to the repo | **The repo's own gate says FAIL. On substance I score it PASS — but it must be made green before freeze.** | `compliance.mjs` AF5 **FAIL**: "credential-shaped strings alive in git history (3 file/shape pairs)". I inspected all three at the tip: `src/lib/cards/asa.test.ts:85,118` are `whsec_AAAA…=` and `whsec_BBBB…=`; `src/lib/rails/plaid/client.test.ts` is `'access-sandbox-x'`; the third is `docs/EVALUATION.md`'s own redacted prose. **None can authenticate anything.** The real tokens a previous evaluator found in `research/` are now redacted and marked ROTATED in the working tree, and AF5's pickaxe confirms "no current `.env` secret value appears in any commit (17 values)". So: **the claim "no credential-shaped string is committed" is false as stated** — three are — but no *secret* is. |
| 6 | Code you cannot explain line by line | **UNKNOWN by construction** | Not mechanisable and `compliance.mjs` correctly refuses to fake it. Proxies are strong: 183 of 183 `src/lib/` modules carry file headers; 53 numbered timestamped decision entries across 34 commits spanning 27.0 hours. |

**No automatic fail is triggered.** AF5 is the one that would be argued about in the room,
and the argument is winnable — but only if someone either silences the three dummies with
justified `.secretscanignore` entries or narrows `HISTORY_SHAPES`. Walking into the debrief
with the repo's own compliance tool printing `FAIL AF5` is an unforced error.

---

## 5. The load-bearing claims, checked one at a time

### "`/api/health` reports 7 of 7 slots live — is every one actually live, by a real call?"

**Six of seven: yes, verified independently. One is live but its evidence string is weaker
than every other slot's.**

| Slot | Evidence published | My verdict |
| --- | --- | --- |
| `card_issuing` | `GET /v1/cards -> 200` | **Live.** Live fire drove three real Lithic sandbox transactions with real tokens. |
| `card_webhooks` | subscription `ep_3J8yb9…` enabled, latest delivery SUCCESS, our endpoint answered 202 | **Live.** Attack 8 replayed a genuinely signed delivery `msg_3JATMxo1zQ18Xquvokv6NOLl7Lr` with a **tampered-signature negative control returning 401**. That negative control is what makes the 200s mean something. |
| `director_kyc` (**must be live**) | `Stripe Identity enabled (Persona not configured)` | **Live — and I proved it a second way.** This is the one evidence string in the set that names **no HTTP verb and no status code**, which is exactly the shape the earlier `else`-branch bug had. So I called it myself at 21:55:21: `GET /v1/identity/verification_sessions?limit=1` → **200**, returning real sessions (`vs_1UEFp2DgSL5WTGpmNegNPM2n`, `livemode:false`, `has_more:true`). And the database shows Ridgeline Robotics carrying `director_provider: stripe-identity`, `director_reference: vs_1UEDLcDgSL5WTGpmif87HEZ7`, `director_evidence: live`. It is genuinely live. **Make the evidence string quote the call like the other six do.** |
| `business_registry` | `GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple Inc.)` | **Live**, and used in anger: Silverline Freight Co. carries `registry_provider: gleif-lei`, `registry_evidence: live`, status `needs_review` from a real no-match. The `provider` label contradicting it is the AF2 note above. |
| `open_banking` | `POST /institutions/get -> 200 [quoted, not re-probed: earned 19s ago]` | **Live.** The cache is disclosed in the evidence string with its rationale and age — that is the honest way to do it. |
| `ach_rail` | `GET /accounts -> 200` | **Live at the API, and broken at the webhook.** See §3. The slot answers truthfully about what it measured; what it measured is not the thing that matters for this rail. |
| `stablecoin` | `15.03 USDC and 68659903703189 wei gas — a transfer is fundable` | **Live**, and the best-designed probe in the set: it answers "can we send", not "can we read", after a documented earlier version reported LIVE on a `balanceOf` with zero gas. |

### "The core loop passes 7/7 on a second business."

**7/7 confirmed at 21:51:50. "On a second business" is not supported by any run of this
script, and the script cannot produce one.**

`scripts/coreloop.mjs` accepts only `--base-url` and `--only` (`parseArgs`, line 106). There
is no business selector. It picks its own subject by ranking (lines 873–895):

```js
const rankOf = (answer) => (answer.allowed ? -1 : (GATE_RANK[answer.code] ?? 9));
const ranked = [...gateAnswers].sort((a, b) =>
  rankOf(a) - rankOf(b) ||
  Number(b.legs_on_file ?? 0) - Number(a.legs_on_file ?? 0) ||
  a.legal_name.localeCompare(b.legal_name));
```

Every allowed business collapses to rank `-1`; three are tied on `legs_on_file = 2`; the
tiebreak is `localeCompare`. **"Hold Fuzzer Fixture Co." wins alphabetically, every time,
deterministically, including in front of the graders.**

And that business's KYB, read 04:55:59.599Z, is:

```
Hold Fuzzer Fixture Co.  approved  evidence: simulated
  director: simulated-hold-fuzzer / sim.fuzz-director_kyc   approved  simulated
  registry: simulated-hold-fuzzer / sim.fuzz-business_registry  approved  simulated
```

So the headline artifact of this build — **core loop 7/7** — runs leg 1, *"open an account
behind a real KYB check,"* against a business verified entirely by a simulator, and its
"unverified" foil ("Holds Integration Fixture Co.") has **zero legs on file** and was never
checked by anything. Meanwhile Ridgeline Robotics, the one business holding a real Stripe
Identity session reference, is never selected.

This is the same defect shape as §2 in the selection layer: **the sort key omits
`kyb_evidence`, and `kyb_evidence` is the only field that distinguishes a real KYB check
from a simulated one — which is precisely what leg 1 exists to prove.** The output labels it
`approved/simulated` honestly, so it is not dishonest; it is a proof that does not prove
what it is cited for. Ranking `evidence = 'live'` above `'manual'` above `'simulated'`
inside the allowed tier is a two-line change and would make the headline claim true.

Related and worth knowing before the debrief: the gate leg 1 exercises runs
`requireLiveEvidence: false`. `src/app/(app)/payments/live-source.ts:132` computes the
strict gate too — but as `gateIfLiveRequired`, **for display beside the real one**. Under
`requireLiveEvidence: true` the subject of all seven legs would be refused
`KYB_EVIDENCE_SIMULATED`. That choice is deliberate and documented in
`src/components/onboarding/EntityCard.tsx:114` ("a gate that denies everything teaches
people to route around the gate") — it is defensible, and you will be asked about it.

### "No credential-shaped string is committed."

**False as stated; harmless in substance.** Three are committed (§4, AF5). None can
authenticate. The repo's own gate prints FAIL.

### "Money is never a float, including intermediates."

**Upheld.** `src/lib/format/money.ts` does integer division on `bigint` (`magnitude / 100n`)
and documents the absence of `/ 100`, `toFixed` and `Intl.NumberFormat`-on-a-decimal.
`src/lib/ledger/post.ts:94` explicitly says *"Never `Number(l.amountCents)`"* and passes
cents to Postgres for casting. `src/lib/fx/gate.ts:106` formats dollars by `bigint`
arithmetic and a thousands regex rather than `toFixed`. `src/lib/accrual/interest-types.ts`
declares no `number`, no `Math.round`, no `toFixed` in the calculation.

Every `Number(…)` I found in a money module is on a **count or a day tally**, not on cents
— `daysClaimed`, `daysPosted`, `residualPenniesApplied`, `authCount`, `eventCount`
(`src/lib/accrual/store.ts:255-259,300-303`, `src/lib/ledger/queries.ts:623-624`), and
`store.ts:478` states the reasoning. `v_entry_unbalanced`, `v_trial_balance` and
`v_book_not_zero` all return zero rows (04:53:08.984Z), which is the arithmetic proving
itself. The one place a float legitimately appears is the FX **rate** (`src/lib/fx/rate.ts`),
which is a rate and not money, and `src/lib/fx/allocation.ts:119` documents the
integer-ceiling rule that converts it back to cents.

### "Every screen answers 200 in five states."

**13 of 15. Two return 404 on the deployed build.** Probed 22:01:27 −0700, five states each:

```
/accounts /approvals /funding /onboarding /payments /statements
/reconciliation /disputes /payees /pots /payouts /standing-orders /accruals
                                      → 200 in all five states

/transactions   → 404  default loading empty error edge
/breaks         → 404  default loading empty error edge
```

Both routes are present in the local `pnpm build` manifest (`├ ƒ /breaks`,
`└ ƒ /transactions`, 21:57:53), so they are built and undeployed — in-flight work, same
class as §2 and §3. `compliance.mjs` AF1 asserts "all **11** console screens answer 200",
so its list does not include them either, and the claim as written ("every screen") is
broader than what any check covers. The brief asks for **three** screens in five states;
13 comfortably clears it. The claim is over-stated, not the work.

---

## 6. The ten non-negotiables

| # | Requirement | Verdict |
| --- | --- | --- |
| 1 | Deployed, two roles | **PASS** — `verify-demo` checks 4–7: no cookie → Priya Raman "cannot approve"; `corgi_demo_role=approver` → Dana Okonkwo "can approve"; the switch is a real server action setting an HttpOnly cookie, and it changes the *server's answer*, not a label. |
| 2 | You wrote the ledger; double-entry, append-only, derivable at any past date | **PASS** — `journal_line_balanced`, `journal_entry_has_lines`, `journal_entry_reversal_exact` triggers; `value_date date` and `booking_seq bigint`/`booking_time` as separate columns; balances are views. `compliance.mjs` NN2 drove a real bitemporal as-of query against the deployed function and confirmed the answer echoes the as-of it was asked. |
| 3 | Two integrations genuinely live | **PASS, comfortably** — six providers, both must-be-live slots verified independently (§5). |
| 4 | Webhooks done properly | **PASS on signatures and idempotency; FAIL on the ACH consumer.** Attack 8: signed replay twice → one `webhook_inbox` row, deduped by `UNIQUE (provider, provider_event_id)`, with a tampered-signature 401 negative control. Attack 4: settlement before its auth lands where in-order lands. But §3: 179 Increase events dead-lettered for want of a consumer. |
| 5 | The correction test | **PASS** — `coreloop` leg 6 and `livefire` attack 3. Reversal + re-book at the **original** value date, later booking seq; as-believed `$509,229.01` at watermark 2631, as-corrected `$509,155.61` at 2632, difference exactly `−$73.40`. Nothing rewritten. |
| 6 | Approvals above a threshold; initiator can never approve | **PASS, proven at the database** — `livefire --only 5` asserts SQLSTATE 42501 from `assert_maker_checker()` on a raw INSERT with no application code in the call stack. `verify-demo` check 9 honestly records that it *cannot* prove this over HTTP and names the command that can. A skip declared as a skip. |
| 7 | Reconciliation is a feature | **PASS** — `coreloop` leg 7 and `livefire` attack 6: a row deleted from tonight's file surfaces as `in_ledger_not_file`, ref `LF6-MTVRTYAB-3`, with category and severity. **One defect:** the aging reads **`age -447d`** on a file with business date **2027-12-02**. The gauntlet asks for aging; negative aging is broken aging. Report only — not fixed. |
| 8 | An agent surface, implemented | **PASS** — a real MCP server (`src/lib/mcp/`), seven-plus read tools, one write tool, `no-write-imports.test.ts` enforcing the boundary structurally, and a written never-automate list. |
| 9 | Money is never a float | **PASS** — §5. |
| 10 | A decision log written as you go | **PASS** — 53 numbered timestamped entries, touched by 34 commits spanning 27.0 hours (`e1d1759` 2026-09-09T17:26 → `b6cc820` 2026-09-10T20:27). Three timestamps go backwards; parallel workers, correctly flagged SOFT. |

---

## 7. The ten-item domain gauntlet

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Ledger vs available, derived not stored | **PASS.** `v_available_balance`, `v_ledger_balance`, `v_trial_balance` are views. `v_balance_definition_drift` holds `v_hold_state`'s release predicate equal to `ledger_availability()`'s — two independent bodies — and is empty. **One caveat:** `compliance.mjs` G1 **FAILs** on `interest_posting.basis_balance_cents` as a stored balance column, while `dbcheck` passes it as one of "3 named exceptions, each proven reproducible" and re-derives every stored basis from the journal at its watermark. The two tools disagree; `dbcheck` does the harder check and I side with it. **Reconcile them before the debrief — you do not want to be explaining a disagreement between your own two gates.** |
| 2 | The authorisation lifecycle; hold releases exactly once | **FAIL on the deployed build** at 05:05Z: a declined authorisation placed a hold (§2). **CORRECTION, 09:40Z: the decline path is deployed.** `card_auth_event` holds 74 `declined` rows, and `v_refused_auth_hold` returns **zero rows with `verdict = 'refused'`** — no hold withholds money against an authorisation the network is recorded as having refused. Its 154 rows are all `verdict = 'unanswered'`: pre-0026 fixture events whose payloads were never retained, so the verdict cannot be recovered and is not being invented. **Also closed:** `incremental_authorization` had never been recorded by any path and now has 8 rows. **Still short:** the $50-auth/$73.40-capture sequence cannot be driven at all, because the Lithic sandbox spend cap is exhausted — live-fire attack 2 SKIPs and coreloop leg 4 FAILs on it. |
| 3 | Settlement is not authorisation | **PASS** — `coreloop` leg 4: $50 auth, $73.40 capture, hold releases exactly once, ledger posts settled. Force-post modelled (81 `force_post` events on file). |
| 4 | Out-of-order delivery | **PASS** — `livefire` attack 4 ends exactly where in-order ends. 55 parked Lithic events show the parking machinery is live. |
| 5 | Returns and recalls | **PARTIAL** at 05:05Z: modelled and tested in-repo, but the deployed Increase consumer was absent (§3), so the ACH return path was not exercisable on the URL. **CORRECTION, 09:47Z: the consumer is registered and 124 Increase deliveries are consumed, 0 dead.** The outbound ACH return is exercised end to end — `ach:return:sandbox_ach_transfer_x5vdo5m7b6k924sszlms:644288470109390`, R01 `insufficient_fund`, $6,000.00, posted at `return.created_at` with the settlement left standing. **Still partial, for a different reason:** the *inbound* recall cannot be attributed at all, because the programme has one shared FBO account number across six businesses (`docs/GAUNTLET.md` §5 addendum), and R02–R29 remain table-driven and unexercised. |
| 6 | Bitemporality — the correction test | **PASS, and it is the best work in the build.** §6 item 5. |
| 7 | Statements reproducible forever | **PASS** — `v_statement_version` (52 rows); statement screen renders both readings and the watermark. |
| 8 | Standing orders fire once and only once | **PASS, and honestly repaired.** `v_standing_order_double_fire` was for days a view joining a UNIQUE column asking `count > 1` — unsatisfiable — and quoted as proof in a test, a document and `compliance.mjs`. 0023 repointed it at the derived-key question the unique index does not answer. **CORRECTION, 09:58Z: this row said it was "made to fail before being trusted", and that is the wrong order.** 0023 recorded the demonstration as a SQL comment and *nobody ran it* between then and 2026-09-11; it was trusted for days on a described measurement. It was made to fail for the first time at 09:41Z, by `dbcheck --prove` planting a second instruction on one occurrence under a different spelling of the derived key: 0 → 1, both keys named in `instruction_keys`, 0 again after rollback. The house rule was stated, not followed — which is this report's own §2 finding. |
| 9 | Scheme reconciliation with aging | **PASS with the negative-aging defect** (§6 item 7). |
| 10 | Maker-checker, agent included | **PASS** — enforced by database trigger, and the MCP write tool lands in the same queue. |

---

## 8. The eight live-fire attacks — a skip is not a pass

Run 21:53:33 → 22:00:30. **PASS 6 · FAIL 2 · SKIP 0.** No skips, which is itself worth noting.

| # | Attack | Verdict |
| --- | --- | --- |
| 1 | $50 fuel-pump auth: available drops, ledger does not | **FAIL** — §2. Lithic DECLINED; the hold was placed anyway. |
| 2 | Capture $73.40; hold releases exactly once | **FAIL** — §2. Same root cause; the auth was declined and held. |
| 3 | Backdated reversal + statement for settlement day | **PASS** — both readings at once. |
| 4 | Settlement before its auth | **PASS** — ends exactly where in-order does. |
| 5 | Initiator approves own payment | **PASS** — refused by the database, SQLSTATE 42501. |
| 6 | Row deleted from tonight's scheme file | **PASS** — surfaces as `in_ledger_not_file`. |
| 7 | Issuing provider webhooks off for five minutes | **PASS, and this one is excellent.** A real 306-second silence; `/api/health` moves lithic to `stale` at 184s inside its own 180–900s band, escalates `status: "degraded"` with `database.reachable: true`, and the deployed console renders `data-provider-status="provider-down"` **with balances still rendered underneath rather than blanked**. And the script then tests the *gate* against the thing it guards: replaying the outage's own published facts with `card_webhooks` forced not-live shows the alarm stays armed under `some` and is **silenced under `every`** — proving `some` is not incidentally correct. That is the only place in this build where someone tried to make a guard fail and wrote down what happened. |
| 8 | Signed provider replay: twice is one | **PASS** — one inbox row after 1 delivery + 2 signed replays, with a tampered-signature 401 negative control. |

Attacks 1 and 2 are the brief's own first two scenarios. They fail on the deployed URL.
The failure text diagnoses the cause correctly and without defensiveness, which is
literally what "Live fire (15)" says it is grading — that is why this category scores 10
and not 5.

---

## 9. Failures attributed

**Real, on the deployed build (fix or be ready to explain):**

1. A hold is placed on a **declined** authorisation — livefire 1 & 2, $100 wrongly withheld
   during my run alone. Fix exists in the repo (0026 + `apply.ts`), undeployed.
2. **179 Increase ACH webhooks dead-lettered** — "no consumer registered". Fix exists in the
   repo (`drain.ts`), undeployed. Newest dead-letter 05:00:29Z.
3. `/transactions` and `/breaks` **404** on the deployed URL; built locally.
4. Reconciliation **aging is negative** (`age -447d`) on a future-dated business date.
5. `business_registry` publishes `provider: "… — simulated"` with `status: "live"`.
6. `director_kyc` evidence string quotes no HTTP call, unlike the other six slots.

**In-flight work, red on files being edited as I read them — not real defects:**

7. `pnpm test` 5 failures across 3 files: `holds/model.test.ts` (terminallyClosed —
   0028 landing at 21:34), `ledger/boundary.test.ts` ×2 (the allowlist ratchet caught
   `src/lib/chaos/driver.ts` and four grown counts — 0029 chaos landing at 21:36), and
   `recon/zzdump.test.ts` (missing `APP_DATABASE_URL`; a `zz`-prefixed dump test that looks
   like scratch and should not ship).
8. `pnpm typecheck` 1 error, `timetravel/integrity.test.ts(112,18)` TS2352 — test-only;
   `pnpm build` is green.
9. `scripts/dbcheck.mjs` changed mid-evaluation (13 → 15 views).

**Guards failing loudly and correctly, already self-documented:**

10. `verify-demo` checks 10 and 12. Both are one parser bug: `derivation()` takes the first
    **four** money figures after "How the available balance is derived", and the table has
    **five** rows since "Committed outflows" was added — so it reads `$0.00` as the available
    balance. I confirmed the screen is right: `$510,513.59 − $3,816.60 − $3,750.00 − $0.00 =
    $502,946.99`, exact, and that is what the page prints. `docs/DEMO.md:501-535` already
    diagnoses this precisely and **deliberately leaves it red**, writing *"a checker that is
    adjusted until it agrees is not a check."* That is the correct instinct and it should be
    said out loud in the debrief.

---

## 10. The single most likely reason this submission would lose

> **SUPERSEDED 2026-09-11T10:05Z, and this section is the most important one in
> the report to not quote stale.** Its premise — *"the deployed URL is behind
> the repo on two money-path defects"* — was right at 05:05Z and its three
> named green signals have all moved: `dbcheck` reads **36 passed, 2 failed**
> (not 30/0), Increase drops **nothing** (not all 179 — 124 consumed, 0
> dead-lettered), and `/api/health` still reads 7 of 7 live. **The argument in
> the last three paragraphs is untouched by that and is the part worth
> keeping.** The deployment is still not the tree: `/api/health` reported
> `544b481` at 09:38Z and `2c13805` at 09:59Z; `.git/refs/heads/main` is
> `59010b5`. And `scripts/audit-claims.mjs` — the tool whose job is to catch
> exactly this — still cannot see it, which is instance 21.


**The deployed URL is behind the repo on two money-path defects, and every green dashboard
is measuring the repo instead of the deployment.**

The trial grades what a grader can open. What a grader can open right now:

- places a hold on an authorisation the card network **refused**;
- receives ACH webhooks and **drops all 179 of them**;
- and reports `status: "ok"`, `7 of 7 slots live`, `increase: fresh`, and — via
  `pnpm db:check` — `30 passed, 0 failed` including the very invariant that exists to catch
  the first defect.

Every one of those green signals is technically true about something. `/api/health` truly
reached Increase's API; `v_refused_auth_hold` truly returned zero rows; `coreloop` truly
passed 7/7. None of them is true about the thing it is quoted for, because each measures
the half of the system that is working: the API call rather than the event's fate, the rows
that have a verdict rather than the rows that do not, the gate's answer rather than the
provenance of the approval it consulted.

That is the sixteenth guard, and it is also the fifteen before it. The pattern has not been
broken, it has moved — out of individual SQL predicates and into the **relationship between
the repo and the deployment**. The house rule is right and needs one more clause:

> A new invariant must be made to fail before it is trusted — **against the build that is
> serving the URL**, not the build on disk.

Had anyone tried to make `v_refused_auth_hold` return a row tonight, they would have needed
a refused verdict to insert, and would have discovered within a minute that the deployed
system writes none.

**Deploy the tip, re-run `livefire.mjs` and `verify-demo.mjs` against it, and this is a
strong submission.** The ledger, the bitemporal correction, the maker-checker trigger, the
privilege boundary and attack 7's gate-tested-against-the-thing-it-guards are genuinely
better than the brief asks for. Do not let them be graded through a stale deployment.

---

*Every figure in this report carries the command and the time it was produced. Nothing was
fixed, edited or tidied; two defects in §9 were left exactly where they were found.*
