-- =========================================================
-- jmdict_lookup: a kanji search answers with the entry WRITTEN that way.
--
-- THE REPORT: looking up 質 did not show "quality".
--
-- It was there — third. Two JMdict entries carry the writing 質:
--   1320640  質 (しつ)  "quality; value"          headword 質,   frequency 465
--   1320650  質 (たち)  "nature; disposition"     headword たち, frequency 577
-- The second is `uk` (usually kana), so its headword resolves to たち — and the JA→EN
-- ordering is frequency-first, so たち's 577 beat 質's 465. A search for 質 therefore
-- answered with たち, a word the user had not typed and does not look like what they
-- did type, and pushed "quality" below it. In the single-word view the primary sense
-- IS the answer, so the effect was simply that the meaning was missing.
--
-- THE FIX: when the input contains KANJI, an entry whose displayed headword equals the
-- input sorts first; frequency then decides as before. Ranking by "is this the word you
-- typed" before "how common is it" is the right precedence for an exact-form search.
--
-- WHY GUARDED TO KANJI. Unguarded, this would also fire on kana input, where a
-- kana-headword `uk` entry would leapfrog the kanji entry a searcher usually wants:
-- ねこ must still answer 猫 (verified before and after — 猫 first either way). Kana
-- input keeps the old behaviour exactly; the new key is inert there.
--
-- Everything else in the function is byte-for-byte 20260740 — only the ORDER BY moves.
-- =========================================================

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
        (SELECT sn.part_of_speech FROM jmdict_senses sn
          WHERE sn.entry_id = ent.entry_id ORDER BY sn.position ASC LIMIT 1)
                                                          AS part_of_speech
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
