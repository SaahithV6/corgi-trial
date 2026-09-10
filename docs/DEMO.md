# Demo access, the two roles, and a five-minute click path

Live: **https://corgi-trial-psi.vercel.app**

Everything below was walked against that URL by `scripts/verify-demo.mjs`, which
is checked in beside this file. Run it and it will tell you whether this
document is still true:

```bash
node scripts/verify-demo.mjs
node scripts/verify-demo.mjs --base-url http://localhost:3000
```

It makes no writes. Every request is a GET except one POST whose only effect is
a `Set-Cookie` on the response it returns. Last run — 13 PASS, 0 FAIL, 1 SKIP;
the output is at the bottom of this file.

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
an actor with `can_approve = true` that is not already a seeded row, because
the resolution is a `SELECT` with a `WHERE` clause rather than a value read out
of the cookie. The id it returns is then passed to the database, and the
database decides: switch to Approver, press approve on a payment you raised
yourself, and you get SQLSTATE 42501 from `assert_maker_checker()`, not an
approval.

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

The refusal text the screen shows for each case is the same text the database
enforces, restated — the screen is a legibility layer and says so:

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
is a worse control: it teaches operators that the queue's buttons are
unreliable, and it puts a maker-checker refusal in the same visual channel as a
network blip. It is also not a substitute for the control — the server action
ignores the component entirely, and a POST assembled by hand reaches the same
trigger and is refused by the same `RAISE EXCEPTION`.

---

## 3. The five-minute click path

Figures move: the deployed system is live, live fire runs against it, and other
work is landing. The **relationships** below hold; the specific dollar amounts
are what was on screen at 2026-09-10T17:56Z and are given so you can see what
"correct" looks like.

### 0:00 — `/api/health`, before anything else

Every live-versus-simulated label in the README is computed here, by a real
authenticated call, at the moment you load the page. Read `integrations.slots[]`
and the `evidence` string beside each one. It reports **4 live of 7**, with
`business_registry` and `stablecoin` simulated and the reason for each written
out. The README says it and it is worth repeating: **if the README ever
disagrees with this page, the page is right.**

One row deserves your suspicion and gets an answer in the README:
`card_webhooks` reports SIMULATED with evidence `credential present but NOT
probed — no round trip proves this slot works`. That
verdict is not earned by a round trip; it is earned by a credential being
present. See "The one row in that table that is weaker than the others".

### 0:30 — `/accounts`, the list

Two tables, and the split is the point. **Deposit accounts** are read from the
journal at request time — ledger and available are both folds over journal
lines, and no balance is stored in the schema. **Demo accounts** are fixtures
behind the five URL-driven states, and the header says so: *"They write nothing
and read nothing: an over-capture, an empty account and a failed query are not
conditions you seed on a live ledger to show someone."*

Note the **Operating ••4417** row before you click it:

```
Operating  ••4417  Blue Ridge Coffee Roasters LLC   $48,215.60   $33,715.60
```

### 1:00 — the authorisation moves available and does not move the ledger

Click that row. It opens `/accounts/acct_operating_4417?auth=pending` — the same
fixture with a $50.00 fuel-pump authorisation landed. Compare against the two
numbers you just read:

```
before (the /accounts row)     ledger $48,215.60                       available $33,715.60
after  (?auth=pending)         ledger $48,215.60   holds $2,050.00     available $33,665.60
                               ledger delta $0.00        available delta -$50.00
```

The ledger balance carries the annotation **"unchanged by the authorisation"**;
the available balance carries **"−$50.00 · down 50 dollars · SHELL OIL 1247
authorisation"**. Scroll to *How the available balance is derived from the
ledger balance* and the four rows add up exactly, in integers, with no clamp:

```
    ledger balance      $48,215.60
  − active holds         $2,050.00   (4 holds)
  − uncleared credits   $12,500.00   (1 pending · releases 09:00 ET)
  = available balance   $33,665.60
```

The **Holds** panel below it shows the authorisation arithmetic per hold —
authorised, cleared, remaining — because the remaining hold is
`max(authorised − cleared, 0)` over the event set and not a number any provider
told us. The demo-state bar at the top offers *Reverse the $50.00 fuel-pump
authorisation*, which is the same URL without `?auth=pending`; the state lives
entirely in the query string and nothing is written either way.

There is no `?auth=absent`. An empty query string is the **live** account, and
`acct_operating_4417` is not a live account id, so the bare URL answers
`ACCOUNT_NOT_FOUND` rather than quietly showing you a fixture. That is the
labelling rule working, not a broken link.

### 2:00 — the same story on a real account

Go back and open a **Deposit account** — the uuid-addressed rows, badged **live
ledger**. Nothing on that page came from a fixture:

```
a0c41a37…  Ridgeline Robotics, Inc.
    $46,877.93 − $200.00 − $0.00 = $46,677.93
```

Those four holds are real card authorisations that arrived as signed Lithic
webhook deliveries, were verified, drained, and posted to the memo book. The
page states its **booking watermark** and its **as-of** instant, because a fold
is only meaningful with both clocks named.

### 2:45 — `/approvals` as Staff

You arrive as **Priya Raman**, badged *cannot approve*. Read the panel titled
*Maker-checker on money out, and where it is actually enforced* — it names the
trigger, the SQLSTATE and the CHECK constraint, and ends with the sentence this
whole screen turns on:

> Where you see a disabled button below, the screen is telling you in advance
> what the database would do. It is not the check. Every decision is sent to
> Postgres and refused there.

Every approve and reject control in the queue is disabled for Priya, with the
`not_an_approver` reason attached to the control by `aria-describedby` so a
screen reader announces the refusal rather than leaving it to be found. Each
payment carries its **policy version** (`ach@2026-01-01`, threshold $2,500.00,
1 approval), the count of distinct approvals held, its full append-only
lifecycle, and its **content hash** — sha256 over the account, rail, amount,
destination and value date, which an approval must cite, so an approval given
for one amount cannot apply to another.

Several rows in the queue were raised by **Corgi payments agent**. They sit below
the threshold and need no human, which is what makes the agent surface
interesting rather than decorative: it can state an intention and it cannot make
anything final.

### 3:15 — switch to Approver, and watch the refusal change

Click **Approver**. The header now reads **Dana Okonkwo · can approve**, and the
queue's answers change with it:

- payments raised by Priya Raman or by the agent become approvable — the
  controls are live, and the reason text is gone;
- payments Dana raised herself are marked **"that is you"**, and the reason is
  now `self_initiated`: *"You raised this payment, so you cannot approve it…"*

That is the whole maker-checker demonstration in one click. Nothing about
Dana's rights is wrong — she is an approver, and the queue still refuses her —
so the refusal can only be the maker-checker rule.

If you want to see the database do it rather than the screen predict it:

```bash
node scripts/livefire.mjs --only 5
```

That raises a $4,200.00 ACH payment as a human who **is** an approver and then
attempts the approval twice: once as a raw `INSERT` with no application code in
the call stack, asserting SQLSTATE `42501` from `assert_maker_checker()` with
the actor id and instruction id in the message; and once through
`approvePayment()`, to show the application carries no second copy of the rule
and only translates the exception. It then proves a *different* human can
approve the same instruction — without which "it refused" would also be
satisfied by a system that refuses everything.

### 4:00 — `/reconciliation`, the breaks screen

Last night's settlement file against our book, matched on the provider's own
reference and on nothing else. Three break categories, no more and no fewer:
**in file, not in ledger**, **in ledger, not in file**, **amount mismatch**.

What was on screen: file `livefire-MTVRTYAB-tonight.csv`, matched 3 / 3, one
open break, net difference +$240.71. That break is the published planted-break
attack, left where it landed: live fire booked four inbound ACH settlements,
imported the complete file and reconciled it as a **control** — zero breaks —
then deleted one row and re-imported, and the screen answers with
`LF6-MTVRTYAB-3`, `in_ledger_not_file`, $240.71, with the entry id and value
date attached.

Two things to click while you are here. **Aging is measured in day closes, not
hours** — a break does not get younger because the nightly job ran late, and
`aged` means somebody signed off a business day with it outstanding, which is a
fact about a human decision. And **Runs over this file**: a reconciliation run
is immutable, so re-running appends a new run and never revises the old one.
Breaks themselves are a *view* rather than a table, so a break corrected ten
minutes ago reads as corrected without anything having to repair a row.

### 4:45 — close on the thing that is hardest to fake

```bash
pnpm db:check
```

Connects as `corgi_app` — the role the application actually uses — and attempts
`UPDATE`, `DELETE` and `TRUNCATE` on `journal_entry` and `journal_line`. A
success is a failure. It reports 14 passed, 0 failed, and the first six lines
are `permission denied for table journal_entry` / `journal_line`.

---

## 4. `scripts/verify-demo.mjs` — output

Run at 2026-09-10T17:56Z against the deployed URL. Exit code 0.

```
------------------------------------------------------------------------------
VERIFY DEMO — docs/DEMO.md, walked against the deployed system
base url   https://corgi-trial-psi.vercel.app
started    2026-09-10T17:56:26.860Z
------------------------------------------------------------------------------

   1. PASS  /api/health answers, the database is reachable, and it reports its slots
        status ok · db reachable · 4 live of 7
        LIVE      card_issuing       GET /v1/cards -> 200
        SIMULATED card_webhooks      credential present but NOT probed
        LIVE      director_kyc       Stripe Identity enabled (Persona not configured)
        SIMULATED business_registry  Connect not enabled. Every KYB option the brief lists (Middesk, Persona KYB, Sumsub KYB) is gated behind sales or business verification; registry runs simulated and is labelled so.
        LIVE      open_banking       POST /institutions/get -> 200
        LIVE      ach_rail           GET /accounts -> 200
        SIMULATED stablecoin         holds 20.00 USDC but only 0 wei gas; a transfer needs ~390000000000 — cannot send
   2. PASS  no nested webhook slot contradicts the authoritative live/simulated table
        5 webhook providers checked, every nested slot agrees
        must-be-live slots: card_issuing=live, director_kyc=live
   3. PASS  every screen in the click path answers 200
        GET /                200     6435 bytes
        GET /accounts        200    32341 bytes
        GET /approvals       200   724853 bytes
        GET /reconciliation  200    61673 bytes
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
        66fdc0f8…  $49,104.00 - $542.00 - $0.00 = $48,562.00
        a0c41a37…  $46,877.93 - $200.00 - $0.00 = $46,677.93
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
  finished   2026-09-10T17:56:33.530Z
------------------------------------------------------------------------------
```

### The one skip, and why it is a skip rather than a pass

Check 9 wanted to prove the maker-checker refusal *at the database* by POSTing
the approvals form by hand from this script, the way check 5 proves the role
switch by POSTing the switcher form by hand. It cannot. `DecisionForm` is a
client component driven by `useActionState`, so its server action does not emit
a no-JavaScript `$ACTION_ID_…` field into the HTML, and there is nothing for a
script to submit to.

That is a limitation of this checker, not a gap in the control, and the
distinction matters enough to print rather than to quietly fold into the pass
count. The refusal is proven by `node scripts/livefire.mjs --only 5`, against
the live database, with the raw `INSERT` and no application code in the call
stack. What check 8 does prove over HTTP is that the screen tells you the same
thing before you press anything, and names the trigger and the SQLSTATE while
doing it.

---

## 5. If you would rather drive the API than the console

`POST /api/mcp` is a Model Context Protocol server over Streamable HTTP with
four tools — three read, one that queues a payment request a person has to work
through. It refuses every call without a bearer token and there is no
development bypass, so it needs a grant in `MCP_AGENT_TOKENS`.
[`MCP.md`](./MCP.md) has the configuration, a full `curl` transcript and the
transport details; [`AGENT-LIMITS.md`](./AGENT-LIMITS.md) is the list of
operations deliberately absent from that surface, with the failure mode for
each.

`POST /api/drain` with `Authorization: Bearer $DRAIN_TOKEN` drains the webhook
inbox on demand, which is the "watch, I will drain it now" move rather than
waiting for the cron. The cron itself runs daily rather than hourly, and the
reason is in [`CUT-LIST.md`](./CUT-LIST.md) §2.3.
