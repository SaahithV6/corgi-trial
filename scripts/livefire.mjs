#!/usr/bin/env node
/**
 * LIVE FIRE — run the seven published attacks (plus the replay claim) against
 * PRODUCTION, and print a scoreboard.
 *
 *   node scripts/livefire.mjs
 *   node scripts/livefire.mjs --base-url https://corgi-trial-psi.vercel.app
 *   node scripts/livefire.mjs --only 3,5,6        # a subset, by attack number
 *
 * This is the thing that gets run in front of the panel, so two rules govern
 * every line of it:
 *
 *   1. IT MUST NEVER OVERSTATE A PASS. The status printed for an attack is not
 *      something a test asserts about itself — it is derived from Vitest's own
 *      JSON result. A test that cannot prove its claim skips, and a skip is
 *      printed as SKIP with the reason, never folded into the pass count.
 *   2. IT MUST BE READABLE AT A GLANCE. One line per attack with the verdict in
 *      a fixed column, the evidence indented underneath, and a total at the
 *      bottom that adds up.
 *
 * Everything it runs hits the live Neon database, the live provider sandboxes
 * and the deployed URL. There are no mocks in the suite; that is the point of
 * it. Money tables are append-only, so nothing is torn down: each run isolates
 * itself with its own synthetic references and asserts by those references.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://corgi-trial-psi.vercel.app";

/* -------------------------------------------------------------------------- */
/* The attack list. Numbers and titles are the published ones.                */
/* -------------------------------------------------------------------------- */

const ATTACKS = [
  {
    n: 1,
    file: "attack-01-fuel-pump-authorisation.test.ts",
    title: "$50 fuel-pump auth: AVAILABLE drops 5000, LEDGER does not move",
  },
  {
    n: 2,
    file: "attack-02-over-capture-release.test.ts",
    title: "$73.40 capture: hold released exactly once, available not clamped",
  },
  {
    n: 3,
    file: "attack-03-bitemporal-correction.test.ts",
    title: "Backdated reversal: corrected figure AND as-believed, both at once",
  },
  {
    n: 4,
    file: "attack-04-settlement-before-authorisation.test.ts",
    title: "Settlement before its authorisation ends exactly where in-order does",
  },
  {
    n: 5,
    file: "attack-05-maker-checker.test.ts",
    title: "Self-approval refused by the DATABASE (SQLSTATE 42501)",
  },
  {
    n: 6,
    file: "attack-06-planted-break.test.ts",
    title: "Row deleted from tonight's scheme file -> in_ledger_not_file break",
  },
  {
    n: 7,
    file: "attack-07-provider-outage.test.ts",
    title: "Issuing-provider webhook outage degrades visibly, invents no money",
  },
  {
    n: 8,
    file: "attack-08-real-provider-replay.test.ts",
    title: "Dedupe against a genuinely signed provider replay: twice is one",
  },
];

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { baseUrl: process.env.LIVEFIRE_BASE_URL ?? DEFAULT_BASE_URL, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") {
      args.baseUrl = argv[i + 1] ?? args.baseUrl;
      i += 1;
    } else if (arg.startsWith("--base-url=")) {
      args.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--only") {
      args.only = (argv[i + 1] ?? "").split(",").map((n) => Number(n.trim()));
      i += 1;
    } else if (arg.startsWith("--only=")) {
      args.only = arg.slice("--only=".length).split(",").map((n) => Number(n.trim()));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/livefire.mjs [--base-url URL] [--only 1,2,3]\n" +
          "Runs the published live-fire attacks against PRODUCTION and prints a scoreboard.",
      );
      process.exit(0);
    }
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Load `.env` without clobbering anything already exported.
 *
 * The suite needs real credentials — that is what makes it live fire — and the
 * repo keeps them in `.env`, which is gitignored. Values already present in the
 * environment win, so `APP_DATABASE_URL=... node scripts/livefire.mjs` behaves
 * the way anyone would expect.
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
    // An empty value means "absent" everywhere else in this codebase
    // (env.schema.ts strips blanks before validation); keep that true here.
    if (value === "") continue;
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
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

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const WIDTH = 84;
const RULE = "=".repeat(WIDTH);
const THIN = "-".repeat(WIDTH);

const COLOUR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text);
const GREEN = (t) => paint("32;1", t);
const RED = (t) => paint("31;1", t);
const YELLOW = (t) => paint("33;1", t);
const DIM = (t) => paint("2", t);

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

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const args = parseArgs(process.argv.slice(2));

const loaded = loadDotEnv(resolve(ROOT, ".env"));
loadDotEnv(resolve(ROOT, ".env.local"));

const selected = args.only === null ? ATTACKS : ATTACKS.filter((a) => args.only.includes(a.n));
if (selected.length === 0) {
  console.error("no attacks selected");
  process.exit(2);
}

// NOT `.next/`. A concurrent `next build` in this repo removes that directory
// wholesale, and a run of this suite has already lost its evidence file
// mid-flight to exactly that: the file vanished under an open handle, every
// `record()` after it threw ENOENT, and an attack whose assertions had all
// passed was reported as a failure with a filesystem error for a reason.
// `node_modules/.cache` is gitignored, is owned by nothing that wipes it on a
// build, and is where a tool's scratch space belongs.
const tmpDir = resolve(ROOT, "node_modules", ".cache", "livefire");
mkdirSync(tmpDir, { recursive: true });
const evidencePath = resolve(tmpDir, "evidence.jsonl");
const resultPath = resolve(tmpDir, "vitest.json");
rmSync(evidencePath, { force: true });
rmSync(resultPath, { force: true });
writeFileSync(evidencePath, "", "utf8");

const startedAt = new Date();

console.log("");
console.log(RULE);
console.log("  LIVE FIRE — the seven published attacks, and the replay claim");
console.log(THIN);
console.log(`  target     ${args.baseUrl}`);
console.log(`  database   ${describeDatabase(process.env.APP_DATABASE_URL)}`);
console.log(`  providers  Lithic sandbox ${process.env.LITHIC_API_KEY ? "LIVE" : "no key"}` +
  ` · Increase sandbox ${process.env.INCREASE_API_KEY ? "LIVE" : "no key"}`);
console.log(`  env        ${loaded} values read from .env`);
console.log(`  started    ${startedAt.toISOString()}`);
console.log(RULE);
console.log("");
console.log(DIM("  running against live systems; nothing here is mocked. this takes a few minutes."));
console.log("");

const vitest = resolve(ROOT, "node_modules", ".bin", "vitest");
const targets = selected.map((a) => `src/test/livefire/${a.file}`);

const child = spawnSync(
  vitest,
  [
    "run",
    ...targets,
    "--reporter=json",
    `--outputFile=${resultPath}`,
    // Serial: the provider sandboxes rate-limit simulate writes to 1 RPS
    // (DECISIONS 005) and a scoreboard people read in order should be produced
    // in order.
    "--no-file-parallelism",
    // These tests poll live systems. Vitest's 5s default would fail them for
    // being honest about how long a real webhook takes to arrive.
    "--testTimeout=240000",
    "--hookTimeout=120000",
  ],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      LIVEFIRE: "1",
      LIVEFIRE_BASE_URL: args.baseUrl,
      LIVEFIRE_EVIDENCE: evidencePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  },
);

const finishedAt = new Date();
const durationSeconds = Math.round((finishedAt - startedAt) / 1000);

/* -------------------------------------------------------------------------- */
/* Collect                                                                    */
/* -------------------------------------------------------------------------- */

/** Vitest's own verdict per file. Nothing here is self-reported by a test. */
function readVitestResults() {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return null;
  }
}

function readEvidence() {
  const byAttack = new Map();
  if (!existsSync(evidencePath)) return byAttack;
  for (const line of readFileSync(evidencePath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const bucket = byAttack.get(entry.attack) ?? { evidence: [], skip: [] };
    if (entry.kind === "skip") bucket.skip.push(entry.text);
    else bucket.evidence.push(entry.text);
    byAttack.set(entry.attack, bucket);
  }
  return byAttack;
}

const results = readVitestResults();
const evidence = readEvidence();

/**
 * PASS only when Vitest ran at least one assertion for the file and every one
 * of them passed. Any failure is FAIL. Anything else — a skipped test, a file
 * that never ran, a suite that could not be collected — is SKIP or FAIL, never
 * a pass. There is deliberately no branch that turns "no result" into a pass.
 */
function verdictFor(attack) {
  if (results === null) {
    return { status: "FAIL", detail: "vitest produced no JSON result" };
  }
  const fileResult = (results.testResults ?? []).find((r) =>
    String(r.name ?? "").replace(/\\/g, "/").endsWith(`src/test/livefire/${attack.file}`),
  );
  if (fileResult === undefined) {
    return { status: "SKIP", detail: "not run in this invocation" };
  }
  const assertions = fileResult.assertionResults ?? [];
  const failed = assertions.filter((a) => a.status === "failed");
  const passed = assertions.filter((a) => a.status === "passed");
  const skipped = assertions.filter((a) => a.status !== "passed" && a.status !== "failed");

  if (String(fileResult.status) === "failed" && failed.length === 0 && assertions.length === 0) {
    return { status: "FAIL", detail: fileResult.message ?? "the test file failed to run" };
  }
  if (failed.length > 0) {
    const first = failed[0];
    const message = String((first.failureMessages ?? [])[0] ?? "").split("\n")[0];
    return {
      status: "FAIL",
      detail: `${failed.length}/${assertions.length} assertions failed — "${first.title}": ${message}`,
      counts: { passed: passed.length, failed: failed.length, skipped: skipped.length },
    };
  }
  if (skipped.length > 0 || passed.length === 0) {
    return {
      status: "SKIP",
      detail: `${passed.length} passed, ${skipped.length} skipped — the attack is NOT proven`,
      counts: { passed: passed.length, failed: 0, skipped: skipped.length },
    };
  }
  return {
    status: "PASS",
    detail: `${passed.length}/${passed.length} assertions`,
    counts: { passed: passed.length, failed: 0, skipped: 0 },
  };
}

/* -------------------------------------------------------------------------- */
/* Scoreboard                                                                 */
/* -------------------------------------------------------------------------- */

console.log("");
console.log(RULE);
console.log("  SCOREBOARD");
console.log(RULE);
console.log("");

const totals = { PASS: 0, FAIL: 0, SKIP: 0 };

for (const attack of selected) {
  const verdict = verdictFor(attack);
  totals[verdict.status] += 1;

  const badge =
    verdict.status === "PASS" ? GREEN("PASS") : verdict.status === "FAIL" ? RED("FAIL") : YELLOW("SKIP");
  const head = `  ${String(attack.n).padStart(2)}  ${attack.title}`;
  const padding = Math.max(1, WIDTH - 6 - head.length);
  console.log(`${head}${" ".repeat(padding)}${badge}`);
  console.log(DIM(`      ${verdict.detail}`));

  const bucket = evidence.get(attack.n);
  if (verdict.status === "SKIP") {
    const reasons = bucket?.skip ?? [];
    if (reasons.length === 0) {
      console.log(YELLOW(`      waiting on: (no reason recorded — investigate)`));
    }
    for (const reason of reasons) {
      for (const line of wrap(`waiting on: ${reason}`, WIDTH - 10, 6)) console.log(YELLOW(line));
    }
  }
  for (const item of bucket?.evidence ?? []) {
    for (const line of wrap(`evidence: ${item}`, WIDTH - 10, 6)) console.log(line);
  }
  console.log("");
}

console.log(RULE);
const summary =
  `  ${GREEN(`PASS ${totals.PASS}`)}    ${RED(`FAIL ${totals.FAIL}`)}    ` +
  `${YELLOW(`SKIP ${totals.SKIP}`)}    of ${selected.length} attacks` +
  `    ${durationSeconds}s`;
console.log(summary);
console.log(RULE);
console.log("");
console.log(DIM("  A SKIP is not a pass. It means the claim could not be proven against real"));
console.log(DIM("  state in this run, and the reason above says exactly what is missing."));
console.log("");

if (child.status !== 0 && results === null) {
  console.log(RED("  vitest itself did not produce a result. Its output follows:"));
  console.log(String(child.stderr ?? "").slice(-4000));
  console.log(String(child.stdout ?? "").slice(-2000));
}

// Exit non-zero only on a genuine failure. A skip is a known gap, loudly
// printed, and failing the process on it would train people to ignore the
// exit code — the same reasoning as DECISIONS 014 on breaks nobody reads.
process.exit(totals.FAIL > 0 ? 1 : 0);
