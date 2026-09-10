# Live fire

The seven published attacks, plus the one claim that was still unproven, as
automated tests — so we run them before the graders do.

```
node scripts/livefire.mjs                    # all of them, against production
node scripts/livefire.mjs --only 3,5,6       # a subset, by attack number
node scripts/livefire.mjs --base-url https://…   # somewhere other than production
```

The runner loads `.env`, sets `LIVEFIRE=1`, runs the suite serially, and prints
a scoreboard: attack, verdict, evidence, total. Without `LIVEFIRE=1` every file
here skips, so `pnpm test` does not fire real card authorisations at a provider.

---

## 1. The rules this suite is written under

**No mocks. That is the entire point of it.** Every assertion is against the
live Neon database, a live provider sandbox, or the deployed URL. There is not
one test double in this directory. A suite that proves the code agrees with
itself would have proved nothing about the thing the panel is going to attack.

**A test that cannot prove its claim SKIPS. It never passes.** Where a claim is
unprovable today the test says so in a sentence that names the missing thing,
and the scoreboard prints that sentence in yellow next to a SKIP. The pass count
never includes it. This is the rule that matters most: the previous attempt at
the dedupe claim (DECISIONS 020) *looked* like a pass and was not, and a test
that passes for the wrong reason is worse than one that fails.

**The verdict is not self-reported.** `scripts/livefire.mjs` derives PASS / FAIL
/ SKIP from Vitest's own JSON result, not from anything a test writes about
itself. The tests write only evidence strings; they cannot promote themselves.

**There is no teardown, because money tables are append-only.** Isolation is by
construction instead: every run mints its own Lithic card, its own synthetic
references (`LF6-<tag>-n`), its own idempotency keys, and its own business date
where one is needed. Every assertion is either a DELTA measured across the run's
own window or a lookup BY REFERENCE. Nothing counts rows in a shared table.

**Where something is constructed rather than provider-originated, it says so.**
Two attacks need an event the sandbox will not produce (a clearing that arrives
before its authorisation; a delivery that never arrives at all). Both build the
body from a REAL captured Lithic delivery, reissue its ids, and re-sign it with
this deployment's own `LITHIC_WEBHOOK_SECRET`. The construction is labelled in
the file, in the evidence line, and here. What is simulated is the ORDER and the
ARRIVAL; the body shape, the signature check, the consumer and the ledger are
all the real ones.

---

## 2. What each attack does

| # | File | Claim |
|---|---|---|
| 1 | `attack-01-fuel-pump-authorisation.test.ts` | $50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move |
| 2 | `attack-02-over-capture-release.test.ts` | $73.40 capture releases the hold exactly once; available not clamped |
| 3 | `attack-03-bitemporal-correction.test.ts` | Corrected figure and as-believed figure, both true at once |
| 4 | `attack-04-settlement-before-authorisation.test.ts` | Out-of-order delivery ends exactly where in-order does |
| 5 | `attack-05-maker-checker.test.ts` | Self-approval refused by the DATABASE, SQLSTATE 42501 |
| 6 | `attack-06-planted-break.test.ts` | A row deleted from tonight's file surfaces as `in_ledger_not_file` |
| 7 | `attack-07-provider-outage.test.ts` | An issuing-provider outage degrades visibly and invents no money |
| 8 | `attack-08-real-provider-replay.test.ts` | Dedupe against a genuinely signed provider replay |

### 1 — the fuel-pump authorisation

Creates a card on Lithic, registers it to a customer, and asks Lithic to
authorise $50.00 at MCC 5542. The delivery goes to the **deployed** webhook
endpoint and is drained there — the run nudges `POST /api/drain` with
`DRAIN_TOKEN`, which is the same call an operator makes in the debrief rather
than waiting for the 04:17 cron. Then it reads the effect out of the live
database: available down by exactly 5000, ledger unchanged, the whole of the
drop attributable to card-auth holds, and the financial trial balance unmoved
because a hold is memo-only.

### 2 — the over-capture

Authorise $50.00, clear $73.40. Two tests, because the attack names two things
and only one of them holds today:

* **the money claim** — the hold's memo entries are the opening delta and its
  exact negation and nothing else (one release posting), the ledger posts
  exactly 7340 in exactly one financial entry, the hold stops withholding
  anything, and `available == ledger − holds − uncleared` exactly, in integers,
  with no floor. This passes.
* **the bookkeeping claim** — exactly one `hold_closure` row. This SKIPS, and
  the skip is a real finding rather than a missing feature. See §4.

### 3 — the backdated correction

Posts a $73.40 card clearing on a synthetic settlement day, takes the booking
watermark (that is "the intermediate day"), then reverses at the ORIGINAL value
date. Both answers are then read back in the same run:

* settlement day as the ledger reads it **now** → the corrected figure;
* settlement day **as believed** at the intermediate watermark → the
  pre-correction figure.

They differ by exactly 7340, neither overwrote the other, the original row's
description and amount are unchanged, and the correction group holds two
entries. A second test asks the database to `UPDATE journal_entry` and asserts
`permission denied`, because the whole argument rests on the original row being
unchangeable.

**One honest note.** There is no statement RENDERER in this codebase — the
`statement` table exists and nothing writes to it — so "pull the statement" is
executed as `ledgerBalanceAsOf(account, day)`, which is the fold a statement is
a rendering of (DESIGN §13). The evidence line says so. It is a live query
against live rows, not a substitute figure.

### 4 — settlement before its authorisation

Episode A is entirely real: authorise, then clear, through Lithic. Episode B is
the same two facts in the other order, and the Lithic sandbox cannot produce it
(DECISIONS 004), so it is constructed from episode A's own delivery bodies:
fresh transaction id, fresh event ids, the clearing body stripped to its CLEARING
event, re-signed, POSTed clearing-first.

The fresh event ids are load-bearing rather than tidiness. `financialPostingKey`
is `card:<kind>:<provider event id>` and lands in `journal_entry`'s UNIQUE
idempotency key, so reusing episode A's event ids makes episode B's settlement a
REPLAY of episode A's — the ledger correctly refuses to post it twice, and the
comparison then measures the idempotency key instead of the ordering. The first
version of this test did exactly that and read a ledger delta of 0.

The comparison is the delta each episode leaves on one customer: ledger,
available and holds, equal in all three; the in-order delta is additionally
asserted to be −7340 so that two episodes which both did nothing cannot satisfy
it; one clearing event per transaction; `origin` recorded as `clearing_first`
versus `authorization` with identical arithmetic either way; and no dead letters.

### 5 — maker-checker

Raises a $4,200.00 ACH payment (the policy threshold is $2,500.00) as a human
who **is** an approver, then tries to approve it. Deliberately the hard case:
nothing about that actor's rights is wrong, so a refusal can only be the
maker-checker rule.

The refusal is exercised twice, in this order:

1. **straight at the database**, with the raw INSERT and no application code in
   the call stack — SQLSTATE `42501` from `assert_maker_checker()`, with the
   actor id and instruction id in the message. This is the assertion the attack
   actually makes.
2. through `approvePayment()`, to show the application carries no second copy of
   the rule and only translates the exception.

Then: zero `approved` events were written, and a different human can approve the
same instruction — without which the earlier assertions would also be satisfied
by a system that refuses every approval.

### 6 — the planted break

Books four inbound ACH settlements, imports last night's complete file and
reconciles it (**the control**: zero breaks carrying this run's prefix — without
this step, "we found the deleted row" proves nothing, because a system that
reported every entry as a break would also find it). Then deletes one row,
imports that file, and asks the breaks screen where the row went: an
`in_ledger_not_file` break with that reference, that amount, that entry id, that
value date — asserted on the run result, on the frozen `recon_run_break`
snapshot, and through `loadReconView()`, the same entry point `/reconciliation`
renders.

The business date is **forward-dated** and unique to the run. Both halves are
deliberate: unique so no other file, run or journal entry shares it and this run
leaves no break on a real business day; forward-dated because the breaks screen
orders runs by business date first (`v_recon_run_history` — "the most recent run"
means last night's FILE, not whichever file was re-run most recently), so a run
dated in the past is unreachable from the screen however recent it is. A
forward-dated file is a case the aging ladder already supports explicitly (a
warehoused ACH effective date).

### 7 — the provider outage

The live Lithic subscription is left **enabled**; disabling it mid-trial is the
irreversible thing the brief warns about. The outage is simulated from the angle
that matters: a card event happens at the network and **we never receive it**. A
genuine authorisation body is captured, reissued under a fresh transaction id,
signed, and then HELD — not POSTed — for the window.

* through the dark window: the trial balance does not move, the customer's
  ledger and available do not move, the swallowed event has zero inbox rows, and
  `/api/health` still answers with the database reachable. Nothing invented from
  an event we were never told about.
* on recovery: the backlog is delivered twice, as a provider catching up and
  retrying does. It produces one inbox row, one `card_auth_event`, one hold;
  available drops by exactly 5000 and the ledger does not move. Nothing lost,
  nothing double-counted.

The window is `LIVEFIRE_OUTAGE_SECONDS`, 20s by default. The published attack
says five minutes; five minutes of a rehearsal suite is five minutes nobody
runs, and the claim is about state rather than duration. Set it to 300 for the
real thing.

The money half is asserted BY ATTRIBUTION — the swallowed transaction produced
zero inbox rows and zero authorisations; the recovered hold's own memo account
carries exactly one entry of −5000 and zero financial entries — and the
customer's whole position is additionally asserted frozen **when the window was
quiet**. That condition is not decoration: this Neon branch is shared with the
database-backed integration suite, and a concurrent run of it moved this same
seeded business's ledger by 67,899 cents inside one 20s window and failed this
attack for another process's writes. When the window is not quiet the freeze
cross-check is reported as not evaluated, with the count, and the attribution
stands alone. A suite that reports someone else's writes as our system
inventing money is worse than one that says which it could not tell apart.

**The other two claims now pass, and they are INDUCED rather than found.**
`/api/health` publishes `integrations.webhookHealth` and the console shell
renders a banner from it — but neither says anything at rest, deliberately: a
feed nobody has poked reads `quiet` or `never` and neither is an outage. So the
second test opens a real, deliberate silence measured from the delivery the
first test just made, watches Lithic cross its own 180s threshold from `fresh`
to `stale`, and cross-checks the published `lastDelivery` against
`MAX(webhook_inbox.received_at)` read straight out of the database; the third
reads the deployed console inside that same window and asserts the degraded
banner specifically — the "cannot reach the health endpoint" banner carries the
same `data-provider-status` attribute and would prove the opposite — plus that
the rendered lag matches the endpoint's own figure and the balances underneath
are still rendered. One limit is recorded on the scoreboard rather than
asserted away: see §4.

### 8 — the real provider replay

The claim that was still unproven, done properly this time.

An earlier attempt appeared to pass and did not: the stored headers were
double-encoded, the replays carried no usable signature, production answered 401,
and the row count held **because the requests were rejected before the inbox**
rather than because the unique index deduped them (DECISIONS 020).

So this test refuses to accept a row count as evidence on its own, and proves
four things, all of which are required:

* **A.** the delivery is a real Lithic delivery — this run causes it, so it
  cannot be a stale hand-made probe row; it carries Lithic's own
  `webhook-signature`, stored as a jsonb object; its body is >500 bytes; and it
  is inside the 300s Standard Webhooks window (which is why the test generates
  its own delivery rather than replaying an old row: a stale delivery is
  correctly rejected, and that rejection looks exactly like a pass).
* **B.** both replays are ACCEPTED — HTTP 200 with `status: "replay"`, which is
  reachable only after signature verification succeeds. A 401 carries
  `WEBHOOK_SIGNATURE_INVALID` and is a different body entirely.
* **C.** the `inboxId` echoed by both replays is the id of the row the original
  delivery created, so the replays reached the same row.
* **D.** a **negative control**: the same bytes with a tampered signature are
  answered 401. Without this, (B) could be a system that accepts anything.

Only then is the row count read, and it is 1.

---

## 3. Running it

```
node scripts/livefire.mjs
```

Needs, from `.env`: `APP_DATABASE_URL` (the restricted `corgi_app` role — the
suite proves immutability by attempting an UPDATE, which only means something as
that role), `LITHIC_API_KEY`, `LITHIC_WEBHOOK_SECRET`, and `DRAIN_TOKEN` so the
run can nudge the deployed drain rather than waiting for the cron. The database
must be seeded (`node scripts/seed.mjs`).

Everything is serial (`--no-file-parallelism`): Lithic's simulate endpoints are
capped at 1 RPS (DECISIONS 005) and a scoreboard people read in order should be
produced in order. Test timeouts are raised to 240s because these tests poll live
systems and Vitest's 5s default would fail them for being honest about how long a
real webhook takes to arrive.

The evidence file lives under `node_modules/.cache/livefire/`, not `.next/`. A
concurrent `next build` in this repo removes `.next` wholesale, and a run has
already lost its evidence to exactly that: the file vanished mid-flight, every
`record()` after it threw ENOENT, and an attack whose assertions had all passed
was scored FAIL with a filesystem error as its reason. `record()` also recreates
the directory before appending. Evidence must never be the thing that fails a
live-fire run.

**What a run leaves behind**, all of it deliberate and none of it removable:
Lithic cards and transactions in the sandbox; `webhook_inbox` rows; card
authorisations, holds and memo postings; one financial settlement per
over-capture; two scheme files and two reconciliation runs on a forward-dated
business day; and one approved ACH payment instruction in the queue.

---

## 4. What is not proven, and exactly what is missing

**One claim SKIPs.** It is printed on the scoreboard with the sentence below.

**Attack 2 — the `hold_closure` row.** The hold IS released: the memo balance
goes to zero, one release posting, available exactly right. But no
`hold_closure` row is written, so the attack's literal "one closure row" is
unproven. `src/lib/holds/model.ts` computes
`closed(E) = is_final OR close/expiry OR (A <= 0)`, and
`src/lib/holds/lithic-events.ts` deliberately never sets `is_final` on a CLEARING
because Lithic offers no last-capture flag. On an over-capture A = 5000 and
C = 7340, so A > 0 and `closed(E)` is FALSE — while **DESIGN.md §8.3 row 2, the
fuel-pump over-capture, states `closed = y` for exactly this case.** The model
and the design document disagree. Either `closed(E)` needs the `C >= A` arm §8.3
assumes, or "closure row" in the attack means the release posting and §8.3 should
say so. Until then the hold sits at H = 0 with no closure row until the seven-day
expiry sweeper closes it. This is a bookkeeping divergence and not a money error
— available is correct either way, because `availableBalance` reads the memo
balance as well as the closure row.

**This one is deliberately NOT closed.** The one-line `C >= A` fix was written
and reverted: `v_hold_drift` holds the TypeScript model and the SQL view equal
*by invariant*, so moving one side alone converts a prose mismatch into a live
drift alarm, and an invariant reporting drift is indistinguishable from a ledger
that has actually drifted (DECISIONS 024). The assertion must not be weakened to
make the scoreboard greener; the skip is the finding.

---

## 4b. What PASSES but is narrower than it sounds

Not a skip — a pass whose limit belongs next to it rather than in a footnote.

**Attack 7 — the outage is REPORTED but does not ESCALATE.** With Lithic
genuinely stale, `/api/health` publishes
`webhookHealth.providers[lithic].verdict = "stale"` with the lag in seconds, and
the console renders the provider-down banner. But `degradesDeployment` is
`false`, `degradedBy` is empty and the top-level `status` stays `"ok"`.

That is not a threshold being missed. `delivery-health.ts` gates escalation on
four conditions, one of which is that the provider's integration is probed live,
and `route.ts` derives that as **every** Lithic slot reading `live`:

```ts
integrationLive: w.slots.length > 0 && w.slots.every((s) => probedStatus.get(s.slot) === 'live')
```

Lithic owns two slots. `card_webhooks` has no probe, so since DECISIONS 026 it
reads `unprobed` and is labelled `simulated` — correctly, because nothing has
proven it by a round trip. `every(... === 'live')` is therefore permanently
false, so the escalation clause **can never fire on this deployment** and no
webhook outage can move the top-level status. The note the endpoint prints in
that state says the integration "is not live", which is true of `card_webhooks`
and misleading about the card rail as a whole.

A reader of `webhookHealth` sees the outage. A monitor watching `status` alone
does not. Same shape as the `v_hold_drift` blind spot in DECISIONS 026: a check
whose exclusion is shaped exactly like the thing it should catch. The test
asserts the claim the attack makes — the endpoint reports it — and records this
limit as evidence on the scoreboard.

---

## 5. Adding an attack

One file, `src/test/livefire/attack-NN-slug.test.ts`, and one entry in the
`ATTACKS` array in `scripts/livefire.mjs`. The file must:

* gate on `LIVEFIRE=1` and record a skip reason when a precondition is absent,
  at module level, so a skipped file still explains itself;
* append evidence with the local `record()` helper — never `console.log`, which
  eslint refuses here and which would not reach the scoreboard anyway;
* `ctx.skip(reason)` the moment a claim becomes unprovable, having recorded the
  same reason first;
* assert against live state only.
