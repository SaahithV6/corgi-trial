-- =====================================================================
-- 0036.  The opening whose memo posting never landed.
-- =====================================================================
--
-- WHAT WAS SEEN.  `v_hold_drift` -- empty all evening -- came back with
-- three rows at 06:0xZ, then a fourth.  Each one identical in shape:
--
--     a single `authorization 5000`, `is_final = false`, verdict NULL,
--     no `hold_closure` row, and a memo book holding NOTHING.
--
-- So the fold over the card events says $50 is authorised and the memo
-- book withholds nothing.  The drift is in the CUSTOMER'S FAVOUR, which
-- is the direction nobody complains about and therefore the direction
-- that survives longest.
--
-- THE HYPOTHESIS THAT WAS WRONG, and it is worth recording because it
-- was a good hypothesis.  `apply.ts` splits one event into two
-- transactions -- facts and closure first, the memo posting second -- and
-- the gap between them was independently measured at ~330ms.  Nine agents
-- were killed mid-execution by a session rate limit earlier the same
-- night.  A process killed inside that window commits transaction one and
-- never runs transaction two, which produces EXACTLY these rows.  It is
-- the right shape.  It is not what happened.
--
-- THREE MEASUREMENTS KILLED IT, none of them an inference:
--
--   1. `hold.external_ref`.  `ensureAuthorization()` builds it as
--      `<provider> || ':' || <provider_auth_id>`.  470 of the 474 card
--      authorisations in this database satisfy that.  The 4 that do not
--      are these, where `external_ref` EQUALS `provider_auth_id` with no
--      prefix added -- a row shape `ensureAuthorization()` cannot emit.
--      They did not come through `apply.ts` at all.
--   2. `card_auth_event_result`.  Since 0026, `recordFacts()` writes a
--      verdict row beside every fact IN THE SAME TRANSACTION as the fact
--      -- NULL when the payload carried no `result`, but a row.  A crash
--      between transaction one and transaction two would leave the
--      verdict row behind, because it is part of transaction one.  These
--      four events have no verdict row at all.
--   3. `webhook_inbox`.  No row anywhere mentions them, and every event
--      carries `inbox_id IS NULL`.  There was no delivery to crash on.
--
-- WHAT IT ACTUALLY WAS.  `src/lib/team/team.integration.test.ts` §9
-- ("removing a member leaves an outstanding authorisation untouched")
-- hand-writes a hold, a `card_authorization` and one `card_auth_event`
-- with raw SQL against the LIVE book, under its own comment "No money --
-- this suite never posts."  It is right that it posts no money; what it
-- does not do is post the MEMO entry, and the memo book is not money, it
-- is the withholding.  Every run of that test leaves one hold whose fold
-- says $50 and whose memo book says nothing.
--
-- THE MEASUREMENT THAT MATTERS MOST.  The `apply.ts` window is real and
-- it CLOSES.  Over the 474 authorisations in this book, first fact to
-- opening memo entry:
--
--     p50   342 ms          <1s    286 holds
--     p95  2102 ms          <1m     72 holds
--                           <1h      3 holds
--     never posted 113 holds, of which 112 have target_hold_cents = 0
--                            (Δ was always zero; nothing was owed)
--                            and 1 is the team-suite orphan.
--
-- So: ZERO of the 470 holds that went through `apply.ts` are drifting.
-- The transient is real, it is ~342ms, and it self-heals in process.
-- The orphan does not self-heal at all.  It resolves only when
-- `expires_at` arrives seven days later and `v_card_auth_hold.is_closed`
-- flips on the clock -- at which point `v_hold_drift`'s `WHERE NOT
-- is_released` stops matching it and the row LEAVES THE GUARD WITHOUT
-- THE MONEY EVER HAVING BEEN WITHHELD.  That is the worst kind of
-- self-healing: the evidence heals, the defect does not.
--
-- WHAT THIS MIGRATION DOES
--
--   1. Adds `v_hold_posting_incomplete`, DEFINED ON TOP OF
--      `v_hold_drift`, carrying the identity a repair needs plus the AGE
--      and the PROVENANCE an operator needs to tell a delivery in flight
--      from a hold nothing will ever finish.
--   2. Asserts that the new view's population is EXACTLY `v_hold_drift`'s
--      -- not a copy of its predicate that can drift from it.
--   3. Narrows NOTHING.  `v_hold_drift`, `v_hold_release_drift` and
--      `v_hold_closure_not_terminal` are not touched by this file.  The
--      guard stays absolute; the tolerance, where there is one, lives in
--      the SWEEPER, which is a different object with a different job.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
--   * It does not repair the live book.  `scripts/repair-0036-missing-memo.mjs`
--     does that, by calling `settleHoldPosting()` -- the compare-and-append
--     that `apply.ts` and `expiry.ts` already use -- rather than by
--     inventing a second way to move the memo book inside a DO block.
--     0032 had to use `ledger_append()` directly because it was reversing
--     entries at their original value dates and there was no TypeScript
--     path for that.  There is a TypeScript path for this one.
--   * It does not add the new view to `scripts/dbcheck.mjs`, because
--     `v_hold_posting_incomplete` is NOT an invariant -- it is a WORK
--     QUEUE, and it is legitimately non-empty for ~342ms at a time.
--     Listing it beside the views that must be empty would teach an
--     operator that a red line there is survivable, which is the habit
--     this log has spent nineteen entries trying to break.


-- ---------------------------------------------------------------------
-- 1.  The work queue
-- ---------------------------------------------------------------------
--
-- `FROM v_hold_drift d` is the load-bearing line.  The sweeper's domain
-- is the guard's domain BY CONSTRUCTION, so there is no second predicate
-- to keep in step and no way for the repair to range over less than the
-- alarm.  0023's lesson, applied at the point where it usually goes
-- wrong: the repair and the guard disagreeing about which rows exist is
-- how a green tree carries a red book.
--
-- The columns beyond the guard's three are the ones a human or a sweeper
-- needs and the guard has no business carrying:
--
--   age             how long the memo book has been behind the fold.  An
--                   operator looking at one row at 23:10 cannot tell "a
--                   suite is mid-flight" from "money is missing".  The
--                   measured in-process window is 342ms at p50 and 2.1s
--                   at p95.  Seconds means in flight; minutes means
--                   nothing is coming.
--   through_apply   did this identity come out of `ensureAuthorization()`?
--                   False means some other path wrote the rows directly,
--                   and that path is not going to post the memo entry
--                   later, because it never knew it had to.
--   from_webhook    is there a delivery behind any of these facts?  A
--                   hold with no `inbox_id` anywhere and no matching
--                   `webhook_inbox` row was not produced by a provider.

CREATE VIEW v_hold_posting_incomplete AS
SELECT d.hold_id,
       ca.id                     AS auth_id,
       ca.provider,
       ca.provider_auth_id,
       ca.origin,
       ca.expires_at,
       h.account_id,
       h.memo_account_id,
       acct.entity_id,
       d.memo_balance_cents,
       d.target_hold_cents,
       d.target_hold_cents - d.memo_balance_cents AS missing_cents,
       last_ev.provider_event_id AS last_event_id,
       last_ev.value_date        AS last_event_value_date,
       last_ev.received_at       AS last_event_at,
       now() - last_ev.received_at AS age,
       (h.external_ref = ca.provider || ':' || ca.provider_auth_id) AS through_apply,
       EXISTS (SELECT 1 FROM card_auth_event w
                WHERE w.auth_id = ca.id AND w.inbox_id IS NOT NULL)  AS from_webhook
  FROM v_hold_drift          d
  JOIN hold                  h    ON h.id    = d.hold_id
  JOIN card_authorization    ca   ON ca.hold_id = d.hold_id
  JOIN account               acct ON acct.id = h.account_id
  -- The event `apply.ts` would have keyed the posting on: the LAST member
  -- of the set under `loadCardEvents()`'s own ordering, which is what
  -- `derived.events.at(-1)` resolves to for the delivery that opened it.
  -- Keying the repair the same way means a redelivery of that payload
  -- computes Δ = 0 and appends nothing, instead of racing a second entry
  -- in beside ours.
  CROSS JOIN LATERAL (
    SELECT ev.provider_event_id, ev.value_date, ev.received_at
      FROM card_auth_event ev
     WHERE ev.auth_id = ca.id
     ORDER BY ev.received_at DESC, ev.provider_event_id DESC
     LIMIT 1
  ) last_ev;

COMMENT ON VIEW v_hold_posting_incomplete IS
  'NOT an invariant -- a WORK QUEUE, and legitimately non-empty while a delivery is in flight (measured: 342ms p50, 2.1s p95 from first fact to opening memo entry, over 474 authorisations). One row per card-auth hold whose memo book disagrees with the fold over its event set, carrying the identity settleHoldPosting() needs plus the age and provenance a human needs. Defined FROM v_hold_drift so the repair cannot range over fewer rows than the guard that reports them. Read by src/lib/holds/completion.ts and scripts/repair-0036-missing-memo.mjs. Deliberately NOT in scripts/dbcheck.mjs: v_hold_drift is the invariant and it stays absolute.';

GRANT SELECT ON v_hold_posting_incomplete TO corgi_app;


-- ---------------------------------------------------------------------
-- 2.  The domain assertion
-- ---------------------------------------------------------------------
--
-- Decision 056 ended with "make every guard state its own domain, out
-- loud, every run."  This is the same demand pointed at a REPAIR: the
-- set of holds the sweeper can act on must equal the set of holds the
-- guard can report, in both directions, or one of them is lying.
--
-- It is an equality and not an inclusion on purpose.  A sweeper that
-- reaches FEWER rows than the guard leaves money unwithheld with an
-- alarm nobody can clear.  A sweeper that reaches MORE rows than the
-- guard is moving the memo book on holds no invariant is watching, which
-- is worse: it is an unobserved write to the book.
--
-- This can fail.  It fails the day someone edits either view without the
-- other, which is the only way the two can come apart.

DO $$
DECLARE
  v_only_guard int;
  v_only_queue int;
BEGIN
  SELECT count(*) INTO v_only_guard
    FROM v_hold_drift d
   WHERE NOT EXISTS (SELECT 1 FROM v_hold_posting_incomplete q WHERE q.hold_id = d.hold_id);

  SELECT count(*) INTO v_only_queue
    FROM v_hold_posting_incomplete q
   WHERE NOT EXISTS (SELECT 1 FROM v_hold_drift d WHERE d.hold_id = q.hold_id);

  IF v_only_guard <> 0 OR v_only_queue <> 0 THEN
    RAISE EXCEPTION
      '0036 refuses to commit: the sweeper and the guard disagree about which holds exist (% only the guard sees, % only the queue sees); both must be 0',
      v_only_guard, v_only_queue;
  END IF;

  RAISE NOTICE '0036: v_hold_posting_incomplete ranges over exactly v_hold_drift (% row(s) right now)',
    (SELECT count(*) FROM v_hold_drift);
END $$;


-- ---------------------------------------------------------------------
-- 3.  What is NOT in scope, said here rather than discovered later
-- ---------------------------------------------------------------------
--
-- RELEASED holds that still withhold money -- `v_hold_release_drift` --
-- are NOT the sweeper's business, and the exclusion is a decision rather
-- than an oversight.
--
-- `settleHoldPosting()` would happily repair them: the fold says 0, the
-- memo book says N, Δ = −N, and the money goes back.  That is precisely
-- why it must not be run there automatically.  Migration 0011's bug
-- produced exactly that state, and the right repair was to reverse the
-- WRONG CLOSURE, not to post the release the closure implied.  A sweeper
-- that tidied the memo book would have made 0011's alarm go quiet while
-- leaving the false closure standing in an append-only audit table.
--
-- So: the opening direction is mechanical and is swept.  The release
-- direction requires someone to decide whether the closure or the memo
-- book is the thing that is wrong, and `scripts/repair-0011-spurious-closures.mjs`
-- is where that decision is made, one hold at a time, by a human.

COMMENT ON VIEW v_hold_release_drift IS
  'MUST BE EMPTY. A released hold that still withholds money. Added by migration 0011 as the complement to v_hold_drift, because a spurious closure sets is_released and therefore hides itself from that view. NOT repaired by the 0036 sweeper and that is deliberate: a row here means EITHER the memo posting never landed OR the closure should never have been written, and posting the release would silence the alarm without answering the question. See scripts/repair-0011-spurious-closures.mjs.';
