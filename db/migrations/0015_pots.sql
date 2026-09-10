-- =====================================================================
-- 0015  POTS  -  sub-accounts of a customer's deposit liability, moved
--                between by internal transfers that touch no rail.
--
-- Reasoning lives in docs/POTS.md.  This file carries the mechanics and a
-- comment on every non-obvious line.
--
-- ---------------------------------------------------------------------
-- WHAT A POT IS, IN THE CHART OF ACCOUNTS
-- ---------------------------------------------------------------------
--
-- A pot is a REAL LEDGER ACCOUNT, a child of the customer's own '2100'
-- deposit leaf, in the financial book, credit-normal, carrying the same
-- business_id as its parent.  It is not a tag, not a column, not a
-- number kept beside the balance.  The money in it is still owed to the
-- same customer -- it never leaves 2100's subtree, so the deposit
-- CONTROL account still equals total customer money -- it is merely held
-- in a different leaf of that customer's own tree.
--
-- The account code is '2100.<pot uuid>'.  Three properties of that
-- choice, all load-bearing:
--
--   1. It is NOT the string '2100'.  Every consumer in the codebase
--      addresses a customer's spendable account with an EXACT equality
--      (`code = '2100' AND business_id = ...`): availableBalance(),
--      v_available_balance, v_overdrawn_accounts, listDepositAccounts,
--      the statements reader, the holds store, the recon demo.  A pot is
--      invisible to all of them, which is precisely what makes moving
--      money into one reduce AVAILABLE without a single line of those
--      modules changing.  See docs/POTS.md §2.
--
--   2. It is unique per pot, so `UNIQUE NULLS NOT DISTINCT (entity_id,
--      code, business_id)` in 0001 permits many pots per business.  Had
--      pots reused the bare code '2100' that constraint would allow
--      exactly one.
--
--   3. The separator is '.', not '/'.  chart.ts reserves '/' for the
--      DISPLAY form of a per-business leaf ('2100/<business uuid>') and
--      parsePerBusinessCode() splits on it.  A pot code must never parse
--      as one of those, and with '.' it cannot.
--
-- ---------------------------------------------------------------------
-- THE INVARIANT THIS MIGRATION HAD TO FIX, AND WHY THAT IS NOT CHEATING
-- ---------------------------------------------------------------------
--
-- 0001 says of v_deposit_control_drift:
--
--     "Written as a subtree walk rather than 'sum the 2100 children' so
--      that adding a sub-account level later cannot silently break it."
--
-- That claim was verified against the live database before this file was
-- written -- one pot account, one $500.00 internal transfer, inside a
-- transaction that was rolled back -- and it is HALF TRUE.  The view has
-- two sides:
--
--   subtree_cents   WITH RECURSIVE over account.parent_id.  This half is
--                   exactly as advertised: it picked the new pot account
--                   up with no change at all.
--
--   reported_cents  SUM over v_ledger_balance WHERE code = '2100'.  A
--                   FLAT CODE FILTER.  This half does not recurse, did
--                   not see the pot, and the view returned
--                   subtree 13,577,077 vs reported 13,527,077 -- a
--                   drift of exactly the 50,000 cents in the pot.
--
-- So the sub-account level DID silently break it, on the side nobody was
-- looking at.  The fix below is not "relax the check until the feature
-- passes": reported_cents is generalised from a code filter to
-- `code = '2100' OR the account is in the deposit tree`, which is a
-- STRICT SUPERSET of the rows the old predicate matched.  Anything the
-- old view would have caught, this one still catches; it now also
-- catches a customer-scoped account inside the deposit tree that nobody
-- is reporting.  With zero pots on the book the two predicates select
-- the identical row set, which is asserted by the pots integration test.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
-- ---------------------------------------------------------------------
--
--   * No balance column, on `pot` or anywhere.  A pot's balance is
--     SUM(journal_line) over its account, exactly like every other
--     balance in this schema.  scripts/dbcheck.mjs fails the build if a
--     stored one appears.
--   * No transfer table.  An internal transfer IS a journal entry:
--     two lines, one entity, one customer, rail = 'internal', and
--     nothing else exists to describe it.  A `pot_transfer` row would be
--     a second copy of the truth, free to drift from the first.
--   * No pot_closure.  Closing a pot is not needed to prove anything
--     this migration is for, and an UPDATE on `pot` is refused, so it
--     could not be a status flag anyway.  See docs/POTS.md, cut list.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The pot's identity.  NOT its balance.
-- ---------------------------------------------------------------------

CREATE TABLE pot (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES business(id),
  -- The ledger account that actually holds the money.  UNIQUE because a
  -- pot and its account are one thing recorded twice; two pots sharing
  -- an account would make "this pot's balance" ambiguous.
  account_id   uuid NOT NULL UNIQUE REFERENCES account(id),
  name         text NOT NULL,
  -- Free text.  Why the customer set this money aside, in their words --
  -- carried onto the journal entry's description so the reason survives
  -- in the journal and not only in this table.
  purpose      text,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  opened_by    uuid NOT NULL REFERENCES actor(id),

  -- A name is how a person refers to a pot out loud ("move it to
  -- payroll"), so it has to be unambiguous within one business.
  CONSTRAINT pot_name_unique  UNIQUE (business_id, name),
  CONSTRAINT pot_name_shape   CHECK (length(btrim(name)) BETWEEN 1 AND 60
                                     AND name = btrim(name)),
  CONSTRAINT pot_purpose_len  CHECK (purpose IS NULL OR length(purpose) <= 280)
);

CREATE INDEX pot_business_idx ON pot (business_id);

-- Append-only, by the same trigger the money tables use.  A pot is not a
-- money row, but its NAME is quoted on the journal entry that moved money
-- into it, and a renamed pot would make a past entry's description a lie.
-- Layer 1 (privileges) is below: corgi_app gets SELECT and nothing else,
-- so the application cannot express an INSERT either -- pots are opened
-- through pot_open() or not at all.
CREATE TRIGGER pot_no_update_delete
  BEFORE UPDATE OR DELETE ON pot
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER pot_no_truncate
  BEFORE TRUNCATE ON pot
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 2.  Opening a pot: one function, because it is two writes
-- ---------------------------------------------------------------------
--
-- corgi_app holds SELECT on `account` and nothing more -- account
-- creation has always been a seed/migration act, never a request-time
-- one.  Pots are the first feature that needs an account opened while
-- the system is running, and the answer is the shape 0001 already uses
-- for ledger_append(): a SECURITY DEFINER function with a pinned
-- search_path, revoked from PUBLIC, granted to corgi_app.  The
-- application gains exactly one new capability -- "open a pot account
-- under this business's own deposit leaf" -- and not INSERT on `account`,
-- which would let it open anything anywhere.
--
-- Both writes are in one function so they are in one statement: an
-- `account` row with no `pot` row would be an orphan leaf inside the
-- deposit subtree, which is exactly what v_pot_orphan exists to report.

CREATE OR REPLACE FUNCTION pot_open(
  p_business uuid,
  p_name     text,
  p_purpose  text,
  p_actor    uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pot_id     uuid := gen_random_uuid();
  v_main       record;
  v_account_id uuid;
  v_name       text := btrim(COALESCE(p_name, ''));
  v_purpose    text := NULLIF(btrim(COALESCE(p_purpose, '')), '');
  v_legal      text;
BEGIN
  IF length(v_name) = 0 OR length(v_name) > 60 THEN
    RAISE EXCEPTION 'a pot name is 1 to 60 characters; got %', length(v_name)
      USING ERRCODE = '22023';
  END IF;

  -- The parent, and the source of every other field on the child: entity,
  -- currency and business all come from the leaf rather than from the
  -- caller, so a pot cannot be opened in the wrong book, the wrong
  -- currency or under somebody else's business.
  SELECT a.id, a.entity_id, a.currency, a.business_id
    INTO v_main
    FROM account a
   WHERE a.code = '2100'
     AND a.business_id = p_business
     AND a.book = 'financial';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'business % has no 2100 deposit account; it has not passed KYB', p_business
      USING ERRCODE = '23503';
  END IF;

  SELECT b.legal_name INTO v_legal FROM business b WHERE b.id = p_business;

  INSERT INTO account (id, entity_id, code, name, parent_id, type, book,
                       currency, business_id, is_postable)
  VALUES (gen_random_uuid(),
          v_main.entity_id,
          -- See the header: not '2100', unique per pot, '.' not '/'.
          '2100.' || v_pot_id::text,
          COALESCE(v_legal, 'Unknown business') || ' — pot: ' || v_name,
          v_main.id,
          'liability',      -- the customer's money is still our liability
          'financial',      -- a pot is real money, not a memo hold
          v_main.currency,
          p_business,
          true)             -- postable: it is a leaf and money lands in it
  RETURNING id INTO v_account_id;

  INSERT INTO pot (id, business_id, account_id, name, purpose, opened_by)
  VALUES (v_pot_id, p_business, v_account_id, v_name, v_purpose, p_actor);

  RETURN v_pot_id;
END $$;

ALTER FUNCTION pot_open(uuid, text, text, uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION pot_open(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pot_open(uuid, text, text, uuid) TO corgi_app;


-- ---------------------------------------------------------------------
-- 3.  The lock that makes "is there enough?" and "post it" one decision
-- ---------------------------------------------------------------------
--
-- Same problem as 0008 §2 and the same solution.  Two concurrent moves
-- into pots could each read an available balance of $100.00 and each
-- post $80.00, leaving the customer $60.00 overdrawn against a check
-- that both passed.  The fix is to serialise every mover of one
-- customer's deposits behind a row lock taken before the balance is read
-- and held to the caller's COMMIT.
--
-- corgi_app cannot take that lock itself: SELECT ... FOR UPDATE needs
-- UPDATE privilege on the table, and handing the application UPDATE on
-- `account` to obtain a lock would be an absurd trade.  So, as with
-- lock_card_authorization(), the lock is taken by a definer function
-- whose entire surface is one uuid in, one boolean out.  It does not get
-- its own transaction -- a SECURITY DEFINER function gets its own
-- privileges, not its own transaction -- so this is the caller's lock,
-- released at the caller's COMMIT, exactly as intended.
--
-- It locks the whole family (the 2100 leaf AND every pot beneath it)
-- because a move touches two of them and either could be the source.

CREATE OR REPLACE FUNCTION lock_business_deposits(p_business uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_locked integer;
BEGIN
  PERFORM 1
     FROM account a
    WHERE a.business_id = p_business
      AND a.book = 'financial'
      AND (a.code = '2100' OR a.code LIKE '2100.%')
    ORDER BY a.id          -- a total order on the rows, so two movers on
                           -- the same business cannot deadlock each other
      FOR UPDATE;
  GET DIAGNOSTICS v_locked = ROW_COUNT;
  RETURN v_locked > 0;
END $$;

ALTER FUNCTION lock_business_deposits(uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION lock_business_deposits(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_business_deposits(uuid) TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  Derived views.  There is still no stored balance anywhere.
-- ---------------------------------------------------------------------

-- One pot, with the balance of its account.  LEFT JOIN because a pot
-- opened a moment ago has no lines and must read 0, not vanish.
CREATE VIEW v_pot_balance AS
SELECT p.id                              AS pot_id,
       p.business_id,
       p.account_id,
       p.name,
       p.purpose,
       p.opened_at,
       COALESCE(lb.balance_cents, 0)::bigint AS balance_cents
  FROM pot p
  LEFT JOIN v_ledger_balance lb ON lb.account_id = p.account_id;

-- The identity the /pots screen shows rather than asserts:
--
--     main + Σ pots = total deposit liability for this business
--
-- `main_cents` is the balance of the 2100 leaf -- the spendable account,
-- the one availableBalance() reads.  `pots_cents` is everything
-- earmarked.  `total_cents` is what the customer owns and is what the
-- deposit control account has to agree with.
CREATE VIEW v_pot_identity AS
SELECT a.business_id,
       a.id                                                       AS main_account_id,
       COALESCE(lb.balance_cents, 0)::bigint                       AS main_cents,
       COALESCE(pt.pots_cents, 0)::bigint                          AS pots_cents,
       (COALESCE(lb.balance_cents, 0) + COALESCE(pt.pots_cents, 0))::bigint
                                                                   AS total_cents,
       COALESCE(pt.pot_count, 0)::bigint                           AS pot_count
  FROM account a
  LEFT JOIN v_ledger_balance lb ON lb.account_id = a.id
  LEFT JOIN LATERAL (
    SELECT SUM(pb.balance_cents) AS pots_cents, count(*) AS pot_count
      FROM v_pot_balance pb
     WHERE pb.business_id = a.business_id
  ) pt ON true
 WHERE a.code = '2100'
   AND a.business_id IS NOT NULL
   AND a.book = 'financial';

-- The same total, computed the other way: a recursive walk of the
-- customer's own deposit subtree.  Two independent derivations of one
-- number is what makes v_pot_identity_drift (below) a test rather than a
-- restatement.
CREATE VIEW v_pot_subtree AS
WITH RECURSIVE tree AS (
  SELECT a.id AS main_account_id, a.business_id, a.id AS account_id
    FROM account a
   WHERE a.code = '2100'
     AND a.business_id IS NOT NULL
     AND a.book = 'financial'
  UNION ALL
  SELECT t.main_account_id, t.business_id, c.id
    FROM account c
    JOIN tree t ON c.parent_id = t.account_id
)
SELECT t.main_account_id,
       t.business_id,
       COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS subtree_cents
  FROM tree t
  JOIN account a ON a.id = t.account_id
  LEFT JOIN journal_line l ON l.account_id = t.account_id
 GROUP BY t.main_account_id, t.business_id;


-- ---------------------------------------------------------------------
-- 5.  Invariant views.  Every one MUST return zero rows.  They are TESTS.
-- ---------------------------------------------------------------------

-- main + Σ pots must equal the recursive walk of this customer's deposit
-- subtree.  If a pot's account were reparented, or an account appeared
-- under the leaf with no `pot` row, or the arithmetic on the screen
-- stopped matching the tree, this fires.
CREATE VIEW v_pot_identity_drift AS
SELECT i.business_id,
       i.main_cents,
       i.pots_cents,
       i.total_cents,
       s.subtree_cents
  FROM v_pot_identity i
  JOIN v_pot_subtree  s ON s.main_account_id = i.main_account_id
 WHERE i.total_cents <> s.subtree_cents;

-- A pot cannot be overdrawn.  A DEPOSIT ACCOUNT can -- an over-captured
-- fuel-pump authorisation settles above what was authorised and the
-- honest answer is that the customer owes us money (1190, v_overdrawn_
-- accounts).  A POT is our own construct: nothing external can push it
-- negative, so a negative pot is always a bug in the move guard and
-- never a fact about the world.
CREATE VIEW v_pot_negative AS
SELECT pot_id, business_id, account_id, name, balance_cents
  FROM v_pot_balance
 WHERE balance_cents < 0;

-- A pot's account must be a liability leaf in the financial book, owned
-- by the same business as the pot, coded for that pot, and parented
-- directly on that business's own 2100 deposit leaf.  Any one of those
-- being false would put money inside the deposit subtree that the
-- customer's own screen cannot see, or outside it while still being
-- theirs.
CREATE VIEW v_pot_orphan AS
SELECT p.id AS pot_id, p.business_id, p.account_id, a.code, a.parent_id
  FROM pot p
  LEFT JOIN account a    ON a.id = p.account_id
  LEFT JOIN account main ON main.id = a.parent_id
 WHERE a.id IS NULL
    OR a.business_id IS DISTINCT FROM p.business_id
    OR a.book       <> 'financial'
    OR a.type       <> 'liability'
    OR a.is_postable = false
    OR a.code       <> ('2100.' || p.id::text)
    OR main.id IS NULL
    OR main.code    <> '2100'
    OR main.business_id IS DISTINCT FROM p.business_id;

-- An internal transfer must be exactly what it claims: two lines, both
-- in this customer's own deposit subtree, netting to zero, on no rail.
-- The generic balanced-entry trigger already proves "nets to zero"; what
-- this adds is "and it did not quietly touch anything else", which is
-- the whole claim of the phrase "pure ledger move".
CREATE VIEW v_internal_transfer_impure AS
SELECT e.id AS entry_id,
       e.value_date,
       e.booking_seq,
       e.description,
       count(l.*)                                              AS line_count,
       count(*) FILTER (WHERE a.code <> '2100'
                          AND a.code NOT LIKE '2100.%')        AS foreign_lines,
       count(DISTINCT a.business_id)                           AS business_count
  FROM journal_entry e
  JOIN journal_line  l ON l.entry_id = e.id
  JOIN account       a ON a.id = l.account_id
 WHERE e.rail = 'internal'
   AND e.idempotency_key LIKE 'pot:%'
 GROUP BY e.id, e.value_date, e.booking_seq, e.description
HAVING count(l.*) <> 2
    OR count(*) FILTER (WHERE a.code <> '2100' AND a.code NOT LIKE '2100.%') > 0
    OR count(DISTINCT a.business_id) <> 1;


-- ---------------------------------------------------------------------
-- 6.  v_deposit_control_drift, generalised.  See the header for why.
-- ---------------------------------------------------------------------
--
-- CREATE OR REPLACE rather than DROP + CREATE so the GRANT that 0008
-- issued survives, and so that any dependent object keeps working.  The
-- output columns keep their names, their order and their types
-- (`numeric`, from SUM over a bigint) -- REPLACE refuses otherwise, which
-- is a useful thing for it to refuse.

CREATE OR REPLACE VIEW v_deposit_control_drift AS
WITH RECURSIVE deposit_tree AS (
  SELECT id FROM account WHERE code = '2100' AND business_id IS NULL
  UNION ALL
  SELECT a.id FROM account a JOIN deposit_tree t ON a.parent_id = t.id
),
subtree AS (
  -- Unchanged in substance.  This half of the original view already
  -- recursed and already saw the pots; COALESCE is the only difference,
  -- so that "the subtree has no lines at all but somebody is reporting a
  -- balance" is a drift rather than a NULL that swallows the comparison.
  SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0) AS cents
    FROM journal_line l
    JOIN account a ON a.id = l.account_id
   WHERE a.id IN (SELECT id FROM deposit_tree)
),
reported AS (
  -- The half that was flat, and is not any more.
  --
  --   code = '2100'                 every row the ORIGINAL predicate
  --                                 matched, kept verbatim -- including a
  --                                 customer deposit leaf that had been
  --                                 reparented OUT of the tree, which the
  --                                 tree membership test alone would miss.
  --   OR in the deposit tree        every customer-scoped account inside
  --                                 the control account's subtree, which
  --                                 is what a pot is.
  --
  -- Strict superset of the old row set.  With no pots on the book the two
  -- select identically, which the pots integration test asserts.
  SELECT COALESCE(SUM(v.balance_cents), 0) AS cents
    FROM v_ledger_balance v
   WHERE v.business_id IS NOT NULL
     AND (v.code = '2100' OR v.account_id IN (SELECT id FROM deposit_tree))
)
SELECT s.cents AS subtree_cents,
       r.cents AS reported_cents
  FROM subtree s CROSS JOIN reported r
 WHERE s.cents <> r.cents;


-- ---------------------------------------------------------------------
-- 7.  Privileges
-- ---------------------------------------------------------------------
--
-- SELECT on `pot` and nothing else: the application reads pots and opens
-- them through pot_open(), so there is no code path -- and, more to the
-- point, no CAPABILITY -- by which it could write half of one.
GRANT SELECT ON pot TO corgi_app;

GRANT SELECT ON
  v_pot_balance,
  v_pot_identity,
  v_pot_subtree,
  v_pot_identity_drift,
  v_pot_negative,
  v_pot_orphan,
  v_internal_transfer_impure
TO corgi_app;
