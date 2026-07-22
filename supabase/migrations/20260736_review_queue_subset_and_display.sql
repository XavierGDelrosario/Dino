-- =========================================================
-- review_queue: (1) an EXPLICIT id set means "quiz exactly these", and
--               (2) the fill bands read the LIVE display confidence (20260735).
--
-- (1) THE RETRY BUG (reported 2026-07-22: "words disappear from retry quiz, less
--     flashcards"). "Retry quiz" re-runs the session you just finished by passing the
--     exact user_word_ids back in (useReview.retry). But p_user_word_ids was only ever
--     a FILTER — the DUE gate and the FILL quotas still ran on top of it. Every word you
--     just graded ≥3 is now fresh by construction (R ≈ 1), so it fails the DUE gate, and
--     the fill quotas then admit only a fraction of what's left: a conf-5 word is
--     excluded outright except as the 1% cameo, and conf-4s are capped at a ~15–40%
--     slice. Retrying a 20-card session dealt a handful of cards, and retrying again
--     dealt fewer still — the set shrank every pass, exactly as reported.
--
--     The same gate silently shrank the Lists view's "quiz this filtered subset": you
--     select 30 words and get 6, with no indication the other 24 were dropped.
--
--     FIX: an explicit id set is an explicit INSTRUCTION, not a pool to sample from.
--     When p_user_word_ids IS NOT NULL the phases are bypassed — every requested word is
--     dealt, most-overdue first, up to p_limit. The general queue (no id set) is
--     untouched: DUE then FILL, exactly as 20260732–34 left it. Grading a fresh card is
--     still frozen by record_review, so re-running a set can't inflate any schedule —
--     it's practice, which is precisely what the user asked for by pressing Retry.
--
-- (2) The fill bands ("≤3 is the bulk, 4 is a sprinkle, 5 never") were reading the
--     STORED confidence_rating, which 20260735 turned into a write-time snapshot. Left
--     alone, the scheduler would band a word by what it read months ago while the UI
--     shows something else. Both the banding and the returned column now come from
--     display_confidence(), so what you see in Lists is what the queue treats it as.
--     Note the DUE gate itself still runs on the true R — the schedule must not be
--     driven by the gentler display curve, or cards would come back early.
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
      -- the fill bands sort and filter on, so the queue and the UI agree.
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
  -- (0) EXPLICIT SET: "quiz exactly these". No due gate, no quotas — the caller named
  -- the words. Empty for the general queue.
  explicit AS (
    SELECT * FROM scored
     WHERE p_user_word_ids IS NOT NULL
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, p_limit)
  ),
  -- (1) DUE: R ≤ 0.9 — exactly the words record_review will NOT freeze. Skipped
  -- entirely when an explicit set was given.
  due AS (
    SELECT * FROM scored
     WHERE p_user_word_ids IS NULL
       AND r <= 0.9
     ORDER BY sort_key DESC, COALESCE(last_reviewed_date, originally_translated_date, 'epoch'::timestamptz) ASC
     LIMIT GREATEST(0, p_limit)
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
