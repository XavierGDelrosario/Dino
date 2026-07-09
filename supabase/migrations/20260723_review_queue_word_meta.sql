-- =========================================================
-- review_queue: surface the dictionary sense's proficiency band, part-of-speech,
-- and corpus frequency so the flashcard's word-info ("?") panel can show Level
-- (JLPT/CEFR) + Part of Speech + Commonness without a second query — the same
-- attributes the Lists row already joins from `words` (see userWords.ts
-- SELECT_WITH_DICTIONARY). All are read-only dictionary attributes (NULL for a
-- standalone created word); resolved by the LEFT JOIN already present. Body is
-- otherwise identical to 20260711.
--
-- Changing RETURNS TABLE alters the result type, so DROP + CREATE (not REPLACE),
-- then re-grant on the same 4-arg signature.
-- =========================================================

DROP FUNCTION IF EXISTS review_queue(TEXT, INT, UUID, UUID[]);

CREATE FUNCTION review_queue(
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
STABLE
AS $$
  SELECT
    uw.user_word_id,
    uw.user_id,
    uw.input,
    uw.source_lang,
    uw.target_lang,
    uw.dictionary_word_id,
    uw.custom_translation,
    COALESCE(uw.custom_translation, w.translation, '')                          AS translation,
    w.input_reading                                                             AS input_reading,
    CASE WHEN uw.custom_translation IS NOT NULL THEN NULL ELSE w.translation_reading END
                                                                                AS translation_reading,
    w.proficiency_band                                                          AS proficiency_band,
    w.part_of_speech                                                            AS part_of_speech,
    w.frequency                                                                 AS frequency,
    uw.stability,
    uw.confidence_rating,
    uw.last_reviewed_date,
    uw.originally_translated_date,
    -- Decay from the last review, or — when seeded-but-never-reviewed — from the
    -- originally-translated date, so a calibrated stability actually affects rank.
    -- Only a truly cold word (no stability) scores 0 and leads the queue.
    (CASE
       WHEN uw.stability IS NULL OR uw.stability <= 0 THEN 0
       ELSE exp( - GREATEST(0, EXTRACT(EPOCH FROM
                   (now() - COALESCE(uw.last_reviewed_date, uw.originally_translated_date))) / 86400.0)
                 / uw.stability )
     END)::REAL                                                                 AS retrievability
  FROM user_words uw
  LEFT JOIN words w ON w.word_id = uw.dictionary_word_id
  WHERE uw.user_id = p_user_id
    AND (p_list_id IS NULL OR EXISTS (
          SELECT 1 FROM list_words lw
           WHERE lw.user_word_id = uw.user_word_id
             AND lw.list_id = p_list_id))
    AND (p_user_word_ids IS NULL OR uw.user_word_id = ANY(p_user_word_ids))
  ORDER BY retrievability ASC,
           COALESCE(uw.last_reviewed_date, uw.originally_translated_date, 'epoch'::timestamptz) ASC
  LIMIT GREATEST(0, p_limit);
$$;
REVOKE EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) TO anon, authenticated;
