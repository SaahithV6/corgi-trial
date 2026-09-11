import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";
import { ROLE_SUMMARY, STATE_SUMMARY } from "@/lib/team/roles";

import type { ClientTeamScreen, TeammateLine } from "./contract";
import { AddTeammateForm, TeammateControls } from "./TeamClientForms";

/**
 * `/client/team` — the customer's own team, drawn from one value.
 *
 * A pure function of `ClientTeamScreen`, in the shape every screen on this
 * surface uses, so the live read and a slow read are the same render.
 *
 * ===========================================================================
 * THE PEOPLE WHO LEFT ARE STILL ON THIS LIST
 * ===========================================================================
 *
 * Ordered last, and shown. A team screen that hid them could not answer "who
 * bought this", which is most of what the feature is for — and their charges
 * are still on this account, because a removal does not reach back and unspend
 * money. Nothing on this surface deletes a person; the only verb available is
 * an append.
 *
 * ===========================================================================
 * IT DOES NOT BORROW THE SHARED HEADER, DELIBERATELY
 * ===========================================================================
 *
 * `ClientHeaderBar`, `ClientStateBar` and `BusinessPicker` take a
 * `ClientScreenHref`, whose union lives in `src/components/client/view-state.ts`
 * — a central register this change is not allowed to edit, and should not: a
 * new route belongs in it once, centrally, with the navigation. So the header
 * and the business picker below are this screen's own, the picker is the same
 * plain GET form the shared one is, and it stays a SUBJECT for a query rather
 * than permission for a view.
 */

const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

function stateTone(state: TeammateLine["state"]): "positive" | "negative" | "quiet" {
  if (state === "active") return "positive";
  if (state === "removed") return "negative";
  return "quiet";
}

function BusinessPicker({
  screen,
  businesses,
  current,
}: {
  readonly screen: string;
  readonly businesses: ClientTeamScreen["subject"]["businesses"];
  readonly current: string;
}) {
  return (
    <form action={screen} method="get" className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Signed in as</span>
        <select
          name="business"
          defaultValue={current}
          className={`rounded border border-border-strong bg-surface px-2 py-1.5 text-sm ${FOCUS_RING}`}
        >
          {businesses.length === 0 ? (
            <option value={current}>this business</option>
          ) : (
            businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.legalName}
              </option>
            ))
          )}
        </select>
      </label>
      <button
        type="submit"
        className={`rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING}`}
      >
        Switch
      </button>
    </form>
  );
}

function MemberPanel({
  businessId,
  member,
  canAdminister,
}: {
  readonly businessId: string;
  readonly member: TeammateLine;
  readonly canAdminister: boolean;
}) {
  return (
    <section className="border-b border-border px-5 py-5 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">{member.displayName}</h3>
            <Badge tone={stateTone(member.state)}>{member.state}</Badge>
            <Badge tone="neutral">{member.role}</Badge>
            {member.isYou ? <Badge tone="quiet">you</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {member.email ?? "no email on file"} · joined {member.joinedAt.slice(0, 10)} · terms
            version {member.termsVersion}
          </p>
          <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
            {ROLE_SUMMARY[member.role]}
          </p>
          <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
            {STATE_SUMMARY[member.state]}
          </p>
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-right">
          {[
            { label: "Per purchase", value: member.perTxnDisplay },
            { label: "Per day", value: member.dailyDisplay },
            { label: "Per month", value: member.monthlyDisplay },
            { label: "Spent today", value: member.spentTodayDisplay },
            { label: "Spent this month", value: member.spentMonthDisplay },
          ].map((row) => (
            <div key={row.label} className="flex items-baseline justify-end gap-3">
              <dt className="text-[11px] text-muted">{row.label}</dt>
              <dd className="money text-xs">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {member.cards.length === 0 ? (
          <span className="text-[11px] text-muted">No card yet.</span>
        ) : (
          member.cards.map((card) => (
            <span
              key={card.cardId}
              className="rounded border border-border px-2 py-1 text-[11px] text-muted"
            >
              card ···· <span className="money">{card.lastFour ?? "????"}</span>
              {card.providerState === null ? null : ` · ${card.providerState} at the issuer`} ·
              since {card.issuedAt.slice(0, 10)}
            </span>
          ))
        )}
        {member.outstandingCount === 0 ? null : (
          <span className="rounded border border-border-strong px-2 py-1 text-[11px]">
            {member.outstandingCount} in flight, holding{" "}
            <span className="money">{member.outstandingDisplay}</span>
          </span>
        )}
      </div>

      <div className="mt-4">
        <TeammateControls
          businessId={businessId}
          member={member}
          canAdminister={canAdminister}
        />
      </div>
    </section>
  );
}

export function TeamClientView({
  screen,
  href,
}: {
  readonly screen: ClientTeamScreen;
  readonly href: string;
}) {
  const { subject, actingAs, members } = screen;
  const live = members.filter((m) => m.state !== "removed");
  const cards = members.reduce((n, m) => n + m.cards.length, 0);

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-border bg-surface px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">Your team</h1>
              {subject.live ? <Badge tone="positive">live</Badge> : <Badge tone="negative">fixture</Badge>}
            </div>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              The people who can see your money, move it, approve it and spend it — and the card
              each of them holds. Everything on this page is your business and only your business:
              every read is a <code>WHERE business_id</code> the database applies, and every change
              re-checks it before it writes.
            </p>
            <p className="mt-2 text-sm font-medium">{subject.legalName}</p>
            <p className="text-xs text-muted">
              {subject.accountName ?? "No current account has been opened yet."} ·{" "}
              {live.length} {live.length === 1 ? "person" : "people"} · {cards}{" "}
              {cards === 1 ? "card" : "cards"} · read at {subject.asOf}
            </p>
          </div>
          <BusinessPicker
            screen={href}
            businesses={subject.businesses}
            current={subject.businessId}
          />
        </div>
      </header>

      {actingAs === null ? (
        <Note emphasis title="Nobody here can change this team yet">
          This business has no active administrator, so this screen can read your team and change
          nothing. That is not a fault: a business&rsquo;s first administrator is created by Corgi
          when the account is opened, because a business cannot appoint its own first
          administrator — the person who would authorise it is the person being appointed. Ask
          Corgi to appoint one and every form below becomes live.
        </Note>
      ) : (
        <Note title={`You are acting as ${actingAs.displayName}`}>
          Your business&rsquo;s own administrator, resolved from your team rather than from the
          Corgi staff account this console signs in as. That is the difference that matters on this
          screen: a change made here is recorded as{" "}
          <strong className="font-medium text-text">{actingAs.displayName}</strong> doing it, and it
          is checked against what {actingAs.displayName} is allowed to do — by the database, in the
          same statement that writes it. A change laundered through a bank employee would pass a
          check written for bank employees.
        </Note>
      )}

      <Panel
        title="Add somebody to the team"
        description="They get a principal of their own, a role, their own spend limits, and — when you press the second button — a card."
      >
        {actingAs === null ? (
          <div className="px-5 py-5 text-xs text-muted">
            Nobody can be added until this business has an administrator.
          </div>
        ) : (
          <AddTeammateForm businessId={subject.businessId} actingName={actingAs.displayName} />
        )}
      </Panel>

      <Panel
        title="Everybody on the team"
        description="People who have left are kept, and shown last. Their charges are still on your account, so they still have to be attributable to them — nothing on this screen deletes a person."
      >
        {members.length === 0 ? (
          <div className="px-5 py-6 text-xs text-muted">
            Nobody is on this team yet.
          </div>
        ) : (
          members.map((member) => (
            <MemberPanel
              key={member.memberId}
              businessId={subject.businessId}
              member={member}
              canAdminister={actingAs !== null}
            />
          ))
        )}
      </Panel>

      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        A note on what these limits are. The ones here belong to the PERSON and follow them when
        their card is replaced. Their card carries its own, which belong to the INSTRUMENT and
        reset when a new one is issued. Both are checked, in that order, on every purchase, and the
        issuer keeps its own $5,000.00 ceiling underneath both — enforced on Lithic&rsquo;s side
        whether or not this system is reachable.
      </p>
    </div>
  );
}
