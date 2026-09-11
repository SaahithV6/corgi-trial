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
| Journal entries written | **zero.** A quote is not a transaction; §6 |
| Refusal code for an unquoted payout | `FX_QUOTE_NOT_ACCEPTED` |

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
