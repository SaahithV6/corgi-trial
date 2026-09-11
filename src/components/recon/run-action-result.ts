/**
 * What the reconciliation run controls hand back to the form that fired them.
 *
 * IN ITS OWN PLAIN MODULE, DELIBERATELY. `src/app/(app)/reconciliation/actions.ts`
 * is a `"use server"` module, and everything exported from such a module becomes
 * a SERVER REFERENCE — a client importing a constant from one receives a
 * callable stub rather than the object, `useActionState` seeds the form with it,
 * and the component throws inside the streamed Suspense body while the page
 * still answers 200. That is the defect that took `/team` out for hours; see
 * `src/components/team/action-result.ts` for the full account. The type and the
 * idle value therefore live here, and BOTH the action module and the client
 * component import them from here.
 *
 * This module is imported by a client component, so it must stay free of
 * `server-only` and free of anything that reaches a database.
 */

export type ReconRunStatus = "idle" | "ok" | "failed";

/** A fact worth copying out of the receipt: a run id, a file hash. */
export type ReconRunFact = {
  readonly label: string;
  readonly value: string;
  /** Render monospaced. True for ids and hashes. */
  readonly mono?: boolean;
};

export type ReconRunResult = {
  readonly status: ReconRunStatus;
  readonly code: string | null;
  readonly message: string;
  readonly facts: readonly ReconRunFact[];
  /**
   * Where to go to read what this run found, or `null` when nothing ran.
   *
   * A run that found breaks is not finished business, so the receipt carries
   * the URL that shows them rather than leaving the operator to find the run
   * in the history by its number.
   */
  readonly href: string | null;
  readonly at: string | null;
};

export const RECON_RUN_IDLE: ReconRunResult = {
  status: "idle",
  code: null,
  message: "",
  facts: [],
  href: null,
  at: null,
};
