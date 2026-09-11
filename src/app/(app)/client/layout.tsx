import type { ReactNode } from "react";

import { readRole, ROLE_LABEL } from "@/components/app-shell/role";

/**
 * The client surface's own shell.
 *
 * A nested layout under `(app)`, so these five screens keep the console's
 * header and the provider-health banner and add one thing of their own: a
 * standing statement of what this surface is and, more importantly, what it is
 * not. It is rendered on every client screen rather than on a landing page,
 * because the screen a stranger deep-links into is the screen that has to
 * explain itself.
 *
 * ===========================================================================
 * WHY THIS SITS INSIDE THE STAFF CONSOLE AND SAYS SO
 * ===========================================================================
 *
 * This build has no authentication of any kind — `docs/DEMO.md` §1, "There is
 * nothing to sign into". Rendering a customer surface behind a fake login, or
 * on its own origin with the same open access, would be dressing up a boundary
 * that is not there. So `/client` is honestly what it is: the customer's VIEW,
 * rendered by an open console, with the isolation that matters — the query
 * predicate — already real, and the isolation that is not yet real named out
 * loud rather than implied by chrome.
 *
 * The thing that would be dishonest is the opposite: a surface that looks
 * sealed and is not.
 */
export default async function ClientLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const role = await readRole();

  return (
    <div className="space-y-6">
      <aside
        aria-label="About this surface"
        className="rounded-lg border border-dashed border-border-strong px-4 py-3"
      >
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Customer view · one business
        </p>
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
          These five screens are the bank&rsquo;s customer speaking to their own
          money: one business, their words, no chart-of-accounts codes and no
          other customer&rsquo;s figures anywhere on the page. Every read is
          scoped inside the query, by a <code>WHERE business_id</code> predicate
          the database applies — never by a filter this screen runs afterwards.
        </p>
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
          <strong className="font-medium text-text">
            The business selector is a demo control, not a login.
          </strong>{" "}
          This deployment has no authentication, and the console it sits in is
          open to anyone with the URL. Choosing a business here changes the
          subject of a query; it grants nothing that <code>/accounts</code> does
          not already show a stranger. When a session claim replaces it, one
          line changes — where the id comes from — because every read beneath it
          already treats the id as a predicate rather than as permission.
        </p>
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
          You are acting as{" "}
          <strong className="font-medium text-text">{ROLE_LABEL[role]}</strong>,
          a Corgi staff actor, because the role switcher resolves staff and only
          staff: <code>WHERE kind = &lsquo;human&rsquo; AND business_id IS NULL</code>.
          The customer&rsquo;s own signer exists on this book and is deliberately
          not reachable from it — a bank employee and a customer signer are
          different principals. See <code>docs/CLIENT.md</code>.
        </p>
      </aside>

      {children}
    </div>
  );
}
