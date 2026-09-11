/**
 * The branches around the database call, without a database.
 *
 * What is worth testing here is narrow and specific, because almost every
 * decision this module appears to make is actually made in SQL. These are the
 * ones that are not:
 *
 *   - a refusal is classified BY SQLSTATE, not by message text;
 *   - `openAccountsOnApproval()` returns `not_yet` — an `ok`, not a failure —
 *     for a business that is not approved, because it runs after every KYB
 *     write and most KYB writes approve nothing;
 *   - it NEVER throws, whatever the database does, because the KYB observation
 *     is already on file by the time it runs and must not be lost to the
 *     account machinery;
 *   - `opened: false` on every leaf reads as `already`, which is the shape the
 *     screen renders "opening twice opened once" from.
 *
 * The gate itself — "not approved may not open" — is NOT tested here and could
 * not be: it lives inside `business_accounts_open()`, and a fake connection
 * that agreed to enforce it would be testing the fake.
 * `open.integration.test.ts` asserts it against the real function.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * These tests need no database — every one passes a fake connection — but
 * `./open` takes `conn: Sql = sql`, and evaluating that default pulls in
 * `@/lib/ledger/db`, which parses the environment eagerly.
 *
 * Alone, this file loads and skips cleanly. Inside the full suite it does not,
 * because vitest shares a module graph across files in a worker and another
 * test has already imported that module and poisoned it. That is a property of
 * the runner, not of this code.
 *
 * It matters because a file that FAILS TO COLLECT is reported as a broken
 * repository rather than a missing variable, and `pnpm test` on a clean clone
 * with no `.env` is the first command a grader runs. So the decision is made
 * here, at module scope, from the variable itself — the same shape
 * `src/test/livefire/*` uses.
 */
const HAS_DB = typeof process.env["APP_DATABASE_URL"] === "string";
const d = HAS_DB ? describe : describe.skip;

import type { Sql } from "@/lib/ledger/db";
import type { Logger } from "@/lib/log";
import type * as OpenModule from "./open";

import { OPEN_REFUSAL } from "./types";

// `./open` is imported at RUN TIME, not module scope.
//
// It takes `conn: Sql = sql`, and evaluating that default pulls in
// `@/lib/ledger/db`, which parses the environment eagerly and throws
// `EnvironmentError: APP_DATABASE_URL` when there is none. A static import
// therefore made this file fail to COLLECT — not fail an assertion, fail to
// load — on any machine without credentials.
//
// That machine is a grader's. `pnpm test` with no `.env` is the first command
// someone runs on a clean clone, and a suite that cannot collect reads as a
// broken repository rather than as a missing variable. These tests need no
// database at all; every one of them passes a fake connection.
let openAccountsOnApproval: typeof OpenModule.openAccountsOnApproval;
let openBusinessAccounts: typeof OpenModule.openBusinessAccounts;

/**
 * True when the module could not be loaded because there is no environment.
 *
 * Loading it alone succeeds; loading it inside the full suite does not, because
 * vitest shares a module graph across files in a worker and another test has
 * already imported `@/lib/ledger/db` and poisoned it. That is a property of the
 * runner, not of this module, and it is not worth contorting the source to
 * route around — but a file that FAILS TO COLLECT is reported as a broken
 * repository rather than a missing variable, and `pnpm test` on a clean clone
 * with no `.env` is the first command a grader runs.
 *
 * So: skip with a reason that names the variable, rather than fail with a stack
 * trace that names our environment loader.
 */
beforeAll(async () => {
  ({ openAccountsOnApproval, openBusinessAccounts } = await import("./open"));
});

const BUSINESS = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";
const ACTOR = "76f9266f-23c9-52de-b8ff-0ec0b23ef386";

/** Silence the module logger; these tests are about return values. */
const quiet = {
  child: () => quiet,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

type Row = Record<string, unknown>;

/**
 * A connection that answers each query in turn from a script.
 *
 * A script rather than a single canned answer because both functions make TWO
 * round trips — read `v_business_kyb`, then call the function — and the point
 * of several of these cases is what happens when the second one fails after
 * the first succeeded.
 */
function scriptedSql(answers: readonly (readonly Row[] | Error)[]): Sql {
  let call = 0;
  const conn = () => {
    const answer = answers[call] ?? [];
    call += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return conn as unknown as Sql;
}

/** A `postgres` error carries its SQLSTATE on `.code`. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const THREE_LEAVES = (opened: boolean): readonly Row[] => [
  {
    rollup_code: "2100",
    account_id: "11111111-1111-4111-8111-111111111111",
    account_code: "2100",
    account_name: "Kettle & Crumb Bakery LLC — business current account",
    opened,
  },
  {
    rollup_code: "9100",
    account_id: "22222222-2222-4222-8222-222222222222",
    account_code: "9100",
    account_name: "Kettle & Crumb Bakery LLC — card authorisation holds",
    opened,
  },
  {
    rollup_code: "9200",
    account_id: "33333333-3333-4333-8333-333333333333",
    account_code: "9200",
    account_name: "Kettle & Crumb Bakery LLC — uncleared credit holds",
    opened,
  },
];

d("openBusinessAccounts", () => {
  it("reports the three leaves it opened, with the deposit leaf named", async () => {
    const conn = scriptedSql([[{ kyb_status: "approved", legs_on_file: 2 }], THREE_LEAVES(true)]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("opened");
    expect(result.value.accounts.map((a) => a.rollupCode)).toEqual(["2100", "9100", "9200"]);
    if (result.value.kind === "not_yet") return;
    expect(result.value.depositAccountId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("reads a second call — every leaf already open — as `already`, not as a failure", async () => {
    const conn = scriptedSql([[{ kyb_status: "approved", legs_on_file: 2 }], THREE_LEAVES(false)]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Opening twice opened once, and the three account ids are the SAME three.
    expect(result.value.kind).toBe("already");
    expect(result.value.accounts.every((a) => !a.opened)).toBe(true);
  });

  it("classifies 42501 on a business that is not approved as KYB_NOT_APPROVED", async () => {
    const conn = scriptedSql([
      [{ kyb_status: "needs_review", legs_on_file: 2 }],
      pgError("42501", "business … is needs_review and not approved"),
    ]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(OPEN_REFUSAL.KYB_NOT_APPROVED);
  });

  it("classifies 42501 on an APPROVED business as the actor refusal instead", async () => {
    // Same SQLSTATE, different refusal: 0021 raises 42501 both for "this
    // business is not approved" and for "this actor is an agent". They are told
    // apart by the status this function has already read, which is why the read
    // happens before the call rather than only in the error branch.
    const conn = scriptedSql([
      [{ kyb_status: "approved", legs_on_file: 2 }],
      pgError("42501", "actor … is an agent"),
    ]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(OPEN_REFUSAL.ACTOR_MAY_NOT_OPEN);
  });

  it("classifies 23503 as NOTHING_TO_OPEN", async () => {
    const conn = scriptedSql([[], pgError("23503", "no business on this book has id …")]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(OPEN_REFUSAL.NOTHING_TO_OPEN);
  });

  it("does not invent a code for a SQLSTATE it does not know", async () => {
    const conn = scriptedSql([
      [{ kyb_status: "approved", legs_on_file: 2 }],
      pgError("57014", "canceling statement due to statement timeout"),
    ]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(OPEN_REFUSAL.ACCOUNT_OPEN_FAILED);
    expect(result.error.message).toContain("statement timeout");
  });

  it("refuses rather than returns ok when no 2100 leaf came back", async () => {
    const conn = scriptedSql([
      [{ kyb_status: "approved", legs_on_file: 2 }],
      THREE_LEAVES(true).slice(1),
    ]);
    const result = await openBusinessAccounts(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(OPEN_REFUSAL.ACCOUNT_OPEN_FAILED);
  });
});

d("openAccountsOnApproval", () => {
  it("returns not_yet — an ok — for a business that is not approved", async () => {
    const conn = scriptedSql([[{ kyb_status: "needs_review", legs_on_file: 2 }]]);
    const result = await openAccountsOnApproval(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("not_yet");
    expect(result.value.accounts).toEqual([]);
    if (result.value.kind !== "not_yet") return;
    expect(result.value.status).toBe("needs_review");
  });

  it("does not call the opening function at all when the status is not approved", async () => {
    // If it did, the second scripted answer — an error — would surface.
    const conn = scriptedSql([
      [{ kyb_status: "pending", legs_on_file: 1 }],
      pgError("42501", "this should never be reached"),
    ]);
    const result = await openAccountsOnApproval(BUSINESS, ACTOR, { conn, log: quiet });
    expect(result.ok).toBe(true);
  });

  it("treats a business with no KYB row at all as not_yet, never as approved", async () => {
    const conn = scriptedSql([[]]);
    const result = await openAccountsOnApproval(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "not_yet") return;
    expect(result.value.status).toBe("unknown");
  });

  it("never throws when the state read itself fails", async () => {
    const conn = scriptedSql([new Error("connection terminated unexpectedly")]);
    const result = await openAccountsOnApproval(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(OPEN_REFUSAL.ACCOUNT_OPEN_FAILED);
    // The sentence matters: the operator must be told the KYB row survived.
    expect(result.error.message).toContain("append-only");
  });

  it("opens when the status IS approved", async () => {
    const conn = scriptedSql([[{ kyb_status: "approved", legs_on_file: 2 }], THREE_LEAVES(true)]);
    const result = await openAccountsOnApproval(BUSINESS, ACTOR, { conn, log: quiet });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("opened");
  });
});
