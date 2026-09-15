-- =========================================================
-- Placement answers — the calibration quiz's verdicts, kept as their OWN evidence.
--
-- The band used to be computed over the user's WHOLE vocabulary (every user_words row,
-- "known" = the live displayed confidence ≥ 3). That placed real N2/N3 learners at N5,
-- for two reasons the data can't fix on its own:
--
--   1. SELECTION BIAS. A vocabulary is mostly words the user saved BECAUSE they didn't
--      know them — from the reader, articles, the Learn tab. Studying twenty N4 words
--      added twenty shaky N4 words to the N4 tally, so studying a band demoted you
--      below it. The calibration quiz, by contrast, deals words the user did NOT pick,
--      which is the only unbiased sample we have.
--   2. DECAY. The displayed confidence fades on purpose (it answers "due for a look?"),
--      so a word graded 3 last week read as "unknown" to the placement today.
--
-- So each swipe is recorded here, and the placement reads ONLY these rows. A word's
-- evidence is "known" if the user swiped know OR the saved word has since reached a
-- long-term confidence of 3 (peak_confidence — it never decays, and cramming can't buy
-- it), so a word marked unknown that the user then genuinely learned counts in their
-- favour. Nothing else about the vocabulary is consulted.
--
-- Storage is bounded by the dictionary, not by behaviour: one row per (user, sense),
-- and the quiz never re-deals a word already in the vocabulary. Deleting the user
-- cascades; deleting a cache row cascades too (the evidence is about that sense).
-- =========================================================

CREATE TABLE IF NOT EXISTS placement_answers (
  user_id     TEXT        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  word_id     UUID        NOT NULL REFERENCES words(word_id) ON DELETE CASCADE,
  known       BOOLEAN     NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One verdict per sense; a later swipe on the same word replaces it (upsert).
  PRIMARY KEY (user_id, word_id)
);

ALTER TABLE placement_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_select_own_placement_answers" ON placement_answers;
DROP POLICY IF EXISTS "user_manage_own_placement_answers" ON placement_answers;
CREATE POLICY "user_select_own_placement_answers"
ON placement_answers FOR SELECT USING (user_id = (auth.uid())::text);
CREATE POLICY "user_manage_own_placement_answers"
ON placement_answers FOR ALL
USING (user_id = (auth.uid())::text)
WITH CHECK (user_id = (auth.uid())::text);

GRANT SELECT, INSERT, UPDATE, DELETE ON placement_answers TO anon, authenticated;

-- ── placement_evidence: the rows levelFromRatings folds, in one round trip ──
-- SECURITY INVOKER: RLS on placement_answers / user_words / words does the scoping.
-- `band` / `frequency` come from the CURRENT cache row, so a re-ingested band list
-- re-places the user without rewriting their answers.
CREATE OR REPLACE FUNCTION placement_evidence(p_source_lang TEXT)
RETURNS TABLE (band INT, frequency INT, known BOOLEAN)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT w.proficiency_band::INT,
         w.frequency::INT,
         (pa.known OR COALESCE(uw.peak_confidence, 0) >= 3) AS known
    FROM placement_answers pa
    JOIN words w ON w.word_id = pa.word_id
    LEFT JOIN user_words uw
           ON uw.user_id = pa.user_id AND uw.dictionary_word_id = pa.word_id
   WHERE pa.user_id = (auth.uid())::text
     AND w.source_lang = p_source_lang;
$$;

REVOKE ALL ON FUNCTION placement_evidence(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION placement_evidence(TEXT) TO anon, authenticated;
