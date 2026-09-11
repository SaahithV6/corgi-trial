# Architecture — one money path, end to end

**Purpose.** One diagram, one path, pasteable into an email. It follows a single
dollar through the brief's published core loop: *KYB approval → account opening →
funding → card issue → authorisation → clearing → outbound payment with a second
approver → reversal → reconciliation.*

**The one thing to get right out loud:** there are **two books**, and the
difference between them is the difference between *held* and *posted*.

| | The financial book | The memo book |
| --- | --- | --- |
| Account codes | `1000`–`5000` | `9000`–`9999` |
| What it records | money that has **moved** | money that is **spoken for** |
| Card authorisation | nothing | `DR 9900 / CR 9100` |
| Card clearing | `DR 2100 / CR 2200` | `DR 9100 / CR 9900` (release) |
| Nets to zero | yes, on its own | yes, on its own |

`v_book_not_zero` asserts each book nets to zero **per entity and per book**
independently, so a memo line can never leak into the financial book or vice
versa. An authorisation cannot move the ledger balance, because the only accounts
it is allowed to touch are the ones the ledger balance does not read.

Every figure quoted in this file was measured on **2026-09-11 between 04:26Z and
04:40Z**; the commands are in `docs/DEBRIEF.md` §0.

---

## 1. The money path

```
                                    THE MONEY PATH — one business, end to end
                                    (measured 2026-09-11T04:26–04:28Z, run CL-MTWGFIFT,
                                     Hold Fuzzer Fixture Co., 7 PASS / 0 FAIL / 0 SKIP)

  ┌─ 1. KYB ──────────────────────────────────────────────────────────────────────────────────────┐
  │  GLEIF  GET /v1/lei-records/{lei}      ──┐                                                     │
  │  Stripe Identity  verification_sessions ─┼─► kyb_verification_leg  (append-only, INSERT only)  │
  │  operator review  (named human, reason) ─┘        evidence: live < manual < simulated          │
  │                                                   worst-wins fold over the legs                │
  │                                              canTransact()  ──►  KYB_ALLOWED | KYB_PENDING     │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      │  refusal here writes ZERO rows
                                                      ▼
  ┌─ 2. ACCOUNT OPENING ──────────────────────────────────────────────────────────────────────────┐
  │  migration 0021 open_accounts():  an approval opens the chart, it is not seeded                │
  │     2100/<business>   business current account        (financial, liability)                   │
  │     9100/<business>   card authorisation holds        (MEMO)                                   │
  │     9200/<business>   uncleared credit holds          (MEMO)                                   │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 3. FUNDING from a linked external bank ──────────────────────────────────────────────────────┐
  │  Plaid sandbox  link/token/create → sandbox/public_token/create → item/public_token/exchange   │
  │                 → accounts/get → auth/get → item/get         (the Link BROWSER UI is never     │
  │                                                               driven; the token is minted and  │
  │                                                               not used — stated in code 3x)    │
  │                                                                                                │
  │  ONE TRANSACTION, two facts:                                                                   │
  │     FINANCIAL   DR 1130 ACH receivable — inbound in transit   125000                           │
  │                 CR 2100/<business>                            125000     ◄── LEDGER +$1,250    │
  │     MEMO        DR 9900 Memo contra                           125000                           │
  │                 CR 9200/<business> uncleared credit hold      125000     ◄── AVAILABLE +$0     │
  │                                                                                                │
  │  measured    LEDGER $501,229.36 → $502,479.36   AVAILABLE $497,412.76 → $497,412.76            │
  │  the hold releases at 2026-09-14T13:00:00Z, chosen by funds_availability_policy,               │
  │  effective-dated on (rail, counterparty_class, effective_from) — a MISSING policy is a          │
  │  refusal (NO_AVAILABILITY_POLICY), never a default of zero.                                    │
  │                                                                                                │
  │  WHY A HOLD AND NOT A LATER CREDIT: an ACH credit can be returned after it lands.               │
  │  The money is IN THE BOOK and NOT SPENDABLE. Two facts, therefore two rows.                    │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 4. CARD ISSUE ───────────────────────────────────────────────────────────────────────────────┐
  │  Lithic sandbox  POST /v1/cards  ──►  card 2fbf4656…  last four 6495  state OPEN               │
  │  bound in THIS ledger to  2100/<business>  and  9100/<business>                                │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 5. AUTHORISATION — held, NOT posted ─────────────────────────────────────────────────────────┐
  │                                                                                                │
  │   Lithic ──► POST /api/webhooks/lithic ──► [verify sig] ──► webhook_inbox ──► drain ──►        │
  │                     (Standard Webhooks,      UNIQUE(provider,                after()/cron/     │
  │                      generic verifier)       provider_event_id)              bearer POST       │
  │                                                                                                │
  │   ┌─────────── AND, before any of that, inside the provider's 6000 ms window ──────────────┐   │
  │   │  POST /api/webhooks/lithic-auth   the ASA responder — the ONE route where the          │   │
  │   │  response BODY is the side effect.  decide() is pure. CONTROL_READ_BUDGET_MS = 600.    │   │
  │   │  NOTHING ON THIS PATH POSTS MONEY.  measured: Lithic waits ≈6.19 s then DECLINES       │   │
  │   │  (CUSTOMER_ASA_TIMEOUT). It fails closed, so we answer "no" early WITH A ROW.          │   │
  │   └─────────────────────────────────────────────────────────────────────────────────────────┘  │
  │                                                                                                │
  │   card_auth_event  (append-only, UNIQUE (auth_id, provider_event_id))                          │
  │                          │                                                                     │
  │                          ▼                                                                     │
  │        H(E) = 0 if closed(E) else max(A(E) − C(E), 0)        ── a PURE FUNCTION OF A SET       │
  │        A(E) = Σ authorization + incremental − Σ reversal                                       │
  │        C(E) = Σ clearing + force_post                                                          │
  │                          │                                                                     │
  │                          ▼                                                                     │
  │     MEMO ONLY:   DR 9900 Memo contra     5000                                                  │
  │                  CR 9100/<business>      5000                                                  │
  │                                                                                                │
  │     FINANCIAL:   ── nothing. Not a zero-amount entry. No entry at all. ──                      │
  │                                                                                                │
  │   measured    LEDGER $502,479.36 → $502,479.36   (+$0.00)                                      │
  │               HOLDS    $3,816.60 →   $3,866.60   (+$50.00)                                     │
  │               AVAIL  $497,412.76 → $497,362.76   (−$50.00)                                     │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 6. CLEARING — posted, and the hold comes off ────────────────────────────────────────────────┐
  │  clearing $73.40 against an authorisation of $50.00 — an OVER-CAPTURE, not special-cased       │
  │                                                                                                │
  │     FINANCIAL:   DR 2100/<business>              7340     ◄── the ledger moves, by the         │
  │                  CR 2200 Card network payable    7340         SETTLED amount, not the          │
  │                                                               authorised one                   │
  │     MEMO:        DR 9100/<business>              5000     ◄── the hold comes off, ONCE         │
  │                  CR 9900 Memo contra             5000                                          │
  │                                                                                                │
  │  measured    LEDGER $502,479.36 → $502,405.96   (−$73.40)                                      │
  │              HOLDS    $3,866.60 →   $3,816.60   (−$50.00)                                      │
  │              AVAIL  $497,362.76 → $497,339.36   (−$73.40)                                      │
  │              memo balance $0.00 · v_hold_state active $0.00 · 1 opening entry, 1 releasing     │
  │                                                                                                │
  │  EXACTLY ONCE is structural, not procedural:                                                   │
  │     journal_entry.idempotency_key is UNIQUE, and it is `hold:<holdId>:after:<providerEventId>` │
  │     — derived from the SOURCE FACT, never from a uuid we generate. A redelivered webhook       │
  │     cannot append a second delta, because Postgres refuses the row.                            │
  │                                                                                                │
  │  OUT OF ORDER is not a case. A clearing that arrives before its authorisation is the SAME SET  │
  │  assembled in a different order, and Σ / ∃ / max are permutation-invariant. Measured by the    │
  │  fuzzer: 1,286,000 sets, 6,257,911 orderings, ZERO disagreements on byte-identical HoldState.  │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 7. OUTBOUND PAYMENT, second approver ────────────────────────────────────────────────────────┐
  │  Staff raises  $3,200.00 ACH ──► canTransact() ──► payment_instruction                         │
  │                                    (KYB gate runs INSIDE requestPayment)                       │
  │                     policy: threshold $2,500.00, 1 approval required                           │
  │                     the approval names a HASH OF THE AMOUNT, not the row                       │
  │                                                                                                │
  │     Priya Raman (maker) presses approve on her own instruction                                 │
  │        ──► REFUSED  NOT_AN_APPROVER / SELF_APPROVAL, 0 events written                          │
  │        the refusal's source, read from the live database:                                      │
  │            assert_maker_checker()  ·  trigger payment_instruction_event_maker_checker          │
  │            SQLSTATE 42501                                                                      │
  │        The screen ALSO disables the control. The screen is not the guard.                      │
  │        coreloop assembles the POST by hand to reach the trigger anyway.                        │
  │                                                                                                │
  │     Dana Okonkwo (approver) approves ──► Increase sandbox ──► ACH credit transfer              │
  │                                                                                                │
  │     FINANCIAL:   DR 2100/<business>              320000                                        │
  │                  CR 2300 ACH payable — outbound in transit                                     │
  │                     … then on settlement:  DR 2300 / CR 1110 Cash — FBO at sponsor bank        │
  │                                                                                                │
  │  The agent surface (POST /api/mcp, 8 tools) lands in this SAME queue. initiate_payment writes  │
  │  one payment_instruction and nothing else. An agent can never be the checker.                  │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 8. REVERSAL — the bitemporal correction ─────────────────────────────────────────────────────┐
  │  Lithic  POST /v1/simulate/return          ──► refund posts at value_date 2026-09-11, seq 2319 │
  │  Lithic  POST /v1/simulate/return_reversal ──► correction, seq 2344                            │
  │                                                                                                │
  │  routed by a ROW, not by an `if`:                                                              │
  │     rail_event_semantics( card_transaction.updated / RETURN_REVERSAL )                         │
  │       → kind=refund_reversal  semantics=CORRECTION  value_date_source=original.value_date      │
  │     an event with NO semantics row PARKS the whole payload. There is no default.               │
  │                                                                                                │
  │     reverseAndRebook():  a new entry, at the ORIGINAL value date, in the ORIGINAL group        │
  │                          idempotency  reversal:<original entry id>                             │
  │                                                                                                │
  │  BOTH AXES, measured on account 2eb04bde…:                                                     │
  │     value_date    original 2026-09-11   correction 2026-09-11   ── SAME DAY                    │
  │     booking_seq   original 2319         correction 2344         ── LATER                       │
  │     as believed   $502,479.36   read at watermark 2319                                         │
  │     as corrected  $502,405.96   read at watermark 2344                                         │
  │     difference        −$73.40   exactly the refund taken back                                  │
  │                                                                                                │
  │  Tuesday's figure changed. Wednesday's belief is still reproducible.                           │
  │  NOTHING WAS REWRITTEN — the only verb is INSERT.                                              │
  └───────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                      ▼
  ┌─ 9. RECONCILIATION against the scheme file ───────────────────────────────────────────────────┐
  │  nightly file ──► recon_run ──► pairing RE-DERIVED from provider references on EVERY run       │
  │                                  (recon_match is append-only EVIDENCE of the first pairing,    │
  │                                   never the definition of "matched" — a UNIQUE(entry_id)       │
  │                                   definition reports a re-issued file as PERFECT)              │
  │                                                                                                │
  │     in_file_not_ledger · in_ledger_not_file · amount_mismatch                                  │
  │     aging is measured in DAY CLOSES, not hours:  open → aged → stale → critical                │
  │     in_ledger_not_file EXCLUDES groups whose net is zero — a booked-then-reversed entry is     │
  │     AGREEMENT with a file that never mentioned it, not a break.                                │
  │                                                                                                │
  │  measured   file livefire-MTVRTYAB-tonight.csv, 3 rows, $694.99                                │
  │             break  In ledger, not in file  ref LF6-MTVRTYAB-3  $240.71  unmatched_reference    │
  └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Where money is held versus posted — the one-screen answer

```
   available = ledger − card holds − uncleared credits − committed future outflows
               └──────┘   └────────────────────────────┘   └──────────────────────┘
                 9000                                            value_date > today
              1000–5000    memo book, per business                on the 2100 leaf
              financial    9100 cards · 9200 uncleared           (debits only)

   ONE BODY:  ledger_availability()  — a Postgres FUNCTION, migration 0022.
              v_available_balance calls it. The TypeScript calls it.
              Neither CONTAINS a definition, so neither can drift from the other.

   The asymmetry is deliberate and it is the whole argument:
     a future-dated CREDIT is NOT available  — you cannot spend tomorrow's settlement today
     a future-dated DEBIT  IS subtracted     — it is already booked to leave

   A definition symmetric in VALUE DATE is asymmetric in RISK, and the risk is whose
   money it is.
```

**Nothing is stored.** There is no balance column anywhere in the money schema.
`dbcheck` asserts this by scanning `information_schema` for column names that
look like stored balances, with three named exceptions, each proven reproducible:
`statement.opening_balance_cents` / `closing_balance_cents` (a published artefact
— the figure it *asserted* must stay queryable for ever, which is the as-published
axis of the bitemporal model) and `interest_posting.basis_balance_cents` (proven
by re-deriving `ledger_settled_cents` at the recorded watermark, row by row).

---

## 3. The immutability stack — four layers, each of which can fail alone

```
  ┌─ 1. PRIVILEGES ────────────────────────────────────────────────────────────┐
  │  the app connects as corgi_app, which holds SELECT + INSERT and nothing     │
  │  else on journal_entry, journal_line, card_auth_event, hold_closure.        │
  │  Measured 2026-09-11T04:28Z: UPDATE / DELETE / TRUNCATE all refused with    │
  │  "permission denied for table journal_entry".                               │
  │  Privileges NEVER bind the table owner — this layer was worth nothing for   │
  │  the first three hours of the build, because the app connected as the       │
  │  owner. DECISIONS 008.                                                      │
  ├─ 2. TRIGGERS ──────────────────────────────────────────────────────────────┤
  │  row-level refusals on UPDATE/DELETE, plus a STATEMENT-level one for        │
  │  TRUNCATE (which is why TRUNCATE was refused even as the owner).            │
  │  assert_entry_balanced(): every entry sums to zero PER CURRENCY.            │
  │  assert_maker_checker(): SQLSTATE 42501, the initiator cannot approve.      │
  ├─ 3. NO `ON CONFLICT DO UPDATE` ────────────────────────────────────────────┤
  │  the only conflict action on a money table is DO NOTHING. An upsert is an   │
  │  UPDATE wearing an INSERT's clothes, and the automatic-fail clause says     │
  │  "UPDATE or DELETE on money rows. Anywhere. Ever."                          │
  ├─ 4. SHA-256 HASH CHAIN ────────────────────────────────────────────────────┤
  │  each journal_entry carries the hash of its own content chained to its      │
  │  predecessor, computed inside ledger_append() — a SECURITY DEFINER function │
  │  with SET search_path = public, pg_temp (pg_temp LAST, deliberately: omit   │
  │  it and Postgres searches it FIRST and a caller can shadow digest/nextval   │
  │  with a temp object and run its own code as the owner).                     │
  │  Layers 1–3 stop the application. Layer 4 detects an operator with the      │
  │  owner role, which is the only actor the first three cannot bind.           │
  └────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Evidence, not adjectives

```
  live < manual < simulated          an ASCENDING WEAKNESS order, so the
   │       │         │               existing worst-wins fold over the legs
   │       │         └─ a fixture    needed no special case at all.
   │       └─ a NAMED human, with a written reason, ≥20 chars, on an
   │          append-only row whose composite FK (actor_id, actor_kind)
   │          → actor(id, kind) plus a human-only kind check is what makes
   │          "an agent cannot approve a KYB leg" true. The FK alone is
   │          MATCH SIMPLE and a NULL kind sails straight through it.
   └─ a real authenticated third-party call that returned 2xx

  LIVE is earned by a ROUND TRIP, never by a credential existing:
     live          a real authenticated call returned 2xx
     unauthorised  the credential exists and the provider REJECTED it
     unreachable   network or provider failure — we do not know
     unprobed      we have not asked; we DECLINE TO CLAIM it
     not_configured no key at all
  Only `live` earns the LIVE label. Everything else reads SIMULATED, because
  over-claiming is the automatic fail and under-claiming is merely pessimistic.
```

Measured at **2026-09-11T04:28:33Z**, `GET /api/health` reports **7 of 7 live**:
`card_issuing` (Lithic `GET /v1/cards` 200), `card_webhooks` (Lithic
`GET /v1/event_subscriptions` + that subscription's `/attempts` showing our
endpoint answering HTTP 202), `director_kyc` (Stripe Identity), `business_registry`
(GLEIF `GET /v1/lei-records/{lei}` 200, Apple Inc.), `open_banking` (Plaid
`POST /institutions/get` 200), `ach_rail` (Increase `GET /accounts` 200),
`stablecoin` (15.03 USDC + 68,659,903,703,189 wei — *a transfer is fundable*, which
is the capability, not the credential).

---

## 5. Webhook path, in one line each

```
  provider ──► POST /api/webhooks/<provider>
                 │
                 ├─ Standard Webhooks signature verified (ONE generic verifier;
                 │  the per-provider copy was deleted, not kept "just in case")
                 │
                 ├─ INSERT INTO webhook_inbox  UNIQUE (provider, provider_event_id)
                 │  payload stored ::text::jsonb — a bare ::jsonb makes the driver
                 │  send a JSON-typed parameter and Postgres quotes it a SECOND time,
                 │  so every payload->>'field' reads nothing. Found only in production.
                 │
                 ├─ 202, immediately. NO consumer runs inline: a provider needs its
                 │  2xx in seconds and Plaid retries for 24 hours without one.
                 │
                 └─ drain, by three triggers chosen because each fails differently:
                      after()          fast path. A NUDGE, never the mechanism —
                                       it can be dropped when an instance is recycled.
                      cron /api/drain  the guarantee. DAILY, because Vercel Hobby
                                       caps cron at once per day. Worst-case LATENCY,
                                       not worst-case correctness: the row stays
                                       `pending` until a consumer succeeds.
                      bearer POST      the demo. "Watch, I will drain it now."
```

---

## 6. Module map

```
  src/lib/ledger/      post.ts · queries.ts · readers.ts · chart.ts · balance-definitions.ts
                       THE ONLY MODULE ALLOWED TO WRITE SQL AGAINST journal_entry,
                       journal_line, account. boundary.test.ts enforces it as a RATCHET:
                       235 references across 50 files, each allowlisted with its owning
                       module named, and a file may hold FEWER than its recorded count,
                       never more. The list can only shrink.
  src/lib/holds/       model.ts (H(E), pure) · lithic-events.ts (provider → our vocabulary)
                       apply.ts · store.ts · corrections.ts · expiry.ts · fuzz.test.ts
  src/lib/cards/       the ASA responder's decide(), RULE_ORDER, the control store
  src/lib/webhooks/    the generic verifier, the inbox, the dispatcher/drain
  src/lib/rails/       ach (Increase) · internal · stablecoin (direct signer + Circle)
                       ONE interface. A rail is an adapter, not a schema.
  src/lib/kyb/         the composite provider, the evidence lattice, the operator review
  src/lib/approvals/   policy lookup, the amount hash, the queue
  src/lib/recon/       import, pairing, the breaks ladder
  src/lib/statements/  a closed day, reproducible for ever
  src/lib/standing/    the occurrence is the unit
  src/lib/mcp/         8 tools — 7 read, 1 that queues for a human
  src/lib/{pots,payees,fx,onboarding,disputes,accrual}/
```

---

*Every number in this file was run on 2026-09-11 between 04:26Z and 04:40Z.
Twelve agents are writing this repo concurrently; treat any figure here as true
as of its stamp and re-run the command before quoting it. The commands are in
`docs/DEBRIEF.md` §0.*
