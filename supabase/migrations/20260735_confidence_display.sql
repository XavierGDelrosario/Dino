-- =========================================================
-- CONFIDENCE becomes a LIVE display value, separate from the SCHEDULE.
--
-- THE CONFLICT. One stored number was doing two incompatible jobs. `stability` (S)
-- schedules the card — a word returns when R = exp(-Δ/S) falls to 0.9 — and the
-- displayed confidence was nothing but confidence_from_stability(S). So the display
-- inherited two properties of the scheduler that make no sense to a reader:
--
--   * It NEVER DECAYED. S doesn't change while you're away, so a word graded 4 in
--     April still read 4/5 in July, when its true recall probability was ~0.
--   * It IGNORED PRACTICE. 20260729's cram freeze — a successful review of a still-
--     fresh word (R > 0.9) is logged but changes nothing — protects the schedule from
--     massed-practice inflation (measured: 14 days of daily grade-5s took a word
--     40d → 85d). It also, as a side effect, made quizzing a word three times in one
--     sitting move the display 0 → 0 → 0. Nothing you did registered.
--
-- THE SPLIT. The schedule keeps `stability` exactly as it is (freeze, absolute lapse
-- cap, ease, fuzz — all untouched). The DISPLAY becomes its own quantity, computed at
-- READ time from three inputs:
--
--   1. LONG-TERM, gently decayed:  S · R^0.35  (c_display_exp)
--      Not S · R. A word decays for the SCHEDULER on the true curve; for the READER it
--      fades more slowly, because "you are due to look at this" and "you have forgotten
--      this" are different claims. At the exponent 0.35 a mature 40-day word holds 5/5
--      for a fortnight, rather than dropping a bucket in the first week.
--
--   2. SHORT-TERM, fast:  short_stability · 2^(-Δhours / 8)   (c_short_half_life_h)
--      A new per-word strength that ANY successful pass grows, including the ones the
--      schedule freezes. This is what makes cramming visible: 0 → 4 across a session.
--      It half-lives in 8 hours, so it survives a same-evening return and is gone by
--      morning — practice is rewarded and then honestly forgotten. It NEVER touches
--      the schedule, so it cannot re-open the inflation bug.
--
--   3. A FLOOR at 3 once a word has genuinely reached 5/5 (peak_confidence).
--      Without it, a shelf of 5s slowly fading to 0s reads as "the app is losing my
--      progress". The floor makes a stale mature word say "due for a look", not "gone".
--      Peak tracks the LONG-TERM bucket only — you cannot cram your way to a floor.
--
-- ASYMMETRIC EVIDENCE. The freeze already weights a fresh SUCCESS at zero. This makes
-- the other side explicit: a fresh FAILURE — you forgot a word you saw minutes ago —
-- is the strongest single signal the scheduler ever gets, and was being treated the
-- same as forgetting one you last saw in March. It now cuts by an extra ×0.2 AND voids
-- the peak floor. Fail a word right after acing it and it reads 0, as it should.
--
-- WHAT'S STORED vs COMPUTED. `confidence_rating` stays on the row but becomes a
-- WRITE-TIME SNAPSHOT of the displayed value (so record_review's return is what the
-- user just saw, and review_log analysis keeps a stable number). READS no longer trust
-- it: display_confidence() recomputes. Every read surface must use it or the same word
-- reads 4 on one screen and 1 on another — see 20260736 for review_queue, and
-- services/review.ts displayConfidence() for the client-side mirror (the Lists surface
-- reads user_words directly through PostgREST, so the formula lives in both runtimes —
-- KEEP THEM IN SYNC; tests/services/confidence-display.test.ts pins the constants).
-- =========================================================

-- ── The two new per-word display columns ───────────────────────────────────
-- Nullable / defaulted: every existing row keeps working (no short-term strength =
-- the long-term term alone), and peak backfills from the confidence already earned.
ALTER TABLE user_words ADD COLUMN IF NOT EXISTS short_stability    REAL;
ALTER TABLE user_words ADD COLUMN IF NOT EXISTS short_stability_at TIMESTAMPTZ;
ALTER TABLE user_words ADD COLUMN IF NOT EXISTS peak_confidence    SMALLINT NOT NULL DEFAULT 0;

UPDATE user_words
   SET peak_confidence = confidence_rating
 WHERE peak_confidence < confidence_rating;

COMMENT ON COLUMN user_words.short_stability IS
  'Short-term display strength (days). Grown by ANY successful review incl. crammed ones; half-lives in 8h. Display only — never schedules.';
COMMENT ON COLUMN user_words.peak_confidence IS
  'Highest LONG-TERM confidence bucket ever reached. Floors the display at 3 once it hits 5; voided by a fresh failure.';

-- ── display_confidence: the read-time 0–5 the user actually sees ───────────
-- IMMUTABLE because `now` is passed in (callers pass now(); the queue passes its own),
-- so it can be used in indexes/expressions without dragging volatility around.
CREATE OR REPLACE FUNCTION display_confidence(
  p_stability REAL,
  p_last      TIMESTAMPTZ,
  p_origin    TIMESTAMPTZ,
  p_short     REAL,
  p_short_at  TIMESTAMPTZ,
  p_peak      SMALLINT,
  p_now       TIMESTAMPTZ
)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  WITH k AS (
    SELECT
      0.35::REAL AS display_exp,      -- c_display_exp: 1.0 = decay as fast as true recall
      8.0::REAL  AS short_half_life,  -- hours
      3          AS peak_floor,
      -- Δdays since the decay anchor (last review, else when the word was first saved).
      GREATEST(0, EXTRACT(EPOCH FROM (p_now - COALESCE(p_last, p_origin, p_now))) / 86400.0) AS days,
      GREATEST(0, EXTRACT(EPOCH FROM (p_now - p_short_at)) / 3600.0)                         AS hours
  ),
  parts AS (
    SELECT
      -- LONG TERM, gently decayed. exp() on float8 RAISES on underflow (22003) rather
      -- than returning 0 — the same trap 20260732 hit — so clamp before calling it.
      CASE
        WHEN p_stability IS NULL OR p_stability <= 0 THEN 0
        WHEN (SELECT days FROM k) / p_stability >= 700 THEN 0
        ELSE p_stability * power(exp(- (SELECT days FROM k) / p_stability), (SELECT display_exp FROM k))
      END AS long_part,
      -- SHORT TERM, fast. Beyond ~40 half-lives it is numerically nothing; clamp so a
      -- long-abandoned row can't underflow power().
      CASE
        WHEN p_short IS NULL OR p_short <= 0 OR p_short_at IS NULL THEN 0
        WHEN (SELECT hours FROM k) / (SELECT short_half_life FROM k) >= 40 THEN 0
        ELSE p_short * power(0.5, (SELECT hours FROM k) / (SELECT short_half_life FROM k))
      END AS short_part
  )
  SELECT GREATEST(
           confidence_from_stability((SELECT (long_part + short_part)::REAL FROM parts)),
           CASE WHEN COALESCE(p_peak, 0) >= 5 THEN (SELECT peak_floor FROM k) ELSE 0 END
         );
$$;
REVOKE EXECUTE ON FUNCTION display_confidence(REAL, TIMESTAMPTZ, TIMESTAMPTZ, REAL, TIMESTAMPTZ, SMALLINT, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION display_confidence(REAL, TIMESTAMPTZ, TIMESTAMPTZ, REAL, TIMESTAMPTZ, SMALLINT, TIMESTAMPTZ) TO anon, authenticated;

-- ── record_review: write the short-term strength + the asymmetric lapse ────
-- Body swap (supersedes 20260731). The SCHEDULE math is byte-for-byte unchanged —
-- seeds, ease, cram freeze, absolute lapse cap, fuzz. What is new: the short-term
-- strength is written on EVERY pass (including a frozen one, which is the entire point),
-- a fresh failure is amplified, peak_confidence is tracked, and the stored
-- confidence_rating is now the DISPLAY value rather than a raw stability bucket.
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
  v_fresh   BOOLEAN := FALSE;   -- was the word still held when this review happened?
  v_peak    SMALLINT;
  v_lvl     srs_leveling_t;
  c_max_stability   CONSTANT REAL := 3650;
  c_fresh_r         CONSTANT REAL := 0.9;
  c_short_half_life CONSTANT REAL := 8.0;   -- hours; mirrors display_confidence
  -- How hard a FRESH failure cuts, on top of the normal lapse. Forgetting a word you
  -- saw minutes ago is the strongest evidence available; the plain lapse cap alone
  -- left it reading the same as a word you last saw months back.
  c_fresh_lapse_amp CONSTANT REAL := 0.2;
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

    -- CRAM FREEZE (20260729): a successful review of a word still held teaches the
    -- SCHEDULER nothing — neither the strength nor the clock moves. It does teach the
    -- DISPLAY something, so the short-term strength and the snapshot are written here;
    -- that is the whole difference from the previous body.
    IF p_grade >= 3 AND v_fresh THEN
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
