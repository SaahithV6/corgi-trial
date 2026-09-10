import Link from "next/link";

import { Badge, FOCUS_RING, MetaList, type BadgeTone } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import type { KybStatus } from "@/lib/kyb";

import type { BusinessKybView, LegView, TransactGateView } from "./data-contract";
import { VerificationForm } from "./VerificationForm";

const STATUS_TONE: Record<KybStatus, BadgeTone> = {
  approved: "positive",
  pending: "neutral",
  needs_review: "neutral",
  rejected: "negative",
};

const STATUS_NOTE: Record<KybStatus, string> = {
  approved: "Both legs answered and neither blocks. The only status that permits transacting.",
  pending:
    "A provider has not answered — or only one leg is on file, which the view reads as pending, because a verification half of which was never performed has not passed.",
  needs_review: "A human has to act: a review, a dead session, or a code this build does not know.",
  rejected: "A decision to say no. Terminal — there is no path from here to approved.",
};

/**
 * One business, and everything the screen knows about why it may or may not
 * move money.
 *
 * NOTHING ON THIS CARD IS A STORED FLAG. `business` has no `kyb_status` column
 * and no `kyb_evidence` column, deliberately: both are derived by
 * `v_business_kyb` from the latest row per leg, every time they are read, so
 * there is no column an UPDATE could forge. The card shows the legs underneath
 * the derived answer for exactly that reason — the answer is checkable against
 * its own inputs, right here.
 */
export function EntityCard({
  business,
  live,
}: {
  readonly business: BusinessKybView;
  readonly live: boolean;
}) {
  const { status, evidence } = business;

  return (
    <section
      aria-labelledby={`kyb-${business.businessId}`}
      className="rounded-lg border border-border bg-surface"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 id={`kyb-${business.businessId}`} className="text-sm font-semibold tracking-tight">
              {business.legalName}
            </h3>
            <Badge tone={STATUS_TONE[status]} title={STATUS_NOTE[status]}>
              {status}
            </Badge>
            <Badge
              tone={evidence === "live" ? "positive" : "quiet"}
              title={
                evidence === "live"
                  ? "Every leg was answered by a third party we do not control."
                  : "At least one leg was answered by us. A composite is only as live as its least live leg, and the label never un-degrades."
              }
            >
              evidence · {evidence}
            </Badge>
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {STATUS_NOTE[status]}
          </p>
        </div>

        <MetaList
          items={[
            { label: "EIN", value: <span className="font-mono">{business.ein}</span> },
            { label: "Legs on file", value: `${business.legsOnFile} of 2` },
            {
              label: "Decided",
              value:
                business.decidedAt === null ? (
                  <span className="text-muted">never</span>
                ) : (
                  formatTimestamp(business.decidedAt)
                ),
            },
          ]}
        />
      </header>

      <div className="border-b border-border px-5 py-4">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Evidence on file
        </h4>
        {business.legs.length === 0 ? (
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            None. No verification has been started, so there is nothing to cite and nothing to
            derive a status from — which is why the view reads{" "}
            <span className="font-mono">pending</span> rather than assuming the best.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {business.legs.map((leg) => (
              <LegRow key={leg.leg} leg={leg} />
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-x-8 gap-y-4 border-b border-border px-5 py-4 sm:grid-cols-2">
        <GateReading
          title="canTransact() — this deployment"
          gate={business.gate}
          note="requireLiveEvidence is false here, and that default is a stated choice: this deployment runs without a full set of provider keys, and a gate that denies everything teaches people to route around the gate."
        />
        <GateReading
          title="canTransact() — requireLiveEvidence"
          gate={business.gateIfLiveRequired}
          note="The same row, in a deployment that touches real money. One flag, no second code path."
        />
      </div>

      <div className="border-b border-border px-5 py-4">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Where money would land
        </h4>
        {business.depositAccount === null ? (
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            <span className="font-medium text-text">No deposit account.</span> The 2100 account and
            its two memo hold accounts are opened on approval and not before — you cannot owe money
            to a business you have not verified. So half this gate is structural rather than a
            check: an inbound credit for {business.legalName} has nowhere to land and parks in 2400
            suspense, whatever any flag says.
          </p>
        ) : (
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            <Link
              href={`/accounts/${business.depositAccount.id}`}
              className={`font-medium text-text underline underline-offset-4 ${FOCUS_RING}`}
            >
              {business.depositAccount.name}
            </Link>{" "}
            <span className="font-mono">({business.depositAccount.code})</span> — opened when KYB
            approved, which is the only event that opens one.
          </p>
        )}
      </div>

      <div className="px-5 py-4">
        <VerificationForm
          businessId={business.businessId}
          legalName={business.legalName}
          legsOnFile={business.legsOnFile}
          gate={business.gate}
          live={live}
        />
      </div>
    </section>
  );
}

function LegRow({ leg }: { readonly leg: LegView }) {
  return (
    <li className="rounded-md border border-border bg-surface-raised px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-medium">{leg.label}</span>
        <Badge tone={STATUS_TONE[leg.status]}>{leg.status}</Badge>
        <Badge tone={leg.evidence === "live" ? "positive" : "quiet"}>{leg.evidence}</Badge>
        <span className="font-mono text-[11px] text-muted">{leg.provider}</span>
      </div>
      <p className="mt-1 break-all font-mono text-[11px] text-muted">
        {leg.reference}
        {leg.rawStatus === null ? null : (
          <span className="ml-2">· provider said &ldquo;{leg.rawStatus}&rdquo;</span>
        )}
      </p>
      {leg.checks.length === 0 ? null : (
        <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted">
          {leg.checks.map((check) => (
            <li key={check.name}>
              <span className="font-mono">{check.name}</span>: {check.status}
              {check.reasons.length === 0 ? null : ` — ${check.reasons.join("; ")}`}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-muted">observed {formatTimestamp(leg.observedAt)}</p>
    </li>
  );
}

function GateReading({
  title,
  gate,
  note,
}: {
  readonly title: string;
  readonly gate: TransactGateView;
  readonly note: string;
}) {
  return (
    <div>
      <h4 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{title}</h4>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-2">
        <Badge tone={gate.allowed ? "positive" : "negative"}>
          {gate.allowed ? "may transact" : "may not transact"}
        </Badge>
        {gate.code === null ? null : (
          <span className="font-mono text-[11px] text-negative">{gate.code}</span>
        )}
      </p>
      <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">{gate.message}</p>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}
