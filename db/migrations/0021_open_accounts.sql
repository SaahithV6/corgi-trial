-- =====================================================================
-- 0021  OPEN ACCOUNTS  -  KYB approval opens the chart of accounts.
--
-- Reasoning lives in docs/ACCOUNT-OPENING.md.  This file carries the
-- mechanics and a comment on every non-obvious line.
--
-- ---------------------------------------------------------------------
-- THE GAP THIS CLOSES
-- ---------------------------------------------------------------------
--
-- The brief's core loop opens with "open an account behind a real KYB
-- check".  Until this migration the KYB check was real and the OPENING
-- was not: `scripts/seed.mjs` created the per-customer leaves for the one
-- business a hardcoded fixture said `opensAccounts: true`, and nothing in
-- `src/lib/**` could open an account at all.  Two of the three demo
-- businesses could not hold money, and passing KYB would not have changed
-- that, because approval was wired to nothing.
--
-- So the deposit leaf and its two memo hold leaves stop being a seeding
-- act and become a CONSEQUENCE OF APPROVAL, performed by the application
-- at request time, exactly the way `pot_open()` in 0015 made opening a pot
-- a request-time act.
--
-- ---------------------------------------------------------------------
-- WHY A SECURITY DEFINER FUNCTION AND NOT A GRANT
-- ---------------------------------------------------------------------
--
-- `corgi_app` holds SELECT on `account` and nothing more (0001 §13).  That
-- is not an oversight to be corrected: account creation decides WHERE
-- MONEY MAY LAND, and an application that held INSERT on `account` could
-- open anything, anywhere in the tree, under any business, in any book.
--
-- 0015 already answered this question for pots and the answer is reused
-- verbatim: one SECURITY DEFINER function with a pinned `search_path`,
-- revoked from PUBLIC, granted to `corgi_app`, every field of the child
-- read from existing rows rather than passed in by the caller, and every
-- write inside one function so there is no half-opened business.
--
-- The application gains exactly one new capability - "open the chart of
-- accounts for a business that v_business_kyb says is approved" - and not
-- INSERT on `account`.
--
-- ---------------------------------------------------------------------
-- WHERE "APPROVED ONLY" IS ENFORCED, AND WHY IT IS NOT IN TYPESCRIPT
-- ---------------------------------------------------------------------
--
-- `business_accounts_open()` takes no status argument.  It reads
-- `v_business_kyb` ITSELF, inside its own body, and raises if the answer
-- is anything but `approved`.  There is deliberately no parameter a caller
-- could pass to say "I already checked" - a function that trusts its
-- caller to have checked KYB is a function that will one day be called by
-- something that did not.
--
-- Because `corgi_app` cannot express `INSERT INTO account` at all, this
-- check is not merely the first gate in front of the write.  It is the
-- ONLY door in the wall.  The TypeScript in `src/lib/onboarding/` reads
-- the same view first, but only so the screen can print a good sentence;
-- remove that read entirely and nothing about what the database permits
-- changes.
--
-- The one principal this does not bind is the OWNER, which is by
-- definition the role that runs migrations and could drop the check
-- anyway.  `scripts/seed.mjs` and the holds/pots integration fixtures open
-- accounts over `DIRECT_URL` as the owner, so they bypass it - and rather
-- than pretend otherwise with a trigger carrying an exemption for exactly
-- the rows that would trip it, `v_account_opened_outside_approval` below
-- REPORTS every leaf that did not come through this function.  A list you
-- can read beats an enforcement you had to hole.
--
-- ---------------------------------------------------------------------
-- IDEMPOTENCE IS THE DATABASE'S JOB
-- ---------------------------------------------------------------------
--
-- Approval can be re-read, a webhook can be redelivered, an operator can
-- double-click, and `openAccountsOnApproval()` is called after EVERY KYB
-- write on purpose - so opening twice must open once.
--
-- It is tempting to derive deterministic ids the way `seed.mjs` does
-- (`uuid5('account:<entity>:<code>:<business>')`) and let the primary key
-- collide.  That is a weaker guarantee than the one already on the table:
--
--     CONSTRAINT account_code_scope
--       UNIQUE NULLS NOT DISTINCT (entity_id, code, business_id)
--
-- A uuid5 collision proves two callers derived the same id.  THIS
-- constraint proves something stronger and more useful - that this
-- business cannot have two `2100` leaves in this entity no matter who
-- inserts them, with what id, from what code path.  So the insert below
-- uses `gen_random_uuid()` and `ON CONFLICT ON CONSTRAINT
-- account_code_scope DO NOTHING`, and leans on the constraint that was
-- already true rather than on a convention two call sites have to share.
--
-- There is no check-then-insert anywhere in this file.  A `SELECT ... IF
-- NOT FOUND THEN INSERT` is a race with a pretty face.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY ABSENT
-- ---------------------------------------------------------------------
--
--   * NO JOURNAL ENTRY.  Opening an account posts nothing.  An account
--     with no lines has a zero balance BY CONSTRUCTION - that is the
--     whole point of deriving balances from `journal_line` instead of
--     storing them - and an "opening entry" of zero would be two lines of
--     noise on a customer's first statement.
--   * NO BALANCE COLUMN, here or anywhere.  `scripts/dbcheck.mjs` fails
--     the build if a stored one appears.
--   * NO `closed_at` PATH.  Closing an account is not needed to prove
--     anything this migration is for, and `account` carries no UPDATE
--     grant for `corgi_app` to close one with.  See the cut list in
--     docs/ACCOUNT-OPENING.md.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The shape of a customer's chart, as data
-- ---------------------------------------------------------------------
--
-- `src/lib/ledger/chart.ts` marks three rollups `perBusiness: true` -
-- 2100 customer deposits, 9100 card-authorisation holds, 9200
-- uncleared-credit holds - and `accountsForBusiness()` is the function
-- that names them.  That is the source of truth, and this table is it
-- again in the only place a plpgsql function can read.
--
-- TWO COPIES OF ONE FACT IS EXACTLY THE THING THIS CODEBASE KEEPS
-- CATCHING, so the copy is checkable rather than trusted:
-- `src/lib/onboarding/shape.test.ts` parses the INSERT below out of this
-- file and asserts, with no database, that its codes are precisely
-- `PER_BUSINESS_PARENTS` and that every `leaf_name` here is the string
-- `perBusinessAccountName()` produces.  Add a fourth per-business rollup
-- to the chart and that test goes red until this row exists.
--
-- The name is carried here, rather than composed in the function, for the
-- same reason `pot_open()` reads currency off the parent: a customer's
-- deposit leaf is called "<legal name> - business current account" and
-- not "<legal name> - Customer deposits", and the difference is a
-- product decision, not something to re-derive from the rollup's own name.

CREATE TABLE per_business_rollup (
  -- The BARE rollup code, which is also the code the leaf is stored
  -- under: `account.code` is '2100' and the customer is identified by
  -- `business_id`.  chart.ts's `PerBusinessAccountRef` doc comment spells
  -- out why - v_available_balance, v_overdrawn_accounts and
  -- v_deposit_control_drift all select on `code = '2100' AND business_id
  -- IS NOT NULL`, and storing the qualified '2100/<uuid>' display form
  -- would make every one of them return nothing, silently.
  code       text PRIMARY KEY,
  -- Appended to the business's legal name with an em dash.  Verbatim from
  -- perBusinessAccountName() in chart.ts; asserted equal by the test above.
  leaf_name  text NOT NULL,
  -- The sentence used to explain this leaf out loud.  Carried so there is
  -- one wording of it, the same discipline as `ChartAccount.why`.
  why        text NOT NULL,
  -- Insertion order for the function below, so a business's accounts are
  -- always opened in chart order: deposit first, memo leaves after.
  ordinal    smallint NOT NULL UNIQUE,

  CONSTRAINT per_business_rollup_code_is_bare CHECK (code ~ '^[0-9]{4}$')
);

COMMENT ON TABLE per_business_rollup IS
  'The rollups that carry one leaf per customer. Mirrors PER_BUSINESS_PARENTS in src/lib/ledger/chart.ts; src/lib/onboarding/shape.test.ts asserts the two agree without touching a database.';

INSERT INTO per_business_rollup (code, leaf_name, why, ordinal) VALUES
  ('2100', 'business current account',
   'The customer''s own money and our liability to them: credit-normal, in the financial book, and the account every balance on every screen for this business is derived from.',
   1),
  ('9100', 'card authorisation holds',
   'Memo book. Credited when an authorisation opens a hold and debited as clearing, reversal or expiry consumes it, so available balance is derivable as ledger minus the sum of these rather than stored as a second number.',
   2),
  ('9200', 'uncleared credit holds',
   'Memo book. Credited when an ACH or USDC credit posts to the ledger before it is safe to spend, and debited when the funds-availability policy''s moment passes or the credit is returned.',
   3);

-- Reference data, read by the application and written by nobody.
GRANT SELECT ON per_business_rollup TO corgi_app;


-- ---------------------------------------------------------------------
-- 2.  Provenance: which approval opened this account
-- ---------------------------------------------------------------------
--
-- `account` has `opened_at` and no `opened_by`, and no column saying WHY
-- it exists.  For a house account that is fine - the chart explains it.
-- For a customer's deposit leaf it is not: the sentence this whole
-- migration exists to make true is "this account opened BECAUSE this
-- business passed KYB", and a sentence nobody recorded is a sentence
-- nobody can check in a debrief.
--
-- So one row per account this function opens, carrying the KYB reading
-- AS IT STOOD AT THE MOMENT OF OPENING.  Not a foreign key to some
-- decision row - `v_business_kyb` is a fold over an append-only evidence
-- table and a later observation can move it - but the four values that
-- fold produced, frozen, beside the account they justified.
--
-- The CHECK is the part worth pausing on: this table CANNOT RECORD A
-- NON-APPROVED OPENING.  It is not that we decline to write one; the row
-- is unrepresentable.  An account whose provenance says `pending` cannot
-- exist, so "was this account opened behind an approval?" is answered by
-- the presence of a row and never by reading its contents.

CREATE TABLE account_opening (
  account_id     uuid PRIMARY KEY REFERENCES account(id),
  business_id    uuid NOT NULL REFERENCES business(id),
  rollup_code    text NOT NULL REFERENCES per_business_rollup(code),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  -- Who pressed it.  NOT NULL: an account nobody can be named for is not
  -- one this system opens, the same rule `pot.opened_by` already applies.
  opened_by      uuid NOT NULL REFERENCES actor(id),

  -- The KYB reading at the instant of opening.
  kyb_status     kyb_status   NOT NULL,
  kyb_evidence   kyb_evidence NOT NULL,
  kyb_decided_at timestamptz,
  kyb_legs_on_file integer NOT NULL,

  -- The claim, as a constraint.
  CONSTRAINT account_opening_only_approved CHECK (kyb_status = 'approved'),
  -- v_business_kyb reads `pending` below two legs, so an approved row
  -- always has at least both of them.  Restated here because this row is
  -- read in a debrief long after the view that produced it.
  CONSTRAINT account_opening_both_legs CHECK (kyb_legs_on_file >= 2)
);

CREATE INDEX account_opening_business_idx ON account_opening (business_id);

COMMENT ON TABLE account_opening IS
  'Why a customer account exists: the KYB reading at the moment it was opened, frozen. Append-only. A row here can only say approved - the CHECK makes any other provenance unrepresentable.';

-- Append-only, by the same trigger the money tables use.  A provenance
-- row that could be edited would be a provenance row worth nothing, and
-- an account opened in error is closed (a future `closed_at`), never
-- un-opened.
CREATE TRIGGER account_opening_no_update_delete
  BEFORE UPDATE OR DELETE ON account_opening
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER account_opening_no_truncate
  BEFORE TRUNCATE ON account_opening
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- SELECT and nothing else.  The rows are written by the definer function
-- below or not at all, which is the same absent-capability argument as
-- `pot`: there is no code path by which the application could write half
-- an opening.
GRANT SELECT ON account_opening TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON account_opening FROM corgi_app, PUBLIC;


-- ---------------------------------------------------------------------
-- 3.  Opening the chart: one function, because it is six writes
-- ---------------------------------------------------------------------
--
-- Three accounts and three provenance rows, in one function, so they are
-- in one statement and therefore one transaction.  A business with a 2100
-- leaf and no 9100 would authorise a card into an account that cannot
-- carry its hold; there is no state between "no accounts" and "all of
-- them" that this system has a meaning for.
--
-- Returns one row per rollup, ALWAYS three, with `opened` saying whether
-- this call is the one that created it.  A second call returns the same
-- three account ids with `opened = false` - which is what makes "opening
-- twice opens once" something a caller can SEE rather than infer from the
-- absence of an error.

CREATE OR REPLACE FUNCTION business_accounts_open(
  p_business uuid,
  p_actor    uuid
) RETURNS TABLE (
  rollup_code text,
  account_id  uuid,
  account_code text,
  account_name text,
  opened      boolean
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_entity     uuid;
  v_legal      text;
  v_kyb        record;
  v_rollup     record;
  v_parent     record;
  v_new_id     uuid;
  v_actor_kind actor_kind;
BEGIN
  -- ---- the business, and the entity its accounts belong to -----------
  -- Entity is read from the BUSINESS row, never passed in: an account
  -- opened in the wrong entity would be money on the wrong book, and
  -- `account_code_scope` is scoped by entity, so a caller who could
  -- choose the entity could open a second 2100 for the same customer.
  SELECT b.entity_id, b.legal_name INTO v_entity, v_legal
    FROM business b WHERE b.id = p_business;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no business on this book has id %', p_business
      USING ERRCODE = '23503';
  END IF;

  -- ---- the actor ----------------------------------------------------
  -- Resolved here rather than trusted, so `account_opening.opened_by`
  -- names somebody who exists.  An agent may not open an account: the
  -- agent surface's entire contract is that its writes land in the human
  -- approval queue, and an account opening has no queue to land in.
  SELECT a.kind INTO v_actor_kind FROM actor a WHERE a.id = p_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no actor has id % - an account opening is attributed or it does not happen', p_actor
      USING ERRCODE = '23503';
  END IF;
  IF v_actor_kind = 'agent' THEN
    RAISE EXCEPTION 'actor % is an agent; opening an account is not an act an autonomous surface performs', p_actor
      USING ERRCODE = '42501';
  END IF;

  -- ---- THE GATE -----------------------------------------------------
  -- Read here, from the derived view, with no way for a caller to assert
  -- it.  `v_business_kyb` folds the latest row per leg out of an
  -- append-only evidence table: strictest status wins, one leg on file
  -- reads `pending`, and there is no stored column an UPDATE could forge.
  SELECT k.kyb_status, k.kyb_evidence, k.decided_at, k.legs_on_file
    INTO v_kyb
    FROM v_business_kyb k
   WHERE k.business_id = p_business;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no KYB state for business %', p_business
      USING ERRCODE = '23503';
  END IF;

  IF v_kyb.kyb_status <> 'approved' THEN
    RAISE EXCEPTION
      'business % is % and not approved; an account is where money lands and it does not open before the check passes',
      p_business, v_kyb.kyb_status
      USING ERRCODE = '42501';   -- insufficient_privilege: a refusal, not a bug
  END IF;

  -- ---- the leaves ---------------------------------------------------
  FOR v_rollup IN
    SELECT r.code, r.leaf_name FROM per_business_rollup r ORDER BY r.ordinal
  LOOP
    -- The parent, and the source of every structural field on the child:
    -- type, book and currency all come from the house rollup rather than
    -- from this function's opinion, so a leaf cannot be opened in the
    -- wrong book or with the wrong normal side however the chart moves.
    SELECT a.id, a.type, a.book, a.currency
      INTO v_parent
      FROM account a
     WHERE a.entity_id = v_entity
       AND a.code = v_rollup.code
       AND a.business_id IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the chart of accounts has no house rollup % in entity % - run scripts/seed.mjs',
        v_rollup.code, v_entity
        USING ERRCODE = '23503';
    END IF;

    v_new_id := NULL;   -- reset: RETURNING leaves it untouched on conflict

    INSERT INTO account (id, entity_id, code, name, parent_id, type, book,
                         currency, business_id, rail_control, is_postable)
    VALUES (gen_random_uuid(),
            v_entity,
            v_rollup.code,                       -- BARE, never qualified
            v_legal || ' — ' || v_rollup.leaf_name,
            v_parent.id,
            v_parent.type,
            v_parent.book,
            v_parent.currency,
            p_business,
            NULL,                                -- rail_control is a house concept
            true)                                -- a leaf; money lands in it
    -- The whole idempotence story, in one clause.  See the header.
    ON CONFLICT ON CONSTRAINT account_code_scope DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NULL THEN
      -- Already open.  Return the account that exists, and write no
      -- provenance row: this call did not open it and must not claim to.
      SELECT a.id, a.code, a.name INTO account_id, account_code, account_name
        FROM account a
       WHERE a.entity_id = v_entity
         AND a.code = v_rollup.code
         AND a.business_id = p_business;
      rollup_code := v_rollup.code;
      opened := false;
    ELSE
      INSERT INTO account_opening (account_id, business_id, rollup_code, opened_by,
                                   kyb_status, kyb_evidence, kyb_decided_at,
                                   kyb_legs_on_file)
      VALUES (v_new_id, p_business, v_rollup.code, p_actor,
              v_kyb.kyb_status, v_kyb.kyb_evidence, v_kyb.decided_at,
              v_kyb.legs_on_file);

      SELECT a.id, a.code, a.name INTO account_id, account_code, account_name
        FROM account a WHERE a.id = v_new_id;
      rollup_code := v_rollup.code;
      opened := true;
    END IF;

    RETURN NEXT;
  END LOOP;
END $$;

ALTER FUNCTION business_accounts_open(uuid, uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION business_accounts_open(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_accounts_open(uuid, uuid) TO corgi_app;

COMMENT ON FUNCTION business_accounts_open(uuid, uuid) IS
  'Opens a business''s chart of accounts as a consequence of KYB approval. Reads v_business_kyb itself and refuses anything but approved; idempotent through account_code_scope. Posts nothing to the journal.';


-- ---------------------------------------------------------------------
-- 4.  Derived views.  There is still no stored balance anywhere.
-- ---------------------------------------------------------------------

-- What a customer's chart looks like right now, one row per business that
-- has any of it.  LEFT JOIN to `account_opening` because the seed and the
-- integration fixtures opened theirs over the owner connection before this
-- function existed, and those accounts are real - they simply have no
-- provenance, and this view says so rather than hiding them.
CREATE VIEW v_business_accounts AS
SELECT a.business_id,
       b.legal_name,
       count(*)                                            AS leaves_open,
       count(*) FILTER (WHERE o.account_id IS NOT NULL)     AS leaves_with_provenance,
       max(o.opened_at)                                     AS opened_at,
       bool_and(o.account_id IS NOT NULL)                   AS opened_on_approval,
       (SELECT a2.id FROM account a2
         WHERE a2.business_id = a.business_id
           AND a2.code = '2100' AND a2.book = 'financial')  AS deposit_account_id
  FROM account a
  JOIN business b ON b.id = a.business_id
  LEFT JOIN account_opening o ON o.account_id = a.id
 WHERE a.business_id IS NOT NULL
   AND a.code IN (SELECT code FROM per_business_rollup)
 GROUP BY a.business_id, b.legal_name;

-- Which businesses are approved and have NOT had their accounts opened.
-- Zero rows is the steady state: `openAccountsOnApproval()` runs after
-- every KYB write, so a row here means an approval happened somewhere
-- this codebase does not yet call it from - a webhook path, a script, a
-- direct INSERT - and the fix is to call it, which is safe to do at any
-- time because the function is idempotent.
CREATE VIEW v_approved_without_accounts AS
SELECT k.business_id,
       k.legal_name,
       k.kyb_status,
       k.kyb_evidence,
       k.decided_at,
       COALESCE(v.leaves_open, 0) AS leaves_open
  FROM v_business_kyb k
  LEFT JOIN v_business_accounts v ON v.business_id = k.business_id
 WHERE k.kyb_status = 'approved'
   AND COALESCE(v.leaves_open, 0) < (SELECT count(*) FROM per_business_rollup);

-- The mirror image, and the honest one.  Every per-customer leaf that did
-- NOT come through business_accounts_open() - no provenance row, so
-- nothing proves an approval preceded it.
--
-- THIS VIEW IS A REPORT AND NOT AN INVARIANT, and the distinction is the
-- point.  It is non-empty today and expected to be:
--
--   * Ridgeline Robotics' five accounts were created by scripts/seed.mjs
--     before this function existed;
--   * 'Holds Integration Fixture Co.' and 'Pots Integration Fixture Co.'
--     are provisioned by their own test suites over DIRECT_URL, as the
--     OWNER, precisely because `corgi_app` cannot open an account - and
--     they carry no KYB evidence at all, deliberately, because what those
--     suites test is the hold machine and not the gate.
--
-- A trigger on `account` would have refused all of them, so it would have
-- shipped with an exemption for exactly the rows that would trip it - and
-- an enforcement you had to hole is worse than a list you can read.  The
-- enforcement that IS airtight is the privilege boundary: `corgi_app` has
-- no INSERT on `account`, and the only function that does checks KYB
-- itself.  Everything on this list was written by the database owner,
-- which is the role that could drop a trigger anyway.
CREATE VIEW v_account_opened_outside_approval AS
SELECT a.id            AS account_id,
       a.business_id,
       b.legal_name,
       a.code,
       a.name,
       a.opened_at,
       k.kyb_status,
       k.kyb_evidence
  FROM account a
  JOIN business b ON b.id = a.business_id
  LEFT JOIN v_business_kyb k ON k.business_id = a.business_id
  LEFT JOIN account_opening o ON o.account_id = a.id
 WHERE a.business_id IS NOT NULL
   AND a.code IN (SELECT code FROM per_business_rollup)
   AND o.account_id IS NULL;

COMMENT ON VIEW v_account_opened_outside_approval IS
  'REPORT, not an invariant: per-customer leaves with no account_opening provenance. Non-empty by design - the seed and the integration fixtures open accounts as the database owner. See docs/ACCOUNT-OPENING.md.';

-- A leaf must be what it claims: the right type, book and currency for its
-- rollup, owned by the business it is scoped to, parented on the house
-- rollup of the same code, postable, and coded BARE.  Any one of those
-- being false would put a customer's money somewhere their own screen
-- cannot see, or somewhere v_deposit_control_drift cannot count.
--
-- This one IS an invariant and MUST return zero rows.  It is the same
-- shape of test as v_pot_orphan in 0015.
CREATE VIEW v_business_account_malformed AS
SELECT a.id AS account_id, a.business_id, a.code, a.name, a.parent_id,
       a.type::text AS type, a.book::text AS book, a.currency, a.is_postable
  FROM account a
  JOIN per_business_rollup r ON r.code = a.code
  LEFT JOIN account p ON p.id = a.parent_id
 WHERE a.business_id IS NOT NULL
   AND (p.id IS NULL
     OR p.code        <> a.code
     OR p.business_id IS NOT NULL
     OR p.entity_id   <> a.entity_id
     OR a.type        <> p.type
     OR a.book        <> p.book
     OR a.currency    <> p.currency
     OR a.is_postable  = false);

GRANT SELECT ON
  v_business_accounts,
  v_approved_without_accounts,
  v_account_opened_outside_approval,
  v_business_account_malformed
TO corgi_app;
