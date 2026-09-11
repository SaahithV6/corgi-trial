"use server";

/**
 * The customer filing a dispute on their own settled card transaction.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 *
 * The brief asks for "dispute intake on a settled card transaction". INTAKE is
 * the person who was charged raising the claim. This build had it entirely
 * operator-side: `/disputes` lets a Corgi operator open a case on a customer's
 * behalf and then decide it, and the customer whose money it was had no way to
 * say anything at all. This action is the missing half.
 *
 * ===========================================================================
 * THIS ACTION MOVES NO MONEY, AND THAT IS THE POINT
 * ===========================================================================
 *
 * It calls exactly one writer — `raiseDispute()` in `@/lib/disputes`, the same
 * function `/disputes`'s own action calls. That function inserts a `dispute`
 * row and one `raised` event inside one transaction and posts NOTHING: no
 * `postEntry`, no hold, no journal line. Read it and count the writes.
 *
 * Provisional credit is a separate transition (`grantProvisionalCredit`), it is
 * gated by `assert_dispute_lifecycle()`, and that trigger demands the
 * authoriser be a HUMAN CORGI APPROVER who is neither the raiser nor anybody
 * belonging to the disputing business. The raiser this action resolves has a
 * `business_id`, so the customer filing here is excluded from authorising their
 * own advance by the database, not by this file remembering to check. A screen
 * that appeared to hand the customer money would be the worst bug available
 * here; the arrangement that prevents it is structural.
 *
 * ===========================================================================
 * THE ENTRY ID IS A CLAIM AND IT IS CHECKED AS A PREDICATE
 * ===========================================================================
 *
 * A transaction id arrives from a form, so it is worth nothing on its own.
 * Before anything is written it is resolved against the business this surface
 * is scoped to with `WHERE e.id = $1 AND a.business_id = $2` — one statement,
 * both columns, evaluated by Postgres. It is never a `.find()` over a list
 * fetched first, for the reason `src/app/(app)/client/cards-actions.ts` gives
 * at length: that would make tenant isolation a step in a program.
 *
 * A charge belonging to another business produces the same refusal as one that
 * does not exist, so this form cannot be used to discover which ids are real.
 *
 * ===========================================================================
 * NOBODY TYPES AN AMOUNT
 * ===========================================================================
 *
 * The claim is the whole amount still outstanding on the charge, and that
 * figure is read off the journal at the moment of the write by the library's
 * own query. There is no amount field on the form, so there is nothing to
 * tamper with, and `assert_dispute_intake()` re-derives the same two sums under
 * an advisory lock and refuses if they disagree.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { CaseFact, FileDisputeResult } from "@/components/client/disputes/file-state";
import {
  DISPUTE_REASONS,
  listReasonCodes,
  raiseDispute,
  readCardCharge,
} from "@/lib/disputes";
import { entryBelongsToBusiness } from "@/lib/ledger/readers";
import { formatUsd } from "@/lib/format/money";
import { sql } from "@/lib/ledger/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same sentence for a charge that is not real and one that is not theirs.
 *
 * Telling them apart would turn this form into an oracle for which journal
 * entries exist on the platform. `readApproveScreen` and the card-controls
 * action both make this choice and both say so.
 */
const NOT_YOURS =
  "That transaction is not on this business. The answer is the same for one that does not exist " +
  "and one belonging to another customer — telling them apart would let anybody confirm which " +
  "transactions are real. Pick a charge from the list on this screen, which is already yours.";

const fileSchema = z.object({
  businessId: z.string().trim().regex(UUID, { error: "which business?" }),
  disputedEntryId: z
    .string()
    .trim()
    .regex(UUID, { error: "choose the transaction you are disputing" }),
  reason: z.enum(DISPUTE_REASONS, { error: "choose what went wrong" }),
  narrative: z
    .string()
    .trim()
    .min(10, { error: "tell us what happened, in your own words — at least a sentence" })
    .max(500, { error: "500 characters at most" }),
});

function refused(
  code: string,
  message: string,
  entryId: string | null,
  facts: readonly CaseFact[] = [],
): FileDisputeResult {
  return {
    status: "refused",
    code,
    message,
    entryId,
    caseRef: null,
    disputeId: null,
    facts,
  };
}

export async function fileDisputeAction(
  _previous: FileDisputeResult,
  formData: FormData,
): Promise<FileDisputeResult> {
  const parsed = fileSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    disputedEntryId: formData.get("disputedEntryId") ?? "",
    reason: formData.get("reason") ?? "",
    narrative: formData.get("narrative") ?? "",
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refused(
      "DISPUTE_FORM_INCOMPLETE",
      `${first?.message ?? "The form could not be read"}. Nothing was written and no case was opened.`,
      null,
    );
  }

  const { businessId, disputedEntryId, reason, narrative } = parsed.data;

  // ---------------------------------------------------------------------
  // 1. Is this charge theirs? One statement, both columns, in Postgres.
  // ---------------------------------------------------------------------
  // Through a named reader in src/lib/ledger/, not inline SQL: the boundary
  // ratchet counts the modules that may touch journal_entry / journal_line /
  // account, and a screen is not one of them. Same predicate, same one
  // statement, both columns — just somewhere it can be found.
  const owned = await entryBelongsToBusiness(disputedEntryId, businessId, sql);
  if (!owned) {
    return refused("CHARGE_NOT_ON_THIS_BUSINESS", NOT_YOURS, null);
  }

  // ---------------------------------------------------------------------
  // 2. No double-filing. A second claim RETURNS THE FIRST CASE.
  //
  // Refusing and returning the existing case are both defensible; returning it
  // is chosen because a customer who clicks twice, or files again a week later
  // because nothing seems to have happened, is asking "what is happening to my
  // claim" and the answer is the case they already have. It is deterministic:
  // `ORDER BY raised_at, dispute_id` takes the EARLIEST standing case, so the
  // same second click always lands on the same case ref rather than whichever
  // row the planner returned first.
  //
  // Scoped on both columns, like every other read here. A withdrawn case is
  // excluded because a withdrawal releases the charge to be claimed again —
  // the same rule `assert_dispute_intake()` applies to `already_claimed_cents`,
  // and disagreeing with it would offer a case ref that no longer stands.
  // ---------------------------------------------------------------------
  const standing = await sql<{ dispute_id: string; case_ref: string; status: string }[]>`
    SELECT s.dispute_id, s.case_ref, s.status
      FROM v_dispute_state s
     WHERE s.disputed_entry_id = ${disputedEntryId}::uuid
       AND s.business_id = ${businessId}::uuid
       AND NOT s.withdrawn
     ORDER BY s.raised_at, s.dispute_id
     LIMIT 1`;
  const existing = standing[0];
  if (existing !== undefined) {
    return {
      status: "already_filed",
      code: "DISPUTE_ALREADY_FILED",
      message:
        `You have already raised a claim on this transaction and it is still open, so nothing ` +
        `new was written. Case ${existing.case_ref} is below on this page, with everything that ` +
        `has happened on it. If that case is wrong, ask us to withdraw it — a withdrawn claim ` +
        `frees the charge to be disputed again.`,
      entryId: disputedEntryId,
      caseRef: existing.case_ref,
      disputeId: existing.dispute_id,
      facts: [
        { label: "Case", value: existing.case_ref, mono: true },
        { label: "Where it is now", value: existing.status.replaceAll("_", " ") },
      ],
    };
  }

  // ---------------------------------------------------------------------
  // 3. Is it a settled card transaction, and how much of it is still unclaimed?
  //
  // Both answers from the library's own query, which is the same query that
  // built the list this form offered — so the form cannot offer a charge the
  // trigger would then refuse. An authorisation, a hold, a provisional credit,
  // a clawback and a write-off all fail to match it and all land here.
  // ---------------------------------------------------------------------
  const charge = await readCardCharge(disputedEntryId, sql);
  if (charge === null) {
    return refused(
      "NOT_A_SETTLED_CARD_TRANSACTION",
      "Only a settled card transaction can be disputed. This one is not: a pending " +
        "authorisation has not taken your money yet and there is nothing to claim back, and a " +
        "transfer, a payment or a credit is not a card purchase and has no card network behind " +
        "it to file with. Wait for the payment to settle — it will appear in the list on this " +
        "screen the moment it does.",
      disputedEntryId,
    );
  }

  const outstandingCents = charge.netChargeCents - charge.alreadyClaimedCents;
  if (charge.netChargeCents <= 0n) {
    return refused(
      "CHARGE_ALREADY_REVERSED",
      "The merchant already took this charge back, so the money is in your account and there " +
        "is nothing left to claim. Check the amount on your activity screen.",
      disputedEntryId,
    );
  }
  if (outstandingCents <= 0n) {
    return refused(
      "NOTHING_LEFT_TO_CLAIM",
      `Every cent of this ${formatUsd(charge.netChargeCents)} charge is already claimed on ` +
        "another case, so a second claim would ask for money twice. The case that holds it is " +
        "listed below.",
      disputedEntryId,
    );
  }

  // ---------------------------------------------------------------------
  // 4. The network's own reason code for the reason the customer picked.
  //
  // The customer is not asked for `visa/10.4`. That is issuer vocabulary and
  // asking a bakery owner to choose between "Other Fraud — Card-Absent
  // Environment" and "No Cardholder Authorisation" is asking them to do our
  // job. They say what went wrong; the code is resolved from the reference
  // table by predicate, taking the first network in name order so the same
  // reason always files under the same code.
  // ---------------------------------------------------------------------
  const codes = await listReasonCodes(sql);
  const matched = codes.find((row) => row.reason === reason);
  if (matched === undefined) {
    return refused(
      "NO_NETWORK_CODE_FOR_REASON",
      `No card network reason code is on file for "${reason}", so this claim could not be ` +
        "filed under one. Seed `dispute_reason_code` with a row for that reason, or pick " +
        "another reason from the list.",
      disputedEntryId,
    );
  }

  // ---------------------------------------------------------------------
  // 5. Who raised it.
  //
  // This build has no customer authentication — `docs/DEMO.md` §1: "There is
  // nothing to sign into" — so the person is resolved by PREDICATE against the
  // team of the business this surface is scoped to, never taken from the form.
  // The earliest human on that team, deterministically. When a session claim
  // replaces the query parameter, this statement is the only line that changes.
  //
  // It matters that this actor has a `business_id`: `assert_dispute_lifecycle()`
  // requires an authoriser with `business_id IS NULL`, so whoever files here is
  // structurally barred from authorising the advance that follows.
  // ---------------------------------------------------------------------
  const raisers = await sql<{ id: string; display_name: string }[]>`
    SELECT a.id, a.display_name
      FROM actor a
     WHERE a.business_id = ${businessId}::uuid
       AND a.kind::text = 'human'
     ORDER BY a.created_at, a.id
     LIMIT 1`;
  const raiser = raisers[0];
  if (raiser === undefined) {
    return refused(
      "NO_CARDHOLDER_ON_FILE",
      "Nobody is recorded on this business's team, so there is no person to attribute the " +
        "claim to and a case with an invented author is worse than no case. Add a team member " +
        "on /team, then file again.",
      disputedEntryId,
    );
  }

  // ---------------------------------------------------------------------
  // 6. Raise it. One library call, shared with the operator surface.
  // ---------------------------------------------------------------------
  const result = await raiseDispute(
    {
      disputedEntryId,
      reason,
      network: matched.network,
      networkCode: matched.networkCode,
      narrative,
      amountCents: outstandingCents,
      actorId: raiser.id,
    },
    sql,
  );

  if (result.kind === "refused") {
    // -------------------------------------------------------------------
    // OVER_CLAIMED is the one refusal whose sentence is written in MINOR
    // UNITS, and a customer must never be shown one.
    //
    // `raiseDispute()` composes "Only 4250 cents of this 9900 cent charge is
    // still unclaimed" because it serves both surfaces and the operator
    // console reads cents. That file is the library and it is not this
    // surface's to edit, so the code is caught HERE — at the boundary where a
    // library answer becomes a sentence for the person whose money it is —
    // and the figures are rendered through `formatUsd` like every other
    // amount on this screen.
    //
    // It is reachable, and only one way: nobody types an amount here, so the
    // claim is the outstanding figure read a few statements above, and the
    // library re-derives the same figure under its own advisory lock. They
    // disagree only when a second claim landed on this charge in between. The
    // figures below therefore come from a FRESH read rather than from the
    // pair that was already stale when the library refused it.
    // -------------------------------------------------------------------
    if (result.code === "OVER_CLAIMED") {
      const nowCharge = await readCardCharge(disputedEntryId, sql);
      const chargeCents = nowCharge?.netChargeCents ?? charge.netChargeCents;
      const leftCents =
        nowCharge === null
          ? 0n
          : nowCharge.netChargeCents - nowCharge.alreadyClaimedCents;
      return refused(
        result.code,
        `Another claim was filed against this charge while this page was open, so there is less ` +
          `left to claim than when the screen was drawn. ${formatUsd(leftCents)} of this ` +
          `${formatUsd(chargeCents)} charge is still unclaimed, and you asked for ` +
          `${formatUsd(outstandingCents)}. Nothing was written and no money moved. Reload this ` +
          `page and file again for what is left.`,
        disputedEntryId,
        [
          { label: "The charge", value: formatUsd(chargeCents) },
          { label: "Still unclaimed", value: formatUsd(leftCents) },
          { label: "You asked to claim", value: formatUsd(outstandingCents) },
          { label: "Money moved", value: "none" },
        ],
      );
    }

    // Carried through with its own code, not flattened. Every one of these has
    // a matching `RAISE EXCEPTION` in `assert_dispute_intake()`; an error the
    // library does not recognise was rethrown before it ever reached here.
    return refused(
      result.code,
      `${result.message} Nothing was written and no money moved.`,
      disputedEntryId,
    );
  }

  revalidatePath("/client/disputes");

  return {
    status: "filed",
    code: null,
    message:
      `Your claim is recorded as case ${result.caseRef}. Nothing has moved in your account and ` +
      `your available balance is unchanged — raising a claim is not a refund. ` +
      (result.needsAuthorization
        ? `Because this is ${formatUsd(result.amountCents)}, at or above the ` +
          `${formatUsd(result.thresholdCents)} card threshold, advancing the money early needs ` +
          `a second Corgi approver to sign it off. Nobody here can grant it to themselves.`
        : `Whether we advance the money while the card network decides is our decision to make, ` +
          `and you will see it on this page either way.`),
    entryId: disputedEntryId,
    caseRef: result.caseRef,
    disputeId: result.disputeId,
    facts: [
      { label: "Case", value: result.caseRef, mono: true },
      { label: "Claimed", value: formatUsd(result.amountCents) },
      { label: "Filed by", value: raiser.display_name },
      { label: "Network code", value: `${matched.network}/${matched.networkCode}`, mono: true },
      { label: "Money moved", value: "none" },
    ],
  };
}
