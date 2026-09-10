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
