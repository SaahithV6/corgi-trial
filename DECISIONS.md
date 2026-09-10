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
