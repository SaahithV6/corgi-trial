"use server";

import { cookies } from "next/headers";

import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/**
 * The approvals screen's write path.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Next's own guidance is blunt about
 * it: "the route is reachable to anyone who can send the same POST. Treat every
 * action as an untrusted entry point." Rendering a disabled button is not a
 * control; it is a courtesy.
 *
 * So everything that arrives in the `FormData` is treated as a claim:
 *
 *   instructionId   a REFERENCE. Which payment, nothing more. The amount, the
 *                   destination, the rail and the initiator are re-read from
 *                   the row inside the database, never taken from the client.
 *   contentHash     a claim about WHAT THE APPROVER SAW, and the one field that
 *                   is *supposed* to come from the client. It is passed to the
 *                   database unaltered so the trigger can compare it against
 *                   the row. Re-reading it server-side would make
 *                   approve-the-hash a tautology — the check would compare the
 *                   row to itself and pass every time.
 *   reason          free text, trimmed, length-capped, stored.
 *
 * And the identity is NOT taken from the form at all. The actor id is resolved
 * on the server from the session (today: the demo role cookie, via
 * `lib/approvals/session.ts`, which resolves by predicate rather than by value).
 * A caller who POSTs a different actor id changes nothing, because no field
 * named `actorId` is read.
 *
 * The maker-checker rules themselves are not here and must not be added here.
 * See the header of `src/lib/approvals/decide.ts`.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the module for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";
import { rootLogger } from "@/lib/log";

/**
 * WHY `decide`, `release` AND `session` ARE NOT IMPORTED AT THE TOP OF THIS
 * FILE.
 *
 * All three reach `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env`
 * at module scope and throws `EnvironmentError` without `APP_DATABASE_URL`.
 * `DecisionForm` imports `decideAction` from here, `QueueList` imports
 * `DecisionForm`, and `ApprovalsView` imports `QueueList` — so on a deployment
 * with no database this module's imports are a second static route from the
 * page to a throw, beside the one that was actually measured. Under the app
 * router the client boundary at `DecisionForm` usually stops the server from
 * evaluating it; "usually" is not a property a screen should depend on to
 * render the words "no database configured", and nothing outside a bundler
 * stops it at all.
 *
 * They are imported inside the action instead, on the branch that has already
 * established there is a database to write to. The action is a POST, and a POST
 * to this screen on a deployment with no database is refused below with a code
 * rather than an exception — see `NO_DATABASE` — because a server action that
 * throws gives an operator an error boundary and no sentence.
 */

/** What the form gets back. Serialised to the client, so: no row contents. */
export type DecisionResult = {
  readonly status: "idle" | "ok" | "refused";
  /** Machine-readable refusal code, or the intent that succeeded. */
  readonly code: string | null;
  readonly message: string;
  /** Which row the message belongs to, so one form does not report another's. */
  readonly instructionId: string | null;
};

const decisionSchema = z.object({
  instructionId: z.uuid({ error: "that is not a payment id" }),
  contentHash: z.string().regex(/^[0-9a-fA-F]{64}$/, {
    error: "the approval did not carry a readable content hash",
  }),
  intent: z.enum(["approve", "reject", "release"]),
  reason: z.string().max(500).optional(),
  /**
   * The release confirmation. Absent on approve and reject, which add an event
   * and stop; required on release, which posts the entry and hands the
   * instruction to a rail. Checked HERE and not only in the form, because a
   * checkbox a hand-assembled POST can omit is a courtesy and not a control —
   * the same reason the maker-checker rule lives in a trigger.
   */
  releaseConfirmed: z.literal("yes").optional(),
});

const SUCCESS: Record<"approve" | "reject" | "release", string> = {
  approve:
    "Approved. The approval cites this payment's content hash, so it applies to this amount and this destination and to nothing else.",
  reject: "Rejected. No money moved and none can: a rejected instruction can never be released.",
  release:
    "Released. The journal entry is keyed on the instruction id, so pressing release again would post nothing.",
};

/**
 * Record a decision.
 *
 * Shaped for `useActionState`, so the form can render the refusal inline
 * instead of throwing an unexplained error boundary at an operator who is
 * halfway through a payment run.
 */
export async function decideAction(
  _previous: DecisionResult,
  formData: FormData,
): Promise<DecisionResult> {
  // A SESSION IS REQUIRED TO DECIDE A PAYMENT, AND THIS IS WHERE IT IS CHECKED.
  //
  // This module was exempted from `assertOperatorAction()` because it is
  // rendered on `/client/approvals` as well as the console, and an operator-only
  // guard would refuse a customer their own screen. The exemption was correct
  // and the consequence was not: a server action posts to whatever page the
  // browser is on, `/` is classified `customer`, and `/` renders this very form.
  // So the middleware's write gate did not cover it and neither did the action
  // guard. Measured on the deployed site: Approve and Reject rendered ENABLED to
  // a visitor holding no credential at all.
  //
  // Approving a payment is the highest-privilege act in this system — it is the
  // second signature the whole maker-checker design exists to require — so it
  // needs a session whoever is asking, customer or operator. That is a real cost
  // and it is stated in docs/AUTH.md rather than hidden: the customer surface has
  // no sign-in of its own yet, so `/client/approvals` becomes read-only until one
  // exists. A queue you can read and not act on is an honest screen; an Approve
  // button that works for anybody is not.
  //
  // The database refuses independently — `assert_maker_checker()` raises 42501
  // on a self-approval and `can_approve` is checked there too — but a trigger
  // refusing an unauthenticated caller is the last line, not the first, and it
  // cannot tell an anonymous visitor from the actor whose cookie they typed.
  const session = await verifySession(
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  if (!session.ok) {
    return {
      status: "refused",
      instructionId: String(formData.get("instructionId") ?? ""),
      code: "SIGN_IN_REQUIRED",
      message:
        "Deciding a payment needs a signed-in session. Nothing was written, and the payment is exactly where it was. " +
        "Sign in at /signin and open the queue again — the role switch between Staff and Approver works behind that gate, " +
        "and the rule that an initiator can never approve their own payment is enforced by the database either way.",
    };
  }

  const parsed = decisionSchema.safeParse({
    instructionId: formData.get("instructionId"),
    contentHash: formData.get("contentHash"),
    intent: formData.get("intent"),
    reason: formData.get("reason") ?? undefined,
    releaseConfirmed: formData.get("releaseConfirmed") ?? undefined,
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_REQUEST",
      message:
        "That decision could not be read. Nothing was written. Reload the queue and try again — a mangled form field must never become an approval.",
      instructionId: null,
    };
  }

  const { instructionId, contentHash, intent, reason, releaseConfirmed } = parsed.data;
  const log = rootLogger.child({ instructionId, intent });

  // Release is the one intent that moves money. It is refused unless the
  // request carried the confirmation the form makes the operator tick, so the
  // friction survives a POST that skipped the screen.
  if (intent === "release" && releaseConfirmed === undefined) {
    return {
      status: "refused",
      code: "RELEASE_NOT_CONFIRMED",
      message:
        "A release must carry the confirmation that names the amount and the destination. Nothing was written and no entry was posted.",
      instructionId,
    };
  }

  if (!hasDatabase()) {
    // Unreachable from the screen — with no database `/approvals` draws the
    // refusal panel and no row, so there is no button to press. It is reachable
    // by a hand-assembled POST, which is the whole reason a server action
    // re-checks everything, and the honest answer is that nothing was written
    // because there was nowhere to write it.
    return {
      status: "refused",
      code: "APPROVALS_NO_DATABASE",
      message:
        "No database is configured for this deployment, so the decision was not recorded and the payment it names was never read. Nothing was approved, rejected or released.",
      instructionId,
    };
  }

  const [{ approvePayment, rejectPayment }, { releasePayment }, { currentActor }] =
    await Promise.all([
      import("@/lib/approvals/decide"),
      import("@/lib/approvals/release"),
      import("@/lib/approvals/session"),
    ]);

  const actor = await currentActor();
  if (actor === null) {
    return {
      status: "refused",
      code: "NO_ACTOR",
      message:
        "No actor could be resolved for this session, so the decision has nobody to attribute it to and was not written.",
      instructionId,
    };
  }

  const input = {
    instructionId,
    actorId: actor.id,
    contentHash,
    ...(reason === undefined ? {} : { reason }),
  };

  const result =
    intent === "approve"
      ? await approvePayment(input)
      : intent === "reject"
        ? await rejectPayment(input)
        : await releasePayment({ instructionId, actorId: actor.id });

  if (!result.ok) {
    // The raw Postgres text goes to the log with its SQLSTATE — an operator
    // investigating a refusal needs the trigger's own words. The screen gets
    // the translated sentence and never the internal ids.
    log.warn("approvals.refused", {
      actorId: actor.id,
      code: result.error.code,
      detail: result.error.details,
    });
    return {
      status: "refused",
      code: result.error.code,
      message: result.error.message,
      instructionId,
    };
  }

  log.info("approvals.recorded", { actorId: actor.id, intent });
  revalidatePath("/approvals");

  return {
    status: "ok",
    code: intent.toUpperCase(),
    message: SUCCESS[intent],
    instructionId,
  };
}
