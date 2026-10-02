-- =========================================================
-- review_log: drop its copy of the owner, record the card's DIRECTION; two redundant
-- indexes go. One file because all of it turns on one new record_review().
--
-- ── A. Storage trim ───────────────────────────────────────────────────────────
-- Measured on prod 2026-10-02 (one real account: 3,327 words, 10,368 log rows):
--
--   review_log.user_id            37 B of every ~139 B row, and it says nothing the row
--                                 doesn't already say: user_word_id -> user_words.user_id.
--                                 The log is the table that grows with use (one row per
--                                 card per day), so this is ~18% off the growth rate.
--   idx_user_words_by_user        (user_id) — a strict PREFIX of uq_user_words_dictionary
--                                 (user_id, dictionary_word_id), idx_user_words_user_recent
--                                 and idx_user_words_lookup, any of which answers a
--                                 user_id-only probe. 72 kB / ~22 B per saved word.
--   idx_list_words_lookup         (list_id, user_word_id) — byte-for-byte the same key as
--                                 the UNIQUE constraint's own index
--                                 (list_words_list_id_user_word_id_key).
--
-- WHAT READ THE COLUMN, and what each becomes (inventory taken from pg_proc / pg_depend
-- on prod, not from grep — superseded migration bodies don't count):
--   * record_review              wrote it on both INSERTs            -> stops writing it
--   * snapshot_confidence_daily  "who reviewed on p_day"             -> joins user_words
--   * user_select_own_review_log USING (user_id = auth.uid())        -> EXISTS on the card
--   * review_log_user_id_fkey    users ON DELETE CASCADE             -> goes with the
--     column; a deleted user still takes their log with them, one hop longer:
--     users -> user_words (CASCADE) -> review_log (CASCADE).
--   profile_history, prune_anonymous_guests and prune_review_log already reach the log
--   through user_word_id and are untouched. No client reads the table's user_id (the app
--   never selects review_log directly), so no installed build is affected.
--   claim_guest_merge (20260782) is written to work on either side of this migration.
--
-- ORDER. The file applies as one transaction, and the steps are still ordered so each
-- is valid on what came before it: the column first becomes optional, THEN the
-- functions stop supplying it, THEN the policy stops reading it, and only then is it
-- dropped.
--
-- SPACE. DROP COLUMN is a catalog change: rows written from now on are smaller, the
-- existing ones keep their 37 bytes until the table is rewritten. That is a one-off
-- `VACUUM FULL review_log;` run by hand after this has applied (it cannot run inside a
-- migration's transaction; on today's 2 MB table it holds its lock for milliseconds).
--
-- BACKUPS. scripts/backup-user-data.sh dumps DATA ONLY, with a column list. A dump
-- taken BEFORE this migration therefore restores only into a schema that still has the
-- column: restore the schema at 20260783, load the dump, then apply this file. Take a
-- fresh backup right before applying it to an environment with real data, and another
-- right after — that second one is the first that restores into the new schema.
--
-- ── B. Card direction ─────────────────────────────────────────────────────────
-- A flashcard is shown word-first (foreign -> native) everywhere — a new word's first
-- quiz and the review queue alike — unless the user has flipped the quiz to
-- meaning-first (hooks/useQuizFlip). Recognising a word and producing it are different
-- acts of memory, and until now the log mixed them with no way to tell which a grade
-- was given for. Like every other column here it cannot be backfilled, so it starts
-- being written now: review_log.reversed, +1 byte a row (under 3 B with alignment —
-- a fraction of what part A takes off).
--
--   FALSE  word on the front (the default)        TRUE  meaning on the front (flipped)
--   NULL   not recorded — every row before this migration, and any written by a build
--          that predates it. Deliberately not defaulted to FALSE: an old build could
--          have been flipped, and "unknown" must stay distinguishable from "word-first".
--
-- IT IS EVIDENCE, NOT STATE. There is still ONE schedule per word: a grade moves the
-- same stability and the same displayed confidence whichever way the card faced, so a
-- new word graded 5 is a 5 in both directions. Nothing in the scheduler reads the
-- column; it exists so a later fit can ask whether direction predicts recall.
--
-- A same-day repeat keeps the direction of the day's FIRST review, like every other
-- column on the row (20260744) — the row is that review; later ones bump `repeats`.
--
-- record_review() gains p_reversed (DEFAULT NULL). An added parameter is a NEW function
-- identity, and two overloads would make a (p_user_word_id, p_grade) call ambiguous to
-- PostgREST, so the 3-argument form is dropped first — the same move 20260759 made.
-- Installed builds call with named arguments and simply land on the default.
-- =========================================================

DROP INDEX IF EXISTS idx_user_words_by_user;
DROP INDEX IF EXISTS idx_list_words_lookup;

-- 1. Optional before anything stops supplying it.
ALTER TABLE review_log ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE review_log ADD COLUMN IF NOT EXISTS reversed BOOLEAN;

COMMENT ON COLUMN review_log.reversed IS
  'Which face was up when this grade was given: FALSE = word-first, TRUE = meaning-first '
  '(the quiz flip), NULL = not recorded. Evidence only — the schedule never reads it.';

-- 2. record_review — body as 20260759, minus the owner column on the two INSERTs and
--    plus the direction. The old identity goes first (see B above).
DROP FUNCTION IF EXISTS record_review(UUID, INT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION record_review(
  p_user_word_id UUID,
  p_grade        INT,
  p_reviewed_at  TIMESTAMPTZ DEFAULT NULL,  -- NULL = now(); an offline replay names its moment
  p_reversed     BOOLEAN     DEFAULT NULL   -- TRUE = meaning-first card; NULL = not recorded
)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w         user_words;
  v_now     TIMESTAMPTZ;   -- assigned after the row is locked (the clamp needs it)
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

  -- The review instant, clamped to [last_reviewed_date, now()] — see the header. With
  -- p_reviewed_at NULL this is exactly now(), so the online path is unchanged.
  v_now := LEAST(
             now(),
             GREATEST(
               COALESCE(p_reviewed_at, now()),
               COALESCE(w.last_reviewed_date, COALESCE(p_reviewed_at, now()))
             )
           );

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
        (user_word_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability,
         ease, word_position, user_position, level_source, retrievability, reversed)
      VALUES
        (p_user_word_id, p_grade, v_now, v_elapsed, v_prev_s, w.stability,
         v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r, p_reversed)
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
    (user_word_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability,
     ease, word_position, user_position, level_source, retrievability, reversed)
  VALUES
    (p_user_word_id, p_grade, v_now, v_elapsed, v_prev_s, v_new_s,
     v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r, p_reversed)
  ON CONFLICT (user_word_id, reviewed_on)
  DO UPDATE SET repeats = LEAST(review_log.repeats + 1, 32767);

  RETURN w;
END;
$$;

-- Re-apply what the DROP discarded.
REVOKE EXECUTE ON FUNCTION record_review(UUID, INT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION record_review(UUID, INT, TIMESTAMPTZ, BOOLEAN) TO anon, authenticated;

COMMENT ON FUNCTION record_review(UUID, INT, TIMESTAMPTZ, BOOLEAN) IS
  'Records one review. p_reviewed_at names the instant it happened (offline replay; '
  'NULL = now(), clamped to [last_reviewed_date, now()] — 20260759). p_reversed records '
  'which face of the card was up; it is logged, never scheduled on — 20260784.';

-- 3. snapshot_confidence_daily — body as 20260779; the day's reviewers are found
--    through the card they reviewed.
CREATE OR REPLACE FUNCTION snapshot_confidence_daily(
  p_day DATE DEFAULT ((now() AT TIME ZONE 'UTC')::date - 1)
)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT (p_day::timestamp AT TIME ZONE 'UTC')       AS t0,
           ((p_day + 1)::timestamp AT TIME ZONE 'UTC') AS t1
  ),
  active AS (
    SELECT uw.user_id FROM user_words uw, bounds b
     WHERE uw.originally_translated_date >= b.t0 AND uw.originally_translated_date < b.t1
    UNION
    SELECT uw.user_id FROM user_words uw, bounds b
     WHERE uw.short_stability_at >= b.t0 AND uw.short_stability_at < b.t1
    UNION
    SELECT uw.user_id FROM review_log r
      JOIN user_words uw ON uw.user_word_id = r.user_word_id
     WHERE r.reviewed_on = p_day
  ),
  scored AS (
    SELECT uw.user_id,
           uw.source_lang,
           COALESCE(w.proficiency_band, w.estimated_band, 0) AS slot,
           (w.proficiency_band IS NULL
              AND not_leveled_vocab(w.part_of_speech, w.jmdict_entry_id)) AS skip_level,
           display_confidence(
             uw.stability, uw.last_reviewed_date, uw.originally_translated_date,
             uw.short_stability, uw.short_stability_at, uw.peak_confidence, b.t1
           ) AS conf
      FROM active a
      JOIN user_words uw ON uw.user_id = a.user_id
      LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
      CROSS JOIN bounds b
     WHERE uw.originally_translated_date < b.t1   -- only words that existed that day
  ),
  lang AS (
    SELECT s.user_id, mode() WITHIN GROUP (ORDER BY s.source_lang) AS main_lang
      FROM scored s GROUP BY s.user_id
  ),
  tot AS (
    SELECT s.user_id, count(*)::int AS n, avg(s.conf)::real AS c
      FROM scored s GROUP BY s.user_id
  ),
  per_band AS (
    SELECT s.user_id, s.slot, count(*)::int AS n, avg(s.conf)::real AS c
      FROM scored s JOIN lang l ON l.user_id = s.user_id
     WHERE s.source_lang = l.main_lang AND NOT s.skip_level
     GROUP BY s.user_id, s.slot
  ),
  arrs AS (
    SELECT m.user_id,
           array_agg(COALESCE(pb.n, 0) ORDER BY g) AS band_n,
           array_agg(pb.c ORDER BY g)              AS band_conf
      FROM (SELECT user_id, max(slot) AS mx FROM per_band GROUP BY user_id) m
      CROSS JOIN LATERAL generate_series(0, m.mx) g
      LEFT JOIN per_band pb ON pb.user_id = m.user_id AND pb.slot = g
     GROUP BY m.user_id
  ),
  ins AS (
    INSERT INTO user_confidence_daily
           (user_id, day, word_count, avg_conf, main_lang, band_n, band_conf)
    SELECT t.user_id, p_day, t.n, t.c, l.main_lang,
           COALESCE(a.band_n, '{}'), COALESCE(a.band_conf, '{}')
      FROM tot t
      JOIN lang l USING (user_id)
      LEFT JOIN arrs a USING (user_id)
    ON CONFLICT (user_id, day) DO UPDATE
       SET word_count = EXCLUDED.word_count,
           avg_conf   = EXCLUDED.avg_conf,
           main_lang  = EXCLUDED.main_lang,
           band_n     = EXCLUDED.band_n,
           band_conf  = EXCLUDED.band_conf
    RETURNING 1
  )
  SELECT count(*)::int FROM ins;
$$;

-- 4. Read-own, through the card. user_words carries its own own-rows policy, so the
--    subquery can only ever see the caller's cards; the explicit auth.uid() test keeps
--    this correct for a role that bypasses that policy.
DROP POLICY IF EXISTS "user_select_own_review_log" ON review_log;
CREATE POLICY "user_select_own_review_log"
ON review_log FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM user_words uw
     WHERE uw.user_word_id = review_log.user_word_id
       AND uw.user_id = (auth.uid())::text
  )
);

-- 5. Nothing reads or writes it now. The FK to users goes with it.
ALTER TABLE review_log DROP COLUMN IF EXISTS user_id;
