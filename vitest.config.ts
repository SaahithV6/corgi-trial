import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// ===========================================================================
// "2,556 passed" IS TRUE AND IT IS SILENT ABOUT 381 TESTS
// ===========================================================================
//
// The plain run of this suite read `2,556 passed / 381 skipped`, and in the
// 381 were EVERY database-backed suite and ALL EIGHT live-fire attacks — the
// hold model, the bitemporal correction, maker-checker, the breaks screen.
// Nothing in the output said so. The qualification lived in a document, and
// the number lived in the terminal, and only one of the two is read.
//
// That is this codebase's defining failure in its most ordinary form: a
// figure that reports healthy about a population it excludes. The same shape
// as `v_standing_order_double_fire` joining a UNIQUE column, as GUARD REACH
// measuring `hold_closure` instead of the guard's own predicate, as a KYB
// requirement scored against a summary of the brief instead of the brief.
//
// THE FIX IS NOT TO RUN THEM IN CI. CI holds no provider credentials and no
// database URL, deliberately, so that this repository builds on a fork and
// so that a green tick is never bought with a secret. That decision stands.
// The fix is that the SKIP IS NOW PRINTED NEXT TO THE NUMBER, every run, with
// the count, the reason and the command that does run them — and that the
// command exists, is documented in docs/TESTING.md, and is run before
// submission.
//
// The reporter below is deliberately not a list of suites. A hand-typed list
// is what GUARD REACH was, and it was wrong by ten rows. It reads the gate
// out of each skipped file's own source and reports what THIS environment did
// not provide, so a new gated suite appears in the output the first time it
// is skipped, without anybody remembering to add it.

/** The shape of a vitest task tree, to the depth this reporter walks it. */
interface TaskLike {
  type?: string;
  mode?: string;
  tasks?: TaskLike[];
  result?: { state?: string } | undefined;
}
interface FileLike extends TaskLike {
  filepath?: string;
}

/**
 * The `process.env` names a file GATES ON — not every name it reads.
 *
 * The distinction earns its keep. `attack-07` reads `LIVEFIRE_OUTAGE_SECONDS`
 * and `LIVEFIRE_BASE_URL`, and neither has anything to do with whether the
 * attack runs: one tunes the length of the dark window, the other overrides a
 * URL that already has a default. Reporting those as "what this environment
 * did not provide" would be the same species of untruth as the count this
 * reporter exists to qualify — a list padded with things that are not the
 * reason, which teaches the reader to stop reading the list.
 *
 * Two mechanical signals, both read out of the file:
 *
 *   (a) the name is COMPARED on its own line — `=== "1"`, `!== ""`,
 *       `typeof … !== "string"`. A comparison is a decision.
 *   (b) the name is defaulted to the EMPTY string — `?? ""`. That is this
 *       codebase's idiom for "a credential I may not hold", and the emptiness
 *       is then tested one line later against a const.
 *
 * A read with a real default (`?? "https://httpbin.org/post"`) is a knob, not
 * a gate, and is left out.
 */
function gateNamesIn(source: string): string[] {
  const found = new Set<string>();
  const ref = /process\.env(?:\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]|\.([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const line of source.split("\n")) {
    ref.lastIndex = 0;
    let m: RegExpExecArray | null = ref.exec(line);
    while (m !== null) {
      const name = m[1] ?? m[2];
      if (name !== undefined) {
        const before = line.slice(0, m.index);
        const after = line.slice(m.index + m[0].length);
        const compared = /^[^;]{0,40}(?:===|!==|==|!=)/.test(after) || /typeof\s*$/.test(before);
        const emptyDefault = /^\s*\?\?\s*["'`]["'`]/.test(after);
        if (compared || emptyDefault) found.add(name);
      }
      m = ref.exec(line);
    }
  }
  return [...found];
}

/**
 * Is this gate a FLAG the operator turns on, or a CREDENTIAL they must hold?
 *
 * Read out of the file rather than guessed from the name: a flag is compared
 * against the string "1" at its use site (`env["RUN_DB_TESTS"] === "1"`), and
 * anything else — a key, a URL — is a credential. The distinction is what
 * makes the printed command runnable: `RUN_DB_TESTS=1` is something a reader
 * can type, and `LITHIC_API_KEY=1` is not.
 */
function isFlag(source: string, name: string): boolean {
  const re = new RegExp(
    `process\\.env(?:\\[\\s*["'\`]${name}["'\`]\\s*\\]|\\.${name})\\s*[!=]==\\s*["'\`]1["'\`]`,
  );
  return re.test(source);
}

/** Count the leaf tests under a task, split by whether they ran. */
function census(task: TaskLike, into: { ran: number; skipped: number }): void {
  if (task.type === "test") {
    const state = task.result?.state;
    if (task.mode === "skip" || task.mode === "todo" || state === "skip") into.skipped += 1;
    else into.ran += 1;
    return;
  }
  for (const child of task.tasks ?? []) census(child, into);
}

const CWD = `${process.cwd()}/`;
const relative = (p: string): string => (p.startsWith(CWD) ? p.slice(CWD.length) : p);

/**
 * SKIP VISIBILITY — printed after every run, including a fully green one.
 *
 * Writes straight to stdout: `no-console` is an error in this repo outside
 * `src/lib/log.ts` and `scripts/**`, and a reporter is a terminal surface, so
 * it uses the stream the logger would have used anyway.
 */
const skipVisibility = {
  onFinished(files?: FileLike[]): void {
    const out = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    const all = files ?? [];
    if (all.length === 0) return;

    const totals = { ran: 0, skipped: 0 };
    let suitesFullySkipped = 0;
    let casesSkippedInsideRunningSuites = 0;
    // A suite that throws while it is being COLLECTED contributes nothing to
    // either number. It is not passed, it is not skipped, it is not counted —
    // the quietest form of the failure this whole reporter exists for, so it
    // is named first and separately from anything that was merely gated.
    const failedToCollect: string[] = [];

    // gate signature -> what it stopped
    const groups = new Map<
      string,
      { flags: string[]; credentials: string[]; files: string[]; tests: number }
    >();

    for (const file of all) {
      const counts = { ran: 0, skipped: 0 };
      census(file, counts);
      totals.ran += counts.ran;
      totals.skipped += counts.skipped;
      if (counts.ran === 0 && counts.skipped === 0) {
        failedToCollect.push(relative(file.filepath ?? "(unknown file)"));
        continue;
      }
      if (counts.skipped === 0) continue;

      if (counts.ran > 0) {
        // An `it.skip` / `skipIf` inside a suite that otherwise executed.
        casesSkippedInsideRunningSuites += counts.skipped;
        continue;
      }
      suitesFullySkipped += 1;

      const path = file.filepath ?? "";
      let source = "";
      try {
        source = readFileSync(path, "utf8");
      } catch {
        source = "";
      }

      // WHAT THIS ENVIRONMENT DID NOT PROVIDE. Not "what the gate is" — that
      // would need a list — but the strictly mechanical version: of the env
      // names this file reads, which ones are unset or empty right now.
      const missing = gateNamesIn(source).filter((n) => {
        const value = process.env[n];
        return value === undefined || value === "";
      });
      const flags = missing.filter((n) => isFlag(source, n)).sort();
      const credentials = missing.filter((n) => !isFlag(source, n)).sort();

      const key = `${flags.join(",")}|${credentials.join(",")}`;
      const group = groups.get(key) ?? { flags, credentials, files: [], tests: 0 };
      group.files.push(`${relative(path)} (${counts.skipped})`);
      group.tests += counts.skipped;
      groups.set(key, group);
    }

    const rule = "─".repeat(76);

    if (failedToCollect.length > 0) {
      out("");
      out(rule);
      out(`  ${failedToCollect.length} SUITE(S) RAN NO TESTS AT ALL — they failed while being loaded`);
      out(rule);
      out("");
      for (const f of failedToCollect) out(`      ${f}`);
      out("");
      out("  These are counted in neither the passed number nor the skipped number.");
      out("  A suite that throws on import is invisible to both, which is worse than");
      out("  a skip: a skip at least prints an arrow. See the failure above.");
      out("");
    }

    if (totals.skipped === 0) {
      out("");
      out(`  SKIPPED — nothing. All ${totals.ran} tests in this run executed.`);
      out("");
      return;
    }

    out("");
    out(rule);
    out(`  WHAT THIS RUN DID NOT RUN — ${totals.skipped} skipped, next to the ${totals.ran} that passed`);
    out(rule);
    out("");
    out(`  ${suitesFullySkipped} of ${all.length} suites did not execute at all.`);
    out("  A skipped test is not a passing test. Grouped by what this environment");
    out("  did not provide, read out of each suite's own source:");
    out("");

    const ordered = [...groups.values()].sort((a, b) => b.tests - a.tests);
    for (const group of ordered) {
      const named = [...group.flags, ...group.credentials];
      const label = named.length === 0 ? "skipped without naming an environment gate" : named.join("  ");
      out(`  ${label}`);
      out(`      ${group.files.length} suite(s), ${group.tests} test(s)`);
      if (group.flags.length > 0) {
        const assignments = group.flags.map((f) => `${f}=1`).join(" ");
        out(`      set -a; . ./.env; set +a; ${assignments} pnpm vitest run --no-file-parallelism \\`);
        out("          <paths below>");
      }
      if (group.credentials.length > 0) {
        out(`      and credentials this environment does not hold: ${group.credentials.join(", ")}`);
      }
      for (const f of group.files) out(`        ${f}`);
      out("");
    }

    if (casesSkippedInsideRunningSuites > 0) {
      out(
        `  ${casesSkippedInsideRunningSuites} further test(s) were skipped INSIDE suites that did run —` +
          " an it.skip or a skipIf, case by case.",
      );
      out("");
    }

    out("  WHERE THESE ACTUALLY RUN. Not in CI: this repository's CI holds no");
    out("  database URL and no provider key, on purpose, so that it builds on a");
    out("  fork and so that no green tick is ever bought with a secret. They run");
    out("  from a developer machine, against the live Neon book, and they are run");
    out("  BEFORE SUBMISSION, not instead of it:");
    out("");
    out("      pnpm test:db          every RUN_DB_TESTS suite, sequentially");
    out("      pnpm test:probes      the read-only Increase probes");
    out("      pnpm test:livefire    the eight live-fire attacks + chaos mode");
    out("      pnpm test:optin       the ones that cost something: a real Lithic");
    out("                            card, the demo pots, the httpbin round trip");
    out("      pnpm test:submission  all of the above, then dbcheck and --prove");
    out("");
    out("  Sequentially is not a style choice — see docs/TESTING.md §'Why");
    out("  --no-file-parallelism'. These suites share one live book, and run in");
    out("  parallel they fail each other on contention rather than on defects.");
    out(rule);
    out("");
  },
};

export default defineConfig({
  test: {
    globals: true,
    // Live-fire tests talk to Neon, Lithic and Increase over the network, in
    // sequence, under a 1 RPS simulate cap. 5s is the vitest default and it was
    // failing three attacks with 'Test timed out in 5000ms' and nothing else -
    // a red suite that said nothing about the system under test.
    //
    // 30s is still not enough for every attack, and the one it is not enough
    // for could not say so either: attack 07 ("turn the webhooks off for five
    // minutes") declares 60s and 90s budgets on its own inner steps, inside an
    // `it` with no timeout of its own, so its ceiling was 30s while its floor
    // was 210s. It could not pass at any speed. `pnpm test:livefire` raises the
    // timeout for that directory rather than raising it for all 2,556 tests,
    // because a global 300s turns a hung unit test into a five-minute wait.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "src/**/__tests__/**/*.{test,spec}.ts"],
    reporters: ["default", skipVisibility],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // TEST ONLY. See test/server-only-stub.ts for why this is safe.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
});
