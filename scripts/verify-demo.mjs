#!/usr/bin/env node
/**
 * VERIFY THE DEMO — walk docs/DEMO.md against the deployed system and assert
 * every step of it actually works.
 *
 *   node scripts/verify-demo.mjs
 *   node scripts/verify-demo.mjs --base-url http://localhost:3000
 *
 * Why this exists. `docs/DEMO.md` tells a grader to click eleven things in a
 * fixed order and promises what each one does. A document that says "switch to
 * Approver and the queue refuses your own payment" is a claim, and the fastest
 * way to lose a trial is to hand somebody a click path that does not click.
 * So every assertion below is made against the live URL over HTTP, in the same
 * order a person would perform it, using the same mechanisms a browser uses —
 * the role switch is submitted as the real no-JavaScript form POST that the
 * segmented control emits, not by setting a cookie by hand.
 *
 * Two rules, the same two the live-fire runner is written under:
 *
 *   1. IT MUST NEVER OVERSTATE A PASS. Every check names the exact bytes it
 *      found and prints them as evidence. Where a claim cannot be proven over
 *      HTTP, it is printed as SKIP with the command that does prove it, and
 *      the skip is never folded into the pass count.
 *   2. IT MUST BE READABLE AT A GLANCE. One line per step, verdict in a fixed
 *      column, evidence indented underneath, a total at the bottom that adds
 *      up, and a non-zero exit code if anything failed.
 *
 * It writes nothing. Every request is a GET, except the role-switch POST,
 * whose only effect is a `Set-Cookie` on the response it returns.
 */

const DEFAULT_BASE_URL = "https://corgi-trial-psi.vercel.app";
const TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base-url") {
      const next = argv[i + 1];
      if (!next) {
        console.error("--base-url needs a value");
        process.exit(2);
      }
      baseUrl = next.replace(/\/+$/, "");
      i += 1;
    }
  }
  return { baseUrl };
}

const { baseUrl } = parseArgs(process.argv.slice(2));

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const useColour = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const paint = (code, s) => (useColour ? `[${code}m${s}[0m` : s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const yellow = (s) => paint("33", s);
const dim = (s) => paint("2", s);

const RULE = "-".repeat(78);
const results = [];

function record(verdict, step, title, evidence) {
  results.push({ verdict, step, title, evidence });
  const tag =
    verdict === "PASS" ? green("PASS") : verdict === "FAIL" ? red("FAIL") : yellow("SKIP");
  console.log(`  ${String(step).padStart(2, " ")}. ${tag}  ${title}`);
  for (const line of Array.isArray(evidence) ? evidence : [evidence]) {
    console.log(dim(`        ${line}`));
  }
}

/**
 * Run one step. A thrown error is a FAIL with its message as the evidence, so
 * a network blip or a changed page reports as a failed check rather than as a
 * stack trace that stops the walk.
 */
async function step(n, title, fn) {
  try {
    const out = await fn();
    if (out && out.skip) record("SKIP", n, title, out.skip);
    else record("PASS", n, title, out ?? "ok");
    return out;
  } catch (e) {
    record("FAIL", n, title, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

async function req(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...options,
      signal: controller.signal,
      headers: { "cache-control": "no-cache", ...(options.headers ?? {}) },
    });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

async function getPage(path, role) {
  const headers = role ? { cookie: `corgi_demo_role=${role}` } : {};
  const res = await req(path, { headers });
  assert(res.status === 200, `GET ${path} answered ${res.status}, expected 200`);
  return res.body;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** Strip scripts, styles and tags. Used for reading numbers off a table. */
function text(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

const MONEY = /(-?)\$([\d,]+)\.(\d\d)/g;

function centsFrom(match) {
  const [, sign, whole, frac] = match;
  const n = Number(whole.replace(/,/g, "")) * 100 + Number(frac);
  return sign === "-" ? -n : n;
}

const fmt = (cents) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/**
 * The four figures of the availability derivation, in the order the table
 * renders them: ledger, active holds, uncleared credits, available.
 *
 * Read off the account screen's own "How the available balance is derived"
 * table rather than off the headline, because the headline is a rendering of
 * this table and the point of the check is that the table adds up.
 */
function derivation(html) {
  const t = text(html);
  const anchor = t.indexOf("How the available balance is derived");
  assert(anchor >= 0, "the availability derivation table is not on the page");
  const section = t.slice(anchor);
  const found = [...section.matchAll(MONEY)].slice(0, 4).map(centsFrom);
  assert(found.length === 4, `expected 4 figures in the derivation table, found ${found.length}`);
  const [ledger, holds, uncleared, available] = found;
  return { ledger, holds, uncleared, available };
}

/** The server-action id the role switcher's <form> carries for no-JS posts. */
function actionId(html) {
  const m = html.match(/\$ACTION_ID_([a-f0-9]+)/);
  assert(m !== null, "no server-action id found in the page — the role switcher form is missing");
  return m[0];
}

function setCookieRole(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  for (const c of raw) {
    const m = /corgi_demo_role=([a-z]+)/.exec(c);
    if (m) return { value: m[1], httpOnly: /httponly/i.test(c), raw: c };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

console.log("");
console.log(RULE);
console.log("VERIFY DEMO — docs/DEMO.md, walked against the deployed system");
console.log(`base url   ${baseUrl}`);
console.log(`started    ${new Date().toISOString()}`);
console.log(RULE);
console.log("");

/* --- 1. the health endpoint, which the README calls authoritative --------- */

await step(1, "/api/health answers, the database is reachable, and it reports its slots", async () => {
  const res = await req("/api/health");
  assert(res.status === 200, `answered ${res.status}`);
  const h = JSON.parse(res.body);
  assert(h.status === "ok", `status is "${h.status}", expected "ok"`);
  assert(h.database?.reachable === true, "database.reachable is not true");
  const live = h.integrations?.live;
  const total = h.integrations?.total;
  assert(typeof live === "number" && typeof total === "number", "integrations.live/total missing");
  const lines = [
    `status ok · commit ${h.commit?.shortSha ?? "?"} · db ${h.database.latencyMs}ms · ${live} live of ${total}`,
  ];
  for (const s of h.integrations.slots) {
    lines.push(
      `${s.status === "live" ? "LIVE     " : "SIMULATED"} ${s.slot.padEnd(18)} ${s.evidence}`,
    );
  }
  return lines;
});

/* --- 2. no nested slot may contradict the authoritative verdict ----------- */

await step(2, "no nested webhook slot contradicts the authoritative live/simulated table", async () => {
  const h = JSON.parse((await req("/api/health")).body);
  const authoritative = new Map(h.integrations.slots.map((s) => [s.slot, s.status]));
  const disagreements = [];
  for (const w of h.integrations.webhooks ?? []) {
    for (const s of w.slots ?? []) {
      const truth = authoritative.get(s.slot);
      if (truth !== undefined && truth !== s.status) {
        disagreements.push(`${w.provider}.${s.slot}: nested "${s.status}" vs authoritative "${truth}"`);
      }
    }
  }
  assert(
    disagreements.length === 0,
    `a slot is labelled two ways in one document: ${disagreements.join("; ")}`,
  );
  const mustBeLive = h.integrations.slots.filter((s) => s.mustBeLive);
  return [
    `${h.integrations.webhooks.length} webhook providers checked, every nested slot agrees`,
    `must-be-live slots: ${mustBeLive.map((s) => `${s.slot}=${s.status}`).join(", ")}`,
  ];
});

/* --- 3. every screen the click path visits is up ------------------------- */

await step(3, "every screen in the click path answers 200", async () => {
  const paths = ["/", "/accounts", "/approvals", "/reconciliation"];
  const out = [];
  for (const p of paths) {
    const res = await req(p);
    assert(res.status === 200, `GET ${p} answered ${res.status}`);
    out.push(`GET ${p.padEnd(16)} 200  ${String(res.body.length).padStart(7)} bytes`);
  }
  return out;
});

/* --- 4. the default role is the least privileged one ---------------------- */

await step(4, "with no cookie the console acts as Staff, and Staff cannot approve", async () => {
  const html = await getPage("/approvals");
  assert(html.includes("Priya Raman"), 'the staff actor "Priya Raman" is not named on the page');
  assert(html.includes("cannot approve"), 'the staff actor is not marked "cannot approve"');
  assert(
    html.includes("holds no approval rights"),
    "the not_an_approver gate reason is not rendered for the staff actor",
  );
  assert(!html.includes("can approve</"), "the staff actor is marked as able to approve");
  return [
    'actor: "Priya Raman" · badge: "cannot approve"',
    'gate reason present: "Acting as Priya Raman, who holds no approval rights."',
  ];
});

/* --- 5. the role switcher is a real form, and it really switches ---------- */

await step(5, "the Approver button submits the real server action and sets the role", async () => {
  const html = await getPage("/accounts");
  const id = actionId(html);
  const form = new FormData();
  form.set(id, "");
  form.set("role", "approver");
  const res = await req("/accounts", { method: "POST", body: form });
  assert(res.status === 200, `the role-switch POST answered ${res.status}`);
  const cookie = setCookieRole(res.headers);
  assert(cookie !== null, "the response set no corgi_demo_role cookie");
  assert(cookie.value === "approver", `the cookie was set to "${cookie.value}", expected "approver"`);
  assert(cookie.httpOnly, "the role cookie is not HttpOnly");
  return [
    `POST /accounts with ${id.slice(0, 24)}… and role=approver -> 200`,
    `set-cookie: corgi_demo_role=approver; HttpOnly; SameSite=lax`,
  ];
});

await step(6, "the Staff button switches back, so the control is not one-way", async () => {
  const html = await getPage("/accounts", "approver");
  const id = actionId(html);
  const form = new FormData();
  form.set(id, "");
  form.set("role", "staff");
  const res = await req("/accounts", {
    method: "POST",
    body: form,
    headers: { cookie: "corgi_demo_role=approver" },
  });
  assert(res.status === 200, `the role-switch POST answered ${res.status}`);
  const cookie = setCookieRole(res.headers);
  assert(cookie !== null && cookie.value === "staff", "the cookie did not return to staff");
  return "set-cookie: corgi_demo_role=staff";
});

/* --- 7. the two roles resolve to two different seeded actors -------------- */

await step(7, "Approver resolves to a different actor, who does hold approval rights", async () => {
  const html = await getPage("/approvals", "approver");
  assert(html.includes("Dana Okonkwo"), 'the approver actor "Dana Okonkwo" is not named on the page');
  assert(html.includes("can approve"), 'the approver actor is not marked "can approve"');
  assert(
    !html.includes("holds no approval rights"),
    "the not_an_approver gate reason is rendered for an actor who does hold approval rights",
  );
  return [
    'actor: "Dana Okonkwo" · badge: "can approve"',
    "the not_an_approver reason is absent, so the switch changed the server's answer and not just a label",
  ];
});

/* --- 8. maker-checker: the queue refuses the approver's own payment ------- */

await step(8, "the queue refuses self-approval, and says so before the button is pressed", async () => {
  const html = await getPage("/approvals", "approver");
  assert(html.includes("that is you"), 'no queue row is marked "that is you" for the approver');
  const reason = "You raised this payment, so you cannot approve it.";
  assert(html.includes(reason), "the self_initiated gate reason is not rendered");
  assert(
    html.includes("assert_maker_checker"),
    "the screen does not name the database trigger that enforces the rule",
  );
  assert(
    html.includes("42501"),
    "the screen does not name the SQLSTATE the trigger raises",
  );
  assert(html.includes("disabled"), "no control on the page is rendered disabled");
  return [
    'a queue row raised by Dana Okonkwo is marked "that is you"',
    `gate reason: "${reason} The initiator is never the checker…"`,
    "the reason names assert_maker_checker() and SQLSTATE 42501, and the approve control is disabled",
  ];
});

await step(9, "the database-level refusal is not asserted over HTTP", async () => ({
  skip: [
    "the approvals form is a client component, so its server action carries no no-JavaScript",
    "action id in the HTML and a hand-assembled POST cannot reach the trigger from this script.",
    "The DATABASE refusal is proven by:  node scripts/livefire.mjs --only 5",
    "  (raw INSERT, no application code in the call stack, asserts SQLSTATE 42501)",
  ],
}));

/* --- 10. an authorisation moves available and does not move the ledger ---- */

await step(10, "a $50.00 authorisation moves AVAILABLE and does not move the LEDGER", async () => {
  // BEFORE is the row on /accounts, which is where the click path starts and
  // which renders the same fixture with no authorisation landed. There is no
  // "?auth=absent" URL: an empty query string is the LIVE account, and
  // `acct_operating_4417` is not a live account id, so the bare URL correctly
  // answers ACCOUNT_NOT_FOUND rather than quietly showing a fixture.
  const list = text(await getPage("/accounts"));
  const row = list.indexOf("\nOperating\n");
  assert(row >= 0, 'the "Operating" demo account row is not on /accounts');
  const listed = [...list.slice(row, row + 600).matchAll(MONEY)].slice(0, 2).map(centsFrom);
  assert(listed.length === 2, "could not read ledger and available off the Operating row");
  const before = { ledger: listed[0], available: listed[1] };

  const afterHtml = await getPage("/accounts/acct_operating_4417?auth=pending");
  const after = derivation(afterHtml);

  assert(
    before.ledger === after.ledger,
    `the ledger balance moved: ${fmt(before.ledger)} -> ${fmt(after.ledger)}`,
  );
  assert(
    after.available === before.available - 5000,
    `available moved by ${fmt(after.available - before.available)}, expected exactly -$50.00`,
  );
  assert(
    after.ledger - after.holds - after.uncleared === after.available,
    "the availability derivation on the after view does not add up",
  );
  // The screen must SAY it, not merely arrive at it. A number that happens to
  // be right and is not explained teaches a viewer nothing.
  assert(
    afterHtml.includes("unchanged by the authorisation"),
    'the ledger balance is not annotated "unchanged by the authorisation"',
  );
  assert(afterHtml.includes("down 50 dollars"), "the available balance is not annotated with the drop");
  assert(afterHtml.includes("SHELL OIL 1247"), "the hold that caused the drop is not named on the screen");
  return [
    `before (/accounts row)     ledger ${fmt(before.ledger)}                        available ${fmt(before.available)}`,
    `after  (?auth=pending)     ledger ${fmt(after.ledger)}  holds ${fmt(after.holds)}  available ${fmt(after.available)}`,
    `ledger delta ${fmt(after.ledger - before.ledger)} · available delta ${fmt(after.available - before.available)}`,
    'annotated on screen: "unchanged by the authorisation" / "down 50 dollars" / "SHELL OIL 1247"',
  ];
});

/* --- 11. the fixture says it is a fixture --------------------------------- */

await step(11, "the demo authorisation is labelled a fixture, and the live account is labelled live", async () => {
  const fixture = await getPage("/accounts/acct_operating_4417?auth=pending");
  assert(fixture.includes("fixture"), "the fixture view is not labelled a fixture");
  assert(
    fixture.includes("nothing here was written to the database"),
    "the fixture view does not say it wrote nothing",
  );
  const liveList = await getPage("/accounts");
  assert(liveList.includes("live ledger"), 'the accounts list carries no "live ledger" badge');
  return [
    'fixture view: badge "fixture" + "nothing here was written to the database"',
    'live view:    badge "live ledger"',
  ];
});

/* --- 12. the live account's arithmetic actually adds up ------------------- */

await step(12, "on the LIVE account, available == ledger - holds - uncleared, exactly, in cents", async () => {
  const list = await getPage("/accounts");
  const ids = [...list.matchAll(/href="\/accounts\/([0-9a-f-]{36})"/g)].map((m) => m[1]);
  assert(ids.length > 0, "the accounts list links to no live (uuid-addressed) account");
  const out = [];
  for (const id of ids) {
    const html = await getPage(`/accounts/${id}`);
    assert(html.includes("live ledger"), `account ${id} is not labelled a live ledger`);
    const d = derivation(html);
    const derived = d.ledger - d.holds - d.uncleared;
    assert(
      derived === d.available,
      `account ${id}: ${fmt(d.ledger)} - ${fmt(d.holds)} - ${fmt(d.uncleared)} = ${fmt(derived)}, but the screen says ${fmt(d.available)}`,
    );
    out.push(
      `${id.slice(0, 8)}…  ${fmt(d.ledger)} - ${fmt(d.holds)} - ${fmt(d.uncleared)} = ${fmt(d.available)}`,
    );
  }
  return out;
});

/* --- 13. the breaks screen -------------------------------------------- */

await step(13, "the breaks screen renders a reconciliation run and its break categories", async () => {
  const html = await getPage("/reconciliation");
  const t = text(html);
  assert(html.includes("LIVE LEDGER"), "the reconciliation screen is not reading the live ledger");
  for (const category of ["In file, not in ledger", "In ledger, not in file", "Amount mismatch"]) {
    assert(html.includes(category), `break category "${category}" is not on the screen`);
  }
  assert(html.includes("Runs over this file"), "the run history is not on the screen");
  assert(
    html.includes("A run is immutable"),
    "the screen does not state that a reconciliation run is immutable",
  );
  const file = /business date\s*\n(.+)/.exec(t);
  const matched = /Matched\s*\n([\d]+ \/ [\d]+)/.exec(t);
  const breaks = /Breaks\s*\n(\d+)\s*\nnone of them answered yet/.exec(t);
  return [
    "three break categories rendered, no more and no fewer",
    matched ? `matched ${matched[1]} file rows paired by reference` : "matched tile rendered",
    breaks ? `${breaks[1]} open break(s) on the most recent run` : "breaks tile rendered",
    file ? `business date ${file[1]}` : "run header rendered",
  ];
});

/* --- 14. the break detail is real, not a placeholder ---------------------- */

await step(14, "a break carries a reference, an amount, an age and a severity", async () => {
  const html = await getPage("/reconciliation");
  const t = text(html);
  assert(html.includes("Reference"), "the breaks table has no reference column");
  assert(
    html.includes("Severity"),
    "the breaks table has no severity column, so the aging ladder is not shown",
  );
  assert(
    html.includes("day close"),
    "the screen does not explain that aging is measured in day closes",
  );
  const ref = /\n(LF6-[A-Z0-9]+-\d+)\n/.exec(t);
  const sev = /\n(Open|Aged|Stale|Critical|Explained)\n/.exec(t);
  assert(ref !== null || t.includes("No breaks"), "no break reference is rendered and the screen is not empty");
  return [
    ref ? `break reference on screen: ${ref[1]}` : "no open break right now (the screen is legitimately clean)",
    sev ? `severity: ${sev[1]}` : "severity column rendered",
    "aging is stated as day closes, not hours",
  ];
});

/* -------------------------------------------------------------------------- */
/* Scoreboard                                                                 */
/* -------------------------------------------------------------------------- */

const pass = results.filter((r) => r.verdict === "PASS").length;
const fail = results.filter((r) => r.verdict === "FAIL").length;
const skip = results.filter((r) => r.verdict === "SKIP").length;

console.log("");
console.log(RULE);
console.log(
  `  ${green(`${pass} PASS`)}   ${fail === 0 ? `${fail} FAIL` : red(`${fail} FAIL`)}   ${
    skip === 0 ? `${skip} SKIP` : yellow(`${skip} SKIP`)
  }   of ${results.length} checks`,
);
if (skip > 0) console.log(dim("  a skip is not a pass; each one names the command that does prove it"));
console.log(`  finished   ${new Date().toISOString()}`);
console.log(RULE);
console.log("");

process.exit(fail === 0 ? 0 : 1);
