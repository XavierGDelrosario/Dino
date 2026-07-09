-- =========================================================
-- learn_words_at_band v3 — quality + portability. Three fixes (all observed in a
-- live pool audit of the calibration/level quiz, 2026-07-09):
--
--   1. SECURITY DEFINER. v2 was SECURITY INVOKER and reads the server-only jmdict_*
--      tables directly, so it only works where the CALLER has table SELECT. On
--      hosted Supabase service_role is auto-granted, but on a FRESH instance (CI)
--      it is not → the RPC returned 42501 and the integration test failed. Running
--      as the owner (postgres) removes the caller-grant dependency, matching the
--      other server-only readers (jmdict_lookup). search_path pinned for safety.
--
--   2. POS filter — drop BARE AFFIXES. The band pool surfaced bound morphemes as
--      standalone cards (化/第/着/系 = suffix/prefix, さん/好き = suffix): a learner
--      can't self-rate "第" in isolation, which skews the placement estimate. Keep an
--      entry only if it has a sense with a FREE-STANDING (non-affix) part of speech.
--
--   3. Mature-content skip — a tiny blocklist so a placement quiz doesn't surface
--      explicit loanwords (セックス at N1). Extensible; deliberately minimal.
--
-- Everything else (frequency gate/floor, honest writing-own-frequency, pool+random
-- variety) is unchanged from v2 (20260719).
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
  -- Bound-morpheme POS: an entry whose senses are ONLY these is not a stand-alone
  -- word to quiz. (n-suf/n-pref included: 化/系/感 are noun-suffixes, still bound.)
  c_affix_pos  CONSTANT TEXT[] := ARRAY['pref','suf','ctr','aux','aux-v','aux-adj','cop','cop-da','n-suf','n-pref'];
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
           -- (#2) keep only entries with a FREE-STANDING (non-affix) sense.
           AND EXISTS (
                 SELECT 1 FROM jmdict_senses s
                  WHERE s.entry_id = b.entry_id
                    AND EXISTS (SELECT 1 FROM unnest(s.part_of_speech) p
                                 WHERE p <> ALL (c_affix_pos)))
           -- (#3) explicit-content skip.
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
