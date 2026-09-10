import { ROLE_LABEL, readRole } from "@/components/app-shell/role";
import { Badge, MetaList, Note } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import { createLiveOnboardingSource } from "@/lib/kyb/wire";
import { isErr } from "@/lib/result";

import { EntityCard } from "./EntityCard";
import { ErrorPanel } from "./ErrorPanel";
import { OnboardingSkeleton } from "./OnboardingSkeleton";
import { WiringPanel } from "./WiringPanel";
import type { OnboardingDataSource } from "./data-contract";
import { createFixtureSource } from "./fixtures";
import type { OnboardingView as View } from "./demo-state";

export { OnboardingSkeleton };

/**
 * The onboarding screen.
 *
 * An async server component behind the page's Suspense boundary. It reads
 * through `OnboardingDataSource` and knows nothing about where the rows came
 * from — `default` is the live derived state, the other four are fixtures.
 *
 * THE SENTENCE THIS SCREEN EXISTS TO MAKE TRUE: an unverified entity can look,
 * but not transact. Both halves of that are shown, because they are enforced in
 * two different places and only one of them is a predicate:
 *
 *   structurally  a business gets its 2100 deposit account, and its two memo
 *                 hold accounts, when KYB approves it and not before. A pending
 *                 or rejected business has nowhere for money to land at all.
 *   by predicate  `canTransact()` reads `v_business_kyb` and refuses, with a
 *                 code, on every state that is not exactly `approved`.
 */
export async function OnboardingView({ view }: { readonly view: View }) {
  const role = await readRole();
  const live = view.state === "default";

  const source: OnboardingDataSource = live
    ? createLiveOnboardingSource()
    : createFixtureSource(view.state);

  const result = await source.getSnapshot();

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header role={role} live={live} asOf={null} />
        <ErrorPanel error={result.error} />
      </div>
    );
  }

  const snapshot = result.value;

  return (
    <div className="space-y-6">
      <Header role={role} live={live} asOf={snapshot.asOf} />

      <Note title="Gate the account: unverified entities can look but not transact">
        <p>
          Two independent mechanisms, and the weaker-looking one is the stronger. A business gets
          its <code className="font-mono">2100</code> deposit account — and the{" "}
          <code className="font-mono">9100</code> / <code className="font-mono">9200</code> memo
          hold accounts beside it — <em>on approval</em>. Until then there is no account for money
          to land in, which is not a check anybody can forget to write.
        </p>
        <p className="mt-2">
          On top of that, <code className="font-mono">canTransact()</code> reads the derived state
          and refuses with a code: <code className="font-mono">KYB_NOT_STARTED</code>,{" "}
          <code className="font-mono">KYB_PENDING</code>,{" "}
          <code className="font-mono">KYB_NEEDS_REVIEW</code>,{" "}
          <code className="font-mono">KYB_REJECTED</code>,{" "}
          <code className="font-mono">KYB_EVIDENCE_SIMULATED</code> or{" "}
          <code className="font-mono">KYB_STATE_UNREADABLE</code>. There is no boolean anywhere in
          its return type, and no path to <em>allowed</em> that a status it cannot parse could take.
        </p>
      </Note>

      <WiringPanel wiring={snapshot.wiring} />

      {snapshot.businesses.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-5 py-8 text-sm text-muted">
          No businesses on the book. Nothing to verify, and nothing that could transact.
        </p>
      ) : (
        <div className="space-y-4">
          {snapshot.businesses.map((business) => (
            <EntityCard key={business.businessId} business={business} live={live} />
          ))}
        </div>
      )}

      <p className="max-w-prose text-xs leading-relaxed text-muted">
        {role === "approver"
          ? "Acting as Approver. Starting a verification is not an approval and this screen holds no approval controls: the decision comes back from a provider, over their signature, and lands as a new row in an append-only table. Nobody here can type a business into `approved`."
          : "Acting as Staff. You can start a verification, re-read one, and ask the gate whether a business may move money. What you cannot do — what nobody here can do — is set a status: there is no kyb_status column to set, and the table that holds the evidence carries no UPDATE grant."}
      </p>
    </div>
  );
}

function Header({
  role,
  live,
  asOf,
}: {
  readonly role: "staff" | "approver";
  readonly live: boolean;
  readonly asOf: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Onboarding &amp; KYB</h1>
        <Badge tone={live ? "positive" : "quiet"}>{live ? "LIVE" : "FIXTURE"}</Badge>
      </div>
      <p className="mt-0.5 max-w-prose text-sm text-muted">
        Two legs, one composite, and an evidence label that cannot be forged. Status and evidence
        are derived on every read — there is no column holding either.
      </p>
      <div className="mt-3">
        <MetaList
          items={[
            { label: "Acting as", value: ROLE_LABEL[role] },
            ...(asOf === null ? [] : [{ label: "As of", value: formatTimestamp(asOf) }]),
          ]}
        />
      </div>
    </header>
  );
}
