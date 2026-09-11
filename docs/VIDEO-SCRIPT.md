# Five-minute video — the money path, shot by shot

**Total runtime 4:52.** Fourteen shots across twelve browser tabs and one
terminal. Every URL below was opened and every
figure below was read off the deployed system between **2026-09-11T09:43Z and
09:52Z**, commit `59010b5`, at `https://corgi-trial-psi.vercel.app`.

The previous version of this file was stale in five places — it said *4 of 7
integrations live* (it is now 7 of 7), it quoted a reconciliation file
(`livefire-MTVRTYAB`) that has been superseded, it quoted statement figures
(`$1,630.49` / `$10,082.94`) that have moved, it said `pnpm db:check` was
`14 passed, 0 failed` (it is now 36 / 2), and it routed you to
`/accounts/acct_operating_4417` as the main balance screen when the **live**
Ridgeline account screen now renders and is strictly better evidence. All of
that is corrected below.

---

## FLAGS — read these before you plug the mic in

**1. The Lithic sandbox daily spend cap is exhausted. Do not simulate an
authorisation on camera.** Measured at 09:49Z:
`available_spend_limit.daily = 0`, against `spend_limit.daily = 500000` and
`spend_velocity.daily = 1070442`. **Every authorisation declines, at every
amount, on this account today.** Raising it needs `PATCH /v1/accounts/{token}`,
which the permission classifier blocks, so it cannot be raised before 05:23.
Nothing in this script needs an approved authorisation — the hold lifecycle is
shown on the two labelled fixtures and on the live book's existing holds, and
the script says out loud that it is.

**2. Issuing a card is NOT gated by that cap.** `POST /v1/cards` is a different
endpoint and the health probe round-tripped Lithic in 216 ms at 09:43Z. Shot 5
presses the real button. Fallback sentence is written into the shot in case it
hangs.

**3. The figures move while you record.** Another process is raising payments
against this book — Ridgeline's ledger read `$52,371.09` at 09:44Z and
`$52,557.69` at 09:47Z, three minutes apart. Every figure below is marked
**FIXED** (an append-only historical fact that cannot move) or **DRIFTS** (read
it off the screen, do not read it off this page). Where it drifts, say
"roughly".

**4. Do not read the sentence "Six screens and the JSON endpoint" off the
landing page.** It is stale prose above a list of eighteen screens. You are
never pointed at it below.

---

## Before you record — setup

- **Screen recording at 1440×900 or larger, browser zoom 125%.** Every number
  has to be legible after the panel's player compresses it.
- **Two windows: browser, and a terminal in the repo root** with
  `set -a; . ./.env; set +a` already run. Alt-tab between them. Never type a
  URL on camera.
- **Pre-open these thirteen tabs, in this order, and let every one finish
  loading.** Several screens stream in behind a Suspense boundary — the landing
  page and `/accounts` show `reading…` for a beat — and you do not want that
  beat on tape. Then drive the whole video with Ctrl+Tab.

| Tab | URL |
| --- | --- |
| 1 | `/api/health` |
| 2 | `/onboarding` |
| 3 | `/funding?state=edge&business=e274546d-6bdd-5266-b0fb-cc839a7811f9` |
| 4 | `/accounts/a0c41a37-2be1-5c30-bfe9-03455f048fac` |
| 5 | `/accounts?business=e274546d-6bdd-5266-b0fb-cc839a7811f9` |
| 6 | `/accounts/acct_operating_4417?auth=pending` |
| 7 | `/accounts/acct_fuel_8802?state=edge` |
| 8 | `/approvals` |
| 9 | `/transactions?account=2eb04bde-236e-4c3a-b89f-657cc7dc61eb&asOf=1988-06-21&asKnownAt=2026-09-11T04:58:08.573Z` |
| 10 | `/transactions?account=2eb04bde-236e-4c3a-b89f-657cc7dc61eb&asOf=1988-06-21&asKnownAt=2026-09-11T04:58:08.647Z` |
| 11 | `/statements` |
| 12 | `/reconciliation` |
| 13 | terminal |

- **Tab 8 must be loaded with no cookie**, i.e. as Staff. If you have been
  clicking Approver while testing, clear `corgi_demo_role` first or you will
  start the maker-checker shot on the wrong side of it.
- **Nothing else needs pre-running.** Both terminal commands are fast and were
  timed tonight: `livefire.mjs --only 5` took **3.7 s**, `rebuild.mjs` took
  **2.7 s**. Run them live; they are more convincing live.

---

# The shots

## Shot 1 — 0:00 → 0:16 (16s) · what is actually live

**Tab 1, `/api/health`.** Scrolled so `"integrations"` is at the top of frame.

**On screen, verified 09:43:38Z:** `"live": 7, "total": 7`. Seven slots, each
with an `evidence` string and a `latencyMs`. `card_issuing` — `GET /v1/cards ->
200`, 216 ms. `director_kyc` — `Stripe Identity enabled`. `open_banking` —
`POST /institutions/get -> 200`, 63 ms. `ach_rail` —
`GET https://sandbox.increase.com/accounts?limit=1 -> 200`. `stablecoin` —
`15.03 USDC and 68659903703189 wei gas — a transfer is fundable`.
`business_registry` — `GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple
Inc.)`. **DRIFTS:** latencies, and the USDC balance.

**Say:**

> Seven integration slots, seven live. Live means a real authenticated call to
> that provider returned 2xx while this page was loading — not that a key
> exists in a file. The two the brief marks must-be-live are card issuing,
> which is Lithic, and director KYC, which is Stripe Identity. Both round-trip
> here. The registry leg is GLEIF and it is a substitution, and the evidence
> string says so in those words, because Middesk, Persona KYB and Sumsub KYB
> were all measured gated.

---

## Shot 2 — 0:16 → 0:32 (16s) · the account does not open until KYB says so

**Tab 2, `/onboarding`.** Scroll to the **Ridgeline Robotics, Inc.** row, then
down two lines to the raw provider answer beneath it.

**On screen, verified 09:50Z:** Ridgeline — **approved · evidence manual**.
Beneath it: `gleif-lei answered needs_review · not_in_lei_registry`, left
unedited, with a named reviewer's reason citing Stripe Identity session
`vs_1UEDLcDgSL5WTGpmif87HEZ7`. Further down the page, **Silverline Freight Co.
— needs_review · evidence live**. And on every row: *"business current account
(2100) — opened when KYB approved, which is the only event that opens one."*
**FIXED.**

**Say:**

> Leg one. KYB is a gate, not a badge — the two-one-zero-zero deposit account
> is created by the approval, so an unverified business has nowhere for money
> to land. The registry leg here reads needs review, because GLEIF has no
> record of a fictional robotics firm, and a miss is evidence of nothing. A
> named human overrode it on a certificate of incorporation and a verified
> Stripe Identity session, and the provider's original answer is still sitting
> underneath, unedited. The composite is labelled manual, not live, for exactly
> that reason.

---

## Shot 3 — 0:32 → 0:56 (24s) · funded from a linked bank, and the delay

**Tab 3, `/funding?state=edge&business=e274546d-…`.** Point first at the
**business picker**, then at the Ridgeline balance block.

**On screen, verified 09:47Z:** the picker prints the gate's verdict per
business — Ridgeline `✓`, Silverline Freight Co. `KYB_NEEDS_REVIEW`, others
`KYB_PENDING`. Ridgeline: ledger `$52,557.69`, − Card holds `$410.00`,
− Uncleared `$30,210.50`, − Committed out `$2,500.00`. **DRIFTS — read them
off the screen.** The panel text is FIXED: *"five real HTTP requests to
sandbox.plaid.com"*, and *"No ACH entry is transmitted to any network"*.

**Say:**

> Leg two, funded from a bank the customer linked themselves. Pressing this
> makes five real calls to the Plaid sandbox — link token, public token,
> exchange, accounts, auth — and books one financial entry and one memo entry
> in one transaction. Watch which number moves: the ledger rises by the full
> deposit and available does not move a cent, because the identical amount is
> withheld under an uncleared-credit hold until the return window closes.
> Raising available the moment the ledger rises is lending the customer money
> against an entry that can come back. And the screen says plainly that no ACH
> entry was transmitted — it is booked at origination against ACH receivable,
> which is where a debit sits at file-cut.

---

## Shot 4 — 0:56 → 1:30 (34s) · ledger and available, side by side, with the arithmetic

**Tab 4, `/accounts/a0c41a37-2be1-5c30-bfe9-03455f048fac`** — Ridgeline's live
deposit account. Point at the two big figures, then at the derivation table
under them.

**On screen, verified 09:44Z:** badge **live ledger**. Ledger balance
**$52,371.09**. Available balance **$19,500.59**. *"$30,620.50 of the ledger
balance is not spendable. Here is exactly where it is."* Then the table:
Ledger `$52,371.09` − Active holds (10 holds) `$410.00` − Uncleared credits
(30 pending) `$30,210.50` − Committed outflows `$2,250.00` = Available
`$19,500.59`. **DRIFTS — all five.** The identity does not: it closes to the
cent every time.

**Say:**

> The two balances, side by side, on the live book. Ledger, fifty-two three
> seventy-one oh nine. Available, nineteen five hundred fifty-nine. They differ
> by thirty thousand six twenty fifty, and the screen does not tell you that as
> a conclusion — it itemises it. Four hundred and ten of card holds, thirty
> thousand two ten fifty of uncleared credits, two thousand two fifty of debits
> booked for a future value date. Integers, no clamp, and neither of those
> figures is a column. There is no balance column anywhere in this schema.
> Both are folds over journal lines at one value date and one booking
> watermark, and the page names both clocks at the top.

---

## Shot 5 — 1:30 → 1:44 (14s) · a real card, issued live

**Tab 5, `/accounts?business=e274546d-…`.** Scroll to the **Cards** panel and
press **Issue a real Lithic card**.

**On screen, verified 09:52Z:** *"This calls `POST /v1/cards` against the live
Lithic API and then binds the returned token to Ridgeline Robotics, Inc.'s 2100
deposit account and 9100 memo account through `registerCard()`."* Below it, the
table **Cards registered to this customer, newest first** — top row token
`c4856733-153e-46a6-afeb-44ad6fb84cae`, last four `••5132`, nickname *corgi
core loop CL-MTWP9GVZ*. **DRIFTS** — a new row appears at the top when you
press it.

**Say:**

> Leg three. That button is a real POST to the Lithic card API, and the token
> and last four that come back are bound to this customer's deposit account and
> its memo account. There is no PAN column in this schema.

**If it hangs or errors, do not wait — say:** *"The table underneath is a
hundred and seventy-eight of them, every one a real object on a real card
program."* and Ctrl+Tab on.

---

## Shot 6 — 1:44 → 2:02 (18s) · an authorisation moves available, not the ledger

**Tab 6, `/accounts/acct_operating_4417?auth=pending`.** Point at the **fixture**
badge first, then the two balances.

**On screen, verified 09:45Z — all FIXED, this is a fixture:** badge
**fixture**, *"Demo data behind the same interface the live ledger implements…
nothing here was written to the database."* Ledger **$48,215.60** with the
annotation **"unchanged by the authorisation"**. Available **$33,665.60** with
**"−$50.00 · down 50 dollars · SHELL OIL 1247 authorisation"**. Derivation:
48,215.60 − 2,050.00 − 12,500.00 − 0.00 = 33,665.60.

**Say:**

> Leg four. A fifty dollar fuel-pump authorisation lands. This one is a
> labelled fixture and it says so at the top — I will tell you in thirty
> seconds why it has to be. Ledger balance, forty-eight thousand two fifteen
> sixty, annotated unchanged by the authorisation. Available, down exactly
> fifty. An authorisation is a memo posting. It changes what you can spend and
> it does not touch the book.

---

## Shot 7 — 2:02 → 2:26 (24s) · settle for a different amount, hold releases once

**Tab 7, `/accounts/acct_fuel_8802?state=edge`.** Point at the two balances,
then at the paragraph headed *"Available balance is negative. This is not a
display bug."*

**On screen, verified 09:47Z — FIXED:** Ledger **−$8.40**. Available
**−$20.40**. Derivation: −8.40 − 12.00 − 0.00 − 0.00 = −20.40. The prose:
*"SHELL OIL 1247 · pump 4 authorised $50.00 and was withheld from availability
at that amount. The network then cleared $73.40 — an over-capture of $23.40,
which was never authorised and therefore never held. The hold released to $0.00
because H(E) = max(A − C, 0)… The rail reports the authorisation as SETTLED —
which is also what it reports while a partial hold is still live, so it is
displayed and never acted on."*

**Say:**

> Days later it clears, and for a different amount. Fifty authorised,
> seventy-three forty cleared. That is a fuel pump. The ledger takes the full
> seventy-three forty. The hold releases once, at the fifty that was actually
> held, because the remaining hold is max of authorised minus cleared and zero,
> folded over the event set — it is never the provider's status field. The rail
> says SETTLED while money is still held. We measured that, so we display it
> and never act on it. And available is minus twenty forty, not clamped,
> because the customer really is overdrawn.

---

## Shot 8 — 2:26 → 2:54 (28s) · maker-checker, from both sides

**Tab 8, `/approvals`.** Point at the actor badge, then a queue row's disabled
control and its reason. Then **click Approver** in the header and let it
reload. Point at a row now marked **that is you**.

**On screen, verified 09:45Z.** As Staff: *Actor **Priya Raman** · cannot
approve*, and on every row the reason *"Acting as Priya Raman, who holds no
approval rights… the database refuses an approved event from an actor whose
can_approve is false."* As Approver: *Actor **Dana Okonkwo** · can approve*,
with her own rows marked **that is you**. Queue depth **50 awaiting** and the
row amounts **DRIFT**; a representative row was `$3,200.00 USD ach`, policy
version `ach@2026-01-01`, threshold `$2,500.00`, `0 of 1 approval held`, content
hash `133f897983c4…`. FIXED on the page: the panel naming the trigger on
`payment_instruction_event`, SQLSTATE 42501, and the CHECK
`NOT (kind <> 'human' AND can_approve)`.

**Say:**

> Leg five, money out above a threshold. I am Priya Raman and I cannot approve
> anything — every control is disabled and the reason is printed beside it.
> Each instruction carries its policy version, the threshold that produced it,
> and a content hash over the account, rail, amount, destination and value
> date, so an approval given for one amount cannot be moved to another. Now
> switch role. Dana Okonkwo can approve — and the queue still refuses her on
> the payments she raised herself. Nothing about her rights is wrong, so the
> refusal can only be the maker-checker rule. Some of these were raised by the
> agent surface, and they land in the same queue.

---

## Shot 9 — 2:54 → 3:12 (18s) · and the button is not the control

**Tab 13, terminal.** Type and run:

```bash
node scripts/livefire.mjs --only 5
```

**Timed at 3.7 s.** Stay quiet while the scoreboard paints.

**On screen, verified 09:47Z — the ids change every run, the shape does not:**

```
 5  Self-approval refused by the DATABASE (SQLSTATE 42501)            PASS
    4/4 assertions
    evidence: raw INSERT of an 'approved' event by the initiator -> SQLSTATE
    42501 from assert_maker_checker(): "maker-checker: actor 76f9266f… initiated
    instruction f35df6d4… and cannot approve it"
    evidence: approved events for f35df6d4…: 0 after both attempts;
    application refusal code SELF_APPROVAL
    evidence: a second human approved the same instruction: 1 approved event,
    actor 9fff2b99… (not the initiator)

  PASS 1    FAIL 0    SKIP 0    of 1 attacks    4s
```

**Say:**

> That disabled button is not the control. This bypasses the application
> entirely — a raw INSERT of an approved event by the initiator, no code of
> mine in the call stack — and the database refuses it: SQLSTATE 42501, from a
> trigger, naming the actor and the instruction. Zero approved events written
> after both attempts. And the last line matters as much: a different human
> then approved the same instruction, because "it refused" is also what a
> system that refuses everything would say.

---

## Shot 10 — 3:12 → 3:40 (28s) · time travel, two URLs, one day

**Tab 9, then Tab 10.** Both are `/transactions` on the same account and the
same `asOf=1988-06-21`; only `asKnownAt` differs, by 74 milliseconds. Show tab
9, read the three tiles, then Ctrl+Tab to tab 10 and read the same tiles.

**On screen, verified 09:45Z — FIXED. These are historical booking positions in
an append-only book and they cannot move.**

Tab 9 (`asKnownAt=…04:58:08.573Z`): resolves to **booking watermark 2680**.
*the belief changed* — **As believed then $951.50** · **Difference +$50.00,
over 1 later act** · **As corrected $1,001.50**. Itemised underneath: *"Reversal
of 91d5a24f…: statement proof MTWHJLCM: merchant reversed and re-presented"*,
`reversal · act 91d5a24f`, **value date 1988-06-21**, **seq 2681** — and its
re-book at seq 2682. Banner: *"fully accounted for."*

Tab 10 (`asKnownAt=…04:58:08.647Z`): resolves to **booking watermark 2682**.
*no change* — **As believed then $1,001.50** · **Difference $0.00, the two
queries agree**.

**Say:**

> Same account, same business day, same rows. One argument changed — what we
> had learned when we asked — and it changed by seventy-four milliseconds. At
> the first instant the day closes at nine fifty-one fifty. At the second it
> closes at a thousand and one fifty. Between them a merchant reversal and a
> re-book were appended, both at the original value date, nineteen eighty-eight
> June twenty-first, and both booked in twenty twenty-six. The value date never
> moved; the booking sequence did. The cut is on the sequence, never on the
> timestamp — and the page proves no correction act was split across it.

*(That business is a fuzzer fixture and that value date is synthetic. If it
bothers you, say so in four words: "fuzzer-seeded day, real machinery." Do not
apologise for it.)*

---

## Shot 11 — 3:40 → 4:00 (20s) · the statement for the corrected day

**Tab 11, `/statements`.** The three tiles, then the hash row at the bottom.

**On screen, verified 09:46Z:** business **Ridgeline Robotics, Inc.**, value
date **Jul 25, 2026**, day close **seq 508**. **As published $22,011.05** at
booking watermark **508**. **Difference +$50.00**, *"Accounted for, entry by
entry, by 6 later acts below."* **As corrected $22,061.05** at the current
watermark. Badges **FULLY ITEMISED** and **HASH REPRODUCED**; content hash
`a2d7b19dcd546dd22f29b5ca724ebb85ee646e6c02a561071288513f611434f7`. The
published figure, the hash and the +$50.00 are **FIXED**; the right-hand
watermark **DRIFTS** (it read 3,912).

**Say:**

> The same idea as a document. A statement here is a period and a booking
> watermark, not just a period. Version one went out at twenty-two thousand
> eleven oh five, and this page re-derived it from the ledger just now and
> hashed it to the stored value — nothing was edited to make that true. The
> same day read today is twenty-two thousand sixty-one oh five, and the fifty
> dollars between them is itemised by the six acts that caused it. Both are
> true. One is what we told the customer, one is what the book knows now.

---

## Shot 12 — 4:00 → 4:16 (16s) · reconcile the scheme file

**Tab 12, `/reconciliation`.** The four tiles, then the single break row.

**On screen, verified 09:45Z:** badge **LIVE LEDGER**. File
`livefire-MTWHF7RX-tonight.csv`, business date **Dec 07, 2027**, run **#1**,
watermark seq 2662. **Matched 3 / 3** · **Breaks 1** · **Net difference
+$240.71** · **Past a close 0**. The break: **In ledger, not in file**,
reference **LF6-MTWHF7RX-3**, `$240.71`, age **-452d**, severity **Open**.
**FIXED** unless someone re-runs live fire.

**Say:**

> Last night's settlement file against our book, matched on the provider's own
> reference and nothing else. Three break categories, no more and no fewer.
> Three of three rows matched, one break — two hundred and forty seventy-one,
> in the ledger and not in the file. That break is planted, and the control run
> is the point: live fire booked the settlements, imported the complete file,
> reconciled it to zero breaks, then deleted one row and re-imported. The age
> reads negative because the file is deliberately dated in the future, so a
> test run can never leave a break standing on a real business day.

---

## Shot 13 — 4:16 → 4:34 (18s) · the book, rebuilt from its events

**Tab 13, terminal.** Run:

```bash
node scripts/rebuild.mjs | head -60
```

The `| head -60` matters: the full output is 110 lines and the tail is the
findings dump, which you do not want scrolling under your voice. Line 59 is the
summary. **Timed at 2.7 s.**

**On screen, verified 09:45Z:** `isolation REPEATABLE READ, READ ONLY, as
corgi_app`. FACTS FOLDED — **3,682 journal entries**, **7,369 journal lines**,
**737 holds**, **651 card authorisations**, **60 published statements**.
Fourteen checks, thirteen `OK`, one `MISMATCH`. Then the table **THE CUSTOMER
DEPOSIT ACCOUNTS, REBUILT**, whose Ridgeline row reads
`$52371.09  $410.00  $30210.50  $2250.00  $19500.59`. Summary:
**`14 checks · 0 rebuild disagreement(s) · 9 fact-vs-fact disagreement(s) ·
2678 ms wall clock`**. **All of it DRIFTS** — the entry count grows as webhooks
land, so say "roughly three and a half thousand".

**Say:**

> One command. It reconnects as the application's own read-only role, folds
> roughly three and a half thousand journal entries back into every balance,
> every hold, every statement hash — and compares the reconstruction to what
> production is serving. Zero rebuild disagreements, in two and a half seconds.
> And look at the Ridgeline row: it is the same five figures you saw on the
> account screen four minutes ago, derived twice, independently. That is what
> "derived, never stored" has to mean to be worth anything.

---

## Shot 14 — 4:34 → 4:52 (18s) · what is wrong with it

**Stay on the terminal.** Do not cut away, do not slow down, do not apologise.

**Say:**

> Three things you would find in ten minutes, so I will say them. One: the
> Lithic sandbox's daily spend cap is exhausted — available daily limit is
> zero — so every authorisation declines today. That is why two of the balance
> screens you just saw are labelled fixtures, and why live-fire attack two
> reports SKIP rather than folding itself into a pass. Two: `pnpm db:check` is
> thirty-six passed and two failed, and both failures are real. A hundred and
> fifty-four holds withhold nine thousand seven eighty-six against
> authorisations for which no verdict was ever observed, and nine card holds
> carry an expiry instant a hundred and forty milliseconds off the
> authorisation's, because two clock reads at insert time. That second one is
> the same mismatch the rebuild just printed. Neither is repaired, because
> repairing a guard you have not understood is how a guard stops meaning
> anything. Three: the USDC leg confirms on Base Sepolia and there is no
> off-ramp partner behind it, so the delivery amount on a cross-border quote is
> a commitment and no peso has ever moved. The URL is live, the cut list is in
> the repo, and all of that is written down there too.

---

# If a take goes wrong and you are out of time — the 2:00 version

Seven shots. Tabs 1, 4, 7, 8, 9+10, 12, 13.

| | |
| --- | --- |
| 0:00 `/api/health` | *"Seven integration slots, seven live — each one a real 2xx round trip on this page load, not a key in a file."* |
| 0:12 Tab 4 | *"Ledger fifty-two three seventy-one, available nineteen five hundred. Neither is a column. The difference is itemised underneath in integers and it closes to the cent."* |
| 0:32 Tab 7 | *"Fifty authorised, seventy-three forty cleared. The ledger takes the clearing, the hold releases once at the fifty that was held, and available goes negative and is not clamped."* |
| 0:52 Tab 8 → click Approver | *"Staff cannot approve. The approver can — and still cannot approve what she raised herself."* |
| 1:08 Tabs 9 → 10 | *"Same day, same rows, one argument changed by seventy-four milliseconds. Nine fifty-one fifty, then a thousand and one fifty. A reversal and a re-book appended at the original value date. Nothing was edited."* |
| 1:32 Tab 12 | *"Three of three matched, one planted break — two forty seventy-one in the ledger and not in the file — with its reference and the journal entry behind it."* |
| 1:44 terminal, `node scripts/rebuild.mjs \| head -60` | *"The whole book rebuilt from its events in two and a half seconds. Zero rebuild disagreements. The Ridgeline row is the same five figures you saw ninety seconds ago."* |
| 1:56 close | *"The Lithic spend cap is exhausted so authorisations decline today; db:check is thirty-six passed, two failed, both real and both written up. It is all on the URL."* |
