# ACH rail selection — Increase vs. Moov vs. Modern Treasury

Corgi trial, Track 3. Research date **2026-09-09**. No accounts were created; every
claim below is from public docs or an unauthenticated page fetch. Anything I could
not confirm without signing up is marked **UNCONFIRMED**.

**Recommendation: Increase sandbox**, with **Modern Treasury as a pre-committed
fallback** and a 10-minute go/no-go check before writing any adapter code (see
[§0](#0-the-go-no-go-check-do-this-first)).

---

## 1. Self-serve availability — the deciding factor

| | **Increase** | **Moov (test mode)** | **Modern Treasury** |
|---|---|---|---|
| Public self-serve signup URL | `dashboard.increase.com/signup` | `dashboard.moov.io/signup` | `app.moderntreasury.com/sign_up` |
| Signup gated behind sales/demo? | **No** — "Sign up" is a top-level nav CTA alongside "Contact sales" | **No** — "Start building" on the pricing page; "Get a demo" is optional | **No** — but the marketing site pushes "Talk to us" first; "Start building" is secondary |
| Docs explicitly say sandbox is granted at signup? | Implied only: "Obtain API keys by signing up for an Increase account via the dashboard" | **Yes, explicitly**: "Creating an account gives you access to test mode" | **Yes, explicitly**: "Every organization is initially provisioned two environments, one live and one sandbox" |
| Business verification / KYB for sandbox? | **UNCONFIRMED** — no doc says either way | **No.** Test account is pre-populated with sample business details; all capabilities auto-enabled; "You aren't required to enter anything for your test account to receive the `verified` status" | **No** for sandbox. Live mode is gated on onboarding progress |
| What the signup form asks for | **UNCONFIRMED** — SPA, form fields not readable unauthenticated | **UNCONFIRMED** — not enumerated in docs | **Confirmed by page inspection**: one field, `Enter your work email address...`, then Continue |
| Personal-email risk | Unknown | Unknown | **Real** — field says "work email"; gmail may be rejected. **UNCONFIRMED** |
| Sandbox free? | Not priced; no money moves. **UNCONFIRMED** in writing | **UNCONFIRMED** whether the $500/mo production minimum touches test mode | **UNCONFIRMED** — pricing entirely gated, no free tier published |
| Production requires a sales call? | **Yes** — pricing page: "Monthly fees for users building on Increase vary by use case — Contact Sales" | **Yes** — "you'll need to work with Moov directly and provide the necessary onboarding documentation"; **$500/mo minimum** | **Yes** — "usage-based pricing" with a minimum commitment, single CTA "Talk to us" |
| **Verdict for a 48h trial** | Public signup, unverified instant | **Best-documented no-KYB instant sandbox** | Confirmed self-serve form, gmail risk |

**Honest summary:** all three are *nominally* self-serve for sandbox and all three
require a sales conversation for production. Only **Moov** and **Modern Treasury**
have documentation that states in so many words that sandbox access is granted at
signup with no verification. Increase's signup page is public and its sandbox API
answers on the open internet (`GET https://sandbox.increase.com/accounts` returns a
clean `401 invalid_api_key_error`, not a 403 or a marketing redirect), but I could
not confirm without signing up that a fresh account gets sandbox keys with no
business details.

I still recommend Increase, because on every axis that this brief says matters —
**returns**, delayed settlement, and webhook integrity — it is not close. See §3.

### 0. The go/no-go check — do this first

Before writing a line of adapter code:

1. Sign up at `https://dashboard.increase.com/signup`.
2. If you land in a dashboard with a **sandbox API key** in
   `Developers → API keys` — proceed with Increase. Total time ~5 min.
3. If you hit an application form, a "we'll be in touch", or a KYB wall —
   **stop, switch to Modern Treasury** (`app.moderntreasury.com/sign_up`). Its
   return simulation is nearly as good (§6.1) and it is confirmed self-serve.
   The `PaymentRail` interface in `adapter.draft.ts` does not change; only the
   adapter class does. That is the entire point of the interface.

Budget: 20 minutes for this branch. Do not spend the trial arguing with a signup form.

---

## 2. Feature comparison at a glance

| | Increase | Moov | Modern Treasury |
|---|---|---|---|
| Force a return | **Explicit API**: `POST /simulations/ach_transfers/{id}/return` | Magic **amount** (`$55.01` → R01) | Magic **account number** (`10001` → R01) |
| Choose the return code | **Yes** — ~80 named reasons | Yes — 14 fixed amounts | **Yes** — `100XX` → R`XX`, any code |
| Return code on an *arbitrary* transfer | **Yes** | **No** — code is baked into the amount, and only fires on a leg that exists (R01 needs a debit leg) | **No** — code is baked into the counterparty account |
| Simulate NOC / COR | **Yes** — dedicated endpoint | **No** (hosted sandbox) | **Yes** — `200XX` → C`XX`, auto-updates the external account |
| Drive settlement deterministically | **Yes** — separate `submit` / `acknowledge` / `settle` endpoints | No — ~1 hour wall clock on weekdays | No — seconds, automatic |
| Webhook signature covers the body | Yes | **No — headers only** | Yes |
| Webhook signature has a timestamp / replay protection | **Yes** | Partial (`X-Nonce`, but unsigned body) | **No** |
| Idempotent replay returns the original response | **Yes** (`Idempotent-Replayed: true`) | **No — 409** | **Yes** (cached 24h) |

The row that decided it: **"return code on an arbitrary transfer."** Increase lets
you take *the transfer you already created in your demo* and return it with any
code. The other two require you to have known, at creation time, that this
particular payment was going to be returned and with which code. For a demo that
shows return handling — including "an R01 arrives four days after settlement, and
here is what the ledger does" — that difference is the whole exercise.

---

## 3. Winner: Increase

### 3.1 Environment and auth

| | |
|---|---|
| Sandbox base URL | `https://sandbox.increase.com` |
| Production base URL | `https://api.increase.com` |
| Auth | `Authorization: Bearer ${INCREASE_API_KEY}` |
| Keys | Signup issues a pair — one sandbox, one production. Managed at `dashboard.increase.com/developers/api_keys` |
| Errors | RFC 9457 problem details: `{ type, title, status, detail }` |
| Pagination | `{ data, next_cursor }`, default `limit` 100 |

Sandbox has full feature parity: "Every API and dashboard feature is available in
Sandbox." Simulation APIs exist **only** in sandbox.

Docs: [API overview](https://increase.com/documentation/api/overview) ·
[Sandbox](https://increase.com/documentation/sandbox)

### 3.2 Creating transfers — one endpoint, both directions

`POST /ach_transfers` does credits *and* debits. **The sign of `amount` picks the
direction:**

> "The transfer amount in USD cents. A positive amount indicates a credit transfer
> pushing funds to the receiving account. A negative amount indicates a debit
> transfer pulling funds from the receiving account."

**Required:** `account_id`, `amount`, `statement_descriptor`.

**Destination is supplied one of two ways** (mutually exclusive):

- **Raw:** `routing_number` (9-digit ABA) + `account_number`, plus optional
  `funding` (`checking` | `savings` | `loan` | `general_ledger`).
- **Stored:** `external_account_id` — an External Account object created once. Prefer
  this in production so raw account numbers do not re-enter the request path.

**Other useful fields:** `individual_name`, `individual_id`, `company_name`,
`company_entry_description`, `destination_account_holder`
(`business` | `individual` | `unknown`), `preferred_effective_date`, `addenda`,
`require_approval`.

**SEC codes** — field `standard_entry_class_code`. All of CCD/PPD/WEB are supported:

| Nacha | Increase enum | Use |
|---|---|---|
| CCD | `corporate_credit_or_debit` | **default** — business ↔ business |
| PPD | `prearranged_payments_and_deposit` | consumer, written/recurring authorisation |
| WEB | `internet_initiated` | consumer, authorised online or in-app |
| CTX | `corporate_trade_exchange` | B2B with structured remittance addenda |

For **ACH debits** Increase automatically allocates a Pending Transaction with
category `inbound_funds_hold` and a negative amount offsetting the debit, and
releases it "when the two-business-day return window has passed." That hold is
free, correct behaviour you would otherwise have to build yourself — and it is the
thing the ledger design should mirror.

Docs: [ACH transfers](https://increase.com/documentation/api/ach-transfers) ·
[Sending ACH debits](https://increase.com/documentation/sending-ach-debit-transfers) ·
[SEC codes](https://increase.com/documentation/ach-standard-entry-class-codes)

### 3.3 Inbound ACH (money arriving at us)

Two distinct things, don't conflate them:

- **An inbound ACH debit we originate** (pulling from a customer's bank) is just
  `POST /ach_transfers` with a negative `amount`. This is `initiateDebit`.
- **An inbound ACH someone else originates** (they push to, or pull from, our
  account) creates an **Inbound ACH Transfer** object. Simulate one with
  `POST /simulations/inbound_ach_transfers`
  (`account_number_id`, `amount` — negative for an inbound debit —
  `standard_entry_class_code`, `company_name`, `receiver_name`, `resolve_at`).

Inbound ACH Transfer statuses: `pending` → `accepted` | `declined` | `returned`.
`pending` means "awaiting action, will transition automatically if no action is
taken"; `automatically_resolves_at` is the deadline. Actions:

- `POST /inbound_ach_transfers/{id}/decline` — before settlement, optional `reason`
- `POST /inbound_ach_transfers/{id}/transfer_return` — required `reason`; allowed
  only "up to a cutoff date of 2 banking days after the transfer's effective date"
- `POST /inbound_ach_transfers/{id}/create_notification_of_change`

Docs: [Receiving ACH transfers](https://increase.com/documentation/receiving-ach-transfers) ·
[Inbound ACH transfers API](https://increase.com/documentation/api/inbound-ach-transfers)

### 3.4 The state machine

Outbound ACH Transfer `status` enum, exact values:

```
pending_approval
pending_transfer_session_confirmation
pending_submission
pending_reviewing
submitted
returned
rejected
requires_attention
canceled
```

Normal path:

```
                                       ┌─ rejected  (pre-submission, compliance)
POST /ach_transfers                    │
  └→ pending_submission ──→ submitted ─┼─ settlement.settled_at stamped
                                       │        (status STAYS "submitted")
                                       └─→ returned  (return.* populated)

with require_approval: pending_approval ─→ pending_submission | canceled
```

**The trap worth writing down: there is no `settled` status.** Settlement is
recorded as a *timestamp*, `settlement.settled_at`, on a transfer whose status is
still `submitted`. If your mapper keys only off `status`, you will never release a
hold. `adapter.draft.ts` promotes `submitted` + `settlement.settled_at` → our
`settled` for exactly this reason.

Sub-objects that mark progress: `acknowledgement.acknowledged_at` (FedACH said
"got it" — typically within ~15 min in production), `submission.submitted_at` +
`submission.trace_number`, `settlement.settled_at`, `return` (see below),
`notifications_of_change[]`.

**Sandbox timing.** Sandbox transfers are never sent to the Federal Reserve. The
docs say transfers auto-advance — "once FedACH acknowledges a transfer, Increase
settles it automatically at the expected settlement time" — but the reliable move
is to drive it yourself with the simulation endpoints, which is deterministic and
instant. **UNCONFIRMED:** whether sandbox auto-advance runs on a real wall-clock
timer or fires immediately. Assume you must call the simulations. There is
deliberately **no** sandbox simulation for `rejected`.

Docs: [Sending ACH transfers](https://increase.com/documentation/sending-ach-transfers)

### 3.5 ★ Forcing a return — the key question

**Mechanism: a dedicated sandbox endpoint, with a free choice of reason code.**

```
POST /simulations/ach_transfers/{ach_transfer_id}/return
  body: { "reason": "<return_reason_code>", "addenda_information": "<optional>" }
```

`reason` is the `return_reason_code` enum — ~80 named values, one per Nacha code.
The three the brief asks for (note R01 is spelled **singular**, `insufficient_fund`):

| Nacha | Increase `reason` | Meaning |
|---|---|---|
| **R01** | `insufficient_fund` | "The available balance is not sufficient to cover the amount of the debit entry." |
| **R02** | `account_closed` | "The previously active account has been closed by the customer or the bank." |
| **R03** | `no_account` | "The account number does not correspond to the individual identified in the entry." |

The resulting `return` sub-object carries `return_reason_code` (the enum name),
`raw_return_reason_code` (the literal Nacha string), `created_at`, `trace_number`,
`transaction_id`, `transfer_id`, `addenda_information`. Increase "will automatically
reconcile it with the originating transfer and create a new Transaction to reduce
your balance" — i.e. the return is a second money movement, not an edit of the
first. Model your ledger the same way.

**The full sandbox toolkit** (all sandbox-only):

| Endpoint | Effect |
|---|---|
| `POST /simulations/ach_transfers/{id}/submit` | → `submitted` |
| `POST /simulations/ach_transfers/{id}/acknowledge` | adds `acknowledgement` |
| `POST /simulations/ach_transfers/{id}/settle` | stamps `settlement.settled_at`; optional `inbound_funds_hold_behavior` |
| `POST /simulations/ach_transfers/{id}/return` | → `returned` with your chosen `reason` |
| `POST /simulations/ach_transfers/{id}/create_notification_of_change` | **NOC/COR** — `corrected_routing_number`, `corrected_account_number`, `corrected_account_funding`, `corrected_individual_id` |
| `POST /simulations/inbound_ach_transfers` | someone else sends/pulls money at us |

**NOC/COR: yes, fully simulable**, and it is a first-class endpoint rather than a
side-effect of a magic value. This matters — NOC is how you learn a customer's
account details changed without a failed payment, and handling it is a visible
correctness win in a neobank demo.

Calling any simulation endpoint fires the corresponding webhook to your configured
event subscription, so the whole loop is exercisable end to end.

Sandbox test routing numbers (from
[sandbox test values](https://increase.com/documentation/sandbox-test-values)):
`110000000` Example Bank, `101050001` First Bank of the US, `790000006` Alpha,
`790000019` Bravo, `790000022` Charlie, `790000035` Echo, `790000048` Foxtrot,
`790000051` No Transactions Bank (returns `not_supported` for every method),
`790000064` Partial Transactions Bank (ACH + Wire only). Note these gate *method
support*, not return codes — return codes come from the simulation endpoint.

Docs: [ACH returns](https://increase.com/documentation/ach-returns) ·
[ACH transfers API](https://increase.com/documentation/api/ach-transfers)

### 3.6 Webhooks

**Registration:** `POST /event_subscriptions` (or the dashboard).
Params: `url` (required), `selected_event_categories[]`, `shared_secret`
("The key that will be used to sign webhooks"), `oauth_connection_id`, `status`.
Statuses: `active` | `disabled` | `deleted`.

**Event categories** relevant here:

```
ach_transfer.created
ach_transfer.updated
inbound_ach_transfer.created
inbound_ach_transfer.updated
transaction.created
declined_transaction.created
```

There is **no** `ach_transfer.returned` category — a return arrives as
`ach_transfer.updated`.

**The payload is the Event object, not the transfer:**

```json
{
  "id": "event_123abc",
  "type": "event",
  "category": "ach_transfer.updated",
  "associated_object_id": "ach_transfer_uoxatyh3lt5evrsdvo7q",
  "associated_object_type": "ach_transfer",
  "created_at": "2026-09-09T12:00:00Z"
}
```

So the webhook tells you *what changed*, and you `GET /ach_transfers/{id}` to learn
*how*. This is a feature: the read-back is authoritative, and out-of-order webhook
delivery becomes harmless. `adapter.draft.ts` implements this as
`parseEventWithTransfer`.

**Signature verification — Standard Webhooks spec.** Increase is the only one of
the three with real replay protection.

| | |
|---|---|
| Headers | `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature` |
| Algorithm | HMAC-SHA256, then **Base64** |
| Signed payload | `` `${webhook-id}.${webhook-timestamp}.${rawBody}` `` |
| Signature format | `v1,<base64>` — the header may hold **several space-separated** signatures during secret rotation; accept if **any** matches |
| Timestamp tolerance | Not fixed by Increase; docs recommend **5 minutes** |
| Key | the `shared_secret` on the Event Subscription |

Example signed string:
`event_123abc.1674087231.{"id":"event_123abc",...}`

Reference implementation (Ruby, from the docs):

```ruby
signed_payload = "#{webhook_id}.#{webhook_timestamp}.#{request_body}"
expected_signature =
  'v1,' + Base64.strict_encode64(
    OpenSSL::HMAC.digest('SHA256', signing_secret, signed_payload))
verified = webhook_signature_header.split(' ')
  .any? { |s| OpenSSL.secure_compare(s, expected_signature) }
```

Verify against the **raw body bytes**. Re-serialising the parsed JSON is the
classic way to break this. In Next.js that means reading `await req.text()` in the
route handler before any JSON parsing.

Docs: [Webhooks](https://increase.com/documentation/webhooks) ·
[Event subscriptions API](https://increase.com/documentation/api/event-subscriptions)

### 3.7 Idempotency

- Header: **`Idempotency-Key`** — one unique value per intended request.
- **Replay with identical params:** returns the **original object**, HTTP **200**,
  plus the header **`Idempotent-Replayed: true`**.
- **Replay with different params:** HTTP **409**, `type:
  idempotency_key_already_used_error`, and the body carries the `resource_id` of the
  object the key is already bound to.
- Guarantee: "no more than one transfer is created."
- **UNCONFIRMED:** retention window for keys — not stated in the docs.

This is the best of the three: a network timeout can be retried with the same key
and you get the transfer object back, so the client never has to do a lookup to
find out what happened.

Docs: [Idempotency keys](https://increase.com/documentation/idempotency-keys)

### 3.8 curl — create an outbound ACH credit

```bash
export INCREASE_API_KEY=sandbox_key_...
export BASE=https://sandbox.increase.com

curl -sS -X POST "$BASE/ach_transfers" \
  -H "Authorization: Bearer $INCREASE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "account_id": "account_in71c4amph0vgo2qllky",
    "amount": 12345,
    "statement_descriptor": "CORGI PAY",
    "routing_number": "101050001",
    "account_number": "987654321",
    "funding": "checking",
    "standard_entry_class_code": "corporate_credit_or_debit",
    "individual_name": "Ian Crease",
    "destination_account_holder": "business"
  }'
```

### 3.9 curl — create an inbound ACH debit (pull funds)

Same endpoint. **Negative amount.** WEB because it is a consumer authorising online:

```bash
curl -sS -X POST "$BASE/ach_transfers" \
  -H "Authorization: Bearer $INCREASE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "account_id": "account_in71c4amph0vgo2qllky",
    "amount": -12345,
    "statement_descriptor": "CORGI FUND",
    "routing_number": "101050001",
    "account_number": "987654321",
    "funding": "checking",
    "standard_entry_class_code": "internet_initiated",
    "individual_name": "Ian Crease",
    "destination_account_holder": "individual"
  }'
```

### 3.10 ★ curl — force an R01 return

Full deterministic lifecycle: create → submit → settle → **return R01**.

```bash
# 1. create (capture the id)
TRANSFER_ID=$(curl -sS -X POST "$BASE/ach_transfers" \
  -H "Authorization: Bearer $INCREASE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "account_id": "account_in71c4amph0vgo2qllky",
    "amount": -5000,
    "statement_descriptor": "R01 TEST",
    "routing_number": "101050001",
    "account_number": "987654321",
    "standard_entry_class_code": "internet_initiated",
    "individual_name": "Ian Crease"
  }' | jq -r .id)

# 2. hand it to the "Fed"          -> status: submitted
curl -sS -X POST "$BASE/simulations/ach_transfers/$TRANSFER_ID/submit" \
  -H "Authorization: Bearer $INCREASE_API_KEY"

# 3. settle it                     -> settlement.settled_at stamped, status still "submitted"
curl -sS -X POST "$BASE/simulations/ach_transfers/$TRANSFER_ID/settle" \
  -H "Authorization: Bearer $INCREASE_API_KEY"

# 4. THE RETURN                    -> status: returned, return.return_reason_code = insufficient_fund
curl -sS -X POST "$BASE/simulations/ach_transfers/$TRANSFER_ID/return" \
  -H "Authorization: Bearer $INCREASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "insufficient_fund" }'
```

Swap step 4's `reason` for `account_closed` (R02) or `no_account` (R03). Each step
fires an `ach_transfer.updated` webhook.

**Simulate a NOC instead of a return:**

```bash
curl -sS -X POST \
  "$BASE/simulations/ach_transfers/$TRANSFER_ID/create_notification_of_change" \
  -H "Authorization: Bearer $INCREASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "corrected_account_number": "111222333", "corrected_routing_number": "110000000" }'
```

### 3.11 Known gaps / risks with Increase

- **UNCONFIRMED:** whether sandbox keys are truly issued instantly with no business
  details. This is the single assumption the recommendation rests on. See §0.
- Production is definitively a sales conversation and involves a partner bank
  (Increase Bank, Grasshopper, First Internet Bank of Indiana, or Core Bank).
  Irrelevant for a 48h trial; relevant to say out loud in the write-up.
- No sandbox simulation for `rejected` (pre-submission compliance rejection) — that
  path can only be reasoned about, not demoed.
- The `requires_attention` status has no documented recovery path via API; treat it
  as "page a human."
- Return reason enum names beyond R01/R02/R03 were not individually verified
  against the docs; `adapter.draft.ts` marks that table **UNVERIFIED**.

---

## 4. Runner-up: Modern Treasury

**Use this if the Increase signup gates you.** Strongest self-serve evidence of the
three that is also feature-complete on returns.

- **Signup:** `app.moderntreasury.com/sign_up` — confirmed to be a real one-field
  form ("Create your workspace" / "Enter your work email address..."), not a
  lead-capture form. Every org is provisioned two environments, one live and one
  sandbox, with "feature parity to a production environment."
  Risk: the field says *work* email; a gmail address may be rejected. **UNCONFIRMED.**
- **Base URL:** `https://app.moderntreasury.com/api` — **the same host for both
  modes**; the API key decides. Sandbox objects carry `live_mode: false`.
- **Auth:** HTTP Basic, `curl -u ORGANIZATION_ID:API_KEY`.
- **Create:** `POST /api/payment_orders`. Required: `amount`, `direction`
  (`credit` | `debit`), `originating_account_id`, `type` (`"ach"`). Destination is
  `receiving_account_id` (an external account) or an inline `receiving_account`.
  Routing/account numbers live on the external account as
  `routing_details[]` / `account_details[]` under a counterparty.
- **SEC code:** the field is **`subtype`**. Supported: `CCD`, `PPD`, `CTX`, `WEB`,
  `TEL`, `CIE`, `IAT`. Defaults to `PPD` when the receiving account's `party_type`
  is `individual`, else `CCD`.
- **Statuses:** `approved`, `cancelled`, `completed`, `denied`, `failed`, `held`,
  `needs_approval`, `pending`, `processing`, `returned`, `reversed`, `sent`,
  `stopped`. Returns are a **separate object** with its own smaller status enum
  (`cancelled`, `completed`, `failed`, `pending`, `processing`, `returned`, `sent`)
  plus `code` (R01–R19+, C01–C09), `reason`, `role`, `corrections`, `date_of_death`.
- **★ Force a return: magic account numbers.** Put the code in the receiving
  account number and send a normal payment.

  | Account number | Effect |
  |---|---|
  | `100XX` | ACH return, code **R`XX`** — `10001` = R01, `10002` = R02, `10003` = R03 |
  | `200XX` | ACH **NOC**, code **C`XX`** — `20001` = C01, `20002` = C02, `20003` = C03, `20005` = C05 |
  | `11111111X` | generic payment failure |

  NOC returns carry dummy `corrections` and **auto-update the external account**.

  ```bash
  # 1. counterparty whose account number encodes R01
  curl -sS -X POST -u "$MT_ORG:$MT_KEY" \
    https://app.moderntreasury.com/api/counterparties \
    -H 'Content-Type: application/json' \
    -d '{"name":"Return Test Co","accounts":[{"account_type":"checking",
         "routing_details":[{"routing_number_type":"aba","routing_number":"121141822"}],
         "account_details":[{"account_number":"10001"}]}]}'

  # 2. send a normal payment order to that external account -> returns R01 within minutes
  curl -sS -X POST -u "$MT_ORG:$MT_KEY" \
    https://app.moderntreasury.com/api/payment_orders \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: '"$(uuidgen)" \
    -d '{"type":"ach","subtype":"WEB","amount":1000,"direction":"credit","currency":"USD",
         "originating_account_id":"YOUR_INTERNAL_ACCOUNT_ID",
         "receiving_account_id":"EXTERNAL_ACCOUNT_ID_FROM_STEP_1"}'
  ```

- **There is no return-simulation endpoint and no state-transition endpoint.** The
  entire API has exactly two `/api/simulations/*` routes:
  `POST /api/simulations/incoming_payment_details/create_async` and
  `PATCH /api/simulations/legal_entities/{id}/update_status`. Don't confuse
  `POST /api/returns` with a simulator — that *originates* a return on money you
  **received**, and `returnable_type` currently accepts only
  `incoming_payment_detail`.
- **Sandbox timing:** heavily accelerated — payment orders settle in seconds,
  simulated returns post within minutes, an originated return processes exactly one
  minute after creation. `process_after` is the only delay lever you control.
- **Webhooks:** register in-dashboard or `POST /api/webhook_endpoints`. 16 topics
  including `payment_order` and `return`. Payload `{ "event": ..., "data": {...} }`.
  Signature: header **`X-Signature`**, **HMAC-SHA256, hex**, over the **raw
  unmodified body** with the webhook key (distinct from the API key). Docs warn:
  "It is important not to parse the request body or manipulate the data before
  performing signature verification."
  **Weakness: no timestamp in the signature and no documented tolerance window — no
  built-in replay protection.** `X-Event-Time` exists but is not signed. Dedupe on
  `X-Webhook-ID` (stable across retries) yourself.
- **Idempotency:** `Idempotency-Key`, max 180 chars, POST and PATCH only. Successful
  responses cached **24 hours** and echoed verbatim; failures are **not** cached, so
  retries re-execute; a concurrent duplicate while the first is in flight → **409**.
  **Footgun: keys are scoped to the API key** — the same key value under two
  different API keys executes twice.

Docs: [sandbox overview](https://docs.moderntreasury.com/payments/docs/payments-sandbox-overview) ·
[simulating a return](https://docs.moderntreasury.com/payments/docs/simulating-a-return) ·
[SEC codes](https://docs.moderntreasury.com/payments/docs/customize-sec-codes) ·
[verifying webhooks](https://docs.moderntreasury.com/platform/docs/verifying-webhooks) ·
[idempotent requests](https://docs.moderntreasury.com/platform/reference/idempotent-requests) ·
[return object](https://docs.moderntreasury.com/platform/reference/return-object)

---

## 5. Runner-up: Moov

Best-documented instant no-KYB sandbox, weakest return ergonomics and the only one
with a webhook signature I would call unsound.

- **Signup:** `dashboard.moov.io/signup`. "Creating an account gives you access to
  test mode." Test account is pre-populated with sample business details; all
  capabilities (transfers, wallet, send-funds, collect-funds) auto-enabled; "You
  aren't required to enter anything for your test account to receive the `verified`
  status." Production needs onboarding docs + **$500/mo minimum**.
  One doc page ([set-up-your-account/test-mode](https://docs.moov.io/guides/set-up-your-account/test-mode/))
  contradicts this and implies test mode follows production approval —
  **UNCONFIRMED**, but three other pages say signup grants it.
- **Base URL:** `https://api.moov.io` for **both** test and production — the API key
  selects the mode. **No sandbox hostname exists.**
- **Auth:** Basic (`base64(publicKey:privateKey)`) **or** OAuth2 client_credentials
  → `Bearer` token via `POST https://api.moov.io/oauth2/token`. Scopes are granular
  and per-resource, e.g. `/accounts/{accountID}/transfers.write`.
  **An `Origin` (or `Referer`) header matching a domain registered on the key is
  required** — test keys accept `localhost`, ngrok, Vercel domains. Always send
  `X-Moov-Version`; it silently defaults to `v2024.01.00`, and the rail-specific
  webhook fields depend on it.
- **Create:** `POST /accounts/{accountID}/transfers`. **Direction is chosen by
  payment method type, not by a field:** `ach-debit-fund` / `ach-debit-collect`
  (inbound pull) vs. `ach-credit-standard` / `ach-credit-same-day` (outbound push).
  Routing/account numbers are **never** on the transfer — two-step indirection:
  `POST /accounts/{id}/bank-accounts`, then `GET /accounts/{id}/payment-methods` to
  get the `paymentMethodID`s.
- **SEC codes:** `WEB`, `PPD`, `CCD`, `TEL`, set via `secCode` in
  `source.achDetails` / `destination.achDetails`. Also `companyEntryDescription`,
  `originatingCompanyName`, `addenda[].record`, `debitHoldPeriod`
  (`no-hold` | `1-day` | `2-days`).
- **Statuses:** top-level `created`, `queued`, `pending`, `completed`, `canceled`,
  `failed`, `reversed`; **plus** rail-specific `achDetails.status`: `initiated`,
  `originated`, `corrected`, `completed`, `returned`, `canceled`, with a `return`
  object (`code`, `reason`, `description`). Returned *during* clearing → `failed`;
  returned *after* completion → `reversed`.
- **Sandbox timing — genuinely delayed:** weekday ACH in test mode completes in
  **about an hour**; weekend ACH waits for Monday 12:00 AM ET. Realistic, but slow
  and non-deterministic to iterate against in a 48-hour trial.
- **★ Force a return: magic dollar amounts.** No simulation endpoint, no dashboard
  button. `$55.01` → R01, `$55.02` → R02, `$55.03` → R03, `$55.07` → R07,
  `$55.08` → R08, `$55.09` → R09, `$55.10` → R10, `$55.11`, `$55.15`, `$55.16`,
  `$55.20`, `$55.24`, `$55.29`.
  **Gotcha:** the code only fires if the transfer actually contains the relevant
  leg. R01/R02 are debit-leg codes and **cannot** be triggered on a
  wallet-to-bank credit-only transfer; R03/R04 are the credit-leg ones.
  Test routing number `322271627`, any account number.

  ```bash
  curl -sS -X POST "https://api.moov.io/accounts/$FACILITATOR/transfers" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Moov-Version: v2026.07.00" \
    -H "x-idempotency-key: $(uuidgen)" \
    -H "Content-Type: application/json" \
    -d '{"source":{"paymentMethodID":"<ach-debit-collect>",
                   "achDetails":{"secCode":"WEB","debitHoldPeriod":"no-hold"}},
         "destination":{"paymentMethodID":"<wallet>"},
         "amount":{"currency":"USD","value":5501},
         "description":"R01 return test"}'
  ```

- **NOC/COR: cannot be simulated** on the hosted sandbox. The `corrected` status and
  `achDetails.correction` object exist, but no amount, account number, or endpoint
  triggers one. (The self-hosted
  [`moov-io/ach-test-harness`](https://github.com/moov-io/ach-test-harness) does
  returns *and* NOCs, but it is a local ACH file simulator, not the platform sandbox.)
- **Webhooks:** dashboard registration only (no documented API). Relevant events:
  `transfer.created`, `transfer.updated`. **No dedicated return event** — returns
  arrive as `transfer.updated` with `achDetails.status: "returned"`. Must return 2xx
  within 5s; retries for 24h.
  **Signature:** headers `X-Timestamp`, `X-Nonce`, `X-Webhook-ID`, `X-Signature`;
  signed string is `` `{X-Timestamp}|{X-Nonce}|{X-Webhook-ID}` ``; **HMAC-SHA512**,
  lowercase hex.
  **The request body is NOT part of the signed string.** The signature authenticates
  the headers only. That is a genuine weakness for a money-movement webhook — treat
  `X-Nonce` as a mandatory replay-dedupe key and do not trust the body's contents
  without a read-back. No tolerance window documented. **UNCONFIRMED.**
- **Idempotency:** `x-idempotency-key`, required on `POST /transfers`, ≤36 chars.
  **Replay returns `409 Conflict`, not the cached response** — a retry after a
  network timeout tells you the transfer exists but does not hand it back, so your
  retry path needs a lookup. Bonus: `x-wait-for: rail-response` makes the create
  synchronous (15s timeout) and returns full rail details.

Docs: [test mode](https://docs.moov.io/guides/get-started/test-mode/) ·
[test data](https://docs.moov.io/guides/developer-tools/test-data/) ·
[events & statuses](https://docs.moov.io/guides/money-movement/events-and-statuses/) ·
[ACH details](https://docs.moov.io/guides/money-movement/accept-payments/ach/ach-details/) ·
[check webhook signatures](https://docs.moov.io/guides/webhooks/check-webhook-signatures/) ·
[pricing](https://moov.io/pricing/)

---

## 6. Design consequences for the trial

Whichever rail wins, these are the things the research says the ledger must do —
and they are the same three sentences in all three providers' docs, which is why
they belong in the *interface*, not the adapter:

1. **A return is a second money movement, not an edit.** Increase "create[s] a new
   Transaction to reduce your balance"; Modern Treasury emits a separate Return
   object; Moov flips `completed` → `reversed`. Never mutate the original transfer
   row's amount — append.
2. **Settlement is a timestamp, not a status.** Increase makes this explicit and
   painful; the other two hide it. `settledAt` must come from the rail, never be
   inferred from `submittedAt + N days`.
3. **The return window outlives settlement.** 2 business days commercial, 60 calendar
   days consumer/unauthorised. A balance is not spendable the moment it settles;
   `RailCapabilities.returnWindowDays` is what drives hold release, and Increase's
   automatic `inbound_funds_hold` pending transaction is the model to copy.
4. **Webhooks are hints; read-backs are truth.** All three redeliver, none guarantee
   ordering. Dedupe on the provider's event id and reconcile with a `getTransfer`
   sweep.

See `adapter.draft.ts` for the interface these fall out of.
