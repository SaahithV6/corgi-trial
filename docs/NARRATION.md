# The five-minute video — the core loop, arrow by arrow

Recorded against **https://corgi-trial-psi.vercel.app**. The browser is driven
at narration pace; you talk over it.

The brief names the loop. This is that loop, in that order, one shot per arrow:

> open an account behind a real KYB check → fund it from a linked external bank →
> issue a real (sandbox) card → authorise, then settle for a different amount days
> later → send an outbound payment that needs a second approver → survive a
> reversed settlement → reconcile the scheme file

Three shots carry the things the brief says it grades hardest — **2, 4 and 6**.
If you run long, cut shot 0 and shot 8. Never those three.

---

## 0 · `/` — where we are  ·  ~15s

> "One book, two surfaces. The customer's side, and the bank's side. The console
> is readable without a password on purpose, so you can check everything I am
> about to say — but nothing can be *done* to the money without signing in."

---

## 1 · `/client/open` — open an account behind a real KYB check  ·  ~30s

> "A business applies. The registry leg is a live call to GLEIF; the director
> check is live Stripe Identity. We report the **weaker** of the two, never an
> average — one unanswered leg holds the whole application at pending."

> "And there is no account yet. No deposit leaf exists until the checks pass, so
> there is nothing to transact against. Pending and rejected are both real
> states here, not screens we drew."

---

## 2 · `/client` — the balance, and why two numbers  ·  ~45s  ← LONGEST HOLD

> "Ledger balance, minus card holds, minus credits that have not cleared, minus
> money already committed to leave. That subtraction is on the page because it
> is exactly what the system does."

> "There is no `available` column in this database. Not on any table. It is a
> SQL function with five terms, and every screen — customer, console, API,
> agent — calls that same one. The brief asks whether available balance is
> derived truth or a stored lie. It is derived, and it is provable rather than
> asserted."

---

## 3 · `/client/funding` — fund it from a linked external bank  ·  ~30s

> "The customer links their own bank through Plaid — their link, not ours. Money
> arrives, and watch which number moves: the ledger goes up, and **available
> does not**, because the credit has not cleared."

> "Every one of these rows says on its face: originated, not transmitted. No ACH
> entry was sent to a network. We are not going to let a screen imply otherwise."

---

## 4 · `/client/cards` → `/client/activity` — authorise, then settle for a different amount  ·  ~50s  ← LONGEST HOLD

> "A card for each person on the team, issued through Lithic, with limits the
> customer sets themselves — per-card, per-transaction, blocked merchant
> categories — enforced inside the issuer's six-second window."

Then activity:

> "A fuel pump authorises fifty dollars. Two days later it settles for
> seventy-three forty — **more** than it asked for, which pumps and tips do
> constantly. The hold released exactly once. The ledger posted the settled
> amount. Both numbers are on the record because neither was ever wrong."

> "The hold is not stored either. It is a fold over the event set — authorised
> minus captured, floored at zero — so no arrival order is a special case. A
> settlement that arrives before its own authorisation parks and matches later."

---

## 5 · `/client/pay` → `/client/approvals` — a second approver  ·  ~35s

> "Above the threshold it needs a second human. The person who raised it can
> never approve it — and that is not a hidden button. It is a database trigger.
> Try it and you get SQLSTATE 42501."

> "The agent surface obeys the same rule, and it has to: across this whole book
> the agent has requested a hundred and ninety-three payments and approved
> zero."

---

## 6 · `/client/statements` — survive a reversed settlement  ·  ~50s  ← LONGEST HOLD

**Open the statement for 2026-07-25** — group `eaf694e2`, booking seqs
508/509/510, −$248.50 reversed and re-booked at −$198.50. That is the published
day that carries a correction. (2026-09-08 also has one, at seqs 3/4/5, but
Ridgeline has no published statement for it — do not open that day.)

> "A merchant took back a settlement days after it happened. The statement for
> the day it happened now shows the corrected position — and the system can still
> tell you what it believed at any earlier point, and exactly when it learned the
> truth."

> "That is not a figure of speech. Every entry carries a booking position as well
> as a value date, so you can ask the book what it knew as of any position and it
> will answer."

> "Value date and booking date are different columns on the base table, decided
> on day one. This cannot be retrofitted at hour forty. A correction is three
> entries — the original, the reversal, the re-book — and the value date never
> moves. The original is still there. Nothing is rewritten, because this ledger
> has no UPDATE and no DELETE on a money row at all."

> "And it re-derives. It rebuilt twice on this page load, at two different
> instants, same fingerprint."

---

## 7 · `/breaks` — reconcile the scheme file  ·  ~30s

> "The processor's nightly file against our ledger. In-file-not-ledger,
> in-ledger-not-file, amount mismatch — with aging, because a break nobody has
> looked at for nine days is a different problem from one that appeared this
> morning."

> "They said they would plant a row. Here is a planted one, and here is where it
> went."

---

## 8 · The honest part  ·  ~25s

> "Six invariants are red right now and every one has a written argument beside
> it, in the script itself. Over-capture writes no closure row — because the
> network reopened a hold after an over-capture and captured it, so closing on
> captured-exceeds-authorised would have freed money that was still authorised."

> "No mobile app: a deliberate cut. The console is readable by anyone with the
> link: a trade, written at the top of the auth doc, not in a footnote."

---

## One command, if they ask

`pnpm confirm` — the brief, line by line, measured against the live book and the
deployment. **23 pass · 0 fail · 1 cut · 0 unproven.** Nothing in it means
"looks right": a row whose evidence cannot be gathered prints UNPROVEN and says
why.
