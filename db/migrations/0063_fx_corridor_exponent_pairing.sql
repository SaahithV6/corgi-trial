-- =====================================================================
-- 0063  THE CORRIDOR LIST, ON THE COLUMN  -  pairing buy_currency with
--                                            buy_exponent
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- WHAT IS WRONG
-- ---------------------------------------------------------------------
--
-- `fx_quote` constrains the two halves of a corridor SEPARATELY:
--
--   buy_currency char(3) NOT NULL CHECK (buy_currency ~ '^[A-Z]{3}$'
--                                        AND buy_currency <> 'USD')
--   buy_exponent smallint NOT NULL CHECK (buy_exponent BETWEEN 0 AND 6)
--
-- Both are true of ('JPY', 2).  Neither is capable of noticing that the
-- yen has NO minor unit and that its exponent is 0 -- because the fact
-- pairing a currency with its ISO 4217 exponent lives in ONE place, and
-- that place is a TypeScript array:
--
--   src/lib/fx/types.ts  CORRIDORS = [ ... { currency: "JPY",
--                                            exponent: 0, ... } ]
--
-- `requireCorridor()` reads it, `priceQuote()` goes through
-- `requireCorridor()`, and so every quote the application writes today
-- is right.  That is a calling convention, not a constraint.  Any writer
-- that skips `requireCorridor` -- a repair script, a seed, a second
-- entry point, a hand-typed INSERT in a console -- stores ('JPY', 2) and
-- the database accepts it.
--
-- ---------------------------------------------------------------------
-- WHAT IT COSTS, MEASURED
-- ---------------------------------------------------------------------
--
-- `buy_minor` is GENERATED ALWAYS ... STORED from
-- `fx_buy_minor(..., buy_exponent)`, so the wrong exponent does not
-- produce a wrong-looking row.  It produces a row that is internally
-- CONSISTENT and externally a hundred times too large.  On this book,
-- $1,000.00 sold at the JPY mid of 154.18:
--
--     exponent 0  ->  buy_minor =    154180   ->   "154,180 JPY"
--     exponent 2  ->  buy_minor =  15418000   ->   "154,180.00 JPY"
--
-- and `formatMinorUnits(15418000, 0, 'JPY')` prints 15,418,000 JPY.
-- The promise on the row is the promise the beneficiary is owed.  A
-- hundredfold on a delivery commitment is not a display bug.
--
-- ---------------------------------------------------------------------
-- LATENT TODAY.  THAT IS THE ARGUMENT FOR IT, NOT AGAINST IT
-- ---------------------------------------------------------------------
--
-- Every one of the 124 rows standing on `fx_quote` right now pairs
-- correctly (the counts are asserted in section 3 below, and printed).
-- Nothing is being repaired here.  The point is that the guarantee
-- currently rests on every future writer remembering to call one
-- function, and this build's through-line defect is exactly that: an
-- invariant that holds because of how the application happens to be
-- written rather than because the database will not express the
-- alternative.  A constraint that has never fired is not a constraint
-- that was unnecessary.
--
-- ---------------------------------------------------------------------
-- WHY A COMPOSITE CHECK AND NOT A REFERENCE TABLE
-- ---------------------------------------------------------------------
--
-- A `fx_corridor (currency, exponent)` table with a composite FOREIGN
-- KEY would be the textbook shape and it is the wrong one here.  ISO
-- 4217 minor units are not configuration: the yen's exponent is 0 the
-- way a dollar has 100 cents, and a table is a thing somebody can UPDATE
-- at 2am to make an INSERT go through.  The CHECK cannot be edited by
-- the application role at all -- changing it takes a migration, which is
-- the review step this fact deserves.  The list is five rows long and
-- has changed never.
--
-- The pairs are the five in `CORRIDORS`, and they are pinned here so
-- that widening the TypeScript array WITHOUT a migration fails loudly at
-- the INSERT rather than quietly at the beneficiary's bank.  That is the
-- intended direction of the coupling.
--
-- The existing per-column CHECKs are left in place.  `buy_exponent
-- BETWEEN 0 AND 6` is now implied by this one, but dropping a constraint
-- to tidy up is a strictly negative trade: it removes a guarantee from
-- the catalogue in exchange for nothing.
--
-- ---------------------------------------------------------------------
-- THE THREE RANGES, NOW ONE  (companion change in src/lib/fx/**)
-- ---------------------------------------------------------------------
--
-- One quantity had three ranges: `pow10()`'s guard admitted 0..18, its
-- own doc comment said 0..6, this column's CHECK says 0..6, and
-- `CORRIDORS` produces only {0, 2}.  `pow10()` now bounds at
-- MAX_MINOR_EXPONENT = 6 -- the column's own number, stated once in
-- src/lib/fx/types.ts -- so the arithmetic cannot accept an exponent the
-- row cannot hold.  It stays WIDER than {0, 2} deliberately: the
-- arithmetic is general, and the thing that pins an exponent to a
-- currency is this constraint, not a range.


-- ---------------------------------------------------------------------
-- 1.  BEFORE WRITING ANYTHING: does every existing row satisfy it?
-- ---------------------------------------------------------------------
--
-- `ALTER TABLE ... ADD CONSTRAINT` validates existing rows by itself and
-- would fail on a violation.  It fails with "check constraint is
-- violated by some row" and names no row, no currency and no count,
-- which on a 124-row table is a ten-minute detour and on a large one is
-- a bad afternoon.  This block asks the question first and prints the
-- answer either way.

DO $$
DECLARE
  v_total int;
  v_bad   int;
  r       record;
BEGIN
  SELECT count(*) INTO v_total FROM fx_quote;

  SELECT count(*) INTO v_bad FROM fx_quote
   WHERE (buy_currency, buy_exponent) NOT IN (
           ('MXN', 2::smallint), ('PHP', 2::smallint), ('INR', 2::smallint),
           ('BRL', 2::smallint), ('JPY', 0::smallint));

  IF v_bad <> 0 THEN
    FOR r IN SELECT buy_currency, buy_exponent, count(*) AS n
               FROM fx_quote
              WHERE (buy_currency, buy_exponent) NOT IN (
                      ('MXN', 2::smallint), ('PHP', 2::smallint), ('INR', 2::smallint),
                      ('BRL', 2::smallint), ('JPY', 0::smallint))
              GROUP BY 1, 2 ORDER BY n DESC LOOP
      RAISE WARNING '0063: mispaired: (%, %) -- % quote(s)', r.buy_currency, r.buy_exponent, r.n;
    END LOOP;
    RAISE EXCEPTION
      '0063 refuses to commit: % of % fx_quote rows pair a currency with an exponent ISO 4217 does not give it. Every one of them carries a GENERATED buy_minor computed from the wrong exponent, so this is a repair, not a constraint -- and a repair does not ride along inside the migration that discovered it.',
      v_bad, v_total;
  END IF;

  FOR r IN SELECT buy_currency, buy_exponent, count(*) AS n
             FROM fx_quote GROUP BY 1, 2 ORDER BY buy_currency LOOP
    RAISE NOTICE '0063: standing: (%, %) -- % quote(s), all correctly paired',
      r.buy_currency, r.buy_exponent, r.n;
  END LOOP;
  RAISE NOTICE '0063: % of % existing rows satisfy the pairing', v_total - v_bad, v_total;
END $$;


-- ---------------------------------------------------------------------
-- 2.  The constraint
-- ---------------------------------------------------------------------

ALTER TABLE fx_quote
  ADD CONSTRAINT fx_quote_corridor_exponent_pairing CHECK (
    (buy_currency, buy_exponent) IN (
      ('MXN', 2::smallint),
      ('PHP', 2::smallint),
      ('INR', 2::smallint),
      ('BRL', 2::smallint),
      -- Exponent 0.  The yen has no minor unit; ('JPY', 2) is the row
      -- this whole migration exists to make unwritable.
      ('JPY', 0::smallint)
    )
  );

COMMENT ON COLUMN fx_quote.buy_exponent IS
  'The destination currency''s ISO 4217 minor-unit exponent, and NOT a free smallint: fx_quote_corridor_exponent_pairing pins it to buy_currency, because buy_minor is GENERATED from it and a JPY quote stored at exponent 2 promises the beneficiary a hundred times the yen. The pairs are the five in CORRIDORS (src/lib/fx/types.ts); widening that array without a migration now fails at the INSERT.';


-- ---------------------------------------------------------------------
-- 3.  WHAT THIS MIGRATION ASSERTS BEFORE IT COMMITS
-- ---------------------------------------------------------------------
--
-- Three things, and the third is the one that is usually skipped:
--
--   a. the constraint EXISTS and is VALIDATED -- a NOT VALID constraint
--      is a constraint that binds nothing already in the table, and this
--      one's whole claim is about rows that are already there;
--   b. every standing row still satisfies it, re-counted AFTER the ALTER
--      rather than trusting section 1's count across the DDL;
--   c. IT IS NON-VACUOUS.  A CHECK nobody has seen refuse is a claim.
--      The block below INSERTs a ('JPY', 2) quote inside a SAVEPOINT,
--      requires the refusal, and rolls the savepoint back -- so this
--      migration proves its own constraint on the way past, and writes
--      no row doing it.

DO $$
DECLARE
  v_valid   boolean;
  v_bad     int;
  v_total   int;
  v_refused boolean := false;
  v_entity  uuid;
  v_biz     uuid;
  v_actor   uuid;
  v_obs     uuid;
BEGIN
  SELECT convalidated INTO v_valid
    FROM pg_constraint
   WHERE conrelid = 'fx_quote'::regclass
     AND conname  = 'fx_quote_corridor_exponent_pairing';

  IF v_valid IS NULL THEN
    RAISE EXCEPTION '0063 refuses to commit: fx_quote_corridor_exponent_pairing is not on the table';
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION
      '0063 refuses to commit: fx_quote_corridor_exponent_pairing exists but is NOT VALID, so it binds nothing already stored -- which is precisely the population this constraint is about';
  END IF;

  SELECT count(*) INTO v_total FROM fx_quote;
  SELECT count(*) INTO v_bad FROM fx_quote
   WHERE (buy_currency, buy_exponent) NOT IN (
           ('MXN', 2::smallint), ('PHP', 2::smallint), ('INR', 2::smallint),
           ('BRL', 2::smallint), ('JPY', 0::smallint));
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '0063 refuses to commit: % of % rows violate the pairing after the ALTER', v_bad, v_total;
  END IF;

  -- (c) Make it refuse, here, on this book.
  SELECT q.entity_id, q.business_id, q.created_by, q.observation_id
    INTO v_entity, v_biz, v_actor, v_obs
    FROM fx_quote q ORDER BY q.created_at DESC LIMIT 1;

  IF v_entity IS NULL THEN
    RAISE NOTICE '0063: fx_quote is empty, so the constraint could not be exercised against a real row';
  ELSE
    BEGIN
      INSERT INTO fx_quote (
        entity_id, business_id, quote_ref, sell_cents,
        fee_flat_cents, fee_bps, spread_bps,
        observation_id, mid_rate_scaled, rate_scale,
        buy_currency, buy_exponent,
        beneficiary_ref, created_by, expires_at, settlement_window_seconds)
      VALUES (
        -- quote_ref must match '^FXQ-[0-9A-HJKMNP-TV-Z]{8}$' (no I, L, O, U).
        v_entity, v_biz, 'FXQ-0063PRVE', 100000,
        100, 25, 50,
        v_obs, 15418000000, 100000000,
        'JPY', 2::smallint,
        '0063 non-vacuity probe', v_actor, now() + interval '2 minutes', 86400);
      RAISE EXCEPTION
        '0063 refuses to commit: the database ACCEPTED a JPY quote at exponent 2. The constraint is on the table and does not bind, which is worse than not having written it.';
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;

    IF NOT v_refused THEN
      RAISE EXCEPTION '0063 refuses to commit: the JPY-at-exponent-2 probe neither inserted nor raised check_violation';
    END IF;
    RAISE NOTICE '0063: a JPY quote at exponent 2 was refused by fx_quote_corridor_exponent_pairing -- the constraint is non-vacuous, and the probe row was not kept';
  END IF;

  RAISE NOTICE '0063: fx_quote_corridor_exponent_pairing is VALIDATED and 0 of % rows violate it', v_total;
END $$;
