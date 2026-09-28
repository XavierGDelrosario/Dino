-- =========================================================
-- Learn / calibration pool v9: no katakana, no affixes.
--
-- learn_words_at_band deals the level quiz (Learn) AND the calibration quiz ("Find my
-- level"). Two kinds of card kept slipping in:
--   · AFFIXES — v7 dropped an entry only when its primary sense had NO free-standing
--     tag, so "noun, suffix" entries passed. Now any prefix/suffix tag on the primary
--     sense excludes it (c_affix_pos).
--   · KATAKANA — loanwords are a different kind of study, and near-free for an
--     English-native learner, so they skew both a placement and a level quiz.
-- Everything else is 20260761 unchanged, including the grants (see the note above them).
-- The JA→EN branch only: EN→JA draws English words, which have neither issue.
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
  -- v9: affix tags. An entry whose PRIMARY sense carries any of these is not dealt,
  -- even when it also has a free-standing tag.
  c_affix_pos CONSTANT TEXT[] := ARRAY['pref', 'suf', 'n-suf', 'n-pref'];
  -- Explicit-content skip for a placement/learn context (minimal, extensible).
  c_blocklist  CONSTANT TEXT[] := ARRAY['セックス','エッチ','エロ','ポルノ'];
  -- The same skip for English, same narrow intent (see the header).
  c_blocklist_en CONSTANT TEXT[] := ARRAY[
    'sex', 'sexy', 'rape', 'porn', 'pornography', 'erotic', 'nude'
  ];
  -- ENGLISH CLOSED-CLASS STOPLIST — the surface half of the JA branch's c_excluded_pos.
  -- WordNet membership alone lets function words through on a content homograph ("a" the
  -- vitamin, "will" the testament); see 20260745 for the measurement. Grouped by class
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
  -- v8: IRREGULAR VERB FORMS — past tenses and participles the detachment rules cannot
  -- derive, so nothing else in this function can see them. A card showing one is
  -- AMBIGUOUS (`saw` the tool vs the past of see; `left` the direction vs the past of
  -- leave), and a learner who self-rates the wrong word is scored on the wrong word.
  -- Excluded outright — the cost is that the flower `rose`, the direction `left` and the
  -- tool `saw` stop being QUIZZABLE, exactly as 私 did in v7; they remain ordinary
  -- vocabulary everywhere else in the app.
  -- Irregular PLURALS are NOT here on purpose: men · women · children · feet · teeth ·
  -- people are unambiguous cards and belong in the pool.
  c_inflected_en CONSTANT TEXT[] := ARRAY[
    'went', 'gone', 'got', 'gotten', 'made', 'knew', 'known', 'thought', 'took', 'taken',
    'saw', 'seen', 'came', 'gave', 'given', 'found', 'told', 'became', 'left', 'felt',
    'brought', 'began', 'begun', 'kept', 'held', 'wrote', 'written', 'stood', 'heard',
    'meant', 'met', 'ran', 'paid', 'sat', 'spoke', 'spoken', 'led', 'grew', 'grown',
    'lost', 'fell', 'fallen', 'sent', 'built', 'understood', 'drew', 'drawn', 'broke',
    'broken', 'spent', 'rose', 'risen', 'drove', 'driven', 'bought', 'wore', 'worn',
    'chose', 'chosen', 'sought', 'threw', 'thrown', 'caught', 'dealt', 'won', 'forgot',
    'forgotten', 'ate', 'eaten', 'taught', 'sold', 'flew', 'flown', 'fought', 'hid',
    'hidden'
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
      -- draw sees (see 20260755). Read off user_words directly so standalone created
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
           -- v9: no affix at all on the PRIMARY sense. v7 only required ONE free-standing
           -- tag, so an entry tagged "noun, suffix" (〜さん-like) still came through.
           AND NOT EXISTS (
                 SELECT 1 FROM jmdict_senses s
                  WHERE s.entry_id = b.entry_id
                    AND s.position = (SELECT min(s2.position) FROM jmdict_senses s2
                                       WHERE s2.entry_id = b.entry_id)
                    AND s.part_of_speech && c_affix_pos)
           -- v9: no katakana-only headwords — loanwords are a different kind of study
           -- (and trivial for the English-native learner this pool mostly serves).
           AND hw.writing !~ '^[ァ-ヶー・＝]+$'
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
        -- keyed on the SURFACE, not a dictionary id (see 20260745).
        SELECT DISTINCT lower(w.input) AS surface
          FROM user_words uw
          JOIN words w ON w.word_id = uw.dictionary_word_id
         WHERE uw.user_id = p_user_id
           AND w.source_lang = 'EN'
      ),
      cand AS (
        -- surface is english_proficiency's PK, so there is nothing to de-duplicate.
        SELECT p.surface, f.frequency AS freq,
               -- v8: a regular -ing/-ed participle whose BASE VERB is banded easier —
               -- sorted last rather than removed (see the header: the signal is the CEFR
               -- list's own banding, which is too coarse to ban on). The LIKE guard keeps
               -- the lookup off the ~90% of candidates that are not participle-shaped.
               ((p.surface LIKE '%ing' OR p.surface LIKE '%ed')
                 AND EXISTS (
                       SELECT 1
                         FROM unnest(en_participle_bases(p.surface)) AS b(base)
                         JOIN english_proficiency bp ON bp.surface = b.base
                        WHERE bp.band < p.band
                          -- the base must be a VERB, or `corner`<`corn` and `better`<`bet`
                          -- style coincidences would demote real vocabulary.
                          AND EXISTS (
                                SELECT 1 FROM wordnet_senses_en se
                                  JOIN wordnet_synsets sy ON sy.synset_id = se.synset_id
                                 WHERE se.lemma = b.base AND sy.pos = 'v'))) AS derived
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
           -- function words, because they are the most frequent — see 20260745.
           AND p.surface <> ALL (c_stopwords_en)
           -- v8: irregular verb forms — an ambiguous card, not a redundant one.
           AND p.surface <> ALL (c_inflected_en)
           -- explicit-content skip.
           AND p.surface <> ALL (c_blocklist_en)
      ),
      gated AS (
        SELECT surface, freq, derived FROM cand
         WHERE p_band >= c_top_from
            OR (freq IS NOT NULL AND freq >= c_freq_floor)
      ),
      pool AS (
        -- v8: `derived` leads the sort (FALSE first), so participles fill the pool only
        -- once the band's own vocabulary is exhausted.
        SELECT surface FROM gated
         ORDER BY derived, freq DESC NULLS LAST, surface
         LIMIT GREATEST(COALESCE(p_limit, 0) * 6, 40)
      )
      SELECT surface FROM pool
       ORDER BY random()
       LIMIT GREATEST(COALESCE(p_limit, 0), 0);
  END IF;
END;
$$;

-- ‼️ `FROM PUBLIC, anon, authenticated` — NOT just PUBLIC. On hosted Supabase an
-- ALTER DEFAULT PRIVILEGES grants EXECUTE to anon/authenticated on every newly CREATED
-- function, and a PUBLIC-only revoke does not remove it. Every migration that re-creates
-- this function must repeat this, or it re-opens the leak 20260748 closed: the function
-- is SECURITY DEFINER over a caller-supplied p_user_id, so a client could diff
-- p_exclude_seen true/false to infer another user's saved words. (v7 shipped the
-- PUBLIC-only form; this migration re-creates the function, so it would have re-opened it.)
REVOKE EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION learn_words_at_band(TEXT, TEXT, SMALLINT, TEXT, INTEGER, BOOLEAN)
  TO service_role;
