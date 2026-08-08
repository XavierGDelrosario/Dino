-- ============================================================================
-- record_review: accept the instant a review actually happened (offline replay).
--
-- WHY. A review graded with no network is queued on the device and replayed on
-- reconnect. Stamped at replay time, a Monday review synced on Friday records four
-- extra days of `elapsed_days` — so the scheduler concludes the user held the word for
-- far longer than they did, and hands back an interval to match. The stamp has to be
-- the moment the grade was GIVEN.
--
-- WHY THIS IS SAFE. `now()` on the server exists precisely so review history cannot be
-- forged: review_log is the FSRS training set. Letting a client name the time gives
-- some of that back, so the value is CLAMPED to a window in which nothing can be
-- fabricated:
--
--   · never in the FUTURE      — you cannot claim to have waited longer than you have;
--   · never before the card's  — time cannot run backwards for a card, which is what a
--     last_reviewed_date         wrong or tampered device clock would otherwise do.
--
-- Inside that window the worst a bad value can do is collapse toward "just now" or "no
-- time passed" — both same-day no-ops the 20260744 compaction already absorbs. It
-- cannot manufacture a long interval, which is the property that matters.
--
-- The client side never reads the wall clock either: services/offline/clock.ts derives
-- the instant from a SERVER timestamp captured while online plus a MONOTONIC delta, so
-- changing the device clock mid-session cannot move it (performance.now() does not jump
-- when the system clock is set).
--
-- SIGNATURE CHANGE. p_reviewed_at cannot be added as an overload: a 3-arg function with
-- a DEFAULT makes every existing 2-arg call ambiguous. So the 2-arg form is dropped and
-- replaced, and the grants — which a DROP discards — are re-applied at the bottom.
-- Defaulting to NULL keeps every existing caller (useReview, the integration suite)
-- byte-for-byte unchanged in behaviour.
--
-- The body below is 20260744's, verbatim, except for the v_now derivation.
-- ============================================================================

-- ── The clock anchor ────────────────────────────────────────────────────────
-- The device clock cannot be trusted to timestamp an offline review, so the client
-- anchors to a SERVER instant captured while online and measures forward from it with
-- a monotonic clock. This is that instant.
--
-- Deliberately trivial and STABLE: it reads no rows, so it needs no RLS consideration
-- and leaks nothing — the wall-clock time is already in every HTTP Date header.
CREATE OR REPLACE FUNCTION server_now()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$ SELECT now() $$;

REVOKE EXECUTE ON FUNCTION server_now() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION server_now() TO anon, authenticated;

COMMENT ON FUNCTION server_now() IS
  'The server clock, for anchoring offline review timestamps (see 20260757).';

DROP FUNCTION IF EXISTS record_review(UUID, INT);

CREATE OR REPLACE FUNCTION record_review(
  p_user_word_id UUID,
  p_grade        INT,
  p_reviewed_at  TIMESTAMPTZ DEFAULT NULL   -- NULL = now(); an offline replay names its moment
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

-- Re-apply what the DROP discarded (20260613 set this for the 2-arg form).
REVOKE EXECUTE ON FUNCTION record_review(UUID, INT, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION record_review(UUID, INT, TIMESTAMPTZ) TO anon, authenticated;

COMMENT ON FUNCTION record_review(UUID, INT, TIMESTAMPTZ) IS
  'Records one review. p_reviewed_at names the instant it happened (offline replay); '
  'NULL means now(). Clamped to [last_reviewed_date, now()] so a client clock cannot '
  'fabricate an interval — see migration 20260757.';
