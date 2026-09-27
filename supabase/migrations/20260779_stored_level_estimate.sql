-- =========================================================
-- The level estimate becomes a STORED, one-time calculation.
--
-- 20260777/78 computed the estimate at read time from frequency alone (a bin table the
-- client mirrored). Measured on the full JMdict, frequency can't separate an N1 kanji
-- compound from an N3 one at the same Zipf — but word SHAPE and membership of NINJAL's
-- teaching vocabulary lists can (off-list compounds at Zipf 3.5–5.0: 63% N1). That
-- signal needs per-word data, so instead of storing the list we store the RESULT:
--
--   · jmdict_kanji / jmdict_kana.estimated_band — written by
--     `npm run apply:level-estimates` (scripts/apply-level-estimates.ts; the rule is
--     scripts/lib/levelEstimate.ts). Re-run it after any re-ingest.
--   · words.estimated_band — the cached word's copy, derived exactly like its curated
--     band (the shown writing's value, else the entry's kanji value) and kept current by
--     a trigger, so rows the edge caches later get it with no edge change.
--
-- The SOURCE stays separate: proficiency_band is still curated-only; an estimate is only
-- ever set where the curated band is NULL. Every surface reads COALESCE(curated, estimate).
-- Rationale + numbers: docs/research/Level_Estimate_Gap_Fill.md.
--
-- The read-time pieces (language_level_estimate, estimated_band(), level_estimate_bins())
-- are left in place, unused by current code, so an older installed client that still
-- calls level_estimate_bins() at startup keeps working. Drop them once those are gone.
-- =========================================================

ALTER TABLE jmdict_kanji ADD COLUMN IF NOT EXISTS estimated_band SMALLINT;
ALTER TABLE jmdict_kana  ADD COLUMN IF NOT EXISTS estimated_band SMALLINT;
ALTER TABLE words        ADD COLUMN IF NOT EXISTS estimated_band SMALLINT;

-- A cached word's estimate: the same derivation as its curated band (apply-proficiency /
-- jmdict_lookup) — the shown writing's own value, else the entry's kanji value.
CREATE OR REPLACE FUNCTION words_level_estimate(p_entry_id TEXT, p_input TEXT)
RETURNS SMALLINT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT kj.estimated_band FROM jmdict_kanji kj
      WHERE kj.entry_id = p_entry_id AND kj.text = p_input LIMIT 1),
    (SELECT k.estimated_band FROM jmdict_kana k
      WHERE k.entry_id = p_entry_id AND k.text = p_input LIMIT 1),
    (SELECT kj.estimated_band FROM jmdict_kanji kj
      WHERE kj.entry_id = p_entry_id AND kj.estimated_band IS NOT NULL
      ORDER BY kj.common DESC, kj.position ASC LIMIT 1)
  );
$$;
REVOKE ALL ON FUNCTION words_level_estimate(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION words_level_estimate(TEXT, TEXT) TO service_role;

-- Keep a cached word's estimate current as the edge writes it. Only JA→EN rows with no
-- curated band carry one. Fires on the columns it depends on, not on estimated_band
-- itself, so the backfill script can set that column without re-deriving it.
CREATE OR REPLACE FUNCTION words_set_estimated_band()
RETURNS TRIGGER
LANGUAGE plpgsql
-- DEFINER: the edge writes `words` as service_role, and a trigger that failed on a
-- permission would fail the cache write itself — the one thing this must never do.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.estimated_band := CASE
    WHEN NEW.source_lang = 'JA' AND NEW.proficiency_band IS NULL AND NEW.jmdict_entry_id IS NOT NULL
    THEN words_level_estimate(NEW.jmdict_entry_id, NEW.input)
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS words_estimated_band ON words;
CREATE TRIGGER words_estimated_band
  BEFORE INSERT OR UPDATE OF input, jmdict_entry_id, proficiency_band, source_lang ON words
  FOR EACH ROW EXECUTE FUNCTION words_set_estimated_band();

-- ── Every level surface reads the stored value ────────────────────────────────
-- Bodies as 20260777 / 20260778, with the read-time estimated_band() swapped for the
-- stored w.estimated_band.

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
           COALESCE(w.proficiency_band, w.estimated_band, 0) AS slot,
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
           COALESCE(w.proficiency_band, w.estimated_band) AS proficiency_band,
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

CREATE OR REPLACE FUNCTION list_overview(p_freq_bins INT[] DEFAULT NULL)
RETURNS TABLE (
  list_id            UUID,
  list_name          TEXT,
  created_at         TIMESTAMPTZ,
  last_word_added_at TIMESTAMPTZ,
  word_count         BIGINT,
  confidence         INT[],
  -- {"-1": n, "0": n, …} — -1 unranked, then width_bucket over p_freq_bins ASCENDING.
  freq_counts        JSONB,
  -- {"-1": n, "1": n, …} — -1 unranked, then the raw proficiency_band ordinal.
  band_counts        JSONB,
  -- The scope's dominant source language; picks the ruler the Difficulty bar uses.
  main_lang          TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH scored AS (
    SELECT uw.user_word_id,
           uw.originally_translated_date,
           uw.source_lang,
           w.frequency,
           -- The curated band, else the STORED estimate (never set for grammar / affixes /
           -- interjections / names — apply-level-estimates skips them).
           COALESCE(w.proficiency_band, w.estimated_band) AS proficiency_band,
           display_confidence(
             uw.stability, uw.last_reviewed_date, uw.originally_translated_date,
             uw.short_stability, uw.short_stability_at, uw.peak_confidence, now()
           ) AS conf
      FROM user_words uw
      -- LEFT: a standalone created word has no dictionary row, and must still count.
      LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
     WHERE uw.user_id = (auth.uid())::text
  ),
  -- One row per (scope, word). scope NULL = ALL, which is why every join below uses
  -- IS NOT DISTINCT FROM: a plain `=` never matches the ALL scope against itself.
  scoped AS (
    SELECT NULL::UUID AS scope, s.* FROM scored s
    UNION ALL
    SELECT lw.list_id, s.* FROM list_words lw JOIN scored s USING (user_word_id)
  ),
  lang AS (
    SELECT sc.scope, mode() WITHIN GROUP (ORDER BY sc.source_lang) AS main_lang
      FROM scoped sc GROUP BY sc.scope
  ),
  agg AS (
    SELECT sc.scope,
           count(*) AS word_count,
           max(sc.originally_translated_date) AS last_saved_at,
           ARRAY[
             count(*) FILTER (WHERE sc.conf = 0), count(*) FILTER (WHERE sc.conf = 1),
             count(*) FILTER (WHERE sc.conf = 2), count(*) FILTER (WHERE sc.conf = 3),
             count(*) FILTER (WHERE sc.conf = 4), count(*) FILTER (WHERE sc.conf = 5)
           ]::INT[] AS confidence
      FROM scoped sc GROUP BY sc.scope
  ),
  freq AS (
    SELECT t.scope, jsonb_object_agg(t.b::text, t.c) AS counts
      FROM (
        SELECT sc.scope,
               CASE WHEN sc.frequency IS NULL OR p_freq_bins IS NULL THEN -1
                    ELSE width_bucket(sc.frequency, p_freq_bins) END AS b,
               count(*) AS c
          FROM scoped sc GROUP BY sc.scope, 2
      ) t GROUP BY t.scope
  ),
  band AS (
    SELECT t.scope, jsonb_object_agg(t.b::text, t.c) AS counts
      FROM (
        SELECT sc.scope, COALESCE(sc.proficiency_band, -1) AS b, count(*) AS c
          FROM scoped sc
          JOIN lang lg ON lg.scope IS NOT DISTINCT FROM sc.scope
         WHERE sc.source_lang = lg.main_lang
         GROUP BY sc.scope, 2
      ) t GROUP BY t.scope
  )

  -- ALL. Driven off a one-row base so a user with NO words still gets the row.
  SELECT NULL::UUID, NULL::TEXT, NULL::TIMESTAMPTZ,
         a.last_saved_at,
         COALESCE(a.word_count, 0),
         COALESCE(a.confidence, ARRAY[0,0,0,0,0,0]),
         COALESCE(f.counts, '{}'::jsonb),
         COALESCE(b.counts, '{}'::jsonb),
         lg.main_lang
    FROM (SELECT NULL::UUID AS scope) base
    LEFT JOIN agg  a  ON a.scope  IS NOT DISTINCT FROM base.scope
    LEFT JOIN freq f  ON f.scope  IS NOT DISTINCT FROM base.scope
    LEFT JOIN band b  ON b.scope  IS NOT DISTINCT FROM base.scope
    LEFT JOIN lang lg ON lg.scope IS NOT DISTINCT FROM base.scope

  UNION ALL

  -- The real lists. LEFT JOINed throughout so an EMPTY list still appears, with 0 and
  -- empty histograms, rather than vanishing exactly when the user needs to fill it.
  SELECT l.list_id, l.list_name, l.created_at,
         lt.last_tag,
         COALESCE(a.word_count, 0),
         COALESCE(a.confidence, ARRAY[0,0,0,0,0,0]),
         COALESCE(f.counts, '{}'::jsonb),
         COALESCE(b.counts, '{}'::jsonb),
         lg.main_lang
    FROM lists l
    LEFT JOIN (SELECT lw.list_id, max(lw.created_at) AS last_tag
                 FROM list_words lw GROUP BY lw.list_id) lt ON lt.list_id = l.list_id
    LEFT JOIN agg  a  ON a.scope  = l.list_id
    LEFT JOIN freq f  ON f.scope  = l.list_id
    LEFT JOIN band b  ON b.scope  = l.list_id
    LEFT JOIN lang lg ON lg.scope = l.list_id
   WHERE l.user_id = (auth.uid())::text
$$;

REVOKE EXECUTE ON FUNCTION list_overview(INT[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION list_overview(INT[]) TO anon, authenticated;
