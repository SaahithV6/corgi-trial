# The webhook ingestion layer

Four providers send us events. This directory is the one door they come through
and the one queue they come out of.

| file | what it is |
| --- | --- |
| `rawbody.ts` | Read the body as bytes, before anything parses it. The footgun, and its guard rails. |
| `inbox.ts` | Verifiers (one per provider, registered by name), the inbox store, and `ingestWebhook`. |
| `dispatch.ts` | The dispatcher: claim, hand to a consumer, park / retry / dead-letter. |
| `../../../db/migrations/0002_webhook_inbox.sql` | The table, its indexes, its constraints, and the guard trigger. |

The pipeline, end to end:

```
provider POST
    │
    ▼  await req.text()                 raw bytes, before any parse
    ▼  verifier.verify(raw, headers)    401 and no row if this fails
    ▼  JSON.parse(raw)                  only now
    ▼  INSERT ... ON CONFLICT DO NOTHING
webhook_inbox     UNIQUE (provider, provider_event_id)   <- replay dies here
    │
    ▼  return 202                       nothing has been processed yet
    ┊
    ▼  dispatchOnce()                   cron / queue, out of band
consumer.handle(event)  ->  processed | ignored | parked | throw
```

---

## 1. The raw body, and the mistake everyone makes once

**Every provider signs the bytes it sent, not the JSON value those bytes
denote.** `JSON.parse` followed by `JSON.stringify` is not the identity
function. Measured, not asserted — the canonical Standard Webhooks vector,
which Lithic prints in its own documentation:

```
raw bytes            {"test": 2432232314}   ->  v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=
JSON.stringify(...)  {"test":2432232314}    ->  v1,Vif40peJBP7Iyl0XGmu61n4MwdrcHov5CFREBpE0svs=
```

One space. Completely different signature. The failure mode is that *every*
genuine delivery is rejected and it looks like a secret problem, so the fix
people reach for is rotating the secret, which does nothing.

In the Next.js App Router the request body is a one-shot stream. Once
`await req.json()` has consumed it the bytes are gone and cannot be recovered
later in the handler — there is no way to repair this downstream, which is why
reading the text is the first statement in the route:

```ts
const { raw, headers } = await readRawDelivery(req);   // await req.text()
const outcome = await verifier.verify({ raw, headers, now });
const payload = parseVerifiedJson(raw);                // ONLY after verifying
```

`parseVerifiedJson` is named the way it is on purpose: if you are calling it
before verifying, the name is telling you so.

Two more things that fall out of the same rule:

- Plaid's `request_body_sha256` claim is a hash of the raw bytes, and their docs
  warn that it "is sensitive to the whitespace in the webhook body". Same trap,
  different mechanism.
- Persona says it out loud: *"JavaScript may round floats and reduce precision.
  We recommend using the raw request body when computing the HMAC."*

`rawbody.test.ts` demonstrates the round-trip divergence rather than describing
it, and `inbox.test.ts` has a verifier test that rejects the re-serialised body.

**Runtime.** These modules use `node:crypto` (HMAC, `timingSafeEqual`, ES256
verification from a JWK), so every webhook route must declare
`export const runtime = "nodejs"`. The Edge runtime has no `node:crypto`.

---

## 2. Replay is a no-op at the database

`webhook_inbox` has `UNIQUE (provider, provider_event_id)`. Ingestion is a
single statement:

```sql
insert into webhook_inbox (...) values (...)
on conflict (provider, provider_event_id) do nothing
returning id
```

and **the row count that statement returns is the decision**. One row means
first delivery; zero rows means Postgres has seen this event before and did
nothing. There is no `SELECT` first, because a select-then-insert has a race
between its two statements and this has none, and there is no `if` in
application code that could be wrong.

Both outcomes are 2xx. A replay is not an error — it is the provider doing
exactly what its documentation says it does. Lithic retries eight times on any
non-2xx, Plaid retries for 24 hours, Persona retries seven times. Answering
`409` to a replay only produces more replays.

The event ids, per provider:

| provider | `provider_event_id` | stable across retries? |
| --- | --- | --- |
| lithic | the `webhook-id` header (Lithic documents it as equal to `event.token`) | yes |
| increase | the Event object's own `id` (`event_123abc`), falling back to `webhook-id` | yes |
| persona | `data.id` (`evt_…`) | yes |
| stripe | the event `id` (`evt_…`) | yes |
| plaid | `sha256:<hex of the raw body>` | yes |

Plaid ships **no event id of any kind**. The dedupe key is therefore the hash of
the bytes Plaid itself signed in `request_body_sha256`, which is stable across
their retries. The cost, stated plainly: two genuinely distinct Plaid webhooks
with byte-identical bodies collapse into one row. That is acceptable *only*
because every Plaid webhook is a "something changed, come and re-read it"
notification whose consumer re-fetches from the API — processing it once or
twice reaches the same state. It would not be acceptable for an event carrying
an amount, and if we ever take money instructions from Plaid this has to change.

`inbox.test.ts` asserts the property both ways: against the in-memory store, and
— when `WEBHOOK_INBOX_TEST_DATABASE_URL` is set — against real Postgres with
the actual migrations applied, which is the authoritative version.

---

## 3. Verify, persist, ack fast, process async

`ingestWebhook` verifies, persists, and returns. It cannot process anything:
there is no code path in `inbox.ts` that could apply an effect even if a caller
wanted it to. The work happens in `dispatch.ts`, driven by cron.

Why it matters, per provider:

- **Plaid**: 2xx within **10 seconds** or it is a failure, then retries with
  exponential backoff for **24 hours**. A serverless cold start plus a Postgres
  round trip already flirts with that budget; a ledger write inside the handler
  would blow it.
- **Persona**: **5 seconds**, then up to 7 retries.
- **Lithic / Increase**: Standard Webhooks; retries on any non-2xx, and Lithic
  auto-disables a subscription that fails continuously for five days.

A route handler in full:

```ts
// src/app/api/webhooks/lithic/route.ts
export const runtime = "nodejs";        // node:crypto
export const dynamic = "force-dynamic"; // never cached, never prerendered

import { after } from "next/server";
import { ingestWebhook } from "@/lib/webhooks/inbox";
import { dispatchOnce } from "@/lib/webhooks/dispatch";
import { inboxStore } from "@/lib/webhooks/wiring"; // your app's singleton

export async function POST(req: Request) {
  const result = await ingestWebhook("lithic", req, { store: inboxStore });

  if (result.status === "rejected") {
    return new Response(null, { status: result.httpStatus });
  }

  // Optional nudge so the demo feels instant. NOT the delivery mechanism:
  // the cron below is, and this is allowed to be dropped at any time.
  after(() => dispatchOnce({ store: inboxStore, batchSize: 5 }));

  return new Response(null, { status: result.httpStatus }); // 202, or 200 on replay
}
```

and the cron that actually drives it:

```ts
// src/app/api/cron/dispatch/route.ts
export const runtime = "nodejs";

import { dispatchUntilIdle } from "@/lib/webhooks/dispatch";
import { inboxStore } from "@/lib/webhooks/wiring";

export async function GET() {
  const summary = await dispatchUntilIdle({ store: inboxStore, maxBatches: 20 });
  return Response.json(summary);
}
```

Status codes: `202` accepted, `200` replay, `401` signature failed (nothing
persisted — an unauthenticated body is not evidence of anything, and storing it
would let anyone who can reach the URL fill the inbox), `404` no verifier
registered for that provider, `400` verified but unusable.

The one deliberate oddity: a body whose **signature verified** but which will not
parse as JSON is filed `dead` on arrival with its raw bytes and answered `202`,
provided the provider put an id in a header. Those bytes really did come from
the provider, so throwing them away is throwing away evidence — and a retry
cannot fix a body that will never parse, so making the provider retry is worse
than useless.

---

## 4. Out-of-order delivery, and the parked state

**The dispatcher makes no ordering promise at all**, so no consumer can come to
depend on one. Persona says it in their docs ("Events are not ordered");
everyone else means it. Consumers are expected to be idempotent and, where the
domain allows, commutative — the card model in `DESIGN.md` §8 computes hold as a
function of an event *set*, so for card there is no ordering to be out of.

Where a consumer genuinely cannot proceed — the event references an entity that
does not exist yet — it returns `parked(kind, ref)`. Three sentences:

1. The row moves to state `parked` with the referent it is waiting for recorded
   on it as `(parked_on_kind, parked_on_ref)` in the consumer's own vocabulary,
   so parking is a state with a named cause rather than a silent drop or a
   crash — and a check constraint refuses a park with no referent, because that
   would be a queue nothing could ever drain.
2. It is woken two ways: immediately, when any consumer reports having created
   that entity (`processed([{ kind, ref }])` → one `UPDATE` moves every row
   waiting on it back to `pending`), and independently on its own exponential
   re-check timer, so a park is never load-bearing on some other event turning up.
3. Parks are counted separately from failures, so waiting does not spend the
   retry budget; but they are still bounded — after `maxParkAttempts` the row is
   dead-lettered with "referent never arrived", because an event waiting five
   hours for an authorisation is a missing event, not a late one.

The four states are `pending`, `parked`, `done`, `dead`. A claimed row stays
`pending` and carries a `locked_until` lease: a lease is a timeout, not a state,
so a worker that dies releases its work by doing nothing at all.

---

## 5. Bounded retry and the dead letter

| knob | default | why that number |
| --- | --- | --- |
| `maxFailedAttempts` | 8 | Lithic's own schedule is 8 attempts. If the provider gives up after eight, so do we. |
| `baseDelayMs` → `maxDelayMs` | 5s doubling, capped at 1h | Roughly the shape of every provider's own backoff. |
| `maxParkAttempts` | 12 | 30s doubling to a 1h cap ≈ 5 hours of waiting for a referent. |
| `jitter` | 0.2 | So a burst of failures does not retry in lockstep for ever. |

`attempts` is incremented **when the dispatcher claims the row, not when it
fails**. That is the whole poison-message defence: a worker that dies mid-event
has still spent an attempt, so an event that reliably kills workers cannot loop
for ever. A park is not a failure, so the retry budget is
`attempts - park_attempts` — one subtraction, two independent caps.

Past either cap the row lands in `dead`, visible to staff through
`v_webhook_dead_letter` (a view, so it cannot go stale). `dead` is not a grave:
`requeueDeadLetter` puts a row back in the queue with the counters reset, which
is the correct ops action after the bug is fixed. `done` *is* terminal, enforced
by the guard trigger.

Nothing anywhere retries without a bound.

---

## 6. Provider-agnostic

One inbox, one dispatcher, two registries keyed by provider name:

```ts
// src/lib/webhooks/wiring.ts  (application wiring, not part of this directory)
verifiers
  .register(lithicVerifier({ secret: env.LITHIC_WEBHOOK_SECRET }))
  .register(increaseVerifier({ secret: env.INCREASE_WEBHOOK_SECRET }))
  .register(personaVerifier({ secret: env.PERSONA_WEBHOOK_SECRET }))
  .register(plaidVerifier({
    fetchVerificationKey: cachedVerificationKeys(fetchPlaidKey),
    expectedEnvironment: "sandbox",
  }));

consumers
  .register(cardConsumer)
  .register(achConsumer)
  .register(kybConsumer)
  .register(fundingConsumer);
```

`dispatch.ts` contains no provider name, no event type and no ledger
vocabulary. Adding a fifth provider is two `register` calls and a route file;
nothing in the dispatcher moves, and nothing in the database moves either —
which is why `provider` is a plain `text` column and not an enum, while `state`
(which is ours) *is* an enum.

That claim is tested rather than asserted: `stripeVerifier` is a real fifth
provider added for the business-registry leg, and `dispatch.test.ts` dispatches
a provider called `acme-bank` that exists nowhere else in the repo.

Both registries refuse a second registration for the same provider unless you
pass `{ replace: true }`. Silent last-wins registration is how two people ship
two verifiers for one provider and nobody notices which is live.

### The four signature schemes

| provider | header(s) | algorithm | signed string | replay window |
| --- | --- | --- | --- | --- |
| lithic | `webhook-id`, `webhook-timestamp`, `webhook-signature` | HMAC-SHA256 → base64, key = base64-decode(secret minus `whsec_`) | `{id}.{timestamp}.{raw}` | ±300s (spec) |
| increase | same three | HMAC-SHA256 → base64, key = the shared secret's **raw bytes** | `{id}.{timestamp}.{raw}` | ±300s (our policy; Increase recommends 5 min) |
| persona | `Persona-Signature` | HMAC-SHA256 → hex | `{t}.{raw}` | ±300s — **ours**, see below |
| plaid | `Plaid-Verification` | ES256 JWT + `request_body_sha256` | n/a (hash of raw) | `iat` within 300s |
| stripe | `Stripe-Signature` | HMAC-SHA256 → hex | `{t}.{raw}` | ±300s (documented) |

Details that are easy to get wrong and are therefore explicit arguments in the
code rather than guesses:

- **Lithic vs Increase key handling differs.** Standard Webhooks says the key is
  the base64-decoded secret body; Increase's own reference implementation passes
  the `shared_secret` string straight to HMAC. Getting this wrong rejects every
  real delivery, so `secretEncoding` is a required parameter with no default.
- **Rotation.** All of these can carry more than one signature while a secret
  rotates. Lithic/Increase space-separate `v1,<sig>` entries; Persona
  space-separates whole `t=…,v1=…` groups; Stripe comma-separates several `v1=`
  inside one group. Splitting on spaces first and commas second parses all three,
  and each signature is checked against the timestamp of its own group.
- **Persona publishes no tolerance at all** and checks none in its own sample, so
  its scheme has no built-in replay protection. The 300s window is *our* policy,
  not a Persona number — say so if asked.
- **Plaid's six steps are all mandatory.** In particular `alg` must be pinned to
  `ES256` (the algorithm-confusion defence: an attacker sending `alg: "none"` has
  to fail), and keys are cached **per `kid`** — Plaid's own published sample
  caches one key globally, which breaks on their first rotation.
- Comparisons are constant-time. `timingSafeEqual` throws on a length mismatch,
  and letting that exception escape differently from a mismatch is itself an
  oracle, so both sides are hashed to a fixed 32 bytes first.

### Note for the Lithic worker

`src/lib/rails/lithic/verify.ts` is a self-contained Standard Webhooks verifier
and it is **superseded by `lithicVerifier` here**. Two verifiers for one provider
is exactly the situation the registry refuses at runtime, and having two also
means two places to fix a bug. The generic path wins because Increase needs the
same algorithm with a different key encoding, and because the registry is what
makes requirement 6 true. That file should be deleted (its test vector is
already reproduced in `inbox.test.ts`); the coordinator is doing it, not me.

---

## 7. Wiring the store

`inbox.ts` talks to Postgres through a two-method port (`SqlExecutor`) rather
than through Drizzle. That is deliberate and narrow: the entire design lives in
three statements — `ON CONFLICT DO NOTHING` with a row count, `FOR UPDATE SKIP
LOCKED` with a lease, and an `unnest` join for the unpark — and those need to be
readable line by line, not generated. Everything else about the row is ordinary.

```ts
import postgres from "postgres";
import { createPostgresInboxStore, sqlExecutorFromPostgresJs } from "@/lib/webhooks/inbox";

const sql = postgres(env.DATABASE_URL);
export const inboxStore = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));
```

`createMemoryInboxStore()` is a **test double**, not a second implementation.
Its only contract is to mirror the constraints the migration declares — above
all the unique index. The Postgres-backed test is the authoritative one.

### Testing

```bash
pnpm test                                     # in-memory: fast, no database
WEBHOOK_INBOX_TEST_DATABASE_URL=… pnpm test   # also applies 0001+0002 and proves the unique index
```

The second form drops and recreates the `public` schema, so point it at a
throwaway database and never at anything real.

---

## 8. What the table stores, and what it deliberately does not

`0002_webhook_inbox.sql` finishes the table `0001_ledger.sql` creates (0001 has
to create it because `journal_entry.inbox_id` references it). It adds
`raw_body`, `headers`, `signature_verified_at`, the four-state machine, the
retry counters and the parked-referent columns; replaces the poll index; extends
the guard trigger and the column-level `UPDATE` grant; and adds the two staff
views.

- **`raw_body` is kept forever**, so any signature can be re-verified years later
  and a re-serialisation bug can be proven rather than argued about.
- **`headers` is an allowlist** of the signature-bearing headers only. This row
  is kept for years and must never become a credential store.
- **`signature_verified_at`, not `signature_verified`.** A row only exists here
  because verification passed, so the useful fact is *when* we checked. A boolean
  that can be false invites a code path that reads it and carries on anyway.
  0001's boolean column is dropped by 0002 for that reason.
- **No money column, deliberately.** Amounts belong to the adapter's output and
  to `journal_line`, in signed `bigint` cents. A copy here would be a second,
  unreconciled place where a figure lives. If one is ever added it is `bigint`
  cents — never `numeric`, never `float`.
- **Immutable facts, mutable processing state.** The guard trigger pins
  `provider`, `provider_event_id`, `payload`, `event_type`, `raw_body`,
  `headers`, `received_at` and `signature_verified_at`; keeps `processed_at` a
  one-way door; makes `done` terminal; and lets the attempt counters climb only
  (the single exception being the dead-letter requeue, which zeroes both). That
  is DESIGN.md §4's line, drawn in the database rather than in a code review.

---

## 9. Known gaps, stated before someone finds them

1. **The migration has not been applied to a live database yet.** No Postgres was
   reachable from the machine it was written on. Run `pnpm migrate` against the
   Neon branch before trusting it, and run the test with
   `WEBHOOK_INBOX_TEST_DATABASE_URL` set — that test applies both migrations, so
   it is also a syntax check.
2. **Plaid's dedupe key collapses byte-identical bodies** (§2). Correct for
   notification-shaped webhooks, wrong for money-shaped ones.
3. **`dispatchOnce` processes a batch sequentially.** Bounded and easy to reason
   about, but one slow consumer slows its batch; the throughput knob is
   `batchSize` plus more frequent cron ticks, not concurrency, until measured.
4. **The inbox guarantees an event is *stored* once, not *handled* once.** A
   process can die between applying an effect and marking the row done, so the
   effect is retried. That is why every consumer must be idempotent, and why the
   ledger keeps its own idempotency keys derived from `provider_event_id`
   (DESIGN.md §11) as the last line of defence. Exactly-once delivery does not
   exist; exactly-once *state* does, and it is bought in the consumer.
