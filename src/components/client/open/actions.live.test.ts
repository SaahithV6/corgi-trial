/**
 * The application action, treated as the public POST endpoint it is.
 *
 * ── WHY THE ACTION IS IMPORTED AND CALLED, NOT POSTED TO ────────────────────
 *
 * `curl` cannot drive a Next 16 server action: `useActionState` puts the
 * previous-state argument in fields that cannot be reproduced by hand, and a
 * no-JS multipart POST returns 200 having rendered the page WITHOUT running the
 * action — which looks like a pass and is not. So the action is imported and
 * called, the way `src/components/home/actions.test.ts:16` and
 * `src/components/client/payouts/actions.live.test.ts` do.
 *
 * ── WHAT IT TOUCHES ─────────────────────────────────────────────────────────
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/components/client/open
 *
 * It writes NO ROW — `applyAction` has no INSERT on any path — but the
 * happy-path case makes a real `GET` to api.gleif.org, so it is gated with the
 * same flag and the module is imported DYNAMICALLY inside the gate: importing
 * it evaluates `src/lib/env.ts`, which refuses to load without a full set of
 * keys, and a suite that pulled it in at the top would fail COLLECTION in a run
 * that was only ever going to skip it.
 *
 * The names used below are invented and are NOT the three demo businesses.
 */
import { describe, expect, it } from "vitest";

import { IDLE_APPLICATION } from "./application";

const RUN = process.env.RUN_DB_TESTS === "1";

function form(overrides: Readonly<Record<string, string>> = {}): FormData {
  const fields: Record<string, string> = {
    legalName: "Northwind Instruments, Inc.",
    ein: "12-3456789",
    street1: "1 Harbour Way",
    city: "Portland",
    subdivision: "OR",
    postalCode: "97204",
    lei: "",
    "director.0.fullName": "Alex Mercer",
    "director.0.email": "alex@northwind.example",
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe.skipIf(!RUN)("applyAction", () => {
  it("refuses an application with no director, before anything is sent", async () => {
    const { applyAction } = await import("./actions");
    const data = form({ "director.0.fullName": "", "director.0.email": "" });

    const result = await applyAction(IDLE_APPLICATION, data);

    expect(result.status).toBe("refused");
    expect(result.code).toBe("APPLICATION_INVALID");
    expect(result.state).toBeNull();
    expect(result.registry).toBeNull();
  });

  it("refuses a malformed EIN rather than sending it to a third party", async () => {
    const { applyAction } = await import("./actions");

    const result = await applyAction(IDLE_APPLICATION, form({ ein: "not-an-ein" }));

    expect(result.status).toBe("refused");
    expect(result.code).toBe("APPLICATION_INVALID");
    expect(result.detail).toContain("nine digits");
  });

  it(
    "asks the live register and reports a first-class pending state with no account",
    { timeout: 30_000 },
    async () => {
      const { applyAction } = await import("./actions");

      const result = await applyAction(IDLE_APPLICATION, form());

      expect(result.status).toBe("submitted");
      // The weakest leg decides. The director leg is unanswered on this
      // surface, so the fold can never be `approved` however the register
      // answers — this is the rule, asserted rather than described.
      expect(result.state).not.toBe("approved");
      expect(result.accountOpen).toBe(false);
      expect(result.registry).not.toBeNull();
      expect(result.registry?.reference).not.toBe("");
      // A pending applicant is told what is true and what happens next, and
      // the handover names the step a human has to perform.
      if (result.state === "pending") {
        expect(result.handover).not.toBeNull();
        expect(result.detail).toContain("no account");
      }
    },
  );
});
