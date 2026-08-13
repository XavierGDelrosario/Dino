-- =========================================================
-- EN→JA lookup: stop resolving headwords for entries that cannot place.
--
-- THE MEASUREMENT (prod, 2026-08-13). docs/TODO.md carried "5.0 s for one", taken
-- 2026-08-07; it is 519 ms today, so something in between already fixed the worst of
-- it and the entry was costing more attention than the query. What is left splits:
--
--     word     candidates   gloss scan   full lookup   scan share
--     one           7,693       141 ms        519 ms         27%
--     time          1,682       112 ms        165 ms         68%
--     penguin          25        81 ms         83 ms         98%
--
-- So for the slow case the gloss SCAN is a quarter of the cost and the rest is the
-- LATERAL headword resolution running once per candidate entry — 7,693 times for
-- "one", to return 12 rows.
--
-- WHAT WAS TRIED AND REJECTED: the gloss_terms index docs/TODO.md prescribed. Built
-- both shapes on prod inside a rolled-back transaction: a materialised
-- gloss_terms(term, entry_id, rank) is 1,087,028 rows ≈ 85 MB, and a
-- GIN(to_tsvector('simple', text)) is 10 MB. The GIN measured 0.6–1.2× over a median
-- of 7 runs — noise, some slower — because it addresses the 27%, not the 73%. 85 MB
-- would also have taken half the free tier's remaining headroom, on a database whose
-- word-map was deleted at 80 MB to stay off Pro (QualityLimitations §1).
--
-- WHAT THIS DOES INSTEAD: prune the candidates before the LATERAL, exactly. The
-- ordering is (match_rank >= 2) DESC, central DESC, THEN pref.frequency — the first
-- two are computable from the gloss scan alone, so they define tiers that dominate
-- the sort. Once the top tiers hold 12 entries the rest cannot place. Whole tiers are
-- kept or dropped together, because within a tier the order does need frequency.
--
-- Not every word wins: "own" has 7 entries in its top tiers, so it keeps all 458 and
-- pays exactly what it paid before. Nothing regresses; the pathological cases stop
-- being pathological. Output is unchanged by construction, and verified equal
-- row-for-row against the previous definition before this shipped.
--
-- Only the EN→JA branch changes. JA→EN never had the fan-out: it matches headwords,
-- not glosses, so its candidate set is a handful of entries.
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
      ),
      -- ── THE CAP (20260765) ──────────────────────────────────────────────────
      -- The sort below is cheap-key-first: (match_rank >= 2), then central, and only
      -- THEN pref.frequency. So the tier an entry lands in strictly dominates the
      -- ordering, and once the top tiers already hold `LIMIT` entries no lower-tier
      -- entry can reach the result no matter how frequent it is. That makes this an
      -- exact prune, not a heuristic — and it is what keeps the LATERAL below from
      -- resolving a headword for every entry whose glosses merely MENTION the word.
      -- Measured on prod for "one": 7,693 candidates, of which 32 are in the top
      -- tiers; the other 7,661 were resolved and then thrown away.
      tiered AS (
        SELECT ent.*,
               (CASE WHEN ent.match_rank >= 2 AND ent.central = 1 THEN 0
                     WHEN ent.match_rank >= 2                     THEN 1
                     ELSE 2 END) AS tier
          FROM ent
      ),
      -- The lowest tier at which the running count reaches the LIMIT. NULL when even
      -- every tier together has fewer — then nothing is pruned.
      cut AS (
        SELECT MIN(tier) AS keep_through
          FROM (SELECT tier, SUM(n) OVER (ORDER BY tier) AS cum
                  FROM (SELECT tier, count(*) AS n FROM tiered GROUP BY tier) c) s
         WHERE cum >= 12
      ),
      -- Whole tiers only: within a tier the order needs pref.frequency, so a tier is
      -- kept or dropped entire. Dropping half of one would change the result.
      capped AS (
        SELECT * FROM tiered
         WHERE tier <= COALESCE((SELECT keep_through FROM cut), 2)
      )
      SELECT
        pref.writing                                      AS translation,
        NULL::TEXT                                        AS input_reading,
        pref.reading                                      AS translation_reading,
        (ROW_NUMBER() OVER (ORDER BY (ent.match_rank >= 2) DESC, ent.central DESC,
                                     pref.frequency DESC NULLS LAST,
                                     pref.is_common DESC, ent.first_sense ASC,
                                     -- Total order. Without this the sort ends in a tie for every
                                     -- entry with no frequency, and the winner is whatever order the
                                     -- plan happened to emit — so the same query returned the same 12
                                     -- rows in a different sequence run to run (observed on "cat":
                                     -- positions 5/7/9/10 permuted between two plans). sense_position
                                     -- reaches the words cache, so an unstable one churns rows on
                                     -- re-projection for no reason.
                                     ent.entry_id ASC))::INT - 1
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
      FROM capped ent
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
