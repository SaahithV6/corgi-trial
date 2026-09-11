# The client surface — `/client`

Five screens, scoped to one business, in the customer's language rather than the
ledger's.

Live: https://corgi-trial-psi.vercel.app/client

---

## 1. The gap this closes

The brief opens:

> Business current accounts. Customers hold a balance, send and receive
> payments, and get a card for each person on the team.

and later:

> Users need to see their balance. Users need to approve payments above a
> threshold. Users need to reconcile the scheme file.

Before this, nineteen screens existed and **every one of them was the
operator's view**: every business on the book in one table, staff vocabulary,
`2100` account codes, invariant row counts, breaks aging. A customer of this
bank could not see their own balance without reading a table of everyone
else's — which is not a usability complaint, it is the shape of a data breach
waiting for an audience.

Five screens now answer the brief's own sentences, for the person whose money
it is:

| Route | The brief's sentence | What it shows |
| --- | --- | --- |
| `/client` | "Users need to see their balance" | What they have, what they can spend **right now**, and why those differ — itemised, in whole cents, without the word *memo* |
| `/client/activity` | "send and receive payments" | Their transactions in plain language, with *authorised $50.00, settled $73.40* on one line |
| `/client/cards` | "a card for each person on the team" | Each person's card, what it can and cannot do, and why a declined authorisation was declined |
| `/client/pay` | money out | The existing `requestPayment()` path, worded for a customer |
| `/client/approvals` | "approve payments above a threshold" | Maker-checker as the customer meets it, with the refusal as a sentence |

Every screen takes the house five URL states — `?state=loading`, `empty`,
`error`, `edge`, bare for default — and a `?business=<uuid>` subject.

---

## 2. Tenant isolation: a predicate, never a step

**A customer must never see another customer's anything.** On this surface that
is enforced in one way and one way only: the business id is an *argument to a
reader that puts it in a `WHERE` clause*. There is no `.filter()`, no `.find()`
and no `if (row.businessId === mine)` anywhere in
`src/app/(app)/client/live-source.ts` that decides which customer a row belongs
to.

| Question | Reader | Predicate |
| --- | --- | --- |
| who is this | `findBusiness(businessId)` | `WHERE b.id = $1` |
| their account | `findAccount({businessId, code:'2100'})` | `WHERE a.business_id = $1` |
| **available** | `availableBalance(businessId)` | `mainDepositAccountId($1)` → `ledger_availability()` |
| what is held | `listHoldRows(accountId)` | `WHERE h.account_id = $1` |
| transactions | `listLedgerLines({businessId, accountCode:'2100'})` | `WHERE a.business_id = $1` |
| cards | `listCardsWithControls(businessId)` | `WHERE c.business_id = $1` |
| decisions | `listDecisions({businessId})` | `WHERE business_id = $1` |
| who holds which card | `readTeamScreen(businessId)` | `WHERE m.business_id = $1` |
| payees | `loadPayeeBook({businessId})` | `WHERE business_id = $1` |
| may they transact | `transactGateForBusiness(businessId)` | `WHERE business_id = $1` |

`listBusinesses()` is the one deliberate exception and it returns **names only**
— it feeds the switcher, which in a real deployment is the customer's own entity
list off their session. No figure on this surface comes from a query that spans
businesses.

**Why the distinction is not stylistic.** A predicate is evaluated by Postgres
before the rows exist. A filter is a step in a program, and steps get reordered,
short-circuited by an early return, or dropped by whoever next edits the paging
logic. `src/lib/api/limits.ts` already made this argument for the public API and
this surface obeys it — including where obeying it cost a feature (§4).

Two supporting choices carry it:

- **The contract has no tenant field on a row.** `src/components/client/
  contract.ts` deliberately gives `ActivityRow`, `HoldLine`, `CardLine` and the
  rest no `businessId`. A component cannot filter on a discriminator that does
  not exist. `ClientHeader.businessId` is the single exception and it names the
  *subject* of the screen.
- **The account is not a form field.** `/client/pay` sends the deposit account
  as a hidden input resolved on the server from the business the page is scoped
  to, rather than a dropdown of every account on the book. That is not a
  security control — a hand-written POST can carry any uuid, and the gates check
  it either way — it is a refusal to *offer* a choice that is not the
  customer's.

### Proven, not asserted

`src/components/client/ClientScreens.render.test.ts` (19 tests, `RUN_DB_TESTS=1`,
against Neon) renders every screen in every state with live data, and three of
its assertions are the isolation claim itself:

- a reference that does not exist → no payment, and a specific sentence;
- **a real pending payment belonging to another business on this book** →
  the *same* answer, byte for byte;
- a payment that does belong to this business → it renders.

The third matters as much as the second: without it, "it refused" would also be
satisfied by a screen that refuses everything — the same argument
`livefire.mjs --only 5` makes about maker-checker.

---

## 3. One definition of available

`ledger_availability()` (migration 0022) → `accountAvailability()` →
`businessAvailability()` → `availableBalance(businessId)`. This surface is the
**fifth caller of the one function**, and it computes nothing:

- the balance screen **restates** the subtraction Postgres already did; the
  total row prints the function's own `available_cents` rather than a sum of the
  rows above it, so there is no locally computed number that could one day
  differ;
- holds are listed for explanation and are never summed into a total;
- nothing is clamped at zero.

This is the property the system has failed before. It once held four definitions
at once, two of which printed on two screens at the same instant and differed by
**$25,040.70**, and an agent surface was later caught holding a fifth reading
**$17,035.50** above the customer's own screen. A customer-facing balance that
the staff console contradicts is the worst place for that bug to reappear, so
the balance screen states on its own face that it reads the same function the
bank's staff read.

**Money is `bigint` cents throughout.** The contract keeps cents as `bigint` all
the way to `<Money>`, which does integer `bigint` arithmetic — a departure from
`src/components/approvals/data-contract.ts`, which flattens to strings because
its consumer is a *client* component. Every view here is a server component, so
there is no serialisation boundary to survive and no reason to lose exactness
early. The two client components on this surface (`PaymentForm`, `ApproveForm`)
carry **no numbers on their props at all**: figures arrive as strings the server
formatted through `formatUsd`, and the amount leaves as the literal characters
somebody typed. There is no `/ 100` and no `toFixed` in
`src/components/client/**`.

One small consequence worth naming: the `?state=edge` amount prefill on
`/client/pay` is formatted **ungrouped** — `2500.00`, not `2,500.00`. A form
prefilled with a thousands separator round-trips to a parse failure, and that is
the exact pressure that put `(cents / 100).toFixed(2)` on a screen in this
repository once already.

---

## 4. The reader I needed and could not have

**`listQueue()` has no business predicate, so `/client/approvals` does not have
a queue.**

`listQueue({ pendingOnly, limit }, conn)` in `src/lib/approvals/instructions.ts`
is the only reader of pending payments in this build. It is platform-wide by
design — it feeds the operator console, which is supposed to span every business
— and `PaymentInstruction` does not carry a business id at all, only a
`businessName`. Measured against this database on 2026-09-11, the first eight
rows it returns belong to *Hold Fuzzer Fixture Co.* and rows nine and ten to
Ridgeline.

The obvious workaround is to call it and drop the rows that are not yours.
`src/lib/api/limits.ts:261` already considered and refused exactly that for the
public API:

> listQueue() is platform-wide: it feeds an operator screen and is called with
> an already-scoped session. The obvious workaround — fetch the queue and filter
> it in TypeScript against this business's account ids — is precisely the
> pattern mcp/gateway.ts refuses for reconciliation breaks… it makes tenant
> isolation a STEP rather than a PREDICATE, and a step can be reordered,
> short-circuited or dropped by whoever next edits the paging logic. On a public
> API that step is the only thing between one customer and another customer's
> payments.

A customer-facing queue is the same surface and the argument does not get weaker
for being on a screen instead of an endpoint. So `/client/approvals` does what
the public API does: **it answers for an id.** A payment raised on `/client/pay`
links straight here with its own reference, which is the path a customer
actually walks, and the point read is scoped by comparing the instruction's
account to this business — `readAccountIdentity`, one row, one id. A payment
belonging to somebody else produces the **same** answer as one that does not
exist, so the screen cannot be used to discover which references are real.

### What would fix it

One `WHERE` clause, in the file that defines what a queued payment is:

```ts
export type QueueQuery = {
  readonly businessId?: string;      // <- this
  readonly pendingOnly?: boolean;
  readonly limit?: number;
};
```

```sql
 WHERE (${query.businessId ?? null}::uuid IS NULL
        OR acc.business_id = ${query.businessId ?? null}::uuid)
   AND <the existing pendingOnly predicate>
```

The query already joins `account acc` for exactly this row, so the predicate is
one line from where it belongs. `PaymentInstruction` should gain `businessId`
beside its existing `businessName` at the same time.

It is not mine to write — `src/lib/**` belongs to other workers on this build —
so it is reported here, named on the screen itself in prose a reader will meet,
and documented in the header of `readApproveScreen()`. **The screen says out
loud why it has no list**, because a queue silently filtered in the renderer is
worse than a queue that is not shown.

### Two smaller notes on readers

- `listQueue()` is read **once** in this workstream, inside
  `ClientScreens.render.test.ts`, deliberately: it is the fastest way to lay
  hands on an instruction that genuinely belongs to another tenant so the test
  can prove the screen refuses it. A test may look across tenants to prove a
  screen does not.
- `readApproveScreen()` takes the **actor as a parameter** rather than calling
  `currentActor()`, which reads `cookies()` and throws outside a request scope.
  That is the house shape already —
  `createLivePaymentsSource().getFormData(actor)` does the same — and it is what
  makes the isolation assertion above runnable at all. The cookie is read in
  `sources.ts`, inside the request, through `currentActorForRequest()`.

---

## 5. The role switcher: a business selector, not a third role

**Decision: the switcher keeps its two entries, and the customer arrives as a
`?business=` *subject* on a separate surface.**

### The argument

**Role and tenant are different axes.** Staff / Approver answers *what may I do
inside this bank* — it resolves by `SELECT … WHERE kind = 'human' AND
business_id IS NULL AND can_approve = <bool>`. A customer answers *whose book is
this*, which resolves on a different column entirely: `business_id`. Putting
"Customer" third in that control would imply a customer is a more-or-less
privileged staff member, and the model a UI teaches is the model the next
engineer codes to. The code that follows from that mental model is
`if (role === 'customer') rows = rows.filter(…)` — isolation as a step, which is
the exact failure §2 exists to prevent.

**The switcher must not become an authorisation mechanism, and one control
resolving two predicates is how it would.** Today the cookie grants nothing
because resolution is a `SELECT … WHERE can_approve = …`: editing the cookie by
hand cannot produce an approving actor that is not already a seeded row. If the
same control also selected a tenant, the isolation-bearing predicate would be
chosen by a value the browser sets — and the one predicate that must never be
attacker-controlled would be sitting in the same widget as one that safely is.

**A customer is not one person.** Ridgeline's team already has a signer, an
approver and cardholders, modelled in `team_member` with their own terms and
their own limits. "Customer" as a single role is under-specified; *which
business* plus *which of that business's people* is the real shape, and `/team`
already holds the second half. The build's own decision log agrees: the
customer's signer, **Alex Whitfield** (`actor.business_id = Ridgeline`), exists
on this book and is **deliberately** not reachable from the switcher, because
"a bank employee and a customer signer are different principals and conflating
them in a demo is how a demo teaches the wrong model"
(`src/lib/approvals/session.ts`).

### What this build actually does, said plainly

There is **no authentication anywhere in this deployment** — `docs/DEMO.md` §1,
"There is nothing to sign into". So:

- `?business=` is a **demo control**, exactly like the role cookie, and the
  client layout says so in capitals on every one of the five screens. It reveals
  nothing `/accounts` does not already show a stranger.
- What makes it safe to ship *today* is that it does not grant a view: it
  chooses the subject of a query whose isolation is already a `WHERE` clause.
- The person acting on `/client` is still the staff actor the cookie resolves,
  and the banner says which one and why. Rendering a customer surface behind a
  fake login would be dressing up a boundary that is not there; a surface that
  *looks* sealed and is not is the dishonest option.

**What replaces it is one line.** `businessId` stops coming from `searchParams`
and starts coming from a verified session claim. Every read beneath it is
unchanged, because every read already treats the id as a predicate the database
applies rather than as permission the screen grants. That is the same sentence
`session.ts` writes about `resolveActor()`, and it is true here for the same
reason.

### What did change in the shell

- `NavLinks` carries the five client routes — `NavLinks.test.ts` requires it,
  and it is the honest requirement: a screen carried in a list but painted
  nowhere is the failure that test exists to catch. They render as their own
  dashed **Customer** group rather than mixed into the console's nav, because a
  customer surface and an operator console are different products and a reader
  should see the seam.
- `AppHeader`'s scope line became `ScopeLine`, a route-derived component. The
  constant read "Staff console — all businesses on this book", which was true of
  every page under it until `/client` shipped and false for five of them. That
  bar has printed a wrong answer to "whose books am I looking at?" once before
  in this repository; a constant cannot tell the difference and a route can.
  It changes no query and grants nothing.

---

## 6. The five states, per screen

`default` and `edge` are **live** everywhere. `loading` is the real read held
open for six seconds behind a real Suspense boundary — the skeleton is the
component's own, not a mock of one. `empty` and `error` are labelled fixtures,
because arranging them live means finding a customer with no money or taking the
database down, and every fixture prints **FIXTURE** on its face and reports
`live: false` in its own header.

| Screen | `edge` |
| --- | --- |
| `/client` | **LIVE. Available is NEGATIVE while the ledger balance is POSITIVE.** Kettle & Crumb Bakery LLC, measured 2026-09-11: ledger $45,301.36, card holds $520.00, uncleared credits $55,500.00, available **−$10,718.64**. Money has landed and not cleared. Correct, real, and never clamped — the screen explains the position rather than rounding it up to zero, because "$0.00 available" would hide the size of the hole from the person who has to manage it |
| `/client/activity` | LIVE, filtered to the corrections: a settlement taken back, beside the entry it reverses, both still on the record |
| `/client/cards` | LIVE, filtered to the declines, each with the sentence it was recorded with |
| `/client/pay` | LIVE, prefilled at exactly the approval threshold |
| `/client/approvals` | LIVE. The same payment judged for whoever you are acting as — including the refusal when that is the person who raised it |

The edge business on `/client` is addressed by a fixed id —
`uuid5('business:kettle-and-crumb')`, derived by `scripts/seed.mjs` from a fixed
namespace, so it is the same id on any seeded book. **That is deliberate and it
is the point of the surface:** finding "the business with a negative available
balance" means asking that question of every business on the book, which is the
cross-tenant read nothing here is allowed to do — not even for a demo control.
An explicit `?business=` always wins over it, including on `edge`: a reader who
chose a customer and then clicked a state has not asked to be moved to a
different company.

---

## 7. Money out: the same path, different words

`/client/pay` posts to **`raisePaymentAction`**, imported from
`src/app/(app)/payments/actions.ts`. Not copied — imported. So the KYB gate, the
payee confirmation, the pinned `policy_id`, the content hash over (account,
rail, amount, destination, value date) and the idempotency key derived from the
reference all apply unchanged, because none of them is applied on this screen at
all: they are applied inside one transaction in `requestPayment()`, and this is
one more caller alongside the console, the MCP write tool, the standing-order
runner and the public API. **There is no second money-out path in this build.**

`/client/approvals` posts to **`decideAction`** from
`src/app/(app)/approvals/actions.ts`, the same way, and reuses `decisionGate()`
and `releaseGate()` for the pre-flight sentences rather than restating the rule.

Two deliberate asymmetries, both the same asymmetry the staff console makes:

- **The approve button is disabled when the gate refuses**, with the reason
  attached by `aria-describedby`. That refusal is a settled fact about *you*.
- **The send button is NOT disabled when the KYB gate refuses.** That refusal is
  a fact about the *business*, read outside any transaction seconds ago, and
  re-taken inside `requestPayment()`'s own transaction. A form that pre-empted
  it would be the screen claiming to know an answer only the database has.

Neither is the control. Both refusals are enforced by Postgres —
`assert_maker_checker()` raising SQLSTATE `42501` for the first, `canTransact()`
inside the write transaction for the second — and a POST assembled by hand with
none of this markup reaches the same triggers and is refused by the same
exceptions.

### The refusal reads as a sentence

`classifyRefusal()` translates the exception; the raw Postgres text never
reaches a screen. A customer who tries to approve their own payment is told:

> You raised this payment, so you cannot approve it. Maker-checker needs a
> second person: the initiator is never the checker.

with the code printed small beside it so a support call has something exact to
quote, and the SQLSTATE carried into the structured log where it belongs.

---

## 8. What the customer is never shown

- **Another customer's anything.** Asserted by the test, against real foreign
  rows.
- **A chart-of-accounts code.** `2100` does not appear on the balance screen;
  a render test asserts the absence of `2100`, *memo* and *journal* from the
  prose.
- **A full account number.** Destinations render as "account ending 8801"; the
  schema only ever stores the last four.
- **A rewritten decline reason.** `card_auth_decision.reason` is rendered
  verbatim. There is no rule-to-sentence lookup table in this build and this
  surface does not start one — the sentence was written inside the issuer's
  measured 6000 ms deadline by the function that made the decision, and it is
  the sentence a dispute is answered from six months later. A second copy in the
  UI would drift, and the drift would be discovered by a cardholder being told
  two different things.
- **A limit of zero dressed up as "no limit".** `null` and `0n` render as
  different sentences. The obvious `limit || "no limit"` fails open on the
  dangerous one.
- **A date that crashes the page.** Every date on this surface goes through
  `isoOrNull()`. A dispute's provisional credit is a hold whose `available_at`
  is `'infinity'`, and one unguarded `.toISOString()` on it took Ridgeline's
  account screen down with an error card (`docs/DEMO.md` §5.1). Here it renders
  as "released by a person", which is what `infinity` actually means.

---

## 9. Known limits

1. **No queue on `/client/approvals`.** §4, with the fix written out.
2. **No authentication.** §5. The business selector and the role cookie are both
   demo controls and both say so on screen.
3. **`/client` is rendered inside the open staff console**, under its header and
   its provider-health banner. It is not a separate origin and does not pretend
   to be one.
4. **The activity feed is the deposit account only** (`accountCode: '2100'`).
   Pot sub-accounts are coded `2100.<uuid>` and are excluded by construction: an
   internal earmark is not a transaction, it is the same money in a different
   shape. A customer's pots are visible on the staff `/pots` screen and have no
   customer screen yet.
5. **Statements and reconciliation have no customer screen.** The brief's third
   sentence — "reconcile the scheme file" — is an operator's job on this book
   and `/reconciliation` does it; a customer-facing statement download is the
   obvious week-two item and is not built.
6. **The five URL states were verified by render test, not by HTTP.** The shared
   `next dev` server on this machine had been up for eight hours answering 500
   to every route in the build — its own and everybody else's — over a stale
   `Can't resolve 'zod'` that was false when it was raised. The render test
   drives the same components with the same values against the live database;
   what it does not cover is the handful of lines in each `page.tsx` that choose
   between them, which are type-checked and branch-free.
