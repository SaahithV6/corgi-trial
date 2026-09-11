"use server";

/**
 * The team console's write path.
 *
 * ============================================================================
 * WHAT THESE ACTIONS DO AND DO NOT DO
 *
 * They change who is on a team, what those people may do, and what their cards
 * may spend. Not one statement below posts money. There is no `postEntry()`, no
 * `ledger_append()`, no journal table and no hold table anywhere on this path.
 *
 * `issueMemberCardAction` calls a PROVIDER: it creates a real card on Lithic
 * through `createCard()` — the same function `/accounts` uses, with the same
 * rate limiter and the same idempotency key — binds it to the customer through
 * `registerCard()`, and writes the one row that says whose it is.
 * `endMembershipAction` calls the provider too: `PATCH /v1/cards/{token}`.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT
 *
 * Next's own guidance: the route is reachable to anyone who can send the same
 * POST, so treat every action as an untrusted entry point. Three consequences
 * are honoured throughout, the same three `/accounts/actions.ts` honours:
 *
 *   - EVERY FIELD IS A CLAIM. `businessId` and `memberId` are references and
 *     nothing else; the member's business, state and name are re-read inside
 *     the action. A caller who posts a member id belonging to another customer
 *     is refused by the ownership check — and then refused AGAIN by
 *     `assert_card_member()` and by the triggers in 0033, which is the layer
 *     that actually holds.
 *   - EVERY ACTION REQUIRES A RESOLVABLE ACTOR. Demo identity rather than
 *     authentication (see `@/lib/approvals/session`), but "create a real card
 *     on our Lithic account" and "revoke somebody's access" are not things an
 *     anonymous POST should be able to do.
 *   - THE AUTHORISATION IS IN THE DATABASE, NOT HERE. Whether the actor may
 *     administer this team is decided by `team_add_member()` and by
 *     `assert_team_member_version()`. This file does not check it, deliberately:
 *     a check here would be a second copy of the rule, and the copy in the
 *     screen is the one that gets forgotten.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import { rootLogger } from "@/lib/log";
import { endMembership, issueCardToMember, reinstateMember } from "@/lib/team/lifecycle";
import { MEMBER_STATES, TEAM_ROLES } from "@/lib/team/roles";
import { addMember, setMemberTerms, readMember } from "@/lib/team/store";

import { assertOperatorAction } from "@/lib/authz/action-guard";

// The shape and its idle value live in a PLAIN module, not here. A
// `"use server"` file may only export async functions: every other export
// becomes a server reference, so a client importing `TEAM_IDLE` from this file
// got a callable stub instead of the object and `/team` rendered nothing but
// its skeleton. See `@/components/team/action-result` for the full account.
import type { TeamActionResult } from "@/components/team/action-result";

function fail(code: string, message: string, facts: TeamActionResult["facts"] = []): TeamActionResult {
  return { status: "failed", code, message, facts, at: new Date().toISOString() };
}

function done(code: string, message: string, facts: TeamActionResult["facts"] = []): TeamActionResult {
  return { status: "ok", code, message, facts, at: new Date().toISOString() };
}

async function actor(): Promise<string | null> {
  const session = await currentActor();
  return session?.id ?? null;
}

/**
 * A money limit typed into a form.
 *
 * EMPTY IS `null` AND `0` IS ZERO, and they mean different things all the way
 * down: `null` is "no limit of this kind on this person", `0` is "this person
 * spends nothing". Both are reachable from this form and the database stores
 * both. A single sentinel would collapse them, and the collapse always goes the
 * dangerous way.
 *
 * The parse is on the STRING. `Number` never touches it: `parseUsdAmount`'s
 * argument is characters and its result is `bigint` cents.
 */
function limitCents(raw: FormDataEntryValue | null): bigint | null | "invalid" {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return "invalid";
  const [dollars, fraction = ""] = text.split(".");
  return BigInt(dollars ?? "0") * 100n + BigInt(fraction.padEnd(2, "0"));
}

/* -------------------------------------------------------------------------- */
/* 1. Add a member                                                            */
/* -------------------------------------------------------------------------- */

const addSchema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  displayName: z.string().trim().min(1).max(80),
  email: z.email({ error: "a member needs an email address" }),
  role: z.enum(TEAM_ROLES),
  note: z.string().trim().min(1, { error: "say why this person is being added" }).max(400),
});

export async function addMemberAction(
  _previous: TeamActionResult,
  formData: FormData,
): Promise<TeamActionResult> {
  await assertOperatorAction("addMemberAction");

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
      `That request could not be read, so nobody was added: ${parsed.error.issues[0]?.message ?? "invalid input"}.`,
    );
  }

  const actorId = await actor();
  if (actorId === null) {
    return fail("NO_ACTOR", "No actor could be resolved for this session, so there is nobody to attribute this to and nothing was done.");
  }

  const perTxn = limitCents(formData.get("perTxn"));
  const day = limitCents(formData.get("day"));
  const month = limitCents(formData.get("month"));
  if (perTxn === "invalid" || day === "invalid" || month === "invalid") {
    return fail("INVALID_AMOUNT", "A limit is dollars and cents, or blank for no limit of that kind. Nothing was added.");
  }

  const result = await addMember({
    businessId: parsed.data.businessId,
    displayName: parsed.data.displayName,
    email: parsed.data.email,
    role: parsed.data.role,
    actorId,
    note: parsed.data.note,
    perTxnLimitCents: perTxn,
    dailyLimitCents: day,
    monthlyLimitCents: month,
  });

  if (!result.ok) return fail(result.code, result.message);

  rootLogger.info("team.member_added", {
    businessId: parsed.data.businessId,
    role: parsed.data.role,
  });
  revalidatePath("/team");

  return done(
    "MEMBER_ADDED",
    `${parsed.data.displayName} is on the team as ${parsed.data.role}, with terms version 1. Their principal was created by team_add_member() — a SECURITY DEFINER function, because this application holds SELECT and only SELECT on the actor table and a test asserts that by trying.`,
    [
      { label: "Member", value: result.value, mono: true },
      { label: "Role", value: parsed.data.role },
      {
        label: "May approve payments",
        value: parsed.data.role === "approver" || parsed.data.role === "admin" ? "yes" : "no — and this cannot be granted later, because actor.can_approve is append-only",
      },
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Change somebody's terms                                                 */
/* -------------------------------------------------------------------------- */

const termsSchema = z.object({
  businessId: z.uuid(),
  memberId: z.uuid(),
  role: z.enum(TEAM_ROLES),
  note: z.string().trim().min(1, { error: "say why the terms are changing" }).max(400),
});

/**
 * Write terms version N+1.
 *
 * The state is carried forward rather than taken from the form: changing
 * somebody's limits is not how they get suspended or removed, and a single form
 * that could do either is a form somebody presses by accident.
 */
export async function setTermsAction(
  _previous: TeamActionResult,
  formData: FormData,
): Promise<TeamActionResult> {
  await assertOperatorAction("setTermsAction");

  const parsed = termsSchema.safeParse({
    businessId: formData.get("businessId"),
    memberId: formData.get("memberId"),
    role: formData.get("role"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return fail("INVALID_REQUEST", `That request could not be read: ${parsed.error.issues[0]?.message ?? "invalid input"}.`);
  }

  const actorId = await actor();
  if (actorId === null) return fail("NO_ACTOR", "No actor could be resolved for this session.");

  const member = await readMember(parsed.data.memberId);
  if (member === null) return fail("NO_SUCH_MEMBER", "That member does not exist.");
  if (member.businessId !== parsed.data.businessId) {
    return fail("MEMBER_NOT_OWNED", "That member belongs to a different business. Nothing was changed.");
  }

  const perTxn = limitCents(formData.get("perTxn"));
  const day = limitCents(formData.get("day"));
  const month = limitCents(formData.get("month"));
  if (perTxn === "invalid" || day === "invalid" || month === "invalid") {
    return fail("INVALID_AMOUNT", "A limit is dollars and cents, or blank for no limit of that kind. Nothing was changed.");
  }

  const result = await setMemberTerms({
    memberId: parsed.data.memberId,
    draft: {
      state: member.terms.state,
      role: parsed.data.role,
      perTxnLimitCents: perTxn,
      dailyLimitCents: day,
      monthlyLimitCents: month,
      note: parsed.data.note,
    },
    actorId,
  });

  if (!result.ok) return fail(result.code, result.message);
  revalidatePath("/team");

  return done(
    "TERMS_WRITTEN",
    `Version ${result.value.version} of ${member.displayName}'s terms. Version ${result.value.version - 1} still says exactly what it said, and any authorisation judged under it still cites it.`,
    [
      { label: "Terms version", value: String(result.value.version) },
      { label: "Effective from", value: result.value.effectiveFrom, mono: true },
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Suspend, remove, reinstate                                              */
/* -------------------------------------------------------------------------- */

const endSchema = z.object({
  businessId: z.uuid(),
  memberId: z.uuid(),
  state: z.enum(MEMBER_STATES),
  note: z.string().trim().min(1, { error: "say why" }).max(400),
  /**
   * The member's own display name, typed by hand, and required only to remove.
   *
   * The form disables its button until this matches, but a server action is a
   * public POST endpoint and a disabled button enforces nothing, so the match
   * is re-checked HERE against the name re-read from the database — not against
   * anything else the same request supplied. Absent for suspend and reinstate,
   * which are both reversible at both ends.
   */
  confirmName: z.string().max(80).optional(),
});

export async function endMembershipAction(
  _previous: TeamActionResult,
  formData: FormData,
): Promise<TeamActionResult> {
  await assertOperatorAction("endMembershipAction");

  const parsed = endSchema.safeParse({
    businessId: formData.get("businessId"),
    memberId: formData.get("memberId"),
    state: formData.get("state"),
    note: formData.get("note"),
    confirmName: formData.get("confirmName") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_REQUEST", `That request could not be read: ${parsed.error.issues[0]?.message ?? "invalid input"}.`);
  }

  const actorId = await actor();
  if (actorId === null) return fail("NO_ACTOR", "No actor could be resolved for this session.");

  // Removal is the only terminal state, and it is the only one that asks for a
  // gesture. Checked BEFORE `endMembership()`, because that function's first
  // act is to close the card at the issuer and there is no un-closing it.
  if (parsed.data.state === "removed") {
    const target = await readMember(parsed.data.memberId);
    if (target === null) return fail("NO_SUCH_MEMBER", "That member does not exist, so nobody was removed.");
    if (target.businessId !== parsed.data.businessId) {
      return fail("MEMBER_NOT_OWNED", "That member belongs to a different business. Nobody was removed.");
    }
    if ((parsed.data.confirmName ?? "").trim() !== target.displayName) {
      return fail(
        "REMOVAL_NOT_CONFIRMED",
        `Removal is terminal and was not confirmed, so nobody was removed and no card was touched at the issuer. Type ${target.displayName} — that member's display name, exactly as it is written here — into the confirmation field on /team and press the button again. Suspension is the reversible option and needs no confirmation.`,
        [
          { label: "Member", value: target.displayName },
          { label: "Name to type", value: target.displayName, mono: true },
          { label: "Where", value: "/team → Suspend, remove or reinstate" },
        ],
      );
    }
  }

  if (parsed.data.state === "active") {
    const back = await reinstateMember({
      memberId: parsed.data.memberId,
      businessId: parsed.data.businessId,
      actorId,
      note: parsed.data.note,
    });
    if (!back.ok) return fail(back.code, back.message);
    revalidatePath("/team");
    return done(
      "REINSTATED",
      `${back.value.displayName} is active again, at terms version ${back.value.termsVersion}. Their cards were re-opened at the issuer AFTER the fact was written, which is the mirror of the order a revocation uses: widening waits for certainty, narrowing does not.`,
      back.value.cards.map((c) => ({ label: `card ···· ${c.lastFour ?? "????"}`, value: c.detail })),
    );
  }

  const result = await endMembership({
    memberId: parsed.data.memberId,
    businessId: parsed.data.businessId,
    actorId,
    state: parsed.data.state,
    note: parsed.data.note,
  });
  if (!result.ok) return fail(result.code, result.message);

  const { value } = result;
  const outstanding = value.outstanding.reduce((sum, a) => sum + a.targetHoldCents, 0n);

  rootLogger.info("team.membership_ended", {
    businessId: parsed.data.businessId,
    state: parsed.data.state,
    enforcedAtIssuer: value.enforcedAtIssuer,
    outstandingCount: value.outstanding.length,
  });
  revalidatePath("/team");

  const facts: TeamActionResult["facts"] = [
    { label: "Terms version", value: String(value.termsVersion) },
    ...value.cards.map((c) => ({ label: `card ···· ${c.lastFour ?? "????"}`, value: c.detail })),
    {
      label: "Outstanding authorisations",
      value:
        value.outstanding.length === 0
          ? "none"
          : `${value.outstanding.length}, holding ${outstanding} cents — untouched, and they will still settle`,
    },
  ];

  if (!value.enforcedAtIssuer) {
    return {
      status: "failed",
      code: "NOT_ENFORCED_AT_ISSUER",
      message: `${value.displayName} is ${value.state} in this system and at least one of their cards could NOT be set at Lithic. The revocation is recorded — a revocation must not depend on a third party being reachable — but until the issuer confirms, and while ASA is disenrolled, that card can still authorise. Retry, or close it in the Lithic dashboard.`,
      facts,
      at: new Date().toISOString(),
    };
  }

  return done(
    value.state === "removed" ? "REMOVED" : "SUSPENDED",
    value.state === "removed"
      ? `${value.displayName} is removed at terms version ${value.termsVersion} and their cards are CLOSED at Lithic. Nothing of theirs was deleted: their membership, their cards, their authorisations, their holds and every journal entry they caused all stand. ${value.outstanding.length === 0 ? "They had no outstanding authorisation." : "The authorisations below were outstanding at that instant and are completely untouched — the merchant has not claimed that money yet and will, days later, for a different amount."}`
      : `${value.displayName} is suspended at terms version ${value.termsVersion} and their cards are PAUSED at Lithic. Reversible, at both ends.`,
    facts,
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Issue a card to a member                                                */
/* -------------------------------------------------------------------------- */

const issueSchema = z.object({
  businessId: z.uuid(),
  memberId: z.uuid(),
  /** Generated once per render; becomes Lithic's own `Idempotency-Key`. */
  formKey: z.uuid({ error: "the form did not carry a usable idempotency key" }),
});

/**
 * Create a real card on Lithic and give it to a person.
 *
 * ONLY FROM AN EXPLICIT PRESS. There is no path from rendering `/team` to this
 * function; a page that issued a card on render would put one real card per
 * page load on the Lithic account.
 */
export async function issueMemberCardAction(
  _previous: TeamActionResult,
  formData: FormData,
): Promise<TeamActionResult> {
  await assertOperatorAction("issueMemberCardAction");

  const parsed = issueSchema.safeParse({
    businessId: formData.get("businessId"),
    memberId: formData.get("memberId"),
    formKey: formData.get("formKey"),
  });
  if (!parsed.success) {
    return fail("INVALID_REQUEST", "That request could not be read, so no card was created. Reload and try again.");
  }

  const actorId = await actor();
  if (actorId === null) return fail("NO_ACTOR", "No actor could be resolved for this session, so no card was created.");

  const issued = await issueCardToMember({
    businessId: parsed.data.businessId,
    memberId: parsed.data.memberId,
    actorId,
    formKey: parsed.data.formKey,
  });
  if (!issued.ok) return fail(issued.code, issued.message);

  rootLogger.info("team.card_issued", {
    businessId: parsed.data.businessId,
    cardToken: issued.value.providerCardToken,
  });
  revalidatePath("/team");

  return done(
    "CARD_ISSUED",
    `A real card on a real card program, created through the same Lithic path /accounts uses, and bound to ${issued.value.displayName}. Its authorisations post to this customer's 2100 and hold against their 9100 — and they are now attributable to a person, not only to a card token.`,
    [
      { label: "Lithic card token", value: issued.value.providerCardToken, mono: true },
      { label: "Last four", value: issued.value.lastFour, mono: true },
      { label: "Expires", value: `${issued.value.expMonth}/${issued.value.expYear}`, mono: true },
      { label: "State at the issuer", value: issued.value.providerState },
      { label: "Provider backstop", value: "$5,000.00 per transaction, enforced by Lithic" },
    ],
  );
}
