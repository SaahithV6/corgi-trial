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
  // 0052's one — the structural pot guard, and the reason the four above are
  // not it. Each of them compares a BALANCE (identity drift, negative), a fact
  // about the CHART (orphan), or a shape over a population the writer selected
  // ITSELF into (impure: `rail = 'internal' AND idempotency_key LIKE 'pot:%'`).
  // A pot line written by the wrong writer for the right amount passes all
  // four — measured, not supposed: docs/POTS.md §10.3 moved $50.00 out of a pot
  // into `1000 Cash at bank` under an `ach:` key and impure, identity drift and
  // deposit-control drift all stayed at 0.
  //
  // This one keys on `journal_line.account_id IN (SELECT account_id FROM pot)`,
  // a fact about the chart rather than a label, so the only way out of its
  // population is to not touch a pot account. Mirrored here in the same pass
  // that added it to `scripts/dbcheck.mjs` — the two lists are asserted equal
  // by this module's own test, and a sixth side array was not going to be the
  // thing this file finally tolerated.
  [
    'v_pot_line_provenance',
    'every journal line on a pot account is traceable to a pot operation',
  ],
  // 0054's two — 0052's finding generalised past the pot table. Every one
  // of the thirty-one views above was read as SQL rather than as its own
  // summary and classified in docs/INVARIANTS.md: fifteen turn on a
  // quantity, and eleven of those fifteen are dodgeable, each dodge
  // constructed against the live book in a transaction that was rolled
  // back. These close the worst two.
  //
  // The deposit one is the serious one. `v_deposit_control_drift` is the
  // ONLY invariant over the whole customer deposit subtree, and both of
  // its sides count the same accounts — so a movement inside that subtree
  // moves both equally and the difference stays zero for ANY amount.
  // $250,000.00 was moved from one customer's `2100` to another's and nine
  // balance guards stayed green, this dashboard's among them. The memo one
  // is the same defect one book over: `v_hold_state` folds only
  // `l.account_id = h.memo_account_id`, so $85,000.00 of withholding
  // parked on a different customer's memo account appears in neither side
  // of v_hold_drift's comparison.
  //
  // Mirrored here in the same pass that added them to `scripts/dbcheck.mjs`
  // — the two lists are asserted identical by this module's own test, and a
  // side array is how five previous additions quietly dropped out of
  // `--prove`.
  [
    'v_deposit_cross_customer',
    'no single entry moves money between two customers, or onto the house control account',
  ],
  [
    'v_memo_line_placement',
    'every memo line lies where the hold it names says it does',
  ],
  // 0055's one — hole 1, which 0054 ranked as the largest thing it left
  // open: a customer's money moved out to a house account that is not the
  // `2100` control. One customer, one entry, so `v_deposit_cross_customer`
  // passes it. $500,000.00 moved to house `1000 Cash at bank` and twelve
  // guards stayed green.
  //
  // The near miss is the part worth keeping: `1000` receives no real
  // traffic, so a whitelist of the ten house accounts that do would have
  // caught that probe and shipped green. The identical theft one account
  // over — into `1110`, which 145 legitimate entries use — walks through
  // any such whitelist. A legitimate payout and a theft are THE SAME
  // TRANSACTION; the difference is not in the money, it is in whether an
  // instruction exists. So the guard asks for provenance and ranks the
  // anchors: an FK citation (unfakeable), a retained webhook, a declared
  // fixture, or `external_ref` alone — which is a label, and is named the
  // weakest anchor wherever it appears. It catches a writer that forgot,
  // not an attacker that lied; the attacker-resistant form is red at 406
  // and left for a RED_REGISTER argument in docs/INVARIANTS.md.
  //
  // Mirrored here in the same pass that added it to `scripts/dbcheck.mjs`.
  [
    'v_deposit_outflow_unexplained',
    'customer money never leaves for a house account with nothing saying anybody asked',
  ],
  // 0053/0054's FX commitment guard, built by the agent that owns
  // `src/lib/fx/**` and wired in here because that agent can write
  // neither this file nor `scripts/dbcheck.mjs`.
  //
  // Accepting an FX quote used to reserve nothing: two acceptances of
  // $21,308.95 each against $35,514.93 available left availability
  // unmoved and the payout gate cleared both. The repair places an
  // ordinary `manual` hold through the existing hold model — no second
  // definition of availability, which is the constraint that matters.
  //
  // Its population is acceptances at or after
  // `fx_commitment_regime.effective_from`; the 35 that predate it hold
  // nothing. That watermark was attacked before this entry was written —
  // UPDATE, DELETE, TRUNCATE and a second regime row, as the app role and
  // as the owner, eight attempts, all refused — so the boundary cannot be
  // walked forward to empty the guard.
  //
  // Green today over an EMPTY population (0 standing of 35 acceptances),
  // which dbcheck's GUARD REACH prints as EMPTY rather than as evidence.
  [
    'v_fx_commitment_unheld',
    'every standing FX commitment withholds exactly the price it committed',
  ],
  [
    // 0061's. An approved payment withholds what it will pay, from the moment
    // the second approver signs rather than from the moment it leaves.
    'v_payment_release_unheld',
    'every approved, unreleased payment withholds exactly what it will pay',
  ],
  // 0056's one — the far side of a threshold. `v_advice_delta_unsound`
  // asks whether an advice's implied base is BELOW ZERO; 12 of the 13
  // advices on this book have a base of zero or more and were never
  // questioned again by any view. The base is not merely supposed to be
  // non-negative — it is supposed to be the authorisation's own net
  // immediately before the event, which is one number computed from rows
  // rather than a tolerance.
  //
  // Deliberately scoped: the negative-base and missing-payload arms stay
  // with 0043's guard, which is red on the single row they cover. Firing
  // here too would put one defect on the board twice and take the failure
  // count to five while the number of findings stayed at four. The
  // migration asserts at commit that the declining guard's owner still
  // reports every row it declines.
  [
    'v_advice_base_drift',
    "an advice's stored delta reconstructs the authorisation net that stood before it",
  ],
  // 0057's third state, and the first invariant on this book that reads the
  // CATALOGUE rather than the money.
  //
  // Every view above asks a question about rows. This one asks whether the
  // guard that PREVENTS a row is still switched on. 0057 shipped the first
  // prevention on this build — a DEFERRABLE INITIALLY DEFERRED constraint
  // trigger refusing any transaction that leaves a pot below zero — and a
  // prevention has a failure mode detection does not: it can be turned off,
  // and a view over the money goes on reading green while it is.
  //
  // The three ways past it are owner-level (`DISABLE TRIGGER`,
  // `session_replication_role = replica`, dropping it) and `corgi_app` can do
  // none of them. What is not acceptable is for one to happen silently, so
  // this reads `pg_trigger` and reports DISABLED / REPLICA ONLY / ABSENT —
  // the last arm being a NOT EXISTS, because a view that only inspects rows it
  // finds cannot report a trigger somebody dropped.
  //
  // It does NOT retire `v_pot_negative` above. Prevention and detection are
  // not substitutes: the trigger refuses the write, `v_pot_negative` says so
  // if the refusal ever stopped working, and this one says so if the refusal
  // was switched off rather than defeated.
  //
  // Mirrored here in the same pass that added it to `scripts/dbcheck.mjs`; the
  // two lists are asserted equal by this module's own test.
  [
    'v_pot_guard_disarmed',
    'the 0057 negative-pot guard is present and armed for ordinary writes',
  ],
  // 0059's, and the first invariant on this list that ranges over a
  // DOCUMENT rather than over money.
  //
  // The brief's item 7 — "a closed day's statement is reproducible
  // forever, corrections included, identical every time" — had no gated
  // view before this one. The design supports it (append-only
  // `statement`, a correction is a new version, and the content hash's
  // preimage is exactly (format, account, period, watermark)) and nothing
  // executed it.
  //
  // It does NOT recompute the hash: that has one definition, in
  // `src/lib/statements/render.ts`, and a second in SQL would be the
  // defect 0022 exists to have ended. It re-derives the RECTANGLE the
  // hash is taken over — opening balance, line count, closing balance,
  // from the journal at each statement's own stored watermark — because a
  // moved rectangle is a moved preimage, and then nothing can reproduce.
  // The bytes half lives with the renderer, in
  // `src/lib/statements/statements.integration.test.ts`.
  //
  // Mirrored here in the same pass that added it to `scripts/dbcheck.mjs`;
  // the two lists are asserted equal by this module's own test.
  [
    'v_statement_content_drift',
    'a published statement still re-derives, figure for figure, from the book at the watermark it pinned',
  ],
] as const;
