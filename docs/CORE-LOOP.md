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
| **Provider-driven steps** | The sandbox is called for real — by the deployed action (leg 4) or directly, where no screen exposes the call (leg 6) — and the run then waits for the real webhook and nudges `POST /api/drain` |
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
  before            $31,894.53       $360.00    $11,253.00    $20,281.53
  after             $33,144.53       $360.00    $12,503.00    $20,281.53
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
  before            $33,144.53       $360.00    $12,503.00    $20,281.53
  after             $33,144.53       $410.00    $12,503.00    $20,231.53
  delta                  $0.00       +$50.00         $0.00       -$50.00

AUTH -> SETTLEMENT                 LEDGER         HOLDS     UNCLEARED     AVAILABLE
  before            $33,144.53       $360.00    $12,503.00    $20,281.53
  after             $33,071.13       $360.00    $12,503.00    $20,208.13
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

### 6 — Survive a reversed settlement

The one leg with no button on any screen, because a merchant reversing a
settlement does not originate at the customer's bank — it originates at the
network. So it is driven **at the provider**, over Lithic's own sandbox API,
and the deployment's consumer does the rest:

```
POST https://sandbox.lithic.com/v1/simulate/return           {amount, descriptor, pan}  -> 201
POST https://sandbox.lithic.com/v1/simulate/return_reversal   {token}                    -> 201
```

The `RETURN_REVERSAL` comes back as a **real signed webhook** to the deployed
endpoint and is drained by the deployed pipeline. This is the same shape as leg
4 — the only difference is that no screen exposes this call. Nothing is written
to the database by the script; every consequence is the deployment's.

**The classification is data, not an `if`.** The run reads the row that sent the
event down the correction path back out of the database and asserts it:

```
classified by card_transaction.updated/RETURN_REVERSAL
              kind=refund_reversal semantics=correction value date from original.value_date
```

`resolveEventSemanticsBatch()` routes any step whose value-date anchor is
`original` to `src/lib/holds/corrections.ts` and `reverseAndRebook` at the
**original entry's** value date. No event type is hard-coded in the consumer, so
the leg asserts against the table rather than against a list of event names.

**Both time axes, which is the whole leg:**

```
BOTH TIME AXES, on 2026-09-10, account a0c41a37-2be1-5c30-bfe9-03455f048fac:
  value date    original 2026-09-10   correction 2026-09-10   SAME DAY
  booking seq   original 1180         correction 1181         LATER
  as believed         $63,806.63   read at watermark 1180
  as corrected        $63,733.23   read at watermark 1181
  difference             -$73.40   exactly the refund taken back
```

Two assertions standing at once. The correction belongs to the day the thing
happened, so that day's figure changed. And it was learned later, so the
pre-correction watermark **still returns the pre-correction number** — the run
re-reads it after the correction lands and asserts it is unchanged, because a
closed reading that moves is not reproducible. Value date and booking date are
different columns; `balanceAsOf(account, valueDate, watermark)` holds one still
and moves the other, and the corrected figure is that same query with the
watermark left open. It is not stored anywhere.

The reversal is also asserted to be `entry_type = 'reversal'`, to carry the same
`correction_group_id` as its subject, and to leave the ledger exactly where it
started — a refund taken back nets to nothing.

**One provider limit, encoded rather than fought.** The pair runs on its own
transaction rather than on leg 4's settlement, and that is Lithic's constraint,
not a preference:

| Attempt on a cleared debit | What the sandbox does |
| --- | --- |
| `return_reversal` | **400** — "Return reversal is not supported for debit transactions" |
| `void` | appends `AUTHORIZATION_REVERSAL` and never touches `settled_amount` |
| `clearing` with a negative amount | **ignores the sign** and adds a second capture |

The third is the dangerous one: it returns 201 and looks like it worked. The leg
prints all three in its evidence and does not go near them. A bare `RETURN` on
its own is refused for a different reason — it is a new refund at *today's*
value date, a different claim wearing this leg's name. It is the **reversal of
that refund** that the deployment classifies as a correction, and that is what
is asserted.

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

Last full run — `CL-MTW5GIX5`, 2026-09-10T23:19:44Z, against
`https://corgi-trial-psi.vercel.app`: **7 PASS, 0 FAIL, 0 SKIP**, invariants
**14/14**, 91 HTTP calls to the deployed origin and 3 to the Lithic sandbox,
56 seconds, **exit code 0**.

| Leg | | Proven by |
| --- | --- | --- |
| 1 KYB gate | **PASS** | 10 checks — `KYB_PENDING` refusal at the gate *and* at `/payments` with 0 rows written; `KYB_ALLOWED` with both legs' providers named |
| 2 Fund from a linked bank | **PASS** | 7 checks — ledger +$1,250.00, available +$0.00, uncleared +$1,250.00, and the hold that explains it |
| 3 Issue a card | **PASS** | 9 checks — real Lithic token and last four, bound to this business's 2100/9100 |
| 4 Authorise then settle | **PASS** | 24 checks — available −$50 with the ledger still, ledger −$73.40, hold released exactly once |
| 5 Second approver | **PASS** | 27 checks — initiator refused, self-approval refused as `SELF_APPROVAL`, second role approves; SQLSTATE 42501 read from the trigger |
| 6 Reversed settlement | **PASS** | 22 checks — provider-driven `return` + `return_reversal`, real signed webhook, correction at the **original** value date with a later booking seq, as-believed vs as-corrected differing by exactly −$73.40 |
| 7 Reconcile the scheme file | **PASS** | 11 checks — the break the screen renders, corroborated in the database, with kind, amount, age and severity |

Exit code is **0 only when every leg passes**. A skip alone makes it 1, which is
the point — a gap that does not change an exit code is a gap nobody acts on.

Leg 6 skipped when this script was first written and passed about ten minutes
later, without the assertions changing, because the card correction path landed
and deployed. That is the shape a run like this should have: the legs assert the
property, the deployment either has it or does not, and the scoreboard is the
difference.
