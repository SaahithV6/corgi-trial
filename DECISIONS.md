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
