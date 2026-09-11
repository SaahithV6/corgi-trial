/**
 * The program default's FIGURES, in a module that reaches no database.
 *
 * ─── WHY THIS IS NOT IN `./defaults.ts` WITH THE FUNCTION THAT WRITES THEM ──
 *
 * `./defaults.ts` imports `server-only` and `@/lib/ledger/db`, and
 * `@/lib/ledger/db` PARSES THE ENVIRONMENT AT MODULE SCOPE and throws when
 * `APP_DATABASE_URL` is absent — deliberately, so a malformed database URL
 * kills the process at boot rather than at the first request that needs money.
 *
 * The consequence, found on 2026-09-11: `defaults.test.ts` imported those four
 * constants statically, so the whole suite THREW WHILE BEING LOADED on any
 * machine without credentials — which is every CI runner. Verbatim:
 *
 *     EnvironmentError: Environment is invalid. 1 problem(s):
 *       APP_DATABASE_URL: APP_DATABASE_URL is required
 *      ❯ src/lib/env.ts:57:25
 *      ❯ src/lib/ledger/db.ts:18:1
 *
 * A suite that throws on import is counted in neither the passed number nor the
 * skipped number — this repository's own vitest reporter says exactly that, in
 * those words — so four assertions about the one equality that makes the
 * program default safe to apply were INVISIBLE rather than failing. The suite
 * had taken the shape of the bug it was written to catch.
 *
 * Splitting the figures from the writer fixes it at the cause. The test imports
 * this file and needs no credentials to check what the numbers are; the writer
 * imports it too and re-exports it, so every existing consumer of
 * `@/lib/cards/defaults` is unchanged. It is the same split `./types.ts` makes
 * and for the same reason: a value four callers can import is worth more than a
 * value that lives next to the query that uses it.
 *
 * NOTHING HERE REACHES A DATABASE, A PROVIDER OR `server-only`, and nothing may
 * be added that does.
 */

import type { CardControlsDraft } from "./types";

/* -------------------------------------------------------------------------- */
/* 1. The default itself                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The per-transaction ceiling every newly-issued card is born under.
 *
 * DELIBERATELY EQUAL to `CARD_SPEND_LIMIT_CENTS` in
 * `src/app/(app)/accounts/actions.ts` and `src/lib/team/lifecycle.ts`, which is
 * the `spend_limit` both issuance paths already declare to Lithic with
 * `spend_limit_duration: "TRANSACTION"`. The equality is the whole argument for
 * the default being safe, so `defaults.test.ts` asserts it rather than trusting
 * a comment — if somebody raises the provider-side limit and not this one, the
 * default stops being behaviour-neutral and a test says so before a cardholder
 * does.
 */
export const DEFAULT_PER_TXN_LIMIT_CENTS = 5_000_00n;

/**
 * The note on version 1. Mandatory in the schema, and read first in a dispute,
 * so it says what happened and who did not choose it.
 */
export const DEFAULT_CONTROL_NOTE =
  "Program default, applied when this card was issued. A per-transaction " +
  "ceiling of $5,000.00 only — the same figure this system already declares to " +
  "Lithic as the card's own spend_limit, so it declines nothing the issuer " +
  "would not already have declined. No daily limit, no monthly limit, no " +
  "blocked categories: those are a person's decision, made on this screen, as " +
  "version 2. Nobody chose these figures; the program did.";

/** Version 1 of every card issued through a path that applies the default. */
export const DEFAULT_CONTROLS: CardControlsDraft = {
  cardState: "active",
  perTxnLimitCents: DEFAULT_PER_TXN_LIMIT_CENTS,
  dailyLimitCents: null,
  monthlyLimitCents: null,
  blockedMccs: [],
  note: DEFAULT_CONTROL_NOTE,
};

/**
 * The `system` actor version 1 is attributed to. Created by migration 0051,
 * with the id the seed's own `uuid5("actor:system.card-controls")` produces, so
 * a rebuilt book and this one agree.
 */
export const DEFAULT_CONTROL_ACTOR_ID = "b23a047b-e495-5f80-bf40-cd6396b77280";
