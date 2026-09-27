-- =========================================================
-- Profile history: per-day activity + a daily confidence snapshot.
--
-- The profile's History section plots words added / total words / cards reviewed
-- per day, a confidence-per-level bar, and confidence OVER TIME. Everything except
-- the last is already stored:
--   · words added   → user_words.originally_translated_date (deletes are hard, so a
--                     deleted word drops out of every day — "ignore deleted" is free);
--   · total words   → the running sum of the above (client-side);
--   · cards reviewed→ review_log, one row per card per UTC day since 20260744 (the
--                     weekly prune keeps each card's newest 30 review-days, so very old
--                     days thin out for heavily drilled cards);
--   · confidence by level, NOW → display_confidence() over user_words, as list_overview.
--
-- Confidence over TIME is not: it is computed live and never recorded. So this adds
-- ONE small table, written nightly, and only for users who were ACTIVE that day.
-- Confidence decays every day even when nothing happens, so "store only days that
-- changed" would mean every day — activity is the gate instead, and an idle stretch
-- plots as a straight line between the active days on either side.
--
-- Measured on the owner's prod account (3,122 words, 77% of days active): a row is
-- ≈225 B incl. tuple + PK overhead (arrays, not JSONB — JSONB measured ≈420 B), so
-- ≈63 KB/year, ≈0.3% of that account's ≈4.9 MB total footprint.
-- =========================================================

-- ── 1. The snapshot table ──────────────────────────────────────────────────────
-- band_n / band_conf are FIXED-SLOT arrays over the day's dominant source language:
-- slot 0 (array index 1) = unranked, slot b (index b+1) = proficiency band b. A slot
-- with no words carries n = 0 and conf NULL. Arrays, not JSONB, for size (see above).
CREATE TABLE IF NOT EXISTS user_confidence_daily (
  user_id    TEXT   NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  day        DATE   NOT NULL,                -- UTC day
  word_count INT    NOT NULL,
  avg_conf   REAL,                           -- over the WHOLE vocabulary, every language
  main_lang  TEXT,
  band_n     INT[]  NOT NULL DEFAULT '{}',
  band_conf  REAL[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, day)
);

-- Read-own, NO client write — the same lockdown as review_log: a client can't forge
-- its own history. Only snapshot_confidence_daily() (SECURITY DEFINER, cron) writes.
ALTER TABLE user_confidence_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_select_own_confidence_daily ON user_confidence_daily;
CREATE POLICY user_select_own_confidence_daily ON user_confidence_daily
  FOR SELECT USING (user_id = (auth.uid())::text);
REVOKE ALL ON user_confidence_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON user_confidence_daily TO authenticated;

-- ── 2. The nightly writer ──────────────────────────────────────────────────────
-- ONE set-based INSERT … SELECT … ON CONFLICT, not a loop per user. Cost scales with
-- the ACTIVE users' vocabulary (1,000 × 3k words ≈ 3M rows scored once a night).
-- Confidence is scored AT the end of p_day (00:00 UTC of the next day), using the
-- rows' state when the job runs — which, run just after midnight, is that day's final
-- state. Re-running it later for an old day scores the CURRENT state, so it is not a
-- backfill tool; re-running for the same day is idempotent (ON CONFLICT).
--
-- "Active" = added a word, reviewed a card, or pressed Forgot (soften_confidence
-- stamps short_stability_at, as does every review) during the UTC day.
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
     WHERE s.source_lang = l.main_lang
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

-- Cron/server-only.
REVOKE EXECUTE ON FUNCTION snapshot_confidence_daily(DATE) FROM PUBLIC, anon, authenticated;

-- Daily, just after the UTC day closes (for the day that just ended).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('snapshot-confidence-daily', '10 0 * * *',
                        'SELECT public.snapshot_confidence_daily()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule snapshot_confidence_daily() manually / via Supabase Cron', SQLERRM;
END $$;

-- ── 3. The profile read ────────────────────────────────────────────────────────
-- One JSONB for the whole History section:
--   days       [{day, added, reviewed, reviews}]  bucketed in the CALLER's timezone
--              (p_tz, IANA) so days match the client's local dayKey; an unknown zone
--              falls back to UTC. reviewed = distinct cards; reviews = total grades
--              (the first plus review_log.repeats' extra same-day ones).
--   bands      [{band, n, avg_conf}]  live confidence per level (-1 = unranked), over
--              the dominant source language — a JLPT band means nothing on a CEFR
--              ruler (same rule as summarizeUserWords / list_overview).
--   confidence [{day, word_count, avg_conf, main_lang, band_n, band_conf}]  the
--              snapshot rows above (UTC days).
--   main_lang
-- review_log is reached THROUGH user_words (indexed by user_id, then review_log's
-- (user_word_id, reviewed_on) unique index) — review_log.user_id has no index, so
-- filtering on it would scan every user's rows.
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
     WHERE m.source_lang = lang.l
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
