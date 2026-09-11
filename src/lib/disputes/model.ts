/**
 * Disputes, the pure half.
 *
 * No database, no clock, no `server-only` — so every rule that decides WHAT
 * MONEY MOVES is provable in a plain Node process, which is where the
 * interesting properties of this feature live:
 *
 *   * the postings for a grant, a clawback, a write-off and a final credit,
 *     each as a balanced pair of signed lines;
 *   * the idempotency keys, all derived from the dispute id and nothing else,
 *     so a double-submitted form posts once and Postgres decides it;
 *   * which transitions are legal, mirrored from the trigger in
 *     db/migrations/0019_disputes.sql.
 *
 * That last mirroring is the only duplication in this module and it is
 * deliberate. The database is the law: `assert_dispute_lifecycle()` refuses an
 * illegal transition no matter who asks, including a future caller that skips
 * this file entirely. What this file buys is a REFUSAL WITH A SENTENCE IN IT
 * before the round trip, so an operator sees "this case was already decided"
 * rather than a raw `55006`. If the two ever disagree, the database wins and
 * this file has a bug.
 */

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the enums in 0019_disputes.sql exactly.
// ---------------------------------------------------------------------------

/** `dispute_reason` in 0019. OUR word for the claim, not the network's code. */
export const DISPUTE_REASONS = [
  "fraud",
  "goods_not_received",
  "duplicate",
  "incorrect_amount",
  "not_as_described",
  "credit_not_processed",
] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export function isDisputeReason(value: unknown): value is DisputeReason {
  return DISPUTE_REASONS.some((r) => r === value);
}

/** `dispute_event_kind` in 0019. */
export const DISPUTE_EVENT_KINDS = [
  "raised",
  "provisional_credit_authorized",
  "provisional_credit_granted",
  "provisional_credit_declined",
  "evidence_submitted",
  "won",
  "lost",
  "withdrawn",
  "credit_finalized",
  "credit_clawed_back",
  "credit_written_off",
] as const;

export type DisputeEventKind = (typeof DISPUTE_EVENT_KINDS)[number];

/** The `status` column of `v_dispute_state`, which is a fold and not a column. */
export const DISPUTE_STATUSES = [
  "raised",
  "authorized",
  "provisional_credit_granted",
  "provisional_credit_declined",
  "evidence_submitted",
  "won_pending_finalization",
  "lost_pending_recovery",
  "closed_won",
  "closed_lost_recovered",
  "closed_lost_written_off",
  "withdrawn",
] as const;

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** One sentence per status, for the screen and for an operator reading a case. */
export const DISPUTE_STATUS_MEANING: Record<DisputeStatus, string> = {
  raised: "The claim is recorded. No money has moved and no evidence has been filed.",
  authorized:
    "A second Corgi approver has signed off on advancing provisional credit. The credit has not been granted yet.",
  provisional_credit_granted:
    "We have advanced the customer their money. It is in their ledger balance and it is held — they cannot spend it until the case resolves, which is what makes a clawback safe.",
  provisional_credit_declined:
    "We chose not to advance the money. The customer is made whole on the decision, not before it.",
  evidence_submitted: "Evidence has been filed with the network. Awaiting a decision.",
  won_pending_finalization:
    "The network decided for the customer. The credit has not been made final yet.",
  lost_pending_recovery:
    "The network decided for the merchant. The advance is still outstanding and must be clawed back or written off.",
  closed_won: "Won. The credit is final and the hold is released — the money is spendable.",
  closed_lost_recovered:
    "Lost, and the advance came back off the customer. Two entries stand: the grant on its day and the clawback on the decision day.",
  closed_lost_written_off:
    "Lost, and we chose to absorb it rather than take it back off the customer. The cost sits on 5200.",
  withdrawn: "The customer withdrew the claim before any money was advanced.",
};

/** A case in one of these statuses is finished; nothing may follow. */
export const CLOSED_STATUSES: readonly DisputeStatus[] = [
  "closed_won",
  "closed_lost_recovered",
  "closed_lost_written_off",
  "withdrawn",
];

export function isClosed(status: DisputeStatus): boolean {
  return CLOSED_STATUSES.some((s) => s === status);
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

/**
 * Every key is derived from the DISPUTE ID and the step, never from a uuid we
 * generate at call time. Two deliveries of the same operator click produce the
 * same key, and the second is a no-op decided by
 * `journal_entry.idempotency_key`'s unique index under the append lock — not by
 * a check anyone can forget to write. This is the same discipline
 * `card:clearing:<provider_event_id>` follows, applied to an operator action
 * instead of a provider event.
 */
export const disputeKeys = {
  provisionalCredit: (disputeId: string) => `dispute:provisional_credit:${disputeId}`,
  holdOpen: (disputeId: string) => `dispute:hold:open:${disputeId}`,
  holdRelease: (disputeId: string) => `dispute:hold:release:${disputeId}`,
  clawback: (disputeId: string) => `dispute:clawback:${disputeId}`,
  writeOff: (disputeId: string) => `dispute:write_off:${disputeId}`,
  finalCredit: (disputeId: string) => `dispute:final_credit:${disputeId}`,
} as const;

/** `hold.external_ref`, unique with `kind` — one hold per dispute, by construction. */
export function disputeHoldRef(disputeId: string): string {
  return `dispute:${disputeId}`;
}

// ---------------------------------------------------------------------------
// The chart accounts this feature touches
// ---------------------------------------------------------------------------

/**
 * 1120, `Card network settlement receivable`.
 *
 * The counter-account for a provisional credit, and the choice is worth a
 * sentence: advancing the money is not an expense and not a refund, it is a
 * CLAIM WE HAVE FILED WITH THE NETWORK, which is exactly what 1120 holds. It
 * becomes an expense only if we lose AND choose not to take it back (5200), and
 * it becomes cash only when a scheme file funds it — which is why nothing here
 * ever debits 1110. The chart's own note on 1110 forbids it: cash is debited
 * "when funds actually land there and never when a provider merely promises
 * them". Winning a dispute is a promise.
 */
export const DISPUTE_RECEIVABLE_CODE = "1120";

/** 5200, `Losses — chargebacks and write-offs`. Its own note names this case. */
export const DISPUTE_LOSS_CODE = "5200";

/** 9900, the other side of every memo posting. */
export const MEMO_CONTRA_CODE = "9900";

// ---------------------------------------------------------------------------
// The postings
// ---------------------------------------------------------------------------

/**
 * One line of an entry, in the ledger's own convention:
 * A DEBIT IS POSITIVE, A CREDIT IS NEGATIVE. One signed column.
 */
export interface PostingLine {
  readonly accountId: string;
  readonly amountCents: bigint;
  readonly memo: string;
}

export interface DisputeAccounts {
  /** The customer's 2100 deposit leaf. Credit-normal: a DEBIT takes money away. */
  readonly customerAccountId: string;
  /** The customer's 9200 uncleared-credit memo leaf. */
  readonly memoAccountId: string;
  /** House 1120. */
  readonly receivableAccountId: string;
  /** House 5200. */
  readonly lossAccountId: string;
  /** House 9900. */
  readonly memoContraAccountId: string;
}

function assertPositive(amountCents: bigint): void {
  if (amountCents <= 0n) {
    throw new RangeError(`a dispute posting needs a positive amount, got ${amountCents}`);
  }
}

/**
 * Provisional credit: the customer's balance goes UP, and we carry a claim
 * against the network.
 *
 *   CR 2100/<business>   the customer is owed more     (negative)
 *   DR 1120              the network owes us           (positive)
 *
 * Nothing here touches 1110 and nothing here touches 2200. The original
 * clearing already credited 2200 and that obligation stands — we paid the
 * merchant, and whether we get it back is what the dispute is about.
 */
export function provisionalCreditLines(
  accounts: DisputeAccounts,
  amountCents: bigint,
): readonly PostingLine[] {
  assertPositive(amountCents);
  return [
    {
      accountId: accounts.customerAccountId,
      amountCents: -amountCents,
      memo: "Provisional credit — reversible while the network decides",
    },
    {
      accountId: accounts.receivableAccountId,
      amountCents,
      memo: "Chargeback filed with the card network",
    },
  ];
}

/**
 * The clawback: the exact mirror of the grant, AT A DIFFERENT VALUE DATE.
 *
 *   DR 2100/<business>   the customer repays the advance   (positive)
 *   CR 1120              the claim is extinguished          (negative)
 *
 * The lines are the grant's lines negated, and that is the only thing this
 * shares with a reversal. It is NOT `reverseAndRebook`: a reversal carries the
 * ORIGINAL entry's value date, which would erase the grant from the day we told
 * the customer it had happened. The grant was correct on its day; the network's
 * verdict is a new fact on a new day. See the header of 0019_disputes.sql.
 */
export function clawbackLines(
  accounts: DisputeAccounts,
  amountCents: bigint,
): readonly PostingLine[] {
  assertPositive(amountCents);
  return [
    {
      accountId: accounts.customerAccountId,
      amountCents,
      memo: "Provisional credit recovered — dispute lost",
    },
    {
      accountId: accounts.receivableAccountId,
      amountCents: -amountCents,
      memo: "Chargeback claim extinguished — network decided for the merchant",
    },
  ];
}

/**
 * The write-off: we lost, and we are NOT taking it back off the customer.
 *
 *   DR 5200   the loss is ours                       (positive)
 *   CR 1120   the claim is extinguished              (negative)
 *
 * The customer's deposit account is untouched. Somebody always eats a lost
 * dispute, and this function and `clawbackLines` are the two answers to who —
 * made explicit, and chosen by a human, rather than assumed by whoever wrote
 * the code.
 */
export function writeOffLines(
  accounts: DisputeAccounts,
  amountCents: bigint,
): readonly PostingLine[] {
  assertPositive(amountCents);
  return [
    {
      accountId: accounts.lossAccountId,
      amountCents,
      memo: "Dispute lost and absorbed rather than recovered from the customer",
    },
    {
      accountId: accounts.receivableAccountId,
      amountCents: -amountCents,
      memo: "Chargeback claim extinguished — network decided for the merchant",
    },
  ];
}

/**
 * A final credit posted on a WIN where provisional credit was never granted.
 *
 * Identical lines to a grant, and a completely different fact: there is no hold
 * behind it, because there is nothing left to decide. The customer can spend it
 * the moment it lands.
 */
export function finalCreditLines(
  accounts: DisputeAccounts,
  amountCents: bigint,
): readonly PostingLine[] {
  assertPositive(amountCents);
  return [
    {
      accountId: accounts.customerAccountId,
      amountCents: -amountCents,
      memo: "Dispute won — credit posted final",
    },
    {
      accountId: accounts.receivableAccountId,
      amountCents,
      memo: "Chargeback recovered from the card network",
    },
  ];
}

/**
 * The memo pair that opens or releases the hold.
 *
 * Positive `deltaCents` OPENS or grows the hold; negative RELEASES it. The 9200
 * leaf is credit-normal, so a POSITIVE delta is a NEGATIVE `amount_cents` on
 * that line. That inversion is the classic error in this codebase's own words
 * (see `postHoldDelta` in src/lib/holds/store.ts) and it lives in exactly one
 * place per subsystem.
 */
export function holdLines(
  accounts: DisputeAccounts,
  deltaCents: bigint,
): readonly PostingLine[] {
  if (deltaCents === 0n) {
    throw new RangeError("a zero memo delta posts nothing; the caller must not call this");
  }
  return [
    {
      accountId: accounts.memoAccountId,
      amountCents: -deltaCents,
      memo: deltaCents > 0n ? "Provisional credit withheld" : "Provisional credit hold released",
    },
    {
      accountId: accounts.memoContraAccountId,
      amountCents: deltaCents,
      memo: "Memo contra",
    },
  ];
}

// ---------------------------------------------------------------------------
// Which transitions are legal — mirrored from the trigger
// ---------------------------------------------------------------------------

/** What the fold in `v_dispute_state` knows, as far as the rules care. */
export interface DisputeFold {
  readonly status: DisputeStatus;
  readonly granted: boolean;
  readonly declined: boolean;
  readonly decided: boolean;
  readonly needsAuthorization: boolean;
  readonly authorizations: number;
  readonly requiredApprovals: number;
}

export type TransitionVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly message: string };

const ALLOW: TransitionVerdict = { allowed: true };

function refuse(code: string, message: string): TransitionVerdict {
  return { allowed: false, code, message };
}

/**
 * May this transition be attempted?
 *
 * Advisory only. The database decides — see the module header. Every refusal
 * here has a matching `RAISE EXCEPTION` in `assert_dispute_lifecycle()`.
 */
export function canTransition(
  fold: DisputeFold,
  kind: Exclude<DisputeEventKind, "raised">,
): TransitionVerdict {
  if (isClosed(fold.status)) {
    return refuse("DISPUTE_CLOSED", "This case is closed. Nothing may follow a resolution.");
  }

  switch (kind) {
    case "provisional_credit_authorized":
    case "provisional_credit_granted":
    case "provisional_credit_declined": {
      if (fold.decided) {
        return refuse(
          "ALREADY_DECIDED",
          "The network has already decided this case; provisional credit is not available any more.",
        );
      }
      if (fold.granted || fold.declined) {
        return refuse(
          "CREDIT_ALREADY_SETTLED",
          "The question of provisional credit has already been settled on this case.",
        );
      }
      if (
        kind === "provisional_credit_granted" &&
        fold.needsAuthorization &&
        fold.authorizations < fold.requiredApprovals
      ) {
        return refuse(
          "NEEDS_AUTHORIZATION",
          `This advance is at or above the threshold and needs ${fold.requiredApprovals} ` +
            `authorisation(s) from a Corgi approver who did not raise it; it has ${fold.authorizations}.`,
        );
      }
      return ALLOW;
    }

    case "evidence_submitted":
      return fold.decided
        ? refuse("ALREADY_DECIDED", "The network has already decided; evidence cannot be filed now.")
        : ALLOW;

    case "won":
    case "lost":
      return fold.decided ? refuse("ALREADY_DECIDED", "This case has already been decided.") : ALLOW;

    case "withdrawn": {
      if (fold.decided) return refuse("ALREADY_DECIDED", "This case has already been decided.");
      if (fold.granted) {
        return refuse(
          "CREDIT_OUTSTANDING",
          "Provisional credit is outstanding, so this is not a withdrawal — it is a loss. " +
            "Record the case lost, then claw back or write off.",
        );
      }
      return ALLOW;
    }

    case "credit_finalized":
      return fold.status === "won_pending_finalization"
        ? ALLOW
        : refuse("NOT_WON", "A credit can only be made final on a case the network decided for us.");

    case "credit_clawed_back":
    case "credit_written_off": {
      if (fold.status !== "lost_pending_recovery") {
        return refuse("NOT_LOST", "This only applies to a case the network decided against us.");
      }
      if (!fold.granted) {
        return refuse(
          "NOTHING_ADVANCED",
          "No provisional credit was ever advanced on this case, so there is nothing to recover.",
        );
      }
      return ALLOW;
    }

    default: {
      const exhaustive: never = kind;
      return refuse("UNKNOWN_TRANSITION", String(exhaustive));
    }
  }
}

/**
 * The case reference an operator reads out on the phone.
 *
 * Derived from the value date and a short random suffix, and deliberately NOT
 * the dispute's uuid: a customer has to be able to say it, and a uuid is not
 * something anyone says.
 */
export function caseRef(valueDate: string, suffix: string): string {
  return `DSP-${valueDate.replaceAll("-", "")}-${suffix.toUpperCase()}`;
}

/**
 * The network's outside date: the day by which the network will have finished
 * with the case, one way or the other.
 *
 * 120 days from the claim, which is the outer edge of the Visa dispute
 * lifecycle once representment and pre-arbitration are allowed for. This drives
 * AGEING ON A SCREEN and nothing else — in particular it is NOT the hold's
 * `available_at`, which is `'infinity'`, because a hold released by a clock
 * would make an invariant view fire on an ordinary business condition. See
 * 0019_disputes.sql §2.
 */
export const NETWORK_OUTSIDE_DAYS = 120;

export function networkOutsideDate(valueDate: string, days = NETWORK_OUTSIDE_DAYS): string {
  const at = new Date(`${valueDate}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) throw new RangeError(`not a value date: ${valueDate}`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
