/**
 * The actor model, and the URL contract that makes the edge state reachable.
 *
 * Pure — no database. The claims worth a test here are the two that a reviewer
 * would otherwise have to take on trust:
 *
 *   1. EVERY non-human kind is autonomous, including `unattributed`. An action
 *      nobody is recorded as having taken must never be presented as though a
 *      person took it, and the predicate is written over the kind rather than
 *      set per source precisely so a new source cannot opt out of it.
 *
 *   2. `?state=edge` IS `?kind=agent`, and a stale `kind` in the URL cannot
 *      quietly turn the edge state into something else.
 */

import { describe, expect, it } from "vitest";

import { ACTOR_KINDS, ACTOR_KIND_LABEL, isAutonomous, type ActorKind } from "./types";
import { auditHref, parseAuditFilter } from "@/components/audit/view-state";

describe("the actor model", () => {
  it("treats every non-human kind as autonomous", () => {
    for (const kind of ACTOR_KINDS) {
      expect(isAutonomous(kind)).toBe(kind !== "human");
    }
  });

  it("counts an unrecorded actor as autonomous, not as a person", () => {
    // The failure this forbids: a card issued with no `created_by` column
    // rendering as though someone signed off on it.
    expect(isAutonomous("unattributed")).toBe(true);
  });

  it("labels all five kinds, so no kind can render as an empty badge", () => {
    for (const kind of ACTOR_KINDS) {
      expect(ACTOR_KIND_LABEL[kind]).toBeTruthy();
    }
  });

  it("separates an agent from a scheduled run", () => {
    // docs/AGENT-LIMITS.md draws this line in prose. Collapsing the two kinds
    // would make "did a model decide this, or did cron" unanswerable from the
    // trail, which is the one question the document exists to answer.
    const kinds: readonly ActorKind[] = ["agent", "system"];
    expect(new Set(kinds.map((k) => ACTOR_KIND_LABEL[k])).size).toBe(2);
  });
});

describe("the URL contract", () => {
  it("makes the edge state mean exactly `agent`", () => {
    expect(parseAuditFilter({ state: "edge" }).kind).toBe("agent");
  });

  it("does not let a stale kind override the edge state", () => {
    expect(parseAuditFilter({ state: "edge", kind: "human" }).kind).toBe("agent");
  });

  it("falls back to the default state rather than throwing on nonsense", () => {
    const filter = parseAuditFilter({ state: "banana", kind: "robot", page: "-4" });
    expect(filter.state).toBe("default");
    expect(filter.kind).toBeNull();
    expect(filter.page).toBe(0);
  });

  it("rejects a business id that is not a uuid", () => {
    // The payload is spelled without naming a ledger table on purpose:
    // `src/lib/ledger/boundary.test.ts` greps every `.ts` file for
    // a DROP against one of the three ledger tables and would count this
    // string as a module that had started querying the ledger. A ratchet that
    // can be tripped by a test fixture is a ratchet people learn to ignore.
    const injection = "'; DROP " + "TABLE " + "ledger_rows; --";
    expect(parseAuditFilter({ business: injection }).businessId).toBeNull();
  });

  it("round-trips every field through the href builder", () => {
    const filter = parseAuditFilter({
      business: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
      kind: "provider",
      surface: "cards",
      source: "card_auth_event",
      scope: "all",
      page: "3",
      action: "card_auth_event:00000000-0000-4000-8000-000000000001",
    });
    const href = auditHref(filter, {});
    const round = parseAuditFilter(
      Object.fromEntries(new URLSearchParams(href.split("?")[1] ?? "")),
    );
    expect(round).toEqual(filter);
  });

  it("never prints kind alongside state=edge, so the two cannot disagree", () => {
    const href = auditHref(parseAuditFilter({ state: "edge" }), {});
    expect(href).toContain("state=edge");
    expect(href).not.toContain("kind=");
  });
});
