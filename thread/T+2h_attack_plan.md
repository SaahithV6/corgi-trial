Subject: Work trial: Saahith Veeramaneni, Track 3

Track 3, neobank. T0 17:13 PDT 9 Sep, freeze 17:13 PDT 11 Sep.

THE THREE USE CASES I OWN END TO END

1. The hold, from authorisation to settlement.
   Issue a sandbox card, authorise $50 at a fuel pump, clear $73.40 two days
   later. Available balance drops on the auth; ledger balance does not move
   until the clearing posts. The hold releases exactly once regardless of the
   order the events arrive in, including the settlement that lands before its
   own authorisation. Partial capture, multiple capture, over-capture, expiry
   and reversal are all transitions on the same state machine rather than
   special cases.

2. Money out, with a second human on it.
   An outbound ACH payment above threshold enters an approval queue. The
   initiator cannot approve it and neither can the agent surface — the MCP
   write tool lands in the same queue as a person. The payment settles late,
   then returns days after that, and the returned position appears on the day
   it happened rather than the day we heard about it.

3. The correction, and finding the break.
   Thursday reverses Tuesday's settlement. Tuesday's statement shows the
   corrected position, and the system can still prove what it believed on
   Wednesday. Value date and booking date are separate columns from the first
   migration. The nightly scheme file reconciles against the ledger and a
   breaks screen shows in-file-not-ledger, in-ledger-not-file and amount
   mismatch, with aging.

PROVIDER PICKS

  Card issuing        Lithic sandbox              LIVE
  Director KYC        Persona sandbox             LIVE
  Business registry   Stripe Connect test mode    LIVE  (see question 1)
  Open banking        Plaid sandbox               LIVE
  ACH rail            Increase sandbox            LIVE if self-serve, else a
                                                  labelled simulator behind the
                                                  same rail adapter
  Stablecoin          USDC on Base Sepolia,       LIVE
                      direct via viem

That is four live slots against a minimum of two, plus a testnet USDC payout
that confirms on chain. Every rail — ACH, card, USDC — sits behind one adapter
interface, because a rail is an adapter and not a schema. Everything is
labelled live or simulated in the README and I will not blur that line.

Stack: TypeScript, Next.js on Vercel, Postgres on Neon. USD in integer cents
throughout, no floats anywhere near money. Rounding is banker's rounding with
the residual penny assigned deterministically to the earliest line by id, and
it is written down.

CUT LIST v0

Not building: the mobile app (responsive web instead), standing orders, the
public API, sub-accounts and pots, disputes with provisional credit, wires,
interest and fee accrual, card controls in the real-time auth decision webhook.

Week two, in order: card controls inside the provider's auth timeout, since
that is the only one that has to be real-time and therefore the only one whose
design I would want to prove early; then standing orders with exactly-once
firing across restarts; then disputes.

If the core is standing early I will take card controls off this list rather
than adding polish.

QUESTIONS

1. KYB, and what I found rather than what I assumed. Persona's business
   verification is gated: their KYB-via-API guide's first step is to contact
   their team for a transaction_type_id, and Business Verification is listed
   Not Available on every self-serve tier. Rather than label the slot
   simulated, I am splitting it. Persona sandbox does director KYC live, and
   its perform-simulate-actions endpoint drives an inquiry to pending,
   declined and needs_review while firing the real webhooks for each — so the
   non-happy-path states you asked for are genuinely third-party rather than
   rows I flipped. Stripe Connect test mode does the business-registry leg
   live, with published magic EINs that force company-not-found and
   pending-response-from-registry. A composite provider takes the stricter of
   the two statuses and degrades its own evidence label to "simulated" if
   either leg was, so the system cannot structurally claim third-party
   verification over manufactured evidence. Does splitting the slot across two
   live providers read as one satisfied integration to you, or two? I am
   proceeding either way; it changes the README labelling, not the build.

2. Uncleared credits and available balance. The brief says available equals
   ledger minus active holds "plus rules you must decide about uncleared
   credits". My default is that an inbound ACH credit is not available until
   the return window has passed, because the alternative is lending money
   against a payment that can still come back. That is conservative and it
   will annoy customers. Where does Corgi actually sit on that trade, and does
   the answer change by counterparty or by account age?

3. A business question rather than a spec question. Corgi is a full-stack
   carrier structured as a risk retention group, and an RRG under the LRRA can
   only write liability. Everything on the current product list is liability
   and consistent with that, but the roadmap here is banking. A neobank
   deposit product is not something an RRG can hold, so the banking leg needs
   a sponsor bank and the insurance leg stays inside the RRG. Is the intended
   shape one holding company over two separately regulated entities sharing
   this ledger, and if so, is the ledger meant to be the shared spine across
   both — which is the reading that would change how I model the account
   hierarchy this weekend?

4. Lithic cannot originate a force post, and I would rather say so now than
   have it come up in the debrief. I enumerated every simulate path in their
   OpenAPI spec: there is no force-post endpoint, and /simulate/clearing
   requires a parent authorisation token, so it cannot produce an unmatched
   clearing. What I am building instead: the matcher does not require an
   authorisation to exist, so an unmatched clearing posts and opens a
   reconciliation break; FINANCIAL_AUTHORIZATION exercises the same
   no-hold-to-release path; and the scheme file simulator ships genuine
   unmatched clearings. If you know a way to originate a real one in their
   sandbox, I would rather hear it than ship the substitute.

One thing already measured rather than assumed, since it shaped the schema.
Lithic's transaction status flips to SETTLED while a partial hold is still
outstanding — a 1000 authorisation cleared for 600 reports SETTLED with 400
still held — and amounts.hold.amount is signed negative. Releasing a hold on
status == SETTLED, which is the obvious implementation, frees money that is
still authorised. So the hold is computed as a pure function of the event set,
max(authorised - cleared, 0), which reproduces their arithmetic in every case I
measured including over-capture, and agrees with the network precisely where
their status field does not.

Saahith Veeramaneni
