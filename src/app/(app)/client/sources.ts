import "server-only";

/**
 * Which of the five states reads the database, and which is constructed.
 *
 * One module for all five screens, because the rule is the same on all five and
 * writing it five times is how four of them would end up subtly different:
 *
 *   default   LIVE. A real read of the real book, for one business.
 *   edge      LIVE. A real read, of the subject or the subset that is the point.
 *   loading   LIVE, held open. `?state=loading` slows the READ; the skeleton is
 *             the component's own, behind a real Suspense boundary. It is not a
 *             mock of a slow render.
 *   empty     FIXTURE. A customer nobody has paid.
 *   error     FIXTURE. The read failed.
 *
 * `empty` and `error` are fixtures because arranging them live means finding a
 * customer with no money or taking the database down, and neither is a thing to
 * do in the middle of a demo. Every fixture state prints FIXTURE on its face
 * and reports `live: false` in its own header.
 *
 * The live modules are imported DYNAMICALLY, because importing them evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * right for the app and wrong for a page whose job includes rendering the words
 * "no database configured".
 */

import type {
  ActivityScreen,
  ApproveScreen,
  BalanceScreen,
  BusinessRef,
  CardsScreen,
  Loaded,
  PayScreen,
} from "@/components/client/contract";
import {
  emptyActivity,
  emptyApprove,
  emptyBalance,
  emptyCards,
  emptyPay,
  errorState,
  holdOpen,
} from "@/components/client/fixtures";
import type { ClientState, ClientView } from "@/components/client/view-state";

/**
 * The business whose available balance is negative while its ledger balance is
 * positive, which is the edge case this surface is graded on.
 *
 * A FIXED ID RATHER THAN A SEARCH, and the reason is the whole point of this
 * surface: finding "the business with a negative available balance" means
 * asking that question of every business on the book, which is exactly the
 * cross-tenant read nothing here is allowed to do. Even for a demo control.
 *
 * The id is not a magic number. `scripts/seed.mjs` derives it as
 * `uuid5('business:kettle-and-crumb')` from a fixed namespace, so it is the
 * same id on a book seeded ten minutes ago and on this one — the same trick
 * `docs/DEMO.md` uses to deep-link Ridgeline's account. If the business is not
 * on the book the readers fall back to the default customer and the screen says
 * whether the condition holds, rather than pretending.
 *
 * Measured on this database 2026-09-11: ledger $45,301.36, card holds $520.00,
 * uncleared credits $55,500.00, committed out $0.00, available −$10,718.64.
 */
export const UNCLEARED_CREDIT_BUSINESS = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";

/** True when this deployment has a database to read at all. */
async function databaseAvailable(): Promise<boolean> {
  const { hasDatabase } = await import("./live-source");
  return hasDatabase();
}

/**
 * The business a live read should use for a given state.
 *
 * An explicit `?business=` always wins, including on `edge` — a reader who has
 * chosen a customer and then clicked a demo state has not asked to be moved to
 * a different company.
 */
function subjectFor(view: ClientView): string | null {
  if (view.businessId !== null) return view.businessId;
  if (view.state === "edge") return UNCLEARED_CREDIT_BUSINESS;
  return null;
}

/** Fixture states need the real business list so the switcher still works. */
async function businessRefs(): Promise<readonly BusinessRef[]> {
  if (!(await databaseAvailable())) return [];
  try {
    const { listBusinesses, ledgerConnection } = await import("@/lib/ledger/queries");
    const conn = await ledgerConnection();
    const rows = await listBusinesses(conn);
    return rows.map((b) => ({
      id: b.businessId,
      legalName: b.legalName,
      hasAccount: b.depositAccountId !== null,
    }));
  } catch {
    // The switcher is a convenience; a screen that cannot list names still has
    // a balance to show. Never let this take a page down.
    return [];
  }
}

/**
 * Run a live read, or fall back to the fixture when there is no database.
 *
 * The fallback is `empty`, never `error`: "this deployment has no database
 * configured" is not the same claim as "your account could not be read", and a
 * customer-facing error card is the wrong thing to show a developer running
 * without a `.env`.
 */
async function live<T>(
  state: ClientState,
  read: () => Promise<Loaded<T>>,
  fallback: (businesses: readonly BusinessRef[]) => T,
): Promise<Loaded<T>> {
  if (!(await databaseAvailable())) {
    return { ok: true, value: fallback([]) };
  }
  const result = await read();
  return state === "loading" ? holdOpen(result) : result;
}

/* -------------------------------------------------------------------------- */

export async function loadBalance(view: ClientView): Promise<Loaded<BalanceScreen>> {
  if (view.state === "error") return errorState<BalanceScreen>();
  if (view.state === "empty") {
    return { ok: true, value: emptyBalance(await businessRefs()) };
  }
  const { readBalanceScreen } = await import("./live-source");
  return live(view.state, () => readBalanceScreen(subjectFor(view)), emptyBalance);
}

export async function loadActivity(view: ClientView): Promise<Loaded<ActivityScreen>> {
  if (view.state === "error") return errorState<ActivityScreen>();
  if (view.state === "empty") {
    return { ok: true, value: emptyActivity(await businessRefs()) };
  }
  const { readActivityScreen } = await import("./live-source");
  return live(view.state, () => readActivityScreen(subjectFor(view), 40), emptyActivity);
}

export async function loadCards(view: ClientView): Promise<Loaded<CardsScreen>> {
  if (view.state === "error") return errorState<CardsScreen>();
  if (view.state === "empty") {
    return { ok: true, value: emptyCards(await businessRefs()) };
  }
  const { readCardsScreen } = await import("./live-source");
  return live(view.state, () => readCardsScreen(subjectFor(view)), emptyCards);
}

export async function loadPay(view: ClientView): Promise<Loaded<PayScreen>> {
  if (view.state === "error") return errorState<PayScreen>();
  if (view.state === "empty") {
    return { ok: true, value: emptyPay(await businessRefs()) };
  }
  const { readPayScreen } = await import("./live-source");
  return live(view.state, () => readPayScreen(subjectFor(view)), emptyPay);
}

export async function loadApprove(view: ClientView): Promise<Loaded<ApproveScreen>> {
  if (view.state === "error") return errorState<ApproveScreen>();
  if (view.state === "empty") {
    return { ok: true, value: emptyApprove(await businessRefs()) };
  }
  const { readApproveScreen, currentActorForRequest } = await import("./live-source");
  // Resolved HERE, inside the request, because this is where the cookie is
  // readable. The reader takes the actor rather than fetching it — see the note
  // on `currentActorForRequest`.
  const actor = await currentActorForRequest();
  return live(
    view.state,
    () => readApproveScreen(subjectFor(view), view.paymentId, actor),
    emptyApprove,
  );
}
