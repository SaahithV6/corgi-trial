# The webhook HTTP surface

One route file for five providers, and one page that says what it answers and
why.

```
src/app/api/webhooks/[provider]/route.ts   the route: segment config + two lines
src/lib/webhooks/route-handler.ts          wiring, the status table, the log line
src/lib/webhooks/route-handler.test.ts     the status table, as tests
src/app/api/health/route.ts                what proves the deployment is up
```

`src/lib/webhooks/README.md` is the ingestion layer underneath this one —
verifiers, the inbox table, replay, the dispatcher. This page is only about the
HTTP edge.

---

## 1. The route table

| method | path | answers |
| --- | --- | --- |
| POST | `/api/webhooks/lithic` | card authorisations and clearings |
| POST | `/api/webhooks/persona` | KYB / KYC inquiry and case status |
| POST | `/api/webhooks/plaid` | open-banking item and funding notifications |
| POST | `/api/webhooks/increase` | ACH transfer lifecycle and returns |
| POST | `/api/webhooks/stripe` | business-registry leg (the fifth provider) |
| GET | `/api/webhooks/{provider}` | `405` with `Allow: POST` and the provider list |
| GET | `/api/health` | `200`, always — build, database, integrations |

There is **one** route file: `[provider]/route.ts`. The provider is the path
segment, and it is validated against the *verifier registry* — a `Map` lookup,
not a string comparison against a list somebody has to remember to update. A
sixth provider is one entry in `WEBHOOK_INTEGRATIONS` and a consumer
registration; no new route file, no migration (`provider` is a text column, not
an enum).

## 2. The order is load-bearing

```
await req.text()                  raw bytes, before anything parses them
verifier.verify(raw, headers)     over those exact bytes
parseVerifiedJson(raw)            ONLY now
insert ... on conflict do nothing
return 2xx
```

Every provider signs **the bytes it sent**, not the JSON value those bytes
denote, and `JSON.parse` followed by `JSON.stringify` is not the identity
function. One space of difference produces a completely different signature, so
a handler that re-serialises rejects every genuine delivery — and the failure
looks like "their signatures are broken", which sends you rotating a secret that
was never wrong.

**How this route makes the order impossible to get wrong.** The handler body is
a single call to `ingestWebhook`, which owns all four steps. The route never
calls `req.json()`, and it *cannot* usefully do so afterwards: the request body
is a one-shot stream, so once `ingestWebhook` has read it the bytes are gone.
The ordering is not protected by a comment or a code review — it is protected by
there being exactly one call site and nothing left to parse after it.
`route-handler.test.ts` passes a request whose `json()` throws, so if any of
this ever changes, every test in the file fails at once.

## 3. Failure semantics

Every response — success or failure — carries the request id in the body and in
the `x-request-id` header, and is `cache-control: no-store`.

| what happened | status | body `error.code` | persisted? | why that code |
| --- | --- | --- | --- | --- |
| valid, first delivery | **202** | — | yes, `pending` | Accepted, not processed. Dispatch is out of band, so `200 OK` would overstate what has happened. |
| **duplicate delivery** | **200** | — | no (unique index refused it) | **Never 409.** A provider that gets a 4xx on a replay retries the replay — for ever. The body says `"replay": true` and names the row that already exists. |
| **bad signature** | **401** | `WEBHOOK_SIGNATURE_INVALID` | **no** | An unauthenticated body is not evidence of anything, and storing it would let anyone who can reach the URL fill the inbox. The response says *that* verification failed, never *why*: "timestamp too old" versus "no v1 signature matched" is free information for someone probing the endpoint. The reason goes to the log. |
| stale timestamp | **401** | `WEBHOOK_SIGNATURE_INVALID` | no | A replayed old delivery is a failed verification, not a different class of event. ±300s. |
| **unknown provider** | **404** | `UNKNOWN_PROVIDER` | no | No verifier means no way to authenticate the caller, so there is nothing to do with the bytes. Resolved by a `Map` lookup before anything is constructed, which is why it can never become a 500 — tested with a deliberately broken store. |
| known provider, credentials missing | **503** | `WEBHOOK_PROVIDER_NOT_CONFIGURED` | no | See §4. |
| **verified but not JSON** | **400** | `WEBHOOK_BODY_UNPARSEABLE` | yes, filed `dead` | Should be impossible: it means the provider signed bytes that are not JSON. The bytes are kept as evidence — they really did come from the provider — but the request is malformed and no retry can fix it. See §5. |
| verified, unusable (no event id; wrong Plaid environment) | **400** | `WEBHOOK_BODY_UNUSABLE` | no | Past verification the caller *is* the provider, so the reason is safe and useful to hand back. |
| **inbox write failed** | **500** | `WEBHOOK_INBOX_UNAVAILABLE` | no | We have accepted responsibility for nothing. 500 is the only honest answer, and it is the one that makes the provider retry. The driver's message stays in the log; the response says nothing about our database. |

### Return 2xx fast, process later

Verify, persist, return. Nothing else. **No dispatch inline, and deliberately no
`after()` nudge either** — a nudge that usually runs is a delivery mechanism
people start to rely on, and then it is load-bearing without being on the
diagram. Processing is `dispatchOnce()` from cron.

The budgets this is protecting, per provider:

- **Plaid**: 2xx within **10 seconds**, or the delivery has failed and Plaid
  retries with backoff for **24 hours**. A cold start plus a Postgres round trip
  already spends part of that; a ledger write inside the handler would blow it.
- **Persona**: **5 seconds**, then up to 7 retries.
- **Lithic / Increase**: retry on any non-2xx; Lithic auto-disables a
  subscription that fails continuously for five days.

## 4. Why a missing secret is 503 and not 404

A provider in the catalogue whose verification credentials are absent gets no
verifier, so the route cannot authenticate its deliveries and must not accept
them. It answers **503**, not 404, because the two say different things to the
sender:

- `404` means *this endpoint does not exist* — a well-behaved provider stops,
  and the event is gone.
- `503` means *not now, try again* — the delivery survives a deploy that forgot
  a secret, which is the actual failure this models.

Either way it is never a 500: nothing threw. This is a configuration fact we
know and can state. `/api/health` says the same thing at the same moment:
`webhookVerifierRegistered: false`, with the missing env var named.

## 5. Where this diverges from `src/lib/webhooks/README.md`

One deliberate difference, called out rather than buried.

A body whose **signature verified** but which will not parse as JSON is filed
`dead` on arrival by `ingestWebhook`, which suggests **202** — its reasoning is
that a retry cannot fix a body that will never parse, so making the provider
retry is worse than useless.

This route answers **400**. The row is still filed with its raw bytes either
way; only the status code differs. The reasoning: the request genuinely is
malformed, and a 2xx tells the sender everything was fine when it was not. The
cost is bounded — Lithic gives up after 8 attempts, and every retry lands on the
unique index rather than a second row.

The case should never happen. If it does, the row is on the dead-letter screen
with the exact bytes to argue about.

## 6. Runtime: Node, not Edge, and never cached

```ts
export const runtime = 'nodejs';        // node:crypto — see below
export const dynamic = 'force-dynamic'; // never prerendered, never cached
```

**`nodejs` is not optional.** Signature verification is `node:crypto`:
`createHmac` and `timingSafeEqual` for Lithic, Increase, Persona and Stripe;
`createPublicKey` plus `verify` for Plaid's ES256 JWT. The Edge runtime has no
`node:crypto`. Pinned explicitly rather than inherited from a default, because
on Edge this would not fail at build time — it would fail at the first real
delivery, which is the worst possible moment to find out.

**`force-dynamic`** because a webhook is a side effect delivered by POST. A
cached or prerendered response would acknowledge a delivery that was never
stored, and the provider would never send it again.

## 7. Logging

One structured line per request, whatever happened, at `info` for 2xx, `warn`
for 4xx and `error` for 5xx:

```json
{"ts":"2026-09-10T01:41:48.730Z","level":"warn","event":"webhook.request",
 "requestId":"req_f433642aa83e4f...","route":"POST /api/webhooks/[provider]",
 "provider":"lithic","eventId":null,"verified":false,
 "outcome":"signature_invalid","httpStatus":401,"durationMs":7,
 "reason":"timestamp too old (174739178s > 300s)"}
```

`provider`, `eventId` (when known), `verified`, `outcome`, `httpStatus` and
`durationMs`, always. `reason` is present on failures — this is the line that
carries what the response deliberately withholds from an unauthenticated
caller. The logger redacts secret-shaped keys, so a raw body never reaches a log
drain by accident.

`outcome` is a closed set: `accepted`, `replay`, `unparseable`,
`signature_invalid`, `unusable`, `unknown_provider`, `not_configured`,
`inbox_unavailable`.

## 8. `/api/health`

`GET /api/health` returns **200 always** — including when the database is
down, when the environment is invalid, and when nothing is configured. A monitor
that receives a 500 from the health endpoint has learned only that the health
endpoint is broken. The status code says "the process is answering"; the body
says how well.

```json
{
  "requestId": "req_3b64cf16...",
  "status": "ok",
  "checkedAt": "2026-09-10T01:40:30.400Z",
  "commit": { "sha": null, "source": null, "note": "no commit sha in the environment (looked for VERCEL_GIT_COMMIT_SHA, ...)" },
  "runtime": { "node": "v26.7.0", "nodeEnv": "development", "uptimeSeconds": 8 },
  "database": { "urlEnv": "APP_DATABASE_URL", "timeoutMs": 3000, "reachable": true, "latencyMs": 73 },
  "integrations": {
    "live": 2, "total": 7,
    "slots":    [ { "slot": "card_issuing", "provider": "Lithic sandbox", "status": "live", "mustBeLive": true, "missing": [] }, "..." ],
    "webhooks": [ { "provider": "lithic", "status": "live", "webhookPath": "/api/webhooks/lithic", "webhookVerifierRegistered": true, "missingEnv": [] }, "..." ],
    "warnings": [ { "slot": "director_kyc", "message": "director_kyc must be live for the trial but is simulated", "missingEnv": ["PERSONA_API_KEY"] } ]
  },
  "durationMs": 1780
}
```

**Commit sha** comes from the platform's environment —
`VERCEL_GIT_COMMIT_SHA` first, then five other conventions. Absent locally, and
the body says so and names what it looked for rather than inventing a value or
shelling out to `git` from inside a serverless function.

**Database** is a real `select 1` round trip as the restricted `corgi_app`
role — `APP_DATABASE_URL`, never `DATABASE_URL`. A health check that proves the
*owner* connection works has proved the wrong thing (DECISIONS 008). The probe
has a 3s hard timeout: measured against this Neon branch at 1,775ms cold,
692ms next, 69-73ms warm, so a 1s budget would report `degraded` every time the
compute woke up and train whoever reads this to ignore it. On failure the body
carries `reachable: false` and the reason, and the status code stays 200 with
`status: "degraded"`.

**Integrations are not computed here.** `INTEGRATION_SLOTS` in
`src/lib/env.schema.ts` is the one place the live-vs-simulated decision is made
for the whole system, and this endpoint renders its verdicts. The webhook rows
add exactly one fact that table does not know: whether a verifier is registered,
which is what decides 503 versus a real answer on the route. A provider cannot
be `live` here and `simulated` there, because there is only one decision.

**A missing API key is `not_configured`, never `live`.** There is no path
through this code by which it could be otherwise: `live` requires every owning
slot to be live *and* a verifier registered, and both an absent variable and one
set to the empty string count as missing (a dashboard where someone added the
key and left the value blank produces `""`, and an operator staring at it
believes it is unset). Env var **names** are reported; values never are.
`warnings` lists the slots the brief requires to be genuinely live that are not,
so that a simulated integration cannot be quietly presented as a live one.

## 9. What is tested, and what was checked live

`route-handler.test.ts` — 26 tests, in-memory inbox store, real signature
schemes (the canonical Standard Webhooks vector, so the verifier is
byte-compatible with Lithic's rather than merely self-consistent):

- valid signature → 202, and the row's `rawBody` is the exact bytes received
- **tampered body → 401 and the store is never called** — asserted on a store
  that counts writes, not merely on the status code
- the same payload re-serialised → 401 (the footgun, as a status code)
- stale timestamp → 401, nothing stored
- unknown provider → 404, still 404 with a deliberately broken store
- duplicate delivery → 200, `replay: true`, exactly one row
- verified-but-unparseable → 400, filed `dead` with its bytes
- inbox failure → 500, driver message not leaked
- the handler never calls `req.json()`
- integration status is never `live` without the API key, and never leaks values

Checked against a running server (`next dev`, real Neon):
`/api/health` 200 with a live `select 1`; `404` for `acme-bank`; `503` for a
provider whose secret is absent; `405` on GET; `401` for a tampered body and for
a stale timestamp with the real Lithic verifier registered; and the structured
log line above, copied from that run.

**Not checked live:** a successful `202` over HTTP, because that writes a row to
the shared Neon `webhook_inbox` that another worker is using. It is covered by
the tests, and by `inbox.test.ts` against real Postgres when
`WEBHOOK_INBOX_TEST_DATABASE_URL` is set.
