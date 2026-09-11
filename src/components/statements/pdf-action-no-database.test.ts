/**
 * THE STATEMENT PDF ACTION REFUSES IN WORDS, AND THIS PINS THE LUCK IT RELIES
 * ON.
 *
 * ============================================================================
 * `src/app/(app)/statements/actions.ts` opens with
 *
 *     import { hasDatabase, loadStatementsScreen } from "./live-source";
 *
 * a STATIC import of a live module, guarding a refusal forty lines below it:
 *
 *     if (!hasDatabase()) return { ok: false, message: "No database is
 *       configured, so there is no ledger to generate a statement from..." }
 *
 * That is the exact SHAPE of the unreachable guard seven screens on this
 * console carried — a predicate reached through an import that only succeeds
 * when the answer is yes. Here it is reachable, and measured: it returns the
 * refusal, as this file shows. The reason is that
 * `src/app/(app)/statements/live-source.ts` happens to open its connection
 * through `ledgerConnection()` rather than value-importing `sql` from
 * `@/lib/ledger/db`, so its module graph does not reach `@/lib/env` at module
 * scope.
 *
 * IT SURVIVES ON LUCK, WHICH IS WHY THIS FILE EXISTS. `page.tsx`'s own header
 * says the same thing about the page's former guard, in those words: one new
 * value import inside `live-source.ts` — one `import { sql } from
 * "@/lib/ledger/db"` added by somebody adding a query — turns this action into
 * a module that cannot load, and the failure is invisible. Nothing renders an
 * action, so nothing renders its absence: the operator presses the download
 * button and the panel's failure branch has no `message` to print, because the
 * action never returned one.
 *
 * So this pins the property rather than the implementation. If the import graph
 * grows a value import of the database, the first test below goes red naming
 * it, instead of a download button going quiet in a demo.
 *
 * The refusal it protects is worth keeping reachable. It says the document is
 * never rendered from fixtures, because a statement drawn from typed-in numbers
 * is the one artefact here that would be worth nothing — which is precisely the
 * defect this screen carried on its own face until an hour ago.
 * ============================================================================
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

describe("statementPdfAction with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("loads at all, which is the half that was broken", async () => {
    // Dynamic, and after the delete. A static import at the top of this file
    // would evaluate the action module while the variable is still set, and
    // whether it can be loaded without one is exactly what is under test.
    const actions = await import("@/app/(app)/statements/actions");
    expect(typeof actions.statementPdfAction).toBe("function");
  }, 30_000);

  it("returns the refusal as a VALUE, with its reason", async () => {
    const { statementPdfAction } = await import("@/app/(app)/statements/actions");
    const result = await statementPdfAction({});

    expect(result.ok).toBe(false);
    // The failure branch of the result type carries a message and nothing else,
    // so this is what the panel has to render.
    expect(result.ok === false ? result.message : "").toContain(
      "No database is configured",
    );
  }, 30_000);

  it("renders no document, no fingerprint and no watermark", async () => {
    const { statementPdfAction } = await import("@/app/(app)/statements/actions");
    const result = await statementPdfAction({});

    // A statement is the one artefact on this console whose whole value is that
    // it was derived from the journal. There is no partial version of it worth
    // handing back.
    expect(result).not.toHaveProperty("base64");
    expect(result).not.toHaveProperty("fingerprint");
    expect(result).not.toHaveProperty("believedWatermark");
  }, 30_000);
});
