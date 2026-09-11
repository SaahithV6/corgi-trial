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

There is exactly one thing that is neither of those, and §2b is it: a test that
proves a **different, smaller, named** claim than the published attack, because
the provider refused to produce the published one. That is not a skip — the
pipeline ran end to end and something real was demonstrated — and it is not a
pass on the attack either. It is allowed only on the terms §2b sets: the smaller
claim is stated in the file and here, and the FIRST evidence line the reader sees
says which published sentence was **not** exercised, and why. A test that reads
as if it proved more than it did is still worse than a skip.

**The verdict is not self-reported.** `scripts/livefire.mjs` derives PASS / FAIL
/ SKIP from Vitest's own JSON result, not from anything a test writes about
itself. The tests write only evidence strings; they cannot promote themselves.

**There is no teardown, because money tables are append-only.** Isolation is by
construction instead: every run mints its own Lithic card, its own synthetic
references (`LF6-<tag>-n`), its own idempotency keys, and its own business date
where one is needed. Every assertion is either a DELTA measured across the run's
own window or a lookup BY REFERENCE. Nothing counts rows in a shared table.

**And an attack owns the customer it measures.** This was the suite's largest
hole and it took two red attacks to see it. Every attack used to reach for the
same row — `ORDER BY business_id LIMIT 1` — and then measure that customer's
whole position, or one of its days, across a window. So attacks 1, 2, 3 and 7
were all measuring the same business at the same time as each other, as the
database-backed integration suites, as the demo scripts, and as every other
agent on this branch. **A global quantity under concurrent writers is not the
quantity an attack claims to be reading**, and DECISIONS 028 recorded exactly
this vulnerability in attacks 1, 2 and 4 and left it because they were passing —
a green result produced by the weakness is not evidence against the weakness.
Attacks 3 and 7 now open their OWN business (deterministic id, idempotent,
opened through the owner role because `corgi_app` holds only SELECT on
`account`; ids chosen to sort ABOVE the seeded businesses so that attacks still
using `LIMIT 1` cannot pick them up). Where an assertion can be attributed to
this run's own rows instead of to a business at all, it is — see attack 7's
two-watermark isolation, which cancels every other writer arithmetically. The
rule this suite now holds itself to: **never widen a tolerance to absorb
another writer. A tolerance wide enough to absorb a concurrent hold is wide
enough to absorb the bug the attack exists to catch.**

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

**It proves the published sentence again.** For part of 2026-09-11 it proved
the other half instead, because Lithic refused every authorisation — see §2b,
which covers attacks 1, 2 and 7 together and is kept because the branch is
still in the code and still correct.

### 2 — the over-capture

Authorise $50.00, clear $73.40. Three tests, because the attack names two
things and only one of them holds, and because the reason for that is a
measurement rather than an opinion (DECISIONS 049):

* **the money claim** — the hold's memo entries are the opening delta and its
  exact negation and nothing else (one release posting), the ledger posts
  exactly 7340 in exactly one financial entry, the hold stops withholding
  anything, and `available == ledger − holds − uncleared` exactly, in integers,
  with no floor. This passes.
* **the measurement** — Lithic approves an `authorization_advice` to $90.00
  AFTER the $73.40 over-capture, and then really captures the $16.60 remainder.
  So over-capture is not terminal and the closure row must not be written. This
  passes, and if Lithic ever refuses the advice it **skips loudly**, which is
  the trigger to reopen the decision below.
* **the bookkeeping claim** — exactly one `hold_closure` row. This SKIPS, and
  the skip is a real finding rather than a missing feature. See §4.

The first two need an approved authorisation and skipped through the declined
era (§2b). They pass again, which means the file's SKIP is now the third test
and only the third test — the meaning the scoreboard line has always claimed
for it. **A skip whose reason has quietly changed is worse than a failure**, so
it is re-read against DECISIONS 049 whenever the provider's behaviour moves.

### 2b — what attacks 1, 2 and 7 prove when the sandbox declines everything

**READ THE TENSE. This section described the live state of the suite for most
of 2026-09-11 and no longer does.** A human raised the account's daily spend
cap from $5,000 to $500,000 (reported as roughly 12:00Z; what is measured is
the limit, below, not the moment) and authorisations now approve, so the branch
below is not being taken on any current run. It is kept, in full, for two
reasons: the branch is still in the code and will be taken again the moment the
account's daily velocity is exhausted, and the argument it records — that a
refusal is a pass
on a smaller, loudly labelled claim rather than a red — is the rule the rest of
this file is written under.

**What is true now.** `GET /v1/accounts/{token}` reads
`spend_limit.daily = 50000000` ($500,000.00) against the earlier
`500000` ($5,000.00), the account is `ACTIVE`, and every attack in this suite
reads `AUTHORIZATION 5000 result APPROVED` from the provider. Attack 1 asserts
the published drop of 5000 again; attack 2's money test and its measurement
test both pass, so its SKIP is now exactly and only the `hold_closure` claim of
§4 and nothing else; attack 7's recovery half asserts the memo posting again.
Attack 3's part B reports the verdict it read, so a future decline shows up in
its evidence instead of passing unremarked.

**And it cost something on the way in, which §2c is about.** Approvals are
slower to become visible at the provider than declines, and attack 3 had a
1-second gap sitting on the wrong side of that tail.

---

*What follows is the record of the declined era, unedited.*

Attacks 1 and 2 read the network's verdict from the provider before asserting
anything (migration 0026), and both then read
`AUTHORIZATION 5000 result DECLINED [ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED]`. The
Lithic sandbox account's rolling 24-hour cap was exhausted —
`available_spend_limit.daily = 0` against `spend_limit.daily = 500000`, with
`spend_velocity.daily = 760210` — so **no authorisation could be approved at any
amount**, which a run established directly by sending a one-cent
authorisation and watching it decline. The only routes out were raising the limit
(`PATCH /v1/accounts/{token}`, deliberately blocked by the permission
classifier) or standing up a second provider account. Both are a human's
decision, not a thing a test may tune around — and it was a human raising the
limit that ended it.

**A refusal is a PASS, on a smaller claim, loudly labelled.** Both files used to
`throw` on it, on the argument that "the demo could not be performed" is a red
rather than a skip. That was right about the skip and wrong about the red.
Nothing is broken on a declined run: the delivery arrives, the consumer runs,
the verdict survives ingest, and the ledger correctly withholds nothing.
Reporting a working system as a broken one is the same misreport as a green on a
broken one, pointing the other way. So the branch asserts, in full:

> **a declined authorisation places no hold** — holds, available, ledger and
> the trial balance all flat across the authorisation; zero memo entries on the
> hold; and this run's own hold absent from `v_refused_auth_hold`.

That is a real and demonstrable property, and it is the property production did
**not** have for eight hours (DECISIONS 050, 056). It is arguably the more
interesting one: the happy path shows money being withheld, and this shows money
correctly *not* being withheld, which is the failure that actually cost a
customer $300.00.

**It is not allowed to read as more than it is.** The first evidence line on a
declined run opens `THE PUBLISHED HAPPY PATH WAS NOT EXERCISED`, says which
published sentence is not shown by the run, and names the cause. The scoreboard
title comes from `scripts/livefire.mjs` and still reads "AVAILABLE drops 5000",
so the evidence is the only place that can be said — which is why it is said
first, before the numbers. Attack 1's own test title was changed for the same
reason: it now reads "available moves by exactly what the network granted", true
at 5000 on an approval and at 0 on a refusal, instead of asserting a drop in its
name on a run where nothing was granted. Attack 2 still scores **SKIP** on a
declined run, correctly: its other two tests cannot run at all without an
approved authorisation, and the runner scores any file with a skipped test as
SKIP. One test passing on a smaller claim does not promote the attack.

**And the assertion that used to fail here was scoped wrong, not sized wrong.**
The refusal branch ended on `expect(count(*) FROM v_refused_auth_hold).toBe(0)`
— *nobody on the whole deployment is withholding money against an unapproved
authorisation*. Measured: 149 rows, and they should be there. They are the
historical backlog of authorisations whose verdict was never observed —
pre-0026 fixture events plus test authorisations from the other suites —
migration 0032 **deliberately refused to exclude them**, and `dbcheck` reports
that count as a standing, deliberate failure that must not be tuned back.

So the fix is neither a wider tolerance nor a deletion. It is the repair attacks
3 and 7 had earlier in the night: the claim is pointed at **this run's own
rows**, by hold id and by provider transaction, both of which must be absent
from the view. `v_refused_auth_hold` lists a hold only while
`active_hold_cents > 0`, so absence *is* the claim — this declined authorisation
is not withholding a cent. The book-wide count is still read, and printed in the
evidence next to the scoped one under `NOT ASSERTED, REPORTED`, so a reader sees
the number and sees that none of it is ours. The rule in §1 holds: **never widen
a tolerance to absorb another writer** — and the corollary this pass adds is
that a global zero is not a tolerance at all, it is a claim about every other
suite on the book, which an attack has no business making and cannot keep.

**Attack 7's money half joined this branch, and it is the instructive one,
because it failed in the OPPOSITE direction.** Its recovery test demanded that a
memo posting follow the backlog's authorisation, and failed with *"no memo
posting withheld the money within 60s of it, so $50.00 is authorised and not
held and the customer can spend it twice."* The ledger was right. The
authorisation had been REFUSED for the same exhausted daily cap as attacks 1 and
2, so `H(E) = 0`, `Δ = 0` and `postHoldDelta()` correctly appended nothing —
measured on hold `d22227bd-efad-4149-9ae6-1faf0e7ae7fe`: one `card_auth_event`
with `kind = 'declined'`, a `card_auth_event_result` row beside it reading
`DECLINED`/`AUTHORIZATION`/`ingest`, `v_card_auth_hold.target_hold_cents = 0`,
and `v_hold_drift`, `v_hold_posting_incomplete` and `v_refused_auth_hold` all
empty for it. Full diagnosis in `docs/HOLDS.md` §9.9.

Two things follow, and both are on the record rather than patched around.

*It went through `apply.ts`.* `hold.external_ref` carries the
`<provider>:<provider_auth_id>` prefix that only `ensureAuthorization()` emits,
the verdict row exists, and the `webhook_inbox` row exists — which is exactly
the opposite of all three readings that identified the four hand-written orphans
in HOLDS §9.1. Since migration 0036 the compare-and-append is in the same
transaction as the facts, so **a committed fact is proof the posting decision
was taken**; the decision was `Δ = 0`. The `claimed=0 processed=0 parked=0` from
the drain nudge was not a lost delivery either: the webhook route drains in an
`after()` callback, so the envelope was `state = 'done'` 129ms after it arrived.

*So attack 7 now reads the verdict first*, off the bytes it is about to deliver
and off the provider's own copy of the template transaction, cross-checks it
against `card_auth_event_result`, and branches. On an approval nothing is
weakened — the memo posting is still required and its absence still fails with
the same message. On a refusal the first evidence line opens **THE PUBLISHED
HAPPY PATH WAS NOT EXERCISED** and the smaller claim is named: *a backlog
delivered twice after a dark window applies exactly once and withholds exactly
what the network granted.* And a delivery that carried a verdict the database
does not have is a hard failure naming DECISIONS 050/056, because that is the
eight-hour production bug and nothing else. The dark-window half is
verdict-independent and is asserted and recorded in full on both branches.

**This is this build's one pattern with the sign flipped.** Every earlier
instance — nineteen of them are written up in DECISIONS — was a guard that
reported HEALTHY on a broken book because what it excluded was shaped like the
failure. This assertion reported a BROKEN book on a healthy one, for the same
structural reason: *it demanded a withholding without
ever asking whether there was anything to withhold, so the one state it could
not tell from its target was the ledger being right.* Reporting a working system
as broken is the same misreport as the other, pointing the other way, and a red
that is wrong burns a debrief exactly as fast as a green that is.

One residual, recorded rather than fixed: attacks 1, 2 and 4 still pick their
customer with `ORDER BY business_id LIMIT 1` and measure a delta on it, rather
than opening their own business as attacks 3 and 7 do (§1). Every assertion
across that customer is a **delta over the attack's own window**, which is the
shape §1 asks for, but the window is not isolated the way attack 7's two
watermarks are. It was left alone in this pass because the defect being repaired
was the absolute assertion, and widening the change to re-home two more attacks
on a deployed, green tree is a separate decision.

### 2c — a token is not a transaction yet, and approvals are slower than declines

**Raising the spend cap took the core loop from 6/7 to 7/7 and turned attack 3
red.** Part B threw `LithicApiError: Transaction was not found` out of
`simulateClearing`, before a single assertion ran, in 1 of 4 consecutive runs.
It is written up here rather than only in attack 3 because it is a property of
the sandbox that any attack can hit, and because the obvious reading of it was
wrong.

The obvious reading was that a *declined* authorisation produces a transaction
the clearing endpoint will not accept, and that approvals had changed what part
B was reversing. It is neither. **The 404 is a read-after-write delay and the
token is valid**: the exact transaction a failing run could not clear,
`19676a84-1748-4bb5-8d34-0d6089469ae4`, reads `PENDING / APPROVED /
AUTHORIZATION:APPROVED:5000` on `GET /v1/transactions` afterwards. It existed.
The clearing was early.

`/v1/simulate/authorize` answers `201 {token}` before the transaction is
readable, and every endpoint keyed on that token — `GET /v1/transactions/{token}`
and `/v1/simulate/clearing` alike — answers 404 until it is. MEASURED against
this sandbox on 2026-09-11, six trials each, polling every 200ms from the
authorize response, on a card this suite already owns:

```
AUTHORISATION APPROVED    969  1166  1177  1184  1450  1759 ms   mean 1284
AUTHORISATION DECLINED    781   788   829   875  1047  1051 ms   mean  895
```

`simulateLimiter` is one request per 1000ms plus a 50ms safety margin and it
counts request STARTS, so a clearing issued straight after an authorisation
reaches Lithic at roughly t+1100–1200ms. That is past the far tail of the
declined distribution and through the middle of the approved one. **The race
was always there. The declined era was simply always on the safe side of it,
and raising the cap moved the distribution rather than the code.** A green that
depended on the provider declining was never evidence about the correction —
the same sentence this file already had to write about interchange timing, one
layer further out.

The repair is a wait on the PROVIDER and nothing else:
`waitForProviderVisibility` in attack 3 and `readWhenVisible` in attack 2 poll
`GET /v1/transactions/{token}` until it answers, and a token still 404 after
30s fails hard with the measurement quoted, because that would be a different
fault and a longer wait must not paper over it. No assertion moved. Attack 3's
part B evidence now reports the delay it actually waited out, and the same read
supplies the network's verdict, so a decline is reported instead of passing
unremarked.

Attack 2 had the same race latent: its measurement test waited a flat 1500ms
and then read the transaction, which is 241ms of margin against the worst
approved reading taken and none against a slower one. It had not failed yet. It
was one bad sample away, and a test that has not failed yet is not a test that
works.

Two call sites were checked and left alone, because they poll the LEDGER for
the authorisation before touching the provider again and so cannot be early:
attack 4 (`src/test/livefire/attack-04-settlement-before-authorisation.test.ts`)
and `src/lib/interchange/interchange.integration.test.ts`. Part A of attack 3 is
safe for the same reason. `simulateClearingAction` in the console works from a
transaction the database already has.

**The durable version of this belongs in `src/lib/rails/lithic/client.ts`** — a
`getTransactionWhenVisible`, or a documented 404-retry on the simulate calls
keyed on a token, so that the next call site does not have to know. That is a
`src/lib/**` change and was not made here; it is recorded so that it is a
decision rather than an omission.

### 3 — the backdated correction

Two parts, both driven from the PROVIDER end. Part A is entirely Lithic's: a
real `/v1/simulate/return` settlement and a real `/v1/simulate/return_reversal`
of it, signed and delivered over the internet to the deployed endpoint. Part B
is the brief's sentence literally — a $50 fuel-pump authorisation, a $73.40
clearing, and then the reversal of THAT, which Lithic's sandbox measurably
refuses (`400 Return reversal is not supported for debit transactions`), so one
`CORRECTION_CREDIT` step is synthesised, dated the NEXT DAY, and nothing else
is: the signature, the transport, the verification, the inbox, the drain and
the posting are all production. A negative control proves the signature is
being checked.

Part B waits for Lithic to be able to see its own transaction before it clears
it, and reports both the delay it waited out and the network's verdict on the
authorisation — see §2c for the measurement, and for the run in which clearing
too early failed this attack for the provider's indexing rather than for
anything the ledger did.

Both parts then read the statement for settlement day at two booking
watermarks, through `renderStatement()` — the real renderer, the one
`/statements` and `publishStatement` use.

* the line the correction ADDED is dated settlement day and carries exactly
  minus the settled amount;
* the entry it corrects reads identically in both renderings — neither
  overwrote the other;
* the correction posted nothing at its own date.

**The last one used to be asserted as "the learning day's statement has zero
lines", and it failed, twice, at nine.** The nine were Plaid funding credits
and released ACH payments booked to that day by the rest of the build —
measured: value date 2026-09-11 on the demo account already carried nine
entries at `booking_seq` 1395…1931 before the attack ran, and not one of them
was the correction's. The assertion was testing "nobody else used this account
that day", which was true when the book was small and was never the property
under test. It is not loosened, it is pointed at the rows this run created,
from three directions: no entry under the key such a posting would carry
(`card:%:<correction event>`), no financial entry of this transaction or its
correction group dated anywhere but settlement day, and not one line of OURS on
the learning day's rendered statement. What that day carries otherwise is other
people's traffic, and is now reported in the evidence instead of asserted
about.

The same reasoning applies to the whole-day figures. "The day's closing moved
by exactly 7340 over exactly one new line" is a claim about the whole book on a
shared database, so it is asserted when nothing else was booked to that day
inside the window and REPORTED, with the interfering entries named, when
something was. The line-level assertions above are unconditional, and they are
the attack's actual claim.

A third test asks the database to `UPDATE journal_entry` and to `DELETE FROM
journal_line` and asserts `permission denied` on both, because the whole
correction argument rests on the original row being unchangeable.

**And the wait for the correction no longer counts rows.** Part A reported *"no
reversal entry was produced by the provider's correction"* against a ledger that
had produced it correctly. It waited for the transaction's SECOND financial
entry and then looked for a reversal among what had arrived — and a card
settlement no longer produces one entry. `interchangeHook()` prices it in the
same delivery, so the settlement and its interchange both land under the same
`external_ref`. Measured on the deployed tip, Lithic transaction
`8b119c1b-748a-4315-aa48-b74026361c57`:

```
07:08:13.787  card:refund:141db235-…   entry b181c6e0   the money
07:08:13.952  interchange:141db235-…   entry 2a2589fc   +165ms
07:08:50.009  reversal:b181c6e0-…      entry 8a57b3fa   +36s, THE REPAIR
07:08:50.126  reversal:2a2589fc-…      entry 069c14ad   the interchange unbooked
```

"The second entry" was therefore the interchange, 36 seconds before Lithic's
asynchronous `RETURN_REVERSAL`, and the attack read its own early exit as the
provider having failed. The same file passed 3/3 a few hours earlier only
because interchange was then being priced by a LATER reconcile pass — measured
819s behind the settlement at 05:46, and 0–1s from 06:58 onward. **A green that
depended on how far behind a second, unrelated posting was running was never
evidence about the correction.**

The repair is §1's rule and not a longer wait: **wait for the SUBJECT.** Both
parts now poll for the entry whose `reverses_entry_id` is the entry the provider
corrected, which no interchange line, no other attack and no other process can
satisfy — and part B stops taking "the first reversal", because the correction
unbooks the interchange as well as the money and which of those two commits
first is not a property this attack should rest on. The claim is **narrower**
than the one that failed. The idempotence check reads its before-count at the
replay rather than reusing the poll's, for the same reason: the two reversals
commit 117–132ms apart and a poll can return between them.

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
  retrying does. It produces one inbox row, one `card_auth_event`, one hold; the
  hold withholds exactly what the network granted — 5000 on an approval, nothing
  on a refusal — and the ledger does not move. Nothing lost, nothing
  double-counted.

The recovery half reads the network's verdict before it asserts any money, and
**while the sandbox declines everything it proves the smaller, named claim** —
see §2b, which covers attacks 1, 2 and 7 together, and `docs/HOLDS.md` §9.9 for
the measurement. Since the cap was raised the verdict reads APPROVED and the
memo posting is required again; the branch remains. The dark-window half does
not depend on the verdict and is asserted and recorded in full either way.

The window is `LIVEFIRE_OUTAGE_SECONDS`, 20s by default. The published attack
says five minutes; five minutes of a rehearsal suite is five minutes nobody
runs, and the claim is about state rather than duration. Set it to 300 for the
real thing.

**The two visibility claims need a silence that no attack can own.** The money
half is isolated to this attack's own business and its own rows, but
`webhookHealth`'s Lithic verdict is derived from `MAX(webhook_inbox.received_at)`
across the whole deployment — one feed, not one customer. So the induced silence
is defeated by anybody else delivering a Lithic event, and when that happens the
test reports what defeated it ("7 restart(s) — something is still delivering")
and SKIPS rather than asserting something weaker. Measured both ways on the same
code: 3/3 with the branch to itself, and a skip on the health claim with a dozen
agents running suites against the same Lithic sandbox. Run attack 7 when the
branch is quiet, or accept the skip and read its reason — which is the rule this
suite is written under.

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

**Two things about that measurement were wrong until now, and they are the same
mistake this whole debrief is about: what a guard excluded was shaped exactly
like the failure it existed to catch.**

* *It waited for the wrong row.* `src/lib/holds/apply.ts` splits one event into
  two transactions on purpose — facts and closure first, the memo posting
  second — so `card_authorization` exists before the money is withheld. The
  test polled for the authorisation and then read `available`. Measured on the
  failing suite run: the hold row committed at 03:45:45.251Z and its opening
  posting at 03:45:45.581Z, and the position was read in the 330ms between
  them, so available read the same figure at both ends of a window that had
  genuinely moved by $50. Reconstructed afterwards, the account's active holds
  were 40000 at the start and 45000 at the end: the ledger was right and the
  read was early. It now waits for the POSTING, which is what the claim is
  about, and treats a fact that lands without its withholding as a failure with
  its own message rather than a skip.
* *Its quiet-window guard watched the wrong book.* It counted `journal_entry
  WHERE book = 'financial'` before asserting a delta on `available` — and
  `available` is moved by the MEMO book, because that is where a hold lives.
  Every card hold in the suite walked straight through it. Worse, `available`
  also moves with the CLOCK and no entry at all: `ledger_availability` matures
  uncleared credits at `available_at`, expires card holds at `expires_at`, and
  pulls a warehoused ACH credit into the ledger term when `book_date()` reaches
  its value date — measured here as a multi-million-cent step at 00:00
  America/New_York, fifteen minutes from the failing run.

The fix is not a better guard, because a guard is an exclusion and an exclusion
shaped like the failure is how this keeps happening. **The delta is ISOLATED
instead.** The app's own `accountAvailability()` is asked the same question at
ONE instant and TWO watermarks — the pair either side of this run's own opening
posting. Everything anybody else wrote is in both readings and cancels; the
clock is identical on both sides and cancels; what is left is this attack's own
$50. Cross-attack and cross-process interference is prevented by construction
rather than detected afterwards, which is the honest answer to a shared
database: not "was anyone else writing", but "measure only our own rows".

The whole-business freeze and delta are still asserted on top, now guarded by a
count over BOTH books and bounded by a watermark rather than a wall clock, and
still reported rather than asserted when the episode was not quiet.

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

**Last full reading, started 2026-09-11T14:22:34Z, against
`https://corgi-trial-psi.vercel.app`:**

```
  1  $50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move          PASS
  2  $73.40 capture: hold released exactly once, available not clamped       SKIP
  3  Backdated reversal: corrected figure AND as-believed, both at once      PASS
  4  Settlement before its authorisation ends exactly where in-order does    PASS
  5  Self-approval refused by the DATABASE (SQLSTATE 42501)                  PASS
  6  Row deleted from tonight's scheme file -> in_ledger_not_file break      PASS
  7  Issuing-provider webhook outage degrades visibly, invents no money      PASS
  8  Dedupe against a genuinely signed provider replay: twice is one         PASS

  PASS 7    FAIL 0    SKIP 1    of 8 attacks    303s
```

Attack 3 was additionally run alone five times after the §2c repair and passed
five times; it had failed 1 in 4 before it. The SKIP is §4's, and only §4's —
checked, not assumed (§2).

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
two live-fire fixture businesses, `Live Fire — attack 3` and `Live Fire —
attack 7`, opened once and reused by every subsequent run (attack 3's nets to
zero — every settlement it books it also reverses; attack 7's accumulates one
$50 memo hold per run, which the seven-day expiry sweeper closes);
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

## 4b. The limit that used to live here, and what retired it

Kept rather than deleted, because the SHAPE of it is the through-line of this
debrief and four of the five instances in this repo look exactly like it.

**Attack 7 shipped with a gap recorded on the scoreboard rather than asserted
away: the outage was REPORTED and did not ESCALATE.** With Lithic genuinely
stale, `/api/health` published `webhookHealth.providers[lithic].verdict =
"stale"` and the console rendered the provider-down banner — but
`degradesDeployment` was `false`, `degradedBy` was empty and the top-level
`status` stayed `"ok"`. Measured at the time: stale at 184s, `status` "ok". A
monitor watching `status` alone saw a healthy deployment with its card rail
dark.

That was not a threshold being missed. `delivery-health.ts` gates escalation on
the provider's integration being probed live, and `route.ts` derived that as
**every** Lithic slot reading `live`:

```ts
integrationLive: w.slots.length > 0 && w.slots.every((s) => probedStatus.get(s.slot) === 'live')
```

Lithic owns two slots, and `card_webhooks` had no probe, so it read `unprobed`
and was labelled `simulated` — honestly, because nothing had proven it by a
round trip. One honest absence of evidence made the clause unsatisfiable for
ever. **The guard's exclusion was shaped exactly like the failure it existed to
catch.**

Two things retired it, and the test asserts both:

1. `card_webhooks` earned a real probe — `GET /v1/event_subscriptions` plus that
   subscription's `/attempts` log showing Lithic's own record of our endpoint
   answering HTTP 202. It reads `live` now.
2. The gate became `some` (DECISIONS 028), so no single slot's degradation can
   silence the alarm.

(2) is not made redundant by (1): that probe reads Lithic's own delivery log, so
it goes not-live in precisely the conditions that ARE the outage — our endpoint
rejecting deliveries reads `unauthorised`, an unreadable `/attempts` reads
`unreachable`. Under `every`, either would have disarmed the alarm at the exact
moment deliveries were being lost. So the test re-derives the degraded case from
the outage's own published facts with `card_webhooks` forced not-live, through
the same pure function `/api/health` calls, and asserts that the alarm stays
armed under `some` and would have been silenced under `every`.

**There is no remaining limit recorded for attack 7.** It now asserts the
stronger claim the attack's wording implies — a webhook outage moves the
top-level status — by inducing one and reading `status: "degraded"` with
`degradedBy: ["lithic"]` and `database.reachable: true`, so that the word is
the feed and not a coincidental database failure.

The two mistakes retired from the same file's MONEY half in this same pass — a
test that read a balance between the two commits of a deliberately two-phase
apply, and a quiet-window guard that counted the financial book while asserting
a quantity the memo book moves — are written up under §2, attack 7. They are the
same shape as this one. That is the finding: **every guard that failed in this
build failed because what it excluded looked exactly like the thing it was
meant to catch**, and the durable answer is not a better exclusion but a
measurement that isolates our own rows.

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
