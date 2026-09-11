/**
 * Fixtures for the two states that cannot be a real query.
 *
 * THE DEFAULT, EDGE AND EMPTY STATES ARE ALL LIVE. `?state=empty` is a real
 * business filtered to agent actions, which genuinely returns nothing; only
 * `?state=loading` (which needs a read that is slow on purpose) and the
 * no-database fallback use anything from this file. A fixture proves the
 * component renders; it cannot prove the trail is complete, and completeness
 * is the whole claim.
 *
 * Everything below is labelled `live: false`, and the screen prints `fixture`
 * where it would otherwise print `live`. Presenting a fixture as a live read
 * is the fastest way to fail this trial and it would be an odd way to fail an
 * AUDIT feature in particular.
 */

import { ACTOR_KINDS, type ActorAction, type ActorKind, type TimelineResult } from "@/lib/audit/types";

import type { AuditDataSource } from "./contract";

const BUSINESS = { id: "00000000-0000-4000-8000-000000000000", legalName: "Example Trading Co." };

const ACTIONS: readonly ActorAction[] = [
  {
    source: "payment_instruction_event",
    actionId: "payment_instruction_event:00000000-0000-4000-8000-000000000101",
    businessId: BUSINESS.id,
    occurredAt: "2026-09-10T14:02:11.000Z",
    recordedAt: "2026-09-10T14:02:11.000Z",
    valueDate: "2026-09-10",
    actorKind: "agent",
    actorId: null,
    actorLabel: "Corgi payments agent",
    surface: "payments",
    action: "payment.requested",
    summary: "ACH payment requested",
    amountCents: 499000n,
    subjectKind: "payment_instruction",
    subjectId: "00000000-0000-4000-8000-000000000901",
    entryId: null,
    detail: { rail: "ach", account_number_last4: "4417" },
    timeAxesDiffer: false,
  },
  {
    source: "kyb_verification_leg",
    actionId: "kyb_verification_leg:00000000-0000-4000-8000-000000000102",
    businessId: BUSINESS.id,
    occurredAt: "2026-09-08T09:31:00.000Z",
    recordedAt: "2026-09-10T11:04:52.000Z",
    valueDate: "2026-09-08",
    actorKind: "provider",
    actorId: null,
    actorLabel: "stripe-identity",
    surface: "kyb",
    action: "kyb.director_kyc.approved",
    summary: "Director kyc — approved via stripe-identity",
    amountCents: null,
    subjectKind: "business",
    subjectId: BUSINESS.id,
    entryId: null,
    detail: { leg: "director_kyc", status: "approved", evidence: "live" },
    timeAxesDiffer: true,
  },
];

function zeroByKind(): Record<ActorKind, number> {
  return Object.fromEntries(ACTOR_KINDS.map((k) => [k, 0])) as Record<ActorKind, number>;
}

function fixtureResult(): TimelineResult {
  const byKind = zeroByKind();
  byKind.agent = 1;
  byKind.provider = 1;
  return {
    business: BUSINESS,
    actions: ACTIONS,
    matched: ACTIONS.length,
    total: ACTIONS.length,
    byKind,
    bySource: { payment_instruction_event: 1, kyb_verification_leg: 1 },
    bookWideAvailable: 0,
    filterNote: null,
    page: 0,
    pageSize: 100,
    completeness: {
      sources: [],
      exclusions: [],
      unclaimed: [],
      mutable: [],
      weak: [],
    },
    live: false,
  };
}

/**
 * The loading source.
 *
 * A real await, not a `setTimeout` around a synchronous return: the page holds
 * a Suspense boundary and the skeleton only appears if the server component
 * genuinely suspends.
 */
export function createSlowFixtureSource(delayMs = 2_500): AuditDataSource {
  return {
    load: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fixtureResult();
    },
  };
}

/** The no-database fallback. The screen says `fixture` on its face. */
export function createFixtureSource(): AuditDataSource {
  return { load: async () => fixtureResult() };
}

/**
 * The error source.
 *
 * It throws the shape a Neon outage throws, so the error panel is exercised by
 * something that reads like the real failure rather than by the string
 * "error".
 */
export function createFailingSource(): AuditDataSource {
  return {
    load: async () => {
      throw new Error(
        'read CONNECT_TIMEOUT ep-corgi-neon.us-east-1.aws.neon.tech:5432 — no row was read and nothing was written',
      );
    },
  };
}
