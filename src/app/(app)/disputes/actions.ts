"use server";

/**
 * The disputes screen's write paths.
 *
 * ============================================================================
 * WHAT THESE ACTIONS DO, AND WHAT THEY DO NOT.
 *
 * THEY DO:
 *   - append a `dispute` row and a `dispute_event` row, both immutable, and
 *   - post real journal entries through `postEntry()` — two lines each, bigint
 *     cents, double-entry, append-only, to the live database.
 *
 * THEY DO NOT:
 *   - call a card network. There is nobody to call: Lithic's sandbox has no
 *     dispute simulator (`/v1/simulate/chargeback` and `/v1/simulate/dispute`
 *     both 404, measured), so the verdict is an operator action and the screen
 *     says so beside every control that records one.
 *   - decide anything the database has not already agreed to. Every refusal
 *     these actions can return has a matching `RAISE EXCEPTION` in
 *     `assert_dispute_intake()` or `assert_dispute_lifecycle()`.
 *
 * ============================================================================
 * THE ACTOR IS NOT TAKEN FROM THE FORM, AND IT IS NOT THE SYSTEM POSTER.
 *
 * The pots actions post as the `ledger-poster` system actor and say why: the
 * console's role cookie is a demo affordance, and attributing an entry to a
 * human this endpoint cannot authenticate would put a lie in the audit trail.
 *
 * Disputes cannot do that, because maker-checker is the point. The trigger
 * demands that the authoriser is a HUMAN, is an APPROVER, is NOT the actor who
 * raised the case, and does NOT belong to the customer being advanced money.
 * A single system actor satisfies none of those and would make the control
 * vacuous. So these actions resolve the actor through `currentActor()`, the
 * same way the approvals console does — and `resolveActor` picks by PREDICATE
 * (`kind = 'human' AND business_id IS NULL AND can_approve = …`) rather than by
 * a value taken out of the cookie, so the cookie chooses a ROLE and never an
 * identity.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import {
  authorizeProvisionalCredit,
  clawBackCredit,
  declineProvisionalCredit,
  DISPUTE_REASONS,
  finalizeCredit,
  grantProvisionalCredit,
  raiseDispute,
  recordDecision,
  submitEvidence,
  writeOffCredit,
  type Refused,
  type Transitioned,
} from "@/lib/disputes";
import { sql } from "@/lib/ledger/db";
import { formatUsd } from "@/lib/format/money";

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type Issue = { readonly path: string; readonly message: string };

export type RaiseResult = {
  readonly status: "idle" | "raised" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  readonly caseRef: string | null;
  readonly disputeId: string | null;
};

export type TransitionResult = {
  readonly status: "idle" | "done" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  /** Every entry id the transition posted, so the operator can cite them. */
  readonly entryIds: readonly string[];
  readonly newStatus: string | null;
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A plain USD amount to `bigint` cents, by integer string arithmetic.
 *
 * No `parseFloat`, no `* 100`. Returns `null` for anything that is not a plain
 * amount, and the caller renders that as a refusal rather than guessing.
 *
 * Not exported: a `"use server"` module may export only async functions.
 */
function parseUsdToCents(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf(".");
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? "" : cleaned.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const raiseSchema = z.object({
  disputedEntryId: z
    .string()
    .trim()
    .regex(UUID, { error: "choose the settled charge being disputed" }),
  reason: z.enum(DISPUTE_REASONS, { error: "choose a reason" }),
  /** `visa/10.4` — the network's own vocabulary, kept out of our enum. */
  networkCode: z
    .string()
    .trim()
    .regex(/^[a-z]+\/[0-9.]+$/, { error: "choose a network reason code" }),
  amount: z.string().trim().min(1, { error: "enter the amount claimed" }),
  narrative: z
    .string()
    .trim()
    .min(10, { error: "record what the customer actually said, in their words" })
    .max(500, { error: "500 characters at most" }),
});

const TRANSITIONS = [
  "authorize",
  "grant",
  "decline",
  "evidence",
  "won",
  "lost",
  "withdraw",
  "finalize",
  "clawback",
  "writeoff",
] as const;

const transitionSchema = z.object({
  disputeId: z.string().trim().regex(UUID, { error: "which case?" }),
  intent: z.enum(TRANSITIONS, { error: "unknown action" }),
  detail: z.string().trim().max(500).optional(),
  /**
   * The day the FACT happened, not the day the button was pressed.
   *
   * This field is the correction-versus-new-event decision, exposed. A clawback
   * carries the day the NETWORK decided; leaving it blank books it on today's
   * business date. It is never the grant's date, because the grant was not
   * wrong — the network's answer is a new fact on a new day.
   */
  valueDate: z.string().trim().regex(ISO_DATE, { error: "YYYY-MM-DD" }).optional(),
});

function issuesOf(error: z.ZodError): readonly Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(form)",
    message: issue.message,
  }));
}

/* -------------------------------------------------------------------------- */
/* Raise                                                                      */
/* -------------------------------------------------------------------------- */

export async function raiseDisputeAction(
  _previous: RaiseResult,
  formData: FormData,
): Promise<RaiseResult> {
  const parsed = raiseSchema.safeParse({
    disputedEntryId: formData.get("disputedEntryId") ?? "",
    reason: formData.get("reason") ?? "",
    networkCode: formData.get("networkCode") ?? "",
    amount: formData.get("amount") ?? "",
    narrative: formData.get("narrative") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so nothing was written and no case was opened.",
      issues: issuesOf(parsed.error),
      caseRef: null,
      disputeId: null,
    };
  }

  const amountCents = parseUsdToCents(parsed.data.amount);
  if (amountCents === null || amountCents <= 0n) {
    return {
      status: "refused",
      code: "INVALID_AMOUNT",
      message: "That is not a plain USD amount. Money is integer cents here; nothing was written.",
      issues: [{ path: "amount", message: "e.g. 73.40" }],
      caseRef: null,
      disputeId: null,
    };
  }

  const actor = await currentActor();
  if (actor === null) {
    return {
      status: "refused",
      code: "NO_ACTOR",
      message:
        "No actor could be resolved for this role, so there is nobody to attribute the case to.",
      issues: null,
      caseRef: null,
      disputeId: null,
    };
  }

  const [network, code] = parsed.data.networkCode.split("/");
  if (network === undefined || code === undefined) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "That network reason code could not be read.",
      issues: [{ path: "networkCode", message: "expected network/code" }],
      caseRef: null,
      disputeId: null,
    };
  }

  const result = await raiseDispute(
    {
      disputedEntryId: parsed.data.disputedEntryId,
      reason: parsed.data.reason,
      network,
      networkCode: code,
      narrative: parsed.data.narrative,
      amountCents,
      actorId: actor.id,
    },
    sql,
  );

  if (result.kind === "refused") {
    return {
      status: "refused",
      code: result.code,
      message: result.message,
      issues: null,
      caseRef: null,
      disputeId: null,
    };
  }

  revalidatePath("/disputes");
  return {
    status: "raised",
    code: null,
    message:
      `Case ${result.caseRef} opened for ${formatUsd(result.amountCents)}. ` +
      (result.needsAuthorization
        ? `It is at or above the ${formatUsd(result.thresholdCents)} threshold, so provisional credit needs one Corgi approver who did not raise it.`
        : `It is below the ${formatUsd(result.thresholdCents)} threshold, so provisional credit needs no second human.`) +
      " No money has moved: raising a claim is not a payment.",
    issues: null,
    caseRef: result.caseRef,
    disputeId: result.disputeId,
  };
}

/* -------------------------------------------------------------------------- */
/* Everything after intake                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One action, one `intent` per submit button.
 *
 * The alternative — ten actions — would put the lifecycle in ten places and
 * make "which transitions exist" a thing you learn by grepping. Here it is one
 * enum, and the actual rules are still in the trigger, where they cannot be
 * routed around.
 */
export async function disputeTransitionAction(
  _previous: TransitionResult,
  formData: FormData,
): Promise<TransitionResult> {
  const parsed = transitionSchema.safeParse({
    disputeId: formData.get("disputeId") ?? "",
    intent: formData.get("intent") ?? "",
    detail: formData.get("detail") ?? undefined,
    valueDate: formData.get("valueDate") || undefined,
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so nothing was written and no money moved.",
      issues: issuesOf(parsed.error),
      entryIds: [],
      newStatus: null,
    };
  }

  const actor = await currentActor();
  if (actor === null) {
    return {
      status: "refused",
      code: "NO_ACTOR",
      message: "No actor could be resolved for this role, so there is nobody to attribute this to.",
      issues: null,
      entryIds: [],
      newStatus: null,
    };
  }

  const base = {
    disputeId: parsed.data.disputeId,
    actorId: actor.id,
    ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
    ...(parsed.data.valueDate === undefined ? {} : { valueDate: parsed.data.valueDate }),
  };

  let result: Transitioned | Refused;
  switch (parsed.data.intent) {
    case "authorize":
      result = await authorizeProvisionalCredit(base, sql);
      break;
    case "grant":
      result = await grantProvisionalCredit(base, sql);
      break;
    case "decline":
      result = await declineProvisionalCredit(base, sql);
      break;
    case "evidence":
      result = await submitEvidence(base, sql);
      break;
    case "won":
      result = await recordDecision({ ...base, outcome: "won" }, sql);
      break;
    case "lost":
      result = await recordDecision({ ...base, outcome: "lost" }, sql);
      break;
    case "withdraw":
      result = await recordDecision({ ...base, outcome: "withdrawn" }, sql);
      break;
    case "finalize":
      result = await finalizeCredit(base, sql);
      break;
    case "clawback":
      result = await clawBackCredit(base, sql);
      break;
    case "writeoff":
      result = await writeOffCredit(base, sql);
      break;
    default: {
      const exhaustive: never = parsed.data.intent;
      throw new Error(`unhandled intent ${String(exhaustive)}`);
    }
  }

  if (result.kind === "refused") {
    return {
      status: "refused",
      code: result.code,
      message: result.message,
      issues: null,
      entryIds: [],
      newStatus: null,
    };
  }

  revalidatePath("/disputes");
  return {
    status: "done",
    code: null,
    message:
      result.entryIds.length === 0
        ? `Recorded ${result.event} on ${result.valueDate}. No money moved — this step only changes what the case says.`
        : `Recorded ${result.event} on ${result.valueDate}, value-dated to the day the fact happened. ` +
          `${String(result.entryIds.length)} entr${result.entryIds.length === 1 ? "y" : "ies"} posted through postEntry().`,
    issues: null,
    entryIds: result.entryIds,
    newStatus: result.status,
  };
}
