import { describe, expect, it } from "vitest";

import { classifyRefusal, isRefusal, rawMessage, refuse, sqlState } from "./refusal";

/**
 * These fixtures are the EXACT text the migrations raise, with the `%`
 * placeholders filled in the way Postgres fills them. If a migration ever
 * rewords one of these messages, this file fails and the operator-facing
 * refusal is fixed in the same change rather than silently degrading to
 * "something went wrong".
 */
function pgError(message: string, code = "42501", constraint?: string) {
  return {
    name: "PostgresError",
    code,
    message,
    ...(constraint === undefined ? {} : { constraint_name: constraint }),
  };
}

const INSTRUCTION = "9f3ad1c2-0000-0000-0000-000000000001";
const ACTOR = "76f9266f-23c9-52de-b8ff-0ec0b23ef386";

describe("classifyRefusal", () => {
  it("names the self-approval refusal from 0001's assert_maker_checker()", () => {
    const error = classifyRefusal(
      pgError(
        `maker-checker: actor ${ACTOR} initiated instruction ${INSTRUCTION} and cannot approve it`,
      ),
    );
    expect(error.code).toBe("SELF_APPROVAL");
    expect(error.message).toMatch(/you cannot approve it/);
    expect(error.details).toEqual({ sqlstate: "42501" });
  });

  it("distinguishes 'not an approver' from 'not this payment'", () => {
    const error = classifyRefusal(pgError(`actor ${ACTOR} (kind agent) is not an approver`));
    expect(error.code).toBe("NOT_AN_APPROVER");
    expect(error.message).toMatch(/agent or a service account cannot be one/);
  });

  it("names the stale approval", () => {
    const error = classifyRefusal(
      pgError(`approval for ${INSTRUCTION} cites the wrong content hash`),
    );
    expect(error.code).toBe("STALE_APPROVAL");
    expect(error.message).toMatch(/changed since it was shown to you/);
  });

  it("names an insufficient approval count", () => {
    const error = classifyRefusal(
      pgError(`instruction ${INSTRUCTION} needs 2 approval(s) above the 0 cent threshold, has 1`),
    );
    expect(error.code).toBe("INSUFFICIENT_APPROVALS");
  });

  it("names a double release", () => {
    const error = classifyRefusal(
      pgError(`instruction ${INSTRUCTION} has already been released`, "55006"),
    );
    expect(error.code).toBe("ALREADY_RELEASED");
    expect(error.message).toMatch(/keyed on the instruction id/);
  });

  it("names a release after a rejection", () => {
    const error = classifyRefusal(
      pgError(`instruction ${INSTRUCTION} was rejected or cancelled and cannot be released`),
    );
    expect(error.code).toBe("ALREADY_DECIDED");
  });

  it("names 0001's UNIQUE (instruction_id, kind, actor_id)", () => {
    const error = classifyRefusal(
      pgError(
        'duplicate key value violates unique constraint "pie_one_decision_per_actor"',
        "23505",
        "pie_one_decision_per_actor",
      ),
    );
    expect(error.code).toBe("DUPLICATE_DECISION");
    expect(error.message).toMatch(/One actor, one decision/);
  });

  it("names the actor CHECK, which no code path can get around", () => {
    const error = classifyRefusal(
      pgError(
        'new row for relation "actor" violates check constraint "actor_only_humans_approve"',
        "23514",
        "actor_only_humans_approve",
      ),
    );
    expect(error.code).toBe("AGENT_CANNOT_APPROVE");
    expect(error.message).toMatch(/no row shape/);
  });

  it("names the append-only trigger and the privilege refusal separately", () => {
    expect(
      classifyRefusal(
        pgError(
          "append-only violation: UPDATE attempted on public.payment_instruction_event",
          "55006",
        ),
      ).code,
    ).toBe("IMMUTABLE");
    expect(
      classifyRefusal(
        pgError("permission denied for table payment_instruction_event", "42501"),
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("falls back to a message that says nothing was written", () => {
    const error = classifyRefusal(new Error("connection terminated unexpectedly"));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toMatch(/Nothing was written/);
  });

  /**
   * The raw server text names internal ids and table structure. `ErrorShape`
   * documents `message` as "safe to show", so no branch may pass the Postgres
   * string through to a screen.
   */
  it("never leaks the raw Postgres text into the user-facing message", () => {
    const raw = `maker-checker: actor ${ACTOR} initiated instruction ${INSTRUCTION} and cannot approve it`;
    const error = classifyRefusal(pgError(raw));
    expect(error.message).not.toContain(ACTOR);
    expect(error.message).not.toContain(INSTRUCTION);
    // …but it is still available for the log.
    expect(rawMessage(pgError(raw))).toBe(raw);
    expect(sqlState(pgError(raw))).toBe("42501");
  });
});

describe("refuse", () => {
  it("produces an Err ready to return from a write path", () => {
    const result = refuse(pgError(`approval for ${INSTRUCTION} cites the wrong content hash`));
    expect(result.ok).toBe(false);
    expect(isRefusal(result.error, "STALE_APPROVAL")).toBe(true);
    expect(isRefusal(result.error, "SELF_APPROVAL")).toBe(false);
  });

  it("handles a non-Postgres throw without pretending to know what happened", () => {
    expect(sqlState("a string")).toBe("");
    expect(rawMessage("a string")).toBe("a string");
    expect(classifyRefusal("a string").code).toBe("UNAVAILABLE");
  });
});
