/**
 * Which businesses on this book are CUSTOMERS, and which are test fixtures.
 *
 * ============================================================================
 * The front door sums customer money across every open `2100` leaf. Three of
 * the seven on this book were opened by test suites with raw SQL, and one of
 * them sits at **-$858,941.45**. Summed in silently, the operator console's
 * headline "Customer money on this book" read **-$196,505.08** at
 * 2026-09-11T16:00Z — a bank that appears to owe its customers negative money,
 * on camera, with no way for the reader to tell which part of it is real.
 * (Customer money at that instant: $105,600.67. It moves; the sign of the
 * headline was the defect and that did not.)
 * ============================================================================
 *
 * ─── The measurement this file exists because of ────────────────────────────
 *
 * `Holds Integration Fixture Co.` (`7e57b115-0000-5000-a000-000000000001`,
 * deposit leaf `66fdc0f8-9fc9-4119-88aa-895e0dc90f00`) stood at, under
 * `ledger_availability()` — the one authoritative definition — five terms:
 *
 *     ledger      -$858,941.45
 *     holds          $4,283.00
 *     uncleared          $0.00
 *     committed          $0.00
 *     available   -$863,224.45
 *
 * `node scripts/rebuild.mjs` replays the book from its events and derives
 * exactly those figures: **0 rebuild disagreements.** The rows are not a
 * reader disagreeing with a writer, and they are not a mispost. They are four
 * $500,000.00 card force-posts written by
 * `src/lib/holds/holds.integration.test.ts` §4b between 12:28Z and 12:36Z on
 * 2026-09-11, of which only two reached the RETURN that the same test posts a
 * few assertions later. The other two runs threw in between and the refund was
 * never reached. That suite is wrapped in `rolledBack()` now and the leaf has
 * not moved since 12:49:50Z.
 *
 * ─── So the rows stay, and the SCREEN changes ───────────────────────────────
 *
 * There is no honest way to make that number smaller. Deleting or updating
 * journal rows is refused at four layers and is the trial's automatic fail.
 * Appending a compensating RETURN would be worse than useless: no provider
 * ever sent one, so the correction would be a card event this system invented
 * to make its own screen look better — "the correction shaped like the
 * defect", which is the argument DECISIONS records for leaving 1,712
 * out-of-band value dates MARKED rather than reversed, and the argument
 * migration 0041 records for marking seven fixture FX settlements rather than
 * deleting them.
 *
 * `Holds Integration Fixture Co.` genuinely IS -$863,224.45. The defect is
 * that a screen presented that figure as part of a live customer total.
 *
 * ─── NOTHING IS FILTERED ────────────────────────────────────────────────────
 *
 * 0041 §"AND WHY NOT A FILTER" is the rule here too, and it is worth restating
 * because the tempting fix is one `WHERE` clause and nobody ever sees the
 * fixtures again: *a filter that hides fixtures is one edit — one widened
 * predicate, one careless OR — away from hiding a real failure, and it hides
 * it from the screen whose whole job is to be the record.*
 *
 * So every row still renders, the account count does not move, and the totals
 * are SPLIT and both halves printed rather than one half suppressed.
 *
 * ─── How a fixture is recognised ────────────────────────────────────────────
 *
 * By its EIN, which is a fact already in the book rather than a list this file
 * has to keep up to date.
 *
 * Every real business on this book carries nine bare digits — `000000000`,
 * `222221005`, `222221000`. Every business a test suite has ever opened here
 * carries a hyphenated placeholder of the form `00-000000N`, typed as a
 * literal into the suite that writes it (`holds.integration.test.ts:195`,
 * `pots.integration.test.ts:349`, `fuzz.test.ts:1647`, the live-fire attacks).
 * `00` is not an allocated IRS EIN prefix and no EIN is punctuated in this
 * schema, so the shape is not a coincidence a real customer could stumble
 * into.
 *
 * That criterion is the OPERATIVE one, and it is deliberately the one that
 * cannot go stale: a sixth fixture business opened by a suite tomorrow is
 * labelled the moment it appears, without anybody editing this file.
 *
 * `KNOWN_FIXTURES` adds nothing to the decision. It carries the two fields
 * `fx_quote_fixture` carries and for the same reasons — WHAT WROTE IT, as a
 * file path the next reader can open, and WHY IT IS NOT REAL, in a sentence a
 * stranger can act on. A fixture the roster does not name is still a fixture;
 * it just gets the generic sentence instead of the specific one.
 *
 * The two criteria are a UNION rather than an intersection. Labelling a real
 * customer as a fixture is a visible, correctable embarrassment; presenting a
 * test suite's half-million-dollar overdraft as customer money is the failure
 * this file exists to prevent. Unknown is never a pass, and the safe direction
 * is to label more rather than fewer.
 */

/** Where a fixture business came from, and why it is not a customer. */
export type FixtureOrigin = {
  /** What wrote it — a file path, so the next reader can open it. */
  readonly source: string;
  /** Why this is not a real customer position. Never empty. */
  readonly reason: string;
};

/** One business, as much of it as classification needs. */
export type ClassifiableBusiness = {
  readonly businessId: string;
  readonly ein: string | null;
};

/**
 * `00-0000000` — the placeholder shape, and only that shape.
 *
 * Anchored at both ends and exact in length. A looser `^00-` would also match
 * a hypothetical real EIN rendered with punctuation, and the whole value of
 * this predicate is that it cannot be satisfied by accident.
 */
const PLACEHOLDER_EIN = /^00-\d{7}$/;

/** True for the EIN shape no customer has and every test suite here types. */
export function isPlaceholderEin(ein: string | null | undefined): boolean {
  return typeof ein === "string" && PLACEHOLDER_EIN.test(ein.trim());
}

/**
 * The fixtures we can name, with the file that opened each one.
 *
 * Annotation only — see the header. Adding an entry here changes the sentence
 * a reader sees, never whether the row is treated as customer money.
 */
const KNOWN_FIXTURES: ReadonlyMap<string, FixtureOrigin> = new Map([
  [
    "7e57b115-0000-5000-a000-000000000001",
    {
      source: "src/lib/holds/holds.integration.test.ts",
      reason:
        "Opened with raw SQL by the card-hold integration suite, which never ran KYB and was never onboarded. Its ledger is dominated by two $500,000.00 force-posts from scenario 4b whose matching RETURN was never reached, because the suite committed to this database before it was wrapped in a rolled-back transaction. Real rows, replayed identically by scripts/rebuild.mjs, and not one cent of customer money.",
    },
  ],
  [
    "7e57b115-0000-5000-a000-0000000000f2",
    {
      source: "src/lib/holds/fuzz.test.ts",
      reason:
        "Opened by the hold fuzzer so generated card-event sequences have somewhere to post. Its balance is whatever the last corpus happened to authorise and clear; it is a property-test workspace, not a position anyone is owed.",
    },
  ],
  [
    "70747300-0000-5000-a000-000000000001",
    {
      source: "src/lib/pots/pots.integration.test.ts",
      reason:
        "Opened by the pots integration suite to exercise sub-account allocation against the live book. Never onboarded, never verified, never a customer.",
    },
  ],
  [
    "f1e1fa3e-0000-4000-8000-000000000003",
    {
      source: "src/test/livefire/attack-03-bitemporal-correction.test.ts",
      reason:
        "A target opened by live-fire attack 3 so a bitemporal correction can be driven against a real account without touching a demo customer's book.",
    },
  ],
  [
    "f1e1fa7e-0000-4000-8000-000000000007",
    {
      source: "src/test/livefire/attack-07-provider-outage.test.ts",
      reason:
        "A target opened by live-fire attack 7 so a provider outage can be driven against a real account without touching a demo customer's book.",
    },
  ],
]);

/** The sentence a fixture gets when the roster does not name it. */
const UNNAMED_FIXTURE: FixtureOrigin = {
  source: "unknown — a test suite, identified by its placeholder EIN",
  reason:
    "This business carries a placeholder EIN of the form 00-000000N. Every business opened through onboarding carries nine bare digits; every business opened by a test suite in this repository carries this shape. Its figures are a test artefact and are not customer money.",
};

/**
 * Classify one business. `null` means a real customer position.
 *
 * Pure, and takes the EIN as a value rather than reading it, so the whole
 * classification is testable without a database and the console keeps its rule
 * that only `console-source.ts` knows a database exists.
 */
export function fixtureOriginOf(
  business: ClassifiableBusiness,
): FixtureOrigin | null {
  const named = KNOWN_FIXTURES.get(business.businessId);
  if (named !== undefined) return named;
  if (isPlaceholderEin(business.ein)) return UNNAMED_FIXTURE;
  return null;
}

/** Every business id the roster names, for the test that checks it against the book. */
export function rosteredFixtureIds(): readonly string[] {
  return [...KNOWN_FIXTURES.keys()];
}
