# The public HTTP API (`/api/v1`)

The developer surface a business banking on Corgi integrates against.

Every request and response on this page was **captured from a real call** against
the running app on 2026-09-11, against the live Neon branch, with real ids. The
transcripts are lightly trimmed (long arrays elided with `…`) and nothing has
been invented; where a claim could not be demonstrated by a call, this page says
so rather than describing it.

- Code: `src/app/api/v1/**` (routing only) and `src/lib/api/**` (everything else).
- Tests: `src/lib/api/guards.test.ts`, `http.test.ts`, `api.integration.test.ts`.
- The refusal list is also served live at `GET /api/v1/limits`.

---

## Contents

1. [The one-sentence safety argument](#the-one-sentence-safety-argument)
2. [Authentication](#authentication)
3. [Conventions](#conventions) — money, dates, pagination, errors
4. [Idempotency](#idempotency)
5. [Endpoints](#endpoints)
6. [Errors](#errors) — the register, with real bodies
7. [**What is deliberately NOT exposed, and why**](#what-is-deliberately-not-exposed-and-why)
8. [What the ledger cannot answer yet](#what-the-ledger-cannot-answer-yet)
9. [Relationship to the MCP surface](#relationship-to-the-mcp-surface)

---

## The one-sentence safety argument

**An integrator can *propose* money movement and can never *cause* it.**

`POST /api/v1/payments` writes one `payment_instruction` row and one `requested`
event. That is the whole of its effect. The instruction lands in the same
approval queue a person's request lands in, under the same policy version, with
the same content hash — and the credential this API authenticates resolves, by
construction, to an actor that **cannot approve**:

```
CONSTRAINT actor_only_humans_approve CHECK (NOT (kind <> 'human' AND can_approve))
```

so an approving non-human is not a row Postgres will store. On top of that,
`assert_maker_checker()` independently refuses an `approved` event whose actor is
not a human approver, whose actor is the initiator, or that cites a different
`content_hash`; and `pie_one_decision_per_actor` stops one actor approving twice
to satisfy a two-approver rule. None of those refusals is in TypeScript.

This is the MCP surface's property, exposed over HTTP to a wider audience. It
survived the move because **the HTTP surface calls the same code**: `src/lib/api`
holds no SQL and is handed `Gateway` — the interface implemented by
`src/lib/mcp/gateway.ts`, where every statement the tenant boundary governs lives
in one reviewable file.

---

## Authentication

`Authorization: Bearer <token>`, on every endpoint. There is no anonymous read.

A token is a **grant**: exactly one `business_id` and exactly one `actor_id`. No
parameter on any endpoint can widen it, because no endpoint accepts a business,
account, entity or actor identifier at all — `FORBIDDEN_QUERY_PARAMETERS` in
`src/lib/api/http.ts` is that boundary written as data, and `guards.test.ts`
asserts it over every route file.

Grants come from `API_TOKENS`, falling back to `MCP_AGENT_TOKENS` (same JSON
shape; see `.env.example`). The fallback exists so a deployment that has already
issued an agent credential for a business does not need a second secret to reach
the same data over a second protocol. For anything past a sandbox, set
`API_TOKENS`: revoking an integration should not revoke an agent.

### Why an HTTP caller must resolve to an actor of kind `agent`

This looks like a category error — an integrator is a company's back-office
system, not an agent — and it is deliberate. `actor.kind` is not a description of
what is at the other end of the socket. It is the answer to one question the
ledger asks: **may this principal approve a payment?** A credential resolving to
a *human* actor would put an integration's instruction into the queue wearing a
face that can approve, and maker-checker would then be reasoning about the wrong
principal. `src/lib/api/auth.ts` refuses any grant whose actor is not
`kind = 'agent'` with `can_approve = false`, re-read from the database at most 60
seconds stale, so revoking an integration is a row edit and not a deploy.

The token itself is hashed and compared with `timingSafeEqual` on **every**
request; only the actor lookup is cached. The comparison loop does not exit on a
hit, because an early exit leaks — through response time — roughly where in the
list a token sits.

### Real call

```
$ curl -s http://127.0.0.1:3117/api/v1/accounts
HTTP/1.1 401
www-authenticate: Bearer realm="corgi-api", error="invalid_token"

{"error":{"type":"authentication","code":"MISSING_BEARER_TOKEN",
  "message":"this endpoint requires a bearer token: send Authorization: Bearer <token>. See docs/API.md.",
  "condition":"Authorization: Bearer <token> is present on the request",
  "resolution":"Send the API token issued for your business as a bearer token. Every endpoint under /api/v1 requires one; there is no anonymous read."},
 "request_id":"req_e9bfcb619101466fa92b721ffab2a411"}
```

An unknown token, a revoked token and a mistyped one produce the **same**
`401 UNKNOWN_TOKEN` with the same wording. A caller able to tell them apart has a
probing oracle.

---

## Conventions

### Money

Every amount, everywhere, in both directions:

```json
{ "cents": "-1234", "display": "-$12.34" }
```

`cents` is a **string of signed integer cents**, always, including zero. Never a
JSON number. `JSON.parse` produces a double, and a double stops being able to
represent consecutive integers above 2^53 — about $90 trillion in cents, which is
not a fantasy figure for a gross settlement total — with no warning. This
codebase is `bigint` cents end to end and the wire format is the one place that
discipline could be quietly dropped. `src/lib/api/http.ts` carries a backstop
that fails the request if any serialiser leaks a raw `bigint` into a payload,
rather than shipping a `TypeError` out of the JSON encoder.

Sending a JSON number is refused, with the reason rather than with pedantry:

```
$ curl … -d '{"rail":"ach","amount_cents":100, …}'
HTTP/1.1 400
{"error":{"code":"INVALID_ARGUMENTS", …,
  "details":{"problems":[{"field":"amount_cents","problem":
    "amount_cents is a positive integer number of CENTS as a decimal STRING, e.g. \"125000\" for $1,250.00 — not dollars, and NOT a JSON number: JSON.parse produces a double, and a double cannot represent every cent value"}]}}}
```

### Two date axes, and neither is "the date"

Every ledger row carries both:

| field | meaning |
| --- | --- |
| `value_date` | **when it happened** — the business day the activity belongs to |
| `booking_date` / `booking_time` | **when we learned it** |
| `booking_seq` | the ledger's total order; what the opaque cursor is built from |

They are filtered independently (`value_date_from`, `booking_date_from`, …). An
integrator who treats one as "the date" gets a correct-looking answer until a
settlement reversal lands three days late, at which point their daily file
silently disagrees with the statement.

Business dates are `YYYY-MM-DD` in **book time (America/New_York)**. Instants are
ISO 8601 with a zone.

### Pagination

Cursor, never offset. The cursor is opaque — base64url of a versioned object —
and a constructed or tampered one is **refused**, not ignored:

```
$ curl … '/api/v1/transactions?cursor=2736'
HTTP/1.1 400
{"error":{"code":"INVALID_CURSOR",
  "condition":"cursor is a value copied verbatim from a previous response's page.next_cursor",
  "resolution":"Cursors are opaque: copy the whole string, do not construct or edit one. Omit the parameter to start from the newest row. A cursor is refused rather than ignored, because silently starting from the top is how a paging loop skips rows without anyone noticing."}}
```

Every list response has the same wrapper:

```json
{ "object": "list", "data": [ … ],
  "page": { "limit": 2, "has_more": true, "next_cursor": "eyJ2IjoxLCJzIjoiMjczNiJ9" } }
```

### Unknown query parameters are refused

Not ignored. A caller who sends `?business_id=…` and is quietly served their own
data walks away believing the parameter worked, and the next call they write is
the dangerous one.

```
$ curl … '/api/v1/transactions?business_id=abc'
HTTP/1.1 400
{"error":{"type":"invalid_request","code":"UNKNOWN_QUERY_PARAMETER",
  "message":"this endpoint does not accept \"business_id\"",
  "condition":"every query parameter is one this endpoint declares",
  "resolution":"Remove it. This endpoint accepts: account_code, value_date_from, value_date_to, booking_date_from, booking_date_to, rail, book, limit, cursor. …",
  "details":{"unknown":["business_id"],
             "accepted":["account_code","value_date_from","value_date_to","booking_date_from","booking_date_to","rail","book","limit","cursor"]}}}
```

### Headers

Every response: `content-type: application/json; charset=utf-8`,
`cache-control: no-store`, `x-request-id`, `x-corgi-api-version: v1`. A cached
answer about someone's balance is a wrong answer about it.

### Rate limits

Two budgets. The per-token request budget comes from the grant (60/minute on the
demo token). A much smaller **write** budget of 6 queued payments per minute
applies to `POST /api/v1/payments`, because a queued payment costs a human's
attention and sixty a minute is a denial-of-service attack on the approver — who
is the control this design rests on. Both return `429` with `Retry-After`.

Honest limitation, inherited from `src/lib/mcp/ratelimit.ts` and not implied
away: the buckets live in the process, so N warm instances permit N times the
rate. The limiter's job is to stop a well-meaning integration in a retry loop.
The controls that stop an attacker are the token, the tenant scope and the
approval queue.

---

## Idempotency

`Idempotency-Key` is **required** on every write. `[A-Za-z0-9._:-]{8,120}`.

Derive it from the **fact** that caused the payment — an invoice number, a
payroll run id — never generate one per attempt. A key per attempt turns one
retry after a socket timeout into two payments; a key per fact makes the retry a
no-op. The header is required rather than optional because an optional safety
mechanism is one that is absent exactly when it is needed.

The key is namespaced by tenant and actor before it reaches the database
(`api:<business>:<actor>:<your key>`), so one integration's `INV-2026-0041` can
never collide with — or probe for — another's.

**The replay is decided by the database, not by an `if`.**
`payment_instruction.idempotency_key` is `UNIQUE` and the insert is
`ON CONFLICT DO NOTHING`, so a concurrent double-POST has one winner at the index
and the loser reads the winner's row back.

### Proof: a real double-POST

Three POSTs, one key. Captured 2026-09-11.

```
$ K=INV-2026-0041-http-1789104133
$ BODY='{"rail":"ach","amount_cents":"125000",
         "destination":{"type":"ach","holder_name":"Harborview Supply Co",
           "routing_number":"011401533","account_number_last4":"4321","account_type":"checking"},
         "reason":"Invoice INV-2026-0041, net 30, approved by ops on 2026-09-09"}'

# 1st
$ curl -i -X POST -H "Idempotency-Key: $K" -d "$BODY" …/api/v1/payments
HTTP/1.1 201 Created
idempotency-replayed: false
location: /api/v1/payments/5bb2d788-d3c2-43f1-99e4-73deecc33110

# 2nd — identical body, same key
$ curl -X POST -H "Idempotency-Key: $K" -d "$BODY" …/api/v1/payments
HTTP/1.1 200
idempotency-replayed: true
{ "id":"5bb2d788-d3c2-43f1-99e4-73deecc33110",
  "replayed": true,
  "content_hash":"aaea81fed183858e18d390dad8f95f68377ef8dbc1781d00877b732e7295106d",
  "requested_at":"2026-09-11T05:22:14.515Z",
  "amount":{"cents":"125000","display":"$1,250.00"}, … }

# 3rd — same key, DIFFERENT amount
$ curl -X POST -H "Idempotency-Key: $K" -d '{… "amount_cents":"9900" …}' …/api/v1/payments
HTTP/1.1 409
{"error":{"type":"conflict","code":"IDEMPOTENCY_KEY_REUSED",
  "message":"Idempotency-Key \"INV-2026-0041-http-1789104133\" is already attached to a DIFFERENT payment. Nothing was queued and the original instruction is unchanged.",
  "condition":"an Idempotency-Key seen before is replayed with the same account, rail, amount, currency, destination and value date",
  "resolution":"A key identifies a payment, not an attempt. …",
  "details":{"existing_instruction_id":"5bb2d788-d3c2-43f1-99e4-73deecc33110",
             "existing_content_hash":"aaea81fe…95106d",
             "requested_content_hash":"5ef0a3ba…0013da",
             "content_hash_covers":["account","rail","amount_cents","currency","destination","value_date"]}}}
```

Asked of the database afterwards:

```
instruction rows for this key: 1
  [ { id: '5bb2d788-d3c2-43f1-99e4-73deecc33110',
      amount_cents: '125000',
      hash: 'aaea81fed183858e18d390dad8f95f68377ef8dbc1781d00877b732e7295106d' } ]
events: [ { kind: 'requested', n: 1 } ]
```

**One row, one `requested` event, amount unchanged.** The `409` is the half that
matters most on a machine-to-machine surface. `requestPayment()` returns the
ORIGINAL instruction for a replayed key *whatever the new body said*, so an
integrator reusing last week's invoice key for a different amount would otherwise
receive a confident `200` describing a payment they did not ask for — and would
reconcile against it. This endpoint computes the content hash of the **request**
using `contentHash()` from `@/lib/approvals/hash` — the same canonicalisation the
database stored, never a second one — and compares. Nothing is written either
way: the conflict is detected *after* the no-op, so the original is untouched.

`201` on a row that was written, `200` on a replay that wrote nothing, plus an
`idempotency-replayed` header. The distinction is real and free, and it lets an
integrator detect a duplicate delivery without diffing bodies.

A `5xx` is safe to retry with the **same** key.

---

## Endpoints

Base path `/api/v1`. Every example below is a real captured call. The demo token
is scoped to `Ridgeline Robotics, Inc.` (`e274546d-6bdd-5266-b0fb-cc839a7811f9`).

### `GET /api/v1` — service index

Echoes the tenant the credential is scoped to, so a token accidentally pointed at
the wrong business is visible on the first call rather than on the first payment.

```json
{
  "object": "api", "version": "v1",
  "business": { "id": "e274546d-6bdd-5266-b0fb-cc839a7811f9", "legal_name": "Ridgeline Robotics, Inc." },
  "credential": {
    "label": "demo-read-and-propose",
    "fingerprint": "7b5c37ab",
    "rate_limit_per_minute": 60,
    "max_instruction_cents": "500000",
    "can_approve": false,
    "scope": "exactly one business; no parameter on any endpoint can widen it"
  },
  "endpoints": [ … 12 entries … ],
  "conventions": { "money": "…", "dates": "…", "pagination": "…", "idempotency": "…", "errors": "…", "unknown_parameters": "…" },
  "safety": "Every write on this API lands in the same approval queue a person's request lands in, …",
  "request_id": "req_c03d20a80534445c88cc0d9fadc21259"
}
```

---

### `GET /api/v1/accounts`

Every account this token can name, plus the **KYB gate on money-out**.

```json
{
  "object": "list",
  "data": [
    { "object": "account", "code": "2100",
      "name": "Ridgeline Robotics, Inc. — business current account",
      "currency": "USD", "book": "financial", "type": "liability",
      "postable": true, "readable": true, "payable": true, "payable_note": null,
      "opened_at": "2026-09-10T01:37:39.479Z",
      "links": { "balance": "/api/v1/accounts/2100/balance" } },

    { "object": "account", "code": "2100.a94a4e92-19af-4004-8fc9-d3b77f23df0c",
      "name": "Ridgeline Robotics, Inc. — pot: Payroll — October",
      "currency": "USD", "book": "financial", "type": "liability",
      "postable": true, "readable": true, "payable": false,
      "payable_note": "A pot is readable but not payable through this API. Debiting one directly would move money out of the balance every other funding decision is judged against, with nothing on the pots screen to show for it. Move funds between pots in the console, then pay from 2100.",
      "opened_at": "2026-09-10T23:51:53.143Z",
      "links": { "balance": "/api/v1/accounts/2100.a94a4e92-19af-4004-8fc9-d3b77f23df0c/balance" } },

    { "object": "account", "code": "9100",
      "name": "Ridgeline Robotics, Inc. — card authorisation holds",
      "book": "memo", "postable": true, "readable": true, "payable": false,
      "payable_note": "Memo-book accounts carry holds, not money. They have no balance endpoint and cannot fund a payment.",
      "links": { "balance": null } }
    // …2100.<uuid> (Sales tax), 9200 (uncleared credit holds)
  ],
  "page": { "limit": 100, "has_more": false, "next_cursor": null },
  "business": { "id": "e274546d-6bdd-5266-b0fb-cc839a7811f9", "legal_name": "Ridgeline Robotics, Inc." },
  "gate": { "can_transact": true, "status": "approved", "evidence": "manual", "denial_code": null, "message": null }
}
```

**`gate` is the same predicate `requestPayment()` will consult**, reported ahead
of time so "why can I read this account but not pay from it" is answerable
*before* a payment is attempted. From a KYB-pending business:

```json
"gate": {
  "can_transact": false,
  "status": "pending",
  "evidence": "simulated",
  "denial_code": "KYB_PENDING",
  "message": "Verification is still in progress. This business can be viewed, but not transacted on."
}
```

**A pot is readable and is not payable, and that is a decision.** A pot is a real
leaf of the customer's own subtree (`2100.<uuid>`), on the financial book and
postable, so by the ledger's rules it *could* fund a payment. This API will not
let it — see [refusal A5's neighbour, AGENT-LIMITS §15](#what-is-deliberately-not-exposed-and-why):
available balance is a control **input**, and money in a pot is not in the main
account's available balance. An integration that can debit the payroll pot has
moved money out of the number every other funding decision is judged against,
with nothing on the pots screen to show for it.

**The list carries no balances, deliberately.** A balance is a point on two axes
and `balanceNow()` takes *one* snapshot to evaluate every term. Computing a
balance per account in a loop takes a fresh snapshot per account, so four
accounts is four different instants and any total a caller derives was never
true. See [What the ledger cannot answer yet](#what-the-ledger-cannot-answer-yet).

`GET /api/v1/accounts/{code}` returns one account in the same shape plus `gate`.

---

### `GET /api/v1/accounts/{code}/balance`

| param | |
| --- | --- |
| `as_of_value_date` | valid time — which business day to report |
| `as_of_booking_time` | transaction time — report it **as we believed it** at that instant |

Both, independently. This is the published live-fire question: a merchant
reverses Tuesday's settlement on Thursday; show Tuesday now, **and** prove what
you believed on Wednesday.

```json
{
  "object": "balance",
  "business": { "id": "e274546d-…", "legal_name": "Ridgeline Robotics, Inc." },
  "account": { "code": "2100", "name": "…business current account", "currency": "USD", "book": "financial" },
  "as_of": { "basis": "current", "value_date": null, "booking_time": null, "booking_watermark": null },
  "ledger_balance":    { "cents": "4102129", "display": "$41,021.29" },
  "available_balance": { "cents": "1765529", "display": "$17,655.29" },
  "difference": {
    "total": { "cents": "-2336600", "display": "-$23,366.00" },
    "components": [
      { "kind": "card_auth_holds", "count": 9,
        "amount": { "cents": "-36000", "display": "-$360.00" },
        "explanation": "Card authorisations still open. The merchant holds the customer's promise; the money has not left the ledger and cannot be spent twice." },
      { "kind": "uncleared_credits", "count": 18,
        "amount": { "cents": "-2125600", "display": "-$21,256.00" },
        "explanation": "Inbound credits booked but not released under the funds-availability policy. An ACH credit is returnable for days after it lands." },
      { "kind": "pending_outbound", "count": null,
        "amount": { "cents": "-175000", "display": "-$1,750.00" },
        "explanation": "Debits already booked with a future value date: money committed to leave. Still inside the ledger balance and not spendable. Derived from journal lines, so it has no hold row and no count." }
    ]
  },
  "formula": "available = ledger − active holds (card authorisations AND operator holds) − uncleared credits − debits already booked to leave on a future value date. Every term is a SUM over immutable rows at query time; no balance is stored in this schema. This is ledger_availability() in Postgres — the same function the customer's own screens use, so this figure can never be more permissive than what the customer is shown."
}
```

`ledger_balance + Σ components = available_balance` — asserted against live data
in `api.integration.test.ts`.

`operator_holds` is a fourth component, omitted above because it is zero for this
account. It is never folded into a total: an API that can say *which* term is
withholding the money tells a customer something true, and one that can only say
"available is less than ledger" invites a guess.

With a transaction-time cut:

```json
"as_of": { "basis": "as_believed",
           "value_date": "2026-01-31",
           "booking_time": "2026-02-01T00:00:00.000Z",
           "booking_watermark": "0" }
```

`basis` is `current`, `as_of_value_date` or `as_believed`, and it is always
named, so a caller never has to guess which day it got.

---

### `GET /api/v1/transactions`

Filters: `account_code`, `value_date_from`, `value_date_to`, `booking_date_from`,
`booking_date_to`, `rail` (`card|ach|usdc|wire|internal`), `book`
(`financial|memo`), `limit` (≤200), `cursor`.

```json
{
  "object": "list",
  "data": [
    { "object": "transaction",
      "entry_id": "4895d624-190f-4c7b-8dc2-fced5830c2e2",
      "account": { "code": "2100", "name": "Ridgeline Robotics, Inc. — business current account" },
      "value_date": "2027-11-15",
      "booking_date": "2026-09-11",
      "booking_time": "2026-09-11T05:07:55.694Z",
      "booking_seq": "2737",
      "entry_type": "original",
      "book": "financial",
      "description": "Live-fire settlement LF6-MTWHW9IB-4",
      "rail": "ach",
      "external_ref": "LF6-MTWHW9IB-4",
      "amount": { "cents": "25428", "display": "$254.28" },
      "currency": "USD",
      "memo": null,
      "reverses_entry_id": null,
      "correction_group_id": "4895d624-190f-4c7b-8dc2-fced5830c2e2" }
  ],
  "page": { "limit": 2, "has_more": true, "next_cursor": "eyJ2IjoxLCJzIjoiMjczNiJ9" }
}
```

**A correction is visible, never hidden.** `entry_type` is `original`, `reversal`
or `rebook`; `reverses_entry_id` names what a reversal negates and
`correction_group_id` ties the three together. Nothing is edited and nothing
disappears, so an integrator reconciling against this feed sees the repair as two
more rows rather than as a row that changed underneath them.

`amount` is signed: positive is money in for the account holder.

---

### `POST /api/v1/payments`

Queue a payment for **human approval**. Requires `Idempotency-Key`.

```jsonc
{
  "rail": "ach",                       // ach | usdc | wire. See A5 for why not "internal".
  "amount_cents": "125000",            // integer cents, decimal STRING
  "currency": "USD",                   // optional, USD only
  "value_date": "2026-09-11",          // optional; today..+90d, book time
  "account_code": "2100",              // optional; four digits, the business current account
  "reason": "Invoice INV-2026-0041, net 30, approved by ops on 2026-09-09",
  "destination": {
    "type": "ach",
    "holder_name": "Harborview Supply Co",
    "routing_number": "011401533",
    "account_number_last4": "4321",    // LAST FOUR ONLY — a full number is refused
    "account_type": "checking"
  }
}
```

Destination shapes: `ach` (as above), `wire`
(`holder_name`, `wire_routing_number`, optional `bic`, `account_number_last4`),
`usdc` (`chain`, `address`). The type must match the rail.

Response (`201`; a replay is `200`):

```json
{
  "object": "payment",
  "id": "cb12c5c8-c9ca-41a4-9cf6-b0d2d585d330",
  "status": "queued_for_human_approval",
  "state": "requested",
  "money_moved": false,
  "replayed": false,
  "content_hash": "…",
  "requested_at": "2026-09-11T05:24:…Z",
  "requested_by": { "actor_id": "3743dc53-…", "kind": "agent", "can_approve": false },
  "business": { "id": "e274546d-…", "legal_name": "Ridgeline Robotics, Inc." },
  "debit_account": { "code": "2100", "name": "…business current account" },
  "amount": { "cents": "300000", "display": "$3,000.00" },
  "currency": "USD",
  "rail": "ach",
  "value_date": "2026-09-11",
  "destination": { "type": "ach", "holder_name": "Harborview Supply Co",
                   "routing_number": "011401533", "account_number_last4": "4321",
                   "account_type": "checking",
                   "display": "Harborview Supply Co (ACH 011401533 ••4321)" },
  "approval": {
    "policy_id": "9315dd14-5e7f-5703-b37a-236a2531b968",
    "policy_version": "ach@2026-01-01",
    "effective_from": "2026-01-01",
    "threshold": { "cents": "250000", "display": "$2,500.00" },
    "above_threshold": true,
    "required_human_approvals": 1,
    "approvals_held": 0,
    "policy_note": "ACH debits of $2,500 or more need one approver who is not the initiator. Below that the agent may submit unattended; an ACH entry is recallable for two banking days, which bounds the damage.",
    "self_approval_possible": false,
    "enforced_by": [
      "actor.actor_only_humans_approve — CHECK (NOT (kind <> 'human' AND can_approve)): an approving non-human is not a storable row",
      "assert_maker_checker() — refuses an 'approved' event whose actor is not a human approver",
      "assert_maker_checker() — refuses an 'approved' event whose actor is the initiator",
      "assert_maker_checker() — refuses an 'approved' event citing a different content_hash",
      "payment_instruction_event.pie_one_decision_per_actor — one actor cannot approve twice to satisfy a two-approver rule",
      "src/lib/api/no-write-imports.test.ts — this surface imports no function that approves, releases or posts"
    ]
  },
  "what_happens_next": "A human approver who is not the initiator must approve this instruction once before it can be released. The credential that requested it cannot be one of them.",
  "links": { "self": "/api/v1/payments/cb12c5c8-c9ca-41a4-9cf6-b0d2d585d330" }
}
```

`money_moved: false` is on every successful response, and `status` has exactly
one possible value. Not as reassurance — because the caller is frequently a piece
of software that will relay "payment created" to a person as "your payment has
been sent" unless the field names make that impossible.

Below the threshold the wording changes and the refusal does not:

> "This instruction is below the $2,500.00 threshold for ach under policy
> ach@2026-01-01, so policy requires no second human. **It is still queued and
> unreleased**: this API has no operation that approves, submits or releases a
> payment, and nothing leaves the account until a person releases it in the
> approval queue."

Note: `reason` is **required, validated, and reaches the audit log only.**
`requestPayment()` takes no reason parameter and this surface will not write the
event row itself, so it does not reach the approver's screen. Documented rather
than quietly dropped — see
[What the ledger cannot answer yet](#what-the-ledger-cannot-answer-yet).

---

### `GET /api/v1/payments/{id}`

One instruction with its **whole event stream**, appended and never edited — so
an integrator polling this sees a release as a new event rather than as a status
field that changed.

```json
{
  "object": "payment",
  "id": "5bb2d788-d3c2-43f1-99e4-73deecc33110",
  "state": "requested",
  "money_moved": false,
  "events": [
    { "kind": "requested",
      "actor": { "id": "3743dc53-…", "name": "Corgi payments agent", "kind": "agent" },
      "approved_content_hash": null,
      "reason": null,
      "value_date": "2026-09-11",
      "occurred_at": "2026-09-11T05:22:14.515Z",
      "entry_id": null }
  ],
  "links": { "self": "/api/v1/payments/5bb2d788-d3c2-43f1-99e4-73deecc33110" }
}
```

There is no `GET /api/v1/payments` list. See
[What the ledger cannot answer yet](#what-the-ledger-cannot-answer-yet).

---

### `GET /api/v1/payees`

The payee book and every confirmation-of-payee finding. **Read-only** — see
[A8](#what-is-deliberately-not-exposed-and-why).

Filters: `rail`, `outcome` (`verified|warned|blocked`), `freshness`
(`fresh|ageing|stale|never`), `holder_name_contains`, `include_archived`, `limit`.

```json
{
  "object": "payee",
  "id": "fc359532-40bf-4fe6-b831-d4abd2e67c6d",
  "display_name": "Green coffee supplier",
  "holder_name": "Ridgeline Gatefirst it-mtwidq9u Roasters LLC",
  "rail": "ach",
  "routing_number": "011401533",
  "account_number_last4": "3434",
  "account_type": "checking",
  "created_at": "2026-09-11T05:21:37.852Z",
  "created_by": "Alex Whitfield",
  "archived": false,
  "verification": {
    "checked_at": "2026-09-11T05:21:37.852Z",
    "checked_by": "Alex Whitfield",
    "checked_days_ago": 0,
    "outcome": "warned",
    "freshness": "fresh",
    "checksum_ok": true,
    "prefix_assigned": true,
    "directory": "not_checked",
    "name_match": "unavailable",
    "name_source": "payer_asserted",
    "evidence": "simulated",
    "findings": [
      { "code": "NAME_NOT_VERIFIABLE", "severity": "note",
        "title": "No bank has confirmed the name on this account",
        "detail": "US ACH has no Confirmation of Payee network: there is no message that asks a receiving bank what name is on an account… The name below is the one your own team typed." },
      { "code": "TWIN_WITH_DIFFERENT_DETAILS", "severity": "warn",
        "title": "You already pay someone by this name at a different account",
        "detail": "…different bank details for the same name. This is what a redirected-invoice fraud looks like from the inside, and it is also what a supplier changing bank looks like. Confirm the change by a channel you already had, not one from the email that asked for it." }
    ]
  },
  "acknowledgement": { "acknowledged": true, "acknowledged_at": "2026-09-11T05:21:39.337Z",
                       "acknowledged_by": "Dana Okonkwo",
                       "reason": "Confirmed the second wire account out of band, on a number we already had." },
  "has_conflicting_twin": true
}
```

A destination whose `outcome` is `warned` and whose `acknowledged` is `false` will
be refused by `POST /api/v1/payments` with `PAYEE_WARNING_UNACKNOWLEDGED` — which
is checkable **here**, before the payment is attempted. The envelope also carries
a `writes_refused` block naming the three writes this endpoint does not have and
why.

---

### `GET /api/v1/statements` and `GET /api/v1/statements/{business_date}`

The list gives closed business days this account has something to show for:

```json
{ "object": "statement_day",
  "business_date": "2026-07-25",
  "closed_at": "2026-09-10T18:15:25.012Z",
  "booking_watermark": "508",
  "versions_published": 3,
  "line_count": 4,
  "late_posting_count": 2,
  "links": { "statement": "/api/v1/statements/2026-07-25?account_code=2100" } }
```

`late_posting_count` is the column to watch: non-zero means the published
document for that day is no longer what the ledger says the day was.

**The detail endpoint returns BOTH readings, because a statement endpoint that
returns one document is lying by omission.** Real call, `2026-07-25`:

```json
{
  "object": "statement",
  "business_date": "2026-07-25",
  "published": {
    "statement_id": "00c7b301-528a-451a-81ec-5902dd000eb9",
    "version": 1,
    "generated_at": "2026-09-10T18:15:25.349Z",
    "booking_watermark": "508",
    "content_hash":   "a2d7b19dcd546dd22f29b5ca724ebb85ee646e6c02a561071288513f611434f7",
    "reproduced": true,
    "recomputed_hash":"a2d7b19dcd546dd22f29b5ca724ebb85ee646e6c02a561071288513f611434f7",
    "format": "corgi.statement.v1",
    "format_changed": false,
    "document": {
      "opening_balance": { "cents": "2105955", "display": "$21,059.55" },
      "closing_balance": { "cents": "2201105", "display": "$22,011.05" },
      "line_count": 2,
      "lines": [
        { "entry_id": "71b59372-…", "value_date": "2026-07-25", "booking_seq": "507", "ordinal": 1,
          "entry_type": "original", "description": "Inbound ACH credit — customer funding",
          "external_ref": "STMT-DEMO-ACH-0001", "rail": "ach",
          "amount": { "cents": "120000", "display": "$1,200.00" },
          "running_balance": { "cents": "2225955", "display": "$22,259.55" } },
        { "entry_id": "eaf694e2-…", "booking_seq": "508", "ordinal": 0,
          "description": "Card clearing — Harborview Supply Co.",
          "amount": { "cents": "-24850", "display": "-$248.50" },
          "running_balance": { "cents": "2201105", "display": "$22,011.05" } }
      ]
    }
  },
  "corrected": {
    "booking_watermark": "2746",
    "document": { "opening_balance": { "cents": "2105955", "display": "$21,059.55" },
                  "closing_balance": { "cents": "2206105", "display": "$22,061.05" },
                  "line_count": 4, "lines": [ … ] }
  },
  "delta": {
    "amount": { "cents": "5000", "display": "$50.00" },
    "is_explained": true,
    "late_postings": [
      { "entry_id": "3e809365-…", "booking_seq": "509", "booking_time": "2026-09-10T18:15:26.314Z",
        "entry_type": "reversal",
        "description": "Reversal of eaf694e2-…: merchant reversed the clearing and re-presented for less",
        "reverses_entry_id": "eaf694e2-…", "correction_group_id": "eaf694e2-…",
        "amount": { "cents": "24850", "display": "$248.50" }, "affects_opening": false },
      { "entry_id": "321de4f1-…", "booking_seq": "510", "entry_type": "rebook",
        "description": "Card clearing re-presented — Harborview Supply Co.",
        "correction_group_id": "eaf694e2-…",
        "amount": { "cents": "-19850", "display": "-$198.50" }, "affects_opening": false }
      // …plus later live-fire entries whose value date falls before this period,
      //    each with "affects_opening": true
    ]
  },
  "versions": [
    { "version": 1, "booking_watermark": "508",  "closing_balance": { "cents": "2201105", … }, "line_count": 2, "content_hash": "a2d7b19d…" },
    { "version": 2, "booking_watermark": "510",  "closing_balance": { "cents": "2206105", … }, "line_count": 4, "content_hash": "461f0429…" },
    { "version": 3, "booking_watermark": "982",  "closing_balance": { "cents": "2206105", … }, "line_count": 4, "content_hash": "432e525a…" }
  ],
  "note": "Both documents are true. `published` is what the customer was told, re-derived at its frozen watermark; `corrected` is what the ledger now says that day was. A correction produces a NEW version, never an edit — which is how a real bank issues a corrected statement and the only answer that survives 'so which is it, immutable or corrected?'."
}
```

Three things worth naming in that body:

- **`reproduced: true`** — the published document was re-derived from immutable
  ledger rows at its own frozen watermark and hashed, **on this call**, and the
  hash matched. A reproducibility claim the caller cannot see is a claim they
  have to take on faith. `format_changed` separates "a money row changed"
  (impossible through the application role) from "the renderer changed", which is
  a deployment fact.
- **`delta.is_explained: true`** — the identity
  `corrected.closing − published.closing = Σ late_postings.amount` holds. If it
  ever fails, the response says so rather than printing a confident number.
- **`affects_opening`** — a late posting whose value date is *before* the period
  moved the opening balance. Same effect on the closing figure, completely
  different thing to read: "the day before was restated" rather than "this day
  was corrected".

`?version=N` selects which published version is the `published` side; v1 is the
default, because v1 is the one that went out.

`404 NO_STATEMENT_PUBLISHED` is a **state, not an error**: a day can be closed
with no statement issued yet, and a day still open has no frozen watermark to
issue one against.

---

### `GET /api/v1/reconciliation/breaks`

Where the processor's file and this ledger disagree, with aging. Filters:
`category` (`in_file_not_ledger|in_ledger_not_file|amount_mismatch`),
`min_age_days`, `include_explained`, `limit`.

```json
{
  "object": "list",
  "data": [
    { "object": "reconciliation_break",
      "break_key": "5c308105-f8c9-4d96-99e1-f6a49775e488",
      "category": "in_ledger_not_file",
      "reason_code": "unmatched_reference",
      "severity": "critical",
      "age_days": 9176, "age_bucket": "31+",
      "value_date": "2001-07-28",
      "rail": "ach", "provider": "achsim",
      "external_ref": "PLANT-MTVR17P2-3",
      "entry_id": "5c308105-f8c9-4d96-99e1-f6a49775e488",
      "file_amount": null,
      "ledger_amount": { "cents": "13333", "display": "$133.33" },
      "break_amount":  { "cents": "13333", "display": "$133.33" },
      "description": "Planted settlement PLANT-MTVR17P2-3",
      "explained_by": null }
  ],
  "page": { "limit": 2, "has_more": false, "next_cursor": null },
  "unattributable_open_breaks": 159,
  "unattributable_note": "Breaks with no journal entry have no account and therefore no business. They are counted, never listed: guessing an owner would hand one customer a row about another customer's money. A non-zero count means the books do not tie out platform-wide even if none of your rows appear above."
}
```

The diff is not re-implemented here: `v_recon_break` is the single definition of
the three categories, and the tenant predicate is pushed into the WHERE clause
rather than applied in TypeScript afterwards, so there is no moment at which this
process holds another business's break in memory.

`unattributable_open_breaks` is the **one deliberate platform-wide figure on this
entire surface**, and the trade is named rather than hidden: it is a small
cross-tenant disclosure, and it is there because telling an integrator "no
breaks" when the truth is "none of yours, and 159 nobody owns" invites them to
reassure a customer that the books tie out. A count, never a list.

---

### `GET /api/v1/limits`

This document's refusal register, served from the same data the refusals are
written in, so it cannot drift from them. Reads no customer data and touches no
table. Returns `principle`, `http_specific` (A1–A8), `inherited_from_agent_limits`
(all 20 sections of `docs/AGENT-LIMITS.md`), `guarantee_legend`,
`missing_readers`, and `error_codes` (24 registered codes).
`?error_code=KYB_PENDING` returns that entry's status, condition and resolution.

A written policy the caller cannot read is a policy enforced only by refusals the
caller cannot interpret. `404` is the worst possible answer to "can I do X",
because it is indistinguishable from a typo, from a version skew, and from a
capability that exists under a different name — so the integrator retries,
invents a workaround, or tells their customer the bank's API is broken.

---

## Errors

One shape, always:

```json
{ "error": { "type": "…", "code": "…", "message": "…",
             "condition": "…", "resolution": "…", "details": { … } },
  "request_id": "req_…" }
```

`type` is the coarse class an integrator branches on before reading `code`:
`invalid_request`, `authentication`, `refused`, `not_found`, `unprocessable`,
`conflict`, `rate_limit`, `internal`.

**`condition` names the predicate that was false; `resolution` names what would
make it true.** That is what makes this different from an ordinary API error, and
it is here because of the register the rest of this build already writes in — the
dead-letter messages on the webhook path do not say "invalid request", they name
the missing thing. A refusal with no forward path is how an integrator ends up
inventing one.

The **message** always comes from the module that refused — the KYB gate, the
payee check, the approvals module — and is never rewritten here. That module
knows the amounts, the names and the dates; this layer does not, and a duplicate
sentence is how the two drift. The single exception is `MISSING_BEARER_TOKEN`,
where the upstream wording points at `docs/MCP.md`; only the pointer is replaced,
never the decision. A refusal code with no register entry is honest about it: a
`422` carrying the upstream message and a resolution that says this layer holds
no remedy for that code.

### The register

| code | HTTP | condition | remedy, in one line |
| --- | --- | --- | --- |
| `MISSING_BEARER_TOKEN` | 401 | a bearer token is present | send the token issued for your business |
| `UNKNOWN_TOKEN` | 401 | the token matches a grant | same wording for mistyped, revoked and never-existed, on purpose |
| `NO_TOKENS_CONFIGURED` | 401 | the deployment has ≥1 grant | operator sets `API_TOKENS`; there is no development bypass |
| `GRANT_DOES_NOT_RESOLVE` | 403 | the grant's actor and business exist | operator problem; send the `request_id` |
| `ACTOR_MAY_APPROVE` | 403 | the grant's actor is `agent`, `can_approve=false` | re-issue against a non-approving actor |
| `UNKNOWN_QUERY_PARAMETER` | 400 | every parameter is declared | remove it; the accepted list is in `details` |
| `INVALID_DATE` / `INVALID_INSTANT` / `INVALID_ENUM_VALUE` / `INVALID_BOOLEAN` / `INVALID_LIMIT` / `INVALID_INTEGER` / `INVALID_VERSION` | 400 | the parameter parses | the message names the field and the shape |
| `INVALID_CURSOR` | 400 | the cursor came from a previous response | copy it verbatim; never construct one |
| `MALFORMED_JSON` / `BODY_NOT_AN_OBJECT` / `UNSUPPORTED_MEDIA_TYPE` / `BODY_TOO_LARGE` | 400/415/413 | the body is one small JSON object | there is no batch endpoint |
| `INVALID_ARGUMENTS` | 400 | the body validates | `details.problems` names each field; unknown fields are refused |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | the header is present | derive it from the invoice, not per attempt |
| `INVALID_IDEMPOTENCY_KEY` | 400 | `[A-Za-z0-9._:-]{8,120}` | 8 minimum because a short key collides |
| `IDEMPOTENCY_KEY_REUSED` | 409 | a replayed key carries the same payment | a key identifies a payment, not an attempt |
| `KYB_NOT_STARTED` | 422 | `kyb_status = 'approved'` | a person starts it in the console; reads keep working |
| `KYB_PENDING` | 422 | `kyb_status = 'approved'` | clears itself; poll `GET /accounts` for `can_transact` |
| `KYB_NEEDS_REVIEW` | 422 | `kyb_status = 'approved'` | a named human clears it; no API call can |
| `KYB_REJECTED` | 422 | `kyb_status = 'approved'` | terminal; no retry will change it |
| `KYB_EVIDENCE_SIMULATED` / `KYB_EVIDENCE_MANUAL` | 422 | evidence this deployment accepts as real | re-run the live provider leg |
| `KYB_STATE_UNREADABLE` | 422 | the stored status parses | fails closed; operator problem |
| `PAYEE_ROUTING_NUMBER_IMPOSSIBLE` | 400 | ABA check digit is correct | arithmetic, not policy — no override is offered |
| `PAYEE_WIRE_ROUTING_NUMBER_MISSING` | 400 | a wire carries a wire ABA | a BIC is not a Fedwire address |
| `PAYEE_WARNING_UNACKNOWLEDGED` | 422 | no unsigned warning on this destination | a person signs it in the console; the payment is then unchanged |
| `PAYEE_STANDING_CHECK_UNAVAILABLE` | 503 | the payee book is readable | retry with the same key; an unchecked payment is not a checked one |
| `INSUFFICIENT_AVAILABLE_FUNDS` | 422 | `amount_cents <= available_cents` | the four figures are in `details` |
| `ABOVE_TOKEN_CEILING` | 422 | `amount_cents <= the token's ceiling` | a property of the credential, not the account |
| `VALUE_DATE_IN_THE_PAST` | 400 | `value_date >= today` (book time) | backdating money out is not a correction |
| `VALUE_DATE_TOO_FAR_AHEAD` | 400 | `value_date <= today + 90d` | beyond that it is a mandate |
| `ACCOUNT_NOT_FOUND` | 404 | the code names an open account of this business | `GET /accounts` lists every code |
| `ACCOUNT_NOT_PAYABLE` | 422 | postable and on the financial book | memo accounts carry holds, not money |
| `NO_SUCH_INSTRUCTION` | 404 | the instruction is this business's | same answer for "does not exist" and "someone else's" |
| `NO_STATEMENT_PUBLISHED` | 404 | a version exists for this day | a state, not an error |
| `POLICY_MISSING` | 422 | a policy version is in force | operator problem, never a default threshold |
| `RATE_LIMITED` / `WRITE_RATE_LIMITED` / `TOO_MANY_FAILED_AUTH` | 429 | under the budget | `Retry-After` carries the number |
| `UNAVAILABLE` | 503 | the database is reachable | retry with the SAME key |
| `INTERNAL_ERROR` | 500 | the handler completes | our fault; retry with the SAME key |

### Real refusal bodies

**The KYB gate** — a business whose verification is still pending:

```json
{"error":{"type":"unprocessable","code":"KYB_PENDING",
  "message":"Verification is still in progress. This business can be viewed, but not transacted on.",
  "condition":"business.kyb_status = 'approved'",
  "resolution":"A provider has the case and has not answered. This one clears itself: poll GET /api/v1/accounts and retry the payment when the account reports can_transact true. Do not retry in a tight loop — provider decisions are minutes, not milliseconds."},
 "request_id":"req_b65e8e79b8b747f9a157acdac115bdfa"}
```

**Confirmation of payee** — an ABA that cannot exist. Note that the upstream
message does the arithmetic and names the likely transposition:

```json
{"error":{"type":"invalid_request","code":"PAYEE_ROUTING_NUMBER_IMPOSSIBLE",
  "message":"The check digit does not hold: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) = 68, which is 8 away from a multiple of ten. No bank has this routing number. Two adjacent digits look swapped: 011401533 would be valid. Check the payee's paperwork rather than accepting a guess.",
  "condition":"ABA check digit of destination.routing_number is correct",
  "resolution":"The routing number cannot exist — this is arithmetic, not a policy, so no override is offered and none would be right. The message names the transposed digits when two adjacent ones look swapped. Re-read the payee's paperwork and send the correct number."}}
```

**The funds check**, itemised:

```json
{"error":{"type":"unprocessable","code":"INSUFFICIENT_AVAILABLE_FUNDS",
  "message":"$50,000.00 exceeds the available balance of $17,655.29 on account 2100. Nothing was queued.",
  "condition":"amount_cents <= available_cents on the debit account",
  "resolution":"GET /api/v1/accounts/2100/balance returns the same figure with the difference itemised — open card authorisations, operator holds, uncleared credits, and debits already booked to leave. Either reduce the amount or wait for the named term to clear. This is ledger_availability(), the same function the customer's own screen uses, so it can never read higher than what they are shown.",
  "details":{"requested":{"cents":"5000000","display":"$50,000.00"},
             "available":{"cents":"1765529","display":"$17,655.29"},
             "ledger":{"cents":"4102129","display":"$41,021.29"},
             "held":{"cents":"2336600","display":"$23,366.00"}}}}
```

The funds check here is **pre-flight only**, and the response says so. The binding
check is at *release*, against the balance at that moment — an available balance
from thirty seconds ago is a fact about the past, and a card authorisation can
land in between. It refuses anyway, because putting a payment that cannot fund in
front of an approver wastes the scarcest resource in this design.

**The per-token ceiling:**

```json
{"error":{"type":"unprocessable","code":"ABOVE_TOKEN_CEILING",
  "message":"this token may queue at most $5,000.00 per instruction; $6,000.00 was requested",
  "condition":"amount_cents <= the per-instruction ceiling on this token",
  "resolution":"The ceiling bounds how large a thing this integration may put in front of a human approver, and it is a property of the credential rather than of the account. A larger one is an operator decision made when the token is issued.",
  "details":{"requested":{"cents":"600000","display":"$6,000.00"},
             "ceiling":{"cents":"500000","display":"$5,000.00"}}}}
```

**A backdated payment:**

```json
{"error":{"type":"invalid_request","code":"VALUE_DATE_IN_THE_PAST",
  "message":"value_date 2026-09-01 is before today (2026-09-11, book time)",
  "condition":"value_date >= today in book time (America/New_York)",
  "resolution":"Backdating money out is not a correction, it is a claim that a payment already happened. Send today's date or a future one. A genuine correction is a reversal plus a re-book, performed by a person; this API can post neither.",
  "details":{"value_date":"2026-09-01","book_today":"2026-09-11"}}}
```

**A wire with no wire ABA** — the mistake this field exists to catch is omitting
it and sending a BIC, so the message is attached to the *type* check and not only
to the pattern:

```json
{"error":{"code":"INVALID_ARGUMENTS",
  "message":"invalid request body: destination.wire_routing_number — wire_routing_number is required: it is the receiving bank's 9-digit WIRE ABA, which is a DIFFERENT number from the same bank's ACH ABA. A BIC is not a substitute — it identifies a bank on the SWIFT network and Fedwire does not read it — and a wire without this is refused by the payee gate before anything is queued."}}
```

---

## What is deliberately NOT exposed, and why

`docs/AGENT-LIMITS.md` holds twenty refusals for the MCP surface, each with an
argument, an enforcement mechanism and a forward path. **Every one of them
applies here unchanged and is inherited rather than restated** — `GET /api/v1/limits`
serves the same array, and `guards.test.ts` fails the build if this surface ever
claims a section that no longer exists. Restating twenty arguments in a second
document is how the two lists disagree six weeks from now.

### Why the HTTP surface must be *stricter*, not merely equal

1. **The audience is wider and flatter.** An MCP token is handed to one agent
   configured by one operator. An HTTP token is handed to whoever an integrator's
   engineering team decides should hold it, lives in their CI, and is copied into
   their staging environment. Same operations, more people, more often.
2. **Nobody reads the refusal.** The MCP refusals are written for a language model
   that will read `reason` and `instead` and change course — `list_agent_limits`
   exists so it can. An HTTP client reads a status code. A `403` with a beautiful
   paragraph in it is retried in a loop by a `while (!ok)` someone wrote at 2am.
   An operation merely *discouraged* on the agent surface has to be **absent**
   here.
3. **The call rate is machine rate, not conversation rate.** An agent writes when
   a person asks it to. An integration writes on a webhook, on a cron, and on
   every retry of both. Every argument in AGENT-LIMITS that turns on write
   frequency — §13's above all — is strictly worse here.

Two guarantee levels, and flattening them into "the API cannot" would be the most
dishonest sentence on this page:

- **`unrepresentable`** — Postgres will not store the row, from any connection,
  with or without our application code in the path. Proved by attempting it.
- **`capability-absent`** — the function that performs it is not imported by
  `src/lib/api/**` or `src/app/api/v1/**`, and `guards.test.ts` fails the build if
  anyone adds it. Real, and conditional on a test surviving.

---

### A1 — Writing a card control. **This is the one I was asked to think hardest about.**

Absent: `PUT /api/v1/cards/{id}/controls`, `POST /api/v1/cards/{id}/limits`,
`POST /api/v1/cards/{id}/block-mcc`, `PATCH /api/v1/cards/{id}`.
Sharpens AGENT-LIMITS §13. Guarantee: `capability-absent`.

**The case FOR is not weak, and pretending otherwise would be dishonest.** Card
controls are the most operationally useful write in the product and the one
customers ask for most, because the question arrives at the worst possible time:
a card declines at a pump at 06:00 and the person who can change a control is
asleep. Tightening is safe-direction. An integration that notices six declines in
four minutes across three states and tightens a card at 03:00 is doing what a
good ops team would do. Refusing it costs real money.

**The timing argument, with the measured number.** `docs/CARD-CONTROLS.md` §2
*measured* Lithic's authorisation timeout rather than quoting it: a stalled ASA
responder returns **6.527 s** against a **0.334 s** baseline, so the hard ceiling
is **6000 ms and on timeout Lithic DECLINES** — it does not approve, and it does
not retry into an approval. Our own decision path runs at 40–150 ms.

The *naive* version of the timing objection is "a control write might not land
before the authorisation arrives, so the change would be ignored", and I want to
**discard that explicitly**, because arguing against a weak form of an objection
is how a bad decision gets made. A control write is a row in
`card_control_version` and the decision path reads the current version at
authorisation time. There is no cache to warm and no third party to propagate to.
A write that commits before the ASA request is seen; one that commits after is
not. That is an ordinary race between two database transactions, and it is the
same race a human clicking the same button runs.

**The real argument is about failure mode and frequency, and it is worse over
HTTP than over MCP.** The control write and the authorisation decision contend on
the same rows, and the decision path's timeout *is a decline*. A human writes a
control roughly never — a few times in a card's life, from a screen, with a person
waiting for the page to load. An integration writes controls from a webhook
handler, on a schedule, in a retry loop, possibly for every card at once, possibly
while a webhook storm is already loading the same rows, and with none of the
natural rate limiting a person at a keyboard provides. Every other write on this
surface fails **safe** under load: a payment instruction that cannot be written is
a payment that does not get queued, and somebody notices. A control write that
contends fails **into a decline**, on a card somebody is standing in front of, at
a pump, attributed to nothing.

**But the argument I actually rest on stands even granting perfect timing and
infinite capacity.** A control change **IS an authorisation decision, made in
advance.** The values in `card_control_version` are not configuration a human
later acts on — they *are* the answer the card network receives, inside 6000 ms,
with no person on the path. An integration that unblocks MCC 5542 has not
requested a payment and has not approved one; it has arranged for the next
fuel-pump authorisation to be approved, and **no queue anywhere will ever show
that as a payment decision**.

Test it against the question this build decides new capabilities with: *if this
call were wrong, would a person get to see it before the consequence?* For a
queued payment the answer is yes, by construction — an approver reads the row. For
a control change the answer is **no, and no in a specific and nasty way**: the
person who eventually sees the consequence sees a settled card transaction that
looks exactly like every other settled card transaction. There is nothing to
review, because the review step is the thing that was written.

**Why "tighten-only" does not rescue it**, in increasing order of how much it
bothers me:

1. Tightening a business's *only* card is not inconvenience at scale — it is a
   payroll card declining at a pump. A false-positive rate that is fine for a
   consumer's tenth card is not fine for the one card a small business runs on.
2. A tighten with no unwind path is a freeze with extra steps. The integration
   cannot loosen — that is the point of tighten-only — so every false positive
   escalates to a human anyway, at 03:00, which is the hour the feature existed
   to cover.
3. The direction is not well-defined. Lowering `daily_limit_cents` is tightening.
   Blocking an MCC is tightening. Adding an *allow* list is tightening for every
   category except the ones on it, and a caller asked to "restrict this card to
   fuel and parking" reaches for exactly that. A permission whose boundary
   depends on classifying a diff as safe-direction is a permission whose boundary
   somebody gets to argue about, and they will argue correctly nine times and
   creatively once.

**What is built instead:** the reads. "This card declined because category 5542 is
blocked under control version 3, set on the 8th by Priya" is a complete answer,
it is actionable, and it ends with a person — which is the property this surface
exists to preserve. (Card *reads* are on the MCP surface today as
`list_card_controls`; the HTTP equivalent is the obvious next endpoint and is on
the cut list below, not on this refusal list.)

**What would change my mind, concretely,** because "no" without that is just
taste: a `card_control_proposal` table with its own screen and an approval step,
so the write lands in a queue the way a payment does. At that point the
integration is *proposing* again, and this entry stops applying. That is a feature
with a screen and an SLA attached; it is not an endpoint.

---

### A2 — Card numbers, CVVs, expiries, and full bank account numbers

Absent: any endpoint that returns a PAN, CVV or expiry; any parameter that
*accepts* a full account number. Sharpens §7. `capability-absent`.

The write side is the half people forget. The approvals module stores
`accountNumberLast4` because an approver needs to **recognise** a beneficiary, not
to be able to re-key the payment somewhere else. Honouring that one layer earlier
means a compromised integration cannot exfiltrate a full account number from a
response it triggers, and the audit log — which is shipped to a log aggregator by
some unrelated deploy sooner or later — cannot accidentally become the most
sensitive store in the system. Last four identifies a beneficiary in an
investigation; the other ten only create liability.

A routing number is the deliberate exception and is carried **in full**: it is
published by the Federal Reserve and is exactly what an investigator needs to name
the receiving institution. Redacting public data only makes the log useless.

Enforced by: every destination schema takes `account_number_last4` and refuses a
longer value; `redactArguments()` masks `account_number`, `iban`, `card_number`
and `pan` to last four before anything is logged.

---

### A3 — Replaying webhooks, simulating authorisations, driving the simulators

Absent under `/api/v1` entirely. Sharpens §5 and §8. `capability-absent`.

This deployment *has* operator routes that replay provider events and drive the
simulators. They are deliberately not under `/api/v1` and never will be.

An integrator who can replay a settlement webhook can **manufacture** a
settlement. The consumers are idempotent, so replaying a *real* event is
correctly a no-op — but a synthesised one that was never delivered is a journal
entry with a provider's name on it and no provider behind it, and that is
indistinguishable, in the ledger and on the statement, from money that actually
moved. The whole reconciliation feature exists to catch exactly this disagreement
between provider truth and our books; handing a caller the provider's side of it
would make the breaks screen unable to tell a real break from a manufactured one.

---

### A4 — House accounts, and anything platform-wide

Absent: `GET /api/v1/accounts/1110`, `GET /api/v1/businesses`,
`GET /api/v1/ledger/trial-balance`. `capability-absent`.

`1110` is the FBO cash account — every customer's money pooled. A single
settlement entry touches **both** the customer's leaf and the rail control
account, so an endpoint keyed on the control account would hand one business every
other business's activity on the rail. The gateway's predicate is
`business_id = $1` and **not** `business_id = $1 OR business_id IS NULL`, so a
house account is not filtered out — it is not addressable.

```
$ curl … '/api/v1/accounts/1110/balance'
HTTP/1.1 404
{"error":{"code":"ACCOUNT_NOT_FOUND",
  "message":"Ridgeline Robotics, Inc. has no open account with code 1110", …}}
```

**A cross-business read is a data breach, not a bug, and that sentence is a
test.** Real call: the demo token asked for a payment instruction that genuinely
exists and belongs to `Hold Fuzzer Fixture Co.`:

```
$ curl -H 'Authorization: Bearer <ridgeline token>' \
       …/api/v1/payments/dec453fc-a4c7-4bcd-8425-b378a75d52f7
HTTP/1.1 404
{"error":{"type":"not_found","code":"NO_SUCH_INSTRUCTION",
  "message":"no payment instruction with that id belongs to this business",
  "condition":"the instruction exists AND its debit account belongs to this token's business",
  "resolution":"The answer is identical for an id that does not exist and an id belonging to another business — telling them apart would let a caller confirm which ids are real. …"}}
```

…and the mirror, with a second token scoped to the other business asking for
Ridgeline's real instruction id — `404` — while the id returns `200` to its own
token. **Not a 403**: a distinguishable refusal confirms the id is real, which is
the first half of an enumeration attack against a uuid space someone might
otherwise assume is unguessable.

Enforced by: `gateway.findAccount`'s predicate; `FORBIDDEN_QUERY_PARAMETERS` plus
the `guards.test.ts` assertion over every route file; and
`api.integration.test.ts`, which performs the cross-business read against the live
database on every run and asserts the refusal, plus a check that two tokens get
**disjoint sets of ledger rows**.

---

### A5 — Originating an internal book transfer

Absent: `POST /api/v1/payments` with `rail: "internal"`. Sharpens §15.
`capability-absent`.

The seeded internal-rail policy is threshold 0, required approvals 0. Every other
rail here produces an instruction a human must release; `internal` would produce
the one instruction on this surface that could be released with nobody having
approved anything — which breaks the single sentence the whole design rests on.

The counter-argument is real and recorded rather than hidden: internal transfers
are arguably the safest thing to automate — both legs are ours, nothing leaves the
FBO account, and a mistake is correctable by reversal. Refusing the **rail** rather
than special-casing the **policy** is a judgement call, and the policy is where the
decision properly belongs. Until the policy says so, the rail is absent.

Pot moves are the same act in a quieter register and are refused for §15's reason,
which is the argument behind `payable: false` on every pot in `GET /accounts`.

---

### A6 — Backdating a payment, or dating one past 90 days

`capability-absent`. Sharpens §8 and §10.

Backdating money **out** is not a correction, it is a claim that a payment already
happened — and on a bitemporal ledger that claim lands on a day whose statement
may already have been issued. A genuine correction is a reversal plus a re-book,
both journal entries, both made by a person, neither reachable from here.

The forward bound is the other half of the same rule: past 90 days an instruction
is really a mandate, and **a mandate is a thing that writes payments**. This
surface may write a request; it may not write a thing that writes requests,
because the per-instruction ceiling on the token is never applied again to the
stream a mandate produces.

---

### A7 — Closing a book day, publishing or reissuing a statement

Absent: `POST /api/v1/statements`, `POST /api/v1/statements/{date}/publish`,
`POST /api/v1/book-days/{date}/close`. Sharpens §6. `capability-absent`.

Closing a day freezes the watermark every statement for that day is derived from —
it is the act that decides what "as published" will mean **forever**, and a day
closed at the wrong moment silently changes what a customer was told. Publishing
is telling a customer what their money did.

AGENT-LIMITS §6 refuses the close for the agent surface; this extends it to the
publish and the reissue, which the agent surface never had endpoints near because
it has no statement tool. Both are acts of a named person and both are recorded as
such: `book_day.closed_by` and `statement.generated_by` carry an actor id, and an
integration's id in that column would be a signature nobody signed.

Enforced by: `closeDay`, `publishStatement` and `reissueStatement` are forbidden
imports; `statement` and `book_day` are append-only (`corgi_app` holds `SELECT`
and `INSERT` and nothing else); no route under `src/app/api/v1/statements/**`
exports anything but `GET`, and `guards.test.ts` asserts that no route file on the
whole surface exports `PUT`, `PATCH` or `DELETE`.

---

### A8 — Anything that lets one credential satisfy both halves of a control

Absent: `POST /api/v1/payments/{id}/approve`, `…/release`,
`POST /api/v1/payees/{id}/acknowledge`, `POST /api/v1/kyb/{id}/approve`.
Sharpens §1, §2, §11, §16. **`unrepresentable`.**

The generalisation, stated once for this surface because an HTTP API is where
somebody eventually asks for a convenience endpoint that collapses two steps.

Every control in this build is a **second opinion**: maker-checker on a payment, a
signature on a name-match warning, a human decision on a KYB review. A control
that records a second opinion *guaranteed to match the first* is worse than no
control, because it manufactures evidence of review. Maker-checker specifically is
not primarily a control against a malicious maker — it is a control against a
mistaken one. Two people make uncorrelated mistakes; a system approving its own
instruction makes perfectly correlated ones.

For maker-checker this is not merely unreachable but unrepresentable, and the
credential this API authenticates resolves to a non-approving actor by
construction (`src/lib/api/auth.ts` refuses any grant that does not).

**Instead:** `POST /api/v1/payments` queues the request and
`GET /api/v1/payments/{id}` shows its whole event stream, so an integration can
*watch* a human approve and release it. That is the complete loop from the
outside, and the missing verb is the point of the design.

---

## What the ledger cannot answer yet

`src/lib/ledger/readers.ts` is the boundary and reaching around it is what
`boundary.test.ts` ratchets against. Where a question needs a reader nobody has
written, the honest answer is to **name the reader** — not to assemble the query
here and become the next module with its own definition of a customer's money.
These three are also served at `GET /api/v1/limits` under `missing_readers`.

**1. List every payment instruction belonging to one business.**
Wanted: a business-scoped variant of `listQueue()` in
`@/lib/approvals/instructions` — the query already joins `account`, so the
predicate is one `WHERE` clause from where it belongs.
Why not worked around: `listQueue()` is platform-wide; it feeds an operator screen
and is called with an already-scoped session. The obvious workaround — fetch the
queue and filter it in TypeScript against this business's account ids — is exactly
the pattern `mcp/gateway.ts` refuses for reconciliation breaks, for two reasons
that both apply here: it is the slower plan, and it makes tenant isolation a
**step** rather than a **predicate**, and a step can be reordered,
short-circuited or dropped by whoever next edits the paging logic. On a public API
that step is the only thing between one customer and another customer's payments.
So `POST` returns an id, `GET /payments/{id}` answers for it, and the list waits.

**2. Several accounts' balances under one snapshot.**
Wanted: the plural form of `accountAvailability()` — a set of account ids, one
`readSnapshot()`. Why not worked around: a loop takes a fresh snapshot per
account, so a list of four accounts is four different instants and any total a
caller derives from it was never true. `home/summary.ts` hit the same race and
fixed it with one `REPEATABLE READ` transaction rather than papering over it.

**3. Attach the caller's `reason` to the instruction a person will approve.**
Wanted: a `reason` parameter on `requestPayment()`, written to
`payment_instruction_event.reason` — the column exists and is `NULL` for every
`requested` event today. Why not worked around: `POST /api/v1/payments` requires
`reason` and it reaches the audit log and nothing else, because `requestPayment()`
takes no such parameter and this surface will not write the event row itself. An
integrator who believes their reason reaches the approver and finds it did not has
been misled by the API, which is worse than being told the field is audit-only.

### Cut list for this surface

Not gaps in the ledger — endpoints that are simply not built yet, in the order I
would build them: card **reads** (`GET /api/v1/cards`, controls and real-time
decisions — the MCP surface has them; see A1 for why the writes stay off),
standing-order reads, pots reads, dispute reads, accrual reads, and a webhook
*outbound* subscription so an integrator learns that a payment was released
without polling.

---

## Relationship to the MCP surface

They are the same capability behind two protocols, and that is enforced rather
than intended.

| | MCP (`/api/mcp`) | HTTP (`/api/v1`) |
| --- | --- | --- |
| tenant scoping | `Gateway` | **the same `Gateway`** |
| balance definition | `ledger_availability()` | **the same function** |
| money on the wire | decimal string of cents | **the same `money()`** |
| the one write | `initiate_payment` | `POST /api/v1/payments` |
| what the write does | queues for human approval | **identical** |
| approve / release | absent | absent |
| refusal register | 20 sections | **those 20, plus A1–A8** |
| audit | one `mcp.audit` line per call, always | **the same sink**, `surface: "api"` |

`src/lib/api/**` holds no SQL. It is handed `Gateway`, so the set of statements an
HTTP caller can cause is a matter of reading one interface — the same one an agent
can cause. The only place the HTTP surface reaches past the gateway is for
statements (`@/lib/statements/compare`, which is the console's own read) and for
the payment-by-id tenant check (`readAccountIdentity` from the ledger's own
readers), and both are named reads behind the ledger boundary, not new SQL.

One audit line per call, in a `finally`, on every path out — including every
refusal and including the throw nobody predicted:

```json
{"ts":"2026-09-11T05:25:46.264Z","level":"info","event":"mcp.audit",
 "requestId":"req_580c77718e6b483d92d5b6d4a0317d59","surface":"api",
 "method":"POST /api/v1/payments","tool":null,
 "outcome":"tool_error","errorCode":"VALUE_DATE_IN_THE_PAST",
 "actorId":"3743dc53-4e1c-577e-9a0f-e4469ffc1761",
 "businessId":"e274546d-6bdd-5266-b0fb-cc839a7811f9",
 "grantLabel":"demo-read-and-propose","grantFingerprint":"7b5c37ab",
 "clientKey":"::ffff:127.0.0.1",
 "argumentsRedacted":{"rail":"ach","amount_cents":"100","value_date":"2026-09-01",
   "destination":{"type":"ach","holder_name":"Harborview Supply Co",
     "routing_number":"011401533","account_number_last4":"4321","account_type":"checking"},
   "reason":"backdating money out is not a correction"},
 "durationMs":0,"result":null}
```

A surface that only logs what it allowed cannot answer the question people
actually ask after an incident, which is *what did it try?*. Arguments are
redacted before they are written; the routing number is not, for A2's reason.
Note that the record is the MCP surface's `AuditRecord`, reused deliberately, so
"what did the integration try" and "what did the agent try" is **one** query
rather than two log formats.

---

## Verification

```
pnpm typecheck                                   # tsconfig.json and tsconfig.test.json
pnpm lint --max-warnings=0
pnpm test                                        # guards + wire conventions
set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/api    # 56 tests, live Neon
pnpm build
node scripts/dbcheck.mjs
```

`src/lib/api/guards.test.ts` is the one worth reading: it asserts that no file on
this surface imports a function that writes, that no route reads a scope-widening
parameter off the URL, that every route file goes through the single `handle()`
gate with the node runtime pinned and caching off, that exactly one route exports
`POST` and none exports `PUT`/`PATCH`/`DELETE`, and that every endpoint A1–A8
claims is absent really is absent — by **method and path**, so a refusal cannot
quietly become a lie.

---

## Audit log — 2026-09-11, every endpoint driven by a real call

This section is a measurement, not a description. Each row below was produced by
an actual HTTP request; nothing here is inferred from reading the handler. Where
a thing was **not** reached it says so, because a skip is not a pass.

Local runs were against `next dev` on `127.0.0.1:3117` with a probe grant minted
for this audit (one business, one non-approving actor — the `API_TOKENS` shape in
`.env.example`). Production runs were against
`https://corgi-trial-psi.vercel.app`, unauthenticated only, because the
production credential is not held by the person running the audit and because a
read that needs a token is not a read to guess at.

### The public surface

| method | path | auth | happy path (measured) | refusals seen, by code |
| --- | --- | --- | --- | --- |
| GET | `/api/v1` | bearer | `200` — index, echoes the grant's business and `can_approve: false` | `MISSING_BEARER_TOKEN` 401, `UNKNOWN_TOKEN` 401, `ACTOR_MAY_APPROVE` 403 |
| GET | `/api/v1/accounts` | bearer | `200` — 2100 plus pot leaves, each with `payable` and a `payable_note` | `UNKNOWN_QUERY_PARAMETER` 400 (on `?business_id=`) |
| GET | `/api/v1/accounts/{code}` | bearer | `200` | `ACCOUNT_NOT_FOUND` 404 (`9999`) |
| GET | `/api/v1/accounts/{code}/balance` | bearer | `200` — ledger, available, and the difference itemised into three named terms | — |
| GET | `/api/v1/accounts/{code}/balance?as_of_…` | bearer | `200` on both time axes | — |
| GET | `/api/v1/transactions` | bearer | `200` — cursor-paged | — |
| POST | `/api/v1/payments` | bearer | `201 queued_for_human_approval`, `money_moved: false` | see the write table below |
| GET | `/api/v1/payments/{id}` | bearer | `200` — instruction plus its event stream | `NO_SUCH_INSTRUCTION` 404 |
| GET | `/api/v1/payees` | bearer | `200` — 50 entries with findings, freshness and acknowledgement | — |
| GET | `/api/v1/statements` | bearer | `200` — closed days with watermarks | — |
| GET | `/api/v1/statements/{business_date}` | bearer | `200` — published AND recomputed, `reproduced: true` with both hashes equal | `NO_STATEMENT_PUBLISHED` 404, `INVALID_DATE` 400 |
| GET | `/api/v1/reconciliation/breaks` | bearer | `200` — open breaks with severity and ageing | — |
| GET | `/api/v1/limits` | bearer | `200` — the refusal list, served live | — |

**A note on the statement endpoint, because it nearly went down as unverified.**
Against the business used for most of this audit, every closed day the index
offered answered `NO_STATEMENT_PUBLISHED` — `versions_published: 0` on all
sixteen. That is a state and not a failure (a day can close with nothing
published), but it also means the success path could not be reached from there,
and "the handler looks right" is not a measurement. It was reached instead
against a business that does hold published versions: `200`, with the stored
`content_hash` and the `recomputed_hash` equal and `reproduced: true` — recomputed
at request time against the open ledger, which is the distinction that matters,
because a reproduction claim made with nothing to reproduce from is the exact
defect this audit was commissioned over.

**Genuinely not reached**, and therefore claims of the code rather than
measurements: the whole `KYB_*` family (every business used here is approved),
`PAYEE_STANDING_CHECK_UNAVAILABLE`, `INVALID_CURSOR`, `POLICY_MISSING`,
`UNAVAILABLE` and `INTERNAL_ERROR`. Reaching the last three means breaking the
database on purpose under a live book, which was judged the wrong trade.

### Every refusal `POST /api/v1/payments` produced, measured

| sent | got |
| --- | --- |
| no `Idempotency-Key` | `400 IDEMPOTENCY_KEY_REQUIRED` |
| `"amount_cents": 100` as a JSON number | `400 INVALID_ARGUMENTS`, naming the double |
| `"rail": "internal"` | `400 INVALID_ARGUMENTS` — **see the finding below** |
| $100 on a token capped at $1 | `422 ABOVE_TOKEN_CEILING`, both figures in `details` |
| a warned payee nobody has signed for | `422 PAYEE_WARNING_UNACKNOWLEDGED`, carrying `/payees?payee=<id>&sign=1` |
| a clean payee, first time | `201`, `money_moved: false`, `state: requested` |
| the same key, byte-identical body | `200`, `replayed: true`, `idempotency-replayed: true`, **same instruction id** |
| the same key, a different amount | `409 IDEMPOTENCY_KEY_REUSED`, both content hashes in `details` |
| a seventh write inside one minute | `429 WRITE_RATE_LIMITED`, `retry_after_seconds: 3` |

The idempotency claim was checked against the table afterwards and not only
against the two response bodies: **one** `payment_instruction` row exists for
that key. The 409 wrote nothing.

### The scheduled routes

Every one of the five, by both `GET` and `POST`, with no credential, with a
forged `x-vercel-cron: 1`, and with a bearer that matches nothing — thirty
requests locally and ten against production. **All thirty-one distinct
combinations answered `401 UNAUTHORISED`.**

```
for p in /api/drain /api/cron/accrual /api/cron/holds /api/cron/outbound /api/cron/standing; do
  curl -s -o /dev/null -w "%{http_code} $p\n"                      https://corgi-trial-psi.vercel.app$p
  curl -s -o /dev/null -w "%{http_code} $p (forged)\n" -H 'x-vercel-cron: 1' https://corgi-trial-psi.vercel.app$p
done
```

Production answered `401` to all ten, and every response carried

```
x-stripped-request-headers: x-vercel-cron
```

which is `src/middleware.ts` proving from outside the deployment that the header
was deleted before any handler saw it. That is the one control on this list that
can be demonstrated by a stranger with curl.

`CRON_SECRET` is now set on the Vercel project (created four hours before the
check; the live production deployment is two hours old, so the running build
carries it). The **accepting** path in production is deliberately not
demonstrated: proving it means making a money-posting cron run on the real book
on demand, and `src/app/api/cron/_auth.test.ts` proves the same predicate
locally for nothing.

### Copy-pasteable, against the deployed URL

```bash
BASE=https://corgi-trial-psi.vercel.app
TOKEN=...                      # the grant issued for your business

# No anonymous read exists. This is the first thing to check.
curl -i  $BASE/api/v1

# The index, the accounts, one balance with its difference itemised.
curl -s  -H "authorization: Bearer $TOKEN" $BASE/api/v1
curl -s  -H "authorization: Bearer $TOKEN" $BASE/api/v1/accounts
curl -s  -H "authorization: Bearer $TOKEN" $BASE/api/v1/accounts/2100/balance
curl -s  -H "authorization: Bearer $TOKEN" "$BASE/api/v1/transactions?limit=5"
curl -s  -H "authorization: Bearer $TOKEN" $BASE/api/v1/payees
curl -s  -H "authorization: Bearer $TOKEN" $BASE/api/v1/statements
curl -s  -H "authorization: Bearer $TOKEN" "$BASE/api/v1/reconciliation/breaks?limit=5"
curl -s  -H "authorization: Bearer $TOKEN" $BASE/api/v1/limits

# A scope-widening parameter is REFUSED rather than ignored.
curl -s  -H "authorization: Bearer $TOKEN" "$BASE/api/v1/accounts?business_id=$(uuidgen)"

# The write. This queues a request for a human; it moves no money and cannot.
curl -i -X POST $BASE/api/v1/payments \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: INV-2026-0041' \
  -d '{"rail":"ach","amount_cents":"12500",
       "destination":{"type":"ach","holder_name":"Northwind Industrial LLC",
                      "routing_number":"011401533","account_number_last4":"7742",
                      "account_type":"checking"},
       "reason":"invoice 2026-0041"}'

# Send it a SECOND time, byte-identical: 200, replayed:true, the same id, no new row.
# Send it a THIRD time with a different amount_cents: 409 IDEMPOTENCY_KEY_REUSED.

# Every scheduled route, unauthenticated and with the forgeable platform header.
curl -i $BASE/api/drain
curl -i $BASE/api/drain -H 'x-vercel-cron: 1'     # note x-stripped-request-headers
```

### One finding this audit fixed, and one it only records

**Fixed.** `rail: "internal"` came back as
`Invalid option: expected one of "ach"|"usdc"|"wire"` — a message
indistinguishable from a typo, for a rail that is refused on purpose and for a
reason (its seeded policy is `threshold 0, required_approvals 0`, so an
instruction raised on it could be released with nobody having approved
anything). Both schemas — `src/lib/api/routes/payments.ts` for HTTP and
`src/lib/mcp/tool-initiate-payment.ts` for the agent surface — now carry that
sentence and point at A5, which already held the argument in prose.

**Recorded, not fixed.** `GET /api/v1/statements/{business_date}` has no
measured success path; see above.
