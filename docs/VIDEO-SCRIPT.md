# Five-minute video — the money path, shot by shot

Insurance against demo-day gremlins, not a substitute for the URL. The URL is
**https://corgi-trial-psi.vercel.app** and it is the thing to open first if it
is up.

One path, walked once: **an authorisation moves available and not the ledger →
a clearing for a different amount moves the ledger and releases the hold exactly
once → a backdated correction leaves both time axes answerable → reconciliation
surfaces a planted break → the ledger refuses to be edited.** Everything else is
one sentence at the end.

Six beats. 724 spoken words, which is five minutes at a normal 145-a-minute
pace. Do not speed up to fit more in — there is nothing more to fit.

---

## Before you record

- **Screen recording, 1440×900 or larger, browser zoom at 125%.** Every number
  below has to be legible at whatever size the panel plays it.
- **Two windows, pre-loaded, alt-tab between them.** Browser for beats 1–5, a
  terminal in the repo root with `set -a; . ./.env; set +a` already run for
  beat 6. Do not type URLs on camera.
- **The figures move.** The deployment is live and live fire runs against it, so
  the specific dollar amounts drift. What must not drift is the *relationship*
  in each "must be visible" line. The amounts given are what was on screen at
  **2026-09-10T18:18Z**, so a re-shoot can be checked against them.
- **Say "sandbox" once and mean it.** No real money, no real customer data,
  every provider credential is a test key.

Tabs to open in advance, in order:

| Beat | URL |
| --- | --- |
| 1 | `/api/health` |
| 2 | `/accounts` then `/accounts/acct_operating_4417?auth=pending` |
| 3 | `/accounts/acct_fuel_8802?state=edge` |
| 4 | `/statements` |
| 5 | `/reconciliation` |
| 6 | terminal, repo root |

---

## 0:00 — What is live, and what is not

**On screen.** `/api/health`, raw JSON, scrolled to `integrations`. Or the same
table rendered at the bottom of `/` if the JSON is hard to read on video — it is
read from this endpoint, so it cannot disagree with it.

**Say:**

> Start here. The health endpoint on the deployed system. Four of seven
> integration slots are live. Live means a real authenticated call to that
> provider came back 2xx on this page load — not that a key exists. Card issuing
> is Lithic. Director KYC is Stripe Identity. Open banking is Plaid. ACH is
> Increase. All four, live. Three say simulated. Business registry, because
> Stripe Connect is gated. The stablecoin payout, because the wallet holds twenty
> dollars of USDC and no gas. And card webhooks — the deliveries are real, but no
> probe proves that slot, so it reads simulated. Under-claiming on purpose. None
> of this was typed by hand.

**Must be visible.** `"live": 4`, `"total": 7`. The four `"status":"live"` slots
named above, each with its evidence string (`GET /v1/cards -> 200`,
`Stripe Identity enabled`, `POST /institutions/get -> 200`, `GET /accounts ->
200`). The three `"status":"simulated"` slots with their reasons. If the count
has changed since the shoot, re-record this beat rather than talking over it.

---

## 0:35 — The authorisation moves available, and does not move the ledger

**On screen.** `/accounts` first — the **Operating ••4417** row. Then click it;
it opens `/accounts/acct_operating_4417?auth=pending`. Scroll to *How the
available balance is derived from the ledger balance*.

**Say:**

> Now the money. Operating, four-four-one-seven. Ledger, forty-eight thousand
> two fifteen sixty. Available, thirty-three seven fifteen sixty. I open it with
> a fifty dollar fuel-pump authorisation landed. Watch both numbers. Ledger is
> still forty-eight thousand two fifteen sixty — the screen says unchanged by the
> authorisation. Available is thirty-three six sixty-five sixty. Down fifty. An
> authorisation is a memo posting. It changes what you can spend. It does not
> touch the book. And here is the arithmetic rather than a claim about it:
> ledger, minus two thousand and fifty of holds, minus twelve and a half thousand
> of uncleared credit, equals available. Integers, no clamp. This one is a
> fixture and says so at the top. The same thing against production is attack one
> in live fire.

**Must be visible.** Both figures side by side: ledger **$48,215.60** before and
after; available **$33,715.60** → **$33,665.60**. The annotations *"unchanged by
the authorisation"* and *"−$50.00 · down 50 dollars · SHELL OIL 1247
authorisation"*. The four-row derivation summing exactly: 48,215.60 − 2,050.00 −
12,500.00 = 33,665.60. The **fixture** badge.

---

## 1:20 — The clearing moves the ledger and releases the hold exactly once

**On screen.** `/accounts/acct_fuel_8802?state=edge`. Scroll to **Holds** (the
SHELL OIL row), then to **Activity** (the top two rows).

**Say:**

> Now the clearing, and it is for a different amount. Fifty authorised.
> Seventy-three forty cleared. That is a fuel pump. Look at the activity list.
> One row moves the ledger — card clearing, minus seventy-three forty. One row
> releases the hold — plus fifty to available, no ledger effect. Once. Not fifty
> and then seventy-three forty. The hold releases at what was actually held.
> Remaining hold is zero, because the hold is max of authorised minus cleared and
> zero, over the events. We never read the provider's status field. It says
> SETTLED while money is still held — we measured that. Available is minus twenty
> forty. Not clamped, because the customer really is overdrawn.

**Must be visible.** In Holds: **Authorised $50.00 · Cleared $73.40 (+$23.40
over) · Remaining hold $0.00**. In Activity, two rows at the same timestamp and
the same event id: *Card clearing · SHELL OIL 1247* with **Ledger Δ −$73.40**,
and *Hold released · SHELL OIL 1247 (final clearing, over-capture)* with
**Available Δ +$50.00** and "no ledger effect". Balances **ledger −$8.40**,
**available −$20.40**.

---

## 2:10 — A backdated correction, with both time axes still answerable

**On screen.** `/statements`. Top three tiles, then the v1 document and its hash
row, then the **Versions of this statement** table at the bottom.

**Say:**

> A backdated correction. A statement here is a period and a booking watermark,
> not just a period. This day closed and published at watermark five-oh-four.
> Sixteen thirty forty-nine. Then a merchant reversed two forty-eight fifty and
> re-presented at one ninety-eight fifty — at the original value date, because
> the clearing should never have posted at that amount. That is version two:
> sixteen eighty forty-nine. Version one still says sixteen thirty forty-nine.
> The page re-derives it from the ledger right now and the hash matches. Nothing
> was edited to make that true. Ask the same day what it is today: ten thousand
> eighty-two ninety-four, itemised underneath. Both true. One is what we told the
> customer. One is what the book knows now.

**Must be visible.** The three tiles: **As published $1,630.49** (v1, watermark
504) · **Difference +$8,452.45** · **As corrected $10,082.94** (watermark 565).
The **HASH REPRODUCED** badge with stored and recomputed hashes both reading
`877f7bfefb2e…5cc6`. The **FULLY ITEMISED** badge. The versions table: v1 →
$1,630.49 at watermark 504, v2 CURRENT → $1,680.49 at watermark 506.

---

## 3:05 — Reconciliation surfaces the planted break

**On screen.** `/reconciliation`. The four summary tiles, then the single break
row.

**Say:**

> Reconciliation. Last night's settlement file against our book, matched on the
> provider's own reference and nothing else. Three break categories, no more and
> no fewer. Three of three rows matched. One break: two hundred and forty dollars
> seventy-one, in the ledger, not in the file. That break is planted, and the
> planting is the point. Live fire booked four settlements, imported the complete
> file, reconciled it — zero breaks. That is the control. Then it deleted one row
> and re-imported. This is where the row came out, with its reference and the
> journal entry behind it. The age reads negative because the file is dated in
> the future, so a test run cannot leave a break on a real business day.

**Must be visible.** File `livefire-MTVRTYAB-tonight.csv`, **Matched 3 / 3**,
**Breaks 1**, **Net difference +$240.71**. The break row: **LF6-MTVRTYAB-3**,
category **In ledger, not in file**, **$240.71**, severity **Open**. The **LIVE
LEDGER** badge, not a fixture badge.

---

## 3:55 — The ledger cannot be edited, including by me

**On screen.** Terminal, repo root. Run `pnpm db:check`. Let the output land and
stay silent for a beat while the first six lines paint.

**Say:**

> Last thing, and the one I would want checked hardest. The application connects
> to Postgres as a role called corgi_app. This script connects as that same role
> and tries to break the ledger. Update a journal entry. Delete one. Truncate the
> table. Watch. Permission denied. Permission denied. Permission denied. Six
> times — and a pass here means the database refused. Fourteen of fourteen. There
> is no update privilege to revoke, so no code path edits a posted entry,
> including mine. That is why the two figures on the statement screen can both be
> true.
>
> What I cut from these five minutes: maker-checker on money out, the agent
> surface, and the two things live fire cannot prove yet. All of it is in the
> README and the cut list, written down before you asked.

**Must be visible.** The header line *"attempting the forbidden, expecting
refusal"*. The first six `PASS` lines, each ending `permission denied for table
journal_entry` or `journal_line`. The last line: **`14 passed, 0 failed`**.

---

## If you only get one take — the 90-second version

Same order, three things cut: the health beat shrinks to one sentence, the
statements beat loses the itemisation, and reconciliation loses its control run.
Roughly 200 words.

**0:00 — `/api/health`.**

> Four of seven integrations are live against a real provider sandbox — Lithic,
> Stripe Identity, Plaid, Increase — and three are simulated and labelled so on
> this page. Live means a 2xx round trip, not a key in a file.

**0:12 — `/accounts/acct_operating_4417?auth=pending`.**

> Fifty dollar card authorisation. Ledger, forty-eight thousand two fifteen
> sixty — unchanged. Available, down exactly fifty. An authorisation does not
> touch the book.

**0:28 — `/accounts/acct_fuel_8802?state=edge`.**

> Now it clears at seventy-three forty. The ledger moves by seventy-three forty.
> The hold releases once, at the fifty that was actually held. Available goes
> negative and is not clamped, because the customer is overdrawn.

**0:48 — `/statements`.**

> A merchant reversed and re-presented at the original value date. The published
> statement still says sixteen thirty forty-nine and its hash still reproduces.
> The same day read today says ten thousand eighty-two ninety-four. Both true,
> neither overwrote the other.

**1:08 — terminal, `pnpm db:check`.**

> The app's own database role tries to update, delete and truncate the journal.
> Permission denied, six times. Fourteen of fourteen. Nothing edits a posted
> entry, including me.

**1:25 — close.**

> Reconciliation, maker-checker and what is still unproven are all on the live
> URL and in the cut list.
