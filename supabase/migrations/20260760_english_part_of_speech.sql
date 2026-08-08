-- =========================================================
-- words.part_of_speech describes the WORD, not its translation.
--
-- THE BUG. For an EN→JA row, `words.input` is the ENGLISH term — but part_of_speech
-- was filled from the matched JAPANESE entry. So `a` (the English article) carried
-- {n}, because the Japanese sense it resolved to (アンペア) is a noun. Every English row
-- has been annotated with the word class of a different word, in a different language.
--
-- The knock-on: docs/TODO.md files "No English POS source" as THE blocker for English —
-- no POS offsets in the leveling profile, no proper-noun demotion, a hand-written
-- 24-word exclusion list in the reader's lemmatizer standing in for one. That premise
-- was wrong. We have had an English POS all along: `wordnet_synsets.pos`, populated for
-- every synset — 82,115 n · 18,156 a · 13,767 v · 3,621 r — and EN→JA lookup already
-- resolves THROUGH those synsets. The data was in the query and thrown away at the last
-- step.
--
-- WHAT EACH PATH NOW RETURNS
--   wordnet_en_ja_lookup  the POS of the synset that WON the ranking — per SENSE, which
--                         is the same granularity JMdict gives the Japanese side, so the
--                         leveling profile can treat both alike.
--   jmdict_lookup (EN→JA) the POS SET WordNet records for the input lemma, or NULL when
--                         it has none. This is the gloss FALLBACK, used for words
--                         WordNet lacks — and if WordNet lacks the word we genuinely do
--                         not know its English POS, so NULL is the honest answer rather
--                         than borrowing the Japanese one.
--
-- JA→EN is untouched: there `input` IS the Japanese word and JMdict's tags describe it
-- correctly. Only the EN→JA direction was mislabelled.
--
-- NOT A TAGGER. This is POS per lemma/sense, not per token in context — it cannot tell
-- "I saw a cat" from "a rusty saw". Neither can the Japanese side: JMdict POS is
-- per-sense too, and the leveling profile uses it anyway. For leveling this is an
-- equal-quality signal; for in-context disambiguation neither language has one.
--
-- CURRENT_PROJECTION_VERSION is bumped alongside this so cached EN rows re-project on
-- next use rather than keeping the Japanese tags forever.
-- =========================================================

CREATE OR REPLACE FUNCTION wordnet_en_ja_lookup(p_input TEXT)
RETURNS TABLE (
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,   -- always NULL for EN->JA (mirrors jmdict_lookup)
  jmdict_entry_id      TEXT,
  frequency            INT,
  proficiency_band     SMALLINT,   -- added by 20260716 / 20260740; NOT in 20260703
  part_of_speech       TEXT[]
)
LANGUAGE sql
STABLE
AS $$
  WITH syn AS (
    -- synsets for the English lemma (lowercased; input is NFC-normalized upstream),
    -- now carrying the synset's ENGLISH part of speech (n/v/a/r).
    SELECT se.synset_id, MIN(se.sense_rank) AS rank, sy.pos
      FROM wordnet_senses_en se
      JOIN wordnet_synsets sy ON sy.synset_id = se.synset_id
     WHERE se.lemma = lower(btrim(p_input))
     GROUP BY se.synset_id, sy.pos
  ),
  ja AS (
    -- Japanese lemmas across those synsets; best (lowest) sense_rank per lemma, and
    -- the POS of the synset that WON — a lemma reachable from both a noun and a verb
    -- synset takes the sense the ranking actually picked, not an arbitrary one.
    SELECT DISTINCT ON (wj.lemma) wj.lemma, syn.rank, syn.pos
      FROM wordnet_words_ja wj
      JOIN syn ON syn.synset_id = wj.synset_id
     ORDER BY wj.lemma, syn.rank ASC NULLS LAST
  ),
  resolved AS (
    -- resolve each JA lemma to its single best JMdict entry, then its headword.
    SELECT e.entry_id, ja.rank, ja.pos AS en_pos,
           hw.writing, hw.reading, hw.is_common, hw.frequency,
           hw.proficiency_band, hw.part_of_speech
      FROM ja
      JOIN LATERAL (
        SELECT cand.entry_id
          FROM (
            SELECT kj.entry_id, kj.common AS c, kj.frequency AS f, 0 AS src
              FROM jmdict_kanji kj WHERE kj.text = ja.lemma
            UNION ALL
            SELECT ka.entry_id, ka.common, ka.frequency, 1
              FROM jmdict_kana ka WHERE ka.text = ja.lemma
          ) cand
         -- prefer a common surface, then a higher-frequency one, kanji over kana.
         ORDER BY cand.c DESC, cand.f DESC NULLS LAST, cand.src ASC
         LIMIT 1
      ) e ON TRUE
      CROSS JOIN LATERAL jmdict_entry_headword(e.entry_id) hw
  ),
  headline AS (
    -- HOW PRIMARY the English word is inside each candidate entry — identical to
    -- jmdict_lookup's (20260742):
    --   0 = first gloss of the first sense — the entry MEANS this word
    --   1 = first sense, later gloss
    --   2 = a later sense
    -- (absent → 9 below: WordNet linked it semantically and the dictionary does not
    -- confirm it lexically.) Restricted to the entries WordNet actually produced, so
    -- this is a handful of id lookups, not the full gloss scan jmdict_lookup runs.
    SELECT s.entry_id,
           MIN(CASE
                 WHEN (lower(gl.text) = lower(p_input) OR lower(gl.text) = 'to ' || lower(p_input))
                   OR gl.text ~* ('^(to )?' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '($|[;,]| \()')
                 THEN (CASE WHEN s.position = 0 AND gl.position = 0 THEN 0
                            WHEN s.position = 0 THEN 1
                            ELSE 2 END)
                 ELSE 9
               END) AS headline_rank
      FROM jmdict_senses s
      JOIN jmdict_glosses gl ON gl.sense_id = s.id
     WHERE s.entry_id IN (SELECT entry_id FROM resolved)
     GROUP BY s.entry_id
  ),
  dedup AS (
    -- one row per entry (a synset's lemmas, or a lemma's homographs, can collide
    -- on the same entry); keep the best-ranked occurrence.
    SELECT DISTINCT ON (r.entry_id)
           r.entry_id, r.rank, r.en_pos, r.writing, r.reading,
           r.is_common, r.frequency, r.proficiency_band, r.part_of_speech,
           COALESCE(h.headline_rank, 9) AS headline_rank
      FROM resolved r
      LEFT JOIN headline h ON h.entry_id = r.entry_id
     WHERE r.writing IS NOT NULL
     ORDER BY r.entry_id, r.rank ASC NULLS LAST, r.frequency DESC NULLS LAST
  )
  SELECT
    d.writing                                                   AS translation,
    NULL::TEXT                                                  AS input_reading,
    d.reading                                                   AS translation_reading,
    -- contiguous rank: match QUALITY first (does this entry mean the word, and how
    -- primarily), then WordNet's sense order, then corpus frequency as the tiebreak
    -- among equals — the same discipline JA→EN and jmdict_lookup follow.
    (ROW_NUMBER() OVER (ORDER BY d.headline_rank ASC,
                                 d.rank ASC NULLS LAST,
                                 d.frequency DESC NULLS LAST,
                                 d.is_common DESC))::INT - 1     AS sense_position,
    NULL::TEXT                                                  AS writing,
    d.entry_id                                                  AS jmdict_entry_id,
    d.frequency                                                 AS frequency,
    d.proficiency_band                                          AS proficiency_band,
    -- THE ENGLISH word's part of speech, not the Japanese translation's.
    CASE WHEN d.en_pos IS NULL THEN NULL ELSE ARRAY[d.en_pos] END AS part_of_speech
  FROM dedup d
  ORDER BY sense_position
  LIMIT 12;
$$;

REVOKE EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION jmdict_lookup(p_input TEXT, p_source TEXT, p_target TEXT)
RETURNS TABLE (
  translation TEXT, input_reading TEXT, translation_reading TEXT, sense_position INT,
  writing TEXT, jmdict_entry_id TEXT, frequency INT, proficiency_band SMALLINT,
  part_of_speech TEXT[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$

BEGIN
  IF p_source = 'JA' AND p_target = 'EN' THEN
    RETURN QUERY
      SELECT
        (SELECT string_agg(gl.text, '; ' ORDER BY gl.position)
           FROM jmdict_glosses gl
          WHERE gl.sense_id = s.id)                       AS translation,
        CASE
          WHEN pref.is_uk THEN pref.kanji
          WHEN pref.kanji IS NOT NULL THEN pref.kana
          ELSE NULL
        END                                               AS input_reading,
        NULL::TEXT                                        AS translation_reading,
        s.position                                        AS sense_position,
        CASE
          WHEN pref.is_uk THEN pref.kana
          WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji
          ELSE COALESCE(pref.kanji, pref.kana)
        END                                               AS writing,
        s.entry_id                                        AS jmdict_entry_id,
        -- OWN frequency of the shown writing (no kana fallback for a chosen kanji).
        CASE
          WHEN pref.is_uk THEN pref.kana_freq
          WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_freq
          WHEN pref.kanji IS NOT NULL THEN pref.kanji_freq
          ELSE pref.kana_freq
        END                                               AS frequency,
        -- Shown writing's own band, ELSE the entry's kanji band. Deliberately NOT
        -- symmetric with the frequency CASE above — see the migration header.
        COALESCE(
          CASE
            WHEN pref.is_uk THEN pref.kana_band
            WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_band
            WHEN pref.kanji IS NOT NULL THEN pref.kanji_band
            ELSE pref.kana_band
          END,
          jmdict_entry_kanji_band(s.entry_id)
        )                                               AS proficiency_band,
        s.part_of_speech                                  AS part_of_speech
      FROM jmdict_senses s
      JOIN LATERAL (
        SELECT
          (SELECT kj.text FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji,
          (SELECT k.text FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana,
          (SELECT kj.frequency FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji_freq,
          (SELECT k.frequency FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana_freq,
          (SELECT kj.proficiency_band FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji_band,
          (SELECT k.proficiency_band FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana_band,
          (SELECT kj.text FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND kj.text = p_input LIMIT 1) AS matched_kanji,
          (SELECT kj.frequency FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND kj.text = p_input LIMIT 1) AS matched_kanji_freq,
          (SELECT kj.proficiency_band FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND kj.text = p_input LIMIT 1) AS matched_kanji_band,
          (COALESCE((SELECT bool_or(common) FROM jmdict_kana  WHERE entry_id = s.entry_id), FALSE)
           OR COALESCE((SELECT bool_or(common) FROM jmdict_kanji WHERE entry_id = s.entry_id), FALSE))
                                                              AS is_common,
          COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                     WHERE sn.entry_id = s.entry_id ORDER BY sn.position ASC LIMIT 1), FALSE)
                                                              AS is_uk
      ) pref ON TRUE
      WHERE s.entry_id IN (
              SELECT entry_id FROM jmdict_kanji WHERE text = p_input
              UNION
              SELECT entry_id FROM jmdict_kana  WHERE text = p_input
            )
      ORDER BY
               -- THE ENTRY THAT IS ACTUALLY WRITTEN THIS WAY COMES FIRST.
               -- Only when the user typed KANJI: a `uk` entry headwords as its KANA, so
               -- it can win the frequency race on a reading the user never typed. 質 was
               -- the report — 質/quality (465) lost to 質-read-たち/disposition, whose
               -- headword is たち (577), so a search for 質 answered with たち and
               -- "quality" was pushed below the fold under a word that looked unrelated.
               -- Guarded to kanji input so the kana case is untouched: ねこ must still
               -- answer 猫 on frequency, not promote some kana-headword entry above it.
               (CASE WHEN p_input ~ '[一-龥]'
                      AND (CASE
                             WHEN pref.is_uk THEN pref.kana
                             WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji
                             ELSE COALESCE(pref.kanji, pref.kana)
                           END) = p_input
                     THEN 1 ELSE 0 END) DESC,
               (CASE
                  WHEN pref.is_uk THEN pref.kana_freq
                  WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_freq
                  WHEN pref.kanji IS NOT NULL THEN pref.kanji_freq
                  ELSE pref.kana_freq
                END) DESC NULLS LAST,
               pref.is_common DESC, s.entry_id, s.position;

  ELSIF p_source = 'EN' AND p_target = 'JA' THEN
    RETURN QUERY
      WITH ent AS (
        SELECT s.entry_id,
               MIN(s.position) AS first_sense,
               MAX(CASE
                     WHEN (lower(gl.text) = lower(p_input) OR lower(gl.text) = 'to ' || lower(p_input)) THEN 3
                     WHEN gl.text ~* ('^(to )?' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '($|[;,]| \()') THEN 2
                     ELSE 1
                   END) AS match_rank,
               MAX(CASE WHEN s.position <= 1 AND (
                          (lower(gl.text) = lower(p_input) OR lower(gl.text) = 'to ' || lower(p_input))
                          OR gl.text ~* ('^(to )?' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '($|[;,]| \()')
                        ) THEN 1 ELSE 0 END) AS central
          FROM jmdict_senses s
          JOIN jmdict_glosses gl ON gl.sense_id = s.id
         WHERE gl.text ~* ('\y' || regexp_replace(p_input, '[][(){}.^$*+?|\\-]', '\\&', 'g') || '\y')
         GROUP BY s.entry_id
      )
      SELECT
        pref.writing                                      AS translation,
        NULL::TEXT                                        AS input_reading,
        pref.reading                                      AS translation_reading,
        (ROW_NUMBER() OVER (ORDER BY (ent.match_rank >= 2) DESC, ent.central DESC,
                                     pref.frequency DESC NULLS LAST,
                                     pref.is_common DESC, ent.first_sense ASC))::INT - 1
                                                          AS sense_position,
        NULL::TEXT                                        AS writing,
        ent.entry_id                                      AS jmdict_entry_id,
        pref.frequency                                    AS frequency,
        pref.proficiency_band                             AS proficiency_band,
        -- THE ENGLISH input's part of speech (see the migration header): the POS set
        -- WordNet records for this lemma, or NULL when it has no entry — never the
        -- Japanese translation's tags, which is what this used to return.
        (SELECT array_agg(DISTINCT sy.pos ORDER BY sy.pos)
           FROM wordnet_senses_en se
           JOIN wordnet_synsets sy ON sy.synset_id = se.synset_id
          WHERE se.lemma = lower(btrim(p_input)))         AS part_of_speech
      FROM ent
      JOIN LATERAL (
        SELECT
          CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END AS writing,
          CASE WHEN uk.is_uk THEN NULL ELSE ka.text END                       AS reading,
          COALESCE(kj.common, ka.common, FALSE)  AS is_common,
          -- OWN value of the shown writing (no kana fallback for a chosen kanji).
          CASE WHEN uk.is_uk THEN ka.frequency
               WHEN kj.text IS NOT NULL THEN kj.frequency
               ELSE ka.frequency END                                          AS frequency,
          -- Shown writing's own band, ELSE the entry's kanji band (header).
          COALESCE(
            CASE WHEN uk.is_uk THEN ka.proficiency_band
                 WHEN kj.text IS NOT NULL THEN kj.proficiency_band
                 ELSE ka.proficiency_band END,
            jmdict_entry_kanji_band(ent.entry_id))                                   AS proficiency_band
        FROM (SELECT kk.text, kk.common, kk.frequency, kk.proficiency_band FROM jmdict_kanji kk
               WHERE kk.entry_id = ent.entry_id
               ORDER BY kk.common DESC, kk.position ASC LIMIT 1) kj
        FULL JOIN (SELECT nn.text, nn.common, nn.frequency, nn.proficiency_band FROM jmdict_kana nn
                    WHERE nn.entry_id = ent.entry_id
                    ORDER BY nn.common DESC, nn.position ASC LIMIT 1) ka ON TRUE
        CROSS JOIN LATERAL (
          SELECT COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                            WHERE sn.entry_id = ent.entry_id
                            ORDER BY sn.position ASC LIMIT 1), FALSE) AS is_uk
        ) uk
      ) pref ON TRUE
      WHERE pref.writing IS NOT NULL
      ORDER BY sense_position
      LIMIT 12;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jmdict_lookup(TEXT, TEXT, TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION jmdict_lookup(TEXT, TEXT, TEXT) TO service_role;
