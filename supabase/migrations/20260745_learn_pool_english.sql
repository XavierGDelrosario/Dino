-- =========================================================
-- learn_words_at_band v5 — an ENGLISH (EN→JA) branch.
--
-- v4 (20260730) and every version before it opened with `IF p_source = 'JA' AND
-- p_target = 'EN'` and fell straight through to a zero-row return for anything else.
-- So for a JA-native learner studying ENGLISH both quizzes that read this function —
-- the placement/calibration quiz and the Learn quiz — came back empty. That was the
-- last thing standing between the ingested English leveling data and an English tab:
-- the DATA has been there (english_frequency 321k rows, english_proficiency 8,845
-- CEFR-banded words, migrations 20260721/20260722), and the EN leveling profile is
-- measured (language_leveling, CEFR anchors), but nothing turned it into cards.
--
-- The JA branch is BYTE-FOR-BYTE v4 — untouched. Everything below is additive.
--
-- WHAT PLAYS THE PART OF EACH JA PIECE
--   band source   jmdict_kanji/kana.proficiency_band  →  english_proficiency.band (CEFR,
--                 1=A1 … 6=C2; the ascending-is-harder convention holds, so p_band needs
--                 no remapping — see services/proficiency/framework.ts).
--   headword      jmdict_entry_headword(entry_id)     →  nothing to resolve: an English
--                 surface IS its own headword. No uk/kanji-vs-kana choice, so the whole
--                 headword + DISTINCT ON layer collapses to the PK (surface).
--   frequency     jmdict_kanji/kana.frequency         →  english_frequency.frequency.
--                 Same wordfreq Zipf×100 scale, so the SAME floor constants apply
--                 unchanged (measured below).
--
-- THE POS FILTER HAS NO ENGLISH EQUIVALENT — it is replaced by TWO filters.
-- There is no English POS source (words.part_of_speech on an EN row holds the JMdict POS
-- of the matched JAPANESE sense, which says nothing about the English side), so the
-- filter's PURPOSE — drop anything that isn't a free-standing content word a learner can
-- self-rate — has to be reconstructed:
--
--   (1) The surface must be a WORDNET LEMMA. WordNet holds only nouns, verbs, adjectives
--       and adverbs, so most function words are absent by construction. Measured against
--       the CEFR list, the surfaces WordNet lacks are exactly the ones v4's rule would
--       want gone: 'm / 're / 's, and, because, could, did, does, during, among,
--       although, from, her, him, hers, herself, everybody, else — plus INFLECTIONS
--       (been, had, has, doing), which are just as useless on a card.
--       The lemma is matched as replace(surface, ' ', '_') because WordNet joins
--       multi-word entries with underscores. Without that, real compound vocabulary (bus
--       stop, credit card, high school, department store) would be dropped as if it were
--       a function word — it recovers ~12–30 words per band.
--
--   (2) A CLOSED-CLASS STOPLIST, because (1) alone is NOT enough and the first build of
--       this branch proved it. WordNet lists a content HOMOGRAPH for many function words
--       — "a" (the vitamin), "will" (a testament), "do" (a hairdo), "but", "any" — so
--       they sail through. And because the pool is ordered by frequency, function words
--       are precisely the ones that fill it: measured, band A1's top 40 candidates were
--       ~30 function words (a in i on be as are have at he by but or all so me one can
--       will just like about up out more no do there), and a first draw returned
--       "a, any, but, do, good, make, two, will". A card showing "a" or "but" tests
--       nothing about a learner's LEVEL, which is the sole reason both quizzes exist.
--       With the stoplist the same draw becomes real vocabulary:
--         A1  like time get new people good first two see know think make back want go
--         A2  last state part next ever company thought public government system support
--       English's function words are a genuinely CLOSED class, so an explicit list is the
--       honest instrument here — the same shape as the JA branch's c_excluded_pos, just
--       enumerated by surface instead of by tag. It covers articles/determiners,
--       pronouns, prepositions, conjunctions and connectives, the copula + auxiliaries +
--       modals with their inflections, wh-words, and degree/focus/pro-adverbs.
--       It deliberately does NOT block ordinary frequency adverbs (often, always, never,
--       sometimes) — the JA branch quizzes よく, so blocking their English counterparts
--       would be a divergence, not a parallel.
--       It blocks the SURFACE, so a homographic content sense goes with it ("past" the
--       noun, "can" the container, "may" the month). That is the right trade: a card
--       cannot tell the learner WHICH sense it is asking about, so a surface whose
--       dominant reading is grammatical carries no clean signal either way.
--
-- WE ALSO REQUIRE A JAPANESE SIDE (a wordnet_words_ja row on one of the lemma's synsets).
-- The JA branch can assume a card resolves — every candidate came out of JMdict. An
-- English candidate is drawn from a wordlist that knows nothing about our dictionary, so
-- without this the pool can hand back a headword the EN→JA lookup then fails to
-- translate, and the learner gets a blank card. This gates on the SAME source the edge
-- function's primary EN→JA path uses (wordnet_en_ja_lookup, migration 20260703), so a
-- surviving candidate is one we know we can put Japanese on.
--
-- POOL SIZES after every filter (prod, 2026-08-01):
--   A1 931 · A2 1177 · B1 2040 · B2 2271 · C1 748 · C2 669
-- — one to two orders of magnitude more than a quiz draws, so the random pick stays
-- varied even deep into a user's vocabulary.
--
-- FREQUENCY FLOOR: c_freq_floor / c_top_from are REUSED AS-IS, and the measurement says
-- they transfer. Below the 250 floor, English has 1/4/29 words in A1/A2/B1 (noise — the
-- CEFR list is curated, so the floor has little left to do) but 146/144/270 in B2/C1/C2
-- — the same shape that made the JA branch stop applying the floor from band 4 up. Rare
-- IS what advanced means; the floor exists to catch obscure entries at BEGINNER levels.
--
-- EXPLICIT-CONTENT SKIP: c_blocklist_en mirrors the JA list's intent, which is narrow —
-- it blocks explicitly sexual terms, NOT clinical or identity vocabulary. So 'sex',
-- 'sexy' and 'rape' (all present in the CEFR list) are skipped, while 'gay', 'drug',
-- 'breast' and 'naked' are LEFT IN: they are ordinary vocabulary, and dropping them
-- would be a different and worse editorial decision than the one v4 made in Japanese.
-- The remaining entries are pre-emptive (not in today's wordlist) so a future re-ingest
-- of a larger CEFR list stays covered.
--
-- SEEN-EXCLUSION is keyed on the surface, not on a dictionary id: an EN row's identity in
-- `words` is its English `input`, and the same English word legitimately spans several
-- rows (one per Japanese sense — bank → 銀行 / 岸), so entry-id matching would let a word
-- the user already has come back. lower() because the user's own lookup may have been
-- capitalized while the wordlist is lowercased.
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
