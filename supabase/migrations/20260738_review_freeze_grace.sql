-- =========================================================
-- record_review: give the CRAM FREEZE a grace window near the due date.
--
-- The freeze (20260729/20260735) rejects a successful review of any word still held
-- above R = 0.9 — the SCHEDULE (stability + clock) doesn't move. That's right for a
-- word you're cramming early, but too blunt at the boundary: a word essentially at its
-- due date (R just above 0.9), reviewed via "Review" / "Review All", earned nothing.
--
-- FIX: count a success once the word is within the LAST `c_freeze_grace_frac` (15%) of
-- its review interval — i.e. ≤ 15% of the time-to-due remaining. A PROPORTIONAL window,
-- not an absolute one, so a 6-day interval and a 200-day interval each get their own
-- last-15% (≈ 0.9d vs ≈ 3d).
--
-- Neat identity that makes it a one-liner: "the last fraction f of the interval" is a
-- constant RECALL threshold. The interval runs R: 1 → c_fresh_r, and because the
-- forgetting curve flattens near due, equal time-fractions map to one R — freeze holds
-- exactly while R > c_fresh_r^(1−f) (≈ 0.914 at f = 0.15). No stability term needed.
--
-- Why this can't re-inflate mature words (the thing the freeze exists to stop): credit
-- is only granted in that last slice before due, and a counted review pushes the next
-- due date well out — so a word can be advanced at most about once per interval, never
-- daily. The measured 40→85 daily-cram blow-up needed EVERY day to count.
--
-- SCOPE: only the freeze changes. `v_fresh` (the fresh-LAPSE amplifier — a word you
-- failed moments after seeing it) keeps its R > 0.9 meaning; a new `v_freeze` carries
-- the grace. Everything else — seeds, ease, lapse cap, fuzz, the short-term strength
-- written on every pass, peak tracking — is byte-for-byte 20260735.
-- =========================================================

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
         v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r);
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
     v_lvl.ease, v_lvl.word_position, v_lvl.user_position, v_lvl.level_source, v_r);

  RETURN w;
END;
$$;
