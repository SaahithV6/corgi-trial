/**
 * Seeds the reconciliation demo into the live book, and asserts that what the
 * breaks screen renders is what the scenario planted.
 *
 * This doubles as the seeder: `src/lib/recon/screen.ts` reads the live
 * database in its default state, so the screen having something to show is a
 * consequence of this file running, not of a fixture.
 *
 * Gated on `APP_DATABASE_URL` for the same reason as planted-break.test.ts:
 * CI is deliberately secret-free and skips; a local `set -a; . ./.env; set +a;
 * pnpm test` runs it with no extra flag to remember.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type * as DemoModule from "./demo";
import type * as IngestModule from "./ingest";
import type * as DiffModule from "./diff";
import type * as RunModule from "./run";
import type { ReconBreak } from "./types";

const RUN = typeof process.env.APP_DATABASE_URL === "string";
const d = RUN ? describe : describe.skip;

d("the reconciliation demo, against the live database", () => {
  let seedReconDemo: typeof DemoModule.seedReconDemo;
  let readBreaks: typeof DiffModule.readBreaks;
  let listRuns: typeof RunModule.listRuns;
  let listRejects: typeof IngestModule.listRejects;

  let seeded: DemoModule.ReconDemoResult;
  let agedFile: DemoModule.ReconDemoFile;
  let breaks: readonly ReconBreak[];

  const find = (ref: string): ReconBreak | undefined =>
    breaks.find((b) => b.externalRef === ref);

  beforeAll(async () => {
    ({ seedReconDemo } = await import("./demo"));
    ({ readBreaks } = await import("./diff"));
    ({ listRuns } = await import("./run"));
    ({ listRejects } = await import("./ingest"));

    seeded = await seedReconDemo();
    const tonight = seeded.files[0];
    if (!tonight) throw new Error("the demo should have seeded three files");
    agedFile = tonight;
    breaks = await readBreaks({ fileId: agedFile.fileId });
  }, 120_000);

  it("plants one break of each category, and only those", () => {
    const kinds = breaks.map((b) => b.kind).sort();
    expect(kinds).toEqual([
      "amount_mismatch",
      "amount_mismatch",
      "in_file_not_ledger",
      "in_ledger_not_file",
    ]);
  });

  it("the settled transfer nobody booked is in_file_not_ledger", () => {
    const found = find(seeded.plantedRefs.inFileNotLedger);
    expect(found?.kind).toBe("in_file_not_ledger");
    expect(found?.fileAmountCents).not.toBeNull();
    expect(found?.ledgerAmountCents).toBeNull();
    expect(found?.fileRowId).not.toBeNull();
  });

  it("the entry the file omits is in_ledger_not_file", () => {
    const found = find(seeded.plantedRefs.inLedgerNotFile);
    expect(found?.kind).toBe("in_ledger_not_file");
    expect(found?.ledgerAmountCents).toBe(21_450n);
    expect(found?.breakAmountCents).toBe(21_450n);
    expect(found?.fileAmountCents).toBeNull();
    expect(found?.entryId).not.toBeNull();
  });

  it("the capture booked at the authorised amount is a mismatch carrying both numbers", () => {
    const found = find(seeded.plantedRefs.amountMismatch);
    expect(found?.kind).toBe("amount_mismatch");
    expect(found?.explainedBy).toBeNull();
    // We booked $18.40 less than the file settled for.
    expect(found?.breakAmountCents).toBe(1_840n);
    expect(found?.fileAmountCents).toBe(
      (found?.ledgerAmountCents ?? 0n) + 1_840n,
    );
  });

  it("the corrected entry is a mismatch that is EXPLAINED, not one that vanished", () => {
    const found = find(seeded.plantedRefs.explainedMismatch);
    expect(found?.kind).toBe("amount_mismatch");
    expect(found?.explainedBy).toBe("reversal_and_rebook");
    expect(found?.severity).toBe("explained");
    // What we booked, and where the correction group stands now.
    expect(found?.ledgerNetCents).toBe(found?.fileAmountCents ?? null);
    expect(found?.ledgerAmountCents).not.toBe(found?.ledgerNetCents ?? null);
  });

  it("aging is driven by day closes, not by a clock", async () => {
    // The three files sit today, one day back and forty-five days back on a
    // book whose last forty-six days are closed, so the ladder is visible.
    const yesterday = await readBreaks({ fileId: seeded.files[1]?.fileId ?? "" });
    const old = await readBreaks({ fileId: seeded.files[2]?.fileId ?? "" });

    for (const b of breaks) {
      // Today's business day has not been closed, so nothing on tonight's
      // file has been past a control yet.
      expect(b.closesCrossed).toBe(0);
      expect(["open", "explained"]).toContain(b.severity);
    }
    for (const b of yesterday) {
      expect(b.closesCrossed).toBe(1);
      expect(["aged", "explained"]).toContain(b.severity);
    }
    for (const b of old) {
      expect(b.closesCrossed).toBeGreaterThanOrEqual(2);
      // Past the 30-day threshold, so the ladder has actually topped out.
      expect(["critical", "explained"]).toContain(b.severity);
    }
  });

  it("malformed rows are recorded, not fatal", async () => {
    expect(agedFile.rejectedCount).toBe(5);
    const rejects = await listRejects(agedFile.fileId);
    expect(rejects.map((r) => r.reason).sort()).toEqual([
      "bad_amount",
      "bad_amount",
      "bad_value_date",
      "direction_sign_mismatch",
      "field_count",
    ]);
    // ...and the file still imported every row it could read.
    expect(agedFile.rowCount).toBeGreaterThan(0);
  });

  it("re-running appends a run; the history is queryable and never revised", async () => {
    const runs = await listRuns({ fileId: agedFile.fileId });
    expect(runs.length).toBeGreaterThanOrEqual(2);

    // Newest first, and run numbers only ever go up. `listRuns` pages, so the
    // assertion is about the SHAPE of the history rather than about run #1
    // still being on the first page after the seed has been run many times.
    const numbers = runs.map((r) => r.runNo);
    expect([...numbers].sort((a, b) => b - a)).toEqual(numbers);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(runs.length);

    const [newest, previous] = runs;
    if (!newest || !previous) throw new Error("expected at least two runs");
    // Consecutive: the seed runs this file twice in a row, so nothing came
    // between them.
    expect(newest.runNo).toBe(previous.runNo + 1);
    // Same file, same book, so the two runs saw exactly the same breaks — and
    // the content hash proves it rather than asserting it.
    expect(newest.contentHash).toBe(previous.contentHash);
    expect(newest.bookingWatermark).toBe(previous.bookingWatermark);
  });

  it("re-seeding is a no-op: the same bytes are the same file", async () => {
    const again = await seedReconDemo();
    expect(again.files.map((f) => f.fileId)).toEqual(
      seeded.files.map((f) => f.fileId),
    );
    for (const file of again.files) expect(file.imported).toBe(false);
  }, 120_000);
});
