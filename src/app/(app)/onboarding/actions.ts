"use server";

/**
 * The onboarding screen's write path.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything arriving in the
 * `FormData` is a claim, and two of these three intents spend something real —
 * one creates a verification session at Stripe, all three read from the live
 * book — so each is treated as an untrusted entry point.
 *
 *   businessId   a REFERENCE, and nothing else. The legal name, the EIN and
 *                the KYB state are re-read from the row on the server; nothing
 *                about the business is taken from the client.
 *   intent       one of three fixed verbs. Anything else is refused before a
 *                provider is touched.
 *
 * THE THIRD-PARTY CALL IS DELIBERATELY NOT ON THE RENDER PATH. `POST
 * /v1/identity/verification_sessions` creates a real object in a real Stripe
 * account. A page that created one per render would litter that account on
 * every refresh, every prefetch and every bot, so the only thing that creates a
 * session is a person pressing a button — and `beginVerification()` refuses a
 * second one for a business that already has evidence on file.
 *
 * THE GATE IS NOT A UI STATE. `intent=gate` runs `canTransact()` against the
 * live derived state on the server. The screen renders a disabled button and a
 * reason BEFORE the press as a courtesy, exactly as the approvals queue does,
 * but the predicate here is the one that would refuse a payment, and it is
 * re-run on every POST whatever the button looked like.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import {
  beginVerification,
  refreshVerification,
  transactGateForBusiness,
} from "@/lib/kyb/wire";
import { rootLogger } from "@/lib/log";
import type { LegView } from "@/components/onboarding/data-contract";

/** What the form gets back. Serialised to the client, so: no row contents. */
export type OnboardingResult = {
  readonly status: "idle" | "ok" | "refused";
  readonly intent: "begin" | "refresh" | "gate" | null;
  /** Machine-readable: a denial code, or the intent that succeeded. */
  readonly code: string | null;
  readonly message: string;
  /** Which business this belongs to, so one card never reports another's. */
  readonly businessId: string | null;
  /**
   * The provider's hosted flow, when a session was just created. Single-use and
   * short-lived, which is why it is returned here and never stored.
   */
  readonly hostedUrl: string | null;
  /** The live provider reference to quote in the debrief — `vs_…`. */
  readonly directorReference: string | null;
  readonly legs: readonly LegView[];
};

/**
 * Not exported: a `"use server"` module may export ONLY async functions, so
 * the client's idle value is declared next to the form that renders it.
 */
const IDLE_RESULT: OnboardingResult = {
  status: "idle",
  intent: null,
  code: null,
  message: "",
  businessId: null,
  hostedUrl: null,
  directorReference: null,
  legs: [],
};

const schema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  intent: z.enum(["begin", "refresh", "gate"]),
});

function refused(
  businessId: string | null,
  intent: OnboardingResult["intent"],
  code: string,
  message: string,
): OnboardingResult {
  return { ...IDLE_RESULT, status: "refused", intent, code, message, businessId };
}

export async function onboardingAction(
  _previous: OnboardingResult,
  formData: FormData,
): Promise<OnboardingResult> {
  const parsed = schema.safeParse({
    businessId: formData.get("businessId"),
    intent: formData.get("intent"),
  });

  if (!parsed.success) {
    return refused(
      null,
      null,
      "INVALID_REQUEST",
      "That request could not be read, so nothing was sent to a provider and nothing was recorded.",
    );
  }

  const { businessId, intent } = parsed.data;
  const log = rootLogger.child({ businessId, intent });

  // Attribution. `kyb_verification_leg` records WHO SAID IT — the provider —
  // and has no actor column, deliberately: a provider's answer is not something
  // a member of staff authored. So the operator is attributed in the log, and
  // an unresolved session still refuses, because an action nobody can be named
  // for is not one this console performs.
  const actor = await currentActor();
  if (actor === null) {
    return refused(
      businessId,
      intent,
      "NO_ACTOR",
      "No actor could be resolved for this session, so this action has nobody to attribute it to and was not performed.",
    );
  }

  if (intent === "gate") {
    const decision = await transactGateForBusiness(businessId);
    log.info("kyb.gate.checked", {
      actorId: actor.id,
      allowed: decision.allowed,
      code: decision.allowed ? null : decision.code,
    });
    if (!decision.allowed) {
      return {
        ...IDLE_RESULT,
        status: "refused",
        intent,
        code: decision.code,
        message: `${decision.message} Nothing was raised: canTransact() refused before a payment instruction could be written.`,
        businessId,
      };
    }
    return {
      ...IDLE_RESULT,
      status: "ok",
      intent,
      code: "KYB_ALLOWED",
      message:
        decision.evidence === "live"
          ? "canTransact() allows this business to raise a payment, on live third-party evidence. The payment itself is raised on the approvals screen; this check is the one that would gate it."
          : "canTransact() allows this business to raise a payment — on SIMULATED evidence. Under requireLiveEvidence the same row is refused KYB_EVIDENCE_SIMULATED. The payment itself is raised on the approvals screen; this check is the one that would gate it.",
      businessId,
    };
  }

  const result =
    intent === "begin"
      ? await beginVerification(businessId)
      : await refreshVerification(businessId);

  if (!result.ok) {
    log.warn("kyb.action.refused", { actorId: actor.id, code: result.error.code });
    return refused(businessId, intent, result.error.code, result.error.message);
  }

  const outcome = result.value;
  log.info("kyb.action.recorded", {
    actorId: actor.id,
    status: outcome.status,
    evidence: outcome.evidence,
  });
  revalidatePath("/onboarding");

  const evidenceSentence =
    outcome.evidence === "live"
      ? "Both legs were answered by third parties, so this verification is labelled live."
      : "One leg was simulated, so the whole verification is labelled simulated — evidence degrades and never un-degrades.";

  return {
    status: "ok",
    intent,
    code: intent === "begin" ? "KYB_STARTED" : "KYB_REFRESHED",
    message:
      `${intent === "begin" ? "Started" : "Re-read"}: ${outcome.legalName} is ${outcome.status} on ${outcome.evidence} evidence. ` +
      evidenceSentence,
    businessId,
    hostedUrl: outcome.hostedUrl,
    directorReference: outcome.directorReference,
    legs: outcome.legs,
  };
}
