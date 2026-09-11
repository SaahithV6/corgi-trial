# The hold-model fuzzer

**What it is.** `src/lib/holds/fuzz.test.ts` and `src/lib/holds/fuzz-generators.ts`:
a property-based, seeded, shrinking fuzzer for `H(E)` — the card authorisation
hold in `src/lib/holds/model.ts`.

**Why it exists.** The brief's gauntlet item 2 says *"the hold releases exactly
once, no matter how strangely the sequence arrives"*, and item 4 says the
settlement webhook can arrive before the auth it belongs to. `model.ts` answers
both with one argument:

> `H` is built out of Σ, ∃, `max` and one clock comparison over a SET, and every
> one of those is invariant under permutation. That is the entire out-of-order
> story.

It is a genuinely good argument. Before this file it was supported by fifteen
hand-picked rows in `model.test.ts`. A function of a set is exactly what
property-based testing was invented for, so the claim is now attacked rather
than asserted.

---

## TL;DR — the result

| | |
| --- | --- |
| **Sets generated** | 25,720 per `pnpm test`; **1,286,000** on the deep run |
| **Orderings evaluated** | 98,611 per `pnpm test`; **6,257,911** on the deep run |
| **Prefix/invariant evaluations** | 55,036 per `pnpm test`; **2,763,725** on the deep run |
| **Runtime** | **0.6 s** default, **7.6 s** deep (`FUZZ_EXHAUSTIVE=1`) |
| **Live-book orderings** | 18, across 6 sets, ~50 webhook deliveries (`RUN_DB_TESTS=1`) |
| **Counterexamples to permutation invariance** | **ZERO.** |
| **Counterexamples found elsewhere** | **ONE** — FINDING 1, **fixed in migration 0028**. |

**The set-function claim survives.** Across 6.25 million orderings, `holdState()`
returned a byte-identical `HoldState` every time — not just `holdCents`, every
field. Nothing in `model.ts` needed changing for that, and nothing in `model.ts`
*was* changed.

**What did not survive is a claim one layer up.** `H(E)` is order-free; the
append-only `hold_closure` row that `apply.ts` wrote *on the way* was not,
because it was decided on a PREFIX and then made permanent. That is FINDING 1,
and migration 0028 fixed it by making the predicate that licenses the row out of
monotone arms only. The row is now as order-free as the number.

---

## FINDING 1 — terminal closure was not permanent — **FIXED, migration 0028**

> **Severity: real money.** A hold that is permanently released while the memo
> book still carries it. Same shape as the bug migration 0011 exists to repair.
>
> **Reported here, fixed in 0028.** This file was written under a *report it, do
> not fix it* brief — a property test tuned until it passes is worthless, and the
> owner of `model.ts` had to decide whether the failure was the model's or the
> test's. It was the model's. `A <= 0` moved out of `terminallyClosed` and stayed
> in `closed(E)`; `it.fails` became a plain `it`; the live book had **zero** wrong
> closures to repair. The sections below are kept in the past tense rather than
> deleted, because the diagnosis is the reusable part.

### The invariant that should hold

`apply.ts` step 5 writes `hold_closure` the moment `state.terminallyClosed` is
true. `hold_closure` is `PRIMARY KEY (hold_id)` and append-only; migration 0011's
preamble spends fifty lines on why that row cannot be unwritten. So
`terminallyClosed` must be **monotone**: true on a subset means true on every
superset. Otherwise a later event re-opens a hold that availability has already
given away.

### It is not monotone

```
terminallyClosed(E) = sawFinal ∨ sawClose ∨ expired ∨ (sawAuthorisation ∧ A ≤ 0)
                      \________________________/   \__________________________/
                          monotone (asserted)          NOT monotone
```

`sawFinal` and `sawClose` are `∃` over a growing set; `expired` does not read the
set at all. The fourth disjunct is a predicate on a **running total that can go
back up**.

### Witness A — the minimal one, and the reachable one

The shrinker took a forty-event set down to two:

```
E1 = { authorization 0 }                    A = 0, sawAuthorisation = true
                                            ⇒ terminallyClosed = TRUE
E2 = E1 ∪ { incremental_authorization 1 }   A = 1
                                            ⇒ terminallyClosed = FALSE, H = 1
```

**A `$0` authorisation is permanently closed the instant it arrives.** That is
not a synthetic shape: a `$0` auth is how card-on-file verification works, and
Lithic sends `AUTHORIZATION` with `amount: 0` followed by an
`AUTHORIZATION_ADVICE` carrying the real figure. When those arrive in one payload
the set is `{auth 0, incremental N}` and nothing goes wrong. When they arrive in
two deliveries — which is the ordinary case, and precisely the case the brief
tells you to survive — the first delivery writes a permanent closure.

`lithic-events.ts` already knows this hazard exists. It drops `BALANCE_INQUIRY`
with the comment:

> storing a zero-amount row in `card_auth_event` would put a member in `E` that
> changes `count(*)` (which the `A <= 0` closure test guards on) without changing
> any sum.

A genuine zero-amount `AUTHORIZATION` is not dropped, and it sets
`sawAuthorisation = true` as well as `count(*) = 1`.

### Witness B — the same defect with more steps

```
delivery 1,2 : { authorization 100, authorization_reversal 100 }
               A = 0 ⇒ terminallyClosed = TRUE, hold_closure written
delivery 3   : { incremental_authorization 1 }
               A = 1 ⇒ terminallyClosed = FALSE, H = 1
```

`model.test.ts` asserts that `{auth 10000, reversal 10000}` **is** terminal, and
on that set it is right to. The set with the late incremental in it is a
different set, and the row was already written.

### What it costs

1. `v_hold_state.is_released` reads the closure row first, so `active_hold_cents`
   is 0 and **availability stops withholding money that `H(E)` says is held**.
   The customer can spend it twice.
2. `settleHoldPosting()` then drives the memo balance back up to `H(E)`, so the
   hold is simultaneously *released* and *carrying money* — which is exactly the
   row shape `v_hold_release_drift` was added in migration 0011 to report. **The
   invariant view catches it; `v_hold_drift` does not**, because `v_hold_drift`
   is `WHERE NOT is_released` and a spurious closure excludes the row from it.
   That asymmetry is migration 0011's own central observation, playing out again.
3. On the `$0`-auth path the closure row is written with
   `closureReason() = "authorisation fully reversed"` — a false statement, in an
   append-only audit table, about an authorisation nobody reversed.

### Where the model's own reasoning already agrees

Migration 0011 declined to add a `C >= A` arm to `closed(E)` for exactly this
reason, in exactly these words:

> its only effect would be to write a PERMANENT closure row on a condition a
> later incremental authorisation can undo. That is the same mistake as the one
> being corrected above, and this migration exists because we have measured what
> it costs.

The `A <= 0` arm is a condition a later incremental authorisation can undo. The
reasoning was right; it was applied to one arm and not the other.

### The three candidate fixes, and the one that was taken

The options were narrow, and each had a cost worth stating rather than picking
silently:

- **Guard on a positive authorisation.** `sawAuthorisation` becomes "has seen a
  raise with `amountCents > 0`", and the arm becomes
  `sawPositiveAuthorisation ∧ A ≤ 0`. Kills witness A. Does **not** kill witness
  B — a later incremental can still raise `A` after a genuine full reversal. So
  it fixes the witness rather than the property, which is the worst of the three.
- **← TAKEN. Drop the `A ≤ 0` arm from `terminallyClosed` entirely** and close on
  `sawFinal ∨ sawClose ∨ expired` only. Monotone by construction. The cost is
  that a fully reversed authorisation's closure row now waits for the expiry
  sweep — which releases nothing extra, because `H` is already 0 and
  `v_card_auth_hold.is_closed` already says closed, so availability is already
  right. This is the option that makes the *stored* decision as order-free as the
  *computed* one, which is the property the design is arguing for.
- **Make the closure reversible in the live path**, i.e. have `apply.ts` write a
  `hold_closure_reversal` when a closed hold's `H(E)` goes positive again. The
  table already exists (0011) and nothing but a one-off repair script writes it.
  Correct, append-only, and the most machinery — and it needs `apply.ts`, which
  the second option does not touch at all.

### What was verified before the change was made

The claim that carried the decision is that the arm is **free**: `H` is already
0 wherever `A ≤ 0`, so moving it out of the permanent predicate cannot move a
customer's number. That was not taken on trust. It was run against this file's
own generators, at the deep scale, **before** `model.ts` was edited:

| | |
| --- | --- |
| Sets | 320,000 |
| Orderings | 5,118,851 |
| Prefixes | 16,199,101 |
| Sets where `H` changed | **0** |
| Sets where `closed(E)` changed | **0** |
| Sets where the new predicate failed to imply `closed` | **0** |
| Sets where the new predicate failed to imply `H = 0` | **0** |
| Non-monotone prefixes, new predicate | **0** |
| Non-monotone prefixes, old predicate | 141,209 |
| Sets that lose terminality | 11,236 |
| ...of those, any with `H > 0` | **0** |

The last two rows are the whole argument in two numbers: eleven thousand sets
stop being terminally closed, and **every one of them already held nothing and
was already `closed(E)`**. Nothing that stops being closed permanently was ever
withholding money.

The SQL needed no change, which was the other thing checked rather than assumed.
`v_card_auth_hold.is_closed`, `v_hold_state.is_released`, `ledger_availability()`
and `holdItemisationAsOf()` all express `closed(E)` — "withhold nothing now" —
and `closed(E)` keeps the arm. **`terminallyClosed` has no SQL counterpart and
never did**, which is exactly why it could be wrong in one place with nothing to
disagree with it. See migration 0028 §2.

### How this is recorded in the suite

- `it("FINDING 1, fixed — once terminallyClosed, no further event makes it false
  again")` — the invariant stated as it should hold. It was `it.fails` while the
  defect stood, and going **red the day `model.ts` was fixed** is what brought a
  human back to this file. Only the wrapper changed; the sweep, the shrinker and
  the failure message are the ones that found the bug.
- `it("FINDING 1 was EXACTLY the `A <= 0` arm — and 0028 removed exactly that
  arm")` — sweeps the corpus once and checks **two** predicates off the same
  `HoldState`: the current one, which must never un-fire, and `legacyTerminallyClosed()`,
  a local transcription of the pre-0028 predicate, which still must. The second
  half is not decoration: without it, the first would go green the day somebody
  narrowed the generator, and nothing would say so. At every legacy violation it
  still asserts that `sawFinal`, `sawClose` and `expired` were all false at the
  prefix that closed the hold — the one-line diagnosis — and now also that `H`
  was 0 and `closed(E)` was true there, which is the "it costs nothing" claim
  asserted per-set rather than only in aggregate.
- Two pinned witnesses with their exact numbers, readable without running
  anything, each now asserting **both** predicates: what the old one did, what
  the new one does, and that no money figure differs between them.
- `it("the other three arms ARE monotone")` — the complement, asserted rather
  than assumed. This is what makes "three arms, and only three" a measurement.

---

## Everything else: clean

| Property | Result |
| --- | --- |
| `holdState()` is identical under every one of the `n!` arrival orders | clean, exhaustive to 6! = 720 orderings per set |
| ...and under 120 random shuffles for sets of 7–14 events | clean |
| ...and when the whole set is re-delivered in a new order, twice over | clean |
| `holdState()` equals the formula documented in the `model.ts` header | clean (differential, against a second naive implementation) |
| `H ≥ 0` | clean |
| `closed(E) ⇒ H = 0` | clean |
| `¬closed(E) ⇒ H = max(A − C, 0)` | clean |
| Re-delivering any event at any position changes nothing | clean |
| `terminallyClosed ⇒ closed` | clean |
| `terminallyClosed ⇒ H = 0` | clean |
| `terminallyClosed` is monotone | **was FINDING 1** — clean since migration 0028 |
| ...and the PRE-0028 predicate still is not, on the same corpus | asserted, so the row above cannot go green by the corpus going quiet |
| `sawFinal` / `sawClose` / `expired` are monotone | clean |
| A negative magnitude is refused wherever in the order it sits | clean |
| Cents past 2⁵³ survive | clean — and the same figures collide as `number`, which is asserted |

### The one precondition, written down

Two events sharing a `providerEventId` but disagreeing about their contents make
`holdState()` **order-dependent**: first occurrence wins.

```ts
holdState([auth5000_id_x, clearing900_id_x]) → H = 5000
holdState([clearing900_id_x, auth5000_id_x]) → H = 0
```

This is not a bug and it is not fixed here. `UNIQUE (auth_id, provider_event_id)`
means `E` can never contain both — the second insert does not land. But it is the
single precondition the entire function-of-a-set argument rests on, so it is
asserted in the suite rather than left to be rediscovered: **the dedupe key must
be trusted, which is why it is a database constraint and not a convention.**

---

## How to run it

```bash
pnpm test                                   # 0.6 s, runs with everything else
FUZZ_EXHAUSTIVE=1 pnpm test                 # 50x the corpus, 7.6 s
set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test   # + the live-book property
```

Every corpus is deterministic from a seed. A failure prints the seed, the
original set, the **shrunk** set and the disagreement, so any counterexample is
reproducible by anyone holding the number. This is the real output from the run
that found FINDING 1, kept verbatim — the property it names passes now, so
reproducing it means restoring the `A ≤ 0` arm first:

```
PROPERTY VIOLATED: terminallyClosed is monotone under adding events to E
  seed: 5300024  (generateEventSet(5300024, ...))
  clock: now=2026-09-10T12:00:00.000Z expiresAt=2099-01-01T00:00:00.000Z
  original (8 events): { force_post 10000, authorization 0, ... }
  shrunk (2 events): {
    authorization 0 (s5300024-e1),
    incremental_authorization 1 (s5300024-e7)
  }
```

---

## How it is built

### `fuzz-generators.ts`

- **`makeRng(seed)`** — mulberry32. Thirty-two bits of state and no dependency,
  because a fuzzer whose randomness comes from `Math.random()` cannot print a
  seed, and a counterexample nobody can reproduce is a rumour.
- **`generateEventSet(seed, options)`** — one valid set. Every `card_event_kind`,
  weighted the way a card's life is weighted rather than uniformly. Amounts are
  drawn from a list the arithmetic is known to care about (`0`, `1`, the measured
  fuel-pump pair `5000`/`7340`, and `2⁵³+1`) plus a uniform tail. Exact
  redeliveries are generated at ~8%; the clock is generated already-expired at
  ~15%.

  "Valid" means non-negative magnitudes and honest duplicate ids, and nothing
  else. It deliberately does **not** generate lifecycles that make narrative
  sense — a reversal with no authorisation, three closes, a clearing for nine
  trillion cents are all fair game, because the model claims to be total over the
  set and a generator that only produces sensible histories only tests the
  sensible half.
- **`orderings(items, rng, budget)`** — every ordering when `n!` is affordable, a
  seeded sample when it is not. The sample always includes the identity and the
  exact reverse, because those are the two a human would have written and the one
  the brief names.
- **`shrink(events, stillFails)`** — Vitest ships no shrinker, so: drop each
  event in turn and keep the drop while the property still fails; then simplify
  what survives (amount down to `0`/`1`/`100`/half, `isFinal` off); then go round
  again until a whole pass changes nothing. Takes the forty-event
  counterexamples down to two or three, which is the difference between a bug
  report and a wall of text.

### `fuzz.test.ts`

The properties, plus:

- **A second implementation of the spec.** `referenceHold()` is the formula from
  the `model.ts` header transcribed as naively as it can be written — filter,
  sum, `some`, one `max`. It is not a better implementation and is not used for
  anything. It exists so the fuzzer has something to disagree *with*: the day the
  fold and the documentation part company, 3,000 sets per run notice.
- **A census.** `CENSUS` is accumulated by the properties themselves and pinned
  by the last test in the file. "I ran six million orderings" is only a real
  result if the number is real, and a future edit that quietly shrinks a corpus
  turns that test red instead of turning the fuzzer into a formality.
- **A budget.** 0.6 s at the default scale, because this runs on every
  `pnpm test` and a fuzzer nobody keeps is worth nothing. The deep run is behind
  `FUZZ_EXHAUSTIVE=1`.

---

## The live-book property (`RUN_DB_TESTS=1`)

Everything above is about a pure function, and a pure function is the easy half.
The last `describe` in the file delivers the same generated set through
`applyCardTransaction()` in three orders each — inbox, unique index, row lock,
financial postings, closure row, compare-and-append — against the real Neon book,
**one event per webhook**. One event per delivery is the only way to make
ordering real: Lithic's own payload carries the whole `events[]` array every
time, so a "clearing-first" delivery is a delivery that does not mention the
authorisation.

Then it asserts that all three orderings produced the same `HoldState`, the same
memo balance, a memo balance equal to `H(E)`, and that **both** halves of the
0011 invariant are empty — `v_hold_drift` (a live hold equals the fold over its
events) and `v_hold_release_drift` (a released hold is withholding nothing).

**Measured: 6 sets, 18 orderings, ~50 deliveries, ~60 s. All converged. Both
drift views empty, globally.**

Two notes on how it is set up, both deliberate:

- **The fixture is opened through the product.** The business row and its two KYB
  legs are written with the owner connection — they are operator facts the
  application role cannot forge — and then `openBusinessAccounts()` opens the
  chart, which goes through `business_accounts_open()`, which reads
  `v_business_kyb` itself and refuses a business that is not approved. So the
  fuzzer cannot open an account the product would have refused to open. It also
  means this suite writes **no** SQL against `account`, `journal_entry` or
  `journal_line`: `src/lib/ledger/boundary.test.ts` is a ratchet and a new file
  correctly has no allowance. The KYB legs are labelled `simulated` evidence from
  a provider named `simulated-hold-fuzzer`, which is what they are.
- **Sets that reproduce FINDING 1 are filtered out before anything is sent, and
  the filter is counted and asserted on.** This was not the property being tuned
  until it passes — the defect was already proved four ways in the pure suite. It
  was a refusal to corrupt a shared ledger to prove a point twice: reproducing
  FINDING 1 here wrote a permanent, wrong `hold_closure` row into an append-only
  table, and the only way back is a hand-written `hold_closure_reversal` (see
  `scripts/repair-0011-spurious-closures.mjs`, which exists because this happened
  once already, to three real holds, for $60).

  **Since migration 0028 the filter refuses nothing**, and it is kept anyway.
  `terminallyClosed` is now monotone, so a terminal prefix implies a terminal
  set, and terminal implies `H = 0` — `safeToDeliver()` cannot return false. The
  guard stays because the cost of being wrong about that is a permanent row in an
  append-only table on the SHARED book, not a red test, and because
  `filteredForFinding1` is counted and asserted: if it ever starts refusing
  again, the count says so out loud instead of the suite quietly delivering less.

  **To watch the old failure on a throwaway database:** restore the `A ≤ 0` arm
  to `terminallyClosed`, delete the `safeToDeliver()` guard, point
  `DATABASE_URL` at a scratch branch, and deliver `{AUTHORIZATION 0}` then
  `{AUTHORIZATION_ADVICE 5000}` as two separate payloads. `v_hold_release_drift`
  will report the hold, `v_hold_drift` will not, and `availableBalance()` will be
  $50 short of what `H(E)` says is held. With the arm gone, the same two
  deliveries leave both views empty and the hold correctly open at 5000.

---

## What this does not cover

Named so the gaps are chosen rather than implied:

- **The Lithic adapter's advice conversion.** `AUTHORIZATION_ADVICE` carries an
  absolute amount that `deriveCardEvents()` turns into a delta using the events
  preceding it *in the same payload*. The live-book generator therefore excludes
  it: splitting a payload one-event-per-delivery changes what an advice means,
  and that is a property of the adapter rather than of the hold model. Conflating
  the two would make the test unable to say which layer broke. `AUTHORIZATION_ADVICE`
  is still fuzzed in the pure suite, as `incremental_authorization` /
  `authorization_reversal`, which is what it becomes.
- **Corrections.** `RETURN_REVERSAL` and `CORRECTION_*` are classified
  `correction` in `rail_event_semantics` and take the reverse-and-rebook path at
  the *original* value date. Different property, own suite
  (`corrections.test.ts`).
- **Concurrency.** Two processors racing the same authorisation is asserted by
  `holds.integration.test.ts` scenario 7, not here. This fuzzer varies *arrival
  order*, not *interleaving*.
- **The clock as an axis.** `expired` is generated at two values (past and far
  future) rather than fuzzed continuously. It does not read the event set, so it
  cannot interact with ordering — which is the thing under test.
