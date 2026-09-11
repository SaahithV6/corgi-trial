/**
 * The classifier, and the one property that matters more than the feature.
 *
 * This build's recurring failure mode is a guard whose exclusion is shaped
 * exactly like the thing it should catch. The exclusion here is the sentence
 * "this break has a correction group behind it, so it is answered", and these
 * tests exist to hold it to the narrowest form that sentence can take:
 *
 *   - a reversal with no re-book is NOT answered;
 *   - a re-book that lands a penny out is NOT answered;
 *   - a break with no file side can never be answered by a correction;
 *   - and none of the three may ever reach the `explained` rung.
 *
 * No database. Every input here is a literal.
 */

import { describe, expect, it } from "vitest";

import {
  ageExplainedBreak,
  axisFor,
  buildTimeline,
  classifyCorrection,
  CORRECTION_CLASSES,
  CORRECTION_CLASS_EXCLUSION_RISK,
  bookDateOf,
  daysBetween,
  explainBreak,
  isFullyExplained,
  learnedAtOf,
  residualCentsOf,
  type CorrectionEntryFacts,
  type CorrectionInput,
} from "./explain";

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

function entry(
  over: Partial<CorrectionEntryFacts> & Pick<CorrectionEntryFacts, "entryType">,
): CorrectionEntryFacts {
  return {
    entryId: `entry-${over.entryType}`,
    valueDate: "2026-09-08",
    bookingSeq: 100n,
    bookingTime: "2026-09-08T18:00:00.000Z",
    bookingDate: "2026-09-08",
    railCents: 0n,
    description: over.entryType,
    reversesEntryId: null,
    ...over,
  };
}

/** The brief's own scenario: booked $309.59, provider settled $259.59. */
const ORIGINAL = entry({
  entryType: "original",
  entryId: "e-original",
  bookingSeq: 100n,
  bookingTime: "2026-09-08T18:00:00.000Z",
  bookingDate: "2026-09-08",
  railCents: 30_959n,
});

const REVERSAL = entry({
  entryType: "reversal",
  entryId: "e-reversal",
  bookingSeq: 200n,
  // Two days later, and STILL carrying the original's value date.
  bookingTime: "2026-09-10T14:00:00.000Z",
  bookingDate: "2026-09-10",
  railCents: -30_959n,
  reversesEntryId: "e-original",
});

const REBOOK = entry({
  entryType: "rebook",
  entryId: "e-rebook",
  bookingSeq: 201n,
  bookingTime: "2026-09-10T14:00:01.000Z",
  bookingDate: "2026-09-10",
  railCents: 25_959n,
});

function input(over: Partial<CorrectionInput> = {}): CorrectionInput {
  return {
    breakKind: "amount_mismatch",
    fileAmountCents: 25_959n,
    ledgerAnchorCents: 30_959n,
    ledgerNetCents: 25_959n,
    entries: [ORIGINAL, REVERSAL, REBOOK],
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Classification                                                          */
/* -------------------------------------------------------------------------- */

describe("classifyCorrection", () => {
  it("calls a break with no reversal behind it unexplained", () => {
    expect(classifyCorrection(input({ entries: [ORIGINAL] }))).toBe("not_a_correction");
  });

  it("does not infer a correction from a row count alone", () => {
    // Two entries, neither a reversal. A group of more than one is not
    // evidence of a correction; the presence of a `reversal` is.
    const twin = entry({ entryType: "original", entryId: "e-twin", bookingSeq: 101n });
    expect(classifyCorrection(input({ entries: [ORIGINAL, twin] }))).toBe(
      "not_a_correction",
    );
  });

  it("calls a reversal with no re-book a correction IN FLIGHT, not a closed one", () => {
    expect(
      classifyCorrection(input({ entries: [ORIGINAL, REVERSAL], ledgerNetCents: 0n })),
    ).toBe("correction_open");
  });

  it("calls a reversal plus re-book that nets to the file's amount closed", () => {
    expect(classifyCorrection(input())).toBe("correction_closed");
  });

  it("refuses to close on a re-book that lands ONE CENT out", () => {
    expect(classifyCorrection(input({ ledgerNetCents: 25_960n }))).toBe(
      "correction_residual",
    );
    expect(classifyCorrection(input({ ledgerNetCents: 25_958n }))).toBe(
      "correction_residual",
    );
  });

  it("can never close a break with no file side, however tidy the group", () => {
    // `in_ledger_not_file`: the provider omits the reference entirely. A
    // correction cannot explain an omission.
    expect(
      classifyCorrection(
        input({
          breakKind: "in_ledger_not_file",
          fileAmountCents: null,
          ledgerNetCents: 25_959n,
        }),
      ),
    ).toBe("correction_residual");
  });

  it("classifies every input into one of the four declared classes", () => {
    const nets = [null, 0n, 25_958n, 25_959n, 99_999n];
    const files = [null, 0n, 25_959n];
    const groups = [
      [],
      [ORIGINAL],
      [ORIGINAL, REVERSAL],
      [ORIGINAL, REVERSAL, REBOOK],
      [REVERSAL, REBOOK],
    ];
    for (const ledgerNetCents of nets) {
      for (const fileAmountCents of files) {
        for (const entries of groups) {
          const cls = classifyCorrection(
            input({ ledgerNetCents, fileAmountCents, entries }),
          );
          expect(CORRECTION_CLASSES).toContain(cls);
          expect(CORRECTION_CLASS_EXCLUSION_RISK[cls].length).toBeGreaterThan(0);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. What is still outstanding                                               */
/* -------------------------------------------------------------------------- */

describe("residualCentsOf", () => {
  it("is zero once the group nets to the file, even though the break amount is not", () => {
    const facts = input();
    // The engine's break amount is file - ANCHOR = -5000: the provider did
    // disagree with what we had booked, and the run that recorded it was right.
    expect(facts.fileAmountCents! - facts.ledgerAnchorCents!).toBe(-5_000n);
    // Nothing is outstanding, because the book has moved.
    expect(residualCentsOf(facts)).toBe(0n);
  });

  it("is the whole file amount when the reversal has not been re-booked", () => {
    expect(residualCentsOf(input({ entries: [ORIGINAL, REVERSAL], ledgerNetCents: 0n }))).toBe(
      25_959n,
    );
  });

  it("is the group's net when the file omits the reference", () => {
    expect(
      residualCentsOf(input({ fileAmountCents: null, ledgerNetCents: 24_071n })),
    ).toBe(24_071n);
  });

  it("is the file amount when there is no ledger side at all", () => {
    expect(
      residualCentsOf(
        input({
          breakKind: "in_file_not_ledger",
          ledgerAnchorCents: null,
          ledgerNetCents: null,
          entries: [],
        }),
      ),
    ).toBe(25_959n);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The timeline, and both axes                                             */
/* -------------------------------------------------------------------------- */

describe("buildTimeline", () => {
  it("orders by booking position, not by value date", () => {
    const steps = buildTimeline([REBOOK, ORIGINAL, REVERSAL]);
    expect(steps.map((s) => s.entryType)).toEqual(["original", "reversal", "rebook"]);
    // All three share one value date, so value date could not have ordered them.
    expect(new Set(steps.map((s) => s.valueDate)).size).toBe(1);
  });

  it("carries the reversal's value date as the ORIGINAL's, not the day we learned", () => {
    const steps = buildTimeline([ORIGINAL, REVERSAL, REBOOK]);
    const reversal = steps[1]!;
    expect(reversal.valueDate).toBe("2026-09-08");
    expect(reversal.bookingDate).toBe("2026-09-10");
    expect(reversal.backdatedDays).toBe(2);
    // The original was booked on its own day: the two axes agree there, and
    // the difference between the two rows is the whole bitemporal claim.
    expect(steps[0]!.backdatedDays).toBe(0);
  });

  it("runs the net forward so the last step is where the group stands", () => {
    const steps = buildTimeline([ORIGINAL, REVERSAL, REBOOK]);
    expect(steps.map((s) => s.runningNetCents)).toEqual([30_959n, 0n, 25_959n]);
  });

  it("leaves an incomplete group sitting at zero, which is the point of it", () => {
    const steps = buildTimeline([ORIGINAL, REVERSAL]);
    expect(steps[steps.length - 1]!.runningNetCents).toBe(0n);
  });
});

describe("learnedAtOf", () => {
  it("is the highest booking position in the group", () => {
    expect(learnedAtOf([ORIGINAL, REVERSAL, REBOOK])?.entryId).toBe("e-rebook");
    expect(learnedAtOf([])).toBeNull();
  });
});

describe("bookDateOf and daysBetween", () => {
  it("puts a late-evening UTC instant on the previous New York business day", () => {
    // 2026-09-11T02:14Z is 22:14 on 2026-09-10 in New York, which is the book's
    // timezone. Getting this wrong would only ever show up after 20:00 ET.
    expect(bookDateOf("2026-09-11T02:14:00.000Z")).toBe("2026-09-10");
  });

  it("counts whole days across a month end", () => {
    expect(daysBetween("2026-08-30", "2026-09-02")).toBe(3);
    expect(daysBetween("2026-09-08", "2026-09-08")).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. THE AXIS DECISION                                                       */
/* -------------------------------------------------------------------------- */

describe("axisFor", () => {
  it("ages an unexplained break on the value date", () => {
    expect(axisFor("not_a_correction")).toBe("value_date");
  });

  it("ages a correction on the booking axis", () => {
    expect(axisFor("correction_open")).toBe("booking_time");
    expect(axisFor("correction_closed")).toBe("booking_time");
  });

  it("ages a correction that left a shortfall on the VALUE date again", () => {
    // The trap. A correction group exists, so "it is fresh, we just learned"
    // is available and it is wrong: the remainder has been missing since the
    // business day and the correction did not touch it.
    expect(axisFor("correction_residual")).toBe("value_date");
  });
});

describe("ageExplainedBreak", () => {
  /** Three weeks ago, three closes signed off. */
  const OLD_VALUE_AXIS = { ageDays: 21, closesCrossed: 3 };
  /** Booked ten minutes ago; nobody has closed a day since. */
  const FRESH_BOOKING_AXIS = { ageDays: 0, closesCrossed: 0 };

  it("does not print a three-week-old settlement's age as the age of this morning's correction", () => {
    const aged = ageExplainedBreak({
      correctionClass: "correction_open",
      residualCents: 25_959n,
      explainedBy: null,
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: FRESH_BOOKING_AXIS,
    });
    expect(aged.axis).toBe("booking_time");
    expect(aged.ageDays).toBe(0);
    expect(aged.severity).toBe("open");
    // The other axis is still carried, so the screen can print both.
    expect(aged.valueAxis).toEqual(OLD_VALUE_AXIS);
  });

  it("lets a reversal that has been dangling across closes climb the ladder", () => {
    const aged = ageExplainedBreak({
      correctionClass: "correction_open",
      residualCents: 25_959n,
      explainedBy: null,
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: { ageDays: 14, closesCrossed: 12 },
    });
    expect(aged.axis).toBe("booking_time");
    // Past two closes, and $259.59 is below the $1,000.00 materiality line.
    expect(aged.severity).toBe("stale");

    // Material, and the same dangling reversal is critical.
    expect(
      ageExplainedBreak({
        correctionClass: "correction_open",
        residualCents: 250_000n,
        explainedBy: null,
        valueAxis: OLD_VALUE_AXIS,
        bookingAxis: { ageDays: 14, closesCrossed: 12 },
      }).severity,
    ).toBe("critical");
  });

  it("drops an inherited reversal_and_rebook flag it cannot see in the group", () => {
    // The view says the break was corrected; this module read the group and
    // found no reversal. Those disagree, and a disagreement about whether
    // money is explained resolves to the louder answer.
    const aged = ageExplainedBreak({
      correctionClass: "not_a_correction",
      residualCents: 5_000n,
      explainedBy: "reversal_and_rebook",
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: null,
    });
    expect(aged.severity).not.toBe("explained");
  });

  it("NEVER marks a correction in flight as explained", () => {
    for (const closes of [0, 1, 2, 9]) {
      for (const residual of [1n, 25_959n, 1_000_000n]) {
        const aged = ageExplainedBreak({
          correctionClass: "correction_open",
          residualCents: residual,
          explainedBy: null,
          valueAxis: OLD_VALUE_AXIS,
          bookingAxis: { ageDays: closes, closesCrossed: closes },
        });
        expect(aged.severity).not.toBe("explained");
      }
    }
  });

  it("NEVER marks a correction that left a shortfall as explained, even if the engine did", () => {
    // The engine's `explained_by` is passed in and deliberately ignored for
    // this class: a stale `reversal_and_rebook` flag must not be able to
    // launder a residual.
    const aged = ageExplainedBreak({
      correctionClass: "correction_residual",
      residualCents: 1n,
      explainedBy: "reversal_and_rebook",
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: FRESH_BOOKING_AXIS,
    });
    expect(aged.severity).not.toBe("explained");
    expect(aged.axis).toBe("value_date");
    expect(aged.ageDays).toBe(21);
  });

  it("marks a closed correction explained, and only that class", () => {
    const aged = ageExplainedBreak({
      correctionClass: "correction_closed",
      residualCents: 0n,
      explainedBy: null,
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: FRESH_BOOKING_AXIS,
    });
    expect(aged.severity).toBe("explained");
  });

  it("passes an adjudication through untouched on an unexplained break", () => {
    const aged = ageExplainedBreak({
      correctionClass: "not_a_correction",
      residualCents: 1_840n,
      explainedBy: "adjudicated",
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: null,
    });
    expect(aged.severity).toBe("explained");
    expect(aged.axis).toBe("value_date");
  });

  it("falls back to the louder axis rather than inventing one", () => {
    const aged = ageExplainedBreak({
      correctionClass: "correction_open",
      residualCents: 25_959n,
      explainedBy: null,
      valueAxis: OLD_VALUE_AXIS,
      bookingAxis: null,
    });
    expect(aged.axis).toBe("value_date");
    expect(aged.ageDays).toBe(21);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The whole explanation                                                   */
/* -------------------------------------------------------------------------- */

describe("explainBreak", () => {
  const AXES = {
    valueAxis: { ageDays: 2, closesCrossed: 1 },
    bookingAxis: { ageDays: 0, closesCrossed: 0 },
  };

  it("explains the brief's own scenario end to end", () => {
    const e = explainBreak(input(), AXES, "reversal_and_rebook");
    expect(e.correctionClass).toBe("correction_closed");
    expect(e.residualCents).toBe(0n);
    expect(e.steps).toHaveLength(3);
    expect(e.maxBackdatedDays).toBe(2);
    expect(e.learnedAt).toBe("2026-09-10T14:00:01.000Z");
    expect(e.aging.axis).toBe("booking_time");
    expect(isFullyExplained(e)).toBe(true);
  });

  it("holds a penny back from being explained", () => {
    const e = explainBreak(input({ ledgerNetCents: 25_960n }), AXES, "reversal_and_rebook");
    expect(e.correctionClass).toBe("correction_residual");
    expect(e.residualCents).toBe(-1n);
    expect(isFullyExplained(e)).toBe(false);
    expect(e.aging.severity).not.toBe("explained");
  });

  it("never treats an unexplained break as having a booking axis", () => {
    const e = explainBreak(input({ entries: [ORIGINAL] }), AXES, null);
    expect(e.correctionClass).toBe("not_a_correction");
    expect(e.aging.bookingAxis).toBeNull();
    expect(e.aging.axis).toBe("value_date");
    expect(e.aging.ageDays).toBe(2);
  });

  it("carries an exclusion risk sentence on every class", () => {
    for (const cls of CORRECTION_CLASSES) {
      expect(CORRECTION_CLASS_EXCLUSION_RISK[cls]).toMatch(/\S/);
    }
    const e = explainBreak(input(), AXES, null);
    expect(e.exclusionRisk).toBe(CORRECTION_CLASS_EXCLUSION_RISK.correction_closed);
  });

  it("is total: it returns an explanation for a break with no ledger side", () => {
    const e = explainBreak(
      input({
        breakKind: "in_file_not_ledger",
        ledgerAnchorCents: null,
        ledgerNetCents: null,
        entries: [],
      }),
      AXES,
      null,
    );
    expect(e.correctionClass).toBe("not_a_correction");
    expect(e.steps).toEqual([]);
    expect(e.residualCents).toBe(25_959n);
    expect(isFullyExplained(e)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. THE SAFETY PROPERTY                                                     */
/* -------------------------------------------------------------------------- */

describe("explainable never means suppressed", () => {
  /**
   * Over every shape this classifier can see, a break with money outstanding
   * is never ranked as answered. This is the property the whole feature is
   * allowed to be judged on: if it ever fails, the screen has learned to hide
   * a live break behind a story about a correction.
   */
  it("ranks no break with a non-zero residual as explained", () => {
    const groups: readonly (readonly CorrectionEntryFacts[])[] = [
      [],
      [ORIGINAL],
      [ORIGINAL, REVERSAL],
      [ORIGINAL, REVERSAL, REBOOK],
    ];
    const nets: readonly (bigint | null)[] = [null, 0n, 1n, 25_958n, 25_959n, 30_959n];
    const files: readonly (bigint | null)[] = [null, 0n, 25_959n, 30_959n];

    let sawResidual = false;
    let sawExplained = false;

    for (const entries of groups) {
      for (const ledgerNetCents of nets) {
        for (const fileAmountCents of files) {
          for (const engineVerdict of [null, "reversal_and_rebook", "adjudicated"] as const) {
            const e = explainBreak(
              input({ entries, ledgerNetCents, fileAmountCents }),
              {
                valueAxis: { ageDays: 40, closesCrossed: 5 },
                bookingAxis: { ageDays: 0, closesCrossed: 0 },
              },
              engineVerdict,
            );

            const outstanding = e.residualCents !== 0n;
            if (outstanding) sawResidual = true;
            if (e.aging.severity === "explained") sawExplained = true;

            if (outstanding && e.aging.severity === "explained") {
              // The only way a row with money outstanding may read as
              // explained is a human adjudication note on a break the system
              // could not explain itself — which is a person's signature, not
              // an inference.
              expect(e.correctionClass).toBe("not_a_correction");
              expect(engineVerdict).toBe("adjudicated");
            }
            // One direction only, and it is the direction that matters:
            // nothing may be called fully explained while money is
            // outstanding. The converse is deliberately NOT asserted — a
            // reversal with no re-book against a file that also carries
            // nothing nets to zero and is still an open correction, because
            // the group has not finished.
            if (isFullyExplained(e)) {
              expect(e.residualCents).toBe(0n);
              expect(e.correctionClass).toBe("correction_closed");
            }
          }
        }
      }
    }

    // The loop has to have exercised both sides or it proves nothing.
    expect(sawResidual).toBe(true);
    expect(sawExplained).toBe(true);
  });
});
