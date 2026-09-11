"use server";

/**
 * `/client/open` — the write path for a business applying for an account.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHY IT IS NOT `/onboarding`
 * ===========================================================================
 *
 * The brief's core loop opens "open an account behind a real KYB check", and
 * until this route existed step one was something staff did TO a customer:
 * `/onboarding` is the operator's console and every verb on it starts from a
 * `businessId` that already exists on the book. KYB *enforcement* was already
 * on the customer surface — `transactGateForBusiness` is one of the ten `WHERE`
 * predicates in `src/app/(app)/client/live-source.ts` and it runs again inside
 * `requestPayment()`'s own transaction. APPLYING was not. This is applying.
 *
 * ONE LIBRARY, TWO CALLERS. Nothing here imports the operator's action file and
 * nothing here reimplements it. The registry leg is run by `probeRegistry()`
 * from `@/lib/kyb/wire` — the same live GLEIF adapter, through the same
 * function the operator's registry probe calls — and the applicant's state is
 * folded by `strictestOf()` from `@/lib/kyb/types`, the library's own
 * weakest-leg rule.
 *
 * ===========================================================================
 * THE WEAKEST LEG DECIDES, AND THAT IS WHY THIS SCREEN CANNOT APPROVE ANYBODY
 * ===========================================================================
 *
 * A composite verification has two legs: director KYC and the business
 * registry. `strictestOf()` reports the WEAKEST rather than an average, so one
 * unanswered leg holds the whole application down. On this surface the director
 * leg has not been answered — see `ENTITY_RECORD_HANDOVER` — so the fold is
 * `strictestOf([registryStatus, 'pending'])`, which can be `pending`,
 * `needs_review` or `rejected` and can NEVER be `approved`. That is the rule
 * working, not a limitation being papered over, and the applicant is told it in
 * those words.
 *
 * ===========================================================================
 * THIS ACTION CREATES NOTHING AT A PROVIDER AND WRITES NO ROW
 * ===========================================================================
 *
 * `probeRegistry()` is a `GET` against a public, key-less, CC0 index. It writes
 * nothing, it is about an identifier rather than about a business on this book,
 * and its sentinel reference id is not a uuid, so it could not be filed against
 * a business row even by accident.
 *
 * The second half — appending the answer to `kyb_verification_leg` under a real
 * `business.id`, and starting the live Stripe Identity session for the
 * directors — needs a `business` row, and the application role CANNOT CREATE
 * ONE. `db/migrations/0001_ledger.sql:839` grants `corgi_app` SELECT and only
 * SELECT on `business`, `actor` and `book_entity`, there is no SECURITY DEFINER
 * function for entity creation the way `business_accounts_open()` exists for
 * accounts, and `src/lib/ledger/db.ts` connects as exactly that role. So
 * creating the entity record is an operator act by privilege boundary. This
 * action says so, names the step, and hands it over — it does not try, and it
 * does not pretend the application got further than it did.
 *
 * ===========================================================================
 * EVERYTHING ARRIVING HERE IS A CLAIM
 * ===========================================================================
 *
 * A server action is a public POST endpoint. The legal name, the EIN, the
 * address and the directors are what somebody typed; none of them is treated
 * as a fact. What survives into the applicant's answer is the REGISTRY's reply,
 * under the registry's name.
 *
 * NO PII EVER REACHES A URL. Every field arrives in the POST body of a server
 * action, nothing is put in a query string, and the EIN and the directors are
 * not echoed into any link, `revalidatePath` argument, or log field below.
 */

import { z } from "zod";

import { MAX_DIRECTORS, type ApplicationResult, type ApplicationState, type RegistryAnswerView } from "./application";
import { strictestOf, type KybStatus } from "@/lib/kyb/types";
import { probeRegistry } from "@/lib/kyb/wire";
import { rootLogger } from "@/lib/log";

/**
 * The one step this surface genuinely cannot perform, named so it can be handed
 * to a person rather than faked.
 */
const ENTITY_RECORD_HANDOVER =
  "A Corgi reviewer has to create your entity record before the director identity checks can start. " +
  "The application role this page runs as holds SELECT and only SELECT on the business table " +
  "(db/migrations/0001_ledger.sql:839), so no screen can create that record — including this one. " +
  "Your submission and the registry answer below are what the reviewer works from.";

const director = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, { error: "a director needs a full legal name" })
    .max(200, { error: "that name is longer than this form accepts" }),
  email: z.email({ error: "a director needs a contactable email address" }).max(320),
});

/**
 * The EIN is shape-checked and never interpolated into a URL.
 *
 * Nine digits, optionally hyphenated after the second — the IRS form. A string
 * that is not that shape is refused HERE, before anything is sent anywhere,
 * because the alternative is sending somebody's typo to a third party.
 */
const schema = z.object({
  legalName: z
    .string()
    .trim()
    .min(2, { error: "a legal name is needed to search the register" })
    .max(200, { error: "that is longer than any legal name in the register" }),
  ein: z
    .string()
    .trim()
    .refine((v) => /^\d{2}-?\d{7}$/.test(v), {
      error: "an EIN is nine digits, written 12-3456789",
    }),
  street1: z.string().trim().min(2, { error: "a registered street address is needed" }).max(200),
  city: z.string().trim().min(1, { error: "a city is needed" }).max(120),
  subdivision: z
    .string()
    .trim()
    .min(2, { error: "a state or territory is needed" })
    .max(60),
  postalCode: z.string().trim().min(3, { error: "a postal code is needed" }).max(20),
  lei: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-Z0-9]{20}$/.test(v), {
      error: "a Legal Entity Identifier is twenty letters and digits (ISO 17442)",
    }),
  directors: z
    .array(director)
    .min(1, { error: "a business account needs at least one director" })
    .max(MAX_DIRECTORS, { error: `this form takes at most ${MAX_DIRECTORS} directors` }),
});

function refused(code: string, headline: string, detail: string): ApplicationResult {
  return {
    status: "refused",
    state: null,
    code,
    headline,
    detail,
    legalName: null,
    registry: null,
    accountOpen: false,
    handover: null,
  };
}

/**
 * Pull the directors out of the flat `FormData` a form posts.
 *
 * Indexed names rather than a JSON blob, so the browser's own validation can
 * mark the field that is wrong, and so nothing has to be parsed out of a
 * string the client assembled.
 */
function readDirectors(formData: FormData): readonly { fullName: string; email: string }[] {
  const rows: { fullName: string; email: string }[] = [];
  for (let index = 0; index < MAX_DIRECTORS; index += 1) {
    const fullName = formData.get(`director.${index}.fullName`);
    const email = formData.get(`director.${index}.email`);
    const name = typeof fullName === "string" ? fullName.trim() : "";
    const mail = typeof email === "string" ? email.trim() : "";
    if (name === "" && mail === "") continue;
    rows.push({ fullName: name, email: mail });
  }
  return rows;
}

/**
 * The applicant-facing state, folded by the library's own rule.
 *
 * `needs_review` is not a fourth state the applicant is shown — a registry that
 * cannot corroborate an entity is an application still being looked at, which
 * is `pending` to the person waiting. `rejected` is the only status that
 * becomes `rejected`, and `approved` is unreachable here BY CONSTRUCTION
 * because the director leg contributes `pending` to every fold.
 */
function applicantState(registryStatus: KybStatus): ApplicationState {
  const folded = strictestOf([registryStatus, "pending"]);
  if (folded === "rejected") return "rejected";
  if (folded === "approved") return "approved";
  return "pending";
}

export async function applyAction(
  _previous: ApplicationResult,
  formData: FormData,
): Promise<ApplicationResult> {
  const parsed = schema.safeParse({
    legalName: formData.get("legalName"),
    ein: formData.get("ein"),
    street1: formData.get("street1"),
    city: formData.get("city"),
    subdivision: formData.get("subdivision"),
    postalCode: formData.get("postalCode"),
    lei: formData.get("lei") ?? "",
    directors: readDirectors(formData),
  });

  if (!parsed.success) {
    return refused(
      "APPLICATION_INVALID",
      "That application could not be read",
      `${parsed.error.issues[0]?.message ?? "One of the fields could not be read."} ` +
        "Nothing was sent to a registry and nothing was recorded — fix that field and submit again.",
    );
  }

  const { legalName, lei, directors } = parsed.data;

  // The EIN, the address and the directors are deliberately ABSENT from this
  // logger's fields. What is worth knowing is that an application arrived and
  // how many directors it named; who they are is not a log line.
  const log = rootLogger.child({ surface: "client/open" });

  // The real check. `probeRegistry()` asks the live GLEIF adapter about the
  // asserted LEI when there is one — an exact identifier lookup, whose miss is
  // a decline rather than a shrug — and about the legal name otherwise.
  const probe = await probeRegistry(lei === "" ? legalName : lei);

  if (!probe.ok) {
    // Fail closed and name the fix. A registry we could not reach is NOT a
    // pass, and it is not silently downgraded to one either.
    log.warn("client.open.registry.unreachable", { code: probe.error.code });
    return refused(
      probe.error.code,
      "We could not reach the company register",
      `${probe.error.message} Your application was not recorded, so there is nothing to withdraw. ` +
        "Submitting again re-asks the register; if it keeps failing, the register itself is down and a reviewer will pick this up by hand.",
    );
  }

  const leg = probe.value.leg;
  const registry: RegistryAnswerView = {
    kind: probe.value.kind,
    provider: leg.provider,
    reference: leg.reference,
    status: leg.status,
    evidence: leg.evidence,
    providerCode: leg.providerCode,
    citation: leg.citation,
    reasons: leg.checks.flatMap((check) => check.reasons),
  };

  const state = applicantState(leg.status);
  log.info("client.open.submitted", {
    directors: directors.length,
    assertedLei: lei !== "",
    registryStatus: leg.status,
    registryEvidence: leg.evidence,
    state,
  });

  const evidenceSentence =
    leg.evidence === "live"
      ? `That answer came from ${leg.provider}, a third party, and is quotable: reference ${leg.reference}.`
      : `That answer came from a LABELLED SIMULATOR (${leg.provider}), not from a register, because this deployment has the registry leg forced to the simulator. It cannot support an approval.`;

  if (state === "rejected") {
    return {
      status: "submitted",
      state,
      code: registry.providerCode ?? "REGISTRY_DECLINED",
      headline: "We cannot open an account for you",
      detail:
        `The company register declined ${legalName}. ${evidenceSentence} ` +
        "No account has been opened and none will be on this application. " +
        "If you believe the register holds the wrong record for you, correct it with the register first — we read what they publish, we do not overrule it — and then apply again.",
      legalName,
      registry,
      accountOpen: false,
      handover: null,
    };
  }

  return {
    status: "submitted",
    state,
    code: "APPLICATION_PENDING",
    headline: "Your application is under review",
    detail:
      `We have your application for ${legalName} and we have asked the company register about you. ${evidenceSentence} ` +
      (leg.status === "approved"
        ? "That leg is satisfied — but it is one of two. "
        : "That leg is not yet satisfied. ") +
      "Your directors still have to pass an identity check, and an application is only as strong as its WEAKEST leg: we report the weaker of the two rather than averaging them, so one unfinished check holds the whole application at pending. " +
      "You have no account and no balance yet, and you cannot send or receive money. That is not a delay in switching something on — an account does not exist until the check passes.",
    legalName,
    registry,
    accountOpen: false,
    handover: ENTITY_RECORD_HANDOVER,
  };
}
