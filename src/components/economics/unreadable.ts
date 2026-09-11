/**
 * The refusal `/economics` shows on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and on this
 * screen the two were separated by one word. `page.tsx` answered "there is no
 * database" with `createFixtureEconomicsSource("empty")`, and the EMPTY state
 * of this screen is not a blank page. It is a finding:
 *
 *     "No card has settled yet"
 *     "Until a card transaction settles there is nothing to price, and this
 *      page will not invent a figure to fill itself."
 *
 * That is a sentence about a programme, and it is the sentence somebody acts
 * on — nobody chases a revenue figure that a screen has told them does not
 * exist yet. "Nothing has settled" and "nothing was read" have different
 * remedies, and only one of them was true.
 *
 * The rate-card panel underneath it made the same mistake in the other
 * direction. Its description says the card is in force whether or not anything
 * has priced against it, which is exactly right about a card that was READ and
 * empty of meaning over four bands from a fixture file.
 *
 * It never actually reached that fallback. The guard asked `hasDatabase()` by
 * destructuring it off `await import("@/lib/interchange/screen")`, which throws
 * without `APP_DATABASE_URL` — and because `EconomicsView.tsx` imports
 * `portfolioTotals` from that same module as a value, the page module did not
 * finish evaluating either. The operator got the framework error page and all
 * five states went down together.
 *
 * WHY THIS SCREEN IS A REFUSAL COMPONENT AND NOT A REFUSAL SOURCE. Every other
 * repaired screen answers "no database" with a source that returns a failed
 * read, so the refusal arrives down the path failures already take. That is
 * still the better shape and it is not available here: the component that
 * renders a failed read is `EconomicsView`, and `EconomicsView` cannot be
 * loaded without a database, which is the defect. So the refusal is a
 * component the page renders INSTEAD of loading that module. It draws no
 * board — there is exactly one thing in this directory that draws a board, and
 * it is not this — and `EconomicsView` renders the same component for a read
 * that failed for any other reason, so the two causes look alike on purpose
 * and differ only in their code and their words.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database. The read-failure case beside it is `retryable: true`, and that is
 * also new — this screen's error panel used to offer a bare "Retry" link with
 * no code and no statement of whether retrying could help.
 */

import type { ErrorShape } from "@/lib/result";

export const ECONOMICS_BOOK_UNREADABLE: ErrorShape = {
  code: "ECONOMICS_BOOK_UNREADABLE",
  message:
    "No database is configured for this deployment, so no settlement was priced, no rate card was resolved and no guard was counted. Nothing on this screen is a statement about whether the card programme makes money. A blank page here is not a programme that has never settled a card, and no guard reading zero rows is not a guard that held.",
  details: {
    retryable: false,
    source: "interchange.screen",
    operation: "the unit economics read",
  },
};

/** A read that failed for some other reason. Retrying one of these is worth a try. */
export function economicsReadFailed(thrown: unknown): ErrorShape {
  return {
    code: "ECONOMICS_READ_FAILED",
    message: thrown instanceof Error ? thrown.message : String(thrown),
    details: {
      retryable: true,
      source: "interchange.screen",
      operation: "the unit economics read",
    },
  };
}
