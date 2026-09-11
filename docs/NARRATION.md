# The video — one continuous take, timed

Recorded against **https://corgi-trial-psi.vercel.app**, commit `826276a`.
Six screens, no cuts. Times are cumulative from the moment recording starts.

The brief says it grades three things hardest: **the hold model under hostile
sequencing, the bitemporal correction, and whether available balance is derived
truth or a stored lie.** Those are 0:20, 1:30 and 2:20. Everything else can be
trimmed; those cannot.

---

### 0:00 — 0:20 · `/client` loads

Ridgeline Robotics, the customer's own view.

> "This is a business current account. Two surfaces over one ledger — what a
> customer sees, and what the bank sees. Same money, one implementation."

---

### 0:20 — 1:05 · `/client` — the subtraction  ← **HOLD**

Scroll to *"Why those two numbers are different"*.

> "Sixty-seven thousand seven hundred and fifty-nine in the account. Ten
> nine-four-seven spendable. The difference is on the page, line by line:
> twenty-four thousand of card payments waiting to settle, twenty-nine thousand
> that has landed but not cleared, twenty-five hundred already on its way out."

> "That last row says it — *the database's own answer, not a total added up on
> this page*. There is no `available` column in this database. Not on any table.
> It is one SQL function with five terms, and the customer screen, the console,
> the API and the agent surface all call that same one."

---

### 1:05 — 1:50 · `/client/activity` — authorised vs settled  ← **HOLD**

Scroll to the first card row.

> "A fuel pump authorised fifty dollars. Two days later it settled for
> seventy-three forty — **more** than it asked for, which pumps and restaurant
> tips do constantly."

> "The hold released exactly once. The ledger posted the settled amount. Both
> numbers are on the record, because neither one was ever wrong."

> "Underneath, an inbound ACH funding row — and it says *originated, not
> transmitted*, because no entry was sent to a network. The screen will not
> imply otherwise."

---

### 1:50 — 2:45 · `/client/statements` — Tuesday, corrected  ← **LONGEST HOLD**

Opens on 2026-07-25 by default.

> "A merchant took back a settlement and re-presented it for less. Here is that
> day: the original clearing at two-forty-eight fifty, the reversal that took it
> back, and the re-book at one-ninety-eight fifty. The closing balance already
> carries the corrected figure."

> "Nothing was edited. The original entry is still there — this ledger has no
> UPDATE and no DELETE on a money row anywhere. A correction is three entries,
> and the value date never moves; only the booking position does."

Point at the three fingerprints.

> "And it re-derives. Rebuilt twice while this page loaded, at two different
> instants, same fingerprint both times, matching the one stored when the
> statement was issued. Earlier versions are kept, not overwritten."

---

### 2:45 — 3:30 · `/approvals` — the second signature

Scroll to the top card.

> "Three thousand two hundred dollars, above the threshold, awaiting approval.
> The initiator is Dana Okonkwo — and I'm signed in as Dana, so the row is
> marked **that is you** and all three controls are dead."

> "Read the reason: *this is not a rule the screen is applying*.
> `assert_maker_checker()` in the database refuses the insert with SQLSTATE
> 42501. The button is disabled so you learn it here rather than after pressing
> it."

> "The agent surface obeys the same rule, and it has to — across this whole book
> the agent has requested a hundred and ninety-three payments and approved
> zero."

---

### 3:30 — 4:10 · `/breaks` — the nightly file

> "Last night's file against our ledger. Three categories — in-file-not-ledger,
> in-ledger-not-file, amount mismatch — each asked a further question: *does the
> book already explain this?*"

> "One unexplained break, two hundred and forty dollars seventy-one, reference
> LF6. That's a row deliberately deleted from tonight's file, and this is the
> screen finding it, naming its category and ageing it."

> "The age says *453 days ahead* — the file's business date is in 2027, because
> the harness forward-dates it so the run is reachable from this screen. It says
> ahead rather than minus four hundred, because a minus sign in an age column is
> a puzzle, not a fact."

---

### 4:10 — 4:45 · `/chaos` — the weapon, handed over

> "And this is where we hand you the stick. Four controls: hold our own webhook
> deliveries back, delay a settlement, duplicate a delivery, or release them in
> reverse so a settlement arrives before the authorisation it belongs to."

> "It never touches the provider — these are deliveries we originated, held in
> our own durable outbox, and they catch up when it's turned off. Nothing is
> lost, which is the point."

---

### 4:45 — 5:00 · close

> "Six invariants are red right now and every one has a written argument beside
> it in the script that reports them. There's no mobile app — that was cut early
> and written down as a decision. And the console you've been watching is
> readable by anyone with the link, on purpose, so you can check all of this
> without a password. Nothing can be *done* to the money without one."

---

## If you need it shorter

Cut `/chaos` (4:10–4:45) and the close to one sentence. That lands at 4:15 and
loses none of the three graded claims.

## If a panel asks for one command

`pnpm confirm` — the brief, line by line, measured now. `node scripts/coreloop.mjs`
— the seven arrows in ninety seconds, last run PASS 7 / FAIL 0 / SKIP 0.
