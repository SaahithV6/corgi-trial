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
  const args = { baseUrl: process.env.CORELOOP_BASE_URL ?? DEFAULT_BASE_URL, only: null };
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
        "usage: node scripts/coreloop.mjs [--base-url URL] [--only 1,2,3]\n" +
          "Drives the published core loop end to end against the DEPLOYED system.",
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

async function http(path, options = {}) {
  httpCalls += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...options,
      signal: controller.signal,
      headers: { "cache-control": "no-cache", ...(options.headers ?? {}) },
    });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
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
 * Ledger, holds, uncleared and available for one business.
 *
 * This is `availableBalance()`'s query, re-expressed here rather than imported,
 * because importing it would put application code in this script's call stack
 * and the whole claim of this file is that there is none. It reads; it is the
 * yardstick the legs measure against, not a second opinion the app consults.
 *
 * available = ledger - active card holds - uncleared credits, in cents.
 */
async function facts(businessId) {
  const [row] = await sql`
    WITH deposit AS (
      SELECT id, normal_side FROM account
       WHERE code = '2100' AND business_id = ${businessId}::uuid
    ),
    booked AS (
      SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * d.normal_side AS cents
        FROM deposit d LEFT JOIN journal_line l ON l.account_id = d.id
       GROUP BY d.normal_side
    ),
    active_holds AS (
      SELECT h.id, h.kind, COALESCE(SUM(l.amount_cents), 0)::bigint AS cents
        FROM hold h
        JOIN account a ON a.id = h.account_id
        LEFT JOIN journal_entry e ON e.hold_id = h.id
        LEFT JOIN journal_line  l ON l.entry_id = e.id AND l.account_id = h.memo_account_id
       WHERE a.business_id = ${businessId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM hold_closure c
            WHERE c.hold_id = h.id
              AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal r WHERE r.hold_id = c.hold_id)
         )
       GROUP BY h.id, h.kind
    )
    SELECT (SELECT COALESCE(cents, 0) FROM booked)                             AS ledger_cents,
           COALESCE((SELECT SUM(ABS(cents)) FROM active_holds
                      WHERE kind = 'card_auth'), 0)::bigint                    AS holds_cents,
           COALESCE((SELECT SUM(ABS(cents)) FROM active_holds
                      WHERE kind = 'uncleared_credit'), 0)::bigint             AS uncleared_cents`;
  const ledger = row?.ledger_cents ?? 0n;
  const holds = row?.holds_cents ?? 0n;
  const uncleared = row?.uncleared_cents ?? 0n;
  return { ledger, holds, uncleared, available: ledger - holds - uncleared };
}

/** Two readings of the same four figures, formatted so the money can be followed. */
function positionLines(label, before, after) {
  const cell = (v) => usd(v).padStart(14);
  return [
    `${label}                 LEDGER         HOLDS     UNCLEARED     AVAILABLE`,
    `  before        ${cell(before.ledger)}${cell(before.holds)}${cell(before.uncleared)}${cell(before.available)}`,
    `  after         ${cell(after.ledger)}${cell(after.holds)}${cell(after.uncleared)}${cell(after.available)}`,
    `  delta         ${delta(before.ledger, after.ledger).padStart(14)}` +
      `${delta(before.holds, after.holds).padStart(14)}` +
      `${delta(before.uncleared, after.uncleared).padStart(14)}` +
      `${delta(before.available, after.available).padStart(14)}`,
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
 */
const candidates = await sql`
  SELECT dep.business_id AS business_id,
         b.legal_name    AS legal_name,
         dep.id          AS deposit_account,
         memo.id         AS memo_account,
         b.ein           AS ein
    FROM account dep
    JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
    JOIN business b   ON b.id = dep.business_id
   WHERE dep.code = '2100' AND dep.closed_at IS NULL
   ORDER BY b.legal_name`;

const onboardingHtml = await getPage("/onboarding");
const onboardingForms = parseForms(onboardingHtml);
const gateAnswers = [];
for (const candidate of candidates) {
  const form = findForm(onboardingForms, { where: { businessId: candidate.business_id } });
  if (form === null) {
    gateAnswers.push({ ...candidate, allowed: false, code: "NO_GATE_CONTROL" });
    continue;
  }
  const answer = await submitForm("/onboarding", form, {
    businessId: candidate.business_id,
    intent: "gate",
  });
  gateAnswers.push({
    ...candidate,
    actionId: form.actionId,
    allowed: answer.state !== null && answer.state.status === "ok",
    code: answer.state?.code ?? `NO_STATE(${answer.status})`,
    message: answer.state?.message ?? "",
  });
}

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
const rankOf = (answer) => (answer.allowed ? -1 : (GATE_RANK[answer.code] ?? 9));

const ranked = [...gateAnswers].sort((a, b) => rankOf(a) - rankOf(b));
const subject = ranked[0];
const foil = gateAnswers.find((c) => !c.allowed && c.business_id !== subject?.business_id);

if (subject === undefined) {
  console.error("no business on this book holds both a 2100 deposit account and a 9100 memo account");
  await sql.end();
  process.exit(2);
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
console.log("  WHY THIS BUSINESS — the deployed gate was asked, live, before anything else ran");
for (const answer of gateAnswers) {
  const mark = answer.allowed ? "ALLOWED " : "REFUSED ";
  const role =
    answer.business_id === subject.business_id
      ? "  <- the subject"
      : foil !== undefined && answer.business_id === foil.business_id
        ? "  <- leg 1's foil"
        : "";
  console.log(`    ${mark} ${String(answer.code).padEnd(22)} ${answer.legal_name}${role}`);
}
if (!subject.allowed) {
  console.log("");
  console.log(YELLOW("    The gate allows NO business on this book right now. The subject below is the one"));
  console.log(YELLOW(`    closest to allowed (${subject.code}); the legs that need a transactable business`));
  console.log(YELLOW("    will skip, and will say so."));
}
console.log(RULE);
console.log("");

const opening = await facts(BIZ);
console.log(`  OPENING POSITION   ledger ${usd(opening.ledger)} · holds ${usd(opening.holds)}` +
  ` · uncleared ${usd(opening.uncleared)} · available ${usd(opening.available)}`);
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
    if (foil === undefined) t.skip("this book holds only one business, so there is no unverified foil to refuse");

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
    t.check(refusal.status === 200, `the gate POST answered ${refusal.status}`);
    t.check(refusal.state !== null, "the gate action returned no state to the re-rendered page");
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
    t.check(allowed.state !== null, "the gate action returned no state for the subject business");

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
        `the deployed gate currently refuses EVERY business on this book — ` +
          gateAnswers.map((a) => `${a.legal_name}=${a.code}`).join(", ") +
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
    t.check(sent.status === 200, `the funding POST answered ${sent.status}`);
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
      `hold          ${hold.id}  kind=${hold.kind}  releases ${hold.available_at ?? "(no release time)"}`,
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
    const page = await getPage(CONSOLE_PATH);
    const form = findForm(parseForms(page), { where: { businessId: BIZ }, has: ["formKey", "nickname"] });
    if (form === null) {
      t.skip(`the console at ${CONSOLE_PATH} renders no issue-card form for this business`);
    }

    const nickname = `corgi core loop ${RUN}`;
    const issued = await submitForm(CONSOLE_PATH, form, { businessId: BIZ, nickname });
    t.check(issued.status === 200, `the issue-card POST answered ${issued.status}`);
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
    if (carried.cardToken === null) {
      t.skip("leg 3 produced no card token, so there is nothing to authorise against");
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
    t.check(authed.status === 200, `the authorise POST answered ${authed.status}`);
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
    t.check(cleared.status === 200, `the clearing POST answered ${cleared.status}`);

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
      afterClear.available === afterClear.ledger - afterClear.holds - afterClear.uncleared,
      "available is not exactly ledger - holds - uncleared, so it is a stored number rather than a derived one",
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
      `exercised by leg 6.`,
    );
  });
}

/* ========================================================================== */
/* LEG 5 — an outbound payment that needs a second approver                   */
/* ========================================================================== */

if (want(5)) {
  await runLeg(LEGS[4], async (t) => {
    if (!subject.allowed) {
      t.skip(
        `the deployed gate refuses ${subject.legal_name} with ${subject.code}, and requestPayment() ` +
          `re-reads that gate inside the write transaction, so no payment instruction can be raised ` +
          `for this business at all. There is no second business on this book the gate allows either ` +
          `(${gateAnswers.map((a) => `${a.legal_name}=${a.code}`).join(", ")}). The maker-checker ` +
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
    t.check(raised.status === 200, `the raise POST answered ${raised.status}`);
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
    t.check(selfTry.status === 200, `the approve POST answered ${selfTry.status}`);
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
    t.check(approved.status === 200, `the second approver's POST answered ${approved.status}`);
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

if (want(6)) {
  await runLeg(LEGS[5], async (t) => {
    if (carried.transactionToken === null || carried.settlementEntryId === null) {
      t.skip("leg 4 produced no settlement, so there is nothing to reverse");
    }

    /* Is there a deployed control that reverses a settlement at all? */
    const page = await getPage(CONSOLE_PATH);
    const forms = parseForms(page);
    const reversal = forms.find((f) => {
      const map = controlMap(f);
      const named = ACTION_NAMES.get(f.actionId) ?? "";
      return (
        /revers|void|correct|refund|rebook|return/i.test(named) ||
        Object.keys(map).some((k) => /revers|void|correct|rebook/i.test(k))
      );
    });

    /* Has the deployed pipeline ever produced a card correction? */
    const [corrected] = await sql`
      SELECT count(*)::int AS n
        FROM journal_entry e
       WHERE e.rail = 'card' AND e.reverses_entry_id IS NOT NULL`;

    if (reversal === undefined) {
      t.skip(
        `no control on the deployed console reverses a settlement. The four forms ${CONSOLE_PATH} ` +
          `renders are issue-card, authorise, clearing and drain, and none of them corrects a booked ` +
          `card entry; the card-correction path (src/lib/holds/, ` +
          `src/lib/webhooks/consumers/lithic-card.ts) is being written now and reverseAndRebook() has ` +
          `no caller on the webhook path yet — ${corrected.n} card entries on this whole book carry a ` +
          `reverses_entry_id. Settlement ${carried.transactionToken} at value date ` +
          `${carried.settlementValueDate} (entry ${carried.settlementEntryId}) is the row this leg ` +
          `would reverse. Driving it any other way — a direct reverseAndRebook(), a hand-written row ` +
          `— would prove the library, not the deployment, so this leg reports what is missing instead.`,
      );
    }

    const before = await facts(BIZ);
    const sent = await submitForm(CONSOLE_PATH, reversal, { businessId: BIZ }, {});
    t.check(sent.status === 200, `the reversal POST answered ${sent.status}`);
    t.check(sent.state !== null, "the reversal action returned no state");
    t.check(sent.state.status !== "refused", `the reversal was refused: ${sent.state.code}`);

    const landed = await waitForDrained("the reversal", async () => {
      const [row] = await sql`
        SELECT e.id, e.value_date, e.booking_seq, e.reverses_entry_id, e.correction_group_id
          FROM journal_entry e
         WHERE e.reverses_entry_id = ${carried.settlementEntryId}::uuid
         ORDER BY e.booking_seq DESC LIMIT 1`;
      return row ?? null;
    });
    t.check(landed.ok, "no reversing entry appeared against the settlement");
    t.check(
      day(landed.value.value_date) === carried.settlementValueDate,
      `the reversal booked at value date ${day(landed.value.value_date)}, not the ` +
        `settlement's ${carried.settlementValueDate} — a correction belongs to the day it happened`,
    );

    const after = await facts(BIZ);
    const statementPath =
      `/statements?account=${DEPOSIT}&day=${carried.settlementValueDate}&v=1`;
    const statement = await getPage(statementPath);
    const readable = statement
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<[^>]+>/g, "\n");
    t.check(
      /as published/i.test(readable) && /as corrected|corrections?/i.test(readable),
      "the statement for settlement day does not carry both readings",
    );

    t.note(
      `action        ${nameOf(reversal.actionId)}`,
      `reversed      entry ${carried.settlementEntryId} at value date ${carried.settlementValueDate}`,
      `reversal      entry ${landed.value.id}  seq ${landed.value.booking_seq}` +
        `  group ${landed.value.correction_group_id}`,
      `statement     ${baseUrl}${statementPath}`,
      ...positionLines("the correction", before, after),
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
/* Invariants                                                                 */
/* ========================================================================== */

console.log(THIN);
console.log("");
process.stdout.write("  invariants   running scripts/dbcheck.mjs against the live database … ");

const dbcheck = spawnSync(process.execPath, [resolve(ROOT, "scripts", "dbcheck.mjs")], {
  cwd: ROOT,
  env: process.env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const summary = /(\d+)\s+passed,\s+(\d+)\s+failed/.exec(`${dbcheck.stdout ?? ""}${dbcheck.stderr ?? ""}`);
const invariants =
  summary === null
    ? { ok: false, passed: 0, failed: 0, detail: "dbcheck produced no summary line" }
    : {
        ok: Number(summary[2]) === 0 && Number(summary[1]) === 14,
        passed: Number(summary[1]),
        failed: Number(summary[2]),
        detail: `${summary[1]} passed, ${summary[2]} failed`,
      };
console.log(invariants.ok ? GREEN(invariants.detail) : RED(invariants.detail));

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
    `    ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s    ${httpCalls} HTTP calls to ${baseUrl}`,
);
console.log(
  `  invariants  ${invariants.ok ? GREEN(`${invariants.passed}/14 held`) : RED(invariants.detail)}`,
);
console.log(
  `  ${subject.legal_name}   opening ${usd(opening.available)} available` +
    `  ->  closing ${usd(closing.available)} available   (ledger ${usd(closing.ledger)},` +
    ` holds ${usd(closing.holds)}, uncleared ${usd(closing.uncleared)})`,
);
console.log(RULE);
console.log("");
console.log(DIM("  A SKIP is not a pass. It means the leg could not be driven through the deployed"));
console.log(DIM("  surface in this run, and the reason above names exactly what is missing."));
console.log("");

await sql.end();

process.exit(totals.FAIL > 0 || totals.SKIP > 0 || !invariants.ok ? 1 : 0);
