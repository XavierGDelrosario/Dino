-- =========================================================
-- review_queue: retune the FILL mix (product decision 2026-07-14).
--
-- 20260732 introduced the two phases (DUE, then FILL) and fixed the conf-5 replay bug.
-- The DUE phase is unchanged here and is not up for tuning — it is pinned to the same
-- R ≤ 0.9 line record_review freezes at, which is what makes the deadlock impossible.
--
-- What changes is the composition of the FILL cards, expressed against the default
-- 20-card session (useReview.DEFAULT_LIMIT) but written as PROPORTIONS of however many
-- fill slots there are, so a smaller/larger session keeps the same shape:
--
--   confidence 0–3 :  ~16 of 20  (80%) — the bulk: the words you're actually shaky on.
--   confidence 4   :  3–4 of 20  (15% + a coin flip) — the sprinkle. Randomized per
--                     session on purpose: a fixed 3 or 4 makes the rotation feel
--                     mechanical, and the point of the 4s is variety.
--   confidence 5   :  a CAMEO at ~1 in 100 CARDS — each fill slot carries a 1% chance,
--                     capped at ONE per session. At 20 cards that lands roughly every
--                     5th session. Mature words are otherwise invisible until they
--                     decay (which is correct), but a rare cameo keeps them from feeling
--                     gone, at a rate too low to bring back the replay problem.
--
-- Confidence 5 enters ONLY through that 1% draw — never as filler. If the ≤3 pool is
-- thin, the shortfall is covered by confidence 4 and then the session simply runs short.
-- That's deliberate: a short session is the honest signal that you have little left to
-- practise, and padding it with words you know cold is exactly the bug we just removed.
--
-- Grading a fill card is still FROZEN by record_review (they are fresh by definition) —
-- practice, not evidence. They rotate on their own as low-stability words decay.
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
    -- NEVER call exp() on the 1e9 "infinitely overdue" sentinel a cold word carries:
    -- `urgency` is float8 (stability is REAL), and Postgres float8 exp() RAISES on
    -- underflow (22003) rather than returning 0 — it dies past about exp(-745). Clamp
    -- first: anything that overdue has R = 0 for every practical purpose.
    SELECT s.*,
           (CASE WHEN s.urgency >= 700 THEN 0 ELSE exp(-s.urgency) END)::REAL AS r,
           s.urgency * (0.85 + 0.30 * random())                               AS sort_key
      FROM scoped s
  ),
  -- (1) DUE: R ≤ 0.9 — exactly the words record_review will NOT freeze. Confidence 5
  --     belongs here when it has genuinely decayed; that is how a mature word lapses.
  due AS (
    SELECT * FROM scored
     WHERE r <= 0.9
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, p_limit)
  ),
  -- (2) FILL quotas, drawn once per session (random() here is per-CTE-row, not per word).
  quota AS (
    SELECT
      n,
      -- conf-5 cameo: 1% per fill slot, at most ONE card.
      (CASE WHEN random() < n * 0.01 THEN 1 ELSE 0 END)                        AS five_take,
      -- conf-4 sprinkle: 15% of the slots, plus a coin flip → 3–4 in a 20-card session.
      FLOOR(n * 0.15)::int + (CASE WHEN random() < 0.5 THEN 1 ELSE 0 END)      AS four_take
    FROM (SELECT GREATEST(0, GREATEST(0, p_limit) - (SELECT count(*) FROM due))::int AS n) q
  ),
  fill_low AS (
    SELECT * FROM scored
     WHERE r > 0.9 AND confidence_rating <= 3
     ORDER BY confidence_rating ASC, sort_key DESC
     LIMIT (SELECT GREATEST(0, n - five_take - four_take) FROM quota)
  ),
  fill_four AS (
    SELECT * FROM scored
     WHERE r > 0.9 AND confidence_rating = 4
     ORDER BY sort_key DESC
     -- The sprinkle PLUS any ≤3 shortfall, so a thin shaky pool doesn't shrink the
     -- session. (Confidence 5 never covers a shortfall — only its 1% cameo.)
     LIMIT (SELECT GREATEST(0, n - five_take - (SELECT count(*) FROM fill_low)) FROM quota)
  ),
  fill_five AS (
    SELECT * FROM scored
     WHERE r > 0.9 AND confidence_rating = 5
     ORDER BY sort_key DESC
     LIMIT (SELECT five_take FROM quota)
  ),
  final AS (
    SELECT 0 AS phase, * FROM due
    UNION ALL SELECT 1 AS phase, * FROM fill_low
    UNION ALL SELECT 1 AS phase, * FROM fill_four
    UNION ALL SELECT 1 AS phase, * FROM fill_five
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
