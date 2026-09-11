"use client";

import Link from "next/link";

import type { CheckReceipt } from "@/app/(app)/payees/actions";
import { Badge, FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import { AbaWorking } from "./AbaWorking";
import { ConfirmationStep } from "./ConfirmationStep";
import { SignWarningForm } from "./SignWarningForm";
import { payeeHref } from "./view-state";

/**
 * What a check came back with — the panel that was written and never wired.
 *
 * `ConfirmationStep` has existed since the feature was built and had no
 * importer: it is presentational, pure, and renders a decision `verifyPayee()`
 * already made, which is exactly what a confirmation step has to be if it is
 * never to disagree with the row that got written. THIS is the thing that was
 * missing — the caller that hands it a real decision and the form that turns
 * a warning into a signature.
 *
 * Three shapes, and they look different on purpose:
 *
 *   BLOCKED   `ConfirmationStep` renders no continue control at all. The
 *             arithmetic is shown underneath in full, because a refusal
 *             somebody can check is a refusal they believe, and because the
 *             one thing they can do about it — re-key from the paperwork — is
 *             only obvious once they can see which digits missed.
 *
 *   WARNED    A continue path exists and it costs a sentence. The signature
 *             names the findings it answers; see `SignWarningForm`.
 *
 *   VERIFIED  Continue, with the notes still on the page rather than collapsed
 *             behind a tick. The commonest failure of a feature like this is a
 *             green tick a reader takes to mean more than it says.
 *
 * THE ROW IDS ARE PRINTED. `payee_verification` and `payee` are append-only,
 * so the ids are what a reviewer quotes when they ask what the system believed
 * at a given moment — and they are the proof that this panel is showing a row
 * rather than a calculation.
 */
export function ConfirmationResult({
  receipt,
  headline,
  code,
  refused,
}: {
  readonly receipt: CheckReceipt;
  readonly headline: string;
  readonly code: string | null;
  readonly refused: boolean;
}) {
  const suggestions =
    receipt.arithmetic.state === "computed"
      ? receipt.arithmetic.transpositions.map((t) => t.candidate)
      : [];

  return (
    <div className="space-y-4">
      <ConfirmationStep
        view={{
          decision: receipt.decision,
          holderName: receipt.holderName,
          routingNumber: receipt.routingNumber,
          accountNumberLast4: receipt.accountNumberLast4,
          rail: receipt.rail,
          institutionName: receipt.institutionName,
          counterpartyName: receipt.counterpartyName,
          nameSource: receipt.nameSource,
          nameMatchScore: receipt.nameMatchScore,
          findings: receipt.findings,
          suggestions,
        }}
        acknowledgeForm={
          receipt.verificationId === null ? (
            <p className="text-xs leading-relaxed text-muted">
              Nothing was written, so there is no check for a signature to attach itself to. An
              acknowledgement references a `payee_verification` row by id; without one there is
              nothing to sign.
            </p>
          ) : (
            <SignWarningForm
              verificationId={receipt.verificationId}
              findings={receipt.findings.filter((finding) => finding.severity === "warn")}
              beneficiaryName={receipt.holderName}
            />
          )
        }
        continueAction={
          receipt.payeeId === null ? undefined : (
            <p className="text-xs leading-relaxed text-muted">
              This beneficiary is on the book and a payment to it passes the payee gate. What that
              gate proves is the arithmetic and the absence of an unsigned warning — it is not a
              statement that anybody confirmed who owns the account.
            </p>
          )
        }
      />

      <Panel
        title={refused ? (code ?? "Refused") : "What was written"}
        as="h3"
        description={headline}
        actions={<Badge tone={refused ? "negative" : "neutral"}>{code ?? "—"}</Badge>}
      >
        <div className="border-b border-border px-5 py-4">
          <MetaList
            items={[
              {
                label: "payee row",
                value:
                  receipt.payeeId === null ? (
                    <span className="text-muted">none — a blocked candidate is not a payee</span>
                  ) : (
                    <Link
                      href={payeeHref({ payeeId: receipt.payeeId })}
                      className={`font-mono underline underline-offset-4 ${FOCUS_RING}`}
                    >
                      {receipt.payeeId}
                    </Link>
                  ),
              },
              {
                label: "verification row",
                value:
                  receipt.verificationId === null ? (
                    <span className="text-muted">none</span>
                  ) : (
                    <span className="font-mono">{receipt.verificationId}</span>
                  ),
              },
              { label: "checked", value: formatTimestamp(receipt.checkedAt) },
              { label: "by", value: receipt.checkedByName },
              {
                label: "evidence",
                value:
                  receipt.evidence === "live"
                    ? `live · ${receipt.directoryProvider ?? receipt.nameProvider ?? "provider"}`
                    : "local only — no third party answered",
              },
              { label: "new payee", value: receipt.created ? "yes" : "no — key already existed" },
            ]}
          />
        </div>

        <div className="space-y-4 px-5 py-4">
          <AbaWorking
            explanation={receipt.arithmetic}
            railLabel={receipt.rail === "wire" ? "WIRE ABA" : "ACH ABA"}
          />
        </div>

        {receipt.payeeId === null ? (
          <div className="border-t border-border px-5 py-4">
            <Note title="Where the caught typo went">
              <p>
                A blocked candidate never becomes a payee, so without a record of it the thing
                this feature exists to catch would be invisible five minutes after it was caught.
                It is a <code>payee_candidate_refusal</code> row — the digits as typed, not
                normalised and not corrected — and it is the only table here whose routing-number
                column has no checksum constraint, because its job is to hold the numbers that
                fail one. It is on this screen under &ldquo;Refused before they became
                payees&rdquo;.
              </p>
            </Note>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
