-- =====================================================================
-- 0017  The FX quote, and the commitment an acceptance creates
-- =====================================================================
--
-- Stretch-ladder item one, verbatim:
--
--   "The cross-border USDC payout with an FX quote the customer accepts
--    first."
--
-- ---------------------------------------------------------------------
-- THE FIRST THING TO SAY: THIS IS NOT A MULTI-CURRENCY LEDGER
-- ---------------------------------------------------------------------
--
-- The brief says "the ledger is USD, in cents, even when the rail is a
-- stablecoin", and the rules say multi-currency is explicitly out of
-- scope. Nothing in this migration touches `journal_line`, adds a
-- currency to it, or opens an account in anything but USD. Not one row
-- below is a money row in the general-ledger sense.
--
-- What a quote IS, precisely: a CUSTOMER-FACING COMMITMENT about a
-- payout that has not happened yet. We tell a customer "send us
-- $1,000.00 and your supplier in Guadalajara receives 16,799.77 MXN",
-- they accept, and from that moment the MXN figure is fixed. The
-- general ledger stays in USD cents throughout — the only place a
-- non-USD number appears in this database is `fx_quote.buy_minor`, and
-- it is a PROMISE, not a balance. It is never summed with anything, it
-- never nets to zero against anything, and no view adds it to a dollar.
--
-- ---------------------------------------------------------------------
-- THE FOUR FACTS THIS SCHEMA IS BUILT OUT OF
-- ---------------------------------------------------------------------
--
--   1. A QUOTE IS AN OFFER WITH AN EXPIRY. `fx_quote` is the offer.
--      `expires_at` is part of the offer, not a policy the application
--      applies afterwards.
--
--   2. ACCEPTANCE IS A ROW, NOT AN EDIT. There is no `status` column on
--      `fx_quote` and no UPDATE anywhere. `fx_quote_acceptance` has the
--      quote id as its PRIMARY KEY, exactly like `hold_closure` and
--      `payee_archival`: acceptance can happen once, it cannot happen
--      twice, and it cannot be undone, because there is no UPDATE and
--      no DELETE. An expired quote stays on file forever.
--
--   3. THE EXPIRY IS ENFORCED BY THE DATABASE, NOT BY THE CALLER.
--      `fx_quote_acceptance_guard()` refuses an acceptance whose
--      `now()` is past the quote's own `expires_at`. If the application
--      forgets to check, the row still does not go in. That trigger is
--      the entire feature in six lines, and the screen's EDGE state
--      exists to show it firing.
--
--   4. THE ARITHMETIC IS A DATABASE EXPRESSION. `fee_cents`,
--      `customer_rate_scaled` and `buy_minor` are GENERATED columns.
--      A caller cannot store a commitment that does not follow from the
--      rate it claims — the number the customer is shown and the number
--      the database holds are the same computation, not two of them.
--      See section 2 for why the functions exist rather than inline SQL.
--
-- ---------------------------------------------------------------------
-- RATES ARE INTEGERS, SCALED, AND THE SCALE IS STORED WITH THEM
-- ---------------------------------------------------------------------
--
-- There is no float anywhere in this file. A rate is a `bigint` scaled
-- by `rate_scale`, which is stored ON THE ROW rather than assumed as a
-- global constant. That costs 8 bytes per quote and buys the thing a
-- constant cannot: if the scale is ever widened, every historical quote
-- still reads back as the number it actually was, instead of silently
-- becoming 100x itself. The application's scale is 10^8
-- (`RATE_SCALE` in src/lib/fx/types.ts); the database will hold any
-- power of ten and will not reinterpret one row with another's scale.
--
-- `numeric` appears inside the four IMMUTABLE functions, and only
-- there. It is Postgres's EXACT decimal type, not a float — it is used
-- as a wide integer accumulator so an intermediate product cannot
-- overflow `bigint`, and every function floors or ceilings back to
-- `bigint` before it returns. `double precision` appears nowhere.
--
-- ---------------------------------------------------------------------
-- WHERE THE MONEY ACTUALLY POSTS, AND THE ACCOUNT THAT IS MISSING
-- ---------------------------------------------------------------------
--
-- Nothing in this migration posts to the journal, and that is correct:
-- an offer is not a transaction and an acceptance is not a transfer.
-- The posting happens at SETTLEMENT, and it is `postUsdcPayout()` in
-- src/lib/rails/stablecoin/ledger.ts, which this migration does not
-- touch.
--
-- But settlement under an accepted quote has one leg that path does not
-- have today, and it has to be named here because `fx_quote_settlement`
-- is the row that records it. Between acceptance and settlement the
-- market moves, and we are committed to the MXN figure the customer
-- saw. Somebody eats the difference, and it is us:
--
--   DR  2100/<business>   sell_cents              (the committed price)
--   CR  4200              fee_cents               (our disclosed fee)
--   CR  1140              settlement_cost_cents   (the USDC that left)
--   CR/DR  ????           variance_cents          (what the move cost us)
--
-- THE FOURTH ACCOUNT DOES NOT EXIST IN THE CHART. It is not 5200
-- (that is credit loss), not 5100 (that is what providers charge us),
-- and not 2900 (that is sub-cent dust). Adding it means editing
-- src/lib/ledger/chart.ts, which this work does not own, so it is
-- written down rather than invented: docs/FX.md §6 carries the exact
-- `ChartAccount` literal to add, and `fx_quote_settlement.variance_cents`
-- records the number in the meantime so the unposted amount is a
-- queryable figure rather than a paragraph.
--
-- ---------------------------------------------------------------------
-- 1.  The rate observation — where the number came from
-- ---------------------------------------------------------------------

-- The same two words 0005 and 0016 use, and the same rule: `live` only
-- when a real third party answered a real call. A quote priced off the
-- fallback table is `simulated` in this column and says so on the
-- screen, in words, above the rate.
CREATE TYPE fx_rate_evidence AS ENUM ('live', 'simulated');

-- One reading of one currency pair, kept forever.
--
-- This table is the answer to "where did 16.9435 come from". A quote
-- references the observation it was priced from, so the provenance of
-- a commitment made months ago is a join rather than a log grep.
CREATE TABLE fx_rate_observation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who said so. 'frankfurter.dev' for the live source; 'fixed-table'
  -- for the built-in fallback. Never a display name — this is matched
  -- on.
  source        text NOT NULL CHECK (length(btrim(source)) > 0),
  evidence      fx_rate_evidence NOT NULL,

  base_currency  char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fx_observation_pair_differs CHECK (base_currency <> quote_currency),

  -- Units of quote_currency per ONE unit of base_currency, multiplied
  -- by rate_scale. USD/MXN 16.9435 at scale 10^8 is 1694350000.
  rate_scaled   bigint NOT NULL CHECK (rate_scaled > 0),
  rate_scale    bigint NOT NULL CHECK (rate_scale > 0),
  -- A scale that is not a power of ten would make every printed rate a
  -- lie about its own decimal places.
  CONSTRAINT fx_observation_scale_is_power_of_ten
    CHECK (rate_scale IN (1, 10, 100, 1000, 10000, 100000, 1000000,
                          10000000, 100000000, 1000000000, 10000000000,
                          100000000000, 1000000000000)),

  -- THE EXACT CHARACTERS THE SOURCE RETURNED, unparsed.
  --
  -- Frankfurter returns `16.9435` as a JSON number, and JSON.parse
  -- would make that an IEEE-754 double before any of our code saw it.
  -- src/lib/fx/rate.ts lifts the literal out of the response text with
  -- a regex and scales it by string arithmetic, and this column is the
  -- receipt: the digits we were actually given, next to the integer we
  -- turned them into. A reader can redo the conversion by hand.
  rate_literal  text NOT NULL CHECK (rate_literal ~ '^[0-9]+(\.[0-9]+)?$'),

  -- The source's OWN date for the rate, which is not when we asked.
  -- ECB reference rates are published once per working day around
  -- 16:00 CET, so a rate fetched on Saturday carries Friday's date and
  -- the screen has to be able to say so.
  rate_date     date NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),

  -- The status code of the call that produced this row. 200 for a live
  -- reading; NULL when nobody was called. Kept because "the rate source
  -- answered" is a claim, and a claim wants evidence.
  http_status   smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT fx_observation_live_was_answered
    CHECK (evidence = 'simulated' OR http_status IS NOT NULL)
);

CREATE INDEX fx_rate_observation_pair_idx
  ON fx_rate_observation (base_currency, quote_currency, fetched_at DESC);

COMMENT ON TABLE fx_rate_observation IS
  'One reading of one currency pair, append-only. rate_literal is the exact text the source returned; rate_scaled is that text as an integer at rate_scale. Evidence is live only when a third party answered.';
COMMENT ON COLUMN fx_rate_observation.rate_literal IS
  'The undigested decimal the source printed. Kept so the integer beside it can be re-derived by hand, and so no float ever has to be trusted.';


-- ---------------------------------------------------------------------
-- 2.  The arithmetic, as four IMMUTABLE functions
-- ---------------------------------------------------------------------
--
-- These exist as functions, not as inline expressions, for one hard
-- reason and one soft one.
--
-- HARD: Postgres forbids a generated column from referencing another
-- generated column. `buy_minor` needs `fee_cents` and
-- `customer_rate_scaled`, so without functions its expression would
-- have to repeat both of theirs verbatim, and three copies of the fee
-- formula in one CREATE TABLE is three places for it to diverge.
--
-- SOFT: the same arithmetic exists in TypeScript, in
-- src/lib/fx/quote.ts, because the screen has to price a quote before
-- anything is stored. Two copies of one formula is normally forbidden;
-- it is allowed here for the same reason `aba_checksum_ok()` is allowed
-- to duplicate `aba.ts`, and under the same condition — a test runs a
-- corpus through both and asserts they agree exactly, digit for digit
-- (src/lib/fx/fx.integration.test.ts). These being callable functions
-- is what makes that test possible at all.
--
-- `numeric` inside is an exact wide integer accumulator, never a float:
-- sell_cents * rate_scaled * 10^exponent overflows bigint at plausible
-- amounts, and numeric does not overflow. Every function floors or
-- ceilings back to bigint before returning.

-- The disclosed fee: a flat charge plus basis points of the amount,
-- ROUNDED UP. Rounding a fee up is in our favour by at most one cent,
-- and it is stated here, in the screen's arithmetic panel, and in
-- docs/FX.md §4 rather than being discovered by a customer.
CREATE OR REPLACE FUNCTION fx_fee_cents(p_sell_cents bigint, p_fee_flat_cents bigint, p_fee_bps integer)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT p_fee_flat_cents
       + ceil(p_sell_cents::numeric * p_fee_bps::numeric / 10000::numeric)::bigint
$$;

COMMENT ON FUNCTION fx_fee_cents(bigint, bigint, integer) IS
  'Flat cents plus basis points of the amount, rounded UP to the cent. The rounding direction is ours and is disclosed on the screen.';

-- The rate the customer actually gets: the mid, less our spread,
-- ROUNDED DOWN. Down means fewer destination units per dollar, which is
-- in our favour — the same direction every dealer rounds, and the same
-- disclosure obligation. The spread is shown on the screen as its own
-- line precisely because a spread is the part of an FX price that
-- normally hides inside the rate.
CREATE OR REPLACE FUNCTION fx_customer_rate(p_mid_rate_scaled bigint, p_spread_bps integer)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT floor(
    p_mid_rate_scaled::numeric * (10000 - p_spread_bps)::numeric / 10000::numeric
  )::bigint
$$;

COMMENT ON FUNCTION fx_customer_rate(bigint, integer) IS
  'Mid rate less spread_bps, floored at the stored scale. Floor favours us; the spread is shown as its own line on the quote.';

-- What the beneficiary receives, in the destination's minor units.
--
--   (sell_cents - fee_cents) / 100        -> dollars, exactly, as numeric
--     x customer_rate_scaled / rate_scale -> destination major units
--     x 10^exponent                       -> destination minor units
--
-- FLOORED, and the floor is the interesting one because it is the only
-- rounding here that is against the customer AND unavoidable: a
-- fraction of a centavo cannot be delivered by anybody. The residual is
-- strictly less than one minor unit — under a hundredth of a US cent on
-- an MXN corridor — and it is disclosed on the screen next to the
-- figure it was taken from. Rounding UP would commit us to money we did
-- not buy, which is a worse answer than losing a fraction of a centavo.
CREATE OR REPLACE FUNCTION fx_buy_minor(
  p_sell_cents      bigint,
  p_fee_flat_cents  bigint,
  p_fee_bps         integer,
  p_mid_rate_scaled bigint,
  p_spread_bps      integer,
  p_rate_scale      bigint,
  p_buy_exponent    smallint
) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT floor(
    (p_sell_cents - fx_fee_cents(p_sell_cents, p_fee_flat_cents, p_fee_bps))::numeric
      * fx_customer_rate(p_mid_rate_scaled, p_spread_bps)::numeric
      * power(10::numeric, p_buy_exponent::numeric)
      / (100::numeric * p_rate_scale::numeric)
  )::bigint
$$;

COMMENT ON FUNCTION fx_buy_minor(bigint, bigint, integer, bigint, integer, bigint, smallint) IS
  'The committed delivery amount in destination minor units, floored. This is the number the customer is promised and the number the schema generates — a caller cannot store one that does not follow from the rate it claims.';

-- The USD cost, in cents, of buying a committed delivery amount at a
-- given rate. Used at SETTLEMENT to work out what the market move cost
-- us, and CEILINGED — buying is the expensive direction, and a cost
-- rounded down is a loss hidden by a penny.
CREATE OR REPLACE FUNCTION fx_cost_cents(
  p_buy_minor    bigint,
  p_rate_scaled  bigint,
  p_rate_scale   bigint,
  p_buy_exponent smallint
) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ceil(
    p_buy_minor::numeric * 100::numeric * p_rate_scale::numeric
      / (p_rate_scaled::numeric * power(10::numeric, p_buy_exponent::numeric))
  )::bigint
$$;

COMMENT ON FUNCTION fx_cost_cents(bigint, bigint, bigint, smallint) IS
  'USD cents needed to buy p_buy_minor of the destination at p_rate_scaled, ceilinged. The settlement side of fx_buy_minor.';


-- ---------------------------------------------------------------------
-- 3.  The quote — the offer itself
-- ---------------------------------------------------------------------

CREATE TABLE fx_quote (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_id     uuid NOT NULL REFERENCES book_entity(id),
  -- Whose money it is. The 2100 leaf is derivable from this; storing an
  -- account id as well would be two spellings of one fact.
  business_id   uuid NOT NULL REFERENCES business(id),

  -- The handle a human quotes down a phone. Unique, but NOT an
  -- idempotency key: asking for a quote twice SHOULD produce two
  -- quotes, because two offers at two instants are two different
  -- offers and neither commits anybody. The only thing in this feature
  -- that must happen at most once is acceptance, and that is a PRIMARY
  -- KEY two tables down.
  quote_ref     text NOT NULL UNIQUE CHECK (quote_ref ~ '^FXQ-[0-9A-HJKMNP-TV-Z]{8}$'),

  -- ---- what the customer sends -------------------------------------
  -- USD, in cents, and the CHECK says so rather than a comment saying
  -- so. This column exists to be read, not to vary.
  sell_currency char(3) NOT NULL DEFAULT 'USD' CHECK (sell_currency = 'USD'),
  -- Up to $1bn. An upper bound because `buy_minor` is a bigint and a
  -- JPY corridor multiplies by ~150: an unbounded sell amount is an
  -- unbounded product.
  sell_cents    bigint NOT NULL CHECK (sell_cents > 0 AND sell_cents <= 100000000000),

  -- ---- our charges, both of them, separately -----------------------
  fee_flat_cents bigint NOT NULL CHECK (fee_flat_cents >= 0 AND fee_flat_cents <= 1000000),
  fee_bps        integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  -- The spread is kept APART from the fee on purpose. They are two
  -- different charges with two different disclosure stories: the fee is
  -- the one customers see, the spread is the one that normally hides
  -- inside the rate. Netting them into one number would be the single
  -- most dishonest thing this schema could do.
  spread_bps     integer NOT NULL CHECK (spread_bps BETWEEN 0 AND 1000),

  -- ---- the rate this quote was priced from -------------------------
  observation_id  uuid NOT NULL REFERENCES fx_rate_observation(id),
  mid_rate_scaled bigint NOT NULL CHECK (mid_rate_scaled > 0),
  rate_scale      bigint NOT NULL CHECK (rate_scale > 0),

  -- ---- what the beneficiary receives -------------------------------
  buy_currency  char(3) NOT NULL CHECK (buy_currency ~ '^[A-Z]{3}$' AND buy_currency <> 'USD'),
  buy_exponent  smallint NOT NULL CHECK (buy_exponent BETWEEN 0 AND 6),

  -- ---- the rail the money crosses on -------------------------------
  -- 'usdc' and nothing else, today. The column is `rail` rather than a
  -- boolean because the quote mechanism is rail-agnostic — a wire to a
  -- correspondent would use the identical row — and the CHECK is the
  -- honest statement of what is actually wired.
  rail          rail NOT NULL DEFAULT 'usdc' CHECK (rail = 'usdc'),

  -- Who is being paid, in the customer's own words, and where the USDC
  -- leg sends. NEVER a bank account number: same rule as
  -- payee.account_number_last4 and payment_instruction.counterparty.
  beneficiary_ref     text NOT NULL CHECK (length(btrim(beneficiary_ref)) > 0),
  destination_address text CHECK (destination_address IS NULL OR destination_address ~ '^0x[0-9a-fA-F]{40}$'),

  -- ---- the derived commitment --------------------------------------
  -- GENERATED, so the promise cannot disagree with the rate it claims
  -- to follow. See section 2.
  fee_cents bigint GENERATED ALWAYS AS
    (fx_fee_cents(sell_cents, fee_flat_cents, fee_bps)) STORED,
  customer_rate_scaled bigint GENERATED ALWAYS AS
    (fx_customer_rate(mid_rate_scaled, spread_bps)) STORED,
  buy_minor bigint GENERATED ALWAYS AS
    (fx_buy_minor(sell_cents, fee_flat_cents, fee_bps, mid_rate_scaled,
                  spread_bps, rate_scale, buy_exponent)) STORED,

  -- ---- the offer's own terms ---------------------------------------
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES actor(id),

  -- THE EXPIRY IS PART OF THE OFFER, not a policy applied later. Stored
  -- absolute rather than as a TTL so a clock change, a deploy or a
  -- config edit cannot retroactively lengthen an offer somebody is
  -- looking at.
  expires_at    timestamptz NOT NULL,
  CONSTRAINT fx_quote_expiry_after_creation CHECK (expires_at > created_at),
  -- Fifteen minutes is the ceiling. Past that the rate we are quoting
  -- is a rate nobody could still deal at, and a long-lived quote is an
  -- unhedged option we handed out for free.
  CONSTRAINT fx_quote_expiry_is_short
    CHECK (expires_at <= created_at + interval '15 minutes'),

  -- How long AFTER acceptance we remain on the hook for the rate. Also
  -- part of the offer: an acceptance is a commitment, but not an
  -- indefinite one, and "how long do I have to send it" is a question
  -- the customer is entitled to have answered up front.
  settlement_window_seconds integer NOT NULL
    CHECK (settlement_window_seconds BETWEEN 60 AND 604800)
);

CREATE INDEX fx_quote_business_idx ON fx_quote (business_id, created_at DESC);
CREATE INDEX fx_quote_expiry_idx   ON fx_quote (expires_at);

COMMENT ON TABLE fx_quote IS
  'A priced offer with an expiry. Append-only and never edited: there is no status column, because acceptance is a row in fx_quote_acceptance and expiry is a comparison against expires_at.';
COMMENT ON COLUMN fx_quote.buy_minor IS
  'The committed delivery amount, in the destination currency minor units. A PROMISE, not a balance: it is never summed, never netted, and never added to a dollar. The general ledger stays USD cents.';
COMMENT ON COLUMN fx_quote.quote_ref IS
  'A human handle, unique, deliberately NOT an idempotency key — two requests should produce two offers, and only acceptance is once-only.';
COMMENT ON COLUMN fx_quote.spread_bps IS
  'Our margin on the rate, held apart from fee_bps because they are two different charges with two different disclosure stories.';


-- ---------------------------------------------------------------------
-- 4.  Acceptance — one row, once, and never after the expiry
-- ---------------------------------------------------------------------

CREATE TABLE fx_quote_acceptance (
  -- The PRIMARY KEY is the whole concurrency story. Two simultaneous
  -- acceptances of one quote are one row and one unique violation, and
  -- the loser is told so rather than quietly overwriting the winner.
  quote_id      uuid PRIMARY KEY REFERENCES fx_quote(id),
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  accepted_by   uuid NOT NULL REFERENCES actor(id),
  -- What the customer was looking at when they pressed it. Free text,
  -- e.g. the invoice this payout settles.
  reference     text CHECK (reference IS NULL OR length(btrim(reference)) > 0)
);

COMMENT ON TABLE fx_quote_acceptance IS
  'The acceptance. Quote id as PRIMARY KEY: once, never twice, never undone. An acceptance past the quote expiry is refused by fx_quote_acceptance_guard, not by the application.';

-- THE TRIGGER THAT MAKES THE EXPIRY REAL.
--
-- Everything else in this feature is arithmetic and presentation. This
-- is the control. It fires as the row goes in, reads the quote's own
-- `expires_at`, and refuses — so an acceptance that was in flight when
-- the offer lapsed does not land, an application that forgets to check
-- does not create a commitment we never made, and a hand-written INSERT
-- in psql gets the same answer.
--
-- `now()` is the transaction timestamp, which is the right clock: two
-- statements in one transaction must agree on whether the offer was
-- still open.
CREATE OR REPLACE FUNCTION fx_quote_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
BEGIN
  SELECT expires_at, quote_ref INTO q FROM fx_quote WHERE id = NEW.quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no quote %', NEW.quote_id USING ERRCODE = '23503';
  END IF;

  IF NEW.accepted_at > q.expires_at THEN
    RAISE EXCEPTION
      'quote % expired at % and cannot be accepted at % - request a new quote',
      q.quote_ref, q.expires_at, NEW.accepted_at
      USING ERRCODE = '55006';   -- object_not_in_prerequisite_state
  END IF;

  -- Backdating an acceptance would defeat the line above.
  IF NEW.accepted_at > now() + interval '5 seconds'
     OR NEW.accepted_at < now() - interval '5 seconds' THEN
    RAISE EXCEPTION
      'accepted_at must be the wall clock, not a chosen instant (got %, now is %)',
      NEW.accepted_at, now()
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fx_quote_acceptance_before_expiry
  BEFORE INSERT ON fx_quote_acceptance
  FOR EACH ROW EXECUTE FUNCTION fx_quote_acceptance_guard();


-- ---------------------------------------------------------------------
-- 5.  Settlement — the payout that consumed the commitment
-- ---------------------------------------------------------------------

CREATE TABLE fx_quote_settlement (
  -- Once, like acceptance. A quote is consumed by exactly one payout;
  -- a second payout needs a second quote, and the PRIMARY KEY is what
  -- stops one accepted rate funding two transfers.
  quote_id      uuid PRIMARY KEY REFERENCES fx_quote(id),
  settled_at    timestamptz NOT NULL DEFAULT now(),
  settled_by    uuid NOT NULL REFERENCES actor(id),

  -- The chain's own handle on the money. NOT NULL, because a settlement
  -- with no transaction is a settlement that did not happen: this row
  -- is written AFTER a receipt came back with status 0x1, never after a
  -- broadcast. Same rule postUsdcPayout() holds itself to.
  tx_hash       text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- The journal entry that posted it, when the caller has one. Nullable
  -- because the posting and this row are two writes to two systems and
  -- the honest schema admits the gap rather than pretending it closes.
  entry_id      uuid REFERENCES journal_entry(id),

  -- ---- what the commitment cost us ---------------------------------
  -- The mid at the moment we actually settled, and the variance it
  -- implies. NOT the quoted mid: the whole point of a commitment is
  -- that these two can differ.
  settlement_mid_rate_scaled bigint NOT NULL CHECK (settlement_mid_rate_scaled > 0),
  settlement_rate_scale      bigint NOT NULL CHECK (settlement_rate_scale > 0),
  settlement_observation_id  uuid REFERENCES fx_rate_observation(id),

  -- SIGNED. Positive means the move went our way and we kept the
  -- difference; negative means we ate it. One signed number rather than
  -- a gain column and a loss column, for the same reason journal_line
  -- has one signed amount_cents: two columns is two places for a sign
  -- error to hide.
  --
  -- THIS FIGURE IS NOT POSTED TO THE JOURNAL by anything in this repo,
  -- because the chart has no account for it (see the header, and
  -- docs/FX.md §6 for the exact account to add). It is stored so the
  -- unposted amount is queryable rather than rhetorical.
  variance_cents bigint NOT NULL,

  -- What the USDC leg actually cost in cents, at the settlement rate.
  -- The three numbers must be consistent, and the CHECK says so: the
  -- customer's price, less our fee, less what we spent, is the
  -- variance. A settlement row that does not add up cannot be stored.
  settlement_cost_cents bigint NOT NULL CHECK (settlement_cost_cents > 0)
);

COMMENT ON TABLE fx_quote_settlement IS
  'The payout that consumed an accepted quote. Written only after a receipt came back with status 0x1 - tx_hash is NOT NULL for exactly that reason.';
COMMENT ON COLUMN fx_quote_settlement.variance_cents IS
  'Signed: positive we kept the difference, negative we ate it. Not posted to the journal - the chart has no account for it yet. See docs/FX.md section 6.';

-- Settlement has two preconditions and neither is the caller's to
-- assert: the quote must have been accepted, and the settlement window
-- the offer named must not have run out. Both are read from rows, here.
CREATE OR REPLACE FUNCTION fx_quote_settlement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
  a record;
BEGIN
  SELECT quote_ref, sell_cents, fee_cents, settlement_window_seconds
    INTO q FROM fx_quote WHERE id = NEW.quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no quote %', NEW.quote_id USING ERRCODE = '23503';
  END IF;

  SELECT accepted_at INTO a FROM fx_quote_acceptance WHERE quote_id = NEW.quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'quote % was never accepted - a payout cannot settle against an offer nobody took',
      q.quote_ref
      USING ERRCODE = '55006';
  END IF;

  IF NEW.settled_at > a.accepted_at + q.settlement_window_seconds * interval '1 second' THEN
    RAISE EXCEPTION
      'quote % was accepted at % and its % second settlement window has closed - re-quote',
      q.quote_ref, a.accepted_at, q.settlement_window_seconds
      USING ERRCODE = '55006';
  END IF;

  -- The identity that makes the variance meaningful rather than a
  -- number somebody typed:
  --   what the customer paid  -  our fee  -  what we spent  =  variance
  IF q.sell_cents - q.fee_cents - NEW.settlement_cost_cents <> NEW.variance_cents THEN
    RAISE EXCEPTION
      'settlement does not add up on %: % - % - % <> %',
      q.quote_ref, q.sell_cents, q.fee_cents, NEW.settlement_cost_cents, NEW.variance_cents
      USING ERRCODE = '23514';   -- check_violation
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fx_quote_settlement_preconditions
  BEFORE INSERT ON fx_quote_settlement
  FOR EACH ROW EXECUTE FUNCTION fx_quote_settlement_guard();


-- ---------------------------------------------------------------------
-- 6.  The derived state
-- ---------------------------------------------------------------------
--
-- Five states, and not one of them is stored. Exactly the rule
-- available balance follows: a status column is a second copy of the
-- truth that drifts and then gets "fixed" by a cron job.
--
--   open      no acceptance, and the offer has not lapsed
--   expired   no acceptance, and it has - the customer must re-quote
--   accepted  accepted, unsettled, and still inside its window
--   lapsed    accepted, unsettled, and the window has closed
--   settled   a payout consumed it
--
-- `expired` and `lapsed` are deliberately different words for
-- deliberately different facts. An expired quote is an offer nobody
-- took. A lapsed one is a commitment we made and honoured for as long
-- as we said we would. Collapsing them would make the screen unable to
-- say which of the two happened, and they have different remedies.
CREATE VIEW v_fx_quote AS
SELECT
  q.id                AS quote_id,
  q.quote_ref,
  q.entity_id,
  q.business_id,
  b.legal_name        AS business_name,

  q.sell_currency,
  q.sell_cents,
  q.fee_flat_cents,
  q.fee_bps,
  q.fee_cents,
  (q.sell_cents - q.fee_cents) AS net_cents,

  q.spread_bps,
  q.mid_rate_scaled,
  q.customer_rate_scaled,
  q.rate_scale,

  q.buy_currency,
  q.buy_exponent,
  q.buy_minor,

  q.rail,
  q.beneficiary_ref,
  q.destination_address,

  o.source            AS rate_source,
  o.evidence          AS rate_evidence,
  o.rate_literal,
  o.rate_date,
  o.fetched_at        AS rate_fetched_at,
  o.http_status       AS rate_http_status,

  q.created_at,
  q.created_by,
  cb.display_name     AS created_by_name,
  q.expires_at,
  q.settlement_window_seconds,

  a.accepted_at,
  a.accepted_by,
  ab.display_name     AS accepted_by_name,
  a.reference         AS acceptance_reference,
  -- How close the customer cut it. Negative is impossible - the
  -- trigger refuses it - so a negative here would be a bug, loudly.
  CASE WHEN a.accepted_at IS NULL THEN NULL
       ELSE floor(extract(epoch FROM (q.expires_at - a.accepted_at)))::bigint
  END AS accepted_with_seconds_to_spare,
  CASE WHEN a.accepted_at IS NULL THEN NULL
       ELSE a.accepted_at + q.settlement_window_seconds * interval '1 second'
  END AS settle_by,

  s.settled_at,
  s.tx_hash,
  s.entry_id,
  s.settlement_mid_rate_scaled,
  s.settlement_cost_cents,
  s.variance_cents,

  -- Seconds until the offer lapses. Negative once it has, which the
  -- screen renders as a countdown that has run out rather than hiding.
  floor(extract(epoch FROM (q.expires_at - now())))::bigint AS expires_in_seconds,

  CASE
    WHEN s.quote_id IS NOT NULL THEN 'settled'
    WHEN a.quote_id IS NOT NULL
     AND now() <= a.accepted_at + q.settlement_window_seconds * interval '1 second'
      THEN 'accepted'
    WHEN a.quote_id IS NOT NULL THEN 'lapsed'
    WHEN now() > q.expires_at THEN 'expired'
    ELSE 'open'
  END AS state

FROM fx_quote q
JOIN business b            ON b.id = q.business_id
JOIN fx_rate_observation o ON o.id = q.observation_id
JOIN actor cb              ON cb.id = q.created_by
LEFT JOIN fx_quote_acceptance a ON a.quote_id = q.id
LEFT JOIN actor ab              ON ab.id = a.accepted_by
LEFT JOIN fx_quote_settlement s ON s.quote_id = q.id;

COMMENT ON VIEW v_fx_quote IS
  'Every quote with its state derived, never stored. open / expired / accepted / lapsed / settled - expired is an offer nobody took, lapsed is a commitment whose settlement window closed.';


-- ---------------------------------------------------------------------
-- 7.  Privileges — the same shape every other append-only table has
-- ---------------------------------------------------------------------
--
-- corgi_app gets SELECT and INSERT and nothing else. It cannot express
-- an UPDATE against a quote, an acceptance or a settlement, so "a quote
-- is not edited into accepted" is a privilege rather than a habit. The
-- REVOKE is redundant after the GRANT and is written anyway, because it
-- is the line a reviewer greps for.

GRANT SELECT, INSERT ON
  fx_rate_observation, fx_quote, fx_quote_acceptance, fx_quote_settlement
TO corgi_app;

REVOKE UPDATE, DELETE, TRUNCATE ON
  fx_rate_observation, fx_quote, fx_quote_acceptance, fx_quote_settlement
FROM corgi_app, PUBLIC;

GRANT SELECT ON v_fx_quote TO corgi_app;

-- Layer 2, exactly as 0001 section 13: privileges do not bind the table
-- OWNER, so a future migration or a human in psql would sail past the
-- REVOKE above. These triggers catch that.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fx_rate_observation', 'fx_quote', 'fx_quote_acceptance', 'fx_quote_settlement'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_no_update_delete BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
  END LOOP;
END $$;
