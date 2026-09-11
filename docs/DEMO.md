# Demo access, the two roles, and a click path

Live: **https://corgi-trial-psi.vercel.app**

Everything below was walked against that URL by `scripts/verify-demo.mjs`, which
is checked in beside this file. Run it and it will tell you whether this
document is still true:

```bash
node scripts/verify-demo.mjs
node scripts/verify-demo.mjs --base-url http://localhost:3000
```

It makes no writes. Every request is a GET except one POST whose only effect is
a `Set-Cookie` on the response it returns. Last run — **13 PASS, 0 FAIL, 1 SKIP**
of 14 checks; the full output is at the bottom of this file, and §5 explains the
skip.

If you would rather watch the money move than click, that is one command:

```bash
set -a; . ./.env; set +a
node scripts/coreloop.mjs
```

Seven legs of the published core loop, in one run, against this deployed URL,
driving the real server actions. PASS 7, FAIL 0, SKIP 0, invariants 14/14. See
[`CORE-LOOP.md`](./CORE-LOOP.md).

---

## 1. There is nothing to sign into

The ops console is open. No email, no password, no magic link, and no seeded
login to hand over — an authentication system was cut on the first day and the
console has never had one.

The submission asks for demo credentials for at least two roles, so here is the
honest version of that: **the credential is a role switch in the header, and the
two roles are two different seeded database actors.**

| "Credential" | What to do | Which actor the server resolves |
| --- | --- | --- |
| **Staff** (default) | Open any console page. This is what you get with no cookie at all. | **Priya Raman** — `kind = 'human'`, `can_approve = false` |
| **Approver** | Click **Approver** in the *Acting as* control, top right of every console page. | **Dana Okonkwo** — `kind = 'human'`, `can_approve = true` |

Both are seeded by `scripts/seed.mjs`. Neither is scoped to a customer: they are
Corgi staff, `business_id IS NULL`.

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

## 3. Eleven screens, five states, all in the URL

Every screen takes the same query parameter, so any state is a link you can
paste or bookmark:

```
?state=loading    ?state=empty    ?state=error    ?state=edge    (bare = default)
```

`/` · `/onboarding` · `/accounts` · `/pots` · `/funding` · `/payments` ·
`/payees` · `/approvals` · `/standing-orders` · `/reconciliation` ·
`/statements`

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

### 1:00 — `/accounts`, the two balances and everything between them

Two tables, and the split is the point. **Deposit accounts** are read from the
journal at request time — ledger and available are both folds over journal lines,
and no balance is stored in the schema. **Demo accounts** are fixtures behind the
five URL states, and the header says so.

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
success is a failure. It reports 14 passed, 0 failed, and the first six lines are
`permission denied for table journal_entry` / `journal_line`.

---

## 5. `scripts/verify-demo.mjs` — output

Run at 2026-09-11T00:54Z against the deployed URL. Exit code 0.

```
------------------------------------------------------------------------------
VERIFY DEMO — docs/DEMO.md, walked against the deployed system
base url   https://corgi-trial-psi.vercel.app
started    2026-09-11T00:54:07.182Z
------------------------------------------------------------------------------

   1. PASS  /api/health answers, the database is reachable, and it reports its slots
        status ok · commit 2310fd7 · db 140ms · 7 live of 7
        LIVE      card_issuing       GET /v1/cards -> 200
        LIVE      card_webhooks      GET /v1/event_subscriptions -> 200, GET /v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW/attempts -> 200: subscription enabled at https://corgi-trial-psi.vercel.app/api/webhooks/lithic; latest delivery SUCCESS, our endpoint answered HTTP 202
        LIVE      director_kyc       Stripe Identity enabled (Persona not configured)
        LIVE      business_registry  GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple Inc.); GLEIF is a substitution for Middesk / Persona KYB / Sumsub KYB, all gated
        LIVE      open_banking       POST /institutions/get -> 200
        LIVE      ach_rail           GET /accounts -> 200
        LIVE      stablecoin         18.50 USDC and 69212360086576 wei gas — a transfer is fundable
   2. PASS  no nested webhook slot contradicts the authoritative live/simulated table
        5 webhook providers checked, every nested slot agrees
        must-be-live slots: card_issuing=live, director_kyc=live
   3. PASS  every screen in the click path answers 200
        GET /                200   154136 bytes
        GET /accounts        200   942930 bytes
        GET /approvals       200   708551 bytes
        GET /reconciliation  200    62197 bytes
   4. PASS  with no cookie the console acts as Staff, and Staff cannot approve
        actor: "Priya Raman" · badge: "cannot approve"
        gate reason present: "Acting as Priya Raman, who holds no approval rights."
   5. PASS  the Approver button submits the real server action and sets the role
        POST /accounts with $ACTION_ID_401fb0b176c8a… and role=approver -> 200
        set-cookie: corgi_demo_role=approver; HttpOnly; SameSite=lax
   6. PASS  the Staff button switches back, so the control is not one-way
        set-cookie: corgi_demo_role=staff
   7. PASS  Approver resolves to a different actor, who does hold approval rights
        actor: "Dana Okonkwo" · badge: "can approve"
        the not_an_approver reason is absent, so the switch changed the server's answer and not just a label
   8. PASS  the queue refuses self-approval, and says so before the button is pressed
        a queue row raised by Dana Okonkwo is marked "that is you"
        gate reason: "You raised this payment, so you cannot approve it. The initiator is never the checker…"
        the reason names assert_maker_checker() and SQLSTATE 42501, and the approve control is disabled
   9. SKIP  the database-level refusal is not asserted over HTTP
        the approvals form is a client component, so its server action carries no no-JavaScript
        action id in the HTML and a hand-assembled POST cannot reach the trigger from this script.
        The DATABASE refusal is proven by:  node scripts/livefire.mjs --only 5
          (raw INSERT, no application code in the call stack, asserts SQLSTATE 42501)
  10. PASS  a $50.00 authorisation moves AVAILABLE and does not move the LEDGER
        before (/accounts row)     ledger $48,215.60                        available $33,715.60
        after  (?auth=pending)     ledger $48,215.60  holds $2,050.00  available $33,665.60
        ledger delta $0.00 · available delta -$50.00
        annotated on screen: "unchanged by the authorisation" / "down 50 dollars" / "SHELL OIL 1247"
  11. PASS  the demo authorisation is labelled a fixture, and the live account is labelled live
        fixture view: badge "fixture" + "nothing here was written to the database"
        live view:    badge "live ledger"
  12. PASS  on the LIVE account, available == ledger - holds - uncleared, exactly, in cents
        66fdc0f8…  $104,018.90 - $1,934.00 - $1,250.00 = $100,834.90
        b86fb38f…  $25,000.00 - $0.00 - $0.00 = $25,000.00
        a0c41a37…  $49,689.53 - $411.00 - $17,503.00 = $31,775.53
  13. PASS  the breaks screen renders a reconciliation run and its break categories
        three break categories rendered, no more and no fewer
        matched 3 / 3 file rows paired by reference
        1 open break(s) on the most recent run
        business date Dec 02, 2027
  14. PASS  a break carries a reference, an amount, an age and a severity
        break reference on screen: LF6-MTVRTYAB-3
        severity: Open
        aging is stated as day closes, not hours

------------------------------------------------------------------------------
  13 PASS   0 FAIL   1 SKIP   of 14 checks
  a skip is not a pass; each one names the command that does prove it
  finished   2026-09-11T00:54:20.534Z
------------------------------------------------------------------------------
```

*(Check 1's `card_webhooks` evidence string is reproduced above with the
subscription id abbreviated for width; the endpoint prints it in full.)*

### The one skip, and why it is a skip rather than a pass

Check 9 wanted to prove the maker-checker refusal *at the database* by POSTing
the approvals form by hand from this script, the way check 5 proves the role
switch by POSTing the switcher form by hand. It cannot. `DecisionForm` is a
client component driven by `useActionState`, so its server action does not emit
a no-JavaScript `$ACTION_ID_…` field into the HTML, and there is nothing for
*this script's* matcher to submit to.

That is a limitation of this checker, not a gap in the control, and the
distinction matters enough to print rather than quietly fold into the pass count.
Two other things do prove it. `node scripts/livefire.mjs --only 5` asserts the
refusal against the live database with a raw `INSERT` and no application code in
the call stack. And `scripts/coreloop.mjs` leg 5 reaches the same trigger *over
HTTP*: a `useActionState` action emits React's **bound** progressive-enhancement
fields (`$ACTION_REF_…`, `$ACTION_<n>:0`) rather than the unbound `$ACTION_ID_…`
this checker looks for, and the core loop scrapes and posts those instead —
getting `NOT_AN_APPROVER` and `SELF_APPROVAL` refusals with zero approved events
written. Fixing check 9 is a matcher change, and it is small.

---

## 6. If you would rather drive the API than the console

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP. Ask it
what it has rather than taking this document's word for it: `tools/list` on the
deployed endpoint answered with exactly four at 2026-09-11T01:18Z — `get_balance`,
`list_transactions` and `list_recon_breaks` read, `initiate_payment` queues a
payment request a person has to work through. More reads exist in the working
tree and are not deployed yet; the live `tools/list` is the authority. It refuses every call without a bearer token and there is no development
bypass, so it needs a grant in `MCP_AGENT_TOKENS`. [`MCP.md`](./MCP.md) has the
configuration, a full `curl` transcript and the transport details;
[`AGENT-LIMITS.md`](./AGENT-LIMITS.md) is the list of operations deliberately
absent from that surface, with the failure mode for each.

`POST /api/drain` with `Authorization: Bearer $DRAIN_TOKEN` drains the webhook
inbox on demand, which is the "watch, I will drain it now" move rather than
waiting for the cron. `POST /api/cron/standing` ticks the standing-order
schedule the same way. Both also accept Vercel's cron header, and both answer 401
with neither. The cron itself runs daily rather than hourly, and the reason is in
[`CUT-LIST.md`](./CUT-LIST.md) §3.3.
