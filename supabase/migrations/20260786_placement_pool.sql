-- =========================================================
-- placement_pool — how much of each band's POOL the caller already holds.
--
-- 20260783 made the swipe the only placement evidence, and the quiz only ever deals
-- words that are NOT in the vocabulary. Together those leave a learner who studies
-- through the app permanently stuck: every word they save and learn leaves the quiz
-- pool, so each new sitting samples only the part of the band they have never touched,
-- and their hit rate there stays where it started however much of the band they now
-- know. (Counting learned words as "known swipes" — 20260770 — was wrong the other way:
-- the sample drifted to 100%.)
--
-- The fix weighs both by what they actually are. A band's bar is a share of its POOL:
--
--   pool    N — every word the quiz could ever deal at that band
--   known   K — pool words the caller has saved AND holds (long-term confidence ≥ 3)
--   unsaved U — pool words not in the vocabulary: exactly what the quiz still deals
--
-- and the swipes estimate the rate over U alone, so the band's estimate is
-- (K + rate · U) / N. Knowing 600 of a 1,000-word pool against an 80% bar leaves 200 to
-- find among the 400 unsaved — the swipes need 50%, not 80%. The maths is in the client
-- (services/calibration.levelFromRatings), next to the rest of the placement; this
-- function only supplies the three counts.
--
-- The pool is learn_words_at_band's own — called, not copied, so the two can never
-- disagree about what "the pool" is: p_exclude_seen FALSE is N, TRUE is U, and a limit
-- far above any band's size returns the whole gated set instead of a sample.
--
-- "Holds" is the UN-decayed long-term strength (confidence_from_stability ≥ 3, i.e. a
-- stability of a week or more), not the displayed confidence, which fades on purpose,
-- and not peak_confidence, which never comes back down after a lapse. A quiz "know"
-- swipe seeds stability 40, so it counts; a "don't know" counts once it is learned.
--
-- SECURITY DEFINER because the pool reads the server-only dictionary tables; it takes no
-- user argument and scopes to auth.uid(), and returns counts only.
-- =========================================================

CREATE FUNCTION placement_pool(p_source_lang TEXT, p_target_lang TEXT, p_max_band INT)
RETURNS TABLE (band INT, pool INT, unsaved INT, known INT)
LANGUAGE sql
VOLATILE          -- learn_words_at_band is (it shuffles); the counts themselves are stable
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH held AS MATERIALIZED (
    SELECT DISTINCT lower(uw.input) AS surface
      FROM user_words uw
     WHERE uw.user_id = (auth.uid())::text
       AND uw.source_lang = p_source_lang
       AND confidence_from_stability(uw.stability::REAL) >= 3
  )
  SELECT b.band,
         a.pool,
         (SELECT count(*)::INT
            FROM learn_words_at_band(p_source_lang, p_target_lang, b.band::SMALLINT,
                                     (auth.uid())::text, 1000000, TRUE)) AS unsaved,
         a.known
    FROM generate_series(1, LEAST(GREATEST(p_max_band, 0), 10)) AS b(band)
   CROSS JOIN LATERAL (
          SELECT count(*)::INT AS pool,
                 (count(*) FILTER (WHERE lower(p.headword) IN (SELECT surface FROM held)))::INT AS known
            FROM learn_words_at_band(p_source_lang, p_target_lang, b.band::SMALLINT,
                                     (auth.uid())::text, 1000000, FALSE) p
        ) a
   WHERE auth.uid() IS NOT NULL
   ORDER BY b.band;
$$;

REVOKE ALL ON FUNCTION placement_pool(TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION placement_pool(TEXT, TEXT, INT) TO anon, authenticated;
