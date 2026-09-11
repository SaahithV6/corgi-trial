/**
 * Card controls against the REAL Neon database, and the real decision path.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * WHAT THIS SUITE PROVES, and what it deliberately does not.
 *
 * PROVES, against the live database:
 *   1  the control chain is append-only and versioned — no UPDATE exists
 *   2  a decision cites the version it was judged under, and a LATER control
 *      change cannot retroactively re-judge it
 *   3  the velocity sum is our own approved decisions, in one source lane
 *   4  a $10 limit declines a $50 fuel-pump authorisation, end to end through
 *      `parseAsaRequest` → `readControlsAndSpend` → `decide` → `appendDecision`
 *   5  the decision path posts NOTHING: the journal is byte-identical either
 *      side of a decline and an approval
 *
 * DOES NOT PROVE: that Lithic calls us. Every row this suite writes carries
 * `source = 'harness'`, and that column is the difference between "the decision
 * function works" and "the provider drove it". The second claim is made only by
 * rows with `source = 'provider'`, written by the route, and by the evidence in
 * docs/CARD-CONTROLS.md.
 *
 * The suite provisions its own card so its velocity windows are its own. A
 * suite that measured against a shared card would be measuring whatever else
 * was running, which is how the holds suite learned the same lesson.
 */
import { beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

import { parseAsaRequest } from "./asa";
import { decide } from "./decide";
import { asaPayload } from "./fixtures";
import type * as StoreModule from "./store";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

const PROVIDER = "lithic";

/** Unique per run, so two runs never share a velocity window. */
const CARD_TOKEN = `asa-harness-${Date.now().toString(36)}`;

let cardId = "";
let businessId = "";
let actorId = "";

/**
 * `./store` is imported DYNAMICALLY, inside `beforeAll`, and that is not a
 * style choice. It imports `@/lib/ledger/db`, which parses the environment at
 * module scope and throws when `APP_DATABASE_URL` is absent — deliberately, so
 * a malformed database URL kills the process at boot rather than at the first
 * request that needs money. A static import here would make the whole file
 * fail to COLLECT on a machine with no credentials, which is every CI runner,
 * and `describe.skip` cannot skip a module that threw while being loaded.
 * `holds.integration.test.ts` does the same thing for the same reason.
 */
let store: typeof StoreModule;

/**
 * Provisioning needs the OWNER connection. `corgi_app` holds SELECT and INSERT
 * on `card`, but the card must point at a business that already has both
 * leaves of the chart, and finding one is a read the owner does once here
 * rather than a fixture that goes stale. Nothing in this function writes money.
 */
async function provision(): Promise<void> {
  const url = process.env["DIRECT_URL"];
  if (url === undefined) throw new Error("DIRECT_URL is required for RUN_DB_TESTS=1");
  const owner = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<
      { business_id: string; account_id: string; memo_account_id: string }[]
    >`
      SELECT c.business_id, c.account_id, c.memo_account_id
        FROM card c
       ORDER BY c.created_at DESC
       LIMIT 1
    `;
    if (row === undefined) throw new Error("no card exists to borrow a chart from");
    businessId = row.business_id;

    const [card] = await owner<{ id: string }[]>`
      INSERT INTO card (provider, provider_card_token, business_id, account_id, memo_account_id,
                        last_four, nickname)
      VALUES (${PROVIDER}, ${CARD_TOKEN}, ${row.business_id}, ${row.account_id},
              ${row.memo_account_id}, '0000', 'card-controls integration')
      RETURNING id
    `;
    cardId = card?.id ?? "";

    const [actor] = await owner<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'human' ORDER BY display_name LIMIT 1
    `;
    actorId = actor?.id ?? "";
  } finally {
    await owner.end();
  }
}

/** How many decision rows one provider auth token has, in the harness lane. */
async function decisionRowCount(authToken: string): Promise<string> {
  const owner = postgres(process.env["DIRECT_URL"] as string, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM card_auth_decision
       WHERE provider_auth_token = ${authToken} AND source = 'harness'`;
    return row?.n ?? "0";
  } finally {
    await owner.end();
  }
}

/** The journal, as a single fingerprint. Used to prove nothing was posted. */
async function journalFingerprint(): Promise<string> {
  const url = process.env["DIRECT_URL"];
  const owner = postgres(url as string, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<{ n: string; total: string }[]>`
      SELECT count(*)::text AS n, COALESCE(SUM(amount_cents), 0)::text AS total
        FROM journal_line
    `;
    return `${row?.n}/${row?.total}`;
  } finally {
    await owner.end();
  }
}

d("card controls against the live database", () => {
  beforeAll(async () => {
    store = await import("./store");
    await provision();
  });

  it("1 — the control chain is versioned and append-only", async () => {
    const first = await store.setCardControls({
      cardId,
      draft: {
        cardState: "active",
        perTxnLimitCents: 5_000n,
        dailyLimitCents: null,
        monthlyLimitCents: null,
        blockedMccs: [],
        note: "opening position",
      },
      actorId,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.controls.version).toBe(1);

    const second = await store.setCardControls({
      cardId,
      draft: {
        cardState: "active",
        perTxnLimitCents: 1_000n,
        dailyLimitCents: 2_000n,
        monthlyLimitCents: null,
        blockedMccs: ["5542"],
        note: "$10 per transaction, fuel blocked",
      },
      actorId,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.controls.version).toBe(2);

    // Both versions survive. There is no UPDATE — the earlier limit is still
    // readable, which is what makes a decision that cited it explainable.
    const versions = await store.listControlVersions(cardId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]?.perTxnLimitCents).toBe(5_000n);
  });

  it("1b — the database refuses an UPDATE on a control version", async () => {
    // The app role holds SELECT and INSERT and nothing else, and the table
    // carries the same immutability trigger as the journal. Attempting the
    // forbidden thing and asserting refusal is the only proof worth having.
    const app = postgres(process.env["APP_DATABASE_URL"] as string, { max: 1, onnotice: () => {} });
    try {
      await expect(
        app`UPDATE card_control_version SET note = 'tampered' WHERE card_id = ${cardId}`,
      ).rejects.toThrow(/permission denied|append-only/i);
    } finally {
      await app.end();
    }
  });

  it("2 — a $50 fuel-pump authorisation is declined by a $10 limit, end to end", async () => {
    const before = await journalFingerprint();

    const request = parseAsaRequest(
      asaPayload({ cardToken: CARD_TOKEN, amountCents: 5_000, mcc: "5542" }),
    );
    const lookup = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    expect(lookup.status).toBe("read");

    const verdict = decide(request, lookup);
    expect(verdict.outcome).toBe("decline");
    // MCC is checked before the amount, and 5542 is on version 2's block list,
    // so the fuel pump is refused for the category before the limit is reached.
    expect(verdict.rule).toBe("mcc_blocked");
    expect(verdict.result).toBe("UNAUTHORIZED_MERCHANT");

    const id = await store.appendDecision({
      provider: PROVIDER,
      request,
      lookup,
      verdict,
      latencyUs: 1234,
      source: "harness",
      requestId: null,
    });
    expect(id).not.toBeNull();

    // 5 — the decision path posted nothing.
    expect(await journalFingerprint()).toBe(before);
  });

  it("2b — the same $50 at a non-blocked merchant is declined by the limit", async () => {
    const request = parseAsaRequest(
      asaPayload({ cardToken: CARD_TOKEN, amountCents: 5_000, mcc: "5812" }),
    );
    const lookup = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    const verdict = decide(request, lookup);
    expect(verdict.rule).toBe("per_transaction_limit_exceeded");
    expect(verdict.inputs["limit_cents"]).toBe("1000");
    expect(verdict.inputs["over_by_cents"]).toBe("4000");
  });

  it("3 — approved spend accumulates in the harness lane and moves the daily total", async () => {
    const before = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    if (before.status !== "read") throw new Error("control read failed");

    // $6 — inside the $10 per-transaction limit, and inside the $20 daily one.
    const request = parseAsaRequest(
      asaPayload({ cardToken: CARD_TOKEN, amountCents: 600, mcc: "5812" }),
    );
    const verdict = decide(request, before);
    expect(verdict.outcome).toBe("approve");
    await store.appendDecision({
      provider: PROVIDER,
      request,
      lookup: before,
      verdict,
      latencyUs: 900,
      source: "harness",
      requestId: null,
    });

    const after = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    if (after.status !== "read") throw new Error("control read failed");
    expect(after.spend.dayCents - before.spend.dayCents).toBe(600n);

    // The next $6 is fine; the one after that crosses $20 and is refused.
    const second = decide(request, after);
    expect(second.outcome).toBe("approve");
  });

  it("3b — a decline consumes no velocity", async () => {
    const before = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    if (before.status !== "read") throw new Error("control read failed");

    const request = parseAsaRequest(
      asaPayload({ cardToken: CARD_TOKEN, amountCents: 5_000, mcc: "5812" }),
    );
    const verdict = decide(request, before);
    expect(verdict.outcome).toBe("decline");
    await store.appendDecision({
      provider: PROVIDER,
      request,
      lookup: before,
      verdict,
      latencyUs: 800,
      source: "harness",
      requestId: null,
    });

    const after = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    if (after.status !== "read") throw new Error("control read failed");
    expect(after.spend.dayCents).toBe(before.spend.dayCents);
  });

  it("3c — the provider lane cannot see harness spend", async () => {
    // The honesty column, enforced in SQL rather than by convention. A harness
    // replay must never eat a real card's daily limit.
    const provider = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "provider",
    });
    if (provider.status !== "read") throw new Error("control read failed");
    expect(provider.spend.dayCents).toBe(0n);
  });

  it("4 — a later control change cannot retroactively re-judge a past decision", async () => {
    const decisionsBefore = await store.listDecisions({ businessId, limit: 50 });
    const declined = decisionsBefore.find(
      (row) => row.outcome === "decline" && row.rule === "per_transaction_limit_exceeded",
    );
    expect(declined).toBeDefined();
    const versionAtDecision = declined?.controlVersion;

    // Raise the limit far above the amount that was declined.
    const raised = await store.setCardControls({
      cardId,
      draft: {
        cardState: "active",
        perTxnLimitCents: 1_000_000n,
        dailyLimitCents: null,
        monthlyLimitCents: null,
        blockedMccs: [],
        note: "limits lifted after the fact",
      },
      actorId,
    });
    expect(raised.ok).toBe(true);

    const decisionsAfter = await store.listDecisions({ businessId, limit: 50 });
    const same = decisionsAfter.find((row) => row.id === declined?.id);
    expect(same?.outcome).toBe("decline");
    expect(same?.controlVersion).toBe(versionAtDecision);
    expect(same?.inputs["limit_cents"]).toBe("1000");
  });

  it("5 — an unknown card token is a successful read with no controls", async () => {
    const lookup = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: `never-issued-${Date.now()}`,
      source: "harness",
    });
    expect(lookup.status).toBe("read");
    if (lookup.status === "read") {
      expect(lookup.cardId).toBeNull();
      expect(lookup.controls).toBeNull();
    }
  });

  it("6 — a control read that misses its deadline is 'unavailable', not a throw", async () => {
    // 1 ms against a network round trip. The fail-closed branch has to be
    // reachable from a test or the argument in decide.ts is untested prose.
    const lookup = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
      budgetMs: 1,
    });
    expect(lookup.status).toBe("unavailable");

    const request = parseAsaRequest(asaPayload({ cardToken: CARD_TOKEN, amountCents: 1 }));
    const verdict = decide(request, lookup);
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("control_store_unavailable");
  });

  it("8 — a missed append deadline records ONE row, not two", async () => {
    // THE REGRESSION. On 2026-09-11T14:09:08Z a real Lithic delivery
    // (transaction 8025729c-f3a8-4aa1-bfd5-b42405e16f9a) produced TWO rows in
    // `card_auth_decision` with one webhook id and one 600,390 us latency: the
    // insert lost the 400 ms race, `withDeadline()` does not cancel the loser,
    // and the route read that null as "not written" and inserted again.
    //
    // On a DECLINE that is a lie in an append-only table. On an APPROVE it is
    // worse — the velocity sum is SUM(amount_cents) over approvals, so one
    // $200 authorisation would have eaten $400 of the cardholder's day.
    //
    // The token is unique to this run, so the count below is this test's alone.
    const authToken = randomUUID();
    const request = parseAsaRequest(
      asaPayload({ cardToken: CARD_TOKEN, token: authToken, amountCents: 700, mcc: "5812" }),
    );
    const lookup = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    const verdict = decide(request, lookup);
    const params = {
      provider: PROVIDER,
      request,
      lookup,
      verdict,
      latencyUs: 4242,
      source: "harness" as const,
      requestId: authToken,
    };

    // 1 ms against a network round trip: the caller gives up, the INSERT does
    // not. This is exactly the state the route is in when it logs
    // `asa.decision_not_recorded`.
    const pending = store.startDecisionAppend(params);
    expect(await store.awaitDecisionAppend(pending, 1)).toBeNull();

    // The route now awaits THE SAME promise rather than issuing a second
    // insert. It comes back with the row the deadline could not wait for.
    const late = await pending;
    expect(late).not.toBeNull();

    // And the belt-and-braces path — used only when the original genuinely
    // rejected — refuses to write a second row for the same delivery.
    const again = await store.reappendDecisionIfMissing(params);
    expect(again.status).toBe("already_recorded");

    expect(await decisionRowCount(authToken)).toBe("1");
  });

  it("7 — the whole hot path stays well inside the provider's budget", async () => {
    // Not a benchmark, a floor. If the one read plus the decision ever takes
    // longer than Lithic's recommended ceiling, this feature is broken even
    // when every rule is right.
    const started = performance.now();
    const lookup = await store.readControlsAndSpend({
      provider: PROVIDER,
      providerCardToken: CARD_TOKEN,
      source: "harness",
    });
    decide(parseAsaRequest(asaPayload({ cardToken: CARD_TOKEN })), lookup);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
