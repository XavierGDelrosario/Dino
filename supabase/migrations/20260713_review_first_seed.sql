-- =========================================================
-- Raise the FIRST-review strength seeds so the self-rated grade maps to the matching
-- confidence on a new word: rate it 5 (= "I know this") and it reads 5/5, not 3/5.
--
-- Before, grade 5 seeded stability 7.0d → confidence_from_stability bucket [7,16) =
-- 3/5, and even grade 4 → 2/5 — too low for "the user knows the word". New seeds put
-- each grade squarely in its own confidence bucket (confidence == grade on the first
-- review): 1→1.5d(=1), 2→4d(=2), 3→10d(=3), 4→22d(=4), 5→40d(=5).
--
-- ONLY the first-review seed CASE changes; the subsequent-review growth (spacing
-- effect) + lapse math are unchanged. CREATE OR REPLACE so it's a body swap; the
-- {user_word_id, grade} API and everything downstream are unaffected.
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
  v_new_s   REAL;
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

  IF w.stability IS NULL OR w.last_reviewed_date IS NULL THEN
    -- First-ever review: seed strength so confidence_from_stability(seed) == grade
    -- (rate 5 → 5/5 "knows it"; rate 1 → 1/5). See bucket thresholds in
    -- confidence_from_stability(): 1,3,7,16,35.
    v_elapsed := NULL;
    v_r       := NULL;
    v_new_s   := CASE p_grade
                   WHEN 1 THEN 1.5    -- bucket [1,3)   → 1
                   WHEN 2 THEN 4.0    -- bucket [3,7)   → 2
                   WHEN 3 THEN 10.0   -- bucket [7,16)  → 3
                   WHEN 4 THEN 22.0   -- bucket [16,35) → 4
                   WHEN 5 THEN 40.0   -- bucket [35,∞)  → 5
                 END;
  ELSE
    v_elapsed := GREATEST(0, EXTRACT(EPOCH FROM (v_now - w.last_reviewed_date)) / 86400.0);
    v_r := exp(- v_elapsed / GREATEST(w.stability, 0.01));

    IF p_grade <= 2 THEN
      v_new_s := GREATEST(0.5, w.stability * (CASE p_grade WHEN 1 THEN 0.3 ELSE 0.6 END));
    ELSE
      v_new_s := w.stability * (1 + (CASE p_grade
                                       WHEN 3 THEN 1.0
                                       WHEN 4 THEN 2.0
                                       WHEN 5 THEN 3.5
                                     END) * (1 - v_r));
    END IF;
  END IF;

  UPDATE user_words
     SET stability          = v_new_s,
         last_reviewed_date = v_now,
         confidence_rating  = confidence_from_stability(v_new_s)
   WHERE user_word_id = p_user_word_id
   RETURNING * INTO w;

  INSERT INTO review_log
    (user_word_id, user_id, grade, reviewed_at, elapsed_days, prev_stability, new_stability)
  VALUES
    (p_user_word_id, w.user_id, p_grade, v_now, v_elapsed, v_prev_s, v_new_s);

  RETURN w;
END;
$$;
