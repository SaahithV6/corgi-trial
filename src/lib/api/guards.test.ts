/**
 * THE GUARDS. Three of them, and each one exists because the property it
 * checks is otherwise a fact about today's diff rather than a control.
 *
 *   1. no file on this surface imports a function that writes;
 *   2. no route declares a parameter that would take its scope from the
 *      caller instead of from the token;
 *   3. every route file under src/app/api/v1/** goes through `handle()`,
 *      which is the only place authentication happens.
 *
 * Deliberately greps rather than type-level tricks. The thing being prevented
 * in each case is a future contributor writing an ordinary-looking line, and
 * the check that catches that is the one that reads the lines.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { FORBIDDEN_QUERY_PARAMETERS } from "./http";
import { API_REFUSALS, inheritedRefusals } from "./limits";

const ROOT = process.cwd();
const LIB = join(ROOT, "src", "lib", "api");
const ROUTES = join(ROOT, "src", "app", "api", "v1");

/**
 * Every write this surface refuses, as the identifier that performs it.
 *
 * A superset of `src/lib/mcp/no-write-imports.test.ts`'s list — the HTTP
 * surface inherits every agent refusal and adds the statement writers, which
 * the agent surface never had a reader near. Each entry names its section so a
 * failure tells the person who caused it where the argument lives.
 */
const FORBIDDEN_IMPORTS: readonly { readonly name: string; readonly why: string }[] = [
  // The ledger itself (AGENT-LIMITS §8, API §A6).
  { name: "postEntry", why: "posts a journal entry — AGENT-LIMITS §8" },
  { name: "reverseAndRebook", why: "corrects the ledger — AGENT-LIMITS §8, API §A6" },
  // Approval and release (§1, §2, API §A8).
  { name: "approvePayment", why: "approves an instruction — API §A8" },
  { name: "rejectPayment", why: "decides an instruction — API §A8" },
  { name: "cancelPayment", why: "decides an instruction — API §A8" },
  { name: "releasePayment", why: "calls the rail — AGENT-LIMITS §1" },
  // Statements and the book day (§6, API §A7). NEW on this surface: the HTTP
  // API reads statements, so it sits one import away from publishing one.
  { name: "closeDay", why: "freezes the watermark every statement derives from — API §A7" },
  { name: "publishStatement", why: "tells a customer what their money did — API §A7" },
  { name: "reissueStatement", why: "issues a corrected document — API §A7" },
  // Cards (§7, §13, API §A1).
  { name: "setCardControls", why: "changes a real-time auth decision — API §A1" },
  // Payees (§11, §12, API §A8).
  { name: "savePayee", why: "writes the payee book — AGENT-LIMITS §12" },
  { name: "acknowledgeWarning", why: "signs off a name-match warning — API §A8" },
  { name: "archivePayee", why: "changes the payee book — AGENT-LIMITS §12" },
  { name: "recordVerification", why: "writes a verification record — AGENT-LIMITS §11" },
  { name: "confirmPayee", why: "runs and records a payee check — AGENT-LIMITS §12" },
  // Standing orders (§10, §14, API §A6).
  { name: "createStandingOrder", why: "creates recurring authority — API §A6" },
  { name: "cancelStandingOrder", why: "amends a mandate — AGENT-LIMITS §10" },
  { name: "runStandingOrders", why: "fires occurrences — AGENT-LIMITS §14" },
  // Pots (§15, API §A5).
  { name: "openPot", why: "creates an account — AGENT-LIMITS §15" },
  { name: "movePotFunds", why: "posts a book transfer — API §A5" },
  // Stablecoin (§9).
  { name: "sendUsdcPayout", why: "broadcasts a transfer — AGENT-LIMITS §9" },
  { name: "signTransaction", why: "signs with the payout key — AGENT-LIMITS §9" },
  { name: "settleTransaction", why: "books an on-chain settlement — AGENT-LIMITS §9" },
  // KYB (§16, API §A8).
  { name: "manualReviewLeg", why: "decides a KYB review — API §A8" },
  // Disputes and provisional credit (§17, §18).
  { name: "raiseDispute", why: "opens a case and starts the network clock — AGENT-LIMITS §17" },
  { name: "insertDispute", why: "writes the case row directly — AGENT-LIMITS §17" },
  { name: "grantProvisionalCredit", why: "advances the bank's money — AGENT-LIMITS §18" },
  { name: "clawBackCredit", why: "takes money back off a customer — AGENT-LIMITS §18" },
  // Accrual (§19, §20).
  { name: "runAccrual", why: "posts the daily fee — AGENT-LIMITS §20" },
  { name: "runInterest", why: "posts the daily interest — AGENT-LIMITS §20" },
  // Webhooks and simulators (API §A3).
  { name: "handleWebhookRequest", why: "writes the provider's side of the books — API §A3" },
  { name: "simulateAuthorization", why: "manufactures a card authorisation — API §A3" },
];

/**
 * Modules no file here may import at all, write function or not.
 *
 * The barrels are the entries worth explaining: `@/lib/disputes` re-exports
 * `./operations` and `@/lib/accrual` re-exports `./accrue`, and both of those
 * import `postEntry`. A NAMED import from a barrel makes nothing new callable
 * — but it puts `ledger/post.ts` into this process's module graph, and "the
 * public API does not import ledger/post.ts" is the strongest sentence in
 * docs/API.md.
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
  "@/lib/statements/publish",
  "@/lib/webhooks/route-handler",
  "@/lib/chaos",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function sourceFiles(): { readonly file: string; readonly text: string }[] {
  return [...walk(LIB), ...walk(ROUTES)]
    .filter((p) => !p.endsWith(".test.ts"))
    .map((p) => ({
      file: relative(ROOT, p).split(sep).join("/"),
      text: readFileSync(p, "utf8"),
    }));
}

/**
 * The import statements only.
 *
 * Matched precisely rather than by splitting the file, because this surface is
 * full of prose that NAMES the forbidden functions — that is the point of the
 * comments — and a guard that cannot tell `releasePayment` in a paragraph from
 * `releasePayment` in an import is a guard that forces people to stop writing
 * the paragraphs.
 */
function importLines(text: string): string[] {
  const matches = text.match(/^[ \t]*import\b[\s\S]*?from\s+"[^"]+";/gm) ?? [];
  return matches.map((chunk) => chunk.replace(/\s+/g, " "));
}

describe("the public API imports nothing that writes", () => {
  const files = sourceFiles();

  it("has source files to check at all", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(15);
    expect(files.map((f) => f.file)).toContain("src/lib/api/handle.ts");
    expect(files.map((f) => f.file)).toContain("src/app/api/v1/payments/route.ts");
  });

  it("imports no write entry point by name", () => {
    for (const { file, text } of files) {
      for (const line of importLines(text)) {
        for (const forbidden of FORBIDDEN_IMPORTS) {
          expect(
            new RegExp(`\\b${forbidden.name}\\b`).test(line),
            `${file} imports ${forbidden.name}, which ${forbidden.why}. If this surface is meant to gain that capability, argue it in docs/API.md before adding the import.`,
          ).toBe(false);
        }
      }
    }
  });

  it("imports none of the modules whose whole purpose is to write", () => {
    for (const { file, text } of files) {
      for (const line of importLines(text)) {
        for (const mod of FORBIDDEN_MODULES) {
          expect(line.includes(`"${mod}"`), `${file} imports ${mod}; see docs/API.md.`).toBe(false);
        }
      }
    }
  });

  it("reaches the approvals module only through its request and read paths", () => {
    for (const { file, text } of files) {
      for (const line of importLines(text)) {
        if (!/"@\/lib\/approvals/.test(line)) continue;
        expect(
          /\bapprove|\brelease|\breject|\bcancel/.test(line),
          `${file} imports a decision path from approvals: ${line}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the refusal catalogue free of anything but the catalogue it inherits", () => {
    const limits = files.find((f) => f.file === "src/lib/api/limits.ts");
    expect(limits).toBeDefined();
    const lines = importLines(limits?.text ?? "");
    // Exactly one import, and it is the MCP catalogue, which itself imports
    // nothing. A list of operations that write must not become the module that
    // makes one of them reachable.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"@/lib/mcp/limits"');
  });
});

/**
 * Every name a route handler reads off the query string.
 *
 * Two sources, and both have to agree with each other by construction: the
 * allowlist handed to `rejectUnknownParams`, and the literal passed to each
 * typed reader (`stringParam(url, "rail")` and friends). A name that appears
 * in one and not the other is either an undeclared read or a dead entry, and
 * both are worth catching.
 */
function declaredQueryParams(text: string): readonly string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b\w*[Pp]aram\(\s*(?:ctx\.)?url\s*,\s*"([^"]+)"/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  for (const match of text.matchAll(/rejectUnknownParams\(\s*ctx\.url\s*,\s*\[([^\]]*)\]/g)) {
    for (const quoted of (match[1] ?? "").matchAll(/"([^"]+)"/g)) {
      const name = quoted[1];
      if (name !== undefined) names.add(name);
    }
  }
  // `const ACCEPTED = [...] as const` handed to rejectUnknownParams.
  for (const match of text.matchAll(/const ACCEPTED\s*=\s*\[([\s\S]*?)\]\s*as const/g)) {
    for (const quoted of (match[1] ?? "").matchAll(/"([^"]+)"/g)) {
      const name = quoted[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
}

describe("no endpoint takes its scope from the caller", () => {
  const files = sourceFiles();

  it("declares none of the forbidden parameter names", () => {
    // The tenant boundary written as data. A route that accepted any of these
    // would be taking its scope from the caller instead of from the token, and
    // the reviewer who added it would have had no reason to think twice.
    //
    // Matched against the names a route actually READS OFF THE URL, not
    // against every string in the file: `businessId: ctx.grant.businessId` is
    // a property on an object built FROM the token, which is the opposite of
    // the thing being prevented, and a guard that cannot tell those apart is
    // one that forces the scoping code to be written badly.
    const handlers = files.filter((f) => f.file.startsWith("src/lib/api/routes/"));
    expect(handlers.length).toBeGreaterThan(4);

    for (const { file, text } of handlers) {
      for (const name of declaredQueryParams(text)) {
        expect(
          (FORBIDDEN_QUERY_PARAMETERS as readonly string[]).includes(name),
          `${file} reads the query parameter "${name}" off the URL. Scope comes from the token; no endpoint may accept a business, account, entity or actor identifier from a caller.`,
        ).toBe(false);
      }
      expect(
        /searchParams\.get\(/.test(text),
        `${file} reads searchParams directly instead of going through the typed helpers, which is how an undeclared parameter gets read without appearing in an allowlist`,
      ).toBe(false);
    }
  });

  it("passes an explicit allowlist of query parameters on every route handler", () => {
    const handlers = files.filter((f) => f.file.startsWith("src/lib/api/routes/"));
    expect(handlers.length).toBeGreaterThan(4);
    for (const { file, text } of handlers) {
      expect(
        text.includes("rejectUnknownParams"),
        `${file} never calls rejectUnknownParams, so an unknown query parameter would be silently ignored. A caller quietly served their own data after sending a filter that did nothing walks away believing it worked.`,
      ).toBe(true);
    }
  });
});

describe("every route goes through the one gate", () => {
  const routeFiles = sourceFiles().filter((f) => f.file.startsWith("src/app/api/v1/"));

  it("found the route files", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(12);
  });

  it("calls handle() and constructs no deps of its own", () => {
    for (const { file, text } of routeFiles) {
      expect(text.includes("handle(request"), `${file} does not call handle()`).toBe(true);
      expect(
        text.includes("liveGateway("),
        `${file} constructs a gateway directly; it must go through apiDeps() so the token config, limiter and audit sink are the shared ones`,
      ).toBe(false);
    }
  });

  it("pins the node runtime and refuses caching", () => {
    for (const { file, text } of routeFiles) {
      expect(text.includes('runtime = "nodejs"'), `${file} does not pin the node runtime`).toBe(
        true,
      );
      expect(
        text.includes('dynamic = "force-dynamic"'),
        `${file} does not opt out of caching; a cached answer about someone's money is a wrong answer about it`,
      ).toBe(true);
    }
  });

  it("exports POST from exactly one route, and it is the payment queue", () => {
    const writers = routeFiles.filter((f) => /export async function POST\b/.test(f.text));
    expect(writers.map((f) => f.file)).toEqual(["src/app/api/v1/payments/route.ts"]);
  });

  it("exports no PUT, PATCH or DELETE anywhere", () => {
    for (const { file, text } of routeFiles) {
      for (const verb of ["PUT", "PATCH", "DELETE"]) {
        expect(
          new RegExp(`export (async )?function ${verb}\\b`).test(text),
          `${file} exports ${verb}. Nothing on this surface edits or removes anything: every record of a fact in this schema is append-only.`,
        ).toBe(false);
      }
    }
  });

  it("marks the payment route as a write so the small write budget applies", () => {
    const payments = routeFiles.find((f) => f.file === "src/app/api/v1/payments/route.ts");
    expect(payments?.text).toMatch(/readOnly:\s*false/);
    for (const { file, text } of routeFiles) {
      if (file === "src/app/api/v1/payments/route.ts") continue;
      expect(text, `${file} should be readOnly: true`).toMatch(/readOnly:\s*true/);
    }
  });
});

describe("the refusal register describes the surface that exists", () => {
  const routeFiles = sourceFiles().filter((f) => f.file.startsWith("src/app/api/v1/"));

  it("names no METHOD-and-PATH that actually exists", () => {
    // The entries in API_REFUSALS are promises that a thing is absent. If one
    // of them ever becomes a real route, this fails rather than the
    // documentation quietly becoming a lie.
    //
    // The METHOD is half the claim, and the half that is easy to get wrong:
    // `GET /api/v1/statements` exists and `POST /api/v1/statements` does not,
    // and a check that compared paths alone would either pass vacuously or
    // fail on a route that is fine.
    const byPath = new Map(
      routeFiles.map((f) => [
        f.file.replace(/^src\/app/, "").replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}"),
        f.text,
      ]),
    );
    for (const refusal of API_REFUSALS) {
      for (const endpoint of refusal.absentEndpoints) {
        // NOT `split(/\s+/, 2)`: JavaScript's limit TRUNCATES the array rather
        // than capping the number of splits, so the tail — the part that says
        // this entry is about a payload and not a path — would be silently
        // discarded and every such entry would be checked as a path.
        const firstSpace = endpoint.indexOf(" ");
        if (firstSpace < 0) continue;
        const method = endpoint.slice(0, firstSpace);
        const rawPath = endpoint.slice(firstSpace + 1).trim();
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) continue;
        // Entries like `POST /api/v1/payments with rail "internal"` describe a
        // constrained REQUEST rather than an absent path; the path itself
        // exists and must. Those are asserted separately, below, against the
        // schema that refuses them.
        if (/\s/.test(rawPath)) continue;
        const path = (rawPath.split("?")[0] ?? "").trim();
        const text = byPath.get(path);
        if (text === undefined) continue; // no route file at all: absent.
        expect(
          new RegExp(`export (async )?function ${method}\\b`).test(text),
          `${refusal.ref} claims ${endpoint} does not exist, but that route file exports ${method}.`,
        ).toBe(false);
      }
    }
  });

  it("refuses the internal rail in the schema, which is what A5 promises", () => {
    // A5 is a refusal about a payload, so the mechanism is the enum rather
    // than an absent file. Asserted directly: `internal` must not be an
    // accepted rail, because its seeded policy requires zero approvals and it
    // would be the one instruction here releasable with nobody having approved.
    const payments = readFileSync(join(LIB, "routes", "payments.ts"), "utf8");
    // The trailing `)` is deliberately NOT anchored: `z.enum([...])` may carry
    // a second argument (the custom `error` message that tells an integrator
    // `internal` is refused rather than misspelt), and a regex that required
    // `])` went red for the message rather than for the rail list — a guard
    // failing about its own regex instead of about the thing it stands for.
    const railEnum = /rail:\s*z\.enum\(\[([^\]]*)\]/.exec(payments)?.[1] ?? "";
    expect(railEnum).not.toBe("");
    expect(railEnum).not.toContain("internal");
    expect(railEnum).not.toContain("card");
    expect(railEnum).toContain("ach");
  });

  it("carries an enforcement mechanism and a forward path for every refusal", () => {
    for (const refusal of [...API_REFUSALS]) {
      expect(refusal.enforcedBy.length, `${refusal.ref} cites no enforcement`).toBeGreaterThan(0);
      expect(refusal.instead.length, `${refusal.ref} offers no forward path`).toBeGreaterThan(40);
      expect(refusal.why.length, `${refusal.ref} has no argument`).toBeGreaterThan(200);
    }
  });

  it("inherits every agent-surface refusal rather than restating any", () => {
    // At least as strict, never less. If AGENT-LIMITS grows a section, this
    // surface gets it for free — and if someone deletes one, this notices.
    expect(inheritedRefusals().length).toBeGreaterThanOrEqual(20);
    const sections = new Set(inheritedRefusals().map((r) => r.section));
    for (const refusal of API_REFUSALS) {
      for (const sharpened of refusal.sharpens) {
        expect(
          sections.has(sharpened),
          `${refusal.ref} claims to sharpen AGENT-LIMITS §${sharpened}, which does not exist`,
        ).toBe(true);
      }
    }
  });
});
