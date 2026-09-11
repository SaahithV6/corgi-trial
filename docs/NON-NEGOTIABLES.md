# The ten non-negotiables, measured

Every verdict below was taken against **commit `463488a`**, deployed at
<https://corgi-trial-psi.vercel.app>, and against the live book, between
**22:36Z and 22:45Z on 2026-09-11**. Nothing here is carried forward from an
earlier reading. Where a number disagrees with another document in this repo,
the number here is the newer one and the other document is stale — that
disagreement is itself a finding and is called out where it happens.

This document does not grade the build. It asks one question of each rule:

> **Would a reasonable engineer, told only this repo's own disclosure, correctly
> predict what happens when they press the button?**

If yes, a limitation is a **decision**. If they would be surprised, it is a
**defect wearing a disclosure** — and that category has its own verdict below,
because it is the specific thing this audit was asked to find.

**Verdicts used:** `HOLDS` · `PARTIAL` · `FAILS` · `DISCLOSURE COVERING A DEFECT`

---

## Scoreboard

| # | Rule | Verdict |
| --- | --- | --- |
| 1 | Deployed, with demo credentials for two roles | **DISCLOSURE COVERING A DEFECT** |
| 2 | You wrote the ledger | **HOLDS** |
| 3 | Two integrations genuinely live | **HOLDS** |
| 4 | Webhooks done properly | **HOLDS** |
| 5 | The correction test | **PARTIAL** |
| 6 | Approvals above a threshold | **PARTIAL** |
| 7 | Reconciliation is a feature | **HOLDS** |
| 8 | An agent surface, implemented | **PARTIAL** |
| 9 | Money is never a float | **HOLDS** |
| 10 | A decision log written as you go | **HOLDS** |

| Automatic fail | Verdict |
| --- | --- |
| Localhost only, or a video in place of a URL | **HOLDS** (URL live; the video does not exist — see §AF1) |
| A simulated integration presented as live | **HOLDS** |
| UPDATE or DELETE on money rows | **HOLDS** (three blemishes named, none a breach) |
| Live-mode keys, real money, real personal data | **HOLDS** |
| Secrets committed to the repo | **FAILS** — as the rule is written. §AF5. |
| Code that cannot be explained line by line | **NOT MECHANISABLE** — not checked, and not claimed |

---

## The headline

**Every write on the deployed system answers `401 SIGN_IN_REQUIRED`, and the
submission email tells the panel there is no login.**

```
$ curl -s -o /dev/null -w "%{http_code}" -D- -X POST https://corgi-trial-psi.vercel.app/accounts
HTTP/2 401
x-corgi-authz: deny; SIGN_IN_REQUIRED
```

That refusal is correct engineering and it is documented — `docs/AUTH.md`,
written today at 15:11, explains the shared `CONSOLE_PASSWORD` and argues the
trade well. The defect is the **handover**. Two documents a grader actually
reads still describe the previous world:

- `thread/freeze_submission.md`, the email itself: *"There is no login and no
  password."* It then instructs the panel to *"Raise a payment as Staff, then
  switch to Approver to clear it."* Both writes. Both now 401.
- `docs/DEMO.md` §1: *"The ops console is open. No email, no password, no magic
  link."* and *"There is no login."*

Neither document carries the passphrase. The deployed `/signin` page names the
variable (`CONSOLE_PASSWORD`) but not its value, which is correct — the value
belongs in the email, and the email says there isn't one.

**The measured consequence** is that the repo's own end-to-end proof no longer
runs. `scripts/coreloop.mjs`, the seven-leg drive of the money path, went from
its last recorded `PASS 7 · FAIL 0 · SKIP 0` to:

```
  PASS 1    FAIL 3    SKIP 3    of 7 legs    23s    87 HTTP calls
   1  FAIL  KYB gate                     the gate POST answered 401
   2  FAIL  Fund from a linked bank      the funding POST answered 401
   3  FAIL  Issue a real (sandbox) card  the issue-card POST answered 401
   4  SKIP  Authorise $50, settle $73.40 leg 3 produced no card token
   5  SKIP  Outbound payment, 2nd approver
   6  SKIP  Reversed settlement, corrected figure at original value date
   7  PASS  Reconcile the scheme file    11/11 checks
```

This is the single most important thing in this document, and it is why rules
1, 5 and 6 are not green.

**A second-order defect sits on top of it.** `coreloop.mjs` does not know the
passphrase exists, so it attributes the 401 to the *KYB gate* and prints:

```
  WHY THIS BUSINESS — the deployed gate was asked, live, before anything else ran
    REFUSED  NO_STATE(401)  Ridgeline Robotics, Inc.   approved/manual, 2 leg(s), 1 live
    …
    The gate allows NO business on this book right now.
```

`NO_STATE(401)` is `coreloop.mjs:1040`'s own fallback label for *"the response
carried no state code"*. A reader is told the **KYB gate** refuses every
business on the book. It does not. The **auth middleware** refuses every
anonymous write, before the KYB gate is ever consulted. A panel reading this
output diagnoses the wrong subsystem — and diagnosing in front of the panel is
15 points of the rubric.

---

## 1. It is deployed, with demo credentials for at least two roles — **DISCLOSURE COVERING A DEFECT**

**The URL holds.** Not localhost, not a video.

```
$ curl -s https://corgi-trial-psi.vercel.app/api/health
{"status":"ok","service":"corgi-neobank","checkedAt":"2026-09-11T22:38:33.180Z",
 "commit":{"shortSha":"463488a"},"database":{"reachable":true,"latencyMs":13},
 "integrations":{"live":7,"total":7}}
```

Note that health now reads **`ok`**, not the `degraded` that
`docs/REMAINING.md` and `thread/freeze_submission.md` both still warn about.
Those two documents are stale in the safe direction.

**The two roles hold as a read distinction:**

| Request | Answer |
| --- | --- |
| `GET /accounts` anonymous | `200` |
| `GET /accounts` `-b corgi_demo_role=staff` | `200` |
| `GET /accounts` `-b corgi_demo_role=customer` | `403` |
| `GET /client` | `200` |
| `GET /signin` | `200` |

**What a reader would wrongly predict.** Told only the submission email, an
engineer predicts they can sign in as Staff, raise a payment, switch to
Approver, and clear it. What actually happens is that the role switch is itself
a server action — `setRoleAction` in `src/app/(app)/actions.ts`, a POST — and
so is every control on every screen. All of them answer `401
SIGN_IN_REQUIRED`. The panel can read the entire book and cannot perform one
write, and nothing they were handed tells them why or how to fix it.

The rule asks for *demo credentials for at least two roles*. What exists is a
credential for **one** role (the operator passphrase, undisclosed to the
grader) plus a role **switch** that requires that credential to operate. The
customer surface at `/client` genuinely needs no credential and genuinely
renders — that half is real.

**This is not a disagreement about whether a passphrase is right.** It is
right, and `docs/AUTH.md` argues it better than most production systems
document their own auth. It is that the gate shipped at 15:23 and the two
documents that hand the system to a stranger were last touched at 14:26 and
never updated.

---

## 2. You wrote the ledger — **HOLDS**

Double-entry, append-only, immutable, and every balance re-derivable — proved
by folding the book from its own facts rather than by reading a stored column.

```
$ node scripts/rebuild.mjs
  FACTS FOLDED   accounts 55 · journal entries 5307 · journal lines 10622
                 holds 1240 (354 closed, 3 closure reversed) · statements 62
  OK  every entry sums to zero, per currency          5307 entries
  OK  settled ledger balance, every account           55 accounts at 2026-09-11 / seq 12294
  OK  available balance and its five terms            7 customer deposit accounts
  OK  trial balance, per entity and per book          2 (entity, book, currency) groups
  OK  statement content hash, re-rendered from the journal   62 published statements
  OK  every settled lithic delivery is present in the book   995 deliveries
  14 checks · 0 rebuild disagreement(s) · 3090 ms
```

**"Including as it stood on any past date" holds structurally.** The balance
function takes both axes and is called, not copied:

```
ledger_availability(value date 2026-09-11, booking seq 12294) — the one definition, called not copied.
INCLUDES lines dated on or before that day and booked at or under that seq, and the holds live then;
EXCLUDES later-dated lines — their DEBITS return as PENDING OUT, their CREDITS are not money today.
```

`confirm.mjs` measures the axes exist and are used in anger: *"journal_entry
carries 3/3 axes; 310 value dates were booked on a later day."* That is the
bitemporal property with a population attached, which is the right way to state
it.

**The disclosed limitation is a decision, not a defect.** Only `/statements`
accepts `?asOf=&asKnownAt=`; there is no console-wide time slider. A reader
told that predicts exactly what happens: the model supports any past date, one
screen exposes it. `docs/REMAINING.md` §3 says so in those words.

**Every external money event lands as a journal entry** is separately proved by
`evidence.mjs`: *"every settled lithic delivery is present in the book — 995
`card_transaction.updated` deliveries marked done"*, and *"the stablecoin leg is
booked as a double entry in USD cents like any other rail"*.

**The 15 fact-vs-fact disagreements `rebuild.mjs` reports are not ledger
errors** and the script says so itself: they are `hold.expires_at` vs its
authorisation's, *"two separate clock reads at insert time"*, ~150 ms apart,
for holds expiring seven days from now. `0 rebuild disagreement(s)` is the
number that answers this rule. The script's own framing — *"a mismatch is NOT
evidence that the rebuild is wrong"* — is honest and correct.

---

## 3. At least two integrations genuinely live — **HOLDS**

Seven of seven, each carrying the call that earned the label, re-proved at read
time (`ageSeconds: 0`):

| Slot | Provider | Evidence at 22:38:33Z |
| --- | --- | --- |
| `card_issuing` | Lithic sandbox | `GET /v1/cards -> 200`, 213 ms |
| `card_webhooks` | Lithic | subscription `ep_3J8yb9xommtOdKee1FzpUA4GBrW` **enabled at `https://corgi-trial-psi.vercel.app/api/webhooks/lithic`**; latest delivery SUCCESS, **our endpoint answered HTTP 202 at 2026-09-11T22:00:18.060Z** |
| `director_kyc` | Stripe Identity | enabled (Persona not configured) |
| `business_registry` | GLEIF LEI | `GET api.gleif.org /v1/lei-records/{lei} -> 200 (Apple Inc.)` |
| `open_banking` | Plaid | live |
| `ach_rail` | Increase | live |
| `stablecoin` | Base Sepolia | live |

The `card_webhooks` row is the one that satisfies *"real webhooks received by
your deployed system"* without argument: the subscription points at the
production URL, and the provider's own delivery log records our deployment
answering 202 thirty-eight minutes before this reading.

**The labelling is clean.** The repo's own claim auditor finds no gap between
what the endpoint says and what the documents say:

```
$ node scripts/audit-claims.mjs
truth: 7 of 7 live
  live:      card_issuing, card_webhooks, director_kyc, business_registry, open_banking, ach_rail, stablecoin
  simulated:
no document contradicts the endpoint
```

**GLEIF is a substitution and is labelled as one on the endpoint itself** —
*"GLEIF is a substitution for Middesk / Persona KYB / Sumsub KYB, all gated"*.
A reader told that predicts correctly: a real registry lookup against a real
third party, standing in for a KYB vendor that will not open a sandbox without
a sales call. That is a decision, disclosed at the point of claim rather than
in a footnote. `docs/REMAINING.md` still calls this slot "simulated" in its gap
table; the endpoint and `audit-claims.mjs` both say live. **The endpoint is
authoritative** by the repo's own standing rule, so `REMAINING.md` is the stale
one.

---

## 4. Webhooks done properly — **HOLDS**

The strongest area of the build, and the one where the evidence is strictly
better than the claim.

```
$ node scripts/evidence.mjs
  PROVEN  all 1940 stored deliveries carry signature_verified_at
  PROVEN  one delivery, one row — enforced by UNIQUE (provider, provider_event_id)
  PROVEN  every delivery Lithic logged as sent is a row in our inbox, matched by the id we returned to Lithic
  PROVEN  refusals are recorded with reason codes, including signature_mismatch WITH a signature present
  PROVEN  no unsigned body was accepted by any endpoint
  PROVEN  a signed delivery sent more than once produced exactly one inbox row
  PROVEN  a replay of a 2379s-old signed delivery is refused as timestamp_outside_window
  PROVEN  content the signature does not cover is refused 401 signature_mismatch and is not ingested
  PROVEN  the refusal this run just caused is readable back out of the database
  PROVEN  every event in this authorisation arrived on a signature-verified delivery
  21 proven, 1 not proven, 22 claims checked.
```

- **Signatures verified** — all 1940, not a sample. The eighth line is the one
  that matters most: content *outside* the signed envelope is refused, which is
  the attack a naive verifier passes.
- **Idempotent, twice is one** — `UNIQUE (provider, provider_event_id)`, proved
  by sending the same signed delivery twice in this run.
- **Replay refused** — a 2379-second-old signed body is rejected on the
  timestamp window, so a captured-and-replayed delivery does not land even
  though its signature is valid.
- **Out-of-order tolerated** — and the honest case proves it. A **$10,000.00
  inbound ACH credit is deliberately unbooked** because no row on the book
  identifies whose `account_number_id sandbox_account_number_96mzhz3n61f5p0jpvytc`
  is. The consumer parked rather than guessed. `REMAINING.md` calls this *"this
  requirement working"* and that is the correct reading, not a euphemism: a
  reader told "the consumer refuses to guess an owner" predicts exactly the
  $10,000 sitting parked.
- **Polling is a fallback** — the drain cron is daily because Vercel Hobby caps
  it there, with an `after()` nudge for latency and the row staying `pending`
  until a consumer succeeds. Disclosed in `REMAINING.md` §2 and predictable.

The one `NOT PROVEN` is honest and unrelated to this rule: *"the most recent
real authorisations DECLINE — the sandbox account's daily cap is exhausted."*

---

## 5. The correction test — **PARTIAL**

**The mechanism is real and is in the schema.** Corrections are appended, never
edited:

- `db/migrations/0011_hold_closure_reversal.sql` creates a reversal table that
  is itself `BEFORE UPDATE OR DELETE` protected. Three rows stand in it today —
  the repair of the stale memo holds was done by reversal, and `rebuild.mjs`
  independently folds `holds 1240 (354 closed, **3 closure reversed**)`.
- `rebuild.mjs` re-renders all **62 published statements** from `journal_line`
  at each statement's own watermark and the content hashes match, which is the
  "the statement still reconciles" half.
- `dbcheck.mjs --prove` demonstrates the guard that catches a statement figure
  that stops re-deriving, by making it fail on purpose.

**The named half that does not work: the test cannot be driven.** Leg 6 of the
core loop — *"Survive a reversed settlement: corrected figure at the original
value date"* — did not run:

```
   6  Survive a reversed settlement: corrected figure at the original value date   SKIP
      0 checks held before the leg stopped  ·  0.0s
      waiting on: leg 3 produced no card, so there is no transaction to correct
```

Leg 3 produced no card because its POST answered 401. So on the shipped commit,
the correction test's end-to-end proof is dead for the same reason everything
else is. The last recorded pass — *"Tuesday's figure changed and Wednesday's
belief is still reproducible… Nothing was rewritten"* — is from **16:28Z, on an
earlier commit**, and `docs/REMAINING.md` still quotes it as current.

`A SKIP is not a pass`, in the script's own words printed under its own
scoreboard. That sentence is the reason this is PARTIAL and not
`DISCLOSURE COVERING A DEFECT`: the tool refuses to round its own skip up. The
document that quotes it is the stale part, not the tool.

---

## 6. Approvals above a threshold — **PARTIAL**, and `confirm.mjs`'s row on it is a disclosure covering a defect

**The mechanism is enforced in the database, not on a screen.** That part is
genuinely proved:

```
$ node scripts/evidence.mjs
  PROVEN  no released instruction was approved by its own initiator
  PROVEN  2 approvals, each recorded against the instruction's current content hash
```

`assert_maker_checker()` raises SQLSTATE `42501`, so the refusal survives an
attacker who reaches the database directly. Binding each approval to the
instruction's **content hash** is above the bar — it closes the
approve-then-amend attack the rule does not even ask about.

**The named half that does not work.** Leg 5 could not be driven, and its
reason is worth quoting in full because it is where the audit turns:

```
   5  Outbound payment needing a second approver, initiator refused by the trigger   SKIP
      waiting on: the deployed gate refuses Ridgeline Robotics, Inc. with NO_STATE(401),
      and requestPayment() re-reads that gate inside the write transaction, so no
      payment instruction can be raised for this business at all. … The maker-checker
      machinery is unaffected and unproven by this run.
```

**The disclosure covering the defect.** `scripts/confirm.mjs` prints, in a
section of its own:

```
MAKER-CHECKER
    ok   the initiator can never approve their own payment
         0 self-approvals on the whole book — enforced by trigger, not by a screen
```

`0 self-approvals on the whole book` is **true**. It is also, right now,
**vacuous** — there are zero self-approvals in part because no payment
instruction can be raised through the deployed surface at all. A reasonable
engineer reading that row predicts they can open `/payments`, raise one, and
watch the refusal. They cannot. `confirm.mjs` reports `23 pass · 0 partial ·
0 fail` on a commit where `coreloop.mjs` reports `PASS 1 · FAIL 3 · SKIP 3`,
because `confirm.mjs` measures *reads and database state* and never attempts a
write. **Two of this repo's own scorecards disagree by six legs and only one of
them says so.**

**"Neither can an agent"** is covered in §8.

The disclosed identity limitation is a decision and a good one:
`docs/AUTH.md` says plainly that `resolveActor()` is *"a seeded predicate"* and
that the database *"already enforces maker-checker on the actor… it is simply
not fed a real one."* A reader told that predicts exactly what is there.

---

## 7. Reconciliation is a feature — **HOLDS**

The only leg of the core loop that passed, and it passed completely, because it
is a read.

```
   7  Reconcile the scheme file: a planted break with its kind and its age      PASS
      11/11 checks  ·  1.1s
      GET /reconciliation  (a read; the breaks screen carries no write control and needs none)
      file          livefire-MTX1R8MG-tonight.csv   3 rows   $694.99   business date 2027-12-08
      runs          3 over this file, newest 7caf3baf-6f50-4d9e-82c6-7ca8b23282ac
      breaks        in_ledger_not_file=1
      on screen     In ledger, not in file  ref LF6-MTX1R8MG-3
                    $240.71  age -453d  closes crossed 0  severity Open  value date 2027-12-08
      reason        unmatched_reference
```

Both halves the rule asks for are present: a **job** that pulls provider truth
and diffs it (three runs over this file; `scripts/reconcile-usdc.mjs` does the
same against chain truth), and a **screen** that shows the breaks with a
category, an age, a severity and a reference. `db/migrations/0006_recon.sql`
makes `recon_run` and `recon_run_break` append-only by trigger, so a break
cannot be tidied away.

The disclosed limitation — *"the planting itself has no deployed control —
`/reconciliation` renders no write form — so this run did not plant it and does
not claim to have"* — is a decision stated at the exact moment it matters, and
a reader predicts it correctly.

---

## 8. An agent surface, implemented — **PARTIAL**

**The surface itself clears the bar with margin, and is deployed.**
`POST /api/mcp` (`src/app/api/mcp/route.ts`) is a real Streamable-HTTP JSON-RPC
endpoint on the deployed system — not stdio, not local-only. It authenticates
with a bearer token (`src/lib/mcp/auth.ts`, `MCP_AGENT_TOKENS`), rate-limits per
process, and audits **every call including every refusal** to `mcp_audit`,
setting `x-corgi-audit: degraded` on the response if that persistence fails
rather than dropping the record silently.

**Eleven tools: ten read, one write** — against a required three and one.

> read — `get_balance`, `list_pots`, `list_transactions`, `list_payees`,
> `list_standing_orders`, `list_card_controls`, `list_accruals`,
> `list_disputes`, `list_recon_breaks`, `list_agent_limits`
> write — `initiate_payment`

**The write tool genuinely lands in the human approval queue**, traced end to
end. `tool-initiate-payment.ts:405` → `gateway.queuePayment()` →
`requestPayment()` (`src/lib/approvals/instructions.ts:212`), whose only writes
are `INSERT INTO payment_instruction … ON CONFLICT (idempotency_key) DO NOTHING`
and `INSERT INTO payment_instruction_event (…, 'requested', …)`. **No journal
posting and no rail call exist anywhere on that path.** The output schema pins
the terminal state at the type level — `status: { enum:
["queued_for_human_approval"] }` and `self_approval_possible: { enum: [false] }`.
Two extra guards are above the bar: a per-token ceiling
(`ABOVE_TOKEN_CEILING`), and an explicit refusal of the `internal` rail
(`:92-104`) because its seeded policy is `threshold 0, required_approvals 0` —
the one rail that could release with nobody approving. That is a sharp catch
nobody asked for.

**"Neither can an agent" approve is the strongest single thing in this build.**
Four layers, and the claim is tested rather than asserted:

1. `db/migrations/0001_ledger.sql:97` —
   `CHECK (NOT (kind <> 'human' AND can_approve))`. An approving agent **is not
   a storable row**.
2. `assert_maker_checker()` (`:686-688`) raises SQLSTATE `42501` on a non-human
   actor, plus `:691-694` (initiator cannot approve their own) and `:698-700`
   (approve-the-content-hash).
3. `src/lib/mcp/auth.ts:315-347` refuses a human-backed token with
   `actor_not_agent`.
4. `src/lib/mcp/mcp.integration.test.ts:553-615` inserts an `approved` event as
   the real agent actor **against the live database** and asserts `42501`, then
   asserts that minting an approving agent fails the CHECK.

**The written list exists and is unusually good.** `docs/AGENT-LIMITS.md` —
twenty numbered operations, mirrored as executable data in
`src/lib/mcp/limits.ts` and served to agents through `list_agent_limits`, so an
agent can read its own restrictions. Its summary table honestly splits
*"Unrepresentable"* (the database refuses) from *"Capability-absent"* (the
function does not exist), and `limits.test.ts:76-80` fails the build if both
kinds are not present.

### The named half that does not work: four of the twenty are not enforced by code

The rule says *check the code actually refuses every one*. It refuses sixteen.
Enforcement comes in three layers — an L1 tool-name ban (`tools.test.ts`), an L2
CI grep over imports in `src/lib/mcp/*.ts` (`no-write-imports.test.ts`), and L3
database constraints. **Four sections have only L1:**

| § | Operation | What actually stops it |
| --- | --- | --- |
| **4** | Rotate, mint or read credentials | Nothing. No forbidden import, no forbidden module, no constraint. |
| **5** | Resolve or adjust a recon break | Nothing. `@/lib/recon/demo` writes `recon_break_note` and is **not** in `FORBIDDEN_MODULES`; `runReconciliation` is not a forbidden import. |
| **6** | Close a book day | Nothing. `INSERT INTO book_day` lives in `src/lib/recon/demo.ts:444` and `src/lib/statements/publish.ts`; **neither module is banned.** |
| **7** | Issue / freeze / unfreeze a card | Name-ban only. Mitigated by `issueCard`/`freezeCard` not existing yet — the capability is unbuilt, not guarded. |

Two more are weaker than their section headers imply: **§3** (`corgi_app` holds
`INSERT` on `approval_policy` at `0001_ledger.sql:840`, so a *new*
effective-dated policy row is insertable — only the retroactive change is
unrepresentable, which the doc's summary table at line 859 states correctly even
though the section header is more sweeping), and **§19** (the accrual barrel is
module-banned but `@/lib/accrual/store` is not).

**Two structural facts belong beside all of this.** L2 is a CI grep over import
*lines* in one directory — a write reached through an intermediate module
outside `src/lib/mcp/`, or through raw SQL in `gateway.ts`, is invisible to it.
And the MCP process connects as **`corgi_app`, the same database role as the web
app** (`src/lib/ledger/db.ts:20`), holding `INSERT` on every money table. There
is no agent-specific database role. The refusals that are real are real because
of CHECK constraints and triggers that bind every caller — §2, §16, §18 — not
because the agent's connection is narrower than a human's.

### The disclosure problem inside §8

`src/lib/mcp/limits.ts` gives every section an `enforcedBy` array, and
`limits.test.ts:60` fails the build if that array is empty. It **only checks
that the array is non-empty — never that the strings name anything real.** So
§5 carries `"no write path to recon_break_note exists in this module"` and §6
carries `"the book-day module is not imported by src/lib/mcp/**"`. Both are
descriptions of today's dependency graph, sitting in a field whose shape and
whose test promise machine-checked enforcement. `no-write-imports.test.ts`'s own
header says a description of the current diff "is not a control" — and these two
are exactly that, in the one field designed to hold controls.

**What a reader would wrongly predict:** that all twenty refusals are backed by
something that goes red if violated. Four are not. If someone writes
`closeBookDay()` or `resolveBreak()` next week and the gateway imports it,
**nothing fails**.

This is the second-largest disclosure-covering-a-defect in the build, and it is
narrow: the four unguarded operations are all currently unreachable because the
functions do not exist. It is a guard that has not been built, standing in a
field that says it has been.

---

## 9. Money is never a float — **HOLDS**

Measured against the schema rather than the prose:

```
$ grep -rnoE "_cents\s+(bigint|integer|numeric|double precision|real)" db/ | awk '{print $NF}' | sort | uniq -c
     95 bigint
```

**Ninety-five money columns, all `bigint`. Zero `double precision`, zero
`real`, zero `money`** anywhere in `db/`. Integer minor units, throughout.

The currency handling is stated and the rounding rule is stated at the one
place where a rate could smuggle a float in —
`db/migrations/0017_fx_quotes.sql`:

> *"There is no float anywhere in this file. A rate is a `bigint` scaled…
> `numeric` inside is an exact wide integer accumulator, never a float…
> `double precision` appears nowhere."*

and the raw provider decimal is retained deliberately:

> *"The undigested decimal the source printed. Kept so the integer beside it can
> be re-derived by hand, and so no float ever has to be trusted."*

Currency is USD cents throughout, per the brief's "Build American" rule.
`confirm.mjs` separately measures that no stored balance shortcut exists:
*"0 stored available columns on any base table; `v_balance_definition_drift` =
0"* — which is the Track 3 "derived truth, not a stored lie" test, and it is
the same discipline.

**The rounding rule is stated in full and implemented once per language.**
`research/ledger/DESIGN.md` §12: compute in `numeric(38,12)` never float (12.1);
a single value rounds **half-to-even** (12.2); a split across N uses
**largest-remainder** (12.3); ties break by ordinal then `account_id` (12.4);
the house eats the penny (12.5); sub-cent dust posts to
`2900 Rounding residual clearing` (12.6). Implemented in SQL as
`interest_round_half_even()` (`0024_interest.sql:361`, pure `bigint`, reused by
interchange at `0031:341`) and in TypeScript as `roundHalfEven()`
(`src/lib/accrual/interest-types.ts:198`, `bigint`). Not a README paragraph —
two implementations and a dust account.

**No float arithmetic touches an amount in `src/`.** `parseFloat` appears only
inside comments explaining why it is absent. No `toFixed`, no `* 100` or `/ 100`
on money. Operator input is string surgery straight to `bigint`
(`src/components/accounts/amount.ts:52` —
`BigInt(dollars) * 100n + BigInt(fraction)`), `toCents` throws on a
non-integer, non-finite or unsafe input (`src/lib/format/money.ts:56`), the
write path never converts (`src/lib/ledger/post.ts:94` sends
`amountCents.toString()` and lets Postgres cast), and the public API emits cents
as **decimal strings**, with `src/lib/api/http.ts:82` throwing if a bigint ever
leaks unserialised. Every `Math.round` in `src/` is on a duration, a latency, a
PDF layout unit or a name-match score.

Where money crosses a provider boundary as a JS `number`, each site
range-checks against `MAX_SAFE_INTEGER` and **throws rather than truncating** —
`increase/client.ts:427-433`, `wire/client.ts:294-331`, `amount.ts:68-72`.

**Two small gaps, named:** `src/lib/rails/wire/client.ts:448` —
`simulateInbound()` does `Number(args.amount.amount)` with a currency check but
**no `MAX_SAFE_INTEGER` check**, unlike its sibling `createTransfer` 120 lines
above, in a file whose own comment at `:267` claims the conversion happens "at
exactly this line and nowhere else". Sandbox-only, no customer money, but it is
the one asymmetry. And `scripts/faucet.mjs:99` and
`scripts/reconcile-usdc.mjs:146,154` do `Number(x) / 1e6` — the only float
division on money anywhere, both in console print statements with the
authoritative cents figure computed in `bigint` beside them.
`scripts/payout-usdc.mjs:203-228` does the same job in `bigint` and says so.

One cross-check worth recording: `evidence.mjs` proves *"the stablecoin leg is
booked as a double entry in USD cents like any other rail"*, so the rail most
likely to introduce a floating-point amount does not.

---

## 10. A decision log written as you go — **HOLDS**

This one is checked by reading the history, as the brief says it will be.

```
$ git log --oneline --follow -- DECISIONS.md | wc -l
37
$ git log --format="%ad" --date=iso | tail -1     # first commit in the repo
2026-09-09 17:26:33 -0700
$ git log --format="%ad" --date=iso | head -1     # tip
2026-09-11 15:23:33 -0700
$ git log --oneline | wc -l
121
```

**59 numbered entries across 37 separate commits, spanning the whole 46 hours.**
The very first commit in the repository is `e1d1759 Decision log 001: pick
Track 1 (policy administration)` — the log predates the code. The second is
`76b71ef Decision log 002: supersede 001, switch to Track 3 (neobank)`, which
is the shape that cannot be faked after the fact: a decision recorded, then
reversed, with the reversal recorded rather than the original edited away.

Entries land continuously — 09-09 17:26, 17:30, 17:36, 17:49, 17:58, 18:15,
18:22, 18:25, 18:30, 20:35, then twenty more through 09-10, through to 09-11
10:54. There is no hour-47 commit titled "add decision log". This is the
cleanest pass of the ten.

Entries are timestamped in-file as well as by commit
(`2026-09-10T20:04:50`-style stamps appear in the body), and several commit
subjects are themselves decisions recorded against measurement — *"A compliance
checker found two live secrets committed"*, *"An unprobed slot can no longer
report LIVE"*, *"7 of 7 was a lie"*. A stranger can follow it.

---

# The automatic fails, each checked explicitly

## AF1 — Localhost only, or a video in place of a URL — **HOLDS**, with a package gap

The URL is live, public, serves its own commit sha, and answers `200` anonymous
on the front door, the console and the customer surface. Nothing here is
localhost, and no video is offered *in place of* the URL.

**The gap, stated plainly because it is not a disclosure problem but a missing
deliverable:** the five-minute video **does not exist**.
`thread/freeze_submission.md` carries `3. VIDEO — [LINK — unlisted, under five
minutes]` as a literal placeholder, and item 4 of the evidence pack carries
`[LINK — shared folder, three screenshots]` for a folder that has not been
created. `docs/VIDEO-SCRIPT.md` is a complete shot list; nothing has been shot.
This is not an automatic fail — the rule punishes a video *instead of* a URL,
not a missing one — but it is a required item of the submission package and it
is unstarted.

## AF2 — A simulated integration presented as live — **HOLDS**

`audit-claims.mjs` exists precisely to catch this and finds nothing:

```
truth: 7 of 7 live
  simulated:
no document contradicts the endpoint
```

Every slot carries its proving call on `/api/health` with a `provenAt` and an
`ageSeconds`, so the label is re-earned on read rather than stored. The
substitution that could have been hidden — GLEIF standing in for a gated KYB
vendor — is named **in the evidence string on the endpoint itself**, which is
the hardest place to hide it. The repo's history shows this rule being enforced
against itself three separate times: `b79d96e A click turned a slot LIVE and
the probe believed it. 7 of 7 was a lie`, `6a84fc5 An unprobed slot can no
longer report LIVE`, `eda7db7 The stablecoin slot was claiming LIVE while unable
to send a single cent`. That is the opposite of the failure this rule names.

## AF3 — UPDATE or DELETE on money rows — **HOLDS**

Swept exhaustively: the schema, every `UPDATE`/`DELETE`/`TRUNCATE` in `src/`
and `scripts/`, and all five repair scripts. **No production code issues an
UPDATE or a DELETE against a money table, and the database would refuse it if it
did.**

**Two independent mechanisms, on every money table.**

1. **Privilege.** `0001_ledger.sql:816` —
   `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`, then `corgi_app` is
   granted **`SELECT, INSERT` only** (`:819-823`), then an explicit
   `REVOKE UPDATE, DELETE, TRUNCATE` (`:827-833`). `ledger_append()` is the only
   writer and is itself `REVOKE ALL … FROM PUBLIC`.
2. **Trigger.** `ledger_row_is_immutable()` (`0001_ledger.sql:748`) raises
   `55006` on any UPDATE or DELETE, attached by a `FOREACH t IN ARRAY` loop
   (`:758-776`) and re-applied by every later migration — `0005`/`0013`/`0018`
   (KYB legs), `0006` (recon), `0008` (card), `0011` (hold closure reversal),
   `0012` (standing orders), `0014` (card controls), `0015` (pots), `0016`
   (payees), `0017` (FX), `0019` (disputes), `0020`/`0024` (accrual, interest),
   `0031` (interchange), `0033` (team), `0042`, `0047`, `0049`, `0053`–`0055`,
   `0061`, `0065`. New tables get it by construction, not by the author
   remembering.

**Every mutation in `src/` targets an operational table, never money** —
`plaid_item_secret.retired_at`, `chaos_*`, `outbound_endpoint`/`_cursor`/
`_delivery` (each behind a directional guard trigger at `0034:353-497` making
bytes and URLs immutable and cursors forward-only). The single sanctioned
exception is `webhook_inbox` in `scripts/redrive.mjs`, where the migration
grants `UPDATE` on **three named columns only** (`processed_at`,
`processing_error`, `attempts`) and `webhook_inbox_guard()` (`0001:779-800`)
blocks any other. Every other hit in the tree is a **refusal prover** — a test
asserting the database says no.

**All five `repair-*.mjs` scripts append; none mutates.** `repair-0011` and
`repair-0028` do `INSERT INTO hold_closure_reversal … ON CONFLICT DO NOTHING`;
`repair-0036` and `repair-0048` hold no SQL write at all and read back what the
production sweeper appended; `repair-0049` posts a reversal plus a re-book
through `ledger_append` and reports both entry ids. **None of the five contains
`UPDATE` or `DELETE` as a statement.** This is the correction doctrine (rule 5)
being followed in the one place where it would be most tempting not to.

**Three blemishes, named. None is a breach of the rule.**

1. **`chaos_run` is the one table with a full `UPDATE, DELETE` grant**
   (`0029_chaos.sql:389`) and no immutability trigger. Its written
   justification at `0029_chaos.sql:62` says: *"None of the four has a 'cents'
   column, a foreign key into 'account'…"* — **and that is false.** `chaos_run`
   declares `auth_cents bigint NOT NULL` and `clearing_cents bigint NOT NULL`
   two hundred lines below (`:167-168`). The *guarantee* still holds in
   substance — these are episode script parameters, no balance derives from
   them, and `src/lib/chaos/driver.ts:543` only sets `card_registered` — but the
   written argument for the widest grant in the schema is contradicted by its
   own table. **A reader auditing by reading that comment would stop looking.**
   The fix is one sentence, not one grant.
2. **Four money-adjacent tables have the trigger but no greppable `REVOKE`
   line** — `hold_closure_reversal` (`0011:77`), `pot` (`0015:130`),
   `card_auth_event_result` (`0026:211`), `virtual_account_number`
   (`0042:184`). Still safe: `corgi_app` holds `SELECT, INSERT` only and 0001's
   blanket revoke stands. But the line a reviewer greps for is missing on four
   tables, and defence-in-depth that is only one deep reads as two.
3. **`scripts/dbreset.mjs:45` grants table-wide `UPDATE` on `webhook_inbox`**
   where the migration grants three columns. The trigger still blocks the
   difference, so nothing escapes — but a dev script drifting wider than the
   schema is the shape of how these things eventually escape. (The same script
   carries a documented self-inflicted bug at `:57-80`.)

One item outside the rule but worth recording: `scripts/seed.mjs:833` does
`INSERT … ON CONFLICT DO UPDATE` on `rail_event_semantics`, run **as owner**.
Not a money row — but it is the table that decides what a provider event
*means*, and it carries neither a REVOKE nor an immutability trigger
(`0001_ledger.sql:203`). It is the only owner-level in-place rewrite of
money-*semantics* data in the repo.

Corroborating: `rebuild.mjs:1306` states *"this script holds no UPDATE and no
DELETE"*; `dbcheck.mjs:44-48` **attempts both against the live database every
run** and asserts the refusal; and the submission email's claim that the
evidence connection *"could not have tidied anything on the way past"* is the
right property to assert and is true.

## AF4 — Live-mode keys, real money, real personal data — **HOLDS**

Every rail is a sandbox or a testnet, and each says so in its own evidence
string: **Lithic sandbox**, **Stripe Identity test mode**, **Plaid sandbox**,
**Increase sandbox** (`sandbox_wire_transfer_*` ids throughout `evidence.mjs`
output), **Base Sepolia** testnet (`USDC transfer confirmed on Base Sepolia in
block 46683447`). GLEIF is a public register queried for **Apple Inc.**, which
is a public company record, not personal data. The businesses on the book are
seeded fixtures and are named as fixtures — `Hold Fuzzer Fixture Co.`,
`Holds Integration Fixture Co.`, `Live Fire — attack 3 (bitemporal
correction)`. The subject business `Ridgeline Robotics, Inc.` carries EIN
`000000000`.

`livefire.mjs` is described in this repo as posting "real money"; that is
sandbox money on sandbox rails, and it was not run by this audit.

## AF5 — Secrets committed to the repo — **FAILS**

**Stating it without softening, in either direction.**

**It is a fail.** The rule is *"Secrets committed to the repo."* A real Plaid
sandbox access token was committed to `docs/EVALUATION.md` and is still
reachable in pushed history. The repo's own gate scores it as a fail on every
single run and refuses to exempt it — `scripts/compliance.mjs` AF5, and
`docs/COMPLIANCE.md` says of it: *"**It is still a FAIL**, and correctly so. The
rule is about the repo, and the repo includes its history."* There is no
reading of the rule as written under which this passes, and the repo does not
attempt one.

**One correction to the premise.** The brief for this audit says *three* pushed
commits. `compliance.mjs`'s re-run at 2026-09-11T09:51Z says **two** —
`467f460` and `c551b9f` — for the real token in `docs/EVALUATION.md`. A broader
pickaxe for `access-sandbox-` returns ten commits, but the other eight carry
the fixture literal `'access-sandbox-x'` or the redaction
`access-sandbox-REDACTED-ROTATED`. **Two commits hold the real value.**

**What is genuinely true in mitigation, none of which changes the verdict:**

- The token is **dead**. `compliance.mjs:1447` tests it live and reports *"a
  committed Plaid token no longer authenticates (HTTP …) — leaked, but dead"*.
- It granted access to **sandbox data that was fabricated**.
- **The tip is clean.** `git grep` for the token across all tracked files
  returns nothing. It survives only in history objects.
- It is **disclosed in at least three places** (`COMPLIANCE.md`,
  `REMAINING.md`, `SETUP.local.md` which carries the exact remediation), and
  the gate is not switched off to hide it.
- The three *other* strings the history scan flags are genuinely not secrets,
  and are excluded **by a property of the string** — base64 of a phrase that
  says it is not a secret, or one character repeated — never by exempting a
  path. That discipline is right, and it was re-tested against a throwaway repo
  where a real random `whsec_` went red.
- The decision not to purge is Saahith's, recorded, and the reasoning is sound
  on its own terms: force-pushing 71 commits including the deployed sha, hours
  before freeze, invalidates every sha cited across sixty documents, for a dead
  credential.

**The verdict.** *Disclosed* is not the same as *not committed*. The rule does
not have a disclosure exception, and this repo's own tooling is the most
insistent voice saying so. Everything in the mitigation list is an argument a
human should weigh when deciding what the fail is worth — a dead sandbox token
for fabricated data is not a breach, and the panel will almost certainly treat
it as one. **It is not an argument that the rule was met.** By the rule as
written: **automatic fail**, and the repo scores itself that way on every run.

The one thing that would be indefensible is not present: there is no attempt to
argue this into a pass, and no `.secretscanignore` entry hiding it. The gate
goes red every time.

## AF6 — Code that cannot be explained line by line — **NOT MECHANISABLE**

Not checked, and correctly not claimed. `compliance.mjs` AF6 refuses to fake
it: *"whether the author can explain a line when a grader points at it is NOT
mechanisable, and this tool will not fake a check for it."* That refusal is the
right call — a green check here would be the exact failure mode this document
exists to find. `docs/DEBRIEF.md` (2,552 lines) is the preparation; 75 minutes
of a panel driving is the only test.

---

# Where a disclosure is covering something broken

Six, ranked. Everything else in this repo's extensive disclosure apparatus —
the `RED_REGISTER`, the cut list, the `UNPROVEN` verdicts, the `NOT PROVEN`
line in `evidence.mjs`, the "A SKIP is not a pass" footer, the standing-gap
table in `REMAINING.md` — is genuine. These four are not.

### 1. "There is no login and no password" — the submission email

**What a reader predicts:** open the URL, click Approver, raise a payment,
approve it.
**What happens:** `401 SIGN_IN_REQUIRED` on every write, with no credential
anywhere in the handover. This is a defect in the highest-stakes document in the
submission, and it is the reason three of the ten rules are not green.
`docs/DEMO.md` §1 says the same thing and is equally stale.

### 2. `confirm.mjs` printing `23 pass · 0 partial · 0 fail`

**What a reader predicts:** the system was driven and everything worked.
**What happens:** `confirm.mjs` never attempts a write. On the same commit,
`coreloop.mjs` — which does — reports `PASS 1 · FAIL 3 · SKIP 3`. A scorecard
that cannot fail on the defect that dominates the build is not a scorecard. The
`MAKER-CHECKER ok` row is the sharpest instance: `0 self-approvals on the whole
book` is true and currently vacuous.

### 3. `coreloop.mjs` attributing an auth 401 to the KYB gate

**What a reader predicts:** the KYB gate is refusing every business; go look at
KYB.
**What happens:** the auth middleware refuses every anonymous write before KYB
is consulted. `NO_STATE(401)` is the script's own label for "no state code in
the response", rendered in a table headed *"the deployed gate was asked, live"*.
The line *"The gate allows NO business on this book right now"* sends a debugger
to the wrong subsystem in front of the panel.

### 4. `docs/REMAINING.md` quoting an eight-hour-old core loop as current

**What a reader predicts:** `PASS 7 · FAIL 0 · SKIP 0`, and the bitemporal
correction proven end to end.
**What happens:** `PASS 1 · FAIL 3 · SKIP 3`. The document's own opening
paragraph warns that *"this file's whole failure mode is being read as current
when it is a day old"* — and it then became the thing it warned about. Its
health verdict (`degraded`) is also stale; live health now reads `ok`.

### 5. `limits.ts`'s `enforcedBy` field on agent-limit §5 and §6

**What a reader predicts:** all twenty never-hand-to-an-agent operations are
backed by something that goes red if violated — the field is an array, the test
checks it, the tool serves it.
**What happens:** `limits.test.ts:60` checks only that the array is
**non-empty**, never that its strings name anything real. §5 carries *"no write
path to `recon_break_note` exists in this module"* and §6 carries *"the book-day
module is not imported by `src/lib/mcp/**`"* — descriptions of today's
dependency graph, in the field designed to hold controls, when
`no-write-imports.test.ts`'s own header says such a description "is not a
control". §4 and §7 have no guard either. Full detail in §8.

### 6. `0029_chaos.sql:62` justifying the widest grant in the schema

**What a reader predicts:** from *"None of the four has a 'cents' column, a
foreign key into `account`…"*, that `chaos_run`'s full `UPDATE, DELETE` grant
touches nothing money-shaped, and stops auditing there.
**What happens:** `chaos_run` declares `auth_cents bigint NOT NULL` and
`clearing_cents bigint NOT NULL` at `:167-168`. The guarantee survives — they
are episode script parameters and no balance derives from them — but the
sentence a reviewer would rely on to skip the check is false. This is the
smallest item on this list and the cheapest to fix.

**A note on the ones that are NOT in this list.** The parked $10,000 ACH credit,
the six standing red invariants, the `v_payment_release_unheld` view with no
registered proof, the daily drain cron, the absent `hold_closure` row on
over-capture, the missing console-wide time slider, the 55-of-67 uncontrolled
cards — every one of these is a limitation whose disclosure lets a reader
predict the behaviour exactly. They are decisions. Several are better disclosed
than most production systems manage. `dbcheck.mjs --prove` volunteering
*"`v_payment_release_unheld` CAN fail — NO PROOF IS REGISTERED FOR THIS VIEW —
it is trusted, not tested"* is the single best line of disclosure in the repo:
a tool reporting the one place it has nothing to say.

---

# The one thing to fix first

**Put the operator passphrase in the submission email and in `docs/DEMO.md`,
and correct the two sentences that say there is no login.**

It is a five-minute edit to two files that contain no code. It converts rule 1
from a defect to a pass, un-blocks legs 1 through 6 of the core loop, restores
the end-to-end proof of the correction test (rule 5) and of maker-checker
(rule 6), and removes the misdiagnosis in `coreloop.mjs`'s header. Nothing else
on any list in this repo buys as much.

The second fix, if there is time: teach `scripts/confirm.mjs` to attempt one
write and report the answer, so its scoreboard cannot read `0 fail` on a commit
where the money path is closed.

---

*Measured 2026-09-11, 22:36Z–22:45Z, against commit `463488a`. Commands used:
`scripts/confirm.mjs`, `scripts/dbcheck.mjs`, `scripts/dbcheck.mjs --prove`,
`scripts/rebuild.mjs`, `scripts/coreloop.mjs`, `scripts/evidence.mjs`,
`scripts/audit-claims.mjs`, `curl` against the deployment, `git log`, and reads
against `db/migrations`. `scripts/livefire.mjs` was deliberately not run.
**Zero rows were written to the book by this audit.**
No source, test or script was edited.*
