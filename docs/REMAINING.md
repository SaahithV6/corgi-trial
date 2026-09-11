# What is left

Re-measured **Fri 09:40 PDT (16:40Z)** · **T+40.4h of 48** · freeze Fri 17:13 PDT
— **7.6h left**. Deployed commit `225f00d`, `/api/health` `status: "degraded"`.

The previous version of this file was written Thu 11:26 PDT at T+18.2h and led
with "are we ready for the T+24h email". That checkpoint is **22 hours in the
past**. Everything below is re-established rather than carried forward, because
this file's whole failure mode is being read as current when it is a day old.

---

## 0. The T+24h checkpoint — I cannot verify it was sent

`thread/T+24h_money_moves.md` (243 lines) and `thread/T+24h_short.md` are both
written and both predate the Thu 17:13 PDT deadline. **Whether the email was
actually sent is not something I could establish** — it is Gmail account state,
not repo state, and the tool call to check it was refused. Confirm it in the sent
folder before freeze; if it was missed, the brief's own rule applies (an honest
paragraph recovers a miss, silence does not) and it belongs in the freeze email.

---

## 1. Must be done before freeze — 7.6 hours

Ordered by what costs the most if skipped.

### 1.1 The video. This is the largest unstarted item and it is a human task.
`docs/VIDEO-SCRIPT.md` is written, re-measured, and shot-by-shot: **4:52 across
fourteen shots, twelve browser tabs and one terminal**, every figure in it read
off the deployed system between 09:43Z and 09:52Z. **No video file exists in the
tree** (`find . -iname '*.mp4' -o -iname '*.mov' -o -iname '*.webm'` → nothing).
`thread/freeze_submission.md` carries `3. VIDEO — [LINK …]` as a placeholder.
Nothing else on this list is worth a minute of the time this needs.

**One correction to make before recording:** the script's own flags block is
stale in at least one place — it says `pnpm db:check` is "now 36 / 2". At
16:23:07Z it is **43 passed, 4 failed**, and the four reds are on the register
with written arguments. Read the numbers off the system at record time, as the
script itself instructs.

### 1.2 The evidence pack and the two demo roles in the email body
`docs/EVIDENCE-PACK.md` is the checklist; `thread/freeze_submission.md` already
carries the role instructions and the `curl -b 'corgi_demo_role=approver'` line.
What is outstanding is account state outside the repo, and `compliance.mjs` says
so rather than passing it: **SP2** (are @AlexanderReinicke and @mojafa's GitHub
invitations accepted), **SP4** (video link), **SP5** (evidence folder shared).
All three report `UNKNOWN — could not be checked, and therefore NOT a pass`.

### 1.3 Re-run the numbers against the final commit, and only then
Every headline figure in the submission rots. The current readings, all
2026-09-11:

| Command | Time | Result |
|---|---|---|
| `curl /api/health` | 16:15:22Z | `7 live of 7`, `status: "degraded"`, commit `225f00d` |
| `node scripts/dbcheck.mjs` | 16:23:07Z | **43 passed, 4 failed**; `GUARD REACH` 31 of 31 |
| `node scripts/coreloop.mjs` | 16:28:26Z | **PASS 7 · FAIL 0 · SKIP 0 of 7** (95s) |
| `node scripts/compliance.mjs` | 16:25:43Z | **PASS 28 · FAIL 2 · UNKNOWN 4 · CITED 7 of 41** |
| `node scripts/livefire.mjs` | **not run since 08:23:58Z** | last recorded 7 PASS / 0 FAIL / 1 SKIP |

**Live fire is the one that must be re-earned.** It takes 294s, it posts real
money, and its last reading is eight hours old. Run it against whatever finally
ships. **Do not round the SKIP up** — the suite prints "A SKIP is not a pass"
under its own scoreboard and that honesty is worth more than the extra point.

### 1.4 Debrief preparation
"Code you cannot explain line by line when we point at it" is an **automatic
fail**, and `compliance.mjs` AF6 refuses to fake a check for it: *"whether the
author can explain a line when a grader points at it is NOT mechanisable, and
this tool will not fake a check for it."* `docs/DEBRIEF.md` (2,552 lines) is the
preparation. 75 minutes of the panel driving is the exposure.

---

## 2. Known gaps, deliberately open

Each is a decision, not an oversight, and each is in `docs/CUT-LIST.md` with the
reasoning. **This table was wrong in four places as of Thursday** and those rows
are corrected rather than deleted, because what changed is worth more than the
current state alone.

| Gap | State at 16:40Z Fri | Week-two fix |
|---|---|---|
| `/api/health` reads `degraded` | **Live.** `degradedBy: ["increase"]` — 1 of 37 dead letters died after that provider's last consumption. Measured 16:35:12Z, **zero of the 37 are fault deaths**; all are refusals that ran their full ladder, and Lithic has 53 of the identical shape reading `backlogged`. Patch is in the tree with passing tests; expected to read `ok` after the next deploy. **It is not fixed on the deployed commit.** | deploy |
| A **$10,000.00** inbound ACH credit is unbooked | **Live, and correct.** Nothing on the book says whose `account_number_id sandbox_account_number_96mzhz3n61f5p0jpvytc` is, so the consumer refused rather than guessed. This is requirement 4 working. | a person, then a claim screen |
| 55 of 67 provider-lane card approvals judged nothing | **Live.** 55 of 962 cards carry a control version. The ratio is improving (was 48 of 51) and the **absolute count is rising**, because `registerCard()` mints uncontrolled cards faster than issuance mints controlled ones. | fix the registration path, not the decision path |
| ~~`stablecoin` simulated — 20 USDC and zero gas~~ | **STALE — this shipped.** `/api/health` 16:15:30Z: *"13.05 USDC and 68384981507408 wei gas — a transfer is fundable"*. **Two** real Base Sepolia transfers now carry ledger entries; I verified the second (`0x92b3…d58d`, block `0x2c85537`, 1.979521 USDC) on chain at 16:22:57Z. | — |
| ~~No `Payments` screen~~ | **STALE — it exists.** `/payments` answers 200, with a `wire` fieldset. 29 page routes now, 28 on the front door, 25 in the nav. | — |
| ~~11 parked webhook events~~ | **Superseded.** 19 Lithic parked + 53 dead, 151 Increase parked + 37 dead. `scripts/redrive.mjs` took Increase from 167 dead to 37 and from 52 consumed to **207**. | a card-claim path; the re-drive shipped |
| ~~Three stale memo holds, $60 withheld from nothing~~ | **Repaired, by reversal.** `hold_closure_reversal` holds **3 rows** at 16:41:16Z — the append-only repair, not a deletion. Cited that way deliberately: `v_hold_drift` also reads 0, and it is `WHERE NOT is_released AND memo <> target`, so it is **structurally blind to a spurious closure** and its zero proves nothing here. The reversal count is the evidence; the drift view is not. | — |
| `business_registry` simulated | **Still true.** GLEIF is live and is a labelled *substitution* for Middesk / Persona KYB / Sumsub KYB, all measured gated behind sales. | none available without a real company |
| Five interest days priced before their date closed | **Live, and deliberately held.** The corrector runs on every accrual tick and refuses in three places until `adjusted_on_book_date > accrual_date`. All five report HELD. Error is **$1.85** ($25.20 priced, $27.05 correct). | the first tick after midnight ET |
| Drain cron is daily | **Still true.** Vercel Hobby caps crons at daily; the `after()` nudge covers latency and the row stays `pending` until a consumer succeeds. | one line of `vercel.json` and a paid plan |
| Attack 2: no `hold_closure` row on over-capture | **Still true, and settled by measurement.** Over-capture is *not* terminal — the hold reopens and the network captures exactly that. The money is right; one bookkeeping row is absent. | DECISIONS 049 has the full argument |
| A dead Plaid token in three pushed commits | **Disclosed, deliberately not purged.** Saahith's call: purging means force-pushing 71 commits including the deployed sha, hours before freeze, for a credential granting access to fabricated data. AF5 fails on it every run. | after freeze, or never |

---

## 3. If there is time left after the video

Ordered by points per hour against the rubric.

1. **Deploy the health patch** so a grader loading the URL sees `ok` rather than
   `degraded` — and if it does not deploy, say so in the email. §2 row 1.
2. **Put more cards under a control version.** It is the one number in this build
   that is getting worse in absolute terms while looking better as a ratio.
3. **Join the wire halves in one run.** Twelve dead letters are sitting there
   proving the two halves were never the same wire. One run keyed
   `payment:<instruction id>` closes it.
4. **Re-prove the repaired invariants.** `--prove` now reaches all 31 views;
   `v_standing_order_double_fire` was repaired and has never been made to fail.

**Items 1–4 of the old version of this list are done.** The USDC payout confirms
on chain (twice), both real settlements carry ledger entries, interchange is
posting (331 postings, 114 reversals, 16:22:22Z), and chaos mode shipped
(`/chaos`, 40 runs, 218 events, 112 deliveries). The bitemporal read is live and
driven end to end rather than asserted: `coreloop.mjs` leg 6 at 16:28Z replays a
corrected day on both axes and prints *"Tuesday's figure changed and Wednesday's
belief is still reproducible: the correction is appended at the ORIGINAL value
date, and the pre-correction watermark still returns the pre-correction number.
Nothing was rewritten."* That is most of the old §4 "scope creep worth trying"
section, which is why it is gone. The one item from it nobody built is the
**full `?asOf=&asKnownAt=` console slider** — the model supports it, the
statements screen uses it, and no other screen takes the parameter.

---

## 4. Standing rules that must not slip

- **Never claim a capability that has not been proven by a real call.** Four
  probes have reported LIVE for things that did not exist; each was caught only
  by measuring. A skip is not a pass.
- **State the population beside every statistic.** The published card-auth p50 of
  14.2 ms was true of ten transactions and generalised; over the 85 real provider
  round trips it is **134.6 ms**. A p50 with no population is how that happened,
  and pooling a network lane with an in-process one is how it happened twice.
- **`/api/health` is authoritative.** If any document disagrees with it, the
  document is wrong.
- **Nothing that another worker owns gets committed until they are done.** This
  has bitten three times and each time it turned CI red.
- **The gate is chained with `&&`, never `;` and never through a pipe.** Both
  have silently let a red gate through.
