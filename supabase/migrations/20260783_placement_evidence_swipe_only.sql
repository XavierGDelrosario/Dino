-- =========================================================
-- placement_evidence — the SWIPE is the evidence; studying the word afterwards is not.
--
-- 20260770 counted an answer as known if the user swiped know OR the saved word had
-- since reached a long-term confidence of 3, "so a word marked unknown that the user
-- then genuinely learned counts in their favour". That clause re-opened the bias the
-- table was built to remove, from the other side:
--
--   A swipe is one DRAW from a band — its value is what it says about the words that
--   were NOT dealt. But the quiz SAVES every word it deals, a don't-know lands in the
--   review queue, and a few sessions later it sits at confidence 3. So the sampled
--   words get taught and the rest of the band does not, and the sample stops
--   representing the band: every band the user is quizzed in drifts to 100% no matter
--   how much of it they know.
--
-- Measured on prod (2026-10-01, the one account with answers): N2 swiped know 52/105
-- (50%), N1 51/109 (47%) — but the evidence read 96/105 and 87/109, over both bars, so
-- the stored band was N1 for a learner who knew about half of either band. That band
-- feeds the SRS ease (20260731), which was stretching intervals on words "below" them.
--
-- So `known` is the swipe and nothing else; user_words is no longer consulted at all.
--
-- That removes the only way a band could RISE, so the window replaces it: only the
-- NEWEST 40 answers per band count. Progress shows up because the quiz never re-deals
-- a saved word — every new sitting is a fresh draw from what is still unsaved, and it
-- displaces the oldest answers instead of being averaged against them forever (at
-- 52/105, clearing N2's 0.79 bar by accumulation alone needed 147 straight knows).
-- 40 is ~2 sittings (the quiz deals 5 per band per fetch), over twice the largest
-- trust threshold (18), and one miss moves a band by 2.5%. Rows come back oldest →
-- newest. The client folds whatever it is given and appends the current session's
-- swipes on top (services/calibration.levelFromRatings), so a sitting in progress
-- reads slightly smoother than the next load will.
--
-- Same signature and columns as 20260770, so every installed client keeps working and
-- picks the fix up with no release. Stored answers are untouched (nothing is deleted;
-- the window is a read). users.proficiency_band is NOT rewritten here — the placement
-- maths lives in the client — so a stored band corrects itself the next time its owner
-- finishes the quiz.
-- =========================================================

CREATE OR REPLACE FUNCTION placement_evidence(p_source_lang TEXT)
RETURNS TABLE (band INT, frequency INT, known BOOLEAN)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT r.band, r.frequency, r.known
    FROM (
      SELECT w.proficiency_band::INT AS band,
             w.frequency::INT        AS frequency,
             pa.known,
             pa.answered_at,
             pa.word_id,
             row_number() OVER (
               PARTITION BY w.proficiency_band
               ORDER BY pa.answered_at DESC, pa.word_id
             ) AS rn
        FROM placement_answers pa
        JOIN words w ON w.word_id = pa.word_id
       WHERE pa.user_id = (auth.uid())::text
         AND w.source_lang = p_source_lang
    ) r
   WHERE r.rn <= 40
   ORDER BY r.answered_at, r.word_id;
$$;

REVOKE ALL ON FUNCTION placement_evidence(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION placement_evidence(TEXT) TO anon, authenticated;
