import Link from "next/link";

import { formatUsd } from "@/lib/format/money";
import { ROLE_SUMMARY, STATE_SUMMARY } from "@/lib/team/roles";
import type { TeamMemberDetail } from "@/lib/team/types";
import { Badge, FOCUS_RING, TD_CLASS } from "@/components/ui/primitives";

import { teamQuery, type TeamFilter } from "./view-state";

/** A limit, or the absence of one. `null` and `0` are DIFFERENT and both show. */
function limit(cents: bigint | null): string {
  return cents === null ? "no limit" : formatUsd(cents);
}

/**
 * One person: who they are, what they may do, what they hold, what they spent.
 *
 * Money is `bigint` cents all the way to `formatUsd`, which does integer
 * division and remainder on `bigint` and never touches a float.
 */
export function MemberRow({
  detail,
  filter,
  expanded,
}: {
  readonly detail: TeamMemberDetail;
  readonly filter: TeamFilter;
  readonly expanded: boolean;
}) {
  const { member, cards, outstanding, spend } = detail;
  const removed = member.terms.state === "removed";
  const suspended = member.terms.state === "suspended";

  return (
    <>
      <tr className={removed ? "border-t border-border opacity-70" : "border-t border-border"}>
        <td className={TD_CLASS}>
          <div className="flex flex-col gap-1">
            <Link
              href={`/team${teamQuery({
                state: filter.state,
                businessId: filter.businessId,
                memberId: expanded ? null : member.memberId,
              })}#member-${member.memberId}`}
              className={`font-medium ${FOCUS_RING} hover:underline`}
            >
              {member.displayName}
            </Link>
            <span className="text-xs text-muted">{member.email ?? "no email"}</span>
            {member.membershipSeq > 1 ? (
              <span className="text-[11px] text-muted">
                membership {member.membershipSeq} — they were here before
              </span>
            ) : null}
          </div>
        </td>

        <td className={TD_CLASS}>
          <div className="flex flex-col items-start gap-1">
            <Badge tone="neutral" title={ROLE_SUMMARY[member.terms.role]}>
              {member.terms.role}
            </Badge>
            <span className="text-[11px] text-muted">terms v{member.terms.version}</span>
          </div>
        </td>

        <td className={TD_CLASS}>
          <div className="flex flex-col items-start gap-1">
            <Badge
              tone={removed ? "negative" : suspended ? "negative" : "positive"}
              title={STATE_SUMMARY[member.terms.state]}
            >
              {member.terms.state}
            </Badge>
            <span className="text-[11px] text-muted">
              since {member.terms.effectiveFrom.slice(0, 10)}
            </span>
          </div>
        </td>

        <td className={TD_CLASS}>
          {cards.length === 0 ? (
            <span className="text-xs text-muted">no card</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {cards.map((card) => (
                <li key={card.cardId} className="font-mono text-xs">
                  ···· {card.lastFour ?? "????"}
                  <span className="ml-2 text-[11px] text-muted">{card.providerCardToken}</span>
                </li>
              ))}
            </ul>
          )}
        </td>

        <td className={`${TD_CLASS} money whitespace-nowrap`}>
          <div className="flex flex-col gap-0.5 text-xs">
            <span>
              txn {limit(member.terms.perTxnLimitCents)}
            </span>
            <span>
              day {limit(member.terms.dailyLimitCents)}
              {member.terms.dailyLimitCents === null ? null : (
                <span className="ml-1 text-muted">· spent {formatUsd(spend.dayCents)}</span>
              )}
            </span>
            <span>
              month {limit(member.terms.monthlyLimitCents)}
              {member.terms.monthlyLimitCents === null ? null : (
                <span className="ml-1 text-muted">· spent {formatUsd(spend.monthCents)}</span>
              )}
            </span>
          </div>
        </td>

        <td className={`${TD_CLASS} money whitespace-nowrap`}>
          {outstanding.length === 0 ? (
            <span className="text-xs text-muted">none</span>
          ) : (
            <div className="flex flex-col gap-0.5 text-xs">
              {outstanding.map((auth) => (
                <span key={auth.authId}>
                  {formatUsd(auth.targetHoldCents)}
                  <span className="ml-1 text-muted">H(E)</span>
                </span>
              ))}
            </div>
          )}
        </td>
      </tr>

      {expanded ? (
        <tr id={`member-${member.memberId}`} className="border-t border-border bg-surface-raised">
          <td className={TD_CLASS} colSpan={6}>
            <div className="flex flex-col gap-3 text-xs leading-relaxed">
              <p className="max-w-prose text-muted">
                <span className="font-medium text-text">{member.terms.role}</span> —{" "}
                {ROLE_SUMMARY[member.terms.role]}
              </p>
              <p className="max-w-prose text-muted">
                <span className="font-medium text-text">{member.terms.state}</span> —{" "}
                {STATE_SUMMARY[member.terms.state]}
              </p>
              <p className="max-w-prose text-muted">
                <span className="font-medium text-text">Why this version exists:</span>{" "}
                {member.terms.note}
              </p>

              <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-muted">
                <div>
                  <dt className="inline">member </dt>
                  <dd className="inline text-text">{member.memberId}</dd>
                </div>
                <div>
                  <dt className="inline">actor </dt>
                  <dd className="inline text-text">{member.actorId}</dd>
                </div>
                <div>
                  <dt className="inline">terms version </dt>
                  <dd className="inline text-text">{member.terms.memberVersionId}</dd>
                </div>
              </dl>

              <p className="max-w-prose text-muted">
                <span className="font-medium text-text">actor.can_approve is{" "}
                  {String(member.actorCanApprove)}</span>{" "}
                — migration 0001 owns that column and it is append-only, so it is the
                ENVELOPE: whether this principal may ever hold approval rights. Whether
                they hold them today is their role, and{" "}
                <code>assert_team_maker_checker()</code> composes the two with an AND.
                0033 can only ever narrow 0001.
              </p>

              {outstanding.length > 0 ? (
                <div className="rounded-md border border-border px-3 py-2">
                  <p className="font-medium text-text">Outstanding authorisations</p>
                  <ul className="mt-1 flex flex-col gap-1 font-mono text-[11px] text-muted">
                    {outstanding.map((auth) => (
                      <li key={auth.authId}>
                        {auth.providerAuthId} · A(E) {formatUsd(auth.authorisedCents)} · C(E){" "}
                        {formatUsd(auth.capturedCents)} · H(E) {formatUsd(auth.targetHoldCents)} ·
                        memo {formatUsd(auth.memoBalanceCents)} · expires{" "}
                        {auth.expiresAt.slice(0, 10)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
