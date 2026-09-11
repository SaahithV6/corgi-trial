# Payee confirmation — catching the mistyped account before the money leaves

Stretch-ladder item six, verbatim:

> A payee confirmation step that catches the mistyped account before the money
> leaves.

In the UK that feature is **Confirmation of Payee** and it is a network: you
send a sort code, an account number and a name, and the beneficiary's own bank
answers *match* / *close match* / *no match* from its own records. The trial
says **Build American**, so this is the US construction of the same idea — and
the first thing that has to be said about it is what the US does not have.

**There is no Confirmation of Payee for US ACH.** Nacha has no name-inquiry
message. The closest thing the rails offer is a zero-dollar *prenotification*,
which the receiving bank may answer days later with a C01/C02/C03 correction
and is not obliged to answer at all. Nothing in this repository's credential
set — Increase, Plaid, Lithic, Circle — can ask a US bank what name sits on an
arbitrary third party's account. That is measured, not assumed; §3 lists the
calls that were made and what came back.

So this feature has three legs of very different strength, and the whole design
is about not letting the weak ones borrow credibility from the strong one.

**Both rails that carry an ABA get all four legs.** ACH and WIRE are addressed
by a 9-digit routing number, and they are addressed by *different* ones — the
same bank's wire ABA is not its ACH ABA. Until 2026-09-11 the gate looked only
at ACH and a wire got none of this; §5a is the whole story, and it is the one
section in this document about a bug rather than a design.

| Leg | What it proves | How strong | Blocks? |
| --- | --- | --- | --- |
| **1. The ABA check digit** | This routing number is arithmetically possible | Proof. No provider, no network, no counterparty | **Yes** |
| **2. The routing directory** | A real institution holds this routing number, and takes this rail | Live provider call (Increase) | No — warns |
| **3. The name** | The name you typed is the name on the account | Algorithm is real; the counterparty's name is **not obtainable** for US ACH | No — warns |
| **4. The payee book** | You already pay this name at a different account | Local, and the only account-number check we have | No — warns |

---

## 1. The ABA routing number check digit

A US routing number is nine digits with a weighted mod-10 checksum:

```
3·(d1+d4+d7) + 7·(d2+d5+d8) + 1·(d3+d6+d9)  ≡  0  (mod 10)
```

The ninth digit is *chosen* to make that sum land on zero. A number that misses
is not "probably wrong" or "unknown to us" — it is impossible. No bank has ever
been issued one and none ever will be.

Worked, on a routing number this system already carries:

```
011401533     3·(0+4+5) = 27
              7·(1+0+3) = 28
              1·(1+1+3) =  5
                          --
                          60   ≡ 0 (mod 10)   ✓
```

Implemented twice, on purpose:

* `src/lib/payees/aba.ts` — so a form can say *why* before it round-trips.
* `aba_checksum_ok()` in `db/migrations/0016_payees.sql` — so the block is a
  **CHECK constraint**, not a service that can be bypassed, skipped or down.

Two copies of one rule is normally exactly what `DECISIONS` forbids. They are
held equal by a test rather than by hope: `payees.integration.test.ts` runs a
305-number corpus through both and asserts they agree digit for digit.

> The SQL version uses `CASE`, not `AND`. **Postgres does not guarantee
> short-circuit evaluation of `AND`**, so `rn ~ '^[0-9]{9}$' AND
> substr(rn,1,1)::int + …` is free to evaluate the cast first, and
> `'ABCDEFGHI'::int` raises 22P02 inside a CHECK constraint where the caller
> expected a clean refusal. `CASE` is the documented construct that does
> guarantee untaken branches are not evaluated.

### What it catches, and what it does not

Proved exhaustively in `aba.test.ts` over a deterministic 500-number corpus —
these are counted results, not claims.

#### Single wrong digit — **100% caught**

All 500 × 9 × 9 = **40,500 single-digit substitutions, zero missed.**

All three weights (1, 3, 7) are coprime to 10, so `w·δ ≡ 0 (mod 10)` forces
`δ ≡ 0`. A changed digit always moves the sum. There is no exception, ever.

A corollary worth knowing, because it decides a UI choice: since every weight
is invertible mod 10, **every invalid routing number has exactly nine
single-digit repairs — one per position, always.** "Did you mean one of these
nine?" is not a hint, it is a restatement of "it is wrong" in nine parts. The
product shows none of them.

#### Adjacent transposition — **89.03% caught** (3,656 cases, 401 missed)

The classic mistype. Swapping positions *i* and *i+1* shifts the sum by
`(w_i − w_{i+1})·(d_{i+1} − d_i)`. The adjacent weight differences cycle
−4, +6, −2; each has gcd 2 with 10, so the swap is invisible **exactly when the
two digits differ by 5**.

The miss set is therefore precisely, and only:

```
0↔5   1↔6   2↔7   3↔8   4↔9
```

Ten of the ninety ordered pairs of distinct digits — 11.1% — at every position
equally. **Everything else transposed is caught.** Measured miss rate over the
corpus: 10.97%.

Worked examples, on real routing numbers:

| From | To | Swap | Result |
| --- | --- | --- | --- |
| `011401533` | `011041533` | 4↔0, differ by 4 | **caught** |
| `021000021` | `012000021` | 2↔1, differ by 1 | **caught** |
| `021000021` | `021000012` | 2↔1, differ by 1 | **caught** |
| `101050001` | `100150001` | 1↔0, differ by 1 | **caught** |
| `026009593` | `206009593` | 0↔2, differ by 2 | **caught** |
| `101050001` | `101500001` | 0↔5, **differ by 5** | **MISSED** |

That last row is the honest limit and it is not academic: `101500001` passes the
check digit, the form accepts it, the rail submits it, and only the receiving
bank rejects it — days later, as an R03 or R04 return.

#### Transposition three or six positions apart — **0% caught**

The weight vector repeats every three digits, so positions 1&4, 2&5, 3&6, 4&7,
5&8, 6&9, 1&7, 2&8 and 3&9 carry **equal weights**. Swapping them cannot change
the sum by anything at all. Measured over the corpus: **4,019 cases, 4,019
missed — 100%.**

This is a property of every mod-10 checksum over a repeating weight vector. It
is not a defect in this implementation and no correct implementation of the ABA
rule does better.

#### Twin shift across a 3+7 weight pair — **0% caught**

Positions (1,2), (4,5) and (7,8) carry weights 3 and 7, which sum to 10.
Mistyping *both* by the same amount shifts the sum by `10δ`, invisible for every
δ. `011401533 → 121401533` (both of the first two digits +1) is undetectable.

### One more structural signal, deliberately *not* a block

The first two digits are a Federal Reserve **allocation**: 00 US Government,
01–12 the districts, 21–32 thrifts (district + 20), 61–72 electronic
(district + 60), 80 traveler's cheques. 13–20, 33–60, 73–79 and 81–99 have
never been allocated.

`aba_prefix_assigned()` checks it and it **warns**. A prefix outside those
ranges is unissued under a scheme a registrar maintains and could extend — a
fact about a registry, not about arithmetic. That distinction is the same one
the whole feature is built on, so it is applied to itself.

---

## 2. What routing-number lookup is genuinely available

### Increase — `GET /routing_numbers` — **LIVE, and it works**

Measured with the key in `INCREASE_API_KEY`. This is the first module in the
repo to reach Increase with a live key at all; the ACH transfer adapter next
door still carries a `[DOCS]`-only honesty banner, because a transfer is a
write and this is a GET that moves no money.

```
GET https://sandbox.increase.com/routing_numbers?routing_number=101050001
Authorization: Bearer <INCREASE_API_KEY>

200
{"type":"routing_number",
 "name":"First Bank of the United States",
 "routing_number":"101050001",
 "ach_transfers":"supported",
 "fednow_transfers":"not_supported",
 "real_time_payments_transfers":"supported",
 "real_time_payments_request_for_payment":"supported",
 "wire_transfers":"supported"}
```

Round trip measured at **0.15s**. Full results of the probe:

| Routing number | What it is | Response |
| --- | --- | --- |
| `101050001` | Increase's sandbox bank | `200`, one row, *First Bank of the United States* |
| `011401533` | **real** — Plaid sandbox's ACH routing | `200`, `data: []` |
| `021000021` | **real** — JPMorgan Chase wire | `200`, `data: []` |
| `026009593` | **real** — Bank of America NY | `200`, `data: []` |
| `121000248` | **real** — Wells Fargo | `200`, `data: []` |
| `000000000` | not a routing number | `200`, `data: []` |
| `101050002` | **fails the check digit** | `200`, `data: []` |
| `12345678` | eight digits | `400` `invalid_parameters_error` — "Minimum length is 9." |
| `abcdefghi` | not numeric | `400` `invalid_parameters_error` — "only numbers." |

Two conclusions, and both are load-bearing:

**(a) In sandbox, a miss means nothing.** The sandbox directory holds sandbox
banks; every genuine routing number in the seed data misses it. So
`DirectoryStatus` has `not_listed` **and** `unavailable` as distinct values, and
in a sandbox environment a `not_listed` produces a *note*, not a warning.
Turning "the test directory is small" into "we could not verify your payee"
would put a red flag on every payment in the demo, and a warning that fires on
everything is a warning nobody reads. **In production the same miss is a real
warning.** `environment` is derived from the base URL and cannot be configured,
so nothing pointed at production can claim to be sandbox and have its misses
silently downgraded.

**(b) Increase does not validate the checksum.** `101050002` (check digit fails)
and `000000000` (not a routing number) come back exactly as `011401533` (real,
valid, unknown to sandbox) does. Increase validates *shape*, not *arithmetic*.
Our check digit is not redundant with this call — it is the only thing either of
us does that catches a typo.

Adapter: `src/lib/payees/directory.ts`. Tests: `directory.test.ts` (scripted
bodies are verbatim copies of live responses; `RUN_LIVE_TESTS=1` drives the real
thing and would go red if Increase changed shape).

### Plaid — no routing-number directory

Plaid has no routing-number lookup. `/auth/get` returns routing numbers *for an
Item you already hold*, which is the opposite direction. `/institutions/get`
searches institutions by name and product, not by routing number. Nothing there
answers "whose bank is `011401533`".

### Also available, deliberately unused: Increase ACH prenotification

```
GET https://sandbox.increase.com/ach_prenotifications?limit=1   →  200 {"data":[]}
```

The endpoint is reachable with our key. A prenote is the genuine US mechanism
for validating an account before sending money: a zero-dollar entry the
receiving bank may answer with C01 (wrong account number), C02 (wrong routing
number) or C03 (both). **It is not in this feature**, for two reasons, both
deliberate:

* it is a **write to the rail**, and this path validates rather than transacts;
* the answer arrives in days, over a webhook — so it is a background assurance
  loop, not a confirmation step in front of a payment.

It is the right week-two feature and §7 sketches it. It is described here as
unbuilt, because it is.

---

## 3. Account-name matching, honestly

### The gap, precisely

`POST /identity/match` takes an **access token**, not a routing number and an
account number. An access token exists for an Item, and an Item exists because
a human sat in front of Plaid Link and typed their own bank credentials. So:

> Plaid can answer: *does the name I typed match the name on **this** account
> that **its own holder** connected to me?*
>
> Confirmation of Payee answers: *does the name I typed match the name on
> **that** account at **somebody else's** bank, which I know only by its
> number?*

Those are different questions. The second has no answer available to this
system, from any provider in the credential set.

### What that leaves, and it is not nothing

`/identity/match` is **live with our credentials** and it does real name
verification — for accounts somebody linked. Six calls, six `200`s:

| Name typed | `legal_name.score` | `is_first_name_or_last_name_match` | `is_business_name_detected` | `request_id` |
| --- | --- | --- | --- | --- |
| Alberta Bobbeth Charleson | 100 | true | false | `bb0b1a0f2d6e1af` |
| ALBERTA B CHARLESON | 99 | true | false | `ac47aaa52dcae8e` |
| Alberta Charleson | 99 | true | false | `6022fb024b2078c` |
| Alberta Charlson | 93 | true | false | `6414abec680a152` |
| Roberto Gonzalez | 28 | false | false | `9f2d9d1a717b9a8` |
| Acme Widgets LLC | 0 | false | **true** | `c32f17a551f5aa0` |

(Item created through `POST /sandbox/public_token/create` on `ins_109508` with
`["auth","identity"]`; holder on file `Alberta Bobbeth Charleson`, confirmed via
`/identity/get`.)

So there are exactly three provenances for the other name, and
`payee_name_source` in migration 0016 has one value for each:

| Value | Meaning | Available? |
| --- | --- | --- |
| `linked_account_holder` | The receiving institution's own record, via the holder's Plaid link | **Yes, live** — for accounts somebody linked |
| `payer_asserted` | Our own team typed both sides. Nobody confirmed anything | The default, and the honest one |
| `confirmation_of_payee` | A real name-check network answered | **No US provider in this repo can produce this.** Declared so the schema does not move the day one can |

The screen prints the source in words. `payer_asserted` never renders in the
positive tone, however high the score — `src/components/payees/labels.tsx` is
the one place every label is written down, and rule 1 there is *no green tick
without a third party*.

### The algorithm, and the threshold I chose and will defend

`src/lib/payees/name-match.ts`. Normalisation first: NFKD then strip combining
marks (so `José` = `Jose`, because a US core system very often holds the
ASCII-only form), uppercase, `&` → ` AND `, punctuation → space, collapse
whitespace, drop a leading `THE`, strip legal-form suffixes (LLC, INC, CORP,
CO, LTD, PC, NA, …), and join a dotted initialism **only when the joined result
is itself a legal form** — so `L.L.C.` becomes `LLC` and is stripped, while
`A B Smith` keeps two initials.

Then two signals:

* **Structural** — token alignment where a pair scores 1.00 for an exact match
  and 0.95 for an initial standing in for the name it abbreviates, and
  **nothing otherwise**. Coverage is measured against the *shorter* name and
  the longer name's leftovers are charged for: 0 for an interior initial, 1 for
  an interior word (a middle name), **12 for a first or last token**. That
  asymmetry is the point — a dropped middle name is presentational, a dropped
  surname is a different person.
* **Textual** — Jaro–Winkler over the concatenated cores. Right family for
  names, because people get the start of a name right and drift later.

And then **the one rule that makes the scoring defensible**:

> **Character similarity may never assert a match. Only structure may.**

A `match` requires structure to clear the threshold on its own. Jaro–Winkler
runs, but its result is clamped one point *below* the threshold and can only
grade a non-match between "close" and "nothing like it".

The reason is the entire purpose of the feature. `Alberta Charleston` against
`Alberta Bobbeth Charleson` — one inserted letter, the exact mistype we are
here to catch — scores **99** on Jaro–Winkler. An algorithm that took that at
face value would call the typo a match and wave it through. So it does not get
to: it lands at 94, in `close_match`, in front of a human.

**Thresholds: `match` ≥ 95, `close_match` ≥ 80, `no_match` below.**

*Why 95 and not 90.* By construction, **every** difference that is merely
presentational — case, punctuation, `&` vs `and`, diacritics, legal form, word
order, an initial for a given name, a dropped middle name — normalises to 95 or
better. **Nothing that changes a letter of a name token can reach it.** The
threshold separates two categories rather than slicing a continuum at a round
number, which is what makes it arguable rather than tuned.

*Why 80 is a presentation boundary, not a decision one.* Both bands below
`match` warn, both need the same signature, and nothing in the system behaves
differently across 80. It exists so a screen can say "did you mean" for a near
miss and "these are not the same name" for a stranger.

### Calibrated against Plaid, and deliberately stricter

| Name typed | Plaid | Ours | Our band |
| --- | --- | --- | --- |
| Alberta Bobbeth Charleson | 100 | 100 | match |
| ALBERTA B CHARLESON | 99 | 98 | match |
| Alberta Charleson | 99 | 99 | match |
| **Alberta Charlson** | **93** | **89** | **close_match** |
| Roberto Gonzalez | 28 | 46 | no_match |
| Acme Widgets LLC | 0 | 54 | no_match |

Two deliberate divergences:

* **Plaid's own guidance treats ≥ 90 as a strong match**, which would pass
  `Charlson` — a one-letter surname difference. Ours does not.
* **Our floor is higher** (46 vs 28 for an unrelated name), because
  Jaro–Winkler over two English names shares vowels and never approaches zero.
  It does not matter: nothing below 80 behaves differently from anything else
  below 80, so the disagreement is invisible to the product. The test asserts
  rank agreement only where Plaid is above 80 — asserting a rank we do not have
  would be a test that lies.

Business cases the normaliser gets right, all pinned in `name-match.test.ts`:

| Compared | Band | |
| --- | --- | --- |
| `Ridgeline Coffee Roasters LLC` vs `Ridgeline Coffee Roasters, L.L.C.` | match | punctuation + initialism |
| `Acme Corp` vs `ACME CORPORATION` | match | legal form |
| `Smith & Jones` vs `Smith and Jones` | match | ampersand |
| `John Smith` vs `Smith John` | match | word order — banks store surname-first |
| `John Smith` vs `John Q Smith` | match | interior initial |
| `Ridgeline Coffee` vs `Ridgeline Coffee Roasters LLC` | close_match | terminal word |
| `Northwind Trading` vs `Northwind Traders` | close_match | one letter |
| `RCR Holdings LLC` vs `Ridgeline Coffee Roasters LLC` | no_match | trading name — legitimate, warned |
| `Ridgeline Holdings` vs `Ridgeline` | **not** match | `HOLDINGS` is the name, not a legal form |

### Two opinions are kept apart, never averaged

When both Plaid and our comparison have an answer, a `match` requires **both**
to agree. Either one dissenting drops the band. Two independent opinions that
disagree is exactly the case a human should look at, and an average would hide
it. `payee_verification` stores `name_match_score` (ours) and the provider's
score separately; there is no column that blends them.

---

## 4. The payee book

`db/migrations/0016_payees.sql`. Five tables, all append-only: SELECT and
INSERT for `corgi_app`, an explicit REVOKE of UPDATE/DELETE/TRUNCATE, and
0001's `ledger_row_is_immutable()` trigger as the layer that also binds the
table owner. Not because these are money rows — no journal line is written by
anything in this feature — but because they are the record of what we checked
before money moved, and an assurance trail you can edit afterwards is a story.

| Table | What it holds |
| --- | --- |
| `payee` | The beneficiary. **A routing number that fails the check digit cannot be stored** — `payee_routing_number_possible` |
| `payee_verification` | One row per check. Never updated; "verified in March" and "verified today" are different rows |
| `payee_acknowledgement` | A named human, an instant and a sentence. What makes a warning a warning |
| `payee_archival` | Removal as an append. PK is the payee id, so it happens at most once |
| `payee_candidate_refusal` | **The caught typo.** The only table whose routing-number column has no checksum constraint, because its job is to hold numbers that fail it |

### Freshness is derived, not stamped

> "A payee verified six months ago is not the same as one verified today."

So there is **no `is_verified` boolean anywhere in this feature.** There is a
list of checks with timestamps, and `v_payee_book` derives the current standing
from the newest one and labels its age against `now()`:

```
fresh    ≤ 30 days
ageing   ≤ 90 days
stale     > 90 days
never                  no check on file at all
```

Defined once, in `payee_verification_freshness()`, called by the view.
TypeScript reads the label off the view rather than recomputing it — the same
reason `standing_order_due_dates()` owns the calendar. A stored flag would have
to be re-stamped by something, and the thing that re-stamps it is the thing
that eventually does not.

90 days is the horizon a payments team uses for re-confirming supplier bank
details out of band.

### The twin probe — the only account-number check we have

`payee.account_number_last4` holds four digits and never the full number, the
same rule `payment_instruction.counterparty` follows: the approver needs to
recognise a beneficiary, not to be able to re-key the payment somewhere else.

The cost of that choice, stated plainly: **we cannot re-derive the account
number, so the only account-number typo this system can catch is one that
disagrees with a payee already in the book.**

It catches the failure that actually costs businesses money, though. If you
have paid *Ridgeline Coffee Roasters* at ••4417 for a year and today's payment
says ••9002, somebody should look at that — and it should be a person, because
a supplier genuinely changing bank looks identical to an invoice redirected by
a fraudster. `findConflictingTwin()` compares through the same normaliser the
name match uses, because a slightly different spelling is usually *why* a
second record exists.

The other account-number defence is re-entry: `accountNumberEntryAgrees()`
compares two typings. It is deliberately **not** a `PayeeFinding` and not part
of the block/warn ladder — two different strings are a contradiction in the
form, not a fact about a bank, and mixing the two would blur the distinction
the feature is built on.

**The United States puts no check digit on an account number.** No length rule,
no character rule, no checksum. The arithmetic that saves the routing number
saves nothing here, and that is why §7 is about prenotification.

---

## 5. The judgement call: block versus warn

### The line

> **A failed routing checksum is a BLOCK.**
> **A failed name match is a WARNING.**

Not because one matters more. Because they are different *kinds* of statement.

**The checksum is a closed question.** A number that misses is not a number any
bank has, has had, or will be issued. There is no fact about the world that
could make it right, so there is no informed human who could be right to
override it. An "are you sure?" in front of arithmetic is theatre — and worse
than useless, because it teaches people that this system's warnings are things
you click through. The next warning they click through is the one that
mattered.

**The name is an open question, and it is open in the direction of false
positives.** Companies trade under names that are not their registered ones.
Subsidiaries bank in a parent's name. Sole traders bank personally. A factoring
company is paid instead of the supplier who raised the invoice. Every UK CoP
scheme — the mature version of this feature, running at national scale — lets
the payer proceed after an explicit acknowledgement, for exactly these reasons.
**A hard block on a name mismatch does not stop fraud; it stops legitimate
payments, and then it gets switched off.**

So the warning is made to **cost** something instead. `payee_acknowledgement` is
a row with a named human, an instant and a sentence, a trigger refuses one
against a check that was not `warned`, and the row is append-only like
everything else. That is what makes "we let it through" answerable afterwards,
and it is what earns the name leg the right to be a warning rather than a wall.

### Where the line is enforced — four times, so it cannot be moved in one place

1. **`assertBlockIsArithmetic()`** (`verify.ts`) — at runtime, on every check.
   `ROUTING_CHECKSUM_FAILED` is the only code permitted to carry `block`. If a
   future edit gives another finding that severity — one word in an object
   literal — this **throws** at the point of the mistake rather than silently
   converting a warning into a wall nobody can override and nobody can find.
2. **`payee_routing_number_possible`** — a CHECK constraint. An impossible
   routing number is not storable. The block is unrepresentable-as-stored, not
   enforced-by-a-caller.
3. **`payee_verification_block_is_arithmetic`** — a second CHECK:
   `(outcome = 'blocked') = (checksum_ok IS FALSE)`. A stored verification
   cannot claim a block for a soft reason.
4. **The UI has no continue control in the blocked branch.** Not disabled —
   *absent*. A disabled button says "you may not do this", which invites
   somebody to find out who can. For arithmetic there is nobody.

### 5a. THE HOLE: the gate was a no-op on wires, and wires are the rail that cannot be recalled

Fixed 2026-09-11. Recorded here rather than quietly patched, because the shape
of it is more useful than the fix.

`gatePaymentOnPayee()` opened with, in effect:

```ts
const routingNumber = input.destination.type === "ach" ? input.destination.routingNumber : null;
```

and then `if (routingNumber === null || last4 === null) return null;`. So a
**wire received neither leg 1 nor leg 4** — no ABA check-digit arithmetic and no
standing-warning check — on the one rail where the money cannot be recovered.
The two rails this feature protects are the two rails addressed by an ABA, and
it protected one of them.

**It was not a missed branch. It was a missing field.** `destinationSchema`'s
wire variant was `{ type: 'wire', holderName, bic, accountNumberLast4 }`, and a
**BIC is a SWIFT identifier for a bank**, used on cross-border payments. A
domestic Fedwire beneficiary is addressed by a 9-digit ABA — specifically the
**WIRE** variant of it, which is a different number from the same bank's ACH
variant. The seeded Plaid item carries `011401533` for ACH and `021000021` for
wire, and substituting one for the other is an R13 days later. So the field the
gate was reading was not the field the payment was using, and the early return
was the correct behaviour of a schema that was wrong.

The fix is four small edits and one refusal:

1. `wireRoutingNumber: z.string().regex(/^\d{9}$/).optional()` on the wire
   variant, and `bic` demoted to optional — kept for genuinely cross-border
   wires, no longer the only bank identifier.
2. `destinationRoutingNumber()` in the gate returns the ACH number for an ACH
   destination and the wire number for a wire one. Named `wireRoutingNumber`
   and not `routingNumber` on purpose: **the mistake this rail suffers is the
   substitution**, and a field that accepts both names accepts it in silence.
3. `describeDestination()` and `buildDestination()` follow.
4. A wire carrying no wire routing number is **refused**
   (`PAYEE_WIRE_ROUTING_NUMBER_MISSING`) rather than skipped.

**Why the schema field is OPTIONAL and the enforcement is in the gate.**
`parseDestination()` re-validates every STORED destination on the way out, so a
required field would turn the ten pre-existing wire instructions — including the
$42.00 wire that really went out on Fedwire — into "Unrecognised destination —
do not approve" on `/approvals`, and would stop `originateApprovedWire()`
recognising its own transfer. Requiring it would rewrite history by refusing to
read it. The gate runs on the way IN and never on the way out, so a refusal
there is forward-only by construction.

**What `/payments` does about it.** The wire branch is now a **payee picker**,
not a free-text field, and the asymmetry with ACH is deliberate and preserved:
`originateApprovedWire()` refuses a beneficiary that is not on the confirmed
book, so a free-text wire is a payment a clerk can raise and nobody can send —
a refusal that arrives two approvals and one ledger entry too late. Requiring
pre-registration would be wrong for ACH for the reasons in *What the gate
deliberately does not refuse* below: those costs are costs of **delay**, and an
ACH entry is recallable for two banking days. A wire is not, and *"urgent
payment, right now, to a beneficiary nobody has seen before"* is a verbatim
description of business email compromise.

### 5b. THE SECOND HOLE: the gate could not report its own failure

Also fixed 2026-09-11, and it compounds with the first.

The standing-warning check was wrapped, whole, in
`try { … } catch { return null }`. Every outcome inside it therefore reached the
caller as the same value: **"no warning on this destination" and "the lookup
exploded" were indistinguishable**, and the payment proceeded either way. The
condition the guard exists to catch — a database this transaction cannot read —
was precisely the condition that silently disabled the guard.

Put beside §5a, the combination was the worst case this build had: on wires the
gate returned early and validated nothing, and on the paths where it did run,
any failure inside it read as a pass.

**The argument for failing open was about a different system.** It said: *"a
destination-validation service that can stop every payment by falling over is a
worse risk than one that occasionally does not run."* That is true of a separate
service. There is no separate service — this runs on `tx`, the same connection
and the same transaction that is about to `INSERT` the instruction. A throw here
does not mean the payee book is unreachable while payments are healthy; it means
**this transaction cannot read**, and the INSERT two statements later is going
to fail anyway. Failing open bought availability that was never on offer, and
paid for it by disarming the check on the rail with no recall.

It now fails closed, with `PAYEE_STANDING_CHECK_UNAVAILABLE`, and the message
names **which** read did not complete — the account's business, or the payee
book — because "invalid request" is not something an operator can act on. The
driver's own text is deliberately not included: it names internal ids and table
structure and this string is rendered on a screen. Only the error's class is.

**The `try` now wraps the CALL and not the DECISION.** Everything after it is a
decision about a value that came back, and the thing this has to distinguish is
"the database answered null" from "the database did not answer".

**The one case that still proceeds, named exactly**, because a bare `catch` over
everything is what got us here:

> A destination with no payee-book row, on a business with no payee book at
> all, proceeds.

Both of those are ANSWERS, not failures: a deposit account with no business row
cannot have a payee book, and an unregistered destination is deliberately
allowed. **What it can let through:** a payment to a beneficiary nobody has ever
checked, with nothing but the ABA arithmetic in front of it. On ACH that is the
accepted trade and the reasoning is below. On WIRE it is not — and it is closed
one layer down rather than here, because `resolveWireBeneficiary()` refuses to
address a Fedwire message to a beneficiary that is not on the confirmed book.

### The intermediate case, and why it is not an exception

The payment gate refuses a payment to a payee whose standing warning **nobody
has signed for** (`PAYEE_WARNING_UNACKNOWLEDGED`). That looks like a block on a
soft reason, and it is not:

> It is not a block on the warning. The warning is still overridable, by
> anybody, at any time, in one step. It is a **refusal to let the override be
> implicit.** The remedy is a signature, not an exception — and the difference
> between those two is the difference between a control and a checkbox.

### What the gate deliberately does *not* refuse

* **A destination that is not on the book.** Requiring every payee to be
  pre-registered has real costs — the one-off refund, the emergency supplier
  payment, the payment raised by the MCP agent from an invoice — and the brief
  did not ask for it. An unknown destination still gets the arithmetic, which
  is the part that catches the typo.
* **A stale check.** A payee last verified in March is one whose *screen*
  should say so, loudly, and whose payment should still go out. Blocking on age
  means a bank holiday and a slow re-check can stop payroll, and the fix people
  reach for is turning the check off. Age is surfaced; it is not a gate.

### The severity ladder, complete

| Finding | Severity | Why |
| --- | --- | --- |
| `ROUTING_CHECKSUM_FAILED` | **block** | Arithmetically impossible. Nothing can make it right |
| `ROUTING_PREFIX_UNALLOCATED` | warn | A registry fact, not an arithmetic one |
| `NAME_NO_MATCH` / `NAME_CLOSE_MATCH` | warn | Names legitimately differ |
| `TWIN_WITH_DIFFERENT_DETAILS` | warn | Identical to a supplier changing bank |
| `DIRECTORY_RAIL_UNSUPPORTED` | warn | Usually a wire routing number used for ACH |
| `DIRECTORY_NOT_LISTED` | warn **in production**, note **in sandbox** | In sandbox it means the test directory is small |
| `DIRECTORY_UNAVAILABLE` | note | A provider being down is not evidence about a payee |
| `NAME_NOT_VERIFIABLE` | note | The normal case for US ACH. A warning on every payment is no warning |
| `DIRECTORY_CONFIRMED` / `NAME_CONFIRMED_BY_INSTITUTION` | note | Positive findings, recorded, stop nothing |

### And two refusals the GATE makes that are not `PayeeFinding`s at all

`assertBlockIsArithmetic()` polices the ladder above, and it is about what a
CHECK on a payee may claim. These two are decisions the payment gate makes about
a payment, and they are deliberately not findings — a finding is a statement
about a beneficiary, and neither of these is.

| Code | What it means |
| --- | --- |
| `PAYEE_WIRE_ROUTING_NUMBER_MISSING` | A wire carrying no 9-digit wire routing number. Both checks above are unrunnable on it, so it is refused rather than skipped. A BIC is not a substitute: it names a bank on SWIFT, and Fedwire does not read it. |
| `PAYEE_STANDING_CHECK_UNAVAILABLE` | The payee-book lookup threw. The payment is refused, and the message names which read failed. See §5b. |

---

## 6. Where to wire it in

> **`src/app/(app)/payments/**` was off-limits to the worker who wrote this
> section.** It is now wired: the one line below is in `requestPayment()`, and
> the wire branch of `/payments` carries a payee picker (§5a).

### The one line, in `requestPayment()`

`src/lib/approvals/instructions.ts`, **inside `conn.begin()`**, immediately
after the KYB gate (`if (!gate.allowed) return fail(gate.code, gate.message);`)
and **before** the `INSERT INTO payment_instruction`:

```ts
const payee = await gatePaymentOnPayee(
  { accountId: args.accountId, destination: args.destination },
  tx as unknown as Sql,
);
if (payee !== null) return fail(payee.code, payee.message);
```

with

```ts
import { gatePaymentOnPayee } from "@/lib/payees";
```

### Why that exact position

* **After the KYB gate** — an unverified business should be told it cannot
  transact at all before it is told anything about its payee.
* **Inside the transaction** — the payee book is read under the same snapshot
  that writes the instruction, so a warning cannot be raised between the check
  and the INSERT. The same argument the KYB gate makes about
  approve-then-revoke.
* **Before the INSERT** — a blocked destination writes no instruction at all.
  There is no "raised then refused" state to clean up, and the approvals queue
  never shows a payment that could not be made.

### What it costs

**No network call.** A checksum is arithmetic; the book lookup is one index
scan on `(business_id, routing_number)`. Safe inside a transaction that is
already writing two rows. The provider legs — Increase's directory, Plaid's
identity match — run when a payee is added or re-checked, on the payee screen,
where a person is waiting and 150ms is affordable. A payment path that fanned
out to two third parties inside a transaction would be a payment path that
fails when they do.

### Which direction it fails in

**Closed.** `gatePaymentOnPayee` never *throws* — every outcome is a value — but
"never throws" is not "always proceeds", and conflating those two is what made
this function a no-op on its own failure. A lookup that fails returns
`PAYEE_STANDING_CHECK_UNAVAILABLE` and the payment is refused. §5b is the full
argument, and the one case that still proceeds is named there.

### The screen

`src/components/payees/**` is complete and unwired, because `src/app/**` is off
limits. Two files stand it up:

```tsx
// src/app/(app)/payees/page.tsx
import { Suspense } from "react";
import { PayeeBookView, PayeeSkeleton } from "@/components/payees/PayeeBookView";
import { PayeeStateBar } from "@/components/payees/PayeeStateBar";
import { fixtureSource } from "@/components/payees/fixtures";
import { parsePayeeFilter } from "@/components/payees/view-state";
import { livePayeeSource } from "@/lib/payees/screen";

export default async function PayeesPage({ searchParams }: { searchParams: Promise<…> }) {
  const filter = parsePayeeFilter(await searchParams);
  const source = filter.state === "default" ? livePayeeSource() : fixtureSource(filter.state);
  return (
    <>
      <PayeeStateBar filter={filter} />
      <Suspense fallback={<PayeeSkeleton />}>
        <PayeeBookView source={source} filter={filter} />
      </Suspense>
    </>
  );
}
```

Plus a nav entry to `/payees` in the app shell. The five demo states — default,
loading, empty, error, and **edge (warned, unsigned)** — are all reachable from
the query string and none of them writes a row.

`ConfirmationStep` is the panel that goes between naming a destination and
sending: it is presentational and pure, renders a decision `verifyPayee()`
already made, and therefore cannot disagree with the row that gets written.

---

## 7. What is not built, and what week two is

* **ACH prenotification.** The real answer to "is this account number right".
  `POST /ach_prenotifications` on Increase, reachable with our key today. It
  writes a zero-dollar entry to the rail; the RDFI may answer days later with a
  C01/C02/C03 addenda correction. Shape it would take: fire the prenote when a
  payee is added, record it as a `payee_verification` row with a new
  `directory`-style column for the prenote's state, consume the notification
  webhook through the existing `webhook_inbox` (signature-verified, idempotent,
  out-of-order tolerant, already built), and append a **second** verification
  when the answer lands — never update the first. The freshness bands already
  in place are what make a days-later answer coherent.
* **Micro-deposits.** The other US account-validation mechanism. Slower, needs
  the payee's cooperation, and only sensible where the payee is onboarding
  anyway.
* **A real US name-check provider.** Several exist commercially. When one is
  wired in, `identity.ts` gains a method, `payee_name_source` gains its already
  declared third value, and **nothing in `name-match.ts` changes.** That is
  the point of building the comparison now.
* **Re-check on a schedule.** The freshness bands tell you which payees are
  stale; nothing yet re-checks them automatically. A cron over
  `v_payee_book WHERE freshness = 'stale'` is a small job on top of what exists.
* **Payee management from the MCP surface.** Deliberately absent — see
  `docs/AGENT-LIMITS.md`. An agent that can add a payee is an agent that can
  name where money goes.

---

## 8. Running it

```bash
# unit — no credentials needed
pnpm test src/lib/payees

# against the live database
set -a; . ./.env; set +a
RUN_DB_TESTS=1 pnpm test src/lib/payees

# and against the live providers (Increase + Plaid)
RUN_DB_TESTS=1 RUN_LIVE_TESTS=1 pnpm test src/lib/payees
```

150 tests. The ones worth reading first:

* `aba.test.ts` → **EXHAUSTIVE: what the check digit catches** — the four
  sweeps that produce every number in §1.
* `verify.test.ts` → **ONLY arithmetic blocks** and **a name mismatch NEVER
  blocks** — the block/warn line, in assertions.
* `name-match.test.ts` → **THE RULE: character similarity may never assert a
  match**.
* `payees.integration.test.ts` → the CHECK constraint refusing an impossible
  routing number directly at the table; TypeScript and Postgres agreeing on 305
  numbers; and *a full confirmation writes no journal entry and no journal
  line*, counted before and after.

`node scripts/dbcheck.mjs` → **14/14** with migration 0016 applied.
