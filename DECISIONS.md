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
