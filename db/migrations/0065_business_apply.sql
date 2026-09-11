-- =====================================================================
-- 0065  A BUSINESS CAN APPLY  -  the definer function `/client/open`
--       was missing, and the applicant that is NOT an account
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- 1.  THE GAP
-- ---------------------------------------------------------------------
--
-- `/client/open` is a real application form that runs a REAL registry
-- check (`probeRegistry()` -> GLEIF, live, key-less, CC0).  It then stops
-- and hands over to a human, and its own header says exactly why:
--
--     db/migrations/0001_ledger.sql:839
--       GRANT SELECT ON account, business, actor, book_entity, ... TO corgi_app
--
-- SELECT and only SELECT.  `src/lib/ledger/db.ts` connects as that role,
-- so no screen can create a `business` row, which means no screen can
-- file a `kyb_verification_leg` (it is `NOT NULL REFERENCES business(id)`)
-- and no screen can start a director identity session against anything.
-- An applicant could be told what the register said and nothing more.
--
-- THAT GRANT IS NOT A BUG AND THIS MIGRATION DOES NOT WIDEN IT.  Creating
-- an entity record decides WHO IS ON THE BOOK; an application role holding
-- INSERT on `business` and `actor` could mint a customer, mint a human
-- actor with `can_approve`, and attach both to any entity.  The missing
-- piece is the same piece 0021 supplied one table over: one SECURITY
-- DEFINER function with a pinned `search_path`, revoked from PUBLIC,
-- granted to `corgi_app`, that performs EXACTLY ONE act and reads every
-- field it does not need the caller's word for out of the book itself.
--
-- 0021 §"WHY A SECURITY DEFINER FUNCTION AND NOT A GRANT" is the argument
-- and it is not restated here.  What follows is what is DIFFERENT about
-- this one, because the difference is the whole risk.
--
-- ---------------------------------------------------------------------
-- 2.  IT CREATES AN APPLICANT.  AN APPLICANT IS NOT AN ACCOUNT.
-- ---------------------------------------------------------------------
--
-- `business_accounts_open()` is called BY an approval.  This function is
-- called by a stranger over the public internet: a server action is a
-- public POST endpoint and every field arriving at it is a CLAIM.  So the
-- two functions sit on opposite sides of the check and must not be
-- confused:
--
--     business_apply()          reads nothing, opens nothing, and creates
--                               the row the checks are ABOUT.
--     business_accounts_open()  reads v_business_kyb and opens the chart
--                               only when it says `approved`.
--
-- This function DOES NOT CALL THE OTHER ONE and must never be changed to.
-- `src/components/client/contract.ts` models the boundary as "no `2100`
-- leaf means KYB has not let them in", and that sentence stays true here
-- for a reason stronger than restraint: to open a leaf, a business needs
-- `v_business_kyb.kyb_status = 'approved'`, and §3 shows an applicant
-- cannot reach that status through this function at all.
--
-- ---------------------------------------------------------------------
-- 3.  AN APPLICANT CANNOT SELF-APPROVE.  NOT "IS CHECKED" - CANNOT.
-- ---------------------------------------------------------------------
--
-- The obvious shape for this function would take the registry answer as
-- an argument and file it as a `kyb_verification_leg` in the same call.
-- That shape is REFUSED here, and the refusal is the design:
--
--     a `p_registry_status kyb_status` parameter is a status a stranger
--     types into a POST body.
--
-- So the argument list of `business_apply()` contains NO `kyb_status`, NO
-- `kyb_evidence`, NO boolean that could read as a verdict, and the body
-- contains no INSERT into `kyb_verification_leg` and no UPDATE of
-- anything.  §7's proof asserts both mechanically, out of the catalog,
-- rather than by reading the source: an argument list is checkable, and a
-- promise is not.
--
-- The legs are appended AFTERWARDS, by `beginVerification()` in
-- `src/lib/kyb/wire.ts` - the same function the operator console calls,
-- running the same two live adapters (Stripe Identity for director KYC,
-- GLEIF for the register).  corgi_app holds `INSERT ON
-- kyb_verification_leg` (0005 §212) and always has; what it did not have
-- was a `business` row to hang one off.  That is what this function
-- supplies, and it supplies nothing else.
--
-- The consequence, stated as a chain that can be checked link by link:
--
--   * a brand-new applicant has ZERO legs on file;
--   * `v_business_kyb` reads `pending` below two legs, unconditionally
--     (0005: `WHEN COALESCE(r.legs_on_file, 0) < 2 THEN 'pending'`);
--   * `business_accounts_open()` raises 42501 on anything but `approved`;
--   * so no `2100` leaf exists, and the applicant has no account.
--
-- And once the legs ARE filed by the live adapters, the composite still
-- cannot be approved on this path, because `v_business_kyb` folds the
-- STRICTEST leg (`max(status)` over an enum ordered approved < pending <
-- needs_review < rejected) and a freshly created Stripe Identity session
-- is `requires_input`, which `STRIPE_IDENTITY_STATUS_MAP` maps to
-- `pending`.  The weakest leg decides.  That is the same rule
-- `strictestOf()` applies on the screen, and it is why the screen can
-- show a live registry `approved` beside an application that is pending:
-- reporting the weaker leg rather than averaging them is the point.
--
-- ---------------------------------------------------------------------
-- 4.  ONE BUSINESS, ONE EIN.  A SECOND APPLICATION RETURNS THE FIRST.
-- ---------------------------------------------------------------------
--
-- A form that can be submitted twice WILL be submitted twice - a
-- double-click, a retry after a timeout, a refresh.  Two `business` rows
-- for one company is not a cosmetic duplicate: each would carry its own
-- KYB legs and its own chart, so the same company could be `rejected` on
-- one row and open an account on the other.
--
-- The rule is a UNIQUE INDEX and not a check-then-insert.  `SELECT ... IF
-- NOT FOUND THEN INSERT` is a race with a pretty face (0021's words), so
-- the insert is attempted with `ON CONFLICT DO NOTHING` and the conflict
-- IS the answer:
--
--   * a second application with the same EIN RETURNS THE EXISTING
--     applicant with `created = false`.  Deterministic, idempotent, and
--     it writes no second `business`, no second set of director actors
--     and no second application row.
--   * the EIN is normalised to nine digits first (`12-3456789` and
--     `123456789` are one EIN), so the rule cannot be dodged with a
--     hyphen.
--   * an EIN that already belongs to a business ON THE BOOK but with NO
--     application - a customer staff onboarded through `/onboarding` -
--     is REFUSED with 42501 and nothing is created.  Returning that
--     business would let a stranger who guesses an EIN attach directors
--     to somebody else's company, which is worse than a duplicate.
--
-- The oracle question, honestly: any deterministic answer to "this EIN is
-- already known" leaks that it is known.  The mitigation is at the
-- surface, not here - `applyAction()` renders the SAME pending sentence
-- for a first application and a repeat, so the applicant-visible response
-- does not distinguish them.  The refusal in the third case is visible,
-- and is judged the lesser leak than hijack.
--
-- ---------------------------------------------------------------------
-- 5.  WHAT THE CALLER'S WORD IS ACCEPTED FOR, AND WHAT IT IS NOT
-- ---------------------------------------------------------------------
--
--   accepted as a CLAIM, stored as a claim, believed by nothing:
--     legal name, EIN, registered address, asserted LEI, director names
--     and emails.  They are what the applicant typed.  `business_application`
--     is named for exactly that and its rows are evidence of a submission,
--     never of a fact.
--
--   NOT accepted from the caller, read from the book instead:
--     the entity the business belongs to (resolved from `book_entity`;
--     a caller who could choose it could put a customer on the wrong
--     book), `actor.kind` (always `human`), `actor.can_approve` (always
--     false - a director's approval rights are a team decision made on
--     `/team` under 0033's maker-checker, not something asserted on a
--     signup form), and the application's state (always `pending`, and
--     the CHECK below makes any other value unrepresentable).
--
-- ---------------------------------------------------------------------
-- 6.  APPEND-ONLY, like every other evidence table in this book
-- ---------------------------------------------------------------------
--
-- `business_application` carries `ledger_row_is_immutable()`, the same
-- trigger `account_opening` and the KYB evidence use.  An application is
-- a thing somebody SUBMITTED at a moment; editing it afterwards would
-- destroy the only record of what was actually claimed.  A corrected
-- application is a new submission, and the EIN rule above decides what
-- that means.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 7.  The applicant's claim, as a row
-- ---------------------------------------------------------------------

CREATE TABLE business_application (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One application per business row, both ways: this is the row that
  -- says "this business exists because somebody applied".
  business_id   uuid NOT NULL UNIQUE REFERENCES business(id),

  -- THE UNIQUENESS RULE (§4).  Nine digits, hyphens stripped by the
  -- function before it gets here; the CHECK means a row that dodged the
  -- normalisation cannot exist to be missed by the unique index.
  ein_digits    text NOT NULL UNIQUE,

  -- The claim, verbatim as typed.  Believed by nothing.
  legal_name    text  NOT NULL,
  registered_address jsonb NOT NULL,
  -- Optional; '' is stored as NULL so "asserted no LEI" has one spelling.
  asserted_lei  text,
  directors_declared smallint NOT NULL,

  -- THE STATE, AND IT HAS ONE VALUE.  Not an enum with an `approved`
  -- member nobody writes: a column whose only representable value is
  -- `pending`.  An approved application row cannot exist, so "did this
  -- applicant approve themselves?" is not a query over contents - the
  -- row shape answers it.  Approval, when it happens, is a
  -- `kyb_verification_leg` written by a live provider adapter and folded
  -- by `v_business_kyb`; it is never a column on the applicant's own
  -- submission.
  state         text NOT NULL DEFAULT 'pending',

  submitted_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_application_ein_is_digits CHECK (ein_digits ~ '^\d{9}$'),
  CONSTRAINT business_application_lei_shape
    CHECK (asserted_lei IS NULL OR asserted_lei ~ '^[A-Z0-9]{20}$'),
  CONSTRAINT business_application_directors CHECK (directors_declared BETWEEN 1 AND 8),
  -- §3, as a constraint.  This is the line a reviewer greps for.
  CONSTRAINT business_application_never_approved CHECK (state = 'pending')
);

CREATE INDEX business_application_submitted_idx ON business_application (submitted_at DESC);

COMMENT ON TABLE business_application IS
  'What a business claimed about itself on /client/open, and nothing more. Append-only. `state` can only ever be `pending` - an approved application is unrepresentable, because approval is a kyb_verification_leg written by a provider and folded by v_business_kyb, never a column on the applicant''s own submission. See db/migrations/0065_business_apply.sql.';

COMMENT ON COLUMN business_application.ein_digits IS
  'The EIN, nine digits, hyphens stripped. UNIQUE: one company cannot apply twice and get two entities. A repeat application returns the first one.';

CREATE TRIGGER business_application_no_update_delete
  BEFORE UPDATE OR DELETE ON business_application
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER business_application_no_truncate
  BEFORE TRUNCATE ON business_application
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- SELECT and nothing else, the same shape as `account_opening`: the rows
-- are written by the definer function below or not at all.
GRANT SELECT ON business_application TO corgi_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON business_application FROM corgi_app, PUBLIC;


-- ---------------------------------------------------------------------
-- 8.  The function.  One act: an applicant appears on the book.
-- ---------------------------------------------------------------------
--
-- Returns one row.  `created` says whether THIS call is the one that made
-- the applicant, the same way `business_accounts_open()` returns `opened`
-- - idempotence you can SEE rather than infer from the absence of an
-- error.
--
-- NOTE THE ARGUMENT LIST.  No status, no evidence, no verdict, no actor
-- id (the directors are created here; there is nobody to attribute this
-- to yet, which is exactly what being an applicant means).

CREATE OR REPLACE FUNCTION business_apply(
  p_legal_name          text,
  p_ein                 text,
  p_registered_address  jsonb,
  p_asserted_lei        text    DEFAULT NULL,
  p_directors           jsonb   DEFAULT '[]'::jsonb,
  p_entity_code         text    DEFAULT NULL
) RETURNS TABLE (
  business_id      uuid,
  application_id   uuid,
  created          boolean,
  state            text,
  directors_on_file integer
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_entity     uuid;
  v_entities   integer;
  v_ein        text;
  v_lei        text;
  v_name       text;
  v_count      integer;
  v_new_biz    uuid;
  v_app        uuid;
  v_director   jsonb;
  v_dname      text;
  v_demail     text;
  v_existing   uuid;
BEGIN
  -- ---- the claim, shape-checked before anything is written ----------
  -- Refusals here are 22023 (invalid_parameter_value), not 42501: this
  -- is "that is not an application", not "you may not apply".
  v_name := btrim(COALESCE(p_legal_name, ''));
  IF length(v_name) < 2 OR length(v_name) > 200 THEN
    RAISE EXCEPTION 'APPLICATION_INVALID: a legal name is 2..200 characters; got %', length(v_name)
      USING ERRCODE = '22023';
  END IF;

  -- §4: the EIN is normalised BEFORE the uniqueness rule sees it, so a
  -- hyphen cannot buy a second entity.
  v_ein := regexp_replace(COALESCE(p_ein, ''), '[^0-9]', '', 'g');
  IF v_ein !~ '^\d{9}$' THEN
    RAISE EXCEPTION 'APPLICATION_INVALID: an EIN is nine digits, written 12-3456789'
      USING ERRCODE = '22023';
  END IF;

  v_lei := NULLIF(upper(btrim(COALESCE(p_asserted_lei, ''))), '');
  IF v_lei IS NOT NULL AND v_lei !~ '^[A-Z0-9]{20}$' THEN
    RAISE EXCEPTION 'APPLICATION_INVALID: a Legal Entity Identifier is twenty letters and digits (ISO 17442)'
      USING ERRCODE = '22023';
  END IF;

  IF p_registered_address IS NULL OR jsonb_typeof(p_registered_address) <> 'object' THEN
    RAISE EXCEPTION 'APPLICATION_INVALID: a registered address object is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_directors IS NULL OR jsonb_typeof(p_directors) <> 'array' THEN
    RAISE EXCEPTION 'APPLICATION_INVALID: directors must be a json array'
      USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_directors);
  IF v_count < 1 OR v_count > 8 THEN
    RAISE EXCEPTION 'APPLICATION_INVALID: a business account needs 1..8 directors; got %', v_count
      USING ERRCODE = '22023';
  END IF;

  -- ---- the entity, read from the book and never from the caller -----
  IF p_entity_code IS NULL THEN
    SELECT count(*) INTO v_entities FROM book_entity;
    IF v_entities <> 1 THEN
      RAISE EXCEPTION
        'APPLICATION_AMBIGUOUS_ENTITY: this book carries % entities, so an applicant''s entity must be named explicitly', v_entities
        USING ERRCODE = '22023';
    END IF;
    SELECT e.id INTO v_entity FROM book_entity e;
  ELSE
    SELECT e.id INTO v_entity FROM book_entity e WHERE e.code = p_entity_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'APPLICATION_INVALID: no entity on this book has code %', p_entity_code
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- ---- §4, case 1: this EIN already applied -------------------------
  -- Read first, because the answer is "here is your application" and not
  -- a write.  The unique index below is what makes the RACING case safe;
  -- this read is what makes the common case cheap and silent.
  SELECT a.id, a.business_id INTO v_app, v_existing
    FROM business_application a WHERE a.ein_digits = v_ein;

  IF FOUND THEN
    business_id := v_existing;
    application_id := v_app;
    created := false;
    state := 'pending';
    SELECT count(*) INTO directors_on_file FROM actor ac WHERE ac.business_id = v_existing;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ---- §4, case 3: this EIN is a customer, not an applicant ---------
  -- Somebody staff onboarded, who never came through this form.  Do not
  -- attach, do not create, do not return their id.
  PERFORM 1 FROM business b
    WHERE regexp_replace(COALESCE(b.ein, ''), '[^0-9]', '', 'g') = v_ein;
  IF FOUND THEN
    RAISE EXCEPTION
      'EIN_ALREADY_ON_BOOK: that EIN belongs to a business already on this book which did not come through this form. An application cannot attach itself to an existing customer; a reviewer has to connect you to it'
      USING ERRCODE = '42501',
            CONSTRAINT = 'business_application_ein_on_book';
  END IF;

  -- ---- the applicant -------------------------------------------------
  -- `business.ein` is stored normalised, so the next applicant's §4 read
  -- sees a comparable value.
  INSERT INTO business (id, entity_id, legal_name, ein)
  VALUES (gen_random_uuid(), v_entity, v_name, v_ein)
  RETURNING id INTO v_new_biz;

  -- The application row.  `state` is not passed in and cannot be: the
  -- column's default is its only representable value (§7).
  INSERT INTO business_application
    (business_id, ein_digits, legal_name, registered_address, asserted_lei, directors_declared)
  VALUES (v_new_biz, v_ein, v_name, p_registered_address, v_lei, v_count)
  -- The race, and the only place it can be decided: two first-writers of
  -- the same EIN.  The loser reads the winner's row rather than raising,
  -- because a double-submit is not an error.
  ON CONFLICT (ein_digits) DO NOTHING
  RETURNING id INTO v_app;

  IF v_app IS NULL THEN
    -- We lost the race.  Our `business` insert is rolled back with this
    -- statement's subtransaction only if it were in one - it is not, so
    -- raise: the caller retries and takes the cheap path above.  A
    -- serialisation refusal is the right direction to fail in.
    RAISE EXCEPTION
      'APPLICATION_RACED: another application for this EIN committed while this one was being written; submit again and you will be shown it'
      USING ERRCODE = '40001';
  END IF;

  -- ---- the directors, as actors -------------------------------------
  -- `kind` is always human and `can_approve` is always false (§5). A
  -- signup form does not grant approval rights; `/team` does, under
  -- 0033's maker-checker.
  directors_on_file := 0;
  FOR v_director IN SELECT * FROM jsonb_array_elements(p_directors)
  LOOP
    v_dname := btrim(COALESCE(v_director->>'fullName', ''));
    v_demail := NULLIF(btrim(COALESCE(v_director->>'email', '')), '');
    IF length(v_dname) < 2 OR length(v_dname) > 200 THEN
      RAISE EXCEPTION 'APPLICATION_INVALID: a director needs a full legal name'
        USING ERRCODE = '22023';
    END IF;
    IF v_demail IS NULL THEN
      RAISE EXCEPTION 'APPLICATION_INVALID: a director needs a contactable email address'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO actor (id, kind, display_name, email, business_id, can_approve)
    VALUES (gen_random_uuid(), 'human', v_dname, v_demail, v_new_biz, false);
    directors_on_file := directors_on_file + 1;
  END LOOP;

  business_id := v_new_biz;
  application_id := v_app;
  created := true;
  state := 'pending';
  RETURN NEXT;
END $$;

ALTER FUNCTION business_apply(text, text, jsonb, text, jsonb, text)
  SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION business_apply(text, text, jsonb, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_apply(text, text, jsonb, text, jsonb, text) TO corgi_app;

COMMENT ON FUNCTION business_apply(text, text, jsonb, text, jsonb, text) IS
  'Creates an APPLICANT: one business row, its director actors and the application that claimed them. Opens no account, files no KYB leg, and takes no status argument - an applicant cannot reach v_business_kyb through this function at all. Idempotent on the normalised EIN: a second application returns the first. See db/migrations/0065_business_apply.sql.';


-- ---------------------------------------------------------------------
-- 9.  The applicant's own view: where an application got to
-- ---------------------------------------------------------------------
--
-- One row per application, carrying the derived KYB state beside it and
-- whether a deposit leaf exists.  `has_deposit_account` is the sentence
-- `src/components/client/contract.ts` models, computed rather than
-- claimed - and for an applicant it is false until the legs say
-- otherwise, which is the whole point.

CREATE VIEW v_business_application AS
SELECT a.id                AS application_id,
       a.business_id,
       a.legal_name,
       a.state             AS application_state,
       a.submitted_at,
       a.directors_declared,
       a.asserted_lei,
       k.kyb_status,
       k.kyb_evidence,
       k.legs_on_file,
       EXISTS (SELECT 1 FROM account ac
                WHERE ac.business_id = a.business_id
                  AND ac.code = '2100'
                  AND ac.book = 'financial') AS has_deposit_account
  FROM business_application a
  LEFT JOIN v_business_kyb k ON k.business_id = a.business_id;

COMMENT ON VIEW v_business_application IS
  'Where each application got to: the claim, the derived KYB fold, and whether a deposit leaf exists yet. An applicant with has_deposit_account = false and kyb_status <> approved is the system working.';

GRANT SELECT ON v_business_application TO corgi_app;

-- MUST BE EMPTY.  The claim this migration makes, as a query: no
-- application may have an account without an approval behind it.  An
-- applicant whose KYB is not `approved` and who nonetheless has a `2100`
-- leaf would mean something opened an account off an application - either
-- this function grew a call it must not have, or the privilege boundary
-- moved.
CREATE VIEW v_applicant_with_unearned_account AS
SELECT v.application_id, v.business_id, v.legal_name, v.kyb_status, v.legs_on_file
  FROM v_business_application v
 WHERE v.has_deposit_account
   AND COALESCE(v.kyb_status::text, 'pending') <> 'approved';

COMMENT ON VIEW v_applicant_with_unearned_account IS
  'MUST BE EMPTY. An applicant holding a deposit leaf without an approved KYB fold. See db/migrations/0065_business_apply.sql section 10.';

GRANT SELECT ON v_applicant_with_unearned_account TO corgi_app;


-- ---------------------------------------------------------------------
-- 10.  The migration refuses to commit unless it can PROVE the function
-- ---------------------------------------------------------------------
--
-- 0062 §10's shape, and 0062's reason for it verbatim: a definer that
-- returns true having done nothing passes every other check.  So the
-- function is CALLED, against a throwaway applicant, inside a
-- subtransaction that ends by raising - nothing it writes survives, and
-- the proof is of behaviour rather than of source text.
--
-- Three claims, each asserted the way it is stated:
--
--   10.2  THE GRANT.  corgi_app can execute it; PUBLIC cannot.  Read out
--         of the catalog with has_function_privilege, not by eyeballing
--         the GRANT above.
--   10.3  NO VERDICT IN THE ARGUMENT LIST.  §3's claim, checked against
--         pg_proc: an applicant can pass nothing of type kyb_status or
--         kyb_evidence, because no such parameter exists.
--   10.4  AN APPLICANT CANNOT REACH APPROVED.  The function is called and
--         the resulting state is read: zero legs, `pending`, no deposit
--         leaf, and `business_accounts_open()` REFUSES that business.
--         The last one is the load-bearing assertion - it proves the
--         applicant is on the wrong side of the gate that already exists,
--         rather than merely on the near side of one this file invented.
--   10.5  THE EIN RULE.  Apply twice with the same EIN written two
--         different ways; the second call must return the first business
--         with created = false, and exactly one business row may carry
--         that EIN.  Then a third application for an EIN that belongs to
--         a business already on the book must be refused.

DO $$
DECLARE
  v_app_exec    boolean;
  v_pub_exec    boolean;
  v_verdict_arg text;
  v_biz         uuid;
  v_biz2        uuid;
  v_app_id      uuid;
  v_created     boolean;
  v_dirs        integer;
  v_legs        integer;
  v_status      text;
  v_deposit     boolean;
  v_rows        integer;
  v_unearned    integer;
  v_gate        text;
  v_onbook      text;
  v_probe_ein   text := '99-0000065';
BEGIN
  -- ---- 10.1  the book this arrives on -------------------------------
  SELECT count(*) INTO v_unearned FROM v_applicant_with_unearned_account;
  IF v_unearned <> 0 THEN
    RAISE EXCEPTION
      '0065 refuses to commit: v_applicant_with_unearned_account = % (must be 0)', v_unearned;
  END IF;

  -- ---- 10.2  the grant ----------------------------------------------
  SELECT has_function_privilege('corgi_app',
           'business_apply(text,text,jsonb,text,jsonb,text)', 'EXECUTE')
    INTO v_app_exec;
  SELECT has_function_privilege('public',
           'business_apply(text,text,jsonb,text,jsonb,text)', 'EXECUTE')
    INTO v_pub_exec;

  IF NOT v_app_exec THEN
    RAISE EXCEPTION
      '0065 refuses to commit: corgi_app cannot EXECUTE business_apply() - the function exists and the application still cannot apply';
  END IF;
  IF v_pub_exec THEN
    RAISE EXCEPTION
      '0065 refuses to commit: PUBLIC can EXECUTE business_apply() - a definer function granted to PUBLIC is a definer function granted to everybody';
  END IF;

  -- ---- 10.3  no verdict can be passed in ----------------------------
  SELECT string_agg(t.typname, ', ') INTO v_verdict_arg
    FROM pg_proc p
    CROSS JOIN LATERAL unnest(p.proargtypes) AS a(oid)
    JOIN pg_type t ON t.oid = a.oid
   WHERE p.proname = 'business_apply'
     AND t.typname IN ('kyb_status', 'kyb_evidence');
  IF v_verdict_arg IS NOT NULL THEN
    RAISE EXCEPTION
      '0065 refuses to commit: business_apply() takes % as an argument - a verdict an applicant can type into a POST body is a verdict an applicant can assert',
      v_verdict_arg;
  END IF;

  -- ---- the probe: everything below is rolled back -------------------
  BEGIN
    SELECT r.business_id, r.application_id, r.created, r.directors_on_file
      INTO v_biz, v_app_id, v_created, v_dirs
      FROM business_apply(
             'Probe Applicant 0065, Inc.',
             v_probe_ein,
             '{"street1":"1 Probe Way","city":"Probeville","subdivision":"CA","postalCode":"94000"}'::jsonb,
             NULL,
             '[{"fullName":"Probe Director","email":"probe@example.invalid"}]'::jsonb,
             NULL) r;

    IF NOT v_created OR v_biz IS NULL OR v_app_id IS NULL THEN
      RAISE EXCEPTION '0065 refuses to commit: business_apply() created no applicant (created=%, business=%)', v_created, v_biz;
    END IF;
    IF v_dirs <> 1 THEN
      RAISE EXCEPTION '0065 refuses to commit: business_apply() filed % director actor(s) for one declared director', v_dirs;
    END IF;

    -- ---- 10.4  the applicant is on the wrong side of the gate -------
    SELECT count(*) INTO v_legs FROM kyb_verification_leg WHERE business_id = v_biz;
    IF v_legs <> 0 THEN
      RAISE EXCEPTION
        '0065 refuses to commit: business_apply() filed % KYB leg(s). It must file none - a leg written by the function that the applicant called is a leg the applicant wrote',
        v_legs;
    END IF;

    SELECT k.kyb_status::text INTO v_status FROM v_business_kyb k WHERE k.business_id = v_biz;
    IF v_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION
        '0065 refuses to commit: a brand-new applicant reads kyb_status = % and must read pending', COALESCE(v_status, '<no row>');
    END IF;

    SELECT v.has_deposit_account INTO v_deposit
      FROM v_business_application v WHERE v.business_id = v_biz;
    IF v_deposit THEN
      RAISE EXCEPTION
        '0065 refuses to commit: the applicant has a deposit account. An application is not an account';
    END IF;

    -- The load-bearing one: the gate that already exists refuses them.
    v_gate := NULL;
    BEGIN
      PERFORM * FROM business_accounts_open(v_biz,
                (SELECT id FROM actor WHERE business_id = v_biz LIMIT 1));
      v_gate := 'OPENED';
    EXCEPTION WHEN insufficient_privilege THEN
      v_gate := SQLERRM;
    END;
    IF v_gate = 'OPENED' THEN
      RAISE EXCEPTION
        '0065 refuses to commit: business_accounts_open() OPENED accounts for a fresh applicant. The applicant reached approved';
    END IF;

    -- ---- 10.5  the EIN rule -----------------------------------------
    SELECT r.business_id, r.created INTO v_biz2, v_created
      FROM business_apply(
             'Probe Applicant 0065, Inc. (again)',
             '990000065',                      -- same EIN, written without the hyphen
             '{"street1":"1 Probe Way","city":"Probeville","subdivision":"CA","postalCode":"94000"}'::jsonb,
             NULL,
             '[{"fullName":"Probe Director","email":"probe@example.invalid"}]'::jsonb,
             NULL) r;

    IF v_created THEN
      RAISE EXCEPTION '0065 refuses to commit: a second application for the same EIN created a second applicant';
    END IF;
    IF v_biz2 IS DISTINCT FROM v_biz THEN
      RAISE EXCEPTION
        '0065 refuses to commit: a second application for EIN % returned business % and not % - the rule is not deterministic',
        v_probe_ein, v_biz2, v_biz;
    END IF;

    SELECT count(*) INTO v_rows FROM business
     WHERE regexp_replace(COALESCE(ein, ''), '[^0-9]', '', 'g') = '990000065';
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '0065 refuses to commit: % business rows carry the probe EIN; one company, one entity', v_rows;
    END IF;

    -- An EIN that belongs to a business already on the book, applied for
    -- by a stranger, must be refused rather than handed over.
    v_onbook := NULL;
    BEGIN
      PERFORM * FROM business_apply(
        'Hijack Attempt, Inc.',
        (SELECT regexp_replace(COALESCE(b.ein, ''), '[^0-9]', '', 'g')
           FROM business b
           LEFT JOIN business_application ba ON ba.business_id = b.id
          WHERE ba.id IS NULL
            AND regexp_replace(COALESCE(b.ein, ''), '[^0-9]', '', 'g') ~ '^\d{9}$'
          ORDER BY b.created_at LIMIT 1),
        '{"street1":"1 Probe Way","city":"Probeville","subdivision":"CA","postalCode":"94000"}'::jsonb,
        NULL,
        '[{"fullName":"Probe Director","email":"probe@example.invalid"}]'::jsonb,
        NULL);
      v_onbook := 'ACCEPTED';
    EXCEPTION WHEN insufficient_privilege THEN
      v_onbook := 'REFUSED';
    END;
    IF v_onbook <> 'REFUSED' THEN
      RAISE EXCEPTION
        '0065 refuses to commit: an application quoting an existing customer''s EIN was % - it must be refused, or a stranger attaches directors to somebody else''s company',
        v_onbook;
    END IF;

    RAISE EXCEPTION 'PROBE_ROLLBACK: applicant %, application %, gate said: %', v_biz, v_app_id, left(v_gate, 120);
  EXCEPTION WHEN raise_exception THEN
    IF position('PROBE_ROLLBACK' in SQLERRM) = 0 THEN
      RAISE;
    END IF;
    RAISE NOTICE '0065 proof: %', SQLERRM;
  END;

  RAISE NOTICE '0065: business_apply() is executable by corgi_app and not by PUBLIC, takes no kyb_status/kyb_evidence argument, files no KYB leg, leaves its applicant at pending with no deposit account and refused by business_accounts_open(), and returns the first application for a repeated EIN. The probe applicant was rolled back.';
END $$;
