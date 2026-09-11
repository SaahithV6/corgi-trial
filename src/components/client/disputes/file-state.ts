/**
 * The result of filing a dispute, and its idle value.
 *
 * Its own module because a `"use server"` file may export only async functions,
 * so the type `useActionState` needs cannot live beside the action. Exactly the
 * shape and the reason of `src/components/client/card-controls-state.ts`.
 *
 * Pure. No `server-only`, no database, no money type — every figure here is a
 * string the server has already formatted, because the consumer is a client
 * component and a `bigint` does not survive that boundary.
 */

export type FileDisputeStatus = "idle" | "filed" | "already_filed" | "refused";

export type CaseFact = {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
};

export type FileDisputeResult = {
  readonly status: FileDisputeStatus;
  /**
   * The named refusal, or `null` on success.
   *
   * Every non-null value here is a code somebody can search for, and its
   * message says what resolves it. There is no path through the action that
   * returns a generic failure: an unrecognised database error is rethrown
   * rather than flattened into this field, because a money screen that
   * swallows an unknown error starts lying quietly.
   */
  readonly code: string | null;
  readonly message: string;
  /** Which charge the result is about, so one refusal prints under one row. */
  readonly entryId: string | null;
  readonly caseRef: string | null;
  readonly disputeId: string | null;
  readonly facts: readonly CaseFact[];
};

export const FILE_DISPUTE_IDLE: FileDisputeResult = {
  status: "idle",
  code: null,
  message: "",
  entryId: null,
  caseRef: null,
  disputeId: null,
  facts: [],
};
