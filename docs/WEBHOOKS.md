# Refused webhooks

*The half of the webhook traffic `webhook_inbox` cannot hold.*

`src/lib/webhooks/README.md` documents the accepted path: raw bytes, signature,
inbox, dispatch, consumer. This file documents the other outcome — the delivery
we refuse — and the table that now records it.

---

## 1. The hole

`route-handler.ts` answered a forged delivery with `401` and the sentence
*"signature verification failed; nothing was stored"*, and it stored nothing.

The refusal is correct. An unauthenticated body is not evidence of anything and
must never reach the inbox; `0002_webhook_inbox.sql` says so in the comment that
replaced `signature_verified boolean` with `signature_verified_at timestamptz`
— *"a row only exists here because verification passed"*.

But it meant every rejected attempt was **absent from the system**. Only a log
line existed, and a log line is not a queryable fact. So:

> `webhook_inbox` holds only the **accepted** deliveries. Any trail, count or
> dashboard built on it **reads complete** while the entire population of
> forged, misrouted and stale attempts is invisible.

An operator asking *"is anyone hammering our webhook endpoints with bad
signatures?"* got silence, and silence is indistinguishable from safety.
`docs/AUDIT.md` §2.1 item 2 named this as one of three actions recorded nowhere.

The precedent for the fix is in the schema already. `0016_payees.sql` §2:

> A blocked candidate never becomes a payee, so the caught typo would otherwise
> leave no trace — and the caught typo is the entire point of the feature.
> `payee_candidate_refusal` is where it lands.

Same shape, same argument. The table is `webhook_refusal`
(`db/migrations/0038_webhook_refusals.sql`), named to match the precedent it
follows rather than the `webhook_rejection` sketched in `docs/AUDIT.md` §2.

---

## 2. What is recorded, and what is deliberately not

The counterparty on this path is **unauthenticated**. Every byte of a refused
delivery is chosen by whoever sent it, and the endpoint is open to the internet.
A table on the 401 path is therefore, by construction, a place where an attacker
picks what our database contains and what our screens render. Two rules follow,
and every column obeys them.

### Kept

| Column | Why it is safe, and why it is worth keeping |
| --- | --- |
| `provider`, `endpoint` | The path segment, **sanitised to `[A-Za-z0-9_-]{0,40}`** before it can reach a row, with the same regex re-asserted as a CHECK. Two copies of the rule, so it holds when the application is wrong. |
| `reason_code` | An enum **we** define. Five values, §3. |
| `source_ip` | `inet`, never `text`. **The type is the validator**: a hostile `x-forwarded-for` cannot smuggle anything through a parser that only accepts addresses. Anything else is stored as NULL. |
| `source_header` | Which forwarding header the address came from — a closed CHECK set, never a caller-invented header name — so an operator knows how much to trust it. Our edge asserting an address and the person we are about to block asserting it are not the same fact. |
| `body_sha256`, `body_bytes` | A fixed-width, 64-hex-character digest and a length. Attacker-uninfluenceable in *shape*. |
| `signature_present`, `signature_shape`, `signature_bytes` | The **shape** of the signature: scheme, how many `v1` entries, how many bytes. `swh:v1x2` is what a secret rotation looks like; a 12-byte signature header is somebody guessing. |
| `refusals`, `first_seen_at`, `last_seen_at`, `minute_bucket` | The count and the window. §4. |
| `body_varied` | One boolean: did this bucket see more than one distinct body? |

### Refused, with the argument

* **The body.** This is the whole design problem and the answer is no. A forged
  body is a document authored by an unauthenticated stranger. Storing it
  wholesale creates stored XSS, log injection and unbounded free storage in one
  column, and hands an attacker editorial control of an operator's screen. The
  **hash** answers the questions that actually get asked — *"is this the same
  forgery again?"* (compare hashes) and *"is this the delivery the provider's
  dashboard says it sent?"* (hash the replay and compare) — without ever holding
  what it said. What the hash cannot answer is *"what did the forgery claim"*.
  That is the deliberate trade, and it is the right way round: a system that
  keeps forged payloads has accepted a submission from a stranger.

* **The signature value.** Its shape is diagnostic; its bytes are not.

* **The verifier's own reason string.** This one looks safe and is not.
  `plaidVerifier` builds `unexpected alg '<attacker string>'`,
  `no verification key for kid <attacker string>` and
  `JWT signature check failed: ${String(err)}`. The reason is matched against
  our own fixed patterns to choose a reason **code** and is then dropped. It
  still goes to the structured log, which is where attacker-influenced text was
  already going and is not rendered as data.

* **The user agent**, and every other free-text header: attacker-chosen text
  with no diagnostic value `source_ip` does not carry better.

* **The request id.** `requestIdFrom` reads a caller-supplied `x-request-id`. It
  belongs in the log, not in a column an operator reads as fact.

* **Secrets.** By construction: nothing on this path touches one.

The database enforces the rules rather than trusting the writer. Proven live
against Neon as `corgi_app`:

```
REFUSED  INSERT a hostile provider segment
         → violates check constraint "webhook_refusal_provider_check"
REFUSED  INSERT a shape outside the closed grammar
         → violates check constraint "webhook_refusal_signature_shape_check"
```

---

## 3. The five reason codes

A single `invalid` bucket throws away the only thing this table is for: **a
wrong secret and an attacker are the same HTTP status and completely different
incidents.**

| `reason_code` | The operational story | Who owns it |
| --- | --- | --- |
| `unknown_provider` | A POST to a path segment we have no verifier for. No real provider sends this — a provider only ever posts to the URL we gave it. Scanning, or our own copy-paste into a provider dashboard. | security / nobody |
| `signature_absent` | The scheme's signature header is not present at all. A naive forgery, a probe, or a proxy stripping headers. | security |
| `signature_malformed` | A signature header **is** present and does not parse as this provider's scheme. **The misrouting signal**: a Stripe delivery arriving at the Lithic endpoint looks exactly like this, and so does a provider changing its scheme under us. | integrations |
| `signature_mismatch` | Well-formed, and **did not verify**. Two causes and no third: our secret is wrong (rotated in the provider's dashboard and not here — in which case *we are silently dropping real money events*), or someone is forging. `source_ip` tells you which: the provider's address means the secret, a stranger's means the stranger. **This is the one that should page somebody.** | integrations **or** security |
| `timestamp_outside_window` | Outside the ±300s replay window, or not a unix second count. Either a replayed capture — the replay defence working — or **our clock has drifted and we are now refusing genuine deliveries**, which is an outage wearing an attack's clothes. | platform |

Four of these were asked for. `signature_malformed` is the fifth, and the
shipped verifiers forced it: "a header that is present but does not parse" is
neither absent nor a mismatch, and calling it either would have hidden the one
reason that means *a provider is pointed at the wrong URL*.

**Classification reads our own prose and never stores it.**
`refusals.test.ts` pins every reason string the shipped verifiers can produce
against the code it must land in — 21 of them — so a reworded verifier fails the
suite instead of drifting into the catch-all. The catch-all is
`signature_mismatch`, the **loudest** bucket, on purpose: an unrecognised reason
reported as a forgery gets investigated, and one reported as a formatting
problem does not.

That table caught a real bug on its first run. The Standard Webhooks reason for
a missing header is `missing webhook-id / webhook-timestamp / webhook-signature`
— which contains the word *timestamp*. Testing the timestamp pattern first
reported **every unsigned delivery as a clock problem**. The order in
`classifyRefusal` is load-bearing and says so.

---

## 4. The order of operations

*Do not weaken the verification in order to observe it.* The dangerous version
of this feature is the one that reads attacker bytes earlier than it used to so
it can describe them. What was concluded, and implemented:

1. **`unknown_provider` never reads the body.** There is no verifier, so there
   is nothing that could ever authenticate those bytes, and reading them to hash
   them would mean consuming an unauthenticated stream for a telemetry field.
   Those rows carry **null** body columns.

   This is not a convention. It is a constraint:

   ```sql
   CONSTRAINT webhook_refusal_body_read_iff_there_was_a_verifier
     CHECK ((reason_code = 'unknown_provider') = (body_sha256 IS NULL))
   ```

   An edit that starts reading the body of an unroutable request cannot store
   the result. Proven live:

   ```
   REFUSED  INSERT unknown_provider WITH a body hash
            → violates check constraint
              "webhook_refusal_body_read_iff_there_was_a_verifier"
   ```

2. **For every other reason the body has already been read**, by
   `ingestWebhook`, at exactly the point it always read it: step 1, *before*
   verification, because you cannot verify a signature over bytes you have not
   read. Nothing here moves that read one instruction earlier.

3. **The probe is a tee, not a second read.** `probeBody(req)` hands
   `ingestWebhook` a request whose `text()` delegates to the real one and takes
   a SHA-256 and a byte count on the way past. The body is a one-shot stream —
   reading it twice is *impossible*, which is what makes this safe rather than a
   promise to behave. No parse, no branch on content, no reference to the bytes
   kept after the digest.

4. **Computed before authentication, persisted only after refusal.** What must
   not happen before a signature check is *parsing*, *persisting verbatim*,
   *dispatching*, or letting content steer control flow. A fixed-width hash of
   bytes we were always going to hold in memory for the length of an HMAC is
   none of those.

The refusal is still a refusal: nothing ingested, no consumer run, 401 returned,
raw body never parsed before the signature check. `route-handler.test.ts` hands
the handler a request whose `json()` **throws**; it passes unchanged through the
probe, which is the proof the wrapper did not become a second reader.

One wording change: the 401 body now says *"the payload was not ingested"*
rather than *"nothing was stored"*, because the second sentence stopped being
true the moment this table existed. The reason itself is still withheld from the
caller — `timestamp too old` versus `no v1 signature matched` is free
intelligence for someone probing the endpoint — and goes to the log beside the
reason code, so a log line can be joined to a row.

**`503 not_configured` is deliberately not a refusal.** A known provider whose
secret is missing is a fact about our deployment, not about whoever knocked. It
is already published by name in `/api/health` as
`integrations[].status = 'not_configured'` with the missing env var names beside
it. Filing it here too would let a stranger inflate our refusal rate by POSTing
at an endpoint whose secret we forgot to set, and would put one fact in two
places with two owners.

---

## 5. How the write is bounded

An unauthenticated endpoint that writes a row per request is free storage for
whoever finds the URL. **The write amplification is the attack.** Two bounds:

### Bound 1 — aggregation

A row is a **bucket**: `(provider, reason_code, source_ip, minute)`, carrying a
count, a window and an exemplar. Ten thousand forgeries from one address in one
minute are one row saying `10000`. The unique index is the decision and
`ON CONFLICT DO UPDATE` is the mechanism — the same construction the inbox uses
for replay, for the same reason: a SELECT-then-INSERT has a race and this has
none.

**What it loses:** `body_sha256`, `body_bytes` and `signature_shape` describe
the **first** request in the bucket. Requests 2..N contribute to the count and
to `body_varied` and are not individually described. `body_varied` is the one
boolean that preserves the distinction that matters — *one captured delivery
replayed ten thousand times* versus *ten thousand different probes* are
different attacks.

### Bound 2 — a per-instance write budget

At most `DEFAULT_MAX_ROWS_PER_MINUTE` (60) **source-attributed rows per instance
per minute**. Beyond it, buckets **fold** into an overflow row whose
`source_header` is `'folded'` and whose `source_ip` is NULL. Refusals held when
the budget is spent accumulate in memory and are written when the minute rolls.

For an `unknown_provider` flood the fold drops the **segment** as well, because
`/api/webhooks/aaa1`, `aaa2`, … is itself an unbounded cardinality dimension; a
*known* provider is kept, because that dimension is bounded at five.

**What it loses**, stated rather than implied:

* under a flood you learn the rate and the reason and lose per-source
  attribution;
* a process that dies with counts pending loses them;
* the budget is per **instance** — under horizontal scaling the ceiling is
  `instances × budget`, which is a bound and not a guarantee.

All three are deliberate. An attacker must not be able to turn our telemetry
into our outage, and losing the count of an attack we can see is cheaper than
losing the database to it. Critically, **the loss is visible**:
`folded_rows_24h` in `v_webhook_refusal_rate` and `foldedRows24h` in the health
field say when the budget was spent, so an aggregate that stopped attributing
sources never reads like an aggregate that had no sources to attribute.

The cap was wrong on the first attempt and a test caught it: the fold gate read
`pending.size`, which the database flush empties, so the cap reset every time a
write went through and five rows landed in a minute with a budget of two. It now
counts every bucket key **opened** in the minute, written or not.

---

## 6. The table

```
webhook_refusal
  id, provider, endpoint, reason_code,
  source_ip inet, source_header,
  minute_bucket, first_seen_at, last_seen_at, refusals,
  signature_present, signature_shape, signature_bytes,
  body_bytes, body_sha256, body_varied
```

**Append-mostly, with a named guard.** Not append-only, and the exception is
narrow and deliberate: `refusals`, `last_seen_at` and `body_varied` advance as a
bucket fills, because the alternative is a row per request, which is the attack.
It is exactly the carve-out `webhook_inbox` already holds, defended the same
way — a **column-level GRANT** so the application cannot *express* a rewrite,
plus a trigger so the owner cannot either.

```sql
GRANT SELECT, INSERT ON webhook_refusal TO corgi_app;
GRANT UPDATE (refusals, last_seen_at, body_varied) ON webhook_refusal TO corgi_app;
REVOKE DELETE, TRUNCATE ON webhook_refusal FROM corgi_app, PUBLIC;
```

Proven live, as `corgi_app`:

```
REFUSED  DELETE FROM webhook_refusal      — permission denied for table webhook_refusal
REFUSED  TRUNCATE webhook_refusal         — permission denied for table webhook_refusal
REFUSED  UPDATE ... SET body_sha256       — permission denied for table webhook_refusal
REFUSED  UPDATE ... SET source_ip         — permission denied for table webhook_refusal
REFUSED  UPDATE ... SET refusals = 0      — webhook_refusal.refusals only increases
```

**The audit registry.** `0035_audit.sql` §7 asserts
`v_audit_source_unclaimed` is empty: a migration that adds a store and does not
classify it turns the audit screen red. `0038` classifies `webhook_refusal` as
`excluded`, and the reason is the point rather than an excuse — `v_actor_action`
is a **business timeline keyed by an actor**, and a refused webhook has neither.
The counterparty has no `actor` row, and the delivery names no business (it
could not; naming one would mean reading and trusting a body we just refused).
Projecting it would mean inventing an actor and a business for every scanner on
the internet, corrupting the one trail the audit screen exists to keep honest.
Its home is the operational surface instead. `v_audit_source_unclaimed` was
re-read after the migration and this table is not on it.

---

## 7. The operator's queries

```sql
-- What has been hitting us, newest first.
SELECT * FROM v_webhook_refusal_recent;

-- The rate, per provider per reason, over 15 minutes and 24 hours.
SELECT * FROM v_webhook_refusal_rate;

-- "Has this address been at it before?"
SELECT * FROM webhook_refusal WHERE source_ip = '203.0.113.41'
 ORDER BY minute_bucket DESC;

-- "Is this the same forged payload every time?"
SELECT body_sha256, sum(refusals), bool_or(body_varied)
  FROM webhook_refusal WHERE provider = 'lithic' GROUP BY 1;
```

The windows live in `v_webhook_refusal_rate`, not in TypeScript, so a psql
session and the health endpoint cannot disagree about what "15 minutes" means —
the same reasoning as `payee_verification_freshness()` in `0016`.

---

## 8. What `/api/health` needs — NOT WIRED, and why

`/api/health` gained a `webhookProcessing` section reporting consumed, parked
and dead-lettered depth. A refusal rate belongs in that family, and
`src/app/api/health/route.ts` **belongs to another worker in this build**, so it
is reported here and not edited — the same discipline `docs/AUDIT.md` §2.1 used
for the one-line MCP audit change.

`src/lib/webhooks/refusals.ts` exports the two halves already, shaped exactly
like `processing.ts`'s pair:

```diff
+import {
+  readWebhookRefusals,
+  webhookRefusalHealth,
+} from '@/lib/webhooks/refusals';

 const processingRead = readWebhookProcessing(sql);
+const refusalRead = readWebhookRefusals(sql);          // same warmed connection
 ...
 const webhookProcessing = webhookProcessingHealth(await processingRead, new Date());
+const webhookRefusals   = webhookRefusalHealth(await refusalRead, new Date());
 ...
         webhookProcessing,
+        webhookRefusals,
```

It takes the connection the route has **already opened and warmed**, exactly as
`readWebhookDeliveries` and `readWebhookProcessing` do, and it never throws: an
unreadable refusal table reports `uncounted`, never `clean`.

**A fourth question, a fourth vocabulary.** `probe.ts` asks *does this credential
work* (`live` / `simulated` / …); `delivery-health.ts` asks *is this provider
still talking to us* (`fresh` / `stale` / `quiet` / `never` / `unknown`);
`processing.ts` asks *did we do anything with what arrived* (`consuming` /
`backlogged` / `dropping` / …). **None of them can express "we are refusing
deliveries", because all three read `webhook_inbox`, and a refused delivery is
by definition not in it.** So:

| Verdict | Meaning |
| --- | --- |
| `clean` | Nothing refused in 24 hours. |
| `probed` | Refusals, none of them a signature that failed to verify. Scanning, or a misrouted provider. |
| `stale_clock` | Timestamps outside the replay window. A replayed capture, or our clock has drifted. |
| `forged` | A well-formed signature did not verify. The secret is wrong, or someone is forging. |
| `uncounted` | The query did not run. Stated, never guessed. |

DECISIONS 021 and `consistency.test.ts`: one opinion per question and no shared
word between vocabularies, so `live` + `fresh` + `consuming` + `forged` reads as
four facts rather than a contradiction. `refusals.test.ts` asserts the
disjointness against the other three lists rather than asking a reader to check.

Two deliberate refusals in the published shape:

* **A refusal never marks the deployment degraded.** The field is
  `needsAttention`, not `degradedBy`. A stranger with `curl` must not be able to
  turn our status page red — that is precisely how a status page trains its
  readers to ignore it, the mistake `delivery-health.ts` already argues against.
* **Unroutable segments are counted and never listed.** The segment is
  attacker-authored text and a health endpoint is a screen. `unroutable` carries
  `refusals15m`, `refusals24h` and `distinctSegments24h` — and no names.

---

## 9. Evidence

Six forged POSTs and one genuine delivery against the running app, writing to
the live Neon database.

```
POST /api/webhooks/lithic   -> 401  WEBHOOK_SIGNATURE_INVALID   (bad signature, ×3)
POST /api/webhooks/lithic   -> 401  WEBHOOK_SIGNATURE_INVALID   (no signature header)
POST /api/webhooks/lithic   -> 401  WEBHOOK_SIGNATURE_INVALID   (stale timestamp)
POST /api/webhooks/shopify  -> 404  UNKNOWN_PROVIDER
POST /api/webhooks/stripe   -> 202  accepted                    (genuine)
```

Six refused requests, **four rows**:

| provider | reason_code | source_ip | refusals | sig_present | sig_shape | body_bytes | body_sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| lithic | `signature_mismatch` | 203.0.113.41 | **3** | true | `swh:v1x1` | 68 | `5f563ed2…` |
| lithic | `signature_absent` | 203.0.113.42 | 1 | false | `swh:nosig` | 68 | `5f563ed2…` |
| lithic | `timestamp_outside_window` | 203.0.113.43 | 1 | true | `swh:v1x1` | 68 | `5f563ed2…` |
| shopify | `unknown_provider` | 203.0.113.44 | 1 | true | `swh:v1x1` | **null** | **null** |

Read it as: the three repeated forgeries collapsed into one row with
`refusals = 3` and `body_varied = false` — *the same payload, three times* — and
the `unknown_provider` row has null body columns because **its body was never
read**.

The negative control, after the drain:

| provider | provider_event_id | event_type | state | processed |
| --- | --- | --- | --- | --- |
| stripe | `evt_negctl_1789108873` | `ping.refusal_negative_control` | `done` | true |

`SELECT count(*) FROM webhook_refusal WHERE provider = 'stripe'` → **0**. A
genuine signed delivery verifies, ingests, is consumed, and leaves no refusal
row.

### Running the tests

```
pnpm test                                   # 65 unit tests in refusals.test.ts
WEBHOOK_REFUSAL_TEST_DATABASE_URL=$APP_DATABASE_URL pnpm test src/lib/webhooks/refusals.test.ts
```

The second form adds one test that exercises the **real** multi-row
`INSERT ... ON CONFLICT DO UPDATE` against Postgres — the statement shape that
gave `inbox.ts` two production-only scars (a jsonb double-encode and an
ambiguous `id`), both of which passed every in-memory test because a double
never parses SQL. It runs **entirely inside a transaction that is always rolled
back**, so it is safe to point at a live branch and asserts afterwards that
nothing survived.

---

## 10. What is not built

* **Retention.** Nothing prunes `webhook_refusal`, and the guard refuses DELETE
  outright. At the bounded write rate that is a few thousand rows a day in the
  worst case, which is years of headroom. When retention is written it must
  **summarise and never erase** — the trigger's own hint says so.
* **Alerting.** `needsAttention` is published; nothing pages on it.
* **Blocking.** This table observes. It does not rate-limit the caller, and
  deliberately so: turning a telemetry table into an access-control decision
  gives an attacker who can spoof `x-forwarded-for` a way to get someone else
  blocked.
* **The screen.** `v_webhook_refusal_recent` exists and has no page.
* **The health wiring**, §8 — one import and three lines, in a file owned by
  another worker.
