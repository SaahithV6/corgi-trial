# Payment rails

One interface, three rails, and an ACH simulator that produces the cases a
sandbox will not.

```
src/lib/rails/
  types.ts          the PaymentRail interface — the contract everything below satisfies
  increase/         ACH, the LIVE adapter (Increase)
  achsim/           ACH, the SIMULATOR — same interface, honest label
  lithic/           cards, the LIVE adapter (owned elsewhere; it fits this interface)
```

---

## 1. What is live and what is simulated

**This table is the answer to "is that real?" and it is the first thing to read.**

| Slot | Adapter | Provider slug | Status | Evidence | Exercised against a real provider? |
|---|---|---|---|---|---|
| **Cards** | `lithic/` | `lithic.card` | **LIVE** | `live` | **Yes** — sandbox key, measurements in DECISIONS 006 |
| **ACH** | `increase/client.ts` | `increase.ach` | **LIVE code path, NEVER RUN** | `live` | **No.** There is no Increase key in this repo. Every wire shape is `[DOCS]`, from `research/ach/NOTES.md`. Nothing in that file is marked `[MEASURED]`, because nothing in it has been measured. |
| **ACH** | `achsim/` | `achsim.ach` | **SIMULATED** | `simulated` | n/a — it is the simulator |
| **USDC** | *(not in this package)* | `base-sepolia.usdc` | research draft | — | see `research/usdc/` |

**Which one is serving the ACH slot right now?** Whichever `createAchRail()`
picked, and it says so out loud:

```ts
const { rail, health, engine } = createAchRail();
// health.label      'LIVE' | 'SIMULATED'
// health.reason     one sentence an operator can act on
// health.missingEnv env var NAMES only, never values
```

- `INCREASE_API_KEY` present → the **live** adapter, one `info` log line.
- `INCREASE_API_KEY` absent → the **simulator**, one **`warn`** line
  (`rails.ach.simulator_selected`) naming the missing variables and saying, in
  words, that nothing it produces is evidence of a real bank transfer.

Never silently. `factory.test.ts` asserts that every selection path emits
exactly one line and that the no-key path is a `warn`, not an `info` — an
`info` line is one people filter out.

`achRailHealth(env)` returns the same report with no client constructed and no
network touched, shaped like `IntegrationReport` in
`src/lib/webhooks/route-handler.ts` so `/api/health` can render rail slots and
webhook integrations side by side.

---

## 2. The interface

`types.ts`. Four methods, and a rail is an **adapter**, not a schema.

```ts
interface PaymentRail {
  readonly capabilities: RailCapabilities;
  initiateCredit(req: TransferRequest): Promise<RailTransfer>;  // push
  initiateDebit(req: TransferRequest): Promise<RailTransfer>;   // pull
  getTransfer(id: string): Promise<RailTransfer>;               // read back — the truth
  parseEvent(rawBody: string): Promise<RailEvent>;              // interpret a callback
}
```

### No ACH nouns at the top level

Routing numbers and account types live inside **one variant** of a `Destination`
union. The card variant has a token; the USDC variant has a chain and an
address. Only the ACH adapters read the ACH variant.

SEC codes are reached through an **intent**, never named by the caller:

| `AuthorizationKind` | Nacha | Increase enum |
|---|---|---|
| `business_agreement` | CCD | `corporate_credit_or_debit` |
| `consumer_written` | PPD | `prearranged_payments_and_deposit` |
| `consumer_online` | WEB | `internet_initiated` |
| `business_remittance` | CTX | `corporate_trade_exchange` |

The caller genuinely knows *how the customer authorised the payment*; it
genuinely does not know which three letters that implies. So the interface asks
the question the caller can answer, and `SEC_CODE_BY_AUTHORIZATION` — the only
table in the repo that knows what a SEC code is — answers the other one. The
card and USDC adapters never import it and never learn that Nacha exists.

`types.test.ts` contains stub card and USDC rails that exist purely to be
type-checked. Widen `PaymentRail` for ACH's benefit and they stop compiling.

### There is no `verifyWebhook` on the interface, deliberately

Increase and Lithic both speak Standard Webhooks, and
`src/lib/webhooks/inbox.ts` already has one generic, tested verifier for it plus
a registry keyed by provider. A per-rail copy of a shared scheme is exactly the
duplication **DECISIONS 007** deleted. Verification happens once, upstream; by
the time a rail sees a body the bytes are already authenticated, which is why
`parseEvent` takes a raw string and nothing else.

*(This is why there is no `increase/verify.ts`. `increaseVerifier()` in
`inbox.ts` covers it.)*

### The seven normalised events

```
submitted · settled · returned · failed · canceled · correction · unknown
```

`unknown` is not a failure mode. It is how an unrecognised delivery still gets a
**200** instead of a throw that becomes a 5xx and gets the subscription
disabled. It carries a reason so the two honest cases are distinguishable:

- `unmodelled_event` — a provider event type this adapter does not model.
- `no_state_change` — recognised, but the money's fate did not change (Increase
  fires `ach_transfer.created` on a transfer still awaiting submission).
- `unparseable` — verified bytes we could not read.

One thing does throw: a **failed read-back**. Not knowing the state is not the
same as the event being uninteresting, and swallowing it would let the
dispatcher mark the row done. A throw is a retryable failure in `dispatch.ts`,
which is the correct outcome.

### A return is a second money movement

`returned` carries its own `amount` and a `RailReturnReason`:

```ts
{ category: 'insufficient_funds',   // branch on this
  code: 'R01',                      // canonical Nacha
  providerCode: 'insufficient_fund',// EXACTLY what Increase said — singular
  retryable: true }
```

`category` is what retry and dunning logic branches on, so one implementation
covers an ACH R01, a card `insufficient_funds` decline and a reverted USDC
transfer. The ledger **appends** a new entry; it never edits the original
transfer's amount, and the settlement timestamp is not erased — the transfer
really did settle, and then really did come back, and both facts survive.

### The return window is a capability, not a transfer field

`RailCapabilities.returnWindowDays` is 60 for ACH. It lives on the rail because
**the return window outlives settlement**: it is the input to "when do these
funds become available", which is a different question from "when did they
settle". 60 is the worst case the rail permits (an unauthorised consumer debit),
not the common one (2 banking days) — a hold policy sized for the common case is
wrong exactly when it matters. `null` on USDC means "the question does not
apply", which is not the same as `0`.

### Money

Integer minor units, `bigint`, everywhere. USDC is 6dp and blows past
`Number.MAX_SAFE_INTEGER` immediately, and a single interface cannot be bigint
on one rail and number on another without a conversion site that will eventually
be wrong. Adapters whose provider speaks `number` convert at their own boundary
and nowhere else. `JSON.stringify(1n)` throws, so anything crossing a JSON
boundary uses `serializeMoney` / `deserializeMoney`.

---

## 3. The Increase adapter, and the trap it exists to absorb

**Increase has no `settled` status.** A settled ACH transfer keeps
`status: "submitted"` and grows a `settlement.settled_at` timestamp. An adapter
that maps status-to-status is correct on every value in the enum and *still*
never releases a hold, because the state it is waiting for is not in the enum.

```ts
const status = mapped === 'submitted' && t.settlement?.settled_at ? 'settled' : mapped;
```

One line, at the one site where both fields are in scope. `client.test.ts`
asserts both halves, and asserts that the provider's own `"submitted"` survives
untouched in `raw` for audit.

**The webhook body is a pointer, not a payload.** Increase POSTs an Event
object — `{ id, category, associated_object_id }` — with no transfer state at
all, and there is no `ach_transfer.returned` category; a return arrives as
`ach_transfer.updated` like everything else. So `parseEvent` reads the transfer
back. That is a feature: the read-back is authoritative, which is what makes
out-of-order delivery harmless (§4).

Sandbox-only affordances (`simulateSubmit`, `simulateSettle`, `simulateReturn`,
`simulateNotificationOfChange`) are on the class but **not** on `PaymentRail`:
test affordances do not belong in the production interface. They drive the real
provider, so what comes back is `evidence: 'live'` — but they cannot deliver a
settlement webhook before a submission webhook, cannot redeliver on demand, and
cannot take the provider offline. That is what the simulator is for.

---

## 4. The simulator

`achsim/`. Same interface, same webhook scheme, same receiving code path,
`evidence: 'simulated'` on every value.

### The awkward cases, on demand and deterministically

| Preset | What it produces |
|---|---|
| `happy_path` | submitted now, settled tomorrow |
| `delayed_settlement` | submitted in 2h, settled in **3 days** |
| `return_after_settlement` | settles, then **R01 four days later** |
| `return_before_settlement` | never settles, **R02** two days after submission |
| `notification_of_change` | **COR** with corrected routing + account numbers (C01/C02) |
| `out_of_order` | the **settlement webhook arrives before the submission webhook** |
| `duplicate_delivery` | every notification delivered **twice** — same id, same bytes, same signature |

Plus, on the engine rather than in a preset:

- **`forceReturn(id, code)`** — any of R01, R02, R03, R05, R07, R08, R09, R10,
  R16, R29, on an arbitrary existing transfer, at any point in its life. This is
  the one capability that decided Increase over Moov and Modern Treasury in
  `research/ach/NOTES.md`, and the simulator has it too.
- **`beginOutage(ms)`** — API calls fail with a retryable `RailError`, webhooks
  **stop** (they are queued, not dropped), and the next drain after the window
  delivers everything at once as a **catch-up burst**.

```ts
const control = new AchSimControl({ secret: process.env.ACH_SIM_WEBHOOK_SECRET! });
await control.startPreset('return_after_settlement');
control.advance(days(1));            // -> settled
control.advance(days(4));            // -> returned, R01
for (const { delivery, event } of await control.drainAndParse()) { /* ... */ }
```

Time is virtual (`clock.ts`): "four days after settlement" costs a microsecond,
not four days. Ids come from a seeded PRNG. Same seed, same script → same ids,
same bodies, same order, **same signature bytes**. `engine.test.ts` asserts it
by running the script twice and deep-comparing.

### How the out-of-order settlement is produced

Under `delivery: 'settlement_before_submission'`, the engine schedules the
**submission notification** to leave 1ms *after* the settlement notification:

```
state:        submitted @ T0 ─────────────────── settled @ T0+1d
notifications:                                   settled @ T0+1d
                                                 submitted @ T0+1d+1ms   <- held back
drain order:                                    [settled, submitted]
```

Both state changes still happen when they happen. **Only the notification is
late** — which is what a real redelivery-after-timeout looks like. Moving the
settlement itself earlier would be time travel, not out-of-order delivery, and a
consumer that "handled" it would be handling something that cannot occur.

And then nothing breaks, because the body is a pointer: both notifications read
the transfer back and both resolve to `settled`. The late submission
notification is a harmless no-op instead of a regression that un-settles a
settled transfer. `rail.test.ts` runs the same scenario in both orders and
asserts the consumer lands in the same place.

### It signs like the real thing

Standard Webhooks, HMAC-SHA256 over `` `${id}.${timestamp}.${rawBody}` ``,
base64, `v1,` prefix, secret bytes used as UTF-8 — Increase's convention, not
Lithic's base64-decode one. `signing.test.ts` verifies a simulated delivery with
the **production** verifier out of `src/lib/webhooks/inbox.ts` — the real one,
not a copy — so the claim "the receiving code path is identical" is falsified
automatically if it ever stops being true.

`signingTime` picks which clock stamps `webhook-timestamp`: `'virtual'`
(default) for reproducible bytes, `'wall'` for deliveries POSTed over real HTTP,
where the inbox enforces a 300-second replay window against real time.

---

## 5. Three layers, none of them a promise

`evidence: 'simulated'` is not a convention the simulator is trusted to follow.
It is three independent mechanisms, and defeating the label means defeating all
three.

**1 — The stamp, written last.** Every value leaving `AchSimRail` goes through
`stamp()`, which writes `evidence: 'simulated'` **after** the spread. Not "sets
it if absent": written last, so no caller-supplied object, no spread order, no
config flag and no future edit that adds a field can produce a value from that
class claiming to be live. `capabilities` is typed to the literal `'simulated'`,
so widening it back is a compile error rather than a review comment.

**2 — The marker is inside the signed bytes.** Every simulated body carries
`"simulated": true` at the top level, and the signature covers the body. Strip
the marker to make a delivery look real and the HMAC no longer verifies; keep
the signature and the marker is still there. There is no third option.

**3 — The key and the key space are different.** The simulator signs with
`ACH_SIM_WEBHOOK_SECRET` and **refuses to be constructed** with the value of
`INCREASE_WEBHOOK_SECRET` (`SimulatedSecretMisuseError`, at boot, not at signing
time). So a simulated delivery does not verify against Increase's shared secret,
and forging one that does would require Increase's own secret. Its ids live in
their own namespace — `ach_sim_…`, `evt_sim_…` versus `ach_transfer_…`,
`event_…` — so a simulated row is distinguishable in the inbox, the ledger and
any log line by its **primary data**, not only by a flag a consumer might forget
to read.

And for the consumer side: `assertLive(value)` **throws** rather than returning
false. A boolean is forgettable, and the failure being defended against is a
caller who forgot to look.

---

## 6. The control API

`achsim/control.ts` is the interface — `AchSimControl` is what tests, seed
scripts and the demo drive.

`POST /api/sim` is a thin HTTP shell over it, and it is **off unless two
conditions both hold**: `NODE_ENV !== 'production'` **and**
`ACH_SIM_CONTROL_ENABLED === 'true'`. Two, not one, and neither defaults to on:
a single flag is one mis-set environment variable away from a production
endpoint that mints money-shaped events. When either fails the route answers
**404**, not 403 — "there is no such endpoint here" is the honest description of
a production deployment, and it tells a prober nothing.

```bash
curl -sX POST localhost:3000/api/sim -d '{"action":"start","preset":"return_after_settlement"}'
curl -sX POST localhost:3000/api/sim -d '{"action":"advance","ms":432000000}'
curl -sX POST localhost:3000/api/sim -d '{"action":"force_return","transferId":"ach_sim_…","code":"R02"}'
curl -sX POST localhost:3000/api/sim -d '{"action":"outage","durationMs":90000}'
```

Every response carries `"evidence": "simulated"` and `"label": "SIMULATED"` at
the top level — **including error bodies**. A rule with an exception for error
responses is a rule with a hole in it.

The `delivered[]` entries include the exact `rawBody` and `headers`, so an
operator can `curl` a simulated delivery straight at the real webhook route and
watch it go through the real verifier and into the real inbox.

---

## 7. Environment

| Variable | Used by | Effect if absent |
|---|---|---|
| `INCREASE_API_KEY` | live ACH adapter | **the simulator is selected**, loudly |
| `INCREASE_WEBHOOK_SECRET` | `increaseVerifier` in the inbox | inbound Increase webhooks cannot be verified (the route answers 503) |
| `INCREASE_BASE_URL` | live ACH adapter | defaults to `https://sandbox.increase.com` |
| `ACH_SIM_WEBHOOK_SECRET` | the simulator's signer | falls back to an unmistakable non-secret; **never** to the Increase secret |
| `ACH_SIM_CONTROL_ENABLED` | `POST /api/sim` | the route 404s |
| `ACH_SIM_SEED` | the simulator | defaults to `achsim` |

---

## 8. Known gaps, stated rather than hidden

- **The Increase adapter has never run against a real key.** Everything in it is
  `[DOCS]`. The shapes marked `UNVERIFIED` in the source are the ones most
  likely to be wrong: `preferred_effective_date` nesting, the NOC `change_code`
  → field mapping, and the R-code table beyond R01/R02/R03.
- **The simulator's state is in memory and process-local.** It is a demo script,
  not a record of money; `reset` and a process restart are the same thing. A
  Postgres-backed store would be a drop-in behind the same engine, and is
  deliberately not shipped — there is no migration for it because there is no
  table for it.
- **The simulator models one provider's shape (Increase's).** A rail whose
  webhooks *carry state* rather than pointing at it would be materially harder
  to get right under out-of-order delivery, and this simulator would not have
  taught you that.
- **`rejected` (pre-network compliance refusal)** cannot be produced by
  Increase's own sandbox. The simulator can (`failAfterMs`), which is one of the
  few places it is strictly more capable than the provider.
