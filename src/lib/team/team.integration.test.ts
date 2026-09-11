/**
 * The team, against the REAL Neon database — and, when asked, against the real
 * Lithic sandbox.
 *
 * Two gates, because the two cost different things:
 *
 *   RUN_DB_TESTS=1     every scenario below except the last. Reads and writes
 *                      Neon. Free, fast, and run on every pass.
 *   RUN_LITHIC_TESTS=1 scenario 12 only: creates a REAL card on the Lithic
 *                      sandbox and gives it to a member. Left off by default so
 *                      a test run does not add a card to the program every time
 *                      somebody presses save — the account already carries the
 *                      scars of automated runs.
 *
 *     set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run src/lib/team
 *
 * ─── WHAT THIS SUITE PROVES ─────────────────────────────────────────────────
 *
 *   1  the TypeScript capability matrix and `team_role_can()` agree, cell by
 *      cell, including on a capability neither has heard of
 *   2  the terms chain is append-only — the database refuses an UPDATE
 *   3  removal is TERMINAL: no version may follow it
 *   4  approval rights cannot be granted after the fact, because `actor` is
 *      append-only and 0033 may only narrow it
 *   5  a removed member's card DECLINES, through the same `decide()` the
 *      provider drives, with the card's own controls not even consulted
 *   6  a suspended member's card declines, and a REFUND to it does not
 *   7  the person's envelope bites where the card's limit would have allowed it
 *   8  a member's spend is summed across EVERY card they hold
 *   9  removing a member leaves an outstanding authorisation completely
 *      untouched — same hold, same H(E), same memo balance, same journal
 *  10  maker-checker: a peer may approve, a subordinate may not approve their
 *      administrator, and a member of another business may not approve at all
 *  11  both invariant views are empty, and one of them is made to FAIL first
 *  12  (gated) a real Lithic card, issued to a real member
 */
import { beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { decide } from "@/lib/cards/decide";
import { PURCHASE_STATUSES, type AsaRequestStatus, type AuthRequest } from "@/lib/cards/types";

import { TEAM_CAPABILITIES, TEAM_ROLES, roleCan } from "./roles";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const LIVE = process.env["RUN_LITHIC_TESTS"] === "1";
const d = RUN ? describe : describe.skip;
const dLive = RUN && LIVE ? describe : describe.skip;

/** Unique per run, so two runs never share a velocity window or an email. */
const RUN_ID = Date.now().toString(36);

type Sql = ReturnType<typeof postgres>;
let sql: Sql;

/**
 * The modules are imported DYNAMICALLY inside `beforeAll`, and that is not a
 * style choice — `@/lib/ledger/db` parses the environment at module scope and
 * throws when `APP_DATABASE_URL` is absent, deliberately, so a malformed URL
 * kills the process at boot rather than at the first request that needs money.
 * A static import would make this file fail to COLLECT on a CI runner with no
 * credentials, and `describe.skip` cannot skip a module that threw while being
 * loaded. `cards.integration.test.ts` does the same thing for the same reason.
 */
import type * as StoreModule from "./store";
import type * as LifecycleModule from "./lifecycle";
import type * as CardStoreModule from "@/lib/cards/store";
import type * as HoldsModule from "@/lib/holds";
import type * as BalancesModule from "@/lib/ledger/balances";

let store: typeof StoreModule;
let lifecycle: typeof LifecycleModule;
let cardStore: typeof CardStoreModule;
let holds: typeof HoldsModule;
let balances: typeof BalancesModule;

const BIZ_A = "e274546d-6bdd-5266-b0fb-cc839a7811f9"; // Ridgeline Robotics, Inc.
const BIZ_B = "1151e7b5-b75b-5f58-bdbf-68cd714178ce"; // Kettle & Crumb Bakery LLC
/** Dana Okonkwo — Corgi staff, can_approve. The bootstrap author. */
const STAFF = "76f9266f-23c9-52de-b8ff-0ec0b23ef386";

beforeAll(async () => {
  if (!RUN) return;
  const url = process.env["APP_DATABASE_URL"];
  if (url === undefined) throw new Error("APP_DATABASE_URL is not set");
  sql = postgres(url, {
    max: 2,
    onnotice: () => {},
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: bigint | number) => v.toString(),
        parse: (v: string) => BigInt(v),
      },
    },
  });
  store = await import("./store");
  lifecycle = await import("./lifecycle");
  cardStore = await import("@/lib/cards/store");
  // The ledger's own named readers. This suite reaches `account`,
  // `journal_entry` and `journal_line` through them and never in SQL of its
  // own — `src/lib/ledger/boundary.test.ts` holds test suites to the same
  // boundary as modules, deliberately, because a test that re-expresses a
  // ledger query is a test asserting its own definition of the answer.
  holds = await import("@/lib/holds");
  balances = await import("@/lib/ledger/balances");
});

/** A member nobody else's test will touch. Returns the member id. */
async function member(
  role: "viewer" | "initiator" | "approver" | "admin",
  suffix: string,
  limits: { perTxn?: bigint; day?: bigint; month?: bigint } = {},
  businessId = BIZ_A,
  conn: never = sql as never,
): Promise<string> {
  const result = await store.addMember(
    {
      businessId,
      displayName: `Test ${suffix} ${RUN_ID}`,
      email: `test-${suffix}-${RUN_ID}@example.test`,
      role,
      actorId: STAFF,
      note: `integration test ${RUN_ID}`,
      perTxnLimitCents: limits.perTxn ?? null,
      dailyLimitCents: limits.day ?? null,
      monthlyLimitCents: limits.month ?? null,
    },
    conn,
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}

/**
 * Register a card in this book and give it to a member. No provider call.
 *
 * Through `registerCard()` — the SAME function the issuing path uses, which
 * resolves the customer's 2100 and 9100 leaves itself. A fixture that wrote its
 * own INSERT would be testing a card binding this system does not create.
 */
async function cardFor(
  memberId: string,
  businessId = BIZ_A,
  conn: never = sql as never,
): Promise<string> {
  const token = `team-test-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  const binding = await holds.registerCard(
    { provider: "lithic", providerCardToken: token, businessId, lastFour: "4242", nickname: "team test" },
    conn,
  );
  const assigned = await store.assignCardToMember(
    { cardId: binding.cardId, memberId, actorId: STAFF },
    conn,
  );
  if (!assigned.ok) throw new Error(`${assigned.code}: ${assigned.message}`);
  return token;
}

/* ========================================================================== */

d("1. the capability matrix has exactly one definition", () => {
  it("agrees with team_role_can() in every cell", async () => {
    // Sixteen cells, asked of Postgres one statement at a time, compared with
    // the TypeScript copy. Two copies of a permission matrix is how a
    // permission system becomes decorative; this is the test that stops it.
    for (const role of TEAM_ROLES) {
      for (const capability of TEAM_CAPABILITIES) {
        const [row] = await sql<{ can: boolean }[]>`
          SELECT team_role_can(${role}, ${capability}) AS can`;
        expect(
          row?.can,
          `team_role_can('${role}', '${capability}') disagrees with roles.ts`,
        ).toBe(roleCan(role, capability));
      }
    }
  });

  it("says false on both sides for a capability neither has heard of", async () => {
    const [row] = await sql<{ can: boolean }[]>`
      SELECT team_role_can('admin', 'launch_the_missiles') AS can`;
    expect(row?.can).toBe(false);
  });

  it("keeps one list of the statuses that consume a limit", () => {
    // `src/lib/team/store.ts` restates PURCHASE_STATUSES rather than importing
    // it, to keep the card-control module out of a page render. The day the two
    // disagree is the day a refund starts eating somebody's monthly allowance.
    expect([...PURCHASE_STATUSES]).toEqual(["AUTHORIZATION", "FINANCIAL_AUTHORIZATION"]);
  });
});

d("2. the terms chain is append-only", () => {
  it("refuses an UPDATE, from the application role", async () => {
    const id = await member("initiator", "append");
    await expect(
      sql`UPDATE team_member_version SET role = 'admin' WHERE member_id = ${id}`,
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it("refuses a DELETE of the membership itself", async () => {
    const id = await member("viewer", "nodelete");
    await expect(sql`DELETE FROM team_member WHERE id = ${id}`).rejects.toThrow(
      /permission denied|append-only/i,
    );
  });
});

d("3. removal is terminal", () => {
  it("refuses any version after a removal", async () => {
    const id = await member("initiator", "terminal");
    const removed = await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "removed",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "left the company",
        },
        actorId: STAFF,
      },
      sql as never,
    );
    expect(removed.ok).toBe(true);

    const undo = await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "active",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "actually, come back",
        },
        actorId: STAFF,
      },
      sql as never,
    );
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.message).toMatch(/removal is terminal/i);
  });

  it("lets the same person be re-added as a NEW membership spell", async () => {
    const email = `test-rehire-${RUN_ID}@example.test`;
    const first = await store.addMember(
      {
        businessId: BIZ_A,
        displayName: `Test rehire ${RUN_ID}`,
        email,
        role: "initiator",
        actorId: STAFF,
        note: "first spell",
      },
      sql as never,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A second live membership is not representable.
    const dup = await store.addMember(
      {
        businessId: BIZ_A,
        displayName: `Test rehire ${RUN_ID}`,
        email,
        role: "initiator",
        actorId: STAFF,
        note: "second, while the first is live",
      },
      sql as never,
    );
    expect(dup.ok).toBe(false);

    await store.setMemberTerms(
      {
        memberId: first.value,
        draft: {
          state: "removed",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "left",
        },
        actorId: STAFF,
      },
      sql as never,
    );

    const second = await store.addMember(
      {
        businessId: BIZ_A,
        displayName: `Test rehire ${RUN_ID}`,
        email,
        role: "initiator",
        actorId: STAFF,
        note: "re-hired",
      },
      sql as never,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same person, same actor, two spells — so their history reads as one
    // person's and their old journal entries still point at the same principal.
    const [a] = await sql<{ actor_id: string; membership_seq: number }[]>`
      SELECT actor_id, membership_seq FROM team_member WHERE id = ${first.value}`;
    const [b] = await sql<{ actor_id: string; membership_seq: number }[]>`
      SELECT actor_id, membership_seq FROM team_member WHERE id = ${second.value}`;
    expect(b?.actor_id).toBe(a?.actor_id);
    expect(b?.membership_seq).toBe((a?.membership_seq ?? 0) + 1);
  });
});

d("4. approval rights cannot be granted after the fact", () => {
  it("refuses to promote a viewer into a role that carries approve_payment", async () => {
    const id = await member("viewer", "promote");
    const promoted = await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "active",
          role: "approver",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "promotion",
        },
        actorId: STAFF,
      },
      sql as never,
    );
    // Refused LOUDLY here rather than accepted and then silently ignored by
    // assert_maker_checker() at the moment somebody tries to approve a payment.
    // A screen that says yes and a database that says no is the defect class
    // this whole build hunts.
    expect(promoted.ok).toBe(false);
    if (!promoted.ok) expect(promoted.message).toMatch(/append-only|approval rights/i);
  });

  it("allows a demotion, because narrowing is always safe", async () => {
    const id = await member("approver", "demote");
    const demoted = await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "active",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "moved off the approvals rota",
        },
        actorId: STAFF,
      },
      sql as never,
    );
    expect(demoted.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The authorisation path                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The real hot-path read, with a longer deadline than the real hot path.
 *
 * `CONTROL_READ_BUDGET_MS` is 600 ms and the deployed function runs in `iad1`,
 * in Neon's own region, where the measured server-side execution of this query
 * is 0.6 ms. From a laptop on the other side of the WAN a cold pool can miss
 * 600 ms outright — and when it does, `decide()` correctly returns
 * `control_store_unavailable`, which is the RIGHT answer to a missed deadline
 * and the WRONG thing for a test about member rules to be measuring. So the
 * budget is widened here and nowhere else: this suite is testing the rules, and
 * `cards.integration.test.ts` scenario 7 is what tests the budget.
 */
async function lookupFor(token: string) {
  return cardStore.readControlsAndSpend({
    provider: "lithic",
    providerCardToken: token,
    source: "harness",
    budgetMs: 15_000,
  });
}

function request(
  amountCents: bigint,
  token: string,
  status: AsaRequestStatus = "AUTHORIZATION",
): AuthRequest {
  return {
    providerAuthToken: `00000000-0000-4000-8000-${RUN_ID.padStart(12, "0").slice(-12)}`,
    card: { token, lastFour: "4242", memo: "corgi", state: "OPEN" },
    amountCents,
    mcc: "5542",
    merchantDescriptor: "CORGI FUEL PUMP 14",
    requestStatus: status,
  };
}

d("5. a removed member's card stops authorising", () => {
  it("declines a purchase on rule member_removed, WITHOUT consulting the card's controls", async () => {
    const id = await member("initiator", "stopcard");
    const token = await cardFor(id);

    // The card has NO control version at all — nobody has ever set a limit on
    // it. That is the case that matters: if the member rules sat after
    // `no_controls_configured`, this card would keep approving after its holder
    // was removed, because that rule approves.
    //
    // Note which rule fires here. NOT `no_controls_configured`: that rule now
    // also requires the card to belong to nobody, and this one belongs to
    // somebody whose limits happen to be null. So it is `within_controls`,
    // citing a null control version and a real member version — which is the
    // accurate sentence, and the tightened predicate is in `decide.ts` §15.
    const before = decide(request(5_000n, token), await lookupFor(token));
    expect(before.outcome).toBe("approve");
    expect(before.rule).toBe("within_controls");
    expect(before.inputs["control_version"]).toBeNull();
    expect(before.inputs["member_id"]).toBe(id);

    await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "removed",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "left the company",
        },
        actorId: STAFF,
      },
      sql as never,
    );

    const after = decide(request(5_000n, token), await lookupFor(token));
    expect(after.outcome).toBe("decline");
    expect(after.rule).toBe("member_removed");
    expect(after.result).toBe("CARD_PAUSED");
    expect(after.inputs["controls_consulted"]).toBe(false);
    expect(after.inputs["member_id"]).toBe(id);
  });
});

d("6. a suspended member declines purchases and still receives refunds", () => {
  it("declines the purchase and approves the credit", async () => {
    const id = await member("initiator", "suspend");
    const token = await cardFor(id);
    await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "suspended",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "on leave pending a review",
        },
        actorId: STAFF,
      },
      sql as never,
    );

    const lookup = await lookupFor(token);
    expect(decide(request(5_000n, token), lookup).rule).toBe("member_suspended");

    // A refund goes back to the BUSINESS's 2100, not to the individual.
    // Declining it would leave the customer unable to receive their own money
    // back because an employee is suspended.
    const refund = decide(request(4_000n, token, "CREDIT_AUTHORIZATION"), lookup);
    expect(refund.outcome).toBe("approve");
    expect(refund.rule).toBe("credit_not_a_purchase");
  });
});

d("7. the person's envelope sits on top of the card's", () => {
  it("declines where the card's own limit would have allowed it", async () => {
    // Card: no limits at all. Person: $250 per transaction.
    const id = await member("initiator", "envelope", { perTxn: 25_000n });
    const token = await cardFor(id);

    const lookup = await lookupFor(token);
    const verdict = decide(request(30_000n, token), lookup);
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("member_per_transaction_limit_exceeded");
    expect(verdict.inputs["scope"]).toBe("member");
    expect(verdict.inputs["limit_cents"]).toBe("25000");

    // And a transaction inside it is approved, citing BOTH scopes.
    const ok = decide(request(20_000n, token), lookup);
    expect(ok.outcome).toBe("approve");
    expect(ok.rule).toBe("within_controls");
    expect(ok.inputs["member_per_txn_limit_cents"]).toBe("25000");
  });

  it("checks the card first, so the narrower instrument gives the reason", async () => {
    const id = await member("initiator", "order", { perTxn: 25_000n });
    const token = await cardFor(id);
    const [card] = await sql<{ id: string }[]>`
      SELECT id FROM card WHERE provider_card_token = ${token}`;
    const set = await cardStore.setCardControls({
      cardId: card?.id ?? "",
      draft: {
        cardState: "active",
        perTxnLimitCents: 10_000n,
        dailyLimitCents: null,
        monthlyLimitCents: null,
        blockedMccs: [],
        note: "tighter than the person's own envelope",
      },
      actorId: STAFF,
    });
    expect(set.ok).toBe(true);

    // $150 breaks BOTH. First match wins and the card is first.
    const verdict = decide(request(15_000n, token), await lookupFor(token));
    expect(verdict.rule).toBe("per_transaction_limit_exceeded");
  });
});

d("8. a person's spend is summed across every card they hold", () => {
  it("counts an approval on card A against the limit on card B", async () => {
    // $400 a day, two cards, neither with a limit of its own.
    const id = await member("initiator", "twocards", { day: 40_000n });
    const tokenA = await cardFor(id);
    const tokenB = await cardFor(id);

    const first = decide(request(30_000n, tokenA), await lookupFor(tokenA));
    expect(first.outcome).toBe("approve");
    await cardStore.appendDecision({
      provider: "lithic",
      request: request(30_000n, tokenA),
      lookup: await lookupFor(tokenA),
      verdict: first,
      latencyUs: 100,
      source: "harness",
      requestId: null,
    });

    // $200 on the OTHER card. Per card, both are fine; for the person, the day
    // is $500 against a $400 limit. A per-card limit cannot see this.
    const second = decide(request(20_000n, tokenB), await lookupFor(tokenB));
    expect(second.outcome).toBe("decline");
    expect(second.rule).toBe("member_daily_limit_exceeded");
    expect(second.inputs["spend_cents"]).toBe("30000");
    expect(second.inputs["would_total_cents"]).toBe("50000");
  });
});

d("9. removing a member leaves an outstanding authorisation untouched", () => {
  it("changes nothing about the hold, the fold or the journal", async () => {
    /**
     * THE WHOLE SCENARIO RUNS INSIDE A TRANSACTION THAT IS ROLLED BACK, and
     * that is not tidiness — it is a bug this suite already caused once.
     *
     * The scenario needs an authorisation it OWNS, so it writes the three rows
     * the webhook consumer writes: a hold, a card_authorization and one
     * card_auth_event. It deliberately posts no memo entry, because this suite
     * never posts. The consequence, which took a `pnpm db:check` to notice, is
     * a hold whose fold says H(E) = $50.00 and whose memo book says $0.00 —
     * which is exactly what `v_hold_drift` exists to catch, and it caught it.
     * Every earlier run left one behind, and they had to be retired through
     * `expireOne()` by hand.
     *
     * A test that leaves a drift row on a live book is a test that makes a
     * real guard cry wolf, and the next person to see `v_hold_drift` with a row
     * in it has to prove it was only a fixture before they can go back to bed.
     * So: one transaction, every assertion inside it, rolled back at the end.
     * The fixture never exists outside this function.
     */
    let failure: unknown = null;
    try {
      await sql.begin(async (tx) => {
        const conn = tx as never;
        const id = await member("initiator", "outstanding", {}, BIZ_A, conn);
        const token = await cardFor(id, BIZ_A, conn);
        const [card] = await tx<{ id: string; account_id: string; memo_account_id: string }[]>`
          SELECT id, account_id, memo_account_id FROM card WHERE provider_card_token = ${token}`;
        if (card === undefined) throw new Error("no fixture card");

        // A $50 authorisation, written the way the webhook consumer writes one.
        const ref = `lithic:team-test-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
        const [hold] = await tx<{ id: string }[]>`
          INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, expires_at)
          VALUES (${card.account_id}::uuid, ${card.memo_account_id}::uuid, 'card_auth',
                  ${ref}, current_date, now() + interval '7 days')
          RETURNING id`;
        const [auth] = await tx<{ id: string }[]>`
          INSERT INTO card_authorization (provider, provider_auth_id, card_id, account_id,
                                          hold_id, origin, expires_at)
          VALUES ('lithic', ${ref}, ${card.id}::uuid, ${card.account_id}::uuid,
                  ${hold?.id ?? ""}::uuid, 'authorization', now() + interval '7 days')
          RETURNING id`;
        await tx`
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
          VALUES (${auth?.id ?? ""}::uuid, 'authorization', 5000, false, current_date, ${`${ref}-e1`})`;

        const snapshot = async () =>
          tx<
            {
              auth_net_cents: bigint;
              captured_cents: bigint;
              target_hold_cents: bigint;
              is_closed: boolean;
              memo_balance_cents: bigint;
              event_count: bigint;
            }[]
          >`
            SELECT ch.auth_net_cents, ch.captured_cents, ch.target_hold_cents, ch.is_closed,
                   hs.memo_balance_cents,
                   (SELECT count(*) FROM card_auth_event WHERE auth_id = ${auth?.id ?? ""}::uuid) AS event_count
              FROM v_card_auth_hold ch
              JOIN v_hold_state hs ON hs.hold_id = ${hold?.id ?? ""}::uuid
             WHERE ch.auth_id = ${auth?.id ?? ""}::uuid`;

        const before = await snapshot();
        // Compared as text. `target_hold_cents` is a CASE over GREATEST in
        // `v_card_auth_hold`, so Postgres types it `numeric` rather than `int8`
        // and this suite's own driver hands it back as a string. The figure is
        // what matters and it is never parsed into a JS number.
        expect(String(before[0]?.target_hold_cents)).toBe("5000");

        const outstandingBefore = await lifecycle.outstandingForMember(id, conn);
        expect(outstandingBefore).toHaveLength(1);

        // REMOVE. No provider call is made here — `setMemberTerms` is the
        // database half on its own, which is exactly the half being tested.
        const removed = await store.setMemberTerms(
          {
            memberId: id,
            draft: {
              state: "removed",
              role: "initiator",
              perTxnLimitCents: null,
              dailyLimitCents: null,
              monthlyLimitCents: null,
              note: "removed while holding an outstanding authorisation",
            },
            actorId: STAFF,
          },
          conn,
        );
        expect(removed.ok).toBe(true);

        const after = await snapshot();
        // Byte for byte. A removal that released this hold would hand the
        // customer back money the merchant is still going to claim.
        expect(after).toEqual(before);

        // And it is still THERE to settle — still reported, still open, still
        // attributable to the person who is no longer on the team.
        const stillOpen = await lifecycle.outstandingForMember(id, conn);
        expect(stillOpen).toHaveLength(1);
        expect(String(stillOpen[0]?.targetHoldCents)).toBe("5000");

        // The card still resolves to the same book. This is what makes the
        // settlement land: the async path is keyed on the token, not the person.
        const [binding] = await tx<{ account_id: string; memo_account_id: string }[]>`
          SELECT account_id, memo_account_id FROM card WHERE provider_card_token = ${token}`;
        expect(binding?.account_id).toBe(card.account_id);
        expect(binding?.memo_account_id).toBe(card.memo_account_id);

        throw new Error("rollback");
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== "rollback") failure = thrown;
    }
    if (failure !== null) throw failure;
  });
});

/* -------------------------------------------------------------------------- */
/* Maker-checker                                                              */
/* -------------------------------------------------------------------------- */

d("10. maker-checker, now that there are members", () => {
  /** Raise an above-threshold ACH payment for a business, as `actorId`. */
  async function raise(actorId: string, businessId: string, amountCents: bigint) {
    const [policy] = await sql<{ id: string }[]>`
      SELECT id FROM approval_policy WHERE rail = 'ach' ORDER BY effective_from DESC LIMIT 1`;
    const accountId = await balances.mainDepositAccountId(businessId, sql as never);
    const key = `team-test-${RUN_ID}-${Math.random().toString(36).slice(2, 10)}`;
    const [pi] = await sql<{ id: string; content_hash: Buffer }[]>`
      INSERT INTO payment_instruction (account_id, rail, amount_cents, counterparty,
                                       value_date, requested_by, policy_id,
                                       idempotency_key, content_hash)
      VALUES (${accountId ?? ""}::uuid, 'ach', ${amountCents.toString()}::bigint,
              ${sql.json({ name: "Test payee" })}, current_date,
              ${actorId}::uuid, ${policy?.id ?? ""}::uuid, ${key},
              digest(${key}, 'sha256'))
      RETURNING id, content_hash`;
    await sql`
      INSERT INTO payment_instruction_event (instruction_id, kind, actor_id, value_date)
      VALUES (${pi?.id ?? ""}::uuid, 'requested', ${actorId}::uuid, current_date)`;
    return pi;
  }

  async function approve(instructionId: string, hash: Buffer, actorId: string) {
    return sql`
      INSERT INTO payment_instruction_event (instruction_id, kind, actor_id,
                                             approved_content_hash, value_date)
      VALUES (${instructionId}::uuid, 'approved', ${actorId}::uuid, ${hash}, current_date)`;
  }

  async function actorOf(memberId: string): Promise<string> {
    const [row] = await sql<{ actor_id: string }[]>`
      SELECT actor_id FROM team_member WHERE id = ${memberId}`;
    return row?.actor_id ?? "";
  }

  it("lets two peers approve each other — mutual approval is ALLOWED", async () => {
    // The deliberate answer. What maker-checker buys is that two humans looked
    // at the same content hash; forbidding peers would make the control
    // unusable for a three-person business and push people into sharing a
    // login, which destroys attribution entirely.
    const one = await member("approver", "peer1");
    const two = await member("approver", "peer2");
    const a = await actorOf(one);
    const b = await actorOf(two);

    const pi = await raise(a, BIZ_A, 900_000n);
    await expect(approve(pi?.id ?? "", pi?.content_hash ?? Buffer.alloc(32), b)).resolves.toBeDefined();

    const pi2 = await raise(b, BIZ_A, 900_000n);
    await expect(approve(pi2?.id ?? "", pi2?.content_hash ?? Buffer.alloc(32), a)).resolves.toBeDefined();
  });

  it("refuses an approval by somebody the initiator administers", async () => {
    const boss = await member("admin", "boss");
    const report = await member("approver", "report");
    const bossActor = await actorOf(boss);
    const reportActor = await actorOf(report);

    const pi = await raise(bossActor, BIZ_A, 900_000n);
    await expect(
      approve(pi?.id ?? "", pi?.content_hash ?? Buffer.alloc(32), reportActor),
    ).rejects.toThrow(/administers the team/i);
  });

  it("allows the reverse direction: an admin approving their report's payment", async () => {
    // Only one direction is refused. The approver being under the INITIATOR's
    // control is what makes the second pair of eyes not independent; the
    // initiator being under the approver's control does not.
    const boss = await member("admin", "boss2");
    const report = await member("initiator", "report2");
    const pi = await raise(await actorOf(report), BIZ_A, 900_000n);
    await expect(
      approve(pi?.id ?? "", pi?.content_hash ?? Buffer.alloc(32), await actorOf(boss)),
    ).resolves.toBeDefined();
  });

  it("refuses an approver who is a member of a DIFFERENT business", async () => {
    // A hole that existed until 0033: `actor.can_approve` is global, so a
    // customer's signer could approve another customer's payment.
    const theirs = await member("approver", "other", {}, BIZ_B);
    const ours = await member("initiator", "ours");
    const pi = await raise(await actorOf(ours), BIZ_A, 900_000n);
    await expect(
      approve(pi?.id ?? "", pi?.content_hash ?? Buffer.alloc(32), await actorOf(theirs)),
    ).rejects.toThrow(/not a member of business/i);
  });

  it("refuses an approval by a REMOVED member, whose actor row still says can_approve", async () => {
    const gone = await member("approver", "gone");
    const maker = await member("initiator", "maker");
    const goneActor = await actorOf(gone);

    await store.setMemberTerms(
      {
        memberId: gone,
        draft: {
          state: "removed",
          role: "approver",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "left",
        },
        actorId: STAFF,
      },
      sql as never,
    );

    // The actor column is unchanged — it is append-only and 0001 owns it.
    const [actorRow] = await sql<{ can_approve: boolean }[]>`
      SELECT can_approve FROM actor WHERE id = ${goneActor}`;
    expect(actorRow?.can_approve).toBe(true);

    const pi = await raise(await actorOf(maker), BIZ_A, 900_000n);
    await expect(
      approve(pi?.id ?? "", pi?.content_hash ?? Buffer.alloc(32), goneActor),
    ).rejects.toThrow(/removed member|cannot approve/i);
  });

  it("refuses a MAKER whose role does not carry raise_payment", async () => {
    const reader = await member("viewer", "reader");
    await expect(raise(await actorOf(reader), BIZ_A, 900_000n)).rejects.toThrow(
      /does not carry raise_payment/i,
    );
  });

  it("leaves Corgi staff alone — they are members of nothing", async () => {
    const maker = await member("initiator", "staffcase");
    const pi = await raise(await actorOf(maker), BIZ_A, 900_000n);
    await expect(
      approve(pi?.id ?? "", pi?.content_hash ?? Buffer.alloc(32), STAFF),
    ).resolves.toBeDefined();
  });
});

d("11. the invariants", () => {
  it("are empty", async () => {
    for (const invariant of await store.readTeamInvariants(sql as never)) {
      expect(invariant.rows, `${invariant.view}: ${invariant.claim}`).toBe(0);
    }
  });

  it("CAN fail — v_approved_auth_for_dead_member, made to, and rolled back", async () => {
    // A guard nobody has seen fail is a claim. This writes the violating row
    // the rule exists to prevent, watches the count go 0 -> 1, and rolls the
    // transaction back. 0023's lesson, applied on the way in.
    const id = await member("initiator", "guard");
    const token = await cardFor(id);
    await store.setMemberTerms(
      {
        memberId: id,
        draft: {
          state: "removed",
          role: "initiator",
          perTxnLimitCents: null,
          dailyLimitCents: null,
          monthlyLimitCents: null,
          note: "removed",
        },
        actorId: STAFF,
      },
      sql as never,
    );

    let delta: { before: number; inside: number } | null = null;
    try {
      await sql.begin(async (tx) => {
        const [before] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM v_approved_auth_for_dead_member`;
        const [card] = await tx<{ id: string }[]>`
          SELECT id FROM card WHERE provider_card_token = ${token}`;
        const [version] = await tx<{ member_version_id: string }[]>`
          SELECT member_version_id FROM v_team_member_current WHERE member_id = ${id}`;
        await tx`
          INSERT INTO card_auth_decision (
            provider, provider_auth_token, provider_card_token, card_id,
            member_id, member_version_id, amount_cents, request_status,
            outcome, result_code, rule, reason, decision_latency_us, source)
          VALUES ('lithic', ${`guard-${RUN_ID}`}, ${token}, ${card?.id ?? ""}::uuid,
                  ${id}::uuid, ${version?.member_version_id ?? ""}::uuid, 5000,
                  'AUTHORIZATION', 'approve', 'APPROVED', 'within_controls',
                  'a purchase approved for somebody who is not on the team', 100, 'harness')`;
        const [inside] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM v_approved_auth_for_dead_member`;
        delta = { before: before?.n ?? -1, inside: inside?.n ?? -1 };
        throw new Error("rollback");
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== "rollback") throw thrown;
    }

    expect(delta).not.toBeNull();
    expect(delta!.before).toBe(0);
    expect(delta!.inside).toBe(1);

    // And it is back to zero outside the transaction.
    const [after] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM v_approved_auth_for_dead_member`;
    expect(after?.n).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The provider                                                               */
/* -------------------------------------------------------------------------- */

dLive("12. a real Lithic card, issued to a real member", () => {
  it("creates it through the existing issuing path and binds it to the person", async () => {
    const id = await member("initiator", "livecard", { perTxn: 25_000n, month: 200_000n });
    const issued = await lifecycle.issueCardToMember(
      {
        businessId: BIZ_A,
        memberId: id,
        actorId: STAFF,
        formKey: crypto.randomUUID(),
      },
      sql as never,
    );
    expect(issued.ok, issued.ok ? "" : `${issued.code}: ${issued.message}`).toBe(true);
    if (!issued.ok) return;

    // eslint-disable-next-line no-console -- the token is the evidence
    console.log("LIVE CARD", JSON.stringify(issued.value));
    expect(issued.value.providerCardToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.value.providerState).toBe("OPEN");

    // And the person's limits are enforced on it, through the real decision.
    const verdict = decide(
      request(30_000n, issued.value.providerCardToken),
      await lookupFor(issued.value.providerCardToken),
    );
    expect(verdict.rule).toBe("member_per_transaction_limit_exceeded");
  });
});
