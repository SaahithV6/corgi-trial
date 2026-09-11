/**
 * THE REGISTER: which reds are DECIDED, and the comparator that separates a
 * decided red from a new one.
 *
 * ===========================================================================
 * WHY A DASHBOARD NEEDS A WRITTEN-DOWN BEFORE
 * ===========================================================================
 *
 * `src/lib/chaos/baseline.ts` is the shape this module follows, and its rule
 * is explicit: the baseline is CAPTURED from the live database at the start of
 * a run, never written as a literal, because "the four standing populations
 * move as other branches write, and a hard-coded 212 would be a second lie
 * with a shorter half-life than the first".
 *
 * That rule is right for a chaos run and it cannot be obeyed here, for a
 * reason worth stating rather than working around: **a dashboard is a single
 * reading. It has no start-of-run to capture at.** An operator opening this
 * screen at the top of a shift gets one instant, and one instant cannot tell
 * you whether the 257 rows in `v_refused_auth_hold` are the accepted finding
 * or a fresh incident that happens to be the same size.
 *
 * So the comparison point is written down, and it is written down with its
 * provenance so nobody mistakes it for a measurement of the book:
 *
 *   `witnessed`   what `node scripts/dbcheck.mjs` printed
 *   `witnessedAt` when it printed it
 *
 * and the screen renders it as a WATERMARK, never as a licence. The three
 * relations it can produce are all reported:
 *
 *   rows === witnessed   decided, unchanged since that instant
 *   rows  >  witnessed   decided, AND it has grown — the excess is new, and it
 *                        is ranked with the new findings, not absorbed
 *   rows  <  witnessed   somebody repaired it; the watermark in THIS FILE is
 *                        now stale and the screen says so. It is reported and
 *                        never auto-lowered, because a literal that edits
 *                        itself at render time is how one repair buys
 *                        permanent headroom — `baseline.ts`'s `ratchet()`
 *                        exists for exactly that hazard and it can do the
 *                        lowering because it lives inside one run.
 *
 * ===========================================================================
 * WHAT IS AND IS NOT A DECISION
 * ===========================================================================
 *
 * Membership of this register is the ONLY judgement this module makes, and it
 * is not a severity: it is a citation. Every entry names the migration, script
 * or document where the argument for accepting the population lives. A view
 * with no citation is not on the register, whatever it reads, and it therefore
 * renders as NEW. That is the safe direction — an unclassified red is reported
 * rather than excused — and it is the same direction `baseline.ts` takes for a
 * view it never captured.
 *
 * Nothing here ranks by amount, age or "impact". The only ordering this file
 * produces is by the comparison above, and the comparison is arithmetic.
 *
 * No imports, no database, no clock — so `decided.test.ts` proves the
 * comparator without one.
 */

/** One invariant reading, structurally `chaos/observe.ts`'s `InvariantReading`. */
export interface Reading {
  readonly view: string;
  readonly claim: string;
  /** Rows returned. `-1` accompanies a non-null `error`. */
  readonly rows: number;
  /** Set when the view could not be read at all. NOT a pass, ever. */
  readonly error: string | null;
}

/** A red with an argument behind it. */
export interface DecidedEntry {
  readonly view: string;
  /** Rows `scripts/dbcheck.mjs` printed at `witnessedAt`. A comparison point. */
  readonly witnessed: number;
  /** ISO instant of the dbcheck run that produced `witnessed`. */
  readonly witnessedAt: string;
  /** The population, in the view's own words — never a paraphrase of a count. */
  readonly population: string;
  /** Why it stands. One sentence a reviewer can argue with. */
  readonly argument: string;
  /** Where the argument lives. A register entry without one is not an entry. */
  readonly citation: string;
  /**
   * Whether the rows CAN be repaired at all. Three of the four cannot, and
   * saying so is the difference between an accepted finding and a backlog.
   */
  readonly repairable: false | string;
}

/**
 * THE FOUR.
 *
 * `node scripts/dbcheck.mjs` reads 42 passed / 4 failed against this book and
 * these are the four. Every `witnessed` below is that run's own printed count,
 * copied, not recalculated — and the `witnessedAt` is when the run happened.
 *
 * Note on `v_hold_expiry_drift`: the comment beside it in
 * `src/lib/chaos/invariants.ts` says "Non-empty on arrival — 9 rows". The gate
 * reads 12 today. The watermark below is the GATE's reading and not the
 * comment's, because the comment is a note about the day the view was written
 * and the gate is a measurement. The discrepancy is real and is recorded in
 * `docs/DASHBOARD.md` rather than smoothed over here.
 */
export const DECIDED: readonly DecidedEntry[] = [
  {
    view: "v_refused_auth_hold",
    witnessed: 257,
    witnessedAt: "2026-09-11T14:52:00Z",
    population: "301 auth events on holds withholding money",
    argument:
      "Every row is `unanswered`: no verdict was ever observed for the event, which is the state migration 0032 rebuilt the view to be able to see at all. The repairable half — `refused` — was repaired by 0032 (12 holds, $600.00) and reads zero. An unanswered event cannot be repaired by inventing the verdict nobody recorded.",
    citation: "db/migrations/0032_guard_repairs.sql; scripts/dbcheck.mjs explain()",
    repairable: false,
  },
  {
    view: "v_hold_expiry_drift",
    witnessed: 12,
    witnessedAt: "2026-09-11T14:52:00Z",
    population: "966 card holds carrying an authorisation, i.e. two expiry clocks",
    argument:
      "`v_card_auth_hold` reads `card_authorization.expires_at` and `ledger_availability()` reads `hold.expires_at`. That the two agree is a convention inside one function rather than a constraint, so the view was kept wide rather than narrowed to hide the disagreement. Every row is released and withholds zero cents.",
    citation: "src/lib/chaos/invariants.ts, the v_hold_expiry_drift entry (0040)",
    repairable: false,
  },
  {
    view: "v_advice_delta_unsound",
    witnessed: 1,
    witnessedAt: "2026-09-11T14:52:00Z",
    population: "11 stored events derived from an AUTHORIZATION_ADVICE",
    argument:
      "Red on arrival, deliberately: it makes a measured finding visible instead of absorbing it. `deriveCardEvents()` had never been fuzzed; 4,000 generated payloads found advices converted against a negative base. The CONVERSION is fixed — base = max(A,0) — but the stored row is not repairable, because the only compensation would be a second event the network never sent.",
    citation: "db/migrations/0043_auth_floor.sql; docs/FUZZ.md",
    repairable: false,
  },
  {
    view: "v_hold_closure_unexplained",
    witnessed: 4,
    witnessedAt: "2026-09-11T14:52:00Z",
    population: "266 card-auth closures, ALL of them, whatever their declared writer",
    argument:
      "All four are a test fixture's closures, declared `test_harness`, over $132.00 the fold still says is authorised. 0043's header prices both available repairs and both are worse than leaving the rows standing, so they stand and the guard keeps reporting them.",
    citation: "db/migrations/0043_auth_floor.sql; docs/HOLDS.md §10.4",
    repairable: false,
  },
];

const BY_VIEW: ReadonlyMap<string, DecidedEntry> = new Map(
  DECIDED.map((entry) => [entry.view, entry]),
);

export function decidedFor(view: string): DecidedEntry | null {
  return BY_VIEW.get(view) ?? null;
}

/**
 * THE LIMITS.
 *
 * A count is not the same claim as "this holds". Some of these views reach
 * over a population smaller than the thing their claim names, and a screen
 * that printed the zero without the reach would read as more complete than it
 * is. Every sentence below is quoted from the view's own migration or from
 * `dbcheck`'s GUARD REACH block; none of it is inferred here.
 *
 * This is the failure this codebase has catalogued 25 times, and it is what a
 * reviewer will probe. The limit renders NEXT TO the number, not in a footnote.
 */
export const REACH_LIMITS: Readonly<Record<string, string>> = {
  v_internal_transfer_impure:
    "Its population is `rail = 'internal' AND idempotency_key LIKE 'pot:%'` — THE WRITER'S OWN LABEL, not a structural fact. $50.00 was moved out of a pot into `1000 Cash at bank` under an `ach:` key and this view, pot identity-drift and deposit-control all stayed at zero. GUARD REACH measures it at 20 of 88 rows: 68 (77%) are outside it by construction. The structural version keys on `journal_line.account_id IN (SELECT account_id FROM pot)` and does not exist yet — docs/POTS.md §10.3.",
  v_member_approval_without_right:
    "It used to resolve its subject through an INNER JOIN to `team_member`, so a principal with no membership of that business fell out of the FROM clause and was neither judged nor reported — 33 of 186 approvals. Migration 0046 widened it and GUARD REACH now reads 207 of 207. But 'all of them are judged' is not 'all of them are checked by a join': of the 207, 165 are permitted BY NAME as Corgi staff break-glass and 42 by membership. A zero here means nobody unauthorised among the 42; the 165 are exempt by a rule, not by evidence.",
  v_hold_closure_not_terminal:
    "GUARD REACH: ranges over 189 of 320 closures, by declared writer. 131 (41%) are outside it by construction — repairs, operator overrides, disputes, a rail's availability sweep, test fixtures. 52 of the excluded `repair` rows and 4 of the excluded `test_harness` rows carry the guard's own defect shape ($2,551.00 and $132.00). A zero here is a statement about 189 rows.",
  v_interchange_unreversed:
    "GUARD REACH: ranges over 107 of 312 interchange postings. 205 (66%) are outside it by construction.",
  v_accrual_month_drift:
    "GUARD REACH reports its population as EMPTY: 0 complete accrual months. It is green because there is nothing to be green about, which is not the same statement as 'a month's daily shares sum to the fee exactly'.",
};

export function reachLimitFor(view: string): string | null {
  return REACH_LIMITS[view] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The comparator                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What this reading is.
 *
 * Derived entirely from `error`, `rows` and the register. Nothing here is a
 * score, and the order below is the order the screen ranks in.
 */
export type Verdict =
  /** Could not be read. Never a pass — its own band, above everything. */
  | "unreadable"
  /** Not on the register and returning rows. Nobody has argued for these. */
  | "new"
  /** On the register and returning MORE than was witnessed. The excess is new. */
  | "grown"
  /** On the register, reading exactly what was witnessed. Decided. */
  | "decided"
  /** On the register and returning FEWER. Somebody repaired it; the file is stale. */
  | "shrunk"
  /** Not on the register and empty. The ordinary case. */
  | "holding";

export const VERDICT_ORDER: readonly Verdict[] = [
  "unreadable",
  "new",
  "grown",
  "decided",
  "shrunk",
  "holding",
];

/** True for the two bands that mean "this was not here when somebody last looked". */
export function isUnexplained(verdict: Verdict): boolean {
  return verdict === "unreadable" || verdict === "new" || verdict === "grown";
}

export interface Classified {
  readonly view: string;
  readonly claim: string;
  readonly rows: number;
  readonly error: string | null;
  readonly verdict: Verdict;
  /** The register's comparison point, or `null` when the view is not on it. */
  readonly witnessed: number | null;
  /** `rows - witnessed`. Positive is growth, negative is a repair. Null off-register. */
  readonly delta: number | null;
  readonly decided: DecidedEntry | null;
  /** The reach caveat, where one is written down for this view. */
  readonly reachLimit: string | null;
}

export function classify(reading: Reading): Classified {
  const entry = decidedFor(reading.view);
  const reachLimit = reachLimitFor(reading.view);
  const base = {
    view: reading.view,
    claim: reading.claim,
    rows: reading.rows,
    error: reading.error,
    decided: entry,
    reachLimit,
  };

  // An unreadable view and a satisfied one look identical to anything that
  // treats an exception as zero. They are not the same, and the register has
  // no power to excuse one: there is no argument for a count nobody took.
  if (reading.error !== null) {
    return { ...base, verdict: "unreadable", witnessed: entry?.witnessed ?? null, delta: null };
  }

  if (entry === null) {
    return {
      ...base,
      verdict: reading.rows > 0 ? "new" : "holding",
      witnessed: null,
      delta: null,
    };
  }

  const delta = reading.rows - entry.witnessed;
  const verdict: Verdict = delta > 0 ? "grown" : delta < 0 ? "shrunk" : "decided";
  return { ...base, verdict, witnessed: entry.witnessed, delta };
}

/**
 * Every reading, classified and ranked.
 *
 * Ranked by BAND only — `VERDICT_ORDER` — and within a band by the order the
 * gate lists the views, which is `INVARIANT_VIEWS` and therefore the order
 * `dbcheck` prints. Deliberately not by row count, amount or age: this screen
 * has no opinion about which of two unexplained reds matters more, and
 * inventing one would be inventing a severity.
 */
export function rank(readings: readonly Reading[]): readonly Classified[] {
  const position = new Map(readings.map((r, i) => [r.view, i]));
  return [...readings]
    .map(classify)
    .sort((a, b) => {
      const band =
        VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict);
      if (band !== 0) return band;
      return (position.get(a.view) ?? 0) - (position.get(b.view) ?? 0);
    });
}

/** The headline: how many of each band. Counts, not a grade. */
export interface Tally {
  readonly unreadable: number;
  readonly unexplained: number;
  readonly decided: number;
  readonly shrunk: number;
  readonly holding: number;
  readonly total: number;
  /** Rows standing across every red view, whatever its band. */
  readonly standingRows: number;
  /** Rows in excess of the register — the part nobody has argued for. */
  readonly unexplainedRows: number;
}

export function tally(classified: readonly Classified[]): Tally {
  let unreadable = 0;
  let unexplained = 0;
  let decided = 0;
  let shrunk = 0;
  let holding = 0;
  let standingRows = 0;
  let unexplainedRows = 0;

  for (const c of classified) {
    if (c.verdict === "unreadable") {
      unreadable += 1;
      continue;
    }
    standingRows += c.rows;
    if (c.verdict === "new") {
      unexplained += 1;
      unexplainedRows += c.rows;
    } else if (c.verdict === "grown") {
      unexplained += 1;
      unexplainedRows += c.delta ?? 0;
    } else if (c.verdict === "decided") decided += 1;
    else if (c.verdict === "shrunk") shrunk += 1;
    else holding += 1;
  }

  return {
    unreadable,
    unexplained,
    decided,
    shrunk,
    holding,
    total: classified.length,
    standingRows,
    unexplainedRows,
  };
}

/**
 * The one-line answer to "is anything wrong right now".
 *
 * It refuses to say "all clear" while anything is unreadable, and it never
 * calls the decided four a problem. Both halves are the point of the screen.
 */
export function headline(t: Tally): string {
  if (t.unreadable > 0) {
    return `${String(t.unreadable)} invariant view${t.unreadable === 1 ? "" : "s"} could not be read. That is not an all-clear — an unreadable guard and a satisfied one are indistinguishable to anything that treats an exception as zero.`;
  }
  if (t.unexplained > 0) {
    return `${String(t.unexplained)} view${t.unexplained === 1 ? "" : "s"} ${t.unexplained === 1 ? "is" : "are"} red with no argument on the register — ${String(t.unexplainedRows)} row${t.unexplainedRows === 1 ? "" : "s"} nobody has accounted for. Start here.`;
  }
  if (t.shrunk > 0) {
    return `Nothing new. ${String(t.shrunk)} decided view${t.shrunk === 1 ? " reads" : "s read"} FEWER rows than the register records — somebody repaired it, and the watermark in src/components/dashboard/decided.ts is stale.`;
  }
  return `Nothing new. ${String(t.decided)} view${t.decided === 1 ? "" : "s"} red, every one of them on the register with its argument and its citation; ${String(t.holding)} holding.`;
}
