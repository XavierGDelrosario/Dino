-- =========================================================
-- The lists OVERVIEW — timestamps on lists/list_words, plus the one query that
-- feeds a vertical index of every list.
--
-- WHY: the only way into a list was the horizontal chip row, which is cramped on a
-- phone and gets worse with every list added — a scroller you have to hunt through.
-- The replacement is a vertical page listing every list with its size and how it is
-- going, which needs two things this schema never had:
--
--   * lists.created_at        — "recently added" (the list itself)
--   * list_words.created_at   — "recently added a new word" (the last tag)
--
-- Neither table carried ANY timestamp, so both sorts were unimplementable, not merely
-- slow. Both columns are NOT NULL DEFAULT now(), which is a metadata-only ALTER on
-- PG11+ (no table rewrite) — the same "adding columns to existing data is cheap"
-- property CLAUDE.md measured at ~4 ms on jmdict_kanji.
--
-- THE BACKFILL IS EXACT FOR THE COMMON PATH. save_dictionary_word(p_list_id) creates
-- the user_words row AND its list_words tag in ONE transaction, so for every word
-- saved directly into a list the tag time IS originally_translated_date. Words tagged
-- into a list LATER (the ＋ menu on an existing word) get the date they were first
-- saved instead of the date they were filed, which is earlier than the truth — an
-- acceptable approximation for history, and correct for everything written from here
-- on. Without it every pre-existing row would share the migration's timestamp and the
-- new sorts would be meaningless on exactly the data users already have.
--
-- ⚠️ NUMBER: 20260773 follows 20260772 in this repo, but staging carries migrations
-- from other branches — CHECK BOTH HOSTED DBs before pushing (see docs/TODO.md).
-- =========================================================

ALTER TABLE list_words ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE lists      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN list_words.created_at IS
  'When the word was filed into this list. Backfilled from user_words.originally_translated_date, which is exact for words saved straight into a list.';
COMMENT ON COLUMN lists.created_at IS
  'When the list was created. Backfilled from its earliest tag, so pre-existing lists sort plausibly rather than all sharing the migration timestamp.';

-- Tag time ← the word's save time (identical for the save-into-list path).
UPDATE list_words lw
   SET created_at = uw.originally_translated_date
  FROM user_words uw
 WHERE uw.user_word_id = lw.user_word_id;

-- List creation ← its earliest tag. An EMPTY list has nothing to infer from and keeps
-- the default (now()); it also has no words to sort by, so nothing rests on it.
UPDATE lists l
   SET created_at = t.first_tag
  FROM (SELECT list_id, min(created_at) AS first_tag FROM list_words GROUP BY list_id) t
 WHERE t.list_id = l.list_id;

-- =========================================================
-- list_overview() — ONE round-trip for the whole index page.
--
-- Returns a row per list PLUS a leading row for ALL (list_id NULL), because "ALL is
-- virtual" is an invariant — there is no lists row to join, and the index must still
-- show the whole vocabulary as the first thing you can open.
--
-- It loads NO WORDS. Counts and the confidence histogram are aggregates, so the page
-- costs the same whether the user has 50 saved words or 50,000 — the thing the chip
-- row's replacement must not regress on.
--
-- ‼️ THE HISTOGRAM USES display_confidence(), NOT the stored confidence_rating
-- snapshot. That snapshot is written at review time and does not decay; every read
-- surface recomputes the live value (CLAUDE.md: "if one screen used the stored
-- snapshot the same word would read 4 in Lists and 1 in Review"). It is computed ONCE
-- in `scored` and reused by both branches, so ALL and a list can never disagree about
-- the same word.
--
-- SECURITY INVOKER: RLS on lists/list_words/user_words does the authorising, exactly
-- as it does for a direct select. The explicit user_id predicates are not the security
-- boundary — they let the planner use the indexes instead of filtering post-RLS.
-- =========================================================
CREATE OR REPLACE FUNCTION list_overview()
RETURNS TABLE (
  list_id            UUID,
  list_name          TEXT,
  created_at         TIMESTAMPTZ,
  last_word_added_at TIMESTAMPTZ,
  word_count         BIGINT,
  -- Six buckets, ordinal 1..6 = confidence 0..5. One array rather than six columns so
  -- the shape survives a future bucket change without a signature break.
  confidence         INT[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH scored AS (
    SELECT uw.user_word_id,
           uw.originally_translated_date,
           display_confidence(
             uw.stability, uw.last_reviewed_date, uw.originally_translated_date,
             uw.short_stability, uw.short_stability_at, uw.peak_confidence, now()
           ) AS conf
      FROM user_words uw
     WHERE uw.user_id = (auth.uid())::text
  )
  -- ALL. Aggregate-only with no GROUP BY, so it yields exactly one row even for a user
  -- with no words at all (count 0, NULL dates) — the index always has its first entry.
  SELECT NULL::UUID, NULL::TEXT,
         min(s.originally_translated_date),
         max(s.originally_translated_date),
         count(*),
         ARRAY[
           count(*) FILTER (WHERE s.conf = 0), count(*) FILTER (WHERE s.conf = 1),
           count(*) FILTER (WHERE s.conf = 2), count(*) FILTER (WHERE s.conf = 3),
           count(*) FILTER (WHERE s.conf = 4), count(*) FILTER (WHERE s.conf = 5)
         ]::INT[]
    FROM scored s

  UNION ALL

  -- The real lists. LEFT JOINed so an EMPTY list still appears (count 0) rather than
  -- vanishing from the index the moment it has nothing in it — which is exactly when
  -- the user needs to see it to fill it.
  --
  -- Every count is over lw.user_word_id, never count(*): on the empty side of the LEFT
  -- JOIN there is still one row, and count(*) would report that phantom as a word.
  SELECT l.list_id, l.list_name, l.created_at,
         max(lw.created_at),
         count(lw.user_word_id),
         ARRAY[
           count(lw.user_word_id) FILTER (WHERE s.conf = 0),
           count(lw.user_word_id) FILTER (WHERE s.conf = 1),
           count(lw.user_word_id) FILTER (WHERE s.conf = 2),
           count(lw.user_word_id) FILTER (WHERE s.conf = 3),
           count(lw.user_word_id) FILTER (WHERE s.conf = 4),
           count(lw.user_word_id) FILTER (WHERE s.conf = 5)
         ]::INT[]
    FROM lists l
    LEFT JOIN list_words lw ON lw.list_id = l.list_id
    LEFT JOIN scored s      ON s.user_word_id = lw.user_word_id
   WHERE l.user_id = (auth.uid())::text
   GROUP BY l.list_id, l.list_name, l.created_at
$$;

-- Ordering is deliberately NOT done here: the page has its own sort control (name /
-- created / last word added) and sorting a handful of rows client-side beats a round
-- trip per axis change.

REVOKE EXECUTE ON FUNCTION list_overview() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION list_overview() TO anon, authenticated;
