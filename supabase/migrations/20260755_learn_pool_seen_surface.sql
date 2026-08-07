-- =========================================================
-- learn_words_at_band v6 — the JA seen-exclusion is keyed on the SURFACE too.
--
-- THE BUG. The JA branch excludes what the user has already saved by
-- `jmdict_entry_id`, but the pool hands back a WRITING. JMdict splits one writing
-- across several entries (神 has 4, 大 has 5, 数 and 金 have 3 each), so owning one
-- of them leaves the others looking unseen: the same headword comes back as a "new
-- word", the learner grades it, that entry drops out — and the NEXT entry for the
-- same writing surfaces in a later session. A writing with N entries can be handed
-- to you N times.
--
-- It is worse than the raw counts suggest, because the pool is ORDERED BY FREQUENCY
-- and takes only the top `p_limit * 6` before the random pick. Frequent writings are
-- exactly the ones JMdict splits most, so the leak concentrates in the window a draw
-- can actually see. Measured on prod (2026-08-07, the 1,762-word account, N3):
--     whole unseen N3 set:            53 of 1,600 already owned by surface (3%)
--     the 60-word window a 10-card draw samples:  36 of 60 (60%)
-- i.e. six of every ten N3 cards were words the account already had, and the genuine
-- new words cycled out of a pool of ~24. That is the "I keep getting repeats"
-- report, and it is NOT band exhaustion — N3 is 19% covered (387 of 1,987).
--
-- THE FIX is the one the EN branch already made when it shipped (v5, see its header:
-- "SEEN-EXCLUSION is keyed on the SURFACE, not on a dictionary id … entry-id
-- matching would let a word the user already has come back"). The JA branch never got
-- the same treatment. It now excludes a candidate if EITHER its entry or its writing
-- is already in the vocabulary.
--
-- WHY user_words.input AND NOT words.input. The surface is read straight off
-- `user_words`, no join: `save_dictionary_word` derives that column FROM the
-- referenced `words` row, so it already holds the canonical headword — and reading it
-- directly also covers STANDALONE created words (`dictionary_word_id IS NULL`), which
-- a join through `words` cannot see at all. Scoped to `source_lang = 'JA'` so an
-- English row can never mask a Japanese candidate.
--
-- WHAT IS DELIBERATELY *NOT* MATCHED: `input_reading`. For a `uk` entry the headword
-- IS the kana and `input` already holds it, so the kana case is covered; matching the
-- reading as well would exclude by PRONUNCIATION, and homophones are different words
-- (owning 橋 must not retire はし for 端). Surface only.
--
-- COST: one more anti-join over the user's own rows, on the same `user_words` scan
-- the entry-id CTE already pays for. The EN branch is BYTE-FOR-BYTE v5 — untouched;
-- everything v5 documents about it (the English wordlist, the WordNet filter, the
-- closed-class stoplist, the frequency floor, the measured pool sizes) still stands,
-- so read 20260745 for that half.
--
-- FORWARD-ONLY: v5 is applied on staging and prod, so it must not be edited. This
-- replaces the function body; nothing is materialized per word, so the change applies
-- immediately and retroactively on the next draw.
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
  -- The same skip for English, same narrow intent (see the header).
  c_blocklist_en CONSTANT TEXT[] := ARRAY[
    'sex', 'sexy', 'rape', 'porn', 'pornography', 'erotic', 'nude'
  ];
  -- ENGLISH CLOSED-CLASS STOPLIST — the surface half of the JA branch's c_excluded_pos.
  -- WordNet membership alone lets function words through on a content homograph ("a" the
  -- vitamin, "will" the testament); see the header for the measurement. Grouped by class
  -- so the list stays auditable and extensible.
  c_stopwords_en CONSTANT TEXT[] := ARRAY[
    -- articles & determiners
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'either',
    'neither', 'another', 'both', 'all', 'any', 'some', 'no', 'none', 'much', 'many',
    'more', 'most', 'less', 'least', 'few', 'fewer', 'several', 'such', 'enough',
    'same', 'other',
    -- pronouns
    'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself', 'yourselves',
    'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself',
    'we', 'us', 'our', 'ours', 'ourselves', 'they', 'them', 'their', 'theirs',
    'themselves', 'one', 'oneself', 'someone', 'somebody', 'something', 'anyone',
    'anybody', 'anything', 'everyone', 'everybody', 'everything', 'nobody', 'nothing',
    'each other', 'one another', 'no one',
    -- prepositions
    'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'as',
    'at', 'before', 'behind', 'below', 'beneath', 'beside', 'besides', 'between',
    'beyond', 'by', 'despite', 'down', 'during', 'except', 'for', 'from', 'in', 'inside',
    'into', 'near', 'of', 'off', 'on', 'onto', 'out', 'outside', 'over', 'past', 'per',
    'since', 'through', 'throughout', 'till', 'to', 'toward', 'towards', 'under',
    'underneath', 'until', 'up', 'upon', 'via', 'with', 'within', 'without',
    -- conjunctions & connectives (the parallel of the JA branch's `conj`: しかし → however)
    'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though', 'while',
    'whereas', 'unless', 'if', 'than', 'whether', 'however', 'therefore', 'thus',
    'moreover', 'otherwise', 'meanwhile', 'nevertheless', 'hence',
    -- copula, auxiliaries & modals (+ their inflections)
    'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
    'having', 'do', 'does', 'did', 'done', 'doing', 'will', 'would', 'shall', 'should',
    'can', 'could', 'may', 'might', 'must', 'ought',
    -- wh-words
    'what', 'when', 'where', 'why', 'how', 'who', 'whom', 'whose', 'which', 'whatever',
    'whenever', 'wherever', 'whoever',
    -- degree / focus / pro-adverbs & polarity
    'very', 'too', 'quite', 'rather', 'just', 'only', 'also', 'even', 'still', 'now',
    'then', 'there', 'here', 'yes', 'not', 'indeed'
  ];
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
      -- v6: the SURFACE half of the same question. The entry-id CTE above misses a
      -- writing the user owns under a DIFFERENT JMdict entry, which is most of what a
      -- draw sees (see the header). Read off user_words directly so standalone created
      -- words count as owned too.
      seen_surface AS (
        SELECT DISTINCT uw.input AS writing
          FROM user_words uw
         WHERE uw.user_id = p_user_id
           AND uw.source_lang = 'JA'
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
           AND (NOT p_exclude_seen
                OR (b.entry_id NOT IN (SELECT entry_id FROM seen)
                    AND hw.writing NOT IN (SELECT writing FROM seen_surface)))
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

  ELSIF p_source = 'EN' AND p_target = 'JA' THEN
    RETURN QUERY
      WITH seen AS (
        -- keyed on the SURFACE, not a dictionary id (see the header).
        SELECT DISTINCT lower(w.input) AS surface
          FROM user_words uw
          JOIN words w ON w.word_id = uw.dictionary_word_id
         WHERE uw.user_id = p_user_id
           AND w.source_lang = 'EN'
      ),
      cand AS (
        -- surface is english_proficiency's PK, so there is nothing to de-duplicate.
        SELECT p.surface, f.frequency AS freq
          FROM english_proficiency p
          LEFT JOIN english_frequency f ON f.surface = p.surface
         WHERE p.band = p_band
           AND (NOT p_exclude_seen OR p.surface NOT IN (SELECT surface FROM seen))
           -- keep only free-standing CONTENT words, filter 1 of 2: WordNet holds no
           -- function words, so lemma membership is the English stand-in for the JA POS
           -- filter. Underscored lemma → multi-word entries (bus stop → bus_stop)
           -- survive. The JA join makes sure the card can actually be translated.
           AND EXISTS (
                 SELECT 1
                   FROM wordnet_senses_en s
                   JOIN wordnet_words_ja j ON j.synset_id = s.synset_id
                  WHERE s.lemma = replace(p.surface, ' ', '_'))
           -- filter 2 of 2: the closed class WordNet lets through on a content homograph
           -- ("a" the vitamin, "will" the testament). Without this the pool is ~3/4
           -- function words, because they are the most frequent — see the header.
           AND p.surface <> ALL (c_stopwords_en)
           -- explicit-content skip.
           AND p.surface <> ALL (c_blocklist_en)
      ),
      gated AS (
        SELECT surface, freq FROM cand
         WHERE p_band >= c_top_from
            OR (freq IS NOT NULL AND freq >= c_freq_floor)
      ),
      pool AS (
        SELECT surface FROM gated
         ORDER BY freq DESC NULLS LAST, surface
         LIMIT GREATEST(COALESCE(p_limit, 0) * 6, 40)
      )
      SELECT surface FROM pool
       ORDER BY random()
       LIMIT GREATEST(COALESCE(p_limit, 0), 0);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN) TO service_role;
