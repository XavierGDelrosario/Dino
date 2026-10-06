-- =========================================================
-- Study goals + streak data (the 🔥 counter in the top bar and the /goals page).
--
-- Two small things:
--   1. users.daily_new_words_goal / daily_reviews_goal — the targets the person picks
--      on /goals. NULL = the app default (services/goals.ts), so no row needs touching
--      for a user who never opens the page. On `users` (not localStorage) because a
--      goal follows the ACCOUNT across devices, like the language pair.
--   2. study_days(p_tz) — one row per LOCAL calendar day with any activity: words
--      saved (user_words.originally_translated_date) and cards graded (review_log, one
--      row per card per UTC day, `repeats` for same-day re-grades). The client turns
--      this into the current/longest streak and today's progress against the goals.
--
-- WHY A SEPARATE FUNCTION. profile_history() already returns these days, but it also
-- runs display_confidence() over the whole vocabulary for the confidence-by-level
-- bars — far too much for a counter that loads with every page. This is just the
-- `adds` ⨝ `revs` half of it, same bucketing, same timezone rule, no words join.
--
-- A day counts as STUDIED when added > 0 OR reviews > 0 (either kind of work keeps the
-- streak). That rule lives on the client (services/streak.ts); the function only
-- reports the counts, so a later definition change needs no migration.
--
-- Rows ≈ days the user ever studied — hundreds, not thousands — so there is no window.
-- SECURITY INVOKER: RLS on user_words / review_log already scopes to auth.uid(); the
-- WHERE on user_id just lets the planner use the index.
-- =========================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_new_words_goal INT
  CHECK (daily_new_words_goal IS NULL OR daily_new_words_goal > 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_reviews_goal INT
  CHECK (daily_reviews_goal IS NULL OR daily_reviews_goal > 0);

COMMENT ON COLUMN users.daily_new_words_goal IS
  'New words the user aims to save per day (/goals). NULL = app default.';
COMMENT ON COLUMN users.daily_reviews_goal IS
  'Card grades the user aims to give per day (/goals). NULL = app default.';

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
    SELECT uw.user_word_id, uw.originally_translated_date
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
  )
  SELECT COALESCE(a.d, r.d) AS day,
         COALESCE(a.n, 0)::bigint AS added,
         COALESCE(r.cards, 0)::bigint AS reviewed,
         COALESCE(r.reviews, 0)::bigint AS reviews
    FROM adds a FULL JOIN revs r ON r.d = a.d
   ORDER BY 1;
$$;

COMMENT ON FUNCTION study_days(TEXT) IS
  'Per-local-day activity (words saved, cards graded) for the caller; feeds the streak '
  'counter and /goals. The cheap half of profile_history().';

REVOKE EXECUTE ON FUNCTION study_days(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION study_days(TEXT) TO authenticated;
