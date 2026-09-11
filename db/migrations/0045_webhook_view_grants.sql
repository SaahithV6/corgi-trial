-- =====================================================================
-- 0045 — the two staff views 0002 said corgi_app could read, and could not
-- =====================================================================
--
-- 0002 line 321 says, in the file, applied and hashed into
-- schema_migrations on 2026-09-10:
--
--     GRANT SELECT ON v_webhook_dead_letter, v_webhook_parked TO corgi_app;
--
-- The live database disagreed, and the database is the one that decides:
--
--     relname                  relacl
--     v_webhook_dead_letter    {neondb_owner=arwdDxtm/neondb_owner}
--     v_webhook_parked         {neondb_owner=arwdDxtm/neondb_owner}
--     webhook_inbox            {neondb_owner=…,corgi_app=arw/neondb_owner}
--
--     SELECT count(*) FROM v_webhook_dead_letter   (as corgi_app)
--       -> ERROR: permission denied for view v_webhook_dead_letter
--
-- 107 of the 109 views in this schema are readable by corgi_app. These two
-- are the exceptions.
--
-- ---------------------------------------------------------------------
-- WHY THE GRANT IS NOT ON THE DATABASE, GIVEN THAT THE STATEMENT RAN
-- ---------------------------------------------------------------------
--
-- It ran, and then it was taken away, out of band, by our own tooling.
-- `scripts/dbreset.mjs` rebuilds the schema and finishes with:
--
--     REVOKE ALL ON ALL TABLES IN SCHEMA public FROM corgi_app;   -- line 41
--     GRANT SELECT, INSERT ON journal_entry, journal_line, …      -- lines 42+
--
-- In Postgres, "ALL TABLES" includes views. So the reset strips every
-- privilege the migrations granted and then restores a hand-maintained list
-- that names tables and no views at all. Anything granted by a migration
-- that had ALREADY been applied when the reset ran is silently lost;
-- anything granted by a migration applied afterwards survives.
--
-- The timestamps say exactly that happened. 0001, 0002 and 0003 share one
-- apply batch (2026-09-10T01:29:06.226Z / .981Z / 01:29:07.346Z) — a reset —
-- and 0005 onwards were applied later, over hours. 0002's view grants were
-- inside that batch, so the reset's REVOKE ate them; 0038's identical view
-- grants came later and are still there. 0008 §1 records the same class of
-- injury being repaired by hand for 0001's thirteen derived views, found
-- the same way: "Three gaps were found by running the application role
-- against the live database rather than by reading the file."
--
-- So the claim in 0002 was true when it was written and false by the time
-- anyone read it, and nothing noticed because NOTHING READS THESE VIEWS.
-- `src/lib/home/summary.ts` counts dead and parked rows straight off
-- `webhook_inbox`, and `src/lib/chaos/observe.ts` groups the parked ones the
-- same way. Both are readable, both work, neither goes near the views — so
-- the documented staff surface has been dead with no screen degraded and no
-- error logged. An unread view is a claim nobody checks.
--
-- ---------------------------------------------------------------------
-- WHAT THIS FIXES AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------
--
-- Fixed: the grant, re-applied, and asserted below in the same transaction,
-- so this migration cannot claim a privilege it did not actually create.
--
-- NOT fixed, and it needs a second pair of hands because the file is outside
-- this change's remit: `scripts/dbreset.mjs` will do it again. Its line-41
-- REVOKE plus a hardcoded re-grant list is a policy that silently diverges
-- from the migrations every time a new grant is written. The durable repair
-- is for the reset to stop re-granting by hand and let the migrations be the
-- only source of privilege — they already are for 40 of the 45 files.
--
-- Idempotent: GRANT of a privilege already held is a no-op, so a reset that
-- replays every migration lands in the same place.

-- ---------------------------------------------------------------------
-- 1.  The grant 0002 intended
-- ---------------------------------------------------------------------
--
-- SELECT only, and only on views — the reasoning 0008 §1 gives, unchanged.
-- Both are fixed parameterless projections of `webhook_inbox`, on which
-- corgi_app already holds SELECT, so this widens nothing: it lets the
-- application read rows it could already read, through the shared definition
-- that keeps the customer log and the operator dead-letter list from
-- disagreeing in front of somebody.
GRANT SELECT ON v_webhook_dead_letter, v_webhook_parked TO corgi_app;

-- ---------------------------------------------------------------------
-- 2.  Prove it, here, rather than in a document
-- ---------------------------------------------------------------------
--
-- The failure mode this migration exists to repair is precisely "the file
-- says GRANT and the database says no". A migration that only says GRANT
-- again would be the same kind of evidence that was wrong the first time.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(v, ', ' ORDER BY v)
    INTO missing
    FROM unnest(ARRAY['v_webhook_dead_letter', 'v_webhook_parked']) AS v
   WHERE NOT has_table_privilege('corgi_app', v, 'SELECT');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'corgi_app still cannot SELECT: %. The grant in this migration did not take effect; do not record it as applied.',
      missing;
  END IF;
END $$;

COMMENT ON VIEW v_webhook_parked IS
  'What is waiting, and for what. Readable by corgi_app since 0045 — 0002 granted it and scripts/dbreset.mjs revoked it back out of band.';
