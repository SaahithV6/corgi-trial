# The cross-border payout, and the FX quote the customer accepts first

Stretch-ladder item one, verbatim: *"The cross-border USDC payout with an FX
quote the customer accepts first."*

| | |
| --- | --- |
| Screen | `/payouts` |
| Schema | `db/migrations/0017_fx_quotes.sql` |
| Code | `src/lib/fx/**`, `src/components/payouts/**`, `src/app/(app)/payouts/**` |
| Rate source | `frankfurter.dev` — **live**, measured, no key, no signup |
| Off-ramp partner | **none.** The last mile is not built, and §7 says so at length |
| Journal entries written | **zero by a quote or an acceptance** — a quote is not a transaction (§6). A *settlement* posts one five-line entry, since §11 |
| Refusal code for an unquoted payout | `FX_QUOTE_NOT_ACCEPTED` |
| Rows in `fx_quote_settlement` | **9 — two real, seven test fixtures, each labelled as one.** §12, §13 |

---

## 1. What this is, and the trap it is built to avoid

The brief says **"the ledger is USD, in cents, even when the rail is a
stablecoin"**, and the rules say **multi-currency is explicitly out of scope**.
Both are obeyed literally. Nothing in this feature touches `journal_line`, adds
a currency to it, or opens an account in anything but USD.

What a quote *is*: a **customer-facing commitment** about a payout that has not
happened yet. We tell a customer *"send us $1,000.00 and your supplier in
Guadalajara receives 16,799.77 MXN"*, they accept, and from that moment the
peso figure is fixed — even if the market moves before it settles. The general
ledger stays in USD cents throughout.

There is exactly one non-USD number in the entire database:
`fx_quote.buy_minor`. It is a **promise**, not a balance. It is never summed
with anything, never nets to zero against anything, and no view adds it to a
dollar. `fx.integration.test.ts` asserts that `SELECT DISTINCT currency FROM
journal_line` returns `['USD']` and nothing else, after the whole suite has
run.

**If a change here starts wanting a currency column on `journal_line`, the
change is wrong.**

---

## 2. The rate source, measured

### The exact call

```
$ curl -sS -D - -o - \
    'https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN,PHP,INR,BRL,JPY'

HTTP/2 200
content-type: application/json; charset=utf-8
cache-control: public, max-age=86400

{"amount":1.0,"base":"USD","date":"2026-09-10",
 "rates":{"BRL":5.1247,"INR":95.44,"JPY":154.18,"MXN":16.9435,"PHP":62.576}}
```

**Status 200. ~0.45 s. No API key, no signup, no account, no rate limit
published.** The URL is built in one place — `frankfurterUrl()` in
`src/lib/fx/rate.ts` — and printed on the screen verbatim, so what the docs
claim and what the code calls cannot drift.

Frankfurter republishes the **European Central Bank's daily euro reference
rates** and cross-computes the pairs.

### What that number is, and what it is not

**It is real.** A third party answered a real call. Every quote priced from it
carries `evidence = 'live'`, the HTTP status code, the source's own date, and
the exact characters it printed — all four on the row, all four on the screen.

**It is not a dealable price, and the screen says so in those words.** The ECB
publishes once per working day at about 16:00 CET; the response's own
`cache-control: max-age=86400` is the source telling you its refresh rate. A
Saturday fetch returns Friday's rate under Friday's date. Nobody will trade
with you at the mid.

So the claim this system makes is exactly two things, and no more:

> **The mid is live. The spread is ours.**

What the customer is offered is the live mid less a spread we set and print as
its own line. Nothing anywhere calls the result a market price.

### The labelled fallback

When the call fails — timeout, non-200, an unparseable body, no network —
`FIXED_RATE_TABLE` in `src/lib/fx/rate.ts` answers instead. Every quote priced
from it carries:

* `fx_rate_observation.evidence = 'simulated'`,
* a `fallbackReason` naming what went wrong,
* `rate_date` of **2026-09-10**, the day those figures were read off the live
  source — never today's date, because a simulated rate reporting the current
  date is a simulated rate wearing a live one's clothes,
* and a **SIMULATED RATE** badge in the negative colour, on the quote row and
  in the arithmetic panel, in words.

There is no configuration that makes the fallback look live. `observeRate()` is
the only function that substitutes one for the other, and it records the
substitution on the observation.

---

## 3. Scale, and the no-floats chain

**Money is `bigint` cents. Rates are `bigint` scaled by 10^8. There is no
`number` in any money or rate position anywhere in `src/lib/fx/**`.**

`RATE_SCALE = 100_000_000n` — eight decimal places. Eight because the pairs we
quote span three orders of magnitude (5.12 to 154.18, and a hypothetical IDR at
16,000), and eight holds every one of them either way round with headroom. It
is also the precision the market quotes small-figure crosses at.

**The scale is stored on every row that carries a rate**
(`fx_rate_observation.rate_scale`, `fx_quote.rate_scale`) rather than assumed to
be the constant. That costs 8 bytes and buys the thing a constant cannot: if
the scale is ever widened, every historical quote still reads back as the number
it actually was instead of silently becoming a hundred times itself. The schema
CHECKs it is a power of ten — a scale that is not would make every printed rate
a lie about its own decimal places.

### The one place a float could have got in, and did not

```js
JSON.parse('{"MXN":16.9435}')   // -> 16.943500000000000227... an IEEE-754 double
```

`16.9435` is not representable in binary floating point. By the time any of our
code ran, the original decimal would be **gone** — unrecoverable — and
`Math.round(x * 1e8)` happens to be right for this value and is not right for
all of them.

So the response body is treated as **text**:

1. `extractRateLiteral()` lifts the decimal literal out of the `rates` object
   with a regex. It is anchored on the quoted key, so `"INR"` cannot match
   inside `"XINR"`, and it only reads inside the `rates` block, so the `base`
   field cannot be mistaken for a rate.
2. `parseDecimalToScaled()` turns those characters into a `bigint` by string
   surgery — pad the fraction to eight places, concatenate onto the whole part,
   `BigInt(...)`. Nothing is multiplied by a power of ten as a `number`, and
   nothing is divided at all. An exponent form like `1.6e1` is refused rather
   than guessed at.
3. The literal is carried all the way to `fx_rate_observation.rate_literal`, so
   the integer beside it **can be re-derived by hand from the row**.

Rendering never divides either: `formatRate()` and `formatMinorUnits()` build
their output from the digit string, so a rate cannot display as
`16.943499999999998` on the one screen where a customer is deciding whether to
agree to it.

---

## 4. The arithmetic, and all four rounding rules

Four formulas. Each exists **twice** — as a TypeScript function in
`src/lib/fx/quote.ts` and as an `IMMUTABLE` SQL function in 0017.

| TypeScript | SQL | Rounds | In whose favour |
| --- | --- | --- | --- |
| `feeCents` | `fx_fee_cents` | **up** | ours, ≤ 1¢ |
| `customerRateScaled` | `fx_customer_rate` | **down** | ours |
| `buyMinorUnits` | `fx_buy_minor` | **down** | unavoidable |
| `costCents` | `fx_cost_cents` | **up** | against us |

Three of the four favour us. That is what every dealer does, and it is exactly
why they are written down here, printed in the screen's arithmetic panel, and
stated in the code. **A rounding rule nobody states is a rounding rule nobody
can audit.**

The delivery floor is the interesting one: it is the only rounding against the
customer, and it is unavoidable, because a fraction of a centavo cannot be
delivered by anybody. Rounding *up* would commit us to money we did not buy.
`PricedQuote.deliveryResidualTenThousandths` reports the size of that
rounding — under a hundredth of a US cent on an MXN corridor — so "we rounded
down" comes with the magnitude rather than as a bare admission.

### Worked example, and it is the real one

$1,000.00 to Mexico, at the mid Frankfurter printed on 2026-09-10:

```
amount in                    100000 cents            $1,000.00
fee            100 + ceil(100000 × 25 / 10000)  =       350     − $3.50
converted                     99650 cents              $996.50
mid rate                 1694350000 @ 1e8           16.9435
spread          floor(mid × 9950 / 10000)  = 1685878250  →  16.8587825
delivery   floor(99650 × 1685878250 × 10^2 / (100 × 1e8))
                                          =   1679977   16,799.77 MXN
spread worth        99650 − fx_cost_cents(1679977, mid)  =  498     $4.98
```

Verified against the live database in `fx.integration.test.ts`, and reproduced
by the seeded demo quote `FXQ-GSMXG5HE`.

### Why the same formula exists twice, and what makes that acceptable

Duplicating a formula is normally the wrong answer. It is the right one here
for the reason `aba.ts` is allowed to duplicate `aba_checksum_ok()`, and under
the same non-negotiable condition:

* **The screen has to price a quote before anything is stored.** A customer
  asking "what would this cost" has not agreed to anything, and making that a
  database round trip means a row for every idle question.
* **The database has to generate what it stores.** `fee_cents`,
  `customer_rate_scaled` and `buy_minor` are `GENERATED ALWAYS ... STORED`
  columns. A caller **cannot** write a commitment that does not follow from the
  rate it claims — not the application, not a psql prompt, not the table owner.
  The integration test proves this by trying: the INSERT is refused with
  *"cannot insert a non-DEFAULT value into column buy_minor"*.

The condition is the test. `fx.integration.test.ts` runs a corpus of **1,600+
cases** — amounts straddling every rounding boundary, both minor-unit exponents,
fee and spread settings at zero and at the ceiling, amounts past
`Number.MAX_SAFE_INTEGER` cents — through both copies and asserts they agree
digit for digit. Without that test this duplication is a liability.

(SQL note: `numeric` appears inside those four functions and nowhere else. It is
Postgres's **exact decimal** type, used as a wide integer accumulator so an
intermediate product cannot overflow `bigint`; every function floors or ceilings
back to `bigint` before returning. `double precision` appears nowhere in 0017.)

---

## 5. The lifecycle, and the gate

### A quote is an offer with an expiry

`fx_quote` is the offer. **`expires_at` is part of the offer, not a policy the
application applies afterwards** — it is stored absolute, computed from the
*database's* `now()` rather than the application's, so a lambda whose clock has
drifted cannot write an offer that stands longer than it should. The schema caps
the life of an offer at fifteen minutes; the default is **120 seconds**.

### Acceptance is a row, never an edit

There is **no `status` column on `fx_quote`**, no UPDATE anywhere, and
`corgi_app` holds SELECT and INSERT on all four tables and nothing else —
enforced by GRANT, by explicit REVOKE, and by append-only triggers that catch
even the table owner.

`fx_quote_acceptance` has the **quote id as its PRIMARY KEY**, exactly like
`hold_closure` and `payee_archival`: acceptance can happen once, cannot happen
twice, and cannot be undone. Two simultaneous acceptances are one row and one
unique violation, and the loser is told so rather than quietly overwriting the
winner.

**An expired quote stays on file forever.** It is on the screen, in the book,
with its rate and its arithmetic, indefinitely.

### The expiry is enforced by the database

```sql
-- 0017 §4
CREATE TRIGGER fx_quote_acceptance_before_expiry
  BEFORE INSERT ON fx_quote_acceptance
  FOR EACH ROW EXECUTE FUNCTION fx_quote_acceptance_guard();
```

The guard reads the quote's own `expires_at` against the transaction clock and
raises SQLSTATE `55006`. This is the control; everything else in the feature is
arithmetic and presentation.

The application deliberately does **not** re-check the expiry before the
INSERT — the rule `src/lib/approvals/refusal.ts` states at length. Two reasons,
and the second is the one that matters: a pre-check is a second, weaker copy of
the control and it is always the copy people hit; and between `SELECT
expires_at` and `INSERT` an offer can lapse, which is a race a pre-check cannot
close and the trigger closes by construction.

The countdown on the screen renders the expiry; it does not decide it. **The
accept button is never disabled by it.** A browser clock can be minutes out, and
a greyed-out button demonstrates nothing — pressing accept on a lapsed offer
sends a real request and gets a real refusal with a real code.

### Five states, none of them stored

`v_fx_quote.state` derives all five from the presence of rows and a comparison
against `now()` — the same rule available balance follows, because a status
column is a second copy of the truth that drifts and then gets "fixed" by a cron
job.

| State | Meaning | Remedy |
| --- | --- | --- |
| `open` | An offer that still stands. We are committed to nothing. | — |
| `expired` | Nobody accepted it in time. Costless. This is what an expiry is *for*. | Re-quote (one click) |
| `accepted` | A live commitment. We carry the market risk. | Send it |
| `lapsed` | Accepted, then not sent inside the settlement window. | Re-quote |
| `settled` | A payout consumed it. One accepted rate funds one transfer. | — |

**`expired` and `lapsed` are deliberately different words for different facts.**
An expired quote is an offer nobody took: nothing was committed and nothing was
lost. A lapsed one is a commitment we *did* make and honoured for the whole
window we named. Collapsing them would make the screen unable to say which
happened, and they owe the customer different explanations.

### The gate

```ts
// src/lib/fx/gate.ts
export async function requireAcceptedQuote(
  context: PayoutQuoteContext,
  conn: Sql = sql,
): Promise<FxRefusal | null>   // null means proceed
```

| Code | When |
| --- | --- |
| `FX_QUOTE_REQUIRED` | the payout names no quote at all |
| `FX_QUOTE_NOT_FOUND` | the reference matches nothing on file |
| **`FX_QUOTE_NOT_ACCEPTED`** | **the quote exists and nobody accepted it** — including one that expired unaccepted |
| `FX_QUOTE_COMMITMENT_LAPSED` | accepted, but the settlement window has closed |
| `FX_QUOTE_ALREADY_SETTLED` | already consumed by a payout |
| `FX_QUOTE_MISMATCH` | wrong customer, wrong recipient, or more USDC than the customer authorised |

**`FX_QUOTE_NOT_ACCEPTED` is the headline code** — the direct answer to *"a
payout without an accepted, unexpired quote must be refused with its own
code"*.

Five codes rather than one, for the reason `payee_directory_result` has four
values rather than two: these are different facts with different remedies, and
an operator holding a single `FX_QUOTE_INVALID` cannot tell *"you never quoted
this"* from *"you quoted it and waited too long"*.

#### It fails closed, unlike the payee gate — and the asymmetry is deliberate

`gatePaymentOnPayee()` returns `null` (proceed) when it cannot reach the
database, and that is right for it: it is an additional check in front of
controls that *do* hold, and a destination-validation service that can stop
every payment by falling over is the bigger risk.

This gate takes the opposite position. It is not an additional check — **it is
the control**. "The customer agreed a price" has no second enforcement point
anywhere in the system. An outage here stops cross-border payouts, which
somebody notices and fixes; failing open produces a commitment nobody made,
which nobody notices until the customer does.

#### Where to call it — the one line

In `scripts/payout-usdc.mjs`, immediately before the `sendUsdcPayout` call:

```js
const { requireAcceptedQuote } = await import(`${SRC}lib/fx/gate.ts`);

const refusal = await requireAcceptedQuote({ quoteRef: QUOTE, amountUnits: AMOUNT_UNITS, toAddress: RECIPIENT });
if (refusal) { console.error(`${refusal.code}: ${refusal.message}`); await sql.end(); process.exit(1); }
```

with `--quote` read alongside the other options
(`const QUOTE = option("quote", process.env.USDC_PAYOUT_QUOTE ?? null);`).

**It is deliberately *not* called inside `src/lib/rails/stablecoin/adapter.ts`.**
That module holds no database handle by design — the whole crash-recovery story
in its header depends on the adapter and the ledger being separable — and a rail
adapter that cannot send without a Postgres round trip is a rail adapter that
stops working when Postgres does. The gate belongs at the orchestration point
that already holds both, which is the same place `postUsdcPayout()` is called.

---

## 6. Who eats the difference, and where it posts

**This is the question the whole feature exists for.**

A customer accepted *$1,000.00 → 16,799.77 MXN* at a mid of 16.9435. By the time
it settles the peso has strengthened to 16.50. We are still committed to 16,799.77
MXN, and buying that now costs **$1,018.10**. The customer pays $1,000.00.

**We eat $21.60.** Unhedged, in both directions — a gain when the move goes our
way and a loss when it does not. That is what a rate commitment *is*, and it is
printed on the screen in those words while the commitment is live:

```
mid when quoted   16.9435
mid now           16.5012
delivery cost     $1,018.10
our position      -$21.60
```

`settlementVariance()` computes it and `fx_quote_settlement.variance_cents`
records it, signed — positive we kept it, negative we ate it. One signed column
rather than a gain column and a loss column, for the same reason `journal_line`
has one signed `amount_cents`: two columns is two places for a sign error to
hide. The schema refuses a settlement row that does not satisfy the identity:

```
amount in  −  our fee  −  what the delivery cost  =  variance
```

### The settlement entry

```
DR  2100/<business>   sell_cents              the committed price
CR  4200              fee_cents               our disclosed fee
CR  1140              settlement_cost_cents   the USDC that actually left
CR/DR  ????           variance_cents          what the market move cost us
```

Three of those four accounts already exist and are exactly right: `2100`
(customer deposits — the customer spending money is a *debit*, chart.ts fact 1),
`4200` (fee income, "fees we charge the customer … credited at the same instant
the customer's deposit account is debited"), and `1140` (the USDC omnibus
wallet, carried in cents).

### The fourth account does not exist, and I did not invent it

There is **no account in `src/lib/ledger/chart.ts` for an FX settlement
variance**, and there is no honest way to fold it into one that is there:

* not `5200` — that is credit loss: chargebacks, unrecoverable overdrafts,
  unauthorised ACH returns;
* not `5100` — that is what the network, the sponsor bank and the ACH originator
  charge *us*;
* not `2900` — that is sub-cent dust, and the variance is dollars;
* **not netted into `4200`.** An expense booked as negative fee income is exactly
  the netting `5100`'s own `why` refuses ("never netted silently against 4100").
  A fee and a market loss are two different facts.

`src/lib/ledger/chart.ts` is not owned by this work, so the account is written
down rather than added silently. **This is the exact literal to insert after
`4200`:**

```ts
{
  code: "4300",
  name: "FX quote settlement variance",
  type: "income",
  book: "financial",
  parent: "4000",
  postable: true,
  why: "The difference between the rate a customer accepted and the market when their payout actually settled. An accepted quote is a price commitment we hold unhedged, so this line is a real P&L position and not a rounding artefact: it is credited when the move goes our way and DEBITED when it does not, which is why one signed account rather than a 4300/5400 pair — an FX variance is one fact with two signs, and splitting it means the P&L has to add them back together to answer 'what did our rate commitments cost us this month'. Distinct from 4200 because a disclosed fee and an unhedged market loss are different facts, and from 5200 because nobody defaulted.",
},
```

A credit-normal account carrying a debit balance when we lose reads as negative
income, which is exactly what an FX book does.

**Until that account exists, nothing in this feature posts to the journal at
all** — and the integration test asserts it, by counting `journal_entry` before
and after the whole suite. That is the correct behaviour rather than a gap: an
offer is not a transaction, an acceptance is not a transfer, and the settlement
posting belongs to `postUsdcPayout()`, one module over, which this work does not
own. `variance_cents` is stored in the meantime so the unposted amount is a
**queryable figure rather than a paragraph**, and the screen labels it
`unposted`.

### Also missing: the memo hold an acceptance should place

An accepted quote is an obligation of the customer's money that has not moved
yet — which is precisely the shape of a card authorisation hold. Acceptance
*should* place a `hold_kind = 'manual'` hold for `sell_cents` so the customer's
**available balance** reflects the commitment they made, and release it at
settlement. It does not, because `hold` is a money table owned by
`src/lib/holds/**`. The right home for it in the chart would be a sibling of
`9100`/`9200`:

```
9300  Holds — accepted FX commitments   (memo book, perBusiness: true)
```

Week two. Named rather than discovered.

---

## 7. What is not built, said plainly

**There is no off-ramp partner and the last mile does not exist.** The USDC leg
is real and confirms on Base Sepolia. The step *after* it — somebody in Mexico
handing the beneficiary pesos — needs a licensed partner this build does not
have. So the delivery amount on every quote is a **commitment**: priced
honestly, recorded honestly, and never described as money that moved. Nothing on
the screen claims a peso has ever been delivered.

**Nothing is hedged.** A production desk would cover an accepted commitment the
moment it is accepted. We carry it, which is why §6 exists and why the screen
shows the live position on an open commitment.

**Corridors are a closed list of five** (MXN, PHP, INR, BRL, JPY) rather than
"whatever the rate source returns". Listing thirty currencies would dress up the
gap in §7 as coverage. JPY is on the list specifically because its minor-unit
exponent is 0, which keeps the arithmetic general instead of letting `× 100`
hide everywhere.

**The "Send" button does not send.** It runs the gate against the real database
and reports the verdict, then prints the command that *will* send it. Signing
needs `USDC_SENDER_PRIVATE_KEY`, and the sanctioned path for that is
`scripts/payout-usdc.mjs` — an operator CLI that prints the transaction hash
**before** it broadcasts, so a crash between the two is recoverable. A button on
a public URL that signs with a wallet key on every click is a worse design, and
a three-minute wait for a receipt does not fit in a serverless function anyway.
The screen says all of this above the button.

---

## 8. Whose name goes on an acceptance

The system actor **`ledger-poster`**, not a human — the same choice
`src/app/(app)/pots/actions.ts` makes, for the same stated reason. The console's
role switcher is a demo affordance and **not an authorisation boundary**; this
deployment cannot authenticate a person, and writing a human name onto a
commitment we cannot prove that human made would put a lie in the audit trail of
exactly the record that exists to be trusted.

A real deployment binds `fx_quote_acceptance.accepted_by` to the authenticated
session. The column is already the right shape for it.

Note also what acceptance is **not** gated on: maker-checker. §16's threshold is
on the *money-out* path, and accepting a quote moves no money. The payout it
eventually authorises still goes through approvals like any other outbound
payment.

---

## 9. The screen

`/payouts`, five URL-driven states, every one reachable by editing the query
string and by nothing else:

| URL | Shows |
| --- | --- |
| `/payouts` | the live quote book and the live rate source |
| `/payouts?state=loading` | the real Suspense fallback, held open by a genuinely slow fixture |
| `/payouts?state=empty` | no quote raised — nothing to show, nothing wrong |
| `/payouts?state=error` | the quote book unreadable; nothing raised, nothing written, retry live |
| **`/payouts?state=edge`** | **an expired quote** |

`?quote=FXQ-XXXXXXXX` focuses one; `?business=<uuid>` filters the book.

**The edge state is the one to pause on.** A customer looked at a rate, thought
about it, and came back after the offer had lapsed. It is a perfectly ordinary
quote — the rate was live, the arithmetic is right, nothing about it is
malformed. The only thing wrong with it is the clock, and that is exactly the
case a quote screen has to handle well: the rate they saw is gone, the
acceptance is refused *by the database*, the expired quote stays on file, and
the remedy is one click.

The four non-default states are fixtures even when a database is configured, so
they can be shown in order in front of a panel without raising a quote or
writing a row. **Not one number in those fixtures is typed by hand** — each
states its terms (an amount, a rate literal, a corridor) and the figures come
out of `priceQuote()` and `quoteView()`, the same functions the live screen
uses. A fixture whose own arithmetic does not add up teaches a viewer the wrong
thing about the feature, and because it is a mock nobody re-checks it.

---

## 10. Verifying all of it

```bash
pnpm typecheck && pnpm lint --max-warnings=0 && pnpm test && pnpm build
node scripts/dbcheck.mjs        # ledger invariants, unaffected by this work
node scripts/audit-claims.mjs   # no document contradicts the health endpoint

# the database-backed proofs: SQL/TypeScript parity, the expiry trigger,
# acceptance-once, the generated commitment, and "no journal entry was written"
set -a; . ./.env; set +a
RUN_DB_TESTS=1 RUN_LIVE_TESTS=1 pnpm test src/lib/fx

# the rate source, by hand
curl -sS -w '\n%{http_code}\n' \
  'https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN,PHP,INR,BRL,JPY'
```

`RUN_LIVE_TESTS=1` adds one assertion worth calling out: it fetches the mid for
real and then re-derives the stored integer from the characters the source
printed, by hand, in the test — which is the whole no-floats claim, checked
against a live response rather than a fixture.

**That suite writes to the live database, and it used to leave what it wrote
there.** Since §12 it does not: every scenario runs inside a transaction that is
rolled back, the one scenario that cannot marks what it commits, and the last
suite in the file asserts the settlement count did not move across the run.
Running the command above is now free rather than cumulative.

---

## 11. The gate, wired — and where the residual landed

*Appended after the wiring. §5 and §6 above describe the design; this section
records what was built, with the real numbers from the run that proved it.*

### The one line, and where it actually sits

`scripts/payout-usdc.mjs` now refuses to sign without an accepted, unexpired,
unspent quote:

```js
const refusal = await requireAcceptedQuote({
  quoteRef: QUOTE, amountUnits: AMOUNT_UNITS, toAddress: RECIPIENT, businessId: business.id,
});
if (refusal !== null) { /* print code + message */ process.exit(1); }
```

It runs **before** `sendUsdcPayout()`, so a refusal happens before the wallet
key is used rather than after. `businessId` is resolved from `--business`
*before* the gate rather than taken off the quote, so the "whose money is this"
check compares two independently-sourced facts instead of asking whether the
quote's own customer equals itself.

A transfer that is genuinely not a conversion — a customer's own dollars to
their own wallet — says so with `--domestic`, which is the caller deciding, as
`gate.ts`'s header requires. The flag is printed in the output, because "we
skipped the price gate" is not something that should happen quietly.

### The amount is derived from the commitment, not typed

What leaves the wallet is `deliveryCostUnits()`: what buying the committed
`buy_minor` costs at the **settlement** mid, to the rail's own six decimals.
`--amount` on a quoted payout is a cross-check — supply it and it must equal
the derived figure or the payout is refused with that figure in the message.
An operator sizing a settlement by hand is not settling a commitment; it is a
transfer that cites one.

The one exception is `--settle`, where the transfer has already confirmed and
`--amount` states what the **chain** says left. That is a fact, not a size.

### The settlement entry, posted

`4300 FX quote settlement variance` now exists in `src/lib/ledger/chart.ts`
with the `why` §6 asked for, so the entry §6 specified posts — through
`postEntry()`, with one line §6 did not have:

```
DR  2100/<business>   sell_cents             the committed price
CR  4200              fee_cents              our disclosed fee
CR  1140              wallet cents           the whole cents the wallet parted with
CR  2900              1                      the sub-cent conversion residual
CR/DR 4300            variance_cents         the market move, and our spread
```

Line order is the **§12.5 template**, not reading order: the house's own
income line leads (4300 when there is a variance, 4200 otherwise) so that
§12.4's ordinal tiebreak assigns any residual penny to us. This entry has no
N-way allocation and therefore nothing for the tiebreak to decide — the same
observation `docs/ACCRUAL.md` makes about the daily fee entry — but the
ordering is the rule, not "the rule except where it does not currently matter".

### Which §12 clause governs the conversion residual, and why

**There are two residuals and only one of them is a ledger amount.**

**The delivery floor** — the fraction of a centavo lost when `buyMinorUnits()`
floors — is *not* a ledger amount and no §12 clause reaches it. The ledger is
USD in cents; the destination currency never enters the books. It is disclosed
instead, as `PricedQuote.deliveryResidualTenThousandths`, on the quote, before
acceptance, priced into what the customer agreed. On the run below it was
**8,977 / 10,000 of one centavo**.

**The sub-cent dust on the USDC leg** is the ledger amount, and **§12.6 is the
clause**:

* not **§12.2** (half-to-even on one value → one cent). Every rounding
  direction on this path is already chosen by *who bears the risk* — §4 above
  fixes all four and prints them on the screen — and half-to-even would round
  the customer's delivery **up** half the time, committing us to money we did
  not buy.
* not **§12.3** (largest remainder across N shares). Nothing is being split.
  One amount, one beneficiary, one wallet; a rule for apportioning a sum across
  lines has nothing to apportion.
* **§12.6**, which describes this exact situation in these exact words: *"USDC
  has six decimals, so a 1.234567 USDC receipt is 123.4567 cents … posts the
  rounded cents to the customer and the remainder to `2900 Rounding residual
  clearing` **as a real journal line**, so the entry still sums to zero and the
  dust is a balance we can see, age, and periodically sweep to `5900`/`4200`."*

So 1140 is credited the whole cents the wallet actually parted with, and the
remainder is carried to **2900** as one cent with the true fraction in the line
memo — the same convention `payoutAllocation()` already applies to an unquoted
USDC transfer one directory over.

**The dust is never folded into 4300.** 4300's own `why` in the chart says it
is a real P&L position "and not a rounding artefact", and a rounding artefact
hidden inside a market-move account is precisely the residual nobody owns.
Fold it in and "what did our rate commitments cost us this month" becomes a
number contaminated by four decimal places of USDC.

### The run

```
node scripts/payout-usdc.mjs --quote-new --currency MXN --usd 3.00
node scripts/payout-usdc.mjs --quote-accept FXQ-XYRJF6AJ
node scripts/payout-usdc.mjs --quote FXQ-XYRJF6AJ
```

| | |
| --- | --- |
| mid, live from frankfurter.dev for 2026-09-10 | 16.9435 MXN/USD |
| customer rate, mid less 50bp | 16.8587825 |
| sells / fee / net | $3.00 / $1.01 / $1.99 |
| delivers | 33.54 MXN (floor residual 8,977/10,000 of a centavo) |
| costs at the settlement mid | **1.979521 USDC** |
| tx | `0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e` |
| block | 46666112, status `0x1`, 2026-09-11T04:21:52Z |
| entry | `027255d5-ee38-4eed-ac50-9771ba8d589a`, value date 2026-09-11, booking_seq 2270 |

```
CR 4300                        1 USD   FX quote settlement variance
CR 4200                      101 USD   Fee income
DR 2100/e274546d…            300 USD   Ridgeline Robotics, Inc. — business current account
CR 1140                      197 USD   USDC omnibus wallet — Base Sepolia
CR 2900                        1 USD   Rounding residual clearing
   balance                     0
```

197.9521 cents of USDC left the wallet. 197 went to 1140, **9,521 / 10,000 of a
cent went to 2900**, `settlement_cost_cents` is 198, and the variance — our
spread, since the mid had not moved between quote and settlement — is 1 cent to
4300. The entry balances to the cent with nothing unowned.

### Both clocks read correctly

`value_date` is the **block's** day in book time; the booking axis is
`ledger_append`'s. The accepted rate and the acceptance instant ride on the
entry's description and on the customer's own line memo, and
`fx_quote_settlement.entry_id` joins the two books:

> Cross-border payout FXQ-XYRJF6AJ — 33.54 MXN to Off-ramp partner — testnet
> demo **at an accepted rate of 16.8587825 MXN/USD (mid 16.9435 less 50bp),
> accepted 2026-09-11T04:21:42.728Z**, settled against a mid of 16.9435 —
> base.usdc block 46666112, gas 269058000000 wei

So a quote accepted Tuesday and settled Thursday reads correctly from either
end: Wednesday's statement shows nothing, because nothing had moved; Thursday's
shows the movement **and** the Tuesday price, without a join.

### The refusals, each with a real row behind it

| Attempt | Code | Nothing signed? |
| --- | --- | --- |
| `--quote` omitted | `FX_QUOTE_REQUIRED` | yes |
| `FXQ-XYRJF6AJ` while still an open offer | `FX_QUOTE_NOT_ACCEPTED` | yes |
| accepting `FXQ-RCNKNJNY`, already expired | `FX_QUOTE_EXPIRED` (from the trigger) | nothing written |
| `FXQ-G21TBSD0`, **accepted** at 04:24:34 with a 60s window, attempted 04:26:24 | `FX_QUOTE_COMMITMENT_LAPSED` | yes |
| `FXQ-XYRJF6AJ` a second time | `FX_QUOTE_ALREADY_SETTLED` | yes |

The fourth is the one worth pausing on, and it is the reason the schema's
minimum `settlement_window_seconds` is 60 rather than 0: **a quote that was
accepted is still refused once its window closes.** The window is the product.
It was proved by accepting a real quote, waiting out a real minute and
attempting a real payout — not by asserting it.

### One thing the live run found, and the fix

The first attempt at the lapse demo was run too early, cleared the gate, and
broadcast 1.482518 USDC. Base Sepolia returned a receipt whose `blockHash` was
zero at the tip; the adapter's canonicality re-check compared that against the
chain's real hash, called it `reorged` and — correctly — posted nothing. By the
time the transaction was confirmed by hand, the 60-second window had closed.

The recovery run (`--settle`) then hit **the gate**, which refused it. That was
wrong, and it is a control manufacturing a reconciliation break: 1.48 USDC had
already left, and refusing to post it only made the ledger disagree with the
chain.

**The gate now does not run on `--settle`.** It exists to stop value leaving;
on a recovery the value has already left. What still runs is the database's own
check at the point the commitment is *consumed* — `fx_quote_settlement`'s
trigger refused the lapsed quote, so the entry is posted and the quote is not
marked settled:

```
entry 4e69213f-aa6d-4d58-b79a-ed061f7976ca   tx 0x1984a32d…ce7fe   block 46666139
CR 4200  101 · DR 2100/e274546d… 250 · CR 1140 148 · CR 2900 1   balance 0
commitment consumed:  REFUSED  FX_QUOTE_COMMITMENT_LAPSED
```

That is the right shape: **the ledger tells the truth about the money and the
quote book tells the truth about the commitment**, and the disagreement between
them is a visible break rather than a lie in either.

### Is the gate in the right place? Mostly — but the binding is in the wrong table

The gate at the send is right *as a last line*. It is the point where value
actually leaves, it fails closed, and it costs a database round trip that the
rail adapter deliberately cannot afford.

**It should not be the only place, and today it is.** Two consequences:

1. **The approver never sees the price.** `payment_instruction.content_hash` is
   sha256 over *(account, rail, amount, counterparty, value_date)* and an
   approval must cite that hash, which is exactly the right mechanism — and the
   quote is not in it. So on a cross-border payout above threshold, the second
   human approves an amount and a beneficiary but **not the rate**, which is
   the one term of a cross-border payment a checker is uniquely placed to
   question. The fix is small and it is in the money-out path, not here: an
   `fx_quote_id` column on `payment_instruction`, folded into `content_hash`,
   so that changing the quote invalidates the approval the same way changing
   the amount does.

2. **An accepted quote moves no available balance.** §6 already names this —
   acceptance should place a memo hold (`9300`) for `sell_cents` so the
   customer's available balance reflects the commitment they made. Until it
   does, a customer can accept five quotes against one balance and the gate
   will clear all five.

So: keep this gate exactly where it is, and **add the binding one level up**.
Acceptance should attach to the payment request, the request should carry the
quote into the approval, and the send script's gate should degrade from *the*
control to defence in depth. That is a schema change in a directory this work
does not own, which is why it is written down rather than done.

---

## 12. Seven of the eight settlements are test artefacts, and they are labelled

*Appended after an audit of what the integration suite had written to the live
database. §11 above describes the one real payout; this section is about the
seven rows sitting next to it and what was done about them.*

### The finding

`fx.integration.test.ts` runs against the **production** Neon database when
`RUN_DB_TESTS=1`, and every row it wrote **committed**. Eleven runs on
2026-09-11 left 63 quotes, 63 rate observations and — the ones that matter —
**seven rows in `fx_quote_settlement`**.

There have been **eight settlements in this system's entire history and exactly
one of them is real**:

| | settlements | tx hash | journal entry |
| --- | --- | --- | --- |
| real | **1** | `0x0acfad50…77d79e`, Base Sepolia block 46666112 | `027255d5-…` |
| fixtures | **7** | `0x` + `a`×64 — a literal typed into a test file | none |

The seven carry no `entry_id`, no destination address and no rate observation
behind their settlement mid. They all claim `settlement_cost_cents = 101817`
and `variance_cents = -2167`, because they are eleven copies of one scenario.

**Nobody meant to claim eight cross-border payouts confirmed on chain.** That
is what makes this worth a section rather than a commit message. A reader runs
`SELECT count(*) FROM fx_quote_settlement`, gets 8, picks a hash, finds it
confirms on Basescan, and has been handed the shape of a false claim by a
system whose entire thesis is that its records can be trusted. No dishonesty is
required anywhere in that chain — only a test that writes to the book people
read.

### They are not deleted, and there are three independent reasons

**They cannot be.** §7 of `0017` grants `corgi_app` SELECT and INSERT on
`fx_quote_settlement` and revokes UPDATE, DELETE and TRUNCATE, then adds
`ledger_row_is_immutable()` triggers because *privileges do not bind the table
owner*. A DELETE here is refused at two layers, and the second layer exists
precisely so that a migration — a file exactly like `0041` — cannot sail past
the first. A migration that dropped the trigger, deleted the rows and put it
back would be the single most dishonest artefact in this repository: it would
defeat a control by using the privilege the control was written to deny.

**They should not be.** The trial's automatic fail is *"UPDATE or DELETE on
money rows. Anywhere. Ever."* `fx_quote_settlement` is guarded with the same
function, the same GRANT shape and the same trigger pair as `journal_entry`; it
carries `settlement_cost_cents`, a signed `variance_cents` that is a real P&L
position on account `4300`, and a foreign key into `journal_entry`. If it is
not a money row it is indistinguishable from one, and *"I judged this table to
be only mostly append-only"* is not an argument anybody should have to accept.

**And the one I would give first if asked:** *"seven bogus settlements were
written to production by a test suite on 2026-09-11"* is a **true and useful
fact about this system**. Deleting the evidence of a bug is not cleaning up
after it. The honest correction to a wrong row in an append-only book is
another row — which is the rule this whole build runs on, applied to itself.

### What was built instead — `db/migrations/0041_fixture_marking.sql`

**A marker table, not a column.** A column is the obvious first idea and it is
unimplementable: `ADD COLUMN` would work and then the backfill is an `UPDATE`,
refused by the privilege *and* by the trigger. A column that can never be
written on an existing row is a column that is always false. So a new fact gets
a new row, which is the shape `fx_quote_acceptance`, `hold_closure` and
`payee_archival` already use.

```sql
CREATE TABLE fx_quote_fixture (
  quote_id  uuid PRIMARY KEY REFERENCES fx_quote(id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid NOT NULL REFERENCES actor(id),
  source    text NOT NULL,   -- a file path, so a reader can open it
  reason    text NOT NULL    -- why it is not a customer commitment
);
```

It keys on **`fx_quote`**, not on the settlement, because the quote is the root
of the lineage: mark the quote and its observation, its acceptance and its
settlement are all accounted for by one row. A suite that raises a quote and
never settles it is covered by the same mechanism.

**The backfill is checked against a second, independent criterion.** The
selector is the suite's own signature — `RUN_ID = 'it-' + Date.now()
.toString(36)`, appended to every `beneficiary_ref` it writes. A regex backfill
is a guess unless it is checked, so `0041` refuses to apply unless that
criterion selects **exactly** the settlements a completely different test does:
a `tx_hash` of 64 repetitions of one hex digit, which no keccak-256 digest has
ever been. On the live database the two agree on 7 of 8, and the eighth is the
Base Sepolia payout. Either direction of disagreement raises and the migration
aborts.

**A view, and it filters nothing.**

```sql
CREATE VIEW v_fx_quote_marked AS
SELECT v.*, (f.quote_id IS NOT NULL) AS is_fixture, f.source, f.reason
  FROM v_fx_quote v LEFT JOIN fx_quote_fixture f ON f.quote_id = v.quote_id;
```

The tempting fix is `WHERE tx_hash <> '0x' || repeat('a', 64)` in the payouts
query, and it is the **worst available answer**. A filter that hides fixtures
is one widened predicate away from hiding a real failure, and it hides it from
the screen whose entire job is to be the record. `LEFT JOIN`, never `WHERE`.
The count on `/payouts` does not move; the label does the work.

`v_fx_quote_settlement` is the settlement book with the same treatment, plus
one column worth calling out: **`has_entry` is derived from the foreign key
into `journal_entry`, not from `entry_id IS NOT NULL`.** A settlement's claim
to have posted is only worth what the journal says.

**And a constraint, so the schema refuses the next one.**

```sql
ALTER TABLE fx_quote_settlement
  ADD CONSTRAINT fx_quote_settlement_tx_hash_not_placeholder
  CHECK (tx_hash !~ '^0x([0-9a-f])\1{63}$') NOT VALID;
```

`NOT VALID` is not a weakening — **every INSERT from now on is checked**; it
only skips the scan of existing rows, which is the point, because those seven
rows fail it and an append-only table cannot be repaired. `pg_constraint
.convalidated = false` then becomes a permanent, queryable statement that this
table contains rows predating the rule, recorded in the catalogue where it
cannot drift from a paragraph in a document.

### What `/payouts` shows now

The fixtures are **on the screen**, in the book, in state order, with the label
built in `src/lib/fx/view.ts` — the same place every other figure is formatted,
under the data contract's own rule that *the server formats and the browser
renders characters*:

```
FXQ-YYZA37KX  settled   FIXTURE — Settled it-mtwkhksl
        tx  0xaaaa…aaaa  FIXTURE — no such transaction exists on any chain

FXQ-XYRJF6AJ  settled   Off-ramp partner — testnet demo
        tx  0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e
```

The label goes **on the hash**, not near it. The hash is the single most
load-bearing string on that screen — it is what a reader copies into Basescan —
and a reference that resolves nowhere, printed by this system under the heading
*Settlement*, is exactly the shape of a claim nobody made but everybody heard.

The word is `FIXTURE` rather than `TEST` deliberately: every integration in
this build runs in a provider's **test** mode, and a test-mode card authorising
a real sandbox transaction produces an entirely real row. These are not records
of anything that happened.

A dedicated `isFixture` field on `QuoteView` and a badge beside
`RateEvidenceBadge` — which is what `evidence` already gets — is the better
version and is week two. What was not acceptable in the meantime was a truthful
database and a screen that did not say so.

### The test does not do it any more

Every scenario in `fx.integration.test.ts` now runs inside a transaction that
is **rolled back** — the shape `src/lib/team/team.integration.test.ts` §9
introduced after the same class of bug left orphan holds in the memo book. The
rows exist, the triggers fire, the generated columns are computed by the server
and every assertion is made against real Postgres; then it is thrown away.

Two things about that are worth writing down.

**`store.ts` calls `conn.begin()`, and a postgres.js transaction handle does
not have one.** `begin` is assigned to the pool object only; a transaction
scope gets `savepoint` instead. So the suite installs `begin` as a savepoint on
the handle it passes down — otherwise the only way to run these scenarios in a
transaction would be to stop calling the production functions and hand-write
their INSERTs in the test, which would mean the suite no longer tests the code
that runs.

**One scenario genuinely cannot roll back, and it is the expiry control.**
`now()` is `transaction_timestamp()` — fixed at the first statement and never
advancing — which `0017` §4 relies on and states: *"two statements in one
transaction must agree on whether the offer was still open."* So `expires_at`,
`accepted_at` and `v_fx_quote.state` all read the same instant inside one
transaction, `accepted_at` can never exceed `expires_at`, and a quote can never
be observed expired by any statement that raised it. **A quote that expires is
a thing that happens between transactions.**

There is a version that stays inside one — pass an explicit `accepted_at` two
seconds ahead and the trigger's first branch fires — and it proves the
comparison without proving the feature: not `state = 'expired'`, not the
application's translation to `FX_QUOTE_EXPIRED`, and not *"the expired quote is
still on file afterwards"*, which is §5 of this document in one assertion.

So that test commits **one** quote per run and pays for it: it writes its own
`fx_quote_fixture` row **in the same transaction**, so there is no instant in
which an unlabelled fixture is visible to anybody, and no follow-up step that
could be forgotten. It cannot delete instead, and that is the design rather
than an obstacle.

Per run, before and after:

| | quotes | observations | acceptances | **settlements** |
| --- | --- | --- | --- | --- |
| before | +9 | +9 | +4 | **+1** |
| after | +1, marked | +1 | 0 | **0** |

### The regression test

The last suite in the file is the one that catches a recurrence:

* the settlement count did not move across the run — with the delta in the
  failure message;
* every settlement carrying an impossible hash **is** marked, with a source and
  a reason;
* every settlement **not** marked has a plausible hash **and** a journal entry
  that actually exists;
* the Base Sepolia payout is on file, unmarked, with `settlement_cost_cents =
  198` and `variance_cents = 1` — so if this document, `docs/STABLECOIN.md` and
  the database ever disagree about it, the test says which.

### Verifying this section

```bash
set -a; . ./.env; set +a
RUN_DB_TESTS=1 pnpm test src/lib/fx

psql "$APP_DATABASE_URL" -c \
  "SELECT quote_ref, is_fixture, has_entry, tx_hash FROM v_fx_quote_settlement ORDER BY settled_at"
psql "$APP_DATABASE_URL" -c \
  "SELECT count(*) FILTER (WHERE is_fixture) AS fixtures,
          count(*) FILTER (WHERE NOT is_fixture) AS real
     FROM v_fx_quote_settlement"        -- 7 and 1
```

---

## 13. Re-verified live on 2026-09-11, and the three things it found

*This section is a record of an end-to-end verification run against the live
Neon book and Base Sepolia, done from scratch rather than by reading §11. §11
stands; nothing in it was contradicted. What follows is a second real payout,
its real ids, and the three defects the run turned up.*

### The rate source, measured twice — and it moved between them

```
13:57:46Z  HTTP/2 200  0.46 s
{"amount":1.0,"base":"USD","date":"2026-09-10",
 "rates":{"BRL":5.1247,"INR":95.44,"JPY":154.18,"MXN":16.9435,"PHP":62.576}}

14:00:21Z  {"amount":1.0,"base":"USD","date":"2026-09-11","rates":{"MXN":16.9771}}
```

**The ECB published the 2026-09-11 fix in the middle of this run.** That is
worth more than any assertion in the suite: the same URL, three minutes apart,
returned a different date and a different rate, so the source is answering
rather than serving a cache of a figure someone typed. It also means the payout
below is not a rate-move rehearsal — **the market genuinely moved between the
quote and the settlement**, and the customer got the rate they accepted anyway.

One thing the headers say that this document did not:

```
deprecation: @1779103800
link: <https://api.frankfurter.dev/v2/rates>; rel="successor-version"
```

`/v1` is announcing its own succession. It answers 200 today. `frankfurterUrl()`
in `rate.ts` is the one place the URL is built, which is exactly the property
that makes moving to `/v2` a one-line change — but it is a change somebody has
to make, and it is named here rather than discovered when a 410 arrives.

### The payout, end to end

| | |
| --- | --- |
| quote | `FXQ-3BHA0ZKW` |
| mid, live for 2026-09-10 | 16.9435 MXN/USD, HTTP 200 |
| customer rate, mid less 50bp | 16.8587825 |
| sells / fee / net | $3.00 / $1.01 / $1.99 |
| delivers | 33.54 MXN (floor residual 8,977 / 10,000 of a centavo) |
| accepted | 2026-09-11T13:59:30.987Z, 283s to spare, by `ledger-poster` |
| **mid at settlement** | **16.9771** — the ECB's 2026-09-11 fix, published mid-run |
| costs | 1.979521 USDC |
| tx | `0x92b308ab099f1cab79e9f54e9c58940ddc2e98e1b7bc8a1389261aac082fd58d` |
| block | 46683447, `0x4b915ea989f036f16e4653fc0e54fd3319c7abae329bc57ff86d3e36250c25a8`, status `0x1`, 2026-09-11T13:59:42Z |
| entry | `8bd5066d-e710-418c-837d-e5e75f90773c`, value date 2026-09-11, booking_seq 5568 |

Read back off a node, not off our own output — `eth_getTransactionReceipt`
returns one `Transfer` log, `0x…1e3481` = **1,979,521 minor units** to
`0x…dEaD`, and `eth_getBlockByNumber(0x2c85537)` returns the same block hash the
receipt claims, so the block is canonical.

```
CR 4300                        1 USD   FX quote settlement variance
CR 4200                      101 USD   Fee income
DR 2100/e274546d…            300 USD   Ridgeline Robotics, Inc. — business current account
CR 1140                      197 USD   USDC omnibus wallet — Base Sepolia
CR 2900                        1 USD   Rounding residual clearing
   balance                     0
```

197.9521 cents left the wallet: **197 to 1140, 9,521 / 10,000 of a cent to
2900** under **§12.6**, `settlement_cost_cents` 198, variance +1 cent to 4300.
The 2900 line's own memo carries the clause and the fraction:

> sub-cent conversion residual on FXQ-3BHA0ZKW · tx 0x92b308ab… : 9521 of 10000
> USDC units of a cent, carried here rather than truncated or netted into 4300
> (DESIGN §12.6)

and the entry description carries both clocks and both rates:

> Cross-border payout FXQ-3BHA0ZKW — 33.54 MXN to Off-ramp partner — testnet
> demo **at an accepted rate of 16.8587825 MXN/USD (mid 16.9435 less 50bp),
> accepted 2026-09-11T13:59:30.987Z, settled against a mid of 16.9771** (trial
> demo payout) — base.usdc block 46683447, gas 269058000000 wei

### The refusals, each against a row raised for it

| Attempt | Code | Exit | Signed? |
| --- | --- | --- | --- |
| `--quote` omitted | `FX_QUOTE_REQUIRED` | 1 | nothing — the gate runs before the chain is even read |
| `FXQ-3BHA0ZKW` while still an open offer | `FX_QUOTE_NOT_ACCEPTED` | 1 | nothing |
| `FXQ-KZ7FR1CM`, a 5-second offer, **accepting** it after it lapsed | `FX_QUOTE_EXPIRED` (trigger, SQLSTATE 55006) | 1 | nothing written |
| `FXQ-KZ7FR1CM`, **sending** against that never-accepted offer | `FX_QUOTE_NOT_ACCEPTED` | 1 | nothing |
| `FXQ-QGXRRK3D`, accepted 13:58:56.829Z on a 60s window, attempted 14:00:55Z | `FX_QUOTE_COMMITMENT_LAPSED` | 1 | nothing |
| `FXQ-3BHA0ZKW` a second time | `FX_QUOTE_ALREADY_SETTLED` | 1 | nothing |

In every refusal the script exits before the `chain, before` section prints,
which is the observable form of "the wallet key was never used".

### Finding 1 — the reorg false negative is not a one-off, and it cost a run

**The happy path did not complete in one command.** `--quote FXQ-3BHA0ZKW`
cleared the gate, signed, broadcast, and then reported:

```
kind    REORGED
detail  receipt claims block 46683447 0x0000…0000, chain now has no such block
```

Base Sepolia answered `eth_getTransactionReceipt` at the tip with a `blockHash`
of sixty-four zeroes — **a preconfirmation, not a reorg** — and the adapter's
canonicality re-check compared that placeholder against the block's real hash,
found them different, and correctly refused to post. Forty seconds later the
same node returned the same receipt with `blockHash`
`0x4b915ea9…250c25a8`, and `eth_getBlockByNumber` confirmed that block is
canonical. §11 records this happening once and treats it as an accident of one
run. It is not: **it is the ordinary outcome of reading a receipt at the tip of
a chain with preconfirmations**, and on this corridor it is closer to the rule
than the exception.

Refusing to post was right and is not being changed — a script does not get to
overrule the canonicality check. What was wrong is where it left the operator:
1.979521 USDC had left the wallet, the ledger did not know, and the output said
only *"Nothing posted."* with no handle on the break it had just created. The
`unconfirmed` branch prints a `--settle` recovery command; the `reorged` branch
printed none, which is the branch that most needs one.

`scripts/payout-usdc.mjs` now prints, on `reorged`, the `curl` that reads the
receipt back and the exact recovery line, with the amount filled in. The
posting still requires a human to look at the chain first. **This is the one
place this feature is not a single command**, and the honest statement of it is:
the gate, the pricing, the send and the posting all work; the *receipt reader*
is racing a preconfirmation, and the fix belongs in
`src/lib/rails/stablecoin/adapter.ts` — treat a zero `blockHash` as "not yet
final, keep waiting" rather than as a reorg — which is a directory this work
does not own.

The recovery itself worked exactly as designed:

```
node scripts/payout-usdc.mjs --quote FXQ-3BHA0ZKW \
  --settle 0x92b308ab… --amount 1.979521
  gate   NOT RUN — --settle
```

and because the settlement window was the default 86,400 seconds rather than
the 60 that bit §11, `fx_quote_settlement`'s trigger accepted the row, the
quote is `settled`, and there is no break to explain.

### Finding 2 — the screen was still saying the variance is unposted

On the deployed console, the settled quote's Settlement panel read:

> The variance above is recorded and **not posted**. There is no account in the
> chart for an FX settlement variance … `unposted`

and the commitment panel read *"It does not post to the journal today, because
the chart has no account for it."* Both were written before §11 and **both were
false the moment `4300` was added** — the ledger above shows the variance
posted, and `fx_quote_settlement.entry_id` has pointed at a journal entry since
the first real payout.

This is the §12 error with the sign reversed. §12 was a database telling the
truth in front of a screen that did not say so; this is a ledger doing the right
thing in front of a screen asserting it did not. Both hand a reader a claim
nobody made.

Fixed by **deriving the paragraph instead of asserting it**:
`fx_quote_settlement.entry_id` is already on `v_fx_quote`, so it is carried
through `QuoteFacts.entryId` to `QuoteView.settlementEntryId`, and
`QuoteDetail` prints either the posted entry id with the account it landed in,
or — when there genuinely is no entry — that this settlement has none, which is
expected on a screen fixture and a break on a live row. There is no longer a
sentence about the journal that a change to the journal can falsify.

### Finding 3 — the error state was the one screen that did not disclose the off-ramp

`PayoutsView` carries a comment saying the two limitations are shown *"at the
top, on every state"*. The error branch returned before the note that carries
them, so `/payouts?state=error` rendered a page headed **Cross-border payouts**
with nothing anywhere on it saying the last mile does not exist. The other four
states — default, loading, empty, edge — all carried it, and still do.

The paragraph is now one component rendered in both branches. An unreadable
quote book is not a reason to stop disclosing what the product is.

### What is still true, and unfixed

**The quote is still not in `payment_instruction.content_hash`.**
`src/lib/approvals/hash.ts` hashes `corgi.payment.v1` over *(account, rail,
amount, currency, destination, value date)* and nothing else. So on a
cross-border payout above threshold the second human still approves an amount
and a beneficiary but **not the rate**. §11.1 is unchanged and its fix —
an `fx_quote_id` column on `payment_instruction`, folded into the preimage and
the version tag bumped to `corgi.payment.v2` — is still a change in
`src/lib/approvals/**`, which this work does not own.

**There is still no off-ramp**, and no hedge, and acceptance still places no
memo hold. §6, §7 and §11.2 are unchanged.

### The book, after this run

Nine settlements: **seven fixtures, two real.** Both real ones carry a hash that
resolves on Base Sepolia and a journal entry that exists; all seven fixtures are
marked in `fx_quote_fixture` and labelled on the hash on `/payouts`. §12's
regression test — *"every settlement not marked has a plausible hash and an
entry that actually exists"* — passes on nine rows rather than eight.

```
$ RUN_DB_TESTS=1 RUN_LIVE_TESTS=1 pnpm test src/lib/fx
  Test Files  5 passed (5)       Tests  99 passed (99)
$ node scripts/dbcheck.mjs              38 passed, 4 failed   (the four are deliberate)
$ node scripts/dbcheck.mjs --prove      26 of 26 invariant views, 33 proofs
$ pnpm typecheck && pnpm lint --max-warnings=0 && pnpm test && pnpm build
  Tests  2547 passed | 431 skipped
```

**The three fixes above are in the tree and are not on the deployed URL.** The
deployment is commit `0fa057d`; everything in §13 that describes the *database*,
the *chain* and the *CLI* was observed against the live system, and the two
screen fixes are source changes awaiting a deploy this work did not make.
