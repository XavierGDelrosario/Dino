-- =========================================================
-- learn_words_at_band v2 — frequency-gated, variety on retry.
--
-- Fixes two problems seen live (level quiz + calibration):
--   1. RARE single-kanji words surfaced. Root cause: jmdict_entry_headword credits
--      a rare KANJI writing with its common KANA reading's frequency (e.g. 亡い gets
--      ない's Zipf ×100 = 704, though 亡い's OWN kanji frequency is NULL). So a
--      frequency sort couldn't keep them out. Fix: gate/order by the WRITING's OWN
--      corpus frequency (max over the exact surface in jmdict_kanji/kana), so a rare
--      spelling of a common word is treated as rare.
--   2. NO new words on retry. Root cause: deterministic ORDER BY frequency returned
--      the same top-N every time. Fix: build a POOL of the most-frequent words at
--      the band, then RANDOM()-sample the requested count from it — frequent words
--      are prioritized (the pool), yet each session/retry varies (the sample).
--
-- Gatekeeping policy (per product decision): apply a frequency FLOOR for the easier
-- bands, but NOT for the two HIGHEST levels (JLPT N2/N1 = bands 4–5), where advanced
-- vocabulary is legitimately rarer. Even there, the pool still favors frequency, so
-- obscure entries rarely surface.
--
-- Now VOLATILE (uses random()). Server-only EXECUTE, JA→EN/JLPT only, same as v1.
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
AS $$
DECLARE
  -- Corpus-frequency floor (wordfreq Zipf ×100; 250 = Zipf 2.5, the "fat common"
  -- threshold used elsewhere). Applied only below the two highest bands.
  c_freq_floor CONSTANT INTEGER := 250;
  -- Bands at/above this get NO floor (the two highest JLPT levels: N2=4, N1=5).
  c_top_from   CONSTANT INTEGER := 4;
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
               -- the WRITING's OWN frequency (honest — never the kana fallback that
               -- inflates a rare kanji spelling). Indexed lookup on text (idx_*_text).
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
      ),
      -- One row per distinct headword writing (homograph entries collapse).
      uniq AS (
        SELECT DISTINCT ON (writing) writing, freq
          FROM cand
         ORDER BY writing, freq DESC NULLS LAST
      ),
      -- Frequency gate: skip rare/unranked words below the top two bands.
      gated AS (
        SELECT writing, freq FROM uniq
         WHERE p_band >= c_top_from
            OR (freq IS NOT NULL AND freq >= c_freq_floor)
      ),
      -- Pool of the most-frequent eligible words (a few × the ask) to sample from.
      pool AS (
        SELECT writing FROM gated
         ORDER BY freq DESC NULLS LAST, writing
         LIMIT GREATEST(COALESCE(p_limit, 0) * 6, 40)
      )
      -- Prioritize frequent (the pool) but vary across retries (random sample).
      SELECT writing FROM pool
       ORDER BY random()
       LIMIT GREATEST(COALESCE(p_limit, 0), 0);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) TO service_role;
