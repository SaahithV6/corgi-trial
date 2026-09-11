"use client";

import { useActionState, useId, useState } from "react";

import {
  addTeammateAction,
  endTeammateAction,
  issueTeammateCardAction,
  setTeammateTermsAction,
} from "@/app/(app)/client/team/actions";
import { FOCUS_RING } from "@/components/ui/primitives";
import { ROLE_SUMMARY } from "@/lib/team/roles";

import { CLIENT_TEAM_IDLE, type ClientTeamResult } from "./action-result";
import { ACTING_RULE, CLIENT_ROLE_CHOICES, type TeammateLine } from "./contract";

/**
 * The customer's four team forms.
 *
 * ===========================================================================
 * NOTHING HERE ENFORCES ANYTHING
 * ===========================================================================
 *
 * Not the disabled remove button, not the role `<select>` that omits `approver`
 * for somebody who cannot hold it, not the absence of a form on your own row.
 * Every one of those is a COURTESY — a server action is a public POST endpoint
 * and a browser is not a trust boundary. Each of them is re-decided in
 * `@/app/(app)/client/team/actions`, against rows re-read from the database, and
 * then again by the triggers in 0033, 0044, 0062 and 0064. If this file were
 * deleted the rules would all still hold; if the actions were deleted, none of
 * them would.
 *
 * ===========================================================================
 * NO ARITHMETIC AND NO `Number`
 * ===========================================================================
 *
 * Limits arrive as strings the server formatted while it still held a `bigint`
 * and leave as the literal characters somebody typed. A blank field stays
 * blank — it is not helpfully filled in with "0.00", because blank means "no
 * limit of this kind" and 0.00 means "spends nothing", and those are different
 * rows in the database.
 */

const FIELD = `w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-sm ${FOCUS_RING}`;
const BUTTON = `rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:opacity-60`;
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

function Receipt({ state }: { readonly state: ClientTeamResult }) {
  if (state.status === "idle") return null;
  const bad = state.status === "failed";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-md border px-4 py-3 ${
        bad ? "border-negative/40 bg-surface-raised" : "border-border bg-surface-raised"
      }`}
    >
      <p className={`text-xs font-semibold ${bad ? "text-negative" : "text-text"}`}>
        {bad ? (state.code ?? "Refused") : "Done"}
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
      {state.facts.length === 0 ? null : (
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {state.facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-[11px] text-muted">{fact.label}</dt>
              <dd className={`text-xs ${fact.mono === true ? "money break-all" : "money"}`}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The three limit fields, shared by the add form and every edit form. */
function LimitFields({
  ids,
  perTxn,
  day,
  month,
}: {
  readonly ids: string;
  readonly perTxn: string;
  readonly day: string;
  readonly month: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[
        { name: "perTxn", label: "Per purchase", value: perTxn },
        { name: "day", label: "Per day", value: day },
        { name: "month", label: "Per month", value: month },
      ].map((f) => (
        <label key={f.name} className="flex flex-col gap-1" htmlFor={`${ids}-${f.name}`}>
          <span className={LABEL}>{f.label}</span>
          <input
            id={`${ids}-${f.name}`}
            name={f.name}
            defaultValue={f.value}
            inputMode="decimal"
            autoComplete="off"
            placeholder="no limit"
            className={FIELD}
          />
        </label>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Add somebody                                                            */
/* -------------------------------------------------------------------------- */

export function AddTeammateForm({
  businessId,
  actingName,
}: {
  readonly businessId: string;
  readonly actingName: string;
}) {
  const [state, formAction, pending] = useActionState(addTeammateAction, CLIENT_TEAM_IDLE);
  const ids = useId();
  const [role, setRole] = useState<string>("initiator");

  return (
    <div className="space-y-4 px-5 py-5">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-name`}>
            <span className={LABEL}>Their name</span>
            <input id={`${ids}-name`} name="displayName" required maxLength={80} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-email`}>
            <span className={LABEL}>Their email</span>
            <input
              id={`${ids}-email`}
              name="email"
              type="email"
              required
              maxLength={120}
              className={FIELD}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1" htmlFor={`${ids}-role`}>
          <span className={LABEL}>What they may do</span>
          <select
            id={`${ids}-role`}
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className={FIELD}
          >
            {CLIENT_ROLE_CHOICES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <p className="max-w-prose text-[11px] leading-relaxed text-muted">
          {ROLE_SUMMARY[role as keyof typeof ROLE_SUMMARY] ?? ""}
        </p>
        <p className="max-w-prose text-[11px] leading-relaxed text-muted">
          <strong className="font-medium text-text">
            Whether this person may approve payments is decided now and never again.
          </strong>{" "}
          Their principal is created with that right or without it, the record of principals is
          append-only, and so there is no later edit that grants it. Choosing{" "}
          <code>viewer</code> or <code>initiator</code> today and wanting an approver tomorrow
          means removing them and adding them again — a new membership, with the old one&rsquo;s
          history left standing.
        </p>

        <LimitFields ids={ids} perTxn="" day="" month="" />
        <p className="max-w-prose text-[11px] leading-relaxed text-muted">
          Leave a limit blank for no limit of that kind. Type <code>0</code> and they spend
          nothing. Those are different answers and both are kept. These are the person&rsquo;s own
          limits and they sit on top of their card&rsquo;s — both are checked, in that order, on
          every purchase.
        </p>

        <label className="flex flex-col gap-1" htmlFor={`${ids}-note`}>
          <span className={LABEL}>Why they are joining</span>
          <input
            id={`${ids}-note`}
            name="note"
            required
            maxLength={400}
            placeholder="Warehouse manager, needs a card for fuel"
            className={FIELD}
          />
        </label>

        <button className={BUTTON} type="submit" disabled={pending}>
          {pending ? "Adding…" : `Add them to the team as ${actingName}`}
        </button>
      </form>
      <Receipt state={state} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Their role and limits                                                   */
/* -------------------------------------------------------------------------- */

function TermsForm({
  businessId,
  member,
}: {
  readonly businessId: string;
  readonly member: TeammateLine;
}) {
  const [state, formAction, pending] = useActionState(setTeammateTermsAction, CLIENT_TEAM_IDLE);
  const ids = useId();

  // A courtesy, not a rule: a person created without approval rights can never
  // hold a role that carries them, so the options that cannot be written are
  // not offered. `setTeammateTermsAction` refuses them anyway, by name, and
  // `assert_team_member_version()` refuses them after that.
  const choices = member.actorCanApprove
    ? CLIENT_ROLE_CHOICES
    : CLIENT_ROLE_CHOICES.filter((r) => r === "viewer" || r === "initiator");

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="memberId" value={member.memberId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-role`}>
            <span className={LABEL}>What they may do</span>
            <select id={`${ids}-role`} name="role" defaultValue={member.role} className={FIELD}>
              {choices.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-note`}>
            <span className={LABEL}>Why this is changing</span>
            <input
              id={`${ids}-note`}
              name="note"
              required
              maxLength={400}
              placeholder="Promoted to run the depot"
              className={FIELD}
            />
          </label>
        </div>
        <LimitFields
          ids={ids}
          perTxn={member.perTxnField}
          day={member.dailyField}
          month={member.monthlyField}
        />
        <button className={BUTTON} type="submit" disabled={pending}>
          {pending ? "Writing…" : `Save as version ${member.termsVersion + 1}`}
        </button>
      </form>
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        Saving writes a NEW version. Version {member.termsVersion} keeps saying what it says, and a
        purchase already judged under it still points at it — that is how &ldquo;what were they
        allowed to spend when this happened&rdquo; stays answerable months later.
        {member.actorCanApprove
          ? null
          : " They were created without approval rights, so approver and admin are not offered and cannot be written."}
      </p>
      <Receipt state={state} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Suspend, remove, bring back                                             */
/* -------------------------------------------------------------------------- */

function StateForm({
  businessId,
  member,
}: {
  readonly businessId: string;
  readonly member: TeammateLine;
}) {
  const [state, formAction, pending] = useActionState(endTeammateAction, CLIENT_TEAM_IDLE);
  const ids = useId();
  const [wanted, setWanted] = useState<string>(
    member.state === "suspended" ? "active" : "suspended",
  );
  const [typed, setTyped] = useState("");

  const removing = wanted === "removed";
  const confirmed = typed.trim() === member.displayName;

  const options =
    member.state === "suspended"
      ? [
          { value: "active", label: "Bring them back" },
          { value: "removed", label: "Remove them — terminal" },
        ]
      : [
          { value: "suspended", label: "Suspend them — reversible" },
          { value: "removed", label: "Remove them — terminal" },
        ];

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="memberId" value={member.memberId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-state`}>
            <span className={LABEL}>What to do</span>
            <select
              id={`${ids}-state`}
              name="state"
              value={wanted}
              onChange={(event) => setWanted(event.target.value)}
              className={FIELD}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-note`}>
            <span className={LABEL}>Why</span>
            <input
              id={`${ids}-note`}
              name="note"
              required
              maxLength={400}
              placeholder="Left the company on Friday"
              className={FIELD}
            />
          </label>
        </div>

        {removing ? (
          <div className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3">
            <p className="text-xs font-semibold text-negative">
              This cannot be undone, and it is the button next to the wrong row that does the
              damage.
            </p>
            <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
              Their card is closed at the issuer before anything is recorded, and a closed card does
              not reopen. Nothing of theirs is deleted — their history stands, and{" "}
              {member.outstandingCount === 0
                ? "they have nothing in flight right now."
                : `the ${member.outstandingCount} authorisation${
                    member.outstandingCount === 1 ? "" : "s"
                  } of theirs still in flight (${member.outstandingDisplay}) are untouched and will still settle against your account.`}{" "}
              Suspending is the reversible option.
            </p>
            <label className="mt-3 flex flex-col gap-1" htmlFor={`${ids}-confirm`}>
              <span className={LABEL}>Type their name to confirm</span>
              <input
                id={`${ids}-confirm`}
                name="confirmName"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={member.displayName}
                aria-describedby={`${ids}-confirm-state`}
                className={FIELD}
              />
            </label>
            <p id={`${ids}-confirm-state`} className="mt-1 text-[11px] text-muted">
              {confirmed
                ? "The name matches. The button below is live and it is terminal."
                : `Type ${member.displayName} exactly. The name is asked for rather than a fixed word so that the person you type is the person you chose. The server checks it again against the name it reads back from the database — this box being green is not what decides it.`}
            </p>
          </div>
        ) : null}

        <button className={BUTTON} type="submit" disabled={pending || (removing && !confirmed)}>
          {pending
            ? "Working…"
            : wanted === "active"
              ? `Bring ${member.displayName} back`
              : wanted === "suspended"
                ? `Suspend ${member.displayName}`
                : `Remove ${member.displayName}`}
        </button>
      </form>
      <Receipt state={state} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Give them a card                                                        */
/* -------------------------------------------------------------------------- */

function IssueCardForm({
  businessId,
  member,
}: {
  readonly businessId: string;
  readonly member: TeammateLine;
}) {
  const [state, formAction, pending] = useActionState(issueTeammateCardAction, CLIENT_TEAM_IDLE);
  // Generated ONCE, when this form first renders, and sent as Lithic's own
  // Idempotency-Key. A double-click, a refresh-resubmit or a retried POST
  // carries the same key and returns the SAME card instead of creating a
  // second real card on a real card program.
  const [formKey] = useState(() => crypto.randomUUID());

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="memberId" value={member.memberId} />
        <input type="hidden" name="formKey" value={formKey} />
        <button className={BUTTON} type="submit" disabled={pending || member.state !== "active"}>
          {pending ? "Creating the card…" : `Give ${member.displayName} a card`}
        </button>
      </form>
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        This creates a real card the moment you press it — nothing happens on load, and nothing
        happens twice: the button carries a key the issuer uses to return the same card if this is
        sent again. It arrives active, capped at $5,000.00 per purchase by the issuer itself, with{" "}
        {member.displayName}&rsquo;s own limits checked on top.
        {member.state === "active"
          ? null
          : ` ${member.displayName} is ${member.state}, so no card can be issued to them.`}
      </p>
      <Receipt state={state} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The per-person panel                                                       */
/* -------------------------------------------------------------------------- */

export function TeammateControls({
  businessId,
  member,
  canAdminister,
}: {
  readonly businessId: string;
  readonly member: TeammateLine;
  readonly canAdminister: boolean;
}) {
  if (!canAdminister) return null;

  if (member.isYou) {
    return (
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        <strong className="font-medium text-text">This is you.</strong> {ACTING_RULE}
      </p>
    );
  }

  if (member.state === "removed") {
    return (
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        Removed on {member.termsEffectiveFrom}. Removal is terminal — the database refuses any
        further version of these terms — so there is nothing to change here. Their row stays
        because everything they spent is still on your account and still has to be attributable to
        them. Bringing this person back is adding them again: a new membership, a new card, and
        this one&rsquo;s history left exactly as it is.
      </p>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-2">
        <h4 className={LABEL}>Their role and limits</h4>
        <TermsForm businessId={businessId} member={member} />
      </section>
      <section className="space-y-2">
        <h4 className={LABEL}>Their access</h4>
        <StateForm businessId={businessId} member={member} />
      </section>
      <section className="space-y-2 lg:col-span-2">
        <h4 className={LABEL}>Their card</h4>
        <IssueCardForm businessId={businessId} member={member} />
      </section>
    </div>
  );
}
