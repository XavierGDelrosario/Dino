-- =========================================================
-- JA->EN: return the SEARCHED kanji writing as the headword, not the entry's
-- preferred one.
--
-- Bug (verified live 2026-07-03): reading 傷む in a sentence "didn't show up" in
-- the reader. jmdict_lookup('傷む','JA','EN') DID match its entry (1432710) but
-- returned writing = 痛む — the entry's PREFERRED kanji (position 0) — because 傷む
-- is only its SECONDARY writing. The edge then projects a row with input=痛む /
-- input_reading=いたむ, and groupByInput() (`_lib.ts`) attributes a result to a
-- search term only when `row.input = term OR row.input_reading = term`. Neither
-- 痛む nor いたむ equals 傷む, so the 傷む token got ZERO senses and rendered grey.
--
-- Fix: when the input IS one of the entry's kanji writings, headline THAT writing
-- (and use its own frequency), so 傷む -> 傷む(いたむ) with its meaning. A KANA search
-- is unchanged — the input isn't a kanji form, so it still falls back to the
-- preferred kanji (ねこ -> 猫), and groupByInput still attributes it via the row's
-- input_reading (=ねこ). uk entries also unchanged (kana still headlines).
--
-- Only the JA->EN branch changes; the EN->JA branch is carried verbatim from
-- 20260702. jmdict_lookup_many (20260710) delegates to this function, so the batch
-- reader inherits the fix. Forward-only CREATE OR REPLACE.
-- =========================================================

CREATE OR REPLACE FUNCTION jmdict_lookup(
  p_input  TEXT,
  p_source TEXT,
  p_target TEXT
)
RETURNS TABLE (
  translation          TEXT,
  input_reading        TEXT,
  translation_reading  TEXT,
  sense_position       INT,
  writing              TEXT,
  jmdict_entry_id      TEXT,
  frequency            INT,
  part_of_speech       TEXT[]
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_source = 'JA' AND p_target = 'EN' THEN
    RETURN QUERY
      SELECT
        (SELECT string_agg(gl.text, '; ' ORDER BY gl.position)
           FROM jmdict_glosses gl
          WHERE gl.sense_id = s.id)                       AS translation,
        -- Annotation above the headword (`input_reading`): uk -> the kanji;
        -- a normal kanji headword -> its kana furigana; kana-only -> nothing.
        CASE
          WHEN pref.is_uk THEN pref.kanji
          WHEN pref.kanji IS NOT NULL THEN pref.kana
          ELSE NULL
        END                                               AS input_reading,
        NULL::TEXT                                        AS translation_reading,
        s.position                                        AS sense_position,
        -- Headword (`writing`): kana for uk; else the SEARCHED kanji when the input
        -- is one of the entry's kanji writings (so 傷む stays 傷む, not 痛む); else the
        -- preferred kanji (so a kana search ねこ still surfaces 猫).
        CASE
          WHEN pref.is_uk THEN pref.kana
          WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji
          ELSE COALESCE(pref.kanji, pref.kana)
        END                                               AS writing,
        s.entry_id                                        AS jmdict_entry_id,
        -- Frequency of the HEADWORD surface: the searched kanji's own score when it
        -- headlines, else the preferred kanji's (uk -> kana). Not a max over readings.
        CASE
          WHEN pref.is_uk THEN pref.kana_freq
          WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji_freq
          ELSE COALESCE(pref.kanji_freq, pref.kana_freq)
        END                                               AS frequency,
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
          -- the exact kanji form the caller searched, if the input IS one of this
          -- entry's kanji writings (vs. a kana search) — lets a specific writing
          -- (傷む) headline itself instead of collapsing to the preferred kanji (痛む).
          (SELECT kj.text FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND kj.text = p_input LIMIT 1) AS matched_kanji,
          (SELECT kj.frequency FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND kj.text = p_input LIMIT 1) AS matched_kanji_freq,
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
               ELSE COALESCE(kj.frequency, ka.frequency) END                  AS frequency
        FROM (SELECT kk.text, kk.common, kk.frequency FROM jmdict_kanji kk
               WHERE kk.entry_id = ent.entry_id
               ORDER BY kk.common DESC, kk.position ASC LIMIT 1) kj
        FULL JOIN (SELECT nn.text, nn.common, nn.frequency FROM jmdict_kana nn
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
