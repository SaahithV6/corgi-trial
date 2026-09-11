/**
 * The judged/unjudged classification, against the REAL Neon book.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \
 *     --no-file-parallelism src/lib/cards/judged.integration.test.ts
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE PROVES, AND THE ONE FAILURE MODE IT EXISTS FOR
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `judged` is stated in TWO places: `UNJUDGED_RULES` in `./types.ts`, which
 * every screen, the MCP surface and `listDecisions()` read; and the `NOT IN`
 * list inside `v_card_auth_decision_judged` (migration 0053), which every
 * set-based reader and every future scoreboard query reads. Two statements of
 * one fact is how a log starts lying — a rule added to one list and not the
 * other would make the screen and the database disagree about which approvals
 * were evidence, silently, in the direction nobody checks.
 *
 * So this suite reads the SQL list back out of the view's own definition with
 * `pg_get_viewdef` and asserts it is the SAME SET as the TypeScript one. Not a
 * count, not a spot check: the set.
 *
 * THIS SUITE WRITES NOTHING. Every statement is a SELECT, and it runs on the
 * app role, which holds no UPDATE or DELETE on money tables anyway. It reads
 * the live book's whole decision history because that history IS the claim
 * under test — the finding was a statement about 145 real rows, and a fixture
 * would prove it about rows this test made up.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { decide } from "./decide";
import {
  DECISION_RULES,
  UNJUDGED_RULES,
  isJudgedRule,
  type AuthRequest,
  type ControlLookup,
} from "./types";
import type * as StoreModule from "./store";
// TYPE-ONLY, so it is erased and the module is never loaded at import time —
// the whole point of the dynamic import below. A `typeof import(...)` inline
// annotation would say the same thing and is banned by this repo's
// `consistent-type-imports` rule, which is right: the two spellings are not
// interchangeable to a reader skimming for what a file pulls in.
import type * as LedgerDb from "@/lib/ledger/db";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

/**
 * `./store` and `@/lib/ledger/db` are imported DYNAMICALLY, inside `beforeAll`.
 * Not a style choice: `@/lib/ledger/db` parses the environment at module scope
 * and throws when `APP_DATABASE_URL` is absent — deliberately, so a malformed
 * database URL kills the process at boot rather than at the first request that
 * needs money. A static import would make this file fail to COLLECT on a
 * machine with no credentials, which is every CI runner, and `describe.skip`
 * cannot skip a module that threw while being loaded. `cards.integration.test.ts`
 * and `holds.integration.test.ts` do the same thing for the same reason — and
 * `defaults.test.ts` did NOT, which is why it threw on import until today.
 */
let store: typeof StoreModule;
let sql: (typeof LedgerDb)["sql"];

/** The rules the SQL view calls unjudged, read back out of the view itself. */
let sqlUnjudged: readonly string[] = [];

d("the judged classification, against Neon", () => {
  beforeAll(async () => {
    store = await import("./store");
    ({ sql } = await import("@/lib/ledger/db"));

    const [row] = await sql<{ def: string }[]>`
      SELECT pg_get_viewdef('v_card_auth_decision_judged'::regclass, true) AS def
    `;
    if (row === undefined) throw new Error("v_card_auth_decision_judged does not exist");

    // The view renders as `rule <> ALL (ARRAY['a'::text, 'b'::text, ...])`.
    // Pulling the literals out of the DEPLOYED definition rather than out of
    // the .sql file is the point: the file is what was written, this is what is
    // running, and a migration applied to one book and not another would show
    // up here instead of in a debrief.
    const array = /rule <> ALL \(ARRAY\[(.+?)\]\)/s.exec(row.def);
    if (array === null) {
      throw new Error(`could not find the rule list in the view definition: ${row.def}`);
    }
    sqlUnjudged = [...array[1]!.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
  });

  /* ---------------------------------------------------------------------- */
  /* 1. The two statements of the definition are one statement               */
  /* ---------------------------------------------------------------------- */

  it("has the same unjudged rule set in SQL as in TypeScript", () => {
    expect([...sqlUnjudged].sort()).toEqual([...UNJUDGED_RULES].sort());
  });

  it("names only rules that exist in the closed set", () => {
    for (const rule of sqlUnjudged) {
      expect(DECISION_RULES).toContain(rule);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 2. The view agrees with the code, row by row, over the whole book       */
  /* ---------------------------------------------------------------------- */

  it("classifies every decision in the book exactly as isJudgedRule() does", async () => {
    const rows = await sql<{ rule: string; judged: boolean; n: bigint }[]>`
      SELECT rule, judged, count(*)::bigint AS n
        FROM v_card_auth_decision_judged
       GROUP BY rule, judged
    `;
    expect(rows.length).toBeGreaterThan(0);

    const disagreements = rows.filter((r) => r.judged !== isJudgedRule(r.rule));
    expect(
      disagreements.map((r) => `${r.rule}: sql=${r.judged} ts=${isJudgedRule(r.rule)}`),
    ).toEqual([]);
  });

  it("finds a real, non-trivial population on both sides of the line", async () => {
    // A test that passed because the table was empty would prove nothing, and
    // an assertion that the unjudged count is ZERO would be the over-claim this
    // whole change removes. So: both buckets are non-empty, and the unjudged
    // approvals are the majority of provider-lane approvals, which is the
    // finding stated as an assertion rather than as a comment.
    const [row] = await sql<
      { judged: bigint; unjudged: bigint }[]
    >`
      SELECT count(*) FILTER (WHERE judged)::bigint     AS judged,
             count(*) FILTER (WHERE NOT judged)::bigint AS unjudged
        FROM v_card_auth_decision_judged
       WHERE outcome = 'approve'
         AND source  = 'provider'
    `;
    expect(row).toBeDefined();
    expect(Number(row!.judged)).toBeGreaterThan(0);
    expect(Number(row!.unjudged)).toBeGreaterThan(Number(row!.judged));
  });

  it("lists every unjudged approval, and every one of them is an approval", async () => {
    const rows = await sql<{ rule: string; n: bigint }[]>`
      SELECT rule, count(*)::bigint AS n
        FROM v_card_auth_approval_unjudged
       GROUP BY rule
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(isJudgedRule(row.rule)).toBe(false);
    }

    // The listing and the census are two renderings of one population; if they
    // disagree, one of them is what somebody will quote.
    const [census] = await sql<{ n: bigint }[]>`
      SELECT COALESCE(sum(decisions), 0)::bigint AS n
        FROM v_card_auth_judged_census
       WHERE outcome = 'approve' AND NOT judged
    `;
    const listed = rows.reduce((sum, row) => sum + Number(row.n), 0);
    expect(Number(census?.n ?? 0n)).toBe(listed);
  });

  /* ---------------------------------------------------------------------- */
  /* 3. What the decision function itself recorded                           */
  /* ---------------------------------------------------------------------- */

  it("never contradicts what the decision recorded on the row", async () => {
    // `judged_recorded` is `inputs->>'judged'`, written by `decide()` from this
    // build onward and NULL on every earlier row. NULL is not a failure — those
    // rows predate the field, and the derivation is what serves them. What
    // would be a failure is a row where the decision said one thing and the
    // view says the other, because then the log has two answers.
    const rows = await sql<{ rule: string; judged: boolean; judged_recorded: boolean }[]>`
      SELECT rule, judged, judged_recorded
        FROM v_card_auth_decision_judged
       WHERE judged_recorded IS NOT NULL
         AND judged_recorded IS DISTINCT FROM judged
    `;
    expect(rows).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* 4. The reader every screen goes through                                 */
  /* ---------------------------------------------------------------------- */

  it("hands each decision's judged flag to the screens, derived from its rule", async () => {
    const [business] = await sql<{ business_id: string }[]>`
      SELECT business_id
        FROM v_card_auth_approval_unjudged
       WHERE business_id IS NOT NULL
       LIMIT 1
    `;
    if (business === undefined) {
      throw new Error("no unjudged approval resolves to a business — the fixture moved");
    }

    const decisions = await store.listDecisions({
      businessId: business.business_id,
      limit: 100,
    });
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      expect(decision.judged).toBe(isJudgedRule(decision.rule));
    }

    // And the population this whole change is about is actually present on a
    // real customer's screen, rather than only in an aggregate.
    expect(decisions.some((x) => x.outcome === "approve" && !x.judged)).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* 5. The live path, end to end                                            */
  /* ---------------------------------------------------------------------- */

  it("reads a real uncontrolled card and decides it unjudged, with no write", async () => {
    // The hot-path read against the live database, then the real `decide()`.
    // Nothing is appended: this is the same pair of calls the ASA route makes
    // before it writes, stopped one step short.
    const [card] = await sql<{ provider: string; provider_card_token: string }[]>`
      SELECT c.provider, c.provider_card_token
        FROM v_card_control_coverage cov
        JOIN card c ON c.id = cov.card_id
       WHERE cov.cover = 'uncontrolled'
       ORDER BY c.created_at DESC
       LIMIT 1
    `;
    if (card === undefined) {
      throw new Error("no uncontrolled card on this book — the finding has been closed");
    }

    const lookup: ControlLookup = await store.readControlsAndSpend({
      provider: card.provider,
      providerCardToken: card.provider_card_token,
      // The lane matters even on a read: the velocity sum filters on it, so a
      // harness read would be measuring a different card's day.
      source: "provider",
    });
    // MEASURED, this machine against Neon over the pooled URL: 66–84 ms for
    // this statement, median 72, against a 600 ms deadline. If it ever misses
    // that deadline the lookup is `unavailable`, `decide()` fails closed, and
    // that row is `judged: false` too — which is asserted below rather than
    // treated as a flake, because a suite that retried past it would be hiding
    // the one operational condition this feature is argued around.
    if (lookup.status === "unavailable") {
      const failClosed = decide(
        {
          providerAuthToken: "00000000-0000-4000-8000-000000000000",
          card: { token: card.provider_card_token, lastFour: null, memo: null, state: "OPEN" },
          amountCents: 5_000n,
          mcc: "5542",
          merchantDescriptor: "JUDGED SUITE — READ ONLY, NOTHING APPENDED",
          requestStatus: "AUTHORIZATION",
        },
        lookup,
      );
      expect(failClosed.outcome).toBe("decline");
      expect(failClosed.rule).toBe("control_store_unavailable");
      expect(failClosed.judged).toBe(false);
      return;
    }

    const request: AuthRequest = {
      providerAuthToken: "00000000-0000-4000-8000-000000000000",
      card: { token: card.provider_card_token, lastFour: null, memo: null, state: "OPEN" },
      amountCents: 5_000n,
      mcc: "5542",
      merchantDescriptor: "JUDGED SUITE — READ ONLY, NOTHING APPENDED",
      requestStatus: "AUTHORIZATION",
    };

    const verdict = decide(request, lookup);
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("no_controls_configured");
    expect(verdict.judged).toBe(false);
    expect(verdict.inputs["judged"]).toBe(false);
  });
});
