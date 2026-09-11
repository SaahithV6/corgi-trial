import { beforeAll, describe, expect, it } from "vitest";

import { isErr, isOk } from "@/lib/result";
import type { sql as SqlHandle } from "@/lib/ledger/db";

import type * as AcknowledgeModule from "./acknowledge";
import type * as GateModule from "./gate";
import type * as RecheckModule from "./recheck";
import type * as StoreModule from "./store";
import type { PayeeCandidate } from "./types";

/**
 * THE OPERATOR'S HALF OF THE LOOP, against the REAL Neon book.
 *
 * `payees.integration.test.ts` proves the checks and the constraints. This
 * file proves the three things a PERSON at the console can now do, and the
 * refusals that stand between them and the easy version of each:
 *
 *   1. RE-CHECKING APPENDS. A second check is a second row; the first one
 *      keeps its findings and keeps whoever signed for them; the payee's
 *      current standing comes from the newest row. There is no `is_verified`
 *      column to re-stamp and this is what replaces one.
 *
 *   2. A SIGNATURE NAMES WHAT IT SIGNED FOR, and the set of findings is
 *      RE-READ from `payee_verification` rather than taken from the form. A
 *      signature that names the wrong findings is refused with
 *      `PAYEE_WARNING_MOVED` and writes nothing — because between a render and
 *      a submit a re-check can land, and then the warning on screen is not the
 *      warning standing against the payee.
 *
 *   3. A SIGNATURE DOES NOT SURVIVE A RE-CHECK. It is attached to the check it
 *      answered, so a re-check that warns again needs a new signature and the
 *      payment gate refuses until it has one. An acknowledgement from June
 *      says nothing about what was found this morning.
 *
 * Gated on RUN_DB_TESTS=1, like its neighbour, because CI holds no credentials
 * on purpose. NO MONEY MOVES: nothing in `src/lib/payees` can write a journal
 * line.
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;

/** Seeded. `scripts/seed.mjs` builds these; stable across resets. */
const RIDGELINE = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
const ALEX = "3b805475-b3a6-5717-bd98-aef8826ce05a";
const DANA = "76f9266f-23c9-52de-b8ff-0ec0b23ef386";

/** Distinct per run, so a re-run is not a replay and a replay is deliberate. */
const RUN_ID = `op-${Date.now().toString(36)}`;

let sql: typeof SqlHandle;
let store: typeof StoreModule;
let gate: typeof GateModule;
let recheck: typeof RecheckModule;
let acknowledge: typeof AcknowledgeModule;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
  store = await import("./store");
  gate = await import("./gate");
  recheck = await import("./recheck");
  acknowledge = await import("./acknowledge");
});

/**
 * A supplier nobody else is writing about.
 *
 * The twin probe fires across the whole book, so the run id has to be in the
 * NAME and not only in the key — the book is append-only and yesterday's run
 * is still in it.
 */
function candidate(tag: string, over: Partial<PayeeCandidate> = {}): PayeeCandidate {
  return {
    businessId: RIDGELINE,
    displayName: `Console fixture ${tag}`,
    holderName: `Cascade ${tag} ${RUN_ID} Packaging Co`,
    rail: "ach",
    routingNumber: "011401533",
    accountNumberLast4: "4417",
    accountType: "checking",
    ...over,
  };
}

run("re-checking a payee appends, and never edits", () => {
  it("writes a second verification row and leaves the first exactly as it was", async () => {
    const first = await gate.confirmPayee({
      candidate: candidate("Recheck"),
      payeeKey: `${RUN_ID}-recheck`,
      actorId: ALEX,
    });
    expect(first.check).not.toBeNull();
    const payeeId = first.saved?.payeeId;
    const firstVerification = first.saved?.verificationId;
    expect(payeeId).toBeDefined();
    expect(firstVerification).toBeDefined();
    if (payeeId === undefined || firstVerification === undefined) return;

    const again = await recheck.recheckPayee({ payeeId, actorId: DANA });
    expect(again.refusal).toBeNull();
    expect(again.check).not.toBeNull();
    expect(again.verificationId).not.toBeNull();
    expect(again.verificationId).not.toBe(firstVerification);

    const rows = await sql<{ id: string; checked_by: string }[]>`
      SELECT id, checked_by::text AS checked_by
        FROM payee_verification
       WHERE payee_id = ${payeeId}::uuid
       ORDER BY checked_at ASC`;
    expect(rows).toHaveLength(2);
    // NOTHING WAS UPDATED. The first row still carries the actor who ran it;
    // the second carries a different one, which is what "two checks" means.
    expect(rows[0]?.id).toBe(firstVerification);
    expect(rows[0]?.checked_by).toBe(ALEX);
    expect(rows[1]?.checked_by).toBe(DANA);
  });

  it("does not re-key the beneficiary — the details come out of the row", async () => {
    const added = await gate.confirmPayee({
      candidate: candidate("Samedetails"),
      payeeKey: `${RUN_ID}-samedetails`,
      actorId: ALEX,
    });
    const payeeId = added.saved?.payeeId;
    if (payeeId === undefined) throw new Error("expected a payee");

    const again = await recheck.recheckPayee({ payeeId, actorId: ALEX });
    expect(again.check?.routingNumber).toBe("011401533");
    expect(again.payee?.accountNumberLast4).toBe("4417");

    // One payee, two checks. A re-check is never an opportunity to change the
    // bank details, so there is no second payee and no second last-four.
    const [count] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM payee WHERE id = ${payeeId}::uuid`;
    expect(count?.n).toBe("1");
  });

  it("refuses to re-check an ARCHIVED payee, and writes nothing", async () => {
    const added = await gate.confirmPayee({
      candidate: candidate("Archivedrecheck"),
      payeeKey: `${RUN_ID}-archivedrecheck`,
      actorId: ALEX,
    });
    const payeeId = added.saved?.payeeId;
    if (payeeId === undefined) throw new Error("expected a payee");

    const archived = await store.archivePayee({
      payeeId,
      actorId: ALEX,
      reason: "Supplier contract ended — console fixture",
    });
    expect(isOk(archived)).toBe(true);

    const before = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM payee_verification WHERE payee_id = ${payeeId}::uuid`;

    const attempt = await recheck.recheckPayee({ payeeId, actorId: ALEX });
    expect(attempt.refusal?.code).toBe("PAYEE_ARCHIVED");
    // NULL, NOT AN EMPTY CHECK. "No check happened" is a different fact from
    // "a check that found nothing", and the type keeps them apart.
    expect(attempt.check).toBeNull();
    expect(attempt.verificationId).toBeNull();

    const after = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM payee_verification WHERE payee_id = ${payeeId}::uuid`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

run("a signature names what it signed for", () => {
  /** A payee that warns: the same name, already on the book at another account. */
  async function warnedPayee(tag: string): Promise<{ payeeId: string; verificationId: string }> {
    const original = await gate.confirmPayee({
      candidate: candidate(tag),
      payeeKey: `${RUN_ID}-${tag}-original`,
      actorId: ALEX,
    });
    if (original.saved === null) throw new Error("expected the first payee to be stored");

    const twin = await gate.confirmPayee({
      // Same holder name, different account. This is the twin probe's whole
      // subject: a supplier changing bank looks exactly like a redirected
      // invoice, which is why it is a warning and not a block.
      candidate: candidate(tag, { accountNumberLast4: "9002" }),
      payeeKey: `${RUN_ID}-${tag}-twin`,
      actorId: ALEX,
    });
    if (twin.saved === null) throw new Error("expected the twin payee to be stored");
    expect(twin.check?.decision).toBe("warned");
    expect(twin.check?.findings.map((f) => f.code)).toContain("TWIN_WITH_DIFFERENT_DETAILS");
    return { payeeId: twin.saved.payeeId, verificationId: twin.saved.verificationId };
  }

  it("stores the operator's sentence AND the findings it answers", async () => {
    const { verificationId } = await warnedPayee("Signnames");

    const signed = await acknowledge.signWarning({
      verificationId,
      actorId: DANA,
      reason: "Confirmed on the finance line from the master agreement, not the remittance email.",
      codes: ["TWIN_WITH_DIFFERENT_DETAILS"],
    });
    expect(isOk(signed)).toBe(true);
    if (!isOk(signed)) return;

    const [row] = await sql<{ reason: string }[]>`
      SELECT reason FROM payee_acknowledgement WHERE id = ${signed.value.acknowledgementId}::uuid`;
    expect(row?.reason).toContain("finance line from the master agreement");
    // THE PART THAT MAKES IT READABLE IN SIX MONTHS. Without this the row says
    // somebody clicked; with it the row says WHAT they waved through.
    expect(row?.reason).toContain("TWIN_WITH_DIFFERENT_DETAILS");
    expect(row?.reason).toContain("You already pay someone by this name at a different account");
  });

  it("REFUSES a signature that does not name every warning, and writes nothing", async () => {
    const { verificationId } = await warnedPayee("Signpartial");

    const attempt = await acknowledge.signWarning({
      verificationId,
      actorId: DANA,
      reason: "Waving this through without saying what it is.",
      codes: [],
    });
    expect(isErr(attempt)).toBe(true);
    if (!isErr(attempt)) return;
    expect(attempt.error.code).toBe("PAYEE_WARNING_MOVED");

    const [count] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n
        FROM payee_acknowledgement WHERE verification_id = ${verificationId}::uuid`;
    expect(count?.n).toBe("0");
  });

  it("refuses a signature whose sentence is not a sentence", async () => {
    const { verificationId } = await warnedPayee("Signterse");
    const attempt = await acknowledge.signWarning({
      verificationId,
      actorId: DANA,
      reason: "ok",
      codes: ["TWIN_WITH_DIFFERENT_DETAILS"],
    });
    expect(isErr(attempt)).toBe(true);
    if (!isErr(attempt)) return;
    expect(attempt.error.code).toBe("ACKNOWLEDGEMENT_NEEDS_A_REASON");
  });

  it("refuses a signature against a check that was not warned", async () => {
    const clean = await gate.confirmPayee({
      candidate: candidate("Signclean"),
      payeeKey: `${RUN_ID}-signclean`,
      actorId: ALEX,
    });
    if (clean.saved === null) throw new Error("expected a payee");
    expect(clean.check?.decision).toBe("verified");

    const attempt = await acknowledge.signWarning({
      verificationId: clean.saved.verificationId,
      actorId: DANA,
      reason: "Signing a clean check, which is noise in an audit trail.",
      codes: [],
    });
    expect(isErr(attempt)).toBe(true);
    if (!isErr(attempt)) return;
    expect(attempt.error.code).toBe("PAYEE_CHECK_NOT_WARNED");
  });
});

run("the loop the payment gate points at", () => {
  it("refuses the payment, names the URL that clears it, then lets it through", async () => {
    // A warned beneficiary nobody has signed for.
    await gate.confirmPayee({
      candidate: candidate("Loop"),
      payeeKey: `${RUN_ID}-loop-original`,
      actorId: ALEX,
    });
    const twin = await gate.confirmPayee({
      candidate: candidate("Loop", { accountNumberLast4: "9002" }),
      payeeKey: `${RUN_ID}-loop-twin`,
      actorId: ALEX,
    });
    if (twin.saved === null) throw new Error("expected the twin payee to be stored");

    const { mainDepositAccountId } = await import("@/lib/ledger/queries");
    const accountId = await mainDepositAccountId(RIDGELINE, sql);
    if (accountId === null) throw new Error("expected Ridgeline's deposit account");

    const destination = {
      type: "ach",
      holderName: candidate("Loop").holderName,
      routingNumber: "011401533",
      accountNumberLast4: "9002",
      accountType: "checking",
    } as const;

    const before = await gate.gatePaymentOnPayee({ accountId, destination });
    expect(before?.code).toBe("PAYEE_WARNING_UNACKNOWLEDGED");
    // THE REMEDY IS AN ADDRESS, NOT THREE VERBS. This is the whole of the fix:
    // a refusal that names an action the console does not offer is a control
    // people route around, so the message carries the URL that performs it.
    expect(before?.message).toContain(gate.signWarningHref(twin.saved.payeeId));
    expect(before?.message).toContain(twin.saved.payeeId);
    // And it names the BENEFICIARY, not only the book's own label.
    expect(before?.message).toContain(candidate("Loop").holderName);

    const signed = await acknowledge.signWarning({
      verificationId: twin.saved.verificationId,
      actorId: DANA,
      reason: "Second account belongs to the same supplier; confirmed out of band.",
      codes: ["TWIN_WITH_DIFFERENT_DETAILS"],
    });
    expect(isOk(signed)).toBe(true);

    const after = await gate.gatePaymentOnPayee({ accountId, destination });
    expect(after).toBeNull();
  });

  it("and a re-check re-opens it, because a signature answers a CHECK", async () => {
    await gate.confirmPayee({
      candidate: candidate("Reopen"),
      payeeKey: `${RUN_ID}-reopen-original`,
      actorId: ALEX,
    });
    const twin = await gate.confirmPayee({
      candidate: candidate("Reopen", { accountNumberLast4: "9002" }),
      payeeKey: `${RUN_ID}-reopen-twin`,
      actorId: ALEX,
    });
    if (twin.saved === null) throw new Error("expected the twin payee to be stored");

    await acknowledge.signWarning({
      verificationId: twin.saved.verificationId,
      actorId: DANA,
      reason: "Signed against the check that was standing at the time.",
      codes: ["TWIN_WITH_DIFFERENT_DETAILS"],
    });

    const [signedStanding] = await store.loadPayeeBook({ payeeId: twin.saved.payeeId });
    expect(signedStanding?.acknowledged).toBe(true);

    const again = await recheck.recheckPayee({ payeeId: twin.saved.payeeId, actorId: ALEX });
    expect(again.check?.decision).toBe("warned");

    const [afterRecheck] = await store.loadPayeeBook({ payeeId: twin.saved.payeeId });
    // The signature is still on the book — it is just not on THIS check.
    expect(afterRecheck?.acknowledged).toBe(false);
    const [old] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM payee_acknowledgement
       WHERE verification_id = ${twin.saved.verificationId}::uuid`;
    expect(old?.n).toBe("1");
  });
});
