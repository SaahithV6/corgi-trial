# Evidence pack — twenty minutes, in order

The brief asks for evidence of the **live** integrations: read-only sandbox
dashboard access, or screenshots including the webhook delivery log. This is the
list, with the exact frame that counts as evidence for each, and the in-repo
proof to fall back on when a dashboard cannot be shared.

Every identifier below was read from the provider's own API on
**2026-09-10T18:2xZ**, not copied from notes.

**Before you start.** Do not capture an unmasked API key or webhook secret in any
frame. Provider dashboards mask secrets by default — leave them masked. Crop or
blur anything beginning `sk_`, `whsec_`, `secret_` or `access-sandbox-`. Two dead
sandbox credentials already sit in this repo's git history (DECISIONS 023); do
not add live ones to a screenshot.

---

## What is live, and what is not

Four slots are live. **`/api/health` is the authority** — if this file ever
disagrees with that endpoint, the endpoint is right.

| Slot | Provider | Verdict | Dashboard evidence exists? |
| --- | --- | --- | --- |
| `card_issuing` | Lithic sandbox | **live** | yes — §1 |
| `ach_rail` | Increase sandbox | **live** | yes — §2 |
| `open_banking` | Plaid sandbox | **live** | yes — §3 |
| `director_kyc` | Stripe Identity (test mode) | **live** | yes — §4 |
| `card_webhooks` | Lithic | **live** | `GET /v1/event_subscriptions -> 200` and its `/attempts` log; the deliveries themselves are §1 |
| `business_registry` | Stripe Connect | simulated (`unauthorised`) | **no — see §6** |
| `stablecoin` | USDC on Base Sepolia | simulated (`unauthorised`) | **no — see §6** |

Read `/api/health` first and screenshot it. It is the one frame that makes every
other frame checkable, and it is computed at load time rather than written down.

```
https://corgi-trial-psi.vercel.app/api/health
```

**Must show:** `"live": 4`, `"total": 7`, and the `evidence` string beside each
of the seven `slots[]`.

---

## 1. Lithic — card issuing and the delivery log · 5 minutes

Sandbox dashboard: **https://sandbox.lithic.com** → *Developers* → *Webhooks*
(event subscriptions). This is the sandbox environment; make sure the
environment selector is in frame so nobody has to guess.

### 1a. The event subscription, pointing at the production URL

**Capture:** the subscription's detail page.

**Must be visible in the frame:**

- token **`ep_3J8yb9xommtOdKee1FzpUA4GBrW`**
- URL **`https://corgi-trial-psi.vercel.app/api/webhooks/lithic`** — the deployed
  origin, not a tunnel and not localhost
- state **enabled** (`"disabled": false`)
- description *"Corgi work trial - card auth and clearing"*
- the sandbox environment indicator

### 1b. The delivery log showing 2xx

**Capture:** the delivery / attempts list for that subscription, at least eight
rows deep.

**Must be visible in the frame:** a column of **`SUCCESS`** results against
**`202`** response codes, the destination URL on each row, timestamps, and the
event tokens. Recent rows to expect:

```
2026-09-10T17:33:31Z  SUCCESS  202  msg_3J97pH5aQY9RFCvS3y4DkGgza2x
2026-09-10T17:17:43Z  SUCCESS  202  msg_3J95uENuagml3DKYTH9cf9aFhQV
2026-09-10T17:17:43Z  SUCCESS  202  msg_3J95u9JSSQDtVGRtmoxr2iXNwkR
```

202 is the correct answer here, not 200: the route stops at *verified and
persisted* and hands off to the drain, and 200 is reserved for a replay of an
event already in the inbox.

### If a screenshot is impossible

The same two facts come out of the API, and the output is a better artefact than
a screenshot because it can be re-run:

```bash
curl -s https://sandbox.lithic.com/v1/event_subscriptions \
  -H "Authorization: $LITHIC_API_KEY"

curl -s "https://sandbox.lithic.com/v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW/attempts?page_size=20" \
  -H "Authorization: $LITHIC_API_KEY"
```

**In the repo:** `src/app/api/webhooks/[provider]/route.ts` is the endpoint those
deliveries hit; §5 below is the inbox they landed in; attack 8 in
`node scripts/livefire.mjs` proves a real signed Lithic delivery and two replays
of it produce exactly one row.

---

## 2. Increase — ACH, and the return that is the interesting part · 5 minutes

Dashboard: **https://dashboard.increase.com**, sandbox environment.

### 2a. The event subscription

**Capture:** *Developers* → *Event subscriptions* → the subscription detail.

**Must be visible in the frame:**

- id **`sandbox_event_subscription_001m261qr3eanr8aw8gq2v3605c`**
- URL **`https://corgi-trial-psi.vercel.app/api/webhooks/increase`**
- status **`active`**
- created **`2026-09-10T16:17:12Z`**

### 2b. The ACH transfer that was created, submitted, settled and returned R01

**Capture:** the transfer detail page, including its event timeline.

**Must be visible in the frame:**

- id **`sandbox_ach_transfer_s2iljuavdzp2p68rh7v7`**
- amount **74219** cents — **$742.19**, outbound ACH credit
- status **`returned`**
- **`settlement.settled_at` = `2026-09-10T16:13:05Z`, still populated** — this is
  the frame's whole point, and it must not be cropped out
- return reason **`insufficient_fund`** — R01
- the lifecycle in order: `pending_submission` → `submitted` → settled →
  `returned`

Two things a reader should be able to see from that one frame: Increase has no
`settled` status at all (a settled transfer stays `submitted` and grows
`settled_at`), and the return does **not** erase the settlement. That is why
`rail_event_semantics` books an ACH return as a *new event at a new value date*
rather than as a correction of the original — DECISIONS 019.

### If a screenshot is impossible

```bash
curl -s https://sandbox.increase.com/event_subscriptions \
  -H "Authorization: Bearer $INCREASE_API_KEY"

curl -s https://sandbox.increase.com/ach_transfers/sandbox_ach_transfer_s2iljuavdzp2p68rh7v7 \
  -H "Authorization: Bearer $INCREASE_API_KEY"
```

**In the repo:** DECISIONS 019 records the whole lifecycle with timestamps;
`research/ach/NOTES.md` has the measured API shapes; `src/lib/rails/` holds the
Increase adapter and the explicit `submitted + settled_at → settled` promotion
that the frame above justifies.

---

## 3. Plaid — the sandbox account exists · 2 minutes

Dashboard: **https://dashboard.plaid.com/developers/keys**

**Capture:** the Keys page.

**Must be visible in the frame:**

- the team / account name, so it is clear this is a real Plaid account
- the **`client_id`**
- the **Sandbox** secret row, **masked** — the claim being evidenced is that the
  sandbox credential exists, not what it is
- the environment selector showing Sandbox

Do not reveal the secret. A masked row proves the account; an unmasked one
proves the account and burns the key.

### If a screenshot is impossible

The health endpoint's probe is the stronger evidence anyway, because it is a
round trip rather than a page:

```
/api/health → slots[] → open_banking → evidence: "POST /institutions/get -> 200"
```

```bash
curl -s -X POST https://sandbox.plaid.com/institutions/get \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",\"count\":1,\"offset\":0,\"country_codes\":[\"US\"]}"
```

**In the repo:** `src/lib/integrations/probe.ts` — and DECISIONS 011 explains why
this particular probe sends a fixed, well-formed body: Plaid validates request
*shape* before credentials, so a malformed probe returns `INVALID_FIELD` for a
real key and a fake one alike.

---

## 4. Stripe — Identity session and the registered endpoint · 4 minutes

Test mode throughout. A key beginning `sk_live` is refused at boot
(`src/lib/env.schema.ts`), and there is a test asserting it.

### 4a. The registered webhook endpoint

**Capture:** **https://dashboard.stripe.com/test/webhooks** → the endpoint
detail.

**Must be visible in the frame:**

- id **`we_1UEAf8DgSL5WTGpm2qVqN478`**
- URL **`https://corgi-trial-psi.vercel.app/api/webhooks/stripe`**
- status **enabled**
- the four subscribed events, all of them:
  `identity.verification_session.verified`,
  `identity.verification_session.requires_input`,
  `identity.verification_session.processing`,
  `identity.verification_session.canceled`
- the **TEST MODE** banner

### 4b. The Identity verification session

**Capture:** **https://dashboard.stripe.com/test/identity/verification-sessions**
→ the session detail.

**Must be visible in the frame:**

- id **`vs_1UEAUADgSL5WTGpmlut3O3hU`**
- type **`document`**
- status **`requires_input`**
- `livemode: false`

**Say what this is, plainly, wherever it is presented.** The session was created
against the live Stripe API and it is genuinely a Stripe Identity session — that
is what makes `director_kyc` live. Nobody completed the document upload, so it
sits at `requires_input`. It is not a verified director. Stripe Identity also
cannot be *driven* to `declined` or `needs_review` on demand, which is why
Persona is item 7 on the week-two list: `perform-simulate-actions` pushes an
inquiry through the non-happy paths and fires the real webhooks for each.

### If a screenshot is impossible

```bash
curl -s "https://api.stripe.com/v1/webhook_endpoints?limit=5" -u "$STRIPE_SECRET_KEY:"
curl -s "https://api.stripe.com/v1/identity/verification_sessions?limit=5" -u "$STRIPE_SECRET_KEY:"
```

**In the repo:** `/api/health` → `director_kyc` → evidence *"Stripe Identity
enabled (Persona not configured)"*; `src/lib/kyb/`; DECISIONS 018 for why Stripe
moved out of the registry slot and into KYC.

---

## 5. In-repo evidence, needing no dashboard at all · 4 minutes

Four artefacts. Capture the terminal output; it is reproducible, which a
screenshot of somebody else's dashboard is not.

### 5a. `node scripts/livefire.mjs`

The seven published attacks plus the replay claim, run against production with no
mocks in the directory.

```bash
set -a; . ./.env; set +a
node scripts/livefire.mjs
```

**Must be visible:** the header naming the target
(`https://corgi-trial-psi.vercel.app`) and the live provider sandboxes, and the
final line — last run: **`PASS 6   FAIL 0   SKIP 2   of 8 attacks   79s`**.
Capture the two SKIP blocks too, in full. A skip is not a pass, each one names
exactly what could not be proven, and hiding them is the thing this whole
submission is arguing against. The two skips are attack 2's `hold_closure` row
(DECISIONS 024) and attack 7's health-freshness and provider-down UI.

### 5b. `pnpm db:check`

Connects as `corgi_app` — the role the running application actually uses — and
attempts the forbidden.

```bash
set -a; . ./.env; set +a
pnpm db:check
```

**Must be visible:** the first six `PASS` lines, each ending `permission denied
for table journal_entry` / `journal_line`, and the final **`14 passed, 0
failed`**. Verified again on 2026-09-10 against production.

### 5c. `webhook_inbox` rows with verified signatures

Read-only, as the restricted role:

```bash
set -a; . ./.env; set +a
node --input-type=module -e '
import postgres from "postgres";
const sql = postgres(process.env.APP_DATABASE_URL, { ssl: "require", max: 1 });
console.log(await sql`select provider, state, count(*)::int from webhook_inbox group by 1,2 order by 1,2`);
console.log(await sql`select count(*)::int total,
  count(*) filter (where headers ? ${"webhook-signature"})::int with_sig from webhook_inbox`);
console.log(await sql`select provider_event_id, state, received_at,
  octet_length(payload::text) bytes, headers->>${"webhook-signature"} sig
  from webhook_inbox order by received_at desc limit 3`);
await sql.end();'
```

**Must be visible:** **64 rows — 53 `done`, 11 `parked`**, all `lithic`; **60 of
64 carrying a real `webhook-signature` header**; and at least one sample row with
its two-signature Standard Webhooks header and a payload over 2,000 bytes, e.g.
`msg_3J97pH5aQY9RFCvS3y4DkGgza2x` at `2026-09-10T17:33:31Z`, 2,339 bytes.

Say what the four rows without a signature are rather than filtering them out:
two are hand-made probe rows (`probe_…`, `probe2_…`) and two are the
double-encoded deliveries from the bug in DECISIONS 020, where `payload` and
`headers` were stored as jsonb *strings* until the `::text::jsonb` fix landed.
Those two are also the rows that prove the retry path worked —
`msg_3J8yjFYaE5cor4TG…` first failed at 16:18:43 and recovered at 16:23:23 once
the cast was fixed, because a failed insert answers 500 rather than swallowing
the delivery.

The 11 `parked` rows are correct behaviour, not a backlog: they are
authorisations on Lithic cards created directly in the sandbox and never
registered to a customer here, so the consumer will not guess whose money to
move. They are verified, durable, and post the moment a card is claimed.

### 5d. The on-chain USDC balance

Wallet **`0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918`** on **Base Sepolia**
(chain id 84532), USDC contract
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

Block explorer, no credentials needed:

```
https://sepolia.basescan.org/address/0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918
```

Or against the RPC:

```bash
set -a; . ./.env; set +a
curl -s -X POST "$BASE_SEPOLIA_RPC_URL" -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","data":"0x70a08231000000000000000000000000d3629d7399945a1ff2c5a1c5b0f7c9d32d3c2918"},"latest"]}'
curl -s -X POST "$BASE_SEPOLIA_RPC_URL" -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918","latest"]}'
```

**Must be visible:** USDC balance `0x1312d00` = **20.000000 USDC**, and native
balance **0 wei**. That pair is the evidence, and it is evidence of a *limit*:
the wallet can read the chain and cannot move a cent, because an ERC-20 transfer
needs roughly 390000000000 wei. There is no outbound transaction to point at,
and there should be no screenshot implying there is one.

---

## 6. Simulated slots — do not go looking for dashboard evidence

Three slots read `simulated` on `/api/health`. **None of them has a provider
dashboard artefact to capture, and that is the honest answer rather than a gap in
this pack.** Anyone asked to "find the screenshot" for these should stop here.

| Slot | Why there is nothing to screenshot | Where the evidence of the *refusal* lives |
| --- | --- | --- |
| `business_registry` | Connect IS now enabled on the account, so a Connect dashboard exists; what is missing is a wired integration. Every KYB option on the brief's menu — Middesk, Persona KYB, Sumsub KYB — is gated behind sales or business verification. | Measured, not read off a support page: `POST /v1/accounts` first returned **400** *"You can only create new accounts if you've signed up for Connect"*, and after Connect was enabled mid-trial it returns **400** *"Stripe no longer recommends Accounts v1 for new Connect integrations. Create connected accounts with POST /v2/core/accounts instead"* — the entitlement check now passes and the v1 path is retired. DECISIONS 015, 017, 018. The probe is a parameterless `POST /v1/accounts`, measured failing in both directions. |
| `stablecoin` | No transfer was ever originated, so no transaction hash exists and no explorer page will show one. | §5d above: 20.00 USDC and 0 wei of gas. DECISIONS 016 — the earlier probe called `balanceOf`, got a 200, and reported LIVE on a wallet that could not send. |
| `card_webhooks` | The *label* is unprobed, not the deliveries. There is no separate dashboard object for it — the subscription and its delivery log are §1. | `/api/health` evidence string: *"credential present but NOT probed — no round trip proves this slot works"*. DECISIONS 026 — the fallback inherited liveness from a non-empty string, which is the failure of DECISIONS 011 reintroduced inside the module written to kill it. |

Two more absences, in case someone goes hunting:

- **Persona is not signed up.** There is no Persona account and no dashboard.
  Director KYC runs on Stripe Identity instead (§4), and `/api/health` says so.
- **The ACH simulator and the scheme-file simulator are labelled simulators**
  in the code, selected when a key is absent, and they log a `warn` line saying
  so. They are not integrations and have no provider side.

---

## Tick sheet

| # | Evidence | Where | Counts only if the frame shows |
| --- | --- | --- | --- |
| 0 | Live/simulated verdicts | `/api/health` | `live: 4`, `total: 7`, all seven `evidence` strings |
| 1a | Lithic event subscription | sandbox.lithic.com → Developers → Webhooks | `ep_3J8yb9xommtOdKee1FzpUA4GBrW`, the `/api/webhooks/lithic` production URL, enabled |
| 1b | Lithic delivery log | same subscription → attempts | `SUCCESS` / **202** rows with timestamps and event tokens |
| 2a | Increase event subscription | dashboard.increase.com → Developers | `sandbox_event_subscription_001m261qr3eanr8aw8gq2v3605c`, `active`, `/api/webhooks/increase` |
| 2b | Increase ACH lifecycle | Transfers → the transfer | `sandbox_ach_transfer_s2iljuavdzp2p68rh7v7`, $742.19, `returned`, `settled_at` still set, `insufficient_fund` |
| 3 | Plaid account exists | dashboard.plaid.com/developers/keys | team name, `client_id`, **masked** sandbox secret, Sandbox selected |
| 4a | Stripe webhook endpoint | dashboard.stripe.com/test/webhooks | `we_1UEAf8DgSL5WTGpm2qVqN478`, enabled, all four identity events, TEST MODE |
| 4b | Stripe Identity session | dashboard.stripe.com/test/identity/verification-sessions | `vs_1UEAUADgSL5WTGpmlut3O3hU`, `document`, `requires_input`, `livemode: false` |
| 5a | Live fire | `node scripts/livefire.mjs` | `PASS 6  FAIL 0  SKIP 2 of 8`, both skip reasons in full |
| 5b | Immutability | `pnpm db:check` | six `permission denied` lines, `14 passed, 0 failed` |
| 5c | Signed webhook inbox | SQL in §5c | 64 rows, 53 `done` / 11 `parked`, 60 with `webhook-signature` |
| 5d | On-chain USDC | sepolia.basescan.org or RPC | 20.000000 USDC and **0 wei** gas |
