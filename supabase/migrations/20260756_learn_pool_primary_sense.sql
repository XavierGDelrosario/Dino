-- =========================================================
-- learn_words_at_band v7 — the grammar filter judges the PRIMARY sense (+ pronouns).
--
-- THE BUG. 20260730 added a filter so a placement/learn card never shows a particle
-- or a conjunction, and shipped a test asserting これ/この/しかし/いいえ/さあ/ばかり/
-- どういたしまして are unquizzable. Six of the seven are. これ NEVER WAS, and the test
-- has been failing on main ever since — intermittently, which is why it survived: the
-- N5 pool is 635 words and the test draws 400 at RANDOM, so これ turns up in roughly
-- two runs out of three. A red that shows up 2/3 of the time reads as flake.
--
-- It is not flake. TWO separate holes, and the first one hides the second:
--
--   (1) THE RULE IS TOO WEAK. It keeps an entry that has ANY sense outside the
--       grammatical set. これ (entry 1628530) is five pronoun senses AND one `adv`
--       sense ("this much"), so one adverbial reading of a demonstrative pronoun was
--       enough to qualify it as vocabulary. An entry is not a content word because
--       its sixth sense is; it is one because that is WHAT IT MOSTLY IS. So the test
--       now runs on the PRIMARY (lowest-position) sense — exactly the call
--       jmdict_lookup already makes for `uk`, where the header spells out the same
--       reasoning: "must be primary, not any sense, or 猫 (whose slang senses are uk
--       but whose main 'cat' sense isn't) wrongly flips to ねこ".
--
--   (2) `pn` WAS NEVER IN THE LIST. c_excluded_pos covers `adj-pn` (この, その) but
--       not `pn` itself, so これ/それ/あれ/ここ/そこ/どこ/私/僕/俺/君/彼ら cleared the
--       filter on their own POS. Adding it alone fixes 44 banded entries and does
--       NOT fix これ — that one needs (1). Both holes, or neither.
--
-- MEASURED on prod (2026-08-07), distinct banded headwords surviving the filter:
--     band | current | +pn  | primary-sense (+pn)   ← this migration
--     N5   |   687   | 663  |  654
--     N4   |   649   | 646  |  639
--     N3   |  2082   | 2080 | 2063
--     N2   |  1625   | 1623 | 1611
--     N1   |  2622   | 2620 | 2610
-- A 4.8% trim at N5 and ~1% elsewhere — the pools stay pools, and all seven words the
-- test names are gone. What leaves is what should: the pronouns above, plus entries
-- whose main reading is an expression or interjection and that only earned their slot
-- on a minor noun sense.
--
-- WHAT THIS COSTS. 私, 僕, 俺, あなた, ここ, そこ, どこ stop being quizzable. That is
-- the intended reading of 20260730's rule, not a side effect: these quizzes exist to
-- LOCATE A LEARNER'S LEVEL, and every learner who has met any Japanese knows 私 — a
-- card showing it discriminates nothing. They remain ordinary vocabulary everywhere
-- else in the app (lookup, the reader, saving, review); this filter governs only what
-- the level pool may DRAW.
--
-- The EN branch has no POS filter (English has no POS source — see 20260745) and is
-- untouched, as is v6's surface-keyed seen-exclusion (20260755).
--
-- FORWARD-ONLY: v6 is applied on staging and prod, so it must not be edited.
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
    'ctr', 'aux', 'aux-v', 'aux-adj', 'cop', 'cop-da',
    -- v7: pronouns. `adj-pn` (この, その) was here from the start but `pn` never was,
    -- so これ/それ/ここ/そこ/どこ/私/僕/俺/君 passed on their own POS.
    'pn'
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
           -- v7: keep an entry whose PRIMARY sense is free-standing (non-grammatical).
           -- Was "any sense", which これ cleared on a single minor `adv` reading behind
           -- five pronoun senses. Same primary-sense rule jmdict_lookup uses for `uk`.
           AND EXISTS (
                 SELECT 1 FROM jmdict_senses s
                  WHERE s.entry_id = b.entry_id
                    AND s.position = (SELECT min(s2.position) FROM jmdict_senses s2
                                       WHERE s2.entry_id = b.entry_id)
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
