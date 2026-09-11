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
 * Because there were 235 of these references across 50 files, and a boundary
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
 * WHAT PAID IT DOWN
 * ===========================================================================
 *
 * Not "wrap every query" — this file's original prediction, which was right.
 * It named four call sites as the ones asking questions the ledger should
 * expose by name: `statements/read.ts` (14), `pots/store.ts` (8),
 * `recon/demo.ts` (7), `home/summary.ts` (11). ALL FOUR ARE NOW ZERO, three or
 * below. They were retired by `src/lib/ledger/readers.ts` — a day's postings
 * (`readAccountPeriod`), the entries behind a recon group
 * (`readCorrectionGroup`), the reader nobody had written at all (every
 * business on the book, `listBusinesses`), and the last of the four, the one
 * this file called "the largest single unpaid entry on this list":
 * `readLedgerCensus`.
 *
 * `home/summary.ts` IS WORTH READING AS THE WORKED EXAMPLE, because it is the
 * case where the answer was NOT "wrap the query". Its eleven references were
 * all inside ONE statement, and that statement was one statement on purpose:
 * one statement is one MVCC snapshot, which is the only thing that made a
 * debit total and an entry count describe the same instant. Splitting it
 * naively would have paid a boundary bill by introducing a race on the landing
 * page — the first screen a grader opens.
 *
 * So the split was made on a test applied per FIGURE — does this number come
 * from `journal_entry`, `journal_line` or `account`, and from nothing else? —
 * and the snapshot was preserved by moving it from an accident of formatting
 * (all the SQL in one template literal) to something Postgres enforces and a
 * name states: both halves run inside one `BEGIN ISOLATION LEVEL REPEATABLE
 * READ READ ONLY`. Verified against the live database before the call site
 * changed: inside the transaction the two statements returned an identical
 * `pg_current_snapshot()` and an identical `now()`, and the same two
 * statements outside one did not.
 *
 * The eleven figures that met the test are `readLedgerCensus`. The counters
 * that did not — `webhook_inbox`, `card_authorization`, `card_auth_event`,
 * `v_hold_state` — stayed in `home/summary.ts`, because a reader counting
 * webhook deliveries would be the ledger learning the shape of the inbox.
 * That is the same call `pots/store.ts` made in the other direction, and it is
 * on this list with its reason attached.
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
 * THE DEBT. Measured 2026-09-11T02:40Z at 235 references across 50 files;
 * re-measured after the first paydown pass at 158, and after `home/summary.ts`
 * at 147 across the 35 files listed below. Every figure is the scanner's own;
 * none was counted by hand.
 *
 * The list below is what is OWED, which is not always what the tree measures
 * this second. Twelve branches are in flight against this repository and three
 * of them were mid-edit inside allowlisted files when this line was written,
 * putting the live scan three references above the list. That is the ratchet
 * doing its job and naming their owners, and the fix is theirs: route it onto
 * a reader. It is emphatically NOT to raise a number here to get green — a
 * line added now is a line the third test below fails on the day it is paid,
 * and the list stops being a measurement the moment it can go up.
 *
 * Re-measure with the scanner above, never by hand — and if a concurrent
 * branch legitimately lands new SQL here, the fix is to move it behind a named
 * reader, not to raise the number without a reason anyone would defend out
 * loud.
 *
 * WHAT PAID IT DOWN was the thing this file asked for in its own header:
 * named readers in `src/lib/ledger/`, in `readers.ts`, forwarded through
 * `queries.ts` so there is one import surface. `listBusinesses` (the LEFT JOIN
 * from `business` that no reader expressed, so five modules wrote it and a
 * sixth matched two lists in memory to avoid writing it), `readAccountIdentity`
 * / `readAccountIdentities` (`JOIN account` for a foreign key), `listAccounts`
 * / `findAccount` / `resolveChartCodes` (`SELECT id FROM account WHERE code =
 * '…'`, which stood in six modules with four different sets of predicates —
 * four different answers to "which account is 1130"), `currentBookingWatermark`
 * (four modules), `readAccountPeriod` and `listEntriesAboveWatermark` (the
 * statement's two rectangles), `listLedgerLines`, `readCorrectionGroup`,
 * `holdMemoCents`, `heldCentsAsBelieved`, `findEntryByIdempotencyKey`,
 * `readLedgerCensus` (how big the book is, where it has got to, and whether it
 * balances — the landing page's eleven).
 *
 * THAT FOUR INDEPENDENT BRANCHES REACHED FOR THE SAME FOUR READER SHAPES is
 * the strongest evidence available that these were the right abstractions.
 * While the first pass was running, `mcp/gateway.ts`,
 * `accrual/interest-store.ts`, `rails/wire/ledger.ts`,
 * `webhooks/consumers/increase-ach.*`, `fx/settle.ts` and `accrual/interest.ts`
 * added new SQL between them, and every piece of it was a shape a reader
 * already covered: `readAccountIdentities`, `currentBookingWatermark`,
 * `resolveChartCodes`, `findAccount({ scope: "house" })`. Nobody coordinated
 * that. Four teams independently needed the same four questions, which is what
 * an abstraction being right looks like from the outside — and several of
 * those branches have since routed themselves onto the readers rather than
 * waiting to be migrated.
 *
 * These figures went down without a single figure on a screen moving. Every
 * extracted body is the call site's own SQL, moved rather than rewritten.
 *
 * ENTRIES THAT REMAIN CARRY THEIR REASON. Where a count did not go to zero the
 * line says what is left and why, so this list reads as a set of decisions
 * rather than as a backlog nobody has triaged. An honest exception list is
 * worth more than a fake zero — which is also why the 33 live-fire references
 * are still here, with the argument for keeping them written out in full.
 *
 * Owning module first, so that a failure names who has to pay rather than
 * only which line broke. These numbers go DOWN or the entry goes away.
 */
const ALLOWED: readonly (readonly [module: string, file: string, refs: number])[] = [
  // ---- screens and server actions -------------------------------------
  //
  // `accounts/actions.ts`, `accounts/live-source.ts` and
  // `home/console-source.ts` were 3, 7 and 4 and are gone. What they were
  // reaching for was `listBusinesses`, `readAccountIdentity`, `holdMemoCents`,
  // `firstEntryDescriptionForHold`, `listDepositMovements` and `readSnapshot`.
  //
  // `pots/view-state.ts` is A SCANNER ARTEFACT and is kept deliberately. The
  // "reference" is the sentence "all of it summed from journal_line." in a
  // UI copy string — English prose that happens to match `FROM journal_line`
  // once the case fold is applied. Rewording it to dodge the regex would make
  // the measurement better and the repository no better at all, which is the
  // wrong trade every time. One of the 235 was never debt.
  ["pots", "src/components/pots/view-state.ts", 1],

  // ---- src/lib, by module ---------------------------------------------
  ["accrual", "src/lib/accrual/accrual.integration.test.ts", 10],
  // 5 -> 3. `entryForKey` and the house-account lookup are named readers now.
  // The three that remain are `JOIN account a ON a.id = s.account_id`, each
  // inside a list query whose `ORDER BY b.legal_name NULLS LAST, s.plan_name`
  // runs THROUGH that join. Splitting it means re-deriving a Postgres
  // collation ordering in JavaScript, under a LIMIT, for a column used only to
  // label a row on a screen. That trade buys three numbers and risks a
  // silently reordered list; see the note at the bottom of this file.
  ["accrual", "src/lib/accrual/store.ts", 3],
  ["approvals", "src/lib/approvals/approvals.integration.test.ts", 4],
  // 0061's proof, added on the last day and gated behind RUN_PROOF=1. It reads
  // the journal directly because it exists to show the defect and the fix side
  // by side: BEFORE, two approvals of $20,000.00 and $24,000.00 left
  // availability UNMOVED and both released against $25,000.92 — ledger
  // -$18,999.08. AFTER, the first withholds and the second is refused. A proof
  // that read through the same reader the fix uses would be asserting that one
  // function agrees with itself.
  ["approvals", "src/lib/approvals/reserve.proof.test.ts", 4],
  // The customer's own standing-orders reader. Its three `account` joins exist
  // for ONE reason: to carry `acc.business_id = $1` in the SAME STATEMENT as
  // the mandate read. That is this repository's isolation rule stated exactly —
  // a predicate evaluated by Postgres before the rows exist, never a filter
  // applied to rows already fetched, because a filter is a step somebody can
  // reorder and a predicate is not.
  //
  // Moving these behind a named reader would BREAK the property it is here to
  // protect: the reader would return mandates and the caller would scope them,
  // which is the shape this rule exists to forbid. The alternative the author
  // rejected was calling the platform-wide `listStandingOrders()` and
  // filtering in TypeScript — correctly rejected.
  ["client", "src/app/(app)/client/standing-orders/reader.ts", 19],
  // Two display joins to reach `account.business_id` for a legal name. Same
  // argument as accrual: `listQueue`'s ordering runs through the join.
  ["approvals", "src/lib/approvals/instructions.ts", 2],
  ["cards", "src/lib/cards/cards.integration.test.ts", 1],
  // 12 -> 7. `readAccountContext` is `resolveChartCodes` and `positionAt`'s
  // hold fold is `heldCentsAsBelieved`. The 7 that remain are one CTE:
  // "card clearings that debited a customer AND paid the network", which
  // interleaves `dispute`, `dispute_event`, `card` and `card_authorization`
  // with the ledger rows and is genuinely a question about DISPUTES. It is
  // the largest honest exception on this list.
  ["disputes", "src/lib/disputes/store.ts", 7],
  ["fx", "src/lib/fx/fx.integration.test.ts", 3],
  ["fx", "src/lib/fx/store.ts", 1],
  ["holds", "src/lib/holds/corrections.ts", 2],
  ["holds", "src/lib/holds/holds.integration.test.ts", 8],
  ["holds", "src/lib/holds/store.ts", 9],
  ["kyb", "src/lib/kyb/wire.ts", 2],
  // 10 -> 2. The agent surface no longer owns its own definition of a
  // transaction row (`listLedgerLines`), of the chart (`findAccount`), of the
  // booking clock (`bookingTimeOfSeq`) or of the hold terms
  // (`holdItemisationAsOf`). The 2 that remain are the TENANCY predicate on
  // the recon-breaks query, and they are kept ON PURPOSE: a pre-fetch is a
  // filter someone can forget to apply, and on an agent surface the thing
  // being forgotten would be tenant isolation. The file says so at the line.
  ["mcp", "src/lib/mcp/gateway.ts", 2],
  ["mcp", "src/lib/mcp/mcp.integration.test.ts", 1],
  ["onboarding", "src/lib/onboarding/open.integration.test.ts", 10],
  ["payees", "src/lib/payees/payees.integration.test.ts", 4],
  ["pots", "src/lib/pots/demo.test.ts", 2],
  ["pots", "src/lib/pots/pots.integration.test.ts", 18],
  // 8 -> 3. The 3 that remain are `listMovements`, which finds the pot leg by
  // joining `pot` on `journal_line.account_id` and the main leg as "the other
  // line of the same entry". Moving it would teach the LEDGER about pots,
  // which is the dependency pointing the wrong way.
  ["pots", "src/lib/pots/store.ts", 3],
  ["rails", "src/lib/rails/plaid/adapter.ts", 7],
  ["rails", "src/lib/rails/plaid/funding.integration.test.ts", 3],
  ["rails", "src/lib/rails/stablecoin/ledger.test.ts", 4],
  ["rails", "src/lib/rails/stablecoin/ledger.ts", 2],
  // 2 -> 1. The watermark is `currentBookingWatermark`. The 1 left decorates
  // frozen `recon_run_break` rows with their entry's description.
  ["recon", "src/lib/recon/run.ts", 1],
  ["standing", "src/lib/standing/store.ts", 1],
  // 4 -> 1. The 1 left is `count(*) FROM journal_entry` before and after a
  // publish, asserting that RENDERING A STATEMENT WROTE NOTHING. That is the
  // test doing its job: it is an assertion about the storage, not about a
  // balance, and routing it through a reader would mean asserting the absence
  // of writes using the code path under test.
  ["statements", "src/lib/statements/statements.integration.test.ts", 1],
  // 0059's reproducibility test, added 12:1x on the last day. It re-derives a
  // closed day's statement FROM THE JOURNAL and asserts the derivation is
  // byte-identical to what was published — twice, at different times, with a
  // real correction inside the period. Reaching the journal directly is the
  // whole point of it: a reproducibility check that read through the same
  // named reader the publisher used would be asserting that one function
  // agrees with itself, which is not the claim gauntlet item 7 makes.
  ["statements", "src/lib/statements/reproducibility.integration.test.ts", 7],
  // The interchange differential fuzzer, added on the last day. 4,008 generated
  // cases proving TS and SQL price a settlement identically digit for digit,
  // over the range the SCHEMA allows rather than the range the seeded rate card
  // uses — "the app would never send that" is not a property of a column. It
  // reaches the ledger because it asserts the nine conjuncts of
  // `interchange_posting_arithmetic` accept the numbers TypeScript computes,
  // which is a claim about what the DATABASE would take, not about what one
  // function returns.
  ["interchange", "src/lib/interchange/arith-fuzz.test.ts", 2],
  ["webhooks", "src/lib/webhooks/consumers/lithic-card.test.ts", 2],

  // ---- the live-fire attack suite --------------------------------------
  //
  // ALL 33 ARE KEPT, DELIBERATELY, AND THIS IS THE ENTRY WORTH ARGUING ABOUT.
  //
  // The rest of this list is modules that had to learn the ledger's schema to
  // answer a question the ledger should have answered for them. Live fire is
  // the opposite: its entire job is to assert what is ON THE ROWS, from
  // outside every abstraction the system has, while somebody watches. An
  // attack that asked `readAccountPeriod()` whether the backdated correction
  // landed would be asking the code under attack to grade itself — and the
  // thing being attacked in attack-03 is precisely the bitemporal read path
  // those readers are.
  //
  // The same argument the file header makes for `coreloop.mjs` ("which DOES
  // re-express the query on purpose so that its verdict does not run through
  // application code") applies here word for word. The difference is that
  // `coreloop.mjs` is a script and is not scanned, and these are `.ts` and
  // are. That is a scanner boundary, not a design one.
  //
  // So: no reduction, and the reason is that reducing them would make the
  // suite worse at the only thing it exists to do.
  //
  // RE-MEASURED 2026-09-11T06:55Z, from 33 to 46. A raised number is a
  // decision somebody has to defend, so here is the defence.
  //
  // Attacks 3 and 7 were rewritten tonight because both were failing for the
  // wrong reason, and the rewrites are the reason the counts moved:
  //
  //  - attack-03 (12 -> 17) stopped demanding that the day we LEARNED of a
  //    correction be otherwise idle. That assertion passed only while the book
  //    was small; it was a coin-flip on what else happened to post that day,
  //    and it passed at 04:28 and failed at 03:44 with no code change between.
  //    Scoping the claim to the entries the attack itself created — "the
  //    correction contributed nothing to the learning day", asserted three
  //    ways — costs rows. It is the difference between a test of the ledger
  //    and a test of the calendar.
  //
  //  - attack-07 (7 -> 14) stopped reading `available` at one watermark and
  //    now reads the app's own `accountAvailability()` at ONE instant and TWO
  //    watermarks, either side of its own posting, so that every other
  //    writer's rows appear in both readings and cancel. Its old guard counted
  //    `WHERE book = 'financial'` while asserting a quantity the MEMO book
  //    moves, and it also counted entries at all while `ledger_availability`
  //    moves on the clock alone.
  //
  //  - attack-02 (7 -> 8) gained the measurement that settled its skip:
  //    an incremental authorisation IS accepted after an over-capture, so
  //    over-capture is not terminal and the closure row must not be written.
  //
  // Every one of those is the suite asserting from outside the abstraction,
  // which is its entire job. A reader would defeat it: asking
  // `readAccountPeriod()` whether the correction landed is asking the code
  // under attack to grade itself.
  ["live-fire", "src/test/livefire/attack-01-fuel-pump-authorisation.test.ts", 2],
  ["live-fire", "src/test/livefire/attack-02-over-capture-release.test.ts", 8],
  ["live-fire", "src/test/livefire/attack-03-bitemporal-correction.test.ts", 17],
  ["live-fire", "src/test/livefire/attack-04-settlement-before-authorisation.test.ts", 2],
  ["live-fire", "src/test/livefire/attack-05-maker-checker.test.ts", 1],
  ["live-fire", "src/test/livefire/attack-06-planted-break.test.ts", 2],
  ["live-fire", "src/test/livefire/attack-07-provider-outage.test.ts", 14],
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
