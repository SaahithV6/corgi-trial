/**
 * The vocabulary of the real-time card control decision.
 *
 * Nothing in this file imports a database, a provider client or
 * `server-only`. It is shared by the decision function (pure), the ASA route
 * (server), the harness (test), and the console panel (client), and a type
 * that three of those four can import is worth more than a type that lives
 * next to the query that produced it.
 *
 * MONEY IS `bigint` CENTS AT EVERY POINT. There is no `number` amount in this
 * module or in anything that reads it. Where a figure has to cross a
 * serialisation boundary — a server action's return value, the `inputs` column
 * — it crosses as a DECIMAL STRING of integer cents, because `JSON.parse`
 * turns 9007199254740993 into 9007199254740992 and a control that silently
 * rounds is a control that silently fails open.
 */

/**
 * The ONE import in this file, and it is a pure one: `@/lib/team/roles` holds
 * no database handle, no `server-only` and no provider client, so a decision
 * function, a page and a test can all read it. The alternative — restating the
 * four roles and the three member states here — is a second copy of a
 * permission vocabulary, and a second copy is how a permission system becomes
 * decorative.
 */
import type { MemberState, TeamRole } from "@/lib/team/roles";

/* -------------------------------------------------------------------------- */
/* 1. Controls                                                                */
/* -------------------------------------------------------------------------- */

/** The on/off switch. `frozen` is checked before any limit. */
export type CardState = "active" | "frozen";

export const CARD_STATES: readonly CardState[] = ["active", "frozen"];

/**
 * One version of one card's controls, as stored in `card_control_version`.
 *
 * A `null` limit means "no limit of this kind". It is NOT the same as `0n`,
 * which means "this card may spend nothing" — both are expressible, both are
 * reachable from the screen, and they mean different things.
 */
export type CardControls = {
  readonly cardId: string;
  readonly controlVersionId: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly cardState: CardState;
  readonly perTxnLimitCents: bigint | null;
  readonly dailyLimitCents: bigint | null;
  readonly monthlyLimitCents: bigint | null;
  /** ISO 18245 four-digit codes, as strings. `'0742'` is not `742`. */
  readonly blockedMccs: readonly string[];
  readonly note: string;
};

/** What an operator asked for. The version number is the store's to assign. */
export type CardControlsDraft = {
  readonly cardState: CardState;
  readonly perTxnLimitCents: bigint | null;
  readonly dailyLimitCents: bigint | null;
  readonly monthlyLimitCents: bigint | null;
  readonly blockedMccs: readonly string[];
  readonly note: string;
};

/* -------------------------------------------------------------------------- */
/* 2. Spend so far                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Spend already approved on this card in the current book day and book month.
 *
 * READ THIS CAREFULLY, because it is the single most arguable number in the
 * feature. It is the sum of amounts THIS SYSTEM APPROVED, taken from
 * `card_auth_decision` — not the settled figure from the journal, and not the
 * outstanding hold from `v_card_auth_hold`.
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. IT HAS TO COUNT AUTHORISATIONS THAT HAVE NOT ARRIVED YET. The ASA call
 *      happens before Lithic has sent us anything asynchronous. Five $9 auths
 *      in four seconds against a $20 daily limit would all be approved by a
 *      ledger-derived figure, because none of them is in the ledger yet. Our
 *      own decision log is the only source that already knows.
 *   2. IT MUST NOT TOUCH THE LEDGER. Folding journal lines on the synchronous
 *      path is exactly the coupling this whole design refuses.
 *   3. IT IS THE CONSERVATIVE DIRECTION. An authorisation we approved and
 *      that was then voided keeps its slot until the window rolls, so the
 *      error is towards declining rather than towards letting a limit be
 *      exceeded. A control that errs the other way is not a control.
 *
 * The cost of (3) is written down in docs/CARD-CONTROLS.md rather than hidden:
 * a voided $200 auth holds $200 of the daily limit until midnight in
 * America/New_York, and the fix — subtracting decisions whose authorisation
 * later reversed — is a second query on a path that has a latency budget.
 */
export type SpendToDate = {
  readonly dayCents: bigint;
  readonly monthCents: bigint;
};

export const NO_SPEND: SpendToDate = { dayCents: 0n, monthCents: 0n };

/* -------------------------------------------------------------------------- */
/* 2b. The person holding the card                                            */
/* -------------------------------------------------------------------------- */

/**
 * One member's terms, as the authorisation decision sees them.
 *
 * A DELIBERATELY SMALLER SHAPE than `@/lib/team/types`'s `MemberTerms`. This is
 * on the hot path and it carries exactly what a rule compares, plus the version
 * id to pin and the name to put in a sentence a cardholder can read. It does
 * not carry the note, the join date or the capability flags, because no rule
 * reads them and a wider row is a wider row on every authorisation.
 *
 * ─── WHY A PERSON HAS LIMITS AT ALL, WHEN THE CARD ALREADY DOES ─────────────
 *
 * A card limit is a property of an INSTRUMENT. Re-issuing a card is a new
 * `card` row with a new provider token (migration 0008 says why), which means a
 * per-card monthly limit silently RESETS when a card is replaced. A member
 * limit is a property of a PERSON and survives that. It is also the limit an
 * operator actually means: "Theo can spend $2,000 a month" is a sentence about
 * Theo, not about a sixteen-digit number that may be replaced twice this year.
 *
 * The two are enforced in the same decision, card first and then person, and
 * both are recorded. See `RULE_ORDER` in `./decide.ts`.
 */
export type MemberDecisionTerms = {
  readonly memberId: string;
  readonly memberVersionId: string;
  readonly version: number;
  readonly displayName: string;
  readonly state: MemberState;
  readonly role: TeamRole;
  readonly perTxnLimitCents: bigint | null;
  readonly dailyLimitCents: bigint | null;
  readonly monthlyLimitCents: bigint | null;
};

/* -------------------------------------------------------------------------- */
/* 3. The request, normalised                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lithic's `asa_request_status`. Verbatim from the provider's OpenAPI
 * document (`lithic-38a020a1….yml`, schema `asa_request_status`), because a
 * value we invent is a value we will one day fail to recognise.
 */
export const ASA_REQUEST_STATUSES = [
  "AUTHORIZATION",
  "CREDIT_AUTHORIZATION",
  "FINANCIAL_AUTHORIZATION",
  "FINANCIAL_CREDIT_AUTHORIZATION",
  "BALANCE_INQUIRY",
] as const;

export type AsaRequestStatus = (typeof ASA_REQUEST_STATUSES)[number];

/**
 * The statuses that consume a spending limit.
 *
 * A BALANCE_INQUIRY moves nothing. A `*_CREDIT_AUTHORIZATION` is money coming
 * back. Both are approved without judgement by `decide()`, and — this is the
 * half that is easy to forget — both must also be EXCLUDED from the velocity
 * sum, or a $40 refund would eat $40 of the card's daily limit. So this
 * constant is exported and used in two places: `isPurchase()` in `./decide.ts`
 * and the `request_status` filter in the velocity query in `./store.ts`. One
 * constant rather than two lists, because the day they disagree is the day a
 * refund starts declining a purchase.
 */
export const PURCHASE_STATUSES: readonly AsaRequestStatus[] = [
  "AUTHORIZATION",
  "FINANCIAL_AUTHORIZATION",
];

/**
 * The three facts about a card the ASA payload carries and the decision may
 * want. `state` is Lithic's opinion of the card, which is NOT our control
 * switch: a card can be OPEN at Lithic and frozen here, and this system's
 * answer is the one that matters on this call.
 */
export type AsaCard = {
  readonly token: string;
  readonly lastFour: string | null;
  readonly memo: string | null;
  readonly state: string | null;
};

/**
 * One authorisation request, reduced to what a control decision needs.
 *
 * `parseAsaRequest` in `./asa.ts` produces this from the provider's payload.
 * The decision function sees only this, which is what makes it testable
 * without a 4 KB fixture and what lets the harness replay a real payload
 * shape through exactly the code the provider drives.
 */
export type AuthRequest = {
  /** Lithic's provisional transaction token. Joins to the async webhook. */
  readonly providerAuthToken: string;
  readonly card: AsaCard;
  /** The amount to authorise against, in cents. Never negative. */
  readonly amountCents: bigint;
  /** ISO 18245, four digits, or null when the network sent nothing usable. */
  readonly mcc: string | null;
  readonly merchantDescriptor: string | null;
  readonly requestStatus: AsaRequestStatus;
};

/* -------------------------------------------------------------------------- */
/* 4. The verdict                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Lithic's `asa-response.result` enum, verbatim.
 *
 * From the provider's OpenAPI document. Anything outside this list is
 * documented by Lithic to decline the transaction and stamp it
 * `CUSTOM_ASA_RESULT`, which is a fact worth knowing and not a fact worth
 * relying on — so the type is closed and `assertNever`-shaped.
 */
export const ASA_RESULTS = [
  "APPROVED",
  "AVS_INVALID",
  "CARD_PAUSED",
  "INSUFFICIENT_FUNDS",
  "UNAUTHORIZED_MERCHANT",
  "VELOCITY_EXCEEDED",
  "DRIVER_NUMBER_INVALID",
  "VEHICLE_NUMBER_INVALID",
  "SUSPECTED_FRAUD",
  "CHALLENGE",
] as const;

export type AsaResult = (typeof ASA_RESULTS)[number];

export type DecisionOutcome = "approve" | "decline";

/**
 * The closed set of rules that can fire. Order is significance order, not
 * evaluation order — `RULE_ORDER` in `./decide.ts` is the evaluation order and
 * it is a separate constant on purpose, so that reordering the display cannot
 * change the decision.
 */
export const DECISION_RULES = [
  /** The control store did not answer inside its deadline. Fail closed. */
  "control_store_unavailable",
  /** This card token is not registered in this book. Out of scope: approve. */
  "card_not_under_control",
  /** The card is registered but neither it nor its holder has any limits. */
  "no_controls_configured",
  /** A balance inquiry is not a purchase. */
  "balance_inquiry_not_a_purchase",
  /** A credit is money coming back. Limits gate spend, not refunds. */
  "credit_not_a_purchase",
  /**
   * The person this card belongs to has been removed from the team.
   *
   * Checked BEFORE the card's own controls, and before
   * `no_controls_configured`, because a removed person's card must stop
   * whether or not anybody ever set a control on it. That ordering is the
   * whole of "removing a member must stop their card".
   */
  "member_removed",
  /** The person this card belongs to is suspended. Reversible. */
  "member_suspended",
  /** The customer turned the card off. */
  "card_frozen",
  /** The merchant's category is on this card's block list. */
  "mcc_blocked",
  "per_transaction_limit_exceeded",
  "daily_limit_exceeded",
  "monthly_limit_exceeded",
  /** The person's own envelope, on top of the card's. */
  "member_per_transaction_limit_exceeded",
  "member_daily_limit_exceeded",
  "member_monthly_limit_exceeded",
  /** Every rule passed. */
  "within_controls",
] as const;

export type DecisionRule = (typeof DECISION_RULES)[number];

/* -------------------------------------------------------------------------- */
/* 4b. Was anything actually compared?                                        */
/* -------------------------------------------------------------------------- */

/**
 * The rules under which NOTHING THIS BOOK HOLDS WAS COMPARED WITH THE REQUEST.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Measured on the live book, whole history of the provider lane:
 *
 *     63 provider-lane approvals
 *       44  no_controls_configured   — no control version, no holder
 *       11  card_not_under_control   — the token is not in this book
 *        8  within_controls          — a rule ran and said yes
 *
 * Fifty-five of sixty-three approvals — 87% — were produced by a branch that
 * returned `outcome: "approve"` WITHOUT CONSULTING A SINGLE CONTROL. Both
 * branches are correct, deliberate and documented (see `decide()`'s header);
 * neither is a defect. The defect is that the LOG could not tell them apart
 * from `within_controls`: three rows, one `outcome` value, and the only way to
 * know which of them was actually gated by a limit was to read the `rule`
 * column and already know what each rule means.
 *
 * That is the shape this repository has catalogued over and over — a guard
 * that reports healthy because the population it excluded is indistinguishable,
 * in the evidence it emits, from the failure it exists to catch. "51 approvals"
 * is not evidence that card controls work if 48 of them were approved by a rule
 * that judged nothing.
 *
 * ─── THE DEFINITION, AND IT IS DELIBERATELY STRICT ──────────────────────────
 *
 *     A decision is JUDGED when at least one control this book holds — a card
 *     control version, or a member's terms — was compared with this request and
 *     COULD HAVE REFUSED IT.
 *
 * "Could have refused it" is the operative half, and it is what puts the two
 * not-a-purchase rules on this list even though they are neither gaps nor
 * defects. `balance_inquiry_not_a_purchase` and `credit_not_a_purchase` fire at
 * positions 3 and 4 of `RULE_ORDER`, BEFORE `card_frozen` at 7 — so a balance
 * inquiry on a FROZEN card is approved, and no control could have stopped it.
 * Counting those as evidence that a control worked would be the same
 * over-claim in miniature, so they are counted as what they are.
 *
 * `control_store_unavailable` is on the list for the same reason and is not an
 * exception to it: it DECLINES, and it declines precisely because nothing could
 * be compared. `judged` is a statement about whether a control ran, not about
 * which way the answer went, and keeping it orthogonal to `outcome` is what
 * makes "a decline nobody judged" countable too.
 *
 * ─── WHY IT IS A FUNCTION OF THE RULE AND NOT A SEPARATE FACT ───────────────
 *
 * Every rule in the closed set is wholly one or the other, and that is a
 * property of the predicates rather than a convenience:
 *
 *   - `no_controls_configured`'s predicate is literally `controls === null &&
 *     member === null`, so it CANNOT fire where something existed to compare.
 *   - `within_controls` is reachable only when that predicate was false, so it
 *     CANNOT fire unless a card control version or a member's terms existed.
 *   - every other judged rule names the control it compared in its own name.
 *
 * So the classification is total, mechanical and checkable, `decide()` states
 * it at every return site rather than deriving it, and `decide.test.ts` asserts
 * the two agree for every rule in `DECISION_RULES`. Deriving it in one place
 * would be smaller; stating it at each site and checking is what stops a rule
 * added next year from defaulting to "judged" because true is the easy value.
 *
 * THE DECISION LOG ALREADY CARRIES ENOUGH TO RECOVER THIS FOR EVERY HISTORIC
 * ROW, which is why no column was added to `card_auth_decision` and no backfill
 * was needed: `rule` is stored on every row that has ever been written, so the
 * 145 rows already in the book classify under exactly this list. Migration 0053
 * mirrors it in SQL for set-based readers, and a test asserts the mirror.
 */
export const UNJUDGED_RULES = [
  "control_store_unavailable",
  "card_not_under_control",
  "no_controls_configured",
  "balance_inquiry_not_a_purchase",
  "credit_not_a_purchase",
] as const;

export type UnjudgedRule = (typeof UNJUDGED_RULES)[number];

/**
 * Whether a rule compared a control with the request.
 *
 * Takes a `string` and not a `DecisionRule`, because its most important callers
 * read a `rule` column out of the database, where the type is `text` and the
 * value could in principle be a rule a newer deploy wrote. An unrecognised rule
 * is reported as JUDGED, which is the direction that leaves the number honest:
 * over-reporting the unjudged count would manufacture a finding, and a rule
 * this build has never heard of is one it cannot claim judged nothing.
 */
export function isJudgedRule(rule: string): boolean {
  return !UNJUDGED_RULES.some((unjudged) => unjudged === rule);
}

/**
 * What the decision function returns.
 *
 * `inputs` is the figures the rule actually compared, with money as decimal
 * strings. It is what a dispute is answered from six months later, so it
 * carries the comparison and not a prose summary of it.
 */
export type Verdict = {
  readonly outcome: DecisionOutcome;
  readonly result: AsaResult;
  readonly rule: DecisionRule;
  /**
   * Whether any control this book holds was compared with this request.
   *
   * NOT a synonym for `outcome === "approve"` and not derivable from it: an
   * approval can be judged or unjudged, and so can a decline. See
   * `UNJUDGED_RULES` above for the definition and for why it exists.
   */
  readonly judged: boolean;
  /** One sentence, safe to show a cardholder. Never contains a token. */
  readonly reason: string;
  readonly inputs: Readonly<Record<string, string | number | boolean | null>>;
};

/* -------------------------------------------------------------------------- */
/* 5. What the store hands the decision                                       */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of the one read on the hot path.
 *
 * `unavailable` is a first-class member and not an exception, because the
 * fail-open/fail-closed argument is the interesting part of this feature and
 * a `catch` block is a bad place to hold an argument. See `decide()`.
 */
export type ControlLookup =
  | {
      readonly status: "read";
      /** null when the ASA card token is not registered in this book. */
      readonly cardId: string | null;
      /** null when the card is registered but has no control version yet. */
      readonly controls: CardControls | null;
      readonly spend: SpendToDate;
      /**
       * The person holding this card, or null when it belongs to nobody.
       *
       * OPTIONAL ON THE TYPE, and that is not laziness. Every card issued
       * before the team existed has no member, `null` and `undefined` mean the
       * same thing to `decide()` — "this card is not a person's card" — and a
       * caller that has no opinion about members (the forty-odd unit tests
       * written before this feature) keeps type-checking and keeps asserting
       * exactly what it asserted. A card with no member behaves EXACTLY as it
       * did, which is the property that made this safe to add to a live path.
       */
      readonly member?: MemberDecisionTerms | null;
      /**
       * Spend already approved for the PERSON today and this book month,
       * across every card they hold. Absent when there is no member.
       */
      readonly memberSpend?: SpendToDate;
    }
  | {
      readonly status: "unavailable";
      /** `timeout` or a driver error code. Recorded, never shown to a cardholder. */
      readonly detail: string;
    };

/** Who drove this decision. The honesty column. */
export type DecisionSource = "provider" | "harness";

/** One row of `card_auth_decision`, as the screen reads it. */
export type DecisionRecord = {
  readonly id: string;
  readonly decidedAt: string;
  readonly provider: string;
  readonly providerAuthToken: string;
  readonly providerCardToken: string;
  readonly cardId: string | null;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly controlVersion: number | null;
  readonly amountCents: bigint;
  readonly mcc: string | null;
  readonly merchantDescriptor: string | null;
  readonly requestStatus: string;
  readonly outcome: DecisionOutcome;
  readonly resultCode: string;
  readonly rule: string;
  /**
   * Whether a control was compared with this authorisation.
   *
   * DERIVED FROM `rule` BY `isJudgedRule()` at read time, not stored: `rule` is
   * on every row this log has ever written, so every historic decision — the
   * 145 in the book when this was added — classifies without a migration, a
   * backfill, or a column that could disagree with the rule beside it. The
   * store fills it in; a screen must not compute it a second time.
   */
  readonly judged: boolean;
  readonly reason: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly decisionLatencyUs: number;
  readonly source: DecisionSource;
  /**
   * Who this authorisation is attributable to. Null for a card with no member.
   *
   * OPTIONAL, for the same reason `ControlLookup.member` is: readers written
   * before the team existed — the console panel's five fixture states among
   * them — keep type-checking and keep meaning what they meant. A reader that
   * wants the person asks for it and gets `undefined` where nobody knows, which
   * is the same answer as `null` and is not a crash on a screen.
   */
  readonly memberId?: string | null;
  readonly memberName?: string | null;
  /** The member terms version this was judged under. Pinned, like the control version. */
  readonly memberVersion?: number | null;
};
