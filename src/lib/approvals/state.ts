/**
 * The payment state machine, as a fold over events.
 *
 *     requested ──approved──▶ approved ──released──▶ released
 *         │                                             │
 *         ├──rejected───▶ rejected  (terminal)          ├──▶ settled
 *         └──cancelled──▶ cancelled (terminal)          ├──▶ returned
 *                                                       └──▶ failed
 *
 * THERE IS NO STATUS COLUMN, and this module is why there does not need to be
 * one. DESIGN §17: "status is a view over events. A status column is a cache
 * with no key and no invalidation story." `payment_instruction_event` is
 * append-only — 0001 §13 puts a no-UPDATE/no-DELETE trigger on it and revokes
 * the privileges besides — so the event set is the whole truth and this fold is
 * total over it.
 *
 * The fold is order-insensitive on purpose. It reads a SET of events and
 * returns the furthest state reached, which means an out-of-order webhook, a
 * replayed delivery, or two rows written in the same millisecond cannot produce
 * a different answer than the same facts arriving tidily. Ordering is enforced
 * where it belongs — in `assert_payment_lifecycle()` at INSERT time — not
 * re-litigated on every read.
 *
 * Everything here is pure. No database, no clock, no `server-only`: it is
 * imported by the queue, by the server actions and by the tests, and it can be
 * exercised without a connection.
 */

import type { PaymentEventKind, PaymentState } from "./types";

/**
 * `submitted` is 0001's name for the release step; `released` is 0007's.
 * They are the same fact, so the fold collapses them rather than branching, and
 * an instruction written by an older code path still renders correctly.
 */
export function normaliseKind(kind: PaymentEventKind): PaymentEventKind {
  return kind === "submitted" ? "released" : kind;
}

/**
 * How far along a state is. The fold takes the maximum, so a `settled` that
 * arrives before the `released` row it followed still reports `settled`.
 *
 * `rejected` and `cancelled` outrank `approved` deliberately: an instruction
 * that was approved and then withdrawn is closed, not pending, and a queue that
 * showed it as awaiting release would invite a second decision on a dead row.
 */
const RANK: Record<PaymentState, number> = {
  requested: 0,
  approved: 1,
  rejected: 90,
  cancelled: 90,
  released: 2,
  settled: 3,
  returned: 3,
  failed: 3,
};

const EVENT_TO_STATE: Record<PaymentEventKind, PaymentState> = {
  requested: "requested",
  approved: "approved",
  rejected: "rejected",
  submitted: "released",
  released: "released",
  settled: "settled",
  returned: "returned",
  failed: "failed",
  cancelled: "cancelled",
};

/** Which kinds may legally follow a given state. Mirrors 0007's trigger. */
const ALLOWED_NEXT: Record<PaymentState, readonly PaymentEventKind[]> = {
  requested: ["approved", "rejected", "cancelled", "released"],
  approved: ["approved", "rejected", "cancelled", "released"],
  released: ["settled", "returned", "failed"],
  settled: ["returned"],
  returned: [],
  failed: [],
  rejected: [],
  cancelled: [],
};

/** Nothing follows these. A terminal instruction is history, not work. */
export const TERMINAL_STATES: readonly PaymentState[] = [
  "rejected",
  "cancelled",
  "returned",
  "failed",
];

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The queue's definition of "pending": a decision or a release is still owed. */
export function isPending(state: PaymentState): boolean {
  return state === "requested" || state === "approved";
}

/**
 * Fold an event set to a state.
 *
 * An empty set is `requested` rather than a throw: `requested` is written in
 * the same transaction as the instruction row, so an instruction with no events
 * cannot be committed — and a read that somehow sees one mid-flight should
 * render the safest possible answer, which is "nothing has happened yet", not
 * an exception on a screen.
 */
export function foldState(events: readonly { readonly kind: PaymentEventKind }[]): PaymentState {
  let state: PaymentState = "requested";
  for (const event of events) {
    const candidate = EVENT_TO_STATE[normaliseKind(event.kind)];
    if (RANK[candidate] > RANK[state]) state = candidate;
  }
  return state;
}

/**
 * Is this transition one the machine allows?
 *
 * ADVISORY, NOT A CONTROL. It exists so the console can disable a button and
 * say why, and so a test can enumerate the machine. The transition that
 * actually holds is the one `assert_payment_lifecycle()` raises on, and every
 * write path in `src/lib/approvals` sends its INSERT to the database whether
 * this returns true or false — see the note at the top of `refusal.ts`.
 */
export function canTransition(from: PaymentState, kind: PaymentEventKind): boolean {
  return ALLOWED_NEXT[from].includes(normaliseKind(kind)) || ALLOWED_NEXT[from].includes(kind);
}

export function nextKinds(from: PaymentState): readonly PaymentEventKind[] {
  return ALLOWED_NEXT[from];
}

/** Plain English, for a badge and for a screen reader. */
export const STATE_LABEL: Record<PaymentState, string> = {
  requested: "Awaiting approval",
  approved: "Approved · awaiting release",
  rejected: "Rejected",
  cancelled: "Cancelled",
  released: "Released",
  settled: "Settled",
  returned: "Returned",
  failed: "Failed",
};

export const STATE_DESCRIPTION: Record<PaymentState, string> = {
  requested: "Raised and waiting on a checker who is not the initiator.",
  approved: "Has the approvals its policy version requires. Nothing has posted yet.",
  rejected: "A checker refused it. No money moved and none can: the release is closed.",
  cancelled: "Withdrawn before release. No ledger footprint at all.",
  released: "Posted to the journal and handed to the rail.",
  settled: "The rail confirmed the money landed.",
  returned: "It settled and came back. A second money movement, not an edit.",
  failed: "The rail refused it outright. Nothing landed.",
};
