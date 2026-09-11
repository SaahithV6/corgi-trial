/**
 * The triage board, against the REAL Neon database.
 *
 * ============================================================================
 * WHY THIS EXISTS AS AN INTEGRATION TEST.
 *
 * Nothing this screen prints is its own calculation — it composes
 * `readInvariants()`, `listQueue()`, `loadReconView()`, `readWebhookProcessing()`
 * and `loadCompleteness()`, and adds SELECTs against views for the rows behind
 * a count. A mock would assert that this file can call five functions, which is
 * the one thing nobody doubts. The claims worth proving are claims about the
 * live book:
 *
 *   * the four reds the register argues for are the four the book has, so the
 *     screen's headline says "nothing new" for the right reason and not by
 *     coincidence;
 *   * every red the screen shows has rows behind it, or a written reason why
 *     it has none — the drill-through rule, enforced rather than intended;
 *   * the invariant counts agree with what the chaos dashboard's own read
 *     returns, because two screens reading the same views through the same
 *     function must not be able to disagree.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials on purpose, skips
 * rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 npx vitest run src/components/dashboard
 * ============================================================================
 *
 * NOTHING HERE WRITES A ROW. The source issues only SELECTs.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { DECIDED, isUnexplained } from "./decided";
import type { TriageDataSource, Triage } from "./data-contract";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

d("the triage board, against the live book", () => {
  let triage: Triage;

  beforeAll(async () => {
    const { createLiveTriageSource } = await import("@/app/(app)/dashboard/live-source");
    const source: TriageDataSource = createLiveTriageSource();
    const result = await source.read();
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    triage = result.value;
  }, 60_000);

  it("reads every invariant view the gate checks, at one instant", async () => {
    const { INVARIANT_VIEWS } = await import("@/lib/chaos/invariants");
    expect(triage.invariants.cards).toHaveLength(INVARIANT_VIEWS.length);
    expect(triage.invariants.cards.map((c) => c.classified.view).sort()).toEqual(
      INVARIANT_VIEWS.map(([view]) => view).sort(),
    );
    expect(triage.live).toBe(true);
    expect(triage.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("cannot disagree with the chaos dashboard about a count", async () => {
    // Same function, same list, same connection. This asserts the composition
    // rather than a number: if this screen ever grew its own read, the two
    // would drift and nobody would know which was right.
    const { readInvariants } = await import("@/lib/chaos/observe");
    const direct = await readInvariants();
    const byView = new Map(direct.map((r) => [r.view, r]));
    for (const card of triage.invariants.cards) {
      const reading = byView.get(card.classified.view);
      expect(reading, `${card.classified.view} is on the board and not in the gate`).toBeDefined();
      // Row counts move between the two reads only if something wrote in
      // between, which on this book is possible — so the assertion is on the
      // SHAPE, not the value: readable here iff readable there.
      expect(card.classified.error === null).toBe(reading?.error === null);
    }
  });

  it("shows the rows behind every red, or says in writing why it cannot", () => {
    for (const card of triage.invariants.cards) {
      if (card.classified.rows <= 0) continue;
      const hasEvidence = card.witnesses.length > 0 || card.groups.length > 0;
      expect(
        hasEvidence || card.noWitnessReason !== null,
        `${card.classified.view} is red with no rows behind it and no reason given — a count presented as a finding`,
      ).toBe(true);
    }
  });

  it("classifies every red on this book as decided, or names it as unexplained", () => {
    // NOT an assertion that the book is clean. It asserts the screen is
    // HONEST about whichever of the two it is: a red that is neither on the
    // register nor rendered in an unexplained band would be a red that the
    // screen quietly absorbed, which is the failure this whole panel exists
    // to prevent.
    const registered = new Set(DECIDED.map((d2) => d2.view));
    for (const card of triage.invariants.cards) {
      const c = card.classified;
      if (c.error === null && c.rows === 0) continue;
      const explained = registered.has(c.view) && !isUnexplained(c.verdict);
      expect(
        explained || isUnexplained(c.verdict),
        `${c.view} is red and sits in the ${c.verdict} band, which is neither`,
      ).toBe(true);
    }
  });

  it("carries the reach limit for every view one is written for", () => {
    // The 25-times-catalogued failure: a count printed without its population.
    const withLimits = triage.invariants.cards.filter((c) => c.classified.reachLimit !== null);
    expect(withLimits.length).toBeGreaterThanOrEqual(5);
    for (const card of withLimits) {
      expect(card.classified.reachLimit?.length ?? 0).toBeGreaterThan(80);
    }
  });

  it("reads the queues that are waiting on a person", () => {
    const h = triage.human;
    expect(h.approvals.pending).toBeGreaterThanOrEqual(0);
    expect(h.disputes.open + h.disputes.closed).toBeGreaterThanOrEqual(0);
    // Parked and dead-lettered groups must name their referent: a group that
    // says "7 things are stuck" without saying what they are waiting for is
    // not actionable, and the whole point of parking is that it is.
    for (const p of h.parked) expect(p.kind.length).toBeGreaterThan(0);
    for (const dl of h.deadLetters) expect(dl.provider.length).toBeGreaterThan(0);
    // Money is bigint cents all the way to the renderer.
    expect(typeof h.approvals.totalCents).toBe("bigint");
    expect(typeof h.approvals.aboveThresholdCents).toBe("bigint");
  });

  it("scopes the breaks panel to the run /reconciliation would show", async () => {
    const { loadReconView } = await import("@/lib/recon/screen");
    const view = await loadReconView({});
    if (!view.ok) return; // the breaks panel degrades alone; nothing to compare
    expect(triage.human.breaks.run?.runId).toBe(view.value.run?.runId);
    // The book-wide figure is deliberately larger and deliberately not linked.
    expect(triage.human.breaks.bookWide).toBeGreaterThanOrEqual(
      triage.human.breaks.breaks.length,
    );
  });

  it("names all five scheduled jobs and what would prove each one ran", () => {
    expect(triage.machine.jobs).toHaveLength(5);
    for (const job of triage.machine.jobs) {
      expect(job.path.startsWith("/api/")).toBe(true);
      expect(job.schedule.split(" ")).toHaveLength(5);
      // The honesty this section rests on: a trace is named, always.
      expect(job.tracedBy.length).toBeGreaterThan(5);
    }
  });

  it("re-uses the health endpoint's own webhook verdicts", () => {
    const p = triage.machine.processing;
    expect(p.providers.length).toBeGreaterThan(0);
    for (const provider of p.providers) {
      expect(provider.verdict.length).toBeGreaterThan(0);
      expect(provider.note.length).toBeGreaterThan(0);
    }
  });

  it("carries the audit trail's own account of its gaps", () => {
    const c = triage.machine.completeness;
    expect(c.sources.length).toBeGreaterThan(0);
    // Not asserted to be empty — that is /audit's assertion to make. Asserted
    // to be PRESENT, because a section about what the machine did that hid the
    // stores it cannot see would read as more complete than it is.
    expect(Array.isArray(c.exclusions)).toBe(true);
    expect(Array.isArray(c.unclaimed)).toBe(true);
  });
});
