/**
 * The control set a card is born with.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the live book on 2026-09-11, over the whole history of the
 * provider lane:
 *
 *     51 provider-lane approvals
 *       38  no_controls_configured
 *       10  card_not_under_control
 *        3  within_controls
 *
 *     911 cards, 31 of them carrying any control version at all.
 *
 * Forty-eight of fifty-one approvals were produced by a rule that judged
 * NOTHING. The machinery was never in doubt — ten real Lithic transactions
 * that morning drove per-card limits, MCC blocks, per-member limits summed
 * across two cards, fail-open and fail-closed, at a p50 of 14.2 ms against a
 * 6000 ms ceiling — but almost no card was under it, so the real-time decision
 * path was mute on nearly every authorisation it saw.
 *
 * ─── RE-MEASURED LATER THE SAME DAY, AND THE NUMBERS MOVED ──────────────────
 *
 * The figures above are kept because they are what this file was written
 * against, not because they are current. Re-run after the live-fire suites had
 * driven more traffic through the same book:
 *
 *     63 provider-lane approvals
 *       44  no_controls_configured
 *       11  card_not_under_control
 *        8  within_controls
 *
 *     936 cards — under_control 45, member_only 137, uncontrolled 756.
 *
 * The share barely moved (94% → 87%) and the ABSOLUTE count of unjudged
 * approvals went UP, from 48 to 55, because every suite that registers a card
 * directly through `registerCard()` adds another uncontrolled one. Two things
 * that matter follow. First, a figure in a comment is a measurement with a
 * timestamp, not a fact — re-measure before quoting. Second, "p50 14.2 ms" is
 * NOT reproducible over the whole provider lane: `decision_latency_us` across
 * all 81 provider rows has a p50 of 125 ms and a p95 of 508 ms, because the
 * lane includes the deliberate fail-closed rows that sat out the full 600 ms
 * budget. 14.2 ms was a true statement about one burst of ten transactions.
 *
 * ─── AND THE HALF OF THE FINDING THIS FILE DID NOT CLOSE ────────────────────
 *
 * Applying a default to NEW cards does nothing about the approvals ALREADY in
 * the log, and until 2026-09-11 every one of them said `outcome: 'approve'` and
 * nothing else — so a reader counting approvals as evidence that card controls
 * work counted 63 when the honest number was 8. That is fixed separately and
 * deliberately without touching a single decision: every verdict now carries
 * `judged`, defined in `UNJUDGED_RULES` in `./types.ts`, derived for historic
 * rows from the `rule` column they already carry, and mirrored in SQL by
 * migration 0053. See `./judged.test.ts`.
 *
 * THE CAUSE IS NOT `decide()`. Rule 15, `no_controls_configured`, is
 * deliberate, documented, unit-tested and correct: the read SUCCEEDED and told
 * us the truth, which is that nobody has said anything about this card, so it
 * approves. That is "approve unless told otherwise", it is the same fail-OPEN
 * argument rule 2 makes at the scope boundary, and flipping it would decline
 * live cards for a reason nobody chose. It stays exactly as it is.
 *
 * THE CAUSE IS THAT NOTHING EVER CALLED THE WRITER. Before this file,
 * `setCardControls()` had exactly one caller in the entire tree —
 * `setCardControlsAction` in `src/components/accounts/CardControlsActions.tsx`,
 * a server action reachable only by a human pressing Save on `/accounts`. Both
 * issuance paths (`issueCardAction` for the console, `issueCardForMember()` for
 * the team) call Lithic's `createCard()` and then `registerCard()` and stop. A
 * card was therefore born with no controls, for ever, unless somebody
 * remembered to open a screen and type some in. Thirty-one people remembered.
 *
 * So `no_controls_configured` is an INTENDED DEFAULT sitting on top of an
 * UNINTENDED GAP, and only the second one is a bug. This file closes the
 * second one and does not touch the first.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THE DEFAULT IS A PER-TRANSACTION CEILING, AND WHY IT IS $5,000
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Three defaults were available and they are genuinely different products.
 *
 * A DAILY LIMIT IS THE MOST USEFUL and it is the wrong default. Whatever
 * number is picked, no customer picked it. The first thing a default daily
 * limit does is decline a real purchase on a card whose owner never agreed to
 * it, at a counter, with `VELOCITY_EXCEEDED` on the wire — and the operator who
 * has to explain it cannot, because the honest answer is "an engineer guessed".
 * A daily limit is the right SECOND control. It is set on the screen, by a
 * person, as version 2, with the mandatory note saying why.
 *
 * AN MCC BLOCK LIST IS THE MOST OPINIONATED and it is the worst default. A
 * block list is a policy about what a business may buy, and we do not know
 * Kettle & Crumb's policy. Inventing one declines at the till with
 * `UNAUTHORIZED_MERCHANT`, which reads to the cardholder as a broken card
 * rather than as a rule.
 *
 * A PER-TRANSACTION CEILING IS THE LEAST SURPRISING, and one particular
 * per-transaction ceiling is better than merely least surprising — it is
 * PROVABLY BEHAVIOUR-NEUTRAL.
 *
 * Both issuance paths already send Lithic `spend_limit: 500000` with
 * `spend_limit_duration: "TRANSACTION"` (`CARD_SPEND_LIMIT_CENTS`, in
 * `src/app/(app)/accounts/actions.ts` and `src/lib/team/lifecycle.ts`). Every
 * card this system has ever issued is ALREADY under a $5,000 per-transaction
 * ceiling, enforced by the issuer, whether or not ASA is enrolled and whether
 * or not this system is up. Setting our default equal to it means:
 *
 *     the set of authorisations this default newly declines is EMPTY,
 *
 * because the predicate is the same predicate on the same axis with the same
 * inclusivity (`spend + amount > limit`, so $5,000 exactly is permitted on both
 * sides). This is not "a number big enough that it probably will not fire". It
 * is a number that CANNOT fire without Lithic having already declined. That is
 * the only kind of default that can be applied to a book with live demo cards
 * on it without a rehearsal.
 *
 * WHAT IT BUYS, given that it declines nothing:
 *
 *   1. THE DECISION IS JUDGED RATHER THAN WAVED THROUGH. The row changes from
 *      `no_controls_configured` (control_version_id NULL — nothing to cite in a
 *      dispute) to `within_controls` with a PINNED control version. "What was
 *      this card allowed to do at 14:07" becomes a lookup instead of a shrug.
 *   2. THE OFF SWITCH EXISTS. `card_state` is now a real field with a real
 *      current value on that card, so freezing it is a version bump on an
 *      existing chain rather than the first control anyone ever set. Freeze is
 *      the promise this feature makes (see `decide.ts`); it should not depend
 *      on a card having been configured first.
 *   3. RULE 15 BECOMES A SIGNAL INSTEAD OF NOISE. `no_controls_configured`
 *      stops being what normally happens and starts meaning exactly one thing:
 *      a card that reached this book WITHOUT going through an issuance path
 *      that applies the default. That is a provisioning gap, and an operator
 *      should be able to see it — which is what `v_card_control_coverage` and
 *      the coverage panel on `/accounts` are for.
 *
 * AND THE HONEST COST, stated rather than buried: this default does not make
 * anybody safer. It tightens nothing. It converts an unjudged approval into a
 * judged one and gives the operator somewhere to stand; the actual safety is
 * the daily limit a human sets as version 2, on the screen, on purpose.
 * Claiming otherwise would be claiming a capability no call has proven.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A DATABASE TRIGGER
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The obvious implementation is an `AFTER INSERT ON card` trigger writing
 * version 1. It would cover every path — console, team, live-fire fixtures, the
 * chaos driver — without editing a single module owned by somebody else, and
 * `assert_card_control_version()` is already a trigger, so it is in keeping.
 *
 * It is still wrong, for one reason that outweighs the convenience: it would
 * make an uncontrolled card UNREPRESENTABLE, and `no_controls_configured` is a
 * rule this system must keep being able to reach. A fail-open branch that can
 * no longer be produced is a fail-open branch that can no longer be TESTED —
 * `cards.integration.test.ts` and the panel's `?controls=empty` state both
 * depend on a card that has never had a control set, and the ability to
 * demonstrate rule 15 in a debrief is worth more than the ability to say every
 * row has a default. A trigger would also write a mandatory `note` and a
 * `created_by` that no application code chose, in a table whose entire purpose
 * is to answer "who decided this, and why".
 *
 * So the default is applied by the issuance path, explicitly, by name, and the
 * cards that do not get one are visible on a screen instead of impossible.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHO `created_by` IS, AND WHY IT IS NOT THE PERSON WHO PRESSED ISSUE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `card_control_version.created_by` is read first in a dispute. Putting the
 * issuing operator's name on version 1 would say "Alex set a $5,000
 * per-transaction limit on this card", which Alex did not do — Alex issued a
 * card and the program applied its default. So version 1 is authored by a
 * `system` actor, `card-control-default` (migration 0051), alongside the
 * `ledger-poster` and `webhook-dispatcher` actors that already exist for
 * exactly this purpose: machine-originated rows get a machine principal so that
 * "who applied this" and "who chose this" stay two answerable questions.
 *
 * The invariant that falls out, and it is worth stating because a reader can
 * check it in one query:
 *
 *     VERSION 1 IS THE PROGRAM DEFAULT AND IS AUTHORED BY `card-control-default`.
 *     EVERY LATER VERSION IS AUTHORED BY A HUMAN ON THE CONSOLE.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DOES NOT CHANGE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * THE HOT PATH. `readControlsAndSpend()` is untouched: same one statement, same
 * LEFT JOIN to `v_card_control_current`, same two `CROSS JOIN LATERAL`
 * aggregates, same 600 ms deadline. A card with a default control version reads
 * through exactly the join that was already there, and the row it finds is the
 * row the join was already looking for. No round trip was added, because none
 * could be: the decision path ends in a DECLINE if it misses its window, so a
 * control that is correct and late is a decline.
 *
 * THE WRITE SURFACE. `applyDefaultControls()` is server-only and is called from
 * the issuance path and from nowhere else. The MCP surface and the public API
 * remain read-only on controls, by the argument in `src/lib/mcp/limits.ts` and
 * `src/lib/api/limits.ts`: a control change IS an authorisation decision made
 * in advance, with no person on the path, and nothing here widens that.
 */

import "server-only";

import { sql } from "@/lib/ledger/db";

import { DEFAULT_CONTROLS, DEFAULT_CONTROL_ACTOR_ID, DEFAULT_CONTROL_NOTE } from "./default-controls";

/* -------------------------------------------------------------------------- */
/* 1. The default itself — re-exported from a module with no database in it   */
/* -------------------------------------------------------------------------- */

/**
 * The figures live in `./default-controls.ts` and are re-exported here so that
 * every caller of `@/lib/cards/defaults` is unchanged.
 *
 * THE SPLIT IS NOT TIDINESS. This module imports `server-only` and
 * `@/lib/ledger/db`, which parses the environment at module scope and throws
 * when it is absent; a test that imported these constants from here threw while
 * being LOADED on every machine without credentials, and a suite that throws on
 * import is counted in neither the passed number nor the skipped number. The
 * argument is written out at the top of `./default-controls.ts`.
 */
export {
  DEFAULT_CONTROLS,
  DEFAULT_CONTROL_ACTOR_ID,
  DEFAULT_CONTROL_NOTE,
  DEFAULT_PER_TXN_LIMIT_CENTS,
} from "./default-controls";

/* -------------------------------------------------------------------------- */
/* 2. Applying it                                                             */
/* -------------------------------------------------------------------------- */

export type DefaultControlsOutcome =
  /** Version 1 was written now. */
  | { readonly kind: "applied"; readonly controlVersionId: string }
  /** The card already had a control chain. Nothing was written, nothing moved. */
  | { readonly kind: "already_controlled" }
  /** The write failed. The CARD still exists; only the default is missing. */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Write version 1 of the program default for one card, if it has none.
 *
 * ONE STATEMENT, AND IT IS GUARDED IN SQL RATHER THAN IN JAVASCRIPT. The
 * `WHERE NOT EXISTS` is a subquery on the same round trip, not a read followed
 * by a write, so two issuances racing on the same card cannot both see "no
 * controls" and both insert version 1: one is refused by
 * `UNIQUE (card_id, version)` and the caller is told `already_controlled`
 * rather than being handed an exception it would have to classify.
 *
 * THIS RETURNS THREE OUTCOMES, NOT TWO. `already_controlled` and `failed` are
 * different facts and collapsing them would let the issuance path report a
 * problem about a card that is fine — the same mistake
 * `reappendDecisionIfMissing()` in `./store.ts` was fixed for, for the same
 * reason.
 *
 * IT NEVER THROWS. Issuing a card is the operation the operator asked for; the
 * default is a consequence of it. A card that exists at Lithic, is registered
 * here, and did not get its default control is a card that behaves EXACTLY as
 * every card issued before today behaved — approved by `no_controls_configured`
 * — which is a degradation the coverage panel can show and an operator can fix
 * with one press of Save. Throwing here would turn a missing default into a
 * failed issuance and strand a real card at the provider with nothing bound to
 * it, which is strictly worse. The caller logs it; it does not refuse.
 */
export async function applyDefaultControls(params: {
  readonly cardId: string;
  /** Override only for a deliberate backfill. Defaults to the system actor. */
  readonly actorId?: string;
  /** Override only for a deliberate backfill, which says why it happened. */
  readonly note?: string;
}): Promise<DefaultControlsOutcome> {
  const actorId = params.actorId ?? DEFAULT_CONTROL_ACTOR_ID;
  const note = params.note ?? DEFAULT_CONTROL_NOTE;

  try {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO card_control_version (
        card_id, version, card_state,
        per_txn_limit_cents, daily_limit_cents, monthly_limit_cents,
        blocked_mccs, note, created_by
      )
      SELECT ${params.cardId}, 1, ${DEFAULT_CONTROLS.cardState},
             ${DEFAULT_CONTROLS.perTxnLimitCents},
             ${DEFAULT_CONTROLS.dailyLimitCents},
             ${DEFAULT_CONTROLS.monthlyLimitCents},
             ${DEFAULT_CONTROLS.blockedMccs as string[]}, ${note}, ${actorId}
       WHERE NOT EXISTS (
               SELECT 1 FROM card_control_version v WHERE v.card_id = ${params.cardId}
             )
      RETURNING id
    `;
    if (row === undefined) return { kind: "already_controlled" };
    return { kind: "applied", controlVersionId: row.id };
  } catch (thrown) {
    // 23505 unique_violation: another issuance won the race to version 1.
    // That is not a failure — the card is controlled, which is the point.
    if ((thrown as { code?: string }).code === "23505") {
      return { kind: "already_controlled" };
    }
    return {
      kind: "failed",
      detail: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 3. The gap, counted                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many of one business's cards are under control, and how many are not.
 *
 * `no_controls_configured` is a REAL STATE and an operator should be able to
 * see it rather than infer it from an approval. The three buckets are the three
 * branches `decide()` actually takes, which is why they are these three and not
 * a pair of "configured / not":
 *
 *   underControl   a control version exists. Judged by rules 7 to 11, and the
 *                  decision row pins the version.
 *   memberOnly     no control version, but the card belongs to a team member,
 *                  so rules 5, 6 and 12 to 14 judge it by the PERSON's terms.
 *                  Rule 15's predicate is `controls === null && member === null`
 *                  — a card with a holder has been judged, and reporting it as
 *                  "no controls" would be false.
 *   uncontrolled   neither. Every purchase on this card is approved by rule 15,
 *                  `no_controls_configured`, having been judged against nothing.
 *
 * OFF THE HOT PATH, on purpose and by construction: this is one aggregate over
 * `card`, read by a server component rendering `/accounts`. The authorisation
 * decision never calls it and never could — it holds no card token and answers
 * about a whole business.
 */
export type ControlCoverage = {
  readonly total: number;
  readonly underControl: number;
  readonly memberOnly: number;
  readonly uncontrolled: number;
};

export async function readControlCoverage(businessId: string): Promise<ControlCoverage> {
  const [row] = await sql<
    {
      total: bigint;
      under_control: bigint;
      member_only: bigint;
      uncontrolled: bigint;
    }[]
  >`
    SELECT count(*)::bigint                                        AS total,
           count(*) FILTER (WHERE cover = 'under_control')::bigint AS under_control,
           count(*) FILTER (WHERE cover = 'member_only')::bigint   AS member_only,
           count(*) FILTER (WHERE cover = 'uncontrolled')::bigint  AS uncontrolled
      FROM v_card_control_coverage
     WHERE business_id = ${businessId}
  `;

  return {
    total: Number(row?.total ?? 0n),
    underControl: Number(row?.under_control ?? 0n),
    memberOnly: Number(row?.member_only ?? 0n),
    uncontrolled: Number(row?.uncontrolled ?? 0n),
  };
}
