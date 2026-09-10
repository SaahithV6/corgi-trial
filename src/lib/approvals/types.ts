/**
 * The maker-checker vocabulary.
 *
 * Nothing in this file enforces anything. Every control the feature is graded
 * on lives in `db/migrations/0001_ledger.sql` — the actor CHECK constraint, the
 * self-approval trigger, the approve-the-hash trigger, the one-decision-per-
 * actor unique index — plus the lifecycle trigger added by `0007_approvals.sql`.
 * These are the types the application uses to *talk about* those controls, and
 * the one place the shapes are written down for the MCP write tool.
 *
 * Two rules hold everywhere below:
 *
 *   1. Money is `bigint` minor units. Never a number, never a string carrying a
 *      decimal point, never `numeric`. `payment_instruction.amount_cents` is a
 *      bigint column and `src/lib/ledger/db.ts` parses bigints as bigints on
 *      purpose.
 *   2. A content hash is 32 bytes, carried through the application as lowercase
 *      hex and stored as `bytea`. The database CHECKs the length; the hex form
 *      exists because it has to survive a hidden form field and a JSON payload.
 */

import { z } from "zod";

import type { Rail as LedgerRail } from "@/lib/ledger/post";

/* -------------------------------------------------------------------------- */
/* Rails                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The `rail` enum, restated so that `src/components/**` can name a rail without
 * importing anything that touches a database handle.
 *
 * `RAIL_TYPES_AGREE` is a compile-time assertion, not a runtime value: if
 * someone adds a rail to the ledger's union and not to this one, `pnpm
 * typecheck` fails here instead of a query failing in production.
 */
export const PAYMENT_RAILS = ["ach", "usdc", "wire", "internal", "card"] as const;

export type PaymentRail = (typeof PAYMENT_RAILS)[number];

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Fails to compile if `PaymentRail` and the ledger's `Rail` ever diverge. */
export const RAIL_TYPES_AGREE: Mutual<PaymentRail, LedgerRail> = true;

/**
 * Rails money can leave the bank on.
 *
 * `card` is in the enum because the ledger books card settlement against it,
 * but a card movement is never a payment INSTRUCTION — it originates at a
 * network, not at a person — so it is not offered here.
 */
export const PAYOUT_RAILS = ["ach", "usdc", "wire", "internal"] as const;

export type PayoutRail = (typeof PAYOUT_RAILS)[number];

export function isPayoutRail(value: unknown): value is PayoutRail {
  return PAYOUT_RAILS.some((rail) => rail === value);
}

/* -------------------------------------------------------------------------- */
/* Where the money is going                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The destination, as stored in `payment_instruction.counterparty` (jsonb).
 *
 * A discriminated union rather than a bag of nullable columns, for the same
 * reason `Destination` in `src/lib/rails/types.ts` is one: routing numbers and
 * chain addresses are not the same kind of fact, and a schema that lets an ACH
 * payment carry a wallet address is a schema that will eventually be asked to.
 *
 * NEVER A FULL ACCOUNT NUMBER. The approver needs to recognise the
 * counterparty, not to be able to re-key the payment somewhere else, and this
 * row is read by a screen. Last four plus the holder name is what a payments
 * team actually checks a beneficiary against.
 */
export const destinationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ach"),
    holderName: z.string().min(1),
    routingNumber: z.string().regex(/^\d{9}$/, { error: "routing number is 9 digits" }),
    accountNumberLast4: z.string().regex(/^\d{4}$/, { error: "last four digits only" }),
    accountType: z.enum(["checking", "savings"]),
  }),
  z.object({
    type: z.literal("usdc"),
    chain: z.enum(["ethereum", "base", "base-sepolia", "solana", "polygon"]),
    address: z.string().min(1),
  }),
  z.object({
    type: z.literal("wire"),
    holderName: z.string().min(1),
    bic: z.string().min(1),
    accountNumberLast4: z.string().regex(/^\d{4}$/, { error: "last four digits only" }),
  }),
  z.object({
    type: z.literal("internal"),
    /** The beneficiary's own `account` row. Both legs stay on our book. */
    accountId: z.uuid(),
    holderName: z.string().min(1),
  }),
]);

export type PaymentDestination = z.infer<typeof destinationSchema>;

/** One line an approver can compare against a beneficiary they know. */
export function describeDestination(destination: PaymentDestination): string {
  switch (destination.type) {
    case "ach":
      return `${destination.holderName} · ACH ${destination.routingNumber} ••${destination.accountNumberLast4} (${destination.accountType})`;
    case "wire":
      return `${destination.holderName} · wire ${destination.bic} ••${destination.accountNumberLast4}`;
    case "usdc":
      return `USDC ${destination.chain} · ${destination.address}`;
    case "internal":
      return `${destination.holderName} · internal book transfer`;
  }
}

/* -------------------------------------------------------------------------- */
/* The lifecycle                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every value of `payment_event_kind` after 0007.
 *
 * `submitted` is 0001's name for the release step and is still accepted on the
 * way in; `released` is the name everything written since uses. See
 * `state.ts` for the fold that treats them as one.
 */
export const PAYMENT_EVENT_KINDS = [
  "requested",
  "approved",
  "rejected",
  "submitted",
  "released",
  "settled",
  "returned",
  "failed",
  "cancelled",
] as const;

export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

/**
 * The states a payment can be IN, which is a smaller set than the events that
 * got it there. DESIGN §17: status is a view over events, never a column, so
 * this type is only ever produced by folding `state.ts` over an event list.
 */
export const PAYMENT_STATES = [
  "requested",
  "approved",
  "rejected",
  "cancelled",
  "released",
  "settled",
  "returned",
  "failed",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export type PaymentInstructionEvent = {
  readonly id: string;
  readonly kind: PaymentEventKind;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorKind: ActorKind;
  /** Lowercase hex of the 32-byte hash the actor cited. Only on `approved`. */
  readonly approvedContentHash: string | null;
  readonly reason: string | null;
  readonly valueDate: string;
  readonly occurredAt: string;
  readonly entryId: string | null;
};

export type ActorKind = "human" | "agent" | "system";

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One row of `approval_policy`, which is append-only and effective-dated.
 *
 * `version` is the human-readable name of the row: `(rail, effective_from)` is
 * the table's UNIQUE key, so `ach@2026-01-01` identifies exactly one policy for
 * ever. An instruction stores `policy_id`, so the threshold a payment was
 * judged under is a fact about the payment and not a lookup that a later policy
 * change can silently rewrite.
 */
export type ApprovalPolicy = {
  readonly id: string;
  readonly rail: PaymentRail;
  readonly effectiveFrom: string;
  readonly thresholdCents: bigint;
  readonly requiredApprovals: number;
  readonly note: string;
  /** `ach@2026-01-01`. Stable, sortable, and safe to print on a screenshot. */
  readonly version: string;
};

export function policyVersion(rail: PaymentRail, effectiveFrom: string): string {
  return `${rail}@${effectiveFrom}`;
}

/* -------------------------------------------------------------------------- */
/* The instruction                                                            */
/* -------------------------------------------------------------------------- */

export type PaymentInstruction = {
  readonly id: string;
  readonly accountId: string;
  /** Customer-facing name of the account the money leaves. */
  readonly accountName: string;
  readonly businessName: string | null;
  readonly rail: PayoutRail;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly destination: PaymentDestination;
  readonly valueDate: string;
  readonly requestedByActorId: string;
  readonly requestedByName: string;
  readonly requestedByKind: ActorKind;
  readonly requestedAt: string;
  readonly policy: ApprovalPolicy;
  readonly idempotencyKey: string;
  /** Lowercase hex, 64 characters. The thing an approval must cite. */
  readonly contentHash: string;
};

/**
 * An instruction plus everything the queue screen needs to decide what to
 * render, folded once on the server so a component never re-derives it.
 */
export type QueuedPayment = {
  readonly instruction: PaymentInstruction;
  readonly state: PaymentState;
  readonly events: readonly PaymentInstructionEvent[];
  /** Distinct human approvers who are not the initiator and cited this hash. */
  readonly approvalsHeld: number;
  /** From the policy the instruction cites. 0 below threshold. */
  readonly approvalsRequired: number;
  /** `amount_cents >= policy.threshold_cents`. */
  readonly aboveThreshold: boolean;
};

/* -------------------------------------------------------------------------- */
/* The MCP write tool's input                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What `requestPayment()` takes. Exported as a zod schema, not just a type,
 * because the caller on the other side of this boundary is an MCP tool whose
 * arguments arrive as untyped JSON from a model.
 *
 * `amountCents` accepts a decimal string as well as a bigint for exactly that
 * reason: JSON has no bigint, and `1e21` arriving as a float is how a payments
 * system loses a digit. A float, a fractional value or a non-integer string is
 * refused here rather than rounded three layers down.
 */
export const requestPaymentSchema = z.object({
  /** The customer deposit account the money leaves. */
  accountId: z.uuid(),
  rail: z.enum(PAYOUT_RAILS),
  amountCents: z
    .union([z.bigint(), z.string().regex(/^[1-9]\d*$/, { error: "integer minor units, as digits" })])
    .transform((value) => (typeof value === "bigint" ? value : BigInt(value)))
    .refine((value) => value > 0n, { error: "amount must be positive" }),
  currency: z.literal("USD").default("USD"),
  destination: destinationSchema,
  /** `YYYY-MM-DD`, the date the money should land. Not an instant. */
  valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "value date is YYYY-MM-DD" }),
  /** The actor raising it. An agent id is expected and is fine. */
  requestedByActorId: z.uuid(),
  /**
   * Derived from the SOURCE FACT — the invoice, the payroll run, the tool call
   * id — never from a uuid we just generated. Replaying it returns the original
   * instruction rather than raising a second one.
   */
  idempotencyKey: z.string().min(1).max(200),
});

export type RequestPaymentInput = z.input<typeof requestPaymentSchema>;
export type RequestPaymentArgs = z.output<typeof requestPaymentSchema>;
