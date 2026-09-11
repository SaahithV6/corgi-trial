/**
 * The source `/onboarding` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and this
 * screen had neither: it had no guard at all. `OnboardingView.tsx` opened with a
 * STATIC `import { createLiveOnboardingSource } from "@/lib/kyb/wire"`, that
 * module's graph reaches `@/lib/ledger/db` -> `@/lib/env`, and `@/lib/env`
 * throws `EnvironmentError` at module scope without `APP_DATABASE_URL`. The
 * page module therefore failed to evaluate and all five states went down
 * together — including `loading`, `empty`, `error` and `edge`, which are
 * fixtures and need no database to be drawn. Measured with the variable
 * deleted, the render threw and the operator got the framework's error page.
 *
 * WHY A REFUSAL AND NOT THE `empty` FIXTURE, which is the shape the screens
 * repaired before this one were repaired away from. The `empty` state here says
 * "no businesses on the book at all", and this screen's rows are the answer to
 * a question with a remedy attached: who is waiting on a verification decision.
 * An empty list means nobody is waiting, and nobody is waiting is the reason a
 * compliance operator closes the tab.
 *
 * THE VERDICTS ARE THE SHARPER HALF. Every card on this screen carries a KYB
 * state and an evidence label, and the whole module exists to make one
 * combination unrepresentable: approved on evidence that is not live. A screen
 * that renders verdicts it did not read has done the same thing one level up —
 * it has printed a verification state that no evidence row supports. So the
 * refusal draws no card, no leg and no verdict.
 *
 * WHAT DOES NOT STOP. The gate is not this screen. `canTransact()` reads
 * `v_business_kyb` on every payment path and fails closed, so a deployment that
 * cannot read the state denies rather than allows, whether or not anybody is
 * looking at this page.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `ErrorPanel` drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { OnboardingDataSource, OnboardingSnapshot } from "./data-contract";

export const ONBOARDING_STATE_UNREADABLE: ErrorShape = {
  code: "ONBOARDING_STATE_UNREADABLE",
  message:
    "No database is configured for this deployment, so no business was listed, no verification leg was read and no composite state was derived. Nothing on this screen is a statement about whether anybody is verified. An empty list here is not a book with no businesses on it, and no business awaiting review is not a queue somebody has cleared.",
  details: {
    retryable: false,
    source: "kyb.wire",
    operation: "the KYB state read",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is an `OnboardingDataSource` rather than a branch in the view so the
 * refusal arrives through the same channel as every other failure: one
 * component draws the entities, one component renders the refusal, and there is
 * no second path on which this screen could be drawn from nothing.
 */
export function createUnreadableOnboardingSource(
  error: ErrorShape = ONBOARDING_STATE_UNREADABLE,
): OnboardingDataSource {
  return {
    getSnapshot(): Promise<Result<OnboardingSnapshot, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
