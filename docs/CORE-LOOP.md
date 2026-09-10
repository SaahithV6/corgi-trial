# The core loop, end to end, in one command

```bash
set -a; . ./.env; set +a
node scripts/coreloop.mjs
```

One business. Seven legs, in the order the brief publishes them. Every write
goes through **https://corgi-trial-psi.vercel.app** as a form POSTed to its
server action — the identical request a browser with JavaScript disabled makes
— and between the legs the live database is read to prove the state actually
changed.

It exits non-zero unless every leg passes. A skip is not a pass.

```bash
node scripts/coreloop.mjs --base-url https://corgi-trial-psi.vercel.app
node scripts/coreloop.mjs --only 4,5      # a subset, by leg number
```

The loop, verbatim from [`BRIEF.md`](./BRIEF.md):

> open an account behind a real KYB check → fund it from a linked external bank
> → issue a real (sandbox) card → authorise, then settle for a different amount
> days later → send an outbound payment that needs a second approver → survive a
> reversed settlement → reconcile the scheme file

---

## 1. What "end to end" means here, and why it is the whole point

There is **not one call to an application function** anywhere in
`scripts/coreloop.mjs`. It imports `postgres` and nothing else from this
repository. `postEntry`, `reverseAndRebook`, `requestPayment`, `drain`,
`canTransact` — none of them are reachable from it, deliberately: a run that
could call them would be testing the process it runs in, not the deployment.

| | How the run drives it |
| --- | --- |
| **Screens with a form** | POST the form to its server action, `multipart/form-data`, over HTTPS to the deployed origin |
| **Provider-driven steps** | The deployed action calls the sandbox for real; the run then waits for the webhook and nudges `POST /api/drain` |
| **Reading state** | `SELECT` against the live Neon database. Read only, every statement |
| **A leg with no deployed surface** | **SKIP**, naming exactly what is missing |

### The mechanism: posting a real server action

Next renders React's progressive-enhancement fields into every form whose
`action` is a server action. There are two shapes and this run reads both:

```html
<!-- unbound: a server component's <form action={fn}> -->
<input type="hidden" name="$ACTION_ID_401fb0b176c8ae…" />

<!-- bound: a useActionState action inside a client component -->
<input type="hidden" name="$ACTION_REF_7" />
<input type="hidden" name="$ACTION_7:0" value='{"id":"60f4e595…","bound":"$@1"}' />
<input type="hidden" name="$ACTION_7:1" value='[{"status":"idle",…}]' />
<input type="hidden" name="$ACTION_KEY"  value="k6746aafcf3fa5e01…" />
```

The run scrapes those out of the live HTML, posts them back verbatim alongside
the named fields, and Next's action handler decodes them exactly as it decodes a
no-JavaScript browser submission (`node_modules/next/dist/server/app-render/action-handler.js`,
`areAllActionIdsValid` → React's `decodeAction`).

**Nothing is hard-coded.** Every action id in the transcript was read off the
deployment on that run; a redeploy that changes them changes nothing in the
script. Where the page eagerly loads the chunk that defines the action, the run
also resolves the id to its exported name — Turbopack compiles a client
component's reference to `createServerReference("<id>", …, "<exported name>")`,
so the deployment is the source of that mapping too. That is why the transcript
says `onboardingAction (60f4e595…)` for some legs and a bare id for others: the
console's forms live in a lazily-loaded chunk, so its ids resolve to no name and
the run prints the id rather than guessing.

### Reading the action's answer

The response to an MPA action POST is the re-rendered page, and React writes the
action's **return value** into that page's `$ACTION_<n>:1` bound-args field for
the next submission. The run parses it back out. So this in the transcript:

```
REFUSED       Holds Integration Fixture Co. -> KYB_PENDING
Verification is still in progress. … Nothing was raised: canTransact() refused
before a payment instruction could be written.
```

is the literal object `onboardingAction` returned on the deployment, not a
sentence scraped out of rendered prose. (One wrinkle worth knowing: in a flight
payload a string starting with `$` is a reference, so React escapes an ordinary
one by doubling it. `unflight()` takes the extra `$` back off, which is why a
card's spend limit reads `$5,000.00` and not `$$5,000.00`.)

### A correction to `docs/DEMO.md`

`DEMO.md` check 9 skips with:

> the approvals form is a client component, so its server action carries no
> no-JavaScript action id in the HTML and a hand-assembled POST cannot reach the
> trigger from this script.

That was measured with a regex looking only for `$ACTION_ID_`, which is the
**unbound** shape. A `useActionState` action in a client component emits the
**bound** shape, `$ACTION_REF_` / `$ACTION_<n>:0`, and it posts perfectly well.
Leg 5 below drives `decideAction` that way and gets the database's refusal back
over HTTP. The control was never in doubt; the checker's reach was.

---

## 2. Choosing the business — the deployment decides, not the script

The candidates are the businesses holding both leaves of the chart (a `2100`
deposit account and its `9100` memo account), because a business without both
cannot hold a card hold. Which of them may transact is then settled by
**pressing the gate on the deployed `/onboarding` screen for each of them** and
reading the answer:

```
  WHY THIS BUSINESS — the deployed gate was asked, live, before anything else ran
    REFUSED  KYB_PENDING     Holds Integration Fixture Co.   pending/simulated, 0 leg(s)  <- leg 1's foil
    ALLOWED  KYB_ALLOWED     Ridgeline Robotics, Inc.        approved/manual, 2 leg(s)    <- the subject
```

Re-deriving `canTransact()`'s rule inside this script would be a second opinion
that can drift from the first — which is exactly the failure the KYB leg exists
to catch. It was worth doing: mid-development this run reported
`KYB_STATE_UNREADABLE` for a business the database showed as `approved`, because
a new `kyb_evidence` value had landed in the schema ahead of the code that reads
it. A hard-coded subject would have printed a confident wrong answer.

When the gate allows nobody, the run still picks a subject — allowed first, then
whoever has real KYB legs on file, then whichever refusal is closest to an
allowance — says so in yellow at the top, and skips the legs that need a
transactable business.

---

## 3. The seven legs

### 1 — KYB gate

Presses **Try to start a payment** on `/onboarding` for the unverified business
and asserts a refusal carrying a `KYB_` code; then raises a real payment for the
same business at `/payments` and asserts it is refused *and wrote zero rows*;
then presses the gate for the verified business and asserts `KYB_ALLOWED`,
listing both verification legs with the provider and provider reference that
answered each.

The refusal is the interesting half, so it is proven twice: once at the gate
control, once on the money path where it actually bites.

### 2 — Fund from a linked external bank

POSTs the `/funding` form and asserts the thing that makes an inbound credit
different from a balance going up:

```
figures                 LEDGER         HOLDS     UNCLEARED     AVAILABLE
  before            $29,541.33       $360.00     $8,753.00    $20,428.33
  after             $30,791.33       $360.00    $10,003.00    $20,428.33
  delta             +$1,250.00         $0.00    +$1,250.00         $0.00
```

Ledger up $1,250.00. Available up **nothing**. The identical amount is withheld
by an `uncleared_credit` hold with a release time, and the run reads that hold
back by the run's own reference.

### 3 — Issue a real (sandbox) card

POSTs the issue-card form on `/accounts?business=<id>`, asserts a Lithic card
token and a four-digit last four came back, and then asserts the card is
registered *in this ledger* against this business's own `2100` and `9100`. A
card at the provider that is not bound here is a card whose authorisations park;
the leg checks both halves.

### 4 — Authorise $50.00, settle $73.40 — the heart of the track

Two POSTs and two waits.

```
on the AUTHORISATION                 LEDGER         HOLDS     UNCLEARED     AVAILABLE
  before            $30,791.33       $360.00    $10,003.00    $20,428.33
  after             $30,791.33       $410.00    $10,003.00    $20,378.33
  delta                  $0.00       +$50.00         $0.00       -$50.00

AUTH -> SETTLEMENT                 LEDGER         HOLDS     UNCLEARED     AVAILABLE
  before            $30,791.33       $360.00    $10,003.00    $20,428.33
  after             $30,717.93       $360.00    $10,003.00    $20,354.93
  delta                -$73.40         $0.00         $0.00       -$73.40
```

Available fell by the amount **authorised** while the ledger did not move a
cent. Then the ledger fell by the amount **settled** — a different number — and
the hold came off. The over-capture of $23.40 is not special-cased anywhere.

**"Released exactly once" is counted on the memo book, not on `hold_closure`.**
A card hold has no amount column: its size is the balance of its own `9100` memo
account, and a release is an appended memo entry taking that balance to zero.
The leg asserts exactly one opening memo entry, exactly one releasing memo
entry, a net memo balance of zero, `v_hold_state.active_hold_cents = 0`, and
zero closure reversals. Counting `hold_closure` rows would measure the wrong
mechanism — that table is the explicit-closure path from migration 0011 and a
card hold released by compare-and-append has none. The first draft of this
script got that wrong and failed the leg for it.

**What this leg does not prove:** "days later". Lithic's sandbox clears on
demand, so the clearing arrives about three seconds after its authorisation. The
different *amount* is the part a clock cannot fake and it is proven; the
value-date axis is leg 6's job, and the transcript says so rather than implying
two days passed.

### 5 — An outbound payment that needs a second approver

Raises $3,200.00 ACH as **Staff (Priya Raman)** through `/payments` — above the
$2,500.00 policy threshold, which the run reads from `approval_policy` and
asserts against rather than assuming.

Then, over HTTP, on the real `/approvals` decision form:

- **the initiator presses approve on her own payment** → refused,
  `NOT_AN_APPROVER`, and the run asserts **zero** `approved` events were written;
- **the approver raises a payment of her own and presses approve on it** →
  refused, `SELF_APPROVAL` — the maker-checker branch specifically;
- **the approver presses approve on the payment Staff raised** → accepted.

The queue renders both refused buttons `disabled`. The run's POST was assembled
by hand and reached the trigger regardless, which is the point: the screen is a
legibility layer, and the control is in the database.

The SQLSTATE is read from the trigger that raises it, not from a string in the
application:

```
the refusal's source, read from this database:
  function    assert_maker_checker()   trigger payment_instruction_event_maker_checker
  SQLSTATE    42501 — RAISE EXCEPTION 'maker-checker: actor % initiated instruction % and
              cannot approve it' USING ERRCODE = '42501'
```

The leg closes by printing the instruction's whole lifecycle from
`payment_instruction_event`, with the actor on each event, so the maker and the
checker can be read off as two different people.

### 6 — Survive a reversed settlement — **currently SKIPS**

This is the one leg that cannot be driven end to end today, and the run says so
precisely rather than finding another way to make it green.

Before skipping, the run **surveys every console screen** — `/accounts`,
`/payments`, `/approvals`, `/statements`, `/reconciliation`, `/standing-orders`,
`/onboarding`, `/funding` — for a control that would reverse a settlement, by
action name and by field name, and prints what each screen actually renders. On
`/accounts` that is five distinct actions
carrying `role`, `businessId+formKey+nickname`,
`cardToken+businessId+amount+mcc+descriptor`, `businessId`, and
`businessId+transactionToken+amount`. None of them corrects a booked card entry.

The correction *machinery* is not in question — dozens of card entries on this
book already carry a `reverses_entry_id`, and the statement screen renders both
readings at `/statements?account=<id>&day=<settlement day>`. What is missing is
a way to **reach** it from the deployment, and that half is being written now
(`src/lib/holds/`, `src/lib/webhooks/consumers/lithic-card.ts`).

The skip names the exact row it would have reversed: the settlement's provider
transaction token, its value date, and its journal entry id.

**Why not reverse it some other way?** Two tempting shortcuts, both refused:

- *Call `reverseAndRebook()` from the script.* That proves the library, not the
  deployment, and the whole claim of this file is that no application function
  is in its call stack.
- *Ask Lithic's sandbox for a `RETURN`.* Legitimate as a provider call, but a
  Lithic return is a **new refund at today's value date**, which the consumer
  books as `refund`. It is not a backdated correction of Tuesday's settlement,
  so booking one and calling it a reversal would be a different claim wearing
  this leg's name.

When the correction control lands, the leg's assertions are already written: the
reversing entry must carry the **original** value date, and the statement for
settlement day must carry both readings.

### 7 — Reconcile the scheme file

Reads `/reconciliation`, pulls the references the breaks table actually renders,
and asks the database to corroborate them. That direction matters: the screen
renders the *live* view rather than a run's snapshot and says so on the page, so
a run this script picked with `ORDER BY started_at DESC` would be a second
opinion that disagrees with it — and it did, on the first attempt, because other
work on this book creates reconciliation runs constantly.

Asserts the break's category is one of the three, that the screen names it, that
the amount matches to the cent, that an age and a severity are rendered, and
that all three categories appear so none can go unseen.

The planting itself has no deployed control — `/reconciliation` renders no write
form — so the run does not claim to have planted the break. What it proves is
detection, categorisation and aging, on the deployed screen.

---

## 4. The rules the script holds itself to

**The verdict is derived from assertions, never asserted about itself.** A leg
is a function that records `check(condition, text)` calls. `verdict()` is a fold
over those records:

```
PASS   at least one check ran and every one held
FAIL   a check did not hold, or the leg threw
SKIP   the leg stopped deliberately, or it asserted nothing at all
```

There is deliberately no branch turning "nothing was checked" into a pass, and
`--only` cannot make a leg pass by not running it.

**Money is bigint cents.** No `parseFloat`, no `Number` on an amount, no
division by 100 outside the single formatter that renders a bigint as text by
string arithmetic. The driver is configured with the same `bigint` type as
`src/lib/ledger/db.ts` for the same reason: without it Postgres hands back
`int8` as a string, `ledger - holds` becomes string arithmetic, and `=== 5000n`
is a comparison that is always false. Measured — it happened, and it is why
`cents()` exists for view columns that compute their way to `numeric`.

**Isolation without teardown.** Every reference, nickname and descriptor the run
controls carries a per-run token, `CL-<base36 clock>`, and every assertion is
made by it. Nothing is torn down: the money tables are append-only by design and
`corgi_app` holds no `DELETE` on them. The run writes real rows and says so.

**The database is read only.** Every statement in the script is a `SELECT`. The
`availableBalance()` derivation is re-expressed rather than imported, because
importing it would put application code in the call stack — it is the yardstick,
not a second opinion the app is consulted for.

**Invariants are checked, not assumed.** The run finishes by shelling out to
`scripts/dbcheck.mjs` — which connects as `corgi_app` and attempts `UPDATE`,
`DELETE` and `TRUNCATE` on the money tables — and requires **14 passed, 0
failed**. Anything else fails the run.

---

## 5. The scoreboard

Last full run — `CL-MTW54U5Y`, 2026-09-10T23:10:39Z, against
`https://corgi-trial-psi.vercel.app`: **6 PASS, 0 FAIL, 1 SKIP**, invariants
**14/14**, 96 HTTP calls to the deployed origin, 44 seconds, exit code 1
(because of the skip).

| Leg | | Proven by |
| --- | --- | --- |
| 1 KYB gate | **PASS** | 10 checks — `KYB_PENDING` refusal at the gate *and* at `/payments` with 0 rows written; `KYB_ALLOWED` with both legs' providers named |
| 2 Fund from a linked bank | **PASS** | 7 checks — ledger +$1,250.00, available +$0.00, uncleared +$1,250.00, and the hold that explains it |
| 3 Issue a card | **PASS** | 9 checks — real Lithic token and last four, bound to this business's 2100/9100 |
| 4 Authorise then settle | **PASS** | 24 checks — available −$50 with the ledger still, ledger −$73.40, hold released exactly once |
| 5 Second approver | **PASS** | 27 checks — initiator refused, self-approval refused as `SELF_APPROVAL`, second role approves; SQLSTATE 42501 read from the trigger |
| 6 Reversed settlement | **SKIP** | no deployed control reverses a settlement; every screen surveyed and printed |
| 7 Reconcile the scheme file | **PASS** | 11 checks — the break the screen renders, corroborated in the database, with kind, amount, age and severity |

Exit code is **0 only when every leg passes**; the skip alone makes it 1, which
is the point — a gap that does not change an exit code is a gap nobody acts on.

Re-run it. It is meant to be re-run, and leg 6 turns green on its own the moment
a correction control reaches the deployment: the leg's assertions are already
written and its survey already prints the screens it is watching.
