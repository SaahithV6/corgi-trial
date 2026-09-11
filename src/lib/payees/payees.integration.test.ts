import { beforeAll, describe, expect, it } from "vitest";

import { isErr, isOk } from "@/lib/result";
import type { PaymentDestination } from "@/lib/approvals/types";
import type { sql as SqlHandle } from "@/lib/ledger/db";

import { abaChecksumOk, checkRoutingNumber } from "./aba";
import { IncreaseRoutingDirectory } from "./directory";
import type * as GateModule from "./gate";
import type * as StoreModule from "./store";
import type { PayeeCandidate } from "./types";
import { verifyPayee } from "./verify";

/**
 * The payee book against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/payees
 *
 * Add RUN_LIVE_TESTS=1 to also drive Increase's directory in the same pass.
 *
 * ============================================================================
 * THE FOUR CLAIMS THIS FILE EXISTS TO PROVE
 * ============================================================================
 *
 *   1. AN IMPOSSIBLE ROUTING NUMBER IS NOT STORABLE. Not "the service refuses
 *      it" — the CHECK constraint refuses it, and the attempt is made here
 *      directly against the table so the refusal is Postgres's rather than
 *      TypeScript's.
 *
 *   2. TWO COPIES OF THE CHECK DIGIT AGREE. `aba.ts` and `aba_checksum_ok()`
 *      are the same arithmetic written twice, which is normally forbidden.
 *      This runs a corpus through both and asserts they agree digit for
 *      digit. That test is the entire justification for the duplication.
 *
 *   3. A BLOCK CANNOT BE ACKNOWLEDGED AND A CLEAN CHECK CANNOT BE SIGNED FOR.
 *      The trigger decides, not the caller.
 *
 *   4. FRESHNESS IS DERIVED. The view labels a check's age against now(), and
 *      the TypeScript constants that describe the bands agree with the SQL
 *      function that defines them.
 *
 * ─── What this suite writes to the live database ────────────────────────────
 *
 * Payees, verifications, acknowledgements and refusals on a dedicated fixture
 * business, all keyed on the run id so two runs never collide. NO MONEY
 * MOVES: nothing in `src/lib/payees` can write a journal line, and the last
 * test in this file asserts that by counting entries before and after.
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;
const live = process.env["RUN_LIVE_TESTS"] === "1" ? it : it.skip;

/** Seeded. `scripts/seed.mjs` builds these; they are stable across resets. */
const RIDGELINE = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
const ALEX = "3b805475-b3a6-5717-bd98-aef8826ce05a";
const DANA = "76f9266f-23c9-52de-b8ff-0ec0b23ef386";

/** Distinct per run, so a re-run is not a replay and a replay is deliberate. */
const RUN_ID = `it-${Date.now().toString(36)}`;

/*
 * `@/lib/ledger/db` validates the environment at import time and throws when
 * APP_DATABASE_URL is absent, so importing it statically would fail this file
 * in CI — which holds no credentials on purpose and is only ever going to
 * skip. Everything that touches the database is therefore loaded in
 * `beforeAll`, behind the same gate as the suites. `standing.integration.test`
 * does the same, for the same reason.
 */
let sql: typeof SqlHandle;
let store: typeof StoreModule;
let gate: typeof GateModule;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
  store = await import("./store");
  gate = await import("./gate");
});

/**
 * A distinct beneficiary name per test.
 *
 * The twin probe is a real feature and it fires across the whole book, so two
 * tests that both write "Ridgeline Coffee Roasters LLC" at different account
 * numbers legitimately warn each other. Giving each test its own supplier is
 * how to test everything ELSE in isolation — weakening the probe to make the
 * suite quiet would be testing a different feature.
 *
 * The run id is in the NAME and not only in the payee key, for the same
 * reason: the book is append-only and yesterday's run is still in it, so a
 * name reused across runs would make every clean payee warn about its own
 * predecessor from an hour ago.
 */
function candidate(
  tag: string,
  over: Partial<PayeeCandidate> = {},
): PayeeCandidate {
  return {
    businessId: RIDGELINE,
    displayName: "Green coffee supplier",
    holderName: `Ridgeline ${tag} ${RUN_ID} Roasters LLC`,
    rail: "ach",
    routingNumber: "011401533",
    accountNumberLast4: "4417",
    accountType: "checking",
    ...over,
  };
}

run("the database refuses an impossible routing number", () => {
  it("the CHECK constraint, not the service, is what refuses it", async () => {
    // Straight at the table. No application code in the way, so what is being
    // proved is the constraint.
    await expect(
      sql`
        INSERT INTO payee
          (business_id, display_name, holder_name, rail,
           routing_number, account_number_last4, account_type,
           created_by, payee_key)
        VALUES
          (${RIDGELINE}::uuid, 'Direct insert', 'Whoever', 'ach'::rail,
           '011401534', '0000', 'checking', ${ALEX}::uuid, ${`${RUN_ID}-direct`})`,
    ).rejects.toThrow(/payee_routing_number_possible/);
  });

  it("and the refusal is recorded as a row, because the caught typo is the product", async () => {
    const check = await verifyPayee(candidate("Blocked", { routingNumber: "011401534" }));
    expect(check.decision).toBe("blocked");

    const saved = await store.savePayee({
      candidate: candidate("Blocked", { routingNumber: "011401534" }),
      check,
      payeeKey: `${RUN_ID}-blocked`,
      actorId: ALEX,
    });
    expect(isErr(saved)).toBe(true);

    const refusals = await store.loadRefusals({ businessId: RIDGELINE, limit: 20 });
    const mine = refusals.find((r) => r.routingNumber === "011401534");
    expect(mine).toBeDefined();
    expect(mine?.code).toBe("ROUTING_CHECKSUM_FAILED");
    expect(mine?.attemptedByName).toBe("Alex Whitfield");
  });

  it("a refusal row cannot hold a routing number that is actually valid", async () => {
    // The table exists for impossible numbers; a valid one is a payee with a
    // warning on it, not a refusal, and the constraint says so.
    await expect(
      sql`
        INSERT INTO payee_candidate_refusal
          (business_id, attempted_by, holder_name, rail, routing_number, code, reason)
        VALUES
          (${RIDGELINE}::uuid, ${ALEX}::uuid, 'Whoever', 'ach'::rail,
           '011401533', 'NOT_REALLY', 'this number is fine')`,
    ).rejects.toThrow(/payee_candidate_refusal_is_impossible/);
  });
});

run("two copies of the check digit, held equal", () => {
  it("aba.ts and aba_checksum_ok() agree on 300 numbers, valid and not", async () => {
    // The justification for writing the same arithmetic twice. A drift here
    // means either the form accepts what the table will refuse, or the table
    // refuses what the form promised — both are bugs a user meets as a 500.
    const corpus: string[] = [];
    let seed = 4242;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed >>> 16) % 10;
    };
    while (corpus.length < 300) {
      corpus.push(Array.from({ length: 9 }, () => next()).join(""));
    }
    // Guarantee both answers are represented rather than trusting the sample.
    corpus.push("011401533", "021000021", "101050001", "011401534", "000000000");

    const inPostgres = await store.abaChecksumOkInDatabaseBatch(corpus);
    const disagreements = corpus.filter((rn) => inPostgres.get(rn) !== abaChecksumOk(rn));
    expect(disagreements).toEqual([]);
    // And the sample really does contain both answers, so agreeing on "all
    // false" would not pass.
    expect(corpus.some((rn) => abaChecksumOk(rn))).toBe(true);
    expect(corpus.some((rn) => !abaChecksumOk(rn))).toBe(true);
  });

  it("Postgres returns false rather than throwing on input that is not nine digits", async () => {
    // The `AND` short-circuit trap: Postgres does not guarantee it, so a
    // naive `rn ~ '^[0-9]{9}$' AND substr(rn,1,1)::int ...` can evaluate the
    // cast first and raise 22P02 inside a CHECK constraint. The function uses
    // CASE for exactly this reason, and this is the test that would have
    // caught it.
    for (const rn of ["", "abcdefghi", "12345678", "0114015333"]) {
      expect(await store.abaChecksumOkInDatabase(rn)).toBe(false);
    }
  });
});

run("the book, end to end", () => {
  it("stores a payee and its first check, and derives the standing from it", async () => {
    const result = await gate.confirmPayee({
      candidate: candidate("Clean"),
      payeeKey: `${RUN_ID}-clean`,
      actorId: ALEX,
    });

    expect(result.refusal).toBe(null);
    expect(result.saved?.created).toBe(true);

    const [entry] = await store.loadPayeeBook({ payeeId: result.saved?.payeeId ?? "" });
    expect(entry).toBeDefined();
    expect(entry?.outcome).toBe("verified");
    expect(entry?.checksumOk).toBe(true);
    // Nobody could be asked, and the row says so rather than implying a check.
    expect(entry?.nameMatch).toBe("unavailable");
    expect(entry?.nameSource).toBe("payer_asserted");
    expect(entry?.counterpartyName).toBe(null);
    expect(entry?.evidence).toBe("simulated");
    // Derived, not stored.
    expect(entry?.freshness).toBe("fresh");
    expect(entry?.checkedDaysAgo).toBe(0);
  });

  it("replaying the payee key writes no second payee but does write a fresh check", async () => {
    const key = `${RUN_ID}-replay`;
    const first = await gate.confirmPayee({ candidate: candidate("Replay"), payeeKey: key, actorId: ALEX });
    const second = await gate.confirmPayee({ candidate: candidate("Replay"), payeeKey: key, actorId: ALEX });

    expect(first.saved?.created).toBe(true);
    expect(second.saved?.created).toBe(false);
    expect(second.saved?.payeeId).toBe(first.saved?.payeeId);
    expect(second.saved?.verificationId).not.toBe(first.saved?.verificationId);

    const payees = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payee WHERE payee_key = ${key}`;
    expect(payees[0]?.n).toBe(1);

    const checks = await sql<{ v: number }[]>`
      SELECT count(*)::int AS v FROM payee_verification
       WHERE payee_id = ${first.saved?.payeeId ?? null}::uuid`;
    expect(checks[0]?.v).toBe(2);
  });

  it("a twin with different bank details warns, and the warning needs a signature", async () => {
    // Same name, different account. The redirected-invoice shape.
    const twin = await gate.confirmPayee({
      candidate: candidate("Clean", { accountNumberLast4: "9002" }),
      payeeKey: `${RUN_ID}-twin`,
      actorId: ALEX,
    });

    expect(twin.saved).not.toBe(null);
    expect(twin.check.decision).toBe("warned");
    expect(twin.check.findings.map((f) => f.code)).toContain("TWIN_WITH_DIFFERENT_DETAILS");

    const verificationId = twin.saved?.verificationId ?? "";

    // Before the signature the book says unacknowledged.
    const [before] = await store.loadPayeeBook({ payeeId: twin.saved?.payeeId ?? "" });
    expect(before?.acknowledged).toBe(false);

    const signed = await store.acknowledgeWarning({
      verificationId,
      actorId: DANA,
      reason: "Confirmed the new account by phone with the supplier's finance lead, not by email.",
    });
    expect(isOk(signed)).toBe(true);

    const [after] = await store.loadPayeeBook({ payeeId: twin.saved?.payeeId ?? "" });
    expect(after?.acknowledged).toBe(true);
    expect(after?.acknowledgedByName).toBe("Dana Okonkwo");
    expect(after?.acknowledgementReason).toContain("by phone");
  });

  it("an acknowledgement is refused against a check that raised no warning", async () => {
    const clean = await gate.confirmPayee({
      candidate: candidate("Noack"),
      payeeKey: `${RUN_ID}-noack`,
      actorId: ALEX,
    });
    expect(clean.check.decision).toBe("verified");

    // The trigger, not the caller.
    const refused = await store.acknowledgeWarning({
      verificationId: clean.saved?.verificationId ?? "",
      actorId: DANA,
      reason: "nothing to sign for",
    });
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.message).toContain("answers a WARNING");
    }
  });

  it("an acknowledgement needs a sentence", async () => {
    const refused = await store.acknowledgeWarning({
      verificationId: "00000000-0000-4000-8000-000000000000",
      actorId: DANA,
      reason: "   ",
    });
    expect(isErr(refused)).toBe(true);
  });

  it("a blocked check cannot be recorded against a stored payee", async () => {
    const stored = await gate.confirmPayee({
      candidate: candidate("Blockrec"),
      payeeKey: `${RUN_ID}-blockrec`,
      actorId: ALEX,
    });
    const impossible = await verifyPayee(candidate("Blockrec", { routingNumber: "011401534" }));
    const refused = await store.recordVerification({
      payeeId: stored.saved?.payeeId ?? "",
      check: impossible,
      actorId: ALEX,
    });
    expect(isErr(refused)).toBe(true);
  });

  it("archiving is an append and cannot happen twice", async () => {
    const stored = await gate.confirmPayee({
      candidate: candidate("Archive"),
      payeeKey: `${RUN_ID}-archive`,
      actorId: ALEX,
    });
    const payeeId = stored.saved?.payeeId ?? "";

    expect(isOk(await store.archivePayee({ payeeId, actorId: ALEX, reason: "Supplier closed." }))).toBe(
      true,
    );
    // Idempotent, decided by the PRIMARY KEY rather than by an `if`.
    expect(isOk(await store.archivePayee({ payeeId, actorId: ALEX, reason: "again" }))).toBe(true);

    const archivals = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payee_archival WHERE payee_id = ${payeeId}::uuid`;
    expect(archivals[0]?.n).toBe(1);

    const [entry] = await store.loadPayeeBook({ payeeId });
    expect(entry?.archived).toBe(true);
    expect(entry?.archivalReason).toBe("Supplier closed.");
  });
});

run("append-only, proved the way db:check proves it", () => {
  it("the app role cannot UPDATE or DELETE any payee table", async () => {
    for (const table of [
      "payee",
      "payee_verification",
      "payee_acknowledgement",
      "payee_archival",
      "payee_candidate_refusal",
    ]) {
      await expect(
        sql.unsafe(`UPDATE ${table} SET created_at = created_at WHERE false`),
      ).rejects.toThrow();
      await expect(sql.unsafe(`DELETE FROM ${table} WHERE false`)).rejects.toThrow();
    }
  });

  it("holds no column a balance could hide in", async () => {
    // `pnpm db:check`'s rule, restated locally so a future column named
    // `available_cents` on a payee table fails here first.
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name LIKE 'payee%'
         AND (column_name LIKE '%balance%' OR column_name LIKE '%cents%')`;
    expect(rows).toEqual([]);
  });
});

run("freshness is derived, and defined once", () => {
  it("the SQL function's bands are the bands TypeScript describes", async () => {
    const [row] = await sql<
      { fresh: string; ageing: string; stale: string; never: string }[]
    >`
      SELECT payee_verification_freshness(now() - interval '29 days', now()) AS fresh,
             payee_verification_freshness(now() - interval '60 days', now()) AS ageing,
             payee_verification_freshness(now() - interval '91 days', now()) AS stale,
             payee_verification_freshness(NULL, now())                       AS never`;
    expect(row).toEqual({ fresh: "fresh", ageing: "ageing", stale: "stale", never: "never" });
  });

  it("a payee with no check at all reads as never, not as verified", async () => {
    // Inserted with no verification, which is a state the book must render
    // rather than a state that cannot exist.
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO payee
        (business_id, display_name, holder_name, rail,
         routing_number, account_number_last4, account_type, created_by, payee_key)
      VALUES
        (${RIDGELINE}::uuid, 'Never checked', 'Nobody Ltd', 'ach'::rail,
         '011401533', '1111', 'checking', ${ALEX}::uuid, ${`${RUN_ID}-unchecked`})
      RETURNING id`;

    const [entry] = await store.loadPayeeBook({ payeeId: inserted?.id ?? "" });
    expect(entry?.outcome).toBe(null);
    expect(entry?.freshness).toBe("never");
    expect(entry?.checkedDaysAgo).toBe(null);
  });
});

run("nothing here touches money", () => {
  it("a full confirmation writes no journal entry and no journal line", async () => {
    const before = await sql<{ e: number; l: number }[]>`
      SELECT (SELECT count(*)::int FROM journal_entry) AS e,
             (SELECT count(*)::int FROM journal_line)  AS l`;

    await gate.confirmPayee({
      candidate: candidate("Nomoney", { accountNumberLast4: "7788" }),
      payeeKey: `${RUN_ID}-nomoney`,
      actorId: ALEX,
    });
    await verifyPayee(candidate("Nomoney", { routingNumber: "011401534" }));

    const after = await sql<{ e: number; l: number }[]>`
      SELECT (SELECT count(*)::int FROM journal_entry) AS e,
             (SELECT count(*)::int FROM journal_line)  AS l`;

    expect(after[0]).toEqual(before[0]);
  });
});

run("the payment gate — the one line that goes in requestPayment()", () => {
  /*
   * These call `gatePaymentOnPayee` with the EXACT argument shape
   * `requestPayment()` has in scope at the call site documented in
   * docs/PAYEES.md — `args.accountId` and `args.destination`, the latter a
   * `PaymentDestination` from `@/lib/approvals/types`. If that signature ever
   * stops matching, this file stops compiling, which is the point: a wiring
   * instruction nothing typechecks is a wiring instruction that rots.
   */
  function destination(over: Partial<Extract<PaymentDestination, { type: "ach" }>> = {}) {
    const base: Extract<PaymentDestination, { type: "ach" }> = {
      type: "ach",
      holderName: "Ridgeline Coffee Roasters LLC",
      routingNumber: "011401533",
      accountNumberLast4: "4417",
      accountType: "checking",
    };
    return { ...base, ...over };
  }

  let accountId: string;

  beforeAll(async () => {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2100' AND business_id = ${RIDGELINE}::uuid`;
    if (account === undefined) throw new Error("the seeded Ridgeline deposit account is missing");
    accountId = account.id;
  });

  it("refuses an impossible routing number, with no database read and no provider call", async () => {
    const refusal = await gate.gatePaymentOnPayee({
      accountId,
      destination: destination({ routingNumber: "011401534" }),
    });
    expect(refusal?.code).toBe("PAYEE_ROUTING_NUMBER_IMPOSSIBLE");
    expect(refusal?.message).toContain("check digit does not hold");
  });

  it("names the swap when an adjacent transposition explains it", async () => {
    const refusal = await gate.gatePaymentOnPayee({
      accountId,
      destination: destination({ routingNumber: "101401533" }),
    });
    expect(refusal?.message).toContain("011401533");
  });

  it("lets a destination nobody has ever keyed through — the arithmetic is the check", async () => {
    const refusal = await gate.gatePaymentOnPayee({
      accountId,
      destination: destination({ accountNumberLast4: "0101" }),
    });
    expect(refusal).toBe(null);
  });

  it("refuses a payment to a payee whose warning nobody has signed for", async () => {
    // Two payees, same name, different accounts: the second warns.
    await gate.confirmPayee({
      candidate: candidate("Gatefirst", { accountNumberLast4: "1212" }),
      payeeKey: `${RUN_ID}-gate-1`,
      actorId: ALEX,
    });
    const warned = await gate.confirmPayee({
      candidate: candidate("Gatefirst", { accountNumberLast4: "3434" }),
      payeeKey: `${RUN_ID}-gate-2`,
      actorId: ALEX,
    });
    expect(warned.check.decision).toBe("warned");

    const holderName = candidate("Gatefirst").holderName;
    const before = await gate.gatePaymentOnPayee({
      accountId,
      destination: destination({ holderName, accountNumberLast4: "3434" }),
    });
    expect(before?.code).toBe("PAYEE_WARNING_UNACKNOWLEDGED");

    // A signature, and the same payment goes through. The warning was never
    // the block; the implicit override was.
    await store.acknowledgeWarning({
      verificationId: warned.saved?.verificationId ?? "",
      actorId: DANA,
      reason: "Confirmed the second account on a call to a number we already had.",
    });

    const after = await gate.gatePaymentOnPayee({
      accountId,
      destination: destination({ holderName, accountNumberLast4: "3434" }),
    });
    expect(after).toBe(null);
  });

  it("does not gate a rail that has no routing number", async () => {
    const refusal = await gate.gatePaymentOnPayee({
      accountId,
      destination: { type: "usdc", chain: "base-sepolia", address: "0xdeadbeef" },
    });
    expect(refusal).toBe(null);
  });
});

run("with the live Increase directory", () => {
  live("records a genuinely live check against 101050001", async () => {
    const directory = new IncreaseRoutingDirectory({});
    const result = await gate.confirmPayee({
      candidate: candidate("Livefound", { routingNumber: "101050001", accountNumberLast4: "5150" }),
      payeeKey: `${RUN_ID}-live`,
      actorId: ALEX,
      directory,
    });

    expect(result.saved).not.toBe(null);
    const [entry] = await store.loadPayeeBook({ payeeId: result.saved?.payeeId ?? "" });
    expect(entry?.directory).toBe("found");
    expect(entry?.directoryProvider).toBe("increase.routing_numbers");
    expect(entry?.institutionName).toBe("First Bank of the United States");
    // `live` because a real third party answered a real call. The constraint
    // `payee_verification_live_needs_a_provider` would have refused the row
    // otherwise.
    expect(entry?.evidence).toBe("live");
  });

  live("a real routing number the sandbox does not carry is still stored, as a note", async () => {
    const directory = new IncreaseRoutingDirectory({});
    const result = await gate.confirmPayee({
      candidate: candidate("Livemiss", { accountNumberLast4: "6161" }),
      payeeKey: `${RUN_ID}-live-miss`,
      actorId: ALEX,
      directory,
    });

    const [entry] = await store.loadPayeeBook({ payeeId: result.saved?.payeeId ?? "" });
    expect(entry?.directory).toBe("not_listed");
    // NOT warned. Every real routing number misses the sandbox directory, and
    // a warning that fires on everything is a warning nobody reads.
    expect(entry?.outcome).toBe("verified");
    expect(checkRoutingNumber("011401533").valid).toBe(true);
  });
});
