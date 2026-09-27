-- =========================================================
-- History: grammar words, affixes, interjections and names leave the "Unranked" level.
--
-- Unranked (no curated band) is read as "not on the JLPT lists". Two kinds of saved
-- sense land there that were never candidates for a vocabulary list, and they inflated
-- the bucket (on the demo account, particles alone were the top of it):
--   · GRAMMAR — every POS tag is a function-word tag (particle, auxiliary, copula):
--     に / が / たり / よう "let's". Tested as grammar at every level, not as vocabulary.
--     Judged per SENSE (as isGrammarOnly in src/services/lookup.ts): よう "let's" goes,
--     よう "well; skillfully" (adv) stays.
--   · AFFIXES + INTERJECTIONS — prefix / suffix (incl. noun-prefix / noun-suffix) and
--     interjection senses: 〜さん, 御〜, ん "huh?". Bound forms and exclamations, not
--     stand-alone vocabulary — the Learn pool already skips them (c_excluded_pos).
--   · NAMES — JMdict's proper-noun entries (sequence numbers 5,000,000+, the block
--     brought in from JMnedict): とき the Shinkansen, place and person names. The
--     ingest keeps no `misc` tags, so the number range is the only marker we store.
--
-- Only UNRANKED senses are dropped — a particle the JLPT list does carry keeps its
-- band. Only the PER-LEVEL figures change: the word totals and the overall confidence
-- still count every saved word. Snapshots already written keep their old counts.
-- =========================================================

CREATE OR REPLACE FUNCTION not_leveled_vocab(p_pos TEXT[], p_entry_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- Never NULL: a custom word (no dictionary row) passes NULLs, and a NULL here would
  -- make `NOT skip_level` drop it from Unranked instead of keeping it.
  SELECT COALESCE(cardinality(p_pos) > 0
                  AND p_pos <@ ARRAY['prt', 'aux', 'aux-v', 'aux-adj', 'cop', 'cop-da',
                                     'pref', 'suf', 'n-pref', 'n-suf', 'int'], FALSE)
      OR COALESCE(CASE WHEN p_entry_id ~ '^[0-9]+$' THEN p_entry_id::bigint >= 5000000 END, FALSE);
$$;

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
           COALESCE(w.proficiency_band, 0) AS slot,
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

-- Cron/server-only (re-stated: CREATE OR REPLACE keeps grants, this is belt-and-braces).
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
           w.proficiency_band,
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
