"use server";

/**
 * The onboarding screen's write path.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything arriving in the
 * `FormData` is a claim, and these verbs spend something real — one creates a
 * verification session at Stripe, one queries a public registry, all of them
 * read from the live book — so each is treated as an untrusted entry point.
 *
 *   businessId   a REFERENCE, and nothing else. The legal name, the EIN and
 *                the KYB state are re-read from the row on the server; nothing
 *                about the business is taken from the client.
 *   intent       one of four fixed verbs — begin, refresh, recheck, gate.
 *                Anything else is refused before a provider is touched.
 *   lei          OPTIONAL, and a CLAIM rather than a fact. Shape-checked
 *                against ISO 17442 before it goes anywhere near a URL, and
 *                never stored: what lands in the table is the registry's
 *                ANSWER to the claim, under the registry's name.
 *
 * `registryProbeAction` at the foot of this file is a separate entry point on
 * purpose — it is about no business, writes nothing, and must not share a code
 * path with the verbs that do.
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
import { MANUAL_MIN_REASON_LENGTH } from "@/lib/kyb/manual-review";
import {
  beginVerification,
  probeRegistry,
  recheckRegistry,
  recordManualReview,
  refreshVerification,
  transactGateForBusiness,
} from "@/lib/kyb/wire";
import { rootLogger } from "@/lib/log";
import type { LegView, RegistryProbeView } from "@/components/onboarding/data-contract";

/** What the form gets back. Serialised to the client, so: no row contents. */
export type OnboardingResult = {
  readonly status: "idle" | "ok" | "refused";
  readonly intent: "begin" | "refresh" | "recheck" | "gate" | "review" | null;
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
 * The registry probe's own result type, separate from `OnboardingResult`.
 *
 * SEPARATE ON PURPOSE. A probe is not a verification — it writes no row, it is
 * about no business, and it must never be renderable in a slot that says
 * "Recorded". Two shapes make that a compile error rather than a discipline.
 */
export type RegistryProbeResult = {
  readonly status: "idle" | "ok" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly probe: RegistryProbeView | null;
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

/**
 * `lei` is OPTIONAL AND UNTRUSTED, and its shape is checked before it is used.
 *
 * ISO 17442 is twenty upper-case alphanumerics. Anything else — an EIN, a
 * pasted URL, a company number — is treated as "no LEI supplied" rather than
 * sent to GLEIF as a path segment, which is both a correctness rule and the
 * reason nothing here interpolates it into a URL by hand.
 *
 * Note what is NOT stored: the claim itself. `kyb_verification_leg` records
 * what a PROVIDER said, and "the applicant says their LEI is X" is not that.
 * What survives is GLEIF's answer, under GLEIF's name — or, when the identifier
 * does not exist, a `gleif.notfound.` reference that says so in the id.
 */
const schema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  intent: z.enum(["begin", "refresh", "recheck", "gate"]),
  lei: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-Z0-9]{20}$/.test(v), {
      error: "a Legal Entity Identifier is twenty letters and digits (ISO 17442)",
    })
    .optional(),
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
    lei: formData.get("lei") ?? undefined,
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
  const lei = parsed.data.lei ?? "";
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
      ? await beginVerification(businessId, lei === "" ? {} : { lei })
      : intent === "recheck"
        ? await recheckRegistry(businessId, lei === "" ? {} : { lei })
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
    // The CLAIM is not stored; whether one was made is worth knowing.
    assertedLei: lei !== "",
  });
  revalidatePath("/onboarding");

  const evidenceSentence =
    outcome.evidence === "live"
      ? "Both legs were answered by third parties, so this verification is labelled live."
      : "One leg was simulated, so the whole verification is labelled simulated — evidence degrades and never un-degrades.";

  return {
    status: "ok",
    intent,
    code:
      intent === "begin"
        ? "KYB_STARTED"
        : intent === "recheck"
          ? "KYB_REGISTRY_RECHECKED"
          : "KYB_REFRESHED",
    message:
      `${
        intent === "begin"
          ? "Started"
          : intent === "recheck"
            ? `Asked GLEIF again${lei === "" ? " by name" : ` about LEI ${lei}`}`
            : "Re-read"
      }: ${outcome.legalName} is ${outcome.status} on ${outcome.evidence} evidence. ` +
      evidenceSentence,
    businessId,
    hostedUrl: outcome.hostedUrl,
    directorReference: outcome.directorReference,
    legs: outcome.legs,
  };
}


/**
 * ============================================================================
 * ASK THE REGISTRY SOMETHING THAT IS NOT ABOUT THIS BOOK.
 *
 * A SECOND ACTION RATHER THAN A FOURTH INTENT, and the split is the safety
 * property. `onboardingAction` takes a `businessId`, resolves an actor, and
 * every one of its verbs either writes to `kyb_verification_leg` or runs the
 * gate against a real row. This one takes a free-text query, is about nobody,
 * and writes nothing at all. Sharing a function between the two would mean one
 * `formData.get("businessId")` away from filing an answer about Apple Inc.
 * against a business on this book.
 *
 * WHY IT EXISTS. Every seeded business is fictional, so GLEIF correctly answers
 * "not in the LEI registry" for all three — needs_review, never approved. That
 * is the right answer and it is also the ONLY answer those three can produce,
 * which leaves a reviewer unable to tell a working registry from one that
 * always shrugs. This asks the same live adapter about anything typed into it,
 * so an approval with a Secretary of State citation, a decline on a withdrawn
 * company, and a 404 on an invented identifier are all reproducible on demand
 * without a single false claim about a demo row.
 * ============================================================================
 */
export async function registryProbeAction(
  _previous: RegistryProbeResult,
  formData: FormData,
): Promise<RegistryProbeResult> {
  const raw = formData.get("query");
  const query = typeof raw === "string" ? raw.trim() : "";

  if (query === "") {
    return {
      status: "refused",
      code: "PROBE_EMPTY",
      message: "Nothing was asked, so nothing was sent to the registry.",
      probe: null,
    };
  }
  if (query.length > 200) {
    return {
      status: "refused",
      code: "PROBE_TOO_LONG",
      message:
        "That is longer than any legal name in the register. Nothing was sent — a public API is still somebody else's server.",
      probe: null,
    };
  }

  // No actor gate here, deliberately, and it is worth saying why rather than
  // leaving the asymmetry to be noticed: this action performs a GET against a
  // public, key-less, CC0 index, creates nothing, spends nothing, and cannot
  // change a single row on this book. There is no action to attribute.
  const result = await probeRegistry(query);
  if (!result.ok) {
    return { status: "refused", code: result.error.code, message: result.error.message, probe: null };
  }

  rootLogger.info("kyb.registry.probe", {
    kind: result.value.kind,
    status: result.value.leg.status,
    provider: result.value.leg.provider,
  });

  return {
    status: "ok",
    code: result.value.leg.status,
    message:
      "This is what the registry said, and it is a statement about that identifier — not about any business on this book. Nothing was written.",
    probe: result.value,
  };
}


/**
 * ============================================================================
 * THE OPERATOR DECISION — a separate action, because it is a separate KIND of
 * act.
 *
 * Every verb in `onboardingAction` asks a PROVIDER something and records what
 * they said. This one records what a PERSON decided, and the difference is the
 * whole reason the evidence lattice grew a third label. Sharing an action
 * between them would put "ask Stripe" and "approve this business yourself" one
 * mistyped `intent` apart.
 *
 * THE ACTOR IS NOT TAKEN FROM THE FORM. It is resolved on the server from the
 * session, exactly as the approvals queue does — a review whose reviewer came
 * out of a hidden input would be an attribution anybody could type. And the
 * database will not accept a non-human reviewer at all: 0013 constrains
 * `decided_by_kind` to `human` through a composite foreign key to
 * `actor(id, kind)`, so the agent surface cannot clear a KYB queue even if it
 * reaches this function.
 *
 * WHAT LANDS: one INSERT. The registry's own answer is not edited, flagged or
 * removed — it stays exactly where it was, and this becomes the latest thing
 * said about that leg. A reversal is a further row.
 * ============================================================================
 */
const reviewSchema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  leg: z.enum(["director_kyc", "business_registry"]),
  decision: z.enum(["approve", "decline"]),
  reason: z
    .string()
    .trim()
    .min(MANUAL_MIN_REASON_LENGTH, {
      error: `A review needs a written reason of at least ${MANUAL_MIN_REASON_LENGTH} characters — the reason IS the evidence here.`,
    })
    .max(2000, { error: "that reason is longer than this column is meant to hold" }),
});

export async function reviewAction(
  _previous: OnboardingResult,
  formData: FormData,
): Promise<OnboardingResult> {
  const parsed = reviewSchema.safeParse({
    businessId: formData.get("businessId"),
    leg: formData.get("leg"),
    decision: formData.get("decision"),
    reason: formData.get("reason"),
  });

  if (!parsed.success) {
    const businessId = formData.get("businessId");
    return refused(
      typeof businessId === "string" ? businessId : null,
      "review",
      "INVALID_REVIEW",
      parsed.error.issues[0]?.message ??
        "That review could not be read, so nothing was recorded.",
    );
  }

  const { businessId, leg, decision, reason } = parsed.data;
  const log = rootLogger.child({ businessId, leg, decision });

  const actor = await currentActor();
  if (actor === null) {
    return refused(
      businessId,
      "review",
      "NO_ACTOR",
      "No actor could be resolved for this session. A KYB decision that nobody can be named for is not one this console records — the reviewer is the evidence.",
    );
  }

  const result = await recordManualReview(
    businessId,
    {
      leg,
      decision,
      reason,
      reviewer: { id: actor.id, displayName: actor.displayName, kind: actor.kind },
    },
    { log },
  );

  if (!result.ok) {
    log.warn("kyb.review.refused", { actorId: actor.id, code: result.error.code });
    return refused(businessId, "review", result.error.code, result.error.message);
  }

  const outcome = result.value;
  revalidatePath("/onboarding");

  return {
    status: "ok",
    intent: "review",
    code: decision === "approve" ? "KYB_REVIEW_APPROVED" : "KYB_REVIEW_DECLINED",
    message:
      `${actor.displayName} ${decision === "approve" ? "approved" : "declined"} the ${
        leg === "director_kyc" ? "director KYC" : "business registry"
      } leg for ${outcome.legalName} on review. It is now ${outcome.status} on ${outcome.evidence} evidence. ` +
      "The provider's own answer is untouched and still on file below this row — a review is another observation, not an edit.",
    businessId,
    hostedUrl: null,
    directorReference: outcome.directorReference,
    legs: outcome.legs,
  };
}
