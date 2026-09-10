# What is left

Written Thu 11:26 PDT · **T+18.2h of 48** · freeze Fri 17:13 PDT (29.8h)
T+24h checkpoint email due **Thu 17:13 PDT — 5.8h**

---

## 0. Are we ready for the T+24h email?

**Yes, with one mechanical step before sending.**

The brief asks for: *"A deployed URL where money already moves end to end
through at least one live sandbox rail, however ugly."* That is true and
provable. It also says a miss is recoverable with an honest paragraph but
**silence is not** — so the email goes either way, at the time, not late.

| Requirement | State |
|---|---|
| Deployed URL, openable, no login wall | ✅ https://corgi-trial-psi.vercel.app |
| Money moves end to end on it | ✅ real Lithic auth → webhook → verified → drained → journal line |
| Through at least one **live** sandbox rail | ✅ Lithic card issuing, probed `GET /v1/cards -> 200` |
| Draft written | ✅ `thread/T+24h_money_moves.md`, 243 lines |
| Honest labelling matches `/api/health` | ✅ table reproduced from the endpoint |

### The one step: re-read the counts before sending

The draft quotes live figures and they move every time a webhook lands. As of
writing it says 53 / 467 / 84; the database says **55 / 673 / 85**. The jump is
the live-fire suite posting real money while it re-runs.

```bash
cd ~/Documents/corgi-trial && set -a; . ./.env; set +a
curl -s https://corgi-trial-psi.vercel.app/api/health | python3 -m json.tool | head -40
node -e "…"   # or just read the numbers off the landing page
```

Then update the four figures in the draft and send. **Do not round the live-fire
number up** — it is stated as PASS/FAIL/SKIP with "a skip is not a pass" ahead
of both explanations, and that honesty is worth more than the extra point.

---

## 1. Must be done before freeze

Ordered by what costs the most if skipped.

### 1.1 The submission package itself
The brief lists exactly what goes in the email at freeze. Missing any of it is
a scored failure regardless of the code.

- [ ] **Five-minute video.** Script being written (`docs/VIDEO-SCRIPT.md`).
      Needs recording — that is a human task and it is the single largest
      unstarted item.
- [ ] **Evidence pack.** Checklist being written (`docs/EVIDENCE-PACK.md`).
      Screenshots of the Lithic and Increase delivery logs are the ones that
      matter; the rest has in-repo equivalents.
- [ ] **Demo credentials for two roles** in the email body. `docs/DEMO.md`
      documents the switcher; the email needs the literal instructions.
- [x] Deployed URL · [x] repo with graders invited · [x] decision log ·
      [x] seed script · [x] `.env.example` · [x] cut list

### 1.2 Re-run live fire against the final commit
Re-run and re-earned: **7 PASS, 0 FAIL, 1 SKIP**. Attack 7 flipped once
delivery freshness and the provider-down banner shipped. It must be re-earned
once more against whatever finally ships, because the number rots.

### 1.3 Debrief preparation
"Code you cannot explain line by line when we point at it" is an **automatic
fail**, and the debrief is 75 minutes of the panel driving. `docs/DEBRIEF.md`
is being written: the five ideas to know cold, a guided tour of every module
with the one decision a reviewer would question, the hostile questions with
answers, and the honest framing of every weakness.

### 1.4 Decide on the three stale memo holds
Currently documented and deliberately unrepaired. **$60.00 is withheld from
nothing**, and `v_hold_drift` cannot see it because that view is
`WHERE NOT is_released AND memo <> target` — a spurious closure row sits
outside the check by construction.

Either repair them with a reversal (append-only, at their original value dates)
or leave them and say so in the debrief. Leaving them is defensible; the
invariant's blind spot is the part that must be volunteered either way.

---

## 2. Known gaps, deliberately open

Each of these is a decision, not an oversight. They are in `docs/CUT-LIST.md`
with reasoning; this is the short form.

| Gap | Why it is open | Week-two fix |
|---|---|---|
| Attack 2: no `hold_closure` row on over-capture | `model.ts` and `DESIGN §8.3` disagree; `v_hold_drift` holds the model and the SQL view equal *by invariant*, so changing one alone turns a prose mismatch into a live drift alarm | change both together in one migration, with the drift view proving they still agree |
| `business_registry` simulated | every KYB provider the brief lists is gated behind sales or business verification — measured, not assumed | none available without a real company |
| `stablecoin` simulated | wallet holds 20 USDC and **zero gas**; it can read the chain and cannot send | one faucet visit: `alchemy.com/faucets/base-sepolia` → `0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918` |
| Drain cron is daily | Vercel Hobby caps crons at daily; the `after()` nudge covers latency and the row stays `pending` until a consumer succeeds | one line of `vercel.json` and a paid plan |
| 11 parked webhook events | cards were never registered and the system **refused to guess whose money to move** | `registerCard()` wakes them; this is requirement 4 working, not a backlog |
| `/api/health` 500s with no `APP_DATABASE_URL` | the env import throws before the route's own try/catch | only reachable on a completely unconfigured deployment |
| No `Payments` screen | outbound payments work through the approvals queue and the MCP write tool; a dedicated screen was cut at T+2h | build it |

---

## 3. If there is time left

Ordered by points per hour against the rubric, not by how fun they are.

1. **The USDC payout that actually confirms.** The brief says it plainly: *"A
   stablecoin payout that actually confirms on a testnet is worth far more than
   a slide about one."* Everything is built — adapter, idempotent send with the
   hash known before broadcast, ledger posting. It needs gas. **This is the
   highest-value hour available** and it is blocked on a faucet, not on code.
2. **Close attack 2 properly** — both the model and the SQL view in one
   migration, with `v_hold_drift` proving they still agree.
3. **Fix the `v_hold_drift` blind spot.** An invariant blind in exactly the
   shape of the bug it should catch is worse than no invariant, because it
   reports clean.
4. **A second product line sharing the schema.** The Track 1 stretch ladder
   names this and it applies here: proving the ledger is not a one-rail wonder.

---

## 4. Scope creep worth trying, once the above is done

These are not on the brief. The brief says the floor is the brief and *"we are
deliberately not telling you what impresses us."* Ordered by what would actually
surprise a panel that has built this platform.

### 4.1 Time-travel the whole console
A single `?asOf=<date>&asKnownAt=<timestamp>` in the URL that re-renders every
screen at that point on **both** axes. The bitemporal model already supports it
— `balanceAsBelieved` exists and is tested. Making the entire console navigable
through time turns the strongest idea in the build from a thing you explain
into a thing you *drag a slider on*. Highest surprise per hour of anything here.

### 4.2 An adversarial ledger fuzzer
Generate random valid event sequences — auths, incremental auths, partial and
multiple captures, over-captures, reversals, expiries, in every arrival order —
and assert the five invariants after each. The hold model is already a pure
function of a set, so this is cheap to write and it is the natural way to prove
"no arrival order is a special case" rather than assert it. It would also have
caught the clearing-first closure bug before a human did.

### 4.3 The reconciliation break that explains itself
When a break is caused by a correction group, the screen already knows the
original, the reversal and the rebook. Render it as a small timeline with the
two time axes side by side. A breaks screen that says *"this is real, and here
is why, and here is who fixed it"* is a different product from one that lists
mismatches.

### 4.4 Chaos mode
A control that kills a provider's webhooks, delays settlements, duplicates
deliveries and reorders them — then a dashboard showing the ledger surviving
it. The simulator can already do all four; this is a UI over it. It turns the
live-fire section from *them* attacking *us* into us handing them the weapon.

### 4.5 Let the agent surface explain itself
`docs/AGENT-LIMITS.md` lists operations never handed to an autonomous agent.
Make the MCP server expose that list as a tool, so an agent asking "what can I
do here" is told what it is refused **and why**. Small, and it makes a written
policy executable.

### 4.6 A statement a human accountant would accept
Statements exist and reproduce byte-identically. Rendering one as a PDF
generated from data — never hand-typed, per the brief's document rule — with
the as-published and as-corrected figures both shown, is the kind of artefact
that survives being forwarded to someone who was not at the demo.

### 4.7 Interchange and the actual unit economics
The chart of accounts already has an interchange income account and nothing
posts to it. Booking interchange on settlement, with a rate card, would make
the ledger tell a *business* story rather than only a correctness one — which
is the thing Corgi is actually building.

---

## 5. Standing rules that must not slip

- **Never claim a capability that has not been proven by a real call.** Four
  probes have reported LIVE for things that did not exist; each was caught only
  by measuring. A skip is not a pass.
- **`/api/health` is authoritative.** If any document disagrees with it, the
  document is wrong.
- **Nothing that another worker owns gets committed until they are done.** This
  has bitten three times and each time it turned CI red.
- **The gate is chained with `&&`, never `;` and never through a pipe.** Both
  have silently let a red gate through.
