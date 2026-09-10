# The seed

`scripts/seed.mjs` stands up the ledger's reference data from an empty
database, and can be run any number of times without changing the result.

```bash
set -a; . ./.env; set +a
node scripts/seed.mjs
```

Companion reading: `research/ledger/DESIGN.md` §2 (the account tree and normal
balances), §2.3 (the chart), §10.1 (funds availability), §12 (rounding);
`db/migrations/0001_ledger.sql` for the DDL; `DECISIONS.md` 008 and 009 for the
privilege model this script deliberately sits outside of.

---

## Which connection, and why it is the owner one

The seed connects on **`DIRECT_URL`** — the owner role, unpooled.

The application connects as **`corgi_app`**, which holds `SELECT` + `INSERT` on
the money tables and **only `SELECT`** on `account`, `business`, `actor`,
`book_entity`, `approval_policy` and `funds_availability_policy`. `corgi_app`
therefore *cannot* seed reference data, and that is the privilege model working
as designed rather than an inconvenience: opening an account and writing a
policy are operator actions, in the same class as a migration, and the running
application has no capability to express them. If this script ever runs
successfully on `APP_DATABASE_URL`, layer 1 has been widened by accident and
`pnpm db:check` should be run immediately.

---

## What it creates

| Table | Rows | Why these |
| --- | ---: | --- |
| `book_entity` | 1 | `CORGI-BANK`, the banking program entity. Entries may never cross entities, so everything below hangs off this one id. |
| `account` | 30 | 27 house accounts (the chart) + 3 customer accounts for the one approved business. |
| `business` | 3 | One per KYB outcome — approved, pending, rejected. |
| `actor` | 7 | 4 humans (3 approvers, 1 maker), 1 agent, 2 system principals. |
| `approval_policy` | 4 | One per money-out rail: `ach`, `usdc`, `wire`, `internal`. |
| `funds_availability_policy` | 7 | DESIGN §10.1, verbatim, as effective-dated data. |
| `rail_event_semantics` | 22 | Lithic 10, Increase 7, Base 5 — the correction-vs-new-event decision, per provider event type. |
| `journal_entry` / `journal_line` | **0** | Deliberate. See "What it does not do". |

---

## The chart of accounts

The chart lives in **`src/lib/ledger/chart.ts`** as typed data and is
`import`ed by the seed — Node strips the types, so the array the database gets
and the array the application reasons about are the same array. It is never
re-typed as SQL, so the two cannot drift.

```
1000  ASSETS                    debit-normal
  1110  Cash — FBO settlement account at sponsor bank
  1120  Card network settlement receivable          [rail control: card]
  1130  ACH receivable — inbound in transit         [rail control: ach]
  1140  USDC omnibus wallet — Base Sepolia          [rail control: usdc]
  1190  Receivable from customers — overdrawn       [reporting reclass only]
2000  LIABILITIES               credit-normal
  2100  Customer deposits                           [control; one leaf per customer]
  2200  Card network settlement payable             [rail control: card]
  2300  ACH payable — outbound in transit           [rail control: ach]
  2400  Suspense — unapplied receipts
  2410  Suspense — unmatched clearings
  2900  Rounding residual clearing
3000  EQUITY                    credit-normal
  3100  Retained earnings
4000  INCOME                    credit-normal
  4100  Interchange income
  4200  Fee income
5000  EXPENSE                   debit-normal
  5100  Network and processing fees
  5200  Losses — chargebacks and write-offs
  5300  Blockchain gas — USDC transfers
  5900  Rounding residual expense
9000  MEMO BOOK                 off balance sheet, nets to zero inside itself
  9100  Holds — card authorisations                 [control; one leaf per customer]
  9200  Holds — uncleared credits                   [control; one leaf per customer]
  9900  Memo contra
```

**A customer's deposit balance is our liability and it is credit-normal.** When
a business deposits $10,000 we owe them $10,000: our cash goes up (debit,
asset) and our obligation goes up (credit, liability). The consequence that
matters every day: **the customer spending money is a DEBIT to their deposit
account.** In this schema a debit is a **positive** `amount_cents` and a credit
is **negative**, so a $25 card clearing adds `+2500` to a deposit account whose
lines currently sum to `-10000`, and the natural balance — `SUM × normal_side`
— falls from $100 to $75. Model the deposit as an asset instead and every
downstream number inverts.

### The customer account code, and the trap in it

The stored `account.code` for a customer's deposit account is the **bare**
`'2100'`; the customer is identified by `business_id`. `v_available_balance`,
`v_overdrawn_accounts` and `v_deposit_control_drift` all select on
`code = '2100' AND business_id IS NOT NULL`, so writing `'2100/<uuid>'` into
that column would leave every one of those views silently empty rather than
wrong — the worst failure mode available. `chart.ts` therefore keeps two forms
apart: `depositAccountCode(businessId)` returns the **qualified** display form
`'2100/<uuid>'` for logs, statements and error messages, and
`accountsForBusiness(businessId)` returns the **stored** form,
`{ code: '2100', businessId, parentCode: '2100' }`. `chart.test.ts` asserts the
round trip in both directions and asserts that the stored form never contains
the separator.

The memo book works the same way: `9100/<uuid>` and `9200/<uuid>` are opened
alongside the deposit account, so a hold is double-entry against the customer's
own memo leaf and available balance is `ledger − active holds` with nothing
stored anywhere.

---

## The three businesses, and why these three

KYB state is carried **without a schema change**. `business` has no
`kyb_status` column and this seed does not add one: migrations are frozen here,
and DESIGN §17 is explicit that anything with an event stream gets no status
column, because a status column is a cache with no key and no invalidation
story. So the state is carried by two facts that are already representable and
are both independently checkable.

| Business | KYB | `ein` | What it makes demoable |
| --- | --- | --- | --- |
| Ridgeline Robotics, Inc. | approved | `000000000` | The happy path, and the only account money can move through. Every card, ACH and USDC scenario runs against it. |
| Kettle & Crumb Bakery LLC | pending | `222221005` | Onboarding in flight, registry has not answered. An inbound credit for it has nowhere to land: `2400` suspense and the inbox's `parked` state are the demo. |
| Silverline Freight Co. | rejected | `222221000` | The registry could not find the company. It has no deposit account, so it cannot be credited by accident — the refusal is structural, not a check somebody must remember. |

**Fact 1 — the EIN is a re-derivable signal, not an assertion.** Those are
Stripe Connect's published **test-mode magic EINs** (research/kyb/NOTES.md
§4.4): `000000000` is a successful business ID match, `222221005` forces
*pending response from registry*, `222221000` forces *company not found in
registry*. Point the KYB adapter at these rows and the sandbox returns that
outcome every time. The demo state is reproducible against a real third party
rather than being a string somebody typed.

**Fact 2 — the accounts themselves.** You cannot owe money to a business you
have not verified, so `2100/<id>` and its two memo hold accounts are opened
**on approval and not before**. The pending and rejected businesses have no
accounts at all. That makes the non-happy path a property of the data rather
than a branch in code: there is no account for an inbound credit to land in, so
the ingestion path must park the event or route it to suspense, and the
question "what happens when money arrives for a business that failed KYB?" has
an answer the panel can watch rather than one they have to take on trust.

---

## The actors, and the constraint the seed proves

| Actor | Kind | `can_approve` | Role in a demo |
| --- | --- | --- | --- |
| Dana Okonkwo | human | yes | Checker #1 — approves money out above the threshold. |
| Miles Ferrara | human | yes | Checker #2 — the second, **distinct** approval a wire needs. |
| Priya Raman | human | no | The maker. Raises instructions, can approve none. |
| Alex Whitfield | human | yes | The customer's own signer, scoped to Ridgeline's `business_id`. |
| Corgi payments agent | **agent** | **no, and cannot be** | The autonomous surface that raises payment instructions. |
| ledger-poster | system | no | Attribution for machine-originated journal entries. |
| webhook-dispatcher | system | no | Attribution for inbox dispatch, kept separate from the poster. |

Two approvers rather than one, and two *rather than the same one twice*, is
what makes `pie_one_decision_per_actor` and the wire policy's
`required_approvals = 2` demonstrable at all.

The agent's `can_approve` is not merely `false`; it is **unrepresentable**:

```sql
CONSTRAINT actor_only_humans_approve CHECK (NOT (kind <> 'human' AND can_approve))
```

The seed proves it rather than asserting it. Inside a savepoint it attempts to
insert an agent with `can_approve = true`, catches the refusal, rolls the
savepoint back and prints the result:

```
  maker-checker constraint: REFUSED by actor_only_humans_approve
```

If that line ever reads anything else, the guarantee is gone and the seed says
so in the same breath as it says everything else.

---

## The policies

**`approval_policy`** — a threshold and an approval count per money-out rail:

| Rail | Threshold | Approvals | Reasoning |
| --- | ---: | ---: | --- |
| `ach` | $2,500 | 1 | An ACH entry is recallable for two banking days, which bounds the damage below the line. |
| `usdc` | $1,000 | 1 | Lower than ACH because an on-chain transfer is irreversible on confirmation — there is no recall window at all. |
| `wire` | $0 | 2 | Every wire, any amount. Irrevocable on receipt, and the rail business-email-compromise actually uses. |
| `internal` | $0 | 0 | Both legs are on our own book; a mistake is correctable by a reversal. |

**`funds_availability_policy`** — DESIGN §10.1 as data: ACH from a known
counterparty (seen ≥3 times over ≥60 days) is `+1` banking day at 09:00 ET, a
new counterparty `+2`, wire and card refunds are immediate, USDC releases on
confirmation count (1 on the Base Sepolia demo, 2 for anything real), internal
transfers are immediate. Every uncleared-credit hold records the `policy_id` it
was created under, so a hold opened in March is still explainable in December
after the policy has changed.

Both tables carry the append-only triggers from `0001`, so the seed inserts
them and never updates them. **Changing a policy means inserting a new row with
a later `effective_from`** — which is the entire reason they are effective-dated
rather than mutable.

**`rail_event_semantics`** — the single most dangerous decision in a bitemporal
ledger, made as reviewable data. Per provider event type:

- **`correction`** → the original posting was a *false statement about its own
  value date*, so the reversal takes the **original's** value date. Examples
  seeded: Lithic `RETURN_REVERSAL`, `CORRECTION_DEBIT`, `CORRECTION_CREDIT`;
  Base `usdc.transfer.failed` and `usdc.transfer.reorged` — a reverted or
  reorged transaction moved no money at all, so the pending posting was never
  true.
- **`new_event`** → the original was true then and the world changed after, so
  it takes **its own** value date. The row worth reading out loud is
  `ach_transfer.updated/returned`: the payment really did settle on Monday and
  the RDFI really did return it on Thursday. Booking the return at Monday's
  value date would erase a settlement that occurred and make an already-issued
  statement disagree with the customer's own bank.

Get one row wrong and every past statement it touches is silently corrupted
while all five invariants still pass, which is why each row carries its own
`note` explaining the choice.

Two shapes worth knowing about in this table:

- **Lithic sends one webhook type for the whole card lifecycle.** Every step
  arrives as `card_transaction.updated`, with the actual step in the nested
  `events[].type`. The primary key is `(provider, provider_event_type)`, so the
  key here carries both — `card_transaction.updated/CLEARING` — or the entire
  card lifecycle would collapse into one ungovernable row. Increase's
  `ach_transfer.updated` has the same problem (there is no
  `ach_transfer.returned` category) and gets the same treatment.
- **The `base` rows are not third-party webhooks.** Our own chain watcher
  synthesises them from transaction receipts. They are registered here anyway
  so the value-date rule for USDC is reviewed in the same place, and by the
  same test, as the rule for a rail somebody else operates.

---

## How it is idempotent

Every row's primary key is a **UUIDv5** over a fixed namespace and a stable
natural name — `business:ridgeline-robotics`,
`account:corgi-bank:2100:house`, `actor:staff.controller`. The same input
always produces the same uuid, so the second run inserts exactly the rows the
first run inserted, and every `INSERT` is `ON CONFLICT DO NOTHING` **with no
conflict target**, which makes *any* unique violation a no-op: the primary key,
`account_code_scope`, `approval_policy_version`, `fap_version`. Running the
seed twice does not double anything, and the summary says `no change` on the
second run.

Deterministic ids buy something that matters more than the idempotence:
`account.parent_id` and `account.business_id` are **computed, not looked up**.
There is no SELECT-then-INSERT anywhere in this script, so there is no race
between two statements and no ordering requirement beyond the foreign keys.
`chart.ts` lists parents before children, so the seed inserts the tree in the
order it reads it.

The one exception is `rail_event_semantics`, which is `ON CONFLICT … DO
UPDATE`. It is pure reference data, it carries no append-only trigger, and a
wrong row silently corrupts every statement it touches — so re-seeding must be
able to carry a correction rather than leave the wrong row standing. The upsert
is still idempotent; it reports `no change` on a re-run by checking
`xmax = 0`.

The whole seed is **one transaction**. A failure writes nothing.

---

## What it does not do

**It posts no journal entries. Not one.** `journal_entry` and `journal_line`
are left empty.

Seeding money is the posting path's job (`src/lib/ledger/post.ts`). A seed that
hand-wrote journal rows would be a second, unverified write path around
`ledger_append()` — which is the only sanctioned way money enters this system,
and the only thing that assigns `booking_seq` under the append lock, forces
`booking_time` monotonic and extends the tamper-evident hash chain. DESIGN §14
exists to prevent exactly that second path. Every table this script touches is
reference data.

The summary prints `journal_entry rows: 0` at the end for that reason: it is
the seed asserting what it did *not* do.

---

## After seeding

```bash
pnpm db:check     # proves the invariants and the privilege model, as corgi_app
```

`db:check` connects as `corgi_app` and attempts the forbidden thing. It should
report 14 of 14 passing against a freshly seeded, money-free database.
