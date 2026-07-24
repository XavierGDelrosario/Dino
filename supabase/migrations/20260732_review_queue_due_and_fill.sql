-- =========================================================
-- review_queue: a DUE gate, then a FILL phase.
--
-- THE BUG (reproduced live, 2026-07-14). The queue had no due gate: it ranked the whole
-- vocabulary by urgency and returned the top N whether or not anything was actually due.
-- On its own that was merely generous. Combined with 20260729's CRAM FREEZE — a grade ≥3
-- on a word that is still fresh (R > 0.9) is LOGGED but changes NOTHING, not the
-- stability and not the clock — it deadlocked:
--
--   a user who has been through their whole vocabulary has nothing due, so the queue
--   hands them the least-fresh of a fully-fresh set; grading those cards 5 cannot move
--   them (frozen); so the SAME few words come back next session, and the next, forever.
--
-- Observed exactly that: four consecutive sessions served 会議 / 住まい / 経済, every card
-- at confidence 5 and R = 1.000, every review logged, nothing ever changing. The ±15%
-- jitter only shuffled their order, which is why it reads as "the same few words" rather
-- than one stuck word.
--
-- THE FIX, in two phases:
--
--   1. DUE — words the scheduler will actually LEARN from: R ≤ c_fresh_r, the SAME 0.9
--      threshold record_review freezes at. The two now agree by construction: if a review
--      would be frozen, the card is not dealt. A frozen word can never be served, so it
--      can never deadlock. Confidence 5 is NOT excluded here — a mature word that has
--      genuinely decayed (住まい at 40d → R = 0.37) is exactly what spaced repetition
--      exists to re-test, and it's the only way a mature word can ever lapse.
--
--   2. FILL — because a due-only queue would leave Review empty on any day nothing is
--      due, and the previous iteration's rhythm (which the user asked for back) was to
--      keep working the words you're still shaky on: new/low-stability words mixed with
--      slightly older ones that are still low-stability. So when the due set doesn't fill
--      the session, top it up from the NOT-due pool, ordered least-confident first:
--        · confidence ≤3  — the bulk of the fill;
--        · confidence 4   — roughly ONE IN FIVE fill slots (a sprinkle), and more only if
--                           the ≤3 pool runs dry (a thin ≤3 pool shouldn't shrink the
--                           session);
--        · confidence 5   — NEVER. A word you know cold is not what a spare slot is for,
--                           and it is precisely what was being replayed.
--
-- Fill cards are, by definition, fresh — so grading them is frozen (logged, no schedule
-- change). That is intended: they're practice, not evidence. They rotate anyway, because
-- low-stability words decay fast and re-enter the DUE phase on their own.
-- =========================================================

CREATE OR REPLACE FUNCTION review_queue(
  p_user_id       TEXT,
  p_limit         INT,
  p_list_id       UUID    DEFAULT NULL,
  p_user_word_ids UUID[]  DEFAULT NULL
)
RETURNS TABLE (
  user_word_id               UUID,
  user_id                    TEXT,
  input                      TEXT,
  source_lang                TEXT,
  target_lang                TEXT,
  dictionary_word_id         UUID,
  custom_translation         TEXT,
  translation                TEXT,
  input_reading              TEXT,
  translation_reading        TEXT,
  proficiency_band           SMALLINT,
  part_of_speech             TEXT[],
  frequency                  INT,
  stability                  REAL,
  confidence_rating          INT,
  last_reviewed_date         TIMESTAMPTZ,
  originally_translated_date TIMESTAMPTZ,
  retrievability             REAL
)
LANGUAGE sql
VOLATILE
AS $$
  WITH scoped AS (
    SELECT
      uw.user_word_id, uw.user_id, uw.input, uw.source_lang, uw.target_lang,
      uw.dictionary_word_id, uw.custom_translation,
      COALESCE(uw.custom_translation, w.translation, '')                        AS translation,
      w.input_reading,
      CASE WHEN uw.custom_translation IS NOT NULL THEN NULL ELSE w.translation_reading END
                                                                                AS translation_reading,
      w.proficiency_band, w.part_of_speech, w.frequency,
      uw.stability, uw.confidence_rating, uw.last_reviewed_date, uw.originally_translated_date,
      -- Overdue-ness = Δdays / S. A cold word (no stability) is infinitely overdue.
      (CASE
         WHEN uw.stability IS NULL OR uw.stability <= 0 THEN 1e9
         ELSE GREATEST(0, EXTRACT(EPOCH FROM
                (now() - COALESCE(uw.last_reviewed_date, uw.originally_translated_date))) / 86400.0)
              / uw.stability
       END)                                                                     AS urgency
    FROM user_words uw
    LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
    WHERE uw.user_id = p_user_id
      AND (p_list_id IS NULL OR EXISTS (
            SELECT 1 FROM list_words lw
             WHERE lw.user_word_id = uw.user_word_id
               AND lw.list_id = p_list_id))
      AND (p_user_word_ids IS NULL OR uw.user_word_id = ANY(p_user_word_ids))
  ),
  scored AS (
    -- R = exp(-urgency) — the same curve as before, just derived from urgency (exp is
    -- monotone, so the ORDER is identical). The ±15% jitter lives on urgency, where a
    -- multiplicative wobble is meaningful; on R it would vanish (R saturates near 0), and
    -- an identical cohort would replay in the same block.
    -- NEVER call exp() on the 1e9 "infinitely overdue" sentinel a cold word carries:
    -- `urgency` is float8 (stability is REAL), and Postgres float8 exp() RAISES on
    -- underflow (22003) rather than returning 0 — it dies past about exp(-745). Clamp
    -- first: anything that overdue has R = 0 for every practical purpose.
    SELECT s.*,
           (CASE WHEN s.urgency >= 700 THEN 0 ELSE exp(-s.urgency) END)::REAL AS r,
           s.urgency * (0.85 + 0.30 * random())                               AS sort_key
      FROM scoped s
  ),
  -- (1) DUE: R ≤ 0.9 — exactly the words record_review will NOT freeze.
  due AS (
    SELECT * FROM scored
     WHERE r <= 0.9
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, p_limit)
  ),
  need AS (
    SELECT GREATEST(0, GREATEST(0, p_limit) - (SELECT count(*) FROM due))::int AS n
  ),
  -- (2) FILL: not due, never confidence 5, least-confident first.
  fill_pool AS (
    SELECT * FROM scored
     WHERE r > 0.9
       AND confidence_rating <= 4
  ),
  fill_low AS (
    SELECT * FROM fill_pool
     WHERE confidence_rating <= 3
     ORDER BY confidence_rating ASC, sort_key DESC
     -- Leave ~1 in 5 of the fill slots for a confidence-4 sprinkle.
     LIMIT (SELECT n - (n / 5) FROM need)
  ),
  fill_four AS (
    SELECT * FROM fill_pool
     WHERE confidence_rating = 4
     ORDER BY sort_key DESC
     -- The sprinkle — PLUS any shortfall, so a thin ≤3 pool doesn't shrink the session.
     LIMIT (SELECT n - (SELECT count(*) FROM fill_low) FROM need)
  ),
  final AS (
    SELECT 0 AS phase, * FROM due
    UNION ALL
    SELECT 1 AS phase, * FROM fill_low
    UNION ALL
    SELECT 1 AS phase, * FROM fill_four
  )
  SELECT
    user_word_id, user_id, input, source_lang, target_lang, dictionary_word_id,
    custom_translation, translation, input_reading, translation_reading,
    proficiency_band, part_of_speech, frequency, stability, confidence_rating,
    last_reviewed_date, originally_translated_date, r AS retrievability
  FROM final
  -- Due work leads the session; the fill follows, shakiest first.
  ORDER BY phase ASC, sort_key DESC
  LIMIT GREATEST(0, p_limit);
$$;
