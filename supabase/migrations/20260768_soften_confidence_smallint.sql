-- =========================================================
-- FIX: soften_confidence() raised 42883 on EVERY call — the "Forgot" control was
-- dead on both surfaces that offer it (the Lists row's confidence dots and the
-- reader's hovercard), surfacing as "Something went wrong. Please try again."
--
-- 20260766 passed the peak as COALESCE(w.peak_confidence, 0). peak_confidence is
-- SMALLINT but the literal 0 is INTEGER, and COALESCE resolves to the common type —
-- INTEGER. display_confidence's 6th parameter is SMALLINT, and int4 → int2 is an
-- ASSIGNMENT cast, not an implicit one, so function resolution found no candidate:
--   function display_confidence(real, timestamptz, timestamptz, real, timestamptz,
--                               integer, timestamptz) does not exist
-- A plpgsql body is not resolved at CREATE FUNCTION time, so 20260766 applied clean
-- everywhere and only failed when a user pressed the button.
--
-- The COALESCE was redundant to begin with: peak_confidence is NOT NULL DEFAULT 0
-- (20260735). It is dropped rather than cast, which is also how every OTHER
-- display_confidence call site passes the peak — a bare SMALLINT column or local.
-- Nothing else about the function changes.
-- =========================================================

CREATE OR REPLACE FUNCTION soften_confidence(p_user_word_id UUID)
RETURNS user_words
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w        user_words;
  v_now    TIMESTAMPTZ := now();
  v_cur    INT;
  v_target INT;
  v_cap    REAL;   -- top of the target bucket's band
  v_new_s  REAL;
  v_peak   SMALLINT;
  c_min_confidence CONSTANT INT      := 3;
  c_dedupe         CONSTANT INTERVAL := INTERVAL '2 seconds';
BEGIN
  -- SECURITY DEFINER bypasses RLS, so the ownership test is explicit — same shape as
  -- record_review.
  SELECT * INTO w FROM user_words
   WHERE user_word_id = p_user_word_id
     AND user_id = (auth.uid())::text
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_word % not found', p_user_word_id;
  END IF;

  -- Guard 2: a double-tap (or a soften landing on top of a just-graded review) is the
  -- same intent arriving twice. Return the row untouched — the caller cannot tell the
  -- difference from a successful no-op, which is the point of idempotency.
  IF w.last_reviewed_date IS NOT NULL AND w.last_reviewed_date > v_now - c_dedupe THEN
    RETURN w;
  END IF;

  -- peak_confidence is NOT NULL SMALLINT: passed bare, so the argument types match
  -- display_confidence exactly (see this migration's header).
  v_cur := display_confidence(w.stability, w.last_reviewed_date, w.originally_translated_date,
                              w.short_stability, w.short_stability_at,
                              w.peak_confidence, v_now);

  -- Guard 1: nothing to soften. Not an error — the button may simply be stale.
  IF v_cur < c_min_confidence THEN
    RETURN w;
  END IF;

  v_target := v_cur - 1;
  -- The top of the target band, a hair inside it (confidence_from_stability's cuts are
  -- 1 / 3 / 7 / 16 / 35), so float noise can never round back up into the band above.
  v_cap := CASE v_target
             WHEN 0 THEN 0.9
             WHEN 1 THEN 2.5
             WHEN 2 THEN 6.0
             WHEN 3 THEN 15.0
             ELSE        34.0
           END;

  -- Guard 3: only ever downward.
  v_new_s := LEAST(COALESCE(w.stability, v_cap), v_cap);

  -- Void the peak FLOOR the way a fresh lapse does (20260735) — otherwise a word that
  -- once hit 5/5 can never be softened below 3/5 and the button would look broken at
  -- exactly the confidence it is offered from. Capped at 4, not at the target: this is
  -- one notch of doubt, not a claim that the word was never learned.
  v_peak := LEAST(w.peak_confidence, 4);

  UPDATE user_words
     SET stability          = v_new_s,
         last_reviewed_date = v_now,
         -- The short-term bounce is exactly the "I just crammed this" signal the user
         -- is disowning, so it goes.
         short_stability    = 0,
         short_stability_at = v_now,
         peak_confidence    = v_peak,
         confidence_rating  = display_confidence(v_new_s, v_now, w.originally_translated_date,
                                                 0, v_now, v_peak, v_now)
   WHERE user_word_id = p_user_word_id
   RETURNING * INTO w;

  RETURN w;
END;
$$;

REVOKE EXECUTE ON FUNCTION soften_confidence(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION soften_confidence(UUID) TO anon, authenticated;

COMMENT ON FUNCTION soften_confidence(UUID) IS
  'Reader "Forgot": drop one displayed-confidence bucket (never below what the long-term '
  'strength supports), pull the next review in, and write NO review_log row — this is a '
  'self-report, not a graded review. No-op below 3/5 or within 2s of the last review.';
