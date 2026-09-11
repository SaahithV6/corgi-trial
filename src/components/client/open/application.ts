/**
 * The shapes `/client/open` passes between its server action and its form.
 *
 * A PLAIN MODULE ON PURPOSE. `./actions.ts` carries `"use server"`, and such a
 * module may export ONLY async functions — export a type or a constant from one
 * and it becomes a *server reference* on the client, which crashes the form on
 * first render while `pnpm typecheck` and `eslint` both stay clean. This build
 * has lost hours to that twice (`/team`, standing orders), so the idle value
 * and every type live here, imported by both sides. Same arrangement as
 * `src/components/team/action-result.ts`.
 */

import type { Evidence, KybStatus } from "@/lib/kyb/types";

/** One director as the applicant typed them. Never reaches a URL. */
export type DirectorInput = {
  readonly fullName: string;
  readonly email: string;
};

/**
 * What the registry actually said about the name the applicant submitted.
 *
 * Carried as its own shape rather than reusing the operator screen's `LegView`
 * because this is a PROBE — it is about an identifier, it wrote no row, and it
 * must never be renderable in a slot that says "recorded against your
 * application". The one-way type boundary is what makes that a compile error
 * rather than a habit.
 */
export type RegistryAnswerView = {
  /** `lei` when the applicant asserted one, `name` when we searched by name. */
  readonly kind: "lei" | "name";
  readonly provider: string;
  readonly reference: string;
  readonly status: KybStatus;
  readonly evidence: Evidence;
  /** The registry's own machine-readable code, when it gave one. */
  readonly providerCode: string | null;
  /** Where this answer can be checked: which register, which entry. */
  readonly citation: string | null;
  /** The registry's own sentences, verbatim. */
  readonly reasons: readonly string[];
};

/**
 * The applicant-facing state of an application.
 *
 * These are the brief's own three integration states and they are FIRST CLASS:
 * `pending` and `rejected` each carry their own headline and their own "what
 * happens next", and neither renders in the shape `approved` renders in. There
 * is no fourth value meaning "submitted, we will see" — a submission that
 * reached no provider is `pending` with a reason.
 */
export type ApplicationState = "pending" | "approved" | "rejected";

export type ApplicationResult = {
  readonly status: "idle" | "submitted" | "refused";
  /**
   * Null only while idle or refused-before-any-check. Whenever a check ran,
   * this is the applicant's state and it is derived, never chosen: see
   * `weakestOfLegs()` in ./actions.ts.
   */
  readonly state: ApplicationState | null;
  /** A named code that names its own fix. Never a bare "error". */
  readonly code: string | null;
  /** The headline the applicant reads. Already written; the view decides nothing. */
  readonly headline: string;
  /** What is true, and what happens next. Plain sentences, no jargon. */
  readonly detail: string;
  /** The legal name as the server read it back, so the applicant sees what we heard. */
  readonly legalName: string | null;
  /** The live registry answer, when one was obtained. */
  readonly registry: RegistryAnswerView | null;
  /**
   * Whether a deposit account exists for this applicant yet.
   *
   * ALWAYS FALSE FROM THIS SCREEN, and that is the point rather than a stub:
   * `src/components/client/contract.ts` models "no `2100` leaf means KYB has
   * not let them in", and nothing on this surface opens one optimistically.
   */
  readonly accountOpen: boolean;
  /** The step a human has to perform, when there is one. Null otherwise. */
  readonly handover: string | null;
  /**
   * The application's own reference, once a row exists for it.
   *
   * Null while idle, refused, or declined by the register — all three are
   * states in which NOTHING WAS WRITTEN, and a reference for a row that does
   * not exist would be the screen claiming more than happened. Non-null means
   * `business_application` carries this id and a reviewer can find it.
   */
  readonly applicationId: string | null;
  /**
   * The derived KYB fold for the applicant, read back from
   * `v_business_application` AFTER the legs were filed.
   *
   * Never `approved` on this surface, and not because this file declines to
   * print it: the director leg is a Stripe Identity session that has just been
   * created, the composite reports the WEAKEST leg, and
   * `db/migrations/0065_business_apply.sql` section 10 proves an applicant
   * cannot reach `approved` through the function that created them.
   */
  readonly kybStatus: string | null;
};

export const IDLE_APPLICATION: ApplicationResult = {
  status: "idle",
  state: null,
  code: null,
  headline: "",
  detail: "",
  legalName: null,
  registry: null,
  accountOpen: false,
  handover: null,
  applicationId: null,
  kybStatus: null,
};

/** The three states, in the words the applicant is owed. */
export const STATE_HEADLINE: Record<ApplicationState, string> = {
  pending: "Your application is under review",
  approved: "Your account is open",
  rejected: "We cannot open an account for you",
};

/** Purely presentational. Kept beside the copy so the two cannot drift. */
export const STATE_TONE: Record<ApplicationState, string> = {
  pending: "border-amber-400/60 bg-amber-50 text-amber-900",
  approved: "border-emerald-400/60 bg-emerald-50 text-emerald-900",
  rejected: "border-rose-400/60 bg-rose-50 text-rose-900",
};

/** The maximum directors one submission may carry. */
export const MAX_DIRECTORS = 4;
