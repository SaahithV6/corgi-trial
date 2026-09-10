-- =====================================================================
-- 0008  Card authorisation holds: the three things 0001 does not have
-- =====================================================================
--
-- 0001 already carries the WHOLE hold model and none of it is repeated
-- or reimplemented here:
--
--   * hold / hold_closure          identity + one-shot closure, PK(hold_id)
--   * card_authorization           immutable identity, NO status column
--   * card_auth_event              append-only, UNIQUE (auth_id, provider_event_id)
--   * v_card_auth_state            A(E) and C(E) as a fold over the event SET
--   * v_card_auth_hold             H(E) = 0 if closed else max(A-C, 0)
--   * v_hold_state, v_available_balance, v_hold_drift
--   * ledger_append()              the only sanctioned money write path
--
-- Three gaps were found by running the application role against the live
-- database rather than by reading the file, and each is proven below by
-- the statement that failed:
--
--   1. corgi_app cannot READ any derived view.
--        SELECT count(*) FROM v_card_auth_hold
--          -> ERROR: permission denied for view v_card_auth_hold
--      0001's `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`
--      runs at line 816, and the views are created at line 998 -- after
--      it.  A new view is created with no privileges for anyone but its
--      owner, so the revoke did not cause this; the absence of a matching
--      GRANT did.  The consequence is that the invariant views the design
--      calls tests, and the availability projection the customer screen
--      reads, are unreachable from the running application.
--
--   2. corgi_app cannot take the row lock the exactly-once argument
--      depends on.
--        SELECT id FROM card_authorization WHERE id = ... FOR UPDATE
--          -> ERROR: permission denied for table card_authorization
--      Postgres requires UPDATE privilege for FOR UPDATE, and the whole
--      point of this ledger is that the application does not hold UPDATE
--      on a money table.  Granting it to buy a lock would trade the
--      immutability guarantee for a mutual-exclusion primitive.  Instead
--      the lock is taken by a SECURITY DEFINER function that can do
--      nothing else -- the same shape as ledger_append(), for the same
--      reason.
--
--   3. There is nowhere to record WHOSE money a card spends.
--      card_authorization.card_id is a bare uuid with no referent, and a
--      Lithic webhook arrives carrying `card_token` and nothing else.
--      Without a mapping the consumer cannot pick a deposit account, and
--      guessing one is how a customer pays for another customer's fuel.
--
-- Nothing else changes.  No table in 0001 is altered, no trigger is
-- replaced, no privilege is widened on a money table.

-- ---------------------------------------------------------------------
-- 1.  Let the application read what the design says is derived
-- ---------------------------------------------------------------------
--
-- SELECT only, and only on views.  A view is not a second source of
-- truth: every one of these is a SUM or a fold over the same immutable
-- rows, so reading them cannot drift from reading the tables, and there
-- is nothing here that could be written even if someone tried.
--
-- These views are owned by the migration role and are NOT
-- security_invoker, so they execute with the owner's rights over the
-- underlying tables.  That is deliberate and it is not a privilege
-- escalation: each one is a fixed, parameterless projection, so the only
-- thing corgi_app gains is the ability to read numbers it can already
-- compute by hand from tables it already holds SELECT on.

GRANT SELECT ON
  v_ledger_balance,
  v_card_auth_state,
  v_card_auth_hold,
  v_hold_state,
  v_available_balance,
  v_entry_unbalanced,
  v_line_denorm_drift,
  v_hold_drift,
  v_book_not_zero,
  v_deposit_control_drift,
  v_overdrawn_accounts,
  v_late_postings,
  v_trial_balance
TO corgi_app;

-- ---------------------------------------------------------------------
-- 2.  The row lock, without the UPDATE privilege
-- ---------------------------------------------------------------------
--
-- DESIGN.md section 9 step 3: "Processing an event runs in one
-- transaction that does SELECT ... FROM card_authorization WHERE id = :a
-- FOR UPDATE first".  That lock is what makes the compare-and-append a
-- compare-and-append: it serialises every processor of one authorisation,
-- so no two can both observe H_cur = 5000 and both post -5000.
--
-- The lock is taken in the CALLER's transaction and released at the
-- caller's COMMIT -- a SECURITY DEFINER function does not get its own
-- transaction, only its own privileges -- so this is exactly the lock the
-- design specifies, obtained without handing the application a capability
-- it must never have.
--
-- The function's entire surface is one uuid in, one boolean out.  It
-- cannot read a money row, cannot write anything at all, and cannot be
-- coaxed into locking a different table.  search_path is pinned for the
-- reason DECISIONS 010 / migration 0003 give: a SECURITY DEFINER body
-- resolves unqualified names through the CALLER's path.
--
-- Returns false when the authorisation does not exist yet, which is not
-- an error: a settlement can arrive before its authorisation, and the
-- caller creates the identity and calls again.

CREATE OR REPLACE FUNCTION lock_card_authorization(p_auth uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT ca.id INTO v_id
    FROM card_authorization ca
   WHERE ca.id = p_auth
     FOR UPDATE;
  RETURN v_id IS NOT NULL;
END $$;

ALTER FUNCTION lock_card_authorization(uuid) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION lock_card_authorization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_card_authorization(uuid) TO corgi_app;

-- ---------------------------------------------------------------------
-- 3.  Which customer a card token belongs to
-- ---------------------------------------------------------------------
--
-- One row per issued card, per provider.  It carries both accounts the
-- hold machinery needs -- the customer's 2100 deposit leaf and their
-- 9100 memo leaf -- rather than deriving them at read time, because
-- deriving them means a per-event lookup by (code, business_id) on the
-- hot path and because storing them makes "which book does this card
-- move" a foreign key rather than a convention.
--
-- Deliberately NOT a balance, a status, or a copy of anything Lithic
-- owns.  PAN, CVV and expiry are absent by construction: they are never
-- persisted (see rails/lithic/types.ts), and a column that does not exist
-- cannot be filled in by a later well-meaning commit.
--
-- A card whose token is unknown does not fail and does not guess.  The
-- consumer returns parked('card', token) and the dispatcher re-tries it
-- when the card is registered -- which is the same mechanism that handles
-- a settlement arriving before its authorisation.

CREATE TABLE card (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_card_token text NOT NULL,
  business_id         uuid NOT NULL REFERENCES business(id),
  -- The customer's 2100 leaf.  Financial book: this is where cleared
  -- spend lands.
  account_id          uuid NOT NULL REFERENCES account(id),
  -- The customer's 9100 leaf.  Memo book: this is where the hold lives.
  memo_account_id     uuid NOT NULL REFERENCES account(id),
  last_four           text,
  nickname            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_provider_key UNIQUE (provider, provider_card_token)
);

CREATE INDEX card_business_idx ON card (business_id);

-- Append-only, like every other row that decides where money goes.
--
-- A card mapping is not money, but it is the arrow money follows: an
-- UPDATE that repointed provider_card_token '56db7b80...' from Ridgeline
-- to Kettle & Crumb would silently bill one customer for another
-- customer's spend, and every invariant in this schema would keep
-- passing while it happened.  Re-issuing a card is a NEW row with a new
-- token, which is also what the provider does.
CREATE TRIGGER card_no_update_delete
  BEFORE UPDATE OR DELETE ON card
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER card_no_truncate
  BEFORE TRUNCATE ON card
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- SELECT and INSERT only, matching `hold` and `card_authorization`: the
-- application creates a card by calling the provider, so it must be able
-- to record the one it just created.  It holds no UPDATE, no DELETE and
-- no TRUNCATE, and the triggers above hold even against the owner.
GRANT SELECT, INSERT ON card TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON card FROM corgi_app, PUBLIC;

-- ---------------------------------------------------------------------
-- 4.  One reporting view for the staff screen
-- ---------------------------------------------------------------------
--
-- Live card holds with the customer attached.  Reads H(E) from
-- v_card_auth_hold (the fold over the event set) beside the memo book's
-- own balance, so the two can be compared by eye as well as by
-- v_hold_drift.  Nothing writes here and nothing repairs from it.

CREATE VIEW v_card_hold_live AS
SELECT ca.id                       AS auth_id,
       ca.provider,
       ca.provider_auth_id,
       ca.origin,
       ca.expires_at,
       h.id                        AS hold_id,
       acct.business_id,
       ch.auth_net_cents,
       ch.captured_cents,
       ch.saw_final,
       ch.is_closed,
       ch.target_hold_cents,
       hs.memo_balance_cents,
       (hc.hold_id IS NOT NULL)    AS closure_posted
  FROM card_authorization ca
  JOIN hold          h    ON h.id = ca.hold_id
  JOIN account       acct ON acct.id = ca.account_id
  JOIN v_card_auth_hold ch ON ch.auth_id = ca.id
  JOIN v_hold_state  hs   ON hs.hold_id = h.id
  LEFT JOIN hold_closure hc ON hc.hold_id = h.id;

GRANT SELECT ON v_card_hold_live TO corgi_app;
