/**
 * `POST /api/v1/payments` and `GET /api/v1/payments/{id}`.
 *
 * ===========================================================================
 * THIS ENDPOINT DOES NOT PAY ANYONE
 * ===========================================================================
 *
 * It writes one `payment_instruction` row and one `requested` event,
 * attributed to the non-approving actor the token resolves to. That is the
 * whole of its effect. `status` is `queued_for_human_approval`, the only value
 * it can produce, and `money_moved` is `false` on every successful response —
 * not as reassurance, but because the caller is frequently a piece of software
 * that will relay "payment created" to a person as "your payment has been
 * sent" unless the field names make that impossible.
 *
 * What makes it structural rather than a promise:
 *
 *   - It cannot post to the journal. Money moves only through
 *     `ledger_append()`; nothing in `src/lib/api/**` imports `postEntry`, and
 *     `no-write-imports.test.ts` in this directory fails the build if anyone
 *     adds it. Nothing downstream of a `requested` event calls it either — the
 *     entry is a consequence of a HUMAN releasing the instruction.
 *
 *   - It cannot approve what it queued. `actor` carries
 *     `CHECK (NOT (kind <> 'human' AND can_approve))`, so an approving
 *     non-human is not a row Postgres will store; `assert_maker_checker()`
 *     independently refuses an `approved` event from a non-human, from the
 *     initiator, or citing the wrong content hash; and
 *     `pie_one_decision_per_actor` stops one actor approving twice to satisfy
 *     a two-approver rule. Four refusals, none of them in TypeScript.
 *
 *   - It cannot change the counterparty afterwards. `content_hash` is sha256
 *     over (account, rail, amount, currency, destination, value date) and an
 *     approval must cite that hash. Changing any of those produces a DIFFERENT
 *     instruction rather than an amended one, so "approve $100, submit
 *     $10,000" has no representation in this schema.
 *
 * ===========================================================================
 * IDEMPOTENCY: THE SAME KEY, THE SAME ANSWER, AND A 409 WHEN IT ISN'T
 * ===========================================================================
 *
 * `Idempotency-Key` is REQUIRED. It is namespaced by tenant and actor before
 * it reaches the database, so one integration's key can never collide with —
 * or be used to probe for — another's instruction.
 *
 * The replay itself is decided by `payment_instruction.idempotency_key UNIQUE`
 * and an `ON CONFLICT DO NOTHING`, not by an `if` in application code: a
 * concurrent double-POST has one winner at the index, and the loser reads the
 * winner's row back. The response to a replay is byte-identical except for
 * `replayed: true` and the HTTP status (200 rather than 201).
 *
 * THE CASE THAT MATTERS MORE. `requestPayment()` returns the ORIGINAL
 * instruction for a replayed key whatever the new body said. On a machine-to-
 * machine surface that is a live hazard: an integrator who reuses last week's
 * invoice key for a different amount would receive a confident 200 describing
 * a payment they did not ask for, and would reconcile against it. So this
 * endpoint computes the content hash of the REQUEST — with `contentHash()`
 * from `@/lib/approvals/hash`, the same canonicalisation the database stored,
 * never a second one — and compares it to the hash on the row that came back.
 * A mismatch is `409 IDEMPOTENCY_KEY_REUSED`, naming both hashes, and the new
 * request is not queued. Nothing was written either way: the conflict is
 * detected after the no-op, so the original instruction is untouched.
 */

import { z } from "zod";

import { contentHash, type PaymentContent } from "@/lib/mcp";
import type { PaymentDestination } from "@/lib/approvals/types";
import { getPayment } from "@/lib/approvals/instructions";
import { ledgerConnection, readAccountIdentity } from "@/lib/ledger/queries";

import { ApiError, badRequest, notFound } from "../errors";
import { money, rejectUnknownParams } from "../http";
import type { ApiContext, RouteResult } from "../handle";

const DEFAULT_ACCOUNT_CODE = "2100";

/** How far ahead an instruction may be dated. Beyond this it is a mandate. */
const MAX_FORWARD_DAYS = 90;

/* -------------------------------------------------------------------------- */
/* The request body                                                           */
/* -------------------------------------------------------------------------- */

/**
 * NOTE WHAT IS ABSENT FROM EVERY DESTINATION SHAPE: a full account number.
 *
 * The approvals module stores `accountNumberLast4` and its comment says why —
 * an approver needs to RECOGNISE a beneficiary, not to be able to re-key the
 * payment somewhere else. This surface honours the rule one layer earlier: an
 * HTTP caller never hands us a full account number, so a compromised
 * integration cannot exfiltrate one from a response it triggers, and the audit
 * log cannot accidentally become the most sensitive store in the system.
 *
 * `routing_number` IS taken in full and is deliberately not redacted anywhere:
 * an ABA routing number is published by the Federal Reserve and is exactly
 * what an investigator needs to identify the receiving institution.
 */
const achDestination = z.strictObject({
  type: z.literal("ach"),
  holder_name: z.string().min(1).max(140),
  routing_number: z.string().regex(/^[0-9]{9}$/, { error: "routing_number must be 9 digits" }),
  account_number_last4: z.string().regex(/^[0-9]{4}$/, {
    error: "the LAST FOUR digits only; this surface never takes a full account number",
  }),
  account_type: z.enum(["checking", "savings"]),
});

/**
 * A wire is routed on the WIRE ABA, and it is required here.
 *
 * A domestic Fedwire beneficiary is addressed by a 9-digit ABA, and
 * specifically by the WIRE variant of it — a DIFFERENT number from the same
 * bank's ACH variant. The seeded Plaid item carries `011401533` for ACH and
 * `021000021` for wire; substituting one for the other comes back as an R13
 * days later, on a rail that has no way back.
 *
 * `bic` is optional and cannot substitute: a BIC identifies a bank on the
 * SWIFT network, which is a cross-border fact, and Fedwire does not read it.
 * `gatePaymentOnPayee()` refuses a new wire with no wire routing number
 * (`PAYEE_WIRE_ROUTING_NUMBER_MISSING`), so requiring it here turns a refusal
 * three layers down into a schema error the integrator can fix from the
 * message.
 */
const wireDestination = z.strictObject({
  type: z.literal("wire"),
  holder_name: z.string().min(1).max(140),
  // The message is attached to the TYPE as well as the pattern: the mistake
  // this field exists to catch is OMITTING it and sending a BIC instead, and
  // zod's default for a missing field ("expected string, received undefined")
  // would tell an integrator nothing about why a BIC will not do.
  wire_routing_number: z
    .string({
      error:
        "wire_routing_number is required: it is the receiving bank's 9-digit WIRE ABA, which is a DIFFERENT number from the same bank's ACH ABA. A BIC is not a substitute — it identifies a bank on the SWIFT network and Fedwire does not read it — and a wire without this is refused by the payee gate before anything is queued.",
    })
    .regex(/^[0-9]{9}$/, {
      error: "wire_routing_number is the receiving bank's 9-digit WIRE ABA",
    }),
  bic: z.string().min(8).max(11).optional(),
  account_number_last4: z.string().regex(/^[0-9]{4}$/, { error: "the LAST FOUR digits only" }),
});

const usdcDestination = z.strictObject({
  type: z.literal("usdc"),
  chain: z.enum(["ethereum", "base", "base-sepolia", "solana", "polygon"]),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, {
    error: "address must be a 0x-prefixed 20-byte hex address",
  }),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "expected a date as YYYY-MM-DD" })
  .refine(
    (v) => {
      const parsed = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
    },
    { error: "not a real calendar date" },
  );

const bodySchema = z
  .strictObject({
    // `card` is not an origination rail — a card movement starts at a network,
    // not at a person. `internal` is absent for a different reason: its seeded
    // policy requires ZERO approvals, which would make it the one rail on this
    // surface where a queued instruction could be released with no human
    // having approved anything. See docs/API.md §Refused operations.
    rail: z.enum(["ach", "usdc", "wire"]),
    // The message is attached to the TYPE check as well as the pattern,
    // deliberately. Sending `"amount_cents": 125000` as a JSON number is the
    // single most likely integration mistake on this endpoint, and zod's
    // default for it — "expected string, received number" — is exactly the
    // wrong answer: it reads like pedantry rather than like the reason.
    amount_cents: z
      .string({
        error:
          'amount_cents is a positive integer number of CENTS as a decimal STRING, e.g. "125000" for $1,250.00 — not dollars, and NOT a JSON number: JSON.parse produces a double, and a double cannot represent every cent value',
      })
      .regex(/^[1-9][0-9]{0,15}$/, {
        error:
          'amount_cents is a positive integer number of CENTS as a decimal STRING, e.g. "125000" for $1,250.00 — no decimal point, no currency symbol, no leading zero, and no sign',
      }),
    currency: z.literal("USD").optional(),
    destination: z.discriminatedUnion("type", [achDestination, wireDestination, usdcDestination]),
    value_date: isoDate.optional(),
    // FOUR DIGITS ONLY, which excludes pots (`2100.<uuid>`) on purpose.
    // GET /api/v1/accounts marks each account `payable` and carries the
    // argument: available balance is a control input, and an integration that
    // can debit the payroll pot directly has moved money out of the number
    // every other funding decision is judged against, with nothing on the pots
    // screen to show for it.
    account_code: z
      .string()
      .regex(/^[0-9]{4}$/, {
        error:
          'account_code is a four-digit chart-of-accounts code such as "2100". Account uuids are not accepted, and a pot ("2100.<uuid>") is readable but not payable — see `payable` and `payable_note` on GET /api/v1/accounts',
      })
      .optional(),
    reason: z.string().min(8).max(500),
  })
  .refine((v) => v.rail === v.destination.type, {
    error: "the destination type must match the rail",
    path: ["destination", "type"],
  });

type Body = z.infer<typeof bodySchema>;

/** `[A-Za-z0-9._:-]{8,120}`. Derived from a fact, not generated per attempt. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,120}$/;

/* -------------------------------------------------------------------------- */
/* POST /api/v1/payments                                                      */
/* -------------------------------------------------------------------------- */

export async function createPaymentRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, []);

  const idempotencyKey = requireIdempotencyKey(ctx.request.headers);
  const body = parseBody(ctx.body ?? {});

  const amountCents = BigInt(body.amount_cents);
  const currency = body.currency ?? "USD";

  if (ctx.grant.maxInstructionCents !== null && amountCents > ctx.grant.maxInstructionCents) {
    // A per-token ceiling. Authentication says who you are; this says how big
    // a thing you may put in front of a person.
    throw new ApiError({
      status: 422,
      type: "unprocessable",
      code: "ABOVE_TOKEN_CEILING",
      message: `this token may queue at most ${money(ctx.grant.maxInstructionCents).display} per instruction; ${money(amountCents).display} was requested`,
      condition: "amount_cents <= the per-instruction ceiling on this token",
      resolution:
        "The ceiling bounds how large a thing this integration may put in front of a human approver, and it is a property of the credential rather than of the account. A larger one is an operator decision made when the token is issued.",
      details: { requested: money(amountCents), ceiling: money(ctx.grant.maxInstructionCents) },
    });
  }

  const valueDate = body.value_date ?? ctx.bookToday;
  if (valueDate < ctx.bookToday) {
    throw badRequest(
      "VALUE_DATE_IN_THE_PAST",
      `value_date ${valueDate} is before today (${ctx.bookToday}, book time)`,
      "value_date >= today in book time (America/New_York)",
      "Backdating money out is not a correction, it is a claim that a payment already happened. Send today's date or a future one. A genuine correction is a reversal plus a re-book, performed by a person; this API can post neither.",
      { value_date: valueDate, book_today: ctx.bookToday },
    );
  }
  const latest = addDays(ctx.bookToday, MAX_FORWARD_DAYS);
  if (valueDate > latest) {
    throw badRequest(
      "VALUE_DATE_TOO_FAR_AHEAD",
      `value_date ${valueDate} is more than ${MAX_FORWARD_DAYS} days ahead; the latest acceptable date is ${latest}`,
      `value_date <= today + ${MAX_FORWARD_DAYS} days`,
      "Beyond 90 days this is a standing-order mandate rather than a payment, and mandates are not writable through this API — a mandate is a thing that writes payments, and this surface may write a request but never a thing that writes requests.",
      { value_date: valueDate, latest_acceptable: latest },
    );
  }

  const code = body.account_code ?? DEFAULT_ACCOUNT_CODE;
  const account = await ctx.gateway.findAccount(ctx.grant.businessId, code);
  if (account === null) {
    throw notFound(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with code ${code}`,
      "account_code names an open account belonging to this token's business",
      "GET /api/v1/accounts lists every code this token can name. House accounts — the pooled FBO cash account and the rail control accounts — are not addressable through this surface at all.",
      { account_code: code },
    );
  }
  if (!account.isPostable || account.book !== "financial") {
    throw new ApiError({
      status: 422,
      type: "unprocessable",
      code: "ACCOUNT_NOT_PAYABLE",
      message: `account ${code} (${account.name}) is a ${account.book}-book or non-postable account and cannot fund a payment`,
      condition: "the debit account is postable and on the financial book",
      resolution:
        "Memo-book accounts carry holds, not money. Use the business current account (code 2100); GET /api/v1/accounts marks every account with `payable`.",
      details: { account_code: code, book: account.book, postable: account.isPostable },
    });
  }

  // PRE-FLIGHT ONLY, and the response says so. The binding funds check is at
  // RELEASE, against the balance at that moment — an available balance from
  // thirty seconds ago is a fact about the past, and a card authorisation can
  // land in between. Refusing here anyway, because putting a payment that
  // cannot fund in front of an approver wastes the scarcest resource in this
  // design.
  const snapshot = await ctx.gateway.balanceNow(ctx.grant.businessId, account.accountId);
  if (amountCents > snapshot.availableCents) {
    throw new ApiError({
      status: 422,
      type: "unprocessable",
      code: "INSUFFICIENT_AVAILABLE_FUNDS",
      message: `${money(amountCents).display} exceeds the available balance of ${money(snapshot.availableCents).display} on account ${code}. Nothing was queued.`,
      condition: "amount_cents <= available_cents on the debit account",
      resolution:
        "GET /api/v1/accounts/" +
        code +
        "/balance returns the same figure with the difference itemised — open card authorisations, operator holds, uncleared credits, and debits already booked to leave. Either reduce the amount or wait for the named term to clear. This is ledger_availability(), the same function the customer's own screen uses, so it can never read higher than what they are shown.",
      details: {
        requested: money(amountCents),
        available: money(snapshot.availableCents),
        ledger: money(snapshot.ledgerCents),
        held: money(snapshot.holdsCents + snapshot.unclearedCents + snapshot.pendingOutboundCents),
      },
    });
  }

  const destination = toDestination(body);

  // THE HASH OF WHAT WAS ASKED FOR, computed before the call, with the
  // system's own canonicalisation. See the header: this is what turns a
  // silently-wrong replay into a 409.
  const requested: PaymentContent = {
    accountId: account.accountId,
    rail: body.rail,
    amountCents,
    currency,
    destination,
    valueDate,
  };
  const expectedHash = contentHash(requested);

  // Namespaced by tenant and by actor. One integration's "INV-2026-0041" can
  // never collide with, or probe for, another's.
  const namespacedKey = `api:${ctx.grant.businessId}:${ctx.grant.actorId}:${idempotencyKey}`;

  // Everything from here is the approvals module's: it picks the policy
  // version in force on the value date, computes the content hash over its own
  // canonical preimage, writes the instruction and its `requested` event in
  // one transaction, and folds the state back out of the event stream. Nothing
  // about payments is re-implemented on this surface.
  const queued = await ctx.gateway.queuePayment({
    accountId: account.accountId,
    rail: body.rail,
    amountCents,
    currency,
    destination,
    valueDate,
    requestedByActorId: ctx.grant.actorId,
    idempotencyKey: namespacedKey,
  });

  if (queued.replayed && queued.contentHash !== expectedHash) {
    throw new ApiError({
      status: 409,
      type: "conflict",
      code: "IDEMPOTENCY_KEY_REUSED",
      message: `Idempotency-Key "${idempotencyKey}" is already attached to a DIFFERENT payment. Nothing was queued and the original instruction is unchanged.`,
      condition:
        "an Idempotency-Key seen before is replayed with the same account, rail, amount, currency, destination and value date",
      resolution:
        "A key identifies a payment, not an attempt. Retrying a timed-out call with the same key and the same body is safe and returns the original response; the same key with a different body is a different payment and needs a different key — derive it from the fact that caused the payment (an invoice number, a payroll run id), never generate one per attempt. GET /api/v1/payments/" +
        queued.instructionId +
        " shows what that key is already attached to.",
      details: {
        idempotency_key: idempotencyKey,
        existing_instruction_id: queued.instructionId,
        existing_content_hash: queued.contentHash,
        requested_content_hash: expectedHash,
        content_hash_covers: [
          "account",
          "rail",
          "amount_cents",
          "currency",
          "destination",
          "value_date",
        ],
      },
    });
  }

  const body_ = serialisePayment(ctx, {
    account,
    amountCents,
    currency,
    rail: body.rail,
    valueDate,
    queued,
    destination,
  });

  return {
    // 201 for a row that was written, 200 for a replay that wrote nothing.
    // The distinction is real and free, and it lets an integrator detect a
    // duplicate delivery without diffing bodies.
    status: queued.replayed ? 200 : 201,
    body: { ...body_, request_id: ctx.requestId },
    headers: {
      "idempotency-replayed": queued.replayed ? "true" : "false",
      location: `/api/v1/payments/${queued.instructionId}`,
    },
    audit: {
      instruction_id: queued.instructionId,
      replayed: queued.replayed,
      content_hash: queued.contentHash,
      money_moved: false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* GET /api/v1/payments/{id}                                                  */
/* -------------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same answer for an id that does not exist and an id belonging to another
 * business.
 *
 * Not a 403. A distinguishable refusal tells a caller that an id is REAL,
 * which is the first half of an enumeration attack against a uuid space
 * someone might otherwise assume is unguessable. `mcp/auth.ts` makes exactly
 * this call about unknown versus revoked tokens, for the same reason.
 */
function noSuchInstruction(id: string): ApiError {
  return notFound(
    "NO_SUCH_INSTRUCTION",
    "no payment instruction with that id belongs to this business",
    "the instruction exists AND its debit account belongs to this token's business",
    "The answer is identical for an id that does not exist and an id belonging to another business — telling them apart would let a caller confirm which ids are real. Use the id returned by POST /api/v1/payments.",
    { payment_id: id.slice(0, 64) },
  );
}

/**
 * One instruction, with its whole event stream.
 *
 * THE TENANT CHECK IS MADE HERE, EXPLICITLY, and it is the one place on this
 * surface where that is true. `getPayment()` is not scoped to a business —
 * the console calls it with a session that has already been scoped — so this
 * route resolves the instruction's debit account through the ledger's own
 * `readAccountIdentity` and compares `business_id` to the grant.
 *
 * An instruction belonging to another business produces the SAME 404 as one
 * that does not exist. Not a 403: a distinguishable answer tells a caller that
 * an id is real, which is the first half of an enumeration attack against a
 * uuid space someone might otherwise think is unguessable.
 */
export async function getPaymentRoute(ctx: ApiContext, id: string): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, []);

  const trimmed = id.trim();
  if (!UUID.test(trimmed)) throw noSuchInstruction(trimmed);

  const conn = await ledgerConnection();
  const stored = await getPayment(trimmed, conn);
  if (!stored.ok) throw noSuchInstruction(trimmed);
  const queued = stored.value;

  // THE TENANT CHECK. Resolved through the ledger's own account reader and
  // compared to the grant — not inferred from the fact that the id was
  // guessable, and not delegated to `getPayment`, which is deliberately not
  // business-scoped because the console calls it with an already-scoped
  // session.
  const identity = await readAccountIdentity(queued.instruction.accountId, conn);
  if (identity === null || identity.businessId !== ctx.grant.businessId) {
    throw noSuchInstruction(trimmed);
  }

  return {
    status: 200,
    body: {
      ...serialisePaymentRow(ctx, queued),
      request_id: ctx.requestId,
    },
    audit: { instruction_id: queued.instruction.id, state: queued.state },
  };
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

type Queued = Awaited<ReturnType<ApiContext["gateway"]["queuePayment"]>>;
type Stored = Extract<Awaited<ReturnType<typeof getPayment>>, { ok: true }>["value"];

function serialisePayment(
  ctx: ApiContext,
  args: {
    readonly account: { readonly code: string; readonly name: string };
    readonly amountCents: bigint;
    readonly currency: string;
    readonly rail: string;
    readonly valueDate: string;
    readonly queued: Queued;
    readonly destination: PaymentDestination;
  },
): Record<string, unknown> {
  const { queued } = args;
  return {
    object: "payment",
    id: queued.instructionId,
    /** The ONLY status this endpoint can produce. There is no code path here that pays. */
    status: "queued_for_human_approval",
    state: queued.state,
    money_moved: false,
    replayed: queued.replayed,
    content_hash: queued.contentHash,
    requested_at: queued.requestedAt,
    requested_by: { actor_id: ctx.grant.actorId, kind: "agent", can_approve: false },
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    debit_account: { code: args.account.code, name: args.account.name },
    amount: money(args.amountCents),
    currency: args.currency,
    rail: args.rail,
    value_date: args.valueDate,
    destination: describeDestination(args.destination),
    approval: {
      policy_id: queued.policy.policyId,
      policy_version: queued.policy.version,
      effective_from: queued.policy.effectiveFrom,
      threshold: money(queued.policy.thresholdCents),
      above_threshold: queued.aboveThreshold,
      required_human_approvals: queued.approvalsRequired,
      approvals_held: queued.approvalsHeld,
      policy_note: queued.policy.note,
      self_approval_possible: false,
      enforced_by: ENFORCED_BY,
    },
    what_happens_next:
      queued.approvalsRequired === 0
        ? `This instruction is below the ${money(queued.policy.thresholdCents).display} threshold for ${queued.policy.rail} under policy ${queued.policy.version}, so policy requires no second human. It is still queued and unreleased: this API has no operation that approves, submits or releases a payment, and nothing leaves the account until a person releases it in the approval queue.`
        : `A human approver who is not the initiator must approve this instruction ${queued.approvalsRequired === 1 ? "once" : `${queued.approvalsRequired} times, by ${queued.approvalsRequired} distinct people`} before it can be released. The credential that requested it cannot be one of them.`,
    links: { self: `/api/v1/payments/${queued.instructionId}` },
  };
}

function serialisePaymentRow(ctx: ApiContext, stored: Stored): Record<string, unknown> {
  const { instruction } = stored;
  return {
    object: "payment",
    id: instruction.id,
    state: stored.state,
    money_moved: stored.events.some((e) => e.kind === "released" || e.kind === "settled"),
    content_hash: instruction.contentHash,
    requested_at: instruction.requestedAt,
    requested_by: {
      actor_id: instruction.requestedByActorId,
      name: instruction.requestedByName,
      kind: instruction.requestedByKind,
    },
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    debit_account: { name: instruction.accountName },
    amount: money(instruction.amountCents),
    currency: instruction.currency,
    rail: instruction.rail,
    value_date: instruction.valueDate,
    destination: describeDestination(instruction.destination),
    approval: {
      policy_id: instruction.policy.id,
      policy_version: instruction.policy.version,
      effective_from: instruction.policy.effectiveFrom,
      threshold: money(instruction.policy.thresholdCents),
      above_threshold: stored.aboveThreshold,
      required_human_approvals: stored.approvalsRequired,
      approvals_held: stored.approvalsHeld,
      policy_note: instruction.policy.note,
      self_approval_possible: false,
      enforced_by: ENFORCED_BY,
    },
    // THE WHOLE LIFECYCLE, appended never edited. An integrator polling this
    // sees a release as a new event rather than as a status field that
    // changed, which is the difference between a feed they can reconcile and
    // one they have to trust.
    events: stored.events.map((event) => ({
      kind: event.kind,
      actor: { id: event.actorId, name: event.actorName, kind: event.actorKind },
      approved_content_hash: event.approvedContentHash,
      reason: event.reason,
      value_date: event.valueDate,
      occurred_at: event.occurredAt,
      entry_id: event.entryId,
    })),
    links: { self: `/api/v1/payments/${instruction.id}` },
  };
}

const ENFORCED_BY: readonly string[] = [
  "actor.actor_only_humans_approve — CHECK (NOT (kind <> 'human' AND can_approve)): an approving non-human is not a storable row",
  "assert_maker_checker() — refuses an 'approved' event whose actor is not a human approver",
  "assert_maker_checker() — refuses an 'approved' event whose actor is the initiator",
  "assert_maker_checker() — refuses an 'approved' event citing a different content_hash",
  "payment_instruction_event.pie_one_decision_per_actor — one actor cannot approve twice to satisfy a two-approver rule",
  "src/lib/api/no-write-imports.test.ts — this surface imports no function that approves, releases or posts",
];

/** One line an approver — or an integrator's log — can recognise. */
function describeDestination(destination: PaymentDestination): Record<string, unknown> {
  switch (destination.type) {
    case "ach":
      return {
        type: "ach",
        holder_name: destination.holderName,
        routing_number: destination.routingNumber,
        account_number_last4: destination.accountNumberLast4,
        account_type: destination.accountType,
        display: `${destination.holderName} (ACH ${destination.routingNumber} ••${destination.accountNumberLast4})`,
      };
    case "wire":
      return {
        type: "wire",
        holder_name: destination.holderName,
        // Both are rendered, and the wire ABA first, because it is what the
        // money is routed on. Rows written before `wireRoutingNumber` existed
        // carry only a BIC and say so rather than looking complete.
        wire_routing_number: destination.wireRoutingNumber ?? null,
        bic: destination.bic ?? null,
        account_number_last4: destination.accountNumberLast4,
        display:
          `${destination.holderName} (wire ` +
          (destination.wireRoutingNumber === undefined
            ? destination.bic === undefined
              ? "no bank identifier"
              : `BIC ${destination.bic}, no wire ABA on this instruction`
            : `${destination.wireRoutingNumber}${destination.bic === undefined ? "" : ` · BIC ${destination.bic}`}`) +
          ` ••${destination.accountNumberLast4})`,
      };
    case "usdc":
      return {
        type: "usdc",
        chain: destination.chain,
        address: destination.address,
        display: `${destination.address.slice(0, 6)}…${destination.address.slice(-4)} on ${destination.chain}`,
      };
    case "internal":
      return {
        type: "internal",
        holder_name: destination.holderName,
        display: `${destination.holderName} (internal book transfer)`,
      };
  }
}

function toDestination(body: Body): PaymentDestination {
  switch (body.destination.type) {
    case "ach":
      return {
        type: "ach",
        holderName: body.destination.holder_name,
        routingNumber: body.destination.routing_number,
        accountNumberLast4: body.destination.account_number_last4,
        accountType: body.destination.account_type,
      };
    case "wire":
      return {
        type: "wire",
        holderName: body.destination.holder_name,
        wireRoutingNumber: body.destination.wire_routing_number,
        ...(body.destination.bic === undefined ? {} : { bic: body.destination.bic }),
        accountNumberLast4: body.destination.account_number_last4,
      };
    case "usdc":
      return {
        type: "usdc",
        chain: body.destination.chain,
        address: body.destination.address,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

function requireIdempotencyKey(headers: Headers): string {
  const raw = headers.get("idempotency-key");
  if (raw === null || raw.trim() === "") {
    throw badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "every write on this API requires an Idempotency-Key header",
      "Idempotency-Key is present and matches [A-Za-z0-9._:-]{8,120}",
      'Send Idempotency-Key derived from the FACT that caused this payment — an invoice number, a payroll run id — never generated fresh per attempt. A key per attempt turns one retry after a socket timeout into two payments; a key per fact makes the retry a no-op that returns the original response. The header is required rather than optional because an optional safety mechanism is one that is absent exactly when it is needed.',
    );
  }
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw badRequest(
      "INVALID_IDEMPOTENCY_KEY",
      `Idempotency-Key must be 8-120 characters of [A-Za-z0-9._:-]; received ${key.length} character(s)`,
      "Idempotency-Key matches [A-Za-z0-9._:-]{8,120}",
      "Eight characters minimum, because a short key collides; 120 maximum, because a key longer than that is a payload. Derive it from an invoice number or a payroll run id.",
      { received_length: key.length },
    );
  }
  return key;
}

function parseBody(raw: Record<string, unknown>): Body {
  const parsed = bodySchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((issue) => ({
    field: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    problem: issue.message,
  }));
  const first = problems[0];
  throw badRequest(
    "INVALID_ARGUMENTS",
    first === undefined
      ? "the request body did not validate"
      : `invalid request body: ${first.field} — ${first.problem}`,
    "the body validates against the endpoint's schema",
    "`details.problems` names each field and what was wrong with it. Unknown fields are REFUSED rather than ignored: a caller who sends a field that is silently dropped walks away believing it worked, and the next call they write is the dangerous one.",
    { problems },
  );
}

/** Calendar arithmetic on YYYY-MM-DD, in UTC, with no clock involved. */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
