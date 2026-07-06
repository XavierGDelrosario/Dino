-- =========================================================
-- PROFICIENCY LABEL axis (JLPT / CEFR / …) — a curated, per-language proficiency
-- band shown as extra info on a word, and (later) the filter for a level-based
-- new-words quiz.
--
-- ONE generic concept, NOT a per-language feature: the band is a raw ordinal and
-- the FRAMEWORK is derived from source_lang (JA→JLPT, EN→CEFR) by the client
-- registry (services/proficiency). Adding a language's scale = a wordlist + a
-- registry entry, never a new column. Deliberately DISTINCT from:
--   * the DIFFICULTY axis (words.frequency / difficulty_override) — COMPUTED, and
--   * the RELATEDNESS axis (word_embeddings) — SEMANTIC.
-- Never conflate the three.
--
-- CONVENTION: proficiency_band is ALWAYS ascending = HARDER regardless of how the
-- framework labels itself (JLPT N5→1 … N1→5; CEFR A1→1 … C2→6), so the raw value
-- is a valid per-language ordering with no normalization.
--
-- MODEL (mirrors `frequency` exactly): the band is a per-SURFACE attribute on the
-- JMdict source (jmdict_kanji/kana), populated at ingest by joining
-- data/proficiency/<lang>.tsv BY SURFACE (scripts/ingest-jmdict.ts). The lookup
-- functions take the HEADWORD's band (same headword pick as frequency — preferred
-- kanji, or kana for uk) and the edge function projects it onto words.proficiency_band.
-- =========================================================

-- 1. Destination + source columns (band is a deterministic global attribute of the
--    headword, so NOT part of any UNIQUE key — same as frequency / input_reading).
ALTER TABLE words
  ADD COLUMN IF NOT EXISTS proficiency_band SMALLINT
    CHECK (proficiency_band IS NULL OR proficiency_band BETWEEN 1 AND 6);

ALTER TABLE jmdict_kanji ADD COLUMN IF NOT EXISTS proficiency_band SMALLINT;
ALTER TABLE jmdict_kana  ADD COLUMN IF NOT EXISTS proficiency_band SMALLINT;

-- 2. Extend the lookup functions to carry proficiency_band alongside frequency.
--    Adding a RETURNS TABLE column is a return-type change → DROP + CREATE. Drop
--    dependents first (the _many wrappers → base fns → the shared headword helper),
--    recreate in reverse. Server-only: EXECUTE stays service_role only.
DROP FUNCTION IF EXISTS jmdict_lookup_many(TEXT[], TEXT, TEXT);
DROP FUNCTION IF EXISTS wordnet_en_ja_lookup_many(TEXT[]);
DROP FUNCTION IF EXISTS jmdict_lookup(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS wordnet_en_ja_lookup(TEXT);
DROP FUNCTION IF EXISTS jmdict_entry_headword(TEXT);

-- --- shared headword helper: writing/reading/common/frequency/BAND/pos ----------
CREATE FUNCTION jmdict_entry_headword(p_entry_id TEXT)
RETURNS TABLE(writing TEXT, reading TEXT, is_common BOOLEAN, frequency INTEGER,
              proficiency_band SMALLINT, part_of_speech TEXT[])
LANGUAGE sql STABLE
AS $$
  SELECT
    CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END   AS writing,
    CASE WHEN uk.is_uk THEN NULL ELSE ka.text END                        AS reading,
    COALESCE(kj.common, ka.common, FALSE)                                AS is_common,
    CASE WHEN uk.is_uk THEN ka.frequency
         ELSE COALESCE(kj.frequency, ka.frequency) END                   AS frequency,
    -- proficiency band of the HEADWORD surface (same pick as frequency).
    CASE WHEN uk.is_uk THEN ka.proficiency_band
         ELSE COALESCE(kj.proficiency_band, ka.proficiency_band) END      AS proficiency_band,
    (SELECT sn.part_of_speech FROM jmdict_senses sn
      WHERE sn.entry_id = p_entry_id ORDER BY sn.position ASC LIMIT 1)   AS part_of_speech
  FROM (SELECT kk.text, kk.common, kk.frequency, kk.proficiency_band FROM jmdict_kanji kk
         WHERE kk.entry_id = p_entry_id
         ORDER BY kk.common DESC, kk.position ASC LIMIT 1) kj
  FULL JOIN (SELECT nn.text, nn.common, nn.frequency, nn.proficiency_band FROM jmdict_kana nn
              WHERE nn.entry_id = p_entry_id
              ORDER BY nn.common DESC, nn.position ASC LIMIT 1) ka ON TRUE
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                      WHERE sn.entry_id = p_entry_id
                      ORDER BY sn.position ASC LIMIT 1), FALSE) AS is_uk
  ) uk;
$$;

-- --- jmdict_lookup (JA→EN + EN→JA) ---------------------------------------------
CREATE FUNCTION jmdict_lookup(p_input TEXT, p_source TEXT, p_target TEXT)
RETURNS TABLE(translation TEXT, input_reading TEXT, translation_reading TEXT,
              sense_position INTEGER, writing TEXT, jmdict_entry_id TEXT,
              frequency INTEGER, proficiency_band SMALLINT, part_of_speech TEXT[])
LANGUAGE plpgsql STABLE
AS $$
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
        CASE
          WHEN pref.is_uk THEN pref.kana_freq
          WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_freq
          ELSE COALESCE(pref.kanji_freq, pref.kana_freq)
        END                                               AS frequency,
        -- proficiency band of the HEADWORD surface (same pick as frequency).
        CASE
          WHEN pref.is_uk THEN pref.kana_band
          WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_band
          ELSE COALESCE(pref.kanji_band, pref.kana_band)
        END                                               AS proficiency_band,
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
      ORDER BY (CASE
                  WHEN pref.is_uk THEN pref.kana_freq
                  WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_freq
                  ELSE COALESCE(pref.kanji_freq, pref.kana_freq)
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
        (SELECT sn.part_of_speech FROM jmdict_senses sn
          WHERE sn.entry_id = ent.entry_id ORDER BY sn.position ASC LIMIT 1)
                                                          AS part_of_speech
      FROM ent
      JOIN LATERAL (
        SELECT
          CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END AS writing,
          CASE WHEN uk.is_uk THEN NULL ELSE ka.text END                       AS reading,
          COALESCE(kj.common, ka.common, FALSE)  AS is_common,
          CASE WHEN uk.is_uk THEN ka.frequency
               ELSE COALESCE(kj.frequency, ka.frequency) END                  AS frequency,
          CASE WHEN uk.is_uk THEN ka.proficiency_band
               ELSE COALESCE(kj.proficiency_band, ka.proficiency_band) END     AS proficiency_band
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
$$;

-- --- wordnet_en_ja_lookup (semantic EN→JA) -------------------------------------
CREATE FUNCTION wordnet_en_ja_lookup(p_input TEXT)
RETURNS TABLE(translation TEXT, input_reading TEXT, translation_reading TEXT,
              sense_position INTEGER, writing TEXT, jmdict_entry_id TEXT,
              frequency INTEGER, proficiency_band SMALLINT, part_of_speech TEXT[])
LANGUAGE sql STABLE
AS $$
  WITH syn AS (
    SELECT se.synset_id, MIN(se.sense_rank) AS rank
      FROM wordnet_senses_en se
     WHERE se.lemma = lower(btrim(p_input))
     GROUP BY se.synset_id
  ),
  ja AS (
    SELECT wj.lemma, MIN(syn.rank) AS rank
      FROM wordnet_words_ja wj
      JOIN syn ON syn.synset_id = wj.synset_id
     GROUP BY wj.lemma
  ),
  resolved AS (
    SELECT e.entry_id, ja.rank,
           hw.writing, hw.reading, hw.is_common, hw.frequency, hw.proficiency_band, hw.part_of_speech
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
         ORDER BY cand.c DESC, cand.f DESC NULLS LAST, cand.src ASC
         LIMIT 1
      ) e ON TRUE
      CROSS JOIN LATERAL jmdict_entry_headword(e.entry_id) hw
  ),
  dedup AS (
    SELECT DISTINCT ON (r.entry_id)
           r.entry_id, r.rank, r.writing, r.reading,
           r.is_common, r.frequency, r.proficiency_band, r.part_of_speech
      FROM resolved r
     WHERE r.writing IS NOT NULL
     ORDER BY r.entry_id, r.rank ASC NULLS LAST, r.frequency DESC NULLS LAST
  )
  SELECT
    d.writing                                                   AS translation,
    NULL::TEXT                                                  AS input_reading,
    d.reading                                                   AS translation_reading,
    (ROW_NUMBER() OVER (ORDER BY d.rank ASC NULLS LAST,
                                 d.frequency DESC NULLS LAST,
                                 d.is_common DESC))::INT - 1     AS sense_position,
    NULL::TEXT                                                  AS writing,
    d.entry_id                                                  AS jmdict_entry_id,
    d.frequency                                                 AS frequency,
    d.proficiency_band                                          AS proficiency_band,
    d.part_of_speech                                            AS part_of_speech
  FROM dedup d
  ORDER BY sense_position
  LIMIT 12;
$$;

-- --- batch wrappers ------------------------------------------------------------
CREATE FUNCTION jmdict_lookup_many(p_inputs TEXT[], p_source TEXT, p_target TEXT)
RETURNS TABLE(input TEXT, translation TEXT, input_reading TEXT, translation_reading TEXT,
              sense_position INTEGER, writing TEXT, jmdict_entry_id TEXT,
              frequency INTEGER, proficiency_band SMALLINT, part_of_speech TEXT[])
LANGUAGE sql STABLE
AS $$
  SELECT i.input, l.translation, l.input_reading, l.translation_reading,
         l.sense_position, l.writing, l.jmdict_entry_id, l.frequency, l.proficiency_band, l.part_of_speech
  FROM unnest(p_inputs) WITH ORDINALITY AS i(input, ord)
  CROSS JOIN LATERAL jmdict_lookup(i.input, p_source, p_target) AS l
  ORDER BY i.ord, l.sense_position NULLS LAST
$$;

CREATE FUNCTION wordnet_en_ja_lookup_many(p_inputs TEXT[])
RETURNS TABLE(input TEXT, translation TEXT, input_reading TEXT, translation_reading TEXT,
              sense_position INTEGER, writing TEXT, jmdict_entry_id TEXT,
              frequency INTEGER, proficiency_band SMALLINT, part_of_speech TEXT[])
LANGUAGE sql STABLE
AS $$
  SELECT i.input, l.translation, l.input_reading, l.translation_reading,
         l.sense_position, l.writing, l.jmdict_entry_id, l.frequency, l.proficiency_band, l.part_of_speech
  FROM unnest(p_inputs) WITH ORDINALITY AS i(input, ord)
  CROSS JOIN LATERAL wordnet_en_ja_lookup(i.input) AS l
  ORDER BY i.ord, l.sense_position NULLS LAST
$$;

-- 3. Server-only EXECUTE (mirrors the originals: service_role only, no PUBLIC).
REVOKE EXECUTE ON FUNCTION jmdict_entry_headword(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION jmdict_entry_headword(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION jmdict_lookup(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION jmdict_lookup(TEXT, TEXT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION wordnet_en_ja_lookup(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION jmdict_lookup_many(TEXT[], TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION jmdict_lookup_many(TEXT[], TEXT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION wordnet_en_ja_lookup_many(TEXT[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION wordnet_en_ja_lookup_many(TEXT[]) TO service_role;
