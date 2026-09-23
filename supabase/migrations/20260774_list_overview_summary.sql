-- =========================================================
-- list_overview(): the per-list SUMMARY, still without loading a single word.
--
-- 20260773 returned a confidence histogram. The recap the Lists tab already shows
-- (summarizeUserWords) has three bars — Confidence, Frequency, Difficulty — and all
-- three inputs live in user_words + words, so all three are aggregates. Adding them
-- keeps the index's cost flat in vocabulary size, which is the property that made the
-- vertical index viable in the first place.
--
-- ‼️ THE BINS ARE A PARAMETER, NOT A CONSTANT. FREQ_BINS lives in
-- services/analyze/summarize.ts and the band LABELS live in services/proficiency.
-- Hardcoding either here would make a second source of truth that drifts silently —
-- the same trap display_confidence already costs us one test and a CLAUDE.md warning
-- to stay ahead of. SQL applies the client's thresholds; it does not own them.
-- p_freq_bins is ASCENDING (width_bucket's requirement), so the client reverses its
-- own descending FREQ_BINS on the way in and back on the way out.
--
-- Histograms come back as JSONB objects rather than arrays so neither side needs a
-- fixed bucket count: a framework with more bands, or a re-tuned bin set, is a client
-- change alone. Key -1 is the UNRANKED bucket (no frequency / no band) — an integer
-- key, not "null", so the client never has to distinguish a missing key from a null one.
--
-- Difficulty counts only words in the scope's DOMINANT source language, mirroring
-- summarizeUserWords: a JLPT band means nothing measured against a CEFR ruler.
--
-- DROP-then-CREATE rather than an overload: a defaulted parameter added alongside the
-- existing no-arg function would make `list_overview()` ambiguous. The default means
-- the PREVIOUSLY DEPLOYED client, which calls it with no arguments, keeps working
-- through the window before the new build ships — it gets unranked frequency counts
-- and ignores the columns it does not know about.
-- =========================================================

DROP FUNCTION IF EXISTS list_overview();

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
           w.proficiency_band,
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
