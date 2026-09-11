# Time travel across the console

`?asOf=<date>&asKnownAt=<timestamp>` re-renders a screen at a point on **both**
axes of the bitemporal ledger.

```
asOf       VALUE   date — which business day we are asking about
asKnownAt  BOOKING time — what we had learned when we asked
```

They are independent. Holding one still and moving the other is the whole
demonstration: the same business day reads differently at two `asKnownAt`
values, because a correction posts at the **original** value date with a
strictly later booking sequence and never edits a row.

---

## The demonstration, on the live book

One account, one value date, two instants on the booking axis. Driven over HTTP
against the deployed schema on 2026-09-11:

| `asKnownAt` | watermark | closing for **1988-06-21** |
| --- | --- | --- |
| `2026-09-11T04:58:08.573Z` | 2680 | **$951.50** |
| `2026-09-11T04:58:08.647Z` | 2682 | **$1,001.50** |

```
/transactions?account=2eb04bde-236e-4c3a-b89f-657cc7dc61eb&asOf=1988-06-21&asKnownAt=2026-09-11T04:58:08.573Z
/transactions?account=2eb04bde-236e-4c3a-b89f-657cc7dc61eb&asOf=1988-06-21&asKnownAt=2026-09-11T04:58:08.647Z
```

Difference `+$50.00`, accounted for entry by entry by one act — correction group
`91d5a24f`, a reversal of `-$248.50` and a re-book of `+$198.50`, both value-dated
1988-06-21 and both booked in 2026.

The book is written to continuously by other workers, so those sequence numbers
move. `/transactions?state=edge` resolves the same demonstration **live**, off
whatever the most recent correction act is.

---

## What the cut is defined on

**The cut is `booking_seq`. It is never `booking_time`.**

`booking_seq` is the ledger's total order. `booking_time` is a stamp: it is what
a human can put in a URL, and it is nothing else. `asKnownAt` is resolved
**exactly once**, in `src/lib/timetravel/point.ts`, into a single `bigint`
watermark, and every downstream read filters `booking_seq <= watermark`. No
screen, component or reader below that line sees the timestamp as a predicate.

Two reasons, one structural and one measured.

**Structural.** `booking_time` does not order the book. Two entries may carry the
same stamp; nothing in the schema forbids it. A predicate on a non-total order
can include half of a tie with no total order to appeal to about which half.

**Measured.** `bookingWatermarkAt()` is `MAX(booking_seq) WHERE booking_time <= t`,
which is already tie-safe — `MAX` over a set selected by a time predicate takes a
whole tie or none of it. What it is *not* immune to is a **sequence inversion**:
an entry with a lower `booking_seq` and a later `booking_time`, which two
concurrent `ledger_append()`s can produce if one calls `nextval` first and stamps
`clock_timestamp()` second.

Measured against this book, twice, as it grew from 2,289 to 2,432 entries:

| fact | measured |
| --- | --- |
| `booking_seq` / `booking_time` inversions | **0** |
| entries sharing a `booking_time` | **0** |
| multi-entry transactions that are **non-contiguous** in `booking_seq` | **0** of 248 |
| widest single transaction | **27** booking positions |

So the two definitions coincide today. `prefixLeak()` checks the leak *at the
cut* on every travelled request — if the entry sitting at the watermark was
booked later than the instant asked about, the prefix contains something we had
not learned — and the screen reports it rather than the module assuming it away.
It renders nothing today, and would render something the day that changes.

### The one place the instant survives, and why it must

`LedgerSnapshot` carries three fields and only one of them is the cut:

```
valueDate         the VALUE axis    <- asOf
bookingWatermark  the BOOKING axis  <- asKnownAt, resolved to a sequence
asOf  (instant)   the hold-release clock
```

`accountAvailability()` evaluates the **hold release predicate** at
`snapshot.asOf`, because `hold_closure` carries `closed_at` and no booking
sequence — a hold closure is a fact whose only clock is a timestamp. So this
module sets `snapshot.asOf` to the **requested** `asKnownAt`.

That is the only coherent choice. `booking_seq <= watermark` and
`closed_at <= asKnownAt` are the *same cut* — "everything stamped at or before
this instant" — expressed on the two clocks the schema actually has. Using the
wall clock instead would evaluate today's closures against a past ledger.
Snapping down to the watermark entry's booking time would forget closures that
genuinely happened between the last posting and the instant asked about.

---

## The trap: a state that never existed

A correction produces a reversal and a re-book, both carrying the original value
date, both booked strictly later, at two different sequences and two different
timestamps:

```
seq 2681   reversal   value date 1988-06-21   booked 04:58:08.574Z
seq 2682   re-book    value date 1988-06-21   booked 04:58:08.646Z
```

Seventy-two milliseconds apart. The obvious reading is that for 72ms the book
contained the reversal and not the re-book, and that a cut in that window shows a
real, if awkward, historical state.

**That reading is wrong, and the measurement says so.** Both rows carry the same
`xmin`. Every one of the twelve most recent reversal → re-book pairs on this book
was written by **one transaction**:

```
reversal@2460 -> rebook@2461     1 transaction
reversal@2508 -> rebook@2509     1 transaction
reversal@2375 -> rebook@2376     1 transaction     ... 12 of 12
```

The gap is not a window of visibility. It is two `clock_timestamp()` calls inside
one transaction — the same phenomenon that produced the `readSnapshot()`/`now()`
defect in `docs/BALANCE-DEFINITIONS.md` §5. MVCC made the pair atomic. **No
reader could ever have observed the half-landed state, because it never
existed.**

### The invariant, stated precisely

The unit that must not be split is **the transaction**, not the correction group.
Those are different sets and the difference is the whole subtlety:

- an **original** and its later reversal are in **different** transactions, hours
  or days apart. Measured: **254 of 254** multi-entry correction groups span
  several transactions. That boundary was genuinely observable and **must** be
  crossable — standing between an original and its reversal *is* the feature.
- a **reversal** and its **re-book** are in the **same** transaction. That
  boundary was never observable and must **not** be crossable.

A rule phrased as *"never split a correction group"* would forbid the first and
destroy the feature. The rule is:

> **The cut must fall on a transaction boundary.**

### Snap down, never up

When a requested watermark falls inside an atomic write, it moves **down**, below
that write's first entry. Down is a derivation, not caution: `booking_time` is
stamped *during* the transaction, before it commits, so an instant between two
stamps of one transaction is an instant at which that transaction had not
committed — a reader standing there would have seen **none** of its entries.

Snapping **up** would answer a question about 04:58:08.575Z with the state of the
book at 04:58:08.646Z, silently. That invents knowledge, which is the one thing
an append-only bitemporal ledger exists to make impossible.

Live, `/transactions?state=edge`:

```
?asKnownAt= resolved to booking watermark 2681, which falls INSIDE an atomic
write. It was moved down 1 position to 2680, below the whole act.

91d5a24f — a reversal and its re-book were written by ONE transaction, 72ms
apart on the wall clock. Cutting between them would have shown seq 2681
without seq 2682 — the settlement reversed and nothing put back.
```

### What is proved, and what is not

| | |
| --- | --- |
| **Proved** | no correction act is split — exact, via `readCorrectionGroup`, for every act within 64 booking positions above the cut |
| **Not proved** | the cut falls on a transaction boundary *in general* |

The ledger records `booking_seq`, which totally orders entries, and records
**nothing** about which entries committed together. `xmin` is a system column and
reading it from outside `src/lib/ledger/**` would breach `boundary.test.ts`.

The residual gap is real and measurable: one transaction on this book wrote
**27 reversal entries at seqs 2474–2500**, and those 27 carry **27 different**
`correction_group_id`s. A cut at seq 2487 splits that transaction, shows 14
reversals without the other 13, and no reader available outside the ledger module
can see that it has done so.

`CutNotice` states this limit on the screen **every time**, not only when the
guard fires. The fix is one reader, named below.

The 64-position scan window is the measured worst-case transaction span (27) with
more than twice its own headroom, and every multi-entry transaction on this book
is contiguous in `booking_seq`, which is what makes a window scan sound.

---

## Which screens honour the parameters

| screen | `asOf` | `asKnownAt` | how |
| --- | --- | --- | --- |
| `/transactions` | **yes** | **yes** | built for it. Both readings, the acts between them, the identity checked, the postings at the cut, availability at the cut. |
| `/accounts` — deposit directory | **yes** | **yes** | `settledBalanceCents` and `accountAvailability` called with the travelled snapshot, beside the same value date at the live watermark. |
| `/accounts` — card & hold console | **no** | **no** | labelled **PINNED TO NOW** on its face. |
| `/statements` — the whole screen | **yes** | — | `asOf` is mapped onto the screen's own `?day=`. Same axis, two names. |
| `/statements` — the URL-point panel | **yes** | **yes** | its own panel, with its own watermark stated. |
| `/statements` — the four-anchor document | — | **no** | keeps `?as=`, which is a *stronger* control: four watermarks that have names. |
| `/accounts/[accountId]` | **no** | **no** | renders an explicit note when a point is asked for, and links to `/transactions`. |
| every other screen | **no** | **no** | no control shown, no claim made. |

### Why the ones that do not, do not

**`/accounts` card & hold console.** Its reads come from
`src/components/accounts/live-source.ts`, which takes its own `readSnapshot()`
internally and is owned by another worker. It cannot be handed a travelled
snapshot without editing a file this worker does not own.

There is a better reason too, and it is a principle rather than an excuse: **a
card is not a bitemporal fact.** It is provider state — it exists on Lithic, it
has a status Lithic owns, and there is no value date at which it was worth
anything. Travelling it would mean inventing an axis the fact does not have.
Balances and holds *are* ledger facts and travel exactly.

**`/accounts/[accountId]`.** Reads through `AccountDataSource`, whose live
implementation (`src/components/account/live-data-source.ts`) takes its own
snapshot internally and exposes no seam to inject one. Also another worker's.

**`/statements` four-anchor document.** `BelievedAnchor` is a closed type —
`published | close | before | now` — in
`src/components/statements/data-contract.ts`, another worker's file. Each of its
four positions is a watermark with a **name a reader can check**. An arbitrary
instant is not one of those four, and squeezing one in would mean either
mislabelling the left-hand column or snapping the reader's instant to the nearest
anchor and answering a different question. Both are false labels. So the
arbitrary instant gets its own reading, with its own watermark on its face,
above a document whose four anchors keep meaning exactly what they say.

> **A screen that ignores the parameter while showing a time-travel control is a
> lie.** Every screen above either honours both axes or says, in the product,
> which module holds it back and where to go instead.

---

## Refusing impossible coordinates

The house rule everywhere else on this console is that a malformed query
parameter falls back to the default — a 500 on a bad URL is a worse answer than
ignoring it. **That rule is inverted here, deliberately.**

Ignoring `?day=` shows you a different day and the day picker tells you.
Ignoring `?asKnownAt=` shows you **today's belief under a heading claiming it is
a past one**. The failure is a number, it is invisible, and the entire claim of
the screen is that the number is what we believed at that moment.

| coordinate | verdict |
| --- | --- |
| `asKnownAt` in the future | **refused** — `AS_KNOWN_AT_IN_FUTURE` |
| `asKnownAt` **before** `asOf` | **supported**, and labelled `foresight` |
| `asOf` in the future | **supported** — the book carries 2027 value dates |
| `asKnownAt` before the book's first entry | **supported** — watermark 0, and the screen says we knew nothing |
| `asOf` as a timestamp | **refused** — `AS_OF_MALFORMED` |
| a date that does not exist (`2026-02-30`) | **refused** — `AS_OF_NOT_A_DATE` |
| either axis outside 1900–2999 | **refused** — `*_OUT_OF_RANGE` |

**`asKnownAt` before `asOf` is supported.** "On Monday, what did we believe Friday
would close at?" is a coherent bitemporal question and this book has real content
for it: standing-order settlements are value-dated years ahead, so a belief held
in 2026 about a 2027 business day is a fact already booked, not a forecast. It is
the quadrant a reader is most likely to land in by accident, so it is **named** on
the screen rather than left to be assumed retrospective.

**A future `asKnownAt` is not.** There is no watermark for an instant that has
not happened; resolving one returns the live watermark and prints today's belief
under tomorrow's heading. Tolerance is 60 seconds, and it is a tolerance for
clock skew between two machines, not a window in which the future may be queried.

Refusals are produced by a **pure function**, so an impossible coordinate never
reaches a connection. Both parameters are checked even when the first fails, so a
URL with two problems reports two problems — fixing one and rediscovering the
other is how a reader concludes the feature is broken.

### Timestamp parsing

| input | read as |
| --- | --- |
| `2026-09-11T04:58:08.573Z` | explicit UTC |
| `2026-09-11T00:58:08-04:00` | explicit offset |
| `2026-09-11T00:58:08` | **banking time** (`America/New_York`) — a server zone is a deployment accident and must never change what a URL means |
| `2026-09-10` | the **end** of that banking day — "what did we believe on Tuesday" means at the close of Tuesday |

Sub-millisecond precision **truncates, never rounds**: the watermark is "at or
below", so truncating can only exclude an entry, never invent one.

`booking_time` is a Postgres `timestamptz` with **microsecond** precision and a JS
`Date` has milliseconds, so every landmark instant is offset one millisecond in
the safe direction. An `after` landmark at the raw truncated stamp resolves to
`booking_time <= floor(T)`, which **excludes the very entry it exists to
include** — that bug shipped, made the two readings identical, and was caught by
the integration suite against the live book rather than by reasoning.

---

## Default behaviour

With **neither** parameter present:

- `parseTimeTravelParams` reports `absent`
- `resolveTimePoint` returns `readSnapshot()` **verbatim** — the same function,
  the same single query, the same three values. It is not "equivalent to" the
  default path; it *is* the default path.
- on `/accounts` and `/statements` `resolveTimePoint` is **never called at all** —
  the `travelling` flag gates every time-travel component, so no extra query is
  issued and the data path is the one that was there before.

Pinned by `params.test.ts` ("absence — the default path", 4 cases, including
`?asOf=` empty-string and unrelated query state) and by
`timetravel.integration.test.ts` §1 against the live book.

**One honest exception.** `/accounts` gains a static `TimeTravelEntryPoint` aside
in the default state — the only route to `/transactions`, which is not in the
nav because `src/components/app-shell/NavLinks.tsx` belongs to another worker.
It issues **no query** and reads **no ledger**. Same queries, same numbers; one
added link.

---

## Disagreements found between existing readers

These are findings, reported rather than fixed — each is a decision with a
customer-facing consequence, in modules this worker does not own.

**1. Two readers answer "what did we believe" on two different axes.**

| caller | reader | axis |
| --- | --- | --- |
| `src/lib/disputes/store.ts:722` | `balanceAsBelieved(account, "9999-12-31", args.seq)` | a raw **booking sequence** |
| `src/lib/mcp/tool-get-balance.ts:177` | `bookingWatermarkAt(new Date(bookingTime))` | a **timestamp**, converted |

Both are defensible and they are not the same question. The sequence path is
exact and unreachable from a URL; the timestamp path is expressible and inherits
every property of `MAX(booking_seq) WHERE booking_time <= t`. Neither says which
it is in its name.

**2. Three readers compute "what was withheld at a past point", and they
disagree.**

| reader | ledger cut | hold-release cut | `manual` holds | pending outbound |
| --- | --- | --- | --- | --- |
| `accountAvailability` | `booking_seq` | **instant** (`snapshot.asOf`) | counted | subtracted |
| `heldCentsAsBelieved` | `booking_seq` | none — no predicate at all | n/a | n/a |
| `holdItemisationAsOf` | `booking_seq` | **instant** (`closureCutoff`) | **dropped** | **absent** |

`readers.ts` already documents the third as "a second definition" in its own
header, at length and honestly. The finding worth adding is the *shape*: the
canonical `accountAvailability` is itself a **mixed cut** — the ledger term is
cut on a sequence and the hold-release predicate on an instant. That is correct
and necessary (see above), but it means a caller who derives the snapshot's two
fields independently gets two cuts that need not agree. This feature derives both
from **one** resolution step, which is why they do.

**3. `listLedgerLines` has no "at or below" bound.**

`LedgerLineFilter.bookingSeqBelow` is **strict** (`<`), because it is a keyset
cursor. A watermark is `<=`. Every caller wanting a watermark must pass
`watermark + 1n`, which is exact for integers and reads like a fence-post error
at every call site.

---

## What is missing — readers that belong in `src/lib/ledger/`

Reported rather than reached around; `src/lib/ledger/boundary.test.ts` is a
ratchet and this feature adds **zero** references to it.

| reader | what it would fix |
| --- | --- |
| `writeBatchOf(seq)` — or a real `write_batch_id` column | closes the residual above **completely**. With the atomic write recorded, the cut could be proved to fall on a transaction boundary instead of only outside correction acts. This is the one that matters. |
| `bookingSeqInversionCount()` | lets the screen assert 0 inversions live instead of quoting a measurement taken by script |
| `LedgerLineFilter.bookingSeqAtOrBelow` | removes the `watermark + 1n` fence-post from every caller |
| `LedgerLineFilter.bookingSeqAbove` | makes the straddle scan one bounded query instead of a window plus client-side filtering |
| `mostActiveDepositAccountId` forwarded from `queries.ts` | it lives in `readers.ts` and is not on the forwarding surface, so callers import it by path |

---

## Files

| file | what it is |
| --- | --- |
| `src/lib/timetravel/params.ts` | parse and **validate** both axes. Pure — no database, no clock read. |
| `src/lib/timetravel/clock.ts` | what "now" means for a request. Injected, never read at the point of use. |
| `src/lib/timetravel/integrity.ts` | the cut's safety rule and the straddle detector |
| `src/lib/timetravel/point.ts` | the two coordinates resolved into a `LedgerSnapshot` |
| `src/lib/timetravel/read.ts` | one account at that point, composed from named readers |
| `src/lib/timetravel/landmarks.ts` | the instants on the booking axis worth standing at |
| `src/components/timetravel/TimeTravelBar.tsx` | the control — two rows, one per axis |
| `src/components/timetravel/BookingAxis.tsx` | the cut drawn through the booking axis |
| `src/components/timetravel/CutNotice.tsx` | the guard, announced; and the limit of the guarantee, always |
| `src/components/timetravel/Refusal.tsx` | impossible coordinates, with the reason |
| `src/components/timetravel/TransactionsView.tsx` | the screen |
| `src/app/(app)/transactions/**` | the route and its live source |
| `src/app/(app)/accounts/time-travel.tsx` | the travelled directory and the PINNED TO NOW label |
| `src/app/(app)/statements/time-travel.tsx` | the URL-point panel |

### Why the control is two rows and not a slider

The proposal asked for a slider. A slider is the wrong instrument here, for a
measured reason: the booking axis of this book is a few hours long and almost all
of it is identical, because nothing about a business day changes except at the
instants something was learned about it. Dragging uniformly shows one number,
then the same number, then the same number, and a reader concludes the parameter
does nothing.

The information is **concentrated at a handful of points**. So the booking row
offers those points — taken live off the account's own correction acts, three per
act — and clicking them in order with the value axis held still is the
demonstration the slider was supposed to deliver.

Every control is a `<Link>`. No client component, no local state, no form. A
screenshot of any state carries the URL that reproduces it.

---

## Tests

| suite | what it pins | credentials |
| --- | --- | --- |
| `params.test.ts` | 29 cases: absence, both axes, refusals, banking-day arithmetic, link building | none |
| `integrity.test.ts` | 11 cases: the straddle rule, including that a cut **between an original and its correction is allowed** | none |
| `timetravel.integration.test.ts` | 11 cases against the live book: default unchanged, the day reading differently at two instants, the identity, the value axis held still, the guard firing, the refusals. **11 of 11 green, 2026-09-11 12:55Z** | `RUN_DB_TESTS=1` |

Every integration assertion is a **relation between two readings**, never a fixed
figure. Twelve workers write to this book while the suite runs; a test asserting
`$1,001.50` would be red by the time it was committed.

### Holding the value axis still — and the constant that was not a relation

That rule had one exception and it cost a red for three hours. The case
*"holds the value axis still"* read:

```ts
// A value date years before the act's own. The correction carries the
// ORIGINAL value date, so it cannot reach a day before it.
const other = "1979-01-02";
expect(await closingAt(before.at)).toBe(await closingAt(after.at));
```

`1979-01-02` is a fixed figure, and the sentence above it is a claim about a
book nobody was holding still. It failed by **exactly 1,234 cents on every
run** for two independent reasons, both of them the same reason:

1. **`bestDemonstration()` is live.** It returns the most recent correction act
   on any deposit account, and it was returning one value-dated **1956-09-24**
   — planted by `src/lib/recon/planted-break.test.ts`, which was committing
   centuries-backdated settlements to this book (`docs/TESTING.md` has the
   whole measurement; it is wrapped now). 1979 is *after* 1956, so the act's
   own reversal and re-book were inside the very figure the case asserted could
   not contain them. A constant cannot be "years before" a date chosen at read
   time. 1,234 is `MISMATCH_DELTA` in that suite, to the cent.
2. **A closing balance is cumulative.** It is every value date at or below the
   one asked for, so *any* writer booking below it moves the figure. An
   equality between two absolute readings on a shared book is a bet.

The repair is the one `src/test/livefire/README.md` §1 settled on — *never
widen a tolerance to absorb another writer; isolate, or take a delta* — and it
makes the case assert **more** than it did:

* the comparison day is `dayBefore(act.valueDate)`, **derived from the act**,
  so "a day below the act's own" is true by construction rather than by luck;
* the entries that landed between the two cuts are listed, and the assertion is
  that **none of them belongs to the act** — by `entryId` and by
  `correctionGroupId`, which is the claim in its own terms rather than as a
  number;
* the arithmetic is closed exactly: `closing(after) − closing(before)` must
  equal the net of those entries. On a quiet book that set is empty, the net is
  `0n`, and the original equality comes back as a **corollary** instead of a
  premise. Another worker's posting is cancelled arithmetically, never
  absorbed by a tolerance.

Proven to still have teeth rather than assumed to: pointing `other` at the
act's own value date instead of the day below it turns the case red with
`expected [ …(2) ] to deeply equal []` — the act's two correcting entries,
named.

### What `?state=edge` was showing, and why it is not filtered

While the planting was running, `bestDemonstration()` — and therefore
`/transactions?state=edge`, the flagship demonstration on this console — was
resolving to correction group `4da141c3`, *"Planted settlement
PLANT-MTWVSLD39…"*, value date **1956-09-24**. A reviewer opening the edge case
was shown a test fixture presented as the book's most recent correction.

`landmarks.ts` is deliberately **not** changed to skip it. A demonstration that
is live is live, and one that quietly drops the rows it finds embarrassing is
the thing this whole feature exists to argue against. The planting has stopped,
so the next real correction act overtakes it on `booking_seq` and the screen
heals itself. The rows stay visible, and
`db/migrations/0047_value_date_sanity.sql` is what makes them *legible* rather
than invisible: `v_value_date_out_of_band` names the file behind every one of
them, and `v_value_date_unexplained` — invariant twenty-six — is the first
guard this ledger has ever had on the value axis.
