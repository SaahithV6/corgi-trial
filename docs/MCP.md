# The MCP surface

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP. It
speaks `initialize`, `tools/list` and `tools/call`, and it exposes eight tools —
seven that read and one that writes:

| Tool | Writes? | What it answers |
| --- | --- | --- |
| `get_balance` | no | Ledger balance and available balance on the main deposit account, difference itemised into card-authorisation holds and uncleared credits, with an optional bitemporal as-of |
| `list_pots` | no | Money earmarked in pots, the main balance beside it, and the identity check that proves the set is complete |
| `list_transactions` | no | Journal postings with `value_date` and `booking_date` as separate, separately filterable columns |
| `list_payees` | no | The payee book: each saved destination's verification outcome, freshness, name-match result and findings |
| `list_standing_orders` | no | Mandates, their next due date, and their occurrences — including refused ones, with the code and the four figures the funding decision was made against |
| `list_card_controls` | no | Card limits, blocks and state, plus the real-time authorisation decisions with the rule that fired |
| `list_recon_breaks` | no | Open reconciliation breaks with category, reason code, age and severity |
| `initiate_payment` | **queues a request** | Writes one `payment_instruction` into the human approval queue. Moves no money, and cannot approve or release what it wrote |

Four of those readers were added after the first cut of this surface, when
pots, the payee book, standing orders and card controls shipped. Each one was
added for the same reason, and it is not "the feature exists": without it the
agent was **confidently wrong** rather than merely unhelpful.

| Without it, the agent would say | Because |
| --- | --- |
| "you have $23,713.13" when the business has $38,713.13 | `get_balance` reads chart code `2100`; a pot is a separate account beneath it |
| "I've drafted a payment to the account on the invoice" | nothing let it check that destination against the book first |
| "I see no record of that payment" | a scheduled payment that was refused is an occurrence row, not a journal row |
| "the bank declined your card" | a declined authorisation never reaches the ledger; the decision log is the only record |

**The number of tools that write is still one.** That is the shape of this
surface: reads grew, writes did not, and the argument for refusing the obvious
new writes — a standing-order mandate, a payee, a card control, an
acknowledgement — is in [AGENT-LIMITS.md](./AGENT-LIMITS.md) §10-§13 alongside
everything else deliberately absent.

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

Eight tools. Full schemas elided here for length; the annotations are the part
worth reading, because they are what a client uses to decide whether to run a
tool without asking its human.

```
get_balance           {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_pots             {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_transactions     {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_payees           {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_standing_orders  {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_card_controls    {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
list_recon_breaks     {"readOnlyHint": true,  "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
initiate_payment      {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
```

`openWorldHint: false` on every one of them is a claim worth checking rather
than taking: no tool here reaches a third party. `list_card_controls` returns
Lithic's authorisation decisions, but it reads them from `card_auth_decision`,
our own table, written when the decision was made. Nothing on this surface calls
a provider, so nothing on it can be slow or wrong because a provider is.

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

The same account, asked as we believed it half an hour earlier:

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

$186.60 as believed at 14:30, $30,576.93 now — the reconciliation demo booked a
great many settlements in between. Neither answer overwrote the other, nothing
was edited, and the watermark that produced the first is returned so the caller
can reproduce it exactly. `as_of_value_date` moves along valid time;
`as_of_booking_time` moves along transaction time; they are independent, and the
`basis` field names which cut was applied — `current`, `as_of_value_date` or
`as_believed` — so a caller is never guessing which question it asked.

This is the published live-fire question, exposed as two tool arguments: show
Tuesday's statement now, and prove what you believed on Wednesday.

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

**HTTP 200** (one of the three breaks shown; the summary is over all three)

```json
{
  "content": [
    {
      "type": "text",
      "text": "3 open break(s) for Ridgeline Robotics, Inc., $399.99 out in total: 3 booked but absent from the settlement file, 0 matched with an amount disagreement, 0 in the file with no entry. Oldest is 8998 day(s), and 3 have survived two or more book-day closes. 20 further unmatched file row(s) cannot be attributed to a business."
    }
  ],
  "structuredContent": {
    "business": {
      "id": "e274546d-6bdd-5266-b0fb-cc839a7811f9",
      "legal_name": "Ridgeline Robotics, Inc."
    },
    "as_of_book_date": "2026-09-10",
    "open_breaks": [
      {
        "category": "in_ledger_not_file",
        "category_meaning": "We booked it and the provider's file omits it. A duplicate posting, a timing difference across the file cutoff, or a row that vanished between two versions of the file.",
        "reason_code": "unmatched_reference",
        "reason": "No counterpart under this reference",
        "severity": "critical",
        "age_days": 8998,
        "age_bucket": "31+",
        "break_key": "0c9c3234-7e1f-415f-a029-76c18265bf23",
        "external_ref": "PLANT-MTVNMTYV-3",
        "value_date": "2002-01-21",
        "rail": "ach",
        "provider": "achsim",
        "entry_id": "0c9c3234-7e1f-415f-a029-76c18265bf23",
        "ledger_amount": { "cents": "13333", "display": "$133.33" },
        "file_amount": null,
        "break_amount": { "cents": "13333", "display": "$133.33" },
        "description": "Planted settlement PLANT-MTVNMTYV-3",
        "explained_by": null
      }
    ],
    "counts_by_category": { "in_ledger_not_file": 3, "amount_mismatch": 0, "in_file_not_ledger": 0 },
    "counts_by_severity": { "critical": 3 },
    "oldest_age_days": 8998,
    "total_break_amount": { "cents": "39999", "display": "$399.99" },
    "unattributable_open_breaks": 20,
    "note": "Categories, reason codes, age buckets and severities come from the reconciliation engine's own view (v_recon_break) and aging rules, not from a second calculation here. Severity is about day closes, not about money: aged means somebody signed off a book day with this break open. This tool reads breaks and cannot adjudicate, resolve or adjust one — that needs a human and a correcting entry."
  }
}
```

Two things worth pointing at.

**The diff is not re-implemented here.** The categories come from
`v_recon_break`, and the age bucket and severity from `recon/aging.ts`, via that
module's own `toReconBreak`. What this surface adds is one predicate — the
tenant filter — pushed into the `WHERE` clause rather than applied in TypeScript
after the fetch, which is both the faster plan (185ms scoped versus 708ms for the
whole view, measured on this branch) and the safer one: there is no moment at
which this process holds another business's break in memory.

**`unattributable_open_breaks: 20`.** Those are `in_file_not_ledger` breaks. A
settlement-file row with no journal entry has no account, so it has no owner, and
attributing it to a tenant would mean guessing. They are counted rather than
listed, so an agent is never told "no breaks" when the truth is "none of yours,
and twenty nobody owns" — which is the answer that would let it reassure a
customer that the books tie out.

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
      "reason": "Invoice NWC-2026-0603, September machining run, 30-day terms, due today",
      "idempotency_key": "invoice-NWC-2026-0603"
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
        "text": "NO MONEY HAS MOVED. A payment instruction for $4,200.00 by ach to Northwind Components LLC (ACH 021000021 ••6789) dated 2026-09-10 is sitting in the approval queue as instruction 7f9187c9-0156-4792-bacd-6d64c2d2b2f2, state \"requested\". It debits Ridgeline Robotics, Inc. — business current account only if and when a human releases it. It needs 1 human approval(s) from someone other than the requester; it holds 0. This agent cannot approve it: the actor table forbids a non-human approver and the maker-checker trigger refuses the initiator."
      }
    ],
    "structuredContent": {
      "status": "queued_for_human_approval",
      "money_moved": false,
      "instruction_id": "7f9187c9-0156-4792-bacd-6d64c2d2b2f2",
      "replayed": false,
      "state": "requested",
      "content_hash": "e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb",
      "requested_at": "2026-09-10T15:02:29.021Z",
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
        "available_before": { "cents": "3125592", "display": "$31,255.92" },
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
"your payment has been sent". `state` is folded from the event stream by
`approvals/state.ts` rather than read off a status column, and `approvals_held`
is counted the way the trigger counts them, so the screen and the agent cannot
disagree about whether this is releasable.

### What that actually wrote

Queried directly, as the restricted `corgi_app` role:

```
id               | 7f9187c9-0156-4792-bacd-6d64c2d2b2f2
amount_cents     | 420000
requested_by     | Corgi payments agent (kind = agent)
idempotency_key  | mcp:e274546d-6bdd-5266-b0fb-cc839a7811f9:3743dc53-4e1c-577e-9a0f-e4469ffc1761:invoice-NWC-2026-0603
content_hash     | e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb
events           | requested
journal_entries  | 0
```

One instruction, one `requested` event, **zero journal entries**. The
idempotency key is namespaced by tenant and agent, so one token's key can never
collide with — or be used to probe for — another's instruction.

### And the agent cannot approve it

Going around the application entirely: connect to Postgres directly and insert
the approval as the agent, citing the correct content hash.

```sql
INSERT INTO payment_instruction_event
  (instruction_id, kind, actor_id, approved_content_hash, value_date)
VALUES
  ('7f9187c9-0156-4792-bacd-6d64c2d2b2f2', 'approved',
   '3743dc53-4e1c-577e-9a0f-e4469ffc1761',
   decode('e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb','hex'),
   CURRENT_DATE);
```

```
SQLSTATE 42501
actor 3743dc53-4e1c-577e-9a0f-e4469ffc1761 (kind agent) is not an approver
```

No TypeScript was in the way. `src/lib/mcp/mcp.integration.test.ts` runs this
same attempt against the live database on every `RUN_DB_TESTS=1` run, and also
proves the row underneath it: inserting an `actor` with `kind = 'agent'` and
`can_approve = true` is refused by `actor_only_humans_approve`.

## 8. Replaying an idempotency key

The same call again, unchanged:

```json
{
  "status": "queued_for_human_approval",
  "money_moved": false,
  "instruction_id": "7f9187c9-0156-4792-bacd-6d64c2d2b2f2",
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
refused. Verbatim from stdout, reformatted for width and with the constant
fields dropped after the first:

```json
{"event":"mcp.audit","requestId":"req_…","method":"tools/call",
 "tool":"initiate_payment","outcome":"ok","errorCode":null,
 "actorId":"3743dc53-4e1c-577e-9a0f-e4469ffc1761",
 "businessId":"e274546d-6bdd-5266-b0fb-cc839a7811f9",
 "grantLabel":"ridgeline-ops-agent","grantFingerprint":"7b5c37ab",
 "clientKey":"::ffff:127.0.0.1",
 "argumentsRedacted":{"rail":"ach","amount_cents":"420000",
   "destination":{"type":"ach","holder_name":"Northwind Components LLC",
     "routing_number":"021000021","account_number_last4":"6789","account_type":"checking"},
   "reason":"Invoice NWC-2026-0603, September machining run, 30-day terms, due today",
   "idempotency_key":"invoice-NWC-2026-0603"},
 "durationMs":1069,
 "result":{"instruction_id":"7f9187c9-0156-4792-bacd-6d64c2d2b2f2","replayed":false,
   "content_hash":"e423ad6eefa640e5b0bece049c9784e17a4305ad5f5bc76eb74fa029da1af3eb",
   "money_moved":false}}

{"tool":"initiate_payment","outcome":"ok","argumentsRedacted":{…same…},
 "durationMs":768,
 "result":{"instruction_id":"7f9187c9-0156-4792-bacd-6d64c2d2b2f2","replayed":true,
   "content_hash":"e423ad6e…da1af3eb","money_moved":false}}

{"tool":"get_balance","outcome":"tool_error","errorCode":"ACCOUNT_NOT_FOUND",
 "businessId":"e274546d-…","grantLabel":"ridgeline-ops-agent","grantFingerprint":"7b5c37ab",
 "argumentsRedacted":{"account_code":"1110"},"durationMs":856}

{"tool":"approve_payment","outcome":"protocol_error","errorCode":"UNKNOWN_TOOL",
 "businessId":"e274546d-…","grantLabel":"ridgeline-ops-agent","grantFingerprint":"7b5c37ab",
 "argumentsRedacted":{"instruction_id":"7f9187c9-0156-4792-bacd-6d64c2d2b2f2"},"durationMs":1}

{"tool":"get_balance","outcome":"protocol_error","errorCode":"INVALID_ARGUMENTS",
 "businessId":"e274546d-…","grantLabel":"ridgeline-ops-agent","grantFingerprint":"7b5c37ab",
 "argumentsRedacted":{"business_id":"1151e7b5-b75b-5f58-bdbf-68cd714178ce"},"durationMs":1}

{"tool":"get_balance","outcome":"tool_error","errorCode":"ACCOUNT_NOT_FOUND",
 "businessId":"1151e7b5-b75b-5f58-bdbf-68cd714178ce",
 "grantLabel":"kettle-ops-agent","grantFingerprint":"6daedd00",
 "argumentsRedacted":{},"durationMs":135}

{"tool":"get_balance","outcome":"ok","businessId":"e274546d-…",
 "grantLabel":"ridgeline-ops-agent","grantFingerprint":"7b5c37ab",
 "argumentsRedacted":{"as_of_value_date":"2026-09-10","as_of_booking_time":"2026-09-10T14:30:00Z"},
 "durationMs":631,"result":{"basis":"as_believed"}}
```

Points worth making about that log:

- **The attempt is recorded, not just the success.** `approve_payment` does not
  exist; the fact that something asked for it, and the instruction id it named,
  are in the log. A surface that only logs what it allowed cannot answer the
  question people actually ask after an incident, which is "what did it try?"
- **Two different tokens, two different `grantFingerprint` values**, and the
  `businessId` on each line is the one the token is scoped to, never one that
  came from an argument.
- **`grantFingerprint`, not `tokenFingerprint`.** `@/lib/log` redacts any field
  whose name contains "token"; this value is four bytes of a sha256 and is
  deliberately non-secret, because it is what distinguishes two tokens sharing a
  label during an investigation. A field that is always `[redacted]` is a field
  that is not in the audit log. (This one was named `tokenFingerprint` first, and
  the log said `[redacted]` until it was renamed.)
- **Arguments are redacted before they are written.** The routing number
  survives — it is published by the Fed and is what identifies the receiving
  institution — and anything matching a secret or a full account number does not.
  There is no full account number to redact here in the first place: the
  destination schema only accepts `account_number_last4`.
- **Where it lands.** One JSON line per call through `@/lib/log`, the same drain
  the rest of the system writes to. A durable `mcp_audit` table is a
  `teeAuditSink` away and its DDL is at the bottom of `src/lib/mcp/audit.ts`; it
  is not added here because migrations are owned by another worker in this
  build. The write tool's trail is already durable and immutable regardless —
  `payment_instruction` and its `requested` event record the agent's actor id,
  the amount, the destination, the value date and the content hash, on tables
  `corgi_app` holds no `UPDATE` or `DELETE` on.

# A second transcript — the four readers added on day two

Captured against **the deployed system** — `POST https://corgi-trial-psi.vercel.app/api/mcp`,
with the published demo token `corgi_mcp_demo_7f3a91c4e05b2d68a4c1` — on
2026-09-11 at 01:26 UTC. Not a local server and not a fixture: these are the
bytes Vercel returned, over the network, reading the live Neon branch.

```bash
curl -s -X POST https://corgi-trial-psi.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer corgi_mcp_demo_7f3a91c4e05b2d68a4c1' \
  -d '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"list_pots","arguments":{}}}'
```

Request and response bodies are verbatim, trimmed only where the omission is
marked, and every id is a real id you can look up in the database. The same
honest note as the first transcript applies: other workers were writing to this
branch while it was captured, so the figures are a snapshot of that minute
rather than fixtures.

## 11. `list_pots` — the money `get_balance` cannot see

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "tools/call",
  "params": { "name": "list_pots", "arguments": {} }
}
```

**HTTP 200**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Ridgeline Robotics, Inc. holds $38,713.13 in total: $23,713.13 in the main balance (of which $5,799.13 is available to spend after holds and uncleared credits) and $15,000.00 earmarked across 2 pot(s) — Payroll — October $12,000.00, Sales tax $3,000.00. Pot money is not part of the main available balance. main + pots reconciles exactly with a recursive walk of the deposit subtree."
    }
  ],
  "structuredContent": {
    "business": { "id": "e274546d-6bdd-5266-b0fb-cc839a7811f9", "legal_name": "Ridgeline Robotics, Inc." },
    "as_of_book_date": "2026-09-10",
    "main_account": {
      "code": "2100",
      "name": "Ridgeline Robotics, Inc. — business current account",
      "ledger_balance": { "cents": "2371313", "display": "$23,713.13" },
      "available_balance": { "cents": "579913", "display": "$5,799.13" },
      "card_authorisation_holds": { "cents": "41100", "display": "$411.00" },
      "uncleared_credits": { "cents": "1750300", "display": "$17,503.00" }
    },
    "pots": [
      {
        "pot_id": "a94a4e92-19af-4004-8fc9-d3b77f23df0c",
        "name": "Payroll — October",
        "purpose": "Wages and payroll taxes for the October run, ring-fenced on the 1st",
        "account_code": "2100.a94a4e92-19af-4004-8fc9-d3b77f23df0c",
        "opened_at": "2026-09-10T23:51:53.143Z",
        "balance": { "cents": "1200000", "display": "$12,000.00" },
        "share_percent": 30
      },
      {
        "pot_id": "ef7dd5c5-9479-4be8-9675-6ec3490ccca7",
        "name": "Sales tax",
        "purpose": "State sales tax collected this quarter, held until the filing date",
        "account_code": "2100.ef7dd5c5-9479-4be8-9675-6ec3490ccca7",
        "opened_at": "2026-09-10T23:51:54.748Z",
        "balance": { "cents": "300000", "display": "$3,000.00" },
        "share_percent": 7
      }
    ],
    "totals": {
      "pot_count": 2,
      "pots_total": { "cents": "1500000", "display": "$15,000.00" },
      "main_plus_pots": { "cents": "3871313", "display": "$38,713.13" },
      "deposit_subtree": { "cents": "3871313", "display": "$38,713.13" },
      "identity_holds": true,
      "identity_difference": { "cents": "0", "display": "$0.00" }
    },
    "truncated": false,
    "note": "A pot is a separate account beneath the customer's 2100 deposit leaf, and money in one is NOT part of the main available balance that get_balance reports. …"
  }
}
```

Three figures matter here and they are three different questions.
`$5,799.13` is what can be spent right now. `$23,713.13` is what the books say
about the main account. `$38,713.13` is how much money this business has. A
surface with only `get_balance` could answer the first two and would answer the
third with the second.

`deposit_subtree` is the same total reached the other way — `v_pot_subtree`
walks `account.parent_id` from the deposit leaf and never reads the `pot` table
— so `identity_holds` is a property the tool SHOWS rather than claims. If the
two ever disagreed the summary would say so in capitals instead of quoting one
of them.

`share_percent` is integer division on `bigint` cents. There is no float
anywhere on this path, including in the decoration.

## 12. `list_payees` — a destination nobody has ever checked

Filtering to the freshness label that should stop a draft:

```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "tools/call",
  "params": { "name": "list_payees", "arguments": { "freshness": "never", "limit": 1 } }
}
```

**HTTP 200**

```json
{
  "content": [
    {
      "type": "text",
      "text": "1 payee(s) on Ridgeline Robotics, Inc.'s book. 1 would pass the payee gate today; 0 would not (blocked, archived, or warned without a human acknowledgement). 1 have a verification that is stale or has never run. 0 share a holder name with another payee carrying different bank details, which is what a changed-bank-details fraud and an innocent duplicate both look like. This surface can read the book and cannot change it, re-check it, or acknowledge a warning."
    }
  ],
  "structuredContent": {
    "payees": [
      {
        "payee_id": "b5d1862a-52cd-448d-a8a8-9fdca9559c4a",
        "display_name": "Never checked",
        "holder_name": "Nobody Ltd",
        "rail": "ach",
        "routing_number": "011401533",
        "account_number_last4": "1111",
        "account_type": "checking",
        "created_at": "2026-09-11T00:11:55.192Z",
        "created_by": "Alex Whitfield",
        "archived": false,
        "archived_at": null,
        "verification": {
          "outcome": null,
          "freshness": "never",
          "checked_at": null,
          "checked_days_ago": null,
          "checked_by": null,
          "evidence": null,
          "routing_checksum_ok": null,
          "routing_prefix_assigned": null,
          "directory": null,
          "directory_provider": null,
          "institution_name": null,
          "name_match": null,
          "name_match_score": null,
          "name_source": null,
          "counterparty_name": null,
          "findings": []
        },
        "acknowledgement": { "acknowledged": false, "acknowledged_by": null, "acknowledged_at": null, "reason": null },
        "has_conflicting_twin": false,
        "payable": true
      }
    ],
    "counts": { "never_checked": 1, "freshness_never": 1 },
    "truncated": true,
    "note": "Outcomes, freshness, name-match bands and findings come from the payee module's own verification record; nothing is recomputed here. …"
  }
}
```

Note the uncomfortable pair: `freshness: "never"` and `payable: true`. Both are
correct. The payee gate blocks on arithmetic and warns on judgement; a payee
nobody has checked has no finding to warn about, so a payment to it is not
refused. `payable` is documented as derived from the columns beside it and NOT
as the gate — `gatePaymentOnPayee()` re-decides inside the transaction that
writes the instruction — and this row is exactly why that distinction is in the
schema text. An agent that reads `payable: true` and stops reading has learned
less than one that reads the line above it.

A verified payee on the same book — same endpoint, same token, `{"holder_name_contains": "ridgeline", "limit": 2}` — carries the other half of the story:

```json
"verification": {
  "outcome": "verified",
  "freshness": "fresh",
  "checked_days_ago": 0,
  "evidence": "live",
  "directory": "not_listed",
  "directory_provider": "increase.routing_numbers",
  "name_match": "unavailable",
  "name_source": "payer_asserted",
  "findings": [
    {
      "code": "NAME_NOT_VERIFIABLE",
      "severity": "note",
      "title": "No bank has confirmed the name on this account",
      "detail": "US ACH has no Confirmation of Payee network: there is no message that asks a receiving bank what name is on an account, and no provider in this system can obtain one for a third party's account. The name below is the one your own team typed. It has been checked for internal consistency and for nothing else."
    }
  ]
}
```

`name_source: "payer_asserted"` is the field that keeps an agent honest. A
`verified` outcome with a payer-asserted name means our own side typed the name
and our own side agreed with it. The tool returns the label rather than
flattening it into "verified", because "the bank confirmed the account holder"
and "we compared two strings we wrote" are different sentences and only one of
them is true here.

## 13. `list_standing_orders` — the payment that did not happen

```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "method": "tools/call",
  "params": {
    "name": "list_standing_orders",
    "arguments": { "refused_only": true, "occurrences_per_order": 1 }
  }
}
```

**HTTP 200**

```json
{
  "content": [
    {
      "type": "text",
      "text": "1 standing order(s) for Ridgeline Robotics, Inc.. 1 recent occurrence(s) shown, 1 of them refused. A refused occurrence was attempted and closed with a reason; it is not carried forward and the next date is unaffected. Nothing here can be created, amended, cancelled or fired through this surface."
    }
  ],
  "structuredContent": {
    "mandates": [
      {
        "standing_order_id": "3e06bbf8-39ca-4c52-8742-7a32117a2fc5",
        "reference": "Quarterly equipment settlement — Northgate Finance",
        "account_name": "Ridgeline Robotics, Inc. — business current account",
        "rail": "ach",
        "amount": { "cents": "2087193", "display": "$20,871.93" },
        "currency": "USD",
        "cadence": "daily",
        "schedule": "every day",
        "start_date": "2026-09-10",
        "end_date": "2026-09-10",
        "next_due_date": null,
        "days_until_next": null,
        "destination": {
          "type": "ach",
          "holder_name": "Northgate Equipment Finance",
          "routing_number": "011401533",
          "account_number_last4": "9012",
          "account_type": "checking"
        },
        "destination_summary": "Northgate Equipment Finance · ACH 011401533 ••9012 (checking)",
        "cancelled": false,
        "created_by": "Priya Raman",
        "occurrence_counts": { "raised": 0, "refused": 1, "undecided": 0 },
        "recent_occurrences": [
          {
            "occurrence_id": "f7c3a4c7-d00b-4223-b1e0-574cc3b4a2fb",
            "scheduled_date": "2026-09-10",
            "idempotency_key": "standing:3e06bbf8-39ca-4c52-8742-7a32117a2fc5:2026-09-10",
            "disposition": "refused",
            "instruction_id": null,
            "refusal_code": "INSUFFICIENT_AVAILABLE_FUNDS",
            "refusal_reason": "Refused: the ledger balance covers this payment but the available balance does not. The difference is money already committed to card authorisations or to credits that have not cleared, and neither is spendable. This occurrence is closed; the next one is unaffected.",
            "shortfall": { "cents": "10000", "display": "$100.00" },
            "observed": {
              "ledger_balance": { "cents": "2108193", "display": "$21,081.93" },
              "card_authorisation_holds": { "cents": "31000", "display": "$310.00" },
              "uncleared_credits": { "cents": "0", "display": "$0.00" },
              "available_balance": { "cents": "2077193", "display": "$20,771.93" }
            },
            "decided_at": "2026-09-10T22:36:27.096Z",
            "claimed_at": "2026-09-10T22:36:26.947Z"
          }
        ]
      }
    ],
    "policy": {
      "on_insufficient_funds": "The occurrence is refused and closed, with the reason and the four observed figures on the row. No partial payment, no carry-forward, no queue that fires whenever the money arrives. The next occurrence is unaffected and fires on its own date.",
      "insufficient_funds_code": "INSUFFICIENT_AVAILABLE_FUNDS",
      "stale_after_days": 5,
      "catch_up_window_days": 45
    },
    "counts": { "mandates": 1, "active": 1, "cancelled": 0, "occurrences_shown": 1, "refused_shown": 1 }
  }
}
```

This is the live-fire question — "what happens on the day the balance cannot
cover it" — answered from a row rather than from a policy document. The ledger
held $21,081.93 and the payment was $20,871.93, so a system that checked the
LEDGER would have paid it; available was $20,771.93 because $310.00 sat in open
card authorisations, and the shortfall is exactly $100.00. All five figures are
on the occurrence, so the refusal can be explained in a year without
re-deriving a balance that has moved since.

`idempotency_key` is generated by Postgres and unique on `payment_instruction`.
It is the exactly-once mechanism, and it is returned rather than described:
a second run of the same date cannot raise a second payment because that string
is already taken.

## 14. `list_card_controls` — why the pump declined

```json
{
  "jsonrpc": "2.0",
  "id": 23,
  "method": "tools/call",
  "params": {
    "name": "list_card_controls",
    "arguments": { "declines_only": true, "limit": 1, "decision_limit": 1 }
  }
}
```

**HTTP 200**

```json
{
  "content": [
    {
      "type": "text",
      "text": "1 card(s) for Ridgeline Robotics, Inc.: 0 frozen, 1 with no controls set. ••6707 no controls, $50.00 approved today. 1 recent authorisation decision(s), 1 declined; the most recent decline was $50.00 at CORGI FUEL PUMP LIVE on 2026-09-11T00:44:10.461Z, rule mcc_blocked, network result UNAUTHORIZED_MERCHANT — Merchant category 5542 is blocked on this card (control version 1).. Controls can be read here and not changed: that is a real-time authorisation decision and it is not on this surface."
    }
  ],
  "structuredContent": {
    "cards": [
      {
        "card_id": "095c941b-9ed2-4362-a885-c0402815109c",
        "last_four": "6707",
        "nickname": "corgi core loop CL-MTW8PY2K",
        "created_at": "2026-09-11T00:51:19.588Z",
        "controls": null,
        "spend_today": { "cents": "5000", "display": "$50.00" },
        "spend_this_month": { "cents": "5000", "display": "$50.00" },
        "headroom_today": null
      }
    ],
    "recent_decisions": [
      {
        "decided_at": "2026-09-11T00:44:10.461Z",
        "card_id": "42c947d7-687f-466e-8c7b-bd29fce8bd14",
        "last_four": "2971",
        "nickname": "corgi core loop CL-MTW7HJG9",
        "amount": { "cents": "5000", "display": "$50.00" },
        "mcc": "5542",
        "merchant_category": "5542 · Automated fuel dispenser",
        "merchant": "CORGI FUEL PUMP LIVE",
        "request_status": "AUTHORIZATION",
        "outcome": "decline",
        "result_code": "UNAUTHORIZED_MERCHANT",
        "rule": "mcc_blocked",
        "reason": "Merchant category 5542 is blocked on this card (control version 1).",
        "control_version": 1,
        "decision_latency_ms": 147,
        "source": "provider"
      }
    ],
    "counts": { "cards": 1, "frozen": 0, "without_controls": 1, "decisions": 1, "declines": 1 },
    "truncated": true,
    "note": "Controls are the real-time authorisation decision made in advance: the values here are what the network is told, inside the provider's timeout, with no human on the path. …"
  }
}
```

A real decline, made by this system inside Lithic's ASA window in 147ms, on a
real sandbox authorisation at a fuel pump. It is not in the ledger and never
will be — no money moved — so this decision log is the only place the answer to
"why was my card declined" exists.

Two details worth pointing at. `controls: null` on the card in the page is not
"no limits": it is a card nobody has set a policy on, and the decision log
shows the rule `no_controls_configured` approving spend on exactly such cards.
Conflating the two would have an agent tell a customer their card is
unrestricted when the truth is that nobody has restricted it yet.

And `provider_card_token` appears nowhere in that payload. It is on the row this
is projected from; it is dropped in the gateway, before anything downstream
could log or return it. It is the handle that addresses a card at Lithic, and an
agent that never holds one cannot be talked into using it.

## 15. An unknown argument, refused rather than ignored

```json
{
  "jsonrpc": "2.0",
  "id": 24,
  "method": "tools/call",
  "params": { "name": "list_pots", "arguments": { "pot_id": "x" } }
}
```

**HTTP 200**

```json
{
  "jsonrpc": "2.0",
  "id": 24,
  "error": {
    "code": -32602,
    "message": "invalid arguments: (root) — Unrecognized key: \"pot_id\"",
    "data": { "problems": [ { "field": "(root)", "problem": "Unrecognized key: \"pot_id\"" } ] }
  }
}
```

Every schema on this surface is strict, including the four newer ones. A model
that invents `pot_id`, `card_id` or `business_id` is told plainly that no such
parameter exists rather than being served its own tenant's data and left
believing the parameter worked — because the next call it writes with that
belief is the dangerous one. `tools.test.ts` asserts the refusal over every
registered schema and over every name in `FORBIDDEN_PARAMETER_NAMES`, so a
future tool cannot quietly accept one.

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
