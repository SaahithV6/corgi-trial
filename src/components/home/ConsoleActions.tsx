import Link from "next/link";
import type { ReactNode } from "react";

import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * The three places money work starts, as three large targets.
 *
 * ============================================================================
 * Every one of these is a typed `<Link>`, and that is the honesty check.
 * ============================================================================
 *
 * `next.config.ts` sets `typedRoutes: true`, so `<Link href="/payments">` does
 * not compile unless that route's `page.tsx` exists in this tree. A card on the
 * front door offering to raise a payment therefore cannot outlive the screen
 * that raises one: the build fails first. That is the same discipline the
 * console's nav keeps by rendering unbuilt sections as plainly disabled text,
 * and the same one `ScreenLinks.test.ts` enforces by walking `src/app` and
 * asserting every href it names resolves to a file.
 *
 * The loop these three describe is the point. A payment is RAISED on one
 * screen, DECIDED on another, and the two cannot be the same person — not
 * because these cards say so, but because `assert_maker_checker()` raises
 * SQLSTATE 42501 when they are.
 */

const CARD =
  `block rounded-md border border-border bg-surface-raised px-4 py-4 ` +
  `hover:border-border-strong ${FOCUS_RING}`;

function Title({ children }: { readonly children: string }) {
  return (
    <span className="text-sm font-semibold tracking-tight underline underline-offset-4">
      {children}
    </span>
  );
}

function Body({ children }: { readonly children: ReactNode }) {
  return (
    <span className="mt-1.5 block text-xs leading-relaxed text-muted">
      {children}
    </span>
  );
}

export function ConsoleActions() {
  return (
    <section
      aria-labelledby="console-actions-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-5 py-4">
        <h2
          id="console-actions-heading"
          className="text-sm font-semibold tracking-tight"
        >
          Move money
        </h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          Everything below is a real screen with real controls. Money out is
          raised in one place and decided in another, by two different people,
          because the database refuses it otherwise.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 px-5 py-5 sm:grid-cols-3">
        <Link href="/payments" className={CARD}>
          <Title>Raise a payment</Title>
          <Body>
            Prepare money out: amount, rail, destination, value date. The
            instruction is hashed over exactly those fields, so an approval
            applies to this amount and this beneficiary and to nothing else —
            change one and it is a different instruction. What you raise here
            lands in the queue above for somebody else to decide.
          </Body>
        </Link>

        <Link href="/approvals" className={CARD}>
          <Title>Approve or reject</Title>
          <Body>
            The full queue, with the policy version each row was judged under.
            You can never approve what you raised: the trigger refuses it with
            SQLSTATE 42501, whatever the screen shows.
          </Body>
        </Link>

        <Link href="/accounts" className={CARD}>
          <Title>Open an account</Title>
          <Body>
            Both balances, every hold with its arithmetic — authorised, cleared,
            remaining — and the postings behind them. Nothing is a stored
            column.
          </Body>
        </Link>
      </div>
    </section>
  );
}
