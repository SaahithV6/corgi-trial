/**
 * The explaining breaks screen, against the real book.
 *
 * `explain.test.ts` proves the policy over literals. This proves it over rows
 * somebody actually posted — which is the only way to know that the SQL, the
 * rail-leg summation and the two time axes line up with what
 * `v_recon_break` and `v_recon_pair` actually return.
 *
 * IT IS READ-ONLY. Not one statement here writes, and that is deliberate
 * beyond good manners: fourteen branches are working against this database,
 * the money tables are append-only, and a test that planted its own rows would
 * change what every other screen shows in order to prove something about this
 * one. The rows it reads were planted by `scripts/livefire.mjs` — attack 6
 * plants the three break categories, attack 3 drives a provider-originated
 * bitemporal correction — and by `seedReconDemo`.
 *
 * It runs whenever `APP_DATABASE_URL` is set and skips otherwise, the same
 * rule as `planted-break.test.ts`. Every assertion is a PROPERTY over whatever
 * the book happens to hold, never a literal id or amount: those move every
 * time a live-fire run posts, and a test pinned to them would be red by
 * morning and would be telling the truth about nothing.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type * as DiffModule from "./diff";
import type * as ExplainReadModule from "./explain-read";
import type * as ExplainedViewModule from "./explained-view";
import type * as RunModule from "./run";

import { isOk } from "@/lib/result";

const RUN = typeof process.env.APP_DATABASE_URL === "string";
const d = RUN ? describe : describe.skip;

d("the explaining breaks screen, against the live database", () => {
  let loadExplainedView: typeof ExplainedViewModule.loadExplainedView;
  let readBreaks: typeof DiffModule.readBreaks;
  let readSilentCorrections: typeof ExplainReadModule.readSilentCorrections;
  let readBookingAxis: typeof ExplainReadModule.readBookingAxis;
  let listRuns: typeof RunModule.listRuns;

  beforeAll(async () => {
    ({ loadExplainedView } = await import("./explained-view"));
    ({ readBreaks } = await import("./diff"));
    ({ readSilentCorrections, readBookingAxis } = await import("./explain-read"));
    ({ listRuns } = await import("./run"));
  });

  it("loads", async () => {
    const result = await loadExplainedView();
    expect(isOk(result)).toBe(true);
  });

  /**
   * THE SAFETY PROPERTY, ON REAL ROWS.
   *
   * The classification is allowed to change how a break is DISPLAYED and
   * never whether it is COUNTED. So the screen's row count must equal the
   * engine's, exactly, for the same file — no filter, no exclusion, no
   * "explained rows are hidden by default".
   */
  it("shows every break the engine reports, and not one fewer", async () => {
    const result = await loadExplainedView();
    if (!isOk(result)) throw new Error(result.error.code);
    const view = result.value;
    if (view.run === null) return; // nothing reconciled yet; nothing to compare

    const engine = await readBreaks({ fileId: view.run.fileId });
    expect(view.rows).toHaveLength(engine.length);

    const engineIds = new Set(engine.map((b) => `${b.kind}:${b.breakKey}`));
    for (const row of view.rows) expect(engineIds.has(row.id)).toBe(true);
  });

  it("never ranks a row with money outstanding as explained", async () => {
    const result = await loadExplainedView();
    if (!isOk(result)) throw new Error(result.error.code);

    for (const row of result.value.rows) {
      if (row.residualCents === 0) continue;
      if (row.explainedBy === "adjudicated") continue; // a person's signature
      expect(row.severity).not.toBe("explained");
      expect(row.fullyExplained).toBe(false);
    }
  });

  it("marks fully explained rows only when the group nets to the file exactly", async () => {
    const result = await loadExplainedView();
    if (!isOk(result)) throw new Error(result.error.code);

    for (const row of result.value.rows) {
      if (!row.fullyExplained) continue;
      expect(row.correctionClass).toBe("correction_closed");
      expect(row.residualCents).toBe(0);
      expect(row.ledgerNetCents).toBe(row.fileAmountCents);
      // ...and it is not a vacuous claim: something was actually corrected.
      expect(row.steps.some((s) => s.entryType === "reversal")).toBe(true);
      expect(row.steps.some((s) => s.entryType === "rebook")).toBe(true);
    }
  });

  /**
   * The bitemporal claim, read off real entries rather than asserted in prose.
   *
   * A reversal carries the ORIGINAL's value date and its own booking time. If
   * this ever stops being true, `reverseAndRebook` has started growing a
   * second line on the statement instead of correcting the first, and the
   * whole track's differentiator is gone.
   */
  it("finds real correction groups whose reversal keeps the original's value date", async () => {
    // The file is found by QUERY rather than by scanning the recent runs. The
    // live-fire suite appends runs continually against synthetic business
    // dates that sort above everything real, so "look at the last N runs" is a
    // test whose truth depends on which attack happened to run last — it went
    // from passing to vacuous when N was tuned from 50 to 8. `v_recon_pair` is
    // recon's own view and it already knows which files carry a correction.
    const { sql } = await import("@/lib/ledger/db");
    const candidates = await sql<{ file_id: string }[]>`
      SELECT DISTINCT p.file_id
        FROM v_recon_pair p
       WHERE p.has_reversal
       LIMIT 5`;

    // If the book holds no correction group on any imported file, the live-fire
    // suite has never run against it and every assertion below would be
    // vacuous. Say so rather than passing quietly.
    expect(candidates.length).toBeGreaterThan(0);

    let seen = 0;
    for (const c of candidates) {
      const runs = await listRuns({ fileId: c.file_id, limit: 1 });
      const run = runs[0];
      if (run === undefined) continue;

      const result = await loadExplainedView({ runId: run.runId });
      if (!isOk(result)) continue;

      for (const row of result.value.rows) {
        const original = row.steps.find((s) => s.entryType === "original");
        const reversal = row.steps.find((s) => s.entryType === "reversal");
        if (original === undefined || reversal === undefined) continue;

        seen += 1;
        expect(reversal.valueDate).toBe(original.valueDate);
        expect(reversal.bookingSeq).toBeGreaterThan(original.bookingSeq);
        expect(Date.parse(reversal.bookingTime)).toBeGreaterThanOrEqual(
          Date.parse(original.bookingTime),
        );
        // The running net after the reversal is the original un-booked.
        expect(reversal.runningNetCents).toBe(
          original.runningNetCents + reversal.railCents,
        );
      }
    }

    expect(seen).toBeGreaterThan(0);
  });

  it("ages corrections on the booking axis and everything else on the value date", async () => {
    const runs = await listRuns({ limit: 8 });
    for (const run of runs) {
      const result = await loadExplainedView({ runId: run.runId });
      if (!isOk(result)) continue;

      for (const row of result.value.rows) {
        if (row.correctionClass === "correction_open" || row.correctionClass === "correction_closed") {
          expect(row.agingAxis).toBe("booking_time");
          expect(row.bookingAxis).not.toBeNull();
          expect(row.ageDays).toBe(row.bookingAxis?.ageDays);
        } else {
          expect(row.agingAxis).toBe("value_date");
          expect(row.ageDays).toBe(row.valueAxis.ageDays);
        }
      }
    }
  });

  it("measures the booking axis in Postgres, on the book's own calendar", async () => {
    const now = new Date().toISOString();
    const [fresh] = await readBookingAxis([now]);
    expect(fresh).toBeDefined();
    expect(fresh?.ageDays).toBe(0);
    // Nothing can have been closed after this instant.
    expect(fresh?.closesCrossed).toBe(0);

    const [old] = await readBookingAxis(["2020-01-01T12:00:00.000Z"]);
    expect(old?.ageDays).toBeGreaterThan(1_000);
  });

  /**
   * The advisory list is ADDITIVE. It may only ever contain rows the diff
   * matched clean, which is exactly why they are worth showing: no break list
   * anywhere reports them.
   */
  it("only ever advises about rows the diff called a match", async () => {
    const result = await loadExplainedView();
    if (!isOk(result)) throw new Error(result.error.code);
    const view = result.value;
    if (view.run === null) return;

    const raw = await readSilentCorrections(view.run.fileId);
    expect(view.silent).toHaveLength(raw.length);

    const breakFileRows = new Set(view.rows.map((r) => r.fileRowId).filter((x) => x !== null));
    for (const s of view.silent) {
      expect(s.driftCents).not.toBe(0);
      expect(s.fileAmountCents - s.ledgerNetCents).toBe(s.driftCents);
      // A row cannot be both a break and a silently-corrected match.
      expect(breakFileRows.has(s.fileRowId)).toBe(false);
    }
  });
});
