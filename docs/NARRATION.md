# Narration — matched to the recording

Video: `2026-09-11 16-52-04.mp4` · **3:43** · 3200×2000 @ 30fps · one Chrome window,
one tab, six screens, no cuts.

Timecodes are where the screen *changes*, read off the recording itself. Each
block is sized to be spoken inside its window at a normal pace (~150 wpm).

> The walkthrough was driven by browser automation, which is why Chrome shows
> "Claude started debugging this browser" across the top. Nothing on the pages is
> stubbed — every figure is read live from the deployed system.

---

## 0:00 — `/client` · what you can actually spend  *(40s, ~95 words)*

The customer's own screen. One business, Ridgeline Robotics.

Availability here is not a column anybody writes. It's five terms, subtracted in
front of you: sixty-seven seven fifty-nine booked, less twenty-four six ten
waiting to settle, less twenty-nine seven-oh-one not yet cleared, less
twenty-five hundred already on its way out. Ten thousand nine forty-seven,
ninety-three.

Read the line under it — that figure is the database's own answer, not a total
this page added up. If the page and the ledger disagreed, the page would be the
one that's wrong. So the page doesn't get a vote.

## 0:40 — `/client/activity` · when the merchant takes more than it asked for  *(40s, ~90 words)*

A fuel pump authorises fifty dollars. It settles at seventy-three forty.

The row says exactly that: held fifty when it was authorised, took seventy-three
forty when it settled — twenty-three forty more than expected. The customer
doesn't reconcile anything; the difference is named on the line.

Above it, the same clearing taken back and re-presented — a reversal tagged as a
correction, and the refund leg beside it. Three rows, one story, nothing
overwritten.

## 1:20 — `/client/statements` · a statement you can re-derive years later  *(40s, ~100 words)*

The twenty-fifth of July. A day that closed, then got corrected.

Four legs: the funding credit, the original clearing, the reversal that took it
back, the re-presentation at a hundred ninety-eight fifty.

Now the three hashes — rebuilt just now, rebuilt again a moment later, and the
fingerprint stored the day it was issued. Identical. The day is frozen at booking
position nine eighty-two, so rebuilding from the ledger there gives the same
document every time.

And both earlier versions of this day, still issued, still readable. A corrected
statement is a new document, not an edit of the old one.

## 2:00 — `/approvals` · a rule the screen cannot bend  *(32s, ~80 words)*

Same window, same tab. This is the ops console.

Priya Raman raised the top payment, so Approve and Reject are live. Dana Okonkwo
raised the one below, and Dana is signed in — tagged "that is you" — so both are
greyed.

Read why. The initiator is never the checker, and this is *not* a rule the screen
is applying: `assert_maker_checker()` refuses the insert with SQLSTATE 42501.
Turn the UI off and the rule still holds.

## 2:32 — `/breaks` · reconciliation that classifies rather than hides  *(32s, ~80 words)*

One break, shown rather than swept. In the ledger, not in the file. Unexplained.
Two hundred forty seventy-one outstanding.

The age reads four hundred fifty-three days *ahead*, because an unexplained break
is aged from its value date — how long the book has been wrong, and every
statement issued since. A break already under correction is aged from when we
learned. Two clocks, and the screen says which one it used.

"The engine reported one; this screen classifies them and hides none."

## 3:04 — `/chaos` · the invariants, measured while things break  *(39s, ~95 words)*

Webhooks off. Settlement delayed. Deliveries duplicated. Settlement arriving
before the authorisation it belongs to — each armed against our own outbox.

Below them, the invariants: the same views `dbcheck` asserts, each of which must
return zero rows, measured live rather than remembered. Every entry sums to zero.
A released hold withholds nothing. No day re-priced by a rate that came later.

And one red, left on screen — three hundred eleven rows under
`v_refused_auth_hold`. It's on the register with a written argument, and it's
showing because a dashboard that only renders its greens isn't evidence.
