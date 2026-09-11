-- =====================================================================
-- 0022  ONE definition of each balance question
-- =====================================================================
--
-- WHY THIS MIGRATION EXISTS
--
-- Before it, this system had three answers to "what is available" and two
-- of them printed at the same time, on two screens, for the same account,
-- and differed by $25,040.70 (measured 2026-09-11T02:10Z; the figure was
-- $30,662.10 when the funding screen first wrote its own copy).  See
-- docs/BALANCE-DEFINITIONS.md for the full before/after table.
--
--   availableBalance()   src/lib/ledger/balances.ts     summed EVERY line,
--                        no value-date predicate at all, so the customer's
--                        available balance today included standing-order
--                        credits value-dated 2027.
--   ledgerBalanceCents() src/lib/ledger/queries.ts      value_date <= today
--                        AND booking_seq <= watermark.  Right about the
--                        ledger, but the screen built on it then subtracted
--                        uncleared-credit holds whose own credit was ALSO
--                        future-dated and therefore not in that sum -- so
--                        $3,750.00 was deducted from the customer twice.
--   readBalanceCents()   the funding screen's private third copy, written
--                        because the first two disagreed.
--   v_available_balance  a fourth, in SQL, over v_ledger_balance (no
--                        predicates) and v_hold_state (a different release
--                        predicate again).
--
-- THE SHAPE OF THE FIX
--
-- A view cannot take an argument and a balance question has three:
-- which business day, which booking watermark, and which instant.  So the
-- canonical definition is a FUNCTION, and everything else calls it:
--
--    ledger_availability(account, value_date, booking_seq, as_of)
--       |                    |
--       |                    +--> v_available_balance  (the live point)
--       +--> availableBalance() / accountAvailability() in TypeScript
--
-- There is one body.  The SQL view and the TypeScript function cannot
-- drift because neither of them contains a definition -- they contain a
-- call.  That is the v_hold_drift bargain kept by construction rather
-- than by invariant, which is strictly stronger.
--
-- v_balance_definition_drift is the invariant anyway, because the hold
-- model lives in v_hold_state and this function re-derives the same
-- release predicate at a parameterised instant.  Those two ARE separate
-- bodies, so they get held equal by a view that must return zero rows.
--
-- NOTHING HERE WRITES.  Every object in this file is a STABLE read.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The settled ledger balance:  Q1, both axes
-- ---------------------------------------------------------------------
--
-- Sigma amount_cents x normal_side over the account's lines, with
--
--     value_date  <= p_value_date    which business days count
--     booking_seq <= p_booking_seq   what we had learned by then
--
-- and nothing else.  Both predicates are load-bearing and they are
-- independent: holding the value date still and moving the watermark is
-- "what did we believe on Wednesday"; holding the watermark still and
-- moving the value date is "what does the ledger say about Tuesday".
--
-- FUTURE-DATED ENTRIES ARE EXCLUDED, and that is the whole argument of
-- this migration in one predicate.  A settlement booked today for
-- tomorrow's business day is a fact we know.  It is not money the
-- customer has today, and a customer cannot spend tomorrow's settlement
-- today.  See section 3 for what happens to a future-dated DEBIT, which
-- is the asymmetry that makes this safe rather than merely tidy.
--
-- NULL value: an account with no lines returns 0, not NULL.  "No rows"
-- and "zero" are different answers and only one of them is true.

CREATE OR REPLACE FUNCTION ledger_settled_cents(
  p_account     uuid,
  p_value_date  date,
  p_booking_seq bigint
) RETURNS bigint
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
           SELECT SUM(l.amount_cents)
             FROM journal_line l
            WHERE l.account_id  = a.id
              AND l.value_date  <= p_value_date
              AND l.booking_seq <= p_booking_seq
         ), 0)::bigint * a.normal_side
    FROM account a
   WHERE a.id = p_account
$$;

COMMENT ON FUNCTION ledger_settled_cents(uuid, date, bigint) IS
  'Q1. The settled ledger balance at a value date and a booking watermark. '
  'Future-dated entries excluded. This is the bitemporal claim; every other '
  'balance question in this system is built on top of it.';


-- ---------------------------------------------------------------------
-- 2.  Availability:  Q2
-- ---------------------------------------------------------------------
--
--   available = settled ledger
--             - active holds          (card authorisations, manual holds)
--             - active uncleared credits
--             - committed future-dated debits
--
-- FOUR DECISIONS ARE WRITTEN INTO THIS BODY.  Each one moved a real
-- figure; all four are argued in docs/BALANCE-DEFINITIONS.md.
--
-- (a) THE LEDGER TERM IS THE SETTLED ONE.  Not "every line".  A credit
--     value-dated 2027 is not spendable in 2026.
--
-- (b) A FUTURE-DATED DEBIT IS SUBTRACTED ANYWAY.  This is deliberately
--     NOT symmetric with (a), and prudence is the reason: money already
--     booked to leave the account has been committed, and the customer
--     must not be able to spend it twice in the window before it
--     settles.  An outbound ACH originated today for tomorrow is gone
--     as far as the customer's spending power is concerned, even though
--     the ledger will not move until tomorrow.  This term is a DERIVED
--     hold -- it needs no hold row because the journal entry is already
--     there, and it therefore cannot be double-counted against a memo
--     hold, which lives in the other book.
--
-- (c) A HOLD ONLY WITHHOLDS FROM ITS OWN VALUE DATE.  h.value_date >
--     p_value_date means the hold guards a credit that is not in the
--     ledger term yet either.  Deducting it would charge the customer
--     for the same dollar twice: once by leaving the credit out of (a),
--     and again by subtracting the hold.  Measured at $3,750.00 on the
--     demo account, printed on the funding screen, before this line.
--
-- (d) MANUAL HOLDS COUNT.  availableBalance() bucketed 'card_auth' and
--     'uncleared_credit' and silently dropped 'manual' -- an operator
--     hold that freed the money it was placed to withhold.  $0.00 in
--     this database today, which is exactly why it survived.
--
-- THE RELEASE PREDICATE is v_hold_state's, re-derived here at the
-- parameterised instant rather than at now(), because a balance "as we
-- believed it on Wednesday" must use Wednesday's view of which holds
-- were live.  The closure row is checked WITH its reversal (migration
-- 0011); the card model is a fold over the event SET and never a
-- provider status field (DECISIONS 006); the clock closes an uncleared
-- credit with no cron required.
--
-- Sign: memo balances are read x normal_side, so a hold is a POSITIVE
-- number of cents withheld.  availableBalance() used ABS() on the raw
-- sum, which gets the same answer for a well-formed hold and silently
-- turns a malformed one into MORE withheld money rather than less.

CREATE OR REPLACE FUNCTION ledger_availability(
  p_account     uuid,
  p_value_date  date,
  p_booking_seq bigint,
  p_as_of       timestamptz
) RETURNS TABLE (
  ledger_cents           bigint,
  hold_cents             bigint,
  uncleared_cents        bigint,
  pending_outbound_cents bigint,
  available_cents        bigint
)
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
AS $$
  WITH held AS (
    SELECT h.id, h.kind, h.value_date, h.expires_at, h.available_at,
           h.memo_account_id
      FROM hold h
     WHERE h.account_id = p_account
  ),
  -- What the memo book says this hold is worth, as at the watermark.
  -- Restricted to the hold's OWN memo account: the 9900 contra leg is
  -- in the same balanced entry and summing both gives zero, always.
  memo AS (
    SELECT held.id AS hold_id,
           COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS memo_cents
      FROM held
      LEFT JOIN journal_entry e ON e.hold_id = held.id
                               AND e.booking_seq <= p_booking_seq
      LEFT JOIN journal_line  l ON l.entry_id = e.id
                               AND l.account_id = held.memo_account_id
      LEFT JOIN account       a ON a.id = l.account_id
     GROUP BY held.id
  ),
  -- A(E) and the closure flags, folded over the event SET as at p_as_of.
  fold AS (
    SELECT held.id AS hold_id,
           count(ev.id) AS event_count,
           COALESCE(SUM(ev.amount_cents) FILTER (
             WHERE ev.kind IN ('authorization','incremental_authorization')), 0)::bigint
         - COALESCE(SUM(ev.amount_cents) FILTER (
             WHERE ev.kind = 'authorization_reversal'), 0)::bigint      AS auth_net_cents,
           COALESCE(bool_or(ev.is_final), false)                        AS saw_final,
           COALESCE(bool_or(ev.kind IN ('expiry','close')), false)      AS saw_close
      FROM held
      LEFT JOIN card_authorization ca ON ca.hold_id = held.id
      LEFT JOIN card_auth_event    ev ON ev.auth_id = ca.id
                                     AND ev.received_at <= p_as_of
     GROUP BY held.id
  ),
  live AS (
    SELECT held.kind, memo.memo_cents
      FROM held
      JOIN memo ON memo.hold_id = held.id
      JOIN fold ON fold.hold_id = held.id
     WHERE held.value_date <= p_value_date          -- (c)
       AND NOT (
             -- closure row, less its reversal (0011)
             EXISTS (SELECT 1 FROM hold_closure hc
                      WHERE hc.hold_id = held.id
                        AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal hr
                                         WHERE hr.hold_id = hc.hold_id))
             -- the card model: four ways to be closed, none of them a status
          OR (held.kind = 'card_auth' AND (
                   fold.saw_final
                OR fold.saw_close
                OR p_as_of >= held.expires_at
                OR (fold.event_count > 0 AND fold.auth_net_cents <= 0)))
             -- the clock, for an uncleared credit
          OR (held.kind = 'uncleared_credit' AND p_as_of >= held.available_at)
           )
  ),
  -- (b) Committed future-dated debits, netted per ENTRY so that an entry
  -- touching this account twice is one commitment and not two.
  future AS (
    SELECT e.id, SUM(l.amount_cents * a.normal_side)::bigint AS delta_cents
      FROM journal_line  l
      JOIN journal_entry e ON e.id = l.entry_id
      JOIN account       a ON a.id = l.account_id
     WHERE l.account_id  = p_account
       AND l.value_date  > p_value_date
       AND l.booking_seq <= p_booking_seq
     GROUP BY e.id
  ),
  parts AS (
    SELECT ledger_settled_cents(p_account, p_value_date, p_booking_seq)   AS ledger_cents,
           COALESCE((SELECT SUM(memo_cents) FROM live
                      WHERE kind <> 'uncleared_credit'), 0)::bigint       AS hold_cents,
           COALESCE((SELECT SUM(memo_cents) FROM live
                      WHERE kind =  'uncleared_credit'), 0)::bigint       AS uncleared_cents,
           COALESCE((SELECT -SUM(delta_cents) FROM future
                      WHERE delta_cents < 0), 0)::bigint                  AS pending_outbound_cents
  )
  SELECT parts.ledger_cents,
         parts.hold_cents,
         parts.uncleared_cents,
         parts.pending_outbound_cents,
         -- Deliberately allowed to go negative. An over-captured
         -- fuel-pump authorisation settles above the amount authorised
         -- and the honest answer is that the customer is overdrawn;
         -- clamping here would hide a real overdraft behind a floor.
         (parts.ledger_cents
            - parts.hold_cents
            - parts.uncleared_cents
            - parts.pending_outbound_cents)::bigint AS available_cents
    FROM parts
$$;

COMMENT ON FUNCTION ledger_availability(uuid, date, bigint, timestamptz) IS
  'Q2. available = settled ledger - active holds - uncleared credits - '
  'committed future-dated debits, at a value date, a booking watermark and an '
  'instant. The ONE definition: v_available_balance and the TypeScript '
  'availableBalance() are both calls to this body, not copies of it.';


-- ---------------------------------------------------------------------
-- 3.  The view is a CALL, not a copy
-- ---------------------------------------------------------------------
--
-- CREATE OR REPLACE keeps the first five columns and their types, so
-- every existing grant and every dependent object survives.  What
-- changed is what they MEAN, and both changes are corrections:
--
--   ledger_balance_cents  was v_ledger_balance (every line, both axes
--                         open).  Is now the settled balance at today's
--                         business day and the live watermark.
--   active_holds_cents    was Sigma v_hold_state.active_hold_cents for
--                         every hold on the account regardless of its
--                         value date.  Is now the same sum restricted
--                         to holds whose value date has arrived, and it
--                         no longer includes uncleared credits, which
--                         have their own column now.
--
-- The live point is (book_date(now()), the highest booking_seq recorded
-- by now(), now()) -- the same three numbers readSnapshot() takes in
-- TypeScript, from the same functions.

CREATE OR REPLACE VIEW v_available_balance AS
SELECT a.id                             AS account_id,
       a.business_id                    AS business_id,
       av.ledger_cents::numeric         AS ledger_balance_cents,
       (av.hold_cents + av.uncleared_cents)::numeric AS active_holds_cents,
       av.available_cents::numeric      AS available_cents,
       -- appended: the decomposition the old five columns could not carry
       av.hold_cents::numeric           AS card_hold_cents,
       av.uncleared_cents::numeric      AS uncleared_credit_cents,
       av.pending_outbound_cents::numeric AS pending_outbound_cents,
       pt.value_date                    AS value_date,
       pt.booking_seq                   AS booking_watermark
  FROM account a
  CROSS JOIN LATERAL (
    -- THE LIVE POINT, and the one line in this file most likely to be
    -- "tidied" into a bug.
    --
    -- clock_timestamp(), not now().  Inside a transaction now() is the
    -- transaction's START, and ledger_append() stamps booking_time from
    -- clock_timestamp() -- so a watermark of
    -- "MAX(booking_seq) WHERE booking_time <= now()" read inside the same
    -- transaction that just posted an entry EXCLUDES that entry, and the
    -- balance comes back as though the posting had not happened.  Every
    -- funds check that runs in the same transaction as its posting --
    -- standing orders, pot transfers -- reads this shape.
    --
    -- The live watermark therefore has no time predicate at all: MVCC
    -- already decides what this transaction can see, and MAX over that is
    -- exactly "everything we have learned".  The time predicate belongs on
    -- the HISTORICAL watermark (bookingWatermarkAt), where it is the whole
    -- point.
    SELECT book_date(clock_timestamp()) AS value_date,
           COALESCE((SELECT MAX(e.booking_seq) FROM journal_entry e), 0)::bigint
                                        AS booking_seq,
           clock_timestamp()            AS as_of
  ) pt
  CROSS JOIN LATERAL ledger_availability(a.id, pt.value_date, pt.booking_seq, pt.as_of) av
 WHERE a.book = 'financial'
   AND a.business_id IS NOT NULL
   AND a.code = '2100';


-- ---------------------------------------------------------------------
-- 4.  The invariant:  the hold model and availability, held equal
-- ---------------------------------------------------------------------
--
-- v_hold_drift holds the memo book and the card-event fold equal.  This
-- is its counterpart one level up: the hold terms of
-- ledger_availability() must equal v_hold_state's own answer, at the
-- live point, for every customer deposit account.
--
-- They are genuinely separate bodies -- v_hold_state evaluates its
-- release predicate at now() and this function evaluates it at a
-- parameter -- so an edit to either that changes what "released" means
-- makes this view non-empty.  The one difference that is INTENDED is
-- the value-date gate, so it is applied to both sides here rather than
-- excused in prose.
--
-- MUST RETURN ZERO ROWS.  Nothing repairs what it reports.  A row here
-- is a bug in the posting path or in one of the two predicates, never a
-- number to overwrite.

CREATE OR REPLACE VIEW v_balance_definition_drift AS
SELECT ab.account_id,
       ab.active_holds_cents                       AS availability_says,
       COALESCE(hs.held_cents, 0)::numeric         AS hold_state_says,
       ab.available_cents                          AS available_cents,
       (ab.ledger_balance_cents
          - ab.active_holds_cents
          - ab.pending_outbound_cents)             AS available_recomputed
  FROM v_available_balance ab
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(s.active_hold_cents), 0)::numeric AS held_cents
      FROM v_hold_state s
      JOIN hold h ON h.id = s.hold_id
     WHERE s.account_id = ab.account_id
       AND h.value_date <= book_date(clock_timestamp())
  ) hs ON true
 WHERE ab.active_holds_cents <> COALESCE(hs.held_cents, 0)
    OR ab.available_cents <> (ab.ledger_balance_cents
                                - ab.active_holds_cents
                                - ab.pending_outbound_cents);


-- ---------------------------------------------------------------------
-- 5.  Grants.  Reads only -- there is nothing here to write.
-- ---------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION ledger_settled_cents(uuid, date, bigint)             TO corgi_app;
GRANT EXECUTE ON FUNCTION ledger_availability(uuid, date, bigint, timestamptz) TO corgi_app;
GRANT SELECT  ON v_balance_definition_drift                                    TO corgi_app;
