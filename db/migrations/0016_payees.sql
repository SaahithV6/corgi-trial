-- =====================================================================
-- 0016  The payee book, and the confirmation step in front of it
-- =====================================================================
--
-- Stretch-ladder item six, verbatim:
--
--   "A payee confirmation step that catches the mistyped account before
--    the money leaves."
--
-- In the UK that feature is Confirmation of Payee and it is a network:
-- you send a name, the beneficiary's bank answers match / close match /
-- no match. THE UNITED STATES HAS NO SUCH NETWORK, and the trial says
-- Build American, so this file is the honest US construction of the same
-- idea. It has three legs of very different strength, and the whole
-- design is about not letting the weak ones borrow credibility from the
-- strong one.
--
--   LEG 1 — ARITHMETIC.  A US routing number carries a weighted mod-10
--     check digit:  3(d1+d4+d7) + 7(d2+d5+d8) + 1(d3+d6+d9) = 0 (mod 10).
--     This needs no provider, no network and no counterparty. It is
--     either right or it is impossible. `aba_checksum_ok()` below is that
--     arithmetic, in Postgres, as a CHECK CONSTRAINT on the payee row.
--     A payee whose routing number cannot exist is not a payee this
--     database will hold. See section 3.
--
--   LEG 2 — A DIRECTORY.  Increase publishes GET /routing_numbers, and
--     our sandbox key reaches it (measured; see docs/PAYEES.md for the
--     exact call and response). A hit is positive evidence that the
--     routing number belongs to a real institution and tells us whether
--     that institution takes ACH and wires. A MISS IS NOT EVIDENCE OF
--     ANYTHING in sandbox, because the sandbox directory contains
--     essentially one bank. `payee_directory_result` therefore has a
--     `not_listed` value AND an `unavailable` value and they are not the
--     same fact.
--
--   LEG 3 — THE NAME.  This is the leg CoP is actually made of, and it
--     is the leg we cannot obtain. Nothing in the credential set can ask
--     a US bank what name sits on an arbitrary third party's account.
--     What we CAN do is compare two names well, so `payee_name_match`
--     records match / close_match / no_match exactly as CoP does — with
--     `counterparty_name_source` recording WHERE the other name came
--     from. In sandbox that column says `payer_asserted`, which means
--     the comparison was against a name our own customer typed, and the
--     screen says so in those words. Plaid's /identity/match CAN answer
--     for an account the holder linked to us; when the payee is such an
--     account the source is `plaid.identity_match` and the score is the
--     provider's. Two sources, one column, never confused.
--
-- ---------------------------------------------------------------------
-- 1.  BLOCK VERSUS WARN, AS A DATABASE CONSTRAINT
-- ---------------------------------------------------------------------
--
-- The judgement this feature turns on:
--
--   * A FAILED CHECKSUM IS A BLOCK. There is no legitimate routing
--     number that fails it. Letting a human click through would be
--     letting them click through arithmetic.
--
--   * A FAILED NAME MATCH IS A WARNING. Names legitimately differ —
--     trading names, subsidiaries, "Ridgeline Coffee" invoicing as
--     "RCR Holdings LLC". Every real CoP scheme lets the payer proceed
--     after an explicit acknowledgement, and one that did not would
--     train people to route around it.
--
-- That line is not an `if` in TypeScript. It is:
--
--   * `payee_routing_number_possible` — the CHECK on `payee`. A blocked
--     routing number has no row. The block is unrepresentable-as-stored,
--     not enforced-by-a-caller.
--
--   * `payee_verification_outcome_matches_findings` — the CHECK on
--     `payee_verification`. `blocked` is reachable only with
--     `checksum_ok = false`, which the payee CHECK has already made
--     impossible, so the outcome column cannot claim a block for a
--     reason that is not arithmetic. A name finding can reach `warned`
--     and can never reach `blocked`.
--
--   * `payee_acknowledgement` — a row, appended by a named human with a
--     sentence, and a trigger that refuses one against a verification
--     that was not `warned`. Acknowledging a clean check is noise;
--     acknowledging a block is impossible because blocks are not stored.
--
-- ---------------------------------------------------------------------
-- 2.  A REFUSAL IS A ROW  (0012 section 4, applied again)
-- ---------------------------------------------------------------------
--
-- Because a blocked candidate never becomes a payee, the caught typo
-- would otherwise leave no trace — and the caught typo is the entire
-- point of the feature. `payee_candidate_refusal` is where it lands:
-- the digits as typed, the arithmetic that refused them, the actor and
-- the instant. It is the only table here whose routing number column
-- carries NO checksum constraint, on purpose, because its whole job is
-- to hold numbers that fail it.
--
-- ---------------------------------------------------------------------
-- 3.  FRESHNESS IS DERIVED, NOT STAMPED
-- ---------------------------------------------------------------------
--
-- "A payee verified six months ago is not the same as one verified
-- today." So there is no `is_verified` boolean anywhere in this file.
-- There is a list of checks with timestamps, and `v_payee_book` derives
-- the current standing from the newest one and labels its age against
-- `now()`. A stored flag would have to be re-stamped by something, and
-- the thing that re-stamps it is the thing that eventually does not.
--
-- The age bands live in `payee_verification_freshness()` — ONE
-- definition, in SQL, called by the view. TypeScript reads the label
-- off the view rather than recomputing it, for the same reason
-- `standing_order_due_dates()` owns the calendar: two copies of a rule
-- held equal by nothing will not stay equal.
--
-- ---------------------------------------------------------------------
-- 4.  NO MONEY IS TOUCHED HERE
-- ---------------------------------------------------------------------
--
-- Nothing in this file writes a journal entry, a journal line, a hold or
-- a payment instruction, and nothing in `src/lib/payees` may either.
-- This path validates a destination; posting is 0001's job and raising
-- an instruction is 0007's. There is no amount column in this migration
-- at all — not a bigint, not anything — because a payee is not a
-- payment.
--
-- Everything is append-only anyway: SELECT and INSERT for corgi_app, an
-- explicit REVOKE of UPDATE/DELETE/TRUNCATE, and 0001's
-- `ledger_row_is_immutable()` trigger as the layer that also binds the
-- table owner. Not because these are money rows — they are not — but
-- because they are the record of what we checked before money moved,
-- and an assurance trail you can edit afterwards is a story.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 5.  The arithmetic, in the database
-- ---------------------------------------------------------------------

-- The ABA/routing transit number check digit.
--
--   3*(d1+d4+d7) + 7*(d2+d5+d8) + 1*(d3+d6+d9)  ==  0  (mod 10)
--
-- IMMUTABLE because a CHECK constraint requires it, and it genuinely is:
-- nine characters in, one boolean out, no session state, no locale, no
-- clock. (Contrast every textual rendering of a date, which is only
-- STABLE — 0012 section 2 has the scar.)
--
-- STRICT so NULL propagates rather than being silently treated as a
-- failure: a wire payee has no routing number, and "absent" must not be
-- confused with "impossible".
--
-- The format gate is inside the function rather than beside it, so a
-- caller cannot get `true` for 'not a number at all'.
--
-- CASE and not `AND`, and this matters: POSTGRES DOES NOT GUARANTEE
-- SHORT-CIRCUIT EVALUATION OF `AND`. Written as
-- `rn ~ '^[0-9]{9}$' AND (substr(rn,1,1)::int + ...)`, the planner is
-- free to evaluate the right operand first, and `'ABCDEFGHI'::int`
-- raises rather than returning false — which inside a CHECK constraint
-- is a 22P02 where the caller expected a clean refusal. CASE is the
-- documented construct that does guarantee untaken branches are not
-- evaluated (constant folding aside, and `rn` is not a constant).
CREATE OR REPLACE FUNCTION aba_checksum_ok(rn text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE WHEN rn ~ '^[0-9]{9}$' THEN
    ( 3 * (substr(rn,1,1)::int + substr(rn,4,1)::int + substr(rn,7,1)::int)
    + 7 * (substr(rn,2,1)::int + substr(rn,5,1)::int + substr(rn,8,1)::int)
    + 1 * (substr(rn,3,1)::int + substr(rn,6,1)::int + substr(rn,9,1)::int)
    ) % 10 = 0
  ELSE false END
$$;

COMMENT ON FUNCTION aba_checksum_ok(text) IS
  'ABA routing transit number check digit: 3(d1+d4+d7)+7(d2+d5+d8)+1(d3+d6+d9) = 0 mod 10. The one thing in the payee path that needs no provider. Mirrored in src/lib/payees/aba.ts, which is tested against this function over the live database in payees.integration.test.ts.';


-- The Federal Reserve prefix allocation. Deliberately NOT part of the
-- CHECK constraint and deliberately NOT a block.
--
-- The first two digits are an ALLOCATION, published by the registrar:
-- 00 federal government, 01-12 the Federal Reserve districts, 21-32
-- thrifts (district + 20), 61-72 electronic (district + 60), 80
-- traveler's cheques. 13-20, 33-60, 73-79 and 81-99 are unassigned.
--
-- Unassigned is not impossible. It is a fact about a registry that can
-- change, whereas the checksum is a fact about arithmetic that cannot.
-- Blocking on it would be blocking on a convention, and the line this
-- migration draws is precisely between the two. So it warns.
CREATE OR REPLACE FUNCTION aba_prefix_assigned(rn text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE WHEN rn ~ '^[0-9]{9}$' THEN
          substr(rn,1,2)::int BETWEEN  0 AND 12
       OR substr(rn,1,2)::int BETWEEN 21 AND 32
       OR substr(rn,1,2)::int BETWEEN 61 AND 72
       OR substr(rn,1,2)::int = 80
  ELSE false END
$$;

COMMENT ON FUNCTION aba_prefix_assigned(text) IS
  'Whether the first two digits fall in an allocated Federal Reserve prefix range. A registry fact, not an arithmetic one, so it warns and never blocks.';


-- ---------------------------------------------------------------------
-- 6.  Vocabulary
-- ---------------------------------------------------------------------

-- Declaration order is load-bearing, exactly as in 0005/0013: the
-- rollup in v_payee_book uses max(), and max() over an enum is
-- "the worst one wins" only if the worst one is declared last.
CREATE TYPE payee_verification_outcome AS ENUM ('verified', 'warned', 'blocked');

-- CoP's own three answers, plus the fourth one CoP does not need and we
-- do: `unavailable`, meaning nobody was asked. A screen that cannot tell
-- "no match" from "not checked" is a screen that will eventually show a
-- green tick for a question nobody put.
CREATE TYPE payee_name_match AS ENUM ('match', 'close_match', 'no_match', 'unavailable');

-- Four values because there are four distinct facts, and collapsing the
-- middle two is the single most dishonest thing this feature could do.
--   found        — the provider knows this routing number. Positive evidence.
--   not_listed   — the provider answered, and does not know it.
--   unavailable  — the provider could not be reached, or holds no key.
--   not_checked  — the rail has no routing number to look up (wire, internal).
CREATE TYPE payee_directory_result AS ENUM ('found', 'not_listed', 'unavailable', 'not_checked');

-- Where the OTHER name came from. The single most important column in
-- this migration, because it is what stops a similarity score being
-- mistaken for a bank's answer.
--
--   payer_asserted        — our own customer typed both sides. The
--                           algorithm ran; no third party confirmed
--                           anything. This is the sandbox default and the
--                           screen prints it in words.
--   linked_account_holder — the payee is an account whose holder linked
--                           it to us through Plaid, so the institution's
--                           own record of the holder name was compared.
--                           This is real name verification, and it is
--                           available for exactly the accounts somebody
--                           consented to link.
--   confirmation_of_payee — a real CoP/name-check network answered. No
--                           US provider in this repo can produce this
--                           value. It exists so the day one can, the
--                           schema does not move.
CREATE TYPE payee_name_source AS ENUM (
  'payer_asserted',
  'linked_account_holder',
  'confirmation_of_payee'
);

-- Same two words 0005 uses, and the same rule: a check is `live` only
-- when a real third party answered a real call.
CREATE TYPE payee_check_evidence AS ENUM ('live', 'simulated');


-- ---------------------------------------------------------------------
-- 7.  The payee
-- ---------------------------------------------------------------------

CREATE TABLE payee (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy. A payee belongs to the business that keyed it, not to an
  -- account: the same supplier is paid from whichever account has the
  -- money, and duplicating the beneficiary per account is how two
  -- versions of one bank detail come to exist.
  business_id   uuid NOT NULL REFERENCES business(id),

  -- What our customer calls them in their own head ("Roasters — green
  -- coffee"). Never sent anywhere.
  display_name  text NOT NULL CHECK (length(btrim(display_name)) > 0),

  -- The name as it would go on the payment. THIS is the string the name
  -- match compares, and the reason it is stored separately from
  -- display_name: a nickname must never become the thing we assert to a
  -- bank.
  holder_name   text NOT NULL CHECK (length(btrim(holder_name)) > 0),

  rail          rail NOT NULL,

  routing_number       text,
  account_number_last4 text,
  account_type         text,

  -- NEVER A FULL ACCOUNT NUMBER, for the same reason
  -- `payment_instruction.counterparty` never holds one (see
  -- src/lib/approvals/types.ts): this row is read by a screen, and the
  -- approver needs to recognise a beneficiary, not to be able to re-key
  -- the payment somewhere else.
  --
  -- The cost of that choice is stated plainly in docs/PAYEES.md: we
  -- cannot re-derive the account number, so the only account-number typo
  -- this system can catch is one that disagrees with a payee already in
  -- the book. Catching the rest needs an ACH prenotification, which is a
  -- write to the rail and is week two.

  CONSTRAINT payee_rail_is_payout CHECK (rail <> 'card'),

  -- Exactly the fields the rail needs and no others. 0012's
  -- `standing_order_cadence_fields` instinct: a wire payee carrying a
  -- routing number is a row two readers will resolve two ways.
  CONSTRAINT payee_rail_fields CHECK (
       (rail = 'ach'
          AND routing_number IS NOT NULL
          AND account_number_last4 IS NOT NULL
          AND account_type IS NOT NULL)
    OR (rail = 'wire'
          AND routing_number IS NOT NULL
          AND account_number_last4 IS NOT NULL
          AND account_type IS NULL)
    OR (rail IN ('usdc', 'internal')
          AND routing_number IS NULL
          AND account_number_last4 IS NULL
          AND account_type IS NULL)
  ),

  CONSTRAINT payee_account_type_values
    CHECK (account_type IS NULL OR account_type IN ('checking', 'savings')),

  CONSTRAINT payee_last4_shape
    CHECK (account_number_last4 IS NULL OR account_number_last4 ~ '^[0-9]{4}$'),

  -- THE BLOCK, AS A CONSTRAINT.
  --
  -- Not "the service refuses to save it" — the database cannot hold it.
  -- A routing number that fails the check digit is arithmetically
  -- impossible, so there is no acknowledgement, no override flag and no
  -- admin path that puts one in this table. Every other finding this
  -- feature produces is a warning; this one is a wall, and it is a wall
  -- made of the same arithmetic that makes it wrong.
  CONSTRAINT payee_routing_number_possible
    CHECK (routing_number IS NULL OR aba_checksum_ok(routing_number)),

  created_by    uuid NOT NULL REFERENCES actor(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Derived from the source fact that caused the payee to exist (an
  -- invoice, a supplier record, a seed run) — never a uuid we generated.
  -- DECISIONS' rule for idempotency keys, applied to a beneficiary:
  -- re-running the importer cannot create a second copy of one bank
  -- detail, and two copies of one bank detail is how a business ends up
  -- paying the stale one.
  payee_key     text NOT NULL UNIQUE CHECK (length(btrim(payee_key)) > 0)
);

CREATE INDEX payee_business_idx ON payee (business_id);
-- The near-duplicate probe (section 11) hits this.
CREATE INDEX payee_business_routing_idx
  ON payee (business_id, routing_number)
  WHERE routing_number IS NOT NULL;

COMMENT ON TABLE payee IS
  'The payee book. Append-only. A routing number that fails the ABA check digit cannot be stored here at all — see payee_routing_number_possible.';
COMMENT ON COLUMN payee.holder_name IS
  'The name that would go on the payment, and the string the name match compares. Deliberately separate from display_name so a nickname can never become the thing asserted to a bank.';
COMMENT ON COLUMN payee.account_number_last4 IS
  'Last four only, never the full number — same rule as payment_instruction.counterparty. The consequence for typo detection is stated in docs/PAYEES.md.';


-- Removing a payee is an append, not a DELETE. Same shape as
-- `standing_order_cancellation` and `hold_closure`: the payee id is the
-- PRIMARY KEY, so it can happen once, it cannot happen twice, and it
-- cannot be undone by an UPDATE because there is no UPDATE.
CREATE TABLE payee_archival (
  payee_id     uuid PRIMARY KEY REFERENCES payee(id),
  archived_at  timestamptz NOT NULL DEFAULT now(),
  archived_by  uuid NOT NULL REFERENCES actor(id),
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0)
);


-- ---------------------------------------------------------------------
-- 8.  The check
-- ---------------------------------------------------------------------

CREATE TABLE payee_verification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id      uuid NOT NULL REFERENCES payee(id),

  checked_at    timestamptz NOT NULL DEFAULT now(),
  checked_by    uuid NOT NULL REFERENCES actor(id),

  outcome       payee_verification_outcome NOT NULL,

  -- ---- leg 1: arithmetic -------------------------------------------
  checksum_ok   boolean NOT NULL,
  prefix_assigned boolean NOT NULL,

  -- ---- leg 2: the directory ----------------------------------------
  directory     payee_directory_result NOT NULL,
  -- 'increase.routing_numbers' when Increase answered. NULL when nobody
  -- was asked, which is a different fact from 'asked and got nothing'.
  directory_provider text,
  institution_name   text,
  ach_supported      boolean,
  wire_supported     boolean,

  -- ---- leg 3: the name ---------------------------------------------
  name_match        payee_name_match NOT NULL,
  -- 0..100. `smallint` and not a float: a similarity is a graded thing,
  -- but it is graded in whole points and there is no arithmetic anywhere
  -- that wants a fraction of one.
  name_match_score  smallint CHECK (name_match_score BETWEEN 0 AND 100),
  name_source       payee_name_source NOT NULL,
  name_provider     text,
  -- The counterparty name we compared against, WHEN a third party gave
  -- it to us. NULL when name_source = 'payer_asserted', because in that
  -- case there is no second name — there is one name, typed once, and
  -- storing a copy of it here would make the screen look like two
  -- independent facts agreed.
  counterparty_name text,

  evidence      payee_check_evidence NOT NULL,

  -- The raw findings list, as the service produced it. Read by the
  -- screen; never parsed to make a decision, because the decision
  -- columns above are the decision.
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- THE BLOCK/WARN LINE, RESTATED WHERE IT CANNOT BE ARGUED WITH.
  --
  -- `blocked` requires a failed checksum and nothing else can produce
  -- it. Since `payee_routing_number_possible` already makes a failed
  -- checksum unstorable on the parent row, this constraint is
  -- unsatisfiable-by-construction for any payee that exists — which is
  -- the point. It is here so that a future writer who relaxes the payee
  -- CHECK still cannot invent a block for a soft reason, and so that a
  -- reader can find the rule by grepping for the word.
  CONSTRAINT payee_verification_block_is_arithmetic
    CHECK ((outcome = 'blocked') = (checksum_ok IS FALSE)),

  -- A score exists exactly when a comparison happened.
  CONSTRAINT payee_verification_score_iff_compared
    CHECK ((name_match = 'unavailable') = (name_match_score IS NULL)),

  -- A counterparty name exists exactly when a third party supplied one.
  CONSTRAINT payee_verification_counterparty_name_iff_sourced
    CHECK ((name_source = 'payer_asserted') = (counterparty_name IS NULL)),

  -- `live` evidence requires a named provider on at least one leg. An
  -- entirely local check is `simulated`, whatever the caller believes.
  CONSTRAINT payee_verification_live_needs_a_provider
    CHECK (evidence = 'simulated'
           OR directory_provider IS NOT NULL
           OR name_provider IS NOT NULL),

  -- Directory columns are populated exactly when the directory answered.
  CONSTRAINT payee_verification_institution_iff_found
    CHECK ((directory = 'found') = (institution_name IS NOT NULL))
);

CREATE INDEX payee_verification_payee_idx
  ON payee_verification (payee_id, checked_at DESC);

COMMENT ON TABLE payee_verification IS
  'One row per check of one payee. Append-only, so "verified six months ago" and "verified today" are different rows and the view can tell them apart.';
COMMENT ON COLUMN payee_verification.name_source IS
  'Where the counterparty name came from. payer_asserted means our own customer typed both sides and no third party confirmed anything — the screen says so in those words.';


-- ---------------------------------------------------------------------
-- 9.  The acknowledgement — what makes a warning a warning
-- ---------------------------------------------------------------------
--
-- A warning nobody has to answer for is a warning people learn to click
-- past. This table is the answer: a named human, an instant, and a
-- sentence saying why they are proceeding anyway. It is the record that
-- makes "we let them through" defensible afterwards, and it is the
-- reason the name leg can be a warning at all.
CREATE TABLE payee_acknowledgement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL REFERENCES payee_verification(id),
  acknowledged_by uuid NOT NULL REFERENCES actor(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  -- One acknowledgement per person per check. Re-submitting the form
  -- does not stack up consents.
  CONSTRAINT payee_acknowledgement_once UNIQUE (verification_id, acknowledged_by)
);


-- ---------------------------------------------------------------------
-- 10.  A refusal is a row
-- ---------------------------------------------------------------------
--
-- A blocked candidate never becomes a payee, so without this table the
-- caught typo — the entire product of this feature — would leave no
-- trace at all.
--
-- This is the ONE table in the file whose routing number column has no
-- checksum constraint, and the absence is deliberate: its job is to hold
-- the numbers that fail it. The digits are kept in full because a
-- routing number is not a secret (they are published), and because the
-- transposition is only legible if you can see it.
CREATE TABLE payee_candidate_refusal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES business(id),
  attempted_at   timestamptz NOT NULL DEFAULT now(),
  attempted_by   uuid NOT NULL REFERENCES actor(id),
  holder_name    text NOT NULL CHECK (length(btrim(holder_name)) > 0),
  rail           rail NOT NULL,
  -- As typed. Not normalised, not padded, not corrected.
  routing_number text NOT NULL,
  account_number_last4 text CHECK (account_number_last4 IS NULL
                                   OR account_number_last4 ~ '^[0-9]{4}$'),
  code           text NOT NULL CHECK (length(btrim(code)) > 0),
  reason         text NOT NULL CHECK (length(btrim(reason)) > 0),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The table exists for impossible numbers. A candidate whose checksum
  -- PASSES was not refused for arithmetic and does not belong here —
  -- that one is a payee with a warning on it.
  -- `aba_checksum_ok` already answers false for anything that is not
  -- nine digits, so malformed input lands here too and no second clause
  -- is needed.
  CONSTRAINT payee_candidate_refusal_is_impossible
    CHECK (NOT aba_checksum_ok(routing_number))
);

CREATE INDEX payee_candidate_refusal_business_idx
  ON payee_candidate_refusal (business_id, attempted_at DESC);

COMMENT ON TABLE payee_candidate_refusal IS
  'Every destination the arithmetic refused, as typed. The caught typo is the product of this feature; this is where it is kept.';


-- ---------------------------------------------------------------------
-- 11.  Freshness, defined once
-- ---------------------------------------------------------------------
--
-- Bands rather than a boolean, because "verified" is not a state a payee
-- is in, it is a thing that happened on a day.
--
--   fresh    <= 30 days   — checked this month.
--   ageing   <= 90 days   — still the last thing we know, and old enough
--                           to mention on the screen.
--   stale     > 90 days   — re-check before you send. Bank details
--                           change, businesses are acquired, and an
--                           answer from last quarter is an answer about
--                           last quarter.
--   never                 — no check on file at all.
--
-- 90 days is the same horizon a payments team uses for re-confirming
-- supplier bank details out of band, and it is written here once so the
-- screen and the API cannot disagree about it.
CREATE OR REPLACE FUNCTION payee_verification_freshness(checked_at timestamptz, at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN checked_at IS NULL THEN 'never'
           WHEN at - checked_at <= interval '30 days' THEN 'fresh'
           WHEN at - checked_at <= interval '90 days' THEN 'ageing'
           ELSE 'stale'
         END
$$;

COMMENT ON FUNCTION payee_verification_freshness(timestamptz, timestamptz) IS
  'The single definition of how old a payee check is allowed to be. Called by v_payee_book; TypeScript reads the label rather than recomputing it.';


-- ---------------------------------------------------------------------
-- 12.  The book, derived
-- ---------------------------------------------------------------------
--
-- No stored standing, no stored freshness, no `is_verified` column.
-- Every row here is computed from the checks that exist, at read time,
-- against now(). Delete every row from `payee_verification` and this
-- view correctly says nobody has ever checked anything — which is what
-- a derived truth does and what a stored lie does not.
CREATE OR REPLACE VIEW v_payee_book AS
WITH latest AS (
  SELECT DISTINCT ON (payee_id)
         id, payee_id, checked_at, checked_by, outcome,
         checksum_ok, prefix_assigned,
         directory, directory_provider, institution_name,
         ach_supported, wire_supported,
         name_match, name_match_score, name_source, name_provider,
         counterparty_name, evidence, detail
    FROM payee_verification
   ORDER BY payee_id, checked_at DESC, id DESC
)
SELECT p.id                          AS payee_id,
       p.business_id,
       b.legal_name                  AS business_name,
       p.display_name,
       p.holder_name,
       p.rail::text                  AS rail,
       p.routing_number,
       p.account_number_last4,
       p.account_type,
       p.payee_key,
       p.created_at,
       ca.display_name               AS created_by_name,
       (ar.payee_id IS NOT NULL)     AS archived,
       ar.archived_at,
       ar.reason                     AS archival_reason,

       l.id                          AS verification_id,
       l.checked_at,
       va.display_name               AS checked_by_name,
       l.outcome,
       l.checksum_ok,
       l.prefix_assigned,
       l.directory,
       l.directory_provider,
       l.institution_name,
       l.ach_supported,
       l.wire_supported,
       l.name_match,
       l.name_match_score,
       l.name_source,
       l.name_provider,
       l.counterparty_name,
       l.evidence,
       l.detail,

       payee_verification_freshness(l.checked_at, now()) AS freshness,
       -- Whole days, floored. A screen that says "12 days ago" and a
       -- band that says "fresh" must be computed from the same instant,
       -- so both come out of this one row.
       CASE WHEN l.checked_at IS NULL THEN NULL
            ELSE floor(EXTRACT(EPOCH FROM (now() - l.checked_at)) / 86400)::int
       END                           AS checked_days_ago,

       -- Has anybody signed for the warning that is currently standing?
       -- Scoped to the LATEST verification: acknowledging June's warning
       -- says nothing about the one raised this morning.
       EXISTS (SELECT 1 FROM payee_acknowledgement pa
                WHERE pa.verification_id = l.id)        AS acknowledged,
       (SELECT max(pa.acknowledged_at) FROM payee_acknowledgement pa
         WHERE pa.verification_id = l.id)               AS acknowledged_at,
       (SELECT aa.display_name FROM payee_acknowledgement pa
          JOIN actor aa ON aa.id = pa.acknowledged_by
         WHERE pa.verification_id = l.id
         ORDER BY pa.acknowledged_at DESC LIMIT 1)      AS acknowledged_by_name,
       (SELECT pa.reason FROM payee_acknowledgement pa
         WHERE pa.verification_id = l.id
         ORDER BY pa.acknowledged_at DESC LIMIT 1)      AS acknowledgement_reason,

       -- The near-duplicate probe: another payee on the same book with a
       -- byte-identical holder name and DIFFERENT bank details. This is
       -- the only account-number check available to a system that stores
       -- four digits, and it catches the specific real-world failure of
       -- paying the right supplier at their old account. Byte-identical
       -- on purpose — the fuzzy version of this question is answered in
       -- TypeScript, where the same normaliser the name match uses can
       -- be applied to both sides.
       EXISTS (
         SELECT 1 FROM payee o
          WHERE o.business_id = p.business_id
            AND o.id <> p.id
            AND o.holder_name = p.holder_name
            AND (o.routing_number IS DISTINCT FROM p.routing_number
                 OR o.account_number_last4 IS DISTINCT FROM p.account_number_last4)
       )                                                AS has_conflicting_twin
  FROM payee p
  JOIN business b        ON b.id = p.business_id
  JOIN actor ca          ON ca.id = p.created_by
  LEFT JOIN payee_archival ar ON ar.payee_id = p.id
  LEFT JOIN latest l     ON l.payee_id = p.id
  LEFT JOIN actor va     ON va.id = l.checked_by;

COMMENT ON VIEW v_payee_book IS
  'Derived standing per payee: the newest check, how old it is, whether its warning was signed for, and whether a twin with different bank details exists. There is deliberately no stored copy of any of it.';


-- ---------------------------------------------------------------------
-- 13.  An acknowledgement only exists for a warning
-- ---------------------------------------------------------------------
--
-- 0007's instinct: the thing the application must not be trusted to get
-- right is checked at the row. Signing for a clean check is noise in an
-- audit trail, and signing for a block is a contradiction — blocks are
-- not stored, and if one ever were, this refuses to let anyone wave it
-- through.
CREATE OR REPLACE FUNCTION assert_payee_acknowledgement_answers_a_warning()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_outcome payee_verification_outcome;
BEGIN
  SELECT outcome INTO v_outcome
    FROM payee_verification WHERE id = NEW.verification_id;

  IF v_outcome IS NULL THEN
    RAISE EXCEPTION 'payee verification % does not exist', NEW.verification_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_outcome <> 'warned' THEN
    RAISE EXCEPTION
      'a payee acknowledgement answers a WARNING; verification % is %',
      NEW.verification_id, v_outcome
      USING ERRCODE = 'check_violation',
            HINT = 'A clean check needs no signature, and a block cannot be acknowledged by anybody.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payee_acknowledgement_answers_a_warning
  BEFORE INSERT ON payee_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION assert_payee_acknowledgement_answers_a_warning();


-- ---------------------------------------------------------------------
-- 14.  Append-only, in two layers
-- ---------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payee', 'payee_archival', 'payee_verification',
    'payee_acknowledgement', 'payee_candidate_refusal'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_no_update_delete BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON
  payee, payee_archival, payee_verification,
  payee_acknowledgement, payee_candidate_refusal
TO corgi_app;

-- Explicit and redundant, so a reviewer can grep for it — 0001's words.
REVOKE UPDATE, DELETE, TRUNCATE ON
  payee, payee_archival, payee_verification,
  payee_acknowledgement, payee_candidate_refusal
FROM corgi_app, PUBLIC;

GRANT SELECT ON v_payee_book TO corgi_app;

GRANT EXECUTE ON FUNCTION aba_checksum_ok(text) TO corgi_app;
GRANT EXECUTE ON FUNCTION aba_prefix_assigned(text) TO corgi_app;
GRANT EXECUTE ON FUNCTION payee_verification_freshness(timestamptz, timestamptz) TO corgi_app;
