-- =========================================================
-- "The entry written this way" only wins when it is a COMMON word.
--
-- THE REPORT (#24): 為 showed "second string of a koto (counting from the player's
-- near side)", levelled N4.
--
-- Three JMdict entries share the spelling 為:
--   1157080  ため  (uk, headword ため)   common    frequency 611   "sake; purpose"
--   2219050  す    (uk, headword す)     common    frequency 533   "to do"
--   2870964  為 read い                  NOT common frequency 514   a koto string
-- 20260758 sorts an entry whose displayed headword equals the typed kanji first — the
-- 質 fix, where 質/しつ "quality" was losing to the uk entry 質/たち. But the only entry
-- that headwords as 為 is the koto string, so the same rule handed it the primary slot,
-- over a word every learner meets in their first month.
--
-- What separates the two cases is what the rule was standing in for: しつ is a common
-- word and たち (in that sense) is not; い is not and ため is. So the preference now
-- requires the written-that-way entry to be common. 質 still answers しつ; 為 falls back
-- to frequency and answers ため.
--
-- THE CACHE needs the same bit. A cached word never reaches jmdict_lookup, and the
-- cache-side twin of the rule (preferWrittenForm, in the edge AND now the client) sees
-- only `words` rows — so `words.is_common` carries it. It is intrinsic to the entry,
-- global and scalar, which is the bar for a `words` column. Maintained by a trigger from
-- the jmdict_* tables rather than by the projection, so no edge deploy or projection
-- version is needed for it to be right, and backfilled here for every cached row.
--
-- AND A REPAIR. 20260767 rebuilt jmdict_entry_headword_mv from a pre-20260740 copy and
-- dropped that migration's band fallback (the shown writing's band, else the entry's
-- kanji band). On prod 705 entries lost their level in the Learn pool that way —
-- exactly the uk words 20260740 existed for (ため, こと, いる). The view is rebuilt
-- below with the fallback back; nothing else in it changes.
--
-- Everything else in jmdict_lookup is byte-for-byte 20260767 — only the ORDER BY moves.
-- ORDER MATTERS FOR AVAILABILITY. The migration is one transaction, and a lock taken
-- early is held until COMMIT. Building the view takes ~20 s on the full dictionary, so
-- it is built FIRST under a new name (no lock on the live view), and everything that
-- locks something readers need — the view swap, ALTER TABLE words, CREATE TRIGGER — runs
-- LAST, holding its lock for milliseconds rather than for the build.
-- =========================================================

-- 1. The headword view, with the 20260740 band fallback restored — built aside ----
CREATE MATERIALIZED VIEW jmdict_entry_headword_mv_next AS
  SELECT
    e.entry_id,
    CASE WHEN uk.is_uk THEN ka.text ELSE COALESCE(kj.text, ka.text) END   AS writing,
    CASE WHEN uk.is_uk THEN NULL   ELSE ka.text END                       AS reading,
    COALESCE(kj.common, ka.common, FALSE)                                 AS is_common,
    -- OWN value of the shown writing (kanji's if a kanji is shown, else kana's).
    CASE WHEN uk.is_uk        THEN ka.frequency
         WHEN kj.text IS NOT NULL THEN kj.frequency
         ELSE ka.frequency END                                            AS frequency,
    -- Shown writing's own band, else the entry's kanji band (20260740; restored here).
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
      FROM jmdict_kanji kk
     WHERE kk.entry_id = e.entry_id AND jmdict_is_written_form(kk.text)
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

-- Unique index → the PK probe the readers use (and lets a future REFRESH … CONCURRENTLY work).
CREATE UNIQUE INDEX idx_jmdict_headword_mv_entry_next ON jmdict_entry_headword_mv_next (entry_id);

-- Server-only, like the jmdict_* source tables (only the edge's service_role reads it).
REVOKE ALL   ON jmdict_entry_headword_mv_next FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON jmdict_entry_headword_mv_next TO service_role;

-- 2. jmdict_lookup -------------------------------------------------------------
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
            WHERE kj.entry_id = s.entry_id AND jmdict_is_written_form(kj.text)
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji,
          (SELECT k.text FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana,
          (SELECT kj.frequency FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND jmdict_is_written_form(kj.text)
            ORDER BY kj.common DESC, kj.position ASC LIMIT 1) AS kanji_freq,
          (SELECT k.frequency FROM jmdict_kana k
            WHERE k.entry_id = s.entry_id
            ORDER BY k.common DESC, k.position ASC LIMIT 1)   AS kana_freq,
          (SELECT kj.proficiency_band FROM jmdict_kanji kj
            WHERE kj.entry_id = s.entry_id AND jmdict_is_written_form(kj.text)
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
               -- A KANJI SEARCH RANKS IN FOUR TIERS before frequency (20260769):
               --   3  written this way AND common     質 → 質/しつ
               --   2  common                          為 → ため, not 為/い (a koto string)
               --   1  written this way                栄 → 栄/えい, not ロン (mahjong)
               --   0  the rest
               -- 20260758's "written this way first" is tiers 3+1 alone, which let a rare
               -- entry beat a common word. Common alone is not enough either: among rare
               -- entries it lets a uk entry's inflated kana frequency win (構 → かじ).
               -- Kana input is untouched — every row is tier 0.
               (CASE WHEN p_input !~ '[一-龥]' THEN 0
                     ELSE (CASE WHEN pref.is_common THEN 2 ELSE 0 END)
                        + (CASE WHEN (CASE
                                        WHEN pref.is_uk THEN pref.kana
                                        WHEN pref.matched_kanji IS NOT NULL THEN pref.matched_kanji
                                        ELSE COALESCE(pref.kanji, pref.kana)
                                      END) = p_input
                                THEN 1 ELSE 0 END)
                END) DESC,
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
               WHERE kk.entry_id = ent.entry_id AND jmdict_is_written_form(kk.text)
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

-- 3. Swap the view in: instant, and the only moment readers of it wait -------------
-- The reader functions name the view at execution time, so they pick up the new one.
DROP MATERIALIZED VIEW jmdict_entry_headword_mv;
ALTER MATERIALIZED VIEW jmdict_entry_headword_mv_next RENAME TO jmdict_entry_headword_mv;
ALTER INDEX idx_jmdict_headword_mv_entry_next RENAME TO idx_jmdict_headword_mv_entry;

-- 4. words.is_common — last, so ALTER TABLE's lock on words is held only to COMMIT --
ALTER TABLE words ADD COLUMN IF NOT EXISTS is_common BOOLEAN;

COMMENT ON COLUMN words.is_common IS
  'JMdict "common" flag of the row''s ENTRY (any common writing or reading). NULL for '
  'rows with no JMdict entry (MT). Trigger-maintained from jmdict_* (20260769).';

CREATE OR REPLACE FUNCTION jmdict_entry_is_common(p_entry_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE((SELECT bool_or(common) FROM jmdict_kana  WHERE entry_id = p_entry_id), FALSE)
      OR COALESCE((SELECT bool_or(common) FROM jmdict_kanji WHERE entry_id = p_entry_id), FALSE)
$$;
REVOKE ALL ON FUNCTION jmdict_entry_is_common(TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION jmdict_entry_is_common(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION words_set_is_common()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  NEW.is_common := CASE WHEN NEW.jmdict_entry_id IS NULL THEN NULL
                        ELSE jmdict_entry_is_common(NEW.jmdict_entry_id) END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION words_set_is_common() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_words_set_is_common ON words;
CREATE TRIGGER trg_words_set_is_common
  BEFORE INSERT OR UPDATE OF jmdict_entry_id ON words
  FOR EACH ROW EXECUTE FUNCTION words_set_is_common();

UPDATE words
   SET is_common = jmdict_entry_is_common(jmdict_entry_id)
 WHERE jmdict_entry_id IS NOT NULL
   AND is_common IS DISTINCT FROM jmdict_entry_is_common(jmdict_entry_id);
