/**
 * The account screen's read queries.
 *
 * Two halves, and they prove different things.
 *
 * The first half runs against a fake connection and asserts the things that
 * must be true of the SQL itself no matter what is in the database: that a
 * non-uuid account id never reaches Postgres, that the memo sum is restricted
 * to the hold's own memo account, that no provider status field is read, and
 * that the hold totals fold the way the data contract's identity requires.
 * These run in CI, which holds no credentials, deliberately.
 *
 * The second half runs against the REAL Neon database and is gated on
 * RUN_DB_TESTS=1:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * It plants a fuel-pump over-capture — the exact figures measured against the
 * Lithic sandbox in DECISIONS 006 — inside a transaction that is rolled back,
 * and asserts the SQL derives A(E), C(E) and H(E) from the event set. Nothing
 * it writes survives the test: the whole point of the exercise is that a read
 * path can be proven without leaving a mark on a ledger.
 */
import { describe, expect, it, beforeAll } from "vitest";

import {
  type HoldRow,
  type LedgerSnapshot,
  type Sql,
  accountAvailability,
  findDepositAccount,
  foldHoldTotals,
  isAccountId,
  ledgerBalanceCents,
  listHoldRows,
  listPostingRows,
  readSnapshot,
} from "./queries";

/* -------------------------------------------------------------------------- */
/* A connection that answers from a script                                    */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

/** Every statement the code under test sent, in order, with its parameters. */
type Call = { readonly text: string; readonly values: readonly unknown[] };

/**
 * A fake `Sql`.
 *
 * Routes by a distinctive fragment of each statement rather than by call
 * order, so a test that adds a query somewhere else does not silently shift
 * another test's answers onto the wrong statement.
 */
function fakeSql(routes: readonly (readonly [string, readonly Row[]])[]): {
  readonly conn: Sql;
  readonly calls: readonly Call[];
} {
  const calls: Call[] = [];

  const conn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ? ");
    calls.push({ text, values });
    const route = routes.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(route === undefined ? [] : route[1]);
  };

  return { conn: conn as unknown as Sql, calls };
}

const SNAPSHOT: LedgerSnapshot = {
  asOf: new Date("2026-09-10T19:42:00.000Z"),
  valueDate: "2026-09-10",
  bookingWatermark: 160n,
};

const ACCOUNT = "a0c41a37-2be1-5c30-bfe9-03455f048fac";

/* -------------------------------------------------------------------------- */

describe("isAccountId", () => {
  it("accepts a uuid and rejects a fixture id", () => {
    expect(isAccountId(ACCOUNT)).toBe(true);
    expect(isAccountId("acct_operating_4417")).toBe(false);
    expect(isAccountId("")).toBe(false);
    expect(isAccountId("../../etc/passwd")).toBe(false);
  });
});

describe("the ::uuid casts are guarded", () => {
  it("answers 'no such account' without sending a statement", async () => {
    const { conn, calls } = fakeSql([]);

    expect(await findDepositAccount("acct_operating_4417", conn)).toBeNull();
    expect(await listHoldRows("acct_operating_4417", SNAPSHOT, conn)).toEqual([]);
    expect(await listPostingRows("acct_operating_4417", SNAPSHOT, 25, conn)).toEqual(
      [],
    );

    // A bad id is an answer, not a 22P02 from Postgres dressed up as an outage.
    expect(calls).toHaveLength(0);
  });
});

describe("readSnapshot", () => {
  it("takes one instant, one business day and one watermark", async () => {
    const { conn } = fakeSql([
      [
        "book_date(clock_timestamp())",
        [
          {
            as_of: new Date("2026-09-10T19:42:00.000Z"),
            value_date: "2026-09-10",
            booking_watermark: 160n,
          },
        ],
      ],
    ]);

    expect(await readSnapshot(conn)).toEqual({
      asOf: new Date("2026-09-10T19:42:00.000Z"),
      valueDate: "2026-09-10",
      bookingWatermark: 160n,
    });
  });

  it("reads the business day from the database's own book_date()", async () => {
    const { conn, calls } = fakeSql([
      [
        "book_date(clock_timestamp())",
        [{ as_of: new Date(), value_date: "2026-09-10", booking_watermark: 0n }],
      ],
    ]);
    await readSnapshot(conn);

    // Not the server's locale, and not a second definition of the Fed calendar
    // day boundary living in TypeScript.
    expect(calls[0]?.text).toContain("book_date(clock_timestamp())");
  });

  it("uses clock_timestamp(), so a posting in the same transaction counts", async () => {
    const { conn, calls } = fakeSql([
      [
        "book_date(clock_timestamp())",
        [{ as_of: new Date(), value_date: "2026-09-10", booking_watermark: 0n }],
      ],
    ]);
    await readSnapshot(conn);

    // now() is the TRANSACTION's start and ledger_append() stamps booking_time
    // from clock_timestamp(). A watermark of "MAX(booking_seq) WHERE
    // booking_time <= now()", read inside the transaction that just posted an
    // entry, excludes that entry — and every funds check that posts and reads
    // in one transaction (standing orders, pot transfers) reads this shape.
    expect(calls[0]?.text).not.toContain("now()");
    // And the LIVE watermark has no time predicate at all: MVCC already
    // decides what this transaction can see.
    expect(calls[0]?.text).not.toContain("booking_time");
  });
});

describe("ledgerBalanceCents", () => {
  it("is the canonical settled balance, on both axes of the bitemporal model", async () => {
    const { conn, calls } = fakeSql([
      ["ledger_settled_cents", [{ cents: 3_329_289n }]],
    ]);

    expect(await ledgerBalanceCents(ACCOUNT, SNAPSHOT, conn)).toBe(3_329_289n);

    // Both axes travel as arguments. The predicates themselves live once, in
    // ledger_settled_cents() (migration 0022), which is also what
    // v_available_balance calls — so the view and this function cannot drift.
    expect(calls[0]?.values).toContain("2026-09-10");
    expect(calls[0]?.values).toContain(160n);
  });

  it("reads zero for an account with no lines rather than no answer", async () => {
    const { conn } = fakeSql([["ledger_settled_cents", []]]);
    expect(await ledgerBalanceCents(ACCOUNT, SNAPSHOT, conn)).toBe(0n);
  });

  it("holds no definition of its own — it is a call, not a copy", async () => {
    const { conn, calls } = fakeSql([["ledger_settled_cents", [{ cents: 0n }]]]);
    await ledgerBalanceCents(ACCOUNT, SNAPSHOT, conn);

    // The moment this file contains "SUM(l.amount_cents)" again, there are two
    // definitions of the balance and one of them will be edited alone. That is
    // how this system got to four.
    expect(calls[0]?.text).toContain("ledger_settled_cents");
    expect(calls[0]?.text).not.toContain("SUM(l.amount_cents)");
  });
});

describe("accountAvailability", () => {
  it("is the ONE definition: one call, four terms and their sum", async () => {
    const { conn, calls } = fakeSql([
      [
        "ledger_availability",
        [
          {
            ledger_cents: 4_961_613n,
            hold_cents: 41_100n,
            uncleared_cents: 1_375_300n,
            pending_outbound_cents: 3_721_200n,
            available_cents: -175_987n,
          },
        ],
      ],
    ]);

    const availability = await accountAvailability(ACCOUNT, SNAPSHOT, conn);

    expect(availability).toEqual({
      ledgerCents: 4_961_613n,
      holdsCents: 41_100n,
      unclearedCents: 1_375_300n,
      pendingOutboundCents: 3_721_200n,
      availableCents: -175_987n,
    });

    // The identity closes, and it closes in Postgres rather than here: this
    // module does no arithmetic on money at all.
    expect(
      availability.ledgerCents -
        availability.holdsCents -
        availability.unclearedCents -
        availability.pendingOutboundCents,
    ).toBe(availability.availableCents);

    // One statement, three arguments: the value axis, the booking axis and the
    // instant. A balance question has all three and none of them is optional.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toContain("2026-09-10");
    expect(calls[0]?.values).toContain(160n);
  });

  it("does not clamp a negative available balance", async () => {
    const { conn } = fakeSql([
      [
        "ledger_availability",
        [
          {
            ledger_cents: -840n,
            hold_cents: 1_200n,
            uncleared_cents: 0n,
            pending_outbound_cents: 0n,
            available_cents: -2_040n,
          },
        ],
      ],
    ]);

    // An over-capture settles above what was authorised. The honest answer is
    // that the customer is overdrawn; a cosmetic floor would hide it.
    expect((await accountAvailability(ACCOUNT, SNAPSHOT, conn)).availableCents).toBe(
      -2_040n,
    );
  });

  it("reads zero on every term for an account with nothing on it", async () => {
    const { conn } = fakeSql([["ledger_availability", []]]);
    expect(await accountAvailability(ACCOUNT, SNAPSHOT, conn)).toEqual({
      ledgerCents: 0n,
      holdsCents: 0n,
      unclearedCents: 0n,
      pendingOutboundCents: 0n,
      availableCents: 0n,
    });
  });
});

describe("listHoldRows — the two bugs that produced silent zeros", () => {
  const holdsSql = async (): Promise<string> => {
    const { conn, calls } = fakeSql([["WITH held", []]]);
    await listHoldRows(ACCOUNT, SNAPSHOT, conn);
    return calls[0]?.text ?? "";
  };

  it("reaches tenancy through hold.account_id — the hold table has no business_id", async () => {
    const text = await holdsSql();
    expect(text).toContain("h.account_id =");
    expect(text).not.toContain("h.business_id");
  });

  it("restricts the memo sum to the hold's OWN memo account", async () => {
    // Both legs of a balanced memo entry are in the entry's lines and they
    // cancel; summing them gives zero for every hold, always.
    expect(await holdsSql()).toContain("l.account_id = held.memo_account_id");
  });

  it("folds A(E) and C(E) over card_auth_event and never a status field", async () => {
    const text = await holdsSql();
    expect(text).toContain("card_auth_event");
    expect(text).toContain("'authorization','incremental_authorization'");
    expect(text).toContain("'authorization_reversal'");
    expect(text).toContain("'clearing','force_post'");
    // DECISIONS 006: Lithic reports SETTLED while a partial hold is live. The
    // schema stores no status column and this query asks for no opinion.
    expect(text.toLowerCase()).not.toContain("status");
  });

  it("closes a hold on a closure row, the network, or the clock", async () => {
    const text = await holdsSql();
    expect(text).toContain("hold_closure");
    expect(text).toContain("saw_final");
    expect(text).toContain("expires_at");
    expect(text).toContain("available_at");
  });

  it("is H(E) = 0 if closed else max(A − C, 0), written out", async () => {
    expect(await holdsSql()).toContain(
      "GREATEST(t.authorised_cents - t.cleared_cents, 0)",
    );
  });
});

describe("listPostingRows", () => {
  const postingsSql = async (): Promise<string> => {
    const { conn, calls } = fakeSql([["WITH entries", []]]);
    await listPostingRows(ACCOUNT, SNAPSHOT, 25, conn);
    return calls[0]?.text ?? "";
  };

  it("unions the financial book with the memo book", async () => {
    const text = await postingsSql();
    expect(text).toContain("UNION ALL");
    // Taking only the deposit account's own lines would drop every
    // authorisation — the posting that explains why available moved and the
    // ledger balance did not.
    expect(text).toContain("l.account_id = h.memo_account_id");
  });

  it("folds over exactly the entries the balance folds over", async () => {
    const text = await postingsSql();
    // Same two predicates as ledgerBalanceCents, on both branches of the
    // union. A future-dated payment in this list but not in the headline
    // balance would make the running-balance column wrong on every row below
    // it — the contract asks for one fold, not two that nearly agree.
    expect(text.match(/e\.value_date {2}<=/g)).toHaveLength(2);
    expect(text.match(/e\.booking_seq <=/g)).toHaveLength(2);
  });

  it("returns both clocks, and the comparison between them", async () => {
    const text = await postingsSql();
    expect(text).toContain("AS value_date");
    expect(text).toContain("AS booking_date");
    expect(text).toContain("book_date(en.booking_time) - en.value_date");
  });

  it("gives a memo posting no ledger delta at all, rather than zero", async () => {
    const text = await postingsSql();
    expect(text).toContain(
      "CASE WHEN en.book = 'financial' THEN en.delta_cents END AS ledger_delta_cents",
    );
  });

  it("maps a backdated correction and a same-day posting apart", async () => {
    const { conn } = fakeSql([
      [
        "WITH entries",
        [
          {
            entry_id: "e1",
            book: "financial",
            description: "Planted settlement PLANT-1, re-booked",
            occurred_at: new Date("2026-09-10T16:05:30.498Z"),
            value_date: "2011-04-26",
            booking_date: "2026-09-10",
            backdated_by_days: 5616,
            entry_type: "rebook",
            booking_seq: 160n,
            ledger_delta_cents: 13_456n,
            available_delta_cents: 13_456n,
            hold_id: null,
            rail: "ach",
            external_ref: "PLANT-1",
          },
          {
            entry_id: "e2",
            book: "memo",
            description: "Card authorisation · SHELL OIL 1247",
            occurred_at: new Date("2026-09-10T15:00:00.000Z"),
            value_date: "2026-09-10",
            booking_date: "2026-09-10",
            backdated_by_days: 0,
            entry_type: "original",
            booking_seq: 159n,
            ledger_delta_cents: null,
            available_delta_cents: -5_000n,
            hold_id: "h1",
            rail: "card",
            external_ref: "evt_1",
          },
        ],
      ],
    ]);

    const rows = await listPostingRows(ACCOUNT, SNAPSHOT, 25, conn);

    expect(rows[0]?.backdated).toBe(true);
    expect(rows[0]?.backdatedByDays).toBe(5_616);
    expect(rows[0]?.valueDate).toBe("2011-04-26");
    expect(rows[0]?.bookingDate).toBe("2026-09-10");

    expect(rows[1]?.backdated).toBe(false);
    expect(rows[1]?.ledgerDeltaCents).toBeNull();
    expect(rows[1]?.availableDeltaCents).toBe(-5_000n);
  });
});

/* -------------------------------------------------------------------------- */
/* foldHoldTotals — the identity the data contract demands                    */
/* -------------------------------------------------------------------------- */

function hold(kind: HoldRow["kind"], remainingCents: bigint): HoldRow {
  return {
    holdId: `hold_${kind}_${remainingCents.toString()}`,
    kind,
    descriptor: kind,
    externalRef: "ref",
    authorisedCents: remainingCents,
    clearedCents: 0n,
    remainingCents,
    memoBalanceCents: remainingCents,
    closed: remainingCents === 0n,
    closedReason: remainingCents === 0n ? "network_final" : null,
    placedAt: new Date("2026-09-10T12:00:00.000Z"),
    expiresAt: null,
    availableAt: null,
    policy: null,
    pending: false,
    authCount: kind === "card_auth" ? 1 : 0,
    eventCount: kind === "card_auth" ? 1 : 0,
  };
}

/** The same hold, value-dated into the future: it withholds nothing yet. */
function pendingHold(kind: HoldRow["kind"], remainingCents: bigint): HoldRow {
  return { ...hold(kind, remainingCents), pending: true };
}

describe("foldHoldTotals", () => {
  it("buckets manual holds with card authorisations, not with uncleared credits", () => {
    // The contract's activeHoldsCents is "card-auth and manual holds"; a
    // manual dispute reserve withholds money exactly as an authorisation does.
    const totals = foldHoldTotals([
      hold("card_auth", 124_000n),
      hold("manual", 50_000n),
      hold("uncleared_credit", 1_250_000n),
    ]);

    expect(totals.activeHoldsCents).toBe(174_000n);
    expect(totals.unclearedCreditsCents).toBe(1_250_000n);
  });

  it("closes the decomposition: available = ledger − holds − uncleared", () => {
    const rows = [
      hold("card_auth", 5_000n),
      hold("card_auth", 26_000n),
      hold("manual", 50_000n),
      hold("uncleared_credit", 1_250_000n),
    ];
    const { activeHoldsCents, unclearedCreditsCents } = foldHoldTotals(rows);
    const ledgerCents = 4_821_560n;

    const summed = rows.reduce((total, row) => total + row.remainingCents, 0n);
    expect(activeHoldsCents + unclearedCreditsCents).toBe(summed);
    expect(ledgerCents - activeHoldsCents - unclearedCreditsCents).toBe(
      3_490_560n,
    );
  });

  it("counts a closed hold as nothing withheld", () => {
    // An over-captured authorisation: H(E) is 0 and the excess was never held.
    expect(foldHoldTotals([hold("card_auth", 0n)]).activeHoldsCents).toBe(0n);
  });

  it("is zero on an account with no holds", () => {
    expect(foldHoldTotals([])).toEqual({
      activeHoldsCents: 0n,
      unclearedCreditsCents: 0n,
    });
  });

  it("skips a hold whose value date has not arrived — the $3,750.00 bug", () => {
    // THE BUG THIS GUARDS.
    //
    // An inbound ACH funding value-dated TOMORROW posts a financial entry
    // dated tomorrow and an uncleared-credit hold dated tomorrow. The ledger
    // term excludes the credit (value_date <= today), so subtracting the hold
    // as well charges the customer twice for the same dollar.
    //
    // Three such holds, $1,250.00 each, were live on the demo account and the
    // funding screen was deducting all three. Measured 2026-09-11T02:10Z.
    const totals = foldHoldTotals([
      hold("uncleared_credit", 250_000n),
      pendingHold("uncleared_credit", 125_000n),
      pendingHold("uncleared_credit", 125_000n),
      pendingHold("uncleared_credit", 125_000n),
    ]);

    expect(totals.unclearedCreditsCents).toBe(250_000n);
    expect(totals.activeHoldsCents).toBe(0n);
  });

  it("skips a pending card hold too — the rule is about the clock, not the kind", () => {
    expect(
      foldHoldTotals([
        hold("card_auth", 5_000n),
        pendingHold("card_auth", 99_999n),
        pendingHold("manual", 99_999n),
      ]).activeHoldsCents,
    ).toBe(5_000n);
  });
});

/* -------------------------------------------------------------------------- */
/* Against the real database                                                  */
/* -------------------------------------------------------------------------- */

const RUN = process.env.RUN_DB_TESTS === "1";
const d = RUN ? describe : describe.skip;

d("the account screen's queries, against the live database", () => {
  let sql: Sql;
  let snapshot: LedgerSnapshot;
  let accountId: string;
  let memoAccountId: string;

  beforeAll(async () => {
    ({ sql } = await import("./db"));

    const [account] = await sql<{ id: string; business_id: string }[]>`
      SELECT id, business_id FROM account
       WHERE code = '2100' AND business_id IS NOT NULL AND book = 'financial'
       ORDER BY name LIMIT 1`;
    if (account === undefined) throw new Error("seed first: node scripts/seed.mjs");
    accountId = account.id;

    const [memo] = await sql<{ id: string }[]>`
      SELECT id FROM account
       WHERE code = '9100' AND business_id = ${account.business_id}::uuid`;
    if (memo === undefined) throw new Error("no 9100 leaf for this business");
    memoAccountId = memo.id;

    snapshot = await readSnapshot(sql);
  });

  it("takes a snapshot with a watermark the journal actually reached", async () => {
    const [row] = await sql<{ seq: bigint }[]>`
      SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq FROM journal_entry`;
    expect(snapshot.bookingWatermark).toBe(row?.seq ?? 0n);
    expect(snapshot.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("agrees with a direct SUM over the account's lines", async () => {
    const balance = await ledgerBalanceCents(accountId, snapshot, sql);

    const [direct] = await sql<{ cents: bigint }[]>`
      SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS cents
        FROM account a
        LEFT JOIN journal_line l
               ON l.account_id = a.id
              AND l.value_date <= ${snapshot.valueDate}::date
              AND l.booking_seq <= ${snapshot.bookingWatermark}
       WHERE a.id = ${accountId}::uuid
       GROUP BY a.normal_side`;

    expect(balance).toBe(direct?.cents ?? 0n);
  });

  it("returns postings on both clocks, newest first, with backdating measured", async () => {
    const rows = await listPostingRows(accountId, snapshot, 200, sql);
    const day = 24 * 60 * 60 * 1000;

    for (const row of rows) {
      expect(row.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.bookingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.backdated).toBe(row.valueDate < row.bookingDate);

      // The gap Postgres measured, recomputed independently from the two
      // dates it returned. Proves the date arithmetic and the book-timezone
      // conversion, rather than restating the flag that was derived from them.
      const gap = Math.round(
        (Date.parse(`${row.bookingDate}T00:00:00Z`) -
          Date.parse(`${row.valueDate}T00:00:00Z`)) /
          day,
      );
      expect(row.backdatedByDays).toBe(Math.max(gap, 0));

      if (row.book === "memo") expect(row.ledgerDeltaCents).toBeNull();
      else expect(row.ledgerDeltaCents).not.toBeNull();

      // §5: the value date can never be past the day the fold was taken for,
      // or the headline balance would not be a fold over these rows.
      expect(row.valueDate <= snapshot.valueDate).toBe(true);
    }

    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const current = rows[i];
      if (previous === undefined || current === undefined) continue;
      expect(previous.bookingSeq > current.bookingSeq).toBe(true);
    }
  });

  it("derives the DECISIONS 006 fuel-pump over-capture from the event set", async () => {
    // Planted inside a transaction that is rolled back at the end: the read
    // path is proven against real Postgres without leaving a row behind.
    const marker = `queries-test-${Date.now()}`;
    // Thrown to roll the transaction back. postgres.js rolls back on a throw
    // from the callback, which is the only correct way to undo it — issuing a
    // bare ROLLBACK inside would leave the driver's own bookkeeping wrong.
    const rollback = new Error("planned rollback");
    let rows: readonly HoldRow[] = [];

    try {
      await sql.begin(async (tx) => {
        const conn = tx as unknown as Sql;

        const [held] = await conn<{ id: string }[]>`
          INSERT INTO hold (account_id, memo_account_id, kind, external_ref,
                            value_date, expires_at)
          VALUES (${accountId}::uuid, ${memoAccountId}::uuid, 'card_auth',
                  ${marker}, ${snapshot.valueDate}::date,
                  ${snapshot.asOf}::timestamptz + interval '7 days')
          RETURNING id`;
        if (held === undefined) throw new Error("hold insert returned nothing");

        const [auth] = await conn<{ id: string }[]>`
          INSERT INTO card_authorization (provider, provider_auth_id, card_id,
                                          account_id, hold_id, origin, expires_at)
          VALUES ('lithic', ${marker}, gen_random_uuid(), ${accountId}::uuid,
                  ${held.id}::uuid, 'authorization',
                  ${snapshot.asOf}::timestamptz + interval '7 days')
          RETURNING id`;
        if (auth === undefined) throw new Error("auth insert returned nothing");

        // authorize 5000 -> hold 5000; clearing 7340 (over-capture) -> hold 0.
        await conn`
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final,
                                       value_date, provider_event_id, received_at)
          VALUES (${auth.id}::uuid, 'authorization', 5000, false,
                  ${snapshot.valueDate}::date, ${`${marker}-auth`},
                  ${snapshot.asOf}::timestamptz - interval '1 hour'),
                 (${auth.id}::uuid, 'clearing', 7340, true,
                  ${snapshot.valueDate}::date, ${`${marker}-clear`},
                  ${snapshot.asOf}::timestamptz - interval '1 minute')`;

        rows = await listHoldRows(accountId, snapshot, conn);

        // Undo everything. The assertions run on the captured rows, outside.
        throw rollback;
      });
    } catch (thrown) {
      if (thrown !== rollback) throw thrown;
    }

    const fuel = rows.find((row) => row.externalRef === marker);
    expect(fuel).toBeDefined();
    // A(E) = 5000, C(E) = 7340, H(E) = 0. The excess of 2340 was never held,
    // so it was never protected — and the hold is not "wrong", it is closed.
    expect(fuel?.authorisedCents).toBe(5_000n);
    expect(fuel?.clearedCents).toBe(7_340n);
    expect(fuel?.remainingCents).toBe(0n);
    expect(fuel?.closed).toBe(true);
    expect(fuel?.closedReason).toBe("network_final");
    expect(fuel?.eventCount).toBe(2);
  });

  it("left no trace: the planted hold is gone", async () => {
    const [row] = await sql<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM hold WHERE external_ref LIKE 'queries-test-%'`;
    expect(row?.n).toBe(0n);
  });
});
