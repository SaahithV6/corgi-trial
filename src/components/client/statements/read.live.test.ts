/**
 * `/client/statements`, driven.
 *
 * ── WHY THIS EXISTS AND WHY IT IS NOT A CURL ────────────────────────────────
 *
 * `curl` cannot drive a Next 16 server component's data path any more than it
 * can drive a server action; what comes back is the framework's rendering, and
 * a screen that rendered the word "verified" from a fixture would pass that
 * test. `src/components/home/actions.test.ts` sets the shape this follows:
 * import the module the page calls and call it.
 *
 * ── IT IS READ-ONLY, AND IT IS GATED ────────────────────────────────────────
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/components/client/statements
 *
 * Nothing here writes. `readClientStatements` is a read path over an
 * append-only ledger: `src/lib/statements/read.ts` opens with "NOTHING HERE
 * WRITES", publishing lives in a different module, and this test never reaches
 * it. It asserts against Ridgeline Robotics and Kettle & Crumb by reading them
 * only.
 *
 * Every module that opens a connection is imported DYNAMICALLY inside the gate,
 * because importing one evaluates `src/lib/env.ts`, which refuses to load
 * without a full set of keys — a suite that pulled them in at the top would
 * fail COLLECTION in a run that was only ever going to skip it.
 */
import { describe, expect, it } from "vitest";

import type { ClientStatementsScreen } from "./contract";

const RUN = process.env["RUN_DB_TESTS"] === "1";

/** `uuid5('business:ridgeline-robotics')`, the same id `docs/DEMO.md` deep-links. */
const RIDGELINE = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
/** A second customer, read only to prove one customer's list is not the other's. */
const KETTLE = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";
/** The corrected day: a wrong settlement, its reversal, and the re-book. */
const CORRECTED_DAY = "2026-09-08";

async function read(
  business: string | null,
  day: string | null,
): Promise<ClientStatementsScreen> {
  const { readClientStatements } = await import("@/app/(app)/client/statements/source");
  const loaded = await readClientStatements(business, day);
  if (!loaded.ok) throw new Error(`${loaded.code}: ${loaded.message}`);
  return loaded.value;
}

describe.skipIf(!RUN)("the customer's own statements", () => {
  it("lists Ridgeline's closed days and opens one", async () => {
    const screen = await read(RIDGELINE, null);

    expect(screen.live).toBe(true);
    expect(screen.legalName).toBe("Ridgeline Robotics, Inc.");
    expect(screen.periods.length).toBeGreaterThan(0);
    // Every period on the list is a day that was signed off: `closedAt` is a
    // real instant and the watermark it was frozen at is a real number. An open
    // day has no `book_day` row and therefore cannot appear here.
    for (const period of screen.periods) {
      expect(Number.isNaN(Date.parse(period.closedAt))).toBe(false);
      expect(period.closeWatermark).toBeGreaterThanOrEqual(0);
    }
    expect(screen.selected).not.toBeNull();
  }, 60_000);

  it("shows the 2026-09-08 correction on the statement itself", async () => {
    const screen = await read(RIDGELINE, CORRECTED_DAY);
    const doc = screen.selected;

    expect(doc).not.toBeNull();
    if (doc === null) return;
    expect(doc.businessDate).toBe(CORRECTED_DAY);

    // The correction is ON the document, not a footnote about it: the original,
    // the reversal that took it back and the entry that replaced it.
    expect(doc.corrections.length).toBeGreaterThan(0);
    const types = doc.corrections.flatMap((c) => c.lines.map((l) => l.entryType));
    expect(types).toContain("reversal");
    expect(types).toContain("rebook");

    // And all three are still on the statement below — nothing was removed to
    // make the closing balance work.
    const onStatement = new Set(doc.lines.map((l) => l.id));
    for (const correction of doc.corrections) {
      for (const line of correction.lines) {
        expect(onStatement.has(line.id)).toBe(true);
      }
    }
  }, 60_000);

  it("rebuilds that statement twice, identically, on one read", async () => {
    const screen = await read(RIDGELINE, CORRECTED_DAY);
    const doc = screen.selected;
    expect(doc).not.toBeNull();
    if (doc === null) return;

    const r = doc.reproduction;
    expect(r.renderedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.renderedAgainHash).toBe(r.renderedHash);
    expect(r.identical).toBe(true);
    // Two DIFFERENT instants, so "identical" is a claim about the ledger and
    // not about one value being read twice out of one variable.
    expect(Date.parse(r.secondAt)).toBeGreaterThanOrEqual(Date.parse(r.firstAt));

    // The claim the screen makes about the stored hash is the claim the data
    // supports, and no other: a day with no issued statement reports `null`,
    // never a green tick.
    if (doc.anchor === "closed") {
      expect(r.storedHash).toBeNull();
      expect(r.matchesStoredHash).toBeNull();
      expect(doc.version).toBeNull();
    } else {
      expect(r.storedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.matchesStoredHash).toBe(true);
    }
  }, 60_000);

  it("reproduces the same document on a second, independent read", async () => {
    const first = await read(RIDGELINE, CORRECTED_DAY);
    const second = await read(RIDGELINE, CORRECTED_DAY);

    expect(second.selected?.reproduction.renderedHash).toBe(
      first.selected?.reproduction.renderedHash,
    );
    expect(second.selected?.closingBalanceCents).toBe(
      first.selected?.closingBalanceCents,
    );
    expect(second.asOf).not.toBe(first.asOf);
  }, 60_000);

  it("never passes a day from the query string through to a document", async () => {
    // A date this account has no closed day for. The reader falls back to its
    // own default period rather than rendering an empty document under a date
    // nobody closed.
    const screen = await read(RIDGELINE, "1900-01-01");
    expect(screen.selected?.businessDate).not.toBe("1900-01-01");
    expect(
      screen.periods.some((p) => p.businessDate === screen.selected?.businessDate),
    ).toBe(true);
  }, 60_000);

  it("shows one customer their own days and not another's", async () => {
    const ridgeline = await read(RIDGELINE, null);
    const kettle = await read(KETTLE, null);

    expect(kettle.legalName).toBe("Kettle & Crumb Bakery LLC");
    expect(kettle.businessId).not.toBe(ridgeline.businessId);
    // The period lists are scoped to the account by predicate, so the days a
    // customer had no activity on are not on their list at all.
    const kettleDays = new Set(kettle.periods.map((p) => p.businessDate));
    const ridgelineOnly = ridgeline.periods.filter((p) => !kettleDays.has(p.businessDate));
    expect(ridgelineOnly.length).toBeGreaterThan(0);
  }, 60_000);
});
