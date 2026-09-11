#!/usr/bin/env node
/**
 * THE CORE LOOP — one business, seven legs, one continuous run against the
 * DEPLOYED system.
 *
 *   node scripts/coreloop.mjs
 *   node scripts/coreloop.mjs --base-url https://corgi-trial-psi.vercel.app
 *   node scripts/coreloop.mjs --only 1,4,5
 *
 * The published brief's core loop, verbatim:
 *
 *   open an account behind a real KYB check -> fund it from a linked external
 *   bank -> issue a real (sandbox) card -> authorise, then settle for a
 *   different amount days later -> send an outbound payment that needs a
 *   second approver -> survive a reversed settlement -> reconcile the scheme
 *   file
 *
 * ============================================================================
 * WHAT "END TO END" MEANS IN THIS FILE, AND IT IS THE WHOLE POINT
 * ============================================================================
 *
 * There is not one call to an application function anywhere below. This script
 * imports `postgres` and nothing else from this repository. `postEntry`,
 * `reverseAndRebook`, `requestPayment`, `drain`, `canTransact` — none of them
 * are reachable from here, and that is deliberate: a run that could call them
 * would be testing this process, not the deployment.
 *
 * Every write goes through the deployed application the way a person's browser
 * does:
 *
 *  - HTTPS against the deployed origin. Never localhost, never an import.
 *  - Where a screen has a form, the form is POSTED TO ITS SERVER ACTION as a
 *    `multipart/form-data` MPA submission — the identical request a browser
 *    with JavaScript disabled makes. Next renders React's progressive-
 *    enhancement fields into every such form: `$ACTION_REF_<n>`,
 *    `$ACTION_<n>:0` carrying `{"id":"<action id>","bound":"$@1"}`,
 *    `$ACTION_<n>:1` carrying the `useActionState` previous state, and
 *    `$ACTION_KEY`. This script scrapes those fields out of the live HTML at
 *    runtime and posts them back verbatim. NOTHING IS HARD-CODED: the action
 *    ids below are read from the deployment on every run, and a redeploy that
 *    changes them changes nothing here.
 *
 *    (`docs/DEMO.md` check 9 records that the approvals form "carries no
 *    no-JavaScript action id". That was measured with a regex looking only for
 *    `$ACTION_ID_`, which is the UNBOUND form React emits for a server
 *    component's `<form action={fn}>`. A `useActionState` action in a client
 *    component emits the BOUND form, `$ACTION_REF_`/`$ACTION_<n>:0`, and it
 *    posts perfectly well. Leg 5 drives it.)
 *
 *  - The server action's own return value is read back out of the re-rendered
 *    page, from the `$ACTION_<n>:1` bound-args field React writes for the next
 *    submission. That is the action's literal result object, produced by the
 *    deployment, not a sentence this script inferred from some rendered text.
 *
 *  - Where a step is inherently provider-driven, the deployed action calls the
 *    provider sandbox for real and this script then WAITS FOR THE WEBHOOK to
 *    arrive and be drained, nudging `POST /api/drain` exactly as
 *    `src/test/livefire/*` does. Nothing is written to the database to make a
 *    step pass.
 *
 * If a leg cannot be driven through the deployed surface, IT SKIPS, and the
 * skip names precisely what is missing. A SKIP IS NOT A PASS.
 *
 * ============================================================================
 * THE TWO RULES GOVERNING THE OUTPUT, borrowed from scripts/livefire.mjs
 * ============================================================================
 *
 *  1. THE VERDICT IS DERIVED FROM ASSERTIONS, NEVER ASSERTED ABOUT ITSELF. A
 *     leg is a function that records `check(condition, text)` calls. `verdict()`
 *     is a fold over those records and there is deliberately no branch in it
 *     that turns "nothing was checked" into a pass.
 *  2. IT MUST BE READABLE AT A GLANCE. One line per leg with the verdict in a
 *     fixed column, the evidence indented beneath, a total at the bottom that
 *     adds up.
 *
 * ============================================================================
 * MONEY, ISOLATION, AND THE DATABASE
 * ============================================================================
 *
 * Money is `bigint` cents everywhere in this file. There is no `parseFloat`, no
 * `Number` applied to an amount, and no division by 100 outside the one
 * formatter that renders a bigint as text by string arithmetic.
 *
 * The database is read ONLY. Every statement is a `SELECT`. The writes this
 * run performs are the real, append-only rows the deployed application writes
 * on its own behalf, and they are not torn down — the money tables are
 * append-only by design and `corgi_app` holds no `DELETE` on them anyway. The
 * run isolates itself the way the live-fire suite does: a per-run reference
 * (`CL-<base36 clock>`) goes into every reference, nickname and descriptor it
 * controls, and every assertion is made by that reference.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://corgi-trial-psi.vercel.app";

/* ========================================================================== */
/* Arguments                                                                  */
/* ========================================================================== */

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.CORELOOP_BASE_URL ?? DEFAULT_BASE_URL,
    only: null,
    business: null,
    listSubjects: false,
  };
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
    } else if (arg === "--business") {
      args.business = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--business=")) {
      args.business = arg.slice("--business=".length);
    } else if (arg === "--list-subjects") {
      args.listSubjects = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/coreloop.mjs [--base-url URL] [--only 1,2,3]\n" +
          "                                [--business <uuid | name substring>] [--list-subjects]\n" +
          "Drives the published core loop end to end against the DEPLOYED system.\n" +
          "\n" +
          "  --business       run the whole loop for ONE named business instead of the\n" +
          "                   highest-ranked one. This exists because \"the core loop\n" +
          "                   passes 7/7 on a second business\" is a claim nobody could\n" +
          "                   make honestly while the script had no way to choose a\n" +
          "                   second business: it selected one and there was no argument\n" +
          "                   that changed it. Now the claim is a command.\n" +
          "  --list-subjects  print the ranking and exit, without running a leg.",
      );
      process.exit(0);
    }
  }
  return args;
}

/* ========================================================================== */
/* Environment                                                                */
/* ========================================================================== */

/** Load `.env` without clobbering anything already exported. */
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
/* Formatting                                                                 */
/* ========================================================================== */

const WIDTH = 92;
const RULE = "=".repeat(WIDTH);
const THIN = "-".repeat(WIDTH);

const COLOUR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text);
const GREEN = (t) => paint("32;1", t);
const RED = (t) => paint("31;1", t);
const YELLOW = (t) => paint("33;1", t);
const DIM = (t) => paint("2", t);

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
/* Money — bigint cents, string arithmetic, no floats anywhere                */
/* ========================================================================== */

/** `"73.40"` -> `7340n`. Refuses anything it cannot read exactly. */
function usdToCents(text) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim().replace(/[$,]/g, ""));
  if (m === null) return null;
  const [, sign, whole, frac = ""] = m;
  const cents = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return sign === "-" ? -cents : cents;
}

/** `7340n` -> `"$73.40"`. Division is on bigints; the text is assembled. */
function usd(cents) {
  const n = typeof cents === "bigint" ? cents : BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${rest}`;
}

/** `7340n` -> `"73.40"`, the way a person types it into the form. */
function usdText(cents) {
  const n = typeof cents === "bigint" ? cents : BigInt(cents);
  return `${(n / 100n).toString()}.${(n % 100n).toString().padStart(2, "0")}`;
}

/** A money column as bigint cents, whatever the driver decided to hand back.
 *  `int8` arrives as a bigint (configured below); a view column that computed
 *  its way to `numeric` arrives as a string, and `"0" === 0n` is false. */
const cents = (value) => (typeof value === "bigint" ? value : BigInt(value ?? 0));

/** A `date` column as `YYYY-MM-DD`. Postgres hands back a Date; slicing its
 *  default string gives "Wed Dec 01", which is not a value date. */
const day = (value) =>
  value === null || value === undefined
    ? "(none)"
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);

/** A signed delta, for before/after lines. */
const delta = (before, after) => {
  const d = after - before;
  return `${d > 0n ? "+" : ""}${usd(d)}`;
};

/* ========================================================================== */
/* HTTP                                                                       */
/* ========================================================================== */

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl.replace(/\/+$/, "");
const HTTP_TIMEOUT_MS = 60_000;

/** Every request this script makes. Counted, so the transcript can prove it. */
let httpCalls = 0;

/**
 * THE OPERATOR SESSION, and why this script now has to hold one.
 *
 * The console went behind a passphrase. Reads stayed open; every WRITE needs a
 * session cookie signed by the server, and an anonymous POST answers
 * 401 SIGN_IN_REQUIRED. This script is nothing BUT writes — it opens an
 * account, funds it, issues a card, raises a payment — so without a session
 * every write leg dies at the door.
 *
 * The mechanism below is `scripts/verify-demo.mjs` step 0's, copied rather than
 * reinvented: POST /signin with `$CONSOLE_PASSWORD`, keep the `corgi_console`
 * cookie, send it on everything after. There is deliberately only one sign-in
 * mechanism in this repository, and this is not a second one.
 *
 * The passphrase is read from this shell's environment. It is never a literal
 * in this file, never printed, and never written to the transcript.
 */
let consoleSession = "";

/**
 * `null` once this run holds a session. Otherwise the SENTENCE naming why it
 * does not — which every write leg prints as its own failure, by name.
 *
 * It is a FAILURE and not a skip. A skip would let seven legs fail one at a
 * time with bare 401s and leave the reader to work out what they had in
 * common; and a gate the checker cannot get past is the single thing the
 * operator running it must be told, in one line, at the top.
 */
let authFailure = null;

/** The remedy for `authFailure`, printed ONCE at the top and once at the foot. */
let authRemedy = "";

async function http(path, options = {}) {
  httpCalls += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    // The session rides ALONGSIDE whatever cookie a caller set for itself (the
    // role switch sets `corgi_demo_role`) rather than replacing it: they are
    // different things and this script needs both. Same composition as
    // verify-demo's `req()`.
    const supplied = options.headers?.cookie ?? "";
    const cookie = [consoleSession, supplied].filter((c) => c !== "").join("; ");
    const res = await fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...options,
      signal: controller.signal,
      headers: {
        "cache-control": "no-cache",
        ...(options.headers ?? {}),
        ...(cookie === "" ? {} : { cookie }),
      },
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A non-200 from a write POST, described by its CAUSE rather than its number.
 *
 * 401 and 503 are statements about the DOOR, not about the subsystem behind
 * it. Printing "the funding POST answered 401" sends a reader to debug the
 * funding rail; printing this sends them to the passphrase, which is where the
 * problem actually is.
 */
function postFailure(what, res) {
  if (res.status === 401) {
    return (
      `${what} answered 401 SIGN_IN_REQUIRED — an AUTHENTICATION failure, not a finding about ` +
      `the subsystem behind it. This run holds no operator session. ` +
      (authFailure ?? "The corgi_console cookie was not sent, or the deployment did not accept it.")
    );
  }
  if (res.status === 403) {
    return (
      `${what} answered 403 — an AUTHORISATION failure: this session is signed in but the ROLE it ` +
      `carries may not perform this write. Not a finding about the subsystem behind it.`
    );
  }
  if (res.status === 503) {
    return (
      `${what} answered 503 CONSOLE_NOT_CONFIGURED — an AUTHENTICATION failure: the DEPLOYMENT ` +
      `has no CONSOLE_PASSWORD set, so its console is closed and no passphrase will open it. ` +
      `Set CONSOLE_PASSWORD on the project and redeploy. See docs/AUTH.md.`
    );
  }
  return `${what} answered ${res.status}`;
}

const cookieFor = (role) => (role ? { cookie: `corgi_demo_role=${role}` } : {});

async function getPage(path, role) {
  const res = await http(path, { headers: cookieFor(role) });
  if (res.status !== 200) {
    throw new Error(`GET ${path} answered ${res.status}, expected 200`);
  }
  return res.body;
}

/* ========================================================================== */
/* HTML — forms, and the server-action ids they carry                         */
/* ========================================================================== */

const unescapeHtml = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

function tagAttrs(raw) {
  const out = {};
  for (const m of raw.matchAll(/([:@\w$-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeHtml(m[2]);
  return out;
}

/**
 * Every `<form>` on a page, with its server-action id and its controls.
 *
 * `actionId` comes from whichever progressive-enhancement shape React used:
 *
 *   `$ACTION_ID_<id>`        an unbound action on a server component's form
 *   `$ACTION_<n>:0` = {"id"} a bound `useActionState` action in a client one
 *
 * Both are read from the live HTML. Neither is ever hard-coded.
 */
function parseForms(html) {
  const forms = [];
  for (const fm of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const body = fm[2];
    const controls = [];
    const action = [];
    let actionId = null;

    for (const sm of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const a = tagAttrs(sm[1]);
      if (a.name === undefined) continue;
      const options = [...sm[2].matchAll(/<option\b([^>]*)>/g)].map((om) => tagAttrs(om[1]).value ?? "");
      controls.push({ tag: "select", name: a.name, value: a.value ?? options[0] ?? "", options });
    }
    for (const tm of body.matchAll(/<(input|button|textarea)\b([^>]*)>/g)) {
      const a = tagAttrs(tm[2]);
      if (a.name === undefined) continue;
      const value = a.value ?? "";
      if (a.name.startsWith("$ACTION")) {
        action.push({ name: a.name, value });
        const bound = /^\$ACTION_(\d+):0$/.exec(a.name);
        if (bound !== null) {
          try {
            actionId = JSON.parse(value).id ?? actionId;
          } catch {
            /* a malformed descriptor is simply not an action id */
          }
        }
        const unbound = /^\$ACTION_ID_([0-9a-f]+)$/.exec(a.name);
        if (unbound !== null) actionId = unbound[1];
        continue;
      }
      controls.push({
        tag: tm[1],
        name: a.name,
        value,
        disabled: Object.hasOwn(a, "disabled"),
      });
    }
    forms.push({ actionId, action, controls });
  }
  return forms;
}

/** The named, non-action controls of a form, as `{name: value}`. */
function controlMap(form) {
  const out = {};
  for (const c of form.controls) if (!(c.name in out)) out[c.name] = c.value;
  return out;
}

/** Pick the one form matching an action id and a set of field values. */
function findForm(forms, { actionId = null, where = {}, has = [] } = {}) {
  return (
    forms.find((f) => {
      if (actionId !== null && f.actionId !== actionId) return false;
      const map = controlMap(f);
      for (const name of has) if (!(name in map)) return false;
      for (const [k, v] of Object.entries(where)) if (map[k] !== v) return false;
      return true;
    }) ?? null
  );
}

/**
 * Read a server action's RETURN VALUE back out of a re-rendered page.
 *
 * React writes the new `useActionState` state into the form's bound-args field
 * for the next submission, so `$ACTION_<n>:1` on the response is literally
 * `[<the object the action returned>]`. This is the deployment's own answer,
 * not a sentence parsed out of rendered prose.
 */
/**
 * Undo React's model escaping.
 *
 * In a flight payload a string whose first character is `$` is a REFERENCE —
 * `$K1` is a FormData, `$@1` a promise — so React escapes an ordinary string
 * that happens to start with `$` by doubling it. Read back raw, a card's spend
 * limit comes out as `$$5,000.00`. One `$` comes off; nothing else is touched.
 */
function unflight(value) {
  if (typeof value === "string") return value.startsWith("$$") ? value.slice(1) : value;
  if (Array.isArray(value)) return value.map(unflight);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unflight(v)]));
  }
  return value;
}

function readActionState(html, { actionId, where = {} }) {
  const forms = parseForms(html).filter((f) => f.actionId === actionId);
  const stateOf = (form) => {
    const field = form.action.find((a) => /^\$ACTION_\d+:1$/.test(a.name));
    if (field === undefined) return null;
    try {
      const parsed = JSON.parse(field.value);
      return Array.isArray(parsed) ? (unflight(parsed[0]) ?? null) : null;
    } catch {
      return null;
    }
  };
  const keyed = forms.filter((f) => {
    const map = controlMap(f);
    return Object.entries(where).every(([k, v]) => map[k] === v);
  });
  for (const form of [...keyed, ...forms]) {
    const state = stateOf(form);
    if (state !== null && state.status !== undefined && state.status !== "idle") return state;
  }
  return null;
}

/**
 * POST a form to its server action, exactly as a browser with JavaScript
 * disabled does: `multipart/form-data`, every `$ACTION_*` field verbatim, then
 * the named controls with this caller's overrides on top.
 *
 * Returns the re-rendered page and the action's own return value.
 */
async function submitForm(path, form, overrides, { role = null, actionId = null } = {}) {
  const body = new FormData();
  for (const a of form.action) body.append(a.name, a.value);

  const map = controlMap(form);
  for (const [name, value] of Object.entries(map)) {
    // Submit buttons contribute a value only when they are the one pressed, so
    // they are never sent from the defaults; the caller names the one it means.
    if (form.controls.some((c) => c.name === name && c.tag === "button")) continue;
    body.set(name, value);
  }
  for (const [name, value] of Object.entries(overrides)) body.set(name, value);

  const res = await http(path, { method: "POST", body, headers: cookieFor(role) });
  const id = actionId ?? form.actionId;
  return {
    status: res.status,
    html: res.body,
    state: res.status === 200 ? readActionState(res.body, { actionId: id, where: overrides }) : null,
  };
}

/**
 * SIGN IN, THEN DRIVE. The first thing a person does, and now the first thing
 * this script does.
 *
 * Mechanism copied verbatim from `scripts/verify-demo.mjs` step 0: read the
 * server-action id off the live /signin page, POST the passphrase to it as
 * multipart form data, keep the `corgi_console` cookie off the response.
 *
 * Returns `null` on success, or the sentence naming the failure. It never
 * throws and it never prints the passphrase.
 */
async function signIn() {
  const password = process.env.CONSOLE_PASSWORD;
  if (password === undefined || password === "") {
    authRemedy =
      "CONSOLE_PASSWORD is absent from THIS SHELL's environment, so this run cannot sign in and " +
      "every write below would be turned away at the door with 401 SIGN_IN_REQUIRED — an " +
      "AUTHENTICATION failure, which says nothing whatever about KYB, funding, card issuing or " +
      "approvals. Export the value the deployment holds:  set -a; . ./.env; set +a   " +
      "(or `export CONSOLE_PASSWORD=...`). See docs/AUTH.md.";
    return "AUTHENTICATION: the console passphrase is not set, so the write legs cannot run, and a skip is not a pass";
  }

  let page;
  try {
    page = await getPage("/signin");
  } catch (e) {
    return `GET /signin failed (${e?.message ?? String(e)}), so this run cannot sign in`;
  }
  if (page.includes("CONSOLE_NOT_CONFIGURED")) {
    authRemedy =
      "The DEPLOYMENT has no CONSOLE_PASSWORD set, so its console is closed and no passphrase " +
      "will open it. Nothing behind the door was reached, so nothing in this run is a finding " +
      "about what is behind it. Set CONSOLE_PASSWORD on the project and redeploy. See docs/AUTH.md.";
    return "AUTHENTICATION: the deployment's console is closed (CONSOLE_NOT_CONFIGURED), so the write legs cannot run";
  }

  const id = page.match(/\$ACTION_ID_([a-f0-9]+)/);
  if (id === null) {
    return "GET /signin carries no server-action id, so there is no sign-in form to post the passphrase to";
  }
  const form = new FormData();
  form.set(id[0], "");
  form.set("passphrase", password);
  const res = await http("/signin", { method: "POST", body: form });

  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  const set = raw.find((c) => c.startsWith("corgi_console="));
  if (set === undefined) {
    authRemedy =
      `POST /signin answered ${res.status} and set no corgi_console cookie: the CONSOLE_PASSWORD in ` +
      `this shell is not the passphrase this deployment holds. Nothing behind the door was ` +
      `reached, so nothing in this run is a finding about what is behind it. See docs/AUTH.md.`;
    return "AUTHENTICATION: the passphrase in this shell was rejected by the deployment, so the write legs cannot run";
  }
  if (!/httponly/i.test(set)) {
    return "the deployment's session cookie is not HttpOnly, so a visitor could mint one — refusing to drive writes through it";
  }
  consoleSession = set.split(";")[0];
  return null;
}

/**
 * Best-effort id -> exported name for the server actions a page ships.
 *
 * Turbopack compiles a client component's server reference to
 * `createServerReference("<id>", callServer, undefined, findSourceMapURL,
 * "<exported name>")`, so the deployment itself is the source of the mapping.
 * Actions whose component is in a chunk the page does not eagerly load are
 * simply absent from the map — the run still knows their id, because it read it
 * off the form, and the id is what it prints when there is no name.
 */
async function discoverActionNames(path) {
  const names = new Map();
  let html;
  try {
    html = await getPage(path);
  } catch {
    return names;
  }
  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/[A-Za-z0-9_./-]+\.js/g)].map((m) => m[0]))];
  for (const chunk of chunks) {
    let source;
    try {
      source = (await http(chunk)).body;
    } catch {
      continue;
    }
    for (const m of source.matchAll(
      /createServerReference\)?\("([0-9a-f]{20,})"[^)]*?"([A-Za-z_$][\w$]*)"\)/g,
    )) {
      names.set(m[1], m[2]);
    }
  }
  return names;
}

const ACTION_NAMES = new Map();
const nameOf = (id) => (ACTION_NAMES.has(id) ? `${ACTION_NAMES.get(id)} (${id})` : id);

/* ========================================================================== */
/* The provider — Lithic's sandbox, called directly                           */
/* ========================================================================== */

/**
 * A step that is inherently provider-driven is driven AT THE PROVIDER.
 *
 * A merchant reversing a settlement is not something a customer's bank has a
 * button for; it originates at the network. So leg 6 calls Lithic's sandbox
 * over its own API — raw HTTP, `Authorization: <key>` with no scheme, exactly
 * as `src/lib/rails/lithic/client.ts` documents — and then waits for the real
 * signed webhook to reach the deployed endpoint and be drained. This is the
 * same shape as leg 4, where the deployed action makes the provider call; the
 * only difference is that no deployed screen exposes this one.
 *
 * It is emphatically NOT a way around the no-application-code rule: nothing
 * here writes to the database, and every consequence is produced by the
 * deployment's own consumer.
 */
const LITHIC_BASE = process.env.LITHIC_BASE_URL ?? "https://sandbox.lithic.com/v1";
let providerCalls = 0;

async function lithic(method, path, body) {
  providerCalls += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${LITHIC_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: process.env.LITHIC_API_KEY ?? "",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* a non-JSON body is reported as text */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/* ========================================================================== */
/* The webhook pipeline                                                       */
/* ========================================================================== */

/**
 * Nudge the deployed drain endpoint. The same call `src/test/livefire/*` makes,
 * and the same `drain()` the cron runs — over HTTP, with the bearer token.
 */
async function drainNow() {
  const token = process.env.DRAIN_TOKEN;
  if (!token) return { ok: false, detail: "DRAIN_TOKEN is not set in this environment" };
  const res = await http("/api/drain", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) return { ok: false, detail: `POST /api/drain -> ${res.status}` };
  try {
    const json = JSON.parse(res.body);
    return { ok: true, summary: json, detail: `claimed ${json.claimed} processed ${json.processed} parked ${json.parked}` };
  } catch {
    return { ok: true, summary: null, detail: "200, unparseable body" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a live-database predicate, nudging the drain between attempts.
 *
 * The wait is for a REAL provider webhook to be delivered to the deployed
 * endpoint and drained by the deployed pipeline. Nothing here writes.
 */
async function waitForDrained(label, read, { attempts = 12, everyMs = 5000 } = {}) {
  const drains = [];
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) {
      return { ok: true, value, drains, waitedMs: i * everyMs };
    }
    const d = await drainNow();
    drains.push(d.detail);
    await sleep(everyMs);
  }
  const value = await read();
  if (value !== null && value !== undefined && value !== false) {
    return { ok: true, value, drains, waitedMs: attempts * everyMs };
  }
  return { ok: false, value: null, drains, waitedMs: attempts * everyMs, label };
}

/* ========================================================================== */
/* The database — READ ONLY. Every statement below is a SELECT.               */
/* ========================================================================== */

let sql = null;

/**
 * ONE QUANTITY, ONE ANSWER, AND A RUN THAT STOPS WHEN THERE ARE TWO.
 *
 * `mine` and `theirs` are two separate bodies asked the same question at the
 * same point. A cent between them is fatal, and the tolerance is zero because
 * there is nothing legitimate for a tolerance to absorb: both sides are meant
 * to be the SAME arithmetic reached by different routes.
 *
 * It stops rather than notes, because the failure it exists to catch has
 * already happened once. Leg 6 printed
 *
 *     the REFUND             LEDGER ...
 *       after            $90,408.21
 *     at this point the book believes 2026-09-11 closes at $60,772.91
 *
 * eleven lines apart, in one run, about one account, and the scoreboard still
 * said PASS 7. A run that prints two answers to one question has nothing to
 * say about a bank, so it does not get to finish.
 */
function agree(quantity, point, mine, theirs) {
  if (mine.cents === theirs.cents) return;
  const gap = mine.cents - theirs.cents;
  console.log("");
  console.log(RED(`  MONEY DISAGREEMENT — ${quantity}, at ${point}`));
  console.log(RED(`    ${mine.from.padEnd(46)}${usd(mine.cents).padStart(16)}`));
  console.log(RED(`    ${theirs.from.padEnd(46)}${usd(theirs.cents).padStart(16)}`));
  console.log(RED(`    ${"difference".padEnd(46)}${usd(gap).padStart(16)}`));
  console.log(RED("    Two bodies, one point, two answers. Nothing here is a tolerance to widen —"));
  console.log(RED("    one of these two is not computing what it says it is computing."));
  console.log("");
  throw new Failed(
    `${quantity} disagrees by ${usd(gap)} at ${point}: ${mine.from} says ${usd(mine.cents)}, ` +
      `${theirs.from} says ${usd(theirs.cents)}`,
  );
}

/**
 * One line naming the definition, one naming the predicate. Every money figure
 * this script prints is one of `ledger_availability()`'s five terms or a delta
 * between two readings of them, so this is the whole audit trail.
 */
const provenance = (f) => [
  `ledger_availability(value date ${f.valueDate}, booking seq ${f.watermark}) — the one definition, called not copied.`,
  `INCLUDES lines dated on or before that day and booked at or under that seq, and the holds live then;`,
  `EXCLUDES later-dated lines — their DEBITS return as PENDING OUT, their CREDITS are not money today.`,
];

/**
 * Ledger, holds, uncleared, pending outbound and available for one business.
 *
 * THIS IS A CALL TO `ledger_availability()`, NOT A COPY OF IT. Migration 0022
 * exists because this system once held four answers to "what is available";
 * the body that used to be here was a fifth, and it was wrong. There is no
 * arithmetic in this function, deliberately: the five figures it returns are
 * the five columns the function returns, carried unchanged.
 *
 * WHAT THE OLD BODY GOT WRONG, MEASURED ON THE SUBJECT ACCOUNT
 *
 *   THE LEDGER TERM summed EVERY line on the 2100 — no value-date predicate,
 *   no booking watermark. On Ridgeline Robotics that admitted 136 lines value-
 *   dated in 2027: $32,135.30 of credit and $2,500.00 of committed debit. The
 *   script printed a ledger of $89,158.21 where the book said $59,522.91 and
 *   an available of $67,797.03 where the book said $35,661.73. NOTHING was
 *   above the watermark; every cent of the gap was the missing value date, and
 *   it grew by $935.70 each time attack 6 appended another forward-dated recon
 *   settlement. NOT a standing order — that attribution was wrong for three
 *   hops and is corrected here: standing orders write no journal lines at all,
 *   and listDue() caps the due-date window at the book date, so one cannot
 *   future-date even in principle. The writer is the planted-break attack,
 *   which forward-dates ON PURPOSE so the run is reachable from the breaks
 *   screen, and its residue is now $5.30 a run rather than $935.70.
 *   This is migration 0022's own opening paragraph, happening again, here.
 *
 *   PENDING OUTBOUND was missing, and for AVAILABLE that is a red herring.
 *   Leaving the 2027 debit inside the ledger sum subtracts it once; taking it
 *   out and subtracting it as `pending_outbound_cents` subtracts it once. The
 *   two errors cancelled to the cent, which is precisely why the first one
 *   survived. It is not a red herring for the LEDGER figure, which was over by
 *   $29,635.30 — the $32,135.30 of credit less that same $2,500.00.
 *
 *   THE HOLD TERMS had no value-date gate, no card-event fold, no release
 *   clock, no watermark, no bucket for 'manual', and an ABS() that turns a
 *   malformed hold into MORE money withheld rather than less. All of it
 *   measured $0.00 today: this book carries no manual holds at all, and no
 *   live uncleared credit whose clock has already passed. Wrong by
 *   construction, right by coincidence — the catalogued shape. Gone, not
 *   patched.
 *
 * No application code enters this script's call stack. `ledger_availability()`
 * is in Postgres, reached by a SELECT over the wire, which is how the deployed
 * screens reach it too — a stronger claim than re-expressing it here, not a
 * weaker one.
 */
async function facts(businessId) {
  const [row] = await sql`
    WITH deposit AS (
      SELECT id FROM account
       WHERE code = '2100' AND book = 'financial' AND business_id = ${businessId}::uuid
    ),
    -- THE LIVE POINT. MATERIALIZED because clock_timestamp() is volatile and
    -- this must be ONE reading: the value date, the watermark and the instant
    -- handed to the function have to name the same moment or the five terms
    -- are not a position. These are v_available_balance's own three numbers.
    point AS MATERIALIZED (
      SELECT book_date(clock_timestamp())                                          AS value_date,
             COALESCE((SELECT MAX(e.booking_seq) FROM journal_entry e), 0)::bigint AS booking_seq,
             clock_timestamp()                                                     AS as_of
    )
    SELECT d.id               AS account_id,
           p.value_date::text AS value_date,
           p.booking_seq      AS booking_seq,
           av.ledger_cents,
           av.hold_cents,
           av.uncleared_cents,
           av.pending_outbound_cents,
           av.available_cents
      FROM deposit d
      CROSS JOIN point p
      CROSS JOIN LATERAL ledger_availability(d.id, p.value_date, p.booking_seq, p.as_of) av`;
  if (row === undefined) {
    throw new Failed(`business ${businessId} holds no open 2100 deposit account in the financial book`);
  }

  const f = {
    account: row.account_id,
    valueDate: row.value_date,
    watermark: cents(row.booking_seq),
    ledger: cents(row.ledger_cents),
    holds: cents(row.hold_cents),
    uncleared: cents(row.uncleared_cents),
    pendingOut: cents(row.pending_outbound_cents),
    available: cents(row.available_cents),
  };
  const point = `value date ${f.valueDate}, booking seq ${f.watermark}`;

  // TWO BODIES, HELD EQUAL, ON EVERY CALL.
  //
  // `balanceAsOf()` is this script's own two-axis sum — the query leg 6 reads
  // its "as believed" figure out of — and it is a genuinely separate body from
  // ledger_settled_cents() in Postgres. They are asked at the SAME point, and
  // the point is safe to re-ask: booking_seq is monotonic, so a row appended
  // between these two statements is above the watermark and invisible to both.
  agree("the settled LEDGER balance", point,
    { from: "ledger_availability(), the one definition", cents: f.ledger },
    { from: "balanceAsOf(), this script's own two-axis sum", cents: await balanceAsOf(f.account, f.valueDate, f.watermark) });

  // And the five terms re-added in JavaScript. If AVAILABLE is not exactly the
  // four terms printed beside it, it came from somewhere else.
  agree("AVAILABLE", point,
    { from: "ledger_availability().available_cents", cents: f.available },
    { from: "ledger - holds - uncleared - pending out", cents: f.ledger - f.holds - f.uncleared - f.pendingOut });

  return f;
}

/**
 * The balance of one account for everything up to a value date, AS BELIEVED at
 * a booking watermark.
 *
 * Two columns, two axes, one query. `value_date` is when it happened;
 * `booking_seq` is when we learned. Holding the value date still and moving the
 * watermark is what "what did we believe on Wednesday" means, and it is a pure
 * read — the corrected figure is not stored anywhere, it is this same query
 * with the watermark left open.
 */
async function balanceAsOf(accountId, valueDate, watermark) {
  const [row] = await sql`
    SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS cents
      FROM account a
      LEFT JOIN journal_line l
             ON l.account_id = a.id
            AND l.value_date  <= ${valueDate}::date
            AND l.booking_seq <= ${watermark}::bigint
     WHERE a.id = ${accountId}::uuid
     GROUP BY a.normal_side`;
  return cents(row?.cents ?? 0);
}

/**
 * Two readings of the same FIVE figures, formatted so the money can be
 * followed. PENDING OUT is a column rather than a footnote because AVAILABLE
 * subtracts it: four columns that do not add up to the fifth are how a reader
 * learns to stop trusting the table.
 */
function positionLines(label, before, after) {
  const cell = (v) => usd(v).padStart(13);
  const head = (t) => t.padStart(13);
  const row = (name, l, h, u, p, a) => `${name.padEnd(20)}${cell(l)}${cell(h)}${cell(u)}${cell(p)}${cell(a)}`;
  return [
    `${label.padEnd(20)}${head("LEDGER")}${head("HOLDS")}${head("UNCLEARED")}${head("PENDING OUT")}${head("AVAILABLE")}`,
    row("  before", before.ledger, before.holds, before.uncleared, before.pendingOut, before.available),
    row("  after", after.ledger, after.holds, after.uncleared, after.pendingOut, after.available),
    `${"  delta".padEnd(20)}${delta(before.ledger, after.ledger).padStart(13)}` +
      `${delta(before.holds, after.holds).padStart(13)}` +
      `${delta(before.uncleared, after.uncleared).padStart(13)}` +
      `${delta(before.pendingOut, after.pendingOut).padStart(13)}` +
      `${delta(before.available, after.available).padStart(13)}`,
    ...provenance(after),
  ];
}

/* ========================================================================== */
/* The leg harness — the verdict is a fold, never a claim                     */
/* ========================================================================== */

class Skip extends Error {}
class Failed extends Error {}

const LEGS = [
  { n: 1, title: "KYB gate: an unverified business REFUSED with its code, a verified one allowed" },
  { n: 2, title: "Fund from a linked external bank: LEDGER rises, AVAILABLE does not" },
  { n: 3, title: "Issue a real (sandbox) card through /accounts" },
  { n: 4, title: "Authorise $50.00, settle $73.40: hold releases exactly once" },
  { n: 5, title: "Outbound payment needing a second approver, initiator refused by the trigger" },
  { n: 6, title: "Survive a reversed settlement: corrected figure at the original value date" },
  { n: 7, title: "Reconcile the scheme file: a planted break with its kind and its age" },
];

const results = new Map();

/** Run one leg. Nothing in here decides its own verdict. */
async function runLeg(spec, fn) {
  const record = { checks: [], evidence: [], skip: null, error: null };
  const ctx = {
    check(condition, text) {
      const ok = condition === true;
      record.checks.push({ ok, text });
      if (!ok) throw new Failed(text);
      return true;
    },
    note(...lines) {
      for (const line of lines.flat()) record.evidence.push(String(line));
    },
    skip(reason) {
      throw new Skip(reason);
    },
  };

  const startedAt = Date.now();
  try {
    await fn(ctx);
  } catch (thrown) {
    if (thrown instanceof Skip) record.skip = thrown.message;
    else if (thrown instanceof Failed) record.error = thrown.message;
    else record.error = `${thrown?.constructor?.name ?? "Error"}: ${thrown?.message ?? String(thrown)}`;
  }
  record.ms = Date.now() - startedAt;
  results.set(spec.n, record);

  // Printed as it happens, so a long run is watchable rather than silent.
  const v = verdict(spec.n);
  process.stdout.write(
    `  ${String(spec.n).padStart(2)}  ${DIM(v.status.padEnd(4))} ${DIM(spec.title.slice(0, 68))}\n`,
  );
  return record;
}

/**
 * PASS only when the leg recorded at least one check and every one of them
 * held. A leg that checked nothing is not a pass; a leg that skipped is not a
 * pass; a leg that threw is a fail. There is deliberately no fourth branch.
 */
function verdict(n) {
  const r = results.get(n);
  if (r === undefined) return { status: "SKIP", detail: "not run in this invocation" };
  if (r.error !== null) {
    const failed = r.checks.filter((c) => !c.ok).length;
    const passed = r.checks.filter((c) => c.ok).length;
    return {
      status: "FAIL",
      detail: `${passed} checks held, then: ${r.error}`,
      counts: { passed, failed },
    };
  }
  if (r.skip !== null) {
    return { status: "SKIP", detail: `${r.checks.filter((c) => c.ok).length} checks held before the leg stopped` };
  }
  if (r.checks.length === 0) {
    return { status: "SKIP", detail: "the leg asserted nothing, so it proves nothing" };
  }
  const passed = r.checks.filter((c) => c.ok).length;
  if (passed !== r.checks.length) {
    return { status: "FAIL", detail: `${passed}/${r.checks.length} checks held` };
  }
  return { status: "PASS", detail: `${passed}/${passed} checks`, counts: { passed, failed: 0 } };
}

/* ========================================================================== */
/* Run                                                                        */
/* ========================================================================== */

const envLoaded = loadDotEnv(resolve(ROOT, ".env")) + loadDotEnv(resolve(ROOT, ".env.local"));

if (!process.env.APP_DATABASE_URL) {
  console.error(
    "APP_DATABASE_URL is not set. This run reads the live database to prove what the\n" +
      "deployed writes actually did. Load it with:  set -a; . ./.env; set +a",
  );
  process.exit(2);
}

sql = postgres(process.env.APP_DATABASE_URL, {
  max: 1,
  onnotice: () => {},
  // BIGINT must not silently become a JS number, here for the same reason it
  // must not in `src/lib/ledger/db.ts`: money is bigint cents, and a driver
  // that hands back a string turns `ledger - holds` into string arithmetic and
  // `=== 5000n` into a comparison that is always false. Measured: it did.
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (v) => v.toString(),
      parse: (v) => BigInt(v),
    },
  },
});

const selected = args.only === null ? LEGS : LEGS.filter((l) => args.only.includes(l.n));
if (selected.length === 0) {
  console.error("no legs selected");
  process.exit(2);
}

/** `CL-XXXXXXXX`. Every reference this run controls carries it. */
const RUN = `CL-${Date.now().toString(36).toUpperCase()}`;
const startedAt = new Date();
const today = new Date().toISOString().slice(0, 10);

/* -------------------------------------------------------------------------- */
/* The business. One, carried through all seven legs.                         */
/* -------------------------------------------------------------------------- */

/**
 * The subject is chosen by ASKING THE DEPLOYED GATE, never by a hard-coded id
 * and never by a re-implementation of the gate's rule in this file.
 *
 * The candidates are the businesses that hold both leaves of the chart — a
 * 2100 deposit account and its 9100 memo account — because a business without
 * both cannot hold a card hold. Which of those may transact is then decided by
 * pressing "Try to start a payment" on the deployed `/onboarding` screen for
 * each of them and reading the answer: the first one the deployment ALLOWS is
 * the business this whole run carries, and the first it REFUSES is leg 1's
 * foil. Re-deriving `canTransact()`'s rule here would be a second opinion that
 * can drift from the first, which is the exact failure the KYB leg exists to
 * catch.
 *
 * ── WHAT THE RANKING WAS MISSING, AND WHY IT MATTERED ──────────────────────
 *
 * It read `kyb_evidence` out of the view and then never used it. So among the
 * businesses the gate ALLOWS the tiebreak fell through to `legs_on_file` and
 * then to `localeCompare`, and the alphabet chose the subject: "Hold Fuzzer
 * Fixture Co.", approved on two legs by `simulated-hold-fuzzer`, sorted ahead
 * of "Kettle & Crumb Bakery LLC" and "Ridgeline Robotics, Inc.", both of which
 * carry a real GLEIF call and a real Stripe Identity verification in their leg
 * history.
 *
 * Leg 1's whole claim is "a REAL KYB check", and the run was demonstrating it
 * on the business verified by our own simulator. Nothing about that is a
 * falsehood the script tells — every line it printed was true — but the
 * evidence it chose to print was the weakest available, which is the same
 * defect as a guard that excludes the failure it looks for, pointed at a demo.
 *
 * So evidence is now a ranking term, ahead of the alphabet:
 *
 *   1. the deployed gate's answer (ALLOWED first) — unchanged, and still the
 *      only thing that decides a VERDICT rather than an order;
 *   2. the rolled evidence tier: live > manual > simulated. `v_business_kyb`
 *      rolls the WEAKEST leg, so this is "how good is the worst evidence
 *      behind this business";
 *   3. how many of its two legs are, at their latest observation, still
 *      standing on a live third-party answer;
 *   4. legs on file, then the alphabet, as before — a total order, so the
 *      choice stays deterministic and a run is reproducible.
 */
const candidates = await sql`
  SELECT dep.business_id       AS business_id,
         b.legal_name          AS legal_name,
         dep.id                AS deposit_account,
         memo.id               AS memo_account,
         b.ein                 AS ein,
         k.legs_on_file        AS legs_on_file,
         k.kyb_status::text    AS kyb_status,
         k.kyb_evidence::text  AS kyb_evidence,
         -- The two legs, named, so the header can say WHICH provider answered
         -- rather than only how strong the weakest answer was.
         k.registry_provider   AS registry_provider,
         k.registry_evidence::text AS registry_evidence,
         k.director_provider   AS director_provider,
         k.director_evidence::text AS director_evidence,
         (CASE WHEN k.registry_evidence::text = 'live' THEN 1 ELSE 0 END
        + CASE WHEN k.director_evidence::text = 'live' THEN 1 ELSE 0 END) AS live_legs
    FROM account dep
    JOIN account memo    ON memo.business_id = dep.business_id AND memo.code = '9100'
    JOIN business b      ON b.id = dep.business_id
    JOIN v_business_kyb k ON k.business_id = dep.business_id
   WHERE dep.code = '2100' AND dep.closed_at IS NULL
   ORDER BY b.legal_name`;

// Sign in BEFORE anything is pressed. Pressing the gate anonymously is what
// produced `NO_STATE(401)` in the column headed by KYB codes, and sent a reader
// to debug KYB when the actual defect was that nobody had signed in.
authFailure = await signIn();

const onboardingHtml = await getPage("/onboarding");
const onboardingForms = parseForms(onboardingHtml);
const gateAnswers = [];
for (const candidate of candidates) {
  const form = findForm(onboardingForms, { where: { businessId: candidate.business_id } });
  if (form === null) {
    // "I found no control to press" is not a KYB verdict, so it is not marked
    // as a refusal. `answered: false` is what keeps it out of every sentence
    // below that speaks about what the gate decided.
    gateAnswers.push({
      ...candidate,
      answered: false,
      allowed: false,
      httpStatus: null,
      code: "GATE_NOT_RENDERED",
      why: `/onboarding renders no verification control for this business, so the gate was never pressed`,
      message: "",
    });
    continue;
  }
  const answer = await submitForm("/onboarding", form, {
    businessId: candidate.business_id,
    intent: "gate",
  });

  /**
   * THREE OUTCOMES, NOT TWO, AND THE THIRD IS THE ONE THAT WAS A LIE.
   *
   * `answered` means the gate action ran and returned a verdict. Only then is
   * `allowed`/`code` a statement about KYB.
   *
   * When the POST is turned away at the door — 401 with no session, 503 with
   * the deployment's passphrase unset — the gate was never reached. The old
   * code wrote `NO_STATE(401)`, its own fallback for "I could not tell", into
   * the same `code` field that otherwise carries `KYB_REJECTED` and
   * `KYB_PENDING`, printed it under a column of KYB codes, and let a reader
   * conclude the KYB subsystem had refused six businesses. It had not been
   * asked. The label now names the door.
   */
  const answered = answer.state !== null;
  const atTheDoor = answer.status === 401 || answer.status === 503;
  gateAnswers.push({
    ...candidate,
    actionId: form.actionId,
    answered,
    allowed: answered && answer.state.status === "ok",
    httpStatus: answer.status,
    code: answered
      ? answer.state.code
      : atTheDoor
        ? `SIGN_IN_REQUIRED(${answer.status})`
        : `GATE_SILENT(${answer.status})`,
    why: answered
      ? null
      : atTheDoor
        ? `the POST was refused at the door with HTTP ${answer.status}; canTransact() never ran, so this run has NO KYB reading for this business`
        : `the POST answered HTTP ${answer.status} and returned no action state; canTransact() may not have run, so this run has NO KYB reading for this business`,
    message: answer.state?.message ?? "",
  });
}

/**
 * ALLOWED / REFUSED / UNKNOWN. The third is printed as loudly as the others
 * precisely because it is the one that used to be dressed as the second.
 */
const gateMark = (a) => (a.answered ? (a.allowed ? "ALLOWED " : "REFUSED ") : "UNKNOWN ");

/** Did the gate answer for ANY candidate? If not, this run knows nothing about KYB. */
const gateWasReached = () => gateAnswers.some((a) => a.answered);

/**
 * How close a refusal is to an allowance, so a run on a book where the gate
 * currently allows nobody still has a subject to carry and still says why.
 * Lower is closer. This ranking chooses a SUBJECT; it never decides a verdict.
 */
const GATE_RANK = {
  KYB_ALLOWED: 0,
  KYB_NEEDS_REVIEW: 1,
  KYB_EVIDENCE_SIMULATED: 2,
  KYB_PENDING: 3,
  KYB_NOT_STARTED: 4,
  KYB_STATE_UNREADABLE: 5,
  KYB_REJECTED: 6,
};
// A gate that never answered is ranked as UNKNOWN (8), between the worst real
// refusal and the truly unrecognised (9). It is emphatically NOT ranked as a
// KYB refusal, because it is not one.
const rankOf = (answer) =>
  answer.allowed ? -1 : !answer.answered ? 8 : (GATE_RANK[answer.code] ?? 9);

/**
 * How strong the WEAKEST leg's evidence is. Lower is stronger.
 *
 * The enum's own order is `live, manual, simulated` and `v_business_kyb` rolls
 * the business up with `max(evidence)`, i.e. the weakest leg — so this reads
 * the same scale the schema already committed to rather than inventing a
 * second one. `manual` outranks `simulated` and is beneath `live` for the
 * reason 038 gives: an operator review is a real decision by a real person
 * recorded against a real provider answer, and a simulator's approval is a
 * fixture agreeing with itself.
 */
const EVIDENCE_RANK = { live: 0, manual: 1, simulated: 2 };
const evidenceRankOf = (answer) => EVIDENCE_RANK[answer.kyb_evidence] ?? 3;

// Allowed first — the gate, never re-derived here. Then the strength of the
// evidence behind the business, because leg 1's claim is "a real KYB check"
// and demonstrating it on the business our own simulator approved proves the
// simulator. Then live legs, legs on file, and finally the alphabet, which
// makes the order total and the run reproducible.
const ranked = [...gateAnswers].sort(
  (a, b) =>
    rankOf(a) - rankOf(b) ||
    evidenceRankOf(a) - evidenceRankOf(b) ||
    Number(b.live_legs ?? 0) - Number(a.live_legs ?? 0) ||
    Number(b.legs_on_file ?? 0) - Number(a.legs_on_file ?? 0) ||
    a.legal_name.localeCompare(b.legal_name),
);

/**
 * `--business` overrides the ranking and NOTHING ELSE.
 *
 * It does not skip the gate, does not assume an answer, and does not lower a
 * bar: the named business was pressed against the deployed `/onboarding` gate
 * with every other candidate, above, and if the deployment refuses it the legs
 * that need a transactable business will skip and say so — exactly as they do
 * for the ranked subject. The flag chooses WHICH business the run carries; it
 * has no opinion about what the run then finds.
 *
 * A name that matches nothing is a hard exit rather than a silent fallback to
 * the ranked subject: a run that quietly carried a different business than the
 * one asked for would print seven verdicts about the wrong entity.
 */
let subject = ranked[0];
if (args.business !== null) {
  const needle = String(args.business).trim().toLowerCase();
  const chosen = ranked.filter(
    (c) =>
      String(c.business_id).toLowerCase() === needle ||
      String(c.legal_name).toLowerCase().includes(needle),
  );
  if (chosen.length === 0) {
    console.error(`--business ${args.business}: no candidate business matches.`);
    console.error("Candidates on this book:");
    for (const c of ranked) console.error(`  ${c.business_id}  ${c.legal_name}`);
    await sql.end();
    process.exit(2);
  }
  if (chosen.length > 1) {
    console.error(`--business ${args.business}: matches ${chosen.length} businesses; be more specific.`);
    for (const c of chosen) console.error(`  ${c.business_id}  ${c.legal_name}`);
    await sql.end();
    process.exit(2);
  }
  subject = chosen[0];
}

// A foil is a business the gate ACTUALLY REFUSED. One it never answered for is
// not a foil — leg 1's claim is "refused with its code", and a business with no
// reading has no code to be refused with.
const foil = gateAnswers.find(
  (c) => c.answered && !c.allowed && c.business_id !== subject?.business_id,
);

if (subject === undefined) {
  console.error("no business on this book holds both a 2100 deposit account and a 9100 memo account");
  await sql.end();
  process.exit(2);
}

if (args.listSubjects) {
  console.log("");
  console.log("  CANDIDATE SUBJECTS, in the order this script ranks them");
  console.log("  gate answer, then evidence tier, then live legs, then legs on file, then name");
  console.log("");
  for (const c of ranked) {
    console.log(
      `    ${gateMark(c)}${String(c.code).padEnd(22)}` +
        ` ${String(c.legal_name).padEnd(34)} evidence ${String(c.kyb_evidence).padEnd(10)}` +
        ` live legs ${c.live_legs}  registry ${c.registry_provider ?? "(none)"}` +
        ` / director ${c.director_provider ?? "(none)"}` +
        (c.business_id === ranked[0]?.business_id ? "   <- default subject" : ""),
    );
    console.log(`      --business ${c.business_id}`);
  }
  console.log("");
  await sql.end();
  process.exit(0);
}

const BIZ = subject.business_id;
const DEPOSIT = subject.deposit_account;
const CONSOLE_PATH = `/accounts?business=${BIZ}`;

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

console.log("");
console.log(RULE);
console.log("  THE CORE LOOP — one business, seven legs, against the DEPLOYED system");
console.log(THIN);
console.log(`  target        ${baseUrl}`);
console.log(`  database      ${describeDatabase(process.env.APP_DATABASE_URL)}  (read only)`);
console.log(`  providers     Lithic sandbox ${process.env.LITHIC_API_KEY ? "LIVE" : "no key"}` +
  ` · Plaid ${process.env.PLAID_SECRET ? "LIVE" : "no key"}` +
  ` · drain ${process.env.DRAIN_TOKEN ? "token held" : "NO TOKEN"}`);
console.log(`  env           ${envLoaded} values read from .env`);
console.log(
  `  session       ` +
    (authFailure === null
      ? GREEN("signed in — POST /signin with $CONSOLE_PASSWORD; corgi_console cookie held on every request below")
      : RED("NONE — the write legs will FAIL by name, not skip")),
);
console.log(`  run           ${RUN}   started ${startedAt.toISOString()}`);
console.log(THIN);
console.log("  THE BUSINESS — every figure below belongs to this one entity");
console.log(`    legal name        ${subject.legal_name}`);
console.log(`    business id       ${BIZ}`);
console.log(`    EIN               ${subject.ein ?? "(none on file)"}`);
console.log(`    2100 deposit      ${DEPOSIT}`);
console.log(`    9100 memo         ${subject.memo_account}`);
console.log(`    console           ${baseUrl}${CONSOLE_PATH}`);
console.log(THIN);
console.log(
  args.business === null
    ? "  WHY THIS BUSINESS — the deployed gate was asked, live, before anything else ran"
    : `  WHY THIS BUSINESS — NAMED on the command line (--business ${args.business}); the deployed` +
      "\n                      gate was still asked about every candidate below, live, first",
);
for (const answer of ranked) {
  const mark = gateMark(answer);
  const role =
    answer.business_id === subject.business_id
      ? "  <- the subject"
      : foil !== undefined && answer.business_id === foil.business_id
        ? "  <- leg 1's foil"
        : "";
  console.log(
    `    ${mark} ${String(answer.code).padEnd(22)} ${String(answer.legal_name).padEnd(32)}` +
      ` ${answer.kyb_status}/${answer.kyb_evidence}, ${answer.legs_on_file} leg(s),` +
      ` ${answer.live_legs} live${role}`,
  );
}
// The evidence behind leg 1's claim, named rather than summarised: "a real KYB
// check" is only worth reading if the reader can see WHICH provider answered.
console.log(
  `    evidence          registry ${subject.registry_provider ?? "(none on file)"}` +
    ` (${subject.registry_evidence ?? "none"}) · director ${subject.director_provider ?? "(none on file)"}` +
    ` (${subject.director_evidence ?? "none"})`,
);
if (subject.kyb_evidence === "simulated") {
  console.log("");
  console.log(YELLOW("    The strongest evidence available on this book is SIMULATED. Leg 1 will say so, and"));
  console.log(YELLOW("    the run demonstrates the gate rather than a real KYB check. That is a fact about"));
  console.log(YELLOW("    the book, not a pass: --list-subjects shows what else is here."));
}
if (!gateWasReached()) {
  // THE MISDIAGNOSIS THIS BLOCK EXISTS TO PREVENT.
  //
  // This used to print "The gate allows NO business on this book right now"
  // whenever `allowed` was false — including when `allowed` was false only
  // because every probe had been turned away at the door with a 401. A panel
  // reading that line was sent to debug KYB. Nothing had asked KYB anything.
  console.log("");
  console.log(RED("    THE GATE WAS NEVER ASKED — nothing above is a KYB finding."));
  console.log(
    RED(`    Every probe was turned away before canTransact() ran (${subject.code}). The codes in`),
  );
  console.log(RED("    that column are this script saying IT COULD NOT TELL, not a verdict from the gate."));
  if (authFailure !== null) {
    console.log("");
    console.log(RED(`    ${authFailure}`));
    for (const line of wrap(authRemedy, WIDTH - 6, 0)) console.log(DIM(`    ${line.trim()}`));
  }
  console.log("");
  console.log(RED("    The write legs below FAIL by name on this. They do not skip: a skip is not a pass."));
} else if (!subject.allowed) {
  console.log("");
  console.log(YELLOW("    The gate allows NO business on this book right now. The subject below is the one"));
  console.log(YELLOW(`    closest to allowed (${subject.code}); the legs that need a transactable business`));
  console.log(YELLOW("    will skip, and will say so."));
} else if (!subject.answered) {
  console.log("");
  console.log(YELLOW(`    The gate answered for other businesses but not for ${subject.legal_name}:`));
  console.log(YELLOW(`    ${subject.why}. This run carries NO KYB reading for the subject.`));
}
console.log(RULE);
console.log("");

const opening = await facts(BIZ);
console.log(`  OPENING POSITION   ledger ${usd(opening.ledger)} · holds ${usd(opening.holds)}` +
  ` · uncleared ${usd(opening.uncleared)} · pending out ${usd(opening.pendingOut)}` +
  ` · available ${usd(opening.available)}`);
for (const line of provenance(opening)) console.log(DIM(`  ${line}`));
console.log("");
console.log(DIM("  Every write below is a form POSTed to its server action on the deployed origin."));
console.log(DIM("  Provider legs wait for the real webhook and nudge POST /api/drain. This takes minutes."));
console.log("");
console.log(THIN);

for (const path of ["/", CONSOLE_PATH, "/payments", "/approvals", "/onboarding", "/funding"]) {
  for (const [id, name] of await discoverActionNames(path)) ACTION_NAMES.set(id, name);
}

const want = (n) => selected.some((l) => l.n === n);

/* State carried between legs. */
const carried = {
  cardToken: null,
  cardLastFour: null,
  transactionToken: null,
  authHoldId: null,
  settlementValueDate: null,
  settlementEntryId: null,
  instructionId: null,
};

/* ========================================================================== */
/* LEG 1 — the KYB gate                                                       */
/* ========================================================================== */

if (want(1)) {
  await runLeg(LEGS[0], async (t) => {
    // The door, first and by name. Pressing the gate without a session answers
    // 401 and returns no state, and EVERY sentence this leg would then print
    // about KYB would be this script guessing. So it fails here, on the real
    // cause, rather than four lines down on a symptom.
    t.check(authFailure === null, authFailure);

    if (foil === undefined) {
      t.skip(
        gateWasReached()
          ? "no business on this book was REFUSED by the gate, so there is no unverified foil to refuse"
          : "the gate answered for no business at all, so this run cannot name a foil it refused",
      );
    }

    // ---- the refusal, which is the interesting half ------------------------
    const onboarding = await getPage("/onboarding");
    const foilForm = findForm(parseForms(onboarding), { where: { businessId: foil.business_id } });
    if (foilForm === null) {
      t.skip(`/onboarding renders no verification form for ${foil.legal_name}, so the gate cannot be pressed`);
    }
    const refusal = await submitForm("/onboarding", foilForm, {
      businessId: foil.business_id,
      intent: "gate",
    });
    t.check(refusal.status === 200, postFailure("the gate POST", refusal));
    t.check(
      refusal.state !== null,
      `the gate POST answered ${refusal.status} but the action returned no state to the re-rendered ` +
        `page, so canTransact() gave this run NO reading — this is an unreadable response, not a KYB verdict`,
    );
    t.check(
      refusal.state.status === "refused",
      `the gate ALLOWED ${foil.legal_name}: ${refusal.state.code}`,
    );
    t.check(
      typeof refusal.state.code === "string" && refusal.state.code.startsWith("KYB_"),
      `the refusal carries no KYB code (got ${refusal.state.code})`,
    );
    t.note(
      `action        ${nameOf(foilForm.actionId)}  <- read off the live form, not hard-coded`,
      `POST /onboarding  intent=gate  businessId=${foil.business_id}`,
      `REFUSED       ${foil.legal_name} -> ${refusal.state.code}`,
      wrap(refusal.state.message, WIDTH - 22, 16).map((l) => l.trim()).join(" ").slice(0, 300),
    );

    // ---- the money path refuses too, at the same gate ----------------------
    const payments = await getPage("/payments");
    const payForm = findForm(parseForms(payments), { has: ["accountId", "rail", "amount", "reference"] });
    if (payForm !== null) {
      const blocked = await submitForm("/payments", payForm, {
        accountId: foil.deposit_account,
        rail: "ach",
        amount: "10.00",
        valueDate: today,
        reference: `${RUN}-GATE`,
        holderName: "Gate Probe LLC",
        routingNumber: "021000021",
        accountNumberLast4: "4417",
        accountType: "checking",
      });
      t.check(
        blocked.state !== null && blocked.state.status === "refused",
        `raising a payment for the unverified business was NOT refused: ${JSON.stringify(blocked.state)}`,
      );
      const [written] = await sql`
        SELECT count(*)::int AS n FROM payment_instruction
         WHERE idempotency_key = ${`console:${foil.deposit_account}:${RUN}-GATE`}`;
      t.check(written.n === 0, `the refused payment still wrote ${written.n} instruction row(s)`);
      t.note(
        `action        ${nameOf(payForm.actionId)}`,
        `POST /payments for the same business -> ${blocked.state.code}` +
          `   rows written: ${written.n}`,
      );
    }

    // ---- and the verified business is allowed ------------------------------
    const subjectForm = findForm(parseForms(onboarding), { where: { businessId: BIZ } });
    t.check(subjectForm !== null, `/onboarding renders no verification form for ${subject.legal_name}`);
    const allowed = await submitForm("/onboarding", subjectForm, { businessId: BIZ, intent: "gate" });
    t.check(allowed.status === 200, postFailure("the gate POST for the subject", allowed));
    t.check(
      allowed.state !== null,
      `the gate POST for the subject answered ${allowed.status} and returned no action state, so ` +
        `canTransact() gave this run NO reading for ${subject.legal_name} — unreadable, not refused`,
    );

    if (allowed.state.status !== "ok") {
      const view = await sql`
        SELECT legal_name, kyb_status::text AS status, kyb_evidence::text AS evidence,
               legs_on_file, director_status::text AS director, registry_status::text AS registry
          FROM v_business_kyb WHERE business_id IS NOT NULL ORDER BY legal_name`;
      t.note(
        "",
        "the second half of this leg — a verified business ALLOWED — could not be shown:",
        ...view.map(
          (v) =>
            `  ${String(v.legal_name).padEnd(32)} ${String(v.status).padEnd(13)} ${String(v.evidence).padEnd(10)}` +
            ` legs=${v.legs_on_file} director=${v.director ?? "-"} registry=${v.registry ?? "-"}`,
        ),
      );
      t.skip(
        `the deployed gate refuses every business it gave this run a reading for ` +
          `(${gateAnswers.filter((a) => a.answered).length} of ${gateAnswers.length} candidates; the rest ` +
          `it never answered for, which is not a refusal) — ` +
          gateAnswers
            .map((a) => `${a.legal_name}=${a.answered ? a.code : `no reading (${a.code})`}`)
            .join(", ") +
          `. The refusal half of this leg is proven above; the allowance half needs a business ` +
          `canTransact() lets through, and the KYB legs are being re-observed live right now ` +
          `(v_business_kyb above is the current reading). Nothing here can manufacture one: a ` +
          `verification status written by this script would not be a KYB check.`,
      );
    }

    t.check(
      allowed.state.code === "KYB_ALLOWED",
      `the gate allowed the business with an unexpected code: ${allowed.state.code}`,
    );

    const legs = await sql`
      SELECT DISTINCT ON (leg) leg, provider, provider_reference, status, evidence, observed_at
        FROM kyb_verification_leg WHERE business_id = ${BIZ}::uuid
       ORDER BY leg, observed_at DESC, seq DESC`;
    t.check(legs.length > 0, "the verified business has no KYB legs on file at all");
    t.note(
      `ALLOWED       ${subject.legal_name} -> ${allowed.state.code}`,
      ...legs.map(
        (l) =>
          `  leg ${String(l.leg).padEnd(18)} ${String(l.status).padEnd(10)} ${String(l.evidence).padEnd(10)}` +
          ` ${l.provider} / ${l.provider_reference}`,
      ),
    );
  });
}

/* ========================================================================== */
/* LEG 2 — fund it from a linked external bank                                */
/* ========================================================================== */

if (want(2)) {
  await runLeg(LEGS[1], async (t) => {
    // The door, first and by name: this leg writes, and a write with no session
    // is refused before the subsystem it names is ever reached.
    t.check(authFailure === null, authFailure);

    const probe = await http("/funding", { headers: cookieFor(null) });
    if (probe.status !== 200) {
      t.skip(
        `GET /funding on the deployed origin answers ${probe.status}. The funding screen exists in ` +
          `src/app/(app)/funding/ but is not on this deployment, so there is no surface to POST a ` +
          `linked-bank credit to. Nothing else can stand in: writing the entry from this script is ` +
          `exactly the shortcut this run refuses to take.`,
      );
    }

    const form = findForm(parseForms(probe.body), {
      has: ["accountId", "amount", "valueDate", "reference"],
    });
    if (form === null) {
      t.skip("/funding renders, but carries no fund form with accountId/amount/valueDate/reference");
    }

    // The text posted and the cents asserted are the SAME number, proven here
    // rather than assumed: a form takes dollars-and-cents text and this run
    // asserts in bigint cents, and a mismatch between the two is exactly the
    // class of bug the ledger's integer-minor-units rule exists to prevent.
    const amountText = "1250.00";
    const amount = usdToCents(amountText);
    const before = await facts(BIZ);
    const reference = `${RUN}-FUND`;

    const sent = await submitForm("/funding", form, {
      accountId: DEPOSIT,
      amount: amountText,
      valueDate: today,
      reference,
    });
    t.check(sent.status === 200, postFailure("the funding POST", sent));
    t.check(sent.state !== null, "the funding action returned no state to the re-rendered page");
    t.check(
      sent.state.status === "ok",
      `funding was refused: ${sent.state.code} — ${String(sent.state.message).slice(0, 200)}`,
    );

    const after = await facts(BIZ);
    t.check(
      after.ledger - before.ledger === amount,
      `LEDGER moved ${delta(before.ledger, after.ledger)}, expected ${usd(amount)}`,
    );
    t.check(
      after.available === before.available,
      `AVAILABLE moved ${delta(before.available, after.available)} — an inbound credit must not be ` +
        `spendable until the return window passes`,
    );
    t.check(
      after.uncleared - before.uncleared === amount,
      `UNCLEARED moved ${delta(before.uncleared, after.uncleared)}, expected ${usd(amount)}`,
    );

    const [hold] = await sql`
      SELECT h.id, h.kind, h.available_at, h.value_date
        FROM hold h JOIN account a ON a.id = h.account_id
       WHERE a.business_id = ${BIZ}::uuid AND h.kind = 'uncleared_credit'
         AND h.external_ref LIKE ${`%${reference}%`}
       ORDER BY h.created_at DESC LIMIT 1`;
    t.check(hold !== undefined, `no uncleared_credit hold carries the run reference ${reference}`);

    t.note(
      `action        ${nameOf(form.actionId)}`,
      `POST /funding  ${usd(amount)} to ${DEPOSIT}  reference ${reference}`,
      `result        ${sent.state.code}`,
      ...positionLines("figures", before, after),
      `hold          ${hold.id}  kind=${hold.kind}  releases ` +
        `${hold.available_at instanceof Date ? hold.available_at.toISOString() : (hold.available_at ?? "(no release time)")}`,
      `the ledger is up ${usd(amount)} and available has not moved a cent: the identical amount is`,
      `withheld by an uncleared-credit hold until the availability policy releases it.`,
    );
  });
}

/* ========================================================================== */
/* LEG 3 — issue a real (sandbox) card                                        */
/* ========================================================================== */

if (want(3)) {
  await runLeg(LEGS[2], async (t) => {
    // The door, first and by name: this leg writes, and a write with no session
    // is refused before the subsystem it names is ever reached.
    t.check(authFailure === null, authFailure);

    const page = await getPage(CONSOLE_PATH);
    const form = findForm(parseForms(page), { where: { businessId: BIZ }, has: ["formKey", "nickname"] });
    if (form === null) {
      t.skip(`the console at ${CONSOLE_PATH} renders no issue-card form for this business`);
    }

    const nickname = `corgi core loop ${RUN}`;
    const issued = await submitForm(CONSOLE_PATH, form, { businessId: BIZ, nickname });
    t.check(issued.status === 200, postFailure("the issue-card POST", issued));
    t.check(issued.state !== null, "the issue-card action returned no state to the re-rendered page");
    t.check(
      issued.state.status === "ok",
      `the card was not issued: ${issued.state.code} — ${String(issued.state.message).slice(0, 220)}`,
    );

    const factList = Array.isArray(issued.state.facts) ? issued.state.facts : [];
    const fact = (label) => factList.find((f) => String(f.label).toLowerCase().includes(label))?.value ?? null;
    const token = fact("card token");
    const lastFour = fact("last four");
    t.check(
      typeof token === "string" && /^[0-9a-f-]{36}$/.test(token),
      `the action returned no Lithic card token (got ${token})`,
    );
    t.check(/^\d{4}$/.test(String(lastFour)), `the action returned no last four (got ${lastFour})`);

    const [row] = await sql`
      SELECT id, provider, provider_card_token, last_four, nickname, account_id, memo_account_id, created_at
        FROM card WHERE provider_card_token = ${token}`;
    t.check(row !== undefined, `the card is not registered in this ledger under ${token}`);
    t.check(row.nickname === nickname, `the registered nickname is "${row.nickname}", expected "${nickname}"`);
    t.check(
      row.account_id === DEPOSIT,
      `the card is bound to account ${row.account_id}, not this business's 2100 (${DEPOSIT})`,
    );
    t.check(row.last_four === String(lastFour), "the registered last four disagrees with Lithic's");

    carried.cardToken = token;
    carried.cardLastFour = String(lastFour);

    t.note(
      `action        ${nameOf(form.actionId)}`,
      `POST ${CONSOLE_PATH}  (issue card)`,
      `Lithic card   ${token}`,
      `last four     ${lastFour}     nickname "${nickname}"`,
      ...factList
        .filter((f) => !/card token|last four/i.test(String(f.label)))
        .map((f) => `  ${String(f.label).padEnd(14)} ${f.value}`),
      `bound in this ledger to 2100 ${row.account_id} / 9100 ${row.memo_account_id}`,
    );
  });
}

/* ========================================================================== */
/* LEG 4 — authorise $50.00, settle $73.40                                    */
/* ========================================================================== */

const AUTH_TEXT = "50.00";
const CLEAR_TEXT = "73.40";
const AUTH_CENTS = usdToCents(AUTH_TEXT);
const CLEAR_CENTS = usdToCents(CLEAR_TEXT);

if (want(4)) {
  await runLeg(LEGS[3], async (t) => {
    t.check(authFailure === null, authFailure);

    if (carried.cardToken === null) {
      t.skip(
        "leg 3 produced no card token, so there is nothing to authorise against" +
          (results.get(3)?.error === null || results.get(3) === undefined
            ? ""
            : ` — leg 3's own reason: ${results.get(3).error}`),
      );
    }

    /* ---- the authorisation ------------------------------------------------ */
    const before = await facts(BIZ);
    const page = await getPage(CONSOLE_PATH);
    const authForm = findForm(parseForms(page), {
      where: { businessId: BIZ },
      has: ["cardToken", "amount", "mcc", "descriptor"],
    });
    t.check(authForm !== null, `the console renders no authorise form for ${BIZ}`);

    const descriptor = `CORGI PUMP ${RUN}`.slice(0, 25);
    const authed = await submitForm(CONSOLE_PATH, authForm, {
      businessId: BIZ,
      cardToken: carried.cardToken,
      amount: AUTH_TEXT,
      mcc: "5542",
      descriptor,
    });
    t.check(authed.status === 200, postFailure("the authorise POST", authed));
    t.check(authed.state !== null, "the authorise action returned no state");
    t.check(
      authed.state.status !== "refused",
      `Lithic refused the authorisation: ${authed.state.code} — ${String(authed.state.message).slice(0, 220)}`,
    );

    const authFacts = Array.isArray(authed.state.facts) ? authed.state.facts : [];
    const txnToken =
      authFacts.find((f) => /transaction token/i.test(String(f.label)))?.value ?? null;
    t.check(
      typeof txnToken === "string" && /^[0-9a-f-]{36}$/.test(txnToken),
      `no Lithic transaction token came back (got ${txnToken})`,
    );
    carried.transactionToken = txnToken;

    // The webhook is a REAL provider delivery to the deployed endpoint. Wait
    // for it, nudging the deployed drain — never writing the row ourselves.
    const landed = await waitForDrained("the authorisation webhook", async () => {
      const [row] = await sql`
        SELECT ca.id, ca.hold_id, ca.account_id, ca.first_seen_at
          FROM card_authorization ca
         WHERE ca.provider_auth_id = ${txnToken}`;
      return row ?? null;
    });
    t.check(
      landed.ok,
      `the authorisation webhook never became a hold in this ledger after ${landed.waitedMs / 1000}s ` +
        `of waiting and ${landed.drains.length} drains`,
    );
    carried.authHoldId = landed.value.hold_id;

    const afterAuth = await facts(BIZ);
    t.check(
      afterAuth.ledger === before.ledger,
      `the LEDGER moved ${delta(before.ledger, afterAuth.ledger)} on an authorisation — it must not move at all`,
    );
    t.check(
      afterAuth.holds - before.holds === AUTH_CENTS,
      `holds moved ${delta(before.holds, afterAuth.holds)}, expected ${usd(AUTH_CENTS)}`,
    );
    t.check(
      afterAuth.available === before.available - AUTH_CENTS,
      `AVAILABLE moved ${delta(before.available, afterAuth.available)}, expected -${usd(AUTH_CENTS)}`,
    );

    t.note(
      `action        ${nameOf(authForm.actionId)}`,
      `POST ${CONSOLE_PATH}  authorise ${usd(AUTH_CENTS)} on card ${carried.cardToken}`,
      `Lithic txn    ${txnToken}      descriptor "${descriptor}"  mcc 5542`,
      `webhook       arrived and drained after ${landed.waitedMs / 1000}s` +
        (landed.drains.length > 0 ? `  (${landed.drains[landed.drains.length - 1]})` : ""),
      `hold          ${landed.value.hold_id}`,
      ...positionLines("on the AUTHORISATION", before, afterAuth),
    );

    /* ---- the settlement, for a different amount --------------------------- */
    const clearPage = await getPage(CONSOLE_PATH);
    const clearForm = findForm(parseForms(clearPage), {
      where: { businessId: BIZ, transactionToken: txnToken },
      has: ["transactionToken", "amount"],
    });
    t.check(
      clearForm !== null,
      `the console renders no clearing control for transaction ${txnToken} — an outstanding ` +
        `authorisation must be settleable from the screen`,
    );

    const eventsBefore = await sql`
      SELECT count(*)::int AS n FROM card_auth_event e
        JOIN card_authorization ca ON ca.id = e.auth_id
       WHERE ca.provider_auth_id = ${txnToken} AND e.kind = 'clearing'`;

    const cleared = await submitForm(CONSOLE_PATH, clearForm, {
      businessId: BIZ,
      transactionToken: txnToken,
      amount: CLEAR_TEXT,
    });
    t.check(cleared.status === 200, postFailure("the clearing POST", cleared));

    const settled = await waitForDrained("the clearing webhook", async () => {
      const [row] = await sql`
        SELECT e.id, e.amount_cents, e.value_date, e.is_final, e.received_at
          FROM card_auth_event e JOIN card_authorization ca ON ca.id = e.auth_id
         WHERE ca.provider_auth_id = ${txnToken} AND e.kind = 'clearing'
         ORDER BY e.received_at DESC LIMIT 1`;
      if (row === undefined) return null;
      return eventsBefore[0].n === 0 || row.amount_cents === CLEAR_CENTS ? row : null;
    });
    t.check(
      settled.ok,
      `the clearing webhook never landed after ${settled.waitedMs / 1000}s and ${settled.drains.length} drains`,
    );
    t.check(
      settled.value.amount_cents === CLEAR_CENTS,
      `the clearing booked ${usd(settled.value.amount_cents)}, expected ${usd(CLEAR_CENTS)}`,
    );
    carried.settlementValueDate = day(settled.value.value_date);

    const afterClear = await facts(BIZ);
    t.check(
      before.ledger - afterClear.ledger === CLEAR_CENTS,
      `the LEDGER moved ${delta(before.ledger, afterClear.ledger)}, expected -${usd(CLEAR_CENTS)} — the ` +
        `ledger posts the SETTLED amount, not the authorised one`,
    );

    // ---- the hold releases exactly once ------------------------------------
    //
    // Counted at the database, and counted on the MEMO BOOK, because that is
    // where a card hold lives: `hold` carries no amount column, the size of a
    // hold is the balance of its own 9100 memo account, and a release is an
    // appended memo entry that takes that balance back to zero. Counting
    // `hold_closure` rows would measure the wrong mechanism — that table is the
    // explicit-closure path (0011) and a card hold released by compare-and-
    // append has none. Two entries and exactly two: one opening, one releasing.
    const [memo] = await sql`
      SELECT
        count(*) FILTER (WHERE l.amount_cents < 0)::int AS opens,
        count(*) FILTER (WHERE l.amount_cents > 0)::int AS releases,
        COALESCE(SUM(l.amount_cents), 0)::bigint        AS net_cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id AND l.account_id = ${subject.memo_account}::uuid
       WHERE e.hold_id = ${carried.authHoldId}::uuid`;
    t.check(
      memo.releases === 1,
      `the hold has ${memo.releases} releasing memo entries — it must release exactly once`,
    );
    t.check(
      memo.opens === 1,
      `the hold has ${memo.opens} opening memo entries, expected exactly one`,
    );
    t.check(
      cents(memo.net_cents) === 0n,
      `the hold's memo balance is ${usd(memo.net_cents)} after settlement, expected zero`,
    );

    const [state] = await sql`
      SELECT memo_balance_cents, active_hold_cents, is_released
        FROM v_hold_state WHERE hold_id = ${carried.authHoldId}::uuid`;
    t.check(state !== undefined, "the hold has no row in v_hold_state");
    t.check(
      cents(state.active_hold_cents) === 0n,
      `v_hold_state still shows ${usd(state.active_hold_cents)} held against this authorisation`,
    );
    t.check(
      cents(state.memo_balance_cents) === 0n,
      `v_hold_state shows a memo balance of ${usd(state.memo_balance_cents)}, expected zero`,
    );

    const [closures] = await sql`
      SELECT count(*)::int AS closed,
             (SELECT count(*)::int FROM hold_closure_reversal r WHERE r.hold_id = ${carried.authHoldId}::uuid) AS reversed
        FROM hold_closure c WHERE c.hold_id = ${carried.authHoldId}::uuid`;
    t.check(closures.reversed === 0, `the hold's closure was reversed ${closures.reversed} time(s)`);
    t.check(
      afterClear.holds === before.holds,
      `holds are ${usd(afterClear.holds)} after settlement, expected the pre-authorisation ${usd(before.holds)}`,
    );
    t.check(
      afterClear.available ===
        afterClear.ledger - afterClear.holds - afterClear.uncleared - afterClear.pendingOut,
      "available is not exactly ledger - holds - uncleared - pending out, so it is a stored number " +
        "rather than a derived one",
    );

    const [entry] = await sql`
      SELECT e.id, e.value_date, e.booking_seq, e.entry_type, e.external_ref
        FROM journal_entry e
       WHERE e.external_ref = ${txnToken} AND e.book = 'financial'
       ORDER BY e.booking_seq DESC LIMIT 1`;
    t.check(entry !== undefined, `no financial journal entry carries the transaction token ${txnToken}`);
    carried.settlementEntryId = entry.id;

    t.note(
      "",
      `action        ${nameOf(clearForm.actionId)}`,
      `POST ${CONSOLE_PATH}  clear ${usd(CLEAR_CENTS)} against ${txnToken}`,
      `webhook       arrived and drained after ${settled.waitedMs / 1000}s`,
      `settled       ${usd(settled.value.amount_cents)} at value date ${carried.settlementValueDate}` +
        `   final=${settled.value.is_final}`,
      `hold          ${memo.opens} opening memo entry, ${memo.releases} releasing — released EXACTLY ONCE;`,
      `              memo balance ${usd(cents(memo.net_cents))}, v_hold_state active ${usd(cents(state.active_hold_cents))},`,
      `              hold_closure rows ${closures.closed} / reversals ${closures.reversed}`,
      `entry         ${entry.id}  seq ${entry.booking_seq}  ${entry.entry_type}`,
      ...positionLines("AUTH -> SETTLEMENT", before, afterClear),
      `authorised ${usd(AUTH_CENTS)}, settled ${usd(CLEAR_CENTS)}: available fell by the authorised`,
      `amount while the ledger stood still, then the ledger fell by the SETTLED amount and the hold`,
      `came off. The over-capture of ${usd(CLEAR_CENTS - AUTH_CENTS)} is not special-cased anywhere.`,
      `"days later" is the one half of this leg the sandbox cannot be made to perform: Lithic clears`,
      `on demand, so the clearing above arrived ${Math.round((settled.value.received_at - landed.value.first_seen_at) / 1000)}s after its authorisation rather than two days.`,
      `What is proven is the part that matters and the part a clock cannot fake — a settlement for a`,
      `DIFFERENT amount, matched to its authorisation and released once. The value-date axis is`,
      `what leg 6 exercises.`,
    );
  });
}

/* ========================================================================== */
/* LEG 5 — an outbound payment that needs a second approver                   */
/* ========================================================================== */

if (want(5)) {
  await runLeg(LEGS[4], async (t) => {
    // The door, first and by name. This leg used to reach the block below with
    // `subject.allowed === false` and report "the deployed gate refuses
    // <business> with NO_STATE(401)" — a sentence about KYB, built out of an
    // authentication failure, printed as the reason maker-checker was unproven.
    t.check(authFailure === null, authFailure);

    if (!subject.answered) {
      t.skip(
        `this run holds NO gate reading for ${subject.legal_name}: ${subject.why}. Whether the gate ` +
          `would allow a payment for this business is therefore unknown here — it was not refused, ` +
          `it was not asked. The maker-checker machinery is unaffected and unproven by this run.`,
      );
    }

    if (!subject.allowed) {
      t.skip(
        `the deployed gate refuses ${subject.legal_name} with ${subject.code}, and requestPayment() ` +
          `re-reads that gate inside the write transaction, so no payment instruction can be raised ` +
          `for this business at all. No other business on this book was ALLOWED either ` +
          `(${gateAnswers
            .map((a) => `${a.legal_name}=${a.answered ? a.code : `no reading (${a.code})`}`)
            .join(", ")}). The maker-checker ` +
          `machinery is unaffected and unproven by this run; leg 1 names what is blocking it.`,
      );
    }

    const [policy] = await sql`
      SELECT id, threshold_cents, required_approvals
        FROM approval_policy WHERE rail = 'ach' ORDER BY effective_from DESC LIMIT 1`;
    t.check(policy !== undefined, "there is no ACH approval policy on this book");
    const amountCents = policy.threshold_cents + 70_000n;
    const amountText = usdText(amountCents);
    t.check(
      usdToCents(amountText) === amountCents,
      `"${amountText}" does not read back as ${amountCents} cents`,
    );

    /* ---- raise it, as the maker ------------------------------------------ */
    const reference = `${RUN}-INV`;
    const payPage = await getPage("/payments", "staff");
    const payForm = findForm(parseForms(payPage), {
      has: ["accountId", "rail", "amount", "valueDate", "reference"],
    });
    t.check(payForm !== null, "/payments renders no raise form");

    const raised = await submitForm(
      "/payments",
      payForm,
      {
        accountId: DEPOSIT,
        rail: "ach",
        amount: amountText,
        valueDate: today,
        reference,
        holderName: `Kestrel Supply Co ${RUN}`,
        routingNumber: "021000021",
        accountNumberLast4: "4417",
        accountType: "checking",
      },
      { role: "staff" },
    );
    t.check(raised.status === 200, postFailure("the raise POST", raised));
    t.check(raised.state !== null, "the raise action returned no state");
    t.check(
      raised.state.status === "ok",
      `raising was refused: ${raised.state.code} — ${String(raised.state.message).slice(0, 220)}`,
    );

    const [instruction] = await sql`
      SELECT pi.id, pi.amount_cents, pi.rail, pi.value_date, pi.requested_by,
             a.display_name AS maker, encode(pi.content_hash, 'hex') AS content_hash
        FROM payment_instruction pi JOIN actor a ON a.id = pi.requested_by
       WHERE pi.idempotency_key = ${`console:${DEPOSIT}:${reference}`}`;
    t.check(instruction !== undefined, `no instruction was written for ${reference}`);
    t.check(
      instruction.amount_cents === amountCents,
      `the instruction is for ${usd(instruction.amount_cents)}, expected ${usd(amountCents)}`,
    );
    t.check(
      instruction.amount_cents >= policy.threshold_cents,
      `${usd(instruction.amount_cents)} is below the ${usd(policy.threshold_cents)} threshold, so it ` +
        `would need no second approver and the leg would prove nothing`,
    );
    carried.instructionId = instruction.id;

    t.note(
      `action        ${nameOf(payForm.actionId)}`,
      `POST /payments as Staff  ${usd(amountCents)} ACH  reference ${reference}`,
      `instruction   ${instruction.id}`,
      `maker         ${instruction.maker}  (${instruction.requested_by})`,
      `policy        threshold ${usd(policy.threshold_cents)} · ${policy.required_approvals} approval(s) required`,
      `hash          ${instruction.content_hash.slice(0, 24)}…  (an approval names the amount, not the row)`,
    );

    /* ---- the initiator is refused, at the database ------------------------ */
    const queueAsMaker = await getPage("/approvals", "staff");
    const makerForm = findForm(parseForms(queueAsMaker), {
      where: { instructionId: instruction.id },
      has: ["instructionId", "contentHash"],
    });
    t.check(
      makerForm !== null,
      `the queue renders no decision form for ${instruction.id} — there is nothing to press`,
    );

    const selfTry = await submitForm(
      "/approvals",
      makerForm,
      { instructionId: instruction.id, contentHash: controlMap(makerForm).contentHash, intent: "approve" },
      { role: "staff" },
    );
    t.check(selfTry.status === 200, postFailure("the approve POST", selfTry));
    t.check(selfTry.state !== null, "the decision action returned no state");
    t.check(
      selfTry.state.status === "refused",
      `the initiator's own approval was ACCEPTED: ${JSON.stringify(selfTry.state).slice(0, 200)}`,
    );
    const [afterSelf] = await sql`
      SELECT count(*)::int AS n FROM payment_instruction_event
       WHERE instruction_id = ${instruction.id}::uuid AND kind = 'approved'`;
    t.check(afterSelf.n === 0, `the refused self-approval still wrote ${afterSelf.n} approved event(s)`);

    /* ---- the maker-checker branch of the trigger, and its SQLSTATE -------- */
    // The queue's buttons are rendered disabled for a maker; the POST above was
    // assembled by hand and reached the trigger anyway, which is the point. To
    // reach the *maker-checker* branch specifically rather than the
    // not-an-approver one, a second instruction is raised BY THE APPROVER and
    // then self-approved by her.
    const selfRef = `${RUN}-SELF`;
    const payPage2 = await getPage("/payments", "approver");
    const payForm2 = findForm(parseForms(payPage2), {
      has: ["accountId", "rail", "amount", "valueDate", "reference"],
    });
    const raised2 = await submitForm(
      "/payments",
      payForm2,
      {
        accountId: DEPOSIT,
        rail: "ach",
        amount: amountText,
        valueDate: today,
        reference: selfRef,
        holderName: `Kestrel Supply Co ${RUN}`,
        routingNumber: "021000021",
        accountNumberLast4: "4417",
        accountType: "checking",
      },
      { role: "approver" },
    );
    t.check(
      raised2.state !== null && raised2.state.status === "ok",
      `the approver could not raise a payment of her own: ${JSON.stringify(raised2.state).slice(0, 200)}`,
    );
    const [own] = await sql`
      SELECT pi.id, a.display_name AS maker
        FROM payment_instruction pi JOIN actor a ON a.id = pi.requested_by
       WHERE pi.idempotency_key = ${`console:${DEPOSIT}:${selfRef}`}`;
    t.check(own !== undefined, `no instruction was written for ${selfRef}`);

    const queueAsApprover = await getPage("/approvals", "approver");
    const ownForm = findForm(parseForms(queueAsApprover), {
      where: { instructionId: own.id },
      has: ["instructionId", "contentHash"],
    });
    t.check(ownForm !== null, `the queue renders no decision form for the approver's own ${own.id}`);
    const makerChecker = await submitForm(
      "/approvals",
      ownForm,
      { instructionId: own.id, contentHash: controlMap(ownForm).contentHash, intent: "approve" },
      { role: "approver" },
    );
    t.check(
      makerChecker.state !== null && makerChecker.state.status === "refused",
      `the approver approved her OWN payment: ${JSON.stringify(makerChecker.state).slice(0, 200)}`,
    );
    t.check(
      makerChecker.state.code === "SELF_APPROVAL",
      `the refusal came back as ${makerChecker.state.code}, not SELF_APPROVAL`,
    );

    // The SQLSTATE itself, read from the live trigger that raised it. The HTTP
    // surface translates the refusal for an operator; the database is where the
    // number lives, so the number is read from the database.
    const [fn] = await sql`
      SELECT pg_get_functiondef(p.oid) AS src
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'assert_maker_checker' AND n.nspname = 'public'`;
    t.check(fn !== undefined, "assert_maker_checker() is not defined in this database");
    t.check(
      fn.src.includes("cannot approve it") && fn.src.includes("42501"),
      "assert_maker_checker() does not raise the maker-checker refusal with SQLSTATE 42501",
    );
    const [trg] = await sql`
      SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal AND tgfoid = 'assert_maker_checker'::regproc LIMIT 1`;
    t.check(trg !== undefined, "no trigger is wired to assert_maker_checker()");

    t.note(
      "",
      `action        ${nameOf(makerForm.actionId)}   (the queue's controls render DISABLED for a maker;`,
      `              this POST was assembled by hand and reached the trigger regardless)`,
      `initiator     ${instruction.maker} pressed approve on her own ${instruction.id}`,
      `  -> REFUSED  ${selfTry.state.code}   approved events written: ${afterSelf.n}`,
      `approver      ${own.maker} pressed approve on her own ${own.id}`,
      `  -> REFUSED  ${makerChecker.state.code}`,
      `the refusal's source, read from this database:`,
      `  function    assert_maker_checker()   trigger ${trg.tgname}`,
      `  SQLSTATE    42501 — RAISE EXCEPTION 'maker-checker: actor % initiated instruction % and`,
      `              cannot approve it' USING ERRCODE = '42501'`,
    );

    /* ---- a second role approves ------------------------------------------ */
    const approverForm = findForm(parseForms(queueAsApprover), {
      where: { instructionId: instruction.id },
      has: ["instructionId", "contentHash"],
    });
    t.check(approverForm !== null, `the approver's queue renders no decision form for ${instruction.id}`);
    const approved = await submitForm(
      "/approvals",
      approverForm,
      {
        instructionId: instruction.id,
        contentHash: controlMap(approverForm).contentHash,
        intent: "approve",
      },
      { role: "approver" },
    );
    t.check(approved.status === 200, postFailure("the second approver's POST", approved));
    t.check(
      approved.state !== null && approved.state.status === "ok",
      `the second approver was refused: ${JSON.stringify(approved.state).slice(0, 220)}`,
    );

    const events = await sql`
      SELECT e.kind, e.occurred_at, a.display_name AS actor, a.can_approve
        FROM payment_instruction_event e JOIN actor a ON a.id = e.actor_id
       WHERE e.instruction_id = ${instruction.id}::uuid
       ORDER BY e.occurred_at`;
    const approvals = events.filter((e) => e.kind === "approved");
    t.check(
      approvals.length >= Number(policy.required_approvals),
      `${approvals.length} approval(s) recorded, policy demands ${policy.required_approvals}`,
    );
    t.check(
      approvals.every((e) => e.actor !== instruction.maker),
      "an approval was recorded against the initiator",
    );

    t.note(
      "",
      `action        ${nameOf(approverForm.actionId)}   as Approver`,
      `  -> ${approved.state.code ?? "APPROVED"}`,
      `lifecycle of ${instruction.id}:`,
      ...events.map(
        (e) =>
          `  ${String(e.kind).padEnd(12)} ${e.actor}${e.can_approve ? " (can approve)" : ""}` +
          `  ${new Date(e.occurred_at).toISOString()}`,
      ),
      `the maker never becomes the checker: two different seeded humans, and the database — not the`,
      `screen — is what refuses the first of them.`,
    );
  });
}

/* ========================================================================== */
/* LEG 6 — survive a reversed settlement                                      */
/* ========================================================================== */

const RETURN_TEXT = "73.40";
const RETURN_CENTS = usdToCents(RETURN_TEXT);

if (want(6)) {
  await runLeg(LEGS[5], async (t) => {
    t.check(authFailure === null, authFailure);

    if (carried.cardToken === null) {
      t.skip(
        "leg 3 produced no card, so there is no transaction to correct" +
          (results.get(3)?.error === null || results.get(3) === undefined
            ? ""
            : ` — leg 3's own reason: ${results.get(3).error}`),
      );
    }
    if (!process.env.LITHIC_API_KEY) {
      t.skip("LITHIC_API_KEY is not in this environment, so the provider cannot be asked to reverse anything");
    }

    /*
     * WHY THIS PAIR AND NOT LEG 4's SETTLEMENT.
     *
     * The honest reversal of a card settlement is a two-step at the provider —
     * a RETURN, then a RETURN_REVERSAL taking it back — and the second of those
     * is what the deployment classifies as a CORRECTION. Reversing leg 4's
     * debit clearing directly is not available in this sandbox, and each of the
     * three ways to try it fails differently and quietly:
     *
     *   return_reversal on a cleared debit -> 400, "Return reversal is not
     *                                         supported for debit transactions"
     *   void                              -> appends AUTHORIZATION_REVERSAL and
     *                                         never touches settled_amount
     *   clearing with a negative amount   -> the sign is IGNORED and a second
     *                                         capture is added instead
     *
     * The last of those is the dangerous one: it looks like it worked. So this
     * leg drives the pair on its own transaction, says so, and asserts the
     * property the brief actually asks for — the corrected figure at the value
     * date the thing happened, and what was believed before.
     */
    const cardRead = await lithic("GET", `/cards/${carried.cardToken}`);
    t.check(cardRead.status === 200, `GET /cards/<token> at Lithic answered ${cardRead.status}`);
    const pan = cardRead.json?.pan;
    t.check(
      typeof pan === "string" && pan.length > 0,
      "Lithic returned this card without a PAN, and the simulator is keyed by PAN rather than by token",
    );

    const before = await facts(BIZ);
    const descriptor = `CORGI RETURN ${RUN}`.slice(0, 25);

    /* ---- 1. the merchant refunds ----------------------------------------- */
    const returned = await lithic("POST", "/simulate/return", {
      amount: Number(RETURN_CENTS),
      descriptor,
      pan,
    });
    t.check(
      returned.status >= 200 && returned.status < 300,
      `POST /v1/simulate/return answered ${returned.status}: ${returned.text.slice(0, 200)}`,
    );
    const returnToken = returned.json?.token;
    t.check(
      typeof returnToken === "string" && returnToken.length > 0,
      "Lithic accepted the return but returned no transaction token",
    );

    const original = await waitForDrained("the RETURN webhook", async () => {
      const [row] = await sql`
        SELECT e.id, e.value_date, e.booking_seq, e.booking_time, e.entry_type::text AS entry_type,
               e.correction_group_id, e.external_ref
          FROM journal_entry e
         WHERE e.external_ref = ${returnToken} AND e.book = 'financial'
         ORDER BY e.booking_seq ASC LIMIT 1`;
      return row ?? null;
    }, { attempts: 20, everyMs: 5000 });
    t.check(
      original.ok,
      `the RETURN webhook never became a journal entry after ${original.waitedMs / 1000}s and ` +
        `${original.drains.length} drains`,
    );
    t.check(
      original.value.entry_type === "original",
      `the refund booked as ${original.value.entry_type}, expected an original entry`,
    );

    const afterReturn = await facts(BIZ);
    t.check(
      afterReturn.ledger - before.ledger === RETURN_CENTS,
      `the refund moved the LEDGER ${delta(before.ledger, afterReturn.ledger)}, expected ` +
        `+${usd(RETURN_CENTS)} — money to the customer`,
    );

    const valueDate = day(original.value.value_date);
    const believedWatermark = original.value.booking_seq;
    const believed = await balanceAsOf(DEPOSIT, valueDate, believedWatermark);

    t.note(
      `provider      POST ${LITHIC_BASE}/simulate/return   pan ****${String(pan).slice(-4)}`,
      `              descriptor "${descriptor}"  ${usd(RETURN_CENTS)}  -> ${returned.status}`,
      `Lithic txn    ${returnToken}`,
      `webhook       arrived and drained after ${original.waitedMs / 1000}s`,
      `entry         ${original.value.id}  ${original.value.entry_type}  seq ${original.value.booking_seq}` +
        `  value date ${valueDate}`,
      ...positionLines("the REFUND", before, afterReturn),
      `at this point the book believes ${valueDate} closes at ${usd(believed)} on this account —`,
      `lines dated on or before ${valueDate} and booked at or under seq ${believedWatermark}, and nothing`,
      `else. That is the same body, at the same point, as the LEDGER column above it.`,
    );

    /* ---- 2. the merchant takes it back ----------------------------------- */
    await sleep(1200); // the sandbox's simulate endpoints are paced at 1 RPS
    const reversed = await lithic("POST", "/simulate/return_reversal", { token: returnToken });
    if (reversed.status === 400) {
      t.skip(
        `Lithic refused the return reversal with 400: ${reversed.text.slice(0, 300)}. The refund ` +
          `${returnToken} is on the book at ${usd(RETURN_CENTS)} and is not corrected by this run.`,
      );
    }
    t.check(
      reversed.status >= 200 && reversed.status < 300,
      `POST /v1/simulate/return_reversal answered ${reversed.status}: ${reversed.text.slice(0, 200)}`,
    );

    // A real signed webhook, delivered to the deployed endpoint, drained by the
    // deployed pipeline. It takes the better part of a minute to arrive.
    const correction = await waitForDrained("the RETURN_REVERSAL webhook", async () => {
      const [row] = await sql`
        SELECT e.id, e.value_date, e.booking_seq, e.booking_time, e.entry_type::text AS entry_type,
               e.reverses_entry_id, e.correction_group_id, e.idempotency_key
          FROM journal_entry e
         WHERE e.reverses_entry_id = ${original.value.id}::uuid
         ORDER BY e.booking_seq DESC LIMIT 1`;
      return row ?? null;
    }, { attempts: 24, everyMs: 5000 });
    t.check(
      correction.ok,
      `the RETURN_REVERSAL webhook never became a correction after ${correction.waitedMs / 1000}s ` +
        `and ${correction.drains.length} drains`,
    );

    const rev = correction.value;
    t.check(
      rev.entry_type === "reversal",
      `the correction booked as ${rev.entry_type}, expected a reversal`,
    );

    /* ---- 3. BOTH TIME AXES ------------------------------------------------
     * The whole leg is these two assertions standing at the same time. The
     * reversal belongs to the day the thing happened — so it changes what that
     * day now says — and it was learned later, which is why the system can
     * still reproduce what it believed before it learned. Value date and
     * booking date are different columns, and here is the pair of them.
     */
    t.check(
      day(rev.value_date) === valueDate,
      `the correction booked at value date ${day(rev.value_date)}, not the original's ${valueDate} — ` +
        `a correction belongs to the day it happened, not to the day it was learned`,
    );
    t.check(
      cents(rev.booking_seq) > cents(original.value.booking_seq),
      `the correction booked at seq ${rev.booking_seq}, not after the original's ` +
        `${original.value.booking_seq} — history is appended, never rewritten`,
    );
    t.check(
      rev.correction_group_id !== null && rev.correction_group_id === original.value.correction_group_id,
      `the correction carries group ${rev.correction_group_id}, the original ` +
        `${original.value.correction_group_id} — a correction and its subject are one group`,
    );

    // And the classification is DATA, not an `if`: the semantics table is what
    // sent this event down the correction path and anchored it to the original
    // value date. Read it back rather than trusting the outcome.
    const [semantics] = await sql`
      SELECT provider_event_type, canonical_kind::text AS canonical_kind,
             semantics::text AS semantics, value_date_source::text AS value_date_source
        FROM rail_event_semantics
       WHERE provider = 'lithic' AND provider_event_type LIKE '%RETURN_REVERSAL'`;
    t.check(semantics !== undefined, "no semantics row classifies a Lithic RETURN_REVERSAL");
    t.check(
      semantics.semantics === "correction",
      `RETURN_REVERSAL is classified "${semantics.semantics}", not "correction"`,
    );
    t.check(
      semantics.value_date_source === "original.value_date",
      `RETURN_REVERSAL is anchored to "${semantics.value_date_source}", not the original's value date`,
    );

    /* ---- 4. the corrected figure, and what was believed before ------------ */
    const [watermark] = await sql`SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq FROM journal_entry`;
    const corrected = await balanceAsOf(DEPOSIT, valueDate, cents(watermark.seq));
    const stillBelieved = await balanceAsOf(DEPOSIT, valueDate, cents(rev.booking_seq) - 1n);

    t.check(
      stillBelieved === believed,
      `read at the pre-correction watermark, ${valueDate} now closes at ${usd(stillBelieved)} but was ` +
        `${usd(believed)} before the correction — a closed reading must be reproducible forever`,
    );
    t.check(
      corrected - believed === -RETURN_CENTS,
      `the corrected reading for ${valueDate} differs from the believed one by ` +
        `${delta(believed, corrected)}, expected -${usd(RETURN_CENTS)}`,
    );

    const afterReversal = await facts(BIZ);
    t.check(
      afterReversal.ledger === before.ledger,
      `the ledger is ${usd(afterReversal.ledger)} after the round trip, expected the opening ` +
        `${usd(before.ledger)} — a refund taken back nets to nothing`,
    );

    /* ---- 5. the statement for that day, on the deployed screen ------------ */
    const statementPath = `/statements?account=${DEPOSIT}&day=${valueDate}`;
    const statement = await http(statementPath);
    t.check(statement.status === 200, `GET ${statementPath} answered ${statement.status}`);
    const readable = unescapeHtml(
      statement.body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, "\n"),
    );
    t.check(
      /as published/i.test(readable) && /as corrected/i.test(readable),
      "the statements screen does not render both readings, so the two axes are not visible to a person",
    );
    t.check(
      /booking watermark/i.test(readable),
      "the statements screen does not name the booking watermark, which is what makes a closed day reproducible",
    );

    t.note(
      "",
      `provider      POST ${LITHIC_BASE}/simulate/return_reversal  {token}  -> ${reversed.status}`,
      `webhook       real, signed, delivered to the deployed endpoint; drained after ` +
        `${correction.waitedMs / 1000}s`,
      `correction    ${rev.id}  ${rev.entry_type}  seq ${rev.booking_seq}`,
      `              reverses ${rev.reverses_entry_id}`,
      `              group ${rev.correction_group_id} — the same group as the original`,
      `              idempotency ${rev.idempotency_key}`,
      `classified by ${semantics.provider_event_type}`,
      `              kind=${semantics.canonical_kind} semantics=${semantics.semantics}` +
        ` value date from ${semantics.value_date_source}`,
      `              — the semantics TABLE sent it down the correction path; no event type is`,
      `              hard-coded in the consumer.`,
      "",
      `BOTH TIME AXES, on ${valueDate}, account ${DEPOSIT}:`,
      `  value date    original ${valueDate}   correction ${day(rev.value_date)}   SAME DAY`,
      `  booking seq   original ${original.value.booking_seq}   correction ${rev.booking_seq}   LATER`,
      `  as believed   ${usd(believed).padStart(16)}   read at watermark ${believedWatermark}`,
      `  as corrected  ${usd(corrected).padStart(16)}   read at watermark ${watermark.seq}`,
      `  difference    ${delta(believed, corrected).padStart(16)}   exactly the refund taken back`,
      `statement     ${baseUrl}${statementPath}  (renders both readings and the watermark)`,
      ...positionLines("the ROUND TRIP", before, afterReversal),
      `Tuesday's figure changed and Wednesday's belief is still reproducible: the correction is`,
      `appended at the ORIGINAL value date, and the pre-correction watermark still returns the`,
      `pre-correction number. Nothing was rewritten.`,
      "",
      `note          this pair runs on its own transaction rather than on leg 4's settlement, and`,
      `              that is a provider limit rather than a choice: the sandbox refuses`,
      `              return_reversal on a cleared debit with 400, a void appends an`,
      `              AUTHORIZATION_REVERSAL without touching settled_amount, and a clearing with a`,
      `              negative amount IGNORES the sign and adds a second capture. The last of those`,
      `              looks like it worked, which is why this leg does not go near it.`,
    );
  });
}

/* ========================================================================== */
/* LEG 7 — reconcile the scheme file                                          */
/* ========================================================================== */

if (want(7)) {
  await runLeg(LEGS[6], async (t) => {
    const html = await getPage("/reconciliation");
    const text = unescapeHtml(
      html
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, "\n"),
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");

    // The screen is read FIRST and the database is asked to corroborate it,
    // not the other way round. Which file and which run the breaks screen shows
    // is the SCREEN's decision — it renders the live view rather than a run's
    // snapshot, and it says so on the page — so a run this script picked by
    // `ORDER BY started_at DESC` would be a second opinion that can disagree
    // with it, and other work landing on this book creates runs constantly.
    const tableStart = text.indexOf("Reconciliation breaks");
    t.check(tableStart >= 0, "the breaks table is not on the deployed screen at all");
    const tableEnd = text.indexOf("Runs over this file", tableStart);
    const region = text.slice(tableStart, tableEnd < 0 ? undefined : tableEnd);
    const candidates = [
      ...new Set(
        region
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z0-9][A-Za-z0-9._:/#-]{5,}$/.test(l)),
      ),
    ];
    t.check(candidates.length > 0, "the breaks table renders no reference-shaped cell");

    const matches = await sql`
      SELECT v.file_id, v.break_kind, v.reason_code, v.external_ref, v.value_date, v.age_days,
             v.closes_crossed, v.file_amount_cents, v.ledger_net_cents, v.break_amount_cents,
             v.business_date, v.provider, v.rail
        FROM v_recon_break v
       WHERE v.external_ref = ANY(${candidates})`;
    const shown = matches[0] ?? null;
    t.check(
      shown !== null,
      `the ${candidates.length} reference(s) the breaks screen renders ` +
        `(${candidates.slice(0, 4).join(", ")}) match no row in v_recon_break`,
    );

    const [file] = await sql`
      SELECT f.filename, f.row_count, f.total_cents, f.business_date,
             (SELECT count(*)::int FROM recon_run r WHERE r.file_id = f.id) AS runs,
             (SELECT r.id FROM recon_run r WHERE r.file_id = f.id ORDER BY r.started_at DESC LIMIT 1) AS newest_run
        FROM scheme_file f WHERE f.id = ${shown.file_id}::uuid`;
    const onFile = await sql`
      SELECT break_kind, count(*)::int AS n FROM v_recon_break
       WHERE file_id = ${shown.file_id}::uuid GROUP BY break_kind`;
    const [severityRow] = await sql`
      SELECT CASE WHEN ${shown.closes_crossed} >= 2 THEN 'Critical'
                  WHEN ${shown.closes_crossed} >= 1 THEN 'Aged'
                  ELSE 'Open' END AS severity`;
    shown.severity = severityRow.severity;

    const KINDS = {
      in_file_not_ledger: "In file, not in ledger",
      in_ledger_not_file: "In ledger, not in file",
      amount_mismatch: "Amount mismatch",
    };

    t.check(
      Object.hasOwn(KINDS, shown.break_kind),
      `the break's kind "${shown.break_kind}" is not one of the three categories`,
    );
    t.check(
      text.includes(KINDS[shown.break_kind]),
      `the screen does not name the break's category "${KINDS[shown.break_kind]}"`,
    );
    t.check(
      text.includes(usd(shown.break_amount_cents)),
      `the screen shows no amount matching ${usd(shown.break_amount_cents)}`,
    );
    t.check(
      typeof shown.age_days === "number",
      "the break carries no age, so a breaks screen cannot age it",
    );
    t.check(
      /\bAge\b/.test(text) && (/day still open/.test(text) || /-?\d+d\b/.test(text)),
      "the screen renders no age for the break",
    );
    t.check(
      text.includes(shown.severity),
      `the screen does not carry the break's severity "${shown.severity}"`,
    );
    t.check(
      shown.closes_crossed !== null && shown.closes_crossed !== undefined,
      "the break records no day closes crossed, so its severity cannot escalate with age",
    );
    t.check(
      Object.keys(KINDS).every((k) => text.includes(KINDS[k])),
      "the screen does not render all three break categories, so a category could go unseen",
    );

    t.note(
      `GET /reconciliation  (a read; the breaks screen carries no write control and needs none)`,
      `file          ${file?.filename ?? "(no file row)"}   ${file?.row_count ?? "?"} rows` +
        `   ${file?.total_cents === null || file?.total_cents === undefined ? "" : usd(file.total_cents)}` +
        `   business date ${day(shown.business_date)}`,
      `runs          ${file?.runs ?? "?"} over this file, newest ${file?.newest_run ?? "?"}`,
      `breaks        ` + onFile.map((c) => `${c.break_kind}=${c.n}`).join(" · "),
      `on screen     ${KINDS[shown.break_kind]}  ref ${shown.external_ref}`,
      `              ${usd(shown.break_amount_cents)}  age ${shown.age_days}d` +
        `  closes crossed ${shown.closes_crossed}  severity ${shown.severity}` +
        `  value date ${day(shown.value_date)}`,
      `reason        ${shown.reason_code}`,
      `the planted row is the one the nightly file is missing; this leg proves the screen finds it,`,
      `names its category and ages it. The planting itself has no deployed control — /reconciliation`,
      `renders no write form — so this run did not plant it and does not claim to have.`,
    );
  });
}

/* ========================================================================== */
/* Invariants — a NAMED SET, never a count                                    */
/* ========================================================================== */

/**
 * THE INVARIANTS THIS RUN STANDS ON, LISTED BY NAME.
 *
 * WHY THIS IS NOT A COUNT. It was `passed === 14 && failed === 0`. A COUNT
 * CANNOT TELL "AN INVARIANT WAS ADDED" FROM "AN INVARIANT STOPPED RUNNING" —
 * one is growth and the other is a guard that quietly went away, and 14 maps
 * both to the same red. dbcheck gates 31 views today, so the number was
 * already stale, and a red that fires on growth is a red nobody reads.
 *
 * It is the same defect this run just fixed in `facts()`: a check whose
 * POPULATION is implicit. dbcheck's own GUARD REACH section states the rule —
 * "coverage is COMPUTED from the list of things that must be covered, never
 * from the list of things that happen to be covered", and a name that has gone
 * missing is a named FAIL rather than a blank. This is that rule carried
 * across the process boundary.
 *
 * THE RULE, IN THREE PARTS
 *
 *   REQUIRED  the list below, one line each naming the leg it carries. Each
 *             must be PRESENT in dbcheck's output AND green. ABSENT IS A
 *             FAILURE: an invariant that stopped running is the one thing a
 *             count can never see, and it is the failure this list exists for.
 *
 *   EXCUSED   the four standing reds, excluded BY NAME. The argument for each
 *             is dbcheck's own RED_REGISTER, cited there to documents that
 *             predate the rows. This script does not restate those arguments
 *             and must not invent its own. By name and not by predicate: a
 *             predicate shaped like the failure is how a guard in this repo
 *             has gone green wrongly twenty-six times, and "NOT LIKE
 *             'lithic:team-test-%'" is the exact move dbcheck refused.
 *
 *   EVERYTHING ELSE  printed, never fatal. A gated view this run does not
 *             lean on is somebody's business but not this script's, and a new
 *             one appearing is growth. Growth must not break a run.
 */
const REQUIRED_INVARIANTS = [
  ["v_entry_unbalanced", "double entry itself — every figure above is a SUM over these lines"],
  ["v_line_denorm_drift", "value_date and booking_seq on the line match their entry — the two columns facts() filters on"],
  ["v_book_not_zero", "the whole book nets to zero, per entity and book"],
  ["v_deposit_control_drift", "the deposits subtree equals what this run reported off the 2100"],
  ["v_balance_definition_drift", "the hold model and ledger_availability() agree at the live point — facts() IS a call to it"],
  ["v_hold_drift", "leg 4: the memo book equals the fold over card events"],
  ["v_hold_release_drift", "leg 4: a released hold withholds nothing"],
  ["v_hold_closure_not_terminal", "leg 4: no permanent closure stands over a hold the fold says is open"],
  ["v_value_date_unexplained", "leg 6: every value date on this book is explained by a declared writer"],
  ["v_approved_auth_for_dead_member", "legs 3-4: no authorisation approved without the cardholder's live terms"],
  ["v_member_approval_without_right", "leg 5: no approval stands from anybody who did not hold the right at the time"],
];

/**
 * Red on purpose. The reasoning is dbcheck's RED_REGISTER, which quotes the
 * documents that predate each row; naming them here is the whole of this
 * script's claim about them, deliberately.
 */
const EXCUSED_INVARIANTS = [
  "v_refused_auth_hold",
  "v_hold_expiry_drift",
  "v_advice_delta_unsound",
  "v_hold_closure_unexplained",
];

console.log(THIN);
console.log("");
process.stdout.write("  invariants   running scripts/dbcheck.mjs against the live database … ");

const dbcheck = spawnSync(process.execPath, [resolve(ROOT, "scripts", "dbcheck.mjs")], {
  cwd: ROOT,
  env: process.env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const dbcheckOut = `${dbcheck.stdout ?? ""}${dbcheck.stderr ?? ""}`;

// dbcheck's INVARIANT VIEWS section prints one line per gated view:
//
//   "  PASS  v_entry_unbalanced is empty — every entry sums to zero, per currency"
//   "  FAIL  v_hold_expiry_drift is empty — 12 row(s) — one card hold, one expiry …"
//
// Matched narrowly on purpose. GUARD REACH prints "<view> declares its reach"
// about the SAME view names, and that is a different claim about a different
// thing; folding the two together would let a reach failure read as an
// emptiness pass, which is the shape of mistake this whole section is about.
const gated = new Map();
for (const m of dbcheckOut.matchAll(/^\s*(PASS|FAIL)\s+(v_[a-z0-9_]+) is empty\b/gm)) {
  gated.set(m[2], m[1] === "PASS");
}

const required = new Set(REQUIRED_INVARIANTS.map(([v]) => v));
const excused = new Set(EXCUSED_INVARIANTS);
const vanished = REQUIRED_INVARIANTS.filter(([v]) => !gated.has(v)).map(([v]) => v);
const broken = REQUIRED_INVARIANTS.filter(([v]) => gated.get(v) === false).map(([v]) => v);
const excusedRed = EXCUSED_INVARIANTS.filter((v) => gated.get(v) === false);
const excusedGreen = EXCUSED_INVARIANTS.filter((v) => gated.get(v) === true);
const otherRed = [...gated].filter(([v, green]) => !green && !required.has(v) && !excused.has(v)).map(([v]) => v);
const tally = /(\d+)\s+passed,\s+(\d+)\s+failed/.exec(dbcheckOut);

const invariants = {
  ok: gated.size > 0 && vanished.length === 0 && broken.length === 0,
  detail:
    gated.size === 0
      ? "dbcheck printed no invariant verdicts at all — it did not run, or its output shape changed"
      : vanished.length > 0
        ? `${vanished.length} REQUIRED INVARIANT(S) HAVE STOPPED RUNNING: ${vanished.join(", ")}`
        : broken.length > 0
          ? `${broken.length} required invariant(s) RED: ${broken.join(", ")}`
          : `${required.size}/${required.size} required held`,
};
console.log(invariants.ok ? GREEN(invariants.detail) : RED(invariants.detail));

console.log(
  DIM(
    `               ${gated.size} views gated · ${required.size} required by name · ` +
      `${excusedRed.length} excused on dbcheck's register · ` +
      `${gated.size - required.size - excusedRed.length} not this run's business` +
      `${tally === null ? "" : `   (dbcheck's own tally: ${tally[1]} passed, ${tally[2]} failed)`}`,
  ),
);
if (vanished.length > 0) {
  console.log(RED(`               GONE FROM dbcheck ENTIRELY, not merely red: ${vanished.join(", ")}`));
  console.log(RED("               A required invariant that no longer runs is why this stopped being a count."));
}
for (const view of broken) {
  const claim = REQUIRED_INVARIANTS.find(([v]) => v === view)?.[1] ?? "";
  console.log(RED(`               RED and required — ${view}: ${claim}`));
}
if (excusedRed.length > 0) {
  console.log(DIM(`               excused by name, red on purpose: ${excusedRed.join(", ")}`));
  console.log(DIM("               — the argument for each is dbcheck's RED_REGISTER, not a sentence invented here."));
}
for (const view of excusedGreen) {
  console.log(YELLOW(`               ${view} is excused here but is GREEN — the excuse has outlived its row.`));
}
if (otherRed.length > 0) {
  console.log(YELLOW(`               red, and not on either list — printed, not fatal: ${otherRed.join(", ")}`));
}

const closing = await facts(BIZ);

/* ========================================================================== */
/* Scoreboard                                                                 */
/* ========================================================================== */

console.log("");
console.log(RULE);
console.log("  SCOREBOARD");
console.log(RULE);
console.log("");

const totals = { PASS: 0, FAIL: 0, SKIP: 0 };

for (const spec of selected) {
  const v = verdict(spec.n);
  totals[v.status] += 1;
  const record = results.get(spec.n);

  const badge = v.status === "PASS" ? GREEN("PASS") : v.status === "FAIL" ? RED("FAIL") : YELLOW("SKIP");
  const head = `  ${String(spec.n).padStart(2)}  ${spec.title}`;
  const padding = Math.max(1, WIDTH - 6 - head.length);
  console.log(`${head}${" ".repeat(padding)}${badge}`);
  console.log(DIM(`      ${v.detail}${record === undefined ? "" : `  ·  ${(record.ms / 1000).toFixed(1)}s`}`));

  if (v.status === "SKIP" && record?.skip) {
    for (const line of wrap(`waiting on: ${record.skip}`, WIDTH - 10, 6)) console.log(YELLOW(line));
  }
  if (v.status === "FAIL" && record?.error) {
    for (const line of wrap(record.error, WIDTH - 10, 6)) console.log(RED(line));
  }
  for (const item of record?.evidence ?? []) {
    if (item === "") {
      console.log("");
      continue;
    }
    console.log(`      ${item}`);
  }
  console.log("");
}

console.log(RULE);
console.log(
  `  ${GREEN(`PASS ${totals.PASS}`)}    ${RED(`FAIL ${totals.FAIL}`)}    ${YELLOW(`SKIP ${totals.SKIP}`)}` +
    `    of ${selected.length} legs` +
    `    ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s    ${httpCalls} HTTP calls to ${baseUrl}` +
    `    ${providerCalls} to the Lithic sandbox`,
);
console.log(
  `  invariants  ${invariants.ok ? GREEN(invariants.detail) : RED(invariants.detail)}` +
    DIM(`  ·  of ${gated.size} gated, ${excusedRed.length} excused by name on dbcheck's register`),
);
console.log(
  `  ${subject.legal_name}   opening ${usd(opening.available)} available` +
    `  ->  closing ${usd(closing.available)} available   (ledger ${usd(closing.ledger)},` +
    ` holds ${usd(closing.holds)}, uncleared ${usd(closing.uncleared)},` +
    ` pending out ${usd(closing.pendingOut)})`,
);
for (const line of provenance(closing)) console.log(DIM(`  ${line}`));
console.log(RULE);
console.log("");
console.log(DIM("  A SKIP is not a pass. It means the leg could not be driven through the deployed"));
console.log(DIM("  surface in this run, and the reason above names exactly what is missing."));
if (authFailure !== null) {
  console.log("");
  console.log(RED("  AND NEITHER IS A 401 A VERDICT ABOUT ANYTHING BEHIND THE DOOR."));
  console.log(RED(`  ${authFailure}`));
  for (const line of wrap(authRemedy, WIDTH - 4, 0)) console.log(DIM(`  ${line.trim()}`));
  console.log(
    DIM("  Nothing above is a finding about KYB, funding, card issuing or approvals: this run"),
  );
  console.log(DIM("  never reached them."));
}
console.log("");

await sql.end();

process.exit(totals.FAIL > 0 || totals.SKIP > 0 || !invariants.ok ? 1 : 0);
