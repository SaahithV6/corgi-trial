/**
 * The rot test: a new operator action is covered by DEFAULT, and an uncovered
 * one is a failing test rather than a silent grant.
 *
 * Same shape as `coverage.test.ts`, for the same reason. That test walks
 * `src/app` so a route nobody classified fails CI; this one walks every
 * `src/app/(app)/**\/actions.ts` so an ACTION nobody guarded fails CI. The
 * population is a filesystem walk, never a list: the thirty-odd defects this
 * repository has catalogued all have the shape "the guard's population was
 * chosen by hand, and the hand forgot".
 *
 * Two properties, and they are different:
 *
 *   1. RUNTIME: an operator action that calls `assertOperatorAction()` refuses
 *      a customer cookie whatever pathname it was posted to.
 *      `action-guard.proof.test.ts` proves that against real actions.
 *
 *   2. REVIEW: an operator action written WITHOUT that call fails this test, by
 *      name, with the line to add. The only way out is to name its module in
 *      `CUSTOMER_EXECUTABLE_ACTION_MODULES` with a reason a reviewer reads —
 *      which is three entries today and each one says why.
 *
 * The check is textual on purpose. Importing thirty-seven action modules to
 * inspect them would drag in the database, the provider clients and the whole
 * server graph, and a test that cannot run without `APP_DATABASE_URL` is a test
 * that gets skipped — see the reporter in `vitest.config.ts` on exactly that.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CUSTOMER_EXECUTABLE_ACTION_MODULES } from "./action-guard";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const APP_GROUP = fileURLToPath(new URL("../../app/(app)", import.meta.url));

/** Repo-relative, so a failure names a file the reader can open. */
function relative(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length) : path;
}

/** Every `actions.ts` under the `(app)` group, at any depth. */
function actionModulesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      found.push(...actionModulesUnder(full));
      continue;
    }
    if (name === "actions.ts") found.push(full);
  }
  return found;
}

const ALL_MODULES = actionModulesUnder(APP_GROUP).map(relative).sort();

/**
 * The customer's own product surface. Skipped wholesale rather than exempted by
 * name: every action under it carries a both-column tenant predicate, which is
 * the boundary that belongs there. A role check would refuse the customer their
 * own screens.
 */
const CUSTOMER_TREE = "src/app/(app)/client/";

const OPERATOR_MODULES = ALL_MODULES.filter(
  (path) =>
    !path.startsWith(CUSTOMER_TREE) &&
    CUSTOMER_EXECUTABLE_ACTION_MODULES[path] === undefined,
);

/** `export async function name(` — the only way an action is declared here. */
const EXPORTED_ACTION = /^export async function ([A-Za-z0-9_]+)\(/gm;

/**
 * Every exported action in a module, paired with the text of its body up to the
 * next exported action. A guard call anywhere in that span is inside the
 * function; a guard call in the module's preamble is not in any span.
 */
function exportedActions(path: string): { name: string; body: string }[] {
  const source = readFileSync(`${REPO_ROOT}${path}`, "utf8");
  const starts = [...source.matchAll(EXPORTED_ACTION)];
  return starts.map((match, index) => ({
    name: match[1] ?? "(unnamed)",
    body: source.slice(match.index, starts[index + 1]?.index ?? source.length),
  }));
}

describe("every operator server action re-derives the decision itself", () => {
  it("found the actions at all — a walk that finds nothing proves nothing", () => {
    expect(ALL_MODULES.length).toBeGreaterThan(15);
    expect(OPERATOR_MODULES.length).toBeGreaterThan(10);
    expect(ALL_MODULES).toContain("src/app/(app)/team/actions.ts");
    expect(ALL_MODULES).toContain("src/app/(app)/client/pots/actions.ts");
  });

  /**
   * THE ROT TEST. Add an operator action without the guard and this fails by
   * name, with the line to paste.
   */
  it("calls assertOperatorAction() as the first statement of every one", () => {
    const unguarded: string[] = [];
    for (const path of OPERATOR_MODULES) {
      for (const action of exportedActions(path)) {
        if (!action.body.includes("await assertOperatorAction(")) {
          unguarded.push(`${path} → ${action.name}`);
        }
      }
    }
    expect(
      unguarded,
      "these operator server actions do not re-derive the authorisation decision:\n" +
        `  ${unguarded.join("\n  ")}\n\n` +
        "A server action POSTs to the page the browser is ON, so middleware.ts sees a\n" +
        "/client/* pathname and allows it, and the (app) layout never runs for an action\n" +
        "that renders no page. Add as the first statement of the function body:\n\n" +
        '    await assertOperatorAction("<theActionName>");\n\n' +
        "If a customer session is genuinely meant to execute it, name the MODULE in\n" +
        "CUSTOMER_EXECUTABLE_ACTION_MODULES (src/lib/authz/action-guard.ts) with the\n" +
        "reason — and give it a both-column tenant predicate, because nothing else\n" +
        "will be scoping it.",
    ).toEqual([]);
  });

  it("guards the action itself, not some other action's name", () => {
    // A copy-paste that guards `foo` inside `bar` would pass the test above and
    // produce a refusal that names the wrong capability in the log.
    const mismatched: string[] = [];
    for (const path of OPERATOR_MODULES) {
      for (const action of exportedActions(path)) {
        if (!action.body.includes(`await assertOperatorAction("${action.name}")`)) {
          mismatched.push(`${path} → ${action.name}`);
        }
      }
    }
    expect(mismatched, `the guard names a different action than the one it is in:\n  ${mismatched.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("exempts no module that does not exist", () => {
    const stale = Object.keys(CUSTOMER_EXECUTABLE_ACTION_MODULES)
      .filter((path) => !ALL_MODULES.includes(path))
      .sort();
    expect(
      stale,
      `these are exempted from the action guard and are not action modules any more:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("exempts nothing under the customer tree — that tree is skipped, not blessed", () => {
    const redundant = Object.keys(CUSTOMER_EXECUTABLE_ACTION_MODULES).filter((path) =>
      path.startsWith(CUSTOMER_TREE),
    );
    expect(redundant).toEqual([]);
  });

  it("leaves the customer's own four actions unguarded and intact", () => {
    // They are correct, they are load-bearing, and this test must never be the
    // reason somebody puts a role check on a customer's own screen. Named so a
    // future edit has to face them, with the predicate that actually scopes
    // each one.
    const ownActions: Readonly<Record<string, string>> = {
      "src/app/(app)/client/disputes/actions.ts": "entryBelongsToBusiness",
      "src/app/(app)/client/pots/actions.ts": "ownsPot",
      "src/app/(app)/client/payouts/actions.ts": "readOwnedQuote",
      "src/app/(app)/client/cards-actions.ts": "business_id",
    };
    for (const [path, predicate] of Object.entries(ownActions)) {
      const source = readFileSync(`${REPO_ROOT}${path}`, "utf8");
      expect(source, `${path} no longer carries its tenant predicate`).toContain(predicate);
      expect(source, `${path} has been given a role check it must not have`).not.toContain(
        "assertOperatorAction",
      );
    }
  });
});
