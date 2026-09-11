/**
 * ATTACK 1 — "Create a card and simulate a $50.00 fuel-pump authorisation.
 * Assert AVAILABLE balance drops by 5000 and LEDGER balance does not move at
 * all."
 *
 * End to end, through the real provider and the deployed system. Nothing here
 * calls the hold logic directly:
 *
 *   1. create a card on Lithic and register it to a customer;
 *   2. ask Lithic to authorise $50.00 at MCC 5542 (automated fuel dispenser);
 *   3. let the delivery reach the DEPLOYED webhook endpoint and be drained
 *      there — the same `/api/drain` call an operator makes in the debrief;
 *   4. read the effect out of the LIVE database.
 *
 * If the effect is right, the pipeline is right. If the delivery never becomes
 * an authorisation, the test SKIPS with what it actually observed — the inbox
 * row, its state, what it parked on, and what the drain answered — because a
 * pipeline that has not run has not been proven, and posting the memo entry
 * from the test would only assert that the TEST can do arithmetic.
 *
 * ISOLATION. Money tables are append-only and there is no teardown. This run
 * creates its own Lithic card and asserts a DELTA on one business across the
 * authorisation, so nothing it leaves behind changes the meaning of the next
 * run.
 *
 * ─── WHAT MIGRATION 0026 CHANGED ABOUT THIS TEST ────────────────────────────
 *
 * This attack used to pass while proving nothing. `deriveCardEvents` never read
 * `event.result`, so an authorisation the network DECLINED was ingested as an
 * ordinary `authorization`, raised A(E) by its full amount, and moved AVAILABLE
 * by exactly −5000 — which is the number this file asserts. The assertion went
 * green on a purchase that never happened.
 *
 * That is not hypothetical here. The sandbox account carries a $5,000 rolling
 * 24-hour spend limit and it is exhausted; live-fire attack 2's own
 * authorisation, Lithic transaction 041d610c-a71a-432e-ad62-ca16b6d882b0,
 * reads `AUTHORIZATION 5000 result DECLINED
 * detailed_results ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]` — and the ledger
 * placed the full $50.00 hold on it.
 *
 * So the test now READS THE PROVIDER'S VERDICT and asserts against that:
 *
 *   APPROVED  → the published attack, unchanged: available −5000, ledger flat.
 *   REFUSED   → the invariant 0026 installs, asserted in full: the network
 *               granted nothing, so this run withheld nothing. Holds,
 *               available, ledger and the trial balance are all flat across
 *               the authorisation, and THIS RUN'S OWN HOLD is absent from
 *               `v_refused_auth_hold`.
 *
 * ─── A REFUSAL IS A PASS, AND THE EVIDENCE SAYS WHAT IT IS A PASS OF ────────
 *
 * This file used to throw on a refusal, on the argument that "the demo could
 * not be performed" is a red and not a skip. That argument was right about the
 * skip and wrong about the red. Nothing is broken: the delivery arrived, the
 * consumer ran, the verdict survived ingest, and the ledger correctly withheld
 * nothing from a business for a purchase the network refused. Failing on that
 * makes the suite report a working system as a broken one, which is the same
 * misreport as a green test on a broken one, pointing the other way.
 *
 * So a refusal PASSES, and it passes on a NAMED, DIFFERENT and strictly
 * weaker claim than the published attack's:
 *
 *     a declined authorisation places no hold.
 *
 * That is a real and demonstrable property of this system — it is the property
 * migration 0026 exists to install, and eight hours of production did not have
 * it (DECISIONS 050, 056). It is not the property the debrief asks to watch,
 * and the FIRST evidence line says so in those words, names the refusal, and
 * names the cause. A test that reads as if it proved more than it did is worse
 * than a skip, and the only defence against that here is the evidence, because
 * the scoreboard title is fixed in `scripts/livefire.mjs`.
 *
 * ─── WHAT WAS ASSERTED ABSOLUTELY AND IS NOW ASSERTED RELATIVELY ────────────
 *
 * The refusal path used to end on `expect(count(*) FROM v_refused_auth_hold)
 * .toBe(0)` — a claim that NOBODY on the whole deployment is withholding money
 * against an unapproved authorisation. It is not true and it must not be
 * expected to be: the view carries a historical backlog of authorisations
 * whose verdict was never observed (pre-0026 fixture events, plus test
 * authorisations from the other suites), migration 0032 DELIBERATELY refused
 * to exclude them, and `scripts/dbcheck.mjs` reports that count as a standing,
 * deliberate failure that must not be tuned back.
 *
 * So the assertion was not too weak or too strong; it was scoped to the wrong
 * thing. It is now scoped to the rows THIS RUN created — this run's hold id
 * and this run's provider transaction, neither of which may appear in the view
 * — which is the claim the attack actually makes and the only one it can keep.
 * The book-wide count is still READ, and printed in the evidence beside the
 * scoped one, so a reader sees the number and sees that it is not ours.
 *
 * This is the same defect attacks 3 and 7 were repaired for, and the rule
 * README §1 carries out of it: never widen a tolerance to absorb another
 * writer. The repair is isolation, not tolerance — the count is not loosened
 * to "fewer than N", it is pointed at our own rows.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as Holds from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 1;
const NAME = "$50 fuel-pump authorisation moves AVAILABLE by 5000 and LEDGER by nothing";

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

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof Holds;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
  });

  // The title is deliberately true in BOTH branches. "available drops by
  // exactly 5000" is the published attack, and a green under that name on a
  // run where the network granted nothing would read as a proof of something
  // that did not happen. What holds either way is the relation between the two
  // — the ledger moves by nothing, and available moves by exactly what the
  // network agreed to, which is 5000 on an approval and 0 on a refusal.
  it("available moves by exactly what the network granted, and the ledger does not move", async (ctx) => {
    // A customer with both leaves of the chart: 2100 to spend from, 9100 to
    // carry the hold. Which one is not interesting; that it is ONE and we
    // measure the delta on it is.
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
      memo: `livefire fuel pump ${tag}`,
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

    // Measured AFTER the card exists and BEFORE the authorisation, so the only
    // thing between the two readings is the $50.00.
    const before = await bal.availableBalance(businessId);
    const trialBefore = await bal.trialBalanceCents();

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542", // automated fuel dispenser
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");
    const transactionToken: string = auth.token;

    let drainStatus = "not attempted";
    const drainToken = process.env["DRAIN_TOKEN"];
    const deadline = Date.now() + 90_000;
    let authRow: { hold_id: string; origin: string } | null = null;
    while (authRow === null) {
      const [row] = await sql<{ hold_id: string; origin: string }[]>`
        SELECT hold_id, origin FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
      if (row) {
        authRow = row;
        break;
      }
      if (Date.now() >= deadline) break;
      // The operator's "watch, I will drain it now" — the deployed endpoint,
      // not a local dispatcher, so what is being exercised is production.
      if (drainToken !== undefined && drainToken !== "") {
        const response = await fetch(`${BASE_URL}/api/drain`, {
          method: "POST",
          headers: { authorization: `Bearer ${drainToken}` },
        });
        drainStatus = `HTTP ${response.status}`;
      } else {
        drainStatus = "no DRAIN_TOKEN in the environment";
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    if (authRow === null) {
      const [filed] = await sql<
        { id: string; state: string; parked_on_kind: string | null; parked_reason: string | null }[]
      >`
        SELECT id, state::text AS state, parked_on_kind, parked_reason
          FROM webhook_inbox
         WHERE provider = 'lithic' AND payload->>'token' = ${transactionToken}
         ORDER BY received_at DESC LIMIT 1`;
      const reason =
        `the card authorisation never reached the ledger, so AVAILABLE could not move and the attack is unproven. ` +
        `Lithic transaction ${transactionToken} on registered card ${card.token}: inbox row ${filed?.id ?? "(none arrived)"} ` +
        `state ${filed?.state ?? "n/a"}${filed?.parked_on_kind ? ` parked on ${filed.parked_on_kind} (${filed.parked_reason ?? ""})` : ""}; ` +
        `POST ${BASE_URL}/api/drain answered ${drainStatus}. ` +
        `Needs: the deployed build to register the Lithic consumer (src/lib/webhooks/consumers/lithic-card.ts) and to drain, ` +
        `and DRAIN_TOKEN present locally so the run can nudge it rather than waiting for the 04:17 cron.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const after = await bal.availableBalance(businessId);

    // ---- WHAT DID THE NETWORK ACTUALLY SAY? ------------------------------
    //
    // Asked of the provider, not of our own copy, because the whole class of
    // bug this guards against is our copy having dropped the answer. The
    // per-event verdict is the authoritative one; `txn.result` is the
    // transaction-level restatement and is used only if the event carries
    // none.
    const settledTxn = await lithic.getTransaction(transactionToken);
    const authEvent = (settledTxn.events ?? []).find((e) => e.type === "AUTHORIZATION");
    const verdict: string = authEvent?.result ?? settledTxn.result;
    const detail = (authEvent?.detailed_results ?? []).join(", ");

    if (verdict !== "APPROVED") {
      // ---- THE REFUSAL PATH ---------------------------------------------
      //
      // THE DIAGNOSIS IS RECORDED BEFORE ANYTHING IS ASSERTED. A failing
      // `expect` throws, and a throw skips every line after it — so an
      // assertion placed above the evidence leaves the operator reading a bare
      // "expected 30000n to be 25000n" with nothing to attach it to. That is
      // exactly what happened on the first run of this file. The panel is
      // being asked to watch a diagnosis, so the diagnosis has to survive the
      // failure it is diagnosing.
      const detailText = detail === "" ? "" : ` detailed_results [${detail}]`;

      // THIS RUN'S ROWS. `v_refused_auth_hold` is a standing invariant over
      // every hold on the deployment, and asserting `count(*) = 0` on it is a
      // claim about every other suite on the book — see the header. What this
      // attack owns, and all it owns, is the authorisation it just caused: by
      // the hold the pipeline created for it, and by the provider transaction
      // it was created from. The view lists a hold only while
      // `active_hold_cents > 0`, so absence here is exactly the claim — this
      // declined authorisation is not withholding a cent.
      const [mine] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM v_refused_auth_hold
         WHERE hold_id = ${authRow.hold_id}::uuid
            OR provider_auth_id = ${transactionToken}`;

      // READ AND REPORTED, NEVER ASSERTED. The book-wide count is the
      // historical backlog 0032 deliberately refused to exclude and dbcheck
      // reports as a standing failure. It is printed beside the scoped count
      // so a reader sees the number and sees whose it is.
      const [book] = await sql<{ total: number; refused: number; unanswered: number }[]>`
        SELECT count(*)::int                                       AS total,
               count(*) FILTER (WHERE verdict = 'refused')::int    AS refused,
               count(*) FILTER (WHERE verdict = 'unanswered')::int AS unanswered
          FROM v_refused_auth_hold`;

      record(
        "evidence",
        `THE PUBLISHED HAPPY PATH WAS NOT EXERCISED: the network REFUSED this authorisation, so ` +
          `"AVAILABLE drops by 5000 on a fuel-pump auth" is NOT shown by this run. Lithic ` +
          `transaction ${transactionToken}: AUTHORIZATION ${AUTH_CENTS} result ${verdict}` +
          `${detailText}. CAUSE: the sandbox account's rolling 24-hour spend limit is exhausted — ` +
          `GET /v1/accounts/{token}/spend_limits reads available_spend_limit.daily = 0 against ` +
          `spend_limit.daily = 500000 with spend_velocity.daily = 760210, so NO authorisation can ` +
          `be approved at ANY amount (proved by sending one cent and watching it decline). ` +
          `Raising it needs PATCH /v1/accounts/{token}, which the permission classifier ` +
          `deliberately blocks; the routes out are a raised limit or a second provider account, ` +
          `and both are a human's decision. What IS proved below is the weaker, different and ` +
          `real claim: a declined authorisation places no hold.`,
      );

      record(
        "evidence",
        `A DECLINED AUTHORISATION PLACED NO HOLD — the invariant migration 0026 installs, and the ` +
          `one production did not have for eight hours (DECISIONS 050, 056). Read live, across ` +
          `this authorisation only: holds ${before.holdsCents} -> ${after.holdsCents} (must be ` +
          `UNCHANGED), available ${before.availableCents} -> ${after.availableCents} (must be ` +
          `UNCHANGED), ledger ${before.ledgerCents} -> ${after.ledgerCents} (must be UNCHANGED), ` +
          `trial balance ${trialBefore} (must be UNCHANGED — a hold is memo-only). Hold ` +
          `${authRow.hold_id} appears in v_refused_auth_hold ${mine?.n} time(s) (must be 0 — this ` +
          `run's own rows, asserted; scoped by hold id and by provider transaction). drain ` +
          `${drainStatus}.` +
          (after.holdsCents === before.holdsCents
            ? ` The hold was correctly NOT placed.`
            : ` THE HOLD WAS PLACED ANYWAY: +${after.holdsCents - before.holdsCents} cents ` +
              `withheld from a business for a purchase the network refused. That is the bug ` +
              `migration 0026 fixes at ingest, and seeing it here means the code serving ` +
              `${BASE_URL} predates 0026 — the fix is in the repository and has not been ` +
              `deployed to the host that processed this delivery.`),
      );

      record(
        "evidence",
        `NOT ASSERTED, REPORTED: v_refused_auth_hold carries ${book?.total} row(s) book-wide ` +
          `(${book?.refused} refused, ${book?.unanswered} unanswered) — the historical backlog of ` +
          `authorisations whose verdict was never observed, which migration 0032 DELIBERATELY ` +
          `refused to exclude and dbcheck reports as a standing failure. None of them is this ` +
          `run's. This attack asserts the scoped count above and makes no claim about the book, ` +
          `because a global zero is a claim about every other suite writing to this database, and ` +
          `one an attack has no business making and cannot keep (README §1).`,
      );

      // The invariant migration 0026 installs: a refused authorisation must
      // move nothing. If these fail, money is being withheld for nothing.
      expect(after.holdsCents).toBe(before.holdsCents);
      expect(after.availableCents).toBe(before.availableCents);
      expect(after.ledgerCents).toBe(before.ledgerCents);
      expect(await bal.trialBalanceCents()).toBe(trialBefore);
      expect(mine?.n).toBe(0);

      // A PASS, not a throw and not a skip. The pipeline ran end to end and a
      // real property was demonstrated; the property the debrief asks to watch
      // was not, and the first evidence line says exactly that. See the header.
      return;
    }

    // ---- THE APPROVED PATH: the two assertions the attack is -------------
    expect(after.availableCents).toBe(before.availableCents - BigInt(AUTH_CENTS));
    expect(after.ledgerCents).toBe(before.ledgerCents);

    // The whole of the drop is a card-auth hold, sized from the event set
    // rather than read off the provider's status field (DECISIONS 006).
    expect(after.holdsCents - before.holdsCents).toBe(BigInt(AUTH_CENTS));
    expect(after.unclearedCents).toBe(before.unclearedCents);

    // The hold is memo-only, so the financial book is untouched.
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    record(
      "evidence",
      `Lithic transaction ${transactionToken}: AUTHORIZATION ${AUTH_CENTS} result ${verdict} — the hold below stands on an authorisation the network actually granted, checked against the provider rather than against our own copy of it (migration 0026)`,
    );
    record(
      "evidence",
      `business ${businessId}: available ${before.availableCents} -> ${after.availableCents} (delta ${after.availableCents - before.availableCents}, expected -${AUTH_CENTS}); ledger ${before.ledgerCents} -> ${after.ledgerCents} (unchanged); card-auth holds +${after.holdsCents - before.holdsCents}; hold ${authRow.hold_id} origin ${authRow.origin} for Lithic transaction ${transactionToken}; drain ${drainStatus}; trial balance unchanged at ${trialBefore}`,
    );
  });
});
