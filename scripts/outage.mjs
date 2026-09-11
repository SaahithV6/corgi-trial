#!/usr/bin/env node
/**
 * OUTAGE — turn the issuing provider's webhooks off, for real, and guarantee
 * they come back on.
 *
 * This is live fire attack 7 as the BRIEF actually words it:
 *
 *   > Turn off your issuing provider's webhooks for five minutes mid-demo and
 *   > ask what the customer sees.
 *
 * The vitest version of attack 7 induces its outage by *sending nothing* and
 * letting the feed go quiet. That is a fair simulation and it is what CI runs,
 * but the health endpoint now correctly reads a feed that was never fed as
 * `dormant` rather than `down`, which is a different word than the one the
 * panel will be looking for. This script does the stronger thing: it disables
 * the Lithic event subscription over the API, so the clearing feed genuinely
 * stops arriving at the deployed app.
 *
 *   node scripts/outage.mjs --status          # read-only. changes nothing.
 *   node scripts/outage.mjs --start           # disable, hold, restore on exit
 *   node scripts/outage.mjs --stop            # restore + VERIFY by real GET
 *   node scripts/outage.mjs --auto 300        # disable, wait 5min, restore, verify
 *
 * ---------------------------------------------------------------------------
 * THE SAFETY IS THE WHOLE JOB
 * ---------------------------------------------------------------------------
 *
 * A script that can turn the webhooks off and not back on is worse than no
 * script, because it converts a demo into an incident. Five guarantees, in the
 * order they fire:
 *
 *   1. PROVE RESTORE BEFORE BREAKING. Before anything is disabled, the script
 *      performs a real no-op PATCH (`disabled:false`) and then a real GET to
 *      confirm the write landed. If the credential cannot PATCH, the script
 *      REFUSES TO START and nothing is touched. You never find out that you
 *      cannot restore after you have already broken it.
 *   2. EVERY EXIT PATH RESTORES. SIGINT, SIGTERM, SIGHUP, normal completion,
 *      a thrown error, an unhandled rejection — all funnel through one
 *      idempotent restore().
 *   3. AN IN-PROCESS WATCHDOG. A hard timer (`--max-outage`, default 600s)
 *      restores and exits even if the main flow is wedged, hung on a socket,
 *      or waiting on a keypress that never comes.
 *   4. A DETACHED SENTINEL. Guarantees 2 and 3 both die with the process, and
 *      `kill -9` does not run handlers. So before disabling, the script forks
 *      a detached child whose ONLY capability is to re-enable the subscription
 *      after `--max-outage` seconds. It survives SIGKILL of the parent, a
 *      closed terminal, and a laptop lid. The only thing it can do is turn the
 *      feed back ON, so it is safe for it to fire spuriously.
 *   5. `--stop` IS ALWAYS THE ANSWER. It is idempotent and takes no state from
 *      a previous run. If anything at all goes wrong, in any terminal:
 *
 *        node scripts/outage.mjs --stop
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT BIT US: PATCH NEEDS THE URL
 * ---------------------------------------------------------------------------
 *
 * An earlier attempt at this PATCH was rejected:
 *
 *   400  {"message": "\"url\" is a required property"}
 *
 * Lithic's PATCH on an event subscription is not a sparse merge — it wants the
 * `url` in the body every time, even when you are only flipping `disabled`. So
 * this script GETs the subscription first and echoes its own `url` back on
 * every write. That is exactly the failure that would have blown up live, at
 * the worst possible moment: on the RESTORE call, with the feed already off.
 *
 * ---------------------------------------------------------------------------
 * THE COST, STATED HONESTLY: USE A FIXTURE CARD
 * ---------------------------------------------------------------------------
 *
 * Lithic does not guarantee replay of events dropped while a subscription is
 * disabled. A card transaction made DURING the outage can therefore lose its
 * clearing webhook PERMANENTLY. On an append-only book that is not a delay, it
 * is a permanent gap — a hold that never releases and a settlement that never
 * posts, with no supported way to ask the provider to send it again.
 *
 * Therefore: TRANSACT ON A FIXTURE CARD DURING THE OUTAGE, NEVER ON A DEMO
 * BUSINESS. Fixtures carry EINs shaped `00-000000N`. Ridgeline Robotics,
 * Kettle & Crumb Bakery and Silverline Freight are the demo businesses the
 * panel will be looking at and must not be used for this.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE OUTAGE DOES *NOT* STOP: ASA IS ENROLLED SEPARATELY
 * ---------------------------------------------------------------------------
 *
 * Measured, not assumed:  GET /v1/auth_stream -> {"enrolled": true}
 *
 * The real-time authorisation stream (ASA) is a SEPARATE enrolment from the
 * event subscription. Disabling the subscription stops the asynchronous
 * clearing/settlement feed; it does NOT stop cards authorising. That is the
 * whole demo, and it is the honest answer to "what does the customer see":
 * the card still works, the clearing feed goes dark, available balance still
 * moves on the hold, and the customer is TOLD that settlement data is stale
 * rather than being shown a number the system cannot currently stand behind.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/** Load `.env` without clobbering anything already exported. */
function loadDotEnv(path) {
  if (!existsSync(path)) return;
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
  }
}

loadDotEnv(resolve(ROOT, ".env"));
loadDotEnv(resolve(ROOT, ".env.local"));

const API_KEY = process.env.LITHIC_API_KEY;
const API_BASE = (process.env.LITHIC_API_BASE ?? "https://sandbox.lithic.com").replace(/\/+$/, "");

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const COLOUR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text);
const GREEN = (t) => paint("32;1", t);
const RED = (t) => paint("31;1", t);
const YELLOW = (t) => paint("33;1", t);
const DIM = (t) => paint("2", t);
const RULE = "=".repeat(78);

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function say(text) {
  console.log(`  ${DIM(stamp())}  ${text}`);
}

/**
 * The one line a panel watching this needs to be able to read from the back of
 * the room: which subscription, and is it on or off, as the provider says so.
 */
function state(label, sub) {
  const on = sub.disabled === false;
  const badge = on ? GREEN("ENABLED ") : RED("DISABLED");
  say(`${label.padEnd(22)} ${badge}  token ${sub.token}`);
  return on;
}

/* -------------------------------------------------------------------------- */
/* Lithic                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The sandbox rate-limits writes hard enough that two PATCHes back to back
 * earn a 429 (measured while building this). A restore that loses to a rate
 * limiter is not a restore, so every call is spaced and every 429 is retried
 * rather than surfaced.
 */
let lastCallAt = 0;
const MIN_GAP_MS = 1200;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function lithic(method, path, body) {
  if (API_KEY === undefined || API_KEY === "") {
    throw new Error("LITHIC_API_KEY is not set — cannot read or write the subscription");
  }
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const gap = Date.now() - lastCallAt;
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
    lastCallAt = Date.now();

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: API_KEY,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();

    if (response.status === 429 || response.status >= 500) {
      if (attempt === 6) {
        throw new Error(`${method} ${path} -> HTTP ${response.status} after ${attempt} attempts: ${text.slice(0, 300)}`);
      }
      say(YELLOW(`${method} ${path} -> HTTP ${response.status}; retrying (attempt ${attempt})`));
      await sleep(1500 * attempt);
      continue;
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    try {
      return text === "" ? {} : JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} -> HTTP ${response.status}: response was not JSON: ${text.slice(0, 200)}`);
    }
  }
  throw new Error(`${method} ${path} exhausted retries`);
}

/**
 * Every write echoes the subscription's own url back — see the header note.
 *
 * And its description. Lithic's PATCH is a FULL REPLACE, not a sparse merge:
 * a body of `{disabled, url}` silently blanks `description`. That is how the
 * subscription lost its "Corgi work trial - card auth and clearing" label while
 * this script was being built, from a hand-run curl that only sent the two
 * fields the docs talk about. Cosmetic, but it is the same trap as the missing
 * `url` wearing a friendlier face, so every field we read is echoed back.
 */
async function setDisabled(token, url, disabled, description) {
  const body = { disabled, url };
  if (typeof description === "string" && description !== "") body.description = description;
  return lithic("PATCH", `/v1/event_subscriptions/${token}`, body);
}

/** The only statement of truth in this file: what the provider says right now. */
async function fetchSubscription(token) {
  if (token !== undefined) return lithic("GET", `/v1/event_subscriptions/${token}`);
  const list = await lithic("GET", "/v1/event_subscriptions");
  const subs = list.data ?? [];
  if (subs.length === 0) throw new Error("no event subscriptions exist on this Lithic account");
  if (subs.length > 1) {
    const tokens = subs.map((s) => s.token).join(", ");
    throw new Error(
      `${subs.length} event subscriptions exist (${tokens}); pass --token to say which one, ` +
        "rather than this script guessing which feed to take down",
    );
  }
  return subs[0];
}

/** Enrolment of the real-time auth stream — separate from the subscription. */
async function authStreamEnrolled() {
  try {
    const result = await lithic("GET", "/v1/auth_stream");
    return result.enrolled === true;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { mode: null, seconds: 300, maxOutage: 600, token: undefined, sentinel: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--status") args.mode = "status";
    else if (arg === "--start") args.mode = "start";
    else if (arg === "--stop") args.mode = "stop";
    else if (arg === "--auto") {
      args.mode = "auto";
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.seconds = value;
        i += 1;
      }
    } else if (arg.startsWith("--auto=")) {
      args.mode = "auto";
      args.seconds = Number(arg.slice("--auto=".length));
    } else if (arg === "--max-outage") args.maxOutage = Number(next());
    else if (arg.startsWith("--max-outage=")) args.maxOutage = Number(arg.slice("--max-outage=".length));
    else if (arg === "--token") args.token = next();
    else if (arg.startsWith("--token=")) args.token = arg.slice("--token=".length);
    else if (arg === "--no-sentinel") args.sentinel = false;
    // Internal. The detached restore child re-execs this file with this flag.
    else if (arg === "--sentinel-restore") args.mode = "sentinel-restore";
    else if (arg === "--help" || arg === "-h") args.mode = "help";
  }
  if (!Number.isFinite(args.seconds) || args.seconds <= 0) args.seconds = 300;
  if (!Number.isFinite(args.maxOutage) || args.maxOutage <= 0) args.maxOutage = 600;
  // The watchdog must outlive the planned outage or it would cut the demo short.
  if (args.maxOutage <= args.seconds) args.maxOutage = args.seconds + 60;
  return args;
}

const USAGE = `
usage: node scripts/outage.mjs <mode> [options]

  --status              read-only. Print the subscription and the ASA enrolment.
  --start               disable the subscription and HOLD. Ctrl-C restores.
  --stop                re-enable and VERIFY by a real GET. Idempotent. Always safe.
  --auto <seconds>      disable, wait, restore, verify, exit. Unattended. Default 300.

  --max-outage <secs>   hard cap enforced by a watchdog AND a detached sentinel.
                        Default 600, always forced above --auto.
  --token <ep_...>      which subscription, if the account has more than one.
  --no-sentinel         do not fork the detached restore child. Only use this if
                        you are supervising the process yourself.

IF ANYTHING GOES WRONG:  node scripts/outage.mjs --stop
`;

/* -------------------------------------------------------------------------- */
/* Restore — one idempotent path, wired to every exit                         */
/* -------------------------------------------------------------------------- */

/** Set once we have actually disabled something. Nothing to undo before that. */
let outage = null;
let restoring = null;

/**
 * Re-enable, then PROVE it with an independent GET. The PATCH response is not
 * accepted as evidence: a restore that reports success and did not land is the
 * exact failure this whole file exists to prevent.
 */
async function restore(reason) {
  if (outage === null) return true;
  if (restoring !== null) return restoring;
  restoring = (async () => {
    console.log("");
    say(YELLOW(`RESTORING — ${reason}`));
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await setDisabled(outage.token, outage.url, false, outage.description);
        const verified = await fetchSubscription(outage.token);
        if (verified.disabled === false) {
          state("verified by GET", verified);
          say(GREEN("the clearing feed is back on. Nothing further is required."));
          outage = null;
          return true;
        }
        lastError = new Error(`GET still reports disabled=${verified.disabled}`);
      } catch (error) {
        lastError = error;
      }
      say(RED(`restore attempt ${attempt} failed: ${lastError?.message ?? lastError}`));
      await sleep(2000 * attempt);
    }
    console.log("");
    console.log(RED(RULE));
    console.log(RED("  RESTORE FAILED. THE WEBHOOK SUBSCRIPTION IS STILL DISABLED."));
    console.log(RED(`  token ${outage.token}`));
    console.log(RED("  Run this until it succeeds:   node scripts/outage.mjs --stop"));
    console.log(RED("  Or by hand (the url is required — that is the 400 that bit us):"));
    console.log(
      RED(
        `    curl -X PATCH -H "Authorization: $LITHIC_API_KEY" -H "Content-Type: application/json" \\\n` +
          `      -d '{"disabled":false,"url":"${outage.url}"}' \\\n` +
          `      ${API_BASE}/v1/event_subscriptions/${outage.token}`,
      ),
    );
    console.log(RED(RULE));
    return false;
  })();
  return restoring;
}

/**
 * Guarantee 4. Handlers and timers both die with the process; `kill -9` runs
 * neither. This child is detached, holds no reference to the parent, and its
 * only capability is to turn the subscription back ON after `seconds`. It is
 * therefore safe for it to fire when it was not needed.
 */
function forkSentinel(token, url, seconds) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--sentinel-restore", "--token", token, "--max-outage", String(seconds)],
    { detached: true, stdio: "ignore", cwd: ROOT, env: { ...process.env, OUTAGE_SENTINEL_URL: url } },
  );
  child.unref();
  return child.pid;
}

function wireExitPaths(maxOutageSeconds) {
  const finish = async (reason, code) => {
    const ok = await restore(reason);
    process.exit(ok ? code : 1);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      void finish(`received ${signal}`, 0);
    });
  }
  process.on("uncaughtException", (error) => {
    console.log(RED(`  uncaught: ${error?.stack ?? error}`));
    void finish("uncaught exception", 1);
  });
  process.on("unhandledRejection", (error) => {
    console.log(RED(`  unhandled rejection: ${error?.stack ?? error}`));
    void finish("unhandled rejection", 1);
  });
  // Guarantee 3: fires even if the main flow never returns.
  setTimeout(() => {
    void finish(`hard watchdog: ${maxOutageSeconds}s cap reached`, 1);
  }, maxOutageSeconds * 1000);
}

/* -------------------------------------------------------------------------- */
/* Preflight — prove we can restore BEFORE we break anything                  */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to start unless a real PATCH lands and a real GET confirms it. This is
 * a no-op write (`disabled:false` on a subscription that is already enabled),
 * so it is safe to run at any time, including thirty seconds before a demo.
 */
async function preflight(token) {
  say("preflight — proving this credential can RESTORE before it is allowed to break anything");
  const before = await fetchSubscription(token);
  state("current state", before);

  if (typeof before.url !== "string" || before.url === "") {
    throw new Error(
      `subscription ${before.token} has no url; PATCH requires one and this script will not invent it`,
    );
  }
  say(`subscription url       ${before.url}`);

  if (before.disabled === true) {
    say(YELLOW("already disabled — a previous run did not restore. Re-enabling now."));
  }

  await setDisabled(before.token, before.url, false, before.description);
  const proof = await fetchSubscription(before.token);
  const enabled = state("restore PROVEN", proof);
  if (!enabled) {
    throw new Error(
      `preflight PATCH did not land: GET still reports disabled=${proof.disabled}. ` +
        "REFUSING to disable anything — a script that can turn it off and not on is worse than no script.",
    );
  }

  const asa = await authStreamEnrolled();
  say(
    `auth_stream (ASA)      ${
      asa === true
        ? GREEN("enrolled: true") + DIM("  — cards KEEP AUTHORISING through the outage")
        : asa === false
          ? YELLOW("enrolled: false")
          : YELLOW("could not be read")
    }`,
  );
  return proof;
}

/* -------------------------------------------------------------------------- */
/* Modes                                                                      */
/* -------------------------------------------------------------------------- */

function printFixtureWarning() {
  console.log("");
  console.log(YELLOW("  ------------------------------------------------------------------------"));
  console.log(YELLOW("  TRANSACT ON A FIXTURE CARD ONLY  (EIN shaped 00-000000N)"));
  console.log(DIM("  Lithic does not guarantee replay of events dropped while a subscription"));
  console.log(DIM("  is down. A transaction made DURING the outage can lose its clearing"));
  console.log(DIM("  webhook permanently, and on an append-only book that is a permanent gap."));
  console.log(DIM("  Do NOT use Ridgeline Robotics, Kettle & Crumb Bakery or Silverline"));
  console.log(DIM("  Freight — those are the demo businesses the panel is looking at."));
  console.log(YELLOW("  ------------------------------------------------------------------------"));
  console.log("");
}

async function modeStatus(token) {
  const sub = await fetchSubscription(token);
  state("subscription", sub);
  say(`url                    ${sub.url}`);
  const asa = await authStreamEnrolled();
  say(`auth_stream (ASA)      enrolled: ${asa === null ? "unreadable" : asa}`);
  say(DIM("read-only. nothing was changed."));
  return sub.disabled === false ? 0 : 1;
}

async function modeStop(token) {
  say("restoring the subscription and verifying by a real GET");
  const sub = await fetchSubscription(token);
  state("before", sub);
  if (typeof sub.url !== "string" || sub.url === "") {
    throw new Error(`subscription ${sub.token} has no url; cannot PATCH without it`);
  }
  await setDisabled(sub.token, sub.url, false, sub.description);
  const verified = await fetchSubscription(sub.token);
  const enabled = state("verified by GET", verified);
  if (!enabled) {
    console.log(RED("  STILL DISABLED after PATCH. Escalate — do not start the demo."));
    return 1;
  }
  const asa = await authStreamEnrolled();
  say(`auth_stream (ASA)      enrolled: ${asa === null ? "unreadable" : asa}`);
  say(GREEN("the clearing feed is on."));
  return 0;
}

async function beginOutage(token, maxOutage, useSentinel) {
  const sub = await preflight(token);
  printFixtureWarning();

  wireExitPaths(maxOutage);

  let sentinelPid = null;
  if (useSentinel) {
    sentinelPid = forkSentinel(sub.token, sub.url, maxOutage);
    say(`detached sentinel      pid ${sentinelPid} — restores in ${maxOutage}s even if this process is killed -9`);
  } else {
    say(YELLOW("detached sentinel      DISABLED by --no-sentinel; you are the supervisor now"));
  }

  // Armed BEFORE the write, not after. A SIGINT landing in the window between
  // the PATCH and this assignment would otherwise find nothing to undo.
  outage = { token: sub.token, url: sub.url, description: sub.description };

  await setDisabled(sub.token, sub.url, true, sub.description);
  const verified = await fetchSubscription(sub.token);
  const stillOn = state("verified by GET", verified);
  if (stillOn) {
    throw new Error("PATCH reported success but GET still reports enabled — refusing to claim an outage that is not real");
  }
  console.log("");
  say(RED("THE CLEARING FEED IS DARK. Cards still authorise (ASA is a separate enrolment)."));
  return sub;
}

async function modeStart(token, maxOutage, useSentinel) {
  await beginOutage(token, maxOutage, useSentinel);
  console.log("");
  console.log(`  ${YELLOW("Press Ctrl-C to restore.")} Hard cap ${maxOutage}s, then it restores itself.`);
  console.log("");
  // Hold. Every way out of here restores; see wireExitPaths().
  await new Promise(() => {});
  return 0;
}

async function modeAuto(token, seconds, maxOutage, useSentinel) {
  await beginOutage(token, maxOutage, useSentinel);
  console.log("");
  for (let remaining = seconds; remaining > 0; remaining -= 30) {
    const step = Math.min(30, remaining);
    say(DIM(`outage holding — ${remaining}s remaining of ${seconds}s`));
    await sleep(step * 1000);
  }
  const ok = await restore(`--auto ${seconds}s elapsed`);
  return ok ? 0 : 1;
}

/**
 * The detached child. No output, no cleverness, one job: wait, then turn it on.
 * It never disables anything, so a spurious run is harmless.
 */
async function modeSentinelRestore(token, seconds) {
  await sleep(seconds * 1000);
  const url = process.env.OUTAGE_SENTINEL_URL;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const sub = await fetchSubscription(token);
      if (sub.disabled === false) return 0;
      await setDisabled(token, url ?? sub.url, false, sub.description);
      const verified = await fetchSubscription(token);
      if (verified.disabled === false) return 0;
    } catch {
      // The sentinel has no terminal. Retrying is the only thing it can do.
    }
    await sleep(5000 * attempt);
  }
  return 1;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const args = parseArgs(process.argv.slice(2));

if (args.mode === null || args.mode === "help") {
  console.log(USAGE);
  process.exit(args.mode === null ? 2 : 0);
}

if (args.mode === "sentinel-restore") {
  process.exit(await modeSentinelRestore(args.token, args.maxOutage));
}

console.log("");
console.log(RULE);
console.log("  OUTAGE — live fire attack 7, the BRIEF's version: the webhooks really go off");
console.log(RULE);
say(`mode                   ${args.mode}`);
say(`provider               ${API_BASE}  ${API_KEY ? GREEN("key present") : RED("NO LITHIC_API_KEY")}`);
console.log("");

let exitCode = 0;
try {
  if (args.mode === "status") exitCode = await modeStatus(args.token);
  else if (args.mode === "stop") exitCode = await modeStop(args.token);
  else if (args.mode === "start") exitCode = await modeStart(args.token, args.maxOutage, args.sentinel);
  else if (args.mode === "auto") exitCode = await modeAuto(args.token, args.seconds, args.maxOutage, args.sentinel);
} catch (error) {
  console.log("");
  console.log(RED(`  ${error?.message ?? error}`));
  await restore("the script threw");
  exitCode = 1;
}
console.log("");
process.exit(exitCode);
