-- =====================================================================
-- 0031  Interchange: the first posting on this book that answers a
--       BUSINESS question rather than a correctness one
-- =====================================================================
--
-- `4100 Interchange income` has been in the chart of accounts since
-- migration 0001. Nothing has ever posted to it. Every other line on
-- this ledger answers "did the money move, did it balance, can we prove
-- what we believed on Tuesday". This one answers "does the card
-- programme make money", and it is the question a company that runs card
-- programmes is actually asking.
--
-- ---------------------------------------------------------------------
-- 1.  INTERCHANGE IS EARNED ON THE CLEARING, NOT ON THE AUTHORISATION
-- ---------------------------------------------------------------------
--
-- This is the whole of the domain content and it is the one thing that
-- would be catastrophic to get wrong in the obvious direction.
--
-- An authorisation is a HOLD. It moves the memo book (9100/<biz> against
-- 9900) and the financial book does not move at all -- there is no code
-- path from an authorisation to postCardMovement(), by construction
-- (src/lib/holds/store.ts). The money that finally settles can be a
-- different amount, it can arrive days later, and it can never arrive:
-- an expiry, a full reversal and a $0 card-on-file verification all end
-- with nothing settled.
--
-- So interchange booked at authorisation is revenue booked on money that
-- may never exist. It is recognised HERE, on the clearing -- the same
-- event, the same value date and the same customer leg that
-- postCardMovement() posts, so the revenue and the spend it came from
-- are dated identically and a day's P&L is internally consistent.
--
--   authorisation       9100/<biz> credit, 9900 debit        -- memo only
--   clearing            2100/<biz> debit,  2200 credit       -- the spend
--   INTERCHANGE         2200 debit,        4100 credit       -- THIS FILE
--
-- ---------------------------------------------------------------------
-- 2.  WHY THE DEBIT IS 2200 AND NOT 1120
-- ---------------------------------------------------------------------
--
-- `2200 Card network settlement payable` is what we owe the network for
-- cleared spend. Interchange is precisely the part of that spend we do
-- NOT owe them: the acquirer pays the issuer the ticket LESS
-- interchange. Debiting 2200 is therefore not a bookkeeping convenience,
-- it is the economically true statement -- after this entry 2200 holds
-- the NET figure we will actually fund into the settlement window, which
-- is the number a treasury operator needs.
--
-- Debiting `1120 Card network settlement receivable` instead would
-- inflate both sides of the balance sheet with a receivable and a
-- payable against the same counterparty for the same transaction, and
-- 1120's own note already scopes it to the gap between a clearing and
-- the day the network's file funds it.
--
-- THE INTERCHANGE ENTRY IS ITS OWN ENTRY, not a third line on the
-- clearing. Two reasons, and the second is load-bearing:
--
--   (a) The clearing is a statement about the CUSTOMER's money and the
--       interchange is a statement about OURS. One event, two facts,
--       two entries, each of which balances on its own.
--
--   (b) postCardCorrection() refuses to re-book an entry that does not
--       have exactly two lines -- "a partial card correction can only
--       re-book a two-line entry without inventing an allocation". A
--       third line on the clearing would break the correction path for
--       every partially corrected settlement on this book. Measured by
--       reading the code before writing this, not after.
--
-- ---------------------------------------------------------------------
-- 3.  THE ROUNDING RULE: DESIGN §12.2, AND NO THIRD RULE IS ADDED
-- ---------------------------------------------------------------------
--
-- DESIGN §12 has two rules and the skill is knowing which one applies.
--
--   §12.2  ONE value -> ONE cent amount:      round HALF TO EVEN.
--   §12.3  ONE amount split across N shares:  LARGEST REMAINDER.
--
-- Interchange is §12.2. "A percentage of an amount" sounds like a split
-- and is not one: §12.3's precondition is a SOURCE AMOUNT distributed
-- across shares that must add back up to it exactly, and the residual
-- penny exists only because the shares owe the source a total.
-- Interchange has no source to distribute -- the settled amount is not
-- being divided between parties, it is an INPUT to a price, and the
-- price is one number. docs/ACCRUAL.md §13 makes exactly this argument
-- one product over ("largest-remainder needs a source amount to
-- distribute; daily interest has none") and it transfers verbatim.
--
-- THE FIXED COMPONENT IS WHERE A FLOAT WOULD TRY TO SNEAK IN, AND IT
-- DOES NOT CHANGE THE ANSWER. `$0.10` is already an integer number of
-- cents. It is not divided, it is not rounded, and it is ADDED AFTER the
-- ad-valorem half has become an integer:
--
--     ad_valorem  = round_half_even(|settled| * rate_bps / 10000)
--     interchange = ad_valorem + fixed_cents
--
-- One rounding step, one operand. Integer + integer cannot produce a
-- fraction, so there is no second rounding decision to make and no third
-- rule to invent. THIS FILE DEFINES NO NEW ROUNDING FUNCTION. It calls
-- 0024's `interest_round_half_even(bigint, bigint)`, which is the §12.2
-- implementation this database already carries. That function is named
-- for the product that first needed it; it is the RULE, not the product,
-- and a second body of it would be a reconciliation break waiting to
-- happen exactly as a third rule would.
--
-- HALF TO EVEN AND NOT HALF UP, and here §12.2's own justification is
-- literally about this feature: "half-up biases every tie in one
-- direction, and over a year of INTERCHANGE that bias is a real number."
-- A half-cent tie is a tie between us and the acquirer; half-up hands it
-- to us every single time, forever.
--
-- NOBODY EATS A RESIDUAL PENNY, and that is not a contradiction. §12.3's
-- residual is real money that must land on one of the shares. §12.2 has
-- none to place: the sub-cent fraction was never money, no party was
-- credited with it, and the entry is two equal and opposite lines
-- summing to zero. §12.6's dust account 2900 is NOT engaged either --
-- 2900 exists for dust that ARRIVED as a real external amount with more
-- precision than a cent, where truncating would break the identity
-- between customer balances and our obligation. A fraction of a cent of
-- interchange never arrived. `remainder_units` is stored on the row and
-- rendered on the screen, so the fraction dropped is visible rather than
-- merely absent, and the bound is half a cent per settlement.
--
-- ---------------------------------------------------------------------
-- 4.  THE DIMENSIONS, MEASURED BEFORE THEY WERE DESIGNED
-- ---------------------------------------------------------------------
--
-- Interchange is not one number: it varies by merchant category, by
-- whether the card was present, and by card product. The rule the brief
-- sets is "pick the dimensions the Lithic event data ACTUALLY carries",
-- so every `card_transaction.updated` payload in webhook_inbox was
-- surveyed first:
--
--   merchant.mcc           PRESENT, VARIED. 100+ distinct four-digit
--                          codes; 5542 (automated fuel dispensers)
--                          dominates at 341 payloads because the brief's
--                          own fuel-pump scenario generated most of this
--                          traffic. 5812 and 5814 (eating places, fast
--                          food) follow. THIS IS THE DIMENSION THAT DOES
--                          REAL WORK ON THIS BOOK.
--
--   pos.entry_mode.pan     PRESENT on every payload and CONSTANT:
--   pos.terminal.type      'MANUAL' at a 'PHONE' terminal, attended
--   pos.terminal.attended  false. That is a keyed phone order and it is
--                          card-NOT-present. The field is real and it is
--                          read; the sandbox never varies it, so the
--                          card-present arm of the rate card ships
--                          correct and unexercised AND SAYS SO. Lithic's
--                          simulate endpoints accept `mcc` and the
--                          merchant acceptor fields and do NOT accept a
--                          POS entry mode, so there is no way to make it
--                          vary from our side. Measured, not assumed.
--
--   network                PRESENT, constant 'VISA'.
--   merchant.country       PRESENT, constant 'USA'.
--                          NEITHER IS A RATE-CARD DIMENSION. A dimension
--                          with one observed value is a dimension you
--                          cannot demonstrate, and a rate card keyed on
--                          one would be decoration. Both are stored on
--                          the posting as EVIDENCE and joined on by
--                          nothing.
--
--   CARD PRODUCT           NOT BUILT. Real interchange varies by
--                          consumer credit / business credit / regulated
--                          debit, and it would be the natural third
--                          dimension -- but it is not in the EVENT. It
--                          lives on Lithic's card object, our own `card`
--                          table stores last_four and nickname only, and
--                          every card here was created by one call with
--                          one set of defaults. Populating it would mean
--                          inventing a product per card and then pricing
--                          against the invention. Named as a gap in
--                          docs/INTERCHANGE.md instead of half-built.
--
-- So the rate card is keyed on (category, presentment) and on nothing
-- else, and `category` is resolved from the MCC through a table whose
-- DEFAULT IS A ROW rather than a constant in two places.
--
-- ---------------------------------------------------------------------
-- 5.  RATES ARE CONFIGURATION, EFFECTIVE-DATED, AND CANNOT REACH BACK
-- ---------------------------------------------------------------------
--
-- `approval_policy` (0001 §12), `funds_availability_policy` (0001 §5)
-- and `interest_rate_policy` (0024 §5) are the pattern, and this is the
-- fourth of them: a policy is a fact with a lifespan, it lives in its
-- own versioned table, it is append-only, and a change is a NEW ROW WITH
-- A LATER EFFECTIVE DATE.
--
-- Three layers make "a changed rate must not retroactively re-price a
-- settlement from last week" true, and only the first is a convention:
--
--   (1) Resolution is on the SETTLEMENT'S VALUE DATE.
--       interchange_rate_at(category, presentment, value_date) is the
--       greatest effective_from not after that date. A replay of an old
--       settlement passes the old date and gets the old card back -- by
--       construction, not by anyone remembering.
--
--   (2) interchange_rate_policy_forward_only REFUSES THE INSERT. A new
--       row must be strictly later than every existing row for its
--       (category, presentment) AND strictly later than every settlement
--       already priced under it. The second condition is the one with
--       teeth: without it, a row dated last Tuesday satisfies the first
--       when the newest card is from last Monday, and silently re-prices
--       every settlement in between. Refusing the INSERT is the right
--       remedy, because afterwards the postings are immutable and the
--       only repair is a reversal and a re-book of every affected
--       settlement.
--
--   (3) v_interchange_rate_drift MUST RETURN ZERO ROWS. The same
--       question asked of the whole book at any moment: every posting
--       must still resolve to the card effective on its own value date.
--       It is what would catch a policy row inserted behind the
--       trigger's back, and it is in scripts/dbcheck.mjs.
--
-- AND THE POSTING STORES THE RESOLVED RATE. When a settlement is later
-- corrected, the interchange is RE-PRICED AT THE STORED POLICY, never at
-- whatever the card says today. A correction is a restatement of what
-- happened on the original date, so it is priced by the card that was in
-- force on the original date. The rebook carries the original's value
-- date for exactly the same reason.
--
-- ---------------------------------------------------------------------
-- 6.  THE TRAP, AND THE INVARIANT WRITTEN FOR IT
-- ---------------------------------------------------------------------
--
-- A SETTLEMENT CAN BE REVERSED. This build has a whole bitemporal
-- correction machinery for exactly that (src/lib/holds/corrections.ts,
-- reverseAndRebook() in src/lib/ledger/post.ts), and 54 settlements on
-- this book with real provider payloads have already been through it.
--
-- Interchange booked on a settlement that later reverses must reverse
-- too -- AS A NEW ENTRY AT THE ORIGINAL VALUE DATE, never an edit. If
-- the reversal path does not unbook it, the ledger quietly overstates
-- revenue for ever, and NOT ONE EXISTING INVARIANT WOULD NOTICE: every
-- existing invariant is about whether entries BALANCE, and an
-- interchange entry that should not exist balances perfectly.
--
-- So this file ships two invariants for it, and the second exists
-- because of what the first excludes:
--
--   v_interchange_unreversed  DID THE REPAIR HAPPEN AT ALL? An
--                             interchange posting whose SETTLEMENT has a
--                             reversal and whose own entry has none.
--
--   v_interchange_drift       IS THE AMOUNT RIGHT? What does this
--                             settlement's correction group now net to
--                             on the customer's own leg, what should
--                             that be worth at the rate this posting was
--                             priced at, and what do the 4100 lines of
--                             the interchange correction group actually
--                             say? A settlement corrected to zero must
--                             carry zero interchange.
--
-- NEITHER READS `interchange_reversal`, AND THAT IS THE WHOLE POINT.
-- The first draft of the first view asked "is there an
-- interchange_reversal row", which is a question about BOOKKEEPING and
-- not about money. It fails in BOTH directions: writing a row silences
-- it while the revenue stands, and losing a row screams while the
-- journal is perfectly correct. Both were observed while building this
-- -- the second one against this database, where 56 correctly repaired
-- settlements reported as unrepaired because the audit table had been
-- rebuilt and the journal had not. A guard whose exclusion is shaped
-- like the failure it watches for is this repository's most-repeated
-- defect; a guard that reads a side table instead of the ledger is the
-- same defect wearing a different hat. Both views read journal_entry
-- and journal_line, and nothing else.
--
-- BOTH WERE MADE TO FAIL BEFORE EITHER WAS TRUSTED, against this
-- database, in transactions that were rolled back. The proof is written
-- out in docs/INTERCHANGE.md §7 with the row counts. A new invariant
-- that has never returned a row is a comment.
--
-- ---------------------------------------------------------------------
-- 7.  What this file does NOT do
-- ---------------------------------------------------------------------
--
-- It does not post a single journal line. postEntry() -> ledger_append()
-- does that and nothing else does, so every table below is the AUDIT of
-- money movement plus the policy it was priced by. They are append-only
-- in two layers (§14) for the reason 0024 gives: an audit trail you can
-- UPDATE is a story.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 8.  Vocabulary
-- ---------------------------------------------------------------------

-- WAS THE CARD PHYSICALLY THERE? Read off pos.entry_mode.pan and from
-- nothing else -- see src/lib/interchange/dimensions.ts for the mapping
-- and for the measurement of what this sandbox emits.
--
-- 'unknown' is a real third state and not an error, in the same way
-- `card_auth_event_result.result` IS NULL is "we were not told" rather
-- than "the network said no". It is priced, deliberately, at the
-- CARD-PRESENT rate: card-present interchange is the LOWER of the two,
-- so an unproven presentment books the smaller number. Revenue we cannot
-- substantiate is revenue we do not claim.
CREATE TYPE interchange_presentment AS ENUM
  ('card_present', 'card_not_present', 'unknown');

COMMENT ON TYPE interchange_presentment IS
  'How the PAN reached the terminal. card_present = the card itself was read (contactless, chip, stripe). card_not_present = the number arrived without the card (keyed, e-commerce, credential on file). unknown = the payload carried no pos block, and is priced at the LOWER card-present rate so that unsubstantiated revenue is never claimed.';

-- WHICH WAY THE MONEY WENT, and therefore which way the interchange
-- went. A purchase earns it; a refund hands it back.
CREATE TYPE interchange_direction AS ENUM ('earned', 'returned');

COMMENT ON TYPE interchange_direction IS
  'earned = a debit settlement (clearing, force post): 2200 debit, 4100 credit. returned = a credit settlement (refund): the same entry with the signs swapped. A purchase fully refunded nets to ZERO interchange by construction, with no arm and no special case.';


-- ---------------------------------------------------------------------
-- 9.  The arithmetic, as IMMUTABLE integer functions
-- ---------------------------------------------------------------------
--
-- Every operand and every result is bigint or a small int. No numeric,
-- no float, no division that is not integer division, no intermediate
-- that holds a fraction. IMMUTABLE so a CHECK constraint may call them,
-- which is the point: TypeScript computes the same integers and the
-- database refuses to store any other answer.
--
-- NOTE THE FUNCTION THAT IS NOT DEFINED HERE. There is no
-- `interchange_round_half_even`. §12.2 has ONE implementation in this
-- database and this file adds none; it calls 0024's. See §3.

-- The percentage half: |amount| * rate_bps / 10000, rounded half to
-- even. 10000 because a rate is in BASIS POINTS, which is how a rate is
-- stored integer-scaled: 165 bps is 1.65% and is the integer 165, never
-- 0.0165.
--
-- abs() and not the signed amount: the sign is carried by
-- interchange_direction and applied when the entry is built. Truncating
-- division on a signed basis would round earned interchange away from
-- zero and returned interchange toward it -- a systematic bias in our
-- favour that no line of code would have had to state out loud.
CREATE FUNCTION interchange_ad_valorem_cents(p_amount_cents bigint, p_rate_bps int)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT interest_round_half_even(abs(p_amount_cents) * p_rate_bps::bigint, 10000::bigint)
$$;

-- The whole price of one settlement, as a MAGNITUDE. THE ONLY ADDITION
-- IN THE FILE, and it is integer + integer: the fixed component is
-- already cents, so it introduces no fraction and therefore no second
-- rounding decision.
CREATE FUNCTION interchange_cents(p_amount_cents bigint, p_rate_bps int, p_fixed_cents bigint)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT interchange_ad_valorem_cents(p_amount_cents, p_rate_bps) + p_fixed_cents
$$;

-- THE ONE DEFINITION of "how much interchange should exist for this
-- settlement, right now", in NATURAL terms: positive is revenue to us,
-- negative is revenue handed back, zero is a settlement that has been
-- corrected out of existence.
--
-- `p_net_customer_cents` is the customer's own leg across the
-- settlement's whole correction group, signed the way the ledger signs a
-- line: POSITIVE is a debit -- money away from the customer, i.e. a
-- purchase -- and negative is a credit.
--
-- Used by the booking path, by the correction path and by
-- v_interchange_drift, which is what makes those three unable to
-- disagree. THE ZERO ARM IS THE TRAP: a settlement reversed in full
-- nets to zero and is therefore worth zero interchange, and the drift
-- view measures exactly that.
CREATE FUNCTION interchange_natural_cents(
  p_net_customer_cents bigint, p_rate_bps int, p_fixed_cents bigint)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
           WHEN p_net_customer_cents = 0 THEN 0::bigint
           WHEN p_net_customer_cents > 0
             THEN  interchange_cents(p_net_customer_cents, p_rate_bps, p_fixed_cents)
           ELSE   -interchange_cents(p_net_customer_cents, p_rate_bps, p_fixed_cents)
         END
$$;

CREATE FUNCTION interchange_direction_of(p_net_customer_cents bigint)
RETURNS interchange_direction
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN p_net_customer_cents >= 0 THEN 'earned' ELSE 'returned' END::interchange_direction
$$;

COMMENT ON FUNCTION interchange_cents(bigint, int, bigint) IS
  'DESIGN §12.2: one value -> one cent amount. round_half_even(|amount| * bps / 10000) + fixed_cents. The fixed half is already an integer number of cents, so there is exactly one rounding step in the whole calculation and this ledger still has exactly two rounding rules.';
COMMENT ON FUNCTION interchange_natural_cents(bigint, int, bigint) IS
  'What a settlement is worth in interchange given what its correction group NOW nets to. Zero net means zero interchange -- which is the reversal trap, expressed as arithmetic rather than as a procedure somebody has to remember to run.';

ALTER FUNCTION interchange_ad_valorem_cents(bigint, int)        SET search_path = public, pg_temp;
ALTER FUNCTION interchange_cents(bigint, int, bigint)           SET search_path = public, pg_temp;
ALTER FUNCTION interchange_natural_cents(bigint, int, bigint)   SET search_path = public, pg_temp;
ALTER FUNCTION interchange_direction_of(bigint)                 SET search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- 10.  Merchant category: the bands, and the map into them
-- ---------------------------------------------------------------------

-- A named band on the rate card. Exists so a posting cites something the
-- database can check -- a free-text category would let a typo price a
-- settlement against a band that has no rate rows, and the failure would
-- surface at the posting rather than at the mapping.
--
-- EXACTLY ONE BAND IS THE DEFAULT, and it is a ROW rather than a
-- constant in two places. `interchange_category_of()` falls through to
-- it for any MCC the map does not name, so "what happens to an MCC we
-- have never seen" is answerable by SELECT rather than by grep.
CREATE TABLE interchange_category (
  category    text PRIMARY KEY CHECK (length(btrim(category)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX interchange_category_one_default_idx
  ON interchange_category (is_default) WHERE is_default;

COMMENT ON INDEX interchange_category_one_default_idx IS
  'Exactly one default band, enforced. Two defaults would make interchange_category_of() non-deterministic for every unmapped MCC, and the rate it resolved would depend on the plan.';

-- MCC -> band. One row per code we have an opinion about; everything
-- else falls to the default.
--
-- THE MAP IS NOT EFFECTIVE-DATED AND THE RATE CARD IS, and that
-- distinction is deliberate. A CLASSIFICATION is not a PRICE: 5542 has
-- been automated fuel dispensers since long before this ledger existed
-- and will not stop being that. What changes is what we charge for fuel,
-- and that is a rate-card row with a date on it. Re-classifying an MCC
-- WOULD re-price history, which is why the posting stores its resolved
-- `category` and `policy_id` and v_interchange_rate_drift checks the
-- rate against the posting's own stored category -- so a re-classing
-- shows up as a decision about future settlements, never as a silent
-- restatement of past ones.
CREATE TABLE interchange_mcc (
  mcc        text PRIMARY KEY CHECK (mcc ~ '^[0-9]{4}$'),
  category   text NOT NULL REFERENCES interchange_category(category),
  note       text NOT NULL CHECK (length(btrim(note)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX interchange_mcc_category_idx ON interchange_mcc (category);

-- The band for one MCC, or the default. STABLE -- it reads a table -- so
-- it cannot appear in a CHECK, which is exactly why the posting stores
-- the resolved category rather than re-deriving it on read.
CREATE FUNCTION interchange_category_of(p_mcc text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
           (SELECT m.category FROM interchange_mcc m WHERE m.mcc = p_mcc),
           (SELECT c.category FROM interchange_category c WHERE c.is_default))
$$;

ALTER FUNCTION interchange_category_of(text) SET search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- 11.  The rate card: one row per (band, presentment, effective date)
-- ---------------------------------------------------------------------
--
-- interest_rate_policy's shape, with the two components a real
-- interchange rate has. BOTH COMPONENTS ON ONE ROW on purpose: a card
-- that let the percentage change on one date and the fixed fee on
-- another would make "what did we charge for fuel on 10 September" a
-- question with two answers and a join.
CREATE TABLE interchange_rate_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category       text NOT NULL REFERENCES interchange_category(category),
  presentment    interchange_presentment NOT NULL,
  effective_from date NOT NULL,

  -- The percentage half, integer basis points, never a decimal and never
  -- a float: 165 is 1.65%.
  rate_bps       integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  -- The per-transaction half, already an integer number of cents: 10 is
  -- $0.10. Bounded at $100 so a typo cannot price a coffee at the cost
  -- of a car -- the same reason rate_bps is bounded at 100%.
  fixed_cents    bigint  NOT NULL CHECK (fixed_cents BETWEEN 0 AND 10000),

  note           text NOT NULL CHECK (length(btrim(note)) > 0),
  created_by     uuid NOT NULL REFERENCES actor(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT interchange_rate_policy_version
    UNIQUE (category, presentment, effective_from)
);

CREATE INDEX interchange_rate_policy_lookup_idx
  ON interchange_rate_policy (category, presentment, effective_from DESC);

COMMENT ON TABLE interchange_rate_policy IS
  'The rate card, effective-dated and append-only. approval_policy, funds_availability_policy and interest_rate_policy are the pattern; the addition here, as in 0024, is a trigger that refuses a row which would re-price a settlement already on the ledger.';
COMMENT ON COLUMN interchange_rate_policy.fixed_cents IS
  'The per-transaction component, in whole cents. It is an integer before the arithmetic starts and is ADDED AFTER the ad-valorem half has been rounded, which is why percent-plus-fixed needs no second rounding rule.';


-- THE RULE THAT MAKES "A CHANGED RATE CANNOT RE-PRICE LAST WEEK" A
-- CONSTRAINT RATHER THAN A CONVENTION. Two conditions, and the second is
-- the one with teeth. See §5.
CREATE FUNCTION assert_interchange_rate_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_latest date;
  v_priced date;
BEGIN
  SELECT max(p.effective_from) INTO v_latest
    FROM interchange_rate_policy p
   WHERE p.category = NEW.category AND p.presentment = NEW.presentment;

  IF v_latest IS NOT NULL AND NEW.effective_from <= v_latest THEN
    RAISE EXCEPTION
      'rate card (%, %) already has a rate effective %; a rate change is a LATER row, never an earlier or equal one',
      NEW.category, NEW.presentment, v_latest USING ERRCODE = '55006';
  END IF;

  SELECT max(ip.value_date) INTO v_priced
    FROM interchange_posting ip
   WHERE ip.category = NEW.category AND ip.presentment = NEW.presentment;

  IF v_priced IS NOT NULL AND NEW.effective_from <= v_priced THEN
    RAISE EXCEPTION
      'rate card (%, %) has already priced settlements through %; a rate effective % would retroactively re-price entries already on the ledger',
      NEW.category, NEW.presentment, v_priced, NEW.effective_from USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_interchange_rate_policy() SET search_path = public, pg_temp;

CREATE TRIGGER interchange_rate_policy_forward_only
  BEFORE INSERT ON interchange_rate_policy
  FOR EACH ROW EXECUTE FUNCTION assert_interchange_rate_policy();


-- THE ONLY DEFINITION of "which rate applied on which date": the
-- greatest effective_from not after the settlement's value date. STABLE,
-- so it cannot appear in a CHECK -- which is exactly why the posting
-- stores the resolved policy id and v_interchange_rate_drift compares
-- the two.
CREATE FUNCTION interchange_rate_at(
  p_category text, p_presentment interchange_presentment, p_date date)
RETURNS interchange_rate_policy
LANGUAGE sql STABLE AS $$
  SELECT p.*
    FROM interchange_rate_policy p
   WHERE p.category = p_category
     AND p.presentment = p_presentment
     AND p.effective_from <= p_date
   ORDER BY p.effective_from DESC
   LIMIT 1
$$;

ALTER FUNCTION interchange_rate_at(text, interchange_presentment, date)
  SET search_path = public, pg_temp;

COMMENT ON FUNCTION interchange_rate_at(text, interchange_presentment, date) IS
  'The rate card as it stood on a business date. One definition, asked by the booking path, by the lifecycle trigger and by v_interchange_rate_drift -- so a replay of an old settlement re-derives the old rate by construction rather than by care.';


-- ---------------------------------------------------------------------
-- 12.  The posting: one per settlement event, with the whole working
-- ---------------------------------------------------------------------
--
-- "A number a customer cannot reproduce by hand is a number they will
-- dispute" -- 0024 §13, and it applies with more force to revenue,
-- because the counterparty here is an acquirer with its own ledger. The
-- row carries the hand calculation and not just its answer: the
-- dimensions it was priced on, the rate card row it resolved, the exact
-- fraction as its two integers, the quotient, the remainder, which way
-- it rounded, the ad-valorem half, the fixed half and the total.

CREATE TABLE interchange_posting (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ---- the settlement event this prices -----------------------------
  provider             text NOT NULL CHECK (length(btrim(provider)) > 0),
  -- Lithic's own immutable event token. THE UNIQUE KEY BELOW IS WHAT
  -- MAKES THIS EXACTLY-ONCE: a redelivered webhook cannot book a second
  -- interchange entry, decided by Postgres and not by an `if`.
  provider_event_id    text NOT NULL CHECK (length(btrim(provider_event_id)) > 0),
  auth_id              uuid NOT NULL REFERENCES card_authorization(id),
  card_id              uuid NOT NULL REFERENCES card(id),
  business_id          uuid NOT NULL REFERENCES business(id),
  -- The customer's own 2100 leaf. Stored so the drift view can ask what
  -- the settlement's correction group nets to WITHOUT re-deriving which
  -- account that was, which would be a second answer to a question the
  -- chart already has one answer to.
  deposit_account_id   uuid NOT NULL REFERENCES account(id),

  -- The entry postCardMovement() wrote for the settlement, and the entry
  -- THIS posting's interchange was written to. Two different entries, by
  -- design -- see §2(b).
  settlement_entry_id  uuid NOT NULL REFERENCES journal_entry(id),
  entry_id             uuid NOT NULL REFERENCES journal_entry(id),

  -- The settlement's value date, which is the interchange entry's value
  -- date too: the revenue and the spend it came from are dated
  -- identically or a day's P&L is not internally consistent.
  value_date           date NOT NULL,
  direction            interchange_direction NOT NULL,
  -- The customer's own leg on the settlement entry, SIGNED. Positive is
  -- a debit (a purchase). This is the input to the price and it is
  -- re-derived by the lifecycle trigger from the journal line itself.
  settled_cents        bigint NOT NULL CHECK (settled_cents <> 0),

  -- ---- the dimensions, as read off the provider's own payload -------
  -- NULL when the payload carried no MCC: "we were not told", which
  -- resolves to the default band rather than blocking the price.
  mcc                  text CHECK (mcc IS NULL OR mcc ~ '^[0-9]{4}$'),
  category             text NOT NULL REFERENCES interchange_category(category),
  presentment          interchange_presentment NOT NULL,
  -- Evidence for `presentment` and for the row generally. Joined on by
  -- nothing: see §4 on why `network` is not a rate-card dimension.
  entry_mode           text,
  terminal_type        text,
  network              text,
  descriptor           text,

  -- ---- the price ----------------------------------------------------
  policy_id            uuid NOT NULL REFERENCES interchange_rate_policy(id),
  rate_bps             integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  fixed_cents          bigint  NOT NULL CHECK (fixed_cents BETWEEN 0 AND 10000),

  -- ---- the exact fraction, as the two integers it actually is -------
  numerator            bigint NOT NULL CHECK (numerator >= 0),
  denominator          bigint NOT NULL CHECK (denominator = 10000),
  whole_cents          bigint NOT NULL CHECK (whole_cents >= 0),
  remainder_units      bigint NOT NULL CHECK (remainder_units >= 0),
  rounding             interest_rounding NOT NULL,   -- 0024's enum, reused
  ad_valorem_cents     bigint NOT NULL CHECK (ad_valorem_cents >= 0),
  -- The magnitude posted. `direction` says which way it went.
  interchange_cents    bigint NOT NULL CHECK (interchange_cents > 0),

  posted_at            timestamptz NOT NULL DEFAULT now(),
  posted_by_run        text NOT NULL CHECK (length(btrim(posted_by_run)) > 0),

  CONSTRAINT interchange_posting_event UNIQUE (provider, provider_event_id),
  -- One settlement entry is priced at most once. Belt to the unique
  -- key's braces: the event id is the provider's fact and this is ours,
  -- and a bug that produced two event ids for one entry would otherwise
  -- double-book the revenue while every existing invariant stayed green.
  CONSTRAINT interchange_posting_settlement UNIQUE (settlement_entry_id),
  -- And one interchange entry belongs to one posting.
  CONSTRAINT interchange_posting_entry UNIQUE (entry_id),

  -- =================================================================
  -- THE ARITHMETIC, RE-DERIVED BY THE DATABASE ON EVERY INSERT.
  --
  -- Seven relations over three inputs (the settled amount, the rate and
  -- the fixed fee). A row that disagrees with §12.2 by one cent cannot
  -- be stored, so the figures the screen renders are not a claim ABOUT
  -- the arithmetic -- they ARE the arithmetic, checked by the thing that
  -- persisted them.
  --
  -- The last conjunct restates the half-even tiebreak INLINE rather than
  -- delegating to interest_round_half_even() a second time. It is
  -- deliberately redundant: if someone ever "optimises" that function
  -- into half-up, this line disagrees and no row can be written at all.
  -- =================================================================
  CONSTRAINT interchange_posting_arithmetic CHECK (
        denominator       = 10000
    AND numerator         = abs(settled_cents) * rate_bps::bigint
    AND whole_cents       = numerator / denominator
    AND remainder_units   = numerator % denominator
    AND rounding          = interest_rounding_of(numerator, denominator)
    AND ad_valorem_cents  = interchange_ad_valorem_cents(settled_cents, rate_bps)
    AND interchange_cents = public.interchange_cents(settled_cents, rate_bps, fixed_cents)
    AND direction         = interchange_direction_of(settled_cents)
    AND ad_valorem_cents  = whole_cents + CASE
                              WHEN 2 * remainder_units > denominator THEN 1
                              WHEN 2 * remainder_units < denominator THEN 0
                              ELSE whole_cents % 2
                            END
  )
);

CREATE INDEX interchange_posting_business_idx ON interchange_posting (business_id, value_date);
CREATE INDEX interchange_posting_category_idx ON interchange_posting (category, presentment);
CREATE INDEX interchange_posting_policy_idx   ON interchange_posting (policy_id);
CREATE INDEX interchange_posting_date_idx     ON interchange_posting (value_date DESC);

COMMENT ON TABLE interchange_posting IS
  'One priced settlement. UNIQUE (provider, provider_event_id) is what makes booking exactly-once under redelivery; UNIQUE (settlement_entry_id) is the second lock, because double-booked revenue balances perfectly and no other invariant on this book would see it.';
COMMENT ON CONSTRAINT interchange_posting_arithmetic ON interchange_posting IS
  'Re-derives every operand from the settled amount, the rate and the fixed fee, and restates DESIGN §12.2s half-even tiebreak inline so a change to the shared rounding function alone cannot pass. TypeScript computes, Postgres verifies.';


-- ---------------------------------------------------------------------
-- 13.  The unbooking: at most once, by PRIMARY KEY
-- ---------------------------------------------------------------------
--
-- hold_closure's shape, and for hold_closure's reason: PRIMARY KEY
-- (interchange_posting_id) makes this exactly-once BY CONSTRUCTION.
-- There is no second row to write, so there is no flag anyone can set
-- twice and no counter anyone can double-decrement.
--
-- The reversal is a NEW ENTRY AT THE ORIGINAL VALUE DATE, written by
-- reverseAndRebook(), never an edit. When the settlement was corrected
-- to a non-zero figure rather than reversed outright, the re-book lands
-- at that same original date for the re-priced amount -- AT THE POLICY
-- THE ORIGINAL POSTING STORED, because a correction is a restatement of
-- what happened on the original date and must be priced by the card that
-- was in force then.
CREATE TABLE interchange_reversal (
  interchange_posting_id   uuid PRIMARY KEY REFERENCES interchange_posting(id),
  reason                   text NOT NULL CHECK (length(btrim(reason)) > 0),
  reversal_entry_id        uuid NOT NULL REFERENCES journal_entry(id),
  rebook_entry_id          uuid REFERENCES journal_entry(id),
  -- What the settlement's correction group nets to on the customer's
  -- leg, signed, at the moment of the repair. Zero for a full reversal.
  net_settled_cents        bigint NOT NULL,
  -- The re-priced interchange in NATURAL terms: positive is revenue we
  -- keep, negative is revenue handed back, zero is a settlement
  -- corrected out of existence.
  rebook_natural_cents     bigint NOT NULL,
  -- The ORIGINAL's value date, always. The whole point of the feature.
  value_date               date NOT NULL,
  correction_group_id      uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL REFERENCES actor(id),

  -- A full unbook has no re-book and nets to nothing; a re-priced one
  -- has both. There is no third shape.
  -- A full unbook has no re-book; a re-priced one has one. There is no
  -- third shape. The coupling is to the REBOOK AMOUNT and not to
  -- net_settled_cents, because a small enough non-zero net can price to
  -- zero interchange at a band with no fixed component (charity, 100 bps
  -- and no fixed fee: a 40c donation rounds to nothing), and that is a
  -- full unbook with a non-zero net. assert_interchange_reversal() holds
  -- rebook_natural_cents equal to the arithmetic either way.
  CONSTRAINT interchange_reversal_shape CHECK (
       (rebook_natural_cents =  0 AND rebook_entry_id IS NULL)
    OR (rebook_natural_cents <> 0 AND rebook_entry_id IS NOT NULL)
  )
);

CREATE INDEX interchange_reversal_entry_idx ON interchange_reversal (reversal_entry_id);

COMMENT ON TABLE interchange_reversal IS
  'One row per interchange posting that has been unbooked or re-priced, by PRIMARY KEY so it is exactly-once. It is BOOKKEEPING, not evidence: v_interchange_unreversed reads it and can therefore be silenced by writing one, which is why v_interchange_drift reads the journal instead and does not join to this table at all.';


-- ---------------------------------------------------------------------
-- 14.  The lifecycle gate: the claims that would be catastrophic if
--      they were merely conventional
-- ---------------------------------------------------------------------
--
-- 0024 §13's instinct, applied to revenue. Four claims, each of which is
-- a sentence this feature makes out loud and which a future edit could
-- quietly stop being true:
--
--   (a) the interchange entry is dated the settlement's value date
--   (b) its two lines are a 2200/4100 pair for exactly this amount, on
--       the correct side for the direction
--   (c) the settled amount on the row is the customer's own leg on the
--       settlement entry it cites -- not a number someone passed in
--   (d) the rate is the one the card says applied on that value date
CREATE FUNCTION assert_interchange_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry      journal_entry%ROWTYPE;
  v_settlement journal_entry%ROWTYPE;
  v_policy     interchange_rate_policy%ROWTYPE;
  v_customer   bigint;
  v_payable    bigint;
  v_income     bigint;
  v_lines      int;
  v_natural    bigint;
BEGIN
  SELECT * INTO v_entry      FROM journal_entry WHERE id = NEW.entry_id;
  SELECT * INTO v_settlement FROM journal_entry WHERE id = NEW.settlement_entry_id;

  -- (a)
  IF v_entry.value_date <> NEW.value_date OR v_settlement.value_date <> NEW.value_date THEN
    RAISE EXCEPTION
      'interchange posting is dated %, its entry %, its settlement % -- revenue must carry the value date of the spend it came from',
      NEW.value_date, v_entry.value_date, v_settlement.value_date USING ERRCODE = '55006';
  END IF;

  IF v_entry.book <> 'financial' THEN
    RAISE EXCEPTION 'interchange is real revenue and belongs in the financial book, not %', v_entry.book
      USING ERRCODE = '55006';
  END IF;

  -- (c) the settled amount is the journal's, not the caller's.
  SELECT COALESCE(SUM(l.amount_cents), 0), count(*)
    INTO v_customer, v_lines
    FROM journal_line l
   WHERE l.entry_id = NEW.settlement_entry_id AND l.account_id = NEW.deposit_account_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION
      'settlement entry % has no line on deposit account % -- this posting is priced against a settlement that is not the customer''s',
      NEW.settlement_entry_id, NEW.deposit_account_id USING ERRCODE = '55006';
  END IF;

  IF v_customer <> NEW.settled_cents THEN
    RAISE EXCEPTION
      'settled_cents is % but settlement entry % moved % on the customer''s leg',
      NEW.settled_cents, NEW.settlement_entry_id, v_customer USING ERRCODE = '55006';
  END IF;

  -- (b) the shape of the entry, on the correct side.
  v_natural := interchange_natural_cents(NEW.settled_cents, NEW.rate_bps, NEW.fixed_cents);

  SELECT COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '2200'), 0),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '4100'), 0),
         count(*)
    INTO v_payable, v_income, v_lines
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.entry_id = NEW.entry_id;

  IF v_lines <> 2 OR v_payable <> v_natural OR v_income <> -v_natural THEN
    RAISE EXCEPTION
      'interchange entry % must be exactly two lines, 2200 % and 4100 %; it has % lines, 2200 % and 4100 %',
      NEW.entry_id, v_natural, -v_natural, v_lines, v_payable, v_income USING ERRCODE = '55006';
  END IF;

  -- (d) the rate is the card's, on this value date.
  SELECT * INTO v_policy
    FROM interchange_rate_at(NEW.category, NEW.presentment, NEW.value_date);

  IF v_policy.id IS NULL THEN
    RAISE EXCEPTION
      'no interchange rate card for (%, %) effective on or before %',
      NEW.category, NEW.presentment, NEW.value_date USING ERRCODE = '55006';
  END IF;

  IF v_policy.id <> NEW.policy_id
     OR v_policy.rate_bps <> NEW.rate_bps
     OR v_policy.fixed_cents <> NEW.fixed_cents THEN
    RAISE EXCEPTION
      'posting cites % (% bps + %c) but the card effective on % is % (% bps + %c)',
      NEW.policy_id, NEW.rate_bps, NEW.fixed_cents, NEW.value_date,
      v_policy.id, v_policy.rate_bps, v_policy.fixed_cents USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_interchange_posting() SET search_path = public, pg_temp;

CREATE TRIGGER interchange_posting_lifecycle
  BEFORE INSERT ON interchange_posting
  FOR EACH ROW EXECUTE FUNCTION assert_interchange_posting();


-- The reversal's own gate: the repair must land at the ORIGINAL's value
-- date and must actually be a reversal OF THE INTERCHANGE ENTRY. A
-- reversal row pointing at some other entry is precisely how
-- v_interchange_unreversed gets silenced while the revenue stands.
CREATE FUNCTION assert_interchange_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_posting  interchange_posting%ROWTYPE;
  v_reversal journal_entry%ROWTYPE;
  v_rebook   journal_entry%ROWTYPE;
BEGIN
  SELECT * INTO v_posting  FROM interchange_posting WHERE id = NEW.interchange_posting_id;
  SELECT * INTO v_reversal FROM journal_entry       WHERE id = NEW.reversal_entry_id;

  IF v_reversal.reverses_entry_id IS DISTINCT FROM v_posting.entry_id THEN
    RAISE EXCEPTION
      'reversal entry % does not reverse interchange entry % -- an unbooking row that points elsewhere silences the guard and leaves the revenue standing',
      NEW.reversal_entry_id, v_posting.entry_id USING ERRCODE = '55006';
  END IF;

  IF NEW.value_date <> v_posting.value_date OR v_reversal.value_date <> v_posting.value_date THEN
    RAISE EXCEPTION
      'interchange repair must carry the ORIGINAL value date %; got row % and entry %',
      v_posting.value_date, NEW.value_date, v_reversal.value_date USING ERRCODE = '55006';
  END IF;

  IF NEW.rebook_entry_id IS NOT NULL THEN
    SELECT * INTO v_rebook FROM journal_entry WHERE id = NEW.rebook_entry_id;
    IF v_rebook.value_date <> v_posting.value_date THEN
      RAISE EXCEPTION
        'interchange re-book must carry the ORIGINAL value date %; got %',
        v_posting.value_date, v_rebook.value_date USING ERRCODE = '55006';
    END IF;
    IF NEW.rebook_natural_cents
       <> interchange_natural_cents(NEW.net_settled_cents, v_posting.rate_bps, v_posting.fixed_cents) THEN
      RAISE EXCEPTION
        'a corrected settlement is re-priced AT THE POSTING''S OWN POLICY (% bps + %c): % nets to %, not %',
        v_posting.rate_bps, v_posting.fixed_cents, NEW.net_settled_cents,
        interchange_natural_cents(NEW.net_settled_cents, v_posting.rate_bps, v_posting.fixed_cents),
        NEW.rebook_natural_cents USING ERRCODE = '55006';
    END IF;
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_interchange_reversal() SET search_path = public, pg_temp;

CREATE TRIGGER interchange_reversal_lifecycle
  BEFORE INSERT ON interchange_reversal
  FOR EACH ROW EXECUTE FUNCTION assert_interchange_reversal();


-- ---------------------------------------------------------------------
-- 15.  The views, including the three that must always be empty
-- ---------------------------------------------------------------------

-- What one settlement's correction group NOW nets to on the customer's
-- own leg. This is the number the whole feature turns on: a clearing of
-- 7340 that was later reversed in full nets to 0, and zero settled spend
-- is worth zero interchange.
--
-- The group, not the entry: reverseAndRebook() puts the original, its
-- reversal and any re-book in one correction_group_id (ledger_append
-- defaults it to the entry's own id, so an uncorrected settlement is a
-- group of one). Reading the entry alone would report the original
-- figure for ever, which is exactly the overstatement this exists to
-- catch.
CREATE VIEW v_interchange_settlement_net AS
SELECT ip.id AS interchange_posting_id,
       se.correction_group_id,
       COALESCE(SUM(l.amount_cents), 0)::bigint AS net_customer_cents,
       count(DISTINCT g.id)::int                AS group_entries,
       -- The entry that reversed the SETTLEMENT, if one exists.
       -- journal_entry_one_reversal_idx makes it at most one, so the
       -- array is a single element or empty.
       (array_agg(g.id) FILTER (WHERE g.reverses_entry_id = ip.settlement_entry_id))[1]
                                                AS settlement_reversal_entry_id
  FROM interchange_posting ip
  JOIN journal_entry se ON se.id = ip.settlement_entry_id
  JOIN journal_entry g  ON g.correction_group_id = se.correction_group_id
                       AND g.book = 'financial'
  JOIN journal_line  l  ON l.entry_id = g.id AND l.account_id = ip.deposit_account_id
 GROUP BY ip.id, se.correction_group_id;

COMMENT ON VIEW v_interchange_settlement_net IS
  'What a priced settlement is now worth, after every correction booked against it, on the customer own leg. A settlement reversed in full nets to zero here.';


-- What the JOURNAL says we have booked in interchange for one posting,
-- in natural (credit-normal) terms: positive is revenue we are carrying.
-- Read across the interchange entry's whole correction group, so a
-- reversal and a re-book are both in the number.
CREATE VIEW v_interchange_booked AS
SELECT ip.id AS interchange_posting_id,
       ie.correction_group_id,
       COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS booked_natural_cents,
       count(DISTINCT g.id)::int                                AS group_entries,
       -- The entry that reversed the INTERCHANGE, if one exists. This is
       -- what "the repair happened" means in the journal, as opposed to
       -- what it means in interchange_reversal -- see §6 on why the two
       -- are not the same question and why only this one is trusted.
       (array_agg(g.id) FILTER (WHERE g.reverses_entry_id = ip.entry_id))[1]
                                                                AS journal_reversal_entry_id
  FROM interchange_posting ip
  JOIN journal_entry ie ON ie.id = ip.entry_id
  JOIN journal_entry g  ON g.correction_group_id = ie.correction_group_id
  JOIN journal_line  l  ON l.entry_id = g.id
  JOIN account       a  ON a.id = l.account_id AND a.code = '4100'
 GROUP BY ip.id, ie.correction_group_id;

COMMENT ON VIEW v_interchange_booked IS
  'The 4100 lines of one posting correction group, in natural terms. This is the journal answer, not the bookkeeping table answer -- which is the whole point of v_interchange_drift.';


-- =====================================================================
-- MUST BE EMPTY. THE TRAP, NAMED.
--
-- An interchange posting whose SETTLEMENT has been reversed and whose
-- own revenue has not been unbooked. If this returns a row, the ledger
-- is carrying income for spend that did not happen.
--
-- IT READS THE JOURNAL ON BOTH SIDES. Did something reverse the
-- settlement, and did something reverse the interchange booked on it --
-- both answered by `journal_entry.reverses_entry_id`, which is immutable
-- and unique per reversed entry. `interchange_reversal` is deliberately
-- NOT joined; see §6.
--
-- It does NOT check the AMOUNT of the repair. That is
-- v_interchange_drift's job, and the split is deliberate: this view
-- names the failure in one line a human can act on -- "revenue is
-- standing on a settlement the network took back" -- and the other
-- measures it.
--
-- IT CAN FAIL, and it was made to: reversing a real priced settlement
-- with the unbooking step skipped produced rows against this database
-- inside a transaction that was rolled back. See docs/INTERCHANGE.md §7.
-- =====================================================================
CREATE VIEW v_interchange_unreversed AS
SELECT ip.id                AS interchange_posting_id,
       ip.provider_event_id,
       ip.value_date,
       ip.business_id,
       ip.settlement_entry_id,
       ip.entry_id          AS interchange_entry_id,
       ip.direction,
       ip.interchange_cents,
       srev.id              AS settlement_reversal_entry_id,
       srev.booking_time    AS settlement_reversed_at
  FROM interchange_posting ip
  JOIN journal_entry srev ON srev.reverses_entry_id = ip.settlement_entry_id
  LEFT JOIN journal_entry irev ON irev.reverses_entry_id = ip.entry_id
 WHERE irev.id IS NULL;

COMMENT ON VIEW v_interchange_unreversed IS
  'MUST BE EMPTY. Revenue standing on a settlement the network took back: the settlement has a reversal and the interchange entry has none. Reads journal_entry on both sides, so no row in any audit table can silence it or falsely trip it.';


-- =====================================================================
-- MUST BE EMPTY. THE SAME QUESTION, ASKED OF THE JOURNAL.
--
-- It does not join to interchange_reversal at all. For every priced
-- settlement it asks three things of immutable rows only:
--
--   what does the settlement's correction group NOW net to?
--   what is that worth at the rate THIS POSTING was priced at?
--   what do the 4100 lines of the interchange group actually say?
--
-- and reports every disagreement. It catches:
--
--   * a reversed settlement whose interchange still stands   (the trap)
--   * interchange booked twice for one settlement
--   * a partially corrected settlement that was never re-priced
--   * a re-book priced at a rate the original was not priced at
--   * an interchange entry reversed when the settlement was not
--
-- and it cannot be quieted by any row in any table this migration
-- created, because it reads none of them except the posting's own stored
-- rate -- which the lifecycle trigger already pinned to the rate card.
--
-- IT CAN FAIL, and it was made to, twice: once by suppressing the
-- unbooking of a reversed settlement (drift = the full interchange), and
-- once by re-pricing a partial correction at today's card instead of the
-- original's (drift = the rate difference). Both against this database,
-- both rolled back. See docs/INTERCHANGE.md §7.
-- =====================================================================
CREATE VIEW v_interchange_drift AS
SELECT ip.id                    AS interchange_posting_id,
       ip.provider_event_id,
       ip.value_date,
       ip.business_id,
       ip.category,
       ip.presentment,
       ip.rate_bps,
       ip.fixed_cents,
       ip.settled_cents         AS originally_settled_cents,
       COALESCE(n.net_customer_cents, 0) AS net_settled_cents,
       COALESCE(n.group_entries, 0)      AS settlement_group_entries,
       COALESCE(b.booked_natural_cents, 0) AS booked_natural_cents,
       interchange_natural_cents(COALESCE(n.net_customer_cents, 0), ip.rate_bps, ip.fixed_cents)
                                AS expected_natural_cents,
       COALESCE(b.booked_natural_cents, 0)
         - interchange_natural_cents(COALESCE(n.net_customer_cents, 0), ip.rate_bps, ip.fixed_cents)
                                AS drift_cents
  FROM interchange_posting ip
  -- LEFT, not INNER, and that is the difference between a guard and a
  -- comment. An INNER JOIN drops any posting whose settlement or whose
  -- own entry cannot be found in the journal at all -- which is one of
  -- the states this view exists to report, so excluding it would make
  -- the exclusion shaped exactly like the failure. With LEFT, a missing
  -- side reads as zero and the disagreement surfaces.
  LEFT JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
  LEFT JOIN v_interchange_booked         b ON b.interchange_posting_id = ip.id
 WHERE COALESCE(b.booked_natural_cents, 0)
       IS DISTINCT FROM interchange_natural_cents(
                          COALESCE(n.net_customer_cents, 0), ip.rate_bps, ip.fixed_cents);

COMMENT ON VIEW v_interchange_drift IS
  'MUST BE EMPTY. For every priced settlement: what its correction group now nets to, what that is worth at the rate it was priced at, and what the 4100 lines actually say. Reads only immutable journal rows and the postings stored rate, so no bookkeeping row can silence it.';


-- =====================================================================
-- MUST BE EMPTY. A SETTLEMENT PRICED BY A RATE THAT CAME LATER.
--
-- "A changed rate must not retroactively re-price a settlement from last
-- week", asked of the whole book at any moment. The forward-only trigger
-- on interchange_rate_policy makes the offending INSERT impossible; this
-- view is what would catch it if that trigger were dropped.
--
-- IT CAN FAIL: disabling the trigger and inserting a backdated rate row
-- makes every posting on or after that date appear here. Done against
-- this database, rolled back. See docs/INTERCHANGE.md §7.
-- =====================================================================
CREATE VIEW v_interchange_rate_drift AS
SELECT ip.id AS interchange_posting_id,
       ip.provider_event_id,
       ip.value_date,
       ip.category,
       ip.presentment,
       ip.policy_id       AS posted_policy_id,
       p.id               AS resolved_policy_id,
       p.effective_from   AS resolved_effective_from,
       ip.rate_bps        AS posted_rate_bps,
       p.rate_bps         AS resolved_rate_bps,
       ip.fixed_cents     AS posted_fixed_cents,
       p.fixed_cents      AS resolved_fixed_cents
  FROM interchange_posting ip
  LEFT JOIN LATERAL (
    SELECT * FROM interchange_rate_at(ip.category, ip.presentment, ip.value_date)
  ) p ON true
 WHERE p.id IS NULL
    OR ip.policy_id   <> p.id
    OR ip.rate_bps    <> p.rate_bps
    OR ip.fixed_cents <> p.fixed_cents;

COMMENT ON VIEW v_interchange_rate_drift IS
  'MUST BE EMPTY. Every posting must still resolve to the rate card row effective on its OWN value date. A row here means a rate was backdated and settlements already on the ledger have been re-priced underneath.';


-- EVERY CARD SETTLEMENT ON THE BOOK, with the context needed to price it.
--
-- One definition of "what is a settlement", used by the live booking hook,
-- by the backfill and by the screen -- so those three cannot disagree about
-- which entries are in scope. The alternative was the same four joins
-- written out in TypeScript, which would also have put `FROM journal_entry`
-- into a module outside src/lib/ledger and made `ledger/boundary.test.ts`
-- fail: that test is a ratchet, a file not on its list may have NO
-- references, and the right answer to "my module needs a ledger question
-- answered" is a named reader or a view, never a fifth private copy of the
-- join.
--
-- WHAT IS IN SCOPE: original financial entries whose idempotency key is
-- `card:clearing:`, `card:force_post:` or `card:refund:` -- the three kinds
-- movesFinancialBook() admits. Deliberately NOT `card:correction:` (that is
-- a re-book of a settlement already in scope, and pricing it separately
-- would double-count) and not `reversal:` (not an original).
--
-- `provider_record_present` says whether the provider's own transaction
-- record can be found. It is not the whole priceability test -- that is
-- isPriceable() in src/lib/interchange/dimensions.ts, which asks whether the
-- payload actually carries a merchant or a pos block -- because the decision
-- belongs in one place and that place reads the same JSON the live webhook
-- path reads.
CREATE VIEW v_interchange_candidate AS
SELECT e.id                                                       AS settlement_entry_id,
       e.value_date,
       e.entity_id,
       e.external_ref                                             AS provider_auth_id,
       -- The provider's own event token, recovered from the key
       -- postCardMovement() chose. A regexp and not split_part(':', 3):
       -- split_part truncates at the next colon, and an id containing one
       -- would silently become a different id -- which is the kind of
       -- almost-right key that produces a second interchange entry.
       regexp_replace(e.idempotency_key, '^card:[a-z_]+:', '')     AS provider_event_id,
       regexp_replace(e.idempotency_key, '^card:([a-z_]+):.*$', '\1') AS kind,
       -- The customer own leg, SIGNED: positive is a debit, i.e. a purchase.
       l.amount_cents                                             AS settled_cents,
       a.id                                                       AS deposit_account_id,
       a.business_id,
       ca.id                                                      AS auth_id,
       ca.card_id,
       ca.provider,
       w.payload,
       (w.payload IS NOT NULL)                                    AS provider_record_present,
       ip.id                                                      AS interchange_posting_id,
       rev.id                                                     AS settlement_reversal_entry_id
  FROM journal_entry e
  JOIN journal_line  l  ON l.entry_id = e.id
  JOIN account       a  ON a.id = l.account_id
                       AND a.code = '2100' AND a.business_id IS NOT NULL
  -- 'lithic' is named rather than derived, and that is a real limitation
  -- worth stating: journal_entry records the RAIL ('card') and the
  -- provider's reference, not which provider issued it, and
  -- card_authorization is unique on (provider, provider_auth_id). With one
  -- card issuer on this book the join is exact; a second would need the
  -- provider on the entry, which is a change to the rail adapter and not
  -- to this file. Named in docs/INTERCHANGE.md.
  JOIN card_authorization ca ON ca.provider = 'lithic'
                            AND ca.provider_auth_id = e.external_ref
  LEFT JOIN LATERAL (
    SELECT wi.payload FROM webhook_inbox wi
     WHERE wi.provider = 'lithic' AND wi.payload->>'token' = e.external_ref
     ORDER BY wi.received_at DESC LIMIT 1
  ) w ON true
  LEFT JOIN interchange_posting ip  ON ip.settlement_entry_id = e.id
  LEFT JOIN journal_entry       rev ON rev.reverses_entry_id = e.id
 WHERE e.book = 'financial'
   AND e.entry_type = 'original'
   AND (e.idempotency_key LIKE 'card:clearing:%'
     OR e.idempotency_key LIKE 'card:force\_post:%'
     OR e.idempotency_key LIKE 'card:refund:%');

COMMENT ON VIEW v_interchange_candidate IS
  'Every card settlement on the book with the context needed to price it: the customer signed leg, the customer and card it belongs to, the providers own transaction record, and whether it has already been priced or already been reversed. One definition, shared by the live hook, the backfill and the screen.';


-- A REPORTING VIEW, NOT AN INVARIANT. It is expected to be non-empty and
-- saying so is the point: settled card movements that carry no
-- interchange, with the reason.
--
-- The line this draws is the brief's own rule enforced at the posting
-- boundary rather than only at design time: WE PRICE WHAT THE PROVIDER
-- TOLD US. A settlement with no provider transaction record has no
-- merchant and no entry mode to read, and inventing them to make a
-- number appear is precisely what "do not invent a dimension you cannot
-- populate from a real event" forbids. On this book those are the
-- synthetic authorisations integration tests built by hand
-- ('auth-1789059056109-2'), and they are listed here rather than
-- silently skipped -- the same park-never-guess discipline
-- resolveCard() and resolveEventSemanticsBatch() already use.
CREATE VIEW v_interchange_unpriced AS
SELECT e.id                                   AS settlement_entry_id,
       e.idempotency_key,
       split_part(e.idempotency_key, ':', 2)  AS kind,
       e.value_date,
       e.external_ref                         AS provider_auth_id,
       a.business_id,
       l.amount_cents                         AS customer_cents,
       (w.id IS NOT NULL)                     AS provider_record_present,
       CASE
         WHEN w.id IS NULL THEN
           'no provider transaction record: there is no merchant and no entry mode to read, and a dimension that cannot be populated from a real event is not invented'
         ELSE
           'the provider record exists but this settlement carries no interchange: either it has not been priced yet, or it prices to zero at its band rate (a small enough ticket on a band with no fixed component rounds to nothing)'
       END                                    AS reason
  FROM journal_entry e
  JOIN journal_line  l ON l.entry_id = e.id
  JOIN account       a ON a.id = l.account_id
                      AND a.code = '2100' AND a.business_id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT wi.id FROM webhook_inbox wi
     WHERE wi.provider = 'lithic' AND wi.payload->>'token' = e.external_ref
     LIMIT 1
  ) w ON true
 WHERE e.book = 'financial'
   AND e.entry_type = 'original'
   AND (e.idempotency_key LIKE 'card:clearing:%'
     OR e.idempotency_key LIKE 'card:force\_post:%'
     OR e.idempotency_key LIKE 'card:refund:%')
   AND NOT EXISTS (
         SELECT 1 FROM interchange_posting ip WHERE ip.settlement_entry_id = e.id);

COMMENT ON VIEW v_interchange_unpriced IS
  'NOT an invariant -- expected to be non-empty. Settled card movements carrying no interchange, with the reason. Synthetic test authorisations have no provider record and are deliberately never priced.';


-- The rate card as a screen reads it: every version with the window it
-- was in force for, and how many settlements each priced.
CREATE VIEW v_interchange_rate_card AS
SELECT p.id,
       p.category,
       c.description AS category_description,
       c.is_default  AS category_is_default,
       p.presentment,
       p.effective_from,
       LEAD(p.effective_from) OVER (
         PARTITION BY p.category, p.presentment ORDER BY p.effective_from)
                     AS superseded_on,
       p.rate_bps,
       p.fixed_cents,
       p.note,
       p.created_at,
       (SELECT count(*) FROM interchange_posting ip WHERE ip.policy_id = p.id)
                     AS settlements_priced,
       (SELECT count(*) FROM interchange_mcc m WHERE m.category = p.category)
                     AS mccs_mapped
  FROM interchange_rate_policy p
  JOIN interchange_category c ON c.category = p.category;


-- Interchange by band and presentment: the view that answers "is the
-- rate card doing anything, or is it one number wearing six hats".
-- Net of reversals, because gross revenue on reversed spend is the
-- number this whole feature exists not to report.
CREATE VIEW v_interchange_by_category AS
SELECT ip.category,
       ip.presentment,
       count(*)::int                                AS settlements,
       SUM(abs(ip.settled_cents))::bigint           AS gross_settled_cents,
       SUM(COALESCE(n.net_customer_cents, 0))::bigint   AS net_settled_cents,
       SUM(COALESCE(b.booked_natural_cents, 0))::bigint AS interchange_cents,
       SUM(ip.ad_valorem_cents)::bigint             AS gross_ad_valorem_cents,
       SUM(ip.fixed_cents)::bigint                  AS gross_fixed_cents,
       count(*) FILTER (WHERE ip.rounding = 'tie_to_even')::int AS half_cent_ties,
       SUM(ip.remainder_units)::bigint              AS remainder_units_dropped
  FROM interchange_posting ip
  LEFT JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
  LEFT JOIN v_interchange_booked         b ON b.interchange_posting_id = ip.id
 GROUP BY ip.category, ip.presentment;

COMMENT ON VIEW v_interchange_by_category IS
  'Interchange NET OF REVERSALS by band and presentment, with the sub-cent fractions dropped and the number of exact half-cent ties DESIGN §12.2 broke to the even cent.';


-- Every priced settlement, with its working, for the drill-through.
CREATE VIEW v_interchange_settlement AS
SELECT ip.id,
       ip.value_date,
       ip.provider_event_id,
       ip.business_id,
       biz.legal_name           AS business_name,
       ip.mcc,
       ip.category,
       ip.presentment,
       ip.entry_mode,
       ip.terminal_type,
       ip.network,
       ip.descriptor,
       ip.direction,
       ip.settled_cents,
       COALESCE(n.net_customer_cents, 0) AS net_settled_cents,
       ip.rate_bps,
       ip.fixed_cents,
       ip.numerator,
       ip.denominator,
       ip.whole_cents,
       ip.remainder_units,
       ip.rounding,
       ip.ad_valorem_cents,
       ip.interchange_cents,
       COALESCE(b.booked_natural_cents, 0) AS booked_natural_cents,
       ip.settlement_entry_id,
       ip.entry_id,
       ir.reversal_entry_id,
       ir.rebook_entry_id,
       ir.rebook_natural_cents,
       ir.reason                AS reversal_reason,
       ip.policy_id,
       pol.effective_from       AS rate_effective_from
  FROM interchange_posting ip
  JOIN business biz ON biz.id = ip.business_id
  JOIN interchange_rate_policy pol ON pol.id = ip.policy_id
  LEFT JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
  LEFT JOIN v_interchange_booked         b ON b.interchange_posting_id = ip.id
  LEFT JOIN interchange_reversal        ir ON ir.interchange_posting_id = ip.id;


-- ---------------------------------------------------------------------
-- 16.  The unit economics
-- ---------------------------------------------------------------------
--
-- THE QUESTION: is this programme profitable, per customer, FROM
-- POSTINGS rather than from a spreadsheet.
--
-- The house's income and expense accounts carry no business_id -- they
-- are house lines, one 4200 for everybody. So attribution is by the
-- ENTRY: a house P&L line belongs to the customer whose own deposit leaf
-- the SAME ENTRY moved. That is exactly right for the platform fee and
-- for both sides of interest, all of which debit or credit the customer
-- in the same entry.
--
-- INTERCHANGE IS THE EXCEPTION AND IT IS WORTH BEING PRECISE ABOUT IT.
-- The interchange entry is 2200/4100 and never touches the customer's
-- leaf -- it cannot, because interchange is money between us and the
-- network and none of it is the customer's. So its attribution comes
-- from interchange_posting.business_id, which the lifecycle trigger tied
-- to the settlement entry it prices. The AMOUNT still comes from the
-- journal, through v_interchange_booked: the posting row says WHOSE, the
-- journal says HOW MUCH, and v_interchange_drift holds the two equal.
CREATE VIEW v_business_pnl AS
-- The house lines of entries that moved this customer's own money.
SELECT touched.business_id,
       a.code,
       a.name,
       a.type::text                             AS account_type,
       SUM(l.amount_cents * a.normal_side)::bigint AS natural_cents
  -- DISTINCT (entry, business), so an entry carrying two lines on the
  -- same deposit leaf attributes the house line once rather than twice.
  -- An entry touching TWO businesses' leaves -- a direct customer-to-
  -- customer transfer -- would attribute its house lines to both, which
  -- is a real ambiguity rather than a bug: there is no fact on the entry
  -- that says whose fee it was. No such entry exists on this book today
  -- (internal transfers are pot moves, which stay inside one business),
  -- and it is named in docs/INTERCHANGE.md rather than silently halved.
  FROM (SELECT DISTINCT dl.entry_id, dep.business_id
          FROM journal_line dl
          JOIN account dep ON dep.id = dl.account_id
         WHERE dep.code = '2100' AND dep.business_id IS NOT NULL) touched
  JOIN journal_line l ON l.entry_id = touched.entry_id
  JOIN account      a ON a.id = l.account_id
 WHERE a.business_id IS NULL
   AND a.type IN ('income', 'expense')
 GROUP BY touched.business_id, a.code, a.name, a.type
UNION ALL
-- Interchange, attributed by the posting and measured by the journal.
SELECT ip.business_id,
       '4100',
       'Interchange income',
       'income',
       SUM(b.booked_natural_cents)::bigint
  FROM interchange_posting ip
  LEFT JOIN v_interchange_booked b ON b.interchange_posting_id = ip.id
 GROUP BY ip.business_id;

COMMENT ON VIEW v_business_pnl IS
  'Every house income and expense line attributable to one customer: by shared entry for fees and interest, and by interchange_posting.business_id for interchange, whose entry never touches the customer leaf because none of that money is theirs.';


-- The screen's row. One per business that has ever had a deposit leaf.
CREATE VIEW v_unit_economics AS
WITH pnl AS (
  SELECT business_id, code, SUM(natural_cents)::bigint AS cents
    FROM v_business_pnl GROUP BY business_id, code
),
cardvol AS (
  SELECT ip.business_id,
         count(*)::int                       AS priced_settlements,
         SUM(COALESCE(n.net_customer_cents, 0))::bigint AS net_settled_cents,
         SUM(abs(ip.settled_cents))::bigint   AS gross_settled_cents,
         count(*) FILTER (WHERE ir.interchange_posting_id IS NOT NULL)::int
                                              AS reversed_settlements
    FROM interchange_posting ip
    LEFT JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
    LEFT JOIN interchange_reversal        ir ON ir.interchange_posting_id = ip.id
   GROUP BY ip.business_id
)
SELECT b.id                                                   AS business_id,
       b.legal_name,
       COALESCE(cardvol.priced_settlements, 0)                AS priced_settlements,
       COALESCE(cardvol.reversed_settlements, 0)              AS reversed_settlements,
       COALESCE(cardvol.gross_settled_cents, 0)::bigint       AS gross_settled_cents,
       COALESCE(cardvol.net_settled_cents, 0)::bigint         AS net_settled_cents,
       COALESCE((SELECT cents FROM pnl WHERE pnl.business_id = b.id AND pnl.code = '4100'), 0)::bigint
                                                              AS interchange_cents,
       COALESCE((SELECT cents FROM pnl WHERE pnl.business_id = b.id AND pnl.code = '4200'), 0)::bigint
                                                              AS fee_income_cents,
       COALESCE((SELECT cents FROM pnl WHERE pnl.business_id = b.id AND pnl.code = '4400'), 0)::bigint
                                                              AS interest_income_cents,
       -- 4300 is a SIGNED variance account, not a fee: the difference between
       -- the rate a customer accepted and what the payout actually cost us. It
       -- is income-typed and it belongs in the contribution, but netting it
       -- into fee income would make a spread look like a price -- which 4300's
       -- own note in chart.ts forbids. Its own column, so the screen can show
       -- it and a reviewer can see it is not zero by accident.
       COALESCE((SELECT cents FROM pnl WHERE pnl.business_id = b.id AND pnl.code = '4300'), 0)::bigint
                                                              AS fx_variance_cents,
       COALESCE((SELECT cents FROM pnl WHERE pnl.business_id = b.id AND pnl.code = '5400'), 0)::bigint
                                                              AS interest_expense_cents,
       COALESCE((SELECT SUM(cents) FROM pnl
                  WHERE pnl.business_id = b.id
                    AND pnl.code IN ('5100', '5200', '5300', '5900')), 0)::bigint
                                                              AS other_expense_cents,
       COALESCE((SELECT SUM(cents) FROM pnl
                  WHERE pnl.business_id = b.id AND pnl.code LIKE '4%'), 0)::bigint
       - COALESCE((SELECT SUM(cents) FROM pnl
                    WHERE pnl.business_id = b.id AND pnl.code LIKE '5%'), 0)::bigint
                                                              AS net_contribution_cents
  FROM business b
  LEFT JOIN cardvol ON cardvol.business_id = b.id
 WHERE EXISTS (SELECT 1 FROM account a
                WHERE a.code = '2100' AND a.business_id = b.id);

COMMENT ON VIEW v_unit_economics IS
  'Is this programme profitable, per customer, from postings. Income less expense, with interchange as the revenue line and interest expense as the cost of the deposits that funded it. Every figure is a sum of immutable journal lines.';


-- ---------------------------------------------------------------------
-- 17.  Append-only, in two layers
-- ---------------------------------------------------------------------
--
-- No journal line is written by anything in this file -- postEntry()
-- does that -- so these are not money tables. They are the AUDIT of
-- money movement plus the policy it was priced by, and an audit trail
-- you can UPDATE is a story. 0012 §12, 0020 §14 and 0024 §17's
-- treatment, unchanged.
--
-- interchange_rate_policy is in the list for the reason §5 is about: a
-- rate you can edit in place is a rate that can re-price the past.
-- interchange_mcc is in it for the same reason one step removed: an MCC
-- you can re-class in place moves a settlement between bands after it
-- has been priced.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['interchange_category', 'interchange_mcc',
                           'interchange_rate_policy', 'interchange_posting',
                           'interchange_reversal'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_no_update_delete BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON
  interchange_category, interchange_mcc, interchange_rate_policy,
  interchange_posting, interchange_reversal
TO corgi_app;

-- Explicit and redundant, so a reviewer can grep for it -- 0001's words.
REVOKE UPDATE, DELETE, TRUNCATE ON
  interchange_category, interchange_mcc, interchange_rate_policy,
  interchange_posting, interchange_reversal
FROM corgi_app;

GRANT SELECT ON
  v_interchange_candidate,
  v_interchange_settlement_net, v_interchange_booked, v_interchange_unreversed,
  v_interchange_drift, v_interchange_rate_drift, v_interchange_unpriced,
  v_interchange_rate_card, v_interchange_by_category, v_interchange_settlement,
  v_business_pnl, v_unit_economics
TO corgi_app;

GRANT EXECUTE ON FUNCTION
  interchange_ad_valorem_cents(bigint, int),
  interchange_cents(bigint, int, bigint),
  interchange_natural_cents(bigint, int, bigint),
  interchange_direction_of(bigint),
  interchange_category_of(text),
  interchange_rate_at(text, interchange_presentment, date)
TO corgi_app;


-- ---------------------------------------------------------------------
-- 18.  The bands, the map, and the rate card
-- ---------------------------------------------------------------------
--
-- The numbers below are shaped on real published US Visa interchange:
-- supermarkets and fuel are cheap because the merchant lobbies are
-- large and the baskets are predictable, restaurants and travel are
-- expensive because the chargeback rates are, and card-not-present is
-- always dearer than card-present because the fraud is. They are not
-- Visa's actual schedule -- publishing a claim to be that would be a
-- claim not proven by a real call -- they are a plausible ISSUER rate
-- card with the right SHAPE, which is what the ledger needs in order to
-- be exercised honestly.

INSERT INTO interchange_category (category, description, is_default) VALUES
  ('standard',    'Everything not named by another band. THE DEFAULT: an MCC this map has no opinion about prices here, and interchange_category_of() falls through to it by reading is_default rather than by a constant written twice.', true),
  ('supermarket', 'Grocery and warehouse clubs. Cheap: high volume, low ticket, near-zero fraud, and the largest merchant lobby in the country.', false),
  ('fuel',        'Service stations and automated fuel dispensers. Cheap per dollar and the band the brief''s own fuel-pump scenario lands in -- 5542 is 341 of the payloads on this book.', false),
  ('restaurant',  'Eating places, fast food and drinking places. Dearer: tips make the settled amount differ from the authorised one routinely, which is the asymmetry this whole track is about.', false),
  ('travel',      'Airlines, lodging, car hire, transport. The dearest band: large tickets, long delivery lags and the highest chargeback rate on the network.', false),
  ('charity',     'Registered charitable and social service organisations. Priced at cost with no fixed component, because charging a fixed fee on a $5 donation is 2% of the gift.', false)
ON CONFLICT (category) DO NOTHING;

INSERT INTO interchange_mcc (mcc, category, note) VALUES
  ('5411', 'supermarket', 'Grocery stores, supermarkets'),
  ('5422', 'supermarket', 'Freezer and locker meat provisioners'),
  ('5441', 'supermarket', 'Candy, nut and confectionery stores'),
  ('5451', 'supermarket', 'Dairy products stores'),
  ('5462', 'supermarket', 'Bakeries'),
  ('5499', 'supermarket', 'Miscellaneous food stores, convenience stores'),
  ('5541', 'fuel',        'Service stations with or without ancillary services'),
  ('5542', 'fuel',        'Automated fuel dispensers -- the pump that authorises $50 and captures $73.40'),
  ('5983', 'fuel',        'Fuel dealers: coal, fuel oil, liquefied petroleum, wood'),
  ('5812', 'restaurant',  'Eating places and restaurants'),
  ('5813', 'restaurant',  'Drinking places: bars, taverns, lounges'),
  ('5814', 'restaurant',  'Fast food restaurants'),
  ('3000', 'travel',      'Airlines (the 3000-3299 airline block, represented by its head)'),
  ('4111', 'travel',      'Local and suburban commuter passenger transportation'),
  ('4112', 'travel',      'Passenger railways'),
  ('4121', 'travel',      'Taxicabs and limousines'),
  ('4131', 'travel',      'Bus lines'),
  ('4511', 'travel',      'Airlines and air carriers, not elsewhere classified'),
  ('4582', 'travel',      'Airports, flying fields, airport terminals'),
  ('4722', 'travel',      'Travel agencies and tour operators'),
  ('4789', 'travel',      'Transportation services, not elsewhere classified'),
  ('7011', 'travel',      'Lodging: hotels, motels, resorts'),
  ('7512', 'travel',      'Automobile rental agency'),
  ('8398', 'charity',     'Charitable and social service organisations')
ON CONFLICT (mcc) DO NOTHING;


-- TWO RATE CARD VERSIONS, seeded in ascending order so the forward-only
-- trigger accepts both, because ONE version cannot demonstrate the thing
-- §5 is about. With two, the same MCC on two adjacent business dates is
-- priced by two different rows, and re-running the earlier date still
-- resolves the earlier row.
--
--   v1   book_date - 30   the opening card, all six bands
--   v2   book_date        FUEL ONLY: 130 -> 145 bps
--
-- THE SECOND VERSION MOVES ONE BAND AND NOT ALL OF THEM, which is what a
-- real interchange re-rate looks like -- the networks publish them per
-- product, not across the board. It is also the band that matters here:
-- 5542 is by a wide margin the most common MCC on this book, so the
-- change is visible on real settlements on both sides of the boundary
-- rather than on a manufactured pair.
--
-- Dates are relative to the book day rather than hard-coded, so the same
-- shape appears whenever this migration is applied, including after a
-- db:reset. Idempotent by NOT EXISTS rather than ON CONFLICT, so the
-- forward-only trigger never fires on a re-run at all.
--
-- THE 'unknown' PRESENTMENT CARRIES THE CARD-PRESENT NUMBERS, and that
-- is the policy from §8 expressed as data rather than as a branch in
-- code: card-present is the LOWER rate, so a settlement whose
-- presentment we cannot substantiate books the smaller number.

INSERT INTO interchange_rate_policy
  (category, presentment, effective_from, rate_bps, fixed_cents, note, created_by)
SELECT v.category, v.presentment::interchange_presentment, book_date(now()) - 30,
       v.rate_bps, v.fixed_cents, v.note, act.id
  FROM actor act
  CROSS JOIN (VALUES
    ('standard',    'card_present',     165::int,  10::bigint, 'Opening card. 1.65% + $0.10 on card-present retail and services.'),
    ('standard',    'card_not_present', 190,       10,         'Opening card. 1.90% + $0.10 card-not-present: the fraud premium, which is the single largest driver of real interchange after merchant category.'),
    ('standard',    'unknown',          165,       10,         'Opening card. An unproven presentment books the CARD-PRESENT rate, because that is the lower of the two and revenue we cannot substantiate is revenue we do not claim.'),
    ('supermarket', 'card_present',     115,        5,         'Opening card. 1.15% + $0.05: high volume, low ticket, near-zero fraud.'),
    ('supermarket', 'card_not_present', 145,        5,         'Opening card. Grocery delivery and click-and-collect carry the card-not-present premium like anything else.'),
    ('supermarket', 'unknown',          115,        5,         'Opening card. Unproven presentment books the lower card-present rate.'),
    ('fuel',        'card_present',     130,        5,         'Opening card. 1.30% + $0.05 at the pump.'),
    ('fuel',        'card_not_present', 155,        5,         'Opening card. Keyed and in-app fuel purchases.'),
    ('fuel',        'unknown',          130,        5,         'Opening card. Unproven presentment books the lower card-present rate.'),
    ('restaurant',  'card_present',     175,       10,         'Opening card. 1.75% + $0.10: tips make the settled amount differ from the authorised one routinely.'),
    ('restaurant',  'card_not_present', 195,       10,         'Opening card. Delivery and phone orders.'),
    ('restaurant',  'unknown',          175,       10,         'Opening card. Unproven presentment books the lower card-present rate.'),
    ('travel',      'card_present',     185,       10,         'Opening card. 1.85% + $0.10: large tickets and long delivery lags.'),
    ('travel',      'card_not_present', 200,       10,         'Opening card. 2.00% + $0.10 -- nearly all travel is card-not-present and nearly all of it is booked months before it is delivered.'),
    ('travel',      'unknown',          185,       10,         'Opening card. Unproven presentment books the lower card-present rate.'),
    ('charity',     'card_present',     100,        0,         'Opening card. 1.00% and no fixed component: a fixed fee on a $5 donation is 2% of the gift.'),
    ('charity',     'card_not_present', 100,        0,         'Opening card. Charities are priced the same either way; almost all giving is card-not-present and pricing it dearer would be a tax on the channel.'),
    ('charity',     'unknown',          100,        0,         'Opening card. Same rate, so the presentment does not matter here -- and the row exists anyway, because a rate card with a hole in it is a rate card that throws at the posting.')
  ) AS v(category, presentment, rate_bps, fixed_cents, note)
 WHERE act.kind = 'system' AND act.display_name = 'ledger-poster'
   AND NOT EXISTS (
         SELECT 1 FROM interchange_rate_policy p
          WHERE p.category = v.category
            AND p.presentment = v.presentment::interchange_presentment
            AND p.effective_from = book_date(now()) - 30);

INSERT INTO interchange_rate_policy
  (category, presentment, effective_from, rate_bps, fixed_cents, note, created_by)
SELECT v.category, v.presentment::interchange_presentment, book_date(now()),
       v.rate_bps, v.fixed_cents, v.note, act.id
  FROM actor act
  CROSS JOIN (VALUES
    ('fuel', 'card_present',     145::int, 5::bigint, 'Fuel re-rate: 1.30% -> 1.45% at the pump, effective today. Settlements before today keep the 1.30% card -- interchange_rate_at() resolves on the SETTLEMENT value date, and interchange_rate_policy_forward_only would have refused this row if any settlement on or after it had already been priced.'),
    ('fuel', 'card_not_present', 170,      5,         'Fuel re-rate, card-not-present leg: 1.55% -> 1.70%.'),
    ('fuel', 'unknown',          145,      5,         'Fuel re-rate, unproven presentment: tracks the card-present leg, as it does on every band.')
  ) AS v(category, presentment, rate_bps, fixed_cents, note)
 WHERE act.kind = 'system' AND act.display_name = 'ledger-poster'
   AND NOT EXISTS (
         SELECT 1 FROM interchange_rate_policy p
          WHERE p.category = v.category
            AND p.presentment = v.presentment::interchange_presentment
            AND p.effective_from = book_date(now()));
