/**
 * The payee screen without a database.
 *
 * Four of the five demo states are served from here, so they can be shown in
 * order in front of a panel without running a check or writing a row. Every
 * figure below is LABELLED AS A FIXTURE on the screen itself — `source:
 * "fixture"` drives a badge and a sentence, and nothing here is ever presented
 * as a statement about a real payee.
 *
 * The routing numbers are real published ones and the check-digit facts about
 * them are true, because a fixture that would fail its own arithmetic teaches a
 * viewer the wrong thing about the feature being demonstrated.
 */

import { err, ok, type Result } from "@/lib/result";

import type {
  PayeeBookView,
  PayeeDataSource,
  PayeeRow,
  RefusalRowView,
} from "./data-contract";
import type { DemoState } from "./view-state";

/** A fixed instant, so two renders of a fixture are byte-identical. */
const AS_OF = "2026-09-10T14:20:00.000Z";

function daysBefore(days: number): string {
  return new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString();
}

const CLEAN: PayeeRow = {
  payeeId: "10000000-0000-4000-8000-000000000001",
  businessName: "Ridgeline Robotics, Inc.",
  displayName: "Green coffee — monthly",
  holderName: "Ridgeline Coffee Roasters LLC",
  rail: "ach",
  routingNumber: "101050001",
  accountNumberLast4: "4417",
  accountType: "checking",
  createdAt: daysBefore(41),
  createdByName: "Alex Whitfield",
  archived: false,
  archivedAt: null,
  archivalReason: null,
  verificationId: "30000000-0000-4000-8000-000000000001",
  checkedAt: daysBefore(2),
  checkedByName: "Alex Whitfield",
  outcome: "verified",
  freshness: "fresh",
  checkedDaysAgo: 2,
  checksumOk: true,
  prefixAssigned: true,
  directory: "found",
  directoryProvider: "increase.routing_numbers",
  institutionName: "First Bank of the United States",
  nameMatch: "unavailable",
  nameMatchScore: null,
  nameSource: "payer_asserted",
  nameProvider: null,
  counterpartyName: null,
  evidence: "live",
  findings: [
    {
      code: "DIRECTORY_CONFIRMED",
      severity: "note",
      title: "First Bank of the United States holds this routing number",
      detail:
        "Confirmed live by increase.routing_numbers. This says the routing number belongs to a " +
        "real institution. It says nothing about the account number or about who owns the account.",
    },
    {
      code: "NAME_NOT_VERIFIABLE",
      severity: "note",
      title: "No bank has confirmed the name on this account",
      detail:
        "US ACH has no Confirmation of Payee network: there is no message that asks a receiving " +
        "bank what name is on an account, and no provider in this system can obtain one for a " +
        "third party's account. The name above is the one your own team typed.",
    },
  ],
  acknowledged: false,
  acknowledgedAt: null,
  acknowledgedByName: null,
  acknowledgementReason: null,
  hasConflictingTwin: false,
};

/**
 * The edge case: a warning nobody has signed for.
 *
 * The name on the account, obtained through the holder's own Plaid link, is
 * the parent company's — which is a completely legitimate arrangement and
 * completely indistinguishable from an invoice redirected to a stranger. A
 * hard block gets this wrong. A warning with a signature on it does not.
 */
const WARNED_UNSIGNED: PayeeRow = {
  payeeId: "10000000-0000-4000-8000-000000000002",
  businessName: "Ridgeline Robotics, Inc.",
  displayName: "Packaging supplier",
  holderName: "Cascade Packaging Co",
  rail: "ach",
  routingNumber: "011401533",
  accountNumberLast4: "9002",
  accountType: "checking",
  createdAt: daysBefore(9),
  createdByName: "Priya Raman",
  archived: false,
  archivedAt: null,
  archivalReason: null,
  verificationId: "30000000-0000-4000-8000-000000000002",
  checkedAt: daysBefore(9),
  checkedByName: "Priya Raman",
  outcome: "warned",
  freshness: "fresh",
  checkedDaysAgo: 9,
  checksumOk: true,
  prefixAssigned: true,
  directory: "not_listed",
  directoryProvider: "increase.routing_numbers",
  institutionName: null,
  nameMatch: "no_match",
  nameMatchScore: 41,
  nameSource: "linked_account_holder",
  nameProvider: "plaid.identity_match",
  counterpartyName: "Northbank Holdings LLC",
  evidence: "live",
  findings: [
    {
      code: "NAME_NO_MATCH",
      severity: "warn",
      title: "The name does not match the account",
      detail:
        'You typed "Cascade Packaging Co", and the account is held by "Northbank Holdings LLC". ' +
        "Names legitimately differ — a trading name, a subsidiary, a factoring company — so this " +
        "does not stop the payment. It does need somebody to say, in writing, why it is right.",
    },
    {
      code: "DIRECTORY_NOT_LISTED",
      severity: "note",
      title: "The sandbox directory does not carry this bank",
      detail:
        "increase.routing_numbers answered and has no entry for this routing number. In the " +
        "sandbox that means almost nothing: the test directory holds test banks, and every real " +
        "routing number in this demo misses it. Against the production directory the same answer " +
        "would be a warning.",
    },
  ],
  acknowledged: false,
  acknowledgedAt: null,
  acknowledgedByName: null,
  acknowledgementReason: null,
  hasConflictingTwin: false,
};

/** Signed for, months ago. Both halves of that sentence are on the screen. */
const STALE_SIGNED: PayeeRow = {
  payeeId: "10000000-0000-4000-8000-000000000003",
  businessName: "Ridgeline Robotics, Inc.",
  displayName: "Freight — Silverline",
  holderName: "Silverline Freight Co.",
  rail: "ach",
  routingNumber: "021000021",
  accountNumberLast4: "3312",
  accountType: "checking",
  createdAt: daysBefore(240),
  createdByName: "Alex Whitfield",
  archived: false,
  archivedAt: null,
  archivalReason: null,
  verificationId: "30000000-0000-4000-8000-000000000003",
  checkedAt: daysBefore(187),
  checkedByName: "Dana Okonkwo",
  outcome: "warned",
  freshness: "stale",
  checkedDaysAgo: 187,
  checksumOk: true,
  prefixAssigned: true,
  directory: "not_listed",
  directoryProvider: "increase.routing_numbers",
  institutionName: null,
  nameMatch: "close_match",
  nameMatchScore: 88,
  nameSource: "payer_asserted",
  nameProvider: null,
  counterpartyName: null,
  evidence: "simulated",
  findings: [
    {
      code: "TWIN_WITH_DIFFERENT_DETAILS",
      severity: "warn",
      title: "You already pay someone by this name at a different account",
      detail:
        '"Silverline Freight Co." is already on your payee book with 021000021 routing and an ' +
        "account ending 7781 — different bank details for the same name. This is what a " +
        "redirected-invoice fraud looks like from the inside, and it is also what a supplier " +
        "changing bank looks like. Confirm the change by a channel you already had.",
    },
  ],
  acknowledged: true,
  acknowledgedAt: daysBefore(187),
  acknowledgedByName: "Dana Okonkwo",
  acknowledgementReason:
    "Called the Silverline finance line from the number on last year's contract, not the one in " +
    "the email. They confirmed the account change.",
  hasConflictingTwin: true,
};

/** Never checked at all. A state the book must render, not one it hides. */
const NEVER_CHECKED: PayeeRow = {
  payeeId: "10000000-0000-4000-8000-000000000004",
  businessName: "Ridgeline Robotics, Inc.",
  displayName: "Office landlord",
  holderName: "Fairmount Property Partners",
  rail: "ach",
  routingNumber: "121000248",
  accountNumberLast4: "6620",
  accountType: "checking",
  createdAt: daysBefore(3),
  createdByName: "Priya Raman",
  archived: false,
  archivedAt: null,
  archivalReason: null,
  verificationId: null,
  checkedAt: null,
  checkedByName: null,
  outcome: null,
  freshness: "never",
  checkedDaysAgo: null,
  checksumOk: null,
  prefixAssigned: null,
  directory: null,
  directoryProvider: null,
  institutionName: null,
  nameMatch: null,
  nameMatchScore: null,
  nameSource: null,
  nameProvider: null,
  counterpartyName: null,
  evidence: null,
  findings: [],
  acknowledged: false,
  acknowledgedAt: null,
  acknowledgedByName: null,
  acknowledgementReason: null,
  hasConflictingTwin: false,
};

/**
 * The caught typo.
 *
 * 101500001 is 101050001 with two adjacent digits swapped, and the checksum
 * does NOT catch that one — the digits differ by exactly five. It is in this
 * fixture as a payee rather than a refusal for that reason; the honest limit
 * belongs on the screen. The refusal below is the swap the checksum DOES
 * catch.
 */
const REFUSALS: readonly RefusalRowView[] = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    attemptedAt: daysBefore(1),
    attemptedByName: "Priya Raman",
    holderName: "Cascade Packaging Co",
    rail: "ach",
    routingNumber: "101401533",
    accountNumberLast4: "9002",
    code: "ROUTING_CHECKSUM_FAILED",
    reason:
      "The check digit does not hold: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) = 56, which is 6 " +
      "away from a multiple of ten. No bank has this routing number. Swapping two adjacent " +
      "digits would give 011401533, which is the commonest way this happens.",
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    attemptedAt: daysBefore(6),
    attemptedByName: "Alex Whitfield",
    holderName: "Fairmount Property Partners",
    rail: "ach",
    routingNumber: "121000249",
    accountNumberLast4: "6620",
    code: "ROUTING_CHECKSUM_FAILED",
    reason:
      "The check digit does not hold: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) = 31, which is 1 " +
      "away from a multiple of ten. No bank has this routing number. Re-key it from the payee's " +
      "own paperwork; no adjacent pair of digits explains the failure.",
  },
];

const FULL_BOOK: readonly PayeeRow[] = [CLEAN, WARNED_UNSIGNED, STALE_SIGNED, NEVER_CHECKED];

function view(over: Partial<PayeeBookView>): PayeeBookView {
  return {
    asOf: AS_OF,
    source: "fixture",
    directoryEnvironment: "sandbox",
    rows: FULL_BOOK,
    refusals: REFUSALS,
    ...over,
  };
}

/**
 * A data source for one demo state.
 *
 * `loading` never resolves on its own — the caller holds it open — so the
 * skeleton is a real Suspense fallback rather than a picture of one.
 */
export function fixtureSource(state: DemoState): PayeeDataSource {
  return {
    load: async (): Promise<Result<PayeeBookView>> => {
      switch (state) {
        case "loading":
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          return ok(view({}));
        case "empty":
          return ok(view({ rows: [], refusals: [] }));
        case "error":
          return err({
            code: "PAYEE_BOOK_UNAVAILABLE",
            message:
              "The payee book could not be read. No check ran and nothing was written — this " +
              "screen only reads.",
          });
        case "edge":
          return ok(view({ rows: [WARNED_UNSIGNED], refusals: [] }));
        case "default":
          return ok(view({}));
      }
    },
  };
}

export const FIXTURE_ROWS = FULL_BOOK;
export const FIXTURE_REFUSALS = REFUSALS;
