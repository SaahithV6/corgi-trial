import { Suspense } from "react";

import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import {
  CONTROL_READ_BUDGET_MS,
  DECISION_APPEND_BUDGET_MS,
  HANDLER_BUDGET_MS,
  PROVIDER_RECOMMENDED_MS,
  PROVIDER_TIMEOUT_MS,
} from "@/lib/cards/budget";
import { FIXTURE_CONTROLS } from "@/lib/cards/fixtures";
import { describeMcc } from "@/lib/cards/mcc";
import { readAsaEnrollment, type AsaEnrollment } from "@/lib/cards/provider";
import { readControlCoverage, type ControlCoverage } from "@/lib/cards/defaults";
import { listCardsWithControls, listDecisions, type CardWithControls } from "@/lib/cards/store";
import type { CardControls, DecisionRecord } from "@/lib/cards/types";
import {
  CONTROL_LOADING_MS,
  CONTROL_VIEWS,
  CONTROL_VIEW_HINTS,
  CONTROL_VIEW_LABELS,
  controlQuery,
  isLiveControlView,
  parseControlView,
  type ControlViewState,
} from "@/lib/cards/view-state";
import { ledgerConnection } from "@/lib/ledger/queries";

import { CardControlsForm, ReplayAuthorizationForm } from "./CardControlsForms";
import { listConsoleBusinesses } from "./live-source";

/**
 * Card controls, enforced inside the provider's authorisation timeout.
 *
 * This panel is the operator half of a feature whose interesting half is a
 * webhook nobody can see: `POST /api/webhooks/lithic-auth`, which Lithic calls
 * synchronously while a cardholder waits at a terminal. So the panel's job is
 * not "render some settings" — it is to make three otherwise invisible things
 * legible:
 *
 *   1. WHETHER THE PROVIDER IS ACTUALLY CALLING US. Read live from Lithic's own
 *      `GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS`. A screen that
 *      showed a decision history without saying who drove it would be
 *      indistinguishable, to a reader, from one that had.
 *   2. WHAT THE BUDGET IS. The deadline numbers on this screen are imported
 *      from the module the route runs to, so they cannot drift into being
 *      marketing.
 *   3. WHY EACH DECISION WENT THE WAY IT DID. The rule that fired, the figures
 *      it compared, the control version it was judged under, and how long it
 *      took — in microseconds, because a decision measured in whole
 *      milliseconds rounds to 0 or 1 and tells you nothing.
 *
 * FIVE URL-DRIVEN STATES, on `?controls=` — deliberately a different parameter
 * from the console's `?state=` above it, so the two can be posed independently:
 *
 *   (none)             live
 *   ?controls=loading  the real skeleton, in front of a genuinely slow read
 *   ?controls=empty    a card that has never had a control set
 *   ?controls=error    the panel's own read failed
 *   ?controls=edge     the fail-closed decline — the control store missed its
 *                      600 ms deadline and the authorisation was refused
 *
 * The panel is mounted from `src/app/(app)/accounts/page.tsx` and takes that
 * page's `searchParams` already resolved, so it can be dropped in with one
 * line and no plumbing.
 */
export function CardControlsPanel({
  searchParams,
  businessId = null,
}: {
  readonly searchParams: Record<string, string | string[] | undefined>;
  /** Which customer. `null` = the same default the console above picks. */
  readonly businessId?: string | null;
}) {
  const view = parseControlView(searchParams);

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-base font-semibold tracking-tight">
          Card controls, decided inside the provider&rsquo;s timeout
        </h2>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          Lithic holds the authorisation open and waits for us. These limits are
          not enforced by a nightly job or by a report — they are enforced in the
          6000&nbsp;ms Lithic gives us to answer, by{" "}
          <code className="font-mono text-xs">POST /api/webhooks/lithic-auth</code>,
          which reads controls and recent spend and returns a verdict. It posts
          no money. Money still moves later, on the ordinary asynchronous card
          webhook.
        </p>
      </header>

      <ControlStateBar searchParams={searchParams} view={view} />

      <BudgetPanel />

      <Suspense fallback={<EnrollmentSkeleton />}>
        <EnrollmentPanel />
      </Suspense>

      <Suspense key={`controls:${view}:${businessId ?? "default"}`} fallback={<ControlsSkeleton />}>
        <ControlsSection view={view} businessId={businessId} />
      </Suspense>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The state bar                                                              */
/* -------------------------------------------------------------------------- */

function ControlStateBar({
  searchParams,
  view,
}: {
  readonly searchParams: Record<string, string | string[] | undefined>;
  readonly view: ControlViewState;
}) {
  return (
    <div className="rounded border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Panel state
        </span>
        {CONTROL_VIEWS.map((state) => {
          const active = state === view;
          return (
            <Link
              key={state}
              href={`/accounts${controlQuery(searchParams, state)}#card-controls`}
              aria-current={active ? "page" : undefined}
              className={`rounded border px-2 py-1 text-[11px] ${FOCUS_RING} ${
                active
                  ? "border-border-strong bg-surface-raised font-medium"
                  : "border-border text-muted hover:bg-surface-raised"
              }`}
            >
              {CONTROL_VIEW_LABELS[state]}
            </Link>
          );
        })}
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {CONTROL_VIEW_HINTS[view]}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The budget                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every number here is imported from `@/lib/cards/budget`, which is the module
 * the route actually runs to. There is no second copy of the budget and there
 * is nothing on this screen a code change cannot move.
 */
function BudgetPanel() {
  return (
    <Panel
      title="The latency budget"
      description="Being slow is not a degraded mode. At 6000 ms Lithic gives up, declines on our behalf, and stamps the transaction CUSTOMER_ASA_TIMEOUT."
      actions={<Badge tone="neutral">measured against the provider</Badge>}
    >
      <div className="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-2">
        <BudgetRow
          label="Provider hard timeout"
          value={`${PROVIDER_TIMEOUT_MS} ms`}
          note="Lithic declines. It does not approve."
        />
        <BudgetRow
          label="Provider recommendation"
          value={`${PROVIDER_RECOMMENDED_MS} ms`}
          note="Acquirer-side timeouts downstream can void a transaction Lithic would still have waited for."
        />
        <BudgetRow
          label="Control read deadline"
          value={`${CONTROL_READ_BUDGET_MS} ms`}
          note="One round trip, one statement. Missing it means the store is gone, not busy."
        />
        <BudgetRow
          label="Decision append deadline"
          value={`${DECISION_APPEND_BUDGET_MS} ms`}
          note="Written before the response: best-effort audit is not audit."
        />
        <BudgetRow
          label="Our ceiling"
          value={`${HANDLER_BUDGET_MS} ms`}
          note="Asserted in budget.test.ts to be under the provider's recommendation."
        />
        <BudgetRow
          label="On store unavailable"
          value="decline"
          note="Fail closed. A wrong decline is recoverable and recorded; a wrong approval on a frozen card is not."
        />
      </div>
    </Panel>
  );
}

function BudgetRow({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted">{label}</span>
        <span className="money text-sm font-medium">{value}</span>
      </div>
      <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Enrollment — is the provider actually calling us?                          */
/* -------------------------------------------------------------------------- */

function EnrollmentSkeleton() {
  return (
    <div className="rounded border border-border bg-surface px-5 py-4">
      <div className="h-3 w-56 animate-pulse rounded bg-border" />
      <div className="mt-2 h-3 w-80 animate-pulse rounded bg-border" />
    </div>
  );
}

async function EnrollmentPanel() {
  const enrollment = await readAsaEnrollment();
  return <EnrollmentView enrollment={enrollment} />;
}

function EnrollmentView({ enrollment }: { readonly enrollment: AsaEnrollment }) {
  const tone =
    enrollment.status === "enrolled"
      ? "positive"
      : enrollment.status === "not_enrolled"
        ? "quiet"
        : "negative";

  return (
    <Panel
      title="Is Lithic calling us?"
      description="Read live from the provider, not from our own configuration. GET /v1/responder_endpoints?type=AUTH_STREAM_ACCESS."
      actions={<Badge tone={tone}>{enrollment.status.replace("_", " ")}</Badge>}
    >
      <div className="px-5 py-4">
        {enrollment.status === "enrolled" ? (
          <>
            <p className="max-w-prose text-sm">
              Lithic is enrolled to call this system synchronously for every
              authorisation on the program. Decision rows below marked{" "}
              <Badge tone="positive">provider</Badge> were driven by that call.
            </p>
            {enrollment.url === null ? null : (
              <p className="mt-2 font-mono text-xs text-muted">{enrollment.url}</p>
            )}
          </>
        ) : enrollment.status === "not_enrolled" ? (
          <p className="max-w-prose text-sm">
            No ASA responder is enrolled on this program right now, so Lithic is
            not calling us and no decision below can have come from a real
            authorisation. Every row is therefore{" "}
            <Badge tone="quiet">harness</Badge> — the same decision function,
            driven locally with a payload built from Lithic&rsquo;s published
            schema. That distinction is a column in the table, not a caption.
          </p>
        ) : (
          <>
            <p className="max-w-prose text-sm text-negative">
              The enrollment probe did not answer, so this screen does not know
              whether Lithic is calling us.
            </p>
            <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
              Not knowing is stated rather than guessed. {enrollment.detail}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The live section                                                           */
/* -------------------------------------------------------------------------- */

function ControlsSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="rounded border border-border bg-surface px-5 py-4">
          <div className="h-3 w-44 animate-pulse rounded bg-border" />
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="h-8 animate-pulse rounded bg-border" />
            <div className="h-8 animate-pulse rounded bg-border" />
            <div className="h-8 animate-pulse rounded bg-border" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The live read, and nothing else.
 *
 * Returns a VALUE, never JSX. React does not render a component at the moment
 * its element is constructed, so JSX built inside a `try` is JSX whose render
 * errors the `catch` will never see — the eslint rule that says so is right,
 * and the fix is the one this codebase already uses everywhere else: fail into
 * a `Result` and let the caller decide what to draw.
 */
type ControlsData =
  | {
      readonly kind: "ok";
      readonly cards: readonly CardWithControls[];
      readonly decisions: readonly DecisionRecord[];
      readonly coverage: ControlCoverage;
    }
  | { readonly kind: "no_customer" }
  | { readonly kind: "no_cards"; readonly coverage: ControlCoverage }
  | { readonly kind: "failed"; readonly detail: string };

async function loadControls(businessId: string | null): Promise<ControlsData> {
  try {
    const conn = await ledgerConnection();
    const businesses = await listConsoleBusinesses(conn);
    const target = businessId ?? businesses[0]?.businessId ?? null;
    if (target === null) return { kind: "no_customer" };

    const [cards, decisions, coverage] = await Promise.all([
      listCardsWithControls(target),
      listDecisions({ businessId: target, limit: 25 }),
      readControlCoverage(target),
    ]);
    if (cards.length === 0) return { kind: "no_cards", coverage };
    return { kind: "ok", cards, decisions, coverage };
  } catch (thrown) {
    return { kind: "failed", detail: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

/* -------------------------------------------------------------------------- */
/* Coverage — how much of the estate the decision path can actually judge      */
/* -------------------------------------------------------------------------- */

/**
 * `no_controls_configured` is a REAL STATE, and until this panel existed the
 * only way to see it was to read an approval and infer it.
 *
 * That was the actual defect behind this feature's worst number. On
 * 2026-09-11 the provider lane held 51 approvals, 38 of them produced by
 * `no_controls_configured` — a rule that compared the authorisation with
 * nothing, because 880 of 911 cards carried no control version. Nothing on any
 * screen said so. The panel above renders the newest six cards of one business
 * beautifully and says nothing at all about the other two hundred, and an
 * operator reading a page of approvals has no way to tell "we judged this and
 * allowed it" from "nobody had ever said anything about this card".
 *
 * The three numbers are the three branches `decide()` takes, not a
 * configured/not pair — see `v_card_control_coverage` (migration 0051) and the
 * note on `readControlCoverage()`. The uncontrolled figure is deliberately the
 * loud one: it is the only one that means an authorisation will be approved
 * without being judged.
 */
function CoveragePanel({
  coverage,
  live,
}: {
  readonly coverage: ControlCoverage;
  readonly live: boolean;
}) {
  const { total, underControl, memberOnly, uncontrolled } = coverage;
  const judged = underControl + memberOnly;
  const pct = total === 0 ? 0 : Math.round((judged / total) * 100);

  return (
    <Panel
      title="How much of this customer's estate is under control"
      description={
        total === 0
          ? "This customer holds no cards."
          : `${judged} of ${total} cards (${pct}%) would have their next authorisation judged against something. The rest are approved by rule no_controls_configured, which compares the authorisation with nothing.`
      }
      actions={
        uncontrolled === 0 ? (
          <Badge tone="positive">every card judged</Badge>
        ) : (
          <Badge tone={live ? "negative" : "quiet"}>{uncontrolled} unjudged</Badge>
        )
      }
    >
      <div className="grid gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-3">
        <CoverageCount
          label="Under a card control"
          value={underControl}
          note="A control version exists. Judged by the card's own limits, its category blocks and its on/off switch, and the decision row pins the version it was judged under."
        />
        <CoverageCount
          label="Covered by their holder"
          value={memberOnly}
          note="No control version, but the card belongs to a team member — so removal, suspension and that person's own limits still judge it. Not the same as no controls."
        />
        <CoverageCount
          label="Judged against nothing"
          value={uncontrolled}
          note="No control version and no holder. Every purchase is approved by no_controls_configured. Not a control that failed — a card nobody has ever configured."
          loud={uncontrolled > 0 && live}
        />
      </div>
      <p className="max-w-prose px-5 pb-4 text-[11px] leading-relaxed text-muted">
        A card issued from the console above is born under the program default —
        control version 1, a $5,000.00 per-transaction ceiling equal to the
        <code className="mx-1 font-mono">spend_limit</code> this system already
        declares to Lithic on that same card, so it declines nothing the issuer
        would not already have declined. What it buys is that the decision is{" "}
        <em>judged</em>: the row cites a control version instead of citing
        nothing. The cards counted as unjudged reached this book another way —
        a test fixture bound straight through{" "}
        <code className="font-mono">registerCard()</code>, or a card issued
        before the default existed.
      </p>
    </Panel>
  );
}

function CoverageCount({
  label,
  value,
  note,
  loud = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly note: string;
  readonly loud?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-2xl ${loud ? "text-negative" : ""}`}>{value}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}

async function ControlsSection({
  view,
  businessId,
}: {
  readonly view: ControlViewState;
  readonly businessId: string | null;
}) {
  // The loading state is not a mock of a slow read; it IS a slow read, and the
  // Suspense boundary above shows the real skeleton for as long as it takes.
  if (view === "loading") {
    await new Promise((resolve) => setTimeout(resolve, CONTROL_LOADING_MS));
  }

  if (!isLiveControlView(view)) return <FixtureSection view={view} />;

  const data = await loadControls(businessId);

  if (data.kind === "failed") return <ControlsErrorPanel detail={data.detail} />;

  if (data.kind === "no_customer") {
    return (
      <Panel title="No customer to control" description="A card needs both leaves of the chart.">
        <p className="px-5 py-8 max-w-prose text-sm text-muted">
          No business on this book has both a 2100 deposit account and a 9100
          memo account, so no card can be issued and there is nothing to put
          controls on.
        </p>
      </Panel>
    );
  }

  if (data.kind === "no_cards") {
    return (
      <div className="space-y-4">
        <CoveragePanel coverage={data.coverage} live />
        <Panel title="No cards" description="Issue one from the console above and it will appear here.">
          <p className="px-5 py-8 max-w-prose text-sm text-muted">
            This customer has no registered cards, so there is nothing to
            control. Controls attach to a card, not to a business: two people on
            the same account get different limits, which is the entire point.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CoveragePanel coverage={data.coverage} live />
      {data.cards.map((card) => (
        <CardPanel key={card.cardId} card={card} live />
      ))}
      <DecisionHistory decisions={data.decisions} live />
    </div>
  );
}

function ControlsErrorPanel({ detail }: { readonly detail: string }) {
  return (
    <Panel
      title="The control panel could not be read"
      description="A read failure. Nothing moved."
      actions={<Badge tone="negative">error</Badge>}
    >
      <div className="px-5 py-6">
        <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Detail</dt>
          <dd className="max-w-prose font-mono text-xs">{detail.slice(0, 220)}</dd>
        </dl>
        <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
          This is the SCREEN&rsquo;s read, not the decision path&rsquo;s. If the
          same store were unreachable from{" "}
          <code className="font-mono">/api/webhooks/lithic-auth</code>, that path
          would DECLINE rather than show you this — it fails closed, and the
          decline is recorded with rule{" "}
          <code className="font-mono">control_store_unavailable</code> so the
          cardholder can be found and told.
        </p>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* One card                                                                   */
/* -------------------------------------------------------------------------- */

/** Cents to the dollars string a form field wants. Never a float. */
function dollarsField(cents: bigint | null): string {
  if (cents === null) return "";
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

function CardPanel({
  card,
  live,
}: {
  readonly card: CardWithControls;
  readonly live: boolean;
}) {
  const c = card.controls;
  const label = card.nickname ?? `card ••${card.lastFour ?? "????"}`;

  return (
    <Panel
      title={`${label}${card.lastFour === null ? "" : ` ••${card.lastFour}`}`}
      description={
        c === null
          ? "No controls have ever been set on this card. Every authorisation is approved by rule no_controls_configured — which is not a control that failed, it is a card with no controls."
          : `Control version ${c.version}, in force since ${formatTimestamp(c.effectiveFrom)}. ${c.note}`
      }
      actions={
        c === null ? (
          <Badge tone="quiet">no controls</Badge>
        ) : c.cardState === "frozen" ? (
          <Badge tone="negative">frozen</Badge>
        ) : (
          <Badge tone="positive">active · v{c.version}</Badge>
        )
      }
    >
      <div className="space-y-4 px-5 py-4">
        <CurrentControls controls={c} spend={card.spend} />

        <CardControlsForm
          cardId={card.cardId}
          cardLabel={label}
          perTxn={dollarsField(c?.perTxnLimitCents ?? null)}
          daily={dollarsField(c?.dailyLimitCents ?? null)}
          monthly={dollarsField(c?.monthlyLimitCents ?? null)}
          blockedMccs={c?.blockedMccs ?? []}
          frozen={c?.cardState === "frozen"}
          live={live}
        />

        <details className="rounded border border-border bg-surface px-3 py-2">
          <summary className={`cursor-pointer text-xs font-medium ${FOCUS_RING}`}>
            Replay an authorisation through the decision function
          </summary>
          <div className="mt-3">
            <p className="mb-3 max-w-prose text-[11px] leading-relaxed text-muted">
              This drives the SAME decision function the provider drives, with a
              payload built field-by-field from Lithic&rsquo;s published OpenAPI
              schema. What is real: the parser, the rules, the control read, the
              append and the database. What is synthesised: the HTTP delivery and
              the payload. Every row it writes is labelled{" "}
              <span className="font-mono">harness</span>, and the velocity sum
              keeps the two lanes apart in SQL so a replay can never eat this
              card&rsquo;s real daily limit.
            </p>
            <ReplayAuthorizationForm
              cardId={card.cardId}
              cardToken={card.providerCardToken}
              live={live}
            />
          </div>
        </details>
      </div>
    </Panel>
  );
}

function CurrentControls({
  controls,
  spend,
}: {
  readonly controls: CardControls | null;
  readonly spend: { readonly dayCents: bigint; readonly monthCents: bigint };
}) {
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <LimitRow
        label="Per transaction"
        limit={controls?.perTxnLimitCents ?? null}
        used={null}
      />
      <LimitRow
        label="Daily"
        limit={controls?.dailyLimitCents ?? null}
        used={spend.dayCents}
      />
      <LimitRow
        label="Monthly"
        limit={controls?.monthlyLimitCents ?? null}
        used={spend.monthCents}
      />
      <div>
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
          Blocked categories
        </span>
        <p className="mt-0.5 text-sm">
          {controls === null || controls.blockedMccs.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <span className="font-mono text-xs">
              {controls.blockedMccs.map((m) => describeMcc(m)).join(" · ")}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function LimitRow({
  label,
  limit,
  used,
}: {
  readonly label: string;
  readonly limit: bigint | null;
  readonly used: bigint | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted">{label}</span>
      <span className="text-sm">
        {limit === null ? (
          <span className="text-muted">no limit</span>
        ) : (
          <Money cents={limit} tone="neutral" />
        )}
        {used === null ? null : (
          <span className="ml-2 text-[11px] text-muted">
            used <Money cents={used} tone="neutral" />
          </span>
        )}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The decision history                                                       */
/* -------------------------------------------------------------------------- */

function DecisionHistory({
  decisions,
  live,
}: {
  readonly decisions: readonly DecisionRecord[];
  readonly live: boolean;
}) {
  return (
    <Panel
      title="Every decision, with the rule that fired and how long it took"
      description="Append-only. A decline a customer disputes in March has to be explainable in September, so each row keeps the rule, the figures it compared, the control version it was judged under, and the latency in microseconds."
      actions={<Badge tone={live ? "positive" : "quiet"}>{live ? "live" : "fixture"}</Badge>}
    >
      {decisions.length === 0 ? (
        <p className="px-5 py-8 max-w-prose text-sm text-muted">
          No authorisation decisions on this customer&rsquo;s cards yet. Either
          Lithic has not called us, or nobody has replayed one through the
          harness. Both are stated rather than filled in with a placeholder.
        </p>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Card authorisation decisions, newest first, with the rule that
              fired and the decision latency
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>When</th>
                <th scope="col" className={TH_CLASS}>Card</th>
                <th scope="col" className={`${TH_CLASS} text-right`}>Amount</th>
                <th scope="col" className={TH_CLASS}>MCC</th>
                <th scope="col" className={TH_CLASS}>Outcome</th>
                <th scope="col" className={TH_CLASS}>Rule</th>
                <th scope="col" className={`${TH_CLASS} text-right`}>Latency</th>
                <th scope="col" className={TH_CLASS}>Driven by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {decisions.map((d) => (
                <tr key={d.id}>
                  <td className={`${TD_CLASS} whitespace-nowrap text-xs text-muted`}>
                    {formatTimestamp(d.decidedAt)}
                  </td>
                  <td className={`${TD_CLASS} text-xs`}>
                    ••{d.lastFour ?? "????"}
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {d.controlVersion === null ? "no version" : `v${d.controlVersion}`}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={d.amountCents} tone="neutral" />
                  </td>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{d.mcc ?? "—"}</td>
                  <td className={TD_CLASS}>
                    <Badge tone={d.outcome === "approve" ? "positive" : "negative"}>
                      {d.outcome}
                    </Badge>
                    <span className="mt-0.5 block font-mono text-[11px] text-muted">
                      {d.resultCode}
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    <span className="font-mono text-[11px]">{d.rule}</span>
                    <span className="mt-0.5 block max-w-[28rem] text-[11px] leading-relaxed text-muted">
                      {d.reason}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} money text-right text-xs whitespace-nowrap`}>
                    {d.decisionLatencyUs} µs
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {(d.decisionLatencyUs / 1000).toFixed(1)} ms
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    <Badge tone={d.source === "provider" ? "positive" : "quiet"}>{d.source}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Fixture states                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `empty`, `error` and `edge` write nothing and read nothing.
 *
 * That is deliberate and it is the same rule the console above follows. A
 * fail-closed decline is not a condition you produce on a live database to
 * show someone: you would have to make the database unreachable, and the point
 * of the state is what the screen says when it is, not whether we can break
 * Neon on request.
 */
function FixtureSection({ view }: { readonly view: ControlViewState }) {
  if (view === "error") {
    return (
      <ControlsErrorPanel detail='DeadlineExceededError: control read exceeded its 600 ms budget' />
    );
  }

  const card: CardWithControls = {
    cardId: "00000000-0000-4000-8000-00000000c0de",
    providerCardToken: "fixture-card-token",
    lastFour: "2081",
    nickname: view === "empty" ? "Contractor card, just issued" : "Contractor card",
    createdAt: "2026-09-10T18:00:00.000Z",
    controls: view === "empty" ? null : FIXTURE_CONTROLS,
    spend: view === "empty" ? { dayCents: 0n, monthCents: 0n } : { dayCents: 400n, monthCents: 12_400n },
  };

  const decisions: readonly DecisionRecord[] =
    view === "empty" ? [] : [FAIL_CLOSED_DECISION, DECLINED_FUEL_DECISION, APPROVED_DECISION];

  // The fixture states carry a fixture coverage figure for the same reason the
  // rest of this section does: a state that silently dropped a panel the live
  // view has would make the five states incomparable, which is the one job
  // they exist for. It reads nothing and writes nothing.
  const coverage: ControlCoverage =
    view === "empty"
      ? { total: 1, underControl: 0, memberOnly: 0, uncontrolled: 1 }
      : { total: 4, underControl: 1, memberOnly: 2, uncontrolled: 1 };

  return (
    <div className="space-y-4">
      <CoveragePanel coverage={coverage} live={false} />
      <CardPanel card={card} live={false} />
      <DecisionHistory decisions={decisions} live={false} />
    </div>
  );
}

/**
 * The edge state's headline row: a decision taken while the control store was
 * unreachable. Declined, recorded, and explainable — which is the entire
 * argument for failing closed.
 */
const FAIL_CLOSED_DECISION: DecisionRecord = {
  id: "fixture-fail-closed",
  decidedAt: "2026-09-10T19:04:11.000Z",
  provider: "lithic",
  providerAuthToken: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  providerCardToken: "fixture-card-token",
  cardId: "00000000-0000-4000-8000-00000000c0de",
  lastFour: "2081",
  nickname: "Contractor card",
  controlVersion: null,
  amountCents: 5_000n,
  mcc: "5542",
  merchantDescriptor: "CORGI FUEL PUMP 14",
  requestStatus: "AUTHORIZATION",
  outcome: "decline",
  resultCode: "VELOCITY_EXCEEDED",
  rule: "control_store_unavailable",
  reason:
    "The card control store did not answer inside its deadline, so the controls on this card could not be honoured. This system declines rather than guesses.",
  inputs: {
    detail: "DeadlineExceededError: control read exceeded its 600 ms budget",
    fail_mode: "closed",
    amount_cents: "5000",
  },
  decisionLatencyUs: 601_412,
  source: "harness",
};

const DECLINED_FUEL_DECISION: DecisionRecord = {
  id: "fixture-declined-fuel",
  decidedAt: "2026-09-10T18:41:02.000Z",
  provider: "lithic",
  providerAuthToken: "6b1f2c78-1a3d-4a5e-9c88-2c963f66afa6",
  providerCardToken: "fixture-card-token",
  cardId: "00000000-0000-4000-8000-00000000c0de",
  lastFour: "2081",
  nickname: "Contractor card",
  controlVersion: 3,
  amountCents: 5_000n,
  mcc: "5542",
  merchantDescriptor: "CORGI FUEL PUMP 14",
  requestStatus: "AUTHORIZATION",
  outcome: "decline",
  resultCode: "UNAUTHORIZED_MERCHANT",
  rule: "mcc_blocked",
  reason: "Merchant category 5542 is blocked on this card (control version 3).",
  inputs: { blocked_mccs: "5542,7995", matched_mcc: "5542", amount_cents: "5000" },
  decisionLatencyUs: 7_431,
  source: "harness",
};

const APPROVED_DECISION: DecisionRecord = {
  id: "fixture-approved",
  decidedAt: "2026-09-10T18:12:44.000Z",
  provider: "lithic",
  providerAuthToken: "b2d7c1f0-77ba-4d18-9f0e-2c963f66afa6",
  providerCardToken: "fixture-card-token",
  cardId: "00000000-0000-4000-8000-00000000c0de",
  lastFour: "2081",
  nickname: "Contractor card",
  controlVersion: 3,
  amountCents: 400n,
  mcc: "5812",
  merchantDescriptor: "BLUE BOTTLE COFFEE",
  requestStatus: "AUTHORIZATION",
  outcome: "approve",
  resultCode: "APPROVED",
  rule: "within_controls",
  reason: "Within every control on this card (control version 3).",
  inputs: {
    daily_limit_cents: "5000",
    daily_spend_cents: "0",
    per_txn_limit_cents: "1000",
    amount_cents: "400",
  },
  decisionLatencyUs: 6_902,
  source: "harness",
};
