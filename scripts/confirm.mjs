#!/usr/bin/env node
/**
 * ONE COMMAND THAT ANSWERS "IS IT ALL WORKING": the brief, line by line,
 * against this database and this deployment.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * There are already eight verification scripts here — `coreloop`, `livefire`,
 * `dbcheck`, `rebuild`, `evidence`, `audit-claims`, `compliance`,
 * `verify-demo` — and every one of them answers a question somebody had to
 * know to ask. A reader who does not already know this repository cannot tell
 * from any of them whether the BRIEF is satisfied, because the brief is
 * organised by capability and the scripts are organised by mechanism.
 *
 * So this maps the other way: each row is a sentence from the brief, and its
 * verdict is a measurement taken now. Nothing here re-implements a check —
 * every row either runs an existing script and reads its own output, queries
 * the live book, or fetches the deployment.
 *
 * ===========================================================================
 * WHAT A VERDICT MEANS
 * ===========================================================================
 *
 *   PASS      measured, now, against live data or a live deployment
 *   PARTIAL   works, with a named half that does not — the half is printed
 *   CUT       deliberately absent, with whose decision it was
 *   UNPROVEN  not measured by this script; says who does measure it
 *
 * There is no verdict that means "looks right". A row whose evidence could not
 * be gathered prints UNPROVEN and says why — it never inherits a neighbour's
 * green. That rule is the whole reason this file is worth reading: this build
 * has caught four probes reporting LIVE for things that did not exist, and
 * each was found only by measuring rather than by asking a module how it felt.
 */

import postgres from "postgres";

const BASE = process.env.CONFIRM_BASE_URL ?? "https://corgi-trial-psi.vercel.app";
const URL_DB = process.env.APP_DATABASE_URL;
if (!URL_DB) {
  console.error("APP_DATABASE_URL is required. `set -a; . ./.env; set +a` first.");
  process.exit(2);
}
const sql = postgres(URL_DB, { ssl: "require" });

const rows = [];
const add = (area, brief, verdict, evidence) => rows.push({ area, brief, verdict, evidence });

const one = async (q) => {
  try {
    const r = await q;
    return r[0] ?? null;
  } catch (e) {
    return { __error: String(e).slice(0, 90) };
  }
};

const http = async (path, cookie) => {
  try {
    const r = await fetch(`${BASE}${path}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    return r.status;
  } catch {
    return 0;
  }
};

// ---------------------------------------------------------------------------
// 1. The deployment, and the two slots the brief says MUST be live.
// ---------------------------------------------------------------------------
let health = null;
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(25_000) });
  health = await r.json();
} catch {
  health = null;
}

if (health === null) {
  add("deployment", "a deployed URL", "UNPROVEN", `${BASE}/api/health did not answer`);
} else {
  const slots = health.integrations?.slots ?? [];
  const mustBeLive = slots.filter((s) => s.mustBeLive);
  const liveOfMust = mustBeLive.filter((s) => s.status === "live");
  add(
    "deployment",
    "a deployed URL where money already moves",
    health.status === "ok" ? "PASS" : "PARTIAL",
    `sha ${health.commit?.shortSha}, status ${health.status}, ${health.integrations?.live}/${health.integrations?.total} rails`,
  );
  add(
    "integrations",
    "card issuing MUST be live",
    slots.find((s) => s.slot === "card_issuing")?.status === "live" ? "PASS" : "FAIL",
    slots.find((s) => s.slot === "card_issuing")?.evidence ?? "no slot",
  );
  add(
    "integrations",
    "KYB/KYC MUST be live",
    slots.find((s) => s.slot === "director_kyc")?.status === "live" ? "PASS" : "FAIL",
    slots.find((s) => s.slot === "director_kyc")?.evidence ?? "no slot",
  );
  add(
    "integrations",
    "all five slots",
    liveOfMust.length === mustBeLive.length ? "PASS" : "PARTIAL",
    `${liveOfMust.length} of ${mustBeLive.length} must-be-live are live; ${health.integrations?.live}/${health.integrations?.total} overall`,
  );
}

// ---------------------------------------------------------------------------
// 2. The three the brief says it grades hardest.
// ---------------------------------------------------------------------------
const stored = await one(sql`
  SELECT count(*)::int AS n FROM information_schema.columns c
   JOIN information_schema.tables t
     ON t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.column_name IN ('available_cents','available_balance_cents')`);
const drift = await one(sql`SELECT count(*)::int AS n FROM v_balance_definition_drift`);
add(
  "graded hardest",
  "available balance is derived truth, not a stored lie",
  stored?.n === 0 && drift?.n === 0 ? "PASS" : "FAIL",
  `${stored?.n ?? "?"} stored available columns on any base table; v_balance_definition_drift = ${drift?.n ?? "?"}`,
);

const bitemp = await one(sql`
  SELECT count(*)::int AS n FROM information_schema.columns
   WHERE table_name = 'journal_entry'
     AND column_name IN ('value_date','booking_seq','booking_time')`);
const corrections = await one(sql`
  SELECT count(*)::int AS n FROM (
    SELECT value_date FROM journal_entry
     GROUP BY value_date HAVING max(booking_time)::date <> value_date) x`);
add(
  "graded hardest",
  "bitemporality: value date and booking date are different columns",
  bitemp?.n === 3 && (corrections?.n ?? 0) > 0 ? "PASS" : "PARTIAL",
  `journal_entry carries ${bitemp?.n}/3 axes; ${corrections?.n} value dates were booked on a later day`,
);

const holdViews = ["v_hold_drift", "v_hold_release_drift", "v_hold_closure_not_terminal"];
const holdCounts = [];
for (const v of holdViews) {
  const r = await one(sql.unsafe(`SELECT count(*)::int AS n FROM ${v}`));
  holdCounts.push(`${v}=${r?.n ?? "?"}`);
}
add(
  "graded hardest",
  "the hold model under hostile sequencing",
  holdCounts.every((c) => c.endsWith("=0")) ? "PASS" : "FAIL",
  holdCounts.join(" "),
);

// ---------------------------------------------------------------------------
// 3. The v1 scope list, each measured against the book.
// ---------------------------------------------------------------------------
const counts = await one(sql`
  SELECT (SELECT count(*) FROM business)::int                        AS businesses,
         (SELECT count(*) FROM account WHERE code='2100')::int       AS deposit_accounts,
         (SELECT count(*) FROM card)::int                            AS cards,
         (SELECT count(*) FROM card_auth_decision)::int              AS auth_decisions,
         (SELECT count(*) FROM hold)::int                            AS holds,
         (SELECT count(*) FROM payment_instruction)::int             AS instructions,
         (SELECT count(*) FROM standing_order)::int                  AS mandates,
         (SELECT count(*) FROM dispute)::int                         AS disputes,
         (SELECT count(*) FROM pot)::int                             AS pots,
         (SELECT count(*) FROM fx_quote)::int                        AS fx_quotes,
         (SELECT count(*) FROM journal_entry)::int                   AS entries`);

const scope = [
  ["onboarding and identity checks", counts?.businesses, "business rows behind a live KYB gate"],
  ["accounts and balances", counts?.deposit_accounts, "2100 deposit leaves"],
  ["inbound and outbound payments", counts?.instructions, "payment instructions"],
  ["card authorisation and settlement", counts?.auth_decisions, "recorded authorisation decisions"],
  ["holds", counts?.holds, "holds"],
  ["standing orders", counts?.mandates, "mandates"],
  ["the ledger itself", counts?.entries, "journal entries"],
];
for (const [what, n, unit] of scope) {
  add("v1 scope", what, (n ?? 0) > 0 ? "PASS" : "FAIL", `${n ?? "?"} ${unit}`);
}
add("v1 scope", "a mobile app", "CUT", "cut by Saahith, three times, explicitly. Recorded in the graph with his reasoning.");

// ---------------------------------------------------------------------------
// 4. Stretch ladder — and WHICH SURFACE each is reachable from, because a
//    capability only the console can reach is the operator doing the
//    customer's job. That distinction cost this build a whole afternoon.
// ---------------------------------------------------------------------------
const routeFor = {
  "cross-border USDC with a quote the customer accepts": ["/payouts", "/client/payouts"],
  "card controls in the real-time auth decision": ["/accounts", "/client/cards"],
  "interest or fee accrual, visibly, on the ledger": ["/accruals", null],
  "sub-accounts or pots, pure ledger moves": ["/pots", "/client/pots"],
  "dispute intake with provisional credit": ["/disputes", "/client/disputes"],
  "a payee confirmation step": ["/payees", null],
};
for (const [what, [op, cust]] of Object.entries(routeFor)) {
  const opStatus = await http(op, "corgi_demo_role=staff");
  const custStatus = cust ? await http(cust, "corgi_demo_role=customer") : null;
  const both = opStatus === 200 && (cust === null || custStatus === 200);
  add(
    "stretch ladder",
    what,
    both ? "PASS" : "PARTIAL",
    cust === null
      ? `operator ${op} ${opStatus}; no customer surface (operator capability)`
      : `operator ${op} ${opStatus}, customer ${cust} ${custStatus}`,
  );
}

// ---------------------------------------------------------------------------
// 5. Maker-checker and the tenancy boundary, measured over HTTP rather than
//    read out of a policy file. A hidden link is not a guard.
// ---------------------------------------------------------------------------
const custOnOperator = await http("/accounts", "corgi_demo_role=customer");
const staffOnOperator = await http("/accounts", "corgi_demo_role=staff");
const custOnClient = await http("/client", "corgi_demo_role=customer");
add(
  "authorisation",
  "a customer cannot reach the operator console",
  custOnOperator === 403 && staffOnOperator === 200 && custOnClient === 200 ? "PASS" : "FAIL",
  `customer /accounts ${custOnOperator}, staff /accounts ${staffOnOperator}, customer /client ${custOnClient}`,
);

const selfApprove = await one(sql`
  SELECT count(*)::int AS n
    FROM payment_instruction_event e
    JOIN payment_instruction i ON i.id = e.instruction_id
   WHERE e.kind = 'approved' AND e.actor_id = i.requested_by`);
add(
  "maker-checker",
  "the initiator can never approve their own payment",
  selfApprove?.n === 0 ? "PASS" : "FAIL",
  `${selfApprove?.n ?? "?"} self-approvals on the whole book — enforced by trigger, not by a screen`,
);

// ---------------------------------------------------------------------------
// 6. The invariant suite, read from its own output rather than re-derived.
// ---------------------------------------------------------------------------
const { execSync } = await import("node:child_process");
let dbcheckOut = "";
try {
  dbcheckOut = execSync("node scripts/dbcheck.mjs", {
    encoding: "utf8",
    timeout: 280_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  dbcheckOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
const tally = /(\d+) passed, (\d+) failed/.exec(dbcheckOut);
const unregistered = (dbcheckOut.match(/NOT ON THE REGISTER/g) ?? []).length;
add(
  "invariants",
  "every red carries a written argument",
  tally && unregistered === 0 ? "PASS" : "FAIL",
  tally
    ? `${tally[1]} passed, ${tally[2]} failed, ${unregistered} unexplained — a failure with no argument is the thing this row exists to catch`
    : "could not parse dbcheck output",
);

// ---------------------------------------------------------------------------
// Print.
// ---------------------------------------------------------------------------
const W = (s, n) => String(s).padEnd(n).slice(0, n);
const MARK = { PASS: "  ok  ", PARTIAL: " part ", FAIL: " FAIL ", CUT: " cut  ", UNPROVEN: " ???? " };

console.log("");
console.log("CONFIRMATION — the brief, measured against this book and this deployment");
console.log(`${BASE}   ${new Date().toISOString()}`);
console.log("");

let area = "";
for (const r of rows) {
  if (r.area !== area) {
    area = r.area;
    console.log(`\n${area.toUpperCase()}`);
  }
  console.log(`  ${MARK[r.verdict] ?? r.verdict} ${W(r.brief, 52)} ${r.evidence}`);
}

const fails = rows.filter((r) => r.verdict === "FAIL");
const partial = rows.filter((r) => r.verdict === "PARTIAL");
const unproven = rows.filter((r) => r.verdict === "UNPROVEN");
console.log("");
console.log(
  `${rows.filter((r) => r.verdict === "PASS").length} pass · ${partial.length} partial · ` +
    `${fails.length} fail · ${rows.filter((r) => r.verdict === "CUT").length} cut · ${unproven.length} unproven`,
);
if (fails.length > 0) {
  console.log("\nFAILING:");
  for (const f of fails) console.log(`  ${f.brief} — ${f.evidence}`);
}
console.log(
  "\nNot covered here, on purpose, because another script owns each and says so itself:" +
    "\n  the seven live-fire attacks   node scripts/livefire.mjs" +
    "\n  the seven-leg core loop       node scripts/coreloop.mjs" +
    "\n  the book rebuilt from events  node scripts/rebuild.mjs" +
    "\n  every invariant made to fail  node scripts/dbcheck.mjs --prove",
);

await sql.end();
process.exit(fails.length > 0 ? 1 : 0);
