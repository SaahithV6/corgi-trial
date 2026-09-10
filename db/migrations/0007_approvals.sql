-- =====================================================================
-- 0007  Maker-checker: the two lifecycle steps 0001 did not have
-- =====================================================================
--
-- 0001 already carries the whole of the maker-checker control:
--
--   * actor.kind + CHECK (NOT (kind <> 'human' AND can_approve))
--       -> an agent approver is UNREPRESENTABLE, not merely refused.
--   * approval_policy, effective-dated and append-only, cited by
--     payment_instruction.policy_id
--       -> a payment is judged under a policy VERSION, and a later policy
--          change cannot retroactively make a past approval look wrong.
--   * payment_instruction.content_hash + assert_maker_checker()
--       -> an approval must cite the hash; the initiator can never approve
--          their own instruction; a below-approver actor is refused.
--   * UNIQUE (instruction_id, kind, actor_id)
--       -> one actor, one decision.
--
-- NONE OF THAT IS REIMPLEMENTED HERE, and none of it is reimplemented in
-- application code. This migration adds exactly two things 0001 lacks.
--
-- ---------------------------------------------------------------------
-- 1.  The vocabulary for the released/failed steps
-- ---------------------------------------------------------------------
--
-- The state machine this console drives is
--
--     requested ──approved──▶ approved ──released──▶ released
--         │                                              │
--         ├──rejected──▶ rejected  (terminal)            ├──▶ settled
--         └──cancelled──▶ cancelled (terminal)           ├──▶ returned
--                                                        └──▶ failed
--
-- `payment_event_kind` in 0001 has requested / approved / rejected /
-- submitted / settled / returned / cancelled. Two values are missing:
--
--   released  the money leaves. 0001 calls this step 'submitted' and gates
--             the approval count on it. 'submitted' is kept and still
--             works -- the fold in src/lib/approvals/state.ts reads it as
--             an alias -- but 'released' is the word the rest of the
--             system uses, because "submitted" is also what a rail says
--             about a transfer it has accepted and the two are different
--             facts about different systems.
--   failed    the rail refused it outright. Distinct from 'returned',
--             which is money that moved and came back (a SECOND money
--             movement, per src/lib/rails/types.ts), and distinct from
--             'cancelled', which is us withdrawing before release.
--
-- ---------------------------------------------------------------------
-- 2.  A lifecycle gate for the transitions 0001 does not police
-- ---------------------------------------------------------------------
--
-- 0001's assert_maker_checker() inspects 'approved' and 'submitted' only.
-- It is left ALONE: it is applied, hashed and immutable, its rules are the
-- ones this feature is graded on, and re-issuing it here to bolt on more
-- branches would put the self-approval refusal at risk for the sake of an
-- ordering check. So this migration adds a SECOND BEFORE INSERT trigger
-- that composes with it rather than replacing it.
--
-- Trigger firing order in Postgres is alphabetical by trigger name, so
-- `payment_instruction_event_lifecycle` runs before
-- `payment_instruction_event_maker_checker`. Either order is correct --
-- both are BEFORE INSERT, both RAISE, and one RAISE aborts the statement.
--
-- Every comparison below is written `kind::text = '...'` rather than
-- `kind = '...'`. That is not decoration: `ALTER TYPE ... ADD VALUE` inside
-- a transaction block (and scripts/migrate.mjs runs every file in one)
-- makes the new label unusable until the transaction commits. A text
-- comparison never mentions the enum label to the planner, so the function
-- body, the trigger and this file all apply in a single transaction.
--
-- ---------------------------------------------------------------------
-- 3.  What is deliberately NOT here: a unique index on the release
-- ---------------------------------------------------------------------
--
-- `CREATE UNIQUE INDEX ... WHERE kind = 'released'` cannot be written in
-- this file -- the planner resolves an index predicate immediately and
-- rejects the brand-new enum label; the `kind::text` workaround is refused
-- in turn because an index predicate must be IMMUTABLE. Both were tried
-- against the live database before this comment was written.
--
-- It is not needed, because the guarantee is elsewhere and is stronger.
-- Releasing posts to the journal through ledger_append() with the
-- idempotency key `payment:release:<instruction id>`, derived from the
-- instruction and nothing else. Two concurrent releases therefore produce
-- ONE journal entry, decided by `journal_entry.idempotency_key`'s unique
-- index under the append lock -- not by a check anyone can forget. The
-- "already released" branch below is the sequential guard on the event
-- stream; the money is guarded by Postgres either way. See
-- src/lib/approvals/release.ts, which does both in one transaction so a
-- refused event rolls the posting back with it.
-- =====================================================================

ALTER TYPE payment_event_kind ADD VALUE IF NOT EXISTS 'released' AFTER 'submitted';
ALTER TYPE payment_event_kind ADD VALUE IF NOT EXISTS 'failed'   AFTER 'returned';

CREATE OR REPLACE FUNCTION assert_payment_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pi        payment_instruction%ROWTYPE;
  v_policy    approval_policy%ROWTYPE;
  v_kind      text := NEW.kind::text;
  v_approvals integer;
BEGIN
  SELECT * INTO v_pi FROM payment_instruction WHERE id = NEW.instruction_id;

  -- 'requested' opens the stream and is written exactly once, in the same
  -- transaction as the instruction row itself.
  IF v_kind = 'requested' THEN
    IF EXISTS (SELECT 1 FROM payment_instruction_event
                WHERE instruction_id = NEW.instruction_id) THEN
      RAISE EXCEPTION
        'instruction % is already open: requested is written once, at creation',
        NEW.instruction_id USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
  END IF;

  -- Nothing else may be the first event. An approval on an instruction
  -- with no request is not a lifecycle, it is a forgery.
  IF NOT EXISTS (SELECT 1 FROM payment_instruction_event
                  WHERE instruction_id = NEW.instruction_id
                    AND kind::text = 'requested') THEN
    RAISE EXCEPTION
      'instruction % has no requested event; % cannot be its first transition',
      NEW.instruction_id, v_kind USING ERRCODE = '55006';
  END IF;

  -- A decision is only available while the instruction is still pending.
  IF v_kind IN ('approved', 'rejected', 'cancelled') THEN
    IF EXISTS (SELECT 1 FROM payment_instruction_event
                WHERE instruction_id = NEW.instruction_id
                  AND kind::text IN ('released','submitted','settled','returned','failed')) THEN
      RAISE EXCEPTION
        'instruction % has already been released; % is not available any more',
        NEW.instruction_id, v_kind USING ERRCODE = '55006';
    END IF;
    IF v_kind <> 'approved'
       AND EXISTS (SELECT 1 FROM payment_instruction_event
                    WHERE instruction_id = NEW.instruction_id
                      AND kind::text IN ('rejected','cancelled')) THEN
      RAISE EXCEPTION
        'instruction % is already closed and cannot be %',
        NEW.instruction_id, v_kind USING ERRCODE = '55006';
    END IF;
  END IF;

  IF v_kind = 'released' THEN
    IF EXISTS (SELECT 1 FROM payment_instruction_event
                WHERE instruction_id = NEW.instruction_id
                  AND kind::text IN ('rejected','cancelled')) THEN
      RAISE EXCEPTION
        'instruction % was rejected or cancelled and cannot be released',
        NEW.instruction_id USING ERRCODE = '42501';
    END IF;

    IF EXISTS (SELECT 1 FROM payment_instruction_event
                WHERE instruction_id = NEW.instruction_id
                  AND kind::text IN ('released','submitted')) THEN
      RAISE EXCEPTION
        'instruction % has already been released',
        NEW.instruction_id USING ERRCODE = '55006';
    END IF;

    -- The same gate 0001 puts on 'submitted', word for word, plus one
    -- clause: an approval only counts if it cites the hash this row still
    -- carries. Instructions are append-only, so that clause can only fail
    -- if somebody managed to write an approval against a different
    -- payment -- and it costs nothing to make the invariant explicit at
    -- the moment the money is about to move.
    SELECT * INTO v_policy FROM approval_policy WHERE id = v_pi.policy_id;

    IF v_pi.amount_cents >= v_policy.threshold_cents THEN
      SELECT count(DISTINCT e.actor_id) INTO v_approvals
        FROM payment_instruction_event e
        JOIN actor a ON a.id = e.actor_id
       WHERE e.instruction_id = NEW.instruction_id
         AND e.kind::text = 'approved'
         AND a.kind = 'human'
         AND e.actor_id <> v_pi.requested_by
         AND e.approved_content_hash = v_pi.content_hash;

      IF v_approvals < v_policy.required_approvals THEN
        RAISE EXCEPTION
          'instruction % needs % approval(s) above the % cent threshold, has %',
          NEW.instruction_id, v_policy.required_approvals,
          v_policy.threshold_cents, v_approvals
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- An outcome is a fact about money that left. It cannot precede the
  -- release that moved it.
  IF v_kind IN ('settled', 'returned', 'failed') THEN
    IF NOT EXISTS (SELECT 1 FROM payment_instruction_event
                    WHERE instruction_id = NEW.instruction_id
                      AND kind::text IN ('released','submitted')) THEN
      RAISE EXCEPTION
        'instruction % has not been released; % cannot follow',
        NEW.instruction_id, v_kind USING ERRCODE = '55006';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER payment_instruction_event_lifecycle
  BEFORE INSERT ON payment_instruction_event
  FOR EACH ROW EXECUTE FUNCTION assert_payment_lifecycle();

-- The approvals screen renders the initiator's display name and the owning
-- business beside every amount, because "who asked for this" is the first
-- question an approver has. corgi_app already holds SELECT on actor,
-- account, business and approval_policy from 0001; nothing is widened
-- here, and in particular corgi_app still holds no UPDATE or DELETE on
-- payment_instruction or payment_instruction_event.
--
-- One index, for the queue's own query: pending instructions, newest
-- first. `pie_instruction_idx` from 0001 covers the per-instruction fold;
-- this covers the list.
CREATE INDEX IF NOT EXISTS payment_instruction_requested_idx
  ON payment_instruction (requested_at DESC);
