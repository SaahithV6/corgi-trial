/**
 * ATTACK 2 — "Capture $73.40 two days later. Assert the hold releases exactly
 * once (one closure row, one release posting) and the ledger posts the settled
 * 7340. Available goes negative; assert it is NOT clamped."
 *
 * The fuel-pump over-capture: authorise $50.00, clear $73.40. Lithic's own
 * `status` flips to SETTLED while a partial hold is still live (DECISIONS 006),
 * so a system that released holds on that field would free money that is still
 * authorised. This asserts the outcome, not the mechanism, and it reads that
 * outcome out of the live database after the deployed system processed it.
 *
 * WHAT "EXACTLY ONCE" IS ASSERTED AS. The attack names two things and they are
 * asserted separately, because they are two separate claims and one of them
 * holds while the other is deliberately not made:
 *
 *   * exactly ONE release POSTING — the memo entries for that hold are the
 *     opening delta and its exact negation, and nothing else. Two entries,
 *     summing to zero, so the hold's memo balance is zero and the customer's
 *     available is exactly right. This is the money claim, and it PASSES.
 *   * exactly ONE `hold_closure` row — PRIMARY KEY (hold_id), so a second is
 *     unrepresentable. This is the bookkeeping claim. It is NOT made on an
 *     over-capture, and the third test below skips rather than pretending
 *     either way.
 *
 * WHY THE CLOSURE ROW IS NOT WRITTEN — MEASURED, NOT ARGUED. The second test in
 * this file is the measurement, and it is the reason the third one skips.
 * Writing a closure on `C >= A` requires over-capture to be TERMINAL: nothing
 * may raise A afterwards, because `hold_closure` is append-only with
 * `PRIMARY KEY (hold_id)` and `v_hold_state.is_released` reads it.
 *
 * Over-capture is NOT terminal. Measured against the Lithic sandbox on
 * 2026-09-11 and re-measured by the second test on every run: after a CLEARING
 * that exceeds the authorisation and drives the transaction to SETTLED with
 * `amounts.hold.amount = 0`, `POST /v1/simulate/authorization_advice` answers
 * 201 and appends an `AUTHORIZATION_ADVICE` with `result: APPROVED` — and a
 * further CLEARING for the difference is approved too. The hold reopens, and
 * the reopened amount is then really captured.
 *
 * So a closure row written at the over-capture would have to be reversed by the
 * next event. That is exactly the failure migration 0011 exists to clean up
 * ($60 freed across three holds), and doing it on purpose would be worse than
 * doing it by accident. The skip stands on a measurement; see docs/HOLDS.md.
 *
 * WHAT "NOT CLAMPED" IS ASSERTED AS: `available == ledger − holds − uncleared`
 * exactly, in integers, with no floor anywhere; the customer's available moves
 * by exactly −7340 across the whole episode (the $50.00 hold comes back, the
 * $73.40 settles), which is only true if nothing was clipped at zero; and the
 * resulting figure is reported negative when it is negative.
 *
 * ONE HONEST NOTE. "Two days later" is not reproducible: the Lithic sandbox has
 * no test clock for card transactions, so the clearing is simulated in the same
 * run. What the attack is about — the release arithmetic and its exactly-once
 * property — does not depend on the gap, and the value dates the pipeline
 * records come from the provider's own payload either way.
 *
 * ─── WHAT MIGRATION 0026 CHANGED ABOUT THIS TEST ────────────────────────────
 *
 * §7 of docs/HOLDS.md left this open and named this file's own authorisation as
 * the evidence: Lithic transaction 041d610c-a71a-432e-ad62-ca16b6d882b0 reads
 * `AUTHORIZATION 5000 result DECLINED
 * detailed_results ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]`, and the ledger
 * placed the full $50.00 hold on it anyway, because `deriveCardEvents` never
 * read `event.result`. So "the hold releases exactly once" was being asserted
 * about a hold that should never have existed — the release arithmetic was
 * genuinely correct, and it was being exercised on fabricated input.
 *
 * 0026 carries the verdict through the front door. This file now reads it from
 * the provider before asserting anything, and branches:
 *
 *   APPROVED  → the published attack, unchanged.
 *   REFUSED   → assert the invariant 0026 installs, in full — the network
 *               granted nothing, so nothing was withheld: no memo entry on the
 *               hold, holds/available/ledger flat across the authorisation,
 *               and THIS RUN'S OWN HOLD absent from `v_refused_auth_hold`.
 *               Then PASS, on that claim and no larger one.
 *
 * ─── A REFUSAL IS A PASS, AND THE EVIDENCE SAYS WHAT IT IS A PASS OF ────────
 *
 * The first test used to throw on a refusal, on the argument that "the demo
 * could not be performed" is a red rather than a skip. That was right about
 * the skip and wrong about the red. Nothing here is broken: the delivery
 * arrived, the consumer ran, the verdict survived ingest, and the ledger
 * correctly withheld nothing. Failing on that reports a working system as a
 * broken one, which is the same misreport as a green on a broken one, pointing
 * the other way.
 *
 * So it passes, on a NAMED, DIFFERENT and strictly weaker claim than the
 * published attack's:
 *
 *     a declined authorisation places no hold, so there is correctly nothing
 *     to release.
 *
 * The FIRST evidence line says in those words that the published happy path —
 * "the hold releases exactly once" — was NOT exercised, and names why. A test
 * that reads as if it proved more than it did is worse than a skip, and the
 * evidence is the only place that can be said, because the scoreboard title is
 * fixed in `scripts/livefire.mjs`.
 *
 * The ATTACK still scores SKIP on a refused run, and correctly: the other two
 * tests in this file skip (the measurement needs an approved authorisation
 * before it can ask its question; the closure-row test needs the episode), and
 * `verdictFor` in the runner scores a file with any skipped test as SKIP. One
 * test passing on a smaller claim does not promote the attack, which is the
 * runner doing its job.
 *
 * ─── WHAT WAS ASSERTED ABSOLUTELY AND IS NOW ASSERTED RELATIVELY ────────────
 *
 * The refusal path used to assert `count(*) FROM v_refused_auth_hold` is 0 — a
 * claim that NOBODY on the whole deployment is withholding money against an
 * unapproved authorisation. That is not true and must not be expected to be:
 * the view carries the historical backlog of authorisations whose verdict was
 * never observed (pre-0026 fixture events, plus test authorisations from the
 * other suites), migration 0032 DELIBERATELY refused to exclude them, and
 * `scripts/dbcheck.mjs` reports that count as a standing, deliberate failure
 * that must not be tuned back.
 *
 * The assertion was not too strong or too weak; it was scoped to the wrong
 * thing. It is now scoped to the rows THIS RUN created — this run's hold id
 * and this run's provider transaction. The book-wide count is still read and
 * printed beside it, so a reader sees the number and sees that it is not ours.
 * That is the repair attacks 3 and 7 had earlier tonight, and the rule README
 * §1 carries out of it: never widen a tolerance to absorb another writer. The
 * count is not loosened to "fewer than N"; it is pointed at our own rows.
 *
 * The MEASUREMENT test (the second one) does skip on a refusal, and that is a
 * different judgement for a different reason: it needs an approved
 * authorisation to over-capture before it can ask its question at all, so a
 * refusal leaves its question genuinely unasked rather than answered wrongly.
 *
 * 041d610c also settles one design point here. The sandbox accepted a CLEARING
 * of 7340 against that DECLINED authorisation and drove the transaction to
 * SETTLED — so a refusal must NOT be flagged final and must NOT close the hold,
 * or the capture that follows would have nothing to reconcile against.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as Holds from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 2;
const NAME =
  "Over-capture at $73.40 releases the $50 hold exactly once, and available is not clamped";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  // Recreate the directory if something removed it under us. A run has already
  // lost its evidence to a concurrent `next build` wiping the folder it was
  // written into: every record() after that threw ENOENT and an attack whose
  // assertions had all passed was scored as a failure with a filesystem error
  // as its reason. Evidence must never be the thing that fails a live-fire run.
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const BASE_URL = (
  process.env["LIVEFIRE_BASE_URL"] ?? "https://corgi-trial-psi.vercel.app"
).replace(/\/+$/, "");

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY");
}

const READY = MISSING.length === 0;
if (!READY) record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);

const d = READY ? describe : describe.skip;

const AUTH_CENTS = 50_00;
const CAPTURE_CENTS = 73_40;
/** The incremental the fuel pump sends AFTER the over-capture, in the measurement. */
const INCREMENT_TO_CENTS = 90_00;
const REMAINDER_CENTS = INCREMENT_TO_CENTS - CAPTURE_CENTS; // 1660

/** The simulate endpoints are capped at 1 rps and will 429 if two calls race. */
const pace = () => new Promise((r) => setTimeout(r, 1_500));

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof Holds;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();
  let drainStatus = "not attempted";
  /** Set by the first test; the third reads the hold it created. */
  let episode: { businessId: string; transactionToken: string; holdId: string } | null = null;
  /** Set by the second test; the third quotes it in its skip reason. */
  let measurement: string | null = null;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
  });

  /**
   * `POST /v1/simulate/authorization_advice` — the sandbox's incremental
   * authorisation. It is NOT on the rail client, because nothing in the
   * application sends one: an incremental is something the network tells US
   * about, on a webhook. It is here, as a raw call, because this file is where
   * the question "can one arrive after an over-capture?" is answered, and the
   * answer has to come from the provider rather than from our client.
   *
   * The amount is ABSOLUTE, not a delta (research/lithic/NOTES.md §3c): to go
   * from $73.40 authorised to $90.00 you send 9000, not 1660.
   */
  async function authorizationAdvice(
    token: string,
    absoluteCents: number,
  ): Promise<{ status: number; body: string }> {
    const base = (
      process.env["LITHIC_BASE_URL"] ?? lithic.LITHIC_SANDBOX_BASE_URL
    ).replace(/\/+$/, "");
    const response = await fetch(`${base}/simulate/authorization_advice`, {
      method: "POST",
      headers: {
        // The RAW key, no `Bearer` — same as the rail client sends.
        authorization: process.env["LITHIC_API_KEY"] ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token, amount: absoluteCents }),
    });
    return { status: response.status, body: (await response.text()).slice(0, 300) };
  }

  /**
   * The operator's "watch, I will drain it now", against the DEPLOYED endpoint.
   * Not a local dispatcher: what is under test is production.
   */
  async function nudgeDrain() {
    const token = process.env["DRAIN_TOKEN"];
    if (token === undefined || token === "") {
      drainStatus = "no DRAIN_TOKEN in the environment";
      return;
    }
    try {
      const response = await fetch(`${BASE_URL}/api/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as Record<string, unknown>;
      drainStatus =
        response.status === 200
          ? `HTTP 200 claimed=${String(body["claimed"])} processed=${String(body["processed"])} parked=${String(body["parked"])}`
          : `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`;
    } catch (thrown) {
      drainStatus = `unreachable: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }
  }

  /** Poll the live database, nudging the deployed drain between reads. */
  async function until<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() >= deadline) return null;
      await nudgeDrain();
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  it("authorise $50.00, capture $73.40, and read the outcome out of the live database", async (ctx) => {
    const [customer] = await sql<{ business_id: string }[]>`
      SELECT dep.business_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!customer) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    const businessId = customer.business_id;

    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire over-capture ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    const pan = card.pan;
    if (pan === undefined || pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }
    await holds.registerCard(
      {
        provider: "lithic",
        providerCardToken: card.token,
        businessId,
        lastFour: card.last_four,
        nickname: `live-fire ${tag}`,
      },
      sql,
    );

    const beforeAuth = await bal.availableBalance(businessId);

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");
    const transactionToken: string = auth.token;

    const authRow = await until(async () => {
      const [row] = await sql<{ id: string; hold_id: string }[]>`
        SELECT id, hold_id FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
      return row ?? null;
    }, 90_000);

    if (authRow === null) {
      const reason = `the $50.00 authorisation never reached the ledger, so there is no hold to release and the attack is unproven. Lithic transaction ${transactionToken} on registered card ${card.token} produced no card_authorization row within 90s; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // ---- WHAT DID THE NETWORK ACTUALLY SAY? ------------------------------
    //
    // Asked of the provider before anything is asserted, because the class of
    // bug 0026 closed is our own copy having thrown the answer away.
    const authorised = await lithic.getTransaction(transactionToken);
    const authEvent = (authorised.events ?? []).find((e) => e.type === "AUTHORIZATION");
    const verdict: string = authEvent?.result ?? authorised.result;
    const detail = (authEvent?.detailed_results ?? []).join(", ");

    if (verdict !== "APPROVED") {
      const refusedPosition = await bal.availableBalance(businessId);
      const detailText = detail === "" ? "" : ` detailed_results [${detail}]`;

      const [memoRows] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM journal_entry
         WHERE hold_id = ${authRow.hold_id}::uuid AND book = 'memo'`;

      // THIS RUN'S ROWS. `v_refused_auth_hold` is a standing invariant over
      // every hold on the deployment, and asserting `count(*) = 0` on it is a
      // claim about every other suite on the book — see the header. What this
      // attack owns is the authorisation it just caused: by the hold the
      // pipeline created for it, and by the provider transaction it came from.
      // The view lists a hold only while `active_hold_cents > 0`, so absence
      // here IS the claim — this declined authorisation withholds nothing.
      const [mine] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM v_refused_auth_hold
         WHERE hold_id = ${authRow.hold_id}::uuid
            OR provider_auth_id = ${transactionToken}`;

      // READ AND REPORTED, NEVER ASSERTED: the historical backlog 0032
      // deliberately refused to exclude and dbcheck reports as a standing
      // failure. Printed beside the scoped count so a reader sees whose it is.
      const [book] = await sql<{ total: number; refused: number; unanswered: number }[]>`
        SELECT count(*)::int                                       AS total,
               count(*) FILTER (WHERE verdict = 'refused')::int    AS refused,
               count(*) FILTER (WHERE verdict = 'unanswered')::int AS unanswered
          FROM v_refused_auth_hold`;

      // RECORDED BEFORE ASSERTED. A failing `expect` throws and takes every
      // line below it with it, so an assertion above the evidence leaves a
      // bare "expected 25000n to be 20000n" in the pack with nothing attached.
      // That is what the first run of this file produced. The panel is being
      // asked to watch a diagnosis; the diagnosis has to outlive the failure.
      record(
        "evidence",
        `THE PUBLISHED HAPPY PATH WAS NOT EXERCISED: the network REFUSED the $50.00 authorisation ` +
          `this release was to be measured against, so "the hold releases exactly once" is NOT ` +
          `shown by this run — there is correctly no hold to release. Lithic transaction ` +
          `${transactionToken}: AUTHORIZATION ${AUTH_CENTS} result ${verdict}${detailText}. ` +
          `CAUSE: the sandbox account's rolling 24-hour spend limit is exhausted — ` +
          `GET /v1/accounts/{token}/spend_limits reads available_spend_limit.daily = 0 against ` +
          `spend_limit.daily = 500000, spend_velocity.daily = 760210, so NO authorisation can be ` +
          `approved at ANY amount (proved by sending one cent and watching it decline). Raising it ` +
          `needs PATCH /v1/accounts/{token}, which the permission classifier deliberately blocks; ` +
          `the routes out are a raised limit or a second provider account, and both are a human's ` +
          `decision. What IS proved below is the weaker, different and real claim: a declined ` +
          `authorisation places no hold.`,
      );

      record(
        "evidence",
        `A DECLINED AUTHORISATION PLACED NO HOLD — the invariant migration 0026 installs, and the ` +
          `one production did not have for eight hours (DECISIONS 050, 056). Read live, across ` +
          `this authorisation only: holds ${beforeAuth.holdsCents} -> ` +
          `${refusedPosition.holdsCents} (must be UNCHANGED), available ` +
          `${beforeAuth.availableCents} -> ${refusedPosition.availableCents} (must be UNCHANGED), ` +
          `ledger ${beforeAuth.ledgerCents} -> ${refusedPosition.ledgerCents} (must be ` +
          `UNCHANGED), hold ${authRow.hold_id} carries ${memoRows?.n} memo entr(ies) (must be 0) ` +
          `and appears in v_refused_auth_hold ${mine?.n} time(s) (must be 0 — this run's own rows, ` +
          `scoped by hold id and by provider transaction). drain ${drainStatus}.` +
          (refusedPosition.holdsCents === beforeAuth.holdsCents
            ? ` The hold was correctly NOT placed, so there is correctly nothing to release.`
            : ` THE HOLD WAS PLACED ANYWAY: +${refusedPosition.holdsCents - beforeAuth.holdsCents} ` +
              `cents withheld against an authorisation the network refused. Seeing this here means ` +
              `the code serving ${BASE_URL} predates migration 0026 — the fix is in the ` +
              `repository and has not been deployed to the host that processed this delivery.`),
      );

      record(
        "evidence",
        `NOT ASSERTED, REPORTED: v_refused_auth_hold carries ${book?.total} row(s) book-wide ` +
          `(${book?.refused} refused, ${book?.unanswered} unanswered) — the historical backlog of ` +
          `authorisations whose verdict was never observed, which migration 0032 DELIBERATELY ` +
          `refused to exclude and dbcheck reports as a standing failure. None of them is this ` +
          `run's. This attack asserts the scoped count above and makes no claim about the book, ` +
          `because a global zero is a claim about every other suite writing to this database, and ` +
          `one an attack has no business making and cannot keep (README §1). Before migration 0026 ` +
          `this same refusal produced a PASS on the FULL attack: the decline was ingested as an ` +
          `approval, the $50 hold was placed, and the release arithmetic was exercised on input ` +
          `the network had rejected.`,
      );

      // The invariant 0026 installs: a refused authorisation withholds NOTHING.
      expect(refusedPosition.holdsCents).toBe(beforeAuth.holdsCents);
      expect(refusedPosition.availableCents).toBe(beforeAuth.availableCents);
      expect(refusedPosition.ledgerCents).toBe(beforeAuth.ledgerCents);
      expect(memoRows?.n).toBe(0);
      expect(mine?.n).toBe(0);

      // A PASS, not a throw and not a skip: the pipeline ran end to end and a
      // real property was demonstrated. The attack as a whole still scores
      // SKIP, because the two tests below cannot run — see the header.
      return;
    }

    // Position with the hold live: this is what the capture has to undo.
    const held = await bal.availableBalance(businessId);
    expect(held.holdsCents - beforeAuth.holdsCents).toBe(BigInt(AUTH_CENTS));

    // ---- the capture, over the amount authorised -------------------------
    await lithic.simulateClearing({ token: transactionToken, amountCents: CAPTURE_CENTS });

    const captured = await until(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM card_auth_event ce
          JOIN card_authorization ca ON ca.id = ce.auth_id
         WHERE ca.provider_auth_id = ${transactionToken} AND ce.kind = 'clearing'`;
      return (row?.n ?? 0) > 0 ? row : null;
    }, 90_000);

    if (captured === null) {
      const reason = `the $73.40 clearing for ${transactionToken} never reached the ledger within 90s, so the release is unproven; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }
    expect(captured).toBeDefined();
    expect(captured?.n).toBe(1); // nothing double-counted the capture

    // ---- 1. ONE release posting, and the hold is worth nothing -----------
    // Every memo entry against this hold, netted over the hold's own memo
    // account: the opening, and its exact negation. Nothing else.
    const memo = await sql<{ entry_id: string; delta: bigint }[]>`
      SELECT e.id AS entry_id, SUM(l.amount_cents)::bigint AS delta
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN hold          h ON h.id = e.hold_id
       WHERE e.hold_id = ${authRow.hold_id}::uuid
         AND e.book = 'memo'
         AND l.account_id = h.memo_account_id
       GROUP BY e.id, e.booking_seq
       ORDER BY e.booking_seq`;

    expect(memo).toHaveLength(2);
    const opening = memo[0];
    const release = memo[1];
    if (opening === undefined || release === undefined) throw new Error("unreachable");
    expect(opening.delta).toBe(-BigInt(AUTH_CENTS)); // credit: more held
    expect(release.delta).toBe(BigInt(AUTH_CENTS)); // debit: released, once
    expect(opening.delta + release.delta).toBe(0n);

    // ---- 2. the ledger posts the settled 7340 ----------------------------
    const after = await bal.availableBalance(businessId);
    expect(held.ledgerCents - after.ledgerCents).toBe(BigInt(CAPTURE_CENTS));

    const [settlement] = await sql<{ n: number; cents: bigint }[]>`
      SELECT count(DISTINCT e.id)::int AS n,
             COALESCE(SUM(l.amount_cents), 0)::bigint AS cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN account       a ON a.id = l.account_id
                            AND a.code = '2100' AND a.business_id = ${businessId}::uuid
       WHERE e.book = 'financial' AND e.rail = 'card'
         AND e.external_ref = ${transactionToken}`;
    expect(settlement?.n).toBe(1);
    expect(settlement?.cents).toBe(BigInt(CAPTURE_CENTS));

    // ---- 3. the hold no longer withholds anything ------------------------
    expect(after.holdsCents).toBe(beforeAuth.holdsCents);

    // ---- 4. NOT CLAMPED ---------------------------------------------------
    // The decomposition is exact, in integers, with no floor. A clamp anywhere
    // is the first thing this identity would break.
    expect(after.availableCents).toBe(after.ledgerCents - after.holdsCents - after.unclearedCents);
    // Across the whole episode: the $50 hold came back, $73.40 settled.
    expect(after.availableCents).toBe(beforeAuth.availableCents - BigInt(CAPTURE_CENTS));

    episode = { businessId, transactionToken, holdId: authRow.hold_id };

    record(
      "evidence",
      `hold ${authRow.hold_id}: memo entries = ${memo.length}, deltas ${opening.delta} then ${release.delta} (net 0 — one opening, one release posting, and the hold's memo balance is 0)`,
    );
    record(
      "evidence",
      `business ${businessId}: ledger ${held.ledgerCents} -> ${after.ledgerCents} (settled ${CAPTURE_CENTS} in exactly 1 financial entry under external_ref ${transactionToken}); available ${beforeAuth.availableCents} -> ${held.availableCents} held -> ${after.availableCents}; available == ledger(${after.ledgerCents}) - holds(${after.holdsCents}) - uncleared(${after.unclearedCents}) exactly, not clamped${after.availableCents < 0n ? " — and it IS negative, reported as negative rather than floored at zero" : ""}; drain ${drainStatus}`,
    );
  });

  /**
   * THE MEASUREMENT. This is the test that decides whether the third one can
   * ever be turned into an assertion, so it is run on every live-fire run
   * rather than recorded once in a document and trusted.
   *
   * The question it answers is exactly one: **after a clearing that exceeds the
   * authorisation, can the authorisation still go UP?** If it cannot, then
   * `C >= A` is terminal, a `hold_closure` row written on it can never be
   * wrong, and the third test below becomes an assertion. If it can, the row
   * would have to be reversed by the very next event and must not be written.
   *
   * The card here is deliberately NOT registered with `registerCard`. This test
   * measures the PROVIDER, not our pipeline: an unregistered card cannot resolve
   * to a deposit account, so nothing it does can move the ledger or leave a hold
   * behind. What it does touch is `deriveCardEvents` + `holdState`, fed the real
   * transaction as Lithic returns it — so the reopened figure is our model's
   * answer to the network's own events, not a fixture.
   */
  it("MEASURED: over-capture is NOT terminal — Lithic approves an incremental after it, and the hold reopens", async (ctx) => {
    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire overcapture-not-terminal ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    const pan = card.pan;
    if (pan === undefined || pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }
    await pace();

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI PUMP ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    const token = auth.token;
    if (token === undefined) throw new Error("Lithic returned no transaction token");
    await pace();

    // This measurement needs an APPROVED authorisation before it can ask its
    // question — "after a clearing that exceeds the authorisation, can the
    // authorisation still go UP?" presupposes one. A refusal leaves the
    // question unasked rather than answered wrongly, which is exactly what a
    // skip means in this suite, and a skip is never counted as a pass.
    const opened = await lithic.getTransaction(token);
    const openedEvent = (opened.events ?? []).find((e) => e.type === "AUTHORIZATION");
    const openedVerdict: string = openedEvent?.result ?? opened.result;
    if (openedVerdict !== "APPROVED") {
      const reason =
        `the measurement could not be taken: Lithic refused the $50.00 authorisation it needs to ` +
        `over-capture. Transaction ${token}, AUTHORIZATION ${AUTH_CENTS} result ${openedVerdict} ` +
        `detailed_results [${(openedEvent?.detailed_results ?? []).join(", ")}]. The account's ` +
        `rolling 24-hour spend limit is exhausted (available_spend_limit.daily = 0), and raising it ` +
        `needs PATCH /v1/accounts/{token}, which is deliberately blocked. docs/HOLDS.md §4's ` +
        `decision therefore rests on the run recorded in §3 rather than on one taken today; nothing ` +
        `here contradicts it, and nothing here confirms it either.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // ---- the over-capture, on the published attack's own numbers ---------
    await lithic.simulateClearing({ token, amountCents: CAPTURE_CENTS });
    await pace();

    const overCaptured = await lithic.getTransaction(token);
    const clock = (txnCreated: string) => ({
      expiresAt: new Date(Date.parse(txnCreated) + holds.CARD_AUTH_EXPIRY_DAYS * 86_400_000),
      now: new Date(),
    });

    const s1 = holds.holdState(
      holds.deriveCardEvents(overCaptured).events,
      clock(overCaptured.created),
    );
    // This is the state in which the `C >= A` arm would fire, and everything it
    // would claim about the world is true AT THIS INSTANT: more has been
    // captured than was ever authorised, and the hold is worth nothing.
    expect(s1.capturedCents).toBe(BigInt(CAPTURE_CENTS));
    expect(s1.capturedCents >= s1.authorisedCents).toBe(true);
    expect(s1.holdCents).toBe(0n);
    // ...and the model does NOT call it closed, which is the disagreement with
    // DESIGN §8.3 row 2 that this whole file is about.
    expect(s1.closed).toBe(false);
    expect(s1.terminallyClosed).toBe(false);

    // ---- the question ----------------------------------------------------
    const advice = await authorizationAdvice(token, INCREMENT_TO_CENTS);
    await pace();
    const reopened = await lithic.getTransaction(token);
    const adviceEvents = (reopened.events ?? []).filter((e) => e.type === "AUTHORIZATION_ADVICE");
    const lastAdvice = adviceEvents[adviceEvents.length - 1];

    if (advice.status !== 201 || lastAdvice === undefined || lastAdvice.result !== "APPROVED") {
      // The OTHER outcome, and it is a good one: if the network refuses an
      // incremental after an over-capture then over-capture IS terminal, the
      // `C >= A` arm is safe, and the third test below becomes an assertion.
      // Recorded loudly rather than swallowed, because it would change a
      // decision that is currently written down as settled.
      const reason =
        `Lithic REFUSED an incremental after the over-capture: POST /v1/simulate/authorization_advice ` +
        `answered HTTP ${advice.status} ${advice.body}, last AUTHORIZATION_ADVICE result ` +
        `${String(lastAdvice?.result)}. If that reproduces, over-capture is terminal in fact and ` +
        `docs/HOLDS.md's decision to leave closed(E) alone must be revisited — the C >= A arm would ` +
        `be safe. Transaction ${token}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // The network took it. A is now 9000 against C = 7340.
    const s2 = holds.holdState(holds.deriveCardEvents(reopened).events, clock(reopened.created));
    expect(s2.authorisedCents).toBe(BigInt(INCREMENT_TO_CENTS));
    expect(s2.capturedCents).toBe(BigInt(CAPTURE_CENTS));
    // THE POINT. The hold is live again, for exactly the un-captured remainder.
    // A `hold_closure` row written one event ago would now be freeing this.
    expect(s2.holdCents).toBe(BigInt(REMAINDER_CENTS));
    expect(s2.closed).toBe(false);

    // ---- and the reopened hold is real money, not a bookkeeping artefact --
    await lithic.simulateClearing({ token, amountCents: REMAINDER_CENTS });
    await pace();
    const finished = await lithic.getTransaction(token);
    const clearings = (finished.events ?? []).filter((e) => e.type === "CLEARING");
    expect(clearings).toHaveLength(2);
    expect(clearings[1]?.result).toBe("APPROVED");

    const s3 = holds.holdState(holds.deriveCardEvents(finished).events, clock(finished.created));
    expect(s3.capturedCents).toBe(BigInt(INCREMENT_TO_CENTS)); // 7340 + 1660
    expect(s3.holdCents).toBe(0n);

    measurement =
      `Lithic transaction ${token}: AUTHORIZATION ${AUTH_CENTS} -> CLEARING ${CAPTURE_CENTS} ` +
      `(over-capture; status ${overCaptured.status}, amounts.hold ${String(overCaptured.amounts.hold.amount)}) ` +
      `-> POST /v1/simulate/authorization_advice ${INCREMENT_TO_CENTS} answered HTTP ${advice.status} and Lithic ` +
      `appended AUTHORIZATION_ADVICE ${lastAdvice.amount} result ${String(lastAdvice.result)} ` +
      `-> CLEARING ${REMAINDER_CENTS} result ${String(clearings[1]?.result)}, settlement now ` +
      `${String(finished.amounts.settlement.amount)}`;

    record(
      "evidence",
      `OVER-CAPTURE IS NOT TERMINAL (measured this run). ${measurement}. Our model over the same events: ` +
        `A=${s1.authorisedCents} C=${s1.capturedCents} H=${s1.holdCents} at the over-capture, then ` +
        `A=${s2.authorisedCents} C=${s2.capturedCents} H=${s2.holdCents} after the incremental — the hold REOPENED ` +
        `for ${REMAINDER_CENTS}, and the network then captured exactly that. A hold_closure row written on C >= A ` +
        `would have freed ${REMAINDER_CENTS} that was still authorised; it is append-only, so it would have to be ` +
        `undone with a hold_closure_reversal (migration 0011). That is why the next test skips.`,
    );
  });

  it("and exactly one hold_closure row records the release", async (ctx) => {
    if (episode === null) {
      const reason = "the episode above did not complete, so there is no hold to look for a closure row on";
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const [closures] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM hold_closure WHERE hold_id = ${episode.holdId}::uuid`;

    if ((closures?.n ?? 0) === 0) {
      // NOT a money error — the release posting above already took the hold's
      // memo balance to zero, and `availableBalance` reads that balance, so the
      // customer's available is exactly right either way.
      //
      // And no longer a disagreement between documents, either. The reason this
      // skip exists is now a measurement, taken on this run by the test above.
      const reason =
        `the hold was released — memo balance 0, available correct, ledger settled ${CAPTURE_CENTS} — but NO hold_closure row was written, and that is a DECISION, not a gap. ` +
        `The row would require closed(E) to gain a "C >= A" arm. MEASURED against the Lithic sandbox on this run: over-capture is NOT terminal. ` +
        `${measurement ?? "(the measurement test above did not complete this run; see docs/HOLDS.md for the recorded run)"}. ` +
        `So after the over-capture the authorisation can still rise, and the hold reopens for the un-captured remainder — ${REMAINDER_CENTS} cents in the measured case, which the network then really captured. ` +
        `hold_closure is append-only with PRIMARY KEY (hold_id) and v_hold_state.is_released reads it, so a closure written at the over-capture would free money that is still authorised until someone appends a hold_closure_reversal. That is the exact $60 failure migration 0011 was written to clean up, and it is not worth a row. ` +
        `The attack's "releases exactly once" is met by the release POSTING, asserted above: two memo entries netting to zero, and no second one is possible. The closure row lands when something terminal happens — is_final, an explicit close, or the seven-day expiry sweeper. docs/HOLDS.md carries the full argument. Hold ${episode.holdId}, transaction ${episode.transactionToken}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    expect(closures?.n).toBe(1);
    record("evidence", `hold_closure rows for hold ${episode.holdId}: ${closures?.n} (exactly one)`);
  });
});
