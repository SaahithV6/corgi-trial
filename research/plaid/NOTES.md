# Plaid Sandbox — Research Notes (Corgi Trial, Track 3)

Researched 2026-09-09 against official docs at https://plaid.com/docs.
Everything below is Sandbox-focused. Items I could not pin to a doc page are marked
**UNCONFIRMED** — verify with a live call before relying on them.

**TL;DR**: Sandbox is free and instant (self-serve dashboard signup, no sales call, no
KYC). You can skip the Link UI entirely with `/sandbox/public_token/create`, which means
the fastest path to a linked external bank account with a real routing/account number is
two server-side HTTP calls and zero frontend work.

---

## 1. Self-serve signup, base URL, auth shape

### Steps (free + instant)

1. Go to https://dashboard.plaid.com/signup — create an account with email + password.
   No credit card, no sales contact, no application review for Sandbox.
2. Verify email, answer a short "what are you building" onboarding questionnaire.
3. Land on https://dashboard.plaid.com/developers/keys — this page shows:
   - `client_id` — one per team, shared across all environments.
   - **Sandbox secret** — environment-specific.
   - **Production secret** — present but Production API access itself is gated behind
     a separate application/Trial plan.
4. Copy `client_id` + Sandbox secret into env vars. Done — you can call the API immediately.

Docs: https://plaid.com/docs/quickstart/ ("Get your API keys" step points at
dashboard.plaid.com/developers/keys), https://plaid.com/docs/sandbox/ describes Sandbox as
"a free and fully-featured environment for application development and testing."

> Sandbox is unlimited and free. Only Production/Limited Production requires a plan.
> Note: Sandbox **is** rate-limited, but generously — not a concern for a 48h trial.

### Environments / base URLs

| Environment | Base URL |
|---|---|
| Sandbox | `https://sandbox.plaid.com` |
| Production | `https://production.plaid.com` |

(There is no longer a `development.plaid.com`; Plaid retired the Development environment
in favor of "Limited Production". Not relevant for this trial.)

Docs: https://plaid.com/docs/api/

### Auth shape

Every endpoint is `POST`, `Content-Type: application/json`, TLS 1.2+. Credentials go
**either** in the JSON body **or** in headers — both are supported:

```
# Body style (what all the docs examples use)
{"client_id": "...", "secret": "...", ...}

# Header style
PLAID-CLIENT-ID: <client_id>
PLAID-SECRET: <secret>
```

I use the **header style** in the adapter so credentials never appear in a request body
that might get logged as part of a payload dump. Both are equally valid.

There is no `Plaid-Version` header requirement documented for the modern API; the API is
versioned per-team in the dashboard (leave it at the default).

Docs: https://plaid.com/docs/api/

---

## 2. Full Link flow for Next.js App Router

Four steps: **create link_token (server) → open Link (client) → exchange public_token
(server) → call products with access_token (server)**.

### 2a. `/link/token/create` — server side

Must be called from a Route Handler / Server Action. Never ship the secret to the browser.

Required fields:

| Field | Notes |
|---|---|
| `client_id`, `secret` | body or headers |
| `client_name` | string, **max 30 chars**, shown in the Link UI |
| `language` | `"en"` |
| `country_codes` | `["US"]` (array, min 1) |
| `user.client_user_id` | your own stable user id. Do **not** put PII here — Plaid recommends a UUID, not an email |
| `products` | `["auth"]` for our funding use case. At least one required (unless update mode) |

Useful optional fields:

| Field | Notes |
|---|---|
| `webhook` | HTTPS URL; Item + Auth webhooks for this Item go here |
| `redirect_uri` | **only needed for OAuth institutions**; must be pre-registered in the dashboard |
| `access_token` | update mode (re-auth an existing Item); omit `products` when using it |
| `account_filters` | `{"depository": {"account_subtypes": ["checking","savings"]}}` — strongly recommended for a neobank funding flow so users can't pick a credit card |
| `optional_products` | best-effort extras (e.g. `["identity"]`) that don't fail the link if unavailable |
| `required_if_supported_products` | e.g. `["identity"]` — fetched when the institution supports it, and required when it does |
| `link_customization_name` | dashboard-defined Link UI customization |
| `hosted_link` | Plaid-hosted Link page (returns a URL you redirect to instead of embedding) |

Response:

```json
{
  "link_token": "link-sandbox-af1a0311-da53-4636-b754-dd15cc058176",
  "expiration": "2020-03-27T12:56:34Z",
  "request_id": "..."
}
```

`link_token` is valid for **4 hours** and is **single-use for a completed Link session**.
Create a fresh one per Link open.

Docs: https://plaid.com/docs/api/link/

curl:

```bash
curl -sS -X POST https://sandbox.plaid.com/link/token/create \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "'"$PLAID_CLIENT_ID"'",
    "secret": "'"$PLAID_SECRET"'",
    "client_name": "Corgi Business Banking",
    "language": "en",
    "country_codes": ["US"],
    "user": { "client_user_id": "biz_01J8ZQ4K7N2X" },
    "products": ["auth"],
    "optional_products": ["identity"],
    "webhook": "https://corgi-trial.vercel.app/api/webhooks/plaid",
    "account_filters": {
      "depository": { "account_subtypes": ["checking", "savings"] }
    }
  }' | jq
```

### 2b. Rendering Link in React (App Router)

Package: **`react-plaid-link`**, current version **5.0.0**
(peer deps: `react` `^16.8 || ^17 || ^18 || ^19`; only runtime dep is `prop-types`).
Docs: https://plaid.com/docs/link/web/ · registry: https://registry.npmjs.org/react-plaid-link/latest

```bash
npm i react-plaid-link@5
```

App Router specifics that matter:

- The component **must** be a Client Component — put `'use client'` at the top of the file.
  `usePlaidLink` injects Plaid's `link-initialize.js` script and touches `window`.
- Do not render it from a Server Component without a client boundary; if you get hydration
  complaints, wrap with `next/dynamic` + `{ ssr: false }`. (Note: `ssr: false` is not
  allowed inside a Server Component in App Router — do the dynamic import inside a client
  component.)
- Fetch the `link_token` from your route handler in a `useEffect`, then pass it to the hook.
  The hook re-initializes when `token` changes.

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  usePlaidLink,
  type PlaidLinkOptions,
  type PlaidLinkOnSuccess,
} from 'react-plaid-link';

export function LinkBankButton() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/plaid/link-token', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => setToken(d.link_token));
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>((public_token, metadata) => {
    // metadata.institution, metadata.accounts[] (account_id, name, mask, type, subtype)
    fetch('/api/plaid/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token, accounts: metadata.accounts }),
    });
  }, []);

  const config: PlaidLinkOptions = {
    token,
    onSuccess,
    onExit: (err) => {
      if (err?.error_code === 'INVALID_LINK_TOKEN') {
        // token expired / already used — mint a new one and retry
      }
    },
    onEvent: (eventName, meta) => console.debug('plaid', eventName, meta),
  };

  const { open, ready } = usePlaidLink(config);

  return (
    <button onClick={() => open()} disabled={!ready || !token}>
      Link a bank account
    </button>
  );
}
```

The hook returns `{ open, exit, ready }`. React unmount auto-destroys the Link handler
(unlike the raw JS SDK, where you must call `destroy()` yourself).

`onSuccess(public_token, metadata)` — `metadata` carries `institution`,
`accounts[]` (each with `id`, `name`, `mask`, `type`, `subtype`), `link_session_id`
(quote this to Plaid support), and `transfer_status`.

### 2c. OAuth / `redirect_uri` handling

Only relevant if you link an OAuth institution (in Sandbox: `ins_127287` Platypus OAuth
Bank, `ins_129644`, `ins_132241`). **Non-OAuth sandbox institutions like
`ins_109508` First Platypus Bank do not need any of this** — skip it for the trial.

Rules (https://plaid.com/docs/link/oauth/):

- The `redirect_uri` you pass to `/link/token/create` must be registered on the allowlist
  at https://dashboard.plaid.com/developers/api.
- HTTPS required. **Exception: Sandbox allows `http://localhost...`.**
- No wildcards in the API call (wildcards like `https://*.example.com/oauth.html` are
  allowed **only** on the dashboard allowlist, and not on Public Suffix List domains).
- No query parameters in the registered URI.
- No hash routing — the URI cannot contain `#`.
- On return, Plaid appends `?oauth_state_id=<...>`. Your redirect page re-initializes Link
  with `receivedRedirectUri: window.location.href` and the **same** `link_token`.
- On Vercel, register both `https://<project>.vercel.app/plaid-oauth` and your prod domain.
  Preview deployment URLs are per-deploy and effectively unregisterable — use a wildcard
  entry on the dashboard or just test OAuth on a stable domain. **UNCONFIRMED** whether a
  `https://*.vercel.app/...` wildcard is accepted, since `vercel.app` is on the Public
  Suffix List and the docs say PSL domains are rejected for wildcards. Assume it is not.

### 2d. `/item/public_token/exchange` — server side

```bash
curl -sS -X POST https://sandbox.plaid.com/item/public_token/exchange \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "'"$PLAID_CLIENT_ID"'",
    "secret": "'"$PLAID_SECRET"'",
    "public_token": "public-sandbox-b0e2c4ee-a763-4df5-bfe9-46a46bce993d"
  }' | jq
```

```json
{
  "access_token": "access-sandbox-REDACTED-ROTATED",
  "item_id": "M5eVJqLnv3tbzdngLDp9FL5OlDNxlNhlE55op",
  "request_id": "Aim3b"
}
```

`access_token` is **long-lived** — persist it (encrypted at rest) keyed by your business
entity. `public_token` expires in **30 minutes** and is single-use.

Docs: https://plaid.com/docs/api/items/

---

## 3. Sandbox test credentials

Docs: https://plaid.com/docs/sandbox/test-credentials/ ·
https://plaid.com/docs/sandbox/institutions/

### Standard

- Username `user_good`, password `pass_good` — works at **every** Sandbox institution.
- MFA (only if the institution requires it): the MFA code is `1234`.

### Selecting an institution

In the Link UI you just search for it by name. Programmatically (via
`/sandbox/public_token/create`) you pass `institution_id`:

| Institution | `institution_id` | OAuth? |
|---|---|---|
| First Platypus Bank | `ins_109508` | no — **use this one** |
| First Gingham Credit Union | `ins_109509` | no |
| Tattersall Federal Credit Union | `ins_109510` | no |
| Tartan Bank | `ins_109511` | no |
| Houndstooth Bank | `ins_109512` | no — Auth micro-deposit flows |
| Flexible Platypus Bank | `ins_116834` | no |
| First Platypus Balance Bank | `ins_130016` | no |
| Windowpane Bank | `ins_135858` | no — micro-deposit flows |
| Platypus OAuth Bank | `ins_127287` | **yes** |
| First Platypus Bank - OAuth | `ins_129644` | **yes** |
| First Platypus Bank - OAuth App2App | `ins_132241` | **yes** |
| Tartan-Dominion Bank of Canada | `ins_43` | no (CA) |
| Royal Bank of Plaid | `ins_117650` | no (UK) |

### Forcing specific outcomes

Outcomes are driven by the **password** (with username `user_good`), or by the username
for richer scenarios:

| Goal | Credentials |
|---|---|
| Happy path | `user_good` / `pass_good` |
| Force an error at link time | `user_good` / `error_<ERROR_CODE>` e.g. `error_ITEM_LOCKED`, `error_INSTITUTION_DOWN`, `error_INVALID_CREDENTIALS` |
| Automated micro-deposits (Auth) | `user_good` / `microdeposits_good` |
| MFA — device code | `user_good` / `mfa_device` (code `1234`) |
| MFA — security questions | `user_good` / `mfa_questions_<n>_<m>` (answers `answer_<i>_<j>`) |
| MFA — selections | `user_good` / `mfa_selections` (answer `Yes`) |
| Rich/custom data | `user_custom` / `<JSON config as the password>` |
| Dynamic transactions | `user_transactions_dynamic` / any password |
| Limited-purpose checking | `user_limited_purpose_checking` / `pass_good` |
| Credit/income personas | `user_bank_income`, `user_credit_profile_good`, `user_credit_profile_poor`, `user_prism_1..8` |

Full list of `error_*` codes supported:
`ACCESS_NOT_GRANTED`, `COUNTRY_NOT_SUPPORTED`, `INSTITUTION_DOWN`,
`INSTITUTION_NOT_RESPONDING`, `INSTITUTION_NO_LONGER_SUPPORTED`,
`INSTITUTION_REGISTRATION_REQUIRED`, `INSUFFICIENT_CREDENTIALS`, `INTERNAL_SERVER_ERROR`,
`INVALID_CREDENTIALS`, `INVALID_MFA`, `INVALID_SEND_METHOD`, `ITEM_LOCKED`,
`ITEM_NOT_SUPPORTED`, `MFA_NOT_SUPPORTED`, `NO_ACCOUNTS`, `PAYMENT_INSUFFICIENT_FUNDS`,
`PAYMENT_INVALID_RECIPIENT`, `PAYMENT_INVALID_REFERENCE`, `PAYMENT_INVALID_SCHEDULE`,
`PAYMENT_REJECTED`, `PAYMENT_SCHEME_NOT_SUPPORTED`, `UNAUTHORIZED_INSTITUTION`,
`USER_INPUT_TIMEOUT`, `USER_SETUP_REQUIRED`, `USER_SHOULD_VERIFY_DEPOSIT_ALLOCATIONS`.

### ⭐ Getting a KNOWN routing + account number for ACH

Two options.

**Option A — accept Plaid's defaults (fast, but values must be observed once).**
Link `ins_109508` with `user_good`/`pass_good` and call `/auth/get`. Sandbox returns a
stable, deterministic set of accounts (`Plaid Checking` mask `0000`, `Plaid Saving` mask
`1111`, plus credit/loan/investment accounts that Auth filters out).

**UNCONFIRMED (values from memory, not pinned to a current doc page — run the curl in §4
once and hard-code what you actually see):** ACH for the checking account is
`routing: "011401533"`, `wire_routing: "021000021"`, `account: "1111222233330000"`; the
savings account is `...1111`. The docs' generic `/auth/get` example shows
`routing: "011401533"`, `wire_routing: "021000021"`, `account: "9900009606"`, and the
Transfer sandbox page confirms the first two First Platypus checking/savings accounts end
in `0000` and `1111`. The Auth testing page separately documents **Houndstooth Bank
(`ins_109512`) Instant Match** as `routing 021000021` / `account 1111222233331111`, and
**Same Day Micro-deposits** as `routing 110000000` / `account 1111222233330000` /
deposit code `ABC` (https://plaid.com/docs/auth/coverage/testing/).

**Option B — pin your own numbers with `user_custom` (deterministic, recommended).**
Pass the custom-user JSON as the *password*. This is the only way to make the routing and
account numbers a value **you** chose, which is what you want if your ledger tests assert
on them.

```json
{
  "seed": "corgi-trial-1",
  "override_accounts": [
    {
      "type": "depository",
      "subtype": "checking",
      "starting_balance": 25000,
      "numbers": {
        "account": "1234567890",
        "routing": "011401533",
        "wire_routing": "021000021"
      },
      "identity": {
        "names": ["Jane Q Founder"],
        "emails": [{ "primary": true, "type": "primary", "data": "jane@corgi.test" }],
        "phone_numbers": [{ "primary": true, "type": "mobile", "data": "5551234567" }],
        "addresses": [{
          "primary": true,
          "data": {
            "street": "123 Main St", "city": "Portland",
            "region": "OR", "postal_code": "97214", "country": "US"
          }
        }]
      }
    }
  ]
}
```

Limits: ≤ 10 accounts, config ≤ ~55KB (~250 transactions). OAuth institutions may override
some fields. Use `routing: "322271627"` if you also need
`/transfer/capabilities/get` to return `true` (instant-payout eligible).

Docs: https://plaid.com/docs/sandbox/user-custom/

Combine with §5: pass the whole JSON as `options.override_password` on
`/sandbox/public_token/create` and you never open Link at all.

---

## 4. `/auth/get` and `/identity/get`

### `/auth/get`

Request: `client_id`, `secret`, `access_token`, optional `options.account_ids[]`.

```bash
curl -sS -X POST https://sandbox.plaid.com/auth/get \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "'"$PLAID_CLIENT_ID"'",
    "secret": "'"$PLAID_SECRET"'",
    "access_token": "'"$PLAID_ACCESS_TOKEN"'"
  }' | jq '.numbers.ach'
```

Response (verbatim from https://plaid.com/docs/api/products/auth/, trimmed):

```json
{
  "accounts": [
    {
      "account_id": "vzeNDwK7KQIm4yEog683uElbp9GRLEFXGK98D",
      "balances": {
        "available": 100, "current": 110, "limit": null,
        "iso_currency_code": "USD", "unofficial_currency_code": null
      },
      "mask": "9606",
      "name": "Plaid Checking",
      "official_name": "Plaid Gold Checking",
      "subtype": "checking",
      "type": "depository"
    }
  ],
  "numbers": {
    "ach": [
      {
        "account": "9900009606",
        "account_id": "vzeNDwK7KQIm4yEog683uElbp9GRLEFXGK98D",
        "routing": "011401533",
        "wire_routing": "021000021",
        "is_tokenized_account_number": false
      }
    ],
    "eft": [
      { "account": "111122223333", "account_id": "...", "institution": "021", "branch": "01140" }
    ],
    "international": [
      { "account_id": "...", "bic": "NWBKGB21", "iban": "GB29NWBK60161331926819" }
    ],
    "bacs": [
      { "account": "31926819", "account_id": "...", "sort_code": "601613" }
    ]
  },
  "item": {
    "item_id": "DWVAAPWq4RHGlEaNyGKRTAnPLaEmo8Cvq7na6",
    "institution_id": "ins_117650",
    "institution_name": "Royal Bank of Plaid",
    "available_products": ["balance", "identity", "payment_initiation", "transactions"],
    "billed_products": ["assets", "auth"],
    "consent_expiration_time": null,
    "error": null,
    "update_type": "background",
    "webhook": "https://www.genericwebhookurl.com/webhook",
    "auth_method": "INSTANT_AUTH"
  },
  "request_id": "m8MDnv9okwxFNBV"
}
```

**Where the numbers live**: `numbers.ach[]`, joined to `accounts[]` on `account_id`.
`numbers.ach` is a **flat array across all accounts** — it is *not* nested under each
account, and there is *not* necessarily one entry per account (accounts without ACH
numbers are simply absent). Always index by `account_id`.

**ACH vs wire — the distinction that matters for us:**

| Field | Use for |
|---|---|
| `routing` | **ACH** routing number (ABA). This is the one you send to your ACH provider (Increase/Moov/Column) for `ach_credit` / `ach_debit`. |
| `wire_routing` | **Fedwire** routing number, nullable. Same bank, different rail. Many banks publish a *different* ABA for wires than for ACH. Never substitute one for the other — a wire routing number in an ACH entry gets returned `R13 Invalid ACH routing number`. |
| `account` | Deposit account number, or a **tokenized** account number if `is_tokenized_account_number` is `true` (some institutions issue a per-merchant token; it is still valid for ACH but is not the customer's real DDA number, and it will differ per Item). |
| `eft` | Canadian (institution + branch/transit). Ignore for US. |
| `international` / `bacs` | IBAN/BIC and UK. Ignore for US. |

`item.auth_method` tells you how the numbers were obtained:
`INSTANT_AUTH`, `INSTANT_MATCH`, `AUTOMATED_MICRODEPOSITS`, `SAME_DAY_MICRODEPOSITS`,
`INSTANT_MICRODEPOSITS`, `DATABASE_MATCH`, `DATABASE_INSIGHTS`. Worth persisting for risk
scoring — `INSTANT_AUTH` is the strongest signal.

`accounts[].verification_status` is present when a micro-deposit flow is in progress:
`pending_automatic_verification`, `pending_manual_verification`,
`automatically_verified`, `manually_verified`, `verification_expired`, `verification_failed`.
**Do not originate an ACH debit while status is `pending_*`.**

**Auth webhooks** (https://plaid.com/docs/api/products/auth/):

| `webhook_code` | Meaning |
|---|---|
| `DEFAULT_UPDATE` | Account/routing numbers changed. "Customers that receive a `DEFAULT_UPDATE` webhook should immediately discontinue all usages of existing Auth data" and re-fetch. |
| `AUTOMATICALLY_VERIFIED` | Automated micro-deposit verification succeeded → account now usable. |
| `VERIFICATION_EXPIRED` | Micro-deposit verification failed after 7 days. |
| `SMS_MICRODEPOSITS_VERIFICATION` | Instant micro-deposit outcome. |
| `BANK_TRANSFERS_EVENTS_UPDATE` | New ACH events available (legacy Bank Transfer product). |

### `/identity/get` — account-holder name matching

Same request shape as `/auth/get`. Response adds `owners[]` to each account:

```json
{
  "accounts": [
    {
      "account_id": "BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp",
      "balances": { "available": 100, "current": 110, "iso_currency_code": "USD", "limit": null },
      "mask": "0000",
      "name": "Plaid Checking",
      "official_name": "Plaid Gold Standard 0% Interest Checking",
      "owners": [
        {
          "names": ["Alberta Bobbeth Charleson"],
          "emails": [{ "data": "accountholder0@example.com", "primary": true, "type": "primary" }],
          "phone_numbers": [{ "data": "2025550123", "primary": false, "type": "home" }],
          "addresses": [{
            "data": { "city": "Malakoff", "country": "US", "postal_code": "14236",
                      "region": "NY", "street": "2992 Cameron Road" },
            "primary": true
          }]
        }
      ],
      "subtype": "checking",
      "type": "depository"
    }
  ]
}
```

The default Sandbox identity owner is **`Alberta Bobbeth Charleson`** — handy as a fixture.
`names[]` is an array because joint accounts return multiple owners/name spellings.

**For name matching, prefer `/identity/match` over doing string comparison yourself.**
Request adds a `user` object (`legal_name`, `phone_number`, `email_address`, `address`);
response returns per-account scores:

```
legal_name:    { score: 0-100, is_nickname_match, is_first_name_or_last_name_match, is_business_name_detected }
phone_number:  { score: 0-100 }
email_address: { score: 0-100 }
address:       { score: 0-100, is_postal_code_match }
```

Plaid's guidance: **99–85 = strong match, 84–70 = partial match**; recommended threshold is
**≥ 70**. For a *business* neobank note `is_business_name_detected` — a personal-name
account holder on a business funding source is a fraud signal worth flagging.
`/identity/match` is billed separately from `/identity/get`; **UNCONFIRMED** whether it is
enabled by default on a fresh Sandbox account (it may need to be requested).

Docs: https://plaid.com/docs/api/products/identity/

---

## 5. ⭐ Sandbox-only endpoints (the time savers)

### `/sandbox/public_token/create` — skip the Link UI entirely

This is the single biggest time saver in the whole integration. It creates a fully-formed
Item server-side and hands you a `public_token`, exactly as if a user had completed Link.
**No browser, no `link_token`, no `react-plaid-link`, no OAuth.** Two calls (this +
exchange) and you have a working `access_token`.

Request fields:

| Field | Req? | Notes |
|---|---|---|
| `client_id`, `secret` | yes | |
| `institution_id` | **yes** | e.g. `ins_109508` |
| `initial_products` | **yes** | array, e.g. `["auth"]` — these become the Item's billed products |
| `options.webhook` | no | URL for this Item's webhooks. **Set this if you want to test webhooks** — `/sandbox/item/fire_webhook` needs the Item to have a webhook. |
| `options.override_username` | no | default `user_good`; set to `user_custom` for custom data |
| `options.override_password` | no | default `pass_good`; the custom-user JSON goes here (as a **string**) |
| `transactions.days_requested` | no | 1–730, default 90 |
| `income_verification` | conditional | only when `income_verification` is in `initial_products` |
| `user_token` | conditional | for user-scoped products |

```bash
# Fastest possible path: default sandbox account
curl -sS -X POST https://sandbox.plaid.com/sandbox/public_token/create \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "'"$PLAID_CLIENT_ID"'",
    "secret": "'"$PLAID_SECRET"'",
    "institution_id": "ins_109508",
    "initial_products": ["auth"],
    "options": {
      "webhook": "https://corgi-trial.vercel.app/api/webhooks/plaid",
      "override_username": "user_good",
      "override_password": "pass_good"
    }
  }' | jq
```

```json
{
  "public_token": "public-sandbox-b0e2c4ee-a763-4df5-bfe9-46a46bce993d",
  "request_id": "Aim3b"
}
```

Then feed that straight into `/item/public_token/exchange` (§2d) and `/auth/get` (§4).

**With deterministic numbers** — pass the custom-user JSON as the override password:

```bash
CUSTOM=$(jq -c . <<'JSON'
{
  "seed": "corgi-trial-1",
  "override_accounts": [{
    "type": "depository",
    "subtype": "checking",
    "starting_balance": 25000,
    "numbers": { "account": "1234567890", "routing": "011401533", "wire_routing": "021000021" },
    "identity": { "names": ["Jane Q Founder"] }
  }]
}
JSON
)

curl -sS -X POST https://sandbox.plaid.com/sandbox/public_token/create \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg cid "$PLAID_CLIENT_ID" --arg sec "$PLAID_SECRET" --arg pw "$CUSTOM" '{
        client_id: $cid, secret: $sec,
        institution_id: "ins_109508",
        initial_products: ["auth","identity"],
        options: { override_username: "user_custom", override_password: $pw }
      }')" | jq
```

Note `override_password` is a **JSON-encoded string**, not a nested object.

**UNCONFIRMED:** whether `account_filters` / `optional_products` are honored here — the
documented field list does not include them, so assume `initial_products` is the whole
story and request `["auth","identity"]` up front.

Docs: https://plaid.com/docs/api/sandbox/

### `/sandbox/item/reset_login` — simulate an expired login

Forces the Item into `ITEM_LOGIN_REQUIRED`. This is how you test update mode and your
"reconnect your bank" UX. It also causes subsequent product calls to fail with
`ITEM_LOGIN_REQUIRED`, and fires an `ITEM` / `ERROR` webhook.

```bash
curl -sS -X POST https://sandbox.plaid.com/sandbox/item/reset_login \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'","access_token":"'"$PLAID_ACCESS_TOKEN"'"}'
# => {"reset_login": true, "request_id": "..."}
```

Recovery: create a **new link_token with `access_token` set (and no `products`)**, open
Link — that's update mode — user re-authenticates, Item returns to good standing.

### `/sandbox/item/fire_webhook` — trigger webhooks on demand

```bash
curl -sS -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "'"$PLAID_CLIENT_ID"'",
    "secret": "'"$PLAID_SECRET"'",
    "access_token": "'"$PLAID_ACCESS_TOKEN"'",
    "webhook_type": "AUTH",
    "webhook_code": "DEFAULT_UPDATE"
  }'
# => {"webhook_fired": true, "request_id": "..."}
```

- `webhook_type` (optional): `AUTH`, `ITEM`, `TRANSACTIONS`, `HOLDINGS`,
  `INVESTMENTS_TRANSACTIONS`, `LIABILITIES`, `ASSETS`.
- `webhook_code` (required): `DEFAULT_UPDATE`, `NEW_ACCOUNTS_AVAILABLE`,
  `SMS_MICRODEPOSITS_VERIFICATION`, `USER_PERMISSION_REVOKED`, `USER_ACCOUNT_REVOKED`,
  `PENDING_DISCONNECT`, `RECURRING_TRANSACTIONS_UPDATE`, `LOGIN_REPAIRED`,
  `SYNC_UPDATES_AVAILABLE`, `PRODUCT_READY`, `ERROR`.

The Item must have a webhook URL (set via `options.webhook` on
`/sandbox/public_token/create`, `webhook` on `/link/token/create`, or
`/item/webhook/update`).

### `/sandbox/item/set_verification_status` — skip the micro-deposit wait

```bash
curl -sS -X POST https://sandbox.plaid.com/sandbox/item/set_verification_status \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'",
    "access_token":"'"$PLAID_ACCESS_TOKEN"'",
    "account_id":"'"$ACCOUNT_ID"'",
    "verification_status":"automatically_verified"
  }'
```

`verification_status`: `automatically_verified` | `verification_expired`.
Without this, automated micro-deposits auto-succeed after 24h — too slow for a 48h trial.

### `/sandbox/processor_token/create`

Same idea as `/sandbox/public_token/create` but returns a `processor_token` directly.
Fields: `institution_id` (required), `options.override_username/password`.
Returns `{"processor_token": "processor-sandbox-...", "request_id": "..."}`.

**UNCONFIRMED:** the docs' field list for this endpoint does not show a `processor`
parameter, which is odd given `/processor/token/create` requires one. If you need a
processor token for a *specific* partner, the reliable path is
`/sandbox/public_token/create` → exchange → `/processor/token/create` with
`processor: "increase"`.

### Simulating Item errors — summary of the four levers

| Lever | Produces |
|---|---|
| `/sandbox/item/reset_login` | `ITEM_LOGIN_REQUIRED` (expired login) on an existing Item |
| `override_password: "error_ITEM_LOCKED"` etc. on `/sandbox/public_token/create` | link-time failures |
| `/sandbox/item/fire_webhook` with `webhook_code: "ERROR"` | an `ITEM`/`ERROR` webhook without breaking the Item |
| `/sandbox/item/fire_webhook` with `PENDING_DISCONNECT` / `USER_PERMISSION_REVOKED` | consent-lifecycle webhooks |

### Transfer sandbox (only if you use Plaid Transfer as the money movement rail)

`/sandbox/transfer/simulate` (`event_type`: `posted`, `settled`, `failed`, `returned`,
`funds_available`), `/sandbox/transfer/refund/simulate`, and
`/sandbox/transfer/test_clock/*` for recurring transfers.
Use routing `322271627` on a custom user to make `/transfer/capabilities/get` return `true`.

---

## 6. Webhooks: configuration, types, and exact verification

### Configuring the URL

Three places, in order of precedence for a given Item:

1. `webhook` field on **`/link/token/create`** — the normal path. Set per Link session.
2. `options.webhook` on **`/sandbox/public_token/create`** — the Sandbox path.
3. **`/item/webhook/update`** — change it after the fact.
   Request: `client_id`, `secret`, `access_token`, `webhook` (URL, nullable to remove).
   Response: the full `item` object + `request_id`. Fires an
   `ITEM` / `WEBHOOK_UPDATE_ACKNOWLEDGED` webhook to the new URL.

A few products (Identity Verification, Monitor, some Transfer events) are configured
**team-wide in the Dashboard** instead, at https://dashboard.plaid.com/developers/webhooks.
Auth and Item webhooks are per-Item, not dashboard-configured.

### Delivery contract

- `POST`, raw JSON body, HTTPS with a valid cert.
- You must return a **2xx within 10 seconds**. Anything else (or a timeout) is a failure.
- Retries: exponential backoff starting at 30s, ×4 per attempt, **for up to 24 hours**.
- A `429` response with a `Retry-After` header is honored.
- Originates from a small fixed set of Plaid IPs (documented, subject to change) — usable
  as defense in depth but **not** a substitute for JWT verification.
- **Implication for Next.js on Vercel**: verify + enqueue + `return new Response(null,{status:200})`
  fast. Do the actual work with `waitUntil()` or a queue. A serverless cold start plus a
  Postgres round trip can flirt with 10s.

### Webhook envelope

Common fields across Item/Auth webhooks:

```json
{
  "webhook_type": "ITEM",
  "webhook_code": "ERROR",
  "item_id": "wz666MBjYWTp2PDzzggYhM6oWWmBb",
  "error": { "error_type": "ITEM_ERROR", "error_code": "ITEM_LOGIN_REQUIRED", "...": "..." },
  "environment": "sandbox"
}
```

`environment` is `"sandbox"` or `"production"` — **check it**, so a stray production
webhook can never mutate sandbox ledger rows (and vice versa).

Item webhook codes (https://plaid.com/docs/api/items/):

| Code | Meaning |
|---|---|
| `ERROR` | Item hit an error needing user action (usually `ITEM_LOGIN_REQUIRED`) |
| `LOGIN_REPAIRED` | Item recovered from `ITEM_LOGIN_REQUIRED` on its own |
| `NEW_ACCOUNTS_AVAILABLE` | User has a new account at the institution |
| `PENDING_EXPIRATION` | Consent expires in 7 days (EU/UK) |
| `PENDING_DISCONNECT` | Item disconnects in 7 days (US/CA) — prompt update mode |
| `USER_PERMISSION_REVOKED` | User revoked your access — stop using the Item, delete data |
| `WEBHOOK_UPDATE_ACKNOWLEDGED` | Confirms `/item/webhook/update`; carries `new_webhook_url` |

Auth webhook codes: see §4.

### ⭐ EXACT verification algorithm

Plaid signs every webhook with an **ES256 JWT** in the **`Plaid-Verification`** header.
There is no shared-secret HMAC. Docs:
https://plaid.com/docs/api/webhooks/webhook-verification/

JWT header:
```json
{ "alg": "ES256", "kid": "bfbd5111-8e33-4643-8ced-b2e642a72f3c", "typ": "JWT" }
```
JWT payload:
```json
{ "iat": 1560211755, "request_body_sha256": "bbe8e9..." }
```

Steps, in order — **all six are mandatory**:

1. Read the `Plaid-Verification` header. Decode the JWT **header only, without verifying**.
2. Assert `alg === "ES256"`. **Reject anything else** — this is the classic JWT
   algorithm-confusion defense (an attacker sending `alg: "none"` or `HS256` must fail).
3. Extract `kid`, then call **`/webhook_verification_key/get`** with
   `{client_id, secret, key_id: kid}` against the **same environment the webhook came
   from** (sandbox webhooks → `https://sandbox.plaid.com`). Response:

   ```json
   {
     "key": {
       "alg": "ES256", "created_at": 1560466150, "crv": "P-256",
       "expired_at": null, "kid": "bfbd5111-8e33-4643-8ced-b2e642a72f3c",
       "kty": "EC", "use": "sig",
       "x": "hKXLGIjWvCBv-cP5euCTxl8g9GLG9zHo_3pO5NN1DwQ",
       "y": "shhexqPB7YffGn6fR6h2UhTSuCtPmfzQJ6ENVIoO4Ys"
     },
     "request_id": "RZ6Omi1bzzwDaLo"
   }
   ```

   That `key` is a JWK (EC P-256 public key). **Cache it by `kid`** — Plaid rotates keys,
   so cache per-kid rather than caching a single key globally, and re-fetch on a miss.
   Reject if `key.expired_at` is non-null.
4. **Verify the JWT signature** with that JWK using ES256. Reject on failure.
5. **Freshness**: reject if `iat < now - 300` (5 minutes). Anti-replay.
6. **Body integrity**: `sha256_hex(raw_request_body)` must equal the `request_body_sha256`
   claim, compared in **constant time**.

**The trap**: step 6 is byte-sensitive. The docs warn the hash "is sensitive to the
whitespace in the webhook body and uses a tab-spacing of 2." In practice this means:
**hash the exact bytes you received**. Never `JSON.parse` then `JSON.stringify` and hash
that — it will not match. In a Next.js App Router route handler that means
`const raw = await req.text()` **before** any parsing, and parse from `raw` afterward.
(Do not use a body-parsing middleware that consumes the stream first.)

Plaid's own reference implementation (Python, verbatim from the docs):

```python
import hashlib, hmac, time, requests
from jose import jwt

CLIENT_ID = 'PLAID_CLIENT_ID'
SECRET = 'PLAID_SECRET'
ENDPOINT = 'https://production.plaid.com/webhook_verification_key/get'
CACHED_KEY = None

def verify(body, headers):
    global CACHED_KEY
    signed_jwt = headers.get('plaid-verification')
    current_key_id = jwt.get_unverified_header(signed_jwt)['kid']
    if CACHED_KEY is None:
        response = requests.post(ENDPOINT, json={
            'client_id': CLIENT_ID, 'secret': SECRET, 'key_id': current_key_id})
        if response.status_code != 200:
            return False
        CACHED_KEY = response.json()['key']
    if CACHED_KEY is None:
        return False
    try:
        claims = jwt.decode(signed_jwt, CACHED_KEY, algorithms=['ES256'])
    except jwt.JWTError:
        return False
    if claims["iat"] < time.time() - 5 * 60:
        return False
    m = hashlib.sha256()
    m.update(body.encode())
    body_hash = m.hexdigest()
    return hmac.compare_digest(body_hash, claims['request_body_sha256'])
```

Note Plaid's own sample caches a **single** key rather than a map keyed by `kid` — that is
a bug waiting for the first key rotation. `adapter.draft.ts` caches per-`kid`.

The TS version in `adapter.draft.ts` uses **Web Crypto only** (no `jose`/`jsonwebtoken`
dependency), which works on both the Node and Edge runtimes on Vercel.

---

## 7. Processor tokens (relevant if pairing Plaid with Increase / Moov)

A **processor token** is a token scoped to **one account on one Item, for one named
partner**. You hand it to the partner instead of handing them raw account+routing numbers;
the partner calls Plaid themselves (`/processor/auth/get` etc.) with it. Benefits: the
account number never lands in your infrastructure or your logs, and the partner gets a
live, revocable handle rather than a stale copy.

Endpoint: **`/processor/token/create`**

Request: `client_id`, `secret`, `access_token`, `account_id`, `processor` (enum).
Response: `{"processor_token": "processor-sandbox-...", "request_id": "..."}`.

```bash
curl -sS -X POST https://sandbox.plaid.com/processor/token/create \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'",
    "access_token":"'"$PLAID_ACCESS_TOKEN"'",
    "account_id":"'"$ACCOUNT_ID"'",
    "processor":"increase"
  }'
```

**Both `increase` and `moov` are supported enum values.** Full documented enum list
(https://plaid.com/docs/api/processors/): `dwolla`, `galileo`, `modern_treasury`,
`ocrolus`, `vesta`, `drivewealth`, `vopay`, `achq`, `check`, `checkbook`, `circle`,
`sila_money`, `rize`, `svb_api`, `unit`, `wyre`, `lithic`, `alpaca`, `astra`, **`moov`**,
`treasury_prime`, `marqeta`, `checkout`, `solid`, `highnote`, `gemini`, `apex_clearing`,
`gusto`, `adyen`, `atomic`, `i2c`, `wepay`, `riskified`, `utb`, `adp_roll`,
`fortress_trust`, `bond`, `bakkt`, `teal`, `zero_hash`, `taba_pay`, `knot`, `sardine`,
`alloy`, `finix`, `nuvei`, `layer`, `boom`, `seamlessach`, `stake`, `wedbush`, `esusu`,
`ansa`, `scribeup`, `straddle`, `loanpro`, `bloom_credit`, `sfox`, `brale`, `parafin`,
`cardless`, `open_ledger`, `valon`, `gainbridge`, `cardlytics`, `pinwheel`, `thread_bank`,
`array`, `fiant`, `oatfi`, `curinos`, `frame`, `interchecks`, `interchange`, `atomicfi`,
`pay`, `natural`, `kanmon`, `kick`, **`increase`**, `airwallex`, `cybrid`, `bizcap`,
`webull`, `kikoff_enterprise`.

Note the enum uses **snake_case** (`modern_treasury`, `apex_clearing`) — an older docs page
renders them hyphenated (`modern-treasury`); trust the API reference's snake_case.

Stripe is special-cased: use **`/processor/stripe/bank_account_token/create`**, which
returns a Stripe `btok_...` rather than a Plaid processor token.

Related: **`/processor/auth/get`** — called *by the partner* with the processor token to
retrieve the ACH numbers. **UNCONFIRMED:** whether you (the Plaid customer) can call it
with your own credentials; it is documented as a processor-side endpoint.

### Recommendation for this trial

For a 48h build, **do not bother with processor tokens on day one**. Call `/auth/get`
yourself, take `numbers.ach[].routing` / `.account`, and pass them to your ACH provider
directly. Swap to a processor token later as a hardening step — it's a one-endpoint change
on the Plaid side, and the provider-side field changes from a raw account object to a
`plaid_processor_token` field. Mention the migration path in DECISIONS.md; it reads well
and costs nothing now.

---

## Cheat sheet: zero-UI path to a linked, funded-ready account

```bash
export PLAID_CLIENT_ID=... PLAID_SECRET=...
B=https://sandbox.plaid.com

PT=$(curl -sS -X POST $B/sandbox/public_token/create -H 'Content-Type: application/json' \
  -d '{"client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'",
       "institution_id":"ins_109508","initial_products":["auth","identity"]}' \
  | jq -r .public_token)

AT=$(curl -sS -X POST $B/item/public_token/exchange -H 'Content-Type: application/json' \
  -d '{"client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'","public_token":"'"$PT"'"}' \
  | jq -r .access_token)

curl -sS -X POST $B/auth/get -H 'Content-Type: application/json' \
  -d '{"client_id":"'"$PLAID_CLIENT_ID"'","secret":"'"$PLAID_SECRET"'","access_token":"'"$AT"'"}' \
  | jq '{accounts: [.accounts[] | {account_id, name, mask, subtype}], ach: .numbers.ach}'
```

Three calls, ~2 seconds, no browser. Run this first — it also confirms the actual default
routing/account numbers so you can replace the UNCONFIRMED values in §3.

---

## Source URLs

- Sandbox overview — https://plaid.com/docs/sandbox/
- Sandbox test credentials — https://plaid.com/docs/sandbox/test-credentials/
- Sandbox institutions — https://plaid.com/docs/sandbox/institutions/
- Sandbox custom users — https://plaid.com/docs/sandbox/user-custom/
- Sandbox API reference — https://plaid.com/docs/api/sandbox/
- Quickstart — https://plaid.com/docs/quickstart/
- API conventions / base URLs — https://plaid.com/docs/api/
- Link token API — https://plaid.com/docs/api/link/
- Items API (exchange, webhooks, /item/webhook/update) — https://plaid.com/docs/api/items/
- Link on web / React — https://plaid.com/docs/link/web/
- OAuth & redirect_uri — https://plaid.com/docs/link/oauth/
- Auth API — https://plaid.com/docs/api/products/auth/
- Auth testing in Sandbox — https://plaid.com/docs/auth/coverage/testing/
- Identity API — https://plaid.com/docs/api/products/identity/
- Webhook overview — https://plaid.com/docs/api/webhooks/
- Webhook verification — https://plaid.com/docs/api/webhooks/webhook-verification/
- Processor token partners — https://plaid.com/docs/auth/partnerships/
- Processor API — https://plaid.com/docs/api/processors/
- Transfer sandbox — https://plaid.com/docs/transfer/sandbox/
- react-plaid-link (v5.0.0) — https://registry.npmjs.org/react-plaid-link/latest
