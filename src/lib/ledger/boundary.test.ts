/**
 * THE LEDGER BOUNDARY. A test, because a boundary you cannot enforce is a
 * preference.
 *
 * ===========================================================================
 * WHAT IS BEING ASSERTED
 * ===========================================================================
 *
 * `journal_entry`, `journal_line` and `account` are the ledger's own tables.
 * Nothing outside `src/lib/ledger/**` should write SQL against them. Every
 * module that does has, by definition, its own answer to what a balance is —
 * which is how this system ended up with four of them, two of which printed
 * on two screens at the same instant and disagreed by $25,040.70.
 *
 * ===========================================================================
 * WHY THERE IS AN ALLOWLIST RATHER THAN A CLEAN PASS
 * ===========================================================================
 *
 * Because there are 235 of these references across 50 files, and a boundary
 * test that fails on the first run is a boundary test somebody deletes on the
 * second. The measured violations are written down below WITH THE MODULE
 * NAMED, and the test is a RATCHET:
 *
 *   * a file not in the list may have NO references            (new debt: no)
 *   * a file in the list may have FEWER than its recorded count (paying down)
 *   * a file in the list may not have MORE                      (new debt: no)
 *   * a file in the list that is now clean must be REMOVED from it
 *
 * So the list can only shrink, and the number in it is a bill, not a licence.
 *
 * ===========================================================================
 * WHAT WOULD PAY IT DOWN
 * ===========================================================================
 *
 * Not "wrap every query". The modules with the largest counts —
 * `statements/read.ts` (14), `pots/store.ts` (8), `recon/demo.ts` (7),
 * `home/summary.ts` (11) — are each asking one or two questions the ledger
 * module should expose by name: a day's postings, a subtree balance, the
 * entries behind a recon group. Four or five named readers in
 * `src/lib/ledger/` would retire most of this list. That is week-two work and
 * it is on the cut list; what this test buys today is that the list cannot get
 * longer while nobody is looking.
 *
 * NOTE ON THE TEST SUITES. Integration tests are held to the same boundary,
 * deliberately. A test that reaches into `journal_line` to check a balance is
 * a test asserting its own definition of the balance, which is exactly the
 * failure mode this file exists to stop — and `coreloop.mjs`, which DOES
 * re-express the query on purpose so that its verdict does not run through
 * application code, is a script rather than a module and is not scanned.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const SRC = join(REPO_ROOT, "src");
const LEDGER_PREFIX = join("src", "lib", "ledger") + sep;

/**
 * A reference is a table name in a SQL position: `FROM x`, `JOIN x`,
 * `INTO x`, `UPDATE x`, `TABLE x`.
 *
 * Deliberately NOT a bare mention of the word. `account` is an English noun
 * and this repository is full of prose about accounts; matching it loose would
 * make the count meaningless and the test unfixable. Comments are stripped
 * before matching for the same reason — a doc comment explaining what
 * `journal_line` is must not count as reaching for it.
 */
const SQL_TABLE_REFERENCE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:journal_entry|journal_line|account)\b/gi;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function countReferences(path: string): number {
  return (stripComments(readFileSync(path, "utf8")).match(SQL_TABLE_REFERENCE) ?? []).length;
}

function scan(): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  for (const path of walk(SRC)) {
    const rel = relative(REPO_ROOT, path).split(sep).join("/");
    if (relative(REPO_ROOT, path).startsWith(LEDGER_PREFIX)) continue;
    const n = countReferences(path);
    if (n > 0) found.set(rel, n);
  }
  return found;
}

/**
 * THE DEBT, AS MEASURED 2026-09-11T02:40Z, WITH THE MODULE NAMED.
 *
 * 235 references across 50 files. Re-measure with the scanner above, never by
 * hand — and if a concurrent branch legitimately lands new SQL here, the fix
 * is to move it behind a named reader, not to raise the number without a
 * reason anyone would defend out loud.
 *
 * Owning module first, so that a failure names who has to pay rather than
 * only which line broke. These numbers go DOWN or the entry goes away.
 */
const ALLOWED: readonly (readonly [module: string, file: string, refs: number])[] = [
  // ---- screens and server actions -------------------------------------
  ["accounts-console", "src/app/(app)/accounts/actions.ts", 3],
  ["accounts-console", "src/components/accounts/live-source.ts", 7],
  ["home", "src/components/home/console-source.ts", 4],
  ["pots", "src/components/pots/view-state.ts", 1],

  // ---- src/lib, by module ---------------------------------------------
  ["accrual", "src/lib/accrual/accrual.integration.test.ts", 10],
  ["accrual", "src/lib/accrual/store.ts", 5],
  ["approvals", "src/lib/approvals/approvals.integration.test.ts", 5],
  ["approvals", "src/lib/approvals/instructions.ts", 2],
  ["approvals", "src/lib/approvals/release.ts", 2],
  ["cards", "src/lib/cards/cards.integration.test.ts", 1],
  ["disputes", "src/lib/disputes/store.ts", 12],
  ["fx", "src/lib/fx/fx.integration.test.ts", 3],
  ["fx", "src/lib/fx/store.ts", 1],
  ["holds", "src/lib/holds/corrections.ts", 2],
  ["holds", "src/lib/holds/holds.integration.test.ts", 8],
  ["holds", "src/lib/holds/store.ts", 9],
  ["home", "src/lib/home/summary.ts", 11],
  ["kyb", "src/lib/kyb/wire.ts", 2],
  ["mcp", "src/lib/mcp/gateway.ts", 10],
  ["mcp", "src/lib/mcp/mcp.integration.test.ts", 1],
  ["onboarding", "src/lib/onboarding/open.integration.test.ts", 10],
  ["onboarding", "src/lib/onboarding/open.ts", 1],
  ["payees", "src/lib/payees/gate.ts", 1],
  ["payees", "src/lib/payees/payees.integration.test.ts", 5],
  ["pots", "src/lib/pots/demo.test.ts", 2],
  ["pots", "src/lib/pots/pots.integration.test.ts", 18],
  ["pots", "src/lib/pots/store.ts", 8],
  ["rails", "src/lib/rails/plaid/adapter.ts", 7],
  ["rails", "src/lib/rails/plaid/funding.integration.test.ts", 3],
  ["rails", "src/lib/rails/stablecoin/ledger.test.ts", 4],
  ["rails", "src/lib/rails/stablecoin/ledger.ts", 2],
  ["recon", "src/lib/recon/demo.ts", 7],
  ["recon", "src/lib/recon/diff.ts", 4],
  ["recon", "src/lib/recon/planted-break.test.ts", 2],
  ["recon", "src/lib/recon/run.ts", 2],
  ["standing", "src/lib/standing/standing.integration.test.ts", 1],
  ["standing", "src/lib/standing/store.ts", 1],
  ["statements", "src/lib/statements/demo.ts", 3],
  ["statements", "src/lib/statements/publish.ts", 1],
  ["statements", "src/lib/statements/read.ts", 14],
  ["statements", "src/lib/statements/screen.ts", 1],
  ["statements", "src/lib/statements/statements.integration.test.ts", 4],
  ["webhooks", "src/lib/webhooks/consumers/lithic-card.test.ts", 2],

  // ---- the live-fire attack suite --------------------------------------
  ["live-fire", "src/test/livefire/attack-01-fuel-pump-authorisation.test.ts", 2],
  ["live-fire", "src/test/livefire/attack-02-over-capture-release.test.ts", 7],
  ["live-fire", "src/test/livefire/attack-03-bitemporal-correction.test.ts", 12],
  ["live-fire", "src/test/livefire/attack-04-settlement-before-authorisation.test.ts", 2],
  ["live-fire", "src/test/livefire/attack-05-maker-checker.test.ts", 1],
  ["live-fire", "src/test/livefire/attack-06-planted-break.test.ts", 2],
  ["live-fire", "src/test/livefire/attack-07-provider-outage.test.ts", 7],
];

const BY_FILE = new Map(ALLOWED.map(([module, file, refs]) => [file, { module, refs }]));

const HOW_TO_FIX =
  "Move the query behind a named reader in src/lib/ledger/ and call that instead. " +
  "If the query genuinely belongs where it is, say so in DECISIONS and raise the " +
  "number in src/lib/ledger/boundary.test.ts with the reason — but a raised number " +
  "is a decision somebody has to defend, which is the entire point of this test.";

describe("the ledger boundary", () => {
  const found = scan();

  it("no module outside src/lib/ledger/ starts querying the ledger tables", () => {
    const trespassers = [...found.keys()]
      .filter((file) => !BY_FILE.has(file))
      .sort();

    expect(
      trespassers,
      `New SQL against journal_entry / journal_line / account outside ` +
        `src/lib/ledger/:\n  ${trespassers.join("\n  ")}\n\n${HOW_TO_FIX}`,
    ).toEqual([]);
  });

  it("no allowlisted module reaches further into the ledger than it already had", () => {
    const grown: string[] = [];
    for (const [file, { module, refs }] of BY_FILE) {
      const now = found.get(file) ?? 0;
      if (now > refs) {
        grown.push(`${module}: ${file} — was ${refs}, now ${now}`);
      }
    }

    expect(
      grown.sort(),
      `The allowlist is a ratchet and these went the wrong way:\n  ` +
        `${grown.join("\n  ")}\n\n${HOW_TO_FIX}`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries, so it can only shrink", () => {
    const stale: string[] = [];
    for (const [file, { module }] of BY_FILE) {
      if ((found.get(file) ?? 0) === 0) {
        stale.push(`${module}: ${file} — clean now (or gone); delete its line`);
      }
    }

    expect(
      stale.sort(),
      `These allowlist entries are paid off. Remove them, or the list stops ` +
        `being a measurement:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the ledger module itself is exempt, and that exemption is the only one", () => {
    // A guard on the guard: if someone "fixes" a violation by moving the file
    // under src/lib/ledger/, the count drops and nothing is actually better.
    // The prefix is asserted here so that widening it is a visible edit.
    expect(LEDGER_PREFIX).toBe(join("src", "lib", "ledger") + sep);
  });
});
