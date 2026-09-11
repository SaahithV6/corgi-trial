import "server-only";

/**
 * The live implementation of the payments screen's data contract.
 *
 * It lives under `src/app/(app)/payments/` rather than in `src/lib/` for one
 * reason: `src/lib/**` is owned by another worker on this build and is not mine
 * to extend. Everything else about it follows the pattern
 * `src/lib/approvals/screen.ts` set — one place, and one place only, where
 * database shapes (bigint cents, a `TransactDecision`, an `approval_policy`
 * row) become the flat, JSON-safe shape a React tree renders.
 *
 * Two narrowings happen here and nowhere else:
 *
 *   bigint -> string   a threshold becomes `$2,500.00` HERE, through
 *                      `formatUsd`, because the consumer is a client component
 *                      and the contract deliberately carries no cent counts.
 *                      See the note at the top of `data-contract.ts`.
 *   decision -> view   `canTransact()`'s answer is flattened, never re-derived.
 *                      This module computes no status, no evidence label and no
 *                      permission; it carries values between the database and
 *                      the screen without inventing one.
 *
 * THE GATE READ HERE IS A PREVIEW, NOT THE CONTROL. It is a read, outside any
 * transaction, taken before a person has typed anything. The gate that decides
 * is `transactGateForAccount()` INSIDE `requestPayment()`'s transaction, under
 * the same snapshot that writes the row — so a business approved when this page
 * rendered and revoked a second later is refused at the write, which is the
 * only place it matters.
 */

import type {
  PaymentsDataSource,
  PaymentsSnapshot,
  PolicyOptionView,
  SourceAccountView,
  TransactGateView,
  WirePayeeOption,
} from "@/components/payments/data-contract";
import { listPolicies } from "@/lib/approvals/policy-store";
import { isPayoutRail, type ApprovalPolicy } from "@/lib/approvals/types";
import { BANKING_TIME_ZONE } from "@/lib/format/datetime";
import { formatUsd } from "@/lib/format/money";
import { transactGateForAccount } from "@/lib/kyb/wire";
import type { TransactDecision } from "@/lib/kyb";
import { sql, type Sql } from "@/lib/ledger/db";
import { listDepositAccounts } from "@/lib/ledger/queries";
import { checkRoutingNumber } from "@/lib/payees/aba";
import { loadPayeeBook, type PayeeBookEntry } from "@/lib/payees/store";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

/**
 * Today, in the banking timezone, as `YYYY-MM-DD`.
 *
 * A value date is a calendar date and not an instant (§5), and the calendar
 * that matters is the bank's. `new Date().toISOString().slice(0, 10)` is UTC,
 * which after 20:00 in New York is already tomorrow — so the form would default
 * to a value date a day ahead of the desk that is filling it in.
 */
export function bankingToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANKING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const find = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${find("year")}-${find("month")}-${find("day")}`;
}

function toGateView(decision: TransactDecision): TransactGateView {
  return decision.allowed
    ? {
        allowed: true,
        code: null,
        message:
          "Verification is approved and this deployment's policy accepts the evidence on file. A payment from this account reaches the queue.",
        status: decision.status,
        evidence: decision.evidence,
      }
    : {
        allowed: false,
        code: decision.code,
        message: decision.message,
        status: decision.status,
        evidence: decision.evidence,
      };
}

function toPolicyOption(policy: ApprovalPolicy): PolicyOptionView | null {
  // `approval_policy` is keyed on the whole `rail` enum, which includes `card`
  // — a rail the ledger books settlement against and that no person ever
  // instructs. A policy the form cannot offer is not shown on the form.
  if (!isPayoutRail(policy.rail)) return null;
  return {
    id: policy.id,
    version: policy.version,
    rail: policy.rail,
    effectiveFrom: policy.effectiveFrom,
    thresholdDisplay: formatUsd(policy.thresholdCents),
    requiredApprovals: policy.requiredApprovals,
    note: policy.note,
  };
}

/**
 * One payee-book row, as a wire beneficiary the form can offer.
 *
 * Returns `null` for anything that is not addressable by Fedwire, and the
 * three reasons are each a real refusal one layer down rather than a tidy-up
 * here:
 *
 *   archived          `resolveWireBeneficiary()` filters archived rows out.
 *   no routing number `WIRE_PAYEE_HAS_NO_ROUTING_NUMBER` — a BIC is not a
 *                     Fedwire address.
 *   bad check digit   `WIRE_ROUTING_NUMBER_IMPOSSIBLE`, and
 *                     `gatePaymentOnPayee()` would refuse it first.
 *
 * Offering a beneficiary the origination path is going to refuse is the bug
 * this picker exists to fix, so the filter is the same set of conditions,
 * applied earlier.
 *
 * `wireSupported === false` is deliberately NOT filtered: it is a directory
 * answer that usually means the ACH variant of the routing number has been
 * put in a wire field, and that is a thing a clerk should SEE beside the
 * beneficiary rather than have silently removed from the list. It carries a
 * refusal code instead.
 */
function toWirePayee(entry: PayeeBookEntry): WirePayeeOption | null {
  if (entry.archived) return null;
  if (entry.rail !== "wire") return null;
  const routingNumber = entry.routingNumber;
  if (routingNumber === null) return null;
  if (entry.accountNumberLast4 === null) return null;
  if (!checkRoutingNumber(routingNumber).valid) return null;

  // THE PREDICTION, and the same predicate `gatePaymentOnPayee()` applies —
  // the newest check on this beneficiary warned and nobody has signed for it.
  // A prediction and not the decision: the gate re-runs inside the write
  // transaction, which is where a warning raised a second ago is still seen.
  const gateRefusalCode =
    entry.outcome === "warned" && !entry.acknowledged ? "PAYEE_WARNING_UNACKNOWLEDGED" : null;

  return {
    payeeId: entry.payeeId,
    displayName: entry.displayName,
    holderName: entry.holderName,
    wireRoutingNumber: routingNumber,
    accountNumberLast4: entry.accountNumberLast4,
    institutionName: entry.institutionName,
    outcome: entry.outcome,
    acknowledged: entry.acknowledged,
    freshness: entry.freshness,
    gateRefusalCode,
  };
}

/**
 * The live source.
 *
 * `asOf` is taken once, before the reads, so a screenshot is a consistent
 * statement about one instant rather than a collage of several.
 */
export function createLivePaymentsSource(conn: Sql = sql): PaymentsDataSource {
  return {
    async getFormData(actor): Promise<Result<PaymentsSnapshot, ErrorShape>> {
      const asOf = new Date().toISOString();

      try {
        const [accountRows, policyRows, payeeRows] = await Promise.all([
          listDepositAccounts(conn),
          listPolicies(conn),
          // The whole book, once, rather than one query per account: this is
          // the operator view (`loadPayeeBook({})`) and it is grouped by
          // business below. A read, outside any transaction, exactly like the
          // gate preview above it.
          loadPayeeBook({}, conn),
        ]);

        // Both gates for every account, so the screen can show what this
        // deployment does AND what a real-money deployment would do, side by
        // side, without the reader having to take either on trust.
        const accounts: SourceAccountView[] = await Promise.all(
          accountRows.map(async (row) => {
            const [now, strict] = await Promise.all([
              transactGateForAccount(row.accountId, { conn }),
              transactGateForAccount(row.accountId, {
                conn,
                policy: { requireLiveEvidence: true },
              }),
            ]);
            return {
              id: row.accountId,
              name: row.accountName,
              businessId: row.businessId,
              businessName: row.legalName,
              currency: row.currency,
              gate: toGateView(now),
              gateIfLiveRequired: toGateView(strict),
            };
          }),
        );

        const policies = policyRows
          .map(toPolicyOption)
          .filter((policy): policy is PolicyOptionView => policy !== null);

        const wirePayeesByBusiness: Record<string, WirePayeeOption[]> = {};
        for (const row of payeeRows) {
          const option = toWirePayee(row);
          if (option === null) continue;
          (wirePayeesByBusiness[row.businessId] ??= []).push(option);
        }

        return ok({
          actor,
          accounts,
          policies,
          wirePayeesByBusiness,
          defaultValueDate: bankingToday(),
          asOf,
        });
      } catch {
        // A read failure, and the first thing the screen has to say is that it
        // is one. Nothing here writes: no instruction was raised, and none can
        // be by a SELECT.
        return fail(
          "PAYMENTS_PREFLIGHT_FAILED",
          "The account list and threshold policy could not be read, so the form cannot be drawn honestly and is not drawn at all. Nothing was raised — this is a read, and a read cannot queue a payment.",
        );
      }
    },
  };
}
