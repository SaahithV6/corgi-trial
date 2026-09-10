"""
Project DAG for the Corgi Track 3 work trial.

This file is the allocator. Every unit of work in the build is a node with an
explicit owner, duration and dependency set. schedule.py reads it and computes
the critical path, the parallel waves, and what is blocking right now.

It is edited at runtime. When an estimate turns out wrong, the estimate changes
here and the schedule is recomputed rather than re-guessed in someone's head.

Fields
------
id      short stable key, referenced by deps
title   what the node actually is
cat     category, used for grouping in reports
dur     estimate in MINUTES, wall clock for one worker
deps    ids that must be DONE before this can start
owner   human | claude | agent
        human  = only Saahith can do it (signups, faucets, recording, sending)
        claude = cross-cutting wiring, judgment, anything spanning files
        agent  = self-contained, safe to hand to a parallel subagent
files   paths/namespaces this node writes. two nodes sharing a file must not
        be scheduled into the same wave. this is the real cost of fan-out.
status  todo | doing | done | cut
risk    None, or a one-line note on what makes this node dangerous
"""

T0 = "2026-09-09 17:13"          # kickoff, America/Los_Angeles
FREEZE_HOURS = 48
HUMAN_SLEEP = [("02:00", "09:00")]   # human-owned nodes cannot run in here

NODES = []

def N(id, title, cat, dur, deps=(), owner="claude", files=(), status="todo", risk=None):
    NODES.append(dict(id=id, title=title, cat=cat, dur=dur, deps=list(deps),
                      owner=owner, files=list(files), status=status, risk=risk))

# ---------------------------------------------------------------------------
# H — human-gated. These block everything downstream and only Saahith can do
# them. They are first in the graph for exactly that reason.
# ---------------------------------------------------------------------------
N("H01", "Lithic sandbox signup, copy API key", "human-gate", 15, [], "human", ["env"],
  risk="entire card track blocks on this. if gated, whole track is at risk")
N("H02", "Persona sandbox signup, create KYB template, copy key", "human-gate", 25, [], "human", ["env"],
  risk="KYB is the one genuinely gate-able slot. fallback is R02's job")
N("H03", "Plaid sandbox signup, copy client_id + secret", "human-gate", 12, [], "human", ["env"])
N("H04", "Increase sandbox signup, copy key", "human-gate", 15, [], "human", ["env"],
  risk="if not self-serve, fall back to A07 simulator and label honestly")
N("H05", "Neon project create, copy DATABASE_URL (pooled + direct)", "human-gate", 10, [], "human", ["env"])
N("H06", "Vercel project create, link repo, set env vars", "human-gate", 15, ["H05"], "human", ["env","vercel"])
N("H07", "GitHub repo private + graders invited", "human-gate", 5, [], "human", ["repo"], "done")
N("H08", "Generate throwaway Base Sepolia wallet, fund ETH from faucet", "human-gate", 15, [], "human", ["env"],
  risk="testnet only. never a key that has touched real funds")
N("H09", "Circle faucet: testnet USDC to that wallet", "human-gate", 10, ["H08"], "human", ["env"])
N("H10", "Send T+2h attack plan email", "human-gate", 10, ["C01"], "human", ["thread"])
N("H11", "Loom/YouTube account ready for the 5-min video", "human-gate", 5, [], "human", ["video"])
N("H12", "Register webhook URLs in all four provider dashboards", "human-gate", 25,
  ["O06","W04","W05","W06","W07"], "human", ["providers"],
  risk="cannot be done until a stable prod URL exists. sequencing trap")
N("H13", "Capture evidence pack: dashboard screenshots + webhook delivery logs", "human-gate", 40,
  ["LF01","LF02","LF03"], "human", ["evidence"])
N("H14", "Record the 5-minute video", "human-gate", 45, ["O10","O07"], "human", ["video"])
N("H15", "Send T+24h money-moves email", "human-gate", 10, ["C02"], "human", ["thread"])
N("H16", "Send freeze submission email", "human-gate", 15, ["C03"], "human", ["thread"])

# ---------------------------------------------------------------------------
# R — research. Six are already in flight; the rest are queued behind nothing.
# ---------------------------------------------------------------------------
N("R01", "Lithic API: simulate auth/clear/void, webhook sig, ASA", "research", 45, [], "agent", ["research/lithic"], "doing")
N("R02", "KYB self-serve reality check + fallback architecture", "research", 45, [], "agent", ["research/kyb"], "doing",
  risk="answer determines whether we have two live slots or one")
N("R03", "Plaid sandbox: link token, sandbox public token, auth, JWT verify", "research", 40, [], "agent", ["research/plaid"], "doing")
N("R04", "ACH rail bake-off: Increase vs Moov vs MT, R01 return recipe", "research", 45, [], "agent", ["research/ach"], "doing")
N("R05", "Base Sepolia USDC: contract, faucets, viem, idempotent send", "research", 40, [], "agent", ["research/usdc"], "doing")
N("R06", "Bitemporal double-entry ledger schema + hold model design", "research", 70, [], "agent", ["research/ledger"], "doing",
  risk="single most important artifact. everything downstream reads it")
N("R07", "MCP TypeScript SDK: server shape, transport, hosting on Vercel", "research", 35, [], "agent", ["research/mcp"])
N("R08", "Next.js App Router raw-body webhooks + Vercel runtime constraints", "research", 30, [], "agent", ["research/platform"],
  risk="raw body for signature verification is a classic App Router footgun")
N("R09", "Turn the 7 published live-fire attacks into concrete test specs", "research", 40, [], "agent", ["research/livefire"])
N("R10", "Auth/session for two demo roles on Vercel, minimal and explainable", "research", 25, [], "agent", ["research/auth"])
N("R11", "Prior art: Increase/Modern Treasury public writing on hold models", "research", 30, [], "agent", ["research/priorart"])
N("R12", "US ACH return codes + timing windows, R01/R02/R03 semantics", "research", 30, [], "agent", ["research/ach"])
N("R13", "Statement reproducibility patterns + content-hash approach", "research", 25, [], "agent", ["research/statements"])

# ---------------------------------------------------------------------------
# S — scaffold. Cheap, and unblocks everyone.
# ---------------------------------------------------------------------------
N("S01", "pnpm init, Next.js App Router, TypeScript strict", "scaffold", 20, [], "claude", ["app/config"])
N("S02", "Tailwind + base layout + design tokens", "scaffold", 25, ["S01"], "agent", ["app/ui-base"])
N("S03", "Drizzle install + config against Neon", "scaffold", 20, ["S01","H05"], "claude", ["db/config"])
N("S04", "zod env schema, fail fast on missing keys", "scaffold", 20, ["S01"], "agent", ["app/env"])
N("S05", ".env.example documenting every key", "scaffold", 15, ["S04"], "agent", ["env-docs"])
N("S06", "Hello-world deploy to Vercel, prove the pipeline", "scaffold", 20, ["S01","H06"], "claude", ["vercel"],
  risk="do this in hour 2, not hour 40. a broken deploy path found late is fatal")
N("S07", "GitHub Actions: typecheck + unit tests on push", "scaffold", 25, ["S01"], "agent", ["ci"])
N("S08", "Vitest setup + test DB strategy", "scaffold", 30, ["S03"], "agent", ["test/config"])
N("S09", "Structured logging + request ids", "scaffold", 25, ["S01"], "agent", ["app/log"])
N("S10", "Error boundary + typed API result helper", "scaffold", 20, ["S01"], "agent", ["app/errors"])

# ---------------------------------------------------------------------------
# L — the ledger. The thing that is graded hardest and cannot be retrofitted.
# ---------------------------------------------------------------------------
N("L01", "Money type: bigint cents, no floats, rounding rule written down", "ledger", 35, ["S01"], "claude", ["lib/money"],
  risk="every downstream number depends on this being right and boring")
N("L02", "accounts table + normal balance side per account type", "ledger", 35, ["S03","R06"], "claude", ["db/schema"],
  risk="customer deposit is OUR liability. getting the sign wrong poisons everything")
N("L03", "journal_entries: value_date and booking_date as separate columns", "ledger", 40, ["L02"], "claude", ["db/schema"],
  risk="bitemporality decided here or never")
N("L04", "journal_lines: entry_id, account_id, direction, amount_cents", "ledger", 30, ["L03"], "claude", ["db/schema"])
N("L05", "Constraint: lines of an entry sum to zero, enforced in DB", "ledger", 35, ["L04"], "claude", ["db/constraints"])
N("L06", "REVOKE UPDATE/DELETE on money tables + RAISE triggers", "ledger", 40, ["L04"], "claude", ["db/constraints"],
  risk="this is the automatic-fail clause. make it structural, not a promise")
N("L07", "Test: attempt UPDATE and DELETE on money rows, assert both fail", "ledger", 30, ["L06","S08"], "agent", ["test/immutability"])
N("L08", "Chart of accounts seed + the reasoning for each account", "ledger", 35, ["L02"], "agent", ["db/seed-coa"])
N("L09", "postEntry(): transactional, balanced, append-only posting API", "ledger", 50, ["L05","L01"], "claude", ["lib/ledger"])
N("L10", "Idempotent posting: (source, source_ref) unique, replay is a no-op", "ledger", 35, ["L09"], "claude", ["lib/ledger"])
N("L11", "Projection: ledger balance as of a value date", "ledger", 40, ["L09"], "claude", ["lib/balances"])
N("L12", "Projection: balance as we BELIEVED it on a booking date", "ledger", 45, ["L11"], "claude", ["lib/balances"],
  risk="the bitemporal proof. they will ask for it live")
N("L13", "reverseAndRebook(): correction as new entries, never an edit", "ledger", 45, ["L09"], "claude", ["lib/ledger"])
N("L14", "Correction scenario test: Tue settlement reversed Thu", "ledger", 40, ["L13","L12"], "agent", ["test/correction"])
N("L15", "Statement generator for a closed day", "ledger", 55, ["L11"], "claude", ["lib/statements"])
N("L16", "Statement content-hash: re-run produces byte-identical output", "ledger", 35, ["L15","R13"], "agent", ["lib/statements"])
N("L17", "Test: closed-day statement reproducible after a later correction", "ledger", 35, ["L16","L13"], "agent", ["test/statements"])
N("L18", "Trial balance check: every account, sums to zero, exposed as a job", "ledger", 30, ["L11"], "agent", ["lib/ledger"])
N("L19", "Rounding residual: deterministic assignment + unit tests", "ledger", 30, ["L01"], "agent", ["lib/money"])
N("L20", "Ledger README: explain every table out loud in the debrief", "ledger", 35, ["L06","L12"], "agent", ["docs/ledger"])

# ---------------------------------------------------------------------------
# D — holds and the authorisation lifecycle. The heart of Track 3.
# ---------------------------------------------------------------------------
N("D01", "holds table + hold state enum", "holds", 35, ["L04","R06"], "claude", ["db/schema"])
N("D02", "card_events append-only table, one row per provider event", "holds", 30, ["D01"], "claude", ["db/schema"])
N("D03", "Auth received -> open hold, available drops, ledger does not", "holds", 45, ["D02","L09"], "claude", ["lib/holds"])
N("D04", "Incremental auth raises an existing hold", "holds", 35, ["D03"], "agent", ["lib/holds"])
N("D05", "Partial capture: post settled amount, reduce hold", "holds", 40, ["D03"], "claude", ["lib/holds"])
N("D06", "Multiple captures against one auth", "holds", 40, ["D05"], "agent", ["lib/holds"])
N("D07", "Over-capture (tip/fuel): settle above auth, hold still releases once", "holds", 40, ["D05"], "claude", ["lib/holds"],
  risk="the published fuel-pump attack. $50 auth, $73.40 clearing")
N("D08", "Auth expiry sweeper: release stale holds, idempotent", "holds", 40, ["D03"], "agent", ["lib/holds"])
N("D09", "Void / auth reversal releases the hold", "holds", 30, ["D03"], "agent", ["lib/holds"])
N("D10", "Force post: unmatched clearing. NO Lithic endpoint exists - see 004", "holds", 45, ["D05"], "claude", ["lib/holds"],
  risk="Lithic has no force-post simulate endpoint. model it in the scheme file + FINANCIAL_AUTHORIZATION")
N("D11", "Out-of-order: settlement lands before its auth. park it.", "holds", 50, ["D10"], "claude", ["lib/holds"],
  risk="published attack. must not crash and must not double-count")
N("D12", "Orphan matcher: reconcile parked settlements when auth arrives", "holds", 45, ["D11"], "claude", ["lib/holds"])
N("D13", "Exactly-once hold release, proven by construction not by luck", "holds", 50, ["D07","D09","D12","D18"], "claude", ["lib/holds"],
  risk="graded hardest. must survive any arrival order")
N("D14", "Available balance projection = ledger - active holds +/- policy", "holds", 45, ["D13","L11"], "claude", ["lib/balances"],
  risk="must be derived. a stored column here is an instant loss")
N("D15", "Uncleared-credit policy: inbound ACH not available until window passes", "holds", 35, ["D14","R12"], "claude", ["lib/balances"])
N("D16", "Property test: random permutations of a lifecycle, invariants hold", "holds", 60, ["D13"], "agent", ["test/holds"],
  risk="this is what makes the live fire boring. worth every minute")
N("D17", "Hold model ASCII state diagram in the docs", "holds", 25, ["D13"], "agent", ["docs/holds"])

N("D18", "SETTLE partial-clearing arithmetic against the live sandbox", "holds", 30, ["A03"], "claude", ["lib/holds"],
  risk="docs contradict themselves. clearing 600 of a 1000 auth: hold 400/PENDING or 0/SETTLED? "
       "the hold model depends on the answer. measure it, do not assume it")
N("D19", "Serial rate limiter: Lithic simulate writes are 1 RPS in sandbox", "holds", 30, ["A03"], "agent", ["lib/rails/lithic"],
  risk="a 50-txn seed takes 100s. biggest operational constraint on the track")

# ---------------------------------------------------------------------------
# W — webhooks. Signature, idempotency, ordering, degradation.
# ---------------------------------------------------------------------------
N("W01", "Raw-body capture in App Router route handlers", "webhooks", 30, ["S01","R08"], "claude", ["app/webhooks"],
  risk="parsing before verifying is the classic bug. verify the raw bytes")
N("W02", "webhook_inbox table, unique (provider, provider_event_id)", "webhooks", 30, ["S03"], "claude", ["db/schema"],
  risk="replay becomes a no-op at the DB, not in application code")
N("W03", "Generic verify -> persist -> enqueue -> 200 fast handler", "webhooks", 45, ["W01","W02"], "claude", ["app/webhooks"])
N("W04", "Lithic signature verification", "webhooks", 35, ["W03","R01","H01"], "agent", ["lib/verify/lithic"])
N("W05", "Persona signature verification", "webhooks", 30, ["W03","R02","H02"], "agent", ["lib/verify/persona"])
N("W06", "Plaid JWT verification incl. body SHA-256 compare", "webhooks", 40, ["W03","R03","H03"], "agent", ["lib/verify/plaid"])
N("W07", "Increase signature verification", "webhooks", 30, ["W03","R04","H04"], "agent", ["lib/verify/increase"])
N("W08", "Dispatcher: route inbox rows to idempotent consumers", "webhooks", 45, ["W03"], "claude", ["lib/dispatch"])
N("W09", "Test: replay the same event twice, assert one effect", "webhooks", 30, ["W08","S08"], "agent", ["test/webhooks"])
N("W10", "Test: deliver events out of order, assert convergence", "webhooks", 40, ["W08","D12"], "agent", ["test/webhooks"])
N("W11", "Dead-letter queue + bounded retry with backoff", "webhooks", 40, ["W08"], "agent", ["lib/dispatch"])
N("W12", "Graceful degradation when a provider is down", "webhooks", 40, ["W11"], "claude", ["lib/dispatch"],
  risk="published attack: they kill provider webhooks for 5 minutes mid-demo")
N("W13", "Webhook delivery log screen, staff-visible", "webhooks", 40, ["W08","S02"], "agent", ["app/ui/webhooks"])
N("W14", "Backfill/poller as an explicit fallback, clearly secondary", "webhooks", 40, ["W12"], "agent", ["lib/dispatch"])

# ---------------------------------------------------------------------------
# A — rail and provider adapters. A rail is an adapter, not a schema.
# ---------------------------------------------------------------------------
N("A01", "Rail interface: initiate -> pending -> settled/returned, normalised", "adapters", 45, ["R04","R05","L09"], "claude", ["lib/rails/iface"],
  risk="ACH, card and USDC must all fit behind this. design it once, properly")
N("A02", "Lithic card adapter: create cardholder, create virtual card", "adapters", 45, ["A01","R01","H01"], "agent", ["lib/rails/lithic"])
N("A03", "Lithic simulate helpers: authorize, clearing, void, return", "adapters", 45, ["A02"], "agent", ["lib/rails/lithic"])
N("A04", "Persona KYB adapter + inquiry lifecycle", "adapters", 50, ["R02","H02"], "agent", ["lib/kyb/persona"])
N("A05", "Plaid adapter: link token, exchange, auth, identity", "adapters", 50, ["R03","H03"], "agent", ["lib/rails/plaid"])
N("A06", "Increase ACH adapter behind the rail interface", "adapters", 55, ["A01","R04","H04"], "agent", ["lib/rails/increase"])
N("A07", "ACH simulator behind the SAME interface, honestly labelled", "adapters", 50, ["A01"], "agent", ["lib/rails/achsim"],
  risk="insurance against H04 being gated. also generates the awkward cases")
N("A08", "USDC Base Sepolia adapter via viem", "adapters", 55, ["A01","R05","H09"], "agent", ["lib/rails/usdc"])
N("A09", "USDC idempotent send: tx hash persisted before broadcast", "adapters", 40, ["A08"], "claude", ["lib/rails/usdc"],
  risk="a retry that double-sends is the worst bug in the build")
N("A10", "USDC confirmation watcher -> ledger event", "adapters", 40, ["A09"], "agent", ["lib/rails/usdc"])
N("A11", "Scheme file simulator: nightly file with awkward cases", "adapters", 50, ["A03"], "agent", ["lib/scheme"])
N("A12", "Provider health tracking + circuit breaker per adapter", "adapters", 40, ["A01","W12"], "agent", ["lib/rails/health"])
N("A13", "Adapter contract tests: every rail satisfies the same suite", "adapters", 45, ["A06","A07","A08"], "agent", ["test/rails"])

# ---------------------------------------------------------------------------
# E — entities and the account lifecycle.
# ---------------------------------------------------------------------------
N("E01", "businesses table + KYB gate states (pending/approved/rejected)", "entities", 40, ["L02","A04"], "claude", ["db/schema"],
  risk="unverified entities can look but not transact. enforce it, do not document it")
N("E02", "users + roles: staff, approver, business admin", "entities", 35, ["S03"], "claude", ["db/schema"])
N("E03", "Session auth for two demo roles", "entities", 45, ["E02","R10"], "claude", ["app/auth"])
N("E04", "Transaction gate: unverified business cannot move money", "entities", 35, ["E01","E03"], "claude", ["lib/policy"])
N("E05", "accounts (customer-facing) mapped onto ledger accounts", "entities", 40, ["E01","L02"], "claude", ["db/schema"])
N("E06", "cards + cardholders, linked to Lithic tokens", "entities", 35, ["E05","A02"], "agent", ["db/schema"])
N("E07", "external_bank_accounts from Plaid items", "entities", 35, ["E05","A05"], "agent", ["db/schema"])
N("E08", "payments table + outbound/inbound state machine", "entities", 50, ["E05","A01"], "claude", ["db/schema"])
N("E09", "ACH return handling: R01/R02 post on the day it happened", "entities", 50, ["E08","R12"], "claude", ["lib/payments"],
  risk="published attack. value date is the original day, booking date is today")
N("E10", "Inbound payment recall handling", "entities", 40, ["E09"], "agent", ["lib/payments"])
N("E11", "Funding flow: Plaid-linked account -> ACH debit -> balance", "entities", 50, ["E07","A06","A07"], "claude", ["lib/payments"])
N("E12", "Beneficiaries / payees with a confirmation step", "entities", 40, ["E08"], "agent", ["db/schema"])
N("E13", "KYB pending and rejected states visible in UI, not just happy path", "entities", 35, ["E01","U02"], "agent", ["app/ui/onboard"])

# ---------------------------------------------------------------------------
# K — maker-checker. Money out above a threshold needs a second human.
# ---------------------------------------------------------------------------
N("K01", "approvals table: request, initiator, approver, decision, timestamps", "approvals", 35, ["E08","E02"], "claude", ["db/schema"])
N("K02", "Threshold policy, configurable, written down", "approvals", 25, ["K01"], "agent", ["lib/policy"])
N("K03", "DB-level constraint: initiator_id <> approver_id", "approvals", 30, ["K01"], "claude", ["db/constraints"],
  risk="enforce in the database. an application-layer check is a promise, not a control")
N("K04", "Agent-initiated writes land in the same queue as humans", "approvals", 35, ["K03","M05"], "claude", ["lib/policy"])
N("K05", "Approvals queue screen with approve/reject", "approvals", 50, ["K03","S02","E03"], "agent", ["app/ui/approvals"])
N("K06", "Test: initiator tries to approve own payment, assert refusal", "approvals", 25, ["K03","S08"], "agent", ["test/approvals"])
N("K07", "Full audit trail on every approval decision", "approvals", 30, ["K01"], "agent", ["lib/audit"])

# ---------------------------------------------------------------------------
# N — reconciliation. A feature, not a chore.
# ---------------------------------------------------------------------------
N("N01", "recon_runs + recon_breaks tables", "recon", 35, ["S03"], "claude", ["db/schema"])
N("N02", "Scheme file ingest + parse, tolerant of malformed rows", "recon", 45, ["N01","A11"], "agent", ["lib/recon"])
N("N03", "Diff engine: in-file-not-ledger, in-ledger-not-file, amount mismatch", "recon", 55, ["N02","L11"], "claude", ["lib/recon"],
  risk="they will plant a break and watch. all three categories must work")
N("N04", "Break aging + severity", "recon", 30, ["N03"], "agent", ["lib/recon"])
N("N05", "Breaks screen with aging, filters, drill-through to the entry", "recon", 55, ["N04","S02"], "agent", ["app/ui/breaks"])
N("N06", "Test: plant each of the three break types, assert each surfaces", "recon", 40, ["N03","S08"], "agent", ["test/recon"])
N("N07", "Nightly recon job + manual re-run button", "recon", 35, ["N03"], "agent", ["lib/recon"])
N("N08", "Recon run history, immutable", "recon", 30, ["N01"], "agent", ["lib/recon"])

# ---------------------------------------------------------------------------
# M — the agent surface. Three read tools, one write tool, into the queue.
# ---------------------------------------------------------------------------
N("M01", "MCP server scaffold, hosted from the deployed app", "mcp", 50, ["R07","S01"], "claude", ["mcp/server"])
N("M02", "MCP auth + scoping to a single business", "mcp", 40, ["M01","E03"], "claude", ["mcp/server"])
N("M03", "read tool: get_balance (ledger + available, with as-of)", "mcp", 30, ["M02","D14"], "agent", ["mcp/tools"])
N("M04", "read tool: list_transactions with filters", "mcp", 30, ["M02","L11"], "agent", ["mcp/tools"])
N("M05", "read tool: list_recon_breaks", "mcp", 30, ["M02","N03"], "agent", ["mcp/tools"])
N("M06", "write tool: initiate_payment -> approval queue, never executes", "mcp", 45, ["M02","K01"], "claude", ["mcp/tools"],
  risk="the whole point. an agent can propose, never dispose")
N("M07", "Written list: operations never handed to an autonomous agent, and why", "mcp", 35, ["M06"], "agent", ["docs/agent-limits"])
N("M08", "MCP demo transcript captured for the debrief", "mcp", 25, ["M06","M03"], "agent", ["docs/mcp-demo"])
N("M09", "Rate limiting + audit log on every MCP call", "mcp", 35, ["M02","K07"], "agent", ["mcp/server"])

# ---------------------------------------------------------------------------
# U — screens. Three that matter must show default, loading, empty, error and
# one edge state. That is a rubric line, so it is a node, not a hope.
# ---------------------------------------------------------------------------
N("U01", "App shell: nav, role switcher, business context", "ui", 45, ["S02","E03"], "claude", ["app/ui/shell"])
N("U02", "Onboarding screen: KYB submit + pending/rejected states", "ui", 55, ["U01","A04"], "agent", ["app/ui/onboard"])
N("U03", "Account screen: ledger vs available balance, side by side", "ui", 55, ["U01","D14"], "claude", ["app/ui/account"],
  risk="showing both numbers and explaining the gap IS the domain command demo")
N("U04", "Transactions screen: postings, holds, pending vs settled", "ui", 60, ["U03","D13"], "agent", ["app/ui/txns"])
N("U05", "Card screen: issue card, view, simulate auth/clearing controls", "ui", 55, ["U01","A03"], "agent", ["app/ui/cards"])
N("U06", "Payments screen: initiate outbound, pick rail (ACH or USDC)", "ui", 55, ["U01","E08"], "agent", ["app/ui/payments"])
N("U07", "Statement screen with as-of date picker (both time axes)", "ui", 55, ["U01","L15","L12"], "claude", ["app/ui/statement"],
  risk="the bitemporal demo surface. must make two time axes legible to a human")
N("U08", "Funding screen: Plaid Link + deposit", "ui", 45, ["U01","A05"], "agent", ["app/ui/funding"])
N("U09", "Five states on the three key screens: default/loading/empty/error/edge", "ui", 60, ["U03","U04","K05"], "agent", ["app/ui/states"])
N("U10", "Responsive pass, no horizontal scroll", "ui", 35, ["U09"], "agent", ["app/ui/states"])
N("U11", "Money formatting component: cents in, never a float displayed", "ui", 25, ["S02","L01"], "agent", ["app/ui/money"])
N("U12", "Integration status banner: live vs simulated, visible in-product", "ui", 35, ["U01","A12"], "agent", ["app/ui/shell"],
  risk="honest labelling in the product, not only the README. unasked-for")
N("U13", "Provider-down state visible to the customer, not a spinner forever", "ui", 40, ["U12","W12"], "agent", ["app/ui/shell"])

# ---------------------------------------------------------------------------
# LF — live-fire rehearsal. Every published attack, automated, before they run
# it on us. This is the 15-point bucket and the only one we can practise.
# ---------------------------------------------------------------------------
N("LF01", "Attack: $50 fuel-pump auth. available drops, ledger does not", "livefire", 35, ["D03","D14","R09"], "agent", ["test/livefire"])
N("LF02", "Attack: clear $73.40 two days later. hold releases exactly once", "livefire", 40, ["D07","D13"], "agent", ["test/livefire"])
N("LF03", "Attack: reverse that settlement, pull the statement for settle day", "livefire", 45, ["L13","L15","LF02"], "agent", ["test/livefire"])
N("LF04", "Attack: settlement delivered before its auth", "livefire", 40, ["D11","D12"], "agent", ["test/livefire"])
N("LF05", "Attack: initiator approves own above-threshold payment", "livefire", 25, ["K06"], "agent", ["test/livefire"])
N("LF06", "Attack: delete a row from the scheme file, breaks screen finds it", "livefire", 40, ["N06","N05"], "agent", ["test/livefire"])
N("LF07", "Attack: provider webhooks off for 5 minutes mid-demo", "livefire", 45, ["W12","U13"], "agent", ["test/livefire"])
N("LF08", "Attack: replay every webhook type twice, assert no double-count", "livefire", 35, ["W09"], "agent", ["test/livefire"])
N("LF09", "Attack: backdated correction, prove what we believed on Wednesday", "livefire", 45, ["L12","L14"], "agent", ["test/livefire"])
N("LF10", "Rehearsal run: execute all attacks against PROD, record results", "livefire", 60,
  ["LF01","LF02","LF03","LF04","LF05","LF06","LF07","LF08","LF09","O06"], "claude", ["test/livefire"],
  risk="against prod, not local. localhost-green and prod-red is the nightmare")
N("LF11", "Fix whatever the rehearsal breaks", "livefire", 90, ["LF10"], "claude", ["*"],
  risk="deliberate slack. if nothing breaks, this converts into stretch work")

# ---------------------------------------------------------------------------
# T — correctness tests beyond the attack list.
# ---------------------------------------------------------------------------
N("T01", "Unit: money arithmetic, rounding, residual penny", "tests", 30, ["L19","S08"], "agent", ["test/money"])
N("T02", "Unit: every entry balances, invariant fuzzed", "tests", 30, ["L05","S08"], "agent", ["test/ledger"])
N("T03", "Integration: full happy path, fund -> card -> auth -> clear", "tests", 55, ["E11","D07"], "claude", ["test/e2e"])
N("T04", "Integration: outbound payment with approval, settle, then return", "tests", 50, ["E09","K05"], "agent", ["test/e2e"])
N("T05", "Bitemporal invariant: as-of queries never change for a past pair", "tests", 40, ["L12"], "agent", ["test/ledger"])
N("T06", "Seed determinism: seed twice, identical ledger hash", "tests", 30, ["O01"], "agent", ["test/seed"])
N("T07", "No-float audit: grep the codebase for float money paths", "tests", 25, ["L01"], "agent", ["test/audit"])
N("T08", "Smoke suite runnable against prod in under 2 minutes", "tests", 40, ["T03"], "claude", ["test/smoke"])

# ---------------------------------------------------------------------------
# O — ops, deployment, and the submission artifacts.
# ---------------------------------------------------------------------------
N("O01", "Seed script: believable demo data from zero", "ops", 60, ["L08","E11","E06","D19"], "claude", ["scripts/seed"],
  risk="explicitly on the submission list. not optional")
N("O02", ".env.example complete and accurate, every key documented", "ops", 25, ["S05","A08","A06"], "agent", ["env-docs"])
N("O03", "README: integration honesty table finalised, live vs simulated", "ops", 40, ["A06","A07","A08","A04"], "claude", ["docs/readme"],
  risk="presenting simulated as live is an automatic fail. this node is a gate")
N("O04", "Cut list: what we did not build and what week two looks like", "ops", 35, [], "claude", ["docs/cutlist"])
N("O05", "Secret scan: assert no keys anywhere in git history", "ops", 25, ["S07"], "agent", ["ci"],
  risk="automatic fail. verify, do not assume")
N("O06", "Production deploy with all env vars set", "ops", 40, ["S06","U03","D14"], "claude", ["vercel"])
N("O07", "Prod smoke test green", "ops", 30, ["O06","T08"], "claude", ["test/smoke"])
N("O08", "Two demo role logins created and verified on prod", "ops", 30, ["O07","E03"], "claude", ["ops/demo"])
N("O09", "Architecture diagram: money path end to end", "ops", 45, ["A01","L09"], "agent", ["docs/arch"])
N("O10", "Video script: the money path in five minutes", "ops", 40, ["O07","U03","U07"], "claude", ["video"])
N("O11", "Debrief prep: be able to explain every line we will be pointed at", "ops", 90, ["L20","D17","O03"], "claude", ["docs/debrief"],
  risk="'code you cannot explain line by line' is an automatic fail")
N("O12", "Decision log maintenance", "ops", 60, [], "claude", ["DECISIONS.md"])
N("O13", "Stretch: card controls enforced in the real-time auth webhook", "ops", 90, ["A03","LF11"], "agent", ["lib/rails/lithic"])
N("O14", "Stretch: sub-accounts as pure ledger moves", "ops", 60, ["L09","LF11"], "agent", ["lib/ledger"])

# ---------------------------------------------------------------------------
# C — the three checkpoint gates. Hard deadlines, not tasks.
# ---------------------------------------------------------------------------
N("C01", "GATE T+2h: attack plan drafted", "gate", 5, [], "claude", ["thread"], "done")
N("C02", "GATE T+24h: money moves on a live rail from the deployed URL", "gate", 20,
  ["O06","A02","A03","D03","D14"], "claude", ["thread"],
  risk="the single most-read checkpoint. plan backwards from it")
N("C03", "GATE T+48h: submission package complete", "gate", 30,
  ["O03","O04","O08","H13","H14","O11","O12"], "claude", ["thread"])

# ---------------------------------------------------------------------------
# DELEGATION POLICY
#
# The first schedule run said something uncomfortable: claude holds 47.0 h of
# serial work against a 48 h budget, while six parallel agents finish their
# 66.8 h in about 11. Adding agents past two changed the makespan by zero.
# The bottleneck was never agent count. It was me.
#
# So the question is not "how many agents" but "what must NOT be delegated".
#
# The binding constraint is the automatic fail: "code you cannot explain line
# by line when we point at it." Note who that binds — Saahith, in the debrief.
# It does not say he must have typed it. It says he must own it. Drafting can
# move; understanding cannot. So delegated work comes back through review, and
# review is roughly a quarter the cost of writing.
#
# KEEP (not delegated, regardless of cost): anything where a wrong design
# choice propagates into every downstream node and cannot be cheaply undone —
# the ledger core, the hold state machine, available balance, bitemporality,
# the rail interface, and every node carrying a risk flag.
#
# DELEGATE: schema mechanics, adapters against a documented API, screens,
# tests, docs. Bounded, checkable, and wrong answers are local.
REVIEW_FRACTION = 0.25

DELEGATE = [
    "S01","S03",              # scaffolding, no judgment
    "L04","L15",              # line table + statement generator, shapes fixed by L03/L11
    "D01","D02",              # tables whose semantics D03/D13 already pin down
    "E02","E05","E08","E12",  # entity tables
    "N01","W02",              # recon + inbox tables
    "U01","U07",              # shell and statement screen
    "K01","M01",              # approvals table, MCP scaffold
    "E03","E11","O09",        # session auth, funding flow, arch diagram
]

def apply_delegation():
    """Move drafting to agents, add the review cost back onto claude.

    Called by schedule.py. Kept as a function rather than baked in so the
    policy can be turned off and the counterfactual re-measured."""
    idx = {n["id"]: n for n in NODES}
    added = []
    for i in DELEGATE:
        n = idx.get(i)
        if not n or n["owner"] != "claude":
            continue
        n["owner"] = "agent"
        rid = i + "rv"
        added.append(dict(id=rid, title=f"Review + own: {n['title'][:48]}",
                          cat="review", dur=max(10, int(n["dur"] * REVIEW_FRACTION)),
                          deps=[i], owner="claude", files=list(n["files"]),
                          status="todo", risk=None))
    # rewire: anything that depended on the drafted node now waits for the review
    for n in NODES:
        n["deps"] = [d + "rv" if d in DELEGATE and n["id"] != d + "rv" else d
                     for d in n["deps"]]
    NODES.extend(added)
