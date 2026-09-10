/**
 * The live implementation of the approvals screen's data contract.
 *
 * One place, and one place only, where a `QueuedPayment` (bigint cents, event
 * rows, policy row) becomes the flat, JSON-safe shape a React tree renders.
 * Two narrowings happen here and nowhere else:
 *
 *   bigint -> number   exact for every cent count below 2^53 (~$90tn), which is
 *                      comfortably past any balance this bank will hold. The
 *                      contract documents how to widen it if that stops being
 *                      true.
 *   trigger -> reason  the gate on each row, which is a restatement of what
 *                      `assert_maker_checker()` will do, computed once on the
 *                      server so a component never re-derives it.
 */

import "server-only";

import type {
  ActorView,
  ApprovalsDataSource,
  ApprovalsSnapshot,
  EventView,
  PolicyView,
  QueueItem,
} from "@/components/approvals/data-contract";
import { sql, type Sql } from "@/lib/ledger/db";
import { ok, type Result, type ErrorShape } from "@/lib/result";

import { decisionGate, releaseGate } from "./gate";
import { listQueue } from "./instructions";
import { listPolicies } from "./policy-store";
import { normaliseKind } from "./state";
import { describeDestination, type ApprovalPolicy, type QueuedPayment } from "./types";

function toPolicyView(policy: ApprovalPolicy): PolicyView {
  return {
    id: policy.id,
    version: policy.version,
    rail: policy.rail,
    effectiveFrom: policy.effectiveFrom,
    thresholdCents: Number(policy.thresholdCents),
    requiredApprovals: policy.requiredApprovals,
    note: policy.note,
  };
}

function toQueueItem(payment: QueuedPayment, actor: ActorView | null): QueueItem {
  const { instruction } = payment;
  const gateInput = {
    state: payment.state,
    initiatorActorId: instruction.requestedByActorId,
    initiatorName: instruction.requestedByName,
    actor,
  };

  const events: EventView[] = payment.events.map((event) => ({
    id: event.id,
    kind: normaliseKind(event.kind),
    actorName: event.actorName,
    actorKind: event.actorKind,
    reason: event.reason,
    occurredAt: event.occurredAt,
    citedHash: event.approvedContentHash,
    citesCurrentHash: event.approvedContentHash === instruction.contentHash,
    entryId: event.entryId,
  }));

  return {
    id: instruction.id,
    state: payment.state,
    amountCents: Number(instruction.amountCents),
    currency: instruction.currency,
    rail: instruction.rail,
    destination: describeDestination(instruction.destination),
    accountName: instruction.accountName,
    businessName: instruction.businessName,
    initiatorActorId: instruction.requestedByActorId,
    initiatorName: instruction.requestedByName,
    initiatorKind: instruction.requestedByKind,
    requestedAt: instruction.requestedAt,
    valueDate: instruction.valueDate,
    policy: toPolicyView(instruction.policy),
    aboveThreshold: payment.aboveThreshold,
    approvalsHeld: payment.approvalsHeld,
    approvalsRequired: payment.approvalsRequired,
    contentHash: instruction.contentHash,
    events,
    gate: decisionGate(gateInput),
    releaseGate: releaseGate({
      ...gateInput,
      approvalsHeld: payment.approvalsHeld,
      approvalsRequired: payment.approvalsRequired,
    }),
  };
}

/**
 * The live source.
 *
 * `asOf` is taken once, before the reads, and every age on the screen is
 * measured against it — so a screenshot is a consistent statement about one
 * instant rather than a collage of several.
 */
export function createLiveApprovalsSource(conn: Sql = sql): ApprovalsDataSource {
  return {
    async getQueue(actor): Promise<Result<ApprovalsSnapshot, ErrorShape>> {
      const asOf = new Date().toISOString();
      const [queue, policies] = await Promise.all([
        listQueue({ pendingOnly: true, limit: 50 }, conn),
        listPolicies(conn).then((rows) => rows.map(toPolicyView)),
      ]);

      if (!queue.ok) return queue;

      return ok({
        actor,
        queue: queue.value.map((payment) => toQueueItem(payment, actor)),
        policies,
        asOf,
      });
    },
  };
}
