# TEST AUDIT — is the claim asserted, or asserted next to?

Written 2026-09-11, against commit `59010b5` and the live Neon database.

This is not a coverage report and there is no percentage in it. The question
asked of every subsystem was the one this build has already answered twenty-three
times the hard way:

> For each thing the code says out loud, is that thing **asserted**, or is
> something adjacent to it asserted while the thing itself goes unwatched?

The method is the one `scripts/dbcheck.mjs --prove` established. A guard is only
believed after it has been seen to go red. Where a claim could be violated, the
violating state was **constructed against the live database inside a transaction
that was rolled back**, and the result is reported with the delta. Where it could
not be, that is written down as a finding rather than as a pass.

Two rules were held to throughout: **nothing in `src/lib/**`, no migration, no
script and no existing test was modified.** Defects are reported, not repaired.
One new test file was added, and the record of it being made to fail is in §7.

---

## 1. THE TWENTY-FOURTH

**`db/migrations/0033_team.sql:309-322` and `:818-831` — being removed from a
team does not fail the authorship check. It passes it.**

### The claim

0033 §9 states removal's whole meaning, twice:

> `-- What DOES stop is the future` (`:995`)

> `(2) A MEMBER WHOSE CURRENT ROLE DOES NOT CARRY approve_payment CANNOT
> APPROVE, whatever actor.can_approve says. This is the narrowing that makes
> removal real: a removed member's actor row still says can_approve, because
> actor rows are append-only and 0001 owns that column. Their membership says
> removed, **and this is where that stops being a label.**` (`:556-562`)

And `src/app/(app)/team/actions.ts:35-40` hands the whole question to the
database on purpose:

> `THE AUTHORISATION IS IN THE DATABASE, NOT HERE. Whether the actor may
> administer this team is decided by team_add_member() and by
> assert_team_member_version(). This file does not check it, deliberately: a
> check here would be a second copy of the rule`

### The guard

`assert_team_member_version()`, clause (d) — the only thing standing between an
unauthorised actor and a team member's terms:

```sql
  -- (d) authorship
  SELECT tmc.role INTO v_author
    FROM team_member tm
    JOIN v_team_member_current tmc ON tmc.member_id = tm.id
   WHERE tm.business_id = v_member.business_id
     AND tm.actor_id    = NEW.created_by
     AND tmc.state <> 'removed'          -- <<<<
   ORDER BY tm.membership_seq DESC
   LIMIT 1;

  IF v_author IS NOT NULL AND NOT team_role_can(v_author, 'administer_team') THEN
    RAISE EXCEPTION 'actor % is a % of this business and cannot change a member''s terms; …'
```

`team_add_member()` carries the identical lookup and the identical gate at
`:818-831`, refusing with `'… cannot add members'`.

`v_author IS NULL` is the **Corgi-staff break-glass branch**, and 0033 says so
at `:250-252` and `:817` — "an admin of this business, or Corgi staff". Staff
carry `business_id IS NULL`, so they match no `team_member` row, so the lookup
returns NULL and the check is skipped. That is correct and intended.

But `tmc.state <> 'removed'` means the lookup **also** returns NULL for a
removed member of this very business. Removal does not fail the authorship
check. It moves the actor out of the branch that checks and into the branch
that trusts.

**What the guard excludes from its own lookup — members whose state is
`removed` — is exactly the population it exists to stop.** Removal is *how* an
actor loses authority over a team; it is the one state where the check matters
most, and it is the one state the check cannot see.

### Made to fail, against the live database

Both halves, in `sql.begin()` transactions that ended by throwing. Nothing was
left behind (verified after each by re-reading the table).

**(a) A removed admin changes another member's terms.** Corgi staff removes Alex
Whitfield, the customer's own admin signer on Ridgeline. The removed Alex then
authors a promotion:

```
staff : Dana Okonkwo
admin : Alex Whitfield v1
victim: Noor Haddad v1 approver
after removal, admin state = removed

>>> THE REMOVED ADMIN WAS ALLOWED TO AUTHOR IT. victim is now active admin

(rolled back)
rows left behind: 0
```

**(b) A removed admin adds a brand-new member.** Same setup, through the
definer function the application actually calls:

```
Alex Whitfield is now: removed
>>> ALLOWED. A removed admin created a new active approver with actor.can_approve = true
Audit Ghost rows left behind: 0
```

### Why this is worse than an authorisation hole

`actor.can_approve` is set from the role at creation and `actor` is append-only
— 0033 `:302-306` refuses any later widening, and says why. The one moment that
column is decided is inside `team_add_member()`. So (b) is not "a removed person
edited a row". A removed admin **minted a fresh approving principal**: a new
`actor` with `can_approve = true`, an active `approver` membership, and a live
claim on the second pair of eyes that the entire maker-checker control rests on.

Removal is supposed to be the remedy for a compromised or departed signer. Here
it is the qualification.

### Why twenty-three passes did not find it

The same two reasons, and they are the two shapes in this file's brief.

**The fixture hardcodes the field the gate dispatches on.** Every one of the 17
membership writes in `src/lib/team/team.integration.test.ts` passes
`actorId: STAFF` — defined at `:78` as "Dana Okonkwo — Corgi staff, the
bootstrap author", `business_id IS NULL`. That is the NULL branch by
construction. The suite has never sent a non-NULL author into either function,
so neither the refusal arm nor the hole beside it has ever been reached. `grep`
for `cannot add members`, `cannot change a member`, `administer_team` and `is
not a human actor` across every `*.test.ts` in the repository returns nothing.

**And the product cannot reach it either.** `src/lib/approvals/session.ts:70-78`
resolves the console session with `WHERE kind = 'human' AND business_id IS NULL`
— always Corgi staff, deliberately (`:65-68` explains the choice, and the choice
is right). So no caller the system has has ever driven the branch. The check is
live, correct-looking, quoted by `actions.ts` as the reason there is no
TypeScript copy of it, and it has never once executed.

### What a reviewer sees

`db/migrations/0033_team.sql`, lines 309-322 and 818-831. In both, delete
`AND tmc.state <> 'removed'` / `AND c.state <> 'removed'` and the NULL branch
narrows to what its comment says it is: Corgi staff, who have no membership row
at all. A removed member then resolves to their terminal role and is refused by
the line below, which is the behaviour `:556-562` claims. **Not applied here —
this is a report.** It is one line in each of two functions, it is inside an
already-applied migration, and it needs its own rolled-back proof and a test
before it goes near a demo.

---

## 1b. THE SAME SHAPE, FOUND FOUR MORE TIMES

The brief asked for the twenty-fourth. Honestly reported: the shape is not down
to one. Four more instances were found, each matching the pattern exactly —
**what the guard excludes is shaped like the failure it exists to catch.** §1 is
the headline because it is the only one with a proven, live, exploitable
consequence; these are the same defect class and two of them are purer examples.

**(i) The holds fuzzer's alphabet, and the completeness test that enforces the
omission.** `fuzz-generators.ts:139` is headed *"Every kind in
`card_event_kind`"* and lists eight of the enum's nine. The missing one,
`declined`, is the **fifth most common kind on the live book** (74 rows) —
commoner than two kinds the fuzzer does generate. The guard against exactly this,
`fuzz.test.ts:1468` (*"generates every kind in the vocabulary"*), is a hardcoded
array of the same eight names compared with `toEqual`, so **adding the missing
kind turns the guard red.** It does not merely fail to notice the blind spot; it
holds it in place. This is the purest instance in the build.

**(ii) `prefixLeak()` cannot return a value under the failure it detects.**
`point.ts:353` subtracts `requestedKnownAt` from the booking time of the entry
**at** the watermark — a row selected by `booking_time <= t`, so the difference
is `<= 0` by construction. The leak it hunts lives one row *below* the cut. The
doc says *"It renders nothing today, and would render something the day that
changes"*; it renders nothing on every possible day. Demonstrated on a synthetic
book. Nothing asserts it. See **timetravel** in §3.

**(iii) The MCP write-capability guard exempts the one barrel that reaches the
writer.** `no-write-imports.test.ts`'s `FORBIDDEN_MODULES` lists
`@/lib/approvals/release` and omits `@/lib/approvals`, and a test at `:200-213`
explicitly *blesses* the exemption on the "one binding" argument that the same
file declares insufficient for two other modules. The barrel does reach
`ledger/post.ts`, and the minified `postEntry` is present in the built
`/api/mcp` chunk. See **mcp** in §3.

**(iv) The chaos dashboard's list-sync parser reads the first array only, and
compares names while the claims drift.** It is green today while the screen
renders the pre-0032 sentence beside a live $9,786.20 red — asserting that the
network refused 154 authorisations when it answered none of them. `dbcheck.mjs`
carries three separate written confessions of this parser being slipped past. See
**chaos** in §3.

And **§6** is the fifth, one level up: the mechanism written to catch guards that
range over nothing is itself a hand-typed list that cannot notice a guard it was
never told about.

---

## 2. THE META-FINDING: what "green" does not run

Measured on this machine, with `.env` loaded exactly as specified:

```
Test Files  143 passed | 39 skipped (182)
     Tests  2546 passed | 371 skipped (2917)
```

**371 tests — 12.7% of the suite — do not run, and they are not a random
12.7%.** `RUN_DB_TESTS` gates 103 sites; `.env` sets it nowhere. Neither does
`.github/workflows/ci.yml`, which runs bare `pnpm test`.

Every skipped file, by what it was written to prove:

| skipped suite | tests | the claim that stops being checked |
| --- | --- | --- |
| `approvals.integration` | 13 | maker-checker at the database — the self-approval refusal, SQLSTATE and message |
| `team.integration` | 25 | both team invariants, the removal semantics of §1 |
| `holds.integration` | 12 | the hold model under hostile sequencing |
| `ledger.integration` | 10 | append-only, balance derivation |
| `statements.integration` | 6 | a closed day reproducible forever |
| `timetravel.integration` | 11 | bitemporality — the graded differentiator |
| `interchange.integration` | 14 | the three "should this entry exist" guards |
| `payees.integration` | 32 | the gate that failed open for its whole life |
| `fx.integration` | 22 | the only enforcement point for "the customer agreed a price" |
| `mcp.integration` | 20 | the agent write tool landing in the human queue |
| `api.integration` | 23 | the public API surface |
| `cards.integration`, `advice-wake` | 20 | authorisation lifecycle |
| `accrual`, `interest` | 21 | fee and interest posting |
| `disputes`, `pots`, `standing`, `onboarding`, `audit` | 39 | per-subsystem lifecycle and refusals |
| `wire.integration`, `wire/outbound` | 11 | the wire rail end to end |
| `increase/observe`, `increase/probe`, `plaid/funding` | 12 | live-rail observation |
| `chaos.livefire`, `events/roundtrip.live` | 11 | degradation and outbound delivery |
| `cards/panel.render`, `team/screen.render`, `holds/completion`, `pots/demo` | 19 | screen states |
| **`src/test/livefire/attack-01` … `attack-08`** | **22** | **every published live-fire scenario** |

This is not an accusation of dishonesty — the gating is deliberate, documented,
and keeps CI secret-free, which is correct. The finding is narrower and it is
the same finding as everything else in this file:

**"2,546 green" is an assertion standing next to the claim it appears to make.**
It is a true statement about the pure functions, the parsers, the formatters and
the render fixtures. It is silent about every claim whose falsity requires a
database to observe — which is every claim in the domain gauntlet. The number
that answers "does the ledger hold" is `RUN_DB_TESTS=1 pnpm test`, and nothing
in the repository runs it.

Two suites were re-run with the flag during this audit (approvals + audit,
97/97; the FX and recon suites in place) and they pass. The gap is that nothing
makes them.

**Recommendation, not applied:** say the real number out loud in the debrief —
"2,546 without a database, 2,917 with one, and here is the command" — rather
than letting the smaller number carry the larger claim. A grader who runs
`pnpm test` and a grader who reads `docs/` are currently reading two different
systems.

---

## 3. PER SUBSYSTEM

Format: **claim** → *what asserts it* → **can that assertion fail?**

### ledger

**"The SQL view and the TypeScript function cannot drift — they are compared
term by term"** (`docs/BALANCE-DEFINITIONS.md` §5) →
`ledger.integration.test.ts:276` → **two of five terms are compared, and the two
excluded are the only two that are genuinely two bodies.** The test SELECTs six
columns and asserts on `ledger_balance_cents` and `pending_outbound_cents`;
`card_hold_cents`, `uncleared_credit_cents` and `available_cents` are selected
and never compared. Its third assertion —

```ts
expect(fromFunction.ledgerCents - fromFunction.holdsCents
  - fromFunction.unclearedCents - fromFunction.pendingOutboundCents)
  .toBe(fromFunction.availableCents);
```

— re-adds the arithmetic `ledger_availability()`'s own final SELECT already
performed, from a single row of that function. It restates the implementation
instead of crossing the seam.

**`v_balance_definition_drift` MUST RETURN ZERO ROWS** → `:319` → **half of it
cannot be true.** 0022:356's second disjunct is

```sql
OR ab.available_cents <> (ab.ledger_balance_cents - ab.active_holds_cents - ab.pending_outbound_cents)
```

and all four columns come from the same `ledger_availability()` row in
`v_available_balance` (`:294`), where `available_cents = L − H − U − P` and
`active_holds_cents = H + U`. Same tuple, exact `numeric` ⇒ `X <> X`. Verified
live: the disjunct could fire on 0 of 7 rows. Disjunct 1 is real and worth
keeping; the migration presents disjunct 2 as an independent second check and it
is a comment.

**`available = ledger − holds − uncleared − committed`** →
`queries.test.ts:196` → **no change to any source file can make it red.** The
fixture hands `accountAvailability` five literals the author reconciled by hand
(`4961613 − 41100 − 1375300 − 3721200 = −175987`) and the test then re-adds them.
`accountAvailability` is a field-for-field copy out of `rows[0]`; the comment
says the identity "closes in Postgres", and Postgres is not in this test. The
same non-assertion appears twice more (`queries.test.ts:238`,
`components/account/live-data-source.test.ts:404`). The real coverage is
`ledger.integration.test.ts:333,351` — future-dated credit and debit as clean
before/after deltas — and those are sound.

**`boundary.test.ts` — "every module that reads these tables has its own answer
to what a balance is"** → `:96` →
`/(FROM|JOIN|INTO|UPDATE|TABLE)\s+(journal_entry|journal_line|account)\b/` →
**blind to every view over those tables.** `SELECT … FROM v_available_balance`
is a second answer to what a balance is and the ratchet cannot see it; three
live `JOIN v_card_auth_hold` / `JOIN v_hold_state` uses outside `src/lib/ledger`
count as zero references against the allowlist.

**Untested entirely:** `src/lib/ledger/readers.ts` — 1,694 lines, 24 exports, no
`readers.test.ts`. `mostActiveDepositAccountId`, `entityBookingWatermark`,
`highestBookingSeqAffecting`, `listRailControlEntries` and `countPostingsForDays`
are referenced by zero test files. `post.ts`'s zero-amount-line refusal (`:81`)
is cited by five other modules as behaviour they depend on and driven by nothing.

**Sound:** `chart.test.ts` (27 cases, properties derived over the whole `CHART`,
refusals driven) is the cleanest file in the audit.

### holds

**"H is a function of the event SET, not the order"** → `model.test.ts:200` (all
`n!` orders) and the `fuzz.test.ts` permutation corpus → **yes, genuinely
strong.** So are `terminallyClosed` monotonicity (`fuzz.test.ts:715`, with the
`legacyViolations > 0` pairing that defends against a quiet corpus), the TS
`closed(E)` ≡ `v_card_auth_hold.is_closed` cross-body check over every row
(`holds.integration.test.ts:955`), and `completion.test.ts`, which drives
`v_hold_drift` 0→1→0 from the state a killed process really leaves. The release
races assert **identities** (`[0n, −6000n]`), not counts. Money is measured as
deltas throughout. This subsystem is the best-defended in the build.

**Which makes its one blind spot the sharpest finding in the audit after §1.**

`fuzz-generators.ts:139` is headed *"Every kind in `card_event_kind`"* and lists
eight. The live enum has nine. Measured on the book:

```
authorization 508 · clearing 303 · force_post 118 · refund 114 · expiry 85
declined 74 · authorization_reversal 41 · incremental_authorization 8 · close 0
```

**`declined` is the fifth most common event kind on this book** — commoner than
two kinds the fuzzer does generate — and `close`, which it does generate, has
zero rows. Rarity is not the reason.

And the guard that exists to catch exactly this, `fuzz.test.ts:1468`
(*"generates every kind in the vocabulary"*, commented *"A corpus that never
emits a force_post is a corpus that never tests one"*), is a **hardcoded array of
the same eight names compared with `toEqual`.** It cannot notice the unlisted
kind — and because the comparison is exact, **adding `declined` to the generator
turns this test red.** The guard does not merely fail to catch the omission; it
holds it in place.

Three more hardcoded kind lists repeat it: `model.test.ts:404`,
`corrections.test.ts:57`, and `fuzz.test.ts`'s `DB_STEPS`. So
`docs/HOLDS.md` §7.4's claim — *"A kind in none of those lists feeds A(E), C(E)
and closure exactly nothing — in both implementations, by construction"* — is
never exercised by the 6.25M-ordering fuzzer, and the interaction it names (an
authorisation whose only event is a refusal, closed by the `A ≤ 0` arm) is a set
the generator cannot produce. `declined` is covered only incidentally, by
`holds.integration.test.ts:955`.

**`"every invariant view is still empty"`** (`holds.integration.test.ts:998`) →
**checks 5 of the ~11 this module owns.** The hardcoded list keeps
`v_hold_drift` and drops `v_hold_release_drift` — its own complement, which
exists *because* migration 0011's bug set `is_released`. The half retained is
precisely the half blind to that bug, under a title that says "every".

**Unwatched refusals:** `apply.ts:550` (`unclassified_step` — carrying the
all-or-nothing claim *"acting on the classified half of a payload would post some
of a transaction's money and park the rest"*) and `apply.ts:277`
(`unknown_card`). Repo-wide, zero test files. Both are pure branches over a
`Transaction` and a fake `Sql`. Likewise `store.ts:135` `registerCard`'s missing
2100/9100 refusal, which `completion.test.ts:90` cites as a fact it relies on.

**A fifth definition of available.** `docs/BALANCE-DEFINITIONS.md` §4 says *"every
other balance function in the system is a call into it."*
`components/account/live-data-source.ts:387` computes its own:

```ts
const { activeHoldsCents, unclearedCreditsCents } = foldHoldTotals(input.holds);
const availableCents = input.ledgerCents - activeHoldsCents - unclearedCreditsCents - input.pendingOutboundCents;
```

`ledgerCents` and `pendingOutboundCents` come from `accountAvailability()`; the
**hold terms do not** — they are the fold over `card_auth_event`, while
`ledger_availability()` sums `memo_cents`. The two agree **iff `v_hold_drift` is
empty**. Measured live: identical on all 7 accounts today, which is why it has
survived. `completion.test.ts` scenario 1 creates the disagreeing state on this
very book every run, and during that window the account screen and the accounts
console print different available balances. `v_balance_definition_drift` cannot
see it — both its sides are memo-based.

### webhooks

**"Consumers idempotent: we will replay events, twice is one."** →
`src/lib/webhooks/dispatch.test.ts` (the whole file) → **yes, genuinely.**
Out-of-order convergence, park/unpark, both retry caps, lease expiry and poison
isolation are all driven and all would go red under mutation. This is one of the
strongest files in the repository.

But it runs entirely on `createMemoryInboxStore`. **`createPostgresInboxStore`'s
mutating SQL has never been sent to Postgres by any test, gated or not** —
`claimBatch`, `markProcessed`, `park`, `recordFailure`, `deadLetter`,
`unparkWaitingFor`, `requeueDeadLetter`, `listDeadLetters`, `listParked`. The
only ungated Postgres test (`inbox.test.ts:431`) exercises `insertIfNew` and
`findByProviderEventId`. `inbox.ts:647-657` says this in its own words about an
ambiguous-`id` bug that reached production: *"It could not fail in a test: the
in-memory store never parses SQL, so a statement Postgres will not accept passes
the suite."* That is still true today, and `claimBatch`'s CTE is the exact
statement shape that killed the first production drain.

**"Signatures verified."** → `refusals.test.ts` §4-7 drives four of the five
reason codes end to end, with negative controls. → **four can fail; the fifth
cannot.** `signature_malformed` is produced by no real delivery in any test. And
the drift-catcher at `refusals.test.ts:219-225` — commented *"EVERY reason string
the shipped verifiers in inbox.ts can return … If someone rewords a verifier,
this table fails"* — is a hand-typed list of 21 that **feeds string literals to
the classifier and never invokes a verifier**. It cannot catch a rewording, and
it is not every string: `inbox.ts:501`'s `'JWT has no request_body_sha256'` is
missing, and falls through to the catch-all as `signature_mismatch`. A malformed
Plaid JWT therefore pages security as a forgery. **Pinned list of 21, 22nd item
exists — the `SCREENS` shape, reproduced inside the file built to prevent drift.**

**"The dead-letter is visible to staff through `v_webhook_dead_letter` (a view,
so it cannot go stale)"** (`webhooks/README.md` §5) → *nothing asserts it* →
**the view is unreadable in production.** Verified live as `corgi_app`:

```
ERR  v_webhook_dead_letter   permission denied for view v_webhook_dead_letter
ERR  v_webhook_parked        permission denied for view v_webhook_parked
OK   v_webhook_refusal_rate  7
```

ACLs confirm it — `v_webhook_dead_letter -> {neondb_owner=arwdDxtm/neondb_owner}`
with no `corgi_app=r` entry, while 0038's views do carry one. `0002:321` grants
SELECT on both; the grant is not on the live database. Nothing in `src/` reads
either view and no test touches them, which is why a documented staff surface
has been dead without anyone noticing.

### rails — ach

**`src/lib/rails/achsim/rail.ts:151-156`: "Byte-for-byte the same algorithm as
`IncreaseAchRail.parseEvent`."** → *nothing asserts the equivalence* →
**the two dispatch on different fields and no test can see it.** The live
adapter was fixed to match on type (`increase/client.ts:455-468`, *"Match on the
TYPE, not on a prefix of the id"*); the simulator still reads
`transferId.startsWith('ach_sim_')` at `rail.ts:181` and never reads
`associated_object_type`, which `engine.ts:829-838` writes unconditionally.

Every body fed to the simulator's parser comes from `engine.drainDue()`, and
`clock.ts:135-138` mints only `ach_sim_…` ids — **the producer pins both the id
prefix and the object type, so the two strategies are indistinguishable under
test.** This is the ACH-prefix bug that dropped a whole rail's events, still
live in its sibling, with the fixture shaped so it cannot be seen. Contrast
`consumers/increase-wire.test.ts:225-243`, which deliberately drives
`sandbox_`-prefixed ids — that guard is real; the simulator got none.

### rails — wire

**`docs/WIRES.md:404-411` quotes a proof of the inbound credit that does not
exist.** The doc says `after.ledgerCents - before.ledgerCents === +75000n`; the
code (`wire.integration.test.ts:235-241`) says

```ts
expect(after.ledgerCents - before.ledgerCents).toBe(after.availableCents - before.availableCents);
```

— an equality between two deltas, **satisfied by `0n === 0n`, i.e. by the credit
posting nothing at all.** The backstop is a count (`:300`, `entries.size === 3`).
And the suite is skipped anyway. `src/lib/rails/wire/ledger.ts` is 742 lines with
no unit test; `wireValueDate` (`:302-311`) is a *pure function* whose header
makes the central timezone claim and needs no database to check.

### rails — card

See **cards** below.

### rails — stablecoin

**`docs/STABLECOIN.md:489-491`: a confirmation "requires one from our wallet, to
our recipient."** → `verifyTransferOnChain` → **the check is delegated entirely
to an `eth_getLogs` topic filter that no test constrains.** `TransferLog`
(`client.ts:66-70`) carries `txHash`, `blockNumber` and `amountUnits` — no
`from`, no `to` — so all sender/recipient correctness rests on `topics` at
`client.ts:262`. Every fake `eth_getLogs` in the repo ignores its params, and the
log fixture emits no `topics` field at all. Swapping `from` ↔ `to`, or dropping
the `to` topic, leaves the suite green. The wrong-recipient case is precisely the
mediated-provider attack the `unverified` outcome was invented for.

### kyb

**"Unverified entities can look but not transact."** → the gate is
`src/lib/approvals/instructions.ts:254-257`, the single one for console and agent
→ **its refusal arm is never driven at the call site.** `canTransact` itself is
excellently tested as a pure predicate (`kyb/types.test.ts:118-190`, including
both fail-closed unknown arms), but **no test anywhere calls `requestPayment()`
for a non-approved business.** Both integration fixtures filter it out and say
why:

- `approvals.integration.test.ts:105-110` — `WHERE kyb_status = 'approved'`
- `mcp.integration.test.ts:106-122` — *"the business must also be able to
  transact … a business whose verification is still pending refuses the write
  path with KYB_PENDING and every assertion below it fails"*

Both were changed *because the gate fired*, and both fixed it by choosing an
approved business rather than by asserting the refusal. Delete lines 254-257 and
the suite stays green.

Credit where due: `onboarding/open.integration.test.ts:172-191` does this
properly — a genuinely non-approved business through the real
`business_accounts_open()`, asserting `KYB_NOT_APPROVED` *and* that nothing was
written. That is the model the payment gate lacks.

### approvals

**"The initiator can never approve their own payment."** →
`approvals.integration.test.ts:158-206` → **yes, and it is the best refusal test
in the repository.** A raw INSERT at Neon with no application code in the stack,
asserting SQLSTATE `42501`, the exact message, then `count(*) = 0` on the
instruction's own approved events, then a different human succeeding. The hard
case is chosen deliberately (the initiator *is* an approver). Scoped per
instruction id throughout.

**"Neither can an agent."** → `:236-273` → **yes**, driven at the database in the
database's own words.

Both skipped by `pnpm test` (§2).

**Unasserted:** `src/lib/approvals/gate.ts:12-18` claims *"the reasons below are
a restatement of `assert_maker_checker()`"*. Since 0033 the database carries four
refusals with no counterpart in `GateCode`, and `decisionGate` decides from the
global `actor.can_approve` — the column 0033 `:556-562` says is *not* the
authority. For a member-actor the screen would say "you may approve" and the
trigger would return 42501. It bites nobody today only because §1's
`resolveActor` makes every session actor Corgi staff.

**And the reach nobody measures:** `v_member_approval_without_right` is gated by
`dbcheck`, proved by `--prove`, mirrored by the chaos dashboard, and prints PASS.
Measured live, it ranges over **24 of 163 approvals (14.7%)** — and those 24 are
its own test fixtures (`Test peer1/peer2/boss2 <tag>`, one approval each). All
139 approvals by the two demo operators are invisible to it, because it INNER
JOINs `team_member` on `(actor_id, paying business)` and staff have no such row.
0033 `:1052` says the view *"asserts the composition held for every approval ever
written"*. It held for 15% of them. See §6 for why nothing reports this.

### standing

**"Fire once and only once across restarts and retries."** →
`standing.integration.test.ts:249-308` → **yes.** A genuine race on freshly
created mandates, `expect(raisedFresh.length).toBe(1)` and
`expect(replayed.length).toBe(1)`. This is the model the accrual race test should
have followed. `:349-375` also plants a `:retry`-suffixed key and watches the
repaired `v_standing_order_double_fire` fire — the 0023 rebuild is sound.

**"A written policy for the day the balance cannot cover them."** → **four of
five refusal codes have never been produced by anything.** `INVALID_DESTINATION`
(`fire.ts:166`) and `UNSCOPED_ACCOUNT` (`:182`) appear only at their definition
and use sites — zero test references. The `DEFERRABLE_CODES` branch (`:366-383`)
and the non-deferrable KYB refusal (`:386-414`) are undriven. `STALE_OCCURRENCE`
is tested only as a pure function, never through `fireOne`, and `fire.ts:150`
calls the freshness-before-funding ordering *"load-bearing in one place"* while
nothing constructs an occurrence that is both stale and unfunded. Live,
`standing_order_outcome` holds only `INSUFFICIENT_AVAILABLE_FUNDS` (14 rows), and
`standing.integration.test.ts:500-509` then asserts `v_standing_order_unresolved`
is empty — **for a state nothing in the system can produce.**

### accrual (fee + interest)

**"Running it twice for the same day posts once … two full ticks started
CONCURRENTLY"** (`accrual.integration.test.ts:13-18`) → `:181-218`, mirrored at
`interest.integration.test.ts:275-308` → **the race test runs over an empty
list.** `accrual_due_dates()` (0020:768-771) excludes dates already in
`accrual_day`, and the *first* test in each file claims every owed date. So by
the race test `listDue()` returns `[]`, both ticks consider zero days, and
`deferred === 0` / `postedCents === 0n` / watermark-unchanged are all true of
nothing. Confirmed live: `v_accrual_gap` = 0, `v_interest_gap` = 0, and
`DayReport.replayed === true` is never once produced by the suite —
`accrual.integration.test.ts:231` loops over an empty array.

Its two database cross-checks are `WHERE false` with extra steps: `:204-207`
groups `accrual_day` `HAVING count(*) > 1` against
`accrual_day_once UNIQUE (schedule_id, accrual_date)`; `:213-216` groups
`journal_entry` by `idempotency_key`, which is UNIQUE. **This is the
`v_standing_order_double_fire` shape — a duplicate-detector over a unique
column — reproduced twice in the suite that was written after it was found.**

What *is* proved: exactly-once **by key**, at `:367` and `interest:310`, and both
say so. The claim/lock **race** is not.

**The penny.** `accrual` is the strongest thing in the audit.
`accrual/types.test.ts:37-58` sweeps four month-lengths × 5000 prices asserting
exact sums, and `:60-100` asserts the penny's **destination** — first `r` days,
ordinal ascending — not merely the total. The database re-derives it in a CHECK.
This cannot go vacuous. Interchange and interest have no residual to place and
both say so.

### interchange

**"Three guards about whether an entry SHOULD exist"** → all three are **made to
fire on real data inside rolled-back transactions** (`:571`, `:655`, `:777`),
including a deliberate demonstration that `v_interchange_drift` keeps firing
where `v_interchange_unreversed` goes quiet. **Exemplary — the model for the
rest of the repository.**

**"The same merchant category on two adjacent business dates, priced by two
different rate-card rows"** (`:37-39`) → `:489-522` → **the headline is computed
and printed, never asserted.** `distinctPolicies` (`:508`) appears only inside
`process.stdout.write`. The only assertions are `rows.length > 0` and
`rate_effective_from <= value_date` — which **cannot be false**:
`assert_interchange_posting()` (0031:824-836, BEFORE INSERT) refuses any posting
whose `policy_id` is not `interchange_rate_at(...)`, which filters on exactly
that inequality, and both tables are append-only. Remove the seed cutover and
nothing goes red. `interest.integration.test.ts:451-550` proves the identical
claim properly, with a counterfactual.

**"The reversal carries the ORIGINAL value date"** → `:474-481` → **`SELECT
count(*) WHERE false`.** `assert_interchange_reversal()` (0031:876-880, BEFORE
INSERT) raises on exactly the condition counted. 78 reversal rows, 0 mismatches,
as it must be. The test's own comment at `:444-445` admits the dependency.

**"The screen sums per business; the trial balance sums the account"**
(`:879-886`) → **compares a view to itself.** Both sides derive from
`v_business_pnl`. `v_trial_balance` exists and `interest.integration.test.ts:668`
uses it.

**Unasserted:** nothing anywhere asks whether a *priceable* settlement went
unpriced. The three guards all ask "is the number right on what we priced".
`v_interchange_unpriced` holds 214 rows and is honestly declared a report; I
checked all 214 and every one has `provider_record_present = false`, so the
comment's claim holds today — but nothing will notice when it stops.

### disputes

**"Withdrawal refused: money is outstanding, so this is a loss"**
(`disputes.integration.test.ts:20`) → `:288-292` →
**asserts a different guard.** `model.ts:421-422` tests `fold.decided` before
`fold.granted`, and `recordDecision('lost')` already ran at `:276-285`, so
`ALREADY_DECIDED` fires. The assertion expects `ALREADY_DECIDED`. Delete
`CREDIT_OUTSTANDING` from the model and it still passes; the SQL clause it
claims to prove (0019:627-631) is reached by no test in the repository.

**Every DB-enforced lifecycle refusal that has a test sits inside
`if (raised.needsAuthorization)`** (`:201`), and `needsAuthorization` is never
itself asserted. It is `amountCents >= 5000` against
`listDisputableCharges(...)[0]`, ordered `booking_seq DESC`, and each `it`
consumes one charge permanently. Ridgeline's live queue has three sub-threshold
charges two runs out. **When the first `it` draws the $12.00 charge, all
coverage of `assert_dispute_lifecycle()` evaporates and the suite stays green.**

1 of 9 intake refusals and 3 of 21 lifecycle refusals are driven.

### recon

**"A job that pulls provider truth and diffs it against your ledger … we will
plant a break and watch it surface."** → `src/lib/recon/planted-break.test.ts` →
**yes, and it is derived rather than counted.** It runs in the green suite
against the live database, and asserts identity on every break: `kind`,
`externalRef`, both amounts, `entryId`, `valueDate`, scoped to this run's own
rows. All three break classes are produced. The `explain-live` suite additionally
asserts the correction-group case. This subsystem is in good shape.

### statements

**"A closed day's statement is reproducible forever, corrections included,
identical every time."** → `statements.integration.test.ts:188` → **yes, and it
is strong**: the preimage is compared as a string across a backdated correction,
and `late?.n === 2` proves the book really moved underneath it. PDF byte-identity
is likewise driven (`pdf.test.ts:250`).

**"The hash is a pure function of (format, account, period, watermark)"** →
`render.test.ts` → **two of the four inputs have a sensitivity test.** Watermark
and format are driven; **account and period are not.**

**"This is a P1, never a number to overwrite"** — `StatementReproductionError`,
thrown at `publish.ts:396` when a re-render of a published watermark does not
reproduce its stored hash → **no test.** The module's entire claim is
reproducibility, and the code that fires when reproducibility fails has never
been watched fire. `publish` takes a `Sql`, so a fake connection would drive it
with no credentials — the pattern `queries.test.ts` already uses.

**"There is exactly one narrowing site in the read path — `toCents` — and it
refuses rather than rounds"** (`docs/STATEMENTS.md`) → **there are two
byte-identical copies** (`statements/screen.ts:66` and
`app/(app)/statements/live-source.ts:123`), and **neither has a test.**
`src/app/(app)/statements/` contains no `*.test.ts` at all. The analogous
refusal in `pdf.ts` *is* driven, which makes this an omission rather than a
style. The same untested file also holds `seqBeforeLatestCorrection` (`:288`) —
the "most recent, not first" anchor rule `docs/STATEMENTS.md` devotes a section
to, quoting the measured damage of getting it wrong (−$513.80 over 21 acts
against an honest −$73.40 over one). **No test would fail if it picked the
first.**

**`affectsOpening === true`** — a late posting that moved the opening balance —
is constructed by no fixture in the repo, and
`statements.integration.test.ts:370` asserts it does **not** occur
(`every((p) => !p.affectsOpening)`). Its two rendering paths have never rendered
in a test. This is the case `highestBookingSeqAffecting` exists for and the one
`read.ts` says *"failed the first time this ran"*.

**Silent skips.** `:465` (*"refuses to publish an unclosed day"*) returns early
if the day is already closed; measured, 20 of 5,000 candidate days are, so it is
~0.4% today and rising monotonically. `:608`'s PDF-vs-screen comparison is
wrapped in `if (readings !== null)`.

### pots

**"A pot can never go negative — see `v_pot_negative`"** (`model.ts:27`) →
`v_pot_negative` → **the view is a detector, not an enforcer.** 0015:359-363 is
`WHERE balance_cents < 0` over a SUM; nothing in 0015 constrains a pot's balance.
The rule lives in TypeScript only. This is precisely the argument 0023 §3a made
when it *moved* the dispute-intake filter into a trigger — *"A list is a
suggestion. The trigger is the rule."* — not applied here.

**"Submitting the same reference with a different amount is refused as a replay,
and the screen shows the entry that already exists"** (`model.ts:201-203`) →
`pots.integration.test.ts:303-328` → **the receipt echoes the caller's new
amount.** `transfer.ts:249-267` returns `amountCents: args.amountCents` with
`kind: "posted"`, and `PotForms.tsx` renders *"available moved by exactly the
amount"* beside a table showing nothing moved. The test replays with the
identical figure, so no test at any level can see it.

Otherwise pots is sound: it measures deltas on its own provisioned business and
drives both refusals for real.

### payees

**"Both gates fail closed … A payment that could not be checked is not a payment
that has been checked"** (`fx/gate.ts:62-83`, describing the payee gate's repair)
→ `payees.integration.test.ts:645` → **the test drives the wrong `catch`.** The
seam at `:640-643` makes *every* tag call reject, and the first one is inside
`readAccountIdentity` (`readers.ts:268`) called at `gate.ts:235` — inside the
**first** try. So `gate.ts:237` fires and the payee-book catch at `:250-268`
never executes. All four assertions pass either way because `unavailable()`
interpolates into a fixed sentence. **Revert `gate.ts:266-268` to
`catch { return null }` — the exact bug the header says was fixed — and the
suite stays green.**

**And `confirmPayee` still fails open**, 290 lines below that header
(`gate.ts:356-358`, verified verbatim):

```ts
  const book = await loadBookEntries(input.candidate.businessId, conn).catch(
    () => [] as const,
  );
```

`book` is the sole input to the twin probe. Over `[]`, `findConflictingTwin`
returns null, `decide()` returns `"verified"`, and a **permanent, append-only**
`payee_verification` row is written (0016:723-733). A transient read error
converts the warning the gate later reads into a clean check. No test passes a
throwing `conn` to `confirmPayee`.

Credit: the name-matching tests use genuinely mismatching names, and the warned
state in the gate test is *derived* by writing two real payees — the opposite of
a hardcoded fixture. `aba.test.ts` enumerates its own blind spot rather than
hiding it.

### fx

**"This gate is not an additional check — it IS the control. 'The customer agreed
a price' has no second enforcement point anywhere in the system"**
(`gate.ts:78-82`) → `fx.integration.test.ts` drives four of five refusals →
**the fifth, `FX_QUOTE_COMMITMENT_LAPSED`, was driven by nothing.** The string
did not occur in a single `*.test.ts` file. `docs/FX.md:741-745` says it was
proved by hand, *"not by asserting it"*. **Addressed — see §7.**

Also undriven: the read-failed `catch` (`gate.ts:147`) despite a page of prose on
why it must fail closed; the expired-quote arm (`:172`); `amountUnits <= 0`
(`:254`). `settle.ts` — the module that posts the journal entry — is imported by
no test at all.

**"No more USDC leaves than the customer paid us"** → `fx.integration.test.ts:766-776`
→ **asserted an order of magnitude away from the line.** The comment reads
*"$1,000.00 is 10,000,000,000 USDC units, so one unit past that is a refusal"*
and probes `10_000_000_001n`. `USDC_UNITS_PER_CENT` is `10_000n`, so the quote's
`sellCents` of `100_000n` is **1,000,000,000** units. The probe is nine billion
units past the ceiling, not one. Had the gate computed `sellCents * 100_000n`,
that probe would still refuse and the test would still pass, while a $9,999
payout settled against a $1,000 commitment. **Addressed — see §7.**

**Both settlement identities are `x === x`.** `allocation.ts:164-172` says *"Both
are asserted here rather than hoped for"*; `allocation.test.ts:130-149` asserts
them. `varianceCents` is *defined* as the left-hand side (`:226`) and
`settlementCostCents = walletCreditCents + residualCreditCents` (`:214`), so
expression one reduces to `0 ≡ 0` and expression two to `x === x`. The runtime
guards at `:233-238` are dead for the same reason. Change `:211` to
`fundedUnits / 1000n` — a 10× error in what 1140 is credited — and the 25-case
loop passes in full.

**The penny, and the seam.** The 2900 residual cent is the only line whose amount
*and* memo any test asserts. Swap the 4200 and 1140 amounts in
`allocation.ts:317-338` and every `settlementLines` test still passes: the sum is
still zero, `lines[0]` is still 4300, `toHaveLength(5)` still holds. **Nothing
binds the deposit, fee or wallet figures to their accounts** — the exact
"counted, not derived" shape.

**`it("refuses an UPDATE on a quote even as the owner")`** (`:621`) → **never
uses the owner.** The suite has no `postgres(` call and no `DIRECT_URL`; it runs
as `corgi_app`, which holds no UPDATE. Postgres checks table privilege *before*
firing row triggers, so `ledger_row_is_immutable()` never executes, and the regex
`/append-only violation|permission denied/` absorbs the privilege refusal. Layer
2 — whose stated purpose (0017:691-693) is to catch what layer 1 misses — is
never exercised. `interchange.integration.test.ts:778` and
`pots.integration.test.ts:144` both open owner connections when they need one.

### mcp

**"The capability is absent from the process — the MCP module does not import
`ledger/post.ts` … and that absence is asserted by a test rather than left to a
reader's diff"** (`docs/AGENT-LIMITS.md:927-929`) → `mcp/no-write-imports.test.ts`
→ **false in the shipped bundle, and the guard's single hand-written exemption is
exactly the hole.**

The value-import path from the real entry point:

```
src/app/api/mcp/route.ts
 -> src/lib/mcp/gateway.ts:34      import { getPayment, requestPayment } from "@/lib/approvals";
 -> src/lib/approvals/index.ts:38  export { releasePayment, … } from "./release";
 -> src/lib/approvals/release.ts:37 import { postEntry } from "@/lib/ledger/post";
```

Confirmed in the production build rather than inferred:
`.next/server/app/api/mcp/route.js` pulls `server/chunks/src_lib_0navgy3._.js`,
which contains the minified `postEntry` / `reverseAndRebook` implementation and
the `ledger_append` call. Turbopack did not shake it out — `package.json` has no
`sideEffects` field. The "reach past the barrel" fix bought nothing either:
`disputes/store.ts:903` is itself a re-export into `@/lib/holds`, which reaches
`@/lib/interchange` and `ledger/post.ts` again.

`FORBIDDEN_MODULES` (`:128-141`) lists `@/lib/approvals/decide`,
`@/lib/approvals/release`, `@/lib/disputes`, `@/lib/accrual` — and **not
`@/lib/approvals`**. `:200-213` actively blesses the exemption
(`expect(approvals).toHaveLength(1)`, *"reaches the approvals module only through
its request path"*) using the "one binding" argument that the same file at
`:111-126` and `AGENT-LIMITS.md:55-60` both declare **insufficient** for disputes
and accrual. **The exclusion is shaped exactly like the failure.**

The matcher `/^[ \t]*import\b[\s\S]*?from\s+"[^"]+";/gm` is also blind to
single quotes (91 files in `src/` already use them; `eslint.config.mjs` has no
`quotes` rule and there is no Prettier config), to a missing semicolon, to
side-effect imports, and to `await import("…")` — the house idiom, used at 9
non-test sites including a write at `app/(app)/events/actions.ts:103`. And
`HERE = join(cwd,"src","lib","mcp")` with a non-recursive `readdirSync`, so
**`src/app/api/mcp/route.ts` — the actual process entry point — is outside the
guard entirely.**

**"Its write tool lands in the queue like everyone else"** → the SQLSTATE-42501
self-approval proof in `mcp.integration.test.ts` → **yes, and it is the
strongest refusal on the agent surface** — but `limits.ts:72-74` and `:137` say
it runs *"on every run"*, and the file is `describe.skip` without
`RUN_DB_TESTS=1`, which neither CI nor the documented local command sets (§2).

**Sound, and worth saying:** the `void promise` audit trap is genuinely closed —
`app/api/mcp/route.ts:121` awaits `trail.settle()` before the response leaves,
and `sink.test.ts` drives permission-denied, connect-timeout, deadline-exceeded
and partial-failure. There is no fire-and-forget anywhere in
`src/lib/{mcp,api,recon,chaos}`. And `tools.test.ts:31-44` / `server.test.ts:177-190`
are **not** the `SCREENS` shape: they `toEqual` the full derived array, so a
twelfth unlisted tool goes red.

### api

**No test in the repository imports or executes any `src/app/api/**/route.ts`.**
`api.integration.test.ts:74` builds its own `RouteSpec` and calls `handle()`
directly. Every route-level claim is therefore a claim about substrings in a
file, and the substring matchers have holes:

- `guards.test.ts:311` uses `export (async )?function DELETE\b`.
  `export const DELETE = async (r) => …` — which the App Router honours — is
  invisible to it, and passes all 17 route guards. So does
  `export { del as DELETE }`. The POST census at `:304` has the same blind spot.
- `importLines` (`:139`) repeats MCP's five-form blind spot, and
  `src/app/api/sim/route.ts:24` already uses single quotes in this very tree.

**"Every endpoint A1–A8 claims is absent really is absent — by method and path,
so a refusal cannot quietly become a lie"** (`docs/API.md:1425`) →
`guards.test.ts:341-364` → **reaches 1 of 22 entries.** Thirteen are skipped by
`if (text === undefined) continue`, two are payload entries, and the one asserted
is covered elsewhere. The entry it skips is the sharp one: A4's
`GET /api/v1/accounts/1110` — the only entry naming a path this API really serves
(`accounts/[code]/route.ts` handles `/1110`). The guard normalises the **disk**
path to `{code}` and never normalises the **literal** `1110`. It excludes exactly
the shape it exists to catch.

**Four cited enforcement mechanisms name test files that do not exist.**
`limits.ts:149` — A4, cross-tenant isolation, *"a data breach, not a bug"* —
cites `src/lib/api/isolation.test.ts`; `:153` cites `routes.test.ts`;
`:94/:203/:228` cite `api/no-write-imports.test.ts`. None of
`isolation.test.ts`, `routes.test.ts`, `no-write-imports.test.ts` or
`boundary.test.ts` exists in `src/lib/api/`. `api/routes/meta.ts:166` serves one
of those strings to integrators over HTTP. The guard
(`guards.test.ts:387-390`) asserts `enforcedBy.length > 0` and prose length —
every entry could read `"trust me"` and stay green.

**Five cron/drain routes authorise on a header the caller can type.**

```ts
if (req.headers.get("x-vercel-cron")) return true;      // cron/accrual/route.ts:64
```

Identical at `cron/standing:50`, `cron/holds:41`, `cron/outbound:32`,
`drain:30`. **There is no `middleware.ts` anywhere in the repo**, so nothing
strips a client-supplied header. The accrual route posts journal entries against
customer deposit accounts; the standing route raises payment instructions. The
bearer fallback compares with `===`, against `api/auth.ts:11`'s own stated
discipline. **No test touches any of the five**, and they are outside every route
guard (`guards.test.ts:275` filters `src/app/api/v1/`). Both files assert in
prose that *"there is no unauthenticated path"*.

`meta.ts:52-109` is a hand-written 12-entry endpoint index served to
integrators, derived from nothing and compared to nothing — textbook `SCREENS`.

**Sound:** `http.test.ts`, `processing.test.ts`, MCP's `auth.test.ts` and
`ratelimit.test.ts` all drive real exported functions and would go red.

### events

**"Bodies are capped at 8 KiB"** (`transport.ts:33-35`, `EVENTS.md:467-469`) →
`transport.test.ts:67`: `expect(MAX_EXCERPT_CHARS).toBeLessThanOrEqual(1024)` →
**a constant compared to a constant, next to a branch that does not work.**
`MAX_RESPONSE_BYTES` has no assertion at all, and the bound it names is a hang:

```js
res.on("data", (chunk) => {
  read += chunk.byteLength;
  if (read <= MAX_RESPONSE_BYTES) chunks.push(chunk);
  else { res.destroy(); }          // transport.ts:239
});
```

`finish()` is reachable only from `res.on("end")`, `res.on("error")` and
`req.on("error")`. `res.destroy()` fires none of them — measured on Node v26.7.0
with the identical handler shape, the events are `aborted`, `close`, `close` —
and `:299`'s `req.on("close", () => clearTimeout(hardStop))` cancels the last
escape. **The promise never settles, `deliverOnce` awaits it, the batch stops and
the 60s lease re-claims the same row forever.** A customer serving a >8 KiB error
page burns the worker repeatedly and every other endpoint in that batch goes
undelivered. This is a live production defect, reported not repaired.

**The event-type dispatch seam is invisible.** `store.ts:488`
(`eventTypeFor(row.book, row.entryType)`) feeds the body, the `event_type` column
*and* the subscription filter. `envelope.test.ts:8` hardcodes
`eventType: "transaction.posted"` in `BASE` and every derived case;
`eventTypeFor` is tested only in isolation. Mutate `:488` to
`eventTypeFor("financial", row.entryType)` — every `hold.*` event becomes
`transaction.*` and every hold-only filter silently stops matching — and **all 88
tests stay green.**

**No outbound invariant exists anywhere.** `dbcheck` carries 22 invariant views
and not one is `outbound_*`. `EVENTS.md:503-509` advertises the private-IP query
as *"the standing proof… a query, not an opinion"* — it is not a view, not in
`dbcheck.mjs`, and runs on no schedule. The DNS pin at `transport.ts:227`, the
single load-bearing rebinding control, can be deleted with the suite green.

`rotateEndpointSecret`/`retireEndpointSecret` have **zero callers** anywhere, so
the rotation path `EVENTS.md:230-231` describes has never executed;
`store.ts:209-218` declares a `Result<…, UrlRefusal>` containing no `err(...)`,
making every `if (!result.ok)` at its call sites dead code.

### audit

**"A base table nobody has classified. A migration that adds an action store and
does not append to `audit_source` turns this non-empty"** (0035:1267-1287,
`v_audit_source_unclaimed`, MUST RETURN ZERO ROWS) → *nothing* → **it is
non-empty right now.** Live:

```
UNCLAIMED: card_member, outbound_attempt, outbound_cursor, outbound_delivery,
           outbound_endpoint, outbound_endpoint_secret, outbound_event,
           team_member, team_member_version
```

`audit.integration.test.ts` asserts `v_audit_coverage_drift` empty (`:45`) and
`v_audit_source_mutable` empty (`:135`) — and not this one. It is not in
`dbcheck`'s `INVARIANT_VIEWS` either. The only consumer is the screen, and
`components/audit/fixtures.ts:88` hardcodes `unclaimed: []`.

`docs/AUDIT.md:372` states the number honestly — *"9 rows — see §2.3"* — so this
is a documented gap, not a lie. The finding is that **nothing will notice when 9
becomes 14.** The sharpest instance is `team_member_version`, which
`docs/AUDIT.md:237` calls *"on its face, the answer to 'who removed a team
member'"*. It is not on the trail — so "the audit log is complete" excludes the
entire authority subsystem, which is also the subsystem §1 is about.

Credit: `audit.integration.test.ts:49-132` is **the best guard-can-fail proof in
the repository** — it rewrites the view's join to the plausible authoring
mistake, watches the count move, and rolls back.

### team

Covered by §1. Additionally:

**`screen.render.test.ts:143-156` loops `for (const canAdminister of [true, false])`
and asserts three strings present in both branches.** The only thing the prop
controls — the *"You are not an administrator of this team"* note at
`TeamForms.tsx:333-339` — is never asserted. Delete the prop and its branch; the
test stays green. And `team/page.tsx:149` is
`canAdminister={me === null ? true : me.canAdministerTeam}` with `me` always null
in the demo, so the false branch never renders in the product either.

**The MCP write-guard is a hardcoded name list and `team` is not on it.**
`mcp/no-write-imports.test.ts:54-109` enumerates 40 forbidden identifiers and
`:128-141` twelve forbidden modules; neither mentions `@/lib/team/*`,
`addMember`, `setMemberTerms`, `assignCardToMember` or `endMembership`. An MCP
tool that added an `admin` member would import cleanly past this guard — and
adding an approver is the one write that manufactures the second pair of eyes the
whole maker-checker control depends on. Combined with §1, this is the same hole
approached from the other side.

### cards

**"A removed person's card must decline whether or not anybody ever set a control
on it … and `decide.test.ts` drives exactly that case"** (`decide.ts:263-271`) →
**it does not.** `decide.test.ts:38-43`'s only lookup builder has no `member`
key. The only tests that pass a member into `decide()` are in `src/lib/team/`,
and both are `RUN_DB_TESTS`-gated and skipped by default.

**Mutation-verified in an isolated copy:** deleting `decide.ts:280-304` — the
entire `member_removed` / `member_suspended` rule — changes nothing. Five of
sixteen rules have zero default coverage. The test that looks like it would catch
this, `decide.test.ts:52`, is
`expect([...RULE_ORDER].sort()).toEqual([...DECISION_RULES].sort())` — and
`decide()` never reads `RULE_ORDER`; evaluation order is a hardcoded if-chain.
Swapping rules 8 and 9 in the code is also green. Note this composes with §1: the
database check on a removed member's *authority* has never fired, and the
real-time check on their *card* is mutation-green.

**`PURCHASE_STATUSES` can be shrunk with the suite green.** Deleting
`"FINANCIAL_AUTHORIZATION"` from `cards/types.ts:174-177` makes real purchases
approve via `credit_not_a_purchase`, **bypassing freeze, MCC blocks and every
limit**. The "every status Lithic documents" test (`asa.test.ts:200-206`)
enumerates from a literal.

**`docs/CARD-CONTROLS.md:374-393`**, headed *"The rules, in evaluation order"*,
puts `no_controls_configured` at 5 and `card_frozen` at 6. In code
`no_controls_configured` is rule **15**, and the table omits all five member
rules. Read literally, the document describes precisely the bug
`decide.ts:263-271` says the ordering exists to prevent.

`cards/provider.ts` has no test file; its `__resetAsaSecretCache()` — commented
*"Test seam"* — is called by no test. `budget.ts:125`'s `clearTimeout` is
deletable (green): `budget.test.ts:62-69` measures the await, not the timer.

**Sound:** the normalisation tests in `rails/lithic/client.test.ts` are real
arithmetic on real shapes, and the hold-side assertions are covered under
**holds** above.

### chaos

**"This is a COPY of `INVARIANT_VIEWS` in `scripts/dbcheck.mjs` — same views,
same claims, same order"** (`chaos/invariants.ts:4-5`) →
`chaos/invariants.test.ts:53` → **it compares names only.** The claims are
checked by `expect(claim.length).toBeGreaterThan(10)`. They have drifted:

| view | the gate says | the screen says |
| --- | --- | --- |
| `v_refused_auth_hold` | "an authorisation **not recorded as APPROVED**" | "an authorisation **the network refused**" |
| `v_wire_availability_drift` | "spendable the moment it is booked" | "withholds nothing, because a wire cannot be returned" |

**Measured consequence.** `v_refused_auth_hold` is red on the live database with
154 rows / 130 holds / $9,786.20 — and **every one is `unanswered`; zero are
`refused`.** `ChaosView.tsx:216-220` renders view, claim and a red badge, so the
dashboard currently asserts *the network refused 154 authorisations* when the
network answered none of them. That exact wording **is** the 0026 bug —
`dbcheck.mjs:267-283` records it, and 0032 replaced it. The gate has an
`explain()` (`:484-505`) that separates repairable `refused` from unrepairable
`unanswered`; the dashboard has neither the breakdown nor the corrected sentence.

**The list-sync parser reads the first array only.**
`invariants.test.ts:39-48` does `indexOf('const INVARIANT_VIEWS = [')` →
`indexOf('\n];')` → `/\[\s*"(v_[a-z0-9_]+)"/g`. Replayed against the real file: a
23rd view added in a **second array** and iterated is silently skipped; so is a
single-quoted or backticked entry. `dbcheck.mjs` preserves three separate
confessions of this happening (`:338-354`, `:356-372`, `:420-435`) — each time
the test stayed green while the dashboard checked fewer invariants than CI. It is
clean today only because a human moved them back by hand.

**`bounds.test.ts:124-136`** — *"supplies a usable default for **every**
parameterised control"* — names three controls by hand. Nothing in any test
iterates `CHAOS_CONTROLS`, and nothing holds `CHAOS_MAX_SECONDS` /
`CHAOS_CONTROLS` equal to `0029_chaos.sql:124-132` despite `types.ts:45`'s
*"Change one and the other"*.

**Sound:** `chaos.livefire.test.ts:73-81`'s `invariantsMustHold` has **no
exclusion list** and counts an unreadable view as failing. That is the honest
shape. It cannot pass today — two views are red — but it is `LIVEFIRE`-gated, so
nobody sees that.

### timetravel

**"`prefixLeak()` checks the leak at the cut on every travelled request … It
renders nothing today, and would render something the day that changes"**
(`docs/TIMETRAVEL.md`) → *nothing asserts it* → **it can never render anything.**

```ts
export function prefixLeak(point: TimePoint): number | null {          // point.ts:353
  const overshoot = point.watermarkBookedAt.getTime() - point.requestedKnownAt.getTime();
  return overshoot > 0 ? overshoot : null;
}
```

`watermarkBookedAt` is the booking time of `MAX(booking_seq) WHERE booking_time
<= t`. The row at the watermark is the argmax **of a set selected by
`booking_time <= t`**, so its booking time is `<= t` by construction and
`overshoot <= 0` always. The subtraction is `x − t` where `x` was chosen because
`x <= t`.

The leak is real and lives one row **below** the cut. Demonstrated on a synthetic
three-row book, read-only:

```
watermark              100
what_prefixleak_reads  10:00:00Z   (the entry AT the cut)
requested              10:02:00Z
prefixleak_fires       false
there_IS_a_leak        true
leaked_seqs            [99]        <- booked 10:05, inside `booking_seq <= 100`
```

The correct predicate asks the prefix, not the cut:
`EXISTS (… WHERE booking_seq <= W AND booking_time > t)`. **The guard's
population is the one position at which the failure is excluded by
definition** — the catalogued shape, in the subsystem the brief grades hardest.

**The headline bitemporal invariant is asserted by nothing today.**
`timetravel.integration.test.ts:205` — *"the cut never lands inside an atomic
write"* — returns silently when the chosen act has no `midWrite` landmark, which
needs `correcting.length > 1 && gap >= 2ms`. `bestDemonstration()` takes the act
with the highest last `booking_seq`. Measured live:

| acct | correcting members | last seq | gap |
| --- | --- | --- | --- |
| **a0c41a37** | **1** | **3957** | **0.000 ms** |
| 2eb04bde | 2 | 3956 | 73.633 ms |

The top row wins, has one member, and the test returns. Confirmed by running it:
green in 1,390 ms, which is `bestDemonstration()` plus the early return. **The
margin is one booking position.** A single reversal-only entry booked above the
real demonstration act silenced "snap down, never up", `observableWatermark` and
`cut.snapped` against the live book — all three green, none asserted.

Every other DB case in the file has the same escape (`if (act === null) return;`
at `:169, :202, :239, :291, :319`), and `:116` uses `expect(act).toBeNull()` — a
tautology — as a pass. `:254`'s `expect(straddle([], point.cut.effective))
.toBeNull()` reads as a check on the resolved cut and is a check on an empty
array, for which `straddle` returns null under every possible watermark.

**`point.test.ts` is cited twice as the asserting test and does not exist**
(`point.ts:103`, `params.ts:148`), for the claim *"`resolveTimePoint` returns
`readSnapshot()` verbatim — the same single query."* Nothing counts the
statements issued. `positionsSince`, `beforeTheBookBegan`, `aheadOfTheBook` and
`livePoint` are exported and referenced by no source or test file.

**`AS_KNOWN_AT_OUT_OF_RANGE`** is the one of six refusal codes `params.test.ts`
does not drive — and the documented behaviour is wrong for half its inputs:
with a time component the `ISO_INSTANT` parse already requires
`year >= MIN_YEAR`, so `?asKnownAt=1899-06-21T12:00:00Z` returns
`AS_KNOWN_AT_MALFORMED`. Two answers to "out of range" on one axis, neither
asserted.

**Sound:** `integrity.test.ts:118` builds its inputs by *running the detector*
rather than hand-shaping them, and says why. Exemplary.

### onboarding

**"An agent may not open an account"** (0021:309) → `open.test.ts:180-194` →
**asserts the classifier, not the refusal.** The test hands `scriptedSql` a
hand-built `pgError("42501", "actor … is an agent")`, which proves the
SQLSTATE→code mapping — worth proving — but `open.integration.test.ts` drives the
KYB arm of that same 42501 live and never the actor arm. Remove the
`v_actor_kind = 'agent'` branch from 0021 and nothing goes red.

Otherwise onboarding is the **strongest refusal in the audit**:
`open.integration.test.ts:172-191` drives a genuinely non-approved business
through the real definer function, asserts the code and asserts nothing was
written, plus an un-bypassability assertion at `:193-202`.

### integrations

**`scripts/audit-claims.mjs` check 2 — the automatic-fail check — has zero reach
today.** All 7 slots read `live` on the deployed health endpoint, so the
`simulated` set is empty and the loop that looks for a simulated slot presented
as live never executes. It is also the narrower of the two checks: check 1 was
widened to two spellings after a `4/7 live` shorthand sailed past it, with the
comment *"A guard that only understands one spelling of the claim it guards is
not a guard"* — and that lesson was not applied to check 2, which understands
exactly `| **live** |` and `^LIVE `. The README happens to use the first form, so
it works; nothing makes it keep working.

---

## 4. UNASSERTED LOAD-BEARING CLAIMS

Ranked by what breaks if the claim is false.

1. **Removal revokes authority over a team** — §1. Nothing asserts it; it is
   false. Proven twice, live.
2. **The KYB transact gate refuses at the payment call site** — no test calls
   `requestPayment()` for a non-approved business; both fixtures filter them out.
3. **`confirmPayee` fails closed** — `payees/gate.ts:356-358` still returns `[]`
   on a read error and writes a permanent `verified` row.
4. **The 8 KiB response bound** — `events/transport.ts:239` hangs the worker
   instead; nothing asserts `MAX_RESPONSE_BYTES` at all.
5. **`v_webhook_dead_letter` is readable by the application** — it is not, on the
   live database, and nothing reads it to find out.
6. **`v_audit_source_unclaimed` is empty** — it holds 9 rows including
   `team_member_version`, and is in no gate.
7. **The simulator and the live ACH adapter parse identically** — they dispatch
   on different fields; the fixture pins both.
8. **The event-type dispatch is right** — one mutation at `store.ts:488` silently
   breaks every hold subscription with 88 tests green.
9. **On-chain `from`/`to` verification** — delegated to a topic filter no fake
   constrains.
10. **A priceable card settlement is priced** — three interchange guards, none
    asking this.
11. **The FX allocation's lines are bound to their accounts** — only the residual
    cent is; the deposit, fee and wallet amounts can be swapped freely.
12. **A removed cardholder's card declines** — `decide.ts:280-304` is deletable
    with the suite green; the only tests that pass a member are DB-gated.
13. **`PURCHASE_STATUSES` is complete** — dropping `FINANCIAL_AUTHORIZATION`
    routes real purchases past freeze, MCC blocks and every limit, green.
14. **The five cron/drain routes are authenticated** — both say in prose that
    there is no unauthenticated path; both accept a header the caller can type,
    and no test touches any of them.
15. **`prefixLeak()` detects a sequence inversion** — it cannot (§1b ii).
16. **The statement re-render P1** — `StatementReproductionError` has no test;
    reproducibility is the module's whole claim.
17. **`toCents` refuses rather than rounds** — two untested copies.
18. **`seqBeforeLatestCorrection` anchors at the most recent act** — no test
    would fail if it picked the first, which the doc measures at −$513.80.
19. **`unclassified_step` / `unknown_card`** — the all-or-nothing posting claim,
    driven by nothing.
20. **The four cited API enforcement tests** — `isolation.test.ts`,
    `routes.test.ts`, `api/no-write-imports.test.ts`, `boundary.test.ts` do not
    exist; one of the strings is served to integrators over HTTP.

---

## 5. ASSERTIONS THAT CANNOT FAIL

Constructed or traced to the point where the violating state is impossible.

| assertion | why it cannot fail |
| --- | --- |
| `accrual.integration.test.ts:204-207` | `HAVING count(*) > 1` on `accrual_day_once UNIQUE (schedule_id, accrual_date)` |
| `accrual.integration.test.ts:213-216` | same, on `journal_entry.idempotency_key` UNIQUE |
| `interest.integration.test.ts:304-306` | same, on `interest_day_once UNIQUE` |
| `accrual.integration.test.ts:181-231` | `listDue()` returns `[]` — the whole race runs over an empty list |
| `interchange.integration.test.ts:474-481` | counts the condition `assert_interchange_reversal()` refuses BEFORE INSERT |
| `interchange.integration.test.ts:512` | counts the condition `assert_interchange_posting()` refuses BEFORE INSERT |
| `interchange.integration.test.ts:879-886` | both sides derive from `v_business_pnl` |
| `fx/allocation.test.ts:130-149` | both identities reduce to `x === x` by definition |
| `fx.integration.test.ts:621-664` | runs as `corgi_app`; privilege refusal precedes the trigger, and the regex absorbs both |
| `accrual.integration.test.ts:406-440` | the value-date branch is unreachable — `monthly_cents` fires first, by construction of the fixture |
| `disputes.integration.test.ts:288-292` | `ALREADY_DECIDED` precedes `CREDIT_OUTSTANDING` in the fold |
| `standing.integration.test.ts:500-509` | asserts a view empty for a state nothing can produce |
| `events/transport.test.ts:67` | a constant compared to a constant |
| `webhooks/refusals.test.ts:219-254` | feeds literals to the classifier; never invokes a verifier |
| `team/screen.render.test.ts:143-156` | asserts only strings present in both branches |
| `wire.integration.test.ts:235-241` | `0n === 0n` satisfies it |
| `rails/semantics.test.ts:930-931` | `!==` satisfied by any third value, including `""` |
| `plaid/funding.integration.test.ts:239-244` | loop body empty on a Mon–Wed value date |
| `increase/observe.integration.test.ts:192` | `if (rows.length === 0) return;` |
| `stablecoin/adapter.ts:230-238` reorg re-read | re-queries the same block through a pure-function fake |
| `audit-claims.mjs` check 2 | iterates an empty `simulated` set |
| `accrual` `v_accrual_month_drift` | 0 complete months — `dbcheck` says so itself |
| `timetravel/point.ts:353` `prefixLeak()` | `overshoot <= 0` by construction — the argmax of a set bounded by `t` |
| `timetravel.integration.test.ts:254` | `straddle([], …)` is null for every watermark |
| `timetravel.integration.test.ts:116` | `expect(act).toBeNull()` inside `if (act === null)` |
| `0022_balance_definitions.sql:356` disjunct 2 | `X <> X` — all four columns from one `ledger_availability()` row |
| `queries.test.ts:196` | fixture-computed literals; the module does no arithmetic |
| `ledger.integration.test.ts:246` | ternary on the constant `73_40n - 90_00n === -16_60n` |
| `holds/fuzz.test.ts:1468` | `toEqual` against the same 8 names the generator emits |
| `cards/decide.test.ts:52` | `RULE_ORDER` vs `DECISION_RULES`; `decide()` reads neither |
| `api/guards.test.ts:341-364` | 13 of 22 entries skipped by `if (text === undefined) continue` |
| `chaos/bounds.test.ts:124-136` | three controls named by hand; nothing iterates `CHAOS_CONTROLS` |
| `integrations/verdict-cache.test.ts:114-151` | re-implements `readSlot` in the test body and never calls it |
| `health/consistency.test.ts` | tests a function defined in the test file that production never calls |

`dbcheck --prove` reports 22 of 22, and I could not falsify any of the 22 proofs;
they are real. The list above is what sits *outside* that mechanism.

---

## 6. THE MECHANISM THAT WATCHES THE MECHANISM

Worth separating, because it is the same failure one level up.

`scripts/dbcheck.mjs` contains two guard-of-guards, thirty lines apart, and only
one of them learned the lesson.

**`--prove` (§9) walks `INVARIANT_VIEWS` itself:**

```js
for (const [view] of ALL_VIEWS) {
  const specs = PROOFS.filter((p) => p.view === view);
  if (specs.length === 0) {
    bad(`${view} CAN fail`, "NO PROOF IS REGISTERED FOR THIS VIEW — it is trusted, not tested");
```

*"COVERAGE IS COMPUTED, NOT CLAIMED … a view added above without a proof here is
a named FAILURE on the next run rather than a quiet gap."* Correct, and it works.

**`GUARD REACH` (§8) walks a hand-typed literal.** Its header states its own
purpose precisely:

> `THE FAILURE THIS SECTION EXISTS FOR. v_standing_order_double_fire joined a
> UNIQUE column … so it could not return a row under ANY state of the database
> … A guard that cannot fail converts an untested claim into a green tick`

`const REACH = [...]` holds **15 rows against 24 gated invariants.** Nine have no
reach line, and the loop iterates `REACH`, not `INVARIANT_VIEWS`, so adding an
invariant without adding a reach row is silent. **What the section excludes — any
invariant nobody typed into its array — is exactly the failure it exists to
catch.**

Measured, for two of the nine:

| gated invariant | reach | of what |
| --- | --- | --- |
| `v_member_approval_without_right` | **24** | of 163 approvals — **14.7%**, and the 24 are its own test fixtures |
| `v_approved_auth_for_dead_member` | **8** | of 654 card authorisations — **1.2%** |

Both print `PASS` on every run. Both are proved by `--prove`, which fabricates a
row *inside* the reach and therefore cannot reveal the blind spot. Both are
mirrored by the chaos dashboard. The section built because 0028's guard *"could
only see 55% of its table"* does not report either of these, because neither is
on its list.

A smaller note in the same file: the `--prove` driver does
`proven.add(view)` unconditionally after `runProof`, so the closing
`--prove covered N of M` is a count of **registrations**, not of successes. The
`pass`/`fail` tally still catches a failed proof, so this misleads a reader
rather than hiding a defect.

**Not repaired.** Deriving `REACH` from `INVARIANT_VIEWS` would turn the tree red
tonight by naming nine omissions, which is the right change and the wrong hour.

---

## 7. TESTS ADDED

One file. **`src/lib/fx/gate.unwatched.test.ts`** — 8 tests, two claims.

Both were **made to fail before being trusted**, by mutation, with the output
recorded here.

### (a) `FX_QUOTE_COMMITMENT_LAPSED`

The fifth refusal on `requireAcceptedQuote()` — the function whose own header
says *"this gate is not an additional check — it IS the control"* — was driven by
nothing. The string did not appear in any `*.test.ts`.

**Why it had never been driven, which is the interesting part.** `v_fx_quote`
derives `lapsed` as *accepted, unsettled, and `now() > accepted_at +
settlement_window_seconds`*. Three correct decisions put that state out of reach
together:

- `settlement_window_seconds` is `CHECK (BETWEEN 60 AND 604800)` — the shortest
  commitment lasts a minute;
- `fx_quote_acceptance_guard()` refuses any `accepted_at` more than five seconds
  from `now()` — *"Backdating an acceptance would defeat the line above"*;
- `now()` is the **transaction** timestamp, so inside the `rolledBack()` helper
  the rest of the directory uses, it never advances. `pg_sleep()` changes nothing.

So reaching `lapsed` live means committing an acceptance and returning 55 seconds
later — a permanent row per run in a book the suite deliberately stopped growing,
and a test twice the configured timeout. **The integrity check that makes the
control real is the same thing that made the control unobservable.** The test
therefore stubs `loadQuoteByRef` — the only stub in that directory — and says so
in its header, along with what it does not prove (that 0017 derives `lapsed`
correctly; that is the migration's arithmetic).

**Made to fail:** mutating the fixture's `state` from `"lapsed"` to `"accepted"`
— the defect shape, a closed window the gate treats as open:

```
× refuses on the clock alone … → expected 'FX_QUOTE_MISMATCH' to be 'FX_QUOTE_COMMITMENT_LAPSED'
× does not collapse into the never-accepted answer … → expected 'FX_QUOTE_MISMATCH' to be …
× tells the customer which window closed and when … → expected '…' to contain '900-second'
× refuses before it reaches the recipient and amount checks … → expected 'FX_QUOTE_MISMATCH' to be …
Tests  4 failed (4)
```

### (b) The amount ceiling, probed at the ceiling

`fx.integration.test.ts:766-776` is the only assertion on *"no more USDC leaves
than the customer paid us"*. Its comment says *"$1,000.00 is 10,000,000,000 USDC
units, so one unit past that is a refusal"* and it probes `10_000_000_001n`.
`USDC_UNITS_PER_CENT` is `10_000n`, so `sellCents: 100_000n` is **1,000,000,000**
units. The probe is nine billion units past the line, not one. A ceiling
computed as `sellCents * 100_000n` would still refuse that probe — the existing
test cannot distinguish the correct ceiling from one ten times too generous.

The new cases sit on the line — exactly the ceiling passes, exactly one unit more
refuses, zero refuses — and the ceiling is **derived** from
`USDC_UNITS_PER_CENT` rather than typed out, so a literal cannot drift again.

**Made to fail:** mutating the derivation to the 10×-wrong scale
(`SELL_CENTS * 100_000n`):

```
✓ (the four lapsed cases — unaffected, as they should be: the state switch runs first)
× lets exactly the committed amount through  → expected { code: 'FX_QUOTE_MISMATCH' } to be null
✓ refuses one single unit more
× is the ceiling the gate derives, not a literal → expected 10000000000n to be 1000000000n
✓ refuses a payout of nothing
Tests  2 failed | 6 passed (8)
```

Restored, re-run, **8 passed**.

### Where I chose not to add a test

- **§1.** The fix is in a migration and the test belongs with the fix. A test
  asserting today's behaviour would pin the hole; a test asserting the correct
  behaviour would be red. Reported instead.
- **§6.** Deriving `REACH` from `INVARIANT_VIEWS` is the right repair and turns
  the tree red by naming nine omissions. An allow-list of the nine would be the
  pinned list this whole audit is about.
- **The unfailable assertions in §5.** Each needs its existing test rewritten,
  which is outside this pass's remit.

---

## 8. DEFECTS IN SOURCE — REPORTED, NOT REPAIRED

| where | what a reviewer sees |
| --- | --- |
| `db/migrations/0033_team.sql:318`, `:822` | `AND state <> 'removed'` puts a removed member in the Corgi-staff branch. Proven twice, live, rolled back. §1 |
| `src/lib/events/transport.ts:239` | `res.destroy()` in the size-cap branch settles no promise. The delivery worker hangs and the lease re-claims the row forever. |
| `src/lib/payees/gate.ts:356-358` | `confirmPayee` fails open: `.catch(() => [])` on the payee book, then writes a permanent `verified` row. |
| live database | `corgi_app` lacks SELECT on `v_webhook_dead_letter` and `v_webhook_parked` despite `0002:321`. Verified by ACL. |
| `src/lib/rails/achsim/rail.ts:181` | dispatches on an id prefix where the live adapter dispatches on type, against a header claiming they are byte-for-byte identical. |
| `src/lib/pots/transfer.ts:249-267` | the replay receipt returns the caller's new amount beside a table showing nothing moved. |
| `src/lib/events/store.ts:209-218` | a `Result` type with no `err` path; every `if (!result.ok)` at its call sites is dead. `rotate/retireEndpointSecret` have no callers at all. |
| `src/lib/webhooks/inbox.ts:501` | `'JWT has no request_body_sha256'` classifies as `signature_mismatch` — a malformed delivery paging as a forgery. |

**Tooling note that affects anyone auditing this repo:**
`src/lib/webhooks/inbox.ts` contains a literal NUL byte at line 943 (a deliberate
map-key separator). `file` reports it as `data` and **plain `grep -rn` silently
skips the entire 1,242-line file.** Use `grep -a`. Every grep sweep over this
repository has been missing the heart of the webhook pipeline.

---

## 9. TREE STATE AT THE TIME OF WRITING

| gate | result |
| --- | --- |
| `pnpm test` **with `.env` loaded** | **2546 passed, 371 skipped** — green |
| `pnpm test` **with no secrets (the CI condition)** | **2509 passed, 408 skipped, 1 file failed** |
| `pnpm db:check` | **36 passed, 4 failed** — see below |
| `pnpm db:check --prove` | 22 of 22 |
| `tsc --noEmit` | **RED** |

### The two reds are not mine, and both are live in-flight work

**`tsc`**: every error is in `src/lib/webhooks/consumers/increase-ach.ts`, which
another agent is editing right now — the error set changed shape between two runs
four minutes apart (`TS2552`/`TS2304` → `TS6133`) as `0042_virtual_account_numbers.sql`,
`rails/increase/account-numbers.ts` and `inbound-ach-ledger.ts` landed. Zero
errors reference any file I touched. Flagged, not touched.

**CI-mode suite**: the one failing file is
`src/lib/rails/increase/inbound-recall.integration.test.ts` — new, from the same
agent — failing at module load with
`EnvironmentError: APP_DATABASE_URL is required`, via
`src/lib/ledger/db.ts:18`. It is a `describe.skip` suite, but the import of
`@/lib/ledger/db` happens before the skip, so it takes the file down before a
single test is collected. **CI runs bare `pnpm test`. This is red on the
pipeline right now** and is a one-line fix at that agent's end (defer the handle,
or stub it the way §7's file does).

**Line numbers in this report were correct when read and several files have moved
since.** `scripts/dbcheck.mjs`, `src/lib/holds/fuzz*.ts`, `src/lib/webhooks/inbox.ts`
and eleven integration suites were all edited by other agents while this was
being written. Every finding above was **re-verified against the tree as it
stands** at the time of writing; where a line number has shifted, the quoted text
is the anchor. Two re-checks worth recording: `dbcheck`'s `REACH` is now 15 rows
against 24 gated invariants — the nine omissions in §6 are the same nine — and
`fuzz-generators.ts:139` still lists eight of the nine `card_event_kind` values
with `fuzz.test.ts:1468` still pinning the same eight.

**`db:check` moved from 36/2 to 36/4 during this audit**, and not from anything
here. `db/migrations/0043_auth_floor.sql` landed at 03:02 (after
`0042_virtual_account_numbers.sql` at 02:51) and added two invariant views, both
of which are red on arrival:

```
FAIL  v_advice_delta_unsound is empty — 1 row(s)
FAIL  v_hold_closure_unexplained is empty — 4 row(s)
```

The two deliberate pre-existing failures (`v_refused_auth_hold` 154,
`v_hold_expiry_drift` 9) are unchanged. Whether the two new reds are intentional
— a guard shipped red because it found something real, which this codebase does
on purpose and documents — or in-flight, is that agent's to say. It needs saying
before the demo, because "36/2 with both failures deliberate" is currently the
stated baseline and the number a grader will be shown is 36/4.

**Nothing in this audit wrote to the database.** Every transaction opened here
ended by throwing, and each was followed by a read confirming zero rows left
behind (the §1 proofs print those checks).

### Disclosure: my own file had the same defect and it was caught in review

The first version of `src/lib/fx/gate.unwatched.test.ts` imported the gate, which
imports `@/lib/ledger/db`, which throws without `APP_DATABASE_URL`. It was green
under `set -a; . ./.env; set +a` — the command in the brief — and would have
turned CI red. That is a small instance of this whole document's subject: **the
environment the test was verified in excluded the environment the failure occurs
in.** It now stubs `@/lib/ledger/db` with a Proxy that throws if anything ever
reaches it, and is verified green both ways:

```
env -i  ->  8 passed
with .env  ->  8 passed
```

Worth saying out loud because it is the reason this audit's own claims are stated
with the command that produced them.

### Files changed by this audit

Added: `docs/TEST-AUDIT.md`, `src/lib/fx/gate.unwatched.test.ts`.
Modified: nothing. No file under `src/lib/**` other than the added test, no
migration, no script, no config, no existing test.
