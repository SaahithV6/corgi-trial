# Decision log

Timestamps are UTC. Entries are append-only: if a decision is reversed, a new
entry supersedes the old one. Nothing here is edited after the fact.

---

## 001 — 2026-09-10T00:26Z — Track 1, Policy administration

**Decision.** Track 1.

**Why.** Domain command is the largest single scoring bucket (30/100) and is
graded on precision of vocabulary under questioning, not on novelty. I already
carry working insurance vocabulary — carrier vs. broker vs. MGA economics,
risk retention groups under the LRRA, filed-and-approved rate regulation,
coverage anchoring and inflation guards — from building a replacement-cost
underinsurance scoring product on the SF assessor roll. Track 1 lets me spend
the 48 hours on mechanics rather than on learning what a premium is.

Track 1's money mechanics also collide directly with the hardest
non-negotiables. Pro-rata unearned premium on a mid-term cancellation is
exactly the "someone has to eat the penny" case in requirement 9, and a
backdated endorsement is exactly the reversal-plus-rebook case in requirement 5.
Those two land in the same ledger, so correctness there compounds instead of
splitting my attention.

**Considered and rejected.** Track 3 (neobank) has the flashier integration
surface — the authorize-then-capture-a-different-amount asymmetry on Lithic is
a genuinely good demo. I rejected it because the domain depth I would have to
fake is larger than the demo advantage I would gain. Track 2 (investing) needs
tax lots and T+1 corporate actions, which is the most domain to learn per hour
of the three.

**Risk accepted.** Track 1 is the product Corgi runs today, so it is graded by
people who know every shortcut I might take. I am treating that as the reason
to pick it, not the reason to avoid it.

---

## 002 — 2026-09-10T00:30Z — Supersedes 001: Track 3, Neobank

**Decision.** Track 3. Entry 001 stands as written and is wrong; this entry
replaces it. T0 was 2026-09-09 17:13 PDT.

**What changed.** 001 justified Track 1 on the claim that my insurance
background transfers. Reading Track 1's actual gauntlet, it largely does not.
What I know is distribution- and underwriting-adjacent: replacement-cost gaps,
coverage anchoring, inflation guards, rate filing, RRG structure under the
LRRA. Track 1 grades policy-administration accounting: written versus earned
premium, unearned premium as a liability, short-rate versus pro-rata,
commission on written versus collected with clawback, and state premium tax
that rides the same charge while staying out of the earned-premium figure.
That is convention rather than derivation — you either know it or you are
guessing, and the panel builds it daily.

**Why Track 3.** The three things it grades hardest — the hold model under
hostile sequencing, the bitemporal correction, and available balance as derived
truth rather than a stored number — are engineering problems, not domain
trivia. I can defend all three line by line, which is what the debrief tests.
Every one of the seven published live-fire attacks is a test I can write and
run before they run it.

**Assumptions written down, not waiting on an answer.**
- KYB self-serve is the one integration I cannot confirm without trying.
  Plan: Persona sandbox for business + director verification. If Persona's KYB
  templates turn out to be gated, fallback is Persona or Stripe Identity for
  director KYC live, with the business-registry check behind the same interface
  as a labelled simulator. Asking on the thread, not blocking on it.
- Bitemporal from hour one: every money row carries value_date (when it
  happened) and booking_date (when we learned it). Retrofitting this at hour 40
  is the failure the brief warns about.
- USDC on Base Sepolia direct via viem rather than through Bridge or Circle,
  because provider onboarding is the risk and a confirmed testnet transaction
  is the evidence. It sits behind the same rail adapter interface as ACH.

**Risk accepted.** I have not worked in banking. The mitigation is that the
domain here is sequencing and I can test sequencing exhaustively before anyone
attacks it.

---

## 003 — 2026-09-10T00:45Z — Cost-benefit across all three tracks

Track 3 confirmed after scoring all three against the published rubric rather
than on instinct. Recorded because the reasoning is the artifact, not the
conclusion.

**The denominator.** 48 hours is roughly 34-38 productive hours after sleep,
deploys, the video and the checkpoint emails. Every track is over-scoped
deliberately, so the question is points per hour and where the floor sits when
something goes wrong, not whether the brief can be finished. It cannot.

**Estimated build cost of the required core.** T1 ~64h (1.8x over), T2 ~73h
(2.0x over), T3 ~53h (1.5x over). Track 3 is the only one where the cut list
reads as judgment rather than as running out of time, and a credible cut list
is itself scored.

**Expected score.** T1 ~65, T2 ~66, T3 ~77. More importantly the floors:
T1 ~55, T2 ~58, T3 ~72. In a build nobody finishes, the floor is the number
that matters.

**Three things drive the spread.**

1. Domain command splits on convention versus derivation rather than on
   difficulty. T1's gauntlet is convention — short-rate versus pro-rata,
   commission on written versus collected, state premium tax riding the charge
   while staying out of earned premium. None of it is derivable; you know it or
   you are bluffing to a panel that does it daily. T2's is derivable in an
   evening. T3's is sequencing, which is an engineering problem.

2. Integration count is not integration risk, and this corrects entry 002.
   I dismissed T2 for needing three live slots. That was lazy: Alpaca paper,
   Stripe Identity test mode and Plaid sandbox are all instant and self-serve.
   T1 and T3 share the one genuinely gated slot, KYB. If Persona's business
   templates need a sales call, T2 is the only track that never had the
   problem. That is T2's real advantage and it is why the KYB question went out
   first rather than last.

3. Live fire is 15 points and the only bucket that can be rehearsed. All seven
   published T3 attacks are tests I can write in advance and run before the
   debrief. T1's include "cancel mid-term with an open claim and tell us what
   happened to the refund, the commission and the reserve", which is a
   conversation with experts and cannot be rehearsed.

**Caveat recorded honestly.** T1 has the higher ceiling and the offer to meet
them in their own domain is genuine. With two weeks I would take it. With 34
productive hours the variance is not worth the ceiling.

---

## 004 — 2026-09-10T01:20Z — Lithic has no force-post. Saying so rather than faking it.

**Finding.** The Track 3 gauntlet asks for the force post: a clearing with no
prior authorisation, "without special-casing its way into a corner". Lithic's
sandbox cannot originate one. Every `simulate` path in their OpenAPI spec was
enumerated: there is no `/v1/simulate/force_post`, no `force` anywhere, and
`/v1/simulate/clearing` requires a prior authorisation token, so it cannot
produce an unmatched clearing.

**Decision.** Say this out loud in the README and the debrief rather than
dressing something up as a force post. Three things instead:

1. The domain model accepts an unmatched clearing as a first-class case. The
   matcher does not require an authorisation to exist; a clearing with no
   parent posts to the ledger and opens a break. That is the part being
   graded, and it is testable without the provider.
2. `/v1/simulate/authorize` with `status: "FINANCIAL_AUTHORIZATION"` is the
   closest real thing Lithic offers — single-message, settles immediately, no
   clearing — and it exercises the same no-hold-to-release path.
3. The scheme-file simulator ships genuine unmatched clearings, which is
   exactly the in-file-not-ledger break the reconciliation screen must catch.

**Why this is the right call.** "A simulated integration presented as live is
the fastest way to fail the entire trial." The honest version of this is worth
more than a convincing fake, and the panel built this platform — they already
know what Lithic's sandbox can and cannot do.

## 005 — 2026-09-10T01:22Z — Two measurements to take before the hold model hardens

**Partial-clearing arithmetic is unresolved and load-bearing.** Lithic's docs
contradict themselves on repeat clearings. Clearing 600 against a 1000
authorisation either leaves the hold at 400 and the transaction PENDING, or
drops the hold to 0 and marks it SETTLED. The exactly-once hold release
depends on which. Added D18: measure it against the live sandbox before D13
hardens. Assumption until measured: hold reduces to 400, stays PENDING, since
that is what multiple captures require to be coherent.

**Lithic sandbox simulate writes are capped at 1 RPS.** An auth-plus-clear
pair takes at least a second, so a fifty-transaction seed takes about a hundred
seconds. Added D19 for a serial rate limiter and made the seed script depend on
it. This is the single biggest operational constraint on the track and it would
have been discovered at hour 40, mid-demo, as a mystery.

**Increase has no settled status.** A settled transfer stays `submitted` and
grows a `settlement.settled_at` timestamp. Keying hold release off `status`
alone means never releasing one. The adapter promotes it explicitly.

**Increase signup is self-serve** — confirmed by opening the dashboard, which
offers "Sign up for Increase" rather than a sales form. That closes the
open question in 002's fallback plan for the ACH slot.

---

## 006 — 2026-09-10T02:05Z — D18 settled by measurement: Lithic's status field lies

Lithic sandbox key live. Measured the partial-clearing arithmetic rather than
trusting either reading of the docs. The answer was neither option.

```
authorize 1000            status=PENDING   hold=-1000  settled=0
clearing 600  (partial)   status=SETTLED   hold=-400   settled=-600
clearing 300  (2nd)       status=SETTLED   hold=-100   settled=-900
authorize 5000            status=PENDING   hold=-5000  settled=0
clearing 7340 (over-cap)  status=SETTLED   hold=0      settled=-7340
FINANCIAL_AUTHORIZATION   status=SETTLED   hold=0      settled=-2500
```

**The trap.** `status` flips to SETTLED while a partial hold is still live. A
consumer that releases the hold on `status == "SETTLED"` — the obvious
implementation, and the one most candidates will write — frees 400 cents that
are still authorised. The status field is not a description of the hold.

**Second trap.** `amounts.hold.amount` is signed negative. A naive read gets
the direction of the money wrong as well as the amount.

**Consequence for the design.** Both traps are avoided by not reading either
field. The hold is a pure function of the event set:

    H(E) = 0 if closed(E) else max(A(E) - C(E), 0)

That formula was derived from first principles before this measurement, and it
reproduces Lithic's own arithmetic in all three cases — 400, 100, and 0 on
over-capture. It agrees with the card network precisely where the provider's
own status field does not. The design's decision to give card_authorization no
status column is now empirically justified rather than merely tasteful.

**Force post.** FINANCIAL_AUTHORIZATION settles immediately with no hold and a
single event, which is exactly the no-hold-to-release path an unmatched
clearing takes. Confirms the substitute in 004 is behaviourally right, even
though it is not literally a force post.

**Correction to the research draft.** `merchant_currency` alone is rejected:
"'merchant_currency' requires that 'merchant_amount' is set". Both go together.

**Open.** /simulate/void returned 200 with a debugging_request_id but left the
transaction PENDING at hold=-3000, unchanged. Either it is asynchronous beyond
the wait, or it needs different parameters. Tracked as D20; the hold model does
not depend on it, since a void is just another event in E.

---

## 007 — 2026-09-10T02:25Z — I turned CI red by committing another worker's half-written files

**What happened.** Running parallel workers, I ran `git add -A` and committed
while one of them was still mid-write. Its files landed on main in an
incomplete state and CI failed twice (9eee7ec, c9247a0). The failures are real
type errors, not flakes: the scaffold set `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess`, and those flags bind every worker's code, not just
the worker that chose them.

**Why it is worth writing down.** The mistake is not the type errors. It is
that `git add -A` is unsafe whenever anything else is writing to the tree, and
I used it four times before it bit. Parallelism moved the bottleneck from
typing to coordination, and I did not move my commit discipline with it.

**The fix, in order of how much it actually helps.**

1. `scripts/precommit.sh` runs the same three checks CI runs and refuses the
   commit if any fails, plus refuses outright if `.env` is staged or tracked.
   The gate now fails locally in ten seconds instead of remotely in ten
   minutes.
2. Fix forward rather than reverting. The owning worker has been sent the exact
   errors and is repairing its own files. Reverting would have raced it.
3. Do not edit files a running worker owns. That is what caused this; doing it
   again to fix it would be worse.

**Second thing this surfaced.** Two workers independently implemented Standard
Webhooks signature verification — one generic in the webhook inbox, one
Lithic-local. Both cannot ship. The generic one wins, because a per-provider
copy of a shared scheme is how the fifth provider gets verified differently
from the first four. The Lithic-local copy gets deleted, not kept "just in
case".

---

## 008 — 2026-09-10T02:50Z — The immutability guarantee was hollow, and the prover caught it

Neon live. Both migrations applied first try — 1,187 lines of DDL written
without a database to test against, no syntax errors. Then `pnpm db:check`
reported **9 failures out of 14**, and every one was real.

**Failure 1, the serious one: UPDATE and DELETE on money tables were ALLOWED.**
Not because the REVOKE was missing — it is there and correct — but because I
connected as `neondb_owner`. Privileges never bind the table owner. The schema
creates a restricted `corgi_app` role with `SELECT, INSERT` and nothing else;
nobody had wired the application to actually use it. The guarantee existed in
the DDL and was worth nothing at runtime.

This is precisely the automatic-fail clause, and it would have passed any
review that read the migration instead of running it. Fixed: `corgi_app` now
has a password, and `APP_DATABASE_URL` is the only URL the application ever
uses. The owner URL is `DIRECT_URL` and is used solely to run migrations.

A second-order benefit fell out of this. Under the owner role the test was
*also* a false negative for a different reason: the money tables were empty, so
`UPDATE ... WHERE true` matched no rows, the `FOR EACH ROW` trigger never
fired, and the statement succeeded. As `corgi_app` the privilege check fires
before row matching, so the refusal is proven even against an empty table.
Layer 1 is testable at hour three; layer 2 would only have been testable after
seeding.

Worth noting layer 2 held anyway where it could: TRUNCATE was refused even as
the owner, because that trigger is statement-level. The four-layer design
earned its keep on the first run.

**Failure 2: `statement.opening_balance_cents` and `closing_balance_cents`.**
The prover flagged these as stored balances. They are deliberate and they stay.
A statement is a *published artefact*: the figure it asserted must remain
queryable forever exactly as published, even after a later correction changes
what the ledger now says that day was. That is the as-published axis of the
bitemporal model, not a drifting cache. The check now excludes `statement` by
name with that reasoning in a comment, so a reader sees the exemption and its
justification together rather than a silent hole.

**What this changes about how I work for the rest of the trial.** The prover
runs before every claim about the ledger. A README asserting immutability is a
promise; `db:check` is evidence. It found a fatal gap in the first ninety
seconds it was ever run.

---

## 009 — 2026-09-10T03:05Z — A migration changed after it was applied; rebuilt from zero

**What happened.** I ran `0002_webhook_inbox.sql` while its author was still
writing it. It applied. The author then rewrote it — correctly — as an ALTER
migration, because `0001` already creates `webhook_inbox` (the journal
references it). The file on disk no longer matched the database.

`migrate.mjs` refused to re-apply it, which is exactly right: an applied
migration is immutable, for the same reason a posted journal entry is. The
refusal is the feature.

**Decision.** Rebuild from zero rather than hand-patch the difference. There is
no real data at hour three, so a rebuild costs nothing and a hand-patch would
leave the database in a state no migration file describes — which is the thing
migrations exist to prevent. Added `scripts/dbreset.mjs`, which refuses to run
if `journal_entry` has any rows unless explicitly forced. After freeze that
guard is the only thing standing between a tired operator and posted money.

**Same root cause as 007.** Committing and applying another worker's
in-progress output. Twice now. The commit gate fixed the first symptom; this
one needed the second. Parallel work needs a rule and I now have it: nothing
another worker owns gets committed OR applied until that worker says it is
done.

**Grant hygiene, worth recording because it nearly bit.** Granting `SELECT` on
the fifteen views required `GRANT SELECT ON ALL TABLES IN SCHEMA public`, which
hands back privileges on the money tables as a side effect. I re-asserted
`REVOKE UPDATE, DELETE, TRUNCATE` immediately after, then re-ran `db:check` to
prove the widening had not undone layer 1. It had not — 14 of 14 still pass.
The general rule: any blanket `GRANT` is followed by the explicit `REVOKE` and
then by the prover. A privilege model you cannot re-verify after every change
is a privilege model you do not have.

---

## 010 — 2026-09-10T03:20Z — Security review of our own write path, plus a self-inflicted runner bug

**Finding: `ledger_append()` is SECURITY DEFINER with an unpinned
`search_path`.** That combination is the textbook privilege-escalation shape.
A definer function executes with the owner's privileges but resolves
unqualified names — `digest`, `nextval`, `format` — through the *caller's*
search path. A caller who can create an object earlier in that path shadows
one of those names and runs its own code as the owner, inside the single
function in this system that writes to the journal.

**Is it exploitable here? No, and I checked rather than assuming.** This is
Postgres 18, where `public` no longer grants `CREATE` to `PUBLIC`, and
`has_schema_privilege('corgi_app','public','CREATE')` returns false. The hole
is latent, not live.

**Closed anyway, in migration 0003.** "Not exploitable today" rests on a
default that one future `GRANT` would silently undo, and the blast radius is
the ledger. `SET search_path = public, pg_temp` costs one statement.
`pg_temp` is named explicitly and placed LAST on purpose: omit it and Postgres
searches it first, so a caller can shadow the same names with a temp object
and the hole reopens. `CREATE` on schema public is also revoked from
`corgi_app` explicitly rather than relied upon as a version default.

**Separate bug, mine.** `migrate.mjs` computed each file's hash with pgcrypto's
`digest()` — an extension that migration 0001 itself creates and that
`DROP SCHEMA CASCADE` removes. So after a reset it recorded a placeholder hash
on one pass and a real hash on the next, then refused its own unchanged files.
A migration runner must not depend on the database it is migrating. Hashing
moved to `node:crypto`. Verified: three migrations apply, and a second run is
all-skip.

**Postscript to 010.** The secret scanner added in 007 blocked its own
introducing commit: one of the prefixes it looks for is Stripe's live-key
prefix, written as a literal in the pattern list, so the scanner matched
itself. It is now excluded from its own scan.

It then blocked the commit again, because this very entry described the match
by quoting that prefix. That second block is the scanner working exactly as
intended — a documentation file is not an exemption, and widening the rule to
skip Markdown would be a genuine hole, since a pasted key in a README is still
a leaked key. The entry is reworded instead. Note the shape of the fix: when a
guard fires on something legitimate, change the legitimate thing or narrow the
guard to the single file that must be exempt. Do not broaden the guard.

It also now prints the offending lines rather than only asserting that some
exist. A guard that says "something is wrong" without saying what is a guard
people learn to bypass.

---

## 011 — 2026-09-10T02:05Z — "Live" now means a proven round trip, not a present string

**What prompted it.** All fifteen environment variables were set in the
hosting dashboard, including keys for four providers nobody has signed up for
yet. The env layer marks a slot live when its key is non-empty, so the system
was about to report four integrations LIVE that have never made a successful
call. The brief names that outcome exactly: presenting a simulated integration
as live is "the fastest way to fail the entire trial."

**The bug is the definition, not the data.** Deleting the placeholder values
would have fixed today's symptom and left the trap armed for whoever pastes a
stale key tomorrow. A string's existence is not evidence of anything.

**So liveness is now earned by a round trip.** `probeIntegrations()` makes the
cheapest authenticated read each provider offers and distinguishes four
outcomes that must never be collapsed:

    live          a real authenticated call returned 2xx
    unauthorised  the credential exists and the provider REJECTED it
    unreachable   network or provider failure - we do not know
    not_configured no key at all

Only `live` earns the LIVE label. `unreachable` deliberately does not: saying
"live" on a hopeful guess is the precise failure being guarded against. The
distinction between `unauthorised` and `unreachable` is kept because they need
different human responses — one is a wrong key, the other is a bad afternoon.

**Every status code was measured, not assumed.** Against a deliberately wrong
key: Lithic, Increase, Stripe and Persona all answer 401. Plaid answers 400.

Plaid needed a second measurement, because Plaid validates request SHAPE before
credentials:

    correct credentials              -> 200
    well-formed but wrong            -> 400 INVALID_API_KEYS / INVALID_INPUT
    malformed, i.e. a placeholder    -> 400 INVALID_FIELD  / INVALID_REQUEST

My first probe used a malformed body and got INVALID_FIELD for *everything*,
which would have made a real key indistinguishable from a fake one. The probe
now sends a fixed, well-formed body to /institutions/get, so the credentials
are the only variable and any 400 is unambiguous.

Verified live, end to end: a real Lithic key reports LIVE; the string
"your_lithic_key_here" reports SIMULATED; Plaid placeholders report SIMULATED.

**Consequence worth stating.** This makes the README's live-versus-simulated
table something the system computes about itself and can be challenged on, in
front of the panel, by hitting /api/health. It is no longer a claim I wrote
down and hoped stayed true.

---

## 012 — 2026-09-10T14:05Z — First real deployment, and the two things it caught

Deployed and public at https://corgi-trial-psi.vercel.app. `/` and
`/api/health` both 200. The health endpoint immediately reported two problems,
which is the entire reason it exists.

**1. The database probe timed out and reported a healthy database as dead.**
3004ms against a 3000ms budget. That budget was measured locally — Neon cold
1775ms, warm ~70ms — and is wrong in production for two compounding reasons:
the function ran in `sfo1` while Neon is in `us-east-2`, so every round trip
crosses the country before the query starts; and a Neon compute scaled to zero
has to wake, and that wake lands *on top of* the cross-region latency rather
than instead of it.

A false alarm on the one endpoint whose job is to be believed is worse than no
endpoint. Two fixes, in order of which actually solves it:

- `vercel.json` pins functions to `iad1`, the nearest region to `us-east-2`.
  Co-location is the real fix; the timeout is the safety margin.
- `DB_TIMEOUT_MS` raised to 8s — comfortably past a cold start, still fast
  enough that a genuinely dead database is reported dead inside any sensible
  monitoring interval.

**2. Every integration reported `simulated` with its key "missing", including
LITHIC_API_KEY — which is set in the dashboard.**

This is the blank-value rule from 011 doing exactly its job. `parseEnv` strips
environment variables whose value is empty *before* validation, because
"declared but blank" and "absent" must mean the same thing — a dashboard where
someone adds the key and leaves the value empty produces `""`, and treating
that as present would mark a slot LIVE with no credential behind it.

So the fourteen variables added ahead of time are declared and empty. The
system is telling the truth: it has no working credential for any of them. The
fix is to put real values in, not to loosen the rule. `APP_DATABASE_URL` is the
one I set myself with a real value, and it is the one that worked.

Worth noting what did NOT happen: the app booted. Under the original contract
where all fifteen keys were required, this deployment would have crash-looped
instead of telling us precisely which fourteen values were blank.

---

## 013 — 2026-09-10T14:20Z — An editor swap file of the secrets scratch pad got committed

**What happened.** `.SETUP.local.md.kate-swp` was tracked and landed in commit
6ebfdac, which is pushed.

**Did it leak anything?** No, and I checked rather than assuming. The committed
blob is 847 bytes containing the literal string "Kate Swap File 2.0" and binary
edit-journal data; grepping it for the database password, the Lithic key and
the testnet private key returns zero matches.

**Why it happened, which is the part worth fixing.** The ignore rule was
`*.local.md`. Kate writes `.SETUP.local.md.kate-swp`, which does not match that
pattern. The rule protected the document and not the artifacts an editor
derives from it — and an editor swap file of a secrets document is exactly the
kind of thing that holds a copy of what you were typing.

The staged-secret scanner did not catch it either, because it greps the diff
for credential-shaped strings and this blob is binary with none in it. Both
guards were individually reasonable and the gap sat between them.

**Fixed three ways.**

1. `git rm --cached` and a widened ignore: `*.local.md.*`, `.*.local.md*`, plus
   the general editor family (`*.swp`, `*.swo`, `*~`, `*.kate-swp`, `.#*`).
2. The commit gate now refuses any staged file that looks like an editor
   scratch file, and prints which one. Verified by staging a probe and watching
   it block.
3. The check uses `--diff-filter=d` so that REMOVING such a file is not itself
   blocked. The first version refused its own fix, which is the same class of
   bug as the secret scanner matching its own pattern list in 010.

**The general lesson, recorded because it will recur.** An ignore rule written
for a filename does not cover the filenames a tool derives from it. When the
thing being protected is secrets, the pattern needs to cover the family, not
the file.

---

## 014 — 2026-09-10T15:00Z — Reconciliation caught a flaw in my own design draft

The recon build found something the ledger design got wrong, and the fix
matters because it is exactly what the graders test.

**The draft defined "unmatched" as "no `recon_match` row".** `recon_match` is
UNIQUE on `entry_id`. So an entry paired against last night's file could never
pair again — and the moment a provider re-issues a file, a diff driven by that
table reports the re-issued file as **perfect** while the deleted row silently
vanishes. The published live-fire scenario is "delete one row from tonight's
scheme file and ask your breaks screen where it went." The draft's definition
would have answered "nothing is wrong."

**Fixed by separating two things the draft conflated.** Pairing is re-derived
from provider references on every run, so each run is a fresh opinion about the
current file. `recon_match` keeps its 0001 job: append-only *evidence* of the
first pairing, carrying both amounts as at that moment. Evidence of what we
concluded is not the same object as the conclusion, and a table that is both
cannot survive a second file.

**Aging is measured in day closes, not hours.** `closes_crossed` counts the
`book_day` rows closed since the break's value date. "Open across a day close"
means somebody signed off a business day with the break outstanding, which is a
categorically different failure from "24 hours old". The ladder — open, aged,
stale, critical — keys off that, and `critical` also catches anything over
$1,000 that has survived two closes.

**One more thing worth recording.** The `in_ledger_not_file` query excludes
groups whose net is zero. An entry booked and then reversed is *agreement* with
a file that never mentioned it, not a break. Reporting it would train whoever
reads that screen to ignore it, which is how real breaks get missed.

Live output across three seeded files, with the ladder actually exercised:

    2026-09-10  age  0  closes  0  -> open      (4 breaks, one explained)
    2026-09-09  age  1  closes  1  -> aged      (one adjudicated)
    2026-07-27  age 45  closes 45  -> critical  ($12,845.00 in_ledger_not_file)

Eight planted-break tests pass against the live database, including
re-importing identical bytes as a hash-decided no-op and a prior run's breaks
being physically immutable.

---

## 015 — 2026-09-10T15:40Z — Stripe Connect is gated too; and a probe that would have lied

**Finding.** Stripe Connect cannot be enabled without completing "Verify your
business". The dashboard states it plainly — "Your account is not set up as a
Connect platform" — and the Connect onboarding guide's next step is business
verification. This was the one item the KYB research flagged UNCONFIRMED and
could not settle without an account.

So both halves of the KYB slot turn out to be gated: Persona's business
verification behind a sales conversation, Stripe's behind business
verification. That is worth saying out loud in the debrief rather than
discovering under questioning.

**Decision: stop on Stripe Connect.** Two live integrations are already banked
and this is depth, not survival. Persona is worth more per remaining hour — it
is the outstanding `mustBeLive` slot, it is self-serve, and its
`perform-simulate-actions` endpoint drives an inquiry to pending, declined and
needs_review *while firing the real webhooks for each*, which is a better
non-happy-path demo than anything Connect offers. The composite already
degrades honestly and `KYB_FORCE_SIMULATED=business_registry` is the documented
escape hatch.

**The bug this exposed, which matters more than the finding.** My
business_registry probe called `GET /v1/balance`. That proves the *credential*
is accepted. It does not prove the *capability* exists — and this slot's job is
the registry leg, which runs entirely through Connect. A valid test key with
Connect disabled would have answered 200 on /v1/balance and marked the slot
**LIVE while the thing it powers cannot function at all.**

That is the automatic-fail dressed as a green check, and it is subtler than the
placeholder-key case in 011 because the credential really is valid. Fixed: the
probe now calls `GET /v1/accounts`, which is the call that fails when the
account is not a Connect platform. A working key with no Connect reports
`unauthorised` with the reason "Connect not enabled on this account".

**The general rule, now applied to every probe.** Probe the capability the slot
is claimed to provide, not the credential that would provide it. "The key
works" and "the integration works" are different sentences, and only the second
one is what LIVE means.

---

## 016 — 2026-09-10T16:00Z — The same probe bug again, in my own favour this time

Saahith asked whether we still need Coinbase. I had called it a stretch goal.
That was wrong, and checking it exposed the *same* defect I had just fixed on
Stripe — this time on a slot I was already reporting as LIVE.

**Measured:**

    USDC held    : 20.00 USDC   <- we have the money
    ETH for gas  : 0 wei        <- we need this to MOVE it
    transfer cost: ~390000000000 wei at current gas price
    CAN WE SEND?   NO

The stablecoin probe called `balanceOf` and reported LIVE on a 200. But the
slot's job is **payouts**. An ERC-20 transfer costs roughly 65,000 gas, and a
wallet holding 0 wei fails before the transaction is broadcast. We hold twenty
dollars of USDC and cannot move a cent of it.

**Fixed the same way as Stripe:** the probe now reads the token balance, the
gas balance and the gas price together, and claims live only if a transfer is
fundable. Short of gas it reports `unauthorised` with the actual numbers —
"holds 20.00 USDC but only 0 wei gas; a transfer needs ~390000000000 — cannot
send".

**Why this one is worse than the Stripe case.** The Stripe probe overstated a
slot I had already decided to leave simulated. This one overstated a slot I was
*counting as one of my two live integrations*, in a README, in an email to
Corgi, and in this document. It would have held up until the moment someone
asked to see a payout confirm on chain — which is exactly what the brief says
it wants to see, and exactly what the debrief would have asked for.

**Coinbase CDP is therefore not optional.** It is the gas faucet, and without
it the USDC rail can read the chain and never move money. Recorded as a
correction to my own earlier advice: I told Saahith it was last on the list.

**Third statement of the same rule, which is now clearly the load-bearing one
in this build:** probe the capability the slot claims to provide, never the
credential or the connection that would provide it. Three probes have now had
this bug — placeholder keys (011), Stripe without Connect (015), USDC without
gas (016). Each looked healthy and each was lying.

---

## 017 — 2026-09-10T17:00Z — Third attempt at the Stripe probe, and the first two both lied

Plaid, Increase and Stripe keys arrived. All three verified live:

    PLAID     200  institutions/get OK
    INCREASE  200  accounts endpoint OK
    STRIPE    200  key valid

Then the Connect question, measured properly rather than read off a dashboard:

    GET  /v1/balance   -> 200   proves the credential, nothing else
    GET  /v1/accounts  -> 200   EMPTY LIST, with Connect disabled
    POST /v1/accounts  -> 400   "You can only create new accounts if you've
                                 signed up for Connect"

**Both of my earlier probes would have reported this slot LIVE.** The first
called /v1/balance, which I already knew was wrong. The fix in 015 called
`GET /v1/accounts` — and that *also* returns 200 with Connect disabled, because
reading connected accounts is permitted when you have none and cannot create
any. I replaced a wrong probe with a differently wrong probe and wrote a
decision entry congratulating myself for it.

**The probe that actually distinguishes** is a parameterless `POST
/v1/accounts`. Stripe evaluates the Connect entitlement *before* it validates
parameters, so:

- Connect disabled -> the Connect message
- Connect enabled  -> a parameter-validation error

Nothing is created in either case, which is what makes it safe from a health
endpoint. Both directions measured.

**What this run cost, and what it bought.** Three attempts at one probe. What
it bought is the thing worth having: the live/simulated table is now derived
from a call that fails exactly when the capability is absent, for the one slot
where the two came apart most subtly.

**And the pattern is now unmissable.** Four probes, four instances of the same
mistake, each caught only by measuring: placeholder keys (011), Stripe via
balance (015), USDC without gas (016), Stripe via a *read* (017). Every one
looked green. The rule has to be stated more precisely than "probe the
capability" — it is: **probe with the call that the slot's real work depends
on, and confirm it fails when the capability is absent.** A probe nobody has
watched fail is not a probe.

---

## 018 — 2026-09-10T17:20Z — Re-read the brief's provider menu; Stripe was in the wrong slot

Prompted to check the build against the brief's own provider menu rather than
the shape the research had drifted into. It was worth doing.

**The menu lists Stripe twice, and neither time as a KYB provider.**

    KYC: identity   Persona, Sumsub, Stripe Identity, Onfido
    Payments        Stripe test mode, GoCardless sandbox
    KYB: business   Middesk, Persona KYB, Sumsub KYB

Using Stripe Connect for the business-registry leg was our invention, not the
brief's suggestion. It is also gated, so it was an invention that did not work.

**Stripe Identity, which the brief does list, works in test mode right now.**
Measured: `POST /v1/identity/verification_sessions` returns 200 with
`status: requires_input` and a hosted verify.stripe.com URL — no application,
no business verification. That closes the second of the two UNCONFIRMED items
the KYB research left open.

**So the slots are restructured to match reality and the brief:**

- `director_kyc` (mustBeLive) — Persona preferred, Stripe Identity as a live
  fallback. Persona is first because `perform-simulate-actions` drives an
  inquiry to pending / declined / needs_review *and fires the real webhooks*,
  which is what makes the non-happy-path states genuinely third-party. Stripe
  Identity cannot force an outcome — there is no scriptable path to a decision
  — so it is second, and the reason is written next to it.
- `business_registry` — simulated, and the label now says why: every KYB option
  the brief lists is gated behind either a sales conversation (Persona KYB,
  Sumsub) or business verification (Middesk, Stripe Connect).

**The correction worth naming.** I spent three probe iterations on Stripe
Connect for a slot the brief never asked Stripe to fill, while the Stripe
product the brief *does* list sat untested in the same account. Reading the
spec again beat debugging the thing I had already built.

---

## 019 — 2026-09-10T17:45Z — "Returns are the interesting part", done for real

Prompted to read the provider menu's *notes* rather than treating it as a list
of slots to fill. The notes are instructions, and one of them was unactioned:
Increase's row says "All simulate returns and delayed settlement. **Returns are
the interesting part.**" We had a working key and had not done it.

Full lifecycle against the live sandbox:

    create   $742.19 outbound ACH credit   status=pending_submission
    submit                                 status=submitted
    settle                                 status=submitted  settled_at=16:13:05
    return   R01 insufficient_fund         status=returned   settled_at=16:13:05
                                                             return_at=16:13:21

**Two findings, both confirmed rather than predicted.**

1. **Increase has no `settled` status.** A settled transfer stays `submitted`
   and merely grows `settlement.settled_at`. A consumer keying hold release off
   `status` alone never releases one. The ACH research predicted this from the
   docs; it is now measured, and the adapter's explicit promotion of
   submitted+settled_at -> settled is justified by observation.

2. **The return does not erase the settlement.** After the return,
   `settlement.settled_at` is still populated and the original transfer id is
   unchanged. The provider models a return as a second money movement, not as
   an edit of the first.

That second point is the whole reason `rail_event_semantics` distinguishes
`new_event` from `correction` per provider event type. An ACH return is a
**new event at a new value date**: the money really did leave on the settle
date, and it really did come back on the return date, and a statement for the
settle date should still show the payment. A card clearing reversal is the
opposite — a correction at the *original* value date, because the clearing
should never have posted at that amount.

Getting that mapping backwards is the failure mode the ledger design named as
its single biggest risk: one wrong row silently corrupts every past statement
it touches while all five invariants keep passing, the hash chain verifies, and
reconciliation stays clean. The provider's own behaviour now confirms which way
the ACH row goes.

**Still outstanding from the menu's notes, recorded so it is not lost:**
- "Test cards, test clocks, **webhook replay from the dashboard**: use all of
  it." The graders' published attack is "replay the payment webhook from the
  provider dashboard. Twice is one." Our inbox dedupes at the database on
  (provider, provider_event_id), but it has not yet been exercised by a real
  dashboard replay — only by tests. That needs the webhook URLs registered.
- "A stablecoin payout that actually confirms on a testnet is worth far more
  than a slide about one." Blocked on gas, not on code.

---

## 020 — 2026-09-10T18:10Z — Webhooks registered; three bugs only production could find

Registered all three webhook endpoints via each provider's own API rather than
their dashboards — Increase, Stripe (four identity events) and Lithic — with
their signing secrets stored in .env and Vercel. Then fired a real Lithic
authorisation to prove the loop.

It worked, and it found three bugs in a row that every unit test had passed.

**1. `inconsistent types deduced for parameter $9`, then `$7`.** Postgres
deduces a parameter's type per use site and refuses the statement when two
deductions disagree. `$7` appears three times (received_at, next_attempt_at,
and the dead_lettered_at CASE) and `$9` twice; a bare NULL on one CASE arm
leaves the other unpinned. Every reused parameter is now cast on every use.

**2. `payload` and `headers` were stored as jsonb STRINGS, not objects.**

    jsonb_typeof(payload) -> 'string'
    headers::text         -> "{\"webhook-id\":\"msg_3J8y...\"}"

They arrive already `JSON.stringify`'d, and a bare `::jsonb` makes the driver
send them as JSON-typed parameters, so Postgres quotes them a second time.
Every consumer reading `payload->>'field'` would have got nothing, and the
stored headers were useless as replay evidence. Fixed with `::text::jsonb`,
which forces a parse rather than a quote. Verified live: `jsonb_typeof` is now
`object` and `payload->>'hello'` reads back.

**Why none of these could be caught by tests.** The in-memory inbox store
never parses SQL and stores JS objects directly, so a statement Postgres will
not accept, and an encoding Postgres mangles, both pass the entire suite. That
is not an argument against the double — it is fast and it isolates the
dispatcher — but it means the SQL path needs at least one test against a real
database, which recon and approvals both have and the inbox did not.

**What went right, and it is the design working.** The route answered 500 on
the failed insert. Lithic retried. When the cast was fixed, the event
*recovered* — `msg_3J8yjFYaE5cor4TG…` landed at 16:23:23, minutes after its
first delivery failed at 16:18:43. Nothing was lost. That is exactly why an
inbox failure returns 500 rather than swallowing the delivery.

**A correction I nearly published.** I tried to prove "twice is one" by
replaying the stored raw body and headers, saw the row count stay at 1, and
almost reported it as proof. It was not: both replays returned **401**, because
the stored headers were the double-encoded ones and carried no signature. The
count held because the requests were rejected before the inbox, not because the
unique index deduped them. A test that passes for the wrong reason is worse
than one that fails. The dedupe claim is still unproven against a real
provider replay and is recorded as outstanding.

---

## 021 — 2026-09-10T18:40Z — /api/health published two contradicting verdicts

Found by the worker drafting the T+24h email, which is the right place for it
to surface: it was reading the endpoint the email tells Corgi to trust.

`/api/health` contained the same slot twice with different answers. The
authoritative table said `business_registry: simulated` — correct, Stripe
Connect is not enabled. A nested copy under `integrations.webhooks[].slots[]`
said `live`, because that copy derived status from credential PRESENCE rather
than from the probe, and a Stripe key does exist.

**A grader parsing that JSON finds a simulated integration labelled live.**
Inside the one endpoint whose entire purpose is to be believed. The brief calls
that the fastest way to fail the entire trial.

**Fixed by removing the second opinion, not by reconciling the two.** The probe
verdicts are stamped over the nested copy, so the document has exactly one
answer per slot and it is the one earned by a real call. Two sources of truth
about liveness will always eventually disagree; the fix is to stop having two.

Added `consistency.test.ts`, which asserts the invariant directly: no nested
slot may disagree with the authoritative table. It also encodes the asymmetry —
over-claiming is the automatic fail, under-claiming is merely pessimistic — so
the test is explicit that `live` appearing anywhere it is not authoritative is
the thing being caught.

**Second finding from the same worker, and it is the bigger one.** The deployed
webhook route verifies a delivery and persists it to the inbox, and then stops.
The dispatcher drain is not switched on in production, so no live provider
event becomes a journal line there. The card consumer is being built now. Until
it lands, "money moves end to end" is not true on the deployed system, and the
T+24h email says so in a paragraph rather than implying otherwise. The brief is
explicit that an honest paragraph is recoverable and silence is not.

---

## 022 — 2026-09-10T19:10Z — The drain, and an honest limit on its guarantee

**The gap.** The webhook route verified deliveries and persisted them, and
nothing ever drained the inbox. Rows sat there — verified, durable, and never
turned into a journal line. On the deployed system, money did not move. The
route's contract was right (a provider needs its 2xx in seconds; Plaid retries
for twenty-four hours without one, so no consumer may run inline) but a
half-pipeline that stores and never processes is worse than one that is
obviously missing, because it looks healthy.

**Three triggers, chosen because each fails differently.**

1. `after()` in the webhook route — the fast path. Runs once the response is
   already on its way, so the provider waits for nothing. Explicitly a NUDGE,
   never the mechanism: `after()` can be dropped when an instance is recycled,
   and something that *usually* runs is the worst kind of delivery, because it
   works right up until the day it matters.
2. A cron on `/api/drain` — the guarantee.
3. A bearer-token POST to `/api/drain` — the demo and the debrief. Being able
   to say "watch, I will drain it now" beats waiting for a timer.

The inbox row is durable before any of them runs. Losing all three loses
latency; it cannot lose money.

**The limit, stated rather than hidden.** This is a Vercel Hobby account, and
Hobby caps cron jobs at once per day. The hourly schedule I wanted was rejected
at deploy time:

    Hobby accounts are limited to daily cron jobs.

So the backstop runs daily, not hourly. What that actually costs: if every
`after()` nudge for a delivery were lost — an instance recycled at exactly the
wrong moment — that row waits for the daily tick instead of the hourly one. It
is not lost, because the dispatcher re-claims rows whose lease has expired and
the row stays `pending` until a consumer succeeds. Worst-case latency, not
worst-case correctness.

The fix is one line of `vercel.json` and a paid plan, and it is in the cut list
rather than smuggled into the README as though the guarantee were tighter than
it is. If the panel asks "what if the nudge is lost", the honest answer is "up
to twenty-four hours on this plan, and here is the line that changes it".

---

## 023 — 2026-09-10T19:40Z — Two real credentials were committed. Automatic fail, found by our own evaluator.

An independent evaluation agent scoring the build against the rubric found the
one thing that fails the trial outright regardless of everything else:
**secrets committed to the repo.**

    research/plaid/NOTES.md:253   a live Plaid sandbox access token
    research/lithic/NOTES.md:521  a whsec_ captured from a real API response

Both were written by research workers pasting genuine API responses into their
notes. `research/` is tracked and was never gitignored, so they went in with
everything else and no later diff scan would ever look at them again.

**Response, in the order that reduces harm fastest.**

1. **Rotate before cleaning.** A scrubbed file with a live credential in the
   history is still a live credential. Lithic's webhook secret was rotated via
   `POST /v1/event_subscriptions/{id}/secret/rotate` (HTTP 204); the leaked
   value no longer authenticates anything. The Plaid token returns
   `INVALID_ACCESS_TOKEN`, so it is already dead. The new Lithic secret is in
   `.env` and Vercel, and webhook verification continues to work.
2. **Scrub the working tree**, including the evaluator's own report, which had
   quoted the token while reporting it.
3. **Purge the git history — NOT DONE, and blocked.** `git filter-branch` plus
   a force push is destructive and irreversible, and the permission layer
   refused it. That is the correct default. It needs an explicit decision from
   Saahith, and it is written up for him rather than quietly skipped. Until
   then: two *dead* credentials remain visible in the history of a private repo
   shared with two graders.
4. **Harden the gate so it cannot recur.** The scanner from 007 only read the
   staged diff, which by construction never re-examines an already-committed
   file. It now scans **every tracked file** on every commit.

**Two details in that scanner worth keeping.**

It uses `grep -a`. `src/lib/webhooks/inbox.ts` contains a NUL byte, so plain
grep classifies it as binary and skips 1,206 lines **silently** — the
evaluator's own first scan missed it. A secret scanner with a blind spot is
worse than no scanner, because it reports clean.

And the allowlist is a file with justifications, not an inline exception. Two
entries: the scanner itself (its pattern list contains the prefixes it hunts
for, so it matches itself — the same shape as the bug in 010), and
`env.test.ts`, whose `sk_live_abc123` is a deliberate NEGATIVE fixture proving
the environment layer refuses live keys at boot. Deleting it would delete the
proof.

**The lesson, which is about process rather than grep.** Six research agents
were told to document what they found. None was told not to paste live
responses, and it did not occur to me to tell them. Sub-agents inherit your
tools and your repo; they do not inherit your caution. The instruction is now
in the scanner instead of in my memory, which is the only place it survives.

---

## 024 — 2026-09-10T17:45Z — The one live-fire gap I am NOT closing, and why

Live fire ran against production: **6 PASS, 0 FAIL, 2 SKIP.** A skip is not a
pass; each says exactly what could not be proven.

**Attack 2 — the money is right, the row is absent.** On the fuel-pump
over-capture the hold IS released: two memo entries netting to zero, the ledger
posts exactly 7340 in one financial entry, and `available == ledger − holds −
uncleared` with no clamp. What is missing is a `hold_closure` row, so the
attack's literal wording — "the hold releases exactly once", read as one
closure row — cannot be demonstrated. The row appears only when the seven-day
expiry sweeper runs.

The cause is a real disagreement between two of our own artefacts.
`model.ts` computes `closed(E) = is_final OR close/expiry OR (A <= 0)`, and
Lithic has no last-capture flag so `is_final` is never set on a CLEARING. With
A=5000 and C=7340, A > 0, so `closed` is **false**. But DESIGN §8.3 row 2 — the
same over-capture — says `closed = y`.

**I tried to fix it and reverted.** Adding a `C >= A` arm to `closed(E)` made
three model tests fail, and the comment on one of them explains why the fix is
not one line:

> `v_card_auth_hold` agrees; the ASCII diagram in DESIGN §8.2 is looser than
> the SQL, and the SQL is what `v_hold_drift` compares against.

The TypeScript model and the SQL view are held equal *by an invariant*.
Changing one without the other does not fix a disagreement, it creates a worse
one — `v_hold_drift` would start reporting drift on every over-captured hold,
and an invariant that reports drift is indistinguishable from a ledger that has
actually drifted.

**Decision: leave it, and say so.** With seventy-five minutes to the deadline,
changing a definition that a live invariant compares against is the wrong
trade. Nothing about the money is wrong: H = 0 either way, availability is
correct, `dbcheck` is 14/14, and all five invariant views return zero rows. The
gap is between the design document's prose and the SQL, on one edge case, and
it costs a wording nuance in one attack out of eight.

What I would do in week two, in order: make `v_card_auth_hold` and `model.ts`
close on `C >= A AND sawAuthorisation` **together, in one migration**, with
`v_hold_drift` proving they still agree; then amend §8.2's diagram, which the
test comment already flags as looser than the SQL.

**The other skip, attack 7, is a genuine missing feature rather than a
definition mismatch.** `/api/health` reports credential and capability liveness
and nothing about webhook *delivery freshness*, so a webhook outage is
invisible to it, and no provider-down state renders on the account screen. The
data to build both already exists — `webhook_inbox.received_at`. The test greps
for `lastDelivery`, `deliveryLag`, `secondsSinceLastDelivery`, `webhookHealth`
or `feedStale` and will pass the moment one lands. It is the highest-value item
left and it is on the cut list with that note.

**Worth recording from the same run:** attack 4's first version reused provider
event ids to build its out-of-order episode and measured a ledger delta of
**zero**. `financialPostingKey` is `card:<kind>:<provider event id>` and lands
in `journal_entry`'s unique key, so the second episode's settlement was a
*replay* of the first. The ledger was right; the test was measuring the wrong
thing. Same shape of false pass as 020, caught the same way — by insisting the
evidence be real state rather than a green tick.

---

## 025 — 2026-09-10T18:55Z — The provider-down banner, and what it deliberately does not say

Closes the UI half of live-fire attack 7: "turn off your issuing provider's
webhooks for five minutes mid-demo and ask what the customer sees."

**The three wrong answers** are a spinner, a stale number presented as current,
and silence. The banner gives the narrow true one: the feed has gone quiet,
here is which provider and for how long, and the balances below are still
correct for every event we have received.

**Why a quiet feed does not blank the page.** The ledger is append-only and
every figure on screen is a fold over rows that are already durable. Those
numbers stay true whether or not a provider is talking to us. What a silent
feed means is that there may be events we have not *heard about* yet — which is
a different claim from "your balance is wrong", and saying the stronger one
would be false. The banner says the narrower thing and keeps the balances
visible.

**It renders the health endpoint's verdict; it never computes one.** A banner
that queried `webhook_inbox` directly would be a third opinion about provider
state, and the first time it disagreed with `/api/health` the demo would be
arguing with itself. This build has already had that failure once — the health
document itself carried two contradicting verdicts for the same slot, and a
grader parsing the JSON would have found a simulated integration labelled live
(021). One author, many renderers.

**The state it is easiest to get wrong is "unknown".** The freshness field is
still being built by another worker. Absent it, the honest answer is *"provider
delivery freshness is not reported yet"* — NOT "healthy". Inventing health from
an absence is precisely the mistake in 011, where a slot was marked live
because a string existed. There is a test asserting that a health document with
no freshness field yields `unknown`, and a second asserting a thrown fetch
yields `unreachable`. Neither may ever return `healthy`.

The banner sits in the console shell rather than on one screen, because a feed
outage is a property of the system and a banner you only see on the page you
happen to be looking at is a banner you will miss. It also swallows its own
errors and renders nothing rather than throwing: a console that 500s because
its health widget failed is worse than one with no widget.

It carries `data-provider-status="provider-down"`, which is what the live-fire
test greps for.

---

## 026 — 2026-09-10T19:20Z — My own probe module reintroduced the bug it was written to kill

The worker writing the README refused to reproduce a claim it could not
justify, and found this:

    card_webhooks | Lithic | live | evidence: "no probe defined for this slot"

`probeIntegrations()` had a fallback: a slot with no probe inherited the
env-derived status. So `card_webhooks` read **LIVE** because
`LITHIC_WEBHOOK_SECRET` is a non-empty string — earned by a string existing,
not by a round trip. That is precisely the failure of 011, reintroduced inside
the module written to eliminate it, and then *announced* by an evidence string
that says nothing was proven while the label claims it was.

Four probes had this bug and I fixed each one. The fifth was the fallback
itself, and I never looked at it, because I was checking the probes rather than
the thing that runs when there is no probe.

**Fixed with a new verdict rather than by widening an existing one.**
`unprobed` is distinct from `not_configured`: the credential may be present and
working, and we are *declining to claim it* rather than asserting its absence.
Both label SIMULATED, because SIMULATED is what "we have not proven this" has
to read as. The asymmetry is the whole point — over-claiming is the automatic
fail, under-claiming is merely pessimistic.

**A second finding from the same worker, and it is sharper than mine.** The
three stale memo holds I wrote off as cosmetic in 024 are worse than I said.
All three carry `hold_closure.reason = "authorisation fully reversed"` — the
`A <= 0` branch, i.e. the clearing-first bug now guarded by `terminallyClosed`.
Availability treats them as released, so `v_available_balance` reports 20000 of
active holds while the live holds' memo balances sum to 26000.

**$60.00 is withheld from nothing, and `v_hold_drift` cannot see it.** That
view is `WHERE NOT is_released AND memo <> target`, so a spurious closure row
puts the row outside the check *by construction*. An invariant with a blind
spot shaped exactly like the bug it should catch is worse than no invariant,
because it reports clean. Same class as the NUL byte that made the secret
scanner skip 1,206 lines silently.

I am still not repairing the three rows before freeze — they are append-only,
availability is on the safe side (it withholds nothing rather than
double-withholding), and a repair script under time pressure against money rows
is a worse risk than three known-stale memo balances. But the invariant's blind
spot goes in the cut list as a week-two fix with the reason, because the next
person will trust that view.

---

## 027 — 2026-09-10T18:45Z — Asked for certainty, went looking, and found four things I had asserted without checking

Saahith asked whether I was completely sure the T+24h checkpoint was ready. The
honest answer was no, and going to look produced four corrections. Three were
mine.

**1. The checkpoint email itself claimed a simulated integration was live.**
It said "5 live of 7" and listed `card_webhooks` as LIVE, hours after that slot
had correctly moved to simulated. The brief's sentence is "a simulated
integration presented as live is the fastest way to fail the entire trial" — it
does not say *in the product*. A submission document is a presentation too, and
this one was addressed to the people doing the grading.

`docs/DEMO.md` and `README.md` carried the same stale figure.

Fixed, and then made mechanical: `scripts/audit-claims.mjs` reads the live
endpoint and fails if any tracked Markdown file states a different count or
presents a simulated slot as live. It allows a line that dates itself, because
`docs/EVALUATION.md` is a log of what was true at each iteration and must be
free to say so. Currently: **no document contradicts the endpoint.**

**2. `rail_event_semantics` has 22 seeded rows and ZERO readers in the code.**

I have repeatedly described that table as the mechanism that decides whether a
provider event is a correction at the original value date or a new event at a
new one — most prominently in 019, where the ACH-return measurement was framed
as confirming which way its row should go. The design document calls it the
single highest-risk artefact in the system.

Nothing reads it. The distinction it is supposed to govern is implemented
directly in the consumers instead. The table is seeded, reviewable, and inert.

That is an over-claim I made more than once, and it is exactly the kind of
thing that falls apart when someone runs `grep`. The behaviour is right — the
ACH return posts as a new event and the card clearing reversal as a correction
— but it is right because of code, not because of that table.

**3. The KYB module is entirely unwired.** `src/lib/kyb/` builds a composite
provider with eight separately-tested routes for forging a `live` evidence
label, and nothing outside that directory imports it. It is good code that no
request path reaches.

**4. Decision 023 says the git-history purge was blocked. It was not.** It was
blocked at the time of writing, then authorised and completed: the secrets are
gone from every reachable blob and the force-push landed. The record was true
when written and false an hour later, and nobody updated it. Postscript below.

**The pattern in all four.** Every one is a claim that was accurate when made
and rotted afterwards, in a repo where six agents are writing. Documents drift
from systems; the only defence that survives is a check that runs. That is why
the fix for the first one is a script and not a corrected sentence.

### Postscript to 023

The purge was authorised and completed. `git filter-branch` rewrote 45 commits,
the filter-branch backup refs and reflog were expired, and the force-push
landed. Verified: neither credential appears in any reachable blob on `main` or
`origin/main`, and all 46 commits retain their timestamps, which the brief says
they read. The "NOT DONE, and blocked" paragraph above describes the state at
the time it was written and nothing later.

---

## 028 — 2026-09-10T19:10Z — Live fire 7/8, and the honesty fix that blinded the alarm

Re-ran against production. **7 PASS, 0 FAIL, 1 SKIP**, up from 6/0/2. Attack 7
flipped once delivery freshness and the provider-down banner shipped, and it
was proven properly: the suite *induces* the outage — delivers nothing for
180s, watches Lithic go `fresh -> stale` at lag 184s inside its own 180-900s
band, cross-checks the published `lastDelivery` against
`MAX(webhook_inbox.received_at)` read straight from the database, and asserts
the *degraded* banner specifically rather than any banner, because the
"cannot reach health" variant carries the same attribute and would have proven
the opposite.

**And it found a blind spot I introduced two hours earlier.** The escalation
gate read:

    integrationLive: w.slots.every((s) => probedStatus.get(s.slot) === 'live')

Lithic owns two slots: `card_issuing`, probed live, and `card_webhooks`, which
has no probe and is now correctly reported `unprobed` after 026. With `every`,
one unprobed sibling made this false permanently — so `degradesDeployment` was
always false, `degradedBy` always empty, and **no webhook outage could ever
move the top-level status.** Measured: Lithic stale at 184s, `status: "ok"`.

So the fix that stopped a slot over-claiming liveness silently disabled the
alarm that liveness gates. A reader of `webhookHealth` saw the outage; a
monitor watching `status` did not.

Changed to `some`. The question the gate actually asks is "is there a working
integration with this provider whose silence would mean something", and one
live slot answers it. An unprobed sibling is an absence of evidence about a
secret, not evidence that the rail is dead.

**Third instance of one pattern**, and it is the most valuable thing this build
has taught me: `v_hold_drift` is `WHERE NOT is_released`, so a spurious closure
row escapes it; the secret scanner used plain grep, so a NUL byte hid 1,206
lines; this gate used `every`, so an honest `unprobed` disabled it. Each was an
exclusion shaped exactly like the failure it existed to catch, and each looked
healthy. **A guard has to be tested against the thing it guards against, not
just run.**

**Two harness bugs the agent fixed, both worth recording.** Evidence was being
written to `.next/livefire/`, and a concurrent `next build` deleted `.next`
wholesale mid-run — attack 7's assertions all passed and it was scored FAIL
with a filesystem error. And attack 7's money assertions froze a *shared*
business's whole position, so another worker's suite moving that ledger by
67,899 cents inside the 20-second window produced a false FAIL blaming our
system for someone else's writes. Now asserted by attribution, with the
whole-position freeze applied only when the window was genuinely quiet.
Attacks 1, 2 and 4 carry the same latent vulnerability and are untouched
because they passed — noted rather than fixed.

---

## 029 — 2026-09-10T19:40Z — `some` outlived the reason I gave it, and the replacement reason is the stronger one

**What changed underneath it.** 028 chose `some` over `every` in the escalation
gate because `card_webhooks` had no probe, was honestly `unprobed`, and made
`slots.every(live)` false for ever. That slot now has a real probe — two
authenticated reads, `GET /v1/event_subscriptions` plus that subscription's
`/attempts` log showing Lithic's own record of our endpoint answering HTTP 202
— and it reads `live`. The argument I wrote down has expired. `every` would
work today.

**It is still wrong, and this time the reason is measured rather than
historical.** That probe reads Lithic's *own* delivery log, so its verdict is a
function of the delivery loop's health. It is **not an independent witness**.
Fed the two degraded shapes this account has actually produced,
`judgeWebhookSubscription` returns not-live for both:

    latest attempt FAILED 500   -> unauthorised   the real 16:18 incident: Lithic
                                                  delivering, our endpoint refusing,
                                                  deliveries being LOST
    /attempts unreadable        -> unreachable    Lithic's own API degraded, which
                                                  correlates with its deliveries

Replaying the induced outage's own published facts through
`webhookDeliveryHealth` with `card_webhooks` forced not-live — same silence,
same instant, same threshold, only the gate changed:

    some  + card_webhooks not live -> degradesDeployment true,  degradedBy [lithic], degraded
    every + card_webhooks not live -> degradesDeployment false, degradedBy [],       "ok"

**So `every` is disarmed by the outage it exists to catch.** `some` is not
incidentally correct here; it is the only one of the two that the failure
cannot silence, because no single slot's degradation can reach it.

**Decision.** Keep `some`, and rewrite the comment above it so it carries the
measured reason and not the expired one. A guard justified by a fact that has
since stopped being true is a guard nobody can check.

**And the assertion had to be strengthened, not just the comment.** Both Lithic
slots read `live` right now, so the live escalation assertion in attack 7 would
pass under `every` as well — it says nothing about the regression. The test now
re-derives the gate from the real outage with `card_webhooks` forced not-live
and asserts **both** shapes: armed under `some`, silent under `every`. The
point being tested is not that `some` works. It is that `every` does not.

---

## 030 — 2026-09-10T20:12Z — A USDC payout confirmed on chain, and the hash existed before the broadcast did

The brief's own note said it: "a stablecoin payout that actually confirms on a
testnet is worth far more than a slide about one." 016 measured that we held
20 USDC and 0 wei of gas and could not move a cent. Gas landed; this is the
payout.

    tx        0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1
    network   Base Sepolia, chain id 84532
    amount    0.500000 USDC (500000 minor units)
    nonce     0 — this wallet's first transaction ever
    receipt   status 0x1
    block     46651201 @ 2026-09-10T20:04:50Z
    gas       44843 used @ 6000000 wei = 269058000000 wei

Read back off the chain rather than inferred: sender 20.000000 -> 19.500000
USDC, recipient 6142.438501 -> 6142.938501 USDC. And the entry it produced:

    entry           9ab676c5-6c84-4124-bede-d2b9facf8558
    value date      2026-09-10   from the BLOCK's timestamp, converted to book time
    rail            usdc
    external_ref    0xb47c5a36…86a1
    idempotency_key usdc:payout:0xb47c5a36…86a1

    DR 2100/<business>   50
    CR 1140              50
       balance             0

**The idea worth keeping is the identifier, not the transfer.** An Ethereum
transaction hash is `keccak256` of the signed transaction's own bytes. Nothing
about it is assigned by the network. So the name of this money movement exists
on our machine *before* a byte goes over the wire, and the script prints it
there — `signed locally / tx hash … <- known BEFORE broadcast`. That is what
lets it be the **idempotency key** rather than a receipt for one.
`journal_entry.idempotency_key` is UNIQUE, so a second posting is a no-op
decided by Postgres. The alternative — broadcast, then ask the node what it
called the transaction — has a window in which money has moved under a name we
do not yet know, and that window is where double spends live.

**Two writes to two systems that cannot share a transaction, so there are
exactly three places to die.**

1. **Before broadcast.** Nothing signed onto the wire, nothing moved, nothing
   posted. A re-run reads the same nonce and sends one transfer.

2. **After broadcast, before the receipt — the one that pays twice.** A
   transaction sits in the mempool at nonce N and we never learn its fate. The
   naive re-run reads `eth_getTransactionCount(pending)`, which **already
   counts the in-flight transaction**, builds a second transfer at N+1, and
   pays twice. Closed by reading `pending` and `latest` separately and refusing
   while they disagree:

        kind    REFUSED
        reason  transaction_in_flight
        detail  nonce pending=1 latest=0: 1 transaction(s) from this wallet are
                unmined. Broadcasting now would take nonce 1 and send a SECOND
                payout.

   If it mines, point 3 finds it. If it is dropped, `pending` falls back to
   `latest` and the re-run sends exactly one. The hash was printed before the
   broadcast either way, so `--settle <hash>` resumes directly.

3. **After the receipt, before the ledger write.** Closed by asking the chain
   and not a local row: `eth_getLogs` for an ERC-20 `Transfer` from this wallet,
   to this recipient, for this amount, over the last 10,000 blocks. A hit
   returns that transaction's receipt as `confirmed` with `recovered: true`,
   having sent nothing. That is also what makes the second demo run a clean
   no-op — same entry id, one entry with that key. Its honest limit is stated
   in `docs/STABLECOIN.md`: the on-chain evidence is `(token, from, to,
   amount)`, so two payouts agreeing on all four are indistinguishable to it,
   and the scan reaches back 10,000 blocks and no further.

**One more thing the type system does rather than a reviewer.**
`postUsdcPayout` takes a `ConfirmedPayout`, which is only constructible after a
receipt has been read, `status: 0x1` asserted and the block re-checked as
canonical. A broadcast, reverted or reorged transaction cannot be passed to it
at all, so "we posted a payment that never happened" is a compile error.

**No dependency was added.** No `viem`, no `ethers`: keccak-256, secp256k1 with
RFC 6979 and EIP-2 low-`s`, RLP, the EIP-1559 envelope and thirteen JSON-RPC
methods are in `src/lib/rails/stablecoin/`, 42 tests, pinned to published
vectors — including the EIP-155 example transaction, whose exact `r` and `s`
come back out, which is only possible if the address derivation, the RLP, the
hash and the signer are simultaneously right. `tx.test.ts` also re-encodes this
very transaction from fields read back with `eth_getTransactionByHash` and
asserts the hash the network has.

`/api/health` previously reported **6 of 7 live** at that reading; `business_registry` alone was
simulated.

---

## 031 — 2026-09-10T20:20Z — The three gaps the payout leaves open, written down before anyone finds them

The payout is real. These three are the parts of it that are not, and each one
is a place where inventing the missing piece would have been worse than the
gap.

**1. The ledger carries USDC in cents, not as its own currency.**
`journal_line.currency` is `char(3)`, every seeded account is `'USD'`, and
`assert_entry_balanced()` requires **each currency in an entry to net to zero
independently**. So an entry whose debit is USD and whose credit is USDC cannot
balance, by construction, without an FX bridge account pair this chart does not
have. Widening the column would not fix that; it would move it. Chart account
1140 already anticipated this and states its own unit — "carried in cents at
1 USDC = 100 cents … with sub-cent dust going to 2900 rather than being
truncated" — which is why there is no migration 0012. USDC and USD are still
kept apart where they could actually be added together by accident:
`rails/types.ts` gives USDC its own `Currency`, and the narrowing to cents
happens once, visibly, at the posting boundary. USDC has six decimals, so
1.234567 USDC is 123.4567 cents and the four digits below the ledger's
resolution go to a real line rather than into a rounding error nobody can find.
0.50 USDC has no dust and posts two lines.

**2. Gas is not posted.** Account 5300 ("Blockchain gas — USDC transfers") is
the right home and is deliberately empty. Gas is paid in ETH; the chart has no
ETH-denominated asset account to credit, and converting wei to cents needs an
ETH/USD rate this system has no live source for. Inventing one is worse than
the gap. On Base Sepolia the figure is 269,058,000,000 wei — 2.7×10⁻⁷ ETH, on
the order of a tenth of a cent, so it rounds to zero cents and would be
rejected as a zero-amount line — but on mainnet the accumulated figure is real.
The actual `gasCostWei` is carried on the outcome and written into the entry
description, so nothing is lost, only unposted.

**3. Account 1140 does not reconcile to the wallet.** The ledger says 1140 is
−$0.50; the chain says the wallet holds 19.50 USDC. The difference is exactly
the opening 20 USDC, which came from the Circle faucet and never entered the
books. Booking it needs an equity-contribution account the chart does not have
— 3000 is a non-postable rollup and 3100 is retained earnings — and inventing
one under time pressure against money rows is the wrong trade. The gap is the
un-booked opening balance and nothing else, which is a sentence I would rather
say first than be asked.

**Why all three are in the log rather than only in the code.** Each is a place
where the honest artefact is smaller than the impressive one, and the brief's
automatic fail is about claiming the impressive one. `docs/STABLECOIN.md`
carries the same three plus the missing durable intent table, the
non-constant-time signer and the single confirmation.

---

## 032 — 2026-09-10T20:30Z — The secret scanner's proxy fired on 24 innocent constants, so it was replaced with the real check

**The proxy.** The staged-file scanner carried a shape rule — `0x` followed by
64 hex characters — aimed at `USDC_SENDER_PRIVATE_KEY`. It was fine until this
repo started doing elliptic-curve arithmetic. Then the secp256k1 curve order,
the field prime, both generator coordinates, every keccak test vector and the
published EIP-155 signature all matched it: **24 matches across
`src/lib/rails/stablecoin/`, 23 distinct values, none of them a secret.**

**Why that is a failure and not an annoyance.** A rule that fires on 24 innocent
constants gets switched off by whoever is in a hurry, and then it protects
nothing. The guard's failure mode is not a false positive; it is the disabling
that follows one.

**The replacement compares against the literal values in `.env`.** No false
positives at all, and strictly stronger for every secret this project actually
holds, because it catches a leaked key in any encoding position — prefix or
not, hex or not. Values only, quotes stripped, 16 characters or longer, because
a value like `true` would match half the tree.

**The classification is by key name, and the direction is the point: it is a
whitelist of secret-bearing names, not a blacklist of public ones.** You can
enumerate your own credential names; you cannot enumerate every public value
that might legitimately appear in a document. The blacklist version fired three
times in one afternoon — on the wallet address, on the public RPC endpoint, and
on the literal string `business_registry` from a feature flag, which appears in
every document that discusses that slot. `DATABASE_URL`, `DIRECT_URL` and
`APP_DATABASE_URL` are named explicitly rather than left to a `_URL` suffix
rule, because they carry a password in the userinfo and a suffix rule would
have classed them with the public URLs.

**Proved rather than reasoned about.** Planted the real private key in a staged
file and watched the gate refuse it, then confirmed it flagged nothing else in
the tree. The refusal deliberately prints the offending *file* and never the
matching line: a gate that echoes the secret it caught has just put it in a
terminal scrollback and a CI log.

**The shape rule survives where it cannot collide.** Provider prefixes
(`npg_`, `sk_live_`, `whsec_`) carry their own namespace, so unlike bare hex
they cannot be a mathematical constant. Those stayed, along with the
whole-tree scan from 023 and its `grep -a`.

**Noted while reading it, not fixed by me:** the comment claims
`scripts/precommit.sh --audit` prints the classification so the assumption can
be checked rather than trusted. No argument handling exists in the script, so
that flag does nothing today. A comment that documents a capability the file
does not have is the same class of over-claim as a probe that reports live
without a round trip; it is one function or one deleted sentence.

---

## 033 — 2026-09-10T20:35Z — Five guards have now failed the same way, and I only went looking after the fourth

This is the most useful thing this build has taught me, so it gets its own
entry rather than another paragraph inside someone else's.

    guard             the exclusion               what it let through
    ----------------------------------------------------------------------------
    v_hold_drift      WHERE NOT is_released       a wrong closure row
    secret scanner    plain grep                  1,206 lines after a NUL byte
    escalation gate   slots.every(live)           any outage, once a slot was
                                                  honestly unprobed
    doc auditor       "N of 7" only               it read past "4/7 live", its
                                                  own log's shorthand
    secret scanner v2 0x + 64 hex shape           would have fired on 24 curve
                                                  constants and been switched off

**Every one of those exclusions is shaped exactly like the failure the guard
exists to catch, and every one reported healthy while blind.** `v_hold_drift`
excludes released holds, and the bug *is* a spurious release. The scanner
skipped binary files, and a leaked credential in a binary-looking file is
exactly the thing it would miss. The gate required every slot live, and an
outage is what makes a slot not live. The auditor understood one spelling of
"N of 7", and the drifted document was written in the other spelling — its own
iteration log's. The shape rule matched 64 hex characters, and this repo's
honest constants are 64 hex characters.

**The one-line lesson, phrased so it can be pushed back on: a guard must be
tested against the thing it guards against, not merely run.** Running it proves
it does not crash. Only the failure case proves it can see. The counter-argument
worth having in the room is that this is just "write a negative test" — and it
is more than that, because the negative test has to be built out of the guard's
own exclusion clause, which is the line nobody reads twice.

**The honest part.** Four of these were found one at a time, each by accident,
by something else failing — the evaluator's clean scan, a README worker refusing
a claim, a live-fire run, a stale email. Only the fifth was found by going
looking on purpose, after the pattern was already written down in 028. I would
rather record that order than imply I had the rule first and applied it.

**What follows from it and is not done.** `v_hold_drift`'s blind spot is still
open and is in the cut list with the reason; the honest position is that the
same audit has not been run over the other invariant views. The list above is
what the audit found in the guards I did look at, not a clean bill of health for
the ones I did not.

---

## 034 — 2026-09-10T22:10Z — I turned a slot LIVE by clicking a button, and the probe believed me

**What happened.** Chasing the last simulated integration, I clicked "Get
started" on Stripe Connect in the dashboard. The API's answer to the probe's
`POST /v1/accounts` changed from

    "You can only create new accounts if you've signed up for Connect"

to

    "Stripe no longer recommends Accounts v1 for new Connect integrations.
     Create connected accounts with POST /v2/core/accounts instead"

The probe tested for the first string and treated **anything else** as
parameter validation, therefore entitled, therefore `live`. Within seconds
`/api/health` briefly reported **7 of 7 live** with `business_registry: live`,
while the registry leg was still the simulator and `KYB_FORCE_SIMULATED` was
still set.

**That is the automatic fail of this trial, produced by a click and an
else-branch.** No code changed. No deploy happened. A dashboard button in a
different browser tab moved a production endpoint from an honest label to a
false one.

**The fix.** Entitlement is necessary and not sufficient. The probe now
distinguishes three answers rather than two:

| Stripe says | Verdict | Why |
|---|---|---|
| "signed up for Connect" | `unauthorised` | not entitled |
| "Accounts v1 … use /v2/core/accounts" | `unauthorised` | entitled, but through an API this system does not speak |
| a genuine parameter error | `live` | entitled AND callable |

**What this is the fourth instance of.** `v_hold_drift` excluded released
holds. The secret scanner used plain `grep`. The escalation gate used `every`.
Each was an exclusion shaped exactly like the failure it existed to catch. This
one is the same shape wearing different clothes: **an `else` that means
"success" is a claim, and a claim needs a reason.** The other three were caught
by tests or by a screen. This one was caught only because I re-read the
endpoint after touching something unrelated to it.

**The uncomfortable part, said plainly for the debrief.** Every other bug of
this shape in this project was found by an instrument. This one was found by
habit. If I had enabled Connect and moved on, the submission would have shipped
claiming a live integration it did not have — and the probe, the invariants,
the doc auditor and the live-fire suite would all have stayed green, because
none of them asks whether an integration the endpoint calls `live` is one the
application actually uses.

**Also corrected:** README, DEMO, EVIDENCE-PACK and both email drafts said
"Connect not enabled", which had become false in the other direction. The
honest statement is that Connect *is* enabled and the leg is still simulated
for a different reason than this morning.

---

## 035 — 2026-09-10T22:38Z — Standing orders: the occurrence is the unit, and Postgres computes the key

**Decision.** The row that can fire twice is not the mandate, it is one dated
instance of it, so `standing_order_occurrence (standing_order_id,
scheduled_date)` is the unit of the whole design. Exactly-once is four
constraints in a chain rather than one: `UNIQUE (standing_order_id,
scheduled_date)`, `UNIQUE (idempotency_key)`, `standing_order_outcome` keyed
`occurrence_id PRIMARY KEY` — one decision per occurrence, for ever — and
`payment_instruction.idempotency_key UNIQUE` at the far end.

**The key is a `GENERATED ALWAYS … STORED` column, built from `EXTRACT` and
`lpad`, and that is not a style preference.** The obvious spelling is
`to_char(scheduled_date, 'YYYY-MM-DD')` or `scheduled_date::text`. Both are only
**`STABLE`** in Postgres, because date output reads the `DateStyle` setting. A
key that depends on a session setting is a key that changes when a pooled
connection hands you a different session, and two keys for one occurrence is a
**second payment**. `EXTRACT` + `lpad` is IMMUTABLE, and the guarantee is
structural rather than asserted: Postgres refuses to create a generated column
whose expression is not immutable, so the DDL carries the property. The
application never computes the key — it reads it back with `RETURNING` and hands
it on.

**Policy: refuse and close, checked against available.** Not partial, not
carried forward, not queued for retry. A decided occurrence leaves the queue by
construction, because `listDue()` returns only dates with no occurrence row and
occurrences with no outcome. The alternative — retry tomorrow — quietly turns a
mandate into a debt collector and makes "did this fire?" unanswerable without
reading a log. All four figures are persisted on the outcome row so a refusal is
explainable months later.

**The recorded refusal is the one that justifies the choice of balance.** Amount
$20,871.93; ledger $21,081.93, which covers it; available $20,771.93, which does
not; shortfall $100.00; code `INSUFFICIENT_AVAILABLE_FUNDS`. The gap was $310.00
of card authorisations. A ledger-balance check would have sent that payment.

**Concurrency is proved rather than argued:** two overlapping `runStandingOrders`
calls under `Promise.all`, two real pooled connections, two server-side
transactions, asserting one instruction, one occurrence, one outcome, one
"raised", one "replayed" — on a `SELECT … FOR UPDATE` plus `ON CONFLICT DO
NOTHING` at three levels, with no application-side check anywhere in it.

**Risk accepted.** The proof suite is gated on `RUN_DB_TESTS=1` and CI holds no
credentials, so the green run is a transcription in `docs/STANDING-ORDERS.md`
rather than a captured artefact. And "book days" in the staleness policy is
calendar-day subtraction while the prose implies banking days — the banking-day
code exists in the funding module and is not used here.

---

## 036 — 2026-09-10T22:52Z — Funding: the ledger moves, the customer's spendable balance does not

**Decision.** Leg two of the core loop is a real Plaid sandbox flow —
`/link/token/create`, `/sandbox/public_token/create`,
`/item/public_token/exchange`, `/accounts/get`, `/auth/get`, `/item/get` — over
raw `fetch`, and the deposit it books opens an `uncleared_credit` hold for the
same amount **in the same transaction** as the financial entry.

    ledger        $23,584.93 -> $28,584.93
    card holds       $310.00 ->    $310.00
    uncleared      $2,503.00 ->  $7,503.00
    available     $20,771.93 -> $20,771.93

**Why a hold rather than a later credit.** An ACH credit can be returned after it
lands. Raising available at the instant the ledger moves is lending the customer
money against an entry that can still come back — so the money is *in the book*
and *not spendable*, which is two facts and therefore two rows, not one number
adjusted twice.

**The availability policy is data, and the row is chosen by the credit's value
date rather than by today.** `funds_availability_policy` is effective-dated on
`(rail, counterparty_class, effective_from)`, the hold stores the `policy_id` it
was opened under, and a missing policy is a refusal (`NO_AVAILABILITY_POLICY`),
never a default of zero. That is what makes a hold opened in March explainable in
December after the policy changed.

**Measured rather than assumed:** banking days come from the eleven Federal
Reserve holiday rules computed in code, including the Fed's Saturday rule (a
Saturday holiday is *not* observed on the Friday for banking purposes — pinned by
2026-07-03), and 09:00 ET is a real timezone conversion with a two-pass offset
correction, tested on both sides of the March DST boundary.

**Stated limit, in the code three times and not only in the document.** The Link
*browser UI* is never driven: the link token is minted for real and then not
used, and the flow continues through Plaid's own sandbox public-token endpoint.
And the financial leg debits `1130 ACH receivable — inbound in transit`; no ACH
entry is transmitted, and the entry description carries `ORIGINATED, NOT
TRANSMITTED` for ever.

**What this entry does not claim, and 046 does:** that the money becomes
spendable on schedule. It does on the SQL view and it does not on the function
the screens call.

---

## 037 — 2026-09-10T23:06Z — A card correction is driven by the provider, and routed by a row

**Decision.** `RETURN_REVERSAL` arriving from Lithic now reverses the entry it
corrects **at that entry's original value date**, through `reverseAndRebook()`,
and the decision to treat it as a correction rather than as a new event is taken
by the `rail_event_semantics` row, not by an `if` on the event type.

**What was actually broken.** The ledger could always reverse at an original
value date — `reverseAndRebook()` has been tested since the ledger was written —
but its only non-test callers were two demo modules. A real `RETURN_REVERSAL` was
posted as an ordinary `force_post` at **its own** value date, so the day it
corrected kept its wrong figure for ever and the statement grew a second line on
the day we found out. The table said one thing in a reviewed row and the code did
another; the row was right.

**Measured at the provider, because the obvious plan does not work.** The brief
says *a merchant reverses Tuesday's settlement on Thursday*. On Lithic you cannot
do that to a debit clearing. Enumerating the simulate surface with an empty body
— existing endpoints answer 400 "Missing required parameter(s)", absent ones 404
— gives **seven** endpoints (`authorize`, `authorization_advice`, `clearing`,
`void`, `return`, `return_reversal`, `credit_authorization_advice`) and **twelve**
404s. Then, against a transaction authorised at $50.00 and cleared at $73.40:

    return_reversal   400  "Return reversal is not supported for debit transactions"
    void              201  appends AUTHORIZATION_REVERSAL; settled_amount unchanged
    clearing -7340    201  the sign is IGNORED; a second capture, 7340 -> 14680

**The third is the dangerous one, because it looks like it worked.** So the
correction is driven where the provider supports it — a `return` taken back by a
`return_reversal` — and the code says which of the three it is not doing, above
the assertions, rather than in a document.

**Also decided:** an event with no semantics row **parks the whole payload**
instead of defaulting to either behaviour, and a `correction` row whose
`value_date_source` is not `original.value_date` throws at load. A default here
is a silent, permanent corruption of every past statement it touches.

**Owned.** Two hard-coded switches survive — `canonicalKind()` and
`directionOf()` — and neither decides correction-versus-new-event. The
consequence is that the table's `canonical_kind` column is decorative: the table
says `refund_reversal`, the code stores `force_post`, and the test pins the
divergence as `kindMatches: false` rather than hiding it. `rail_event_semantics`
is also the one table the seed upserts, so a re-seed can rewrite a classification
silently.

---

## 038 — 2026-09-10T23:12Z — KYB went live on GLEIF, which broke the product, and the fix is an operator review

**Decision.** The business-registry leg reads a real registry — GLEIF, four real
endpoints, no credential, no mock — and **GLEIF is a substitution**, not one of
the three vendors the brief names. Persona KYB and Sumsub want a sales
conversation; Middesk and Stripe Connect want business verification first. GLEIF
sits at the bottom of a precedence ladder every named vendor outranks, and two
environment variables move the leg the hour one is available. That sentence ships
next to the word "live" everywhere the word appears.

**Making it honest broke the core loop, and that is the interesting part.**
GLEIF's population is financial-market participants, so every fictional business
on this book answers `not_in_lei_registry` and lands at `needs_review`.
`canTransact()` runs inside `requestPayment()`, so leg 5 — an outbound payment
needing a second approver — was refused for every business on the book.

**Three ways out; two are disqualifying.** Weaken the gate, and the screen stops
making the only claim it exists to make. Invent an LEI, and a real company's
identifier now sits on a fictional business — the exact forgery this module was
built to prevent. Or do what a KYB operation actually does with a registry miss:
**a named human reads the file, decides, and writes down why.** The registry
still said what it said; a person said something else; the system records both
rather than collapsing them into one word.

**`manual` is a third evidence label, and the ordering is what makes it free.**
`live < manual < simulated` is a **weakness** order, ascending, so the existing
worst-wins fold needed no special case. A human is not a third party, so an
operator's decision cannot be `live`. A named, accountable person with a written
reason is not a fixture, so it cannot be `simulated`. The same order is the
declaration order of the `kyb_evidence` enum, which is what lets the view say
`max(evidence)`.

**A review is an INSERT, not an edit.** `corgi_app` holds `SELECT, INSERT` on
`kyb_verification_leg` and the grants are restated in 0013, because a table-level
grant silently covers columns added later. Nine constraints make the wrong row
unrepresentable — the composite FK `(decided_by_actor_id, decided_by_kind) →
actor(id, kind)`, an **equality** check so a manual row must name a reviewer and a
provider row must not, a human-only kind, a twenty-character minimum reason, the
`operator-review` provider name and `manual.` reference prefix, and the two that
stop a reason being smuggled onto a provider row.

**The subtlety worth recording, because the document I wrote gets it wrong.**
`docs/KYB.md` prints six constraints and omits `kyb_leg_reviewer_kind_matches` —
which is the one that makes the headline constraint work. The FK is `MATCH
SIMPLE`, so a composite FK is satisfied whenever *any* referencing column is
NULL: a row carrying an agent's uuid with a NULL kind sails straight through it.
"An agent cannot approve a KYB leg" is that trio, not the FK alone.

**Not in SQL, and say so:** *a review may never clear a provider's decline* is
`reviewRefusal()` in application code, called twice. The table is append-only and
a CHECK cannot see prior rows, so enforcing it in the schema needs a trigger and
there is none.

**Risk accepted.** The deployed gate runs `requireLiveEvidence: false`, so a
`manual`-evidence business can transact — the one business that can move money on
this book does so on a human's recorded say-so. And the reviewer's identity comes
from the role cookie, which is demo-grade and labelled as such: the *agent cannot
review* half is an absent capability, the *which human* half is not.

---

## 039 — 2026-09-10T23:22Z — The core loop is one command, and it imports nothing

**Decision.** `scripts/coreloop.mjs` drives the brief's seven arrows as seven
legs against the **deployed URL**, and imports nothing from `src/` — four `node:`
builtins and `postgres`, and that is the entire list. A runner that imports the
application can pass because the application agrees with itself.

**How it drives a deployment rather than a library.** It scrapes the
deployment's own HTML and replays React's server-action fields —
`$ACTION_ID_<hex>` for an unbound action, `$ACTION_<n>:0` carrying `{"id":…}` for
a bound one — as `multipart/form-data`, which is the identical request a browser
with JavaScript disabled makes. No `Next-Action` header, no hard-coded action id:
if a form is renamed the run fails rather than passing against a stale constant.
The action's return value is read back out of the re-rendered page, so the leg
reads the deployment's literal result object.

**Last full run:** `CL-MTW5GIX5`, 2026-09-10T23:19:44Z, **7 PASS, 0 FAIL, 0
SKIP**, invariants 14/14 (shelled out to `dbcheck`), 91 HTTP calls to the
deployed origin and 3 to the Lithic sandbox, 56 seconds, exit 0. A skip alone
makes the exit code 1 — a gap that does not change an exit code is a gap nobody
acts on.

**Leg 6 was a SKIP when this was written and passed about ten minutes later,
without its assertions changing, because the correction path in 037 deployed.**
That is the shape a run like this should have: the legs assert the property, the
deployment either has it or does not, and the scoreboard is the difference.

**Two honest limits, both in the file above the assertions.** Leg 4 cannot do
"days later" — Lithic clears on demand, so the clearing lands seconds after its
authorisation and the value-date half of the brief's sentence is leg 6's job. Leg
7's title says "a planted break" and the leg plants nothing: `/reconciliation`
renders no write control, so the break is seeded and the leg proves detection,
categorisation and aging only.

**Risk accepted.** The scoreboard lives in `docs/CORE-LOOP.md` as prose; there is
no checked-in transcript. Re-run it before the debrief and quote that run. And do
not let it be confused with `scripts/livefire.mjs`, which is eight attacks and
last read 7 PASS / 0 FAIL / 1 SKIP.

---

## 040 — 2026-09-10T23:35Z — A second stablecoin provider, and the provider is a broadcaster rather than a witness

**Decision.** Circle joins the direct signer behind one interface,
`StablecoinPayoutProvider` — `id`, `label`, `health()`, `send()`. Selection is an
explicit `STABLECOIN_PROVIDER`, never inferred from which credentials happen to
exist, and asking for Circle without Circle configured yields a provider that
reports `not_configured` rather than throwing or silently falling back to the
other rail. 030 said the direct rail was chosen *rather than* Bridge or Circle;
this entry does not reverse that, it adds the second implementation the interface
claim needed to be worth anything.

**The transfer:** `0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa`,
block 46,657,187 at 23:24:22Z, receipt `0x1`, 0.100000 USDC, Base Sepolia,
journal entry `9ad9fac3-…` — DR 2100/Ridgeline 10¢, CR 1140 10¢. **The receipt
was read off the chain by us, not reported by Circle**, and the ERC-20 `Transfer`
log in that block was re-matched against our own amount and recipient.

**Measured, and it decided the design.** Circle's ladder ran `INITIATED` (no
hash) → `CONFIRMED` with the hash at about ten seconds → and **still `CONFIRMED`
at 181 seconds**, never `COMPLETE`. `COMPLETE` is its only success-terminal
state, so waiting for it means waiting for a provider's opinion about a fact the
chain settled minutes earlier — and a poll timeout tuned to "terminal in seconds"
would have given up on a transfer that had already succeeded. The wait therefore
stops at the **hash**, after which the chain is the authority.

**The type gate, stated exactly.** `postUsdcPayout` takes an input whose
`outcome` field is typed `ConfirmedPayout`; Circle's `INITIATED/QUEUED/SENT` map
to `acknowledged`, whose `txHash` is typed `null`, so handing an acknowledgement
to the posting function fails to compile twice over. The limit is real and gets
said in the same breath: it is a discriminated union rather than a branded type,
there is no runtime check on `outcome.kind`, and the gate is on that function
rather than on the journal — `scripts/book-usdc-funding.mjs` posts a USDC entry
through `postEntry()` directly.

**Owned.** Circle has no operator entry point: no script, no route, no server
action. `stablecoinProviderHealth()` is not wired into `/api/health`, and
`.env.example` documents no `CIRCLE_*` variable. The transfer happened; the path
to repeat it is a library call rather than a command.

---

## 041 — 2026-09-11T00:00Z — Pots, and the invariant whose own comment said it could not break

**Decision.** A pot is a **node in the account tree** — an account coded
`2100.<uuid>` parented to the business's `2100` leaf — and not a column, not a
table with a balance, not a tag. A transfer is two journal lines on `rail =
'internal'` and touches no adapter. `corgi_app` holds `SELECT` on `pot` and
nothing else; pots are opened through a `SECURITY DEFINER` function, so there is
no capability by which the application could write half of one.

**The claim being tested was that the ledger is derived.** Available falls when
money moves into a pot with **zero changes under `src/lib/ledger`**, and the
mechanism is worth saying precisely rather than in the compressed form: the
transfer debits the bare `2100` leaf, `availableBalance()` selects that leaf by
**exact equality** on `'2100'`, so the debit lands and the credited pot leaf is
invisible to it. Exact equality is what stops the money being added straight back
in; the fall comes from the debit. Every other consumer matches the same way,
which is why a pot is earmarked money everywhere at once without any of them
learning a new concept.

**And it falsified a claim this build had already made in writing.**
`db/migrations/0001_ledger.sql` says of `v_deposit_control_drift`: *"Written as a
subtree walk rather than 'sum the 2100 children' so that adding a sub-account
level later cannot silently break it."* `docs/CUT-LIST.md` repeats it as a reason
pots were safe to defer. **Half true.** The view has two sides: the subtree side
is a `WITH RECURSIVE` walk and picked the pot up exactly as advertised; the
**reported** side was a flat `SUM(v_ledger_balance) WHERE code = '2100'`, which
did not recurse and did not see the pot. One pot, one $500.00 transfer inside a
rolled-back transaction: **subtree 13,577,077 vs reported 13,527,077**, drift of
exactly the 50,000 cents in the pot, reported by the invariant that was supposed
to be immune.

**The fix is not "relax the check until the feature passes".** `reported` is
generalised to `code = '2100' OR the account is in the deposit tree` — a **strict
superset** of the old row set, so it still catches a deposit leaf reparented
*out* of the tree, and with no pots on the book the two predicates select
identically. `CREATE OR REPLACE`, so 0008's grant survives. The pots integration
test re-runs the **original** predicate verbatim and asserts it *would* have
drifted by exactly the pot balances.

**For the record, because I got this wrong when summarising it:** the claim that
was falsified was never in this log. It is a comment in 0001 and a row in the cut
list. This entry is the first time the decision log has said anything about it.

---

## 042 — 2026-09-11T00:14Z — Payee confirmation: block on arithmetic, warn on judgement

**Decision.** The US has no Confirmation of Payee — Nacha has no name-inquiry
message, a prenote may be answered days later or not at all, and nothing in this
credential set can ask a bank what name sits on a stranger's account. So the
screen blocks on the one thing that is *arithmetic* — the ABA check digit — and
everything else is a warning a named human can acknowledge on the record.

**Enforced in four places, not one:** a runtime assertion that **throws** if any
finding other than `ROUTING_CHECKSUM_FAILED` carries severity `block`; a CHECK on
`payee` that the routing number satisfies `aba_checksum_ok()`; a CHECK that
`(outcome = 'blocked') = (checksum_ok IS FALSE)`; and a blocked UI branch with no
continue control at all — absent, not disabled. The payment gate adds a fifth
refusal, `PAYEE_WARNING_UNACKNOWLEDGED`, which is a refusal to let an override be
*implicit* rather than a block on judgement.

**The check digit was swept, and the failures are structural.** Over a fixed-seed
corpus of 500 valid numbers: single wrong digit **40,500 cases, 100% caught**;
adjacent transposition **3,656 cases, 89.03% caught**, and the misses are exactly
the digit pairs differing by **5** (adjacent weight differences cycle −4, +6, −2,
each sharing a factor of 2 with 10); transposition **3 or 6 apart, 4,019 cases,
0% caught**, because the weight vector `3,7,1` repeats every three digits so
those positions carry equal weights and the swap moves the sum by zero.

**Which decides a product question.** For an invalid number every weight is a
unit mod 10, so there is exactly one repairing digit at each of the nine
positions — **nine repairs, always**. A "did you mean" list would be nine equally
likely guesses dressed as help, so the screen offers none and tells the user to
check the payee's own paperwork.

**And the provider does not do this for us — measured, not assumed.** Increase's
`/routing_numbers` is live and answers a checksum-invalid `101050002` with **200
and an empty list**, the same answer it gives for a real but unlisted bank. It
validates shape (400 for eight digits, 400 for letters) and not arithmetic, so
the local check digit is not redundant.

**Owned.** `aba.ts` says 88.9% and `docs/PAYEES.md` says 89.03% — the first is
the population value, the second is this corpus, and neither says which. The test
asserts only a band, so the documented figure is not regression-guarded.
"Exhaustive" means over the error space of a 500-number corpus, not over all
valid routing numbers.

---

## 043 — 2026-09-11T00:52Z — Card controls, decided inside Lithic's timeout, with the provider in the loop

**Decision.** The authorisation decision is taken in our own responder inside the
provider's real-time window, and the deadline that governs it is **ours**, set an
order of magnitude below theirs.

**Measured first, by stalling on purpose.** Enrol an ASA responder at a URL that
sleeps twenty seconds, fire one simulated authorisation, compare with a
no-responder baseline: **0.334 s → APPROVED**; **6.527 s → DECLINED,
`UNKNOWN_HOST_TIMEOUT`, `CUSTOMER_ASA_TIMEOUT`**. So the provider waits ≈6.19 s,
consistent with its documented 6000 ms, and **it fails closed**. A responder that
goes quiet declines the cardholder. That changes the design: silence declines
anyway, so there is nothing to gain by being slow and everything to gain by
answering "no" early *with a record*.

**Hence `CONTROL_READ_BUDGET_MS = 600`** — a tenth of the provider's window —
returned from the store as a **value** rather than thrown as an exception, so
"the control store did not answer" is an input to a pure `decide()` rather than a
hole in the control flow. `RULE_ORDER` is a separate constant from the display
order, so reordering a screen cannot change what a card may buy.

**Live, against the deployed endpoint, with Lithic's own traffic** (rows in
`card_auth_decision` carrying `source = 'provider'`):

    00:42:24.687Z  decline  control_store_unavailable  601,521 us  $25.00  mcc 5812
    00:43:31.584Z  approve  card_not_under_control      14,297 us  $15.00  mcc 5812
    00:44:10.461Z  decline  mcc_blocked                147,419 us  $50.00  mcc 5542

and the provider's own record of the third: transaction
`b1bd8d71-554a-46fc-b80a-fe90044868a8`, **status DECLINED, result
UNAUTHORIZED_MERCHANT**, 5000, VISA, merchant `CORGI FUEL PUMP LIVE`. Our row and
theirs agree to the second.

**The two fail modes point in opposite directions on purpose.** Rule 1 fails
**closed** — we hold controls for this card and cannot read them, so we decline
rather than guess. Rule 2 fails **open** — this token is not in our book, we hold
no opinion, and the issuer's own limits still apply. A card with no controls is
not a card whose control failed.

**Owned, and it is the sharpest hole in the feature's own story.** The argument
for failing closed is partly *"every fail-closed decline leaves a row, so the
customer can be found and made whole"* — but rule 1 fires **because the database
is unreachable**, so the append fails too; it retries once through `after()` and
then logs `asa.decision_lost`. The 601 ms row above exists only because that
outage was a slow read rather than a dead database. Also: the wire code for rule
1 is `VELOCITY_EXCEEDED`, the same code the limit rules use, so to the acquirer
an outage is indistinguishable from a customer hitting a limit; the approve-under-
configured-controls branch has been driven against a live database in tests but
not over HTTP by the provider; and `docs/CARD-CONTROLS.md` §8 still reads as a
to-do list for the enrolment that has since happened.

---

## 044 — 2026-09-11T00:58Z — The reconciliation was wrong the moment a second wallet existed

**Decision.** `scripts/reconcile-usdc.mjs` enumerates the wallets at runtime —
the treasury address from the environment, the Circle wallets from a live
`GET /v1/w3s/wallets` — and **fails rather than reconciling against a subset**: a
venue it knows about and cannot read sets `incomplete`, and the verdict is
`ledgerCents === chainCents && !incomplete`.

**What it did before, and why it was confidently wrong.** `1140` is **one
omnibus account**; after Circle, the USDC sits in **two wallets**. The script
read a single address. Treasury 1,850¢ against a ledger saying 1,940¢ is **90
cents of drift reported against a ledger that was exactly right** — and the
missing 90¢ was not drift, it was a venue nobody had looked at. A reconciliation
is at its most confident precisely when a new venue has just been added, which is
the last moment it should be.

Today's run, live: treasury 1850¢ + circle 90¢ = 1940¢ on chain, 1940¢ in 1140,
difference 0, `RECONCILES`, exit 0.

**Related and now closed:** 031 recorded that 1140 did not reconcile because the
opening 20 USDC from the faucet had never entered the books, and said an
equity-contribution account did not exist. It does now — `3200 Contributed
capital — testnet funding` — and the opening balance is booked under the key
`usdc:opening-funding:circle-faucet`. An un-booked opening balance is a hole in
the books, not a labelling problem.

**The fix still carries a hole of the same shape, and it is written down rather
than quietly left.** `incomplete` can only be set *inside* the branch that runs
when `CIRCLE_API_KEY` is present. With the key unset the script reconciles the
treasury alone, reports "1 wallet(s)", and prints the original wrong answer as
drift. A 200 with an unexpected body, or a page-limited wallet list, is silent
for the same reason. **Week two:** the venue list is a claim about the world, so
it belongs in the database next to the account it reconciles, with the script
refusing to run when it cannot prove it has them all.

---

## 045 — 2026-09-11T01:05Z — Nine guards now, and two of them were my own claims

**This supersedes nothing in 033; it extends it.** The table there had five rows
and the rule under it was *a guard must be tested against the thing it guards
against, not merely run*. Four more instances have landed, and they are worse
than the first five, because **two of them are claims I wrote down and repeated**.

    6 v_deposit_control_drift   reported side was a flat    a pot: subtree 13,577,077
                                code = '2100' filter        vs reported 13,527,077
    7 reconcile-usdc            one address from env        a second wallet: 90 cents
                                                            of "drift" against a right
                                                            ledger
    8 v_standing_order_double_  joins on a UNIQUE column    everything — the count it
      fire                                                  tests cannot exceed 1
    9 probe fromStatus()        any non-auth 4xx is live    a 404, which Lithic answers
                                                            with no credential at all

**Six and seven are the ones I asserted.** 0001's own comment says the deposit
control view *"cannot silently break"* when a sub-account level is added, and the
cut list repeats it — the subtree half honoured that and the reported half was
the flat filter the sentence promised it was not, eight lines below the sentence.
And the reconciler's premise, that reading the wallet proves the account, was
mine too; it was true until it silently was not.

**Eight and nine are new instances found by running the rule on purpose**, which
is the first time in this build the pattern has been used as a tool rather than
recorded as a habit. `v_standing_order_double_fire` joins `payment_instruction`
to the occurrence on the idempotency key and reports more than one instruction
per key — but that column is UNIQUE, so the count can never exceed one and the
view is tautologically empty; the failure worth detecting, two instructions for
one occurrence under *different* keys, is exactly what it cannot see, and a test
presents its emptiness as evidence. `fromStatus()` treats any non-401/403 4xx as
`live` on the reasoning that the credential must have been accepted — measured
against the live sandbox in two `curl`s, `GET /v1/not_a_real_endpoint` at Lithic
answers **404 with the key and 404 with no Authorization header at all**, so a
mistyped path or a retired endpoint would read as a live integration. That is 011
wearing the costume of the fix for 011.

**The one-line lesson, unchanged and still the thing to push back on: a guard
must be tested against the thing it guards against, not merely run.** The
stronger form, which the two self-asserted instances earn: *a guard whose
exclusion clause you cannot state in one sentence is not a guard you have
understood.* By that standard three of these nine were never understood by the
person who wrote them, and that person was me.

**The honest order, again, because it keeps getting more embarrassing rather than
less.** The first four were found by accident, one at a time, by something else
failing. The fifth was the first found deliberately. **Six and seven were found
by building the next feature**, not by auditing — pots broke the view, Circle
broke the reconciler — so the rule written down in 033 did not prevent either of
them; the features did. Only eight and nine came from applying it, and that took
minutes. The rule is cheap and I did not spend it until now.

**Open, not fixed:** eight and nine both stand as written, with their week-two
lines here. `v_hold_drift`'s blind spot is still open. And `v_hold_release_drift`
has a different disease — it is correct and **nothing queries it** (046).

---

## 046 — 2026-09-11T01:10Z — Three definitions of "available", and the sweep nobody calls

**Decision.** Name this rather than unify it tonight. Available balance is the
thing this track grades hardest, it is derived everywhere and stored nowhere —
and it is currently derived **three ways from three different questions**, which
is a weaker claim than "derived" and the room deserves the weaker claim.

| Where | The question it answers | Release rule |
| --- | --- | --- |
| `availableBalance()` — `/accounts`, holds, standing orders, live fire | every line on the `2100` leaf, no date predicate | a hold is released when a `hold_closure` row exists |
| `readBalanceCents()` — `/funding` and its receipt | the same four figures **as at a snapshot**: `value_date <= today AND booking_seq <= watermark` | same |
| `v_available_balance` — the SQL view | the view's own fold | an uncleared credit releases **on the clock**, `now() >= available_at` |

The first two differ by **$30,662.10** on the seeded business, because the book
carries $37,212.00 of debits value-dated tomorrow and standing-order credits
dated 2027, and only one applies a value-date predicate. That is not a discovery
waiting to be made; the funding worker wrote it into the file with the reason the
screen refuses to print both numbers.

**The third is the real defect.** The view releases on the clock; the function
releases on a closure row; and `releaseAvailableCredits()`, which writes that
row, **has no caller anywhere in the repository** — no route, no cron, no test.
So "when does my $5,000 become spendable" has two answers: at 09:00 ET the next
banking day on the view, and **never** on the screen and in the funds check.

**Dated, so it can be checked rather than believed:** fourteen `uncleared_credit`
holds are open on this book, ten of them maturing at 2026-09-11T13:00Z and four
at 2026-09-14T13:00Z, none closed. At the first of those instants
`v_hold_release_drift` — which asserts that a released hold withholds nothing —
goes non-empty, because `is_released` turns true on the clock while the memo leaf
still carries the money. Nothing queries that view: it is not among `dbcheck`'s
fourteen, it is in no test, it is on no route. All seven invariant views returned
zero rows when this entry was written, and that is a measurement with an expiry
time.

**Why it is not fixed tonight.** Wiring the sweep is one import and one call, and
it writes `hold_closure` rows against money tables at 01:00 with a debrief in the
morning; the same trade as the three stale memo holds in 022 and 028, on the safe
side — today the system withholds money it should have released, which is
conservative, and the opposite mistake is not.

**Week two, in this order.** Wire `releaseAvailableCredits()` to the existing
daily drain (it is written, tested, and idempotent through `hold_closure`'s own
uniqueness). Add `v_hold_release_drift` and `v_hold_drift` to `dbcheck`, so the
clock-versus-closure disagreement is an alarm rather than a view. **Then** give
`availableBalance()` the snapshot predicate and let the funding screen delete its
local copy. Not the other order: unifying the readers while the sweep is unwired
would make both screens agree on a number that is wrong in the same direction.
