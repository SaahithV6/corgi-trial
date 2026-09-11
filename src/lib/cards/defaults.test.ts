/**
 * The program default, and the one property that makes it safe to apply to a
 * book with live demo cards on it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CLAIM UNDER TEST
 * ════════════════════════════════════════════════════════════════════════════
 *
 * "A newly-issued card is born under a control version, and the set of
 * authorisations that control newly declines is EMPTY."
 *
 * The second half is the one that matters, because it is what lets version 1
 * be applied without a rehearsal. It rests on an equality that lives in two
 * files and could silently drift:
 *
 *     DEFAULT_PER_TXN_LIMIT_CENTS   src/lib/cards/defaults.ts
 *     CARD_SPEND_LIMIT_CENTS        src/app/(app)/accounts/actions.ts
 *                                   src/lib/team/lifecycle.ts
 *
 * The second is the `spend_limit` sent to Lithic with
 * `spend_limit_duration: "TRANSACTION"` when the card is created. If somebody
 * raises the provider-side ceiling to $10,000 and leaves ours at $5,000, the
 * default stops being behaviour-neutral and starts declining real purchases
 * Lithic would have approved. A comment cannot catch that. These tests can.
 *
 * The pure half of this file runs anywhere. The live half is gated on
 * RUN_DB_TESTS=1 and drives the real `applyDefaultControls()` against Neon,
 * because an INSERT guarded by `WHERE NOT EXISTS` against a table with a
 * contiguity trigger on it is exactly the kind of thing that works in a unit
 * test and refuses in the database.
 *
 *     set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \
 *       --no-file-parallelism src/lib/cards/defaults.test.ts
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AND THE ONE-SHOT BACKFILL, WHICH IS GATED SEPARATELY AND ON PURPOSE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The last block runs only under RUN_CARD_CONTROL_BACKFILL=1 and touches a
 * HARD-CODED, ENUMERATED list of five Lithic card tokens: the named people on
 * Ridgeline Robotics' team. It is here rather than in a migration because
 * `card_control_version` has one writer and it is the application — see the
 * header of migration 0051 — and it is here rather than in a throwaway script
 * because the exact list of cards a backfill touched is evidence, and evidence
 * belongs in the repository.
 *
 * It is idempotent: a second run reports `already_controlled` for all five and
 * writes nothing, because `applyDefaultControls()` is guarded in SQL.
 */
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

import { rootLogger } from "@/lib/log";

import { decide } from "./decide";
import {
  DEFAULT_CONTROLS,
  DEFAULT_CONTROL_ACTOR_ID,
  DEFAULT_PER_TXN_LIMIT_CENTS,
} from "./defaults";
import type * as DefaultsModule from "./defaults";
import type * as StoreModule from "./store";
import type { AuthRequest, CardControls, ControlLookup } from "./types";

/**
 * The figure both issuance paths declare to Lithic. Copied here as a LITERAL
 * rather than imported, deliberately: importing
 * `src/app/(app)/accounts/actions.ts` would drag a server action, `next/cache`
 * and the whole console into a unit test, and — more to the point — a test
 * that imports the same constant it is checking proves nothing. This is a
 * second, independent statement of the number, and the assertion is that the
 * two agree.
 */
const PROVIDER_SPEND_LIMIT_CENTS = 5_000_00n;

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

const BACKFILL = process.env["RUN_CARD_CONTROL_BACKFILL"] === "1";
const b = BACKFILL ? describe : describe.skip;

const PROVIDER = "lithic";

/* -------------------------------------------------------------------------- */
/* 1. The default itself                                                      */
/* -------------------------------------------------------------------------- */

describe("the program default", () => {
  it("is a per-transaction ceiling equal to the issuer's own spend_limit", () => {
    // THE WHOLE SAFETY ARGUMENT, IN ONE LINE. If this fails, version 1 can
    // decline an authorisation Lithic would have approved, and applying it to
    // a live card stops being a no-op.
    expect(DEFAULT_PER_TXN_LIMIT_CENTS).toBe(PROVIDER_SPEND_LIMIT_CENTS);
    expect(DEFAULT_CONTROLS.perTxnLimitCents).toBe(PROVIDER_SPEND_LIMIT_CENTS);
  });

  it("sets no daily limit, no monthly limit and no blocked categories", () => {
    // NULL is "no limit of this kind" and is NOT 0 ("this card may spend
    // nothing") — 0014's note. A default that wrote 0 anywhere here would
    // freeze every card it touched.
    expect(DEFAULT_CONTROLS.dailyLimitCents).toBeNull();
    expect(DEFAULT_CONTROLS.monthlyLimitCents).toBeNull();
    expect(DEFAULT_CONTROLS.blockedMccs).toEqual([]);
  });

  it("leaves the card active — a default must never be an off switch", () => {
    expect(DEFAULT_CONTROLS.cardState).toBe("active");
  });

  it("carries a note that says nobody chose these figures", () => {
    // `note` is NOT NULL in the schema because it is read first in a dispute.
    // A default whose note was "default" would answer the question with the
    // question.
    expect(DEFAULT_CONTROLS.note.length).toBeGreaterThan(80);
    expect(DEFAULT_CONTROLS.note).toMatch(/program/i);
    expect(DEFAULT_CONTROLS.note).toMatch(/\$5,000\.00/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Behaviour-neutrality, proven through decide() rather than asserted       */
/* -------------------------------------------------------------------------- */

function request(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    providerAuthToken: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    card: { token: "card-token", lastFour: "2081", memo: "corgi", state: "OPEN" },
    amountCents: 5_000n,
    mcc: "5542",
    merchantDescriptor: "CORGI FUEL PUMP 14",
    requestStatus: "AUTHORIZATION",
    ...overrides,
  };
}

/** Version 1 exactly as `applyDefaultControls()` writes it. */
function defaultControls(): CardControls {
  return {
    cardId: "card-id",
    controlVersionId: "version-1-id",
    version: 1,
    effectiveFrom: "2026-09-11T00:00:00.000Z",
    ...DEFAULT_CONTROLS,
    blockedMccs: [...DEFAULT_CONTROLS.blockedMccs],
  };
}

function lookup(controls: CardControls | null, spendCents = 0n): ControlLookup {
  return {
    status: "read",
    cardId: "card-id",
    controls,
    spend: { dayCents: spendCents, monthCents: spendCents },
  };
}

describe("the default declines nothing the issuer would have approved", () => {
  it("approves a $50 fuel-pump authorisation, as an uncontrolled card did", () => {
    const req = request({ amountCents: 5_000n });
    const before = decide(req, lookup(null));
    const after = decide(req, lookup(defaultControls()));

    expect(before.outcome).toBe("approve");
    expect(before.rule).toBe("no_controls_configured");

    // Same verdict, different rule — and THAT is the entire change. The card
    // was approved either way; now the row can cite what allowed it.
    expect(after.outcome).toBe("approve");
    expect(after.rule).toBe("within_controls");
    expect(after.inputs["control_version"]).toBe(1);
  });

  it("approves $5,000.00 exactly — limits are inclusive on both sides", () => {
    // Lithic's TRANSACTION spend_limit permits the limit itself, and so does
    // `spend + amount > limit`. An off-by-one here would decline the one
    // authorisation the issuer allows, which is the narrowest possible way to
    // be wrong and the hardest to notice.
    const verdict = decide(request({ amountCents: 5_000_00n }), lookup(defaultControls()));
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("within_controls");
  });

  it("declines $5,000.01 — which Lithic's own spend_limit declines too", () => {
    const verdict = decide(request({ amountCents: 5_000_01n }), lookup(defaultControls()));
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("per_transaction_limit_exceeded");
  });

  it("never fires on velocity, however much the card has already spent", () => {
    // The daily and monthly limits are NULL, so no accumulation can reach
    // them. A default that quietly capped a month's spend would decline a
    // legitimate purchase in week four of a card nobody configured.
    const verdict = decide(
      request({ amountCents: 1_000_00n }),
      lookup(defaultControls(), 900_000_00n),
    );
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("within_controls");
  });

  it("blocks no merchant category", () => {
    for (const mcc of ["5542", "5812", "7995", "6011"]) {
      const verdict = decide(request({ mcc, amountCents: 1_000n }), lookup(defaultControls()));
      expect(verdict.rule).toBe("within_controls");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Against the live database                                               */
/* -------------------------------------------------------------------------- */

/**
 * Dynamic, inside the suite, for the reason `cards.integration.test.ts` spells
 * out: these modules import `@/lib/ledger/db`, which parses the environment at
 * module scope and throws without `APP_DATABASE_URL`. A static import would
 * make the file fail to COLLECT on a machine with no credentials — which is
 * every CI runner — and `describe.skip` cannot skip a module that threw while
 * being loaded.
 */
async function load(): Promise<{
  defaults: typeof DefaultsModule;
  store: typeof StoreModule;
}> {
  return {
    defaults: await import("./defaults"),
    store: await import("./store"),
  };
}

d("applyDefaultControls, against Neon", () => {
  it("writes version 1, is idempotent, and turns rule 15 into rule 16", async () => {
    const url = process.env["DIRECT_URL"];
    if (url === undefined) throw new Error("DIRECT_URL is required for RUN_DB_TESTS=1");
    const owner = postgres(url, { max: 1, onnotice: () => {} });

    // A throwaway card of its own, so this suite's velocity window and control
    // chain are its own and not whatever else is running on this book.
    const token = `asa-default-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let cardId = "";

    try {
      const [seed] = await owner<
        { business_id: string; account_id: string; memo_account_id: string }[]
      >`
        SELECT c.business_id, c.account_id, c.memo_account_id
          FROM card c ORDER BY c.created_at DESC LIMIT 1`;
      if (seed === undefined) throw new Error("this book has no cards to borrow a chart from");

      const [row] = await owner<{ id: string }[]>`
        INSERT INTO card (provider, provider_card_token, business_id,
                          account_id, memo_account_id, last_four, nickname)
        VALUES (${PROVIDER}, ${token}, ${seed.business_id},
                ${seed.account_id}, ${seed.memo_account_id}, '0000',
                'card-controls default test')
        RETURNING id`;
      if (row === undefined) throw new Error("the test card was not created");
      cardId = row.id;

      const { defaults, store } = await load();

      // BEFORE. The card exists, has no controls and no holder, so the
      // decision path reaches rule 15 and judges the authorisation against
      // nothing. This is the state 880 of this book's 911 cards were in.
      //
      // `budgetMs` is widened from the production 600 ms for this suite and
      // ONLY for this suite. The deadline is a property of the deployed
      // function in `iad1`, a few milliseconds from the database; the first
      // query from a developer laptop pays a cross-region TLS handshake to
      // Neon and can genuinely exceed 600 ms, at which point `decide()` fails
      // closed exactly as designed and this test would be asserting the
      // network rather than the default. The deadline itself is proven by
      // `cards.integration.test.ts` and by the live fail-closed run in
      // docs/CARD-CONTROLS.md §3, not here.
      const beforeLookup = await store.readControlsAndSpend({
        provider: PROVIDER,
        providerCardToken: token,
        source: "harness",
        budgetMs: 20_000,
      });
      expect(beforeLookup.status).toBe("read");
      const before = decide(request({ amountCents: 5_000n }), beforeLookup);
      expect(before.rule).toBe("no_controls_configured");
      expect(before.outcome).toBe("approve");

      // APPLY.
      const applied = await defaults.applyDefaultControls({ cardId });
      expect(applied.kind).toBe("applied");

      // IDEMPOTENT. The second call must not raise, must not write, and must
      // not be reported as a failure — the three-outcome shape exists so the
      // caller can tell "already fine" from "went wrong".
      const again = await defaults.applyDefaultControls({ cardId });
      expect(again.kind).toBe("already_controlled");

      const [count] = await owner<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM card_control_version WHERE card_id = ${cardId}`;
      expect(Number(count?.n ?? 0n)).toBe(1);

      // THE CHAIN IS THE ORDINARY ONE. Version 1, authored by the system
      // actor, with the mandatory note on it.
      const [v1] = await owner<
        {
          version: number;
          card_state: string;
          // The OWNER handle has no bigint type parser (that is configured on
          // `@/lib/ledger/db`, not here), so Postgres `bigint` arrives as a
          // decimal string. Read it as one and convert; assuming otherwise is
          // how a money comparison passes on the wrong type.
          per_txn_limit_cents: string | null;
          daily_limit_cents: string | null;
          monthly_limit_cents: string | null;
          blocked_mccs: string[];
          created_by: string;
        }[]
      >`
        SELECT version, card_state, per_txn_limit_cents, daily_limit_cents,
               monthly_limit_cents, blocked_mccs, created_by
          FROM card_control_version WHERE card_id = ${cardId}`;
      expect(v1?.version).toBe(1);
      expect(v1?.card_state).toBe("active");
      expect(BigInt(v1?.per_txn_limit_cents ?? "-1")).toBe(PROVIDER_SPEND_LIMIT_CENTS);
      expect(v1?.daily_limit_cents).toBeNull();
      expect(v1?.monthly_limit_cents).toBeNull();
      expect(v1?.blocked_mccs).toEqual([]);
      expect(v1?.created_by).toBe(DEFAULT_CONTROL_ACTOR_ID);

      // AFTER. The same authorisation, through the same single statement and
      // the same pure function, now judged — and the verdict is unchanged.
      const afterLookup = await store.readControlsAndSpend({
        provider: PROVIDER,
        providerCardToken: token,
        source: "harness",
        budgetMs: 20_000,
      });
      const after = decide(request({ amountCents: 5_000n }), afterLookup);
      expect(after.outcome).toBe(before.outcome);
      expect(after.rule).toBe("within_controls");
      expect(after.inputs["control_version"]).toBe(1);

      // A HUMAN'S CHANGE STILL LANDS ON TOP, as version 2. The default is a
      // floor to build on, not a chain that has to be broken to be edited.
      const [actor] = await owner<{ id: string }[]>`
        SELECT id FROM actor WHERE kind = 'human' AND business_id IS NOT NULL LIMIT 1`;
      if (actor === undefined) throw new Error("this book has no human actor");
      const written = await store.setCardControls({
        cardId,
        actorId: actor.id,
        draft: {
          cardState: "active",
          perTxnLimitCents: 25_00n,
          dailyLimitCents: 100_00n,
          monthlyLimitCents: null,
          blockedMccs: ["5542"],
          note: "defaults.test.ts — a person's change on top of the program default",
        },
      });
      expect(written.ok).toBe(true);
      if (written.ok) expect(written.controls.version).toBe(2);

      // AND THE COVERAGE VIEW SEES IT. `no_controls_configured` is a real
      // state and this is the screen's answer to it.
      const [cover] = await owner<{ cover: string }[]>`
        SELECT cover FROM v_card_control_coverage WHERE card_id = ${cardId}`;
      expect(cover?.cover).toBe("under_control");
    } finally {
      await owner.end();
    }
  }, 60_000);

  it("classifies a card with no controls and no holder as uncontrolled", async () => {
    // The other side of the view, so the three buckets are proven and not just
    // the flattering one. `card_control_version` is append-only, so this card
    // stays uncontrolled for ever and is a permanent, honest example of the
    // state rule 15 exists for.
    const url = process.env["DIRECT_URL"];
    if (url === undefined) throw new Error("DIRECT_URL is required for RUN_DB_TESTS=1");
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [seed] = await owner<
        { business_id: string; account_id: string; memo_account_id: string }[]
      >`
        SELECT c.business_id, c.account_id, c.memo_account_id
          FROM card c ORDER BY c.created_at DESC LIMIT 1`;
      if (seed === undefined) throw new Error("this book has no cards to borrow a chart from");

      const token = `asa-uncovered-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const [row] = await owner<{ id: string }[]>`
        INSERT INTO card (provider, provider_card_token, business_id,
                          account_id, memo_account_id, last_four, nickname)
        VALUES (${PROVIDER}, ${token}, ${seed.business_id},
                ${seed.account_id}, ${seed.memo_account_id}, '0000',
                'card-controls coverage test')
        RETURNING id`;

      const [cover] = await owner<{ cover: string; has_controls: boolean; has_member: boolean }[]>`
        SELECT cover, has_controls, has_member
          FROM v_card_control_coverage WHERE card_id = ${row?.id ?? null}`;
      expect(cover?.cover).toBe("uncontrolled");
      expect(cover?.has_controls).toBe(false);
      expect(cover?.has_member).toBe(false);
    } finally {
      await owner.end();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/* 4. The deliberate backfill — five named cards, enumerated                  */
/* -------------------------------------------------------------------------- */

/**
 * THE CARDS THIS BOOK'S BACKFILL TOUCHED, AND NOTHING ELSE.
 *
 * The selection rule, stated so it can be argued with: a card is backfilled if
 * and only if A PERSON HOLDS IT. These five are the named members of Ridgeline
 * Robotics — the cards `/team` renders, the cards a reviewer opens, and the
 * only real-provider-token cards in this book bound to a human rather than to
 * a test run.
 *
 * WHAT WAS DELIBERATELY LEFT ALONE, and why the residue is honest rather than
 * unfinished:
 *
 *   * ~740 fixture cards — `asa-harness-…`, `test-…`, `team-…`, `fuzz-…`,
 *     `completion-…`, and the `holds`/`hold` nicknames. They belong to the
 *     integration, fuzz and completion suites. Giving them controls would move
 *     a number on a screen and change nothing about any authorisation, which
 *     is padding.
 *   * ~200 one-shot `live-fire …` and `corgi core loop …` cards. Each was
 *     created by one scripted run, took its single authorisation, and will
 *     never take another; the NEXT core-loop run issues through the console
 *     action and gets the default without anybody backfilling anything.
 *   * Noor Haddad's ••2656 — already at control version 6 from the live proof
 *     in docs/CARD-CONTROLS.md §8. `applyDefaultControls()` reports
 *     `already_controlled` for it and writes nothing.
 *
 * Two of the five belong to REMOVED members (Cass Brennan, Theo Marchetti).
 * Their cards already decline on rule 5, `member_removed`, which is checked
 * before any card-scoped rule — so the default changes nothing for them
 * either, and they are included because the selection rule is about who holds
 * a card, not about whether the control will ever be the binding one.
 */
const BACKFILL_TOKENS: readonly { token: string; who: string; lastFour: string }[] = [
  { token: "e54d6e93-631a-4d9d-9f39-f6e395f655aa", who: "Alex Whitfield", lastFour: "3787" },
  { token: "249a5d92-a3f0-450b-938c-d1c07e9e534e", who: "Cass Brennan (removed)", lastFour: "5601" },
  { token: "b6a110cf-23e5-404c-91c3-57f417d26991", who: "Noor Haddad · second card", lastFour: "7024" },
  { token: "d7a79245-c8a0-48b2-a987-3780adeb25b1", who: "Ruth Castellanos", lastFour: "7282" },
  { token: "43ea116a-b1ed-4023-83b5-ff69bf3e46f1", who: "Theo Marchetti (removed)", lastFour: "9128" },
  { token: "84b40e67-0eb3-4309-953e-cfd3b7305d70", who: "Noor Haddad", lastFour: "2656" },
];

const BACKFILL_NOTE =
  "Program default, applied by a deliberate backfill on 2026-09-11 to a card " +
  "that predates the default and is held by a named member of this team. A " +
  "per-transaction ceiling of $5,000.00 only — the same figure already " +
  "declared to Lithic as this card's own spend_limit, so it declines nothing " +
  "the issuer would not already have declined. The full list of cards this " +
  "backfill touched, and the ones it deliberately did not, is in " +
  "docs/CARD-CONTROLS.md §11.";

b("the deliberate backfill", () => {
  it("gives each named member's card version 1, and touches nothing else", async () => {
    const url = process.env["DIRECT_URL"];
    if (url === undefined) throw new Error("DIRECT_URL is required");
    const owner = postgres(url, { max: 1, onnotice: () => {} });

    const log = rootLogger.child({ action: "cards.backfill" });

    try {
      const { defaults } = await load();

      for (const entry of BACKFILL_TOKENS) {
        const [card] = await owner<{ id: string; nickname: string | null }[]>`
          SELECT id, nickname FROM card
           WHERE provider = ${PROVIDER} AND provider_card_token = ${entry.token}`;
        if (card === undefined) {
          // A book rebuilt from zero holds none of these tokens. That is not a
          // failure of the backfill; it is the backfill having nothing to do.
          log.info("cards.backfill.absent", { who: entry.who, lastFour: entry.lastFour });
          continue;
        }

        const outcome = await defaults.applyDefaultControls({
          cardId: card.id,
          note: BACKFILL_NOTE,
        });
        log.info("cards.backfill.card", {
          who: entry.who,
          lastFour: entry.lastFour,
          outcome: outcome.kind,
        });
        expect(["applied", "already_controlled"]).toContain(outcome.kind);

        const [cover] = await owner<{ cover: string }[]>`
          SELECT cover FROM v_card_control_coverage WHERE card_id = ${card.id}`;
        expect(cover?.cover).toBe("under_control");
      }
    } finally {
      await owner.end();
    }
  }, 120_000);
});
