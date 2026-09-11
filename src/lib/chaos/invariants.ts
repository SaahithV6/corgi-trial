/**
 * The invariant list, as data, with nothing else in the module.
 *
 * This is a COPY of `INVARIANT_VIEWS` in `scripts/dbcheck.mjs` — same views,
 * same claims, same order. It has to be a copy, because `scripts/**` is not
 * part of the TypeScript program and making the gate depend on the app
 * building would be the wrong direction for that dependency to run.
 *
 * A copy is exactly the kind of thing that drifts silently, so it is held in
 * its own file with no imports, and `invariants.test.ts` reads `dbcheck.mjs`
 * off disk and asserts the two lists are identical.
 *
 * THE FAILURE THAT TEST EXISTS FOR: somebody adds a fifteenth invariant to the
 * gate, the chaos dashboard keeps checking fourteen, and the screen says ALL
 * INVARIANTS HOLD while an invariant nobody wired up is being violated in front
 * of the panel. A dashboard that checks thirteen of fourteen and reports "all"
 * is worse than one that checks none, because it is believed.
 */

/** Every view that MUST return zero rows, with the claim it makes. */
export const INVARIANT_VIEWS: readonly (readonly [string, string])[] = [
  ['v_entry_unbalanced', 'every entry sums to zero, per currency'],
  ['v_line_denorm_drift', 'denormalised clocks match their entry'],
  ['v_hold_drift', 'the memo book equals the fold over card events'],
  ['v_hold_release_drift', 'a released hold withholds nothing'],
  ['v_book_not_zero', 'the whole book nets to zero, per entity and book'],
  ['v_deposit_control_drift', 'the deposits subtree equals what we report'],
  ['v_accrual_month_drift', "a month's daily shares sum to the fee exactly"],
  ['v_accrual_ledger_drift', 'every accrual claim matches the entry it cites'],
  ['v_standing_order_double_fire', 'one occurrence, at most one payment instruction'],
  [
    'v_dispute_ledger_double_count',
    'one dispute line, one row — the episode screen counts money once',
  ],
  ['v_balance_definition_drift', 'the hold model and availability agree, at the live point'],
  ['v_interest_ledger_drift', 'every interest posting matches the entry and side it cites'],
  ['v_interest_rate_drift', 'no day has been re-priced by a rate that came later'],
  // ---- added to the gate by migration 0026's owner, while this file was
  // being written. `invariants.test.ts` is what noticed, which is the whole
  // reason it exists: the list had drifted by two inside one afternoon, and a
  // dashboard reporting "all invariants hold" over thirteen of fifteen would
  // have been believed. Both are card-hold invariants and therefore the two
  // most relevant on this screen of any in the list.
  [
    'v_refused_auth_hold',
    'no hold withholds money against an authorisation the network refused',
  ],
  [
    'v_hold_closure_not_terminal',
    'no permanent closure stands over a hold the fold says is open',
  ],
  // Migration 0025 declared this must be empty and nothing queried it for the
  // rest of the night. It is the wire rail's whole availability claim — a wire
  // is final, so its funds are available on arrival, and this is the assertion
  // that the arithmetic actually does that rather than the code merely
  // intending to.
  //
  // Added here as well as in `scripts/dbcheck.mjs` because the two lists are
  // asserted equal by this module's own test. That parity is the point: a
  // chaos dashboard checking fifteen invariants while CI checks sixteen is a
  // screen quietly claiming more coverage than it has, which is the failure
  // this build has now catalogued twenty-three times — the count is
  // reconciled in DECISIONS 058, because four documents were running four
  // different tallies, which is itself the pattern.
  [
    'v_wire_availability_drift',
    'a wire credit withholds nothing, because a wire cannot be returned',
  ],
  // 0033. Both made to fail on purpose before being trusted; the second
  // needed two triggers disabled to violate, which proves they compose.
  //
  // BOTH WIDENED BY MIGRATION 0046, with the third team view below. Each
  // resolved its subject through an INNER JOIN — to `team_member` for the
  // approval guards, to `team_member_version` for the decision guard — so a
  // principal with no membership of that business, or a decision that pinned
  // no member version, fell out of the FROM clause and was neither judged nor
  // reported. Measured by `dbcheck`'s GUARD REACH before the repair: 33 of
  // 186 approvals, 11 of 26 approved decisions, 3 of 422 member-version rows.
  // The claims below are the wider ones and the counts are now N of N.
  [
    'v_approved_auth_for_dead_member',
    "no authorisation is approved without the cardholder's terms, or under terms that were dead at the time",
  ],
  [
    'v_member_approval_without_right',
    'no approval stands from anybody but a member who held the right at the time, or Corgi staff',
  ],
  // 0031's three and 0040's one. They lived in side arrays in dbcheck.mjs
  // because the agents that added them could not write THIS file, and the two
  // lists are asserted equal below. That kept them checked and provable, which
  // was the right call under a write scope — but left permanently it would
  // mean this dashboard checking four fewer invariants than CI, which is the
  // same failure as claiming four more.
  [
    'v_interchange_unreversed',
    'no revenue stands on a settlement the network took back',
  ],
  [
    'v_interchange_drift',
    'every priced settlement carries the interchange it is now worth',
  ],
  [
    'v_interchange_rate_drift',
    'no settlement has been re-priced by a rate that came later',
  ],
  // Non-empty on arrival — 9 rows, all released, zero cents of exposure. Kept
  // rather than narrowed: v_card_auth_hold reads card_authorization.expires_at
  // and ledger_availability() reads hold.expires_at, and that they agree is a
  // convention inside one function rather than a constraint.
  [
    'v_hold_expiry_drift',
    'one card hold, one expiry instant — the two readers agree',
  ],
  // 0043's two. Both are RED ON ARRIVAL and that is deliberate: they make a
  // measured finding visible rather than absorbing it. Neither is exposure.
  //
  // The advice one exists because deriveCardEvents() had never been fuzzed —
  // docs/FUZZ.md had NAMED that gap and excused it with "it's still fuzzed as
  // what it becomes", which is not the same as fuzzing the step that decides
  // it. 4,000 generated payloads found 624 advices converted against a
  // negative base, $61,277.06 the old rule would have fabricated.
  [
    'v_advice_delta_unsound',
    'an advice is never converted against a base an authorised amount cannot take',
  ],
  [
    'v_hold_closure_unexplained',
    'no unreversed closure stands over an open authorisation the provider does not explain',
  ],
  // 0044. The closest thing to real harm found tonight: a REMOVED admin could
  // author a member's terms and mint a new approver with can_approve = true,
  // because the authority lookup filtered `AND state <> 'removed'` and then
  // treated NULL as Corgi staff.
  //
  // Widened by 0046 in the same pass: 0044's repair resolved the AUTHOR
  // through an inner LATERAL, so an author holding no membership of that
  // business produced no author row and the version left the guard entirely.
  // A security fix carrying its own defect one table over — the twenty-fifth
  // instance of this build's defining failure, and the first one found inside
  // a repair for the same failure.
  [
    'v_team_terms_by_unauthorised_author',
    "no member's terms were written by anybody but an active admin of that business, or Corgi staff",
  ],
  // 0047's one, and the FIFTH side array in `scripts/dbcheck.mjs` to be folded
  // back — always for the same cause: the agent that added it could not write
  // this file, and the gate's list is asserted equal to this one. It is the
  // first guard on this book about WHEN an entry claims to have happened
  // rather than whether it balances: 1,712 entries carried value dates that
  // cannot be real, the earliest 1606-04-01, and nothing on the system noticed
  // except a timetravel assertion going red three files from the cause.
  [
    'v_value_date_unexplained',
    'no entry carries a value date outside [entity created − 1 year, today + 18 months] that no declared writer owns',
  ],
  // 0015's four. They existed, were correct, and were checked by nothing —
  // `--prove` said "26 of 26" against a list that did not contain them.
  // Each made to fail in a rolled-back transaction before being listed.
  ['v_internal_transfer_impure', "an internal transfer touches only the customer's own subtree"],
  ['v_pot_identity_drift', 'every pot is exactly one sub-account, and nothing else lives under it'],
  ['v_pot_negative', 'no pot holds less than nothing'],
  ['v_pot_orphan', 'no pot sub-account exists without the pot that names it'],
] as const;
