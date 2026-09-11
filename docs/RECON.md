# The reconciliation break that explains itself

`/breaks` — `docs/REMAINING.md` §4.3.

`/reconciliation` answers *what does not match*. `/breaks` answers *and why*,
by reconstructing the causal history of a discrepancy out of immutable journal
rows and showing both of the system's time axes for every step.

This document states the four things somebody should be able to argue with:
how the screen tells an explainable break from a real one, what that test could
wrongly suppress, which axis each class is aged on and why, and what it found
in the existing engine while being built.

---

## 1. The one rule everything else is subordinate to

> **Explainable is not resolved, and a classification may change how a break is
> DISPLAYED but never whether it is COUNTED.**

The screen is a second *reading* of the same breaks, never a second *list*. It
calls `readBreaks()` — the one diff, `v_recon_break` in
`db/migrations/0006_recon.sql` — and adds a class, a timeline and an axis
decision. It cannot remove a row:

```
rows.length === readBreaks({ fileId }).length     always
```

That is asserted three ways: as a property over a generated matrix of inputs in
`src/lib/recon/explain.test.ts`, against the live database in
`src/lib/recon/explain-live.test.ts`, and on the screen itself, which prints
*"Showing n of m. The engine reported m; this screen classifies them and hides
none."* under every table.

There is **no default filter**, no "hide explained" toggle and no severity
floor. A screen whose default view is a subset teaches people that the subset
is the whole, and "explained rows are collapsed by default" is precisely how an
explainable break becomes a suppressed one.

---

## 2. How an explainable break is told from a real one

`src/lib/recon/explain.ts` → `classifyCorrection`. Four classes.

| Class | Test | Reads as answered? |
|---|---|---|
| `not_a_correction` | no `reversal` entry in the group | only via a human adjudication note |
| `correction_open` | a `reversal`, and no `rebook` | **no** |
| `correction_closed` | a `reversal` **and** a `rebook`, **and** a file side exists, **and** `ledgerNet === fileAmount` exactly, in cents | yes |
| `correction_residual` | a `reversal` and a `rebook`, and any of the above fails | **no** |

Four things in that table are load-bearing.

**The test is the presence of a `reversal` entry, not a row count.** A group of
more than one entry is not evidence of a correction. Inferring an explanation
from `entries.length > 1` would mean any two postings sharing a correction
group id could launder each other.

**Exact equality, no tolerance band.** A one-cent rounding rule is also a
one-cent theft rule. A re-book that lands a penny out stays in
`correction_residual`, keeps the full severity ladder, and is worked like any
other break.

**No file side means it can never close.** An `in_ledger_not_file` break is the
provider omitting the reference entirely, and a correction cannot explain an
omission however tidy the group behind it is.

**The engine's own `reversal_and_rebook` flag is dropped, not trusted.** If
`v_recon_break` says a break was corrected and this module reads the correction
group and finds no reversal in it, the two disagree — and a disagreement about
whether money is explained resolves to the louder answer, every time. The one
verdict that IS inherited is `adjudicated`, because that is a person's
signature on a `recon_break_note` and not an inference this module is in a
position to second-guess.

### What this test could wrongly suppress

Written down because the instruction was to write it down, and because each of
these is a real limit rather than a hedge.

- **`correction_closed` is the only class that reads as answered, and it can be
  reached for the wrong reason.** Two offsetting errors that happen to net to
  the provider's figure are indistinguishable, by any amount check, from a
  correct re-book. The screen states this on the drill-through, in the panel
  titled *"What believing this classification could hide"*. Closing that gap
  needs the re-book's own provenance — which provider event produced it —
  compared against the original's, and that is not built.
- **`correction_open` follows `correction_group_id`, not intent.** A re-book
  posted under a different reference, or as a fresh group, leaves the original
  group looking incomplete. That error is in the safe direction: it over-reports.
- **`not_a_correction` over-reports by construction.** Everything that is not
  provably a correction lands there. Nothing is excluded.
- **`correction_residual` suppresses nothing at all.** It exists so that
  *"there is a correction group here"* can never be read as *"this is handled"*.

Every class carries its own risk sentence as a field —
`CORRECTION_CLASS_EXCLUSION_RISK` — and the screen renders it. A classification
that cannot state its own blind spot is an opinion wearing a badge.

---

## 3. Which axis each class is aged on

The brief's question: a break we learned about this morning concerning a
settlement three weeks ago — is it three weeks old?

It depends on what the age is *for*, and the answer differs by class. The
severity ladder itself is untouched: there is exactly one, `severityOf` in
`src/lib/recon/aging.ts`, and this feature only chooses which facts to feed it.

| Class | Axis | Because |
|---|---|---|
| `not_a_correction` | **value date** | the age measures EXPOSURE — how long the book has been wrong. A settlement three weeks ago that we never booked has been missing from three weeks of balances and, the part that bites, every statement issued for those days. Learning about it this morning does not make three weeks of wrong statements younger. This is the existing `v_recon_break.age_days` behaviour, unchanged, because it was already right. |
| `correction_open` | **when we learned** | the age measures an OPEN OPERATIONAL ITEM. A reversal carries its original's value date — that is the whole bitemporal design — so aging it on the value axis reads the age of the *settlement* and prints it as the age of the *correction*. A three-week-old settlement reversed ten minutes ago would render `31+`, `critical`, three closes crossed, and sit above genuine month-old breaks. Within a week an operator learns the top of the screen is noise. That is how a breaks screen dies. |
| `correction_closed` | **when we learned** | this row is the record of something already fixed; the only question left is how recently it was fixed. |
| `correction_residual` | **value date** | the trap. A correction group exists, so *"it is fresh, we just learned"* is available — and it is wrong. The remainder has been missing since the business day and the correction did not touch it. |

The converse case is why the booking axis is not cosmetic: **a reversal posted a
fortnight ago whose re-book never arrived is a real, aging operational
failure.** On the value axis it is indistinguishable from the settlement's own
age; on the booking axis it climbs the ladder close by close, exactly as it
should. `explain.test.ts` asserts both directions.

`correction_residual` is the single most important line in the module. It is
the one place where a plausible generalisation — *"correction groups age on the
booking axis"* — would have quietly downgraded a live break.

**Both axes are always carried on every row**, and the drill-through prints the
one it did *not* use, marked "not used", beside the one it did. The number the
screen chose not to use is exactly the number somebody will ask about, and
*"why does this say today when the settlement was three weeks ago"* has to be
answerable from the screen.

### How the booking axis is measured

In Postgres, in `src/lib/recon/explain-read.ts` → `readBookingAxis`, one round
trip for the whole page:

```sql
(book_date(now()) - book_date(t.at))::integer                     AS age_days
(SELECT count(*) FROM book_day bd WHERE bd.closed_at >= t.at)     AS closes_crossed
```

`book_date()` is the book's own calendar function (`America/New_York`,
`0001_ledger.sql`) and `book_day` is the close log the existing ladder already
counts. Re-implementing either in TypeScript would give the screen a second
opinion about what day it is. The one place TypeScript does compute a book date
— `bookDateOf`, for the per-step backdating badge — uses `BANKING_TIME_ZONE`,
the same literal, exported once.

**A measurement caveat, on seeded data.** `closes_crossed` on the booking axis
counts `book_day` rows whose `closed_at` is at or after the instant we learned.
`seedReconDemo` back-fills 46 business days in one pass, so every one of those
rows carries a `closed_at` of the seed moment. An entry booked before that pass
therefore shows several closes "since we learned" even when it was booked
today. The count is literally correct — those closes were signed off after the
booking — and it is surprising on demo data. It is not surprising on a book
whose days were closed as they happened.

---

## 4. What this found in the existing engine

### 4.1 Corrections the breaks screen cannot see

`v_recon_pair` matches the file against the correction group's **anchor** entry
— the earliest booking, *"what we had booked when the provider produced the
file"*. That is the right anchor for the question the diff asks, and
`0006_recon.sql` defends it well. It has a consequence nobody had written down.

Take a settlement the file reports at $309.59 that we booked at $309.59 and
later reversed and re-booked at $259.59:

```
file 30959  ==  anchor 30959     ->  exact_ref, matched, NO BREAK
group net   ==  25959            ->  the book and the file are $50.00 apart
```

The reconciliation reports the file clean while our position on that reference
is fifty dollars below the provider's. It is the *same* $50.00 that **does**
surface, as an explained amount mismatch, when the provider re-issues the file
at the corrected figure. Which of the two an operator sees depends entirely on
whether the provider happened to restate the row — and the version that reports
clean is precisely the version where our book has moved away from the file.

Measured on this database: **two such rows on
`achsim-settlement-2026-09-10.csv` (run `79b520b6-…`, #22), $50.00 each, $100.00
invisible to the existing breaks screen.**

| reference | file row | file | group nets to | drift | group |
|---|---|---|---|---|---|
| `260570540744811` | `be14a3ca-8a48-4d41-8af0-d848fd627ec2` | $309.59 | $259.59 | $50.00 | `7885c140-73b3-4e55-ba0f-98ba7436fdad` |
| `450306155602447` | `7aa24a08-5ad8-4fe5-82fe-2760bcd7c0a6` | $309.59 | $259.59 | $50.00 | `ca993e63-18b7-42eb-951d-5009f04138b7` |

This is an exclusion shaped exactly like the thing it should catch, so it is
**surfaced rather than fixed**: `readSilentCorrections` in `explain-read.ts`,
rendered in its own panel headed *"Corrections the file has not caught up
with"*, explicitly labelled as advisory and **not** a break kind.

Why not a fourth break kind: `BREAK_KINDS` is three, the three are exhaustive
over the ways a file and a book can disagree once matching is by reference, and
`v_recon_break`, `recon_run_break.break_kind` and `recon_break_note.break_kind`
all CHECK the same three strings. Adding a fourth would change the audit
vocabulary, every frozen run snapshot, and four other branches' expectations,
to fix what is a display problem. The right fix is a decision for whoever owns
`0006_recon.sql`, with the evidence now on a screen rather than in a month-end
surprise.

**What this query could hide: nothing that was previously reported.** It is
strictly additive — it removes no row from any break list and changes no count.
What it can *miss* is the mirror case where a group's earliest rail-facing entry
is not the original, which `reverseAndRebook` cannot produce; such a row would
still be an ordinary amount mismatch.

### 4.2 A deep link to a run outside the first page resolved to "nothing reconciled"

`listRuns` orders by business date and takes a `LIMIT`, which is right for a
history panel and wrong for a URL. A live-fire attack's synthetic business date
(`2027-12-02`) sorts above everything real, so `?run=<uuid>` for anything older
fell through to the empty state. Fixed for this screen by `readRunById` in
`explain-read.ts`, which resolves any run id `v_recon_run_history` holds.
`src/lib/recon/screen.ts` has the same shape and is not changed here — it is on
`/reconciliation`'s path and another branch owns that screen's behaviour.

### 4.3 No incomplete correction group can currently surface as a live break

This book holds **ten** correction groups with a reversal and no re-book. They
are real: live-fire attack 3 drives a `CORRECTION_CREDIT` from the provider end
against a real Lithic card clearing, and the resulting reversal has no re-book
because the clearing was corrected in full. They are all on the **card** rail.

`v_recon_ledger_group` joins `scheme_file` on rail and business date, so the
reconciliation can only see a correction group that falls on an **imported
settlement file** — and no card settlement file has ever been imported. Every
genuinely incomplete correction in this book is therefore invisible to
reconciliation, not because the classifier cannot describe it but because no
file brings it into scope.

Measured, not assumed:

```sql
SELECT count(*) FROM v_recon_ledger_group WHERE has_reversal AND NOT has_rebook;
-- 0
```

That is why `?state=edge` is a fixture, and the fixture says so on the screen.
It uses the real entry ids, booking sequences, amounts and descriptions of
group `1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7`; it moves their dates apart,
because in the real run the reversal landed four seconds after the clearing and
the state exists to show two axes disagreeing; and the settlement file beside
them is invented. All three of those distinctions are printed under the fixture
banner. Nothing was imported and nothing was posted to manufacture a demo.

**The week-two fix** is a card settlement file — a Lithic-shaped simulator
already exists for the ACH rail in `src/lib/recon/simulate.ts` — at which point
this state is live and this paragraph goes away.

---

## 5. What is on the screen

Five URL states, house standard:

| URL | State |
|---|---|
| `/breaks` | last night's file, classified, **live from the ledger** |
| `/breaks?state=loading` | the real skeleton, held open by a genuinely slow read |
| `/breaks?state=empty` | a file that reconciled clean, with nothing to explain |
| `/breaks?state=error` | the read failed; nothing moved, retry is live |
| `/breaks?state=edge` | **a break whose correction group is incomplete** |

Plus `?kind=`, `?class=`, `?run=<uuid>` and `?break=<kind>:<key>`, all of which
are deep-linkable and survive a reload.

The edge state is the incomplete group because it is the state where every
signal points at "explained" — there IS a correction group, the system CAN
narrate it end to end — and the money is still missing. A screen that gets that
state wrong has taught its users that a timeline means a closed ticket.

### The timeline

A table, not a drawn rail, because **the axes are the content**. A horizontal
timeline with three dots on it must choose one axis to lay out against, and
whichever it chose would be the claim this screen exists to complicate. The
table gives both columns equal weight, aligns the money, reads correctly in a
screen reader, and can be pasted into a ticket.

Columns: step · value date (*when it happened*) · booked (*when we learned*,
with the booking sequence) · effect on the rail · the group's running net. The
reversal row carries a **backdated Nd** badge — the distance between its two
axes — and a zero gap renders nothing, because a badge on every row would drain
the meaning from the one that matters.

### Money

`bigint` cents throughout `src/lib/recon/**`, narrowed to `number` cents exactly
once per module (`toCents`, which refuses rather than rounds), rendered through
`src/components/ui/Money.tsx` → `src/lib/format/money.ts`. There is no division
anywhere on this path: grepping these files for `/ 100` and `toFixed` returns
exactly one hit, and it is the sentence in `explain-contract.ts` promising
there are none. The only arithmetic in the pure layer is `+` and `-` on
`bigint`; the only arithmetic in the components is `Math.abs` and `+` over
integer cents, in the class tiles.

---

## 6. Where the code lives

| File | What it is |
|---|---|
| `src/lib/recon/explain.ts` | pure: the classifier, the residual, the timeline, the axis decision. No connection, no clock, no `server-only`. |
| `src/lib/recon/explain-read.ts` | the three reads: correction groups reduced to rail-facing facts, the booking axis, the silent-correction list. Plus `readRunById`. |
| `src/lib/recon/explained-view.ts` | composes them into the screen's contract and narrows `bigint` once. |
| `src/lib/recon/explain.test.ts` | 35 tests, no database. Includes the safety property over a generated matrix. |
| `src/lib/recon/explain-live.test.ts` | 8 tests against the live book, **read-only**. Skips with no `APP_DATABASE_URL`. |
| `src/components/recon/explain-contract.ts` | the seam. Nothing under `src/components/**` opens a connection. |
| `src/components/recon/CorrectionTimeline.tsx` | the two-axis timeline. |
| `src/components/recon/ExplainedBreaksView.tsx` | the screen. |
| `src/components/recon/explain-fixtures.ts` | the four non-live states, with provenance printed on screen. |
| `src/app/(app)/breaks/page.tsx` | the route. |

**The ledger boundary holds.** Not one of these files contains a SQL reference
to `journal_entry`, `journal_line` or `account`; correction-group entries come
through `src/lib/ledger/queries.ts` → `readCorrectionGroup`, forwarded by
`./diff.ts`. `src/lib/ledger/boundary.test.ts` is a ratchet and none of these
files appear on its debt list.

**No migration was added.** `0030` was reserved for this work and is not used:
everything here is derivable from rows that already exist, which is the point
being made.

---

## 7. The real rows this screen explains

As of Sep 11 2026, on the live Neon book.

**A correction that closes** — `achsim-settlement-2026-09-11.csv`, run
`f66cbb79-ac0a-4f12-a284-e4404e00aced` (#20):

- break `amount_mismatch:b7867a63-a985-4f9c-a37b-db0e99e7ed7d`, reference
  `221099211345426`
- correction group `60849963-f800-4e00-b9aa-effa2369d407`, three real entries:

| step | entry | seq | value date | booked | rail | net |
|---|---|---|---|---|---|---|
| original | `60849963-f800-4e00-b9aa-effa2369d407` | 2037 | Sep 11 2026 | Sep 11 2026 | +$309.59 | $309.59 |
| reversal | `30cce766-51bd-455f-8b09-043d57a10e31` | 2038 | Sep 11 2026 | Sep 11 2026 | −$309.59 | $0.00 |
| re-book | `68471fff-16af-4972-b9c2-4665e6bad9b1` | 2039 | Sep 11 2026 | Sep 11 2026 | +$259.59 | $259.59 |

File $259.59. The file disagreed with what we had booked by **−$50.00**;
**$0.00** is outstanding. Class `correction_closed`, severity `explained`, aged
on the booking axis.

**Genuine breaks on the same run, none of them suppressed** —
`amount_mismatch:979ac84e-…` (`289007259742356`, $18.40 outstanding),
`in_file_not_ledger:d92399cd-…` (`319824413466267`, $102.74),
`in_ledger_not_file:73ec3b89-…` (`ACH-LEDGER-ONLY-s2-20260911`, $214.50), and
three Plaid funding legs at $1,250.00 each. Seven breaks in, seven out.

**Corrections the file has not caught up with** — the two rows in §4.1, on run
`79b520b6-0dca-4c52-91f6-7e19aa871087`.

Reproduce any of it:

```bash
set -a; . ./.env; set +a
npx vitest run src/lib/recon/explain.test.ts src/lib/recon/explain-live.test.ts
```

and open, on the deployment or on `next dev`:

```
/breaks?run=f66cbb79-ac0a-4f12-a284-e4404e00aced&break=amount_mismatch:b7867a63-a985-4f9c-a37b-db0e99e7ed7d
/breaks?run=79b520b6-0dca-4c52-91f6-7e19aa871087
/breaks?state=edge
```

Break ids are stable while the rows are; the live-fire suite appends new runs
continually, so the newest run is whatever attack ran last. The tests assert
*properties*, never these ids, for exactly that reason.
