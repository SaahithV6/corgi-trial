import Link from "next/link";

import { formatAge, formatCountdown, formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";

import type { Hold, HoldKind } from "./data-contract";
import {
  holdStatus,
  isOverCaptured,
  overCaptureCents,
  providerStatusDisagrees,
  sortHolds,
} from "./derive";

const KIND_LABEL: Record<HoldKind, string> = {
  card_auth: "Card auth",
  uncleared_credit: "Uncleared credit",
  manual: "Manual",
};

/**
 * Active holds, with the arithmetic that produced each one.
 *
 * The columns are the terms of `H(E) = 0 if closed(E) else max(A(E) − C(E), 0)`:
 * authorised, cleared, remaining. Showing all three rather than just the
 * remaining amount is the difference between an operator being able to answer
 * "why is my available balance short" and having to open a database client.
 *
 * The row that matters most is the over-captured one — cleared greater than
 * authorised, remaining zero. It is not an error state and it is not styled as
 * one: it is a correct hold on an authorisation the network exceeded.
 */
export function HoldsPanel({
  holds,
  asOf,
}: {
  readonly holds: readonly Hold[];
  readonly asOf: string;
}) {
  const ordered = sortHolds(holds);
  const activeCount = ordered.filter((hold) => hold.remainingCents > 0).length;

  return (
    <Panel
      id="holds"
      title="Holds"
      description="Every hold withholding money from the available balance, and the authorisation arithmetic behind it. A hold is a memo posting: none of these touch the ledger balance."
      actions={
        <span className="text-xs text-muted">
          {activeCount} active · {ordered.length} shown
        </span>
      }
    >
      {ordered.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">
          No holds. Nothing is being withheld, so the available balance equals
          the ledger balance.
        </p>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Active and recently closed holds on this account
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  Descriptor
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Authorised
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Cleared
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Remaining hold
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Age
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ordered.map((hold) => (
                <HoldRow key={hold.id} hold={hold} asOf={asOf} />
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

function HoldRow({ hold, asOf }: { readonly hold: Hold; readonly asOf: string }) {
  const status = holdStatus(hold);
  const overCaptured = isOverCaptured(hold);
  const excess = overCaptureCents(hold);
  const partiallyCleared =
    !overCaptured && hold.clearedCents > 0 && hold.remainingCents > 0;
  const isCard = hold.kind === "card_auth";

  return (
    <tr className={hold.remainingCents === 0 ? "text-muted" : ""}>
      <td className={TD_CLASS}>
        <div className="flex flex-wrap items-center gap-2">
          {/* The descriptor is the only handle an operator has on a hold, and it
              used to be plain text — so the authorisation arithmetic behind the
              three amount columns, which has its own page at
              /accounts/holds/<id>, was reachable from the account directory and
              not from the account itself. */}
          <Link
            href={`/accounts/holds/${hold.id}`}
            className={`font-medium text-text underline underline-offset-4 ${FOCUS_RING}`}
            title="Open this hold: the event set, the fold at each step, and the closed(E) terms."
          >
            {hold.descriptor}
          </Link>
          <Badge tone="quiet">{KIND_LABEL[hold.kind]}</Badge>

          {status === "over_captured" ? (
            <Badge
              tone="negative"
              title="The network captured more than it authorised. The hold is correctly zero; the excess was never protected."
            >
              over-captured
            </Badge>
          ) : null}

          {status === "closed" && !overCaptured ? (
            <Badge tone="quiet">released</Badge>
          ) : null}

          {partiallyCleared ? <Badge tone="quiet">partially cleared</Badge> : null}
        </div>

        <p className="mt-1 text-xs text-muted">
          Placed {formatTimestamp(hold.placedAt)}
          {hold.expiresAt === null ? null : (
            <> · expires {formatTimestamp(hold.expiresAt)}</>
          )}
          {hold.availableAt === null ? null : (
            <>
              {" "}
              · available {formatTimestamp(hold.availableAt)} (
              {formatCountdown(hold.availableAt, asOf)})
            </>
          )}
        </p>

        {hold.policyRef === null ? null : (
          <p className="mt-1 text-xs text-muted">Policy · {hold.policyRef}</p>
        )}

        {providerStatusDisagrees(hold) ? (
          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-negative">
            The rail reports <span className="font-medium">SETTLED</span> while{" "}
            <Money cents={hold.remainingCents} tone="neutral" /> is still
            authorised. Measured behaviour, DECISIONS 006 — the status field is
            not a description of the hold, so it is never read. The remaining
            amount is derived from the event set.
          </p>
        ) : null}

        {overCaptured ? (
          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
            Cleared <Money cents={hold.clearedCents} tone="neutral" /> against an
            authorisation of <Money cents={hold.authorisedCents} tone="neutral" />
            . The excess of <Money cents={excess} tone="neutral" /> was never
            held, so it was never protected — the classic fuel-pump capture. The
            hold is <span className="font-medium">$0.00</span> because{" "}
            <span className="font-mono">max(A − C, 0)</span> is zero, not because
            anything failed.
          </p>
        ) : null}
      </td>

      <td className={`${TD_CLASS} text-right`}>
        <Money cents={hold.authorisedCents} tone="neutral" />
      </td>

      <td className={`${TD_CLASS} text-right`}>
        {isCard ? (
          <>
            <Money
              cents={hold.clearedCents}
              tone={overCaptured ? "auto" : "neutral"}
              className={overCaptured ? "text-negative" : ""}
            />
            {overCaptured ? (
              <span className="mt-0.5 block text-[11px] text-negative">
                <span aria-hidden="true">+</span>
                <Money cents={excess} tone="neutral" className="text-negative" />{" "}
                over
              </span>
            ) : null}
          </>
        ) : (
          <span aria-hidden="true" className="text-muted">
            —
          </span>
        )}
      </td>

      <td className={`${TD_CLASS} text-right`}>
        <Money
          cents={hold.remainingCents}
          tone="neutral"
          className={hold.remainingCents > 0 ? "font-medium" : ""}
        />
      </td>

      <td className={`${TD_CLASS} text-right whitespace-nowrap`}>
        {formatAge(hold.placedAt, asOf)}
      </td>
    </tr>
  );
}
