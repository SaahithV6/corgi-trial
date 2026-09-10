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
  KYB / KYC           Persona sandbox             LIVE  (see question 1)
  Open banking        Plaid sandbox               LIVE
  ACH rail            Increase sandbox            LIVE if self-serve, else a
                                                  labelled simulator behind the
                                                  same rail adapter
  Stablecoin          USDC on Base Sepolia,       LIVE
                      direct via viem

That is three live slots against a minimum of two, plus a testnet USDC payout
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

1. KYB self-serve. Persona's sandbox is the plan for business plus director
   verification. If their KYB templates turn out to be gated behind a sales
   conversation, my fallback is director KYC live through Persona or Stripe
   Identity, with the business-registry check behind the same interface as a
   clearly labelled simulator. Does that still satisfy the must-be-live
   requirement on that slot, or would you rather I move the live slot
   somewhere else and label KYB simulated in full? Proceeding on the fallback
   until I hear otherwise.

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

Saahith Veeramaneni
