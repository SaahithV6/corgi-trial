"use server";

/**
 * The reconciliation screen's write path — the only surface from which a
 * reconciliation can be RUN.
 *
 * ============================================================================
 * WHY THIS EXISTS
 *
 * Every other half of this feature was reachable from `/reconciliation`: the
 * breaks, the age buckets, the rejects, the run history, the drill-through to
 * the journal entry. Running one was not. It lived in `scripts/` and in the
 * tests, which means the screen could show an operator a stale answer and give
 * them no way to ask for a fresh one — "re-run it after the correction posts"
 * was advice that required a terminal.
 *
 * ============================================================================
 * WHAT THESE ACTIONS DO AND DO NOT DO
 *
 * They do not move money and they do not touch the ledger. There is no
 * `postEntry()` and no journal table on this path: a reconciliation READS the
 * book and writes its findings beside it. What they append is
 *
 *   - `scheme_file` + `scheme_file_row` + `scheme_file_reject`, on import, and
 *     only when the file's sha256 is not already on record; and
 *   - `recon_run` + `recon_run_break`, on every run, always.
 *
 * NOTHING IS EVER UPDATED. A re-run is `run_no` N+1 with its own frozen break
 * rows; run N still says exactly what it said, because "was that break open
 * when we closed Tuesday" is asked weeks later about a break that was fixed
 * within the hour.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT
 *
 * The same three consequences `/team` and `/accounts` honour:
 *
 *   - EVERY FIELD IS A CLAIM. `fileId` is a reference and nothing else; the
 *     file's identity, provider, rail and business date are re-read inside
 *     `runReconciliation()` from `scheme_file`, never taken from the form.
 *   - EVERY RUN REQUIRES A RESOLVABLE ACTOR. `recon_run.run_by` is NOT NULL and
 *     it is the answer to "who asked for this number", so an anonymous POST
 *     cannot produce a run.
 *   - THE FILE IS NOT TRUSTED. `parseSchemeFile()` reads it before a connection
 *     is opened; a file that is not a settlement file at all is refused having
 *     written nothing.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rootLogger } from "@/lib/log";
// `parse.ts` is pure — no `server-only`, no database handle — so it is safe at
// module scope. Everything else on this path is not: see the block below.
import { SchemeFileFormatError } from "@/lib/recon/parse";

// Type-only, and therefore erased: naming these here costs the module graph
// nothing, and it keeps `import()` out of a type position.
import type { currentActor as CurrentActor } from "@/lib/approvals/session";
import type {
  importSchemeFile as ImportSchemeFile,
  ImportSchemeFileResult,
} from "@/lib/recon/ingest";
import type {
  runReconciliation as RunReconciliation,
  RunReconciliationResult,
} from "@/lib/recon/run";

// Not from this module: a `"use server"` file exports only server references,
// so a client importing `RECON_RUN_IDLE` from here would receive a stub.
import type { ReconRunFact, ReconRunResult } from "@/components/recon/run-action-result";

import { assertOperatorAction } from "@/lib/authz/action-guard";

/**
 * The largest settlement file this form accepts, in bytes.
 *
 * A nightly file for this book is a few kilobytes. The cap exists so that a
 * mis-drop — a database dump, a video — is refused by a sentence rather than by
 * a parse that reads it all into memory first.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The three functions that reach a database, imported ONLY inside a handler.
 *
 * NOT AT MODULE SCOPE, AND THIS IS THE SAME TRAP `/reconciliation/page.tsx`
 * documents at `selectSource()`. `@/lib/recon/ingest`, `@/lib/recon/run` and
 * `@/lib/approvals/session` each reach `@/lib/ledger/db` -> `@/lib/env`, which
 * parses `process.env` at module scope and THROWS when `APP_DATABASE_URL` is
 * absent — on purpose, so a malformed URL kills the boot rather than the first
 * request that needs money.
 *
 * This module is imported by `RunControls.tsx`, which the breaks screen renders.
 * A static import here would therefore put `@/lib/env` into the page's module
 * graph, and the one screen that must be able to render the words "no database
 * configured" would throw while loading instead of saying them. The panel is
 * hidden on that deployment anyway (`runnable` is false), but "hidden" is a
 * render-time decision and a module graph is evaluated before any of it runs.
 *
 * Deferring costs one dynamic import on a path that is about to open a
 * connection regardless.
 */
async function connected(): Promise<{
  readonly currentActor: typeof CurrentActor;
  readonly importSchemeFile: typeof ImportSchemeFile;
  readonly runReconciliation: typeof RunReconciliation;
}> {
  const [session, ingest, run] = await Promise.all([
    import("@/lib/approvals/session"),
    import("@/lib/recon/ingest"),
    import("@/lib/recon/run"),
  ]);
  return {
    currentActor: session.currentActor,
    importSchemeFile: ingest.importSchemeFile,
    runReconciliation: run.runReconciliation,
  };
}

function fail(code: string, message: string, facts: readonly ReconRunFact[] = []): ReconRunResult {
  return { status: "failed", code, message, facts, href: null, at: new Date().toISOString() };
}

async function actorId(currentActor: typeof CurrentActor): Promise<string | null> {
  const session = await currentActor();
  return session?.id ?? null;
}

/** The message an operator can act on, from whatever was thrown. */
function reason(thrown: unknown): string {
  if (thrown instanceof SchemeFileFormatError) return thrown.message;
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}

/**
 * Reconcile a file already on record, again.
 *
 * The ordinary operator gesture: a break was investigated, the correcting
 * entry was posted, and the question is whether the file matches the book NOW.
 * The answer is a new run at a later booking watermark, not an edit to the old
 * one.
 */
const rerunSchema = z.object({
  fileId: z.uuid({ error: "that is not a settlement file id" }),
});

export async function rerunReconciliationAction(
  _previous: ReconRunResult,
  formData: FormData,
): Promise<ReconRunResult> {
  await assertOperatorAction("rerunReconciliationAction");

  const parsed = rerunSchema.safeParse({ fileId: formData.get("fileId") });
  if (!parsed.success) {
    return fail(
      "INVALID_REQUEST",
      "That request did not name a settlement file, so nothing was run. Reload /reconciliation and press the button again; the file id comes from the run on screen.",
    );
  }

  const { currentActor, runReconciliation } = await connected();
  const actor = await actorId(currentActor);
  if (actor === null) {
    return fail(
      "NO_ACTOR",
      "No actor could be resolved for this session, so there is nobody to record as having asked for this run and nothing was run. A run is signed: recon_run.run_by is NOT NULL. Pick an actor on /approvals and try again.",
    );
  }

  try {
    const run = await runReconciliation({ fileId: parsed.data.fileId, actorId: actor });
    rootLogger.info("recon.run_from_screen", {
      fileId: parsed.data.fileId,
      runId: run.runId,
      runNo: run.runNo,
      breaks: run.breaks.length,
    });
    revalidatePath("/reconciliation");
    return receipt(run, "the file already on record");
  } catch (thrown) {
    rootLogger.error("recon.run_from_screen_failed", {
      fileId: parsed.data.fileId,
      reason: reason(thrown),
    });
    return fail(
      "RECON_RUN_FAILED",
      `The run did not finish, so no recon_run row was written and the run history is unchanged — the whole run is one transaction. The database said: ${reason(thrown)}. Nothing about the book changed; a reconciliation only reads it. Press the button again, and if it fails the same way take the message to whoever owns the settlement tables.`,
      [{ label: "File", value: parsed.data.fileId, mono: true }],
    );
  }
}

/**
 * Import a settlement file and reconcile it in one press.
 *
 * Two appends, in this order and not the other: the file is on record BEFORE
 * anything is matched against it, so a run can always name the exact bytes it
 * judged. Re-uploading the same file does not duplicate it — `scheme_file` is
 * unique on sha256 and the importer says `imported: false` — but it DOES run
 * again, which is the point: same file, later book, possibly a different
 * answer.
 */
export async function importAndRunAction(
  _previous: ReconRunResult,
  formData: FormData,
): Promise<ReconRunResult> {
  await assertOperatorAction("importAndRunAction");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail(
      "NO_FILE",
      "No file was attached, so nothing was imported and nothing was run. Choose a settlement file with the file picker above and press the button again.",
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return fail(
      "FILE_TOO_LARGE",
      `That file is ${file.size} bytes and this form accepts ${MAX_FILE_BYTES}. Nothing was imported. A nightly settlement file for this book is a few kilobytes, so a file this size is almost certainly not one — check what you picked.`,
    );
  }

  const { currentActor, importSchemeFile, runReconciliation } = await connected();
  const actor = await actorId(currentActor);
  if (actor === null) {
    return fail(
      "NO_ACTOR",
      "No actor could be resolved for this session, so there is nobody to record as the importer and nothing was imported. Both scheme_file.imported_by and recon_run.run_by are NOT NULL. Pick an actor on /approvals and try again.",
    );
  }

  // Read as text and hash as given. The importer never normalises the bytes:
  // a trailing newline changes the sha256, and the sha256 is the file's
  // identity.
  const content = await file.text();
  const filename = file.name === "" ? "uploaded-file" : file.name;

  let imported: ImportSchemeFileResult;
  try {
    imported = await importSchemeFile({ filename, content, importedBy: actor });
  } catch (thrown) {
    rootLogger.warn("recon.import_from_screen_failed", { filename, reason: reason(thrown) });
    const malformed = thrown instanceof SchemeFileFormatError;
    return fail(
      malformed ? "NOT_A_SETTLEMENT_FILE" : "IMPORT_FAILED",
      malformed
        ? `That file was not read as a settlement file, so nothing was imported and nothing was run. The parser said: ${reason(thrown)}. A settlement file starts with the line "#CORGI-SETTLE v1 provider=… rail=… business_date=YYYY-MM-DD", then a header row of reference,amount,value_date,direction,descriptor. Fix the file and choose it again.`
        : `The import did not finish, so nothing was run. The database said: ${reason(thrown)}. No partial file is on record — the import is one transaction.`,
      [{ label: "File", value: filename }],
    );
  }

  try {
    const run = await runReconciliation({ fileId: imported.fileId, actorId: actor });
    rootLogger.info("recon.import_and_run_from_screen", {
      fileId: imported.fileId,
      alreadyOnRecord: !imported.imported,
      runId: run.runId,
      runNo: run.runNo,
      breaks: run.breaks.length,
    });
    revalidatePath("/reconciliation");
    return receipt(
      run,
      imported.imported
        ? `${filename}, newly on record`
        : `${filename} — these exact bytes were already on record, so no second copy was made`,
      [
        { label: "File sha256", value: imported.sha256, mono: true },
        { label: "Rows accepted", value: String(imported.rowCount) },
        {
          label: "Rows rejected",
          value:
            imported.rejectedCount === 0
              ? "none — every row parsed"
              : `${imported.rejectedCount}, listed under Rejected rows below and NOT matched against anything`,
        },
      ],
    );
  } catch (thrown) {
    rootLogger.error("recon.run_after_import_failed", {
      fileId: imported.fileId,
      reason: reason(thrown),
    });
    return fail(
      "RECON_RUN_FAILED",
      `The file is on record but the run did not finish, so no recon_run row was written. The database said: ${reason(thrown)}. The file is imported and does not need uploading again — press "Run this file again" on the run that names it, or re-upload the same bytes, which will not make a second copy.`,
      [
        { label: "File", value: filename },
        { label: "File id", value: imported.fileId, mono: true },
      ],
    );
  }
}

/**
 * The receipt for a finished run.
 *
 * It states what the run compared and what it found, and it links to the run
 * itself. It does NOT say "reconciled": a run that found four breaks has
 * reconciled nothing, and the word is only earned by a break count of zero.
 */
function receipt(
  run: RunReconciliationResult,
  what: string,
  extra: readonly ReconRunFact[] = [],
): ReconRunResult {
  const clean = run.breaks.length === 0;
  return {
    status: "ok",
    code: clean ? "RECONCILED_CLEAN" : "BREAKS_FOUND",
    message: clean
      ? `Run #${run.runNo} over ${what} matched every row in the file to an entry in the book and found no break. Rows the importer rejected were never matched against anything and are not counted here.`
      : `Run #${run.runNo} over ${what} found ${run.breaks.length === 1 ? "one break" : `${run.breaks.length} breaks`}. They are in the table below, worst first. Nothing has been corrected — a run reports, it does not fix — and run #${run.runNo - 1} still says what it said.`,
    facts: [
      { label: "Run", value: `#${run.runNo}`, mono: true },
      { label: "Run id", value: run.runId, mono: true },
      { label: "Matched", value: `${run.match.matched} of the file's rows` },
      { label: "Breaks", value: clean ? "none" : String(run.breaks.length) },
      {
        label: "Booking watermark",
        value: `seq ${run.bookingWatermark.toString()} — the run judged the book as at this entry and no later`,
      },
      { label: "Content hash", value: run.contentHash, mono: true },
      ...extra,
    ],
    href: `/reconciliation?run=${run.runId}`,
    at: new Date().toISOString(),
  };
}
