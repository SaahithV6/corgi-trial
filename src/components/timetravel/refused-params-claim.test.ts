/**
 * A SCREEN THAT REFUSED A COORDINATE DID NOT READ THE LEDGER, AND ITS BADGE
 * MUST NOT SAY `live`.
 *
 * ============================================================================
 * `/transactions` was repaired for the no-database defect an hour before this
 * file was written, and the repair resolved ONE value — `noDatabase` — and fed
 * it to both the state bar and the section below. That is right, and it is not
 * the whole question the badge answers.
 *
 * There is a second way this screen reads nothing, and it has nothing to do
 * with whether a database is configured. `?asOf=` and `?asKnownAt=` are
 * validated by a pure function BEFORE a connection is opened, precisely so an
 * impossible coordinate never reaches the database — and when that validation
 * fails the page renders `RefusalPanel` instead of the board. The panel says,
 * in its own words:
 *
 *     "Nothing was read and nothing moved ... this request never reached a
 *      connection."
 *
 * Directly above it, `StateBar` printed `<Badge tone="positive">live</Badge>`,
 * because its predicate was `noDatabase && state !== "error"` — a question
 * about the DEPLOYMENT and the DEMO STATE, neither of which knows whether this
 * particular request read anything. A database was configured and the state was
 * `default`, so the badge said live over a panel saying nothing was read.
 *
 * That is the defect this whole pass is about, in its purest form: the badge
 * covers a population — "deployments with a database, in a state that is not
 * the drawn failure" — chosen by something other than the capability it stands
 * for, which is "this render read the book".
 *
 * The fix is one more input to the same value, not a second predicate: whether
 * the coordinates parsed is already known at the call site, and the badge is
 * told.
 * ============================================================================
 *
 * A DATABASE URL IS SET HERE AND NOTHING CONNECTS TO IT. That is the point of
 * the case: the bug needs a configured database to show, because with none the
 * NO DATABASE badge was already correct. The URL only has to parse — the page
 * returns the refusal before any source is consulted — so a placeholder does,
 * and the real value is restored afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, renderPage } from "@/test/no-database-render";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];
const PLACEHOLDER = "postgresql://corgi_app:x@localhost:5432/corgi?sslmode=require";

/** Every word this screen can use to claim it read something. */
const BADGES = ["live", "fixture", "NO DATABASE"] as const;

/**
 * Coordinates this screen refuses without opening a connection.
 *
 * One malformed on each axis, because they are parsed separately and a fix
 * that only reached one of them would leave the other badging `live`.
 */
const REFUSED: readonly Record<string, string>[] = [
  { asOf: "banana" },
  { asKnownAt: "not-an-instant" },
  { asOf: "2026-13-45" },
];

describe("/transactions badges no claim to have read when it refused the coordinates", () => {
  beforeAll(() => {
    if (SAVED === undefined || SAVED === "") process.env["APP_DATABASE_URL"] = PLACEHOLDER;
  });

  afterAll(() => {
    if (SAVED === undefined) delete process.env["APP_DATABASE_URL"];
    else process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const params of REFUSED) {
    const label = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    it(`?${label} refuses, and does not badge live over the refusal`, async () => {
      const page = await import("@/app/(app)/transactions/page");
      const html = await renderPage(page, params);

      // The refusal really is the thing on screen.
      expect(html).toContain("never reached a connection");

      // And the bar above it does not claim a read that did not happen.
      expect(claimsIn(html, BADGES)).not.toContain("live");
    }, 30_000);
  }

  it("still makes its other claims rather than going silent", async () => {
    // The guard against over-correction: the badge must not simply disappear
    // for every request. With the coordinates absent and no database
    // configured, the bar still speaks, and says the one true thing.
    //
    // `?state=error` would be the other half of this guard and cannot be
    // rendered here: its retry control is a client component calling
    // `useRouter()`, and no app router is mounted in a unit test — the same
    // limit `src/components/standing/no-database.test.ts` documents, which is
    // why that file skips the state too.
    delete process.env["APP_DATABASE_URL"];
    try {
      const page = await import("@/app/(app)/transactions/page");
      const html = await renderPage(page, {});
      expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
    } finally {
      process.env["APP_DATABASE_URL"] = PLACEHOLDER;
    }
  }, 30_000);
});
