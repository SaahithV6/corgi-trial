/**
 * The four fixture states behind the approvals screen's data contract.
 *
 * `default` is not here: it is the live queue (see `demo-state.ts`). These four
 * exist so `loading`, `empty`, `error` and — the one that matters — `edge` can
 * be shown on demand, in order, in front of a panel, without breaking a
 * database or raising a payment while pretending to be somebody else.
 *
 * THE EDGE STATE IS BUILT AROUND WHOEVER IS SIGNED IN. Its single row is
 * initiated by the *current actor*, whichever role the switcher is on, so the
 * disabled approve button and its reason are true statements about the person
 * looking at the screen rather than a mock-up of somebody else's problem. Flip
 * the role switcher on `?state=edge` and the reason changes with it: as
 * Approver you are told you raised it, as Staff you are told the same thing
 * first, because "you raised this one" is the more specific fact.
 *
 * The numbers are the seeded policy's numbers: the ACH threshold really is
 * $2,500 with one approver and the wire policy really is $0 with two, so a
 * fixture row and a live row are judged by the same table.
 */

import { decisionGate, releaseGate } from "@/lib/approvals/gate";
import { fail, ok } from "@/lib/result";

import type {
  ActorView,
  ApprovalsDataSource,
  ApprovalsSnapshot,
  PolicyView,
  QueueItem,
} from "./data-contract";
import type { DemoState } from "./demo-state";

/** Fixed, so ages and screenshots are reproducible. */
export const DEMO_NOW = "2026-09-10T18:20:00.000Z"; // 14:20 ET

/** How long `?state=loading` holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const ACH_POLICY: PolicyView = {
  id: "9315dd14-5e7f-5703-b37a-236a2531b968",
  version: "ach@2026-01-01",
  rail: "ach",
  effectiveFrom: "2026-01-01",
  thresholdCents: 250_000,
  requiredApprovals: 1,
  note: "ACH debits of $2,500 or more need one approver who is not the initiator.",
};

const WIRE_POLICY: PolicyView = {
  id: "d0aaa278-d28b-502c-9e4f-4eddda0af506",
  version: "wire@2026-01-01",
  rail: "wire",
  effectiveFrom: "2026-01-01",
  thresholdCents: 0,
  requiredApprovals: 2,
  note: "Every wire, at any amount, needs two distinct human approvers.",
};

const POLICIES: readonly PolicyView[] = [ACH_POLICY, WIRE_POLICY];

/** Only 32-byte hex is accepted anywhere; a fixture hash has to be real hex. */
function fixtureHash(seed: string): string {
  let out = "";
  let n = 0;
  while (out.length < 64) {
    n += 1;
    out += Buffer.from(`${seed}:${n}`, "utf8").toString("hex");
  }
  return out.slice(0, 64);
}

type Draft = Omit<QueueItem, "gate" | "releaseGate">;

function gated(draft: Draft, actor: ActorView | null): QueueItem {
  const input = {
    state: draft.state,
    initiatorActorId: draft.initiatorActorId,
    initiatorName: draft.initiatorName,
    actor,
  };
  return {
    ...draft,
    gate: decisionGate(input),
    releaseGate: releaseGate({
      ...input,
      approvalsHeld: draft.approvalsHeld,
      approvalsRequired: draft.approvalsRequired,
    }),
  };
}

/**
 * The row that makes the edge case real: raised by the person reading it.
 *
 * When no actor is resolved the initiator id is a literal that matches nobody,
 * and the gate falls through to `no_actor` — which is also correct, and is what
 * an unauthenticated session should see.
 */
function selfInitiated(actor: ActorView | null): Draft {
  return {
    id: "edge-self-initiated",
    state: "requested",
    amountCents: 412_000,
    currency: "USD",
    rail: "ach",
    destination:
      "Fairbanks Machining LLC · ACH 021000021 ••4417 (checking)",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    businessName: "Ridgeline Robotics, Inc.",
    initiatorActorId: actor?.id ?? "00000000-0000-0000-0000-000000000000",
    initiatorName: actor?.displayName ?? "Nobody",
    initiatorKind: "human",
    requestedAt: "2026-09-10T17:55:00.000Z",
    valueDate: "2026-09-11",
    policy: ACH_POLICY,
    aboveThreshold: true,
    approvalsHeld: 0,
    approvalsRequired: 1,
    contentHash: fixtureHash("edge"),
    events: [
      {
        id: "edge-ev-1",
        kind: "requested",
        actorName: actor?.displayName ?? "Nobody",
        actorKind: "human",
        reason: null,
        occurredAt: "2026-09-10T17:55:00.000Z",
        citedHash: null,
        citesCurrentHash: false,
        entryId: null,
      },
    ],
  };
}

/** A second row on the edge screen, so the contrast is visible side by side. */
function approvableByAnyone(): Draft {
  return {
    id: "edge-someone-else",
    state: "approved",
    amountCents: 1_800_000,
    currency: "USD",
    rail: "wire",
    destination: "Halden & Roe LLP · wire CHASUS33 ••9902",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    businessName: "Ridgeline Robotics, Inc.",
    initiatorActorId: "3743dc53-4e1c-577e-9a0f-e4469ffc1761",
    initiatorName: "Corgi payments agent",
    initiatorKind: "agent",
    requestedAt: "2026-09-10T16:02:00.000Z",
    valueDate: "2026-09-11",
    policy: WIRE_POLICY,
    aboveThreshold: true,
    approvalsHeld: 1,
    approvalsRequired: 2,
    contentHash: fixtureHash("wire"),
    events: [
      {
        id: "wire-ev-1",
        kind: "requested",
        actorName: "Corgi payments agent",
        actorKind: "agent",
        reason: null,
        occurredAt: "2026-09-10T16:02:00.000Z",
        citedHash: null,
        citesCurrentHash: false,
        entryId: null,
      },
      {
        id: "wire-ev-2",
        kind: "approved",
        actorName: "Miles Ferrara",
        actorKind: "human",
        reason: "Invoice 22-8814 checked against the engagement letter.",
        occurredAt: "2026-09-10T16:40:00.000Z",
        citedHash: fixtureHash("wire"),
        citesCurrentHash: true,
        entryId: null,
      },
    ],
  };
}

function snapshot(actor: ActorView | null, drafts: readonly Draft[]): ApprovalsSnapshot {
  return {
    actor,
    queue: drafts.map((draft) => gated(draft, actor)),
    policies: POLICIES,
    asOf: DEMO_NOW,
  };
}

const QUEUE_READ_FAILED = {
  code: "LEDGER_UNAVAILABLE",
  message:
    "The approvals queue could not be read. This is a read failure: no payment was approved, rejected or released, and none can be by a query.",
} as const;

/**
 * The fixture source for one demo state.
 *
 * `loading` is not a rendered mock — it genuinely does not resolve for six
 * seconds, so the Suspense fallback on the page is the real loading state and
 * not a picture of one.
 */
export function createFixtureSource(state: Exclude<DemoState, "default">): ApprovalsDataSource {
  return {
    async getQueue(actor) {
      switch (state) {
        case "loading":
          await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
          return ok(snapshot(actor, [approvableByAnyone()]));
        case "empty":
          return ok(snapshot(actor, []));
        case "error":
          return fail(QUEUE_READ_FAILED.code, QUEUE_READ_FAILED.message);
        case "edge":
          return ok(snapshot(actor, [selfInitiated(actor), approvableByAnyone()]));
      }
    },
  };
}
