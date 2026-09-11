import { fail, ok } from "@/lib/result";

import type { PotsDataSource, PotsResult, PotsView } from "./data-contract";
import type { DemoState } from "./view-state";

/**
 * The non-live states, without a database.
 *
 * WHICH STATES ARE FIXTURES AND WHY, stated plainly because the trial's fastest
 * way to fail is presenting something as more real than it is:
 *
 *   default  LIVE. Real pots, real balances, real journal entries.
 *   edge     LIVE. The refusal is decided by `decideMove()` against this
 *            moment's real available balance; only the AMOUNT is synthetic.
 *            It is not in this file — see `edgeRefusal` in lib/pots/screen.ts.
 *   loading  FIXTURE-ish: a real query held open, so the skeleton on screen is
 *            the skeleton a slow database actually produces.
 *   empty    FIXTURE. A customer with no pots. Reproducible live by opening the
 *            screen on a business nobody has given a pot to, but not on demand
 *            once every business on the book has one.
 *   error    FIXTURE. Requires the database to be down, which is not a thing to
 *            arrange in front of a panel — and the interesting half of the
 *            state is what the screen SAYS, which is real either way.
 *
 * Every fixture view carries `source: "fixture"`, and the screen prints that on
 * its face. A viewer never has to guess which figures are real.
 */

const NOW = "2026-09-10T18:00:00.000Z";

const EMPTY_VIEW: PotsView = {
  source: "fixture",
  asOf: NOW,
  bookDate: "2026-09-10",
  businesses: [
    {
      businessId: "00000000-0000-4000-8000-000000000001",
      legalName: "Ridgeline Robotics, Inc.",
      mainAccountId: "00000000-0000-4000-8000-0000000000a1",
    },
  ],
  selected: {
    businessId: "00000000-0000-4000-8000-000000000001",
    legalName: "Ridgeline Robotics, Inc.",
    mainAccountId: "00000000-0000-4000-8000-0000000000a1",
  },
  pots: [],
  // The identity still holds with no pots: it degenerates to main = subtree.
  // Showing it in the empty state is the point — the arithmetic does not start
  // working once there is something to look at.
  identity: {
    mainCents: 3_424_763,
    potsCents: 0,
    totalCents: 3_424_763,
    subtreeCents: 3_424_763,
    differenceCents: 0,
    holds: true,
  },
  availability: {
    ledgerCents: 3_424_763,
    holdsCents: 36_000,
    unclearedCents: 1_375_300,
    availableCents: 2_013_463,
  },
  movements: [],
  invariants: [],
  refusal: null,
};

export function createFixturePotsSource(state: DemoState): PotsDataSource {
  return {
    async load(): Promise<PotsResult> {
      switch (state) {
        case "loading":
          // Long enough that the Suspense fallback is unmistakably on screen,
          // short enough that nobody in the room thinks it has hung.
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          return ok(EMPTY_VIEW);

        case "error":
          return fail(
            "POTS_READ_FAILED",
            "The pots read failed. No money moved: this path only reads, and the two writes on this screen are server actions raised from a form. Nothing was posted, no pot was opened, and the balances below are simply unknown right now rather than wrong.",
            { detail: "connection to the ledger timed out after 10s" },
          );

        case "empty":
          return ok(EMPTY_VIEW);

        default:
          return ok(EMPTY_VIEW);
      }
    },
  };
}
