-- =========================================================
-- learn_words_at_band v8 — the ENGLISH branch stops dealing INFLECTED FORMS.
--
-- THE BUG. A band-4 English draw opened with: found · known · moving · expected ·
-- growing · fighting · learning · planning — 8 of the 40 most frequent candidates were
-- -ing/-ed forms of verbs the learner meets at band 1. The JA branch has no equivalent
-- problem: JMdict headwords ARE dictionary lemmas, so a Japanese card is never a
-- conjugation. English candidates come from a CEFR word list, which bands `expect` (b2)
-- and `expected` (b4) as separate entries, and the pool orders by frequency — exactly
-- where inflections cluster.
--
-- WHY THE OBVIOUS FILTERS ARE WRONG — all measured on prod, 2026-08-12, over the 7,940
-- banded surfaces that clear the WordNet+JA filter:
--
--   "drop anything suffix-derived" — 587 surfaces are derivable from a real WordNet
--   lemma, and the -er/-s rules are mostly NOISE: brother<broth, butter<butt,
--   dinner<din, deer<de, news<new, feed<fe, species<specie. Those rules are safe in the
--   edge's `lemmaCandidates` because the DICTIONARY verifies each candidate; here the
--   verifier is only "the base is a lemma too", which junk passes. So this migration
--   uses the -ing/-ed arms ONLY, min length 6.
--
--   "drop the ones WordNet calls adjectives" — that is 93 -ing + 83 -ed surfaces, and it
--   takes interesting · exciting · boring · amazing · advanced · complicated · married
--   with it. Participial adjectives ARE ordinary vocabulary; POS cannot separate them
--   from expected/convinced (docs/TODO.md said as much).
--
--   "drop the ones whose Japanese is just the base verb's" — the distinct-sense test,
--   and it fails for a structural reason: Japanese nominalizes with the same morpheme,
--   so swimming/swim, dancing/dance, hunting/hunt all share 100% of their WordNet-JA
--   lemmas while building/build share 21%. Worse, the thin-coverage variant drops
--   challenging · prepared · organized · motivated · educated, which have exactly ONE
--   Japanese lemma in wnjpn — an artifact of WordNet-JA coverage, not a word-quality
--   signal.
--
-- WHAT THIS DOES INSTEAD — two instruments, matched to how good each signal is.
--
--   (1) EXCLUDE irregular verb forms outright (c_inflected_en). A card reading `found`
--       or `left` or `saw` is AMBIGUOUS, not merely redundant: the learner cannot tell
--       which word is being asked, so the answer they self-rate is not the one we score.
--       That is a hard defect, so it earns a hard filter. A closed, enumerated class —
--       the same instrument, for the same reason, as c_stopwords_en. 12 land in the pool
--       today: broken fallen found given hidden known left lost rose saw thought worn.
--       ⚠️ Irregular PLURALS are deliberately absent: men · children · feet · people are
--       unambiguous and are ordinary vocabulary. Only past/participle forms are listed.
--
--   (2) DEMOTE regular -ing/-ed participles whose base verb is banded EASIER (sort them
--       behind everything else, don't remove them). The claim "you already know the base,
--       so this card cannot place you" is a real one — but it rests on the CEFR list's own
--       band assignment, which puts `boxing` two bands above `box` and `learning` three
--       above `learn`. Banning on that signal costs learning · planning · parking ·
--       lighting · fighting · coaching · boxing, all of which are genuine cards. So it
--       only reorders: 128 surfaces (1.6% of the pool) sort last and are drawn only when
--       a band would otherwise run short. Same discipline as the leveling profile's
--       "correct only in the SAFE direction" — a weak signal gets a soft instrument.
--
-- MEASURED EFFECT (prod, 2026-08-12) — the top of band 4's frequency order:
--   before: found god times united means known community data energy project federal
--           lower hell related damn version minister moving conference … expected growing
--   after : god times means data community energy project federal lower hell damn version
--           minister conference western particular campaign contract master stock …
--   Demoted per band: b1 0 · b2 19 · b3 42 · b4 56 · b5 8 · b6 3 (of a 7,940-surface
--   pool). Every band keeps ≥666 non-demoted candidates against the 120 a 20-card draw
--   reads, so demotion never starves a draw and never changes what a SMALL draw can see
--   except by removing inflections from it.
--
-- The five words docs/TODO.md named are all handled: found/known by (1), growing ·
-- expected · convinced · attached by (2). The five it warned must SURVIVE all do:
-- building · feeling · blessing (base at the SAME band → not demoted), banking (not a
-- participle), boxing (demoted, still drawable). interesting · exciting are untouched —
-- their bases are banded harder or not at all.
--
-- The JA branch is BYTE-FOR-BYTE v7. FORWARD-ONLY: v7 is applied on staging and prod.
-- =========================================================

-- Base-form candidates for an English -ing/-ed participle. A deliberate SUBSET of the
-- edge function's `lemmaCandidates` (supabase/functions/translate/_lib.ts): same -ing/-ed
-- detachment rules, and NOT its -s/-es/-er/-est rules, which over-generate (see the
-- header). Over-generation within these two arms is still fine — every candidate is
-- verified against english_proficiency AND WordNet before it counts.
CREATE OR REPLACE FUNCTION en_participle_bases(p_surface TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
           -- MIN LENGTH, per arm, so the stem stays 3+ chars: below that the rules produce
           -- noise rather than lemmas. -ed needs 5 (fixed→fix, tired→tire, based→base),
           -- which still excludes the 4-letter junk the rule would otherwise invent
           -- (feed→fe, need→ne, seed→se, aged→ag). -ing needs 6, keeping `being`→`be` out.
           WHEN length(p_surface) < 5 THEN ARRAY[]::TEXT[]
           WHEN p_surface LIKE '%ing' AND length(p_surface) < 6 THEN ARRAY[]::TEXT[]
           WHEN p_surface LIKE '%ing' THEN
             ARRAY[t.s3, t.s3 || 'e']                          -- walking→walk, making→make
             || CASE WHEN t.s3 ~ '([bcdfghjklmnpqrstvwxz])\1$' -- running→run
                     THEN ARRAY[left(t.s3, -1)] ELSE ARRAY[]::TEXT[] END
           WHEN p_surface LIKE '%ed' THEN
             ARRAY[t.s2, left(p_surface, -1)]                  -- walked→walk, liked→like
             || CASE WHEN p_surface LIKE '%ied'                -- studied→study
                     THEN ARRAY[left(p_surface, -3) || 'y'] ELSE ARRAY[]::TEXT[] END
             || CASE WHEN t.s2 ~ '([bcdfghjklmnpqrstvwxz])\1$' -- stopped→stop
                     THEN ARRAY[left(t.s2, -1)] ELSE ARRAY[]::TEXT[] END
           ELSE ARRAY[]::TEXT[]
         END
    FROM (SELECT left(p_surface, -3) AS s3, left(p_surface, -2) AS s2) t
$$;

COMMENT ON FUNCTION en_participle_bases(TEXT) IS
  'Base-form candidates for an English -ing/-ed participle (learn_words_at_band v8). '
  'Subset of the edge function''s lemmaCandidates: -ing/-ed only, min length 6.';

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

-- Same treatment for the new helper. It is pure string math over its argument — it reads
-- no table and takes no user id — but nothing client-side calls it (learn_words_at_band is
-- SECURITY DEFINER and runs as the owner), so it follows the server-only convention.
REVOKE EXECUTE ON FUNCTION en_participle_bases(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION en_participle_bases(TEXT) TO service_role;
