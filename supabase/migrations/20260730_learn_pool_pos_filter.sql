-- =========================================================
-- learn_words_at_band v4 — widen the POS filter to GRAMMATICAL words.
--
-- v3 (20260724) dropped bare AFFIXES (化/第/さん) because a learner can't self-rate a
-- bound morpheme in isolation. The same argument applies to the rest of the function
-- words: a placement/learn card showing は, しかし, ～的, もしもし or どういたしまして
-- tests grammar or set phrases, not vocabulary, and the learner's yes/no on it tells us
-- nothing about their LEVEL — which is the only thing these two quizzes exist to measure.
--
-- So the excluded set now also covers (product decision 2026-07-14):
--   prt     particle        (は, が, を, ね)
--   conj    conjunction     (しかし, だから)
--   exp     expression      (どういたしまして, お疲れ様 — set phrases, often multi-word)
--   int     interjection    (もしもし, ええと)
--   adj-pn  pre-noun adjectival / determiner (この, その, あらゆる)
--   suf / pref / n-suf / n-pref   affixes (already excluded in v3)
-- plus the v3 carry-overs (ctr, aux*, cop*), which are bound/grammatical for the same
-- reason.
--
-- The RULE is unchanged and stays INCLUSIVE: an entry survives if it has at least one
-- sense carrying a FREE-STANDING content POS. So a word that is a particle in one sense
-- and a noun in another is still quizzable (on the noun), and only entries that are
-- grammar-ONLY drop out. Everything else (frequency floor/gate, headword resolution,
-- blocklist, pool+random variety) is byte-for-byte v3.
--
-- BOTH quizzes read this: the level/calibration quiz and the Learn quiz both go through
-- the edge function's learn mode → learn_words_at_band. useCalibration.ts keeps a client
-- backstop over the SAME code list (a DB that hasn't taken this migration still filters);
-- keep the two lists in sync.
-- =========================================================

DROP FUNCTION IF EXISTS learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN);

CREATE FUNCTION learn_words_at_band(
  p_source       TEXT,
  p_target       TEXT,
  p_band         SMALLINT,
  p_user_id      TEXT,
  p_limit        INTEGER,
  p_exclude_seen BOOLEAN DEFAULT TRUE
)
RETURNS TABLE(headword TEXT)
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_freq_floor CONSTANT INTEGER := 250;   -- wordfreq Zipf ×100 "fat common" floor
  c_top_from   CONSTANT INTEGER := 4;      -- N2/N1: no floor (advanced vocab is rarer)
  -- GRAMMATICAL / BOUND POS: an entry whose senses are ONLY these is not a stand-alone
  -- vocabulary item to quiz — it is a particle, conjunction, interjection, determiner,
  -- set expression, or an affix. (See the header; v3 covered only the affix half.)
  c_excluded_pos CONSTANT TEXT[] := ARRAY[
    'prt', 'conj', 'exp', 'int', 'adj-pn',
    'pref', 'suf', 'n-suf', 'n-pref',
    'ctr', 'aux', 'aux-v', 'aux-adj', 'cop', 'cop-da'
  ];
  -- Explicit-content skip for a placement/learn context (minimal, extensible).
  c_blocklist  CONSTANT TEXT[] := ARRAY['セックス','エッチ','エロ','ポルノ'];
BEGIN
  IF p_source = 'JA' AND p_target = 'EN' THEN
    RETURN QUERY
      WITH banded AS (
        SELECT entry_id FROM jmdict_kanji WHERE proficiency_band = p_band
        UNION
        SELECT entry_id FROM jmdict_kana  WHERE proficiency_band = p_band
      ),
      seen AS (
        SELECT DISTINCT w.jmdict_entry_id AS entry_id
          FROM user_words uw
          JOIN words w ON w.word_id = uw.dictionary_word_id
         WHERE uw.user_id = p_user_id
           AND w.jmdict_entry_id IS NOT NULL
      ),
      cand AS (
        SELECT hw.writing,
               (SELECT max(x.frequency) FROM (
                  SELECT frequency FROM jmdict_kanji WHERE text = hw.writing
                  UNION ALL
                  SELECT frequency FROM jmdict_kana  WHERE text = hw.writing
                ) x) AS freq
          FROM banded b
          CROSS JOIN LATERAL jmdict_entry_headword(b.entry_id) hw
         WHERE hw.writing IS NOT NULL
           AND hw.proficiency_band = p_band
           AND (NOT p_exclude_seen OR b.entry_id NOT IN (SELECT entry_id FROM seen))
           -- keep only entries with a FREE-STANDING (non-grammatical) sense.
           AND EXISTS (
                 SELECT 1 FROM jmdict_senses s
                  WHERE s.entry_id = b.entry_id
                    AND EXISTS (SELECT 1 FROM unnest(s.part_of_speech) p
                                 WHERE p <> ALL (c_excluded_pos)))
           -- explicit-content skip.
           AND hw.writing <> ALL (c_blocklist)
      ),
      uniq AS (
        SELECT DISTINCT ON (writing) writing, freq
          FROM cand
         ORDER BY writing, freq DESC NULLS LAST
      ),
      gated AS (
        SELECT writing, freq FROM uniq
         WHERE p_band >= c_top_from
            OR (freq IS NOT NULL AND freq >= c_freq_floor)
      ),
      pool AS (
        SELECT writing FROM gated
         ORDER BY freq DESC NULLS LAST, writing
         LIMIT GREATEST(COALESCE(p_limit, 0) * 6, 40)
      )
      SELECT writing FROM pool
       ORDER BY random()
       LIMIT GREATEST(COALESCE(p_limit, 0), 0);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) TO service_role;
