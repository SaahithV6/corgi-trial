/**
 * The payee screen's data contract.
 *
 * Same seam and the same rules as `src/components/standing/data-contract.ts`:
 * nothing under `src/components/payees/**` opens a connection, imports
 * `postgres`, or reaches into `src/lib/payees/*` for anything but these types.
 * The screen depends on this interface; `src/lib/payees/screen.ts` implements
 * it against the live database and `./fixtures.ts` implements it without one.
 *
 * Shape notes:
 *
 * - **There are no amounts on this screen at all.** Not in cents, not in
 *   anything — a payee is not a payment, and the only number here is a
 *   similarity score between 0 and 100 in whole points.
 * - **Instants are ISO 8601 strings.** Ages are pre-computed by the database
 *   against one `now()`, so the band and the "12 days ago" cannot disagree.
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never writes and never checks.** Running a check is an
 *   operator action with an actor attached; a render is not one.
 */

import type {
  CheckEvidence,
  DirectoryOutcome,
  FindingSeverity,
  Freshness,
  NameMatchOutcome,
  NameSource,
  PayeeOutcome,
  PayeeRail,
} from "@/lib/payees/types";
import type { ErrorShape, Result } from "@/lib/result";

export type Instant = string;

export type {
  CheckEvidence,
  DirectoryOutcome,
  FindingSeverity,
  Freshness,
  NameMatchOutcome,
  NameSource,
  PayeeOutcome,
  PayeeRail,
};

/** One thing a check found, as the screen shows it. */
export type FindingRow = {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
};

export type PayeeRow = {
  readonly payeeId: string;
  readonly businessName: string;
  /** What the customer calls them. */
  readonly displayName: string;
  /** The name that would go on the payment, and the one the check compares. */
  readonly holderName: string;
  readonly rail: PayeeRail;
  /** Published, not secret. Shown in full so a transposition is legible. */
  readonly routingNumber: string | null;
  /** Four digits. There is no full account number anywhere in this system. */
  readonly accountNumberLast4: string | null;
  readonly accountType: string | null;
  readonly createdAt: Instant;
  readonly createdByName: string;

  readonly archived: boolean;
  readonly archivedAt: Instant | null;
  readonly archivalReason: string | null;

  /** Null when nobody has ever checked this payee. A real state, not an error. */
  readonly checkedAt: Instant | null;
  readonly checkedByName: string | null;
  readonly outcome: PayeeOutcome | null;
  readonly freshness: Freshness;
  readonly checkedDaysAgo: number | null;

  readonly checksumOk: boolean | null;
  readonly prefixAssigned: boolean | null;

  readonly directory: DirectoryOutcome | null;
  readonly directoryProvider: string | null;
  readonly institutionName: string | null;

  readonly nameMatch: NameMatchOutcome | null;
  readonly nameMatchScore: number | null;
  readonly nameSource: NameSource | null;
  readonly nameProvider: string | null;
  readonly counterpartyName: string | null;

  readonly evidence: CheckEvidence | null;
  readonly findings: readonly FindingRow[];

  readonly acknowledged: boolean;
  readonly acknowledgedAt: Instant | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgementReason: string | null;

  readonly hasConflictingTwin: boolean;
};

/**
 * A destination the arithmetic refused.
 *
 * The caught typo, which is the product of this feature. It has its own row
 * type because it is not a payee and never was — a blocked candidate does not
 * become one.
 */
export type RefusalRowView = {
  readonly id: string;
  readonly attemptedAt: Instant;
  readonly attemptedByName: string;
  readonly holderName: string;
  readonly rail: PayeeRail;
  /** As typed. Not corrected, not normalised. */
  readonly routingNumber: string;
  readonly accountNumberLast4: string | null;
  readonly code: string;
  readonly reason: string;
};

export type PayeeBookView = {
  readonly asOf: Instant;
  readonly source: "live" | "fixture";
  /**
   * Which routing-number directory answered, and in which environment. Shown
   * because a `not_listed` means something completely different in each.
   */
  readonly directoryEnvironment: "sandbox" | "production" | "none";
  readonly rows: readonly PayeeRow[];
  readonly refusals: readonly RefusalRowView[];
};

export interface PayeeDataSource {
  load(filter?: {
    readonly businessId?: string | undefined;
    readonly payeeId?: string | undefined;
  }): Promise<Result<PayeeBookView, ErrorShape>>;
}
