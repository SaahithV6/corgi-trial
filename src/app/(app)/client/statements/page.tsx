import { Suspense } from "react";
import type { Metadata } from "next";

import {
  ClientErrorPanel,
  ClientSkeleton,
} from "@/components/client/Chrome";
import { StatementsClientView } from "@/components/client/statements/StatementsClientView";
import { parseClientView, type ClientView } from "@/components/client/view-state";
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Your statements · Corgi",
};

/**
 * Never prerendered.
 *
 * This page rebuilds a statement from the ledger twice and compares the two
 * hashes. Baking that into a static artefact at build time would either freeze
 * a verification that is only meaningful when it is performed NOW, or fail the
 * build on a machine with no database.
 */
export const dynamic = "force-dynamic";

/**
 * `/client/statements` — the customer reading their own closed days.
 *
 * ===========================================================================
 * THE GAP THIS FILLS
 * ===========================================================================
 *
 * Statements were operator-only. `/statements` is a superb screen for the
 * person who issued the document — two readings side by side, four booking
 * anchors, version lineage — and it is addressed to a Corgi employee. The
 * customer whose money it is could not open their own statement at all, which
 * on a product whose v1 scope lists statements is a hole rather than a
 * refinement.
 *
 * This screen is deliberately NOT that screen with a different stylesheet. The
 * operator needs "what did we tell them, and what do we know now"; the customer
 * needs "what happened on my account that day, and can I rely on it". So it
 * opens on the LATEST issued version rather than v1, it has no anchor control,
 * and the correction is stated in the customer's language on the face of the
 * document instead of being an itemised delta between two columns.
 *
 * ===========================================================================
 * URL STATE
 * ===========================================================================
 *
 *   ?business=<uuid>  whose book. The same demo control the rest of `/client`
 *                     uses, and the same caveat applies: it is a predicate in
 *                     Postgres, not a permission. See `view-state.ts`.
 *   ?day=YYYY-MM-DD   which closed day. VALIDATED against this account's own
 *                     list of closed days in `source.ts` before it reaches a
 *                     query — a date from a query string is never passed
 *                     through, and a day this account has nothing on renders
 *                     the default period rather than an empty document with a
 *                     stranger's date on it.
 *
 * There is no `?state=` here. The five demo states on the rest of this surface
 * exist to show a screen's empty and error shapes without arranging them live;
 * this screen's entire claim is that the hashes on it were computed on this
 * request, and a fixture that printed a reproduction would be exactly the
 * defect `/statements` was caught with — HASH REPRODUCED, rendered with no
 * database connection open. The empty and closed-not-issued states are real
 * states of a real book here and are reachable by picking the day.
 *
 * With no database the page renders a refusal and no document, so there is no
 * hash on the page to be wrong about.
 */
export default async function ClientStatementsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const view = parseClientView(resolved);
  const day = businessDateParam(resolved);

  if (!hasDatabase()) {
    return (
      <ClientErrorPanel
        code="NO_DATABASE"
        message="This deployment has no database configured, so no statement can be rebuilt or checked. Nothing on this page is derived from stored figures."
      />
    );
  }

  return (
    <Suspense key={`${view.businessId ?? ""}:${day ?? ""}`} fallback={<ClientSkeleton rows={6} />}>
      <StatementsSection view={view} day={day} />
    </Suspense>
  );
}

async function StatementsSection({
  view,
  day,
}: {
  readonly view: ClientView;
  readonly day: string | null;
}) {
  // Imported dynamically: importing the reader evaluates `src/lib/env.ts`,
  // which refuses to load without a full set of keys — right for the app, wrong
  // for a page that must be able to render "no database configured".
  const { readClientStatements } = await import("./source");
  const loaded = await readClientStatements(view.businessId, day);

  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }

  const business = loaded.value.businessId;
  return (
    <StatementsClientView
      screen={loaded.value}
      hrefFor={(businessDate) =>
        `/client/statements?business=${encodeURIComponent(business)}&day=${encodeURIComponent(businessDate)}`
      }
    />
  );
}

/** `YYYY-MM-DD` and nothing else. Anything else is `null` and the reader picks. */
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

function businessDateParam(
  params: Record<string, string | string[] | undefined>,
): string | null {
  const raw = params["day"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && BUSINESS_DATE.test(value) ? value : null;
}
