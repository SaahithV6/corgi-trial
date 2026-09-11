/**
 * Price the settlements that were already on the book when interchange
 * shipped.
 *
 * ─── Why a backfill exists at all, and why it is not a migration ────────────
 *
 * `4100 Interchange income` has been in the chart since migration 0001 and
 * nothing had ever posted to it. This book carries 163 card settlements with a
 * real provider transaction record behind them — real Lithic sandbox
 * authorisations, real clearings, real refunds, 54 of them already reversed by
 * the correction machinery. Shipping the hook alone would leave every one of
 * them unpriced and the economics screen empty, and an empty screen proves
 * nothing about whether the programme makes money.
 *
 * It is not done in SQL inside the migration, and that is deliberate: money is
 * written by `postEntry()` -> `ledger_append()` and by NOTHING ELSE, so the
 * hash chain, the serialised `booking_seq` and the idempotent replay hold for
 * every line. A migration that INSERTed journal rows would be the one place in
 * this system that bypassed all three.
 *
 * ─── It is the hook, run over history ───────────────────────────────────────
 *
 * This module contains no pricing logic. It selects settlements and calls
 * `reconcileSettlement()` — the same function the live webhook hook calls, in
 * the same order, with the same idempotency. So the postings a backfill
 * produces are indistinguishable from the ones the hook would have produced had
 * the feature existed on the day, INCLUDING the repairs: a settlement that was
 * reversed before interchange shipped gets its interchange booked at the
 * original amount and then unbooked at the original value date, which is
 * exactly the pair of facts the live path would have written.
 *
 * ─── Safe to run repeatedly ─────────────────────────────────────────────────
 *
 * Every write underneath is decided by a unique index. A second run reports
 * `unchanged` for everything it did the first time. That is asserted in
 * `interchange.integration.test.ts` rather than claimed here.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import { reconcileCandidate, type ReconcileOutcome } from "./book";
import { listCandidates, ledgerPosterActorId } from "./store";

export interface BackfillResult {
  readonly examined: number;
  readonly booked: number;
  readonly repaired: number;
  readonly unchanged: number;
  readonly unpriceable: number;
  readonly zeroValue: number;
  readonly reCorrection: number;
  /** Gross interchange booked by this run, before any repair. */
  readonly interchangeBookedCents: bigint;
  /** Interchange this run took back off the book, at the ORIGINAL value date. */
  readonly interchangeUnbookedCents: bigint;
  /**
   * Every settlement this run could not resolve, with its reason. Carried
   * rather than counted: "sixteen were skipped" is not a diagnosis.
   */
  readonly skipped: readonly { readonly entryId: string; readonly reason: string }[];
}

export interface BackfillOptions {
  /**
   * Only settlements with a provider transaction record. `true` is the useful
   * default for a run whose output you are about to read: the rest are
   * unpriceable by construction and would be 152 identical lines of "no
   * provider transaction record". `false` walks everything, which is what the
   * integration test does so that the unpriceable arm is exercised on real
   * rows rather than asserted.
   */
  readonly onlyProviderRecords?: boolean;
  readonly limit?: number;
  readonly run?: string;
  readonly conn?: Sql;
}

export async function backfillInterchange(
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const conn = options.conn ?? sql;
  // Resolved once for the whole run rather than once per settlement: it is the
  // same actor every time and 163 round trips for one uuid is 163 round trips.
  const actorId = await ledgerPosterActorId(conn);
  const run = options.run ?? "interchange:backfill";

  const candidates = await listCandidates(
    {
      onlyProviderRecords: options.onlyProviderRecords ?? true,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    conn,
  );

  let booked = 0;
  let repaired = 0;
  let unchanged = 0;
  let unpriceable = 0;
  let zeroValue = 0;
  let reCorrection = 0;
  let bookedCents = 0n;
  let unbookedCents = 0n;
  const skipped: { entryId: string; reason: string }[] = [];

  // Sequential, deliberately. These postings take an advisory lock inside
  // ledger_append() one at a time anyway, and a parallel fan-out over the same
  // lock buys nothing but a harder failure to read when one row is refused.
  for (const candidate of candidates) {
    const outcome: ReconcileOutcome = await reconcileCandidate(candidate, {
      actorId,
      run,
      conn,
    });

    switch (outcome.status) {
      case "booked":
        booked += 1;
        bookedCents += outcome.interchangeCents;
        break;
      case "booked_and_repaired":
        booked += 1;
        repaired += 1;
        bookedCents += outcome.interchangeCents;
        unbookedCents += absOf(
          outcome.repair.previousNaturalCents - outcome.repair.rebookNaturalCents,
        );
        break;
      case "repaired":
        repaired += 1;
        unbookedCents += absOf(
          outcome.repair.previousNaturalCents - outcome.repair.rebookNaturalCents,
        );
        break;
      case "unchanged":
        unchanged += 1;
        break;
      case "unpriceable":
        unpriceable += 1;
        skipped.push({ entryId: candidate.settlementEntryId, reason: outcome.reason });
        break;
      case "zero_value":
        zeroValue += 1;
        skipped.push({
          entryId: candidate.settlementEntryId,
          reason: `prices to zero cents at ${outcome.category} ${outcome.rateBps} bps`,
        });
        break;
      case "re_correction_unsupported":
        reCorrection += 1;
        skipped.push({
          entryId: candidate.settlementEntryId,
          reason: `corrected a second time: the book says ${outcome.bookedNaturalCents} and the settlement is now worth ${outcome.expectedNaturalCents}`,
        });
        break;
      case "not_found":
        skipped.push({
          entryId: candidate.settlementEntryId,
          reason: "the settlement disappeared between listing and reconciling",
        });
        break;
    }
  }

  return {
    examined: candidates.length,
    booked,
    repaired,
    unchanged,
    unpriceable,
    zeroValue,
    reCorrection,
    interchangeBookedCents: bookedCents,
    interchangeUnbookedCents: unbookedCents,
    skipped,
  };
}

function absOf(value: bigint): bigint {
  return value < 0n ? -value : value;
}
