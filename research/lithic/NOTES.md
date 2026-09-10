# Lithic Sandbox — Operational Research Notes

Researched 2026-09-09 against official Lithic docs (`docs.lithic.com`), the Lithic
OpenAPI spec served at `https://docs.lithic.com/reference/<op>.md`, and the
`lithic-com/lithic-node` SDK source (generated from that same OpenAPI spec).

**No Lithic account was created.** Everything below is read from docs/spec, not from
live calls against a real key. Items I could not confirm are explicitly flagged
`UNCONFIRMED`.

Primary sources (all fetched):
- https://docs.lithic.com/llms.txt (doc index; append `.md` to any docs URL for markdown)
- https://docs.lithic.com/docs/get-api-key
- https://docs.lithic.com/docs/enviornments  *(sic — Lithic's own typo in the slug)*
- https://docs.lithic.com/docs/simulating-transactions
- https://docs.lithic.com/docs/events-api
- https://docs.lithic.com/docs/auth-stream-access-asa
- https://docs.lithic.com/docs/rate-limits
- https://docs.lithic.com/reference/postsimulateauthorize
- https://docs.lithic.com/reference/postsimulateclearing
- https://docs.lithic.com/reference/postsimulateauthorizationadvice
- https://docs.lithic.com/reference/postsimulatevoid
- https://docs.lithic.com/reference/postsimulatereturn
- https://docs.lithic.com/reference/postsimulatereturnreversal
- https://docs.lithic.com/reference/postresponderendpoints
- https://docs.lithic.com/reference/cardauthorizationapprovalrequestwebhook (full OpenAPI dump)
- https://docs.lithic.com/reference/cardtransactionupdatedwebhook
- https://github.com/lithic-com/lithic-node (`src/client.ts`, `src/resources/webhooks.ts`,
  `src/resources/transactions/transactions.ts`, `src/resources/cards/cards.ts`,
  `src/resources/events/*`)
- https://github.com/standard-webhooks/standard-webhooks (`libraries/javascript/src/index.ts`)

---

## 1. Sandbox signup, base URL, auth header

### Signup path — genuinely self-serve, free, no KYB

1. Go to **https://app.lithic.com/signup** and create an account.
2. **Every account is issued a Sandbox API key automatically.** Quote from
   `docs/get-api-key`: *"To generate an API key, you need to create an account on
   lithic.com. Each account comes with a Sandbox API key."*
3. Read the key at **https://app.lithic.com/settings** (the ASA demo repos and the
   ASA doc also reference https://app.lithic.com/account for the ASA HMAC secret).
4. Sandbox is explicitly free: *"Our Sandbox environment is free to use."*
   Production keys are gated (*"A Production API key is available when you are
   enabled for a production environment"* → requires talking to Sales/Implementation),
   but **sandbox is not**.

**UNCONFIRMED:** the exact fields on the signup form (email/password only vs. also a
company name). Docs never state a KYB/business-verification requirement for sandbox,
and KYB in Lithic is a *product feature* (`/v1/account_holders`) applied to *your end
users*, not a gate on your own sandbox key. Assume email + password + email
verification; budget 5 minutes.

### Base URLs

| Environment | Base URL |
|---|---|
| Sandbox | `https://sandbox.lithic.com` (paths are `/v1/...`, so effectively `https://sandbox.lithic.com/v1`) |
| Production | `https://api.lithic.com` |

The OpenAPI spec's `servers` block lists only `https://sandbox.lithic.com`.

### Auth header

The API key is a bare UUID (docs' own example: `e65e2478-f516-4c9d-af36-7d1ebc5414fd`).

**Canonical form, and what the official SDK sends** (`lithic-node` `src/client.ts`,
`authHeaders()` → `buildHeaders([{ Authorization: this.apiKey }])`):

```
Authorization: <api_key>
```

No `Bearer`, no `Basic`, **no base64**. Just the raw key.

The Environments page also shows `Authorization: Basic {api_key}` and `curl -u {key}:`
as accepted alternatives. **Use the raw form** — it is what the SDK, every `.md` code
sample in the simulation docs, and the quick-start curls use.

Optional header on `POST /v1/cards`: `Idempotency-Key: <string>`.

---

## 2. Creating a card

**`POST /v1/cards`**

Required body field: **`type`** only.

```
type: 'VIRTUAL' | 'PHYSICAL' | 'SINGLE_USE' | 'MERCHANT_LOCKED'
      | 'UNLOCKED' (deprecated) | 'DIGITAL_WALLET' (deprecated)
```

- `VIRTUAL` — authorizes at any merchant, digital-wallet-able. **Use this.**
- `SINGLE_USE` — card closes after the first successful authorization. Will break a
  multi-transaction demo; do not use for the auth→clearing lifecycle.
- `MERCHANT_LOCKED` — locks to the first merchant that successfully authorizes.
- `PHYSICAL` — requires `shipping_address` + `product_id` and Lithic configuration;
  not usable self-serve.

Useful optional fields:

| Field | Notes |
|---|---|
| `account_token` | Required only for programs enrolling users via `/v1/account_holders`. Sandbox auto-provisions a default account, so it can be omitted for a first card. |
| `memo` | Friendly name |
| `spend_limit` | **integer cents**. `0` means *no limit*; only `>= 1` produces declines. |
| `spend_limit_duration` | `TRANSACTION` \| `MONTHLY` \| `ANNUALLY` \| `FOREVER` |
| `state` | `OPEN` \| `PAUSED` |
| `exp_month` / `exp_year` | `"MM"` / `"yyyy"`. If both omitted, Lithic generates +5 years. |
| `card_program_token` | Sandbox test values: `00000000-0000-0000-1000-000000000000` and `00000000-0000-0000-2000-000000000000` |
| `pin` | base64 encrypted PIN block |

### What a sandbox card returns

Response is `200 OK` (not 201) with the **PCI card response** — i.e. **sandbox returns
the full PAN and CVV in the clear**, which is exactly what you need to drive
`/v1/simulate/authorize`. Official example from the spec:

```json
{
  "token": "7ef7d65c-9023-4da3-b113-3b8583fd7951",
  "account_token": "f3f4918c-dee9-464d-a819-4aa42901d624",
  "card_program_token": "5e9483eb-8103-4e16-9794-2106111b2eca",
  "cardholder_currency": "USD",
  "created": "2021-06-28T22:53:15Z",
  "cvv": "776",
  "pan": "4111111289144142",
  "last_four": "4142",
  "exp_month": "06",
  "exp_year": "2027",
  "funding": {
    "token": "b0f0d91a-3697-46d8-85f3-20f0a585cbea",
    "account_name": "Sandbox",
    "created": "2020-07-08T17:57:36Z",
    "last_four": "5263",
    "nickname": "checking account",
    "state": "ENABLED",
    "type": "DEPOSITORY_CHECKING"
  },
  "hostname": "",
  "memo": "New Card",
  "replacement_for": null,
  "spend_limit": 1000,
  "spend_limit_duration": "TRANSACTION",
  "state": "OPEN",
  "type": "VIRTUAL",
  "pin_status": "NOT_SET"
}
```

In **production** `pan`/`cvv` are withheld unless you are PCI-DSS compliant. Design the
adapter so PAN is only ever read in the sandbox code path — store `card.token` and
`last_four` in Postgres, never the PAN.

`state` on a retrieved card can also be `CLOSED`, `PENDING_ACTIVATION`,
`PENDING_FULFILLMENT`. `GET /v1/cards` (list) returns the **non-PCI** shape (no PAN).

---

## 3. The simulation endpoints

All are sandbox-only ("Simulation operations are only available in the Sandbox").
All amounts are **integer cents**. All return `debugging_request_id`; the ones that
*create* a new transaction also return `token`.

### The token that ties everything together

`POST /v1/simulate/authorize` returns `token` — **this is the Transaction token**. It is
the same value as `GET /v1/transactions/{transaction_token}`'s `token`, and it is what
you pass as `token` to `clearing`, `void`, `authorization_advice`, and
`return_reversal`. Persist it as your transaction primary key on the Lithic side.

`/v1/simulate/return` also returns a `token` — a *new, independent* transaction token
(a return is not linked to a prior auth), which is what `return_reversal` consumes.

Individual *events* inside a transaction have their own `token`
(`transaction.events[].token`); those are not interchangeable with the transaction token.

### 3a. Simulate an authorization

```
POST /v1/simulate/authorize
```

| Field | Type | Req | Notes |
|---|---|---|---|
| `amount` | int (cents) | ✅ | 0 … 2,000,000,000. Must be `0` for `BALANCE_INQUIRY`. For credit types, converted to a negative amount internally. |
| `descriptor` | string | ✅ | Merchant name, 1–25 chars |
| `pan` | string | ✅ | 16-digit card number from card create |
| `mcc` | string | | 4-digit ISO 18245 |
| `merchant_acceptor_id` | string | | 1–15 chars |
| `merchant_acceptor_city` | string | | max 13 chars |
| `merchant_acceptor_state` | string | | ISO 3166-2, max 3 chars |
| `merchant_acceptor_country` | string | | ISO 3166-1 alpha-3, exactly 3 (`"USA"`) |
| `merchant_amount` | int | | amount in `merchant_currency`, incl. acquirer fees |
| `merchant_currency` | string | | **Simulator accepts only USD, GBP, EUR and DEFAULTS TO GBP.** Always send `"USD"`. |
| `partial_approval_capable` | bool | | |
| `pin` | string | | 4–12 chars; omitted ⇒ no PIN check |
| `status` | enum | | default `AUTHORIZATION` |

`status` values and their meaning:

- `AUTHORIZATION` — **dual-message**; needs a subsequent clearing to settle. *This is
  the one Track 3 is about.*
- `BALANCE_INQUIRY` — $0 auth
- `CREDIT_AUTHORIZATION` — dual-message refund auth, needs clearing
- `FINANCIAL_AUTHORIZATION` — **single-message**, debits immediately, no clearing (ATM-like)
- `FINANCIAL_CREDIT_AUTHORIZATION` — single-message immediate credit

Response `201`:
```json
{ "debugging_request_id": "d31645af-…", "token": "fabd829d-7f7b-4432-a8f2-07ea4889aaac" }
```

Error `422 Unprocessable Entity`, e.g.:
```json
{ "debugging_request_id": "9399…", "message": "Exceeds transaction limit" }
```
A decline from a card spend limit returns a body with `message`, `token` **and**
`debugging_request_id` — so a `token` in the response does not by itself mean approved.
Read the resulting Transaction's `result`/`status` to know.

Gotcha: **non-ASA sandbox accounts have a default $5,000 USD daily transaction limit.**
Raise it via `PATCH /v1/accounts/{account_token}`.

### 3b. Simulate a clearing / capture (higher OR lower than the auth)

```
POST /v1/simulate/clearing
```

| Field | Type | Req | Notes |
|---|---|---|---|
| `token` | uuid | ✅ | the transaction token from `/v1/simulate/authorize` |
| `amount` | int (cents) | | **omit ⇒ clears the full authorized amount.** May be **higher or lower** than the auth. Sign is auto-matched to the original auth's sign. |

Response `201`: `{ "debugging_request_id": "…" }` — **no token**.

Verbatim from the endpoint doc:

> *"Typically this will match the amount in the original authorization, but can be
> higher or lower."*
> *"This endpoint may be called multiple times against the same authorization to
> simulate a multiple-completion scenario, with each call creating a separate clearing
> event."*

Transaction transitions `PENDING → SETTLED`. *"Transactions that have already cleared,
either partially or fully, cannot be cleared again"* appears in the endpoint summary
while the body text explicitly permits multiple completions — these two statements are
in tension.
**UNCONFIRMED:** whether a second clearing on an already-fully-cleared auth is rejected
or accepted in sandbox. Test this empirically on day 1; do not build the ledger assuming
one is guaranteed.

### 3c. Simulate an authorization advice / incremental auth

```
POST /v1/simulate/authorization_advice
```

| Field | Type | Req | Notes |
|---|---|---|---|
| `token` | uuid | ✅ | transaction token from `/v1/simulate/authorize` |
| `amount` | int (cents) | ✅ | **overrides** the original auth amount |

Response `201`: `{ "token": "…", "debugging_request_id": "…" }`

> *"An authorization advice changes the pending amount of the transaction."*
> *"This amount will override the transaction's amount that was originally set by
> /v1/simulate/authorize."*

Note the semantics: this is **absolute, not a delta**. To go 1000 → 1500 you send
`amount: 1500`, not `amount: 500`. It appends an `AUTHORIZATION_ADVICE` event to the
transaction and adjusts the hold. There is no separate "incremental auth" endpoint;
this is the sandbox mechanism for it.

### 3d. Simulate a void / reversal

```
POST /v1/simulate/void
```

| Field | Type | Req | Notes |
|---|---|---|---|
| `token` | uuid | ✅ | transaction token |
| `amount` | int (cents) | | *"Typically this will match the amount in the original authorization, but can be less."* Partial voids allowed. Applies to `AUTHORIZATION_REVERSAL` only — an expiry always voids the full pending amount. |
| `type` | enum | | `AUTHORIZATION_REVERSAL` (default, merchant-initiated) \| `AUTHORIZATION_EXPIRY` (Lithic-initiated) |

Response `201`: `{ "debugging_request_id": "…" }`

Constraints: works on a **pending** (uncleared) auth. *"Can be used on partially voided
transactions but not partially cleared transactions."* Simulating an expiry on credit
authorizations is not currently supported.

**Ambiguity:** the docs' own sample sends `{"amount":0, "token":"…"}` while the field
description says "if `amount` is not set, the full amount will be voided". Whether
`amount: 0` means "full" or literally zero is not stated.
**Recommendation: omit `amount` entirely for a full void.** The adapter does this.

There is also a non-simulate production-shaped endpoint
`POST /v1/transactions/{transaction_token}/expire_authorization`.

### 3e. Simulate a return (refund)

```
POST /v1/simulate/return
```

| Field | Type | Req |
|---|---|---|
| `amount` | int (cents) | ✅ |
| `descriptor` | string | ✅ |
| `pan` | string | ✅ |

Response `201`: `{ "token": "…", "debugging_request_id": "…" }`

> *"Returns simulated via this endpoint clear immediately, without prior authorization,
> and result in a `SETTLED` transaction status."*

Note: it takes a **PAN, not a token** — a return is a fresh credit transaction, not a
child of the original purchase. If you want a refund attributable to the original
purchase in your ledger you must correlate it yourself (by card + amount + descriptor).

Reversal of a return:
```
POST /v1/simulate/return_reversal      body: { "token": "<return's token>" }
```
→ `{ "debugging_request_id": "…" }`. Reverses a `SETTLED` credit transaction.

### 3f. Force-post (clearing with no prior authorization)

**There is no force-post simulation endpoint.** I enumerated every path in Lithic's
OpenAPI spec containing `simulate`; the complete card-transaction set is:

```
/v1/simulate/authorize
/v1/simulate/authorization_advice
/v1/simulate/clearing
/v1/simulate/credit_authorization_advice
/v1/simulate/return
/v1/simulate/return_reversal
/v1/simulate/void
```

No `/v1/simulate/force_post`, no `force` anywhere in the spec. `POST /v1/simulate/clearing`
**requires** a `token` from a prior authorize, so it cannot originate an unmatched clearing.

Closest reachable substitutes, in order of fidelity:

1. **`/v1/simulate/authorize` with `status: "FINANCIAL_AUTHORIZATION"`** — a single-message
   debit that settles immediately with no clearing step. This is the best available
   stand-in for "money moves with no dual-message auth" and produces a
   `FINANCIAL_AUTHORIZATION` event on a transaction that goes straight to `SETTLED`.
2. **`/v1/simulate/return`** — same shape (PAN, no prior auth, immediate `SETTLED`) but
   with credit polarity.
3. **`/v1/simulate/credit_authorization_advice`** (`amount`, `descriptor`, `pan`, plus
   optional merchant fields) — *"the network approved a credit authorization on your
   behalf."*

For the trial: implement your ledger's force-post handling against event type
`FINANCIAL_AUTHORIZATION` (and the unmatched-clearing case defensively), and say
plainly in the writeup that Lithic sandbox cannot emit a true unmatched `CLEARING`.
The `Transaction.result` enum does contain `ORIGINAL_NOT_FOUND` and
`detailed_results` contains `REVERSAL_UNMATCHED`, which is the shape an unmatched
message would take if the network sent one.

---

## 4. Transaction object model

`GET /v1/transactions/{transaction_token}` and `GET /v1/transactions` (cursor paginated).
All amounts are integer cents.

### Auth vs. clearing: they are the SAME transaction, distinguished by events

There is no separate "clearing object". One `Transaction` accumulates an `events[]`
array. **`transaction.events[].type` is what identifies an authorization vs its
clearing:**

```
AUTHORIZATION | AUTHORIZATION_ADVICE | AUTHORIZATION_EXPIRY | AUTHORIZATION_REVERSAL
| BALANCE_INQUIRY | CLEARING | CORRECTION_CREDIT | CORRECTION_DEBIT
| CREDIT_AUTHORIZATION | CREDIT_AUTHORIZATION_ADVICE
| FINANCIAL_AUTHORIZATION | FINANCIAL_CREDIT_AUTHORIZATION
| RETURN | RETURN_REVERSAL
```

Each event carries its own `token`, `created`, `amount` / `amounts` (cardholder /
merchant / settlement), `effective_polarity` (`CREDIT` | `DEBIT`), `result`,
`detailed_results[]`, `rule_results[]`, and `network_info`. **The clearing event's
`amount` is the settled amount for that completion** — that's where a
clear-for-a-different-amount shows up.

To fetch events explicitly there is also `GET /v1/transactions/{token}/events` on the
`transactions.events` sub-resource.

### Auth amount vs settled amount

| Field | Meaning |
|---|---|
| `amounts.hold.amount` | **The pending / held amount** in the anticipated settlement currency. This is the live authorization hold. |
| `amounts.settlement.amount` | The settled amount in the settlement currency |
| `amounts.cardholder.amount` | Estimated settled amount in cardholder billing currency (+ `conversion_rate`) |
| `amounts.merchant.amount` | Settled amount in merchant currency |
| `authorization_amount` | **DEPRECATED** — auth amount in anticipated settlement currency |
| `settled_amount` | **DEPRECATED** — settled amount in settlement currency |
| `amount` | **DEPRECATED** — auth amount while `PENDING`, settled amount once `SETTLED` |
| `merchant_amount`, `merchant_authorization_amount`, `merchant_currency` | **DEPRECATED** — use `amounts.merchant` |

**Use the `amounts` object, not the top-level scalars.** The flat fields are all marked
deprecated in the current spec but are still populated, so they're a convenient
cross-check during the trial; don't build the ledger on them.

Also on the transaction: `token`, `account_token`, `card_token`, `financial_account_token`,
`authorization_code` (6-digit), `acquirer_fee`, `network`
(`VISA`|`MASTERCARD`|`AMEX`|`INTERLINK`|`MAESTRO`|`UNKNOWN`), `network_risk_score` (0–999),
`merchant{…}`, `pos{entry_mode, terminal}`, `avs{address, zipcode}`,
`cardholder_authentication`, `token_info.wallet_type`, `tags{}`, `created`, `updated`.

### Status values

```
PENDING | SETTLED | DECLINED | EXPIRED | VOIDED
```

### `result` (transaction-level outcome)

`APPROVED`, `DECLINED`, `INSUFFICIENT_FUNDS`, `USER_TRANSACTION_LIMIT`, `CARD_PAUSED`,
`CARD_CLOSED`, `ACCOUNT_PAUSED`, `INACTIVE_ACCOUNT`, `INCORRECT_PIN`,
`INVALID_CARD_DETAILS`, `MERCHANT_BLACKLIST`, `ORIGINAL_NOT_FOUND`,
`PREVIOUSLY_COMPLETED`, `SINGLE_USE_RECHARGED`, `SUSPECTED_FRAUD`,
`UNAUTHORIZED_MERCHANT`, `UNKNOWN_HOST_TIMEOUT`, `FRAUD_ADVICE`, `IGNORED_TTL_EXPIRY`,
`INVALID_TRANSACTION`, `BANK_CONNECTION_ERROR`, `BANK_NOT_VERIFIED`,
`INSUFFICIENT_FUNDS_PRELOAD`, `ACCOUNT_STATE_TRANSACTION_FAIL`, `SWITCH_INOPERATIVE_ADVICE`.

`detailed_results[]` on each event is a much finer enum (~60 values) including
`AUTH_RULE`, `CARD_SPEND_LIMIT_EXCEEDED`, `CUSTOMER_ASA_TIMEOUT`, `CUSTOM_ASA_RESULT`,
`MALFORMED_ASA_RESPONSE`, `REVERSAL_UNMATCHED`, `OVER_REVERSAL_ATTEMPTED`,
`TRANSACTION_PREVIOUSLY_COMPLETED`.

### `pending_amount` / `settled_amount` across the lifecycle — IMPORTANT NAMING TRAP

`pending_amount` **does not exist on the card `Transaction` object.** It exists on the
**Financial Transaction** object, a different resource:

```
GET /v1/financial_accounts/{financial_account_token}/financial_transactions
GET /v1/cards/{card_token}/financial_transactions
```

whose schema is `{ token, category (CARD|ACH|INTERNAL|TRANSFER), status, result,
pending_amount, settled_amount, currency, descriptor, events[], created, updated }`.
Spec descriptions:

- `pending_amount` — *"Pending amount of the transaction in the currency's smallest unit
  (e.g., cents), including any acquirer fees. **The value of this field will go to zero
  over time once the financial transaction is settled.**"*
- `settled_amount` — *"Amount of the transaction that has been settled … **This may change
  over time.**"*

So there are two parallel views and you should pick one and be consistent:

| Concept | Card Transaction API | Financial Transaction API |
|---|---|---|
| held / pending | `amounts.hold.amount` | `pending_amount` |
| settled | `amounts.settlement.amount` (+ deprecated `settled_amount`) | `settled_amount` |

Expected behaviour across the dual-message lifecycle (auth 1000 ¢, clear 1200 ¢):

| Step | `status` | hold / `pending_amount` | settled |
|---|---|---|---|
| after `authorize` amount=1000 | `PENDING` | 1000 | 0 |
| after `authorization_advice` amount=1500 | `PENDING` | 1500 | 0 |
| after `void` amount=200 | `PENDING` | 1300 | 0 |
| after `clearing` amount=1200 | `SETTLED` | 0 | 1200 |
| after full `void` (no clearing) | `VOIDED` | 0 | 0 |
| after expiry | `EXPIRED` | 0 | 0 |

**UNCONFIRMED:** the exact intermediate hold arithmetic for *partial* clearing (clear 600
of a 1000 auth) — whether the hold drops to 400 and status stays `PENDING`, or drops to 0
with status `SETTLED`. The endpoint doc says the status transitions to `SETTLED` after a
clearing, unqualified, which suggests any clearing settles the transaction and a second
clearing appends another `CLEARING` event. **Verify empirically before you write the
ledger reconciliation.** This is the single highest-value thing to nail down on day 1 of
the trial.

---

## 5. Webhooks / events

### Registering a webhook URL (identical in sandbox)

```
POST https://sandbox.lithic.com/v1/event_subscriptions
Authorization: <api_key>
Content-Type: application/json

{ "url": "https://<your-vercel-app>/api/webhooks/lithic",
  "description": "corgi trial",
  "event_types": ["card_transaction.updated"],   // omit ⇒ ALL event types
  "disabled": false }
```

Response:
```json
{ "token": "ep_1srOrx2ZWZBpBUvZwXKQmoEYga1", "url": "…", "description": "…",
  "event_types": null, "disabled": false, "debugging_request_id": "…" }
```

**URL must be HTTPS.** A Vercel preview/production URL works; localhost does not — use a
tunnel (ngrok/cloudflared) or deploy the webhook route first.

Other subscription endpoints:

| Purpose | Endpoint |
|---|---|
| Get the signing secret | `GET /v1/event_subscriptions/{tok}/secret` → `{"key":"whsec_REDACTED-ROTATED"}` |
| Rotate the secret (old valid 24h) | `POST /v1/event_subscriptions/{tok}/secret/rotate` |
| List / get / update / delete | `GET|PATCH|DELETE /v1/event_subscriptions[/{tok}]` |
| Delivery attempts | `GET /v1/event_subscriptions/{tok}/attempts` |
| Recover failed deliveries | `POST /v1/event_subscriptions/{tok}/recover?begin=&end=` |
| Backfill events from before the sub existed | `POST /v1/event_subscriptions/{tok}/replay_missing?begin=&end=` |
| **Fire a fake event to test your handler** | `POST /v1/simulate/event_subscriptions/{tok}/send_example` body `{"event_type":"card_transaction.updated"}` |
| Resend one event | `POST /v1/events/{event_token}/event_subscriptions/{sub_token}/resend` |
| Query past events (90 days) | `GET /v1/events?event_types=a,b&begin=&end=` |

`send_example` is how you test signature verification without simulating a transaction.

### Event envelope

```json
{
  "token": "msg_1srOrx2ZWZBpBUvZwXKQmoEYga1",   // == webhook-id header
  "event_type": "card_transaction.updated",
  "payload": { ... },                            // payload also contains event_type
  "created": "2022-10-10T12:31:12Z"
}
```

**The HTTP body Lithic POSTs to your endpoint is the payload object itself** (it carries
its own `event_type` discriminator) — the `{token, event_type, payload, created}` wrapper
is the shape returned by `GET /v1/events`. Write the handler to read `event_type` off the
top level of the parsed body and get the message id from the `webhook-id` header.

### Event types relevant to auth & clearing

**`card_transaction.updated`** — *"Occurs when a card transaction happens."* This is the
one that matters. Its payload is **the full `Transaction` object plus
`event_type: "card_transaction.updated"`** (SDK: `CardTransactionUpdatedWebhookEvent
extends Transaction`). It fires on every lifecycle step — authorization, advice,
clearing, void, expiry, return — so your handler must diff `events[]` / re-read
`amounts` rather than assume "new transaction".

Also potentially relevant:
- `card_authorization.approval_request` — the **ASA** real-time decisioning request (see §6). Delivered to the *responder endpoint*, not to an event subscription.
- `card_authorization.challenge` / `card_authorization.challenge_response` — out-of-band auth challenges
- `card_transaction.enhanced_data.created` / `.updated` — L2/L3 data (**not available in sandbox**)
- `balance.updated` — financial account balance update
- `financial_account.created` / `.updated`
- `card.created`, `card.updated`, `card.converted`, `card.renewed`, `card.reissued`, `card.shipped`
- `dispute.updated`, `dispute_transaction.created` / `.updated`, `claim.*`, `claim_document.*`
- `three_ds_authentication.created` / `.updated` / `.challenge`
- `tokenization.*`, `digital_wallet.*` (deprecated aliases)
- `account_holder.created` / `.updated` / `.verification`, `account_holder_document.updated`
- `payment_transaction.*`, `book_transfer_transaction.*`, `external_payment.*`,
  `external_bank_account.*`, `internal_transaction.*`, `management_operation.*`,
  `funding_event.created`, `loan_tape.*`, `statements.created`, `settlement_report.updated`,
  `network_total.*`, `auth_rules.backtest_report.created`, `embed.session_generated`, `embed.viewed`,
  `dispute_evidence.upload_failed`

(Full union is reproduced as a TS type in `adapter.draft.ts`.)

### Signature verification — Standard Webhooks (the Svix scheme)

**Yes, it is a standard.** Lithic uses **Standard Webhooks** — the official
`lithic-node` SDK literally does `import { Webhook } from 'standardwebhooks'` and calls
`wh.verify(body, headers)`. Standard Webhooks is the spec Svix authored and open-sourced,
so a Svix verifier is byte-compatible.

**Headers** (lowercase, exact names):

| Header | Meaning |
|---|---|
| `webhook-id` | message id; stable across retries; **equals `event.token`** — use it for idempotency |
| `webhook-timestamp` | Unix seconds, as a decimal string |
| `webhook-signature` | space-delimited list of `v1,<base64>` entries (multiple during secret rotation) |

**Recipe:**

1. Take the **raw request body bytes**, before any JSON parsing. On Next.js App Router
   that is `await req.text()` — never `await req.json()` then re-stringify.
2. `signedContent = "{webhook-id}.{webhook-timestamp}.{rawBody}"` (ASCII full stops).
3. Key = `base64Decode(secret.replace(/^whsec_/, ""))` — i.e. **strip the `whsec_`
   prefix, then base64-DECODE the remainder to raw bytes**. Do not use the string.
4. `expected = base64Encode(HMAC_SHA256(key, utf8Bytes(signedContent)))`
5. Split `webhook-signature` on **spaces**. For each entry, split on the first `,`;
   keep only entries whose version is exactly `v1`; compare the part **after** the comma
   to `expected` with a **constant-time** comparison. Any match ⇒ valid.
6. **Timestamp tolerance: ±5 minutes (300 seconds).** Reject if
   `now - timestamp > 300` ("too old") or `timestamp > now + 300` ("too new").
   That's `WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60` in the reference implementation.

So: HMAC-SHA256 over `id.timestamp.rawBody`, base64-encoded, key is the base64-decoded
secret body, `v1,` prefix stripped before comparison, 5-minute window.

The exact same three headers and the exact same algorithm are used for **ASA requests**
and **Tokenization Decisioning** requests.

**Verified, not assumed.** I ran the algorithm above against the canonical Standard
Webhooks test vector — secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`,
id `msg_p5jXN8AQM9LWM0D4loKWxJek`, timestamp `1614265330`, body `{"test": 2432232314}` —
and it reproduces `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`, which is the exact
signature string Lithic prints in its own "example header with multiple signature" block.
Re-serialising that same body with `JSON.stringify` (dropping the space after the colon)
produces a completely different signature — concrete proof of why you must sign the raw
body. `verifyLithicWebhook` in `adapter.draft.ts` was then exercised against valid,
multi-signature, tampered-body, wrong-version, stale-timestamp, future-timestamp,
missing-header, and prefix-less-secret cases; all eight behave correctly.

### Delivery retries

`Immediate → +5s → +5m → +30m → +2h → +5h → +10h → +10h` (8 attempts total, then
dropped). Retries fire on any non-2xx. A subscription failing **continuously for 5 days
is auto-disabled**; re-enable with `PATCH … {"disabled": false}`.

Practical consequences for the trial: **return 2xx fast and process asynchronously**, and
**dedupe on `webhook-id`** (a unique index in Postgres) because the same message can
legitimately arrive twice.

---

## 6. Auth Stream Access (ASA) — real-time decisioning

**Yes, ASA is fully reachable in sandbox, self-serve, no sales conversation.**
The doc states: *"In both sandbox and production, users can configure their ASA endpoint
using the enroll and disenroll responder endpoint APIs."* Lithic's own launch blog is
titled "Real-time Authorization Decisioning, Now Available in Sandbox."

### Enrolling

```
POST /v1/responder_endpoints
{ "type": "AUTH_STREAM_ACCESS", "url": "https://<your-app>/api/lithic/asa" }
```
→ `200 { "enrolled": true }`

`type` ∈ `AUTH_STREAM_ACCESS` | `THREE_DS_DECISIONING` | `TOKENIZATION_DECISIONING`.
`url` must be http(s). Also `GET /v1/responder_endpoints?type=…` (status) and
`DELETE /v1/responder_endpoints?type=…` (disenroll).

### The contract

Lithic **POSTs** the authorization to your URL and **blocks** on your response body.

**Request body** = `event_type: "card_authorization.approval_request"` + the full
`authorization` object:

```
token (uuid — the transaction token), event_token, created, status,
amount, amounts{cardholder{amount,conversion_rate,currency}, merchant{…},
                hold{…}, settlement{…}},
authorization_amount, settled_amount, merchant_amount, merchant_currency,
cardholder_currency, acquirer_fee, cash_amount, cashback, conversion_rate,
card { token, last_four, state, type, memo, … },
merchant { acceptor id, mcc, descriptor, city/state/country/postal/street, … },
pos { entry_mode, terminal }, avs { address, zipcode },
cardholder_authentication, token_info { wallet_type },
network, network_risk_score, network_specific_data, service_location,
fleet_info, name_validation, latest_challenge,
transaction_initiator: 'CARDHOLDER'|'MERCHANT'|'UNKNOWN',
account_type, ttl
```

**Response** — HTTP **200** with JSON. Only `result` is required:

```jsonc
{
  "result": "APPROVED",           // required
  "token": "<echo the request token>",   // optional
  "approved_amount": 1234,        // optional — cents; PRESENCE implies PARTIAL approval,
                                  //   so omit it entirely for a full approval
  "avs_result": "MATCH",          // MATCH | MATCH_ZIP_ONLY | MATCH_ADDRESS_ONLY | FAIL
  "balance": { "amount": 50000, "available": 42000 },  // required for BALANCE_INQUIRY
  "challenge_phone_number": "+15555555555",           // only when result == CHALLENGE
  "name_validation_result": "…"
}
```

`result` enum: `APPROVED`, `CHALLENGE`, `AVS_INVALID`, `CARD_PAUSED`,
`INSUFFICIENT_FUNDS`, `UNAUTHORIZED_MERCHANT`, `VELOCITY_EXCEEDED`,
`DRIVER_NUMBER_INVALID`, `VEHICLE_NUMBER_INVALID`, `SUSPECTED_FRAUD`.

Anything other than `APPROVED`/`CHALLENGE` **declines**. A value outside the enum
declines with `detailed_result = CUSTOM_ASA_RESULT`. A malformed body ⇒
`MALFORMED_ASA_RESPONSE`.

### Timeout — this is the number that matters

> *"If no response is received within **6 seconds**, the transaction will be declined for
> the cardholder … We recommend responding within **3 seconds**. If your ASA responder
> takes longer than that, you may see a higher percentage of transactions being voided
> shortly after you have approved them."*

Timeout declines surface as `detailed_result = CUSTOMER_ASA_TIMEOUT`.

**Vercel implication:** a serverless function cold start plus a Neon connection
establishment can eat well past 3s. If you attempt ASA, use Edge runtime or a warm
route, keep the DB query to a single indexed lookup, and hard-cap your own work with a
~2s internal timeout that falls back to a default decision.

### Signing

Same Standard Webhooks scheme as §5 — but the three headers are **NOT sent by default**.
They start appearing (within minutes) only after you call:

```
GET  /v1/auth_stream/secret      → creates the key if absent, returns it
POST /v1/auth_stream/secret/rotate  → old key deactivated after 24h
```

Both are available in sandbox. The Sandbox ASA key also appears on
https://app.lithic.com/account **only after** you've enrolled a sandbox ASA responder
endpoint. Secrets are **per-program**.

### Retry behaviour (different from Events)

Lithic retries an ASA request **once, immediately**, on a connection failure or 5xx. It
does **not** retry on 4xx or on a 2xx with an invalid body. So your ASA handler can be
called twice for the same authorization — make the decision idempotent.

### Ordering caveat

Lithic runs its own pre-checks (default security rules, Authorization Rules, balance
checks for authorization-from-balance) **before** calling you. If those decline, **your
endpoint is never invoked.** Don't build a demo that assumes every simulated auth reaches
your ASA handler — a card spend limit will decline it upstream of you.

Also note: `/v1/simulate/authorize` docs warn that once you're configured for ASA,
**simulating authorizations requires your ASA client to be up and returning valid JSON**.
Enrolling a broken ASA endpoint will break your otherwise-working simulate flow. Enroll
ASA last, and keep the disenroll call handy.

Reference implementations: https://github.com/lithic-com/asa-demo-node and
https://github.com/lithic-com/asa-demo-python (both AWS SAM + Lambda).

---

## 7. Rate limits and sandbox gotchas

### Rate limits

Grouped **by resource and by HTTP method**, enforced separately. `429` + `retry-after: 1`
on breach. Every response carries `x-requests-remaining`.

| Resource | Sandbox read | **Sandbox write** | Prod read | Prod write |
|---|---|---|---|---|
| **`/simulate*` (sandbox only)** | 15 RPS | **1 RPS** | n/a | n/a |
| `/cards*` | 15 RPS | **2 RPS** | 30 | 15 |
| `/transactions*` | 15 RPS | 1 RPS | 30 | 5 |
| `/events*`, `/event_subscriptions*` | 15 RPS | 1 RPS | 30 | 5 |
| `/responder_endpoints*`, `/auth_stream*` | 15 RPS | 1 RPS | 30 | 5 |
| `/accounts*`, `/account_holders*`, `/financial_accounts*`, `/balances`, most others | 15 RPS | 1 RPS | 30 | 5 |
| `/transfers*` | 15 RPS | 2 RPS | 30 | 5 |

**The single biggest operational constraint on this track: `POST /v1/simulate/*` is
capped at 1 request per second in sandbox.** An auth-then-clearing pair is 2 writes ⇒ ≥1s
apart. A seed script creating 50 transactions takes ~100 seconds minimum. Serialize your
simulation calls with an explicit ≥1100ms delay, or you will spend the trial debugging
spurious 429s. Card creation is 2 RPS, marginally better.

### Sandbox gotchas

1. **1 RPS on `/simulate/*` writes** (above). Build a small queue/limiter.
2. **Fair-use policy with teeth.** *"Accounts that exhibit patterns inconsistent with
   legitimate development … are subject to enforcement action **without prior notice**,
   up to and including immediate API key revocation and account deactivation."* Do not
   loop-hammer the sandbox in CI.
3. **Default $5,000/day transaction limit** on non-ASA accounts. Raise via
   `PATCH /v1/accounts/{account_token}`. Amounts are cents, so 500000 is the ceiling.
4. **`merchant_currency` silently defaults to GBP.** The simulator accepts only USD, GBP,
   EUR and *"defaults to GBP if another ISO 4217 code is provided"* — including, by the
   letter of the doc, when omitted. **Always send `"merchant_currency": "USD"`** on
   `/simulate/authorize`, or your ledger will be reconciling GBP against USD cents.
5. **Sandbox returns full PAN + CVV**; production doesn't unless PCI-compliant. Keep PAN
   handling isolated so the code doesn't quietly become production-incompatible.
6. **`SINGLE_USE` cards close after one successful auth** — will silently break a demo of
   the auth→clear lifecycle. Use `VIRTUAL`.
7. **Not available in sandbox:** settlement reports (`GET /v1/reports/settlement/summary`),
   network totals (`/v1/network_totals*`), L2/L3 enhanced commercial data
   (`/v1/transactions/{t}/enhanced_commercial_data`). All explicitly marked "Not available
   in sandbox." If your reconciliation design leans on settlement reports, it can't be
   demoed.
8. **Webhook URLs must be HTTPS** — no localhost. Deploy the route to Vercel first, or tunnel.
9. **The simulate-authorize decline response still contains a `token`.** Check the
   resulting Transaction's `status`/`result`, not the presence of a token.
10. **Enrolling an ASA endpoint changes `/simulate/authorize` semantics** — the simulator
    will then call your ASA endpoint and require valid JSON back. Broken ASA endpoint ⇒
    broken simulations.
11. **Duplicate webhook deliveries are normal** (retries reuse the same `webhook-id`, and
    ASA retries once on 5xx). Idempotency key = `webhook-id`; unique index it.
12. **Events are queryable for 90 days** via `GET /v1/events` — a useful backstop if a
    webhook is missed during development, alongside `replay_missing`.
13. `POST /v1/cards` returns **200**, not 201; the simulate endpoints return **201**.
    Don't write `res.status === 201` checks across the board.
14. **UNCONFIRMED:** whether sandbox data is periodically reset. Not documented either way.

---

## 8. Exact curl: auth then clearing for a DIFFERENT amount

Full happy path. Substitute `$KEY` with your sandbox key. Note the `sleep 1.5`s — they
are load-bearing at 1 RPS.

```bash
export KEY="e65e2478-f516-4c9d-af36-7d1ebc5414fd"     # your sandbox key
export BASE="https://sandbox.lithic.com/v1"

# ── 0. (optional) raise the $5,000/day default limit ──────────────────────────
#     first find your account token
curl -s "$BASE/accounts" -H "Authorization: $KEY" | jq -r '.data[0].token'

# ── 1. create a VIRTUAL card ─────────────────────────────────────────────────
CARD=$(curl -s -X POST "$BASE/cards" \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: corgi-card-001" \
  -d '{
        "type": "VIRTUAL",
        "memo": "corgi trial card",
        "spend_limit": 500000,
        "spend_limit_duration": "MONTHLY",
        "state": "OPEN"
      }')
echo "$CARD" | jq '{token, last_four, pan, state, type}'
PAN=$(echo "$CARD" | jq -r .pan)

sleep 1.5

# ── 2. simulate a $38.31 AUTHORIZATION (dual-message) ────────────────────────
AUTH=$(curl -s -X POST "$BASE/simulate/authorize" \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -d "{
        \"amount\": 3831,
        \"descriptor\": \"COFFEE SHOP\",
        \"pan\": \"$PAN\",
        \"status\": \"AUTHORIZATION\",
        \"mcc\": \"5812\",
        \"merchant_acceptor_id\": \"OODKZAPJVN4YS7O\",
        \"merchant_acceptor_city\": \"LOS ANGELES\",
        \"merchant_acceptor_state\": \"CA\",
        \"merchant_acceptor_country\": \"USA\",
        \"merchant_currency\": \"USD\"
      }")
echo "$AUTH"
# → {"debugging_request_id":"…","token":"fabd829d-7f7b-4432-a8f2-07ea4889aaac"}
TXN=$(echo "$AUTH" | jq -r .token)

sleep 1.5

# ── 3. inspect: PENDING, hold = 3831, settlement = 0 ─────────────────────────
curl -s "$BASE/transactions/$TXN" -H "Authorization: $KEY" \
  | jq '{status, result,
         hold:       .amounts.hold.amount,
         settlement: .amounts.settlement.amount,
         events: [.events[] | {type, amount, result}]}'
# {"status":"PENDING","result":"APPROVED","hold":3831,"settlement":0,
#  "events":[{"type":"AUTHORIZATION","amount":3831,"result":"APPROVED"}]}

sleep 1.5

# ── 4a. CLEAR FOR A HIGHER AMOUNT ($42.14 — e.g. a tip added at the restaurant)
curl -s -X POST "$BASE/simulate/clearing" \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN\", \"amount\": 4214}"
# → {"debugging_request_id":"…"}      NOTE: no token in the clearing response

sleep 1.5

# ── 5. inspect after clearing: SETTLED, hold → 0, settlement = 4214 ──────────
curl -s "$BASE/transactions/$TXN" -H "Authorization: $KEY" \
  | jq '{status,
         hold:       .amounts.hold.amount,
         settlement: .amounts.settlement.amount,
         cardholder: .amounts.cardholder.amount,
         events: [.events[] | {type, amount, created}]}'
# expect: status SETTLED, hold 0, settlement 4214,
#         events: [{AUTHORIZATION,3831}, {CLEARING,4214}]
```

**The lower-amount variant** — identical except step 4, and start from a fresh
authorization (do not reuse a settled one):

```bash
# ── 4b. CLEAR FOR A LOWER AMOUNT ($30.00 against a $38.31 auth) ──────────────
curl -s -X POST "$BASE/simulate/clearing" \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN2\", \"amount\": 3000}"

# ── 4c. CLEAR THE FULL AUTHORIZED AMOUNT — just omit `amount` ────────────────
curl -s -X POST "$BASE/simulate/clearing" \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN3\"}"
```

**Incremental auth (advice), void, and return:**

```bash
# raise the hold from 3831 → 5000 (ABSOLUTE, not a delta)
curl -s -X POST "$BASE/simulate/authorization_advice" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN\", \"amount\": 5000}"
# → {"token":"…","debugging_request_id":"…"}

# partial void: release 1000 of the pending hold
curl -s -X POST "$BASE/simulate/void" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN\", \"amount\": 1000, \"type\": \"AUTHORIZATION_REVERSAL\"}"

# FULL void — omit `amount` (do NOT send 0; semantics undocumented)
curl -s -X POST "$BASE/simulate/void" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN\", \"type\": \"AUTHORIZATION_REVERSAL\"}"

# expiry instead of merchant reversal (always full pending amount)
curl -s -X POST "$BASE/simulate/void" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"token\": \"$TXN\", \"type\": \"AUTHORIZATION_EXPIRY\"}"

# return / refund — by PAN, settles immediately, NEW transaction token
RET=$(curl -s -X POST "$BASE/simulate/return" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"amount\": 2934, \"descriptor\": \"COFFEE SHOP\", \"pan\": \"$PAN\"}")
RTOK=$(echo "$RET" | jq -r .token)

# reverse that return
curl -s -X POST "$BASE/simulate/return_reversal" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"token\": \"$RTOK\"}"

# closest thing to a FORCE POST: single-message financial auth, settles immediately
curl -s -X POST "$BASE/simulate/authorize" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d "{\"amount\": 2500, \"descriptor\": \"ATM WITHDRAWAL\", \"pan\": \"$PAN\",
       \"status\": \"FINANCIAL_AUTHORIZATION\", \"merchant_currency\": \"USD\"}"
```

**Webhook setup + test:**

```bash
SUB=$(curl -s -X POST "$BASE/event_subscriptions" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://your-app.vercel.app/api/webhooks/lithic",
       "description":"corgi trial",
       "event_types":["card_transaction.updated"]}')
STOK=$(echo "$SUB" | jq -r .token)

# fetch the signing secret (whsec_…) — put it in the Vercel env
curl -s "$BASE/event_subscriptions/$STOK/secret" -H "Authorization: $KEY"

# fire a fake card_transaction.updated at your endpoint to test verification
curl -s -X POST "$BASE/simulate/event_subscriptions/$STOK/send_example" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d '{"event_type":"card_transaction.updated"}'
```

**ASA (stretch):**

```bash
curl -s -X POST "$BASE/responder_endpoints" \
  -H "Authorization: $KEY" -H "Content-Type: application/json" \
  -d '{"type":"AUTH_STREAM_ACCESS","url":"https://your-app.vercel.app/api/lithic/asa"}'
# → {"enrolled": true}

# turn ON signature headers for ASA (creates the key on first call)
curl -s "$BASE/auth_stream/secret" -H "Authorization: $KEY"
# → {"secret":"whsec_…"}    [UNVERIFIED: exact response field name]

# disenroll if it breaks your simulations
curl -s -X DELETE "$BASE/responder_endpoints?type=AUTH_STREAM_ACCESS" -H "Authorization: $KEY"
```

---

## 9. Summary of everything flagged UNCONFIRMED

| # | Item | Why it matters | How to settle it |
|---|---|---|---|
| 1 | Exact fields on the lithic.com signup form | Determines whether "5 min to a key" holds | Sign up |
| 2 | Whether a 2nd clearing on a fully-cleared auth is accepted (docs contradict themselves) | Multi-completion ledger design | Simulate it |
| 3 | Partial-clearing arithmetic: does hold drop to the remainder with `PENDING`, or to 0 with `SETTLED`? | **Core to Track 3's ledger** | Simulate: auth 1000, clear 600, read `amounts` + `status` |
| 4 | `simulate/void` with `amount: 0` — full void or literal zero? | Avoid a silent no-op | Omit `amount`; test 0 separately |
| 5 | Response field name of `GET /v1/auth_stream/secret` (`key` vs `secret`) | ASA verification wiring | Call it |
| 6 | Whether sandbox data is periodically reset | Demo durability | Ask support / observe |
| 7 | Whether `merchant_currency` defaults to GBP when *omitted* (vs only when an unsupported code is sent) | Currency correctness | Omit it once and read `amounts.merchant.currency` |
