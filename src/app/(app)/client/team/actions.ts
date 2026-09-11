"use server";

/**
 * The customer's own team, written by the customer.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * The brief's FIRST SENTENCE: "Customers hold a balance, send and receive
 * payments, and get a card for each person on the team." Until this file, the
 * last clause was operator-only — a business owner could not add somebody to
 * their own team or issue them a card, and a member of bank staff had to do it
 * on their behalf. That polarity is backwards in the same way `/pots` was: the
 * bank needs to SEE the team, not to be the only party who can change it.
 *
 * ===========================================================================
 * ONE WRITER, TWO SURFACES
 * ===========================================================================
 *
 * Every write below goes through `@/lib/team/**` — `addMember()`,
 * `setMemberTerms()`, `endMembership()`, `reinstateMember()` and
 * `issueCardToMember()`. These are the same functions `/team` calls, reached
 * through the library rather than through the other screen.
 * `src/app/(app)/team/actions.ts` is not imported and is not touched.
 *
 * That matters most for issuance. `issueCardToMember()` creates the card
 * through `createCard()` — the same Lithic path, rate limiter and idempotency
 * key `/accounts` uses — binds it with `registerCard()`, and then calls
 * `applyDefaultControls()`, so a card issued from this screen arrives with a
 * control version exactly like one issued from the operator's: active, $5,000.00
 * per transaction, no daily cap, no monthly cap, no blocked MCCs. A second
 * issuing path that forgot the controls would be a card with no controls row,
 * and the authorisation decision would have nothing to consult.
 *
 * ===========================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT
 * ===========================================================================
 *
 * Next's own guidance, and this file assumes it throughout. Three consequences:
 *
 *   - EVERY FIELD IS A CLAIM. `businessId` and `memberId` are references and
 *     nothing else. The member's business, state and display name are re-read
 *     inside the action, by a predicate over both columns (`ownedMember()`), and
 *     then refused AGAIN by `assert_card_member()` and by the triggers in 0033,
 *     0044, 0062 and 0064 — the layer that actually holds.
 *   - A DISABLED BUTTON ENFORCES NOTHING. The removal confirmation is checked
 *     here, against the name this action re-read from the database, not against
 *     anything else the same request supplied.
 *   - NO OPERATOR GUARD, DELIBERATELY. `assertOperatorAction()` is on the
 *     thirty-seven actions that must NOT be reachable from a customer session.
 *     These four are the customer's own, on the customer's own surface, scoped
 *     to one business by predicate. `action-reachability.test.ts` recognises
 *     `@/app/(app)/client/**` as exactly that surface.
 *
 * ===========================================================================
 * WHO IS ACTING, AND WHY NOT STAFF
 * ===========================================================================
 *
 * `resolveActingAdmin()`. The full argument is in
 * `@/components/client/team/contract`: attributing a customer's team change to
 * the staff actor from the role cookie would take the UNGATED authorship branch
 * of `team_add_member()` on the one screen whose whole subject is who may do
 * what. The customer acts as their own active admin, so the gated branch runs.
 *
 * ===========================================================================
 * AND THEY MAY NOT ACT ON THEMSELVES
 * ===========================================================================
 *
 * `ACTING_RULE`. The database already refuses the widest escalation — a role
 * carrying `approve_payment` cannot be written for an actor whose append-only
 * `can_approve` is false, and `assert_team_member_version()` raises 42501 on
 * the attempt. What it does NOT refuse is an admin quietly raising their own
 * spend limits, or removing the only other admin and then themselves. So the
 * self-edit is refused here, by member id, after re-reading who is acting.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ACTING_RULE } from "@/components/client/team/contract";
import type {
  ClientTeamFact,
  ClientTeamResult,
} from "@/components/client/team/action-result";
import { formatUsd } from "@/lib/format/money";
import { sql } from "@/lib/ledger/db";
import { rootLogger } from "@/lib/log";
import { endMembership, issueCardToMember, reinstateMember } from "@/lib/team/lifecycle";
import { TEAM_ROLES } from "@/lib/team/roles";
import {
  addMember,
  setMemberTerms,
  TERMS_PREDATE_APPROVAL_CODE,
} from "@/lib/team/store";

import { ownedMember, resolveActingAdmin, type OwnedMember } from "./acting";

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

function done(code: string, message: string, facts: readonly ClientTeamFact[] = []): ClientTeamResult {
  return { status: "ok", code, message, facts, at: new Date().toISOString() };
}

function fail(code: string, message: string, facts: readonly ClientTeamFact[] = []): ClientTeamResult {
  return { status: "failed", code, message, facts, at: new Date().toISOString() };
}

/**
 * A refusal from the database, as a sentence.
 *
 * The library already hands back the plpgsql RAISE verbatim, and that sentence
 * is the useful half — "actor X administers the team actor Y belongs to…" is
 * what a person needs. What it does not carry is what to DO, and two of these
 * are actionable in different ways, so the code gets a lead sentence and the
 * database's own words follow it. A five-character SQLSTATE on a customer
 * screen is not an explanation of anything.
 */
function refusalSentence(code: string, message: string): string {
  switch (code) {
    case TERMS_PREDATE_APPROVAL_CODE:
      return (
        "That change is refused because it would reach backwards. This person has already approved a payment, " +
        "and a new version of their terms is stamped at the moment it is written — so recording this would make " +
        "an approval that was valid when it was made look as though it never had the right behind it, on a book " +
        "that cannot take an entry back out. Migration 0064 refuses the write at COMMIT. Nothing changed and no " +
        `card was touched. The database's own words: ${message}`
      );
    case "42501":
      return (
        "The database refused this, and its refusal is the authority rather than this screen's opinion of it. " +
        `Nothing changed. ${message}`
      );
    case "55P03":
    case "40P01":
      return (
        "Somebody else is changing this team right now, and team writes take a row lock so that a person's terms " +
        "cannot move underneath an approval being decided in another transaction (migration 0062). Nothing " +
        `changed. Reload and try again. ${message}`
      );
    case "VERSION_RACE":
      return `${message} Nothing of yours was lost — the other change landed first and this one was not applied on top of a version it had not seen.`;
    default:
      return message;
  }
}

function refused(code: string, message: string, facts: readonly ClientTeamFact[] = []): ClientTeamResult {
  return fail(code, refusalSentence(code, message), facts);
}

/* -------------------------------------------------------------------------- */
/* Reading what somebody typed                                                */
/* -------------------------------------------------------------------------- */

/**
 * A money limit typed into a form.
 *
 * EMPTY IS `null` AND `0` IS ZERO. `null` is "no limit of this kind on this
 * person"; `0` is "this person spends nothing". Both are reachable from this
 * form, the database stores both, and they must never collapse into one another
 * — the collapse always goes the dangerous way.
 *
 * The parse is on the STRING. `Number` never touches it: the argument is
 * characters and the result is `bigint` integer minor units.
 */
function limitCents(raw: FormDataEntryValue | null): bigint | null | "invalid" {
  const text =
    typeof raw === "string" ? raw.trim().replace(/^\$/, "").replace(/,/g, "") : "";
  if (text === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return "invalid";
  const [dollars = "0", fraction = ""] = text.split(".");
  return BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, "0"));
}

const BAD_AMOUNT =
  "A limit is dollars and cents — 250, 250.00, $250 — or blank for no limit of that kind. " +
  "Blank and 0 are different: blank means there is no limit of that kind on this person, 0 means they spend nothing. " +
  "Nothing was changed.";

/**
 * The same sentence for a member who is not real and one who is not theirs.
 *
 * Telling them apart would let anybody with the URL confirm which member ids
 * exist on the platform, one POST at a time.
 */
const NOT_YOURS =
  "That person is not on this business's team. The answer is the same for somebody who does not exist and " +
  "somebody who belongs to another customer — telling them apart would let anybody confirm which members are real. " +
  "Nothing was changed.";

const NO_ADMIN =
  "This business has no active administrator, so there is nobody for this screen to act as and nothing was done. " +
  "A business's first admin is created by Corgi at account opening, because a business cannot appoint its own " +
  "first administrator. Ask Corgi to appoint one.";

/** Who is acting, plus the member the form named, both re-read. Or a refusal. */
type Subjects = {
  readonly acting: NonNullable<Awaited<ReturnType<typeof resolveActingAdmin>>>;
  readonly target: OwnedMember;
};

async function subjects(
  businessId: string,
  memberId: string,
): Promise<Subjects | ClientTeamResult> {
  const [acting, target] = await Promise.all([
    resolveActingAdmin(businessId, sql),
    ownedMember(memberId, businessId, sql),
  ]);
  if (acting === null) return fail("NO_ACTING_ADMIN", NO_ADMIN);
  if (target === null) return fail("NOT_YOUR_MEMBER", NOT_YOURS);
  if (target.memberId === acting.memberId) {
    return fail("SELF_ADMINISTRATION", ACTING_RULE);
  }
  return { acting, target };
}

function isRefusal(value: Subjects | ClientTeamResult): value is ClientTeamResult {
  return "status" in value;
}

/* -------------------------------------------------------------------------- */
/* 1. Add somebody to the team                                                */
/* -------------------------------------------------------------------------- */

const UUID = z.uuid({ error: "that is not an id this screen can use" });

const addSchema = z.object({
  businessId: UUID,
  displayName: z.string().trim().min(1, { error: "a person needs a name" }).max(80),
  email: z.email({ error: "a person needs an email address" }),
  role: z.enum(TEAM_ROLES),
  note: z
    .string()
    .trim()
    .min(1, { error: "say why this person is joining — it goes on the record permanently" })
    .max(400),
});

export async function addTeammateAction(
  _previous: ClientTeamResult,
  formData: FormData,
): Promise<ClientTeamResult> {
  const parsed = addSchema.safeParse({
    businessId: formData.get("businessId"),
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    role: formData.get("role"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return fail(
      "INVALID_REQUEST",
      `That could not be read, so nobody was added: ${parsed.error.issues[0]?.message ?? "invalid input"}.`,
    );
  }

  const acting = await resolveActingAdmin(parsed.data.businessId, sql);
  if (acting === null) return fail("NO_ACTING_ADMIN", NO_ADMIN);

  const perTxn = limitCents(formData.get("perTxn"));
  const day = limitCents(formData.get("day"));
  const month = limitCents(formData.get("month"));
  if (perTxn === "invalid" || day === "invalid" || month === "invalid") {
    return fail("INVALID_AMOUNT", BAD_AMOUNT);
  }

  const result = await addMember(
    {
      businessId: parsed.data.businessId,
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      role: parsed.data.role,
      // Attributed to the customer's own admin, so `team_add_member()` takes
      // its GATED authorship branch. Never a staff actor from a cookie.
      actorId: acting.actorId,
      note: parsed.data.note,
      perTxnLimitCents: perTxn,
      dailyLimitCents: day,
      monthlyLimitCents: month,
    },
    sql,
  );
  if (!result.ok) return refused(result.code, result.message);

  rootLogger.info("client_team.member_added", {
    businessId: parsed.data.businessId,
    role: parsed.data.role,
  });
  revalidatePath("/client/team");

  const approves = parsed.data.role === "approver" || parsed.data.role === "admin";
  return done(
    "MEMBER_ADDED",
    `${parsed.data.displayName} is on your team as ${parsed.data.role}, at terms version 1, added by ${acting.displayName}. ` +
      "They have no card yet — issuing one is a separate, explicit press, because a screen that created a card on " +
      "render would put a real card on a real card program every time somebody reloaded it.",
    [
      { label: "Member", value: result.value, mono: true },
      { label: "Role", value: parsed.data.role },
      { label: "Per transaction", value: perTxn === null ? "no limit" : formatUsd(perTxn), mono: true },
      { label: "Per day", value: day === null ? "no limit" : formatUsd(day), mono: true },
      { label: "Per month", value: month === null ? "no limit" : formatUsd(month), mono: true },
      {
        label: "May approve payments",
        value: approves
          ? "yes — decided now, at creation, and never afterwards"
          : "no — and this cannot be granted later: actor.can_approve is append-only",
      },
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Change somebody's role and limits                                       */
/* -------------------------------------------------------------------------- */

const termsSchema = z.object({
  businessId: UUID,
  memberId: UUID,
  role: z.enum(TEAM_ROLES),
  note: z
    .string()
    .trim()
    .min(1, { error: "say why the terms are changing" })
    .max(400),
});

/**
 * Write terms version N+1.
 *
 * NEVER AN UPDATE. `team_member_version` is append-only, so this is a new row,
 * and version N still says exactly what it said — which is what makes an
 * authorisation decided under N still citable. The STATE is carried forward
 * from the row this action re-read, not taken from the form: changing somebody's
 * limits is not how they get suspended or removed, and one form that could do
 * either is a form somebody presses by accident.
 */
export async function setTeammateTermsAction(
  _previous: ClientTeamResult,
  formData: FormData,
): Promise<ClientTeamResult> {
  const parsed = termsSchema.safeParse({
    businessId: formData.get("businessId"),
    memberId: formData.get("memberId"),
    role: formData.get("role"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return fail(
      "INVALID_REQUEST",
      `That could not be read, so nothing was changed: ${parsed.error.issues[0]?.message ?? "invalid input"}.`,
    );
  }

  const found = await subjects(parsed.data.businessId, parsed.data.memberId);
  if (isRefusal(found)) return found;
  const { acting, target } = found;

  const perTxn = limitCents(formData.get("perTxn"));
  const day = limitCents(formData.get("day"));
  const month = limitCents(formData.get("month"));
  if (perTxn === "invalid" || day === "invalid" || month === "invalid") {
    return fail("INVALID_AMOUNT", BAD_AMOUNT);
  }

  // Said here as a sentence rather than left to a 42501, because this is the
  // one people try. The trigger still refuses it if this branch is ever removed.
  const wantsApproval = parsed.data.role === "approver" || parsed.data.role === "admin";
  if (wantsApproval && !target.actorCanApprove) {
    return fail(
      "APPROVAL_NOT_IN_ENVELOPE",
      `${target.displayName} was created without approval rights, and that is decided once, when a person is added, ` +
        "because actor rows are append-only. They cannot become an approver or an admin now — the database refuses " +
        "the write (assert_team_member_version, 0033). To give somebody approval rights, remove them and add them " +
        "again as an approver: that is a new membership with a new principal, and the old one's history stands. " +
        "Nothing was changed.",
    );
  }

  const result = await setMemberTerms(
    {
      memberId: target.memberId,
      draft: {
        state: target.state,
        role: parsed.data.role,
        perTxnLimitCents: perTxn,
        dailyLimitCents: day,
        monthlyLimitCents: month,
        note: parsed.data.note,
      },
      actorId: acting.actorId,
    },
    sql,
  );
  if (!result.ok) return refused(result.code, result.message);

  rootLogger.info("client_team.terms_written", {
    businessId: parsed.data.businessId,
    version: result.value.version,
  });
  revalidatePath("/client/team");

  return done(
    "TERMS_WRITTEN",
    `Version ${result.value.version} of ${target.displayName}'s terms, written by ${acting.displayName}. ` +
      `Version ${result.value.version - 1} still says exactly what it said, and any purchase judged under it still cites it — ` +
      "this is an append, not an edit. Their personal limits sit ON TOP OF their card's own: both are checked, in that order, " +
      "in the same authorisation decision.",
    [
      { label: "Terms version", value: String(result.value.version), mono: true },
      { label: "Effective from", value: result.value.effectiveFrom, mono: true },
      { label: "Role", value: parsed.data.role },
      { label: "Per transaction", value: perTxn === null ? "no limit" : formatUsd(perTxn), mono: true },
      { label: "Per day", value: day === null ? "no limit" : formatUsd(day), mono: true },
      { label: "Per month", value: month === null ? "no limit" : formatUsd(month), mono: true },
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Suspend, remove, bring back                                             */
/* -------------------------------------------------------------------------- */

const endSchema = z.object({
  businessId: UUID,
  memberId: UUID,
  state: z.enum(["active", "suspended", "removed"]),
  note: z.string().trim().min(1, { error: "say why" }).max(400),
  /**
   * The member's own display name, typed by hand, required only to remove.
   *
   * The hazard is the RIGHT BUTTON ON THE WRONG ROW, so the gesture is the name
   * of the person being removed rather than a fixed word like DELETE: typing
   * "DELETE" proves you meant to remove somebody, typing "Theo Marchetti"
   * proves you meant to remove Theo. The form disables its button until the
   * typed name matches, and that enforces NOTHING — a server action is a public
   * POST endpoint. So the match is re-checked below against the name this
   * action re-read from the database, never against a name the same request
   * also supplied.
   *
   * Absent for suspend and for bringing somebody back, both reversible at both
   * ends.
   */
  confirmName: z.string().max(80).optional(),
});

export async function endTeammateAction(
  _previous: ClientTeamResult,
  formData: FormData,
): Promise<ClientTeamResult> {
  const parsed = endSchema.safeParse({
    businessId: formData.get("businessId"),
    memberId: formData.get("memberId"),
    state: formData.get("state"),
    note: formData.get("note"),
    confirmName: formData.get("confirmName") ?? undefined,
  });
  if (!parsed.success) {
    return fail(
      "INVALID_REQUEST",
      `That could not be read, so nothing was changed and no card was touched: ${parsed.error.issues[0]?.message ?? "invalid input"}.`,
    );
  }

  const found = await subjects(parsed.data.businessId, parsed.data.memberId);
  if (isRefusal(found)) return found;
  const { acting, target } = found;

  // Checked BEFORE the library is called, because `endMembership()`'s FIRST act
  // is to close the card at Lithic and there is no un-closing it.
  if (parsed.data.state === "removed") {
    if ((parsed.data.confirmName ?? "").trim() !== target.displayName) {
      return fail(
        "REMOVAL_NOT_CONFIRMED",
        "Removing somebody is terminal and it was not confirmed, so nobody was removed and no card was touched at " +
          `the issuer. Type ${target.displayName} — that person's name, exactly as it is written here — into the ` +
          "confirmation field and press the button again. The name is asked for instead of a fixed word so that the " +
          "person you type is the person you selected. Suspending is the reversible option and needs no confirmation.",
        [
          { label: "Person", value: target.displayName },
          { label: "Name to type", value: target.displayName, mono: true },
        ],
      );
    }
  }

  if (parsed.data.state === "active") {
    const back = await reinstateMember(
      {
        memberId: target.memberId,
        businessId: parsed.data.businessId,
        actorId: acting.actorId,
        note: parsed.data.note,
      },
      sql,
    );
    if (!back.ok) return refused(back.code, back.message);
    revalidatePath("/client/team");
    return done(
      "REINSTATED",
      `${back.value.displayName} is active again, at terms version ${back.value.termsVersion}. Their cards were ` +
        "re-opened at the issuer AFTER the fact was written, which is the mirror of the order a suspension uses: " +
        "widening waits for certainty, narrowing does not.",
      back.value.cards.map((c) => ({ label: `card ···· ${c.lastFour ?? "????"}`, value: c.detail })),
    );
  }

  const result = await endMembership(
    {
      memberId: target.memberId,
      businessId: parsed.data.businessId,
      actorId: acting.actorId,
      state: parsed.data.state,
      note: parsed.data.note,
    },
    sql,
  );
  if (!result.ok) return refused(result.code, result.message);

  const { value } = result;
  const heldCents = value.outstanding.reduce((sum, a) => sum + a.targetHoldCents, 0n);

  rootLogger.info("client_team.membership_ended", {
    businessId: parsed.data.businessId,
    state: parsed.data.state,
    enforcedAtIssuer: value.enforcedAtIssuer,
    outstandingCount: value.outstanding.length,
  });
  revalidatePath("/client/team");

  const facts: readonly ClientTeamFact[] = [
    { label: "Terms version", value: String(value.termsVersion), mono: true },
    ...value.cards.map((c) => ({ label: `card ···· ${c.lastFour ?? "????"}`, value: c.detail })),
    {
      label: "Still in flight",
      value:
        value.outstanding.length === 0
          ? "nothing"
          : `${value.outstanding.length} authorisation${value.outstanding.length === 1 ? "" : "s"}, holding ${formatUsd(heldCents)} — untouched, and they will still settle`,
      mono: true,
    },
  ];

  if (!value.enforcedAtIssuer) {
    return fail(
      "NOT_ENFORCED_AT_ISSUER",
      `${value.displayName} is ${value.state} on your team and at least one of their cards could NOT be set at the ` +
        "issuer. The change is recorded — taking somebody's access away must not depend on a third party being " +
        "reachable — but until the issuer confirms, that card can still authorise. Try again, and tell Corgi if it " +
        "keeps failing.",
      facts,
    );
  }

  return done(
    value.state === "removed" ? "REMOVED" : "SUSPENDED",
    value.state === "removed"
      ? `${value.displayName} is removed at terms version ${value.termsVersion} and their cards are CLOSED at the issuer. ` +
          "Nothing of theirs was deleted: their membership, their cards, their purchases and every entry they caused all " +
          "stand, because that is the only way to answer “who spent this” later. " +
          (value.outstanding.length === 0
            ? "They had nothing outstanding."
            : "The authorisations below were in flight at that instant and are completely untouched — the merchant has not " +
              "claimed that money yet and will, days later, possibly for a different amount.")
      : `${value.displayName} is suspended at terms version ${value.termsVersion} and their cards are PAUSED at the issuer. ` +
          "Reversible, at both ends: a later version of their terms turns it back on.",
    facts,
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Give somebody a card                                                    */
/* -------------------------------------------------------------------------- */

const issueSchema = z.object({
  businessId: UUID,
  memberId: UUID,
  /** Generated once per render; becomes Lithic's own `Idempotency-Key`. */
  formKey: z.uuid({ error: "the form did not carry a usable idempotency key" }),
});

/**
 * Create a real card on a real card program and give it to a person.
 *
 * ONLY FROM AN EXPLICIT PRESS. There is no path from rendering `/client/team`
 * to this function; a page that issued on render would put one real card on the
 * Lithic account per page load. The `formKey` is Lithic's own idempotency key,
 * so a double-click or a refresh-resubmit returns the SAME card rather than
 * creating a second one.
 */
export async function issueTeammateCardAction(
  _previous: ClientTeamResult,
  formData: FormData,
): Promise<ClientTeamResult> {
  const parsed = issueSchema.safeParse({
    businessId: formData.get("businessId"),
    memberId: formData.get("memberId"),
    formKey: formData.get("formKey"),
  });
  if (!parsed.success) {
    return fail(
      "INVALID_REQUEST",
      "That could not be read, so no card was created and nothing was sent to the issuer. Reload and try again.",
    );
  }

  // Ownership re-checked HERE, before a provider call that costs a real card.
  // `issueCardToMember()` checks it again against its own read, and
  // `assert_card_member()` checks it a third time in the database.
  const [acting, target] = await Promise.all([
    resolveActingAdmin(parsed.data.businessId, sql),
    ownedMember(parsed.data.memberId, parsed.data.businessId, sql),
  ]);
  if (acting === null) return fail("NO_ACTING_ADMIN", NO_ADMIN);
  if (target === null) return fail("NOT_YOUR_MEMBER", NOT_YOURS);

  const issued = await issueCardToMember(
    {
      businessId: parsed.data.businessId,
      memberId: target.memberId,
      actorId: acting.actorId,
      formKey: parsed.data.formKey,
    },
    sql,
  );
  if (!issued.ok) return refused(issued.code, issued.message);

  rootLogger.info("client_team.card_issued", {
    businessId: parsed.data.businessId,
    cardToken: issued.value.providerCardToken,
  });
  revalidatePath("/client/team");

  return done(
    "CARD_ISSUED",
    `${issued.value.displayName} has a card. It is real, on the same card program and through the same issuing path ` +
      "the rest of this bank uses, and it arrived with its controls already set — active, $5,000.00 per transaction, " +
      "no daily cap, no monthly cap, nothing blocked by merchant category — the same defaults every other card here " +
      "gets. Their personal limits sit on top of those. Everything they buy posts to your account and holds against " +
      "your available balance, and it is now attributable to a person rather than to a card number.",
    [
      { label: "Last four", value: issued.value.lastFour, mono: true },
      { label: "Expires", value: `${issued.value.expMonth}/${issued.value.expYear}`, mono: true },
      { label: "State at the issuer", value: issued.value.providerState },
      { label: "Per transaction, at the issuer", value: formatUsd(5_000_00), mono: true },
    ],
  );
}
