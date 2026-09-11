# Outbound webhooks — the events this bank sends to its customers

Every other integration in this build points inward: Lithic, Increase, Plaid,
Persona and Stripe push events to us, and `src/lib/webhooks/**` is the one door
they come through. This is the only thing that points outward.

It exists because the brief puts a **public API** in v1 scope, and an API
without events is a polling API. A business integrating with this bank needs to
know when a payment settled, when an authorisation landed, when a correction
was booked — without asking every thirty seconds.

The sending half is the mirror of the receiving half, deliberately, line for
line where it can be. Everything hard about webhooks was already decided in
this repository by people who got it wrong first: raw bytes before parse,
Standard Webhooks signatures, replay killed by a unique index, bounded retry
into a dead letter whose message names the missing thing. This reuses those
decisions rather than re-litigating them, and where it departs from them it
says why.

| file | what it is |
| --- | --- |
| `db/migrations/0034_outbound_events.sql` | The tables, their guards, their grants, the two views. |
| `src/lib/events/envelope.ts` | What a customer receives, and the entry→event mapping. |
| `src/lib/events/sign.ts` | Standard Webhooks signing. The mirror of `inbox.ts`'s verifier. |
| `src/lib/events/secret.ts` | The per-endpoint secret, and the type that stops it leaking. |
| `src/lib/events/url.ts` | **What we refuse to fetch, and why.** The SSRF fence. |
| `src/lib/events/transport.ts` | The pinned-IP HTTPS POST. The enforcement. |
| `src/lib/events/store.ts` | Every SQL statement this feature issues. |
| `src/lib/events/deliver.ts` | The worker: claim, sign, POST, retry or dead-letter. |
| `src/lib/events/drain.ts` | Generate then deliver. Safe at any time. |
| `src/app/(app)/events/**`, `src/components/events/**` | The delivery log a customer can read. |

```
journal_entry committed
    │                                    (nothing below is in that transaction)
    ▼  cursor over booking_seq          outbound_cursor.last_sequence
outbound_event      UNIQUE (business_id, source_entry_id, event_type)
    │                                    <- double emission dies here
    ▼  fan out to active endpoints
outbound_delivery   UNIQUE (event_id, endpoint_id)
    │                                    <- duplicate fan-out dies here
    ▼  claim under a lease, FOR UPDATE SKIP LOCKED
sign  ->  POST https://… (pinned IP, no redirects, 10s, bounded response)
    │
    ├─ 2xx        state = delivered
    ├─ anything   backoff, retry, up to 8 attempts
    └─ budget spent   state = dead, dead_reason NAMES THE FAILURE
outbound_attempt    one append-only row per attempt = the delivery log
```

---

## 1. The trap, and how the schema makes it unrepresentable

**An outbound webhook must never affect the ledger and must never block a
transaction.** If a customer's endpoint is slow or down, their payments still
settle. Get this wrong and a customer's broken server stops their own money
moving.

It is not held by discipline. It is held by three facts that can be checked by
reading, not by trusting:

**The generator is a cursor, not a hook.** `outbound_cursor.last_sequence`
walks `journal_entry.booking_seq` *after the fact*, exactly the way a
change-data-capture consumer would. Nothing was added to the posting path — no
`postEntry()` caller writes to these tables, and no agent's code was touched to
make this work.

That is possible because the ledger already publishes a change feed and did not
know it. Migration 0001 §14 serialises `booking_seq` assignment so that
**sequence order is commit order** within a book entity, which makes
"everything above N" a set that can never gain rows below N later. That is
precisely the property a watermark needs, and precisely the property a
timestamp does *not* have.

**Every foreign key points one way.** `outbound_event.source_entry_id
REFERENCES journal_entry(id)`. There is no column anywhere in the money schema
that references anything in `outbound_*`. A posting therefore cannot be waiting
on a delivery row, and a delivery row cannot be created inside a posting's
transaction, because the posting's transaction does not know these tables
exist.

**The worker holds no lock the posting path wants.** Every statement this
feature issues is in `store.ts` and touches `outbound_*` tables only. The only
money table it reads is `journal_entry`, and it reads it — `SELECT`, no `FOR
UPDATE`, from a watermark, outside any transaction that posts.

### The proof

```
$ set -a; . ./.env; set +a
$ EVENTS_LIVE=1 npx vitest run src/lib/events/roundtrip.live.test.ts
 ✓ a dead endpoint retries with backoff and dead-letters with a message that names the failure
```

That test registers `https://httpbin.org/status/503`, queues a real event from
a real journal entry, and drives the entire retry budget against a host that
really answers 503 — eight attempts, exponential backoff, into a dead letter.
While it runs, the ledger is untouched: no journal entry is written, no hold
moves, no row on any money table changes. The endpoint is as dead as an
endpoint gets and the only thing that happened is eight rows in
`outbound_attempt`.

The structural version of the same proof, which does not depend on running
anything:

```
$ grep -rl "lib/events" src/lib/ledger src/lib/holds src/lib/rails
  (no matches)
```

If that command ever returns a file, this guarantee is gone.

### The hook we did NOT add, and would want

Nothing here is blocked on it, but it is worth stating what a second pass would
ask for:

> **A low-latency nudge after a commit.** Today an event is generated by the
> next drain tick, so the floor on end-to-end latency is the cron period.
> The right shape is `after(() => drainOutbound())` — Next's `after()`, so it
> runs once the HTTP response is already on its way — in the route handlers
> that post money, exactly the way `src/app/api/webhooks/[provider]/route.ts`
> already nudges the inbound drain. It must be `after()` and never `await`
> inside the transaction; that distinction is the whole of this section.
>
> That is a one-line change in files owned by other workers, so it was reported
> rather than made.

---

## 2. Signing: the same scheme we verify on the way in

**Standard Webhooks.** Three headers, HMAC-SHA256 over `{id}.{timestamp}.{raw
body}`, base64, `v1,`-prefixed, space-separated while a secret rotates, ±300s
replay window.

| header | value |
| --- | --- |
| `webhook-id` | the event id. **Stable across every retry and every endpoint of the same business.** This is the customer's dedup key. |
| `webhook-timestamp` | unix seconds at **this attempt**. Changes per attempt, so the signature does too — a frozen timestamp would make a captured delivery replayable for the whole retry window. |
| `webhook-signature` | `v1,<base64>`, space-separated when more than one secret is live. |

This is the identical scheme `src/lib/webhooks/inbox.ts` uses to verify real
**Lithic** deliveries into this system, with `secretEncoding: 'base64'` — the
spec's key handling, and what Lithic's own SDK does. A customer therefore needs
nothing from us: the `standardwebhooks` npm package, any Svix library, or a
verifier they already wrote for their Lithic or Stripe feed will check our
signature with the secret and nothing else.

### The round trip, and the negative control

`src/lib/events/sign.test.ts` signs a body and hands it to
`standardWebhooksVerifier` **imported from `src/lib/webhooks/inbox.ts`** — the
function that checks real provider traffic. Nothing in `src/lib/webhooks/**`
was modified to make it pass.

`src/lib/events/roundtrip.live.test.ts` does it over a real network. It signs,
delivers to a public HTTPS receiver that echoes the request verbatim, takes the
**echoed bytes and echoed headers**, and runs the same verifier over them.

Live, against `https://httpbin.org/post`:

```
POST https://httpbin.org/post?run=1789106032131
webhook-id: 7ce0c43a-ff20-4cda-af27-7e32d09299b6
webhook-timestamp: 1789106066
webhook-signature: v1,9jByGe2vJJrDrFtr5O/P+kcn4FoOetBvHa5xtykYruM=
content-type: application/json; charset=utf-8
user-agent: Corgi-Webhooks/1

HTTP 200
receiver echoed:  Webhook-Id: 7ce0c43a-ff20-4cda-af27-7e32d09299b6
                  Webhook-Signature: v1,9jByGe2vJJrDrFtr5O/P+kcn4FoOetBvHa5xtykYruM=
                  Webhook-Timestamp: 1789106066
receiver echoed body === bytes we signed:   true

VERIFICATION over the ECHOED bytes
  untouched body verifies:  true
  tampered  body verifies:  false      "cents":"22714"  ->  "cents":"227149"
```

**A signature nobody has watched reject something is not a signature.** Five
negative controls are asserted, not described:

| control | result |
| --- | --- |
| one digit changed in the amount | `{ ok: false, reason: "no v1 signature matched" }` |
| a different secret | `{ ok: false, reason: "no v1 signature matched" }` |
| the same delivery six minutes later | `{ ok: false, reason: "timestamp too old (…)" }` |
| the body parsed and re-serialised | `{ ok: false, reason: "no v1 signature matched" }` |
| no live secret at all | refuses to sign; nothing is sent unsigned |

The fourth one is the outbound spelling of the footgun `rawbody.ts` exists to
prevent: `{"test": 2432232314}` and `{"test":2432232314}` have completely
different signatures. It is why `outbound_event.body` is `text` and never
`jsonb` — jsonb reorders keys, drops whitespace and renormalises numbers, so
storing jsonb and re-serialising at send time would produce signatures nobody
can verify.

### Secrets: shown once, never again, never logged

The signing secret lives in **its own table**, `outbound_endpoint_secret`, for
one reason: so that `SELECT * FROM outbound_endpoint` — the query every screen,
every debug session and every `console.log(row)` reaches for — *cannot* return
one. This repository has already leaked two live credentials into git history;
the pre-commit gate catches a commit and catches nothing that goes to a log
drain.

Once it leaves the database it is never a `string`. `SigningSecret` is an
opaque object whose material is behind a module-private `Symbol`:

```
JSON.stringify(secret)   ->  "[redacted]"
`${secret}`              ->  "whsec_***"
console.log(secret)      ->  SigningSecret(v1) [redacted]
{...secret}              ->  {}
```

`revealSecret()` is the only way through, it is greppable, and it has exactly
two callers: the signer, and the creation path that hands the plaintext back
once. There is no read path in `src/lib/events/**` or
`src/components/events/**` that can produce it again — the screen's data
contract has no field that could hold one, and `v_outbound_delivery` does not
join the secret table at all.

**Rotation is the answer to a lost secret, not a reveal button.** A new version
is inserted; both sign every delivery until the old one is retired. The
`webhook-signature` header carries two space-separated entries and any match
wins — which is not something we invented, it is what Lithic and Increase send
*us*, and what `standardWebhooksVerifier` already parses.

It is stored in plaintext, and that is stated rather than dressed up: an HMAC
needs the key material, so "hashed at rest" is not available the way it is for
a password, and encrypting it with a key from the same environment the
application reads would move it one dereference away and no further. What is
bought is blast radius: a separate table, no UPDATE grant on the column, and a
guard trigger that refuses to let a live secret be altered.

---

## 3. At-least-once, with idempotency

Exactly-once delivery does not exist. Exactly-once *state* does, and it is
bought in the consumer — that is what `webhooks/README.md` §9 says about our
own inbox, and it is just as true in this direction.

So we are honest about it and we give the customer the same tool we use:

**Every delivery carries a stable event id.** It is `outbound_event.id`, it is
in the body as `id`, it is the `webhook-id` header, and it does not change
across retries or between two endpoints of the same business. A customer should
do to us precisely what we do to Lithic:

```sql
INSERT INTO their_inbox (provider, provider_event_id, …)
VALUES ('corgi', $webhook_id, …)
ON CONFLICT (provider, provider_event_id) DO NOTHING
```

and return 2xx either way. A replay is not an error — it is us doing what this
document says we do. Answering `409` only produces more replays.

**Retry is bounded.** Eight attempts, 5s doubling to a 1h cap, 20% jitter.
Eight because that is the number this system is itself held to by Lithic: if
eight attempts is enough for a provider to conclude we are down, it is enough
for us to conclude a customer is. The ladder spans a little over five hours,
which covers an ordinary deploy, an ordinary incident and a certificate expiry
noticed in the morning. Past that it is not a blip and a human needs to know.

The jitter matters more than it looks: without it, a customer who goes down and
comes back receives their whole backlog in one synchronised burst — our outage
becoming their outage.

`backoffDelayMs` is **imported** from `src/lib/webhooks/dispatch.ts` rather than
copied. It is pure and already tested against exact numbers with an injected
`random`; a second exponential-backoff implementation in one repository is two
places to fix the day somebody finds the jitter is one-sided.

**`attempts` is incremented at claim, not at failure.** The inbox's
poison-message defence, unchanged: a worker that dies mid-delivery has still
spent an attempt, so an endpoint that reliably kills workers cannot loop for
ever.

**The dead letter names the missing thing.** Not "invalid request" — that is
what the inbound dead letter used to say, and the reason nobody could act on
it. Real messages from this system:

```
dead-lettered after 8 attempts: HTTP 503 from httpbin.org
dead-lettered after 8 attempts: refused before connecting: 'x.example' resolves
  to 10.4.19.6, which is a private address (10.0.0.0/8, RFC 1918)
no live signing secret for this endpoint — every secret version has been
  retired. Rotate the endpoint to issue a new one; nothing is sent unsigned.
HTTP 301 redirect to 'https://elsewhere.example/' — redirects are never
  followed, because a redirect is a second URL chosen by the destination after
  our checks ran. Register the new URL as an endpoint instead.
```

**Generation is at-least-once too, and the database decides.** A worker can die
between inserting events and advancing the cursor, so the next pass sees the
same entries. It produces nothing, because `UNIQUE (business_id,
source_entry_id, event_type)` and `UNIQUE (event_id, endpoint_id)` are enforced
with `ON CONFLICT DO NOTHING` and **the row count is the decision** — no
`SELECT` first, so no race between two statements, and no `if` over application
state that could be wrong.

---

## 4. Ordering is not guaranteed, and we say so out loud

**We do not promise ordering. We promise the means to reconstruct it.**

We retry, we fan out to more than one endpoint, and more than one worker can
drain the queue. Any one of those reorders arrival relative to what happened,
and the first is enough on its own: a delivery that fails twice and succeeds on
its third attempt arrives after everything queued behind it.

This build exists *because* providers deliver out of order. `dispatch.ts` opens
with "the dispatcher makes no ordering promise at all, so consumers cannot come
to depend on one." Promising our own customers otherwise would be a lie we then
have to keep — across every retry, every deploy, and every future worker.

So the envelope carries the state to reconstruct order without trusting
arrival:

```json
{
  "id": "7ce0c43a-ff20-4cda-af27-7e32d09299b6",
  "type": "transaction.posted",
  "api_version": "2026-09-10",
  "sequence": "2735",
  "occurred_at": "2026-09-11T05:07:55.538Z",
  "value_date": "2027-11-15",
  "business_id": "e274546d-…",
  "delivery": {
    "ordered": false,
    "order_by": "sequence",
    "note": "Deliveries are at-least-once and unordered. Deduplicate on `id` (also
             sent as the webhook-id header) and order by `sequence`, which is this
             ledger's total order. `data` is a snapshot at emit time; read `links`
             for authoritative current state."
  },
  "data": {
    "object": "ledger_entry",
    "entry_id": "a8d5fde8-…",
    "entry_type": "original",
    "book": "financial",
    "rail": "ach",
    "description": "Live-fire settlement LF6-MTWHW9IB-2",
    "external_ref": "LF6-MTWHW9IB-2",
    "reverses_entry_id": null,
    "correction_group_id": "a8d5fde8-…",
    "net_amount": { "currency": "USD", "cents": "22714" },
    "accounts": [ { "account_code": "2100", "account_name": "…", "amount_cents": "22714", "currency": "USD", "memo": null } ]
  },
  "links": {
    "transactions": "/api/v1/transactions?account_code=2100&value_date_from=2027-11-15&value_date_to=2027-11-15",
    "balance": "/api/v1/accounts/2100/balance"
  }
}
```

### How a customer reconstructs order

**`sequence` is `journal_entry.booking_seq`.** Not a per-endpoint counter, not
a delivery number: the ledger's own total order, assigned under a serialised
lock so that sequence order is commit order. It is the same integer
`GET /api/v1/transactions` publishes as `booking_seq` on every row and builds
its pagination cursor from, so an event and an API row about the same fact
carry the same number.

Sort on it. Two events about the same account, `sequence` 3007 and 3011, are in
that order in the book no matter which arrives first. A gap in the sequence is
not a lost event — most journal entries touch nobody's customer account (house
entries like interchange income emit nothing), so gaps are normal and are not a
signal.

**Both clocks ride along, always.** `value_date` is *when it happened*;
`occurred_at` is *when we learned it*. They differ, and a backdated correction
is exactly where treating either one as "the date" goes wrong: a reversal
booked Thursday for Tuesday's settlement carries Tuesday's `value_date` and
Thursday's `occurred_at`. A customer aggregating a daily file has to know which
axis they are on. Corrections are visible as extra events —
`transaction.reversed` then `transaction.rebooked`, carrying
`reverses_entry_id` and `correction_group_id` — never as a row that changed
underneath them, because nothing in this ledger is ever edited.

**The body is a pointer.** `data` is a snapshot at emit time; `links` names the
resources holding authoritative state. This is the same answer this build's own
Plaid consumer runs on, and it buys three things:

- *Out-of-order stops mattering for state.* Receive `transaction.reversed`
  before `transaction.posted` and reading the balance back gives the same
  answer either way. Only the event **log** needs ordering, and `sequence`
  orders that.
- *A duplicate delivery is free.* Re-reading is idempotent by construction.
- *The body can never drift from the ledger*, because it is not a second copy
  of it.

`links` are **relative** to the API base the customer integrated against. This
deployment has no configured public origin, and inventing one would produce
links that 404 in exactly the environment where somebody trusts them.

### The event types

Six, and the mapping from a journal entry is total by construction —
`entry_type` is an enum of three and `book` is an enum of two, so all six
combinations are named and a new entry type fails the typecheck rather than
silently producing an event called `undefined`.

| book | `original` | `reversal` | `rebook` |
| --- | --- | --- | --- |
| `financial` | `transaction.posted` | `transaction.reversed` | `transaction.rebooked` |
| `memo` | `hold.placed` | `hold.released` | `hold.adjusted` |

The memo book gets its own family rather than being flattened into
`transaction.*` because the distinction is the one the whole domain turns on: a
`hold.placed` is available balance moving while ledger balance does not. A
customer watching card authorisations is watching `hold.*`; one reconciling
settled money is watching `transaction.*`.

### What is never in a body

No secret, no full account number, no card number, no PAN fragment, no expiry,
no CVV, no director PII. The mechanism is not intention: `data` is built from a
fixed list of columns in `buildEnvelope()`, there is **no passthrough of any
provider payload anywhere in the module**, and a test asserts the body's
top-level key set exactly, so a new field cannot appear without somebody
choosing it.

Money is **integer cents as a decimal string** (`"22714"`), never a JSON
number. The ledger is `bigint` and `src/lib/ledger/db.ts` goes out of its way
to stop bigint silently becoming a JS number; serialising as a float at the
last step would throw that away at the exact boundary where someone else's
parser decides what it means. `"9007199254740993"` survives; `9007199254740993`
would not.

The sign convention is `amount_cents * account.normal_side` — **positive is
money in for the account holder** — which is the same expression
`/api/v1/transactions` publishes. An event and an API row about one fact must
not need a sign flip between them.

---

## 5. What we refuse to fetch, and why

A customer types a URL and our server fetches it. That sentence is the
definition of SSRF. This is the **second** time this class has appeared in this
repository today — the earlier one was a header-controlled fetch that let a
caller choose which host the server called. That one was a bug. This one is a
feature request: the destination is attacker-controlled *by design*, so it
cannot be fixed by removing the capability. It has to be fenced.

| # | refused | why |
| --- | --- | --- |
| 1 | anything but `https:` — `http:`, `file:`, `gopher:`, `ftp:`, `data:`, `redis:` | The body is a customer's transaction history and the headers carry its signature; in clear text both are readable by every hop. And `http:` is the scheme of every classic pivot into a plaintext internal protocol, because enough of them will parse an HTTP request as a command stream. **Enforced twice**: in code, and as a `CHECK` constraint in 0034 where an application bug cannot route around it. |
| 2 | any port but 443 | The bar most people leave out, and the one that turns a webhook sender into a **port scanner with a UI**: a delivery attempt reports, in the customer's own log, whether a connection succeeded, was refused, or hung — for any host:port they choose. Restricting to 443 collapses the port axis entirely, and every real receiver on the public internet listens there. |
| 3 | userinfo in the URL | `https://evil.example@internal.svc/` has host `internal.svc` and is read as `evil.example` by roughly every human and a depressing number of parsers. Refusing removes a whole family of validator-vs-fetcher disagreements. |
| 4 | `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.onion`, and any single-label host | A single-label name resolves through the deployment's own search domain — the internal namespace this exists to keep out — and the answer differs per environment, so "it was fine in CI" is not evidence about production. |
| 5 | **any** resolved address that is not global unicast | The bar that actually holds, because 1–4 are about the string and DNS decides where the packet goes. `evil.example` with an A record of `169.254.169.254` passes every textual check ever written. Refused in v4 and v6: loopback (`127/8`, not just `.1`), RFC 1918, CGNAT `100.64/10`, link-local `169.254/16` (**the cloud metadata service**), `0/8`, documentation, benchmarking, 6to4 relay anycast, multicast, reserved `240/4`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8` — **and the v6 spellings of v4 addresses**: `::ffff:127.0.0.1`, `::ffff:7f00:1`, the NAT64 prefix `64:ff9b::/96`, 6to4 `2002::/16`, and deprecated `::/96`. Those exist precisely so a v4 address can arrive wearing a v6 coat. |
| 6 | a connection to an address we did not check | Validating a name and then handing the *name* to a fetch library re-resolves it, and that window is DNS rebinding: a 0-TTL record answers public on the check and internal on the connect. So `transport.ts` passes a `lookup` function to `node:https` that returns only the pinned address from this validation. **There is no second resolution to poison.** SNI and certificate validation still use the hostname, so TLS is not weakened. |
| 7 | redirects, always | A redirect is a second URL, chosen by the destination, *after* every check above ran. Following one — even "just to https" — hands the attacker a validated request aimed wherever they like: the whole fence undone by one `Location` header. `node:https` does not follow redirects and has no option to; a 3xx is a delivery failure whose message tells the customer to register the new URL. |

Two more bounds, because a customer's server is untrusted in every direction:
the whole exchange is capped at **10 seconds** (a wall-clock timer, not only
socket inactivity, which a trickling server can dodge for ever), and the
response is read to **8 KiB** and then the socket is destroyed, with 1 KiB
stored as an excerpt.

### The bound that was written down and did not hold

**2026-09-11.** Both sentences above were true of the code and one of them was
worthless, because the 8 KiB bound ended the *read* and never ended the
*attempt*. `res.destroy()` at the cap emits `aborted` and `close` on the
response and `close` on the request. It does **not** emit `end`, and it does not
emit `error` — and `end` was the only handler that resolved the promise, while
the `close` handler on the request cleared the wall-clock backstop that was
supposed to catch exactly this. So the socket died, the timer was cancelled by
the death, and the promise stayed pending. Measured against a real endpoint
echoing 40 KiB:

```
{ requestBytes: 20010, cap: 8192, settledAfterMs: null, outcome: "NEVER SETTLED" }
   — 40,014 ms of wall clock on a transport whose documented timeout is 10,000 ms,
     still pending when the harness gave up. Control, same endpoint, 204 response: 544 ms.
```

`deliverOnce()` awaits that promise **sequentially**, once per delivery. So it
is not one slow delivery: it is every later delivery, for every other customer,
stopped for the life of the process — a denial of service any customer can cause
by accident with a verbose error page. The queue's own rule is that delivery can
never touch the ledger, and that held; what it could do was stop every other
delivery, which is the other half of the same promise.

**What a too-large delivery does now.** Hitting the cap settles the attempt
**there**, inside the `data` handler, before destroying the socket — it does not
destroy and hope. The outcome carries `limit: "response_too_large"` and an error
that names the number, and `deliver.ts` turns a non-null `limit` into an
immediate **dead letter** rather than spending the retry budget: the next attempt
would read the same page off the same server.

```
HTTP 200 with a response body over the 8192-byte read limit (read 16152 bytes and
stopped; the socket was closed rather than drained). A webhook acknowledgement must
be short — answer with a status and a brief body. This delivery was not retried,
because the next attempt would read the same page.
   — settled in 545 ms, with the first 1 KiB of their own body kept as the excerpt.
```

Three rules now hold the file together, and they are worth stating because the
bug was the absence of each:

1. **Every terminal socket event settles the promise** — `end`, `error` *and*
   `close`, on both halves. `close` is the only one that fires however an
   exchange ended, so it is the catch-all under the other two rather than a
   place to cancel timers.
2. **A bound settles the promise where it is enforced**, not by killing a socket
   and waiting for an event the kill just made impossible.
3. **The wall-clock deadline is cleared by settlement alone.** It is
   `timeoutMs + ATTEMPT_DEADLINE_GRACE_MS` (2 s), so the ordinary socket timeout
   still wins the ordinary late endpoint and that delivery still retries; if the
   deadline is what settles an attempt, the transport failed to police itself,
   the outcome carries `limit: "attempt_deadline"`, and the delivery is dead with
   the deadline named. Nothing on the wire can cancel it, and because settlement
   always clears it, it cannot hold a serverless invocation open either.

None of this touched the request options: no redirect was enabled, no second DNS
resolution was introduced, and the pinned `lookup` is still the only resolution
that happens. Asserted live against a real HTTPS endpoint, in the gated
`src/lib/events/bounds.live.test.ts` — over-cap settles and dead-letters;
under-cap is untouched and still 2xx (the regression a `close` backstop can
introduce); and an ordinary timeout is still a **retryable** failure with
`limit: null`, not a dead letter.

```
EVENTS_LIVE=1 npx vitest run src/lib/events/bounds.live.test.ts
```

**`ALL` resolved addresses, not the first.** A name with one public A record and
one internal one is a bypass, not a coincidence — checking only the first
address means the resolver's ordering decides whether we are safe today.

**`fetch` is not used.** It resolves the hostname itself inside undici after
our check ran, it follows redirects by default (`redirect: "manual"` is a flag
someone can remove), and its body is a promise you either await whole or
abandon. `node:https` gives the safe behaviour as the *only* behaviour on all
three.

### What this costs, stated plainly

A developer cannot point an endpoint at `localhost:3000` or at an HTTP tunnel.
That is a real inconvenience and it will be asked about. The answer is that the
exemption people reach for — "allow loopback in development" — is a flag one
environment-variable mistake away from being on in production, and what it
protects is the deployment's entire internal network.

**There is deliberately no allowlist escape hatch in `url.ts`**: no
per-endpoint "trusted" boolean, no env var. If one is ever needed it belongs in
a separate, loudly-named module a reviewer trips over.

### The audit trail nobody else prints

`outbound_attempt.resolved_ip` records **the address the socket actually
connected to**, per attempt. It is on the delivery screen as a column.

Two reasons. The hardest outbound-webhook support conversation is the one where
the customer's endpoint is up, reachable from their laptop, and refused by us —
which is what a DNS record that started answering internally looks like from
their side. Printing the address turns that from an argument into a fact. And
it is the standing proof that this service has never connected to anything
internal: *"has it ever?"* is a query, not an opinion.

```sql
SELECT count(*) FROM outbound_attempt
 WHERE resolved_ip << ANY (ARRAY['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16',
                                 '127.0.0.0/8','169.254.0.0/16']::inet[]);
```

Live, this refusal is asserted end to end against real DNS:
`registerEndpoint({ url: "https://localtest.me/hook" })` — a genuine public
name whose A record is `127.0.0.1` — is refused with
`ADDRESS_NOT_GLOBAL … loopback (127.0.0.0/8) — that is this server`, **and no
row is written**.

---

## 6. The delivery log the customer sees

`/events`, modelled on the operator-facing delivery surfaces this console
already has, with one difference that changes almost every column: **the
audience is the person whose server is broken.** An operator reading an inbound
dead letter wants to know what *we* must fix; a customer reading an outbound one
wants to know what *they* must fix.

| column | answers |
| --- | --- |
| state | delivered / pending / dead, with the semantics in the tooltip |
| event | type, the `webhook-id` we signed under, both clocks, the byte count — enough to grep their own logs for this exact delivery |
| seq | the ledger's total order |
| response | HTTP status, duration, **and the first line of their own response body** — usually the only thing that explains a 500 to the person who wrote the server that emitted it |
| connected to | the resolved IP, or "never connected" when no packet was sent |
| attempts | how many, and when the next one is — so "is it coming back?" is a fact on the screen rather than a question in an email |

Five states, all reachable from the URL, the house pattern: `default` (live),
`?state=loading`, `?state=empty`, `?state=error`, `?state=edge`.

The **edge state is a dead letter refused before a packet was sent**, because
the endpoint's DNS started answering with a private address. That is the state
this screen most needs to render well, and the one most likely to render wrong:
every signal the customer has says their server is fine, and if the screen does
not print the address and the reason, the conversation is unresolvable. It also
exercises the `lastResolvedIp === null` branch, which must read "never
connected" rather than a plausible blank.

Backing it are two views, in SQL rather than in TypeScript, for the reason 0002
gives for `v_webhook_dead_letter`: a view cannot go stale against a schema
change, and the customer log and the operator dead-letter list must read the
same join or they will eventually disagree in front of somebody. **Neither view
joins the secret table**, which is checkable by reading 0034 §9.

### The grant 0002 made and the database did not have

**2026-09-11.** `0002:321` says
`GRANT SELECT ON v_webhook_dead_letter, v_webhook_parked TO corgi_app`, the file
is hashed into `schema_migrations` exactly as applied, and the application role
could not read either view:

```
SELECT count(*) FROM v_webhook_dead_letter     (as corgi_app)
  -> ERROR: permission denied for view v_webhook_dead_letter
relacl: {neondb_owner=arwdDxtm/neondb_owner}   — no corgi_app entry, on both views
        (107 of the schema's 109 views ARE readable by corgi_app; these were the two)
```

**Both were true.** The statement ran, and then the privilege was removed out of
band by our own tooling: `scripts/dbreset.mjs` rebuilds the schema, re-runs the
migrations, and finishes with `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
corgi_app` followed by a hand-maintained re-grant list that names tables and no
views. "ALL TABLES" includes views. The apply timestamps show which side of that
reset each migration fell on — `0001`, `0002` and `0003` share one batch at
`01:29:06.226Z / .981Z / 01:29:07.346Z` and `0005` onwards came later, over
hours — so 0002's view grants were inside the reset and were eaten, while 0038's
identical view grants, applied afterwards, are still there. `0008 §1` records
the same injury being repaired by hand for 0001's thirteen derived views, found
the same way: *"by running the application role against the live database rather
than by reading the file."*

`db/migrations/0045_webhook_view_grants.sql` re-grants both and then **asserts
the privilege in the same transaction**, so the migration cannot claim what it
did not create. Proven as `corgi_app` after it applied: `v_webhook_dead_letter`
30 rows, `v_webhook_parked` 160 rows.

**No screen fell back, because no screen reads them.** That is the second
finding, and it is why nobody noticed for a day: `src/lib/home/summary.ts` counts
dead and parked rows straight off `webhook_inbox`, `src/lib/chaos/observe.ts`
groups the parked ones the same way, and both are readable. A documented staff
surface was dead with no degraded screen and no logged error anywhere. **An
unread view is a claim nobody checks.** `scripts/dbreset.mjs` will also do it
again to the next grant a migration writes — its REVOKE-plus-hardcoded-list is a
privilege policy that silently diverges from the migrations, and the durable fix
is for the reset to stop re-granting by hand. That file was outside this change.

---

## 7. The schema, and what is immutable in it

The same line 0002 drew across `webhook_inbox`, drawn again: **what we sent is
a fact; what we are doing about it is processing state.**

| table | immutable | may change |
| --- | --- | --- |
| `outbound_event` | everything — it is the signed bytes | nothing. `UPDATE` and `DELETE` both raise. |
| `outbound_attempt` | everything | nothing. A delivery log that can be edited is not a log. |
| `outbound_delivery` | `event_id`, `endpoint_id`, `created_at`; `delivered` and `dead` are terminal; `attempts` only climbs | the retry counters, the lease, the last response |
| `outbound_endpoint_secret` | the material, once inserted | `retired_at`, once, `NULL` → timestamp |
| `outbound_endpoint` | `url`, `business_id`, `created_at` | `status`, `description`, `event_types` |
| `outbound_cursor` | — | `last_sequence`, **forwards only** |

Two of those are load-bearing rather than tidy:

**The endpoint URL is immutable.** Editing it in place would move every
historical delivery in the log onto a destination that never received it — and,
the reason it is a trigger rather than a review comment, it would be a way to
point a *validated* endpoint at an internal address after the SSRF checks ran.
A new destination is a new endpoint, with new checks and a new secret.

**A dead letter cannot un-dead-letter itself.** `dead` → `pending` raises, and
`corgi_app` has no privilege to do it anyway. Requeuing is an **owner**
operation, deliberately: it is an ops decision taken after a bug is fixed, and
the difference between "an operator requeued it" and "the app requeued it" is
the difference between a decision and a loop.

The cursor is seeded at the ledger head rather than at zero. 2,823 entries were
already on this book; starting at zero would fan thousands of historical events
at the first endpoint anybody registers. A backfill is a separate, deliberate,
bounded operation (`generateEvents({ backfillFrom })`, which never moves the
watermark) — plus a five-event `backfillEndpoint()` on registration, so the
first delivery is visible while the customer is still looking at the screen.

### Proven, not asserted

Every guard above was made to fail on purpose against this database, in a
transaction that was rolled back, before the migration was applied:

```
refused: http:// endpoint            -> violates check constraint "outbound_endpoint_https"
refused: UPDATE endpoint url         -> an endpoint URL is immutable; register a new endpoint instead
refused: DELETE endpoint             -> an endpoint is disabled, never deleted: its delivery log must survive it
refused: cursor backwards            -> the outbound cursor only moves forwards (3002 -> 0)
refused: UPDATE outbound_event       -> outbound_event is immutable: the signed bytes may never change
refused: duplicate outbound_event    -> duplicate key value violates "outbound_event_source_key"
refused: duplicate delivery          -> duplicate key value violates "outbound_delivery_once"
refused: attempts going backwards    -> outbound_delivery.attempts may only climb
refused: undelivering a delivered row-> a delivered webhook cannot be undelivered
refused: UPDATE outbound_attempt     -> outbound_attempt is append-only: a delivery log that can be edited is not a log
secret columns in v_outbound_delivery: []
```

---

## 8. Known gaps, stated before someone finds them

1. **Latency is a cron period.** There is no post-commit nudge, because adding
   one means editing route handlers owned by other workers. §1 names the exact
   change and why it must be `after()` and never `await`.

2. **`/events` is not in the console nav.**
   `src/components/app-shell/NavLinks.tsx` was outside this change's remit. The
   screen is reached by URL; adding it is one line for whoever owns that file.

3. **The cron route does not exist yet.** `drainOutbound()` is written, tested
   and driven by the "Drain now" button, but `src/app/api/**` was outside the
   write list, so nothing ticks it on a schedule. The route is four lines —
   the inbound `/api/drain` is the template — and `vercel.json` needs one entry.
   Until then the queue drains when somebody presses the button. **This is the
   one thing that stops the feature being finished**, and it is deliberately
   not worked around with a background timer, which would be a delivery
   mechanism that exists only while one process happens to be alive.

4. **One event per (journal entry, business).** An entry touching two
   businesses emits two events, correctly. An entry touching none — a
   house-only posting such as interchange income — emits nothing, which is
   right, but it means `sequence` has gaps and a customer must not read a gap
   as a lost event. Said in §4; not said in the payload.

5. **No customer-facing API for endpoint management.** Registration is a
   console action. A real product puts it behind `POST /api/v1/webhook_endpoints`
   with the same one-time reveal — `src/lib/api/**` was outside the write list.

6. **Delivery is sequential within a batch.** Bounded and easy to reason about,
   but one slow endpoint slows its batch. The throughput knob is `batchSize`
   plus more frequent ticks, not concurrency, until measured — the same call
   `dispatchOnce` makes, for the same reason. **What that costs is now
   bounded**: a single attempt can no longer fail to settle (§5, "The bound that
   was written down and did not hold"), so the worst a hostile endpoint can buy
   is `timeoutMs + 2 s` of one worker, once, and then a dead letter. Before that
   fix, sequential delivery plus one unsettling promise was a permanent stop.

7. **The retry budget is per delivery, not per endpoint.** An endpoint that has
   been down for a day dead-letters every event independently rather than being
   circuit-broken. Correct but noisy; a real product disables an endpoint after
   N consecutive dead letters, which is what Lithic does to us after five days.

8. **`resolvePublicAddress` runs twice on the delivery path** — once at
   registration, once per attempt. That is deliberate (DNS changes) and it
   costs a lookup per attempt, uncached. If that ever matters, cache per `kid`-
   style by hostname with a short TTL, and remember why Plaid's own sample
   caching one key globally was wrong.
