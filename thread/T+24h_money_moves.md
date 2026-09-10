# T+24h checkpoint email — draft for review

```
Subject: Re: Work trial: Saahith Veeramaneni, Track 3 — T+24h

https://corgi-trial-psi.vercel.app

No credentials. There is nothing to sign into: the ops console is open, and the
screens are /accounts, /approvals, /reconciliation and /api/health.

Start with the health page. Every label on it was earned by a live
authenticated call, and the evidence string beside each slot names the call. If
anything below disagrees with that page, believe the page.

It reports 5 live of 7 right now.

  LIVE       card_issuing       Lithic sandbox      GET /v1/cards -> 200
  LIVE       card_webhooks      Lithic              verified deliveries on Neon
  LIVE       ach_rail           Increase sandbox    GET /accounts -> 200
  LIVE       open_banking       Plaid sandbox       POST /institutions/get -> 200
  LIVE       director_kyc       Stripe Identity     Stripe Identity enabled
  SIMULATED  business_registry  Stripe Connect      Connect not enabled
  SIMULATED  stablecoin         USDC, Base Sepolia  0 wei gas, cannot send

The two simulated ones, said plainly. Business registry is simulated because
every KYB provider on your menu is gated. Middesk and Sumsub want a sales
conversation, Persona's own KYB guide opens with "contact your Persona team",
and Stripe Connect needs business verification first. I stopped rather than
invent a company to get past a form. The stablecoin wallet holds 20.00 USDC on
Base Sepolia and 0 wei of gas; a transfer needs roughly 390000000000 wei, so it
can read the chain and cannot move a cent. Its probe used to report LIVE off a
balanceOf call, which is the same lie in a friendlier shape, and I count that as
one of the worse bugs I have written this weekend.

WHAT MOVED MONEY

Increase, live sandbox, whole lifecycle: a $742.19 outbound ACH credit created,
submitted, settled at 16:13:05, then returned R01 insufficient_fund at 16:13:21.

Lithic, live sandbox: authorisations and clearings driven through the partial,
repeat and over-capture cases, and a real card_transaction.updated delivery
arrived at production, signature verified, stored on Neon. That delivery is also
the best thing that happened today. The first attempt failed at 16:18:43 on a
jsonb cast bug, the route returned 500, Lithic retried, and the event landed at
16:23:23 once I had fixed it. Nothing was lost, which is the entire reason an
inbox failure returns 500 instead of swallowing the delivery.

WHERE I AM SHORT

The gate asks for money moving end to end through a live rail on the deployed
URL. I am one hop short of it. On production the webhook route verifies the
signature and writes the event to the inbox, then stops. The drain that turns an
inbox row into journal lines runs out of band and is not switched on yet, so no
live provider event has become a journal line in production. The account screen
still reads fixtures and the home page still says so.

Both halves either side of that hop are real. Provider events reach the deployed
system and are stored with signatures checked. Ledger posting, derived balances
and the backdated correction all run against the same live Neon database in the
integration suite, including reverse-and-rebook of $73.40 at Tuesday's value
date with Tuesday-as-believed-on-Wednesday still answerable. 700 tests pass.

Why it went this way, since the honest version is more useful than an excuse. I
spent most of the first day making the live/simulated labels impossible to fake,
and it cost more than I planned: four probes shipped green while the capability
behind them was absent, and I only found each by measuring. A valid Stripe key
answers 200 on /v1/balance with Connect switched off. It also answers 200 on GET
/v1/accounts with Connect switched off, which is the fix I wrote for the first
bug and congratulated myself for. Only a parameterless POST /v1/accounts fails
when the entitlement is missing. Three attempts at one probe. I would make that
trade again, because the alternative was a README claiming five live slots that
nobody had watched fail, but it is where the hours went and the drain is what
paid for it.

THREE THINGS I MEASURED THAT CHANGED THE BUILD

1. Lithic's transaction status flips to SETTLED while a hold is still
   outstanding. Authorise 1000, clear 600, and the transaction reports
   status=SETTLED with amounts.hold.amount at -400. Release the hold on
   status == "SETTLED" and you have freed 400 cents that are still authorised.
   The signed negative is a second trap on the same field. So the hold reads
   neither field: it is max(authorised - cleared, 0) over the event set, which
   reproduces their own arithmetic in every case I measured, over-capture
   included, and agrees with the network exactly where their status does not.

2. Increase has no settled status at all. A settled transfer stays submitted and
   grows settlement.settled_at. Key a release off status and you release
   nothing, ever. The more useful half came from the return: after R01, the
   original transfer id is unchanged and settled_at is still populated. The
   provider models a return as a second movement rather than an edit of the
   first. That decides a row I could otherwise have got backwards for the whole
   trial. An ACH return is a new event at a new value date, because the money
   really did leave on the settle date and really did come back on the return
   date, and a statement for the settle date must still show the payment. A card
   clearing reversal is the opposite: a correction at the original value date,
   because the clearing should never have posted at that amount. One wrong entry
   there corrupts every past statement it touches while the invariants keep
   passing and reconciliation stays clean.

3. The application connects as a restricted role that cannot express UPDATE on a
   money table. Not "does not", cannot. pnpm db:check attempts the forbidden
   thing and asserts the refusal, and it ran a few minutes ago at 14 of 14:

     PASS  UPDATE journal_entry is refused - permission denied for table journal_entry
     PASS  DELETE FROM journal_entry is refused - permission denied for table journal_entry
     PASS  TRUNCATE journal_entry is refused - permission denied for table journal_entry

   Worth knowing how that got found. The REVOKE was correct in the migration
   from the first hour and worth nothing at runtime, because I had connected as
   the table owner and privileges never bind an owner. The prover caught it
   ninety seconds after it first ran. Reading the migration would not have.

NOT DONE

- No live provider event becomes a journal line on the deployed URL. Above.
- Account, approvals and reconciliation screens read fixtures in production.
- The USDC payout is blocked on testnet gas, not on code.
- Persona is not signed up. Director KYC is live via Stripe Identity instead,
  which cannot script a declined or needs_review outcome, so the non-happy-path
  KYC states are not yet third-party.
- Webhook dedupe is unproven against a real dashboard replay. I tried to prove
  it by replaying stored bytes, saw the row count hold at 1, and nearly wrote it
  up as evidence. It was not. Both replays returned 401 on corrupted stored
  headers, so the count held because the requests never reached the inbox.

REMAINING HOURS, IN ORDER

1. Drain the inbox into the journal, so a real Lithic authorisation moves the
   available balance on the deployed URL. This is the miss above and it is
   first.
2. Account screen off fixtures. state=default becomes the live query; the other
   four states keep working, because they answer the same interface.
3. Hold state machine end to end: partial capture, over-capture, a settlement
   that arrives before its own authorisation, exactly-once release.
4. Approvals and reconciliation on live data, with the initiator-cannot-approve
   rule enforced in the database rather than in a handler.
5. The seven published live-fire attacks as automated tests, run against
   production before you run them.
6. Gas, then a USDC payout that confirms on chain.

Every number here came from /api/health or from a run I can replay in front of
you.

Saahith
```

## What I left out and why

- The T+2h email promised six live slots including USDC and Stripe Connect for
  the registry leg. Rather than re-litigating that plan line by line, the email
  states today's labels and lets /api/health be the diff. The two slots that
  moved are named as simulated in the same table as the live ones.
- Test-count trivia, table counts, commit counts and the decision-log length are
  all out. They measure typing, not whether money moved, and this checkpoint is
  graded on the latter. The one count kept is 700 passing tests, because it sits
  under the claim about the ledger running against a live database.
- **Fix /api/health before sending; it currently contradicts itself.** The
  authoritative `integrations.slots[]` array says `business_registry:
  simulated`, and the count is 5 of 7. But `integrations.webhooks[]` carries a
  nested copy of the slot list, and in it the Stripe entry reports
  `business_registry: live`, because that nested status is derived from whether
  the webhook credentials are present rather than from the slot probe. Anyone
  parsing the JSON finds a simulated slot labelled live inside the page this
  email tells them to trust. That is the automatic-fail shape, in the one
  endpoint whose job is to be believed. Fix it before the email goes, or the
  labelling in the email does not match the page.
- **Re-check before sending.** The "one hop short" section is true as measured
  at T+16h. If the inbox drain lands before Thu 17:13 PDT, that section and item
  1 of the plan both have to be rewritten, and /api/health has to be re-read for
  the live count, which may become 6 of 7 if the testnet wallet gets gas.

## Style checklist used

Applied to the draft above, in order of how much each one cut.

1. **Vary sentence length hard.** AI prose runs a metronome at roughly 20-25
   words per sentence where human writing sits at 14-18. Human technical writing
   drops to four words and back. ("Three attempts at one probe." "Above.")
2. **No triads.** The three-parallel-item rhythm is the single loudest tell.
   Where a list wanted three parallel clauses, it got two or four, or became a
   numbered list of unequal length.
3. **At most one em dash.** Not because em dashes are inhuman, but because the
   density is the tell rather than the mark itself. This draft has one, in the
   subject line. Hyphens and full stops do the rest.
4. **Kill the throat-clearing opener.** No warm-up paragraph. The first line is
   the URL. Test: if the first sentence can be deleted with no information lost,
   it was announcing itself.
5. **No summary paragraph.** Nothing restates the paragraph before it, and there
   is no "in conclusion", "ultimately" or "at the end of the day".
6. **No upbeat forward-looking closer.** The email ends on where the numbers
   came from, not on enthusiasm. No "excited to", no "happy to answer questions".
7. **Ban the vocabulary.** leverage, utilise, robust, seamless, comprehensive,
   delve, navigate, landscape, realm, pivotal, unlock, empower, foster, myriad.
   None appear.
8. **Cut empty intensifiers.** incredibly, truly, extremely, really, simply,
   just, genuinely, "it is crucial that". Replaced by a number or deleted.
9. **Strip hedges.** No stacked can/may/might/could. Claims are stated flat and
   attributed to a measurement, or they are labelled as unproven and named as
   such.
10. **Avoid the named constructions.** "It's not just X, it's Y", "X, not Y" as
    a rhetorical reframe, "That's where...", "Whether you're X or Y", "From X to
    Y". One deliberate exception survives: "Not 'does not', cannot" — it is a
    precise distinction about database privileges, not a rhetorical flourish.
11. **Concrete nouns and real numbers over adjectives.** Every claim carries a
    figure, an endpoint or a timestamp: 5 of 7, $742.19, 16:13:21, hold -400,
    390000000000 wei, 14 of 14.
12. **One specific thing only the author could write.** The 16:18:43 failure and
    the 16:23:23 recovery, and the probe I congratulated myself for.

### Sources read

- Olivia Cal, "How to Spot AI Writing Tells: 17 Examples + AI Words Blacklist 2026" — https://www.oliviacal.com/post/ai-writing-tells (triads, uniform 15-20 word sentences, banned word list, hedges, throat-clearing, recap closers)
- Tundra AI Labs, "Anti-AI Writing Guide" — https://tundraailabs.com/writing-guide (named constructions including "It's not X. It's Y." and the "X, not Y" reframe; em dash rule; empty intensifiers; meta-labels)
- imperfectly, "Remove AI slop from writing: 7 edits that work in 2026" — https://imperfectly.app/post/remove-ai-slop-from-writing (20-25 vs 14-18 words per sentence; "kill the throat-clearing"; the cover-the-first-sentence test for announcing paragraphs; add one detail only you could write)
- Fast Company on the Economist/Rambelli analysis of AI tells — https://www.fastcompany.com/91584243/how-to-identify-ai-generated-writing-viral-report-has-surprising-new-clues-economist (via search summary; the tell is the cluster rather than any single mark, and sparse commas/semicolons/parentheses beat em dashes as a signal)
