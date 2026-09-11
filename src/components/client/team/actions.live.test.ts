/**
 * The customer's team actions, PROVEN BY CALLING THEM.
 *
 * ===========================================================================
 * WHY IMPORT AND CALL, RATHER THAN curl
 * ===========================================================================
 *
 * `curl` cannot drive a Next 16 server action: the POST carries an
 * `$ACTION_ID_…` the bundler mints at build time and a body in React's own
 * serialisation. A shell that guesses at either proves nothing about the
 * function that actually runs. So these tests import the action modules and
 * call the exported functions with a real `FormData`, exactly as the framework
 * does — the same code path, including the Zod parse, the ownership predicate,
 * the confirmation re-check and the library call underneath.
 *
 * `src/components/home/actions.test.ts` establishes the pattern.
 *
 * ===========================================================================
 * HOW TO RUN
 * ===========================================================================
 *
 *   RUN_DB_TESTS=1                      everything except issuance
 *   RUN_DB_TESTS=1 RUN_LITHIC_TESTS=1   plus a REAL card on the Lithic account
 *
 *     set -a; . ./.env; set +a; RUN_DB_TESTS=1 \
 *       pnpm vitest run src/components/client/team
 *
 * ===========================================================================
 * WHAT IT WRITES
 * ===========================================================================
 *
 * A fixture business only — `Holds Integration Fixture Co.`, EIN 00-0000000 —
 * and every person it creates carries the run id in their email, so a re-run
 * never collides with a previous one and no demo business is touched. It never
 * deletes anything, because nothing on this path can: `team_member_version` is
 * append-only and the application role holds no DELETE on it.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as ActionsModule from "@/app/(app)/client/team/actions";
import type * as DbModule from "@/lib/ledger/db";
import type * as StoreModule from "@/lib/team/store";

import { CLIENT_TEAM_IDLE } from "./action-result";

/**
 * `revalidatePath` is a cache hint that throws outside a request scope, and it
 * is the one thing about a server action that genuinely cannot be exercised
 * from a test process. It is stubbed HERE rather than guarded in the action: a
 * `try/catch` around it in production code would be a swallow, and this
 * surface's rule is that nothing fails silently. Everything else — the parse,
 * the acting-admin resolution, the ownership predicate, the confirmation
 * re-check, the library call, the refusal codes and the receipt — runs exactly
 * as it does behind the form. `src/components/client/payouts/actions.live.test.ts`
 * does the same, for the same reason.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/**
 * EVERY MODULE THAT OPENS A CONNECTION IS IMPORTED DYNAMICALLY, inside the gate.
 * Importing one evaluates `src/lib/env.ts`, which refuses to load without a full
 * set of keys — so a static import would make this FILE fail to collect on a
 * machine with no `.env`, which is a red test run for a suite that was supposed
 * to skip. `src/components/client/payouts/actions.live.test.ts` does the same.
 * `./action-result` is safe to import statically: it is the plain module, and
 * that is half of why it exists.
 */
let actions: typeof ActionsModule;
let db: typeof DbModule;
let store: typeof StoreModule;

const RUN = process.env["RUN_DB_TESTS"] === "1";
const LIVE = process.env["RUN_LITHIC_TESTS"] === "1";
const d = RUN ? describe : describe.skip;
const dLive = RUN && LIVE ? describe : describe.skip;

const RUN_ID = Date.now().toString(36);

/**
 * A fixture business. `Holds Integration Fixture Co.`, EIN 00-0000000.
 *
 * IT HAS BOTH A 2100 AND A 9100 LEAF, and that is why it and not another
 * fixture: `registerCard()` binds a provider token to that PAIR, and a business
 * with only a 2100 is refused — measured, on `Pots Integration Fixture Co.`,
 * which has no 9100: Lithic created the card and `registerCard()` then refused
 * to bind it, so the receipt said the card exists and any authorisation on it
 * would park instead of posting. That refusal is the correct one and it is
 * loud; this is just not the business to issue against.
 */
const BIZ = "7e57b115-0000-5000-a000-000000000001";
/** Another business entirely, for the isolation probe. */
const OTHER_BIZ = "7e57b115-0000-5000-a000-0000000000f2";
/** A Corgi staff actor — the ONLY thing that bootstraps a first admin. */
const STAFF = "76f9266f-23c9-52de-b8ff-0ec0b23ef386";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

let adminName = "";
let memberId = "";
let otherMemberId = "";

beforeAll(async () => {
  if (!RUN) return;
  [actions, db, store] = await Promise.all([
    import("@/app/(app)/client/team/actions"),
    import("@/lib/ledger/db"),
    import("@/lib/team/store"),
  ]);

  // The bootstrap, and it is the real one: a business cannot appoint its own
  // first administrator, so Corgi does it. This is `team_add_member()`'s staff
  // branch, used here exactly where it is meant to be used — and NOT used by
  // any of the customer actions under test, which is the point of the whole
  // acting-admin arrangement.
  const rows = await db.sql<{ display_name: string }[]>`
    SELECT display_name FROM v_team_member
     WHERE business_id = ${BIZ}::uuid AND state = 'active' AND role = 'admin'
     ORDER BY joined_at, membership_seq LIMIT 1`;
  if (rows[0] === undefined) {
    const created = await store.addMember({
      businessId: BIZ,
      displayName: `Fixture Administrator ${RUN_ID}`,
      email: `fixture.admin.${RUN_ID}@fixture.example`,
      role: "admin",
      actorId: STAFF,
      note: "first administrator, created by Corgi at account opening — the bootstrap a business cannot do for itself",
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    adminName = `Fixture Administrator ${RUN_ID}`;
  } else {
    adminName = rows[0].display_name;
  }

  // Somebody on ANOTHER business, so the isolation probe has a real id to post.
  const other = await store.addMember({
    businessId: OTHER_BIZ,
    displayName: `Other Co Person ${RUN_ID}`,
    email: `other.person.${RUN_ID}@fixture.example`,
    role: "viewer",
    actorId: STAFF,
    note: "belongs to a different business; used to prove one customer cannot reach another's team",
  });
  expect(other.ok, JSON.stringify(other)).toBe(true);
  if (other.ok) otherMemberId = other.value;
}, 60_000);

d("a customer adds somebody to their own team", () => {
  it("creates the person, at terms version 1, with the limits typed", async () => {
    const result = await actions.addTeammateAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        displayName: `Warehouse Manager ${RUN_ID}`,
        email: `warehouse.${RUN_ID}@fixture.example`,
        role: "initiator",
        note: "runs the depot, needs a fuel card",
        perTxn: "250.00",
        day: "0",
        month: "",
      }),
    );

    expect(result.status, result.message).toBe("ok");
    expect(result.code).toBe("MEMBER_ADDED");
    memberId = result.facts.find((f) => f.label === "Member")?.value ?? "";
    expect(memberId).toMatch(/^[0-9a-f-]{36}$/);

    // A BLANK MONTH IS NULL AND A TYPED ZERO IS ZERO. Read back from the
    // database, not from the receipt, because the receipt is this code's own
    // opinion and the column is the fact.
    const [row] = await db.sql<
      {
        per_txn_limit_cents: string | null;
        daily_limit_cents: string | null;
        monthly_limit_cents: string | null;
      }[]
    >`
      SELECT per_txn_limit_cents, daily_limit_cents, monthly_limit_cents
        FROM team_member_version
       WHERE member_id = ${memberId}::uuid AND version = 1`;
    expect(row?.per_txn_limit_cents?.toString()).toBe("25000");
    expect(row?.daily_limit_cents?.toString()).toBe("0");
    expect(row?.monthly_limit_cents).toBeNull();
  }, 60_000);

  it("refuses a limit that is not money, and adds nobody", async () => {
    const result = await actions.addTeammateAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        displayName: `Never Added ${RUN_ID}`,
        email: `never.${RUN_ID}@fixture.example`,
        role: "viewer",
        note: "should not exist",
        perTxn: "2.5e3",
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.code).toBe("INVALID_AMOUNT");

    const rows = await db.sql`
      SELECT 1 FROM actor WHERE email = ${`never.${RUN_ID}@fixture.example`}`;
    expect(rows.length).toBe(0);
  }, 30_000);
});

d("a customer manages their OWN team only", () => {
  it("refuses a member id belonging to another business, with the same sentence as one that does not exist", async () => {
    const real = await actions.setTeammateTermsAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId: otherMemberId,
        role: "admin",
        note: "reaching into another customer's team",
        perTxn: "",
        day: "",
        month: "",
      }),
    );
    const imaginary = await actions.setTeammateTermsAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId: "00000000-0000-4000-8000-000000000000",
        role: "admin",
        note: "a member id that names nothing",
        perTxn: "",
        day: "",
        month: "",
      }),
    );

    expect(real.status).toBe("failed");
    expect(real.code).toBe("NOT_YOUR_MEMBER");
    // The same answer for both, so the form is not an oracle for which member
    // ids are real.
    expect(imaginary.code).toBe(real.code);
    expect(imaginary.message).toBe(real.message);

    // And nothing was written to the other customer's member.
    const versions = await db.sql`
      SELECT version FROM team_member_version WHERE member_id = ${otherMemberId}::uuid`;
    expect(versions.length).toBe(1);
  }, 30_000);
});

d("a customer cannot grant themselves rights they do not have", () => {
  it("refuses any change to the acting administrator's own membership", async () => {
    const [me] = await db.sql<{ member_id: string }[]>`
      SELECT member_id FROM v_team_member
       WHERE business_id = ${BIZ}::uuid AND state = 'active' AND role = 'admin'
       ORDER BY joined_at, membership_seq LIMIT 1`;
    const mine = me?.member_id ?? "";

    const terms = await actions.setTeammateTermsAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId: mine,
        role: "admin",
        note: "raising my own limits",
        perTxn: "999999",
        day: "",
        month: "",
      }),
    );
    expect(terms.status).toBe("failed");
    expect(terms.code).toBe("SELF_ADMINISTRATION");

    const gone = await actions.endTeammateAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId: mine,
        state: "removed",
        note: "removing myself",
        confirmName: adminName,
      }),
    );
    expect(gone.status).toBe("failed");
    expect(gone.code).toBe("SELF_ADMINISTRATION");
  }, 30_000);

  it("refuses to promote somebody whose approval envelope is closed", async () => {
    const result = await actions.setTeammateTermsAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId,
        role: "approver",
        note: "promoting an initiator into an approver",
        perTxn: "250.00",
        day: "0",
        month: "",
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.code).toBe("APPROVAL_NOT_IN_ENVELOPE");
  }, 30_000);
});

d("terms are an append, never an edit", () => {
  it("writes version 2 and leaves version 1 saying what it said", async () => {
    const result = await actions.setTeammateTermsAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId,
        role: "initiator",
        note: "raised for the fuel card",
        perTxn: "400.00",
        day: "",
        month: "1000",
      }),
    );
    expect(result.status, result.message).toBe("ok");
    expect(result.code).toBe("TERMS_WRITTEN");

    const rows = await db.sql<
      { version: number; per_txn_limit_cents: string | null; daily_limit_cents: string | null }[]
    >`
      SELECT version, per_txn_limit_cents, daily_limit_cents
        FROM team_member_version WHERE member_id = ${memberId}::uuid ORDER BY version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]?.per_txn_limit_cents?.toString()).toBe("25000");
    expect(rows[1]?.per_txn_limit_cents?.toString()).toBe("40000");
    // Version 1's typed zero is still a zero; version 2's blank is now null.
    expect(rows[0]?.daily_limit_cents?.toString()).toBe("0");
    expect(rows[1]?.daily_limit_cents).toBeNull();
  }, 60_000);
});

d("removal has friction, and the friction is server-side", () => {
  it("refuses a removal whose typed name does not match the one in the database", async () => {
    const result = await actions.endTeammateAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId,
        state: "removed",
        note: "left the company",
        confirmName: "Somebody Else",
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.code).toBe("REMOVAL_NOT_CONFIRMED");

    // Not removed, and no version was appended at all.
    const [row] = await db.sql<{ state: string }[]>`
      SELECT state FROM v_team_member WHERE member_id = ${memberId}::uuid`;
    expect(row?.state).toBe("active");
  }, 30_000);

  it("suspends without a confirmation, because suspension is reversible", async () => {
    const result = await actions.endTeammateAction(
      CLIENT_TEAM_IDLE,
      form({
        businessId: BIZ,
        memberId,
        state: "suspended",
        note: "on leave",
      }),
    );
    expect(result.status, result.message).toBe("ok");
    expect(result.code).toBe("SUSPENDED");

    const [row] = await db.sql<{ state: string }[]>`
      SELECT state FROM v_team_member WHERE member_id = ${memberId}::uuid`;
    expect(row?.state).toBe("suspended");
  }, 60_000);

  it("brings them back", async () => {
    const result = await actions.endTeammateAction(
      CLIENT_TEAM_IDLE,
      form({ businessId: BIZ, memberId, state: "active", note: "back from leave" }),
    );
    expect(result.status, result.message).toBe("ok");
    expect(result.code).toBe("REINSTATED");
  }, 60_000);
});

d("the invariants that cover authorship", () => {
  it("both read zero after everything above", async () => {
    const [row] = await db.sql<{ dead: number; without_right: number; author: number }[]>`
      SELECT (SELECT count(*)::int FROM v_approved_auth_for_dead_member)     AS dead,
             (SELECT count(*)::int FROM v_member_approval_without_right)     AS without_right,
             (SELECT count(*)::int FROM v_team_terms_by_unauthorised_author) AS author`;
    expect(row?.dead).toBe(0);
    expect(row?.without_right).toBe(0);
    // Not asked for, but it is the one this surface could most plausibly break:
    // every terms row written above was authored by an active admin of that
    // business, because the action resolved one rather than taking a staff
    // actor off a cookie.
    expect(row?.author).toBe(0);
  }, 30_000);
});

dLive("issuing a real card from the customer's own screen", () => {
  it("creates one on Lithic and gives it the program's default controls", async () => {
    const result = await actions.issueTeammateCardAction(
      CLIENT_TEAM_IDLE,
      form({ businessId: BIZ, memberId, formKey: crypto.randomUUID() }),
    );
    expect(result.status, result.message).toBe("ok");
    expect(result.code).toBe("CARD_ISSUED");

    // THE CONTROLS ARE THE POINT. A second issuing path that forgot
    // `applyDefaultControls()` would leave the authorisation decision with
    // nothing to consult.
    const [row] = await db.sql<
      {
        card_state: string;
        per_txn_limit_cents: string | null;
        daily_limit_cents: string | null;
        monthly_limit_cents: string | null;
        blocked_mccs: string[] | null;
      }[]
    >`
      SELECT cc.card_state, cc.per_txn_limit_cents, cc.daily_limit_cents,
             cc.monthly_limit_cents, cc.blocked_mccs
        FROM card_member cm
        JOIN v_card_control_current cc ON cc.card_id = cm.card_id
       WHERE cm.member_id = ${memberId}::uuid
       ORDER BY cm.assigned_at DESC LIMIT 1`;
    expect(row?.card_state).toBe("active");
    expect(row?.per_txn_limit_cents?.toString()).toBe("500000");
    expect(row?.daily_limit_cents).toBeNull();
    expect(row?.monthly_limit_cents).toBeNull();
    expect(row?.blocked_mccs ?? []).toEqual([]);
  }, 120_000);
});
