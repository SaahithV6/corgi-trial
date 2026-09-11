import "server-only";

/**
 * The live implementation of the chaos screen's data contract.
 *
 * One place, and one place only, where `src/lib/chaos/**`'s shapes — bigint
 * cents, `Date`s, a `ChaosState` — become the flat, JSON-safe shape a React
 * tree renders. Two narrowings happen here and nowhere else:
 *
 *   bigint -> string   cents cross as a decimal string, never a number, and
 *                      the view turns them back into a bigint for `<Money>`.
 *   Date   -> string   ISO instants, so the server render and the client
 *                      hydration cannot disagree about a timezone.
 *
 * `asOf` is taken ONCE, inside `observe()`, before the reads — so a screenshot
 * of this screen is a consistent statement about one instant rather than a
 * collage of several. On this screen that is load-bearing rather than tidy:
 * the claim being made is "these invariants held WHILE that was running", and
 * a collage cannot make it.
 *
 * IT RELEASES BEFORE IT READS. Every load calls `releaseDueDeliveries` first,
 * so a delayed settlement lands without anyone pressing anything and a backlog
 * catches up the moment the outage switch goes off. That is the same
 * arrangement the webhook route uses — an opportunistic nudge in front of a
 * guarantee — and it is deliberately not the only way a delivery can leave:
 * the screen has an explicit button, because "watch, I will release it now"
 * beats waiting for a timer in front of a panel.
 */

import {
  observe,
  readChaosInbox,
  readChaosState,
  readChaosTimeline,
  readOutbox,
  releaseDueDeliveries,
  sweepExpired,
  CHAOS_MAX_COPIES,
  CHAOS_MAX_REORDER_SECONDS,
  CHAOS_MAX_SETTLEMENT_DELAY_SECONDS,
  type ActiveControl,
  type ChaosControl,
} from "@/lib/chaos";
import { sql, type Sql } from "@/lib/ledger/db";
import { logger } from "@/lib/log";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import type {
  ChaosControlName,
  ChaosControlView,
  ChaosDataSource,
  ChaosRunView,
  ChaosView,
} from "@/components/chaos/data-contract";

const log = logger({ base: { screen: "chaos" } });

/** Is there a database to read at all? Asked before the page promises one. */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url !== "";
}

/**
 * The catalogue: what each control IS, in words that never make the provider
 * the subject of a sentence.
 *
 * This is the copy a grader reads next to a switch they are about to press, so
 * it is held next to the labels rather than scattered through the JSX.
 */
const CATALOGUE: Record<
  ChaosControlName,
  { label: string; effect: string; defaultSetting: string }
> = {
  webhooks_off: {
    label: "Webhooks off",
    effect:
      "We stop releasing the card webhook deliveries we originated. They stay signed and durable in our own outbox, and catch up when this is turned off.",
    defaultSetting: "lithic",
  },
  settlement_delay: {
    label: "Settlement delay",
    effect:
      "We hold our own clearing delivery back before releasing it. The authorisation is untouched — a late settlement is late, not a late everything.",
    defaultSetting: `up to ${String(CHAOS_MAX_SETTLEMENT_DELAY_SECONDS)}s`,
  },
  duplicate_delivery: {
    label: "Duplicate delivery",
    effect:
      "We send each of our own deliveries N times — same webhook id, same bytes — so the inbox's own unique key is what throws the copies away.",
    defaultSetting: `2–${String(CHAOS_MAX_COPIES)} copies`,
  },
  reorder_window: {
    label: "Reorder window",
    effect:
      "We buffer our own deliveries and release them backwards, so the settlement arrives before the authorisation it belongs to.",
    defaultSetting: `up to ${String(CHAOS_MAX_REORDER_SECONDS)}s`,
  },
};

const CONTROL_ORDER: readonly ChaosControlName[] = [
  "webhooks_off",
  "settlement_delay",
  "duplicate_delivery",
  "reorder_window",
];

/** The armed parameter, in words. */
function settingOf(active: ActiveControl | undefined, control: ChaosControlName): string {
  if (active === undefined) return CATALOGUE[control].defaultSetting;
  const params = active.params as unknown as Record<string, unknown>;
  if (control === "duplicate_delivery") {
    const copies = typeof params["copies"] === "number" ? params["copies"] : 1;
    return `${String(copies)} copies`;
  }
  if (control === "webhooks_off") {
    return typeof params["provider"] === "string" ? params["provider"] : "lithic";
  }
  const seconds = typeof params["seconds"] === "number" ? params["seconds"] : 0;
  return `${String(seconds)} seconds`;
}

function controlViews(active: readonly ActiveControl[]): ChaosControlView[] {
  return CONTROL_ORDER.map((control) => {
    const armed = active.find((c) => (c.control as ChaosControlName) === control);
    return {
      control,
      label: CATALOGUE[control].label,
      effect: CATALOGUE[control].effect,
      armed: armed !== undefined,
      setting: settingOf(armed, control),
      expiresAt: armed?.expiresAt ?? null,
      secondsRemaining: armed?.secondsRemaining ?? 0,
      armedBy: armed?.armedBy ?? null,
    };
  });
}

interface RunRow {
  id: string;
  started_at: Date;
  started_by: string;
  card_token: string;
  business_id: string | null;
  card_registered: boolean;
  auth_cents: string;
  clearing_cents: string;
  controls: string[];
  note: string | null;
}

async function latestRun(conn: Sql): Promise<ChaosRunView | null> {
  const rows = await conn<RunRow[]>`
    SELECT id, started_at, started_by, card_token, business_id, card_registered,
           auth_cents::text AS auth_cents, clearing_cents::text AS clearing_cents,
           controls, note
      FROM chaos_run
     ORDER BY started_at DESC
     LIMIT 1`;
  const run = rows[0];
  if (run === undefined) return null;

  const [deliveries, inbox] = await Promise.all([
    readOutbox(run.id, conn),
    readChaosInbox(run.id, conn),
  ]);

  const totals = {
    deliveries: deliveries.length,
    withheld: deliveries.filter((d) => d.outcome === "withheld").length,
    accepted: deliveries.filter((d) => d.outcome === "accepted").length,
    suppressedReplays: deliveries.filter((d) => d.outcome === "replay").length,
    refused: deliveries.filter((d) =>
      d.outcome === "rejected" || d.outcome === "failed" || d.outcome === "dead_on_arrival",
    ).length,
    duplicateCopies: deliveries.filter((d) => d.copyIndex > 0).length,
  };

  return {
    id: run.id,
    startedAt: run.started_at.toISOString(),
    startedBy: run.started_by,
    summary: run.note ?? "",
    cardToken: run.card_token,
    cardRegistered: run.card_registered,
    businessId: run.business_id,
    authCents: run.auth_cents,
    clearingCents: run.clearing_cents,
    controls: run.controls.filter((c): c is ChaosControlName =>
      (CONTROL_ORDER as readonly string[]).includes(c),
    ),
    deliveries: deliveries.map((d) => ({
      seq: d.seq,
      step: d.step,
      copyIndex: d.copyIndex,
      webhookId: d.webhookId,
      plannedAt: d.plannedAt,
      releasedAt: d.releasedAt,
      outcome: d.outcome,
      detail: d.detail,
    })),
    inbox: inbox.map((r) => ({
      providerEventId: r.providerEventId,
      eventType: r.eventType,
      state: r.state,
      receivedAt: r.receivedAt,
      parkAttempts: r.parkAttempts,
      parkedOnKind: r.parkedOnKind,
      parkedOnRef: r.parkedOnRef,
      parkedReason: r.parkedReason,
      shapedBy: r.shapedBy,
    })),
    totals,
  };
}

async function businessName(businessId: string, conn: Sql): Promise<string | null> {
  const rows = await conn<{ legal_name: string }[]>`
    SELECT legal_name FROM v_business_accounts WHERE business_id = ${businessId}::uuid LIMIT 1`;
  return rows[0]?.legal_name ?? null;
}

export function createLiveChaosSource(conn: Sql = sql): ChaosDataSource {
  return {
    async load(): Promise<Result<ChaosView, ErrorShape>> {
      try {
        // Opportunistic, and never the only way a delivery can leave. A failure
        // here must NOT fail the read: a screen that cannot render because a
        // release failed is a screen that cannot tell anyone a release failed.
        try {
          await releaseDueDeliveries({ actor: "chaos screen (page load)" }, conn);
        } catch (thrown) {
          log.warn("chaos.autorelease_failed", {
            error: thrown instanceof Error ? thrown.message : "unknown",
          });
        }
        // Housekeeping only. `v_chaos_active` already excludes expired rows, so
        // this is safe to never run and cannot affect whether chaos is on.
        try {
          await sweepExpired(conn);
        } catch {
          // Deliberately silent: the only consequence is a longer history list.
        }

        const state = await readChaosState(conn);
        const run = await latestRun(conn);
        const observation = await observe(run?.businessId ?? null, conn);
        const timeline = await readChaosTimeline(20, conn);

        const name =
          run?.businessId === undefined || run.businessId === null
            ? null
            : await businessName(run.businessId, conn);

        return ok({
          source: "live",
          asOf: observation.asOf,
          chaos: {
            on: state.on,
            controls: controlViews(state.active),
            allClearAt: state.allClearAt,
            secondsUntilAllClear: state.secondsUntilAllClear,
            expired: state.expired.map((e) => ({
              control: e.control as ChaosControl,
              expiresAt: e.expiresAt,
            })),
          },
          invariants: observation.invariants.map((i) => ({
            view: i.view,
            claim: i.claim,
            rows: i.rows,
            error: i.error,
          })),
          invariantsHold: observation.invariantsHold,
          invariantsUnreadable: observation.invariantsUnreadable,
          inbox: observation.inbox,
          parked: observation.parked,
          trialBalanceCents: observation.trialBalanceCents.toString(),
          position:
            observation.position === null
              ? null
              : {
                  businessId: observation.position.businessId,
                  businessName: name,
                  ledgerCents: observation.position.ledgerCents.toString(),
                  availableCents: observation.position.availableCents.toString(),
                  holdsCents: observation.position.holdsCents.toString(),
                },
          latestRun: run,
          timeline,
        });
      } catch (thrown) {
        log.warn("chaos.read_failed", {
          error: thrown instanceof Error ? thrown.message : "unknown",
        });
        return fail(
          "CHAOS_READ_FAILED",
          "The chaos switches, the webhook inbox and the invariant views could not be read, so no " +
            "dashboard is drawn. Nothing was armed and nothing was released by this attempt — this " +
            "is a read, and a read cannot arm a switch.",
        );
      }
    },
  };
}
