# Chaos mode

**`/chaos`.** Four switches that perturb the *delivery* of card webhooks this
deployment originates itself — their availability, timing, multiplicity and
order — and a dashboard showing the ledger absorbing it.

It exists to turn the live-fire section from *them* attacking *us* into us
handing them the weapon. The brief's gauntlet lists adversarial conditions;
this screen lets a grader cause them, on purpose, while watching every
invariant hold.

---

## 1. The honesty rule, first, because it outranks the feature

A chaos control that fakes a provider outage is one screenshot away from being
"a simulated integration presented as live", which is an automatic fail. So:

> **The banner says we turned it off. It never says the provider is down.**

The exact wording rendered when any control is armed
(`src/components/chaos/ChaosBanner.tsx`):

> ### CHAOS MODE IS ON — WE ARE DOING THIS, NOT THE PROVIDER.
>
> Corgi is deliberately perturbing the delivery of card webhooks that **Corgi
> itself originated** — their timing, their order, how many times they arrive,
> and whether they arrive at all. **Lithic's sandbox is untouched.** Its live
> event subscription has not been disabled, no provider has reported a problem,
> and **nothing on this screen is evidence of a provider outage.**
>
> This screen is a test harness. `/api/health` is the authoritative statement of
> which integrations are live; chaos mode does not write to it, read into it, or
> override it.
>
> …then one line per armed control, each with *we* as the subject…
>
> **All chaos ends automatically at 14:31:07 (in 4m 12s).** The ten-minute
> ceiling is a `CHECK` constraint in migration 0029, not a policy: the database
> refuses to store a longer arming, so a forgotten switch cannot outlive the
> demo.

Three rules produced that copy, and they are worth stating because they are
what makes a cropped screenshot safe:

1. **Every sentence has us as its subject.** "Corgi is withholding", "we are
   sending", "we are releasing". Never "the provider is", never an adjective
   like *degraded* or *down* that describes them. The grammar carries the
   claim, so cropping cannot remove it.
2. **The provider is exonerated in the banner body**, not in a footnote.
   Deleting that sentence to make the screenshot mean the opposite is forgery,
   not cropping.
3. **`/api/health` is named as authoritative.** If any word on this screen ever
   disagrees with that endpoint, the endpoint is right.

Chaos does not touch `ProviderHealthBanner`, the site-wide strip that *is*
allowed to make a statement about provider health. That component derives its
verdict from `/api/health` and chaos neither feeds it nor imitates it.

---

## 2. What already existed, and what I had to build

The premise handed to me was "the simulator can already produce all four; this
is a UI over it". **That is half true, and the half that is false is the half
that matters.** Measured rather than assumed:

| Condition | Exists as machinery? | Where | Could it reach the running system? |
| --- | --- | --- | --- |
| Webhooks off | Yes | `AchSimControl.outage()` / `AchSimEngine.beginOutage()` | **No** |
| Settlement delay | Yes | `SIM_PRESETS.delayed_settlement` | **No** |
| Duplicate delivery | Yes | `SIM_PRESETS.duplicate_delivery` | **No** |
| Out-of-order | Yes | `SIM_PRESETS.out_of_order` | **No** |

All four exist, as concepts, **on the ACH rail**, inside `src/lib/rails/achsim/`.
None of them had a door into this deployment, for four independent reasons,
each of which I checked:

1. **`achsim` is not a routable webhook provider.** `WEBHOOK_INTEGRATIONS` in
   `src/lib/webhooks/route-handler.ts` holds five entries — lithic, persona,
   plaid, increase, stripe. `POST /api/webhooks/achsim` answers
   `UNKNOWN_PROVIDER`.
2. **No consumer is registered for it.** `ensureConsumers()` in
   `src/lib/webhooks/drain.ts` registers four: lithic-card, increase-ach,
   stripe-identity, plaid-item. An `achsim` row would be retried eight times and
   dead-lettered with "no consumer registered for provider 'achsim'".
3. **`/api/sim` is off.** It requires `NODE_ENV !== 'production'` **and**
   `ACH_SIM_CONTROL_ENABLED === 'true'`. The flag is unset. That gate is correct
   and I did not touch it.
4. **The ACH slot is not served by the simulator anyway.** `INCREASE_API_KEY` is
   set, so `createAchRail()` selects the live Increase adapter.

And the decisive one: **the brief's chaos item is about the *issuing* provider**
— "turn off your issuing provider's webhooks for five minutes mid-demo" — and
**none of the four existed on the card rail at all.** The card rail is where
holds, available balance and the whole of Track 3's domain gauntlet live, so it
is the only place this demo is worth watching.

**So: the four conditions were pre-existing as ACH-rail simulator presets. The
delivery driver that can subject this deployment's *card* pipeline to them is
new machinery, in `src/lib/chaos/`.** This is not a UI over existing machinery,
and calling it one would blur exactly the distinction the build refuses to blur.

---

## 3. The four controls

Each is a transform on a release schedule. `src/lib/chaos/plan.ts` is the only
file where they mean anything, and it is pure.

| Control | Perturbs | What it does |
| --- | --- | --- |
| `webhooks_off` | availability | Nothing leaves our outbox. The deliveries are signed and durable; the switch only decides whether they go. |
| `settlement_delay` | timing | The clearing's release moves into the future. The authorisation is untouched — a late settlement is late, not a late everything. |
| `duplicate_delivery` | multiplicity | Each delivery goes N times, **same `webhook-id`, same bytes**. |
| `reorder_window` | order | The buffer holds for W seconds then emits **backwards**, so the settlement arrives before the authorisation it belongs to. |

Applied in that order — timing, order, fan-out, gate — so every copy inherits
its slot's place, and availability applies last to whatever the others produced.

**The episode** they shape is the brief's own fuel-pump pair: a $50.00
authorisation and a $73.40 clearing, on one card. The amounts are the row
`src/lib/rails/lithic/README.md` measured against the live sandbox, so the
bodies' aggregates agree with their own events and the demo does not
manufacture a reconciliation break while claiming to show the ledger surviving.

---

## 4. What is exercised, and what is not

Chaos hands its deliveries to **`ingestWebhook`** — the exact function the
deployed `/api/webhooks/[provider]` route calls, with the exact
`createPostgresInboxStore` it uses — together with a verifier registry chaos
builds itself, holding `lithicVerifier({ secret: chaosSecret() })`.

| Link in the chain | Exercised by chaos | Exercised by |
| --- | --- | --- |
| Signature verified over raw bytes | **yes**, by the production verifier factory | also attacks 4, 7, 8 |
| Persisted to `webhook_inbox` | **yes**, by the production store | also attacks 4, 7, 8 |
| Deduped by `UNIQUE (provider, provider_event_id)` | **yes**, by Postgres | also attacks 4, 7, 8 |
| Dispatched by `drain()` to the Lithic consumer | **yes** | also attacks 4, 7, 8 |
| Applied to the ledger by `applyCardTransaction` | **yes** | also attacks 4, 7, 8 |
| The HTTP shell in `route.ts` | **no** | attacks 4, 7, 8, over real HTTP |
| A signature checked against *Lithic's own* secret | **no**, deliberately | attacks 4, 7, 8 |

The last two rows are the price of the refusal in §5, and **neither claim
borrows the other's evidence.** The live-fire attacks cover the HTTP hop
against the deployed URL; chaos covers everything downstream of it, from a
screen.

---

## 5. Why a chaos delivery cannot be forged, and cannot be accepted by the route

Three layers, copied from the ACH simulator's anti-forgery doctrine in
`src/lib/rails/achsim/signing.ts`, because that doctrine is correct.

**1. The key is different.** Chaos signs with `CHAOS_WEBHOOK_SECRET` (or a
loudly-named development default) and `assertNotAProviderSecret` refuses to
resolve a secret equal to any provider's. The consequence is real and is the
property being bought:

> **A chaos delivery cannot be accepted by the deployed webhook route.**
> `/api/webhooks/lithic` verifies against Lithic's own subscription secret and
> will answer 401 to everything chaos signs, for ever.

The shortest path to this feature was to sign with `LITHIC_WEBHOOK_SECRET` and
POST at the deployed endpoint — which is what attacks 4 and 7 do, deliberately,
with the construction labelled in their headers, because a rehearsal suite has
no other way to produce an out-of-order clearing. **A shipped screen is not a
rehearsal suite**, so chaos holds its own key and ingests in-process instead.

**2. The marker is inside the signed bytes.** Every body carries a top-level
`corgi_chaos` object naming the run, the control that shaped the delivery, and
the sentence "Originated by Corgi chaos mode, not by Lithic." Strip it to make
the row look like a real delivery and the HMAC no longer verifies; keep the
signature and the marker is still there. There is no third option, and
`sign.test.ts` proves it.

**3. The id lives in its own key space.** Every chaos `webhook-id` is
`chaos_<run>_<seq>`, so `webhook_inbox.provider_event_id` — *half of the table's
own replay key* — announces the row's origin, for ever:

```sql
SELECT * FROM webhook_inbox WHERE provider_event_id LIKE 'chaos\_%';
-- or the view: SELECT * FROM v_chaos_inbox;
```

---

## 6. Chaos must never corrupt the book — and it has no branch downstream

The rule I was given was that if I found myself adding a branch to accommodate
chaos, I had built the wrong thing. **I did not have to add one.** Nothing in
`src/lib/webhooks/**`, `src/lib/holds/**` or `src/lib/ledger/**` was changed, no
column was added to `webhook_inbox`, and nothing outside `src/lib/chaos/**`,
`src/components/chaos/**`, `src/app/(app)/chaos/**` and migration 0029 knows
chaos exists.

The duplicate control is the test of that claim. Copies 1..N carry the same
`webhook-id` and the same bytes, so they are refused by
`webhook_inbox UNIQUE (provider, provider_event_id)` — the replay suppression
that existed before chaos did. Chaos does not look the id up first, does not
check for a duplicate, and has **no code path that could produce that answer**;
it records whatever `ingestWebhook` returns. Measured against the live database:
6 deliveries planned, 2 accepted, **4 suppressed as replays**, invariants held.

The four chaos tables carry no money column, no foreign key into `account`,
`journal_entry`, `journal_line`, `hold` or `card_auth_event`, and no path into
the balance derivation. Dropping all four would lose the demo's script and not
one cent of the book.

---

## 7. It cannot be left on by accident

This is enforced in the database, not in the application:

```sql
CONSTRAINT chaos_control_bounded
  CHECK (expires_at > armed_at
         AND expires_at <= armed_at + interval '10 minutes')
```

There is no code path, no admin form, no direct `psql` session and no future
worker's bug that can write a chaos switch lasting eleven minutes. Postgres
refuses the row. The live-fire suite asserts this **by reaching around the
application check** and writing the row directly.

Four further properties follow:

- **Expiry is not a sweeper.** `v_chaos_active` filters on `now()`, so a control
  that has run out is *absent* from the only relation anything reads. No cron to
  fail, no job to be dropped by a recycled serverless instance, and no window in
  which one reader thinks chaos is on and another thinks it is off.
- **Off is a `DELETE`.** `chaos_control` has no `enabled` column, because a
  switch whose off state is another row is a switch with two truths.
- **The expiry is computed by Postgres** (`now() + make_interval(...)`), not by
  the process, so a serverless instance with a skewed clock cannot buy itself
  time.
- **ALL CHAOS OFF is rendered on every state of the screen**, including the state
  where nothing is armed. The moment somebody reaches for it is the moment they
  are unsure what is on.

A restart clears nothing here because there is nothing to clear: the worst case
for a forgotten switch is ten minutes, measured by the database's own clock.

---

## 8. The frame worth watching

The interesting demo is not "nothing happened". Start an episode with **"let
the deliveries park"**:

1. The deliveries arrive, verified and durable, naming a card that is not bound
   to any customer.
2. The consumer answers `parked("card", <token>)`. **Nothing is posted.** Not
   dropped, not failed, not dead-lettered — the system is holding a verified
   money event and **refusing to guess whose money to move**.
3. `card_authorization` has no row for that transaction. It *cannot*:
   `card_authorization.card_id` is a foreign key into `card`, and there is no
   `card` row to point at. The refusal is in the schema, not in an `if`.
4. Press **Register the card**. `unparkWaitingFor` — the same call the
   dispatcher makes when a consumer reports it produced a `card` ref — wakes the
   rows, and they post against the customer they always belonged to.
5. The same events. Never re-delivered, never re-signed.

---

## 9. Measured, against the live system

`src/lib/chaos/chaos.livefire.test.ts`, eight tests, run with `LIVEFIRE=1`
against the live Neon database. **All eight pass.** Every test asserts every
invariant view unconditionally, because "they held throughout" is the claim.

| Test | What the ledger did |
| --- | --- |
| At rest | every invariant empty; chaos off |
| Duplicate delivery ×3 | 6 planned, 2 accepted, **4 suppressed as replays**; inbox holds one row per slot, not three |
| Reorder | clearing released first and accepted; the authorisation it overtook released after; both landed |
| Settlement delay | authorisation accepted immediately, clearing **withheld** and scheduled later, then accepted |
| Webhooks off | both deliveries withheld, **neither reached an inbox row at all**; a release attempt returned 0; switch off → both accepted |
| Parks | deliveries parked on `card:<token>`, no `card_authorization` row; after registering, woken and posted |
| The bound | application refused 601s; **direct `INSERT` of 11 minutes refused by `chaos_control_bounded`** |
| Expiry | armed for 2s, gone from `v_chaos_active` with no job run, reported as history |

`node scripts/dbcheck.mjs` after all of it: **30 passed, 0 failed** — including
the two card-hold invariants another branch added while this was being built,
which `invariants.test.ts` caught drifting and which are now on this screen too.

---

## 10. Reaching the screen

`/chaos`, by URL. It is **not** in the header navigation: `NavLinks.tsx` holds
that array and it belongs to another worker on this build, so adding a link
would mean editing a file outside this slice. Precedent exists — several live
screens are absent from one registry or the other — but it is a real gap and it
is recorded here rather than worked around.

Five URL states, house standard: `?state=default|loading|empty|error|edge`.
`default` and `edge` read the live book; `edge` is a *label* for the most
interesting real state — all four controls armed at once against an
unregistered card — and not a second, fake dataset. The three fixture states
say in prose that nothing on them is a statement about a real book, and the
controls are disabled on them.

---

## 11. The hook chaos would want inside the webhook path

Chaos needs no hook to work, and I added none. But the design above pays a real
price for that, and the price has a name:

> **`achsim` — and any future in-house origin — has no door.** The receiving
> path is keyed on a five-entry provider catalogue in
> `src/lib/webhooks/route-handler.ts` and a four-entry consumer list in
> `src/lib/webhooks/drain.ts`. A delivery that is honestly *ours* has nowhere to
> land: it cannot be routed (no integration entry) and would not be consumed (no
> consumer registration).

If the webhook path's owner wanted to close that, the smallest change that would
do it is **one `WEBHOOK_INTEGRATIONS` entry plus one consumer registration**:

```ts
// src/lib/webhooks/route-handler.ts — WEBHOOK_INTEGRATIONS
{
  provider: 'chaos',
  label: 'Chaos mode (ours, not a provider)',
  purpose: 'deliveries this deployment originates to stress its own pipeline',
  slots: [],                                   // never counts toward live/simulated
  verificationEnv: ['CHAOS_WEBHOOK_SECRET'],
  makeVerifier: (env) => lithicVerifier({ secret: mustRead(env, 'CHAOS_WEBHOOK_SECRET') }),
}
```

plus an alias so the Lithic consumer handles `provider = 'chaos'` rows.

**I did not add it, and I am not asking for it lightly** — it widens the set of
things the deployed route accepts, and the `slots: []` line is load-bearing in a
way that would need review: a provider that is *ours* must never be counted by
`/api/health` as an integration at all, live or simulated. Chaos works without
it. What the hook would buy is the last two rows of §4's table: the HTTP shell,
exercised from the screen rather than only from the live-fire suite.

---

## 12. Files

| Path | What |
| --- | --- |
| `db/migrations/0029_chaos.sql` | four tables, four views, the `CHECK` that holds the whole safety story |
| `src/lib/chaos/types.ts` | vocabulary, bounds, the marker. No I/O |
| `src/lib/chaos/bounds.ts` | the parameter ranges. No database, so the gate can test them |
| `src/lib/chaos/sign.ts` | the signer and the refusal |
| `src/lib/chaos/body.ts` | Lithic's measured wire shape |
| `src/lib/chaos/plan.ts` | four controls → one release schedule. Pure |
| `src/lib/chaos/switch.ts` | arm, disarm, and the one answer to "is chaos on" |
| `src/lib/chaos/driver.ts` | the outbox and the door into the real pipeline |
| `src/lib/chaos/observe.ts` | invariants, inbox and position, at one instant |
| `src/lib/chaos/invariants.ts` | the list, mirrored from `scripts/dbcheck.mjs` and kept in sync by a test |
| `src/components/chaos/**` | pure view code against a data contract |
| `src/app/(app)/chaos/**` | the page, its live source, its six server actions |
