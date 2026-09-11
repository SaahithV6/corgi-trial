/**
 * The four non-default URL states, as fixtures.
 *
 * ============================================================================
 * NOTHING ON A FIXTURE IS A STATEMENT ABOUT A REAL BOOK, and every one of them
 * carries `live: false` so the screen says so on its own face.
 * ============================================================================
 *
 * That badge matters more on this screen than on any other in the build. The
 * claim section 1 makes is "nothing new is wrong with the ledger", and a
 * screenshot of a fixture making that claim would be the single most
 * misleading artefact this repository could produce. So `live` is not a styling
 * hint: it is the difference between evidence and a drawing.
 *
 * `edge` is the one that needs its argument written down. See the header of
 * `./view-state.ts`: against this book there is currently no view that is red
 * WITHOUT an argument on the register — `dbcheck` reads 42 passed / 4 failed
 * and all four are decided. The juxtaposition the edge state exists to show
 * therefore cannot be read; the two ways to manufacture it live would be to
 * drop a view off the register so a decided red renders as new, or to draw a
 * row no view returned. Both are the screen inventing a finding. So it is a
 * fixture, and it says that in prose above the panel.
 */

import type { BreakRow, RunRow } from "@/components/recon/data-contract";
import type { Completeness } from "@/lib/audit/types";
import { fail, ok } from "@/lib/result";

import type {
  InvariantCard,
  MachineSection,
  Triage,
  TriageDataSource,
} from "./data-contract";
import { classify, headline, tally, type Reading } from "./decided";

/** One fixed instant, so a fixture is byte-identical on every render. */
const AT = "2026-09-11T06:00:00.000Z";
const WATERMARK = "3413";

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

function card(reading: Reading, extra: Partial<InvariantCard> = {}): InvariantCard {
  return {
    classified: classify(reading),
    witnesses: [],
    groups: [],
    noWitnessReason: null,
    ...extra,
  };
}

const EMPTY_COMPLETENESS: Completeness = {
  sources: [],
  exclusions: [],
  unclaimed: [],
  mutable: [],
  weak: [],
};

const QUIET_MACHINE: MachineSection = {
  jobs: [],
  actions: [],
  refusals: [],
  sweeps: [],
  outbound: [],
  processing: {
    measured: false,
    error: "fixture — no query was issued",
    measuredAt: AT,
    providers: [],
    degradedBy: [],
  },
  completeness: EMPTY_COMPLETENESS,
};

function base(overrides: Partial<Triage>): Triage {
  const cards = overrides.invariants?.cards ?? [];
  const counted = tally(cards.map((c) => c.classified));
  return {
    readAt: AT,
    bookingWatermark: WATERMARK,
    live: false,
    invariants: {
      cards,
      tally: counted,
      headline: headline(counted),
      readAt: AT,
    },
    human: {
      approvals: {
        pending: 0,
        aboveThreshold: 0,
        capped: false,
        oldestAt: null,
        totalCents: 0n,
        aboveThresholdCents: 0n,
      },
      disputes: { needingDecision: 0, open: 0, closed: 0 },
      parked: [],
      parkedTotal: 0,
      deadLetters: [],
      deadLetterTotal: 0,
      unattributed: [],
      breaks: { run: null, breaks: [], bySeverity: [], byAge: [], bookWide: 0 },
    },
    machine: QUIET_MACHINE,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* empty — a quiet shift                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every view holding, nothing queued, nothing refused.
 *
 * Deliberately NOT "the four reds are gone". A fixture that showed this book
 * with a clean invariant list would be teaching a reader that the four are an
 * outage that gets fixed, when they are an accepted finding that stands. The
 * empty state here is what a DIFFERENT, quieter book looks like, and the
 * register is unchanged underneath it — which is why `v_refused_auth_hold`
 * below reads zero and classifies as `shrunk`: on a book where the population
 * really had been repaired, the screen's job is to say the watermark is stale,
 * not to congratulate itself.
 */
function emptyCards(): readonly InvariantCard[] {
  return [
    card({ view: "v_refused_auth_hold", claim: "no hold withholds money against an authorisation not recorded as APPROVED", rows: 0, error: null }),
    card({ view: "v_entry_unbalanced", claim: "every entry sums to zero, per currency", rows: 0, error: null }),
    card({ view: "v_book_not_zero", claim: "the whole book nets to zero, per entity and book", rows: 0, error: null }),
    card({ view: "v_hold_drift", claim: "the memo book equals the fold over card events", rows: 0, error: null }),
  ];
}

/* -------------------------------------------------------------------------- */
/* edge — a decided red beside a new one                                      */
/* -------------------------------------------------------------------------- */

const EDGE_RUN: RunRow = {
  runId: "00000000-0000-4000-8000-00000000f1xe",
  runNo: 1,
  fileId: "00000000-0000-4000-8000-00000000f11e",
  filename: "achsim-settlement-2026-09-11.csv",
  fileSha256: "fixture-not-a-real-digest",
  provider: "achsim",
  rail: "ach",
  businessDate: "2026-09-11",
  bookingWatermark: 3413,
  matchedCount: 18,
  fileRowCount: 19,
  breakCount: 1,
  breakTotalCents: 7340,
  inFileNotLedger: 1,
  inLedgerNotFile: 0,
  amountMismatch: 0,
  rejectedRows: 0,
  contentHash: "fixture",
  startedAt: AT,
  runBy: "fixture",
};

const EDGE_BREAK: BreakRow = {
  id: "in_file_not_ledger:fixture-row-9",
  kind: "in_file_not_ledger",
  reasonCode: "unmatched_reference",
  severity: "aged",
  ageBucket: "2-3",
  externalRef: "achsim:fixture-row-9",
  valueDate: "2026-09-09",
  businessDate: "2026-09-11",
  provider: "achsim",
  rail: "ach",
  fileAmountCents: 7340,
  ledgerAmountCents: null,
  ledgerNetCents: null,
  breakAmountCents: 7340,
  ageDays: 2,
  closesCrossed: 1,
  explainedBy: null,
  severityReason: "Open across one day close — a signed-off day contains this break.",
  description: "fixture",
  fileRowId: null,
  fileRowNo: 9,
  entryId: null,
  correctionGroupId: null,
};

/**
 * The whole point of the screen, in one panel.
 *
 * `v_refused_auth_hold` at 257 is on the register: decided, argued, cited,
 * unrepairable. `v_entry_unbalanced` at 1 is on nothing: an entry that does not
 * sum to zero is the one failure this system has no story for, and it renders
 * in the `new` band above everything else because NOBODY HAS WRITTEN AN
 * ARGUMENT FOR IT. The two reds are the same colour and they are not the same
 * fact, and telling them apart at a glance is the job.
 *
 * `v_hold_expiry_drift` at 13 against a watermark of 12 is the third case and
 * the subtle one: a decided view that GREW. Twelve of those rows are argued
 * for; the thirteenth is not, and it is ranked with the new findings rather
 * than absorbed into a population that was accepted a day ago.
 */
function edgeCards(): readonly InvariantCard[] {
  return [
    card(
      { view: "v_entry_unbalanced", claim: "every entry sums to zero, per currency", rows: 1, error: null },
      {
        noWitnessReason:
          "No drill-through is wired for this view. It was not red when this screen was written, so nothing here knows which of its columns identifies a row — and guessing would be the screen inventing a taxonomy for rows it did not produce. Read it directly: SELECT * FROM v_entry_unbalanced;",
      },
    ),
    card(
      { view: "v_hold_expiry_drift", claim: "one card hold, one expiry instant — the two readers agree", rows: 13, error: null },
      {
        groups: [
          { group: "released", rows: 13, holds: 13, cents: 0n, centsLabel: "active_hold_cents" },
        ],
        witnesses: [
          {
            group: "released",
            providerAuthId: "lithic:fixture-auth-1",
            holdId: null,
            figures: [{ label: "withheld now", cents: 0n }],
            detail: "the two clocks differ by 00:00:00.135502",
          },
        ],
      },
    ),
    card(
      { view: "v_refused_auth_hold", claim: "no hold withholds money against an authorisation not recorded as APPROVED", rows: 257, error: null },
      {
        groups: [
          { group: "unanswered", rows: 257, holds: 215, cents: 1682110n, centsLabel: "active_hold_cents" },
        ],
        witnesses: [
          {
            group: "unanswered",
            providerAuthId: "auth-fixture-5-b",
            holdId: null,
            figures: [
              { label: "withheld now", cents: 2000n },
              { label: "refused", cents: 5000n },
            ],
            detail: "not_retained",
          },
        ],
      },
    ),
    card({ view: "v_book_not_zero", claim: "the whole book nets to zero, per entity and book", rows: 0, error: null }),
  ];
}

/* -------------------------------------------------------------------------- */
/* The source                                                                 */
/* -------------------------------------------------------------------------- */

export type FixtureState = "loading" | "empty" | "error" | "edge";

/** Held open long enough that the skeleton is actually visible. */
const LOADING_MS = 1_200;

export function createFixtureTriageSource(state: FixtureState): TriageDataSource {
  return {
    async read() {
      if (state === "loading") {
        await new Promise((resolve) => setTimeout(resolve, LOADING_MS));
        // Never actually rendered — the Suspense fallback is the skeleton —
        // but a source that returned a malformed snapshot to win an argument
        // with the type system would be a fixture lying to its own contract.
        return ok(base({ invariants: sectionFor([]) }));
      }

      if (state === "error") {
        return fail(
          "TRIAGE_57014",
          "the triage board could not be read: canceling statement due to statement timeout",
          { retryable: true, source: "dashboard.triage", operation: "the triage board" },
        );
      }

      if (state === "empty") {
        return ok(base({ invariants: sectionFor(emptyCards()) }));
      }

      return ok(
        base({
          invariants: sectionFor(edgeCards()),
          human: {
            approvals: {
              pending: 2,
              aboveThreshold: 1,
              capped: false,
              oldestAt: "2026-09-11T03:12:44.000Z",
              totalCents: 1_250_00n,
              aboveThresholdCents: 1_000_00n,
            },
            disputes: { needingDecision: 1, open: 1, closed: 28 },
            parked: [
              {
                kind: "card",
                ref: "bee76ecf-7c1e-4f52-b035-509177702080",
                count: 3,
                reason:
                  "a settlement arrived for a card this book has never seen. NOTHING WAS POSTED — the delivery is held until the card is registered rather than guessing whose money to move.",
              },
            ],
            parkedTotal: 3,
            deadLetters: [
              {
                provider: "lithic",
                kind: "card",
                count: 1,
                oldestAt: "2026-09-11T05:10:00.000Z",
                newestAt: "2026-09-11T05:10:00.000Z",
                reason: "parked 12 times waiting for card:bee76ecf…; referent never arrived",
                oldestAgeDays: 0,
              },
            ],
            deadLetterTotal: 1,
            unattributed: [
              {
                transferId: "sandbox_inbound_ach_transfer_fixture",
                firstSeenAt: "2026-09-11T04:14:57.871Z",
                ageDays: 0,
                deliveries: 2,
                stillParked: 2,
                deadLettered: 0,
                attributed: false,
                reason:
                  "the virtual account numbers it was addressed to could not be looked up, so there is no way to tell which customer this credit belongs to. Nothing was posted.",
              },
            ],
            breaks: {
              run: EDGE_RUN,
              breaks: [EDGE_BREAK],
              bySeverity: [{ severity: "aged", count: 1 }],
              byAge: [{ bucket: "2-3", count: 1 }],
              bookWide: 1,
            },
          },
        }),
      );
    },
  };
}

function sectionFor(cards: readonly InvariantCard[]) {
  const counted = tally(cards.map((c) => c.classified));
  return { cards, tally: counted, headline: headline(counted), readAt: AT };
}
