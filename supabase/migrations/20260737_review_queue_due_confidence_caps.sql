-- =========================================================
-- review_queue: cap how many HIGH-confidence words a scheduled session deals.
--
-- Before this, the DUE phase took the most-overdue words up to p_limit regardless of
-- confidence. A shelf of mature (conf 4–5) words that all decayed past the freshness
-- line could therefore fill a whole session with words you basically know — crowding
-- out the shaky words that actually need the reps.
--
-- New rule, applied to the DUE (scheduled) phase ONLY:
--   * confidence 5  → at most 4 per review
--   * confidence 4+5 combined → at most 10 per review (so conf-4 ≤ 10 − #conf-5 dealt)
-- Low-confidence words (≤3) keep PRIORITY and are uncapped up to p_limit; the high-
-- confidence bands only fill slots those leave, subject to the ceilings above. So a
-- session of 20 shaky due words is still 20 shaky words; a session where everything
-- due is conf-5 deals 5 of them and tops the rest up from FILL (fresh practice).
--
-- SCOPE — the general queue only. An EXPLICIT id set (p_user_word_ids: "Retry quiz",
-- the Lists filtered-subset / sub-list "Review") still bypasses every phase and deals
-- exactly what it was handed — the 20260736 contract. Capping an explicit set would
-- re-introduce the "I picked 20, got 5" shrink that migration fixed, so it must not.
-- The sub-list "Review" caps its COUNT (20) client-side by passing p_limit, not by
-- confidence.
--
-- FILL is unchanged (its own quotas already keep conf-4 a sprinkle and conf-5 a 1%
-- cameo — tighter than these ceilings). The caps govern SCHEDULED words; fill cards
-- are frozen practice, not evidence, so they sit outside this accounting.
--
-- Everything else (the explicit path, display_confidence banding, the DUE gate on the
-- true R, grants) is carried over verbatim from 20260736.
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
      uw.stability,
      -- The LIVE 0–5 the user sees (20260735) — not the stored snapshot. This is what
      -- the caps and fill bands sort and filter on, so the queue and the UI agree.
      display_confidence(uw.stability, uw.last_reviewed_date, uw.originally_translated_date,
                         uw.short_stability, uw.short_stability_at, uw.peak_confidence,
                         now())                                                 AS confidence_rating,
      uw.last_reviewed_date, uw.originally_translated_date,
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
  -- (0) EXPLICIT SET: "quiz exactly these". No due gate, no quotas, no caps — the
  -- caller named the words (a count cap arrives as p_limit, never by confidence).
  explicit AS (
    SELECT * FROM scored
     WHERE p_user_word_ids IS NOT NULL
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, p_limit)
  ),
  -- (1) DUE: R ≤ 0.9 — exactly the words record_review will NOT freeze. Skipped
  -- entirely when an explicit set was given. Split into confidence bands so the
  -- high-confidence ones can be CAPPED without starving the shaky ones.
  --   due_low  (conf ≤3) — the priority: uncapped, most-overdue first, up to p_limit.
  --   due_four (conf  4) — fills what's left, but conf-4 total ≤ 10.
  --   due_five (conf  5) — fills what's still left, ≤ 4 AND ≤ 10 − #conf-4.
  due_low AS (
    SELECT * FROM scored
     WHERE p_user_word_ids IS NULL AND r <= 0.9 AND confidence_rating <= 3
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, p_limit)
  ),
  due_four AS (
    SELECT * FROM scored
     WHERE p_user_word_ids IS NULL AND r <= 0.9 AND confidence_rating = 4
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, LEAST(10, p_limit - (SELECT count(*) FROM due_low)))
  ),
  due_five AS (
    SELECT * FROM scored
     WHERE p_user_word_ids IS NULL AND r <= 0.9 AND confidence_rating = 5
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, LEAST(
             4,                                            -- conf-5 hard cap
             10 - (SELECT count(*) FROM due_four),         -- conf-4+5 combined cap
             p_limit - (SELECT count(*) FROM due_low) - (SELECT count(*) FROM due_four)
           ))
  ),
  due AS (
    SELECT * FROM due_low
    UNION ALL SELECT * FROM due_four
    UNION ALL SELECT * FROM due_five
  ),
  -- (2) FILL quotas, drawn once per session (random() here is per-CTE-row, not per word).
  -- n is 0 whenever an explicit set filled the session, which switches the fill off.
  quota AS (
    SELECT
      n,
      -- conf-5 cameo: 1% per fill slot, at most ONE card.
      (CASE WHEN random() < n * 0.01 THEN 1 ELSE 0 END)                        AS five_take,
      -- conf-4: a 15% floor plus a uniform draw of up to 25% more → 3–8 of 20.
      LEAST(
        n,
        FLOOR(n * 0.15)::int + FLOOR(random() * (FLOOR(n * 0.25)::int + 1))::int
      )                                                                        AS four_take
    FROM (
      SELECT CASE WHEN p_user_word_ids IS NOT NULL THEN 0
                  ELSE GREATEST(0, GREATEST(0, p_limit) - (SELECT count(*) FROM due))
             END::int AS n
    ) q
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
     -- The quota PLUS any ≤3 shortfall, so a thin shaky pool doesn't shrink the session.
     -- (Confidence 5 never covers a shortfall — only its 1% cameo.)
     LIMIT (SELECT GREATEST(0, n - five_take - (SELECT count(*) FROM fill_low)) FROM quota)
  ),
  fill_five AS (
    SELECT * FROM scored
     WHERE r > 0.9 AND confidence_rating = 5
     ORDER BY sort_key DESC
     LIMIT (SELECT five_take FROM quota)
  ),
  final AS (
    SELECT 0 AS phase, * FROM explicit
    UNION ALL SELECT 0 AS phase, * FROM due
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
REVOKE EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) TO anon, authenticated;
