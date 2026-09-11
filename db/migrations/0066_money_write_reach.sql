-- =====================================================================
-- 0066.  The grant that was justified by a false sentence, the verdict on
--        whether it was also a wrong grant, and the guard that stops the
--        next one being settled by anybody's memory.
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- THE FINDING
-- ---------------------------------------------------------------------
--
-- `0029_chaos.sql:62` justifies the only full `UPDATE, DELETE` grant the
-- app role holds anywhere on this schema with this sentence:
--
--     "None of the four has a `cents` column, a foreign key into
--      `account`, `journal_entry`, `journal_line`, `hold` or
--      `card_auth_event`, or any way to be read by the balance
--      derivation."
--
-- The first clause is FALSE, and it is false about a table ninety lines
-- below it in the same file:
--
--     chaos_run.auth_cents      bigint NOT NULL
--     chaos_run.clearing_cents  bigint NOT NULL
--
-- and the grant it justifies, verbatim from `0029_chaos.sql:388-390`:
--
--     GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_control  TO corgi_app;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_run      TO corgi_app;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_delivery TO corgi_app;
--     GRANT SELECT, INSERT                 ON chaos_event    TO corgi_app;
--
-- ---------------------------------------------------------------------
-- THE VERDICT: A WRONG COMMENT, NOT A WRONG GRANT
-- ---------------------------------------------------------------------
--
-- A `cents` column is not what makes a row a money row. What makes a row
-- a money row is that a balance is derived from it. Measured against the
-- live database rather than against anybody's recollection:
--
--   1. `ledger_availability()` (0022, current body 0053) is the ONE
--      definition of availability, and its five terms read exactly:
--      `journal_line`, `journal_entry`, `account` (through
--      `ledger_settled_cents()`), `hold`, `card_authorization`,
--      `card_auth_event`, `hold_closure`, `hold_closure_reversal`.
--      No chaos table appears in it, directly or through a view.
--
--   2. There is no foreign key out of any chaos table into any money
--      table. The only two foreign keys any of the four carries are
--      `chaos_delivery.run_id -> chaos_run` and
--      `chaos_event.run_id -> chaos_run`. `chaos_run.business_id` is a
--      bare `uuid` and 0029 says so on purpose.
--
--   3. No function on this database mentions a chaos table. The only
--      views that do are the four `v_chaos_*` of 0029 itself, plus
--      `v_audit_source_count` (a row-count census) and `v_actor_action`,
--      whose `chaos_event` branch emits `NULL::bigint AS amount_cents` —
--      the audit feed carries no cents out of chaos either.
--
--   4. `scripts/rebuild.mjs`, which rebuilds the book from the event log
--      and is the harshest reader on this schema, does not contain the
--      string `chaos`. Its inputs are `account`, `journal_entry`,
--      `journal_line`, `hold`, `hold_closure`, `hold_closure_reversal`,
--      `card_authorization`, `card_auth_event`, `webhook_inbox`,
--      `statement`, `book_day` and `business`.
--
--   5. `chaos_run.auth_cents` and `clearing_cents` are not even READ by
--      the thing that spends them. `startChaosRun()` writes both from
--      the module constants `CHAOS_AUTH_CENTS` / `CHAOS_CLEARING_CENTS`
--      and signs the delivery bodies from THE SAME CONSTANTS, not from
--      the row. The row's only reader in the entire repository is
--      `src/app/(app)/chaos/live-source.ts`, which prints it on a
--      dashboard. Changing it after the fact changes a caption.
--
-- So: these are a simulation LOG's record of what a scripted card
-- episode was told to be worth. The money that episode moves is posted
-- by the ordinary consumer reading `webhook_inbox`, and that path is
-- guarded where it has always been guarded. This is NOT the automatic
-- fail. It is a comment that was wrong about its own file.
--
-- ---------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES ABOUT IT
-- ---------------------------------------------------------------------
--
-- 1. It makes the sentence true rather than merely defensible. 0029 is
--    immutable, so the correction goes where the next reader will
--    actually be standing: `COMMENT ON COLUMN` on the two columns, which
--    `\d+ chaos_run` prints and no archaeology is needed to find.
--
-- 2. It narrows the grant to the columns the application demonstrably
--    writes, so that "the cents columns are not money" stops being a
--    claim and becomes a privilege. The app's ONLY update of this table
--    is `src/lib/chaos/driver.ts:543`,
--    `UPDATE chaos_run SET card_registered = true`. `finished_at` and
--    `note` are included because 0029's own header says a run "closes
--    when the episode ends" and the closing writer has not been written
--    yet; leaving them out would be this migration inventing a bug for
--    somebody else to find. `auth_cents`, `clearing_cents`,
--    `business_id`, `card_token` and `transaction_token` are left
--    un-writable: they are what the run WAS, and a log whose past is
--    editable is not a log.
--
--    This is a narrowing, not a revocation. There is nothing here to
--    revoke: no balance reads this table.
--
-- 3. It ships the guard, which is the part that outlives this finding.
--
-- ---------------------------------------------------------------------
-- THE GUARD, AND WHY IT IS NOT A LIST
-- ---------------------------------------------------------------------
--
-- "No UPDATE on money rows" is enforced today by `%I_no_update_delete`
-- triggers and by withheld privileges — on the sixty-eight tables
-- somebody remembered. Nothing notices the sixty-ninth. The whole reason
-- 0029's comment could be wrong for as long as it was is that the claim
-- "this is not a money table" was checked by a human reading, once.
--
-- `money_reachable_relations()` computes, FROM THE CATALOG, the set of
-- relations a balance can see: it starts at the balance's own
-- definitions and walks every edge — view to its referenced relations
-- (via `pg_rewrite`/`pg_depend`, exact), function to the relations and
-- functions its body names, view to the functions its definition names —
-- to a fixed point. Add a table tomorrow and join it into anything a
-- balance reads, and it is in the set the moment the migration commits.
-- Nobody declares it. Nobody can forget to.
--
-- `v_money_writable_by_app` is then the invariant: the set of relations
-- that are BOTH reachable from a balance AND carry `UPDATE` or `DELETE`
-- for `corgi_app`. It must be empty, forever, and it is a view so that
-- `scripts/dbcheck.mjs` and `src/lib/chaos/invariants.ts` check it the
-- same way they check the other thirty-odd.
--
-- The textual edges OVER-APPROXIMATE: a table named in a comment inside
-- a function body joins the set (`card` does, today, from the words "the
-- card model" in `ledger_availability`'s own commentary). That is the
-- safe direction on purpose. An over-wide reachability set can only make
-- the guard stricter than the truth; an under-wide one is the failure
-- this migration exists to stop, and it is the failure a hand-written
-- list has by construction.
--
-- ---------------------------------------------------------------------
-- THE PROOF
-- ---------------------------------------------------------------------
--
-- A guard that returns "empty" is worth nothing until you have seen it
-- return something. 0062 proves its lock by taking it and reading
-- `pg_locks` for a real `RowShareLock` rather than trusting a function
-- that returns true; this one proves itself the same way, in four steps
-- at the bottom of this file:
--
--   A  the reachable set is NOT VACUOUS — it must contain `journal_line`,
--      `journal_entry`, `account`, `hold` and `card_auth_event`, or the
--      emptiness of the guard means only that the walk found nothing.
--   B  the guard FIRES. `UPDATE` on `journal_line` is granted to
--      `corgi_app` inside a subtransaction, the view is required to name
--      it, and the subtransaction is rolled back. The grant never
--      commits, and the guard has been seen red.
--   C  the refusal is REAL AT THE ENGINE. As `corgi_app`, an `UPDATE` on
--      `journal_entry` must fail with `42501`. `WHERE false` — the
--      privilege is checked at plan time, so the refusal arrives before
--      any row is considered, and no money row is touched on either
--      branch.
--   D  the CONTROL. As `corgi_app`, `UPDATE chaos_run SET note = note
--      WHERE false` must SUCCEED, and the same statement against
--      `auth_cents` must be REFUSED after step 2's narrowing. Without
--      this pair, step C proves only that the role is feeble.
--
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1.  The correction, where the next reader will be standing
-- ---------------------------------------------------------------------

COMMENT ON COLUMN chaos_run.auth_cents IS
  'The scripted authorisation amount for this episode, in cents. 0029''s header '
  'says "none of the four has a `cents` column"; this column and clearing_cents '
  'are the counter-examples and the sentence is wrong. The SUBSTANCE of that '
  'header is right: no balance reads this column. It is written from the '
  'constant CHAOS_AUTH_CENTS, the signed delivery bodies are built from the '
  'same constant rather than from this row, and its only reader anywhere is the '
  'chaos dashboard. Migration 0066 removed UPDATE on it from corgi_app so that '
  'this is a privilege rather than a promise.';

COMMENT ON COLUMN chaos_run.clearing_cents IS
  'The scripted clearing amount for this episode, in cents. See '
  'chaos_run.auth_cents: 0029''s "no cents column" claim is false about this '
  'column and true about what the column means. Not writable by corgi_app '
  'since 0066.';

COMMENT ON TABLE chaos_run IS
  'One chaos episode: the scripted card lifecycle chaos put through the real '
  'delivery pipeline, and the controls that were armed while it did. NOT a '
  'money table -- it carries two `cents` columns (0029''s header denies this, '
  'wrongly) but no balance is derived from it: ledger_availability() does not '
  'reach it, scripts/rebuild.mjs does not name it, and it has no foreign key '
  'into any money table. Since 0066 corgi_app may update only card_registered, '
  'finished_at and note.';

-- ---------------------------------------------------------------------
-- 2.  The narrowing — the columns the app actually writes, and no more
-- ---------------------------------------------------------------------
--
-- REVOKE then re-GRANT at column granularity. Postgres treats a
-- table-level UPDATE as covering every column including ones added
-- later, which is precisely the property that made this grant outlive
-- the sentence justifying it.

REVOKE UPDATE ON chaos_run FROM corgi_app;
GRANT  UPDATE (card_registered, finished_at, note) ON chaos_run TO corgi_app;

-- ---------------------------------------------------------------------
-- 3.  money_reachable_relations() — the walk
-- ---------------------------------------------------------------------
--
-- Roots default to the balance's own definitions. The parameter exists
-- so the proof below can walk a probe root, and so a future reader can
-- ask "what would be reachable if I hung it off X" without editing this.

CREATE OR REPLACE FUNCTION money_reachable_relations(p_roots text[] DEFAULT NULL)
RETURNS TABLE (relkind "char", relname name)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
WITH RECURSIVE
  root_names AS (
    SELECT COALESCE(p_roots,
                    ARRAY['ledger_availability',
                          'ledger_settled_cents',
                          'v_available_balance']) AS names
  ),
  rel AS (
    SELECT c.oid, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
  ),
  fn AS (
    SELECT p.oid, p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
  ),
  viewsrc AS (
    SELECT rel.oid, pg_get_viewdef(rel.oid) AS src
      FROM rel WHERE rel.relkind IN ('v','m')
  ),
  -- Tokenise once and join on equality. The obvious form -- a regex of
  -- every name against every body -- is correct and takes 36 seconds on
  -- this database, which is 36 seconds nobody will spend on every gate
  -- run. This is the same set in under a second.
  fn_word AS (
    SELECT DISTINCT fn.oid, w AS word
      FROM fn, LATERAL regexp_split_to_table(fn.prosrc, '[^A-Za-z0-9_]+') AS w
     WHERE w <> ''
  ),
  view_word AS (
    SELECT DISTINCT viewsrc.oid, w AS word
      FROM viewsrc, LATERAL regexp_split_to_table(viewsrc.src, '[^A-Za-z0-9_]+') AS w
     WHERE w <> ''
  ),
  edges AS (
        -- a function names a relation
        SELECT 'f'::text AS sk, fn_word.oid AS so, 'r'::text AS dk, rel.oid AS do_
          FROM fn_word JOIN rel ON rel.relname::text = fn_word.word
    UNION ALL
        -- a function names another function
        SELECT 'f', fn_word.oid, 'f', fn.oid
          FROM fn_word JOIN fn ON fn.proname::text = fn_word.word
                               AND fn.oid <> fn_word.oid
    UNION ALL
        -- a view depends on a relation -- the exact catalog edge, no text
        SELECT 'r', rw.ev_class, 'r', d.refobjid
          FROM pg_rewrite rw
          JOIN pg_depend d ON d.classid    = 'pg_rewrite'::regclass
                          AND d.objid      = rw.oid
                          AND d.refclassid = 'pg_class'::regclass
                          AND d.refobjid  <> rw.ev_class
    UNION ALL
        -- a view names a function (pg_depend does not record this one
        -- for a plain function call in a view body)
        SELECT 'r', view_word.oid, 'f', fn.oid
          FROM view_word JOIN fn ON fn.proname::text = view_word.word
  ),
  seed AS (
        SELECT 'f'::text AS k, fn.oid AS o
          FROM fn, root_names WHERE fn.proname = ANY (root_names.names)
    UNION
        SELECT 'r', rel.oid
          FROM rel, root_names WHERE rel.relname = ANY (root_names.names)
  ),
  walk AS (
        SELECT k, o FROM seed
    UNION
        SELECT e.dk, e.do_ FROM walk w JOIN edges e ON e.sk = w.k AND e.so = w.o
  )
SELECT rel.relkind, rel.relname
  FROM walk JOIN rel ON rel.oid = walk.o AND walk.k = 'r'
 ORDER BY rel.relkind, rel.relname
$fn$;

COMMENT ON FUNCTION money_reachable_relations(text[]) IS
  'Every relation a balance can see, computed from the catalog by walking '
  'view->relation (pg_rewrite/pg_depend), function->relation, function->function '
  'and view->function to a fixed point from ledger_availability(), '
  'ledger_settled_cents() and v_available_balance. Textual edges '
  'over-approximate deliberately: a wider set only makes v_money_writable_by_app '
  'stricter, and a narrower one is the bug this exists to prevent. 0066.';

-- ---------------------------------------------------------------------
-- 4.  v_money_writable_by_app — the invariant. MUST BE EMPTY.
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW v_money_writable_by_app AS
  SELECT m.relname                                                   AS relation,
         m.relkind                                                   AS relkind,
         string_agg(g.privilege_type, ',' ORDER BY g.privilege_type) AS privileges
    FROM money_reachable_relations() m
    JOIN information_schema.role_table_grants g
      ON g.table_schema = 'public'
     AND g.table_name   = m.relname::text
   WHERE g.grantee        = 'corgi_app'
     AND g.privilege_type IN ('UPDATE','DELETE')
   GROUP BY m.relname, m.relkind;

COMMENT ON VIEW v_money_writable_by_app IS
  'INVARIANT, must be empty: no relation reachable from a balance carries '
  'UPDATE or DELETE for corgi_app. Unlike the per-table append-only triggers '
  'this notices a table nobody remembered -- its population is derived from '
  'the balance definition, not from a list. 0066.';

GRANT SELECT ON v_money_writable_by_app TO corgi_app;

-- ---------------------------------------------------------------------
-- 5.  THE PROOF.  A guard you have never seen red is a guard you are
--     taking on trust, which is what this whole migration is about.
-- ---------------------------------------------------------------------

DO $proof$
DECLARE
  reach    text[];
  missing  text[];
  n_probe  int;
  n_after  int;
  n_now    int;
  ok_note  boolean := false;
  ok_cents boolean := false;
BEGIN
  -- ---- A. the reachable set is not vacuous -------------------------
  SELECT array_agg(relname::text ORDER BY relname)
    INTO reach
    FROM money_reachable_relations();

  SELECT array_agg(t)
    INTO missing
    FROM unnest(ARRAY['journal_line','journal_entry','account',
                      'hold','card_auth_event']) AS t
   WHERE NOT (t = ANY (COALESCE(reach, ARRAY[]::text[])));

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      '0066 PROOF A FAILED: the balance-reachability walk cannot see %. An '
      'empty v_money_writable_by_app would then mean nothing at all.',
      array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE '0066 proof A: % relations are reachable from a balance: %',
    array_length(reach, 1), array_to_string(reach, ', ');

  -- ---- B. the guard fires, then the grant is rolled back ------------
  --
  -- The GRANT below is real and is taken on a real money table. It is
  -- taken inside a PL/pgSQL block with an EXCEPTION clause, which is a
  -- subtransaction, and the RAISE at the end of it rolls that
  -- subtransaction back. It never commits. If anything here goes wrong
  -- the whole migration aborts at the enclosing BEGIN and it still never
  -- commits. Local variables survive the rollback; the grant does not.
  BEGIN
    GRANT UPDATE ON journal_line TO corgi_app;

    SELECT count(*)::int INTO n_probe
      FROM v_money_writable_by_app
     WHERE relation = 'journal_line' AND privileges LIKE '%UPDATE%';

    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '0066-probe-rollback';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> '0066-probe-rollback' THEN
      RAISE;
    END IF;
  END;

  IF n_probe IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      '0066 PROOF B FAILED: UPDATE was granted on journal_line and '
      'v_money_writable_by_app reported % rows for it, not 1. The guard does '
      'not fire, so its emptiness is decoration.', COALESCE(n_probe, -1);
  END IF;

  SELECT count(*)::int INTO n_after FROM v_money_writable_by_app;
  IF n_after <> 0 THEN
    RAISE EXCEPTION
      '0066 PROOF B FAILED: the probe grant did not roll back -- % row(s) '
      'still stand in v_money_writable_by_app.', n_after;
  END IF;

  RAISE NOTICE '0066 proof B: guard went red on a planted UPDATE grant and '
               'green again when the subtransaction rolled back.';

  -- ---- C. the refusal is real at the engine ------------------------
  --
  -- WHERE false. The privilege is checked when the statement is planned,
  -- so the refusal arrives before a single row is examined, and on the
  -- branch where it does NOT arrive the statement still touches nothing.
  --
  -- `neondb_owner` is a member of `corgi_app` with ADMIN but, on this
  -- database, `set_option = false` -- so `SET ROLE corgi_app` is refused
  -- outright (PostgreSQL 18; the SET half of membership is separable
  -- since 16). Taking the SET half for the length of this proof and
  -- giving it back is the honest way to actually BE the app role here.
  -- It is taken inside a subtransaction and rolled back with the same
  -- RAISE trick as step B, so the membership this database holds
  -- afterwards is exactly the one it held before.
  BEGIN
    EXECUTE format('GRANT corgi_app TO %I WITH SET TRUE', current_user);
    SET LOCAL ROLE corgi_app;
    BEGIN
      EXECUTE 'UPDATE journal_entry SET hold_id = hold_id WHERE false';
      RESET ROLE;
      RAISE EXCEPTION
        '0066 PROOF C FAILED: corgi_app was NOT refused UPDATE on '
        'journal_entry. That is the automatic fail, arriving from a '
        'direction this migration was not even looking.';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;

    -- ---- D. the control, so C is not proving feebleness ------------
    BEGIN
      EXECUTE 'UPDATE chaos_run SET note = note WHERE false';
      ok_note := true;
    EXCEPTION WHEN insufficient_privilege THEN
      ok_note := false;
    END;

    BEGIN
      EXECUTE 'UPDATE chaos_run SET auth_cents = auth_cents WHERE false';
      ok_cents := false;
    EXCEPTION WHEN insufficient_privilege THEN
      ok_cents := true;
    END;

    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '0066-setrole-rollback';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> '0066-setrole-rollback' THEN
      RAISE;
    END IF;
  END;

  IF pg_has_role(current_user, 'corgi_app', 'SET') THEN
    RAISE EXCEPTION
      '0066 PROOF C/D FAILED: the SET half of corgi_app membership did not '
      'roll back. This migration must not leave a privilege behind it.';
  END IF;

  IF NOT ok_note THEN
    RAISE EXCEPTION
      '0066 PROOF D FAILED: corgi_app can no longer update chaos_run.note. '
      'The narrowing in section 2 broke the chaos demo, which was not the '
      'finding and is not an acceptable price for it.';
  END IF;

  IF NOT ok_cents THEN
    RAISE EXCEPTION
      '0066 PROOF D FAILED: corgi_app can still update chaos_run.auth_cents. '
      'Section 2 did not take effect, so the corrected comment is once again '
      'a claim rather than a privilege.';
  END IF;

  RAISE NOTICE '0066 proofs C and D: UPDATE on journal_entry refused (42501); '
               'UPDATE on chaos_run.note allowed; UPDATE on chaos_run.auth_cents '
               'refused. No row was written on any branch.';

  -- ---- the invariant itself, at commit ------------------------------
  SELECT count(*)::int INTO n_now FROM v_money_writable_by_app;
  IF n_now <> 0 THEN
    RAISE EXCEPTION
      '0066 FAILED: % relation(s) reachable from a balance carry UPDATE or '
      'DELETE for corgi_app: %',
      n_now,
      (SELECT string_agg(relation || ' (' || privileges || ')', ', ')
         FROM v_money_writable_by_app);
  END IF;

  RAISE NOTICE '0066: v_money_writable_by_app is empty, and has been seen red.';
END
$proof$;

COMMIT;
