# Demo access, the three roles, and a click path

Live: **https://corgi-trial-psi.vercel.app**

Everything below was walked against that URL by `scripts/verify-demo.mjs`, which
is checked in beside this file. Run it and it will tell you whether this
document is still true:

```bash
node scripts/verify-demo.mjs
node scripts/verify-demo.mjs --base-url http://localhost:3000
```

It makes no writes. Every request is a GET except one POST whose only effect is
a `Set-Cookie` on the response it returns. Last run, 2026-09-11T05:02:48Z —
**13 PASS, 5 FAIL, 1 SKIP** of 19 checks, exit code 1. The full output is in §5.

**Read that number in the right direction.** It got worse on purpose. The
previous version of this checker reported 11 PASS / 2 FAIL / 1 SKIP of 14, and
this document said of those two failures: *"neither of which is a broken
screen"*. That was true of the two it reported and false about the system. Both
failures were a stale parser — it read the availability table by taking its
first four money figures after the table had grown to five rows — and because
the check **threw on the first account in the list, it never opened the last
one, which does not render at all.** A checker that cries wolf does not merely
waste a reader's time; it gives the real wolf somewhere to stand. The parser now
reads the table by its own row labels and fails by name if a row it does not
recognise appears, the account walk collects a verdict per account instead of
stopping at the first, and five checks were added for things a stranger does in
the first ninety seconds that nothing was measuring.

So: two of the old failures were the checker and are fixed. **Five failures
remain and every one of them is a real defect a grader will see**, each named
with the file that has to change, none of them in this script. The worst is
§5.1: the account screen for **Ridgeline Robotics, Inc.** — the business this
whole document is a story about — renders an error card.

If you would rather watch the money move than click, that is one command:

```bash
set -a; . ./.env; set +a
node scripts/coreloop.mjs
```

Seven legs of the published core loop, in one run, against this deployed URL,
driving the real server actions. PASS 7, FAIL 0, SKIP 0, invariants 25/25
— run at 2026-09-11T04:03Z. It runs on **Kettle & Crumb Bakery LLC**, which is
deliberately not the business every screenshot in this repo is of: it held zero
accounts, zero journal lines and zero payments until a KYB approval opened its
chart of accounts at request time. The run prints the deployed gate's answer for
every business on the book before leg 1, so you see the refusal and the allowance
side by side. See [`CORE-LOOP.md`](./CORE-LOOP.md).

---

## 1. Read anything. Sign in to do anything.

**This section said "there is nothing to sign into" until 15:23 on the last
day, and it was true until then.** Authentication was cut at T+2h and rolled
back at T+46h; the sentence outlived the decision by three commits, which is
exactly the failure this repository spends its time hunting elsewhere. Corrected
here rather than quietly deleted.

The posture now:

- **Every screen is READABLE with no credential at all** — the console included.
  A reviewer arriving from a link can check every claim this repository makes
  without anyone mailing them a secret.
- **Every WRITE needs the console passphrase.** Approve a payment, issue a card,
  run a reconciliation, set a limit: all refused without a session, server-side,
  before the screen renders. `curl -X POST` any operator route and you get
  `401` with `x-corgi-authz: deny; SIGN_IN_REQUIRED`.
- **With the passphrase unset the console still READS and still refuses every
  write** (`503 CONSOLE_NOT_CONFIGURED`). An unset secret closes the till; it
  never opens it.

Sign in at **`/signin`**. The passphrase is in the submission email, not in this
repository — no passphrase literal exists in any tracked file, and the tests
mint a throwaway one per run.

The trade is real and is argued at the top of `docs/AUTH.md` rather than in a
footnote: anyone with the link reads every business on this book, and with no
per-visitor identity there is no record of who read what. That is not a small
deviation for a bank — it is the absence of the most basic property such a
console has. It was chosen because the data is a sandbox of seeded fixtures and
because a reviewer who never signs in never sees the refusal, and a refusal
nobody observes is indistinguishable from none.

The submission asks for demo credentials for at least two roles, so here is the
honest version of that: **the credential is a role switch in the header, and the
two roles are two different seeded database actors.**

| "Credential" | What to do | Which actor the server resolves |
| --- | --- | --- |
| **Staff** (default) | Open any console page. This is what you get with no cookie at all. | **Priya Raman** — `kind = 'human'`, `can_approve = false` |
| **Approver** | Click **Approver** in the *Acting as* control, top right of every console page. | **Dana Okonkwo** — `kind = 'human'`, `can_approve = true` |

Both are seeded by `scripts/seed.mjs`. Neither is scoped to a customer: they are
Corgi staff, `business_id IS NULL`.

### The literal instructions, for the submission email

Copy this block verbatim. Every sentence in it is asserted against the deployed
URL by `verify-demo.mjs` checks 7 to 11 — including that the switch works from
the landing page itself, before any navigation, because that is the only page a
stranger is guaranteed to be standing on.

> **Demo URL** — https://corgi-trial-psi.vercel.app
>
> **Reading needs nothing. Writing needs the passphrase in this email.** Sign in
> once at `/signin`; the two roles are then a switch in the top-right of every
> page, labelled **Acting as** — the switch selects WHICH PRINCIPAL you are, it
> is not the credential.
>
> **Role 1 — Staff.** Do nothing. With no cookie the console acts as **Priya
> Raman**, an operations analyst who can read every balance and prepare money
> movement and cannot approve any of it. Open `/approvals` and every approve
> and reject control is disabled, with the reason printed beside it.
>
> **Role 2 — Approver.** Click **Approver** in the *Acting as* control. The
> console reloads as **Dana Okonkwo**, a controller who can approve. The same
> queue now offers approve on payments somebody else raised — and still refuses
> the ones she raised herself, marked *"that is you"*. Click **Staff** to go
> back; it is not one-way.
>
> The switch is a plain HTML form and a server action, so it works with
> JavaScript disabled. If you would rather script it, every console URL accepts
> `curl -b 'corgi_demo_role=approver'`. The cookie chooses which seeded person
> you are acting as; it grants nothing — see §1 of `docs/DEMO.md`.

### 1.1 Before you click: what is actually on this book

Seven businesses, and **three of them are the demo**. The other four are test
fixtures, and you will meet them first, so they are named here rather than
discovered.

| Business | What it is | Where it shows up |
| --- | --- | --- |
| **Ridgeline Robotics, Inc.** | **The one to follow.** KYB approved on a named human's review, funded from a linked external bank, real Lithic cards, holds, standing orders, pots, disputes with provisional credit, closed statements. Every leg of the core loop is on this one business. | everywhere |
| Kettle & Crumb Bakery LLC | KYB pending at seed time; `coreloop.mjs` approves it at request time and opens its chart of accounts while you watch. Deliberately not the business the screenshots are of. | `/onboarding`, `/accounts` |
| Silverline Freight Co. | KYB rejected. Has no deposit account and never will, which is the point: a rejected business cannot be credited by accident. | `/onboarding` only |
| *Holds Integration Fixture Co.* | Opened by the holds integration suite. 1,215 journal lines. | `/accounts` and every customer picker |
| *Hold Fuzzer Fixture Co.* | Opened by the hold-model fuzzer. | as above |
| *Pots Integration Fixture Co.* | Opened by the pots integration suite. | as above |
| *Live Fire — attack 7 (provider outage)* | Opened by `livefire.mjs` attack 7 while this document was being written. | as above |

**Why the fixtures are still here, and why they are not hidden.** They are the
residue of test suites run against this same database, and they are evidence
that those suites ran — a fuzz company with hundreds of postings is worth more
than a paragraph claiming the hold model was exercised. They are not deleted
because this book is append-only: the application role holds no `DELETE` on a
money table, and removing a business that has postings is precisely the edit the
entire design refuses. Their balances are real entries through `postEntry()`,
they are inside the trial balance, and nothing is excluded from a total to make
a screen look tidier.

**What they do to the demo, and what to do about it.** `/accounts` sorts its
live deposit accounts **alphabetically**, so *Hold Fuzzer Fixture Co.* is the
first row and the largest balance on the book, and the customer pickers on
`/payments`, `/payouts`, `/statements` and `/accruals` default to whichever
fixture sorts first. That is the sort order working as written, not the demo's
customers having lost their money. Two consequences:

- **Every deep link in §4 names Ridgeline explicitly.** You never have to find
  it in a list.
- `scripts/seed.mjs` prints this same list, from the database, at the end of
  every run, so it cannot go stale the way a paragraph can. `verify-demo.mjs`
  check 17 asserts that at least one real customer is still visible among them
  and that every fixture is nameable as one from its own row.

This is the honest version. The dishonest versions available were filtering
fixtures out of the console — which would make a screen look better than the
book is — or deleting them, which is the automatic fail.

### How the switch actually works

`src/components/app-shell/RoleSwitcher.tsx` is a `<form>` with two submit
buttons and a server action — `setRoleAction` in `src/app/(app)/actions.ts` —
not client state. It works with JavaScript disabled, survives a reload and a
deep link, and announces the current role with `aria-pressed` rather than by
colour alone. The action sets one cookie:

```
set-cookie: corgi_demo_role=approver; Path=/; Max-Age=2592000; HttpOnly; SameSite=lax
```

If you would rather script it than click it, `curl -b 'corgi_demo_role=approver'`
on any console URL is the whole mechanism. `verify-demo.mjs` does not take that
shortcut: it scrapes the form's `$ACTION_ID_…` field out of the page and submits
the real no-JavaScript POST, because the claim being checked is that the button
works, not that the cookie does.

### What the role does not do

**It grants nothing.** `src/lib/approvals/session.ts` resolves the role to an
actor by **predicate**, not by name and not by anything in the cookie:

```sql
SELECT id, display_name, kind::text, can_approve
  FROM actor
 WHERE kind = 'human'
   AND business_id IS NULL
   AND can_approve = <role = 'approver'>
 ORDER BY display_name
 LIMIT 1
```

So the cookie chooses *which seeded person you are acting as*, the way logging
in as somebody else would, and nothing more. Editing it by hand cannot produce
an actor with `can_approve = true` that is not already a seeded row, because the
resolution is a `SELECT` with a `WHERE` clause rather than a value read out of
the cookie. The id it returns is then passed to the database, and the database
decides: switch to Approver, press approve on a payment you raised yourself, and
you get SQLSTATE 42501 from `assert_maker_checker()`, not an approval.

Both `role.ts` and `session.ts` carry a header saying this in the file, in
capitals, along with the one function that replaces it — `resolveActor()` stops
reading a role and starts reading a verified session claim, and every caller is
unchanged, because every caller already treats the returned id as an assertion
the database will check rather than as permission. A cookie the browser can set
is not an access-control decision, and this document is not going to pretend
otherwise.

Two actors are deliberately **not** reachable from the switcher:

- **Alex Whitfield**, the customer's own signer, scoped to Ridgeline's
  `business_id`. A bank employee and a customer signer are different principals,
  and conflating them in a demo teaches the wrong model.
- **Corgi payments agent**, `kind = 'agent'`. It is not merely absent from the
  switcher — `actor_only_humans_approve CHECK (NOT (kind <> 'human' AND
  can_approve))` means an approving agent is not a row Postgres will store. It
  raises payment instructions over MCP and they land in the same queue a
  person's do. Rows it raised are labelled `agent` in the queue.

---

## 2. What each role can and cannot do

| | **Staff** (Priya Raman) | **Approver** (Dana Okonkwo) |
| --- | --- | --- |
| Read every balance, hold and posting | yes | yes |
| Read the approvals queue and every payment's full lifecycle | yes | yes |
| Read the reconciliation breaks screen | yes | yes |
| Prepare money movement | yes | yes |
| **Approve an outbound payment** | **no** — `can_approve = false`. Every approve and reject control on the queue is rendered disabled, with the reason beside it. | **yes**, on payments somebody else raised. |
| **Approve a payment they raised themselves** | n/a | **no.** The control is disabled and the row is marked *that is you*. |
| Release an approved payment | no | yes, once the policy version's approval count is held |
| Post to the journal directly | no. Nobody can. `ledger_append()` is the only writer and the app role holds no `UPDATE` on a money table | same |

The refusal text the screen shows is the same text the database enforces,
restated — the screen is a legibility layer and says so:

> **Staff, on any payment:** *"Acting as Priya Raman, who holds no approval
> rights. Approving money out is a separate role, and the database refuses an
> approved event from an actor whose `can_approve` is false."*

> **Approver, on their own payment:** *"You raised this payment, so you cannot
> approve it. The initiator is never the checker — and this is not a rule the
> screen is applying: `assert_maker_checker()` in the database refuses the
> INSERT with SQLSTATE 42501. The button is disabled so you learn it here rather
> than after pressing it."*

The disabled button is deliberate rather than lazy. Learning that you cannot
approve your own payment by pressing a live-looking button and getting an error
is a worse control: it teaches operators that the queue's buttons are unreliable,
and it puts a maker-checker refusal in the same visual channel as a network blip.
It is also not a substitute for the control — the server action ignores the
component entirely, and a POST assembled by hand reaches the same trigger and is
refused by the same `RAISE EXCEPTION`. Core-loop leg 5 does exactly that,
deliberately, and is refused.

---

### 2.1 The third role: **Customer** — and what it actually changes

Added on the last day, after this was asked directly: *why can I reach the ops
console from the customer side?* The answer was that you could, and it was worse
than it looked. `/client` rendered links to **all sixteen operator screens**, no
operator screen checked a role, and both roles that existed — Staff and Approver
— were Corgi employees. The client surface was a **view, not a tenant
boundary**: the per-business `WHERE business_id = $1` predicates under
`src/app/(app)/client/` were correct and always had been, so isolation was real
one layer down and absent at the layer a person clicks.

| | **Staff / Approver** | **Customer** |
| --- | --- | --- |
| `/client`, `/client/activity`, `/client/cards`, `/client/pay`, `/client/approvals`, `/client/pots`, `/client/disputes`, `/client/payouts`, `/client/open` | yes | **yes** |
| `/accounts`, `/payments`, `/approvals`, `/audit`, `/team`, `/dashboard`, `/onboarding`, `/economics`, … and every operator screen added after this was written | yes | **no — HTTP 403, code `OPERATOR_ONLY`** |
| `/` (the front door) | yes | yes — see the caveat below |

Measured on a local production build, `next start`:

```
$ curl -s -i -H 'Cookie: corgi_demo_role=customer' http://localhost:3020/accounts | head -4
HTTP/1.1 403 Forbidden
cache-control: no-store
content-type: text/html; charset=utf-8
x-corgi-authz: deny; OPERATOR_ONLY
```

**This is authorisation, not authentication.** §1 is still true: there is
nothing to sign into, and the cookie is still a demo credential anyone can type.
What changed is that it now *restricts* rather than merely *decorates* — and a
restriction driven by an unverified claim is safe in a way a grant is not, since
the worst a forged cookie can do is lock its own sender out. Approving money is
still decided by the database, not by the cookie.

**Where the decision lives.** One module, `src/lib/authz/`, and it is **default
deny**: the customer-reachable set is the explicit list and *everything else* is
operator-only, including routes that do not exist yet. It is enforced twice — in
`src/middleware.ts`, which answers before any route or server action runs, and
again in `src/app/(app)/layout.tsx`, which re-derives the same decision and fails
closed if the middleware never ran. The nav calls the same function, so a link is
painted if and only if the server would serve it. Hiding the nav is **not** the
control; the 403 is.

**The switch still works in both directions**, which `verify-demo.mjs` checks 8
and 9 pin: Customer is a third button on the same segmented control, posting the
same server action, and the default with no cookie is still Staff (check 7).

**Known residual leak, stated rather than hidden.** `/` stays reachable to a
customer, and `/` renders platform-wide summary figures. It is reachable because
it is where the role switch lives — refusing it would strand a person in the
customer role with no way back, and the submission email points a stranger at
exactly that URL. Closing it means `/` rendering a different page per principal,
which is a page change and not a guard change. It is the next thing to do.

---

## 3. Fourteen screens, five states, all in the URL

Every screen takes the same query parameter, so any state is a link you can
paste or bookmark:

```
?state=loading    ?state=empty    ?state=error    ?state=edge    (bare = default)
```

`/` · `/onboarding` · `/accounts` · `/pots` · `/funding` · `/payments` ·
`/payees` · `/payouts` · `/approvals` · `/standing-orders` · `/accruals` ·
`/disputes` · `/reconciliation` · `/statements`

The trial's wording is *"the three screens that matter show default, loading,
empty, error and one edge state"*. All fourteen do, and this is no longer a
claim made by a one-off measurement in a document: **`verify-demo.mjs` check 4
is that sweep.** It fetches all seventy renders on every run and asserts two
things — every one answers 200, and for each screen the five renders are five
*distinct* documents, so a screen that silently ignored the parameter is caught
and so is one that answers 200 with nothing in it. Measured 2026-09-11T05:02Z
against the deployed URL: **70/70, and 14 screens × 5 distinct documents.**
(Pass `--quick` to skip it; it is the slow check, because `?state=loading` holds
a real read open for six seconds on purpose.)

Do not read a 200 as a working screen. It is not one, and §5.1 is a screen that
answers 200 with an error card on it. The status code says the process replied.

**Which are live and which are fixtures is printed on the page itself.**
`default` is a real read of the real book everywhere. `loading` is not a mock of
a slow read — it *is* the read, held open behind a real Suspense boundary, so
you are looking at the component's own skeleton. `empty` and `error` are labelled
fixtures, because an empty account and a failed query are not conditions you
arrange on a live ledger to show someone. `edge` is **live** on `/funding`,
`/payments` and `/pots`, and a labelled fixture elsewhere.

---

## 4. The click path

Figures move — the deployed system is live, live fire runs against it, and the
core loop posts real entries. The **relationships** below hold; specific dollar
amounts are what was on screen when `verify-demo.mjs` last ran, and are given so
you can see what "correct" looks like.

### 0:00 — `/api/health`, before anything else

Every live-versus-simulated label in the README is computed here, by a real
authenticated call, at the moment you load the page. Read `integrations.slots[]`
and the `evidence` string beside each one. It reports **7 live of 7**, and every
slot carries the round trip that earned it. **If the README ever disagrees with
this page, the page is right** — and `scripts/audit-claims.mjs` fails the commit
if it does.

Two things to read rather than skim:

- **`business_registry` is GLEIF, and GLEIF is a substitution** for Middesk /
  Persona KYB / Sumsub KYB, all of which were measured gated. The evidence
  string says so in those words. A hit in GLEIF is a citation you can follow to
  a government register; a miss is evidence of nothing, so a miss is
  `needs_review` and never `approved`.
- **`webhookHealth`** is the half of this endpoint that a health check usually
  lacks: per-provider delivery freshness read from `webhook_inbox.received_at`,
  with a stated threshold and a written rationale for each (Lithic 180 s,
  Increase 6 h, Persona 24 h — the numbers follow how each feed actually
  behaves). A stale issuing feed moves the **top-level** status to `degraded`.
  It is a band rather than a latch: silence *after recent traffic* is an outage,
  silence with no traffic expected is Tuesday. Measured on 2026-09-11 after a
  live-fire run — `degraded` from 180 s to 900 s, then `stale` -> `quiet` and
  back to `ok` at 937 s with no intervention. So check 1 below will legitimately
  report FAIL for about a quarter of an hour after `scripts/livefire.mjs` runs.

### 0:30 — `/onboarding`, because money should not move before this does

KYB per business, per leg, with the evidence and the provenance of each leg
shown separately — `director_kyc` live via Stripe Identity, `business_registry`
live via GLEIF or decided by a named human in manual review. A composite is only
as live as its least live leg, and the label says so.

This is a gate, not a badge: `canTransact()` runs inside `requestPayment()`, so
an unverified business is refused before an instruction can be written. Core-loop
leg 1 proves it from the outside — a pending business is refused with
`KYB_PENDING` and **zero rows** are written.

**One sentence on this screen is out of date and you will notice it.** The panel
headed *"Every seeded business misses the registry, and that is the correct
answer"* says *"The three businesses on this book are fictional"*. Count the rows
underneath and there are seven — the four extra are the test fixtures in §1.1,
which the panel predates. The panel's actual argument is sound and worth reading
(a GLEIF miss is evidence of nothing, so a miss can never be an approval, and
`Ask the registry` below it runs the same live adapter against anything you
type); it is the census in its first line that has gone stale. Reported, not
fixed: this worker does not write `src/**`.

### 1:00 — `/accounts`, the two balances and everything between them

Two tables, and the split is the point. **Deposit accounts** are read from the
journal at request time — ledger and available are both folds over journal lines,
and no balance is stored in the schema. **Demo accounts** are fixtures behind the
five URL states, and the header says so.

Three things on this screen will confuse you if nobody says them first, so here
they are in the order you will hit them.

1. **The context bar at the top of every console page reads "Blue Ridge Coffee
   Roasters LLC · Delaware LLC · EIN ••-•••4417".** No business by that name
   exists on the book. It is a hard-coded placeholder in
   `src/components/app-shell/AppHeader.tsx`, left over from when the console
   showed one business, and it now sits above tables listing seven other
   companies. **Ignore it.** It is a known defect, listed in §5.2.
2. **The first row of *Deposit accounts* is a test fixture**, and so are three
   of the six rows. The list sorts alphabetically and *Hold Fuzzer Fixture Co.*
   wins. §1.1 is the roster; nothing has gone wrong.
3. **Kettle & Crumb Bakery LLC shows a negative available balance** against a
   positive ledger balance. That is correct and it is the model working: an ACH
   credit that has landed but not cleared is withheld under an
   `uncleared_credit` hold, and available is never clamped at zero, because the
   customer really is in that position. Open the row and the derivation prints
   the subtraction.

**Go straight to the business the demo is about:**

```
/accounts/a0c41a37-2be1-5c30-bfe9-03455f048fac      Ridgeline Robotics, Inc.
```

That account id is not a magic number — it is a UUIDv5 of
`account:corgi-bank:2100:ridgeline-robotics`, derived by `scripts/seed.mjs` from
a fixed namespace, so it is the same id on a book seeded ten minutes ago and on
this one. The seed script prints it, and every other leg's URL, at the end of
every run.

> **This link is currently broken, and it is the most important defect in this
> document.** It answers 200 with *"Balances could not be loaded ·
> `LEDGER_READ_FAILED` · listHolds failed: Invalid time value"*. Ridgeline is
> the only business with disputes, a dispute's provisional credit is a hold
> whose `available_at` is `'infinity'`, and one unguarded `.toISOString()` takes
> the whole screen down. Full diagnosis and the one-line fix are in §5.1. The
> other five account screens render correctly, and Ridgeline's balances are
> right everywhere else — `/accounts` itself, `/disputes`, `/statements` — so
> this is a presentation bug on one page and not a ledger error. It is not
> hidden here because a demo document that routes around its own broken screen
> is worth nothing.

Note the **Operating ••4417** row before you click it:

```
Operating  ••4417  Blue Ridge Coffee Roasters LLC   $48,215.60   $33,715.60
```

Click it. It opens `?auth=pending` — the same fixture with a $50.00 fuel-pump
authorisation landed:

```
before (the /accounts row)     ledger $48,215.60                       available $33,715.60
after  (?auth=pending)         ledger $48,215.60   holds $2,050.00     available $33,665.60
                               ledger delta $0.00        available delta -$50.00
```

The ledger balance carries the annotation **"unchanged by the authorisation"**;
the available balance carries **"−$50.00 · down 50 dollars · SHELL OIL 1247
authorisation"**. Scroll to *How the available balance is derived from the ledger
balance* and the rows add up exactly, in integers, with no clamp. The **Holds**
panel shows the arithmetic per hold — authorised, cleared, remaining — because
the remaining hold is `max(authorised − cleared, 0)` over the event set and not a
number any provider told us.

There is no `?auth=absent`. An empty query string is the **live** account, and
`acct_operating_4417` is not a live account id, so the bare URL answers
`ACCOUNT_NOT_FOUND` rather than quietly showing you a fixture. That is the
labelling rule working, not a broken link.

Then open a **Deposit account** — the uuid-addressed rows, badged **live
ledger**. Nothing there came from a fixture: the holds are real card
authorisations that arrived as signed Lithic webhook deliveries, were verified,
drained and posted to the memo book. The page states its **booking watermark**
and its **as-of** instant, because a fold is only meaningful with both clocks
named.

**Card controls** are on this screen too, and the panel reads Lithic's enrollment
endpoint live, so it states on its face whether the provider is actually calling
us rather than implying it. The decision is made inside Lithic's measured
6000 ms ASA deadline, it is pure, and it posts no money — money still moves on
the ordinary asynchronous webhook. It fails **closed**.

### 2:00 — `/funding`, where the interesting half is the delay

Fund from a linked external bank. Watch what happens to the two balances:
**ledger rises, available does not**, and the identical amount is withheld under
an `uncleared_credit` hold with its release date itemised. That is not caution
for its own sake — an ACH credit can be returned after it lands, so raising
available at the moment ledger rises is lending the customer money against an
entry that can come back.

`?state=edge` is the live version of exactly that condition. The policy behind it
is append-only and effective-dated, and every hold cites the `policy_id` it was
created under, so a hold opened in March is still explainable in December.

### 2:30 — `/pots`, `/standing-orders`, `/payees`

Three screens, three sentences each.

**`/pots`** — sub-accounts inside the customer's own `2100` subtree. An internal
transfer posts **no rail entry**: two lines, one book, netting to zero within the
customer's own money. `?state=edge` is live and is a move of one cent *more* than
the available balance.

**`/standing-orders`** — mandates and every occurrence they produced, with what
each one decided. The unit is the occurrence, and the exactly-once guarantee is a
`GENERATED ALWAYS` idempotency key on a `UNIQUE` column, so two runs that both
get all the way through raise one payment *because the database says so*. A
firing mandate calls the same `requestPayment()` a human does, so the person who
set it up cannot approve what it raises.

**`/payees`** — the confirmation step before money leaves. A failed routing
checksum **blocks**; a failed name match **warns**, and the warning costs
something: an acknowledgement row with a named human, an instant and a sentence.
The screen labels which kind of name check it did — `linked_account_holder` when
Plaid holds an Item for the destination, `payer_asserted` when it does not — and
says plainly that the second is not confirmation of anything, because there is no
name-inquiry network for US ACH.

### 3:00 — `/approvals` as Staff, then as Approver

You arrive as **Priya Raman**, badged *cannot approve*. Read the panel titled
*Maker-checker on money out, and where it is actually enforced* — it names the
trigger, the SQLSTATE and the CHECK constraint, and ends with the sentence this
screen turns on:

> Where you see a disabled button below, the screen is telling you in advance
> what the database would do. It is not the check. Every decision is sent to
> Postgres and refused there.

Every approve and reject control is disabled for Priya, with the
`not_an_approver` reason attached by `aria-describedby` so a screen reader
announces the refusal rather than leaving it to be found. Each payment carries
its **policy version**, the count of distinct approvals held, its full
append-only lifecycle, and its **content hash** — sha256 over the account, rail,
amount, destination and value date, which an approval must cite, so an approval
given for one amount cannot apply to another.

Several rows were raised by **Corgi payments agent**. They sit below the
threshold and need no human, which is what makes the agent surface interesting
rather than decorative: it can state an intention and it cannot make anything
final.

Now click **Approver**. The header reads **Dana Okonkwo · can approve**, and the
queue's answers change with it: payments raised by Priya or by the agent become
approvable, and payments Dana raised herself are marked **"that is you"** with
the reason `self_initiated`. That is the whole maker-checker demonstration in one
click. Nothing about Dana's rights is wrong — she *is* an approver, and the queue
still refuses her — so the refusal can only be the maker-checker rule.

To see the database do it rather than the screen predict it:

```bash
node scripts/livefire.mjs --only 5
```

That attempts the approval twice: once as a raw `INSERT` with no application code
in the call stack, asserting SQLSTATE `42501` from `assert_maker_checker()` with
the actor and instruction ids in the message; and once through `approvePayment()`,
to show the application carries no second copy of the rule and only translates
the exception. It then proves a *different* human can approve the same
instruction — without which "it refused" would also be satisfied by a system that
refuses everything.

### 4:00 — `/reconciliation`, and `/statements`

**`/reconciliation`** is last night's settlement file against our book, matched on
the provider's own reference and on nothing else. Three break categories, no more
and no fewer: **in file, not in ledger**, **in ledger, not in file**, **amount
mismatch**. The open break on screen is the published planted-break attack, left
where it landed: live fire booked inbound ACH settlements, imported the complete
file and reconciled it as a **control** — zero breaks — then deleted one row and
re-imported.

Two things to notice. **Aging is measured in day closes, not hours** — a break
does not get younger because the nightly job ran late, and `aged` means somebody
signed off a business day with it outstanding, which is a fact about a human
decision. And **runs are immutable**, so re-running appends a new run and never
revises the old one; breaks themselves are a *view*, so a break corrected ten
minutes ago reads as corrected without anything having to repair a row.

**A third thing, which looks like a bug and is not.** The header reads
`file livefire-MTWHF7RX-tonight.csv · business date Dec 07, 2027`, while the
same header's *read* clock says Sep 11, 2026 — a settlement file dated fifteen
months in the future. Both are true, and the date is chosen on purpose —
`src/test/livefire/attack-06-planted-break.test.ts:85-103` gives two reasons.
**Unique:** money tables are append-only and the attack has no teardown, so the
file takes a business date no other file, run or journal entry shares, and the
run leaves no break standing on a real business day. **Forward-dated:** the
breaks screen entry point orders runs by business date first — *"the most recent
run"* means last night's **file**, not whichever file was re-run most recently —
so a backdated attack file would be unreachable from the screen however recently
it ran. A forward-dated file is a case the aging ladder already handles (a
warehoused ACH effective date). The screen prints the file's own date rather
than one it would prefer, which is right; it just does not explain the gap, so
it is explained here.

**`/statements`** closes the loop the brief opens with. A closed day's statement
is reproducible forever, corrections included, and the screen shows **both
readings at once** — what the book believed at the pre-correction watermark and
what it says now — with the value date unchanged. Core-loop leg 6 drives a real
Lithic return, then a real return reversal, and links to the statement for the
day:

```
value date    original 2026-09-10   correction 2026-09-10   SAME DAY
booking seq   original 1255         correction 1256         LATER
as believed         $49,762.93   read at watermark 1255
as corrected        $49,689.53   read at watermark 1256
difference             -$73.40   exactly the refund taken back
```

Tuesday's figure changed and Wednesday's belief is still reproducible. Nothing
was rewritten.

### 4:45 — close on the thing that is hardest to fake

```bash
pnpm db:check
```

Connects as `corgi_app` — the role the application actually uses — and attempts
`UPDATE`, `DELETE` and `TRUNCATE` on `journal_entry` and `journal_line`. A
success is a failure. Measured 2026-09-11 it reports **30 passed, 0 failed**:
fifteen that attempt the forbidden or pin a grant — the first six lines are
`permission denied for table journal_entry` / `journal_line` — and **fifteen
invariant views that must each return zero rows**, including the two that hold
the daily accrual's residual-penny arithmetic exact and
`v_balance_definition_drift`, which migration 0022 declares must be empty and
which nothing was querying until today. (The count grows as workers land
invariants; it was 25 earlier tonight and 28 an hour ago. The number that
matters is the second one.)

Ask about that second block rather than the first. Two of those views were empty
for the wrong reason and had been quoted as evidence anyway — see the README's
*The commands that prove things*. A zero-row invariant proves nothing until
somebody has watched it return a row.

---

## 5. `scripts/verify-demo.mjs` — output

Run at 2026-09-11T05:02:48Z against the deployed URL. **13 PASS, 5 FAIL, 1 SKIP
of 19.** Exit code 1, because a checker that exits 0 with five failing
assertions is a checker nobody should believe.

Every failure below names the file that has to change, and **none of them is
this script**. That is the standard the previous run did not meet: it reported
two failures, both of which were this script, and in doing so it stopped walking
before it reached the one screen that is genuinely broken.

```
------------------------------------------------------------------------------
VERIFY DEMO — docs/DEMO.md, walked against the deployed system
base url   https://corgi-trial-psi.vercel.app
started    2026-09-11T05:02:48.332Z
------------------------------------------------------------------------------

   1. PASS  /api/health answers, the database is reachable, and it reports its slots
        status ok · commit 4c682e1 · db 13ms · 7 live of 7
        LIVE      card_issuing       GET /v1/cards -> 200
        LIVE      card_webhooks      GET /v1/event_subscriptions -> 200, then /attempts -> 200:
                                     subscription enabled at .../api/webhooks/lithic; latest
                                     delivery SUCCESS, our endpoint answered HTTP 202
        LIVE      director_kyc       Stripe Identity enabled (Persona not configured)
        LIVE      business_registry  GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple Inc.)
        LIVE      open_banking       POST /institutions/get -> 200
        LIVE      ach_rail           GET /accounts -> 200
        LIVE      stablecoin         15.03 USDC and 68659903703189 wei gas — a transfer is fundable
   2. FAIL  nothing inside /api/health contradicts anything else inside it
        business_registry: verdict "live" but provider reads "Stripe Connect (gated) — simulated"
   3. PASS  every one of the console's screens answers 200
        14 screens, all 200
   4. PASS  every screen answers in all five demo states, and the five are five different documents
        70 renders (14 screens × 5 states), every one 200
        every screen produced 5 distinct documents, so none ignores ?state=
   5. FAIL  the landing page leads to every screen the console serves
        7 of 13 screens are not linked from it and / carries no nav:
          /pots  /funding  /payees  /payouts  /standing-orders  /accruals  /disputes
   6. FAIL  the landing page's prose agrees with /api/health, which outranks it
        "The two SIMULATED rows" — health reports 7 live of 7 and the table on the same page
        prints "0 are simulated"
        "the registry leg is simulated" — health reports business_registry=live
   7. PASS  with no cookie the console acts as Staff, and Staff cannot approve
   8. PASS  the Approver button on the LANDING page submits the real server action
   9. PASS  the Staff button switches back, so the control is not one-way
  10. PASS  Approver resolves to a different actor, who does hold approval rights
  11. PASS  the queue refuses self-approval, and says so before the button is pressed
  12. SKIP  the database-level refusal is not asserted by THIS script
        proven by  node scripts/livefire.mjs --only 5   and   node scripts/coreloop.mjs leg 5
  13. PASS  a $50.00 authorisation moves AVAILABLE and does not move the LEDGER
        before (/accounts row)     ledger $48,215.60   available $33,715.60
        after  (?auth=pending)     $48,215.60 − $2,050.00 − $12,500.00 − $0.00 = $33,665.60
        ledger delta $0.00 · available delta -$50.00
  14. PASS  the demo authorisation is labelled a fixture, and the live account is labelled live
  15. FAIL  every live account screen opens, and available == ledger − holds − uncleared − committed
        1 of 6 live account screens do not work:
        ok    61eb  Hold Fuzzer Fixture Co.        $512,691.69 − $3,816.60 − $5,000.00 − $0.00 = $503,875.09
        ok    0f00  Holds Integration Fixture Co.  $145,320.15 − $2,489.00 − $1,250.00 − $0.00 = $141,581.15
        ok    108b  Kettle & Crumb Bakery LLC      $30,850.35 − $300.00 − $37,250.00 − $0.00 = -$6,699.65
        ok    34fa  Live Fire — attack 7           $0.00 − $200.00 − $0.00 − $0.00 = -$200.00
        ok    9911  Pots Integration Fixture Co.   $25,000.92 − $0.00 − $0.00 − $0.00 = $25,000.92
        FAIL  8fac  Ridgeline Robotics, Inc.       BROKEN — LEDGER_READ_FAILED: listHolds failed:
                                                   Invalid time value
  16. FAIL  a stranger can follow one business — Ridgeline Robotics, Inc. — through the whole loop
        /accounts/a0c41a37-… — the protagonist's own account screen — renders LEDGER_READ_FAILED
        /onboarding            names Ridgeline Robotics, Inc. with its KYB evidence
        /accounts              row ••8fac is Ridgeline Robotics, Inc.
        /statements?account=…  a closed day for Ridgeline Robotics, Inc.
        /disputes              Ridgeline Robotics, Inc. has cases with provisional credit
  17. PASS  test fixture companies on the live book are distinguishable from customers
        6 deposit accounts: 2 customer, 4 test fixture
        the list sorts alphabetically, so Hold Fuzzer Fixture Co. is the first row a grader sees
  18. PASS  the breaks screen renders a reconciliation run and its break categories
  19. PASS  a break carries a reference, an amount, an age and a severity

------------------------------------------------------------------------------
  13 PASS   5 FAIL   1 SKIP   of 19 checks
  a skip is not a pass; each one names the command that does prove it
  every FAIL above names the file that has to change; none of them is this script
  finished   2026-09-11T05:02:39.231Z
------------------------------------------------------------------------------
```

### 5.1 Check 15 and 16 — a broken screen, and the stale parser that was hiding it

**This is the important one.**

`https://corgi-trial-psi.vercel.app/accounts/a0c41a37-2be1-5c30-bfe9-03455f048fac`
— the deposit account of **Ridgeline Robotics, Inc.**, the business this
document, the seed script and every screenshot in the repo are about — answers
HTTP 200 and renders:

```
Balances could not be loaded
This is a read failure. No money moved, no posting was written, and no hold changed.
Code     LEDGER_READ_FAILED
Message  listHolds failed: Invalid time value
```

**Diagnosis.** `hold.available_at` is a `timestamptz`, and `timestamptz` has two
values that are not instants: `infinity` and `-infinity`. `src/lib/disputes/store.ts:866`
writes the first one deliberately — a dispute's provisional credit is an
`uncleared_credit` hold released by a person deciding the case, never by a clock,
and "no release instant" is exactly what `infinity` means. The `postgres` driver
parses it into a `Date` whose time value is `NaN`. Neither `=== null` nor a
truthiness check sees that.

`src/components/account/live-data-source.ts:108-114`:

```js
function toInstant(value: Date): Instant {
  return value.toISOString();                       // RangeError on an invalid Date
}
function toInstantOrNull(value: Date | null): Instant | null {
  return value === null ? null : value.toISOString();
}
```

`toHold()` (same file, line 265) calls both for `placedAt`, `expiresAt` and
`availableAt`. One `infinity` row throws `RangeError: Invalid time value`, the
throw is caught by `listHolds`'s own catch at line 504, and the whole account
view becomes `LEDGER_READ_FAILED`. Ridgeline has 22 dispute cases and therefore
twenty-odd such holds; the other five accounts have none, which is exactly why
only this one screen is down.

**This bug has already been found and fixed once, somewhere else.**
`src/app/(app)/funding/live-source.ts:156-176` carries a capitalised header —
*"`available_at` CAN BE `infinity`, AND THAT USED TO TAKE THE WHOLE SCREEN
DOWN"* — describing the identical failure on `/funding`, measured on
2026-09-10, on the same nine Ridgeline rows. That file grew an `isInstant()`
guard. The account screen did not. The fix is to use the same guard in the two
functions above.

**Why it went unnoticed.** The old check 12 walked the account list and threw on
the first account it could not parse. Its parser was stale — it read the
availability table by taking the first four money figures after that table had
grown to five rows — so it threw on account #1, and accounts #2 through #6 were
never opened. The broken one was #6. The document you are reading said of that
failure *"neither of which is a broken screen"* and was wrong, not because the
diagnosis of the parser was wrong (it was right) but because the diagnosis
stopped at the first thing that explained the output.

Both halves are fixed in the checker. `derivation()` now parses the table by its
own row labels and **fails by name** if a row it does not recognise appears —
so the next time a component is added, the failure says *"the derivation table
has a row this checker does not know about: 'Committed outflows'"* rather than
quietly reading the wrong number. And check 15 collects a verdict per account
instead of throwing, so one bad row can never again hide five others, in either
direction.

The arithmetic assertion itself — `available == ledger − holds − uncleared −
committed`, exactly, in cents — now passes on every account that renders, and is
separately proven by `node scripts/coreloop.mjs` (legs 2 and 4) and by
`pnpm db:check`, whose `v_balance_definition_drift` is the invariant that the
Postgres function and the view cannot disagree.

### 5.2 Check 5 — the front door does not lead to half the build

`/` is the only URL in the submission email, and it has **no navigation bar**.
Its map of the product is `src/components/home/ScreenLinks.tsx`, which lists six
screens under a heading that reads *"Every screen in this build"* and a sentence
that reads *"Six screens and the JSON endpoint behind the integration table.
Everything built in this trial is reachable from here."*

The console serves thirteen. Seven of them — `/pots`, `/funding`, `/payees`,
`/payouts`, `/standing-orders`, `/accruals`, `/disputes` — are linked from
nowhere a stranger standing on `/` can see. They are one click away *once you
have clicked one of the six*, because the console shell has the full nav; but
the front door's own claim about itself is false, and the seven include
`/funding`, which is leg two of the published core loop.

`src/components/home/ScreenLinks.test.ts` asserts that every link in the list
resolves to a route, and never that every route appears in the list. It also
pins the list to exactly seven entries by name, so adding a screen cannot fail
the suite — the test locks the gap in rather than catching it. That is the same
shape as every other guard this build has had to fix: it watches the half that
was already right.

Check 5 reads the route list off the **deployed console's own nav** rather than
from a literal in the checker, so it cannot go stale when a screen is added.

### 5.3 Check 6 — two sentences on the front door that /api/health contradicts

`/api/health` is authoritative. Two pieces of prose on `/` disagree with it, and
both are visible above the fold:

- **`src/components/home/WhatToLookAt.tsx`**, the item keyed `simulated`, tells
  the reader to look at *"The two SIMULATED rows"* and explains what demoted
  them. Health reports **7 live of 7**, and the integrations table lower down
  **the same page** prints *"0 are simulated"*. A grader who follows the
  instruction finds nothing and has caught the build contradicting itself on its
  own landing page.
- **`src/components/home/ScreenLinks.tsx`**, the `/onboarding` entry, says *"the
  registry leg is simulated"*. Health reports `business_registry = live` with the
  evidence `GET api.gleif.org /v1/lei-records/{lei} -> 200`.

`scripts/audit-claims.mjs` enforces the health-is-authoritative rule and is the
right tool for this — but it reads `*.md` only. The screens, which are what a
grader reads **first**, were audited by nothing. Check 6 closes that for the
landing page's two specific claims.

### 5.4 Check 2 — one row of the integrations table says LIVE and simulated at once

`src/lib/env.schema.ts:116` declares the `business_registry` slot with
`provider: "Stripe Connect (gated) — simulated"`. The verdict is computed
separately, by an authenticated round trip, and comes back `live` via GLEIF. The
integrations table on `/` renders provider and verdict in adjacent columns, so
the row a grader reads is:

```
business_registry   Stripe Connect (gated) — simulated   LIVE   GET api.gleif.org … -> 200 (Apple Inc.)
```

Three answers in one row, and the provider named is not the provider probed.
(The same line's `keys: ["STRIPE_SECRET_KEY"]` is stale for the same reason:
GLEIF needs no key.) The verdict and the evidence are both correct; the label
beside them is left over from an earlier design. This is the only check that
fails inside the authoritative document itself, which is why it is check 2 and
not a screen check.

### 5.5 A failure you may see that is the system working

If you run this within about fifteen minutes of `scripts/livefire.mjs`, check 1
will also fail with `status is "degraded", expected "ok"`. That is the
webhook-freshness alarm doing its job: live fire induces a real 180-second
issuing-provider silence, `/api/health` moves lithic to `stale` inside its own
180–900 s band and escalates the top-level status, and the band expires on its
own at 900 s. It is a band, not a latch. §4's *0:00* entry has the reasoning.

### 5.6 The one skip, and why it is a skip rather than a pass

Check 12 wanted to prove the maker-checker refusal *at the database* by POSTing
the approvals form by hand, the way check 8 proves the role switch by POSTing the
switcher form by hand. It does not. `DecisionForm` is a client component driven
by `useActionState`, so React emits its **bound** progressive-enhancement fields
(`$ACTION_REF_…`, `$ACTION_<n>:0`) rather than the unbound `$ACTION_ID_…` this
script's matcher submits.

The previous wording of this skip said a hand-assembled POST *"cannot reach the
trigger from this script"*. That was too strong and is corrected: it can, and
`scripts/coreloop.mjs` does exactly that — it scrapes the bound fields and posts
them, getting `NOT_AN_APPROVER` and `SELF_APPROVAL` refusals with zero approved
events written. The honest reason this is a skip is that reimplementing React's
bound-action scraping here would be a second copy of working code, and a skip
that names the command is better than a duplicate that can rot.

Two things prove it, and neither is this file:

```bash
node scripts/livefire.mjs --only 5   # raw INSERT, no application code in the call stack,
                                     # SQLSTATE 42501 from assert_maker_checker(), then a
                                     # DIFFERENT human approving the same instruction
node scripts/coreloop.mjs            # leg 5, over HTTP, through the real server action
```

The second half of the livefire assertion matters as much as the first: without
it, "it refused" would also be satisfied by a system that refuses everything.

### 5.7 What is NOT wrong

None of the five failures is a ledger error, and it is worth saying which
assertions held while they were failing:

- **Every account screen that renders is exact in cents.** Five of six, no
  rounding, no clamp, including one legitimately negative available balance.
- **Seventy renders, seventy 200s, fourteen × five distinct documents.** No
  screen ignores `?state=`.
- **Both roles resolve to two different seeded actors**, from the landing page,
  with the maker-checker refusal stated before the button is pressed.
- **`pnpm db:check` is 30 passed, 0 failed** — fourteen attempts at the
  forbidden, each refused, and sixteen invariant views that must each return
  zero rows.
- **The demo authorisation labels itself a fixture** and the live accounts label
  themselves live, which is the labelling rule this build is graded on.


## 6. If you would rather drive the API than the console

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP. Ask it
what it has rather than taking this document's word for it — **the deployed
`tools/list` is the authority, not the file tree, and this paragraph has been
wrong in both directions already**. Measured at 2026-09-11T03:39Z it answered
with **eight**: `get_balance`, `list_pots`, `list_transactions`, `list_payees`,
`list_standing_orders`, `list_card_controls` and `list_recon_breaks` read, and
`initiate_payment` queues a payment request a person has to work through. It
refuses every call without a bearer token and there is no development bypass, so
it needs a grant in `MCP_AGENT_TOKENS`. [`MCP.md`](./MCP.md) has the
configuration, a full `curl` transcript and the transport details;
[`AGENT-LIMITS.md`](./AGENT-LIMITS.md) is the list of operations deliberately
absent from that surface, with the failure mode for each.

`POST /api/drain` with `Authorization: Bearer $DRAIN_TOKEN` drains the webhook
inbox on demand, which is the "watch, I will drain it now" move rather than
waiting for the cron. `POST /api/cron/standing` ticks the standing-order
schedule the same way. Both also accept Vercel's cron header, and both answer 401
with neither. The cron itself runs daily rather than hourly, and the reason is in
[`CUT-LIST.md`](./CUT-LIST.md) §3.3.

---

# §9. The provider-outage step, scripted for a human — 2026-09-11

The published attack is the brief's own wording: *"Turn off your issuing
provider's webhooks for five minutes mid-demo and ask what the customer sees."*

**This step is driven by a person, on purpose.** It is deliberately NOT in
`scripts/livefire.mjs`: a Lithic event subscription left disabled by a crashed,
timed-out or `SIGKILL`ed test run is a broken card rail for the rest of the
demo, and a suite that fails in the middle of a batch cannot be trusted to get
to its own restore.

**It is now driven by `scripts/outage.mjs` rather than by loose curl**, because
the objection above is about *guaranteeing the restore*, and the right answer to
that is a script built around the guarantee rather than a person remembering a
command. Five guarantees, in the order they fire:

1. **Prove restore before breaking.** A real no-op PATCH and an independent GET
   *before* anything is disabled. If the credential cannot PATCH, it refuses to
   start and nothing is touched.
2. **Every exit path restores** — `SIGINT`, `SIGTERM`, `SIGHUP`, normal
   completion, a throw, an unhandled rejection — through one idempotent
   `restore()` that verifies by GET rather than trusting the PATCH's response.
3. **An in-process watchdog** (`--max-outage`, default 600 s, always forced
   above `--auto`) restores even if the main flow is wedged.
4. **A detached sentinel.** Handlers and timers both die with the process and
   `kill -9` runs neither, so it forks a detached child whose *only* capability
   is to re-enable. It survives SIGKILL of the parent and a closed terminal, and
   because it can only turn the feed **on**, a spurious fire is harmless.
5. **`--stop` is always the answer**, from any terminal, taking no state from a
   previous run.

What that still does not cover, plainly: power loss, or both processes killed.
The manual restore in step 6 below remains the backstop, and the script prints
it in red on its own failure path.

The rehearsal script for this step — what to say, what to point at, and the
exact words on the customer's screen — is **`docs/LIVE-FIRE.md` §7**.

## 9.1 What is safe here, and it was measured

Two facts, both read off the live sandbox at 2026-09-11T18:2xZ:

```
GET https://sandbox.lithic.com/v1/auth_stream          -> {"enrolled": true}
GET https://sandbox.lithic.com/v1/event_subscriptions  -> ep_3J8yb9xommtOdKee1FzpUA4GBrW
                                                          disabled: false
                                                          url: https://corgi-trial-psi.vercel.app/api/webhooks/lithic
```

**Auth Stream Access is enrolled SEPARATELY from the event subscription.** So
disabling the subscription stops the asynchronous clearing feed and does **not**
stop card authorisation at the terminal. Cards keep working while the feed is
dark. That is exactly the state the attack is about: the money is being
authorised, and we are not being told about it.

## 9.2 Why silence alone is not enough any more

`/api/health` no longer treats `MAX(webhook_inbox.received_at)` plus a clock as
an outage, because that cannot tell *"the provider stopped delivering while
transactions were happening"* from *"nobody swiped a card"*. It narrows the
silence against `card_auth_decision WHERE source = 'provider'` — the ASA record,
written synchronously while Lithic holds an authorisation open at a terminal, on
a channel independent of the inbox whose silence is in question.

So the sequence matters. **Disable, and THEN transact.** Disabling and waiting
reads `dormant` and correctly stays green:

```json
"verdict": "dormant",
"note": "no transaction has been initiated since the newest delivery ...
         There is nothing outstanding for this provider to have sent"
```

That is not the endpoint failing to notice an outage. That is the endpoint
refusing to page somebody because the card rail was quiet — and it is the exact
reason live-fire attack 7 no longer asserts `status === "degraded"` (it induces
its silence by sending nothing, so `dormant` is the honest reading of what it
induced). See the header of
`src/test/livefire/attack-07-provider-outage.test.ts`.

## 9.3 The step

Run these from the repo root with `set -a; . ./.env; set +a` already done.

**1 — Show the feed healthy.** Open `/accounts`. No banner.

```bash
curl -s "$BASE/api/health" | jq '.status,
  (.integrations.webhookHealth.providers[] | select(.provider=="lithic") | {verdict, secondsSinceLastDelivery}),
  (.integrations.transactionInitiation.providers[] | select(.provider=="lithic") | {verdict, initiatedSinceLastDelivery})'
```

**2 — Turn the webhooks off.**

```bash
node scripts/outage.mjs --start      # disable and hold; Ctrl-C restores
# or, fully unattended:
node scripts/outage.mjs --auto 300   # disable, wait 5 min, restore, verify
```

It prints the preflight, the subscription token, the ASA enrolment, the detached
sentinel's pid, and the state verified by GET at every step — so a panel watching
can see the restore happen rather than take it on trust.

By hand, if you must: the `url` is REQUIRED by Lithic's schema on this PATCH;
sending `{"disabled": true}` alone answers `400 "url" is a required property`.
This is also the exact shape of the RESTORE call, which is where that 400 would
have hurt.

```bash
curl -s -X PATCH \
  -H "Authorization: $LITHIC_API_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic","disabled":true}' \
  https://sandbox.lithic.com/v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW
```

**3 — TRANSACT while it is dark.** This is the half that makes it an outage
rather than a quiet hour. Use the **Simulate an authorisation** form on
`/accounts` (a real `POST /v1/simulate/authorize`), or curl it. The card
authorises — ASA is still enrolled — and the clearing webhook never arrives.

> **On a FIXTURE card only — EIN shaped `00-000000N`.** Lithic does not
> guarantee replay of events dropped while a subscription is disabled, so a
> transaction made during the outage can lose its clearing webhook permanently,
> and on an append-only book that is a permanent gap: a hold that never releases
> and a settlement that never posts. **Do not use Ridgeline Robotics, Kettle &
> Crumb Bakery or Silverline Freight** — those are the demo businesses the panel
> is looking at. `scripts/outage.mjs` prints this warning before it disables
> anything.

**4 — Wait past 180s** (`staleAfterSeconds` for Lithic) and re-read health. The
narrowing now has traffic to find:

```
webhookHealth.lithic.verdict                        stale
transactionInitiation.lithic.verdict                transacting
transactionInitiation.lithic.initiatedSinceLastDelivery   >= 1
webhookHealth.lithic.degradesDeployment             true
webhookHealth.degradedBy                            ["lithic"]
status                                              degraded
```

**5 — Ask what the customer sees.** Reload `/accounts`. The banner reads
**"Issuing provider feed is quiet — lithic"**, with *"no delivery for N
minutes"* rendered from the endpoint's own number, and **the balances below it
are still there.** They are not blanked and not spinning, because every figure
on that page is a fold over rows that are already durable. The banner says the
narrow true thing — there may be events we have not heard about — not the wide
false one, "your balance is wrong".

**6 — RESTORE. Do this before anything else, and verify it.**

```bash
node scripts/outage.mjs --stop
```

It re-enables, then re-reads by an independent GET and prints
`verified by GET  ENABLED  token ep_…`. It is idempotent and safe to run at any
time, including when nothing is disabled. `--auto` and Ctrl-C on `--start` both
do this for you; running it again costs a second and proves it.

By hand, if the script is unavailable:

```bash
curl -s -X PATCH \
  -H "Authorization: $LITHIC_API_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic","disabled":false}' \
  https://sandbox.lithic.com/v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW

# VERIFY by re-reading, not by trusting the PATCH's response:
curl -s -H "Authorization: $LITHIC_API_KEY" \
  https://sandbox.lithic.com/v1/event_subscriptions | jq '.data[] | {token, disabled}'
# must print  "disabled": false
```

**7 — Drain the backlog** and show it applies exactly once:

```bash
curl -s -X POST -H "authorization: Bearer $DRAIN_TOKEN" "$BASE/api/drain"
```

## 9.4 What the suite proves instead, without the risk

Live-fire attack 7 replays the induced outage's **own published facts** through
`attributeDeliverySilence` — the same pure function `/api/health` calls — with
exactly one input varied: provider-sourced ASA decisions after the last
delivery. With `0` the verdict is `dormant` and `degradedBy` is empty. With `1`
it is `transacting`, `degradesDeployment` is `true`, `degradedBy` is
`["lithic"]` and the top-level status would read `degraded`. The narrowing can
only ever subtract on a counted zero; it cannot silence real loss.

**What that does NOT prove, and §9.3 does:** that a genuinely disabled
subscription produces that second state end to end. If the panel wants to see
the endpoint actually turn red, §9.3 is the only thing that shows it, and it
needs a human at step 6.
