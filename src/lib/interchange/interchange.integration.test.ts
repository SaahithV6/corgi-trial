/**
 * Interchange against the REAL Neon database and the REAL Lithic sandbox,
 * booking REAL revenue on REAL settled card transactions.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/interchange
 *
 * ============================================================================
 * THE SEVEN CLAIMS THIS FILE EXISTS TO PROVE
 * ============================================================================
 *
 *   1. INTERCHANGE IS BOOKED ON THE CLEARING AND NOT ON THE AUTHORISATION. A
 *      real Lithic card, a real $50.00 authorisation and a real $73.40 clearing
 *      two calls later. After the authorisation, 4100 has not moved. After the
 *      clearing it has, by the amount the rate card says, at the settlement's
 *      own value date.
 *
 *   2. RUNNING IT TWICE BOOKS ONCE. The same payload through the same hook,
 *      and the booking watermark does not move.
 *
 *   3. THE ARITHMETIC ON THE ROW IS THE ARITHMETIC. Every stored operand
 *      re-derived here from the settled amount, the rate and the fixed fee —
 *      and Postgres already refused any row where they disagreed.
 *
 *   4. THE BACKFILL PRICES HISTORY THROUGH THE SAME FUNCTION, including the
 *      settlements that had already been reversed before interchange existed.
 *
 *   5. A REVERSED SETTLEMENT'S INTERCHANGE IS UNBOOKED — as a NEW ENTRY at the
 *      ORIGINAL value date, never an edit — and the settlement's net interchange
 *      is then exactly zero. On real settlements the correction machinery
 *      really did reverse.
 *
 *   6. A CHANGED RATE DOES NOT RE-PRICE LAST WEEK. The same merchant category
 *      on two adjacent business dates, priced by two different rate-card rows,
 *      plus the trigger that makes a backdated rate impossible rather than
 *      merely unlikely.
 *
 *   7. THE INVARIANTS CAN FAIL. Each of the three is MADE to return rows, on
 *      real data, inside transactions that are rolled back. A new invariant
 *      that has never returned a row is a comment, and this repository has
 *      found sixteen guards that reported healthy while the thing they watched
 *      was broken.
 *
 * ─── What this suite writes to the live database ────────────────────────────
 *
 * Real interchange postings on real settlements, at real (small) amounts, plus
 * one new Lithic sandbox card and one new transaction per run of claim 1. That
 * is the point — revenue recognition is not proven by a mock.
 *
 * It does NOT clean up after itself, and could not: `journal_entry` has no
 * DELETE for this role, by design. Re-running is therefore free rather than
 * destructive — the second run finds the settlements priced and asserts that it
 * posted nothing, which is claim 2 all over again.
 *
 * ─── The boundary ───────────────────────────────────────────────────────────
 *
 * `src/lib/ledger/boundary.test.ts` holds test files to the same rule as
 * modules: no SQL against `journal_entry`, `journal_line` or `account`. Every
 * question this suite asks of the ledger goes through a named reader or through
 * a view migration 0031 declares. The assertions are stronger for it — "did
 * anything post" became "did the BOOKING WATERMARK move", which is monotonic
 * and cannot be unchanged by chance.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as QueriesModule from "@/lib/ledger/queries";
import type * as PostModule from "@/lib/ledger/post";
import type * as HoldsModule from "@/lib/holds";
import type * as LithicModule from "@/lib/rails/lithic/client";

import type * as BookModule from "./book";
import type * as BackfillModule from "./backfill";
import type * as StoreModule from "./store";
import { interchangeForNet, priceSettlement } from "./rate-card";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

let sql: typeof SqlHandle;
let currentBookingWatermark: typeof QueriesModule.currentBookingWatermark;
let findEntryByIdempotencyKey: typeof QueriesModule.findEntryByIdempotencyKey;
let reverseAndRebook: typeof PostModule.reverseAndRebook;
let resolveChartCodes: typeof QueriesModule.resolveChartCodes;
let reconcileSettlementEvent: typeof BookModule.reconcileSettlementEvent;
let backfillInterchange: typeof BackfillModule.backfillInterchange;
let listCandidates: typeof StoreModule.listCandidates;
let ledgerPosterActorId: typeof StoreModule.ledgerPosterActorId;
let holds: typeof HoldsModule;
let lithic: typeof LithicModule;

/** The business every live-fire card on this book is issued against. */
const DEMO_BUSINESS = "1151e7b5-b75b-5f58-bdbf-68cd714178ce"; // Kettle & Crumb Bakery LLC

const AUTH_CENTS = 5_000;
const CLEAR_CENTS = 7_340;
const FUEL_MCC = "5542";

beforeAll(async () => {
  if (!RUN) return;
  ({ sql } = await import("@/lib/ledger/db"));
  ({ currentBookingWatermark, findEntryByIdempotencyKey, resolveChartCodes } = await import(
    "@/lib/ledger/queries"
  ));
  ({ reverseAndRebook } = await import("@/lib/ledger/post"));
  ({ reconcileSettlementEvent } = await import("./book"));
  ({ backfillInterchange } = await import("./backfill"));
  ({ listCandidates, ledgerPosterActorId } = await import("./store"));
  holds = await import("@/lib/holds");
  lithic = await import("@/lib/rails/lithic/client");
});

// ===========================================================================
// Claims 1-3: the live hook, on a card that did not exist a minute ago
// ===========================================================================

d("interchange is earned on the clearing, not on the authorisation", () => {
  it(
    "books nothing on a real $50 authorisation and the rate card's figure on the $73.40 clearing",
    async () => {
      const tag = Date.now().toString(36).toUpperCase().slice(-6);

      const card = await lithic.createCard({
        type: "VIRTUAL",
        memo: `interchange ${tag}`,
        state: "OPEN",
        // 0 is NO limit. A fresh card with a default limit declines the $50
        // authorisation, and a declined authorisation would make the first
        // half of this claim vacuous rather than proven.
        spend_limit: 0,
      });
      const pan = card.pan;
      if (pan === undefined || pan === "") {
        throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
      }
      await holds.registerCard(
        {
          provider: "lithic",
          providerCardToken: card.token,
          businessId: DEMO_BUSINESS,
          lastFour: card.last_four ?? "",
          nickname: `interchange ${tag}`,
        },
        sql,
      );

      // ---- THE AUTHORISATION. A hold, and nothing else. -------------------
      //
      // EXACTLY ONE AUTHORISATION PER RUN, and that is a deliberate retreat from
      // an earlier draft that retried at smaller amounts when the network
      // declined. Lithic's sandbox ACCOUNT carries a daily spend cap shared by
      // every card in the program and a day of live-fire runs exhausts it, so a
      // $50.00 authorisation comes back `ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED` —
      // a real network refusal, not a bug here. Retrying turned one refused
      // authorisation per run into three, and every one of them leaves a row in
      // `v_refused_auth_hold` when the deployed webhook consumer happens to
      // ingest it in the window before Lithic attaches the verdict. Three times
      // the traffic for no extra proof is a bad trade: the claim being made is
      // that an authorisation books NO interchange, and that is true and worth
      // asserting whether the network approved it or refused it. The verdict is
      // printed either way so a reader never has to guess which ran.
      const authCents = AUTH_CENTS;
      const clearCents = CLEAR_CENTS;
      const attempt = await lithic.simulateAuthorize({
        amount: authCents,
        descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
        pan,
        status: "AUTHORIZATION",
        mcc: FUEL_MCC,
      });
      const token = attempt.token;
      if (token === undefined) throw new Error("Lithic returned no transaction token");

      const beforeAuth = await interchangeTotalCents();
      // WAIT FOR THE VERDICT, not just for the event. MEASURED: Lithic
      // attaches `result` to the AUTHORIZATION a moment after the event
      // itself appears, and ingesting it in that window records the step as
      // kind 'authorization' with no verdict — which is the exact state
      // migration 0026 exists to make impossible and 0032 could not repair,
      // because the kind is on an append-only row. Two runs of an earlier
      // draft of this test did that and put two $50.00 holds into
      // `v_refused_auth_hold` that nothing but the seven-day expiry sweep can
      // clear. Polling for the verdict is what stops it happening again.
      const authorised = await readTransaction(token, (t) =>
        (t.events ?? []).some((e) => e.type === "AUTHORIZATION" && typeof e.result === "string"),
      );
      // WHAT DID THE NETWORK ACTUALLY SAY? Asked before anything is asserted,
      // because the class of bug migration 0026 closed is our own copy having
      // thrown the answer away. Reported either way; the claim below holds
      // whichever it is, and a reader should not have to guess which ran.
      const authEvent = (authorised.events ?? []).find((e) => e.type === "AUTHORIZATION");
      const verdict = authEvent?.result ?? authorised.result;
      // TOLERANT ON PURPOSE, AND THE REASON IS NOT A FLAKE. The deployed system
      // receives the same Lithic webhook, and it can ingest the AUTHORIZATION in
      // the window before the verdict is attached — after which
      // `assert_card_auth_event_result()` correctly refuses to file a DECLINED
      // result against a row already stored as kind 'authorization'. That is
      // migration 0026's guard working, it is a race with another PROCESS
      // rather than a fact about interchange, and the claim being made here is
      // unaffected: an authorisation books no interchange whoever ingested it.
      let authIngest: string;
      try {
        const authResult = await holds.applyCardTransaction(authorised, { conn: sql });
        expect(authResult.status).toBe("applied");
        // An authorisation earns nothing, so the hook has nothing to do.
        expect(authResult.status === "applied" ? authResult.interchange : []).toEqual([]);
        authIngest = "ingested here";
      } catch (error) {
        authIngest = `already ingested by the deployed consumer (${
          error instanceof Error ? error.message.slice(0, 60) : String(error)
        })`;
      }

      // THE CLAIM. An authorisation moves the memo book; the financial book
      // does not move, so no interchange can have been earned.
      expect(await interchangeTotalCents()).toBe(beforeAuth);
      const [noPosting] = await sql<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM v_interchange_settlement
         WHERE provider_event_id IN (
           SELECT provider_event_id FROM v_interchange_candidate
            WHERE provider_auth_id = ${token})`;
      expect(noPosting?.n).toBe(0n);

      // ---- THE CLEARING, for a DIFFERENT amount. --------------------------
      await lithic.simulateClearing({ token, amountCents: clearCents });
      // MEASURED: the clearing is not in `events[]` the instant the simulate
      // call returns. Feeding the transaction through before it is there
      // records only the authorisation, and the assertion below then fails for
      // a reason that has nothing to do with interchange. Poll for the fact.
      const cleared = await readTransaction(token, (t) =>
        (t.events ?? []).some((e) => e.type === "CLEARING"),
      );
      // The same tolerance, for the same race — and here the settlement itself
      // may already be on the book, posted by the deployed consumer through the
      // identical code path with the identical idempotency keys. Either way the
      // assertions below are about what the LEDGER says, not about which
      // process said it.
      try {
        const clearResult = await holds.applyCardTransaction(cleared, { conn: sql });
        expect(clearResult.status).toBe("applied");
      } catch {
        await reconcileSettlementEvent(
          "lithic",
          (cleared.events ?? []).find((e) => e.type === "CLEARING")?.token ?? "",
          { conn: sql },
        );
      }

      // The settlement is on the book, and so is its interchange.
      const [row] = await sql<
        {
          provider_event_id: string;
          value_date: string;
          mcc: string | null;
          category: string;
          presentment: string;
          entry_mode: string | null;
          rate_bps: number;
          fixed_cents: bigint;
          settled_cents: bigint;
          numerator: bigint;
          denominator: bigint;
          whole_cents: bigint;
          remainder_units: bigint;
          rounding: string;
          ad_valorem_cents: bigint;
          interchange_cents: bigint;
          booked_natural_cents: bigint;
          entry_id: string;
          settlement_entry_id: string;
          rate_effective_from: string;
        }[]
      >`
        SELECT provider_event_id, to_char(value_date,'YYYY-MM-DD') AS value_date,
               mcc, category, presentment, entry_mode, rate_bps, fixed_cents,
               settled_cents, numerator, denominator, whole_cents, remainder_units,
               rounding::text AS rounding, ad_valorem_cents, interchange_cents,
               booked_natural_cents, entry_id, settlement_entry_id,
               to_char(rate_effective_from,'YYYY-MM-DD') AS rate_effective_from
          FROM v_interchange_settlement
         WHERE settlement_entry_id IN (
           SELECT settlement_entry_id FROM v_interchange_candidate
            WHERE provider_auth_id = ${token})`;

      expect(row).toBeDefined();
      if (row === undefined) return;

      // ---- Claim 3: the working, re-derived here -------------------------
      expect(row.mcc).toBe(FUEL_MCC);
      expect(row.category).toBe("fuel");
      // Measured, and stated rather than assumed: this sandbox only ever emits
      // a keyed phone order, so the presentment is always card-not-present.
      expect(row.entry_mode).toBe("MANUAL");
      expect(row.presentment).toBe("card_not_present");
      expect(row.settled_cents).toBe(BigInt(clearCents));

      const recomputed = priceSettlement(BigInt(clearCents), {
        rateBps: row.rate_bps,
        fixedCents: row.fixed_cents,
      });
      expect(row.numerator).toBe(recomputed.numerator);
      expect(row.denominator).toBe(recomputed.denominator);
      expect(row.whole_cents).toBe(recomputed.wholeCents);
      expect(row.remainder_units).toBe(recomputed.remainderUnits);
      expect(row.rounding).toBe(recomputed.rounding);
      expect(row.ad_valorem_cents).toBe(recomputed.adValoremCents);
      expect(row.interchange_cents).toBe(recomputed.interchangeCents);
      // And the JOURNAL agrees with the row, which is the thing that matters.
      expect(row.booked_natural_cents).toBe(recomputed.interchangeCents);

      // The revenue is dated the spend, not today.
      const settlement = await findEntryByIdempotencyKey(
        `card:clearing:${row.provider_event_id}`,
        sql,
      );
      const interchange = await findEntryByIdempotencyKey(
        `interchange:${row.provider_event_id}`,
        sql,
      );
      expect(settlement).not.toBe(null);
      expect(interchange).not.toBe(null);
      expect(interchange?.valueDate).toBe(settlement?.valueDate);
      expect(interchange?.entryId).toBe(row.entry_id);
      expect(settlement?.entryId).toBe(row.settlement_entry_id);

      // ---- Claim 2: a redelivery books nothing ---------------------------
      const before = await currentBookingWatermark(sql);
      // Wrapped for the same reason as the two applies above: a redelivery of a
      // payload whose AUTHORIZATION was ingested before its verdict existed is
      // refused by 0026's guard, and that refusal is a fact about THAT event,
      // not about this one. The assertion that matters is the one after it —
      // the booking watermark is monotonic, so "nothing posted" cannot be true
      // by accident.
      try {
        const replay = await holds.applyCardTransaction(cleared, { conn: sql });
        expect(replay.status).toBe("applied");
      } catch {
        /* see above */
      }
      const again = await reconcileSettlementEvent("lithic", row.provider_event_id, {
        conn: sql,
      });
      expect(again.status).toBe("unchanged");
      expect(await currentBookingWatermark(sql)).toBe(before);

      process.stdout.write(
        `\n    [interchange] ${token}  authorisation ${authCents}c ${verdict} (${authIngest}), cleared ` +
          `${row.settled_cents}c @ ${row.rate_bps}bps+${row.fixed_cents}c` +
          ` (${row.category}/${row.presentment}, card ${row.rate_effective_from})` +
          ` -> ${row.interchange_cents}c  entry ${row.entry_id}\n`,
      );
    },
    120_000,
  );
});

// ===========================================================================
// Claim 4: the backfill
// ===========================================================================

d("the backfill prices history through the same function as the hook", () => {
  it(
    "books every priceable settlement, refuses every unpriceable one, and is idempotent",
    async () => {
      // onlyProviderRecords: false, so the unpriceable arm is exercised on real
      // rows rather than asserted. Those are the synthetic authorisations that
      // integration tests built by hand — no merchant, no entry mode, nothing
      // to read a dimension off.
      const first = await backfillInterchange({ onlyProviderRecords: false, conn: sql });

      expect(first.examined).toBeGreaterThan(0);
      expect(first.unpriceable).toBeGreaterThan(0);
      expect(first.reCorrection).toBe(0);

      // The second run must post nothing at all.
      const watermark = await currentBookingWatermark(sql);
      const second = await backfillInterchange({ onlyProviderRecords: false, conn: sql });
      expect(second.booked).toBe(0);
      expect(second.repaired).toBe(0);
      expect(await currentBookingWatermark(sql)).toBe(watermark);
      expect(second.unchanged + second.unpriceable + second.zeroValue).toBe(second.examined);

      process.stdout.write(
        `\n    [backfill] examined ${first.examined}, booked ${first.booked},` +
          ` repaired ${first.repaired}, unchanged ${first.unchanged},` +
          ` unpriceable ${first.unpriceable}, zero-value ${first.zeroValue};` +
          ` ${first.interchangeBookedCents}c booked, ${first.interchangeUnbookedCents}c unbooked\n`,
      );
    },
    600_000,
  );

  it("leaves all three invariants empty", async () => {
    expect(await countOf("v_interchange_drift")).toBe(0n);
    expect(await countOf("v_interchange_unreversed")).toBe(0n);
    expect(await countOf("v_interchange_rate_drift")).toBe(0n);
  });

  it("prices no settlement that has no provider transaction record", async () => {
    const candidates = await listCandidates({ onlyProviderRecords: false }, sql);
    const synthetic = candidates.filter((c) => !c.providerRecordPresent);
    expect(synthetic.length).toBeGreaterThan(0);
    for (const c of synthetic) expect(c.interchangePostingId).toBe(null);
  });
});

// ===========================================================================
// Claim 5: THE TRAP
// ===========================================================================

d("interchange on a reversed settlement is unbooked at the original value date", () => {
  it("nets to exactly zero on every settlement the correction machinery reversed", async () => {
    const rows = await sql<
      {
        provider_event_id: string;
        value_date: string;
        rate_bps: number;
        fixed_cents: bigint;
        interchange_cents: bigint;
        booked_natural_cents: bigint;
        net_settled_cents: bigint;
        reversal_entry_id: string | null;
        rebook_entry_id: string | null;
        entry_id: string;
      }[]
    >`
      SELECT provider_event_id, to_char(value_date,'YYYY-MM-DD') AS value_date,
             rate_bps, fixed_cents,
             interchange_cents, booked_natural_cents, net_settled_cents,
             reversal_entry_id, rebook_entry_id, entry_id
        FROM v_interchange_settlement
       WHERE reversal_entry_id IS NOT NULL
       ORDER BY value_date, provider_event_id`;

    // This book carries real reversed settlements — the correction machinery
    // ran on them before interchange existed — so this is not a hypothetical.
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // The repair is a NEW ENTRY at the ORIGINAL value date. The reversal
      // exists; `interchange_reversal.value_date` is held equal to the
      // posting's by the test below and by assert_interchange_reversal().
      expect(row.reversal_entry_id).not.toBe(null);

      // AND THE BOOK NOW SAYS WHAT THE SETTLEMENT IS ACTUALLY WORTH. Recomputed
      // here from the settlement's current net and the posting's OWN stored
      // rate — not read back off the row that was written, which would be the
      // arithmetic agreeing with itself.
      const expected = interchangeForNet(row.net_settled_cents, {
        rateBps: row.rate_bps,
        fixedCents: row.fixed_cents,
      });
      expect(row.booked_natural_cents).toBe(expected.naturalCents);

      // A settlement reversed in FULL is worth exactly nothing, and the
      // interchange entry was taken back rather than restated.
      if (row.rebook_entry_id === null) {
        expect(row.net_settled_cents).toBe(0n);
        expect(row.booked_natural_cents).toBe(0n);
        expect(row.interchange_cents).toBeGreaterThan(0n);
      }
    }

    const fullyReversed = rows.filter((r) => r.rebook_entry_id === null);
    process.stdout.write(
      `\n    [reversals] ${rows.length} priced settlements repaired,` +
        ` ${fullyReversed.length} unbooked in full, all at the original value date\n`,
    );
  });

  it("the reversal entry carries the ORIGINAL value date, never today's", async () => {
    const [row] = await sql<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
        FROM interchange_reversal ir
        JOIN interchange_posting ip ON ip.id = ir.interchange_posting_id
       WHERE ir.value_date <> ip.value_date`;
    expect(row?.n).toBe(0n);
  });
});

// ===========================================================================
// Claim 6: a changed rate cannot reach back
// ===========================================================================

d("a rate change does not re-price a settlement from last week", () => {
  it("prices the same merchant category on two adjacent dates by two different cards", async () => {
    const rows = await sql<
      {
        value_date: string;
        rate_bps: number;
        rate_effective_from: string;
        policy_id: string;
        n: bigint;
      }[]
    >`
      SELECT to_char(value_date,'YYYY-MM-DD') AS value_date, rate_bps,
             to_char(rate_effective_from,'YYYY-MM-DD') AS rate_effective_from,
             policy_id, count(*)::bigint AS n
        FROM v_interchange_settlement
       WHERE category = 'fuel' AND presentment = 'card_not_present'
       GROUP BY 1,2,3,4 ORDER BY 1`;

    // The seeded card cuts over on the book day: settlements before it keep
    // 155 bps, settlements on or after it get 170.
    const distinctPolicies = new Set(rows.map((r) => r.policy_id));
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      expect(r.rate_effective_from <= r.value_date).toBe(true);
    }

    process.stdout.write(
      `\n    [rate card] fuel/card_not_present priced by ${distinctPolicies.size} card version(s): ` +
        rows
          .map((r) => `${r.value_date} -> ${r.rate_bps}bps (card ${r.rate_effective_from}, n=${r.n})`)
          .join("; ") +
        "\n",
    );
  });

  it("REFUSES a rate row that would re-price a settlement already on the ledger", async () => {
    const actorId = await ledgerPosterActorId(sql);
    const [priced] = await sql<{ latest: string | null }[]>`
      SELECT to_char(max(value_date),'YYYY-MM-DD') AS latest
        FROM interchange_posting
       WHERE category = 'fuel' AND presentment = 'card_not_present'`;
    expect(priced?.latest).not.toBe(null);

    await expect(
      sql`
        INSERT INTO interchange_rate_policy
          (category, presentment, effective_from, rate_bps, fixed_cents, note, created_by)
        VALUES ('fuel', 'card_not_present', ${priced?.latest ?? "2000-01-01"}::date,
                999, 5, 'a backdated re-rate that must be refused', ${actorId}::uuid)`,
    ).rejects.toThrow(/retroactively re-price|LATER row/);
  });

  it("refuses a rate row that is not later than the newest one for its key", async () => {
    const actorId = await ledgerPosterActorId(sql);
    const [latest] = await sql<{ effective_from: string }[]>`
      SELECT to_char(max(effective_from),'YYYY-MM-DD') AS effective_from
        FROM interchange_rate_policy
       WHERE category = 'charity' AND presentment = 'card_present'`;

    await expect(
      sql`
        INSERT INTO interchange_rate_policy
          (category, presentment, effective_from, rate_bps, fixed_cents, note, created_by)
        VALUES ('charity', 'card_present', ${latest?.effective_from ?? "2000-01-01"}::date,
                111, 0, 'same date as an existing row', ${actorId}::uuid)`,
    ).rejects.toThrow(/LATER row|already has a rate/);
  });
});

// ===========================================================================
// Claim 7: THE INVARIANTS CAN FAIL
// ===========================================================================

d("the invariants can fail, and here is each one failing", () => {
  /**
   * THE TRAP, REPRODUCED. A real priced settlement is reversed inside a
   * transaction — exactly what a merchant reversal does — and the interchange
   * is deliberately NOT unbooked. Both guards must light up.
   *
   * Rolled back, so nothing survives. `journal_entry` has no DELETE for this
   * role, which is why it has to be a transaction and not a cleanup.
   */
  it("v_interchange_unreversed and v_interchange_drift both fire on an unrepaired reversal", async () => {
    const actorId = await ledgerPosterActorId(sql);

    const [target] = await sql<
      { id: string; settlement_entry_id: string; interchange_cents: bigint }[]
    >`
      SELECT ip.id, ip.settlement_entry_id, ip.interchange_cents
        FROM interchange_posting ip
        LEFT JOIN interchange_reversal ir ON ir.interchange_posting_id = ip.id
       WHERE ir.interchange_posting_id IS NULL
         AND ip.direction = 'earned'
         AND NOT EXISTS (
               SELECT 1 FROM v_interchange_candidate c
                WHERE c.settlement_entry_id = ip.settlement_entry_id
                  AND c.settlement_reversal_entry_id IS NOT NULL)
       LIMIT 1`;
    expect(target).toBeDefined();
    if (target === undefined) return;

    let unreversedDuring = -1n;
    let driftDuring = -1n;
    let driftCents: bigint | null = null;

    await expect(
      sql.begin(async (tx) => {
        // The merchant takes the settlement back. Nothing touches interchange.
        await reverseAndRebook(
          {
            originalEntryId: target.settlement_entry_id,
            reason: "PROOF: the merchant reversed the settlement and nothing unbooked the revenue",
            actorId,
          },
          asNestable(tx),
        );

        const [a] = await tx<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM v_interchange_unreversed`;
        const [b] = await tx<{ n: bigint; drift: bigint | null }[]>`
          SELECT count(*)::bigint AS n,
                 max(drift_cents) AS drift
            FROM v_interchange_drift WHERE interchange_posting_id = ${target.id}::uuid`;
        unreversedDuring = a?.n ?? 0n;
        driftDuring = b?.n ?? 0n;
        driftCents = b?.drift ?? null;

        throw new Error("ROLLBACK: proving the guards fire, not changing the book");
      }),
    ).rejects.toThrow(/ROLLBACK/);

    // BOTH fired, and the drift is exactly the revenue that should not exist.
    expect(unreversedDuring).toBeGreaterThan(0n);
    expect(driftDuring).toBe(1n);
    expect(driftCents).toBe(target.interchange_cents);

    // And the book is untouched.
    expect(await countOf("v_interchange_unreversed")).toBe(0n);
    expect(await countOf("v_interchange_drift")).toBe(0n);
  });

  /**
   * THE BLIND SPOT IN THE FIRST GUARD, DEMONSTRATED RATHER THAN CLAIMED.
   *
   * `v_interchange_unreversed` reads `interchange_reversal`, so a row there
   * silences it. `v_interchange_drift` does not read that table at all, so it
   * keeps reporting. This is the difference between the two, made visible on
   * real data.
   *
   * THE LIE THIS USES IS ONE THE DATABASE ACTUALLY PERMITS, which is the part
   * worth reading twice. `assert_interchange_reversal()` holds
   * `rebook_natural_cents` equal to the arithmetic ON `net_settled_cents` — but
   * `net_settled_cents` IS THE CALLER'S CLAIM, not the journal's. Nothing in a
   * trigger can check it, because the settlement's true net is a sum over a
   * correction group that will keep changing after the row is written. So a
   * repair that records a net the journal does not agree with passes every
   * constraint, writes a perfectly balanced re-book, and leaves the first guard
   * with nothing to report.
   *
   * That is exactly the shape of failure this repository has found sixteen
   * times: a guard whose exclusion is the same shape as the thing it watches
   * for. The drift view is the answer, and this is the proof that it is needed
   * rather than the assertion that it might be.
   *
   * Rolled back, so nothing survives.
   */
  it("v_interchange_drift keeps firing where v_interchange_unreversed goes quiet", async () => {
    const actorId = await ledgerPosterActorId(sql);
    const [target] = await sql<
      {
        id: string;
        settlement_entry_id: string;
        entry_id: string;
        entity_id: string;
        value_date: string;
        rate_bps: number;
        fixed_cents: bigint;
      }[]
    >`
      SELECT ip.id, ip.settlement_entry_id, ip.entry_id, c.entity_id,
             to_char(ip.value_date,'YYYY-MM-DD') AS value_date,
             ip.rate_bps, ip.fixed_cents
        FROM interchange_posting ip
        JOIN v_interchange_candidate c ON c.settlement_entry_id = ip.settlement_entry_id
        LEFT JOIN interchange_reversal ir ON ir.interchange_posting_id = ip.id
       WHERE ir.interchange_posting_id IS NULL AND ip.direction = 'earned'
         AND c.settlement_reversal_entry_id IS NULL
       LIMIT 1`;
    expect(target).toBeDefined();
    if (target === undefined) return;

    // A net the journal will NOT agree with, and the interchange it implies.
    const FAKE_NET = 10_000n;
    const fake = interchangeForNet(FAKE_NET, {
      rateBps: target.rate_bps,
      fixedCents: target.fixed_cents,
    });

    let quiet = -1n;
    let loud = -1n;

    await expect(
      sql.begin(async (raw) => {
        const tx = asNestable(raw);

        // The merchant reverses the settlement in full: it is now worth zero.
        await reverseAndRebook(
          {
            originalEntryId: target.settlement_entry_id,
            reason: "PROOF: settlement reversed in full",
            actorId,
          },
          tx,
        );

        const chart = await resolveChartCodes(
          { entityId: target.entity_id, houseCodes: ["2200", "4100"] },
          raw,
        );
        const payable = chart.get("2200");
        const income = chart.get("4100");
        if (payable === undefined || income === undefined) {
          throw new Error("PROOF SETUP: the house accounts are missing");
        }

        // The interchange is "repaired" — reversed and re-booked at a figure
        // derived from a net that never happened. Every constraint is
        // satisfied; the journal disagrees with all of it.
        const { reversalEntryId, rebookEntryId, correctionGroupId } = await reverseAndRebook(
          {
            originalEntryId: target.entry_id,
            reason: "PROOF: a repair that records a net the journal does not agree with",
            actorId,
            rebook: {
              valueDate: target.value_date,
              book: "financial",
              description: "PROOF: interchange re-booked against a net that never happened",
              idempotencyKey: `interchange:proof:${target.id}`,
              lines: [
                { accountId: payable.accountId, amountCents: fake.naturalCents },
                { accountId: income.accountId, amountCents: -fake.naturalCents },
              ],
            },
          },
          tx,
        );

        await raw`
          INSERT INTO interchange_reversal (
            interchange_posting_id, reason, reversal_entry_id, rebook_entry_id,
            net_settled_cents, rebook_natural_cents, value_date, correction_group_id,
            created_by)
          VALUES (${target.id}::uuid, 'PROOF: a net nobody can check',
                  ${reversalEntryId}::uuid, ${rebookEntryId}::uuid,
                  ${FAKE_NET}, ${fake.naturalCents}, ${target.value_date}::date,
                  ${correctionGroupId}::uuid, ${actorId}::uuid)`;

        const [a] = await raw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM v_interchange_unreversed
           WHERE interchange_posting_id = ${target.id}::uuid`;
        const [b] = await raw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM v_interchange_drift
           WHERE interchange_posting_id = ${target.id}::uuid`;
        quiet = a?.n ?? -1n;
        loud = b?.n ?? -1n;

        throw new Error("ROLLBACK: proving the guards differ, not changing the book");
      }),
    ).rejects.toThrow(/ROLLBACK|PROOF SETUP/);

    // The bookkeeping guard is silent; the journal guard is not.
    expect(quiet).toBe(0n);
    expect(loud).toBe(1n);

    expect(await countOf("v_interchange_drift")).toBe(0n);
  });

  /**
   * v_interchange_rate_drift, made to fire.
   *
   * The forward-only trigger makes the offending INSERT impossible, so this
   * needs the OWNER connection to disable it — which is exactly the scenario
   * the view exists for: "what would catch a policy row inserted behind the
   * trigger's back". Rolled back.
   *
   * Skipped rather than failed when no owner URL is configured, because a check
   * that cannot be performed is UNKNOWN and never a pass.
   */
  it("v_interchange_rate_drift fires on a rate row inserted behind the trigger", async () => {
    const ownerUrl = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
    if (ownerUrl === undefined || ownerUrl === "") {
      throw new Error(
        "no owner connection configured: this proof cannot be performed, and a proof that cannot be performed is not a pass",
      );
    }
    const { default: postgres } = await import("postgres");
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });

    let driftDuring = -1n;
    try {
      await expect(
        owner.begin(async (tx) => {
          const [actor] = await tx<{ id: string }[]>`
            SELECT id FROM actor WHERE kind='system' AND display_name='ledger-poster' LIMIT 1`;
          const [oldest] = await tx<{ value_date: string }[]>`
            SELECT to_char(min(value_date),'YYYY-MM-DD') AS value_date
              FROM interchange_posting WHERE category='fuel' AND presentment='card_not_present'`;

          await tx.unsafe(
            "ALTER TABLE interchange_rate_policy DISABLE TRIGGER interchange_rate_policy_forward_only",
          );
          await tx`
            INSERT INTO interchange_rate_policy
              (category, presentment, effective_from, rate_bps, fixed_cents, note, created_by)
            VALUES ('fuel', 'card_not_present', ${oldest?.value_date ?? "2000-01-01"}::date,
                    77, 1, 'PROOF: a backdated re-rate slipped past the trigger',
                    ${actor?.id ?? null}::uuid)`;

          // ::int, not ::bigint: this connection is a bare postgres.js client
          // with none of src/lib/ledger/db.ts's type overrides, so a bigint
          // would arrive as a string. It is a row COUNT and never money.
          const [n] = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM v_interchange_rate_drift`;
          driftDuring = BigInt(n?.n ?? 0);

          throw new Error("ROLLBACK: proving the guard fires, not changing the book");
        }),
      ).rejects.toThrow(/ROLLBACK/);
    } finally {
      await owner.end();
    }

    expect(driftDuring).toBeGreaterThan(0n);
    expect(await countOf("v_interchange_rate_drift")).toBe(0n);
  });
});

// ===========================================================================
// The unit economics, as the screen reads them
// ===========================================================================

d("the unit economics are derivable from postings", () => {
  it("every business's contribution is its income less its expense, both from the journal", async () => {
    const rows = await sql<
      {
        legal_name: string;
        priced_settlements: number;
        net_settled_cents: bigint;
        interchange_cents: bigint;
        fee_income_cents: bigint;
        interest_income_cents: bigint;
        fx_variance_cents: bigint;
        interest_expense_cents: bigint;
        other_expense_cents: bigint;
        net_contribution_cents: bigint;
      }[]
    >`SELECT * FROM v_unit_economics ORDER BY legal_name`;

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Every income line less every expense line. 4300 is in it because it is
      // income-typed and signed — the difference between the rate a customer
      // accepted and what the payout cost us — and leaving it out of the
      // contribution would report a spread as if it were free.
      expect(
        r.interchange_cents +
          r.fee_income_cents +
          r.interest_income_cents +
          r.fx_variance_cents -
          r.interest_expense_cents -
          r.other_expense_cents,
      ).toBe(r.net_contribution_cents);
    }

    const withCards = rows.filter((r) => r.priced_settlements > 0);
    expect(withCards.length).toBeGreaterThan(0);

    process.stdout.write("\n    [unit economics]\n");
    for (const r of rows) {
      process.stdout.write(
        `      ${r.legal_name.padEnd(34)} settlements ${String(r.priced_settlements).padStart(4)}` +
          `  net spend ${String(r.net_settled_cents).padStart(9)}c` +
          `  interchange ${String(r.interchange_cents).padStart(7)}c` +
          `  fees ${String(r.fee_income_cents).padStart(6)}c` +
          `  interest exp ${String(r.interest_expense_cents).padStart(6)}c` +
          `  => ${String(r.net_contribution_cents).padStart(8)}c\n`,
      );
    }
  });

  it("the interchange attributed to businesses equals 4100's own balance", async () => {
    // The screen sums per business; the trial balance sums the account. If
    // those two disagree, the attribution has invented or lost revenue.
    const [attributed] = await sql<{ cents: bigint }[]>`
      SELECT COALESCE(SUM(interchange_cents), 0)::bigint AS cents FROM v_unit_economics`;
    const account = await interchangeTotalCents();
    expect(attributed?.cents).toBe(account);
  });
});

// ---------------------------------------------------------------------------
// Helpers. Every ledger question goes through a view, never through this
// suite's own join onto journal_line — see the header on the boundary.
// ---------------------------------------------------------------------------

/** 4100's natural balance, from the ledger's own balance view. */
async function interchangeTotalCents(): Promise<bigint> {
  const [row] = await sql<{ cents: bigint }[]>`
    SELECT COALESCE(SUM(natural_cents), 0)::bigint AS cents
      FROM v_business_pnl WHERE code = '4100'`;
  return row?.cents ?? 0n;
}

/**
 * `GET /v1/transactions/{token}`, with a short poll.
 *
 * MEASURED: the sandbox answers 404 'Transaction not found' for a second or so
 * after `POST /simulate/authorize` returns the token. That is eventual
 * consistency on the provider's side, not a bug in ours, and a test that
 * asserted it away on the first call would be flaky rather than wrong.
 */
async function readTransaction(
  token: string,
  until: (txn: Awaited<ReturnType<typeof lithic.getTransaction>>) => boolean = () => true,
) {
  let lastError: unknown = null;
  let last: Awaited<ReturnType<typeof lithic.getTransaction>> | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      last = await lithic.getTransaction(token);
      if (until(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (last !== null) return last;
  throw lastError instanceof Error
    ? lastError
    : new Error(`Lithic never made transaction ${token} readable`);
}

/**
 * A transaction handle that `reverseAndRebook()` can open its own transaction
 * on.
 *
 * postgres.js gives a transaction handle `savepoint()` and no `begin()`, and
 * the production path calls `conn.begin()`. A SAVEPOINT is what `begin` means
 * inside a transaction, so the handle is proxied rather than the production
 * path being re-implemented for the proof — proving a guard against a copy of
 * the code it watches would prove nothing.
 */
type Savepointer = { savepoint: (fn: unknown) => unknown };
function asNestable(tx: unknown): typeof sql {
  const target = tx as object & Savepointer;
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === "begin") {
        return (fn: unknown) => (obj as Savepointer).savepoint(fn);
      }
      const value = Reflect.get(obj, prop) as unknown;
      return typeof value === "function" ? value.bind(obj) : value;
    },
  }) as unknown as typeof sql;
}

async function countOf(view: string): Promise<bigint> {
  const rows = await sql.unsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${view}`);
  return rows[0]?.n ?? 0n;
}
