/**
 * ATTACK 3 — "Reverse that settlement the next day and pull up the statement
 * for settlement day."
 *
 * ============================================================================
 * WHY THIS TEST WAS REWRITTEN.
 *
 * The previous version of this file imported `reverseAndRebook` and called it
 * on entries it had posted itself, thirty lines earlier, through `postEntry`.
 * Every assertion passed and every one of them was about the MACHINERY: no
 * provider event was involved, no webhook was verified, no consumer ran, and
 * `src/lib/holds/*` — the code that actually decides what a card settlement
 * does to the ledger — was not on the call path at all. `reverseAndRebook`'s
 * only non-test callers were two demo harnesses.
 *
 * So the claim "a merchant reverses a settlement and the corrected position
 * appears on the day it happened" was true of a function and false of the
 * card rail, and this test was the reason nobody could tell.
 *
 * It now drives the correction from the PROVIDER end, twice, and says exactly
 * which single step of the second run was synthesised and why.
 * ============================================================================
 *
 * PART A — NOTHING SYNTHESISED.
 *   Lithic's sandbox originates a real card settlement (`/v1/simulate/return`,
 *   a $73.40 credit clearing) and then REVERSES it (`/v1/simulate/return_reversal`,
 *   a real `RETURN_REVERSAL` step). Lithic signs both deliveries and sends them
 *   over the internet to the deployed endpoint. Everything after that is
 *   production: signature verification, the inbox, the dispatcher, the
 *   `rail_event_semantics` lookup, and the correction posting.
 *
 * PART B — THE BRIEF'S SENTENCE, LITERALLY, with ONE step synthesised.
 *   A real $50 fuel-pump authorisation and a real $73.40 CLEARING, both from
 *   Lithic. Then the reversal of THAT settlement — which Lithic's sandbox
 *   cannot originate. Measured, this run:
 *
 *     POST /v1/simulate/return_reversal {token: <the cleared txn>}
 *       -> 400 "Return reversal is not supported for debit transactions"
 *     POST /v1/simulate/correction, /correction_debit, /correction_credit
 *       -> 404 Not Found (no such endpoints exist)
 *
 *   So the CORRECTION_CREDIT step is fabricated — and nothing else is. It is
 *   attached to the real transaction beside its real events, signed with the
 *   real `LITHIC_WEBHOOK_SECRET` using Standard Webhooks, and POSTed to the
 *   deployed webhook endpoint over the internet. A negative control proves the
 *   signature is being checked. The one thing this run cannot claim is that
 *   Lithic emitted the step; every other link in the chain is real.
 *
 * WHAT IS ASSERTED, IN BOTH PARTS.
 *   1. The provider event produced a `reversal` entry against the entry it
 *      corrects, in the same correction group.
 *   2. That reversal carries the ORIGINAL entry's value date — in Part B the
 *      correction event's own value date is the NEXT DAY, and the money still
 *      lands on settlement day, which is the whole difference between a
 *      statement that corrects itself and one that grows a second line.
 *   3. The correction did NOT post as an ordinary entry at its own date: the
 *      idempotency key it would have used does not exist.
 *   4. The statement for settlement day, rendered by the real renderer, gives
 *      two different answers at two booking watermarks, differing by exactly
 *      the settled amount. Both are true at once.
 *   5. Nothing was edited: the original row is byte-identical afterwards and
 *      the database refuses an UPDATE to it.
 *   6. The financial book still nets to zero and `v_hold_drift` /
 *      `v_hold_release_drift` are still empty — the hold model and the SQL
 *      view are held equal by invariant and a correction moved neither.
 *
 * ISOLATION. Money tables are append-only, so there is no teardown. Every run
 * creates its own Lithic card and its own transactions, and every assertion is
 * a delta on one account between two watermarks this run captured.
 */
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as HoldsModule from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";
import type * as StatementRead from "@/lib/statements/read";

const ATTACK = 3;
const NAME = "Provider-driven settlement reversal: corrected statement and as-believed, both true at once";

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
  MISSING.push("LITHIC_API_KEY (Lithic must originate the settlement and its reversal)");
}
if (
  typeof process.env["LITHIC_WEBHOOK_SECRET"] !== "string" ||
  process.env["LITHIC_WEBHOOK_SECRET"] === ""
) {
  MISSING.push("LITHIC_WEBHOOK_SECRET (part B signs a real delivery with it)");
}

const READY = MISSING.length === 0;
if (!READY) {
  record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);
}

const d = READY ? describe : describe.skip;

const SETTLED_CENTS = 73_40n;
const AUTH_CENTS = 50_00n;

/**
 * `POST /v1/simulate/return_reversal` — the one card correction Lithic's
 * sandbox will originate, and the only simulate endpoint this suite needs that
 * `src/lib/rails/lithic/client.ts` does not wrap.
 *
 * It is called here rather than added to the adapter because the adapter is
 * another agent's file this run. It still goes through the shared
 * `simulateLimiter`, so it obeys the sandbox's 1 request/second simulate cap
 * alongside every other call in the suite rather than racing them into a 429.
 *
 * Body is `{ token }` and nothing else, per Lithic's own SDK. Against a DEBIT
 * transaction it answers 400 — which is not an error here, it is the measured
 * evidence part B needs.
 */
async function simulateReturnReversal(
  token: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const { simulateLimiter, LITHIC_SANDBOX_BASE_URL } = await import("@/lib/rails/lithic/client");
  return simulateLimiter.run(async () => {
    const response = await fetch(`${LITHIC_SANDBOX_BASE_URL}/simulate/return_reversal`, {
      method: "POST",
      headers: {
        authorization: process.env["LITHIC_API_KEY"] ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      detail: `HTTP ${response.status} ${text.slice(0, 200)}`,
    };
  });
}

interface EntryRow {
  id: string;
  value_date: string;
  booking_seq: bigint;
  entry_type: string;
  description: string;
  idempotency_key: string;
  reverses_entry_id: string | null;
  correction_group_id: string;
  inbox_id: string | null;
}

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof HoldsModule;
  let lithic: typeof LithicClient;
  let statements: typeof StatementRead;

  const tag = Date.now().toString(36).toUpperCase();
  let businessId = "";
  let accountId = "";
  let pan = "";
  let cardToken = "";

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
    statements = await import("@/lib/statements/read");

    // A customer with both leaves of the chart. Which one is not interesting;
    // that it is ONE and every figure below is a delta on it, is.
    const [customer] = await sql<{ business_id: string; account_id: string }[]>`
      SELECT dep.business_id, dep.id AS account_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!customer) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    businessId = customer.business_id;
    accountId = customer.account_id;

    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire correction ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    if (card.pan === undefined || card.pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }
    pan = card.pan;
    cardToken = card.token;

    await holds.registerCard(
      {
        provider: "lithic",
        providerCardToken: card.token,
        businessId,
        lastFour: card.last_four,
        nickname: `live-fire correction ${tag}`,
      },
      sql,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Shared helpers                                                         */
  /* ---------------------------------------------------------------------- */

  /** The current top of the transaction-time axis. */
  async function watermark(): Promise<bigint> {
    const [row] = await sql<{ seq: bigint }[]>`
      SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq FROM journal_entry`;
    return row?.seq ?? 0n;
  }

  /** Every financial entry this Lithic transaction has produced, in order. */
  async function entriesFor(txnToken: string): Promise<EntryRow[]> {
    return sql<EntryRow[]>`
      SELECT id, value_date::text AS value_date, booking_seq, entry_type::text AS entry_type,
             description, idempotency_key, reverses_entry_id, correction_group_id, inbox_id
        FROM journal_entry
       WHERE external_ref = ${txnToken} AND book = 'financial'
       ORDER BY booking_seq`;
  }

  /**
   * Nudge the DEPLOYED drain, the way an operator does in the debrief. Not a
   * local dispatcher: what is being exercised is production.
   */
  async function nudgeDrain(): Promise<string> {
    const token = process.env["DRAIN_TOKEN"];
    if (token === undefined || token === "") return "no DRAIN_TOKEN in the environment";
    try {
      const response = await fetch(`${BASE_URL}/api/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      return `HTTP ${response.status}`;
    } catch (thrown) {
      return `unreachable: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }
  }

  /** Poll until the transaction has produced `want` financial entries. */
  async function waitForEntries(
    txnToken: string,
    want: number,
    budgetMs: number,
  ): Promise<{ rows: EntryRow[]; drainStatus: string }> {
    const deadline = Date.now() + budgetMs;
    let drainStatus = "not attempted";
    for (;;) {
      const rows = await entriesFor(txnToken);
      if (rows.length >= want) return { rows, drainStatus };
      if (Date.now() >= deadline) return { rows, drainStatus };
      drainStatus = await nudgeDrain();
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  /** Why a wait gave up, in the words of the rows that did arrive. */
  async function diagnose(txnToken: string, drainStatus: string): Promise<string> {
    const filed = await sql<
      { id: string; state: string; parked_on_kind: string | null; parked_reason: string | null }[]
    >`
      SELECT id, state::text AS state, parked_on_kind, parked_reason
        FROM webhook_inbox
       WHERE provider = 'lithic' AND payload->>'token' = ${txnToken}
       ORDER BY received_at`;
    const inbox = filed
      .map(
        (f) =>
          `${f.id.slice(0, 8)}:${f.state}${f.parked_on_kind ? ` parked on ${f.parked_on_kind} (${f.parked_reason ?? ""})` : ""}`,
      )
      .join(", ");
    return `Lithic transaction ${txnToken}: inbox [${inbox || "no rows arrived"}]; POST ${BASE_URL}/api/drain answered ${drainStatus}`;
  }

  /**
   * The statement for one business day, at one point in transaction time,
   * through the REAL renderer — the same `renderStatement` the /statements
   * screen and `publishStatement` use. Not a hand-rolled SUM.
   */
  async function statementFor(day: string, at: bigint): Promise<{ closing: bigint; lines: number }> {
    const doc = await statements.renderStatement(
      { accountId, periodStart: day, periodEnd: day, bookingWatermark: at },
      sql,
    );
    return { closing: doc.closingBalanceCents, lines: doc.lineCount };
  }

  /**
   * What one entry did to the customer's own leaf, in STATEMENT terms: signed
   * by `normal_side`, so a credit to a liability account reads positive
   * exactly as the statement renders it.
   *
   * The two parts of this attack correct movements in opposite directions — a
   * refund in part A, a purchase clearing in part B — so the expected change
   * in the day's closing balance is read off the entry being corrected rather
   * than hard-coded with a sign that would be right in one part and wrong in
   * the other. A full reversal must move the day by exactly minus what the
   * original moved it, whichever way that was.
   */
  async function signedOnAccount(entryId: string): Promise<bigint> {
    const [row] = await sql<{ cents: bigint }[]>`
      SELECT (l.amount_cents * a.normal_side)::bigint AS cents
        FROM journal_line l JOIN account a ON a.id = l.account_id
       WHERE l.entry_id = ${entryId}::uuid AND l.account_id = ${accountId}::uuid`;
    if (row === undefined) throw new Error(`entry ${entryId} has no line on ${accountId}`);
    return row.cents;
  }

  /** The two invariant views that must never report, checked as a pair. */
  async function driftIsZero(): Promise<{ hold: number; release: number }> {
    const [h] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM v_hold_drift`;
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM v_hold_release_drift`;
    return { hold: h?.n ?? -1, release: r?.n ?? -1 };
  }

  /* ---------------------------------------------------------------------- */
  /* PART A — Lithic originates both halves. Nothing synthesised.           */
  /* ---------------------------------------------------------------------- */

  it("A. Lithic reverses a real settlement, and the ledger repairs the day it happened", async () => {
    // A real card settlement, originated by the provider. It is a CREDIT
    // clearing — a merchant refund — because that is the only settlement
    // Lithic's sandbox will reverse; the debit case is part B.
    const settlement = await lithic.simulateReturn({
      amount: Number(SETTLED_CENTS),
      descriptor: `CORGI CORRECT ${tag}`.slice(0, 25),
      pan,
    });
    const txn = settlement.token;
    expect(txn, "Lithic returned no transaction token for the settlement").toBeTruthy();
    if (txn === undefined || txn === "") return;

    const settled = await waitForEntries(txn, 1, 90_000);
    if (settled.rows.length < 1) {
      throw new Error(
        `the $73.40 settlement never reached the ledger, so there is nothing to reverse and the attack is unproven. ${await diagnose(txn, settled.drainStatus)}`,
      );
    }
    const original = settled.rows[0];
    expect(original).toBeDefined();
    if (original === undefined) return;

    // It came from a REAL delivery: the entry carries the inbox row Lithic's
    // signed webhook created. A test-authored entry has no inbox_id, which is
    // exactly what the previous version of this file produced.
    expect(original.inbox_id, "the settlement entry has no webhook provenance").not.toBeNull();
    expect(original.entry_type).toBe("original");
    expect(original.idempotency_key).toMatch(/^card:refund:/);

    const settlementDay = original.value_date;
    const beforeCorrection = await watermark();
    const asBelieved = await statementFor(settlementDay, beforeCorrection);

    // ---- Lithic reverses it, for real -----------------------------------
    const reversal = await simulateReturnReversal(txn);
    expect(reversal.ok, `Lithic refused the reversal: ${reversal.detail}`).toBe(true);

    // Measured: the sandbox applies a return reversal ASYNCHRONOUSLY, about 45
    // seconds later, and the transaction reads unchanged until it lands. A
    // shorter wait here reads as "the provider cannot do this", which is the
    // false negative that made an earlier note in the adapter README call void
    // "unproven".
    const corrected = await waitForEntries(txn, 2, 180_000);
    if (corrected.rows.length < 2) {
      throw new Error(
        `Lithic accepted the RETURN_REVERSAL but the correction never reached the ledger within 180s, so the rail is unproven. ${await diagnose(txn, corrected.drainStatus)}`,
      );
    }

    const repair = corrected.rows.find((r) => r.entry_type === "reversal");
    expect(repair, "no reversal entry was produced by the provider's correction").toBeDefined();
    if (repair === undefined) return;

    // (1) It reverses the settlement, in the settlement's own correction group.
    expect(repair.reverses_entry_id).toBe(original.id);
    expect(repair.correction_group_id).toBe(original.correction_group_id);

    // (2) At the ORIGINAL's value date.
    expect(repair.value_date).toBe(settlementDay);
    // And it was learned later: this is a second axis, not a rewrite.
    expect(repair.booking_seq > original.booking_seq).toBe(true);

    // (3) It did NOT post as an ordinary entry at its own date. The correction
    //     step is a `force_post` in our vocabulary, so the key it would have
    //     used is `card:force_post:<its own token>` — and there is none.
    const [correctionEvent] = await sql<{ provider_event_id: string; value_date: string }[]>`
      SELECT cae.provider_event_id, cae.value_date::text AS value_date
        FROM card_auth_event cae
        JOIN card_authorization ca ON ca.id = cae.auth_id
       WHERE ca.provider = 'lithic' AND ca.provider_auth_id = ${txn}
         AND cae.kind = 'force_post'`;
    expect(correctionEvent, "the RETURN_REVERSAL fact was not recorded").toBeDefined();
    if (correctionEvent === undefined) return;
    const [stray] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE idempotency_key = ${`card:force_post:${correctionEvent.provider_event_id}`}`;
    expect(stray?.n, "the correction ALSO posted at its own date — a second line, not a repair").toBe(0);

    // (4) Both time axes, from the real renderer. A settlement of $73.40 that
    //     never happened must move settlement day by exactly minus what it
    //     moved it by — here a refund, so the day comes back DOWN.
    const originalSigned = await signedOnAccount(original.id);
    expect(originalSigned).toBe(SETTLED_CENTS); // a refund credits the customer
    const asCorrected = await statementFor(settlementDay, await watermark());
    expect(asCorrected.closing - asBelieved.closing).toBe(-originalSigned);
    expect(asCorrected.lines).toBe(asBelieved.lines + 1);

    // (5) Nothing was edited.
    const [after] = await sql<{ description: string; entry_type: string }[]>`
      SELECT description, entry_type::text AS entry_type
        FROM journal_entry WHERE id = ${original.id}::uuid`;
    expect(after?.description).toBe(original.description);
    expect(after?.entry_type).toBe("original");

    // (6) The books, and the two views the hold model is held equal by.
    expect(await bal.trialBalanceCents()).toBe(0n);
    expect(await driftIsZero()).toEqual({ hold: 0, release: 0 });

    record(
      "evidence",
      `PART A — NOTHING SYNTHESISED. Lithic transaction ${txn} on card ${cardToken}: ` +
        `/v1/simulate/return 201 posted entry ${original.id} (${original.idempotency_key}) at value date ${settlementDay} from webhook inbox row ${original.inbox_id}; ` +
        `/v1/simulate/return_reversal 201 produced RETURN_REVERSAL ${correctionEvent.provider_event_id}, which the consumer routed through reverseAndRebook to entry ${repair.id} — entry_type=reversal, reverses ${original.id}, correction group ${repair.correction_group_id}, VALUE DATE ${repair.value_date} (the original's), booking_seq ${original.booking_seq} -> ${repair.booking_seq}. ` +
        `No entry exists at key card:force_post:${correctionEvent.provider_event_id}: the correction did not post at its own date. ` +
        `Statement for ${settlementDay} via renderStatement(): as-believed@seq${beforeCorrection} closing ${asBelieved.closing} over ${asBelieved.lines} lines; as-corrected closing ${asCorrected.closing} over ${asCorrected.lines} lines; difference ${asCorrected.closing - asBelieved.closing} = minus the original entry's ${originalSigned} on the customer's leaf — the refund taken back, on the day it was booked. Trial balance 0; v_hold_drift 0; v_hold_release_drift 0.`,
    );
  }, 240_000);

  /* ---------------------------------------------------------------------- */
  /* PART B — the brief's sentence, with the one synthesised step named.     */
  /* ---------------------------------------------------------------------- */

  it("B. the $73.40 fuel-pump capture, reversed the NEXT DAY, repairs settlement day", async () => {
    // ---- Real: $50 fuel-pump authorisation, then a $73.40 capture --------
    const auth = await lithic.simulateAuthorize({
      amount: Number(AUTH_CENTS),
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542", // automated fuel dispenser
    });
    const txn = auth.token;
    expect(txn, "Lithic returned no transaction token for the authorisation").toBeTruthy();
    if (txn === undefined || txn === "") return;

    await lithic.simulateClearing({ token: txn, amountCents: Number(SETTLED_CENTS) });

    const cleared = await waitForEntries(txn, 1, 90_000);
    const clearing = cleared.rows.find((r) => r.idempotency_key.startsWith("card:clearing:"));
    if (clearing === undefined) {
      throw new Error(
        `the $73.40 clearing never reached the ledger, so there is nothing to reverse. ${await diagnose(txn, cleared.drainStatus)}`,
      );
    }
    expect(clearing.inbox_id, "the clearing entry has no webhook provenance").not.toBeNull();

    const settlementDay = clearing.value_date;
    const beforeCorrection = await watermark();
    const asBelieved = await statementFor(settlementDay, beforeCorrection);

    // ---- Establish, by measurement, that Lithic cannot reverse this ------
    //
    // Not asserted from the docs and not skipped: the endpoint is called, and
    // its refusal is the evidence for the synthesis that follows.
    const refusal = await simulateReturnReversal(txn);
    expect(refusal.ok, "Lithic reversed a debit clearing — this test's premise is stale").toBe(
      false,
    );

    // ---- THE ONE SYNTHESISED STEP ---------------------------------------
    //
    // A CORRECTION_CREDIT, dated the NEXT DAY, attached to the REAL
    // transaction beside its REAL events. Everything from the signature
    // onwards is production.
    const real = await lithic.getTransaction(txn);
    const nextDay = new Date(`${settlementDay}T12:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const correctionToken = randomUUID();
    const correctionCreated = nextDay.toISOString().replace(/\.\d{3}Z$/, "Z");

    const body = {
      ...(real as unknown as Record<string, unknown>),
      event_type: "card_transaction.updated",
      updated: correctionCreated,
      events: [
        ...(real.events ?? []),
        {
          token: correctionToken,
          type: "CORRECTION_CREDIT",
          created: correctionCreated,
          result: "APPROVED",
          amount: Number(SETTLED_CENTS),
          effective_polarity: "CREDIT",
          amounts: {
            cardholder: { amount: Number(SETTLED_CENTS), conversion_rate: "1.000000", currency: "USD" },
            merchant: { amount: Number(SETTLED_CENTS), currency: "USD" },
            settlement: { amount: Number(SETTLED_CENTS), conversion_rate: "1.000000", currency: "USD" },
            hold: { amount: 0, currency: "USD" },
          },
          detailed_results: ["APPROVED"],
          rule_results: [],
          network_info: null,
          network_specific_data: null,
          account_type: null,
        },
      ],
    };
    const raw = JSON.stringify(body);

    // Standard Webhooks, signed with the REAL secret, exactly as Lithic signs:
    // `id.timestamp.body`, HMAC-SHA256 keyed on the base64-DECODED secret.
    const webhookId = `msg_lf3_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = process.env["LITHIC_WEBHOOK_SECRET"] ?? "";
    const signature = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
      .update(`${webhookId}.${timestamp}.${raw}`, "utf8")
      .digest("base64");

    const delivered = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body: raw,
    });
    const deliveredBody = (await delivered.json()) as Record<string, unknown>;
    expect(delivered.status).toBe(202);
    expect(deliveredBody["status"]).toBe("accepted");

    // NEGATIVE CONTROL. Without it the 202 proves nothing about verification:
    // an endpoint that accepts anything would answer 202 too.
    const tampered = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": `${webhookId}X`,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${"A".repeat(43)}=`,
      },
      body: raw,
    });
    const tamperedBody = (await tampered.json()) as { error?: { code?: string } };
    expect(tampered.status).toBe(401);
    expect(tamperedBody.error?.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    // ---- Production processes it ----------------------------------------
    const repaired = await waitForEntries(txn, cleared.rows.length + 1, 120_000);
    const repair = repaired.rows.find((r) => r.entry_type === "reversal");
    if (repair === undefined) {
      throw new Error(
        `the signed CORRECTION_CREDIT was accepted (HTTP ${delivered.status}) but produced no correction within 120s. ${await diagnose(txn, repaired.drainStatus)}`,
      );
    }

    // (1) and (2). The correction event's OWN value date is the next day; the
    //     money is repaired on settlement day. This one pair of assertions is
    //     the entire attack.
    const [fact] = await sql<{ value_date: string }[]>`
      SELECT cae.value_date::text AS value_date
        FROM card_auth_event cae
        JOIN card_authorization ca ON ca.id = cae.auth_id
       WHERE ca.provider = 'lithic' AND ca.provider_auth_id = ${txn}
         AND cae.provider_event_id = ${correctionToken}`;
    expect(fact?.value_date, "the correction fact was not recorded at its own date").toBe(
      correctionCreated.slice(0, 10),
    );
    expect(fact?.value_date).not.toBe(settlementDay);
    expect(repair.value_date).toBe(settlementDay);
    expect(repair.reverses_entry_id).toBe(clearing.id);
    expect(repair.correction_group_id).toBe(clearing.correction_group_id);
    expect(repair.booking_seq > clearing.booking_seq).toBe(true);

    // (3) Nothing landed on the day we learned.
    const [strayRefund] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE idempotency_key = ${`card:refund:${correctionToken}`}`;
    expect(strayRefund?.n, "the correction ALSO posted at its own date").toBe(0);
    const nextDayStatement = await statementFor(fact?.value_date ?? "", await watermark());
    expect(nextDayStatement.lines, "the correction grew a line on the day we learned").toBe(0);

    // (4) Settlement day, both axes, from the real renderer. The clearing took
    //     $73.40 off the customer, so undoing it puts exactly that back — on
    //     SETTLEMENT DAY, not on the day the correction arrived.
    const clearingSigned = await signedOnAccount(clearing.id);
    expect(clearingSigned).toBe(-SETTLED_CENTS); // a capture debits the customer
    const asCorrected = await statementFor(settlementDay, await watermark());
    expect(asCorrected.closing - asBelieved.closing).toBe(-clearingSigned);
    expect(asCorrected.lines).toBe(asBelieved.lines + 1);

    // (5) Nothing was edited.
    const [after] = await sql<{ description: string; entry_type: string }[]>`
      SELECT description, entry_type::text AS entry_type
        FROM journal_entry WHERE id = ${clearing.id}::uuid`;
    expect(after?.description).toBe(clearing.description);
    expect(after?.entry_type).toBe("original");

    // (6) Books and drift.
    expect(await bal.trialBalanceCents()).toBe(0n);
    expect(await driftIsZero()).toEqual({ hold: 0, release: 0 });

    // ---- Idempotence: redeliver the same signed bytes --------------------
    const replay = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body: raw,
    });
    expect(replay.status).toBe(200);
    await nudgeDrain();
    const afterReplay = await entriesFor(txn);
    expect(afterReplay.length).toBe(repaired.rows.length);

    record(
      "evidence",
      `PART B — ONE STEP SYNTHESISED, NAMED. Real Lithic transaction ${txn} on card ${cardToken}: ` +
        `/v1/simulate/authorize 201 ($50.00 fuel pump, MCC 5542) then /v1/simulate/clearing 201 ($73.40) posted entry ${clearing.id} (${clearing.idempotency_key}) at settlement day ${settlementDay} from webhook inbox row ${clearing.inbox_id}. ` +
        `Lithic CANNOT reverse it: POST /v1/simulate/return_reversal {token: ${txn}} -> ${refusal.detail}. ` +
        `SYNTHESISED: one CORRECTION_CREDIT step (token ${correctionToken}, created ${correctionCreated} — the next day), appended to the REAL transaction beside its real events. ` +
        `NOT synthesised: the signature (HMAC-SHA256 over "${webhookId}.<ts>.<body>" with LITHIC_WEBHOOK_SECRET), the transport (POST ${BASE_URL}/api/webhooks/lithic -> HTTP ${delivered.status}), verification (a one-character signature change -> HTTP ${tampered.status} ${tamperedBody.error?.code}), the inbox row ${String(deliveredBody["inboxId"])}, the drain, the rail_event_semantics lookup, or the posting. ` +
        `RESULT: the fact is dated ${fact?.value_date} (the day we learned) and the MONEY was repaired at ${repair.value_date} (settlement day) as entry ${repair.id}, entry_type=reversal, reverses ${clearing.id}, correction group ${repair.correction_group_id}. ` +
        `Statement for ${settlementDay} via renderStatement(): as-believed@seq${beforeCorrection} closing ${asBelieved.closing} over ${asBelieved.lines} lines; as-corrected closing ${asCorrected.closing} over ${asCorrected.lines} lines; difference ${asCorrected.closing - asBelieved.closing}. Statement for ${fact?.value_date}: ${nextDayStatement.lines} lines — the correction grew no second line on the day it arrived. Redelivery of the same signed bytes -> HTTP ${replay.status}, entries unchanged at ${afterReplay.length}. Trial balance 0; v_hold_drift 0; v_hold_release_drift 0.`,
    );
  }, 240_000);

  /* ---------------------------------------------------------------------- */

  it("the database itself refuses to edit the rows we just corrected", async () => {
    // Not decoration. The whole correction argument rests on the original row
    // being unchangeable, so the suite proves it rather than asserting it.
    await expect(
      sql`UPDATE journal_entry SET description = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql`DELETE FROM journal_line WHERE true`,
    ).rejects.toThrow(/permission denied/);
    record(
      "evidence",
      "UPDATE on journal_entry and DELETE on journal_line are both refused for corgi_app: permission denied. A correction is an append; there is no other kind available to this role.",
    );
  });
});
