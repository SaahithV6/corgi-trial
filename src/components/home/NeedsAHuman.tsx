import Link from "next/link";
import type { ReactNode } from "react";
import type { Route } from "next";

import { DecisionForm } from "@/components/approvals/DecisionForm";
import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, Panel } from "@/components/ui/primitives";
import { formatAge, formatDate, formatTimestamp } from "@/lib/format/datetime";

import { attentionItems, outstanding, summariseAttention } from "./console-derive";
import type { AttentionItem } from "./console-derive";
import type { Attention, ConsoleActor, PendingPayment } from "./console-contract";

/**
 * What is waiting on a person, and the one control that acts on it.
 *
 * ============================================================================
 * The panel exists to answer a single question — is there anything I have to
 * do right now — and then to let the operator do the first of it without
 * leaving the page.
 * ============================================================================
 *
 * The decision form here is the SAME COMPONENT the approvals queue renders,
 * wired to the SAME server action. That is deliberate and it is not laziness:
 * a second approve button with its own action would be a second place for
 * maker-checker to be got wrong, and the whole point of this control is that
 * it is refused by `assert_maker_checker()` in Postgres exactly as the queue's
 * is. The gates beside it are a pre-computed explanation of what the trigger
 * will do — never permission, and never the check.
 *
 * On a fixture state the form is handed `live={false}` and says so instead of
 * offering to write against a row that has no database row behind it.
 */

/* -------------------------------------------------------------------------- */
/* Counts                                                                     */
/* -------------------------------------------------------------------------- */

function ItemLink({ item }: { readonly item: AttentionItem }) {
  const className = `font-medium underline underline-offset-4 ${FOCUS_RING}`;
  const label = `${item.count} ${item.label}`;

  return item.href.startsWith("/api/") ? (
    <a href={item.href} className={className}>
      {label}
    </a>
  ) : (
    <Link href={item.href as Route} className={className}>
      {label}
    </Link>
  );
}

function AttentionList({ attention }: { readonly attention: Attention }) {
  const items = attentionItems(attention);
  const open = outstanding(items);

  return (
    <div className="border-b border-border px-5 py-4">
      <p className="text-sm">{summariseAttention(items)}</p>

      {open.length === 0 ? (
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          Every count on this list is read from the view that defines it —
          <code className="mx-1 font-mono">v_overdrawn_accounts</code>,
          <code className="mx-1 font-mono">v_business_kyb</code>, the webhook
          inbox — so an empty list means those views are empty, not that nothing
          was checked.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {open.map((item) => (
            <li key={item.key} className="max-w-prose text-xs leading-relaxed">
              <ItemLink item={item} />
              <span className="mt-0.5 block text-muted">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The oldest thing in the queue                                              */
/* -------------------------------------------------------------------------- */

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function OldestPending({
  payment,
  live,
  now,
}: {
  readonly payment: PendingPayment;
  readonly live: boolean;
  readonly now: string;
}) {
  const age = formatAge(payment.requestedAt, now);

  return (
    <div className="px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="text-sm font-semibold tracking-tight">
          Oldest payment awaiting approval
        </h3>
        <span className="text-xs text-muted">
          raised {age === "just now" || age === "\u2014" ? age : `${age} ago`} ·{" "}
          {formatTimestamp(payment.requestedAt)}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Amount">
          <span className="text-lg font-semibold">
            <Money cents={payment.amountCents} tone="neutral" />
          </span>
          <span className="mt-0.5 block text-xs text-muted">
            {payment.currency} · {payment.rail}
            {payment.aboveThreshold ? " · above threshold" : " · below threshold"}
          </span>
        </Field>

        <Field label="To">
          {payment.destination}
          <span className="mt-0.5 block text-xs text-muted">
            value date {formatDate(payment.valueDate)}
          </span>
        </Field>

        <Field label="From">
          {payment.businessName ?? payment.accountName}
          <span className="mt-0.5 block text-xs text-muted">
            {payment.accountName}
          </span>
        </Field>

        <Field label="Raised by">
          {payment.initiatorName}
          <span className="mt-0.5 block text-xs text-muted">
            {payment.initiatorKind} · {payment.approvalsHeld} of{" "}
            {payment.approvalsRequired} approvals held under{" "}
            <span className="font-mono">{payment.policyVersion}</span>
          </span>
        </Field>
      </dl>

      <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
        The policy version is the one this row cites, read from its own{" "}
        <code className="font-mono">policy_id</code> and never re-picked from
        today&rsquo;s table — the threshold that applied when it was raised was{" "}
        <Money cents={payment.thresholdCents} tone="neutral" />, and it still
        is, whatever the table says now. The approval must cite the content
        hash below, so you cannot approve this amount and submit another one.
      </p>

      <p className="mt-2 font-mono text-[11px] break-all text-muted">
        {payment.contentHash}
      </p>

      <div className="mt-4 rounded-md border border-border bg-surface-raised px-4 py-4">
        <DecisionForm
          instructionId={payment.id}
          contentHash={payment.contentHash}
          gate={payment.gate}
          releaseGate={payment.releaseGate}
          live={live}
        />
      </div>

      <p className="mt-3 text-xs text-muted">
        <Link
          href="/approvals"
          className={`underline underline-offset-4 ${FOCUS_RING}`}
        >
          Work the whole queue on Approvals
        </Link>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function NeedsAHuman({
  attention,
  payment,
  actor,
  live,
  now,
}: {
  readonly attention: Attention;
  readonly payment: PendingPayment | null;
  readonly actor: ConsoleActor | null;
  readonly live: boolean;
  readonly now: string;
}) {
  return (
    <Panel
      id="needs-a-human"
      title="Needs a human"
      description="Counted at request time from the views that define each condition. Nothing on this list is a reminder — it is the current contents of a query."
      actions={
        actor === null ? (
          <Badge tone="negative">no actor resolved</Badge>
        ) : (
          <Badge tone="quiet">
            acting as {actor.displayName}
            {actor.canApprove ? " · can approve" : " · cannot approve"}
          </Badge>
        )
      }
    >
      <AttentionList attention={attention} />

      {payment === null ? (
        <p className="px-5 py-8 text-sm text-muted">
          Nothing is awaiting a decision. When a payment is raised it lands here
          and in the approvals queue, and the person who raised it can never be
          the one who approves it.
        </p>
      ) : (
        <OldestPending payment={payment} live={live} now={now} />
      )}
    </Panel>
  );
}
