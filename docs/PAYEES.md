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
allowed. **What it can let through:** an ACH payment to a beneficiary nobody has ever
checked, with nothing but the ABA arithmetic in front of it. On ACH that is the
accepted trade and the reasoning is below. **On WIRE neither of those zero-row
outcomes is an answer any more** — both are `PAYEE_WIRE_PAYEE_NOT_ON_BOOK`, at
this gate, as of §5c. It used to be closed one layer down instead, by
`resolveWireBeneficiary()` refusing to address a Fedwire message to a
beneficiary that is not on the confirmed book; that refusal still exists and
now has a twin at the front door.

### 5c. WHERE A WIRE'S ABA COMES FROM — a design conflict, decided

Decided 2026-09-11. Two defensible stories were live at once, which is worse
than either of them being wrong.

* **The rail's story.** `resolveWireBeneficiary()` resolved the wire ABA **from
  the confirmed payee book** at send time and refused a beneficiary nobody had
  checked, so `src/lib/rails/wire/outbound.integration.test.ts` deliberately
  raised a BIC-only wire. Its argument: a wire beneficiary's bank details come
  from the book, not from whoever typed the instruction.
* **The gate's story.** §5a had just added `wireRoutingNumber` to the
  destination and refused a wire without one, so that a wire is validated
  against the number it will actually be sent to.

Four of that suite's six tests were red on the disagreement.

**The decision: the book is authoritative, AND the instruction carries a copy
of the book's number.**

The deciding argument is **maker-checker**, and it is not about payees at all.
`payment_instruction.content_hash` is what an approver must cite — the
approve-the-hash trigger in 0001 enforces it — and the hash covers
`counterparty`. Leave the ABA off the instruction and the single most important
fact about a wire, *which bank receives the money*, sits **outside the thing
two humans signed**, re-resolved later from a table that grows rows. The payee
book is append-only but it is not frozen: archive a payee, append a same-name
same-last-four payee at a different bank, and an already-approved wire
addresses itself somewhere new with no approval having changed, because no
approval ever covered it. A control that can be stepped around by appending a
row is not a control.

So the number rides on the instruction, inside the hash, on the approver's
screen — and **the gate is what proves it came from the book**:

| Code | When |
| --- | --- |
| `PAYEE_WIRE_PAYEE_NOT_ON_BOOK` | No confirmed, unarchived wire payee matches `(rail = 'wire', holderName, accountNumberLast4)` — the same predicate `resolveWireBeneficiary()` matches on, and now literally the same function, `loadWireBeneficiaries()` in `store.ts`. Also the answer when the account has no business at all. |
| `PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED` | The beneficiary matches, but the instruction names a bank the book does not confirm for them. The message names the number that *is* confirmed. |

Both of these refusals already existed — inside `originateApprovedWire()`,
**after two approvals and a ledger entry**. They are the same refusals moved to
the front, which is what docs/WIRES.md §7 asked for. The rail still makes them,
because the gate speaks for the book on the way *in* and cannot speak for it at
release time; and the rail gained one the gate cannot make,
`WIRE_ROUTING_NUMBER_NOT_CONFIRMED`, for when the two moments disagree.

**Why the matching rule leaves the routing number out.** Folding it into the
match would collapse "you have never confirmed this bank for this beneficiary"
into an indistinguishable "no such payee" — and those two sentences send a
payments clerk to two different places. The first is the redirected invoice.

**Nothing on the ACH path changed.** ACH still allows an unregistered
destination, for the reasons in *What the gate deliberately does not refuse*
below: those costs are costs of **delay**, and an ACH entry is recallable for
two banking days. A wire is not, and *"urgent payment, right now, to a
beneficiary nobody has seen before"* is a verbatim description of business
email compromise. The asymmetry **is** the decision, and
`payees.integration.test.ts` asserts it both ways: the same unknown beneficiary
is refused on wire and allowed on ACH.

**The schema field stays optional.** Ten `payment_instruction` rows predate it,
including the $42.00 wire that really went out on Fedwire, and
`parseDestination()` re-validates every stored destination on the way *out*.
Requiring it would rewrite history by refusing to read it. The gate runs on the
way in and never on the way out, so the enforcement is forward-only by
construction.

**And the second refusal that suite hit was not a defect.** Supplying the ABA
reached `PAYEE_WARNING_UNACKNOWLEDGED`, and **measured** against the live book
rather than guessed: the payee carries `TWIN_WITH_DIFFERENT_DETAILS`, because
*Northwind Industrial LLC* is already on Ridgeline's book at `021000021`
••3330 and the fixture registers the same beneficiary at ••0000. Same supplier,
different account — exactly what the twin probe exists to raise, and exactly
what a person on `/payees` would read and sign for before the payment went out.
**The fixture was failing to acknowledge something a real user would see and
click.** It now signs, with a named human who is *not* the maker and a sentence,
because signing for a warning and raising a payment are different acts.

### 5d. THE THIRD HOLE: `confirmPayee()` failed open *and wrote a permanent row*

Fixed 2026-09-11. The same shape as §5b, one layer up, and strictly worse.

```ts
const book = await loadBookEntries(input.candidate.businessId, conn).catch(
  () => [] as const,
);
```

Every consequence of that one line ran downhill. `findConflictingTwin()` over an
empty list finds nothing, so `TWIN_WITH_DIFFERENT_DETAILS` — the only
account-number check a book of last-four digits can perform, and the one that
catches the redirected invoice — **could not fire**. With no warn-level finding,
`decide()` returned `verified`. And then `savePayee()` wrote that word into
`payee_verification`, which is append-only by grant, by REVOKE and by 0001's
`ledger_row_is_immutable()` trigger.

**So a transient read failure became permanent evidence of a check that never
happened**, on the book that gates money leaving the building. That is worse
than §5b: there the payment proceeded and left nothing behind, here the row
outlives the outage and can never be corrected, only superseded. Every screen,
every freshness band and the payment gate itself then read a check nobody ran,
and nothing downstream could tell the difference because nothing downstream was
given one.

**It now fails closed and writes nothing.** No payee, no verification, and
deliberately no `payee_candidate_refusal` either — that table is for a candidate
the *arithmetic* refused, which is the product of this feature; this candidate
was not refused, it was **not examined**, and filing it as a caught typo would
be a second false statement in place of the first. The caller gets
`check: null`, `saved: null` and `PAYEE_BOOK_UNREADABLE` naming the leg that did
not run.

`ConfirmPayeeResult.check` is nullable for exactly this: `null` means *no check
happened*, which is a different thing from a `PayeeCheck` with no findings.

**The case that still proceeds, named exactly**, because a bare `catch` over
everything is what got us here:

> `loadBookEntries()` returning **zero rows**.

An empty book is an ANSWER and it is the commonest one — it means this is the
business's first payee, and `verifyPayee()` already says so in as many words.
**What that can let through:** nothing the twin probe would have caught, because
a twin needs an existing record to be a twin of. The `catch` conflated that
answer with "the database did not answer", which are the two things this has to
tell apart.

### 5e. THE FOURTH ONE: the refusal named a noun the payer had never seen

Found 2026-09-11 by firing the gate against the deployed system rather than
against a fixture, which is how this one could only have been found.

`PAYEE_WARNING_UNACKNOWLEDGED` quoted `payee.display_name` and nothing else.
That is the wrong noun. `display_name` is the label somebody filed the payee
under — a folder name, shared across a dozen accounts on this very book
("Green coffee supplier"), and on the rows the wire suite writes it is a
generated fixture string. `holder_name` is the **beneficiary**: the name on the
account, the name the payer typed into the payment, the name on the invoice in
front of them.

Measured, on `POST /api/v1/payments` against the deployed URL, for a wire to
`Northwind Industrial LLC` ••0000:

```
422 PAYEE_WARNING_UNACKNOWLEDGED
The last check on "Northwind (wire) wire-1789107730307" raised a warning that
nobody has signed for. Open the payee, read what the check found, …
```

The refusal was **correct and unusable**. The payer asked about *Northwind
Industrial LLC* and was told a warning stands on a string they have never seen,
cannot search for, and cannot tie to the payment in front of them — on the one
message whose whole job is to send a person to a specific record and get a
signature out of them. A control nobody can act on is a control that gets
routed around.

**Fixed in source, NOT YET ON THE DEPLOYED URL.** The deployment is commit
`0fa057d` and still emits the message above; the quoted 422 is what
`corgi-trial-psi.vercel.app` returns today. What follows is what the code in
this repository produces, asserted in `payees.integration.test.ts` against the
live book — the test fails if the beneficiary name is absent.

`unsignedWarning()` names both, beneficiary first:

```
The last check on "Northwind Industrial LLC", filed on your payee book as
"Northwind (wire) wire-1789107730307", raised a warning that nobody has signed
for. Open /payees?payee=<id>&sign=1 — it shows that payee, what the check found,
and the form that records why it is right to pay this account. …
```

(The second sentence arrived with §6a. This section fixed the NOUN — it named a
label the payer had never seen; §6a.6 fixed the VERB, because *"open the payee,
read what the check found, and record why"* was three verbs and no address, and
the console performed none of them.)

The book label is kept because it is what they will have to find on `/payees`;
it is second because it is not what they recognise. When the two are the same
string the clause is omitted rather than printed twice. The ACH branch had to
grow `v.holder_name` in its SELECT to say it; the wire branch already had it and
was throwing it away.

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

### And the refusals the GATE makes that are not `PayeeFinding`s at all

`assertBlockIsArithmetic()` polices the ladder above, and it is about what a
CHECK on a payee may claim. These are decisions the payment gate makes about a
payment, and they are deliberately not findings — a finding is a statement
about a beneficiary, and none of these is.

| Code | Rail | What it means |
| --- | --- | --- |
| `PAYEE_WIRE_ROUTING_NUMBER_MISSING` | wire | A wire carrying no 9-digit wire routing number. Both checks above are unrunnable on it, so it is refused rather than skipped. A BIC is not a substitute: it names a bank on SWIFT, and Fedwire does not read it. |
| `PAYEE_WIRE_PAYEE_NOT_ON_BOOK` | wire | No confirmed wire payee matches `(rail, holderName, accountNumberLast4)`. ACH deliberately allows an unknown destination; this rail does not. See §5c. |
| `PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED` | wire | The beneficiary IS on the book, at a different bank. Same supplier, different bank, is the redirected invoice. See §5c. |
| `PAYEE_STANDING_CHECK_UNAVAILABLE` | both | The payee-book lookup threw. The payment is refused, and the message names which read failed. See §5b. |

And one the CONFIRMATION step makes, which is not a finding either — it is the
statement that there is no check to report:

| Code | What it means |
| --- | --- |
| `PAYEE_BOOK_UNREADABLE` | `confirmPayee()` could not read the existing book, so the twin probe did not run. Nothing is written: no payee, no verification, no refusal row. See §5d. |

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

**Closed, in all three places it used to fail open.** `gatePaymentOnPayee`
never *throws* — every outcome is a value — but "never throws" is not "always
proceeds", and conflating those two is what made this function a no-op on its
own failure. A lookup that fails returns `PAYEE_STANDING_CHECK_UNAVAILABLE` and
the payment is refused; §5b is the full argument. `confirmPayee()` had the same
shape one layer up and additionally recorded a permanent `verified` row for a
check that could not complete; §5d. In both, the case that still proceeds is
named exactly, because a bare `catch` over everything is what produced them.

### The screen — BOTH HALVES, AS OF 2026-09-11

Until today this section said *"two halves, and only one of them is reachable
from the deployed console"*. That was true and it was the top of the cut list:
`confirmPayee()` had **no caller in `src/app/**`**, `ConfirmationStep.tsx` had
**no importer**, and `/payees` was read-only. The gate in front of the money was
real and enforcing, and its central refusal —
`PAYEE_WARNING_UNACKNOWLEDGED` — told an operator to *"open the payee, read
what the check found, and record why it is right to pay this account"* on a
console that offered no way to do any of those three things. The refusal was
correct and the loop was open. **A control whose remedy is unreachable is a
control people route around.**

Both halves are wired now. §6a is the operator's half.

**THE READ HALF, unchanged.** `PayeesPage` → `livePayeeSource()` →
`v_payee_book`. Every payee, its most recent check, its findings in words, its
freshness band, who signed for a warning and what they wrote, and the
`payee_candidate_refusal` table — the caught typos, which are the product.
**Rendering still runs no checks and writes no rows**, which is what makes "last
checked two days ago" a fact rather than an artefact of who last opened the
page. Running a check is an operator action with an actor attached and a row at
the end of it; a render is not one.

**THE FIVE DEMO STATES STILL WRITE NOTHING.** default, loading, empty, error and
**edge (warned, unsigned)**, all off the query string. The edge state is the one
the whole feature exists for: a payee whose last check warned and whose warning
nobody has signed for. Four of the five are fixtures, and the operator actions
are **absent** on them rather than disabled — a form over a fixture would either
do nothing, which teaches a viewer that this screen's buttons are decorative, or
write a real row against an id that does not exist, which is worse.
`PayeesPage` only fetches the business list on the live state, and an empty list
is what turns the write controls off.

---

## 6a. The operator's half: add, re-check, sign

Three server actions in `src/app/(app)/payees/actions.ts`, three forms under
`src/components/payees/**`, and **no new route** — everything is on `/payees`,
behind query-string flags (`?add=1`, `?payee=<id>&sign=1`). That is deliberate:
`/payees/new` would be a second page carrying a form whose whole purpose is to
be read NEXT TO the book it writes into. The twin probe's answer is only legible
beside the payee it is a twin of.

### 6a.1 THE CHECK DIGIT, SHOWN AS ARITHMETIC

`src/lib/payees/explain.ts`, rendered by `AbaWorking.tsx`. Pure, client-safe,
no I/O, no clock. The add form recomputes it on every keystroke in the browser;
the server recomputes it from the string that was actually posted; and
`payee_routing_number_possible` — a CHECK constraint — has the last word. Three
evaluations of one rule, and the browser's is the only one nothing depends on.

It shows the **working**, not a verdict: each digit, the weight its position
carries, the product, the three group subtotals, the total, and the remainder.

```
position   d1  d2  d3  d4  d5  d6  d7  d8  d9
digit       0   1   1   4   0   1   5   3   3
weight     ×3  ×7  ×1  ×3  ×7  ×1  ×3  ×7  ×1
product     0   7   1  12   0   1  15  21   3

3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)
= 3(0+4+5) + 7(1+0+3) + (1+1+3)
= 27 + 28 + 5
= 60   ≡ 0 (mod 10)
```

**Why the working and not the answer.** This is the one leg that BLOCKS and the
only one with no provider behind it. A block that says "invalid routing number"
is an assertion of authority, and a person who believes they typed it correctly
has no way to tell whether the software is right or merely fussy — the next
thing they do is look for somebody who can turn it off. A block that shows the
sum missing zero by *n* is a claim they can check against the letterhead in ten
seconds. Then the wall is obviously arithmetic and not policy, which is the
whole reason this feature is allowed to have exactly one wall in it.

**The nine single-digit repairs stay unlisted.** `explain.ts` filters
`abaNearMisses()` to transpositions only, exactly as `verify.ts` and `gate.ts`
do, and `explain.test.ts` asserts both halves of that: the transposition IS
named, and every one of the nine substitutions is NOT offered. §1's proof is
what makes it a product decision rather than an oversight — every weight is
invertible mod 10, so every invalid routing number has exactly nine, always, and
"did you mean one of these nine?" is "it is wrong" retyped in nine parts.

**And the blind spot is on the screen, on the number it applies to.** On a
routing number that PASSES, the panel lists the adjacent swaps this arithmetic
could not have caught — `101500001` says out loud that it is indistinguishable
from `101050001`, because the swapped digits differ by exactly five. A
limitation the operator can see is a limitation; one only the author knows about
is a trap. `transpositionIsDetectable()` already existed for exactly this and
had no caller.

### 6a.2 THE FULL ACCOUNT NUMBER IS NEVER SENT TO THE SERVER

The form asks for the account number **twice**, because re-entry is the only
defence the United States leaves against an account-number typo: no check digit,
no length rule, no character rule. The two typings are compared **in the
browser** by `accountNumberEntryAgrees()` — the library's own function, not a
copy — and **only the last four digits are posted**.

That is the right side of the trade. `payee` stores four digits and never more,
for the same reason `payment_instruction.counterparty` does. Sending the whole
number to a server that would immediately discard it would put it in a request
body, in a platform's action log, and in whatever captures an exception on the
way — to buy nothing, because the value is stored at neither end.

And **the re-entry check is not a control**, which is exactly why it is allowed
to live in the browser. `verify.ts` says so already: two different strings are a
contradiction in the FORM, not a fact about a bank, which is why it is
deliberately not a `PayeeFinding` and not part of the block/warn ladder. A POST
assembled by hand skips it and meets every check that matters unchanged.

### 6a.3 THE SIGNATURE NAMES WHAT IT ANSWERED

`src/lib/payees/acknowledge.ts` (server) and `acknowledge-text.ts` (pure, so the
form can show the operator the exact text before it is written — composing a
sentence on somebody's behalf and then putting their name to it is only
acceptable if they read it first).

A sentence on its own answers the wrong question. Six months from now the row
reads

```
Priya Raman · 2026-09-11 · "Checked with the supplier, this is fine."
```

and nobody can tell whether Priya was waving through *a name that did not match*
or *a beneficiary at a different bank from the one already on the book*. Those
are different acts. The first is routine. The second is the exact shape of a
redirected invoice, and it is the only account-number finding a book of
last-four digits can produce. A signature that cannot distinguish them is a
signature for "a warning", which is the checkbox this feature exists not to be.

So the stored `reason` is composed — the operator's own words first, then the
findings by code and by title:

```
Northwind opened a second account for the industrial division in August.
Confirmed on the finance line from the 2025 master agreement, not the number in
the remittance email; spoke to K. Ozuna who read back the last four. — signed
for 1 finding on this check: TWIN_WITH_DIFFERENT_DETAILS ("You already pay
someone by this name at a different account").
```

**Every warn-level finding is a separate checkbox and all of them are
required.** A signature answering one of two warnings, with the payment then
proceeding, is the implicit override the gate exists to refuse.

**And the set is RE-READ from `payee_verification`, never taken from the form.**
The browser posts the codes it displayed; that is a CLAIM about what was on
screen, and between the render and the submit a re-check can land — re-checking
is the normal thing to do, see 6a.4 — at which point the warning on screen is
not the warning standing against the payee. `signWarning()` loads the row by id
and refuses unless the posted set is EXACTLY its warn set:
**`PAYEE_WARNING_MOVED`**, nothing written, recoverable in one step by
reloading. Not a subset and not a superset: a signature naming a finding the
check did not make is a false statement in an append-only table.

The other refusals it makes, all values with codes, all in front of guarantees
rather than instead of them:

| Code | When |
| --- | --- |
| `ACKNOWLEDGEMENT_NEEDS_A_REASON` | Under 12 characters. Not a serious barrier and not meant to be one — it stops "ok" without pretending a length threshold can tell a considered reason from a padded one |
| `PAYEE_CHECK_NOT_WARNED` | The check came back `verified`. Signing a clean check is noise in an audit trail; signing a block is a contradiction. `assert_payee_acknowledgement_answers_a_warning()` refuses it at the row as well |
| `PAYEE_CHECK_HAS_NO_WARNINGS` | Recorded as `warned` but carrying no warn-level finding, so a signature would have nothing to name |
| `PAYEE_CHECK_UNREADABLE` | The check could not be read. Nothing written — a signature against a check nobody could read would name findings nobody verified were on it |

### 6a.4 RE-CHECK APPENDS, AND IS NOT AN EDIT

`src/lib/payees/recheck.ts`. **There are no fields on this form**, and that is
the design rather than a saving. The beneficiary's details come out of the row,
so a re-check can mean *"the same details, checked again today"* and mean it
exactly. A form that re-keyed the bank details in order to re-check them would
make every re-check an opportunity to change them — an unnoticed edit wearing
the word "verify". Changing a beneficiary's bank details is **adding a payee**,
and it goes through the arithmetic and the twin probe as new details, which is
what raises `TWIN_WITH_DIFFERENT_DETAILS` and puts a person in front of it.

It exists because freshness here is DERIVED. `v_payee_book` reads the age of the
newest verification against `now()`; there is no `is_verified` column to
re-stamp, and there could not be, because the thing that re-stamps a flag is the
thing that eventually does not. **Running another check and appending it is the
only operation that can move a payee out of `stale`** — without it the bands
were a label nobody could act on.

Three consequences, each asserted in `operator.integration.test.ts`:

* The previous check keeps its findings and keeps whoever signed for them. Two
  rows, two actors, nothing updated.
* **A signature does not survive a re-check**, because it is attached to the
  check it answered. A re-check that warns again is a new warning with nobody's
  name against it, and the payment gate refuses until somebody signs again. An
  acknowledgement from June says nothing about what was found this morning.
* An **archived** payee is refused (`PAYEE_ARCHIVED`) and nothing is written.
  Appending a fresh check to a withdrawn beneficiary would leave a
  current-looking row on a payee nobody intends to pay, and a later reader would
  take that as permission.

### 6a.5 FAIL-CLOSED IS UNCHANGED, AND CARRIED THROUGH THE FORM

`ConfirmPayeeResult.check` is nullable because `null` means *no check happened*,
which is a different thing from a `PayeeCheck` with no findings. **That
nullability is carried all the way to the screen rather than flattened on the
way**: `ConfirmResult.receipt` is `null` for the §5d path, the panel is not
rendered at all, and the operator is shown `PAYEE_BOOK_UNREADABLE` with the leg
that did not run. `RecheckResult.check` has the same shape and the same rule.

The actions add no new `catch`. Every refusal below the form is a value that
`confirmPayee()`, `recheckPayee()` or `signWarning()` returned.

### 6a.6 THE REFUSAL NOW CARRIES THE REMEDY'S ADDRESS

`unsignedWarning()` in `gate.ts` builds the URL from the payee id it already had
in its hand:

```
Open /payees?payee=3b2decf5-1f19-4664-9852-4e108a2dd3de&sign=1 — it shows that
payee, what the check found, and the form that records why it is right to pay
this account.
```

`signWarningHref()` names the route ONCE on the library side (`payeeHref()`
names it for the screen), and `operator.integration.test.ts` asserts the gate's
message contains it — so a rename that misses one of them fails rather than
shipping a refusal that points at nothing. `PAYEE_WIRE_PAYEE_NOT_ON_BOOK` and
`PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED` carry `/payees?add=1` for the same
reason.

It is a **path and not an anchor tag** on purpose: `/payments` renders a
refusal's `message` as text, and the message has to survive being pasted into a
ticket, an email and a terminal.

§5e fixed the noun in this message; this fixes the verb. *"Open the payee, read
what the check found, and record why"* is three verbs and no address, and until
today the console performed none of them.

### 6a.7 WHAT THE PROVIDERS DO, AND WHICH ONE DELIBERATELY DOES NOT RUN

**Increase's routing directory is LIVE on every add and every re-check.** It is
constructed even with no key, because it degrades to `unavailable` with a
reason rather than throwing — and `unavailable` is truthful where `not_checked`
would be a lie. Those are two of the four values `DirectoryStatus` has and the
pair this feature is most careful about.

**Plaid's `/identity/match` is NOT wired to this form**, and the reason is a
fact about the schema rather than a shortcut. It takes an ACCESS TOKEN — it
answers *"does this name match the account whose own holder linked it to us"* —
and `src/lib/rails/plaid/adapter.ts` says plainly that there is nowhere in this
schema to persist one. So there is no linked account to offer in a dropdown, and
the alternative, a form field asking an operator to paste a bearer token, would
be worse than not having the leg. Manufacturing a sandbox Item purely to run a
name match against an unrelated payee would be a fabricated check, which is
worse again.

The honest consequence is already on the screen: `name_source` comes back
`payer_asserted`, `labels.tsx` refuses to draw that in the positive tone however
high the score is, and the panel says *"both names here were entered by your own
team"*.

### 6a.8 WHAT THE FORM WILL NOT LET YOU ADD

**ACH and wire only.** They are the two rails addressed by a nine-digit ABA, so
they are the two rails this form has anything to check. USDC is addressed by a
chain address with its own EIP-55 checksum and an internal transfer never leaves
this book; putting either behind this panel would be a confirmation step that
confirms nothing, wearing the same frame as one that does.

The wire branch labels the field **wire routing number** and says why: a bank's
wire ABA is a different number from its ACH ABA (`021000021` against
`011401533` on the seeded Plaid item) and substituting one for the other is an
R13 days later. §5a is the same distinction, one layer down.

**The payee key is derived from a source reference** — a supplier record, an
invoice, a ticket — scoped to the business, exactly as `requestPayment()`
derives its idempotency key. Keying the same supplier twice returns the payee
that already exists and writes no second payee; the UNIQUE index decides, not an
`if`. It DOES append today's check, because refusing to record a check on the
grounds that the payee is old would be backwards.

### 6a.9 AND THE ASYMMETRY IS UNTOUCHED

Nothing in this section changes the wire/ACH decision in §5c, the block/warn
line in §5, or the fail-closed behaviour in §5b and §5d. The `/payees` form does
not create wire beneficiaries by a different route: it writes the same `payee`
row that `loadWireBeneficiaries()` reads, so a wire added here is a wire the
gate and `resolveWireBeneficiary()` will both recognise, and one added anywhere
else is not.

---

## 7. What is not built, and what week two is


* ~~**THE CONFIRMATION FORM.**~~ **BUILT 2026-09-11 — see §6a.** It was the top
  of this list for the right reason and it is struck out rather than deleted,
  because the shape of the gap is more useful than the fix: every leg underneath
  it was built, tested and append-only, and none of it was reachable by a
  person. Add, re-check and sign now exist as three server actions and three
  forms on `/payees`; `ConfirmationStep` has an importer; and
  `PAYEE_WARNING_UNACKNOWLEDGED` carries the URL that clears it.
* **ARCHIVING FROM THE CONSOLE.** `archivePayee()` still has no button — the
  same shape as the gap above, one size smaller. It is append-only and tested
  (`operator.integration.test.ts` archives a payee in order to prove a re-check
  refuses one), so what is missing is a form and a confirmation. It is below
  the three that were built because withdrawing a beneficiary is not what an
  unsigned warning sends somebody to `/payees` to do.
* **A BOOK YOU CAN SEARCH.** `/payees` renders every payee on every business,
  newest first, and this book is 380-odd rows of integration-test detritus. The
  drill-through (`?payee=<id>`) is what the gate's refusal uses and it works;
  browsing does not scale, and the fix is a business filter and a name search on
  `v_payee_book`, not pagination alone — a payments clerk arrives knowing the
  supplier's name.
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

**191 tests, and 184 pass with `RUN_DB_TESTS=1`** — measured 2026-09-11 against
the live Neon book. The 7 skipped are the ones that call Increase and Plaid for
real; `RUN_LIVE_TESTS=1` runs those too. Without any flag the suite is 126
passed / 45 skipped, because everything that needs a database skips rather than
fails: CI holds no credentials on purpose.

(It was 171 tests before §6a. The 20 new ones are `explain.test.ts` — the
working, and the nine repairs it refuses to offer — and
`operator.integration.test.ts` — add, re-check, sign, and the refusals between
them.)

The ones worth reading first:

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
* `explain.test.ts` → **the transposition IS named and the nine substitutions
  are NOT**, asserted against `abaNearMisses()` itself so the count is proved
  rather than assumed; and `101500001` saying out loud that it is
  indistinguishable from `101050001`.
* `operator.integration.test.ts` → **a re-check appends and never edits**; **a
  signature that does not name every warning is refused and writes nothing**;
  and the whole loop in one test — the gate refuses, the message carries
  `signWarningHref(payeeId)`, the signature lands, the gate returns `null`, and
  a re-check re-opens it.

`node scripts/dbcheck.mjs` reads **42 passed, 4 failed** across the whole book as
of 2026-09-11. None of the four is a payee view — they are the deliberate
red-on-arrival card/hold findings this repository publishes rather than hides.
No payee table has an invariant view of its own, by design: the payee book is
evidence, not money, and the constraints that police it
(`payee_routing_number_possible`, `payee_verification_block_is_arithmetic`, the
REVOKEs and `ledger_row_is_immutable()`) refuse at write time rather than being
reported after the fact.

---

## 9. What was actually fired, on the deployed system, on 2026-09-11

Every line below is a real HTTP call to `https://corgi-trial-psi.vercel.app`
with the published demo token, scoped to Ridgeline Robotics, Inc.
(`e274546d-6bdd-5266-b0fb-cc839a7811f9`). The quoted text is what the API
returned, not a paraphrase. **Nothing that was refused wrote a
`payment_instruction` row** — checked afterwards by idempotency key, which is
what makes "the refusal arrives before two humans approve" a fact rather than a
design intention.

### Leg 1 — the check digit, computed rather than trusted

`3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)`, evaluated and **printed**:

| sent | what it is | answer |
| --- | --- | --- |
| `011401534` | one digit off `011401533` | `PAYEE_ROUTING_NUMBER_IMPOSSIBLE` — *"The check digit does not hold: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) = **61**, which is **1** away from a multiple of ten. No bank has this routing number."* |
| `011041533` | positions 4 and 5 transposed | *"… = **76**, which is **6** away from a multiple of ten. No bank has this routing number. **Two adjacent digits look swapped: `011401533` would be valid.** Check the payee's paperwork rather than accepting a guess."* |
| `101500001` | `0`↔`5` swap of `101050001` | **ACCEPTED** — queued as instruction `342c3a36-94ad-4883-9013-9f2271c5735b`, `money_moved: false` |

The third row is the honest limit of the arithmetic, live. The two swapped
digits differ by five, the weight difference has gcd 2 with ten, and the sum
does not move — §1 predicts exactly this miss set and the deployed system
reproduces it. Nothing downstream catches it either; the RDFI does, days later,
as an R03 or R04.

### What the screen names, and what it deliberately does not

The claim being tested was *"the screen naming the single-digit repairs"*. **It
does not, on purpose, and that is a feature rather than an omission.** §1 proves
that every weight is invertible mod 10, so **every invalid routing number has
exactly nine single-digit repairs — one per position, always.** Offering them
would be "did you mean one of these nine?", which is the statement *"it is
wrong"* re-typed in nine parts, and it would invite a clerk to pick one. What
the message names instead is the **transposition** repair, which is a specific,
checkable claim about what the hand did — and `abaNearMisses()` returns both
kinds so the count can be asserted in a test while `verify.ts` and the gate show
only the diagnostic one.

### Legs 2–4 — the twin, and the two rails

| sent | rail | answer |
| --- | --- | --- |
| `Fenwick Marine Supply LLC` ••8801, wire `021000021` | wire | `PAYEE_WIRE_PAYEE_NOT_ON_BOOK` — *"No confirmed wire payee matches "Fenwick Marine Supply LLC" ••8801 … A wire is final on receipt and business email compromise is a WELL-FORMED instruction … ACH deliberately allows it, because an ACH entry is recallable for two banking days and a wire is not. Nothing was written and no payment was raised."* |
| **the same beneficiary**, ••8801, ACH `011401533` | ACH | **ACCEPTED** — `42cb1a2f-e2d2-4e08-b8d9-77e981c026b1`, $42.00, `queued_for_human_approval`, `money_moved: false` |
| `Northwind Industrial LLC` ••3330, wire `011401533` | wire | `PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED` — *"… is on your payee book, but not at 011401533. **The wire routing number somebody confirmed for this beneficiary is 021000021.** Same supplier, different bank is what a redirected invoice looks like from the inside, and a wire cannot be recalled once it is received. Confirm the change through a channel you already had — not one from the message that asked for it …"* |
| `Northwind Industrial LLC` ••0000, wire `021000021` | wire | `PAYEE_WARNING_UNACKNOWLEDGED` (see §5e) |

**The asymmetry, in two adjacent calls.** Same beneficiary, same last four,
same instant: refused on wire, accepted on ACH. That is §5c's decision, running.

**The twin, on the book.** The ••0000 payee warns because `confirmPayee()` ran
the twin probe and found the same beneficiary already at a different account.
The finding is stored, verbatim, in `payee_verification`
`aa1c5be9-edbc-4ce8-bdce-46f68750d1a9` on payee
`7e3f832e-98fb-4128-b181-52198db46c1b`:

```json
{ "code": "TWIN_WITH_DIFFERENT_DETAILS",
  "severity": "warn",
  "title": "You already pay someone by this name at a different account",
  "detail": "\"Northwind Industrial LLC\" is already on your payee book with 021000021
             routing and an account ending 3330 — different bank details for the same
             name. This is what a redirected-invoice fraud looks like from the inside,
             and it is also what a supplier changing bank looks like. Confirm the
             change by a channel you already had, not one from the email that asked
             for it." }
```

Append-only, so that row is what the check said at the moment it ran and stays
that way. `v_payee_book.has_conflicting_twin` reads `true` on it.

### Leg 5 — the refusal arrives before the approvers, and nothing is written

Nine calls, three of which were meant to succeed. Afterwards, on the live book,
by namespaced idempotency key:

| key | instruction written? |
| --- | --- |
| `proof-aba-single-011401534` | **no** |
| `proof-aba-transpose-011041533` | **no** |
| `proof-wire-unknown-fenwick-1` | **no** |
| `proof-wire-unconfirmed-bank-nw-2` | **no** |
| `proof-wire-twin-unsigned-nw-2` | **no** |
| `proof-aba-blindspot-101500001` | yes — the accepted one |
| `proof-ach-unknown-fenwick-1` | yes — the accepted one |

No `payment_instruction` row means no `payment_instruction_event`, which means
nothing in the approvals queue, which means **no approver's attention was spent
on a payment that could never be made**. The gate sits inside `conn.begin()` in
`requestPayment()`, after the KYB gate and before the INSERT; that ordering is
the whole of the claim and this is what it looks like from outside.

### Fail-closed, against a real Postgres error rather than a stub

§5b and §5d are argued against "a database this transaction cannot read". The
suite now makes that literal instead of handing the code a rejecting object: it
opens a real transaction on the live book, runs `SELECT 1 / 0` and swallows it,
after which Postgres answers every further statement with **25P02
`current_transaction_is_aborted`** — the driver's own `PostgresError`, with a
SQLSTATE, on the same connection that was about to write.

```
confirmPayee → PAYEE_BOOK_UNREADABLE
               check:  null        ← no check happened, which is not "a check that found nothing"
               saved:  null
               payee rows 0 · verification rows 0 · refusal rows 0
```

Both new tests were **made to fail first**. Restore the pre-2026-09-11
`.catch(() => [])` and `confirmPayee` comes back with a populated `PayeeCheck`
and the code `PAYEE_REFUSED` — a check reported for a probe that never ran,
which is the defect §5d is about. Restore `catch { return null }` on the
account-identity read and the gate test goes from a refusal to `undefined`,
which is a payment proceeding unchecked.

A `statement_timeout` was tried first and rejected: the payee book is one index
scan and it sometimes beats the clock, so the test would have been flaky in the
direction of passing — which is the worst direction a control test can be flaky
in.

---

## 10. The operator loop, fired for real on 2026-09-11

**WHERE THIS RAN, stated before anything else.** A production build of this
repository (`next build` then `next start`), against the **live Neon book** and
the **live Increase sandbox** — not against a fixture, and **not against
`corgi-trial-psi.vercel.app`**, which still serves the commit that predates §6a
and has no forms on `/payees`. Every id below is a row you can select today. The
POSTs went through the real server actions over their no-JS form encoding, which
is the same code path the browser drives.

Acting as **Priya Raman** (`b3c4f786-…`), the staff demo role — a named human
who cannot approve payments, which is the point: signing for a warning is not an
approval and deliberately requires no approval rights.

### Leg 1 — a payee the arithmetic refused, added from the form

Submitted `Fenwick Marine Supply LLC`, ACH, `011041533`, ••8801.

```
payee_candidate_refusal  8702f7d4-094c-421c-898e-dec3fafd37fc
  attempted_at  2026-09-11T15:35:38.928Z
  routing_number 011041533          ← as typed. Not normalised, not corrected
  code          ROUTING_CHECKSUM_FAILED
  reason        "The check digit does not hold: 3(d1+d4+d7) + 7(d2+d5+d8) +
                 (d3+d6+d9) = 76, which is 6 away from a multiple of ten. No
                 bank has this routing number. Swapping two adjacent digits
                 would give 011401533, which is the commonest way this happens.
                 Confirm against the payee's own paperwork rather than taking a
                 suggestion from us."
```

`SELECT count(*) FROM payee WHERE holder_name = 'Fenwick Marine Supply LLC'` →
**0**. A blocked candidate is not a payee. The sum is 76 exactly as §1 predicts
for that transposition, the transposition repair is named, and the nine
single-digit repairs are not.

### Leg 2 — a payee added, warned by the twin probe

Submitted `Northwind Industrial LLC`, ACH, `011401533`, ••7742, reference
`G2B-PROOF-TWIN-1`.

```
payee              ee3ae568-f210-4a30-9129-66da677f29f6
  display_name     "Northwind Industrial — ACH (console)"
  payee_key        console:payee:e274546d-…-cc839a7811f9:G2B-PROOF-TWIN-1
  created_by_name  Priya Raman
payee_verification b7c2fd1c-9a3e-4236-9ea7-a6a99ebc9db0
  outcome          warned
  directory        not_listed · increase.routing_numbers   ← a LIVE call
  evidence         live
  name_source      payer_asserted        ← nobody confirmed the name. §3
  findings         DIRECTORY_NOT_LISTED  note
                   NAME_NOT_VERIFIABLE   note
                   TWIN_WITH_DIFFERENT_DETAILS  warn
```

verbatim from `payee_verification.detail`:

```json
{ "code": "TWIN_WITH_DIFFERENT_DETAILS",
  "severity": "warn",
  "title": "You already pay someone by this name at a different account",
  "detail": "\"Northwind Industrial LLC\" is already on your payee book with 021000021
             routing and an account ending 3330 — different bank details for the same
             name. This is what a redirected-invoice fraud looks like from the inside,
             and it is also what a supplier changing bank looks like. Confirm the change
             by a channel you already had, not one from the email that asked for it." }
```

**The twin probe ran from a screen rather than from a test**, which is the
sentence §7 could not say this morning.

### Leg 3 — the signature, and the guard in front of it

First, a signature naming nothing:

```
POST … reason="Trying to wave this through without naming what it is."
      (no `code` field)
→ PAYEE_WARNING_MOVED
  payee_acknowledgement rows for this verification: 0
```

Then the real one:

```
payee_acknowledgement  12353dc0-4892-4fe0-bdbc-da6de91fbd3f
  verification_id      b7c2fd1c-9a3e-4236-9ea7-a6a99ebc9db0
  acknowledged_by      Priya Raman
  acknowledged_at      2026-09-11T15:36:41.497Z
  reason               "Northwind opened a second account for the industrial
                        division in August. Confirmed on the finance line from the
                        2025 master agreement, not the number in the remittance
                        email; spoke to K. Ozuna who read back the last four.
                        — signed for 1 finding on this check:
                        TWIN_WITH_DIFFERENT_DETAILS ("You already pay someone by
                        this name at a different account")."
```

The row names the human, the instant, the words, **and what the words were
about**. `v_payee_book.acknowledged` → `true`, `acknowledged_by_name` → Priya
Raman.

### Leg 4 — the refusal reaching the fix, end to end

A second warned payee, left unsigned: `3b2decf5-1f19-4664-9852-4e108a2dd3de`,
`Northwind Industrial LLC` ACH `011401533` ••7743.

```
POST /api/v1/payments   $1.00 ACH to that beneficiary
→ 422 PAYEE_WARNING_UNACKNOWLEDGED
  "The last check on "Northwind Industrial LLC", filed on your payee book as
   "Northwind Industrial — ACH loop proof", raised a warning that nobody has
   signed for. Open /payees?payee=3b2decf5-1f19-4664-9852-4e108a2dd3de&sign=1 —
   it shows that payee, what the check found, and the form that records why it
   is right to pay this account. …"
```

That URL was then opened **verbatim**. It rendered the payee, the finding, and a
signature form pre-addressed to verification
`accdf9a2-265e-43e3-8b3f-0064213c303d` offering exactly one code,
`TWIN_WITH_DIFFERENT_DETAILS`. Signed →
`payee_acknowledgement 5e6e3a72-caa1-4e44-a6a7-4a2681ec0b15`.

The same payment, re-sent:

```
→ 201 Created
  instruction 993f222a-fbb9-4be5-a60b-1a3c1a3ad748
  status      queued_for_human_approval
  money_moved false
```

**Refused → the message names an address → the address performs the remedy →
the same payment is accepted.** That is the loop that was open this morning.

### Leg 5 — the re-check, appending

Re-checked payee `ee3ae568-…` from the console:

```
payee_verification rows for this payee, oldest first
  b7c2fd1c-9a3e-4236-9ea7-a6a99ebc9db0  15:35:59  Priya Raman  warned  signatures 1
  effedc13-c626-4b23-8a5f-86ad9627419c  15:38:49  Priya Raman  warned  signatures 0

v_payee_book  outcome warned · acknowledged FALSE · acknowledged_by_name NULL
```

Two rows, nothing updated, the older one keeps its signature — **and the payee's
current standing is unsigned again**, because a signature answers a check and
not a beneficiary. A payment to it is refused until somebody signs the new one.
That is the behaviour §4's freshness argument implies and it is now observable.

### What was NOT proven here

* **Nothing was deployed.** These calls hit a local production build. The Vercel
  deployment is unchanged and still has no forms on `/payees`; §5e's note about
  the deployed commit still applies to it.
* **No name check was performed by anybody but us.** `name_source` is
  `payer_asserted` on every row above. §6a.7 says why, and the screen says so in
  those words.
* **No money moved.** Leg 4's instruction is queued and unreleased; nothing in
  `src/lib/payees` can write a journal line, and `payees.integration.test.ts`
  counts entries before and after a full confirmation to prove it.
