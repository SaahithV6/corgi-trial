/**
 * THE IMPORT GUARD.
 *
 * `tools.test.ts` asserts that no TOOL is named after an operation this
 * surface refuses. That is the outermost layer and the weakest one: it checks
 * names. This file checks capability — that the MCP module does not import the
 * functions that perform those operations, anywhere, for any reason.
 *
 * It exists because of a real change in the guarantee. When this surface had
 * four tools, `docs/AGENT-LIMITS.md` could say the refusals were absent
 * capabilities: the module imported `@/lib/approvals`'s request path and
 * nothing else that writes, so there was no code path to a journal line or an
 * approval even by mistake. Adding the pots, payee, standing-order and
 * card-control readers changed that, because the modules holding those reads
 * ALSO hold the writes:
 *
 *   `@/lib/cards/store`   listCardsWithControls  …and setCardControls
 *   `@/lib/payees/store`  loadPayeeBook          …and acknowledgeWarning
 *   `@/lib/pots/store`    listPots               …and, next door, movePotFunds
 *
 * The disputes and accrual readers made it sharper again, and added a second
 * shape of the same problem — the BARREL. `@/lib/disputes/store` holds
 * `listDisputeStates` next to `insertDispute`, which is the old shape. But
 * `@/lib/disputes/index.ts` re-exports `./operations`, which imports
 * `postEntry`: importing the barrel for a read would make nothing new callable
 * and would still drag the journal-writing module into this process's graph.
 * Both spellings are now refused below.
 *
 * A named import brings in one binding, not a module's whole surface, so
 * nothing became reachable. But "we did not import the write" is a fact about
 * today's diff, and a fact about a diff is not a control. This test makes it
 * one: adding the import fails the build, in this file, with the reason
 * attached.
 *
 * It is deliberately a grep rather than a type-level trick. The thing being
 * prevented is a future contributor writing an ordinary-looking import line,
 * and the check that catches that is the one that reads the import lines.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = join(process.cwd(), "src", "lib", "mcp");

/**
 * Every write this surface refuses, as the identifier that performs it.
 *
 * Each entry names the operation and its section in docs/AGENT-LIMITS.md, so a
 * failure tells the person who caused it where the argument lives rather than
 * only that a test went red.
 */
const FORBIDDEN_IMPORTS: readonly { readonly name: string; readonly why: string }[] = [
  // The ledger itself (§8).
  { name: "postEntry", why: "posts a journal entry — AGENT-LIMITS §8" },
  { name: "reverseAndRebook", why: "corrects the ledger — AGENT-LIMITS §8" },
  // Approval and release (§1, §2).
  { name: "approvePayment", why: "approves an instruction — AGENT-LIMITS §2" },
  { name: "rejectPayment", why: "decides an instruction — AGENT-LIMITS §2" },
  { name: "cancelPayment", why: "decides an instruction — AGENT-LIMITS §2" },
  { name: "releasePayment", why: "calls the rail — AGENT-LIMITS §1" },
  // Cards (§7, §13).
  { name: "setCardControls", why: "changes a real-time auth decision — AGENT-LIMITS §13" },
  // Payees (§11, §12).
  { name: "savePayee", why: "writes the payee book — AGENT-LIMITS §12" },
  { name: "acknowledgeWarning", why: "signs off a name-match warning — AGENT-LIMITS §11" },
  { name: "archivePayee", why: "changes the payee book — AGENT-LIMITS §12" },
  { name: "recordVerification", why: "writes a verification record — AGENT-LIMITS §11" },
  { name: "confirmPayee", why: "runs and records a payee check — AGENT-LIMITS §12" },
  // Standing orders (§10, §14).
  { name: "createStandingOrder", why: "creates recurring authority — AGENT-LIMITS §10" },
  { name: "cancelStandingOrder", why: "amends a mandate — AGENT-LIMITS §10" },
  { name: "runStandingOrders", why: "fires occurrences — AGENT-LIMITS §14" },
  // Pots (§15).
  { name: "openPot", why: "creates an account — AGENT-LIMITS §15" },
  { name: "movePotFunds", why: "posts a book transfer — AGENT-LIMITS §15" },
  // Stablecoin (§9).
  { name: "sendUsdcPayout", why: "broadcasts a transfer — AGENT-LIMITS §9" },
  { name: "signTransaction", why: "signs with the payout key — AGENT-LIMITS §9" },
  { name: "encodeSignedTransaction", why: "produces a broadcastable payload — AGENT-LIMITS §9" },
  { name: "settleTransaction", why: "books an on-chain settlement — AGENT-LIMITS §9" },
  // KYB (§16).
  { name: "manualReviewLeg", why: "decides a KYB review — AGENT-LIMITS §16" },
  // Disputes (§17, §18). These arrived with `list_disputes`, and they are the
  // sharpest instance of the problem this file exists for: the read the tool
  // needs, `listDisputeStates`, lives in the same module as `insertDispute`.
  { name: "raiseDispute", why: "opens a case and starts the network clock — AGENT-LIMITS §17" },
  { name: "insertDispute", why: "writes the case row directly — AGENT-LIMITS §17" },
  { name: "insertDisputeEvent", why: "writes a lifecycle transition — AGENT-LIMITS §17" },
  { name: "submitEvidence", why: "files with the network — AGENT-LIMITS §17" },
  { name: "recordDecision", why: "records a verdict — AGENT-LIMITS §17" },
  { name: "openDisputeHold", why: "encumbers customer money — AGENT-LIMITS §18" },
  { name: "closeDisputeHold", why: "releases an encumbrance — AGENT-LIMITS §18" },
  {
    name: "authorizeProvisionalCredit",
    why: "is the maker-checker step itself — AGENT-LIMITS §18",
  },
  { name: "grantProvisionalCredit", why: "advances the bank's money — AGENT-LIMITS §18" },
  { name: "declineProvisionalCredit", why: "decides an advance — AGENT-LIMITS §18" },
  { name: "clawBackCredit", why: "takes money back off a customer — AGENT-LIMITS §18" },
  { name: "writeOffCredit", why: "absorbs a loss onto 5200 — AGENT-LIMITS §18" },
  { name: "finalizeCredit", why: "makes an advance permanent — AGENT-LIMITS §18" },
  // Accrual (§19, §20).
  { name: "runAccrual", why: "posts the daily fee — AGENT-LIMITS §20" },
  { name: "runInterest", why: "posts the daily interest — AGENT-LIMITS §20" },
  { name: "claimDay", why: "claims an accrual day for a tick — AGENT-LIMITS §20" },
  { name: "recordPosting", why: "records an accrual decision — AGENT-LIMITS §20" },
];

/**
 * Modules no file here may import at all, write function or not.
 *
 * The last four are BARRELS, and they are the entries worth explaining,
 * because they are not modules whose purpose is to write — they are modules
 * that re-export one.
 *
 * `@/lib/disputes/index.ts` re-exports `./operations`, and
 * `@/lib/accrual/index.ts` re-exports `./accrue`; both of those import
 * `postEntry`. A named import from a barrel brings in one binding, so
 * importing `listDisputeStates` from `@/lib/disputes` would make nothing new
 * CALLABLE — but it would put `ledger/post.ts` into this process's module
 * graph, and "the MCP module does not import ledger/post.ts" is the strongest
 * sentence in docs/AGENT-LIMITS.md. The gateway therefore reaches past both
 * barrels to `@/lib/disputes/store` and to scoped SQL, and this list makes
 * that a rule rather than a habit.
 */
const FORBIDDEN_MODULES: readonly string[] = [
  "@/lib/ledger/post",
  "@/lib/approvals/decide",
  "@/lib/approvals/release",
  "@/lib/pots/transfer",
  "@/lib/standing/fire",
  "@/lib/rails/stablecoin/tx",
  "@/lib/rails/stablecoin/secp256k1",
  "@/lib/disputes/operations",
  "@/lib/accrual/accrue",
  "@/lib/accrual/interest",
  "@/lib/disputes",
  "@/lib/accrual",
];

function sourceFiles(): { readonly file: string; readonly text: string }[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(join(HERE, f), "utf8") }));
}

/**
 * The import statements only.
 *
 * Matched precisely rather than by splitting the file, because this very
 * directory is full of prose that NAMES the forbidden functions — that is the
 * point of the comments — and a guard that cannot tell `approvePayment` in a
 * paragraph from `approvePayment` in an import is a guard that forces people to
 * stop writing the paragraphs.
 */
function importLines(text: string): string[] {
  const matches = text.match(/^[ \t]*import\b[\s\S]*?from\s+"[^"]+";/gm) ?? [];
  return matches.map((chunk) => chunk.replace(/\s+/g, " "));
}

describe("the MCP module imports nothing that writes", () => {
  const files = sourceFiles();

  it("has source files to check at all", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(15);
    expect(files.map((f) => f.file)).toContain("gateway.ts");
  });

  it("imports no write entry point by name", () => {
    for (const { file, text } of files) {
      for (const line of importLines(text)) {
        for (const forbidden of FORBIDDEN_IMPORTS) {
          expect(
            new RegExp(`\\b${forbidden.name}\\b`).test(line),
            `${file} imports ${forbidden.name}, which ${forbidden.why}. ` +
              "If this surface is meant to gain that capability, argue it in " +
              "docs/AGENT-LIMITS.md before adding the import.",
          ).toBe(false);
        }
      }
    }
  });

  it("imports none of the modules whose whole purpose is to write", () => {
    for (const { file, text } of files) {
      for (const line of importLines(text)) {
        for (const mod of FORBIDDEN_MODULES) {
          expect(
            line.includes(`"${mod}"`),
            `${file} imports ${mod}; see docs/AGENT-LIMITS.md.`,
          ).toBe(false);
        }
      }
    }
  });

  it("reaches the approvals module only through its request path", () => {
    // `requestPayment` and `getPayment` are the two the write tool needs.
    // `@/lib/approvals` re-exports the decide and release paths as well, so
    // the import being NAMED is what keeps the capability out.
    const gateway = files.find((f) => f.file === "gateway.ts");
    expect(gateway).toBeDefined();
    const approvals = importLines(gateway?.text ?? "").filter((l) =>
      l.includes('"@/lib/approvals"'),
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatch(/getPayment/);
    expect(approvals[0]).toMatch(/requestPayment/);
    expect(approvals[0]).not.toMatch(/\bapprove|\brelease|\breject|\bcancel/);
  });

  it("reaches disputes past the barrel, at the read-only store", () => {
    // The gateway needs `listDisputeStates` and `listDisputeEvents`. Both are
    // in `@/lib/disputes/store`, which also holds `insertDispute`; the barrel
    // next door re-exports the module that calls `postEntry`. This asserts the
    // import is spelled the way that keeps `ledger/post.ts` out of the graph.
    const gateway = files.find((f) => f.file === "gateway.ts");
    const disputes = importLines(gateway?.text ?? "").filter((l) =>
      l.includes("@/lib/disputes"),
    );
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toContain('"@/lib/disputes/store"');
    expect(disputes[0]).toMatch(/listDisputeStates/);
    expect(disputes[0]).toMatch(/listDisputeEvents/);
    expect(disputes[0]).not.toMatch(/insert|open|close|raise/i);
  });

  it("takes nothing from the accrual module but pure arithmetic", () => {
    // `@/lib/accrual/types` has no database handle, no `server-only` and no
    // imports of its own beyond zod. `explainAllocation` renders integers the
    // ledger already stored; it cannot post anything. Everything else about
    // accrual on this surface is scoped SQL in the gateway.
    for (const { file, text } of files) {
      for (const line of importLines(text)) {
        if (!line.includes("@/lib/accrual")) continue;
        expect(
          line.includes('"@/lib/accrual/types"'),
          `${file} imports accrual from somewhere other than the pure types module: ${line}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the refusal catalogue free of imports entirely", () => {
    // `limits.ts` is a list of operations that write. The one way it could
    // become dangerous is by importing one of them for a type, so it imports
    // nothing at all and this asserts it rather than trusting the diff.
    const limits = files.find((f) => f.file === "limits.ts");
    expect(limits).toBeDefined();
    expect(importLines(limits?.text ?? "")).toHaveLength(0);
  });
});
