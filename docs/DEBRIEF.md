# Debrief pack — Track 3, Neobank

75 minutes. Ten of them are a demo; the panel drives the other 65. The failing
condition is **"code you cannot explain line by line when we point at it."**

This document is the whole build compressed: the measurements taken tonight with
the commands beside them, the one argument that organises everything else, the
five ideas to know cold, a tour of every module with the decision in each that a
hostile reviewer would poke, the hard questions answered, and every weakness
volunteered rather than found.

The money path as a diagram is `docs/ARCHITECTURE.md`.

### Rules for the room, in order of how much they help

1. **Answer with the file.** *"That is `src/lib/holds/model.ts`, the fold is
   about forty lines down"* beats a correct answer with no address.
2. **The database is the control; TypeScript is the translation.** Almost every
   "how do you stop X" ends at a trigger, a unique index, a CHECK or a revoked
   privilege. Say which one.
3. **A skip is not a pass.** Where something is unproven, say the sentence that
   names what is missing and the command that would prove it.
4. **If you do not know, say so and name the measurement.** Every good finding in
   this build came from measuring. Every bad one came from assuming.

### If you have thirty minutes before the room, read in this order

| Minutes | Read | Why |
| --- | --- | --- |
| 0–5 | **§0** | The only numbers you are allowed to say out loud, and the three things that moved while they were being taken. |
| 5–12 | **§1** | The organising argument. If you remember one thing, it is the sentence in the block quote. |
| 12–20 | **§2** | The five ideas. These are what "explain it line by line" actually tests. |
| 20–26 | **§4.1, §4.2, §4.3, §4.4** | The four questions that hurt, pre-answered. |
| 26–30 | **§7** | What you cannot explain, so you are never surprised by your own repo. |

`docs/ARCHITECTURE.md` is the one-page money path. §3 is the file-by-file tour —
skim the headings so you know where to look, do not try to memorise it.

---

## 0. Tonight's numbers, with the command and the timestamp

Numbers in this repo have gone stale repeatedly and then been repeated
confidently — live fire was quoted at 7 PASS / 0 FAIL for hours while it was
5/2/1. Every figure below was run by this worker on **2026-09-11 between 04:26Z
and 04:41Z**. Re-run them before the debrief and quote the new run, not this one.

| Command | Result | Taken at |
| --- | --- | --- |
| `node scripts/dbcheck.mjs` | **24 passed, 1 failed** (`interest_posting.basis_balance_cents` flagged as a stored balance) | 04:26:37Z |
| `node scripts/dbcheck.mjs` *(again, 105 s later)* | **26 passed, 0 failed** | 04:28:21Z |
| `node scripts/coreloop.mjs` | **7 PASS / 0 FAIL / 0 SKIP of 7 legs**, 64 s, 94 HTTP calls to the deployed origin + 3 to Lithic, invariants 26/26 | 04:26:37 – 04:27:57Z |
| `node scripts/livefire.mjs` | **7 PASS / 0 FAIL / 1 SKIP of 8 attacks**, 307 s | 04:27:57 – 04:33:04Z |
| `node scripts/livefire.mjs` *(again, 70 s later)* | **4 PASS / 3 FAIL / 1 SKIP of 8 attacks**, 428 s — see §0.2 | 04:34:12 – 04:41:21Z |
| `node scripts/compliance.mjs` | **28 PASS / 2 FAIL / 0 WARN / 4 UNKNOWN / 7 CITED of 41**, 19 s | 04:33:05 – 04:33:24Z |
| `node scripts/audit-claims.mjs` | *no document contradicts the endpoint* — truth is **7 of 7 live** | 04:33:25Z |
| `curl /api/health` | **7 of 7 live**, database reachable 108 ms, commit `4c682e1` | 04:28:33Z |
| `POST /api/mcp` `tools/list` | **8 tools** — 7 read, 1 that queues for a human | 04:29:36Z |

### 0.0 RE-RUN — 2026-09-11 between 09:38Z and 10:02Z, against commit `544b481`

**The table above is left exactly as it was measured at 04:26–04:41Z. This is
the re-run it asks for**, against the deployed origin and the live Neon
database. Quote this one, and re-run it again before the room.

| Command | Result | Taken at |
| --- | --- | --- |
| `curl /api/health` | `status: "ok"`, **7 of 7 live**, database reachable 149 ms, commit `544b481` | 09:38:36Z |
| `node scripts/dbcheck.mjs` | **36 passed, 2 failed** — both failures deliberate, item 1 below | 09:40Z |
| `node scripts/dbcheck.mjs --prove` | **22 of 22 invariant views, 24 proofs**, 8 of them needing a trigger disabled on the owner connection; **61 passed, 2 failed** | 09:41Z |
| `node scripts/livefire.mjs` | **7 PASS / 0 FAIL / 1 SKIP of 8 attacks**, 334 s | 09:43:31 – 09:49:05Z |
| `node scripts/coreloop.mjs` | **6 PASS / 1 FAIL / 0 SKIP of 7 legs**, 84 s, 104 HTTP calls to the deployed origin + 3 to Lithic, invariants 36/2 | 09:49:20 – 09:50:44Z |
| `node scripts/compliance.mjs` | **25 PASS / 5 FAIL / 0 WARN / 4 UNKNOWN / 7 CITED of 41**, 22 s | 09:51Z |
| `node scripts/audit-claims.mjs` | **exit 1 — 7 contradictions**, all of them false positives; §0.0b | 09:39Z |

**Four things in that table are worse than the 04:26Z reading, and they should
read as worse.**

1. **`dbcheck` is 36/2, not 26/0.** Twenty-two invariant views now run where
   fifteen did, and **two of them are deliberate standing reds**:
   `v_refused_auth_hold` (**154 rows** at 09:40Z, every one `verdict =
   'unanswered'`, 130 holds, **$9,786.20** withheld behind a verdict the network
   never gave us — migration 0032 refused to exclude them) and
   `v_hold_expiry_drift` (**9 rows**, all released, **zero cents of exposure** —
   nine fixtures that took two `now()` readings 135–158 ms apart). Both are
   green-able with one `WHERE` clause and both `WHERE` clauses would be
   shaped like the failure. `compliance.mjs` AF3 spawns `dbcheck` and asserts
   exit 0, so **AF3 reports this as a violation**, correctly.
2. **`coreloop` is 6/1, not 7/0.** Leg 4 fails: *"holds moved $0.00, expected
   $50.00"*. The subject also changed — DECISIONS 057 made evidence tier a
   ranking term ahead of the alphabet, so the run is now **Ridgeline Robotics,
   Inc.** (director leg live on Stripe Identity), not Kettle & Crumb.
3. **`compliance.mjs` is 5 FAIL, not 2.** AF1, AF2, AF3, AF5 and G1. AF2 fails
   *only* because `audit-claims.mjs` exits 1 — see §0.0b.
4. **Live fire's SKIP is still attack 2**, and this run degraded its own
   explanation: *"1 passed, 2 skipped — the attack is NOT proven · waiting on:
   (no reason recorded — investigate)"*. A skip that cannot say what it is
   waiting on is worse than one that can, and it is reported here as such.

**What moved the right way, and is not softened:** live fire is 7/0/1 rather
than 4/3/1 — attacks 3 and 7 both now pass every assertion, which is the two
failures the 04:34Z run found being genuinely closed, not re-labelled.

### 0.0b The seven `audit-claims.mjs` contradictions are all false positives

`node scripts/audit-claims.mjs` exits 1 with seven findings at 09:39Z, and
**not one of them is a simulated slot presented as live.** The checker's first
rule matches `/(\d+)\s+(?:live of|of)\s+(\d+)/` and fires on **any** "N of 7"
in any document, whatever the seven are:

| Where | What it reads | What it is |
| --- | --- | --- |
| `DECISIONS.md:2846` | `PASS 7 FAIL 0 SKIP 0 of 7 legs` | coreloop's **seven legs** |
| `docs/CUT-LIST.md:42` | `PASS 6 · FAIL 1 · SKIP 0 of 7` | coreloop's seven legs again |
| `docs/CUT-LIST.md:87` | `understood the spelling "N of 7" only` | the log **quoting the checker's own historical bug** |
| `docs/RAILS.md:66–69` | `5 of 7`, `4 of 7`, `6 of 7`, `3 of 7` | the rail capability matrix's **seven adapters** |

Three separate populations of seven, none of them integration slots. The
checker's second rule — the one that would catch an automatic fail — reports
nothing, and `/api/health` has **no simulated slot** for it to catch. **This is
instance 4 of §1 recurring in the same tool**: 033 recorded that the auditor
understood one spelling of the claim; the fix taught it a second spelling and
did not teach it what the denominator *means*. The honest repair is to require
the word `live` next to the number, or to scope the rule to lines naming a slot,
and it is one line in a script this worker may not edit. **Until it lands,
`compliance.mjs` AF2 will read FAIL for a reason that is not AF2.**

**Say the second dbcheck row out loud.** Two runs of the same command, 105
seconds apart, gave different answers — 24/1 then 26/0 — because another worker
landed a fix to the stored-balance check between them. Twelve agents are writing
this repo right now. That is not an excuse; it is the reason every figure here
carries a clock.

### Two things moved *during* these measurements, and both matter

**Migration `0026_auth_result.sql` was applied at 04:32:15Z.** At 04:30:22Z I
queried `schema_migrations` and it was not there; `card_auth_event` had columns
`id, auth_id, kind, amount_cents, is_final, value_date, provider_event_id,
inbox_id, received_at` and no result column. At 04:33:01Z the table
`card_auth_event_result` held **753 rows: 253 APPROVED, 67 DECLINED, 1
UNAUTHORIZED_MERCHANT, 1 UNKNOWN_HOST_TIMEOUT, 431 NULL** (no retained payload to
backfill from). **So the livefire run at 04:27:57–04:33:04Z straddles that
deploy**, and attacks 1 and 2 in it ran under the old regime where a declined
authorisation was ingested as an approval. DECISIONS 050 predicted those two
attacks would fail once declines stopped counting and said *"that is the correct
outcome"*. A second run was started at 04:34:12Z for exactly this reason; quote
whichever run is most recent when you walk in.

### §0.2 Live fire ran twice and disagreed with itself, and the reason is not the system

**7 PASS / 0 FAIL / 1 SKIP at 04:33:04Z. 4 PASS / 3 FAIL / 1 SKIP at 04:41:21Z.**
Same suite, same deployment, seventy seconds apart. Say the second number, and
then say why — because the diagnosis is the interesting part and it is already
written down in the decision log, by name, as a thing that was not fixed.

```
1  $50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move    FAIL
     AssertionError: expected 50000n to be 45000n
2  $73.40 capture: hold released exactly once, available not clamped FAIL
     AssertionError: expected 45000n to be 40000n
3  Backdated reversal: corrected figure AND as-believed, both at once FAIL
     ReferenceError: nextDayStatement is not defined
7  Issuing-provider webhook outage degrades visibly                  SKIP
     Lithic never crossed its 180s staleness threshold within 309s of
     deliberate silence (6 restart(s) — something is still delivering)
```

**Attacks 1, 2 and 7 are the same cause: the book is not quiet.** Attack 1 picks
its subject with `ORDER BY dep.business_id LIMIT 1` — the lowest uuid, a
**shared** business — and then freezes that business's **whole position** across
the window rather than attributing the delta to its own hold. The two failures
are off by exactly `5000` and `5000`: one other agent's $50 authorisation landed
inside the window. Attack 7 could not induce its outage for the same reason —
something else kept delivering, so Lithic never went stale.

**DECISIONS 028 named this exact defect and declined to fix it:** *"attack 7's
money assertions froze a shared business's whole position, so another worker's
suite moving that ledger by 67,899 cents inside the 20-second window produced a
false FAIL blaming our system for someone else's writes. Now asserted by
attribution… **Attacks 1, 2 and 4 carry the same latent vulnerability and are
untouched because they passed — noted rather than fixed.**"* Attack 4 still
passes because it asserts deltas between two episodes it created itself. **The
latent vulnerability fired tonight, in the two attacks that were left with it,
and the entry that predicted it is three days of work old.** None of this is a
money error: the trial balance is 0, `v_hold_drift` is empty, `v_hold_release_drift`
is empty, and `dbcheck` is 26/26 through both runs.

**Attack 3's failure is different and it is a real code defect that landed
tonight.** `ReferenceError: nextDayStatement is not defined` in
`src/test/livefire/attack-03-bitemporal-correction.test.ts` — a genuine
undefined identifier, and the same run's evidence string printed
`closing undefined`, `difference NaN` and thirty-nine `[object Object]`s where
the statement lines should be. The **second** instance of part B in the same run
completed correctly and printed real numbers (`as-believed@seq2561 closing
3121735 over 43 lines; as-corrected closing 3114395 over 44 lines`, the added
line `−7340` at the original's value date), so **the bitemporal claim itself is
demonstrated and the test around it is broken.** Do not present that as a
success; present it as an attack that cannot currently report.

**What to do with this in the room.** Re-run the suite before the debrief when
the repo is quiet, and if it still reads 4/3/1, walk them through this section
rather than the scoreboard. The suite failing honestly against a noisy book is
worth more than a green number from a run that got lucky — and it is the
fourteenth instance of §1 wearing yet another set of clothes: *the quiet-window
guard counts entries in the financial book to protect a quantity the memo book
moves.*

### §0.3 Migration 0026 is applied and production is not writing to it

Measured at 04:43:29Z: **33 `card_auth_event` rows ingested since 04:34Z, and
zero corresponding `card_auth_event_result` rows** — every one reads
`result = NULL`, `source = '-'`. The 753 rows in that table are entirely the
migration's own backfill from retained payloads.

So the state right now is: **the schema is fixed, the code is written
(`lithic-events.ts` now has 29 occurrences of `result`/`APPROVED`/`DECLINED`
where it had zero), and the running deployment predates both.** `/api/health` at
04:28:33Z reports commit `4c682e1`. Until that is redeployed, **a declined
authorisation is still holding the customer's money in production.** That is the
single most important sentence in this document, and it will hopefully be false
by the time anyone reads it — check before you say it.

**`src/lib/holds/model.ts` changed at 04:31Z.** `terminallyClosed` is now
`sawFinal || sawClose || expired` — the non-monotone `A <= 0` arm that DECISIONS
051's fuzzer found has been removed. `closed` is unchanged, which is correct:
`closed` is the term `v_card_auth_hold.is_closed` is held equal to by
`v_hold_drift`, and `terminallyClosed` is the term that licenses an append-only
`hold_closure` row. **The comment in that file cites "migration 0028", and
migration 0028 does not exist on disk.** If someone greps for it in the room, that
is the honest answer: the TypeScript half landed and the SQL half is queued.

---

## 1. The organising argument — twenty-two guards, one failure shape

> **RECONCILED 2026-09-11T09:55Z.** This section used to say *fourteen*, and
> three other documents were counting the same pattern with three different
> numberings: `DECISIONS.md` 056 said *nineteen*, `docs/COMPLIANCE.md` §5 was
> headed *"sixteen, seventeen and eighteen"*, and `docs/EVALUATION.md` called
> `card_auth_event`'s missing `result` column *"the fifteenth guard"* where the
> table below numbers it **13**. They are now one list with one numbering, and
> **the numbering below is the canonical one** — rows 1–14 are unchanged, so
> every `instance N` back-reference elsewhere in this document still resolves.
> Eight instances are appended; the total is **22**. The working is in
> `DECISIONS.md` 058, and the inclusion rule is stated under the table.

This is the most interesting thing this build has to say, and it goes first
rather than buried in an appendix at the end.

> **Every guard that failed in this build failed because what it excluded was
> shaped exactly like the failure it existed to catch — and every one of them
> reported healthy while blind.**

`v_hold_drift` is `WHERE NOT is_released`, and the bug it missed *is a spurious
release*. The secret scanner used plain `grep`, and a credential hidden in a
binary-looking file is exactly what plain `grep` cannot see. The escalation gate
required *every* slot live, and an outage is what makes a slot not live.
`card_auth_event` has no column for whether an authorisation was declined, so a
decline and an approval were literally the same row. Attack 7's quiet-window
guard counted entries in the **financial** book to protect a quantity the **memo**
book moves.

Two of the first fourteen were claims *I* wrote down and had to retract.

### The table

| # | Guard | The exclusion | What it let through | Where |
| --- | --- | --- | --- | --- |
| 1 | `v_hold_drift` | `WHERE NOT is_released` | a wrong closure row — $60.00 withheld from nothing | 026, 033 |
| 2 | secret scanner | plain `grep` (binary skip) | 1,206 lines after a NUL byte in `inbox.ts` | 023, 033 |
| 3 | escalation gate | `slots.every(live)` | any outage, once one slot was honestly `unprobed` | 028, 033 |
| 4 | doc auditor | understood `"N of 7"` only | it read past `"4/7 live"` — its own log's other spelling | 027, 033 |
| 5 | secret scanner v2 | `0x` + 64 hex *shape* | would have fired on 24 curve constants and been switched off | 032, 033 |
| 6 | `v_deposit_control_drift` | **reported** side was a flat `code = '2100'` | a pot: subtree 13,577,077 vs reported 13,527,077 — **my own written claim that it "cannot silently break"** | 041, 045 |
| 7 | `reconcile-usdc.mjs` | one address from the environment | a second wallet: 90¢ of "drift" reported against a ledger that was exactly right — **my own premise** | 044, 045 |
| 8 | `v_standing_order_double_fire` | joined on a **UNIQUE** column | everything — the count it tested could not exceed 1, so the view was tautologically empty. **Repaired by migration 0023 and, on 2026-09-11, made to fail for the first time** — see §5.4 | 045, 058 |
| 9 | probe `fromStatus()` | any non-auth 4xx ⇒ `live` | a 404, which Lithic answers with **no credential at all** — 011 wearing the costume of the fix for 011 | 045 |
| 10 | Stripe Connect probe | an `else` branch meaning "success" | a **dashboard click in another tab** flipped `/api/health` to `business_registry: live` while the leg was still the simulator. No code changed. No deploy happened. | 034 |
| 11 | `probeIntegrations()` fallback | a slot with **no probe** inherited the env-derived status | `card_webhooks` read LIVE with evidence reading *"no probe defined for this slot"*. Four probes had this bug and I fixed each one; the fifth was the fallback, and I never looked at it because I was checking the probes rather than the thing that runs when there is no probe. | 026 |
| 12 | `compliance.mjs` AF6 stamp check | only sees a decrease against the **immediately preceding** entry | 4 duplicated timestamps exist; it reports 3. *"A guard that catches half a defect and reports a count is more dangerous than one that catches none, because the count reads as complete."* | 047 |
| 13 | `card_auth_event` | **the column itself** — there is no `result` | 60+ authorisations the network **refused** raised `A(E)` at full value. 24 were still withholding **$1,151.00** across three businesses. Attacks 1 and 2 were passing *because we ingested declines as approvals.* | 050 |
| 14 | `terminallyClosed`'s `A <= 0` arm | a predicate on a running total **that can go back up**, licensing a permanent row | `{authorization 0}` ⇒ closed for ever; a later incremental reopens `H` to 1. A $0 card-on-file verification split across two deliveries — *the ordinary case, and exactly the case the brief tells you to survive* — permanently closes the hold, writing `reason = "authorisation fully reversed"`, **a false statement in an append-only audit table**. | 051 |
| 15 | `IncreaseAchRail.parseEvent` — and the **test fixture** that proved it worked | `startsWith('ach_transfer_')`, while the test's `eventBody` helper hardcoded `associated_object_type` and varied only the id | every id Increase's sandbox issues is `sandbox_ach_transfer_…`, so the whole ACH rail answered `200` and discarded. The first instance where the blind spot was a **fixture holding constant the field under test**, not a view's `WHERE`. | 052 |
| 16 | `v_refused_auth_hold` | `INNER JOIN card_auth_event_result` **and** `r.result IS NOT NULL` — the two ways this schema spells *we have no verdict* | 98 of 130 authorisation events on holds withholding money (75%), $5,665.60, invisible to the guard that exists to catch exactly a lost verdict. Repaired in 0032. | COMPLIANCE §5.1 |
| 17 | `/api/health` webhook freshness | `MAX(webhook_inbox.received_at)` — **arrival**, which is not disposition | a rail receiving everything and processing nothing read as *maximally fresh*, with 179 Increase deliveries verified and dead-lettered 4 minutes before the reading. | COMPLIANCE §5.4 |
| 18 | `coreloop.mjs` subject ranking | read `kyb_evidence` out of `v_business_kyb` and then **never used it** | the alphabet picked "Hold Fuzzer Fixture Co.", approved by `simulated-hold-fuzzer`, to demonstrate leg 1's *"real KYB check"*. | COMPLIANCE §5.5, 057 |
| 19 | `v_hold_closure_not_terminal` | a population chosen by matching **English** against a free-text `hold_closure.reason` | 64 of 184 closures (35%) outside the guard by *wording*, including 0032's own. Repaired by 0040's `source` column. | 056 |
| 20 | `v_accrual_month_drift` | `WHERE month_complete` — over **zero** complete accrual months | vacuous: green because there is nothing to be green about. Its predicate is sound; its population is empty, which is a different failure and now prints under GUARD REACH. | 056 |
| 21 | `scripts/audit-claims.mjs` | compares documents to `/api/health` and **never compares `/api/health` to the tree** | the authority every document is checked against can be a build nobody in this repository is looking at, and the check cannot see that it is. Still open — COMPLIANCE §5.7. | 056 |
| 22 | `v_balance_definition_drift` | it compares the definitions of "available" **it has been told about** | the agent surface kept a fifth, unregistered definition and told an agent it had **$17,035.50 more** than the customer's own screen said. | 054 |

**The inclusion rule, stated so the count can be checked rather than believed:**
a row belongs here when a check, view, probe, gate or test **reported healthy
because the defect was outside its population by construction** — the `WHERE`,
the `every`, the `else`, the missing column, the fixture that pinned the field
under test, the population that was empty. Two things adjacent to this pattern
are deliberately **not** counted, and naming them is the only way the number
means anything: a guard that is correct but that **nothing runs**
(`v_wire_availability_drift` and `v_hold_release_drift` both sat in that state —
five invariants in this build have), and a **defect a new guard found**
(`v_hold_expiry_drift`'s two clocks, 0040). Neither is a guard with a blind
spot. Counting them would have made the number 27 and the number would have
meant less.

Instances 1–5 are DECISIONS 033's table. 6–9 are 045's extension. 10, 11 and 12
are recorded in 034, 026 and 047 without being numbered into either table. 050
calls itself the thirteenth, 051 is the fourteenth and 052 calls itself the
fifteenth. 16–18 are `docs/COMPLIANCE.md` §5, which numbered them *sixteen,
seventeen and eighteen* and was right. 19–21 are DECISIONS 056's three, which
called itself *"bringing the count to nineteen"* — it had the right three and
the wrong total, because it counted 16 before them when COMPLIANCE §5 had
already taken 16, 17 and 18. 22 is DECISIONS 054, which described the instance
and never numbered it. Ordered by the timestamp of the entry that recorded each,
that is **22**, and `DECISIONS.md` 058 shows the arithmetic line by line.
**If the panel counts and gets a different number, that gap is real and I would
rather say so than defend a count.** The numbering is not the point; the shape
is.

### The rule, phrased so it can be pushed back on

> **A guard must be tested against the thing it guards against, not merely run.**
> Running it proves it does not crash. Only the failure case proves it can *see*.

And the stronger form the two self-asserted instances earn:

> **A guard whose exclusion clause you cannot state in one sentence is not a
> guard you have understood.**

By that standard three of the first nine were never understood by the person who
wrote them, and that person was me.

**The counter-argument worth having in the room** is that this is just "write a
negative test". It is more than that, and the difference is where the negative
test comes from: it has to be built out of the guard's own **exclusion clause** —
the `WHERE`, the `every`, the `else`, the missing column — which is the line
nobody reads twice.

### The honest order, because it keeps getting worse rather than better

- **1–4 were found by accident**, one at a time, by something else failing: an
  evaluator's clean scan, a README worker refusing a claim it could not justify,
  a live-fire run, a stale email.
- **5 was the first found on purpose**, after the pattern was already written down.
- **6 and 7 were found by building the next feature** — pots broke the view,
  Circle broke the reconciler. So the rule written down in 033 did not prevent
  either of them. The features did.
- **8 and 9 came from applying the rule deliberately, and took minutes.** The rule
  is cheap and I did not spend it until 045.
- **13 was found while settling an unrelated argument** about over-capture.
- **14 was found by a fuzzer** built the same night, which paid for itself on its
  first run — and it found the mistake *this log had already made twice*:
  migration 0011 declined a `C >= A` arm because it would "write a PERMANENT
  closure row on a condition a later incremental authorisation can undo", and
  DECISIONS 049 declined the same arm again an hour before on a fresh
  measurement. **The `A <= 0` arm *is* such a condition, sits one line away, and
  neither pass looked at it.** Being right about a line is not the same as being
  right about the file.

### Why this is the argument and not the apology

A team that can name its own failure mode precisely — with twenty-two worked
examples, the exclusion clause in each, and the measurement that caught it — is
demonstrating the thing the trial says it is testing. The alternative version of
this submission has most of these still undiscovered and a README that says every
invariant passes. That version scores better on a checklist and is worth less.

---

## 2. The five ideas to know cold

### 2.1 The bitemporal ledger — `value_date` and `booking_seq` are independent axes

`value_date` is the business day the money belongs to. `booking_seq` is the
position at which we learned about it. **Neither is derivable from the other**,
and every as-of question is two predicates on one query:

```
value_date  <= X     which business days count
booking_seq <= Y     what we had learned by then
```

Fix the booking axis and vary the value axis: you get statements. Fix the value
axis and vary the booking axis: you get *"what did we believe about Tuesday, as of
Wednesday"* — the question most ledgers cannot answer at all.

`booking_seq` and not `booking_time`, because NTP can step a wall clock backwards,
and because the sequence is drawn *while holding the append advisory lock* —
`pg_advisory_xact_lock(hashtext('ledger_append:' || p_entity::text))` then
`nextval('journal_booking_seq')` — so sequence order **is** commit order, and an
as-of snapshot can never gain rows below its watermark later.

**The decision a reviewer would question:** *"You denormalised `value_date` and
`booking_seq` onto `journal_line`. That is a cache."*

Normally yes, and it is safe here for one specific reason: **the source row is
immutable**, so there is no update path that could change one and not the other.
It buys an index-only scan for every balance query
(`journal_line_balance_idx (account_id, value_date, booking_seq) INCLUDE
(amount_cents)`), it is written only by `ledger_append()`, and
`v_line_denorm_drift` is an invariant view that must return zero rows — it did at
04:28:21Z. **A cache whose inputs cannot change is memoisation of a pure function;
a stored balance whose inputs are mutable always drifts.**

Where: `src/lib/ledger/balances.ts` (`ledgerBalanceAsOf` is one predicate,
`balanceAsBelieved` is both), `db/migrations/0001_ledger.sql` `ledger_append()`,
`src/lib/statements/read.ts` (its header states the two predicates and calls a
statement "a rectangle in the (value, booking) plane, fixed forever once both
edges are fixed").

**Measured tonight**, coreloop leg 6, account `2eb04bde…`, both axes at once:

```
value_date    original 2026-09-11   correction 2026-09-11   SAME DAY
booking_seq   original 2319         correction 2344         LATER
as believed   $502,479.36   read at watermark 2319
as corrected  $502,405.96   read at watermark 2344
difference        −$73.40   exactly the refund taken back
```

Tuesday's figure changed. Wednesday's belief is still reproducible. Nothing was
rewritten; the only verb is `INSERT`.

---

### 2.2 The signed-amount convention — debit positive, credit negative, `SUM = 0`

`journal_line.amount_cents` is a **signed `bigint`**: a debit is positive, a
credit is negative. There is no direction enum and no magnitude column.

The payoff is that the two hardest invariants collapse into the same aggregate:

```
"this entry balances"      SUM(amount_cents) = 0
"this account's balance"   SUM(amount_cents)
```

…multiplied by the account's `normal_side` (+1 debit-normal, −1 credit-normal)
**only at the point a human reads it**. No `CASE` in any hot query, and exactly
one place where the two conventions meet.

The vocabulary that goes with it, because it gets asked: a customer's deposit is
**our liability**, so `2100` is credit-normal. The customer *having* money is the
bank *owing* money. The operational consequence is the one that matters —
**money leaving the customer's account is a DEBIT** to their deposit account,
because we now owe them less. That is why a bank statement shows deposits in the
credit column: it is written from the bank's side of the book.

**The decision a reviewer would question:** *"A raw line reads `-5000` for a $50
credit. That is unreadable."*

It is, and the trade is deliberate: the unreadability is confined to raw rows,
and the views translate. The alternative — a `direction` enum plus a magnitude —
makes every balance query a `CASE`, and makes "does this entry balance?" a
different expression from "what is this balance?", which is exactly the pair you
want to be the same expression. The price is paid by whoever reads `journal_line`
directly, which is a debugging activity, not a product one.

**Where:** `db/migrations/0001_ledger.sql` — `amount_cents bigint NOT NULL CHECK
(amount_cents <> 0)`, `account.normal_side` as `GENERATED ALWAYS AS … STORED`,
`v_ledger_balance`. The zero-amount CHECK is why the un-posted USDC gas (269,058
wei ≈ a tenth of a cent) *cannot* be posted rather than merely being un-posted.

Balance enforcement is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger,
because lines are inserted one at a time and a non-deferred trigger fires after
the first line and always fails. There is a **mirror trigger from the entry side**
for the "entry with no lines" case, which the line-side trigger by construction
cannot see. `assert_entry_balanced()` requires each **currency** in an entry to
net to zero independently — which is why USDC is carried in cents rather than as
its own currency: an entry whose debit is USD and whose credit is USDC could not
balance without an FX bridge account pair this chart does not have.

---

### 2.3 The hold model — a pure function of an event set

```
A(E)      = Σ {authorization, incremental_authorization} − Σ {authorization_reversal}
C(E)      = Σ {clearing, force_post}
closed(E) = sawFinal ∨ sawClose ∨ expired ∨ (E ≠ ∅ ∧ A(E) ≤ 0)
H(E)      = 0                      if closed(E)
          = max(A(E) − C(E), 0)    otherwise
```

`H` is built out of Σ, ∃, `max` and one clock comparison over a **set**. Every one
of those is invariant under permutation. **So a settlement that arrives before its
own authorisation is not a case to handle — it is the same set assembled in a
different order, and a function of a set cannot tell the difference.** There is no
status column on `card_authorization` for an arrival order to corrupt.
Deduplication is structural, not logical: `card_auth_event` is
`UNIQUE (auth_id, provider_event_id)`, so a redelivered webhook never enters `E`.

**This was derived from first principles before it was measured, and then it
reproduced the provider's own arithmetic.** DECISIONS 006, measured against the
Lithic sandbox:

```
authorize 1000            status=PENDING   hold=-1000  settled=0
clearing 600  (partial)   status=SETTLED   hold=-400   settled=-600
clearing 300  (2nd)       status=SETTLED   hold=-100   settled=-900
authorize 5000            status=PENDING   hold=-5000  settled=0
clearing 7340 (over-cap)  status=SETTLED   hold=0      settled=-7340
```

**Lithic's `status` flips to SETTLED while a partial hold is still live.** A
consumer releasing on `status == "SETTLED"` — the obvious implementation — frees
400 cents that are still authorised. `amounts.hold.amount` is also signed
negative. Both traps are avoided by **not reading either field**. The design's
decision to give `card_authorization` no status column is empirically justified,
not merely tasteful.

**The decision a reviewer would question:** *"Why is there no `C >= A` arm? On an
over-capture the hold is obviously finished."*

Arithmetically the arm is a **no-op for `H`** — `max(A − C, 0)` is already 0 once
`C` reaches `A`. Its only effects are the append-only `hold_closure` row and
`v_hold_state.is_released`, which forces the hold to 0 *regardless of the memo
balance*. Both are claims about what happens **next**, so the arm is safe only if
over-capture is terminal. **It is not, and this was measured tonight** — live fire
attack 2 re-takes the measurement on every run. Lithic transaction
`4d9ddc8d-1924-47f6-90ba-35c83be59d0e` at 04:29Z:

```
simulate/authorize 5000                 201
simulate/clearing  7340                 201  SETTLED, amounts.hold = 0
simulate/authorization_advice 9000      201  APPROVED    <- the hold REOPENS
simulate/clearing  1660                 201  settlement now -9000
```

Our model over the same events: `A=5000 C=7340 H=0`, then `A=9000 C=7340 H=1660`
— and **the network then captured exactly that 1660.** Lithic's own
`amounts.hold.amount` read `0` throughout and was wrong; our arithmetic predicted
the money the merchant actually took. A closure row written one event earlier
would have freed $16.60 that was still authorised — the exact failure shape
migration `0011` exists to clean up.

**`closed` versus `terminallyClosed`, which is the subtlety and is instance 14.**
`closed` is the term `H` uses and the term `v_card_auth_hold.is_closed` is held
equal to by `v_hold_drift`. `terminallyClosed` is the term that licenses writing a
**permanent** `hold_closure` row. They differ by the arms a later event can undo.
As of 04:31Z tonight `terminallyClosed = sawFinal || sawClose || expired` — three
arms, all monotone — because the fuzzer shrank a counterexample to two events:

```
E1 = { authorization 0 }                  -> terminallyClosed = TRUE
E2 = E1 ∪ { incremental_authorization 1 } -> terminallyClosed = FALSE, H = 1
```

A **$0 authorisation is card-on-file verification.** Lithic sends
`AUTHORIZATION amount:0`, then an advice carrying the real figure. In one payload
it is harmless. Split across two deliveries — the ordinary case — the first
delivery closed the hold for ever.

**The property is measured, not asserted.** `src/lib/holds/fuzz.test.ts`: 25,720
sets and 98,611 orderings in 0.6 s on every `pnpm test`; **1,286,000 sets and
6,257,911 orderings** under `FUZZ_EXHAUSTIVE=1`. Zero disagreements —
byte-identical `HoldState`, not merely equal `holdCents`. One precondition is now
explicit rather than assumed: two events sharing a `providerEventId` with
different contents make `holdState()` order-dependent (first wins), and
`UNIQUE (auth_id, provider_event_id)` is what makes that unreachable.

---

### 2.4 Four-layer immutability

The automatic-fail clause is *"UPDATE or DELETE on money rows. Anywhere. Ever."*
Four layers, and each catches an actor the others cannot.

**Layer 1 — privileges.** The application opens exactly one handle, on
`APP_DATABASE_URL`, as `corgi_app`, which holds `SELECT, INSERT` on the money
tables and nothing else. Not "does not update" — **cannot**. The owner URL
(`DIRECT_URL`) is used only by `scripts/migrate.mjs` and `scripts/seed.mjs` from a
terminal and is never imported into the app. Measured 04:28:21Z: `UPDATE`,
`DELETE` and `TRUNCATE` on `journal_entry` and `journal_line` all refused with
*"permission denied for table journal_entry"*; grants read `INSERT,SELECT` on
`journal_entry`, `journal_line`, `card_auth_event`, `hold_closure`.

**The story is the point.** The `REVOKE` was correct from hour one and worth
nothing at runtime, because the app connected as `neondb_owner` and **privileges
never bind the table owner**. `pnpm db:check` reported 9 failures of 14 the first
time it was ever run (DECISIONS 008). It also found a second-order false negative:
under the owner role the money tables were empty, so `UPDATE … WHERE true` matched
no rows, the `FOR EACH ROW` trigger never fired, and the statement *succeeded*. As
`corgi_app` the privilege check fires **before row matching**, so the refusal is
proven even against an empty table.

**Layer 2 — triggers.** `BEFORE UPDATE/DELETE` row-level refusals on every money
table (there are 40+ such triggers in the live schema), plus a **statement-level**
one for TRUNCATE — which is why TRUNCATE was refused even as the owner while
UPDATE was not. Triggers catch a future migration, or a human in `psql`, where
privileges do not bind. Also here: `assert_entry_balanced()` and
`assert_maker_checker()`.

**Layer 3 — no `ON CONFLICT DO UPDATE` on a money table.** The only conflict
action is `DO NOTHING`. An upsert is an `UPDATE` wearing an `INSERT`'s clothes.
`ledger_append()` looks the idempotency key up first and, on a replay, returns the
original entry id and writes nothing.

**Layer 4 — the SHA-256 hash chain.** Each `journal_entry` carries `prev_hash` and
`hash`, chained, computed inside `ledger_append()`. Layers 1–3 bind the
application. Layer 4 **detects** an operator holding the owner role, which is the
only actor the first three cannot bind.

**The decision a reviewer would question:** *"`ledger_append()` is `SECURITY
DEFINER`. That is a privilege-escalation shape."*

It is the textbook one, and I checked rather than assuming. A definer function
executes with the owner's privileges but resolves unqualified names — `digest`,
`nextval`, `format` — through the **caller's** search path. On Postgres 18
`public` no longer grants `CREATE` to `PUBLIC` and
`has_schema_privilege('corgi_app','public','CREATE')` is false, so it was latent,
not live. **Closed anyway in migration 0003**, because "not exploitable today"
rests on a default that one future `GRANT` would silently undo and the blast
radius is the ledger: `SET search_path = public, pg_temp`. **`pg_temp` is named
explicitly and placed LAST on purpose** — omit it and Postgres searches it *first*,
so a caller can shadow those same names with a temp object and the hole reopens.
`CREATE` on schema `public` is revoked from `corgi_app` explicitly rather than
relied on as a version default.

**One grant-hygiene rule, because it nearly bit.** Granting `SELECT` on the views
required `GRANT SELECT ON ALL TABLES IN SCHEMA public`, which hands back
privileges on the money tables as a side effect. Every blanket `GRANT` is followed
by the explicit `REVOKE UPDATE, DELETE, TRUNCATE` and **then by the prover**. A
privilege model you cannot re-verify after every change is a privilege model you
do not have.

---

### 2.5 The evidence lattice — `live < manual < simulated`

Three evidence labels, in an **ascending weakness order**. That ordering is what
makes the design free: the existing worst-wins fold over a business's verification
legs needed **no special case at all** when `manual` was added, and the same order
is the declaration order of the `kyb_evidence` enum, which is what lets the view
say `max(evidence)`.

- **`live`** — a real authenticated third-party call returned 2xx.
- **`manual`** — a **named, accountable human** read the file and wrote down why.
  A human is not a third party, so an operator's decision cannot be `live`. A
  named person with a written reason is not a fixture, so it cannot be
  `simulated`.
- **`simulated`** — a fixture.

**Liveness is earned by a round trip, never by a credential existing.**
`probeIntegrations()` distinguishes five outcomes that must never be collapsed:

```
live            a real authenticated call returned 2xx
unauthorised    the credential exists and the provider REJECTED it
unreachable     network or provider failure — we do not know
unprobed        we have not asked; we DECLINE TO CLAIM it
not_configured  no key at all
```

Only `live` earns the LIVE label. `unreachable` deliberately does not: saying
"live" on a hopeful guess is the precise failure being guarded against. The
asymmetry is the whole point — **over-claiming is the automatic fail,
under-claiming is merely pessimistic** — and `consistency.test.ts` encodes it
directly: no nested slot may disagree with the authoritative table, and `live`
appearing anywhere it is not authoritative is the thing being caught.

**The decision a reviewer would question:** *"You are grading your own homework.
The probe decides what LIVE means."*

Which is why the rule is stated more precisely than "probe the capability":
**probe with the call that the slot's real work depends on, and confirm it fails
when the capability is absent. A probe nobody has watched fail is not a probe.**
Four probes had this bug and every one looked green:

- **011** — placeholder keys: a string's existence marked four slots LIVE.
- **015** — Stripe via `GET /v1/balance`: proves the *credential*, not the
  *Connect capability* the slot's work runs through.
- **016** — USDC via `balanceOf`: we held 20.00 USDC and **0 wei of gas** and
  could not move a cent. The slot's job is payouts. This one overstated a slot I
  was counting as one of my two live integrations, in a README and in an email to
  Corgi.
- **017** — Stripe via `GET /v1/accounts`: **also** returns 200 with Connect
  disabled, because reading connected accounts is permitted when you have none
  and cannot create any. I replaced a wrong probe with a differently wrong probe
  and wrote a decision entry congratulating myself for it. The probe that actually
  distinguishes is a parameterless `POST /v1/accounts`, because Stripe evaluates
  the entitlement *before* it validates parameters — and nothing is created in
  either case, which is what makes it safe from a health endpoint.

**Where the lattice is enforced in SQL**, because "an agent cannot approve a KYB
leg" is a nine-constraint claim and not a one-line one: the composite FK
`(decided_by_actor_id, decided_by_kind) → actor(id, kind)`; an **equality** check
so a manual row must name a reviewer and a provider row must not; a **human-only
kind check**; a twenty-character minimum reason; the `operator-review` provider
name and `manual.` reference prefix; and two more that stop a reason being
smuggled onto a provider row. **The FK alone is `MATCH SIMPLE`**, so a composite FK
is satisfied whenever *any* referencing column is NULL — a row carrying an agent's
uuid with a NULL kind sails straight through it. `docs/KYB.md` prints six of the
constraints and omits `kyb_leg_reviewer_kind_matches`, which is the one that makes
the headline constraint work. **That document is wrong and this paragraph is
right.**

---

## 3. The guided tour — every module, and the one decision to poke

*Format: what it is, then the single decision inside it a hostile reviewer would
go after, then the answer. "It is well tested" is worthless. The register is
"`listBusinesses` LEFT JOINs, so a business with no account is a row rather than a
silence."*

### 3.1 `db/migrations/0001_ledger.sql` — the schema (1,187 lines)

Tables, the four immutability layers, `ledger_append()`, and every derived view.
Every money write in the system goes through one `SECURITY DEFINER` function that
takes the append lock, draws `booking_seq`, forces `booking_time` monotonic with
`GREATEST(clock_timestamp(), last + 1µs)`, extends the SHA-256 chain, and writes
the denormalised clocks onto the lines.

**Poke:** *"`booking_time` is forced monotonic. You are lying about when things
happened."* — No: `booking_time` is a display and diagnostic field and
`booking_seq` is the axis every query uses. The `GREATEST` exists so that two
entries appended in the same microsecond do not sort ambiguously in a human-facing
list; the ordering that matters is the sequence, drawn under the lock.

### 3.2 `src/lib/ledger/post.ts` — the posting API

`postEntry()` is the **only** caller of `ledger_append()` in the codebase.
`reverseAndRebook()` is the correction path: reverse at the **original's**
`value_date`, then re-book, both sharing a `correction_group_id`.

**Poke:** *"Why is `postEntry` a thin wrapper? Write the SQL where you need it."*
— Because every guarantee that makes this ledger trustworthy lives inside
`ledger_append()` *under the advisory lock*, and `corgi_app` legitimately holds
`INSERT`. A caller writing its own `INSERT` would get none of them: no lock, no
sequence, no hash chain, no denormalised clocks, no idempotency lookup. The
boundary is enforced, not requested — see 3.3.

### 3.3 `src/lib/ledger/boundary.test.ts` — the ratchet

Fails if any module outside `src/lib/ledger/**` writes SQL against
`journal_entry`, `journal_line` or `account`. There are **235 such references
across 50 files**, all allowlisted with the owning module named. Heaviest:
live-fire 33, pots 29, statements 23, holds 19, rails 16.

**Poke:** *"An allowlist of 235 exceptions is not a boundary."* — It is a
**ratchet**: a file may hold fewer than its recorded count, never more, and an
entry paid off must be deleted. The list can only shrink. And it caught its own
author on the first run — the change that *added* the test also added
`SELECT id FROM account WHERE code = '1110'` from outside the ledger module. It is
now `houseAccountId('1110')`, which is the first payment against the 235 rather
than the first exception to them. **A guard that only catches other people is not
a guard.**

### 3.4 `src/lib/ledger/balance-definitions.ts` + `ledger_availability()` (migration 0022)

**A view cannot take an argument and a balance question has three** — which
business day, which watermark, which instant. So the canonical definition is a
Postgres **function**. `v_available_balance` calls it. The TypeScript calls it.
Neither *contains* a definition, so neither can drift. That is the `v_hold_drift`
bargain kept **by construction** rather than by invariant.

**Poke:** *"Future-dated credits are excluded but future-dated debits are
subtracted. That is inconsistent."* — It is asymmetric on purpose, and the
asymmetry is the argument. **Available is the money you could spend right now
without relying on something that has not happened yet.** A future-dated credit is
not available: a customer cannot spend tomorrow's settlement today, and before
0022 `availableBalance()` was handing the demo business **$9,857.00 of credits
value-dated 2027** as spendable money. A future-dated debit is subtracted anyway:
$37,462.00 is already booked to leave, and a customer who can spend it again in
the window before it settles is a customer we overdrew on their own behalf. **A
definition symmetric in *value date* is asymmetric in *risk*, and the risk is
whose money it is.** Ridgeline's available became **−$1,831.68** and that is the
honest number.

**The measurement that forced it.** At 02:31Z, two screens, same account, same
instant: Ridgeline read $8,025.32 on the accounts console and $30,630.32 on the
funding screen — **$22,605.00 apart**. Kettle & Crumb read −$220.20 and
−$17,220.20 — **$17,000.00 apart**, and *that* gap was not known: the funding
screen excluded future-dated credits from its ledger term and then subtracted the
uncleared-credit holds guarding those same credits, **charging the customer for the
same dollar twice**, $17,000.00 on an account holding $16,779.80.

One thing had to change underneath: `readSnapshot()` takes its point from
`clock_timestamp()`, not `now()`. **`now()` inside a transaction is the
transaction's START** and `ledger_append()` stamps `booking_time` from
`clock_timestamp()` — so `MAX(booking_seq) WHERE booking_time <= now()`, read
inside the transaction that just posted, *excludes that entry*. Standing orders
and pot transfers both funds-check inside the transaction that posts. It would
have been a silent wrong answer exactly where a wrong answer costs money.

### 3.5 `src/lib/holds/model.ts` — `H(E)`

See §2.3. Pure, no I/O, no "previous state" argument anywhere in the file.

**Poke:** *"`amountCents` is a magnitude and direction lives in `kind`. Why not
sign it?"* — Because the column is `CHECK (amount_cents >= 0)` and the function
**throws** on a negative magnitude rather than taking its absolute value:
*"kind carries direction, amount does not"*. Silently `abs()`-ing would turn a
reversal into an authorisation, which is a $5,000 error that balances.

### 3.6 `src/lib/holds/apply.ts` — the posting path

Compute `H_new = H(E)` under `lock_card_authorization()`, read `H_cur` from the
journal's memo balance, append the delta **only if non-zero**.

**Poke:** *"Two processors could both read `H_cur = 5000`."* — Not under the row
lock, and if the lock were bypassed the entry carries
`idempotency_key = hold:<hold_id>:after:<provider_event_id>`, UNIQUE on
`journal_entry`, so Postgres refuses the second delta. **The key is derived from
the source fact, never from a uuid we generate** — that is the whole argument.

### 3.7 `src/lib/holds/lithic-events.ts` — provider vocabulary → ours

**The module that held the worst defect of the build** and now holds its fix.
Until 04:32Z tonight this file contained **zero occurrences of `result`,
`APPROVED` or `DECLINED`**, and `card_auth_event` had no column to put the answer
in. An approved authorisation and a refused one were the same row.

**Poke:** *"Why is `isRefused` `result !== undefined && result !== '' && result
!== 'APPROVED'` rather than a list of decline codes?"* — Because a list of decline
codes is a guess about a vocabulary the provider owns, and the guard's exclusion
would be *"a decline code I have not seen yet"* — which is instance 1 of the
pattern, again. **`undefined` is deliberately NOT a refusal**: Lithic's `result` is
optional, and "the payload did not say" is a different claim from "the network
approved it". It is stored as NULL, and 431 of the 753 backfilled rows are NULL
for exactly that reason.

**Poke harder:** *"Why a separate table `card_auth_event_result` and not a column
on `card_auth_event`?"* — Because `card_auth_event` is append-only with a
`no_update_delete` trigger. Adding a column means backfilling it, and backfilling
is an `UPDATE` on a money-adjacent row. A side table keyed to the event is the
only shape that adds a fact to an append-only table without editing one.

### 3.8 `src/lib/webhooks/inbox.ts` — ingestion

`UNIQUE (provider, provider_event_id)`, ingestion is a single
`INSERT … ON CONFLICT DO NOTHING RETURNING id`, and **the row count is the
decision** — first delivery 202 `accepted`, replay 200 `replay`. There is no
`SELECT`-then-`INSERT` anywhere, because that has a race between two statements
and this has none.

**Poke:** *"`payload` is `::text::jsonb`. Why the double cast?"* — Because
payloads arrive already `JSON.stringify`'d, and a bare `::jsonb` makes the driver
send a JSON-typed parameter, so Postgres quotes it a **second** time:
`jsonb_typeof(payload)` read `'string'` and every `payload->>'field'` read
nothing. `::text::jsonb` forces a parse rather than a quote. **No unit test could
catch this** — the in-memory inbox double stores JS objects directly and never
parses SQL, so both a statement Postgres will not accept and an encoding Postgres
mangles pass the entire suite. This file also contains a **NUL byte**, which is
why the secret scanner must use `grep -a` (instance 2).

### 3.9 `src/lib/webhooks/{dispatch,drain,route-handler}.ts`

The route verifies, persists, and answers 202. **No consumer runs inline**: a
provider needs its 2xx in seconds and Plaid retries for 24 hours without one.
Three drain triggers, chosen because each fails differently: `after()` (the fast
path, explicitly a **nudge, never the mechanism** — it can be dropped when an
instance is recycled, and something that *usually* runs is the worst kind of
delivery), a daily cron (the guarantee), and a bearer-token POST (the demo).

**Poke:** *"Why does an inbox insert failure return 500 rather than swallowing
it?"* — Because the provider retries on a 500, and that is exactly what recovered
the 16:18 incident: Lithic's delivery failed, the cast was fixed, and
`msg_3J8yjFYaE5cor4TG…` **landed minutes later** with nothing lost. Swallowing a
delivery to protect a status code loses money.

### 3.10 `src/lib/rails/*` — one adapter interface

ACH (Increase), internal, and stablecoin (a direct signer **and** Circle behind
`StablecoinPayoutProvider`). **A rail is an adapter, not a schema.**

**Poke:** *"`rail_event_semantics` has 22 seeded rows. Show me the reader."* —
Today there is one, and for hours there were none. I described that table
repeatedly as the mechanism that decides correction-versus-new-event while
**nothing read it** and the distinction was implemented in the consumers
(DECISIONS 027). That is fixed: `RETURN_REVERSAL` is now routed by the row, and
coreloop leg 6 prints it — *"the semantics TABLE sent it down the correction path;
no event type is hard-coded in the consumer."* **Still owned:** two hard-coded
switches survive (`canonicalKind()`, `directionOf()`), neither decides
correction-versus-new-event; the table's `canonical_kind` column is therefore
**decorative** — the table says `refund_reversal`, the code stores `force_post`,
and the test pins the divergence as `kindMatches: false` rather than hiding it.
And `rail_event_semantics` is the **one table the seed upserts**, so a re-seed can
rewrite a classification silently.

**Poke:** *"Why is an ACH return a new event but a card clearing reversal a
correction?"* — Measured, not reasoned. Increase's live sandbox: after an `R01`
return, `settlement.settled_at` is **still populated** and the original transfer
id is unchanged. The provider models a return as a second money movement, not an
edit of the first. So the money really did leave on the settle date and really did
come back on the return date, and a statement for the settle date should still
show the payment. A card clearing reversal is the opposite — the clearing should
never have posted at that amount, so it corrects at the **original** value date.
Getting that mapping backwards is the design's named single biggest risk: one
wrong row silently corrupts every past statement it touches **while all invariants
keep passing, the hash chain verifies, and reconciliation stays clean.**

An event with **no** semantics row **parks the whole payload** rather than
defaulting to either behaviour, and a `correction` row whose `value_date_source`
is not `original.value_date` **throws at load**. A default here is a silent,
permanent corruption.

### 3.11 `src/lib/recon/*` + `db/migrations/0006_recon.sql`

**Poke:** *"What is `recon_match` for, if pairing is re-derived every run?"* —
This is the flaw the recon build found in my own design draft, and it is exactly
what the published attack tests. The draft defined "unmatched" as *"no
`recon_match` row"*. `recon_match` is `UNIQUE (entry_id)`, so an entry paired
against last night's file **could never pair again** — and the moment a provider
re-issues a file, a diff driven by that table reports the re-issued file as
**perfect** while the deleted row silently vanishes. The published attack is
"delete one row from tonight's scheme file and ask your breaks screen where it
went", and the draft would have answered *"nothing is wrong."* Fixed by separating
two things the draft conflated: pairing is re-derived on every run (each run is a
fresh opinion about the current file); `recon_match` keeps its append-only job as
**evidence** of the first pairing, carrying both amounts as at that moment.
**Evidence of what we concluded is not the same object as the conclusion, and a
table that is both cannot survive a second file.**

**Poke:** *"`in_ledger_not_file` excludes groups whose net is zero. That is hiding
breaks."* — An entry booked and then reversed is **agreement** with a file that
never mentioned it, not a break. Reporting it would train whoever reads that
screen to ignore it, which is how real breaks get missed.

**Poke:** *"Aging is in day closes, not hours."* — *"Open across a day close"*
means somebody signed off a business day with the break outstanding, which is a
categorically different failure from "24 hours old". `critical` also catches
anything over $1,000 that has survived two closes.

**Known defect, volunteer it:** tonight's coreloop leg 7 printed
`age -447d`, a **negative** age, because the seeded break's value date is
2027-12-02 and `closes_crossed` is 0. The ladder still classified it `Open`, which
is the safe end, but a negative age on a screen is a number nobody can act on.

### 3.12 `src/lib/approvals/*` + `db/migrations/0007_approvals.sql`

**Poke:** *"The screen disables the approve button for the maker. That is client
side."* — The screen is **not** the guard. `coreloop` assembles the POST **by
hand** to reach the trigger anyway, and the refusal comes from the database:
`assert_maker_checker()`, trigger `payment_instruction_event_maker_checker`,
**SQLSTATE 42501**, message *"maker-checker: actor % initiated instruction % and
cannot approve it"*. Livefire attack 5 does a **raw INSERT** of an `approved`
event by the initiator and gets 42501; approved events after both attempts: **0**.

**Poke:** *"An approval names a row. What stops the amount being changed after
approval?"* — Nothing can change it (append-only), but the approval names a
**hash of the amount**, not the row — coreloop leg 5 prints
`hash 1d229c72077729315e27f322…` with the note *"an approval names the amount, not
the row."*

### 3.13 `src/lib/statements/{read,publish,render,compare}.ts`

`read.ts` **writes nothing**, deliberately, so the screen can re-derive any
historical document on every page load — proving the hash — without the risk that
*looking at* a statement issues one.

**Poke:** *"`statement.opening_balance_cents` is a stored balance. You said there
are none."* — It is deliberate and it stays. A statement is a **published
artefact**: the figure it *asserted* must remain queryable for ever exactly as
published, even after a later correction changes what the ledger now says that day
was. That is the **as-published axis** of the bitemporal model, not a drifting
cache. `dbcheck` excludes it **by name with the reasoning in a comment**, so a
reader sees the exemption and its justification together rather than a silent
hole. As of 04:28:21Z there are **three** such named exceptions, the third being
`interest_posting.basis_balance_cents`, which is proven by re-deriving
`ledger_settled_cents` at the recorded watermark **row by row**.

**`server-only` is deliberately absent** from `read.ts` and `queries.ts`: every
function takes its connection as an argument and the module imports no driver, so
it can be exercised against a fake `Sql` in an environment holding no credentials
— which is exactly what CI is. `db.ts` carries `server-only`, and reaching a real
connection means going through it.

### 3.14 `src/lib/standing/*` + `db/migrations/0012_standing_orders.sql`

**The row that can fire twice is not the mandate, it is one dated instance of
it**, so `standing_order_occurrence (standing_order_id, scheduled_date)` is the
unit of the whole design. Exactly-once is four constraints in a chain, not one.

**Poke:** *"Why is the idempotency key a `GENERATED ALWAYS … STORED` column built
from `EXTRACT` and `lpad`? `to_char` is obvious."* — Because `to_char(date,
'YYYY-MM-DD')` and `date::text` are only **`STABLE`** in Postgres: date output
reads the `DateStyle` setting. A key that depends on a session setting is a key
that changes when a pooled connection hands you a different session, **and two
keys for one occurrence is a second payment.** `EXTRACT` + `lpad` is `IMMUTABLE`,
and the guarantee is structural: **Postgres refuses to create a generated column
whose expression is not immutable**, so the DDL carries the property. The
application never computes the key; it reads it back with `RETURNING`.

**Poke:** *"What happens when the balance cannot cover it?"* — **Refuse and
close.** Not partial, not carried forward, not queued for retry. A decided
occurrence leaves the queue by construction, because `listDue()` returns only
dates with no occurrence row and occurrences with no outcome. The alternative
quietly turns a mandate into a debt collector and makes *"did this fire?"*
unanswerable without reading a log. The recorded refusal is what justifies
checking **available** and not ledger: amount $20,871.93, ledger $21,081.93 (which
covers it), available $20,771.93 (which does not), shortfall $100.00, code
`INSUFFICIENT_AVAILABLE_FUNDS`, the gap being $310.00 of card authorisations. **A
ledger-balance check would have sent that payment.**

**Owned:** `standing_order_outcome` stores four of the five terms — 0022 gave
`available` a fifth and that table has no column for it — so the recorded identity
is now an inequality, `available <= ledger − holds − uncleared`. The test asserts
it as one, **names the missing term**, and asserts the full five-term identity
against live figures instead. A `0023` adding `observed_pending_outbound_cents` is
the fix.

### 3.15 `src/lib/pots/*` + `db/migrations/0015_pots.sql`

A pot is a **node in the account tree** — an account coded `2100.<uuid>` parented
to the business's `2100` leaf. Not a column, not a table with a balance, not a
tag. A transfer is two journal lines on `rail = 'internal'` and touches no
adapter. `corgi_app` holds `SELECT` on `pot` and nothing else; pots are opened
through a `SECURITY DEFINER` function, so there is **no capability** by which the
application could write half of one.

**Poke:** *"How does available fall when money moves into a pot, if nothing under
`src/lib/ledger` changed?"* — The transfer debits the **bare `2100` leaf**, and
`availableBalance()` selects that leaf by **exact equality** on `'2100'`, so the
debit lands and the credited pot leaf is invisible to it. **Exact equality is what
stops the money being added straight back in; the fall comes from the debit.**
Every other consumer matches the same way, which is why a pot is earmarked money
everywhere at once without any of them learning a new concept.

**And it falsified a claim this build had written down** — instance 6.
`0001_ledger.sql` says of `v_deposit_control_drift`: *"Written as a subtree walk
rather than 'sum the 2100 children' so that adding a sub-account level later
cannot silently break it."* The **subtree** side is a `WITH RECURSIVE` walk and
picked the pot up exactly as advertised. The **reported** side was a flat
`SUM(v_ledger_balance) WHERE code = '2100'`, eight lines below the sentence
promising it was not. One $500.00 transfer: subtree 13,577,077 vs reported
13,527,077. The fix generalises `reported` to a **strict superset** of the old row
set, so it still catches a deposit leaf reparented *out* of the tree, and the pots
test re-runs the **original** predicate verbatim and asserts it *would* have
drifted by exactly the pot balances.

### 3.16 `src/lib/payees/*` + `db/migrations/0016_payees.sql`

**Block on arithmetic, warn on judgement.** A failed routing checksum is a
**block**; a failed name match is a **warning**.

**Poke:** *"Why not warn on both and let a human decide?"* — Because they are
different kinds of statement. The ABA check digit is **closed arithmetic** — a
number that misses is not one any bank has been issued, so there is no informed
human who could be right to override it, and an *"are you sure?"* in front of
arithmetic teaches people to click through warnings. The name is an **open
question**, open in the direction of false positives, so the warning is made to
**cost** something instead: an acknowledgement row with a named human, an instant
and a sentence, and a trigger that refuses one against a check that was not
`warned`. Enforced in **five** places, not one: a runtime assertion that throws if
any finding other than `ROUTING_CHECKSUM_FAILED` carries severity `block`; a CHECK
that the routing number satisfies `aba_checksum_ok()`; a CHECK that
`(outcome = 'blocked') = (checksum_ok IS FALSE)`; a blocked UI branch with **no
continue control at all** — absent, not disabled; and a payment-gate refusal
`PAYEE_WARNING_UNACKNOWLEDGED`.

**Poke:** *"Offer a 'did you mean' suggestion."* — Swept the error space over a
fixed-seed corpus of 500 valid numbers: single wrong digit **40,500 cases, 100%
caught**; adjacent transposition **3,656 cases, 89.03% caught** (the misses are
exactly the digit pairs differing by **5**); transposition **3 or 6 apart, 4,019
cases, 0% caught**, because the weight vector `3,7,1` repeats every three digits so
those positions carry equal weights. And for an invalid number every weight is a
unit mod 10, so **there is exactly one repairing digit at each of the nine
positions — nine repairs, always.** A "did you mean" list would be nine equally
likely guesses dressed as help.

**Honest limit, on the screen and not in a footnote: there is no name-inquiry
network for US ACH.** Nacha has no such message. So the screen labels which kind
of check it did — `linked_account_holder` when Plaid holds an Item for the
destination, `payer_asserted` when it is only the name already on the payee
record. The second is worth having and it is not confirmation of anything. And
the provider does not do it for us: Increase's `/routing_numbers` answers a
checksum-invalid `101050002` with **200 and an empty list**, the same answer it
gives for a real but unlisted bank.

**Owned:** `aba.ts` says 88.9% and `docs/PAYEES.md` says 89.03% — the first is the
population value, the second is this corpus, and **neither says which**. The test
asserts only a band, so the documented figure is not regression-guarded.

### 3.17 `src/lib/cards/*` + `/api/webhooks/lithic-auth` — the ASA responder

**The only route in the system where the response body *is* the side effect**,
because Lithic is holding a cardholder's authorisation open while it waits.

**Poke:** *"Why is your timeout 600 ms when theirs is 6000?"* — Measured by
stalling on purpose: a responder that sleeps 20 s produced **DECLINED /
`UNKNOWN_HOST_TIMEOUT` / `CUSTOMER_ASA_TIMEOUT` at 6.527 s** against a **0.334 s**
baseline with no responder enrolled. So Lithic waits ≈6.19 s and **it fails
closed**. A responder that goes quiet declines the cardholder anyway — so there is
nothing to gain by being slow and everything to gain by answering "no" early
**with a record**. `CONTROL_READ_BUDGET_MS = 600` is a tenth of their window,
returned from the store as a **value** rather than thrown as an exception, so "the
control store did not answer" is an input to a pure `decide()` rather than a hole
in the control flow. `RULE_ORDER` is a separate constant from the display order,
so reordering a screen cannot change what a card may buy. **Nothing on this path
posts money**: a synchronous decision that writes can block on the append lock, and
a blocked decision is a declined card.

**Poke:** *"Rule 1 fails closed and rule 2 fails open. Pick one."* — They point in
opposite directions on purpose. Rule 1: we hold controls for this card and cannot
read them, so we decline rather than guess. Rule 2: this token is not in our book,
we hold no opinion, and the issuer's own limits still apply. **A card with no
controls is not a card whose control failed.**

**The sharpest hole in the feature's own story, volunteer it:** the argument for
failing closed is partly *"every fail-closed decline leaves a row, so the customer
can be found and made whole"* — but rule 1 fires **because the database is
unreachable**, so the append fails too. It retries once through `after()` and then
logs `asa.decision_lost`. The 601 ms row in the live evidence exists only because
that outage was a *slow read* rather than a *dead database*. Also: the wire code
for rule 1 is `VELOCITY_EXCEEDED`, the same code the limit rules use, **so to the
acquirer an outage is indistinguishable from a customer hitting a limit.**

Live, with the provider's own traffic, rows carrying `source = 'provider'`:

```
00:42:24.687Z  decline  control_store_unavailable  601,521 us  $25.00  mcc 5812
00:43:31.584Z  approve  card_not_under_control      14,297 us  $15.00  mcc 5812
00:44:10.461Z  decline  mcc_blocked                147,419 us  $50.00  mcc 5542
```

and Lithic's own record of the third: transaction
`b1bd8d71-554a-46fc-b80a-fe90044868a8`, **status DECLINED, result
UNAUTHORIZED_MERCHANT**, VISA, merchant `CORGI FUEL PUMP LIVE`. Our row and theirs
agree to the second.

### 3.18 `src/lib/kyb/*` — GLEIF, and the operator review

See §2.5 for the lattice. The mechanism: a composite provider, legs folded
worst-wins.

**Poke — and this is the one to invite:** *"GLEIF is not a KYB vendor."* — See
§4.1.

### 3.19 `src/lib/mcp/*` + `/api/mcp` — the agent surface

**8 tools at 04:29:36Z**: `get_balance`, `list_pots`, `list_transactions`,
`list_payees`, `list_standing_orders`, `list_card_controls`, `list_recon_breaks`,
and `initiate_payment` — whose own description begins *"Queue an outbound payment
for HUMAN APPROVAL. This tool does not pay anyone."* It writes one
`payment_instruction` and nothing else. `tools/list` is **not public**; nothing on
that endpoint is.

**Poke:** *"Your rate limiter is per process."* — Yes, and it says so in
`src/lib/mcp/ratelimit.ts` rather than being implied away: `RateLimiter` holds its
buckets in memory, so across several warm instances the effective limit is
(instances × limit). **It is not the control that stops an attacker** — the token,
the tenant scope and the approval queue are. It is the control that stops a
well-meaning agent in a retry loop from consuming an approver's afternoon.

### 3.20 `src/lib/integrations/probe.ts` + `delivery-health.ts` + `/api/health`

See §2.5. Two things to be able to defend:

**Poke:** *"Why `some` and not `every` in the escalation gate?"* — Because
**`every` is disarmed by the outage it exists to catch.** The measured proof, from
the induced outage's own published facts with `card_webhooks` forced not-live:

```
some  + card_webhooks not live -> degradesDeployment true,  degradedBy [lithic], degraded
every + card_webhooks not live -> degradesDeployment false, degradedBy [],       "ok"
```

`some` is not incidentally correct here; it is the only one of the two that the
failure cannot silence. And the assertion had to be strengthened, not just the
comment: **both Lithic slots read live right now**, so the live assertion would
pass under `every` too and says nothing about the regression. The test re-derives
the gate with `card_webhooks` forced not-live and asserts **both** shapes. **The
point being tested is not that `some` works. It is that `every` does not.**

**Poke:** *"Your `card_webhooks` probe reads Lithic's own delivery log. That is
not an independent witness."* — Correct, and stated: its verdict is a function of
the delivery loop's health. Fed the two degraded shapes this account has actually
produced, `judgeWebhookSubscription` returns not-live for both — `latest attempt
FAILED 500` → `unauthorised` (the real 16:18 incident: Lithic delivering, our
endpoint refusing, **deliveries being lost**), `/attempts` unreadable →
`unreachable`.

### 3.21 `src/lib/rails/stablecoin/*` + `scripts/payout-usdc.mjs`

**Poke:** *"Kill the script after the broadcast. What happens on re-run?"* —
There are exactly three places to die, because two systems cannot share a
transaction.

1. **Before broadcast** — nothing signed, nothing moved, nothing posted. A re-run
   reads the same nonce and sends one transfer.
2. **After broadcast, before the receipt — the one that pays twice.** The naive
   re-run reads `eth_getTransactionCount(pending)`, which **already counts the
   in-flight transaction**, builds a second transfer at N+1, and pays twice.
   Closed by reading `pending` and `latest` **separately** and refusing while they
   disagree: `REFUSED / transaction_in_flight / nonce pending=1 latest=0`.
3. **After the receipt, before the ledger write** — closed by asking the chain and
   not a local row: `eth_getLogs` for an ERC-20 `Transfer` from this wallet, to
   this recipient, for this amount, over the last 10,000 blocks. A hit returns
   that receipt as `confirmed` with `recovered: true`, having sent nothing.

**The idea worth keeping is the identifier, not the transfer.** An Ethereum
transaction hash is `keccak256` of the signed transaction's own bytes — nothing
about it is assigned by the network. **So the name of this money movement exists
on our machine before a byte goes over the wire**, and the script prints it there:
`signed locally / tx hash … <- known BEFORE broadcast`. That is what lets it be the
**idempotency key** rather than a receipt for one. The alternative — broadcast,
then ask the node what it called the transaction — has a window in which money has
moved under a name we do not yet know, **and that window is where double spends
live.**

**The type system does one job a reviewer would otherwise have to.**
`postUsdcPayout` takes a `ConfirmedPayout`, which is only constructible after a
receipt has been read, `status: 0x1` asserted and the block re-checked as
canonical. A broadcast, reverted or reorged transaction **cannot be passed to it
at all**, so "we posted a payment that never happened" is a compile error. The
limit, said in the same breath: it is a discriminated union rather than a branded
type, there is **no runtime check** on `outcome.kind`, and the gate is on that
function rather than on the journal — `scripts/book-usdc-funding.mjs` posts a USDC
entry through `postEntry()` directly.

**Poke:** *"Circle said CONFIRMED, not COMPLETE. Why did you post?"* — Measured:
Circle's ladder ran `INITIATED` (no hash) → `CONFIRMED` with the hash at ~10 s →
and **still `CONFIRMED` at 181 s**, never `COMPLETE`. `COMPLETE` is its only
success-terminal state, so waiting for it means waiting for a provider's *opinion*
about a fact the chain settled minutes earlier — and a poll timeout tuned to
"terminal in seconds" would have given up on a transfer that had already
succeeded. **The wait stops at the hash, after which the chain is the authority.**
The receipt was read off the chain by us, not reported by Circle, and the ERC-20
`Transfer` log in that block was re-matched against our own amount and recipient.

**No dependency was added.** No `viem`, no `ethers`: keccak-256, secp256k1 with
RFC 6979 and EIP-2 low-`s`, RLP, the EIP-1559 envelope and thirteen JSON-RPC
methods, 42 tests pinned to published vectors — including the EIP-155 example
transaction, whose exact `r` and `s` come back out, **which is only possible if the
address derivation, the RLP, the hash and the signer are simultaneously right.**

### 3.22 `scripts/coreloop.mjs` — the core loop as one command

Drives the brief's seven arrows as seven legs **against the deployed URL**, and
imports nothing from `src/` — four `node:` builtins and `postgres`, and that is
the entire list.

**Poke:** *"A runner you wrote proves your own system works."* — Which is why it
imports nothing: **a runner that imports the application can pass because the
application agrees with itself.** It scrapes the deployment's own HTML and replays
React's server-action fields (`$ACTION_ID_<hex>`, `$ACTION_<n>:0`) as
`multipart/form-data` — the identical request a browser with JavaScript disabled
makes. No `Next-Action` header, no hard-coded action id: **if a form is renamed the
run fails rather than passing against a stale constant.** The action's return value
is read back out of the re-rendered page. A **skip alone makes the exit code 1** —
a gap that does not change an exit code is a gap nobody acts on.

**Two honest limits, in the file above the assertions.** Leg 4 cannot do "days
later": Lithic clears on demand, so the clearing lands seconds after its
authorisation, and the value-date half of the brief's sentence is leg 6's job. Leg
7's title says "a planted break" and **the leg plants nothing** — `/reconciliation`
renders no write control, so the break is seeded and the leg proves detection,
categorisation and aging only. It says so on screen.

**It deliberately does not run on the demo favourite.** Every screenshot in this
repo is Ridgeline Robotics, and Ridgeline is the one business the seed ever opened
accounts for — so a core loop driven through Ridgeline would prove the loop works
on the one entity arranged in advance. Tonight's run picked **Hold Fuzzer Fixture
Co.**, and it prints the KYB gate's answer for **every** business on the book
before leg 1, so you see the refusal and the allowance side by side rather than
taking the subject on trust.

### 3.23 The rest of the tour, one poke each

*These were found by reading every non-test file in the remaining directories
tonight. Each is the line a hostile reviewer would stop on. Several are defects;
where one is, it says so.*

**`format/money.ts`** — `toCents` **throws** (`TypeError`/`RangeError`) rather
than returning a `Result`, in a repo whose house style is `Result` everywhere.
Defended as "a float reaching the formatter is a programming error upstream".
**Poke:** this is a *render-path* function, so one bad row takes down the whole
page rather than one figure.

**`format/datetime.ts`** — `calendarDateFormat` is pinned to **UTC** and selected
by `/^\d{4}-\d{2}-\d{2}$/`, because `new Date("2026-09-09")` is midnight UTC,
which is 20:00 the previous evening in New York — *"every daily statement would
be off by one."* Correct, and the reason is written down.

**`home/summary.ts`** — `readSystemState` issues **one** statement with ~17
scalar subqueries, because *"one statement means one MVCC snapshot, which is the
only way the numbers can be describing the same instant."* **Poke, and it is a
real one:** `resolveOrigin` builds the URL it then fetches from
`headers.get("x-forwarded-host") ?? headers.get("host")`, with **no allowlist**.
On any deployment where the proxy does not overwrite that header, a forged value
makes the server-side render fetch an attacker's origin and render whatever
`integrations.slots` it returns as this deployment's liveness table. The comment
defends the behaviour and never addresses the injection surface.

**`onboarding/open.ts`** — migration 0021 raises `42501` for **both** refusals it
can make, so this file disambiguates using a value read in a **separate earlier
round trip** (`statusWasApproved`). KYB can be superseded between the two
statements, and in that window a genuine `KYB_NOT_APPROVED` is reported as
`ACTOR_MAY_NOT_OPEN` — a wrong sentence about who is at fault. The honest fix is
a distinct SQLSTATE in the migration.

**`pots/model.ts`** — the amount is **deliberately not in**
`moveIdempotencyKey(potId, direction, reference)`, so re-submitting one reference
for a different figure cannot post a second transfer. **Poke:** a user who
mistypes $12,000 as $1,200, notices and resubmits with the same reference gets a
silent success with `replay: true`, and `transfer.ts` returns a receipt whose
`amountCents` is the **requested** amount while `before`/`after` show no change.
The receipt is internally inconsistent on exactly the path this choice creates.

**`pots/transfer.ts`** — duplicate-name detection is
`if (message.includes("pot_name_unique"))`, and `demo.ts` **branches on that code
to decide whether to proceed**. `onboarding/open.ts` two directories over refuses
this technique by name. Same repo, same class of problem, opposite rule.

**`pots/screen.ts`** — `sharePercent` is integer `bigint` division, so it floors:
a pot holding 99.6% renders `99`, and every pot under 1% renders `0`. The comment
defends it with the no-float money rule — **but a percentage is not money**.

**`payees/gate.ts`** — **it fails open**, and the `catch { return null }` encloses
the *entire* second section, so a transient database error while reading
`v_payee_book` lets a payment through whose destination has a standing,
unacknowledged warning. That is the exact condition the section exists to catch,
and the failure is silent: nothing distinguishes "checked and clean" from "could
not check". `fx/gate.ts` takes the opposite position for the same class of
question and says so explicitly. **Volunteer this one; do not wait for it.**

**`payees/name-match.ts`** — the rule is *character similarity may never assert a
match; only structure may*: `Alberta Charleston` vs `Alberta Bobbeth Charleson`
scores 99 on Jaro–Winkler and is **clamped to 94**, into `close_match`, in front
of a human. **Poke:** the header claims *"no number of interior [differences]
ever can"* drop a name out of `match`; interior penalties are 1 each and
uncapped, so thirteen of them do. The claim holds empirically, not structurally.

**`fx/allocation.ts`** — `const residualCreditCents = dustUnits > 0n ? 1n : 0n;`
Any non-zero USDC dust becomes exactly **one cent** to 2900, so the house
over-credits by up to 0.9999 of a cent per settlement, always in the same
direction, in a module whose header spends four paragraphs on why unbiased
rounding matters. The true fraction survives only as prose in the line memo.

**`fx/gate.ts`** — the amount check is a **ceiling only**. A $1 payout against a
$1,000 accepted quote is waved through, consumes the quote by primary key, and
leaves the beneficiary short with no refusal anywhere. `deliveryCostUnits()`
exists and computes the lower bound; the gate declines to use it.

**`fx/rate.ts`** — the best idea in the module: the response body is read as
**text** and the decimal literal lifted by regex, because
`JSON.parse('{"MXN":16.9435}')` produces an IEEE-754 double *before any of our
code runs*. **Poke:** `extractRatesBlock` hand-matches the **first** `}` after the
opening brace, so the moment the source nests anything the parse truncates,
`observeRate` silently falls back to the fixed table, and a parse failure becomes
indistinguishable from the source being down.

**`disputes/operations.ts`** — the header opens *"ONE TRANSACTION PER TRANSITION,
AND THE EVENT IS INSIDE IT"* and calls it *"the whole safety argument"*. It is
true of the three money paths and **false of the six bookkeeping-only ones**,
which run three sequential statements on the pooled handle with a read-check-write
race. The trigger catches the race, so the consequence is a wrong-shaped refusal
rather than a wrong outcome — but the header's claim is not true of most of the
file.

**`disputes/model.ts`** — `case_ref` is `UNIQUE NOT NULL` and its suffix is
`Math.random().toString(36).slice(2, 8)`: non-cryptographic, and capable of
yielding fewer than six characters. A collision surfaces as `23505` mapped to
`ALREADY_RECORDED`, which is a meaningless sentence for that cause. Every other
identifier in the repo is `crypto.getRandomValues` or derived from source facts.

**`accrual/store.ts`** — `bookToday()` hand-writes
`(now() AT TIME ZONE 'America/New_York')::date` three times, while
`book_date(now())` exists as a database function and is used by four other
modules. This is the module whose `readInvariants` carries a 15-line comment
about migration 0023 deleting *"a hand-written copy of the view's question"*
because *"two definitions of one question is the defect"*.

**`accrual/screen.ts`** — `Promise.all` over five reads, with the comment *"so
they are consistent as of one read rather than four that could interleave."*
`Promise.all` over a pool is exactly four-or-five interleaved snapshots.
`home/summary.ts` makes the opposite choice for the same reason and explains it
correctly. **The comment states the reverse of what the code does.**

**`approvals/session.ts`** — which human you are acting as is decided by
`ORDER BY display_name LIMIT 1`. The **predicate** is the security boundary
(`can_approve = ${role === "approver"}`) and it holds; the **identity** is a sort
order. Seed a second staff actor called "Aaron" and every `staff` session
silently becomes a different principal, including `requested_by` on every
instruction raised from the console.

**`approvals/state.ts`** — the rank table puts `rejected`/`cancelled` at 90 and
`settled` at 3, and `foldState` takes the **maximum** over the set. A `cancelled`
event after a `settled` one reports the payment as cancelled — money that has
landed, rendered as withdrawn. The lifecycle trigger makes that INSERT
impossible, so this is a fold that depends on a database constraint for its
correctness while advertising itself as total over the event set.

**`approvals/refusal.ts`** — nine of eleven rules match on **exception prose**.
`STALE_APPROVAL` is `m.includes("content hash")`, so any Postgres message
containing that substring renders to the user as *"This payment has changed since
it was shown to you."* The two rules keyed on `constraint_name` are the robust
ones.

**`approvals/instructions.ts`** — a stored `counterparty` that no longer parses is
rendered as **an internal book transfer to the nil uuid** with the holder name
`"Unrecognised destination — do not approve"`. The name shouts; the `type` is now
a lie, and `describeDestination` prints "internal book transfer". A refusal to
render the row would have been the fail-closed version. Also: `ON CONFLICT
(idempotency_key) DO NOTHING` is **global, not per-business** on the console path
— the MCP tool namespaces its key (`mcp:${businessId}:${actorId}:${key}`) and the
console does not, so two businesses can collide on `INV-1041`.

**`approvals/screen.ts`** — three other screens funnel bigints through a `toCents`
that **throws** past `MAX_SAFE_INTEGER`; this one — the screen rendering money
someone is about to approve — uses a bare `Number()`. One rule, four modules,
three implementations and one omission.

**`recon/parse.ts`** — the parser is **positional** and the column line is
skipped without being read. Swapping `reference` and `descriptor` produces
well-formed rows whose matching key is the descriptor, which reconciles against
nothing and surfaces as an in-file-not-ledger break for every line in the file.
The column line is right there and is discarded.

**`recon/aging.ts`** — `severityOf` short-circuits on `explainedBy !== null`
**before** the age and materiality checks, and `explainedBy` is set by either
`reversal_and_rebook` **or** `adjudicated`. So any operator can move a $1.2M,
200-day-old break out of `critical` and to the bottom of the sort by filing a
note. The reversal case is well argued; the same unconditional escape is applied
to the human case, which is the one that can be wrong.

**`recon/diff.ts`** — `toReconBreak` **throws** on an unrecognised `break_kind`,
and `readBreaks` maps over the whole result, so one unknown value from the view
takes out the entire breaks screen. `kyb/wire.ts`'s `toLegViewFromRow` makes the
**opposite** choice for the same question (below). Neither cites the other.

**`statements/publish.ts`** — the tamper alarm is conditional:
`if (atSameWatermark.contentHash !== hash && atSameWatermark.format ===
STATEMENT_FORMAT)`. A hash mismatch on a statement stored under any other format
takes the `return` and is reported as *"already published, nothing to do"*. The
module header calls a reproduction failure *"the single most important alarm in
this module"*, and this is the one branch that can suppress it — suppressed by a
column that a future `STATEMENT_FORMAT` bump sets on every historical row at
once.

**`statements/render.ts`** — every field is emitted netstring-style,
`` `${Buffer.byteLength(value,"utf8")}:${value}` ``, so a description containing
the delimiter cannot forge a different line set; `null`, `""` and the literal
`"null"` stay distinct via a presence marker. **The most careful preimage in the
repo, and the least defended against its own named failure:** nothing enforces
that `STATEMENT_FORMAT` is bumped when `canonicalStatement` changes.

**`statements/compare.ts`** — an unknown `?version=` silently renders **v1**,
which is the version whose divergence from today is the headline. A mistyped URL
produces a confident, plausible, wrong comparison, and nothing in
`StatementComparison` echoes which version was requested versus selected.

**`standing/types.ts`** — `DEFERRABLE_CODES` is `{UNAVAILABLE, POLICY_MISSING}`
and **everything else closes the occurrence permanently**, including
`KYB_NEEDS_REVIEW`, which is as transient as a missing policy row. A business
under review for a week gets a new permanent refusal every cycle.

**`standing/store.ts`** — `listDue` unions an unbounded `stranded` set with a
windowed `fresh` set under **one shared `LIMIT`**, ordered oldest-first. A backlog
of stranded claims consumes the run's 200 slots before today's mandates are
reached: the unbounded recovery path starves the thing it protects.

**`standing/fire.ts`** — the outer catch turns every unexpected throw into a
retry forever. The transaction rolled back, so the claim is gone and the next
tick re-derives the same date; for a **deterministic** fault the same occurrence
fails every tick with one log line and no escalation, and
`v_standing_order_unresolved` cannot see it because the claim rolled back.

**`kyb/wire.ts`** — `toLegViewFromRow` returns `null` for a row whose `evidence`
this build does not recognise, and the caller `continue`s. `recordManualReview`
then rehydrates from the surviving views, and on a **one-leg** set
`strictestOf(['approved'])` is `approved` and `degradeEvidence(['manual'])` is
`manual`. **A deploy-skew value in one leg turns a two-leg composite into a
single-leg approval** — the fail-closed rule becomes fail-open at the fold. The
empty-set case is handled; the one-leg case is not.

**`kyb/gleif.ts`** — the fuzzy candidate generator hardcodes
`filter[entity.legalAddress.country]=US`, permanently, with no parameter — while
`describeSearch` prints that filter to a compliance reviewer as though the search
space were the registry. And the outage guard is
`if (!autocomplete.answered && !fuzzy.answered) throw`: if **one** generator
answers with nothing and the other fails, the leg is still a `needs_review` miss
that says *"not present in the LEI registry"*. **A half-search reported as a full
one** — §1's shape, in the module that decides whether a business exists.

**`kyb/types.ts`** — `DEFAULT_TRANSACT_POLICY` is `{ requireLiveEvidence: false }`
and every call site re-states it. The whole lattice reduces, in production, to
"status must read exactly `approved`". Already volunteered in §4.1; the poke here
is that the **default** is the permissive one rather than an explicit opt-out.

**`integrations/delivery-health.ts`** — the escalation AND has four clauses, and
the third can hide the outage:
`gatesDeploymentStatus && verdict === 'stale' && integrationLive && verifierRegistered`.
If Lithic's **API** is down the probe reports `unreachable` → `integrationLive:
false` → **the delivery feed going silent cannot degrade the deployment**, on
exactly the provider whose silence places holds against money people are
spending. The comment justifies it as avoiding "the same fact stated twice"; the
two facts have different remedies and only one has a cost.

**`integrations/probe.ts`** — `if (status === 400 || status === 409 || status ===
422) return "live";`. That is measured and true for Plaid, and **Plaid is the one
slot that never reaches this line** because its probe special-cases 400 two
hundred lines below. So the branch's justification comes from the provider it
does not apply to, and it applies to `card_issuing` and `ach_rail`, where a 400
for a bad key would read LIVE. Given this function's family already holds five
documented instances of §1, it deserves the same scrutiny.

**`integrations/probes/lithic-webhooks.ts`** — "registered, enabled, never used"
returns `liveness: 'unauthorised'`, and `verdict-cache.ts` **remembers**
`unauthorised` as an earned verdict. A brand-new correctly-wired deployment
records a durable "credential rejected" verdict for a credential nothing
rejected. The right verdict is `unprobed`; the detail string says so in prose.

**`mcp/tool-initiate-payment.ts`** — **a concrete defect, and it is on the one
tool that writes.** The response includes `state`, `approval.policy_version` and
`approval.approvals_held`, none of which are in the declared `outputSchema`,
which is `additionalProperties: false` at both levels. **An MCP client that
validates `structuredContent` against the advertised schema rejects every
successful payment response.** Also: the funds pre-flight declares itself
`binding: false` and then **refuses the call**, so a payment that would be
perfectly fundable at release never reaches a human.

**`mcp/tools.ts`** — `FORBIDDEN_PARAMETER_NAMES` is the tenant boundary written
as data, and it is a **denylist of twelve literal strings**. A thirteenth
spelling — `org_id`, `company_id`, `on_behalf_of` — passes the guard. An
allowlist problem solved with a denylist, in the one place the file calls "the
tenant boundary".

**`mcp/server.ts`** — the write budget is spent **before** the arguments are
validated, so six malformed `initiate_payment` calls exhaust a token's entire
minute of write budget. A model in the schema-correction loop that
`toolCallError` is explicitly designed to encourage locks itself out of the one
thing it is allowed to do.

**`mcp/gateway.ts`** — the hold split clamps:
`cardAuthHoldsCents = itemisation > availability ? availability : itemisation`,
then `otherHoldsCents = availability - cardAuthHoldsCents`. If the two
definitions ever disagree the other way, the clamp produces a tidy itemisation
with the operator-hold term at **zero** — precisely the term whose absence caused
the fifth-definition bug — and nothing logs, counts or surfaces that it happened.

**`mcp/testing.ts`** — the fake gateway's `balanceAsOf` **ignores
`asOfValueDate` and `asOfBookingSeq` entirely**. `get_balance`'s headline feature
— the bitemporal as-of, which the tool's own header calls "the published
live-fire question" — is therefore untestable through the fake. The basis
*selection* is covered; the thing the basis selects is not.

**`mcp/limits.ts`** — 17 of the 20 refusals are guaranteed `capability-absent`,
enforced by `no-write-imports.test.ts`, and the file says so: *"Real, and
conditional on a test surviving."* Press on §1: **releasing a payment**, the most
irreversible operation on the surface, is guarded by an import-graph test rather
than by a grant.

### 3.24 The five to prepare hardest for

*If the panel lands anywhere in the rails or the webhook path, it will probably
be one of these. Four are instances of §1; the fifth is a documentation
mechanism defeating itself.*

**1. `drain.ts`'s `registered` flag silences the missing-consumer alarm after
the first invocation.** A delivery for a provider with no registered consumer is
supposed to be loud. Once the flag is set, it is not — which is the exact
"looks identical to working" failure the surrounding comment is written against.
**This is the same shape as instance 3** (`slots.every(live)`): a state that
suppresses the alarm is set by ordinary operation. The evidence that used to sit
here — two real Increase deliveries verified and dead-lettered with *"no
consumer registered for provider 'increase'"* — **is no longer true of the
book**: the consumer is registered, the backlog was redriven, and as at
2026-09-11T09:47Z no `increase` row is dead and no row anywhere carries that
string (§5.8). **The flag's defect is not repaired by that**, and losing the
symptom is the reason to say so: the shape is still in `drain.ts`, and the next
unregistered provider gets the same silence with no dead letters to notice it
by.

**2. `RETURN_REVERSAL` has three incompatible readings in this repo.**
`adapters/card.ts` treats it as a settlement; `holds/lithic-events.ts` stores it
as a `force_post`; `rail_event_semantics` classifies it as a **backdated
correction**. The behaviour is right — coreloop leg 6 proved it tonight — because
the *semantics row* is what routes it. But `canonicalKind` is decorative
(§3.10), and three artefacts naming one event differently is how the next person
gets it wrong.

**3. `increase/client.ts`'s `parseEvent` could not see a single sandbox
transfer** — it filtered `startsWith('ach_transfer_')` and every sandbox id is
`sandbox_ach_transfer_…`, so the whole rail was answered `200` and discarded.
This is **instance 15**, and the interesting half is that its *test* passed,
because the fixture hardcoded `associated_object_type` and varied only the id.
**Closed (DECISIONS 052):** dispatch is on `associated_object_type`, the helper
takes the type as a parameter, and `adapters/ach.ts`'s `observe` is now
`proof: 'measured'` — earned against the raw signed bytes of five real
deliveries rather than a fixture (§5.7).

**4. `plaid/adapter.ts`'s `resolveChart` is the four-deep self-join that
`resolveChartCodes` was extracted to replace**, and the refactor landed in
`wire/ledger.ts` and not in its origin. It is also raw SQL against `account`
from outside `src/lib/ledger/` — the exact shape `boundary.test.ts` exists to
forbid. Either it is on the 235-item allowlist (the ratchet working as designed)
or the ratchet is not enforcing what three separate comments say it enforces.
**Check this before the debrief; I did not resolve it.**

**5. The wire rail is deliberately excluded from the capability-matrix
generator to keep the drift test green.** `wire/index.ts` says so outright:
`allRailAdapters()` feeds `renderRailCapabilityMatrix()`, which `contract.test.ts`
asserts appears **verbatim** in `docs/RAILS.md`, *"so adding a sixth row turns
that suite red"*. A rail exists, is fully implemented, carries four `measured`
cells — and is left out of the generator. **The mechanism designed to make the
documentation true is the reason the documentation is incomplete.** Volunteer
this one; it is the most quotable self-inflicted wound in the build.

### 3.25 The rails, one poke each

**`rails/wire/client.ts`** — **it has no timeout.** No `AbortController`, no
default deadline. `increase/client.ts` has one (15 s), so do `plaid/client.ts`,
`stablecoin/client.ts` and `circle-client.ts`. The wire client — the one whose
calls are **final on receipt** — is the only HTTP client in the directory that
hangs indefinitely if the provider stops responding mid-`createTransfer`. A
caller must supply a signal, and `outbound.ts` does not.

**`rails/wire/outbound.ts`** — the last-four cross-check before money becomes
unrecoverable is
`!args.beneficiaryAccountNumber.endsWith(dest.type === 'wire' ? dest.accountNumberLast4 : '')`.
**`''.endsWith('')` is true**, so the false branch makes the guard vacuously
pass. Unreachable today because an earlier function throws first — so the final
check is defended by a different function, and expresses its own fallback as
"compare against nothing" rather than "refuse". And the header states plainly
that **`gatePaymentOnPayee()` is a no-op on wires**: *"a wire gets neither the
ABA check-digit arithmetic nor the standing-warning check — on the one rail
where the money cannot be recovered"*, because `approvals/types.ts` is owned by
another worker. The compensating control runs **after** two humans have approved.

**`rails/wire/adapter.ts`** — `observe`'s docstring says it *"NEVER THROWS on an
unrecognised payload — a throw becomes a 5xx and a provider that collects enough
of those disables the subscription"*, and names its one exception. `#settlement`
adds a **second** exception that fires on a *successfully* parsed delivery. Its
only reachable effect is the failure mode the surrounding contract forbids.

**`rails/wire/measured.ts`** — the strongest evidence artefact in the repo
(verbatim sandbox payloads) is connected to the type system by
`as unknown as IncreaseWireTransfer`, which **suppresses exactly the check that
would be most valuable**. Also: both fixtures are post-reversal, so the
`complete`/`accepted` arms that produce a *normal* settlement have no measured
payload at all.

**`rails/stablecoin/allocation.ts`** — `residualCreditCents = dustUnits > 0n ? 1n : 0n`.
`1.000001 USDC` and `1.009999 USDC` both debit the customer **one** extra cent.
The direction is always against the customer, and 2900 accrues a systematic
credit the chart's own note describes as sweepable to income. `dustUnits` is
carried so the exact fraction is on the memo; the asymmetry is not named.

**`rails/stablecoin/ledger.ts`** — the header claims `postUsdcPayout` taking a
`ConfirmedPayout` makes a bad posting *"a compile error rather than a code
review"*. `ConfirmedPayout` is a **structural** type: any caller can write an
object literal with `kind: "confirmed"` and a synthesised receipt and it
typechecks. The guarantee is "no existing code path constructs one without a
receipt", which is a review property sold as a compile-time one.

**`rails/stablecoin/circle-provider.ts`** — on a poll timeout with no hash it
returns `acknowledged`, which is unpostable and correct — and **terminal for
this invocation**. The direct rail's equivalent is recoverable because
`findExistingTransfer` scans the chain. Circle's is not: the already-sent scan
matches on `(token, from, to, amount)`, so a re-run either finds it on chain or
**instructs a second Circle transfer**, because Circle's idempotency key was a
fresh UUID generated inside `createTransfer` and is not derived from the
instruction. Nothing stores it; nothing reuses it on retry.

**`rails/stablecoin/circle-registry.ts`** — the two branches have **opposite**
failure modes for a missing credential. Circle absent returns an inert provider
that reports honestly. The **direct** path — the default — **throws**.
`stablecoinProviderHealth` wraps it in a try/catch to work around exactly this,
in the same file, in a module whose entire header is about degrading honestly.

**`rails/stablecoin/circle-config.ts`** — a live-mode key produces
`configured: false` with **`missing: []`**, the same shape as "no key at all".
So *"you pasted a production key, which is an automatic fail on this trial"* and
*"you set nothing"* arrive at the health surface identically, distinguished only
by a `detail` string. And `CIRCLE_BASE_URL` can redirect Circle calls anywhere
**after** the key-prefix guard has run.

**`rails/stablecoin/circle-recon.ts`** — `openingUnbookedCents` is a
caller-supplied constant subtracted from the break. Documented as the faucet
opening balance; structurally, **a free parameter that can make any break zero**,
in the one function whose output decides whether the books agree with the chain.
Note also the rounding interaction: payouts debit the **rounded-up** cent,
reconciliation compares the **floored** chain cents, so each dusty payout
contributes a cent of expected divergence in the opposite direction and nothing
here accounts for 2900.

**`rails/stablecoin/tx.ts`** — the EIP-1559 access list is a bare `[]` literal,
ninth of nine, and *"a nine-element list is not an EIP-1559 transaction and the
node rejects it outright."* The whole idempotency story rests on nine items in
that exact order, and the order is expressed as **literal array position** with
no named constant and nothing preventing a reorder.

**`ledger/post.ts`** — `reversal:<entry id>` makes any journal entry reversible
**exactly once**, by the UNIQUE idempotency key. `holds/corrections.ts` is the
path that makes a second correction of one clearing reachable in production.

---

## 4. The hard questions, with answers — including the ones that hurt

### 4.1 "Why is `business_registry` on GLEIF instead of a real KYB vendor?"

**The short answer: every vendor the brief names is gated, I measured each gate,
and GLEIF is a substitution that ships next to the word 'live' everywhere the word
appears.**

- **Persona KYB** and **Sumsub KYB** — behind a sales conversation.
- **Middesk** — behind business verification.
- **Stripe Connect** — *"Your account is not set up as a Connect platform"*;
  measured `POST /v1/accounts -> 400 "You can only create new accounts if you've
  signed up for Connect"`. And Connect was **never on the brief's KYB menu** —
  using it for the registry leg was my invention, and it was an invention that did
  not work. The menu lists Stripe twice, as KYC identity and as payments, and
  neither time as KYB.

**What GLEIF actually is:** four real endpoints, no credential, no mock, a real
registry of legal-entity identifiers. Measured 04:28:33Z:
`GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple Inc.)`. It sits at the
**bottom of a precedence ladder every named vendor outranks**, and two environment
variables move the leg the hour one becomes available.

**The part that makes this a good answer rather than an excuse: making it honest
broke the product, and the fix is the interesting bit.** GLEIF's population is
financial-market participants, so **every fictional business on this book answers
`not_in_lei_registry` and lands at `needs_review`**. `canTransact()` runs inside
`requestPayment()`, so leg 5 — the outbound payment needing a second approver —
was refused for **every business on the book**.

Three ways out, and two are disqualifying:

1. **Weaken the gate** — and the screen stops making the only claim it exists to
   make.
2. **Invent an LEI** — and a real company's identifier now sits on a fictional
   business. That is the exact forgery this module was built to prevent.
3. **Do what a KYB operation actually does with a registry miss: a named human
   reads the file, decides, and writes down why.** The registry still said what it
   said; a person said something else; **the system records both rather than
   collapsing them into one word.**

That is where `manual` comes from, and §2.5 is why the ordering made it free.

**Volunteer the risk, do not wait to be asked.** The deployed gate runs
`requireLiveEvidence: false`, so a `manual`-evidence business can transact — **the
one business that can move money on this book does so on a human's recorded
say-so.** And the reviewer's identity comes from the role cookie, which is
demo-grade and labelled as such: the *"an agent cannot review"* half is an absent
capability; the *"which human"* half is not.

**One more thing to say before they find it.** `/api/health` at 04:28:33Z reports
`business_registry` with `status: "live"` and evidence naming GLEIF — while the
`provider` string still reads **`"Stripe Connect (gated) — simulated"`**, from
`src/lib/env.schema.ts:116`. The status is right and the label is stale. It is
under-claiming rather than over-claiming, which is the safe direction, but 021's
own lesson was *one answer per slot* and this is one and a half.

### 4.2 "Why does a skip remain in attack 2?"

**Because a `hold_closure` row there would be wrong, and I would rather carry a
visible skip than an invisible defect.**

What attack 2 asks: *"Capture $73.40 two days later. The hold releases exactly
once."* What is true tonight, measured: the hold **is** released — two memo
entries netting to zero, memo balance $0.00, `v_hold_state` active $0.00, the
ledger posts exactly 7340 in one financial entry, and `available == ledger − holds
− uncleared` **exactly, not clamped** — and it is negative, reported as negative
rather than floored at zero. What is **absent** is a `hold_closure` row.

The row would require `closed(E)` to gain a `C >= A` arm, and §2.3 has the
measurement that says over-capture is **not terminal**: after the over-capture the
authorisation can still rise, the hold reopens for the un-captured remainder, and
the network really captures it. `hold_closure` is append-only with
`PRIMARY KEY (hold_id)` and `v_hold_state.is_released` reads it, so a closure
written at the over-capture **would free money that is still authorised** until
someone appends a `hold_closure_reversal`. That is the exact $60 failure migration
0011 was written to clean up.

**"The attack's wording says the row should exist."** The attack's wording is
*"the hold releases exactly once"*, and the release **posting** is what meets it:
two memo entries netting to zero, and no second one is possible. The closure row
lands when something terminal happens — `is_final`, an explicit close, or the
seven-day expiry sweeper.

**What would change my mind, and it is wired to the evidence.** Attack 2 is now
three tests: the money claim (PASS), **the measurement itself** (PASS — and if
Lithic ever refuses the incremental, it **skips loudly**, which is the trigger to
reopen this decision), and the closure-row claim (SKIP, quoting that run's own
token and approved advice). The decision is wired to the evidence that produced
it, so it cannot quietly rot.

**And the thing I got wrong, said first.** `DESIGN.md` §8.3 *appeared* to say the
case closes. It does not: row 2 reads `clearing 73.40 **final**`, so it closes on
`sawFinal`, which Lithic does not set on a `CLEARING`. The rows that apply are 5
and 12 and both say not closed. **The one artefact that genuinely disagrees is
§8.2's ASCII diagram**, whose `OVER/EXACT CAPTURED -> TERMINAL: H = 0 forever` box
the measurement falsifies outright. **The diagram is the defect, not the model** —
and it took two passes and a fuzzer to be sure of that.

**Also measured:** 88 live holds satisfy `C >= A` with `is_closed = false`, every
one with memo balance 0. **The arm would have alarmed nothing today.** That is what
makes it a trap rather than an obvious mistake.

### 4.3 "Why is the drain cron daily?"

**Because this is a Vercel Hobby account and Hobby caps cron at once per day.**
The hourly schedule was rejected at deploy time: `Hobby accounts are limited to
daily cron jobs`.

**What it actually costs: worst-case latency, never worst-case correctness.** The
inbox row is durable before any trigger runs. If every `after()` nudge for a
delivery were lost — an instance recycled at exactly the wrong moment — that row
waits for the daily tick instead of the hourly one. It is not lost: the dispatcher
re-claims rows whose lease has expired and the row stays `pending` until a
consumer succeeds.

**It costs the standing-order tick less than it looks, and that is a design
property rather than luck.** The unit of work is a **date**, the calendar is a SQL
function, and a tick that runs late still claims exactly the dates that are owed. A
missed day is picked up by the next tick's catch-up window. Past the freshness
limit the occurrence is still **recorded** — as `refused / STALE_OCCURRENCE` —
because *a fortnight of rent debited in one batch by a scheduler that has just
woken up is worse than not firing*. What a tick can never do is claim a date twice,
and that is the property being graded.

It is one line of `vercel.json` and a paid plan, and it is in the cut list rather
than smuggled into the README as though the guarantee were tighter than it is. If
asked *"what if the nudge is lost"*, the honest answer is **"up to twenty-four
hours on this plan, and here is the line that changes it."**

### 4.4 "What is the $60 over-release in the history?"

**Three card holds on Ridgeline Robotics carried a `hold_closure` row while the
event fold still said they were open — so $60.00 was withheld from nothing, and
the invariant could not see it.**

All three closure rows carry `reason = "authorisation fully reversed"`, which is
the fallback branch `closureReason()` returns when the only thing that made
`closed(E)` true was `A <= 0`. **That is the signature of the clearing-first bug**:
a settlement arriving before its authorisation produces the event set
`{clearing 3000}`, where `A = 0` satisfies `A <= 0` and `closed` is true. The late
authorisation then arrived and reopened the hold — **but the closure row outranks
the fold in `is_released`**, so $20.00 each was spendable while still authorised.

**The part that matters is why no alarm fired.** `v_hold_drift` is
`WHERE NOT hs.is_released AND memo <> target`, **so a hold with a spurious closure
row is outside the check by construction.** That is instance 1 of §1, and it is the
one every other instance is measured against: an invariant with a blind spot shaped
exactly like the bug it should catch is worse than no invariant, because it reports
clean.

**What happened to it.** I wrote it off as cosmetic in DECISIONS 024 and a README
worker found it was worse than I had said. I then declined to repair it before
freeze — append-only rows, availability on the safe side (it withholds nothing
rather than double-withholding), and a repair script under time pressure against
money rows being the worse risk. **It has since been repaired properly**, by
append and not by edit: `scripts/repair-0011-spurious-closures.mjs` reverses a
closure only when **all four** of these hold, and refuses loudly without writing on
anything else —

1. `v_hold_release_drift` reports the hold (released, and its memo book still
   withholds money);
2. the fold over its event set says it is genuinely still open
   (`target_hold_cents > 0`), so the memo book is right and the closure is wrong,
   **not the other way round**;
3. the closure reason is the `A <= 0` fallback string;
4. `card_authorization.origin = 'clearing_first'`, which is the arrival order that
   produced the bug.

Measured at 04:33Z: **`hold_closure` holds 152 rows and `hold_closure_reversal`
holds 3.** The $60 is back on the right side of the book.

**What is still open, and it is the bigger half:** `v_hold_drift`'s exclusion
clause is unchanged. Widening it to compare `memo_balance_cents` against
`target_hold_cents` for **closed** holds too is week-two item 2, and it matters
more than the sixty dollars it was sitting on.

### 4.5 "How would you corrupt this ledger if you were malicious?"

Not through the application: `corgi_app` cannot express `UPDATE`. The realistic
attacks, in order of how much they worry me:

1. **A future migration.** Migrations run as the owner. Layer 2's triggers catch
   the row-level cases; the hash chain catches the rest, after the fact.
2. **A wrong `rail_event_semantics` row.** One row flipped from `new_event` to
   `correction` silently corrupts every past statement it touches **while all
   invariants keep passing, the hash chain verifies and reconciliation stays
   clean.** The design names this as the single highest-risk artefact in the
   system. It is also the one table the seed **upserts**.
3. **A guard's exclusion clause.** Which is §1, and is the answer I would give
   first if the question is "what actually went wrong here".

### 4.6 "Turn off the issuing provider's webhooks for five minutes. What does the customer see?"

**Not a spinner, not a stale number presented as current, and not silence.** The
banner gives the narrow true statement: *the feed has gone quiet, here is which
provider and for how long, and the balances below are still correct for every
event we have received.*

**Why a quiet feed does not blank the page.** Every figure on screen is a fold over
rows that are already durable. Those numbers stay true whether or not a provider is
talking to us. What a silent feed means is that there may be events we have not
**heard about** yet — a different claim from "your balance is wrong", and saying
the stronger one would be false.

**It renders the health endpoint's verdict; it never computes one.** A banner
querying `webhook_inbox` directly would be a third opinion about provider state,
and the first time it disagreed the demo would be arguing with itself. This build
has had that failure once already (021). **One author, many renderers.** It sits in
the console shell rather than on one screen, because a feed outage is a property of
the system. And it swallows its own errors and renders nothing rather than
throwing: a console that 500s because its health widget failed is worse than one
with no widget.

**The state easiest to get wrong is "unknown".** Absent a freshness field, the
honest answer is *"provider delivery freshness is not reported yet"* — **NOT
"healthy"**. Inventing health from an absence is the mistake in 011. There is a
test asserting that a health document with no freshness field yields `unknown`, and
a second asserting a thrown fetch yields `unreachable`. **Neither may ever return
`healthy`.**

Measured tonight, livefire attack 7: the suite **induces** the outage, watches
Lithic go `fresh → stale`, cross-checks the published `lastDelivery` against
`MAX(webhook_inbox.received_at)` read straight from the database, and asserts the
**degraded** banner specifically rather than any banner — because the "cannot reach
health" variant carries the same attribute and would have proven the opposite. The
deployed console rendered `data-provider-status="provider-down"` with *"Issuing
provider feed is quiet — lithic"*, **and the deposit-account balances still
rendered underneath rather than being blanked.**

### 4.7 "Replay the webhook. Twice is one."

Proven tonight against a **real, signed Lithic delivery**, and the story of how it
was nearly not proven is the better half.

An earlier attempt replayed a stored delivery, saw the row count hold at 1, and
almost got reported as proof. **It was not**: both replays returned **401**,
because the stored headers were the double-encoded ones and carried no signature.
The count held because the requests were rejected *before* the inbox, not because
the unique index deduped them. **A test that passes for the wrong reason is worse
than one that fails.**

Attack 8 now proves four things before it will read the row count. Measured
04:33Z: real delivery `msg_3JAQ27O4jk1sSFGlYTuMsSk1SZz`, raw body 2,189 bytes,
two signed replays → **HTTP 200 and 200, both `status="replay"`, both echoing the
original `inboxId`**; a negative control with a tampered signature → **401
`WEBHOOK_SIGNATURE_INVALID`**, so the 200s mean the signature genuinely verified;
and `webhook_inbox` rows for that key after 1 delivery + 2 signed replays + 1
tampered replay: **1**. **Deduped by `UNIQUE (provider, provider_event_id)`, not by
a 401.**

### 4.8 "Your decision log's timestamps go backwards."

**Three of them do, and I am not restamping them.** `node scripts/compliance.mjs
--only AF6` reports 011 (02:05Z after 010's 03:20Z), 024 (17:45Z after 023's
19:40Z) and 027 (18:45Z after 026's 19:20Z).

**What the content shows without needing the git history.** Four of the file's
stamps are byte-identical to an earlier entry's, and in **every** case it is the
later-numbered entry that is the duplicate: 006/011, 019/024, 022/028, 023/029.
That is the fingerprint of a heading line copied from a nearby entry and edited for
number and title with the stamp left behind — **a clerical defect, not a backdated
claim.** 027 is the different case: its 18:45Z duplicates nothing and sits earlier
than both neighbours; its subject is being asked whether the checkpoint was ready,
which is the kind of entry started while other work is in flight and filed once the
checking is done.

**And the checker only sees two of the four** (028 and 029 happen to sit next to
entries later than themselves), which is instance 12: *a guard that catches half a
defect and reports a count is more dangerous than one that catches none, because
the count reads as complete.*

**Why they stay.** A monotonic sequence would take five minutes to manufacture and
would be a lie about when the work happened, in a file whose own preamble says
*nothing here is edited after the fact*, and in a trial whose brief says *"we will
read the git history"*. **A log that quietly agrees with itself is worth less than
one that says where it disagrees with itself.** The brief asks for *timestamped
entries written as you go* and nowhere for monotonicity; the checker agrees and
records these as `~` rather than a failure.

### 4.9 "Compliance says you have secrets in git history. That is an automatic fail."

**It is a false positive, and the fact that it is one is itself instance 5 of §1.**

`node scripts/compliance.mjs` at 04:33:24Z reports AF5 FAIL on **3 file/shape
pairs**:

```
src/lib/cards/asa.test.ts           :: whsec_[A-Za-z0-9+/]{20,}         15 commits
src/lib/rails/plaid/client.test.ts  :: access-(sandbox|development|...)  11 commits
docs/EVALUATION.md                  :: access-(sandbox|development|...)   2 commits
```

I checked rather than asserting. The two `whsec_`-shaped strings in `asa.test.ts`
are **`whsec_AAAAAA…` and `whsec_BBBBBB…`**, 50 characters of padding, and neither
equals `LITHIC_WEBHOOK_SECRET` or `STRIPE_WEBHOOK_SECRET`. The six Plaid-shaped
strings are `access-sandbox-x…`. They are deliberate test fixtures. The same
check's **own next line** says so: *"no current .env secret value appears in any
commit (17 values pickaxed with `git log -S`)"*.

**Why I am not simply dismissing it.** DECISIONS 032 replaced a shape rule with a
literal-value comparison against `.env` for exactly this reason — *"a rule that
fires on 24 innocent constants gets switched off by whoever is in a hurry, and then
it protects nothing. The guard's failure mode is not a false positive; it is the
disabling that follows one."* The shape rule was kept **only where it could not
collide** (provider prefixes carry their own namespace). It has now collided, with
a deliberate fixture. **That is the same failure shape, tonight, in the guard
written to avoid it.**

**The real residue, stated separately so it is not lost in the false positive.**
Two *dead* sandbox credentials were genuinely committed (DECISIONS 023): a Plaid
sandbox access token and a `whsec_` captured from a real API response, both pasted
into research notes by research workers. Both were **rotated or already expired
before** the working tree was scrubbed — the Lithic secret via
`POST /v1/event_subscriptions/{id}/secret/rotate` (HTTP 204), the Plaid token
returns `INVALID_ACCESS_TOKEN`. The history purge **was** completed: `filter-branch`
rewrote 45 commits and the force-push landed, with all 46 commits retaining their
timestamps. **The lesson is about process rather than grep:** six research agents
were told to document what they found, none was told not to paste live responses,
and it did not occur to me to tell them. *Sub-agents inherit your tools and your
repo; they do not inherit your caution.* The instruction is now in the scanner
instead of in my memory, which is the only place it survives.

### 4.10 "Compliance says you have a stored balance column. `dbcheck` says you do not."

**Both were true within two minutes of each other tonight, and the disagreement is
the honest headline.** At 04:26:37Z `dbcheck` **failed** on
`interest_posting.basis_balance_cents`. At 04:28:21Z it **passed**, because another
worker landed a named exception plus a new check that re-derives every stored
interest basis from the journal at the recorded watermark, row by row. At
04:33:24Z `compliance.mjs` still **fails** G1 on the same column, because it has
its own copy of the stored-balance rule and that copy has not been updated.

**Two instruments, two opinions, and one of them is stale.** The right answer is
the one 021 already made me learn: **stop having two.** Compliance should call the
same predicate `dbcheck` does rather than re-implement it. That is not done, and
saying so is better than picking whichever number is flattering.

### 4.11 The rest, briefly

- **"Show me the money for a $50 auth cleared at $73.40."** `docs/ARCHITECTURE.md`
  §1 steps 5 and 6, with tonight's measured deltas.
- **"When can I spend the $5,000 I just funded?"** At 09:00 ET on the banking day
  the `funds_availability_policy` row names — a row chosen by the credit's **value
  date**, not by today, with the `policy_id` stored on the hold so a hold opened in
  March is explainable in December after the policy changed. A **missing** policy is
  a refusal (`NO_AVAILABILITY_POLICY`), never a default of zero. Banking days come
  from the eleven Federal Reserve holiday rules computed in code, including the
  Fed's Saturday rule (a Saturday holiday is *not* observed on the Friday for
  banking purposes — pinned by 2026-07-03), and 09:00 ET is a real timezone
  conversion with a two-pass offset correction tested on both sides of the March
  DST boundary.
- **"What breaks if the database goes down mid-drain?"** Nothing is lost: the inbox
  row is durable before any consumer runs, the lease expires, the dispatcher
  re-claims. What *is* affected is the ASA responder — see 3.17, and the fail-closed
  hole in its own story.
- **"Your role switcher is a cookie."** Yes, and `role.ts` and
  `approvals/session.ts` both carry a header saying it is a demo affordance and not
  an authorisation boundary, naming the one function that replaces it. **Nothing is
  granted by it**: the actor is resolved by a `SELECT` with a `WHERE` clause and
  handed to the database, which decides.

---

## 5. Every weakness, volunteered

*Read `DECISIONS.md` end to end (58 entries as at 2026-09-11T10:00Z; 050 onward are tonight's) and
`docs/CUT-LIST.md` §3 for the long form. This is the say-it-first list.*

### 5.1 The one that is live right now

**A declined authorisation was holding the customer's money, and the fix landed
at 04:32:15Z tonight.** `card_auth_event` had no column for the network's
`result`, so the outcome was discarded at ingest and an approved and a refused
authorisation were the same row by the time anything could reason about them.
Measured blast radius from the retained raw payloads: **60+ authorisations the
network refused raised `A(E)` at full value; 24 were still withholding $1,151.00
across three businesses** — Kettle & Crumb $600.00, Holds Integration Fixture
$500.00, Ridgeline $51.00. The rest had already been swept by the seven-day expiry
clock, *which is not a defence*: the customer could not spend their own money for
seven days because a transaction the network refused looked to us exactly like one
it approved.

**Attacks 1 and 2 had been passing because we ingested declines as approvals**, and
DECISIONS 050 says plainly that they are expected to fail once declines stop
counting and **nothing will be tuned to keep them green**. A red test telling the
truth beats a green one that is not.

**One thing explicitly not done:** raising the sandbox account's $5,000 daily
limit. `PATCH /v1/accounts/{token}` was blocked by a deliberate permission guard on
changing a provider account's settings, and working around it is not on the table.

### 5.1b Live fire's own harness has a shared-book defect, and one attack cannot report

Two things, both from §0.2, both worth volunteering before the suite is run in
front of anyone. **Attacks 1 and 2 assert a shared business's whole position
across a window rather than attributing the delta to their own hold** — DECISIONS
028 fixed exactly this in attack 7, named attacks 1, 2 and 4 as carrying the same
latent vulnerability, and left them because they were passing. They stopped
passing tonight. **And attack 3 throws `ReferenceError: nextDayStatement is not
defined`** on one of its two part-B instances, printing `closing undefined`,
`difference NaN` and thirty-nine `[object Object]`s into its own evidence string.
The bitemporal claim is demonstrated by the instance that completes; the attack
cannot currently report it.

Neither is a money error. The trial balance was 0 and `dbcheck` was 26/26 through
both runs. Both are the difference between a suite that proves a property and a
suite that proves a property *when the machine is quiet*, and the brief's whole
point is that the machine is not quiet.

### 5.2 The one whose SQL half has not landed — CLOSED

`src/lib/holds/model.ts` dropped the non-monotone `A <= 0` arm from
`terminallyClosed` at 04:31Z, and for a few hours the comment in that file cited
a **migration that did not exist on disk**. It exists now:
`db/migrations/0028_terminal_closure.sql`, applied. `closed` is unchanged, so
`v_hold_drift` was unaffected throughout and nothing drifted.

**What is still true, and is the more useful sentence:** `0004`, `0010`, `0027`
and `0030` are missing from `db/migrations/`. The numbering has gaps because
numbers were claimed and then not used, not because a migration was deleted —
`migrate.mjs` records what it applies and the journal has no hole.

### 5.3 `v_hold_drift` still cannot see a spurious closure

Instance 1, still open. `WHERE NOT is_released AND memo <> target` excludes a
spuriously-closed hold **by construction**. The three rows it was sitting on have
been repaired by append (§4.4), but **the exclusion clause is unchanged**, and the
next person will trust that view. Week-two item 2.

### 5.4 `v_standing_order_double_fire` was tautologically empty — CLOSED 2026-09-11

Instance 8. The body **joined** `payment_instruction` to the occurrence on the
idempotency key and reported more than one instruction per key — but **that
column is UNIQUE**, so the count could never exceed one. The failure worth
detecting, two instructions for one occurrence under *different* keys, was
exactly what it could not see, and a test, a document and `compliance.mjs` all
presented its emptiness as evidence.

**This is now closed, and closing it is worth more than the guard.** Migration
0023 repointed the body at the mandate's *keyspace* — `'standing:<order id>:%'`
— which is the question the unique index does not answer. Between 0023 and
tonight **nobody ran it**, so the repair was a description of a measurement
rather than a measurement. `node scripts/dbcheck.mjs --prove` now builds the
violating state on every run. Measured against the live database at
**2026-09-11T09:41Z**, in a transaction that was rolled back:

```
PASS  v_standing_order_double_fire CAN fail — 0 -> 1 after a second instruction
      for one occurrence, under a different spelling of the derived key
```

The plant is a second `payment_instruction` on one occurrence in the mandate's
keyspace — `standing:6d27bdba-c9ab-4df1-912c-cd6ff033a6b0:2026-09-11` (the real
one, written by the firing routine) alongside
`standing:6d27bdba-c9ab-4df1-912c-cd6ff033a6b0:2026-9-11#retry-after-a-restart`
(an unpadded, `DateStyle`-dependent key from a retry). The row names **both**
keys in `instruction_keys`, and it is 0 again after the rollback. **The UNIQUE
index is perfectly satisfied by that pair**, which is precisely why the old body
could not see it. Full narrative: `docs/STANDING-ORDERS.md` §8.

### 5.5 `v_hold_release_drift` is correct and was queried by nothing

For a period it was in no test, on no route, and not among `dbcheck`'s checks. It
is in `dbcheck` now (measured 04:28:21Z, empty). The reason it matters is the
measurement that went with it: fourteen `uncleared_credit` holds were open with
`releaseAvailableCredits()` — the function that writes the closure row — **having
no caller anywhere in the repository**. So *"when does my $5,000 become
spendable"* had two answers: 09:00 ET the next banking day on the view, and
**never** on the screen. The sweep is wired now (`drain.ts:156`), which is the
precondition that made 048's unification correct rather than premature.

### 5.6 Three lines of the disputes UI divide money by 100

`src/components/disputes/DisputeForms.tsx:164`, `:182`, `:453`. `compliance.mjs`
fails **NN9 — "Money is never a float"** on them and is right to.
`src/lib/format/money.ts` exists precisely to make that impossible and its header
says *"there is no `/ 100`, no `toFixed`"*. **No money is computed from them** —
two render an `<option>` label and one fills a form default re-parsed into cents
server-side — so nothing in the ledger is wrong. **That is why it matters**: the
README says money is never a float and three lines in the working tree say
otherwise, which is precisely "code you cannot explain when we point at it". The
fix is `formatCents()` and it is minutes.

### 5.7 The Increase adapter's four money operations HAVE now run — CLOSED 2026-09-11

**What this section said, and it was true when it was written at 04:41Z:** the
probe was the only measured cell; `originate`, `observe`, `settle` and `reverse`
were `~` on the capability matrix — supported, and never run against the
provider. The full create/submit/settle/return lifecycle in DECISIONS 019 was
driven against the live Increase sandbox **by hand, not through this adapter**,
which is still the correct account of *that* transfer. Two real Increase
deliveries had reached the deployed endpoint, verified, and been dead-lettered
with *"no consumer registered for provider 'increase'"*, so `parseEvent` had
never seen a real delivery either.

**All five cells now read `proof: 'measured'`** in
`src/lib/rails/adapters/ach.ts`, and the thing worth saying is *why the old
evidence string was wrong rather than merely stale*. It described a **different
transfer**: `sandbox_ach_transfer_s2iljuavdzp2p68rh7v7`, $742.19, whose
`idempotency_key` is **null** — which is exactly the evidence that it did not
come from this code, because `createAchTransfer` is the only thing in this repo
that sends an `Idempotency-Key` to `/ach_transfers`. The transfer that earns the
cell is a second one:

| operation | what earns it |
| --- | --- |
| `originate` | `POST /ach_transfers` → `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`, **$6,000.00**, `Idempotency-Key: test:approvals:1789097931095:gate` — a released payment instruction from the maker-checker suite |
| `observe` | `parseEvent` run against the **raw signed bytes** of 5 real `ach_transfer.*` deliveries read out of `webhook_inbox.raw_body`, not a fixture anybody typed |
| `settle` | `submitted` + `settlement.settled_at` promoted to `settled`, on the book: `ach:settled:…x5vdo5m7b6k924sszlms`, DR 2300 600000 / CR 1110 −600000 |
| `reverse` | R01 `insufficient_fund` end to end: `ach:return:…x5vdo5m7b6k924sszlms:644288470109390`, DR 1110 600000 / CR 2100 −600000, posted at `return.created_at` with the settlement left standing |
| `probe` | `GET /accounts?limit=1` → 200 against `sandbox.increase.com` |

**The gap that remains, stated because it is the same failure shape one level
down: R02–R29 are table-driven and unexercised.** One return code is measured;
twenty-eight are a table. Letting R01 promote its neighbours would be exactly
the move this section was written to refuse.

### 5.8 Parked and dead-lettered deliveries — the Increase half is CLOSED

**What this said at 04:05Z:** `webhook_inbox` held 424 `done`, 35 `parked`, 28
`dead`, 15 `pending`; every parked row was a Lithic card authorisation on an
orphan token; the dead letters were retained and **nothing re-drove them**.

**Measured again at 2026-09-11T09:47Z, against the same database:**

| provider | done | parked | dead |
| --- | ---: | ---: | ---: |
| `lithic` | 905 | 27 | **26** |
| `increase` | 124 | 119 | **0** |
| `plaid` | 3 | 0 | 0 |
| `stripe` | 10 | 0 | 0 |

**Increase went to zero dead, and it did not get there by deletion.** No
`increase` row carries a `dead_lettered_at` at all any more (243 rows, 0
non-null), and **no row anywhere in the table carries the string "no consumer
registered"**. The consumer was registered and the backlog redriven;
`/api/health` reads `status: "ok"` in consequence, not `degraded`.

**Three things here are still real and should read as real.** Lithic's **26 dead
letters** are unchanged — every one is *"parked 12 times waiting for
card:<token>"*, an authorisation on a card created directly in the sandbox and
never registered to a customer here, and **there is still no claim path**: no
screen and no script maps an orphan card token to a business, so the only way to
clear them is a hand-written `INSERT`. Increase's **119 parked** rows are wire
deliveries and one $10,000.00 inbound ACH credit that is parked *on purpose* —
the object names the programme's single shared FBO account number, so the field
that should say whose money it is names the programme, and the consumer refuses
rather than guessing (`docs/GAUNTLET.md` §5 addendum). And the parked count
still grows every time live fire runs. I would rather a grader saw all of that
than a clean zero.

### 5.9 The USDC payout's three honest gaps

1. **The ledger carries USDC in cents, not as its own currency**, because
   `assert_entry_balanced()` requires each currency in an entry to net to zero
   independently and this chart has no FX bridge pair. USDC has six decimals, so
   the four digits below the ledger's resolution go to **a real line (2900)** rather
   than into a rounding error nobody can find.
2. **Gas is not posted.** Account `5300` is the right home and is deliberately
   empty: gas is paid in ETH, the chart has no ETH-denominated asset account to
   credit, and converting wei to cents needs an ETH/USD rate this system has no live
   source for. **Inventing one is worse than the gap.** The actual `gasCostWei` is
   carried on the outcome and written into the entry description, so nothing is
   lost, only unposted.
3. **1140 did not reconcile to the wallet**, because the opening 20 USDC from the
   faucet never entered the books. **Now closed** — account `3200 Contributed
   capital — testnet funding` exists and the opening balance is booked under key
   `usdc:opening-funding:circle-faucet`. Today's reconciliation: treasury 1,850¢ +
   Circle 90¢ = 1,940¢ on chain, 1,940¢ in 1140, difference 0, RECONCILES.

**And the reconciler's remaining hole, same shape as instance 7:** `incomplete` can
only be set *inside* the branch that runs when `CIRCLE_API_KEY` is present. With
the key unset the script reconciles the treasury alone, reports "1 wallet(s)", and
**prints the original wrong answer as drift**. A 200 with an unexpected body, or a
page-limited wallet list, is silent for the same reason. Week two: **the venue list
is a claim about the world, so it belongs in the database next to the account it
reconciles**, with the script refusing to run when it cannot prove it has them all.

### 5.10 The cross-border payout has no last mile

The quote is built, priced off a genuinely live mid rate (`frankfurter.dev`, ECB
daily reference rates), accepted on a screen, and the payout gate refuses an
unquoted payout with `FX_QUOTE_NOT_ACCEPTED`. **Three things are not built and all
three are printed on the screen above the button:** there is **no off-ramp partner,
so no peso has ever been delivered** — every delivery amount is a *commitment*;
**nothing is hedged**, and the screen shows the live position on every open
commitment rather than hiding that we carry it; and **the Send button does not
send** — it runs the gate against the real database, reports the verdict, and
prints the operator CLI. A button on a public URL that signs with a wallet key on
every click is a worse design.

**Nothing in this feature touches `journal_line`.** The only non-USD number in the
database is `fx_quote.buy_minor`; it is a promise, not a balance; no view adds it
to a dollar; and `fx.integration.test.ts` asserts that
`SELECT DISTINCT currency FROM journal_line` returns `['USD']` after the whole
suite has run. **Multi-currency is explicitly out of scope and finishing this did
not introduce it.** Corridors are a closed list of five rather than "whatever the
rate source returns", because listing thirty currencies would dress the missing
off-ramp up as coverage — and JPY is on it specifically because its minor-unit
exponent is 0, which keeps the arithmetic general.

### 5.11 Disputes: the network's verdict is operator-driven, because there is nobody to ask

`POST /v1/simulate/chargeback` and `POST /v1/simulate/dispute` are both **404** in
Lithic's sandbox, measured. So the card, the authorisation, the clearing and the
settled charge under dispute are **live**; the intake, the provisional credit and
the evidence workflow are **ours**; and the verdict is operator-driven.
`recordDecision()` takes the outcome as an argument for exactly that reason, and
`dispute.network_case_ref` is nullable **because in this deployment there is no
network case to reference.**

The judgement it turns on: when a dispute is **lost**, the clawback is a **new
event at a new value date**, not a correction of the provisional credit. We did not
grant that credit in error — we granted it on an outcome that had not happened yet
— and reversing it at the original value date **would delete the fact that the
customer had the money for three weeks**, which is a fact a regulator and the
customer both care about. The credit is real money in the ledger on the day it is
granted **and it is held**, because we may have to take it back.

### 5.12 The smaller ones, named so they are not discovered

- **`rail_event_semantics.canonical_kind` is decorative** (§3.10), and the seed
  **upserts** that table, so a re-seed can rewrite a classification silently.
- **`listPostingRows()` still excludes future-dated entries**, so the committed
  outflows that now reduce `available` are named on the screens but not itemised
  among the postings that explain them.
- **`scripts/precommit.sh --audit`** was documented in a comment before it
  existed as code — a comment documenting a capability the file did not have,
  which is the same class of over-claim as a probe reporting live without a
  round trip. **Closed:** the flag is implemented at `scripts/precommit.sh:21`
  and prints the secret/public partition of `.env` it is assuming.
- **Standing orders' "book days" is calendar-day subtraction** while the prose
  implies banking days; the banking-day code exists in the funding module and is
  not used there.
- **`aba.ts` says 88.9% and `docs/PAYEES.md` says 89.03%**, and neither says which
  is the population value and which is the corpus.
- **The standing-order concurrency proof is a transcription**, not a captured
  artefact: the suite is gated on `RUN_DB_TESTS=1` and CI holds no credentials.
- **Circle has no operator entry point** — no script, no route, no server action.
  `stablecoinProviderHealth()` is not wired into `/api/health` and `.env.example`
  documents no `CIRCLE_*` variable. The transfer happened; the path to repeat it is
  a library call.
- **`/api/sim` exists behind `SIM_CONTROL_ENABLED`**, absent or `false` in any
  shared environment, and absent in this deployment.
- **Some edge states are labelled fixtures.** On `/funding`, `/payments` and
  `/pots` the edge state is live. Elsewhere the page says it is a fixture —
  `/standing-orders`, for instance, needs the ledger above the amount and available
  below it, which is a transient fact about somebody else's card holds.
- **The recon breaks screen printed `age -447d` tonight** (§3.11).
- **`/api/health`'s `business_registry` provider label still says "simulated"**
  while the slot is live on GLEIF (§4.1).

### 5.13 What the cut list says about cuts, briefly

Six of the eight things cut at T+2h were built; **all six stretch-ladder rungs are
built**, three of them carrying a named gap. **The v0 ordering was wrong twice**,
and both changes are recorded rather than presented as a plan executed: card
controls came *off* the week-two list because live fire found a gap that did not
exist as a concept at T+2h — nothing reported webhook delivery freshness, so an
issuing-provider outage was invisible to the one endpoint whose job is to be
believed, **and an outage you cannot see is worth more than a control you have not
shipped** — and then came *back* once the freshness work landed, because a real
`card_webhooks` probe is what arms the alarm and the ASA endpoint is what made that
probe worth writing.

Still cut on purpose: the mobile app (fourteen responsive screens instead), a
public REST API (the MCP surface proves the hard half — an external caller that can
read the book and can only *request* money movement), wires (the `approval_policy`
row exists at threshold $0 requiring two distinct approvers; the rail does not),
multi-currency (ruled out by the brief), our own card processing / identity checks
/ bank linking (*buy, don't build*), and an authentication system.

---

## 6. The ten minutes I drive

1. **`/api/health`** — 7 of 7 live, and read one `evidence` string out loud. Say
   what `live` means here: **a round trip, not a credential**.
2. **`node scripts/coreloop.mjs`** — the whole brief's loop, one command, against
   the deployed URL, on a business that is deliberately not the demo favourite.
   Let it print the KYB gate's refusal and allowance side by side before leg 1.
3. **Leg 4 on screen** — $50 authorised, $73.40 settled. Point at the two books:
   available fell $50 with the ledger still; then the ledger fell $73.40 and the
   hold came off. **Say the over-capture is not special-cased anywhere.**
4. **Leg 6 on the statements screen** — the same day, two watermarks, two numbers,
   and the second one is not an edit.
5. **Leg 5's refusal** — SQLSTATE 42501 from `assert_maker_checker()`, and say that
   the screen's disabled button is not the guard.
6. **Then hand them the keyboard** and let §1 be the thing they remember.

---

## 7. What I could not explain, and comments that contradict their code

*The automatic fail is "code you cannot explain line by line when we point at
it." The defence is not pretending this list is empty. It is having the list,
knowing it is the list, and being able to say what is unresolved versus what is
merely undocumented. Everything here was found by reading the file tonight.*

### 7.1 Genuinely unresolved — I do not know the answer

- **Migration numbering.** `0004` and `0010` do not exist. No file explains the
  gaps, and nothing in `DECISIONS.md` accounts for them.
- **`boundary.test.ts` versus `plaid/adapter.ts`.** `resolveChart` is raw SQL
  against `account` from outside `src/lib/ledger/`, which is the exact shape the
  ratchet forbids. Either it is on the 235-item allowlist or the ratchet is not
  enforcing what three comments say it enforces. **I could not determine which.**
- **`accrual/interest-store.ts`'s watermark claim.** `interest.ts`'s header says
  a concurrent commit during `basisAt` means *"the two answers differ and the
  INSERT is refused"*. The lifecycle trigger re-derives
  `ledger_settled_cents(account, date, NEW.observed_booking_seq)` at the
  **stored** watermark — a pure function of its arguments, which will therefore
  always agree with whatever `basisAt` computed. The trigger can detect a
  *miscomputed* balance at a given watermark; it cannot detect a *stale*
  watermark. **I cannot reconcile the claim with the code.**
- **`home/summary.ts`'s `HEALTH_TIMEOUT_MS = 12_000`** with the comment *"The
  health probe fans out to five providers; each has its own 4s budget."* 5 × 4 =
  20, not 12. Either the fan-out is concurrent (4 s would do) or sequential
  (12 s truncates it).
- **Why livefire attack 1 asserted `50000n` against `45000n` at 04:41Z.** The
  diagnosis in §0.2 — another agent's $50 hold inside a shared business's frozen
  window — fits the arithmetic exactly and matches DECISIONS 028's named latent
  vulnerability, but I did not prove it by attributing the extra hold to a
  specific concurrent run.

### 7.2 Comments that contradict their own code

- **`kyb/manual-review.ts`'s header names a function `approveLegIsPermitted`
  that does not exist.** The implementation is `reviewRefusal`.
- **`accrual/screen.ts`** says `Promise.all` gives *"one read rather than four
  that could interleave"*. It gives four-or-five interleaved snapshots.
  `home/summary.ts` states the opposite, correctly, for the same reason.
- **`integrations/delivery-health.ts`** says Stripe Connect *"is not enabled"*;
  `probe.ts:296` in the same build says it **is** *("now enabled — retired
  Accounts v1")*. The stale one ships in the API response as a
  `thresholdRationale`.
- **`mcp/tool-list-card-controls.ts`** — `Math.round(d.decisionLatencyUs / 1000)`
  under a comment that says *"Integer division, because a fractional millisecond
  is not a fact anybody needs."* It is float division then rounding. Numerically
  harmless; it is the one place a comment asserting the integer-money discipline
  describes a line that does not follow it.
- **`rails/wire/ledger.ts`** — *"THERE IS NO BRANCH IN THIS FILE THAT MENTIONS A
  RAIL. Search this file for `if` and you will find no rail in one."* Strictly
  true of the `if`s, and the file hard-codes `WIRE_COUNTERPARTY_CLASS`,
  hard-codes `1110` as the contra where the ACH path uses `1130`, and passes
  `rail: 'wire'` to four calls. The narrow claim is phrased as the broad one.
- **`payees/aba.ts` says 88.9% and `docs/PAYEES.md` says 89.03%**; the first is
  the population value, the second this corpus, and neither says which.
- **`fx/rate.ts`** defends truncation as avoiding *"a rounding rule nobody could
  name the direction of"* — truncation of a positive number **is** round-down,
  which is nameable and is in the house's favour. Right choice, wrong reason.
- **`payees/name-match.ts`** claims no number of interior differences can drop a
  name out of `match`; thirteen can (§3.23).
- **`disputes/operations.ts`'s header** claims one transaction per transition
  with the event inside it; true of three paths, false of six.
- **`scripts/precommit.sh --audit`** was documented in a comment before the
  argument handling existed. Closed — it is implemented.
- **`db/migrations/0001_ledger.sql`'s comment** on `v_deposit_control_drift`
  claimed the view *"cannot silently break"* when a sub-account level is added.
  It broke, eight lines below the sentence (instance 6). **The comment is now
  true and it was false for two days.**

### 7.3 Dead, unreachable, or unused — named so a grep does not surprise anyone

- **`persona.ts` lines 151–152 are a doubled comment opener** (`/**` inside
  `/**`); the first is dead text. `scriptFor()` has no caller; `PERSONA_EVENTS`
  is exported and unused.
- **`approvals/state.ts`'s `canTransition`** has a second `includes(kind)` clause
  that is dead entirely.
- **`kyb/index.ts`'s `evidenceCeiling`** is typed `Evidence` and can only ever
  return `live` or `simulated` — the health endpoint's ceiling **cannot express
  `manual`**, the third label the lattice was extended for.
- **`wire/semantics.ts`'s `wireSemanticsKey`** is exported, correct, and called
  by nothing: the wire rail decides in a `switch` and never reads
  `rail_event_semantics`, while three comments reference rows in it.
- **`mcp/approvals-port.ts`** declares a one-method port nothing implements by
  name; it documents three properties it asserts are true of `requestPayment`
  *"verified by reading the file"* — a cross-module promise a type could have
  held and does not.
- **`mcp/jsonrpc.ts`'s `JsonRpcError` and `isNotification`** are exported and
  unused; `server.ts` checks `rpc.id === undefined` inline.
- **`wire/types.ts`'s `IncreaseWireReversal.return_reason_code`** is the field
  whose non-null case is the entire argument against `supports.reverse`, and it
  has **never been observed non-null**.
- **`measured.ts` carries `"input_cycle_date": "-4712-01-01"`** — the Julian
  epoch, Increase's null sentinel for a date, pasted verbatim (correctly) and
  declared nowhere, so anyone who reads it gets a date 6,700 years in the past
  with no marker that it means "absent".

### 7.4 The two explicit TODOs

- **`mcp/auth.ts`** — fold `MCP_AGENT_TOKENS` into `envSchema`; blocked because
  `src/lib/env.ts` is owned by another worker.
- **`mcp/audit.ts`** — ~28 lines of `mcp_audit` table DDL carried as
  `TODO(migrations owned elsewhere)`, with the audit trail for MCP reads being
  log lines only until it landed. **Closed:** the table landed in
  `db/migrations/0035_audit.sql` and was wired to the MCP surface in
  `0037_mcp_audit_wiring.sql`.

### 7.5 Three inconsistencies across the repo, said before they are found

1. **Error-code translation has two incompatible house styles.**
   `onboarding/open.ts` and `disputes/operations.ts` map by **SQLSTATE** and say
   message-matching is unacceptable. `pots/transfer.ts`, `fx/store.ts` and
   `approvals/refusal.ts` map by **substring against migration exception text**.
   Both positions are argued in comments; neither cites the other.
2. **Two opposite answers to "a row I cannot parse."** `recon/diff.ts` **throws**
   (taking out the whole breaks screen); `kyb/wire.ts` **drops the row** (and
   can upgrade a verdict, §3.23). Both argued; neither cross-referenced.
3. **One `toCents` rule, four implementations.** `recon/screen.ts`,
   `statements/screen.ts` and `standing/screen.ts` each define a private throwing
   version with near-identical comments; `approvals/screen.ts` uses a bare
   `Number()`. And two of them apply the money-refusal function to **`booking_seq`**,
   which is a sequence number, not cents.

### 7.6 What I did not read

Test files, beyond their headers. Three of them are load-bearing for claims the
source comments make and deserve a targeted read before the debrief:
`rails/contract.test.ts` (asserts the capability matrix matches `docs/RAILS.md`
verbatim, and holds the compile-time assertion that `RailLiveness` equals
`probe.ts`'s `Liveness`), `ledger/boundary.test.ts` (see §7.1), and
`holds/fuzz.test.ts` (owns the order-independence properties `model.ts` asserts
in prose). Also unread: `docs/{MCP,AGENT-LIMITS,FX,STABLECOIN,HOLDS,FUZZ,ACCRUAL,WIRES,TIMETRAVEL}.md`
beyond targeted greps — other workers own them.

---

*Every measurement in this document was taken by one worker on 2026-09-11 between
04:26Z and 04:44Z against `https://corgi-trial-psi.vercel.app` and the live Neon
database, commit `4c682e1`. Twelve agents are writing this repo concurrently, and
three things changed underneath these measurements while they were being taken —
`dbcheck` went 24/1 → 26/0, migration 0026 was applied, and `model.ts` was
rewritten — all three are named in §0. **Re-run before quoting. A number in this
file with no clock beside it is a bug in this file.***
