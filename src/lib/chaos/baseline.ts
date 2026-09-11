/**
 * The invariant BASELINE: a known population, and the change against it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE BUG THIS MODULE EXISTS FOR
 *
 * `chaos.livefire.test.ts` used to assert that EVERY invariant view was empty,
 * every time, as its statement that "the invariants held throughout". Four of
 * them are not empty and are never going to be: `v_refused_auth_hold`,
 * `v_hold_expiry_drift`, `v_advice_delta_unsound` and
 * `v_hold_closure_unexplained` each carry a standing, measured, deliberately
 * unrepairable population, priced and explained in `scripts/dbcheck.mjs`'s
 * `explain()` and in docs/HOLDS.md. `node scripts/dbcheck.mjs` reads 37 passed
 * / 4 failed for exactly that reason and the four are accepted findings.
 *
 * So the suite could not pass under ANY behaviour of the system it was
 * testing. It went red whether chaos corrupted the book or left it untouched,
 * which means it was not measuring chaos at all — it was measuring a fact
 * about the book that was already true before chaos was armed. A test that
 * fails identically in both worlds distinguishes nothing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SHAPE `dbcheck.mjs` ALREADY USES
 *
 * `dbcheck --prove` does not demand zero either. It counts the view, builds a
 * violating state, counts again, and asserts the DELTA — `${before} -> ${after}
 * after ${how}` — then checks the rollback put the population back. A known
 * population plus a reported change is strictly more information than a
 * demand for emptiness, and it is the only form that can survive a book with
 * accepted findings on it.
 *
 * This module is that shape, as data, for a live run:
 *
 *   capture   the population at the start of the run, before anything is armed
 *   compare   every later reading against it
 *   assert    NO VIEW GREW — "chaos introduced no new violation"
 *   ratchet   a view that SHRANK becomes the new known population, so a repair
 *             cannot be spent twice and a later climb back is still caught
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT SOFTEN
 *
 * An UNREADABLE view is never a pass, baseline or no baseline. There is no
 * baseline value that excuses one, because an unreadable invariant and a
 * satisfied one look identical to anything that treats an exception as zero —
 * the failure mode this repository keeps finding in its own guards. So it is
 * reported on its own channel and asserted separately from the deltas.
 *
 * And the baseline is captured ONCE, from the live database, at the start of
 * the run. It is never a literal in a test file: the four standing populations
 * move as other branches write, and a hard-coded 212 would be a second lie
 * with a shorter half-life than the first.
 *
 * No imports, no database, no clock — so the comparison itself is provable
 * without one, and `baseline.test.ts` proves it fails when it should.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** One invariant view, as read. Structurally `observe.ts`'s `InvariantReading`. */
export interface InvariantRowCount {
  readonly view: string;
  readonly claim: string;
  /** Rows returned. `-1` accompanies a non-null `error`. */
  readonly rows: number;
  /** Set when the view could not be read at all. NOT a pass, ever. */
  readonly error: string | null;
}

/** The known population: view -> rows, at the instant it was captured. */
export type InvariantBaseline = Map<string, number>;

export interface CapturedBaseline {
  /** The population every later reading is compared against. */
  readonly baseline: InvariantBaseline;
  /** The views that were NOT empty when the baseline was taken. */
  readonly standing: readonly InvariantRowCount[];
  /** Views that could not be read at capture. Never a pass. */
  readonly unreadable: readonly InvariantRowCount[];
  /** Total rows standing across every view, at capture. */
  readonly standingRows: number;
  readonly capturedAt: string;
}

/**
 * Take the population as it stands.
 *
 * An unreadable view is recorded with its error and DELIBERATELY not given a
 * baseline entry: there is no known population for a view nobody could count,
 * and inventing one (zero, or the previous run's number) is how an unreadable
 * guard becomes a silent pass.
 */
export function captureBaseline(
  readings: readonly InvariantRowCount[],
  now: Date = new Date(),
): CapturedBaseline {
  const baseline: InvariantBaseline = new Map();
  const standing: InvariantRowCount[] = [];
  const unreadable: InvariantRowCount[] = [];

  for (const reading of readings) {
    if (reading.error !== null) {
      unreadable.push(reading);
      continue;
    }
    baseline.set(reading.view, reading.rows);
    if (reading.rows !== 0) standing.push(reading);
  }

  return {
    baseline,
    standing,
    unreadable,
    standingRows: standing.reduce((sum, r) => sum + r.rows, 0),
    capturedAt: now.toISOString(),
  };
}

/** One view that returned more rows than the known population. */
export interface InvariantGrowth {
  readonly view: string;
  readonly claim: string;
  /** The population this run captured. */
  readonly known: number;
  /** What it reads now. */
  readonly now: number;
  /** `now - known`, always positive. */
  readonly grew: number;
}

/**
 * Every view that GREW against the known population.
 *
 * This is the raw material of the assertion — "chaos introduced no new
 * violation" — and it is returned STRUCTURED rather than as sentences, because
 * the caller has one more question to ask of each line before it is allowed to
 * be a failure: are the new rows THIS RUN's? On a database eleven branches
 * write to, growth and blame are not the same measurement, and a suite that
 * conflated them would report another process's writes as chaos corrupting the
 * book. The live suite attributes each line by `provider_auth_id` and fails on
 * the ones it cannot exonerate.
 *
 * A view with no baseline entry — never captured, or unreadable at capture —
 * counts from ZERO, which is the safe direction: an uncounted view that now
 * returns rows is reported rather than excused.
 */
export function growth(
  baseline: InvariantBaseline,
  readings: readonly InvariantRowCount[],
): readonly InvariantGrowth[] {
  const grew: InvariantGrowth[] = [];
  for (const reading of readings) {
    if (reading.error !== null) continue; // its own channel; see unreadable()
    const known = baseline.get(reading.view) ?? 0;
    if (reading.rows > known) {
      grew.push({
        view: reading.view,
        claim: reading.claim,
        known,
        now: reading.rows,
        grew: reading.rows - known,
      });
    }
  }
  return grew;
}

/** One growth, in the `before -> after` form `dbcheck --prove` prints. */
export function describeGrowth(g: InvariantGrowth): string {
  return `${g.view}: ${String(g.known)} -> ${String(g.now)} (+${String(g.grew)}) — ${g.claim}`;
}

/** Every view that could not be read. Separate channel, separate assertion. */
export function unreadable(readings: readonly InvariantRowCount[]): readonly string[] {
  return readings
    .filter((r) => r.error !== null)
    .map((r) => `${r.view}: ${r.error ?? 'unreadable'} — ${r.claim}`);
}

/**
 * Move the baseline DOWN to meet a repaired population, and say what moved.
 *
 * A view that shrank has been repaired by somebody, and the repaired number is
 * the population from here on. Without this, one repair would buy permanent
 * headroom: a view could be fixed from 212 to 4 and then climb back to 212
 * without a single assertion firing, which is the same hole as demanding zero
 * only slower.
 *
 * It never moves the baseline UP. That direction is the failure.
 */
export function ratchet(
  baseline: InvariantBaseline,
  readings: readonly InvariantRowCount[],
): readonly string[] {
  const repaired: string[] = [];
  for (const reading of readings) {
    if (reading.error !== null) continue;
    const known = baseline.get(reading.view);
    if (known !== undefined && reading.rows < known) {
      repaired.push(`${reading.view}: ${String(known)} -> ${String(reading.rows)}`);
      baseline.set(reading.view, reading.rows);
    }
  }
  return repaired;
}

/**
 * The baseline as a human-readable block.
 *
 * Printed by the run rather than only asserted, for the reason `dbcheck.mjs`'s
 * `explain()` gives: a count is enough to fail on and never enough to act on,
 * so "which red is this" must be answerable from the run's own output without
 * anybody opening psql.
 */
export function describeBaseline(captured: CapturedBaseline, total: number): string {
  const lines = [
    `[chaos baseline] ${String(total)} invariant view(s) read at ${captured.capturedAt}`,
    `[chaos baseline] ${String(total - captured.standing.length - captured.unreadable.length)} empty, ` +
      `${String(captured.standing.length)} carrying a standing population ` +
      `(${String(captured.standingRows)} row(s)), ${String(captured.unreadable.length)} unreadable`,
  ];
  for (const s of captured.standing) {
    lines.push(`[chaos baseline]   ${s.view} = ${String(s.rows)} row(s) — ${s.claim}`);
  }
  for (const u of captured.unreadable) {
    lines.push(`[chaos baseline]   ${u.view} UNREADABLE: ${u.error ?? '?'}`);
  }
  lines.push(
    '[chaos baseline] the assertion from here is NO VIEW GROWS. These numbers are the book ' +
      'as chaos found it, not a claim that it is spotless.',
  );
  return lines.join('\n');
}
