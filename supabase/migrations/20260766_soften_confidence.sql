-- =========================================================
-- soften_confidence() — the reader's "Forgot" button, ONE notch down.
--
-- WHAT IT IS FOR. The word popup already tells you what you know (✓ n/5), but until
-- now the only way to say "actually, I don't" was to meet the word in a quiz. This is
-- the affordance for the moment you actually have the thought: you are reading, you hit
-- a word the app claims you know 5/5, and you don't. One press drops it a notch and
-- pulls the next review in.
--
-- ‼️ WHY THIS IS NOT record_review(grade => 1 or 2). A lapse is a graded answer to a
-- CARD, and its whole job is to be decisive: the absolute cap cuts a mature word to
-- ≤ 2 days, so a 5/5 word lands at 1/5 or 0/5. That is right for "I was quizzed and
-- missed it" and wrong for "I glanced at this in a paragraph and felt shaky" — one
-- honest twinge should not erase a month of scheduling. So this is its OWN verb:
-- exactly one bucket, nothing more.
--
-- ‼️ AND IT WRITES NO review_log ROW. review_log is the FSRS training set — one row per
-- card per day answering "what grade did the user give". This is not a graded review:
-- the user was never shown the answer and never recalled or failed to recall it under
-- test conditions. Logging it as a grade would teach a future fit something that never
-- happened. The schedule change is still visible in user_words (stability drops), it
-- just isn't claimed as evidence.
--
-- CONFIDENCE IS DERIVED, so "minus one" is expressed in the only currency the display
-- reads: memory strength. display_confidence buckets an effective strength in days
-- (confidence_from_stability: <1 · <3 · <7 · <16 · <35 · else), and at the moment of
-- the write the elapsed time is zero, so the long-term part IS the stability. Setting
-- stability into the band below therefore lands exactly one bucket lower — no new
-- column, no stored override, and the SRS stays the single source of truth
-- (20260735: "confidence is not the schedule", and this changes both).
--
-- THREE GUARDS, because this is a one-press destructive-ish action on a touch surface:
--   1. FLOOR — no-op below MIN_CONFIDENCE (3). It mirrors the button's own visibility
--      rule, so a stale client that still shows the button cannot walk a word to 0.
--   2. DEDUPE — no-op if this word had ANY review-like write in the last 2 seconds.
--      That is the double-tap guard: the second tap of a fat-fingered double returns
--      the same row rather than dropping a second notch. The client also holds the
--      button in a "done" state for longer than this window, so a user who genuinely
--      wants two notches simply presses again once they have SEEN the first result.
--   3. NEVER STRENGTHENS — the new stability is LEAST(current, band top). A word whose
--      3/5 comes from a cram session (small long-term stability + a big short-term
--      bounce) must not have its long-term strength RAISED to the top of the 2/5 band
--      by an action that means "I forgot this". In that case the drop is more than one
--      notch, because the long term never supported the number in the first place —
--      which is why the function returns the row and the UI shows what actually
--      happened rather than assuming current − 1.
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

  v_cur := display_confidence(w.stability, w.last_reviewed_date, w.originally_translated_date,
                              w.short_stability, w.short_stability_at,
                              COALESCE(w.peak_confidence, 0), v_now);

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
  v_peak := LEAST(COALESCE(w.peak_confidence, 0), 4);

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

-- Client-callable: it takes no user id and authorizes itself against auth.uid(), so the
-- caller can only ever soften their own word (same contract as record_review).
REVOKE EXECUTE ON FUNCTION soften_confidence(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION soften_confidence(UUID) TO anon, authenticated;

COMMENT ON FUNCTION soften_confidence(UUID) IS
  'Reader "Forgot": drop one displayed-confidence bucket (never below what the long-term '
  'strength supports), pull the next review in, and write NO review_log row — this is a '
  'self-report, not a graded review. No-op below 3/5 or within 2s of the last review.';
