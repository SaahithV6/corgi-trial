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

  // 1. A stated count that disagrees with the endpoint.
  lines.forEach((line, i) => {
    const m = line.match(/(\d+)\s+(?:live of|of)\s+(\d+)\s*(live)?/i);
    if (m && Number(m[2]) === total && Number(m[1]) !== liveCount) {
      // Allow a line that is explicitly narrating history.
      // A line that dates itself is a record, not a claim. EVALUATION.md is a
      // log of what was true at each iteration and must be allowed to say so.
      if (/previously|used to|before|briefly|was read at|drift|as at|at that commit|at that reading|see Iteration/i.test(line)) return;
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
