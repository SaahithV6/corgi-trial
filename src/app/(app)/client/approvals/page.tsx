import { Suspense } from "react";
import type { Metadata } from "next";

import { ApproveView } from "@/components/client/ApproveView";
import { ClientErrorPanel, ClientNav, ClientSkeleton, ClientStateBar } from "@/components/client/Chrome";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadApprove } from "../sources";

export const metadata: Metadata = {
  title: "Approvals · Corgi",
};

export const dynamic = "force-dynamic";

/**
 * `/client/approvals` — the customer's side of maker-checker.
 *
 * The brief says users approve payments above a threshold. The operator's queue
 * at `/approvals` already does that, for every business at once; this is the
 * customer's own view of the same rule, scoped to one business and worded for
 * the person whose money it is — and the refusal reads as a sentence rather
 * than a SQLSTATE, because `classifyRefusal()` translates the exception and
 * only the code is printed beside it.
 *
 * It addresses one payment by reference rather than listing a queue, and
 * `ApproveView`'s header says why at length: there is no business-scoped queue
 * reader on this book, and filtering a platform-wide one in TypeScript would
 * turn tenant isolation from a predicate into a step.
 *
 * Five states, all in the URL:
 *
 *   (none)          LIVE. The policy in force, plus `?payment=` if given
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=empty    FIXTURE. Nothing is waiting on you
 *   ?state=error    FIXTURE. The read failed; no decision was recorded
 *   ?state=edge     LIVE. The same payment judged for whoever you are acting
 *                   as — including the refusal when that is the person who
 *                   raised it. Switch role in the console header to move
 *                   between the two sides of the rule.
 *
 * ...plus:
 *
 *   ?payment=<uuid>   the payment to answer for
 *   ?business=<uuid>  whose book
 */
export default async function ClientApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <ClientNav current="/client/approvals" view={view} />
      <ClientStateBar screen="/client/approvals" view={view} />
      <Suspense
        key={`${view.state}:${view.businessId ?? ""}:${view.paymentId ?? ""}`}
        fallback={<ClientSkeleton rows={3} />}
      >
        <ApproveSection view={view} />
      </Suspense>
    </div>
  );
}

async function ApproveSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadApprove(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <ApproveView screen={loaded.value} view={view} />;
}
