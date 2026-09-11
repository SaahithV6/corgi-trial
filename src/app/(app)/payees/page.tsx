import type { Metadata } from "next";
import { Suspense } from "react";

import type { BusinessChoice } from "@/components/payees/AddPayeeForm";
import type { PayeeDataSource } from "@/components/payees/data-contract";
import { PayeeBookView, PayeeSkeleton } from "@/components/payees/PayeeBookView";
import { PayeeStateBar } from "@/components/payees/PayeeStateBar";
import { fixtureSource } from "@/components/payees/fixtures";
import { createUnreadablePayeeSource } from "@/components/payees/unreadable";
import { parsePayeeFilter, type DemoState } from "@/components/payees/view-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Payees · Corgi ops console",
  description:
    "The payee book: routing-number arithmetic, what the directory said, and who signed for a name that did not match.",
};

/**
 * Never prerendered.
 *
 * Freshness here is derived from when a check ran, not stamped at build time,
 * and a payee verified six months ago is a different fact from one verified
 * today. Baking either into a build artefact would put a deploy-time answer on
 * a page that is read as current.
 */
export const dynamic = "force-dynamic";

/**
 * Which businesses a payee may be added to.
 *
 * READ HERE AND NOT IN THE COMPONENT, because nothing under
 * `src/components/payees/**` opens a connection — the same seam the data
 * contract keeps for the book itself. It is also the switch that turns the
 * operator actions on: the list is only fetched for the live state, and an
 * empty list is what makes `PayeeBookView` render read-only.
 *
 * THE IMPORT IS DYNAMIC AND THE CALLER HAS ALREADY ESTABLISHED A DATABASE.
 * `@/lib/payees/store` reaches `@/lib/ledger/db` -> `@/lib/env`, which parses
 * `process.env` at module scope and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. As a top-level import it took the whole page module down
 * with it; see `selectSource` below for the full account.
 *
 * FAILURE IS EMPTY, NOT A THROW. A database that cannot answer this question
 * is one that cannot accept a payee either, so the honest page is the book
 * without an add form rather than an error boundary over the whole screen —
 * and the book's own read has its own error state, which is the one that
 * should be seen. The catch does not swallow: an empty list is rendered, as a
 * book nobody can write to.
 */
async function addableBusinesses(): Promise<readonly BusinessChoice[]> {
  try {
    const { loadBusinessOptions } = await import("@/lib/payees/store");
    return await loadBusinessOptions();
  } catch {
    return [];
  }
}

/**
 * `/payees` — destination validation before the money leaves.
 *
 * RENDERING RUNS NO CHECKS. Running one is an operator action: it has an actor
 * attached and an append-only row at the end of it. A page that called Increase
 * and Plaid because somebody hit reload would be both a bill and a lie about
 * when the check happened — so the live source reads the book, and the check
 * itself lives behind a form.
 *
 * THE FORMS ARE ON THE LIVE STATE ONLY. Four of the five demo states are
 * fixtures, and a fixture that could be written to would be neither a fixture
 * nor a book. The add, re-check and signature actions all resolve their own
 * actor on the server and write against the live database, so they are
 * rendered only where the ids around them are real.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the book is
 * replaced by the refusal panel, and no payee, tile, refusal row or add form is
 * drawn. See `selectSource` below for what this page used to do instead.
 */
export default async function PayeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parsePayeeFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and the view's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();
  const live = filter.state === "default" && !noDatabase;
  const source = await selectSource(filter.state, noDatabase);
  const businesses = live ? await addableBusinesses() : [];

  return (
    <div className="space-y-6">
      <PayeeStateBar filter={filter} noDatabase={noDatabase} />
      <Suspense fallback={<PayeeSkeleton />}>
        <PayeeBookView
          source={source}
          filter={filter}
          businesses={businesses}
          noDatabase={noDatabase}
        />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default`, fixture for everything else — and a REFUSAL for
 * `default` when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS PAGE USED TO DO, AND WHY IT WAS WORSE THAN THE FIVE SCREENS
 * REPAIRED BEFORE IT. Those had a guard that could not run. This one had no
 * guard at all: `loadBusinessOptions` and `livePayeeSource` were imported at
 * the TOP of this file, both reach `@/lib/ledger/db` -> `@/lib/env`, and that
 * module throws `EnvironmentError` while it is being evaluated. So the PAGE
 * MODULE failed to load and there was nowhere for a fallback to live. Measured
 * with the variable deleted, nothing on this screen rendered — not the book,
 * not the state bar, not an error state of its own — and the operator got the
 * framework's error page.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/payees/unreadable`, which `PayeeBookView` renders the same way
 * it renders a failed read: no payee, no tile, no refusal row. "I cannot see
 * the payee book" and "this customer has no beneficiaries" are different
 * screens, and so are "no warning is outstanding" and "no warning was read".
 */
async function selectSource(
  state: DemoState,
  noDatabase: boolean,
): Promise<PayeeDataSource> {
  if (state !== "default") {
    // A demo state stays a fixture whether or not a database is configured:
    // those four are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return fixtureSource(state);
  }

  if (noDatabase) return createUnreadablePayeeSource();

  const { livePayeeSource } = await import("@/lib/payees/screen");
  return livePayeeSource();
}
