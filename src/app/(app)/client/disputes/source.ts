import "server-only";

/**
 * The read behind `/client/disputes`.
 *
 * ===========================================================================
 * EVERY READ IS SCOPED BY A PREDICATE, AND NONE OF THEM BY A FILTER
 * ===========================================================================
 *
 * There is no `rows.filter(r => r.businessId === mine)` in this file, and the
 * shape in `@/components/client/disputes/contract` makes one impossible to
 * write later by not carrying a tenant on any row. What the three live reads
 * actually issue:
 *
 *   readBalanceScreen(businessId)                 -> mainDepositAccountId($1)
 *   listDisputableCharges({ businessId })         WHERE a.business_id = $1
 *   listDisputeStates({ businessId })             WHERE s.business_id = $1
 *
 * The event timelines are the one read keyed on something other than the
 * business, and they are keyed on dispute ids that came OUT of the scoped case
 * query one line above. No id on this path was ever typed by anybody.
 *
 * ===========================================================================
 * ONE DEFINITION OF AVAILABILITY
 * ===========================================================================
 *
 * The available balance on this screen is `readBalanceScreen`'s own figure,
 * which is `ledger_availability()`'s own answer carried unchanged through
 * `BalanceTerms`. This file does no money arithmetic at all: the one
 * subtraction it performs, `netCharge - alreadyClaimed`, is on two figures the
 * library's SQL already computed, and the write path computes it again server
 * side rather than trusting this one.
 *
 * The balance is on this screen for a reason worth stating. A customer filing a
 * claim wants to know what just happened to their money, and the correct answer
 * is NOTHING — so the screen shows the number, before and after, rather than
 * asserting it in prose.
 *
 * ===========================================================================
 * WHY THE IMPORTS ARE DYNAMIC
 * ===========================================================================
 *
 * The same reason `src/app/(app)/client/sources.ts` gives: importing the live
 * modules evaluates `src/lib/env.ts`, which refuses to load without a full set
 * of keys. That is right for the app and wrong for a page whose job includes
 * rendering the words "no database configured".
 */

import type { Loaded } from "@/components/client/contract";
import type {
  CaseStep,
  CustomerCase,
  DisputableCharge,
  DisputesScreen,
  ReasonOption,
} from "@/components/client/disputes/contract";
import { reasonWord, stepSentence } from "@/components/client/disputes/language";
import type { ClientView } from "@/components/client/view-state";

/** How many of each list is worth reading. A screen, not an export. */
const CHARGE_LIMIT = 20;
const CASE_LIMIT = 12;

/**
 * How many cases get their full timeline read.
 *
 * The timeline is one query per case, so it is bounded rather than issued for
 * every case on the book. The newest cases are the ones a customer has come to
 * this screen to check on; the older ones still show their status, which is the
 * fold and costs nothing extra.
 */
const TIMELINE_LIMIT = 6;

/** True when this deployment has a database to read at all. */
async function databaseAvailable(): Promise<boolean> {
  const { hasDatabase } = await import("../live-source");
  return hasDatabase();
}

/**
 * Whether a step was our decision rather than the customer's.
 *
 * Intake is the customer's; everything after it is Corgi's. That is not a
 * simplification on this book — `src/lib/disputes/operations.ts` says so in its
 * own header: Lithic's sandbox has no dispute simulator, so the advance, the
 * evidence and the network's verdict are all operator actions recorded by a
 * human. If a customer-driven transition is ever added, this line is where it
 * stops being true and it is one line.
 */
function decidedByCorgi(kind: string): boolean {
  return kind !== "raised";
}

export async function loadClientDisputes(view: ClientView): Promise<Loaded<DisputesScreen>> {
  if (!(await databaseAvailable())) {
    return {
      ok: false,
      code: "NO_DATABASE",
      message:
        "This deployment has no database configured, so there is nothing to read. Set " +
        "APP_DATABASE_URL in .env and restart. No claim was affected.",
    };
  }

  const { readBalanceScreen } = await import("../live-source");
  const { ledgerConnection } = await import("@/lib/ledger/queries");
  const {
    DISPUTE_STATUS_MEANING,
    listDisputableCharges,
    listDisputeEvents,
    listDisputeStates,
    listReasonCodes,
  } = await import("@/lib/disputes");

  try {
    // The subject, resolved exactly the way the other five client screens
    // resolve it — a uuid that names nothing falls back to the default
    // customer and never widens to "every business".
    const balance = await readBalanceScreen(view.businessId);
    if (!balance.ok) return balance;
    const { header, terms } = balance.value;

    const conn = await ledgerConnection();

    const [chargeRows, caseRows, codeRows] = await Promise.all([
      listDisputableCharges({ businessId: header.businessId, limit: CHARGE_LIMIT }, conn),
      listDisputeStates({ businessId: header.businessId, limit: CASE_LIMIT }, conn),
      listReasonCodes(conn),
    ]);

    const charges: readonly DisputableCharge[] = chargeRows.map((row) => ({
      entryId: row.entryId,
      valueDate: row.valueDate,
      description: row.description,
      externalRef: row.externalRef,
      netChargeCents: row.netChargeCents,
      alreadyClaimedCents: row.alreadyClaimedCents,
      outstandingCents: row.netChargeCents - row.alreadyClaimedCents,
      cardLastFour: row.cardLastFour,
      cardNickname: row.cardNickname,
    }));

    // Keyed on ids that came out of the scoped query above, never on anything
    // a browser sent. Bounded, and issued together rather than in a loop that
    // waits on each one.
    const timelines = await Promise.all(
      caseRows.slice(0, TIMELINE_LIMIT).map(async (row) => {
        const events = await listDisputeEvents(row.id, conn);
        const steps: readonly CaseStep[] = events.map((event) => ({
          id: event.id,
          kind: event.kind,
          sentence: stepSentence(event.kind),
          valueDate: event.valueDate,
          byCorgi: decidedByCorgi(event.kind),
          amountCents: event.amountCents,
        }));
        return [row.id, steps] as const;
      }),
    );
    const stepsByCase = new Map(timelines);

    const cases: readonly CustomerCase[] = caseRows.map((row) => ({
      disputeId: row.id,
      caseRef: row.caseRef,
      disputedEntryId: row.disputedEntryId,
      reason: row.reason,
      reasonWord: reasonWord(row.reason),
      narrative: row.narrative,
      amountCents: row.amountCents,
      status: row.status,
      // The library's own sentence for the status, not a second one written
      // here. An unknown status prints its own name rather than nothing.
      statusMeaning:
        DISPUTE_STATUS_MEANING[row.status as keyof typeof DISPUTE_STATUS_MEANING] ??
        row.status.replaceAll("_", " "),
      isClosed: row.isClosed,
      valueDate: row.valueDate,
      networkOutsideDate: row.networkOutsideDate,
      daysToOutsideDate: row.daysToOutsideDate,
      advancedCents: row.advancedCents,
      heldCents: row.heldCents,
      steps: stepsByCase.get(row.id) ?? [],
    }));

    // One option per reason we can actually file under, in the order the enum
    // declares them. `find` picks the first network in name order, which is the
    // same rule the action applies at the moment of the write — the two must
    // agree or the screen would promise a code the write did not use.
    const seen = new Set<string>();
    const reasons: ReasonOption[] = [];
    for (const row of codeRows) {
      if (seen.has(row.reason)) continue;
      seen.add(row.reason);
      reasons.push({
        reason: row.reason,
        label: reasonWord(row.reason),
        networkCode: `${row.network}/${row.networkCode}`,
        networkLabel: row.networkLabel,
      });
    }

    return {
      ok: true,
      value: {
        header,
        charges,
        cases,
        reasons,
        availableCents: terms.availableCents,
        ledgerCents: terms.ledgerCents,
      },
    };
  } catch (thrown) {
    // Named, and it says what it was doing. This whole function only READS, so
    // there is nothing to roll back and the screen can say so — which matters
    // more here than anywhere: "something went wrong" next to a dispute reads
    // as "your claim is gone" unless the screen says plainly that it is not.
    return {
      ok: false,
      code: "DISPUTES_READ_FAILED",
      message:
        (thrown instanceof Error
          ? `${thrown.name}: ${thrown.message}`
          : "the read failed and gave no reason") +
        " — this screen only reads, so no claim was opened, changed or closed. Reload.",
    };
  }
}
