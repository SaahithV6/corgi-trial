# Track 3 — Neobank — THE BRIEF, VERBATIM

This file exists because the evaluation loop was scoring against a *summary* of
the brief held in conversation rather than against the brief itself, and a
summary is exactly where a requirement goes missing. Two did: KYB/KYC is marked
**Must be live**, and "fund it from a linked external bank" is leg two of the
published core loop. Neither was being scored.

Everything below is the brief as received. Do not edit it. Score against it.

---

Business current accounts. Balances, payments in and out, a card for every
person on the team, and the holds that sit in between while everyone waits to
find out what the real number is.

## The brief, as we received it

> Business current accounts. Customers hold a balance, send and receive
> payments, and get a card for each person on the team.
>
> A card authorisation puts a hold on funds before any money actually moves.
> The amount that finally settles can be different from the amount authorised,
> and it can arrive days later. Tips and fuel pumps do this constantly.
>
> The ledger is append only and immutable. We are regulated and history is
> never rewritten. When a merchant reverses a settlement or a payment is
> recalled, the customer's balance and their statement must both show the
> corrected position for the day it happened.
>
> Businesses pass a check before the account opens. Cards come from an issuer
> processor, payments ride real rails, and customers fund the account from an
> external bank they link themselves. We will not build card processing,
> identity checks or bank linking — use providers.
>
> Users need to see their balance. Users need to approve payments above a
> threshold. Users need to reconcile the scheme file.
>
> We want to be live in six weeks. In scope for v1: onboarding and identity
> checks, accounts and balances, inbound and outbound payments, card
> authorisation and settlement, holds, standing orders, statements, a mobile
> app, an admin console, and a public API.

## What you are actually building

The core loop, working end to end on a deployed URL:

**open an account behind a real KYB check → fund it from a linked external bank
→ issue a real (sandbox) card → authorise, then settle for a different amount
days later → send an outbound payment that needs a second approver → survive a
reversed settlement → reconcile the scheme file.**

This is a US business account: ACH with its return codes, card networks, wires
if you are ambitious, and USDC for the cross-border leg. The ledger is USD, in
cents, even when the rail is a stablecoin.

## Required integrations

| Slot | Requirement | Suggested sandbox | Live or simulated |
| --- | --- | --- | --- |
| Card issuing | Real sandbox cards. Simulate an authorisation, then capture a different amount later — both Lithic and Stripe Issuing support exactly this. This is the heart of the track. | Lithic sandbox, Stripe Issuing test mode, Marqeta | **Must be live** |
| KYB / KYC | The business and its directors pass before the account activates. Pending and rejected states shown. | Persona KYB, Middesk, Sumsub | **Must be live** |
| Payment rails | Outbound and inbound transfers with delayed settlement and returns. Returns are where the design shows. | Increase, Moov, Modern Treasury sandboxes | Live or simulated |
| Open banking funding | Link an external account and fund the balance from it. | Plaid sandbox | Live or simulated |
| Stablecoin rail | First-class here, not a stretch: a cross-border payout over USDC on a testnet, ledgered exactly like any other rail — a rail is an adapter, not a schema. | Bridge sandbox, Circle sandbox — testnet only | Live strongly preferred |

## The domain gauntlet

1. **Ledger balance versus available balance.** Available = ledger minus active
   holds, plus rules you must decide about uncleared credits. It is derived and
   provable from events — never a second stored number that drifts and gets
   "fixed" by a cron job.
2. **The authorisation lifecycle.** Auth, incremental auth, partial capture,
   multiple captures, over-capture — tips and fuel pumps — expiry, reversal.
   Every transition is an event. The hold releases exactly once, no matter how
   strangely the sequence arrives.
3. **Settlement is not authorisation.** Different amount, days later,
   occasionally with no auth at all — the force post. Your model accepts all
   three without special-casing its way into a corner.
4. **Out-of-order delivery.** The settlement webhook can arrive before the auth
   it belongs to. Park it, match it later, never crash, never double-count.
5. **Returns and recalls.** An outbound payment bounces days after it left; an
   inbound payment is recalled. The corrected position appears on the day it
   happened.
6. **Bitemporality — the correction test.** A merchant reverses Tuesday's
   settlement on Thursday. Tuesday's statement now shows the corrected
   position, and the system can still prove what it believed on Wednesday and
   when it learned the truth. Value date and booking date are different
   columns. We run this live.
7. **Statements.** A closed day's statement is reproducible forever,
   corrections included, identical every time.
8. **Standing orders.** Scheduled payments that fire once and only once across
   restarts and retries, with a written policy for the day the balance cannot
   cover them.
9. **Scheme reconciliation.** The nightly file from the processor against your
   ledger: in-file-not-ledger, in-ledger-not-file, amount mismatch. A breaks
   screen with aging. We will plant one.
10. **Maker-checker.** Payments above the threshold need a second human. The
    initiator can never approve their own payment. Neither can the agent
    surface — its write tool lands in the queue like everyone else.

## Live fire

- Create a card and simulate a $50 fuel-pump auth: available drops, ledger
  balance does not.
- Capture $73.40 two days later. The hold releases exactly once; the ledger
  posts the settled amount.
- Reverse that settlement the next day and pull up the statement for settlement
  day.
- Deliver a settlement before its auth and watch what your matcher does.
- Have the payment initiator try to approve their own above-threshold payment.
- Delete one row from tonight's scheme file and ask your breaks screen where it
  went.
- Turn off your issuing provider's webhooks for five minutes mid-demo and ask
  what the customer sees.

## A build order that works

The ledger and the hold model first — on paper for thirty minutes, then in
code. Wire the issuing sandbox on day one; T+24h expects a card authorising and
your available balance moving. The bitemporal correction machinery is the
differentiator — it cannot be retrofitted at hour 40, so decide the schema
early. Statements and the breaks screen close it out.

## Stretch ladder

- The cross-border USDC payout with an FX quote the customer accepts first.
- Card controls — per-card limits, merchant-category blocks — enforced in the
  real-time auth decision webhook inside the provider's timeout.
- Interest or fee accrual computed at end of day, visibly, on the ledger.
- Sub-accounts or pots, with instant internal transfers that are pure ledger
  moves.
- Dispute intake on a settled card transaction, with provisional credit done
  honestly.
- A payee confirmation step that catches the mistyped account before the money
  leaves.

## What we grade hardest here

The hold model under hostile sequencing, the bitemporal correction, and whether
available balance is derived truth or a stored lie. This is literally what
neobank says.
