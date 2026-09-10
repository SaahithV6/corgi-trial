Subject: Re: Work trial: Saahith Veeramaneni, Track 3

Dear Corgi Staff,

T+24h checkpoint. The deployment is at https://corgi-trial-psi.vercel.app and
money moves end to end on it.

A card authorisation from Lithic arrives as a signed webhook, is verified and
deduplicated, and posts to the ledger. Available balance drops on the
authorisation, the ledger balance does not move until the clearing lands, and
the hold releases exactly once. Outbound ACH runs through Increase and an
approval queue that a second person has to clear. A USDC payout confirmed on
Base Sepolia at 0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1,
and the control account for that wallet reconciles to the chain.

/api/health reports six of seven integration slots live against real provider
sandboxes, and it is the authority. The seventh is business registry, simulated
and labelled so. Stripe Connect was gated, I enabled it during the trial, and
Stripe has since retired Accounts v1 for new integrations, so the API I would
have called no longer exists and v2 is not wired. Middesk, Sumsub and Persona
KYB are each behind a sales conversation.

Of your eight published attacks, seven pass against production and one skips.
The skip is the closure row on the over-capture. The money is right and the row
is deliberately not written, and the reasoning is in the decision log.

Two demo roles are in the header of every screen, so the queue can be seen from
both sides.

Thank you,
Saahith Veeramaneni
