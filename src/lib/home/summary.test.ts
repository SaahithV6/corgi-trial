/**
 * The landing page's two reads.
 *
 * Both halves run with no credentials and no network, which is deliberate:
 * these assert properties of the CODE — which columns the SQL asks for, and
 * which field of the health body the verdict is taken from — not properties of
 * whatever happens to be in the database this afternoon.
 *
 * The property that matters most is in `parseHealth`: a nested copy of a slot
 * saying `live` must never be able to promote the authoritative table's
 * `simulated`. That is DECISIONS 021, which is the shape of an automatic fail,
 * and it is asserted directly below.
 */
import { describe, expect, it } from "vitest";

import { isErr, isOk } from "@/lib/result";

import {
  DEFAULT_DEPLOYMENT_ORIGIN,
  parseHealth,
  readHealth,
  readSystemState,
  resolveOrigin,
  type Cents,
} from "./summary";
import type { Sql } from "@/lib/ledger/queries";

/* -------------------------------------------------------------------------- */
/* A connection that answers from a script                                    */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

/**
 * A connection that answers every statement from one script, and RECORDS the
 * transaction it was asked to open.
 *
 * `begin` is part of the fake because it is part of the contract now.
 * `readSystemState` runs its two statements — the ledger census and the
 * platform counters — inside one REPEATABLE READ READ ONLY transaction, which
 * is what replaced "keep all the SQL in one template literal" as the mechanism
 * holding the single-snapshot guarantee. A fake that silently tolerated the
 * transaction being dropped would let that guarantee be deleted in silence,
 * so the options string is captured and asserted on.
 */
function fakeSql(rows: readonly Row[]): {
  readonly conn: Sql;
  readonly statements: readonly string[];
  readonly transactions: readonly string[];
} {
  const statements: string[] = [];
  const transactions: string[] = [];
  const conn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(strings.join(` ?${values.length === 0 ? "" : ""} `));
    return Promise.resolve(rows);
  };
  (conn as unknown as { begin: unknown }).begin = (
    options: string,
    body: (tx: unknown) => Promise<unknown>,
  ) => {
    transactions.push(options);
    return body(conn);
  };
  return { conn: conn as unknown as Sql, statements, transactions };
}

function throwingSql(thrown: unknown): Sql {
  const conn = () => Promise.reject(thrown);
  (conn as unknown as { begin: unknown }).begin = (
    _options: string,
    body: (tx: unknown) => Promise<unknown>,
  ) => body(conn);
  return conn as unknown as Sql;
}

const ROW: Row = {
  read_at: new Date("2026-09-10T17:41:30.000Z"),
  journal_entries: 467,
  financial_entries: 328,
  memo_entries: 139,
  journal_lines: 934,
  booking_watermark: 479n,
  last_posted_at: new Date("2026-09-10T17:33:33.099Z"),
  card_authorisations: 84,
  card_auth_events: 171,
  active_holds: 20,
  active_hold_cents: 74_200n,
  webhook_total: 64,
  webhook_done: 53,
  webhook_pending: 0,
  webhook_parked: 11,
  webhook_dead: 0,
  last_delivery_at: new Date("2026-09-10T17:33:31.582Z"),
  debit_cents: 421_543_593n,
  credit_cents: 421_543_593n,
  trial_balance_accounts: 6,
  deposit_accounts: 2,
};

/* -------------------------------------------------------------------------- */
/* readSystemState                                                            */
/* -------------------------------------------------------------------------- */

describe("readSystemState", () => {
  it("maps every column, keeping money as bigint cents", async () => {
    const { conn } = fakeSql([ROW]);
    const result = await readSystemState(conn);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const state = result.value;
    expect(state.journalEntries).toBe(467);
    expect(state.financialEntries + state.memoEntries).toBe(state.journalEntries);
    expect(state.journalLines).toBe(934);
    expect(state.cardAuthorisations).toBe(84);
    expect(state.cardAuthEvents).toBe(171);
    expect(state.activeHolds).toBe(20);
    expect(state.webhooks.done).toBe(53);
    expect(state.webhooks.total).toBe(64);
    expect(state.depositAccounts).toBe(2);

    // Money is bigint, all the way from the int8 column to the formatter.
    const cents: Cents = state.activeHoldCents;
    expect(typeof cents).toBe("bigint");
    expect(cents).toBe(74_200n);
    expect(typeof state.trialBalance.debitCents).toBe("bigint");
  });

  it("derives the trial-balance difference rather than trusting a column", async () => {
    const { conn } = fakeSql([ROW]);
    const balanced = await readSystemState(conn);
    expect(isOk(balanced) && balanced.value.trialBalance.differenceCents).toBe(0n);

    // A book that does NOT balance must surface as a non-zero difference, not
    // be rounded away or clamped. Nothing in this system repairs it.
    const broken = fakeSql([{ ...ROW, credit_cents: 421_543_592n }]);
    const result = await readSystemState(broken.conn);
    expect(isOk(result) && result.value.trialBalance.differenceCents).toBe(1n);
  });

  it("counts only the financial book in the trial balance", async () => {
    const { conn, statements } = fakeSql([ROW]);
    await readSystemState(conn);
    const sql = statements.join("\n");
    expect(sql).toContain("e.book = 'financial'");
    // The memo book is off balance sheet: a hold must never appear in it.
    expect(sql).toContain("book = 'memo'");
  });

  it("asks for the active-hold figure the schema already publishes", async () => {
    const { conn, statements } = fakeSql([ROW]);
    await readSystemState(conn);
    const sql = statements.join("\n");
    // v_hold_state.active_hold_cents is closed(E)-aware and is what
    // v_hold_drift proves. Re-deriving it here would be a second opinion.
    expect(sql).toContain("v_hold_state");
    expect(sql).toContain("active_hold_cents");
    // And no provider status field, anywhere. DECISIONS 006: Lithic reports
    // SETTLED while a partial hold is still live.
    expect(sql).not.toMatch(/\bstatus\s*=\s*'SETTLED'/i);
  });

  it("takes every figure from ONE SNAPSHOT, in one repeatable-read transaction", async () => {
    const { conn, statements, transactions } = fakeSql([ROW]);
    await readSystemState(conn);

    // Two statements now — the ledger's census, and the counters that need
    // tables the ledger does not own. What makes them describe the same
    // instant is no longer that they are one string; it is that Postgres takes
    // ONE snapshot at the first statement of a REPEATABLE READ transaction and
    // every later statement reads from it. Asserting the count alone would
    // have been asserting the old mechanism.
    expect(statements).toHaveLength(2);
    expect(transactions).toEqual(["isolation level repeatable read read only"]);
  });

  it("asks the ledger for the ledger's own figures, and nothing more", async () => {
    const { conn, statements } = fakeSql([ROW]);
    await readSystemState(conn);
    const census = statements.find((s) => s.includes("journal_entry")) ?? "";
    const platform = statements.find((s) => s.includes("webhook_inbox")) ?? "";

    // The split is one test applied per figure: does it come from
    // journal_entry / journal_line / account and from nothing else?
    expect(census).not.toBe("");
    expect(platform).not.toBe("");
    expect(census).not.toContain("webhook_inbox");
    expect(census).not.toContain("card_auth");
    // And this file no longer writes SQL against the ledger's tables at all —
    // boundary.test.ts measures that directly, and this asserts the intent:
    // the census statement is the READER's, reached by import.
    expect(platform).not.toContain("journal_line");
    expect(platform).not.toContain("journal_entry");
  });

  it("returns the driver's own code when the database is unreachable", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const result = await readSystemState(throwingSql(refused));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("HOME_ECONNREFUSED");
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("never throws, and never invents a figure, when the read fails", async () => {
    const result = await readSystemState(throwingSql(new Error("boom")));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("HOME_READ_FAILED");
    expect(JSON.stringify(result)).not.toContain("467");
  });

  it("treats an empty result set as a failure, not as an empty ledger", async () => {
    const { conn } = fakeSql([]);
    const result = await readSystemState(conn);
    expect(isErr(result) && result.error.code).toBe("HOME_SUMMARY_NO_ROW");
  });
});

/* -------------------------------------------------------------------------- */
/* resolveOrigin                                                              */
/* -------------------------------------------------------------------------- */

function headersOf(entries: Record<string, string>): { get(n: string): string | null } {
  return { get: (name) => entries[name.toLowerCase()] ?? null };
}

/**
 * The permitted set, as Vercel would supply it on a preview deployment.
 *
 * Passed explicitly so these assertions are about the CODE and not about
 * whatever `process.env` happens to hold on the machine running them — which
 * is the same reason the rest of this file uses a scripted connection.
 */
const PREVIEW_ENV = {
  VERCEL_URL: "corgi-trial-9fh3kd-lain.vercel.app",
  VERCEL_BRANCH_URL: "corgi-trial-git-boundary-lain.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: "corgi-trial-psi.vercel.app",
};

describe("resolveOrigin", () => {
  it("trusts the forwarded proto, because TLS terminates at the edge", () => {
    expect(
      resolveOrigin(
        headersOf({ host: "corgi-trial-psi.vercel.app", "x-forwarded-proto": "https" }),
        PREVIEW_ENV,
      ),
    ).toBe("https://corgi-trial-psi.vercel.app");
  });

  it("takes the first hop of a proxy chain", () => {
    expect(
      resolveOrigin(
        headersOf({
          host: "corgi-trial-psi.vercel.app",
          "x-forwarded-proto": "https,http",
        }),
        PREVIEW_ENV,
      ),
    ).toBe("https://corgi-trial-psi.vercel.app");
  });

  it("prefers x-forwarded-host, so a preview reads its own health", () => {
    expect(
      resolveOrigin(
        headersOf({
          host: "internal:3000",
          "x-forwarded-host": "corgi-trial-9fh3kd-lain.vercel.app",
        }),
        PREVIEW_ENV,
      ),
    ).toBe("https://corgi-trial-9fh3kd-lain.vercel.app");
  });

  it("lets a branch alias read its own health too", () => {
    expect(
      resolveOrigin(
        headersOf({ "x-forwarded-host": "corgi-trial-git-boundary-lain.vercel.app" }),
        PREVIEW_ENV,
      ),
    ).toBe("https://corgi-trial-git-boundary-lain.vercel.app");
  });

  it("uses http for loopback and https for a permitted public host", () => {
    expect(resolveOrigin(headersOf({ host: "localhost:3000" }), {})).toBe(
      "http://localhost:3000",
    );
    expect(resolveOrigin(headersOf({ host: "127.0.0.1:3000" }), {})).toBe(
      "http://127.0.0.1:3000",
    );
    expect(resolveOrigin(headersOf({ host: "[::1]:3000" }), {})).toBe(
      "http://[::1]:3000",
    );
    expect(
      resolveOrigin(headersOf({ host: "corgi.example" }), {
        APP_BASE_URL: "https://corgi.example",
      }),
    ).toBe("https://corgi.example");
  });

  /* ------------------------------------------------------------------ */
  /* The hole this allowlist closes                                      */
  /* ------------------------------------------------------------------ */

  it("NEVER fetches a host the caller made up — SSRF, and a spoofable live table", () => {
    // Two things are being stopped at once. The server must not be steerable
    // into an outbound request to an arbitrary host; and `parseHealth` renders
    // whatever comes back as THIS system's live-versus-simulated table, so a
    // caller who picks the host picks the verdicts. Presenting a simulated
    // integration as live is an automatic fail of the whole trial.
    const attacker = headersOf({
      host: "corgi-trial-psi.vercel.app",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
    });
    expect(resolveOrigin(attacker, PREVIEW_ENV)).toBe(
      "https://corgi-trial-psi.vercel.app",
    );
  });

  it("does not accept a look-alike on the same public suffix", () => {
    // The wildcard that would have been tempting — `*.vercel.app` — is the
    // same hole with an extra step, because anyone can deploy to that domain.
    expect(
      resolveOrigin(
        headersOf({ "x-forwarded-host": "corgi-trial-psi.attacker.vercel.app" }),
        PREVIEW_ENV,
      ),
    ).toBe("https://corgi-trial-psi.vercel.app");
  });

  it("falls back to the CONFIGURED origin, not to the header, and not to VERCEL_URL", () => {
    // APP_BASE_URL wins when set...
    expect(
      resolveOrigin(headersOf({ "x-forwarded-host": "attacker.example" }), {
        ...PREVIEW_ENV,
        APP_BASE_URL: "https://configured.example/",
      }),
    ).toBe("https://configured.example");

    // ...and the STABLE production host otherwise. Never the per-deployment
    // VERCEL_URL, which is superseded within the hour — the same ordering the
    // Lithic and Plaid webhook-URL resolvers use, for the same reason.
    expect(
      resolveOrigin(headersOf({ "x-forwarded-host": "attacker.example" }), PREVIEW_ENV),
    ).toBe("https://corgi-trial-psi.vercel.app");
  });

  it("falls back rather than guessing when there is no host at all", () => {
    expect(resolveOrigin(headersOf({}), PREVIEW_ENV)).toBe(
      "https://corgi-trial-psi.vercel.app",
    );
    expect(resolveOrigin(headersOf({ host: "   " }), PREVIEW_ENV)).toBe(
      "https://corgi-trial-psi.vercel.app",
    );
    // With nothing configured at all there is still a built-in production
    // origin, so the panel degrades to "the wrong deployment's true verdicts"
    // rather than to "an origin somebody else chose".
    expect(resolveOrigin(headersOf({}), {})).toBe(DEFAULT_DEPLOYMENT_ORIGIN);
  });

  it("matches the host case-insensitively, because DNS is", () => {
    expect(
      resolveOrigin(
        headersOf({ "x-forwarded-host": "CORGI-TRIAL-PSI.VERCEL.APP" }),
        PREVIEW_ENV,
      ),
    ).toBe("https://CORGI-TRIAL-PSI.VERCEL.APP");
  });
});

/* -------------------------------------------------------------------------- */
/* parseHealth — the honest-labelling requirement                             */
/* -------------------------------------------------------------------------- */

/** The production body, trimmed to the fields this parser reads. */
const HEALTH_BODY = {
  status: "ok",
  checkedAt: "2026-09-10T17:41:30.023Z",
  commit: { sha: "3b1d138d401eb6639c7d73dd8f8cef46e54d55bf", shortSha: "3b1d138" },
  database: { urlEnv: "APP_DATABASE_URL", reachable: true, latencyMs: 182 },
  integrations: {
    live: 5,
    total: 7,
    slots: [
      {
        slot: "card_issuing",
        provider: "Lithic sandbox",
        status: "live",
        mustBeLive: true,
        liveness: "live",
        evidence: "GET /v1/cards -> 200",
        latencyMs: 237,
      },
      {
        slot: "business_registry",
        provider: "Stripe Connect (gated) — simulated",
        status: "simulated",
        mustBeLive: false,
        liveness: "unauthorised",
        evidence: "Connect not enabled.",
        latencyMs: 175,
      },
    ],
    // The nested, joined copy. In production this once said `live` for a slot
    // the authoritative table above called `simulated`. Nothing below reads it.
    webhooks: [
      {
        provider: "stripe",
        slots: [{ slot: "business_registry", status: "live", evidence: "credentials_present" }],
      },
    ],
  },
};

describe("parseHealth", () => {
  it("reads the authoritative slot table", () => {
    const result = parseHealth(HEALTH_BODY);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.total).toBe(2);
    expect(result.value.slots.map((s) => s.slot)).toEqual([
      "card_issuing",
      "business_registry",
    ]);
    expect(result.value.commitShortSha).toBe("3b1d138");
    expect(result.value.databaseReachable).toBe(true);
    expect(result.value.databaseLatencyMs).toBe(182);
  });

  it("carries the evidence string that earned each verdict", () => {
    const result = parseHealth(HEALTH_BODY);
    if (!isOk(result)) throw new Error("expected ok");
    expect(result.value.slots[0]?.evidence).toBe("GET /v1/cards -> 200");
    expect(result.value.slots[1]?.evidence).toContain("Connect not enabled");
    expect(result.value.slots[1]?.liveness).toBe("unauthorised");
  });

  it("a nested copy claiming `live` cannot promote a simulated slot", () => {
    const result = parseHealth(HEALTH_BODY);
    if (!isOk(result)) throw new Error("expected ok");

    const registry = result.value.slots.find((s) => s.slot === "business_registry");
    expect(registry?.status).toBe("simulated");
    // ...and the headline is counted from these rows, not from
    // `integrations.live`, which claims 5 in this fixture.
    expect(result.value.liveCount).toBe(1);
  });

  it("only the exact string `live` earns LIVE", () => {
    for (const status of ["LIVE", "Live", "ok", true, 1, null, undefined, "healthy"]) {
      const result = parseHealth({
        integrations: { slots: [{ slot: "s", provider: "p", status }] },
      });
      if (!isOk(result)) throw new Error("expected ok");
      expect(result.value.slots[0]?.status).not.toBe("live");
      expect(result.value.liveCount).toBe(0);
    }
  });

  it("refuses to render a table it cannot recognise", () => {
    for (const body of [null, 42, "ok", {}, { integrations: {} }, { integrations: { slots: {} } }]) {
      const result = parseHealth(body);
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) continue;
      expect(result.error.code).toBe("HEALTH_SHAPE_UNEXPECTED");
    }
  });

  it("refuses a slot row with no slot or provider name", () => {
    const result = parseHealth({
      integrations: { slots: [{ status: "live" }] },
    });
    expect(isErr(result) && result.error.code).toBe("HEALTH_SHAPE_UNEXPECTED");
  });
});

/* -------------------------------------------------------------------------- */
/* readHealth                                                                 */
/* -------------------------------------------------------------------------- */

describe("readHealth", () => {
  it("fetches /api/health on the given origin, uncached", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(
        new Response(JSON.stringify(HEALTH_BODY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const result = await readHealth("https://corgi-trial-psi.vercel.app", { fetchImpl });
    expect(isOk(result)).toBe(true);
    expect(seen.url).toBe("https://corgi-trial-psi.vercel.app/api/health");
    expect(seen.init?.cache).toBe("no-store");
  });

  it("says the endpoint is unreachable rather than guessing a table", async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch;

    const result = await readHealth("https://corgi.example", { fetchImpl });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("HEALTH_UNREACHABLE");
    expect(result.error.message).toContain("fetch failed");
  });

  it("treats a non-2xx as broken, since health answers 200 even when degraded", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch;

    const result = await readHealth("https://corgi.example", { fetchImpl });
    expect(isErr(result) && result.error.code).toBe("HEALTH_HTTP_ERROR");
  });

  it("reports a body that is not JSON", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )) as unknown as typeof fetch;

    const result = await readHealth("https://corgi.example", { fetchImpl });
    expect(isErr(result) && result.error.code).toBe("HEALTH_NOT_JSON");
  });

  it("fails closed when the origin cannot be determined", async () => {
    const result = await readHealth(null);
    expect(isErr(result) && result.error.code).toBe("HEALTH_ORIGIN_UNKNOWN");
  });
});
