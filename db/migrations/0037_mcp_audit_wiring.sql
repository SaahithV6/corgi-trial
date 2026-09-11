-- =====================================================================
-- 0037.  mcp_audit is wired:  awaiting_wiring  ->  projected.
-- =====================================================================
--
-- 0035 §2 created `mcp_audit` and registered it as `awaiting_wiring`, not
-- as `projected`, and the distinction was the point:  a source that reads
-- zero because nothing writes it must never be indistinguishable from one
-- that reads zero because nothing happened.  The audit screen printed the
-- gap in red on its own face for exactly as long as the gap existed.
--
-- The gap is closed.  `src/app/api/mcp/route.ts` now tees every MCP audit
-- record -- every read, and every REFUSAL, which is the half that matters
-- after an incident -- through `src/lib/audit/sink.ts` into this table,
-- and AWAITS the insert before the response leaves, so a failed write is
-- a fact somebody learns rather than a detached promise a frozen lambda
-- drops.  Which way an audit failure falls is argued in that file's
-- header:  open for the call, closed for the claim -- the call is served,
-- the response carries `x-corgi-audit: degraded`, and an error-level
-- `mcp.audit.persist_failed` line names the request.
--
-- ---------------------------------------------------------------------
-- WHY THIS IS AN INSERT AND NOT AN UPDATE
-- ---------------------------------------------------------------------
--
-- `audit_source` is append-only for the same reason the money tables are:
-- the history of what the trail CLAIMED to cover is itself evidence.  A
-- reviewer asking "when did the agent surface start being recorded, and
-- what did this screen say before that" gets an answer with a timestamp
-- instead of a row that was quietly rewritten.  `v_audit_source` takes
-- the latest declaration per table by `seq`, so this row supersedes 0035's
-- without touching it -- and the trigger `audit_source_no_update_delete`
-- would refuse the alternative anyway, regardless of role.
--
-- Nothing else changes.  `mcp_audit` already had its §5 projection branch,
-- its row in `v_audit_source_count`, and its place in `v_audit_coverage`
-- (which counts `awaiting_wiring` sources too, so the stored-versus-
-- projected reconciliation covered this table before and after).  What
-- moving the disposition does is put it in front of the two invariants
-- that only bind `projected` sources:
--
--   v_audit_source_mutable  -- must stay empty.  `corgi_app` holds only
--                              SELECT and INSERT on `mcp_audit`, so it
--                              does.  Evidence the app can rewrite is not
--                              evidence.
--   v_audit_source_weak     -- a report, not an invariant.  `mcp_audit`
--                              carries `mcp_audit_no_update_delete`, so it
--                              does not appear:  the OWNER cannot rewrite
--                              it either.
--
-- Re-runnable:  the guard makes this a no-op once the row is there, the
-- same way 0035 §4 seeds its registry, because a migration that can only
-- be applied to an empty database cannot be applied to a restored one.

INSERT INTO audit_source (table_name, disposition, surface, reason, declared_in)
SELECT 'mcp_audit', 'projected', 'agent',
       'Every MCP call including refusals: tool, business scope, redacted arguments, outcome, grant fingerprint. Written by src/lib/audit/sink.ts from src/app/api/mcp/route.ts, awaited before the response leaves; a failed write degrades the response header and never refuses the call.',
       '0037_mcp_audit_wiring.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM audit_source s
   WHERE s.table_name  = 'mcp_audit'
     AND s.declared_in = '0037_mcp_audit_wiring.sql'
);
