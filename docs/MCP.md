# The MCP surface

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP. It
speaks `initialize`, `tools/list` and `tools/call`, and it exposes four tools:

| Tool | Writes? | What it answers |
| --- | --- | --- |
| `get_balance` | no | Ledger balance and available balance, difference itemised into card-authorisation holds and uncleared credits, with an optional bitemporal as-of |
| `list_transactions` | no | Journal postings with `value_date` and `booking_date` as separate, separately filterable columns |
| `list_recon_breaks` | no | Open reconciliation breaks with category, reason code, age and severity |
| `initiate_payment` | **queues a request** | Writes one `payment_instruction` into the human approval queue. Moves no money, and cannot approve or release what it wrote |

The list of operations deliberately absent, with the failure mode for each, is
[AGENT-LIMITS.md](./AGENT-LIMITS.md).

---

## Configuring a token

The endpoint refuses every call without a bearer token, and refuses every call
if no tokens are configured. There is no development bypass.

Tokens live in `MCP_AGENT_TOKENS`, a JSON array. Each grant names one agent
actor and one business:

```json
[
  {
    "label": "ridgeline-ops-agent",
    "token": "corgi_mcp_demo_7f3a91c4e05b2d68a4c1",
    "actorId": "3743dc53-4e1c-577e-9a0f-e4469ffc1761",
    "businessId": "e274546d-6bdd-5266-b0fb-cc839a7811f9",
    "rateLimitPerMinute": 60,
    "maxInstructionCents": "5000000"
  }
]
```

| Field | Meaning |
| --- | --- |
| `label` | Non-secret name. Appears in every audit line. |
| `token` | The secret. Use `tokenSha256` instead — a lowercase hex digest — to keep the secret out of the environment. Exactly one of the two. |
| `actorId` | Must resolve to an `actor` row with `kind = 'agent'`. A token pointed at a human or a system principal is refused with 403, checked against the live table on every cache miss. |
| `businessId` | The tenant this token can see. Nothing else. |
| `rateLimitPerMinute` | Optional, default 60. Writes carry a separate, much smaller budget of 6/minute. |
| `maxInstructionCents` | Optional. Ceiling on a single queued payment, as a decimal string of cents. |

Set it alongside the rest of the environment and start the server:

```bash
set -a; . ./.env; set +a
export MCP_AGENT_TOKENS='[{"label":"ridgeline-ops-agent","token":"corgi_mcp_demo_7f3a91c4e05b2d68a4c1","actorId":"3743dc53-4e1c-577e-9a0f-e4469ffc1761","businessId":"e274546d-6bdd-5266-b0fb-cc839a7811f9","rateLimitPerMinute":60,"maxInstructionCents":"5000000"}]'
pnpm build && pnpm start --port 3117
```

Two grants pointing at the same secret are both dropped, with a warning: which
business a call resolves to must never depend on array order.

## Connecting a client

**Anything that speaks Streamable HTTP** connects directly to the URL with an
`Authorization` header. For Claude Desktop, which speaks stdio, bridge with
`mcp-remote`:

```json
{
  "mcpServers": {
    "corgi": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-deployment.example/api/mcp",
        "--header", "Authorization: Bearer corgi_mcp_demo_7f3a91c4e05b2d68a4c1"
      ]
    }
  }
}
```

**curl** is enough to exercise the whole surface, and is what produced the
transcript below.

### Shape of the transport

- One JSON-RPC message per POST; one JSON body back. No SSE stream and no
  session id, because this server never initiates a message to the client. `GET`
  answers 405 with an explanation rather than an empty status line.
- JSON-RPC **batching is refused** — MCP removed it in revision 2025-06-18, and
  supporting it would mean deciding what a half-throttled batch means for the
  audit log.
- Protocol versions accepted: `2025-06-18` (default), `2025-03-26`,
  `2024-11-05`. A client asking for a version we do not know gets our latest
  rather than a refusal. An `MCP-Protocol-Version` header naming an unsupported
  revision is a 400.
- An `Origin` header, when present, must be same-origin or loopback.
- Status codes: transport-level refusals use HTTP (401 no/unknown token, 403
  wrong actor kind or bad origin, 413 oversized body, 429 throttled, 400
  unparseable). Everything else is HTTP 200 with either a JSON-RPC `error` (the
  call never ran) or a `result` carrying `isError: true` (the call ran and was
  refused).

---

# A real transcript

Captured from `pnpm start` on port 3117 against the live Neon branch on
2026-09-10 at ~15:02 UTC, seeded with `scripts/seed.mjs` plus the reconciliation
demo data. Request and response bodies are verbatim; long payloads are trimmed
where the omission is marked, and every id is a real id you can look up in the
database.

One honest note about the figures: other workers were exercising the same branch
while this was captured, so the balances and break counts are a snapshot of that
minute rather than fixtures. Re-running these calls will produce different
numbers and the same shapes.

## 0. No token — refused before anything is dispatched

```console
$ curl -s -i -X POST http://127.0.0.1:3117/api/mcp \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":0,"method":"tools/list"}'
```

```http
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
mcp-protocol-version: 2025-06-18
www-authenticate: Bearer realm="corgi-mcp", error="invalid_token"
x-request-id: req_53bd5eeafb7e414fb15d71d94ca853cb
```

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "error": {
    "code": -32001,
    "message": "this endpoint requires a bearer token: send Authorization: Bearer <token>. See docs/MCP.md.",
    "data": { "reason": "no_token" }
  }
}
```

`tools/list` is not public either. Nothing on this endpoint is.

## 1. `initialize`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "curl", "version": "8.x" }
  }
}
```

**HTTP 200**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": {
      "name": "corgi-neobank",
      "title": "Corgi Neobank",
      "version": "0.1.0"
    },
    "instructions": "Corgi neobank, agent surface.\n\nYour token is scoped to exactly one business. Every tool answers only about\nthat business's money; there is no parameter that widens the scope, and no\naccount belonging to anyone else is addressable.\n\nThree tools read: get_balance, list_transactions, list_recon_breaks.\n\nOne tool writes, and it does not move money: initiate_payment queues a request\nin a human approval queue. When it succeeds, NOTHING HAS BEEN PAID. Say so\nplainly to whoever you are relaying to — \"queued for approval\", never \"sent\",\n\"paid\" or \"initiated\". You cannot approve, release, submit or cancel a payment\nthrough this surface; those operations are not exposed to any agent. See\ndocs/AGENT-LIMITS.md for the full list and the reasoning.\n\nTwo dates, always. value_date is when money moved in business terms;\nbooking_date is when this system learned of it. They differ on every correction\nand every late settlement, and answering with the wrong one is the most common\nway to be confidently wrong about a customer's account.\n\nLedger balance is not available balance. Available subtracts open card\nauthorisation holds and uncleared credits. Quote available when the question is\n\"can I spend it\" and ledger when the question is \"what do the books say\".\n\nAll amounts are integer CENTS as decimal strings, in and out."
  }
}
```

The `notifications/initialized` that follows carries no id and gets **HTTP 202**
with an empty body — and an audit line, because "the client said hello" is worth
having next to the calls that followed.

## 2. `tools/list`

Four tools. Full schemas elided here for length; the annotations are the part
worth reading, because they are what a client uses to decide whether to run a
tool without asking its human.

```
get_balance        {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_transactions  {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_recon_breaks  {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
initiate_payment   {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
```

`initiate_payment` is `readOnlyHint: false` because it writes a row, and
`destructiveHint: false` because nothing is overwritten, nothing is spent, and
the row is append-only.

## 3. `get_balance` — a successful read

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "get_balance", "arguments": {} }
}
```

**HTTP 200**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Ridgeline Robotics, Inc., account 2100 (Ridgeline Robotics, Inc. — business current account), as of now: ledger balance $30,576.93, available $30,576.93. Nothing is encumbered, so the two agree."
      }
    ],
    "structuredContent": {
      "business": {
        "id": "e274546d-6bdd-5266-b0fb-cc839a7811f9",
        "legal_name": "Ridgeline Robotics, Inc."
      },
      "account": {
        "code": "2100",
        "name": "Ridgeline Robotics, Inc. — business current account",
        "currency": "USD",
        "book": "financial"
      },
      "as_of": {
        "value_date": "all",
        "basis": "current",
        "booking_time": null,
        "booking_watermark": null
      },
      "ledger_balance": { "cents": "3057693", "display": "$30,576.93" },
      "available_balance": { "cents": "3057693", "display": "$30,576.93" },
      "difference": {
        "total": { "cents": "0", "display": "$0.00" },
        "items": [
          {
            "kind": "card_auth_holds",
            "count": 0,
            "amount": { "cents": "0", "display": "$0.00" },
            "explanation": "Card authorisations that are still open. The merchant has the customer's promise; the money has not left the ledger and cannot be spent twice."
          },
          {
            "kind": "uncleared_credits",
            "count": 0,
            "amount": { "cents": "0", "display": "$0.00" },
            "explanation": "Inbound credits booked but not yet released under the funds-availability policy. An ACH credit is returnable for days after it lands."
          }
        ]
      },
      "formula": "available = ledger - open card authorisation holds - uncleared credits. Every term is a SUM over immutable journal lines at query time; no balance is stored anywhere in this schema."
    },
    "isError": false
  }
}
```

Nothing was encumbered at this moment, so the two figures agree — and the tool
says so in words rather than leaving a reader to compare two numbers. Every
amount is a decimal string of cents; there is no JSON number anywhere in the
money path, because a double stops representing consecutive integers above 2^53
and does it silently.

## 4. `get_balance` with both time axes

The same account, asked as we believed it seventeen minutes earlier:

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "tools/call",
  "params": {
    "name": "get_balance",
    "arguments": {
      "as_of_value_date": "2026-09-10",
      "as_of_booking_time": "2026-09-10T14:30:00Z"
    }
  }
}
```

```json
{
  "as_of": {
    "value_date": "2026-09-10",
    "basis": "as_believed",
    "booking_time": "2026-09-10T14:30:00Z",
    "booking_watermark": "5"
  },
  "ledger_balance": { "cents": "18660", "display": "$186.60" },
  "available_balance": { "cents": "18660", "display": "$186.60" }
}
```

> Ridgeline Robotics, Inc., account 2100 …, for value date 2026-09-10, as
> believed at 2026-09-10T14:30:00Z (booking_seq <= 5): ledger balance $186.60,
> available $186.60.

$186.60 at 14:30, $9,460.34 now. Neither answer overwrote the other, nothing was
edited, and the watermark that produced the first is returned so the caller can
reproduce it. `as_of_value_date` moves along valid time; `as_of_booking_time`
moves along transaction time; they are independent, and the `basis` field names
which cut was applied.

## 5. `list_transactions` — the two dates, separately

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": { "name": "list_transactions", "arguments": { "limit": 3 } }
}
```

**HTTP 200** (two of the three postings shown)

```json
{
  "content": [
    {
      "type": "text",
      "text": "3 posting(s) for Ridgeline Robotics, Inc., of which 3 were booked after their value date (corrections or late settlements). More pages are available; pass next_cursor."
    }
  ],
  "structuredContent": {
    "transactions": [
      {
        "entry_id": "0334f310-ed0e-4e54-b346-3b524ab0d54c",
        "account_code": "2100",
        "account_name": "Ridgeline Robotics, Inc. — business current account",
        "value_date": "2005-03-18",
        "booking_date": "2026-09-10",
        "booking_time": "2026-09-10T15:02:11.202Z",
        "booking_seq": "132",
        "entry_type": "rebook",
        "book": "financial",
        "amount": { "cents": "13456", "display": "$134.56" },
        "currency": "USD",
        "description": "Planted settlement PLANT-MTVNOGQ7-2, re-booked",
        "memo": null,
        "rail": "ach",
        "external_ref": "PLANT-MTVNOGQ7-2",
        "reverses_entry_id": null,
        "correction_group_id": "ae72f682-9313-4046-9cbc-054dcacd9c99",
        "backdated_by_days": 7846
      },
      {
        "entry_id": "15ec1bfe-3524-43ef-87f7-d08189e5c4e9",
        "account_code": "2100",
        "account_name": "Ridgeline Robotics, Inc. — business current account",
        "value_date": "2005-03-18",
        "booking_date": "2026-09-10",
        "booking_time": "2026-09-10T15:02:11.134Z",
        "booking_seq": "131",
        "entry_type": "reversal",
        "book": "financial",
        "amount": { "cents": "-12222", "display": "-$122.22" },
        "currency": "USD",
        "description": "Reversal of ae72f682-9313-4046-9cbc-054dcacd9c99: settled amount taken from the wrong field on the provider payload",
        "memo": null,
        "rail": "ach",
        "external_ref": "PLANT-MTVNOGQ7-2",
        "reverses_entry_id": "ae72f682-9313-4046-9cbc-054dcacd9c99",
        "correction_group_id": "ae72f682-9313-4046-9cbc-054dcacd9c99",
        "backdated_by_days": 7846
      }
    ],
    "next_cursor": "130",
    "note": "value_date is when the money moved in business terms; booking_date is when this system learned of it. They differ on every correction and on every late-arriving settlement. Amounts are signed from the account's point of view: positive is money in."
  }
}
```

A reversal and its rebook, sharing a `correction_group_id`, both carrying the
original's `value_date` and today's `booking_date` — `backdated_by_days: 7846`,
because the reconciliation demo plants its settlements at absurd historical
dates on purpose. Amounts are signed from the account's point of view: the
reversal of a credit shows as `-$122.22`, because handing an agent a raw
debit-positive journal line is how a customer gets told their deposit was a
debit.

## 6. `list_recon_breaks`

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": { "name": "list_recon_breaks", "arguments": { "limit": 3 } }
}
```

**HTTP 200** (one break shown; the summary is over all three)

```json
{
  "content": [
    {
      "type": "text",
      "text": "3 open break(s) for Ridgeline Robotics, Inc., $13,111.66 out in total: 3 booked but absent from the settlement file, 0 matched with an amount disagreement, 0 in the file with no entry. Oldest is 8899 day(s), and 3 have survived two or more book-day closes. 5 further unmatched file row(s) cannot be attributed to a business."
    }
  ],
  "structuredContent": {
    "as_of_book_date": "2026-09-10",
    "open_breaks": [
      {
        "category": "in_ledger_not_file",
        "category_meaning": "We booked it and the provider's file omits it. A duplicate posting, a timing difference across the file cutoff, or a row that vanished between two versions of the file.",
        "reason_code": "unmatched_reference",
        "reason": "No counterpart under this reference",
        "severity": "critical",
        "age_days": 45,
        "age_bucket": "31+",
        "break_key": "d05aeb7e-c1cc-4f42-977a-b8866b74243a",
        "external_ref": "ACH-LEDGER-ONLY-20260727",
        "value_date": "2026-07-27",
        "rail": "ach",
        "provider": "achsim",
        "entry_id": "d05aeb7e-c1cc-4f42-977a-b8866b74243a",
        "ledger_amount": { "cents": "1284500", "display": "$12,845.00" },
        "file_amount": null,
        "break_amount": { "cents": "1284500", "display": "$12,845.00" },
        "description": "ACH settlement notified by webhook, absent from the ODFI file",
        "explained_by": null
      }
    ],
    "counts_by_category": { "in_ledger_not_file": 3, "amount_mismatch": 0, "in_file_not_ledger": 0 },
    "counts_by_severity": { "critical": 3 },
    "oldest_age_days": 8899,
    "total_break_amount": { "cents": "1311166", "display": "$13,111.66" },
    "unattributable_open_breaks": 5,
    "note": "Categories, reason codes, age buckets and severities come from the reconciliation engine's own view (v_recon_break) and aging rules, not from a second calculation here. Severity is about day closes, not about money: aged means somebody signed off a book day with this break open. This tool reads breaks and cannot adjudicate, resolve or adjust one — that needs a human and a correcting entry."
  }
}
```

Note `unattributable_open_breaks: 5`. Those are `in_file_not_ledger` breaks: a
settlement-file row with no journal entry has no account, so it has no owner, and
attributing it to a tenant would mean guessing. They are counted rather than
listed, so an agent is never told "no breaks" when the truth is "none of yours".

## 7. `initiate_payment` — lands in the queue, moves nothing

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "initiate_payment",
    "arguments": {
      "rail": "ach",
      "amount_cents": "420000",
      "destination": {
        "type": "ach",
        "holder_name": "Northwind Components LLC",
        "routing_number": "021000021",
        "account_number_last4": "6789",
        "account_type": "checking"
      },
      "reason": "Invoice NWC-2026-0512, September machining run, 30-day terms, due today",
      "idempotency_key": "invoice-NWC-2026-0512"
    }
  }
}
```

**HTTP 200**

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "NO MONEY HAS MOVED. A payment instruction for $4,200.00 by ach to Northwind Components LLC (ACH 021000021 ••6789) dated 2026-09-10 is sitting in the approval queue as instruction 02265193-7f3f-4efe-bff0-3442bcb0eaa4, state \"requested\". It debits Ridgeline Robotics, Inc. — business current account only if and when a human releases it. It needs 1 human approval(s) from someone other than the requester; it holds 0. This agent cannot approve it: the actor table forbids a non-human approver and the maker-checker trigger refuses the initiator."
      }
    ],
    "structuredContent": {
      "status": "queued_for_human_approval",
      "money_moved": false,
      "instruction_id": "02265193-7f3f-4efe-bff0-3442bcb0eaa4",
      "replayed": false,
      "state": "requested",
      "content_hash": "e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb",
      "requested_at": "2026-09-10T14:52:01.996Z",
      "requested_by": {
        "actor_id": "3743dc53-4e1c-577e-9a0f-e4469ffc1761",
        "kind": "agent",
        "can_approve": false
      },
      "business": {
        "id": "e274546d-6bdd-5266-b0fb-cc839a7811f9",
        "legal_name": "Ridgeline Robotics, Inc."
      },
      "debit_account": {
        "code": "2100",
        "name": "Ridgeline Robotics, Inc. — business current account"
      },
      "amount": { "cents": "420000", "display": "$4,200.00" },
      "rail": "ach",
      "value_date": "2026-09-10",
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
          "actor.actor_only_humans_approve — CHECK (NOT (kind <> 'human' AND can_approve)): an agent that can approve is not a storable row",
          "assert_maker_checker() — refuses an 'approved' event whose actor is not a human approver",
          "assert_maker_checker() — refuses an 'approved' event whose actor is the initiator",
          "assert_maker_checker() — refuses an 'approved' event citing a different content_hash",
          "payment_instruction_event.pie_one_decision_per_actor — one actor cannot approve twice to satisfy a two-approver rule"
        ]
      },
      "funds_check": {
        "available_before": { "cents": "946034", "display": "$9,460.34" },
        "binding": false,
        "note": "Checked when this instruction was queued, not when it will be released. The balance at release is what actually governs."
      },
      "what_happens_next": "A human approver who is not the initiator must approve this instruction once before it can be released. The agent that requested it cannot be one of them."
    },
    "isError": false
  }
}
```

The prose leads with `NO MONEY HAS MOVED` because the caller is usually a model
relaying to a person, and "payment initiated" is a sentence that gets repeated as
"your payment has been sent".

### What that actually wrote

Queried directly, as the restricted `corgi_app` role:

```
id               | 02265193-7f3f-4efe-bff0-3442bcb0eaa4
amount_cents     | 420000
requested_by     | Corgi payments agent  (kind = agent)
idempotency_key  | mcp:e274546d-…-cc839a7811f9:3743dc53-…-e4469ffc1761:invoice-NWC-2026-0512
content_hash     | e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb
events           | requested
journal_entries  | 0
```

One instruction, one `requested` event, **zero journal entries**. The
idempotency key is namespaced by tenant and agent, so one token's key can never
collide with — or be used to probe for — another's instruction.

### And the agent cannot approve it

Going around the application entirely, connecting to Postgres directly and
inserting the approval as the agent, citing the correct content hash:

```sql
INSERT INTO payment_instruction_event
  (instruction_id, kind, actor_id, approved_content_hash, value_date)
VALUES
  ('02265193-7f3f-4efe-bff0-3442bcb0eaa4', 'approved',
   '3743dc53-4e1c-577e-9a0f-e4469ffc1761',
   decode('e423ad6e…da1af3eb','hex'), CURRENT_DATE);
```

```
SQLSTATE 42501
actor 3743dc53-4e1c-577e-9a0f-e4469ffc1761 (kind agent) is not an approver
```

No TypeScript was in the way. `src/lib/mcp/mcp.integration.test.ts` runs this
same attempt against the live database on every `RUN_DB_TESTS=1` run.

## 8. Replaying an idempotency key

The same call again, unchanged:

```json
{
  "status": "queued_for_human_approval",
  "money_moved": false,
  "instruction_id": "13551a7b-f4a4-4895-ba5a-9db16eab3086",
  "replayed": true,
  "content_hash": "e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb"
}
```

> NO MONEY HAS MOVED. This idempotency key was already queued, so nothing new was
> written; a payment instruction for $4,200.00 …

Same instruction id, `replayed: true`, no second row. An agent retrying after a
socket timeout cannot queue the payment twice — the unique index decides, not an
`if`.

## 9. Refusals

**A house account is not addressable from a tenant token.** `1110` is the FBO
settlement account: every customer's money, pooled.

```json
{
  "jsonrpc": "2.0", "id": 9,
  "result": {
    "content": [{ "type": "text", "text": "ACCOUNT_NOT_FOUND: Ridgeline Robotics, Inc. has no open account with code 1110" }],
    "structuredContent": {
      "error": "ACCOUNT_NOT_FOUND",
      "message": "Ridgeline Robotics, Inc. has no open account with code 1110",
      "details": { "account_code": "1110", "business": "Ridgeline Robotics, Inc." }
    },
    "isError": true
  }
}
```

A business refusal, not a protocol error: the model reads the reason and can ask
a better question.

**There is no approval tool.**

```json
{
  "jsonrpc": "2.0", "id": 10,
  "error": {
    "code": -32602,
    "message": "unknown tool \"approve_payment\"",
    "data": { "available": ["get_balance", "list_transactions", "list_recon_breaks", "initiate_payment"] }
  }
}
```

**And no argument widens the tenant scope.**

```json
{
  "jsonrpc": "2.0", "id": 11,
  "error": {
    "code": -32602,
    "message": "invalid arguments: (root) — Unrecognized key: \"business_id\"",
    "data": { "problems": [{ "field": "(root)", "problem": "Unrecognized key: \"business_id\"" }] }
  }
}
```

Refused rather than ignored, deliberately. A model that hallucinates a parameter
and is silently served its own tenant's data will believe the parameter worked,
and the next call it writes is the dangerous one.

**A different token sees a different bank.** The identical call — `get_balance`
with no arguments — under a token scoped to Kettle & Crumb:

```json
{
  "jsonrpc": "2.0", "id": 12,
  "result": {
    "content": [{ "type": "text", "text": "ACCOUNT_NOT_FOUND: Kettle & Crumb Bakery LLC has no open account with code 2100" }],
    "structuredContent": {
      "error": "ACCOUNT_NOT_FOUND",
      "message": "Kettle & Crumb Bakery LLC has no open account with code 2100",
      "details": { "account_code": "2100", "business": "Kettle & Crumb Bakery LLC" }
    },
    "isError": true
  }
}
```

Ridgeline's `2100` exists and is a foot away in the same table. From this token
it does not exist, because the chart code is resolved inside the grant's
business and there is no argument that could carry it across.

## 10. The audit log

Every call above produced exactly one line, including the ones that were
refused. Verbatim from stdout, reformatted for width:

```json
{"event":"mcp.audit","requestId":"req_46eaf972958f4f218047c8231200cadd","method":"tools/call",
 "tool":"initiate_payment","outcome":"ok","errorCode":null,
 "actorId":"3743dc53-4e1c-577e-9a0f-e4469ffc1761",
 "businessId":"e274546d-6bdd-5266-b0fb-cc839a7811f9",
 "grantLabel":"ridgeline-ops-agent","grantFingerprint":"7b5c37ab","clientKey":"::ffff:127.0.0.1",
 "argumentsRedacted":{"rail":"ach","amount_cents":"420000",
   "destination":{"type":"ach","holder_name":"Northwind Components LLC",
     "routing_number":"021000021","account_number_last4":"6789","account_type":"checking"},
   "reason":"Invoice NWC-2026-0512, September machining run, 30-day terms, due today",
   "idempotency_key":"invoice-NWC-2026-0512"},
 "durationMs":2253,
 "result":{"instruction_id":"02265193-7f3f-4efe-bff0-3442bcb0eaa4","replayed":false,
   "content_hash":"e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb",
   "money_moved":false}}

{"event":"mcp.audit","tool":"get_balance","outcome":"tool_error","errorCode":"ACCOUNT_NOT_FOUND",
 "actorId":"3743dc53-…","businessId":"e274546d-…","grantLabel":"ridgeline-ops-agent",
 "argumentsRedacted":{"account_code":"1110"},"durationMs":71,"result":null}

{"event":"mcp.audit","tool":"approve_payment","outcome":"protocol_error","errorCode":"UNKNOWN_TOOL",
 "actorId":"3743dc53-…","grantLabel":"ridgeline-ops-agent",
 "argumentsRedacted":{"instruction_id":"fb9fa201-531f-4ade-b6af-f826620b45c7"},"durationMs":1}

{"event":"mcp.audit","tool":"get_balance","outcome":"protocol_error","errorCode":"INVALID_ARGUMENTS",
 "actorId":"3743dc53-…","grantLabel":"ridgeline-ops-agent",
 "argumentsRedacted":{"business_id":"1151e7b5-b75b-5f58-bdbf-68cd714178ce"},"durationMs":1}

{"event":"mcp.audit","tool":"get_balance","outcome":"tool_error","errorCode":"ACCOUNT_NOT_FOUND",
 "actorId":"3743dc53-…","businessId":"1151e7b5-b75b-5f58-bdbf-68cd714178ce",
 "grantLabel":"kettle-ops-agent","grantFingerprint":"6daedd00",
 "argumentsRedacted":{},"durationMs":130}

{"event":"mcp.audit","tool":"get_balance","outcome":"ok",
 "actorId":"3743dc53-…","businessId":"e274546d-…","grantLabel":"ridgeline-ops-agent",
 "argumentsRedacted":{"as_of_value_date":"2026-09-10","as_of_booking_time":"2026-09-10T14:30:00Z"},
 "durationMs":614,"result":{"basis":"as_believed"}}
```

Points worth making about that log:

- **The attempt is recorded, not just the success.** `approve_payment` does not
  exist, and the fact that something asked for it is in the log with the
  arguments it tried.
- **`grantFingerprint`, not `tokenFingerprint`.** `@/lib/log` redacts any field
  whose name contains "token"; this value is four bytes of a sha256 and is
  deliberately non-secret, because it is what distinguishes two tokens sharing a
  label during an investigation. A field that is always `[redacted]` is a field
  that is not in the audit log.
- **Arguments are redacted before they are written.** The routing number
  survives — it is published by the Fed and is what identifies the receiving
  institution — and anything matching a secret or a full account number does
  not. There is no full account number to redact here in the first place: the
  destination schema only accepts `account_number_last4`.
- **Where it lands.** One JSON line per call through `@/lib/log`, the same drain
  the rest of the system writes to. A durable `mcp_audit` table is a
  `teeAuditSink` away and its DDL is at the bottom of `src/lib/mcp/audit.ts`; it
  is not added here because migrations are owned by another worker in this
  build. The write tool's trail is already durable and immutable regardless —
  `payment_instruction` and its `requested` event record the agent's actor id,
  the amount, the destination, the value date and the content hash, on tables
  `corgi_app` holds no `UPDATE` or `DELETE` on.

---

## Rate limits

Two budgets, because a read and a write cost different things.

- **Reads and everything else:** the grant's `rateLimitPerMinute`, default 60. A
  token bucket, so the burst is exactly the capacity and never twice it the way
  a fixed window allows.
- **Writes:** 6 per minute per token, regardless of the read budget. Sixty reads
  a minute is a busy agent; sixty queued payments a minute is a denial-of-service
  attack on the approver, and the approver is the control this whole design
  rests on.
- **Failed authentications:** 20 per minute per client address, spent only on
  failure, so a well-behaved client is never throttled by a noisy neighbour
  behind the same proxy.

A throttled call is HTTP 429 with `Retry-After` and JSON-RPC code `-32029`.

The buckets are per process. On a platform running several warm instances the
effective limit is (instances × limit) — a real gap, written down rather than
implied away in `src/lib/mcp/ratelimit.ts`, and discussed in
[AGENT-LIMITS.md](./AGENT-LIMITS.md#where-the-line-is-genuinely-debatable).

## Error codes

| Code | Meaning | HTTP |
| --- | --- | --- |
| `-32700` | Body is not valid JSON | 400 |
| `-32600` | Not a JSON-RPC 2.0 request; batching; oversized body | 400 / 413 |
| `-32601` | Unknown method, or a capability this server does not declare | 200 |
| `-32602` | Unknown tool, or arguments that do not validate — the tool never ran | 200 |
| `-32603` | Internal error | 500 |
| `-32001` | No token, or a token that does not resolve | 401 |
| `-32002` | Refused before dispatch (bad `Origin`) | 403 |
| `-32003` | Token resolves, but not to an agent actor | 403 |
| `-32029` | Rate limited | 429 |

A tool that ran and refused is **not** in this table: it is HTTP 200, a JSON-RPC
`result`, and `isError: true` with a machine-readable code in
`structuredContent.error` (`ACCOUNT_NOT_FOUND`, `INSUFFICIENT_AVAILABLE_FUNDS`,
`ABOVE_TOKEN_CEILING`, `VALUE_DATE_IN_THE_PAST`, `POLICY_MISSING`, …).

## Running the tests

```bash
pnpm test                                   # protocol, auth, scoping, tools — no database needed
set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test   # adds the live-database suite
```

The live suite (`src/lib/mcp/mcp.integration.test.ts`) proves the SQL runs
against this schema, that the tenant predicate holds on real rows, and that the
agent cannot approve its own instruction. It writes real `payment_instruction`
rows, which stay: the table is append-only and those rows are the evidence.
