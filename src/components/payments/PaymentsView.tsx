import { ROLE_LABEL, readRole } from "@/components/app-shell/role";
import {
  Badge,
  MetaList,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { ErrorPanel } from "./ErrorPanel";
import { PaymentForm } from "./PaymentForm";
import { PaymentsSkeleton } from "./PaymentsSkeleton";
import type {
  ActorSource,
  ActorView,
  PaymentsDataSource,
  PaymentsSnapshot,
  Prefill,
  SourceAccountView,
} from "./data-contract";
import type { SourceClaim, PaymentsView as View } from "./demo-state";

export { PaymentsSkeleton };

/** The refusal wording, for the cause that is not a failed read. */
const NO_DATABASE_TITLE = "The payment form was not drawn";
const NO_DATABASE_DESCRIPTION =
  "No database is configured for this deployment, so the account list, the KYB gate and the threshold policy were not read. The form is not drawn, for the same reason it is not drawn after a failed read: a form assembled from an account list nobody fetched would offer a source account nobody checked and quote a threshold nobody looked up.";

/**
 * `/payments` — where a payment instruction is originated.
 *
 * An async server component behind the page's Suspense boundary. It reads the
 * account list, the KYB gate and the threshold policy through
 * `PaymentsDataSource`, and this session's identity through `ActorSource`, and
 * knows nothing about where either came from — which is the point. Identity is
 * still resolved on the server and never from anything the browser sent beyond
 * the role cookie, and even that is resolved by predicate against the `actor`
 * table; what changed is that the seam is chosen in `page.tsx`, where the live
 * implementations are reached only through `await import(...)` on the branch
 * that has established there is a database to read.
 *
 * IT USED TO CHOOSE THEM ITSELF, and that is the defect this screen carried.
 * Line 1 of this file was `import { createLivePaymentsSource } from
 * "@/app/(app)/payments/live-source"`, and `currentActor` was imported beside
 * it, so the page module reached `@/lib/ledger/db` -> `@/lib/env` before it
 * reached its own first line and threw without `APP_DATABASE_URL`. The three
 * fixture states went down with it, having asked for no database at all.
 *
 * ONE COMPONENT DRAWS BOTH OUTCOMES. The refusal is a failed `Result` from a
 * source, not a second rendering path, so there is no branch on which this
 * form could be drawn from nothing.
 *
 * This is the sibling of `/approvals`, and the pair is the whole loop: a maker
 * raises here, a different human checks there, and the money moves on Release.
 * Before this screen existed the loop did not close in the product —
 * `requestPayment()` was reachable from the MCP write tool and from a seed
 * script, which meant a person could approve payments but could not originate
 * one.
 *
 * `default` and `edge` are the live database; the other three states are
 * fixtures so a slow read, a failed read and an empty book can each be shown on
 * demand without arranging one. With no database configured the two live states
 * refuse and the three fixtures still draw — see `selectSource` in `page.tsx`.
 */
export async function PaymentsView({
  view,
  claim,
  source,
  actorSource,
}: {
  readonly view: View;
  readonly claim: SourceClaim;
  readonly source: PaymentsDataSource;
  readonly actorSource: ActorSource;
}) {
  const role = await readRole();
  const live = claim === "LIVE";
  const refusing = claim === "NO DATABASE";

  // Identity is resolved even in the fixture states, because the initiator this
  // form would attribute an instruction to is a true fact about whoever is
  // reading the screen, not part of the demo data.
  const actor: ActorView | null = await actorSource.current();

  const result = await source.getFormData(actor);

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header role={role} actor={actor} claim={claim} asOf={null} />
        {refusing ? (
          <ErrorPanel
            error={result.error}
            title={NO_DATABASE_TITLE}
            description={NO_DATABASE_DESCRIPTION}
            offerExit={false}
          />
        ) : (
          <ErrorPanel error={result.error} />
        )}
      </div>
    );
  }

  const snapshot = result.value;

  return (
    <div className="space-y-6">
      <Header role={role} actor={actor} claim={claim} asOf={snapshot.asOf} />

      <Note title="Submitting this form does not move money, and cannot">
        <p>
          It writes one <code className="font-mono">payment_instruction</code> row and one{" "}
          <code className="font-mono">requested</code> event, in a single transaction, and stops.
          No journal entry exists. No balance changes. Nothing is sent to a rail. The money leaves
          only when a human presses <span className="font-medium">Release</span> on{" "}
          <code className="font-mono">/approvals</code>, which is a different call, made by a
          different person, and — above the threshold — only after the approvals the policy
          version demands.
        </p>
        <p className="mt-2">
          That separation is the reason this screen is allowed to exist at all.{" "}
          <code className="font-mono">docs/AGENT-LIMITS.md</code> draws the line as &ldquo;an agent
          may state an intention; it may not make a fact final&rdquo;. A request is survivable when
          it is wrong, because the next step is a person. This form states an intention. It has no
          route to <code className="font-mono">postEntry()</code> — the module is not imported on
          this path — and <code className="font-mono">corgi_app</code> holds no UPDATE or DELETE on
          the money tables, so even a compromised process could only append.
        </p>
      </Note>

      {snapshot.accounts.length === 0 ? (
        <EmptyBook />
      ) : (
        <Panel
          id="raise"
          title="Raise a payment instruction"
          description="One form, one server action, one entry point. The MCP write tool calls the same requestPayment() with the same schema and lands in the same queue under the same policy version — there is no second path, and this screen is not a privileged one."
          actions={<Badge tone={live ? "positive" : "quiet"}>{claim}</Badge>}
        >
          <PaymentForm
            accounts={snapshot.accounts}
            policies={snapshot.policies}
            defaultValueDate={snapshot.defaultValueDate}
            wirePayeesByBusiness={snapshot.wirePayeesByBusiness}
            prefill={view.state === "edge" ? edgePrefill(snapshot) : null}
            live={live}
          />
        </Panel>
      )}

      {view.state === "edge" ? <EdgeNote snapshot={snapshot} /> : null}

      <GatePanel accounts={snapshot.accounts} />

      <PolicyTable snapshot={snapshot} />

      <p className="max-w-prose text-xs leading-relaxed text-muted">
        {role === "approver"
          ? "Acting as Approver: anything you raise here you can never approve. assert_maker_checker() refuses an approved event whose actor is the instruction's own requested_by, with SQLSTATE 42501 — so originating a payment on this screen actively removes your ability to check it, which is the control working rather than the control being inconvenient."
          : "Acting as Staff: raising a payment is exactly the half of maker-checker this role holds. can_approve is false on this actor, so the queue on /approvals will show your instruction with its approve button disabled for you and live for somebody else."}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The board's heading.
 *
 * THE BADGE IS DROPPED WHEN THE CLAIM IS "NO DATABASE", and that is not
 * tidiness. One screen makes one claim about its data source. On a deployment
 * with nothing to read the claim is carried by the demo-state bar above, whose
 * badge reads NO DATABASE; a second badge here would be the board saying
 * something about a form it did not draw. Both are derived from the same
 * `sourceClaim()` call in `page.tsx`, so they cannot drift apart.
 */
function Header({
  role,
  actor,
  claim,
  asOf,
}: {
  readonly role: "staff" | "approver";
  readonly actor: ActorView | null;
  readonly claim: SourceClaim;
  readonly asOf: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Payments</h1>
        {claim === "NO DATABASE" ? null : (
          <Badge tone={claim === "LIVE" ? "positive" : "quiet"}>{claim}</Badge>
        )}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        Money out, originated. The maker&rsquo;s half of §16; the checker&rsquo;s half is
        /approvals.
      </p>
      <div className="mt-3">
        <MetaList
          items={[
            { label: "Acting as", value: ROLE_LABEL[role] },
            {
              label: "Initiator",
              value:
                actor === null ? (
                  <span className="text-negative">unresolved</span>
                ) : (
                  <>
                    {actor.displayName}
                    <span className="ml-2 text-muted">
                      {actor.canApprove
                        ? "can approve — but never their own"
                        : "cannot approve anything"}
                    </span>
                  </>
                ),
            },
            ...(asOf === null ? [] : [{ label: "As of", value: formatTimestamp(asOf) }]),
          ]}
        />
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* The edge state's prefill and its explanation                               */
/* -------------------------------------------------------------------------- */

/**
 * $2,500.00 on ACH, from the one business the gate currently lets transact.
 *
 * That figure is not a round number chosen to look tidy. The seeded ACH policy
 * has `threshold_cents = 250000` and the test in `requestPayment()` is
 * `amountCents >= policy.thresholdCents` — so $2,500.00 is the exact boundary,
 * and the boundary is where a threshold rule is either right or off by one
 * cent. Submitting it should come back needing one approval; a build that
 * wrote `>` instead of `>=` would come back needing none, and the receipt would
 * say so in a way nobody could miss.
 *
 * The reference carries the value date, so the idempotency key is stable for a
 * day: press it twice in one afternoon and the second press replays the first
 * instruction instead of queueing a second payment.
 */
function edgePrefill(snapshot: PaymentsSnapshot): Prefill {
  const transactable = snapshot.accounts.find((account) => account.gate.allowed);
  return {
    accountId: transactable?.id ?? snapshot.accounts[0]?.id ?? null,
    rail: "ach",
    amount: "2500.00",
    reference: `THRESHOLD-${snapshot.defaultValueDate}`,
    holderName: "Fairbanks Machining LLC",
    routingNumber: "021000021",
    accountNumberLast4: "4417",
  };
}

function EdgeNote({ snapshot }: { readonly snapshot: PaymentsSnapshot }) {
  const simulated = snapshot.accounts.find(
    (account) => account.gate.allowed && !account.gateIfLiveRequired.allowed,
  );
  const blocked = snapshot.accounts.find((account) => !account.gate.allowed);

  return (
    <Note emphasis title="The edge case, and why it is two things at once">
      <p>
        <span className="font-medium text-text">On the threshold.</span> The form is prefilled with
        $2,500.00 on ACH, which is exactly{" "}
        <code className="font-mono">threshold_cents = 250000</code> on{" "}
        <code className="font-mono">ach@2026-01-01</code>. The rule is{" "}
        <code className="font-mono">amount_cents &gt;= threshold_cents</code>, so equal crosses it
        and this payment needs an approver. One cent less does not. Submit it and read{" "}
        <span className="font-medium">Approvals required</span> on the receipt — that number is
        computed in the same transaction that wrote the row, against the policy version the row
        pins, and it is the difference between a control that fires on the boundary and one that is
        off by a cent.
      </p>
      {simulated === undefined ? null : (
        <p className="mt-2">
          <span className="font-medium text-text">On simulated evidence.</span>{" "}
          {simulated.businessName} is <code className="font-mono">approved</code>, and it is
          approved on <code className="font-mono">simulated</code> evidence — this deployment has
          no registry provider keys, so nobody real checked. Under this deployment&rsquo;s policy (
          <code className="font-mono">requireLiveEvidence: false</code>) it may transact, and the
          payment above will be queued. Under{" "}
          <code className="font-mono">requireLiveEvidence: true</code> — what any deployment
          touching real money would run — the identical call is refused{" "}
          <code className="font-mono">{simulated.gateIfLiveRequired.code}</code>. Both answers are
          shown on the form, side by side, because a green tick that does not say whose evidence it
          is is the failure this codebase keeps catching.
        </p>
      )}
      {blocked === undefined ? null : (
        <p className="mt-2">
          <span className="font-medium text-text">And the refusal you can actually trigger.</span>{" "}
          Switch <span className="font-medium">Pay from</span> to {blocked.businessName} and press
          the button. It is refused <code className="font-mono">{blocked.gate.code}</code> by{" "}
          <code className="font-mono">canTransact()</code>, inside the write transaction, before
          any row is inserted. That is &ldquo;unverified entities can look but not
          transact&rdquo;, happening, with a code on it.
        </p>
      )}
    </Note>
  );
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                     */
/* -------------------------------------------------------------------------- */

function EmptyBook() {
  return (
    <Panel
      title="Raise a payment instruction"
      description="There is nothing to pay from."
    >
      <div className="px-5 py-10 text-center">
        <p className="text-sm font-medium">No account on this book can originate a payment.</p>
        <p className="mx-auto mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
          Not an error. A deposit account exists only after a business has been onboarded, and a
          business with no account has nowhere for money to leave from — which is the structural
          half of the same gate the KYB check enforces explicitly. Start a verification on{" "}
          <code className="font-mono">/onboarding</code> and this form will have a source.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Both readings of the gate, for every account, whether or not it is selected.
 *
 * The second column is the one worth the space. `canTransact()` under
 * `requireLiveEvidence: true` is what this deployment would do if it were
 * holding real money, and printing it beside the answer that is actually in
 * force is the difference between "verified" and "verified by nobody, and we
 * are telling you".
 */
function GatePanel({ accounts }: { readonly accounts: readonly SourceAccountView[] }) {
  return (
    <Panel
      id="gate"
      title="The KYB gate, read for every account before you type"
      description="A preview, not the control. The gate that decides runs inside requestPayment()'s transaction, under the same snapshot that writes the instruction — so a business approved when this page rendered and revoked a second later is refused at the write, which is the only place it matters."
    >
      <TableScroll>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                Business
              </th>
              <th scope="col" className={TH_CLASS}>
                Status
              </th>
              <th scope="col" className={TH_CLASS}>
                Evidence
              </th>
              <th scope="col" className={TH_CLASS}>
                This deployment
              </th>
              <th scope="col" className={TH_CLASS}>
                If live evidence were required
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id} className="border-b border-border last:border-b-0">
                <td className={TD_CLASS}>
                  <div>{account.businessName}</div>
                  <div className="text-xs text-muted">{account.name}</div>
                </td>
                <td className={`${TD_CLASS} font-mono text-xs`}>
                  {account.gate.status ?? "—"}
                </td>
                <td className={`${TD_CLASS} font-mono text-xs`}>
                  {account.gate.evidence ?? "—"}
                </td>
                <td className={TD_CLASS}>
                  {account.gate.allowed ? (
                    <Badge tone="positive">may transact</Badge>
                  ) : (
                    <Badge tone="negative">{account.gate.code}</Badge>
                  )}
                </td>
                <td className={TD_CLASS}>
                  {account.gateIfLiveRequired.allowed ? (
                    <Badge tone="positive">may transact</Badge>
                  ) : (
                    <Badge tone="negative">{account.gateIfLiveRequired.code}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}

/**
 * Every version of every payout rail's threshold policy.
 *
 * Shown in full, including versions no longer in force, because that is the
 * whole argument for effective dating: `approval_policy` is append-only, a
 * change is a new row with a later `effective_from`, and both rows exist for
 * ever. An instruction stores the id of the row it was judged under, so raising
 * the ACH threshold tomorrow cannot make a payment queued today look compliant
 * or non-compliant in retrospect — it still cites `ach@2026-01-01`, and that row
 * is still here.
 */
function PolicyTable({ snapshot }: { readonly snapshot: PaymentsSnapshot }) {
  return (
    <Panel
      id="policies"
      title="Threshold policy, every version"
      description="Append-only and effective-dated. The version that judges a payment is chosen by its VALUE DATE, not by today — change the value date on the form above and the sentence under it changes with it."
    >
      <TableScroll>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                Version
              </th>
              <th scope="col" className={TH_CLASS}>
                In force from
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Threshold
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Approvals
              </th>
              <th scope="col" className={TH_CLASS}>
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.policies.map((policy) => (
              <tr key={policy.id} className="border-b border-border last:border-b-0">
                <td className={`${TD_CLASS} font-mono`}>{policy.version}</td>
                <td className={`${TD_CLASS} text-muted`}>{formatDate(policy.effectiveFrom)}</td>
                <td className={`${TD_CLASS} money text-right`}>{policy.thresholdDisplay}</td>
                <td className={`${TD_CLASS} money text-right`}>{policy.requiredApprovals}</td>
                <td className={`${TD_CLASS} max-w-prose text-xs leading-relaxed text-muted`}>
                  {policy.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
