-- =========================================================
-- Two EN→JA fixes that share one projection bump.
--
-- ─────────────────────────────────────────────────────────
-- 1. ENGLISH MONOLINGUAL DEFINITION — data we already had, read by nothing.
--
-- `wordnet_synsets.definition_en` is populated for every synset by
-- scripts/ingest-wordnet.ts, and EN→JA lookup already resolves THROUGH those synsets
-- to pick its Japanese translations. The definition was in the query and thrown away
-- at the last step — the same shape of miss as the POS in 20260760.
--
-- IT LANDS IN AN EXISTING COLUMN. `words.definition_source` means "monolingual
-- definition of this sense IN THE SOURCE LANGUAGE" (20260752 renamed it from
-- definition_ja for exactly this reason). Source is the language being LEARNED
-- (CLAUDE.md: in Translate `source` = the learning language), so a JA→EN row carries a
-- Japanese definition of its Japanese headword and an EN→JA row now carries an English
-- definition of its English headword. Perfect mirror, no new column, no client schema
-- change, and nothing to degrade on an un-migrated environment.
--
-- ‼️ THE DEFINITION IS PER SENSE, and that is the point. Each EN→JA row comes from the
-- synset that WON the ranking for that Japanese lemma (identical rule to `pos` in
-- 20260760), so the rows for "spring" carry three DIFFERENT definitions — the season,
-- the water source, the coil — attached to 春 / 泉 / ばね respectively. A learner
-- choosing between them stops guessing from the Japanese alone. This is a partial
-- answer to the "sense disambiguation in context" gap and needed no new data.
--
-- WHY NOT jmdict_lookup TOO. Its EN→JA branch is the reverse-gloss FALLBACK, used for
-- words WordNet lacks — and if WordNet lacks the word there is no English definition to
-- give. NULL is the honest answer, exactly as 20260760 argued for POS. Its signature is
-- therefore unchanged; only its reading CASE is touched (below).
--
-- ─────────────────────────────────────────────────────────
-- 2. 🐞 A KATAKANA MEANING REPEATED ITSELF.
--
-- EN→JA renders the meaning with its reading above it, but a katakana word IS its own
-- reading, so the reader showed コンピューター(コンピューター). Measured on prod: 679 of
-- 779 katakana EN→JA rows carried a `translation_reading`, and ALL 679 were
-- character-identical to the translation.
--
-- Root cause is one CASE arm, duplicated in both EN→JA emitters:
--     writing = CASE WHEN is_uk THEN kana ELSE COALESCE(kanji, kana) END
--     reading = CASE WHEN is_uk THEN NULL ELSE kana END
-- When an entry has no kanji at all (every katakana loanword), the writing FALLS BACK
-- to the kana and the reading is that same kana. The `uk` arm already got this right —
-- it NULLs the reading precisely because the kana became the writing — the plain
-- kana-only case was just never carried through.
--
-- This is the mirror of a rule JA→EN has always had: jmdict_lookup's JA→EN branch emits
-- `input_reading` only `WHEN pref.kanji IS NOT NULL`, so a kana-only headword annotates
-- itself with nothing. Same rule, other side.
--
-- Stated once, as the invariant rather than as a special case: A READING IDENTICAL TO
-- ITS OWN TERM IS NOT A READING. NULLIF says that literally, and it also covers any
-- future path that reaches the same collision by another route.
--
-- ‼️ jmdict_entry_headword_mv carries the same arm and is deliberately NOT rebuilt.
-- Its `reading` has exactly one consumer — wordnet_en_ja_lookup, fixed here at the
-- point of emission — and the other MV readers (learn_words_at_band and friends) take
-- only `writing`/`proficiency_band`. Fixing it there would rebuild 217k rows to change
-- a value nothing else reads.
--
-- ─────────────────────────────────────────────────────────
-- CURRENT_PROJECTION_VERSION is bumped alongside this (13 → 14) so cached EN→JA rows
-- re-project on next use: without it the definition only ever reaches words nobody has
-- looked up yet, and the 679 doubled readings stay doubled forever. Re-projection is a
-- free jmdict/WordNet re-resolve, never a paid MT call (MT rows are exempt by
-- dictionary_ref — see src/lib/projection.ts).
-- =========================================================

-- Adding an output column changes the return type, which CREATE OR REPLACE cannot do —
-- both must be dropped. The wrapper goes first: it is the one with a caller (the edge's
-- lookupWordNetMany), so this order never leaves a live batch path pointing at a
-- half-updated pair.
DROP FUNCTION IF EXISTS wordnet_en_ja_lookup_many(TEXT[]);
DROP FUNCTION IF EXISTS wordnet_en_ja_lookup(TEXT);

CREATE FUNCTION wordnet_en_ja_lookup(p_input TEXT)
RETURNS TABLE (
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,   -- always NULL for EN->JA (mirrors jmdict_lookup)
  jmdict_entry_id      TEXT,
  frequency            INT,
  proficiency_band     SMALLINT,
  part_of_speech       TEXT[],
  definition_en        TEXT    -- NEW: the winning synset's English definition
)
LANGUAGE sql
STABLE
AS $$
  WITH syn AS (
    -- synsets for the English lemma (lowercased; input is NFC-normalized upstream),
    -- carrying the synset's English part of speech (n/v/a/r) AND its English
    -- definition. definition_en is in the GROUP BY explicitly: it is functionally
    -- dependent on the synset PK, but the group key here is se.synset_id and Postgres
    -- does not infer the dependency across the join.
    SELECT se.synset_id, MIN(se.sense_rank) AS rank, sy.pos, sy.definition_en
      FROM wordnet_senses_en se
      JOIN wordnet_synsets sy ON sy.synset_id = se.synset_id
     WHERE se.lemma = lower(btrim(p_input))
     GROUP BY se.synset_id, sy.pos, sy.definition_en
  ),
  ja AS (
    -- Japanese lemmas across those synsets; best (lowest) sense_rank per lemma, and the
    -- POS *and DEFINITION* of the synset that WON — a lemma reachable from both a noun
    -- and a verb synset takes the sense the ranking actually picked, not an arbitrary
    -- one. This is what makes the definition describe THIS row's translation.
    SELECT DISTINCT ON (wj.lemma) wj.lemma, syn.rank, syn.pos, syn.definition_en
      FROM wordnet_words_ja wj
      JOIN syn ON syn.synset_id = wj.synset_id
     ORDER BY wj.lemma, syn.rank ASC NULLS LAST
  ),
  resolved AS (
    -- resolve each JA lemma to its single best JMdict entry, then its headword.
    SELECT e.entry_id, ja.rank, ja.pos AS en_pos, ja.definition_en AS en_definition,
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
           r.entry_id, r.rank, r.en_pos, r.en_definition, r.writing, r.reading,
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
    -- A READING IDENTICAL TO ITS OWN TERM IS NOT A READING (header §2): every katakana
    -- loanword headwords as its own kana, and コンピューター(コンピューター) is noise.
    NULLIF(d.reading, d.writing)                                AS translation_reading,
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
    -- THE ENGLISH word's part of speech, not the Japanese translation's (20260760).
    CASE WHEN d.en_pos IS NULL THEN NULL ELSE ARRAY[d.en_pos] END AS part_of_speech,
    -- ...and the English DEFINITION of that same winning synset, so the POS and the
    -- definition always describe one sense rather than two.
    d.en_definition                                             AS definition_en
  FROM dedup d
  ORDER BY sense_position
  LIMIT 12;
$$;

-- Thin batch wrapper — unchanged in shape, extended by one column to match. It is a
-- LATERAL over the single lookup, so it inherits every fix automatically; the ONLY
-- reason it appears in this migration is that RETURNS TABLE is written out by hand and
-- would otherwise drop the new column on the floor.
CREATE FUNCTION wordnet_en_ja_lookup_many(p_inputs TEXT[])
RETURNS TABLE(input TEXT, translation TEXT, input_reading TEXT, translation_reading TEXT,
              sense_position INTEGER, writing TEXT, jmdict_entry_id TEXT,
              frequency INTEGER, proficiency_band SMALLINT, part_of_speech TEXT[],
              definition_en TEXT)
LANGUAGE sql STABLE
AS $$
  SELECT i.input, l.translation, l.input_reading, l.translation_reading,
         l.sense_position, l.writing, l.jmdict_entry_id, l.frequency, l.proficiency_band,
         l.part_of_speech, l.definition_en
  FROM unnest(p_inputs) WITH ORDINALITY AS i(input, ord)
  CROSS JOIN LATERAL wordnet_en_ja_lookup(i.input) AS l
  ORDER BY i.ord, l.sense_position NULLS LAST
$$;

-- ‼️ A freshly CREATEd function is EXECUTE-able by PUBLIC by default, so the revoke is
-- not optional — these read the server-only wordnet_*/jmdict_* tables and must stay
-- reachable only by the edge's service role (same lockdown as 20260725/20260748).
REVOKE ALL ON FUNCTION wordnet_en_ja_lookup(TEXT)        FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION wordnet_en_ja_lookup_many(TEXT[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT)        TO service_role;
GRANT EXECUTE ON FUNCTION wordnet_en_ja_lookup_many(TEXT[]) TO service_role;

-- ─────────────────────────────────────────────────────────
-- The gloss FALLBACK: same reading fix, no signature change (header §1, "WHY NOT
-- jmdict_lookup TOO"). Body is 20260760's verbatim apart from the EN→JA reading arm,
-- so a diff against that file shows exactly one changed expression.
-- ─────────────────────────────────────────────────────────
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
        -- symmetric with the frequency CASE above — see 20260740.
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
               -- THE ENTRY THAT IS ACTUALLY WRITTEN THIS WAY COMES FIRST (20260758).
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
        -- THE ENGLISH input's part of speech (20260760): the POS set WordNet records
        -- for this lemma, or NULL when it has no entry — never the Japanese
        -- translation's tags, which is what this used to return.
        (SELECT array_agg(DISTINCT sy.pos ORDER BY sy.pos)
           FROM wordnet_senses_en se
           JOIN wordnet_synsets sy ON sy.synset_id = se.synset_id
          WHERE se.lemma = lower(btrim(p_input)))         AS part_of_speech
      FROM ent
      JOIN LATERAL (
        SELECT
          CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END AS writing,
          -- ⬇️ THE ONE CHANGED EXPRESSION (header §2). Was `WHEN uk.is_uk THEN NULL
          -- ELSE ka.text`, which handed back the kana as a "reading" of itself whenever
          -- the entry had no kanji for the writing to prefer — i.e. for every katakana
          -- loanword, the single commonest shape of EN→JA result.
          CASE WHEN uk.is_uk        THEN NULL
               WHEN kj.text IS NULL THEN NULL   -- kana-only: the writing IS the reading
               ELSE ka.text END                                              AS reading,
          COALESCE(kj.common, ka.common, FALSE)  AS is_common,
          -- OWN value of the shown writing (no kana fallback for a chosen kanji).
          CASE WHEN uk.is_uk THEN ka.frequency
               WHEN kj.text IS NOT NULL THEN kj.frequency
               ELSE ka.frequency END                                          AS frequency,
          -- Shown writing's own band, ELSE the entry's kanji band (20260740).
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

-- The column now has TWO sources, and the old comment named only one. Authored curation
-- still wins where it exists; the edge merges with `??` rather than `=` so a curation
-- row written for some other field cannot blank a generated definition.
COMMENT ON COLUMN words.definition_source IS
  'Monolingual definition of this sense IN THE SOURCE LANGUAGE. JA→EN: authored, from sense_curation. EN→JA: generated, the definition_en of the WordNet synset this sense resolved through (20260764). Curation wins where both exist.';
