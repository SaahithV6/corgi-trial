"use server";

/**
 * The operator's half of payee confirmation — the half that did not exist.
 *
 * ============================================================================
 * WHAT THIS FILE CLOSES.
 *
 * Until it was written, `confirmPayee()` had no caller anywhere in
 * `src/app/**`, `ConfirmationStep.tsx` had no importer, and `/payees` was
 * read-only. The gate in front of the money was real and enforcing — it fires
 * on the deployed URL and refuses before a `payment_instruction` row exists —
 * but its central refusal, `PAYEE_WARNING_UNACKNOWLEDGED`, told an operator to
 * "open the payee, read what the check found, and record why it is right to
 * pay this account" on a console that offered no way to do any of those three
 * things. `acknowledgeWarning()` existed and was tested; it had no button.
 *
 * A control whose remedy is unreachable is a control people route around. The
 * refusal was correct, and the loop was open. These three actions are the
 * other end of it:
 *
 *   addPayeeAction          a beneficiary, checked, and a row either way
 *   recheckPayeeAction      the same beneficiary, checked again, appended
 *   signWarningAction       a named human answering named findings
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything in the `FormData` is a
 * claim and is re-validated here:
 *
 *   businessId    a REFERENCE. The payee is written against it by the
 *                 database's own foreign key; nothing the browser says about
 *                 which business this is gets believed further than that.
 *   routingNumber nine digits, and then the ARITHMETIC, recomputed on the
 *                 server from the submitted string. The browser shows the same
 *                 working as you type, but it is not the browser's answer that
 *                 decides: `verifyPayee()` runs it again, and beneath that
 *                 `payee_routing_number_possible` — a CHECK constraint —
 *                 refuses to store an impossible number at all.
 *   last4         four digits. THE FULL ACCOUNT NUMBER NEVER ARRIVES HERE;
 *                 see THE FULL ACCOUNT NUMBER, below.
 *   codes         which findings a signature answers. Re-read from
 *                 `payee_verification` and refused unless they match — see
 *                 `src/lib/payees/acknowledge.ts`.
 *
 * THE IDENTITY IS NOT TAKEN FROM THE FORM. The actor is resolved on the server
 * from the session (today: the demo role cookie, resolved by predicate). A
 * caller who POSTs an `actorId` field changes nothing, because no field of
 * that name is read. Every row these actions write carries that actor, and
 * every one of the five tables they touch is append-only by grant, by REVOKE
 * and by 0001's `ledger_row_is_immutable()` trigger — so a confirmation is a
 * fact, not a field.
 *
 * ============================================================================
 * THE FULL ACCOUNT NUMBER IS NEVER SENT TO THIS SERVER.
 *
 * The add form asks for the account number twice, because re-entry is the only
 * defence the United States leaves against an account-number typo — there is
 * no check digit on a US account number, no length rule and no character rule.
 * The two typings are compared IN THE BROWSER, by
 * `accountNumberEntryAgrees()`, and only the last four digits are posted.
 *
 * That is deliberate and it is the right side of the trade. `payee` stores
 * four digits and never more, for the same reason `payment_instruction`
 * .counterparty does: an approver needs to recognise a beneficiary, not to be
 * able to re-key the payment somewhere else. Sending the full number to a
 * server that will immediately discard it would put it in a request body, in
 * a platform's action log, and in whatever captures an exception on the way —
 * to buy nothing, because the value would not be stored at either end.
 *
 * AND THE RE-ENTRY CHECK IS NOT A CONTROL, which is why it is allowed to live
 * in the browser. `verify.ts` says so in as many words: two different strings
 * are a contradiction in the FORM, not a fact about a bank, and it is
 * deliberately not a `PayeeFinding` and not part of the block/warn ladder. A
 * POST assembled by hand skips it and reaches exactly the same checks, because
 * the checks that matter are about the routing number and the book.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import { rootLogger } from "@/lib/log";
import { signWarning, type AcknowledgedFinding } from "@/lib/payees/acknowledge";
import { IncreaseRoutingDirectory } from "@/lib/payees/directory";
import { explainRoutingNumber, type AbaExplanation } from "@/lib/payees/explain";
import { confirmPayee } from "@/lib/payees/gate";
import { recheckPayee } from "@/lib/payees/recheck";
import { NO_IDENTITY_SOURCE } from "@/lib/payees/identity";
import { payeeCandidateSchema, type NameSource, type PayeeCheck } from "@/lib/payees/types";

/* -------------------------------------------------------------------------- */
/* What the forms get back                                                    */
/* -------------------------------------------------------------------------- */

/** One field-level complaint, flattened. Never contains a row value. */
export type PayeeFieldIssue = {
  readonly path: string;
  readonly message: string;
};

/** One finding, as the confirmation panel renders it. */
export type CheckFindingView = {
  readonly code: string;
  readonly severity: "block" | "warn" | "note";
  readonly title: string;
  readonly detail: string;
};

/**
 * The check that ran, as the screen shows it.
 *
 * Everything here was produced by `verifyPayee()` and then WRITTEN, so the
 * panel renders a decision that already exists as a row rather than one it
 * computed for display. It cannot disagree with the database, because it is
 * not a second opinion.
 */
export type CheckReceipt = {
  /** Null when the candidate was blocked: a blocked candidate is not a payee. */
  readonly payeeId: string | null;
  /** The append-only row this check became. Null when nothing was written. */
  readonly verificationId: string | null;
  /** False when the payee key already existed and no second payee was written. */
  readonly created: boolean;

  readonly decision: "verified" | "warned" | "blocked";
  /** False only for a block. There is no acknowledgement for arithmetic. */
  readonly acknowledgeable: boolean;

  readonly displayName: string;
  readonly holderName: string;
  readonly rail: string;
  readonly routingNumber: string | null;
  readonly accountNumberLast4: string | null;
  readonly institutionName: string | null;
  readonly counterpartyName: string | null;
  readonly nameSource: NameSource | null;
  readonly nameMatchScore: number | null;
  readonly directoryProvider: string | null;
  readonly nameProvider: string | null;
  readonly evidence: "live" | "simulated";
  readonly checkedAt: string;
  readonly checkedByName: string;

  readonly findings: readonly CheckFindingView[];
  /** The warn-level codes a signature would have to answer. */
  readonly warnedCodes: readonly string[];

  /**
   * THE ARITHMETIC, RECOMPUTED ON THE SERVER from the submitted digits.
   * Shown as working rather than as a verdict — see
   * `src/lib/payees/explain.ts`.
   */
  readonly arithmetic: AbaExplanation;
};

export type ConfirmResult = {
  readonly status: "idle" | "checked" | "refused";
  /** The refusal code verbatim, or the decision on success. */
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly PayeeFieldIssue[] | null;
  /**
   * NULL MEANS NO CHECK HAPPENED — which is not the same as a check that
   * found nothing. `ConfirmPayeeResult.check` is nullable for exactly this
   * reason and the nullability is carried all the way to the screen rather
   * than being flattened into an empty findings list on the way.
   */
  readonly receipt: CheckReceipt | null;
};

/*
 * NOTE: there is no exported `IDLE` constant here and there cannot be. A
 * `"use server"` module may only export async functions — every other export
 * becomes a callable endpoint or a build error — so the initial state for
 * `useActionState` lives in the client components that hold the forms.
 */

export type SignatureView = {
  readonly acknowledgementId: string;
  readonly verificationId: string;
  readonly payeeId: string;
  readonly holderName: string;
  readonly displayName: string;
  /** Verbatim, as stored. The composed sentence, not the one that was typed. */
  readonly reason: string;
  readonly findings: readonly AcknowledgedFinding[];
  readonly signedByName: string;
};

export type SignResult = {
  readonly status: "idle" | "signed" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly signature: SignatureView | null;
};

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                            */
/* -------------------------------------------------------------------------- */

const NO_ACTOR =
  "No actor could be resolved for this session, so there is nobody to attribute the check to " +
  "and nothing was written. Every payee row carries a created_by and every verification a " +
  "checked_by; an unattributable check is not one this system will record.";

/**
 * Which providers run when an operator presses the button.
 *
 * INCREASE'S ROUTING DIRECTORY IS LIVE and it is always constructed, even with
 * no key: it degrades to `unavailable` with a reason rather than throwing, and
 * `unavailable` is a truthful answer where `not_checked` would be a lie — the
 * difference between "nobody answered" and "there was nothing to ask about"
 * is one of the four values `DirectoryStatus` has and the one this feature is
 * most careful about.
 *
 * PLAID'S IDENTITY MATCH IS NOT WIRED TO THIS FORM, and the reason is a fact
 * about the schema rather than a shortcut. `/identity/match` takes an ACCESS
 * TOKEN — it answers "does this name match the account whose own holder linked
 * it to us", not "whose account is this number" — and `plaid/adapter.ts` says
 * plainly that there is nowhere in this schema to persist an access token. So
 * there is no linked account to offer in a dropdown, and the alternative — a
 * form field asking an operator to paste a bearer token — would be worse than
 * not having the leg.
 *
 * The honest consequence is on the screen already: `name_source` comes back
 * `payer_asserted`, which means our own team typed both names and nobody
 * confirmed anything, and `labels.tsx` refuses to draw that in the positive
 * tone however high the score is. When a US name-check network exists,
 * `identity.ts` gains a method and nothing in `name-match.ts` changes.
 */
function providers() {
  return {
    directory: new IncreaseRoutingDirectory({}),
    identity: NO_IDENTITY_SOURCE,
  };
}

function receiptFrom(
  check: PayeeCheck,
  context: {
    readonly payeeId: string | null;
    readonly verificationId: string | null;
    readonly created: boolean;
    readonly displayName: string;
    readonly holderName: string;
    readonly rail: string;
    readonly accountNumberLast4: string | null;
    readonly routingNumberAsTyped: string;
    readonly checkedByName: string;
  },
): CheckReceipt {
  return {
    payeeId: context.payeeId,
    verificationId: context.verificationId,
    created: context.created,
    decision: check.decision,
    acknowledgeable: check.acknowledgeable,
    displayName: context.displayName,
    holderName: context.holderName,
    rail: context.rail,
    routingNumber: check.routingNumber,
    accountNumberLast4: context.accountNumberLast4,
    institutionName: check.institutionName,
    counterpartyName: check.name.counterpartyName,
    nameSource: check.name.source,
    nameMatchScore: check.name.score,
    directoryProvider: check.directoryProvider,
    nameProvider: check.name.provider,
    evidence: check.evidence,
    checkedAt: check.checkedAt,
    checkedByName: context.checkedByName,
    findings: check.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
    })),
    warnedCodes: check.findings.filter((f) => f.severity === "warn").map((f) => f.code),
    // THE DIGITS AS TYPED, not as normalised by the checker. If somebody pasted
    // eight digits or a letter, the working has to be about what they actually
    // sent — a panel that silently explains a different string is a panel that
    // teaches the wrong lesson about what was refused.
    arithmetic: explainRoutingNumber(context.routingNumberAsTyped),
  };
}

/* -------------------------------------------------------------------------- */
/* 1 · Add a payee                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The FORM's schema, which is not the payee's schema.
 *
 * This one gets the browser's strings into the right slots.
 * `payeeCandidateSchema` decides whether what comes out is a beneficiary this
 * book can hold, and `verifyPayee()` decides what is true about it. Restating
 * their rules here would create a second place they could drift.
 */
const addSchema = z.object({
  businessId: z.uuid({ error: "choose the business this payee belongs to" }),
  displayName: z
    .string()
    .trim()
    .min(1, { error: "what do you call them?" })
    .max(200),
  holderName: z
    .string()
    .trim()
    .min(1, { error: "the name that goes on the payment" })
    .max(200),
  // ACH AND WIRE ONLY, and the restriction is the feature rather than a gap.
  // Those are the two rails addressed by a nine-digit ABA, so they are the two
  // rails this form has anything to check. USDC is addressed by a chain
  // address with its own EIP-55 checksum and an internal transfer never leaves
  // this book; adding either here would be a confirmation step that confirms
  // nothing, wearing the same panel as one that does.
  rail: z.enum(["ach", "wire"], { error: "ACH or wire — the two rails an ABA addresses" }),
  routingNumber: z.string().trim().min(1, { error: "enter the routing number" }).max(40),
  accountNumberLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, { error: "the last four digits of the account number" }),
  accountType: z.enum(["checking", "savings"]).optional(),
  /**
   * THE SOURCE FACT — a supplier record, an invoice, an onboarding ticket.
   * The idempotency key is derived from it, so keying the same supplier twice
   * returns the payee that already exists instead of putting two copies of one
   * bank detail on the book. Two copies is how a business ends up paying the
   * stale one.
   */
  reference: z
    .string()
    .trim()
    .min(3, { error: "reference the supplier record, invoice or ticket this payee comes from" })
    .max(120)
    .regex(/^[A-Za-z0-9._:/#-]+(?: [A-Za-z0-9._:/#-]+)*$/, {
      error: "letters, digits, spaces and . _ : / # - only",
    }),
});

export async function addPayeeAction(
  _previous: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  const parsed = addSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    displayName: formData.get("displayName") ?? "",
    holderName: formData.get("holderName") ?? "",
    rail: formData.get("rail") ?? "",
    routingNumber: formData.get("routingNumber") ?? "",
    accountNumberLast4: formData.get("accountNumberLast4") ?? "",
    accountType: formData.get("accountType") ?? undefined,
    reference: formData.get("reference") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message:
        "The form could not be read, so nothing reached the database: no payee, no check, no " +
        "refusal row. Every field is checked again on the server after this one passes — this " +
        "is the outer of three gates, and the innermost is a CHECK constraint.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(form)",
        message: issue.message,
      })),
      receipt: null,
    };
  }

  const fields = parsed.data;
  const log = rootLogger.child({ screen: "payees", rail: fields.rail });

  // ACH carries an account type and wire does not — `payee_rail_fields` is a
  // CHECK constraint and a wire row with one in it cannot be stored. Shaped
  // here rather than rejected there, because "exactly the fields the rail
  // needs" is a statement about the rail, not a complaint about the operator.
  const candidateShape = {
    businessId: fields.businessId,
    displayName: fields.displayName,
    holderName: fields.holderName,
    rail: fields.rail,
    routingNumber: fields.routingNumber,
    accountNumberLast4: fields.accountNumberLast4,
    ...(fields.rail === "ach" ? { accountType: fields.accountType ?? "checking" } : {}),
  };

  const candidate = payeeCandidateSchema.safeParse(candidateShape);
  if (!candidate.success) {
    return {
      status: "refused",
      code: "INVALID_PAYEE",
      message:
        "The beneficiary is not one this book can hold. Nothing was written. The shape of a " +
        "payee is decided by one schema, shared with everything else that can produce one.",
      issues: candidate.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(payee)",
        message: issue.message,
      })),
      receipt: null,
    };
  }

  const actor = await currentActor();
  if (actor === null) {
    return { status: "refused", code: "NO_ACTOR", message: NO_ACTOR, issues: null, receipt: null };
  }

  // Derived from the source fact and scoped to the business, never a uuid we
  // just generated: a key that is fresh on every attempt is not an idempotency
  // key, it is a duplicate waiting for a double-click.
  const payeeKey = `console:payee:${fields.businessId}:${fields.reference}`.slice(0, 200);

  const { directory, identity } = providers();
  const result = await confirmPayee({
    candidate: candidate.data,
    payeeKey,
    actorId: actor.id,
    directory,
    identity,
  });

  // NO CHECK HAPPENED. `check: null` is the §5d fail-closed path — the book
  // could not be read, so the twin probe did not run, so nothing was written:
  // no payee, no verification, and deliberately no refusal row either. It is
  // NOT flattened into "a check with no findings" on its way to the screen.
  if (result.check === null) {
    const refusal = result.refusal;
    log.warn("payees.check_unavailable", {
      actorId: actor.id,
      code: refusal?.code ?? "PAYEE_BOOK_UNREADABLE",
    });
    return {
      status: "refused",
      code: refusal?.code ?? "PAYEE_BOOK_UNREADABLE",
      message: refusal?.message ?? "The payee could not be checked and nothing was written.",
      issues: null,
      receipt: null,
    };
  }

  const receipt = receiptFrom(result.check, {
    payeeId: result.saved?.payeeId ?? null,
    verificationId: result.saved?.verificationId ?? null,
    created: result.saved?.created ?? false,
    displayName: fields.displayName,
    holderName: fields.holderName,
    rail: fields.rail,
    accountNumberLast4: fields.accountNumberLast4,
    routingNumberAsTyped: fields.routingNumber,
    checkedByName: actor.displayName,
  });

  revalidatePath("/payees");
  revalidatePath("/payments");

  // BLOCKED. The candidate is not a payee and never was; what exists is a
  // `payee_candidate_refusal` row, which is the caught typo and the product of
  // this feature. The panel that renders this has NO continue control in the
  // blocked branch — not disabled, absent.
  if (result.saved === null) {
    const refusal = result.refusal;
    log.warn("payees.refused", { actorId: actor.id, code: refusal?.code ?? "PAYEE_REFUSED" });
    return {
      status: "refused",
      code: refusal?.code ?? "PAYEE_REFUSED",
      message:
        refusal?.message ??
        "The candidate was refused and no payee was written. The attempt is on the book as a " +
          "refusal row, which is where a caught typo lives.",
      issues: null,
      receipt,
    };
  }

  log.info("payees.checked", {
    actorId: actor.id,
    payeeId: result.saved.payeeId,
    outcome: result.saved.outcome,
    created: result.saved.created,
  });

  return {
    status: "checked",
    code: result.check.decision.toUpperCase(),
    message: result.saved.created
      ? CHECKED_AND_WRITTEN
      : "This source reference had already been keyed, so the payee key matched an existing " +
        "beneficiary and NO SECOND PAYEE WAS WRITTEN — the unique index decided that, not an " +
        "`if`. Today's check WAS appended, because re-checking an existing payee is the normal " +
        "thing to do and refusing to record it would be backwards.",
    issues: null,
    receipt,
  };
}

const CHECKED_AND_WRITTEN =
  "The payee is on the book and this check is a row on it. NO MONEY HAS MOVED and no journal " +
  "entry exists — a payee is not a payment, and nothing in this feature writes a journal line. " +
  "The row is append-only: a later check appends a second row rather than editing this one, " +
  "which is what makes \"verified in March\" and \"verified today\" different facts.";

/* -------------------------------------------------------------------------- */
/* 2 · Re-check a payee already on the book                                   */
/* -------------------------------------------------------------------------- */

const recheckSchema = z.object({
  payeeId: z.uuid({ error: "which payee" }),
});

/**
 * Run the legs again and append the answer.
 *
 * NOTHING ABOUT THE BENEFICIARY IS RE-ENTERED. The details come out of the row
 * — see `recheckPayee()` — because re-keying them to re-check them would make
 * a re-check an opportunity to change them, and "the same details, checked
 * again today" has to be a sentence this system can mean.
 */
export async function recheckPayeeAction(
  _previous: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  const parsed = recheckSchema.safeParse({ payeeId: formData.get("payeeId") ?? "" });
  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "That is not a payee id, so nothing was read and nothing was written.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(form)",
        message: issue.message,
      })),
      receipt: null,
    };
  }

  const actor = await currentActor();
  if (actor === null) {
    return { status: "refused", code: "NO_ACTOR", message: NO_ACTOR, issues: null, receipt: null };
  }

  const { directory, identity } = providers();
  const result = await recheckPayee({
    payeeId: parsed.data.payeeId,
    actorId: actor.id,
    directory,
    identity,
  });

  const log = rootLogger.child({ screen: "payees" });

  if (result.check === null) {
    const refusal = result.refusal;
    log.warn("payees.recheck_refused", {
      actorId: actor.id,
      payeeId: parsed.data.payeeId,
      code: refusal?.code ?? "PAYEE_BOOK_UNREADABLE",
    });
    return {
      status: "refused",
      code: refusal?.code ?? "PAYEE_BOOK_UNREADABLE",
      message: refusal?.message ?? "The payee could not be re-checked and nothing was written.",
      issues: null,
      receipt: null,
    };
  }

  const payee = result.payee;
  const receipt = receiptFrom(result.check, {
    payeeId: payee?.payeeId ?? null,
    verificationId: result.verificationId,
    created: false,
    displayName: payee?.displayName ?? "",
    holderName: payee?.holderName ?? "",
    rail: payee?.rail ?? "",
    accountNumberLast4: payee?.accountNumberLast4 ?? null,
    routingNumberAsTyped: payee?.routingNumber ?? "",
    checkedByName: actor.displayName,
  });

  if (result.refusal !== null) {
    return {
      status: "refused",
      code: result.refusal.code,
      message: result.refusal.message,
      issues: null,
      receipt,
    };
  }

  revalidatePath("/payees");
  revalidatePath("/payments");

  log.info("payees.rechecked", {
    actorId: actor.id,
    payeeId: parsed.data.payeeId,
    outcome: result.check.decision,
    verificationId: result.verificationId,
  });

  return {
    status: "checked",
    code: result.check.decision.toUpperCase(),
    message:
      "Checked again, and today's answer is a NEW ROW rather than an edit of the old one. The " +
      "previous check is still on the book exactly as it was recorded; the book's standing is " +
      "derived from the newest one, and its age is derived from when it ran. There is no " +
      "`is_verified` column to re-stamp, which is why this had to be a row.",
    issues: null,
    receipt,
  };
}

/* -------------------------------------------------------------------------- */
/* 3 · Sign for a warning                                                     */
/* -------------------------------------------------------------------------- */

const signSchema = z.object({
  verificationId: z.uuid({ error: "which check" }),
  reason: z.string().trim().min(1, { error: "say why this is right to pay" }).max(2000),
});

/**
 * Record a signature against one check.
 *
 * WHAT IT IS NOT: an exception, an override flag, or permission. The payment
 * gate refuses a payee whose standing warning nobody has signed for, and that
 * refusal is not a block on the warning — the warning is overridable by
 * anybody, at any time, in one step. It is a refusal to let the override be
 * IMPLICIT. This is the one step.
 *
 * WHAT IT NAMES: the findings it answers, by code and by title, composed into
 * the stored sentence. Acknowledging "a warning" and acknowledging "this
 * beneficiary is at a different bank from the one on your book" are different
 * acts, and six months from now only the second one is readable.
 *
 * The set of codes is posted by the form and then RE-READ from the check
 * before anything is written; a mismatch is `PAYEE_WARNING_MOVED`. See
 * `src/lib/payees/acknowledge.ts`.
 */
export async function signWarningAction(
  _previous: SignResult,
  formData: FormData,
): Promise<SignResult> {
  const parsed = signSchema.safeParse({
    verificationId: formData.get("verificationId") ?? "",
    reason: formData.get("reason") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message:
        parsed.error.issues.map((issue) => issue.message).join("; ") ||
        "The form could not be read, so nothing was written.",
      signature: null,
    };
  }

  // Every ticked finding, as the form displayed them. A CLAIM about what was
  // on screen — re-read and compared before a row exists.
  const codes = formData
    .getAll("code")
    .filter((value): value is string => typeof value === "string");

  const actor = await currentActor();
  if (actor === null) {
    return { status: "refused", code: "NO_ACTOR", message: NO_ACTOR, signature: null };
  }

  const result = await signWarning({
    verificationId: parsed.data.verificationId,
    actorId: actor.id,
    reason: parsed.data.reason,
    codes,
  });

  const log = rootLogger.child({ screen: "payees" });

  if (!result.ok) {
    log.warn("payees.acknowledgement_refused", { actorId: actor.id, code: result.error.code });
    return {
      status: "refused",
      code: result.error.code,
      message: result.error.message,
      signature: null,
    };
  }

  revalidatePath("/payees");
  revalidatePath("/payments");

  log.info("payees.acknowledged", {
    actorId: actor.id,
    payeeId: result.value.payeeId,
    verificationId: result.value.verificationId,
    acknowledgementId: result.value.acknowledgementId,
  });

  return {
    status: "signed",
    code: "PAYEE_WARNING_ACKNOWLEDGED",
    message:
      "Signed. The row names you, the instant and the findings you answered, and it is attached " +
      "to THIS check rather than to the payee — a later check raises a new warning and needs a " +
      "new signature. It cannot be edited or withdrawn: `payee_acknowledgement` is append-only " +
      "by grant, by REVOKE and by trigger, which is what makes \"we let it through\" answerable " +
      "afterwards. A payment to this beneficiary will now pass the payee gate.",
    signature: {
      acknowledgementId: result.value.acknowledgementId,
      verificationId: result.value.verificationId,
      payeeId: result.value.payeeId,
      holderName: result.value.holderName,
      displayName: result.value.displayName,
      reason: result.value.reason,
      findings: result.value.findings,
      signedByName: actor.displayName,
    },
  };
}
