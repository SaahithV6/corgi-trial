/**
 * ATTACK 6 — "Delete one row from tonight's scheme file and ask the breaks
 * screen where it went. Assert an in_ledger_not_file break with the right
 * reference and amount."
 *
 * Run in full against the LIVE database:
 *
 *   1. book four settlements for a synthetic business date, each carrying its
 *      own provider reference;
 *   2. import last night's file, which contains all four, and reconcile it —
 *      NONE of those four references may appear as a break. Without this step
 *      the next one proves nothing: a system that reported every entry as a
 *      break would also "find" the deleted row;
 *   3. delete exactly one row, import that file, reconcile it, and ask the
 *      screen where the row went.
 *
 * The assertion is BY REFERENCE and BY AMOUNT, on the frozen run snapshot
 * (`recon_run_break`), not on a count of a shared table — money tables are
 * append-only and there is no teardown, so every run picks its own business
 * date and its own reference prefix.
 *
 * The screen is read through `loadReconView()`, the same entry point
 * `/reconciliation` renders, so this asserts what an operator would actually
 * see rather than what a view happens to contain.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type { postEntry as PostEntry } from "@/lib/ledger/post";
import type * as IngestModule from "@/lib/recon/ingest";
import type { renderSchemeFile as RenderSchemeFile, RenderRow } from "@/lib/recon/parse";
import type * as RunModule from "@/lib/recon/run";
import type * as ScreenModule from "@/lib/recon/screen";
import type { ReconBreak } from "@/lib/recon/types";

const ATTACK = 6;
const NAME = "A row deleted from tonight's scheme file surfaces as in_ledger_not_file";

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

const READY =
  process.env["LIVEFIRE"] === "1" && typeof process.env["APP_DATABASE_URL"] === "string";

if (!READY) {
  record("skip", "LIVEFIRE=1 and APP_DATABASE_URL are required; run scripts/livefire.mjs");
}

const d = READY ? describe : describe.skip;

/** `today + n` days, in UTC so no zone can shift it. */
function daysFromToday(offset: number): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + offset);
  return at.toISOString().slice(0, 10);
}

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let postEntry: typeof PostEntry;
  let importSchemeFile: typeof IngestModule.importSchemeFile;
  let renderSchemeFile: typeof RenderSchemeFile;
  let runReconciliation: typeof RunModule.runReconciliation;
  let readRunBreaks: typeof RunModule.readRunBreaks;
  let loadReconView: typeof ScreenModule.loadReconView;

  let entityId = "";
  let actorId = "";
  let depositAccountId = "";
  let achReceivableId = "";

  const stamp = Date.now();
  const tag = stamp.toString(36).toUpperCase();
  /**
   * A FORWARD-DATED business day, unique to this run, and both halves of that
   * are deliberate.
   *
   * Unique, because money tables are append-only and there is no teardown: no
   * other file, run or journal entry shares this date, so `v_recon_break` sees
   * exactly the four settlements this test booked and nothing else, and this
   * run leaves no break on any real business day.
   *
   * Forward-dated, because the breaks screen's entry point orders runs by
   * business date first ("the most recent run" means last night's FILE, not
   * whichever file somebody re-ran most recently — `v_recon_run_history`), so a
   * run dated in 2002 is unreachable from the screen however recent it is. A
   * forward-dated file is a case the aging ladder already supports explicitly
   * (a warehoused ACH effective date; see `ageBucketOf`).
   */
  const businessDate = daysFromToday(365 + (stamp % 90));

  /** Last night's file: four inbound ACH settlements, all of them booked. */
  const fullFile: readonly RenderRow[] = [1, 2, 3, 4].map((n) => ({
    externalRef: `LF6-${tag}-${n}`,
    amountCents: BigInt(20_000 + n * 1_357),
    valueDate: businessDate,
    descriptor: `LIVEFIRE SETTLE ${n}`,
  }));

  /** Row 3 is the one the graders delete. */
  const DELETED_INDEX = 2;
  const deleted = fullFile[DELETED_INDEX] as RenderRow;
  const tonightFile = fullFile.filter((_row, i) => i !== DELETED_INDEX);

  let deletedEntryId = "";
  let tonightRunId = "";

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    ({ postEntry } = await import("@/lib/ledger/post"));
    ({ importSchemeFile } = await import("@/lib/recon/ingest"));
    ({ renderSchemeFile } = await import("@/lib/recon/parse"));
    ({ runReconciliation, readRunBreaks } = await import("@/lib/recon/run"));
    ({ loadReconView } = await import("@/lib/recon/screen"));

    const [entity] = await sql<{ id: string }[]>`SELECT id FROM book_entity LIMIT 1`;
    const [actor] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'human' AND can_approve = true LIMIT 1`;
    const [deposit] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2100' AND business_id IS NOT NULL LIMIT 1`;
    const [receivable] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '1130' AND business_id IS NULL LIMIT 1`;
    if (!entity || !actor || !deposit || !receivable) {
      throw new Error("the live database is not seeded: run node scripts/seed.mjs");
    }
    entityId = entity.id;
    actorId = actor.id;
    depositAccountId = deposit.id;
    achReceivableId = receivable.id;
  });

  /** An inbound ACH settlement: DR 1130 receivable, CR the customer's 2100. */
  async function book(row: RenderRow): Promise<string> {
    return postEntry({
      entityId,
      valueDate: businessDate,
      book: "financial",
      description: `Live-fire settlement ${row.externalRef}`,
      idempotencyKey: `livefire:${tag}:${row.externalRef}`,
      actorId,
      rail: "ach",
      externalRef: row.externalRef,
      lines: [
        { accountId: achReceivableId, amountCents: row.amountCents },
        { accountId: depositAccountId, amountCents: -row.amountCents },
      ],
    });
  }

  async function ingestAndRun(
    filename: string,
    rows: readonly RenderRow[],
  ): Promise<{ runId: string; breaks: readonly ReconBreak[] }> {
    const content = renderSchemeFile(
      { provider: "achsim", rail: "ach", businessDate },
      rows,
    );
    const file = await importSchemeFile({ filename, content, importedBy: actorId }, sql);
    expect(file.imported).toBe(true);
    const run = await runReconciliation({ fileId: file.fileId, actorId }, sql);
    return { runId: run.runId, breaks: run.breaks };
  }

  it("last night's complete file reconciles clean — the control", async () => {
    for (const row of fullFile) {
      const entryId = await book(row);
      if (row.externalRef === deleted.externalRef) deletedEntryId = entryId;
    }
    expect(deletedEntryId).toBeTruthy();

    const { breaks } = await ingestAndRun(`livefire-${tag}-lastnight.csv`, fullFile);
    const mine = breaks.filter((b) => b.externalRef.startsWith(`LF6-${tag}-`));
    expect(mine).toEqual([]);

    record(
      "evidence",
      `control run over the complete file (${fullFile.length} rows, business date ${businessDate}): 0 breaks carrying the LF6-${tag}- prefix`,
    );
  });

  it("tonight's file is missing one row, and the screen says which one", async () => {
    const { runId, breaks } = await ingestAndRun(
      `livefire-${tag}-tonight.csv`,
      tonightFile,
    );
    tonightRunId = runId;

    const mine = breaks.filter((b) => b.externalRef.startsWith(`LF6-${tag}-`));
    expect(mine).toHaveLength(1);

    const found = mine[0] as ReconBreak;
    expect(found.kind).toBe("in_ledger_not_file");
    expect(found.externalRef).toBe(deleted.externalRef);
    // Signed on the file's axis: the file is short by exactly what we booked.
    expect(found.breakAmountCents).toBe(deleted.amountCents);
    expect(found.ledgerNetCents).toBe(deleted.amountCents);
    expect(found.fileAmountCents).toBeNull();
    expect(found.entryId).toBe(deletedEntryId);
    expect(found.valueDate).toBe(businessDate);

    record(
      "evidence",
      `break ${found.kind} / ${found.reasonCode}: ref ${found.externalRef}, amount ${found.breakAmountCents} cents, entry ${found.entryId}, value date ${found.valueDate}, severity ${found.severity}`,
    );
  });

  it("the frozen run snapshot says the same thing, and so does the breaks screen", async () => {
    // The run snapshot is the historical record; it must not be recomputed.
    const frozen = await readRunBreaks(tonightRunId, sql);
    const mine = frozen.filter((b) => b.externalRef === deleted.externalRef);
    expect(mine).toHaveLength(1);
    expect((mine[0] as ReconBreak).kind).toBe("in_ledger_not_file");
    expect((mine[0] as ReconBreak).breakAmountCents).toBe(deleted.amountCents);

    // And the screen an operator actually looks at.
    const view = await loadReconView({ runId: tonightRunId });
    expect(view.ok).toBe(true);
    if (!view.ok) throw new Error(`the breaks screen failed to load: ${view.error.message}`);
    expect(view.value.run?.runId).toBe(tonightRunId);
    const onScreen = view.value.breaks.filter((b) => b.externalRef === deleted.externalRef);
    expect(onScreen).toHaveLength(1);
    const row = onScreen[0];
    if (row === undefined) throw new Error("unreachable");
    expect(row.kind).toBe("in_ledger_not_file");
    expect(row.breakAmountCents).toBe(Number(deleted.amountCents));

    record(
      "evidence",
      `recon_run_break for run ${tonightRunId} and loadReconView() both carry ref ${deleted.externalRef} as in_ledger_not_file`,
    );
  });
});
