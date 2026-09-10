import { isErr } from "@/lib/result";
import type { ErrorShape } from "@/lib/result";
import { formatTimestamp } from "@/lib/format/datetime";
import { ROLE_LABEL, readRole } from "@/components/app-shell/role";
import { MetaList } from "@/components/ui/primitives";

import { AccountSkeleton } from "./AccountSkeleton";
import { BalanceHeadline } from "./BalanceHeadline";
import { ErrorPanel } from "./ErrorPanel";
import { HoldsPanel } from "./HoldsPanel";
import { NegativeAvailableNote } from "./NegativeAvailableNote";
import { PostingsTable } from "./PostingsTable";
import type { DemoView } from "./demo-state";
import { getAccountDataSource } from "./fixtures";

export { AccountSkeleton };

/** Unreachable in practice: the branch above proves one of the three is an `Err`. */
const UNKNOWN_FAILURE: ErrorShape = {
  code: "UNKNOWN",
  message: "The account could not be loaded.",
};

/**
 * The account screen.
 *
 * An async server component behind the page's Suspense boundary: the skeleton
 * is this component's fallback, so the loading state is the real one rather
 * than a mock. It reads through `AccountDataSource` and knows nothing about
 * where the numbers come from — fixture today, `src/lib/ledger/balances.ts`
 * tomorrow, and not one line here changes.
 */
export async function AccountView({
  accountId,
  view,
}: {
  readonly accountId: string;
  readonly view: DemoView;
}) {
  const source = getAccountDataSource(view);
  const role = await readRole();

  const [summaryResult, holdsResult, postingsResult] = await Promise.all([
    source.getAccountSummary({ accountId }),
    source.listHolds({ accountId }),
    source.listPostings({ accountId, limit: 25 }),
  ]);

  // One failed query fails the screen. A page that renders a balance beside a
  // hold list that did not load is worse than one that says it could not load:
  // the two numbers would silently disagree.
  if (isErr(summaryResult) || isErr(holdsResult) || isErr(postingsResult)) {
    const failure: ErrorShape = isErr(summaryResult)
      ? summaryResult.error
      : isErr(holdsResult)
        ? holdsResult.error
        : isErr(postingsResult)
          ? postingsResult.error
          : UNKNOWN_FAILURE;

    return (
      <div className="space-y-6">
        <h1 className="text-lg font-semibold tracking-tight">Account</h1>
        <ErrorPanel error={failure} accountId={accountId} />
      </div>
    );
  }

  const summary = summaryResult.value;
  const holds = holdsResult.value;
  const postings = postingsResult.value;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">
          {summary.accountName}{" "}
          <span className="font-normal text-muted">
            ••{summary.accountNumberLast4}
          </span>
        </h1>
        <p className="mt-0.5 text-sm text-muted">
          {summary.businessName} · {summary.currency} · business current account
        </p>
        <div className="mt-3">
          <MetaList
            items={[
              { label: "As of", value: formatTimestamp(summary.asOf) },
              {
                label: "Booking watermark",
                value: (
                  <span className="font-mono">
                    {summary.bookingWatermark.toLocaleString("en-US")}
                  </span>
                ),
              },
              { label: "Acting as", value: ROLE_LABEL[role] },
            ]}
          />
        </div>
      </header>

      <BalanceHeadline
        summary={summary}
        holds={holds}
        authPending={view.authPending}
      />

      <NegativeAvailableNote summary={summary} holds={holds} />

      <HoldsPanel holds={holds} asOf={summary.asOf} />

      <PostingsTable postings={postings} ledgerCents={summary.ledgerCents} />

      <p className="max-w-prose text-xs leading-relaxed text-muted">
        {role === "approver"
          ? "Acting as Approver: hold closures and outbound payments are yours to approve, and never ones you prepared yourself. Nothing on this screen writes — every figure is a read of the journal."
          : "Acting as Staff: you can read every figure here and prepare money movement, but approval is a separate role. §16 puts maker-checker on money out, and the maker is never the checker."}
      </p>
    </div>
  );
}
