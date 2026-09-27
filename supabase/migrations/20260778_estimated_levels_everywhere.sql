-- =========================================================
-- Estimated levels reach the Lists summary and the client.
--
-- 20260777 filled the level gap for History only. The Lists summary (list_overview) and
-- every client label (the "?" panel, the recaps, the level filter) read the CURATED band
-- alone, so the same word read N3 in History and "—" in Lists. This makes them agree:
--   · list_overview's Difficulty counts use COALESCE(curated, estimate) — the SAME rule
--     as History, grammar / affixes / interjections / names excluded;
--   · level_estimate_bins() hands the (tiny, measured) bin table to the client, which
--     applies the identical rule in services/proficiency/estimate.ts. Hand-mirrored like
--     display_confidence — tests/services/proficiency/estimate.test.ts pins the constants.
--
-- The SOURCE stays distinguishable everywhere: words.proficiency_band is still only the
-- curated band (nothing is written per word), estimated_band() is a separate read, and the
-- client's getProficiency() reports source 'curated' | 'estimated'.
-- =========================================================

-- The estimate table for the client. Anon too: it is read during startup, in parallel
-- with sign-in, before a session exists — and it is non-personal reference data.
CREATE OR REPLACE FUNCTION level_estimate_bins()
RETURNS TABLE (language TEXT, freq_bin SMALLINT, band SMALLINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.language, e.freq_bin, e.band FROM language_level_estimate e ORDER BY 1, 2;
$$;

REVOKE EXECUTE ON FUNCTION level_estimate_bins() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION level_estimate_bins() TO anon, authenticated;

-- list_overview is granted to anon as well, so what it calls must be too.
GRANT EXECUTE ON FUNCTION estimated_band(TEXT, INT) TO anon;

-- Body as 20260774 with ONE change: the Difficulty band is curated, else estimated.
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
           -- The curated band, else the estimate (20260777) — never for grammar / affixes /
           -- interjections / names, which have no level to give.
           COALESCE(w.proficiency_band,
                    CASE WHEN NOT not_leveled_vocab(w.part_of_speech, w.jmdict_entry_id)
                         THEN estimated_band(uw.source_lang, w.frequency) END) AS proficiency_band,
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
