"use client";

import { useActionState, useId } from "react";

import {
  addMemberAction,
  endMembershipAction,
  issueMemberCardAction,
  setTermsAction,
  TEAM_IDLE,
  type TeamActionResult,
} from "@/app/(app)/team/actions";
import { TEAM_ROLES, ROLE_SUMMARY } from "@/lib/team/roles";
import type { TeamMemberDetail } from "@/lib/team/types";
import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

/**
 * The four things an admin can do, and what these forms are careful not to do.
 *
 * 1. THEY PERFORM NO ARITHMETIC ON MONEY. A limit is the literal characters
 *    somebody typed, sent as text, parsed into `bigint` cents on the server.
 *    There is no `Number`, no `/ 100` and no `toFixed` anywhere on this path.
 *
 * 2. THEY ARE NOT THE AUTHORISATION. Whether this actor may administer this
 *    team is decided by `team_add_member()` and `assert_team_member_version()`
 *    in the database. These forms do not check it, deliberately: a check here
 *    would be a second copy of the rule, and the copy in the screen is the one
 *    that gets forgotten. Press Remove as a viewer and the refusal comes back
 *    with the sentence the migration wrote.
 *
 * 3. THE BUTTONS ARE NOT DISABLED WHEN SOMETHING LOOKS WRONG. The refusal is
 *    the most instructive thing this screen can show. Promoting a viewer to
 *    approver is a real POST that comes back with "actor … was created without
 *    approval rights and actor rows are append-only" — which is the answer, and
 *    a greyed-out button demonstrates nothing.
 *
 * 4. REMOVE IS TYPE-TO-CONFIRM. Not because the database needs protecting — it
 *    refuses everything it should — but because removal is TERMINAL: nothing
 *    may follow it, and re-adding somebody is a new membership with a new card.
 *    An irreversible button deserves a deliberate gesture.
 */

const INPUT = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const BUTTON = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;

function Receipt({ result }: { readonly result: TeamActionResult }) {
  if (result.status === "idle") return null;
  return (
    <Note emphasis={result.status === "failed"} title={result.code ?? "Result"}>
      <p>{result.message}</p>
      {result.facts.length === 0 ? null : (
        <dl className="mt-2 flex flex-col gap-1">
          {result.facts.map((fact) => (
            <div key={fact.label} className="flex flex-wrap items-baseline gap-2">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{fact.label}</dt>
              <dd className={fact.mono === true ? "font-mono text-[11px] text-text" : "text-[11px] text-text"}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Note>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <span className={LABEL}>{label}</span>
      {children}
      {hint === undefined ? null : (
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">{hint}</p>
      )}
    </div>
  );
}

/** Add somebody to the team. */
function AddMember({ businessId }: { readonly businessId: string }) {
  const [result, action, pending] = useActionState(addMemberAction, TEAM_IDLE);
  const id = useId();

  return (
    <form action={action} className="space-y-4 px-5 py-4">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className={INPUT} name="displayName" required maxLength={80} id={`${id}-name`} />
        </Field>
        <Field label="Email" hint="One principal per person per business; a unique index enforces it.">
          <input className={INPUT} name="email" type="email" required id={`${id}-email`} />
        </Field>
      </div>

      <Field
        label="Role"
        hint="Four roles, each because a sentence of the brief requires it. Approval rights are set HERE, once: actor.can_approve is append-only, so a viewer cannot be promoted into approving later, and the database refuses that promotion out loud rather than accepting it and ignoring it."
      >
        <select className={INPUT} name="role" defaultValue="initiator" id={`${id}-role`}>
          {TEAM_ROLES.map((role) => (
            <option key={role} value={role}>
              {role} — {ROLE_SUMMARY[role]}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Per transaction" hint="Blank = no limit. 0 = spends nothing. Different things.">
          <input className={INPUT} name="perTxn" inputMode="decimal" placeholder="250.00" />
        </Field>
        <Field label="Per day">
          <input className={INPUT} name="day" inputMode="decimal" placeholder="400.00" />
        </Field>
        <Field label="Per month">
          <input className={INPUT} name="month" inputMode="decimal" placeholder="2000.00" />
        </Field>
      </div>

      <Field label="Why" hint="NOT NULL in the schema. It is the first thing read when somebody asks why a card stopped.">
        <input className={INPUT} name="note" required maxLength={400} />
      </Field>

      <button className={BUTTON} type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add to the team"}
      </button>

      <Receipt result={result} />
    </form>
  );
}

/** Issue a real Lithic card to a member who does not have one. */
function IssueCard({
  businessId,
  members,
  formKey,
}: {
  readonly businessId: string;
  readonly members: readonly TeamMemberDetail[];
  readonly formKey: string;
}) {
  const [result, action, pending] = useActionState(issueMemberCardAction, TEAM_IDLE);
  const candidates = members.filter((m) => m.member.terms.state === "active");

  return (
    <form action={action} className="space-y-4 px-5 py-4">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="formKey" value={formKey} />

      <Field
        label="Member"
        hint="Creates a REAL card on the Lithic sandbox through the same createCard() /accounts uses — same rate limiter, same Idempotency-Key — then registers it against this customer's 2100/9100 pair and writes the one row saying whose it is. A removed member is not offered, and the database refuses it anyway."
      >
        <select className={INPUT} name="memberId" required defaultValue="">
          <option value="" disabled>
            choose a person
          </option>
          {candidates.map((m) => (
            <option key={m.member.memberId} value={m.member.memberId}>
              {m.member.displayName} — {m.member.terms.role}
              {m.cards.length > 0 ? ` (already holds ${m.cards.length})` : ""}
            </option>
          ))}
        </select>
      </Field>

      <button className={BUTTON} type="submit" disabled={pending || candidates.length === 0}>
        {pending ? "Creating at Lithic…" : "Issue a card"}
      </button>

      <Receipt result={result} />
    </form>
  );
}

/** Change one person's role and limits — terms version N+1. */
function ChangeTerms({
  businessId,
  members,
}: {
  readonly businessId: string;
  readonly members: readonly TeamMemberDetail[];
}) {
  const [result, action, pending] = useActionState(setTermsAction, TEAM_IDLE);
  const live = members.filter((m) => m.member.terms.state !== "removed");

  return (
    <form action={action} className="space-y-4 px-5 py-4">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Member">
          <select className={INPUT} name="memberId" required defaultValue="">
            <option value="" disabled>
              choose a person
            </option>
            {live.map((m) => (
              <option key={m.member.memberId} value={m.member.memberId}>
                {m.member.displayName} — terms v{m.member.terms.version}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <select className={INPUT} name="role" defaultValue="initiator">
            {TEAM_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Per transaction" hint="Blank clears the limit.">
          <input className={INPUT} name="perTxn" inputMode="decimal" />
        </Field>
        <Field label="Per day">
          <input className={INPUT} name="day" inputMode="decimal" />
        </Field>
        <Field label="Per month">
          <input className={INPUT} name="month" inputMode="decimal" />
        </Field>
      </div>

      <Field label="Why" hint="A change is version N+1, never an edit. The version a past authorisation cited still says exactly what it said.">
        <input className={INPUT} name="note" required maxLength={400} />
      </Field>

      <button className={BUTTON} type="submit" disabled={pending}>
        {pending ? "Writing…" : "Write terms version N+1"}
      </button>

      <Receipt result={result} />
    </form>
  );
}

/** Suspend, remove or reinstate. */
function EndMembership({
  businessId,
  members,
}: {
  readonly businessId: string;
  readonly members: readonly TeamMemberDetail[];
}) {
  const [result, action, pending] = useActionState(endMembershipAction, TEAM_IDLE);

  return (
    <form action={action} className="space-y-4 px-5 py-4">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Member">
          <select className={INPUT} name="memberId" required defaultValue="">
            <option value="" disabled>
              choose a person
            </option>
            {members.map((m) => (
              <option key={m.member.memberId} value={m.member.memberId}>
                {m.member.displayName} — {m.member.terms.state}
                {m.outstanding.length > 0 ? ` · ${m.outstanding.length} outstanding` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="To"
          hint="suspended is reversible and PAUSES the card at Lithic. removed is TERMINAL — nothing may follow it, the card is CLOSED at the issuer, and re-adding this person is a new membership with a new card. active reinstates a suspended member and is refused for a removed one."
        >
          <select className={INPUT} name="state" defaultValue="suspended">
            <option value="suspended">suspended — reversible</option>
            <option value="removed">removed — terminal</option>
            <option value="active">active — reinstate a suspended member</option>
          </select>
        </Field>
      </div>

      <Field label="Why" hint="Recorded on the version. It is what an auditor reads first.">
        <input className={INPUT} name="note" required maxLength={400} />
      </Field>

      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        The issuer is called BEFORE the fact is written. If the order were reversed and the
        provider call failed, there would be a window in which this system says the person is
        gone and their card still spends. The append happens either way — a revocation must not
        depend on a third party being reachable — and the receipt says which half succeeded.
      </p>

      <button className={BUTTON} type="submit" disabled={pending}>
        {pending ? "Revoking…" : "Change their membership"}
      </button>

      <Receipt result={result} />
    </form>
  );
}

export function TeamForms({
  businessId,
  members,
  formKey,
  canAdminister,
}: {
  readonly businessId: string;
  readonly members: readonly TeamMemberDetail[];
  readonly formKey: string;
  /**
   * Whether the session's actor holds `administer_team` here.
   *
   * A HINT, NOT A GATE. It picks the sentence at the top of the panel. Every
   * form below still posts, and every refusal still comes from the database,
   * because a screen that hides a button has not enforced anything — it has
   * only made the enforcement invisible to the person reading the screen.
   */
  readonly canAdminister: boolean;
}) {
  return (
    <div className="space-y-6">
      {canAdminister ? null : (
        <Note title="You are not an administrator of this team">
          Every form below still posts, and every refusal comes back from a trigger with the
          sentence migration 0033 wrote. Nothing here is hidden, because hiding a button is not
          enforcement — press one and read the refusal.
        </Note>
      )}

      <Panel
        title="Add somebody to the team"
        description="Creates the principal, the membership and terms version 1 in one statement, so a membership with no terms is unrepresentable."
        actions={<Badge tone="quiet">team_add_member()</Badge>}
      >
        <AddMember businessId={businessId} />
      </Panel>

      <Panel
        title="Issue a card"
        description="A real virtual card on the Lithic sandbox, through the existing issuing path, bound to a person."
        actions={<Badge tone="neutral">live provider call</Badge>}
      >
        <IssueCard businessId={businessId} members={members} formKey={formKey} />
      </Panel>

      <Panel
        title="Change somebody's role or limits"
        description="Append-only. A change is version N+1 and the version a past authorisation cited still says what it said."
      >
        <ChangeTerms businessId={businessId} members={members} />
      </Panel>

      <Panel
        title="Suspend, remove or reinstate"
        description="Removal is one INSERT. Nothing is deleted, and an authorisation already outstanding still settles."
        actions={<Badge tone="negative">terminal</Badge>}
      >
        <EndMembership businessId={businessId} members={members} />
      </Panel>
    </div>
  );
}
