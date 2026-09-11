# Plaid — what is true, what was over-claimed, and what item state now records

Everything in this document was measured against the live Plaid sandbox and the
live Neon branch on **2026-09-11**. Plaid request ids are quoted so anyone who
does not trust this file can check them in Plaid's own dashboard. Nothing here
is illustrative.

`docs/FUNDING.md` is the evidence for the funding leg and is still accurate.
This file is about the thing that document could not have: **item state**, and
the health-surface defect that having nowhere to put it produced.

---

## 1. The finding, in one paragraph

`GET /api/health` reported the `open_banking` slot **live**, with the evidence
string `POST /institutions/get -> 200`, while this deployment held **not one
usable funding source**. Both halves of that reading were true.
`/institutions/get` is a *catalogue* lookup: it takes a client id and a secret,
it returns a list of banks, and **it is answerable with no Item in existence**.
It proves the credentials are valid and says nothing whatever about whether a
customer's bank is linked or working.

The slot is named `open_banking`; the webhook route's own purpose string is
`"open banking — account funding and item health"`. A reader takes `live` to
mean *we can fund from a linked bank*. The probe could not see that capability
at all.

> **The generalisation this build keeps re-deriving:** a guard whose population
> or evidence is chosen by something other than the capability it claims to
> cover will report healthy. This is an instance, and the repair is a new
> question rather than a rewritten probe — `/institutions/get` is a perfectly
> good *credential* probe and is unchanged.

---

## 2. What was actually there — three corrections to the original theory

The investigation started from "a Plaid item broke eighteen hours ago and the
feed went silent." All three parts of that were wrong, and the corrections are
more interesting than the theory.

### 2.1 It was not one item. It was three, and they were deliberate.

The three `ITEM`/`ERROR` deliveries in `webhook_inbox` carry **three different
`item_id`s**:

| received (UTC) | `item_id` | `error_code` |
|---|---|---|
| 2026-09-10 21:58:19 | `8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ` | `ITEM_LOGIN_REQUIRED` |
| 2026-09-10 22:15:14 | `xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7` | `ITEM_LOGIN_REQUIRED` |
| 2026-09-10 22:47:23 | `7k9de5pw8RuB7KEwvDWKfvNrwgwr3xiNwBodw` | `ITEM_LOGIN_REQUIRED` |

Three separate throwaway Items, each linked, each deliberately broken by
`probeItemLoginRequired()` calling Plaid's own `/sandbox/item/reset_login`, each
firing one real webhook, each then abandoned. That is **a tested error path,
which is a credit and not a defect** — but the health surface had no way to say
so, and read it as a rail that had gone quiet.

### 2.2 The items are not broken. They are unreachable.

All three were re-checked against Plaid:

```
POST /item/get -> 400 (96ms)  request_id=450751819b578c8   INVALID_ACCESS_TOKEN
POST /item/get -> 400 (106ms) request_id=1225a0dcc433b4b   INVALID_ACCESS_TOKEN
POST /item/get -> 400 (128ms) request_id=fefa3b0d91e7204   INVALID_ACCESS_TOKEN
```

We hold **no credential for any of them**. That is a fourth condition, distinct
from "broken", and it has a practical consequence covered in §7: **Link update
mode cannot repair them**, because update mode needs a `link_token` minted
*from* the access token, and no access token was ever stored.

### 2.3 Plaid funding has run, repeatedly, and the claims survive.

The original theory was that account funding might be an over-claim. It is not.
There are **137 journal entries** whose `external_ref` begins `plaid:`, the
oldest 2026-09-10 22:36:15Z and the newest 2026-09-11 16:28:46Z, each with the
description:

> `Inbound ACH funding from First Platypus Bank 0000 via Plaid — ORIGINATED, NOT TRANSMITTED (no ACH entry was sent to any network)`

each paired with an `uncleared_credit` hold citing a `funds_availability_policy`
row. The money path is real and the documents describing it are scrupulous
about its limits. **The audit of every capability claim is in §8.**

---

## 3. Why the webhooks were forgotten

All four Plaid deliveries are `state = 'done'` with `processing_error IS NULL`.
They were not dropped — `plaidItemConsumer` read every one of them, wrote a
correct operator sentence, and returned `ignored`.

The sentence went nowhere. `markProcessed()` takes `(id, now)` and sets
`processing_error` to `NULL`, so a consumer's reason string never reaches the
database. `done` + no error is **indistinguishable** between "a consumer acted
on this" and "a consumer recognised it and could do nothing".

The consumer said so itself, and was right at the time:

> "THERE IS NO `plaid_item` TABLE. … There is no row to mark unhealthy, no
> customer to route a 'reconnect your bank' prompt to, and nothing a
> reconciliation would notice."

Three times, Plaid told this system a funding source was broken, the system
understood, and then forgot.

---

## 4. Migration 0056 — where item state lives now

Four tables and one view. The full argument is in the migration header; the
shape is:

| object | what it holds |
|---|---|
| `plaid_item` | identity: institution, environment, owning business, purpose. **No token.** |
| `plaid_item_secret` | the access token, versioned, with a retirement path |
| `plaid_item_account` | the accounts, with **mask and routing only — never the account number** |
| `plaid_item_event` | append-only log of everything Plaid has said about an item |
| `v_plaid_item_state` | the derived current state, folded from the log |

Three decisions are load-bearing.

**The log is append-only, and the state is derived.** `corgi_app` holds no
`UPDATE` or `DELETE` on `plaid_item_event`, and a trigger refuses both. An
UPDATE would destroy the sequence `healthy → ITEM_LOGIN_REQUIRED → repaired`,
which is the evidence for *how long was this funding source broken*. This is
the same shape as `team_member_version`/`v_team_member_current` and
`hold`/`hold_closure`/`v_hold_state`.

**`plaid_item_event.item_id` is deliberately NOT a foreign key.** Plaid can tell
us about an item we hold no credential for — it did, three times — and a foreign
key would make the only honest record of that fact unwritable. A webhook is
*something a provider said*. The log records what was said; the join to
`plaid_item` records whether we can act on it; and the **difference between
those two is the `orphaned` state**.

**The consumer's write is idempotent by index.** `UNIQUE (inbox_id)` is what
satisfies the dispatcher's contract that "the same event may be handed to you
again … Make the effect a function of a set (a unique key on the write), not an
increment". A redelivery writes nothing and says so.

### The secret at rest

`plaid_item_secret` copies `outbound_endpoint_secret` (migration 0034 §2)
deliberately rather than inventing a second pattern:

- **A separate table**, so `SELECT * FROM plaid_item` cannot return a token.
- **Plaintext, stated rather than dressed up.** A Plaid access token is a bearer
  credential presented verbatim on every call, so "hashed at rest" is not
  available the way it is for a password, and encrypting it with a key from the
  same environment the application reads moves it one dereference and no
  further. What is bought is blast radius: no `UPDATE` grant on the token
  column (only `UPDATE (retired_at)`), a retirement path, and an immutability
  trigger — each proven by a test.
- **A `CHECK` on shape** (`access-%`, length ≥ 20), so a value pasted into the
  wrong column is refused by the database rather than discovered as a 400 from
  Plaid three days later.
- **An opaque wrapper in TypeScript** (`src/lib/rails/plaid/secret.ts`, modelled
  on `src/lib/events/secret.ts`): `toString()` gives `access-sandbox-***`,
  `toJSON()` gives `"[redacted]"`, and the only accessor is a greppable
  `revealAccessToken()`. The `toJSON()` hook is the one that matters — the
  logger JSON-encodes its context bag, and a bare string in a context bag is one
  `log.info` away from a log drain.

> **For the record, because it must be a deliberate decision and not a
> discovery:** a live Plaid access token is now stored in the application
> database in plaintext. In the sandbox it grants read access to fictional
> accounts at First Platypus Bank. In production the same design would grant
> read access to a customer's real balances, transactions, identity and full
> ACH numbers, and the correct control there is a KMS-backed envelope key that
> the application cannot read unaided — not this. That is named here rather
> than left to be found.

---

## 5. The fourth question, and its own vocabulary

`/api/health` already keeps three verdict vocabularies disjoint so that no
reader has to reconcile them. Item state is a fourth, and shares no word with
any of them:

| vocabulary | question | words |
|---|---|---|
| liveness | does the key work? | `live` `simulated` `unauthorised` `unreachable` `rate_limited` `not_configured` |
| delivery | are they still talking to us? | `fresh` `stale` `quiet` `never` `unknown` |
| processing | did we act on what arrived? | `consuming` `backlogged` `dropping` `refused` `superseded` `never_consumed` `unmeasured` |
| **item** | **can we actually do the thing?** | **`healthy` `needs_reauth` `revoked` `orphaned` `absent` `unread`** |

A test asserts the union has no duplicates, so adding a word to any of the four
without deciding what it means fails the suite.

- **`healthy`** — Plaid's last word on this item was "no error".
- **`needs_reauth`** — Plaid says a **human** must re-authenticate in Link
  update mode. Reported, never alarmed on: see §6.
- **`revoked`** — consent withdrawn. Terminal; re-linking creates a new item, it
  does not repair this one.
- **`orphaned`** — Plaid named an item we hold no live credential for. *Not* a
  broken funding source — one we cannot reach.
- **`absent`** — no item at all, which is the empty view rather than a row. This
  is the word that fixes the original reading: **"we have never linked a bank"
  and "our linked bank is broken" were the same reading, and they are opposite
  operational facts.**
- **`unread`** — the query did not run. Stated, never guessed, and deliberately
  not the same as `absent`.

Two extra published fields carry what the delivery vocabulary had no word for:

- **`heardOnlyErrors`** — true when every observation ever recorded from Plaid
  was an error. `stale` means "this provider has gone quiet", which *implies it
  once worked*; when this is true, that implication is false.
- **`silenceIsExpected`** — true when no item is capable of producing a webhook.
  When this is true, a `stale` delivery verdict is not evidence of anything.

---

## 6. Why none of this degrades the deployment

`route.ts` records the house rule: *"A status that cannot go back to `ok` is a
status people stop reading"*, and this endpoint already learned once not to
report degraded overnight because nobody swiped a card.

`needs_reauth` is a state whose **exit condition is a person doing something**.
If it degraded the deployment, the deployment would be degraded from the moment
a customer's bank rotated its MFA until that customer next logged in — days,
legitimately, with nothing broken on our side and nothing an operator could do.
That is precisely the alarm nobody reads.

`plaidItems.degradesDeployment` is therefore typed as the literal `false`. The
contribution here is **a truer reading, not a louder one**. The question was
never whether the endpoint was loud enough; it was whether it was true.

---

## 7. What a human must do — and what they do not

**Nothing, and it would not be possible anyway.**

The three `ITEM_LOGIN_REQUIRED` items from 2026-09-10 cannot be repaired by
anyone, including by hand:

1. Link update mode requires `POST /link/token/create` with an `access_token`.
2. No access token for those items was ever stored — that was the whole gap.
3. Therefore no update-mode `link_token` can be minted for them.
4. They were throwaway diagnostic items in the first place. Nothing was ever
   funded from them; no customer is affected.

They are now recorded as `orphaned`, which is the accurate state, and they are
deliberately **kept** — an orphaned item, a broken-but-reachable item and a
healthy item side by side are the best available demonstration that the surface
tells the three apart.

The one thing worth a human's attention is **§8's over-claim**, which is a
two-line documentation fix in a file this worker does not own.

---

## 8. Capability-claim audit

Every claim about Plaid in `docs/` and `src/`, and whether it survives.

### Survives — accurate as written

| claim | where | why it stands |
|---|---|---|
| `open_banking` is `live`, evidence `POST /institutions/get -> 200` | `README.md:136`, `docs/EVIDENCE-PACK.md:726` | Re-measured: 200, `request_id=6257cb909c41eca`, 10,088 institutions. The evidence string states exactly what was called. **Adjacent to the capability, but not false** — and `plaidItems` now states the capability separately. |
| `/funding` links a real Item over five real calls | `docs/FUNDING.md:174-181` | Re-measured end to end; all five 200. |
| **No ACH entry is transmitted to any network** | `docs/FUNDING.md:183-190`, `adapter.ts:18-26` | True, and carried on every journal row's own `description` for ever. |
| The Link browser UI is never driven | `DECISIONS.md:1679-82`, `FUNDING.md:229-245` | True; the link token is minted and deliberately unused. |
| Funding raises ledger and leaves available unchanged | `docs/CORE-LOOP.md:397`, `GAUNTLET.md:127-131` | 137 journal entries, each with its `uncleared_credit` hold. |
| Idempotency is a **guard, not a guarantee**, across two linked items | `docs/FUNDING.md:552-562` | Was true. **Now superseded** — see §9. |

### Does NOT survive — one over-claim, and it is in a file this worker does not own

**`docs/PAYEES.md:290`:**

> `| `linked_account_holder` | The receiving institution's own record, via the holder's Plaid link | **Yes, live** — for accounts somebody linked |`

This is contradicted 900 lines later in the same document,
**`docs/PAYEES.md:1174-1181`:**

> "**Plaid's `/identity/match` is NOT wired to this form**, and the reason is a
> fact about the schema rather than a shortcut … there is nowhere in this schema
> to persist one."

`/identity/match` is called from nowhere in `src/`. The second passage is
correct and the table row is the over-claim. `README.md:510` and
`docs/DEBRIEF.md:1081` repeat the first framing.

**Recommended correction** (for whoever owns `docs/PAYEES.md`): change the
`linked_account_holder` row from **"Yes, live"** to **"No — the enum value
exists and nothing writes it; `/identity/match` is not wired"**, and reconcile
`README.md:510`.

Note that the *schema* reason given in the 1174 passage ("nowhere to persist
one") is now out of date — `plaid_item` exists — but the *capability* claim is
still false, because nothing calls the endpoint. **It should be corrected to
"not wired", not to "now possible".**

### Minor drift, worth a line

- **`docs/ACCOUNT-OPENING.md:206-212`** says a 429 makes `/api/health` report the
  open-banking slot "as degraded". The probe actually returns `rate_limited`,
  which renders as `simulated`. Same spirit, wrong word.
- **`docs/WEBHOOK-CONSUMERS.md:28, 292-297, 389`** describe the Plaid consumer
  as acknowledging item health and posting nothing. Still true that it posts
  nothing; **no longer true that it records nothing.**

---

## 9. The limit that disappeared

`adapter.ts` recorded a real hazard:

> "THE ITEM ID IS PART OF THE KEY, AND THIS PATH LINKS A FRESH ITEM ON EVERY
> RUN … the unique indexes make a funding run replay-safe WITHIN one linked
> Item, and they cannot see across two."

`alreadyFundedReference()` was an explicit *guard and not a guarantee*: two
requests racing between its `SELECT` and the `INSERT` both pass it.

With the item stored, a second funding run **does not link at all** — it reads
the funding source back with `fundableAccountsFor()` — so both runs derive the
same `external_ref`, and the unique index decides rather than a `SELECT`. This
is asserted against the live database in
`src/lib/rails/plaid/item-store.integration.test.ts`:

```
firstRun.created  === true
secondRun.created === false
secondRun.entryId === firstRun.entryId   // one deposit, not two
```

---

## 10. Instant auth vs micro-deposits — which one this is

**This is instant auth, and only instant auth.** Measured on the linked item:

```
item.auth_method = "INSTANT_AUTH"
numbers.ach      = 3 entries across 14 accounts
verification_status on each fundable account = null
```

`/auth/get` returns the routing and account numbers immediately because Plaid
already holds them from the login. `verification_status` is `null` precisely
because no verification flow is running — there is nothing to wait for.

**What instant auth does and does not establish.** It proves the credentials
opened an account at that institution and that these are that account's real ACH
numbers. It does **not** by itself establish that the person linking is an
authorised owner of the account; Plaid sells `/identity` and `/identity/match`
for that, and **neither is wired here** (see §8).

**What production funding would additionally require**, stated so it is not
mistaken for done:

1. **Ownership verification** — `/identity/match` against the business's own
   records, or Plaid's `AUTOMATED_MICRODEPOSITS` / `SAME_DAY_MICRODEPOSITS` flow
   where instant auth is unavailable. Micro-deposits are a *two-to-three day
   asynchronous* flow: the item comes back `pending_automatic_verification`,
   `verification_status` becomes non-null, and funding must be refused until it
   reaches `automatically_verified`. `plaid_item_account.auth_method` exists so
   that distinction survives the request; **nothing enforces it yet.**
2. **An actual ACH origination.** No entry is transmitted to any network today
   and the ledger says so on every row.
3. **NACHA authorisation capture** — the WEB debit authorisation, retained.
4. **Return handling** — `rail_event_semantics` has the vocabulary; the Plaid
   funding path has no return leg because it originates nothing to be returned.

An honest partial: **the linkage and the numbers are real; the verification of
ownership and the movement of money are not.**

---

## 11. How to see it

```bash
set -a; . ./.env; set +a

# item state, folded
psql "$APP_DATABASE_URL" -c 'select item_id, purpose, state, has_live_token,
                                    observations, error_observations
                               from v_plaid_item_state order by state'

# the health surface
curl -s localhost:3000/api/health | jq '.integrations.plaidItems'

# the tests
RUN_DB_TESTS=1 pnpm exec vitest run --no-file-parallelism \
  src/app/api/health src/lib/rails/plaid src/lib/webhooks/consumers/plaid-item.test.ts
```

Current reading, 2026-09-11:

```
healthy       MJwjyAyqGbtE688WL1ZLu67yaw44BRiDmRG5b  purpose=funding     obs=1/0err
needs_reauth  MrmwbaJ6QGSooe4P9AG5f67DL48KazCDGG5k3  purpose=diagnostic  obs=2/1err
orphaned      7k9de5pw8RuB7KEwvDWKfvNrwgwr3xiNwBodw  purpose=-           obs=1/1err
orphaned      8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ  purpose=-           obs=1/1err
orphaned      xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7  purpose=-           obs=1/1err
```

The `needs_reauth` row is the end-to-end proof: a real `ITEM_LOGIN_REQUIRED`
webhook, fired by Plaid at 16:55:36Z against the deployed endpoint, verified,
stored, consumed by the real consumer through `/api/drain`, appended to
`plaid_item_event` citing delivery `cf5de11d`, and folded from `healthy` to
`needs_reauth` by the view — the exact sequence that happened three times on
2026-09-10 and left no trace.
