-- =========================================================
-- study_days(): a card's LATEST review also marks its day.
--
-- review_log holds one row per card per UTC day (20260744), stamped with the day's
-- FIRST grade; a later same-UTC-day grade only bumps `repeats`. Bucketing by that
-- stamp alone therefore loses the LOCAL day of a re-grade — and the UTC day turns over
-- at 09:00 in Japan, so a JST learner who graded a card at 20:00 and again at 08:00
-- the next morning (same UTC day) had a morning session that counted for nothing: no
-- row for the new local day, badge unlit, reminder nagging, streak read as broken at
-- midnight.
--
-- user_words.last_reviewed_date is the card's most recent NON-frozen grade, so the
-- union of the two sources recovers that morning. Per day the counts are the larger
-- of what either source says ("at least this many"): where both agree it changes
-- nothing. Residual gap, accepted: a CRAM-FROZEN re-grade (R > 0.9, 20260729) moves
-- neither the log nor last_reviewed_date, so a morning spent only re-grading cards you
-- already know, all first graded the previous evening, still leaves no trace.
-- =========================================================

CREATE OR REPLACE FUNCTION study_days(p_tz TEXT DEFAULT 'UTC')
RETURNS TABLE (day DATE, added BIGINT, reviewed BIGINT, reviews BIGINT)
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
    SELECT uw.user_word_id, uw.originally_translated_date, uw.last_reviewed_date
      FROM user_words uw
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
  latest AS (
    SELECT (m.last_reviewed_date AT TIME ZONE zone.z)::date AS d, count(*) AS cards
      FROM mine m CROSS JOIN zone
     WHERE m.last_reviewed_date IS NOT NULL
     GROUP BY 1
  ),
  days AS (
    SELECT d FROM adds UNION SELECT d FROM revs UNION SELECT d FROM latest
  )
  SELECT days.d AS day,
         COALESCE(a.n, 0)::bigint AS added,
         GREATEST(COALESCE(r.cards, 0), COALESCE(l.cards, 0))::bigint AS reviewed,
         GREATEST(COALESCE(r.reviews, 0), COALESCE(l.cards, 0))::bigint AS reviews
    FROM days
    LEFT JOIN adds   a ON a.d = days.d
    LEFT JOIN revs   r ON r.d = days.d
    LEFT JOIN latest l ON l.d = days.d
   ORDER BY 1;
$$;
