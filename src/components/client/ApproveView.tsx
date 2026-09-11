import { Money } from "@/components/ui/Money";
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

import { formatTimestamp } from "@/lib/format/datetime";

import type { ApprovalItem, ApproveScreen } from "./contract";
import { ApproveForm } from "./ApproveForm";
import { ClientHeaderBar } from "./Chrome";
import { destinationSentence, eventWord, paymentStateWord, railWord } from "./language";
import { clientHref, type ClientView } from "./view-state";

/**
 * Approve — the customer's own view of maker-checker.
 *
 * ===========================================================================
 * WHY THERE IS NO QUEUE ON THIS PAGE, AND WHAT IT WOULD TAKE
 * ===========================================================================
 *
 * The brief asks for a queue and this screen does not have one. That is not an
 * omission; it is a refusal, and the refusal is the interesting part.
 *
 * `listQueue()` — the only reader of pending payments in this build — takes
 * `{ pendingOnly, limit }` and nothing else. It is platform-wide by design: it
 * feeds the operator console, which is supposed to span every business. Its
 * row type does not even carry a business id. Measured against this database,
 * the first eight rows it returns belong to *Hold Fuzzer Fixture Co.*
 *
 * There is an obvious way to get a customer queue out of it: call it and drop
 * the rows that are not yours. `src/lib/api/limits.ts` already considered and
 * refused exactly that for the public API, in these words — *"it makes tenant
 * isolation a STEP rather than a PREDICATE, and a step can be reordered,
 * short-circuited or dropped by whoever next edits the paging logic. On a
 * public API that step is the only thing between one customer and another
 * customer's payments."* A customer-facing queue is the same surface, and the
 * argument does not get weaker for being on a screen instead of an endpoint.
 *
 * So this screen does what the public API does: it answers for an id. A payment
 * raised on `/client/pay` links here with its own reference, which is the path
 * a customer actually walks, and the point read is scoped by comparing the
 * instruction's account to this business — one row, one id. A payment belonging
 * to somebody else produces the SAME answer as one that does not exist, so the
 * screen cannot be used to discover which references are real.
 *
 * The reader that would fix it is one WHERE clause in the file that defines
 * what a queued payment is:
 *
 *     listQueue({ businessId, pendingOnly, limit }, conn)
 *
 * on a query that already joins `account acc`. It is not mine to write —
 * `src/lib/**` belongs to other workers on this build — so it is reported here,
 * in the place where its absence is visible, rather than worked around
 * somewhere a reviewer would have to find it.
 */
export function ApproveView({
  screen,
  view,
}: {
  readonly screen: ApproveScreen;
  readonly view: ClientView;
}) {
  const { header, payment, policies, lookupMessage } = screen;

  return (
    <div className="space-y-6">
      <ClientHeaderBar
        screen="/client/approvals"
        view={view}
        header={header}
        title="Approvals"
        subtitle="Payments above a certain size need a second person. This is where that person says yes — and where the system explains, in a sentence, when they cannot."
      />

      <Panel
        title="Find a payment"
        description="Paste the reference you were given when the payment was raised. Every payment you send from this account links here with its own."
      >
        <form
          action="/client/approvals"
          method="get"
          className="flex flex-wrap items-end gap-3 px-5 py-5"
        >
          {view.state === "default" ? null : (
            <input type="hidden" name="state" value={view.state} />
          )}
          {view.businessId === null ? null : (
            <input type="hidden" name="business" value={view.businessId} />
          )}
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium">Payment reference</span>
            <input
              name="payment"
              defaultValue={view.paymentId ?? ""}
              placeholder="00000000-0000-0000-0000-000000000000"
              className={`rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING}`}
            />
          </label>
          <button
            type="submit"
            className={`rounded border border-border-strong px-3 py-2 text-sm font-medium ${FOCUS_RING}`}
          >
            Look it up
          </button>
        </form>

        {lookupMessage === null ? null : (
          <div className="border-t border-border px-5 py-4">
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              {lookupMessage}
            </p>
          </div>
        )}
      </Panel>

      {payment === null ? (
        <Note title="Why this page asks for a reference instead of listing everything">
          <p>
            Showing you a list would mean reading a queue that spans every
            customer of this bank and then removing the rows that are not yours.
            We will not do that. The line that keeps your payments apart from
            everybody else&rsquo;s has to be inside the question we ask the
            database, not a step we run afterwards and could one day forget.
          </p>
          <p className="mt-2">
            The query that would let us list your payments safely has not been
            written yet, and until it is, this page answers for one payment at a
            time. Every payment you raise links straight here.{" "}
            <span className="text-text">
              This is written up in <code>docs/CLIENT.md</code>, with the exact
              change it needs.
            </span>
          </p>
        </Note>
      ) : (
        <PaymentCard item={payment} live={header.live} />
      )}

      <Panel
        title="The rule, and where it is actually enforced"
        description="Your bank does not merely decline to let you approve your own payment. The database refuses to record it."
      >
        <div className="space-y-3 px-5 py-5 text-xs leading-relaxed text-muted">
          <p>
            Whoever asks for a payment can never be the one who approves it —
            not the person who raised it, not an administrator, and not the
            automated assistant, which cannot hold approval rights at all
            because there is no row shape in which it could.
          </p>
          <p>
            Where you see a greyed-out button below, the screen is telling you in
            advance what the database would do. It is not the check. Every
            decision is sent to the database and refused there.
          </p>
        </div>

        {policies.length === 0 ? null : (
          <TableScroll>
            <table className="w-full border-collapse border-t border-border">
              <caption className="sr-only">Approval thresholds</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH_CLASS}>
                    How it travels
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Needs a second person at
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Why
                  </th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.version} className="border-b border-border last:border-b-0">
                    <td className={TD_CLASS}>{railWord(policy.rail)}</td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                      {policy.requiredApprovals === 0 ? (
                        <span className="text-muted">never</span>
                      ) : policy.thresholdCents === 0n ? (
                        "every payment"
                      ) : (
                        <Money cents={policy.thresholdCents} tone="neutral" />
                      )}
                    </td>
                    <td className={`${TD_CLASS} max-w-prose text-xs text-muted`}>
                      {policy.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <p className="text-xs text-muted">
        <a
          href={clientHref("/client/pay", { businessId: view.businessId })}
          className={`underline underline-offset-4 ${FOCUS_RING}`}
        >
          Send a payment
        </a>{" "}
        and it will appear here with its own reference.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PaymentCard({
  item,
  live,
}: {
  readonly item: ApprovalItem;
  readonly live: boolean;
}) {
  return (
    <Panel
      title={paymentStateWord(item.state)}
      description="Everything this payment is locked to. An approval cites the fingerprint below, so it cannot be moved onto a different amount or a different payee."
      actions={
        item.aboveThreshold ? (
          <Badge tone="neutral">needs a second person</Badge>
        ) : (
          <Badge tone="quiet">under the threshold</Badge>
        )
      }
    >
      <div className="space-y-5 px-5 py-5">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <FieldLabel>Amount</FieldLabel>
            <p className="mt-1">
              <Money cents={item.amountCents} className="text-2xl font-semibold" tone="neutral" />
            </p>
          </div>
          <div>
            <FieldLabel>To</FieldLabel>
            <p className="mt-1 text-sm">{destinationSentence(JSON.parse(item.destination))}</p>
          </div>
          <div>
            <FieldLabel>How</FieldLabel>
            <p className="mt-1 text-sm">{railWord(item.rail)}</p>
          </div>
          <div>
            <FieldLabel>Dated</FieldLabel>
            <p className="mt-1 text-sm">{item.valueDate}</p>
          </div>
        </div>

        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Asked for by{" "}
          <span className="font-medium text-text">{item.requestedByName}</span>
          {item.requestedByKind === "human" ? "" : " (an automated assistant)"} on{" "}
          {formatTimestamp(item.requestedAt)}.{" "}
          {item.approvalsRequired === 0
            ? "It is under the amount that needs a second person."
            : `It has ${item.approvalsHeld} of ${item.approvalsRequired} approval${
                item.approvalsRequired === 1 ? "" : "s"
              }.`}
        </p>

        <MetaList
          items={[
            { label: "rule version", value: <code>{item.policyVersion}</code> },
            {
              label: "second person needed at",
              value: <Money cents={item.thresholdCents} tone="neutral" />,
            },
            {
              label: "fingerprint",
              value: <code>{item.contentHash.slice(0, 16)}…</code>,
            },
          ]}
        />

        {live ? (
          <ApproveForm
            instructionId={item.instructionId}
            contentHash={item.contentHash}
            canDecide={item.gate.allowed}
            decideReason={item.gate.allowed ? null : item.gate.reason}
            canRelease={item.release.allowed}
            releaseReason={item.release.allowed ? null : item.release.reason}
          />
        ) : (
          <p className="text-xs text-muted">
            FIXTURE. Decisions are only recorded against the live book — there is
            no database row behind this one, and the screen will not pretend
            otherwise.
          </p>
        )}

        <div className="border-t border-border pt-4">
          <FieldLabel>Everything that has happened to it</FieldLabel>
          <ul className="mt-2 space-y-1.5">
            {item.events.map((event, index) => (
              <li key={`${event.kind}:${event.occurredAt}:${index}`} className="text-xs">
                <span className="font-medium">{eventWord(event.kind)}</span>
                <span className="text-muted">
                  {" "}
                  — {event.actorName}
                  {event.actorKind === "human" ? "" : " (automated)"}, {formatTimestamp(event.occurredAt)}
                </span>
                {event.reason === null ? null : (
                  <span className="mt-0.5 block max-w-prose text-muted">
                    &ldquo;{event.reason}&rdquo;
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
            This list only ever grows. A decision is added, never replaced, so
            the record of what was decided and by whom cannot be tidied up
            afterwards.
          </p>
        </div>
      </div>
    </Panel>
  );
}
