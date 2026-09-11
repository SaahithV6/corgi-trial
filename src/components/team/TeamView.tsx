import Link from "next/link";

import { formatUsd } from "@/lib/format/money";
import type { TeamScreen } from "@/lib/team/screen";
import type { TeamMemberDetail } from "@/lib/team/types";
import {
  Badge,
  FieldLabel,
  FOCUS_RING,
  MetaList,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import { MemberRow } from "./MemberRow";
import { teamQuery, type TeamFilter } from "./view-state";

/**
 * The team, drawn.
 *
 * A PURE FUNCTION of the screen value. It cannot reach a database, so the
 * fixture states and the live states go through exactly the same renderer and a
 * fixture proves the real thing draws.
 */
export function TeamView({
  screen,
  filter,
  fixture,
  edgeOnly,
}: {
  readonly screen: TeamScreen;
  readonly filter: TeamFilter;
  /** Rendered banner for the two states that are not live. */
  readonly fixture?: string;
  /** The edge state: the same rows, filtered to the ones that are the point. */
  readonly edgeOnly?: readonly TeamMemberDetail[];
}) {
  const shown = edgeOnly ?? screen.members;
  const live = screen.members.filter((m) => m.member.terms.state === "active").length;
  const gone = screen.members.length - live;

  return (
    <div className="space-y-6">
      {fixture === undefined ? null : (
        <Note title="FIXTURE — no database was read for this state">{fixture}</Note>
      )}

      <Panel
        title={`${screen.legalName} — the team`}
        description="A business has people. Each has a role, their own spend limits and their own card, and every authorisation is attributable to one of them."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {screen.businesses.slice(0, 4).map((b) => (
              <Link
                key={b.id}
                href={`/team${teamQuery({ state: filter.state, businessId: b.id })}`}
                aria-current={b.id === screen.businessId ? "page" : undefined}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  b.id === screen.businessId
                    ? "bg-surface-raised font-medium text-text"
                    : "text-muted hover:text-text"
                }`}
              >
                {b.legalName}
              </Link>
            ))}
          </div>
        }
      >
        <div className="flex flex-wrap gap-x-8 gap-y-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <FieldLabel>Members</FieldLabel>
            <span className="text-sm">
              {live} active
              {gone > 0 ? (
                <span className="text-muted"> · {gone} removed or suspended, kept</span>
              ) : null}
            </span>
          </div>
          {screen.balance === null ? (
            <div className="flex flex-col gap-1">
              <FieldLabel>Balance</FieldLabel>
              <span className="text-sm text-muted">
                no 2100 leaf — this business has a team and no account yet
              </span>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <FieldLabel>Ledger</FieldLabel>
                <span className="money text-sm">{formatUsd(screen.balance.ledgerCents)}</span>
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel>Held</FieldLabel>
                <span className="money text-sm">{formatUsd(screen.balance.holdsCents)}</span>
              </div>
              <div className="flex flex-col gap-1">
                <FieldLabel>Available</FieldLabel>
                <span className="money text-sm">{formatUsd(screen.balance.availableCents)}</span>
              </div>
            </>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="border-t border-border px-5 py-8">
            <p className="max-w-prose text-sm text-muted">
              {edgeOnly === undefined
                ? "No members yet. The first admin of a business is created by Corgi ops at account opening — a business's first admin cannot appoint themselves, and team_add_member() enforces that rather than a screen."
                : "Nobody on this team is suspended or removed while still holding an outstanding authorisation. That is the whole edge case, and this screen will not manufacture one to demonstrate itself."}
            </p>
          </div>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-t border-border">
                  <th scope="col" className={TH_CLASS}>Person</th>
                  <th scope="col" className={TH_CLASS}>Role</th>
                  <th scope="col" className={TH_CLASS}>State</th>
                  <th scope="col" className={TH_CLASS}>Card</th>
                  <th scope="col" className={TH_CLASS}>Their own limits</th>
                  <th scope="col" className={TH_CLASS}>Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((detail) => (
                  <MemberRow
                    key={detail.member.memberId}
                    detail={detail}
                    filter={filter}
                    expanded={filter.memberId === detail.member.memberId}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <div className="border-t border-border px-5 py-3">
          <MetaList
            items={[
              { label: "as of", value: screen.asOf },
              { label: "source", value: screen.live ? "live database" : "fixture" },
            ]}
          />
        </div>
      </Panel>

      {edgeOnly === undefined ? null : <EdgeExplanation members={edgeOnly} />}

      <Panel
        title="What the database refuses"
        description={`${screen.invariants.length} invariant${
          screen.invariants.length === 1 ? "" : "s"
        }, counted on this request. A guard nobody queries is a comment, so the screen is one more place that queries them. The count is derived rather than written down, because this caption has twice named a number the list had already moved past.`}
      >
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-t border-border">
                <th scope="col" className={TH_CLASS}>View</th>
                <th scope="col" className={TH_CLASS}>Must be empty because</th>
                <th scope="col" className={TH_CLASS}>Rows</th>
              </tr>
            </thead>
            <tbody>
              {screen.invariants.map((invariant) => (
                <tr key={invariant.view} className="border-t border-border">
                  <td className={`${TD_CLASS} font-mono text-xs`}>{invariant.view}</td>
                  <td className={`${TD_CLASS} text-xs text-muted`}>{invariant.claim}</td>
                  <td className={TD_CLASS}>
                    <Badge tone={invariant.rows === 0 ? "positive" : "negative"}>
                      {invariant.rows}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}

/**
 * The edge state, explained at the point of the evidence.
 *
 * The numbers above are the claim; this is the argument. It is written out
 * because the first reaction to "a removed person's card is still holding fifty
 * dollars" is that something is broken, and the second is a ticket.
 */
function EdgeExplanation({ members }: { readonly members: readonly TeamMemberDetail[] }) {
  const total = members.reduce(
    (sum, m) => sum + m.outstanding.reduce((s, a) => s + a.targetHoldCents, 0n),
    0n,
  );

  return (
    <Note emphasis title="A member was removed while an authorisation of theirs was outstanding">
      <p>
        {formatUsd(total)} is still withheld against this business on the cards of people who
        are no longer on the team. <strong>That is correct and it must stay that way.</strong>{" "}
        The merchant has not claimed it yet and will, days later, for a different amount.
      </p>
      <p className="mt-2">Removing a member is ONE INSERT — a new row of their terms saying{" "}
        <code>removed</code>. It does not touch <code>card</code>,{" "}
        <code>card_authorization</code>, <code>card_auth_event</code>, <code>hold</code> or a
        single journal line, and the application role holds no UPDATE or DELETE on any of them.
        The settlement path is keyed on the PROVIDER CARD TOKEN and resolves to this business&rsquo;s
        2100 and 9100 leaves, none of which removal changes — so the clearing posts exactly as it
        would have if nobody had left, and the hold releases exactly once.
      </p>
      <p className="mt-2">
        What DID stop is the future. The card is <code>CLOSED</code> at Lithic (a real{" "}
        <code>PATCH /v1/cards/&#123;token&#125;</code>, made before the removal was recorded), and
        the real-time authorisation decision declines it on rule <code>member_removed</code> before
        it consults the card&rsquo;s own controls.
      </p>
      <p className="mt-2">
        The two mechanisms are deliberately redundant and fail in opposite directions: ours declines
        when we cannot be reached, theirs declines when they cannot reach us.
      </p>
    </Note>
  );
}

/** The real skeleton. Shown by Suspense while the real read is in flight. */
export function TeamSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <Panel title="The team" description="Reading members, cards, limits and outstanding authorisations.">
        <div className="space-y-3 px-5 py-6">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-4">
              <div className="h-4 w-40 animate-pulse rounded bg-surface-raised" />
              <div className="h-4 w-20 animate-pulse rounded bg-surface-raised" />
              <div className="h-4 w-24 animate-pulse rounded bg-surface-raised" />
              <div className="h-4 w-48 animate-pulse rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
