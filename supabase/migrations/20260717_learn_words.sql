-- =========================================================
-- LEVEL-BASED NEW-WORDS QUIZ (Proficiency.md feature 2 / docs/TODO.md).
--
-- "Give me N words at proficiency band X that I haven't saved yet" — the source
-- retrieval for a level-based learn quiz. The lazy `words` cache is INCOMPLETE (a
-- word only lands there once it's been translated), so the pool of "words at band
-- X" MUST be read from the JMdict SOURCE (jmdict_kanji/kana carry the per-surface
-- proficiency_band, populated at ingest — see 20260716_proficiency.sql), not from
-- `words`. The edge function feeds the returned headwords through the SAME batch
-- projection the reader uses (jmdict_lookup_many → project → cache), so they come
-- back as ordinary verified `words` rows the quiz can save + review.
--
-- UNSEEN = the user has no `user_words` row referencing a `words` row for that
-- JMdict entry. This keeps the quiz to genuinely NEW vocabulary (like the reader's
-- "Quiz N new words", but sourced by level instead of by a pasted text). The
-- p_exclude_seen flag turns that filter OFF: the CALIBRATION quiz (#10) needs a
-- REPRESENTATIVE sample of a band's vocabulary — including words the user already
-- saved — to estimate how much of the band they know, so it passes FALSE.
--
-- ORDER = frequency DESC (most common first) — within one JLPT band, the more
-- common words are the more useful to learn first.
--
-- Server-only, like every jmdict_* function: EXECUTE granted to service_role only
-- (the edge function's client), never to PUBLIC. Runs as service_role, which
-- bypasses RLS, so it can read the caller's user_words — the caller's id is passed
-- explicitly (p_user_id, derived from the request JWT by the edge function).
--
-- Today only JA→EN (JLPT) is populated; any other pair returns no rows (the client
-- hides the feature when a language has no framework — services/proficiency).
-- =========================================================

DROP FUNCTION IF EXISTS learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER);
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
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF p_source = 'JA' AND p_target = 'EN' THEN
    RETURN QUERY
      -- Entries with ANY surface at the requested band (bands are sparse — ~7.8k
      -- surfaces — so this is a small, index-friendly candidate set to expand).
      WITH banded AS (
        SELECT entry_id FROM jmdict_kanji WHERE proficiency_band = p_band
        UNION
        SELECT entry_id FROM jmdict_kana  WHERE proficiency_band = p_band
      ),
      -- JMdict entries the user has already saved (any sense of the word), so the
      -- quiz only surfaces NEW words. Maps user_words → words → jmdict_entry_id.
      seen AS (
        SELECT DISTINCT w.jmdict_entry_id AS entry_id
          FROM user_words uw
          JOIN words w ON w.word_id = uw.dictionary_word_id
         WHERE uw.user_id = p_user_id
           AND w.jmdict_entry_id IS NOT NULL
      ),
      -- Resolve each candidate to its HEADWORD (same pick as jmdict_lookup /
      -- frequency: preferred kanji, or kana for uk). Keep only those whose HEADWORD
      -- is actually at the band (a variant surface could be banded while the
      -- headword isn't — match the projection's band, which is the headword's).
      cand AS (
        SELECT hw.writing, hw.frequency
          FROM banded b
          CROSS JOIN LATERAL jmdict_entry_headword(b.entry_id) hw
         WHERE hw.writing IS NOT NULL
           AND hw.proficiency_band = p_band
           -- Exclude already-saved words for the LEARN quiz; keep them for the
           -- CALIBRATION quiz (p_exclude_seen = FALSE), which samples the whole band.
           AND (NOT p_exclude_seen OR b.entry_id NOT IN (SELECT entry_id FROM seen))
      ),
      -- Collapse homograph entries that share one headword writing (辛い →
      -- からい/つらい are separate entries) to a single quiz card; jmdict_lookup on
      -- that headword returns all their senses anyway. Keep the best frequency.
      uniq AS (
        SELECT DISTINCT ON (writing) writing, frequency
          FROM cand
         ORDER BY writing, frequency DESC NULLS LAST
      )
      SELECT writing AS headword
        FROM uniq
       ORDER BY frequency DESC NULLS LAST, writing
       LIMIT GREATEST(COALESCE(p_limit, 0), 0);
  END IF;
END;
$$;

-- Server-only EXECUTE (mirrors jmdict_lookup et al.: service_role only, no PUBLIC).
REVOKE EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) TO service_role;
