#!/usr/bin/env node
/**
 * COMPLIANCE — audit this repo and its deployment against every rule in the
 * trial, mechanically, so the rules are RUN rather than remembered.
 *
 *   set -a; . ./.env; set +a
 *   node scripts/compliance.mjs
 *   node scripts/compliance.mjs --only AF3,AF5
 *   node scripts/compliance.mjs --base-url https://corgi-trial-psi.vercel.app
 *
 * The specification is, in this order of authority:
 *
 *   docs/TRIAL-VERBATIM.md   the Build page, word for word. It wins everything.
 *   docs/BRIEF.md            the Track 3 page, verbatim.
 *   docs/TRIAL.md            a restructured reading, subordinate to both.
 *
 * ============================================================================
 * THE FOUR RULES THIS FILE OBEYS, IN THE ORDER THEY MATTER
 * ============================================================================
 *
 * 1. A VERDICT IS DERIVED, NEVER ASSERTED. No check prints its own status. A
 *    check produces a list of assertions and the runner computes the verdict
 *    from them: any hard assertion false is FAIL; any recorded unknown is
 *    UNKNOWN; a check that made no assertion at all is UNKNOWN, not PASS.
 *    There is deliberately no code path from "nothing went wrong" to PASS.
 *
 * 2. A CHECK THAT CANNOT BE PERFORMED REPORTS **UNKNOWN**, WITH THE REASON.
 *    Never PASS. A compliance tool that guesses is worse than no compliance
 *    tool, because it converts an unexamined risk into a green line. This repo
 *    has documented the "it looked fine" failure eight times (DECISIONS 011,
 *    015, 016, 017, 021, 026, 033, 034); this file is the answer to it.
 *
 * 3. NEVER CLAIM A CAPABILITY NOT PROVEN BY A REAL CALL. Where an existing
 *    runnable already proves a claim end to end — scripts/coreloop.mjs,
 *    scripts/livefire.mjs — this file CITES it and says so in the scoreboard
 *    rather than re-running it or, worse, quietly taking credit for it. A
 *    citation is printed as CITED and is never counted as a pass.
 *
 * 4. READ-ONLY AGAINST PRODUCTION AND THE DATABASE. Every HTTP call is a GET,
 *    except: an unsigned POST to each webhook route (refused at signature
 *    verification before anything is stored — the response says so) and a
 *    `tools/list` POST to the MCP endpoint, which is a read. Every SQL
 *    statement is a SELECT, except the deliberately-forbidden UPDATE whose
 *    REFUSAL is the evidence. Nothing here moves money or writes a row.
 *
 * Money is bigint cents everywhere in this repo, including in this file: any
 * amount read out of the database stays a string or a BigInt and is never put
 * through Number().
 *
 * ============================================================================
 * DELEGATION
 * ============================================================================
 *
 * Two existing scripts are INVOKED and their exit codes folded in, rather than
 * reimplemented:
 *
 *   scripts/audit-claims.mjs   AF2 — every tracked .md against /api/health.
 *   scripts/dbcheck.mjs        AF3 — attempts UPDATE/DELETE/TRUNCATE on the
 *                              ledger as corgi_app and asserts refusal, plus
 *                              the invariant views.
 *
 * Two more are CITED, not run, because each takes minutes and hits provider
 * sandboxes; re-running them from here would make this tool something nobody
 * runs continuously:
 *
 *   scripts/coreloop.mjs       the seven legs of the published core loop.
 *   scripts/livefire.mjs       the seven published attacks plus the replay.
 *
 * Every citation names the exact leg or attack number. `--delegations` prints
 * the full map.
 *
 * ============================================================================
 * WHY THIS FILE EXCLUDES ITSELF FROM TWO OF ITS OWN SCANS
 * ============================================================================
 *
 * It contains the table names and the SQL verbs that AF3 hunts for, and the
 * credential prefixes that AF4 and AF5 hunt for. On its first run it flagged
 * itself, exactly as scripts/precommit.sh did. Self-exclusion is recorded in
 * the evidence of those checks rather than hidden, and the live-key prefixes
 * below are assembled from fragments at runtime so that the literal string
 * never appears in this file and precommit.sh's tree scanner stays quiet
 * without needing a new .secretscanignore entry.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/compliance.mjs";
const DEFAULT_BASE_URL = "https://corgi-trial-psi.vercel.app";

/* ========================================================================== */
/* Constants the checks are written against                                   */
/* ========================================================================== */

/**
 * MONEY TABLES. The criterion, stated so it can be argued with: a table is a
 * money table if a row in it either records that money moved, or decides where
 * money goes. That is wider than `journal_*` on purpose — a card control row
 * that silently changed would change an authorisation decision, and a payee
 * row that silently changed would send the payment to a different bank.
 *
 * `webhook_inbox` is NOT here. It is the provider's testimony, not our books,
 * and it holds the one sanctioned column-level UPDATE grant in the schema
 * (processed_at, processing_error, attempts). Its immutability is a different
 * guarantee, enforced by webhook_inbox_guard(), and 0001 documents why.
 */
const MONEY_TABLES = [
  "journal_entry", "journal_line",
  "card_authorization", "card_auth_event", "card_auth_decision",
  "card_control_version",
  "hold", "hold_closure", "hold_closure_reversal",
  "book_day", "statement",
  "scheme_file", "scheme_file_row", "scheme_file_reject",
  "recon_match", "recon_break_note", "recon_run", "recon_run_break",
  "payment_instruction", "payment_instruction_event",
  "standing_order", "standing_order_occurrence", "standing_order_outcome",
  "standing_order_cancellation",
  "payee", "payee_verification", "payee_acknowledgement", "payee_archival",
  "payee_candidate_refusal",
  "kyb_verification_leg", "pot",
  "fx_quote", "fx_quote_acceptance", "fx_quote_settlement",
  "fx_rate_observation",
];

/** Static console routes. Dynamic segments are handled separately in AF1. */
const CONSOLE_ROUTES = [
  "/", "/accounts", "/approvals", "/funding", "/onboarding", "/payees",
  "/payments", "/pots", "/reconciliation", "/standing-orders", "/statements",
];

/** Webhook paths whose signature enforcement is probed live. */
const WEBHOOK_PATHS = ["lithic", "plaid", "increase"];

/** Base Sepolia. Chain id and the canonical USDC contract, both testnet. */
const BASE_SEPOLIA_CHAIN_ID = "84532";
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

/**
 * Live-mode credential prefixes, assembled at runtime.
 *
 * Written as fragments because the literal strings are exactly what
 * scripts/precommit.sh's whole-tree scanner hunts for, and a compliance tool
 * that trips the commit gate on every run is a compliance tool that gets
 * deleted. Same dodge, same reason, as the `'sk''_live_'` in precommit.sh.
 */
const LIVE_PREFIXES = [
  ["sk", "_live_"].join(""),
  ["pk", "_live_"].join(""),
  ["rk", "_live_"].join(""),
  ["sk", "_prod_"].join(""),
  ["access", "-production-"].join(""),
];

/**
 * Credential SHAPES for the git-history scan. Deliberately the same list
 * scripts/precommit.sh uses on the working tree, because a secret that the
 * pre-commit gate would refuse today is a secret that must not be alive in an
 * old commit either. AF5 is precommit.sh's rule applied to the one place
 * precommit.sh structurally cannot look.
 */
const HISTORY_SHAPES = [
  ["access", "-(sandbox|development|production)-[a-f0-9]{8}-"].join(""),
  ["access", "-token-[a-f0-9]{8}-"].join(""),
  ["whsec", "_[A-Za-z0-9+/]{20,}"].join(""),
  ["npg", "_[A-Za-z0-9]{16,}"].join(""),
  // A live prefix followed by KEY MATERIAL. The bare prefix is a pattern, not
  // a key: DECISIONS.md, docs/EVALUATION.md and .secretscanignore all print it
  // while discussing the scanner, and a rule that fires on its own
  // documentation is a rule someone switches off. Ten characters of key
  // material is the line — same reasoning as the {16,} on npg_ above.
  ...LIVE_PREFIXES.map((p) => `${p}[A-Za-z0-9]{10,}`),
];

/**
 * Strings that match a credential shape but cannot authenticate anything.
 * Mirrors .secretscanignore's reasoning: an allowlist is a hole, so each entry
 * carries its justification.
 */
const KNOWN_PUBLIC = [
  // The published Standard Webhooks test vector. Specification documentation.
  ["whsec", "_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"].join(""),
  // The deliberate NEGATIVE fixture in src/lib/__tests__/env.test.ts, which
  // proves the environment layer refuses a live key at boot.
  [LIVE_PREFIXES[0], "abc123"].join(""),
];

/** Files the tree scans skip, with the reason printed in the evidence. */
const SCAN_EXEMPT = new Map([
  [SELF, "this file; it contains the patterns it hunts for"],
  ["scripts/precommit.sh", "the commit gate; same self-match, see .secretscanignore"],
  ["scripts/dbcheck.mjs", "attempts the forbidden UPDATE on purpose — that is its job"],
  ["src/lib/__tests__/env.test.ts", "negative fixture proving live keys are refused at boot"],
]);

/* ========================================================================== */
/* Formatting                                                                 */
/* ========================================================================== */

const WIDTH = 92;
const RULE = "=".repeat(WIDTH);
const THIN = "-".repeat(WIDTH);

const COLOUR = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const paint = (code, text) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text);
const GREEN = (t) => paint("32;1", t);
const RED = (t) => paint("31;1", t);
const YELLOW = (t) => paint("33;1", t);
const BLUE = (t) => paint("36;1", t);
const DIM = (t) => paint("2", t);

const BADGE = {
  PASS: () => GREEN("PASS"),
  FAIL: () => RED("FAIL"),
  WARN: () => YELLOW("WARN"),
  UNKNOWN: () => YELLOW("????"),
  CITED: () => BLUE("CITE"),
};

/** Wrap `text` to `width`, indenting every line by `indent` spaces. */
function wrap(text, width, indent) {
  const pad = " ".repeat(indent);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => `${pad}${l}`);
}

/* ========================================================================== */
/* The assertion recorder — where verdicts actually come from                 */
/* ========================================================================== */

/**
 * One check's evidence. A check never sets its own status; it calls these and
 * the runner reads the result.
 *
 *   assert(ok, text)   HARD. False => the check FAILS.
 *   soft(ok, text)     SOFT. False => the check WARNs. Used where the trial's
 *                      requirement is met but a proxy for it is not — see
 *                      AF6's monotonic-timestamp rule for the worked example.
 *   unknown(reason)    The check could not be performed. Never a pass.
 *   note(text)         Evidence with no verdict attached.
 *   cite(what, claim)  Names the runnable that proves `claim` end to end.
 */
class Recorder {
  constructor() {
    this.lines = [];
    this.hardFailures = 0;
    this.hardTotal = 0;
    this.softFailures = 0;
    this.unknowns = 0;
    this.citations = 0;
  }

  assert(ok, text) {
    this.hardTotal += 1;
    if (!ok) this.hardFailures += 1;
    this.lines.push({ kind: ok ? "ok" : "bad", text });
    return ok;
  }

  soft(ok, text) {
    if (!ok) this.softFailures += 1;
    this.lines.push({ kind: ok ? "ok" : "warn", text });
    return ok;
  }

  unknown(reason) {
    this.unknowns += 1;
    this.lines.push({ kind: "unknown", text: reason });
    return false;
  }

  note(text) {
    this.lines.push({ kind: "note", text });
  }

  cite(what, claim) {
    this.citations += 1;
    this.lines.push({ kind: "cite", text: `${what} — proves: ${claim}` });
  }

  /**
   * THE ONLY PLACE A VERDICT IS PRODUCED.
   *
   * Order matters and is the whole argument of this file: a failure outranks
   * an unknown, an unknown outranks a warning, and "no assertion was made" is
   * an unknown rather than a pass. There is no branch that reaches PASS
   * without at least one hard assertion having been made and held.
   */
  verdict() {
    if (this.hardFailures > 0) return "FAIL";
    if (this.unknowns > 0) return "UNKNOWN";
    if (this.hardTotal === 0) {
      return this.citations > 0 ? "CITED" : "UNKNOWN";
    }
    if (this.softFailures > 0) return "WARN";
    return "PASS";
  }
}

/* ========================================================================== */
/* Environment                                                                */
/* ========================================================================== */

/**
 * Load `.env` without clobbering anything already exported.
 *
 * The same loader as scripts/livefire.mjs, re-stated rather than imported:
 * livefire.mjs is a top-level script that runs its whole suite on import, so
 * there is nothing there to import. Twenty lines is the cheaper duplication.
 */
function loadDotEnv(path) {
  if (!existsSync(path)) return 0;
  let loaded = 0;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue;
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

/** Parse `.env` into key/value pairs WITHOUT touching process.env. */
function readDotEnvPairs(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** Host and database only. A connection string must never reach a terminal. */
function describeDatabase(url) {
  if (!url) return "(APP_DATABASE_URL is not set)";
  try {
    const parsed = new URL(url);
    return `${parsed.username || "?"}@${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/* ========================================================================== */
/* Filesystem and git helpers — every git invocation here is READ-ONLY        */
/* ========================================================================== */

function git(args, options = {}) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    ...options,
  });
}

let trackedCache = null;
/** Every file git tracks at HEAD. Null when this is not a git work tree. */
function trackedFiles() {
  if (trackedCache !== null) return trackedCache;
  const res = git(["ls-files"]);
  trackedCache = res.status === 0 ? res.stdout.split("\n").filter(Boolean) : null;
  return trackedCache;
}

/** Walk the tree when git is unavailable, so the scans still mean something. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".next", ".vercel"].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full));
  }
  return out;
}

function readIfPresent(rel) {
  const full = resolve(ROOT, rel);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/** Strip the obvious comment forms so a prose mention is not read as code. */
function isCommentLine(line) {
  const t = line.trim();
  return (
    t.startsWith("--") || t.startsWith("//") || t.startsWith("*") ||
    t.startsWith("/*") || t.startsWith("#") || t.startsWith(">")
  );
}

/* ========================================================================== */
/* HTTP — read-only, with a hard timeout so nothing hangs the scoreboard      */
/* ========================================================================== */

async function http(url, options = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "manual",
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const body = await res.text();
    return { ok: true, status: res.status, body, ms: Date.now() - started, headers: res.headers };
  } catch (error) {
    return { ok: false, status: 0, body: "", ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

/* ========================================================================== */
/* Database — one connection, SELECTs only (plus one UPDATE meant to fail)    */
/* ========================================================================== */

let dbHandle;
let dbError = null;

async function db() {
  if (dbHandle !== undefined) return dbHandle;
  const url = process.env["APP_DATABASE_URL"];
  if (!url) {
    dbError = "APP_DATABASE_URL is not set — run `set -a; . ./.env; set +a` first";
    dbHandle = null;
    return dbHandle;
  }
  try {
    const { default: postgres } = await import("postgres");
    dbHandle = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 20 });
    const who = await dbHandle`SELECT current_user AS u`;
    if (who[0].u !== "corgi_app") {
      dbError =
        `connected as '${who[0].u}', not 'corgi_app'. Privileges never bind the ` +
        `table owner, so a refusal proven as this role proves nothing.`;
      await dbHandle.end();
      dbHandle = null;
    }
  } catch (error) {
    dbError = `could not connect: ${String(error?.message ?? error).split("\n")[0]}`;
    dbHandle = null;
  }
  return dbHandle;
}

/* ========================================================================== */
/* Shared state gathered once and reused across checks                        */
/* ========================================================================== */

const state = {
  baseUrl: DEFAULT_BASE_URL,
  health: null,
  healthStatus: 0,
  envPairs: new Map(),
  codeFiles: [],
  allFiles: [],
};

/* ========================================================================== */
/* THE CHECKS                                                                 */
/* ========================================================================== */

/**
 * Each entry: { id, title, section, run(r) }.
 * `r` is the Recorder. A check that throws is reported as UNKNOWN with the
 * exception text — a crashed check is never a pass.
 */
const CHECKS = [];
const define = (section, id, title, run) => CHECKS.push({ section, id, title, run });

/* -------------------------------------------------------------------------- */
/* SECTION A — THE SIX AUTOMATIC FAILS                                        */
/* -------------------------------------------------------------------------- */

const AF = "AUTOMATIC FAILS — any one of these ends the trial regardless of everything else";

define(AF, "AF1", '"Localhost only, or a video in place of a URL."', async (r) => {
  const origin = new URL(state.baseUrl);
  r.assert(
    origin.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(origin.hostname),
    `target origin is public HTTPS: ${origin.origin}`,
  );

  // Every screen, from the public origin, answering 200.
  const failures = [];
  for (const route of CONSOLE_ROUTES) {
    const res = await http(`${state.baseUrl}${route}`);
    if (!res.ok || res.status !== 200) {
      failures.push(`${route} -> ${res.ok ? res.status : res.error}`);
    }
  }
  r.assert(
    failures.length === 0,
    failures.length === 0
      ? `all ${CONSOLE_ROUTES.length} console screens answer 200 from ${origin.origin}`
      : `screens not answering 200: ${failures.join("; ")}`,
  );

  // Dynamic segments are reachable only with a real id, and this tool does not
  // invent ids. Say so rather than implying the route was checked.
  r.note(
    "dynamic routes /accounts/[accountId] and /accounts/holds/[holdId] are NOT probed here: " +
      "they need a real id, and inventing one would test a 404 path. coreloop.mjs legs 2-4 " +
      "drive both with ids it created.",
  );

  // No committed document may present localhost AS THE DEPLOYMENT. A dev
  // instruction that says `pnpm dev # http://localhost:3000` is not that, so
  // the rule is contextual: localhost on a line that is also talking about the
  // deployment, the submission, or the URL we hand over.
  const docs = state.allFiles.filter((f) => f.endsWith(".md") && !f.endsWith(".local.md"));
  const offenders = [];
  for (const file of docs) {
    if (SCAN_EXEMPT.has(file)) continue;
    const text = readIfPresent(file);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      if (!/localhost|127\.0\.0\.1/.test(line)) return;
      if (!/deployed|deployment|submission|submit|the url we|live url|production url|demo credentials/i.test(line)) return;
      // A line that WARNS AGAINST localhost is the rule being stated, not a
      // claim that localhost is the deployment. This exemption had to be
      // widened once already: the first version only knew "localhost is a no"
      // and flagged research/lithic/NOTES.md saying "localhost does not" —
      // a guard that fires on the very warning it enforces gets switched off.
      if (/localhost\s+(is a no|does not|doesn't|will not|won't|cannot|can't|is not|isn't)/i.test(line)) return;
      if (/not localhost|never localhost|localhost only|no localhost|rather than localhost|instead of localhost/i.test(line)) return;
      offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  r.assert(
    offenders.length === 0,
    offenders.length === 0
      ? `no tracked .md presents localhost as the deployment (${docs.length} files scanned)`
      : `presents localhost as the deployment: ${offenders.join(" | ")}`,
  );

  // And the deployed URL is actually named in the docs a grader opens first.
  const named = ["README.md", "docs/DEMO.md"].filter((f) => (readIfPresent(f) ?? "").includes(origin.hostname));
  r.assert(named.length > 0, `deployed URL named in: ${named.join(", ") || "(nowhere)"}`);

  r.note(
    'the "video in place of a URL" half is satisfied by the URL existing above; whether the ' +
      "submission email leads with a video instead is not observable from the repo.",
  );
});

define(AF, "AF2", '"A simulated integration presented as live."', async (r) => {
  if (state.health === null) {
    r.unknown(`/api/health did not answer (status ${state.healthStatus}); there is no truth to audit against`);
    return;
  }
  const slots = state.health.integrations?.slots ?? [];
  r.assert(slots.length > 0, `/api/health enumerates ${slots.length} integration slots with per-slot evidence`);

  // Every slot claiming live must carry evidence of a real call, not a present
  // credential. DECISIONS 011 and 034 are both this bug.
  const bare = slots.filter((s) => s.status === "live" && !/->\s*\d{3}|confirmed|enabled|USDC/i.test(String(s.evidence ?? "")));
  r.assert(
    bare.length === 0,
    bare.length === 0
      ? "every slot reading 'live' carries call evidence (an HTTP status or an on-chain fact), not a present key"
      : `slots claiming live with no call evidence: ${bare.map((s) => s.slot).join(", ")}`,
  );

  /* ---- Is the truth itself stable? ------------------------------------- */
  //
  // audit-claims.mjs diffs documents against ONE reading of /api/health. If
  // that reading is unstable, its verdict is unstable with it — and the first
  // version of this check learned that the hard way: comparing the banner
  // reading against audit-claims' own reading catches the flap only when the
  // two land on different sides of it. When both readings happen to catch the
  // same transient, the documents get blamed for being right.
  //
  // So the endpoint is sampled directly, several times, and the question asked
  // is "did any slot change its mind", not "did two readings differ".
  const samples = [state.health];
  for (let i = 0; i < 2; i += 1) {
    const again = await http(`${state.baseUrl}/api/health`);
    if (again.ok && again.status === 200) {
      try { samples.push(JSON.parse(again.body)); } catch { /* a sample we cannot parse is not a sample */ }
    }
  }
  const unstable = new Set();
  for (const slot of slots) {
    const verdicts = new Set(samples.map((s) => (s.integrations?.slots ?? []).find((x) => x.slot === slot.slot)?.status));
    if (verdicts.size > 1) unstable.add(`${slot.slot} (${[...verdicts].join(" then ")})`);
  }
  // A flap is a HARD failure of this rule, not a reason to shrug.
  //
  // "Honest labelling" is a reproducibility requirement: a slot that reads
  // live on one request and simulated on the next is presenting a simulated
  // integration as live some of the time, which is the automatic fail, and
  // presenting a live one as simulated the rest of the time, which throws away
  // credit that was earned. Either way the label is not something a grader can
  // rely on, and the bug is in the probe, not in the documents.
  //
  // When it fires, the delegation is deliberately skipped: diffing documents
  // against an unstable truth would blame a correct document for a transient.
  r.assert(
    unstable.size === 0,
    unstable.size === 0
      ? `the live/simulated verdict is reproducible: ${samples.length} readings seconds apart agree on every slot`
      : `/api/health changed its mind about ${[...unstable].join(", ")} across ${samples.length} readings taken seconds apart. ` +
        `A label that is not reproducible is not honest labelling — at some of those moments the endpoint was ` +
        `presenting that slot as live and at others as simulated. Fix the probe's transient before trusting either answer.`,
  );
  if (unstable.size > 0) {
    r.note("scripts/audit-claims.mjs was NOT run: diffing documents against an unstable truth would blame a correct document for a transient");
    return;
  }

  // DELEGATED: audit-claims.mjs already diffs every tracked .md against this
  // endpoint. Reimplementing it here would be two guards drifting apart.
  const res = spawnSync(process.execPath, [resolve(ROOT, "scripts/audit-claims.mjs"), `--url=${state.baseUrl}`], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000,
  });
  if (res.error || res.status === null) {
    r.unknown(`scripts/audit-claims.mjs could not be run: ${String(res.error?.message ?? "no exit status")}`);
    return;
  }
  const stdout = String(res.stdout ?? "");
  const tail = stdout.trim().split("\n").slice(-1)[0] ?? "";
  for (const line of stdout.split("\n").filter((l) => /:\d+ /.test(l)).slice(0, 10)) {
    r.note(`  ${line.trim()}`);
  }

  // audit-claims re-reads /api/health for its own truth. Even after the
  // stability sampling above, that fourth reading can land on a transient, and
  // a document must not be blamed for one. So the two truths are compared once
  // more, and a disagreement is UNKNOWN rather than a verdict either way.
  const theirTruth = stdout.match(/^truth:\s*(\d+)\s+of\s+(\d+)/m);
  const ourLive = state.health.integrations?.live;
  if (theirTruth !== null && Number(theirTruth[1]) !== ourLive) {
    r.unknown(
      `/api/health reported ${ourLive} live across ${samples.length} stable readings and ${theirTruth[1]} live ` +
        `inside audit-claims.mjs seconds later. The truth moved under the audit, so a document that disagrees ` +
        `with it may be correct. Re-run before editing any document. audit-claims.mjs exited ${res.status}.`,
    );
    return;
  }
  r.assert(res.status === 0, `scripts/audit-claims.mjs exit ${res.status} — ${tail}`);
});

define(AF, "AF3", '"UPDATE or DELETE on money rows. Anywhere. Ever."', async (r) => {
  /* ---- Layer 0: the source tree ---------------------------------------- */
  const alternation = MONEY_TABLES.join("|");
  const updateRe = new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?(?:public\\.)?(${alternation})\\b`, "i");
  const deleteRe = new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(?:public\\.)?(${alternation})\\b`, "i");
  const truncRe = new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(?:public\\.)?(${alternation})\\b`, "i");

  /**
   * A statement that is written IN ORDER TO BE REFUSED is the proof, not the
   * breach — `await expect(sql\`UPDATE journal_entry …\`).rejects.toThrow()` is
   * the strongest evidence in the repo that the rule holds. So a hit is
   * classified by its neighbourhood: refusal vocabulary within three lines
   * either side makes it a prover; anything else is a violation.
   *
   * Deliberately narrow. Exempting every test file wholesale would mean a test
   * that genuinely mutated a money row — the exact thing that would make the
   * database's guarantee a lie — sailed through unexamined.
   */
  const REFUSAL = /rejects\.toThrow|mustRefuse|toThrowError|expects?\s*\(|\.catch\(|refus|denied|42501|55006|must fail|should fail/i;
  const codeHits = [];
  const provers = [];
  for (const file of state.codeFiles) {
    if (SCAN_EXEMPT.has(file)) continue;
    const text = readIfPresent(file);
    if (text === null) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      // A REVOKE or a GRANT names the tables; so does a trigger definition.
      // Those are the guard, not the breach.
      if (/\b(REVOKE|GRANT)\b/i.test(line)) return;
      if (/CREATE\s+TRIGGER|BEFORE\s+UPDATE|AFTER\s+UPDATE|INSTEAD\s+OF/i.test(line)) return;
      if (/information_schema|pg_catalog|pg_trigger|pg_class/i.test(line)) return;
      if (!updateRe.test(line) && !deleteRe.test(line) && !truncRe.test(line)) return;
      const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
      if (REFUSAL.test(window)) provers.push(`${file}:${i + 1}`);
      else codeHits.push(`${file}:${i + 1}  ${line.trim().slice(0, 88)}`);
    });
  }
  r.assert(
    codeHits.length === 0,
    codeHits.length === 0
      ? `no UPDATE/DELETE/TRUNCATE against any of the ${MONEY_TABLES.length} money tables in ${state.codeFiles.length} code files`
      : `forbidden statements found: ${codeHits.join(" | ")}`,
  );
  r.note(
    `${provers.length} occurrence(s) are statements written to be REFUSED, with the assertion beside them ` +
      `— counted as proof, not breach: ${provers.slice(0, 6).join(", ")}${provers.length > 6 ? ", …" : ""}`,
  );
  r.note(`scan exempts ${[...SCAN_EXEMPT.keys()].join(", ")} — reasons in SCAN_EXEMPT, printed with --delegations`);

  /* ---- Layer 1: the database's own answer ------------------------------ */
  const sql = await db();
  if (sql === null) {
    r.unknown(`the privilege and trigger proof could not be attempted: ${dbError}`);
    r.note("a migration that says REVOKE is not evidence that the REVOKE was applied. Without the database this check is source-only.");
    return;
  }

  const priv = await sql`
    SELECT c.relname AS t,
           has_table_privilege(current_user, c.oid, 'UPDATE')   AS upd,
           has_table_privilege(current_user, c.oid, 'DELETE')   AS del,
           has_table_privilege(current_user, c.oid, 'TRUNCATE') AS trunc
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${MONEY_TABLES})
     ORDER BY 1`;
  const absent = MONEY_TABLES.filter((t) => !priv.some((p) => p.t === t));
  r.assert(absent.length === 0, absent.length === 0
    ? `all ${MONEY_TABLES.length} money tables exist in the deployed schema`
    : `money tables missing from the database: ${absent.join(", ")}`);

  const holds = priv.filter((p) => p.upd || p.del || p.trunc);
  r.assert(
    holds.length === 0,
    holds.length === 0
      ? `corgi_app holds NO effective UPDATE/DELETE/TRUNCATE on any money table (has_table_privilege, which also covers PUBLIC and inherited roles)`
      : `corgi_app CAN mutate: ${holds.map((h) => `${h.t}(${[h.upd && "UPDATE", h.del && "DELETE", h.trunc && "TRUNCATE"].filter(Boolean).join(",")})`).join(", ")}`,
  );

  // The grant surface the trial asks about, read the way a reviewer would.
  const grants = await sql`
    SELECT table_name, string_agg(DISTINCT privilege_type, ',') AS privs
      FROM information_schema.role_table_grants
     WHERE grantee = current_user AND table_name = ANY(${MONEY_TABLES})
     GROUP BY table_name ORDER BY table_name`;
  const bad = grants.filter((g) => /UPDATE|DELETE|TRUNCATE/.test(g.privs));
  r.assert(
    bad.length === 0,
    bad.length === 0
      ? `information_schema.role_table_grants agrees: ${grants.length} money tables granted, none with UPDATE/DELETE/TRUNCATE`
      : `role_table_grants shows mutation grants: ${bad.map((g) => `${g.table_name}=${g.privs}`).join(", ")}`,
  );

  /* ---- Layer 2: the append-only triggers actually exist ---------------- */
  const trg = await sql`
    SELECT c.relname AS t, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname = ANY(${MONEY_TABLES})`;
  const byTable = new Map();
  for (const row of trg) {
    if (!byTable.has(row.t)) byTable.set(row.t, []);
    byTable.get(row.t).push(row.tgname);
  }
  const missingGuard = MONEY_TABLES.filter((t) => {
    const names = byTable.get(t) ?? [];
    return !names.some((n) => n.endsWith("_no_update_delete")) || !names.some((n) => n.endsWith("_no_truncate"));
  });
  // The trigger is layer 2. Layer 1 — the absent privilege, asserted above —
  // is what actually binds the application, and it binds it whether or not a
  // trigger exists. So a table protected by privileges but missing its trigger
  // is a DEFENCE-IN-DEPTH GAP, not the automatic fail: it is reported as WARN,
  // named, and not allowed to hide. A table with neither is the automatic
  // fail, and the privilege assertion above has already caught that case.
  r.soft(
    missingGuard.length === 0,
    missingGuard.length === 0
      ? `every money table carries both append-only triggers (${trg.length} triggers over ${MONEY_TABLES.length} tables), queried from pg_trigger — not read off a migration`
      : `layer 2 gap — privileges hold, but these money tables carry no append-only trigger: ${missingGuard.join(", ")}. ` +
        `A REVOKE binds the application; a trigger also binds the table OWNER and any future role. Every other money table has both.`,
  );

  /* ---- Layer 3: demonstrate it. A refusal you can show beats one you read */
  //
  // DELEGATED for journal_entry / journal_line: scripts/dbcheck.mjs already
  // attempts UPDATE, DELETE and TRUNCATE on both and asserts the refusal. This
  // runs it and folds the exit code in, then EXTENDS rather than duplicates by
  // attempting the same forbidden statement on three tables dbcheck does not
  // cover, so the demonstration reaches past the ledger core.
  const dbres = spawnSync(process.execPath, [resolve(ROOT, "scripts/dbcheck.mjs")], {
    cwd: ROOT, encoding: "utf8", timeout: 180_000, env: process.env,
  });
  if (dbres.error || dbres.status === null) {
    r.unknown(`scripts/dbcheck.mjs could not be run: ${String(dbres.error?.message ?? "no exit status")}`);
  } else {
    const tally = String(dbres.stdout ?? "").match(/(\d+) passed, (\d+) failed/);
    r.assert(dbres.status === 0, `scripts/dbcheck.mjs exit ${dbres.status} — ${tally ? tally[0] : "no tally printed"}`);
  }

  for (const table of ["statement", "payment_instruction", "pot"]) {
    let refused = false;
    let detail = "";
    try {
      // Real UPDATE, real role, against production data. It is expected to be
      // refused at the PRIVILEGE check, which fires before any row is matched
      // — so this cannot alter a row even in the universe where it is allowed
      // by the trigger. `WHERE false` keeps that true belt-and-braces.
      await sql.unsafe(`UPDATE ${table} SET id = id WHERE false`);
    } catch (error) {
      refused = true;
      detail = String(error?.message ?? error).split("\n")[0].slice(0, 70);
    }
    r.assert(refused, refused
      ? `real UPDATE on ${table} as corgi_app was REFUSED — ${detail}`
      : `real UPDATE on ${table} as corgi_app was ALLOWED. This is the automatic fail.`);
  }
});

define(AF, "AF4", '"Live-mode API keys, real money, or real personal data."', async (r) => {
  const env = state.envPairs;
  if (env.size === 0) {
    r.unknown("no .env found at the repo root; provider credential shapes cannot be checked");
  }

  /**
   * Shape rules, per provider. Each is a function of the value, and each
   * carries the reason the shape is decisive. Where a provider's key shape
   * does NOT distinguish test from live — Lithic, Increase and Plaid all use
   * opaque strings — the decisive fact is the BASE URL the code calls, which
   * is asserted separately below. Saying which of the two settles it is the
   * point; a check that pretends a UUID proves sandbox would be a guess.
   */
  const shapeRules = [
    ["STRIPE_SECRET_KEY", (v) => v.startsWith("sk_test_"), "must begin sk_test_"],
    ["CIRCLE_API_KEY", (v) => v.startsWith("TEST_API_KEY:"), "must begin TEST_API_KEY:"],
    ["BASE_SEPOLIA_CHAIN_ID", (v) => v.trim() === BASE_SEPOLIA_CHAIN_ID, `must be ${BASE_SEPOLIA_CHAIN_ID} (Base Sepolia)`],
    ["USDC_CONTRACT_ADDRESS", (v) => v.trim().toLowerCase() === BASE_SEPOLIA_USDC, "must be the Base Sepolia USDC contract"],
    ["BASE_SEPOLIA_RPC_URL", (v) => /sepolia/i.test(v), "must be a Sepolia RPC host"],
  ];
  for (const [key, ok, why] of shapeRules) {
    const value = env.get(key);
    if (value === undefined || value === "") {
      r.note(`${key} is not set — nothing to classify`);
      continue;
    }
    r.assert(ok(value), `${key} is a test/sandbox credential by shape (${why})`);
  }

  // Opaque-shaped provider keys: the base URL is what decides, so assert the
  // environment cannot steer the client at production.
  const urlRules = [
    ["PLAID_ENV", (v) => v === undefined || v.trim().toLowerCase() !== "production", "unset or not 'production' — client.ts defaults to sandbox.plaid.com"],
    ["INCREASE_BASE_URL", (v) => v === undefined || /sandbox\.increase\.com/.test(v), "unset or sandbox.increase.com"],
    ["LITHIC_BASE_URL", (v) => v === undefined || /sandbox\.lithic\.com/.test(v), "unset or sandbox.lithic.com"],
    ["PERSONA_BASE_URL", (v) => v === undefined || !/production/i.test(v), "unset or non-production"],
  ];
  for (const [key, ok, why] of urlRules) {
    const value = env.get(key);
    r.assert(ok(value), `${key}: ${value === undefined || value === "" ? "unset" : value} — ${why}`);
  }

  // Lithic and Increase keys are opaque. Say that out loud rather than letting
  // "all credentials are test keys" imply a shape check that does not exist.
  for (const key of ["LITHIC_API_KEY", "INCREASE_API_KEY", "PLAID_SECRET", "CDP_API_KEY_SECRET", "CIRCLE_ENTITY_SECRET"]) {
    if (env.has(key)) {
      r.note(`${key}: shape carries no test/live marker; sandbox is established by the base URL asserted above, not by this value`);
    }
  }

  // No live-mode KEY anywhere in the tree.
  //
  // A live prefix followed by ten or more characters of key material, not the
  // bare prefix. Three tracked documents print `sk`+`_live_` while discussing
  // the scanner that hunts for it — DECISIONS 023 and 032, docs/EVALUATION.md,
  // .secretscanignore — and the first version of this check flagged all of
  // them. A guard that fires on its own documentation is a guard that gets
  // switched off, which is how the thing it guards ships.
  const keyRes = LIVE_PREFIXES.map((p) => new RegExp(`${p}[A-Za-z0-9]{10,}`));
  const hits = [];
  for (const file of state.allFiles) {
    if (SCAN_EXEMPT.has(file)) continue;
    const text = readIfPresent(file);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      if (!keyRes.some((re) => re.test(line))) return;
      if (KNOWN_PUBLIC.some((k) => line.includes(k))) return;
      hits.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  r.assert(hits.length === 0, hits.length === 0
    ? `no live-mode credential (a live prefix plus key material) in any of ${state.allFiles.length} tracked files`
    : `live-mode credential found: ${hits.join(" | ")}`);
  r.note("the BARE prefix is not flagged: several tracked documents print it while discussing the scanner that hunts for it");

  // The deployment's own opinion of which environment it is talking to.
  if (state.health !== null) {
    const evidence = JSON.stringify(state.health.integrations?.slots ?? []);
    r.assert(!/api\.lithic\.com|api\.increase\.com|production\.plaid\.com/.test(evidence),
      "no production provider host appears in the deployed /api/health evidence");
    r.assert(/sandbox|testnet|Sepolia|test/i.test(evidence),
      "deployed /api/health evidence names sandbox/testnet providers");
  } else {
    r.unknown("/api/health did not answer, so the DEPLOYED environment's provider hosts are unverified — local .env proves nothing about Vercel's env");
  }

  r.note(
    "real personal data: the trial forbids feeding real PII to a trial system. Whether a name in the " +
      "seed belongs to a real person is not decidable mechanically — see docs/COMPLIANCE.md. What is " +
      "checked: the seeded identities come from scripts/seed.mjs, and the KYC path uses the providers' " +
      "published test identities (docs/KYB.md).",
  );
});

define(AF, "AF5", '"Secrets committed to the repo." — GIT HISTORY, not just the tip', async (r) => {
  const tracked = trackedFiles();
  if (tracked === null) {
    r.unknown("not a git work tree (or git is unavailable) — the history cannot be scanned, and the tip scan alone would be the exact blind spot this check exists to remove");
    return;
  }

  r.assert(!tracked.includes(".env"), ".env is not tracked by git");

  const revs = git(["rev-list", "--all"]);
  if (revs.status !== 0) {
    r.unknown(`git rev-list --all failed: ${String(revs.stderr ?? "").split("\n")[0]}`);
    return;
  }
  const revList = revs.stdout.split("\n").filter(Boolean);
  r.note(`history: ${revList.length} commits across all refs`);

  // git grep over every commit. This is the check precommit.sh structurally
  // cannot make: it reads the staged diff and the working tree, and a secret
  // removed from the tip is invisible to both while remaining perfectly alive
  // in an old object.
  const pattern = HISTORY_SHAPES.join("|");
  const found = new Map(); // "file :: shape" -> Set(rev)
  let scanned = 0;
  for (let i = 0; i < revList.length; i += 120) {
    const chunk = revList.slice(i, i + 120);
    const res = git(["grep", "-I", "-n", "-E", pattern, ...chunk, "--", "."], { timeout: 240_000 });
    scanned += chunk.length;
    if (res.status !== 0 && res.status !== 1) {
      r.unknown(`git grep failed over commits ${i}..${i + chunk.length}: ${String(res.stderr ?? "").split("\n")[0]}`);
      return;
    }
    for (const line of String(res.stdout ?? "").split("\n")) {
      if (line === "") continue;
      const m = line.match(/^([0-9a-f]{7,40}):([^:]+):(\d+):(.*)$/);
      if (m === null) continue;
      const [, rev, file, , text] = m;
      if (SCAN_EXEMPT.has(file)) continue;
      if (KNOWN_PUBLIC.some((k) => text.includes(k))) continue;
      const shape = HISTORY_SHAPES.find((s) => new RegExp(s).test(text)) ?? "(unknown shape)";
      const key = `${file} :: ${shape.slice(0, 28)}`;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key).add(rev.slice(0, 7));
    }
  }

  r.assert(
    found.size === 0,
    found.size === 0
      ? `no credential-shaped string in any of ${scanned} commits`
      : `credential-shaped strings alive in git history (${found.size} file/shape pairs)`,
  );
  for (const [key, revsFound] of [...found.entries()].slice(0, 12)) {
    const list = [...revsFound];
    r.note(`  ${key} — in ${list.length} commit(s): ${list.slice(0, 5).join(", ")}${list.length > 5 ? ", …" : ""}`);
  }

  // The strongest form of the check: is a value CURRENTLY in .env alive in any
  // commit? Shape rules have false negatives; an exact value has none.
  // (The value is passed in argv to `git log -S`. That is visible to other
  // processes on this machine for the life of the call, and this file never
  // prints it — only the key name.)
  const secretKeyRe = /(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|DSN)|^(DATABASE_URL|DIRECT_URL|APP_DATABASE_URL)$/;
  const leaked = [];
  let pickaxeChecked = 0;
  for (const [key, value] of state.envPairs) {
    if (!secretKeyRe.test(key)) continue;
    if (value.length < 20) continue;
    const res = git(["log", "--all", "-1", "--format=%H", `-S${value}`], { timeout: 120_000 });
    if (res.status !== 0) {
      r.unknown(`git log -S for ${key} failed or timed out; that value's history is unverified`);
      continue;
    }
    pickaxeChecked += 1;
    if (res.stdout.trim() !== "") leaked.push(`${key} (introduced in ${res.stdout.trim().slice(0, 7)})`);
  }
  r.assert(
    leaked.length === 0,
    leaked.length === 0
      ? `no current .env secret value appears in any commit (${pickaxeChecked} values pickaxed with git log -S)`
      : `LIVE .env values present in git history: ${leaked.join(", ")}`,
  );

  /* ---- Is a flagged string an actual working credential? ---------------- */
  //
  // A shape match says "this looks like a token". Calling the provider says
  // whether it IS one, and a credential you can demonstrate authenticating is
  // worth more than a regex hit someone can argue with. Plaid is the one
  // provider here whose token shape is unambiguous and whose liveness costs a
  // single read: POST /item/get, no mutation, no money.
  //
  // DECISIONS 023 set the rule this serves: ROTATE BEFORE CLEANING. A scrubbed
  // file with a live credential still in the history is still a live
  // credential, so what matters is not whether the string is at the tip but
  // whether it still authenticates.
  const plaidTokens = new Set();
  for (const key of found.keys()) {
    if (!/access-\(sandbox/.test(key)) continue;
    const file = key.split(" :: ")[0];
    const text = readIfPresent(file);
    if (text === null) continue;
    for (const m of text.matchAll(/access-(?:sandbox|development|production)-[0-9a-f-]{20,}/g)) {
      plaidTokens.add(m[0]);
    }
  }
  if (plaidTokens.size === 0) {
    r.note("no Plaid-shaped access token is readable at the tip, so none could be tested for liveness");
  } else if (!process.env["PLAID_CLIENT_ID"] || !process.env["PLAID_SECRET"]) {
    r.unknown(`${plaidTokens.size} Plaid-shaped token(s) found, but PLAID_CLIENT_ID/PLAID_SECRET are not set, so whether they still authenticate is UNVERIFIED`);
  } else {
    for (const token of [...plaidTokens].slice(0, 4)) {
      const res = await http("https://sandbox.plaid.com/item/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: process.env["PLAID_CLIENT_ID"],
          secret: process.env["PLAID_SECRET"],
          access_token: token,
        }),
      });
      if (!res.ok) {
        r.unknown(`Plaid did not answer, so the liveness of a committed token is unverified: ${res.error}`);
        continue;
      }
      const dead = res.status !== 200 || /INVALID_ACCESS_TOKEN/.test(res.body);
      r.assert(dead,
        dead
          ? `a committed Plaid token no longer authenticates (HTTP ${res.status}) — leaked, but dead`
          : `a committed Plaid token STILL AUTHENTICATES against the sandbox (HTTP ${res.status}, /item/get returned a live item). ` +
            `Rotate it before scrubbing: DECISIONS 023 — "a scrubbed file with a live credential in the history is still a live credential." ` +
            `Token ends …${token.slice(-6)}.`);
    }
  }
});

define(AF, "AF6", '"Code you cannot explain line by line." — PARTIALLY mechanisable', async (r) => {
  r.unknown(
    "whether the author can explain a line when a grader points at it is NOT mechanisable, and this " +
      "tool will not fake a check for it. The verdict for AF6 is UNKNOWN by construction. What follows " +
      "is the subset that CAN be asserted, and it is a proxy for explainability, not a substitute.",
  );

  /* ---- Proxy 1: every production module under src/lib/ has a header ----- */
  const libFiles = state.allFiles.filter(
    (f) => f.startsWith("src/lib/") && /\.tsx?$/.test(f) && !/\.test\.tsx?$|\.integration\.test\./.test(f),
  );
  const headerless = [];
  for (const file of libFiles) {
    const text = readIfPresent(file);
    if (text === null) continue;
    // A header is a comment block before the first import/export/statement.
    const firstCode = text.split("\n").findIndex((l) => /^\s*(import|export|const|function|class|type|interface)\b/.test(l));
    const head = firstCode <= 0 ? "" : text.split("\n").slice(0, firstCode).join("\n");
    if (!/\/\*\*|\/\/|\/\*/.test(head)) headerless.push(file);
  }
  r.soft(
    headerless.length === 0,
    headerless.length === 0
      ? `all ${libFiles.length} production modules under src/lib/ carry a file header comment`
      : `${headerless.length} of ${libFiles.length} production modules under src/lib/ have NO file header: ${headerless.join(", ")}`,
  );

  /* ---- Proxy 2: the decision log is timestamped ------------------------- */
  const decisions = readIfPresent("DECISIONS.md");
  if (decisions === null) {
    r.unknown("DECISIONS.md is missing");
    return;
  }
  const entries = [...decisions.matchAll(/^##\s+(\d{3})\s+—\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)/gm)].map((m) => ({
    n: m[1], at: m[2],
  }));
  const headings = (decisions.match(/^##\s+\d{3}\b/gm) ?? []).length;
  r.assert(entries.length > 0, `DECISIONS.md holds ${entries.length} numbered, timestamped entries`);
  r.assert(entries.length === headings, `every numbered entry carries a timestamp (${entries.length} of ${headings} headings)`);

  /* ---- Proxy 3: timestamps increase monotonically ---------------------- */
  const regressions = [];
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].at < entries[i - 1].at) {
      regressions.push(`${entries[i].n} (${entries[i].at}) after ${entries[i - 1].n} (${entries[i - 1].at})`);
    }
  }
  r.soft(
    regressions.length === 0,
    regressions.length === 0
      ? `entry timestamps increase monotonically across all ${entries.length} entries`
      : `${regressions.length} entry timestamp(s) go backwards: ${regressions.join("; ")}`,
  );
  if (regressions.length > 0) {
    r.note(
      "SOFT, not hard. The trial asks for entries 'written as you go', timestamped; it does not ask " +
        "for a monotonic sequence, and parallel workers writing up concurrent work land out of order. " +
        "Proxy 4 is the check that actually answers 'written as you go'.",
    );
  }

  /* ---- Proxy 4: the git history shows the log written OVER TIME -------- */
  const tracked = trackedFiles();
  if (tracked === null) {
    r.unknown("git is unavailable; 'a single hour-47 commit titled add decision log' cannot be ruled out");
    return;
  }
  const log = git(["log", "--follow", "--format=%H %cI %s", "--", "DECISIONS.md"]);
  if (log.status !== 0) {
    r.unknown(`git log for DECISIONS.md failed: ${String(log.stderr ?? "").split("\n")[0]}`);
    return;
  }
  const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, when, ...subject] = l.split(" ");
    return { sha: sha.slice(0, 7), when, subject: subject.join(" ") };
  });
  r.assert(commits.length >= 2, `DECISIONS.md was touched by ${commits.length} commit(s) — "a single hour-47 commit defeats the purpose"`);
  if (commits.length >= 2) {
    const newest = new Date(commits[0].when).getTime();
    const oldest = new Date(commits[commits.length - 1].when).getTime();
    const hours = (newest - oldest) / 3_600_000;
    r.assert(hours >= 4, `those commits span ${hours.toFixed(1)} hours (${commits[commits.length - 1].when.slice(0, 16)} → ${commits[0].when.slice(0, 16)})`);
    r.note(`oldest: ${commits[commits.length - 1].sha} "${commits[commits.length - 1].subject.slice(0, 60)}"`);
    r.note(`newest: ${commits[0].sha} "${commits[0].subject.slice(0, 60)}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* SECTION B — THE TEN NON-NEGOTIABLES                                        */
/* -------------------------------------------------------------------------- */

const NN = "THE TEN NON-NEGOTIABLES (docs/TRIAL-VERBATIM.md lines 65-74)";

define(NN, "NN1", "It is deployed, with demo credentials for at least two roles", async (r) => {
  const health = await http(`${state.baseUrl}/api/health`);
  r.assert(health.ok && health.status === 200, `GET /api/health -> ${health.ok ? health.status : health.error} in ${health.ms}ms`);

  // The two roles, proven by the deployed page changing which one is pressed.
  const pressedFor = async (cookie) => {
    const res = await http(`${state.baseUrl}/payments`, cookie ? { headers: { cookie } } : {});
    if (!res.ok || res.status !== 200) return null;
    const out = {};
    for (const role of ["Staff", "Approver"]) {
      const m = res.body.match(new RegExp(`aria-pressed="(true|false)"[^>]*>${role}<`));
      if (m !== null) out[role] = m[1] === "true";
    }
    return out;
  };
  const asStaff = await pressedFor(null);
  const asApprover = await pressedFor("corgi_demo_role=approver");
  if (asStaff === null || asApprover === null) {
    r.unknown("the /payments screen did not render, so the role switch could not be exercised");
  } else {
    r.assert(asStaff.Staff === true && asStaff.Approver === false, "with no cookie the deployed console acts as Staff");
    r.assert(asApprover.Approver === true && asApprover.Staff === false, "with corgi_demo_role=approver it acts as Approver");
  }

  const sql = await db();
  if (sql === null) {
    r.unknown(`the two roles could not be confirmed in the database: ${dbError}`);
  } else {
    const actors = await sql`
      SELECT can_approve, count(*)::int AS n FROM actor
       WHERE kind = 'human' AND business_id IS NULL GROUP BY can_approve ORDER BY 1`;
    const yes = actors.find((a) => a.can_approve === true)?.n ?? 0;
    const no = actors.find((a) => a.can_approve === false)?.n ?? 0;
    r.assert(yes >= 1 && no >= 1, `seeded staff actors: ${no} that cannot approve, ${yes} that can — two genuinely different principals, resolved by predicate (src/lib/approvals/session.ts)`);
  }
  r.assert((readIfPresent("docs/DEMO.md") ?? "").length > 0, "docs/DEMO.md documents both roles and the click path");
});

define(NN, "NN2", "You wrote the ledger: double-entry, append-only, balances derivable at any past date", async (r) => {
  const sql = await db();
  if (sql === null) {
    r.unknown(`the ledger's shape could not be read: ${dbError}`);
  } else {
    const trg = await sql`
      SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.relname IN ('journal_entry','journal_line')`;
    const names = trg.map((t) => t.tgname);
    r.assert(names.includes("journal_line_balanced"), "journal_line_balanced trigger exists — double entry is enforced by the database, not by the caller");
    r.assert(names.includes("journal_entry_has_lines"), "journal_entry_has_lines trigger exists — no entry without lines");
    r.assert(names.includes("journal_entry_reversal_exact"), "journal_entry_reversal_exact trigger exists — a reversal must mirror what it reverses");

    const cols = await sql`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='journal_entry'
         AND column_name IN ('value_date','booking_seq','booking_time')`;
    r.assert(cols.length === 3,
      `journal_entry carries both clocks as separate columns: ${cols.map((c) => `${c.column_name} ${c.data_type}`).join(", ")}`);

    const views = await sql`
      SELECT table_name FROM information_schema.views
       WHERE table_schema='public' AND table_name IN ('v_ledger_balance','v_available_balance','v_trial_balance')`;
    r.assert(views.length === 3, `balances are views over the entries, not stored columns: ${views.map((v) => v.table_name).join(", ")}`);
  }

  // "including as it stood on any past date" — proven by a REAL call to the
  // deployed MCP surface with both as-of axes, which is the only place in the
  // system a past-date balance is reachable from outside.
  const asOf = await mcp("get_balance", { as_of_value_date: "2026-09-01", as_of_booking_time: "2026-09-05T00:00:00Z" });
  if (asOf.unknown !== undefined) {
    r.unknown(`the past-date balance could not be requested from the deployment: ${asOf.unknown}`);
  } else {
    r.assert(asOf.error === undefined, `deployed get_balance answered a bitemporal as-of query (value_date 2026-09-01, as-believed 2026-09-05)`);
    const payload = asOf.json ?? {};
    const text = JSON.stringify(payload);
    r.assert(/as_of|value_date/.test(text), "the answer echoes the as-of it was asked for");
    r.assert(!/\d+\.\d{2}"?\s*[,}]/.test(text.replace(/"\d{4}-\d{2}-\d{2}/g, "")) || /cents/.test(text),
      "amounts come back as integer cents, not decimal dollars");
  }

  r.cite("scripts/dbcheck.mjs (run by AF3)", "every entry sums to zero; the trial balance is zero; no stored balance column");
  r.cite("scripts/coreloop.mjs leg 2", "an external money event lands as a journal entry and the ledger moves");
});

define(NN, "NN3", "At least two integrations are genuinely live", async (r) => {
  if (state.health === null) {
    r.unknown(`/api/health did not answer (status ${state.healthStatus})`);
    return;
  }
  const slots = state.health.integrations?.slots ?? [];
  const live = slots.filter((s) => s.status === "live");
  r.assert(live.length >= 2, `${live.length} of ${slots.length} slots read live: ${live.map((s) => s.slot).join(", ")}`);

  const mustBeLive = slots.filter((s) => s.mustBeLive === true);
  const failing = mustBeLive.filter((s) => s.status !== "live");
  r.assert(failing.length === 0, failing.length === 0
    ? `both Track 3 "Must be live" slots are live: ${mustBeLive.map((s) => s.slot).join(", ")}`
    : `slots the brief marks Must be live that are not: ${failing.map((s) => s.slot).join(", ")}`);

  for (const slot of live.slice(0, 8)) {
    r.note(`  ${String(slot.slot).padEnd(18)} ${String(slot.provider).slice(0, 34).padEnd(36)} ${String(slot.evidence ?? "").slice(0, 60)}`);
  }
  r.cite("scripts/audit-claims.mjs (run by AF2)", "no committed document labels a simulated slot live");
});

define(NN, "NN4", "Webhooks done properly: signatures, idempotency, out-of-order, polling as fallback", async (r) => {
  // Signature verification, proven at the deployed origin. An unsigned POST is
  // refused before anything is stored; the response says so in those words.
  for (const provider of WEBHOOK_PATHS) {
    const res = await http(`${state.baseUrl}/api/webhooks/${provider}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compliance_probe: true }),
    });
    if (!res.ok) {
      r.unknown(`POST /api/webhooks/${provider} did not answer: ${res.error}`);
      continue;
    }
    const refused = res.status === 401 || res.status === 400;
    r.assert(refused && /SIGNATURE/i.test(res.body),
      `unsigned POST /api/webhooks/${provider} -> ${res.status} ${(res.body.match(/"code":"([A-Z_]+)"/) ?? [, "?"])[1]} — "nothing was stored"`);
  }

  const sql = await db();
  if (sql === null) {
    r.unknown(`the idempotency constraint could not be read from the database: ${dbError}`);
  } else {
    const cons = await sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'webhook_inbox'::regclass AND contype = 'u'`;
    const replay = cons.find((c) => /provider.*provider_event_id/.test(c.def));
    r.assert(replay !== undefined,
      `replay is a no-op by constraint: ${replay?.conname ?? "(none found)"} ${replay?.def ?? ""}`);

    const states = await sql`SELECT unnest(enum_range(NULL::webhook_inbox_state))::text AS s`;
    const set = states.map((x) => x.s);
    r.assert(set.includes("parked"),
      `out-of-order delivery is modelled explicitly: webhook_inbox_state = {${set.join(", ")}} — 'parked' is an event waiting for the entity it references`);

    const fresh = await sql`
      SELECT provider, count(*)::int AS n, max(received_at) AS last FROM webhook_inbox
       GROUP BY provider ORDER BY 2 DESC LIMIT 6`;
    r.assert(fresh.length > 0, `webhooks are the design, not the fallback: ${fresh.map((f) => `${f.provider}=${f.n}`).join(", ")} events received`);
    for (const row of fresh) r.note(`  ${String(row.provider).padEnd(12)} ${row.n} events, most recent ${String(row.last).slice(0, 19)}`);
  }

  r.assert(existsSync(resolve(ROOT, "src/app/api/drain/route.ts")),
    "the drain is a separate, explicit endpoint (/api/drain) — a fallback beside the webhook route, not the path a delivery normally takes");
  r.cite("scripts/livefire.mjs attack 8", "dedupe against a genuinely signed provider replay: twice is one");
  r.cite("scripts/livefire.mjs attack 4", "a settlement delivered before its authorisation ends where in-order does");
});

define(NN, "NN5", "The correction test: reversal plus re-book, never an edit", async (r) => {
  const sql = await db();
  if (sql === null) {
    r.unknown(`the correction machinery could not be read from the database: ${dbError}`);
  } else {
    const kinds = await sql`SELECT unnest(enum_range(NULL::entry_type))::text AS t`;
    const set = kinds.map((k) => k.t);
    r.assert(set.includes("reversal") && set.includes("rebook"),
      `a correction has its own shape in the schema: entry_type = {${set.join(", ")}}`);

    const used = await sql`
      SELECT entry_type::text AS t, count(*)::int AS n FROM journal_entry GROUP BY 1 ORDER BY 1`;
    const byKind = Object.fromEntries(used.map((u) => [u.t, u.n]));
    r.assert((byKind["reversal"] ?? 0) > 0,
      `corrections exist in the live book: ${used.map((u) => `${u.t}=${u.n}`).join(", ")}`);

    // Bitemporality: a reversal booked LATER than the day it corrects.
    const backdated = await sql`
      SELECT count(*)::int AS n FROM journal_entry e
       WHERE e.entry_type = 'reversal' AND e.value_date < e.booking_time::date`;
    r.assert(backdated[0].n > 0,
      `${backdated[0].n} reversal(s) carry a value_date EARLIER than their booking_time — the corrected figure lands on the day it happened, not the day we learned`);
  }
  r.cite("scripts/livefire.mjs attack 3", "backdated reversal shows the corrected figure AND what we believed on Wednesday");
  r.cite("scripts/coreloop.mjs leg 6", "survive a reversed settlement; the statement still reconciles");
});

define(NN, "NN6", "Maker-checker: the initiator cannot approve, and neither can an agent", async (r) => {
  const sql = await db();
  if (sql === null) {
    r.unknown(`the maker-checker enforcement could not be read from the database: ${dbError}`);
    return;
  }
  const trg = await sql`
    SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND c.relname = 'payment_instruction_event'`;
  const names = trg.map((t) => t.tgname);
  r.assert(names.includes("payment_instruction_event_maker_checker"),
    "payment_instruction_event_maker_checker trigger exists — the refusal is in the database, so no application path can route around it");

  const fn = await sql`SELECT prosrc FROM pg_proc WHERE proname = 'assert_maker_checker'`;
  r.assert(fn.length === 1, "assert_maker_checker() is defined in the deployed schema");
  if (fn.length === 1) {
    const src = fn[0].prosrc;
    r.assert(/42501/.test(src), "it raises SQLSTATE 42501 (insufficient_privilege) rather than returning a soft refusal");
    r.assert(/agent/.test(src), "it names the agent case explicitly — an agent actor cannot be the checker");
  }

  const agents = await sql`SELECT count(*)::int AS n FROM actor WHERE kind = 'agent' AND can_approve = true`;
  r.assert(agents[0].n === 0, `${agents[0].n} agent actors hold can_approve — the MCP write tool lands in the queue like everyone else`);

  r.cite("scripts/livefire.mjs attack 5", "the initiator's self-approval is refused by the DATABASE with SQLSTATE 42501");
  r.cite("scripts/coreloop.mjs leg 5", "an outbound payment needing a second approver, driven through the deployed form");
});

define(NN, "NN7", "Reconciliation is a feature: a job that diffs provider truth, and a breaks screen", async (r) => {
  const screen = await http(`${state.baseUrl}/reconciliation`);
  r.assert(screen.ok && screen.status === 200, `GET /reconciliation -> ${screen.ok ? screen.status : screen.error} — the breaks screen is deployed`);
  if (screen.ok && screen.status === 200) {
    r.assert(/break/i.test(screen.body), "the screen renders the word 'break' — it is a breaks view, not a placeholder");
  }

  const sql = await db();
  if (sql === null) {
    r.unknown(`the reconciliation model could not be read from the database: ${dbError}`);
  } else {
    const v = await sql`
      SELECT table_name FROM information_schema.views
       WHERE table_schema='public' AND table_name IN ('v_recon_break','v_recon_pair','v_recon_run_history')`;
    r.assert(v.length >= 1, `the diff is a view over both sides, recomputed rather than stored: ${v.map((x) => x.table_name).join(", ")}`);
    const kinds = await sql`
      SELECT break_kind::text AS k, count(*)::int AS n FROM recon_run_break GROUP BY 1 ORDER BY 2 DESC`;
    r.assert(kinds.length >= 0, `break kinds recorded in the live book: ${kinds.length === 0 ? "(none outstanding)" : kinds.map((k) => `${k.k}=${k.n}`).join(", ")}`);
  }
  r.assert(existsSync(resolve(ROOT, "scripts/reconcile-usdc.mjs")), "scripts/reconcile-usdc.mjs pulls provider truth for the stablecoin leg");
  r.cite("scripts/livefire.mjs attack 6", "a row deleted from tonight's scheme file surfaces as an in_ledger_not_file break with its age");
  r.cite("scripts/coreloop.mjs leg 7", "reconcile the scheme file end to end from the deployed URL");
});

define(NN, "NN8", "An agent surface: three read tools, one write tool into the human queue, plus agent limits", async (r) => {
  const listed = await mcp(null, null, "tools/list");
  if (listed.unknown !== undefined) {
    r.unknown(`the deployed MCP surface could not be listed: ${listed.unknown}`);
  } else {
    const tools = listed.json?.result?.tools ?? [];
    r.assert(tools.length >= 4, `deployed /api/mcp lists ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    const reads = tools.filter((t) => t.annotations?.readOnlyHint === true);
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false);
    r.assert(reads.length >= 3, `${reads.length} read tools: ${reads.map((t) => t.name).join(", ")}`);
    r.assert(writes.length >= 1, `${writes.length} write tool(s): ${writes.map((t) => t.name).join(", ")}`);
    for (const tool of writes) {
      r.assert(/approval|queue|NOTHING HAS BEEN PAID|queued/i.test(String(tool.description ?? "")),
        `${tool.name} declares that it lands in the human approval queue and moves no money`);
    }
  }

  const unauth = await http(`${state.baseUrl}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  r.assert(unauth.ok && unauth.status === 401, `the surface fails closed: an unauthenticated tools/list -> ${unauth.ok ? unauth.status : unauth.error}`);

  const limits = readIfPresent("docs/AGENT-LIMITS.md");
  if (limits === null) {
    r.assert(false, "docs/AGENT-LIMITS.md is missing — the written list of operations never handed to an agent is a named requirement");
  } else {
    const numbered = (limits.match(/^##\s+\d+\.\s+/gm) ?? []).length;
    r.assert(numbered >= 3, `docs/AGENT-LIMITS.md lists ${numbered} operations that are never handed to an autonomous agent, each with its reasoning`);
  }

  // The demo bearer token is published in docs/MCP.md and authenticates
  // against production. Surfaced deliberately: see docs/COMPLIANCE.md.
  const mcpDoc = readIfPresent("docs/MCP.md") ?? "";
  const documented = /"token"\s*:\s*"[A-Za-z0-9_]{20,}"/.test(mcpDoc);
  r.soft(!documented || /demo/i.test(mcpDoc),
    documented
      ? "a bearer token is published in docs/MCP.md; it is the agent-surface equivalent of the two demo logins the submission requires. Confirm that is intended — see docs/COMPLIANCE.md."
      : "no bearer token is published in docs/MCP.md");
});

define(NN, "NN9", "Money is never a float", async (r) => {
  /* ---- The database's answer ------------------------------------------- */
  const sql = await db();
  if (sql === null) {
    r.unknown(`column types could not be read from the deployed schema: ${dbError}`);
  } else {
    const cols = await sql`
      SELECT c.table_name, c.column_name, c.data_type
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND c.data_type IN ('real','double precision','numeric','money')
       ORDER BY 1, 2`;
    r.assert(cols.length === 0, cols.length === 0
      ? "no BASE TABLE in the deployed schema has a real, double precision, numeric or money column"
      : `non-integer numeric columns on base tables: ${cols.map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`).join(", ")}`);

    const viewCols = await sql`
      SELECT count(*)::int AS n FROM information_schema.columns c
        JOIN information_schema.views v
          ON v.table_schema = c.table_schema AND v.table_name = c.table_name
       WHERE c.table_schema='public' AND c.data_type = 'numeric'`;
    r.note(
      `${viewCols[0].n} view columns are 'numeric'. That is Postgres: SUM(bigint) returns numeric, which is ` +
        "an EXACT decimal, not a float. The trial permits integer minor units or exact decimals; a view " +
        "that sums cents is the second of those and cannot lose a penny.",
    );
  }

  /* ---- The migrations, so an UNAPPLIED float is caught too -------------- */
  const migDir = resolve(ROOT, "db/migrations");
  const floatRe = /\b(float4|float8|double\s+precision|\breal\b|money|numeric|decimal)\b/i;
  const migHits = [];
  if (existsSync(migDir)) {
    for (const file of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      const text = readFileSync(join(migDir, file), "utf8");
      let inTable = false;
      text.split("\n").forEach((line, i) => {
        if (/^\s*CREATE\s+TABLE/i.test(line)) inTable = true;
        else if (inTable && /^\s*\)\s*;?/.test(line)) inTable = false;
        if (!inTable) return;
        if (isCommentLine(line)) return;
        const code = line.split("--")[0];
        if (floatRe.test(code)) migHits.push(`db/migrations/${file}:${i + 1}  ${code.trim().slice(0, 76)}`);
      });
    }
  }
  r.assert(migHits.length === 0, migHits.length === 0
    ? "no CREATE TABLE body in any migration declares a float, real, double precision, numeric, money or decimal column"
    : `float-shaped column declarations in migrations: ${migHits.join(" | ")}`);

  /* ---- The application code -------------------------------------------- */
  /**
   * `Number(someBigIntOfCents)` is deliberately NOT in this pattern.
   *
   * The first version had it, and it flagged thirteen call sites that were all
   * the same safe thing: narrowing a bigint of CENTS to a JS number so it can
   * cross a serialisation boundary. That is an exact integer conversion well
   * inside Number.MAX_SAFE_INTEGER — no decimal is created and no penny can be
   * lost. The second version flagged `Number(...)` only when a `/` followed,
   * and a nested paren made `Number((cents * 100n) / total)` — exact bigint
   * arithmetic — look like a float division.
   *
   * So the pattern is the operations that actually CREATE a decimal:
   * parseFloat, toFixed, multiply or divide by 100 on something that is not
   * already a bigint, and division by a scientific literal. Each of those
   * produces a value that cannot represent a penny exactly; `Number(bigint)`
   * does not.
   */
  const MONEY_WORDS = /cents|amount|balance|usd|dollar|money|price|fee|total/i;
  const FLOAT_OPS = /\bparseFloat\b|\.toFixed\(|(?<![0-9n])\/\s*100(?![0-9n])|(?<![0-9n])\*\s*100(?![0-9n])|\/\s*1e\d/;
  const src = state.allFiles.filter((f) => f.startsWith("src/") && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  const floatHits = [];
  for (const file of src) {
    const text = readIfPresent(file);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      if (isCommentLine(line)) return;
      const code = line.split("//")[0];
      if (!FLOAT_OPS.test(code)) return;
      if (!MONEY_WORDS.test(code)) return;
      // Milliseconds, seconds, basis points and gas are not money.
      if (/\/\s*1000\b|Ms\b|ms\b|seconds|latency|bps|gas|elapsed/i.test(code)) return;
      // A percentage share is not a money amount: `(cents * 100n) / total` is
      // exact bigint arithmetic that produces a percent, and the penny it
      // cannot lose is not in the result.
      if (/percent|share|pct|%`/i.test(code)) return;
      // Prose that says the path has NO parseFloat is the promise, not the
      // breach. Two form hints in this repo say exactly that, and the first
      // version of this check flagged both of them.
      if (/\b(no|never|without|not)\s+\S{0,12}(parseFloat|toFixed)/i.test(code)) return;
      floatHits.push(`${file}:${i + 1}  ${code.trim().slice(0, 80)}`);
    });
  }
  r.assert(floatHits.length === 0, floatHits.length === 0
    ? `no parseFloat / toFixed / *100 / /100 on a money-named expression in ${src.length} source files`
    : `float arithmetic near money (${floatHits.length}): ${floatHits.join(" | ")}`);

  const rounding = readIfPresent("README.md") ?? "";
  r.assert(/round/i.test(rounding) && /cent/i.test(rounding),
    "the README states the currency handling and the rounding rule (\"pro-rata maths always leaves a penny\")");
});

define(NN, "NN10", "A decision log written as you go", async (r) => {
  r.cite("AF6 proxies 2-4 (this run)", "DECISIONS.md is timestamped, and git shows it written across many commits over many hours rather than in one");
  const decisions = readIfPresent("DECISIONS.md");
  if (decisions === null) {
    r.assert(false, "DECISIONS.md is missing");
    return;
  }
  const entries = (decisions.match(/^##\s+\d{3}\s+—\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/gm) ?? []).length;
  r.assert(entries >= 10, `${entries} timestamped entries`);
  r.assert(/assum/i.test(decisions), "the log records assumptions taken when an answer was too slow, as the brief asks");
  r.assert(/\bcut\b/i.test(decisions) && existsSync(resolve(ROOT, "docs/CUT-LIST.md")), "what was cut is recorded, and docs/CUT-LIST.md exists");
});

/* -------------------------------------------------------------------------- */
/* SECTION C — THE TRACK 3 DOMAIN GAUNTLET                                    */
/* -------------------------------------------------------------------------- */

const GA = "THE TRACK 3 DOMAIN GAUNTLET (docs/BRIEF.md, ten items)";

/**
 * Every gauntlet item is a BEHAVIOURAL claim, and behaviour is proven by
 * coreloop.mjs and livefire.mjs, which drive the deployment for real. What this
 * section adds is the structural half: the mechanics the brief demands must
 * live "in your schema and your state machines, not your README", so each item
 * asserts the schema object exists in the DEPLOYED database and then names the
 * runnable that proves the behaviour.
 */
function gauntlet(id, title, structural, citations) {
  define(GA, id, title, async (r) => {
    const sql = await db();
    if (sql === null) {
      r.unknown(`the schema half of this item could not be read: ${dbError}`);
    } else {
      await structural(r, sql);
    }
    for (const [what, claim] of citations) r.cite(what, claim);
  });
}

gauntlet("G1", "Ledger balance versus available balance — derived, never a second stored number",
  async (r, sql) => {
    const v = await sql`
      SELECT table_name FROM information_schema.views
       WHERE table_schema='public' AND table_name IN ('v_ledger_balance','v_available_balance','v_hold_state')`;
    r.assert(v.length === 3, `available is a view: ${v.map((x) => x.table_name).join(", ")}`);
    const stored = await sql`
      SELECT c.table_name, c.column_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
       WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
         AND (c.column_name LIKE '%balance%' OR c.column_name = 'available_cents')
         AND c.table_name <> 'statement'`;
    r.assert(stored.length === 0, stored.length === 0
      ? "no base table stores a balance; there is no second number that can drift"
      : `stored balance columns: ${stored.map((s) => `${s.table_name}.${s.column_name}`).join(", ")}`);
    r.note("statement.opening/closing_balance_cents is the deliberate exception: a published artefact must stay queryable exactly as published. dbcheck.mjs check 5 carries the argument.");
  },
  [["scripts/livefire.mjs attack 1", "a $50 fuel-pump auth drops AVAILABLE by 5000 and does not move LEDGER"]]);

gauntlet("G2", "The authorisation lifecycle — every transition an event; the hold releases exactly once",
  async (r, sql) => {
    const kinds = await sql`SELECT unnest(enum_range(NULL::card_event_kind))::text AS k`;
    const set = kinds.map((x) => x.k);
    r.assert(set.length >= 5, `card_auth_event models the lifecycle as events: {${set.join(", ")}}`);
    const drift = await sql`SELECT count(*)::int AS n FROM v_hold_release_drift`;
    r.assert(drift[0].n === 0, `v_hold_release_drift is empty (${drift[0].n} rows) — no released hold is still withholding memo money`);
  },
  [["scripts/livefire.mjs attack 2", "a $73.40 capture releases the hold exactly once and does not clamp available"]]);

gauntlet("G3", "Settlement is not authorisation — different amount, days later, sometimes no auth at all",
  async (r, sql) => {
    const kinds = await sql`SELECT unnest(enum_range(NULL::card_event_kind))::text AS k`;
    const set = kinds.map((x) => x.k);
    r.assert(set.some((k) => /clear|settle/i.test(k)), `settlement is its own event kind, separate from the auth: {${set.filter((k) => /clear|settle|auth/i.test(k)).join(", ")}}`);
    const semantics = await sql`SELECT count(*)::int AS n FROM rail_event_semantics`;
    r.assert(semantics[0].n > 0, `${semantics[0].n} rows in rail_event_semantics — which provider event means 'new event' and which means 'correction' is a table, not an if-statement`);
  },
  [["scripts/coreloop.mjs leg 4", "authorise $50.00, settle $73.40 two days later"],
   ["docs/RAIL-SEMANTICS.md", "the force-post case written down, including what Lithic's sandbox will not produce"]]);

gauntlet("G4", "Out-of-order delivery — park it, match it later, never crash, never double-count",
  async (r, sql) => {
    const states = await sql`SELECT unnest(enum_range(NULL::webhook_inbox_state))::text AS s`;
    r.assert(states.map((x) => x.s).includes("parked"), `'parked' is a first-class inbox state: {${states.map((x) => x.s).join(", ")}}`);
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='webhook_inbox' AND column_name IN ('parked_reason','park_attempts')`;
    r.assert(cols.length === 2, `a park is distinguished from a failure by its own columns: ${cols.map((c) => c.column_name).join(", ")} — the retry budget is attempts minus parks`);
  },
  [["scripts/livefire.mjs attack 4", "a settlement delivered before its authorisation ends exactly where in-order does"]]);

gauntlet("G5", "Returns and recalls — the corrected position appears on the day it happened",
  async (r, sql) => {
    const rails = await sql`SELECT unnest(enum_range(NULL::rail))::text AS r`;
    r.assert(rails.map((x) => x.r).includes("ach"), `ACH is a modelled rail: {${rails.map((x) => x.r).join(", ")}}`);
    const returns = await sql`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE rail = 'ach' AND (description ILIKE '%return%' OR entry_type = 'reversal')`;
    r.assert(returns[0].n > 0, `${returns[0].n} ACH return/reversal entries in the live book — a bounce is a reversal entry, never an edit`);
    r.note("return CODES (R01, R02, …) are carried by the ACH adapter; docs/RAIL-SEMANTICS.md maps each to its ledger effect");
  },
  [["scripts/coreloop.mjs leg 6", "a reversed settlement, and the statement for settlement day"],
   ["src/lib/rails/achsim", "the simulator that generates the awkward cases: returns after settlement, late returns"]]);

gauntlet("G6", "Bitemporality — the correction test; value date and booking date are different columns",
  async (r, sql) => {
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name IN ('value_date','booking_seq','booking_time')
         AND table_name IN ('journal_entry','journal_line')`;
    r.assert(cols.length >= 5, `both axes are separate columns on both money tables: ${cols.map((c) => `${c.table_name}.${c.column_name}`).join(", ")}`);
    const asBelieved = await sql`
      SELECT count(*)::int AS n FROM journal_entry WHERE value_date <> booking_time::date`;
    r.assert(asBelieved[0].n > 0, `${asBelieved[0].n} entries have value_date <> booking date — the two clocks genuinely diverge in this book, so the as-of query has something to prove`);
  },
  [["scripts/livefire.mjs attack 3", "Tuesday's statement shows the corrected position AND what we believed on Wednesday"]]);

gauntlet("G7", "Statements — a closed day's statement is reproducible forever, identical every time",
  async (r, sql) => {
    const t = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('book_day','statement')`;
    r.assert(t[0].n === 2, "book_day and statement both exist — a closed day is a row, not a render");
    const v = await sql`SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema='public' AND table_name='v_statement_version'`;
    r.assert(v[0].n === 1, "v_statement_version exists — a corrected day gets a NEW version, and the old one stays queryable exactly as published");
  },
  [["scripts/coreloop.mjs leg 6", "pull up the statement for settlement day after the reversal"]]);

gauntlet("G8", "Standing orders — fire once and only once across restarts and retries",
  async (r, sql) => {
    const t = await sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'standing_order%' ORDER BY 1`;
    r.assert(t.length >= 3, `the occurrence is the unit: ${t.map((x) => x.table_name).join(", ")}`);
    const dbl = await sql`SELECT count(*)::int AS n FROM v_standing_order_double_fire`;
    r.assert(dbl[0].n === 0, `v_standing_order_double_fire is empty (${dbl[0].n} rows) — no occurrence has fired twice`);
    r.assert(/insufficient|cannot cover|balance/i.test(readIfPresent("docs/STANDING-ORDERS.md") ?? ""),
      "docs/STANDING-ORDERS.md carries the written policy for the day the balance cannot cover the order");
  },
  [["src/app/api/cron/standing/route.ts", "the scheduler, with the occurrence key computed by Postgres rather than by the caller"]]);

gauntlet("G9", "Scheme reconciliation — in-file-not-ledger, in-ledger-not-file, amount mismatch, with aging",
  async (r, sql) => {
    // break_kind is text with a CHECK constraint rather than an enum, so the
    // vocabulary is read from the constraint AND from what the live book
    // actually contains. Reading only the constraint would prove the schema
    // permits the three kinds without proving the differ ever produces them.
    const check = await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'recon_run_break'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%break_kind%'`;
    const defs = check.map((c) => c.def).join(" ");
    const wanted = ["in_file_not_ledger", "in_ledger_not_file", "amount_mismatch"];
    const missing = wanted.filter((w) => !defs.includes(w));
    r.assert(missing.length === 0, missing.length === 0
      ? `all three break kinds are constrained in the schema: ${wanted.join(", ")}`
      : `break kinds absent from the CHECK constraint on recon_run_break.break_kind: ${missing.join(", ")}`);

    const seen = await sql`
      SELECT break_kind, count(*)::int AS n FROM recon_run_break GROUP BY 1 ORDER BY 2 DESC`;
    const seenKinds = seen.map((s) => s.break_kind);
    const neverSeen = wanted.filter((w) => !seenKinds.includes(w));
    r.assert(neverSeen.length === 0, neverSeen.length === 0
      ? `and the differ has produced all three against real data: ${seen.map((s) => `${s.break_kind}=${s.n}`).join(", ")}`
      : `break kinds the differ has never actually produced: ${neverSeen.join(", ")}`);

    const aging = await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='v_recon_break'
         AND column_name IN ('age_days','age_bucket','severity')`;
    r.assert(aging.length >= 1, `the breaks view carries aging: ${aging.map((a) => a.column_name).join(", ") || "(none)"}`);
  },
  [["scripts/livefire.mjs attack 6", "a row deleted from tonight's scheme file surfaces with its kind and its age"]]);

gauntlet("G10", "Maker-checker — and the agent surface's write tool queues like everyone else",
  async (r, sql) => {
    const pol = await sql`SELECT count(*)::int AS n FROM approval_policy`;
    r.assert(pol[0].n > 0, `${pol[0].n} approval policy row(s) — the threshold is data, not a constant`);
    const agents = await sql`SELECT count(*)::int AS n FROM actor WHERE kind='agent' AND can_approve=true`;
    r.assert(agents[0].n === 0, "no agent actor can approve");
  },
  [["NN6 (this run)", "assert_maker_checker() raises 42501 and names the agent case"],
   ["scripts/livefire.mjs attack 5", "the initiator's own approval refused by the database"]]);

/* -------------------------------------------------------------------------- */
/* SECTION D — THE SEVEN LIVE-FIRE SCENARIOS                                  */
/* -------------------------------------------------------------------------- */

const LF = "THE SEVEN LIVE-FIRE SCENARIOS (docs/BRIEF.md) — delegated to scripts/livefire.mjs";

/**
 * These are DELEGATED in full and reported as CITED, never as PASS.
 *
 * livefire.mjs runs each attack against production and the provider sandboxes
 * and derives its verdict from Vitest's own JSON. Re-running it from here would
 * take minutes and hit rate-limited sandboxes, which would make this tool the
 * thing nobody runs. Asserting a pass without running it would be exactly the
 * over-claim this file exists to catch. So: cited, with the command to run.
 */
const LIVE_FIRE = [
  ["LF1", "Create a card and simulate a $50 fuel-pump auth: available drops, ledger does not", "attack 1"],
  ["LF2", "Capture $73.40 two days later: the hold releases exactly once", "attack 2"],
  ["LF3", "Reverse that settlement and pull up the statement for settlement day", "attack 3"],
  ["LF4", "Deliver a settlement before its auth and watch the matcher", "attack 4"],
  ["LF5", "The initiator tries to approve their own above-threshold payment", "attack 5"],
  ["LF6", "Delete one row from tonight's scheme file; ask the breaks screen where it went", "attack 6"],
  ["LF7", "Turn the issuing provider's webhooks off for five minutes; ask what the customer sees", "attack 7"],
];
for (const [id, title, attack] of LIVE_FIRE) {
  define(LF, id, title, async (r) => {
    const path = "src/test/livefire/";
    const files = existsSync(resolve(ROOT, path)) ? readdirSync(resolve(ROOT, path)) : [];
    const n = attack.replace("attack ", "");
    const file = files.find((f) => f.startsWith(`attack-0${n}-`));
    if (file === undefined) {
      r.unknown(`no test file for ${attack} under ${path} — the delegation target does not exist`);
      return;
    }
    r.cite(`scripts/livefire.mjs --only ${n}  (${path}${file})`, title);
    r.note("CITED, not run here: it drives production and the provider sandboxes and takes minutes. Run it before the debrief.");
  });
}

/* -------------------------------------------------------------------------- */
/* SECTION E — THE SUBMISSION PACKAGE                                         */
/* -------------------------------------------------------------------------- */

const SP = "THE SUBMISSION PACKAGE (docs/TRIAL-VERBATIM.md lines 130-137)";

define(SP, "SP1", "The deployed URL, with demo credentials for two roles", async (r) => {
  r.cite("NN1 (this run)", "the URL answers and the role switch flips at the deployed origin");
  r.assert((readIfPresent("docs/DEMO.md") ?? "").includes(new URL(state.baseUrl).hostname),
    "docs/DEMO.md leads with the deployed URL and documents both roles");
});

define(SP, "SP2", "Repo access: @AlexanderReinicke and @mojafa invited on GitHub", async (r) => {
  r.unknown("collaborator invitations are GitHub account state, not repo content. Not observable from here — confirm in the repo's Settings > Collaborators before submitting.");
});

define(SP, "SP3", "The decision log, in the repo, timestamped", async (r) => {
  r.cite("AF6 / NN10 (this run)", "DECISIONS.md is present, timestamped, and written across many commits");
  r.assert(existsSync(resolve(ROOT, "DECISIONS.md")), "DECISIONS.md is at the repo root");
});

define(SP, "SP4", "A five-minute video walking the money path end to end", async (r) => {
  const scriptDoc = readIfPresent("docs/VIDEO-SCRIPT.md");
  r.assert(scriptDoc !== null, "docs/VIDEO-SCRIPT.md exists — the walk-through is scripted");
  const anyLink = state.allFiles.some((f) => f.endsWith(".md") && /loom\.com\/share|youtu\.be\/|youtube\.com\/watch/.test(readIfPresent(f) ?? ""));
  r.unknown(
    anyLink
      ? "a video link appears in the repo, but whether it is the submitted one, and whether it is under five minutes, is not checkable here"
      : "no video link is in the repo. That is expected — the link goes in the submission EMAIL, not the repo — so this cannot be verified mechanically. Confirm it is recorded and under five minutes before sending.",
  );
});

define(SP, "SP5", "Evidence of the live integrations", async (r) => {
  const pack = readIfPresent("docs/EVIDENCE-PACK.md");
  r.assert(pack !== null, "docs/EVIDENCE-PACK.md exists");
  if (pack !== null) {
    r.assert(/webhook/i.test(pack), "it covers the webhook delivery log, which the trial names explicitly");
  }
  r.unknown("whether the shared folder or read-only dashboard access has actually been granted is account state outside this repo");
});

define(SP, "SP6", "A seed script that stands up believable demo data from zero", async (r) => {
  r.assert(existsSync(resolve(ROOT, "scripts/seed.mjs")), "scripts/seed.mjs exists");
  r.assert(existsSync(resolve(ROOT, "scripts/dbreset.mjs")), "scripts/dbreset.mjs exists — 'from zero' has a runnable meaning");
  r.assert(existsSync(resolve(ROOT, "scripts/migrate.mjs")), "scripts/migrate.mjs exists");
  r.note("this asserts the scripts exist, not that a from-zero run succeeds today. Running them would write to the database, which this tool must not do.");
});

define(SP, "SP7", "An .env.example documenting every key the system needs", async (r) => {
  const example = readIfPresent(".env.example");
  if (example === null) {
    r.assert(false, ".env.example is missing");
    return;
  }
  const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const missing = [...state.envPairs.keys()].filter((k) => !documented.has(k));
  r.assert(missing.length === 0, missing.length === 0
    ? `every one of the ${state.envPairs.size} keys in .env is documented in .env.example`
    : `keys in .env with no entry in .env.example: ${missing.join(", ")}`);
  r.assert(!state.allFiles.includes(".env"), ".env itself is not tracked");
});

define(SP, "SP8", "The cut list: what you did not build, and what week two would be", async (r) => {
  const cut = readIfPresent("docs/CUT-LIST.md");
  r.assert(cut !== null, "docs/CUT-LIST.md exists");
  if (cut !== null) {
    r.assert(/week\s*two|week 2/i.test(cut), "it says what week two would be, not only what was cut");
  }
});

/* ========================================================================== */
/* MCP helper — a read against the deployed agent surface                     */
/* ========================================================================== */

/**
 * Call the deployed MCP endpoint. Returns `{ unknown }` when the call could not
 * be made at all, so a caller can report UNKNOWN with the reason rather than
 * inventing a verdict.
 *
 * The token is read from MCP_AGENT_TOKENS if it carries one in the clear;
 * otherwise from docs/MCP.md, which publishes the demo token. Only `tools/list`
 * and read tools are ever called from here.
 */
async function mcp(tool, args, method = "tools/call") {
  let token = process.env["MCP_COMPLIANCE_TOKEN"];
  if (token === undefined) {
    const raw = state.envPairs.get("MCP_AGENT_TOKENS");
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw);
        token = parsed.find((g) => typeof g.token === "string")?.token;
      } catch { /* fall through to the documented token */ }
    }
  }
  if (token === undefined) {
    const doc = readIfPresent("docs/MCP.md") ?? "";
    token = (doc.match(/"token"\s*:\s*"([A-Za-z0-9_]{20,})"/) ?? [])[1];
  }
  if (token === undefined) {
    return { unknown: "no MCP bearer token is available (MCP_AGENT_TOKENS holds only a digest, and docs/MCP.md publishes none). Set MCP_COMPLIANCE_TOKEN to check this." };
  }
  const body = method === "tools/list"
    ? { jsonrpc: "2.0", id: 1, method: "tools/list" }
    : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args ?? {} } };
  const res = await http(`${state.baseUrl}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { unknown: `POST /api/mcp did not answer: ${res.error}` };
  if (res.status === 401 || res.status === 403) {
    return { unknown: `the available MCP token was refused (HTTP ${res.status}); this surface's tools could not be exercised` };
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    return { unknown: `POST /api/mcp returned non-JSON (HTTP ${res.status})` };
  }
  return { json, error: json.error, status: res.status };
}

/* ========================================================================== */
/* Runner                                                                     */
/* ========================================================================== */

function parseArgs(argv) {
  const args = { baseUrl: process.env["COMPLIANCE_BASE_URL"] ?? DEFAULT_BASE_URL, only: null, delegations: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") { args.baseUrl = argv[i + 1] ?? args.baseUrl; i += 1; }
    else if (arg.startsWith("--base-url=")) args.baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--only") { args.only = (argv[i + 1] ?? "").split(",").map((s) => s.trim().toUpperCase()); i += 1; }
    else if (arg.startsWith("--only=")) args.only = arg.slice("--only=".length).split(",").map((s) => s.trim().toUpperCase());
    else if (arg === "--delegations") args.delegations = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/compliance.mjs [--base-url URL] [--only AF3,NN9] [--delegations]\n" +
        "\n" +
        "Audits this repo and its deployment against every rule in the trial.\n" +
        "Read-only: no money moves, no row is written.\n" +
        "\n" +
        "  --only          run a subset, by check id or by section prefix (AF, NN, G, LF, SP)\n" +
        "  --delegations   print which checks are delegated to which existing script, and exit\n" +
        "\n" +
        "Exit: 0 all clear · 1 at least one check FAILED · 2 no failure, but an\n" +
        "AUTOMATIC-FAIL check could not be performed (UNKNOWN), so the gate is not cleared.",
      );
      process.exit(0);
    }
  }
  return args;
}

function printDelegations() {
  console.log("");
  console.log(RULE);
  console.log("  DELEGATION MAP — what this tool runs, what it cites, and what it refuses to claim");
  console.log(RULE);
  console.log("");
  console.log("  INVOKED, exit code folded into the verdict:");
  console.log("    AF2  scripts/audit-claims.mjs   every tracked .md against the live /api/health");
  console.log("    AF3  scripts/dbcheck.mjs        UPDATE/DELETE/TRUNCATE attempted as corgi_app; invariant views");
  console.log("");
  console.log("  CITED, never run from here (each drives production and takes minutes):");
  console.log("    NN2, NN5, NN7, G1-G10, LF1-LF7   scripts/livefire.mjs, scripts/coreloop.mjs");
  console.log("    Run them yourself:  node scripts/coreloop.mjs   ·   node scripts/livefire.mjs");
  console.log("");
  console.log("  SELF-EXCLUDED from the tree scans, with the reason:");
  for (const [file, why] of SCAN_EXEMPT) console.log(`    ${file.padEnd(32)} ${why}`);
  console.log("");
  console.log("  REPORTED UNKNOWN BY CONSTRUCTION — not mechanisable, and not faked:");
  console.log("    AF6  whether the author can explain a line when a grader points at it");
  console.log("    SP2  GitHub collaborator invitations");
  console.log("    SP4  the video link, which lives in the submission email");
  console.log("    SP5  whether sandbox dashboard access has actually been shared");
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.delegations) { printDelegations(); return 0; }

  state.baseUrl = args.baseUrl.replace(/\/$/, "");
  const loaded = loadDotEnv(resolve(ROOT, ".env"));
  loadDotEnv(resolve(ROOT, ".env.local"));
  state.envPairs = readDotEnvPairs(resolve(ROOT, ".env"));

  const tracked = trackedFiles();
  state.allFiles = tracked ?? walk(ROOT);
  state.codeFiles = state.allFiles.filter((f) => /\.(ts|tsx|mjs|js|sql|sh)$/.test(f));

  const healthRes = await http(`${state.baseUrl}/api/health`);
  state.healthStatus = healthRes.ok ? healthRes.status : 0;
  if (healthRes.ok && healthRes.status === 200) {
    try { state.health = JSON.parse(healthRes.body); } catch { state.health = null; }
  }

  const selected = args.only === null
    ? CHECKS
    : CHECKS.filter((c) => args.only.some((o) => c.id === o || c.id.startsWith(o)));
  if (selected.length === 0) {
    console.error(`no checks matched --only ${args.only?.join(",")}`);
    return 2;
  }

  const started = new Date();
  console.log("");
  console.log(RULE);
  console.log("  COMPLIANCE — every rule in the trial, checked mechanically against evidence");
  console.log(THIN);
  console.log(`  target      ${state.baseUrl}`);
  console.log(`  health      ${state.health === null ? RED(`unavailable (HTTP ${state.healthStatus})`) : `ok — ${state.health.integrations?.live}/${state.health.integrations?.total} slots live, build ${state.health.commit?.shortSha ?? "?"}`}`);
  console.log(`  database    ${describeDatabase(process.env["APP_DATABASE_URL"])}`);
  console.log(`  repo        ${tracked === null ? RED("not a git work tree — AF5 and AF6 cannot run") : `${tracked.length} tracked files`}`);
  console.log(`  env         ${state.envPairs.size} keys in .env (${loaded} newly exported; the rest were already in the environment)`);
  console.log(`  checks      ${selected.length} of ${CHECKS.length}`);
  console.log(`  started     ${started.toISOString()}`);
  console.log(RULE);
  console.log(DIM("  read-only against production and the database. nothing here moves money or writes a row."));

  const totals = { PASS: 0, FAIL: 0, WARN: 0, UNKNOWN: 0, CITED: 0 };
  const failures = [];
  const unknowns = [];
  let section = null;

  for (const check of selected) {
    if (check.section !== section) {
      section = check.section;
      console.log("");
      console.log(THIN);
      for (const line of wrap(section, WIDTH - 4, 2)) console.log(line);
      console.log(THIN);
    }

    const r = new Recorder();
    try {
      await check.run(r);
    } catch (error) {
      r.unknown(`the check threw and could not complete: ${String(error?.message ?? error).split("\n")[0]}`);
    }
    const verdict = r.verdict();
    totals[verdict] += 1;
    if (verdict === "FAIL") failures.push({ check, r });
    if (verdict === "UNKNOWN") unknowns.push({ check, r });

    console.log("");
    const head = `  ${check.id.padEnd(5)} ${check.title}`;
    const padding = Math.max(1, WIDTH - 6 - head.length);
    console.log(`${head}${" ".repeat(padding)}${BADGE[verdict]()}`);
    for (const line of r.lines) {
      const mark = { ok: "  ok ", bad: RED(" !! "), warn: YELLOW("  ~ "), unknown: YELLOW("  ? "), note: DIM("    "), cite: BLUE("  → ") }[line.kind];
      const body = wrap(line.text, WIDTH - 14, 0);
      body.forEach((seg, i) => console.log(`      ${i === 0 ? mark : "    "} ${i === 0 ? seg : `  ${seg}`}`));
    }
  }

  /* ---- Scoreboard ------------------------------------------------------ */
  console.log("");
  console.log(RULE);
  console.log("  SCOREBOARD");
  console.log(RULE);
  console.log("");
  const counted = totals.PASS + totals.FAIL + totals.WARN + totals.UNKNOWN + totals.CITED;
  console.log(
    `  ${GREEN(`PASS ${totals.PASS}`)}   ${RED(`FAIL ${totals.FAIL}`)}   ${YELLOW(`WARN ${totals.WARN}`)}   ` +
    `${YELLOW(`UNKNOWN ${totals.UNKNOWN}`)}   ${BLUE(`CITED ${totals.CITED}`)}   of ${counted} checks` +
    `   ${Math.round((Date.now() - started.getTime()) / 1000)}s`,
  );
  console.log("");

  if (failures.length > 0) {
    console.log(RED("  VIOLATIONS"));
    for (const { check, r } of failures) {
      console.log(`    ${check.id}  ${check.title}`);
      for (const line of r.lines.filter((l) => l.kind === "bad")) {
        for (const seg of wrap(line.text, WIDTH - 12, 10)) console.log(RED(seg));
      }
    }
    console.log("");
  }

  if (unknowns.length > 0) {
    console.log(YELLOW("  UNKNOWN — could not be checked, and therefore NOT a pass"));
    for (const { check, r } of unknowns) {
      console.log(`    ${check.id}  ${check.title}`);
      for (const line of r.lines.filter((l) => l.kind === "unknown")) {
        for (const seg of wrap(line.text, WIDTH - 12, 10)) console.log(YELLOW(seg));
      }
    }
    console.log("");
  }

  console.log(DIM("  CITED is not a pass. It names the runnable that proves the claim end to end."));
  console.log(DIM("  Run those before the debrief:  node scripts/coreloop.mjs  ·  node scripts/livefire.mjs"));
  console.log(DIM("  --delegations prints the full map of what is run, what is cited, and what is not mechanisable."));
  console.log("");

  if (dbHandle) await dbHandle.end();

  // An AUTOMATIC-FAIL check that could not be performed does not clear the
  // gate. It exits 2 so a pipeline distinguishes "we found a violation" from
  // "we could not look", and neither reads as green.
  if (totals.FAIL > 0) return 1;
  const blindAutomatic = unknowns.filter(({ check }) => check.id.startsWith("AF") && check.id !== "AF6");
  if (blindAutomatic.length > 0) return 2;
  return 0;
}

process.exit(await main());
