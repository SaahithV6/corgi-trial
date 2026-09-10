/**
 * Choosing what a correction corrects — the pure half, with no database.
 *
 * `chooseCorrectionTarget` is the only inference in the card money path, and an
 * inference that can change its mind between two deliveries of the same payload
 * is a double-posting bug rather than a wrong number: the first delivery
 * reverses entry A, the redelivery reverses entry B, and both survive because
 * they carry different idempotency keys. So the property that matters here is
 * not "it picks a sensible target" but "it is a function of the event SET",
 * exactly as `H(E)` is — and that is provable without a connection, which is
 * why the choice is a separate function from the posting.
 *
 * The refusals matter as much as the matches. Two identical clearings and one
 * correction is genuinely ambiguous, and this system's answer to ambiguity is
 * a parked row in front of a human, never a guess that balances.
 */
import { describe, expect, it, vi } from "vitest";

// `corrections.ts` reaches `env.ts` through `@/lib/ledger/db` at module load,
// and `postgres()` opens no socket until the first query — so a placeholder is
// enough to let CI, which holds no credentials, run every assertion below.
vi.hoisted(() => {
  process.env["APP_DATABASE_URL"] ??= "postgres://placeholder/none";
});

import {
  chooseCorrectionTarget,
  correctionRebookKey,
  directionOf,
} from "./corrections";
import type { CardEvent, CardEventKind } from "./model";

function ev(
  kind: CardEventKind,
  amountCents: bigint,
  providerEventId: string,
  valueDate = "2026-09-08",
): CardEvent {
  return { kind, amountCents, isFinal: false, valueDate, providerEventId };
}

/** A `RETURN_REVERSAL` / `CORRECTION_DEBIT`: takes money back off the customer. */
const debitCorrection = (cents: bigint, id: string, day?: string) =>
  ev("force_post", cents, id, day);

/** A `CORRECTION_CREDIT`: gives money back to the customer. */
const creditCorrection = (cents: bigint, id: string, day?: string) =>
  ev("refund", cents, id, day);

describe("directionOf", () => {
  it("reads direction off the canonical kind, never off a payload sign", () => {
    expect(directionOf(ev("clearing", 100n, "a"))).toBe("debit");
    expect(directionOf(ev("force_post", 100n, "b"))).toBe("debit");
    expect(directionOf(ev("refund", 100n, "c"))).toBe("credit");
  });

  it("is null for every kind that moves no money", () => {
    for (const kind of [
      "authorization",
      "incremental_authorization",
      "authorization_reversal",
      "expiry",
      "close",
    ] as const) {
      expect(directionOf(ev(kind, 100n, kind))).toBeNull();
    }
  });
});

describe("chooseCorrectionTarget", () => {
  it("a RETURN_REVERSAL of $73.40 picks the $73.40 refund, and calls it full", () => {
    const refund = ev("refund", 7340n, "return", "2026-09-08");
    const reversal = debitCorrection(7340n, "reversal", "2026-09-10");

    const choice = chooseCorrectionTarget(reversal, [refund, reversal]);
    expect(choice.status).toBe("matched");
    if (choice.status !== "matched") return;
    expect(choice.target.providerEventId).toBe("return");
    // The target's date is the one the repair will inherit. It is NOT the
    // correction's own, which is the entire point of the correction path.
    expect(choice.target.valueDate).toBe("2026-09-08");
    expect(choice.full).toBe(true);
  });

  it("a CORRECTION_CREDIT of $73.40 picks the $73.40 clearing", () => {
    const auth = ev("authorization", 5000n, "auth");
    const clearing = ev("clearing", 7340n, "clearing", "2026-09-08");
    const correction = creditCorrection(7340n, "correction", "2026-09-09");

    const choice = chooseCorrectionTarget(correction, [auth, clearing, correction]);
    expect(choice.status).toBe("matched");
    if (choice.status !== "matched") return;
    expect(choice.target.providerEventId).toBe("clearing");
    expect(choice.full).toBe(true);
  });

  it("ignores the authorisation, the incremental and the reversal — they moved no money", () => {
    const set = [
      ev("authorization", 7340n, "auth"),
      ev("incremental_authorization", 7340n, "incr"),
      ev("authorization_reversal", 7340n, "authrev"),
      ev("expiry", 7340n, "expiry"),
    ];
    const correction = creditCorrection(7340n, "correction");
    const choice = chooseCorrectionTarget(correction, [...set, correction]);
    expect(choice.status).toBe("unmatched");
    if (choice.status !== "unmatched") return;
    expect(choice.candidates).toBe(0);
    expect(choice.reason).toMatch(/no debit card event has posted/);
  });

  it("never picks itself, and never picks its own direction", () => {
    // Two debit corrections and no credit anywhere: a correction cannot
    // correct a movement that went the same way it does.
    const a = debitCorrection(7340n, "corr-a");
    const b = debitCorrection(7340n, "corr-b");
    const clearing = ev("clearing", 7340n, "clearing");
    const choice = chooseCorrectionTarget(a, [a, b, clearing]);
    expect(choice.status).toBe("unmatched");
  });

  it("picks the exact magnitude out of several candidates", () => {
    const small = ev("clearing", 1000n, "small");
    const exact = ev("clearing", 7340n, "exact", "2026-09-08");
    const large = ev("clearing", 9999n, "large");
    const correction = creditCorrection(7340n, "correction");

    const choice = chooseCorrectionTarget(correction, [small, exact, large, correction]);
    expect(choice.status).toBe("matched");
    if (choice.status !== "matched") return;
    expect(choice.target.providerEventId).toBe("exact");
    expect(choice.full).toBe(true);
  });

  it("REFUSES two identical candidates rather than picking one", () => {
    // The fuel pump that cleared twice for the same amount. Nothing in the
    // payload says which clearing the correction undoes, so the honest answer
    // is a human, and the caller parks.
    const first = ev("clearing", 7340n, "clearing-1");
    const second = ev("clearing", 7340n, "clearing-2");
    const correction = creditCorrection(7340n, "correction");

    const choice = chooseCorrectionTarget(correction, [first, second, correction]);
    expect(choice.status).toBe("unmatched");
    if (choice.status !== "unmatched") return;
    expect(choice.candidates).toBe(2);
    expect(choice.reason).toMatch(/could each be the one/);
  });

  it("treats a lone mismatched candidate as a PARTIAL correction", () => {
    // $73.40 cleared, the network corrects $3.40 of it. One candidate, so
    // there is no ambiguity — reverse it and re-book the remainder at the same
    // value date.
    const clearing = ev("clearing", 7340n, "clearing", "2026-09-08");
    const correction = creditCorrection(340n, "correction", "2026-09-09");

    const choice = chooseCorrectionTarget(correction, [clearing, correction]);
    expect(choice.status).toBe("matched");
    if (choice.status !== "matched") return;
    expect(choice.target.providerEventId).toBe("clearing");
    expect(choice.full).toBe(false);
  });

  it("REFUSES a partial correction when there is more than one candidate", () => {
    const a = ev("clearing", 7340n, "clearing-a");
    const b = ev("clearing", 1000n, "clearing-b");
    const correction = creditCorrection(340n, "correction");

    const choice = chooseCorrectionTarget(correction, [a, b, correction]);
    expect(choice.status).toBe("unmatched");
    if (choice.status !== "unmatched") return;
    expect(choice.candidates).toBe(2);
  });

  it("is unmatched when the correction arrives before what it corrects", () => {
    // Out-of-order delivery. Not an error and not a drop: the caller parks and
    // the re-check finds the clearing once it lands.
    const correction = creditCorrection(7340n, "correction");
    const choice = chooseCorrectionTarget(correction, [correction]);
    expect(choice.status).toBe("unmatched");
    if (choice.status !== "unmatched") return;
    expect(choice.reason).toMatch(/may have arrived before the movement it corrects/);
  });

  it("refuses a correction whose kind moves no money at all", () => {
    const bogus = ev("authorization", 7340n, "bogus");
    const clearing = ev("clearing", 7340n, "clearing");
    const choice = chooseCorrectionTarget(bogus, [clearing, bogus]);
    expect(choice.status).toBe("unmatched");
    if (choice.status !== "unmatched") return;
    expect(choice.reason).toMatch(/moves no money/);
  });

  it("is a function of the SET: order and duplication change nothing", () => {
    const auth = ev("authorization", 5000n, "auth");
    const clearing = ev("clearing", 7340n, "clearing", "2026-09-08");
    const correction = creditCorrection(7340n, "correction", "2026-09-09");

    const orders: CardEvent[][] = [
      [auth, clearing, correction],
      [correction, clearing, auth],
      [clearing, correction, auth],
      [correction, correction, clearing, clearing, auth],
    ];

    for (const events of orders) {
      const choice = chooseCorrectionTarget(correction, events);
      // The duplicated list is still the same SET — `chooseCorrectionTarget`
      // filters on `providerEventId`, so a caller that has not deduplicated
      // gets the same answer as one that has.
      expect(choice.status).toBe("matched");
      if (choice.status !== "matched") continue;
      expect(choice.target.providerEventId).toBe("clearing");
      expect(choice.target.valueDate).toBe("2026-09-08");
    }
  });

  it("ignores a zero-amount candidate — there is nothing there to reverse", () => {
    const zero = ev("clearing", 0n, "zero");
    const correction = creditCorrection(7340n, "correction");
    expect(chooseCorrectionTarget(correction, [zero, correction]).status).toBe("unmatched");
  });
});

describe("correctionRebookKey", () => {
  it("is derived from the provider's own event id, so a replay collides", () => {
    expect(correctionRebookKey("evt-1")).toBe("card:correction:evt-1");
    expect(correctionRebookKey("evt-1")).toBe(correctionRebookKey("evt-1"));
    expect(correctionRebookKey("evt-2")).not.toBe(correctionRebookKey("evt-1"));
  });
});
