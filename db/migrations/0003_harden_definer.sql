-- =====================================================================
-- 0003  Pin search_path on the SECURITY DEFINER write path
-- =====================================================================
--
-- ledger_append() is SECURITY DEFINER: it executes with the table owner's
-- privileges so that corgi_app can post money without holding privileges
-- that would also let it rewrite money. That is the right design, and it
-- carries the standard hazard that comes with it.
--
-- A SECURITY DEFINER function resolves unqualified names through the
-- CALLER's search_path. If a caller can create an object in a schema that
-- sits earlier in that path, it can shadow a function the definer body
-- calls -- digest(), nextval(), format() -- and have its own code run as
-- the owner. That is privilege escalation into the one function in this
-- system that writes to the journal.
--
-- Is it exploitable today? No. This database is Postgres 18, where the
-- public schema no longer grants CREATE to PUBLIC, and corgi_app has no
-- CREATE anywhere (verified: has_schema_privilege('corgi_app','public',
-- 'CREATE') is false). The hole is latent, not live.
--
-- It is being closed anyway, because "not exploitable today" depends on a
-- default that a single future GRANT would undo silently, and the blast
-- radius is the ledger. Pinning the path costs one statement.
--
-- pg_temp is placed LAST and named explicitly. If it is omitted, Postgres
-- searches it first, and a caller can create a temp object that shadows
-- the same names -- which reintroduces exactly the hole being closed.

ALTER FUNCTION ledger_append(
  uuid, date, account_book, entry_type, text, text, uuid, jsonb,
  rail, text, uuid, uuid, uuid, uuid
) SET search_path = public, pg_temp;

-- Same treatment for the chain verifier: it reads the money it attests to.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'verify_chain' AND p.prosecdef) THEN
    EXECUTE 'ALTER FUNCTION verify_chain(uuid) SET search_path = public, pg_temp';
  END IF;
END $$;

-- Belt and braces: corgi_app must never be able to create objects that
-- could participate in name resolution.
REVOKE CREATE ON SCHEMA public FROM corgi_app;
