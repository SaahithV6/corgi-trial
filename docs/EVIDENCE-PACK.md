# Evidence pack

The submission asks for "evidence of the live integrations: read-only sandbox
dashboard access, or screenshots including the webhook delivery log."

**A screenshot is the weaker artefact.** It has to be trusted: the cropping, the
environment selector, the person holding the camera. It cannot be re-run, it
proves nothing about what happened to the delivery *after* the provider sent it,
and it ages the moment it is taken.

The stronger evidence was already in our own database before anyone thought
about screenshots. Every provider delivery that reached this system was
**signature-verified over the exact bytes received before it was persisted**,
carries **the provider's own event id**, and can be **joined to the exact journal
entries it produced**. That is a query. A grader can re-run a query.

So this pack is in two halves, and they are deliberately unequal:

| | What it is | Size |
| --- | --- | --- |
| **The runnable** | `node scripts/evidence.mjs` — 22 claims, each with the query or the call that proves it printed beside it | the whole of §1–§3 below |
| **The shot list** | the *minimum* set of dashboard frames only a logged-in human can take | **3 screenshots**, §5 |

Three screenshots, not fifteen, because the other twelve would have been
pictures of things the runnable already proves better.

---

## 1. The runnable

```bash
set -a; . ./.env; set +a
node scripts/evidence.mjs
```

```
node scripts/evidence.mjs [--base-url URL] [--no-fire] [--only 1,2,5]

  1  provider deliveries, by state, with the newest provider event id
  2  the negative control: a forged body is refused, a replay is one row
  3  one real payment: instruction -> two approvals -> provider -> ledger
  4  one card transaction: authorisation, hold, clearing, release
  5  the USDC payout: transaction hash, block number, ledger entry
  6  the Fedwire transfer and its IMAD
```

It exits `0` only when every claim is proven, `1` otherwise, and it takes about
50 seconds. `--no-fire` makes it entirely read-only (no HTTP to production).

### The four rules it obeys

1. **Every figure comes from a query or a call that ran, and the query is
   printed beside it.** No number in the output was typed by a human. A claim it
   cannot prove prints `NOT PROVEN` and names what is missing.
2. **It never prints a secret.** Provider event ids, transfer ids, transaction
   hashes, card tokens and IMADs are public-in-context and are printed in full.
   API keys, signing secrets, database passwords, full PANs and full account
   numbers go through `mask()` — the Increase wire's `account_number` reaches the
   terminal as `••0000`. Two live credentials have been in this repo's git
   history (DECISIONS 023); the whole precommit gate exists because of it.
3. **It reads as the application's restricted role.** It connects on
   `APP_DATABASE_URL` (`corgi_app`) — the role that cannot `UPDATE` or `DELETE` a
   money row. The reader can be sure it did not tidy anything on the way past.
4. **The live probes are safe to re-run.** They are a replay of a delivery
   already in the inbox and three forgeries refused before a byte is stored. They
   move no money.

### The header, from the run pasted throughout this document

```
============================================================================================
CORGI WORK TRIAL — TRACK 3 — REPRODUCIBLE EVIDENCE
============================================================================================
  generated at     2026-09-11T08:45:00.891Z
  deployed URL     https://corgi-trial-psi.vercel.app
  deployed commit  2f863c8f52f16a7c13059f172c31617e45e9c264   [/api/health -> commit.sha]
  local commit     2f863c8f52f16a7c13059f172c31617e45e9c264   [.git/HEAD]
  commits agree    yes
  database         ep-curly-tooth-ayhug2be-pooler.c-5.us-east-2.aws.neon.tech as role 'corgi_app' (postgres 18.6)
  db url from      APP_DATABASE_URL
  live HTTP probes ENABLED
```

The deployed commit is read **from the running deployment**, not from a note. If
the deployment is ever not this checkout, the header says so on its third line.

---

## 2. What the runnable proves — the 22 claims

```
  PROVEN      all 1206 stored deliveries carry signature_verified_at
  PROVEN      one delivery, one row — enforced by UNIQUE (provider, provider_event_id)
  PROVEN      every delivery Lithic logged as sent is a row in our inbox, matched by the id we returned to Lithic
  PROVEN      refusals are recorded with reason codes, including signature_mismatch WITH a signature present
  PROVEN      no unsigned body was accepted by any endpoint
  PROVEN      a signed delivery sent more than once produced exactly one inbox row
  PROVEN      a replay of a 550s-old signed delivery is refused as timestamp_outside_window
  PROVEN      content the signature does not cover is refused 401 signature_mismatch and is not ingested
  PROVEN      the refusal this run just caused is readable back out of the database
  PROVEN      no released instruction was approved by its own initiator
  PROVEN      2 approvals, each recorded against the instruction's current content hash
  PROVEN      the provider's own record names our instruction id
  PROVEN      1 journal entry, summing to zero
  PROVEN      every event in this authorisation arrived on a signature-verified delivery
  PROVEN      $50.00 authorised, $73.40 cleared, hold left at $0.00
  PROVEN      every event token Lithic holds for this transaction is one we hold too
  PROVEN      the most recent real authorisations DECLINE — the sandbox account's daily cap is exhausted
  PROVEN      USDC transfer confirmed on Base Sepolia in block 46666112, and the ledger already said so
  PROVEN      the chain's Transfer recipient is the destination on the accepted quote
  PROVEN      the stablecoin leg is booked as a double entry in USD cents like any other rail
  PROVEN      Fedwire issued IMAD 20260911wgpcflcf474978 for sandbox_wire_transfer_z64990197n7mvli7cdqs
  PROVEN      5 inbound wire credits carry the network's IMAD in the ledger itself

  22 proven, 0 not proven, 22 claims checked.
```

---

## 3. The output that matters, with the queries that produced it

Everything below is verbatim from the run at **2026-09-11T08:45Z**, commit
`2f863c8`. Queries are abbreviated here only where the script prints them in
full; run it and you get the rest.

### 3.1 Deliveries received, by provider and state

```
  provider  received  sig_verified  consumed  parked  dead_lettered  pending  first_seen                last_seen
  --------  --------  ------------  --------  ------  -------------  -------  ------------------------  ------------------------
  increase  235       235           52        16      167            0        2026-09-10T19:01:04.455Z  2026-09-11T06:20:31.859Z
  lithic    958       958           871       54      33             0        2026-09-10T16:22:11.829Z  2026-09-11T08:36:37.196Z
  plaid     3         3             3         0       0              0        2026-09-10T21:58:19.587Z  2026-09-10T22:47:23.312Z
  stripe    10        10            10        0       0              0        2026-09-10T18:50:58.138Z  2026-09-11T06:41:14.829Z

  totals: 1206 received · 1206 signature-verified · 936 consumed · 70 parked · 200 dead-lettered
```

`received` here is not what a dashboard counts. A dashboard counts what the
provider **sent**. This counts what we **received and authenticated** — the route
reads `req.text()` once, verifies over those bytes, and only then parses, so an
unverified body is never persisted and `sig_verified = received` is a tautology
that would break the moment it stopped being one.

**The newest provider event id we hold, per provider:**

```
  provider  provider_event_id                                                        event_type                     state   received_at
  --------  -----------------------------------------------------------------------  -----------------------------  ------  ------------------------
  increase  sandbox_event_001m27hzwwhvab7yf0hp79v25ec                                inbound_wire_transfer.created  parked  2026-09-11T06:20:31.859Z
  lithic    msg_3JAtegKxBEJdcb7FfPeEYB5pedL                                          card_transaction.updated       done    2026-09-11T08:36:37.196Z
  plaid     sha256:5be1e1a02415468824be1bbcb90c3ba2d3465b26c05c56d64d04382c18370d73  ITEM.ERROR                     done    2026-09-10T22:47:23.312Z
  stripe    evt_negctl_1789108873                                                    ping.refusal_negative_control  done    2026-09-11T06:41:14.829Z
```

Plaid's `provider_event_id` is a `sha256:` of the body rather than an id, because
**Plaid ships no event id of any kind**. The dedupe key is the SHA-256 of the
exact body — which is the value Plaid itself signed in `request_body_sha256`, so
it is stable across their 24 hours of retries. The cost is stated plainly in
`inbox.ts` rather than hidden: two genuinely distinct webhooks with byte-identical
bodies collapse to one row. That is acceptable **only** because every Plaid
webhook is a "something changed, come and read it" notification whose consumer
re-fetches from the API. It would not be acceptable for a money event carrying an
amount, and the comment says so.

**The 200 dead letters and 70 parked rows are not hidden**, they are §1d of the
run, in the system's own words:

```
  provider  state   rows  reason
  --------  ------  ----  -------------------------------------------------------------------------------------------------
  increase  dead    64    dead-lettered after 8 failed attempts: no consumer registered for provider 'increase'
  lithic    parked  8     card 732415b1-d257-4c62-ba75-ab3061b52f6b is not registered to a customer
  lithic    dead    8     card 49a4c0e8-3c65-40c8-a916-23cdc5d2c3f7 is not registered to a customer
  increase  dead    6     Increase wire sandbox_wire_transfer_j21s5dtdns6eb3xqs3sx carries Idempotency-Key 'corgi-itest-17…
```

Three honest readings, all of them worth more than a clean number:

- **`no consumer registered for provider 'increase'`** is a real gap that was
  real for part of the trial. Those deliveries were *verified and durably
  stored*; nothing was lost, and nothing was invented either. The consumer
  exists now; those rows are the archaeology.
- **`card … is not registered to a customer`** is the system refusing to guess
  whose money to move for a card created directly in the Lithic sandbox. The
  delivery is kept, verified, and replayable the moment the card is claimed.
- **`carries Idempotency-Key 'corgi-itest-…', which names no payment_instruction
  on this book. NOTHING WAS POSTED.`** A wire with no approval behind it is an
  incident for a person, not a row for a consumer.

### 3.2 The provider's own delivery log, reconciled against our inbox

This is the section that replaces the delivery-log screenshot, and it is
strictly stronger than one. Lithic's attempts endpoint records what was **sent**,
the HTTP status **we answered**, and — because our 202 carries a body — **the
inbox id we minted**. The provider is holding a pointer into our database, and
the script dereferences it.

```
  call:  GET https://sandbox.lithic.com/v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW/attempts?page_size=25
  created                   status   http  event_token                      destination                                             inbox_id_in_our_reply
  ------------------------  -------  ----  -------------------------------  ------------------------------------------------------  ------------------------------------
  2026-09-11T08:36:37.100Z  SUCCESS  202   msg_3JAtegKxBEJdcb7FfPeEYB5pedL  https://corgi-trial-psi.vercel.app/api/webhooks/lithic  fbd96d36-aa02-4efd-97a2-627ecf7f8945
  2026-09-11T08:35:33.280Z  SUCCESS  202   msg_3JAtWf2gw1R95OeHubTiAFzTDcF  https://corgi-trial-psi.vercel.app/api/webhooks/lithic  5f3d8ce3-92de-4698-b163-d60cb4150a92
  2026-09-11T08:34:39.760Z  SUCCESS  202   msg_3JAtPvz41aq680FSlfJrpheEzfj  https://corgi-trial-psi.vercel.app/api/webhooks/lithic  a4bdd3c6-d758-43f6-a35f-9fecab16d699
  ...
  25 attempts on this page; every one names the deployed origin as its destination.

  event_token                      lithic_says  inbox_id                              row_exists  our_event_id_matches  state
  -------------------------------  -----------  ------------------------------------  ----------  --------------------  -----
  msg_3JAtegKxBEJdcb7FfPeEYB5pedL  SUCCESS 202  fbd96d36-aa02-4efd-97a2-627ecf7f8945  yes         yes                   done
  msg_3JAtWf2gw1R95OeHubTiAFzTDcF  SUCCESS 202  5f3d8ce3-92de-4698-b163-d60cb4150a92  yes         yes                   done
  ...
  PROVEN      every delivery Lithic logged as sent is a row in our inbox, matched by the id we returned to Lithic
              25 attempts reconciled, 0 non-SUCCESS attempts on this page
```

**202, not 200, is the correct answer here**: the route stops at *verified and
persisted* and hands off to the drain. 200 is reserved for the replay of an
event already in the inbox, which is a different fact and deserves a different
code.

### 3.3 The negative control

`1206 signature-verified deliveries` is worth nothing on its own — a system that
accepts everything and stamps it `verified` prints exactly that line. The claim
only means something if a delivery that *should* fail does.

**Refusals on record** (`webhook_refusal`, added in migration 0038; the body is
never stored, only its length and its sha256, so a forged payload cannot use our
own refusal log as storage):

```
  provider  endpoint                reason_code               refusals  folded_rows  any_signature_present  bodies_varied
  --------  ----------------------  ------------------------  --------  -----------  ---------------------  -------------
  lithic    /api/webhooks/lithic    signature_mismatch        24        12           true                   true
  lithic    /api/webhooks/lithic    signature_absent          13        10           false                  true
  increase  /api/webhooks/increase  signature_absent          11        8            false                  true
  plaid     /api/webhooks/plaid     signature_absent          11        8            false                  true
  lithic    /api/webhooks/lithic    timestamp_outside_window  8         4            true                   true
  shopify   /api/webhooks/shopify   unknown_provider          6         6            true                   false
  stripe    /api/webhooks/stripe    signature_absent          5         5            false                  false
```

`refusals` exceeds `folded_rows` because a burst of identical refusals in one
minute is folded into a single row with a counter, rather than being allowed to
become a write amplifier an attacker controls. `bodies_varied` records whether
the folded attempts differed from each other, so the fold cannot hide a probe
sweeping payloads.

**Unsigned POST to every endpoint, fired live at production during the run:**

```
  endpoint                status  code                             message
  ----------------------  ------  -------------------------------  --------------------------------------------------------
  /api/webhooks/lithic    401     WEBHOOK_SIGNATURE_INVALID        signature verification failed; the payload was not inges
  /api/webhooks/increase  401     WEBHOOK_SIGNATURE_INVALID        signature verification failed; the payload was not inges
  /api/webhooks/plaid     401     WEBHOOK_SIGNATURE_INVALID        signature verification failed; the payload was not inges
  /api/webhooks/stripe    401     WEBHOOK_SIGNATURE_INVALID        signature verification failed; the payload was not inges
  /api/webhooks/persona   503     WEBHOOK_PROVIDER_NOT_CONFIGURED  webhooks for 'persona' are not configured on this deploy
  /api/webhooks/shopify   404     UNKNOWN_PROVIDER                 no webhook endpoint for 'shopify'
```

The 503 is the point of that row: Persona has no secret on this deployment, so
the route **refuses to accept what it cannot authenticate** rather than storing
it optimistically.

**Twice is one, from rows that were already there.** The chaos driver re-sends a
genuinely signed delivery; every copy is its own `chaos_delivery` row, and all of
them point at one `webhook_inbox` row:

```
  run_id                                webhook_id                                 copies_sent  inbox_rows  outcomes
  ------------------------------------  -----------------------------------------  -----------  ----------  ----------------
  472a5959-aa54-4c8c-a91d-8d7de8c66ae0  chaos_472a5959aa544c8ca91d8d7de8c66ae0_00  3            1           accepted, replay
  472a5959-aa54-4c8c-a91d-8d7de8c66ae0  chaos_472a5959aa544c8ca91d8d7de8c66ae0_01  3            1           accepted, replay
  a2163b5c-36d5-4d05-a0ab-65b81285a551  chaos_a2163b5c36d54d05a0ab65b81285a551_00  3            1           accepted, replay
```

and the dedupe is not a code path at all — it is
`UNIQUE (provider, provider_event_id)` plus `ON CONFLICT DO NOTHING`, with
`0` providers holding a duplicate event id across 1,206 rows.

**The live replay, with its expectation computed rather than hoped for.**
Standard Webhooks signs the timestamp as well as the body, and this system
applies a ±300s window. So the *correct* answer depends on how old the stored
delivery is, and the script says which branch it is taking before it fires:

```
  this delivery was signed 550s ago; the replay window is +/-300s, so the correct answer is 401 timestamp_outside_window.
  probe         http  status                     recorded_reason           rows_before  rows_after
  ------------  ----  -------------------------  ------------------------  -----------  ----------
  exact replay  401   WEBHOOK_SIGNATURE_INVALID  timestamp_outside_window  1            1
  PROVEN      a replay of a 550s-old signed delivery is refused as timestamp_outside_window
```

When the inbox has fresh traffic the same probe asserts the other branch — `200
replay`, `rows_after == rows_before == 1`. Both are the system behaving, and a
probe that only passed when the traffic happened to be fresh would be a flaky
claim. A flaky claim in an evidence pack is worse than no claim.

**And the forgery that the whole positive claim rests on.** Three requests, each
carrying the genuine signature Lithic produced, each presenting a *current*
timestamp so that the replay window cannot be what refuses them — leaving the
signature comparison as the only check standing, which makes the recorded reason
code attributable rather than ambiguous:

```
  forgery                                 body_bytes  http  code                       accepted
  --------------------------------------  ----------  ----  -------------------------  --------
  A  body unchanged, clock moved forward  2166        401   WEBHOOK_SIGNATURE_INVALID  no
  B  one space before the closing brace   2167        401   WEBHOOK_SIGNATURE_INVALID  no
  C  "amount":1 -> 2                      2166        401   WEBHOOK_SIGNATURE_INVALID  no

  reason_code               refusals  signature_present  signature_shape  body_varied  last_seen_at
  ------------------------  --------  -----------------  ---------------  -----------  ------------------------
  signature_mismatch        3         true               swh:v1x2         true         2026-09-11T08:45:24.595Z

  PROVEN      content the signature does not cover is refused 401 signature_mismatch and is not ingested
```

- **A** proves the timestamp is inside the signed content: a genuine old
  signature cannot be slid forward onto a fresh clock.
- **B** is **JSON-identical** — one space before the closing brace. It proves the
  signature is over **bytes**, not over meaning, which is the property that makes
  "verify before you parse" the only safe ordering.
- **C** is what an attacker would actually want.

None was ingested. The refusal is then read back out of `webhook_refusal` in the
same run, so the 401 is a durable fact with a reason code rather than a line in a
log that rotates.

### 3.4 One real payment, end to end

The join between our book and the provider's is not an amount or a name — it is
the `Idempotency-Key` we send on origination, which is literally
`payment:<the instruction id>`. The provider hands it back, so the two records
name each other.

```
3b. The instruction — d72d1972-653d-45ce-98da-baca8def22c9
  id                                    business                  rail  amount  beneficiary               beneficiary_acct  content_sha256
  ------------------------------------  ------------------------  ----  ------  ------------------------  ----------------  -----------------
  d72d1972-653d-45ce-98da-baca8def22c9  Ridgeline Robotics, Inc.  wire  $42.00  Northwind Industrial LLC  ••0000            d020088d8bd6fcf1…

3c. Its approvals — two distinct humans, neither of them the initiator
  kind       actor          actor_kind  email                        occurred_at               approved_content_sha256  entry_id
  ---------  -------------  ----------  ---------------------------  ------------------------  -----------------------  ------------------------------------
  requested  Priya Raman    human       priya.raman@corgi.example    2026-09-11T04:45:27.617Z  -                        -
  approved   Dana Okonkwo   human       dana.okonkwo@corgi.example   2026-09-11T04:45:28.961Z  d020088d8bd6fcf1…        -
  approved   Miles Ferrara  human       miles.ferrara@corgi.example  2026-09-11T04:45:30.519Z  d020088d8bd6fcf1…        -
  released   Miles Ferrara  human       miles.ferrara@corgi.example  2026-09-11T04:45:30.716Z  -                        95215cf4-cd9c-4437-bfbe-f94cfc01e94b

3d. What the provider says it did
  provider_transfer_id                        status    amount  routing_number  account_number  imad                    submitted_at          transaction_id
  ------------------------------------------  --------  ------  --------------  --------------  ----------------------  --------------------  ----------------------------------------
  sandbox_wire_transfer_z64990197n7mvli7cdqs  complete  $42.00  021000021       ••0000          20260911wgpcflcf474978  2026-09-11T04:46:03Z  sandbox_transaction_6ga3oovichtasqpoq1ey

  idempotency_key at the provider: payment:d72d1972-653d-45ce-98da-baca8def22c9
  our instruction id:              d72d1972-653d-45ce-98da-baca8def22c9

3e. Every journal entry the payment produced
  entry_id                              ordinal  account                                                   amount   currency
  ------------------------------------  -------  --------------------------------------------------------  -------  --------
  95215cf4-cd9c-4437-bfbe-f94cfc01e94b  0        2100 Ridgeline Robotics, Inc. — business current account  $42.00   USD
  95215cf4-cd9c-4437-bfbe-f94cfc01e94b  1        1110 Cash — FBO settlement account at sponsor bank        -$42.00  USD
```

Two details a reader should not have to be told to notice:

- **The approval carries the content hash.** `approved_content_sha256` equals the
  instruction's current `content_hash`. Change the instruction and the hash
  changes, and an approval recorded against the old hash stops counting. An
  approval of "instruction 7" is worth much less than an approval of "instruction
  7 as it read at this byte".
- **`initiator_self_approved` is `false` across every released instruction the
  script checks**, read back out of the data rather than asserted by the code
  that wrote it. The stronger guard is in the database — live fire attack 5
  proves self-approval is refused with SQLSTATE 42501 — but this is the reading
  that covers *all* the history at once rather than one contrived attempt.

### 3.5 One card transaction — and an honest label on it

**The Lithic sandbox account's daily spend cap is exhausted, so every
authorisation simulated today declines.** The card slot is live; the spend
allowance is not. The transaction below is therefore **historical** — a real
authorisation Lithic approved on 2026-09-10 — and the run proves the decline is a
genuine current limit rather than a flattering choice of old row:

```
4e. Why this is historical: what an authorisation does TODAY
  provider_auth_id                      first_seen_at             amount  result    delivery_id
  ------------------------------------  ------------------------  ------  --------  -------------------------------
  68c9d432-8070-4138-abd1-c2356c4ad40b  2026-09-11T08:36:37.544Z  $0.01   DECLINED  msg_3JAtegKxBEJdcb7FfPeEYB5pedL
  85ff6441-a9ec-42ce-bc29-b4185a503c92  2026-09-11T08:34:31.607Z  $50.00  DECLINED  msg_3JAtOrffKk5iBBNqgsKIXYXOnnD
  5da8ecd3-dd31-4e15-8950-33695f6663d4  2026-09-11T08:32:48.032Z  $50.00  DECLINED  msg_3JAtBsARJTcioEn8qTZ9oCIWrIl

  Lithic's reason for the most recent authorisation: DECLINED ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED
```

The exemplar itself — **$50.00 authorised, $73.40 cleared**, the fuel-pump
asymmetry the brief calls the heart of the track:

```
4b. The events, and the signed deliveries that carried them — bfd64bda-8c76-4224-aa39-10f81b6582b2
  kind           amount  result    step           lithic_event_token                    delivery_id                      state  signature_verified_at
  -------------  ------  --------  -------------  ------------------------------------  -------------------------------  -----  ------------------------
  authorization  $50.00  APPROVED  AUTHORIZATION  b683104a-27e1-4969-9a5d-2df49d822dcb  msg_3J94LEcMYtMxxD5ndR4nHv4mNsl  done   2026-09-10T17:04:52.202Z
  clearing       $73.40  APPROVED  CLEARING       1989ecb0-819b-4900-95fe-bb1f74cfa55d  msg_3J94LfxbpLIpmaZPrN0hIjY2r31  done   2026-09-10T17:04:55.713Z

4c. The hold, and the ledger entries the deliveries produced
  hold_id                               kind       external_ref                                 memo_balance  active_hold  explicit_closure_row
  ------------------------------------  ---------  -------------------------------------------  ------------  -----------  --------------------
  d1a88fd4-9951-4264-9744-0ed103fea093  card_auth  lithic:bfd64bda-8c76-4224-aa39-10f81b6582b2  $0.00         $0.00        false

  booking_seq  ordinal  account                                                           amount
  -----------  -------  ----------------------------------------------------------------  -------
  414          0        9100 Holds Integration Fixture Co. — Holds — card authorisations  -$50.00     <- hold opened
  414          1        9900 Memo contra                                                  $50.00
  415          0        2100 Holds Integration Fixture Co. — Customer deposits            $73.40     <- clearing posted
  415          1        2200 Card network settlement payable                              -$73.40
  416          0        9100 Holds Integration Fixture Co. — Holds — card authorisations  $50.00     <- hold released
  416          1        9900 Memo contra                                                  -$50.00
  2786         0        2200 Card network settlement payable                              $1.19      <- interchange
  2786         1        4100 Interchange income                                           -$1.19
```

Four things in that block:

- **The hold is memo, not money.** It lives on `9100`/`9900`, off the customer's
  `2100`. Available balance is ledger minus active holds, *derived*, never a
  second stored number.
- **The hold released exactly once**, and the proof is arithmetic rather than a
  flag: `memo_balance_cents = 0`. `explicit_closure_row = false` is honest —
  there is no `hold_closure` row for this one (DECISIONS 024), and the memo
  balance is flat regardless. The money position is the arithmetic; the closure
  row is bookkeeping about the arithmetic, and the runnable reports both rather
  than the flattering one.
- **Settlement is not authorisation.** $50.00 held, $73.40 posted, days apart in
  the general case and seconds apart here because the sandbox obliges.
- **`Holds Integration Fixture Co.`** is the business name, and it is a test
  fixture. Said plainly rather than swapped for a prettier row: the *deliveries*
  are genuine signed Lithic traffic, the *business* is a fixture the integration
  suite stood up.

And the provider agrees, event token for event token:

```
4d. The provider's own record of the same transaction
  token                                 status   result    settlement  hold_at_provider  created
  ------------------------------------  -------  --------  ----------  ----------------  --------------------
  bfd64bda-8c76-4224-aa39-10f81b6582b2  SETTLED  APPROVED  -$73.40     $0.00             2026-09-10T17:04:50Z

  type           result    amount  token                                 detailed_results
  -------------  --------  ------  ------------------------------------  ----------------
  AUTHORIZATION  APPROVED  $50.00  b683104a-27e1-4969-9a5d-2df49d822dcb  APPROVED
  CLEARING       APPROVED  $73.40  1989ecb0-819b-4900-95fe-bb1f74cfa55d  APPROVED
```

### 3.6 The USDC payout — hash, block, ledger

```
5a. The settled payout in our book
  quote_ref     rail  sold   bought                destination                                 entry_id                              value_date   booking_seq
  ------------  ----  -----  --------------------  ------------------------------------------  ------------------------------------  -----------  -----------
  FXQ-XYRJF6AJ  usdc  $3.00  3354 MXN minor units  0x000000000000000000000000000000000000dEaD  027255d5-ee38-4eed-ac50-9771ba8d589a  2026-09-11   2270

  tx hash:  0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e

5c. What the chain says
  block_number  block_hash                                                          tx_status      transfer_to                                 transfer_units                 gas_used
  ------------  ------------------------------------------------------------------  -------------  ------------------------------------------  -----------------------------  --------
  46666112      0xb962f51ab4dbc3e3da71310cd8fbbc336af1b81cd223b349cf8d01c13fa212f8  0x1 (success)  0x000000000000000000000000000000000000dead  1979521 (6dp = 1.979521 USDC)  44843

  block number written into the ledger at posting time: 46666112
  block number the node reports now:                    46666112
  PROVEN      USDC transfer confirmed on Base Sepolia in block 46666112, and the ledger already said so
```

Public explorer, no credentials needed:
`https://sepolia.basescan.org/tx/0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e`

The block number is not fetched and then displayed — it was **written into the
journal entry's description at posting time** and is compared against what the
node reports now. A reorg would show up as a mismatch rather than as silence.

The entry itself, booked in USD cents like every other rail:

```
  ordinal  account                                                   amount  currency
  -------  --------------------------------------------------------  ------  --------
  0        4300 FX quote settlement variance                         -$0.01  USD
  1        4200 Fee income                                           -$1.01  USD
  2        2100 Ridgeline Robotics, Inc. — business current account  $3.00   USD
  3        1140 USDC omnibus wallet — Base Sepolia                   -$1.97  USD
  4        2900 Rounding residual clearing                           -$0.01  USD
```

**The sub-cent residual has its own account.** 9,521 of 10,000 USDC units of a
cent went to `2900` rather than being truncated into the customer's leg or
netted into FX variance. Pro-rata maths always leaves a penny and someone has to
eat it deterministically; here it is named.

**Seven rows in `fx_quote_settlement` carry a placeholder hash and are not
payouts**, and the run says so rather than filtering them out:

```
  tx_hash                    rows  with_ledger_entry  with_destination_address  with_rate_observation  moved_money
  -------------------------  ----  -----------------  ------------------------  ---------------------  -------------------------------------------------------
  0xaaaaaaaaaaaaaaaa…aaaaaa  7     0                  0                         0                      NO — nothing posted, no destination, no rate observation
  0x0acfad50d866e99c…77d79e  1     1                  1                         1                      yes
```

No ledger entry, no destination address, no rate observation. The FX settlement
path is exercised by integration tests against this same live database, so those
rows exist. Exactly one row in that table is a payout, and §5c asks the chain
about that one.

### 3.7 The Fedwire transfer

```
6a. The outbound wire behind the approved payment in §3
  id                                          status    amount  imad                    submitted_at          routing_number  account_number  transaction_id
  ------------------------------------------  --------  ------  ----------------------  --------------------  --------------  --------------  ----------------------------------------
  sandbox_wire_transfer_z64990197n7mvli7cdqs  complete  $42.00  20260911wgpcflcf474978  2026-09-11T04:46:03Z  021000021       ••0000          sandbox_transaction_6ga3oovichtasqpoq1ey

6b. Inbound wires we received, with the IMAD carried into the ledger
  external_ref                                                      value_date  booking_seq  imad
  ----------------------------------------------------------------  ----------  -----------  ----------------------
  increase.wire:sandbox_inbound_wire_transfer_aixelen6yjsh8ap0djjf  2026-09-11  3297         20260911ajtfqkxz778542
  increase.wire:sandbox_inbound_wire_transfer_rhwc6j2y0nk687sirnym  2026-09-11  3209         20260911jjatmqzm085046
  increase.wire:sandbox_inbound_wire_transfer_8jrb04vi1mcrn8mtlqco  2026-09-11  2587         20260911fsxoaoyp248548

6c. Every wire transfer this project originated at the provider
  id                                          status    amount    imad                    reversal_imad           raised_by
  ------------------------------------------  --------  --------  ----------------------  ----------------------  -----------------------
  sandbox_wire_transfer_izgjq03g8sga77z2m0lh  reversed  $1250.00  20260911jpoframy752348  20260911ykjbdjpf361971  an integration test
  sandbox_wire_transfer_z64990197n7mvli7cdqs  complete  $42.00    20260911wgpcflcf474978  -                       an approved instruction
  sandbox_wire_transfer_eo0v3izozckf5cbb42rq  complete  $42.00    20260911chbowyvf727572  -                       an approved instruction
```

The **IMAD** is Fedwire's own identifier for a message, and it is the strongest
settlement identity on this rail: one message, one settlement, and **a reversal
is a different message with a different IMAD**. That is why an outbound wire
reversal is booked as a new event at a new value date rather than as a correction
of the original — the `reversal_imad` column above is the network agreeing with
the schema.

`raised_by` is read from the idempotency key. `payment:<id>` means the money-out
path with its approvals behind it; anything else was raised by a test and has no
instruction behind it — which is precisely why the consumer **parks** those
deliveries instead of posting them.

---

## 4. Who can verify what, and with which credentials

This matters, and the previous version of this document was vague about it.

| Evidence | What a grader needs | Reproducible by them? |
| --- | --- | --- |
| `/api/health` — 7 live slots, the commit sha, per-slot round-trip evidence | nothing | **yes, right now** |
| The 401 on a forged or unsigned webhook | nothing — `curl -X POST https://corgi-trial-psi.vercel.app/api/webhooks/lithic -d '{}'` | **yes, right now** |
| The USDC payout on Base Sepolia | nothing — the public explorer link above | **yes, right now** |
| `pnpm test`, `pnpm typecheck`, `pnpm lint` | the repo | **yes** — `137 files, 2485 passed, 389 skipped` with no credentials; the 389 are the integration tests, which need `RUN_DB_TESTS=1` and a database, and skip loudly rather than passing vacuously |
| **Everything in `scripts/evidence.mjs` §1–§2** | the repo **and** a database URL | on request — read-only Neon access can be provisioned; the URL is a secret and is not in the repo |
| **`scripts/evidence.mjs` §3–§6 provider legs** | the repo **and** sandbox API keys | on request, or via the screenshots in §5 |
| `node scripts/livefire.mjs`, `pnpm db:check` | the repo and a database URL | on request |

**This is why the shot list exists at all.** Screenshots are not a better form of
evidence; they are the substitute for credentials that cannot be pasted into an
email. So the shot list covers exactly the things a grader cannot otherwise check
— provider-side account ownership, the environment badge, and the send side of
the wire — and nothing else.

`pnpm db:check` reads **35 passed, 1 failed** on this commit. The failure is
deliberate and named: `v_refused_auth_hold is empty — 149 row(s)`, holds that
withhold money against an authorisation whose result was never retained. It is
left red because a guard that has been quietly excepted is not a guard. See
DECISIONS and `docs/AUDIT.md`.

---

## 5. The shot list — three screenshots

Each one says what it adds **beyond** the runnable. Nothing is asked for twice.

**Before you start.** Do not capture an unmasked API key or webhook secret.
Provider dashboards mask secrets by default — leave them masked. Crop or blur
anything beginning `sk_`, `whsec_`, `secret_` or `access-sandbox-`.

### Shot 1 — Lithic: the subscription and its delivery log

```
https://sandbox.lithic.com  →  Developers → Webhooks → ep_3J8yb9xommtOdKee1FzpUA4GBrW
```

**Must be in frame:**

- the **sandbox environment indicator**, and the account/team name
- token `ep_3J8yb9xommtOdKee1FzpUA4GBrW`
- URL `https://corgi-trial-psi.vercel.app/api/webhooks/lithic` — the deployed
  origin, not a tunnel, not localhost
- state **enabled**, description *"Corgi work trial - card auth and clearing"*
- the **attempts list, at least eight rows deep**: `SUCCESS` against `202`, with
  timestamps and event tokens

**What it adds beyond the runnable:** two things.

1. **Account ownership and environment.** A grader without our API key cannot
   confirm that this Lithic sandbox account is ours. The logged-in frame is the
   only proof of that.
2. **The send side, rendered by the sender.** Our tables can only show what
   *arrived*. §3.2 already reconciles Lithic's attempts log against our inbox
   through the API, but a grader cannot run that call. This frame is the same
   fact in a form that needs no credential from them.

This is the one shot the brief asks for literally ("screenshots including the
webhook delivery log"), and it is worth taking for that reason alone.

### Shot 2 — Increase: the ACH transfer that settled and then returned R01

```
https://dashboard.increase.com  →  sandbox  →  Transfers → sandbox_ach_transfer_x5vdo5m7b6k924sszlms
```

**Must be in frame:**

- the **sandbox environment badge** and the account name
- id `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`, amount **$6,000.00**
- status **`returned`**
- **`settlement.settled_at` = `2026-09-11T04:15:06Z`, still populated** — this is
  the whole point of the frame and must not be cropped
- return reason **`insufficient_fund`** (R01)
- the event timeline in order: `pending_submission` → `submitted` → settled →
  `returned`

Worth a second frame from the same login if it is free:
*Developers → Event subscriptions →*
`sandbox_event_subscription_001m261qr3eanr8aw8gq2v3605c`, **active**, pointed at
`https://corgi-trial-psi.vercel.app/api/webhooks/increase`, created
`2026-09-10T16:17:12Z`.

**What it adds beyond the runnable:** the **provider's own status vocabulary**,
which is the evidence for a design decision the runnable can only assert.
Increase has **no `settled` status at all** — a settled transfer stays
`submitted` and grows a `settled_at` — and **a return does not erase the
settlement**. That is why `rail_event_semantics` books an ACH return as a *new
event at a new value date* rather than as a correction of the original
(DECISIONS 019), and why the adapter promotes `submitted + settled_at → settled`
explicitly. One frame carries the whole argument. It also proves Increase account
ownership and the sandbox environment, which no API output can.

### Shot 3 — Stripe: the TEST MODE banner

```
https://dashboard.stripe.com/test/webhooks  →  we_1UEAf8DgSL5WTGpm2qVqN478
```

**Must be in frame:**

- the **TEST MODE banner**, unmistakably
- id `we_1UEAf8DgSL5WTGpm2qVqN478`, status **enabled**
- URL `https://corgi-trial-psi.vercel.app/api/webhooks/stripe`
- all four subscribed events:
  `identity.verification_session.verified`, `…requires_input`, `…processing`,
  `…canceled`

**What it adds beyond the runnable:** it answers an **automatic-fail** question
with an independent artefact. "Live-mode API keys" fails the trial outright.
Our own evidence for test mode is our own code — `src/lib/env.schema.ts` refuses
a key beginning `sk_live` at boot, and there is a test asserting it — and a
system's own claim about its own keys is exactly the kind of evidence a grader
should not have to accept. Stripe's banner is not our code. One frame, one
automatic fail closed.

If the same login is already open, the Identity session
`vs_1UEDLcDgSL5WTGpmif87HEZ7` (**verified**, type `document`, `livemode: false`,
2026-09-10T19:09:24Z) is a free second frame in the same tab — the session that
produced the `identity.verification_session.verified` delivery sitting in our
inbox. Optional; the banner is the shot that matters.

---

## 6. Shots deliberately not requested, and why

The instinct is to screenshot every provider. Four are not worth a human's time,
and asking for them would pad the pack with frames that prove nothing new.

| Not requested | Why not |
| --- | --- |
| **Plaid — the keys page** | `/api/health` reports `open_banking: POST /institutions/get -> 200` as a **round trip from the deployed system**. That response is impossible without a valid `client_id` + sandbox secret pair, and that pair is impossible without a Plaid account. The keys page would prove the account exists; the 200 already does, and it is checkable by anyone with a browser. |
| **GLEIF — the business registry slot** | There is no dashboard and no credential. `business_registry` runs on the **public GLEIF LEI register** (`GET api.gleif.org/v1/lei-records/{lei} -> 200`), chosen because every KYB provider on the brief's menu — Middesk, Persona KYB, Sumsub KYB — is gated behind sales or business verification that cannot be passed in a weekend. It is labelled a **substitution** on `/api/health`, not a KYB vendor. Anyone can curl it. |
| **Base Sepolia — the wallet or the transaction** | The explorer link in §3.6 is public and needs no login. A screenshot of a public page is strictly worse than the URL to it. |
| **Persona** | There is no Persona account and no dashboard. Director KYC runs on Stripe Identity instead, `/api/health` says so, and `/api/webhooks/persona` answers **503** rather than pretending. Nothing to photograph. |

Two more absences, in case someone goes looking:

- **There is no outbound-transfer screenshot for the USDC leg**, because the
  evidence is the transaction hash on a public chain and the ledger entry that
  names the block. A dashboard frame would add nothing and imply more.
- **The ACH simulator and the scheme-file simulator are labelled simulators** in
  the code, selected when a key is absent, and they log a `warn` line saying so.
  They are not integrations and have no provider side.

---

## 7. What is live

`/api/health` is the authority. If this file ever disagrees with that endpoint,
**the endpoint is right** — it is computed at load time from real round trips,
and this file is written down.

```
https://corgi-trial-psi.vercel.app/api/health
```

Seven slots, seven live, each with the round trip that proves it:

| Slot | Provider | Evidence string from `/api/health` |
| --- | --- | --- |
| `card_issuing` | Lithic sandbox | `GET /v1/cards -> 200` |
| `card_webhooks` | Lithic | `GET /v1/event_subscriptions -> 200` and `…/attempts -> 200`; subscription enabled at the deployed URL; latest delivery SUCCESS, our endpoint answered **202** |
| `director_kyc` | Stripe Identity (test mode) | `Stripe Identity enabled (Persona not configured)` |
| `business_registry` | **GLEIF LEI register** | `GET api.gleif.org /v1/lei-records/{lei} -> 200` — **a substitution** for Middesk / Persona KYB / Sumsub KYB, all gated |
| `open_banking` | Plaid sandbox | `POST /institutions/get -> 200` |
| `ach_rail` | Increase sandbox | `GET https://sandbox.increase.com/accounts?limit=1 -> 200` |
| `stablecoin` | USDC on Base Sepolia | `15.03 USDC and 68659903703189 wei gas — a transfer is fundable` |

That last string is deliberate. An earlier version of this slot called
`balanceOf`, got a 200, and reported **live** on a wallet holding **zero gas**,
which could not have sent a cent (DECISIONS 016). A liveness probe that cannot
fail is not a probe. The slot now reports the gas balance because the gas balance
is what makes the claim true.

---

## 8. Tick sheet

| # | Evidence | Where | Counts only if |
| --- | --- | --- | --- |
| 0 | The 22 claims | `node scripts/evidence.mjs` | exit `0`, `22 proven, 0 not proven`, and the commit line agrees with the deployment |
| 1 | Live/simulated verdicts | `/api/health` | `live: 7`, `total: 7`, all seven `evidence` strings present |
| 2 | Immutability | `pnpm db:check` | `35 passed, 1 failed`, the failure being `v_refused_auth_hold` and named as deliberate |
| 3 | Live fire | `node scripts/livefire.mjs` | the scoreboard, **with every SKIP block in full** — a skip is not a pass, and each one names what could not be proven |
| 4 | On-chain payout | `sepolia.basescan.org/tx/0x0acfad50…` | block `46666112`, status success, Transfer to `0x…dEaD` |
| 5 | Lithic subscription + delivery log | screenshot, §5 shot 1 | sandbox badge, `ep_3J8yb9xommtOdKee1FzpUA4GBrW`, the production URL, `SUCCESS`/`202` rows |
| 6 | Increase ACH lifecycle | screenshot, §5 shot 2 | `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`, `returned`, **`settled_at` still set**, `insufficient_fund` |
| 7 | Stripe test mode | screenshot, §5 shot 3 | the TEST MODE banner, `we_1UEAf8DgSL5WTGpm2qVqN478`, all four identity events |

---

# LIVE FIRE — run of 2026-09-11T18:29:07Z · PASS 7 · FAIL 0 · SKIP 1 · 312s

```
node scripts/livefire.mjs
target     https://corgi-trial-psi.vercel.app
database   corgi_app@ep-curly-tooth-ayhug2be-pooler.c-5.us-east-2.aws.neon.tech/neondb
providers  Lithic sandbox LIVE · Increase sandbox LIVE
```

One run, against production, posting real money. **A SKIP IS NOT A PASS.**

| # | Attack | Verdict | |
|---|---|---|---|
| 1 | $50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move | **PASS** | 1/1 |
| 2 | $73.40 capture: hold released exactly once, available not clamped | **SKIP** | 2 passed, 1 skipped |
| 3 | Backdated reversal: corrected figure AND as-believed, both at once | **PASS** | 3/3 |
| 4 | Settlement before its authorisation ends exactly where in-order does | **PASS** | 1/1 |
| 5 | Self-approval refused by the DATABASE (SQLSTATE 42501) | **PASS** | 4/4 |
| 6 | Row deleted from tonight's scheme file → `in_ledger_not_file` break | **PASS** | 3/3 |
| 7 | Issuing-provider webhook outage degrades visibly, invents no money | **PASS** | 3/3 |
| 8 | Dedupe against a genuinely signed provider replay: twice is one | **PASS** | 4/4 |

## The one non-PASS, with its reason

**Attack 2 — SKIP.** Two of its three assertions passed: the hold's memo
entries net to zero (one opening, one release, `-5000` then `+5000`), the
$73.40 settled in exactly one financial entry, and available came out
un-clamped and negative — `ledger(4475436) − holds(67000) − uncleared(5550000)`
exactly.

It skipped on the third because **no `hold_closure` row was written**, and the
test records that as *a decision, not a gap*. The reason was measured on the
Lithic sandbox during this very run, which is what makes it worth reading:

> Transaction `123048ca-ec41-462f-96ad-30ae2f51fede`: AUTHORIZATION 5000 →
> CLEARING 7340 (over-capture; status SETTLED, `amounts.hold` 0) → `POST
> /v1/simulate/authorization_advice` 9000 → HTTP 201, Lithic appended
> AUTHORIZATION_ADVICE 9000 APPROVED → CLEARING 1660 APPROVED, settlement now
> -9000.

**Over-capture is not terminal.** After the over-capture the authorisation rose
again and the hold reopened for the un-captured 1660 cents, which the network
then really captured. `hold_closure` is append-only with `PRIMARY KEY
(hold_id)`, so a closure written on `C >= A` would have freed money that was
still authorised, and undoing it needs a `hold_closure_reversal` — the exact
$60 failure migration 0011 exists to clean up. The closure row lands on
something genuinely terminal: `is_final`, an explicit close, or the seven-day
expiry sweep.

That is a defensible design position, but it is **not** the attack's published
claim, so it scores SKIP and not PASS.

## Attack 7 — the assertion that was wrong, and what replaced it

Attack 7 asserted `status === "degraded"` after opening a deliberate silence.
**That assertion encoded the precise defect that had just been removed from the
endpoint underneath it**, so it was rewritten rather than repaired.

Escalation used to be `MAX(webhook_inbox.received_at)` and a clock. That
measures *time since the last webhook* when the question is *are we losing
deliveries*, and it cannot separate "the provider stopped delivering while
transactions were happening" from "nobody swiped a card". Measured on this
deployment at 17:56Z with **no outage in progress**: verdict `stale`,
`degradesDeployment: true`, while the liveness probe read `GET /v1/cards → 200`
in the same response.

`/api/health` now narrows the silence against `card_auth_decision WHERE source =
'provider'` — the ASA record, written synchronously while Lithic holds an
authorisation open at a terminal, on a channel independent of the inbox whose
silence is in question. **Attack 7 induces its outage by sending nothing**, so
the honest verdict is `dormant`.

Measured this run:

```
dark window 179s (started 'fresh' at 6s, 0 restarts)
webhookHealth.lithic.verdict                            stale  (184s, inside the 180-900s band)
published lastDelivery == MAX(webhook_inbox.received_at)  2026-09-11T18:31:10.827Z
transactionInitiation.lithic.verdict                    dormant
transactionInitiation.lithic.initiatedSinceLastDelivery  0   (last initiation 211s ago, BEFORE that delivery)
narrowedDeliveryAlarm                                   true
degradedBy                                              []
status                                                  ok
```

**And the claim the attack's wording is actually about, proven without touching
the subscription:** the run replays its own published facts through
`attributeDeliverySilence` — the same pure function `/api/health` calls — with
exactly one input varied.

| ASA decisions after last delivery | verdict | degradesDeployment | degradedBy | status |
|---|---|---|---|---|
| 0 *(this run's real state)* | `dormant` | false | `[]` | `ok` |
| 1 *(one card at a terminal, 1s later)* | `transacting` | **true** | `["lithic"]` | **`degraded`** |

The narrowing only ever subtracts on a counted zero; it cannot silence an outage
that is losing deliveries.

**NOT PROVEN BY THIS RUN, and stated as such:** that a genuinely disabled
subscription produces the second row end to end. **No Lithic event subscription
was disabled at any point.** Subscription `ep_3J8yb9xommtOdKee1FzpUA4GBrW` was
read twice and reads `disabled: false`; the only PATCH attempted was a no-op
that Lithic rejected with `400 "url" is a required property`, so nothing was
mutated. Inducing a true outage requires disabling the subscription and **then**
transacting — a scripted human step in `docs/DEMO.md` §9, deliberately not
automated, because a subscription left disabled by a crashed or `SIGKILL`ed run
is a broken card rail for the rest of the demo.

Attack 7 also still asserts the customer-facing half, and it passed: the
deployed console renders `data-provider-status="provider-down"`, *"Issuing
provider feed is quiet — lithic"*, *"no delivery for 3 minutes"* against the
endpoint's 185s, **with the balances still rendered underneath rather than
blanked.** The banner keys off `verdict === "stale"`, not off
`degradesDeployment` — so the customer is told the feed is quiet even when the
deployment is correctly not paging anybody, which is the right layering.

## Rows this run wrote

The ledger is append-only; none of this can be removed.

- **Attack 1** — Lithic txn `ace633f6-44b8-486f-a539-6616a2bdab17`; hold
  `c4e146a2-0185-45b1-9c8f-058b20161458` (origin `authorization`); memo entries
  on business `1151e7b5`, available -1129224 → -1134224, ledger unchanged.
- **Attack 2** — Lithic txns `123048ca-ec41-462f-96ad-30ae2f51fede` and
  `f519e1d2-a25e-4fbb-8db8-9ad361572874`; hold
  `1893917f-a8da-4d10-a0ae-a58714dd8593`, 2 memo entries netting 0; one
  financial entry of 7340.
- **Attack 3** — business `f1e1fa3e-0000-4000-8000-000000000003`; entries
  `874eda4f`, `32fcb0c3` (reversal), `b5e42f0a`, `9751e47a` (reversal); inbox
  rows `47ae5814`, `3bc5c882`, `fc07ccea`; booking_seq 11935 → 11948.
- **Attack 4** — transactions `9311f116` (in-order) and `aac5b0c1`
  (`clearing_first`), both ledger delta -7340.
- **Attack 5** — payment instruction `f1031501-1129-4153-8260-e5a5419df67f`
  (420000 cents), 1 approved event by a second human.
- **Attack 6** — recon run `6424e1d5-074a-43cf-8a90-1d074c5b69a5`; planted break
  ref `LF6-MTXAKI1J-3` (139 cents); settlement entries at booking_seq
  11961–11964, synthetic business date 2027-10-18.
- **Attack 7** — business `f1e1fa7e-0000-4000-8000-000000000007`; hold
  `82609905-bb7c-4a53-bc59-9915bd10403e`; event
  `d67a5c6d-20a8-4e43-8565-c4ba70f1e52e`; booking_seq 11965 → 11966.
- **Attack 8** — inbox row `07ddf92c-c99f-47fc-adb0-8f6c0634be3b`, exactly one
  for `msg_3JC4LKRlpPrLmrOQ4IbcfIpJ9Tz` after 1 delivery + 2 signed replays + 1
  tampered replay.

Trial balance read 0 at every assertion point; `v_hold_drift` and
`v_hold_release_drift` both 0.
