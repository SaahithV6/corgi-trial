import Link from "next/link";

import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import { Badge, FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";

import { AddPayeeForm, type BusinessChoice } from "./AddPayeeForm";
import type { PayeeDataSource } from "./data-contract";
import { PayeeDetail } from "./PayeeDetail";
import { PayeeErrorPanel } from "./PayeeErrorPanel";
import { PayeeSkeleton } from "./PayeeSkeleton";
import { PayeeTable } from "./PayeeTable";
import { RefusalTable } from "./RefusalTable";
import { SummaryTiles } from "./SummaryTiles";
import { payeeHref, type PayeeFilter } from "./view-state";

export { PayeeSkeleton };

/**
 * The payee screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `PayeeDataSource` and knows nothing about where the rows come from — live
 * query or fixture — except for the one thing it always shows: which of the
 * two it is looking at.
 *
 * IT NEVER RUNS A CHECK. Running one is an operator action with an actor
 * attached and a row at the end of it; a render is not one, and a page that
 * called two third-party providers because somebody hit reload would be both
 * a bill and a lie about when the check happened.
 */
export async function PayeeBookView({
  source,
  filter,
  /**
   * The businesses a payee can be added to, resolved by the page.
   *
   * EMPTY ON EVERY FIXTURE STATE, which is what turns the operator actions
   * off. The rule this screen has always followed is that a demo state writes
   * nothing and calls nobody; a form that posted against fixture ids would
   * break it, and a form that posted against REAL ids from a screen labelled
   * FIXTURE DATA would break it worse.
   */
  businesses = [],
}: {
  readonly source: PayeeDataSource;
  readonly filter: PayeeFilter;
  readonly businesses?: readonly BusinessChoice[];
}) {
  const writable = businesses.length > 0;
  const result = await source.load(
    filter.payeeId === null ? {} : { payeeId: filter.payeeId },
  );

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        <PayeeErrorPanel error={result.error} />
      </div>
    );
  }

  const view = result.value;
  const selected =
    filter.payeeId === null
      ? null
      : (view.rows.find((r) => r.payeeId === filter.payeeId) ?? null);

  const unsigned = view.rows.filter(
    (r) => !r.archived && r.outcome === "warned" && !r.acknowledged,
  ).length;

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "payees", value: String(view.rows.length) },
            { label: "refused", value: String(view.refusals.length) },
            {
              label: "routing directory",
              value:
                view.directoryEnvironment === "none"
                  ? "not configured"
                  : `Increase · ${view.directoryEnvironment}`,
            },
            { label: "read", value: formatTimestamp(view.asOf) },
          ]}
        />
        <Badge tone={view.source === "live" ? "neutral" : "quiet"}>
          {view.source === "live" ? "LIVE DATABASE" : "FIXTURE DATA"}
        </Badge>
      </div>

      {view.source === "fixture" ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          These rows are a fixture. Either a demo state other than <code>default</code> is
          selected, or no database is configured — see the state bar above. Nothing on this
          screen is a statement about a real payee.
        </p>
      ) : null}

      {/*
        The one claim this screen makes loudest, and it is a limitation rather
        than a feature. It is at the top, in full, on every state, because the
        single way a payee-confirmation screen misleads people is by letting
        them assume the name was confirmed by somebody.
      */}
      <Note title="What this screen can and cannot confirm">
        <p>
          <strong>The routing number is proved, not checked.</strong> A US routing number carries
          a weighted mod-10 check digit, so a mistyped one is arithmetically impossible rather
          than merely unknown. That catches every single wrong digit and roughly 89% of swapped
          adjacent pairs. It is the only finding here that blocks, and it needs no provider.
        </p>
        <p className="mt-2">
          <strong>The institution is confirmed by a real provider</strong> when Increase&rsquo;s
          routing-number directory carries it. A miss in sandbox means very little — the test
          directory holds test banks.
        </p>
        <p className="mt-2">
          <strong>The name on the receiving account is NOT obtainable.</strong> UK Confirmation of
          Payee works because a network answers; US ACH has no such message, and no provider in
          this system can return the name on a third party&rsquo;s account from its number. Where
          a payee is an account somebody linked to us through Plaid, the institution&rsquo;s own
          record is compared and the row says <code>linked_account_holder</code>. Everywhere else
          it says <code>payer_asserted</code>, which means your own team typed both names and
          nobody has confirmed anything.
        </p>
      </Note>

      {unsigned > 0 ? (
        <Note emphasis title={`${unsigned} warning${unsigned === 1 ? "" : "s"} nobody has signed for`}>
          <p>
            Payments to {unsigned === 1 ? "this payee" : "these payees"} are refused until
            somebody records why the difference is legitimate. That is not the warning blocking
            the payment — a warning is overridable, by anybody, in one step. It is a refusal to
            let the override be implicit.
          </p>
          <p className="mt-2">
            Open one below. The signature form names the findings it answers, and the row it
            writes cannot be edited or withdrawn. A refused payment links straight to it:{" "}
            <code>/payees?payee=&lt;id&gt;&amp;sign=1</code> is the URL{" "}
            <code>PAYEE_WARNING_UNACKNOWLEDGED</code> now carries.
          </p>
        </Note>
      ) : null}

      {writable ? (
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={payeeHref({ state: filter.state, add: !filter.add })}
            className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING}`}
          >
            {filter.add ? "Close the add form" : "Add a payee"}
          </Link>
          <p className="text-[11px] leading-relaxed text-muted">
            Adding a beneficiary runs the check and writes a row either way — a payee and its
            first verification, or a refusal carrying the digits as typed. Nothing here writes a
            journal line; a payee is not a payment.
          </p>
        </div>
      ) : null}

      {writable && filter.add ? <AddPayeeForm businesses={businesses} /> : null}

      <SummaryTiles rows={view.rows} refusals={view.refusals} />

      <Panel
        title="Payee book"
        description="Append-only. Every check ever run is a row; what you see here is the newest one and how old it is."
      >
        <PayeeTable rows={view.rows} filter={filter} />
      </Panel>

      {selected === null ? null : (
        <PayeeDetail row={selected} writable={writable} signRequested={filter.sign} />
      )}

      <Panel
        title="Refused before they became payees"
        description="The caught typo, as typed. A routing number that fails the check digit never becomes a payee, so this is the only place it exists."
      >
        <RefusalTable rows={view.refusals} />
      </Panel>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">Payees</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        The confirmation step in front of an outbound payment: the arithmetic that makes a
        mistyped routing number impossible, the directory that says whose bank it is, and an
        honest account of the one question US ACH has no way to answer.
      </p>
    </div>
  );
}
