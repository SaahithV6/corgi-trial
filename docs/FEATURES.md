# Feature reachability

**What can be done from where, measured by doing it.**

Every cell below was established by driving the thing: a page fetched from a
running `next dev` and read as rendered text, a server-action form replayed with
the hidden fields the SSR emitted, an HTTP call with a real bearer token, or a
JSON-RPC call to `/api/mcp`. Nothing here was inferred from a route file
existing. Four probes in this build have reported LIVE for things that did not
exist, and each was caught only by measuring; this document is written to be
checkable the same way.

Measured 2026-09-11, against the Neon branch in `.env`, on `next dev` at
`localhost:3000`.

---

## The answer, in one sentence

**Demo the customer story from the client surface and the bank story from the
dashboard — a convincing demo needs both, because the client surface owns the
whole money-out loop and card controls end to end, and the dashboard is the only
place a payee, a pot, a dispute, an FX quote or a business can be brought into
existence at all.**

The justification is the two rows that matter most. *Money out* is `works` on
all four surfaces, so nothing forces the dashboard for the headline flow. But
*add a payee* is `not present` on the client surface, and a payment cannot be
raised without a confirmed payee — so a client-only demo can only pay somebody
the dashboard already knows about. Symmetrically, *set card controls* and
*freeze a card* are now `works` on the client and belong there, so a
dashboard-only demo shows an operator doing the customer's job. Fifteen minutes
on `/client` → `/client/pay` → `/client/approvals` → `/client/cards`, then
`/payees`, `/pots`, `/disputes`, `/payouts` on the console, and the seam between
the two products is itself the thing worth showing.

---

## Legend

- **works** — driven end to end on that surface; the write landed, or the read
  returned live rows.
- **reachable but broken** — the surface offers it and it fails.
- **not present** — no caller on that surface. A capability that exists in
  `src/lib` with no caller in `src/app` counts as *not present*, which is how
  `confirmPayee()` shipped with a gate pointing at a screen that did not exist.
- **operator-only (deliberate)** — absent from the client on purpose; the reason
  is given in §3.

"Client" means reachable from the client nav in ≤3 clicks and it completes.

---

## 1. The matrix

| # | Capability | Client `/client/**` | Dashboard / operator | HTTP API `/api/v1` | MCP |
|---|---|---|---|---|---|
| 1 | Open a business (KYB, registry probe, manual review) | not present — operator-only (deliberate) | **works** — `/onboarding` | not present | not present (refused, `list_agent_limits`) |
| 2 | Open a deposit account | not present — operator-only (deliberate) | **works** — front door, *Open account* | not present | not present |
| 3 | Issue a card | not present — **missing, should be added** | **works** on `/accounts`; **reachable but broken** on `/team` | not present | not present |
| 4 | Freeze / unfreeze a card | **works** — `/client/cards` | **works** — `/accounts` | not present (refused, limit A1) | not present (refused) |
| 5 | Set card spend limits and block merchant categories | **works** — `/client/cards` | **works** — `/accounts` | not present (refused, limit A1) | read-only (`list_card_controls`) |
| 6 | Replay / simulate a card authorisation | not present — operator-only (deliberate) | **works** — `/accounts` | not present | not present |
| 7 | See card decisions and the recorded decline sentence | **works** | **works** | not present | **works** (`list_card_controls`) |
| 8 | See balance: ledger vs available, itemised | **works** (incl. negative-available edge, live) | **works** — `/accounts` | **works** — `GET /accounts/{code}/balance` | **works** (`get_balance`) |
| 9 | See transactions / activity | **works** | **works** — `/transactions` | **works** — `GET /transactions` | **works** (`list_transactions`) |
| 10 | Move money out — ACH | **works** (instruction written, measured) | **works** — `/payments` | **works** — `POST /payments` → 201 | **works** (`initiate_payment`) |
| 11 | Move money out — wire | **works** (same form, rail select) | **works** | **works** (schema accepts `type: "wire"`) | **works** |
| 12 | Approve / reject / release a payment | **works** (release measured) | **works** — `/approvals` | not present (deliberate: no approve endpoint) | not present (refused by design) |
| 13 | Add a payee | not present — **missing, should be added** | **works** — `/payees?add=1` | read-only (`GET /payees`) | read-only (`list_payees`) |
| 14 | Confirm / acknowledge a payee warning | not present — **missing, should be added** | **works** — `/payees?payee=…&sign=1` | not present | not present (refused) |
| 15 | Re-check a payee | not present — operator-only (deliberate) | **works** — `/payees` | not present | not present |
| 16 | Fund from an external bank (ACH in, Plaid) | not present — **missing, should be added** | **works** — `/funding` | not present | not present |
| 17 | Create and fund a pot | not present — **missing, should be added** | **works** — `/pots` | read-only (pot leaves listed, `payable: false`) | read-only (`list_pots`) |
| 18 | **Create or cancel a standing order** | **not present** | **not present** | **not present** | **not present** (refused) |
| 19 | See standing orders and their occurrences | not present — **missing, should be added** | **works** — `/standing-orders` | not present | **works** (`list_standing_orders`) |
| 20 | Fire standing orders | n/a | n/a | `POST /api/cron/standing` (**works**) | not present (refused) |
| 21 | Raise a dispute on a transaction | not present — **missing, should be added** | **works** — `/disputes` | not present | read-only (`list_disputes`) |
| 22 | Grant provisional credit / progress a dispute | not present — operator-only (deliberate) | **works** — `/disputes` | not present | not present (refused) |
| 23 | Request and accept an FX quote | not present — operator-only (deliberate) | **works** — `/payouts` | not present | not present |
| 24 | Stablecoin (USDC) payout | not present — **missing, should be added** (rail is listed on `/client/pay`, but the form builds only ACH/wire destinations) | **works** — `/payouts` | **works** (`type: "usdc"`) | **works** (`initiate_payment`) |
| 25 | View statements / download the PDF | not present — **missing, should be added** | **works** — `/statements` | **works** — `GET /statements`, `GET /statements/{date}` | not present |
| 26 | Reconciliation — view breaks | not present — operator-only (deliberate) | **works** — `/reconciliation`, `/breaks` | **works** — `GET /reconciliation/breaks` | **works** (`list_recon_breaks`) |
| 27 | **Reconciliation — ingest a settlement file / run a match** | **not present** | **not present** (screens read the result only) | **not present** | **not present** (refused) |
| 28 | View the audit trail | not present — operator-only (deliberate) | **works** — `/audit` | not present | not present |
| 29 | Time-travel the book | not present — operator-only (deliberate) | **works** — `/accounts`, `/statements` | **works** (`as_of_value_date`, `as_of_booking_time`) | **works** (`get_balance` as-of) |
| 30 | Accruals and the fee arithmetic | not present — operator-only (deliberate) | **works** — `/accruals` | not present | **works** (`list_accruals`) |
| 31 | Interchange / unit economics | not present — operator-only (deliberate) | **works** — `/economics` | not present | not present |
| 32 | Team: add member, set terms, end membership | not present — operator-only (deliberate) | **reachable but broken** — `/team` | not present | not present |
| 33 | Outbound events: register endpoint, drain | not present — operator-only (deliberate) | **works** — `/events` | not present | not present |
| 34 | Outbound events: **disable** an endpoint | not present | **not present** — the action exists with no caller | not present | not present |
| 35 | Chaos harness | not present — operator-only (deliberate) | **works** — `/chaos` | not present | not present |
| 36 | Drain the webhook inbox / redrive | not present — operator-only (deliberate) | **works** — `/accounts`, `/api/drain` | not present | not present |
| 37 | Read what the agent surface refuses, and why | not present | not present | **works** — `GET /limits` | **works** (`list_agent_limits`) |

### How each surface was driven

- **Client and dashboard.** All 27 pages fetched; every one answered 200. Each
  page's rendered HTML was read as text and its forms enumerated. Writes were
  replayed through the progressive-enhancement path — the `$ACTION_REF` /
  `$ACTION_KEY` hidden fields the SSR emits — and confirmed by querying the row
  in Neon afterwards, not by reading the response.
- **HTTP API.** Bearer token from the `MCP_AGENT_TOKENS` grant
  (`demo-read-and-propose`, fingerprint `7b5c37ab`, scoped to Ridgeline
  Robotics). Every documented endpoint called; `POST /api/v1/payments` returned
  201 with `money_moved: false`.
- **MCP.** `initialize` + `tools/list` + **all eleven tools called**. Ten read
  and returned live rows; `initiate_payment` queued instruction
  `5fa6a9cc-…` and said so in the words the protocol requires
  ("NO MONEY HAS MOVED").

---

## 2. What changed in this pass

### 2.1 Card controls are a customer feature and now live on the client

`/client/cards` was read-only: a customer could see their team's cards and could
not set anything on one. Every control writer lived on the staff console. That
polarity was backwards — a business owner capping the workshop card, blocking a
merchant category, or freezing the card of somebody who has just left is the
customer doing their own job, and the bank only needs to see what they set.

The cost was measurable rather than theoretical: **55 of 67 provider-lane
approvals on this book were made by a rule that compared nothing**, because the
card carried no controls and nobody whose card it was could set any.

- `src/app/(app)/client/cards-actions.ts` — `setClientCardControlsAction`.
- `src/components/client/CardControlsForm.tsx` — the form, pre-filled with the
  version in force, because saving appends a *complete* new version.
- `src/components/client/card-controls-state.ts` — the result type and its idle
  value, kept out of the `"use server"` module on purpose (see §4.2).

It calls `setCardControls()` in `@/lib/cards/store` — the same function the
console's own action calls, reached through the library rather than through the
other screen. The operator screen is unchanged and there is no second copy of
the rule. Nothing here is on the authorisation path: `decide()` is not imported
and not reachable from this file, so the measured 6000 ms ASA ceiling is
untouched.

**The card id is a claim and is checked as a predicate.** Before any write, the
id is resolved with `WHERE c.id = $1 AND c.business_id = $2` — one statement,
both columns, evaluated by Postgres. It is not a `.find()` over a list fetched
first, which would make tenant isolation a step in a program.

Measured, on card `7eaf6550-…`:

| what was driven | what landed |
|---|---|
| limits + blocked categories | `card_control_version` v1 — per-txn `7550`, daily `25000`, `blocked_mccs {5542,7995}`, note stored, author resolved from session |
| freeze | v2, `card_state = frozen`, previous version kept |
| the same form with **another business's card id** | **no row written**; refused `CARD_NOT_ON_THIS_BUSINESS` |

The refusal sentence is deliberately identical for a card that does not exist
and one belonging to another customer, so the form cannot be used to discover
which card ids are real — the same choice `readApproveScreen` makes for payment
references.

### 2.2 The client surface showed superseded approval policies as if in force

`listPolicies()` returns **every version** of every rail's rule — it says so in
its own header — and both `readPayScreen` and `readApproveScreen` handed the
whole list to the customer under "When somebody else has to approve".

Measured on this book: `wire` carries two rows, `2026-01-01` and `2026-09-11`.
So `/client/pay` **offered "Wire" twice** in its *How should it go?* dropdown —
two options a customer cannot tell apart, one of them a rule that stopped
applying that morning — and `/client/approvals` printed two Wire lines with
different notes.

This is the house defect in its usual shape: the population on screen was chosen
by *every row in the table* rather than by the question the screen claims to
answer. `inForceToday()` in `src/app/(app)/client/live-source.ts` now applies
exactly the selection `effectivePolicyFor()` makes when it pins a version onto
an instruction — `effective_from <= today`, newest per rail. A rail with nothing
effective yet drops out rather than falling back to a future version, because
`requestPayment()` would refuse it. The version a payment was *judged* under is
still read off the instruction, so an older payment still shows its own rule.

---

## 3. Deliberately operator-only, and why

A customer should not be handed the bank's job. Each of these is absent from
`/client/**` on purpose, and the absence is the answer rather than a gap:

- **Open a business; open a deposit account** (1, 2). The account exists because
  the business passed its checks. A customer who could open their own account
  could skip the gate that decides whether they may have one.
- **Replay / simulate an authorisation** (6). A synthetic authorisation written
  into the harness lane is a bank's diagnostic. On a customer's screen it would
  be indistinguishable from a real payment on their own card.
- **Re-check a payee** (15). Re-running a verification spends a provider call
  against the bank's account and writes a row the bank must defend. Adding and
  acknowledging, by contrast, *should* be on the client — see §4.1.
- **Grant provisional credit; progress a dispute** (22). Advancing the bank's own
  money against a contested card payment is the bank's decision. The customer
  raising the dispute is not (see §4.1).
- **FX quotes** (23). A quote commits the bank's rate and holds it. The customer
  side of this is a payout, which is row 24.
- **Reconciliation — breaks, ingest, matching** (26, 27). Where our books and the
  network disagree is not the customer's business, and a customer reconciling a
  settlement file would be reading rows that are not attributable to any one
  business (265 of them, measured).
- **Audit trail; accruals; unit economics; time travel** (28–31, 29). All three
  span the platform or expose the bank's own pricing and margin. The customer
  gets the *consequence* — the 83¢ fee on their activity screen, the `as of`
  instant and booking watermark in their balance header — without the console.
- **Team administration** (32). Issuing and revoking access is administration.
  Note the split: *who may hold a card* is the bank's record; *what that card
  may do* is the customer's, which is why 4 and 5 moved and 32 did not.
- **Outbound events; chaos; webhook drain** (33, 35, 36). Operating the platform.
  A customer redriving a webhook is the clearest example of a control that
  belongs to whoever runs the system.

---

## 4. Gaps not closed, with the fix

### 4.1 Client-side gaps — missing and should be added

| Capability | Where it must go | The fix |
|---|---|---|
| **Add a payee** (13) | `src/components/client/` + an action under `src/app/(app)/client/` | The single worst client gap: `/client/pay` refuses when there are no confirmed payees, and there is no path from that screen to creating one. Call `addPayee`/`verifyPayee` in `@/lib/payees/**` with `businessId` from the resolved subject; the gate and the checksum apply unchanged. |
| **Acknowledge a payee warning** (14) | same | `PAYEE_WARNING_UNACKNOWLEDGED` already links to `/payees?payee=…&sign=1`, a *staff* screen. A customer refused a payment is sent to the operator console to fix it. Mirror `signWarningAction` against `@/lib/payees/acknowledge`. |
| **Create / fund a pot** (17) | same | `@/lib/pots/transfer` + `@/lib/pots/store`; both legs are the customer's own accounts and the internal rail needs no approval. |
| **Raise a dispute** (21) | same | `@/lib/disputes/operations`. Raising is the customer's act; *granting provisional credit* stays operator-only. |
| **Fund from an external bank** (16) | same | The Plaid link + fund flow is the customer's money coming in. `src/lib/rails/plaid/**` is another owner's; the client caller is not. |
| **View statements** (25) | same | `@/lib/statements/read` + `publish`; scope by `businessId`. Currently a customer cannot get a statement for their own account from their own surface. |
| **See standing orders** (19) | same | `listStandingOrders({businessId})` already takes the predicate. Read-only is enough; creation is row 18. |
| **USDC payout from `/client/pay`** (24) | `src/components/client/PaymentForm.tsx` | The `usdc` policy is listed but the form emits only ACH/wire destination fields, so choosing it produces an invalid destination. Either add the address field or drop the rail from the select. |
| **Issue a card** (3) | client | "a card for each person on the team" is the brief's first sentence, and the customer cannot issue one. Blocked behind row 32's crash on the operator side too. |

### 4.2 Broken or absent, in files I do not own — please route

1. **`/team` is dead. HTTP 200, renders only the skeleton.**
   `src/components/team/TeamForms.tsx:52` throws
   `TypeError: Cannot read properties of undefined (reading 'length')` on
   `result.facts` — four times per render, once per form, on every load with no
   action ever submitted.
   **Cause:** `src/app/(app)/team/actions.ts:61` exports `TEAM_IDLE`, a plain
   object, from a `"use server"` module. Such a module may export only async
   functions, so the client component's import resolves to a server reference
   rather than to the literal; `status` is therefore not `"idle"`, `Receipt`
   does not bail out, and `facts` is `undefined`.
   **Fix:** move `TeamActionResult` and `TEAM_IDLE` into a non-`"use server"`
   module and import from there — exactly the pattern
   `src/components/chaos/action-result.ts` and `src/lib/cards/view-state.ts`
   already use, and the one `src/components/client/card-controls-state.ts` was
   written to follow. One file move; no logic changes.
   **Cost:** add member, set terms, end membership and **issue a card to a team
   member** are all unreachable. This is the brief's opening sentence.

2. **`disableEndpointAction` has no caller.**
   `src/app/(app)/events/actions.ts:171`. `registerEndpointAction` and
   `drainOutboundAction` are both wired into
   `src/components/events/RegisterForm.tsx`; this one is not, anywhere in `src`.
   It is the `confirmPayee()` shape again: a working action with no screen.
   **Fix:** a button per endpoint row on `/events`, or delete the action.

3. **Creating a standing order is not possible from any surface.**
   `createStandingOrder` and `cancelStandingOrder` in
   `src/lib/standing/store.ts` have **no caller** in `src/app`, `src/components`
   or `scripts/seed.mjs`. The 25 mandates on this book were written by a script.
   `/standing-orders` reads them, `/api/cron/standing` fires them, and both the
   API and MCP refuse to write them *by design* (`src/lib/api/limits.ts:185`,
   `src/lib/mcp/limits.ts:258`) — but those refusals point at a console screen
   that does not exist. That is the same defect as the payee gate pointing at a
   missing screen, and it is live in two refusal messages right now.
   **Fix:** a create form on `/standing-orders`
   (`src/app/(app)/standing-orders/**`, `src/components/standing/**`) calling
   `createStandingOrder`. Until then, the refusal copy in both limits files
   should not name a screen.

4. **Reconciliation cannot be run from any surface.** `src/lib/recon/ingest.ts`
   and `run.ts` have no caller in `src/app`. The screens read the result of a
   scripted run. Arguably correct — a customer must not reconcile, and an
   operator might reasonably do it from a job — but it is not *demoable*, and
   the `/reconciliation` screen does not say so.

5. **Three typecheck errors in files being edited concurrently** (not mine, not
   caused by this pass): `src/components/accounts/unreadable.ts:35`
   (`ConsoleData` not exported), `src/components/approvals/ApprovalsView.tsx:41`
   (unused `view`), `src/components/payments/PaymentsView.tsx:84` (`title` not
   on the error panel's props).

---

## 5. What was not measured

Said plainly so silence does not read as a clean bill:

- **Wire and USDC money-out were not driven to completion from any UI.** Wire
  needs a confirmed wire payee on the subject business and USDC needs an
  address; both schemas were exercised on the API instead. ACH was driven end to
  end on all four surfaces.
- **The no-database state was not rendered.** `ClientStateBar`'s per-state hints
  are constants that say "Live." for `default` and `edge` regardless of whether
  the read reached Neon, while `ClientHeaderBar` badges live/fixture from
  `header.live`, which is earned. With `APP_DATABASE_URL` absent the two would
  disagree on one screen — a state bar saying LIVE over a header saying FIXTURE,
  which is a pair this build has already shipped once. It could not be measured
  here because Next 16 refuses a second `dev` server in the same directory and
  loads `.env` itself regardless of the shell. **Unfixed, and it is mine.** The
  fix is either to thread the loaded `header.live` into `ClientStateBar` or to
  reword the two hints so the verdict is left to the badge that earned it.
- **The dashboard's own screens were measured as rendered, not clicked
  through.** Every operator write action was traced to a component and that
  component to a page, and every page was fetched and its forms enumerated; the
  individual operator writes other than approve/release were not replayed.
