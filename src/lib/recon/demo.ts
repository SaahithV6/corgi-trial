/**
 * Seed the reconciliation demo against the real book.
 *
 * This is a FIXTURE GENERATOR, not part of the reconciliation. It exists so
 * the screen and the report have real rows behind them — real journal entries
 * posted through `ledger_append`, a real settlement file rendered from the ACH
 * simulator's own trace numbers, a real day close — rather than a hand-written
 * table of numbers that proves nothing.
 *
 * ---------------------------------------------------------------------------
 * IT IS IDEMPOTENT, AND ONLY BY THE MEANS THE LEDGER ALREADY HAS
 * ---------------------------------------------------------------------------
 *
 * Every posting's idempotency key is derived from the business date and the
 * simulator's trace number, so running this twice on the same day replays into
 * `ledger_append` and writes nothing. Every file is rendered from a PRNG seeded
 * by its own business date, so the same day produces the same bytes, the same
 * sha256, and an import that reports `imported: false`. There is no
 * `DELETE FROM` anywhere here and there could not be: the money tables refuse
 * it, which is the point of the whole schema.
 *
 * Run it on a later day and it seeds that day, which is what a nightly job
 * does. It never rewrites yesterday.
 *
 * ---------------------------------------------------------------------------
 * THE SCENARIO
 * ---------------------------------------------------------------------------
 *
 * Three files, chosen so the aging ladder is visible rather than described:
 *
 *   today       fresh    0 closes crossed -> `open`
 *   today - 1   aged     1 close  crossed -> `aged`
 *   today - 45  old     45 closes crossed -> `stale` / `critical`
 *
 * and, inside the middle file, one of each break category plus the edge case:
 *
 *   a settled transfer we never booked          -> in_file_not_ledger
 *   an entry the provider's file omits          -> in_ledger_not_file
 *   a capture booked at the authorised amount   -> amount_mismatch
 *   the same, then reversed and re-booked       -> amount_mismatch, EXPLAINED
 *   five lines no parser should accept          -> scheme_file_reject
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry, reverseAndRebook } from "@/lib/ledger/post";
import { createAchRail, hours, type AchSimTransferRecord } from "@/lib/rails/achsim";
import { SEC_CODE_BY_AUTHORIZATION } from "@/lib/rails/increase/client";

import { importSchemeFile } from "./ingest";
import { renderSchemeFile, type RenderRow } from "./parse";
import { runReconciliation } from "./run";
import {
  malformedLines,
  referenceOf,
  settlementRowsFrom,
  signedCentsOf,
  spliceLines,
} from "./simulate";

/** How many days of book_day rows to lay down behind today. */
const CLOSED_DAYS = 46;

/**
 * The scenario's namespace.
 *
 * It is in every idempotency key, every synthetic reference and the
 * simulator's seed, so one scenario's rows can never be mistaken for another's.
 *
 * BUMP IT WHENEVER THE SCENARIO CHANGES. The money tables are append-only —
 * there is no DELETE and there must not be — so an earlier version of this
 * seed has left entries on the book that cannot be removed. Reusing its keys
 * would make `ledger_append` replay them and hand back yesterday's amounts for
 * today's story, which is precisely the failure this seed exists to
 * demonstrate rather than to commit. The stranded rows do not become noise:
 * `carryForwardRows` puts them on the file, where they belong.
 */
const DEMO_SCENARIO = "s2";

export interface ReconDemoFile {
  readonly label: string;
  readonly fileId: string;
  readonly filename: string;
  readonly businessDate: string;
  readonly imported: boolean;
  readonly sha256: string;
  readonly rowCount: number;
  readonly rejectedCount: number;
  readonly runIds: readonly string[];
}

export interface ReconDemoResult {
  readonly today: string;
  readonly files: readonly ReconDemoFile[];
  readonly plantedRefs: {
    readonly inFileNotLedger: string;
    readonly inLedgerNotFile: string;
    readonly amountMismatch: string;
    readonly explainedMismatch: string;
  };
}

interface Refs {
  entityId: string;
  actorId: string;
  depositAccountId: string;
  achReceivableId: string;
  achPayableId: string;
}

/** `YYYY-MM-DD` in the book timezone. Never `new Date().toISOString()`. */
const BOOK_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function bookToday(now: Date = new Date()): string {
  return BOOK_DATE.format(now);
}

/** Calendar arithmetic on a `YYYY-MM-DD`, done in UTC so no zone can shift it. */
export function shiftDate(date: string, deltaDays: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + deltaDays);
  const iso = at.toISOString();
  return iso.slice(0, 10);
}

export async function seedReconDemo(conn: Sql = sql): Promise<ReconDemoResult> {
  const refs = await loadRefs(conn);
  const today = bookToday();

  const dates = {
    // The rich file is TODAY's, because that is what the screen opens on and
    // the planted breaks have to be the first thing anybody sees.
    tonight: today,
    yesterday: shiftDate(today, -1),
    old: shiftDate(today, -45),
  };

  // ---- 1. tonight's file: every category, including the edge case --------
  const tonight = simulateDay(dates.tonight, 9);
  const tonightRefs = tonight.map(referenceOf);

  // Chosen by position so they are stable for a given business date.
  const planted = {
    // Settled, on the file, never booked.
    inFileNotLedger: tonightRefs[2] ?? "",
    // Booked, deliberately absent from the file.
    inLedgerNotFile: `ACH-LEDGER-ONLY-${DEMO_SCENARIO}-${compact(dates.tonight)}`,
    // Booked at the authorised amount, settled for more.
    amountMismatch: tonightRefs[5] ?? "",
    // The same, then corrected by reversal plus re-book.
    explainedMismatch: tonightRefs[7] ?? "",
  };

  for (const record of tonight) {
    const ref = referenceOf(record);
    if (ref === planted.inFileNotLedger) continue; // the webhook that never came

    if (ref === planted.amountMismatch) {
      // A partial capture booked at the amount we authorised. The file
      // settles for $18.40 more; we booked the round number.
      await postSettlement(conn, refs, dates.tonight, ref, signedCentsOf(record) - 1840n,
        "ACH settlement (booked at the authorised amount)");
      continue;
    }

    if (ref === planted.explainedMismatch) {
      const wrong = signedCentsOf(record) + 5000n;
      const entryId = await postSettlement(conn, refs, dates.tonight, ref, wrong,
        "ACH settlement (amount taken from the wrong field)");
      // ...and the correction, which is what makes this the EDGE case: the
      // break is real and recorded, and the book already answers it.
      await correctSettlement(conn, refs, dates.tonight, ref, entryId, signedCentsOf(record));
      continue;
    }

    await postSettlement(conn, refs, dates.tonight, ref, signedCentsOf(record), "ACH settlement");
  }

  // The entry the provider's file omits. Booked from a webhook that arrived;
  // the ODFI's file for the same day does not carry it.
  await postSettlement(conn, refs, dates.tonight, planted.inLedgerNotFile, 21_450n,
    "ACH settlement notified by webhook, absent from the ODFI file");

  // ---- 2. yesterday: one break, one close behind it ----------------------
  const yesterday = simulateDay(dates.yesterday, 3);
  for (const record of yesterday.slice(0, 2)) {
    await postSettlement(conn, refs, dates.yesterday, referenceOf(record), signedCentsOf(record),
      "ACH settlement");
  }
  const yesterdayAdjudicated = `ACH-TIMING-${DEMO_SCENARIO}-${compact(dates.yesterday)}`;
  await postSettlement(conn, refs, dates.yesterday, yesterdayAdjudicated, 33_300n,
    "ACH settlement booked ahead of the file cutoff");

  // ---- 3. the old file: one large break nobody has cleared ---------------
  const old = simulateDay(dates.old, 3);
  for (const record of old.slice(0, 2)) {
    await postSettlement(conn, refs, dates.old, referenceOf(record), signedCentsOf(record),
      "ACH settlement");
  }
  const oldTail = old[2];
  if (oldTail === undefined) throw new Error("the simulator produced fewer transfers than asked for");
  const oldUnbooked = referenceOf(oldTail);
  // A material one, so the top of the ladder is a real number and not a
  // rounding error somebody can ignore for another six weeks.
  await postSettlement(conn, refs, dates.old, `ACH-LEDGER-ONLY-${DEMO_SCENARIO}-${compact(dates.old)}`, 1_284_500n,
    "ACH settlement notified by webhook, absent from the ODFI file");

  // ---- 4. close the days behind us --------------------------------------
  // Aging is a fact about day closes, so the demo has to actually close days.
  await closeDays(conn, refs, today, CLOSED_DAYS);

  // ---- 5. import and reconcile ------------------------------------------
  const files: ReconDemoFile[] = [];

  files.push(
    await importAndRun(conn, refs, {
      label: "tonight · every category",
      businessDate: dates.tonight,
      rows: settlementRowsFrom(tonight, { businessDate: dates.tonight }),
      plantedLedgerOnly: [planted.inLedgerNotFile],
      malformed: malformedLines(dates.tonight),
      // Twice: the second run proves a re-run appends a NEW run and mutates
      // nothing, which is requirement 5 shown rather than claimed.
      runs: 2,
    }),
  );

  files.push(
    await importAndRun(conn, refs, {
      label: "yesterday · one close behind",
      businessDate: dates.yesterday,
      rows: settlementRowsFrom(yesterday, { businessDate: dates.yesterday }),
      plantedLedgerOnly: [yesterdayAdjudicated],
      malformed: [],
      runs: 1,
    }),
  );

  files.push(
    await importAndRun(conn, refs, {
      label: "old · forty-five closes ago",
      businessDate: dates.old,
      rows: settlementRowsFrom(old, { businessDate: dates.old }),
      plantedLedgerOnly: [`ACH-LEDGER-ONLY-${DEMO_SCENARIO}-${compact(dates.old)}`],
      malformed: [],
      runs: 1,
    }),
  );

  // ---- 6. adjudication, so the notes path has real rows -----------------
  await adjudicate(conn, refs, oldUnbooked, null,
    "Chased the ODFI; the trace number is not on their side either. Escalated to the sponsor bank.");
  await adjudicate(conn, refs, yesterdayAdjudicated, "accepted_timing",
    "Booked from the webhook before the file cutoff. It will be on tomorrow's file; no action.");

  return { today, files, plantedRefs: planted };
}

/* -------------------------------------------------------------------------- */
/* The simulator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Run the ACH simulator for one business day and hand back its settled
 * transfers.
 *
 * The engine's epoch is moved to 09:00 ET on the business date, so the
 * settlements land on that date rather than on the simulator's own default
 * epoch, and the seed is the date itself, so two different days cannot mint
 * the same trace numbers.
 */
function simulateDay(businessDate: string, count: number): readonly AchSimTransferRecord[] {
  const { engine } = createAchRail({
    force: "simulator",
    seed: `recon-demo-${DEMO_SCENARIO}-${businessDate}`,
  });
  if (engine === null) throw new Error("createAchRail did not return the simulator engine");

  // 09:00 ET. Written as an explicit offset rather than a local Date so the
  // machine's own timezone cannot move the business day.
  engine.reset(new Date(`${businessDate}T13:00:00.000Z`).getTime());

  for (let i = 0; i < count; i += 1) {
    engine.create({
      clientReferenceId: `recon-demo-${businessDate}-${i}`,
      sourceAccountId: "acct_sim_fbo",
      // Alternating, so the file carries both signs and the sign convention is
      // exercised in both directions rather than assumed.
      direction: i % 3 === 0 ? "credit" : "debit",
      amount: { amount: BigInt(4_000 + i * 3_137), currency: "USD" },
      statementDescriptor: `CORGI ${String(i + 1).padStart(3, "0")}`,
      destination: {
        type: "ach",
        routingNumber: "021000021",
        accountNumber: `00012345${i}`,
        holderName: "Counterparty LLC",
        authorization: "business_agreement",
      },
      // Imported from the live adapter rather than re-typed, exactly as
      // AchSimRail does, so the simulator cannot drift from what it simulates.
      secCode: SEC_CODE_BY_AUTHORIZATION.business_agreement,
      // Submitted at once, settled two hours later: same business day.
      scenario: { submitAfterMs: 0, settleAfterMs: hours(2) },
    });
  }

  // Past settlement but short of a day, so nothing rolls into tomorrow.
  engine.advance(hours(6));
  return engine.list();
}

/** `2026-09-08` -> `20260908`. Used inside references, never as a date. */
function compact(date: string): string {
  return date.replaceAll("-", "");
}

/* -------------------------------------------------------------------------- */
/* Postings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One ACH settlement, booked the way DESIGN.md §14's table says.
 *
 *   inbound  (amount > 0)  DR 1130 ACH receivable   CR 2100 customer deposits
 *   outbound (amount < 0)  DR 2100 customer deposits CR 2300 ACH payable
 *
 * The rail-facing leg is what reconciliation compares against, and its signed
 * sum is exactly `amountCents` in both directions — which is why the file's
 * sign convention and the ledger's need no translation anywhere.
 */
async function postSettlement(
  conn: Sql,
  refs: Refs,
  valueDate: string,
  externalRef: string,
  amountCents: bigint,
  description: string,
): Promise<string> {
  const inbound = amountCents > 0n;
  const magnitude = inbound ? amountCents : -amountCents;

  return postEntry(
    {
      entityId: refs.entityId,
      valueDate,
      book: "financial",
      description,
      idempotencyKey: `ach:settled:${DEMO_SCENARIO}:${valueDate}:${externalRef}`,
      actorId: refs.actorId,
      rail: "ach",
      externalRef,
      lines: inbound
        ? [
            { accountId: refs.achReceivableId, amountCents: magnitude },
            { accountId: refs.depositAccountId, amountCents: -magnitude },
          ]
        : [
            { accountId: refs.depositAccountId, amountCents: magnitude },
            { accountId: refs.achPayableId, amountCents: -magnitude },
          ],
    },
    conn,
  );
}

/**
 * Reverse a settlement and re-book it at the right number.
 *
 * Never an edit. The reversal carries the ORIGINAL's value date (enforced by
 * `assert_reversal_is_exact` in 0001) and the re-book joins the same
 * correction group, so `v_recon_break.ledger_net_cents` picks up the corrected
 * position while `recon_match.ledger_amount_cents` still records what we
 * booked when the file was produced. Both facts survive, which is what makes
 * the break legible instead of merely gone.
 */
async function correctSettlement(
  conn: Sql,
  refs: Refs,
  valueDate: string,
  externalRef: string,
  originalEntryId: string,
  correctedCents: bigint,
): Promise<void> {
  const inbound = correctedCents > 0n;
  const magnitude = inbound ? correctedCents : -correctedCents;

  await reverseAndRebook(
    {
      originalEntryId,
      reason: "settled amount taken from the wrong field on the provider payload",
      actorId: refs.actorId,
      rebook: {
        valueDate,
        book: "financial",
        description: "ACH settlement, re-booked at the settled amount",
        idempotencyKey: `ach:rebook:${DEMO_SCENARIO}:${valueDate}:${externalRef}`,
        rail: "ach",
        externalRef,
        lines: inbound
          ? [
              { accountId: refs.achReceivableId, amountCents: magnitude },
              { accountId: refs.depositAccountId, amountCents: -magnitude },
            ]
          : [
              { accountId: refs.depositAccountId, amountCents: magnitude },
              { accountId: refs.achPayableId, amountCents: -magnitude },
            ],
      },
    },
    conn,
  );
}

/* -------------------------------------------------------------------------- */
/* Day close                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Close the days behind today.
 *
 * `book_day` is append-only, so this is `ON CONFLICT DO NOTHING` and a day
 * that is already closed stays closed at the watermark it was closed at.
 * Closing does not block later postings with that value date (DESIGN.md §13);
 * they simply land above the watermark and show up in `v_late_postings`.
 */
async function closeDays(conn: Sql, refs: Refs, today: string, count: number): Promise<void> {
  const dates = Array.from({ length: count }, (_, i) => shiftDate(today, -(i + 1)));
  await conn`
    INSERT INTO book_day (entity_id, business_date, booking_watermark, closed_by)
    SELECT ${refs.entityId}::uuid,
           d::date,
           (SELECT COALESCE(MAX(booking_seq), 0) FROM journal_entry),
           ${refs.actorId}::uuid
      FROM unnest(${dates}::text[]) AS d
    ON CONFLICT DO NOTHING`;
}

/* -------------------------------------------------------------------------- */
/* Import, run, adjudicate                                                    */
/* -------------------------------------------------------------------------- */

/**
 * File rows for ACH references already on the book for this date that this
 * scenario did not put there.
 *
 * The book is append-only, so an earlier run of this seed — or the
 * planted-break test, or anything else that posted on this rail — has left
 * settlements behind that tonight's simulated file knows nothing about. They
 * would every one of them surface as an in-ledger-not-file break and bury the
 * four this demo is actually trying to show.
 *
 * Carrying them forward is not a fudge: those settlements really did happen,
 * so a real ODFI file for that date really would have carried them. The
 * exclusion list is the point — the references this scenario books DELIBERATELY
 * without a file row stay out, so the planted break survives the tidying.
 */
async function carryForwardRows(
  conn: Sql,
  businessDate: string,
  exclude: readonly string[],
): Promise<readonly RenderRow[]> {
  const rows = await conn<{ external_ref: string; booked_cents: bigint }[]>`
    WITH entry_rail AS (
      SELECT e.id,
             e.external_ref,
             e.correction_group_id,
             e.booking_seq,
             SUM(l.amount_cents)::bigint AS rail_cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN account       a ON a.id = l.account_id AND a.rail_control = 'ach'
       WHERE e.rail       = 'ach'
         AND e.value_date = ${businessDate}::date
         AND e.book       = 'financial'
         AND e.external_ref IS NOT NULL
         AND NOT (e.external_ref = ANY(${[...exclude]}::text[]))
       GROUP BY e.id
    ),
    grouped AS (
      SELECT external_ref,
             MIN(booking_seq)                                      AS anchor_seq,
             -- The ANCHOR's amount, not the group's net. The diff pairs a file
             -- row against what we booked FIRST, so a carried-forward row
             -- carrying the net would show up as an amount mismatch against a
             -- correction group -- inventing exactly the break this function
             -- exists to stop inventing.
             (ARRAY_AGG(rail_cents ORDER BY booking_seq))[1]       AS booked_cents,
             SUM(rail_cents)::bigint                               AS net_cents
        FROM entry_rail
       GROUP BY external_ref, correction_group_id
    )
    SELECT DISTINCT ON (external_ref) external_ref, booked_cents
      FROM grouped
     -- A correction group that nets to zero was booked and un-booked; a file
     -- row for nothing is not a thing a provider would send.
     WHERE net_cents <> 0
     ORDER BY external_ref, anchor_seq`;

  return rows.map((r) => ({
    externalRef: r.external_ref,
    amountCents: r.booked_cents,
    valueDate: businessDate,
    descriptor: "CARRIED FORWARD",
  }));
}

async function importAndRun(
  conn: Sql,
  refs: Refs,
  spec: {
    label: string;
    businessDate: string;
    rows: readonly RenderRow[];
    /** References this scenario books ON PURPOSE without a file row. */
    plantedLedgerOnly: readonly string[];
    malformed: readonly string[];
    runs: number;
  },
): Promise<ReconDemoFile> {
  const carried = await carryForwardRows(conn, spec.businessDate, [
    ...spec.rows.map((r) => r.externalRef),
    ...spec.plantedLedgerOnly,
  ]);

  const body = renderSchemeFile(
    { provider: "achsim", rail: "ach", businessDate: spec.businessDate },
    [...spec.rows, ...carried],
  );
  const content = spliceLines(body, spec.malformed);
  const filename = `achsim-settlement-${spec.businessDate}.csv`;

  const imported = await importSchemeFile(
    { filename, content, importedBy: refs.actorId },
    conn,
  );

  const runIds: string[] = [];
  for (let i = 0; i < spec.runs; i += 1) {
    const run = await runReconciliation(
      { fileId: imported.fileId, actorId: refs.actorId },
      conn,
    );
    runIds.push(run.runId);
  }

  return {
    label: spec.label,
    fileId: imported.fileId,
    filename,
    businessDate: spec.businessDate,
    imported: imported.imported,
    sha256: imported.sha256,
    rowCount: imported.rowCount,
    rejectedCount: imported.rejectedCount,
    runIds,
  };
}

/**
 * Attach a note to whatever break currently carries a reference.
 *
 * Keyed by looking the break up in `v_recon_break`, because `break_key` is the
 * file row / entry / match id and only the view knows which. Guarded on the
 * note text so re-seeding does not stack duplicates: `recon_break_note` is
 * append-only and there is no way to take one back.
 */
async function adjudicate(
  conn: Sql,
  refs: Refs,
  externalRef: string,
  resolution: string | null,
  note: string,
): Promise<void> {
  await conn`
    INSERT INTO recon_break_note (break_kind, break_key, note, resolution, created_by)
    SELECT b.break_kind, b.break_key, ${note}, ${resolution}, ${refs.actorId}::uuid
      FROM v_recon_break b
     WHERE b.external_ref = ${externalRef}
       AND NOT EXISTS (
             SELECT 1 FROM recon_break_note n
              WHERE n.break_kind = b.break_kind
                AND n.break_key  = b.break_key
                AND n.note       = ${note})
     LIMIT 1`;
}

/* -------------------------------------------------------------------------- */
/* Reference data                                                             */
/* -------------------------------------------------------------------------- */

async function loadRefs(conn: Sql): Promise<Refs> {
  const [entity] = await conn<{ id: string }[]>`SELECT id FROM book_entity ORDER BY code LIMIT 1`;
  const [actor] = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' ORDER BY display_name LIMIT 1`;
  const [deposit] = await conn<{ id: string }[]>`
    SELECT id FROM account
     WHERE code = '2100' AND business_id IS NOT NULL AND is_postable
     ORDER BY name LIMIT 1`;
  const [receivable] = await conn<{ id: string }[]>`
    SELECT id FROM account WHERE code = '1130' AND business_id IS NULL LIMIT 1`;
  const [payable] = await conn<{ id: string }[]>`
    SELECT id FROM account WHERE code = '2300' AND business_id IS NULL LIMIT 1`;

  if (!entity || !actor || !deposit || !receivable || !payable) {
    throw new Error("reconciliation demo needs the seeded chart of accounts: node scripts/seed.mjs");
  }
  return {
    entityId: entity.id,
    actorId: actor.id,
    depositAccountId: deposit.id,
    achReceivableId: receivable.id,
    achPayableId: payable.id,
  };
}
