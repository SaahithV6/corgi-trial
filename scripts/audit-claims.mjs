#!/usr/bin/env node
/**
 * Audit every document against the live health endpoint.
 *
 * This exists because the docs drifted from the system within an hour of being
 * written, and one of the drifted files was the checkpoint email to Corgi. It
 * said "5 live of 7" and listed card_webhooks as LIVE, hours after that slot
 * had correctly moved to simulated.
 *
 * "A simulated integration presented as live is the fastest way to fail the
 * entire trial." That sentence does not say "in the product" — a submission
 * document is a presentation too. So the check is mechanical and runnable, not
 * a thing anyone has to remember.
 *
 *   node scripts/audit-claims.mjs [--url https://…]
 *
 * Exits non-zero if any document contradicts the endpoint.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const url =
  process.argv.find((a) => a.startsWith("--url="))?.slice(6) ??
  "https://corgi-trial-psi.vercel.app";

const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`health returned ${res.status}; cannot audit against an unknown truth`);
  process.exit(2);
}
const health = await res.json();
const slots = health.integrations.slots;
const live = new Set(slots.filter((s) => s.status === "live").map((s) => s.slot));
const simulated = new Set(slots.filter((s) => s.status !== "live").map((s) => s.slot));
const liveCount = health.integrations.live;
const total = health.integrations.total;

console.log(`truth: ${liveCount} of ${total} live`);
console.log(`  live:      ${[...live].join(", ")}`);
console.log(`  simulated: ${[...simulated].join(", ")}\n`);

const files = [];
for (const dir of [".", "docs", "thread"]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".md") && !f.endsWith(".local.md")) files.push(join(dir, f));
  }
}

let problems = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");

  // Which lines sit under a dated log heading, e.g. "# ITERATION 2 —
  // 2026-09-10T18:55Z". Everything below one is a RECORD of what was true at
  // that timestamp, not a claim about now, and a record must be allowed to
  // state a number that has since moved — otherwise the only way to keep this
  // check green is to rewrite history, which is the opposite of what the log
  // is for.
  //
  // This is block-level, deliberately. The per-line escape hatches below
  // require every line of a measurement table to carry "as at" boilerplate,
  // and a table that has to repeat its own date on every row stops being read.
  const dated = new Array(lines.length).fill(false);
  let underDatedHeading = false;
  lines.forEach((line, i) => {
    // Only a TOP-LEVEL heading opens or closes a dated block. Sub-headings
    // inherit it. The first version reset on any "#{1,3}", so "## Measured,
    // not assumed" inside a dated iteration cleared the flag and the table
    // underneath it — the entire point of the exemption — was flagged anyway.
    if (/^#\s/.test(line)) {
      underDatedHeading = /\d{4}-\d{2}-\d{2}/.test(line);
    }
    dated[i] = underDatedHeading;
  });

  // The words that make an "N of 7" a claim about INTEGRATIONS rather than
  // about legs, adapters, attacks or screens. Derived from the slot names the
  // endpoint itself publishes, so it cannot drift from them.
  const SLOT_WORDS =
    /integration|slot|card_issuing|card_webhooks|director_kyc|business_registry|open_banking|ach_rail|stablecoin/i;

  // 1. A stated count that disagrees with the endpoint.
  lines.forEach((line, i) => {
    // "4 of 7", "4 live of 7", and "4/7 live". The last one was missed
    // entirely until an iteration log written in that shorthand sailed past a
    // check whose whole job is catching exactly that number. A guard that only
    // understands one spelling of the claim it guards is not a guard.
    const m =
      line.match(/(\d+)\s+(?:live of|of)\s+(\d+)\s*(live)?/i) ??
      line.match(/(\d+)\s*\/\s*(\d+)\s+live/i);

    // THE NUMBER SEVEN IS NOT THE CLAIM. The word `live` beside it is.
    //
    // This matched any "N of 7" anywhere, and there are three unrelated
    // sevens in this repo: coreloop's seven LEGS, the rail matrix's seven
    // ADAPTERS, and the cut list quoting this checker's own original bug. So
    // it reported seven contradictions against an endpoint none of them
    // mentions — and `compliance.mjs` AF2 delegates here, which meant an
    // AUTOMATIC FAIL rule read FAIL on a book that contradicts nothing.
    //
    // That is worse than a nuisance and it is this codebase's own pattern
    // wearing the opposite coat: the twenty-three guards catalogued tonight
    // were blind to what they watched, and this one was blind to what it was
    // watching FOR — it could not tell the population apart, so it could not
    // be right except by luck. A guard that cries wolf on an automatic fail
    // teaches a reader to scroll past the one time it is real.
    //
    // The fix is to require the claim to be ABOUT liveness: either the word
    // `live` is in the match, or the line names an integration slot. A line
    // saying "7 of 7 legs" now says nothing to this rule, which is correct,
    // because it is not a statement about integrations at all.
    const saysLive =
      m !== null && (m[3] !== undefined || /\blive\b/i.test(line) || SLOT_WORDS.test(line));

    // ...and it must be counting SLOTS. "0 of 7 rows", "7 of 7 legs" and
    // "5 of 7 adapters" are all statements about something else that happen to
    // sit near the word `live`, which is how the widened match still found
    // three false positives in a document ABOUT this checker.
    const countsSomethingElse =
      m !== null &&
      new RegExp(`${m[1]}\\s*(?:live\\s+)?(?:of|/)\\s*${m[2]}\\s+(rows?|legs?|adapters?|attacks?|screens?|checks?|tests?|assertions?|disjuncts?)`, "i").test(line);

    // A number inside backticks is being QUOTED, not asserted. The same
    // reasoning as the history exemption below: a document that cannot repeat
    // a past claim without failing the check written because of it is a
    // document that cannot explain its own corrections.
    const isQuoted = m !== null && new RegExp("`[^`]*" + m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^`]*`").test(line);

    if (m && saysLive && !countsSomethingElse && !isQuoted && Number(m[2]) === total && Number(m[1]) !== liveCount) {
      // Allow a line that is explicitly narrating history.
      // A line that dates itself is a record, not a claim. EVALUATION.md is a
      // log of what was true at each iteration and must be allowed to say so.
      if (
        dated[i] ||
        /previously|used to|before|briefly|was read at|drift|as at|at that commit|at that reading|see Iteration/i.test(line) ||
        // A line that QUOTES a past claim while reporting it is a record too.
        // DECISIONS.md documents the bug where the email said "5 live of 7";
        // flagging that sentence would mean the log could not describe its own
        // corrections without failing the check that exists because of them.
        /it said|it read|listed .* as LIVE|hours after|no longer|has since/i.test(line)
      ) return;
      console.log(`${f}:${i + 1}  says ${m[1]} of ${m[2]}, endpoint says ${liveCount}`);
      console.log(`   ${line.trim().slice(0, 100)}`);
      problems++;
    }
  });

  // 2. A simulated slot presented as live. This is the automatic fail.
  for (const slot of simulated) {
    lines.forEach((line, i) => {
      if (!line.includes(slot)) return;
      const claimsLive = /\|\s*\*\*live\*\*\s*\||^\s*LIVE\s+/i.test(line);
      if (!claimsLive) return;
      if (dated[i]) return;
      if (/previously|used to|before|briefly|read \*\*LIVE\*\*|as at|at that commit/i.test(line)) return;
      console.log(`${f}:${i + 1}  presents SIMULATED slot '${slot}' as LIVE`);
      console.log(`   ${line.trim().slice(0, 100)}`);
      problems++;
    });
  }
}

console.log(problems === 0
  ? "\nno document contradicts the endpoint"
  : `\n${problems} contradiction(s) — fix before submitting`);
process.exit(problems === 0 ? 0 : 1);
