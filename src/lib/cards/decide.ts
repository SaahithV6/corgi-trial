/**
 * The decision. One pure function, no I/O, no clock, no database.
 *
 * Everything that makes this feature hard lives on either side of this file —
 * the latency budget in `../../app/api/webhooks/lithic-auth/route.ts`, the
 * single round trip in `./store.ts` — and none of it lives here, deliberately.
 * `decide()` takes what was asked and what was read and returns a verdict. It
 * is called by the provider's synchronous webhook, by the local harness, and
 * by 40-odd unit tests, and all three drive exactly the same code.
 *
 * ─── Why it does not touch the ledger ───────────────────────────────────────
 *
 * Lithic holds the authorisation open while we answer. A synchronous decision
 * that writes is a synchronous decision that can block, and a blocked decision
 * is a declined card: at 6000 ms Lithic gives up and declines on our behalf,
 * stamping the transaction `CUSTOMER_ASA_TIMEOUT`. So this path reads controls
 * and recent spend and returns a verdict. Money moves later, on the ordinary
 * asynchronous `card_transaction.updated` webhook, through the same inbox, the
 * same dispatcher and the same consumer it always did.
 *
 * The corollary is that AVAILABLE BALANCE IS NOT CHECKED HERE. It is a fold
 * over `journal_line` — the most expensive read in the system and the one that
 * contends with the append lock. `v_available_balance` is the ledger's answer
 * to "may this money be spent"; card controls are the customer's answer to
 * "may this card spend it", and conflating them would put the journal on the
 * critical path of every authorisation on the program. Lithic enforces its own
 * `spend_limit` per card independently, which is the backstop.
 *
 * ─── The rules, in evaluation order ─────────────────────────────────────────
 *
 * First match wins. `RULE_ORDER` below is the evaluation order and it is a
 * separate constant from `DECISION_RULES` (the display order) so that
 * reordering a table on a screen cannot change what a card is allowed to buy.
 *
 *   1  control_store_unavailable        the read missed its deadline
 *   2  card_not_under_control           this book has never seen the token
 *   3  balance_inquiry_not_a_purchase   status BALANCE_INQUIRY
 *   4  credit_not_a_purchase            status *CREDIT_AUTHORIZATION
 *   5  member_removed                   the holder is off the team
 *   6  member_suspended                 the holder is suspended
 *   7  card_frozen                      the switch is off
 *   8  mcc_blocked                      category on the block list
 *   9  per_transaction_limit_exceeded   the CARD's limits
 *  10  daily_limit_exceeded
 *  11  monthly_limit_exceeded
 *  12  member_per_transaction_limit_exceeded   the PERSON's envelope
 *  13  member_daily_limit_exceeded
 *  14  member_monthly_limit_exceeded
 *  15  no_controls_configured           no card controls AND no member
 *  16  within_controls                  approve
 *
 * ─── TWO SCOPES, ONE DECISION, NO SECOND ROUND TRIP ─────────────────────────
 *
 * Rules 5, 6 and 12 to 14 are about the PERSON holding the card, and they cost
 * nothing this path was not already paying. `readControlsAndSpend()` reads the
 * member, their terms and their spend-to-date in the SAME single statement it
 * already ran for the card, under the SAME 600 ms deadline. There is no second
 * query, no second deadline and no new way to be slow.
 *
 * Which settles the question of what direction the new rules fail in: exactly
 * the direction the old ones already did. If that one statement misses its
 * deadline the lookup is `unavailable` and rule 1 DECLINES — and for a member
 * check that is doubly right, because removing somebody is a REVOCATION, the
 * same class of promise as freezing a card. A revocation that only holds while
 * the database is reachable has not been made.
 *
 * The one deliberate fail-OPEN is unchanged and now has a sibling: a card that
 * belongs to NO member is judged exactly as it was before this feature existed
 * (every card in this book predates it). "We know the answer is no member" and
 * "we do not know the answer" get opposite defaults, the same distinction rule
 * 2 draws for the card itself.
 *
 * ─── Fail closed, and the argument for it ───────────────────────────────────
 *
 * Rule 1 is the one worth arguing about, and both answers are defensible.
 *
 * FAIL OPEN is what most issuers do, and the case is strong: availability is
 * the product, a decline at a fuel pump at midnight is a real harm to a real
 * person, and the customer never asked our database to be reachable. Visa and
 * Mastercard both run stand-in processing for exactly this reason.
 *
 * WE FAIL CLOSED. The reasons, in order:
 *
 *   1. THE FAILURE MODES ARE NOT SYMMETRIC. A wrong decline is recoverable:
 *      the acquirer may retry, the cardholder may use another card, and we
 *      have the row that says why. A wrong approval is not: the money has
 *      moved on a card the customer froze because it was stolen, and the only
 *      remedy left is a dispute we will lose.
 *   2. FREEZE IS THE PROMISE THIS FEATURE MAKES. A card control product whose
 *      off switch works only while the database is healthy has not shipped an
 *      off switch. Everything else here — limits, MCC blocks — is a
 *      preference; freeze is a commitment, and a commitment that degrades
 *      silently is worse than no commitment.
 *   3. THE DEADLINE IS OURS AND IT IS GENEROUS. `CONTROL_READ_BUDGET_MS` is
 *      600 against a provider timeout of 6000. Missing it does not mean "the
 *      database is busy", it means the database is gone. Fail-open arguments
 *      are arguments about load; this branch is about an outage.
 *   4. IT IS AUDITABLE EITHER WAY. Every fail-closed decline is a
 *      `card_auth_decision` row with rule `control_store_unavailable`, so the
 *      customer who was declined can be found, told and made whole. A silent
 *      fail-open leaves nothing to find.
 *
 * What we do NOT do is decline the whole program. `card_not_under_control`
 * (rule 2) is a deliberate fail-OPEN at the SCOPE boundary, and it is a
 * different question: there, the read succeeded and told us the truth, which
 * is that this token is not a card this book issues controls for. Enrolling an
 * ASA responder is program-wide; declining every card we did not create would
 * turn a new feature into an outage for every card that predates it. The
 * distinction is exactly "we know the answer is no controls" versus "we do not
 * know the answer", and the two get opposite defaults.
 */

import {
  PURCHASE_STATUSES,
  type AuthRequest,
  type CardControls,
  type ControlLookup,
  type DecisionRule,
  type MemberDecisionTerms,
  type SpendToDate,
  type Verdict,
} from "./types";

/**
 * Evaluation order. Separate from `DECISION_RULES` on purpose — see the header.
 * Exported so a test can assert that every rule in the closed set is reachable
 * and that no rule was added to the type without being wired in here.
 */
export const RULE_ORDER: readonly DecisionRule[] = [
  "control_store_unavailable",
  "card_not_under_control",
  "balance_inquiry_not_a_purchase",
  "credit_not_a_purchase",
  "member_removed",
  "member_suspended",
  "card_frozen",
  "mcc_blocked",
  "per_transaction_limit_exceeded",
  "daily_limit_exceeded",
  "monthly_limit_exceeded",
  "member_per_transaction_limit_exceeded",
  "member_daily_limit_exceeded",
  "member_monthly_limit_exceeded",
  "no_controls_configured",
  "within_controls",
];

/** Money into `inputs`: decimal string of integer cents, or null. */
function cents(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/**
 * Whether a request consumes a spending limit at all.
 *
 * A BALANCE_INQUIRY moves nothing and carries a zero amount. A
 * CREDIT_AUTHORIZATION is money coming back — a refund. Lithic's own card
 * `spend_limit` behaves the same way ("refunds and credits will be approved"),
 * and a control that declined a refund because the card had already spent its
 * daily limit would be actively harmful: the customer would be unable to
 * receive their own money back.
 */
function isPurchase(request: AuthRequest): boolean {
  return PURCHASE_STATUSES.includes(request.requestStatus);
}

/**
 * Decide.
 *
 * Total, deterministic, and free of `Date.now()`. The window boundaries that
 * produced `spend` were chosen by the store — `book_date()` in
 * America/New_York, the same clock the statements use — because a decision
 * function that reads a clock cannot be replayed, and replaying a decision is
 * how a dispute six months from now gets answered.
 */
export function decide(request: AuthRequest, lookup: ControlLookup): Verdict {
  /* --- 1. The read failed. Fail closed. See the header. ------------------ */
  if (lookup.status === "unavailable") {
    return {
      outcome: "decline",
      // There is no "issuer system unavailable" member in Lithic's asa-response
      // enum (the full list is in types.ts, verbatim from their OpenAPI
      // document). VELOCITY_EXCEEDED is chosen because it is the only decline
      // in that enum the network documents as RETRYABLE by the acquirer, which
      // is exactly the right operational signal for an outage — and the true
      // reason is on this row, so the dispute is answerable even though the
      // wire code is approximate. Naming it here rather than in the doc alone
      // because the mismatch is the kind of thing that gets discovered by a
      // reviewer and treated as a lie.
      result: "VELOCITY_EXCEEDED",
      rule: "control_store_unavailable",
      reason:
        "The card control store did not answer inside its deadline, so the controls on this card could not be honoured. This system declines rather than guesses.",
      inputs: {
        detail: lookup.detail,
        amount_cents: cents(request.amountCents),
        mcc: request.mcc,
        request_status: request.requestStatus,
        fail_mode: "closed",
      },
    };
  }

  /* --- 2. Not a card this book issues controls for. Out of scope. -------- */
  if (lookup.cardId === null) {
    return {
      outcome: "approve",
      result: "APPROVED",
      rule: "card_not_under_control",
      reason:
        "This card token is not registered in this book, so this system holds no controls to apply to it. Approved without judgement; Lithic's own card limits still apply.",
      inputs: {
        provider_card_token_known: false,
        amount_cents: cents(request.amountCents),
        mcc: request.mcc,
        request_status: request.requestStatus,
        fail_mode: "open",
      },
    };
  }

  const controls = lookup.controls;

  /* --- 3 & 4. Not a purchase. ------------------------------------------- */
  //
  // Checked BEFORE `no_controls_configured` so that the reason recorded for a
  // balance inquiry is "this is not a purchase" whether or not the card has
  // controls. The alternative order records two different reasons for the same
  // fact depending on an unrelated setting, which is the kind of thing that
  // makes a decision log unreadable.
  if (request.requestStatus === "BALANCE_INQUIRY") {
    return {
      outcome: "approve",
      result: "APPROVED",
      rule: "balance_inquiry_not_a_purchase",
      reason:
        "A balance inquiry moves no money and consumes no limit. Approved.",
      inputs: {
        request_status: request.requestStatus,
        amount_cents: cents(request.amountCents),
        control_version: controls?.version ?? null,
      },
    };
  }

  if (!isPurchase(request)) {
    return {
      outcome: "approve",
      result: "APPROVED",
      rule: "credit_not_a_purchase",
      reason:
        "A credit authorisation is money returning to the card. Spending limits gate spend, not refunds, so this is approved regardless of how much the card has spent.",
      inputs: {
        request_status: request.requestStatus,
        amount_cents: cents(request.amountCents),
        control_version: controls?.version ?? null,
      },
    };
  }

  const member = lookup.member ?? null;

  /* --- 5 & 6. The person this card belongs to. --------------------------- */
  //
  // BEFORE the card's own controls and BEFORE `no_controls_configured`, and
  // the ordering is the whole of "removing a member stops their card". A
  // removed person's card must decline whether or not anybody ever set a
  // control on it, and `no_controls_configured` approves — so if these two
  // rules sat after it, a removed member holding a card nobody had configured
  // would keep spending. That is the bug this order exists to make
  // unreachable, and `decide.test.ts` drives exactly that case.
  //
  // AFTER the two not-a-purchase rules, and that is deliberate in the other
  // direction: a REFUND to a removed person's card is still approved. The
  // money goes back to the BUSINESS's account — the card posts to their 2100,
  // not to the individual — so declining it would leave the customer unable to
  // receive their own money back because an employee left. A credit is not
  // spend, and revoking somebody's ability to spend is not revoking the
  // business's ability to be repaid.
  if (member !== null && member.state !== "active") {
    const removed = member.state === "removed";
    return {
      outcome: "decline",
      result: "CARD_PAUSED",
      rule: removed ? "member_removed" : "member_suspended",
      reason: removed
        ? `The person this card belongs to is no longer on this team, so the card no longer authorises. Any authorisation already outstanding still settles.`
        : `The person this card belongs to is suspended, so the card is not authorising at the moment.`,
      inputs: {
        card_id: lookup.cardId,
        member_id: member.memberId,
        member_version: member.version,
        member_state: member.state,
        member_role: member.role,
        amount_cents: cents(request.amountCents),
        mcc: request.mcc,
        request_status: request.requestStatus,
        // The card's controls are NOT consulted, and this says so rather than
        // leaving a reader to infer it from an absent field.
        control_version: controls?.version ?? null,
        controls_consulted: false,
      },
    };
  }

  /* --- 7 to 11. The card's own controls. --------------------------------- */
  if (controls !== null) {
    const base = {
      card_id: lookup.cardId,
      control_version: controls.version,
      member_id: member?.memberId ?? null,
      member_version: member?.version ?? null,
      amount_cents: cents(request.amountCents),
      mcc: request.mcc,
      request_status: request.requestStatus,
    } as const;

    /* --- 7. The switch. -------------------------------------------------- */
    if (controls.cardState === "frozen") {
      return {
        outcome: "decline",
        result: "CARD_PAUSED",
        rule: "card_frozen",
        reason: `This card is frozen (control version ${controls.version}). No authorisation is approved while it is off.`,
        inputs: { ...base, card_state: controls.cardState },
      };
    }

    /* --- 8. Merchant category. ------------------------------------------- */
    //
    // A blocked list with no MCC on the request is NOT a block. The network
    // sends an MCC on every card-present authorisation, but `parseAsaRequest`
    // returns null for anything that is not four digits, and declining on the
    // absence of evidence would decline a real purchase because a terminal sent
    // a malformed field. Recorded as `mcc: null` on the approving row, so the
    // gap is visible rather than assumed away.
    if (request.mcc !== null && controls.blockedMccs.includes(request.mcc)) {
      return {
        outcome: "decline",
        result: "UNAUTHORIZED_MERCHANT",
        rule: "mcc_blocked",
        reason: `Merchant category ${request.mcc} is blocked on this card (control version ${controls.version}).`,
        inputs: {
          ...base,
          blocked_mccs: controls.blockedMccs.join(","),
          matched_mcc: request.mcc,
        },
      };
    }

    /* --- 9. Per transaction. --------------------------------------------- */
    const perTxn = controls.perTxnLimitCents;
    if (perTxn !== null && request.amountCents > perTxn) {
      return {
        outcome: "decline",
        result: "VELOCITY_EXCEEDED",
        rule: "per_transaction_limit_exceeded",
        reason: `This authorisation is over the per-transaction limit on this card (control version ${controls.version}).`,
        inputs: {
          ...base,
          limit_cents: cents(perTxn),
          over_by_cents: cents(request.amountCents - perTxn),
        },
      };
    }

    /* --- 10 & 11. Velocity. ----------------------------------------------- */
    //
    // The comparison is `spend + this amount > limit`, not `spend > limit`. A
    // card with $10 of a $10 daily limit already spent has spent its limit and
    // not exceeded it; the eleventh dollar is the one that is refused. Written
    // out because the off-by-one here is the difference between a $10 limit that
    // permits $10 and one that permits $19.99.
    const day = velocity(request.amountCents, lookup.spend, controls, "day");
    if (day !== null) return day;

    const month = velocity(request.amountCents, lookup.spend, controls, "month");
    if (month !== null) return month;
  }

  /* --- 12 to 14. The person's envelope, on top of the card's. ------------- */
  //
  // THE ORDER BETWEEN THE TWO SCOPES IS A CHOICE AND IT IS THIS WAY ROUND.
  // First match wins, so whichever scope is checked first is the one whose
  // reason the cardholder gets. The card is checked first because it is the
  // narrower instrument and the thing an operator most recently touched on the
  // card screen; the person is the OUTER envelope, and "you are inside every
  // limit on this card but outside your own monthly allowance" is exactly the
  // sentence that should come second. Both are recorded either way, and
  // `member_*` and the card rules carry different names so a decision log can
  // be grouped by which scope refused.
  //
  // THE PERSON'S SPEND IS ACROSS EVERY CARD THEY HOLD, not just this one. That
  // is the point of a per-person limit: a $2,000 monthly allowance that reset
  // every time somebody was given a second card would not be an allowance.
  if (member !== null) {
    const spend = lookup.memberSpend ?? { dayCents: 0n, monthCents: 0n };
    const perTxn = member.perTxnLimitCents;
    if (perTxn !== null && request.amountCents > perTxn) {
      return {
        outcome: "decline",
        result: "VELOCITY_EXCEEDED",
        rule: "member_per_transaction_limit_exceeded",
        reason: `This authorisation is over ${member.displayName}'s own per-transaction limit (member terms version ${member.version}).`,
        inputs: {
          ...memberBase(request, lookup.cardId, controls, member),
          scope: "member",
          limit_cents: cents(perTxn),
          over_by_cents: cents(request.amountCents - perTxn),
        },
      };
    }

    const day = memberVelocity(request, lookup.cardId, controls, member, spend, "day");
    if (day !== null) return day;

    const month = memberVelocity(request, lookup.cardId, controls, member, spend, "month");
    if (month !== null) return month;
  }

  /* --- 15. Nothing to judge it against. ---------------------------------- */
  //
  // Unchanged in meaning and tightened in predicate: it now also requires that
  // the card belongs to nobody. A card with no control version whose HOLDER has
  // limits has been judged — by the block above — and saying "no controls have
  // been set" about it would be false.
  if (controls === null && member === null) {
    return {
      outcome: "approve",
      result: "APPROVED",
      rule: "no_controls_configured",
      reason:
        "No controls have been set on this card and it belongs to no member. Approved. A card with no controls is not a card with a control that failed.",
      inputs: {
        card_id: lookup.cardId,
        amount_cents: cents(request.amountCents),
        mcc: request.mcc,
        control_version: null,
        member_id: null,
      },
    };
  }

  /* --- 16. Approve. ------------------------------------------------------- */
  return {
    outcome: "approve",
    result: "APPROVED",
    rule: "within_controls",
    reason:
      member === null
        ? `Within every control on this card (control version ${controls?.version ?? "none"}).`
        : `Within every control on this card and every limit on ${member.displayName} (member terms version ${member.version}).`,
    inputs: {
      card_id: lookup.cardId,
      control_version: controls?.version ?? null,
      amount_cents: cents(request.amountCents),
      mcc: request.mcc,
      request_status: request.requestStatus,
      card_state: controls?.cardState ?? null,
      per_txn_limit_cents: cents(controls?.perTxnLimitCents ?? null),
      daily_limit_cents: cents(controls?.dailyLimitCents ?? null),
      daily_spend_cents: cents(lookup.spend.dayCents),
      monthly_limit_cents: cents(controls?.monthlyLimitCents ?? null),
      monthly_spend_cents: cents(lookup.spend.monthCents),
      blocked_mcc_count: controls?.blockedMccs.length ?? 0,
      member_id: member?.memberId ?? null,
      member_version: member?.version ?? null,
      member_role: member?.role ?? null,
      member_per_txn_limit_cents: cents(member?.perTxnLimitCents ?? null),
      member_daily_limit_cents: cents(member?.dailyLimitCents ?? null),
      member_daily_spend_cents: cents(lookup.memberSpend?.dayCents ?? null),
      member_monthly_limit_cents: cents(member?.monthlyLimitCents ?? null),
      member_monthly_spend_cents: cents(lookup.memberSpend?.monthCents ?? null),
    },
  };
}

/** The figures every member-scoped decline records. One place, so they agree. */
function memberBase(
  request: AuthRequest,
  cardId: string | null,
  controls: CardControls | null,
  member: MemberDecisionTerms,
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    card_id: cardId,
    control_version: controls?.version ?? null,
    member_id: member.memberId,
    member_version: member.version,
    member_role: member.role,
    amount_cents: cents(request.amountCents),
    mcc: request.mcc,
    request_status: request.requestStatus,
  };
}

/**
 * One velocity window, for the PERSON rather than the card.
 *
 * A separate function from `velocity()` below rather than a parameterised one,
 * because the two record different `inputs` and cite different versions, and a
 * shared function with a `scope` flag would be one function with two meanings on
 * a path where the recorded figures are the evidence in a dispute.
 */
function memberVelocity(
  request: AuthRequest,
  cardId: string | null,
  controls: CardControls | null,
  member: MemberDecisionTerms,
  spend: SpendToDate,
  window: "day" | "month",
): Verdict | null {
  const limit = window === "day" ? member.dailyLimitCents : member.monthlyLimitCents;
  if (limit === null) return null;

  const already = window === "day" ? spend.dayCents : spend.monthCents;
  const total = already + request.amountCents;
  if (total <= limit) return null;

  return {
    outcome: "decline",
    result: "VELOCITY_EXCEEDED",
    rule: window === "day" ? "member_daily_limit_exceeded" : "member_monthly_limit_exceeded",
    reason:
      window === "day"
        ? `This authorisation would take ${member.displayName} past their own daily limit (member terms version ${member.version}).`
        : `This authorisation would take ${member.displayName} past their own monthly limit (member terms version ${member.version}).`,
    inputs: {
      ...memberBase(request, cardId, controls, member),
      scope: "member",
      window,
      window_basis: "book_date (America/New_York)",
      limit_cents: limit.toString(),
      spend_cents: already.toString(),
      would_total_cents: total.toString(),
      over_by_cents: (total - limit).toString(),
    },
  };
}

/** One velocity window. Returns a decline, or null if the window is fine. */
function velocity(
  amountCents: bigint,
  spend: SpendToDate,
  controls: CardControls,
  window: "day" | "month",
): Verdict | null {
  const limit = window === "day" ? controls.dailyLimitCents : controls.monthlyLimitCents;
  if (limit === null) return null;

  const already = window === "day" ? spend.dayCents : spend.monthCents;
  const total = already + amountCents;
  if (total <= limit) return null;

  return {
    outcome: "decline",
    result: "VELOCITY_EXCEEDED",
    rule: window === "day" ? "daily_limit_exceeded" : "monthly_limit_exceeded",
    reason:
      window === "day"
        ? `This authorisation would take the card past its daily limit (control version ${controls.version}).`
        : `This authorisation would take the card past its monthly limit (control version ${controls.version}).`,
    inputs: {
      card_id: controls.cardId,
      control_version: controls.version,
      amount_cents: amountCents.toString(),
      window,
      // The window boundary is the book day / book month in America/New_York —
      // `book_tz()` in migration 0001, the same clock a statement closes on. A
      // card control that rolled over at UTC midnight would reset at 7pm local
      // and nobody would be able to explain why.
      window_basis: "book_date (America/New_York)",
      limit_cents: limit.toString(),
      spend_cents: already.toString(),
      would_total_cents: total.toString(),
      over_by_cents: (total - limit).toString(),
    },
  };
}
