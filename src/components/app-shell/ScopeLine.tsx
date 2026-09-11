"use client";

import { usePathname } from "next/navigation";

/**
 * Whose books are on screen, according to the URL.
 *
 * ===========================================================================
 * WHY THIS IS A COMPONENT RATHER THAN A CONSTANT
 * ===========================================================================
 *
 * `AppHeader` used to print a hard-coded business name on every page —
 * "Blue Ridge Coffee Roasters LLC", a business that does not exist on this book
 * — above tables listing seven that do, so a reader got three different answers
 * to "whose books am I looking at?" on one screen. The fix replaced it with a
 * true statement about every page beneath it: *staff console, all businesses*.
 *
 * That statement stopped being true the moment `/client` shipped. Those five
 * screens are scoped to ONE business, say so in their own header, and a bar
 * above them reading "all businesses on this book" would recreate exactly the
 * defect that was removed — the same sentence, wrong in the other direction.
 *
 * So the scope line is derived from the route rather than asserted. It is a
 * LABEL and not a boundary: what actually keeps one customer's rows away from
 * another is the `WHERE business_id = $1` predicate inside every reader the
 * client surface calls. This changes no query and grants nothing; it stops the
 * chrome contradicting the page.
 *
 * `usePathname()` rather than a prop because `AppHeader` is a server component
 * in a shared layout and has no pathname to pass — the same reason `NavLinks`
 * is a client component.
 */
export function ScopeLine() {
  const pathname = usePathname();
  const client = pathname === "/client" || pathname.startsWith("/client/");

  return (
    <span className="text-muted">
      {client
        ? "Customer view — one business, scoped in the query"
        : "Staff console — all businesses on this book"}
    </span>
  );
}
