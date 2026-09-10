# Corgi Work Trial — The Build page, VERBATIM

Companion to `docs/BRIEF.md` (Track 3, verbatim). Saved because the evaluation
loop was scoring against a remembered summary and two requirements went
missing. Do not edit. Score against it.

---

## Scoring (out of 100)

| Area | Points | What earns them |
| --- | --- | --- |
| Domain command | 30 | The vertical's mechanics live in your schema and your state machines, not your README. The track's domain gauntlet handled correctly. Vocabulary used precisely under questioning. |
| A system that runs | 25 | Deployed, stable through the demo, core loop working end to end. The three screens that matter show default, loading, empty, error and one edge state. |
| Integration reality | 20 | Two or more genuinely live sandbox integrations. Verified signatures, idempotent consumers, graceful degradation when a provider is down. Honest real-versus-simulated labelling. |
| Live fire | 15 | The system survives our scripted attacks. When something breaks, you diagnose it in front of us instead of defending it. |
| Judgment and communication | 10 | Questions asked early and well. Assumptions written down. A credible cut list. A decision log a stranger can follow. |

## Automatic fails, regardless of everything else

- Localhost only, or a video in place of a URL.
- A simulated integration presented as live.
- UPDATE or DELETE on money rows. Anywhere. Ever.
- Live-mode API keys, real money, or real personal data.
- Secrets committed to the repo.
- Code you cannot explain line by line when we point at it.

## The unwritten test

> Every person we have hired did something that was not on this page. The brief
> is the floor, not the ceiling. We notice the second rail nobody asked for, the
> reconciliation view that anticipates the question, the stablecoin payout that
> actually confirms on testnet at 2am. We are deliberately not telling you what
> impresses us. Surprise us.

## The ten non-negotiables

1. **It is deployed.** A URL we can open, with demo credentials for at least two
   roles. Localhost is a no. A video instead of a URL is a no. Free tiers fine.
2. **You wrote the ledger.** Double-entry, append-only, immutable. Your payment
   provider's balance is their ledger, not yours. Every external money event
   lands in your ledger as a journal entry, and every balance on every screen is
   derivable from those entries, including as it stood on any past date.
3. **At least two integrations are genuinely live.** Real third-party sandboxes,
   real API calls, real webhooks received by your deployed system.
4. **Webhooks are done properly.** Signatures verified. Consumers idempotent: we
   will replay events, twice is one. Out-of-order delivery tolerated. Polling is
   a fallback strategy, not the design.
5. **The correction test.** Corrections are reversal entries plus a re-book,
   never an edit. The statement shows the corrected figure and still reconciles.
6. **Approvals above a threshold.** Maker-checker on the money-out path. The
   initiator can never approve their own action. Neither can an agent.
7. **Reconciliation is a feature, not a chore.** A job that pulls provider truth
   and diffs it against your ledger, plus a screen that shows the breaks.
8. **An agent surface, implemented.** A working MCP surface. Minimum three read
   tools and one write tool that lands in the human approval queue. Plus a
   written list of operations you would never hand an autonomous agent, and why.
9. **Money is never a float.** Integer minor units or exact decimals. State your
   currency handling and your rounding rule.
10. **A decision log written as you go.** Timestamped entries in the repo. A
    single hour-47 commit titled "add decision log" defeats the purpose and we
    will read the git history.

## Real versus simulated

> At least two integration slots must be live against a real third-party
> sandbox, end to end, from your deployed system. Any other slot may be a
> simulator you build behind the same interface. A good simulator that generates
> the awkward cases (partial captures, late dividends, reversed settlements) is
> worth real credit. Every slot is labelled honestly in your README: live or
> simulated. **Presenting a mock as a live integration is the fastest way to
> fail the entire trial.**

## The submission package

1. The deployed URL, with demo credentials for two roles.
2. Repo access: invite @AlexanderReinicke and @mojafa on GitHub.
3. The decision log, in the repo, timestamped.
4. A five-minute video walking the money path end to end.
5. Evidence of the live integrations: read-only sandbox dashboard access, or
   screenshots including the webhook delivery log.
6. A seed script that stands up believable demo data from zero.
7. An `.env.example` documenting every key the system needs.
8. The cut list: what you decided not to build, and what you would build in
   week two.

## How to submit

> One email to engineering-trial@corgi.com at freeze, on the same thread as your
> kickoff, subject **Work trial: your name, track number**. It needs exactly
> four things:
>
> 1. The deployed URL, with demo credentials for both roles in the email body.
> 2. The repo link.
> 3. The video link: Loom or unlisted YouTube, five minutes or less.
> 4. The evidence pack for your live integrations.
>
> Everything else on the package list (decision log, seed script, .env.example,
> cut list) lives in the repo, not the email.

## Rules

- **Buy, don't build.** Rebuilding what you could have integrated is a scoping
  mistake, not a flex.
- **Build American.** USD in cents. ACH, cards, wires, USD stablecoins. If your
  instinct says IBAN and SEPA, translate it to routing numbers and ACH.
  Multi-currency is explicitly out of scope.
- Any language, any stack, AI included. **You own every line in the debrief.**
- Spend nothing. Live keys or real money end the trial.

## Live fire, what happens

> A 75-minute debrief. You demo for ten minutes, then we drive: we replay
> webhooks, backdate corrections, reverse settlements, and pull one of your
> providers out from under you. Whether the system degrades gracefully, and
> whether you do.

## What they grade hardest on Track 3

> The hold model under hostile sequencing, the bitemporal correction, and
> whether available balance is derived truth or a stored lie.
