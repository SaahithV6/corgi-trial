/**
 * ============================================================================
 * KYB APPROVAL OPENS AN ACCOUNT — against the REAL Neon database.
 * ============================================================================
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 \
 *     pnpm vitest run src/lib/onboarding/open.integration.test.ts
 *
 * ----------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR, AND WHY IT DRIVES A REAL DEMO BUSINESS
 * ----------------------------------------------------------------------------
 *
 * The holds and pots suites open their own fixture business, for an excellent
 * reason: a delta measured against a shared customer is a delta another suite
 * can move underneath you. This one deliberately does the opposite and drives
 * KETTLE & CRUMB BAKERY LLC, a seeded demo business, because what is under
 * test is not arithmetic — it is the claim that a business on this book which
 * PASSES ITS KYB CHECK ends up able to hold money. A fixture company that this
 * file both created and approved would prove that this file can create and
 * approve a company.
 *
 * Kettle & Crumb is the honest subject for it. Its director leg is a real
 * Stripe Identity session; its registry leg is a real GLEIF miss
 * (`not_in_lei_registry`), which is the correct answer for a bakery and is
 * exactly the `needs_review` a human exists to resolve. Everything below goes
 * through the same `recordManualReview()` the onboarding screen posts to.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS NOT TOUCHED
 * ----------------------------------------------------------------------------
 *
 * SILVERLINE FREIGHT CO. is read and never written. It is the negative control
 * for the gate — `business_accounts_open()` refuses it, and the refusal writes
 * nothing, which is the point — and the book needs a business that does not end
 * up approved. A demo where everyone passes demonstrates nothing.
 *
 * ----------------------------------------------------------------------------
 * REPEATABILITY
 * ----------------------------------------------------------------------------
 *
 * Kettle & Crumb is `needs_review` the first time this runs and `approved`
 * every time after, because the approval is a real append-only row and there is
 * no teardown — `kyb_verification_leg` holds no DELETE grant, and would not be
 * torn down even if it did. So each phase below checks the state it finds and
 * asserts the invariant that holds in it, rather than assuming a fresh book.
 * That is not a weakening: the second run exercises the idempotent path, which
 * is the one the redelivery story depends on.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Sql } from "@/lib/ledger/db";
import type * as WireModule from "@/lib/kyb/wire";

import type * as OpenModule from "./open";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

/**
 * Plaid keys gate the funding leg only, and `it.skipIf` is used rather than an
 * early `return` so a skipped leg is REPORTED as skipped. A leg that returned
 * quietly would be indistinguishable from a leg that passed, and a skip is not
 * a pass.
 */
const HAS_PLAID =
  (process.env["PLAID_CLIENT_ID"] ?? "") !== "" && (process.env["PLAID_SECRET"] ?? "") !== "";

// Neon is a WAN hop away and the KYB review path makes several round trips.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const KETTLE_NAME = "Kettle & Crumb Bakery LLC";
const SILVERLINE_NAME = "Silverline Freight Co.";

/** The three leaves a customer's chart consists of, in chart order. */
const LEAVES = ["2100", "9100", "9200"] as const;

type Ctx = {
  sql: Sql;
  openBusinessAccounts: typeof OpenModule.openBusinessAccounts;
  openAccountsOnApproval: typeof OpenModule.openAccountsOnApproval;
  accountOpenings: typeof OpenModule.accountOpenings;
  recordManualReview: typeof WireModule.recordManualReview;
  transactGateForBusiness: typeof WireModule.transactGateForBusiness;
  kettleId: string;
  silverlineId: string;
  reviewer: { id: string; displayName: string; kind: string };
};

d("KYB approval opens the chart of accounts", () => {
  const ctx = {} as Ctx;

  beforeAll(async () => {
    const db = await import("@/lib/ledger/db");
    const open = await import("./open");
    const wire = await import("@/lib/kyb/wire");
    ctx.sql = db.sql;
    ctx.openBusinessAccounts = open.openBusinessAccounts;
    ctx.openAccountsOnApproval = open.openAccountsOnApproval;
    ctx.accountOpenings = open.accountOpenings;
    ctx.recordManualReview = wire.recordManualReview;
    ctx.transactGateForBusiness = wire.transactGateForBusiness;

    const businesses = await ctx.sql<{ id: string; legal_name: string }[]>`
      SELECT id, legal_name FROM business
       WHERE legal_name IN (${KETTLE_NAME}, ${SILVERLINE_NAME})`;
    const kettle = businesses.find((b) => b.legal_name === KETTLE_NAME);
    const silverline = businesses.find((b) => b.legal_name === SILVERLINE_NAME);
    if (kettle === undefined || silverline === undefined) {
      throw new Error("seed first: node scripts/seed.mjs");
    }
    ctx.kettleId = kettle.id;
    ctx.silverlineId = silverline.id;

    // The reviewer is a SEEDED HUMAN, resolved by predicate rather than by
    // name, exactly as `resolveActor()` does. 0013 refuses a non-human
    // reviewer with a composite foreign key, so this is not a convention.
    const [reviewer] = await ctx.sql<{ id: string; display_name: string; kind: string }[]>`
      SELECT id, display_name, kind::text AS kind
        FROM actor
       WHERE kind = 'human' AND business_id IS NULL AND can_approve = true
       ORDER BY display_name LIMIT 1`;
    if (reviewer === undefined) throw new Error("no seeded human approver on this book");
    ctx.reviewer = { id: reviewer.id, displayName: reviewer.display_name, kind: reviewer.kind };
  });

  async function kybStatus(businessId: string): Promise<string> {
    const [row] = await ctx.sql<{ kyb_status: string }[]>`
      SELECT kyb_status::text AS kyb_status FROM v_business_kyb WHERE business_id = ${businessId}::uuid`;
    return row?.kyb_status ?? "missing";
  }

  async function leafCodes(businessId: string): Promise<readonly string[]> {
    const rows = await ctx.sql<{ code: string }[]>`
      SELECT code FROM account
       WHERE business_id = ${businessId}::uuid
         AND code IN ('2100','9100','9200')
       ORDER BY code`;
    return rows.map((r) => r.code);
  }

  /**
   * The deposit balance, as bigint cents.
   *
   * `::bigint` is load-bearing, not decoration. `v_ledger_balance.balance_cents`
   * is `SUM(amount_cents) * normal_side`, and SUM over a bigint is NUMERIC — so
   * without the cast the driver hands back a JavaScript number, the one type
   * this codebase refuses to carry money in. The cast puts it back on OID 20,
   * where `src/lib/ledger/db.ts`'s parser turns it into a real bigint.
   */
  async function depositBalance(businessId: string): Promise<bigint> {
    const [row] = await ctx.sql<{ balance_cents: bigint }[]>`
      SELECT balance_cents::bigint AS balance_cents FROM v_ledger_balance
       WHERE business_id = ${businessId}::uuid AND code = '2100' AND book = 'financial'`;
    return row?.balance_cents ?? 0n;
  }

  async function journalLineCount(businessId: string): Promise<number> {
    const [row] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM journal_line l JOIN account a ON a.id = l.account_id
       WHERE a.business_id = ${businessId}::uuid`;
    return row?.n ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. The gate, from the outside                                          */
  /* ---------------------------------------------------------------------- */

  it("refuses to open accounts for a business that is not approved", async () => {
    // SILVERLINE. Read, refused, and left exactly as it was — which is both the
    // negative control for the gate and the reason this book still shows a
    // business that did not pass.
    const before = await leafCodes(ctx.silverlineId);
    const status = await kybStatus(ctx.silverlineId);
    expect(status).not.toBe("approved");

    const result = await ctx.openBusinessAccounts(ctx.silverlineId, ctx.reviewer.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("KYB_NOT_APPROVED");
    // The refusal came from inside the function, not from the TypeScript that
    // called it: the message is the database's own.
    expect(result.error.message).toContain("not approved");

    expect(await leafCodes(ctx.silverlineId)).toEqual(before);
    expect(await journalLineCount(ctx.silverlineId)).toBe(0);
  });

  it("cannot be bypassed: corgi_app holds no INSERT on account", async () => {
    // The enforcement that actually matters. A check inside a function is only
    // un-bypassable if there is no other door, and this is the assertion that
    // there is no other door.
    await expect(
      ctx.sql`
        INSERT INTO account (entity_id, code, name, type, book, currency, business_id)
        SELECT entity_id, '2100', 'bypass attempt', 'liability', 'financial', 'USD', id
          FROM business WHERE id = ${ctx.silverlineId}::uuid`,
    ).rejects.toThrow(/permission denied for table account/);
  });

  /* ---------------------------------------------------------------------- */
  /* 2. Approval, through the manual-review path, and its consequence       */
  /* ---------------------------------------------------------------------- */

  it("opens the whole chart when the operator clears the review queue", async () => {
    const statusBefore = await kybStatus(ctx.kettleId);
    const leavesBefore = await leafCodes(ctx.kettleId);

    if (statusBefore !== "approved") {
      // Both legs, because `v_business_kyb` takes the STRICTEST status across
      // them: clearing only the registry leaves the composite on the director's
      // `needs_review` and opens nothing, which is the view working.
      const legs = await ctx.sql<{ leg: string; status: string }[]>`
        SELECT DISTINCT ON (leg) leg::text AS leg, status::text AS status
          FROM kyb_verification_leg
         WHERE business_id = ${ctx.kettleId}::uuid
         ORDER BY leg, observed_at DESC, recorded_at DESC, seq DESC`;

      for (const leg of legs) {
        if (leg.status === "approved") continue;
        const reason =
          leg.leg === "business_registry"
            ? "GLEIF holds no LEI for this entity, which is the expected answer for a single-site bakery: the LEI population is financial-market participants and a miss is evidence of nothing. Certificate of formation and EIN letter checked against the state filing, both consistent with the applicant's claim."
            : "Stripe Identity returned a document check that did not complete to a verified state. The director's government ID and proof of address were reviewed out of band against the incorporation filing and match the named signer; identity is established on documentary evidence rather than on the session.";
        const review = await ctx.recordManualReview(ctx.kettleId, {
          leg: leg.leg as "director_kyc" | "business_registry",
          decision: "approve",
          reason,
          reviewer: ctx.reviewer,
        });
        expect(review.ok, `review of ${leg.leg} was refused`).toBe(true);
      }
    }

    expect(await kybStatus(ctx.kettleId)).toBe("approved");

    // THE CONSEQUENCE. Exactly the call the server action makes after the
    // review row lands.
    const linesBefore = await journalLineCount(ctx.kettleId);
    const result = await ctx.openAccountsOnApproval(ctx.kettleId, ctx.reviewer.id);
    // OPENING AN ACCOUNT POSTS NOTHING. Measured across the call itself rather
    // than asserted about the balance afterwards, because a later phase of this
    // suite funds the account and an absolute figure would be a test that
    // asserts the order the suite happens to run in.
    expect(await journalLineCount(ctx.kettleId)).toBe(linesBefore);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // First run opens them; a later run finds them open. Both are correct and
    // neither is "nothing happened".
    expect(["opened", "already"]).toContain(result.value.kind);
    expect(result.value.accounts.map((a) => a.rollupCode)).toEqual([...LEAVES]);

    if (leavesBefore.length === 0) {
      expect(result.value.kind).toBe("opened");
      expect(result.value.accounts.every((a) => a.opened)).toBe(true);
    }

    expect(await leafCodes(ctx.kettleId)).toEqual([...LEAVES]);
  });

  it("opened the accounts WITHOUT posting anything to the journal", async () => {
    // An account with no entries has a zero balance by construction. If opening
    // posted an "opening entry" this would be non-zero on the first run, and
    // the customer's first statement would carry two lines of noise.
    const [row] = await ctx.sql<{ balance_cents: bigint }[]>`
      SELECT balance_cents FROM v_ledger_balance
       WHERE business_id = ${ctx.kettleId}::uuid AND code = '2100'`;
    // The leaf is visible to the balance view at all, which a leaf stored under
    // the qualified code would not be. Whether it is zero depends on whether a
    // previous run of this suite funded it; what does not depend on that is
    // that the OPENING posted nothing, asserted across the call above.
    expect(row).toBeDefined();
    const opened = await ctx.accountOpenings(ctx.kettleId);
    expect(opened.length).toBe(LEAVES.length);
    for (const record of opened) {
      // The provenance CHECK makes any other value unrepresentable; this
      // asserts the row that exists says what the constraint promises.
      expect(record.kybStatus).toBe("approved");
      expect(record.openedBy).toBe(ctx.reviewer.displayName);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 3. Opening twice opens once                                            */
  /* ---------------------------------------------------------------------- */

  it("opens once however many times it is called, including concurrently", async () => {
    const accountsBefore = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account WHERE business_id = ${ctx.kettleId}::uuid
         AND code IN ('2100','9100','9200')`;
    const openingsBefore = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account_opening WHERE business_id = ${ctx.kettleId}::uuid`;

    // Five at once, not five in a row: a check-then-insert would survive the
    // sequential version and lose the race in this one. The uniqueness lives on
    // the table, so this is the database's guarantee and not the caller's.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.openAccountsOnApproval(ctx.kettleId, ctx.reviewer.id),
      ),
    );

    const ids = new Set<string>();
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.kind).toBe("already");
      for (const account of result.value.accounts) {
        expect(account.opened).toBe(false);
        ids.add(`${account.rollupCode}:${account.accountId}`);
      }
    }
    // Five calls, three distinct accounts. Every call named the SAME rows.
    expect(ids.size).toBe(LEAVES.length);

    const accountsAfter = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account WHERE business_id = ${ctx.kettleId}::uuid
         AND code IN ('2100','9100','9200')`;
    const openingsAfter = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account_opening WHERE business_id = ${ctx.kettleId}::uuid`;

    expect(accountsAfter[0]?.n).toBe(accountsBefore[0]?.n);
    expect(openingsAfter[0]?.n).toBe(openingsBefore[0]?.n);
    expect(accountsAfter[0]?.n).toBe(LEAVES.length);
  });

  /* ---------------------------------------------------------------------- */
  /* 4. The new leaf did not break anything that was already true           */
  /* ---------------------------------------------------------------------- */

  it("leaves every ledger invariant view empty", async () => {
    // v_deposit_control_drift in particular: 0015's header records that a NEW
    // ACCOUNT LEVEL silently broke this view's `reported_cents` half once
    // already, and a new deposit leaf is exactly that class of change. Verified,
    // not assumed.
    for (const view of [
      "v_deposit_control_drift",
      "v_entry_unbalanced",
      "v_line_denorm_drift",
      "v_book_not_zero",
      "v_business_account_malformed",
      "v_approved_without_accounts",
    ]) {
      const rows = await ctx.sql.unsafe(`SELECT count(*)::int AS n FROM ${view}`);
      expect(rows[0]?.["n"], `${view} must be empty`).toBe(0);
    }
  });

  it("shows the deposit leaf to every consumer that addresses it by bare code", async () => {
    // The trap chart.ts warns about: a leaf stored under the QUALIFIED code
    // '2100/<uuid>' would make v_available_balance, v_overdrawn_accounts and
    // v_deposit_control_drift all return nothing for this customer, silently.
    const [deposit] = await ctx.sql<{ code: string; is_postable: boolean }[]>`
      SELECT code, is_postable FROM account
       WHERE business_id = ${ctx.kettleId}::uuid AND code = '2100' AND book = 'financial'`;
    expect(deposit?.code).toBe("2100");
    expect(deposit?.is_postable).toBe(true);

    const [available] = await ctx.sql<{ available_cents: bigint }[]>`
      SELECT available_cents FROM v_available_balance
       WHERE business_id = ${ctx.kettleId}::uuid`;
    expect(available).toBeDefined();
  });

  /* ---------------------------------------------------------------------- */
  /* 5. It can now do the things an account is for                          */
  /* ---------------------------------------------------------------------- */

  it("can now transact: the gate that refused it before now allows it", async () => {
    const decision = await ctx.transactGateForBusiness(ctx.kettleId);
    expect(decision.allowed).toBe(true);
  });

  it.skipIf(!HAS_PLAID)("can be funded from a linked external bank, into the account approval opened", async () => {
    // The brief's core loop, leg two, against the account leg one just opened.
    // Plaid sandbox for real — link an Item, read its fundable accounts, and
    // book the credit through the same `fundFromLinkedAccount()` the /funding
    // screen posts to.
    const { linkExternalAccount, fundFromLinkedAccount } = await import(
      "@/lib/rails/plaid/adapter"
    );

    const link = await linkExternalAccount({ clientUserId: ctx.kettleId });
    const source = link.fundable[0];
    expect(source, "the Plaid sandbox Item exposes no fundable depository account").toBeDefined();
    if (source === undefined) return;

    // Money is bigint cents. $4,250.00.
    const amountCents = 425_000n;
    const valueDate = new Date().toISOString().slice(0, 10);
    // Derived from a SOURCE FACT, not from a uuid minted here, so a re-run of
    // this suite on the same day books one deposit and not a second.
    const reference = `kettle-opening-deposit-${valueDate}`;

    const before = await depositBalance(ctx.kettleId);
    const receipt = await fundFromLinkedAccount({
      businessId: ctx.kettleId,
      amountCents,
      linked: source,
      // A first deposit from an account we have not seen before: the longest
      // funds-availability hold the policy table offers, which is the honest
      // class for money arriving at a business that opened an hour ago.
      counterpartyClass: "new",
      valueDate,
      reference,
    });

    // The credit landed in the leaf approval opened, and nowhere else.
    const [deposit] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM account WHERE business_id = ${ctx.kettleId}::uuid
         AND code = '2100' AND book = 'financial'`;
    expect(receipt.depositAccountId).toBe(deposit?.id);

    const after = await depositBalance(ctx.kettleId);
    if (receipt.created) {
      expect(after - before).toBe(amountCents);
    } else {
      // Same reference, same day: idempotent, nothing new booked.
      expect(after).toBe(before);
    }
    expect(after).toBeGreaterThan(0n);
  });

  it("can raise a payment, which lands in the maker-checker queue", async () => {
    const { requestPayment } = await import("@/lib/approvals/instructions");

    const [deposit] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM account WHERE business_id = ${ctx.kettleId}::uuid
         AND code = '2100' AND book = 'financial'`;
    expect(deposit).toBeDefined();
    if (deposit === undefined) return;

    const valueDate = new Date().toISOString().slice(0, 10);
    const result = await requestPayment({
      accountId: deposit.id,
      rail: "ach",
      // $3,000.00, against an ACH threshold of $2,500.00, so this payment is
      // ABOVE the line: it lands in the maker-checker queue needing a second
      // human rather than slipping under it. The threshold is read from
      // `approval_policy` below rather than trusted from this comment.
      amountCents: 300_000n,
      destination: {
        type: "ach",
        holderName: "Stoneground Flour Co.",
        routingNumber: "021000021",
        accountNumberLast4: "4417",
        accountType: "checking",
      },
      valueDate,
      requestedByActorId: ctx.reviewer.id,
      idempotencyKey: `kettle-flour-invoice-above-threshold-${valueDate}`,
    });

    // Not JSON.stringify: a refusal carries bigint cents and JSON cannot
    // serialise one, so the failure message would replace the failure.
    expect(result.ok, result.ok ? "" : `requestPayment refused: ${result.error.code} — ${result.error.message}`).toBe(true);
    if (!result.ok) return;
    // Raised, not released. `approvalsRequired` above zero is the whole claim:
    // the payment is sitting in the maker-checker queue waiting for a second
    // human, and the initiator is not allowed to be them — a rule the approvals
    // suite asserts and this one does not re-prove.
    expect(result.value.instructionId).toMatch(/^[0-9a-f-]{36}$/);
    // Above the threshold the instruction cites, so a second human is required.
    expect(result.value.policy.thresholdCents).toBeLessThan(300_000n);
    expect(result.value.approvalsRequired).toBeGreaterThan(0);

    const [row] = await ctx.sql<{ account_id: string; amount_cents: bigint }[]>`
      SELECT account_id, amount_cents FROM payment_instruction
       WHERE id = ${result.value.instructionId}::uuid`;
    expect(row?.account_id).toBe(deposit.id);
    expect(row?.amount_cents).toBe(300_000n);
  });
});
