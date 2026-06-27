-- =========================================================
-- Review-queue scalability + scheduling fixes, and a defensive grant (2026-06-27
-- audit). Three things:
--
-- 1. [S3] review_queue gains a p_user_word_ids filter so the Lists "review only
--    these" path filters SERVER-side with the real LIMIT, instead of the client
--    pulling up to 100k ranked rows and slicing in JS.
--
-- 2. [#1, MED] The retrievability CASE returned 0 whenever last_reviewed_date IS
--    NULL, REGARDLESS of a seeded stability — so a #10-calibrated word (positive
--    stability, never reviewed) still sorted to the very front like a cold-start
--    unknown. The calibration seed only moved the confidence badge, not the queue
--    position it promises. Fix: when stability is set, decay from the last review
--    OR (if never reviewed) the originally_translated_date. A truly cold word
--    (stability NULL/0) still scores 0 and leads the queue.
--
-- 3. [#7, LOW] GRANT EXECUTE on confidence_from_stability — review_queue and the
--    save RPCs (SECURITY INVOKER, run as anon) call it but relied on Postgres'
--    default PUBLIC execute; an explicit grant survives `REVOKE … FROM PUBLIC`
--    hardening.
--
-- Adding a parameter changes the signature, so DROP + CREATE (not REPLACE) and
-- re-grant on the new 4-arg signature.
-- =========================================================

DROP FUNCTION IF EXISTS review_queue(TEXT, INT, UUID);

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
    -- [S3] restrict to an explicit subset (Lists "review filtered"), server-side.
    AND (p_user_word_ids IS NULL OR uw.user_word_id = ANY(p_user_word_ids))
  -- least-confident first; ties broken by oldest activity (never-seen = oldest).
  ORDER BY retrievability ASC,
           COALESCE(uw.last_reviewed_date, uw.originally_translated_date, 'epoch'::timestamptz) ASC
  LIMIT GREATEST(0, p_limit);
$$;
REVOKE EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION review_queue(TEXT, INT, UUID, UUID[]) TO anon, authenticated;

-- [#7] Explicit execute for the helper the SECURITY INVOKER client RPCs call.
GRANT EXECUTE ON FUNCTION confidence_from_stability(REAL) TO anon, authenticated;
