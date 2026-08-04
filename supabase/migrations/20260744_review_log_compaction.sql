-- =========================================================
-- review_log compaction — ONE ROW PER CARD PER DAY, and a hard ceiling.
--
-- review_log is the only table in the schema that grows without bound: one row per
-- graded card, never deleted, because FSRS trains on it and the history cannot be
-- backfilled. Measured on prod 2026-08-01: 303 B/row, ~210 reviews per active day
-- for one real user — about 17 MB per user per year, against a 500 MB tier.
--
-- WHAT THIS CHANGES. A card now gets at most one row per UTC day: the FIRST review
-- of that day, which is the one carrying the real retention interval. Later same-day
-- reviews bump a `repeats` counter instead of writing rows. That is the conventional
-- FSRS preprocessing — a 4.5-style fit collapses to the first review of each day
-- anyway — so the fidelity cost is small and deliberate.
--
-- ⚠️ IT IS NOT ZERO, AND IT IS THE REAL DECISION HERE, NOT THE BYTES: FSRS-5's
-- short-term memory model DOES consume same-day reviews. Choosing this closes that
-- door. `repeats` keeps "how much cramming happened that day" at ~1% of the storage,
-- but not the individual grades. Banking data for that future fit is this table's
-- entire reason to exist, so the trade was made explicitly, not by accident.
--
-- Measured effect on prod's real data: 5,877 -> 4,447 rows (-24.3%), 303 -> ~229
-- B/row, 1.70 MB -> ~0.97 MB (-43%). 772 of the 841 cram-frozen rows (92%) are
-- same-day repeats, so the collapse removes almost exactly the reviews the scheduler
-- already treats as teaching it nothing (see the CRAM FREEZE note in 20260729).
--
-- ENFORCED AT WRITE TIME, not by a cleanup job: the unique index IS the guarantee, so
-- there is no window in which duplicates exist and nothing to remember to run.
--
-- The per-card CAP below is separate and removes 0% today (the most-reviewed card has
-- 22 reviews). It is not a saving; it is the ceiling — it converts "grows forever"
-- into "at most vocabulary x KEEP rows".
-- =========================================================

-- ── 1. The counter that replaces the collapsed rows ──────────────────────────
ALTER TABLE review_log
  ADD COLUMN IF NOT EXISTS repeats SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN review_log.repeats IS
  'How many times this card was graded on this UTC day. 1 = a single review. The '
  'extra reviews are NOT stored as rows (see the migration header); this is what '
  'survives of them.';

-- ── 2. Collapse what is already there ────────────────────────────────────────
-- Stamp each day's review count onto every row of that day FIRST (the count has to
-- be taken before anything is deleted), then keep only the earliest row per day.
UPDATE review_log r
   SET repeats = LEAST(c.n, 32767)::SMALLINT
  FROM (
    SELECT user_word_id,
           (reviewed_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS n
      FROM review_log
     GROUP BY 1, 2
    HAVING count(*) > 1
  ) c
 WHERE r.user_word_id = c.user_word_id
   AND (r.reviewed_at AT TIME ZONE 'UTC')::date = c.day;

-- ctid is only used WITHIN this statement, where it is stable.
DELETE FROM review_log
 WHERE ctid IN (
   SELECT ctid FROM (
     SELECT ctid,
            row_number() OVER (PARTITION BY user_word_id,
                                            (reviewed_at AT TIME ZONE 'UTC')::date
                               ORDER BY reviewed_at, ctid) AS rn
       FROM review_log
   ) s
   WHERE s.rn > 1
 );

-- ── 3. Drop the surrogate primary key ────────────────────────────────────────
-- log_id was a UUID PK on an append-only log: 2 lifetime index scans, no foreign key
-- references it, and it appears nowhere in src/ or any migration except its own
-- CREATE TABLE line. Same case as the JMdict surrogate PKs dropped in 20260743.
-- 16 B of heap + ~49 B of index per row, on the fastest-growing table in the schema.
ALTER TABLE review_log DROP CONSTRAINT IF EXISTS review_log_pkey;
ALTER TABLE review_log DROP COLUMN IF EXISTS log_id;

-- ── 4. The day key ───────────────────────────────────────────────────────────
-- A STORED generated column rather than an expression index, for two reasons: an
-- expression index CANNOT back a REPLICA IDENTITY (Postgres requires plain NOT NULL
-- columns), and dropping the PK otherwise leaves the table with none — which would
-- silently break logical replication / Realtime if either is ever pointed at it.
-- Adding it also REWRITES the table, which is what actually reclaims the bytes the
-- dropped log_id column still occupies (DROP COLUMN alone never does).
--
-- UTC on both sides, matching the translation_usage month bucket: the day a review
-- belongs to must not depend on the server's TimeZone setting. timezone(text,
-- timestamptz) is IMMUTABLE, which is what makes it legal in a generated column.
ALTER TABLE review_log
  ADD COLUMN reviewed_on DATE
  GENERATED ALWAYS AS ((reviewed_at AT TIME ZONE 'UTC')::date) STORED NOT NULL;

COMMENT ON COLUMN review_log.reviewed_on IS
  'UTC day of reviewed_at. The collapse key — one row per (user_word_id, reviewed_on).';

CREATE UNIQUE INDEX IF NOT EXISTS review_log_card_day
  ON review_log (user_word_id, reviewed_on);

-- Now redundant: it led with the same column and ordered by reviewed_at, and with one
-- row per card per day reviewed_on sorts identically. Keeping both would mean paying
-- ~53 B/row twice for the same access path.
DROP INDEX IF EXISTS idx_review_log_user_word;

-- Restores what the dropped PK was providing.
ALTER TABLE review_log REPLICA IDENTITY USING INDEX review_log_card_day;

-- ── 5. record_review: later same-day reviews bump the counter ────────────────
-- Body is unchanged from 20260738 EXCEPT the two INSERTs, which now carry
-- ON CONFLICT ... DO UPDATE. Both branches (cram-freeze and the normal path) need it:
-- the freeze branch is where same-day repeats mostly land.
CREATE OR REPLACE FUNCTION record_review(
  p_user_word_id UUID,
  p_grade        INT
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w         user_words;
  v_now     TIMESTAMPTZ := now();
  v_elapsed REAL;
  v_r       REAL;
  v_prev_s  REAL;
  v_base_s  REAL;
  v_new_s   REAL;
  v_short   REAL;
  v_fresh   BOOLEAN := FALSE;   -- still held (R > 0.9) — drives the fresh-LAPSE amplifier
  v_freeze  BOOLEAN := FALSE;   -- still held AND comfortably not-due — drives the cram FREEZE
  v_peak    SMALLINT;
  v_lvl     srs_leveling_t;
  c_max_stability   CONSTANT REAL := 3650;
  c_fresh_r         CONSTANT REAL := 0.9;
  c_short_half_life CONSTANT REAL := 8.0;   -- hours; mirrors display_confidence
  c_fresh_lapse_amp CONSTANT REAL := 0.2;
  -- Grace: a success counts once the word is within the LAST this-fraction of its review
  -- interval (0.15 = final 15% before due). Freeze holds while R > c_fresh_r^(1−frac).
  c_freeze_grace_frac CONSTANT REAL := 0.15;
BEGIN
  IF p_grade < 1 OR p_grade > 5 THEN
    RAISE EXCEPTION 'invalid grade % (expected 1-5)', p_grade;
  END IF;

  SELECT * INTO w FROM user_words
   WHERE user_word_id = p_user_word_id
     AND user_id = (auth.uid())::text
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_word % not found', p_user_word_id;
  END IF;

  v_prev_s := w.stability;
  v_lvl    := srs_leveling(w.user_id, w.dictionary_word_id);  -- ease 1.0 when unknown
  v_peak   := COALESCE(w.peak_confidence, 0);

  -- SHORT-TERM strength: decay what's there, then add this pass. A lapse wipes it —
  -- you just demonstrated you don't have it, so there is nothing to hold.
  v_short := CASE
               WHEN w.short_stability IS NULL OR w.short_stability_at IS NULL THEN 0
               WHEN EXTRACT(EPOCH FROM (v_now - w.short_stability_at)) / 3600.0
                    / c_short_half_life >= 40 THEN 0
               ELSE w.short_stability
                    * power(0.5, GREATEST(0, EXTRACT(EPOCH FROM (v_now - w.short_stability_at))
                                             / 3600.0) / c_short_half_life)
             END;
  v_short := CASE
               WHEN p_grade <= 2 THEN 0
               ELSE v_short + (CASE p_grade WHEN 3 THEN 1.5 WHEN 4 THEN 4.0 ELSE 6.0 END)
             END;

  IF w.stability IS NULL OR w.last_reviewed_date IS NULL THEN
    -- First-ever review: seed so the grade the user gave reads back (see 20260713).
    v_elapsed := NULL;
    v_r       := NULL;
    v_base_s  := CASE p_grade
                   WHEN 1 THEN 1.5
                   WHEN 2 THEN 4.0
                   WHEN 3 THEN 10.0
                   WHEN 4 THEN 22.0
                   WHEN 5 THEN 40.0 * v_lvl.ease
                 END;
  ELSE
    v_elapsed := GREATEST(0, EXTRACT(EPOCH FROM (v_now - w.last_reviewed_date)) / 86400.0);
    v_r := exp(- v_elapsed / GREATEST(w.stability, 0.01));
    v_fresh := v_r > c_fresh_r;
    -- FREEZE only OUTSIDE the grace slice: while R is above c_fresh_r^(1−grace_frac) the
    -- word still has more than grace_frac of its interval left. Inside the slice (or
    -- overdue) a success advances the schedule. This threshold is > c_fresh_r, so it
    -- already implies v_fresh.
    v_freeze := v_r > power(c_fresh_r, 1 - c_freeze_grace_frac);

    -- CRAM FREEZE (20260729): a successful review of a word still held teaches the
    -- SCHEDULER nothing — neither the strength nor the clock moves. It does teach the
    -- DISPLAY something, so the short-term strength and the snapshot are written here.
    IF p_grade >= 3 AND v_freeze THEN
      UPDATE user_words
         SET short_stability    = v_short,
             short_stability_at = v_now,
             confidence_rating  = display_confidence(w.stability, w.last_reviewed_date,
                                                     w.originally_translated_date,
                                                     v_short, v_now, v_peak, v_now)
       WHERE user_word_id = p_user_word_id
       RETURNING * INTO w;

      INSERT INTO review_log
        (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability,
         ease, word_position, user_position, level_source, retrievability)
      VALUES
        (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, w.stability,
         v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r)
      ON CONFLICT (user_word_id, reviewed_on)
      DO UPDATE SET repeats = LEAST(review_log.repeats + 1, 32767);
      RETURN w;
    END IF;

    IF p_grade <= 2 THEN
      -- LAPSE — no ease (see 20260731). The absolute cap brings a mature word straight
      -- back; the fresh amplifier makes "I saw this minutes ago and still missed it"
      -- count for more than a months-old miss.
      v_base_s := LEAST(
                    w.stability * (CASE p_grade WHEN 1 THEN 0.3 ELSE 0.6 END),
                    CASE p_grade WHEN 1 THEN 2.0 ELSE 5.0 END
                  ) * (CASE WHEN v_fresh THEN c_fresh_lapse_amp ELSE 1.0 END);
      -- ...and it voids the peak floor: a word you just failed must be allowed to read 0.
      IF v_fresh THEN
        v_peak := LEAST(v_peak, 4);
      END IF;
    ELSE
      v_base_s := w.stability * (1 + (CASE p_grade
                                        WHEN 3 THEN 1.0
                                        WHEN 4 THEN 2.0 * v_lvl.ease
                                        WHEN 5 THEN 3.5 * v_lvl.ease
                                      END) * (1 - v_r));
    END IF;
  END IF;

  v_base_s := LEAST(c_max_stability, GREATEST(0.5, v_base_s));
  v_new_s  := LEAST(c_max_stability, GREATEST(0.5, fuzz_stability(v_base_s, 0.15)));

  -- Peak tracks the LONG-TERM bucket (un-fuzzed, as before) — cramming can raise the
  -- displayed number but must never earn the floor.
  v_peak := GREATEST(v_peak, confidence_from_stability(v_base_s));

  UPDATE user_words
     SET stability          = v_new_s,
         last_reviewed_date = v_now,
         short_stability    = v_short,
         short_stability_at = v_now,
         peak_confidence    = v_peak,
         confidence_rating  = display_confidence(v_base_s, v_now, w.originally_translated_date,
                                                 v_short, v_now, v_peak, v_now)
   WHERE user_word_id = p_user_word_id
   RETURNING * INTO w;

  INSERT INTO review_log
    (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability,
     ease, word_position, user_position, level_source, retrievability)
  VALUES
    (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, v_new_s,
     v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r)
  ON CONFLICT (user_word_id, reviewed_on)
  DO UPDATE SET repeats = LEAST(review_log.repeats + 1, 32767);

  RETURN w;
END;
$$;

-- ── 6. The ceiling ───────────────────────────────────────────────────────────
-- Keep at most p_keep rows per card, newest first. This removes NOTHING today (the
-- most-reviewed card has 22 rows) — it exists so the table has an upper bound at all:
-- at most (words x p_keep) rows, which at a 5,000-word vocabulary is ~34 MB.
--
-- Newest-first rather than a time window on purpose: a window deletes the START of a
-- card's history, which is where initial-stability signal lives and the part an FSRS
-- fit most needs, while keeping recent noise. This truncates the old tail of only the
-- most-reviewed cards, where recent behaviour already dominates.
CREATE OR REPLACE FUNCTION prune_review_log(
  p_keep    INT     DEFAULT 30,
  p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  IF p_keep < 1 THEN
    RAISE EXCEPTION 'p_keep must be >= 1 (got %)', p_keep;
  END IF;

  IF p_dry_run THEN
    SELECT count(*) INTO v_count FROM (
      SELECT row_number() OVER (PARTITION BY user_word_id ORDER BY reviewed_on DESC) AS rn
        FROM review_log
    ) s WHERE s.rn > p_keep;
    RETURN v_count;
  END IF;

  DELETE FROM review_log
   WHERE ctid IN (
     SELECT ctid FROM (
       SELECT ctid,
              row_number() OVER (PARTITION BY user_word_id ORDER BY reviewed_on DESC) AS rn
         FROM review_log
     ) s
     WHERE s.rn > p_keep
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Server/cron only — it deletes review history.
REVOKE ALL ON FUNCTION prune_review_log(INT, BOOLEAN) FROM public;
REVOKE ALL ON FUNCTION prune_review_log(INT, BOOLEAN) FROM anon, authenticated;

-- Weekly, alongside prune-anonymous-guests (20260727). Same non-fatal pattern where
-- pg_cron isn't available.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('prune-review-log', '41 4 * * 0',
                        'SELECT public.prune_review_log()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule prune_review_log() manually / via Supabase Cron', SQLERRM;
END $$;
