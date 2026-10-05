-- =========================================================
-- placement_pool, made cheap: the pool's word list is STORED, not recomputed per call.
--
-- 20260786 counted each band's pool by calling learn_words_at_band twice per band.
-- Measured on staging (full dictionary, a guest with an empty vocabulary): 8.2 s for
-- JA→EN and 5.3 s for EN→JA — at the 8 s statement limit an authenticated call gets, and
-- the quiz waits on it to open. The client degrades to the swipe-only rule on a timeout,
-- so it would have failed safe, and silently never worked.
--
-- The pool is the same for everyone and changes only when the dictionary data or the
-- pool rules do, so its membership is measured reference data, like the leveling
-- profile (20260731): placement_pool_words holds one row per (pair, band, surface), and
-- the per-user half is a join against the caller's own vocabulary.
--
-- ⚠️ RE-RUN `SELECT refresh_placement_pool();` after any re-ingest (dictionary,
-- frequency, proficiency) and after any migration that changes learn_words_at_band's
-- rules. This migration runs it once, so a database that already has its data is
-- populated here; a fresh one (CI, local) is empty until its ingests run and it is
-- called. An unpopulated pair reads as pool 0, which the client treats as "no counts".
--
-- One deliberate simplification: "saved" is matched by SURFACE only. The quiz also
-- excludes a word the user owns under the same JMdict entry but a different writing;
-- those few read here as unsaved. The surface is what the pool returns and what
-- user_words stores, and the entry id is not something learn_words_at_band exposes.
-- =========================================================

CREATE TABLE placement_pool_words (
  source_lang TEXT     NOT NULL,
  target_lang TEXT     NOT NULL,
  band        SMALLINT NOT NULL,
  surface     TEXT     NOT NULL,   -- lower-cased headword, as learn_words_at_band deals it
  PRIMARY KEY (source_lang, target_lang, band, surface)
);

-- Server-only, like the dictionary tables it is derived from: no policies, no grants.
ALTER TABLE placement_pool_words ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON placement_pool_words FROM PUBLIC, anon, authenticated;

-- Rebuild the stored pool from learn_words_at_band (p_exclude_seen FALSE and a limit
-- far above any band's size = the whole gated set, for nobody in particular). Both
-- pairs the pool function serves; a band past a framework's last is simply empty.
CREATE FUNCTION refresh_placement_pool()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n INT;
BEGIN
  DELETE FROM placement_pool_words WHERE TRUE;  -- WHERE: the API roles refuse a bare DELETE
  INSERT INTO placement_pool_words (source_lang, target_lang, band, surface)
  SELECT DISTINCT pr.s, pr.t, b.band::SMALLINT, lower(p.headword)
    FROM (VALUES ('JA', 'EN'), ('EN', 'JA')) AS pr(s, t)
   CROSS JOIN generate_series(1, 10) AS b(band)
   CROSS JOIN LATERAL learn_words_at_band(pr.s, pr.t, b.band::SMALLINT, '', 1000000, FALSE) p;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION refresh_placement_pool() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION refresh_placement_pool() TO service_role;

SELECT refresh_placement_pool();

-- Same signature and columns as 20260786, so the client needs no change.
CREATE OR REPLACE FUNCTION placement_pool(p_source_lang TEXT, p_target_lang TEXT, p_max_band INT)
RETURNS TABLE (band INT, pool INT, unsaved INT, known INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH mine AS MATERIALIZED (
    SELECT lower(uw.input) AS surface,
           bool_or(confidence_from_stability(uw.stability::REAL) >= 3) AS held
      FROM user_words uw
     WHERE uw.user_id = (auth.uid())::text
       AND uw.source_lang = p_source_lang
     GROUP BY 1
  )
  SELECT b.band::INT,
         count(w.surface)::INT                          AS pool,
         (count(w.surface) - count(m.surface))::INT     AS unsaved,
         (count(*) FILTER (WHERE m.held))::INT          AS known
    FROM generate_series(1, LEAST(GREATEST(p_max_band, 0), 10)) AS b(band)
    LEFT JOIN placement_pool_words w
           ON w.source_lang = p_source_lang
          AND w.target_lang = p_target_lang
          AND w.band = b.band
    LEFT JOIN mine m ON m.surface = w.surface
   WHERE auth.uid() IS NOT NULL
   GROUP BY b.band
   ORDER BY b.band;
$$;
