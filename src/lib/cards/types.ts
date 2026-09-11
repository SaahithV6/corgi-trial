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
  /** The card is registered but nobody has ever set controls on it. */
  "no_controls_configured",
  /** A balance inquiry is not a purchase. */
  "balance_inquiry_not_a_purchase",
  /** A credit is money coming back. Limits gate spend, not refunds. */
  "credit_not_a_purchase",
  /** The customer turned the card off. */
  "card_frozen",
  /** The merchant's category is on this card's block list. */
  "mcc_blocked",
  "per_transaction_limit_exceeded",
  "daily_limit_exceeded",
  "monthly_limit_exceeded",
  /** Every rule passed. */
  "within_controls",
] as const;

export type DecisionRule = (typeof DECISION_RULES)[number];

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
  readonly reason: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly decisionLatencyUs: number;
  readonly source: DecisionSource;
};
