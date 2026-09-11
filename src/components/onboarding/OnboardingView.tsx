import { ROLE_LABEL, readRole, type Role } from "@/components/app-shell/role";
import { Badge, MetaList, Note } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { EntityCard } from "./EntityCard";
import { ErrorPanel } from "./ErrorPanel";
import { OnboardingSkeleton } from "./OnboardingSkeleton";
import { RegistryProbe } from "./RegistryProbe";
import { WiringPanel } from "./WiringPanel";
import type { OnboardingDataSource } from "./data-contract";
import { createFixtureSource } from "./fixtures";
import { ONBOARDING_STATE_UNREADABLE, createUnreadableOnboardingSource } from "./unreadable";
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
export async function OnboardingView({
  view,
  noDatabase = false,
}: {
  readonly view: View;
  readonly noDatabase?: boolean;
}) {
  const role = await readRole();
  const live = view.state === "default";

  const source = await selectSource(view, live, noDatabase);

  const result = await source.getSnapshot();

  if (isErr(result)) {
    // No source badge on a refusal. `LIVE` over a screen that read no evidence
    // row would be claiming the provenance of verdicts it does not have.
    return (
      <div className="space-y-6">
        <Header role={role} live={null} asOf={null} />
        <ErrorPanel error={result.error} />
      </div>
    );
  }

  const snapshot = result.value;

  return (
    <div className="space-y-6">
      <Header role={role} live={live} asOf={snapshot.asOf} />

      <Note title="Every seeded business misses the registry, and that is the correct answer">
        <p>
          Every business on this book is fictional, so GLEIF — a real registry, queried live
          — answers <span className="font-mono">not_in_lei_registry</span> for all three, and the
          registry leg reads <span className="font-mono">needs_review</span>. That is not a broken
          check. GLEIF holds 3,426,836 records, 360,275 of them US, against tens of millions of US
          entities; its population is financial-market participants, so a real, active, ordinary
          corporation can be absent. <strong>A hit is strong evidence; a miss is evidence of
          nothing</strong>, and a miss that quietly approved would be strictly worse than the
          labelled simulator it replaced.
        </p>
        <p className="mt-2">
          <em>Ask the registry</em> below runs the same live adapter against anything you type, so
          an approval with a Secretary of State citation, a decline on a withdrawn company and a 404
          on an invented identifier are all reproducible without a single false claim about a demo
          row. It writes nothing.
        </p>
      </Note>

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

      {live ? <RegistryProbe registry={snapshot.wiring.registry} /> : null}

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
  // `Role`, not the two operator roles spelled out. A customer never reaches
  // this screen — src/middleware.ts answers 403 OPERATOR_ONLY before it renders
  // — so narrowing here would be a second, weaker copy of that decision living
  // in a prop type, and the two would drift.
  readonly role: Role;
  // `null` means "this render read nothing, so it badges nothing". LIVE and
  // FIXTURE are both claims about where a verdict came from, and a refusal has
  // no verdict and no claim.
  readonly live: boolean | null;
  readonly asOf: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Onboarding &amp; KYB</h1>
        {live === null ? null : (
          <Badge tone={live ? "positive" : "quiet"}>{live ? "LIVE" : "FIXTURE"}</Badge>
        )}
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

/**
 * Which source answers this view.
 *
 * Live for `default`, fixture for the other four — and a REFUSAL for `default`
 * when there is no database to read.
 *
 * THE LIVE MODULE IS IMPORTED DYNAMICALLY, AND THAT IS THE REPAIR. It used to
 * be a static `import { createLiveOnboardingSource } from "@/lib/kyb/wire"` at
 * the top of this file. That module's graph reaches `@/lib/ledger/db` ->
 * `@/lib/env`, which throws `EnvironmentError` at module scope without
 * `APP_DATABASE_URL` — deliberately, so a malformed database URL kills the
 * process at boot rather than at the first request that needs money. A static
 * import therefore took the whole page module down with it, including the four
 * fixture states that need no database at all. Measured with the variable
 * deleted, `/onboarding` rendered the framework's error page.
 *
 * Deferring it means the screen can render the words "no database configured".
 * `noDatabase` is resolved in `page.tsx` by `@/lib/has-database`, which imports
 * nothing, so the question cannot be the thing that crashes for the condition
 * it asks about.
 *
 * The four drawn states are checked FIRST and stay drawn either way: they are
 * demonstrations, and "no database" does not make a drawing any more or less
 * drawn.
 */
async function selectSource(
  view: View,
  live: boolean,
  noDatabase: boolean,
): Promise<OnboardingDataSource> {
  if (!live) return createFixtureSource(view.state);

  if (noDatabase) return createUnreadableOnboardingSource(ONBOARDING_STATE_UNREADABLE);

  const { createLiveOnboardingSource } = await import("@/lib/kyb/wire");
  return createLiveOnboardingSource();
}
