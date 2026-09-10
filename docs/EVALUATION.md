# Independent evaluation — Corgi work trial, Track 3 (Neobank)

Evaluator: independent, adversarial. Not a cheerleader.
Evaluated at 2026-09-10 ~16:45Z, against commit **`f39606a`** as deployed.
Repo: `/home/lain_iwakura/Documents/corgi-trial` · Live: https://corgi-trial-psi.vercel.app

> ⚠️ **This report was overtaken by events. Read §8 before acting on §6.**
> Between measurement and write-up the candidate landed `src/lib/holds/`, a Lithic card
> consumer, `src/lib/webhooks/drain.ts`, a cron, and an 8-file live-fire suite — i.e. most
> of fix #5 — and the deployed commit moved to `ef62512`. §1–§7 are a rigorous, evidence-
> backed snapshot of `f39606a`. §8 records what changed, what now passes, and what the
> revised priorities are.

**Snapshot caveat.** T0 was 2026-09-09 17:13 PDT, freeze 2026-09-11 17:13 PDT. The
last decision-log entry is `020 — 2026-09-10T18:10Z`, i.e. roughly T+18h of 48. This is a
**mid-flight score**, not a final one. Section 6 is therefore the operative part of this
document.

**Brief pages.** `app.notion.com/p/Corgi-Work-Trial-The-Build-…` and
`…/Track-3-Neobank-…` both returned a Notion login wall — no page body, no content. Both
are **NOT ACCESSIBLE** without authentication. This evaluation uses the rubric text
supplied to me, which I am treating as authoritative.

**Constraint on my own method.** I was instructed not to run git commands, so I did not
scan git history for committed secrets. Section 2 item 5 is therefore assessed from the
working tree and `.gitignore` only, and I flag it as incompletely verified.

---

## 0. Measurements taken (real numbers, not claims)

| Check | Command | Result |
| --- | --- | --- |
| Unit suite, no DB | `pnpm test` | **42 files passed, 5 skipped; 700 passed, 49 skipped**. Duration 1.70s. |
| DB integration, isolated | `RUN_DB_TESTS=1 pnpm vitest run …integration…` | **31 passed / 31** |
| Recon vs live DB | (auto-enabled by `APP_DATABASE_URL`) | **17 passed / 17** |
| **Full suite with DB** | `set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test` | **RED, and non-deterministic.** Run 1: 2 failed / 746 passed. Run 2: **4 failed** / 745 passed — *a different set of tests*. |
| Ledger invariants | `node scripts/dbcheck.mjs` | **14 passed, 0 failed** — UPDATE/DELETE/TRUNCATE refused on `journal_entry`, `journal_line`, `card_auth_event`, `hold_closure`; grants are INSERT,SELECT only; every entry sums to zero; trial balance zero; no stored balance column; zero denormalised-clock drift. |
| `/api/health` | live | 200, `status: ok`, DB reachable 12–167ms, **5 of 7 integration slots live** *(as at that reading; now 4 of 7 — see Iteration 1)* with round-trip evidence per slot |
| `/accounts`, `/approvals`, `/reconciliation`, `/` | live | all **200** |
| `/api/mcp` | live | **401 `not_configured`** — see §2 and §6 |

The flaky full run is not cosmetic. The failures are absolute-balance assertions
(`expect(after - before).toBe(250_00n)` → got `36111n`;
`expect(after?.n).toBe(before?.n)` → `218` vs `216`) that break because every DB test
runs against **one shared live database with no per-test isolation**, in parallel.
See §6.3.

---

## 1. Score by rubric category

### Domain command — **22 / 30**

This is the strongest work in the build, and it is genuinely strong. It is not full marks.

**What earns the score.** The mechanics really are in the schema, not the README, and the
schema is expert-level:

- `journal_line.amount_cents bigint` **signed** (debit +, credit −), so "the entry
  balances" is `SUM = 0` and "the balance" is `SUM * normal_side` — one column, two
  invariants, no `CASE` in any hot query (`db/migrations/0001_ledger.sql:314-337`).
- Two clocks as two columns, exactly as required: `value_date date` and
  `booking_seq bigint UNIQUE` drawn under an advisory lock so sequence order equals commit
  order (`0001_ledger.sql:255-268`), with a covering index per axis
  (`0001_ledger.sql:339-345`). `balanceAsBelieved()` is two predicates on those two axes
  (`src/lib/ledger/balances.ts:62-79`) — and it is **proven live**
  (`ledger.integration.test.ts`: "a backdated correction leaves BOTH time axes
  independently answerable").
- **The hold model is the best single idea in the repo.** `card_authorization` has
  **no status column, deliberately** (`0001_ledger.sql:487-489`); state is a fold over the
  `card_auth_event` *set*, and `H(E) = max(A(E) − C(E), 0)` with four closure predicates
  (`v_card_auth_state` / `v_card_auth_hold`, `0001_ledger.sql:1010-1053`). Incremental
  auth, partial capture, multiple captures, over-capture, expiry, reversal and
  out-of-order arrival all fall out of the algebra rather than being special-cased. Hold
  release is exactly-once *by construction*: `hold_closure` has `PRIMARY KEY (hold_id)`,
  so "released" is a primary-key existence check, not a flag
  (`0001_ledger.sql:241-247`).
- `rail_event_semantics` (`0001_ledger.sql:203-215`) makes the correction-vs-new-event
  decision **data**, keyed `(provider, provider_event_type)`, 22 seeded rows across card,
  ACH and USDC (`scripts/seed.mjs:328-545`). ACH return → `new_event` at the return date;
  card clearing reversal and USDC re-org → `correction` at the original value date. That
  is the correct answer and the per-row `note` fields show the candidate knows *why*.
- Maker-checker is a Postgres trigger, not TypeScript (`assert_maker_checker`,
  `0001_ledger.sql:671-738`), backed by `CHECK (NOT (kind <> 'human' AND can_approve))`
  at `0001_ledger.sql:97`. The TS layer is explicitly labelled advisory
  (`src/lib/approvals/state.ts:118-129`, `src/lib/approvals/gate.ts:4-19`) — the candidate
  resisted the obvious temptation to write the rule twice.
- Vocabulary is precise and used correctly under load: force post vs clearing,
  authorization advice, RDFI, R01, SEC code, trace number, NOC, ODFI drop time,
  warehoused effective date, filed availability policy.

**What costs the score.**

1. **The card lifecycle has no writer, and no test.** Nothing in `src/` or `scripts/`
   ever `INSERT`s into `hold`, `hold_closure`, `card_authorization` or `card_auth_event` —
   I grepped every SQL string in the tree and the only references are `dbreset.mjs` and
   `dbcheck.mjs`. `v_card_auth_state`, `v_card_auth_hold` and `v_hold_state` are read by
   **zero** application code. No unit test constructs an event set and asserts `H(E)`.
   The schema credit stands, but an unexercised view is a claim, not a proof — and under
   questioning "here is the SQL" is weaker than "here is the test that folds five events".
2. **Statements have a table and no renderer.** `statement` carries
   `(booking_watermark, content_hash)` and the versioning story is right
   (`0001_ledger.sql:545-559`), but nothing writes or reads it. "Identical every time" is
   a property of a canonical rendering function that does not exist.
3. **Standing orders do not exist at all** — honestly declared at
   `src/lib/mcp/tool-initiate-payment.ts:49` ("Beyond this it is a standing order, which
   this system does not have"), but that is a whole gauntlet item with no schema behind it.
4. **A vocabulary crack.** `card_event_kind` (`0001_ledger.sql:46-55`) cannot represent
   three canonical kinds the semantics table maps to: `refund_reversal`,
   `correction_debit`, `correction_credit`. The mapping table points at vocabulary the
   event table cannot store. A grader probing the card enum will find this.
5. `v_available_balance` hardcodes `a.code = '2100'` (`0001_ledger.sql:1108`) — available
   balance is defined for exactly one product code.

### A system that runs — **13 / 25**

**Deployed and stable: yes, unambiguously.** Real URL, real commit SHA surfaced at
`/api/health`, sub-second renders, no dead nav (`Payments` / `Statements` are rendered as
`aria-disabled` text, not 404 links — `src/components/app-shell/NavLinks.tsx:46-53`;
I confirmed both paths 404 and are correctly not linked).

**The five states: met, and better than most.** I verified all of them live, not from the
source. On `/accounts/acct_operating_4417`: default renders balances; `?state=empty` →
"No postings"; `?state=error` → "could not be loaded" plus a live Retry;
`?state=edge` → over-capture with negative available; `?auth=pending` → `−$50.00`
fuel-pump hold; and `?state=loading` **actually takes 8.19s wall-clock** because it
suspends a real async read rather than faking a skeleton
(`src/components/account/fixtures.ts:61`, Suspense boundary at
`src/app/(app)/accounts/[accountId]/page.tsx:44-49`). `/approvals` and `/reconciliation`
carry the same five, all URL-driven. The demo-state bar is deliberately styled as dashed
scaffolding "because a demo control that looks like a feature is a lie"
(`DemoStateBar.tsx:14-21`). That is the right instinct.

**Two demo roles: yes, and correctly de-fanged.** The role cookie is documented in its own
file as a demo affordance and not an authorisation boundary
(`src/components/app-shell/role.ts:11-20`), and the actor behind it is resolved **by
predicate, not by name** (`src/lib/approvals/session.ts:71-78`:
`WHERE kind='human' AND business_id IS NULL AND can_approve = $role`), so a tampered
cookie cannot produce an agent or an unseeded actor. Maker-checker does not depend on the
cookie at all — the DB trigger does the refusing.

**What costs the score — the core loop.** The published loop has seven legs. Two work:

| Leg | Status |
| --- | --- |
| Open an account behind a real KYB check | **No flow.** `src/lib/kyb/*` is 12 well-tested modules that **nothing outside its own directory imports** except the health probe. There is no onboarding route, action or page. |
| Fund it from a linked external bank | **No flow.** Plaid is probed live; no link-token → item → transfer path exists. |
| Issue a real sandbox card | **No flow.** `src/lib/rails/lithic/client.ts` is real and rate-limited; nothing calls it outside tests. |
| Authorise, then settle for a different amount days later | **Fixture only** (see §4). |
| Outbound payment needing a second approver | **Works, end to end, against the live DB.** Console → `decide.ts` → DB trigger; then a separate Release button → `release.ts:141-159` → `postEntry` → `ledger_append`. The live `/approvals` queue has ~50 real instructions with working Approve / Reject / Release. |
| Survive a reversed settlement | **Ledger half works** (`reverseAndRebook`, `post.ts:137-215`); no card settlement exists to reverse. |
| Reconcile the scheme file | **Works, live.** All three break kinds render in production with aging. |

**And the test suite is red on the run a grader will make.** `pnpm test` alone is green
but skips every DB test. With `.env` loaded and `RUN_DB_TESTS=1` — the exact command in
`ledger.integration.test.ts:6` — it fails, differently each run, because all DB tests
share one live database. Worse: **that database is the production one**
(`ep-curly-tooth-ayhug2be…` in both `APP_DATABASE_URL` and the deployed app's
`urlEnv`). Running the suite writes permanent, append-only rows into the demo. My own two
runs took `payment_instruction` to 109 and `journal_entry` to 233. A grader who runs the
tests changes the demo and cannot undo it.

### Integration reality — **12 / 20**

**The provider-facing half is excellent and comfortably clears "two or more".**
`/api/health` reports **5 live slots**, each with a round-trip probe rather than a
present-string check — Lithic `GET /v1/cards → 200` (207ms), Plaid
`POST /institutions/get → 200` (48ms), Increase `GET /accounts → 200` (684ms), Stripe
Identity (134ms), Lithic webhooks registered. Decision entries 011, 015, 016 and 017
record the candidate catching **their own probe lying in their own favour, three times**,
and fixing it. That is exactly the behaviour this bucket is meant to reward.

**Honest labelling: clean.** `business_registry` is `simulated` with the reason stated
("Every KYB option the brief lists … is gated behind sales"); `stablecoin` is `simulated`
with the *measured* reason ("holds 20.00 USDC but only 0 wei gas; a transfer needs
~390000000000 — cannot send"). The ACH simulator shouts `label: "SIMULATED"` in every log
line and every `/api/sim` response body including errors
(`src/app/api/sim/route.ts:16-21`), and is double-gated on `NODE_ENV !== 'production'`
**and** an explicit flag, answering 404 rather than 403 when off.

**Webhooks: the receiving half is textbook.** One route for five providers
(`src/app/api/webhooks/[provider]/route.ts`), `runtime = 'nodejs'` pinned *with the reason*
(Edge has no `node:crypto`, so an Edge deploy would fail at the first real delivery);
HMAC + `timingSafeEqual` for Lithic/Persona/Increase/Stripe and ES256 JWT for Plaid
(`route-handler.ts:104-147`, `rawbody.ts:111-120`); replay deduped by
`UNIQUE (provider, provider_event_id)` at the database (`0001_ledger.sql:156`); a
documented failure table returning 202 / 200-replay / 400 / 401 / 404 / 500 / 503, all
visible in the test log output.

**What costs the score — there are no consumers.**

- `ConsumerRegistry` exists (`dispatch.ts:87-110`) and **`consumers.register(...)` is
  never called anywhere.** The only `.register()` in `src/` is
  `route-handler.ts:287`, which registers a *signature verifier*, not a consumer.
- `dispatchOnce` / `dispatchUntilIdle` (`dispatch.ts:219`, `:328`) are **never invoked by
  any route, action or cron.** `vercel.json` declares no `crons` and there is no
  `/api/cron` route.
- Net effect: every signature-verified webhook is written to `webhook_inbox` and **nothing
  ever happens to it**. The `parked` state, the retry backoff, the dead-letter view, the
  `v_webhook_parked` view — all correct, all unreachable. The requirement says "idempotent
  **consumers**"; there are zero.
- **No polling fallback exists.** `research/lithic/NOTES.md:521` documents Lithic's
  `replay_missing` and `recover` endpoints; neither is implemented, and no backfill or
  catch-up job exists.
- **The README actively misinforms.** `README.md` still says "Status: scaffolding" and its
  integration table marks all five slots "not yet wired". This *understates* rather than
  overstates, so it is not an integrity failure — but it is the first file a grader opens,
  and it contradicts a health endpoint reporting five live slots.

### Live fire — **6 / 15**

Two of the seven scripted attacks are genuinely survivable today, four are design-only,
one has nothing. Detail in §4.

The one thing that lifts this above 4: **the "diagnose it rather than defend it" half is
already demonstrated in writing.** Decision 006 ("Lithic's status field lies" — measured,
not predicted), 008 ("The immutability guarantee was hollow, and the prover caught it"),
009 (a migration changed after it was applied; rebuilt from zero), 016 ("The same probe
bug again, **in my own favour** this time"), 020 ("three bugs only production could find").
That is a real, repeated pattern of measuring instead of arguing, and it is the behaviour
this bucket is actually testing for.

### Judgment and communication — **9 / 10**

`DECISIONS.md` is 845 lines / 20 entries and is the best artifact in the repo. It is
append-only with explicit supersession (001 → 002), every entry carries **Decision / Why /
Considered and rejected / Risk accepted**, and it records reversals against the author's
own interest. Entry 003 is a credible cut list with hour estimates per track
(T1 ~64h, T2 ~73h, T3 ~53h against ~34–38 productive hours), an expected score *and a
floor* per track, and the reasoning is the artifact rather than the conclusion.
Assumptions are written down and not blocking (002: KYB gating, "Asking on the thread,
not blocking on it"). A stranger can follow it.

`docs/MCP.md` (847 lines) and `docs/AGENT-LIMITS.md` (352 lines) are thorough.

**The one mark off is documentation that overclaims** — the exact failure mode this rubric
punishes elsewhere:

- `docs/AGENT-LIMITS.md:70-71` says the live self-approval test runs "on every run". It is
  `RUN_DB_TESTS`-gated and skips in CI. Verified: it skipped in my default run.
- `docs/AGENT-LIMITS.md:11-14` says `tools.test.ts` "fails the build if a tool named after
  one of them appears". It is a **substring blacklist over tool names**
  (`tools.test.ts:43-58`), defeated by naming a tool `execute_transfer`. The real
  protection is the closed registry, which is stronger — the doc undersells the good
  mechanism and oversells the weak one.
- `src/lib/approvals/state.ts:152` and `0007_approvals.sql:37` say released money is
  "handed to the rail" / "the money leaves". **No rail submission exists.** `release.ts`
  imports nothing from `src/lib/rails/*`.
- `scripts/seed.mjs:236` says below-threshold "the agent may submit unattended". The agent
  has no submit capability at any threshold.
- `.env.example` documents 15 secrets but omits **`APP_DATABASE_URL`** (the variable
  `src/lib/ledger/db.ts:18` actually reads) and **`MCP_AGENT_TOKENS`**. A fresh clone
  following `.env.example` does not boot.

### **TOTAL: 62 / 100**

| Category | Score |
| --- | --- |
| Domain command | 22 / 30 |
| A system that runs | 13 / 25 |
| Integration reality | 12 / 20 |
| Live fire | 6 / 15 |
| Judgment and communication | 9 / 10 |
| **Total** | **62 / 100** |

The shape of this build is unusual and worth naming plainly: **the hard half is done and
the easy half is missing.** The ledger, the hold algebra, the bitemporal model, the
maker-checker triggers and the webhook receiver are the parts most candidates get wrong,
and they are right here. What is absent is the wiring — the consumer functions, the drain,
the onboarding route, one env var — which is the part most candidates get right. That is a
much better position to be in at T+18h than the reverse, and §6 is sized accordingly.

---

## 2. Automatic-fail check

| # | Automatic fail | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | localhost only, or a video instead of a URL | **PASS** | https://corgi-trial-psi.vercel.app returns 200 on `/`, `/accounts`, `/approvals`, `/reconciliation`; `/api/health` returns `status: ok` with `commit.sha f39606a` from `VERCEL_GIT_COMMIT_SHA`. No video anywhere. |
| 2 | A simulated integration presented as live | **PASS** | Checked hardest here. `/api/health` labels every slot `live` or `simulated` **with per-slot evidence**, and both simulated slots state *why* (Connect gated; 0 wei gas). The ACH simulator emits `label: "SIMULATED"` on every log line and response body (`achsim/control.ts`, `api/sim/route.ts:16-21`) and is unreachable in production. The account screen's fixtures sit under a dashed "Demo state" bar explicitly styled not to look like a feature (`DemoStateBar.tsx:14-21`). The reconciliation screen's file is rendered from the ACH simulator, and while the screen carries no "SIMULATED" badge, the filename shown in production is literally **`achsim-settlement-2026-09-10.csv`** and the header carries a `Sandbox` badge. Honest — though see §6.5 for the cheap way to remove all doubt. |
| 3 | UPDATE or DELETE on money rows anywhere ever | **PASS**, and unusually well proven | Three independent layers. Privileges: `REVOKE ALL … FROM PUBLIC` then `GRANT SELECT, INSERT` only, with a deliberately redundant explicit `REVOKE UPDATE, DELETE, TRUNCATE … FROM corgi_app, PUBLIC` ("the line a reviewer greps for", `0001_ledger.sql:816-832`). Triggers: `%I_no_update_delete` + `%I_no_truncate` installed over 15 tables (`0001_ledger.sql:748-775`, repeated for recon tables at `0006_recon.sql:176-185`). Runtime proof: `dbcheck.mjs` **14/14 PASS**, each forbidden statement actually attempted and refused with `permission denied`. Source scan: zero `UPDATE … SET` / `DELETE FROM` / `TRUNCATE` statements in `src/` outside comments; the one `ON CONFLICT` on a money-adjacent table is `DO NOTHING`, not `DO UPDATE` (`instructions.ts:265`). The single sanctioned mutation is `webhook_inbox.processed_at/processing_error/attempts`, column-scoped via `GRANT UPDATE (…)` and guarded by `webhook_inbox_guard()` (`0001_ledger.sql:779-800`) — not a money row. |
| 4 | Live-mode API keys, real money, or real personal data | **PASS** | Every key in `.env` is sandbox/testnet: Lithic sandbox, Plaid sandbox, Increase sandbox, `sk_test_…` for Stripe, Base **Sepolia** testnet USDC. `src/lib/env.schema.ts:78` and `:183` actively **refuse** any value starting `sk_live`. Seeded businesses are fictional ("Blue Ridge Coffee Roasters LLC", "Ridgeline"). No real PII found. |
| 5 | Secrets committed to the repo | **FAIL — remediable in 30 minutes** | Two live-shaped credentials sit in tracked files, and `research/` is **not** in `.gitignore`: `research/plaid/NOTES.md:253` pastes a real Plaid **`access-sandbox-<REDACTED, ROTATED>…`** token — and the note two lines below says it is *"long-lived — persist it (encrypted at rest)"*; `research/lithic/NOTES.md:521` pastes **`whsec_REDACTED-ROTATED`** captured from a real `GET /v1/event_subscriptions/{tok}/secret` response (it does **not** match the current `.env` value, so it is probably rotated — but the shape and provenance are genuine, not a doc placeholder). Line 614 of the same file is fine: `whsec_MfKQ9r8…` is the public Standard Webhooks test vector. Mitigating: both are sandbox-scope, no live keys, no money at risk, and `.gitignore` is otherwise unusually careful (`*.local.md` listed *before the file was created*, plus `.*.local.md*` added after the incident in decision 013). Aggravating: **decision 013 self-reports that an editor swap file of the secrets scratchpad was already committed once.** As written, the rule is flat: a credential in a tracked file is a committed secret. **Not fully verified** — I was instructed not to run git commands, so history was not scanned; the working-tree finding alone is sufficient. |
| 6 | Code the candidate cannot explain line by line | **NOT ASSESSABLE** (no red flags) | Cannot be judged without the debrief. Nothing suggests it: comment density is extreme and *reason-giving* rather than restating, decisions record measurements that contradict the author's assumptions, and several comments name the specific bug that motivated the line (e.g. `post.ts:88` "`ledger_append` fails with 'cannot extract elements from a scalar'. Found by…"). One caveat worth naming: `AGENTS.md` and the decision log (entry 007, "I turned CI red by committing another worker's half-written files") indicate multiple agents wrote this tree. The candidate should expect to be asked about a module they did not personally type — `src/lib/mcp/*` and `src/lib/recon/*` are the largest such surfaces. |

**One automatic fail is live (#5).** It is the cheapest thing on the entire list to fix
and it is ranked #2 in §6.

---

## 3. Domain gauntlet

"It is in the decision log" is not evidence. Each row cites schema, code or a passing test.

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Ledger vs available balance, derived, never stored | **IMPLEMENTED** | `v_ledger_balance` and `v_available_balance` are pure `SUM`s (`0001_ledger.sql:998-1110`); `src/lib/ledger/balances.ts:113` derives `ledger − holds − uncleared`. **`dbcheck.mjs` asserts "no stored balance column"** and passes. Read live by `src/lib/mcp/gateway.ts` and proven by `mcp.integration.test.ts` "runs get_balance against the real ledger". *Deduction:* `v_available_balance` is hardcoded to `code = '2100'` (`:1108`). |
| 2 | Auth lifecycle: incremental, partial, multiple, over-capture, expiry, reversal, hold released exactly once | **PARTIAL — schema only** | The algebra is correct and complete: `card_event_kind` enum (`0001:46-55`), `v_card_auth_state` folding `A(E)`/`C(E)` over the event set (`0001:1010-1029`), `v_card_auth_hold` with `GREATEST(auth_net − captured, 0)` and four closure predicates (`0001:1034-1051`), exactly-once release by `hold_closure PRIMARY KEY (hold_id)` (`0001:241-247`). **But no code ever writes `card_authorization`, `card_auth_event`, `hold` or `hold_closure`, no code reads those three views, and no test exercises the fold.** Verified by exhaustive grep of every SQL string in `src/` and `scripts/`. |
| 3 | Settlement is not authorisation (different amount, days later, force post) | **PARTIAL — schema only** | Modelled correctly and separately: `origin CHECK IN ('authorization','clearing_first','force_post')` (`0001:500`); clearing and force-post both feed `C(E)` and neither touches `A(E)`; `value_date` on `card_auth_event` is documented as the **local transaction date, not the settlement date** (`0001:513`); `rail_event_semantics` gives clearing `value_date_source: payload.created` vs authorization's `payload.events[].created` (`seed.mjs`). No writer, no test. |
| 4 | Out-of-order delivery: park it, match later, never crash, never double-count | **PARTIAL — two halves, neither joined** | *Design half, right:* no status column means "there is no order to be out of" (`0001:487-489`), `auth_net_cents` may legally go negative and `H` clamps at 0 (`0001:1021-1023`), `card_auth_event_dedup UNIQUE (auth_id, provider_event_id)` makes the stream a **set** so `H(E)` is order-free (`0001:518`). *Transport half, right:* `webhook_inbox_state` includes `'parked'` with `parked_on_kind`/`parked_on_ref` and a `CHECK` that a parked row must carry a referent (`0002:40`, `:141-144`), plus `v_webhook_parked` and a `parked()` result constructor (`dispatch.ts:61`). **The two halves are never connected**: no consumer parks a card event and nothing re-drives parked rows (see §5 row 4). |
| 5 | Returns and recalls appear on the day they happened | **PARTIAL** | The decision is **data, not code**: `rail_event_semantics` gives `increase/ach_transfer.updated/returned → ach_return, new_event, value_date_source: payload.return.created_at`, with the note "THE row people get wrong" (`seed.mjs`). USDC re-org correctly goes the other way (`correction`, `original.value_date`). Decision 019 records the full live Increase lifecycle including an R01 return, measured. **But nothing reads `rail_event_semantics` — zero references in `src/`.** The right answer is in a table that no code path consults. |
| 6 | Bitemporality: value date and booking date as separate columns, provable what we believed on an intermediate day | **IMPLEMENTED** | Two columns on `journal_entry` (`0001:258-262`) and denormalised onto `journal_line` with a drift-detector view (`v_line_denorm_drift`) that `dbcheck` proves empty. `balanceAsOf` vs `balanceAsBelieved` vs `bookingWatermarkAt` (`balances.ts:32/62/85`). **Proven live** by `ledger.integration.test.ts` "a backdated correction leaves BOTH time axes independently answerable" and `mcp.integration.test.ts` "answers the bitemporal question on both axes". |
| 7 | Statements for a closed day reproducible forever, identical every time | **MISSING in practice** | `book_day` pins a `booking_watermark` at close (`0001:531-543`) and `statement` is correctly a `(period, watermark, version, content_hash)` tuple (`0001:545-559`) — the *model* is right, including "a corrected statement is a new document with a version, never an edit". **But nothing writes or reads the `statement` table, and no canonical rendering function exists**, so "identical every time" is untested and unproduceable. The nav item is `aria-disabled`. |
| 8 | Standing orders firing exactly once across restarts | **MISSING** | No table, no scheduler, no code. Declared absent at `tool-initiate-payment.ts:49`. No cron in `vercel.json`. |
| 9 | Scheme reconciliation with a breaks screen and aging | **IMPLEMENTED** | `recon_run` / `recon_run_break` with `break_kind CHECK IN ('in_file_not_ledger','in_ledger_not_file','amount_mismatch')`, a five-value `reason_code`, five-value `severity`, `age_days`, `closes_crossed`, and an evidence `CHECK` that a mismatch must carry **both** amounts (`0006_recon.sql:111-165`). Aging buckets 0–1/2–3/4–7/8–30/31+ (`recon/aging.ts:68-97`). Live in production: all three break kinds rendering, plus an "Explained" severity for reversal-and-rebook. **8 live-DB tests pass.** |
| 10 | Maker-checker: initiator can never approve their own, and neither can the agent | **IMPLEMENTED** | `assert_maker_checker` BEFORE INSERT trigger raises `42501` on `NEW.actor_id = v_pi.requested_by` (`0001:691-695`) and on any non-human or non-approving actor (`0001:686-689`); `CHECK (NOT (kind <> 'human' AND can_approve))` makes an approving agent **unrepresentable** (`0001:97`); approvals counted as `count(DISTINCT actor_id) … AND a.kind='human'` (`0001:708-713`). The app runs as `corgi_app`, which cannot disable a trigger. **13 live-DB tests pass**, including "THE DATABASE refuses a self-approval, and the application only translates it". |

**Score: 4 implemented, 4 partial, 2 missing.**

---

## 4. Live fire — the seven they will run

| # | Scripted attack | Status | Evidence / what actually happens |
| --- | --- | --- | --- |
| 1 | Create a card, simulate a $50 fuel-pump auth — available drops, ledger does not | **PARTIAL — fixture** | The *number* is real and measured (decision 006, against the Lithic sandbox) and `/accounts/…?auth=pending` renders `−$50.00` against an unchanged ledger balance. But it is `src/components/account/fixtures.ts`, not a hold row: `AccountView.tsx:33` calls `getAccountDataSource(view)`, whose own header says *"returns a fixture today"* (`fixtures.ts:5-8`). No card is created (nothing calls `lithic/client.ts`), no `hold` row exists, `v_hold_state` is not queried. **Survives a screenshot; does not survive "show me the row".** |
| 2 | Capture $73.40 two days later — hold releases exactly once, ledger posts the settled amount | **PARTIAL — fixture** | Same fixture path. The mechanism that *would* be correct is real and unreachable: `H = max(A−C,0)` drives to 0 on over-capture (`0001:1043`), and release is exactly-once by `hold_closure`'s primary key. Not demonstrable against the database. |
| 3 | Reverse that settlement next day, then pull the statement for settlement day | **PARTIAL** | The correction half is genuinely strong: `reverseAndRebook` carries **the original's value_date, deliberately** (`post.ts:137-176`), `assert_reversal_is_exact` enforces exactness (`0001:435-478`), `journal_entry_one_reversal_idx` makes a double-fire impossible (`0001:303-304`), and the bitemporal test proves both axes stay answerable. **But there is no statement to pull** (gauntlet 7), and no card settlement to reverse. The candidate can show this on an ACH entry via the ledger API; not on the card path, and not as a document. |
| 4 | Deliver a settlement before its auth | **PARTIAL — design-only** | Architecturally the best-prepared item in the build and the least demonstrable. `origin = 'clearing_first'` exists for exactly this (`0001:498-501`), the event set is order-free by dedup key, and `webhook_inbox` has a `parked` state with a referent. **But there is no card consumer to park anything and no drain to re-drive it.** Delivered out of order today, the settlement lands in `webhook_inbox` as `pending` and stays there forever. It will not crash and will not double-count — because it will not do anything. |
| 5 | Initiator tries to approve their own payment | **IMPLEMENTED** ✅ | `0001_ledger.sql:691-695`, a `BEFORE INSERT` trigger, raising `42501`. Proven live by `approvals.integration.test.ts` "THE DATABASE refuses a self-approval, and the application only translates it" and "takes an agent's instruction into the same queue and refuses its approval". The live `/approvals` queue in production renders "You raised this" / "Cannot approve" on the initiator's own rows. **This one is airtight — the refusal is in Postgres and the app only translates the error code.** |
| 6 | Delete one row from the scheme file, ask the breaks screen where it went | **IMPLEMENTED** ✅ | `src/lib/recon/planted-break.test.ts` is written for this attack by name and **passes against the live database**: "finds the row the graders deleted: `in_ledger_not_file`, right reference, right amount", plus the inverse, the amount mismatch carrying **both** numbers, re-run producing a *new* run without touching the previous one, and the reversal-and-rebook edge case that explains a break without erasing it. Production `/reconciliation` renders all three kinds with aging and drill-through. |
| 7 | Turn off the issuing provider's webhooks for five minutes mid-demo | **MISSING** ❌ | Nothing recovers. There is no consumer, no drain invocation, no cron in `vercel.json`, no `/api/cron` route, and no polling backfill — `research/lithic/NOTES.md:521` documents Lithic's `replay_missing` and `recover` endpoints and neither is implemented. When webhooks resume, the provider re-delivers into `webhook_inbox` (where dedup works correctly) and then nothing consumes them, exactly as before the outage. The honest answer during the demo is "nothing was being consumed before the outage either", which is worse than the attack. |

**2 of 7 live-fire attacks survivable at that commit.** *(Now 6 of 8 — see Iteration 1. This line scores ATTACKS, not integration slots.)*

---

## 5. The ten non-negotiables

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Deployed with two demo roles | **IMPLEMENTED** | Live at Vercel, `/api/health` 200 with commit SHA. Roles: `role.ts:22-24` (`staff`, `approver`), switched by a server action so it survives reload and works without JS (`app/(app)/actions.ts:20-32`), resolved to a seeded actor **by predicate** (`session.ts:71-78`). Honestly labelled a demo affordance, and correctly not load-bearing — the DB trigger is. |
| 2 | Candidate-written ledger: double-entry, append-only, immutable, balances derivable including as at any past date | **IMPLEMENTED** | Written from scratch, no ledger library. Double-entry enforced by a **deferred constraint trigger** (`assert_entry_balanced`, `0001:355-413`) with the reason for deferral stated. Append-only at privilege + trigger layers. Immutable with a **sha256 hash chain** (`prev_hash`/`hash`, `0001:290-292`) and a `verify_chain(entity)` function (`0001:962`). Single sanctioned write path: `ledger_append()`, with `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO corgi_app` (`0001:858-955`). As-at-any-past-date via `balanceAsBelieved` (two axes), proven live. `dbcheck` 14/14. |
| 3 | Two or more genuinely live integrations | **IMPLEMENTED — exceeded** | **5 live slots** with round-trip probe evidence in `/api/health`: Lithic, Plaid, Increase, Stripe Identity, Lithic webhooks. Decisions 011/015/016/017 document three separate probe bugs the candidate caught in their own favour and fixed. |
| 4 | Webhooks done properly: signatures verified, idempotent consumers, out-of-order tolerated, polling a fallback not the design | **PARTIAL — receiving half only** | *Signatures:* 5 providers, HMAC + `timingSafeEqual` and Plaid ES256 JWT, `runtime='nodejs'` pinned with the reason (`route-handler.ts:104-147`, `rawbody.ts:111-120`). *Idempotency:* `UNIQUE (provider, provider_event_id)` at the DB (`0001:156`), replay returns 200. *Out-of-order:* schema and inbox both ready. ***Consumers:* none. `consumers.register()` is never called; `dispatchOnce`/`dispatchUntilIdle` are never invoked; no cron.** *Polling:* not implemented at all, so it is neither the design nor a fallback. |
| 5 | The correction test | **IMPLEMENTED** | `reverseAndRebook` reverses at the **original** value date and re-books at the correct one, never an edit (`post.ts:125-215`); `assert_reversal_is_exact` (`0001:435-478`); at most one reversal per entry (`0001:303-304`); `entry_type` enum `original`/`reversal`/`rebook` tied by `correction_group_id`. Proven live: "a backdated correction leaves BOTH time axes independently answerable". Reconciliation independently understands the case ("a reversal plus re-book explains the break without erasing it", passing). |
| 6 | Approvals above a threshold, initiator ≠ approver, no agent approving | **IMPLEMENTED** | Threshold is versioned **data**: `approval_policy (rail, effective_from, threshold_cents, required_approvals)` (`0001:626-634`), and each instruction pins the `policy_id` it was judged under, so a later policy change cannot retroactively re-judge it. Lifecycle policed by `assert_payment_lifecycle` (`0007:97-210`): `requested` exactly once and first, decisions only while pending, release blocked after reject, double-release blocked, approval count gated, outcomes cannot precede release. 13 live-DB tests pass. *One latent gap worth naming:* the policy version is selected by the payment's `value_date`, which over MCP is caller-supplied up to 90 days out (`tool-initiate-payment.ts:330-345`); inert today because no future-dated policy row exists, but it becomes an agent-steerable threshold the moment one is written. |
| 7 | Reconciliation as a feature with a breaks screen | **IMPLEMENTED** | See gauntlet 9. Live in production, DB-backed with an honest fixture fallback that "SAYS SO on its face" (`reconciliation/page.tsx:52`), three break kinds, five severities, aging buckets, run history, rejects panel, drill-through. 17 live-DB tests pass. |
| 8 | MCP surface: 3 read tools + 1 write tool landing in the approval queue, plus a written list of operations never handed to an agent | **PARTIAL — implemented, but inert in production** | *Code:* exactly right. 3 read (`get_balance`, `list_transactions`, `list_recon_breaks`) + 1 write (`initiate_payment`), closed registry (`tools.ts:15-20`). The write tool **structurally cannot** move money: it has no DB handle and no ledger import, and the `Gateway` interface exposes no approve/reject/release method at all (`types.ts:140-171`) — the refusal is architectural, not promised. Response is forced honest: `status: "queued_for_human_approval"`, `money_moved: false`, both pinned in the output schema. Auth is bearer + sha256 + `timingSafeEqual`, with the loop deliberately not breaking on a hit so timing does not leak position (`auth.ts:185-197`). The written list is `docs/AGENT-LIMITS.md` (8 numbered entries). **Verified live and it does not work:** `POST /api/mcp` with any token returns `401 {"reason":"not_configured"}` — `MCP_AGENT_TOKENS` is set nowhere, not in `.env`, not in `.env.local`, not even in `.env.example`. **A grader cannot exercise the MCP surface at all.** Also: the enforcement is an allowlist (strong), not the denylist `AGENT-LIMITS.md:11-14` describes (weak, substring-over-names, test-time only). |
| 9 | Money never a float | **IMPLEMENTED** | Zero `float`/`real`/`double precision`/`numeric`/`money` columns anywhere in `db/migrations/*.sql` — every money column is `bigint` cents. `post.ts:94` refuses `Number(l.amountCents)` by name and lets Postgres cast. `format/money.ts:7`: "no `/ 100`, no `toFixed`, no `Intl.NumberFormat` fed a decimal". `recon/parse.ts:24` documents *the actual bug*: `parseFloat("73.40") * 100 === 7340.000000000001`. `increase/client.ts:363` is the single conversion site and "refuses rather than truncates". Sub-cent USDC dust posts to account 2900 rather than being truncated. |
| 10 | A decision log written as you go | **IMPLEMENTED** | `DECISIONS.md`, 845 lines, 20 timestamped entries, append-only with explicit supersession, recording measurements that contradicted the author's own assumptions. Genuinely written as-you-go: entry 020 is timestamped T+18h and the tree matches it. |

**Score: 7 implemented, 3 partial, 0 missing** — but two of the three partials (#4 consumers, #8 production config) are the difference between "built" and "demonstrable".

---

## 6. THE TOP FIVE THINGS TO FIX NEXT

Ranked by **points per hour**. Sequencing note: do 1, 2 and 3 inside the first hour — they
are 20 minutes of typing each and two of them are worth more than a day of new code. Then
start #5, because it is the largest absolute gain and needs the runway.

### 1. Set `MCP_AGENT_TOKENS` in Vercel — **~10 minutes, ~3–4 points**

Non-negotiable 8 is fully built, well tested and **completely unusable on the deployed
system**. I confirmed it directly:

```
POST /api/mcp  Authorization: Bearer <anything>
→ 401 {"code":-32001,"data":{"reason":"not_configured"}}
```

The variable is read at `src/app/api/mcp/route.ts:55` and exists in **no** env file —
`.env`, `.env.local` and `.env.example` all omit it, and it is absent from
`src/lib/env.schema.ts` (there is a live TODO admitting this at `auth.ts:24-29`).

Do this:
1. Mint a grant in the format `docs/MCP.md:52` demonstrates; set `MCP_AGENT_TOKENS` in the
   Vercel project (Production **and** Preview) and redeploy.
2. Add it to `.env.example` **and** to `src/lib/env.schema.ts` so a missing value is a
   startup error rather than a silent 401.
3. While in `.env.example`: it is also missing **`APP_DATABASE_URL`**, the variable
   `src/lib/ledger/db.ts:18` actually reads. A fresh clone following that file does not
   boot. Add both.
4. Add the working `curl` to the README so a grader can exercise it in one paste.

Highest points-per-hour in the build by an order of magnitude: it converts a graded
requirement from "we tested it locally" to "run it yourself".

### 2. Purge two credentials from `research/` and rotate them — **~30 minutes, clears the live automatic fail**

This is the only automatic fail currently tripping, and it is a text edit.

- `research/plaid/NOTES.md:253` — a real `access-sandbox-REDACTED-ROTATED`
  token, which the note itself describes as long-lived and requiring encryption at rest.
- `research/lithic/NOTES.md:521` — `whsec_REDACTED-ROTATED`, captured from
  a real `GET /v1/event_subscriptions/{tok}/secret` response. (Leave line 614 alone —
  `whsec_MfKQ9r8…` is the public Standard Webhooks test vector and is correctly labelled
  as such.)

Do this:
1. Replace both with `<redacted — see .env>`.
2. **Rotate both** at the provider. Lithic has
   `POST /v1/event_subscriptions/{tok}/secret/rotate` (old valid 24h) — documented three
   lines below the leak.
3. Since git history is out of my scope but not out of a grader's: either scrub with
   `git filter-repo` before the freeze, or add one line to `DECISIONS.md` naming exactly
   what leaked, that it was sandbox-scope, and that it was rotated. **Disclosed and
   rotated reads as competence; found by a grader reads as the automatic fail.** Decision
   013 already establishes the candidate discloses these — follow the same pattern.
4. Extend `scripts/precommit.sh` with a regex for `whsec_`, `access-sandbox-`,
   `access-production-`, `sk_live`, `sk_test_` over the whole tree, and add `research/`
   to the scan. The existing `.gitignore` is careful about `*.local.md` and simply never
   anticipated that hand-written research notes are also a secrets surface.

### 3. Give the tests their own database — **~30 minutes, ~2 points plus demo safety**

`APP_DATABASE_URL`, `DIRECT_URL` and the deployed app all point at the same Neon endpoint
(`ep-curly-tooth-ayhug2be…`). Consequences, all of which I hit:

- `RUN_DB_TESTS=1 pnpm test` is **red and non-deterministic** — 2 failures on one run,
  4 different ones on the next — because DB tests run in parallel against shared state and
  assert on absolute balances (`ledger.integration.test.ts:72`,
  `approvals.integration.test.ts:392`).
- **Running the suite permanently mutates the demo.** Money rows are append-only by
  design, so the pollution cannot be cleaned without `dbreset`. My two runs took
  `payment_instruction` to 109 and `journal_entry` to 233. The `/approvals` queue now
  shows ~50 instructions, most of them test residue.
- A grader who runs `pnpm test` during the demo — which the brief invites — changes what
  the demo shows, mid-demo.

Do this: create a Neon **branch** (instant, free, same data) and point a `TEST_DATABASE_URL`
at it; have the integration tests read that variable and refuse to run if it equals
`APP_DATABASE_URL`. Then make the assertions delta-based against a per-run entity id so
parallelism stops mattering. Add `RUN_DB_TESTS=1` against that branch to CI — right now CI
proves none of the invariants that carry this build.

### 4. Point the account screen's default state at the real ledger — **~1–2 hours, ~3 points**

`/accounts` is the screen that demonstrates the single most important claim in Track 3 —
ledger and available as two different derived numbers — and it is entirely fixtures
(`AccountView.tsx:33` → `getAccountDataSource()`; `fixtures.ts:5-8` "returns a fixture
today"). It is honestly labelled, so it is not a fail, but it is a fixture standing where
the load-bearing number belongs.

The candidate has already written the swap and left it in a comment
(`fixtures.ts:6-29`): `if (state === "default") return createLedgerDataSource();`, with the
field-by-field mapping onto `availableBalance()` spelled out. `src/lib/ledger/balances.ts`
exists, works, and is already proven against the live DB by the MCP tests. Keep every
non-default state on fixtures — that is the right call and the file already argues for it.

Two queries do not exist yet and are the actual work: holds with their `A(E)`/`C(E)` terms
(select from `v_hold_state` joined to `v_card_auth_hold`), and postings with a `book`
column. Both are straightforward reads of views that are already written and currently
have **zero** callers — so this task also retires the "unexercised view" criticism in §1.

### 5. Wire **one** card consumer and a drain — **~4–6 hours, ~10–12 points**

Largest absolute gain in the build. Today every signature-verified webhook lands in
`webhook_inbox` and **nothing consumes it**: `consumers.register()` is never called, and
`dispatchOnce`/`dispatchUntilIdle` (`dispatch.ts:219`, `:328`) are never invoked by any
route or cron. The receiving half is excellent and the pipeline stops dead at the table.

This single change flips gauntlet 2, 3 and 4 from PARTIAL to IMPLEMENTED and live-fire
1, 2, 3, 4 and 7 from fixture/design to demonstrable.

Do this, in this order:

1. **A `lithic` consumer** (`src/lib/webhooks/consumers/lithic.ts`) that maps
   `card_transaction.updated` through the vocabulary already seeded in
   `rail_event_semantics` — the mapping table has 10 Lithic rows and **zero readers**; make
   it the consumer's lookup, which also retires the gauntlet-5 criticism. On each event:
   upsert `card_authorization` (setting `origin` to `clearing_first` when a clearing
   arrives first, which is what that column was built for), insert `card_auth_event`
   (the `UNIQUE (auth_id, provider_event_id)` dedup makes the consumer idempotent for
   free), and post the memo entry through `postEntry`.
2. **Register it**: `consumers.register(lithicConsumer)`.
3. **A drain**: `src/app/api/cron/drain/route.ts` calling `dispatchUntilIdle`, plus a
   `crons` entry in `vercel.json` (there is none today) at `* * * * *`. Also call
   `dispatchOnce` inline after the inbox insert so the demo does not wait for a tick.
   The drain is what makes live-fire 7 answerable: when webhooks come back, the parked and
   pending rows drain and the balances converge — *that* is the demo, and it is far more
   impressive than "we never lost the event".
4. **Fix the enum crack** while in there: `card_event_kind` cannot represent
   `refund_reversal`, `correction_debit` or `correction_credit`, which the semantics table
   maps to. Add the three labels.
5. **Then delete the account-screen fixture for the default state** (#4 above) and run the
   published live-fire script end to end against the real database.

If time runs out mid-way, stop after step 3 with authorisation and clearing only. Auth +
clearing alone buys live-fire 1, 2 and 4; refunds and expiry can stay on the clock-based
predicate that already works.

---

**Deliberately not in the top five**, and here is why:

- **Statements (gauntlet 7).** Real points, but a canonical renderer plus a versioning
  path plus a UI is most of a day, and it depends on there being card settlements to put
  on a statement — i.e. on #5 landing first. If #5 finishes early, this is #6.
- **Standing orders (gauntlet 8).** Correctly cut. Entry 003's cut-list logic applies:
  it is the lowest-value gauntlet item and needs a scheduler the architecture has
  deliberately avoided ("no cron required" is a *feature* of the hold model). Add one line
  to `DECISIONS.md` naming it as a conscious cut with the reason — a declared cut scores
  in the judgment bucket; a silent absence does not.
- **`search_path` hardening on the two trigger functions.** `0003_harden_definer.sql`
  pins `search_path` on `ledger_append()` and `verify_chain()` with an excellent argument,
  and did not apply the same to `assert_maker_checker()` (`0001:671`) or
  `assert_payment_lifecycle()` (`0007:97`), which resolve `actor` and
  `payment_instruction` unqualified. Not exploitable — every query is a parameterised
  tagged template, so there is no injection vector, and `pg_temp` shadowing needs
  arbitrary SQL as `corgi_app`. But it is two `ALTER FUNCTION … SET search_path` lines plus
  `REVOKE TEMPORARY ON DATABASE`, and it is exactly the latent-not-live reasoning 0003
  applies to itself. **Five minutes; do it while waiting for a deploy.**
- **The doc overclaims listed in §1.** Ten minutes of edits, no points on their own — but
  every one of them is a sentence a grader can catch the candidate out on, and this build's
  entire credibility rests on the claim that its documentation is honest. Fix them with #2.
- **Migration `0004` is missing** (0001, 0002, 0003, 0005, 0006, 0007) and
  `scripts/migrate.mjs:22` sorts filenames with **no gap detection**, so the absence is
  silent. Either recover it or add a line to `DECISIONS.md` saying the number was skipped.
  A grader who lists that directory will ask.
- **Release never reaches a rail.** `release.ts` posts to the journal and stops, while
  `state.ts:152` and `0007:37` claim the money "leaves" / is "handed to the rail". Fixing
  the *claim* is free and belongs with #2. Fixing the *behaviour* is out of scope before
  freeze — and posting to the ledger without submitting is arguably the safer half to have
  built.

---

## 7. "Unwritten test" ideas — what would actually impress

These are chosen to exploit what is *already built* and currently unexercised. Each is
cheap because the hard part exists; each answers a question a panel will actually ask.

1. **Fold the same card event set in five different arrival orders and assert one
   answer.** Generate the 120 permutations of {auth $50, incremental +$25, partial
   clearing $40, clearing $33.40, final flag}, insert each permutation into a fresh
   `card_authorization`, and assert `v_card_auth_hold.target_hold_cents` and the ledger
   balance are byte-identical across all 120. This is the single highest-value test in the
   build: it turns "the event set is order-free by construction" from an argument into a
   fact, and it directly pre-empts live-fire 4. The schema already makes it true — nobody
   has checked.

2. **A property test for exactly-once hold release.** Fire the release path *N* times
   concurrently against one hold and assert `hold_closure` has one row, the memo balance
   is 0, and `available_cents` moved exactly once. `hold_closure PRIMARY KEY (hold_id)`
   should make this trivially true; proving it under concurrency is what makes the claim
   land. Pair it with a concurrent double-`releasePayment()` — the idempotency-key path in
   `ledger_append` should make one entry and roll the loser back.

3. **The statement reproducibility test, before the statement UI.** Render Tuesday at
   Tuesday's watermark, hash it; post Thursday's backdated correction; re-render Tuesday
   v1 at the *same* watermark and assert **the same sha256**, then render v2 at the new
   watermark and assert a different hash and a different number. This proves gauntlet 7
   without building a single pixel, and it is the exact live-fire 3 question. `book_day`
   and `statement.content_hash` already exist for it.

4. **Chaos-replay the inbox.** Take a recorded sequence of real Lithic deliveries and
   replay it with random duplication, 30% reordering, and a five-minute blackout in the
   middle; assert final balances equal the clean-order run. That is live-fire 7 as a test
   rather than a hope, and it exercises the `parked` machinery that currently has no
   caller. Run it in CI against the test branch from fix #3.

5. **Run `verify_chain()` in `dbcheck` and in CI.** The hash chain is built
   (`0001:962-996`) and **nothing ever calls it**. `dbcheck` already proves 14 invariants;
   a 15th line that verifies the chain end to end costs one query and converts "tamper-
   evident" from a schema comment into a passing assertion. Then tamper with a row as the
   owner and show it going red — that demo takes 30 seconds and is unusually convincing.

6. **A negative test with the owner connection.** Every immutability proof today runs as
   `corgi_app`, which cannot express the forbidden statement. Connect as the **owner**,
   `UPDATE journal_line SET amount_cents = …`, and show the *trigger* refusing where the
   privilege layer no longer protects. That is what makes "defence in depth" a
   demonstrated claim rather than a stated one — and it is the question a good reviewer
   asks the moment they see `REVOKE` and a trigger doing the same job.

7. **Make `dbcheck` assert the negative space.** It already proves "no stored balance
   column". Add: no money column is `float`/`numeric`; every table in the append-only list
   carries both triggers; `corgi_app` holds no `UPDATE`/`DELETE` grant on any money table;
   `v_entry_unbalanced`, `v_line_denorm_drift`, `v_hold_drift`, `v_book_not_zero`,
   `v_deposit_control_drift` and `v_late_postings` all return zero rows. Six of those
   invariant views exist (`0001:1112-1187`) and are described as "TESTS" in their own
   comment — and none of them is currently checked by anything.

---

## Bottom line

**62 / 100 at roughly T+18h, with one automatic fail live (secrets in `research/`) that is
30 minutes of work to clear.**

The ledger is the real thing: append-only, hash-chained, double-entry, bitemporal on two
genuine columns, immutable at both the privilege and trigger layers, with balances derived
and provable as at any past date and a 14/14 prover that actually attempts the forbidden
statements. Maker-checker is enforced by Postgres and the application only translates the
error code. The hold algebra — `H(E) = max(A−C, 0)` over an event *set*, with no status
column — is a better answer to the authorisation gauntlet than most production issuers
have. Five sandbox integrations are live with round-trip evidence, and the decision log is
the strongest communication artifact I have read in a trial of this shape.

What is missing is not depth, it is **connection**. There are no webhook consumers and
nothing drains the inbox, so verified events accumulate and die in a table. Nothing writes
a hold, an authorisation or a card event, so the best code in the repo has no caller and no
test. The account screen — the one that demonstrates ledger-versus-available — is a
fixture. The MCP surface is built, tested and switched off in production for want of one
environment variable. Two of seven live-fire attacks survive; five meet a system that
correctly declines to do anything at all.

That is a recoverable position, and an unusually good one to be in at the halfway mark:
the parts that take judgment to get right are right, and the parts that remain take typing.
The two-hour version of §6 (items 1–3, plus the doc corrections and the `search_path`
lines) clears the automatic fail, turns CI green, and makes a graded requirement
exercisable — call it 62 → 68. The full list, if #5 lands, is a genuinely different build:
the hold model gets a caller, the live-fire script becomes runnable end to end, and the
score goes to the mid-to-high 70s. That is the number entry 003 predicted for this track,
which suggests the estimate was honest.

---

## 8. ADDENDUM — the tree moved during this evaluation

Written 2026-09-10 ~16:50Z. Disclosed rather than quietly folded in, because the
measurements in §0–§7 were taken against `f39606a` and remain accurate for it.

**What happened.** While §1–§7 were being written, the candidate landed roughly 3,800 lines
across nine new files, and the deployed commit moved **`f39606a` → `ef62512`**. The new
work is precisely fix #5, plus most of #4:

| New | Lines | What it is |
| --- | --- | --- |
| `src/lib/holds/{model,apply,expiry,store,lithic-events,index}.ts` | 1,596 | The missing holds module. **`store.ts` now contains the writes whose absence was my central finding**: `INSERT INTO hold` (`:191`), `card_authorization` (`:197`), `card_auth_event` (`:283`), `hold_closure` (`:364`). |
| `src/lib/webhooks/consumers/lithic-card.ts` | 211 | The missing card consumer. |
| `src/lib/webhooks/drain.ts` | 137 | The missing drain — calls `consumers.register` (`:85`) and `dispatchUntilIdle` (`:118`). |
| `src/app/api/drain/route.ts` + `crons` in `vercel.json:14` | — | The missing scheduler. The drain is now **also** called inline from the webhook route (`api/webhooks/[provider]/route.ts:12`). |
| `src/test/livefire/attack-0{1..8}-*.test.ts` | 1,483 | A test per published attack, named after it. |
| `src/lib/holds/model.test.ts` | 365 | **42 unit tests, all passing**, folding event sets — exactly the "unwritten test" idea §7.1 asked for. |

**This retires the single largest deduction in §1 and §4**, and it was done in the right
order: the algebra first, then the writer, then the consumer, then the drain, then a test
per attack. Nothing about it looks like scaffolding.

**But it is not green yet.** Measured directly:

- `pnpm test` (no DB): **9 failed / 714 passed / 72 skipped**, all 9 in
  `src/components/account/derive.test.ts` — the account fixtures no longer satisfy their own
  invariants mid-refactor.
- `LIVEFIRE=1 RUN_DB_TESTS=1 pnpm vitest run src/test/livefire/`: **9 failed / 8 passed / 2 skipped**.
  - ✅ Attack 3 (bitemporal correction), Attack 5 (maker-checker), Attack 6 (planted break, 2 of 3).
  - ❌ **Attacks 1, 2 and 4 fail with `Test timed out in 5000ms` — nothing else.** They are
    not wrong; they are starved. `vitest.config.ts` sets **no `testTimeout`**, so the 5s
    default applies, and each of these does several Neon round trips that measure
    300–1,800ms apiece elsewhere in the suite.
  - ❌ Attack 6's third case: `expected [] to have a length of 1` — a real assertion failure.
  - ❌ Attack 7: deep-equal mismatch — a real assertion failure.
  - ❌ Attack 8: `LithicApiError: Rate limit exceeded`, then three cascading
    `no delivery captured`. Partly my fault — see the disclosure below.

**Revised priorities.** §6 items 1, 2 and 3 are unchanged and still rank first; item 5 is
substantially done; item 4 is in progress and currently red. Insert these two at the top:

- **0a. Add `testTimeout: 30_000` to `vitest.config.ts` — one line, ~30 seconds, recovers
  three of the seven graded live-fire attacks.** Attacks 1, 2 and 4 are failing purely on
  the 5s default. This is the highest points-per-minute item in the entire evaluation.
- **0b. Finish the `derive.test.ts` refactor or revert it.** Nine failing tests on the
  default `pnpm test` is the first thing a grader sees, and it is the one command CI runs.
  A half-landed refactor is worse than either end state.

Then: Attack 8 needs a retry/backoff around the Lithic call (the rate limiter at
`src/lib/rails/lithic/ratelimit.ts` exists but this path evidently does not use it), and
Attacks 6.3 and 7 need their assertions debugged — those two are real failures, not
plumbing.

**Disclosure about my own effect on the system.** This matters because §6.3 is about
exactly this hazard, and I walked into it:

- `.env` points `APP_DATABASE_URL` at the **production** Neon database, so every DB test I
  ran wrote permanent, append-only rows into the live demo. Across my runs and the two
  sub-audits, `payment_instruction` went to 109, `payment_instruction_event` to 157 and
  `journal_entry` to 233. Much of the ~50-row `/approvals` queue now visible in production
  is evaluation residue. It cannot be cleaned without `dbreset` because the tables are
  append-only by design — which is correct behaviour and exactly why the tests need their
  own Neon branch.
- Running Attack 8 consumed Lithic sandbox rate-limit budget and probably caused, or
  contributed to, the `Rate limit exceeded` above. Re-run it in isolation before believing
  that failure.

**Method correction.** Subagent review caught a flaw in my own scanning:
`src/lib/webhooks/inbox.ts` contains a **literal NUL byte at line 907** (`` `${p}\x00${e}` ``
written as a raw `0x00` rather than the escape). `file(1)` classifies it as `data` and
plain `grep`/`grep -r` **silently skips it as binary** — so my first secrets, float-money
and `UPDATE`/`DELETE` sweeps never read the largest file in the webhooks module (1,206
lines). I re-scanned it with `grep -a`: **clean on all three** — no credentials, no float
money (the `Number()` calls are attempt counters and timestamps), and its seven `UPDATE`s
all target `webhook_inbox`, the sanctioned column-scoped exception. **The §2 verdicts
stand.** Worth fixing anyway, and worth flagging to the candidate for a reason bigger than
tidiness: any secret scanner, linter or `grep`-based CI check run across this repo silently
skips that file. Replace the raw byte with `\x00` and add a `grep -aI` guard to
`scripts/precommit.sh`.

**Does the score change?** Not as published — §1–§7 are pinned to `f39606a`, which is what
I measured end to end. Provisionally, if the new work goes green (which on current
evidence is a `testTimeout` line plus two assertion fixes away), gauntlet items 2, 3 and 4
move PARTIAL → IMPLEMENTED and live-fire 1, 2, 4 and 7 become defensible, which is worth
roughly **+10 to +12**, i.e. low-to-mid 70s — matching decision 003's own forecast for this
track. That estimate is contingent on a green run I have not yet seen, and I am not
awarding it on the strength of files existing.

**One observation for the debrief, offered as judgment rather than as a score.** The gap
between "the schema is right" and "the schema has a caller" was closed in about ninety
minutes, which is strong evidence the candidate genuinely understands the code rather than
having assembled it. But it also means the freeze will arrive with this work at whatever
state it happens to be in. Landing `testTimeout` and stabilising `derive.test.ts` is worth
more than starting anything else, because **a red default `pnpm test` at freeze would cost
more points than the entire holds module gains.**

---

# ITERATION 1 — 2026-09-10T20:00Z

First pass of the continuous evaluation loop. This section records the delta
since the original scoring run, which was pinned to commit `f39606a`.

## Measured, not assumed

    deployed commit   0cea11d          health status ok
    integrations      4 of 7 live      webhookHealth present, degradedBy []
    routes            / /accounts /approvals /reconciliation /statements  all 200
    tests             939 passed, 93 skipped
    invariants        dbcheck 14 of 14
    docs              README 477 · CUT-LIST 327 · DEMO 422 · AGENT-LIMITS 352 · MCP 847

## What changed since the base score of 62/100

The base score was taken before roughly 3,800 lines landed and explicitly
flagged that the tree was moving underneath it. Since then:

- **The drain exists.** The inbox was half a pipeline: deliveries were verified
  and stored and nothing ever turned one into a journal line. Three triggers
  now, each failing differently.
- **Money moves on the deployed system.** A real $50.00 Lithic authorisation
  moved available by exactly 5,000 and left the ledger untouched, on production.
- **The root page stopped lying.** It said "ledger not yet wired" while the
  ledger held hundreds of entries.
- **`/statements` exists**, which was non-negotiable 5 and gauntlet item 7.
- **Attack 7's two missing halves shipped** — delivery freshness on health, and
  a provider-down banner in the console shell.
- **The secrets automatic-fail is closed.** Two real credentials were committed;
  both rotated or already dead, history rewritten, force-pushed, and the gate
  now scans every tracked file rather than the staged diff.

## The integration count went DOWN, and that is the point

5 live became 4. `card_webhooks` was reporting LIVE off the back of
`LITHIC_WEBHOOK_SECRET` being a non-empty string, because a slot with no probe
inherited the env-derived status — the 011 failure, reintroduced by the
fallback inside the module written to eliminate it. It now reads
`unprobed`, labelled SIMULATED.

One fewer claimed integration is a better score on integration reality, not a
worse one, because the rubric grades honest labelling and the brief calls
presenting a simulated integration as live the fastest way to fail.

## Graph

    231 nodes: 183 done, 2 in flight, 46 todo
    83% complete · 24.1h worker-hours remaining · 16.1h wall clock at 5 agents

## Dispatched this iteration

1. Re-run live fire against the current deploy — attack 7's blockers shipped, so
   it may now pass. Attack 2 is expected to still skip and must NOT be made to
   pass by weakening its assertion (DECISIONS 024).
2. `docs/DEBRIEF.md` — "code you cannot explain line by line" is an automatic
   fail and the debrief is 75 minutes of the panel driving.
3. `docs/VIDEO-SCRIPT.md` and `docs/EVIDENCE-PACK.md` — the last two submission
   artefacts.

## Standing rule for every iteration

Never claim a capability that has not been proven by a real call. A skip is not
a pass. Four probes have already reported LIVE for capabilities that did not
exist, and each was caught only by measuring.

---

# ITERATION 2 — 2026-09-10T18:55Z

## Measured

    health 8beb825 · status degraded · 4/7 live · degradedBy ['lithic']
    all five screens 200 · 939 tests · dbcheck 14/14
    doc audit: no document contradicts the endpoint

**The `degraded` is correct, not a fault.** Lithic last delivered 343 seconds
ago, inside its own 180–900s stale band, because the live-fire run finished and
nobody has swiped a card since. It self-clears to `quiet` in 9.3 minutes.
Verified by reading the thresholds off the endpoint rather than assuming.

## What moved since iteration 1

- **Live fire re-earned: 7 PASS, 0 FAIL, 1 SKIP**, up from 6/0/2. Attack 7
  flipped once delivery freshness and the provider-down banner shipped, and it
  was proven by *inducing* an outage rather than waiting for one.
- **The escalation gate could never fire.** `slots.every(status === 'live')`,
  and Lithic owns two slots of which `card_webhooks` is permanently `unprobed`
  since 026. So the fix that stopped a slot over-claiming liveness silently
  disabled the alarm liveness gates. Changed to `some`. Now verified firing.
- **A submission document presented a simulated integration as live.** The
  checkpoint email said "5 live of 7" and listed `card_webhooks` as LIVE.
  `scripts/audit-claims.mjs` now fails if any tracked Markdown contradicts the
  endpoint, and it has been tested against an injected contradiction.
- **`/statements` landed** with a three-generation reproducibility proof: the
  same content hash before a backdated correction, after it, and across four
  processes and ~200 intervening journal entries.

## The two over-claims still open, and what was dispatched at them

Both were found by workers refusing to reproduce a claim they could not
justify, which is the behaviour worth keeping.

1. **`rail_event_semantics` has 22 rows and zero readers.** The decision log
   calls it the mechanism deciding correction-versus-new-event; the design calls
   it the highest-risk artefact in the system. The behaviour is right because
   the distinction is hard-coded in a consumer. Dispatched: wire it, or
   establish it should not exist. Both outcomes acceptable; the over-claim is
   not.
2. **`src/lib/kyb/` is entirely unwired** — nothing outside it imports it.
   Eight separately-tested routes for forging a `live` evidence label, on a
   path no request reaches. Dispatched: an onboarding screen that runs Stripe
   Identity live, keeps the registry leg simulated and labelled, and finally
   calls `canTransact()` somewhere that matters.

## Standing pattern, now three deep

`v_hold_drift` excludes released holds, so a spurious closure row escapes it.
The secret scanner used plain grep, so a NUL byte hid 1,206 lines silently.
The escalation gate used `every`, so one honest `unprobed` disabled it.

Each was an exclusion shaped exactly like the failure it existed to catch, and
each reported healthy. **A guard must be tested against the thing it guards
against, not merely run.** The doc auditor was the first guard built that way
from the start.

---

# ITERATION 3 — 2026-09-10T19:20Z

## Measured

    health d601e1f · status ok · degradedBy none
    integrations 5 of 7 live
      live       card_issuing card_webhooks director_kyc open_banking ach_rail
      simulated  business_registry stablecoin
    / /accounts /approvals /reconciliation /statements   all 200
    /onboarding                                          404  (uncommitted, agent still writing)
    1054 tests passed, 96 skipped · dbcheck 14 of 14 · doc audit clean

## The slot that was never broken, only unproven

`card_webhooks` moved SIMULATED -> LIVE, and the interesting part is that
nothing about the integration changed. It was `unprobed` because no probe
existed, and 026 had correctly refused to infer liveness from a non-empty
credential. Lithic exposes `GET /v1/event_subscriptions` and, per subscription,
an `/attempts` log.

The attempts log is the only evidence that can settle this slot at all. Every
other probe reaches outward and reads its own answer. The webhook leg runs
INWARD, and nothing on our side can distinguish *Lithic never sent it* from
*Lithic sent it and we answered 500* — our inbox is empty in both cases. Their
log separates them, and it still holds the receipts for the 020 inbox bug: two
FAILED 500s at 16:18 recovering to SUCCESS 202.

So the verdict is end-to-end, not a ping. `/api/webhooks/lithic` verifies the
Standard Webhooks signature before anything else and answers 401 when it
cannot. A SUCCESS attempt carrying our 202 therefore proves Lithic signed with
the secret it holds and this deployment verified with the secret we hold, as
witnessed by a third party.

## Four guards, all blind in the shape of what they guard

This iteration made it four, and the pattern is now the most useful thing in
this document.

| Guard | Exclusion | What it therefore could not see |
|---|---|---|
| `v_hold_drift` | `WHERE NOT is_released` | a wrong closure row — the thing it exists to catch |
| secret scanner | plain `grep` | 1,206 lines after a NUL byte |
| escalation gate | `slots.every(live)` | any outage, once one slot was honestly `unprobed` |
| doc auditor | `"N of 7"` only | `"4/7 live"`, the shorthand its own log is written in |

Every one of them reported healthy. `v_hold_release_drift` and the auditor's
block-dating were both built by first writing the failure and watching the
guard miss it.

## The $60 was real, and my own note had it backwards

`REMAINING.md` recorded three stale holds as "$60 withheld from nothing". The
live database says the opposite: **$60 spendable that is still authorised**.
Three holds carried a closure reading "authorisation fully reversed" whose
authorisation was never reversed — `origin = clearing_first` on all three,
residue of the bug `terminallyClosed` fixed, permanent because `hold_closure`
is append-only. Corrected by a compensating append; the closure rows are still
there and still say what they said. Available fell by exactly 6000 cents.

The direction mattered. Withheld-from-nothing is a customer complaint;
spendable-while-authorised is a loss.

## Two claims retracted by the workers who were told to reproduce them

- **`rail_event_semantics` is now load-bearing** — delete a row and the
  consumer parks rather than guessing. It also disproved the brief it was
  given: there is no correction path for cards at all, and five rows diverge
  from the code today. Pinned by a characterisation test that fails on purpose
  if one is closed silently.
- **`director_kyc`'s evidence string was a hardcoded lie waiting for a key.**
  It printed "(Persona not configured)" on the Stripe success path while the
  Persona branch falls through on a 401 — so a rejected key rendered as an
  absent one, on the endpoint this trial calls authoritative. True only because
  the key is currently blank.

## Ready now, and what each is blocked on

    Z06  KYB wired to a request path          agent writing
    Z07  Base Sepolia gas                     HUMAN — faucet, ~390000000000 wei
    Z08  five-minute video                    HUMAN — largest unstarted item
    Z09  evidence pack screenshots            HUMAN
    Z10  business_registry off simulated      HUMAN — needs Persona or Connect

The critical path is now entirely historical: every node on it has landed. What
remains is not dependency-bound, it is human-bound. Scheduling cannot compress
it and neither can more agents.
