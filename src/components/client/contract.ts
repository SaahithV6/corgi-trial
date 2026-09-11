/**
 * What the client surface renders, as one shape per screen.
 *
 * Every view component below is a pure function of one of these values, which
 * is what makes the five URL states honest: `default` and `edge` are this value
 * read from Neon, `loading` is this value behind a genuinely slow read, and
 * `empty` and `error` are this value constructed by `fixtures.ts`. The renderer
 * cannot tell them apart, so a fixture state proves the live state renders.
 *
 * ===========================================================================
 * MONEY STAYS bigint ON THIS BOUNDARY, AND THAT IS A DEPARTURE
 * ===========================================================================
 *
 * `src/components/approvals/data-contract.ts` flattens cents to a preformatted
 * string, because its consumer is a CLIENT component and bigint does not
 * survive the serialisation boundary into the browser.
 *
 * Every view here is a SERVER component, so there is no boundary to survive and
 * the cents stay exact all the way to `<Money>`, which does integer `bigint`
 * arithmetic. The one place this surface sends a figure to the browser is the
 * payment form, and that field is a string the customer typed.
 *
 * The rule the brief states — `(cents / 100).toFixed(2)` was found on a screen
 * here and removed — is not satisfied by "we format early". It is satisfied by
 * never having a JavaScript number in the chain at all.
 *
 * ===========================================================================
 * EVERY FIELD HERE IS ALREADY SCOPED
 * ===========================================================================
 *
 * There is no `businessId` on a row. A row cannot carry a tenant discriminator
 * that a component might filter on, because the moment such a field exists
 * somebody writes `rows.filter(r => r.businessId === mine)` and isolation
 * becomes a step. The scoping happened in the `WHERE` clause that produced the
 * row; by the time a value reaches this file the question is already answered.
 * `ClientHeader.businessId` is the single exception and it names the SUBJECT of
 * the screen, not a filter key.
 */

/** A business the picker can switch to. Names only; no figures. */
export type BusinessRef = {
  readonly id: string;
  readonly legalName: string;
  /** False when no `2100` leaf has been opened — KYB has not let them in yet. */
  readonly hasAccount: boolean;
};

export type ClientHeader = {
  readonly businessId: string;
  readonly legalName: string;
  /** `null` when the account has not been opened: a real, rendered state. */
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly currency: string;
  /** ISO instant the reads were taken at. One instant, not one per query. */
  readonly asOf: string;
  /** The value date the ledger is folded to — the bank's calendar, not UTC. */
  readonly valueDate: string;
  /** Everything we have learned, as a booking sequence. */
  readonly bookingWatermark: string;
  /** True when every figure came out of the database on this request. */
  readonly live: boolean;
  readonly businesses: readonly BusinessRef[];
};

/* -------------------------------------------------------------------------- */
/* Balance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The five terms of `ledger_availability()`, carried unchanged.
 *
 * Not re-derived, not re-summed, not clamped. `availableCents` is the function's
 * own answer and this surface never computes a sixth one — the arithmetic shown
 * on screen is a restatement of a subtraction Postgres already did, and the
 * screen says so.
 */
export type BalanceTerms = {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly pendingOutboundCents: bigint;
  readonly availableCents: bigint;
};

export type HoldLine = {
  readonly holdId: string;
  readonly kind: "card_auth" | "uncleared_credit" | "manual";
  readonly descriptor: string;
  readonly externalRef: string;
  readonly authorisedCents: bigint;
  readonly clearedCents: bigint;
  readonly remainingCents: bigint;
  readonly closed: boolean;
  /** The hold's own value date has not arrived; it withholds nothing today. */
  readonly pending: boolean;
  readonly placedAt: string;
  /**
   * ISO instant, or `null` — and `null` covers TWO cases deliberately: no
   * release clock at all, and a clock set to `infinity`. A dispute's
   * provisional credit is released by a person rather than a date, and one
   * unguarded `.toISOString()` on that `infinity` took the whole account screen
   * down (`docs/DEMO.md` §5.1). `releaseWaitsOnAPerson` tells the two apart.
   */
  readonly availableAt: string | null;
  readonly releaseWaitsOnAPerson: boolean;
  readonly expiresAt: string | null;
  readonly policyDays: number | null;
};

export type BalanceScreen = {
  readonly header: ClientHeader;
  readonly terms: BalanceTerms;
  readonly holds: readonly HoldLine[];
};

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

export type ActivityRow = {
  readonly entryId: string;
  /** When it happened, on the bank's calendar. */
  readonly valueDate: string;
  /** When we learned it. Different column, different meaning. */
  readonly bookingDate: string;
  readonly bookingSeq: string;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  /** Signed the way a customer reads it: money in is positive. */
  readonly amountCents: bigint;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
};

/**
 * The card story behind a row, when there is one.
 *
 * Keyed on the provider reference the hold and the journal entry already share,
 * so "authorised $50.00, settled $73.40" is two facts joined on a key both
 * sides carry — not a guess made by matching amounts.
 */
export type CardStory = {
  readonly externalRef: string;
  readonly descriptor: string;
  readonly authorisedCents: bigint;
  readonly clearedCents: bigint;
  readonly remainingCents: bigint;
  readonly closed: boolean;
};

export type ActivityScreen = {
  readonly header: ClientHeader;
  readonly rows: readonly ActivityRow[];
  readonly cardStories: readonly CardStory[];
};

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

export type CardLine = {
  readonly cardId: string;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  /** The person this card belongs to, when the team book says. */
  readonly holderName: string | null;
  /** `null` when nobody has ever set a control policy on this card. */
  readonly state: "active" | "frozen" | null;
  readonly controlVersion: number | null;
  readonly perTxnCents: bigint | null;
  readonly dailyCents: bigint | null;
  readonly monthlyCents: bigint | null;
  readonly blockedMccs: readonly string[];
  readonly spentTodayCents: bigint;
  readonly spentThisMonthCents: bigint;
};

export type DecisionLine = {
  readonly id: string;
  readonly decidedAt: string;
  readonly outcome: "approve" | "decline";
  readonly merchant: string;
  readonly amountCents: bigint;
  readonly mcc: string | null;
  readonly lastFour: string | null;
  readonly memberName: string | null;
  /** The machine-readable rule that fired. Shown small, beside the sentence. */
  readonly rule: string;
  /** The sentence the decision was RECORDED with. Never re-written here. */
  readonly reason: string;
  /** `provider` = a real authorisation from Lithic. `harness` = our own probe. */
  readonly source: "provider" | "harness";
};

export type CardsScreen = {
  readonly header: ClientHeader;
  readonly cards: readonly CardLine[];
  readonly decisions: readonly DecisionLine[];
};

/* -------------------------------------------------------------------------- */
/* Send a payment                                                             */
/* -------------------------------------------------------------------------- */

export type GateView = {
  readonly allowed: boolean;
  readonly code: string | null;
  readonly message: string;
};

export type PolicyLine = {
  readonly rail: string;
  readonly version: string;
  readonly thresholdCents: bigint;
  readonly requiredApprovals: number;
  readonly note: string;
};

export type PayeeLine = {
  readonly payeeId: string;
  readonly displayName: string;
  readonly holderName: string;
  readonly rail: string;
  readonly routingNumber: string | null;
  readonly accountNumberLast4: string | null;
  readonly accountType: string | null;
  readonly archived: boolean;
  /** `warned` with nobody signed for it is the one the gate refuses. */
  readonly outcome: string | null;
  readonly acknowledged: boolean;
};

export type PayScreen = {
  readonly header: ClientHeader;
  readonly gate: GateView;
  readonly policies: readonly PolicyLine[];
  readonly payees: readonly PayeeLine[];
  /** Today, on the bank's calendar. The form's default value date. */
  readonly today: string;
  /** Available right now, so the form can say what is actually spendable. */
  readonly availableCents: bigint;
};

/* -------------------------------------------------------------------------- */
/* Approve                                                                    */
/* -------------------------------------------------------------------------- */

export type ApprovalEventLine = {
  readonly kind: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly occurredAt: string;
  readonly reason: string | null;
};

export type ApprovalItem = {
  readonly instructionId: string;
  readonly contentHash: string;
  readonly amountCents: bigint;
  readonly rail: string;
  readonly valueDate: string;
  readonly destination: string;
  readonly requestedByName: string;
  readonly requestedByKind: string;
  readonly requestedAt: string;
  readonly state: string;
  readonly approvalsHeld: number;
  readonly approvalsRequired: number;
  readonly aboveThreshold: boolean;
  readonly policyVersion: string;
  readonly thresholdCents: bigint;
  readonly events: readonly ApprovalEventLine[];
  /** `decisionGate()`'s answer for the actor this session resolved to. */
  readonly gate: { readonly allowed: boolean; readonly code: string; readonly reason: string };
  /**
   * `releaseGate()`'s answer — a DIFFERENT question, asked separately.
   *
   * Releasing is not approving. The releaser may be the initiator, and on a
   * below-threshold payment there may be no approver at all, so a screen that
   * reused one answer for both would refuse releases it should allow and offer
   * releases the database will refuse.
   */
  readonly release: { readonly allowed: boolean; readonly code: string; readonly reason: string };
};

export type ApproveScreen = {
  readonly header: ClientHeader;
  readonly actorName: string | null;
  readonly actorCanApprove: boolean;
  readonly policies: readonly PolicyLine[];
  /** The one payment addressed by `?payment=`. `null` when none was asked for. */
  readonly payment: ApprovalItem | null;
  /**
   * Why there is no payment on screen, in a sentence — "nothing was asked
   * for", "no payment with that id belongs to you". Deliberately the SAME
   * sentence for an id that does not exist and an id belonging to someone
   * else: telling them apart would let a customer confirm which ids are real.
   */
  readonly lookupMessage: string | null;
};

/* -------------------------------------------------------------------------- */
/* The envelope every loader returns                                          */
/* -------------------------------------------------------------------------- */

export type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };
