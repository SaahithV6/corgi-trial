-- =====================================================================
-- Corgi work trial - Track 3 - the hard queries (draft)
--
-- Every query here is deliberately boring: SUMs, joins, and one CASE.
-- If a query needed a window function or a recursive CTE to explain a
-- customer's balance, the schema would be wrong.
--
-- Bind parameters are written :like_this.
--   :account            uuid    a customer's 2100/<business_id> account
--   :as_of_value_date   date    the VALUE axis  - which business days count
--   :as_of_booking_seq  bigint  the BOOKING axis - what we knew by then
--   :now                timestamptz  injected, never called inline, so that
--                       time-based hold releases are deterministic in tests
-- =====================================================================


-- =====================================================================
-- 1.  LEDGER BALANCE AS OF A VALUE DATE
-- =====================================================================
-- "What is this account's booked balance for business day D, using
--  everything we know today?"
--
-- Note the sign handling: lines are stored debit-positive / credit-
-- negative, and a customer deposit account is a LIABILITY of the bank
-- (credit-normal, normal_side = -1).  Multiplying by normal_side turns
-- the raw sum into the number a customer expects to see: a customer with
-- $100 has lines summing to -10000 and a balance of +10000.

SELECT COALESCE(SUM(l.amount_cents), 0) * a.normal_side AS balance_cents
  FROM journal_line l
  JOIN account a ON a.id = l.account_id
 WHERE l.account_id = :account
   AND l.value_date <= :as_of_value_date
 GROUP BY a.normal_side;

-- Index used: journal_line (account_id, value_date, booking_seq)
--             INCLUDE (amount_cents)  ->  index-only scan, no heap access.


-- Same thing for every customer at once (the daily position report):
SELECT a.business_id,
       COALESCE(SUM(l.amount_cents), 0) * a.normal_side AS balance_cents
  FROM account a
  LEFT JOIN journal_line l
         ON l.account_id = a.id
        AND l.value_date <= :as_of_value_date
 WHERE a.code = '2100' AND a.business_id IS NOT NULL
 GROUP BY a.business_id, a.normal_side
 ORDER BY a.business_id;


-- =====================================================================
-- 2.  AVAILABLE BALANCE, NOW
-- =====================================================================
-- available = ledger - active holds.
--
-- Written out in full rather than as SELECT * FROM v_available_balance,
-- because the point of the requirement is that the number is DERIVED and
-- there is nothing else to look at.  There is no available_balance
-- column in this schema.  There is no balance column at all.
--
-- A hold contributes its memo balance unless it is released, and
-- "released" is a predicate over events and the clock:
--   * card auth   -> the network said final / close, or the auth is fully
--                    reversed, or the clock passed expires_at
--   * uncleared   -> the clock passed available_at, or the credit was
--                    returned (a hold_closure row)
--   * manual      -> a hold_closure row
-- Because the predicate zeroes the term, the physical release posting is
-- bookkeeping: if the release job never runs, this number is still right.

WITH ledger AS (
  SELECT COALESCE(SUM(l.amount_cents), 0) * a.normal_side AS ledger_cents
    FROM journal_line l
    JOIN account a ON a.id = l.account_id
   WHERE l.account_id = :account
     AND l.value_date <= (:now AT TIME ZONE 'America/New_York')::date
   GROUP BY a.normal_side
),
hold_balances AS (
  -- what the memo book currently says each hold is worth
  SELECT h.id AS hold_id,
         h.kind,
         h.expires_at,
         h.available_at,
         COALESCE(SUM(l.amount_cents * a.normal_side), 0) AS memo_cents
    FROM hold h
    LEFT JOIN journal_entry e ON e.hold_id = h.id
    LEFT JOIN journal_line  l ON l.entry_id = e.id AND l.account_id = h.memo_account_id
    LEFT JOIN account       a ON a.id = l.account_id
   WHERE h.account_id = :account
   GROUP BY h.id, h.kind, h.expires_at, h.available_at
),
released AS (
  -- the release predicate, per hold kind
  SELECT hb.hold_id,
         hb.memo_cents,
         ( EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = hb.hold_id)
           OR (hb.kind = 'card_auth' AND (
                  :now >= hb.expires_at
                  OR EXISTS (SELECT 1 FROM card_auth_event ev
                              JOIN card_authorization ca ON ca.id = ev.auth_id
                             WHERE ca.hold_id = hb.hold_id
                               AND (ev.is_final OR ev.kind IN ('expiry','close')))
                  OR COALESCE((SELECT ch.auth_net_cents <= 0 AND ch.event_count > 0
                                 FROM v_card_auth_hold ch
                                WHERE ch.hold_id = hb.hold_id), false)))
           OR (hb.kind = 'uncleared_credit' AND :now >= hb.available_at)
         ) AS is_released
    FROM hold_balances hb
),
active AS (
  SELECT COALESCE(SUM(CASE WHEN is_released THEN 0 ELSE memo_cents END), 0) AS holds_cents
    FROM released
)
SELECT l.ledger_cents,
       a.holds_cents,
       l.ledger_cents - a.holds_cents AS available_cents
  FROM ledger l CROSS JOIN active a;

-- The itemised version, which is what the "why is my available balance
-- lower than my balance?" screen renders:
SELECT hs.hold_id, hs.kind, hs.external_ref, hs.value_date,
       hs.memo_balance_cents, hs.is_released, hs.active_hold_cents
  FROM v_hold_state hs
 WHERE hs.account_id = :account
   AND hs.active_hold_cents <> 0
 ORDER BY hs.value_date, hs.hold_id;


-- =====================================================================
-- 3.  THE BITEMPORAL PROOF
--     "What did we believe on Wednesday about Tuesday?"
-- =====================================================================
-- Both axes, two predicates.  This is the whole model:
--
--     value_date  <= :as_of_value_date     -- which business days count
--     booking_seq <= :as_of_booking_seq    -- what we had learned by then
--
-- The query returns a lower-left rectangle in the (value, booking) plane.
-- Fix the booking axis and vary value -> statements.  Fix the value axis
-- and vary booking -> the audit answer nobody else can produce.

SELECT COALESCE(SUM(l.amount_cents), 0) * a.normal_side AS balance_cents
  FROM journal_line l
  JOIN account a ON a.id = l.account_id
 WHERE l.account_id = :account
   AND l.value_date  <= :as_of_value_date
   AND l.booking_seq <= :as_of_booking_seq
 GROUP BY a.normal_side;


-- Getting the booking watermark for a human-readable instant.  Wall-clock
-- times are for humans; booking_seq is the real key, and it is monotonic
-- because it is drawn under the ledger append lock (see ledger_append).
SELECT COALESCE(MAX(e.booking_seq), 0) AS watermark
  FROM journal_entry e
 WHERE e.entity_id = :entity
   AND e.booking_time <= :as_of_instant;


-- The side-by-side that answers the brief's exact scenario.  A merchant
-- settles $200 with Tuesday's value date; on Thursday they reverse it and
-- the reversal is booked with TUESDAY's value date and Thursday's booking
-- position.  Row 1 shows what we told the customer on Wednesday; row 2
-- shows Tuesday as it stands today.  Both are true, and we can prove both.
WITH watermark_wed AS (
  SELECT COALESCE(MAX(booking_seq), 0) AS seq
    FROM journal_entry
   WHERE entity_id = :entity
     -- end of Wednesday in book time = Tuesday + 2 days at 00:00 ET
     AND booking_time < ((:tuesday::date + 2)::timestamp AT TIME ZONE 'America/New_York')
)
SELECT 'as we believed on Wednesday' AS vantage,
       COALESCE(SUM(l.amount_cents), 0) * a.normal_side AS tuesday_balance_cents
  FROM journal_line l
  JOIN account a ON a.id = l.account_id
 CROSS JOIN watermark_wed w
 WHERE l.account_id = :account
   AND l.value_date  <= :tuesday
   AND l.booking_seq <= w.seq
 GROUP BY a.normal_side

UNION ALL

SELECT 'as we believe today',
       COALESCE(SUM(l.amount_cents), 0) * a.normal_side
  FROM journal_line l
  JOIN account a ON a.id = l.account_id
 WHERE l.account_id = :account
   AND l.value_date <= :tuesday
 GROUP BY a.normal_side;


-- The audit trail behind the difference: the original, its reversal, and
-- the re-book, as one story.  Note reversal.value_date = original.value_date
-- (the correction lands on the day it happened) while the booking
-- positions differ (we learned it later).
SELECT e.booking_seq,
       e.value_date,
       e.booking_time,
       e.entry_type,
       e.reverses_entry_id,
       e.description,
       SUM(l.amount_cents) FILTER (WHERE l.account_id = :account) AS customer_line_cents
  FROM journal_entry e
  JOIN journal_line  l ON l.entry_id = e.id
 WHERE e.correction_group_id = (
         SELECT correction_group_id FROM journal_entry WHERE id = :original_entry)
 GROUP BY e.id, e.booking_seq, e.value_date, e.booking_time,
          e.entry_type, e.reverses_entry_id, e.description
 ORDER BY e.booking_seq;


-- =====================================================================
-- 4.  A REPRODUCIBLE CLOSED-DAY STATEMENT
-- =====================================================================
-- A statement is a (period, booking watermark) pair, NOT a period.
-- Pinning the watermark is what makes it byte-identical forever, and
-- issuing a new VERSION at a later watermark is what makes Tuesday show
-- the correction.  Both requirements, no contradiction.
--
-- Deterministic ordering is (value_date, booking_seq, ordinal), which is a
-- total order: booking_seq is unique per entry and ordinal is unique
-- within an entry.  Without a total order the content hash would not be
-- stable and "identical every time" would be a coin flip.

-- 4a. Opening balance: everything strictly before the period, as known at
--     the watermark.
SELECT COALESCE(SUM(l.amount_cents), 0) * a.normal_side AS opening_balance_cents
  FROM journal_line l
  JOIN account a ON a.id = l.account_id
 WHERE l.account_id = :account
   AND l.value_date  <  :period_start
   AND l.booking_seq <= :watermark
 GROUP BY a.normal_side;

-- 4b. The activity, with a running balance.
WITH lines AS (
  SELECT e.value_date,
         e.booking_seq,
         l.ordinal,
         e.entry_type,
         e.description,
         e.external_ref,
         l.amount_cents * a.normal_side AS signed_cents,  -- + = money in for the customer
         e.booking_time
    FROM journal_line  l
    JOIN journal_entry e ON e.id = l.entry_id
    JOIN account       a ON a.id = l.account_id
   WHERE l.account_id = :account
     AND l.value_date BETWEEN :period_start AND :period_end
     AND l.booking_seq <= :watermark
),
opening AS (
  SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0) AS cents
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.account_id = :account
     AND l.value_date  <  :period_start
     AND l.booking_seq <= :watermark
)
SELECT ln.value_date,
       ln.booking_time,
       ln.entry_type,          -- 'reversal' rows are the corrections, shown not hidden
       ln.description,
       ln.external_ref,
       ln.signed_cents,
       (SELECT cents FROM opening)
         + SUM(ln.signed_cents) OVER (ORDER BY ln.value_date, ln.booking_seq, ln.ordinal
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
         AS running_balance_cents
  FROM lines ln
 ORDER BY ln.value_date, ln.booking_seq, ln.ordinal;

-- 4c. The content hash.  Recomputing this for the same (account, period,
--     watermark) must reproduce statement.content_hash, forever.  If it
--     ever does not, either a money row changed - impossible, see the
--     REVOKEs and the hash chain - or the renderer changed, which is a
--     versioned artefact and a deployment question, not a ledger question.
SELECT digest(
         convert_to(
           :account::text || '|' || :period_start::text || '|' ||
           :period_end::text || '|' || :watermark::text || '|' ||
           COALESCE(string_agg(
             format('%s:%s:%s:%s', l.value_date, l.booking_seq, l.ordinal,
                    l.amount_cents * a.normal_side),
             '|' ORDER BY l.value_date, l.booking_seq, l.ordinal), ''),
           'UTF8'),
         'sha256') AS content_hash
  FROM journal_line l
  JOIN account a ON a.id = l.account_id
 WHERE l.account_id = :account
   AND l.value_date BETWEEN :period_start AND :period_end
   AND l.booking_seq <= :watermark;

-- 4d. Which version of a period's statement is current, and what changed
--     between versions (this is the "corrected statement" story):
SELECT version, booking_watermark, opening_balance_cents,
       closing_balance_cents, line_count, encode(content_hash, 'hex') AS hash,
       generated_at
  FROM statement
 WHERE account_id = :account
   AND period_start = :period_start AND period_end = :period_end
 ORDER BY version;

-- 4e. The entries that forced a new version: value date inside the closed
--     period, booking position after the previous version's watermark.
SELECT e.id, e.value_date, e.booking_seq, e.entry_type, e.description
  FROM journal_entry e
  JOIN journal_line l ON l.entry_id = e.id
 WHERE l.account_id = :account
   AND e.value_date BETWEEN :period_start AND :period_end
   AND e.booking_seq > :previous_version_watermark
 ORDER BY e.booking_seq;


-- =====================================================================
-- 5.  RECONCILIATION BREAKS, WITH AGING
-- =====================================================================
-- Breaks are computed, never stored, so they cannot go stale.  Aging is
-- measured from the VALUE DATE, so a break's age is a fact about the
-- business day and not about when someone last ran a job.
--
-- The three categories, for one imported file (:file_id):

-- 5a. IN FILE, NOT IN LEDGER
--     The network says it happened and we have no entry.  Usually a
--     webhook that never arrived or failed processing; sometimes a
--     genuine force post we have not booked yet.
SELECT 'in_file_not_ledger'              AS break_kind,
       r.id                              AS break_key,
       r.external_ref,
       r.value_date,
       r.amount_cents                    AS file_amount_cents,
       NULL::bigint                      AS ledger_amount_cents,
       r.amount_cents                    AS break_amount_cents,
       (:today - r.value_date)           AS age_days,
       CASE
         WHEN (:today - r.value_date) <=  1 THEN '0-1'
         WHEN (:today - r.value_date) <=  3 THEN '2-3'
         WHEN (:today - r.value_date) <=  7 THEN '4-7'
         WHEN (:today - r.value_date) <= 30 THEN '8-30'
         ELSE '31+'
       END                               AS age_bucket
  FROM scheme_file_row r
  LEFT JOIN recon_match m ON m.file_row_id = r.id
 WHERE r.file_id = :file_id
   AND m.id IS NULL

UNION ALL

-- 5b. IN LEDGER, NOT IN FILE
--     We booked something the network does not have.  A duplicate
--     posting, or a timing difference across the file cutoff.  Scoped by
--     the rail-facing control account (account.rail_control), so "which
--     side of the ledger does this file describe" is data, not a
--     hard-coded account list.
SELECT 'in_ledger_not_file',
       e.id,
       e.external_ref,
       e.value_date,
       NULL::bigint,
       SUM(l.amount_cents),
       ABS(SUM(l.amount_cents)),
       (:today - e.value_date),
       CASE
         WHEN (:today - e.value_date) <=  1 THEN '0-1'
         WHEN (:today - e.value_date) <=  3 THEN '2-3'
         WHEN (:today - e.value_date) <=  7 THEN '4-7'
         WHEN (:today - e.value_date) <= 30 THEN '8-30'
         ELSE '31+'
       END
  FROM scheme_file       f
  JOIN journal_entry     e ON e.rail = f.rail
                          AND e.value_date = f.business_date
                          AND e.book = 'financial'
  JOIN journal_line      l ON l.entry_id = e.id
  JOIN account           a ON a.id = l.account_id AND a.rail_control = f.rail
  LEFT JOIN recon_match  m ON m.entry_id = e.id
 WHERE f.id = :file_id
   AND m.id IS NULL
 GROUP BY e.id, e.external_ref, e.value_date

UNION ALL

-- 5c. AMOUNT MISMATCH
--     Matched by reference, disagreeing on money.  A partial capture
--     booked at the auth amount, a tip or fuel adjustment, an over-capture.
--     Still a match - which is why recon_match stores both amounts rather
--     than leaving the difference to be inferred later.
SELECT 'amount_mismatch',
       m.id,
       r.external_ref,
       r.value_date,
       m.file_amount_cents,
       m.ledger_amount_cents,
       (m.file_amount_cents - m.ledger_amount_cents),
       (:today - r.value_date),
       CASE
         WHEN (:today - r.value_date) <=  1 THEN '0-1'
         WHEN (:today - r.value_date) <=  3 THEN '2-3'
         WHEN (:today - r.value_date) <=  7 THEN '4-7'
         WHEN (:today - r.value_date) <= 30 THEN '8-30'
         ELSE '31+'
       END
  FROM recon_match       m
  JOIN scheme_file_row   r ON r.id = m.file_row_id
 WHERE r.file_id = :file_id
   AND m.file_amount_cents <> m.ledger_amount_cents

 ORDER BY 8 DESC, 1, 4;   -- oldest first: aging is the point of the screen


-- The breaks screen's summary tiles: count and value by category and
-- bucket, across all files (wrap 5a-5c in a view or a set-returning
-- function first; kept inline here so the three definitions stay
-- readable side by side).


-- Adjudication history for one break - append-only, so a resolved break
-- keeps its story instead of disappearing from the screen.
SELECT n.created_at, n.break_kind, n.note, n.resolution,
       n.adjusting_entry_id, act.display_name
  FROM recon_break_note n
  JOIN actor act ON act.id = n.created_by
 WHERE n.break_key = :break_key
 ORDER BY n.created_at;


-- =====================================================================
-- 6.  THE HOLD, RECONSTRUCTED  (the exactly-once release, as a query)
-- =====================================================================
-- Every event we ever received for one authorisation, the running
-- A(E) and C(E), and the target hold after each one.  This is what I
-- would put on screen during the live-fire demo: it shows the fuel-pump
-- over-capture, the out-of-order settlement, and the duplicate delivery
-- all converging on the same number, because H is a function of the event
-- SET and not of the arrival order.

WITH ev AS (
  SELECT ev.received_at,
         ev.kind,
         ev.amount_cents,
         ev.is_final,
         ev.value_date,
         ev.provider_event_id,
         SUM(CASE WHEN ev.kind IN ('authorization','incremental_authorization')
                    THEN  ev.amount_cents
                  WHEN ev.kind = 'authorization_reversal'
                    THEN -ev.amount_cents
                  ELSE 0 END)
           OVER (ORDER BY ev.received_at, ev.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS auth_net_cents,
         SUM(CASE WHEN ev.kind IN ('clearing','force_post') THEN ev.amount_cents ELSE 0 END)
           OVER (ORDER BY ev.received_at, ev.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS captured_cents,
         bool_or(ev.is_final OR ev.kind IN ('expiry','close'))
           OVER (ORDER BY ev.received_at, ev.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closed_so_far
    FROM card_auth_event ev
   WHERE ev.auth_id = :auth_id
)
SELECT received_at, kind, amount_cents, is_final, provider_event_id,
       auth_net_cents, captured_cents,
       CASE WHEN closed_so_far OR auth_net_cents <= 0 THEN 0
            ELSE GREATEST(auth_net_cents - captured_cents, 0)
       END AS target_hold_cents
  FROM ev
 ORDER BY received_at;

-- ...and what the memo book actually posted, which must telescope to the
-- same number.  Each row is one compare-and-append delta, keyed
-- 'hold:<hold_id>:after:<provider_event_id>' on journal_entry
-- .idempotency_key, so a replayed event cannot append a second delta.
SELECT e.booking_seq, e.booking_time, e.value_date, e.idempotency_key,
       SUM(l.amount_cents * a.normal_side) AS delta_cents,
       SUM(SUM(l.amount_cents * a.normal_side)) OVER (ORDER BY e.booking_seq)
         AS hold_balance_after_cents
  FROM journal_entry e
  JOIN journal_line  l ON l.entry_id = e.id
  JOIN account       a ON a.id = l.account_id
 WHERE e.hold_id = :hold_id
   AND a.book = 'memo'
   AND a.business_id IS NOT NULL      -- the 9100/9200 leg, not the 9900 contra
 GROUP BY e.id, e.booking_seq, e.booking_time, e.value_date, e.idempotency_key
 ORDER BY e.booking_seq;


-- =====================================================================
-- 7.  INVARIANTS  -  all of these must return zero rows
-- =====================================================================
SELECT * FROM v_entry_unbalanced;         -- an entry that does not sum to zero
SELECT * FROM v_line_denorm_drift;        -- a line clock that disagrees with its entry
SELECT * FROM v_hold_drift;               -- memo book vs the fold over card events
SELECT * FROM v_book_not_zero;            -- the whole book must net to zero
SELECT * FROM v_deposit_control_drift;    -- customer balances vs the deposits subtree
SELECT * FROM verify_chain(:entity);      -- tamper evidence on the hash chain

-- And the one that is not a view because it needs a watermark: every
-- issued statement still hashes to what it hashed to when it was issued.
-- Run over the whole statement table nightly; a mismatch is a P1.
