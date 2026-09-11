# Statements — both time axes, on a screen

`/statements` answers one question about one value date, in the two ways the
brief demands they be answerable at the same instant:

> *"A merchant reverses Tuesday's settlement on Thursday. Tuesday's statement
> now shows the corrected position, and the system can still prove what it
> believed on Wednesday and when it learned the truth."*

- **as corrected** — what that value date closes at using everything we have
  learned. The reversal booked on Thursday counts towards Tuesday, because the
  reversal carries *Tuesday's* value date.
- **as believed** — what the same value date closed at read at an **earlier
  booking watermark**. What we would have told you then. When a document was
  issued at that watermark, this reading is labelled **as published** and
  carries the stored hash.

Both are `renderStatement(period, watermark)` — the same function, the same
rows, the same canonical form, the same hash — called twice with **one argument
changed**. That is the entire design:

```
value_date   chooses which business days count
booking_seq  chooses what we had learned by then
```

Hold the first still, move the second, and you get the two figures. Neither is
stored anywhere.

---

## What is on the screen, in order

The order of the page is the argument.

1. **Both readings, side by side** (`BothReadings.tsx`). Two equal columns —
   neither subordinate — with the **difference stated between them**, signed,
   never left to be subtracted by eye. Each column carries its **booking
   watermark** on its face, because a figure without its watermark is half a
   fact. Below the tiles, one line says whether the left-hand reading is a
   document somebody *issued* (`AS PUBLISHED`, with version, actor, issue time
   and whether the hash reproduced) or only a reading anybody can *reproduce*
   (`NOT PUBLISHED`, with the watermark it was read at). Directly beneath it,
   on the live screen only, is the way off this screen and into somebody
   else's inbox: **Download statement PDF** — see *The document* below.

2. **What corrected it, and when we learned** (`AsCorrectedPanel.tsx`), when
   the two differ. Grouped by `correction_group_id`, because *a reversal and
   its re-book are one act* and "why is that day different now" is a question
   about acts. Every posting shows **both columns of the bitemporal model on
   one row**: its value date (the corrected day itself) and its booking
   sequence and booking time (strictly later). The panel states the identity it
   depends on —

   ```
   as corrected − as believed = Σ (the acts listed)
   ```

   — and says whether it holds. When it does not, it says so in the negative
   colour rather than printing the delta and moving on.

3. **Nothing has corrected this day** (`StatementsView.tsx`), when they do not
   — which is the overwhelmingly common case, and a screen that only makes
   sense on corrected days is worse than one that reads well on both. The panel
   says the two columns are two *genuinely different queries* that happen to
   return the same number today, and what would have to happen for them not to.

4. **Why these figures cannot change** (`Reproducibility.tsx`). Each reading's
   watermark, line count, closing figure and **sha256 recomputed on this page
   load**. Both readings get a hash, not only the published one: reproducibility
   is a property of `(period, watermark)`, not of the act of publishing. On a
   published day the **stored** `statement` row is shown as a third line, so two
   numbers that must agree are both on the page, with `identical` or
   `DOES NOT MATCH` beside them.

5. **The two documents themselves**, so the figures are not asked to be
   believed. The as-corrected table shades and badges (`BOOKED LATER`) exactly
   the rows that landed above the left-hand watermark.

6. **Versions of this statement**, when any were issued. A correction produces a
   **new version**, never an edit; v1 stays byte-identical forever and v2 exists
   beside it.

---

---

## The document: a PDF an accountant can file

A statement that exists only inside a React screen cannot be forwarded to an
accountant, attached to a filing, or read by somebody who was not at the demo.
So the screen has a **Download statement PDF** button, and what comes out is
the same two readings — the same `renderStatement()` calls at the same two
watermarks, through the same `formatUsd` — serialised into the one format that
survives an inbox.

It is **generated from the ledger on the press**, never transcribed. The brief's
document rule is one line and it is absolute:

> *Documents must be generated from data, never hand-typed.*

### What is on the page, and why an accountant can tie it

An accountant's test is not aesthetic. It is *can I tie this to something*.
So the page prints **two identities**, each one computed in `bigint` cents at
render time and each one followed by the word `CHECKS` or `DOES NOT CHECK`:

```
opening balance  +  every movement (date, description, reference, booking seq)  =  closing balance
$21,059.55       +  $951.50 across 2 movements                                  =  $22,011.05

as published closing  +  every act booked above that watermark  =  as corrected closing
$22,011.05            +  $50.00                                 =  $22,061.05
```

The first is what any bank statement owes its reader. The second is the one no
ordinary statement has, because no ordinary statement is bitemporal — and it is
itemised act by act, each act carrying its value date, its booking sequence and
the instant we learned it.

Both readings' tables carry a running balance column, so the reader can add the
column down and land on the closing figure rather than being asked to believe
it. Rows on the as-corrected table that landed **after** the document went out
are shaded and marked `†`, with the footnote saying what that means: a later
booking time, the same value date, nothing edited.

### Both time axes, for a reader who has never heard the word

Above the figures, in plain words, before any number:

> **TWO DATES SIT ON EVERY ENTRY IN THIS LEDGER.** The value date is the day the
> money belongs to — here, Jul 25, 2026. The booking time is the moment we
> learned about it, which can be days later. Nothing is ever edited: when we
> learn something new about Jul 25, 2026, a new entry is appended carrying Jul
> 25, 2026's value date and today's booking time. So this page shows Jul 25,
> 2026 twice — as we reported it, and as we now know it — and lists what moved
> between.

Then the three figures as a band of equal weight: **as published**, the signed
**difference**, **as corrected**, each with its booking watermark on its face.
On a day nothing has corrected, the middle tile says `none` rather than `$0.00`
and a panel says what would have to happen for the two to differ — the document
has to read well on the three hundred and sixty-four days that were never
corrected, or nobody trusts it on the one that was.

### Byte-identical survived the new format

It did, and it is asserted rather than claimed.

`renderStatementPdf` is a **pure function of its input** — no clock, no random
source, no environment — and `src/lib/statements/pdf-writer.ts` is a
hand-rolled PDF 1.4 writer that refuses the four things which make a PDF
irreproducible:

| what usually varies | what this writer does |
| --- | --- |
| `/CreationDate`, `/ModDate` from the clock | **omitted entirely.** The document's own dates — value date, close, issue time — are content, drawn from immutable rows, and printed on the page |
| a random trailer `/ID` | **the document fingerprint**: sha256 over both readings' own content hashes and the watermarks they were taken at |
| embedded font **subsets**, whose bytes and subset tag vary by run | **nothing embedded.** The four standard Type1 faces (Helvetica, Helvetica-Bold, Courier, Courier-Bold) with `WinAnsiEncoding`; the AFM widths are in the source and are used only for truncation and right-alignment |
| deflate streams, whose bytes depend on the zlib build | **uncompressed.** A statement is kilobytes of text, and an uncompressed stream also means `strings file.pdf` shows an auditor every figure on the page |

Layout arithmetic is in **integer points** from the top-left, so no float
formatting can reach the file's bytes either.

The proof is run two ways:

- `src/lib/statements/pdf.test.ts` (unpriced, runs in CI) generates the same
  statement twice and compares the **bytes**, generates it again from a
  separately-constructed but structurally identical input, asserts the absence
  of `/CreationDate` and `/FontFile`, and walks the xref table checking that
  every object is at the byte offset it claims.
- `statements.integration.test.ts` presses the real button twice against the
  **live Neon book** — through `statementPdfAction`, the same entry point the
  screen uses — and compares the bytes. Measured on this book:

```
  STATEMENT PDF — live, generated twice
  file          statement-ridgeline-robotics-inc-2026-07-25-v1.pdf
  value date    2026-07-25
  watermarks    believed seq 508 · corrected seq 3053
  bytes         18798 both times, identical: true
  fingerprint   d915c9bc161d60b2460ebd63e87ae9af3517401c943546f6c440dd843cb46eb7
```

**The honest caveat, which is on the page and not only here.** The as-corrected
column is read at the *current* watermark, and that number moves whenever
anything is booked anywhere on the book. Two PDFs of the same day taken either
side of a card clearing are different documents — and they say so, because each
carries its watermark. What is guaranteed is exactly what has always been
guaranteed by this module: **fix both watermarks and the bytes are fixed.** The
fingerprint is a hash of the *content*, not of the file, so it stays meaningful
if the layout ever changes.

### Why a button and not `GET /statements/document.pdf`

A URL would be the nicer artefact. `src/components/home/ScreenLinks.test.ts`
walks `src/app` and requires every route this build serves to be either named on
the front door or written down as deliberately absent with a reason — a test
that exists because the front door once claimed to list every screen while
listing six of thirteen, leaving `/funding` unreachable from the only URL in a
submission email. A new route handler under `/statements/` fails that test until
the decision is recorded in `ScreenLinks.tsx`, which this module does not own.
Evading it — naming the file `route.tsx` so the walker misses it, or hiding it
under a group directory — would be defeating a completeness test on purpose.

So the document comes from a server action, which adds no route, breaks no test,
and still hands the reader the thing that actually matters: a PDF file they can
attach to an email. Promoting it to a route later is a four-line handler around
`renderStatementPdf` plus one entry on the front door.

### No new dependency

`package.json` is unchanged. `pdf-writer.ts` is ~380 lines and has no imports at
all; `pdf.ts` imports only `node:crypto`, the money formatter and the date
formatter. A PDF library would have been more code to audit, not less, and every
one of them defeats byte-stability by default.

---

## The anchor: where the left-hand column stands

`?as=` is URL state, like everything else on this screen. Four anchors,
resolved strongest-first when the URL names none, and **all four are always
shown** — the unavailable ones greyed, with the reason, because "no statement
was ever issued for this day" is a fact the reader needs and a missing chip
communicates nothing.

| anchor | watermark | available when |
| --- | --- | --- |
| `published` | the watermark a document was issued against | a statement exists for this account and day |
| `close` | the watermark `book_day` froze | the business day has been closed |
| `before` | the sequence before this day's **most recent** correcting act | the day carries a reversal or re-book |
| `now` | the live watermark | always; both readings become one reading |

### Why `before` exists, and why it is "most recent"

**Why it exists.** `src/lib/statements/screen.ts` answers for *(closed day,
published statement)*, which is the right shape for the customer-facing
document and the wrong shape for the scenario the brief actually describes. A
merchant reverses a settlement at 14:00 and the corrected position exists at
14:01, on a day nobody has signed off yet. A screen that could only show that
tomorrow would be a screen that cannot show the thing it is for. So **any value
date renders**, closed or not, and the screen names which anchor it used.

This is not a weaker claim. `(period, watermark)` reproduces forever whether or
not anybody issued a document at it, because every row at or below a watermark
is immutable and no row can appear below it later.

**Why the most recent correcting act, not the first.** "What did we believe
before the correction landed" is a question about the correction that *just*
landed. On a book with one correction a day the two readings of that phrase
coincide. On a demo book that has driven the same reversal twenty times,
anchoring at the first of them answers a question nobody asked and buries the
act being demonstrated under nineteen others — it showed a difference of
−$513.80 over 21 acts where the honest answer was −$73.40 over one.

A correction is an **act**, not an entry, so the anchor is placed before the
*first correcting entry of the last act* — never between a reversal and the
re-book that completes it. The act's own **original** is deliberately left
*below* the anchor: it is what we believed, and standing before it too would
net the whole episode to nothing and report zero for a day that was visibly
corrected. This is also exactly what `scripts/coreloop.mjs` leg 6 asserts
against — the balance read at the original entry's sequence, one instant before
its reversal.

---

## The five URL-driven states

| URL | what it shows | live? |
| --- | --- | --- |
| `/statements` | one value date, both readings | **live** |
| `?state=loading` | the real Suspense fallback, held open by a genuinely slow read | fixture |
| `?state=empty` | a day closed with no statement issued — both readings still answer | fixture |
| `?state=error` | the read failed; nothing moved, retry is live | fixture |
| `?state=edge` | **the corrected day itself** — the most recent value date this book reversed and re-booked | **live** |

`edge` is live on purpose. The edge state *is* the corrected day, and a
corrected day rendered from typed-in numbers would be the one thing on this
screen worth nothing. It resolves by rendering a bounded window of value dates
at the live watermark and taking the latest line whose `entry_type` is not
`original`. It falls back to the fixture only when there is no database or no
correction to find, and says `FIXTURE DATA` on its face when it does.

`loading`, `empty` and `error` stay fixtures because the two writes behind this
screen — closing a day, issuing a document — are **append-only and permanent**.
There is no undo to demo with.

Other URL state: `?account=<uuid>`, `?day=YYYY-MM-DD` (any value date, closed or
not), `?v=<n>` (which published version anchors the left-hand reading),
`?as=<anchor>`.

---

## Nothing on this screen is stored

`statement.closing_balance_cents` exists and is honest — a published figure has
to stay queryable exactly as published (DECISIONS 008) — but it is **not** what
the screen prints. The screen re-derives the document from the ledger and then
shows the stored figure *beside* it, so two numbers that must agree are both
visible. Printing only the stored one would prove nothing; printing only the
derived one would leave the stored one unexamined, which is how a stored figure
drifts for a year before anybody notices.

Money is `bigint` cents throughout `src/lib/statements/**`. The contract carries
`number` cents because these values cross to the client and `bigint` does not
survive JSON. There is exactly **one** narrowing site in the read path —
`toCents` in `src/app/(app)/statements/live-source.ts` — and it **refuses**
rather than rounds: a balance past `Number.MAX_SAFE_INTEGER` is a bug worth
crashing on, not a number to approximate on a customer's statement. Formatting
goes through `src/lib/format/money.ts`; there is no `/ 100` and no `toFixed`
anywhere on this path.

---

## Files

| file | what it is |
| --- | --- |
| `src/app/(app)/statements/page.tsx` | the route: parses URL state, picks live-or-fixture, holds the Suspense boundary |
| `src/app/(app)/statements/live-source.ts` | the live `StatementsScreenSource`: resolves account, value date and anchor, renders both documents, itemises the difference |
| `src/app/(app)/statements/actions.ts` | `statementPdfAction` — reads through the same loader the screen uses and returns the PDF. Writes nothing |
| `src/lib/statements/pdf.ts` | the statement laid out as a document: both readings, both identities, the acts between them |
| `src/lib/statements/pdf-writer.ts` | a dependency-free, byte-deterministic PDF 1.4 writer: standard fonts, no dates, no random id, no compression |
| `src/lib/statements/pdf.test.ts` | byte-identity, xref integrity, the two identities, and the `DOES NOT CHECK` path — all without a database |
| `src/components/statements/StatementPdfLink.tsx` | the button, carrying the screen's resolved account, day, version and anchor |
| `src/components/statements/data-contract.ts` | the seam — `BothReadingsView`, `ReadingView`, `AnchorOptionView`, `StatementsScreenSource` |
| `src/components/statements/screen-fixtures.ts` | the same screen without a database |
| `src/components/statements/BothReadings.tsx` | the headline: two figures, the difference, the publication status |
| `src/components/statements/AnchorPicker.tsx` | where the left column stands on the booking axis |
| `src/components/statements/AsCorrectedPanel.tsx` | what corrected it, grouped by act, and when we learned |
| `src/components/statements/Reproducibility.tsx` | watermarks, hashes, and why neither figure can change |
| `src/components/statements/StatementDocument.tsx` | a rendered document: opening, lines, closing, evidence strip |
| `src/components/statements/VersionHistory.tsx` | every version issued for this day |

The live source lives under `src/app/(app)/statements/` rather than in
`src/lib/` for the same reason `funding/live-source.ts` and
`payments/live-source.ts` do: those modules are owned by other workers on this
build. It therefore writes **no SQL of its own** — every read is a named reader
out of `src/lib/statements/read.ts`, `src/lib/statements/compare.ts`,
`src/lib/statements/publish.ts` or `src/lib/ledger/**`, which is also what keeps
`src/lib/ledger/boundary.test.ts` green. Composition, not a fifth definition of
a balance.

---

## The acceptance test

`scripts/coreloop.mjs` leg 6 drives a real Lithic `RETURN` and then a real
`RETURN_REVERSAL`, both as signed webhooks to the deployed endpoint, and then
fetches:

```
GET /statements?account=<deposit account>&day=<the original's value date>
```

It requires the rendered page to contain **both readings** and to **name the
booking watermark**. The day it asks for is *today* — the value date the
correction carries — and it is neither closed nor published, which is precisely
why the anchor falls back to `before` and why the screen has to be able to read
an open day at all.

A run against this book, with the correction that leg 6 had just produced:

```
Read as at     As published  —      At the close  —
               Before the correction  seq 1817     Everything we know  seq 1825

As believed    -$440.40   booking watermark 1817
Difference      -$73.40   accounted for, entry by entry, by 1 later act
As corrected   -$513.80   booking watermark 1825

NOT PUBLISHED  No statement has been issued for Sep 10, 2026, so there is no
               as published document to put on the left. The reading there is
               as believed: the same ledger, the same value date, read at
               booking watermark 1817.

What corrected it, and when we learned
  Correction · REVERSAL + RE-BOOK · group de779414
    Reversal of de779414-…: RETURN_REVERSAL 2e511486-… corrects it in full
    value date Sep 10, 2026 · booked at seq 1798 · reverses de779414
    learned Sep 10, 2026 · 22:53 ET                              -$73.40
```

and, on a day that *was* published (Ridgeline, 2026-07-25):

```
As published   $22,011.05  booking watermark 508   HASH REPRODUCED
Difference        +$50.00  accounted for by 6 later acts
As corrected   $22,061.05  booking watermark 1825
```

---

## Reproducibility, as an invariant rather than a design argument

*Added with migration 0059.*

Everything above describes a system that *can* reproduce a closed day's
statement. Until 0059 nothing **checked** that it still did. There was no
`v_statement_*` among the gated invariant views at all, and the whole of the
brief's item 7 —

> A closed day's statement is reproducible forever, corrections included,
> **identical every time.**

— rested on the design argument in `render.ts` and a fixture suite that built
its own day. This build keeps a catalogue of what happens to design arguments
nobody executes: 0012's view was unsatisfiable, 0026's excluded the bug it was
written for, 0028's could see 55% of its table, and each of the three shipped
with a paragraph explaining why it was fine.

The claim is now carried by **two halves that check different things**, because
neither is sufficient alone.

### Half one — the rows have not moved. `v_statement_content_drift`

Gated in `scripts/dbcheck.mjs` and mirrored in `src/lib/chaos/invariants.ts`,
so it runs on every `pnpm db:check` and appears on the `/chaos` board.

A published statement is a pure function of `(format, account, period,
watermark)` **only if the rows those inputs select are still exactly the rows
they selected on the day it was issued.** So for every row of `statement` —
all 62, the whole table, joined on a foreign key that cannot drop one — the
view re-derives three of the stored figures straight from `journal_line` at
that row's own watermark:

| stored | re-derived from |
| --- | --- |
| `opening_balance_cents` | `SUM` over `value_date < period_start`, at `booking_seq <= watermark` |
| `line_count` | `COUNT` over `value_date` inside the period, same watermark |
| `closing_balance_cents` | opening + `SUM` of those same lines |

These are the **same two rectangles `readAccountPeriod()` draws**, including
its deliberate asymmetry where the line query asserts `e.book = 'financial'`
and the opening query does not. The view reproduces that asymmetry rather than
tidying it: a guard drawing a *different* rectangle from the renderer is not
checking the renderer, it is disagreeing with it.

A fourth arm asks the question the first three cannot: two `statement` rows
sharing all four inputs and **disagreeing on `content_hash`** — a function that
is not a function. Its population on this book is zero groups today, because
every version pair sits at a different watermark (Ridgeline's four 2026-07-24
versions are at 485 / 487 / 498 / 502). That is stated in the migration rather
than discovered later, because a zero-population arm is
`v_standing_order_double_fire`'s defect *if it is the whole guard* — and it is
not: the three arms above it range over all 62.

**What it deliberately does not do is recompute the hash.** The canonical
rendering has exactly one definition and it is `src/lib/statements/render.ts`.
A second one in SQL — the netstring preimage, the field order, the
`STATEMENT_FORMAT` prefix — would live where no renderer change would ever
update it, and the two would agree until the day they silently did not. That is
the defect 0022 exists to have ended.

`dbcheck --prove` makes **both** shapes fire, each in a transaction that is
rolled back, and the two probes are built differently on purpose. The
disagreeing-hash arm is *first* in the `CASE`, so a probe that changed a figure
*and* the digest would trip that arm and never reach the re-derivation — it
would "prove" the wrong thing. So the figure probe reuses the **identical**
digest to keep the first arm quiet (`0 -> 1`, only the forged row fires), and
the hash probe changes **only** the digest (`0 -> 2`, because the arm is a
window over the whole group and reports every document in it — there is no way
to tell from outside which of the two is the forgery, and a guard that named
one would be guessing).

### Half two — the bytes are the same. `reproducibility.integration.test.ts`

`src/lib/statements/statements.integration.test.ts` proves the *mechanism* on a
day it builds: a synthetic 1980s day, closed inside a rolled-back transaction,
with the book mutated underneath a published v1. That is the right way to prove
a mechanism and it is not the claim the brief makes. "Forever" is a claim about
rows written weeks ago by code that has changed since.

So `src/lib/statements/reproducibility.integration.test.ts` takes **every
statement this book has actually issued**, re-derives it through
`renderStatement()`, and compares four things in this order:

1. **figures** — opening, closing, line count, watermark, against the row;
2. **ordering** — the `(value_date, booking_seq, ordinal)` sequence, as a list
   and not a count;
3. **the preimage** — `canonicalStatement()`, the netstring bytes themselves.
   This is the load-bearing one: two renders agreeing on a digest from
   different bytes is a sha256 collision, and it is the *other* direction this
   file is hunting;
4. **the hash** — `statementHash()` against the stored `content_hash`, with
   `statement.format` checked first, because a document under a different
   format version is a different artefact and must not be compared at all.

And it does it **twice, at two different instants**, through two separate round
trips — because "identical every time" is a claim about repetition and one
render cannot make it.

It **writes nothing.** No transaction, no rollback, no teardown, because every
call is a `SELECT`. A reproducibility suite that had to publish something in
order to check reproducibility would add a permanent row to an append-only book
on every run; that is how this book acquired 62 statements and 101 book days.

### Measured, on this book

```
  re-deriving 62 published statement(s); 59 of them contain at least one
  correction line (188 lines in all)

  correction group e397837a…: 3 entries at booking seqs 3915,3916,3917,
  net -7340 cents on account a0c41a37-… (Ridgeline Robotics, Inc.)

  2026-09-08 statement at watermark 3917: 87 line(s),
  closing 5101467 cents,
  hash a1d2f13fab28811e2508150952d07226a71c6ff90cfb927d47845870b2521db8
```

**Corrections included** is half the clause and it is asserted, not reported:
the suite fails if *no* published statement carries a correction line, because
a green tick over 62 quiet periods would say nothing about the half that was
asked for. 59 of the 62 do.

The named case has its own test. The Ridgeline **2026-09-08** correction —
group `e397837a…`, booking seqs **3915 / 3916 / 3917**, a wrong settlement, its
reversal and the re-book — is asserted to be *on* the rendered document (all
three seqs present, a `reversal` line present, a `rebook` line present), and
then the whole document is re-rendered and asserted byte-identical. The
corrected position and reproducibility are proved on the same day, in the same
test, which is the only way the clause means anything.

The last test in the file asks the database the same question the renderer just
answered: `v_statement_content_drift` is empty and `v_statement_rederived`
holds exactly as many rows as the suite compared. If those two ever disagree,
one of them is wrong — and the disagreement is the finding. That is why both
exist.
