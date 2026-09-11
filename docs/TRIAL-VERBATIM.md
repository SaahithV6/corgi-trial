# Corgi Work Trial — The Build — VERBATIM SOURCE OF TRUTH

Reproduced word for word so nothing is interpreted. **Do not edit, summarise,
reformat or "tidy" this file.** `docs/TRIAL.md` is a restructured reading of the
same page and is subordinate to this one; `docs/BRIEF.md` is the Track 3 page,
also verbatim. Where any of them disagree, THIS FILE WINS.

Source: https://app.notion.com/p/Corgi-Work-Trial-The-Build-e911308204478388a1528110d02a1b2d

> NOTE ON COMPLETENESS: the portal page at https://hiring.corgi.com/portal/work-trial
> is NOT reproduced here, because its text is no longer available in this session
> verbatim. Everything below is the Build page as supplied. If the portal page
> matters, paste it and it goes in this file unaltered.

---

Scoring (out of 100)
Domain command (30): the vertical's mechanics live in your schema and state machines, not your README.
A system that runs (25): deployed, stable through the demo, core loop working end to end.
Integration reality (20): two or more genuinely live sandbox integrations, honest labelling.
Live fire (15): the system survives our scripted attacks. Diagnose in front of us instead of defending.
Judgment and communication (10): questions asked early, assumptions written down, a credible cut list.
Important:
Automatic fails

Localhost only, or a video in place of a URL.
A simulated integration presented as live.
UPDATE or DELETE on money rows. Anywhere. Ever.
Live-mode API keys, real money, or real personal data.
Secrets committed to the repo.
Code you cannot explain line by line when we point at it.
Note:
The unwritten test

Every person we have hired did something that was not on that page. The brief is the floor, not the ceiling. We are deliberately not telling you what impresses us. Surprise us.

---

Corgi Work Trial: The Build
We're Members of Technical Staff, and this is the work trial.
Corgi builds US financial products, so everything in this trial is US-flavored: US dollars, US rails, US rules. One continuous 48-hour build against real sandbox infrastructure: real KYC, real payment rails, real webhooks, real reconciliation. The thinking has to exist too, and it shows up in a running decision log and a live-fire debrief.

What this is
Two days. One task, picked from three. At the end there is a URL we can open, money that moved on real (sandbox) rails, and a ledger that survives us attacking it while you watch.
What we need to know is whether you can walk into a domain you have never worked in, whether insurance, investing or banking, and come out 48 hours later with working software that respects how that domain actually behaves. That is the job. This trial is the job, compressed.
The briefs are incomplete on purpose. The scope is bigger than the time on purpose. Nobody finishes. We are reading what you chose to build first, what you got right that the brief never mentioned, and how your system behaves when we try to break it.

What Corgi is building
Corgi is building the financial stack for American businesses, starting with commercial insurance, which is live today: instantly-quoted and brokered coverage sold through partners, run end to end on our own policy-administration platform. Underneath it sits exactly the machinery this trial is about: append-only ledgers, rating and pricing, document generation, payment rails, reconciliation.
Banking and investing are where the roadmap points, which is why the three tracks are what they are. Track 1 is the product we run today. Tracks 2 and 3 are the products we intend to run. Whichever you pick, this is not a puzzle. It is a compressed version of the job itself, in the domain you would actually work in.
So understand what we are building before you build. Read about the vertical, ask us about the business on the question thread (that is graded up, not down), and come to the debrief with a point of view. Nothing lands better than a candidate who understood the business well enough to disagree with the brief.

The format
You pick one track and a contiguous 48-hour window inside the week we offer. The clock starts when we send the kickoff message and your sandbox rules. Checkpoints are relative to your start.

When | What we expect | What we are reading
T0: kickoff | You confirm your track. We send the brief, the question channel, and the sandbox rules. | Nothing yet. Breathe.
T+2h: attack plan | One page: the three use cases you will own end to end, your provider picks, and cut list v0. | Decisiveness, not correctness. Plans change; indecision does not.
T+24h: money moves | A deployed URL where money already moves end to end through at least one live sandbox rail, however ugly. | Whether you build outside-in against reality or save integration for the end. If you miss it, one honest paragraph about why is recoverable. Silence is not.
T+48h: freeze | The full submission package (below). Commits after freeze are ignored. | Everything.
Within 2 working days: live fire | A 75-minute debrief. You demo for ten minutes, then we drive: we replay webhooks, backdate corrections, reverse settlements, and pull one of your providers out from under you. | Whether the system degrades gracefully, and whether you do.

The ten non-negotiables
These apply to every track. Each track page adds its own domain-specific requirements on top.
It is deployed. A URL we can open, with demo credentials for at least two roles. Localhost is a no. A video instead of a URL is a no. Free tiers are fine.
You wrote the ledger. Double-entry, append-only, immutable. Your payment provider's balance is their ledger, not yours. Every external money event lands in your ledger as a journal entry, and every balance on every screen is derivable from those entries, including as it stood on any past date.
At least two integrations are genuinely live. Real third-party sandboxes, real API calls, real webhooks received by your deployed system. The rest may be high-fidelity simulators. See Real versus simulated below.
Webhooks are done properly. Signatures verified. Consumers idempotent: we will replay events, twice is one. Out-of-order delivery tolerated. Polling is a fallback strategy, not the design.
The correction test. Each track has a specific backdated-correction scenario, listed on its page. It is executed live in the debrief. Corrections are reversal entries plus a re-book, never an edit. The statement shows the corrected figure and still reconciles.
Approvals above a threshold. Maker-checker on the track's money-out path. The initiator can never approve their own action. Neither can an agent.
Reconciliation is a feature, not a chore. A job that pulls provider truth (API or file) and diffs it against your ledger, plus a screen that shows the breaks. We will plant a break and watch it surface.
An agent surface, implemented. A working MCP surface, not a design for one. Minimum: three read tools and one write tool that lands in the human approval queue. Plus a written list of operations you would never hand an autonomous agent, and why.
Money is never a float. Integer minor units or exact decimals. State your currency handling and your rounding rule. Pro-rata maths always leaves a penny, and someone has to eat it deterministically.
A decision log written as you go. Timestamped entries in the repo: what you decided, what you assumed when our answer was too slow, what you cut. A single hour-47 commit titled "add decision log" defeats the purpose and we will read the git history.

Real versus simulated
Some excellent providers gate their sandboxes behind business verification you cannot pass in a weekend. So the rule is:
At least two integration slots must be live against a real third-party sandbox, end to end, from your deployed system.
Any other slot may be a simulator you build behind the same interface. A fake custodian that ships files, a fake scheme that sends settlement webhooks. A good simulator that generates the awkward cases (partial captures, late dividends, reversed settlements) is worth real credit.
Every slot is labelled honestly in your README: live or simulated. Presenting a mock as a live integration is the fastest way to fail the entire trial.

The provider menu
All of these have free, self-serve sandbox or test modes as of mid-2026. They are suggestions, not requirements: any equivalent is fine, though the menu is deliberately US-first, because Corgi is. Spend $0: if a provider wants a card or a company you do not have, use their prefab test entities or simulate and label it.

Slot | Suggested providers | Notes
KYC: identity | Persona, Sumsub, Stripe Identity, Onfido | Use the provider's published test identities. Never feed real PII, yours or anyone's, into a trial system.
KYB: business | Middesk, Persona KYB, Sumsub KYB | Gate the account: unverified entities can look but not transact.
Payments: cards and collection | Stripe test mode, GoCardless sandbox (direct debit) | Test cards, test clocks, webhook replay from the dashboard: use all of it.
Payment rails: ACH, transfers | Increase sandbox, Moov test mode, Modern Treasury sandbox | All simulate returns and delayed settlement. Returns are the interesting part.
Open banking | Plaid sandbox, TrueLayer sandbox, GoCardless bank account data | Plaid's sandbox test users are the fastest path to a linked funding account.
Card issuing | Lithic sandbox, Stripe Issuing test mode, Marqeta sandbox | Both Lithic and Stripe let you simulate an authorization, then capture a different amount later. That asymmetry is the whole point of Track 3.
Brokerage and market data | Alpaca paper trading + Broker API sandbox; Polygon or Twelve Data free tiers | Alpaca gives you accounts, orders, fills and positions with no money at risk.
Stablecoins | Circle sandbox (USDC on testnet), Bridge sandbox | Testnet only: Base Sepolia or equivalent. A stablecoin payout that actually confirms on a testnet is worth far more than a slide about one.
Documents and e-sign | Documenso (open source), Dropbox Sign test mode, DocuSign developer | Documents must be generated from data, never hand-typed.

Scoring
Out of 100. We share this deliberately: knowing exactly how you are graded and still choosing what to sacrifice is the skill being tested.

Area | Points | What earns them
Domain command | 30 | The vertical's mechanics live in your schema and your state machines, not your README. The track's domain gauntlet handled correctly. Vocabulary used precisely under questioning.
A system that runs | 25 | Deployed, stable through the demo, core loop working end to end. The three screens that matter show default, loading, empty, error and one edge state.
Integration reality | 20 | Two or more genuinely live sandbox integrations. Verified signatures, idempotent consumers, graceful degradation when a provider is down. Honest real-versus-simulated labelling.
Live fire | 15 | The system survives our scripted attacks. When something breaks, you diagnose it in front of us instead of defending it.
Judgment and communication | 10 | Questions asked early and well. Assumptions written down. A credible cut list. A decision log a stranger can follow.

Automatic fails, regardless of everything else:
Localhost only, or a video in place of a URL.
A simulated integration presented as live.
UPDATE or DELETE on money rows. Anywhere. Ever.
Live-mode API keys, real money, or real personal data.
Secrets committed to the repo.
Code you cannot explain line by line when we point at it.

The unwritten test
Every person we have hired did something that was not on this page. The brief is the floor, not the ceiling. We notice the second rail nobody asked for, the reconciliation view that anticipates the question, the stablecoin payout that actually confirms on testnet at 2am. We are deliberately not telling you what impresses us. Surprise us.

Logistics
Questions
To engineering-trial@corgi.com. Reach out whenever you need us. One email thread per candidate: your questions, checkpoints and final submission all live on it. The briefs are incomplete in places on purpose. What you ask is graded alongside what you build, and good questions about the domain are a strong signal, so ask early and often. Never wait on an answer: write the assumption in your decision log and keep going.

Rules
Buy, don't build. Stripe, Plaid, Persona, Lithic, Alpaca: third-party providers are not just allowed, they are the point. Rebuilding what you could have integrated is a scoping mistake, not a flex.
Build American. We ship US products. One currency: USD, in cents. US rails: ACH, cards, wires, USD stablecoins. US conventions: state-regulated insurance, T+1 settlement, US tax lots. If your instinct says IBAN and SEPA, translate it to routing numbers and ACH. Multi-currency is explicitly out of scope; spend those hours on correctness instead.
Any language, any stack, any tools, AI very much included. We use it heavily and expect you to. The bar does not move: you own every line in the debrief.
The 48 hours run on the honour system, and we read commit timestamps.
Spend nothing. Every provider on the menu has a free sandbox. Live keys or real money end the trial.
Your work stays yours. Corgi will not use it.

The submission package
The deployed URL, with demo credentials for two roles.
Repo access: invite @AlexanderReinicke and @mojafa on GitHub.
The decision log, in the repo, timestamped.
A five-minute video walking the money path end to end. This is insurance against demo-day gremlins, not a substitute for the URL.
Evidence of the live integrations: read-only sandbox dashboard access, or screenshots including the webhook delivery log.
A seed script that stands up believable demo data from zero.
An .env.example documenting every key the system needs.
The cut list: what you decided not to build, and what you would build in week two.

How to submit
One email to engineering-trial@corgi.com at freeze, on the same thread as your kickoff, subject Work trial: your name, track number. It needs exactly four things:
The deployed URL, with demo credentials for both roles in the email body.
The repo link: private on GitHub with @AlexanderReinicke and @mojafa invited, or public if you prefer.
The video link: Loom or unlisted YouTube, five minutes or less.
The evidence pack for your live integrations: a shared folder of screenshots, or read-only sandbox dashboard access.
Everything else on the package list (decision log, seed script, .env.example, cut list) lives in the repo, not the email. Checkpoints work the same way: the T+2h attack plan and the T+24h money-moves link go to the same thread, and the clock reads the email timestamp, not the commit.

The tracks
Pick one. Spend the whole 48 hours on it. Each page carries the brief, the required integrations, the domain gauntlet we will grade against, the live-fire scenarios we will run in your debrief, and a stretch ladder for when the core is standing.
