-- =========================================================
-- Estimated levels: a gap fill for words the JLPT list doesn't carry.
--
-- The curated band (Waller's JLPT lists, data/proficiency) covers ~8k words; every other
-- saved word read "Unranked". This estimates a band for those FROM FREQUENCY ALONE, and
-- only where the estimate is defensible. It never overrides a curated band.
--
-- THE RULE (measured 2026-09-28 on the 7,085 levelled content words, 5-fold CV):
--   · bin the headword's frequency (Zipf ×100) in half-Zipf steps, Zipf 6.0+ pooled;
--   · in each bin, take the EASIEST band that at least 25% of the bin's levelled words
--     sit at or below (the "medium tilt": a word shown too HARD is a test surprise, the
--     costlier error, so the estimate leans easy);
--   · FLOOR AT N3: an estimate is never N5/N4. Unranked words are almost never basic —
--     20 of 12,723 (0.16%) are among NINJAL's expert "first 2,000" — so the floor costs
--     nothing there, and it keeps estimates from flooding the levels beginners study;
--   · CUTOFF below Zipf 3.0 (and bins with < 20 levelled words): no estimate. Rarer
--     words are mostly beyond the JLPT, and "N2" would tell a learner to know them.
-- Scored on true N3–N1 words: 41% exact, 3.5% shown one level too hard, 0% two or more.
-- N1 is never reached — frequency can't separate N2 from N1 (their medians sit 0.02 Zipf
-- apart). See docs/research/Level_Estimate_Gap_Fill.md.
--
-- Like the leveling profile (20260731) it is MEASURED reference data, re-measured by
-- `npm run build:leveling -- JA` after any re-ingest, and nothing is stored per word:
-- estimated_band() is read at query time, so a re-measure applies retroactively.
-- Only JA has a source today; any other language gets NULL (Unranked, as before).
-- =========================================================

CREATE TABLE IF NOT EXISTS language_level_estimate (
  language    TEXT     NOT NULL,
  freq_bin    SMALLINT NOT NULL,   -- LEAST(frequency / 50, 12): half-Zipf steps, top bin = Zipf 6.0+
  band        SMALLINT NOT NULL,   -- 1 = easiest; floored at 3 by construction
  support     INT      NOT NULL,   -- levelled words the bin was measured from
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (language, freq_bin)
);

-- Server-only reference data, like language_leveling: clients read it through
-- estimated_band() and nothing else.
ALTER TABLE language_level_estimate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON language_level_estimate FROM PUBLIC, anon, authenticated;

-- (Re)measure one language. Replaces that language's rows; returns how many bins it wrote.
CREATE OR REPLACE FUNCTION measure_level_estimate(p_lang TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_bin_width CONSTANT INT  := 50;    -- half a Zipf
  c_top_bin   CONSTANT INT  := 12;    -- Zipf 6.0+ pooled (too few levelled words above to measure apart)
  c_tilt      CONSTANT REAL := 0.25;  -- share that must sit at or below the chosen band
  c_floor     CONSTANT INT  := 3;     -- never N5/N4
  c_min_bin   CONSTANT INT  := 6;     -- Zipf 3.0 cutoff
  c_support   CONSTANT INT  := 20;    -- too few levelled words → no estimate
  v_written   INT;
BEGIN
  DELETE FROM language_level_estimate WHERE language = p_lang;
  IF p_lang <> 'JA' THEN
    RETURN 0;                         -- no measured source for this language yet
  END IF;

  -- The shown headword's frequency and band, exactly what a projected `words` row
  -- carries; grammar / affixes / interjections / names are not vocabulary to level.
  WITH train AS (
    SELECT LEAST(h.frequency / c_bin_width, c_top_bin) AS bin, h.proficiency_band AS band
      FROM jmdict_entry_headword_mv h
     WHERE h.proficiency_band BETWEEN 1 AND 5
       AND h.frequency IS NOT NULL
       AND NOT not_leveled_vocab(h.part_of_speech, h.entry_id)
  ),
  per AS (
    SELECT bin, band, count(*) AS n FROM train GROUP BY bin, band
  ),
  cum AS (
    SELECT bin, band,
           sum(n) OVER (PARTITION BY bin ORDER BY band) AS at_or_below,
           sum(n) OVER (PARTITION BY bin)               AS total
      FROM per
  ),
  pick AS (
    SELECT DISTINCT ON (bin) bin, band, total
      FROM cum WHERE at_or_below >= c_tilt * total
     ORDER BY bin, band
  )
  INSERT INTO language_level_estimate (language, freq_bin, band, support)
  SELECT p_lang, bin, GREATEST(band, c_floor), total
    FROM pick
   WHERE bin >= c_min_bin AND total >= c_support;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END;
$$;

REVOKE EXECUTE ON FUNCTION measure_level_estimate(TEXT) FROM PUBLIC, anon, authenticated;

-- The estimate for one word, or NULL (below the cutoff, no frequency, unmeasured language).
CREATE OR REPLACE FUNCTION estimated_band(p_lang TEXT, p_frequency INT)
RETURNS SMALLINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- The IS NOT NULL is load-bearing: LEAST() skips NULLs, so LEAST(NULL / 50, 12) is 12
  -- and a word with no frequency (a custom word, an MT row) would land in the top bin.
  SELECT e.band FROM language_level_estimate e
   WHERE p_frequency IS NOT NULL
     AND e.language = p_lang AND e.freq_bin = LEAST(p_frequency / 50, 12);
$$;

REVOKE EXECUTE ON FUNCTION estimated_band(TEXT, INT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION estimated_band(TEXT, INT) TO authenticated;

-- ── History reads the estimate where the curated band is missing ───────────────
-- Bodies as 20260776, with ONE change each: a word's level is its curated band, else
-- its estimate. Grammar / affixes / interjections / names still leave Unranked
-- (skip_level keys on the CURATED band being NULL, so an estimate never rescues them).

CREATE OR REPLACE FUNCTION snapshot_confidence_daily(
  p_day DATE DEFAULT ((now() AT TIME ZONE 'UTC')::date - 1)
)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT (p_day::timestamp AT TIME ZONE 'UTC')       AS t0,
           ((p_day + 1)::timestamp AT TIME ZONE 'UTC') AS t1
  ),
  active AS (
    SELECT uw.user_id FROM user_words uw, bounds b
     WHERE uw.originally_translated_date >= b.t0 AND uw.originally_translated_date < b.t1
    UNION
    SELECT uw.user_id FROM user_words uw, bounds b
     WHERE uw.short_stability_at >= b.t0 AND uw.short_stability_at < b.t1
    UNION
    SELECT r.user_id FROM review_log r WHERE r.reviewed_on = p_day
  ),
  scored AS (
    SELECT uw.user_id,
           uw.source_lang,
           COALESCE(w.proficiency_band, estimated_band(uw.source_lang, w.frequency), 0) AS slot,
           (w.proficiency_band IS NULL
              AND not_leveled_vocab(w.part_of_speech, w.jmdict_entry_id)) AS skip_level,
           display_confidence(
             uw.stability, uw.last_reviewed_date, uw.originally_translated_date,
             uw.short_stability, uw.short_stability_at, uw.peak_confidence, b.t1
           ) AS conf
      FROM active a
      JOIN user_words uw ON uw.user_id = a.user_id
      LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
      CROSS JOIN bounds b
     WHERE uw.originally_translated_date < b.t1   -- only words that existed that day
  ),
  lang AS (
    SELECT s.user_id, mode() WITHIN GROUP (ORDER BY s.source_lang) AS main_lang
      FROM scored s GROUP BY s.user_id
  ),
  tot AS (
    SELECT s.user_id, count(*)::int AS n, avg(s.conf)::real AS c
      FROM scored s GROUP BY s.user_id
  ),
  per_band AS (
    SELECT s.user_id, s.slot, count(*)::int AS n, avg(s.conf)::real AS c
      FROM scored s JOIN lang l ON l.user_id = s.user_id
     WHERE s.source_lang = l.main_lang AND NOT s.skip_level
     GROUP BY s.user_id, s.slot
  ),
  arrs AS (
    SELECT m.user_id,
           array_agg(COALESCE(pb.n, 0) ORDER BY g) AS band_n,
           array_agg(pb.c ORDER BY g)              AS band_conf
      FROM (SELECT user_id, max(slot) AS mx FROM per_band GROUP BY user_id) m
      CROSS JOIN LATERAL generate_series(0, m.mx) g
      LEFT JOIN per_band pb ON pb.user_id = m.user_id AND pb.slot = g
     GROUP BY m.user_id
  ),
  ins AS (
    INSERT INTO user_confidence_daily
           (user_id, day, word_count, avg_conf, main_lang, band_n, band_conf)
    SELECT t.user_id, p_day, t.n, t.c, l.main_lang,
           COALESCE(a.band_n, '{}'), COALESCE(a.band_conf, '{}')
      FROM tot t
      JOIN lang l USING (user_id)
      LEFT JOIN arrs a USING (user_id)
    ON CONFLICT (user_id, day) DO UPDATE
       SET word_count = EXCLUDED.word_count,
           avg_conf   = EXCLUDED.avg_conf,
           main_lang  = EXCLUDED.main_lang,
           band_n     = EXCLUDED.band_n,
           band_conf  = EXCLUDED.band_conf
    RETURNING 1
  )
  SELECT count(*)::int FROM ins;
$$;

REVOKE EXECUTE ON FUNCTION snapshot_confidence_daily(DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION profile_history(p_tz TEXT DEFAULT 'UTC')
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH zone AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
                THEN p_tz ELSE 'UTC' END AS z
  ),
  mine AS (
    SELECT uw.user_word_id, uw.originally_translated_date, uw.source_lang,
           COALESCE(w.proficiency_band, estimated_band(uw.source_lang, w.frequency)) AS proficiency_band,
           (w.proficiency_band IS NULL
              AND not_leveled_vocab(w.part_of_speech, w.jmdict_entry_id)) AS skip_level,
           display_confidence(
             uw.stability, uw.last_reviewed_date, uw.originally_translated_date,
             uw.short_stability, uw.short_stability_at, uw.peak_confidence, now()
           ) AS conf
      FROM user_words uw
      LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
     WHERE uw.user_id = (auth.uid())::text
  ),
  adds AS (
    SELECT (m.originally_translated_date AT TIME ZONE zone.z)::date AS d, count(*) AS n
      FROM mine m CROSS JOIN zone GROUP BY 1
  ),
  revs AS (
    SELECT (r.reviewed_at AT TIME ZONE zone.z)::date AS d,
           count(*) AS cards, sum(r.repeats) AS reviews
      FROM mine m
      JOIN review_log r ON r.user_word_id = m.user_word_id
      CROSS JOIN zone
     GROUP BY 1
  ),
  days AS (
    SELECT COALESCE(a.d, r.d) AS d,
           COALESCE(a.n, 0) AS added,
           COALESCE(r.cards, 0) AS reviewed,
           COALESCE(r.reviews, 0) AS reviews
      FROM adds a FULL JOIN revs r ON r.d = a.d
  ),
  lang AS (
    SELECT mode() WITHIN GROUP (ORDER BY m.source_lang) AS l FROM mine m
  ),
  bands AS (
    SELECT COALESCE(m.proficiency_band, -1) AS band, count(*) AS n,
           avg(m.conf)::real AS avg_conf
      FROM mine m CROSS JOIN lang
     WHERE m.source_lang = lang.l AND NOT m.skip_level
     GROUP BY 1
  )
  SELECT jsonb_build_object(
    'main_lang', (SELECT l FROM lang),
    'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'day', d, 'added', added, 'reviewed', reviewed, 'reviews', reviews)
                        ORDER BY d) FROM days), '[]'::jsonb),
    'bands', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'band', band, 'n', n, 'avg_conf', avg_conf)
                         ORDER BY band) FROM bands), '[]'::jsonb),
    'confidence', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'day', c.day, 'word_count', c.word_count,
                              'avg_conf', c.avg_conf, 'main_lang', c.main_lang,
                              'band_n', c.band_n, 'band_conf', c.band_conf)
                              ORDER BY c.day)
                              FROM user_confidence_daily c
                             WHERE c.user_id = (auth.uid())::text), '[]'::jsonb)
  );
$$;

REVOKE EXECUTE ON FUNCTION profile_history(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION profile_history(TEXT) TO authenticated;

-- Measure now (a no-op returning 0 on a database with no JMdict loaded yet).
SELECT measure_level_estimate('JA');
