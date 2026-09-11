# The video — one continuous take, ~3:00

Against **https://corgi-trial-psi.vercel.app**, commit `826276a`. Five screens,
no cuts. Times are cumulative from the start of the recording.

Written to the length of the take, not to a plan. The brief's three
hardest-graded claims are at **0:15, 0:55 and 1:25** — if anything gets trimmed
it is the last screen, never those.

---

**0:00 — 0:15 · `/client` loads**

> "A business current account. Two surfaces over one ledger — what the customer
> sees, and what the bank sees."

---

**0:15 — 0:55 · the subtraction**  ← hold

> "Sixty-seven thousand in the account. Ten nine-four-seven spendable. The
> difference is on the page: card payments waiting to settle, money that landed
> but hasn't cleared, payments already on their way out."

> "That last line says it — *the database's own answer, not a total added up on
> this page*. There is no `available` column in this database. It's one SQL
> function with five terms, and every screen calls the same one."

---

**0:55 — 1:25 · `/client/activity`**  ← hold

> "A fuel pump authorised fifty dollars. Two days later it settled for
> seventy-three forty — more than it asked for. The hold released exactly once,
> the ledger posted the settled amount, and both numbers are on the record
> because neither was ever wrong."

> "The funding row underneath says *originated, not transmitted* — no entry went
> to a network, and the screen won't imply it did."

---

**1:25 — 2:05 · `/client/statements`**  ← longest hold

> "A merchant took back a settlement and re-presented it for less. That day
> shows all three: the original, the reversal, the re-book — and the closing
> balance already carries the correction."

> "Nothing was edited. This ledger has no UPDATE and no DELETE on a money row
> anywhere. The value date never moves; only the booking position does."

> "And it re-derives — rebuilt twice while this page loaded, same fingerprint
> both times, matching the one stored when it was issued."

---

**2:05 — 2:40 · `/approvals`**

> "Three thousand two hundred, above the threshold. I raised it, so the row says
> **that is you** and all three controls are dead."

> "The reason names it: this is not a rule the screen applies.
> `assert_maker_checker()` refuses the insert with SQLSTATE 42501. The button is
> disabled so you learn it here rather than after pressing it. The agent surface
> obeys the same rule — 193 payments requested, zero approved."

---

**2:40 — 3:00 · `/breaks`**

> "Last night's file against our ledger. One unexplained break, two hundred and
> forty seventy-one — a row deliberately deleted from the file, and this is the
> screen finding it and ageing it."

> "Six invariants are red right now and every one has a written argument beside
> it. And this console is readable by anyone with the link, on purpose — nothing
> can be *done* to the money without signing in."

---

**One command, if they ask:** `pnpm confirm` — the brief, line by line, measured
now. `node scripts/coreloop.mjs` — the seven arrows in ninety seconds; last run
PASS 7 / FAIL 0 / SKIP 0.
