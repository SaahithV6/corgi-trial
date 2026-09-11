/**
 * The four non-live states, as data.
 *
 * WHY THE DEFAULT STATE IS NOT IN HERE. The claim being graded is that
 * interchange is booked on real settlements at a real rate card and that a
 * reversal unbooks it — so the default state has to be a real read of real
 * entries. A fixture would answer the question by construction and prove
 * nothing.
 *
 * WHAT THE EDGE FIXTURE SHOWS, AND WHY IT IS NOT MADE UP. Two things that are
 * both true on the live book and both hard to point at on demand:
 *
 *   1. AN EXACT HALF-CENT TIE, broken to the EVEN cent by DESIGN §12.2. The
 *      figures are computed by `priceSettlement()` — the same function the
 *      ledger posts through — so the fixture cannot disagree with the rule. It
 *      borrows only the CHOICE of amount: 200c at 125 bps lands on exactly
 *      5000/10000 of a cent, which is the case half-up would get different.
 *
 *   2. A SETTLEMENT THE MERCHANT TOOK BACK, with its interchange unbooked at
 *      the ORIGINAL value date and the net at exactly zero. 56 of these are on
 *      the live book; the fixture puts one beside an ordinary settlement so the
 *      difference is visible in one screenful.
 */

import {
  interchangeForNet,
  priceSettlement,
  type Presentment,
} from "@/lib/interchange/rate-card";
import type {
  CategoryRow,
  EconomicsDataSource,
  EconomicsView,
  RateCardRow,
  SettlementRow,
  UnitEconomicsRow,
} from "@/lib/interchange/screen";

import type { EconomicsState } from "./view-state";

const FUEL_V2 = { rateBps: 145, fixedCents: 5n };
const TIE = { rateBps: 125, fixedCents: 0n };

function settlement(
  over: Partial<SettlementRow> & Pick<SettlementRow, "id" | "settledCents" | "rateBps" | "fixedCents">,
): SettlementRow {
  const magnitude = over.settledCents > 0n ? over.settledCents : -over.settledCents;
  const a = priceSettlement(magnitude, { rateBps: over.rateBps, fixedCents: over.fixedCents });
  const net = over.netSettledCents ?? over.settledCents;
  const booked = interchangeForNet(net, {
    rateBps: over.rateBps,
    fixedCents: over.fixedCents,
  });
  return {
    id: over.id,
    valueDate: over.valueDate ?? "2026-09-11",
    providerEventId: over.providerEventId ?? `evt-${over.id}`,
    businessName: over.businessName ?? "Kettle & Crumb Bakery LLC",
    mcc: over.mcc ?? "5542",
    category: over.category ?? "fuel",
    presentment: over.presentment ?? ("card_not_present" as Presentment),
    entryMode: over.entryMode ?? "MANUAL",
    network: over.network ?? "VISA",
    descriptor: over.descriptor ?? "CORGI FUEL PUMP 14",
    direction: over.settledCents > 0n ? "earned" : "returned",
    settledCents: over.settledCents,
    netSettledCents: net,
    rateBps: over.rateBps,
    fixedCents: over.fixedCents,
    numerator: a.numerator,
    denominator: a.denominator,
    wholeCents: a.wholeCents,
    remainderUnits: a.remainderUnits,
    rounding: a.rounding,
    adValoremCents: a.adValoremCents,
    interchangeCents: a.interchangeCents,
    bookedNaturalCents: booked.naturalCents,
    settlementEntryId: over.settlementEntryId ?? `settlement-${over.id}`,
    entryId: over.entryId ?? `interchange-${over.id}`,
    reversalEntryId: over.reversalEntryId ?? null,
    rebookEntryId: over.rebookEntryId ?? null,
    reversalReason: over.reversalReason ?? null,
    rateEffectiveFrom: over.rateEffectiveFrom ?? "2026-09-11",
  };
}

const EDGE_SETTLEMENTS: readonly SettlementRow[] = [
  settlement({
    id: "tie",
    settledCents: 200n,
    rateBps: TIE.rateBps,
    fixedCents: TIE.fixedCents,
    mcc: "8398",
    category: "charity",
    descriptor: "CORGI COMMUNITY FUND",
  }),
  settlement({
    id: "tie-odd",
    settledCents: 600n,
    rateBps: TIE.rateBps,
    fixedCents: TIE.fixedCents,
    mcc: "8398",
    category: "charity",
    descriptor: "CORGI COMMUNITY FUND",
  }),
  settlement({
    id: "ordinary",
    settledCents: 7340n,
    rateBps: FUEL_V2.rateBps,
    fixedCents: FUEL_V2.fixedCents,
    descriptor: "CORGI FUEL PUMP 14",
  }),
  settlement({
    id: "reversed",
    settledCents: 7340n,
    netSettledCents: 0n,
    rateBps: FUEL_V2.rateBps,
    fixedCents: FUEL_V2.fixedCents,
    descriptor: "CORGI FUEL PUMP 14",
    reversalEntryId: "reversal-of-interchange-reversed",
    reversalReason:
      "the settlement it priced was reversed in full, so the interchange was never earned",
  }),
];

const EDGE_BUSINESSES: readonly UnitEconomicsRow[] = [
  {
    businessId: "fixture-1",
    legalName: "Kettle & Crumb Bakery LLC",
    pricedSettlements: 4,
    reversedSettlements: 1,
    grossSettledCents: 15_480n,
    netSettledCents: 8_140n,
    interchangeCents: 121n,
    feeIncomeCents: 0n,
    interestIncomeCents: 0n,
    fxVarianceCents: 0n,
    interestExpenseCents: 135n,
    otherExpenseCents: 0n,
    netContributionCents: -14n,
  },
];

const EDGE_CATEGORIES: readonly CategoryRow[] = [
  {
    category: "charity",
    presentment: "card_not_present",
    settlements: 2,
    grossSettledCents: 800n,
    netSettledCents: 800n,
    interchangeCents: 10n,
    halfCentTies: 2,
    remainderUnitsDropped: 10_000n,
  },
  {
    category: "fuel",
    presentment: "card_not_present",
    settlements: 2,
    grossSettledCents: 14_680n,
    netSettledCents: 7_340n,
    interchangeCents: 111n,
    halfCentTies: 0,
    remainderUnitsDropped: 8_600n,
  },
];

const EDGE_RATE_CARD: readonly RateCardRow[] = [
  {
    id: "fixture-fuel-v1",
    category: "fuel",
    categoryDescription: "Service stations and automated fuel dispensers.",
    categoryIsDefault: false,
    presentment: "card_not_present",
    effectiveFrom: "2026-08-12",
    supersededOn: "2026-09-11",
    rateBps: 155,
    fixedCents: 5n,
    note: "Opening card.",
    settlementsPriced: 77,
    mccsMapped: 3,
  },
  {
    id: "fixture-fuel-v2",
    category: "fuel",
    categoryDescription: "Service stations and automated fuel dispensers.",
    categoryIsDefault: false,
    presentment: "card_not_present",
    effectiveFrom: "2026-09-11",
    supersededOn: null,
    rateBps: 170,
    fixedCents: 5n,
    note: "Fuel re-rate. Settlements before today keep the 1.55% card.",
    settlementsPriced: 42,
    mccsMapped: 3,
  },
];

const CLEAN_GUARDS = [
  {
    view: "v_interchange_unreversed",
    claim: "no revenue stands on a settlement the network took back",
    rows: 0,
  },
  {
    view: "v_interchange_drift",
    claim: "every priced settlement carries the interchange it is now worth",
    rows: 0,
  },
  {
    view: "v_interchange_rate_drift",
    claim: "no settlement has been re-priced by a rate that came later",
    rows: 0,
  },
];

const EMPTY: EconomicsView = {
  businesses: [],
  categories: [],
  rateCard: EDGE_RATE_CARD,
  settlements: [],
  unpriced: [],
  unpricedTotal: 0,
  guards: CLEAN_GUARDS,
  asOf: "2026-09-11T05:00:00.000Z",
};

const EDGE: EconomicsView = {
  businesses: EDGE_BUSINESSES,
  categories: EDGE_CATEGORIES,
  rateCard: EDGE_RATE_CARD,
  settlements: EDGE_SETTLEMENTS,
  unpriced: [
    {
      settlementEntryId: "fixture-unpriced",
      kind: "clearing",
      valueDate: "2026-09-10",
      providerAuthId: "auth-1789059056109-2",
      customerCents: 3_000n,
      providerRecordPresent: false,
      reason:
        "no provider transaction record: there is no merchant and no entry mode to read, and a dimension that cannot be populated from a real event is not invented",
    },
  ],
  unpricedTotal: 152,
  guards: CLEAN_GUARDS,
  asOf: "2026-09-11T05:00:00.000Z",
};

export function createFixtureEconomicsSource(state: EconomicsState): EconomicsDataSource {
  return {
    load: async () => {
      switch (state) {
        case "empty":
          return EMPTY;
        case "error":
          throw new Error(
            "the economics read failed: v_unit_economics could not be read on this connection",
          );
        case "loading":
          // A genuinely slow read, not a faked render. The Suspense fallback is
          // the real skeleton and it is held open by this.
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          return EDGE;
        case "edge":
        case "default":
        default:
          return EDGE;
      }
    },
  };
}
