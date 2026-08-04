-- =========================================================
-- review_queue: the conf-5 cameo may not BE the session.
--
-- 20260737's fill quota gives conf-5 words a 1%-per-slot cameo, so an otherwise-full
-- session occasionally carries one mastered word for variety. That is the intent, and
-- it stays.
--
-- THE HOLE. When the whole vocabulary is known and fresh, nothing is due and the only
-- fill candidates are conf-5 — so the cameo isn't a garnish, it IS the session. The
-- user opens Review, gets exactly one mastered card, grades it 5, and 20260729's cram
-- freeze makes that grade a total no-op: stability unchanged, last_reviewed_date
-- unchanged. That is a one-card version of the conf-5 replay 20260732 was written to
-- kill, and it fires on 1 − 0.99^n of sessions — 10% at the default p_limit of 10.
--
-- It also made `rpc: review_queue > deals NOTHING when the whole vocabulary is known
-- and fresh` fail about 27% of CI runs (three sessions asserted empty, 10% each). The
-- test was right; the queue was wrong at this boundary.
--
-- THE FIX. `has_other` — the cameo may only fire when the session has other material:
-- the due phase dealt something, or a non-conf-5 word is available to fill. When
-- neither holds, the queue returns EMPTY, which is the honest answer: you're done.
-- Nothing else changes; every other quota, cap and ordering is byte-identical to
-- 20260737.
--
-- Forward-only: 20260737 is applied on staging and prod, so it isn't edited.
-- CREATE OR REPLACE re-defines the function in place; the signature is unchanged, so
-- the existing REVOKE/GRANT still apply (re-stated below for a fresh database).
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
  -- Is there ANY card besides the conf-5 cameo? True when the due phase dealt
  -- something, or when a non-conf-5 word is available to fill. False means the whole
  -- vocabulary is known and fresh — the one state where the cameo must stay silent.
  has_other AS (
    SELECT ((SELECT count(*) FROM due) > 0
            OR EXISTS (SELECT 1 FROM scored WHERE r > 0.9 AND confidence_rating <= 4)) AS ok
  ),
  -- (2) FILL quotas, drawn once per session (random() here is per-CTE-row, not per word).
  -- n is 0 whenever an explicit set filled the session, which switches the fill off.
  quota AS (
    SELECT
      n,
      -- conf-5 cameo: 1% per fill slot, at most ONE card — and ONLY as a garnish on
      -- a session that has other material (see the header). `has_other` is what
      -- stops it becoming the entire session.
      (CASE WHEN (SELECT ok FROM has_other) AND random() < n * 0.01
            THEN 1 ELSE 0 END)                                                 AS five_take,
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
