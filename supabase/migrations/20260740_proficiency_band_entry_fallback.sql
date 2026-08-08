-- =========================================================
-- Proficiency band: fall back to the ENTRY's kanji writing.
--
-- MEASURED on prod 2026-07-29: 3,100 of 6,604 JA `words` rows showed no level.
-- 268 are MT rows (no dictionary entry — nothing to resolve). Of the remaining
-- 2,832:
--     1,178  the dictionary HAS a band for that entry today; the cached row just
--            predates the JLPT ingest        → fixed by the backfill + version bump
--       437  the SHOWN writing has no band, but another writing of the same entry
--            does                            → fixed by the fallback below (266 of
--                                              them; see "kana is NOT a fallback")
--     1,217  no surface of the entry is in the JLPT list at all → out of reach
--            without an independent list (docs/QualityLimitations.md §2).
--
-- WHY THE SHOWN-WRITING RULE IS WRONG *FOR THE BAND*. Migration 20260720 made the
-- headword take its OWN frequency, not the max over the entry's readings, because
-- frequency is a property of the SURFACE: a rare kanji must not inherit its common
-- kana's corpus count (亡い reading ない's 704). Proficiency is the opposite kind of
-- fact — JLPT levels a WORD, not a spelling. The two were nevertheless resolved by
-- the same expression, so a "usually kana" entry, whose headword is kana while the
-- JLPT list carries the kanji, lost its level entirely:
--     こと (事 = N4) · いる (居る = N5) · ため (為 = N4) · よう (様 = N4) · ご (御 = N4)
--
-- KANA IS NOT A FALLBACK, and this is the whole safety argument. Falling back the
-- other way — a kanji headword taking a band from the entry's kana — re-creates
-- 20260720's bug in the proficiency axis, because a kana surface is exactly where
-- unrelated words collide. Verified against the live data: 疎雨 "drizzle" would take
-- N4 from the adverb そう, and 犯る would be labelled N5 off やる. So the fallback
-- reads jmdict_kanji ONLY (171 of the 437 rows are kana-only and stay NULL — that
-- is deliberate, not an oversight).
--
-- RESIDUAL, accepted: the fallback is per-ENTRY, so a rare READING of a banded entry
-- inherits the band (か, the counter, takes N5 from 個 — JMdict files them as one
-- entry). Same lexeme by the dictionary's own reckoning, and bounded to kanji, so it
-- cannot wander to a homophone.
-- =========================================================

-- The entry's most representative BANDED kanji writing — same ordering the headword
-- itself uses (common first, then JMdict's own order), restricted to rows that carry
-- a band. NULL for a kana-only entry, which is what keeps the kana path unchanged.
-- Factored out because the band is resolved in THREE places (jmdict_lookup's JA→EN
-- branch, its EN→JA branch, and jmdict_entry_headword_mv) — copy-paste across those
-- is how the axis drifted in the first place.
-- public.-qualified rather than `SET search_path`: a SET clause blocks inlining, and
-- this is called once per entry while the 217k-row matview builds. The qualification
-- gives the same immunity for free (the unqualified form failed to resolve when the
-- planner inlined it into the matview definition).
CREATE OR REPLACE FUNCTION jmdict_entry_kanji_band(p_entry_id TEXT)
RETURNS SMALLINT
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT kj.proficiency_band
    FROM public.jmdict_kanji kj
   WHERE kj.entry_id = p_entry_id
     AND kj.proficiency_band IS NOT NULL
   ORDER BY kj.common DESC, kj.position ASC
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION jmdict_entry_kanji_band(TEXT) FROM public, anon, authenticated;

-- ---------------------------------------------------------
-- 1. The materialized headword (EN→JA, via wordnet_en_ja_lookup).
-- ---------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS jmdict_entry_headword_mv;

CREATE MATERIALIZED VIEW jmdict_entry_headword_mv AS
  SELECT
    e.entry_id,
    CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END   AS writing,
    CASE WHEN uk.is_uk THEN NULL   ELSE ka.text END                       AS reading,
    COALESCE(kj.common, ka.common, FALSE)                                 AS is_common,
    -- OWN value of the shown writing (kanji's if a kanji is shown, else kana's).
    -- Deliberately NOT given the band's fallback: frequency is per-surface (20260720).
    CASE WHEN uk.is_uk        THEN ka.frequency
         WHEN kj.text IS NOT NULL THEN kj.frequency
         ELSE ka.frequency END                                            AS frequency,
    -- Shown writing's own band, else the entry's kanji band (see header).
    COALESCE(
      CASE WHEN uk.is_uk        THEN ka.proficiency_band
           WHEN kj.text IS NOT NULL THEN kj.proficiency_band
           ELSE ka.proficiency_band END,
      jmdict_entry_kanji_band(e.entry_id)
    )                                                                     AS proficiency_band,
    (SELECT sn.part_of_speech FROM jmdict_senses sn
      WHERE sn.entry_id = e.entry_id ORDER BY sn.position ASC LIMIT 1)    AS part_of_speech
  FROM jmdict_entries e
  LEFT JOIN LATERAL (
    SELECT kk.text, kk.common, kk.frequency, kk.proficiency_band
      FROM jmdict_kanji kk WHERE kk.entry_id = e.entry_id
     ORDER BY kk.common DESC, kk.position ASC LIMIT 1
  ) kj ON TRUE
  LEFT JOIN LATERAL (
    SELECT nn.text, nn.common, nn.frequency, nn.proficiency_band
      FROM jmdict_kana nn WHERE nn.entry_id = e.entry_id
     ORDER BY nn.common DESC, nn.position ASC LIMIT 1
  ) ka ON TRUE
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT sn.usually_kana FROM jmdict_senses sn
                      WHERE sn.entry_id = e.entry_id
                      ORDER BY sn.position ASC LIMIT 1), FALSE) AS is_uk
  ) uk;

CREATE UNIQUE INDEX idx_jmdict_headword_mv_entry ON jmdict_entry_headword_mv (entry_id);
REVOKE ALL ON jmdict_entry_headword_mv FROM anon, authenticated;
GRANT SELECT ON jmdict_entry_headword_mv TO service_role;

-- ---------------------------------------------------------
-- 2. jmdict_lookup — BOTH directions resolve a band inline (a third and fourth copy
--    of the same expression), so both get the fallback. The body below is the live
--    20260720 function verbatim except for those two COALESCEs; nothing else about
--    matching, ordering or frequency changes.
-- ---------------------------------------------------------
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
      ORDER BY (CASE
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

-- ---------------------------------------------------------
-- 3. Backfill the CACHE, because none of the above is visible on its own.
--
-- `words` is a lazy cache: the app reads a saved word's band straight off the cached
-- row (Lists joins user_words → words through PostgREST and never consults the
-- dictionary), so a better jmdict_lookup only reaches a word the next time something
-- LOOKS IT UP. Bumping CURRENT_PROJECTION_VERSION (done alongside this migration)
-- makes every row stale so it re-projects when used — but "when used" never comes for
-- the long tail, which is exactly where the missing levels are.
--
-- So fill the NULLs directly, in one pass. This is safe in a way the deferred
-- re-projection sweep (docs/TODO.md #3.2) is not: it only ever writes a band where
-- there was NONE, touches no other column, creates and deletes no rows, and changes
-- no identity — so `user_words.dictionary_word_id` cannot dangle. An existing band is
-- never overwritten, so a row whose own writing IS banded keeps its own value.
--
-- Approximation, stated plainly: this reads the ENTRY's headword band, whereas a JA
-- row whose input is a non-preferred kanji writing would ideally use that writing's
-- own band. Such a row is only touched here if it had no band at all, in which case
-- the entry-level answer is the fallback answer anyway.
-- ---------------------------------------------------------
UPDATE words w
   SET proficiency_band = h.proficiency_band
  FROM jmdict_entry_headword_mv h
 WHERE h.entry_id = w.jmdict_entry_id
   AND w.proficiency_band IS NULL
   AND h.proficiency_band IS NOT NULL;
