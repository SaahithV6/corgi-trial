# What a model could learn from this book — measured, then a proposal

**This is a feasibility pass. Nothing here is built.**

The question put to this worker was Saahith's: *train a model to decide who to
spend on.* Part 1 answers it by counting. Part 2 proposes what to build instead,
and argues against each proposal as hard as it argues for it.

Everything numbered below was read from the **live Neon book as `corgi_app`**
between **2026-09-11T14:55Z and 15:05Z**. The commands are inline. Twelve agents
write this repo concurrently, so re-run before quoting: the counts move, the
*conclusions* do not, because they turn on orders of magnitude and not on
margins.

---

## 0. How to reproduce every figure in this file

```bash
set -a; . ./.env; set +a
node scripts/rebuild.mjs        # §1.6 — the independent reconstruction
node scripts/dbcheck.mjs        # §1.7 — the invariant tally
```

Everything else is a single SQL statement against `APP_DATABASE_URL`, quoted
where it is used.

---

# Part 1 — the measurements

## 1.1 `card_auth_decision`, by source and outcome

```sql
SELECT source, outcome, count(*), min(decided_at), max(decided_at)
  FROM card_auth_decision GROUP BY 1,2;
```

| source | outcome | rows | first | last |
| --- | --- | ---: | --- | --- |
| `provider` | approve | **51** | 2026-09-11T00:43:20Z | 2026-09-11T14:27:35Z |
| `provider` | decline | **17** | 2026-09-11T00:42:24Z | 2026-09-11T14:20:33Z |
| `harness` | approve | 28 | 2026-09-10T23:50:50Z | 2026-09-11T14:29:05Z |
| `harness` | decline | 32 | 2026-09-10T23:50:49Z | 2026-09-11T14:29:07Z |
| | **total** | **128** | | |

**68 rows in the provider lane.** That is the entire real-world decision history
of this system. It is 14 hours 45 minutes long.

By rule, the provider lane divides as: `no_controls_configured` 38 ·
`per_transaction_limit_exceeded` 10 · `card_not_under_control` 10 ·
`within_controls` 3 · `control_store_unavailable` 3 · `mcc_blocked` 2 ·
`daily_limit_exceeded` 1 · `member_daily_limit_exceeded` 1.

**Read the approvals column carefully, because it is the single most useful
number in this file.** Of 51 provider-lane approvals, **48 were approved by a
rule that judged nothing**: 38 `no_controls_configured` (the card is ours, no
control set exists) and 10 `card_not_under_control` (the token is not in this
book). Only **3** were approved by `within_controls` — i.e. by a rule that
actually compared a figure to a limit.

```sql
SELECT count(*) FROM card;                        --  911
SELECT count(DISTINCT card_id) FROM card_control_version;  --   31
```

**31 of 911 cards carry any control version at all.** The real-time path is
live, correct, fast and — on the overwhelming majority of traffic — *silent*.

> ### Re-measured 2026-09-11T16:33:42Z — and the direction matters
>
> The readings above are true of 14:55Z and this file said to re-run before
> quoting. Re-run:
>
> | | 14:55Z | **16:33Z** |
> |---|---|---|
> | provider-lane approvals | 51 | **67** |
> | …approved by a rule that judged nothing | 48 (**94%**) | **55** (**82%**) |
> | …approved by `within_controls` | 3 | **12** |
> | cards | 911 | **962** |
> | cards with any control version | 31 | **55** |
>
> **Both numbers moved and they moved in opposite directions.** The *proportion*
> of unjudged approvals improved from 94% to 82%, because controlled cards are
> being issued and `within_controls` went 3 → 12. The *absolute count* of
> unjudged approvals got worse, 48 → 55, because every suite that registers a
> card through `registerCard()` mints an uncontrolled one faster than issuance
> mints a controlled one.
>
> Reporting either alone is misleading — the ratio alone reads as progress, the
> count alone reads as decay, and the true statement is that **the decision path
> is fine and the registration path is outrunning it.** §3's argument is
> unaffected and is arguably strengthened: the system still has no opinion on the
> overwhelming majority of its traffic.

## 1.2 Cards, businesses, MCCs actually observed

```sql
SELECT count(*), count(DISTINCT card_id), count(DISTINCT mcc),
       count(DISTINCT merchant_descriptor), count(DISTINCT amount_cents)
  FROM card_auth_decision;
```

| | |
| --- | ---: |
| businesses in the book | **8** (6 with any `2100` activity) |
| cards | 911 |
| cards with at least one decision | **60** |
| **distinct MCCs in `card_auth_decision`** | **2** — `5542` and `5812` |
| distinct merchant descriptors | 50 |
| **distinct authorisation amounts** | **11** |

Two MCCs. Eleven amounts, of which `$50.00` accounts for 76 of 128 rows and
`$6.00` for 14.

The wider universe — every Lithic `card_transaction.updated` payload, not just
the ones the ASA path saw — is no better, and is worse in an instructive way:

```sql
SELECT payload->'merchant'->>'mcc', count(*)
  FROM webhook_inbox
 WHERE provider='lithic' AND event_type='card_transaction.updated'
 GROUP BY 1;
```

169 distinct MCCs across 928 deliveries. **715 of the 928 are MCC `5542`**
(the fuel-pump fixture), 26 are `5812`, and **154 of the 169 MCCs appear exactly
once.** One city. 445 descriptors.

That is not a merchant distribution. It is a random-code generator with a fixed
head, and the shape is diagnostic: a model fitted here would learn the fuzzer,
not the customer.

## 1.3 Per-card history depth — the feature that does not exist

"Deviation from that business's own history" needs a history. There is none.

```sql
SELECT n, count(*) FROM (SELECT card_id, count(*) n FROM card_auth_decision
                          WHERE card_id IS NOT NULL GROUP BY 1) t GROUP BY 1;
```

| decisions on the card | cards |
| ---: | ---: |
| 1 | **43** |
| 3 | 14 |
| 5 | 1 |
| 10 | 1 |
| 11 | 1 |

**43 of 60 cards have exactly one decision.** The same holds one level down:
966 `card_authorization` rows spread over **750 distinct cards**, of which 747
hold four or fewer.

A "how unusual is this for this card" feature has, for 72% of cards, a
denominator of zero.

## 1.4 `journal_entry` — count and the span of value dates

```sql
SELECT count(*), min(value_date), max(value_date), count(DISTINCT value_date),
       min(booking_time), max(booking_time), max(booking_seq) FROM journal_entry;
```

| | |
| --- | ---: |
| entries | **4,824** |
| lines | **9,656** |
| distinct value dates | 306 |
| value-date range | **1606-04-01 → 2027-12-08** |
| booking-time range | **2026-09-10T01:48:23Z → 2026-09-11T14:51:32Z** |
| max `booking_seq` | 5,859 |

**The entire book is 1 day, 13 hours and 3 minutes old.** That is the whole
answer to the time-series question, and everything below only restates it.

The value-date span is wide and it is *deliberate defect data*, not history:

| band | entries | distinct days |
| --- | ---: | ---: |
| pre-2000 | 345 | 53 |
| 2000–2025 | 1,367 | 206 |
| 2026-07-24 → today | **2,916** | **17** |
| future (to 2027-12-08) | 196 | 30 |

`v_value_date_out_of_band` holds **1,712** rows; `journal_value_date_residue`
explains **1,596** of them by name; `v_value_date_unexplained` is **0**. The
1606 dates are the value-date fuzzer, already caught, already accounted for.

## 1.5 Is there a time series per business? No.

```sql
SELECT b.legal_name, count(DISTINCT je.id), count(DISTINCT je.value_date)
  FROM business b JOIN account a ON a.business_id=b.id AND a.code='2100'
  JOIN journal_line jl ON jl.account_id=a.id
  JOIN journal_entry je ON je.id=jl.entry_id
 WHERE je.value_date BETWEEN '2026-07-01' AND current_date GROUP BY 1;
```

| business | entries in a plausible period | **distinct days** |
| --- | ---: | ---: |
| Ridgeline Robotics, Inc. | 365 | **16** |
| Holds Integration Fixture Co. | 298 | 12 |
| Kettle & Crumb Bakery LLC | 195 | 5 |
| Hold Fuzzer Fixture Co. | 171 | 6 |
| Live Fire — attack 3 (bitemporal) | 99 | **1** |
| Pots Integration Fixture Co. | 33 | 11 |

Six businesses have any current-account activity. The longest series is
**16 non-contiguous days**, on a fixture company, written over 37 wall-clock
hours. Two of the six are named *"Live Fire — attack N"*: they are attack
fixtures, not customers.

There is no seasonality, no weekday effect, no trend, no burn rate, no
pre-period. A 16-point series with no generative process behind it is not a
series; it is six numbers and some noise.

## 1.6 Does *any* labelled outcome exist? Yes — one, and it is unusable.

This is the part worth reading, because the honest answer is not "no".

### Disputes — the only genuine labels in the book

```sql
SELECT reason, count(*), sum(won::int), sum(lost::int), sum(withdrawn::int),
       count(DISTINCT business_id) FROM v_dispute_state GROUP BY 1;
```

| reason | n | won | lost | withdrawn | businesses |
| --- | ---: | ---: | ---: | ---: | ---: |
| `fraud` | 13 | 0 | 9 | 4 | 1 |
| `goods_not_received` | 8 | 0 | 8 | 0 | 1 |
| `duplicate` | 8 | **6** | 2 | 0 | 1 |
| **total** | **29** | 6 | 19 | 4 | **1** |

Terminal states: 11 `closed_lost_recovered`, 8 `closed_lost_written_off`,
6 `closed_won`, 4 `withdrawn`. 135 `dispute_event` rows across ten kinds.

**These are real labels.** They are also, all 29 of them, one business, three
reason codes, and an outcome that is close to a deterministic function of the
reason: every `goods_not_received` lost, every `fraud` lost or withdrawn, six of
eight `duplicate` won. A classifier trained on this learns `reason`, reports
~93% accuracy, and has learned the seed script.

### The other candidate labels, counted

| label the brief's domain would supply | where it would live | **count** |
| --- | --- | ---: |
| outbound ACH **return** | `webhook_inbox` `ach_transfer.updated` | **4 deliveries total**, no return among them |
| inbound ACH **recall** | `inbound_ach_transfer.updated` | 10 deliveries; **1** booked recall |
| authorisation later **reversed** | `card_auth_event.kind='authorization_reversal'` | 59 events / 52 authorisations |
| settlement **corrected** | `RETURN_REVERSAL` / `CORRECTION_*` | ~10 correction groups |
| payment **rejected** at approval | `payment_instruction_event` | 15 of 519 |

`payment_instruction_event` carries exactly four kinds — `requested` 519,
`approved` 207, `released` 58, `rejected` 15 — and **no** `settled`, `returned`
or `failed`. The outcome column a credit model needs is not merely sparse. It is
**not in the state machine**.

52 reversed authorisations is the largest label set with real provider
provenance behind it, and it is a *mechanical* label (the merchant released the
hold), not an *economic* one (the customer was a bad risk).

## 1.7 What the book does have, in quantity

Stated because the verdict in §2 is "no model", and a reader is entitled to ask
what the 4,824 entries are good for.

| | |
| --- | ---: |
| webhook deliveries received | **1,702** (lithic 1,294 · increase 395 · stripe 10 · plaid 3) |
| … `done` / `parked` / `dead` | 1,439 / 178 / 85 |
| card auth events | 1,850 across 8 kinds |
| holds | 1,064 (320 closed, 3 closure-reversed) |
| published statements | 62, over 29 days, max version 4 |
| recon runs / breaks | 3,104 / 6,815 across 1,004 scheme files |
| views in the schema | **118**, of which ~**49** are invariant-shaped |
| `rail_event_semantics` rows | **30** |
| `audit_source` catalogue | 74 stores, `v_audit_coverage_drift` = 0 |

`node scripts/dbcheck.mjs`, run at 15:00Z: **42 passed, 4 failed**.
The four are open findings, each named: `v_refused_auth_hold` 257 rows,
`v_hold_expiry_drift` 12, `v_hold_closure_unexplained` 4,
`v_advice_delta_unsound` 1.

`node scripts/rebuild.mjs`, run at 15:00:14Z, watermark `booking_seq <= 5859`:

```
14 checks · 0 rebuild disagreement(s) · 12 fact-vs-fact disagreement(s) · 2887 ms
```

Thirteen of fourteen checks OK, including every derivation: settled balance on
53 accounts, `H(E)` on 966 authorisations, hold state on 1,064 holds,
availability and all five terms on 7 deposit accounts, and **62 of 62 statement
content hashes re-derived byte-identically**. The only findings are the twelve
`hold.expires_at` / `card_authorization.expires_at` pairs written from two clock
reads — a fact-vs-fact disagreement, exposure $0.00, already documented in
`docs/REBUILD.md` §4 (it was 9 there; fixtures added 3 more).

ASA latency, read off `card_auth_decision` rather than a log:

```sql
SELECT count(*), min(decision_latency_us),
       percentile_disc(0.5) WITHIN GROUP (ORDER BY decision_latency_us),
       max(decision_latency_us)
  FROM card_auth_decision WHERE source='provider';
```

68 rows · min **11.7 ms** · p50 **24.6 ms** · p95 508 ms · max 601 ms (the
induced outage, at its 600 ms deadline). Excluding the three outage rows: 65
rows, p50 **21.1 ms**, max 508 ms. **Zero of 128 decisions exceeded the 1,400 ms
handler budget, Lithic's 3,000 ms recommendation, or the 6,000 ms timeout.**

> ### Re-measured 2026-09-11T16:42:09Z — do not quote a p50 for this lane
>
> At 16:33Z the provider lane reads **85 rows, p50 134.6 ms** — five times the
> figure above, from the same query against the same column. Elsewhere this build
> publishes **14.2 ms** for the same path. All three are honest readings and the
> spread is the finding, not an error in any of them.
>
> **The lane is bimodal.** Bucketed at 16:42:09Z: **38 decisions under 30 ms, 42
> between 30 and 200 ms, 5 over 200 ms.** 38 against 42 puts the median exactly on
> the boundary between the two modes, so it flips with the sample. By hour, the
> provider-lane p50 reads 124.8 ms, 138.8 ms, **17.0 ms**, 147.1 ms, 162.3 ms.
>
> So the p50 of this path is not a stable statistic and should not be quoted as
> one — including the 24.6 ms above. What survives re-measurement:
>
> * **Max 601.5 ms across all 159 decisions ever taken**, against a 1,400 ms
>   handler budget, a 3,000 ms recommendation and a 6,000 ms cap. The worst case
>   is inside the tightest ceiling by a factor of four, and that claim does not
>   depend on a median.
> * **Excluding the deliberate fail-closed rows: 81 decisions, p50 125.1 ms, p95
>   177.5 ms.** The over-200 ms bucket is `control_store_unavailable` spending its
>   600 ms budget before declining — a designed behaviour, not a slow query.
>
> §2's latency argument is unchanged: the headroom is in the thousands of
> milliseconds and the score's inputs ride the same single statement.

---

## 2. The verdict on a credit or spend-optimisation model

# No.

Not "not yet", not "with more feature engineering". No — and the reasons are
structural rather than quantitative, which is why more hours would not fix them.

**1. There are no labels for the thing being predicted.** "Who to spend on"
needs an outcome: a loss, a write-off, a return, a default. `payment_instruction`
has no terminal failure state at all. Outbound ACH returns: **zero**. The one
labelled population in the book is 29 disputes, all belonging to **one**
business, whose outcome is very nearly `reason` restated.

**2. There is no time axis.** The whole ledger was written in **37 hours**. The
deepest per-business series is **16 non-contiguous value dates**, on a fixture
company. Every credit feature worth having — trend, volatility, seasonality,
days-since, burn rate — is a function of a time axis that does not exist.

**3. The feature space is two MCCs wide and eleven amounts deep.** 715 of 928
card deliveries are one MCC. 154 of 169 MCCs occur once. A model would fit the
generator.

**4. The unit of prediction has n ≈ 6.** Eight businesses, six with any
activity, two of them named "Live Fire — attack N". Six rows is not a training
set under any regularisation.

**5. Per-entity history is absent where the model would need it most.** 43 of
60 decided cards have one decision. 747 of 750 authorised cards have ≤4
authorisations.

**The honest ceiling.** With 68 provider decisions, 29 one-business disputes and
a 16-day maximum series, the *largest* defensible supervised artefact is a
three-class classifier over `dispute.reason` — which is `CASE reason WHEN …`
wearing a coefficient. Shipping it would be a toy, and a panel that has built
this platform would identify it as one inside thirty seconds. **"We measured the
book and there is not enough signal to train on" is the result, and it is a
better result than the toy.**

**What would change the answer**, stated so the claim is falsifiable: roughly
10²–10³ businesses, 6–12 months of postings per business, a terminal-failure
state on `payment_instruction`, and a merchant stream whose MCC distribution is
not 77% one code. None of those is producible in the hours remaining, and three
of them are not producible in a sandbox at all.

### The narrow thing that *is* learnable, and why it still should not ship

Two candidates survive the measurement, and both are rejected:

* **Velocity outlier detection per card** — z-score of an amount against that
  card's own prior approvals. Dies on §1.3: 43 of 60 cards have n=1.
* **Provider-latency prediction** (cold-start vs warm from the bimodal
  distribution in `card_auth_decision`). Genuinely fittable on 68 points, and
  completely worthless: it predicts Vercel's scheduler, not the customer's risk,
  and `docs/CARD-CONTROLS.md` §7 already names the cold lane as an inference.

---

# Part 2 — the three candidates

Each is judged against exactly three questions, because those are the ones the
rubric asks:

1. **Do the mechanics land in the schema?** (30 points, and the only 30-pointer.)
2. **Can it be shown in under a minute?** (25 points, and a demo clock.)
3. **Can every number it shows be traced to an immutable row?** (15 + 10.)

Ranked. The best one is not the most novel.

---

## Candidate 1 — a derived risk score on the ASA decision, that is **recorded and does not decide**

### What it shows

One number on the real-time authorisation path, computed from the card's own
velocity, the merchant category and the deviation from that business's own
posting history — written onto the `card_auth_decision` row beside the rule that
actually decided, with the **policy version it was scored under pinned by id**,
and rendered on the card-controls panel next to the verdict.

And a policy row that says, in data, `advisory` — so the score is visible,
explainable, versioned and **currently decides nothing**.

### Why this one is first

§1.1 is the argument. **55 of 67 provider-lane approvals were approved by a rule
that judged nothing** (48 of 51 when this was first written), and 55 of 962 cards
carry any control at all. The ASA path is live, enrolled, measured and, on the
traffic it actually sees, *mute*. This is the only candidate that puts an opinion
where the system currently has none — and the absolute number of mute approvals
has grown since the proposal was written, which strengthens it.

The latency objection is already answered by measurement, and by the bound rather
than the median: **max 601.5 ms across every decision ever taken**, against a
600 ms control-read deadline, a 1,400 ms handler ceiling and a 6,000 ms
provider cap — and migration 0033 already proved the shape, adding the
per-member velocity as a second `CROSS JOIN LATERAL` aggregate in the **same
single statement**, costing no round trip and no second deadline. The score's
inputs go in the same way. Server-side execution today is **0.665 ms**.

### What it would take

* One migration: `card_risk_policy_version` — append-only, `UNIQUE(scope,
  version)`, contiguity trigger, weights and thresholds as columns, a mandatory
  `note`, a `mode` column with `CHECK (mode IN ('advisory','enforcing'))`, and
  `created_by`. Modelled on `approval_policy` (0001) and `card_control_version`
  (0014) because that is the pattern this repo already argues for: *a decision
  is judged under a policy VERSION, cited by id, so a later change cannot
  retroactively make a past decision look wrong.*
* Two columns on `card_auth_decision`: `risk_score` and `risk_policy_version_id`,
  pinned exactly as `control_version_id` and `member_version_id` already are.
* Three extra aggregates in the existing hot-path statement. No new round trip,
  no new deadline.
* The score's compared figures into the existing `inputs` jsonb, **as decimal
  strings**, following the rule already enforced there.
* One rule at the bottom of `RULE_ORDER`, below `within_controls`, that in
  `advisory` mode records and approves.

Roughly a migration, ~150 lines, and two integration scenarios.

### What could go wrong in a demo

* **It declines nothing, so it looks like it does nothing.** Mitigated by
  showing the score on a decision the controls approved — which is 55 of 67
  provider-lane rows — and pointing at the policy row that says why it did not
  act.
* Flipping `mode` to `enforcing` live would be a one-word change to the most
  consequential path in the build. **Do not.**
* The panel asks what the weights are worth. The answer must be "nothing yet,
  and here is the row that says so".

### The strongest argument against it

**It manufactures a decision on data that cannot justify one.** Part 1 spent
2,000 words establishing that this book has two MCCs, eleven amounts and no
per-card history — and then Candidate 1 proposes scoring on MCC, amount and
per-card history. The score's *only* possible effect on an outcome is to decline
something the controls approved, because `RULE_ORDER` is first-match-wins and it
sits below `within_controls`. So the feature can only ever make the system
refuse more people, on evidence that is 77% one fuel-pump fixture.

There is a second objection and it is sharper: **this repo has a written house
rule that a guard nobody has seen fail is a claim** (`dbcheck --prove` exists for
exactly that), and `docs/CUT-LIST.md` §6 ends on *"tuning any guard until it is
green"* being the one sentence the build would want carried out of the room. A
scoring rule added at hour 47, on the decline path, that nobody has driven to
fail, is the same instinct one table over.

**The `advisory` mode is what answers both objections**, and it is not a hedge —
it is the design. The demo sentence becomes: *"Here is the mechanism, here is the
row it writes, here is the versioned policy that governs it, here is the one-line
change that would let it decide, and here is the measurement that says we have
not earned that change."* A panel that has built this platform will recognise
that as the correct call, and it is worth more than a score that fires.

---

## Candidate 2 — the rulebook screen: `rail_event_semantics`, and an event with no row

### What it shows

The table that decides, for every provider event this system can receive:
what it means, **whether it is a new event or a correction**, and **which field
its value date comes from**. Thirty rows today, with the argument written on the
row. Then: a delivery whose event type has no row **parks the whole payload**,
with the reason on the `webhook_inbox` row, and nothing posts.

This is the brief's items 3, 4, 5 and 6 — settlement-is-not-authorisation,
out-of-order delivery, returns and recalls, bitemporality — answered by a
`SELECT`.

### Why it is here

It is the most literal possible answer to the one line the rubric puts 30 points
on: *the vertical's mechanics live in your SCHEMA, not your README.* The
mechanics are already in a table. Reading two of its rows out loud does more for
the domain-command score than any amount of prose:

> `ach_transfer.updated/returned` → `ach_return` · **new_event** ·
> `payload.return.created_at`
> *"THE row people get wrong. A return is a NEW EVENT with its own value date…
> Booking it at Monday's date would erase a settlement that occurred."*

> `card_transaction.updated/RETURN_REVERSAL` → `refund_reversal` ·
> **correction** · `original.value_date`
> *"The refund was a false statement about its own date."*

Two rows, same book, opposite value-date treatment, and the reason is **data**.

### What it would take

Almost nothing, which is the point. A read-only screen at `/rails` (or a panel
on `/events`) rendering the 30 rows grouped by rail, with `semantics` and
`value_date_source` as columns and the `note` expandable; plus a filter that
joins `webhook_inbox` parked rows to the semantics key they *lack*. Perhaps 120
lines of a server component, zero migrations, zero new writes.

The live half is already true: **178 parked deliveries and 85 dead letters**,
each carrying a written reason on the row — e.g. *"Increase wire … carries
Idempotency-Key 'corgi-itest-…', which names no `payment_instruction` on this
book. NOTHING WAS POSTED … a wire with no approval behind it is an incident for
a person, not a row for a consumer."* Clicking one parked row and reading that
sentence is a 20-second demo.

### What could go wrong in a demo

* Producing a *genuinely* unmapped Lithic event on demand is not reliably
  possible — the simulate endpoints all emit mapped types. **Do not promise to
  create one live.** Show the parked rows that already exist; they are real
  deliveries with real provider ids.
* The screen is a table of text, and a reviewer skimming may read it as
  documentation rather than as a mechanism. The defence is to open the parked
  delivery *first* and the semantics table second.

### The strongest argument against it

**It is a viewer over work that is already done, and it earns few new points.**
The table exists, the parking exists, the argument exists in `docs/RAIL-SEMANTICS.md`.
A screen that renders 30 existing rows adds nothing to *"a system that runs"* (25),
nothing to *"integration reality"* (20), and nothing to *"live fire"* (15). It
moves only the domain-command score, and it moves it by making something
*visible* that a reviewer would find anyway by opening the schema — which they
will, because that is what the 30 points are for.

It is also the candidate most likely to be read as a slide. `docs/TRIAL-VERBATIM.md`
explicitly rewards *"a stablecoin payout that actually confirms on testnet at
2am"* over *"a slide about one"*, and a rulebook screen is closer to the slide
end of that axis than anything else proposed here.

**Build it only if it costs an hour.** If it costs three, it is the wrong hour.

---

## Candidate 3 — rebuild-as-a-row: put `scripts/rebuild.mjs` where a reviewer can see it

### What it shows

`scripts/rebuild.mjs` is the strongest single artefact in this repo and almost
nobody in a 75-minute debrief will see it. It throws every derived number away
and reconstructs the whole book from immutable facts — in a different language,
in a different process, importing **not one line of `src/`** — and today it
reports:

```
14 checks · 0 rebuild disagreement(s) · 12 fact-vs-fact disagreement(s) · 2887 ms
4,824 entries · 9,656 lines · 1,064 holds · 966 authorisations · 1,850 card events
62 of 62 statement content hashes re-derived byte-identically
```

The proposal: an append-only `rebuild_run` / `rebuild_finding` pair, written by
the script, and a screen that renders the **latest run** — the watermark it
pinned, the fourteen checks, the seven rebuilt deposit-account balances, and
every finding with its ids. The screen **reads a stored row; it does not
re-derive.**

### Why that shape, and not clickable lineage on every figure

The obvious version of this idea — *"click any number on any screen and see the
chain of rows"* — is the wrong shape, and this repo has already written down
why. `docs/REBUILD.md` §1:

> *a guard computed from the same input as the thing it guards cannot fail* —
> catalogued twenty-two times under its own name.

A React component that re-derives `available_cents` to show its provenance is a
second derivation *inside the same process, in the same language, over the same
rows, with the same assumptions about what `now()` means.* It would agree with
production for reasons that have nothing to do with the ledger being right. It
would look like proof and be decoration. `v_available_balance` is already
excluded from `rebuild.mjs`'s comparisons for a smaller version of exactly this
reason (it pins itself to `clock_timestamp()`).

So the honest surface is: the page displays what the **independent** process
found, and is explicit that it is a *record of a run* and not a live
computation — with the run's timestamp, watermark and exit code on the face of
it, and a warning when it is stale.

### What it would take

* One migration: `rebuild_run` (started_at, as_of, value_date, watermark,
  isolation, wall_ms, checks_ok, checks_mismatch, exit_code, git_sha) and
  `rebuild_finding` (run_id, check_name, subject_kind, subject_id, detail) —
  both append-only, both under `ledger_row_is_immutable()`.
* ~40 lines in `rebuild.mjs` to write the run at the end. **This is the one risk
  worth flagging loudly:** the script currently runs
  `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, and `READ ONLY` is a
  property it advertises. The write must happen in a **separate transaction,
  after the read-only one commits**, or the guarantee is lost and a reviewer who
  reads the file will notice.
* A screen. ~150 lines, a table and a findings list.

### What could go wrong in a demo

* **The book moves under the run.** §1.7 caught `Holds Integration Fixture Co.`
  at **−$858,941.45** at 15:00Z against **$144,196.35** in `docs/REBUILD.md`'s
  09:12Z run. Another agent is writing. A screen showing a stale run beside a
  live balance invites *"why do these disagree"*, and the answer — different
  watermarks — is correct but costs 90 seconds of the demo. The watermark must
  be on the screen, large.
* The run takes **2.9 s**. Fine for a button; not fine inside a page render.
* Findings are currently non-empty (12) and will stay non-empty. That is the
  right behaviour — *"an invariant view that starts non-empty is a bill, not a
  licence"* — but it must be framed before a reviewer reads it as red.

### The strongest argument against it

**The value lives in the script's independence, and a screen dilutes it.** The
reason `rebuild.mjs` is convincing is that it imports nothing, runs elsewhere,
and is 59 KB a reviewer can read end to end. Rendering its output in the Next.js
app puts the proof inside the thing being proved — not technically (it reads a
stored row), but *rhetorically*, which is what matters in a debrief. The
strongest demo of `rebuild.mjs` may simply be **running it in a terminal on the
shared screen for three seconds**, which costs zero engineering and is available
today.

Second objection: `rebuild_run` is a table about the *system's self-check*, not
about *banking*. It scores on "a system that runs", not cleanly on the
30-point domain line, and a reviewer could fairly call it schema that is not
about the vertical.

---

## 3. Ranking, and what to do if there is time for one

| | candidate | mechanics in schema | <60 s demo | every number an immutable row | new work |
| --- | --- | --- | --- | --- | --- |
| **1** | ASA risk score, **advisory** | **yes** — a versioned policy table, pinned by id | yes — one `simulate/authorize` | yes — `card_auth_decision` is append-only | migration + ~150 lines |
| **2** | `rail_event_semantics` rulebook screen | already there | yes — one parked row | yes | ~120 lines, no migration |
| **3** | rebuild-as-a-row | partly — self-check, not vertical | ~30 s, needs framing | yes, once stored | migration + ~190 lines |

**If there is time for exactly one: Candidate 1.** It is the only one that adds a
mechanic to the schema in the pattern this build already defends, it runs on a
path that is measured and has 24× headroom, and its *refusal to enforce* is the
judgement the last ten points are for.

**If there is time for exactly one hour: Candidate 2**, and stop.

**Candidate 3's zero-cost version — running `node scripts/rebuild.mjs` live in
the debrief — should happen regardless**, and needs nothing built.

---

## 4. What was considered and is not proposed

* **A supervised model of any kind.** Part 1. No labels, no time axis, n≈6.
* **Clickable lineage on every figure.** §Candidate 3 — a second derivation in
  the same process is the failure mode this codebase has catalogued 22 times.
* **A "book health" anomaly screen.** Already built, twice over. 49 of the 118
  views are invariant-shaped; `v_value_date_out_of_band` (1,712 / 0
  unexplained), `v_hold_drift` (0), `v_hold_posting_incomplete` (0),
  `v_interest_gap` (0) are exactly the three defect shapes such a screen would
  hunt, and `src/components/dashboard/decided.ts` already ranks reds against a
  written-down watermark with a decided-vs-new comparator. Proposing it would be
  proposing something finished.
* **Fraud scoring.** `dispute` has 29 rows and one business.
* **Flipping the risk score to `enforcing`.** §Candidate 1, and
  `docs/CUT-LIST.md` §6: *tuning any guard until it is green.*

## 5. Two questions for the panel, asked early

Both are domain questions this book cannot answer from its own rows, and
`docs/TRIAL-VERBATIM.md` grades asking up rather than down.

1. **On the velocity window.** Spend-to-date counts authorisations this system
   approved, so a voided $200 authorisation holds $200 of a daily limit until
   midnight (`docs/CARD-CONTROLS.md` §6 and §10). The error is towards
   declining. **Is that the direction Corgi wants**, or would you rather a
   second query on a budgeted path and the risk of letting a limit be exceeded?

2. **On advisory scores generally.** If a score is computed, recorded and
   pinned to a policy version but decides nothing, is that a feature you would
   ship — or is a number on a screen that never acts worse than no number at
   all, because someone will eventually read it as a decision?

---

*Measured against the live Neon book between 2026-09-11T14:55Z and 15:05Z, as
`corgi_app`. Twelve agents write this repo concurrently; the counts move. Re-run
the statements above before quoting them, and re-read §2 before disagreeing with
it — the verdict turns on orders of magnitude, not on margins.*
